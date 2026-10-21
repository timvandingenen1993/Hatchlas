/**
 * Samples export tile fields on the GPU.
 *
 * Tile preparation resamples ~40 global rasters onto each 1024px camera tile
 * plus its halo. On the CPU that took 3-11 s per tile on the export worker,
 * which every tile helper waited for. Here each global raster is uploaded
 * once per export and every request is one compute dispatch; one readback per
 * batch returns the samples. The sample positions (indices and weights) are
 * computed on the CPU with the same plan as the CPU sampler, so nearest
 * lookups are exact and bilinear samples differ only by float32 rounding.
 */
import {
  createExportAxisSamplePlan,
  type ExportFieldSample,
  type ExportFieldSampleRequest,
} from "./mountainExportRenderer";

const STORAGE = 0x80;
const COPY_SRC = 0x04;
const COPY_DST = 0x08;
const MAP_READ = 0x01;
const UNIFORM = 0x40;
const MAP_READ_MODE = 0x0001;
/** Uniform slots must start on the device's 256-byte offset alignment. */
const SLOT_ALIGNMENT = 256;
const PARAMS_BYTES = 48;
const WORKGROUP = 16;
/**
 * Output (and readback) bytes per batch. The readback is mapped into this
 * worker's memory, so it stays small and is reused for every batch. 256 MB
 * batches were measured on 8K (6 helpers): the GPU wait fell only from 25.5
 * to 21.4 s (it follows the bytes, not the batch count) while the tab peaked
 * 2.4 GB higher.
 */
const BATCH_BYTES = 64 * 1024 * 1024;

const SAMPLE_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  sourceWidth: u32,
  nearest: u32,
  xIndex: u32,
  yIndex: u32,
  xWeight: u32,
  yWeight: u32,
  scale: f32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};
@group(0) @binding(0) var<storage, read> field: array<f32>;
// Per axis: first[n], second[n], nearest[n] source cells.
@group(0) @binding(1) var<storage, read> axisIndex: array<u32>;
@group(0) @binding(2) var<storage, read> axisWeight: array<f32>;
@group(0) @binding(3) var<storage, read_write> samples: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let width = params.width;
  let height = params.height;
  let stride = params.sourceWidth;
  var value: f32;
  if (params.nearest == 1u) {
    let nx = axisIndex[params.xIndex + 2u * width + id.x];
    let ny = axisIndex[params.yIndex + 2u * height + id.y];
    value = field[ny * stride + nx];
  } else {
    let x0 = axisIndex[params.xIndex + id.x];
    let x1 = axisIndex[params.xIndex + width + id.x];
    let y0 = axisIndex[params.yIndex + id.y];
    let y1 = axisIndex[params.yIndex + height + id.y];
    let tx = axisWeight[params.xWeight + id.x];
    let ty = axisWeight[params.yWeight + id.y];
    let top = field[y0 * stride + x0] * (1.0 - tx) + field[y0 * stride + x1] * tx;
    let bottom = field[y1 * stride + x0] * (1.0 - tx) + field[y1 * stride + x1] * tx;
    value = (top * (1.0 - ty) + bottom * ty) * params.scale;
  }
  samples[id.y * width + id.x] = value;
}
`;

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

/** Converts a float32 readback into the type the CPU sampler returns. */
function toRequestedType(values: Float32Array, request: ExportFieldSampleRequest): ExportFieldSample {
  // `precise` keeps double precision on the CPU path only; a GPU sample is
  // float32 already, and widening it would just double its memory.
  if (request.output === "u8") return new Uint8Array(values);
  if (request.output === "i8") return new Int8Array(values);
  return new Float32Array(values);
}

interface BatchBuffers {
  output?: GPUBuffer;
  readback?: GPUBuffer;
  uniforms?: GPUBuffer;
}

interface Batch {
  start: number;
  end: number;
  slots: number[];
  bytes: number;
}

interface AxisOffsets {
  index: number;
  weight: number;
}

export class ExportTileGpuSampler {
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  /** One upload per global raster, reused by every tile of the export. */
  private readonly sourceBuffers = new Map<ArrayLike<number>, GPUBuffer>();
  private lost = false;
  /**
   * Two sets of batch buffers: the GPU fills one while this worker copies the
   * other out, instead of waiting for each batch's readback in turn.
   */
  private readonly batchSets: BatchBuffers[] = [{}, {}];
  uploadedBytes = 0;
  /** Milliseconds spent per phase, summed over every `sample` call. */
  readonly timings = { prepareMs: 0, encodeMs: 0, waitMs: 0, copyMs: 0, readbackBytes: 0, batches: 0 };

  private constructor(device: GPUDevice, pipeline: GPUComputePipeline) {
    this.device = device;
    this.pipeline = pipeline;
    void device.lost.then(() => { this.lost = true; });
  }

  /** A sampler on the high-performance adapter, or null without WebGPU. */
  static async create(): Promise<ExportTileGpuSampler | null> {
    if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: SAMPLE_SHADER }), entryPoint: "main" },
    });
    return new ExportTileGpuSampler(device, pipeline);
  }

  private sourceBuffer(source: ArrayLike<number>): GPUBuffer {
    const cached = this.sourceBuffers.get(source);
    if (cached) return cached;
    const values = source instanceof Float32Array ? source : Float32Array.from(source);
    if (values.byteLength > this.device.limits.maxStorageBufferBindingSize) {
      throw new Error("Global raster exceeds the GPU storage binding limit");
    }
    const buffer = this.device.createBuffer({
      size: alignUp(Math.max(4, values.byteLength), 4),
      usage: STORAGE | COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, values.buffer, values.byteOffset, values.byteLength);
    this.sourceBuffers.set(source, buffer);
    this.uploadedBytes += buffer.size;
    return buffer;
  }

  /** Samples every request; results follow request order and CPU sampler types. */
  async sample(
    requests: readonly ExportFieldSampleRequest[],
    outputWidth: number,
    outputHeight: number,
  ): Promise<ExportFieldSample[]> {
    if (this.lost) throw new Error("GPU device was lost");
    const device = this.device;
    const prepareStarted = performance.now();
    // Sample positions per distinct axis, packed into two shared buffers.
    const indexChunks: Uint32Array[] = [];
    const weightChunks: Float32Array[] = [];
    let indexLength = 0;
    let weightLength = 0;
    const axes = new Map<string, AxisOffsets>();
    const axis = (start: number, length: number, outputSize: number, sourceSize: number): AxisOffsets => {
      const key = `${start},${length},${outputSize},${sourceSize}`;
      const cached = axes.get(key);
      if (cached) return cached;
      const plan = createExportAxisSamplePlan(start, length, outputSize, sourceSize);
      const index = new Uint32Array(length * 3);
      index.set(plan.first, 0);
      index.set(plan.second, length);
      index.set(plan.nearest, length * 2);
      const offsets = { index: indexLength, weight: weightLength };
      indexChunks.push(index);
      weightChunks.push(Float32Array.from(plan.weight));
      indexLength += index.length;
      weightLength += length;
      axes.set(key, offsets);
      return offsets;
    };
    const layouts = requests.map(request => ({
      x: axis(request.x, request.width, outputWidth, request.sourceWidth),
      y: axis(request.y, request.height, outputHeight, request.sourceHeight),
    }));
    const indexData = new Uint32Array(Math.max(1, indexLength));
    const weightData = new Float32Array(Math.max(1, weightLength));
    let offset = 0;
    for (const chunk of indexChunks) {
      indexData.set(chunk, offset);
      offset += chunk.length;
    }
    offset = 0;
    for (const chunk of weightChunks) {
      weightData.set(chunk, offset);
      offset += chunk.length;
    }
    const indexBuffer = device.createBuffer({ size: indexData.byteLength, usage: STORAGE | COPY_DST });
    const weightBuffer = device.createBuffer({ size: weightData.byteLength, usage: STORAGE | COPY_DST });
    device.queue.writeBuffer(indexBuffer, 0, indexData);
    device.queue.writeBuffer(weightBuffer, 0, weightData);

    const results: ExportFieldSample[] = new Array(requests.length);
    const batchLimit = Math.min(BATCH_BYTES, device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
    // Requests whose aligned output slots fit one batch.
    const batches: Batch[] = [];
    for (let start = 0; start < requests.length;) {
      const slots: number[] = [];
      let bytes = 0;
      let end = start;
      while (end < requests.length) {
        const requestBytes = alignUp(Math.max(4, requests[end].width * requests[end].height * 4), SLOT_ALIGNMENT);
        if (end > start && bytes + requestBytes > batchLimit) break;
        slots.push(bytes);
        bytes += requestBytes;
        end++;
      }
      batches.push({ start, end, slots, bytes });
      start = end;
    }
    this.timings.prepareMs += performance.now() - prepareStarted;
    // Batch i uses buffer set i % 2. The next batch is submitted before this
    // one is copied out, so the GPU and its readback run while this worker
    // copies; a set is reused only after its earlier batch was read.
    const pending: Array<{ batch: Batch; set: Required<BatchBuffers>; mapped: Promise<void> }> = [];
    try {
      for (let index = 0; index <= batches.length; index++) {
        if (index < batches.length) {
          const batch = batches[index];
          const set = this.submitBatch(requests, layouts, batch, indexBuffer, weightBuffer, this.batchSets[index % 2]);
          const mapped = set.readback.mapAsync(MAP_READ_MODE, 0, batch.bytes);
          // A failure surfaces when this batch is read below; never unhandled.
          mapped.catch(() => undefined);
          pending.push({ batch, set, mapped });
        }
        // Keep one batch in flight: read the older one once the next is queued.
        if (pending.length > 1 || (index === batches.length && pending.length > 0)) {
          await this.readBatch(requests, pending.shift()!, results);
        }
      }
    } finally {
      // After a failure, let batches still in flight land before unmapping,
      // so the next call never finds a buffer mapped or mid-mapping.
      for (const entry of pending) {
        await entry.mapped.catch(() => undefined);
      }
      for (const set of this.batchSets) {
        if (set.readback?.mapState === "mapped") set.readback.unmap();
      }
      indexBuffer.destroy();
      weightBuffer.destroy();
    }
    return results;
  }

  /** Encodes and submits one batch into `set` (grown as needed). */
  private submitBatch(
    requests: readonly ExportFieldSampleRequest[],
    layouts: ReadonlyArray<{ x: AxisOffsets; y: AxisOffsets }>,
    batch: Batch,
    indexBuffer: GPUBuffer,
    weightBuffer: GPUBuffer,
    set: BatchBuffers,
  ): Required<BatchBuffers> {
    const encodeStarted = performance.now();
    const device = this.device;
    const { start, end, slots } = batch;
    const count = end - start;
    const { output, readback, uniforms } = this.growBatchBuffers(set, batch.bytes, count * SLOT_ALIGNMENT);
    const params = new ArrayBuffer(count * SLOT_ALIGNMENT);
    const words = new Uint32Array(params);
    const floats = new Float32Array(params);
    for (let slot = 0; slot < count; slot++) {
      const request = requests[start + slot];
      const layout = layouts[start + slot];
      const base = (slot * SLOT_ALIGNMENT) / 4;
      words[base] = request.width;
      words[base + 1] = request.height;
      words[base + 2] = request.sourceWidth;
      words[base + 3] = request.nearest ? 1 : 0;
      words[base + 4] = layout.x.index;
      words[base + 5] = layout.y.index;
      words[base + 6] = layout.x.weight;
      words[base + 7] = layout.y.weight;
      floats[base + 8] = request.scale ?? 1;
    }
    device.queue.writeBuffer(uniforms, 0, params);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    for (let slot = 0; slot < count; slot++) {
      const request = requests[start + slot];
      const cells = request.width * request.height;
      if (cells === 0) continue;
      pass.setBindGroup(0, device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.sourceBuffer(request.source) } },
          { binding: 1, resource: { buffer: indexBuffer } },
          { binding: 2, resource: { buffer: weightBuffer } },
          { binding: 3, resource: { buffer: output, offset: slots[slot], size: cells * 4 } },
          { binding: 4, resource: { buffer: uniforms, offset: slot * SLOT_ALIGNMENT, size: PARAMS_BYTES } },
        ],
      }));
      pass.dispatchWorkgroups(Math.ceil(request.width / WORKGROUP), Math.ceil(request.height / WORKGROUP));
    }
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, batch.bytes);
    device.queue.submit([encoder.finish()]);
    this.timings.encodeMs += performance.now() - encodeStarted;
    return { output, readback, uniforms };
  }

  /** Waits for a submitted batch's readback and copies its samples out. */
  private async readBatch(
    requests: readonly ExportFieldSampleRequest[],
    { batch, set, mapped }: { batch: Batch; set: Required<BatchBuffers>; mapped: Promise<void> },
    results: ExportFieldSample[],
  ): Promise<void> {
    const waitStarted = performance.now();
    await mapped;
    const copyStarted = performance.now();
    this.timings.waitMs += copyStarted - waitStarted;
    try {
      const range = set.readback.getMappedRange(0, batch.bytes);
      for (let slot = 0; slot < batch.end - batch.start; slot++) {
        const request = requests[batch.start + slot];
        const cells = request.width * request.height;
        const offset = batch.slots[slot];
        // Float samples leave as one block copy of the mapped range; a typed
        // array copy of the view went element by element at half the speed.
        results[batch.start + slot] = request.output === "u8" || request.output === "i8"
          ? toRequestedType(new Float32Array(range, offset, cells), request)
          : new Float32Array(range.slice(offset, offset + cells * 4));
      }
    } finally {
      set.readback.unmap();
    }
    this.timings.copyMs += performance.now() - copyStarted;
    this.timings.readbackBytes += batch.bytes;
    this.timings.batches += 1;
  }

  /** A set's output, readback and uniform buffers, grown on demand. */
  private growBatchBuffers(set: BatchBuffers, bytes: number, uniformBytes: number): Required<BatchBuffers> {
    if (!set.output || !set.readback || bytes > set.output.size) {
      set.output?.destroy();
      set.readback?.destroy();
      const size = Math.max(bytes, BATCH_BYTES);
      set.output = this.device.createBuffer({ size, usage: STORAGE | COPY_SRC });
      set.readback = this.device.createBuffer({ size, usage: MAP_READ | COPY_DST });
    }
    if (!set.uniforms || uniformBytes > set.uniforms.size) {
      set.uniforms?.destroy();
      set.uniforms = this.device.createBuffer({
        size: Math.max(uniformBytes, 64 * SLOT_ALIGNMENT),
        usage: UNIFORM | COPY_DST,
      });
    }
    return set as Required<BatchBuffers>;
  }

  dispose(): void {
    for (const buffer of this.sourceBuffers.values()) buffer.destroy();
    this.sourceBuffers.clear();
    for (const set of this.batchSets) {
      set.output?.destroy();
      set.readback?.destroy();
      set.uniforms?.destroy();
    }
    this.device.destroy();
  }
}

export interface ExportSampleComparison {
  /** Largest bilinear difference relative to max(1, |CPU value|). */
  maxRelativeError: number;
  /** Nearest (categorical) samples that differ; these must be exact. */
  nearestMismatches: number;
}

/** Compares GPU samples with the CPU reference for the same requests. */
export function compareExportSamples(
  requests: readonly ExportFieldSampleRequest[],
  cpu: readonly ExportFieldSample[],
  gpu: readonly ExportFieldSample[],
): ExportSampleComparison {
  let maxRelativeError = 0;
  let nearestMismatches = 0;
  for (let index = 0; index < requests.length; index++) {
    const expected = cpu[index];
    const actual = gpu[index];
    if (!actual || actual.length !== expected.length) {
      nearestMismatches += expected.length;
      continue;
    }
    if (requests[index].nearest) {
      for (let cell = 0; cell < expected.length; cell++) {
        if (expected[cell] !== actual[cell]) nearestMismatches++;
      }
      continue;
    }
    for (let cell = 0; cell < expected.length; cell++) {
      const error = Math.abs(expected[cell] - actual[cell]) / Math.max(1, Math.abs(expected[cell]));
      if (error > maxRelativeError || Number.isNaN(error)) maxRelativeError = Number.isNaN(error) ? Infinity : error;
    }
  }
  return { maxRelativeError, nearestMismatches };
}

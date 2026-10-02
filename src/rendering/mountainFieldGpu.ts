import type { MountainIllustrationPreparedFields } from './mountainIllustrationFields';

/** Sources for the independent illustration support fields. */
export interface MountainFieldGpuSources {
  width: number;
  height: number;
  lightingElevation: Float32Array;
  reliefElevation: Float32Array;
  ridgeInk: ArrayLike<number>;
  ink: ArrayLike<number>;
  coverage: ArrayLike<number>;
  lineworkCoverage: ArrayLike<number>;
}

export interface MountainFieldGpuOptions {
  /** Maximum interior side length before the preparation is tiled. */
  tileSize?: number;
  /** Retained GPU working-set budget, independent of device limits. */
  maxGpuBytes?: number;
}

export interface MountainWindGpuSources {
  width: number;
  height: number;
  elevation: Float32Array;
  dxMeters: number;
  dyMeters: number;
  windAzimuthDeg: number;
}

export interface MountainWindGpuFields {
  width: number;
  height: number;
  windShelter: Float32Array;
  windLoading: Float32Array;
  slopeBreak: Float32Array;
}

export interface MountainFieldGpuPrepareControl {
  isCancelled?: () => boolean;
  checkpoint?: () => Promise<void>;
}

/**
 * A raster layer supplied to the GPU compositor. Layers are kept as packed
 * RGBA bytes at the public boundary so callers can build them from existing
 * CPU render stages while the compositor owns the blend pass and readback.
 */
export interface MountainGpuRgbaLayer {
  data: Uint8ClampedArray;
  opacity?: number;
}

/** Inputs for the first GPU-owned mountain material/raster pass. */
export interface MountainGpuMountainLayerSources {
  width: number;
  height: number;
  baseElevation: Float32Array;
  fields: MountainIllustrationPreparedFields;
  elevationMin: number;
  elevationMax: number;
}

export interface MountainGpuMountainLayerOptions {
  inkColor?: readonly number[];
  ridgeColor?: readonly number[];
  snowShadowColor?: readonly number[];
  snowColor?: readonly number[];
  snowAmount?: number;
}

export class MountainFieldGpuCancelledError extends Error {
  readonly cancelled = true;

  constructor() {
    super('WebGPU mountain field preparation was cancelled');
    this.name = 'MountainFieldGpuCancelledError';
  }
}

export interface MountainFieldGpuReport {
  backend: 'webgpu';
  /** True when the session returned fields retained from an identical request. */
  cacheHit?: boolean;
  initializationMs: number;
  uploadMs: number;
  computeMs: number;
  readbackMs: number;
  totalMs: number;
  tileCount: number;
  tileSize: number;
  retainedGpuBytes: number;
  /** Peak temporary plus retained bytes observed while processing a tile. */
  peakGpuBytes?: number;
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
}

export interface MountainFieldGpuSession {
  prepare(
    sources: MountainFieldGpuSources,
    radii: {
      lighting: number;
      relief: number;
      rib: number;
      crease: number;
      footprint: number;
      lineworkFootprint: number;
      snowRidge: number;
    },
    control?: MountainFieldGpuPrepareControl,
  ): Promise<{ fields: MountainIllustrationPreparedFields; report: MountainFieldGpuReport }>;
  prepareWindFields?(
    sources: MountainWindGpuSources,
    control?: MountainFieldGpuPrepareControl,
  ): Promise<{ fields: MountainWindGpuFields; report: MountainFieldGpuReport }>;
  /** Rasterize a fast illustrated mountain layer directly on the GPU. */
  rasterizeMountainLayer?(
    sources: MountainGpuMountainLayerSources,
    options?: MountainGpuMountainLayerOptions,
    control?: MountainFieldGpuPrepareControl,
  ): Promise<{
    data: Uint8ClampedArray;
    uploadMs: number;
    computeMs: number;
    readbackMs: number;
    totalMs: number;
    retainedGpuBytes: number;
    peakGpuBytes?: number;
  }>;
  /**
   * Copy a composed RGBA frame through the same persistent device used for
   * field preparation. The method is optional so CPU-only test doubles can
   * continue implementing the field contract without a compositor.
   */
  composeRgba?(
    width: number,
    height: number,
    source: Uint8ClampedArray,
    control?: MountainFieldGpuPrepareControl,
  ): Promise<{
    data: Uint8ClampedArray;
    uploadMs: number;
    computeMs: number;
    readbackMs: number;
    totalMs: number;
    retainedGpuBytes: number;
    peakGpuBytes?: number;
  }>;
  /** Compose already-rasterized layers in one GPU-owned pass chain. */
  composeLayersRgba?(
    width: number,
    height: number,
    layers: readonly MountainGpuRgbaLayer[],
    control?: MountainFieldGpuPrepareControl,
  ): Promise<{
    data: Uint8ClampedArray;
    uploadMs: number;
    computeMs: number;
    readbackMs: number;
    totalMs: number;
    retainedGpuBytes: number;
    peakGpuBytes?: number;
  }>;
  destroy(): void;
}

const STORAGE = 0x80;
const COPY_SRC = 0x04;
const COPY_DST = 0x08;
const MAP_READ = 0x01;
const UNIFORM = 0x40;
const MAP_READ_MODE = 0x0001;
const DEFAULT_GPU_BUDGET = 128 * 1024 * 1024;

const NORMALIZE_SHADER = /* wgsl */ `
struct Params { total: u32 };
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.total) { return; }
  destination[id.x] = f32(source[id.x] & 255u) / 255.0;
}
`;

const SMOOTH_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  radius: u32,
  axis: u32,
};
@group(0) @binding(0) var<storage, read> source: array<f32>;
@group(0) @binding(1) var<storage, read_write> destination: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

fn clampIndex(value: i32, maximum: u32) -> u32 {
  return u32(clamp(value, 0, i32(maximum) - 1));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let radius = i32(params.radius);
  var sum = 0.0;
  var count = 0.0;
  for (var offset = -radius; offset <= radius; offset++) {
    var x = i32(id.x);
    var y = i32(id.y);
    if (params.axis == 0u) {
      x = i32(clampIndex(x + offset, params.width));
    } else {
      y = i32(clampIndex(y + offset, params.height));
    }
    sum += source[u32(y) * params.width + u32(x)];
    count += 1.0;
  }
  destination[id.y * params.width + id.x] = sum / count;
}
`;

/*
 * The fast material pass intentionally works from the already prepared
 * support fields. It replaces the serial CPU snow/material/path loops with
 * one independent invocation per output cell. The exact CPU painter remains
 * available for cpuExact and for any request that cannot use this pass.
 */
const MOUNTAIN_RASTER_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  elevationMin: f32,
  elevationMax: f32,
  ink: vec4<f32>,
  ridge: vec4<f32>,
  snowShadow: vec4<f32>,
  snow: vec4<f32>,
  snowAmount: f32,
};
@group(0) @binding(0) var<storage, read> baseElevation: array<f32>;
// Two vec4 values per cell pack the seven support fields into one storage
// binding. This keeps the pass below the WebGPU minimum of eight storage
// buffers per compute stage (base + support + destination = three).
@group(0) @binding(1) var<storage, read> supportFields: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> destination: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;

fn clamp01(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }

fn mix3(a: vec3<f32>, b: vec3<f32>, amount: f32) -> vec3<f32> {
  return a * (1.0 - amount) + b * amount;
}

fn pack(r: f32, g: f32, b: f32, a: f32) -> u32 {
  let rr = u32(clamp(floor(r * 255.0 + 0.5), 0.0, 255.0));
  let gg = u32(clamp(floor(g * 255.0 + 0.5), 0.0, 255.0));
  let bb = u32(clamp(floor(b * 255.0 + 0.5), 0.0, 255.0));
  let aa = u32(clamp(floor(a * 255.0 + 0.5), 0.0, 255.0));
  return rr | (gg << 8u) | (bb << 16u) | (aa << 24u);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let index = id.y * params.width + id.x;
  let supportA = supportFields[index * 2u];
  let supportB = supportFields[index * 2u + 1u];
  let lightingElevation = supportA.x;
  let reliefReference = supportA.y;
  let ribField = supportA.z;
  let creaseField = supportA.w;
  let footprint = supportB.x;
  let lineworkFootprint = supportB.y;
  let snowRidgeField = supportB.z;
  let elevationSpan = max(0.000001, params.elevationMax - params.elevationMin);
  let elevation = clamp01((baseElevation[index] - params.elevationMin) / elevationSpan);
  let localLight = clamp01(0.58 + (lightingElevation - reliefReference) * 0.012);
  let broadCoverage = clamp01(footprint * 2.2);
  let ridge = clamp01(ribField * 1.65 + snowRidgeField * 0.3);
  let line = clamp01(lineworkFootprint * 1.45);
  let crease = clamp01(creaseField * 1.5);
  let snowBand = clamp01(
    (snowRidgeField * 1.15 + max(0.0, elevation - 0.52) * 0.85)
      * max(0.0, params.snowAmount),
  );
  var rock = mix3(vec3<f32>(0.24, 0.28, 0.31), vec3<f32>(0.70, 0.64, 0.52), elevation);
  rock = rock * (0.72 + localLight * 0.48);
  var color = mix3(rock, params.snowShadow.xyz, snowBand * 0.48);
  color = mix3(color, params.snow.xyz, snowBand * 0.72);
  color = mix3(color, params.ridge.xyz, ridge * 0.18 + line * 0.10);
  color = mix3(color, params.ink.xyz, crease * 0.24);
  let alpha = clamp01(max(broadCoverage, max(ridge * 0.78, line * 0.42)));
  destination[index] = pack(color.x, color.y, color.z, alpha);
}
`;

const WIND_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  rayCount: u32,
};
@group(0) @binding(0) var<storage, read> elevation: array<f32>;
@group(0) @binding(1) var<storage, read_write> shelter: array<f32>;
@group(0) @binding(2) var<storage, read_write> loading: array<f32>;
@group(0) @binding(3) var<storage, read_write> slopeBreak: array<f32>;
@group(0) @binding(4) var<storage, read> rayX: array<i32>;
@group(0) @binding(5) var<storage, read> rayY: array<i32>;
@group(0) @binding(6) var<storage, read> rayInverseDistance: array<f32>;
@group(0) @binding(7) var<storage, read> raySampleIndex: array<u32>;
@group(0) @binding(8) var<uniform> params: Params;

fn clamp01(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }
fn snowStep(edge0: f32, edge1: f32, value: f32) -> f32 {
  let span = select(edge1 - edge0, 0.000001, abs(edge1 - edge0) < 0.000001);
  let t = clamp01((value - edge0) / span);
  return t * t * (3.0 - 2.0 * t);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let index = id.y * params.width + id.x;
  let elevationAtCell = elevation[index];
  var maximum = -1000000000.0;
  var nearMaximum = -1000000000.0;
  var farMaximum = -1000000000.0;
  for (var rayIndex = 0u; rayIndex < params.rayCount; rayIndex++) {
    let sx = i32(id.x) + rayX[rayIndex];
    let sy = i32(id.y) + rayY[rayIndex];
    if (sx < 0 || sy < 0 || sx >= i32(params.width) || sy >= i32(params.height)) { continue; }
    let sample = u32(sy) * params.width + u32(sx);
    let upwindSlope = (elevation[sample] - elevationAtCell) * rayInverseDistance[rayIndex];
    maximum = max(maximum, upwindSlope);
    if (raySampleIndex[rayIndex] <= 3u) {
      nearMaximum = max(nearMaximum, upwindSlope);
    } else {
      farMaximum = max(farMaximum, upwindSlope);
    }
  }
  if (maximum < -999999999.0) { maximum = 0.0; }
  if (nearMaximum < -999999999.0) { nearMaximum = maximum; }
  if (farMaximum < -999999999.0) { farMaximum = maximum; }
  let degrees = 57.29577951308232;
  let horizonAngle = atan(maximum) * degrees;
  let nearAngle = atan(nearMaximum) * degrees;
  let farAngle = atan(farMaximum) * degrees;
  let shelterValue = snowStep(-7.0, 7.0, horizonAngle);
  let exposure = snowStep(-13.0, -1.0, horizonAngle);
  let breakValue = snowStep(1.5, 8.0, nearAngle - farAngle);
  let leeLoading = shelterValue * (0.72 + 0.28 * breakValue);
  shelter[index] = shelterValue;
  slopeBreak[index] = breakValue;
  loading[index] = clamp01(0.48 + leeLoading * 0.46 - exposure * 0.34);
}
`;

const RGBA_COPY_SHADER = /* wgsl */ `
struct Params { total: u32 };
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.total) { return; }
  destination[id.x] = source[id.x];
}
`;

const RGBA_BLEND_SHADER = /* wgsl */ `
struct Params {
  total: u32,
  opacity: u32,
};
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read> overlay: array<u32>;
@group(0) @binding(2) var<storage, read_write> destination: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;

fn byte(pixel: u32, shift: u32) -> f32 {
  return f32((pixel >> shift) & 255u) / 255.0;
}

fn pack(r: f32, g: f32, b: f32, a: f32) -> u32 {
  let rr = u32(clamp(floor(r * 255.0 + 0.5), 0.0, 255.0));
  let gg = u32(clamp(floor(g * 255.0 + 0.5), 0.0, 255.0));
  let bb = u32(clamp(floor(b * 255.0 + 0.5), 0.0, 255.0));
  let aa = u32(clamp(floor(a * 255.0 + 0.5), 0.0, 255.0));
  return rr | (gg << 8u) | (bb << 16u) | (aa << 24u);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.total) { return; }
  let base = source[id.x];
  let top = overlay[id.x];
  let baseA = byte(base, 24u);
  let topA = byte(top, 24u) * f32(params.opacity) / 255.0;
  let outA = topA + baseA * (1.0 - topA);
  if (outA <= 0.000001) {
    destination[id.x] = 0u;
    return;
  }
  let baseR = byte(base, 0u) * baseA;
  let baseG = byte(base, 8u) * baseA;
  let baseB = byte(base, 16u) * baseA;
  let topR = byte(top, 0u) * topA;
  let topG = byte(top, 8u) * topA;
  let topB = byte(top, 16u) * topA;
  let inverse = 1.0 - topA;
  destination[id.x] = pack(
    (topR + baseR * inverse) / outA,
    (topG + baseG * inverse) / outA,
    (topB + baseB * inverse) / outA,
    outA,
  );
}
`;

interface PreparedRegion<T> {
  fields: T;
  uploadMs: number;
  computeMs: number;
  readbackMs: number;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function alignedSize(bytes: number): number {
  return Math.max(4, (bytes + 3) & ~3);
}

function ceilRadius(radius: number): number {
  return Math.max(1, Math.ceil(radius));
}

interface WindRayData {
  x: Int32Array;
  y: Int32Array;
  inverseDistance: Float32Array;
  sampleIndex: Uint32Array;
  maxOffsetX: number;
  maxOffsetY: number;
}

function buildWindRayData(
  dxMeters: number,
  dyMeters: number,
  windAzimuthDeg: number,
): WindRayData {
  const windRad = (windAzimuthDeg * Math.PI) / 180;
  const rayOffsets = [-0.28, -0.14, 0, 0.14, 0.28];
  const distancesM = [35, 65, 105, 160, 250, 380, 560, 780];
  const x: number[] = [];
  const y: number[] = [];
  const inverseDistance: number[] = [];
  const sampleIndex: number[] = [];
  let maxOffsetX = 0;
  let maxOffsetY = 0;
  for (const offset of rayOffsets) {
    const rayRad = windRad + offset;
    const directionX = Math.sin(rayRad);
    const directionY = -Math.cos(rayRad);
    for (let index = 0; index < distancesM.length; index++) {
      const distanceM = distancesM[index];
      const rayX = Math.round(directionX * distanceM / Math.max(1, dxMeters));
      const rayY = Math.round(directionY * distanceM / Math.max(1, dyMeters));
      x.push(rayX);
      y.push(rayY);
      inverseDistance.push(1 / distanceM);
      sampleIndex.push(index);
      maxOffsetX = Math.max(maxOffsetX, Math.abs(rayX));
      maxOffsetY = Math.max(maxOffsetY, Math.abs(rayY));
    }
  }
  return {
    x: Int32Array.from(x),
    y: Int32Array.from(y),
    inverseDistance: Float32Array.from(inverseDistance),
    sampleIndex: Uint32Array.from(sampleIndex),
    maxOffsetX,
    maxOffsetY,
  };
}

function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && navigator.gpu !== undefined;
}

function asPackedBytes(source: ArrayLike<number>): Uint32Array {
  const packed = new Uint32Array(source.length);
  for (let index = 0; index < source.length; index++) {
    packed[index] = Math.max(0, Math.min(255, Math.round(source[index])));
  }
  return packed;
}

function colorToUnit(color: readonly number[]): [number, number, number, number] {
  return [
    Math.max(0, Math.min(1, (color[0] ?? 0) / 255)),
    Math.max(0, Math.min(1, (color[1] ?? 0) / 255)),
    Math.max(0, Math.min(1, (color[2] ?? 0) / 255)),
    1,
  ];
}

function extractRegion<T extends ArrayLike<number>>(
  source: T,
  sourceWidth: number,
  sourceHeight: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
): Float32Array | Uint8Array {
  const output = source instanceof Uint8Array
    ? new Uint8Array(width * height)
    : new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.max(0, Math.min(sourceHeight - 1, y0 + y));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.max(0, Math.min(sourceWidth - 1, x0 + x));
      output[y * width + x] = source[sourceY * sourceWidth + sourceX] ?? 0;
    }
  }
  return output;
}

class WebGpuMountainFieldSession implements MountainFieldGpuSession {
  private readonly device: GPUDevice;
  private readonly normalizePipeline: GPUComputePipeline;
  private readonly smoothPipeline: GPUComputePipeline;
  private readonly windPipeline: GPUComputePipeline;
  private mountainRasterPipeline: GPUComputePipeline | undefined;
  private mountainRasterPipelinePromise: Promise<GPUComputePipeline> | undefined;
  private rgbaCopyPipeline: GPUComputePipeline | undefined;
  private rgbaCopyPipelinePromise: Promise<GPUComputePipeline> | undefined;
  private rgbaBlendPipeline: GPUComputePipeline | undefined;
  private rgbaBlendPipelinePromise: Promise<GPUComputePipeline> | undefined;
  private scratchA: GPUBuffer | undefined;
  private scratchB: GPUBuffer | undefined;
  private readback: GPUBuffer | undefined;
  private rgbaSource: GPUBuffer | undefined;
  private readonly rgbaOverlays: GPUBuffer[] = [];
  private readonly rgbaLayerParams: GPUBuffer[] = [];
  private rgbaDestination: GPUBuffer | undefined;
  private rgbaParams: GPUBuffer | undefined;
  private rgbaReadback: GPUBuffer | undefined;
  private retainedBytes = 0;
  private peakWorkingBytes = 0;
  private lost = false;
  private readonly maxGpuBytes: number;
  private readonly requestedTileSize: number;
  private preparedFieldCache: {
    width: number;
    height: number;
    sources: readonly ArrayLike<number>[];
    radiiKey: string;
    fields: MountainIllustrationPreparedFields;
    tileCount: number;
    tileSize: number;
  } | undefined;

  private constructor(
    device: GPUDevice,
    normalizePipeline: GPUComputePipeline,
    smoothPipeline: GPUComputePipeline,
    windPipeline: GPUComputePipeline,
    maxGpuBytes: number,
    requestedTileSize: number,
  ) {
    this.device = device;
    this.normalizePipeline = normalizePipeline;
    this.smoothPipeline = smoothPipeline;
    this.windPipeline = windPipeline;
    this.maxGpuBytes = maxGpuBytes;
    this.requestedTileSize = requestedTileSize;
    void device.lost.then(() => { this.lost = true; });
  }

  static async create(maxGpuBytes: number, requestedTileSize: number): Promise<{
    session: WebGpuMountainFieldSession;
    initializationMs: number;
    maxStorageBufferBindingSize: number;
    maxBufferSize: number;
  }> {
    if (!hasWebGpu()) throw new Error('WebGPU is unavailable');
    const started = now();
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available');
    const device = await adapter.requestDevice();
    const normalizeModule = device.createShaderModule({ code: NORMALIZE_SHADER });
    const smoothModule = device.createShaderModule({ code: SMOOTH_SHADER });
    const windModule = device.createShaderModule({ code: WIND_SHADER });
    // Field preparation is the common GPU path. Compile those independent
    // pipelines together, and defer the approximate raster/compositor
    // pipelines until a request actually selects those passes.
    const [normalizePipeline, smoothPipeline, windPipeline] = await Promise.all([
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: normalizeModule, entryPoint: 'main' },
      }),
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: smoothModule, entryPoint: 'main' },
      }),
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: windModule, entryPoint: 'main' },
      }),
    ]);
    return {
      session: new WebGpuMountainFieldSession(
        device,
        normalizePipeline,
        smoothPipeline,
        windPipeline,
        maxGpuBytes,
        requestedTileSize,
      ),
      initializationMs: now() - started,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxBufferSize: device.limits.maxBufferSize,
    };
  }

  private ensureMountainRasterPipeline(): Promise<GPUComputePipeline> {
    if (this.mountainRasterPipeline) return Promise.resolve(this.mountainRasterPipeline);
    if (!this.mountainRasterPipelinePromise) {
      const module = this.device.createShaderModule({ code: MOUNTAIN_RASTER_SHADER });
      this.mountainRasterPipelinePromise = this.device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      }).then(pipeline => {
        this.mountainRasterPipeline = pipeline;
        return pipeline;
      });
    }
    return this.mountainRasterPipelinePromise;
  }

  private ensureRgbaCopyPipeline(): Promise<GPUComputePipeline> {
    if (this.rgbaCopyPipeline) return Promise.resolve(this.rgbaCopyPipeline);
    if (!this.rgbaCopyPipelinePromise) {
      const module = this.device.createShaderModule({ code: RGBA_COPY_SHADER });
      this.rgbaCopyPipelinePromise = this.device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      }).then(pipeline => {
        this.rgbaCopyPipeline = pipeline;
        return pipeline;
      });
    }
    return this.rgbaCopyPipelinePromise;
  }

  private ensureRgbaBlendPipeline(): Promise<GPUComputePipeline> {
    if (this.rgbaBlendPipeline) return Promise.resolve(this.rgbaBlendPipeline);
    if (!this.rgbaBlendPipelinePromise) {
      const module = this.device.createShaderModule({ code: RGBA_BLEND_SHADER });
      this.rgbaBlendPipelinePromise = this.device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      }).then(pipeline => {
        this.rgbaBlendPipeline = pipeline;
        return pipeline;
      });
    }
    return this.rgbaBlendPipelinePromise;
  }

  private ensureBuffer(
    existing: GPUBuffer | undefined,
    bytes: number,
    usage: number,
  ): GPUBuffer {
    const required = alignedSize(bytes);
    if (existing && existing.size >= required) return existing;
    if (existing) {
      existing.destroy();
      this.retainedBytes -= existing.size;
    }
    const buffer = this.device.createBuffer({ size: required, usage });
    this.retainedBytes += required;
    return buffer;
  }

  private async prepareRegion(
    sources: MountainFieldGpuSources,
    radii: Parameters<MountainFieldGpuSession['prepare']>[1],
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<PreparedRegion<MountainIllustrationPreparedFields>> {
    if (this.lost) throw new Error('WebGPU device was lost');
    const checkpoint = async (): Promise<void> => {
      if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
      if (control.checkpoint) await control.checkpoint();
      if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
    };
    const bytesPerField = sources.width * sources.height * Float32Array.BYTES_PER_ELEMENT;
    const totalReadbackBytes = bytesPerField * 7;
    const temporary: GPUBuffer[] = [];
    const createTemporary = (size: number, usage: number): GPUBuffer => {
      const buffer = this.device.createBuffer({ size: alignedSize(size), usage });
      temporary.push(buffer);
      return buffer;
    };
    const encoder = this.device.createCommandEncoder();
    const normalizeLayout = this.normalizePipeline.getBindGroupLayout(0);
    const smoothLayout = this.smoothPipeline.getBindGroupLayout(0);
    const uploadStarted = now();
    const uploadFloat = (source: Float32Array): GPUBuffer => {
      const buffer = createTemporary(source.byteLength, STORAGE | COPY_DST);
      this.device.queue.writeBuffer(buffer, 0, source);
      return buffer;
    };
    const uploadBytes = (source: ArrayLike<number>): GPUBuffer => {
      const packed = asPackedBytes(source);
      const buffer = createTemporary(packed.byteLength, STORAGE | COPY_DST);
      this.device.queue.writeBuffer(buffer, 0, packed);
      return buffer;
    };
    const elevation = uploadFloat(sources.lightingElevation);
    const relief = uploadFloat(sources.reliefElevation);
    const ridge = uploadBytes(sources.ridgeInk);
    const ink = uploadBytes(sources.ink);
    const coverage = uploadBytes(sources.coverage);
    const linework = uploadBytes(sources.lineworkCoverage);
    const uploadMs = now() - uploadStarted;

    const normalize = (source: GPUBuffer): GPUBuffer => {
      const destination = createTemporary(bytesPerField, STORAGE | COPY_SRC | COPY_DST);
      const parameterBuffer = createTemporary(16, UNIFORM | COPY_DST);
      this.device.queue.writeBuffer(parameterBuffer, 0, new Uint32Array([sources.width * sources.height]));
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.normalizePipeline);
      pass.setBindGroup(0, this.device.createBindGroup({
        layout: normalizeLayout,
        entries: [
          { binding: 0, resource: { buffer: source } },
          { binding: 1, resource: { buffer: destination } },
          { binding: 2, resource: { buffer: parameterBuffer } },
        ],
      }));
      pass.dispatchWorkgroups(Math.ceil((sources.width * sources.height) / 64));
      pass.end();
      return destination;
    };
    const normalizedRidge = normalize(ridge);
    const normalizedInk = normalize(ink);
    const normalizedCoverage = normalize(coverage);
    const normalizedLinework = normalize(linework);

    const scratchA = this.ensureBuffer(this.scratchA, bytesPerField, STORAGE | COPY_SRC | COPY_DST);
    const scratchB = this.ensureBuffer(this.scratchB, bytesPerField, STORAGE | COPY_SRC | COPY_DST);
    const readback = this.ensureBuffer(this.readback, totalReadbackBytes, MAP_READ | COPY_DST);
    this.scratchA = scratchA;
    this.scratchB = scratchB;
    this.readback = readback;
    const dispatchX = Math.ceil(sources.width / 8);
    const dispatchY = Math.ceil(sources.height / 8);
    const smooth = (source: GPUBuffer, radius: number, outputIndex: number): void => {
      const integerRadius = ceilRadius(radius);
      const horizontalParams = createTemporary(16, UNIFORM | COPY_DST);
      const verticalParams = createTemporary(16, UNIFORM | COPY_DST);
      this.device.queue.writeBuffer(horizontalParams, 0, new Uint32Array([
        sources.width, sources.height, integerRadius, 0,
      ]));
      this.device.queue.writeBuffer(verticalParams, 0, new Uint32Array([
        sources.width, sources.height, integerRadius, 1,
      ]));
      const dispatch = (input: GPUBuffer, output: GPUBuffer, params: GPUBuffer): void => {
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.smoothPipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
          layout: smoothLayout,
          entries: [
            { binding: 0, resource: { buffer: input } },
            { binding: 1, resource: { buffer: output } },
            { binding: 2, resource: { buffer: params } },
          ],
        }));
        pass.dispatchWorkgroups(dispatchX, dispatchY);
        pass.end();
      };
      dispatch(source, scratchA, horizontalParams);
      dispatch(scratchA, scratchB, verticalParams);
      encoder.copyBufferToBuffer(
        scratchB,
        0,
        readback,
        outputIndex * bytesPerField,
        bytesPerField,
      );
    };
    smooth(elevation, radii.lighting, 0);
    smooth(relief, radii.relief, 1);
    smooth(normalizedRidge, radii.rib, 2);
    smooth(normalizedInk, radii.crease, 3);
    smooth(normalizedCoverage, radii.footprint, 4);
    smooth(normalizedLinework, radii.lineworkFootprint, 5);
    smooth(normalizedRidge, radii.snowRidge, 6);
    this.peakWorkingBytes = Math.max(
      this.peakWorkingBytes,
      this.retainedBytes + temporary.reduce((sum, buffer) => sum + buffer.size, 0),
    );
    const computeStarted = now();
    this.device.queue.submit([encoder.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    const computeMs = now() - computeStarted;
    await checkpoint();
    const readbackStarted = now();
    let mapped = false;
    try {
      await readback.mapAsync(MAP_READ_MODE, 0, totalReadbackBytes);
      mapped = true;
      const data = readback.getMappedRange(0, totalReadbackBytes);
      const copyField = (index: number): Float32Array => new Float32Array(
        data.slice(index * bytesPerField, (index + 1) * bytesPerField),
      );
      return {
        fields: {
          width: sources.width,
          height: sources.height,
          lightingElevation: copyField(0),
          reliefReference: copyField(1),
          ribField: copyField(2),
          creaseField: copyField(3),
          footprint: copyField(4),
          lineworkFootprint: copyField(5),
          snowRidgeField: copyField(6),
        },
        uploadMs,
        computeMs,
        readbackMs: now() - readbackStarted,
      };
    } finally {
      if (mapped) readback.unmap();
      for (const buffer of temporary) buffer.destroy();
    }
  }

  async prepare(
    sources: MountainFieldGpuSources,
    radii: Parameters<MountainFieldGpuSession['prepare']>[1],
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<{ fields: MountainIllustrationPreparedFields; report: MountainFieldGpuReport }> {
    const throwIfCancelled = (): void => {
      if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
    };
    throwIfCancelled();
    const started = now();
    const sourceRefs = [
      sources.lightingElevation,
      sources.reliefElevation,
      sources.ridgeInk,
      sources.ink,
      sources.coverage,
      sources.lineworkCoverage,
    ] as const;
    const radiiKey = [
      radii.lighting,
      radii.relief,
      radii.rib,
      radii.crease,
      radii.footprint,
      radii.lineworkFootprint,
      radii.snowRidge,
    ].join(',');
    const cached = this.preparedFieldCache;
    if (
      cached
      && cached.width === sources.width
      && cached.height === sources.height
      && cached.radiiKey === radiiKey
      && cached.sources.every((source, index) => source === sourceRefs[index])
    ) {
      throwIfCancelled();
      return {
        fields: cached.fields,
        report: {
          backend: 'webgpu',
          cacheHit: true,
          initializationMs: 0,
          uploadMs: 0,
          computeMs: 0,
          readbackMs: 0,
          totalMs: now() - started,
          tileCount: 0,
          tileSize: cached.tileSize,
          retainedGpuBytes: this.retainedBytes,
          peakGpuBytes: this.peakWorkingBytes,
          maxStorageBufferBindingSize: this.device.limits.maxStorageBufferBindingSize,
          maxBufferSize: this.device.limits.maxBufferSize,
        },
      };
    }
    const maxRadius = Math.max(
      ceilRadius(radii.lighting),
      ceilRadius(radii.relief),
      ceilRadius(radii.rib),
      ceilRadius(radii.crease),
      ceilRadius(radii.footprint),
      ceilRadius(radii.lineworkFootprint),
      ceilRadius(radii.snowRidge),
    );
    const deviceLimitElements = Math.floor(
      Math.min(
        this.device.limits.maxStorageBufferBindingSize,
        this.device.limits.maxBufferSize,
      ) / 4,
    );
    const budgetElements = Math.floor(this.maxGpuBytes / (4 * 12));
    const limitSide = Math.floor(Math.sqrt(Math.min(deviceLimitElements, budgetElements)));
    const tileSize = Math.min(this.requestedTileSize, limitSide - maxRadius * 2);
    if (tileSize < 1) {
      throw new Error('WebGPU tile halo exceeds the device or memory limit');
    }
    const outputFields = {
      lightingElevation: new Float32Array(sources.width * sources.height),
      reliefReference: new Float32Array(sources.width * sources.height),
      ribField: new Float32Array(sources.width * sources.height),
      creaseField: new Float32Array(sources.width * sources.height),
      footprint: new Float32Array(sources.width * sources.height),
      lineworkFootprint: new Float32Array(sources.width * sources.height),
      snowRidgeField: new Float32Array(sources.width * sources.height),
    };
    let tileCount = 0;
    let uploadMs = 0;
    let computeMs = 0;
    let readbackMs = 0;
    for (let y = 0; y < sources.height; y += tileSize) {
      for (let x = 0; x < sources.width; x += tileSize) {
        throwIfCancelled();
        const interiorWidth = Math.min(tileSize, sources.width - x);
        const interiorHeight = Math.min(tileSize, sources.height - y);
        const left = Math.max(0, x - maxRadius);
        const top = Math.max(0, y - maxRadius);
        const right = Math.min(sources.width, x + interiorWidth + maxRadius);
        const bottom = Math.min(sources.height, y + interiorHeight + maxRadius);
        const regionSources: MountainFieldGpuSources = {
          width: right - left,
          height: bottom - top,
          lightingElevation: extractRegion(sources.lightingElevation, sources.width, sources.height, left, top, right - left, bottom - top) as Float32Array,
          reliefElevation: extractRegion(sources.reliefElevation, sources.width, sources.height, left, top, right - left, bottom - top) as Float32Array,
          ridgeInk: extractRegion(sources.ridgeInk, sources.width, sources.height, left, top, right - left, bottom - top),
          ink: extractRegion(sources.ink, sources.width, sources.height, left, top, right - left, bottom - top),
          coverage: extractRegion(sources.coverage, sources.width, sources.height, left, top, right - left, bottom - top),
          lineworkCoverage: extractRegion(sources.lineworkCoverage, sources.width, sources.height, left, top, right - left, bottom - top),
        };
        const region = await this.prepareRegion(regionSources, radii, control);
        const cropX = x - left;
        const cropY = y - top;
        const copy = (field: Float32Array, destination: Float32Array): void => {
          for (let row = 0; row < interiorHeight; row++) {
            const sourceOffset = (cropY + row) * region.fields.width + cropX;
            destination.set(
              field.subarray(sourceOffset, sourceOffset + interiorWidth),
              (y + row) * sources.width + x,
            );
          }
        };
        copy(region.fields.lightingElevation, outputFields.lightingElevation);
        copy(region.fields.reliefReference, outputFields.reliefReference);
        copy(region.fields.ribField, outputFields.ribField);
        copy(region.fields.creaseField, outputFields.creaseField);
        copy(region.fields.footprint, outputFields.footprint);
        copy(region.fields.lineworkFootprint, outputFields.lineworkFootprint);
        copy(region.fields.snowRidgeField, outputFields.snowRidgeField);
        uploadMs += region.uploadMs;
        computeMs += region.computeMs;
        readbackMs += region.readbackMs;
        tileCount++;
        throwIfCancelled();
        if (control.checkpoint) await control.checkpoint();
      }
    }
    const fields = { width: sources.width, height: sources.height, ...outputFields };
    this.preparedFieldCache = {
      width: sources.width,
      height: sources.height,
      sources: sourceRefs,
      radiiKey,
      fields,
      tileCount,
      tileSize,
    };
    return {
      fields,
      report: {
        backend: 'webgpu',
        cacheHit: false,
        initializationMs: 0,
        uploadMs,
        computeMs,
        readbackMs,
        totalMs: now() - started,
        tileCount,
        tileSize,
        retainedGpuBytes: this.retainedBytes,
        peakGpuBytes: this.peakWorkingBytes,
        maxStorageBufferBindingSize: this.device.limits.maxStorageBufferBindingSize,
        maxBufferSize: this.device.limits.maxBufferSize,
      },
    };
  }

  private async prepareWindRegion(
    sources: MountainWindGpuSources,
    rays: WindRayData,
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<PreparedRegion<MountainWindGpuFields>> {
    if (this.lost) throw new Error('WebGPU device was lost');
    const checkpoint = async (): Promise<void> => {
      if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
      if (control.checkpoint) await control.checkpoint();
      if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
    };
    const bytesPerField = sources.width * sources.height * Float32Array.BYTES_PER_ELEMENT;
    const totalReadbackBytes = bytesPerField * 3;
    const temporary: GPUBuffer[] = [];
    const createTemporary = (size: number, usage: number): GPUBuffer => {
      const buffer = this.device.createBuffer({ size: alignedSize(size), usage });
      temporary.push(buffer);
      return buffer;
    };
    const uploadStarted = now();
    const upload = (source: ArrayBufferView, usage = STORAGE | COPY_DST): GPUBuffer => {
      const buffer = createTemporary(source.byteLength, usage);
      this.device.queue.writeBuffer(buffer, 0, source as ArrayBufferView);
      return buffer;
    };
    const elevation = upload(sources.elevation);
    const rawShelter = createTemporary(bytesPerField, STORAGE | COPY_SRC | COPY_DST);
    const rawLoading = createTemporary(bytesPerField, STORAGE | COPY_SRC | COPY_DST);
    const rawSlopeBreak = createTemporary(bytesPerField, STORAGE | COPY_SRC | COPY_DST);
    const rayX = upload(rays.x);
    const rayY = upload(rays.y);
    const rayInverseDistance = upload(rays.inverseDistance);
    const raySampleIndex = upload(rays.sampleIndex);
    const windParams = createTemporary(16, UNIFORM | COPY_DST);
    this.device.queue.writeBuffer(
      windParams,
      0,
      new Uint32Array([sources.width, sources.height, rays.x.length, 0]),
    );
    const uploadMs = now() - uploadStarted;

    const scratchA = this.ensureBuffer(this.scratchA, bytesPerField, STORAGE | COPY_SRC | COPY_DST);
    const scratchB = this.ensureBuffer(this.scratchB, bytesPerField, STORAGE | COPY_SRC | COPY_DST);
    const readback = this.ensureBuffer(this.readback, totalReadbackBytes, MAP_READ | COPY_DST);
    this.scratchA = scratchA;
    this.scratchB = scratchB;
    this.readback = readback;
    const encoder = this.device.createCommandEncoder();
    const windPass = encoder.beginComputePass();
    windPass.setPipeline(this.windPipeline);
    windPass.setBindGroup(0, this.device.createBindGroup({
      layout: this.windPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: elevation } },
        { binding: 1, resource: { buffer: rawShelter } },
        { binding: 2, resource: { buffer: rawLoading } },
        { binding: 3, resource: { buffer: rawSlopeBreak } },
        { binding: 4, resource: { buffer: rayX } },
        { binding: 5, resource: { buffer: rayY } },
        { binding: 6, resource: { buffer: rayInverseDistance } },
        { binding: 7, resource: { buffer: raySampleIndex } },
        { binding: 8, resource: { buffer: windParams } },
      ],
    }));
    windPass.dispatchWorkgroups(Math.ceil(sources.width / 8), Math.ceil(sources.height / 8));
    windPass.end();

    const smoothLayout = this.smoothPipeline.getBindGroupLayout(0);
    const dispatchX = Math.ceil(sources.width / 8);
    const dispatchY = Math.ceil(sources.height / 8);
    const smooth = (source: GPUBuffer, radius: number, outputIndex: number): void => {
      const integerRadius = ceilRadius(radius);
      const horizontalParams = createTemporary(16, UNIFORM | COPY_DST);
      const verticalParams = createTemporary(16, UNIFORM | COPY_DST);
      this.device.queue.writeBuffer(horizontalParams, 0, new Uint32Array([
        sources.width, sources.height, integerRadius, 0,
      ]));
      this.device.queue.writeBuffer(verticalParams, 0, new Uint32Array([
        sources.width, sources.height, integerRadius, 1,
      ]));
      const dispatch = (input: GPUBuffer, output: GPUBuffer, params: GPUBuffer): void => {
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.smoothPipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
          layout: smoothLayout,
          entries: [
            { binding: 0, resource: { buffer: input } },
            { binding: 1, resource: { buffer: output } },
            { binding: 2, resource: { buffer: params } },
          ],
        }));
        pass.dispatchWorkgroups(dispatchX, dispatchY);
        pass.end();
      };
      dispatch(source, scratchA, horizontalParams);
      dispatch(scratchA, scratchB, verticalParams);
      encoder.copyBufferToBuffer(scratchB, 0, readback, outputIndex * bytesPerField, bytesPerField);
    };
    smooth(rawShelter, 1.8, 0);
    smooth(rawLoading, 2.2, 1);
    smooth(rawSlopeBreak, 2.2, 2);
    this.peakWorkingBytes = Math.max(
      this.peakWorkingBytes,
      this.retainedBytes + temporary.reduce((sum, buffer) => sum + buffer.size, 0),
    );
    const computeStarted = now();
    this.device.queue.submit([encoder.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    const computeMs = now() - computeStarted;
    await checkpoint();
    const readbackStarted = now();
    let mapped = false;
    try {
      await readback.mapAsync(MAP_READ_MODE, 0, totalReadbackBytes);
      mapped = true;
      const data = readback.getMappedRange(0, totalReadbackBytes);
      const copyField = (index: number): Float32Array => new Float32Array(
        data.slice(index * bytesPerField, (index + 1) * bytesPerField),
      );
      return {
        fields: {
          width: sources.width,
          height: sources.height,
          windShelter: copyField(0),
          windLoading: copyField(1),
          slopeBreak: copyField(2),
        },
        uploadMs,
        computeMs,
        readbackMs: now() - readbackStarted,
      };
    } finally {
      if (mapped) readback.unmap();
      for (const buffer of temporary) buffer.destroy();
    }
  }

  async prepareWindFields(
    sources: MountainWindGpuSources,
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<{ fields: MountainWindGpuFields; report: MountainFieldGpuReport }> {
    const throwIfCancelled = (): void => {
      if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
    };
    throwIfCancelled();
    const started = now();
    const rays = buildWindRayData(sources.dxMeters, sources.dyMeters, sources.windAzimuthDeg);
    const smoothingHalo = 3;
    const haloX = rays.maxOffsetX + smoothingHalo;
    const haloY = rays.maxOffsetY + smoothingHalo;
    const deviceLimitElements = Math.floor(
      Math.min(
        this.device.limits.maxStorageBufferBindingSize,
        this.device.limits.maxBufferSize,
      ) / 4,
    );
    const budgetElements = Math.floor(this.maxGpuBytes / (4 * 16));
    const limitSide = Math.floor(Math.sqrt(Math.min(deviceLimitElements, budgetElements)));
    const tileSize = Math.min(this.requestedTileSize, limitSide - Math.max(haloX, haloY) * 2);
    if (tileSize < 1) throw new Error('WebGPU wind-field halo exceeds the device or memory limit');
    const total = sources.width * sources.height;
    const output = {
      windShelter: new Float32Array(total),
      windLoading: new Float32Array(total),
      slopeBreak: new Float32Array(total),
    };
    let tileCount = 0;
    let uploadMs = 0;
    let computeMs = 0;
    let readbackMs = 0;
    for (let y = 0; y < sources.height; y += tileSize) {
      for (let x = 0; x < sources.width; x += tileSize) {
        throwIfCancelled();
        const interiorWidth = Math.min(tileSize, sources.width - x);
        const interiorHeight = Math.min(tileSize, sources.height - y);
        const left = Math.max(0, x - haloX);
        const top = Math.max(0, y - haloY);
        const right = Math.min(sources.width, x + interiorWidth + haloX);
        const bottom = Math.min(sources.height, y + interiorHeight + haloY);
        const regionWidth = right - left;
        const regionHeight = bottom - top;
        const region: MountainWindGpuSources = {
          width: regionWidth,
          height: regionHeight,
          elevation: extractRegion(
            sources.elevation,
            sources.width,
            sources.height,
            left,
            top,
            regionWidth,
            regionHeight,
          ) as Float32Array,
          dxMeters: sources.dxMeters,
          dyMeters: sources.dyMeters,
          windAzimuthDeg: sources.windAzimuthDeg,
        };
        const prepared = await this.prepareWindRegion(region, rays, control);
        const cropX = x - left;
        const cropY = y - top;
        const copy = (field: Float32Array, destination: Float32Array): void => {
          for (let row = 0; row < interiorHeight; row++) {
            const sourceOffset = (cropY + row) * region.width + cropX;
            destination.set(
              field.subarray(sourceOffset, sourceOffset + interiorWidth),
              (y + row) * sources.width + x,
            );
          }
        };
        copy(prepared.fields.windShelter, output.windShelter);
        copy(prepared.fields.windLoading, output.windLoading);
        copy(prepared.fields.slopeBreak, output.slopeBreak);
        uploadMs += prepared.uploadMs;
        computeMs += prepared.computeMs;
        readbackMs += prepared.readbackMs;
        tileCount++;
        throwIfCancelled();
        if (control.checkpoint) await control.checkpoint();
      }
    }
    return {
      fields: { width: sources.width, height: sources.height, ...output },
      report: {
        backend: 'webgpu',
        initializationMs: 0,
        uploadMs,
        computeMs,
        readbackMs,
        totalMs: now() - started,
        tileCount,
        tileSize,
        retainedGpuBytes: this.retainedBytes,
        peakGpuBytes: this.peakWorkingBytes,
        maxStorageBufferBindingSize: this.device.limits.maxStorageBufferBindingSize,
        maxBufferSize: this.device.limits.maxBufferSize,
      },
    };
  }

  async rasterizeMountainLayer(
    sources: MountainGpuMountainLayerSources,
    options: MountainGpuMountainLayerOptions = {},
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<{
    data: Uint8ClampedArray;
    uploadMs: number;
    computeMs: number;
    readbackMs: number;
    totalMs: number;
    retainedGpuBytes: number;
    peakGpuBytes?: number;
  }> {
    if (this.lost) throw new Error('WebGPU device was lost');
    const mountainRasterPipeline = await this.ensureMountainRasterPipeline();
    const started = now();
    const throwIfCancelled = (): void => {
      if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
    };
    throwIfCancelled();
    const total = sources.width * sources.height;
    const temporary: GPUBuffer[] = [];
    const createTemporary = (size: number, usage: number): GPUBuffer => {
      const buffer = this.device.createBuffer({ size: alignedSize(size), usage });
      temporary.push(buffer);
      return buffer;
    };
    const uploadStarted = now();
    const upload = (source: Float32Array): GPUBuffer => {
      const buffer = createTemporary(source.byteLength, STORAGE | COPY_DST);
      this.device.queue.writeBuffer(buffer, 0, source);
      return buffer;
    };
    const baseElevation = upload(sources.baseElevation);
    const packedSupportFields = new Float32Array(total * 8);
    for (let index = 0; index < total; index++) {
      const packedOffset = index * 8;
      packedSupportFields[packedOffset] = sources.fields.lightingElevation[index] ?? 0;
      packedSupportFields[packedOffset + 1] = sources.fields.reliefReference[index] ?? 0;
      packedSupportFields[packedOffset + 2] = sources.fields.ribField[index] ?? 0;
      packedSupportFields[packedOffset + 3] = sources.fields.creaseField[index] ?? 0;
      packedSupportFields[packedOffset + 4] = sources.fields.footprint[index] ?? 0;
      packedSupportFields[packedOffset + 5] = sources.fields.lineworkFootprint[index] ?? 0;
      packedSupportFields[packedOffset + 6] = sources.fields.snowRidgeField[index] ?? 0;
    }
    const supportFields = upload(packedSupportFields);
    const destination = createTemporary(total * Uint32Array.BYTES_PER_ELEMENT, STORAGE | COPY_SRC);
    const readback = createTemporary(total * Uint32Array.BYTES_PER_ELEMENT, MAP_READ | COPY_DST);
    const params = createTemporary(96, UNIFORM | COPY_DST);
    const ink = colorToUnit(options.inkColor ?? [43, 56, 66]);
    const ridge = colorToUnit(options.ridgeColor ?? [43, 56, 66]);
    const snowShadow = colorToUnit(options.snowShadowColor ?? [153, 181, 202]);
    const snow = colorToUnit(options.snowColor ?? [247, 249, 247]);
    const parameterBytes = new ArrayBuffer(96);
    const parameterView = new DataView(parameterBytes);
    parameterView.setUint32(0, sources.width, true);
    parameterView.setUint32(4, sources.height, true);
    parameterView.setFloat32(8, sources.elevationMin, true);
    parameterView.setFloat32(12, sources.elevationMax, true);
    for (let index = 0; index < 4; index++) {
      parameterView.setFloat32(16 + index * 4, ink[index] ?? (index === 3 ? 1 : 0), true);
      parameterView.setFloat32(32 + index * 4, ridge[index] ?? (index === 3 ? 1 : 0), true);
      parameterView.setFloat32(48 + index * 4, snowShadow[index] ?? (index === 3 ? 1 : 0), true);
      parameterView.setFloat32(64 + index * 4, snow[index] ?? (index === 3 ? 1 : 0), true);
    }
    // The trailing scalar is padded to the uniform's 16-byte alignment.
    parameterView.setFloat32(80, Math.max(0, options.snowAmount ?? 1), true);
    this.device.queue.writeBuffer(params, 0, new Uint8Array(parameterBytes));
    const uploadMs = now() - uploadStarted;

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(mountainRasterPipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: mountainRasterPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: baseElevation } },
        { binding: 1, resource: { buffer: supportFields } },
        { binding: 2, resource: { buffer: destination } },
        { binding: 3, resource: { buffer: params } },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(sources.width / 8), Math.ceil(sources.height / 8));
    pass.end();
    encoder.copyBufferToBuffer(
      destination,
      0,
      readback,
      0,
      total * Uint32Array.BYTES_PER_ELEMENT,
    );
    this.peakWorkingBytes = Math.max(
      this.peakWorkingBytes,
      this.retainedBytes + temporary.reduce((sum, buffer) => sum + buffer.size, 0),
    );
    const computeStarted = now();
    this.device.queue.submit([encoder.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    const computeMs = now() - computeStarted;
    throwIfCancelled();
    if (control.checkpoint) await control.checkpoint();
    throwIfCancelled();
    const readbackStarted = now();
    let mapped = false;
    try {
      await readback.mapAsync(MAP_READ_MODE, 0, total * Uint32Array.BYTES_PER_ELEMENT);
      mapped = true;
      const packed = new Uint32Array(
        readback.getMappedRange(0, total * Uint32Array.BYTES_PER_ELEMENT).slice(0),
      );
      const data = new Uint8ClampedArray(total * 4);
      for (let index = 0; index < packed.length; index++) {
        const value = packed[index];
        const offset = index * 4;
        data[offset] = value & 255;
        data[offset + 1] = (value >>> 8) & 255;
        data[offset + 2] = (value >>> 16) & 255;
        data[offset + 3] = value >>> 24;
      }
      return {
        data,
        uploadMs,
        computeMs,
        readbackMs: now() - readbackStarted,
        totalMs: now() - started,
        retainedGpuBytes: this.retainedBytes,
        peakGpuBytes: this.peakWorkingBytes,
      };
    } finally {
      if (mapped) readback.unmap();
      for (const buffer of temporary) buffer.destroy();
    }
  }

  async composeRgba(
    width: number,
    height: number,
    source: Uint8ClampedArray,
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<{
    data: Uint8ClampedArray;
    uploadMs: number;
    computeMs: number;
    readbackMs: number;
    totalMs: number;
    retainedGpuBytes: number;
    peakGpuBytes?: number;
  }> {
    if (this.lost) throw new Error('WebGPU device was lost');
    if (source.length !== width * height * 4) {
      throw new Error('GPU composition source dimensions do not match the frame');
    }
    const rgbaCopyPipeline = await this.ensureRgbaCopyPipeline();
    const started = now();
    const output = new Uint8ClampedArray(source.length);
    const layout = rgbaCopyPipeline.getBindGroupLayout(0);
    let uploadMs = 0;
    let computeMs = 0;
    let readbackMs = 0;
    for (let y = 0; y < height; y += this.requestedTileSize) {
      for (let x = 0; x < width; x += this.requestedTileSize) {
        if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
        const tileWidth = Math.min(this.requestedTileSize, width - x);
        const tileHeight = Math.min(this.requestedTileSize, height - y);
        const tilePixels = tileWidth * tileHeight;
        const tileBytes = tilePixels * 4;
        const packed = new Uint32Array(tilePixels);
        const sourceBuffer = source.buffer as ArrayBuffer;
        for (let row = 0; row < tileHeight; row++) {
          const sourceOffset = ((y + row) * width + x) * 4;
          packed.set(
            new Uint32Array(sourceBuffer, source.byteOffset + sourceOffset, tileWidth),
            row * tileWidth,
          );
        }
        const uploadStarted = now();
        this.rgbaSource = this.ensureBuffer(
          this.rgbaSource,
          tileBytes,
          STORAGE | COPY_SRC | COPY_DST,
        );
        this.rgbaDestination = this.ensureBuffer(
          this.rgbaDestination,
          tileBytes,
          STORAGE | COPY_SRC | COPY_DST,
        );
        this.rgbaParams = this.ensureBuffer(this.rgbaParams, 16, UNIFORM | COPY_DST);
        this.rgbaReadback = this.ensureBuffer(
          this.rgbaReadback,
          tileBytes,
          MAP_READ | COPY_DST,
        );
        if (this.retainedBytes > this.maxGpuBytes) {
          throw new Error('GPU composition exceeded the memory budget');
        }
        this.device.queue.writeBuffer(this.rgbaSource, 0, packed);
        this.device.queue.writeBuffer(this.rgbaParams, 0, new Uint32Array([tilePixels]));
        uploadMs += now() - uploadStarted;

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(rgbaCopyPipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: this.rgbaSource } },
            { binding: 1, resource: { buffer: this.rgbaDestination } },
            { binding: 2, resource: { buffer: this.rgbaParams } },
          ],
        }));
        pass.dispatchWorkgroups(Math.ceil(tilePixels / 64));
        pass.end();
        encoder.copyBufferToBuffer(this.rgbaDestination, 0, this.rgbaReadback, 0, tileBytes);
        const computeStarted = now();
        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();
        computeMs += now() - computeStarted;
        const readbackStarted = now();
        await this.rgbaReadback.mapAsync(MAP_READ_MODE, 0, tileBytes);
        const tile = new Uint8Array(this.rgbaReadback.getMappedRange(0, tileBytes).slice(0));
        this.rgbaReadback.unmap();
        readbackMs += now() - readbackStarted;
        for (let row = 0; row < tileHeight; row++) {
          const destinationOffset = ((y + row) * width + x) * 4;
          output.set(
            tile.subarray(row * tileWidth * 4, (row + 1) * tileWidth * 4),
            destinationOffset,
          );
        }
        if (control.checkpoint) await control.checkpoint();
      }
    }
    this.peakWorkingBytes = Math.max(this.peakWorkingBytes, this.retainedBytes);
    return {
      data: output,
      uploadMs,
      computeMs,
      readbackMs,
      totalMs: now() - started,
      retainedGpuBytes: this.retainedBytes,
      peakGpuBytes: this.peakWorkingBytes,
    };
  }

  async composeLayersRgba(
    width: number,
    height: number,
    layers: readonly MountainGpuRgbaLayer[],
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<{
    data: Uint8ClampedArray;
    uploadMs: number;
    computeMs: number;
    readbackMs: number;
    totalMs: number;
    retainedGpuBytes: number;
    peakGpuBytes?: number;
  }> {
    if (this.lost) throw new Error('WebGPU device was lost');
    if (layers.length === 0) throw new Error('GPU composition requires at least one layer');
    const expectedLength = width * height * 4;
    for (const layer of layers) {
      if (layer.data.length !== expectedLength) {
        throw new Error('GPU composition layer dimensions do not match the frame');
      }
    }
    const rgbaBlendPipeline = await this.ensureRgbaBlendPipeline();
    const started = now();
    const output = new Uint8ClampedArray(expectedLength);
    const layout = rgbaBlendPipeline.getBindGroupLayout(0);
    let uploadMs = 0;
    let computeMs = 0;
    let readbackMs = 0;
    for (let y = 0; y < height; y += this.requestedTileSize) {
      for (let x = 0; x < width; x += this.requestedTileSize) {
        if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
        const tileWidth = Math.min(this.requestedTileSize, width - x);
        const tileHeight = Math.min(this.requestedTileSize, height - y);
        const tilePixels = tileWidth * tileHeight;
        const tileBytes = tilePixels * 4;
        this.rgbaSource = this.ensureBuffer(
          this.rgbaSource,
          tileBytes,
          STORAGE | COPY_SRC | COPY_DST,
        );
        this.rgbaDestination = this.ensureBuffer(
          this.rgbaDestination,
          tileBytes,
          STORAGE | COPY_SRC | COPY_DST,
        );
        for (let layerIndex = 1; layerIndex < layers.length; layerIndex++) {
          const overlayIndex = layerIndex - 1;
          this.rgbaOverlays[overlayIndex] = this.ensureBuffer(
            this.rgbaOverlays[overlayIndex],
            tileBytes,
            STORAGE | COPY_DST,
          );
          this.rgbaLayerParams[overlayIndex] = this.ensureBuffer(
            this.rgbaLayerParams[overlayIndex],
            16,
            UNIFORM | COPY_DST,
          );
        }
        this.rgbaReadback = this.ensureBuffer(
          this.rgbaReadback,
          tileBytes,
          MAP_READ | COPY_DST,
        );
        if (this.retainedBytes > this.maxGpuBytes) {
          throw new Error('GPU composition exceeded the memory budget');
        }

        const sourceBuffer = layers[0].data.buffer as ArrayBuffer;
        const baseTile = new Uint32Array(tilePixels);
        for (let row = 0; row < tileHeight; row++) {
          const sourceOffset = ((y + row) * width + x) * 4;
          baseTile.set(
            new Uint32Array(sourceBuffer, layers[0].data.byteOffset + sourceOffset, tileWidth),
            row * tileWidth,
          );
        }
        const uploadStarted = now();
        this.device.queue.writeBuffer(this.rgbaSource, 0, baseTile);
        let current = this.rgbaSource;
        let next = this.rgbaDestination;
        const encoder = this.device.createCommandEncoder();
        for (let layerIndex = 1; layerIndex < layers.length; layerIndex++) {
          if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
          const layer = layers[layerIndex];
          const opacity = Math.max(0, Math.min(1, layer.opacity ?? 1));
          if (opacity <= 0) continue;
          const layerBuffer = layer.data.buffer as ArrayBuffer;
          const overlayTile = new Uint32Array(tilePixels);
          for (let row = 0; row < tileHeight; row++) {
            const sourceOffset = ((y + row) * width + x) * 4;
            overlayTile.set(
              new Uint32Array(layerBuffer, layer.data.byteOffset + sourceOffset, tileWidth),
              row * tileWidth,
            );
          }
          const overlayBuffer = this.rgbaOverlays[layerIndex - 1];
          const paramsBuffer = this.rgbaLayerParams[layerIndex - 1];
          this.device.queue.writeBuffer(overlayBuffer, 0, overlayTile);
          this.device.queue.writeBuffer(
            paramsBuffer,
            0,
            new Uint32Array([tilePixels, Math.round(opacity * 255), 0, 0]),
          );
          const pass = encoder.beginComputePass();
          pass.setPipeline(rgbaBlendPipeline);
          pass.setBindGroup(0, this.device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { buffer: current } },
              { binding: 1, resource: { buffer: overlayBuffer } },
              { binding: 2, resource: { buffer: next } },
              { binding: 3, resource: { buffer: paramsBuffer } },
            ],
          }));
          pass.dispatchWorkgroups(Math.ceil(tilePixels / 64));
          pass.end();
          const swap = current;
          current = next;
          next = swap;
        }
        uploadMs += now() - uploadStarted;
        // The final output is already in `current`; no intermediate layer is
        // read back, so a frame with many layers pays for one readback only.
        encoder.copyBufferToBuffer(current, 0, this.rgbaReadback, 0, tileBytes);
        const computeStarted = now();
        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();
        computeMs += now() - computeStarted;
        const readbackStarted = now();
        await this.rgbaReadback.mapAsync(MAP_READ_MODE, 0, tileBytes);
        const tile = new Uint8Array(this.rgbaReadback.getMappedRange(0, tileBytes).slice(0));
        this.rgbaReadback.unmap();
        readbackMs += now() - readbackStarted;
        for (let row = 0; row < tileHeight; row++) {
          const destinationOffset = ((y + row) * width + x) * 4;
          output.set(
            tile.subarray(row * tileWidth * 4, (row + 1) * tileWidth * 4),
            destinationOffset,
          );
        }
        // Keep the most recently used buffers warm for the next tile.
        this.rgbaSource = current;
        this.rgbaDestination = next;
        if (control.checkpoint) await control.checkpoint();
      }
    }
    this.peakWorkingBytes = Math.max(this.peakWorkingBytes, this.retainedBytes);
    return {
      data: output,
      uploadMs,
      computeMs,
      readbackMs,
      totalMs: now() - started,
      retainedGpuBytes: this.retainedBytes,
      peakGpuBytes: this.peakWorkingBytes,
    };
  }

  destroy(): void {
    this.scratchA?.destroy();
    this.scratchB?.destroy();
    this.readback?.destroy();
    this.rgbaSource?.destroy();
    for (const buffer of this.rgbaOverlays) buffer.destroy();
    for (const buffer of this.rgbaLayerParams) buffer.destroy();
    this.rgbaDestination?.destroy();
    this.rgbaParams?.destroy();
    this.rgbaReadback?.destroy();
    this.device.destroy();
    this.retainedBytes = 0;
    this.preparedFieldCache = undefined;
  }
}

/** Create a reusable GPU session, or return null when WebGPU is unavailable. */
export async function createMountainFieldGpuSession(
  options: MountainFieldGpuOptions = {},
): Promise<MountainFieldGpuSession | null> {
  if (!hasWebGpu()) return null;
  const budget = Math.max(16 * 1024 * 1024, options.maxGpuBytes ?? DEFAULT_GPU_BUDGET);
  const tileSize = Math.max(32, Math.min(1024, Math.floor(options.tileSize ?? 1024)));
  const created = await WebGpuMountainFieldSession.create(budget, tileSize);
  return created.session;
}

/** Exposed for the browser benchmark and capability diagnostics. */
export async function getMountainFieldGpuCapabilities(): Promise<{
  supported: boolean;
  maxStorageBufferBindingSize?: number;
  maxBufferSize?: number;
  reason?: string;
}> {
  if (!hasWebGpu()) return { supported: false, reason: 'WebGPU is unavailable' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { supported: false, reason: 'No WebGPU adapter is available' };
    return {
      supported: true,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    };
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

import {
  createMountainFieldGpuSession,
  type MountainFieldGpuOptions,
  type MountainFieldGpuPrepareControl,
  type MountainFieldGpuSources,
  type MountainWindGpuFields,
  type MountainWindGpuSources,
  type MountainGpuMountainLayerOptions,
  type MountainGpuMountainLayerSources,
  type MountainGpuRgbaLayer,
  type MountainFieldGpuSession,
} from './mountainFieldGpu';
import type { MountainIllustrationPreparedFields } from './mountainIllustrationFields';

/** Selects the renderer used for a preview or export request. */
export type MountainGpuRenderMode = 'auto' | 'cpuExact' | 'gpuFast' | 'gpuApprox';

export interface MountainGpuRenderReport {
  backend: 'webgpu';
  mode: 'gpuFast';
  initializationMs: number;
  uploadMs: number;
  mountainComputeMs: number;
  waterComputeMs: number;
  vegetationComputeMs: number;
  compositionMs: number;
  readbackMs: number;
  totalMs: number;
  cacheHit: boolean;
  tileCount?: number;
  tileSize?: number;
  retainedGpuBytes: number;
  peakGpuBytes: number;
  maxAbsError?: number;
  meanAbsError?: number;
  changedPixels?: number;
  fallbackReason?: string;
}

export interface MountainGpuSessionOptions extends MountainFieldGpuOptions {
  /** The request mode is retained for diagnostics; GPU sessions are only
   * constructed for explicit GPU modes. */
  mode?: MountainGpuRenderMode;
}

export interface MountainGpuComposeResult {
  imageData: ImageData;
  report: MountainGpuRenderReport;
}

/** A layer accepted by the resident GPU compositor. */
export interface MountainGpuLayerInput {
  image: ImageData;
  opacity?: number;
}

export interface MountainGpuMountainLayerInput {
  baseElevation: Float32Array;
  fields: MountainIllustrationPreparedFields;
  elevationMin: number;
  elevationMax: number;
  options?: MountainGpuMountainLayerOptions;
}

/** Opaque, worker-local prepared raster fields. GPU resources never cross a
 * worker boundary; only this metadata can be used for diagnostics. */
export class MountainGpuFieldSet {
  readonly dependencyKey: string;
  readonly width: number;
  readonly height: number;
  readonly retainedGpuBytes: number;
  private readonly fields: MountainIllustrationPreparedFields;

  private constructor(
    dependencyKey: string,
    fields: MountainIllustrationPreparedFields,
    retainedGpuBytes: number,
  ) {
    this.dependencyKey = dependencyKey;
    this.width = fields.width;
    this.height = fields.height;
    this.retainedGpuBytes = retainedGpuBytes;
    this.fields = fields;
  }

  static create(
    dependencyKey: string,
    fields: MountainIllustrationPreparedFields,
    retainedGpuBytes: number,
  ): MountainGpuFieldSet {
    return new MountainGpuFieldSet(dependencyKey, fields, retainedGpuBytes);
  }

  /** Internal bridge for the CPU validation/compositor path. */
  getPreparedFields(): MountainIllustrationPreparedFields {
    return this.fields;
  }
}

/** Opaque frame handle retained by a worker until the final readback/present. */
export class MountainGpuFrame {
  readonly width: number;
  readonly height: number;
  readonly dependencyKey?: string;
  private readonly imageData: ImageData;

  private constructor(imageData: ImageData, dependencyKey?: string) {
    this.imageData = imageData;
    this.width = imageData.width;
    this.height = imageData.height;
    this.dependencyKey = dependencyKey;
  }

  static create(imageData: ImageData, dependencyKey?: string): MountainGpuFrame {
    return new MountainGpuFrame(imageData, dependencyKey);
  }

  /** Readback is explicit; callers receive a detached copy. */
  readback(): ImageData {
    return makeImageData(this.width, this.height, this.imageData.data);
  }
}

export interface MountainGpuFieldPreparationInput {
  sources: MountainFieldGpuSources;
  radii: Parameters<MountainFieldGpuSession['prepare']>[1];
  dependencyKey: string;
}

export interface MountainGpuSession {
  readonly available: boolean;
  readonly disabled: boolean;
  warmup(): Promise<void>;
  prepareFieldSet?(
    input: MountainGpuFieldPreparationInput,
    control?: MountainFieldGpuPrepareControl,
  ): Promise<{ fieldSet: MountainGpuFieldSet; report: MountainGpuRenderReport }>;
  prepareWindFields?(
    sources: MountainWindGpuSources,
    control?: MountainFieldGpuPrepareControl,
  ): Promise<{ fields: MountainWindGpuFields; report: MountainGpuRenderReport }>;
  invalidateFieldSet?(dependencyKey?: string): void;
  rasterizeMountainLayer?(
    input: MountainGpuMountainLayerInput,
    control?: MountainFieldGpuPrepareControl,
  ): Promise<MountainGpuComposeResult>;
  compose(
    image: ImageData,
    control?: MountainFieldGpuPrepareControl,
  ): Promise<MountainGpuComposeResult>;
  composeLayers(
    layers: readonly MountainGpuLayerInput[],
    control?: MountainFieldGpuPrepareControl,
  ): Promise<MountainGpuComposeResult>;
  composeFrame?(
    image: ImageData,
    fieldSet?: MountainGpuFieldSet,
    control?: MountainFieldGpuPrepareControl,
  ): Promise<{ frame: MountainGpuFrame; imageData: ImageData; report: MountainGpuRenderReport }>;
  dispose(): void;
}

/** Compare two RGBA buffers without allocating another image. */
export function compareMountainGpuImages(
  expected: Uint8ClampedArray,
  actual: Uint8ClampedArray,
): Pick<MountainGpuRenderReport, 'maxAbsError' | 'meanAbsError' | 'changedPixels'> {
  const length = Math.min(expected.length, actual.length);
  let maxAbsError = 0;
  let totalError = 0;
  let changedPixels = 0;
  for (let index = 0; index < length; index++) {
    const difference = Math.abs(expected[index] - actual[index]);
    maxAbsError = Math.max(maxAbsError, difference);
    totalError += difference;
    if (difference !== 0 && (index & 3) === 0) {
      // Count a pixel once even when several channels differ.
      changedPixels++;
    } else if (difference !== 0 && (index & 3) !== 0) {
      const pixelStart = index - (index & 3);
      let alreadyCounted = false;
      for (let channel = 0; channel < (index & 3); channel++) {
        if (expected[pixelStart + channel] !== actual[pixelStart + channel]) {
          alreadyCounted = true;
          break;
        }
      }
      if (!alreadyCounted) changedPixels++;
    }
  }
  const pixelCount = Math.max(1, Math.floor(length / 4));
  return {
    maxAbsError,
    meanAbsError: totalError / Math.max(1, length),
    changedPixels: Math.min(pixelCount, changedPixels),
  };
}

function makeImageData(width: number, height: number, data: Uint8ClampedArray): ImageData {
  // `ImageData` is typed against an ArrayBuffer-backed view while the renderer
  // APIs intentionally accept the wider `ArrayBufferLike` view. Copying here
  // also guarantees that the returned frame does not alias a staging buffer.
  const owned = new Uint8ClampedArray(data) as Uint8ClampedArray<ArrayBuffer>;
  if (typeof ImageData !== 'undefined') return new ImageData(owned, width, height);
  return { width, height, data: owned } as unknown as ImageData;
}

class MountainGpuSessionImpl implements MountainGpuSession {
  private readonly fieldSession: MountainFieldGpuSession;
  private readonly initializationMs: number;
  private initializationReported = false;
  private lost = false;
  private lastFrameKey = '';
  private lastFrameData: Uint8ClampedArray | undefined;
  private lastMountainRasterBase: Float32Array | undefined;
  private lastMountainRasterFields: MountainIllustrationPreparedFields | undefined;
  private lastMountainRasterOptionsKey = '';
  private lastMountainRasterData: Uint8ClampedArray | undefined;
  private readonly fieldSets = new Map<string, MountainGpuFieldSet>();

  constructor(fieldSession: MountainFieldGpuSession, initializationMs: number) {
    this.fieldSession = fieldSession;
    this.initializationMs = initializationMs;
  }

  get available(): boolean {
    return !this.lost;
  }

  get disabled(): boolean {
    return this.lost;
  }

  /** Initialization is a session cost, so expose it on the first operation
   * only. This keeps request profiles from counting the same cold-start work
   * once for fields, wind, rasterization, and composition. */
  private takeInitializationMs(): number {
    if (this.initializationReported) return 0;
    this.initializationReported = true;
    return this.initializationMs;
  }

  async warmup(): Promise<void> {
    if (this.lost) throw new Error('WebGPU device was lost');
  }

  async prepareFieldSet(
    input: MountainGpuFieldPreparationInput,
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<{ fieldSet: MountainGpuFieldSet; report: MountainGpuRenderReport }> {
    if (this.lost) throw new Error('WebGPU device was lost');
    const cached = this.fieldSets.get(input.dependencyKey);
    if (cached) {
      return {
        fieldSet: cached,
        report: {
          backend: 'webgpu',
          mode: 'gpuFast',
          initializationMs: this.takeInitializationMs(),
          uploadMs: 0,
          mountainComputeMs: 0,
          waterComputeMs: 0,
          vegetationComputeMs: 0,
          compositionMs: 0,
          readbackMs: 0,
          totalMs: 0,
          cacheHit: true,
          retainedGpuBytes: cached.retainedGpuBytes,
          peakGpuBytes: cached.retainedGpuBytes,
        },
      };
    }
    const result = await this.fieldSession.prepare(input.sources, input.radii, control);
    // The preview worker already retains the active field set in its stage
    // cache. Keep one GPU-session mirror as well; allowing every changed
    // setting to accumulate here would retain a full Float32 field bundle per
    // edit and quickly dominate the worker's memory.
    this.fieldSets.clear();
    this.lastMountainRasterBase = undefined;
    this.lastMountainRasterFields = undefined;
    this.lastMountainRasterOptionsKey = '';
    this.lastMountainRasterData = undefined;
    const fieldSet = MountainGpuFieldSet.create(
      input.dependencyKey,
      result.fields,
      result.report.retainedGpuBytes,
    );
    this.fieldSets.set(input.dependencyKey, fieldSet);
    return {
      fieldSet,
      report: {
        backend: 'webgpu',
        mode: 'gpuFast',
        initializationMs: this.takeInitializationMs(),
        uploadMs: result.report.uploadMs,
        mountainComputeMs: result.report.computeMs,
        waterComputeMs: 0,
        vegetationComputeMs: 0,
        compositionMs: 0,
        readbackMs: result.report.readbackMs,
        totalMs: result.report.totalMs,
        cacheHit: result.report.cacheHit ?? false,
        tileCount: result.report.tileCount,
        tileSize: result.report.tileSize,
        retainedGpuBytes: result.report.retainedGpuBytes,
        peakGpuBytes: result.report.peakGpuBytes ?? result.report.retainedGpuBytes,
      },
    };
  }

  invalidateFieldSet(dependencyKey?: string): void {
    if (dependencyKey === undefined) this.fieldSets.clear();
    else this.fieldSets.delete(dependencyKey);
  }

  async prepareWindFields(
    sources: MountainWindGpuSources,
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<{ fields: MountainWindGpuFields; report: MountainGpuRenderReport }> {
    if (this.lost) throw new Error('WebGPU device was lost');
    if (!this.fieldSession.prepareWindFields) {
      throw new Error('The active WebGPU session has no wind-field pass');
    }
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      const result = await this.fieldSession.prepareWindFields(sources, control);
      return {
        fields: result.fields,
        report: {
          backend: 'webgpu',
          mode: 'gpuFast',
          initializationMs: this.takeInitializationMs(),
          uploadMs: result.report.uploadMs,
          mountainComputeMs: result.report.computeMs,
          waterComputeMs: 0,
          vegetationComputeMs: 0,
          compositionMs: 0,
          readbackMs: result.report.readbackMs,
          totalMs: typeof performance !== 'undefined'
            ? performance.now() - started
            : Date.now() - started,
          cacheHit: false,
          tileCount: result.report.tileCount,
          tileSize: result.report.tileSize,
          retainedGpuBytes: result.report.retainedGpuBytes,
          peakGpuBytes: result.report.peakGpuBytes ?? result.report.retainedGpuBytes,
        },
      };
    } catch (error) {
      this.lost = true;
      throw error;
    }
  }

  async rasterizeMountainLayer(
    input: MountainGpuMountainLayerInput,
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<MountainGpuComposeResult> {
    if (this.lost) throw new Error('WebGPU device was lost');
    if (!this.fieldSession.rasterizeMountainLayer) {
      throw new Error('The active WebGPU session has no mountain raster pass');
    }
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const optionsKey = JSON.stringify({
      inkColor: input.options?.inkColor,
      ridgeColor: input.options?.ridgeColor,
      snowShadowColor: input.options?.snowShadowColor,
      snowColor: input.options?.snowColor,
      snowAmount: input.options?.snowAmount,
      elevationMin: input.elevationMin,
      elevationMax: input.elevationMax,
    });
    if (
      this.lastMountainRasterBase === input.baseElevation
      && this.lastMountainRasterFields === input.fields
      && this.lastMountainRasterOptionsKey === optionsKey
      && this.lastMountainRasterData
    ) {
      return {
        imageData: makeImageData(input.fields.width, input.fields.height, this.lastMountainRasterData),
        report: {
          backend: 'webgpu',
          mode: 'gpuFast',
          initializationMs: this.takeInitializationMs(),
          uploadMs: 0,
          mountainComputeMs: 0,
          waterComputeMs: 0,
          vegetationComputeMs: 0,
          compositionMs: 0,
          readbackMs: 0,
          totalMs: typeof performance !== 'undefined' ? performance.now() - started : Date.now() - started,
          cacheHit: true,
          retainedGpuBytes: 0,
          peakGpuBytes: 0,
        },
      };
    }
    const sources: MountainGpuMountainLayerSources = {
      width: input.fields.width,
      height: input.fields.height,
      baseElevation: input.baseElevation,
      fields: input.fields,
      elevationMin: input.elevationMin,
      elevationMax: input.elevationMax,
    };
    try {
      const result = await this.fieldSession.rasterizeMountainLayer(
        sources,
        input.options,
        control,
      );
      this.lastMountainRasterBase = input.baseElevation;
      this.lastMountainRasterFields = input.fields;
      this.lastMountainRasterOptionsKey = optionsKey;
      this.lastMountainRasterData = new Uint8ClampedArray(result.data);
      return {
        imageData: makeImageData(input.fields.width, input.fields.height, result.data),
        report: {
          backend: 'webgpu',
          mode: 'gpuFast',
          initializationMs: this.takeInitializationMs(),
          uploadMs: result.uploadMs,
          mountainComputeMs: result.computeMs,
          waterComputeMs: 0,
          vegetationComputeMs: 0,
          compositionMs: 0,
          readbackMs: result.readbackMs,
          totalMs: typeof performance !== 'undefined'
            ? performance.now() - started
            : Date.now() - started,
          cacheHit: false,
          retainedGpuBytes: result.retainedGpuBytes,
          peakGpuBytes: result.peakGpuBytes ?? result.retainedGpuBytes,
        },
      };
    } catch (error) {
      this.lost = true;
      throw error;
    }
  }

  async compose(
    image: ImageData,
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<MountainGpuComposeResult> {
    if (!this.fieldSession.composeLayersRgba && !this.fieldSession.composeRgba) {
      throw new Error('The active WebGPU session has no compositor');
    }
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const frameKey = `${image.width}x${image.height}:${hashFrame(image.data)}`;
    if (
      frameKey === this.lastFrameKey
      && this.lastFrameData
      && this.lastFrameData.length === image.data.length
      && framesEqual(this.lastFrameData, image.data)
    ) {
      const cacheData = new Uint8ClampedArray(this.lastFrameData);
      return {
        imageData: makeImageData(image.width, image.height, cacheData),
        report: {
          backend: 'webgpu',
          mode: 'gpuFast',
          initializationMs: this.takeInitializationMs(),
          uploadMs: 0,
          mountainComputeMs: 0,
          waterComputeMs: 0,
          vegetationComputeMs: 0,
          compositionMs: 0,
          readbackMs: 0,
          totalMs: typeof performance !== 'undefined' ? performance.now() - started : Date.now() - started,
          cacheHit: true,
          retainedGpuBytes: 0,
          peakGpuBytes: 0,
          maxAbsError: 0,
          meanAbsError: 0,
          changedPixels: 0,
        },
      };
    }
    try {
      const result = this.fieldSession.composeLayersRgba
        ? await this.fieldSession.composeLayersRgba(
            image.width,
            image.height,
            [{ data: image.data }],
            control,
          )
        : await this.fieldSession.composeRgba!(
            image.width,
            image.height,
            image.data,
            control,
          );
      this.lastFrameKey = frameKey;
      this.lastFrameData = new Uint8ClampedArray(result.data);
      return {
        imageData: makeImageData(image.width, image.height, result.data),
        report: {
          backend: 'webgpu',
          mode: 'gpuFast',
          initializationMs: this.takeInitializationMs(),
          uploadMs: result.uploadMs,
          mountainComputeMs: 0,
          waterComputeMs: 0,
          vegetationComputeMs: 0,
          compositionMs: result.computeMs,
          readbackMs: result.readbackMs,
          totalMs: typeof performance !== 'undefined' ? performance.now() - started : Date.now() - started,
          cacheHit: false,
          retainedGpuBytes: result.retainedGpuBytes,
          peakGpuBytes: result.peakGpuBytes ?? result.retainedGpuBytes,
        },
      };
    } catch (error) {
      this.lost = true;
      throw error;
    }
  }

  async composeLayers(
    layers: readonly MountainGpuLayerInput[],
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<MountainGpuComposeResult> {
    if (layers.length === 0) throw new Error('GPU composition requires at least one layer');
    if (!this.fieldSession.composeLayersRgba) {
      throw new Error('The active WebGPU session has no layer compositor');
    }
    const first = layers[0].image;
    for (const layer of layers) {
      if (layer.image.width !== first.width || layer.image.height !== first.height) {
        throw new Error('GPU composition layers must have identical dimensions');
      }
    }
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const frameKey = `${first.width}x${first.height}:${layers
      .map(layer => `${hashFrame(layer.image.data)}:${layer.opacity ?? 1}`)
      .join('|')}`;
    if (
      frameKey === this.lastFrameKey
      && this.lastFrameData
      && this.lastFrameData.length === first.data.length
    ) {
      const cacheData = new Uint8ClampedArray(this.lastFrameData);
      return {
        imageData: makeImageData(first.width, first.height, cacheData),
        report: {
          backend: 'webgpu',
          mode: 'gpuFast',
          initializationMs: this.takeInitializationMs(),
          uploadMs: 0,
          mountainComputeMs: 0,
          waterComputeMs: 0,
          vegetationComputeMs: 0,
          compositionMs: 0,
          readbackMs: 0,
          totalMs: typeof performance !== 'undefined' ? performance.now() - started : Date.now() - started,
          cacheHit: true,
          retainedGpuBytes: 0,
          peakGpuBytes: 0,
          maxAbsError: 0,
          meanAbsError: 0,
          changedPixels: 0,
        },
      };
    }
    try {
      const gpuLayers: MountainGpuRgbaLayer[] = layers.map(layer => ({
        data: layer.image.data,
        opacity: layer.opacity,
      }));
      const result = await this.fieldSession.composeLayersRgba(
        first.width,
        first.height,
        gpuLayers,
        control,
      );
      this.lastFrameKey = frameKey;
      this.lastFrameData = new Uint8ClampedArray(result.data);
      return {
        imageData: makeImageData(first.width, first.height, result.data),
        report: {
          backend: 'webgpu',
          mode: 'gpuFast',
          initializationMs: this.takeInitializationMs(),
          uploadMs: result.uploadMs,
          mountainComputeMs: 0,
          waterComputeMs: 0,
          vegetationComputeMs: 0,
          compositionMs: result.computeMs,
          readbackMs: result.readbackMs,
          totalMs: typeof performance !== 'undefined' ? performance.now() - started : Date.now() - started,
          cacheHit: false,
          retainedGpuBytes: result.retainedGpuBytes,
          peakGpuBytes: result.peakGpuBytes ?? result.retainedGpuBytes,
        },
      };
    } catch (error) {
      this.lost = true;
      throw error;
    }
  }

  async composeFrame(
    image: ImageData,
    fieldSet?: MountainGpuFieldSet,
    control: MountainFieldGpuPrepareControl = {},
  ): Promise<{ frame: MountainGpuFrame; imageData: ImageData; report: MountainGpuRenderReport }> {
    const composed = await this.compose(image, control);
    return {
      frame: MountainGpuFrame.create(composed.imageData, fieldSet?.dependencyKey),
      imageData: composed.imageData,
      report: composed.report,
    };
  }

  dispose(): void {
    this.fieldSession.destroy();
    this.fieldSets.clear();
    this.lastFrameKey = '';
    this.lastFrameData = undefined;
    this.lastMountainRasterBase = undefined;
    this.lastMountainRasterFields = undefined;
    this.lastMountainRasterOptionsKey = '';
    this.lastMountainRasterData = undefined;
    this.lost = true;
  }
}

function hashFrame(data: Uint8ClampedArray): number {
  // FNV-1a is deterministic and cheap enough for the bounded preview tiles.
  // The exact-byte cache check in `compose` still protects against a hash
  // collision before a cached frame is returned.
  let hash = 2166136261;
  for (let index = 0; index < data.length; index++) {
    hash ^= data[index];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function framesEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Create the worker-local GPU session, or return null when WebGPU is unavailable. */
export async function createMountainGpuSession(
  options: MountainGpuSessionOptions = {},
): Promise<MountainGpuSession | null> {
  if (options.mode === 'cpuExact') return null;
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const fieldSession = await createMountainFieldGpuSession(options);
  if (!fieldSession) return null;
  const elapsed = typeof performance !== 'undefined' ? performance.now() - started : Date.now() - started;
  return new MountainGpuSessionImpl(fieldSession, elapsed);
}

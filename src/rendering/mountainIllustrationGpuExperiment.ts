/**
 * WebGPU experiment that computes mountain illustration fields on the GPU, with a CPU fallback.
 */
import type { MountainDEMData } from '../terrain/mountainBaseDEM';
import {
  getMountainIllustrationFaceField,
  buildMountainWindFields,
  prepareMountainIllustrationFieldsCpuFromInputs,
  renderMountainIllustration,
  createMountainIllustrationFieldInputs,
  type MountainIllustration,
  type MountainIllustrationOptions,
  type MountainWindFields,
} from './mountainIllustrationRenderer';
import {
  createMountainFieldCache,
  createMountainFieldCacheSession,
  type MountainFieldCache,
  type MountainPatternOverlay,
} from './mountainPatternRenderer';
import {
  createMountainFieldGpuSession,
  MountainFieldGpuCancelledError,
  type MountainFieldGpuOptions,
  type MountainFieldGpuPrepareControl,
  type MountainFieldGpuReport,
  type MountainFieldGpuSession,
} from './mountainFieldGpu';
import {
  getMountainIllustrationFieldDependencySignature,
  getMountainIllustrationPreparedFieldsByteLength,
  type MountainIllustrationFieldInputs,
  type MountainIllustrationPreparedFields,
  type MountainIllustrationPreparedFieldSet,
} from './mountainIllustrationFields';

export interface MountainIllustrationFieldExperimentOptions {
  backend?: 'auto' | 'cpu' | 'webgpu';
  gpu?: MountainFieldGpuOptions;
  /** Preview keeps this enabled; export can limit fallback to one request. */
  disableGpuOnFailure?: boolean;
  fieldCache?: MountainFieldCache;
  backendSession?: MountainIllustrationFieldBackend;
}

export interface MountainIllustrationFieldExperimentReport {
  backend: 'cpu' | 'webgpu';
  totalMs: number;
  initializationMs: number;
  uploadMs: number;
  computeMs: number;
  readbackMs: number;
  tileCount: number;
  tileSize: number;
  retainedGpuBytes: number;
  peakGpuBytes?: number;
  fallbackReason?: string;
  /** Complete synchronous painter timing after fields are prepared. */
  completeIllustrationMs?: number;
  /** Repaint timing with the same prepared fields and cache. */
  cachedRepaintMs?: number;
  /** Support fields plus the shared face field retained by the CPU cache. */
  retainedCpuBytes?: number;
  gpu?: MountainFieldGpuReport;
  /** Timeline of a backend that runs in its own worker (all in ms). */
  fieldWorker?: {
    /** Worker creation until its module finished loading. */
    loadMs: number;
    /** GPU device and pipeline setup, once the worker had loaded. */
    setupMs: number;
    /** Setup finished this long before the request arrived (negative: the request waited). */
    slackMs: number;
  };
}

export interface MountainIllustrationFieldPreparationResult {
  fields: MountainIllustrationPreparedFields;
  dependencySignature: string;
  retainedBytes: number;
  report: MountainIllustrationFieldExperimentReport;
}

export interface MountainIllustrationFieldBackend {
  readonly gpuDisabled: boolean;
  prepare(
    inputs: MountainIllustrationFieldInputs,
    fieldCache?: MountainFieldCache,
    control?: MountainFieldGpuPrepareControl,
  ): Promise<MountainIllustrationFieldPreparationResult>;
  prepareWindFields(
    dem: MountainDEMData,
    windAzimuthDeg: number,
    control?: MountainFieldGpuPrepareControl,
  ): Promise<{
    fields: MountainWindFields;
    report: MountainIllustrationFieldExperimentReport;
  }>;
  /**
   * Starts the GPU device and pipeline setup without waiting for it. The
   * setup needs no inputs, so it can overlap CPU work before the first
   * preparation; a later preparation joins the setup already in flight. The
   * promise settles when setup ends, and never rejects.
   */
  warmup?(): void | Promise<void>;
  dispose(): void;
}

function clock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isCancelledError(error: unknown): boolean {
  return error instanceof MountainFieldGpuCancelledError
    || (typeof error === 'object' && error !== null && 'cancelled' in error
      && Boolean((error as { cancelled?: unknown }).cancelled));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gpuSources(inputs: MountainIllustrationFieldInputs) {
  return {
    width: inputs.width,
    height: inputs.height,
    lightingElevation: inputs.faceField,
    reliefElevation: inputs.reliefElevation,
    ridgeInk: inputs.ridgeInk,
    ink: inputs.ink,
    coverage: inputs.coverage,
    lineworkCoverage: inputs.lineworkCoverage,
  };
}

export function createMountainIllustrationFieldBackend(
  options: Pick<MountainIllustrationFieldExperimentOptions, 'backend' | 'gpu' | 'disableGpuOnFailure'> = {},
): MountainIllustrationFieldBackend {
  const requestedBackend = options.backend ?? 'auto';
  const disableGpuOnFailure = options.disableGpuOnFailure ?? true;
  let session: MountainFieldGpuSession | null = null;
  let sessionPromise: Promise<MountainFieldGpuSession | null> | null = null;
  let disposed = false;
  let initializationMs = 0;
  let initializationReported = false;
  let gpuFailureReason: string | undefined;
  let disabled = requestedBackend === 'cpu';
  let preparationTail: Promise<void> = Promise.resolve();

  // One in-flight creation is shared by warmup() and the first preparation,
  // so they can never create two devices.
  const startSession = (): Promise<MountainFieldGpuSession | null> => {
    sessionPromise ??= createMountainFieldGpuSession(options.gpu)
      .then(created => {
        if (disposed) {
          try { created?.destroy(); } catch { /* nothing left to release */ }
          return null;
        }
        session = created;
        if (!created) {
          disabled = true;
          gpuFailureReason = 'WebGPU is unavailable';
        }
        return created;
      })
      .finally(() => { sessionPromise = null; });
    return sessionPromise;
  };

  // Reports only the time a preparation actually waited, so a warmed device
  // shows as (nearly) free initialization.
  const ensureSession = async (): Promise<MountainFieldGpuSession | null> => {
    if (requestedBackend === 'cpu' || disabled) return null;
    if (session) return session;
    const waitStarted = clock();
    try {
      return await startSession();
    } finally {
      initializationMs += clock() - waitStarted;
    }
  };

  const consumeInitializationMs = (): number => {
    if (initializationReported) return 0;
    initializationReported = true;
    return initializationMs;
  };

  return {
    get gpuDisabled(): boolean {
      return disabled;
    },

    async prepare(inputs, fieldCache, control = {}): Promise<MountainIllustrationFieldPreparationResult> {
      if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
      const previous = preparationTail;
      let release!: () => void;
      preparationTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
        const started = clock();
        const dependencySignature = getMountainIllustrationFieldDependencySignature(inputs);
        if (requestedBackend !== 'cpu' && !disabled) {
          try {
            const activeSession = await ensureSession();
            if (!activeSession) throw new Error(gpuFailureReason ?? 'WebGPU is unavailable');
            const gpuResult = await activeSession.prepare(
              gpuSources(inputs),
              inputs.radii,
              control,
            );
            if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
            return {
              fields: gpuResult.fields,
              dependencySignature,
              retainedBytes: getMountainIllustrationPreparedFieldsByteLength(gpuResult.fields),
              report: {
                ...gpuResult.report,
                initializationMs: consumeInitializationMs(),
                totalMs: clock() - started,
                backend: 'webgpu',
                gpu: gpuResult.report,
                retainedCpuBytes:
                  getMountainIllustrationPreparedFieldsByteLength(gpuResult.fields)
                  + inputs.faceField.byteLength,
              },
            };
          } catch (error) {
            if (isCancelledError(error)) throw error;
            if (disableGpuOnFailure) disabled = true;
            gpuFailureReason = errorMessage(error);
            try { session?.destroy(); } catch { /* device loss can make destroy a no-op */ }
            session = null;
          }
        }

        if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
        const cpuStarted = clock();
        const fields = prepareMountainIllustrationFieldsCpuFromInputs(
          inputs,
          createMountainFieldCacheSession(fieldCache),
        );
        return {
          fields,
          dependencySignature,
          retainedBytes: getMountainIllustrationPreparedFieldsByteLength(fields),
          report: {
            backend: 'cpu',
            totalMs: clock() - started,
            initializationMs: consumeInitializationMs(),
            uploadMs: 0,
            computeMs: clock() - cpuStarted,
            readbackMs: 0,
            tileCount: 1,
            tileSize: Math.max(inputs.width, inputs.height),
            retainedGpuBytes: 0,
            fallbackReason: gpuFailureReason,
            retainedCpuBytes: getMountainIllustrationPreparedFieldsByteLength(fields)
              + inputs.faceField.byteLength,
          },
        };
      } finally {
        release();
      }
    },

    async prepareWindFields(dem, windAzimuthDeg, control = {}) {
      const previous = preparationTail;
      let release!: () => void;
      preparationTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
        const started = clock();
        if (requestedBackend !== 'cpu' && !disabled) {
          try {
            const activeSession = await ensureSession();
            if (activeSession?.prepareWindFields) {
              const gpuResult = await activeSession.prepareWindFields({
                width: dem.width,
                height: dem.height,
                elevation: dem.elevation,
                dxMeters: dem.dxMeters,
                dyMeters: dem.dyMeters,
                windAzimuthDeg,
              }, control);
              if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
              return {
                fields: {
                  windShelter: gpuResult.fields.windShelter,
                  windLoading: gpuResult.fields.windLoading,
                  slopeBreak: gpuResult.fields.slopeBreak,
                },
                report: {
                  ...gpuResult.report,
                  initializationMs: consumeInitializationMs(),
                  totalMs: clock() - started,
                  backend: 'webgpu',
                  gpu: gpuResult.report,
                  retainedCpuBytes: gpuResult.fields.windShelter.byteLength
                    + gpuResult.fields.windLoading.byteLength
                    + gpuResult.fields.slopeBreak.byteLength,
                },
              };
            }
          } catch (error) {
            if (isCancelledError(error)) throw error;
            if (disableGpuOnFailure) disabled = true;
            gpuFailureReason = errorMessage(error);
            try { session?.destroy(); } catch { /* device loss can make destroy a no-op */ }
            session = null;
          }
        }
        if (control.isCancelled?.()) throw new MountainFieldGpuCancelledError();
        const cpuStarted = clock();
        const fields = buildMountainWindFields(dem, windAzimuthDeg);
        return {
          fields,
          report: {
            backend: 'cpu',
            totalMs: clock() - started,
            initializationMs: consumeInitializationMs(),
            uploadMs: 0,
            computeMs: clock() - cpuStarted,
            readbackMs: 0,
            tileCount: 1,
            tileSize: Math.max(dem.width, dem.height),
            retainedGpuBytes: 0,
            retainedCpuBytes: fields.windShelter.byteLength
              + fields.windLoading.byteLength
              + fields.slopeBreak.byteLength,
            fallbackReason: gpuFailureReason,
          },
        };
      } finally {
        release();
      }
    },

    warmup(): Promise<void> {
      if (requestedBackend === 'cpu' || disabled || session) return Promise.resolve();
      // A failed warmup is retried, and reported, by the first preparation.
      return startSession().then(() => undefined, () => undefined);
    },

    dispose(): void {
      disposed = true;
      try { session?.destroy(); } catch { /* device loss is already terminal */ }
      session = null;
    },
  };
}

/**
 * Prepare the exact fields consumed by renderMountainIllustration. This
 * one-shot wrapper remains useful for browser benchmarks and tests; production
 * workers use createMountainIllustrationFieldBackend so the device persists.
 */
export async function prepareMountainIllustrationFieldsExperiment(
  dem: MountainDEMData,
  pattern: MountainPatternOverlay,
  options: Pick<MountainIllustrationOptions, 'scale' | 'offsetX' | 'offsetY'>,
  experiment: MountainIllustrationFieldExperimentOptions = {},
): Promise<MountainIllustrationFieldPreparationResult> {
  const scale = Math.max(0.25, options.scale);
  const naturalElevation = pattern.surfaceElevation ?? dem.elevation;
  const faceField = getMountainIllustrationFaceField(
    dem,
    naturalElevation,
    scale,
    options.offsetX,
    options.offsetY,
    experiment.fieldCache,
  );
  const inputs = createMountainIllustrationFieldInputs(
    dem,
    pattern,
    faceField,
    scale,
    options.offsetX,
    options.offsetY,
  );
  const backend = experiment.backendSession ?? createMountainIllustrationFieldBackend(experiment);
  try {
    return await backend.prepare(inputs, experiment.fieldCache);
  } finally {
    if (!experiment.backendSession) backend.dispose();
  }
}

/**
 * Benchmark-only adapter proving that prepared GPU fields can flow through the
 * unchanged illustration painter.
 */
export async function renderMountainIllustrationWithFieldExperiment(
  dem: MountainDEMData,
  pattern: MountainPatternOverlay,
  shadow: Float32Array,
  options: MountainIllustrationOptions,
  experiment: MountainIllustrationFieldExperimentOptions = {},
): Promise<{
  fields: MountainIllustrationPreparedFields;
  report: MountainIllustrationFieldExperimentReport;
  illustration: MountainIllustration;
}> {
  const fieldCache = experiment.fieldCache ?? createMountainFieldCache();
  const prepared = await prepareMountainIllustrationFieldsExperiment(
    dem,
    pattern,
    options,
    { ...experiment, fieldCache },
  );
  const illustrationStarted = clock();
  const illustration = renderMountainIllustration(
    dem,
    pattern,
    shadow,
    { ...options, preparedFields: prepared.fields },
    undefined,
    fieldCache,
  );
  prepared.report.completeIllustrationMs = clock() - illustrationStarted;
  prepared.report.retainedCpuBytes = prepared.retainedBytes
    + (pattern.surfaceElevation ?? dem.elevation).byteLength;
  const repaintStarted = clock();
  renderMountainIllustration(
    dem,
    pattern,
    shadow,
    { ...options, preparedFields: prepared.fields },
    undefined,
    fieldCache,
  );
  prepared.report.cachedRepaintMs = clock() - repaintStarted;
  return { ...prepared, illustration };
}

export function asPreparedFieldSet(
  result: MountainIllustrationFieldPreparationResult,
): MountainIllustrationPreparedFieldSet {
  return {
    fields: result.fields,
    dependencySignature: result.dependencySignature,
    retainedBytes: result.retainedBytes,
  };
}

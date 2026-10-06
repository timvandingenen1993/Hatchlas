import {
  getMountainBiomeLabel,
  getMountainClimateZoneLabel,
  MOUNTAIN_WATER_EVOLUTION_STEPS,
  getHeightmapFitResolution,
  processMountainBaseDEM,
  rebuildMountainEvolutionStep,
  recomputeMountainLighting,
  resampleHeightmapLuminance,
  DEFAULT_RIVER_THRESHOLD_KM2,
  prepareAnalysisHeightmap,
  sampleMountainElevationProfile,
  type BaseDEMOptions,
  type MountainDEMData,
  type MountainEvolutionState,
} from "../terrain/mountainBaseDEM";
import {
  createMountainRenderStageCache,
  buildMountainWaterStageInputs,
  buildMountainIllustrationStageInputs,
  needsMountainIllustrationStage,
  renderMountainIllustrationStageFromInputs,
  renderMountainDetailDEMWithCache,
  scaleWaterPresentationOptions,
  validateMountainRenderStageCache,
  WATER_REFERENCE_LONG_EDGE,
  type MountainRenderOptions,
  type MountainRenderStageCache,
} from "./mountainDetailRenderer";
import {
  vegetationGeometryStageKey,
  vegetationOverlayStageKey,
} from "./mountainDetailRenderer";
import {
  asPreparedFieldSet,
  createMountainIllustrationFieldBackend,
  type MountainIllustrationFieldBackend,
} from "./mountainIllustrationGpuExperiment";
import {
  MOUNTAIN_ILLUSTRATION_PALETTE,
  type MountainWindFields,
} from "./mountainIllustrationRenderer";
import { MountainFieldGpuCancelledError } from "./mountainFieldGpu";
import {
  compareMountainGpuImages,
  createMountainGpuSession,
  type MountainGpuRenderReport,
  type MountainGpuRenderMode,
  type MountainGpuSession,
} from "./mountainGpuRenderer";
import {
  getMountainIllustrationFieldDependencySignature,
  getMountainIllustrationPreparedFieldsByteLength,
} from "./mountainIllustrationFields";
import {
  createMountainFieldCache,
  getMountainFieldFingerprint,
} from "./mountainPatternRenderer";
import { buildVisualWaterSurfaceDEM } from "./waterRenderer";
import type {
  VegetationMotifAsset,
  VegetationRasterPropAsset,
} from "./vegetationRenderer";
import { mergeVegetationGeometry, mergeVegetationOverlay } from "./vegetationRenderer";
import { createWorkerMountainFieldBackend } from "./mountainFieldBackendProxy";
import { LatestRequestCoordinator } from "./mountainPreviewCoordinator";
import {
  createMountainProfiler,
  diffMountainProfileSettings,
  type MountainProfiler,
} from "./mountainProfiler";
import { createRenderExecution } from "./renderExecution";
import {
  MountainLayerWorkerCancelledError,
  MountainLayerWorkerPool,
  type MountainLayerPreparationResult,
} from "./mountainLayerWorkerPool";
import type {
  MountainPreviewBackendStatus,
  MountainPreviewRequest,
  MountainPreviewResponse,
  MountainPreviewSource,
} from "./mountainPreviewTypes";

// Keep the public final frame at the requested 2048px long edge while doing
// the expensive procedural illustration at a smaller physical raster. The
// bicubic-like bilinear upscale is stable for ink and wash layers and cuts
// the cell-based work by roughly 44% at the live viewport size.
const FINAL_PREVIEW_INTERNAL_LONG_EDGE = 1536;

let source: MountainPreviewSource | null = null;
let sourceRevision = -1;
let analysisRevision = -1;
let preparedSourceKey = "";
let preparedSource: {
  width: number;
  height: number;
  luminance: Float32Array;
  oceanMask?: Uint8Array;
} | null = null;
let coreAnalysisKey = "";
// Water evolution states for every step, computed once when evolution is
// enabled so scrubbing only rebuilds the selected step.
let evolutionKey = "";
let evolutionStates: MountainEvolutionState[] = [];
let lightingKey = "";
let dem: MountainDEMData | null = null;
let visualWaterKey = "";
let visualWaterDem: MountainDEMData | null = null;
let draftDemSource: MountainDEMData | null = null;
let draftDem: MountainDEMData | null = null;
let finalPreviewDemSource: MountainDEMData | null = null;
let finalPreviewDem: MountainDEMData | null = null;
// Keep quality-specific stage caches. Draft renders use a deliberately
// reduced DEM and must not evict reusable final-resolution fields while the
// user is waiting for refinement.
let renderCache = createMountainRenderStageCache();
let draftRenderCache = createMountainRenderStageCache();
let mountainFieldBackend: MountainIllustrationFieldBackend | null = null;
let mountainFieldBackendMode: "auto" | "cpu" | undefined;
let mountainGpuSession: MountainGpuSession | null = null;
let mountainGpuSessionMode: MountainGpuRenderMode | undefined;
let mountainGpuSessionGeneration = 0;
let mountainGpuFallbackReason: string | undefined;
let layerWorkerPool: MountainLayerWorkerPool | null = null;
// Water, vegetation flow and vegetation props are independent jobs, each with
// its own DEM snapshot (a few hundred MiB at preview size), so three of them
// need more than the default memory budget.
const PREVIEW_LAYER_POOL_OPTIONS = { maxWorkers: 3, maxCpuBytes: 1024 * 1024 * 1024 };
let retainedPreparedCache: MountainRenderStageCache | null = null;
const CPU_PREPARED_FIELD_CACHE_BUDGET = 128 * 1024 * 1024;
// Wind fields depend only on the render DEM's elevation grid and the wind
// direction, but are requested whenever the mountain illustration misses its
// cache (a colour or snow edit, for example). Keep the last result.
let previewWindFields: {
  elevation: Float32Array;
  elevationFingerprint: number;
  dxMeters: number;
  dyMeters: number;
  windAzimuthDeg: number;
  gpuMode: MountainGpuRenderMode;
  fields: MountainWindFields;
} | null = null;
let vegetationMotifs: VegetationMotifAsset[] | null = null;
let rasterProps: VegetationRasterPropAsset[] | null = null;
let previousProfileAnalysisSettings: Record<string, unknown> | undefined;
let previousProfileRenderSettings: Record<string, unknown> | undefined;

const FIELD_BACKEND_GPU_OPTIONS = { tileSize: 1024, maxGpuBytes: 128 * 1024 * 1024 };
let warmedFieldBackend: MountainIllustrationFieldBackend | null = null;

/**
 * The GPU field backend lives in its own worker (when available): its device
 * and pipeline setup needs a free event loop, which this worker rarely has
 * during the long synchronous water and pattern stages.
 */
function createGpuFieldBackend(): MountainIllustrationFieldBackend {
  return createWorkerMountainFieldBackend({ gpu: FIELD_BACKEND_GPU_OPTIONS })
    ?? createMountainIllustrationFieldBackend({ backend: "auto", gpu: FIELD_BACKEND_GPU_OPTIONS });
}

/** Starts WebGPU setup while analysis runs, so the first render need not wait for it. */
function warmFieldBackend(): void {
  if (warmedFieldBackend || mountainFieldBackend) return;
  warmedFieldBackend = createGpuFieldBackend();
  warmedFieldBackend.warmup?.();
}

/** The warmed backend serves the GPU case; CPU-only callers never use it. */
function acquireFieldBackend(backend: "auto" | "cpu"): MountainIllustrationFieldBackend {
  if (backend === "cpu") {
    return createMountainIllustrationFieldBackend({ backend, gpu: FIELD_BACKEND_GPU_OPTIONS });
  }
  const warmed = warmedFieldBackend ?? createGpuFieldBackend();
  warmedFieldBackend = null;
  return warmed;
}

function warmLayerWorker(): void {
  if (!layerWorkerPool) layerWorkerPool = new MountainLayerWorkerPool(PREVIEW_LAYER_POOL_OPTIONS);
  if (!layerWorkerPool.available) return;
  void layerWorkerPool.warmup().catch(() => undefined);
}

let mountainGpuSessionPromise: Promise<MountainGpuSession | null> | undefined;

function requestedMountainGpuMode(options: MountainRenderOptions): MountainGpuRenderMode {
  return options.gpuRenderMode ?? "auto";
}

function usesMountainGpu(mode: MountainGpuRenderMode): boolean {
  return mode === "gpuFast" || mode === "gpuApprox";
}

function usesApproximateMountainRaster(mode: MountainGpuRenderMode): boolean {
  return mode === "gpuApprox";
}

function ensureMountainGpuSession(
  mode: MountainGpuRenderMode,
): Promise<MountainGpuSession | null> {
  if (mode === "cpuExact") {
    mountainGpuSessionGeneration += 1;
    mountainGpuSession?.dispose();
    mountainGpuSession = null;
    mountainGpuSessionMode = undefined;
    mountainGpuSessionPromise = undefined;
    return Promise.resolve(null);
  }
  if (mountainGpuSession && mountainGpuSessionMode === mode && mountainGpuSession.available) {
    return Promise.resolve(mountainGpuSession);
  }
  if (mountainGpuSessionMode !== undefined && mountainGpuSessionMode !== mode) {
    mountainGpuSessionGeneration += 1;
    mountainGpuSession?.dispose();
    mountainGpuSession = null;
    mountainGpuSessionPromise = undefined;
  }
  if (!mountainGpuSessionPromise) {
    const generation = ++mountainGpuSessionGeneration;
    mountainGpuSessionMode = mode;
    mountainGpuSessionPromise = createMountainGpuSession({
      mode,
      tileSize: 1024,
      maxGpuBytes: 128 * 1024 * 1024,
    }).then(session => {
      if (generation !== mountainGpuSessionGeneration || mountainGpuSessionMode !== mode) {
        session?.dispose();
        return null;
      }
      mountainGpuSession = session;
      if (session) mountainGpuFallbackReason = undefined;
      else mountainGpuFallbackReason = "WebGPU is unavailable";
      if (session) return session.warmup().then(() => session);
      return null;
    }).catch(error => {
      if (generation !== mountainGpuSessionGeneration || mountainGpuSessionMode !== mode) {
        return null;
      }
      mountainGpuSession = null;
      mountainGpuFallbackReason = error instanceof Error ? error.message : String(error);
      return null;
    }).finally(() => {
      if (generation === mountainGpuSessionGeneration) {
        mountainGpuSessionPromise = undefined;
      }
    });
  }
  return mountainGpuSessionPromise;
}

function recordGpuComposeReport(
  profiler: MountainProfiler | undefined,
  report: Awaited<ReturnType<MountainGpuSession["compose"]>>["report"],
  expected: ImageData,
  actual: ImageData,
): void {
  if (!profiler) return;
  const diff = compareMountainGpuImages(expected.data, actual.data);
  profiler.setMetadata({ mountainGpuBackend: report.backend });
  if (report.initializationMs > 0) {
    profiler.recordMetric("gpu bootstrap", report.initializationMs, "ms");
  }
  profiler.recordMetric("gpu input upload", report.uploadMs, "ms");
  profiler.recordMetric("gpu mountain compute", report.mountainComputeMs, "ms");
  profiler.recordMetric("gpu water compute", report.waterComputeMs, "ms");
  profiler.recordMetric("gpu vegetation compute", report.vegetationComputeMs, "ms");
  profiler.recordMetric("gpu composition", report.compositionMs, "ms");
  profiler.recordMetric("gpu final readback", report.readbackMs, "ms");
  profiler.recordMetric("gpu total", report.totalMs, "ms");
  profiler.recordCache("gpu compositor", report.cacheHit);
  profiler.recordMetric("gpu retained", report.retainedGpuBytes, "bytes");
  profiler.recordMetric("gpu peak", report.peakGpuBytes, "bytes");
  profiler.recordMetric("gpu max abs error", diff.maxAbsError ?? 0, "code");
  profiler.recordMetric("gpu mean abs error", diff.meanAbsError ?? 0, "code");
  profiler.recordMetric("gpu changed pixels", diff.changedPixels ?? 0, "pixels");
}

function recordGpuMountainRasterReport(
  profiler: MountainProfiler | undefined,
  report: MountainGpuRenderReport,
): void {
  if (!profiler) return;
  profiler.setMetadata({ mountainGpuBackend: report.backend });
  if (report.initializationMs > 0) {
    profiler.recordMetric("gpu bootstrap", report.initializationMs, "ms");
  }
  profiler.recordMetric("gpu input upload", report.uploadMs, "ms");
  profiler.recordMetric("gpu mountain compute", report.mountainComputeMs, "ms");
  profiler.recordMetric("gpu composition", report.compositionMs, "ms");
  profiler.recordMetric("gpu final readback", report.readbackMs, "ms");
  profiler.recordMetric("gpu total", report.totalMs, "ms");
  profiler.recordCache("gpu compositor", report.cacheHit);
  profiler.recordMetric("gpu retained", report.retainedGpuBytes, "bytes");
  profiler.recordMetric("gpu peak", report.peakGpuBytes, "bytes");
}

function recordGpuMountainRasterEvent(
  profiler: MountainProfiler | undefined,
  event: "candidate" | "session" | "inputs" | "attempted" | "success" | "fallback",
): void {
  profiler?.recordMetric(`gpu mountain raster ${event}`, 1, "count");
}

// Coarse render stages reported to the status bar: terrain, mountain fields,
// wind, mountain illustration, water/vegetation, compositing, finishing.
const RENDER_STEP_COUNT = 7;

function post(
  response: MountainPreviewResponse,
  transfer: Transferable[] = [],
): void {
  (
    self as unknown as {
      postMessage(message: MountainPreviewResponse, transfer: Transferable[]): void;
    }
  ).postMessage(response, transfer);
}

function postBackendStatus(
  requestId: number,
  backend: Exclude<MountainPreviewBackendStatus, "checking">,
  reason?: string,
): void {
  post({
    type: "backendStatus",
    requestId,
    backend,
    ...(reason ? { reason } : {}),
  });
}

function cachedPreviewWindFields(
  renderDem: MountainDEMData,
  windAzimuthDeg: number,
  gpuMode: MountainGpuRenderMode,
): MountainWindFields | undefined {
  const cached = previewWindFields;
  if (
    !cached
    || cached.elevation !== renderDem.elevation
    || cached.dxMeters !== renderDem.dxMeters
    || cached.dyMeters !== renderDem.dyMeters
    || cached.windAzimuthDeg !== windAzimuthDeg
    || cached.gpuMode !== gpuMode
  ) return undefined;
  // Identity alone would miss an in-place edit; the fingerprint is ~2 ms.
  return getMountainFieldFingerprint(renderDem.elevation) === cached.elevationFingerprint
    ? cached.fields
    : undefined;
}

function fail(requestId: number, error: unknown): void {
  post({
    type: "error",
    requestId,
    message: error instanceof Error ? error.message : "Preview worker failed",
  });
}

function isRenderCancelled(error: unknown): boolean {
  return error instanceof MountainFieldGpuCancelledError
    || (typeof error === "object" && error !== null && "cancelled" in error
      && Boolean((error as { cancelled?: unknown }).cancelled));
}

function isLayerWorkerCancelled(error: unknown): boolean {
  return error instanceof MountainLayerWorkerCancelledError
    || (typeof error === "object" && error !== null && "cancelled" in error
      && Boolean((error as { cancelled?: unknown }).cancelled));
}

function retainPreparedFieldSet(
  cache: MountainRenderStageCache,
  prepared: ReturnType<typeof asPreparedFieldSet>,
  faceFieldBytes: number,
): boolean {
  const retainedBytes = prepared.retainedBytes + faceFieldBytes;
  if (retainedPreparedCache && retainedPreparedCache !== cache) {
    retainedPreparedCache.mountainIllustrationPreparedFieldSet = undefined;
    retainedPreparedCache.mountainFieldCache = createMountainFieldCache();
    retainedPreparedCache = null;
  }
  if (
    retainedBytes > CPU_PREPARED_FIELD_CACHE_BUDGET
    || prepared.fields.width > 2048
    || prepared.fields.height > 2048
  ) {
    cache.mountainIllustrationPreparedFieldSet = undefined;
    if (retainedPreparedCache === cache) {
      retainedPreparedCache = null;
      cache.mountainFieldCache = createMountainFieldCache();
    }
    return false;
  }
  cache.mountainIllustrationPreparedFieldSet = prepared;
  retainedPreparedCache = cache;
  return true;
}

function releaseOversizedPreparedFields(cache: MountainRenderStageCache): void {
  cache.mountainIllustrationPreparedFieldSet = undefined;
  if (retainedPreparedCache === cache) retainedPreparedCache = null;
  cache.mountainFieldCache = createMountainFieldCache();
}

function recordMountainFieldReport(
  profiler: ReturnType<typeof createMountainProfiler>,
  report: Awaited<ReturnType<MountainIllustrationFieldBackend["prepare"]>>["report"],
  cacheReuse: boolean,
): void {
  if (!profiler) return;
  profiler.recordCache("mountain illustration fields", cacheReuse);
  profiler.setMetadata({ mountainFieldBackend: report.backend });
  profiler.recordMetric("mountain fields backend", report.backend === "webgpu" ? 1 : 0, "webgpu");
  if (report.initializationMs > 0) {
    profiler.recordMetric("mountain fields initialization", report.initializationMs, "ms");
  }
  profiler.recordMetric("mountain fields upload", report.uploadMs, "ms");
  profiler.recordMetric("mountain fields compute", report.computeMs, "ms");
  profiler.recordMetric("mountain fields readback", report.readbackMs, "ms");
  profiler.recordMetric("mountain fields preparation", report.totalMs, "ms");
  profiler.recordMetric("mountain fields tiles", report.tileCount, "tiles");
  profiler.recordMetric("mountain fields retained GPU", report.retainedGpuBytes, "bytes");
  if (report.peakGpuBytes !== undefined) {
    profiler.recordMetric("mountain fields peak GPU", report.peakGpuBytes, "bytes");
  }
  if (report.fieldWorker) {
    profiler.recordMetric("mountain fields worker load", report.fieldWorker.loadMs, "ms");
    profiler.recordMetric("mountain fields worker setup", report.fieldWorker.setupMs, "ms");
    profiler.recordMetric("mountain fields worker slack", report.fieldWorker.slackMs, "ms");
  }
  if (report.fallbackReason) profiler.setMetadata({ mountainFieldFallback: report.fallbackReason });
}

function recordMountainGpuFieldReport(
  profiler: MountainProfiler | undefined,
  report: MountainGpuRenderReport,
  cacheHit: boolean,
): void {
  if (!profiler) return;
  profiler.recordCache("mountain illustration fields", cacheHit);
  profiler.setMetadata({ mountainFieldBackend: report.backend });
  profiler.recordMetric("mountain fields backend", 1, "webgpu");
  if (report.initializationMs > 0) {
    profiler.recordMetric("mountain fields initialization", report.initializationMs, "ms");
  }
  profiler.recordMetric("mountain fields upload", report.uploadMs, "ms");
  profiler.recordMetric("mountain fields compute", report.mountainComputeMs, "ms");
  profiler.recordMetric("mountain fields readback", report.readbackMs, "ms");
  profiler.recordMetric("mountain fields preparation", report.totalMs, "ms");
  profiler.recordMetric("mountain fields tiles", report.tileCount ?? 0, "tiles");
  profiler.recordMetric("mountain fields retained GPU", report.retainedGpuBytes, "bytes");
  profiler.recordMetric("mountain fields peak GPU", report.peakGpuBytes, "bytes");
}

function shouldPrepareParallelLayers(
  dem: MountainDEMData,
  options: MountainRenderOptions,
  cache: MountainRenderStageCache,
): "all" | "water" | "vegetationGeometry" | undefined {
  const water = buildMountainWaterStageInputs(dem, options);
  const waterCached = !water.shouldBuildWater
    || (
      cache.dem === dem
      && cache.waterGeometryKey === water.geometryKey
      && cache.waterGeometry !== undefined
      && cache.waterPaintKey === water.paintKey
      && cache.waterOverlay !== undefined
    );
  if (options.layer !== "vegetation_patterns" || !options.vegetation) {
    return waterCached ? undefined : "water";
  }
  const geometryKey = vegetationGeometryStageKey(options);
  const overlayKey = vegetationOverlayStageKey(options, geometryKey);
  const vegetationCached =
    cache.dem === dem
    && cache.vegetationGeometryKey === geometryKey
    && cache.vegetationGeometry !== undefined
    && cache.vegetationOverlayKey === overlayKey
    && cache.vegetationOverlay !== undefined;
  if (!waterCached && !vegetationCached) return "all";
  if (!waterCached) return "water";
  return vegetationCached ? undefined : "vegetationGeometry";
}

function cachedWaterCoverageOverride(
  dem: MountainDEMData,
  cache: MountainRenderStageCache,
): Float32Array | undefined {
  const waterOverlay = cache.waterOverlay;
  if (!waterOverlay) return undefined;
  if (
    cache.vegetationWaterCoverageOverlay === waterOverlay
    && cache.vegetationWaterCoverage
  ) {
    return cache.vegetationWaterCoverage;
  }
  const totalCells = dem.width * dem.height;
  const coverage = new Float32Array(totalCells);
  for (let index = 0; index < totalCells; index++) {
    coverage[index] = Math.max(
      dem.visualWaterCoverage?.[index] ?? dem.visualWaterMask?.[index] ?? 0,
      waterOverlay.waterAlpha[index] / 255,
    );
  }
  cache.vegetationWaterCoverage = coverage;
  cache.vegetationWaterCoverageOverlay = waterOverlay;
  return coverage;
}

interface ParallelLayerPreparation {
  mode: "all" | "water" | "vegetationGeometry";
  promise: Promise<MountainLayerPreparationResult | null>;
  pool: MountainLayerWorkerPool;
}

function startParallelLayerPreparation(
  dem: MountainDEMData,
  options: MountainRenderOptions,
  cache: MountainRenderStageCache,
  control: {
    isCancelled: () => boolean;
    checkpoint: () => Promise<void>;
    profile?: boolean;
  },
): ParallelLayerPreparation | undefined {
  if (!needsMountainIllustrationStage(options)) return undefined;
  const mode = shouldPrepareParallelLayers(dem, options, cache);
  if (!mode) return undefined;
  if (!layerWorkerPool) {
    layerWorkerPool = new MountainLayerWorkerPool(PREVIEW_LAYER_POOL_OPTIONS);
  }
  if (!layerWorkerPool.available) return undefined;
  if (mode === "all" && layerWorkerPool.workerCount >= 2) {
    return {
      mode,
      pool: layerWorkerPool,
      promise: prepareWaterAndVegetationSideBySide(layerWorkerPool, dem, options, control),
    };
  }
  return {
    mode,
    pool: layerWorkerPool,
    promise: layerWorkerPool.prepare(
      dem,
      options,
      {
        ...control,
        waterCoverageOverride: mode === "vegetationGeometry"
          ? cachedWaterCoverageOverride(dem, cache)
          : undefined,
        vegetationGeometryOverride:
          mode === "vegetationGeometry" &&
          cache.dem === dem &&
          cache.vegetationGeometryKey === vegetationGeometryStageKey(options)
            ? cache.vegetationGeometry ?? undefined
            : undefined,
      },
      mode,
    ),
  };
}

/** Joins the flow and props halves of a vegetation job into one "vegetation" result. */
function mergeVegetationJobs(
  flow: MountainLayerPreparationResult,
  props: MountainLayerPreparationResult,
): MountainLayerPreparationResult {
  // Both halves repeat water geometry; the caller reports it from the water job.
  const notWater = (name: string): boolean => !name.startsWith("water");
  const latest = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined || b === undefined ? a ?? b : Math.max(a, b);
  return {
    mode: "vegetation",
    waterGeometry: null,
    waterOverlay: null,
    vegetationGeometry: flow.vegetationGeometry && props.vegetationGeometry
      ? mergeVegetationGeometry(flow.vegetationGeometry, props.vegetationGeometry)
      : null,
    vegetationOverlay: flow.vegetationOverlay && props.vegetationOverlay
      ? mergeVegetationOverlay(flow.vegetationOverlay, props.vegetationOverlay)
      : null,
    timings: {
      ...flow.timings,
      totalMs: Math.max(flow.timings.totalMs, props.timings.totalMs),
      wallMs: latest(flow.timings.wallMs, props.timings.wallMs),
      workerComputationMs: latest(flow.timings.workerComputationMs, props.timings.workerComputationMs),
      queueMs: latest(flow.timings.queueMs, props.timings.queueMs),
      waterGeometryMs: Math.max(flow.timings.waterGeometryMs, props.timings.waterGeometryMs),
      waterOverlayMs: Math.max(flow.timings.waterOverlayMs, props.timings.waterOverlayMs),
      vegetationGeometryMs: Math.max(flow.timings.vegetationGeometryMs, props.timings.vegetationGeometryMs),
      vegetationOverlayMs: Math.max(flow.timings.vegetationOverlayMs, props.timings.vegetationOverlayMs),
    },
    profile: flow.profile && props.profile
      ? {
          ...flow.profile,
          stages: [...flow.profile.stages, ...props.profile.stages.filter(stage => notWater(stage.stage))],
          metrics: [...flow.profile.metrics, ...props.profile.metrics.filter(metric => notWater(metric.metric))],
        }
      : flow.profile ?? props.profile,
  };
}

/**
 * Vegetation needs only the painted water coverage, which water geometry
 * already fixes. Paint water (mostly ocean waves) on one worker while the
 * others build vegetation, then merge the results into one "all" result. With
 * a third worker, vegetation splits into its independent flow and prop halves.
 */
function prepareWaterAndVegetationSideBySide(
  pool: MountainLayerWorkerPool,
  dem: MountainDEMData,
  options: MountainRenderOptions,
  control: { isCancelled: () => boolean; checkpoint: () => Promise<void>; profile?: boolean },
): Promise<MountainLayerPreparationResult | null> {
  const waterJob = pool.prepare(dem, options, control, "water");
  const vegetationJob = pool.workerCount >= 3
    ? Promise.all([
        pool.prepare(dem, options, control, "vegetationFlow"),
        pool.prepare(dem, options, control, "vegetationProps"),
      ]).then(([flow, props]) => (flow && props ? mergeVegetationJobs(flow, props) : null))
    : pool.prepare(dem, options, control, "vegetation");
  return Promise.all([waterJob, vegetationJob]).then(([water, vegetation]) => {
    // A skipped job (memory budget) leaves its stage to the compositor.
    if (!water || !vegetation) {
      return water ?? (vegetation ? { ...vegetation, mode: "vegetationGeometry" as const } : null);
    }
    // The vegetation job repeats water geometry; report it once.
    const notWater = (name: string): boolean => !name.startsWith("water");
    const profile = water.profile && vegetation.profile
      ? {
          ...vegetation.profile,
          stages: [...water.profile.stages, ...vegetation.profile.stages.filter(stage => notWater(stage.stage))],
          metrics: [...water.profile.metrics, ...vegetation.profile.metrics.filter(metric => notWater(metric.metric))],
        }
      : water.profile ?? vegetation.profile;
    return {
      mode: "all" as const,
      waterGeometry: water.waterGeometry,
      waterOverlay: water.waterOverlay,
      vegetationGeometry: vegetation.vegetationGeometry,
      vegetationOverlay: vegetation.vegetationOverlay,
      timings: {
        ...vegetation.timings,
        totalMs: Math.max(water.timings.totalMs, vegetation.timings.totalMs),
        wallMs: Math.max(
          water.timings.wallMs ?? water.timings.totalMs,
          vegetation.timings.wallMs ?? vegetation.timings.totalMs,
        ),
        waterGeometryMs: water.timings.waterGeometryMs,
        waterOverlayMs: water.timings.waterOverlayMs,
      },
      profile,
    };
  });
}

function recordParallelLayerProfile(
  profiler: MountainProfiler | undefined,
  report: MountainLayerPreparationResult["profile"],
): void {
  if (!profiler || !report) return;
  for (const stage of report.stages) {
    profiler.recordExternalStage(`parallel ${stage.stage}`, stage.durationMs, stage.calls);
  }
  for (const metric of report.metrics) {
    profiler.recordMetric(`parallel ${metric.metric}`, metric.average, metric.unit);
  }
}

function splitAnalysisOptions(options: BaseDEMOptions): {
  core: BaseDEMOptions;
  lighting: BaseDEMOptions;
} {
  const {
    sunAzimuthDeg,
    sunAltitudeDeg,
    verticalExaggeration,
    ...core
  } = options;
  return {
    core,
    lighting: { sunAzimuthDeg, sunAltitudeDeg, verticalExaggeration },
  };
}

function profileRenderSettings(options: MountainRenderOptions): Record<string, unknown> {
  const vegetation = options.vegetation;
  return {
    layer: options.layer,
    palette: options.palette,
    gpuRenderMode: options.gpuRenderMode ?? "auto",
    sunAzimuthDeg: options.sunAzimuthDeg,
    sunAltitudeDeg: options.sunAltitudeDeg,
    mountainLightingMode: options.mountainLightingMode,
    mountainViewAngleDeg: options.mountainViewAngleDeg,
    mountainHeightExaggeration: options.mountainHeightExaggeration,
    mountainLineworkScale: options.mountainLineworkScale,
    mountainLineworkOpacity: options.mountainLineworkOpacity,
    mountainHatchOpacity: options.mountainHatchOpacity,
    mountainHatchHorizontalOpacity: options.mountainHatchHorizontalOpacity,
    mountainHatchVerticalOpacity: options.mountainHatchVerticalOpacity,
    mountainHatchDensity: options.mountainHatchDensity,
    mountainLocalDetailDensityMax: options.mountainLocalDetailDensityMax,
    mountainFoothillDetailMultiplier: options.mountainFoothillDetailMultiplier,
    mountainBiomeDetailMultiplier: options.mountainBiomeDetailMultiplier,
    mountainHatchThickness: options.mountainHatchThickness,
    mountainRidgeDensity: options.mountainRidgeDensity,
    mountainRidgeThickness: options.mountainRidgeThickness,
    mountainHatchColor: options.mountainHatchColor,
    mountainRidgeColor: options.mountainRidgeColor,
    fullTerrainCameraType: options.fullTerrainCameraType,
    fullTerrainCameraElevationDeg: options.fullTerrainCameraElevationDeg,
    fullTerrainCameraHeightExaggeration: options.fullTerrainCameraHeightExaggeration,
    fullTerrainCameraRenderStyle: options.fullTerrainCameraRenderStyle,
    snowfallAmount: options.snowfallAmount,
    snowfallDrift: options.snowfallDrift,
    snowfallPersistence: options.snowfallPersistence,
    snowRedistributionSteps: options.snowRedistributionSteps,
    windAzimuthDeg: options.windAzimuthDeg,
    ambientOcclusionStrength: options.ambientOcclusionStrength,
    showRivers: options.showRivers,
    showWaterDetails: options.showWaterDetails,
    showOceanDetails: options.showOceanDetails,
    showContours: options.showContours,
    contourSmoothingPasses: options.contourSmoothingPasses,
    waterFillSmoothing: options.waterFillSmoothing,
    waterOutlineThickness: options.waterOutlineThickness,
    waterOutlineLength: options.waterOutlineLength,
    deepOceanWaveLength: options.deepOceanWaveLength,
    deepOceanStrokeThickness: options.deepOceanStrokeThickness,
    deepOceanWaveShadingScale: options.deepOceanWaveShadingScale,
    deepOceanWaveShadingIntensity: options.deepOceanWaveShadingIntensity,
    waterFlowDensity: options.waterFlowDensity,
    waterFlowLength: options.waterFlowLength,
    wetlandPuddleContours: options.wetlandPuddleContours,
    wetlandPuddleDensity: options.wetlandPuddleDensity,
    wetlandPuddleSizeMin: options.wetlandPuddleSizeMin,
    wetlandPuddleSizeMax: options.wetlandPuddleSizeMax,
    wetlandPuddleCoastDistance: options.wetlandPuddleCoastDistance,
    vegetation: vegetation
      ? {
          preset: vegetation.preset,
          seed: vegetation.seed,
          density: vegetation.density,
          patternScale: vegetation.patternScale,
          strokeLength: vegetation.strokeLength,
          strokeThickness: vegetation.strokeThickness,
          strokeOpacity: vegetation.strokeOpacity,
          mountainSideRidgeDensity: vegetation.mountainSideRidgeDensity,
          mountainMainRidgeThickness: vegetation.mountainMainRidgeThickness,
        }
      : undefined,
  };
}

function resolvePreviewQuality(
  options: MountainRenderOptions,
  quality: "draft" | "final" | undefined,
): MountainRenderOptions {
  if (quality !== "draft") return options;
  const vegetation = options.vegetation;
  return {
    ...options,
    // A draft is deliberately a complete map at lower mark density. The
    // terrain, water masks and global coordinates remain identical, so the
    // final refinement does not jump to a different coastline or mountain
    // placement.
    mountainLocalDetailDensityMax: Math.max(
      0,
      (options.mountainLocalDetailDensityMax ?? 1) * 0.45,
    ),
    mountainFoothillDetailMultiplier: Math.max(
      0,
      (options.mountainFoothillDetailMultiplier ?? 1) * 0.55,
    ),
    mountainBiomeDetailMultiplier: Math.max(
      0,
      (options.mountainBiomeDetailMultiplier ?? 1) * 0.55,
    ),
    mountainHatchDensity: Math.max(0, (options.mountainHatchDensity ?? 1) * 0.65),
    snowRedistributionSteps: Math.min(12, options.snowRedistributionSteps ?? 12),
    showWaterDetails: false,
    showOceanDetails: false,
    vegetation: vegetation
      ? {
          ...vegetation,
          density: (vegetation.density ?? 1) * 0.42,
          strokeLength: (vegetation.strokeLength ?? 1) * 0.75,
          motifDensity: (vegetation.motifDensity ?? 1) * 0.45,
          rasterPropDensity: (vegetation.rasterPropDensity ?? 0) * 0.4,
          wetlandShrubDensity: (vegetation.wetlandShrubDensity ?? 0.55) * 0.4,
          mountainSideRidgeDensity: (vegetation.mountainSideRidgeDensity ?? 1) * 0.6,
        }
      : undefined,
  };
}

function makeImageData(width: number, height: number, data: Uint8ClampedArray): ImageData {
  if (typeof ImageData !== "undefined") {
    return new ImageData(data as unknown as Uint8ClampedArray<ArrayBuffer>, width, height);
  }
  return { width, height, data } as unknown as ImageData;
}

function canGpuRasterizeMountainLayer(
  options: MountainRenderOptions,
): boolean {
  return gpuMountainLayerEligibilityReason(options) === undefined;
}

/**
 * Explain why the current GPU mountain-layer pass cannot own rasterization.
 * Keeping this separate from the boolean gate makes profile output actionable
 * when a fast render silently falls back to the CPU path.
 */
function gpuMountainLayerEligibilityReason(
  options: MountainRenderOptions,
): string | undefined {
  if (options.layer !== "vegetation_patterns") return "layer-not-vegetation-patterns";
  if (options.mountainIllustrationRGBA) return "external-mountain-illustration";
  return undefined;
}

/** Static portion of the GPU raster gate, evaluated before layer-worker output exists. */
function canAttemptGpuMountainLayerBeforeLayers(options: MountainRenderOptions): boolean {
  if (options.layer !== "vegetation_patterns") return false;
  if (options.mountainIllustrationRGBA) return false;
  return true;
}

function downsamplePreviewImage(image: ImageData, longEdge: number): ImageData {
  const scale = Math.min(1, longEdge / Math.max(image.width, image.height));
  if (scale >= 1) return image;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  return resizePreviewImage(image, width, height);
}

function resizePreviewImage(
  image: ImageData,
  width: number,
  height: number,
): ImageData {
  if (image.width === width && image.height === height) return image;
  const output = new Uint8ClampedArray(width * height * 4);
  const xScale = (image.width - 1) / Math.max(1, width - 1);
  const yScale = (image.height - 1) / Math.max(1, height - 1);
  for (let y = 0; y < height; y++) {
    const sourceY = y * yScale;
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const ty = sourceY - y0;
    for (let x = 0; x < width; x++) {
      const sourceX = x * xScale;
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const tx = sourceX - x0;
      const topLeft = (y0 * image.width + x0) * 4;
      const topRight = (y0 * image.width + x1) * 4;
      const bottomLeft = (y1 * image.width + x0) * 4;
      const bottomRight = (y1 * image.width + x1) * 4;
      const destination = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const top = image.data[topLeft + channel] * (1 - tx) +
          image.data[topRight + channel] * tx;
        const bottom = image.data[bottomLeft + channel] * (1 - tx) +
          image.data[bottomRight + channel] * tx;
        output[destination + channel] = Math.round(top * (1 - ty) + bottom * ty);
      }
    }
  }
  return makeImageData(width, height, output);
}

function resamplePreviewFloatField(
  source: ArrayLike<number>,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  components = 1,
): Float32Array {
  const output = new Float32Array(width * height * components);
  const scaleX = (sourceWidth - 1) / Math.max(1, width - 1);
  const scaleY = (sourceHeight - 1) / Math.max(1, height - 1);
  for (let y = 0; y < height; y++) {
    const sourceY = y * scaleY;
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const ty = sourceY - y0;
    for (let x = 0; x < width; x++) {
      const sourceX = x * scaleX;
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const tx = sourceX - x0;
      const destination = (y * width + x) * components;
      const topLeft = (y0 * sourceWidth + x0) * components;
      const topRight = (y0 * sourceWidth + x1) * components;
      const bottomLeft = (y1 * sourceWidth + x0) * components;
      const bottomRight = (y1 * sourceWidth + x1) * components;
      for (let channel = 0; channel < components; channel++) {
        const top = source[topLeft + channel] * (1 - tx) + source[topRight + channel] * tx;
        const bottom = source[bottomLeft + channel] * (1 - tx) + source[bottomRight + channel] * tx;
        output[destination + channel] = top * (1 - ty) + bottom * ty;
      }
    }
  }
  return output;
}

function resamplePreviewByteField(
  source: ArrayLike<number>,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  components = 1,
): Uint8Array {
  const output = new Uint8Array(width * height * components);
  const scaleX = (sourceWidth - 1) / Math.max(1, width - 1);
  const scaleY = (sourceHeight - 1) / Math.max(1, height - 1);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(sourceHeight - 1, Math.round(y * scaleY));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(sourceWidth - 1, Math.round(x * scaleX));
      const sourceOffset = (sourceY * sourceWidth + sourceX) * components;
      const destination = (y * width + x) * components;
      for (let channel = 0; channel < components; channel++) {
        output[destination + channel] = Math.max(0, Math.min(255,
          Math.round(source[sourceOffset + channel]),
        ));
      }
    }
  }
  return output;
}

function resamplePreviewDirectionField(
  source: ArrayLike<number>,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Int8Array {
  const output = new Int8Array(width * height);
  const scaleX = (sourceWidth - 1) / Math.max(1, width - 1);
  const scaleY = (sourceHeight - 1) / Math.max(1, height - 1);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(sourceHeight - 1, Math.round(y * scaleY));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(sourceWidth - 1, Math.round(x * scaleX));
      output[y * width + x] = source[sourceY * sourceWidth + sourceX];
    }
  }
  return output;
}

function buildDraftDEM(source: MountainDEMData, longEdge = 768): MountainDEMData {
  if (Math.max(source.width, source.height) <= longEdge) return source;
  const scale = longEdge / Math.max(source.width, source.height);
  const width = Math.max(2, Math.round(source.width * scale));
  const height = Math.max(2, Math.round(source.height * scale));
  const float = (field: Float32Array, components = 1): Float32Array =>
    resamplePreviewFloatField(field, source.width, source.height, width, height, components);
  const bytes = (field: Uint8Array, components = 1): Uint8Array =>
    resamplePreviewByteField(field, source.width, source.height, width, height, components);
  return {
    ...source,
    width,
    height,
    dxMeters: source.domainWidthKm * 1000 / width,
    dyMeters: source.domainHeightKm * 1000 / height,
    elevation: float(source.elevation),
    normalizedElevation: float(source.normalizedElevation),
    slopeDeg: float(source.slopeDeg),
    aspectDeg: float(source.aspectDeg),
    normals: float(source.normals, 3),
    hillshade: float(source.hillshade),
    ambientOcclusion: float(source.ambientOcclusion),
    curvature: float(source.curvature),
    tpi: float(source.tpi),
    flowAccumulation: float(source.flowAccumulation),
    drainageAreaKm2: float(source.drainageAreaKm2),
    rainfallWeightedAreaKm2: float(source.rainfallWeightedAreaKm2),
    runoffDepthMmYr: float(source.runoffDepthMmYr),
    dischargeM3s: float(source.dischargeM3s),
    strahlerOrder: bytes(source.strahlerOrder),
    riverCenterlineMask: bytes(source.riverCenterlineMask),
    isRiverChannel: bytes(source.isRiverChannel),
    riverChannelRadius: source.riverChannelRadius ? bytes(source.riverChannelRadius) : undefined,
    riverMouthMask: source.riverMouthMask ? bytes(source.riverMouthMask) : undefined,
    riverMouthAreaKm2: source.riverMouthAreaKm2 ? float(source.riverMouthAreaKm2) : undefined,
    waterDepthM: float(source.waterDepthM),
    flowDirection: resamplePreviewDirectionField(source.flowDirection, source.width, source.height, width, height),
    erosionDepthM: float(source.erosionDepthM),
    precipitationMmYr: float(source.precipitationMmYr),
    solarInsolation: float(source.solarInsolation),
    temperatureC: float(source.temperatureC),
    biomeType: bytes(source.biomeType),
    isOcean: bytes(source.isOcean),
    lakeDepthM: source.lakeDepthM ? float(source.lakeDepthM) : undefined,
    wetlandPoolMask: source.wetlandPoolMask ? bytes(source.wetlandPoolMask) : undefined,
    visualWaterMask: source.visualWaterMask ? bytes(source.visualWaterMask) : undefined,
    wetlandPoolCoverage: source.wetlandPoolCoverage ? float(source.wetlandPoolCoverage) : undefined,
    visualWaterCoverage: source.visualWaterCoverage ? float(source.visualWaterCoverage) : undefined,
    siltDepth: source.siltDepth ? float(source.siltDepth) : undefined,
    siltCreaseDepth: source.siltCreaseDepth ? float(source.siltCreaseDepth) : undefined,
  };
}

function profileAnalysisSettings(
  request: Extract<MountainPreviewRequest, { type: "analyze" }>,
): Record<string, unknown> {
  const { oceanMask, oceanFloorElevationM, ...options } = request.options;
  void oceanMask;
  void oceanFloorElevationM;
  return {
    ...options,
    analysisLongEdge: request.analysisLongEdge,
    heightmapSmoothingPasses: request.heightmapSmoothingPasses,
  };
}

function waterKey(options: Pick<
  MountainRenderOptions,
  | "wetlandPuddleContours"
  | "wetlandPuddleDensity"
  | "wetlandPuddleSizeMin"
  | "wetlandPuddleSizeMax"
  | "wetlandPuddleCoastDistance"
  | "wetlandPuddleSeed"
  | "riverThresholdKm2"
  | "siltReachM"
  | "siltTopRemoved"
>): string {
  return JSON.stringify([
    options.wetlandPuddleContours,
    options.wetlandPuddleDensity,
    options.wetlandPuddleSizeMin,
    options.wetlandPuddleSizeMax,
    options.wetlandPuddleCoastDistance,
    options.wetlandPuddleSeed,
    options.riverThresholdKm2,
    options.siltReachM,
    options.siltTopRemoved,
  ]);
}

function getVisualWaterDem(options: Pick<
  MountainRenderOptions,
  | "wetlandPuddleContours"
  | "wetlandPuddleDensity"
  | "wetlandPuddleSizeMin"
  | "wetlandPuddleSizeMax"
  | "wetlandPuddleCoastDistance"
  | "wetlandPuddleSeed"
  | "riverThresholdKm2"
  | "siltReachM"
  | "siltTopRemoved"
>, profiler?: ReturnType<typeof createMountainProfiler>): MountainDEMData {
  if (!dem) throw new Error("Preview analysis is not ready");
  const key = waterKey(options);
  const canReuse = Boolean(visualWaterDem && visualWaterKey === key);
  profiler?.recordCache("visual water preparation", canReuse);
  const waterStop = profiler?.begin("visual water preparation");
  if (!canReuse) {
    visualWaterDem = buildVisualWaterSurfaceDEM(dem, {
      enabled: options.wetlandPuddleContours,
      density: options.wetlandPuddleDensity,
      sizeMin: options.wetlandPuddleSizeMin,
      sizeMax: options.wetlandPuddleSizeMax,
      coastDistance: options.wetlandPuddleCoastDistance,
      seed: options.wetlandPuddleSeed,
      riverThresholdKm2: options.riverThresholdKm2,
      siltReachM: options.siltReachM,
      siltTopRemoved: options.siltTopRemoved,
    }, profiler);
    draftDemSource = null;
    draftDem = null;
    finalPreviewDemSource = null;
    finalPreviewDem = null;
  }
  waterStop?.();
  visualWaterKey = key;
  if (!canReuse) {
    renderCache = createMountainRenderStageCache();
    draftRenderCache = createMountainRenderStageCache();
  }
  return visualWaterDem!;
}

function analyze(request: Extract<MountainPreviewRequest, { type: "analyze" }>): void {
  if (!source || request.sourceRevision !== sourceRevision) return;
  // Analysis is also a valid entry point for callers that retain the source
  // in the coordinator. Starting the nested worker here keeps bootstrap off
  // the first render even when no separate source message was sent.
  warmLayerWorker();
  warmFieldBackend();
  const postAnalysisStep = (step: string, stepIndex: number) =>
    post({
      type: "status",
      requestId: request.requestId,
      phase: "analysis",
      step,
      stepIndex,
      stepCount: 2,
    });
  postAnalysisStep("Preparing heightmap", 1);
  const profilingEnabled = request.profile === true;
  const analysisSettings = profilingEnabled
    ? profileAnalysisSettings(request)
    : undefined;
  const changedSettings = analysisSettings
    ? diffMountainProfileSettings(previousProfileAnalysisSettings, analysisSettings)
    : [];
  if (analysisSettings) previousProfileAnalysisSettings = analysisSettings;
  const profiler = profilingEnabled
    ? createMountainProfiler(true, {
        requestId: request.requestId,
        width: source.width,
        height: source.height,
        layer: "analysis",
        changedSettings,
      })
    : undefined;
  try {
  const preparedKey = JSON.stringify([
    sourceRevision,
    request.analysisLongEdge,
    request.heightmapSmoothingPasses,
  ]);
  const preparedCacheHit = Boolean(preparedSource && preparedSourceKey === preparedKey);
  profiler?.recordCache("source preparation", preparedCacheHit);
  const sourcePreparationStop = profiler?.begin("source preparation");
  if (!preparedCacheHit) {
    const size = getHeightmapFitResolution(
      source.width,
      source.height,
      request.analysisLongEdge,
      4096,
    );
    preparedSource = {
      width: size.width,
      height: size.height,
      ...prepareAnalysisHeightmap(
        source.luminance,
        source.oceanMask,
        source.width,
        source.height,
        size.width,
        size.height,
        request.heightmapSmoothingPasses,
      ),
    };
    preparedSourceKey = preparedKey;
    coreAnalysisKey = "";
  }
  sourcePreparationStop?.();
  const prepared = preparedSource;
  if (!prepared) throw new Error("Mountain analysis preparation failed");
  profiler?.setMetadata({ width: prepared.width, height: prepared.height });

  const split = splitAnalysisOptions(request.options);
  const nextCoreKey = JSON.stringify([preparedKey, split.core]);
  const nextLightingKey = JSON.stringify(split.lighting);
  const coreChanged = !dem || coreAnalysisKey !== nextCoreKey;
  profiler?.recordCache("DEM processing", !coreChanged);
  const demProcessingStop = profiler?.begin("DEM processing");
  if (coreChanged) {
    postAnalysisStep("Processing terrain", 2);
    profiler?.recordCache("lighting updates", false);
    const demOptions: BaseDEMOptions = {
      ...split.core,
      ...split.lighting,
      oceanMask: prepared.oceanMask,
    };
    const { erosionIterations: evolutionStep = 0, ...evolutionCore } = split.core;
    const nextEvolutionKey = JSON.stringify([preparedKey, evolutionCore]);
    const evolutionEnabled =
      (split.core.erosionStrength ?? 0) > 0
      && (evolutionStep > 0 || evolutionKey === nextEvolutionKey);
    if (!evolutionEnabled) {
      evolutionKey = "";
      evolutionStates = [];
      dem = processMountainBaseDEM(
        prepared.luminance,
        prepared.width,
        prepared.height,
        demOptions,
        profiler,
      );
    } else if (evolutionKey === nextEvolutionKey && evolutionStates.length > 0) {
      const step = Math.min(evolutionStep, evolutionStates.length - 1);
      dem = rebuildMountainEvolutionStep(
        evolutionStates[step],
        prepared.width,
        prepared.height,
        demOptions,
        step,
        profiler,
      );
    } else {
      const states: MountainEvolutionState[] = [];
      let selectedDem: MountainDEMData | null = null;
      const lastDem = processMountainBaseDEM(
        prepared.luminance,
        prepared.width,
        prepared.height,
        { ...demOptions, erosionIterations: MOUNTAIN_WATER_EVOLUTION_STEPS },
        profiler,
        undefined,
        (step, stepDem, state) => {
          states.push(state);
          if (step === evolutionStep) selectedDem = stepDem;
        },
      );
      evolutionStates = states;
      evolutionKey = nextEvolutionKey;
      // Erosion stops early once nothing changes; later steps equal the last.
      dem = selectedDem ?? lastDem;
    }
    coreAnalysisKey = nextCoreKey;
    lightingKey = nextLightingKey;
    visualWaterDem = null;
    visualWaterKey = "";
    draftDemSource = null;
    draftDem = null;
    finalPreviewDemSource = null;
    finalPreviewDem = null;
    renderCache = createMountainRenderStageCache();
    draftRenderCache = createMountainRenderStageCache();
  }
  demProcessingStop?.();
  if (!coreChanged && lightingKey !== nextLightingKey) {
    profiler?.recordCache("lighting updates", false);
    post({ type: "status", requestId: request.requestId, phase: "lighting" });
    recomputeMountainLighting(dem!, split.lighting, profiler);
    lightingKey = nextLightingKey;
  } else {
    profiler?.recordCache("lighting updates", true);
  }
  if (!dem) throw new Error("Mountain analysis did not produce a DEM");
  analysisRevision = request.analysisRevision;

  const response: MountainPreviewResponse = {
      type: "analysisReady",
      requestId: request.requestId,
      analysisRevision,
      metadata: {
        width: dem.width,
        height: dem.height,
        domainWidthKm: dem.domainWidthKm,
        domainHeightKm: dem.domainHeightKm,
        minElevationM: dem.minElevationM,
        maxElevationM: dem.maxElevationM,
        riverThresholdKm2: request.options.riverThresholdKm2 ?? DEFAULT_RIVER_THRESHOLD_KM2,
      },
    };
  if (coreChanged) {
    const flow = {
      width: dem.width,
      height: dem.height,
      slopeDeg: dem.slopeDeg.slice(),
      flowDirection: dem.flowDirection.slice(),
      isRiverChannel: dem.isRiverChannel.slice(),
      strahlerOrder: dem.strahlerOrder.slice(),
    };
    response.flow = flow;
    response.dem = dem;
    post(response, [
      flow.slopeDeg.buffer,
      flow.flowDirection.buffer,
      flow.isRiverChannel.buffer,
      flow.strahlerOrder.buffer,
    ]);
  } else {
    post(response);
  }
  profiler?.finish("completed");
  } catch (error) {
    profiler?.finish("failed");
    throw error;
  }
}

const renderCoordinator = new LatestRequestCoordinator<
  Extract<MountainPreviewRequest, { type: "render" }>
>(async (request) => {
  if (!dem || request.analysisRevision !== analysisRevision) return;
  const execution = createRenderExecution(
    request.settingsRevision,
    () => !renderCoordinator.isCurrent(request.requestId),
  );
  await execution.checkpoint(true);
  if (execution.cancelled()) return;
  const started = performance.now();
  const requestedOptions: MountainRenderOptions = {
    ...request.options,
    vegetation: request.options.vegetation
      ? {
          ...request.options.vegetation,
          motifAssets: vegetationMotifs ?? undefined,
          rasterPropAssets: rasterProps ?? undefined,
      }
      : undefined,
  };
  let options = resolvePreviewQuality(requestedOptions, request.quality);
  const profilingEnabled = request.profile === true;
  const profileSettings = profilingEnabled
    ? profileRenderSettings(options)
    : undefined;
  const changedSettings = profileSettings
    ? diffMountainProfileSettings(previousProfileRenderSettings, profileSettings)
    : [];
  if (profileSettings) previousProfileRenderSettings = profileSettings;
  const profiler = profilingEnabled
    ? createMountainProfiler(true, {
        requestId: request.requestId,
        width: dem.width,
        height: dem.height,
        layer: options.layer,
        changedSettings,
      })
    : undefined;
  profiler?.setMetadata({
    parallelLayerPipelineRevision: "worker-budget-512-v2",
  });
  try {
  const postRenderStep = (step: string, stepIndex: number) =>
    post({
      type: "status",
      requestId: request.requestId,
      settingsRevision: request.settingsRevision,
      quality: request.quality ?? "final",
      phase:
        options.layer === "vegetation_patterns" ? "vegetation" : "rendering",
      step,
      stepIndex,
      stepCount: RENDER_STEP_COUNT,
    });
  postRenderStep("Preparing terrain", 1);
   const fullRenderDem = getVisualWaterDem(options, profiler);
   let renderDem = fullRenderDem;
   if (request.quality === "draft") {
     if (draftDemSource !== fullRenderDem || !draftDem) {
       draftDem = buildDraftDEM(fullRenderDem);
       draftDemSource = fullRenderDem;
     }
     renderDem = draftDem;
   } else if (
     Math.max(fullRenderDem.width, fullRenderDem.height) >
     FINAL_PREVIEW_INTERNAL_LONG_EDGE
   ) {
     if (finalPreviewDemSource !== fullRenderDem || !finalPreviewDem) {
       finalPreviewDem = buildDraftDEM(
         fullRenderDem,
         FINAL_PREVIEW_INTERNAL_LONG_EDGE,
       );
       finalPreviewDemSource = fullRenderDem;
     }
     renderDem = finalPreviewDem;
     const previewScale = Math.min(
       (renderDem.width - 1) / Math.max(1, fullRenderDem.width - 1),
       (renderDem.height - 1) / Math.max(1, fullRenderDem.height - 1),
     );
     // Water marks are authored against the reference preview DEM, exactly
     // as the export scales them to its output size.
     options = {
       ...options,
       ...scaleWaterPresentationOptions(
         options,
         previewScale *
           Math.max(fullRenderDem.width, fullRenderDem.height) /
           WATER_REFERENCE_LONG_EDGE,
       ),
       mountainPatternPixelScale: previewScale,
     };
     // Preserve the source-domain placement of flow fields while the
     // expensive preview stages run on the reduced DEM.
     if (options.vegetation) {
       options = {
         ...options,
         vegetation: {
           ...options.vegetation,
           // Forest placement sizes are converted from the normalized map
           // scale inside the shared geometry builder. Only the canvas ink
           // support needs the reduced-raster scale before the final resize.
           forestRenderScale: (options.vegetation.forestRenderScale ?? 1) * previewScale,
           coordinateStride: renderDem.width,
           coordinateHeight: renderDem.height,
           coordinateSourceWidth: fullRenderDem.width,
           coordinateSourceHeight: fullRenderDem.height,
          },
       };
     }
   }
   profiler?.recordMetric("preview internal width", renderDem.width, "px");
   profiler?.recordMetric("preview internal height", renderDem.height, "px");
   profiler?.recordMetric("preview output width", fullRenderDem.width, "px");
   profiler?.recordMetric("preview output height", fullRenderDem.height, "px");
   if (execution.cancelled()) return;
   await execution.checkpoint(true);
  if (execution.cancelled()) return;
  const activeRenderCache = request.quality === "draft"
    ? draftRenderCache
    : renderCache;
  const gpuMode = requestedMountainGpuMode(options);
   const gpuMountainLayerPreflight = usesApproximateMountainRaster(gpuMode)
     && canAttemptGpuMountainLayerBeforeLayers(options);
   profiler?.setMetadata({
     mountainGpuMode: gpuMode,
     mountainGpuRasterStatus: usesApproximateMountainRaster(gpuMode)
       ? "pending"
       : gpuMode === "gpuFast"
         ? "disabled-for-fidelity"
         : "disabled",
   });
   // `gpuFast` keeps the exact CPU mountain material while moving reusable
   // support and wind fields to WebGPU. The approximate material rasterizer is
   // deliberately separate because its output is visually different.
   if (!usesMountainGpu(gpuMode) && mountainGpuSession) {
    mountainGpuSessionGeneration += 1;
    mountainGpuSession.dispose();
    mountainGpuSession = null;
    mountainGpuSessionMode = undefined;
    mountainGpuSessionPromise = undefined;
  }
   // Automatic rendering stays on the exact CPU path. Explicit GPU modes can
   // reuse the resident field session; only `gpuApprox` replaces the CPU
   // illustration with the approximate material raster pass below.
   const desiredFieldBackendMode = usesMountainGpu(gpuMode) ? "auto" : "cpu";
  if (mountainFieldBackend && mountainFieldBackendMode !== desiredFieldBackendMode) {
    mountainFieldBackend.dispose();
    mountainFieldBackend = null;
    mountainFieldBackendMode = undefined;
  }
  // Device creation and pipeline warmup begin while the CPU layer worker and
  // mountain field preparation are running. Automatic rendering never touches
  // the experimental compositor.
   const gpuSessionPromise = usesMountainGpu(gpuMode)
     ? ensureMountainGpuSession(gpuMode)
     : undefined;
  void gpuSessionPromise?.catch(() => undefined);
  // Cache validation must precede the asynchronous field preparation. The
  // stage builder then supplies the exact expanded preview DEM, pattern, face
  // field, and dependency signature consumed by the synchronous painter.
  validateMountainRenderStageCache(renderDem, activeRenderCache);
  // Water and vegetation are independent of mountain pattern construction.
  // Start their whole-stage helper job before the synchronous pattern/GPU
  // preparation, then inject only a complete result into the compositor.
  const parallelLayerPreparation = startParallelLayerPreparation(
    renderDem,
    options,
    activeRenderCache,
    {
      isCancelled: execution.cancelled,
      checkpoint: () => execution.checkpoint(true),
      profile: profilingEnabled,
    },
  );
  const parallelLayerPromise = parallelLayerPreparation?.promise;
  // A cancelled render can return before the await below; don't surface that
  // as an unhandled rejection.
  void parallelLayerPromise?.catch(() => undefined);
  if (
    needsMountainIllustrationStage(options)
    && !parallelLayerPreparation
    && layerWorkerPool
  ) {
    profiler?.setMetadata({
      parallelLayerBackend: layerWorkerPool.available ? "not-needed" : "unavailable",
      parallelLayerStatus: layerWorkerPool.available ? "cached" : "worker-unavailable",
    });
  }
  let preparedFieldSet: ReturnType<typeof asPreparedFieldSet> | undefined;
  let retainedPrepared = false;
  let preparedFromCache = false;
  let windPreparationPromise: ReturnType<MountainIllustrationFieldBackend["prepareWindFields"]> | undefined;
  let sharedGpuSession: MountainGpuSession | null = null;
  let stageInputs: ReturnType<typeof buildMountainIllustrationStageInputs> | undefined;
  if (needsMountainIllustrationStage(options)) {
    stageInputs = buildMountainIllustrationStageInputs(
      renderDem,
      options,
      activeRenderCache,
      undefined,
      profiler,
    );
    const dependencySignature = getMountainIllustrationFieldDependencySignature(
      stageInputs.fieldInputs,
    );
    if (usesMountainGpu(gpuMode) && gpuSessionPromise) {
      const gpuSessionWaitStop = profiler?.begin("gpu session wait");
      try {
        sharedGpuSession = await gpuSessionPromise;
      } finally {
        gpuSessionWaitStop?.();
      }
    }
    const cached = activeRenderCache.mountainIllustrationPreparedFieldSet;
    const cacheHit = Boolean(
      cached
        && cached.dependencySignature === dependencySignature,
    );
    if (cacheHit) {
      const cachedPreparationStarted = performance.now();
      preparedFieldSet = cached;
      preparedFromCache = true;
      profiler?.recordCache("mountain illustration fields", true);
      profiler?.recordMetric(
        "mountain fields cached repaint",
        performance.now() - cachedPreparationStarted,
        "ms",
      );
    } else if (!stageInputs.illustrationCacheHit || gpuMountainLayerPreflight) {
      postRenderStep("Building mountain fields", 2);
      postBackendStatus(request.requestId, "initializing");
      if (!sharedGpuSession?.prepareFieldSet && !mountainFieldBackend) {
        mountainFieldBackend = acquireFieldBackend(
          usesMountainGpu(gpuMode) && !gpuSessionPromise ? "auto" : "cpu",
        );
        mountainFieldBackendMode = desiredFieldBackendMode;
      }
      try {
        const control = {
          isCancelled: execution.cancelled,
          checkpoint: () => execution.checkpoint(true),
        };
        if (sharedGpuSession?.prepareFieldSet) {
          const gpuResult = await sharedGpuSession.prepareFieldSet(
            {
              sources: {
                width: stageInputs.fieldInputs.width,
                height: stageInputs.fieldInputs.height,
                lightingElevation: stageInputs.fieldInputs.faceField,
                reliefElevation: stageInputs.fieldInputs.reliefElevation,
                ridgeInk: stageInputs.fieldInputs.ridgeInk,
                ink: stageInputs.fieldInputs.ink,
                coverage: stageInputs.fieldInputs.coverage,
                lineworkCoverage: stageInputs.fieldInputs.lineworkCoverage,
              },
              radii: stageInputs.fieldInputs.radii,
              dependencyKey: dependencySignature,
            },
            control,
          );
          preparedFieldSet = {
            fields: gpuResult.fieldSet.getPreparedFields(),
            dependencySignature,
            retainedBytes: getMountainIllustrationPreparedFieldsByteLength(
              gpuResult.fieldSet.getPreparedFields(),
            ),
          };
          postBackendStatus(request.requestId, "webgpu");
          recordMountainGpuFieldReport(profiler, gpuResult.report, gpuResult.report.cacheHit);
          profiler?.recordMetric(
            "mountain fields retained CPU",
            preparedFieldSet.retainedBytes + stageInputs.fieldInputs.faceField.byteLength,
            "bytes",
          );
          retainedPrepared = retainPreparedFieldSet(
            activeRenderCache,
            preparedFieldSet,
            stageInputs.fieldInputs.faceField.byteLength,
          );
        } else {
          const result = await mountainFieldBackend!.prepare(
            stageInputs.fieldInputs,
            stageInputs.fieldCache,
            control,
          );
          if (execution.cancelled()) {
            profiler?.finish("cancelled");
            return;
          }
          preparedFieldSet = asPreparedFieldSet(result);
          postBackendStatus(
            request.requestId,
            result.report.backend,
            result.report.fallbackReason,
          );
          recordMountainFieldReport(profiler, result.report, false);
          profiler?.recordMetric(
            "mountain fields retained CPU",
            result.retainedBytes + stageInputs.fieldInputs.faceField.byteLength,
            "bytes",
          );
          retainedPrepared = retainPreparedFieldSet(
            activeRenderCache,
            preparedFieldSet,
            stageInputs.fieldInputs.faceField.byteLength,
          );
        }
        if (execution.cancelled()) {
          profiler?.finish("cancelled");
          return;
        }
      } catch (error) {
        if (isRenderCancelled(error) || execution.cancelled()) {
          profiler?.finish("cancelled");
          return;
        }
        throw error;
      }
    }
    const windAzimuthDeg = options.windAzimuthDeg ?? 225;
    const cachedWind = !stageInputs.illustrationCacheHit
      && !options.snowTransportOverride
      && !options.windFieldsOverride
      ? cachedPreviewWindFields(renderDem, windAzimuthDeg, gpuMode)
      : undefined;
    if (cachedWind) {
      options = { ...options, windFieldsOverride: cachedWind };
      profiler?.recordCache("mountain wind fields", true);
    } else if (
      !stageInputs.illustrationCacheHit
      && !options.snowTransportOverride
      && !options.windFieldsOverride
    ) {
      profiler?.recordCache("mountain wind fields", false);
      // Wind uses the same persistent GPU owner as support-field preparation,
      // so it is queued behind that work. Start it before waiting for the
      // independent water/vegetation helper; the helper's CPU work can then
      // overlap GPU submission, compute, and readback.
      if (!sharedGpuSession?.prepareWindFields && !mountainFieldBackend) {
        mountainFieldBackend = acquireFieldBackend(
          usesMountainGpu(gpuMode) && !gpuSessionPromise ? "auto" : "cpu",
        );
        mountainFieldBackendMode = desiredFieldBackendMode;
      }
      windPreparationPromise = sharedGpuSession?.prepareWindFields
        ? sharedGpuSession.prepareWindFields(
          {
            width: renderDem.width,
            height: renderDem.height,
            elevation: renderDem.elevation,
            dxMeters: renderDem.dxMeters,
            dyMeters: renderDem.dyMeters,
            windAzimuthDeg,
          },
          {
            isCancelled: execution.cancelled,
            checkpoint: () => execution.checkpoint(true),
          },
        ).then(result => ({
          fields: result.fields,
          report: {
            backend: result.report.backend,
            totalMs: result.report.totalMs,
            initializationMs: result.report.initializationMs,
            uploadMs: result.report.uploadMs,
            computeMs: result.report.mountainComputeMs,
            readbackMs: result.report.readbackMs,
            tileCount: 0,
            tileSize: Math.max(renderDem.width, renderDem.height),
            retainedGpuBytes: result.report.retainedGpuBytes,
            peakGpuBytes: result.report.peakGpuBytes,
          },
        }))
        : mountainFieldBackend!.prepareWindFields(
          renderDem,
          windAzimuthDeg,
          {
            isCancelled: execution.cancelled,
            checkpoint: () => execution.checkpoint(true),
          },
        );
      // A cancellation can return through the helper path before this
      // promise is awaited. Mark the rejection as handled; the normal path
      // still awaits the original promise below and receives its result.
      void windPreparationPromise.catch(() => undefined);
    }
  }
  await execution.checkpoint(true);
  if (execution.cancelled()) {
    profiler?.finish("cancelled");
    return;
  }
  if (windPreparationPromise) {
    postRenderStep("Computing wind", 3);
    try {
      const windResult = await windPreparationPromise;
      if (execution.cancelled()) {
        profiler?.finish("cancelled");
        return;
      }
      options = { ...options, windFieldsOverride: windResult.fields };
      previewWindFields = {
        elevation: renderDem.elevation,
        elevationFingerprint: getMountainFieldFingerprint(renderDem.elevation),
        dxMeters: renderDem.dxMeters,
        dyMeters: renderDem.dyMeters,
        windAzimuthDeg: options.windAzimuthDeg ?? 225,
        gpuMode,
        fields: windResult.fields,
      };
      postBackendStatus(
        request.requestId,
        windResult.report.backend,
        windResult.report.fallbackReason,
      );
      profiler?.setMetadata({ mountainWindBackend: windResult.report.backend });
      if (windResult.report.initializationMs > 0) {
        profiler?.recordMetric("mountain wind initialization", windResult.report.initializationMs, "ms");
      }
      profiler?.recordMetric("mountain wind upload", windResult.report.uploadMs, "ms");
      profiler?.recordMetric("mountain wind compute", windResult.report.computeMs, "ms");
      profiler?.recordMetric("mountain wind readback", windResult.report.readbackMs, "ms");
      profiler?.recordMetric("mountain wind preparation", windResult.report.totalMs, "ms");
      profiler?.recordMetric("mountain wind tiles", windResult.report.tileCount, "tiles");
      profiler?.recordMetric("mountain wind peak GPU", windResult.report.peakGpuBytes ?? 0, "bytes");
    } catch (error) {
      if (isRenderCancelled(error) || execution.cancelled()) {
        profiler?.finish("cancelled");
        return;
      }
      // The backend's CPU fallback normally handles device errors. A
      // rejected preparation is still isolated to this request.
      profiler?.setMetadata({
        mountainWindFallback: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Wind is normally much shorter than the layer worker. Resolve it first so
  // the illustration painter has its final inputs, then render that stage
  // while water/vegetation continue on the nested worker.
  if (stageInputs && !stageInputs.illustrationCacheHit) {
    stageInputs = buildMountainIllustrationStageInputs(
      renderDem,
      options,
      activeRenderCache,
      undefined,
      profiler,
    );
    if (!execution.cancelled() && !gpuMountainLayerPreflight) {
      postRenderStep("Drawing mountains", 4);
      const overlapStarted = performance.now();
      renderMountainIllustrationStageFromInputs(
        stageInputs,
        preparedFieldSet,
        profiler,
      );
      profiler?.recordMetric(
        "parallel mountain illustration overlap",
        performance.now() - overlapStarted,
        "ms",
      );
    }
  }
  if (parallelLayerPromise) {
    postRenderStep(
      parallelLayerPreparation?.mode === "water"
        ? "Tracing water"
        : parallelLayerPreparation?.mode === "vegetationGeometry"
          ? "Placing vegetation"
          : "Water & vegetation",
      5,
    );
    const parallelLayerWaitStop = profiler?.begin("parallel layer wait");
    try {
      const parallelLayers = await parallelLayerPromise;
      if (parallelLayers) {
        if (parallelLayers.mode !== "vegetationGeometry") {
          options = {
            ...options,
            waterGeometryOverride: parallelLayers.waterGeometry,
            waterOverlayOverride: parallelLayers.waterOverlay,
          };
        }
        if (parallelLayers.mode !== "water") {
          options = {
            ...options,
            vegetationGeometryOverride:
              parallelLayers.vegetationGeometry ?? options.vegetationGeometryOverride,
            vegetationOverlayOverride: parallelLayers.vegetationOverlay,
          };
        }
        profiler?.setMetadata({ parallelLayerBackend: "worker" });
        recordParallelLayerProfile(profiler, parallelLayers.profile);
        profiler?.recordMetric(
          "parallel layer total",
          parallelLayers.timings.wallMs ?? parallelLayers.timings.totalMs,
          "ms",
        );
        profiler?.recordMetric("parallel layer worker", parallelLayers.timings.totalMs, "ms");
        profiler?.recordMetric("parallel layer bootstrap", parallelLayers.timings.bootstrapMs ?? 0, "ms");
        profiler?.recordMetric("parallel layer input copy", parallelLayers.timings.inputCopyMs ?? 0, "ms");
        profiler?.recordMetric("parallel layer input transfer", parallelLayers.timings.inputTransferMs ?? 0, "ms");
        profiler?.recordMetric("parallel layer worker scheduling", parallelLayers.timings.workerSchedulingMs ?? 0, "ms");
        profiler?.recordMetric("parallel layer worker computation", parallelLayers.timings.workerComputationMs ?? parallelLayers.timings.totalMs, "ms");
        profiler?.recordMetric("parallel layer output transfer", parallelLayers.timings.outputTransferMs ?? 0, "ms");
        profiler?.recordMetric("parallel layer result handling", parallelLayers.timings.resultHandlingMs ?? 0, "ms");
        profiler?.recordMetric("parallel layer queue and transfer", parallelLayers.timings.queueMs ?? 0, "ms");
        profiler?.recordMetric("parallel water geometry", parallelLayers.timings.waterGeometryMs, "ms");
        profiler?.recordMetric("parallel water overlay", parallelLayers.timings.waterOverlayMs, "ms");
        profiler?.recordMetric("parallel vegetation geometry", parallelLayers.timings.vegetationGeometryMs, "ms");
        profiler?.recordMetric("parallel vegetation overlay", parallelLayers.timings.vegetationOverlayMs, "ms");
        profiler?.recordMetric(
          "parallel layer retained CPU",
          layerWorkerPool?.peakTrackedBytes ?? 0,
          "bytes",
        );
      } else {
        const skipReason = parallelLayerPreparation?.pool.lastSkipReason;
        profiler?.setMetadata({
          parallelLayerBackend: "cpu-fallback",
          parallelLayerStatus: "skipped",
          parallelLayerSkipReason: skipReason ?? "unknown",
          parallelLayerReservedBytes: parallelLayerPreparation?.pool.lastReservedBytes ?? 0,
          parallelLayerBudgetBytes: parallelLayerPreparation?.pool.budgetBytes ?? 0,
        });
      }
    } catch (error) {
      if (isLayerWorkerCancelled(error) || execution.cancelled()) {
        profiler?.finish("cancelled");
        return;
      }
      // A helper crash affects only this request. Recompute the affected
      // stages synchronously and keep GPU availability unchanged.
      profiler?.setMetadata({
        parallelLayerBackend: "cpu-fallback",
        parallelLayerFallback: error instanceof Error ? error.message : String(error),
      });
    } finally {
      parallelLayerWaitStop?.();
    }
  }
  let mountainGpuLayerSession: MountainGpuSession | null = null;
  let gpuMountainLayerComposed = false;
  const mountainGpuEligibilityReason = usesApproximateMountainRaster(gpuMode)
    ? gpuMountainLayerEligibilityReason(options)
    : undefined;
  profiler?.setMetadata({
    mountainGpuRasterEligibility: usesApproximateMountainRaster(gpuMode)
      ? mountainGpuEligibilityReason
        ? `blocked:${mountainGpuEligibilityReason}`
        : "eligible"
      : "disabled",
  });
  const mountainGpuLayerCandidate =
    usesApproximateMountainRaster(gpuMode)
    && gpuSessionPromise !== undefined
    && canGpuRasterizeMountainLayer(options);
  if (mountainGpuLayerCandidate) {
    recordGpuMountainRasterEvent(profiler, "candidate");
  } else if (usesApproximateMountainRaster(gpuMode)) {
    profiler?.setMetadata({
      mountainGpuRasterStatus: mountainGpuEligibilityReason
        ? `blocked:${mountainGpuEligibilityReason}`
        : gpuSessionPromise === undefined
          ? "session-not-started"
          : "candidate-rejected",
    });
  }
  if (mountainGpuLayerCandidate) {
    const gpuSessionWaitStop = profiler?.begin("gpu session wait");
    try {
      mountainGpuLayerSession = await gpuSessionPromise;
    } finally {
      gpuSessionWaitStop?.();
    }
    if (mountainGpuLayerSession?.available) {
      recordGpuMountainRasterEvent(profiler, "session");
    } else {
      mountainGpuLayerSession = null;
      recordGpuMountainRasterEvent(profiler, "fallback");
      profiler?.setMetadata({
        mountainGpuFallback: mountainGpuFallbackReason ?? "WebGPU session unavailable",
        mountainGpuRasterStatus: "session-unavailable",
      });
    }
  }
  let gpuMountainLayer: Uint8ClampedArray | undefined;
  if (mountainGpuLayerSession) {
    if (!stageInputs || !preparedFieldSet || !mountainGpuLayerSession.rasterizeMountainLayer) {
      recordGpuMountainRasterEvent(profiler, "fallback");
      profiler?.setMetadata({
        mountainGpuFallback: !stageInputs
          ? "mountain illustration stage inputs unavailable"
          : !preparedFieldSet
            ? "prepared mountain fields unavailable"
            : "WebGPU session has no mountain raster pass",
        mountainGpuRasterStatus: "missing-inputs",
      });
      mountainGpuLayerSession = null;
    } else {
      try {
        recordGpuMountainRasterEvent(profiler, "inputs");
        recordGpuMountainRasterEvent(profiler, "attempted");
        const gpuResult = await mountainGpuLayerSession.rasterizeMountainLayer(
          {
            baseElevation: stageInputs.fieldInputs.faceField,
            fields: preparedFieldSet.fields,
            elevationMin: renderDem.minElevationM,
            elevationMax: renderDem.maxElevationM,
            options: {
              inkColor: stageInputs.illustrationOptions.inkColor,
              ridgeColor: stageInputs.illustrationOptions.ridgeColor,
              snowShadowColor: MOUNTAIN_ILLUSTRATION_PALETTE.snowShadow,
              snowColor: MOUNTAIN_ILLUSTRATION_PALETTE.snowMid,
              snowAmount: stageInputs.illustrationOptions.snowfallAmount,
            },
          },
          {
            isCancelled: execution.cancelled,
            checkpoint: () => execution.checkpoint(true),
          },
        );
        recordGpuMountainRasterReport(profiler, gpuResult.report);
        recordGpuMountainRasterEvent(profiler, "success");
        gpuMountainLayer = gpuResult.imageData.data;
        gpuMountainLayerComposed = true;
        profiler?.setMetadata({
          mountainGpuRasterLayer: "mountain-material",
          mountainGpuRasterStatus: "rasterized",
          mountainGpuRasterQuality: "fast-material-approximate",
        });
      } catch (error) {
        if (isRenderCancelled(error) || execution.cancelled()) {
          profiler?.finish("cancelled");
          return;
        }
        recordGpuMountainRasterEvent(profiler, "fallback");
        mountainGpuFallbackReason = error instanceof Error ? error.message : String(error);
        profiler?.setMetadata({
          mountainGpuFallback: mountainGpuFallbackReason,
          mountainGpuRasterStatus: "fallback",
        });
        mountainGpuLayerSession = null;
      }
    }
  }
  const mountainRenderOptions = gpuMountainLayer
    ? {
      ...options,
      mountainIllustrationRGBA: gpuMountainLayer,
      skipMountainIllustrationStage: true,
    }
    : options;
  postRenderStep("Compositing layers", 6);
  const renderedImageData = renderMountainDetailDEMWithCache(
    renderDem,
    mountainRenderOptions,
    activeRenderCache,
    profiler,
    preparedFieldSet,
  );
  if (!retainedPrepared && !preparedFromCache && preparedFieldSet) {
    releaseOversizedPreparedFields(activeRenderCache);
  }
  if (execution.cancelled()) return;
  postRenderStep("Finishing frame", 7);
  let imageData = request.quality === "draft"
    ? downsamplePreviewImage(renderedImageData, 768)
    : renderDem === fullRenderDem
      ? renderedImageData
      : resizePreviewImage(
          renderedImageData,
          fullRenderDem.width,
          fullRenderDem.height,
        );
  if (
    !gpuMountainLayerComposed
    && gpuSessionPromise
    && usesApproximateMountainRaster(gpuMode)
  ) {
    const gpuSessionWaitStop = profiler?.begin("gpu session wait");
    let gpuSession: MountainGpuSession | null = null;
    try {
      gpuSession = await gpuSessionPromise;
    } finally {
      gpuSessionWaitStop?.();
    }
    if (gpuSession?.available) {
      try {
        const gpuResult = await gpuSession.compose(imageData, {
          isCancelled: execution.cancelled,
          checkpoint: () => execution.checkpoint(true),
        });
        const diff = compareMountainGpuImages(imageData.data, gpuResult.imageData.data);
        recordGpuComposeReport(profiler, gpuResult.report, imageData, gpuResult.imageData);
        if (diff.maxAbsError !== undefined && diff.maxAbsError <= 1) {
          imageData = gpuResult.imageData;
          profiler?.setMetadata({ mountainGpuRasterStatus: "frame-copy" });
        } else {
          profiler?.setMetadata({
            mountainGpuFallback: `visual diff exceeded one code value (${diff.maxAbsError ?? 0})`,
            mountainGpuRasterStatus: "fallback",
          });
          mountainGpuSession?.dispose();
          mountainGpuSession = null;
        }
      } catch (error) {
        if (isRenderCancelled(error) || execution.cancelled()) {
          profiler?.finish("cancelled");
          return;
        }
        mountainGpuFallbackReason = error instanceof Error ? error.message : String(error);
        profiler?.setMetadata({
          mountainGpuFallback: mountainGpuFallbackReason,
          mountainGpuRasterStatus: "fallback",
        });
        mountainGpuSession?.dispose();
        mountainGpuSession = null;
      }
    } else {
      profiler?.setMetadata({
        mountainGpuFallback: mountainGpuFallbackReason ?? "WebGPU session unavailable",
        mountainGpuRasterStatus: "fallback",
      });
    }
  }
  if (execution.cancelled()) {
    profiler?.finish("cancelled");
    return;
  }
  const elapsedMs = performance.now() - started;
  if (typeof createImageBitmap === "function") {
    if (execution.cancelled()) {
      profiler?.finish("cancelled");
      return;
    }
    const bitmap = profiler
      ? await profiler.measureAsync("preview bitmap creation", () => createImageBitmap(imageData))
      : await createImageBitmap(imageData);
    if (execution.cancelled()) {
      bitmap.close();
      profiler?.finish("cancelled");
      return;
    }
    const profile = profiler?.finish("completed", false);
    post(
      {
        type: "frame",
        requestId: request.requestId,
        settingsRevision: request.settingsRevision,
        analysisRevision,
        quality: request.quality ?? "final",
        width: imageData.width,
        height: imageData.height,
        bitmap,
        stats: { ...activeRenderCache.stats },
        elapsedMs,
        profile,
      },
      [bitmap],
    );
  } else {
    const profile = profiler?.finish("completed", false);
    post({
      type: "frame",
      requestId: request.requestId,
      settingsRevision: request.settingsRevision,
      analysisRevision,
      quality: request.quality ?? "final",
      width: imageData.width,
      height: imageData.height,
      imageData,
      stats: { ...activeRenderCache.stats },
      elapsedMs,
      profile,
    });
  }
  } catch (error) {
    profiler?.finish("failed");
    throw error;
  }
});

self.onmessage = (event: MessageEvent<MountainPreviewRequest>) => {
  const request = event.data;
  try {
    switch (request.type) {
      case "source":
        renderCoordinator.cancel();
        // Begin loading the nested layer worker while the following analysis
        // request performs the expensive DEM preparation.
        warmLayerWorker();
        source = request.source;
        sourceRevision = request.sourceRevision;
        preparedSource = null;
        preparedSourceKey = "";
        coreAnalysisKey = "";
        evolutionKey = "";
        evolutionStates = [];
        dem = null;
        visualWaterDem = null;
        draftDemSource = null;
        draftDem = null;
        finalPreviewDemSource = null;
        finalPreviewDem = null;
        previousProfileAnalysisSettings = undefined;
        previousProfileRenderSettings = undefined;
        renderCache = createMountainRenderStageCache();
        draftRenderCache = createMountainRenderStageCache();
        retainedPreparedCache = null;
        previewWindFields = null;
        return;
      case "assets":
        if (request.vegetationMotifs !== undefined)
          vegetationMotifs = request.vegetationMotifs;
        if (request.rasterProps !== undefined)
          rasterProps = request.rasterProps;
        return;
      case "analyze":
        analyze(request);
        return;
      case "render":
        renderCoordinator.enqueue(request);
        return;
      case "inspect": {
        if (!dem || request.analysisRevision !== analysisRevision) return;
        const x = Math.max(0, Math.min(dem.width - 1, request.x));
        const y = Math.max(0, Math.min(dem.height - 1, request.y));
        const index = y * dem.width + x;
        post({
          type: "inspectResult",
          requestId: request.requestId,
          analysisRevision,
          value: {
            x,
            y,
            elevM: dem.elevation[index],
            slopeDeg: dem.slopeDeg[index],
            aspectDeg: dem.aspectDeg[index],
            drainageAreaKm2: dem.drainageAreaKm2[index],
            rainfallWeightedAreaKm2: dem.rainfallWeightedAreaKm2[index],
            runoffDepthMmYr: dem.runoffDepthMmYr[index],
            dischargeM3s: dem.dischargeM3s[index],
            strahler: dem.strahlerOrder[index],
            erosionDepthM: dem.erosionDepthM[index],
            precipMm: dem.precipitationMmYr[index],
            tempC: dem.temperatureC[index],
            solarFlux: dem.solarInsolation[index],
            biomeName: getMountainBiomeLabel(dem.biomeType[index]),
            climateZone: getMountainClimateZoneLabel(dem, index),
            heightAboveRiverM: dem.heightAboveDrainageM?.[index] ?? Number.POSITIVE_INFINITY,
          },
        });
        return;
      }
      case "profile":
        if (!dem || request.analysisRevision !== analysisRevision) return;
        post({
          type: "profileResult",
          requestId: request.requestId,
          analysisRevision,
          value: sampleMountainElevationProfile(
            dem,
            request.p0,
            request.p1,
            request.samples,
          ),
        });
        return;
      case "waterSnapshot": {
        if (!dem || request.analysisRevision !== analysisRevision) return;
        const water = getVisualWaterDem(request.options);
        const value = {
          width: water.width,
          height: water.height,
          wetlandPoolMask: water.wetlandPoolMask?.slice(),
          visualWaterMask: water.visualWaterMask?.slice(),
          wetlandPoolCoverage: water.wetlandPoolCoverage?.slice(),
          visualWaterCoverage: water.visualWaterCoverage?.slice(),
        };
        post({
          type: "waterSnapshotResult",
          requestId: request.requestId,
          analysisRevision,
          value,
        });
        return;
      }
      case "heightmap": {
        if (!dem || request.analysisRevision !== analysisRevision) return;
        let lower = dem.minElevationM;
        for (const elevation of dem.elevation) lower = Math.min(lower, elevation);
        const range = Math.max(1, dem.maxElevationM - lower);
        const normalized = new Float32Array(dem.elevation.length);
        for (let index = 0; index < normalized.length; index++) {
          normalized[index] = Math.max(
            0,
            Math.min(1, (dem.elevation[index] - lower) / range),
          );
        }
        const output =
          request.outputWidth === dem.width && request.outputHeight === dem.height
            ? normalized
            : resampleHeightmapLuminance(
                normalized,
                dem.width,
                dem.height,
                request.outputWidth,
                request.outputHeight,
              );
        post(
          {
            type: "heightmapResult",
            requestId: request.requestId,
            analysisRevision,
            width: request.outputWidth,
            height: request.outputHeight,
            normalizedElevation: output,
          },
          [output.buffer],
        );
        return;
      }
    }
  } catch (error) {
    fail("requestId" in request ? request.requestId : 0, error);
  }
};

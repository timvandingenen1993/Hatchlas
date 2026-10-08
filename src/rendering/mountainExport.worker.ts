/**
 * Export worker: prepares the global illustration, then renders tiles in helper workers.
 */
import {
  extractDeepOpenOceanMask,
  getHeightmapExportAnalysisResolution,
  prepareAnalysisHeightmap,
  processMountainBaseDEM,
  resampleHeightmapLuminance,
  resampleHeightmapMask,
  type BaseDEMOptions,
  type MountainDEMData,
} from "../terrain/mountainBaseDEM";
import {
  buildDistanceToCoast,
  buildRiverSplinesForExport,
  buildVisualWaterSurfaceDEM,
  smoothFieldSeparable,
} from "./waterRenderer";
import { buildRiverSiltCreaseField, buildRiverSiltDepthForDEM } from "./riverSilt";
import {
  renderMountainExportTile,
  renderMountainExportTileAsync,
  getMountainExportTileDimensions,
  getMountainExportCameraElevation,
  getMountainExportCameraRidges,
  prepareMountainExportTile,
} from "./mountainExportRenderer";
import type { MountainDetailImageData } from "./mountainDetailRenderer";
import { blitTownStamps } from "../structures/townStamp";
import { projectThroughMesh } from "../structures/viewProjection";
import {
  prepareFullTerrainCameraProjection,
  prepareFullTerrainCameraBand,
  getCameraBandTextureTileKeys,
  processFullTerrainCameraBandWithinTextureBudget,
  type FullTerrainCameraTextureSource,
} from "./fullTerrainCameraRenderer";
import {
  buildVegetationGeometry,
  buildWetlandImageWaterDistance,
} from "./vegetationRenderer";
import {
  buildMountainRoughnessField,
  buildMountainSnowTransportFields,
  type MountainSnowTransportFields,
} from "./mountainIllustrationRenderer";
import { encodeRgbaPngRows } from "../utils/pngEncoding";
import type { PreparedMountainExportTile } from "./mountainExportRenderer";
import type {
  MountainExportGlobalContext,
  MountainExportRequest,
  MountainExportStageTiming,
  MountainExportTile,
  MountainExportWorkerResponse,
  MountainExportWaterSurface,
} from "./mountainExportTypes";
import {
  createMountainProfiler,
  diffMountainProfileSettings,
} from "./mountainProfiler";
import { createRenderExecution } from "./renderExecution";
import {
  MountainLayerWorkerPool,
  type MountainLayerPreparationResult,
} from "./mountainLayerWorkerPool";
import type { MountainProfiler } from "./mountainProfiler";
import {
  asPreparedFieldSet,
  createMountainIllustrationFieldBackend,
  type MountainIllustrationFieldBackend,
} from "./mountainIllustrationGpuExperiment";
import {
  compareMountainGpuImages,
  createMountainGpuSession,
  type MountainGpuRenderMode,
  type MountainGpuSession,
} from "./mountainGpuRenderer";

const cancelled = new Set<number>();
// One export worker owns one lazy GPU session. Camera exports never call this
// backend because their synchronous texture source must remain CPU-backed.
let mountainFieldBackend: MountainIllustrationFieldBackend | null = null;
let mountainFieldBackendMode: "auto" | "cpu" | undefined;
let mountainGpuSession: MountainGpuSession | null = null;
let mountainGpuSessionMode: MountainGpuRenderMode | undefined;
let mountainGpuSessionGeneration = 0;
let mountainGpuSessionPromise: Promise<MountainGpuSession | null> | undefined;
let mountainGpuFallbackReason: string | undefined;
let layerWorkerPool: MountainLayerWorkerPool | null = null;
const activeCameraTileWorkerCancels = new Map<number, () => void>();

function usesMountainGpu(mode: MountainGpuRenderMode): boolean {
  return mode === "gpuFast" || mode === "gpuApprox";
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
      mountainGpuFallbackReason = session ? undefined : "WebGPU is unavailable";
      return session ? session.warmup().then(() => session) : null;
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

interface CameraTileWorkerResult {
  image: MountainDetailImageData;
  foregroundPropsRGBA?: Uint8ClampedArray;
  computeMs: number;
  roundTripMs: number;
  outputBytes: number;
  externalStages: Array<{ stage: string; durationMs: number; calls: number }>;
}

interface PendingCameraTile {
  resolve: (result: CameraTileWorkerResult) => void;
  reject: (error: Error) => void;
  startedAt: number;
}

interface CameraTileWorkerClient {
  render(prepared: PreparedMountainExportTile): Promise<CameraTileWorkerResult>;
  dispose(): void;
}

/**
 * Starts a helper that renders prepared tiles. It needs no export context, so
 * it starts up while the global preparation is still running.
 */
async function createCameraTileWorker(
  profiler: MountainProfiler | undefined,
  profileEnabled: boolean,
  registerCancel: (cancel: () => void) => void,
  onStartFailure: (message: string) => void,
): Promise<CameraTileWorkerClient | undefined> {
  const workerStartedAt = performance.now();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./mountainExportTile.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch (error) {
    onStartFailure(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  const pending = new Map<number, PendingCameraTile>();
  let nextId = 1;
  let initialized = false;
  let failed = false;
  let resolveReady: ((client: CameraTileWorkerClient | undefined) => void) | undefined;
  const makeError = (message: string): Error => new Error(message || "Camera tile worker failed");
  const failWorker = (error: Error): void => {
    if (failed) return;
    failed = true;
    if (!initialized) onStartFailure(error.message);
    worker.terminate();
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  };
  registerCancel(() => {
    failWorker(makeError("Export cancelled"));
    resolveReady?.(undefined);
  });
  const client: CameraTileWorkerClient = {
    render(prepared): Promise<CameraTileWorkerResult> {
      if (failed || !initialized) {
        return Promise.reject(makeError("Camera tile worker is unavailable"));
      }
      const id = nextId++;
      const startedAt = performance.now();
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, startedAt });
        const postStartedAt = performance.now();
        try {
          worker.postMessage({ type: "tile", id, prepared, profileEnabled });
          profiler?.recordMetric(
            "camera tile worker input dispatch",
            performance.now() - postStartedAt,
            "ms",
          );
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : makeError(String(error)));
        }
      });
    },
    dispose(): void {
      if (failed) return;
      failed = true;
      worker.terminate();
      for (const job of pending.values()) job.reject(makeError("Camera tile worker stopped"));
      pending.clear();
    },
  };
  return new Promise<CameraTileWorkerClient | undefined>((resolve) => {
    resolveReady = resolve;
    worker.onmessage = (event: MessageEvent<{
      type: "ready" | "tile" | "error";
      id?: number;
      width?: number;
      height?: number;
      data?: ArrayBuffer;
      foregroundData?: ArrayBuffer;
      computeMs?: number;
      externalStages?: CameraTileWorkerResult["externalStages"];
      message?: string;
    }>) => {
      const response = event.data;
      if (response.type === "ready") {
        initialized = true;
        profiler?.recordMetric(
          "camera tile worker bootstrap",
          performance.now() - workerStartedAt,
          "ms",
        );
        resolve(client);
        return;
      }
      if (response.id === undefined) return;
      const job = pending.get(response.id);
      if (!job) return;
      pending.delete(response.id);
      if (response.type === "error") {
        job.reject(makeError(response.message ?? "Camera tile worker failed"));
        return;
      }
      if (!response.data || !response.width || !response.height) {
        job.reject(makeError("Camera tile worker returned an invalid image"));
        return;
      }
      const image = {
        width: response.width,
        height: response.height,
        data: new Uint8ClampedArray(response.data),
      } as MountainDetailImageData;
      if (response.foregroundData) {
        image.foregroundPropsRGBA = new Uint8ClampedArray(response.foregroundData);
      }
      job.resolve({
        image,
        foregroundPropsRGBA: image.foregroundPropsRGBA,
        computeMs: response.computeMs ?? 0,
        roundTripMs: performance.now() - job.startedAt,
        outputBytes: image.data.byteLength + (image.foregroundPropsRGBA?.byteLength ?? 0),
        externalStages: response.externalStages ?? [],
      });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      failWorker(makeError(event.message));
      resolve(undefined);
    };
    worker.onmessageerror = () => {
      failWorker(makeError("Camera tile worker message could not be decoded"));
      resolve(undefined);
    };
  });
}

const CAMERA_TILE_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
// Each helper holds one cloned prepared tile plus the renderer scratch, so its
// memory depends on the tile size only, never on the size of the export.
const CAMERA_HELPER_MEMORY_BUDGET_BYTES = 6 * 1024 * 1024 * 1024;
const CAMERA_HELPER_MAX_COUNT = 4;
// Camera tile construction retains dozens of full-tile numeric fields across
// terrain mapping, pattern mapping, and illustration painting. This estimate
// deliberately rounds above the known live buffers.
const CAMERA_TILE_SCRATCH_ESTIMATE_BYTES_PER_PIXEL = 320;
// The prepared tile the helper receives: sampled terrain and vector inputs.
const CAMERA_PREPARED_TILE_ESTIMATE_BYTES_PER_PIXEL = 200;

// A helper that gets no result within this time is given up on, and its tile
// is rendered here instead, so a dead or starved helper cannot hang the export.
const CAMERA_HELPER_TILE_TIMEOUT_MS = 4 * 60 * 1000;

function withHelperTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("camera tile helper gave no result within " + CAMERA_HELPER_TILE_TIMEOUT_MS / 1000 + " s")),
      CAMERA_HELPER_TILE_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Memory a helper needs for each tile of the export, largest first. Edge tiles
 * can expand far beyond interior ones (wave halos), but only a few exist, so
 * the pool is sized by the sum of the largest N, which is the worst case that
 * N helpers can hold at once.
 */
function estimateCameraTileBytesDescending(
  context: MountainExportGlobalContext,
  tileSize: number,
  halo: number,
): number[] {
  const tileBytes: number[] = [];
  for (let y = 0; y < context.outputHeight; y += tileSize) {
    for (let x = 0; x < context.outputWidth; x += tileSize) {
      const tile: MountainExportTile = {
        x,
        y,
        width: Math.min(tileSize, context.outputWidth - x),
        height: Math.min(tileSize, context.outputHeight - y),
        halo,
      };
      const dimensions = getMountainExportTileDimensions(context, tile);
      tileBytes.push(
        dimensions.width * dimensions.height
          * (CAMERA_TILE_SCRATCH_ESTIMATE_BYTES_PER_PIXEL + CAMERA_PREPARED_TILE_ESTIMATE_BYTES_PER_PIXEL)
          + tile.width * tile.height * 4,
      );
    }
  }
  return tileBytes.sort((a, b) => b - a);
}

function post(message: MountainExportWorkerResponse): void {
  self.postMessage(message);
}

function sendProgress(
  request: MountainExportRequest,
  completedTiles: number,
  totalTiles: number,
  phase: "analysis" | "rendering" | "projecting" | "encoding",
  message?: string,
  completedRows?: number,
  totalRows?: number,
  stage?: string,
  stageStartedAt?: number,
  completedStages?: MountainExportStageTiming[],
  stageCompleted?: number,
  stageTotal?: number,
): void {
  post({
    type: "progress",
    id: request.id,
    completedTiles,
    totalTiles,
    phase,
    completedRows,
    totalRows,
    message,
    stage,
    stageStartedAt,
    completedStages,
    stageCompleted,
    stageTotal,
  });
}

function prepareGlobalDEM(
  request: MountainExportRequest,
  profiler?: MountainProfiler,
  onStage?: (stage: string) => void,
): MountainDEMData {
  const source = request.source;
  const analysisSize = getHeightmapExportAnalysisResolution(
    source.width,
    source.height,
    request.outputWidth,
    request.outputHeight,
    request.analysisLongEdge,
  );
  const { luminance: denoised, oceanMask: analysisOceanMask } = prepareAnalysisHeightmap(
    source.luminance,
    source.oceanMask,
    source.width,
    source.height,
    analysisSize.width,
    analysisSize.height,
    Number(request.heightmapSmoothingPasses ?? 0),
  );
  const options: BaseDEMOptions = {
    ...request.analysis,
    oceanMask: analysisOceanMask,
  };
  onStage?.("Analyzing terrain model");
  return processMountainBaseDEM(
    denoised,
    analysisSize.width,
    analysisSize.height,
    options,
    profiler,
    onStage,
  );
}

function recordMountainFieldPreparation(
  profiler: MountainProfiler | undefined,
  report: Awaited<ReturnType<MountainIllustrationFieldBackend["prepare"]>>["report"],
): void {
  if (!profiler) return;
  profiler.recordCache("mountain illustration fields", false);
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
  if (report.fallbackReason) profiler.setMetadata({ mountainFieldFallback: report.fallbackReason });
}

/**
 * Keeps the viewport's visual-water decisions when export analysis runs at a
 * different resolution. Masks use nearest-neighbour sampling so categorical
 * water membership stays stable; fractional coverage remains bilinear so the
 * export renderer can still antialias the boundary.
 */
function resampleExportWaterSurface(
  surface: MountainExportWaterSurface | undefined,
  targetWidth: number,
  targetHeight: number,
): MountainExportWaterSurface | undefined {
  if (!surface) return undefined;
  const sourceWidth = Math.floor(surface.width);
  const sourceHeight = Math.floor(surface.height);
  const sourceLength = sourceWidth * sourceHeight;
  if (
    sourceWidth < 1 ||
    sourceHeight < 1 ||
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    surface.wetlandPoolMask.length !== sourceLength ||
    surface.visualWaterMask.length !== sourceLength ||
    surface.wetlandPoolCoverage.length !== sourceLength ||
    surface.visualWaterCoverage.length !== sourceLength
  ) {
    return undefined;
  }
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) return surface;
  return {
    width: targetWidth,
    height: targetHeight,
    wetlandPoolMask: resampleHeightmapMask(
      surface.wetlandPoolMask,
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
    ),
    visualWaterMask: resampleHeightmapMask(
      surface.visualWaterMask,
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
    ),
    wetlandPoolCoverage: resampleHeightmapLuminance(
      surface.wetlandPoolCoverage,
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
    ),
    visualWaterCoverage: resampleHeightmapLuminance(
      surface.visualWaterCoverage,
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
    ),
  };
}

async function runExport(request: MountainExportRequest): Promise<void> {
  const tileSize = Math.max(128, Math.min(2048, Math.floor(request.tileSize ?? 1024)));
  const halo = Math.max(0, Math.min(96, Math.floor(request.halo ?? 32)));
  const cameraEnabled = request.render.fullTerrainCameraElevationDeg !== undefined;
  // Camera projection samples the unprojected compositor through 1024px source
  // tiles. Non-camera exports retain the caller's tile size for composition.
  const sourceTileSize = cameraEnabled ? 1024 : tileSize;
  // Split exports and region previews render only this output rectangle of
  // the full-size image; framing and tile placement stay those of the full export.
  const rowStart = Math.max(0, Math.min(request.outputHeight - 1, Math.floor(request.rowStart ?? 0)));
  const rowEnd = Math.max(rowStart + 1, Math.min(request.outputHeight, Math.floor(request.rowEnd ?? request.outputHeight)));
  const colStart = Math.max(0, Math.min(request.outputWidth - 1, Math.floor(request.colStart ?? 0)));
  const colEnd = Math.max(colStart + 1, Math.min(request.outputWidth, Math.floor(request.colEnd ?? request.outputWidth)));
  const outputRegionWidth = colEnd - colStart;
  const columns = Math.ceil(colEnd / sourceTileSize) - Math.floor(colStart / sourceTileSize);
  const rows = Math.ceil(rowEnd / sourceTileSize) - Math.floor(rowStart / sourceTileSize);
  const totalTiles = columns * rows;
  const execution = createRenderExecution(
    request.id,
    () => cancelled.has(request.id),
  );
  let completedTiles = 0;
  let exportGpuFallback = false;
  let cpuFieldBackend: MountainIllustrationFieldBackend | null = null;
  const profileSettings = request.profile === true ? {
    sourceWidth: request.source.width,
    sourceHeight: request.source.height,
    analysisLongEdge: request.analysisLongEdge,
    analysisResolution: getHeightmapExportAnalysisResolution(
      request.source.width,
      request.source.height,
      request.outputWidth,
      request.outputHeight,
      request.analysisLongEdge,
    ),
    heightmapSmoothingPasses: request.heightmapSmoothingPasses,
    outputWidth: request.outputWidth,
    outputHeight: request.outputHeight,
    tileSize,
    halo,
    layer: request.render.layer,
    gpuRenderMode: request.render.gpuRenderMode ?? "auto",
    palette: request.render.palette,
    sunAzimuthDeg: request.render.sunAzimuthDeg,
    sunAltitudeDeg: request.render.sunAltitudeDeg,
    mountainLightingMode: request.render.mountainLightingMode,
    mountainViewAngleDeg: request.render.mountainViewAngleDeg,
    mountainHeightExaggeration: request.render.mountainHeightExaggeration,
    mountainLineworkScale: request.render.mountainLineworkScale,
    mountainLineworkOpacity: request.render.mountainLineworkOpacity,
    mountainHatchOpacity: request.render.mountainHatchOpacity,
    mountainHatchHorizontalOpacity: request.render.mountainHatchHorizontalOpacity,
    mountainHatchVerticalOpacity: request.render.mountainHatchVerticalOpacity,
    mountainHatchDensity: request.render.mountainHatchDensity,
    mountainLocalDetailDensityMax: request.render.mountainLocalDetailDensityMax,
    mountainFoothillDetailMultiplier: request.render.mountainFoothillDetailMultiplier,
    mountainBiomeDetailMultiplier: request.render.mountainBiomeDetailMultiplier,
    mountainHatchThickness: request.render.mountainHatchThickness,
    mountainRidgeDensity: request.render.mountainRidgeDensity,
    mountainRidgeThickness: request.render.mountainRidgeThickness,
    fullTerrainCameraElevationDeg: request.render.fullTerrainCameraElevationDeg,
    fullTerrainCameraHeightExaggeration: request.render.fullTerrainCameraHeightExaggeration,
    fullTerrainCameraType: request.render.fullTerrainCameraType,
    snowfallAmount: request.render.snowfallAmount,
    snowfallDrift: request.render.snowfallDrift,
    snowfallPersistence: request.render.snowfallPersistence,
    snowRedistributionSteps: request.render.snowRedistributionSteps,
    windAzimuthDeg: request.render.windAzimuthDeg,
    ambientOcclusionStrength: request.render.ambientOcclusionStrength,
    showRivers: request.render.showRivers,
    showWaterDetails: request.render.showWaterDetails,
    showOceanDetails: request.render.showOceanDetails,
    showContours: request.render.showContours,
    contourSmoothingPasses: request.render.contourSmoothingPasses,
    wetlandPuddleContours: request.render.wetlandPuddleContours,
    wetlandPuddleDensity: request.render.wetlandPuddleDensity,
    wetlandPuddleSizeMin: request.render.wetlandPuddleSizeMin,
    wetlandPuddleSizeMax: request.render.wetlandPuddleSizeMax,
    wetlandPuddleCoastDistance: request.render.wetlandPuddleCoastDistance,
    vegetation: request.render.vegetation
      ? {
          preset: request.render.vegetation.preset,
          seed: request.render.vegetation.seed,
          density: request.render.vegetation.density,
          patternScale: request.render.vegetation.patternScale,
          strokeLength: request.render.vegetation.strokeLength,
          strokeThickness: request.render.vegetation.strokeThickness,
          strokeOpacity: request.render.vegetation.strokeOpacity,
          mountainSideRidgeDensity: request.render.vegetation.mountainSideRidgeDensity,
          mountainMainRidgeThickness: request.render.vegetation.mountainMainRidgeThickness,
        }
      : undefined,
  } : undefined;
  const profiler = request.profile === true
    ? createMountainProfiler(true, {
        requestId: request.id,
        width: request.outputWidth,
        height: request.outputHeight,
        layer: request.render.layer,
        changedSettings: profileSettings
          ? diffMountainProfileSettings(undefined, profileSettings)
          : [],
      })
    : undefined;
  const totalStop = profiler?.begin("export request total");
  let readCameraTextureCacheMetrics: (() => {
    hits: number;
    misses: number;
    evictions: number;
    repeatRenders: number;
    peakRetainedBytes: number;
    actualRenderCount: number;
    uniqueTiles: number;
  }) | undefined;
  let profileStatus: "completed" | "cancelled" | "failed" | undefined;
  const finishProfile = (status: "completed" | "cancelled" | "failed"): void => {
    if (profileStatus) return;
    profileStatus = status;
    totalStop?.();
    const cacheMetrics = readCameraTextureCacheMetrics?.();
    if (cacheMetrics) {
      profiler?.recordMetric("camera texture cache hits", cacheMetrics.hits, "tiles");
      profiler?.recordMetric("camera texture cache misses", cacheMetrics.misses, "tiles");
      profiler?.recordMetric("camera texture cache evictions", cacheMetrics.evictions, "tiles");
      profiler?.recordMetric("camera texture repeat renders", cacheMetrics.repeatRenders, "tiles");
      profiler?.recordMetric("camera texture peak retained", cacheMetrics.peakRetainedBytes, "bytes");
      profiler?.recordMetric("camera texture actual renders", cacheMetrics.actualRenderCount, "tiles");
      profiler?.recordMetric("camera texture unique rendered tiles", cacheMetrics.uniqueTiles, "tiles");
    }
    profiler?.finish(status);
    if (status === "cancelled") {
      post({
        type: "cancelled",
        id: request.id,
        completedTiles,
        totalTiles,
      });
    }
  };
  const completedStages: MountainExportStageTiming[] = [];
  let stage = "";
  let stageTimingLabel = "";
  let stageStartedAt = 0;
  let stageStartedPerformance = 0;
  const reportProgress = (
    phase: "analysis" | "rendering" | "projecting" | "encoding",
    message?: string,
    completedRows?: number,
    totalRows?: number,
    stageCompleted?: number,
    stageTotal?: number,
  ): void => sendProgress(
    request, completedTiles, totalTiles, phase, message,
    completedRows, totalRows, stage, stageStartedAt, completedStages,
    stageCompleted, stageTotal,
  );
  const finishStage = (): void => {
    if (!stage) return;
    const durationMs = performance.now() - stageStartedPerformance;
    const existing = completedStages.find(item => item.label === stageTimingLabel);
    if (existing) existing.durationMs += durationMs;
    else completedStages.push({ label: stageTimingLabel, durationMs });
    stage = "";
    stageTimingLabel = "";
  };
  const beginStage = (
    label: string,
    phase: "analysis" | "rendering" | "projecting" | "encoding" = "analysis",
    completedRows?: number,
    totalRows?: number,
    timingLabel = label,
  ): void => {
    const previous = stage;
    const previousMs = previous ? performance.now() - stageStartedPerformance : 0;
    finishStage();
    if (request.profile === true) {
      // Streamed per stage so a crash or hang still shows the last stage reached.
      const heapMb = (performance as unknown as { memory?: { usedJSHeapSize: number } })
        .memory?.usedJSHeapSize;
      console.log(
        `[mountain export] ${previous ? `done "${previous}" ${Math.round(previousMs)}ms | ` : ""}` +
        `start "${label}"${heapMb !== undefined ? ` | heap ${Math.round(heapMb / 1048576)} MB` : ""}`,
      );
    }
    stage = label;
    stageTimingLabel = timingLabel;
    stageStartedAt = Date.now();
    stageStartedPerformance = performance.now();
    reportProgress(phase, label, completedRows, totalRows);
  };
  try {

  if (execution.cancelled()) {
    finishProfile("cancelled");
    return;
  }

  beginStage("Resampling and smoothing heightmap");
  const preparedDEM = profiler
    ? profiler.measure("export global terrain preparation", () => prepareGlobalDEM(request, profiler, beginStage))
    : prepareGlobalDEM(request, undefined, beginStage);
  beginStage("Preparing water surfaces");
  const suppliedWaterSurface = resampleExportWaterSurface(
    request.waterSurface,
    preparedDEM.width,
    preparedDEM.height,
  );
  const canReuseViewportWaterSurface = Boolean(suppliedWaterSurface);
  profiler?.recordCache("export global visual water preparation", canReuseViewportWaterSurface);
  const globalWaterStop = profiler?.begin("export global visual water preparation");
  const reusedSiltDepth = canReuseViewportWaterSurface
    ? buildRiverSiltDepthForDEM(preparedDEM, request.render.riverThresholdKm2, {
        reachM: request.render.siltReachM,
        topRemoved: request.render.siltTopRemoved,
      })
    : null;
  const dem = canReuseViewportWaterSurface
    ? {
        ...preparedDEM,
        siltDepth: reusedSiltDepth ?? undefined,
        siltCreaseDepth: reusedSiltDepth ? buildRiverSiltCreaseField(reusedSiltDepth, preparedDEM) : undefined,
        wetlandPoolMask: suppliedWaterSurface!.wetlandPoolMask,
        visualWaterMask: suppliedWaterSurface!.visualWaterMask,
        wetlandPoolCoverage: suppliedWaterSurface!.wetlandPoolCoverage,
        visualWaterCoverage: suppliedWaterSurface!.visualWaterCoverage,
      }
    : buildVisualWaterSurfaceDEM(preparedDEM, {
        enabled: request.render.wetlandPuddleContours !== false,
        density: request.render.wetlandPuddleDensity,
        sizeMin: request.render.wetlandPuddleSizeMin,
        sizeMax: request.render.wetlandPuddleSizeMax,
        coastDistance: request.render.wetlandPuddleCoastDistance,
        seed: request.render.wetlandPuddleSeed,
        riverThresholdKm2: request.render.riverThresholdKm2,
        siltReachM: request.render.siltReachM,
        siltTopRemoved: request.render.siltTopRemoved,
      }, profiler);
  globalWaterStop?.();
  if (cancelled.has(request.id)) {
    finishProfile("cancelled");
    return;
  }

  // Props are generated once in global coordinates. Every tile receives the
  // same deterministic list and maps it into its local coordinate system.
  const vectorPreparationStop = profiler?.begin("export global vector preparation");
  beginStage("Placing wetland details");
  const render: MountainExportRequest["render"] = {
    ...request.render,
  };
  const gpuMode: MountainGpuRenderMode = render.gpuRenderMode ?? "auto";
  // The experimental compositor currently transfers a completed CPU tile;
  // keep it opt-in until regular water/vegetation fields are composed on the
  // device. Automatic export stays on the exact CPU path.
  if (!usesMountainGpu(gpuMode) && mountainGpuSession) {
    mountainGpuSessionGeneration += 1;
    mountainGpuSession.dispose();
    mountainGpuSession = null;
    mountainGpuSessionMode = undefined;
    mountainGpuSessionPromise = undefined;
  }
  // Automatic export remains exact CPU rendering. `gpuFast` moves reusable
  // fields to WebGPU but keeps the CPU material; `gpuApprox` additionally opts
  // into the experimental compositor.
  const desiredFieldBackendMode = usesMountainGpu(gpuMode) ? "auto" : "cpu";
  if (mountainFieldBackend && mountainFieldBackendMode !== desiredFieldBackendMode) {
    mountainFieldBackend.dispose();
    mountainFieldBackend = null;
    mountainFieldBackendMode = undefined;
  }
  // The field backend's device and pipelines need no inputs, so start them now
  // (same options as its first use below) to overlap global preparation.
  if (usesMountainGpu(gpuMode) && !mountainFieldBackend) {
    mountainFieldBackend = createMountainIllustrationFieldBackend({
      backend: "auto",
      gpu: { tileSize: 1024, maxGpuBytes: 128 * 1024 * 1024 },
      disableGpuOnFailure: false,
    });
    mountainFieldBackendMode = desiredFieldBackendMode;
    mountainFieldBackend.warmup?.();
  }
  // Pipeline/device warmup overlaps global vector and vegetation preparation.
  // Camera exports keep their synchronous source-tile path and therefore only
  // use this session if the ordinary async tile path is selected.
  const gpuSessionPromise = usesMountainGpu(gpuMode)
    ? ensureMountainGpuSession(gpuMode)
    : undefined;
  void gpuSessionPromise?.catch(() => undefined);
  let parallelVegetationPromise: ReturnType<MountainLayerWorkerPool["prepare"]> | undefined;
  if (render.layer === "vegetation_patterns" && !cameraEnabled && render.vegetation) {
    if (!layerWorkerPool) layerWorkerPool = new MountainLayerWorkerPool();
    if (layerWorkerPool.available) {
      parallelVegetationPromise = layerWorkerPool.prepare(
        dem,
        render,
        {
          isCancelled: execution.cancelled,
          checkpoint: () => execution.checkpoint(true),
          profile: Boolean(profiler),
        },
        "vegetationGeometry",
      );
      void parallelVegetationPromise.catch(() => undefined);
    }
  }
  beginStage("Tracing river geometry");
  const riverSplines = buildRiverSplinesForExport(dem, {
    riverThresholdKm2: render.riverThresholdKm2,
    // River banks and coastlines use the charcoal thickness. Outline
    // thickness is reserved for ocean wave strokes.
    outlineThickness: render.waterFlowThickness,
    fillSmoothing: render.waterFillSmoothing,
    useEcologicalBiomeWater: true,
  });
  // The DEM ocean mask is categorical at the selected global analysis
  // resolution.
  // A short separable blur gives the export sampler a continuous shoreline
  // instead of repeating analysis-grid stair steps across the output raster. Keep the
  // original DEM mask untouched for analysis; only export geometry uses this
  // coverage field.
  beginStage("Smoothing coastlines");
  const rawOceanCoverage = new Float32Array(dem.isOcean.length);
  for (let index = 0; index < rawOceanCoverage.length; index++) {
    rawOceanCoverage[index] = dem.isOcean[index];
  }
  const oceanMaskCoverage = smoothFieldSeparable(
    rawOceanCoverage,
    dem.width,
    dem.height,
    1.25,
    2,
  );
  const softenedOceanMask = new Uint8Array(dem.isOcean.length);
  for (let index = 0; index < softenedOceanMask.length; index++) {
    softenedOceanMask[index] = oceanMaskCoverage[index] >= 0.5 ? 1 : 0;
  }
  const oceanDistanceToCoast = buildDistanceToCoast(
    softenedOceanMask,
    dem.width,
    dem.height,
  );
  // Same open-sea test the preview water renderer uses, scaled to this DEM.
  const openOceanMask = extractDeepOpenOceanMask(
    softenedOceanMask,
    dem.isRiverChannel,
    dem.width,
    dem.height,
    30 * Math.max(dem.width, dem.height) / 2048,
  );
  let oceanDistanceToCoastMax = 0;
  for (const distance of oceanDistanceToCoast) {
    if (distance < 1e5 && distance > oceanDistanceToCoastMax) {
      oceanDistanceToCoastMax = distance;
    }
  }
  vectorPreparationStop?.();
  const vegetationPreparationStop = profiler?.begin("export global vegetation preparation");
  if (render.layer === "vegetation_patterns") beginStage("Preparing vegetation geometry");
  let vegetationGeometry: ReturnType<typeof buildVegetationGeometry> | undefined;
  if (parallelVegetationPromise) {
    try {
      const prepared = await parallelVegetationPromise;
      if (prepared?.vegetationGeometry) {
        vegetationGeometry = prepared.vegetationGeometry;
        profiler?.setMetadata({ parallelLayerBackend: "worker" });
        recordParallelLayerProfile(profiler, prepared.profile);
        profiler?.recordMetric("parallel vegetation geometry", prepared.timings.vegetationGeometryMs, "ms");
        profiler?.recordMetric(
          "parallel vegetation worker total",
          prepared.timings.wallMs ?? prepared.timings.totalMs,
          "ms",
        );
        profiler?.recordMetric("parallel vegetation worker compute", prepared.timings.totalMs, "ms");
        profiler?.recordMetric("parallel vegetation bootstrap", prepared.timings.bootstrapMs ?? 0, "ms");
        profiler?.recordMetric("parallel vegetation input copy", prepared.timings.inputCopyMs ?? 0, "ms");
        profiler?.recordMetric("parallel vegetation input transfer", prepared.timings.inputTransferMs ?? 0, "ms");
        profiler?.recordMetric("parallel vegetation worker scheduling", prepared.timings.workerSchedulingMs ?? 0, "ms");
        profiler?.recordMetric("parallel vegetation output transfer", prepared.timings.outputTransferMs ?? 0, "ms");
        profiler?.recordMetric("parallel vegetation result handling", prepared.timings.resultHandlingMs ?? 0, "ms");
        profiler?.recordMetric("parallel vegetation worker computation", prepared.timings.workerComputationMs ?? prepared.timings.totalMs, "ms");
        profiler?.recordMetric("parallel vegetation queue and transfer", prepared.timings.queueMs ?? 0, "ms");
        profiler?.recordMetric("parallel layer peak CPU", layerWorkerPool?.peakTrackedBytes ?? 0, "bytes");
      }
    } catch (error) {
      if (execution.cancelled()) {
        vegetationPreparationStop?.();
        finishProfile("cancelled");
        return;
      }
      profiler?.setMetadata({
        parallelLayerBackend: "cpu-fallback",
        parallelLayerFallback: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!vegetationGeometry && render.layer === "vegetation_patterns") {
    vegetationGeometry = buildVegetationGeometry(
      dem,
      render.vegetation,
      profiler,
      (label, completed, total) => {
        if (label !== stage) beginStage(label);
        reportProgress("analysis", label, undefined, undefined, completed, total);
      },
    );
  }
  const vegetationWaterDistance = render.layer === "vegetation_patterns"
    ? profiler
      ? profiler.measure("vegetation wetland image distance", () =>
          buildWetlandImageWaterDistance(dem, profiler),
        )
      : buildWetlandImageWaterDistance(dem, profiler)
    : undefined;
  vegetationPreparationStop?.();
  let globalSnowTransport: MountainSnowTransportFields | undefined;
  if (render.layer === "vegetation_patterns" || render.fullTerrainCameraElevationDeg !== undefined) {
    beginStage("Preparing wind and snow fields");
    const windAzimuthDeg = render.windAzimuthDeg ?? 225;
    if (render.layer === "vegetation_patterns") {
      // Keep roughness on the coordinator while the persistent WebGPU session
      // evaluates the ray-based wind fields. Camera texture composition stays
      // synchronous, while its independent wind-field preparation can use GPU.
      if (!mountainFieldBackend) {
        mountainFieldBackend = createMountainIllustrationFieldBackend({
          backend: usesMountainGpu(gpuMode) ? "auto" : "cpu",
          gpu: { tileSize: 1024, maxGpuBytes: 128 * 1024 * 1024 },
          disableGpuOnFailure: false,
        });
        mountainFieldBackendMode = desiredFieldBackendMode;
      }
      const windPromise = mountainFieldBackend.prepareWindFields(
        dem,
        windAzimuthDeg,
        {
          isCancelled: execution.cancelled,
          checkpoint: () => execution.checkpoint(true),
        },
      );
      const roughness = profiler
        ? profiler.measure("export global snow roughness", () => buildMountainRoughnessField(dem))
        : buildMountainRoughnessField(dem);
      try {
        const windResult = await windPromise;
        globalSnowTransport = { roughness, ...windResult.fields };
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
        if (execution.cancelled()) {
          finishProfile("cancelled");
          return;
        }
        profiler?.setMetadata({
          mountainWindFallback: error instanceof Error ? error.message : String(error),
        });
        globalSnowTransport = profiler
          ? profiler.measure("export global snow transport CPU fallback", () =>
              buildMountainSnowTransportFields(dem, windAzimuthDeg),
            )
          : buildMountainSnowTransportFields(dem, windAzimuthDeg);
      }
    } else {
      globalSnowTransport = profiler
        ? profiler.measure("export global snow transport preparation", () =>
            buildMountainSnowTransportFields(dem, windAzimuthDeg),
          )
        : buildMountainSnowTransportFields(dem, windAzimuthDeg);
    }
  }
  let currentCameraBandNumber = 0;
  let currentCameraBandStartRow = 0;
  let currentCameraBandCount = 0;
  const context: MountainExportGlobalContext = {
    dem,
    source: request.source,
    render,
    riverSplines,
    vegetationGeometry,
    vegetationWaterDistance,
    oceanDistanceToCoast,
    oceanDistanceToCoastMax,
    openOceanMask,
    oceanMaskCoverage,
    snowTransport: globalSnowTransport,
    outputWidth: request.outputWidth,
    outputHeight: request.outputHeight,
    profiler,
    onTileStage: cameraEnabled
      ? label => {
          if (currentCameraBandNumber <= 0) return;
          beginStage(
            `${label} · camera tile ${Math.min(totalTiles, completedTiles + 1)}/${totalTiles}`,
            "rendering",
            currentCameraBandStartRow,
            request.outputHeight,
            `Camera tile ${label}`,
          );
        }
      : undefined,
  };
  let cameraHelperPromise: Promise<CameraTileWorkerClient[]> = Promise.resolve([]);
  /**
   * Starts the tile helper pool. Helpers receive only prepared tiles, so they
   * start before the global mountain pattern exists and their memory does not
   * grow with the export.
   */
  const startCameraTileHelpers = (): void => {
    if (request.debugForceSerialCameraTiles) {
      profiler?.setMetadata({ cameraTileMode: "serial", cameraTileModeReason: "diagnostic override" });
      return;
    }
    const tileBytes = estimateCameraTileBytesDescending(context, sourceTileSize, halo);
    const hardwareThreads = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 1 : 1;
    // This worker prepares every tile, so helpers only do the rendering.
    let helperCount = Math.max(0, Math.min(
      CAMERA_HELPER_MAX_COUNT,
      Math.floor(hardwareThreads / 4),
      totalTiles - 1,
    ));
    // N helpers can at worst hold the N largest tiles at the same time.
    let worstCaseBytes = 0;
    for (let n = 0; n < helperCount; n++) worstCaseBytes += tileBytes[n] ?? 0;
    while (helperCount > 0 && worstCaseBytes > CAMERA_HELPER_MEMORY_BUDGET_BYTES) {
      helperCount--;
      worstCaseBytes -= tileBytes[helperCount] ?? 0;
    }
    profiler?.recordMetric("camera export helper memory estimate", worstCaseBytes, "bytes");
    profiler?.recordMetric("camera export helper count", helperCount, "helpers");
    if (request.profile === true) {
      console.log("[mountain export] camera helpers: " + helperCount + " (threads " + hardwareThreads
        + ", worst-case " + Math.round(worstCaseBytes / 1048576) + " MiB)");
    }
    if (helperCount < 1) {
      const reason = "thread count, memory budget or tile count leaves no helper";
      profiler?.setMetadata({ cameraTileMode: "serial", cameraTileModeReason: reason });
      console.warn("[mountain export] camera tiles render serially:", reason);
      return;
    }
    profiler?.setMetadata({ cameraTileMode: "parallel", cameraTileModeReason: helperCount + " helper workers" });
    const cancels: Array<() => void> = [];
    activeCameraTileWorkerCancels.set(request.id, () => {
      for (const cancel of cancels) cancel();
    });
    cameraHelperPromise = Promise.all(
      Array.from({ length: helperCount }, () => createCameraTileWorker(
        profiler,
        request.profile === true,
        cancel => cancels.push(cancel),
        message => console.warn("[mountain export] camera tile helper could not start:", message),
      )),
    ).then(helpers => {
      const started = helpers.filter((helper): helper is CameraTileWorkerClient => helper !== undefined);
      if (started.length < helperCount) {
        profiler?.setMetadata({
          cameraTileMode: "degraded",
          cameraTileModeReason: started.length + " of " + helperCount + " helper workers started",
        });
      }
      return started;
    });
  };
  beginStage(
    cameraEnabled ? "Preparing terrain camera" : "Rendering and encoding PNG tiles",
    cameraEnabled ? "projecting" : "rendering",
  );
  const rowBytes = outputRegionWidth * 4 + 1;
  const townStamps = request.townStamps ?? [];
  // Top-down anchors map straight onto the output; the camera path replaces
  // them with projected positions once its mesh is ready.
  let townPositions: { x: number; y: number }[] = townStamps.map((stamp) => ({
    x: stamp.u * (request.outputWidth - 1),
    y: stamp.v * (request.outputHeight - 1),
  }));
  /**
   * Serve camera texture samples from a bounded 1024px source-tile LRU. The
   * tile renderer still receives global coordinates and halos, so the camera
   * sees the same compositor pixels as a fully assembled source while color
   * memory remains capped at roughly 256 MiB.
   */
  function createCameraTextureSource(
    helpers: CameraTileWorkerClient[],
  ): FullTerrainCameraTextureSource & {
    ensureTiles(keys: readonly string[]): Promise<void>;
    pin(keys: readonly string[]): void;
    unpin(keys: readonly string[]): void;
    sampleField(
      x: number,
      y: number,
      output: Uint8ClampedArray,
      offset: number,
      foreground: boolean,
    ): void;
    sampleForegroundRGBA(
      x: number,
      y: number,
      output: Uint8ClampedArray,
      offset: number,
    ): void;
  } {
    const cache = new Map<string, MountainDetailImageData>();
    const renderedSourceTiles = new Set<string>();
    const pinnedKeys = new Set<string>();
    const activeHelpers = [...helpers];
    let cachedBytes = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    let cacheEvictions = 0;
    let repeatRenders = 0;
    let peakRetainedBytes = 0;
    let actualRenderCount = 0;
    let mostRecentTileX = -1;
    let mostRecentTileY = -1;
    let mostRecentImage: MountainDetailImageData | undefined;
    const cacheBudget = CAMERA_TILE_CACHE_BUDGET_BYTES;
    if (profiler) {
      readCameraTextureCacheMetrics = () => ({
        hits: cacheHits,
        misses: cacheMisses,
        evictions: cacheEvictions,
        repeatRenders,
        peakRetainedBytes,
        actualRenderCount,
        uniqueTiles: renderedSourceTiles.size,
      });
    }
    const tileFromKey = (key: string): MountainExportTile => {
      const [tileX, tileY] = key.split(",").map(Number);
      return {
        x: tileX,
        y: tileY,
        width: Math.min(sourceTileSize, request.outputWidth - tileX),
        height: Math.min(sourceTileSize, request.outputHeight - tileY),
        halo,
      };
    };
    const storeTile = (tile: MountainExportTile, image: MountainDetailImageData): void => {
      const key = `${tile.x},${tile.y}`;
      if (cache.has(key)) return;
      cache.set(key, image);
      cachedBytes += image.data.byteLength + (image.foregroundPropsRGBA?.byteLength ?? 0);
      actualRenderCount++;
      if (!renderedSourceTiles.has(key)) {
        renderedSourceTiles.add(key);
        completedTiles++;
        reportProgress("rendering");
      } else {
        repeatRenders++;
      }
      peakRetainedBytes = Math.max(peakRetainedBytes, cachedBytes);
      while (cachedBytes > cacheBudget) {
        let oldestKey: string | undefined;
        for (const candidate of cache.keys()) {
          if (!pinnedKeys.has(candidate) && candidate !== key) {
            oldestKey = candidate;
            break;
          }
        }
        if (oldestKey === undefined) {
          cache.delete(key);
          cachedBytes -= image.data.byteLength + (image.foregroundPropsRGBA?.byteLength ?? 0);
          throw new Error("Pinned camera texture tiles exceeded the 256 MiB cache budget");
        }
        const oldest = cache.get(oldestKey);
        cache.delete(oldestKey);
        cachedBytes -= oldest?.data.byteLength ?? 0;
        cachedBytes -= oldest?.foregroundPropsRGBA?.byteLength ?? 0;
        cacheEvictions++;
        if (oldestKey === `${mostRecentTileX},${mostRecentTileY}`) {
          mostRecentTileX = -1;
          mostRecentTileY = -1;
          mostRecentImage = undefined;
        }
      }
      mostRecentTileX = tile.x;
      mostRecentTileY = tile.y;
      mostRecentImage = image;
    };
    const renderTileLocally = (tile: MountainExportTile): { image: MountainDetailImageData; durationMs: number } => {
      if (execution.cancelled()) throw new Error("Export cancelled");
      const rasterizingCameraBand = currentCameraBandNumber > 0;
      if (rasterizingCameraBand) {
        beginStage(
          `Rendering camera texture tile ${tile.x}, ${tile.y}`,
          "projecting",
          currentCameraBandStartRow,
          request.outputHeight,
          "Camera source tile composition",
        );
      }
      const startedAt = performance.now();
      const sourceTileStop = profiler?.begin("export camera source tile composition");
      let image: MountainDetailImageData;
      try {
        image = renderMountainExportTile(context, tile);
      } finally {
        sourceTileStop?.();
      }
      const durationMs = performance.now() - startedAt;
      profiler?.recordMetric("camera tile local compute", durationMs, "ms");
      storeTile(tile, image);
      if (rasterizingCameraBand) {
        beginStage(
          `Rasterizing camera band ${currentCameraBandNumber}/${currentCameraBandCount}`,
          "projecting",
          currentCameraBandStartRow,
          request.outputHeight,
          "Camera rasterization",
        );
      }
      return { image, durationMs };
    };
    const tileAt = (tileX: number, tileY: number): MountainDetailImageData => {
      if (tileX === mostRecentTileX && tileY === mostRecentTileY && mostRecentImage) {
        cacheHits++;
        return mostRecentImage;
      }
      const key = `${tileX},${tileY}`;
      const cached = cache.get(key);
      if (cached) {
        cacheHits++;
        cache.delete(key);
        cache.set(key, cached);
        mostRecentTileX = tileX;
        mostRecentTileY = tileY;
        mostRecentImage = cached;
        return cached;
      }
      cacheMisses++;
      profiler?.recordMetric("camera tile unprefetched fallback renders", 1, "tiles");
      return renderTileLocally(tileFromKey(key)).image;
    };
    const ensureTiles = async (requestedKeys: readonly string[]): Promise<void> => {
      const missing = [...new Set(requestedKeys)].filter(key => !cache.has(key));
      cacheMisses += missing.length;
      const queue = missing.slice();
      const idle = [...activeHelpers];
      const running = new Set<Promise<void>>();
      // The stage label otherwise still names the last tile prepared here.
      const showWaitingForHelpers = (): void => {
        if (currentCameraBandNumber <= 0) return;
        beginStage(
          "Rendering camera tiles on helpers · camera tile "
            + Math.min(totalTiles, completedTiles + 1) + "/" + totalTiles,
          "rendering",
          currentCameraBandStartRow,
          request.outputHeight,
          "Camera tiles on helpers",
        );
      };
      // This worker is the producer: preparing a tile needs the export
      // context, so it prepares one tile at a time and hands each to an idle
      // helper, which does the long rendering.
      while (queue.length > 0 && (idle.length > 0 || running.size > 0)) {
        if (execution.cancelled()) throw new Error("Export cancelled");
        if (idle.length === 0) {
          showWaitingForHelpers();
          await Promise.race(running);
          continue;
        }
        const key = queue.shift()!;
        const tile = tileFromKey(key);
        const helper = idle.pop()!;
        const prepareStarted = performance.now();
        const prepared = prepareMountainExportTile(context, tile);
        profiler?.recordMetric("camera tile prepare on coordinator", performance.now() - prepareStarted, "ms");
        const dispatchedAt = performance.now();
        if (request.profile === true) {
          console.log("[mountain export] tile " + tile.x + "," + tile.y + " sent to helper ("
            + running.size + " running, " + queue.length + " queued)");
        }
        const job: Promise<void> = withHelperTimeout(helper.render(prepared)).then(result => {
          if (request.profile === true) {
            console.log("[mountain export] tile " + tile.x + "," + tile.y + " rendered by helper in "
              + Math.round(performance.now() - dispatchedAt) + "ms");
          }
          profiler?.recordMetric("camera tile helper compute", result.computeMs, "ms");
          profiler?.recordMetric("camera tile helper output bytes", result.outputBytes, "bytes");
          profiler?.recordMetric("camera tile helper response wait", result.roundTripMs, "ms");
          for (const externalStage of result.externalStages) {
            profiler?.recordExternalStage(
              "parallel " + externalStage.stage,
              externalStage.durationMs,
              externalStage.calls,
            );
          }
          storeTile(tile, result.image);
          idle.push(helper);
        }, error => {
          if (execution.cancelled()) throw new Error("Export cancelled");
          // A failed helper hands its tile back to be rendered here, so a
          // helper fault never fails the export.
          queue.push(key);
          console.warn("[mountain export] camera tile helper failed:", error instanceof Error ? error.message : error);
          helper.dispose();
          const index = activeHelpers.indexOf(helper);
          if (index >= 0) activeHelpers.splice(index, 1);
          profiler?.setMetadata({
            cameraTileMode: "degraded",
            cameraTileModeReason: error instanceof Error ? error.message : String(error),
          });
        }).finally(() => { running.delete(job); });
        running.add(job);
        // Yield so finished helpers deliver their tiles and take the next one.
        await execution.checkpoint(true);
      }
      if (running.size > 0) showWaitingForHelpers();
      await Promise.all(running);
      // Whatever no helper could take: no helpers, or all of them failed.
      while (queue.length > 0) {
        renderTileLocally(tileFromKey(queue.shift()!));
        await execution.checkpoint(true);
      }
    };
    return {
      width: request.outputWidth,
      height: request.outputHeight,
      ensureTiles,
      pin(keys): void {
        for (const key of keys) pinnedKeys.add(key);
      },
      unpin(keys): void {
        for (const key of keys) pinnedKeys.delete(key);
      },
      sampleField(x: number, y: number, output: Uint8ClampedArray, offset: number, foreground: boolean): void {
        const clampedX = Math.max(0, Math.min(request.outputWidth - 1, x));
        const clampedY = Math.max(0, Math.min(request.outputHeight - 1, y));
        const x0 = Math.floor(clampedX);
        const y0 = Math.floor(clampedY);
        const x1 = Math.min(request.outputWidth - 1, x0 + 1);
        const y1 = Math.min(request.outputHeight - 1, y0 + 1);
        const tx = clampedX - x0;
        const ty = clampedY - y0;
        const topLeftTileX = Math.floor(x0 / sourceTileSize) * sourceTileSize;
        const topLeftTileY = Math.floor(y0 / sourceTileSize) * sourceTileSize;
        const topRightTileX = Math.floor(x1 / sourceTileSize) * sourceTileSize;
        const topRightTileY = topLeftTileY;
        const bottomLeftTileX = topLeftTileX;
        const bottomLeftTileY = Math.floor(y1 / sourceTileSize) * sourceTileSize;
        const bottomRightTileX = topRightTileX;
        const bottomRightTileY = bottomLeftTileY;
        if (
          topLeftTileX === topRightTileX &&
          topLeftTileY === bottomLeftTileY &&
          topLeftTileY === bottomRightTileY
        ) {
          const image = tileAt(topLeftTileX, topLeftTileY);
          const topLeftOffset = ((y0 - topLeftTileY) * image.width + (x0 - topLeftTileX)) * 4;
          const topRightOffset = ((y0 - topLeftTileY) * image.width + (x1 - topLeftTileX)) * 4;
          const bottomLeftOffset = ((y1 - topLeftTileY) * image.width + (x0 - topLeftTileX)) * 4;
          const bottomRightOffset = ((y1 - topLeftTileY) * image.width + (x1 - topLeftTileX)) * 4;
          const topWeight = 1 - tx;
          const bottomWeight = 1 - ty;
          for (let channel = 0; channel < 4; channel++) {
            const source = image.foregroundPropsRGBA;
            const top = (foreground ? source?.[topLeftOffset + channel] ?? 0 : image.data[topLeftOffset + channel]) * topWeight
              + (foreground ? source?.[topRightOffset + channel] ?? 0 : image.data[topRightOffset + channel]) * tx;
            const bottom = (foreground ? source?.[bottomLeftOffset + channel] ?? 0 : image.data[bottomLeftOffset + channel]) * topWeight
              + (foreground ? source?.[bottomRightOffset + channel] ?? 0 : image.data[bottomRightOffset + channel]) * tx;
            output[offset + channel] = Math.round(top * bottomWeight + bottom * ty);
          }
          return;
        }
        const topLeftImage = tileAt(topLeftTileX, topLeftTileY);
        const topRightImage = tileAt(topRightTileX, topRightTileY);
        const bottomLeftImage = tileAt(bottomLeftTileX, bottomLeftTileY);
        const bottomRightImage = tileAt(bottomRightTileX, bottomRightTileY);
        const topLeftOffset = ((y0 - topLeftTileY) * topLeftImage.width + (x0 - topLeftTileX)) * 4;
        const topRightOffset = ((y0 - topRightTileY) * topRightImage.width + (x1 - topRightTileX)) * 4;
        const bottomLeftOffset = ((y1 - bottomLeftTileY) * bottomLeftImage.width + (x0 - bottomLeftTileX)) * 4;
        const bottomRightOffset = ((y1 - bottomRightTileY) * bottomRightImage.width + (x1 - bottomRightTileX)) * 4;
        const topWeight = 1 - tx;
        const bottomWeight = 1 - ty;
        for (let channel = 0; channel < 4; channel++) {
          const topLeftSource = topLeftImage.foregroundPropsRGBA;
          const topRightSource = topRightImage.foregroundPropsRGBA;
          const bottomLeftSource = bottomLeftImage.foregroundPropsRGBA;
          const bottomRightSource = bottomRightImage.foregroundPropsRGBA;
          const top = (foreground ? topLeftSource?.[topLeftOffset + channel] ?? 0 : topLeftImage.data[topLeftOffset + channel]) * topWeight
            + (foreground ? topRightSource?.[topRightOffset + channel] ?? 0 : topRightImage.data[topRightOffset + channel]) * tx;
          const bottom = (foreground ? bottomLeftSource?.[bottomLeftOffset + channel] ?? 0 : bottomLeftImage.data[bottomLeftOffset + channel]) * topWeight
            + (foreground ? bottomRightSource?.[bottomRightOffset + channel] ?? 0 : bottomRightImage.data[bottomRightOffset + channel]) * tx;
          output[offset + channel] = Math.round(top * bottomWeight + bottom * ty);
        }
      },
      sampleRGBA(x, y, output, offset): void {
        this.sampleField(x, y, output, offset, false);
      },
      sampleForegroundRGBA(x, y, output, offset): void {
        this.sampleField(x, y, output, offset, true);
      },
    };
  }

  async function* scanlineBands(): AsyncGenerator<Uint8Array> {
    // Tiles stay on the full export's grid so a cropped region renders the
    // same pixels as the complete image; only the requested rectangle is kept.
    for (let tileY = Math.floor(rowStart / tileSize) * tileSize; tileY < rowEnd; tileY += tileSize) {
      if (cancelled.has(request.id)) return;
      const tileHeight = Math.min(tileSize, request.outputHeight - tileY);
      const bandRowStart = Math.max(rowStart, tileY);
      const bandHeight = Math.min(rowEnd, tileY + tileHeight) - bandRowStart;
      const band = new Uint8Array(rowBytes * bandHeight);
      const bandStop = profiler?.begin("export PNG band assembly");
      for (let row = 0; row < bandHeight; row++) band[row * rowBytes] = 0;
      for (let tileX = Math.floor(colStart / tileSize) * tileSize; tileX < colEnd; tileX += tileSize) {
        if (cancelled.has(request.id)) {
          bandStop?.();
          return;
        }
        const tileWidth = Math.min(tileSize, request.outputWidth - tileX);
        if (execution.cancelled()) {
          bandStop?.();
          return;
        }
        let image = await renderMountainExportTileAsync(
          context,
          {
            x: tileX,
            y: tileY,
            width: tileWidth,
            height: tileHeight,
            halo,
          },
          async preparationRequest => {
            if (execution.cancelled()) throw new Error("Export cancelled");
            if (!mountainFieldBackend) {
              mountainFieldBackend = createMountainIllustrationFieldBackend({
                backend: usesMountainGpu(gpuMode) ? "auto" : "cpu",
                gpu: { tileSize: 1024, maxGpuBytes: 128 * 1024 * 1024 },
                disableGpuOnFailure: false,
              });
              mountainFieldBackendMode = desiredFieldBackendMode;
            }
            const backend = exportGpuFallback
              ? (cpuFieldBackend ??= createMountainIllustrationFieldBackend({ backend: "cpu" }))
              : mountainFieldBackend;
            const result = await backend.prepare(
              // This is the expanded tile DEM and the matching mapped pattern;
              // the detail crop is deliberately not used for field analysis.
              preparationRequest.fieldInputs,
              preparationRequest.fieldCache,
              {
                isCancelled: execution.cancelled,
                checkpoint: () => execution.checkpoint(true),
              },
            );
            if (execution.cancelled()) throw new Error("Export cancelled");
            recordMountainFieldPreparation(profiler, result.report);
            profiler?.recordMetric(
              "mountain fields retained CPU",
              result.retainedBytes + preparationRequest.fieldInputs.faceField.byteLength,
              "bytes",
            );
            if (!exportGpuFallback && result.report.backend === "cpu" && result.report.fallbackReason) {
              exportGpuFallback = true;
            }
            return asPreparedFieldSet(result);
          },
        );
        if (execution.cancelled()) {
          bandStop?.();
          return;
        }
        if (!cameraEnabled && gpuSessionPromise && gpuMode === "gpuApprox") {
          const gpuSession = await gpuSessionPromise;
          if (gpuSession?.available) {
            try {
              const gpuResult = await gpuSession.compose(image, {
                isCancelled: execution.cancelled,
                checkpoint: () => execution.checkpoint(true),
              });
              const diff = compareMountainGpuImages(image.data, gpuResult.imageData.data);
              recordGpuComposeReport(profiler, gpuResult.report, image, gpuResult.imageData);
              if ((diff.maxAbsError ?? 0) <= 1) {
                image = gpuResult.imageData;
              } else {
                profiler?.setMetadata({
                  mountainGpuFallback: `visual diff exceeded one code value (${diff.maxAbsError ?? 0})`,
                });
                mountainGpuSession?.dispose();
                mountainGpuSession = null;
              }
            } catch (error) {
              if (execution.cancelled()) {
                bandStop?.();
                return;
              }
              mountainGpuFallbackReason = error instanceof Error ? error.message : String(error);
              profiler?.setMetadata({ mountainGpuFallback: mountainGpuFallbackReason });
              mountainGpuSession?.dispose();
              mountainGpuSession = null;
            }
          } else if (mountainGpuFallbackReason) {
            profiler?.setMetadata({ mountainGpuFallback: mountainGpuFallbackReason });
          }
        }
        const copyColStart = Math.max(colStart, tileX);
        const copyWidth = Math.min(colEnd, tileX + tileWidth) - copyColStart;
        for (let row = 0; row < bandHeight; row++) {
          const sourceOffset = ((bandRowStart - tileY + row) * tileWidth + copyColStart - tileX) * 4;
          const destinationOffset = row * rowBytes + 1 + (copyColStart - colStart) * 4;
          band.set(
            image.data.subarray(sourceOffset, sourceOffset + copyWidth * 4),
            destinationOffset,
          );
        }
        completedTiles++;
        reportProgress("rendering");
        // Give the worker event loop a turn between tiles so a cancel message
        // can be observed before the next high-resolution tile starts.
        await execution.checkpoint(true);
        if (execution.cancelled()) {
          bandStop?.();
          return;
        }
      }
      if (cancelled.has(request.id)) {
        bandStop?.();
        return;
      }
      if (townStamps.length > 0) {
        blitTownStamps({
          data: band,
          width: outputRegionWidth,
          height: bandHeight,
          rowBytes,
          pixelOffset: 1,
          rowStart: bandRowStart,
          colStart,
        }, townStamps, townPositions);
      }
      reportProgress("rendering", "Rendering and encoding PNG tiles");
      bandStop?.();
      yield band;
      // Let the worker event loop service cancellation between tile rows.
      await execution.checkpoint(true);
    }
  }

  const pngEncodingHooks = {
    beginBand: () => {
      if (cameraEnabled && currentCameraBandNumber > 0) {
        beginStage(
          `Encoding PNG band ${currentCameraBandNumber}/${currentCameraBandCount}`,
          "projecting",
          currentCameraBandStartRow,
          request.outputHeight,
          "PNG band encoding",
        );
      }
      return profiler?.begin("PNG encoding") ?? (() => {});
    },
    beginFinalize: () => {
      beginStage(
        "Finalizing PNG",
        "encoding",
        cameraEnabled ? request.outputHeight : undefined,
        cameraEnabled ? request.outputHeight : undefined,
      );
      return profiler?.begin("PNG encoding finalization") ?? (() => {});
    },
  };
  let blob: Blob;
  if (cameraEnabled) {
    if (cancelled.has(request.id)) {
      finishProfile("cancelled");
      return;
    }
    startCameraTileHelpers();
    const cameraSettingsBase = {
      ridgePaths: getMountainExportCameraRidges(context),
      ridgeColor: render.mountainRidgeColor ?? render.vegetation?.inkColor,
      ridgeThicknessScale: 0.75, // user thickness is already in global path widths
      charcoalRidges: true,
      cameraType: render.fullTerrainCameraType ?? "orthographic",
      elevationDeg: render.fullTerrainCameraElevationDeg,
      fieldOfViewDeg: 35,
      heightExaggeration:
        (render.fullTerrainCameraHeightExaggeration ?? 1) *
        Math.max(0.25, render.verticalExaggeration ?? 1),
      elevationField: getMountainExportCameraElevation(context),
      outputWidth: request.outputWidth,
      outputHeight: request.outputHeight,
      colStart,
      colEnd,
    };
    // Fit and project the native DEM once. Every 128-row band reuses these
    // packed coordinates, so band streaming only repeats raster work.
    beginStage("Preparing camera projection", "projecting", 0, request.outputHeight);
    const projectionStop = profiler?.begin("export camera projection preparation");
    const cameraProjection = prepareFullTerrainCameraProjection(dem, cameraSettingsBase);
    projectionStop?.();
    // Towns stand upright on the draped terrain: project each anchor once.
    townPositions = townStamps.map((stamp) => projectThroughMesh(cameraProjection, stamp));
    await execution.checkpoint(true);
    if (execution.cancelled()) {
      finishProfile("cancelled");
      return;
    }
    const helperWaitStartedAt = performance.now();
    const cameraTileHelpers = await cameraHelperPromise;
    profiler?.recordMetric("camera tile helper workers started", cameraTileHelpers.length, "helpers");
    profiler?.recordMetric("camera tile helper startup wait", performance.now() - helperWaitStartedAt, "ms");
    if (execution.cancelled()) {
      finishProfile("cancelled");
      return;
    }
    const cameraSource = createCameraTextureSource(cameraTileHelpers);
    const cameraForegroundSource: FullTerrainCameraTextureSource = {
      width: cameraSource.width,
      height: cameraSource.height,
      sampleRGBA: cameraSource.sampleForegroundRGBA.bind(cameraSource),
    };
    const cameraSettings = {
      ...cameraSettingsBase,
      projection: cameraProjection,
      foregroundSource: cameraForegroundSource,
    };
    // Keep projection and depth memory bounded to one band. The camera band
    // retains full-output coordinates for framing, while its color/depth
    // buffers are local to the requested rows and can be released after PNG
    // encoding consumes them.
    const cameraBandHeight = Math.min(128, request.outputHeight);
    currentCameraBandCount = Math.ceil((rowEnd - rowStart) / cameraBandHeight);
    async function renderVisibleCameraRows(
      rowStart: number,
      rowEnd: number,
      destination: Uint8ClampedArray,
      destinationRowStart: number,
  ): Promise<void> {
      if (execution.cancelled()) throw new Error("Export cancelled");
      const regionCount = await processFullTerrainCameraBandWithinTextureBudget(
        dem,
        rowStart,
        rowEnd,
        cameraSettings,
        sourceTileSize,
        CAMERA_TILE_CACHE_BUDGET_BYTES,
        async (plan, neededTileKeys, workingSetBytes) => {
          profiler?.recordMetric("camera visible texture tiles per region", neededTileKeys.length, "tiles");
          profiler?.recordMetric("camera visible texture working set", workingSetBytes, "bytes");
          cameraSource.pin(neededTileKeys);
          try {
            beginStage(
              `Preparing ${neededTileKeys.length} visible camera texture tiles`,
              "rendering",
              plan.rowStart,
              request.outputHeight,
              "Visible camera texture tile preparation",
            );
            await cameraSource.ensureTiles(neededTileKeys);
            if (execution.cancelled()) throw new Error("Export cancelled");
            const sampleStop = profiler?.begin("export camera band texture sampling and linework");
            const rendered = plan.finish(cameraSource);
            sampleStop?.();
            destination.set(
              rendered.data,
              (plan.rowStart - destinationRowStart) * request.outputWidth * 4,
            );
          } finally {
            cameraSource.unpin(neededTileKeys);
          }
        },
        (start, end, settings) => profiler
          ? profiler.measure("export camera band rasterization", () =>
              prepareFullTerrainCameraBand(dem, start, end, settings),
            )
          : prepareFullTerrainCameraBand(dem, start, end, settings),
      );
      if (regionCount > 1) {
        profiler?.recordMetric("camera band subdivisions", regionCount - 1, "regions");
      }
    }
    // A small export touches only a handful of source tiles. Plan every band
    // first and render the whole set across the helper pool, instead of
    // discovering two or three new tiles per band. Larger exports keep the
    // per-band path, which still spreads each band's new tiles over the pool.
    if (cameraTileHelpers.length > 0) {
      const prefetchKeys = new Set<string>();
      beginStage("Planning camera texture tiles", "projecting", 0, request.outputHeight);
      for (let y = rowStart; y < rowEnd; y += cameraBandHeight) {
        if (execution.cancelled()) throw new Error("Export cancelled");
        const plan = prepareFullTerrainCameraBand(
          dem,
          y,
          Math.min(rowEnd, y + cameraBandHeight),
          cameraSettings,
        );
        for (const key of getCameraBandTextureTileKeys(
          plan,
          request.outputWidth,
          request.outputHeight,
          sourceTileSize,
        )) prefetchKeys.add(key);
        await execution.checkpoint();
      }
      // RGBA plus foreground-prop RGBA per source tile.
      const prefetchBytes = prefetchKeys.size * sourceTileSize * sourceTileSize * 8;
      profiler?.recordMetric("camera prefetch texture tiles", prefetchKeys.size, "tiles");
      if (prefetchBytes <= CAMERA_TILE_CACHE_BUDGET_BYTES * 0.75) {
        beginStage("Rendering camera texture tiles", "rendering", 0, request.outputHeight);
        await cameraSource.ensureTiles([...prefetchKeys]);
      }
    }
    async function* projectedScanlines(): AsyncGenerator<Uint8Array> {
      let cameraBandNumber = 0;
      for (let y = rowStart; y < rowEnd; y += cameraBandHeight) {
        if (cancelled.has(request.id)) return;
        cameraBandNumber++;
        const bandHeight = Math.min(cameraBandHeight, rowEnd - y);
        currentCameraBandNumber = cameraBandNumber;
        currentCameraBandStartRow = y;
        beginStage(
          `Rasterizing camera band ${cameraBandNumber}/${currentCameraBandCount}`,
          "projecting",
          y,
          request.outputHeight,
          "Camera rasterization",
        );
        const cameraBandData = new Uint8ClampedArray(request.outputWidth * bandHeight * 4);
        await renderVisibleCameraRows(y, y + bandHeight, cameraBandData, y);
        if (townStamps.length > 0) {
          blitTownStamps({
            data: cameraBandData,
            width: request.outputWidth,
            height: bandHeight,
            rowBytes: request.outputWidth * 4,
            pixelOffset: 0,
            rowStart: y,
            colStart: 0,
          }, townStamps, townPositions);
        }
        const cameraBand = {
          width: request.outputWidth,
          height: bandHeight,
          data: cameraBandData,
        } as ImageData;
        const scanlines = new Uint8Array(rowBytes * bandHeight);
        for (let rowIndex = 0; rowIndex < bandHeight; rowIndex++) {
          const rowOffset = rowIndex * rowBytes;
          scanlines[rowOffset] = 0;
          const rgbaStride = cameraBand.width * 4;
          scanlines.set(
            cameraBand.data.subarray(
              rowIndex * rgbaStride + colStart * 4,
              rowIndex * rgbaStride + colEnd * 4,
            ),
            rowOffset + 1,
          );
        }
        yield scanlines;
        reportProgress(
          "projecting",
          stage,
          Math.min(request.outputHeight, y + bandHeight),
          request.outputHeight,
        );
        await execution.checkpoint(true);
      }
    }
    blob = await encodeRgbaPngRows(
      outputRegionWidth,
      rowEnd - rowStart,
      projectedScanlines(),
      pngEncodingHooks,
    );
  } else {
    blob = await encodeRgbaPngRows(
      outputRegionWidth,
      rowEnd - rowStart,
      scanlineBands(),
      pngEncodingHooks,
    );
  }
  if (cancelled.has(request.id)) {
    finishProfile("cancelled");
    return;
  }
  finishStage();
  finishProfile("completed");
  post({ type: "result", id: request.id, filename: request.filename, blob, completedStages });
  } catch (error) {
    finishProfile(cancelled.has(request.id) ? "cancelled" : "failed");
    throw error;
  } finally {
    // Stops the helper workers on every exit path, including a failure
    // before they were awaited.
    activeCameraTileWorkerCancels.get(request.id)?.();
    activeCameraTileWorkerCancels.delete(request.id);
  }
}

self.onmessage = (event: MessageEvent<MountainExportRequest | { type: "cancel"; id: number }>) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelled.add(request.id);
    activeCameraTileWorkerCancels.get(request.id)?.();
    return;
  }
  void runExport(request)
    .catch((error: unknown) => {
      if (cancelled.has(request.id)) return;
      post({
        type: "error",
        id: request.id,
        message: error instanceof Error ? error.message : "Mountain export failed",
      });
    })
    .finally(() => {
      cancelled.delete(request.id);
    });
};

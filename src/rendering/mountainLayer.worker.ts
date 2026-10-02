/**
 * Worker that renders one mountain layer; the layer pool dispatches prepare/cancel messages to it.
 */
import type { MountainDEMData } from "../terrain/mountainBaseDEM";
import {
  buildMountainWaterStageInputs,
  vegetationGeometryStageKey,
  type MountainRenderOptions,
} from "./mountainDetailRenderer";
import {
  buildWaterOverlayGeometry,
  paintedWaterAlphaFromGeometry,
  renderWaterOverlayFromGeometry,
  type WaterOverlay,
  type WaterOverlayGeometry,
} from "./waterRenderer";
import {
  buildVegetationGeometry,
  renderVegetationOverlay,
  type VegetationGeometry,
  type VegetationLayerPart,
  type VegetationOverlay,
} from "./vegetationRenderer";
import {
  createMountainProfiler,
  type MountainProfileReport,
} from "./mountainProfiler";

interface PrepareMessage {
  type: "prepare";
  id: number;
  dem: MountainDEMData;
  options: MountainRenderOptions;
  vegetationGeometryOverride?: VegetationGeometry;
  mode?: "all" | "water" | "vegetationGeometry" | "vegetation" | "vegetationFlow" | "vegetationProps";
  profile?: boolean;
}

interface CancelMessage {
  type: "cancel";
  id: number;
}

interface PreparationResult {
  type: "result";
  id: number;
  mode: "all" | "water" | "vegetationGeometry" | "vegetation" | "vegetationFlow" | "vegetationProps";
  waterGeometry: WaterOverlayGeometry | null;
  waterOverlay: WaterOverlay | null;
  vegetationGeometry: VegetationGeometry | null;
  vegetationOverlay: VegetationOverlay | null;
  timings: {
    totalMs: number;
    waterGeometryMs: number;
    waterOverlayMs: number;
    vegetationGeometryMs: number;
    vegetationOverlayMs: number;
  };
  profile?: MountainProfileReport;
  timestamps: {
    workerStartedAt: number;
    workerFinishedAt: number;
    workerPostedAt: number;
  };
}

interface FailureResult {
  type: "error";
  id: number;
  message: string;
}

const cancelled = new Set<number>();

function absoluteNow(): number {
  return typeof performance !== "undefined" && Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin + performance.now()
    : Date.now();
}

function isCancelled(id: number): boolean {
  return cancelled.has(id);
}

function collectTransferables(value: unknown, transfers: Transferable[], seen: Set<ArrayBuffer>): void {
  if (!value || typeof value !== "object") return;
  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer;
    if (buffer instanceof ArrayBuffer && !seen.has(buffer)) {
      seen.add(buffer);
      transfers.push(buffer);
    }
    return;
  }
  if (value instanceof ArrayBuffer) {
    if (!seen.has(value)) {
      seen.add(value);
      transfers.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTransferables(item, transfers, seen);
    return;
  }
  for (const child of Object.values(value)) collectTransferables(child, transfers, seen);
}

function postResult(result: PreparationResult): void {
  const transfers: Transferable[] = [];
  collectTransferables(result, transfers, new Set<ArrayBuffer>());
  result.timestamps.workerPostedAt = absoluteNow();
  (self as unknown as {
    postMessage(message: PreparationResult, transfer: Transferable[]): void;
  }).postMessage(result, transfers);
}

function postCancellation(id: number): void {
  self.postMessage({
    type: "error",
    id,
    message: "Parallel layer preparation was cancelled",
  } satisfies FailureResult);
}

function prepare(message: PrepareMessage): void {
  const { id, dem, options, mode = "all" } = message;
  const workerStartedAt = absoluteNow();
  const profiler = message.profile
    ? createMountainProfiler(true, {
        width: dem.width,
        height: dem.height,
        layer: "parallel_layers",
      })
    : undefined;
  try {
    const started = performance.now();
    if (isCancelled(id)) {
      postCancellation(id);
      return;
    }
    const stage = mode === "vegetationGeometry"
      ? { shouldBuildWater: false, options: buildMountainWaterStageInputs(dem, options).options }
      : buildMountainWaterStageInputs(dem, options);
    const waterGeometryStarted = performance.now();
    const shouldBuildWater = mode !== "vegetationGeometry" && stage.shouldBuildWater;
    const waterGeometry = shouldBuildWater
      ? buildWaterOverlayGeometry(dem, stage.options, profiler)
      : null;
    const waterGeometryMs = performance.now() - waterGeometryStarted;
    if (isCancelled(id)) {
      postCancellation(id);
      return;
    }
    const waterOverlayStarted = performance.now();
    // The vegetation jobs run beside a "water" job on another worker: they
    // need only the painted water coverage, which geometry already determines.
    const vegetationJob = mode === "vegetation" || mode === "vegetationFlow" || mode === "vegetationProps";
    // "vegetationFlow" and "vegetationProps" are the two independent halves
    // of a "vegetation" job, run on separate workers and merged afterwards.
    const vegetationPart: VegetationLayerPart = mode === "vegetationFlow"
      ? "flow"
      : mode === "vegetationProps" ? "props" : "all";
    const waterOverlay = waterGeometry && !vegetationJob
      ? renderWaterOverlayFromGeometry(dem, stage.options, waterGeometry, profiler)
      : null;
    const paintedWaterAlpha = waterOverlay?.waterAlpha
      ?? (waterGeometry ? paintedWaterAlphaFromGeometry(stage.options, waterGeometry) : undefined);
    const waterOverlayMs = performance.now() - waterOverlayStarted;
    if (isCancelled(id)) {
      postCancellation(id);
      return;
    }

    let vegetationDem = dem;
    if (options.layer === "vegetation_patterns" && paintedWaterAlpha) {
      // The snapshot owns these arrays, so merge the rendered water alpha into
      // the transferred classification buffer in place. This keeps the exact
      // max() semantics while avoiding a second full-resolution allocation and
      // copy before vegetation sampling starts.
      const coverage = dem.visualWaterCoverage?.length === dem.width * dem.height
        ? dem.visualWaterCoverage
        : new Float32Array(dem.width * dem.height);
      for (let index = 0; index < coverage.length; index++) {
        const classified = dem.visualWaterCoverage?.[index]
          ?? dem.visualWaterMask?.[index]
          ?? 0;
        coverage[index] = Math.max(classified, paintedWaterAlpha[index] / 255);
      }
      vegetationDem = { ...dem, visualWaterCoverage: coverage };
    }
    const shouldBuildVegetation = mode !== "water" && options.layer === "vegetation_patterns";
    const vegetationGeometryStarted = performance.now();
    profiler?.recordCache(
      "vegetation geometry input",
      Boolean(message.vegetationGeometryOverride),
    );
    const vegetationGeometry = shouldBuildVegetation
      ? message.vegetationGeometryOverride ??
        buildVegetationGeometry(vegetationDem, options.vegetation, profiler, undefined, vegetationPart)
      : null;
    const vegetationGeometryMs = performance.now() - vegetationGeometryStarted;
    if (isCancelled(id)) {
      postCancellation(id);
      return;
    }
    const vegetationOverlayStarted = performance.now();
    const vegetationOverlay = vegetationGeometry
      ? renderVegetationOverlay(
          vegetationDem,
          vegetationGeometry,
          options.vegetation,
          options.sunAzimuthDeg,
          {},
          vegetationGeometryStageKey(options),
          profiler,
          vegetationPart,
        )
      : null;
    const vegetationOverlayMs = performance.now() - vegetationOverlayStarted;
    if (isCancelled(id)) {
      postCancellation(id);
      return;
    }
    const profile = profiler?.finish("completed", false);
    const workerFinishedAt = absoluteNow();
    postResult({
      type: "result",
      id,
      mode,
      waterGeometry: vegetationJob ? null : waterGeometry,
      waterOverlay,
      // The coordinator retains the source geometry. Sending it back would
      // duplicate megabytes of typed arrays on paint-only renders.
      vegetationGeometry: message.vegetationGeometryOverride ? null : vegetationGeometry,
      vegetationOverlay,
      timings: {
        totalMs: performance.now() - started,
        waterGeometryMs,
        waterOverlayMs,
        vegetationGeometryMs,
        vegetationOverlayMs,
      },
      profile,
      timestamps: {
        workerStartedAt,
        workerFinishedAt,
        workerPostedAt: 0,
      },
    });
  } catch (error) {
    profiler?.finish("failed", false);
    const failure: FailureResult = {
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(failure);
  } finally {
    cancelled.delete(id);
  }
}

self.postMessage({ type: "ready", readyAt: absoluteNow() });

self.onmessage = (event: MessageEvent<PrepareMessage | CancelMessage>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelled.add(message.id);
    return;
  }
  void Promise.resolve().then(() => prepare(message));
};

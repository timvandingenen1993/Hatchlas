import type { MountainDEMData } from "../terrain/mountainBaseDEM";
import type {
  MountainRenderOptions,
} from "./mountainDetailRenderer";
import type {
  VegetationGeometry,
  VegetationOverlay,
} from "./vegetationRenderer";
import type {
  WaterOverlay,
  WaterOverlayGeometry,
} from "./waterRenderer";
import type { MountainProfileReport } from "./mountainProfiler";

// A 2030x2048 preview carries roughly 250 MiB of DEM fields before the
// worker's water/vegetation outputs are accounted for.  The previous 256 MiB
// cap therefore rejected the exact resolution used by the preview profiler,
// silently sending the render back through the serial CPU path.  Keep the
// reservation bounded, but large enough for one full-resolution layer job.
export const PARALLEL_LAYER_CPU_BUDGET = 512 * 1024 * 1024;

export class MountainLayerWorkerCancelledError extends Error {
  readonly cancelled = true;

  constructor() {
    super("Parallel layer preparation was cancelled");
    this.name = "MountainLayerWorkerCancelledError";
  }
}

export interface MountainLayerPreparationResult {
  mode: MountainLayerPreparationMode;
  waterGeometry: WaterOverlayGeometry | null;
  waterOverlay: WaterOverlay | null;
  vegetationGeometry: VegetationGeometry | null;
  vegetationOverlay: VegetationOverlay | null;
  timings: {
    totalMs: number;
    /** Wall time observed by the coordinator, including clone/transfer. */
    wallMs?: number;
    /** Compatibility aggregate for all non-worker wall time. */
    queueMs?: number;
    /** Main-thread DEM snapshot copy time. */
    inputCopyMs?: number;
    /** Worker construction and module initialization time. */
    bootstrapMs?: number;
    /** Time spent inside postMessage copying/transferring the input snapshot. */
    inputTransferMs?: number;
    /** Time after postMessage returns until worker execution begins. */
    workerSchedulingMs?: number;
    /** Time spent cloning/transferring the worker result to the coordinator. */
    outputTransferMs?: number;
    /** Main-thread result handling time after the message is delivered. */
    resultHandlingMs?: number;
    /** Worker-side water/vegetation computation time. */
    workerComputationMs?: number;
    waterGeometryMs: number;
    waterOverlayMs: number;
    vegetationGeometryMs: number;
    vegetationOverlayMs: number;
  };
  /** Absolute cross-context marks used to audit each transport phase. */
  timestamps?: {
    workerCreatedAt?: number;
    workerReadyAt?: number;
    queuedAt?: number;
    postedAt?: number;
    postReturnedAt?: number;
    workerStartedAt?: number;
    workerFinishedAt?: number;
    workerPostedAt?: number;
    receivedAt?: number;
  };
  profile?: MountainProfileReport;
}

export interface MountainLayerWorkerControl {
  isCancelled?: () => boolean;
  checkpoint?: () => Promise<void>;
  profile?: boolean;
  /** Coverage produced by a cached water overlay for vegetation-only work. */
  waterCoverageOverride?: Float32Array;
  /** Reuse primary-worker geometry when only its painted overlay is stale. */
  vegetationGeometryOverride?: VegetationGeometry;
}

/** "vegetation" derives water coverage from geometry and skips water paint,
 * so it can run beside a "water" job on a second worker. "vegetationFlow" and
 * "vegetationProps" are its two independent halves for a third worker. */
export type MountainLayerPreparationMode =
  | "all" | "water" | "vegetationGeometry" | "vegetation" | "vegetationFlow" | "vegetationProps";

export interface MountainLayerTimingMarks {
  queuedAt: number;
  postedAt?: number;
  postReturnedAt?: number;
  workerStartedAt?: number;
  workerPostedAt?: number;
  receivedAt?: number;
  workerMs: number;
}

/** Derive transport phases from clocks shared by the two worker contexts. */
export function deriveMountainLayerTransferTimings(marks: MountainLayerTimingMarks): Pick<
  MountainLayerPreparationResult["timings"],
  "wallMs" | "queueMs" | "inputTransferMs" | "workerSchedulingMs" | "outputTransferMs"
> {
  const wallMs = marks.receivedAt === undefined
    ? undefined
    : Math.max(0, marks.receivedAt - marks.queuedAt);
  return {
    wallMs,
    queueMs: wallMs === undefined
      ? undefined
      : Math.max(0, wallMs - marks.workerMs),
    inputTransferMs: marks.postedAt !== undefined && marks.postReturnedAt !== undefined
      ? Math.max(0, marks.postReturnedAt - marks.postedAt)
      : marks.postedAt !== undefined && marks.workerStartedAt !== undefined
        ? Math.max(0, marks.workerStartedAt - marks.postedAt)
      : undefined,
    workerSchedulingMs: marks.postReturnedAt !== undefined && marks.workerStartedAt !== undefined
      ? Math.max(0, marks.workerStartedAt - marks.postReturnedAt)
      : undefined,
    outputTransferMs: marks.workerPostedAt !== undefined && marks.receivedAt !== undefined
      ? Math.max(0, marks.receivedAt - marks.workerPostedAt)
      : undefined,
  };
}

function absoluteNow(): number {
  return typeof performance !== "undefined" && Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin + performance.now()
    : Date.now();
}

interface WorkerResult {
  type: "result";
  id: number;
  mode: MountainLayerPreparationMode;
  waterGeometry: WaterOverlayGeometry | null;
  waterOverlay: WaterOverlay | null;
  vegetationGeometry: VegetationGeometry | null;
  vegetationOverlay: VegetationOverlay | null;
  timings: MountainLayerPreparationResult["timings"];
  profile?: MountainProfileReport;
  timestamps?: {
    workerStartedAt: number;
    workerFinishedAt: number;
    workerPostedAt: number;
  };
}

interface WorkerReady {
  type: "ready";
  readyAt?: number;
}

interface WorkerFailure {
  type: "error";
  id: number;
  message: string;
}

type WorkerMessage = WorkerResult | WorkerFailure | WorkerReady;

interface WorkerState {
  createdAt: number;
  readyAt?: number;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: unknown) => void;
}

interface Pending {
  resolve: (result: MountainLayerPreparationResult) => void;
  reject: (error: unknown) => void;
  reservedBytes: number;
  queuedAtAbsolute: number;
  inputCopyMs: number;
  snapshot: MountainDEMData;
  options: MountainRenderOptions;
  vegetationGeometryOverride?: VegetationGeometry;
  mode: MountainLayerPreparationMode;
  profile: boolean;
  postedAt?: number;
  postReturnedAt?: number;
  worker?: Worker;
  timer?: ReturnType<typeof setInterval>;
}

function estimateBytes(value: unknown, seen = new Set<ArrayBuffer>()): number {
  if (!value || typeof value !== "object") return 0;
  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer;
    if (!(buffer instanceof ArrayBuffer) || seen.has(buffer)) return 0;
    seen.add(buffer);
    return buffer.byteLength;
  }
  if (value instanceof ArrayBuffer) {
    if (seen.has(value)) return 0;
    seen.add(value);
    return value.byteLength;
  }
  if (Array.isArray(value)) return value.reduce((total, item) => total + estimateBytes(item, seen), 0);
  return Object.values(value).reduce((total, child) => total + estimateBytes(child, seen), 0);
}

function estimateLayerSnapshotBytes(dem: MountainDEMData): number {
  return estimateBytes([
    dem.elevation,
    dem.normalizedElevation,
    dem.slopeDeg,
    dem.curvature,
    dem.tpi,
    dem.flowAccumulation,
    dem.drainageAreaKm2,
    dem.rainfallWeightedAreaKm2,
    dem.strahlerOrder,
    dem.riverCenterlineMask,
    dem.isRiverChannel,
    dem.riverChannelRadius,
    dem.riverMouthMask,
    dem.riverMouthAreaKm2,
    dem.flowDirection,
    dem.precipitationMmYr,
    dem.temperatureC,
    dem.biomeType,
    dem.isOcean,
    dem.lakeDepthM,
    dem.wetlandPoolMask,
    dem.visualWaterMask,
    dem.wetlandPoolCoverage,
    dem.visualWaterCoverage,
  ]);
}

function cloneArray<T extends ArrayBufferView>(value: T): T {
  return (value as unknown as { slice(): unknown }).slice() as T;
}

/** Copy only fields consumed by water/vegetation stages. The authoritative
 * DEM stays owned by the coordinator and is never transferred. */
function cloneLayerDEM(
  dem: MountainDEMData,
  waterCoverageOverride?: Float32Array,
): MountainDEMData {
  const emptyFloat = () => new Float32Array(0);
  return {
    width: dem.width,
    height: dem.height,
    domainWidthKm: dem.domainWidthKm,
    domainHeightKm: dem.domainHeightKm,
    dxMeters: dem.dxMeters,
    dyMeters: dem.dyMeters,
    minElevationM: dem.minElevationM,
    maxElevationM: dem.maxElevationM,
    oceanSurfaceElevationM: dem.oceanSurfaceElevationM,
    elevation: cloneArray(dem.elevation),
    normalizedElevation: cloneArray(dem.normalizedElevation),
    slopeDeg: cloneArray(dem.slopeDeg),
    aspectDeg: emptyFloat(),
    normals: emptyFloat(),
    hillshade: emptyFloat(),
    ambientOcclusion: emptyFloat(),
    curvature: cloneArray(dem.curvature),
    tpi: cloneArray(dem.tpi),
    flowAccumulation: cloneArray(dem.flowAccumulation),
    drainageAreaKm2: cloneArray(dem.drainageAreaKm2),
    rainfallWeightedAreaKm2: cloneArray(dem.rainfallWeightedAreaKm2),
    runoffDepthMmYr: emptyFloat(),
    dischargeM3s: emptyFloat(),
    strahlerOrder: cloneArray(dem.strahlerOrder),
    riverCenterlineMask: cloneArray(dem.riverCenterlineMask),
    isRiverChannel: cloneArray(dem.isRiverChannel),
    riverChannelRadius: dem.riverChannelRadius ? cloneArray(dem.riverChannelRadius) : undefined,
    riverMouthMask: dem.riverMouthMask ? cloneArray(dem.riverMouthMask) : undefined,
    riverMouthAreaKm2: dem.riverMouthAreaKm2 ? cloneArray(dem.riverMouthAreaKm2) : undefined,
    waterDepthM: emptyFloat(),
    flowDirection: cloneArray(dem.flowDirection),
    erosionDepthM: emptyFloat(),
    precipitationMmYr: cloneArray(dem.precipitationMmYr),
    solarInsolation: emptyFloat(),
    temperatureC: cloneArray(dem.temperatureC),
    biomeType: cloneArray(dem.biomeType),
    isOcean: cloneArray(dem.isOcean),
    lakeDepthM: dem.lakeDepthM ? cloneArray(dem.lakeDepthM) : undefined,
    wetlandPoolMask: dem.wetlandPoolMask ? cloneArray(dem.wetlandPoolMask) : undefined,
    visualWaterMask: dem.visualWaterMask ? cloneArray(dem.visualWaterMask) : undefined,
    wetlandPoolCoverage: dem.wetlandPoolCoverage ? cloneArray(dem.wetlandPoolCoverage) : undefined,
    visualWaterCoverage: waterCoverageOverride
      ? cloneArray(waterCoverageOverride)
      : dem.visualWaterCoverage
        ? cloneArray(dem.visualWaterCoverage)
        : undefined,
    siltDepth: dem.siltDepth ? cloneArray(dem.siltDepth) : undefined,
    siltCreaseDepth: dem.siltCreaseDepth ? cloneArray(dem.siltCreaseDepth) : undefined,
  };
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

function canCreateWorker(): boolean {
  return typeof Worker !== "undefined";
}

/**
 * Persistent, bounded helper workers for whole layer stages. The pool owns
 * only cloned snapshots; authoritative DEM arrays remain in the coordinator.
 */
export class MountainLayerWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly pendingByWorker = new Map<Worker, number>();
  private readonly workerStates = new Map<Worker, WorkerState>();
  private readonly pending = new Map<number, Pending>();
  private readonly maxCpuBytes: number;
  private inFlightBytes = 0;
  private peakBytes = 0;
  private nextId = 1;
  private disabled = false;
  private skipReason: "unavailable" | "cancelled" | "memory-budget" | undefined;
  private reservedBytes = 0;

  constructor(options: { maxWorkers?: number; maxCpuBytes?: number } = {}) {
    this.maxCpuBytes = options.maxCpuBytes ?? PARALLEL_LAYER_CPU_BUDGET;
    // A whole-layer preparation occupies one worker. Keep one nested worker by
    // default so startup and memory costs do not double; callers can still
    // request up to three workers for independent jobs or set zero to force
    // fallback.
    const requested = options.maxWorkers ?? 1;
    if (!canCreateWorker() || requested < 1) {
      this.disabled = true;
      return;
    }
    for (let index = 0; index < Math.min(3, requested); index++) {
      try {
        const createdAt = absoluteNow();
        let resolveReady!: () => void;
        let rejectReady!: (error: unknown) => void;
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        // Keep a failed bootstrap from becoming an unhandled rejection when
        // an export caller starts preparation without explicitly awaiting warmup.
        void ready.catch(() => undefined);
        const worker = new Worker(new URL("./mountainLayer.worker.ts", import.meta.url), {
          type: "module",
        });
        this.workerStates.set(worker, {
          createdAt,
          ready,
          resolveReady,
          rejectReady,
        });
        worker.onmessage = event => this.handleMessage(worker, event.data as WorkerMessage);
        worker.onerror = event => this.handleWorkerError(worker, event.error ?? new Error(event.message));
        this.workers.push(worker);
        this.idle.push(worker);
      } catch {
        break;
      }
    }
    if (this.workers.length === 0) this.disabled = true;
  }

  get available(): boolean {
    return !this.disabled && this.workers.length > 0;
  }

  get workerCount(): number {
    return this.disabled ? 0 : this.workers.length;
  }

  /** Explains why the most recent request did not enter the worker. */
  get lastSkipReason(): "unavailable" | "cancelled" | "memory-budget" | undefined {
    return this.skipReason;
  }

  get lastReservedBytes(): number {
    return this.reservedBytes;
  }

  get budgetBytes(): number {
    return this.maxCpuBytes;
  }

  /** Start module loading early so the first render does not pay worker boot time. */
  warmup(): Promise<void> {
    if (!this.available) return Promise.resolve();
    return Promise.all([...this.workerStates.values()].map(state => state.ready)).then(() => undefined);
  }

  get retainedBytes(): number {
    return this.inFlightBytes;
  }

  get peakTrackedBytes(): number {
    return this.peakBytes;
  }

  prepare(
    dem: MountainDEMData,
    options: MountainRenderOptions,
    control: MountainLayerWorkerControl = {},
    mode: MountainLayerPreparationMode = "all",
  ): Promise<MountainLayerPreparationResult | null> {
    this.skipReason = undefined;
    if (!this.available) {
      this.skipReason = "unavailable";
      return Promise.resolve(null);
    }
    if (control.isCancelled?.()) {
      this.skipReason = "cancelled";
      return Promise.reject(new MountainLayerWorkerCancelledError());
    }
    const sourceBytes = estimateLayerSnapshotBytes(dem);
    const optionBytes = estimateBytes(options);
    // Reserve a source snapshot and a conservative output allowance before
    // dispatch. If the cap would be exceeded, the caller deliberately stays
    // serial rather than creating a transient memory spike.
    const outputAllowance = dem.width * dem.height * (mode === "water" || mode === "all" ? 16 : 8);
    const overrideBytes = control.waterCoverageOverride?.byteLength ?? 0;
    const geometryOverrideBytes = estimateBytes(control.vegetationGeometryOverride);
    const reservedBytes = sourceBytes + optionBytes + overrideBytes + geometryOverrideBytes + outputAllowance;
    this.reservedBytes = reservedBytes;
    if (
      reservedBytes > this.maxCpuBytes
      || this.inFlightBytes + reservedBytes > this.maxCpuBytes
    ) {
      this.skipReason = "memory-budget";
      return Promise.resolve(null);
    }
    const snapshotStarted = performance.now();
    const snapshot = cloneLayerDEM(dem, control.waterCoverageOverride);
    const inputCopyMs = performance.now() - snapshotStarted;
    if (control.isCancelled?.()) return Promise.reject(new MountainLayerWorkerCancelledError());
    const id = this.nextId++;
    const queuedAtAbsolute = absoluteNow();
    this.inFlightBytes += reservedBytes;
    this.peakBytes = Math.max(this.peakBytes, this.inFlightBytes);
    return new Promise<MountainLayerPreparationResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        reservedBytes,
        queuedAtAbsolute,
        inputCopyMs,
        snapshot,
        options,
        vegetationGeometryOverride: control.vegetationGeometryOverride,
        mode,
        profile: control.profile === true,
      });
      const cancellationCheck = (): void => {
        const current = this.pending.get(id);
        if (!current) return;
        if (control.isCancelled?.()) {
          for (const worker of this.workers) {
            if (this.pendingByWorker.get(worker) === id) {
              worker.postMessage({ type: "cancel", id });
            }
          }
          this.finish(id, undefined, new MountainLayerWorkerCancelledError());
        }
      };
      const current = this.pending.get(id);
      if (current) current.timer = setInterval(cancellationCheck, 16);
      this.dispatch(id);
    });
  }

  private dispatch(id: number): void {
    // Cancellation can settle a queued request before an idle worker becomes
    // available. Do not dispatch that stale snapshot after the promise has
    // already been discarded by the coordinator.
    const pending = this.pending.get(id);
    if (!pending || pending.worker !== undefined) return;
    // Workers keep module-level caches (forest light textures, flow fields).
    // Send vegetation work to the same worker each time and water to another
    // so neither job finds the other's cold caches; any ready worker still
    // serves as a fallback.
    const isReady = (worker: Worker): boolean => this.workerStates.get(worker)?.readyAt !== undefined;
    const preferred = this.preferredWorker(pending);
    const preferredIndex = isReady(preferred) ? this.idle.indexOf(preferred) : -1;
    let workerIndex = preferredIndex >= 0 ? preferredIndex : this.idle.findIndex(isReady);
    // Leave a ready worker to a queued job that prefers it (both halves of a
    // split preparation queue up while the workers boot).
    if (preferredIndex < 0 && workerIndex >= 0) {
      const fallback = this.idle[workerIndex];
      const reserved = [...this.pending.values()].some(other =>
        other !== pending && other.worker === undefined && this.preferredWorker(other) === fallback);
      if (reserved) workerIndex = -1;
    }
    const worker = workerIndex >= 0 ? this.idle.splice(workerIndex, 1)[0] : undefined;
    if (!worker) {
      // A single rendering worker normally has one request in flight. Keep a
      // small queue for callers that share the pool rather than silently
      // exceeding the memory reservation.
      if (this.workers.length === 0) {
        this.finish(id, undefined, new Error("Parallel layer worker pool unavailable"));
      } else {
        setTimeout(() => this.dispatch(id), 8);
      }
      return;
    }
    this.pendingByWorker.set(worker, id);
    pending.worker = worker;
    try {
      const transfers: Transferable[] = [];
      collectTransferables(pending.snapshot, transfers, new Set<ArrayBuffer>());
      pending.postedAt = absoluteNow();
      worker.postMessage({
        type: "prepare",
        id,
        dem: pending.snapshot,
        options: pending.options,
        vegetationGeometryOverride: pending.vegetationGeometryOverride,
        mode: pending.mode,
        profile: pending.profile,
      }, transfers);
      pending.postReturnedAt = absoluteNow();
    } catch (error) {
      this.idle.push(worker);
      this.pendingByWorker.delete(worker);
      this.finish(id, undefined, error);
      setTimeout(() => this.dispatchQueued(), 0);
    }
  }

  private preferredWorker(pending: Pending): Worker {
    const last = this.workers.length - 1;
    switch (pending.mode) {
      case "water": return this.workers[0];
      case "vegetationFlow": return this.workers[Math.min(1, last)];
      case "vegetationProps": return this.workers[Math.min(2, last)];
      default: return this.workers[last];
    }
  }

  private dispatchQueued(): void {
    // Offer each queued request one dispatch attempt; a request can decline a
    // ready worker that another queued request prefers.
    for (const [id, pending] of [...this.pending.entries()]) {
      if (!this.idle.some(worker => this.workerStates.get(worker)?.readyAt !== undefined)) return;
      if (pending.worker === undefined) this.dispatch(id);
    }
  }

  private handleMessage(worker: Worker, message: WorkerMessage): void {
    if (!message) return;
    if (message.type === "ready") {
      const state = this.workerStates.get(worker);
      if (!state || state.readyAt !== undefined) return;
      state.readyAt = message.readyAt ?? absoluteNow();
      state.resolveReady();
      this.dispatchQueued();
      return;
    }
    if (typeof message.id !== "number") return;
    const receivedAtAbsolute = absoluteNow();
    const pending = this.pending.get(message.id);
    this.pendingByWorker.delete(worker);
    if (!this.idle.includes(worker)) this.idle.push(worker);
    if (message.type === "error") {
      this.finish(message.id, undefined, new Error(message.message));
      this.dispatchQueued();
      return;
    }
    const state = this.workerStates.get(worker);
    const workerStartedAt = message.timestamps?.workerStartedAt;
    const workerPostedAt = message.timestamps?.workerPostedAt;
    const transportTimings = pending
      ? deriveMountainLayerTransferTimings({
          queuedAt: pending.queuedAtAbsolute,
          postedAt: pending.postedAt,
          postReturnedAt: pending.postReturnedAt,
          workerStartedAt,
          workerPostedAt,
          receivedAt: receivedAtAbsolute,
          workerMs: message.timings.totalMs,
        })
      : {};
    const resultHandlingStarted = performance.now();
    const bootstrapMs = state?.readyAt !== undefined && state
      ? Math.max(0, state.readyAt - state.createdAt)
      : undefined;
    this.finish(message.id, {
      mode: message.mode,
      waterGeometry: message.waterGeometry,
      waterOverlay: message.waterOverlay,
      vegetationGeometry: message.vegetationGeometry,
      vegetationOverlay: message.vegetationOverlay,
      timings: {
        ...message.timings,
        wallMs: transportTimings.wallMs ?? message.timings.totalMs,
        inputCopyMs: pending?.inputCopyMs,
        bootstrapMs,
        inputTransferMs: transportTimings.inputTransferMs,
        workerSchedulingMs: transportTimings.workerSchedulingMs,
        outputTransferMs: transportTimings.outputTransferMs,
        resultHandlingMs: Math.max(0, performance.now() - resultHandlingStarted),
        workerComputationMs: message.timings.totalMs,
        // Keep the aggregate for existing consumers while exposing the
        // distinct phases above.
        queueMs: transportTimings.queueMs,
      },
      timestamps: {
        workerCreatedAt: state?.createdAt,
        workerReadyAt: state?.readyAt,
        queuedAt: pending?.queuedAtAbsolute,
        postedAt: pending?.postedAt,
        postReturnedAt: pending?.postReturnedAt,
        workerStartedAt,
        workerFinishedAt: message.timestamps?.workerFinishedAt,
        workerPostedAt,
        receivedAt: receivedAtAbsolute,
      },
      profile: message.profile,
    });
    this.dispatchQueued();
  }

  private handleWorkerError(worker: Worker, error: unknown): void {
    const id = this.pendingByWorker.get(worker);
    this.pendingByWorker.delete(worker);
    const state = this.workerStates.get(worker);
    state?.rejectReady(error);
    this.workerStates.delete(worker);
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    try { worker.terminate(); } catch { /* already stopped */ }
    if (id !== undefined) this.finish(id, undefined, error);
    if (this.workers.length === 0) {
      this.disabled = true;
      // Requests can be queued while the module is still booting. If the
      // last worker fails before receiving one, settle those requests too so
      // the coordinator can enter its synchronous fallback path.
      for (const [pendingId] of this.pending) {
        this.finish(pendingId, undefined, error);
      }
    } else {
      this.dispatchQueued();
    }
  }

  private finish(
    id: number,
    result: MountainLayerPreparationResult | undefined,
    error?: unknown,
  ): void {
    const current = this.pending.get(id);
    if (!current) return;
    this.pending.delete(id);
    this.inFlightBytes = Math.max(0, this.inFlightBytes - current.reservedBytes);
    if (current.timer !== undefined) clearInterval(current.timer);
    if (error !== undefined) current.reject(error);
    else if (result) current.resolve(result);
  }

  dispose(): void {
    for (const worker of this.workers) {
      try { worker.terminate(); } catch { /* already stopped */ }
    }
    this.workers.length = 0;
    this.idle.length = 0;
    this.disabled = true;
    for (const [id, current] of this.pending) {
      if (current.timer !== undefined) clearInterval(current.timer);
      current.reject(new Error("Parallel layer worker pool disposed"));
      this.pending.delete(id);
    }
    this.pendingByWorker.clear();
    for (const state of this.workerStates.values()) state.rejectReady(new Error("Parallel layer worker pool disposed"));
    this.workerStates.clear();
    this.inFlightBytes = 0;
    this.peakBytes = 0;
  }
}

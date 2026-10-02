/**
 * Lightweight opt-in timing for the mountain preview and export pipelines.
 *
 * The profiler is deliberately independent of render options and cache keys.
 * When disabled, begin/measure calls return without allocating timing records
 * so normal rendering keeps the same work and output.
 */

export interface MountainProfileStage {
  stage: string;
  durationMs: number;
  selfMs: number;
  averageMs: number;
  minMs: number;
  maxMs: number;
  calls: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface MountainProfileMetric {
  metric: string;
  unit: string;
  samples: number;
  total: number;
  average: number;
  min: number;
  max: number;
}

export interface MountainProfileReport {
  requestId?: number | string;
  width?: number;
  height?: number;
  layer?: string;
  changedSettings?: string[];
  status: "completed" | "cancelled" | "failed";
  totalMs: number;
  /** Monotonic worker-clock bounds used when merging overlapping tasks. */
  startedAt?: number;
  endedAt?: number;
  taskId?: string | number;
  stages: MountainProfileStage[];
  metrics: MountainProfileMetric[];
}

export interface MountainProfileTaskReport {
  taskId: string | number;
  startedAt: number;
  endedAt: number;
  report: MountainProfileReport;
}

export interface MountainProfileMetadata {
  requestId?: number | string;
  width?: number;
  height?: number;
  layer?: string;
  changedSettings?: string[];
  [key: string]: unknown;
}

interface ActiveTimer {
  stage: string;
  started: number;
  childMs: number;
  stopped: boolean;
}

interface MutableStage extends MountainProfileStage {
  selfTotalMs: number;
}

type MutableMetric = MountainProfileMetric;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function getStage(map: Map<string, MutableStage>, stage: string): MutableStage {
  const existing = map.get(stage);
  if (existing) return existing;
  const created: MutableStage = {
    stage,
    durationMs: 0,
    selfMs: 0,
    selfTotalMs: 0,
    averageMs: 0,
    minMs: Infinity,
    maxMs: 0,
    calls: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  map.set(stage, created);
  return created;
}

/** Add a non-timed metric to a report, useful for tile-size distributions. */
export function addMountainProfileMetric(
  report: MountainProfileReport,
  metric: string,
  value: number,
  unit = "",
): void {
  let entry = report.metrics.find(candidate => candidate.metric === metric && candidate.unit === unit);
  if (!entry) {
    entry = {
      metric,
      unit,
      samples: 0,
      total: 0,
      average: 0,
      min: Infinity,
      max: -Infinity,
    };
    report.metrics.push(entry);
  }
  entry.samples++;
  entry.total += value;
  entry.average = entry.total / entry.samples;
  entry.min = Math.min(entry.min, value);
  entry.max = Math.max(entry.max, value);
}

/** Add a completed timing sample after a worker has handed its report off. */
export function addMountainProfileStage(
  report: MountainProfileReport,
  stage: string,
  durationMs: number,
): void {
  const existing = report.stages.find(candidate => candidate.stage === stage);
  if (existing) {
    existing.calls++;
    existing.durationMs += durationMs;
    existing.selfMs += durationMs;
    existing.averageMs = existing.durationMs / existing.calls;
    existing.minMs = Math.min(existing.minMs, durationMs);
    existing.maxMs = Math.max(existing.maxMs, durationMs);
    return;
  }
  report.stages.push({
    stage,
    durationMs,
    selfMs: durationMs,
    averageMs: durationMs,
    minMs: durationMs,
    maxMs: durationMs,
    calls: 1,
    cacheHits: 0,
    cacheMisses: 0,
  });
}

/**
 * Merge independently timed worker reports without adding overlapping wall
 * durations. Stage and metric samples are still aggregated for diagnostics;
 * the merged elapsed time is the union of the task clock intervals.
 */
export function mergeMountainProfileReports(
  reports: readonly MountainProfileReport[],
): MountainProfileReport | undefined {
  if (reports.length === 0) return undefined;
  const first = reports[0];
  const merged: MountainProfileReport = {
    ...first,
    totalMs: 0,
    startedAt: Math.min(...reports.map(report => report.startedAt ?? 0)),
    endedAt: Math.max(...reports.map(report => report.endedAt ?? report.totalMs)),
    stages: [],
    metrics: [],
  };
  for (const report of reports) {
    for (const stage of report.stages) {
      const entry = merged.stages.find(candidate => candidate.stage === stage.stage);
      if (!entry) {
        merged.stages.push({ ...stage });
      } else {
        entry.durationMs += stage.durationMs;
        entry.selfMs += stage.selfMs;
        entry.calls += stage.calls;
        entry.cacheHits += stage.cacheHits;
        entry.cacheMisses += stage.cacheMisses;
        entry.averageMs = entry.durationMs / Math.max(1, entry.calls);
        entry.minMs = Math.min(entry.minMs, stage.minMs);
        entry.maxMs = Math.max(entry.maxMs, stage.maxMs);
      }
    }
    for (const metric of report.metrics) {
      const entry = merged.metrics.find(candidate =>
        candidate.metric === metric.metric && candidate.unit === metric.unit,
      );
      if (!entry) merged.metrics.push({ ...metric });
      else {
        entry.samples += metric.samples;
        entry.total += metric.total;
        entry.average = entry.total / Math.max(1, entry.samples);
        entry.min = Math.min(entry.min, metric.min);
        entry.max = Math.max(entry.max, metric.max);
      }
    }
  }
  const starts = reports.map(report => report.startedAt).filter((value): value is number => value !== undefined);
  const ends = reports.map(report => report.endedAt).filter((value): value is number => value !== undefined);
  merged.totalMs = starts.length > 0 && ends.length > 0
    ? Math.max(0, Math.max(...ends) - Math.min(...starts))
    : Math.max(...reports.map(report => report.totalMs));
  return merged;
}

/** Print a report in a compact, collapsed console group. */
export function logMountainProfileReport(report: MountainProfileReport): void {
  if (typeof console === "undefined") return;
  const label = `Mountain profile #${report.requestId ?? "?"} (${report.status})`;
  const group = console.groupCollapsed ?? console.group;
  group.call(console, label);
  const diagnostics = Object.fromEntries(
    Object.entries(report).filter(([key]) => /^(mountainGpu|mountainField|parallelLayer|gpu)/.test(key)),
  );
  const details = Object.fromEntries(
    Object.entries(report).filter(([key]) => ![
      "requestId", "width", "height", "layer", "changedSettings", "status",
      "totalMs", "startedAt", "endedAt", "taskId", "stages", "metrics",
    ].includes(key)),
  );
  console.log({
    requestId: report.requestId,
    dimensions: report.width !== undefined && report.height !== undefined
      ? `${report.width}x${report.height}`
      : undefined,
    layer: report.layer,
    changedSettings: report.changedSettings ?? [],
    totalMs: Number(report.totalMs.toFixed(2)),
    details,
    ...diagnostics,
  });
  console.table(report.stages.map(stage => ({
    stage: stage.stage,
    durationMs: Number(stage.durationMs.toFixed(2)),
    selfMs: Number(stage.selfMs.toFixed(2)),
    averageMs: Number(stage.averageMs.toFixed(2)),
    minMs: Number(stage.minMs.toFixed(2)),
    maxMs: Number(stage.maxMs.toFixed(2)),
    calls: stage.calls,
    cacheHits: stage.cacheHits,
    cacheMisses: stage.cacheMisses,
  })));
  if (report.metrics.length > 0) {
    console.table(report.metrics.map(metric => ({
      metric: metric.metric,
      unit: metric.unit,
      samples: metric.samples,
      total: Number(metric.total.toFixed(2)),
      average: Number(metric.average.toFixed(2)),
      min: Number(metric.min.toFixed(2)),
      max: Number(metric.max.toFixed(2)),
    })));
  }
  (console.groupEnd ?? (() => undefined)).call(console);
}

/** Return the keys whose serialized value changed between two snapshots. */
export function diffMountainProfileSettings(
  previous: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
): string[] {
  if (!previous) return Object.keys(current).sort();
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...keys].filter(key => JSON.stringify(previous[key]) !== JSON.stringify(current[key])).sort();
}

export class MountainProfiler {
  readonly enabled: boolean;
  private started: number;
  private metadata: MountainProfileMetadata;
  private readonly stages = new Map<string, MutableStage>();
  private readonly metrics = new Map<string, MutableMetric>();
  private readonly stack: ActiveTimer[] = [];
  private completedReport: MountainProfileReport | undefined;

  constructor(enabled: boolean, metadata: MountainProfileMetadata = {}) {
    this.enabled = enabled;
    this.started = enabled ? now() : 0;
    this.metadata = { ...metadata };
  }

  /** Start a fresh request on a reusable profiler after the prior report ends. */
  reset(metadata: MountainProfileMetadata = this.metadata): void {
    this.started = this.enabled ? now() : 0;
    this.metadata = { ...metadata };
    this.stages.clear();
    this.metrics.clear();
    this.stack.length = 0;
    this.completedReport = undefined;
  }

  setMetadata(metadata: MountainProfileMetadata): void {
    if (!this.enabled) return;
    Object.assign(this.metadata, metadata);
  }

  private stopTimer(timer: ActiveTimer): void {
    if (timer.stopped) return;
    timer.stopped = true;
    const durationMs = Math.max(0, now() - timer.started);
    const index = this.stack.lastIndexOf(timer);
    if (index >= 0) this.stack.splice(index, 1);
    const stageEntry = getStage(this.stages, timer.stage);
    stageEntry.durationMs += durationMs;
    stageEntry.selfTotalMs += Math.max(0, durationMs - timer.childMs);
    stageEntry.selfMs = stageEntry.selfTotalMs;
    stageEntry.averageMs = stageEntry.durationMs / Math.max(1, stageEntry.calls);
    stageEntry.minMs = Math.min(stageEntry.minMs, durationMs);
    stageEntry.maxMs = Math.max(stageEntry.maxMs, durationMs);
    const parent = this.stack[this.stack.length - 1];
    if (parent) parent.childMs += durationMs;
  }

  /** Start a nested timer. The returned callback is safe to call once. */
  begin(stage: string): () => void {
    if (!this.enabled) return () => undefined;
    const timer: ActiveTimer = { stage, started: now(), childMs: 0, stopped: false };
    const entry = getStage(this.stages, stage);
    entry.calls++;
    this.stack.push(timer);
    return () => {
      this.stopTimer(timer);
    };
  }

  measure<T>(stage: string, callback: () => T): T {
    const stop = this.begin(stage);
    try {
      return callback();
    } finally {
      stop();
    }
  }

  async measureAsync<T>(stage: string, callback: () => Promise<T>): Promise<T> {
    const stop = this.begin(stage);
    try {
      return await callback();
    } finally {
      stop();
    }
  }

  recordCache(stage: string, hit: boolean): void {
    if (!this.enabled) return;
    const entry = getStage(this.stages, stage);
    if (hit) entry.cacheHits++;
    else entry.cacheMisses++;
  }

  recordMetric(metric: string, value: number, unit = ""): void {
    if (!this.enabled || !Number.isFinite(value)) return;
    const key = `${metric}\u0000${unit}`;
    const existing = this.metrics.get(key);
    if (existing) {
      existing.samples++;
      existing.total += value;
      existing.average = existing.total / existing.samples;
      existing.min = Math.min(existing.min, value);
      existing.max = Math.max(existing.max, value);
      return;
    }
    this.metrics.set(key, {
      metric,
      unit,
      samples: 1,
      total: value,
      average: value,
      min: value,
      max: value,
    });
  }

  /** Record work measured by a helper worker without disturbing this timer stack. */
  recordExternalStage(stage: string, durationMs: number, calls = 1): void {
    if (!this.enabled || !Number.isFinite(durationMs) || calls <= 0) return;
    const entry = getStage(this.stages, stage);
    entry.calls += calls;
    entry.durationMs += durationMs;
    entry.selfTotalMs += durationMs;
    entry.selfMs = entry.selfTotalMs;
    entry.averageMs = entry.durationMs / Math.max(1, entry.calls);
    entry.minMs = Math.min(entry.minMs, durationMs);
    entry.maxMs = Math.max(entry.maxMs, durationMs);
  }

  report(status: MountainProfileReport["status"] = "completed"): MountainProfileReport | undefined {
    if (!this.enabled) return undefined;
    if (this.completedReport) return this.completedReport;
    // A worker may be cancelled or throw while a coarse stage is active. Close
    // those timers so the report still describes work completed up to that
    // point instead of silently dropping the in-flight stage.
    while (this.stack.length > 0) this.stopTimer(this.stack[this.stack.length - 1]);
    this.completedReport = {
      ...this.metadata,
      status,
      totalMs: Math.max(0, now() - this.started),
      startedAt: this.started,
      endedAt: now(),
      stages: [...this.stages.values()].map(({ selfTotalMs: _selfTotalMs, ...stage }) => ({
        ...stage,
        minMs: Number.isFinite(stage.minMs) ? stage.minMs : 0,
      })),
      metrics: [...this.metrics.values()].map(metric => ({ ...metric })),
    };
    return this.completedReport;
  }

  finish(status: MountainProfileReport["status"] = "completed", emit = true): MountainProfileReport | undefined {
    const result = this.report(status);
    if (result && emit) logMountainProfileReport(result);
    return result;
  }
}

export function createMountainProfiler(
  enabled: boolean,
  metadata: MountainProfileMetadata = {},
): MountainProfiler | undefined {
  return enabled ? new MountainProfiler(true, metadata) : undefined;
}

/**
 * Benchmark harness for the GPU mountain field and wind passes against the CPU versions.
 */
import { smoothMountainField } from './mountainPatternRenderer';
import {
  createMountainFieldGpuSession,
  type MountainFieldGpuOptions,
  type MountainFieldGpuReport,
  type MountainFieldGpuSources,
} from './mountainFieldGpu';
import { buildMountainWindFields } from './mountainIllustrationRenderer';
import type { MountainDEMData } from '../terrain/mountainBaseDEM';

export interface MountainWindBenchmarkInput {
  width: number;
  height: number;
  elevation: Float32Array;
  dxMeters: number;
  dyMeters: number;
  windAzimuthDeg: number;
}

export interface MountainWindBenchmarkReport {
  supported: boolean;
  reason?: string;
  initializationMs: number;
  cpuMs?: number;
  gpu?: MountainFieldGpuReport;
  maxAbsError?: number;
  numericalGatePassed?: boolean;
}

export function createMountainWindBenchmarkInput(
  width: number,
  height: number,
): MountainWindBenchmarkInput {
  const safeWidth = Math.max(2, Math.floor(width));
  const safeHeight = Math.max(2, Math.floor(height));
  const elevation = new Float32Array(safeWidth * safeHeight);
  for (let y = 0; y < safeHeight; y++) {
    for (let x = 0; x < safeWidth; x++) {
      const nx = x / Math.max(1, safeWidth - 1);
      const ny = y / Math.max(1, safeHeight - 1);
      elevation[y * safeWidth + x] =
        Math.sin(nx * 8) * 90 + Math.cos(ny * 5) * 55 + nx * 240 + ny * 80;
    }
  }
  return {
    width: safeWidth,
    height: safeHeight,
    elevation,
    dxMeters: 24,
    dyMeters: 27,
    windAzimuthDeg: 225,
  };
}

function windBenchmarkDem(input: MountainWindBenchmarkInput): MountainDEMData {
  const total = input.width * input.height;
  const zeroFloat = () => new Float32Array(total);
  const zeroByte = () => new Uint8Array(total);
  return {
    width: input.width,
    height: input.height,
    domainWidthKm: input.width * input.dxMeters / 1000,
    domainHeightKm: input.height * input.dyMeters / 1000,
    dxMeters: input.dxMeters,
    dyMeters: input.dyMeters,
    minElevationM: -200,
    maxElevationM: 500,
    elevation: input.elevation,
    normalizedElevation: zeroFloat(),
    slopeDeg: zeroFloat(),
    aspectDeg: zeroFloat(),
    normals: new Float32Array(total * 3),
    hillshade: zeroFloat(),
    ambientOcclusion: zeroFloat(),
    curvature: zeroFloat(),
    tpi: zeroFloat(),
    flowAccumulation: zeroFloat(),
    drainageAreaKm2: zeroFloat(),
    rainfallWeightedAreaKm2: zeroFloat(),
    runoffDepthMmYr: zeroFloat(),
    dischargeM3s: zeroFloat(),
    strahlerOrder: zeroByte(),
    riverCenterlineMask: zeroByte(),
    isRiverChannel: zeroByte(),
    waterDepthM: zeroFloat(),
    flowDirection: new Int8Array(total).fill(-1),
    erosionDepthM: zeroFloat(),
    precipitationMmYr: zeroFloat(),
    solarInsolation: zeroFloat(),
    temperatureC: zeroFloat(),
    biomeType: zeroByte(),
    isOcean: zeroByte(),
  };
}

function windMaximumError(
  actual: { windShelter: Float32Array; windLoading: Float32Array; slopeBreak: Float32Array },
  expected: { windShelter: Float32Array; windLoading: Float32Array; slopeBreak: Float32Array },
): number {
  let maximum = 0;
  for (const key of ['windShelter', 'windLoading', 'slopeBreak'] as const) {
    const left = actual[key];
    const right = expected[key];
    for (let index = 0; index < right.length; index++) {
      maximum = Math.max(maximum, Math.abs(left[index] - right[index]));
    }
  }
  return maximum;
}

export interface MountainFieldBenchmarkInput extends MountainFieldGpuSources {
  radii: {
    lighting: number;
    relief: number;
    rib: number;
    crease: number;
    footprint: number;
    lineworkFootprint: number;
    snowRidge: number;
  };
}

export interface MountainFieldBenchmarkOptions extends MountainFieldGpuOptions {
  warmupRuns?: number;
  measuredRuns?: number;
}

export interface MountainFieldBenchmarkRun {
  totalMs: number;
  uploadMs: number;
  computeMs: number;
  readbackMs: number;
  tileCount: number;
  retainedGpuBytes: number;
  peakGpuBytes?: number;
  maxAbsError: number;
}

export interface MountainFieldBenchmarkReport {
  supported: boolean;
  reason?: string;
  initializationMs: number;
  /** CPU warm-up is excluded from this cold-start value. */
  cpuWarmupMs: number;
  cpuRuns: number[];
  medianCpuTotalMs: number;
  cpuReferenceMs: number;
  cpuReferenceFields: number;
  /** Device initialization plus the first GPU preparation. */
  coldGpuTotalMs?: number;
  gpuRuns: MountainFieldBenchmarkRun[];
  medianGpuTotalMs?: number;
  medianGpuPreparationMs?: number;
  maxAbsError?: number;
  numericalLimit?: number;
  numericalGatePassed?: boolean;
  visualGate: 'not-run';
  gpu?: MountainFieldGpuReport;
}

export function createMountainFieldBenchmarkInput(
  width: number,
  height: number,
): MountainFieldBenchmarkInput {
  const safeWidth = Math.max(2, Math.floor(width));
  const safeHeight = Math.max(2, Math.floor(height));
  const total = safeWidth * safeHeight;
  const lightingElevation = new Float32Array(total);
  const reliefElevation = new Float32Array(total);
  const ridgeInk = new Uint8Array(total);
  const ink = new Uint8Array(total);
  const coverage = new Uint8Array(total);
  const lineworkCoverage = new Uint8Array(total);
  for (let y = 0; y < safeHeight; y++) {
    for (let x = 0; x < safeWidth; x++) {
      const index = y * safeWidth + x;
      const nx = x / Math.max(1, safeWidth - 1);
      const ny = y / Math.max(1, safeHeight - 1);
      const ridge = Math.exp(-((nx - 0.48) ** 2) * 32) * Math.exp(-((ny - 0.5) ** 2) * 8);
      lightingElevation[index] = 0.2 + nx * 0.3 + ny * 0.2 + ridge * 0.45;
      reliefElevation[index] = 0.1 + nx * 0.35 + ny * 0.25 + ridge * 0.55;
      ridgeInk[index] = Math.round(255 * Math.min(1, ridge * 1.8));
      ink[index] = (x * 19 + y * 37) & 255;
      const land = nx > 0.04 && nx < 0.96 && ny > 0.05;
      coverage[index] = land ? 255 : 0;
      lineworkCoverage[index] = land && ridge > 0.02 ? 255 : 0;
    }
  }
  return {
    width: safeWidth,
    height: safeHeight,
    lightingElevation,
    reliefElevation,
    ridgeInk,
    ink,
    coverage,
    lineworkCoverage,
    radii: {
      lighting: 3.5,
      relief: 13,
      rib: 3,
      crease: 4.5,
      footprint: 1,
      lineworkFootprint: 1,
      snowRidge: 5.5,
    },
  };
}

function clock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function normalize(source: ArrayLike<number>): Float32Array {
  return Float32Array.from(source, value => value / 255);
}

function cpuReference(input: MountainFieldBenchmarkInput): {
  fields: Record<string, Float32Array>;
  elapsedMs: number;
} {
  const started = clock();
  const fields: Record<string, Float32Array> = {
    lightingElevation: smoothMountainField(
      input.lightingElevation,
      input.width,
      input.height,
      input.radii.lighting,
    ),
    reliefReference: smoothMountainField(
      input.reliefElevation,
      input.width,
      input.height,
      input.radii.relief,
    ),
    ribField: smoothMountainField(
      normalize(input.ridgeInk),
      input.width,
      input.height,
      input.radii.rib,
    ),
    creaseField: smoothMountainField(
      normalize(input.ink),
      input.width,
      input.height,
      input.radii.crease,
    ),
    footprint: smoothMountainField(
      normalize(input.coverage),
      input.width,
      input.height,
      input.radii.footprint,
    ),
    lineworkFootprint: smoothMountainField(
      normalize(input.lineworkCoverage),
      input.width,
      input.height,
      input.radii.lineworkFootprint,
    ),
    snowRidgeField: smoothMountainField(
      normalize(input.ridgeInk),
      input.width,
      input.height,
      input.radii.snowRidge,
    ),
  };
  return { fields, elapsedMs: clock() - started };
}

function maxError(
  actual: Record<string, Float32Array>,
  expected: Record<string, Float32Array>,
): number {
  let maximum = 0;
  for (const key of Object.keys(expected)) {
    const left = actual[key];
    const right = expected[key];
    if (!left || left.length !== right.length) return Infinity;
    for (let index = 0; index < right.length; index++) {
      maximum = Math.max(maximum, Math.abs(left[index] - right[index]));
    }
  }
  return maximum;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function sourceValueRange(input: MountainFieldBenchmarkInput): number {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const source of [
    input.lightingElevation,
    input.reliefElevation,
    input.ridgeInk,
    input.ink,
    input.coverage,
    input.lineworkCoverage,
  ]) {
    for (let index = 0; index < source.length; index++) {
      const value = Number(source[index]);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  return Number.isFinite(minimum) && Number.isFinite(maximum) ? maximum - minimum : 1;
}

/**
 * Browser/worker benchmark for the bounded WebGPU experiment. It includes
 * upload and readback in the decision numbers and never changes the default
 * CPU preview or export path.
 */
export async function runMountainFieldGpuBenchmark(
  input: MountainFieldBenchmarkInput,
  options: MountainFieldBenchmarkOptions = {},
): Promise<MountainFieldBenchmarkReport> {
  const warmupRuns = Math.max(1, Math.floor(options.warmupRuns ?? 1));
  const measuredRuns = Math.max(1, Math.floor(options.measuredRuns ?? 3));
  let cpuReferenceFields: Record<string, Float32Array> | undefined;
  let cpuWarmupMs = 0;
  for (let run = 0; run < warmupRuns; run++) {
    const warmup = cpuReference(input);
    cpuWarmupMs += warmup.elapsedMs;
    if (!cpuReferenceFields) cpuReferenceFields = warmup.fields;
  }
  const cpuRuns: number[] = [];
  for (let run = 0; run < measuredRuns; run++) {
    const measured = cpuReference(input);
    cpuRuns.push(measured.elapsedMs);
    if (!cpuReferenceFields) cpuReferenceFields = measured.fields;
  }
  const medianCpuTotalMs = median(cpuRuns) ?? cpuWarmupMs / warmupRuns;
  const referenceFields = cpuReferenceFields ?? cpuReference(input).fields;
  const initializationStarted = clock();
  let initializationMs = 0;
  let session: Awaited<ReturnType<typeof createMountainFieldGpuSession>> = null;
  try {
    session = await createMountainFieldGpuSession(options);
    if (!session) {
      return {
        supported: false,
        reason: 'WebGPU is unavailable',
        initializationMs: clock() - initializationStarted,
        cpuWarmupMs,
        cpuRuns,
        medianCpuTotalMs,
        cpuReferenceMs: medianCpuTotalMs,
        cpuReferenceFields: Object.keys(referenceFields).length,
        gpuRuns: [],
        visualGate: 'not-run',
      };
    }
    initializationMs = clock() - initializationStarted;
    let lastReport: MountainFieldGpuReport | undefined;
    let coldGpuTotalMs: number | undefined;
    for (let run = 0; run < warmupRuns; run++) {
      const result = await session.prepare(input, input.radii);
      lastReport = result.report;
      if (coldGpuTotalMs === undefined) {
        coldGpuTotalMs = initializationMs + result.report.totalMs;
      }
    }
    const gpuRuns: MountainFieldBenchmarkRun[] = [];
    for (let run = 0; run < measuredRuns; run++) {
      const result = await session.prepare(input, input.radii);
      const fields: Record<string, Float32Array> = {
        lightingElevation: result.fields.lightingElevation,
        reliefReference: result.fields.reliefReference,
        ribField: result.fields.ribField,
        creaseField: result.fields.creaseField,
        footprint: result.fields.footprint,
        lineworkFootprint: result.fields.lineworkFootprint,
        snowRidgeField: result.fields.snowRidgeField,
      };
      gpuRuns.push({
        totalMs: result.report.totalMs,
        uploadMs: result.report.uploadMs,
        computeMs: result.report.computeMs,
        readbackMs: result.report.readbackMs,
        tileCount: result.report.tileCount,
        retainedGpuBytes: result.report.retainedGpuBytes,
        peakGpuBytes: result.report.peakGpuBytes,
        maxAbsError: maxError(fields, referenceFields),
      });
      lastReport = result.report;
    }
    const maxAbs = Math.max(...gpuRuns.map(run => run.maxAbsError));
    const numericalLimit = 1e-4 * Math.max(1, sourceValueRange(input));
    return {
      supported: true,
      initializationMs,
      cpuWarmupMs,
      cpuRuns,
      medianCpuTotalMs,
      cpuReferenceMs: medianCpuTotalMs,
      cpuReferenceFields: Object.keys(referenceFields).length,
      coldGpuTotalMs,
      gpuRuns,
      medianGpuTotalMs: median(gpuRuns.map(run => run.totalMs)),
      medianGpuPreparationMs: median(gpuRuns.map(run => run.computeMs + run.readbackMs + run.uploadMs)),
      maxAbsError: maxAbs,
      numericalLimit,
      numericalGatePassed: maxAbs <= numericalLimit,
      visualGate: 'not-run',
      gpu: lastReport,
    };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
      initializationMs: initializationMs || clock() - initializationStarted,
      cpuWarmupMs,
      cpuRuns,
      medianCpuTotalMs,
      cpuReferenceMs: medianCpuTotalMs,
      cpuReferenceFields: Object.keys(referenceFields).length,
      gpuRuns: [],
      visualGate: 'not-run',
    };
  } finally {
    session?.destroy();
  }
}

/** Browser benchmark for the bounded GPU wind-field workload. */
export async function runMountainWindGpuBenchmark(
  input: MountainWindBenchmarkInput,
  options: MountainFieldGpuOptions = {},
): Promise<MountainWindBenchmarkReport> {
  const initializationStarted = clock();
  let session: Awaited<ReturnType<typeof createMountainFieldGpuSession>> = null;
  const cpuStarted = clock();
  const cpuFields = buildMountainWindFields(windBenchmarkDem(input), input.windAzimuthDeg);
  const cpuMs = clock() - cpuStarted;
  try {
    session = await createMountainFieldGpuSession(options);
    if (!session?.prepareWindFields) {
      return {
        supported: false,
        reason: 'WebGPU wind preparation is unavailable',
        initializationMs: clock() - initializationStarted,
        cpuMs,
      };
    }
    const result = await session.prepareWindFields(input, {});
    const maxAbsError = windMaximumError(result.fields, cpuFields);
    return {
      supported: true,
      initializationMs: clock() - initializationStarted,
      cpuMs,
      gpu: result.report,
      maxAbsError,
      numericalGatePassed: maxAbsError <= 1e-4,
    };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
      initializationMs: clock() - initializationStarted,
      cpuMs,
    };
  } finally {
    session?.destroy();
  }
}

export function createMountainFieldGpuBenchmarkWorker(): Worker {
  return new Worker(new URL('./mountainFieldGpuBenchmark.worker.ts', import.meta.url), {
    type: 'module',
  });
}

/** Run the same benchmark off the UI thread in a browser page. */
export function runMountainFieldGpuBenchmarkInWorker(
  input: MountainFieldBenchmarkInput,
  options: MountainFieldBenchmarkOptions = {},
): Promise<MountainFieldBenchmarkReport> {
  const worker = createMountainFieldGpuBenchmarkWorker();
  const id = Math.floor(Math.random() * 0x7fffffff);
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{
      type: 'result' | 'error';
      id: number;
      report?: MountainFieldBenchmarkReport;
      message?: string;
    }>) => {
      if (event.data.id !== id) return;
      worker.terminate();
      if (event.data.type === 'result' && event.data.report) resolve(event.data.report);
      else reject(new Error(event.data.message ?? 'Mountain field GPU benchmark failed'));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'Mountain field GPU benchmark worker failed'));
    };
    const transferable: ArrayBuffer[] = [];
    const addTransfer = (source: ArrayLike<number>): void => {
      if (!ArrayBuffer.isView(source)) return;
      const buffer = source.buffer;
      if (buffer instanceof ArrayBuffer && !transferable.includes(buffer)) transferable.push(buffer);
    };
    addTransfer(input.lightingElevation);
    addTransfer(input.reliefElevation);
    addTransfer(input.ridgeInk);
    addTransfer(input.ink);
    addTransfer(input.coverage);
    addTransfer(input.lineworkCoverage);
    worker.postMessage({ type: 'benchmark', id, input, options }, transferable);
  });
}

/** Run the wind benchmark in the browser worker used by the field harness. */
export function runMountainWindGpuBenchmarkInWorker(
  input: MountainWindBenchmarkInput,
  options: MountainFieldGpuOptions = {},
): Promise<MountainWindBenchmarkReport> {
  const worker = createMountainFieldGpuBenchmarkWorker();
  const id = Math.floor(Math.random() * 0x7fffffff);
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{
      type: 'result' | 'error';
      id: number;
      report?: MountainWindBenchmarkReport;
      message?: string;
    }>) => {
      if (event.data.id !== id) return;
      worker.terminate();
      if (event.data.type === 'result' && event.data.report) resolve(event.data.report);
      else reject(new Error(event.data.message ?? 'Mountain wind GPU benchmark failed'));
    };
    worker.onerror = event => {
      worker.terminate();
      reject(new Error(event.message || 'Mountain wind GPU benchmark worker failed'));
    };
    const buffer = input.elevation.buffer;
    const transfer = buffer instanceof ArrayBuffer ? [buffer] : [];
    worker.postMessage({ type: 'windBenchmark', id, input, options }, transfer);
  });
}

/** Compute a compact luminance SSIM for browser-side visual fixture checks. */
export function computeMountainIllustrationSsim(
  left: Uint8Array | Uint8ClampedArray,
  right: Uint8Array | Uint8ClampedArray,
): number {
  if (left.length !== right.length || left.length % 4 !== 0) return 0;
  let meanLeft = 0;
  let meanRight = 0;
  const count = left.length / 4;
  for (let index = 0; index < left.length; index += 4) {
    meanLeft += 0.2126 * left[index] + 0.7152 * left[index + 1] + 0.0722 * left[index + 2];
    meanRight += 0.2126 * right[index] + 0.7152 * right[index + 1] + 0.0722 * right[index + 2];
  }
  meanLeft /= count;
  meanRight /= count;
  let varianceLeft = 0;
  let varianceRight = 0;
  let covariance = 0;
  for (let index = 0; index < left.length; index += 4) {
    const l = 0.2126 * left[index] + 0.7152 * left[index + 1] + 0.0722 * left[index + 2] - meanLeft;
    const r = 0.2126 * right[index] + 0.7152 * right[index + 1] + 0.0722 * right[index + 2] - meanRight;
    varianceLeft += l * l;
    varianceRight += r * r;
    covariance += l * r;
  }
  const denominator = Math.max(1, count - 1);
  varianceLeft /= denominator;
  varianceRight /= denominator;
  covariance /= denominator;
  const c1 = 6.5025;
  const c2 = 58.5225;
  return ((2 * meanLeft * meanRight + c1) * (2 * covariance + c2))
    / ((meanLeft * meanLeft + meanRight * meanRight + c1)
      * (varianceLeft + varianceRight + c2));
}

export function evaluateMountainIllustrationVisualGate(
  reference: Uint8Array | Uint8ClampedArray,
  candidate: Uint8Array | Uint8ClampedArray,
  threshold = 0.98,
): { ssim: number; passed: boolean } {
  const ssim = computeMountainIllustrationSsim(reference, candidate);
  return { ssim, passed: ssim >= threshold };
}

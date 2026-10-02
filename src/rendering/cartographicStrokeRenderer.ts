/**
 * Deterministic charcoal-style strokes with seeded interruptions, shared by water and vegetation.
 */
export interface ContourTangent {
  tx: number;
  ty: number;
  valid: boolean;
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function hash01(value: number, salt: number): number {
  let hash = (Math.imul(value ^ 0x9e3779b9, salt | 0) + 0x7f4a7c15) | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 13), 0x45d9f3b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

export interface CharcoalInterruptionPattern {
  dashLength: number;
  gapLength: number;
  cyclePeriod: number;
  phase: number;
}

export interface CharcoalInterruptionSettings {
  breakProbability?: number;
  dashMin?: number;
  dashMax?: number;
  gapMin?: number;
  gapMax?: number;
}

export interface CharcoalStrokeRun {
  start: number;
  end: number;
}

/** Build the seeded contiguous dash/gap pattern used by charcoal marks. */
export function createCharcoalInterruptionPattern(
  markSeed: number,
  scale = 1,
  settings: CharcoalInterruptionSettings = {},
): CharcoalInterruptionPattern {
  const markScale = Math.max(0.25, scale);
  const breakProbability = clamp01(settings.breakProbability ?? 0.3);
  const dashMin = Math.max(0, settings.dashMin ?? 8);
  const dashMax = Math.max(dashMin, settings.dashMax ?? 24);
  const gapMin = Math.max(0, settings.gapMin ?? 2);
  const gapMax = Math.max(gapMin, settings.gapMax ?? 4);
  const hasBreak = hash01(markSeed, 263) < breakProbability;
  const dashLength = hasBreak
    ? (dashMin + hash01(markSeed, 267) * (dashMax - dashMin)) * markScale
    : 1e5;
  const gapLength =
    (gapMin + hash01(markSeed, 269) * (gapMax - gapMin)) * markScale;
  const cyclePeriod = dashLength + gapLength;
  return {
    dashLength,
    gapLength,
    cyclePeriod,
    phase: hash01(markSeed, 271) * cyclePeriod,
  };
}

/**
 * Build deterministic ink ranges for one continuous charcoal path.
 *
 * Water marks decide independently whether each mark contains a break. A
 * vegetation flow is one longer path, so applying that decision only once
 * would either break the entire flow rhythmically or leave it unbroken. This
 * schedule advances through water-sized candidate marks and inserts a seeded
 * gap only when that candidate receives the same break decision. Adjacent
 * candidates without a break merge into one longer stroke run.
 */
export function createCharcoalStrokeRuns(
  totalLength: number,
  pathSeed: number,
  scale = 1,
  settings: CharcoalInterruptionSettings = {},
): CharcoalStrokeRun[] {
  const length = Math.max(0, totalLength);
  if (length <= 0) return [];

  const markScale = Math.max(0.25, scale);
  const breakProbability = clamp01(settings.breakProbability ?? 0.3);
  const dashMin = Math.max(0, settings.dashMin ?? 8);
  const dashMax = Math.max(dashMin, settings.dashMax ?? 24);
  const gapMin = Math.max(0, settings.gapMin ?? 2);
  const gapMax = Math.max(gapMin, settings.gapMax ?? 4);
  const minimumAdvance = 0.25 * markScale;
  const runs: CharcoalStrokeRun[] = [];
  let cursor = 0;
  let runStart = 0;
  let candidateIndex = 0;

  while (cursor < length) {
    const candidateSeed =
      (pathSeed ^ Math.imul(candidateIndex + 1, 2246822519)) | 0;
    const candidateLength = Math.max(
      minimumAdvance,
      (dashMin + hash01(candidateSeed, 267) * (dashMax - dashMin)) *
        markScale,
    );
    const candidateEnd = Math.min(length, cursor + candidateLength);
    const hasBreak =
      candidateEnd < length &&
      hash01(candidateSeed, 263) < breakProbability;

    if (hasBreak) {
      if (candidateEnd > runStart) {
        runs.push({ start: runStart, end: candidateEnd });
      }
      const gapLength =
        (gapMin + hash01(candidateSeed, 269) * (gapMax - gapMin)) *
        markScale;
      cursor = Math.min(length, candidateEnd + gapLength);
      runStart = cursor;
    } else {
      cursor = candidateEnd;
    }
    candidateIndex++;
  }

  if (runStart < length) runs.push({ start: runStart, end: length });
  return runs;
}

export function findCharcoalStrokeRunAtDistance(
  runs: readonly CharcoalStrokeRun[],
  distance: number,
): CharcoalStrokeRun | undefined {
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const run = runs[middle];
    if (distance < run.start) {
      high = middle - 1;
    } else if (distance >= run.end) {
      low = middle + 1;
    } else {
      return run;
    }
  }
  return undefined;
}

export function isCharcoalInkActiveAtDistance(
  distance: number,
  pattern: CharcoalInterruptionPattern,
): boolean {
  return (distance + pattern.phase) % pattern.cyclePeriod < pattern.dashLength;
}

export function sampleScalarField(
  field: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;
  const top = field[y0 * width + x0] * (1 - tx) + field[y0 * width + x1] * tx;
  const bottom = field[y1 * width + x0] * (1 - tx) + field[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Tangent to an arbitrary scalar-field isoline. */
export function getContourTangentAt(
  field: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): ContourTangent {
  const ddx =
    (sampleScalarField(field, width, height, x + 2, y) -
      sampleScalarField(field, width, height, x - 2, y)) *
      0.25 +
    (sampleScalarField(field, width, height, x + 1, y) -
      sampleScalarField(field, width, height, x - 1, y)) *
      0.5;
  const ddy =
    (sampleScalarField(field, width, height, x, y + 2) -
      sampleScalarField(field, width, height, x, y - 2)) *
      0.25 +
    (sampleScalarField(field, width, height, x, y + 1) -
      sampleScalarField(field, width, height, x, y - 1)) *
      0.5;
  const length = Math.hypot(ddx, ddy);
  return length < 1e-4
    ? { tx: 1, ty: 0, valid: false }
    : { tx: -ddy / length, ty: ddx / length, valid: true };
}

/** Exact Euclidean distance from non-zero cells to the nearest zero cell. */
export function buildDistanceField(
  insideMask: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const total = width * height;
  const distance = new Float32Array(total);
  const inf = 1e9;
  const finiteLimit = 1e8;
  const rowSquared = new Float32Array(total);
  const maxLength = Math.max(width, height);
  const lineValues = new Float32Array(maxLength);
  const lineDistance = new Float32Array(maxLength);
  const envelope = new Int32Array(maxLength);
  const boundaries = new Float64Array(maxLength + 1);

  const transformLine = (length: number): void => {
    let firstFinite = -1;
    for (let i = 0; i < length; i++) {
      if (lineValues[i] < finiteLimit) {
        firstFinite = i;
        break;
      }
    }
    if (firstFinite < 0) {
      lineDistance.fill(inf, 0, length);
      return;
    }
    let k = 0;
    envelope[0] = firstFinite;
    boundaries[0] = Number.NEGATIVE_INFINITY;
    boundaries[1] = Number.POSITIVE_INFINITY;
    for (let q = firstFinite + 1; q < length; q++) {
      const value = lineValues[q];
      if (value >= finiteLimit) continue;
      let boundary =
        (value + q * q -
          (lineValues[envelope[k]] + envelope[k] * envelope[k])) /
        (2 * (q - envelope[k]));
      while (k > 0 && boundary <= boundaries[k]) {
        k--;
        boundary =
          (value + q * q -
            (lineValues[envelope[k]] + envelope[k] * envelope[k])) /
          (2 * (q - envelope[k]));
      }
      k++;
      envelope[k] = q;
      boundaries[k] = boundary;
      boundaries[k + 1] = Number.POSITIVE_INFINITY;
    }
    k = 0;
    for (let q = 0; q < length; q++) {
      while (k < length - 1 && boundaries[k + 1] < q) k++;
      const source = envelope[k];
      const delta = q - source;
      lineDistance[q] = delta * delta + lineValues[source];
    }
  };

  for (let y = 0; y < height; y++) {
    const offset = y * width;
    for (let x = 0; x < width; x++) lineValues[x] = insideMask[offset + x] ? inf : 0;
    transformLine(width);
    rowSquared.set(lineDistance.subarray(0, width), offset);
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) lineValues[y] = rowSquared[y * width + x];
    transformLine(height);
    for (let y = 0; y < height; y++) {
      const squared = lineDistance[y];
      distance[y * width + x] =
        squared >= finiteLimit ? 1e6 : Math.min(1e6, Math.sqrt(Math.max(0, squared)));
    }
  }
  return distance;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function charcoalStrokePressureAt(
  strokeT: number,
  taperStart = true,
  taperEnd = true,
): number {
  const t = clamp01(strokeT);
  return (
    0.035 +
    0.965 *
      Math.pow(
        Math.min(
          taperStart ? smoothstep(0, 0.2, t) : 1,
          taperEnd ? smoothstep(0, 0.2, 1 - t) : 1,
        ),
        0.82,
      )
  );
}

// Pressure is sampled for every candidate pixel of every charcoal segment.
// Keep the public analytic function above for callers that need an exact
// scalar value, but use a small deterministic table in the raster hot loop.
// The interpolation error is below 0.00002 for the smoothstep/power curve.
const CHARCOAL_PRESSURE_LUT_SIZE = 1024;
const charcoalPressureLuts: Record<string, Float32Array> = {};

function getCharcoalPressureLut(
  taperStart: boolean,
  taperEnd: boolean,
): Float32Array {
  const key = `${taperStart ? 1 : 0}${taperEnd ? 1 : 0}`;
  const existing = charcoalPressureLuts[key];
  if (existing) return existing;
  const table = new Float32Array(CHARCOAL_PRESSURE_LUT_SIZE + 1);
  for (let i = 0; i <= CHARCOAL_PRESSURE_LUT_SIZE; i++) {
    table[i] = charcoalStrokePressureAt(
      i / CHARCOAL_PRESSURE_LUT_SIZE,
      taperStart,
      taperEnd,
    );
  }
  charcoalPressureLuts[key] = table;
  return table;
}

export function charcoalStrokePressureFast(
  strokeT: number,
  taperStart = true,
  taperEnd = true,
): number {
  const t = clamp01(strokeT);
  const scaled = t * CHARCOAL_PRESSURE_LUT_SIZE;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  const table = getCharcoalPressureLut(taperStart, taperEnd);
  return table[lower] +
    (table[Math.min(CHARCOAL_PRESSURE_LUT_SIZE, lower + 1)] - table[lower]) * fraction;
}

export function paintInkDisk(
  alpha: Uint8Array,
  clip: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  seed = 0,
  coordinateOffsetX = 0,
  coordinateOffsetY = 0,
  coordinateStride = width,
): void {
  const bound = Math.ceil(radius * 2.2 + 2.5);
  const maximumRadius = radius * 1.175;
  const maximumDistanceSquared = (maximumRadius + 0.65) ** 2;
  for (let y = Math.max(0, Math.floor(cy - bound)); y <= Math.min(height - 1, Math.ceil(cy + bound)); y++) {
    const rowOffset = y * width;
    for (let x = Math.max(0, Math.floor(cx - bound)); x <= Math.min(width - 1, Math.ceil(cx + bound)); x++) {
      const index = rowOffset + x;
      if (clip[index] === 0) continue;
      const dx = x - cx;
      const dy = y - cy;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > maximumDistanceSquared) continue;
      const globalIndex = (y + coordinateOffsetY) * coordinateStride + x + coordinateOffsetX;
      const localRadius = radius * (1 + (hash01(globalIndex * 13 + seed, 541) - 0.5) * 0.35);
      if (distanceSquared >= (localRadius + 0.65) ** 2) continue;
      const coverage = localRadius > 0.35 && distanceSquared <= (localRadius - 0.35) ** 2
        ? 1
        : clamp01(localRadius - Math.sqrt(distanceSquared) + 0.65);
      alpha[index] = Math.max(alpha[index], Math.round(coverage * 255));
    }
  }
}

export function paintInkSegment(
  alpha: Uint8Array,
  clip: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  seed: number,
  smoothing: number,
  strokeT0 = 0,
  strokeT1 = 1,
  taperStart = true,
  taperEnd = true,
  coordinateOffsetX = 0,
  coordinateOffsetY = 0,
  coordinateStride = width,
  opacity = 1,
  drySkipProbability = 0.05,
  clipStartCap = false,
  clipEndCap = false,
  solidCore = false,
  clipRect?: { minX: number; minY: number; maxX: number; maxY: number },
  depthBuffer?: Float32Array,
  depthValue = 0,
): void {
  const sx = x1 - x0;
  const sy = y1 - y0;
  const lengthSquared = sx * sx + sy * sy || 1;
  const invLengthSquared = 1 / lengthSquared;
  const variation = 0.6 / (1 + smoothing * 0.8);
  const inkOpacity = clamp01(opacity);
  const searchRadius = Math.max(3, radius * 2.6 + 2.5);
  const maxLocalRadius = radius * (
    solidCore ? 1 : 1 + variation * 0.65 + 0.0825
  );
  const maxDistance = maxLocalRadius + 0.65;
  const maxDistanceSquared = maxDistance * maxDistance;
  // Pressure is sampled for every candidate pixel. Resolve the lookup table
  // once per segment instead of rebuilding its key and map lookup for every
  // pixel in the brush footprint.
  const pressureTable = radius > 1000
    ? undefined
    : getCharcoalPressureLut(taperStart, taperEnd);
  // Resolve the segment bounds once. This function is called for every
  // vector/raster stroke and the previous implementation repeated the same
  // min/max and optional-clip lookups for every row in the brush footprint.
  const minY = Math.max(
    clipRect?.minY ?? 0,
    Math.floor(Math.min(y0, y1) - searchRadius),
  );
  const maxY = Math.min(
    clipRect?.maxY ?? (height - 1),
    Math.ceil(Math.max(y0, y1) + searchRadius),
  );
  const minX = Math.max(
    clipRect?.minX ?? 0,
    Math.floor(Math.min(x0, x1) - searchRadius),
  );
  const maxX = Math.min(
    clipRect?.maxX ?? (width - 1),
    Math.ceil(Math.max(x0, x1) + searchRadius),
  );
  for (let y = minY; y <= maxY; y++) {
    const rowOffset = y * width;
    let dot = (minX - x0) * sx + (y - y0) * sy;
    for (let x = minX; x <= maxX; x++) {
      const currentDot = dot;
      dot += sx;
      const index = rowOffset + x;
      if (clip[index] === 0) continue;
      const globalIndex = (y + coordinateOffsetY) * coordinateStride + x + coordinateOffsetX;
      const projectedT = currentDot * invLengthSquared;
      if (
        (clipStartCap && projectedT < 0) ||
        (clipEndCap && projectedT > 1)
      ) {
        continue;
      }
      const t = clamp01(projectedT);
      const axisX = x0 + sx * t;
      const axisY = y0 + sy * t;
      const distanceX = x - axisX;
      const distanceY = y - axisY;
      const distanceSquared = distanceX * distanceX + distanceY * distanceY;
      if (distanceSquared > maxDistanceSquared) continue;
      const strokeT = clamp01(strokeT0 + (strokeT1 - strokeT0) * t);
      // Linear interpolation in the 1025-entry table stays below 0.00002 in
      // pressure error. Extremely large export brushes can amplify that
      // error beyond 0.02px, so retain the analytic curve for that case.
      let pressure: number;
      if (pressureTable) {
        const pressurePosition = clamp01(strokeT) * CHARCOAL_PRESSURE_LUT_SIZE;
        const pressureLower = Math.floor(pressurePosition);
        const pressureFraction = pressurePosition - pressureLower;
        const pressureBase = pressureTable[pressureLower];
        pressure = pressureBase + (
          pressureTable[Math.min(CHARCOAL_PRESSURE_LUT_SIZE, pressureLower + 1)]
          - pressureBase
        ) * pressureFraction;
      } else {
        pressure = charcoalStrokePressureAt(strokeT, taperStart, taperEnd);
      }
      const tooth = solidCore ? 0 :
        (hash01(globalIndex * 17 + seed, 541) - 0.5) * 0.35 +
        (hash01(globalIndex * 31, 733) - 0.5) * 0.2;
      const localRadius =
        radius *
        (solidCore ? 1 : pressure) *
        (solidCore
          ? 1
          : 1 - variation * 0.35 + hash01(globalIndex, seed + 1) * variation + tooth * 0.3);
      const localDistance = localRadius + 0.65;
      if (distanceSquared >= localDistance * localDistance) continue;
      const coverage = localRadius > 0.35 && distanceSquared <= (localRadius - 0.35) * (localRadius - 0.35)
        ? 1
        : clamp01(localRadius - Math.sqrt(distanceSquared) + 0.65);
      if (coverage <= 0) continue;
      const edgeFade = Math.min(strokeT, 1 - strokeT);
      if (!solidCore &&
        hash01(globalIndex + seed * 7, 317) <
        drySkipProbability * (1 - edgeFade)
      ) continue;
      const paintedAlpha = Math.round(
        Math.min(
          1,
          coverage * (solidCore ? 1 : 0.78 + 0.22 * hash01(globalIndex, seed + 991)) * inkOpacity,
        ) * 255,
      );
      alpha[index] = Math.max(alpha[index], paintedAlpha);
      if (depthBuffer && paintedAlpha > 0 && Number.isFinite(depthValue)) {
        depthBuffer[index] = Math.max(depthBuffer[index], depthValue);
      }
    }
  }
}

export interface BatchedInkSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  radius: number;
  seed: number;
  smoothing: number;
  strokeT0?: number;
  strokeT1?: number;
  taperStart?: boolean;
  taperEnd?: boolean;
  coordinateOffsetX?: number;
  coordinateOffsetY?: number;
  coordinateStride?: number;
  opacity?: number;
  drySkipProbability?: number;
  clipStartCap?: boolean;
  clipEndCap?: boolean;
  solidCore?: boolean;
  /** Visual bottom used when this stroke participates in prop depth sorting. */
  depth?: number;
}

/**
 * Rasterize independent alpha strokes through 64x64 bins. Each segment is
 * inserted into every bin touched by its conservative footprint; membership
 * is filled in source order, so deterministic tie behaviour within a layer is
 * retained while destination rows stay hot in cache.
 */
export function paintInkSegmentsBatched(
  alpha: Uint8Array,
  clip: Uint8Array,
  width: number,
  height: number,
  segments: readonly BatchedInkSegment[],
  tileSize = 64,
  depthBuffer?: Float32Array,
): void {
  if (segments.length === 0) return;
  const resolvedTileSize = Math.max(8, Math.floor(tileSize));
  const columns = Math.max(1, Math.ceil(width / resolvedTileSize));
  const rows = Math.max(1, Math.ceil(height / resolvedTileSize));
  const binCount = columns * rows;
  const counts = new Int32Array(binCount);
  const minXs = new Int32Array(segments.length);
  const minYs = new Int32Array(segments.length);
  const maxXs = new Int32Array(segments.length);
  const maxYs = new Int32Array(segments.length);
  minXs.fill(1);
  minYs.fill(1);
  maxXs.fill(0);
  maxYs.fill(0);
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    const searchRadius = Math.max(3, segment.radius * 2.6 + 2.5);
    const minX = Math.max(0, Math.floor(Math.min(segment.x0, segment.x1) - searchRadius));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(segment.x0, segment.x1) + searchRadius));
    const minY = Math.max(0, Math.floor(Math.min(segment.y0, segment.y1) - searchRadius));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(segment.y0, segment.y1) + searchRadius));
    minXs[segmentIndex] = minX;
    minYs[segmentIndex] = minY;
    maxXs[segmentIndex] = maxX;
    maxYs[segmentIndex] = maxY;
    if (minX > maxX || minY > maxY) continue;
    const minBinX = Math.floor(minX / resolvedTileSize);
    const maxBinX = Math.floor(maxX / resolvedTileSize);
    const minBinY = Math.floor(minY / resolvedTileSize);
    const maxBinY = Math.floor(maxY / resolvedTileSize);
    for (let binY = minBinY; binY <= maxBinY; binY++) {
      for (let binX = minBinX; binX <= maxBinX; binX++) {
        counts[binY * columns + binX]++;
      }
    }
  }
  const offsets = new Int32Array(binCount + 1);
  for (let index = 0; index < binCount; index++) offsets[index + 1] = offsets[index] + counts[index];
  const cursor = offsets.slice(0, binCount);
  const membership = new Int32Array(offsets[binCount]);
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const minX = minXs[segmentIndex];
    const maxX = maxXs[segmentIndex];
    const minY = minYs[segmentIndex];
    const maxY = maxYs[segmentIndex];
    if (minX > maxX || minY > maxY) continue;
    const minBinX = Math.floor(minX / resolvedTileSize);
    const maxBinX = Math.floor(maxX / resolvedTileSize);
    const minBinY = Math.floor(minY / resolvedTileSize);
    const maxBinY = Math.floor(maxY / resolvedTileSize);
    for (let binY = minBinY; binY <= maxBinY; binY++) {
      for (let binX = minBinX; binX <= maxBinX; binX++) {
        const bin = binY * columns + binX;
        membership[cursor[bin]++] = segmentIndex;
      }
    }
  }
  for (let bin = 0; bin < binCount; bin++) {
    const binX = bin % columns;
    const binY = Math.floor(bin / columns);
    const clipRect = {
      minX: binX * resolvedTileSize,
      minY: binY * resolvedTileSize,
      maxX: Math.min(width - 1, (binX + 1) * resolvedTileSize - 1),
      maxY: Math.min(height - 1, (binY + 1) * resolvedTileSize - 1),
    };
    for (let membershipIndex = offsets[bin]; membershipIndex < offsets[bin + 1]; membershipIndex++) {
      const segment = segments[membership[membershipIndex]];
      paintInkSegment(
        alpha,
        clip,
        width,
        height,
        segment.x0,
        segment.y0,
        segment.x1,
        segment.y1,
        segment.radius,
        segment.seed,
        segment.smoothing,
        segment.strokeT0 ?? 0,
        segment.strokeT1 ?? 1,
        segment.taperStart ?? true,
        segment.taperEnd ?? true,
        segment.coordinateOffsetX ?? 0,
        segment.coordinateOffsetY ?? 0,
        segment.coordinateStride ?? width,
        segment.opacity ?? 1,
        segment.drySkipProbability ?? 0.05,
        segment.clipStartCap ?? false,
        segment.clipEndCap ?? false,
        segment.solidCore ?? false,
        clipRect,
        depthBuffer,
        segment.depth ?? 0,
      );
    }
  }
}

const EMPTY_POISSON_CELL: readonly number[] = [];

export class PoissonGrid {
  private readonly width: number;
  private readonly height: number;
  private readonly cellSize: number;
  private readonly columns: number;
  private readonly rows: number;
  /** Cells are materialized only when they contain at least one point. */
  /** Cells are materialized only when they contain at least one point. */
  private readonly grid = new Map<number, number[]>();
  private readonly points: Array<{ x: number; y: number; radius: number }> = [];
  private maximumRadius = 0;

  constructor(
    width: number,
    height: number,
    minimumRadius: number,
  ) {
    this.width = width;
    this.height = height;
    this.cellSize = Math.max(1, minimumRadius / Math.SQRT2);
    this.columns = Math.ceil(width / this.cellSize);
    this.rows = Math.ceil(height / this.cellSize);
  }

  isClear(x: number, y: number, radius: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
    const gx = Math.floor(x / this.cellSize);
    const gy = Math.floor(y / this.cellSize);
    // A point can be excluded by the sum of its radius and a previously
    // placed point's radius. Search far enough to include the largest stored
    // point before applying that exact pairwise test below.
    const reach = Math.ceil((radius + this.maximumRadius) / this.cellSize) + 1;
    for (let oy = -reach; oy <= reach; oy++) {
      const row = gy + oy;
      if (row < 0 || row >= this.rows) continue;
      for (let ox = -reach; ox <= reach; ox++) {
        const column = gx + ox;
        if (column < 0 || column >= this.columns) continue;
        for (const pointIndex of this.grid.get(row * this.columns + column) ?? EMPTY_POISSON_CELL) {
          const point = this.points[pointIndex];
          // For equal-sized lines this is exactly 2 * radius, keeping their
          // rendered footprints from touching or overlapping.
          const required = radius + point.radius;
          const dx = x - point.x;
          const dy = y - point.y;
          if (dx * dx + dy * dy < required * required) return false;
        }
      }
    }
    return true;
  }

  add(x: number, y: number, radius: number): void {
    const index = this.points.length;
    this.points.push({ x, y, radius });
    this.maximumRadius = Math.max(this.maximumRadius, radius);
    const gx = Math.floor(x / this.cellSize);
    const gy = Math.floor(y / this.cellSize);
    const cellIndex = gy * this.columns + gx;
    let cell = this.grid.get(cellIndex);
    if (!cell) {
      cell = [];
      this.grid.set(cellIndex, cell);
    }
    cell.push(index);
  }
}

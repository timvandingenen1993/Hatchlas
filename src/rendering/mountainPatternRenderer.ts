/**
 * Builds the mountain pattern overlay (stroke paths and field caches) from terrain fields.
 */
import { SimplexNoise } from '../core/noise';
import type { MountainDEMData } from '../terrain/mountainBaseDEM';
import { clamp01, hash01, paintInkSegment, sampleScalarField, createCharcoalInterruptionPattern, isCharcoalInkActiveAtDistance } from './cartographicStrokeRenderer';
import { MIN_POSITIVE_SCALE } from '../config/inspectorBounds';
import type { MountainProfiler } from './mountainProfiler';
import {
  MOUNTAIN_BIOME_DETAIL_MULTIPLIER_DEFAULT,
  MOUNTAIN_BIOME_DETAIL_MULTIPLIER_MIN,
  MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_DEFAULT,
  MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_MIN,
  MOUNTAIN_LOCAL_DETAIL_DENSITY_DEFAULT,
  MOUNTAIN_LOCAL_DETAIL_DENSITY_MIN,
} from './mountainProjection';

export interface MountainPatternOverlay {
  coverage: Uint8Array;
  /** Dry terrain support for geometric linework, independent of biome/material. */
  lineworkCoverage?: Uint8Array;
  /** Automatic local detail multiplier. Mountain terrain is 1x minimum. */
  detailDensity?: Float32Array;
  snow: Float32Array;
  ink: Uint8Array;
  /** Signed pigment variation: broad blooms with fine paper grain. */
  wash: Float32Array;
  /** Smoothed physical surface used by the illustrated relief projection. */
  surfaceElevation?: Float32Array;
  ridgeInk?: Uint8Array;
  paths?: MountainStrokePath[];
  /** Source-space primary crest paths used by the full-terrain camera. They
   * remain separate from map-space paths because the camera redraws them
   * after depth testing; hatch buffers carry all local detail. */
  cameraRidgePaths?: MountainStrokePath[];
}

export interface MountainStrokePath {
  kind: 'ridge' | 'charcoal' | 'contour' | 'dot';
  key: number;
  width: number;
  opacity: number;
  /** Retained primary crest; interior ridge paths use a lighter pen. */
  primary?: boolean;
  /** A secondary crease ends on this primary downhill chain. */
  parentKey?: number;
  /** Geometric feature represented by the path; hatch family remains `kind`. */
  feature?: 'crest' | 'rib' | 'crevice' | 'cliff';
  points: { x: number; y: number }[];
}

function mountainBiomeDetailBoost(biome: number): number {
  // These are presentation nudges, not ecological truth. Glacier and bare
  // alpine classes stay at the 1x floor; meadow/woodland faces get a gentle
  // opportunity for additional marks. Water and sediment classes are either
  // clipped or left at the same floor so their boundaries cannot darken the
  // map by themselves.
  switch (biome) {
    case 2: return 0.12; // Alpine tundra & meadow
    case 3: return 0.08; // Subalpine conifer forest
    case 4: return 0.08; // Montane broadleaf woodland
    case 5: return 0.05; // Riparian canyon & shrubland
    case 20: return 0.08; // Montane meadow
    default: return 0;
  }
}

/**
 * Small, stage-local cache for deterministic terrain fields. Each named entry
 * keeps only its current source and parameter variant. The source fingerprint
 * is checked once per render call, so in-place edits to a typed array cannot
 * leave a stale field behind.
 */
export interface MountainFieldCache {
  entries: Map<string, MountainFieldCacheEntry>;
}

interface MountainFieldCacheEntry {
  sources: readonly ArrayLike<number>[];
  fingerprints: readonly number[];
  width: number;
  height: number;
  signature: string;
  value: unknown;
}

export interface MountainFieldCacheSession {
  cache: MountainFieldCache;
  fingerprints: WeakMap<object, number>;
  hits: number;
  misses: number;
}

export function createMountainFieldCache(): MountainFieldCache {
  return { entries: new Map() };
}

/** Deterministic content fingerprint used only to detect in-place edits. */
export function getMountainFieldFingerprint(source: ArrayLike<number>): number {
  let hash = 2166136261 >>> 0;
  // DEM fields are normally Float32Array/Uint8Array instances. Hashing their
  // representation catches every in-place bit change; the byte path also
  // handles Float64Array inputs without collapsing fractional values through
  // a 32-bit integer cast.
  if (source instanceof Float32Array) {
    const floatBits = new Uint32Array(source.buffer, source.byteOffset, source.length);
    for (const value of floatBits) {
      hash ^= value;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }
  if (ArrayBuffer.isView(source) && !(source instanceof DataView)) {
    const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }
  for (let index = 0; index < source.length; index++) {
    const value = Number(source[index]) >>> 0;
    hash ^= value;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function createMountainFieldCacheSession(
  cache?: MountainFieldCache,
): MountainFieldCacheSession | undefined {
  return cache ? { cache, fingerprints: new WeakMap(), hits: 0, misses: 0 } : undefined;
}

function fingerprintFor(
  session: MountainFieldCacheSession,
  source: ArrayLike<number>,
): number {
  const objectSource = source as object;
  const existing = session.fingerprints.get(objectSource);
  if (existing !== undefined) return existing;
  const fingerprint = getMountainFieldFingerprint(source);
  session.fingerprints.set(objectSource, fingerprint);
  return fingerprint;
}

/** Return a cached field, rebuilding it when any input or parameter changes. */
export function cachedMountainField<T>(
  session: MountainFieldCacheSession | undefined,
  key: string,
  sources: readonly ArrayLike<number>[],
  width: number,
  height: number,
  signature: string,
  build: () => T,
): T {
  if (!session) return build();
  const fingerprints = sources.map(source => fingerprintFor(session, source));
  const entry = session.cache.entries.get(key);
  const reusable = Boolean(
    entry &&
      entry.width === width &&
      entry.height === height &&
      entry.signature === signature &&
      entry.sources.length === sources.length &&
      entry.sources.every((source, index) => source === sources[index]
        && entry.fingerprints[index] === fingerprints[index]),
  );
  if (reusable) {
    session.hits++;
    return entry!.value as T;
  }
  session.misses++;
  const value = build();
  session.cache.entries.set(key, {
    sources: [...sources],
    fingerprints,
    width,
    height,
    signature,
    value,
  });
  return value;
}

/** Walk edges through junctions in their straightest direction. Texture and
 * taper are applied to these whole chains, never to individual raster links. */
export function chainMountainSegments<T extends { x: number; y: number }>(segments: [T, T][]): T[][] {
  const points: T[] = [];
  const index = new Map<T, number>();
  const neighbours: { point: number; edge: number }[][] = [];
  const id = (p: T) => {
    let value = index.get(p);
    if (value === undefined) { value = points.length; index.set(p, value); points.push(p); neighbours.push([]); }
    return value;
  };
  segments.forEach(([a, b], edge) => {
    const i = id(a), j = id(b);
    neighbours[i].push({ point: j, edge }); neighbours[j].push({ point: i, edge });
  });
  const used = new Uint8Array(segments.length);
  const paths: T[][] = [];
  const starts = points.map((_, i) => i).sort((a, b) => neighbours[a].length - neighbours[b].length);
  for (const start of starts) {
    while (neighbours[start].some(link => !used[link.edge])) {
      const path: T[] = [points[start]];
      let current = start, previous = -1;
      for (;;) {
        let best: { point: number; edge: number } | undefined;
        let bestScore = -Infinity;
        for (const link of neighbours[current]) {
          if (used[link.edge]) continue;
          const a = points[current], b = points[link.point];
          const p = previous < 0 ? a : points[previous];
          const score = previous < 0 ? -Math.hypot(b.x - a.x, b.y - a.y)
            : ((a.x - p.x) * (b.x - a.x) + (a.y - p.y) * (b.y - a.y))
              / Math.max(1e-6, Math.hypot(a.x - p.x, a.y - p.y) * Math.hypot(b.x - a.x, b.y - a.y));
          if (previous >= 0 && score < -0.25) continue;
          if (score > bestScore) { best = link; bestScore = score; }
        }
        if (!best) break;
        used[best.edge] = 1; previous = current; current = best.point; path.push(points[current]);
        if (current === start) break;
      }
      if (path.length > 1) paths.push(path);
    }
  }
  return paths;
}

/** Join contour chains that end on the same physical crest. Both endpoint
 * tangents must point into the gap, so nearby parallel spurs stay separate. */
export function joinMountainChains<T extends { x: number; y: number }>(
  chains: T[][], maxGap: number, offsetX = 0, offsetY = 0,
  dryMask?: Uint8Array, maskWidth = 0, maskHeight = 0,
): T[][] {
  const result = chains.filter(chain => chain.length > 1).map(chain => chain.slice());
  const endpoint = (chain: T[], atStart: boolean) => {
    const point = atStart ? chain[0] : chain[chain.length - 1];
    const inside = atStart ? chain[1] : chain[chain.length - 2];
    const dx = point.x - inside.x, dy = point.y - inside.y;
    const length = Math.max(1e-6, Math.hypot(dx, dy));
    return { point, dx: dx / length, dy: dy / length };
  };
  // Match endpoints through a spatial hash. A few rounds allow a newly
  // extended chain to meet its next neighbour without quadratic comparisons.
  for (let round = 0; round < 3; round++) {
    const ends = result.flatMap((chain, path) => chain.length < 2 ? [] : [
      { path, atStart: true, ...endpoint(chain, true) },
      { path, atStart: false, ...endpoint(chain, false) },
    ]);
    const buckets = new Map<number, number[]>();
    const cellX = (value: number) => Math.floor((value + offsetX) / Math.max(1, maxGap));
    const cellY = (value: number) => Math.floor((value + offsetY) / Math.max(1, maxGap));
    // Exact integer key (cells stay far inside +/-2^21), avoiding a string
    // allocation for each of the nine bucket probes per endpoint.
    const cellKey = (cx: number, cy: number) => (cx + 2097152) * 4194304 + (cy + 2097152);
    for (let i = 0; i < ends.length; i++) {
      const e = ends[i], key = cellKey(cellX(e.point.x), cellY(e.point.y));
      const bucket = buckets.get(key);
      if (bucket) bucket.push(i); else buckets.set(key, [i]);
    }
    const nearest = new Int32Array(ends.length).fill(-1);
    const nearestScore = new Float32Array(ends.length).fill(Infinity);
    // Flat endpoint arrays keep the candidate scan (hundreds of millions of
    // pair tests on a dense export) off object property loads.
    const endX = new Float64Array(ends.length), endY = new Float64Array(ends.length);
    const endDx = new Float64Array(ends.length), endDy = new Float64Array(ends.length);
    const endPath = new Int32Array(ends.length);
    for (let i = 0; i < ends.length; i++) {
      const e = ends[i];
      endX[i] = e.point.x; endY[i] = e.point.y; endDx[i] = e.dx; endDy[i] = e.dy; endPath[i] = e.path;
    }
    // Conservative squared-distance reject: anything beyond this is certainly
    // farther than maxGap, so only near candidates pay for Math.hypot.
    const maxGapSquaredSlack = maxGap * maxGap * (1 + 1e-9);
    for (let i = 0; i < ends.length; i++) {
      const ax = endX[i], ay = endY[i], adx = endDx[i], ady = endDy[i], apath = endPath[i];
      const cx = cellX(ax), cy = cellY(ay);
      for (let by = cy - 1; by <= cy + 1; by++) for (let bx = cx - 1; bx <= cx + 1; bx++) {
        const candidates = buckets.get(cellKey(bx, by));
        if (!candidates) continue;
        for (const j of candidates) {
          if (apath === endPath[j]) continue;
          const vx = endX[j] - ax, vy = endY[j] - ay;
          if (vx * vx + vy * vy > maxGapSquaredSlack) continue;
          const distance = Math.hypot(vx, vy);
          if (distance < 0.5 || distance > maxGap) continue;
          const alongA = (adx * vx + ady * vy) / distance;
          const alongB = -(endDx[j] * vx + endDy[j] * vy) / distance;
          if (alongA < 0.45 || alongB < 0.45) continue;
          const score = distance - (alongA + alongB) * maxGap * 0.08;
          if (!(score < nearestScore[i])) continue;
          // The ray walk is the expensive test, so it runs only for a
          // candidate that would otherwise become the nearest partner.
          if (dryMask && maskWidth > 0 && maskHeight > 0) {
            let dry = true;
            const samples = Math.max(2, Math.ceil(distance * 1.5));
            for (let sample = 0; sample <= samples; sample++) {
              const t = sample / samples;
              const x = Math.round(ax + vx * t), y = Math.round(ay + vy * t);
              if (x < 0 || y < 0 || x >= maskWidth || y >= maskHeight
                || !dryMask[y * maskWidth + x]) { dry = false; break; }
            }
            if (!dry) continue;
          }
          nearest[i] = j; nearestScore[i] = score;
        }
      }
    }
    const consumed = new Uint8Array(result.length);
    const replacements = new Map<number, T[]>();
    for (let i = 0; i < ends.length; i++) {
      const j = nearest[i];
      if (j < 0 || nearest[j] !== i) continue;
      const a = ends[i], b = ends[j];
      if (consumed[a.path] || consumed[b.path]) continue;
      consumed[a.path] = consumed[b.path] = 1;
      const first = a.atStart ? result[a.path].slice().reverse() : result[a.path].slice();
      const second = b.atStart ? result[b.path].slice() : result[b.path].slice().reverse();
      // Do not spread a whole chain into push(). Large export DEMs can
      // produce enough points here to exceed the engine's argument limit.
      for (const point of second) first.push(point);
      replacements.set(a.path, first);
    }
    if (!replacements.size) break;
    const merged: T[][] = [];
    for (let i = 0; i < result.length; i++) {
      if (replacements.has(i)) merged.push(replacements.get(i)!);
      else if (!consumed[i]) merged.push(result[i]);
    }
    // The merged chain count is data-dependent and can be very large for an
    // export. Replacing it iteratively avoids another argument-stack limit.
    result.length = 0;
    for (const chain of merged) result.push(chain);
  }
  return result;
}

/** Pixel distance to the nearest detected crest, used to concentrate fall
 * lines near the main ridge while retaining deterministic tile coordinates. */
function buildMountainRidgeDistance(points: MountainLinePoint[], width: number, height: number): Float32Array {
  const distance = new Float32Array(width * height).fill(1e6);
  for (const point of points) {
    const x = Math.round(point.x), y = Math.round(point.y);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    distance[y * width + x] = 0;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (x > 0) distance[i] = Math.min(distance[i], distance[i - 1] + 1);
    if (y > 0) distance[i] = Math.min(distance[i], distance[i - width] + 1);
    if (x > 0 && y > 0) distance[i] = Math.min(distance[i], distance[i - width - 1] + 1.4143);
    if (x + 1 < width && y > 0) distance[i] = Math.min(distance[i], distance[i - width + 1] + 1.4143);
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x;
    if (x + 1 < width) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
    if (y + 1 < height) distance[i] = Math.min(distance[i], distance[i + width] + 1);
    if (x + 1 < width && y + 1 < height) distance[i] = Math.min(distance[i], distance[i + width + 1] + 1.4143);
    if (x > 0 && y + 1 < height) distance[i] = Math.min(distance[i], distance[i + width - 1] + 1.4143);
  }
  return distance;
}

function mountainChainLength(points: MountainLinePoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(
    points[i].x - points[i - 1].x,
    points[i].y - points[i - 1].y,
  );
  return length;
}

/**
 * Hessian contours often describe the same broad fold several times. Keep
 * the strongest chain in each parallel bundle; otherwise every copy becomes
 * a heavy outline and the face reads as a crack network. The comparison is
 * world anchored and only uses the chain's own samples, so preview/export
 * retain identical decisions when they have the same support.
 */
function selectStructuralRidgeChains(
  chains: MountainLinePoint[][],
  scale: number,
  ridgeDensity = 1,
): MountainLinePoint[][] {
  const density = Math.max(0, ridgeDensity);
  if (density <= 0) return [];
  const candidates = chains
    .map(points => ({
      points,
      length: mountainChainLength(points),
      meanStrength: points.reduce((sum, point) => sum + point.strength, 0) / Math.max(1, points.length),
      meanProminence: points.reduce((sum, point) => sum + (point.prominence ?? 0), 0) / Math.max(1, points.length),
    }))
    .sort((a, b) => (b.length * (0.35 + b.meanStrength) * (0.75 + b.meanProminence))
      - (a.length * (0.35 + a.meanStrength) * (0.75 + a.meanProminence)));
  // Lower density is a sharpness/prominence threshold, rather than a random
  // decimation. Strong crests therefore survive first and the same terrain
  // produces the same lines in preview and export. Density above one is
  // handled by the relaxed span filter at the call site.
  const minimumSignal = density < 1 ? (1 - density) * 0.24 : 0;
  const targetCount = density < 1 ? Math.ceil(candidates.length * density) : Infinity;
  const selected: MountainLinePoint[][] = [];
  const sampleAt = (points: MountainLinePoint[], t: number) => {
    const index = Math.min(points.length - 1, Math.round(t * (points.length - 1)));
    return points[index];
  };
  for (const candidate of candidates) {
    if (selected.length >= targetCount) break;
    const signal = candidate.meanStrength * 0.72 + candidate.meanProminence * 0.28;
    if (signal < minimumSignal) continue;
    let duplicate = false;
    for (const retained of selected) {
      const samples = 7;
      let distance = 0;
      let tangentAlignment = 0;
      for (let sample = 0; sample < samples; sample++) {
        const a = sampleAt(candidate.points, sample / (samples - 1));
        const b = sampleAt(retained, sample / (samples - 1));
        distance += Math.hypot(a.x - b.x, a.y - b.y);
        const ai = sampleAt(candidate.points, Math.min(1, sample / (samples - 1) + 0.03));
        const bi = sampleAt(retained, Math.min(1, sample / (samples - 1) + 0.03));
        const al = Math.max(1e-6, Math.hypot(ai.x - a.x, ai.y - a.y));
        const bl = Math.max(1e-6, Math.hypot(bi.x - b.x, bi.y - b.y));
        tangentAlignment += ((ai.x - a.x) * (bi.x - b.x) + (ai.y - a.y) * (bi.y - b.y)) / (al * bl);
      }
      const averageDistance = distance / samples;
      if (averageDistance <= 12 * scale && tangentAlignment / samples >= 0.72) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) selected.push(candidate.points);
  }
  return selected;
}

/** All lengths are preview pixels; export origins are in output pixels. */
export interface MountainPatternOptions {
  scale?: number;
  /** Density multiplier for downhill and contour hatch families. */
  hatchDensity?: number;
  /** Upper bound for automatic local detail; 1 keeps the mountain baseline. */
  localDetailDensityMax?: number;
  /** Multiplier for low-relief/foothill detail opportunities. */
  foothillDetailMultiplier?: number;
  /** Multiplier for the soft biome presentation bias. */
  biomeDetailMultiplier?: number;
  /** Opacity multiplier for downhill and contour hatch families. */
  hatchOpacity?: number;
  /** Opacity multiplier for near-horizontal contour hatches. */
  horizontalHatchOpacity?: number;
  /** Opacity multiplier for downhill/vertical hatches. */
  verticalHatchOpacity?: number;
  /** Independent hatch pen multiplier. */
  hatchThickness?: number;
  /** Independent structural ridge density multiplier. */
  ridgeDensity?: number;
  /** Biomes that get no mountain linework (ridges, creases, hatching). */
  lineworkExcludedBiomeIds?: readonly number[];
  /** Independent structural ridge thickness multiplier. */
  ridgeThickness?: number;
  /** Resolved primary-ridge pen multiplier after linework presentation scale. */
  ridgeStrokeThickness?: number;
  /** Side-mark length only; never changes terrain sampling or seed density. */
  detailLengthScale?: number;
  offsetX?: number;
  offsetY?: number;
  stride?: number;
  seed?: number;
  strokeThickness?: number;
  strokeOpacity?: number;
  drySkipProbability?: number;
  /** Legacy density multiplier for terrain-following side creases. */
  sideRidgeDensity?: number;
  /** Legacy thickness multiplier for the connected main crest outline. */
  mainRidgeThickness?: number;
}

/** Bounded separable smoothing; identical support in preview and export tiles. */
export function smoothMountainField(field: Float32Array, width: number, height: number, radius: number): Float32Array {
  const r = Math.max(1, Math.ceil(radius));
  const horizontal = acquireMountainSmoothingBuffer(field.length);
  const result = new Float32Array(field.length);
  const count = r * 2 + 1;
  const rowOffsets = new Int32Array(height);
  const enteringColumns = new Int32Array(width);
  const leavingColumns = new Int32Array(width);
  for (let y = 0; y < height; y++) rowOffsets[y] = y * width;
  for (let x = 0; x < width; x++) {
    enteringColumns[x] = Math.min(width - 1, x + r + 1);
    leavingColumns[x] = Math.max(0, x - r);
  }
  for (let y = 0; y < height; y++) {
    const rowOffset = rowOffsets[y];
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += field[rowOffset + Math.max(0, Math.min(width - 1, k))];
    for (let x = 0; x < width; x++) {
      horizontal[rowOffset + x] = sum / count;
      sum += field[rowOffset + enteringColumns[x]] - field[rowOffset + leavingColumns[x]];
    }
  }
  // Walk the output row-major. The previous column-major pass performed the
  // same sliding-window arithmetic but repeatedly jumped by `width`, which
  // made the vertical pass memory-bound on large preview fields. One running
  // accumulator per column keeps the window semantics and makes both reads
  // and writes contiguous.
  const sums = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      sum += horizontal[Math.max(0, Math.min(height - 1, k)) * width + x];
    }
    sums[x] = sum;
  }
  for (let y = 0; y < height; y++) {
    const rowOffset = rowOffsets[y];
    for (let x = 0; x < width; x++) result[rowOffset + x] = sums[x] / count;
    const enteringRow = Math.min(height - 1, y + r + 1) * width;
    const leavingRow = Math.max(0, y - r) * width;
    for (let x = 0; x < width; x++) {
      sums[x] += horizontal[enteringRow + x] - horizontal[leavingRow + x];
    }
  }
  releaseMountainSmoothingBuffer(horizontal);
  return result;
}

const mountainSmoothingBufferPool = new Map<number, Float32Array[]>();

function acquireMountainSmoothingBuffer(length: number): Float32Array {
  const bucket = mountainSmoothingBufferPool.get(length);
  const buffer = bucket?.pop();
  return buffer ?? new Float32Array(length);
}

function releaseMountainSmoothingBuffer(buffer: Float32Array): void {
  let bucket = mountainSmoothingBufferPool.get(buffer.length);
  if (!bucket) {
    bucket = [];
    mountainSmoothingBufferPool.set(buffer.length, bucket);
  }
  if (bucket.length < 2) bucket.push(buffer);
}

interface MountainLinePoint {
  x: number;
  y: number;
  nx: number;
  ny: number;
  strength: number;
  /** Broad topographic prominence used to rank structural crests. */
  prominence?: number;
  /** Relief measured across the candidate's crest direction. */
  crossRelief?: number;
}

/**
 * Connect sub-pixel crest crossings into terrain-supported contours.
 *
 * The old implementation stored one candidate per rounded raster cell and
 * only searched a four-pixel neighbourhood. At the camera analysis scale a
 * valid summit often has a seven-pixel gap after smoothing, so the rounded
 * cell map split one physical crest into many short paths. Keep every
 * crossing in a world-anchored spatial index and choose the best forward and
 * backward continuation from its curvature tangent instead.
 */
function connectMountainContours(
  points: MountainLinePoint[], width: number, height: number, minimumSpan: number,
  supportMask?: Uint8Array,
  terrainMask?: Uint8Array,
): [MountainLinePoint, MountainLinePoint][] {
  if (points.length < 2) return [];
  // A source-space floor is important when the presentation scale is below
  // one: geometric filtering may be coarse in the output while the DEM still
  // contains valid crest crossings several cells apart.
  const linkRadius = Math.max(8, Math.min(12, minimumSpan * 3));
  const cellSize = linkRadius;
  // Exact integer cell key; avoids a string allocation per bucket probe.
  const cellKey = (cx: number, cy: number): number => (cx + 2097152) * 4194304 + (cy + 2097152);
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) continue;
    const key = cellKey(Math.floor(point.x / cellSize), Math.floor(point.y / cellSize));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i); else buckets.set(key, [i]);
  }

  const maskAt = (mask: Uint8Array, x: number, y: number): boolean => {
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return false;
    return mask[iy * width + ix] > 0;
  };
  const segmentSupported = (a: MountainLinePoint, b: MountainLinePoint): boolean => {
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const samples = Math.max(2, Math.ceil(distance * 1.4));
    let supported = 0;
    for (let sample = 0; sample <= samples; sample++) {
      const t = sample / samples;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      // A water cell is a hard stop. Crest support itself may dip briefly at
      // a saddle, so require a majority of the interval to remain supported.
      if (terrainMask && !maskAt(terrainMask, x, y)) return false;
      if (!supportMask || maskAt(supportMask, x, y)) supported++;
    }
    return !supportMask || supported >= Math.ceil((samples + 1) * 0.3);
  };

  const links: number[][] = Array.from({ length: points.length }, () => []);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const best = [-1, -1], scores = [Infinity, Infinity];
    const bucketX = Math.floor(p.x / cellSize), bucketY = Math.floor(p.y / cellSize);
    const tangentX = -p.ny, tangentY = p.nx;
    for (let by = bucketY - 1; by <= bucketY + 1; by++) for (let bx = bucketX - 1; bx <= bucketX + 1; bx++) {
      for (const j of buckets.get(cellKey(bx, by)) ?? []) {
        if (j === i) continue;
        const q = points[j], vx = q.x - p.x, vy = q.y - p.y;
      const length = Math.hypot(vx, vy);
        if (length < 0.2 || length > linkRadius) continue;
        const along = (vx * tangentX + vy * tangentY) / length;
        const qTangentX = -q.ny, qTangentY = q.nx;
        const tangentAgreement = Math.abs(tangentX * qTangentX + tangentY * qTangentY);
        if (Math.abs(along) < 0.38 || tangentAgreement < 0.48) continue;
        if (Math.abs(p.nx * q.nx + p.ny * q.ny) < 0.48) continue;
        const lateral = Math.abs(vx * p.nx + vy * p.ny);
        const crossRelief = Math.min(p.crossRelief ?? 0, q.crossRelief ?? 0);
        const side = along < 0 ? 0 : 1;
        const score = length + lateral * 1.8
          - Math.min(12, crossRelief) * 0.03
          - Math.min(p.strength, q.strength) * 0.15;
        // Ray-sampled support is the costly test; only a candidate that
        // would replace the current best needs it.
        if (!(score < scores[side])) continue;
        if (!segmentSupported(p, q)) continue;
        best[side] = j; scores[side] = score;
      }
    }
    for (const j of best) if (j >= 0 && !links[i].includes(j)) { links[i].push(j); links[j].push(i); }
  }
  const visited = new Uint8Array(points.length);
  const segments: [MountainLinePoint, MountainLinePoint][] = [];
  for (let start = 0; start < points.length; start++) {
    if (visited[start]) continue;
    const component = [start];
    visited[start] = 1;
    let minX = points[start].x, maxX = minX, minY = points[start].y, maxY = minY;
    for (let cursor = 0; cursor < component.length; cursor++) {
      const i = component[cursor], p = points[i];
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      for (const j of links[i]) if (!visited[j]) { visited[j] = 1; component.push(j); }
    }
    if (Math.hypot(maxX - minX, maxY - minY) < minimumSpan) continue;
    for (const i of component) for (const j of links[i]) if (i < j) segments.push([points[i], points[j]]);
  }
  return segments;
}

/** Relief-derived crest ink and falling hachures, shared by preview and export. */
export function renderMountainPatternOverlay(
  dem: MountainDEMData,
  options: MountainPatternOptions = {},
  profiler?: MountainProfiler,
  fieldCache?: MountainFieldCache,
): MountainPatternOverlay {
  const { width, height } = dem;
  const fieldSession = createMountainFieldCacheSession(fieldCache);
  const scale = Math.max(0.25, options.scale ?? 1);
  const ox = options.offsetX ?? 0;
  const oy = options.offsetY ?? 0;
  const stride = options.stride ?? width;
  const seed = options.seed ?? 23817;
  const noise = new SimplexNoise(seed);
  const coverage = new Uint8Array(width * height);
  // Line eligibility is a geometric question. Keep a separate dry-land mask
  // so a lowland cliff can be inked even when its biome contributes no rock
  // material to the mountain footprint.
  const lineworkCoverage = new Uint8Array(width * height);
  const lineworkExcludedBiomes = new Set(options.lineworkExcludedBiomeIds ?? []);
  const lineworkFeatureStrength = new Float32Array(width * height);
  const crestSupportCoverage = new Uint8Array(width * height);
  let snow: Float32Array = new Float32Array(width * height);
  const ink = new Uint8Array(width * height);
  const wash = new Float32Array(width * height);
  const legacyStrokeThickness = Math.max(0, options.strokeThickness ?? 1);
  const thickness = Math.max(0, options.hatchThickness ?? legacyStrokeThickness);
  const opacity = clamp01(options.strokeOpacity ?? 0.8);
  const hatchOpacity = clamp01(options.hatchOpacity ?? opacity);
  const horizontalHatchOpacity = clamp01(options.horizontalHatchOpacity ?? hatchOpacity);
  const verticalHatchOpacity = clamp01(options.verticalHatchOpacity ?? hatchOpacity);
  const drySkip = clamp01(options.drySkipProbability ?? 0.05);
  // Typed inspector overrides may exceed the slider maxima; only the 1x
  // baseline floors of the additive detail boosts are enforced.
  const hatchDensity = Math.max(0, options.hatchDensity ?? 1);
  const localDetailDensityMax = Math.max(MOUNTAIN_LOCAL_DETAIL_DENSITY_MIN,
    options.localDetailDensityMax ?? MOUNTAIN_LOCAL_DETAIL_DENSITY_DEFAULT);
  const foothillDetailMultiplier = Math.max(MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_MIN,
    options.foothillDetailMultiplier ?? MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_DEFAULT);
  const biomeDetailMultiplier = Math.max(MOUNTAIN_BIOME_DETAIL_MULTIPLIER_MIN,
    options.biomeDetailMultiplier ?? MOUNTAIN_BIOME_DETAIL_MULTIPLIER_DEFAULT);
  // `sideRidgeDensity` is retained for direct legacy callers. Once the new
  // hatch-density control is present it is the sole secondary-mark density;
  // main-ridge density must not silently change hatch counts.
  const sideRidgeDensity = Math.max(0,
    options.hatchDensity === undefined ? options.sideRidgeDensity ?? 1 : 1);
  const mainRidgeThickness = Math.max(MIN_POSITIVE_SCALE,
    options.ridgeThickness ?? options.mainRidgeThickness ?? 0.75);
  const ridgePenThickness = Math.max(0,
    options.ridgeStrokeThickness
      ?? (options.ridgeThickness !== undefined
        ? mainRidgeThickness
        : legacyStrokeThickness * mainRidgeThickness));
  const crests: MountainLinePoint[] = [];
  const paths: MountainStrokePath[] = [];
  // The illustration is built from three terrain scales. The broad field
  // decides whether a landform belongs to the mountain range, the face field
  // supplies stable planes, and the trace field retains enough local bend for
  // hand-drawn hachures. Keeping these fields separate avoids asking one
  // noisy Hessian to provide both a range silhouette and every small crease.
  // Geometry uses a datum-relative elevation. A complete normalized field is
  // already invariant under a constant vertical datum shift, so use it as the
  // canonical terrain shape. Crops that omit the normalized field fall back to
  // the physical samples with coarse meter quantization to avoid Float32 ulp
  // noise at tile boundaries.
  const totalCells = width * height;
  const elevationRange = Math.max(1, dem.maxElevationM - dem.minElevationM);
  const sourceStride = Math.max(width, options.stride ?? width);
  const localizeTerrainField = (field: ArrayLike<number>): ArrayLike<number> => {
    if (field.length === totalCells) return field;
    const result = new Float32Array(totalCells);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sourceX = x + ox, sourceY = y + oy;
      const sourceIndex = sourceY * sourceStride + sourceX;
      const index = y * width + x;
      result[index] = sourceX >= 0 && sourceY >= 0
        && sourceX < sourceStride && sourceIndex >= 0 && sourceIndex < field.length
        ? field[sourceIndex]
        : field[index] ?? 0;
    }
    return result;
  };
  const localElevation = localizeTerrainField(dem.elevation);
  const localSlope = localizeTerrainField(dem.slopeDeg);
  const localCurvature = localizeTerrainField(dem.curvature);
  const localTpi = localizeTerrainField(dem.tpi);
  let geometryNormalized: Float32Array | undefined;
  let hasNormalizedGeometry = false;
  if (dem.normalizedElevation.length === totalCells) {
    geometryNormalized = dem.normalizedElevation;
    hasNormalizedGeometry = true;
  } else if (dem.normalizedElevation.length > 0) {
    // Preview crop callers may retain the full normalized source field while
    // slicing the physical arrays. Resolve that field with the same world
    // offset/stride used by the terrain filters.
    geometryNormalized = new Float32Array(totalCells);
    let validSamples = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sourceX = x + ox, sourceY = y + oy;
      const sourceIndex = sourceY * sourceStride + sourceX;
      const index = y * width + x;
      if (sourceX >= 0 && sourceY >= 0 && sourceX < sourceStride
        && sourceIndex >= 0 && sourceIndex < dem.normalizedElevation.length) {
        geometryNormalized[index] = dem.normalizedElevation[sourceIndex];
        validSamples++;
      }
    }
    hasNormalizedGeometry = validSamples === totalCells;
  }
  if (hasNormalizedGeometry) {
    let residualMin = Infinity, residualMax = -Infinity;
    for (let i = 0; i < totalCells; i++) {
      const expected = dem.minElevationM + geometryNormalized![i] * elevationRange;
      const residual = localElevation[i] - expected;
      residualMin = Math.min(residualMin, residual);
      residualMax = Math.max(residualMax, residual);
    }
    // A complete normalized field is valid when it differs from the physical
    // samples by one constant datum (including a user-applied elevation
    // offset). A stale field left behind after reshaping the elevation has a
    // varying residual, so use the physical terrain in that case. This also
    // preserves minimal hand-built DEMs whose normalized field is all zero.
    if (residualMax - residualMin > 0.5) hasNormalizedGeometry = false;
  }
  const geometryDatumOffset = hasNormalizedGeometry ? dem.minElevationM : 0;
  const geometryElevation = hasNormalizedGeometry
    ? cachedMountainField(
      fieldSession,
      'pattern geometry elevation',
      [geometryNormalized!],
      width,
      height,
      `cellSize:${dem.dxMeters},${dem.dyMeters}:range:${elevationRange}`,
      () => Float32Array.from(geometryNormalized!, value => value * elevationRange),
    )
    : Float32Array.from(localElevation, value => Math.floor(value));
  const terrainFieldsStop = profiler?.begin('mountain pattern terrain fields');
  const broadElevation = cachedMountainField(
    fieldSession,
    'pattern broad elevation',
    [geometryElevation],
    width,
    height,
    `cellSize:${dem.dxMeters},${dem.dyMeters}:radius:${12 * scale}`,
    () => smoothMountainField(geometryElevation, width, height, 12 * scale),
  );
  const fineElevationPass = cachedMountainField(
    fieldSession,
    'pattern fine elevation pass',
    [geometryElevation],
    width,
    height,
    `cellSize:${dem.dxMeters},${dem.dyMeters}:radius:${3 * scale}`,
    () => smoothMountainField(geometryElevation, width, height, 3 * scale),
  );
  const elevation = cachedMountainField(
    fieldSession,
    'pattern elevation',
    [fineElevationPass],
    width,
    height,
    `cellSize:${dem.dxMeters},${dem.dyMeters}:radius:${3 * scale}`,
    () => smoothMountainField(fineElevationPass, width, height, 3 * scale),
  );
  const faceElevation = cachedMountainField(
    fieldSession,
    'pattern face elevation',
    [geometryElevation],
    width,
    height,
    `cellSize:${dem.dxMeters},${dem.dyMeters}:radius:${5 * scale}`,
    () => smoothMountainField(geometryElevation, width, height, 5 * scale),
  );
  // Crest detection uses the broad field; fall lines use a lightly filtered
  // field so their bends remain those of the source terrain.
  const traceElevation = cachedMountainField(
    fieldSession,
    'pattern trace elevation',
    [geometryElevation],
    width,
    height,
    `cellSize:${dem.dxMeters},${dem.dyMeters}:radius:${Math.max(1, scale)}`,
    () => smoothMountainField(geometryElevation, width, height, Math.max(1, scale)),
  );
  const slopes = cachedMountainField(
    fieldSession,
    'pattern slopes',
    [localSlope],
    width,
    height,
    `cellSize:${dem.dxMeters},${dem.dyMeters}:radius:${3 * scale}`,
    () => smoothMountainField(localSlope as Float32Array, width, height, 3 * scale),
  );
  const sample = (x: number, y: number) => sampleScalarField(elevation, width, height, x, y);
  const crestSample = (x: number, y: number) => sampleScalarField(broadElevation, width, height, x, y);
  const regionalElevation = cachedMountainField(
    fieldSession,
    'pattern regional crest elevation',
    [broadElevation], width, height,
    `cellSize:${dem.dxMeters},${dem.dyMeters}:radius:${32 * scale}`,
    () => smoothMountainField(broadElevation, width, height, 32 * scale),
  );
  const regionalReliefMagnitude = cachedMountainField(
    fieldSession,
    'pattern regional crest relief magnitude',
    [broadElevation, regionalElevation], width, height,
    `cellSize:${dem.dxMeters},${dem.dyMeters}:radius:${18 * scale}`,
    () => smoothMountainField(
      Float32Array.from(broadElevation, (value, index) =>
        Math.abs(value - regionalElevation[index])),
      width, height, 18 * scale,
    ),
  );
  // A few callers edit the height samples after the DEM has been processed
  // (for example to preview a flat control surface) while leaving the
  // derived slope array untouched. Treat that combination as flat material
  // terrain; an explicit, uniform slope field is still honoured for tests
  // and synthetic faces that intentionally provide one.
  let observedElevationMin = Infinity;
  let observedElevationMax = -Infinity;
  let observedSlopeMin = Infinity;
  let observedSlopeMax = -Infinity;
  for (let i = 0; i < totalCells; i++) {
    observedElevationMin = Math.min(observedElevationMin, localElevation[i]);
    observedElevationMax = Math.max(observedElevationMax, localElevation[i]);
    observedSlopeMin = Math.min(observedSlopeMin, localSlope[i]);
    observedSlopeMax = Math.max(observedSlopeMax, localSlope[i]);
  }
  const staleSlopeOnFlatTerrain = observedElevationMax - observedElevationMin < 1e-3
    && observedSlopeMax - observedSlopeMin > 0.5;
  const slopeAt = (index: number): number => staleSlopeOnFlatTerrain ? 0 : slopes[index];
  const normalizedElevation = hasNormalizedGeometry
    ? geometryNormalized!
    : Float32Array.from(localElevation,
      value => clamp01((value - dem.minElevationM) / elevationRange));
  // Approximate the paper's crest-oriented importance field before the
  // explicit crest pass. Broad, low-relief terrain should stay on a stable
  // low-LOD surface, while steep/prominent terrain retains finer samples for
  // its face flow and hatching. The blend is world anchored, so adjacent
  // preview/export crops choose the same level of detail.
  const featureImportance = new Float32Array(width * height);
  const adaptiveFaceElevation = new Float32Array(width * height);
  const adaptiveTraceElevation = new Float32Array(width * height);
  for (let i = 0; i < featureImportance.length; i++) {
    const localReliefScale = Math.max(
      24,
      regionalReliefMagnitude[i] * 0.68,
      Math.max(dem.dxMeters, dem.dyMeters) * 1.8,
    );
    const broadRelief = clamp01(
      Math.abs(elevation[i] - broadElevation[i]) / localReliefScale,
    );
    const slopeImportance = clamp01((slopeAt(i) - 7) / 30);
    const localProminenceImportance = clamp01(
      (geometryElevation[i] - regionalElevation[i]) / localReliefScale,
    );
    const importance = clamp01(
      broadRelief * 0.56 + slopeImportance * 0.34 + localProminenceImportance * 0.1,
    );
    featureImportance[i] = importance;
    const faceMix = 0.2 + importance * 0.8;
    adaptiveFaceElevation[i] = broadElevation[i] * (1 - faceMix) + faceElevation[i] * faceMix;
    const traceMix = 0.38 + importance * 0.62;
    adaptiveTraceElevation[i] = adaptiveFaceElevation[i] * (1 - traceMix) + traceElevation[i] * traceMix;
  }
  // Localized linework is an additive presentation layer. A high-relief
  // massif remains at the existing 1x density; only lower-relief terrain with
  // a real local face can receive extra marks. Biome influence is smoothed so
  // climate/material boundaries do not become visible density seams.
  const localBiomeType = localizeTerrainField(dem.biomeType);
  const smoothedBiomeDetailBoost = cachedMountainField(
    fieldSession,
    'pattern biome detail boost',
    [localBiomeType],
    width,
    height,
    `cellSize:${dem.dxMeters},${dem.dyMeters}:radius:${8 * scale}`,
    () => smoothMountainField(
      Float32Array.from(localBiomeType, value => mountainBiomeDetailBoost(Math.round(value))),
      width,
      height,
      8 * scale,
    ),
  );
  const mountainDetailDensity = new Float32Array(totalCells);
  const massifReliefReference = Math.max(24, elevationRange * 0.14);
  for (let i = 0; i < mountainDetailDensity.length; i++) {
    const massifness = clamp01(regionalReliefMagnitude[i] / massifReliefReference);
    const localFaceOpportunity = clamp01(featureImportance[i] * 1.35);
    const lowerReliefOpportunity = (1 - massifness) * localFaceOpportunity;
    const biomeBoost = smoothedBiomeDetailBoost[i] * biomeDetailMultiplier * (1 - massifness);
    mountainDetailDensity[i] = Math.min(
      localDetailDensityMax,
      1 + lowerReliefOpportunity * (foothillDetailMultiplier - 1) + biomeBoost,
    );
  }
  const faceSample = (x: number, y: number) => sampleScalarField(adaptiveFaceElevation, width, height, x, y);
  const traceSample = (x: number, y: number) => sampleScalarField(adaptiveTraceElevation, width, height, x, y);
  const detailDensityAt = (x: number, y: number): number =>
    sampleScalarField(mountainDetailDensity, width, height, x, y);
  if (fieldSession && profiler) {
    profiler.recordCache('mountain pattern terrain fields', fieldSession.misses === 0);
  }
  terrainFieldsStop?.();
  const radius = 6 * scale;
  const inverseRadius = 1 / Math.max(1e-6, radius);
  const inverseRadiusSquared = inverseRadius * inverseRadius;
  const hessianCrossScale = 0.25 * inverseRadiusSquared;
  // These neighbour indices are constant for the whole crest pass. Keeping
  // them outside the 2.3M-cell loop removes repeated min/max and row-stride
  // arithmetic while preserving the exact clamped sampling rules.
  const rowOffsets = new Int32Array(height);
  const rowAboveOffsets = new Int32Array(height);
  const rowBelowOffsets = new Int32Array(height);
  for (let row = 0; row < height; row++) {
    rowOffsets[row] = row * width;
    rowAboveOffsets[row] = Math.max(0, row - 1) * width;
    rowBelowOffsets[row] = Math.min(height - 1, row + 1) * width;
  }
  const columnLeft = new Int32Array(width);
  const columnRight = new Int32Array(width);
  for (let column = 0; column < width; column++) {
    columnLeft[column] = Math.max(0, column - 1);
    columnRight[column] = Math.min(width - 1, column + 1);
  }
  const gradientDxDenominator = Math.max(1, 2 * dem.dxMeters);
  const gradientDyDenominator = Math.max(1, 2 * dem.dyMeters);
  const curvatureDxDenominator = Math.max(1, dem.dxMeters * dem.dxMeters);
  const curvatureDyDenominator = Math.max(1, dem.dyMeters * dem.dyMeters);
  const physicalFeatureScale = Math.max(dem.dxMeters, dem.dyMeters);
  const localElevationRange = Math.max(1, dem.maxElevationM - dem.minElevationM);
  const localProminenceDenominator = Math.max(1, elevationRange * 0.2);
  // Crest detection samples the same cardinal and diagonal offsets for every
  // terrain cell. Resolve their clamped bilinear indices once so the Hessian
  // loop only performs field reads and interpolation arithmetic.
  type CrestAxisLookup = {
    lower: Int32Array;
    upper: Int32Array;
    lowerOffset: Int32Array;
    upperOffset: Int32Array;
    weight: Float64Array;
  };
  const buildCrestAxisLookup = (length: number, offset: number, stride: number): CrestAxisLookup => {
    const lower = new Int32Array(length);
    const upper = new Int32Array(length);
    const lowerOffset = new Int32Array(length);
    const upperOffset = new Int32Array(length);
    const weight = new Float64Array(length);
    for (let index = 0; index < length; index++) {
      const coordinate = Math.max(0, Math.min(length - 1, index + offset));
      const base = Math.floor(coordinate);
      lower[index] = base;
      upper[index] = Math.min(length - 1, base + 1);
      lowerOffset[index] = lower[index] * stride;
      upperOffset[index] = upper[index] * stride;
      weight[index] = coordinate - base;
    }
    return { lower, upper, lowerOffset, upperOffset, weight };
  };
  const crestXMinus = buildCrestAxisLookup(width, -radius, 1);
  const crestXPlus = buildCrestAxisLookup(width, radius, 1);
  const crestXCenter = buildCrestAxisLookup(width, 0, 1);
  const crestYMinus = buildCrestAxisLookup(height, -radius, width);
  const crestYPlus = buildCrestAxisLookup(height, radius, width);
  const crestYCenter = buildCrestAxisLookup(height, 0, width);
  const sampleFixedCrest = (
    xLookup: CrestAxisLookup,
    yLookup: CrestAxisLookup,
    x: number,
    y: number,
  ): number => {
    const x0 = xLookup.lower[x], x1 = xLookup.upper[x];
    const tx = xLookup.weight[x], ty = yLookup.weight[y];
    const row0 = yLookup.lowerOffset[y], row1 = yLookup.upperOffset[y];
    const top = broadElevation[row0 + x0] * (1 - tx)
      + broadElevation[row0 + x1] * tx;
    const bottom = broadElevation[row1 + x0] * (1 - tx)
      + broadElevation[row1 + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };
  const flowRadius = Math.max(1.5, 2.2 * scale);
  /** Return the legacy downhill guide used by the charcoal hachure family. */
  const downhillFlow = (x: number, y: number): { x: number; y: number; length: number } => {
    const fineX = traceSample(x + flowRadius, y) - traceSample(x - flowRadius, y);
    const fineY = traceSample(x, y + flowRadius) - traceSample(x, y - flowRadius);
    const faceX = faceSample(x + flowRadius * 1.8, y) - faceSample(x - flowRadius * 1.8, y);
    const faceY = faceSample(x, y + flowRadius * 1.8) - faceSample(x, y - flowRadius * 1.8);
    const gx = fineX * 0.72 + faceX * 0.28;
    const gy = fineY * 0.72 + faceY * 0.28;
    const length = Math.hypot(gx, gy);
    if (length < 0.01) return { x: 0, y: 0, length };
    return { x: gx / length, y: gy / length, length };
  };

  // Resolve the ridge control before crest detection. Values above the
  // neutral setting lower the curvature/support gates as well as admitting
  // shorter chains later, so a broad summit can acquire a structural line;
  // density below one still only keeps the strongest detected crests.
  const ridgeDensity = Math.max(0, options.ridgeDensity ?? 1);
  const ridgeSensitivity = ridgeDensity > 1
    ? 1 / Math.sqrt(Math.max(1, ridgeDensity))
    : 1;
  const crestReliefThreshold = 1.2 * ridgeSensitivity;
  const prominenceSupportThreshold = 0.02 * ridgeSensitivity;

  // These coordinates are reused by the three world-anchored noise bands in
  // the crest pass. Resolve the additions/divisions once per axis instead of
  // doing them for every terrain cell; the sampled noise values themselves and
  // their seed order remain unchanged.
  const noiseX46 = new Float64Array(width);
  const noiseX19 = new Float64Array(width);
  const noiseX53 = new Float64Array(width);
  const noiseY46 = new Float64Array(height);
  const noiseY19 = new Float64Array(height);
  const noiseY53 = new Float64Array(height);
  const noiseDenominator46 = 46 * scale;
  const noiseDenominator19 = 19 * scale;
  const noiseDenominator53 = 53 * scale;
  for (let x = 0; x < width; x++) {
    const worldX = x + ox;
    noiseX46[x] = worldX / noiseDenominator46;
    noiseX19[x] = worldX / noiseDenominator19;
    noiseX53[x] = worldX / noiseDenominator53;
  }
  for (let y = 0; y < height; y++) {
    const worldY = y + oy;
    noiseY46[y] = worldY / noiseDenominator46;
    noiseY19[y] = worldY / noiseDenominator19;
    noiseY53[y] = worldY / noiseDenominator53;
  }
  const waterMask = new Uint8Array(totalCells);
  for (let index = 0; index < totalCells; index++) {
    const biome = dem.biomeType[index];
    waterMask[index] = dem.isOcean[index] > 0
      || (dem.visualWaterMask?.[index] ?? 0) > 0
      || dem.isRiverChannel[index] > 0
      || biome === 6
      || biome === 8
      ? 1
      : 0;
  }

  // Crests below this broad prominence are lower spurs/shoulders whose main
  // line should follow the cliff edge rather than the spur centre.
  const lowerCrestBrinkProminence = 0.45;
  const brinkStep = Math.max(0.75, scale);
  const brinkReach = 2 * radius;
  const brinkCurvatureSpan = Math.max(1, 2 * scale);
  const brinkSample = (x: number, y: number) => sampleScalarField(faceElevation, width, height, x, y);
  /** Return the convex slope break on the steeper side of a crest transect. */
  const findCrestBrink = (
    cx: number, cy: number, ux: number, uy: number, reliefScale: number,
  ): { x: number; y: number } | undefined => {
    const at = (t: number) => brinkSample(cx + ux * t, cy + uy * t);
    const convexity = (t: number) =>
      2 * at(t) - at(t - brinkCurvatureSpan) - at(t + brinkCurvatureSpan);
    const centerZ = at(0);
    const side = centerZ - at(brinkReach) >= centerZ - at(-brinkReach) ? 1 : -1;
    let bestT = 0;
    let bestConvexity = -Infinity;
    for (let t = brinkCurvatureSpan; t <= brinkReach; t += brinkStep) {
      const value = convexity(side * t);
      if (value > bestConvexity) { bestConvexity = value; bestT = side * t; }
    }
    const centerConvexity = convexity(0);
    if (bestT === 0 || bestConvexity < 0.05
      || bestConvexity <= Math.max(0, centerConvexity) * 1.2) return undefined;
    // The ground past the brink must actually fall away as a face.
    const drop = at(bestT) - at(bestT + side * radius);
    if (drop < reliefScale * 0.05) return undefined;
    return {
      x: Math.max(0, Math.min(width - 1, cx + ux * bestT)),
      y: Math.max(0, Math.min(height - 1, cy + uy * bestT)),
    };
  };
  const crestDetectionStop = profiler?.begin('mountain pattern crest detection and chaining');
  for (let y = 0; y < height; y++) {
    const rowOffset = rowOffsets[y];
    const rowAboveOffset = rowAboveOffsets[y];
    const rowBelowOffset = rowBelowOffsets[y];
    for (let x = 0; x < width; x++) {
      const i = rowOffset + x;
      const biome = dem.biomeType[i];
      if (waterMask[i]) continue;
      // Every dry terrain cell is available to the geometric linework pass,
      // except biomes drawn by their own linework (sand desert dunes).
      // Material coverage below may still be zero for a meadow, floodplain,
      // or other non-mountain biome.
      lineworkCoverage[i] = lineworkExcludedBiomes.has(biome) ? 0 : 255;
      const materialSlope = staleSlopeOnFlatTerrain && (biome === 3 || biome === 4 || biome === 5 || biome >= 15)
        ? 0
        : slopes[i];
      // Bare alpine rock and glaciers, with a soft transition into steep tundra.
      // Alpine tundra carries the same broad mountain base as bare rock, but
      // its flat meadows remain a translucent footprint so hatching still
      // begins only on real faces below. This keeps the illustrated relief
      // continuous across the biome boundary.
      const tundraElevation = clamp01((normalizedElevation[i] - 0.28) / 0.58);
      const tundraSlope = clamp01((slopeAt(i) - 4) / 34);
      // Keep the high alpine surface opaque, but let low-slope shoulders fade
      // into foothills. A full biome fill made the mountain a soft-edged blob
      // before any crest or face stroke was visible.
      // Derive this from the local elevation array instead of
      // `normalizedElevation`: export crops intentionally omit the latter,
      // and the raw elevation remains globally consistent at the crop origin.
      const localElevationNormalized = clamp01(
        (localElevation[i] - dem.minElevationM) / localElevationRange,
      );
      const alpineProminence = clamp01((localElevationNormalized - 0.36) / 0.42);
      const alpineSlope = clamp01((materialSlope - 7) / 30);
      const woodlandSlope = clamp01((materialSlope - 5) / 28);
      const broadProminence = clamp01((localElevation[i] - broadElevation[i]) / (elevationRange * 0.16));
      // The biome remains a material hint, not a boundary. Keep a small
      // summit contribution for flat glacier/alpine cells (so cold caps still
      // exist), but make ordinary alpine rock depend mostly on its local face
      // rather than on an elevation-shaped biome disk.
      const biomeMountain = biome === 0
        ? clamp01(alpineProminence * 0.58 + alpineSlope * 0.74 + broadProminence * 0.16)
        : biome === 1
          ? clamp01(alpineProminence * 0.18 + alpineSlope * 0.62 + broadProminence * 0.16)
          : biome === 2
            ? clamp01(tundraElevation * 0.12 + tundraSlope * 0.52 + broadProminence * 0.12)
            : biome === 3 || biome === 4 || biome === 15 || biome === 17 || biome === 18 || biome === 20
              ? clamp01(woodlandSlope * 0.72 + broadProminence * 0.18)
              : biome === 5 || biome === 19
                ? clamp01(woodlandSlope * 0.78 + broadProminence * 0.2)
                // Desert hamada reads as broken rock on its slopes.
                : biome === 16
                  ? clamp01(alpineProminence * 0.12 + alpineSlope * 0.62 + broadProminence * 0.16)
                  : 0;
      // The hatch/ridge layer follows the physical heightmap across every
      // land biome. There is deliberately no highland/elevation gate here:
      // elevation only changes the strength of a local face, while slope and
      // relief decide whether that face gets broken rock and linework. This
      // keeps steep lowland cliffs eligible and removes the circular mountain
      // cutoff from the surrounding grassland.
      const leftElevation = faceElevation[rowOffset + columnLeft[x]];
      const rightElevation = faceElevation[rowOffset + columnRight[x]];
      const upElevation = faceElevation[rowAboveOffset + x];
      const downElevation = faceElevation[rowBelowOffset + x];
      const gradientX = (rightElevation - leftElevation) / gradientDxDenominator;
      const gradientY = (downElevation - upElevation) / gradientDyDenominator;
      const heightmapGradient = Math.sqrt(gradientX * gradientX + gradientY * gradientY);
      const heightmapSlopeDeg = Math.atan(heightmapGradient) * 180 / Math.PI;
      const heightmapSteepness = clamp01((heightmapSlopeDeg - 5) / 34);
      const heightmapProminence = clamp01(
        (localElevation[i] - broadElevation[i]) / localProminenceDenominator,
      );
      const steepRidge = clamp01((heightmapSlopeDeg - 18) / 27);
      // Local feature strength is independent of biome and absolute altitude.
      // It keeps real folds eligible in foothills while remaining quiet on
      // broad flat ground. The curvature term uses physical cell spacing,
      // rather than the DEM's global elevation range.
      const localTraceCenter = traceElevation[i];
      const localCurvatureX = (
        traceElevation[rowOffset + columnRight[x]]
        + traceElevation[rowOffset + columnLeft[x]]
        - 2 * localTraceCenter
      )
        / curvatureDxDenominator;
      const localCurvatureY = (
        traceElevation[rowBelowOffset + x]
        + traceElevation[rowAboveOffset + x]
        - 2 * localTraceCenter
      )
        / curvatureDyDenominator;
      const localCurvatureSignal = clamp01(
        Math.abs(localCurvatureX + localCurvatureY)
          * physicalFeatureScale * 5,
      );
      lineworkFeatureStrength[i] = clamp01(Math.max(
        heightmapSteepness * 0.78,
        localCurvatureSignal * 0.82,
      ));
      // A chain may bridge a short raster gap only when the terrain between
      // its endpoints still behaves like a crest or saddle. Positive local
      // relief (TPI in the regional field) and the negative Laplacian branch
      // (the DEM's convex/crest sign) provide that support without treating
      // a steep valley wall as a summit merely because it has high slope.
      const localReliefScale = Math.max(
        24,
        regionalReliefMagnitude[i] * 0.68,
        physicalFeatureScale * 1.8,
      );
      const crestReliefSignal = clamp01(
        (geometryElevation[i] - regionalElevation[i] + localReliefScale * 0.02)
          / Math.max(1, localReliefScale * 0.14),
      );
      const convexSignal = clamp01(
        -(localCurvatureX + localCurvatureY)
          * physicalFeatureScale * 5,
      );
      crestSupportCoverage[i] = lineworkFeatureStrength[i] >= 0.08
        && Math.max(crestReliefSignal, convexSignal) >= 0.12 ? 255 : 0;
      // Low-frequency terrain noise breaks the material into patches while
      // remaining anchored to world coordinates for tiled exports. It changes
      // the amount of exposed rock; it never turns a flat cell into a ridge.
      const patchNoise = clamp01(
        0.5 + 0.5 * noise.noise2D(noiseX46[x], noiseY46[y]),
      );
      const patchFactor = 0.72 + patchNoise * 0.5;
      const heightmapRidge = clamp01(
        heightmapSteepness * 0.74
          + heightmapProminence * (0.2 + localElevationNormalized * 0.18)
          + steepRidge * 0.16,
      );
      const terrainRidge = clamp01(heightmapRidge * patchFactor);
      const mountain = clamp01(Math.max(biomeMountain * patchFactor, terrainRidge));
      coverage[i] = Math.round(mountain * 255);
      if (mountain) {
        const grain = noise.noise2D(noiseX19[x], noiseY19[y]);
        wash[i] = grain * 0.55
          + noise.noise2D(noiseX53[x], noiseY53[y]) * 0.45;
        const upperSlopeEligibility = clamp01((normalizedElevation[i] - 0.48) / 0.28);
        const cold = clamp01(
          (5 - dem.temperatureC[i]) / 8 + upperSlopeEligibility * 0.32 + grain * 0.05,
        );
        const z = sample(x, y);
        // Snow persists in cold accumulation areas but sheds from steep cliffs.
        // Shelter is derived from broad curvature rather than pixel noise so a
        // gully can carry one connected blanket while a convex rock rib stays
        // exposed. The physical field remains deliberately generous; the
        // illustration stage applies the final projected drift edge.
        const retention = 1 - clamp01((slopes[i] - 38) / 27);
        const curvatureRadius = 6 * scale;
        const curvature = (
          sample(x - curvatureRadius, y) + sample(x + curvatureRadius, y)
          + sample(x, y - curvatureRadius) + sample(x, y + curvatureRadius)
          - 4 * z
        ) / Math.max(1, (dem.maxElevationM - dem.minElevationM) * 0.018);
        const shelter = clamp01(0.5 + curvature * 0.75);
        const broadRetention = 0.9 + shelter * 0.1;
        const exposedRib = clamp01((slopes[i] - 24) / 38) * (1 - shelter * 0.55);
        snow[i] = clamp01(
          (biome === 0 ? Math.max(0.85, cold) : cold)
            * retention
            * broadRetention
            * (1 - exposedRib * 0.22),
        );
      }

      // Trace the range-scale summit spine, rather than the small convex
      // folds running down its faces. Snow and hatches retain their fine field.
      const crestZ = broadElevation[i];
      const l = sampleFixedCrest(crestXMinus, crestYCenter, x, y);
      const r = sampleFixedCrest(crestXPlus, crestYCenter, x, y);
      const u = sampleFixedCrest(crestXCenter, crestYMinus, x, y);
      const d = sampleFixedCrest(crestXCenter, crestYPlus, x, y);
      const gx = (r - l) * 0.5 * inverseRadius;
      const gy = (d - u) * 0.5 * inverseRadius;
      const xx = (r + l - 2 * crestZ) * inverseRadiusSquared;
      const yy = (d + u - 2 * crestZ) * inverseRadiusSquared;
      const xy = (
        sampleFixedCrest(crestXPlus, crestYPlus, x, y)
        - sampleFixedCrest(crestXPlus, crestYMinus, x, y)
        - sampleFixedCrest(crestXMinus, crestYPlus, x, y)
        + sampleFixedCrest(crestXMinus, crestYMinus, x, y)
      ) * hessianCrossScale;
      // Most concave Hessian axis crosses a crest. Distance to its derivative
      // zero gives a narrow ridge, even when the ridge climbs toward a peak.
      const eigenvalue = (xx + yy - Math.sqrt((xx - yy) * (xx - yy) + (2 * xy) * (2 * xy))) / 2;
      let ux = xy, uy = eigenvalue - xx;
      const norm = Math.sqrt(ux * ux + uy * uy);
      if (norm > 1e-8) { ux /= norm; uy /= norm; }
      else { ux = xx <= yy ? 1 : 0; uy = xx <= yy ? 0 : 1; }
      const relief = -eigenvalue * radius * radius;
      // A main crest must stand above its surroundings. Steepness alone
      // otherwise promotes downhill ribs to the same pen as summit chains.
      const localReliefSupport = clamp01((relief - crestReliefThreshold) / 8);
      if (relief > crestReliefThreshold) {
        const displacementAlongAxis = (gx * ux + gy * uy) / Math.max(1e-8, -eigenvalue);
        const displacementX = ux * displacementAlongAxis;
        const displacementY = uy * displacementAlongAxis;
        // The Hessian eigenvector is normalized above, so the displacement
        // vector has exactly the scalar length used to construct it. Avoid a
        // second norm and a second normalization in the candidate hot path.
        const displacement = Math.abs(displacementAlongAxis);
        const nx = ux;
        const ny = uy;
        const localProminenceScale = Math.max(
          24,
          regionalReliefMagnitude[i] * 0.68,
          physicalFeatureScale * 1.8,
        );
        const prominence = clamp01((crestZ - regionalElevation[i]) / localProminenceScale);
        const maxCrossingCorrection = Math.max(0.65, radius * 0.9);
        // Most Hessian cells are rejected here. Delay the three extra
        // candidate/cross-ridge samples until both correction distance and
        // broad prominence already prove that a crest is plausible.
        if (displacement > maxCrossingCorrection
          || prominence <= prominenceSupportThreshold) continue;
        // Evaluate the actual zero-crossing instead of accepting a Hessian
        // sample solely because its curvature is strong. Both neighbouring
        // faces must fall away from that crossing; this is the geometric
        // signature shared by lit and shadowed sides of a summit.
        let candidateX = x + displacementX;
        let candidateY = y + displacementY;
        const candidateZ = crestSample(candidateX, candidateY);
        const crossProbe = Math.max(1, radius * 0.85);
        const crossPlus = crestSample(candidateX + ux * crossProbe, candidateY + uy * crossProbe);
        const crossMinus = crestSample(candidateX - ux * crossProbe, candidateY - uy * crossProbe);
        const crossRelief = Math.min(candidateZ - crossPlus, candidateZ - crossMinus);
        const crossSupport = clamp01(crossRelief / localProminenceScale);
        if (crossRelief > Math.max(0.25, crestReliefThreshold * 0.25)) {
          // Lower spurs are rounded by the broad crest field, so their Hessian
          // centre lies mid-shoulder. Move those lines onto the brink where
          // the finer face field breaks into its steeper falloff.
          if (prominence < lowerCrestBrinkProminence) {
            const brink = findCrestBrink(candidateX, candidateY, ux, uy, localProminenceScale);
            if (brink) { candidateX = brink.x; candidateY = brink.y; }
          }
          crests.push({ x: candidateX, y: candidateY,
            nx, ny,
            strength: clamp01(localReliefSupport * 0.3 + prominence * 0.5 + crossSupport * 0.2),
            prominence,
            crossRelief });
          const candidateIndex = Math.round(candidateY) * width + Math.round(candidateX);
          if (candidateIndex >= 0 && candidateIndex < crestSupportCoverage.length
            && lineworkCoverage[candidateIndex]) crestSupportCoverage[candidateIndex] = 255;
        }
      }
    }
  }

  // Accumulation forms connected snowfields; microscopic slope changes must
  // not punch separate white flecks and black contour loops into each face.
  snow = smoothMountainField(snow, width, height, 7 * scale);
  for (let i = 0; i < snow.length; i++) {
    // Preserve the climate/slope eligibility while keeping partial eligibility
    // as one broad cartographic mass instead of erasing it at a hard 0.2
    // threshold. The illustration stage still shapes the final edge.
    const amount = clamp01((snow[i] - 0.04) / 0.3);
    snow[i] = coverage[i] ? amount * amount * (3 - 2 * amount) : 0;
  }

  // Rasterize ridge tangents through the same pressure/tooth brush as water
  // outlines. Coverage must be complete before any brush crosses a neighbour.
  const outline = (a: MountainLinePoint, b: MountainLinePoint, snowBoundary: boolean) => {
    if (ridgePenThickness === 0 || opacity === 0) return;
    const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
    const key = (Math.imul(Math.floor((x + ox) / (12 * scale)), 73856093)
      ^ Math.imul(Math.floor((y + oy) / (12 * scale)), 19349663) ^ seed) | 0;
    paintInkSegment(ink, lineworkCoverage, width, height,
      a.x, a.y, b.x, b.y,
      0.7 * scale * ridgePenThickness, key, 1.2, 0.25, 0.75, false, false,
      ox, oy, stride, (a.strength + b.strength) * 0.5 * opacity
        * (snowBoundary ? 1 : 1 - sampleScalarField(snow, width, height, x, y) * 0.72), drySkip * 0.3);
  };
  const contourConnectStop = profiler?.begin('mountain pattern crest contour linking');
  const ridgeSegments = connectMountainContours(
    crests, width, height, 9 * scale, crestSupportCoverage, lineworkCoverage,
  );
  contourConnectStop?.();
  const ridgeChainStop = profiler?.begin('mountain pattern ridge chain joining');
  // Contour detection can leave a few pixel gaps at a sharp saddle. Join only
  // facing endpoints, but allow enough room for one complete ink stroke.
  const rawChainStop = profiler?.begin('mountain pattern ridge segment chaining');
  const rawRidgeChains = chainMountainSegments(ridgeSegments);
  rawChainStop?.();
  const chainJoinStop = profiler?.begin('mountain pattern ridge endpoint joining');
  const ridgeChains = joinMountainChains(
    rawRidgeChains, 22 * scale, ox, oy,
    crestSupportCoverage, width, height,
  );
  chainJoinStop?.();
  // The Hessian finds every small local fold. Only retain substantial chains
  // as structural crests; using every local sample as a distance seed makes
  // the lower face look uniformly hairy instead of concentrating marks at the
  // principal creases.
  const ridgeSpanScale = 1 / Math.sqrt(Math.max(0.25, ridgeDensity));
  const structuralCandidates = ridgeChains.filter(points => {
    if (ridgeDensity <= 0) return false;
    if (points.length < 10) return false;
    let span = 0;
    for (let i = 1; i < points.length; i++) span += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    const first = points[0], last = points[points.length - 1];
    const closedLoop = Math.hypot(last.x - first.x, last.y - first.y) < 4 * scale;
    const endSpan = Math.hypot(last.x - first.x, last.y - first.y);
    return span >= 60 * scale * ridgeSpanScale && endSpan >= 24 * scale * ridgeSpanScale
      && span / Math.max(endSpan, 1) < 4.2
      && !(closedLoop && span < 72 * scale * ridgeSpanScale);
  });
  ridgeChainStop?.();
  const ridgeSelectStop = profiler?.begin('mountain pattern structural ridge selection');
  const structuralRidgeChains = selectStructuralRidgeChains(structuralCandidates, scale, ridgeDensity);
  ridgeSelectStop?.();
  profiler?.recordMetric('mountain pattern crest points', crests.length, 'count');
  profiler?.recordMetric('mountain pattern ridge segments', ridgeSegments.length, 'count');
  profiler?.recordMetric('mountain pattern ridge chains', ridgeChains.length, 'count');
  profiler?.recordMetric(
    'mountain pattern structural ridge chains',
    structuralRidgeChains.length,
    'count',
  );
  crestDetectionStop?.();
  const strokeTracingStop = profiler?.begin('mountain pattern stroke tracing and rasterization');
  const ridgeOutlineStop = profiler?.begin('mountain pattern ridge outline setup');
  for (const points of structuralRidgeChains) {
    for (let index = 1; index < points.length; index++) {
      outline(points[index - 1], points[index], false);
    }
  }
  const structuralCrests = structuralRidgeChains.length
    ? structuralRidgeChains.flatMap(points => points)
    : crests;
  // Keep hachure placement independent from the displayed primary-chain
  // selection. The complete crest candidate field restores the earlier
  // charcoal distribution while the connected structural chains remain the
  // only paths used for the main ridge ink.
  const hatchCrests = crests.length > 0 ? crests : structuralCrests;
  const hatchRidgeDistance = buildMountainRidgeDistance(hatchCrests, width, height);
  const hatchHasRidges = hatchCrests.length > 0;
  for (const [chainIndex, points] of structuralRidgeChains.entries()) {
    paths.push({ kind: 'ridge', key: seed ^ Math.imul(chainIndex + 1, 0x45d9f3b), width: 0.8 * scale * ridgePenThickness,
      opacity, primary: true, feature: 'crest', points });
  }
  // The deferred camera consumes the same terrain-derived crest paths. Do not
  // synthesize primary lines from material/biome coverage transitions: those
  // boundaries are paint changes, not terrain features.
  const ridgeInk = ink.slice();
  ridgeOutlineStop?.();

  type StreamPoint = { x: number; y: number; opacity: number };
  const classifyFeature = (x: number, y: number): MountainStrokePath['feature'] => {
    const slope = sampleScalarField(localSlope, width, height, x, y);
    const tpi = sampleScalarField(localTpi, width, height, x, y);
    const curvature = sampleScalarField(localCurvature, width, height, x, y);
    const curvatureSignal = Math.abs(curvature) * Math.max(dem.dxMeters, dem.dyMeters) * 20;
    const slopeBreak = Math.max(
      Math.abs(slope - sampleScalarField(localSlope, width, height, x - 2, y)),
      Math.abs(slope - sampleScalarField(localSlope, width, height, x + 2, y)),
      Math.abs(slope - sampleScalarField(localSlope, width, height, x, y - 2)),
      Math.abs(slope - sampleScalarField(localSlope, width, height, x, y + 2)),
    );
    if (slope >= 34 && (slopeBreak >= 6 || curvatureSignal >= 0.18)) return 'cliff';
    // The DEM stores a four-neighbour Laplacian: a convex crest is negative
    // and a concave hollow is positive. TPI catches broad incised channels
    // whose curvature has been softened by the feature filters.
    if (tpi < -8 || curvature > 0.01) return 'crevice';
    return 'rib';
  };
  const hatchSampleOpacity = (familyOpacity: number): number => familyOpacity;
  const emitStreamline = (stream: StreamPoint[], key: number, widthScale: number,
    kind: 'charcoal' | 'contour' = 'charcoal'): void => {
    if (stream.length < 8) return;
    const interruption = createCharcoalInterruptionPattern(key, scale,
      { breakProbability: 0.06, dashMin: 42, dashMax: 84, gapMin: 2, gapMax: 3 });
    const points = stream.map(({ x, y }) => ({ x, y }));
    // Both families carry the slider value on each sample. Use the same
    // average for the scalar path opacity because the illustration raster
    // paints the projected path, not the source stream-point alpha.
    const pathOpacity = stream.reduce((sum, point) => sum + point.opacity, 0) / stream.length;
    paths.push({ kind, key, width: widthScale * scale * thickness,
      opacity: pathOpacity, feature: classifyFeature(stream[0].x, stream[0].y), points });
    for (let step = 0; step < stream.length - 1; step++) {
      const a = stream[step], b = stream[step + 1];
      if (kind === 'charcoal' && isCharcoalInkActiveAtDistance(step * scale, interruption)) {
        paintInkSegment(ink, lineworkCoverage, width, height, a.x, a.y, b.x, b.y,
          widthScale * scale * thickness, key, 1.2,
          step / (stream.length - 1), (step + 1) / (stream.length - 1),
          true, true, ox, oy, stride, a.opacity, drySkip * 0.3);
      }
    }
  };
  const traceStreamline = (startX: number, startY: number, maxSteps: number,
    ridgeLimit: number): StreamPoint[] => {
    const stream: StreamPoint[] = [];
    let x = startX, y = startY;
    for (let step = 0; step < maxSteps; step++) {
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) break;
      const i = Math.round(y) * width + Math.round(x);
      if (!lineworkCoverage[i] || slopes[i] < 6) break;
      if (hatchHasRidges && sampleScalarField(hatchRidgeDistance, width, height, x, y) > ridgeLimit * scale) break;
      const flow = downhillFlow(x, y);
      if (flow.length < 0.01) break;
      stream.push({ x, y, opacity: hatchSampleOpacity(verticalHatchOpacity) });
      const nextX = x - flow.x * scale;
      const nextY = y - flow.y * scale;
      if (traceSample(nextX, nextY) >= traceSample(x, y)) break;
      x = nextX;
      y = nextY;
    }
    return stream;
  };

  // Primary streamlines are seeded along the selected crest skeleton. This
  // is the paper's structure-aware step: the broad feature hierarchy decides
  // where a face begins, while the flow field decides how its hatching bends.
  // It prevents a regular seed grid from turning a smooth face into a comb.
  const crestSeedSpacing = Math.max(10, Math.round(
    18 * scale / Math.sqrt(Math.max(0.25, hatchDensity)),
  ));
  let crestSeedCandidates = 0;
  let crestSeedStreams = 0;
  const crestHachureStop = profiler?.begin(
    'mountain pattern crest anchored hachures',
  );
  const crestBuckets = new Map<string, MountainLinePoint[]>();
  for (const point of hatchCrests) {
    const cellX = Math.floor((point.x + ox) / crestSeedSpacing);
    const cellY = Math.floor((point.y + oy) / crestSeedSpacing);
    const cellKey = `${cellX},${cellY}`;
    const bucket = crestBuckets.get(cellKey);
    if (bucket) bucket.push(point); else crestBuckets.set(cellKey, [point]);
  }
  const emitCrestHachure = (point: MountainLinePoint, key: number, offsetMultiplier = 1): boolean => {
    const normalLength = Math.max(1e-6, Math.hypot(point.nx, point.ny));
    const nx = point.nx / normalLength, ny = point.ny / normalLength;
    const probe = 9 * scale;
    const plus = faceSample(point.x + nx * probe, point.y + ny * probe);
    const minus = faceSample(point.x - nx * probe, point.y - ny * probe);
    const side = plus <= minus ? 1 : -1;
    const offset = (7 + hash01(key, 23) * 6) * scale * offsetMultiplier;
    const stream = traceStreamline(point.x + nx * side * offset, point.y + ny * side * offset,
      Math.round(34 + (point.strength + (point.prominence ?? 0)) * 28), 58);
    if (stream.length < 8) return false;
    emitStreamline(stream, key, 0.5 + hash01(key, 29) * 0.14);
    return true;
  };
  const cellDistance = crestSeedSpacing * 0.9;
  for (let cellY = Math.floor(oy / crestSeedSpacing) - 1;
    cellY <= Math.floor((oy + height) / crestSeedSpacing) + 1; cellY++) {
    for (let cellX = Math.floor(ox / crestSeedSpacing) - 1;
      cellX <= Math.floor((ox + width) / crestSeedSpacing) + 1; cellX++) {
      let point: MountainLinePoint | undefined;
      let nearest = Infinity;
      const centerX = (cellX + 0.5) * crestSeedSpacing - ox;
      const centerY = (cellY + 0.5) * crestSeedSpacing - oy;
      for (let by = cellY - 1; by <= cellY + 1; by++) for (let bx = cellX - 1; bx <= cellX + 1; bx++) {
        for (const candidate of crestBuckets.get(`${bx},${by}`) ?? []) {
          const distance = Math.hypot(candidate.x - centerX, candidate.y - centerY);
          if (distance < nearest) { nearest = distance; point = candidate; }
        }
      }
      if (!point || nearest > cellDistance) continue;
      const key = seed ^ 0x6d2b79f5 ^ Math.imul(cellX, 0x27d4eb2d) ^ Math.imul(cellY, 0x165667b1);
      if (hatchDensity <= 0 || (hatchDensity < 1 && hash01(key, 19) > hatchDensity)) continue;
      if (profiler) crestSeedCandidates++;
      if (emitCrestHachure(point, key)) {
        if (profiler) crestSeedStreams++;
        // Keep the existing crest-anchored mark as the 1x baseline. In
        // lower-relief terrain, add an occasional parallel mark rather than
        // thinning or relocating the original one.
        const localDetail = detailDensityAt(point.x, point.y);
        const extraChance = clamp01(
          (localDetail - 1) / Math.max(1e-6, localDetailDensityMax - 1),
        ) * clamp01(hatchDensity);
        if (extraChance > 0 && hash01(key, 97) < extraChance) {
          const tangentSign = hash01(key, 101) < 0.5 ? -1 : 1;
          const tangentDistance = (0.24 + hash01(key, 103) * 0.22) * crestSeedSpacing;
          const extraPoint: MountainLinePoint = {
            ...point,
            x: point.x - point.ny * tangentSign * tangentDistance,
            y: point.y + point.nx * tangentSign * tangentDistance,
          };
          if (emitCrestHachure(extraPoint, key ^ 0x7f4a7c15, 1.45)) {
            if (profiler) {
              crestSeedCandidates++;
              crestSeedStreams++;
            }
          }
        }
      }
    }
  }
  crestHachureStop?.();
  profiler?.recordMetric(
    'mountain pattern crest seed candidates',
    crestSeedCandidates,
    'count',
  );
  profiler?.recordMetric(
    'mountain pattern crest streams',
    crestSeedStreams,
    'count',
  );

  // The reference uses a second family of marks that wraps across a face.
  // These are contour hachures: rotate the downhill field by 90 degrees and
  // keep the streamline near its starting elevation. The result is a set of
  // broken, nearly horizontal bands after the oblique projection, while the
  // downhill family above still describes gullies and steep ribs.
  // The contour family carries the broad face structure in the reference.
  // Keep it attached to a structural crest, but let it travel well into the
  // face instead of ending after the first narrow ridge band. The reach is
  // deliberately measured in world pixels so preview and export retain the
  // same hatching hierarchy.
  const contourReach = 132 * scale;
  const traceContourStreamline = (startX: number, startY: number,
    maxSteps: number, direction: number): StreamPoint[] => {
    const stream: StreamPoint[] = [];
    let x = startX, y = startY;
    for (let step = 0; step < maxSteps; step++) {
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) break;
      const i = Math.round(y) * width + Math.round(x);
      if (!lineworkCoverage[i] || slopes[i] < 6) break;
      if (hatchHasRidges && sampleScalarField(hatchRidgeDistance, width, height, x, y) > contourReach) break;
      const flow = downhillFlow(x, y);
      if (flow.length < 0.01) break;
      const tangentX = -flow.y * direction;
      const tangentY = flow.x * direction;
      const nextX = x + tangentX * scale * 1.05;
      const nextY = y + tangentY * scale * 1.05;
      const elevationDelta = Math.abs(traceSample(nextX, nextY) - traceSample(x, y));
      // At a saddle the tangent is ill-conditioned. End the band instead of
      // letting it jump across a neighbouring face. The previous three-metre
      // floor stopped almost every band after a few samples on ordinary DEMs;
      // a softer tolerance keeps the line near its contour while allowing the
      // hand-drawn runs to span a meaningful part of the face.
      const driftLimit = Math.max(8, flow.length * scale * 0.42);
      if (elevationDelta > driftLimit) break;
      // Contour bands use their own slider directly; terrain angle controls
      // eligibility and direction, not the resulting line opacity.
      stream.push({ x, y, opacity: hatchSampleOpacity(horizontalHatchOpacity) });
      x = nextX;
      y = nextY;
    }
    return stream;
  };
  const contourSpacing = Math.max(9, Math.round(
    15 * scale / Math.sqrt(Math.max(0.25, hatchDensity)),
  ));
  const contourLengthScale = Math.max(0.65, Math.min(2, options.detailLengthScale ?? 1));
  let contourSeedCandidates = 0;
  let contourStreams = 0;
  const contourHachureStop = profiler?.begin(
    'mountain pattern contour hachures',
  );
  for (let cy = Math.floor(oy / contourSpacing); cy <= Math.floor((oy + height) / contourSpacing); cy++) {
    for (let cx = Math.floor(ox / contourSpacing); cx <= Math.floor((ox + width) / contourSpacing); cx++) {
      const key = (Math.imul(cx, 0x632be5ab) ^ Math.imul(cy, 0x85157af5) ^ seed ^ 0x3c6ef372) | 0;
      const x = (cx + 0.18 + hash01(key, 61) * 0.64) * contourSpacing - ox;
      const y = (cy + 0.18 + hash01(key, 67) * 0.64) * contourSpacing - oy;
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
      const i = Math.round(y) * width + Math.round(x);
      if (!lineworkCoverage[i] || slopes[i] < 6) continue;
      const ridgeDistanceAtAnchor = sampleScalarField(hatchRidgeDistance, width, height, x, y);
      const ridgeBand = hatchHasRidges ? clamp01(1 - ridgeDistanceAtAnchor / contourReach) : 0.35;
      // Use crop-safe physical fields here. Hillshade is an optional global
      // cache and export crops intentionally omit it; slope and crest distance
      // give the same shadow-side preference without breaking tile identity.
      const shadowWeight = clamp01((slopes[i] - 12) / 34) * 0.68 + ridgeBand * 0.22;
      // Preserve a reliable lower-face population. The contour family is
      // already filtered by coverage, slope, ridge reach, and contour drift;
      // an overly small random floor made the horizontal family disappear
      // before any opacity setting could affect it.
      const lowerFacePresence = hatchHasRidges ? 0.07 * clamp01((slopes[i] - 5) / 25) : 0.04;
      const importanceBoost = featureImportance[i] * 0.08;
      const acceptance = clamp01((0.14 + lowerFacePresence + ridgeBand * 0.24 + shadowWeight * 0.28 + importanceBoost)
         * sideRidgeDensity * hatchDensity * detailDensityAt(x, y));
      if (hash01(key, 71) > acceptance) continue;
      if (profiler) contourSeedCandidates++;
      const direction = hash01(key, 73) < 0.5 ? -1 : 1;
      const steps = Math.round((28 + hash01(key, 79) * 46 + featureImportance[i] * 14
        + clamp01((slopes[i] - 16) / 38) * 24) * Math.max(0.7, contourLengthScale));
      const stream = traceContourStreamline(x, y, steps, direction);
      if (stream.length >= 8) {
        if (profiler) contourStreams++;
        emitStreamline(stream, key, 0.5 + hash01(key, 83) * 0.14, 'contour');
      }
    }
  }
  contourHachureStop?.();
  profiler?.recordMetric(
    'mountain pattern contour seed candidates',
    contourSeedCandidates,
    'count',
  );
  profiler?.recordMetric(
    'mountain pattern contour streams',
    contourStreams,
    'count',
  );

  // World-spaced primary creases follow downhill terrain. Secondary creases
  // are retained only where the terrain takes them into a primary chain.
  // Hachures are grouped marks inside a face, not a uniform texture. A
  // slightly wider world spacing leaves room for the major crest and lets the
  // lower face breathe like the reference drawing.
  const spacing = 17 * scale / Math.sqrt(Math.max(0.25, sideRidgeDensity * hatchDensity));
  const detailLengthScale = Math.max(0.65, Math.min(2, options.detailLengthScale ?? 1));
  const secondaryMaxRidgeDistance = 58 * scale;
  const secondaryLineRidgeDistance = 31 * scale;
  const secondaryShortRange = 18 * scale;
  const secondaryBranchJoinRadius = 1.8 * scale;
  let secondarySeedCandidates = 0;
  let secondaryLinePaths = 0;
  const secondaryCreaseStop = profiler?.begin(
    'mountain pattern secondary creases',
  );
  for (let cy = Math.floor(oy / spacing); cy <= Math.floor((oy + height) / spacing); cy++) {
    for (let cx = Math.floor(ox / spacing); cx <= Math.floor((ox + width) / spacing); cx++) {
      const key = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ seed) | 0;
      const anchorX = (cx + 0.15 + hash01(key, 31) * 0.7) * spacing - ox;
      const anchorY = (cy + 0.15 + hash01(key, 37) * 0.7) * spacing - oy;
      const ridgeDistanceAtAnchor = sampleScalarField(hatchRidgeDistance, width, height, anchorX, anchorY);
      const ridgeBand = hatchHasRidges
        ? Math.pow(clamp01(1 - ridgeDistanceAtAnchor / (62 * scale)), 1.15)
        : 0.35;
      const localDetail = detailDensityAt(anchorX, anchorY);
      if (hatchHasRidges && (ridgeDistanceAtAnchor < 5 * scale || ridgeDistanceAtAnchor > 62 * scale)) continue;
      // Nearly every seed close to a main crease survives; the probability
      // falls off sharply toward the foot where only a few broken marks are
      // useful. This leaves the lower face open for dots and wash.
      if (sideRidgeDensity <= 0 || hatchDensity <= 0
        || hash01(key, 53) > clamp01((0.028 + ridgeBand * 0.48) * sideRidgeDensity * localDetail)) continue;
      if (profiler) secondarySeedCandidates++;
      let x = anchorX;
      let y = anchorY;
      const steps = Math.round((hatchHasRidges
        ? 48 + Math.floor(hash01(key, 41) * 16)
        : 72 + Math.floor(hash01(key, 41) * 25)) * detailLengthScale);
      const interruption = createCharcoalInterruptionPattern(key, scale,
        { breakProbability: 0.08, dashMin: 56, dashMax: 96, gapMin: 2, gapMax: 3 });
      const path: { x: number; y: number; opacity: number }[] = [];
      let currentElevation = 0;
      let hasCurrentElevation = false;
      for (let step = 0; step < steps; step++) {
        if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) break;
        const i = Math.round(y) * width + Math.round(x);
        // The oblique relief exaggerates these physical slopes into visible
        // faces, so their structural hatching must start below alpine cliffs.
        if (!lineworkCoverage[i] || slopes[i] < 6) break;
        if (hatchHasRidges && step > 8 && sampleScalarField(hatchRidgeDistance, width, height, x, y) > secondaryMaxRidgeDistance) break;
        const flow = downhillFlow(x, y);
        if (flow.length < 0.01) break;
        const nextX = x - flow.x * scale;
        const nextY = y - flow.y * scale;
        const nextElevation = traceSample(nextX, nextY);
        const elevation = hasCurrentElevation ? currentElevation : traceSample(x, y);
        if (nextElevation >= elevation) break;
       const strokeOpacity = hatchSampleOpacity(verticalHatchOpacity);
        path.push({ x, y, opacity: strokeOpacity });
        x = nextX; y = nextY;
        currentElevation = nextElevation;
        hasCurrentElevation = true;
      }
      // Keep the drawn chain close to its parent crease. The tail of a
      // downhill trace is represented by an occasional dot, so the foot of
      // the face stays open instead of filling with parallel hairlines.
      const lineCut = hatchHasRidges ? path.findIndex((point, index) => index > 5
        && sampleScalarField(hatchRidgeDistance, width, height, point.x, point.y) > secondaryLineRidgeDistance) : -1;
      let linePath = hatchHasRidges ? path.slice(0, lineCut < 0 ? path.length : lineCut) : path;
      if (hatchHasRidges && ridgeDistanceAtAnchor > secondaryLineRidgeDistance) {
        // A seed already low on the face may add a short mark or a dot, but
        // it must not carry a full crest-length stroke into the valley.
        const shortLength = Math.max(0, Math.round(10 - clamp01((ridgeDistanceAtAnchor - secondaryLineRidgeDistance) / secondaryShortRange) * 10));
        linePath = path.slice(0, Math.min(linePath.length, shortLength));
      }
      if (hatchHasRidges) {
        // Even a trace that stays inside the ridge band can run a long way on
        // a broad face. Let the near-crest band carry the longest mark and
        // taper every lower seed to a compact charcoal stroke.
        const bandLength = Math.max(7, Math.round((20 + ridgeBand * 34) * detailLengthScale));
        linePath = linePath.slice(0, Math.min(linePath.length, bandLength));
      }
      const tail = hatchHasRidges ? path.slice(linePath.length) : [];
      const linePathAccepted = linePath.length >= 8;
      const lineWidthNoise = linePathAccepted ? hash01(key, 47) : 0;
      if (linePathAccepted) {
        if (profiler) secondaryLinePaths++;
        const lineOpacity = linePath.reduce((sum, point) => sum + point.opacity, 0) / linePath.length;
         paths.push({ kind: 'charcoal', key,
           width: (0.44 + 0.14 * lineWidthNoise) * scale * thickness
            * (1 + ridgeBand * 0.28), opacity: lineOpacity,
           feature: classifyFeature(linePath[0].x, linePath[0].y), points: linePath });
       }
      if (tail.length && hash01(key, 107) < 0.16 + (1 - ridgeBand) * 0.22) {
        const dot = tail[Math.min(tail.length - 1, Math.floor(tail.length * (0.35 + hash01(key, 109) * 0.45)))];
        paths.push({ kind: 'dot', key: key ^ 0x51f2, width: (0.78 + hash01(key, 113) * 0.32) * scale * thickness,
          opacity: dot.opacity, feature: classifyFeature(dot.x, dot.y), points: [{ x: dot.x, y: dot.y }] });
      }
      if (!linePathAccepted) continue;
      // A side crease must actually join its parent. Offset copies of the
      // same fall line produced comb-like bundles across the snowfields.
      if (linePath.length > 30 && hash01(key, 173) < clamp01((0.2 + ridgeBand * 0.18) * localDetail)) {
        const junction = linePath[Math.floor(linePath.length * 0.45)];
        const dx = sample(junction.x + radius, junction.y) - sample(junction.x - radius, junction.y);
        const dy = sample(junction.x, junction.y + radius) - sample(junction.x, junction.y - radius);
        const norm = Math.max(1e-6, Math.hypot(dx, dy));
        const side = hash01(key, 71) < 0.5 ? -1 : 1;
        let bx = junction.x + (dx * 6 - dy * side * 10) / norm * scale;
        let by = junction.y + (dy * 6 + dx * side * 10) / norm * scale;
        const branch: { x: number; y: number }[] = [];
        let attached = false;
        let branchElevation = 0;
        let hasBranchElevation = false;
        const branchSteps = hatchHasRidges ? Math.max(8, Math.round(8 + ridgeBand * 10)) : 40;
        for (let step = 0; step < branchSteps; step++) {
          if (bx < 1 || by < 1 || bx >= width - 1 || by >= height - 1
            || !lineworkCoverage[Math.round(by) * width + Math.round(bx)]) break;
          branch.push({ x: bx, y: by });
          const join = linePath.find(p => Math.hypot(p.x - bx, p.y - by) < secondaryBranchJoinRadius);
          if (join) { branch.push(join); attached = true; break; }
          const flow = downhillFlow(bx, by);
          if (flow.length < 0.01) break;
          const nx = bx - flow.x * scale, ny = by - flow.y * scale;
          const nextElevation = sample(nx, ny);
          const elevation = hasBranchElevation ? branchElevation : sample(bx, by);
          if (nextElevation >= elevation) break;
          bx = nx; by = ny;
          branchElevation = nextElevation;
          hasBranchElevation = true;
        }
        if (attached && branch.length >= 8) paths.push({ kind: 'charcoal', key: key ^ 1709,
          parentKey: key, width: 0.24 * scale * thickness,
          opacity: verticalHatchOpacity * 0.34,
          feature: classifyFeature(branch[0].x, branch[0].y), points: branch });
      }
      for (let step = 0; step < linePath.length - 1; step++) {
        const a = linePath[step], b = linePath[step + 1];
        if (thickness > 0 && isCharcoalInkActiveAtDistance(step * scale, interruption)) {
           paintInkSegment(ink, lineworkCoverage, width, height, a.x, a.y, b.x, b.y,
             (0.44 + 0.2 * lineWidthNoise) * scale * thickness, key, 1.2,
            step / (linePath.length - 1), (step + 1) / (linePath.length - 1), true, true, ox, oy, stride, a.opacity, drySkip * 0.3);
        }
      }
    }
  }
  secondaryCreaseStop?.();
  profiler?.recordMetric(
    'mountain pattern secondary seed candidates',
    secondarySeedCandidates,
    'count',
  );
  profiler?.recordMetric(
    'mountain pattern secondary line paths',
    secondaryLinePaths,
    'count',
  );

  // Snow is a surface material, not an enclosed outlined polygon. Only real
  // crests and occluding cliffs receive the dark structural outline.
  profiler?.recordMetric('mountain pattern generated paths', paths.length, 'count');
  strokeTracingStop?.();
  const primaryRidgePaths = paths.filter(path => path.kind === 'ridge' && path.primary);
  const surfaceElevation = Float32Array.from(
    elevation,
    value => value + geometryDatumOffset,
  );
  return {
    coverage, lineworkCoverage, detailDensity: mountainDetailDensity,
    snow, ink, wash, surfaceElevation, ridgeInk, paths,
    cameraRidgePaths: primaryRidgePaths,
  };
}

/** Soft pigment shadow; evaluated separately so sun edits reuse mountain ink. */
export function renderMountainPatternShadow(
  overlay: MountainPatternOverlay, width: number, height: number,
  sunAzimuthDeg: number, scale = 1, profiler?: MountainProfiler,
): Float32Array {
  const shadowStop = profiler?.begin('mountain pattern shadow');
  const result = new Float32Array(width * height);
  const azimuth = sunAzimuthDeg * Math.PI / 180;
  const dx = -Math.sin(azimuth) * 2.2 * scale;
  const dy = Math.cos(azimuth) * 2.2 * scale;
  const taps = [[0, 0, 0.4], [-1, 0, 0.15], [1, 0, 0.15], [0, -1, 0.15], [0, 1, 0.15]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!(overlay.lineworkCoverage ?? overlay.coverage)[i]) continue;
      let shadow = 0;
      for (const [tx, ty, weight] of taps) {
        const sx = x - dx + tx * scale, sy = y - dy + ty * scale;
        if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) continue;
        shadow += sampleScalarField(overlay.ink, width, height, sx, sy) / 255 * weight;
      }
      // Pigment settles below bright wash patches, like the vegetation wash.
      const upstream = sampleScalarField(overlay.wash, width, height, x - dx, y - dy);
      result[i] = clamp01((shadow * 0.25 + Math.max(0, upstream - overlay.wash[i]) * 0.12)
        * (0.9 + overlay.wash[i] * 0.15));
    }
  }
  shadowStop?.();
  return result;
}

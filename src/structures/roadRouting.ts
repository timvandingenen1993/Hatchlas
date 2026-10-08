/**
 * Terrain-aware road routing over the analysed DEM.
 *
 * The DEM is reduced to a routing grid (at most `maxEdge` cells on the long
 * side). A* runs on that grid with 16-connected moves (8 neighbours plus
 * knight moves) so headings are not limited to 45° steps. Move cost grows
 * with the directional grade, which lets a road contour or switchback across
 * a slope instead of climbing it head-on.
 *
 * Ordinary moves stay on land. Rivers and pools are crossed only by a
 * crossing jump: a straight hop from a bank cell, over water alone, to the
 * first land cell on the far side, no longer than the maximum bridge length.
 * Every cost is in metres of equivalent detour. A bridge costs a modest
 * fixed amount plus a length cost that climbs steeply past the typical
 * bridge length, so a moderate detour that halves a long bridge pays off,
 * while a short bridge is never avoided by a long detour. A road can never
 * run lengthwise along a river. Ocean and lakes are blocked.
 */
import type {
  MapPoint,
  RoadKind,
  RoadRoute,
  RouteCrossing,
  RoutingSettings,
} from "./types";
import { ROAD_KIND_GRADE_SCALE } from "./types";

/**
 * Share of each cell covered by placed props (forest stands, shrubs,
 * boulders), 0..255, on its own coarse grid spanning the whole map.
 */
export interface VegetationCoverGrid {
  width: number;
  height: number;
  data: Uint8Array;
}

/** DEM fields the router reads; a structural subset of `MountainDEMData`. */
export interface RoutingDemFields {
  width: number;
  height: number;
  dxMeters: number;
  dyMeters: number;
  elevation: ArrayLike<number>;
  /** Crossable water: river channels and, when known, wetland pools. */
  isRiverChannel: ArrayLike<number>;
  strahlerOrder: ArrayLike<number>;
  isOcean: ArrayLike<number>;
  biomeType: ArrayLike<number>;
  lakeDepthM?: ArrayLike<number>;
  wetlandPoolMask?: ArrayLike<number>;
  vegetationCover?: VegetationCoverGrid | null;
}

export const WATER_LAND = 0;
export const WATER_RIVER = 1;
export const WATER_BLOCKED = 2;

export interface RoutingTerrain {
  width: number;
  height: number;
  cellWidthM: number;
  cellHeightM: number;
  elevation: Float32Array;
  /** WATER_LAND, WATER_RIVER or WATER_BLOCKED (ocean, lake). */
  water: Uint8Array;
  /** Largest Strahler order inside the cell (at least 1 for river cells). */
  riverSize: Uint8Array;
  /** Ground difficulty multiplier, >= 1. */
  terrainFactor: Float32Array;
  /** Prop cover 0..1 (forest and shrub stands), when known. */
  vegetation: Float32Array;
}

/** Biome travel difficulty, indexed by `MountainBiomeId`. */
const BIOME_TERRAIN_FACTOR = [
  6, // glacier
  2, // bare rock & scree
  1.1, // alpine tundra
  1.25, // subalpine conifer
  1.2, // montane broadleaf
  1.4, // riparian shrubland
  2.5, // braided gravel bar
  2.2, // floodplain & wetland
  1, // ocean (blocked separately)
  1.1, // river silt
  1.8, // river rock & scree bank
  1.3, // sandy beach
  1.8, // silty beach & river mouth
  2, // rocky shore
  5, // coastal cliff
];
const WETLAND_POOL_FACTOR = 4;

export function buildRoutingTerrain(
  dem: RoutingDemFields,
  maxEdge = 1024,
): RoutingTerrain {
  const factor = Math.max(1, Math.ceil(Math.max(dem.width, dem.height) / maxEdge));
  const width = Math.ceil(dem.width / factor);
  const height = Math.ceil(dem.height / factor);
  const total = width * height;
  const elevation = new Float32Array(total);
  const water = new Uint8Array(total);
  const riverSize = new Uint8Array(total);
  const terrainFactor = new Float32Array(total);
  for (let gy = 0; gy < height; gy++) {
    const y0 = gy * factor;
    const y1 = Math.min(dem.height, y0 + factor);
    for (let gx = 0; gx < width; gx++) {
      const x0 = gx * factor;
      const x1 = Math.min(dem.width, x0 + factor);
      let count = 0;
      let elevationSum = 0;
      let blocked = 0;
      let river = 0;
      let pool = false;
      let maxOrder = 0;
      let factorSum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const index = y * dem.width + x;
          count++;
          elevationSum += dem.elevation[index];
          const isBlocked = dem.isOcean[index] > 0 || (dem.lakeDepthM?.[index] ?? 0) > 0;
          if (isBlocked) {
            blocked++;
            factorSum += 1;
            continue;
          }
          const isPool = (dem.wetlandPoolMask?.[index] ?? 0) > 0;
          if (dem.isRiverChannel[index] > 0) {
            river++;
            maxOrder = Math.max(maxOrder, dem.strahlerOrder[index]);
            if (isPool) pool = true;
          }
          factorSum += isPool
            ? WETLAND_POOL_FACTOR
            : BIOME_TERRAIN_FACTOR[dem.biomeType[index]] ?? 1.2;
        }
      }
      const cell = gy * width + gx;
      elevation[cell] = elevationSum / count;
      terrainFactor[cell] = Math.max(1, factorSum / count);
      if (blocked * 2 > count) {
        water[cell] = WATER_BLOCKED;
      } else if (river > 0) {
        water[cell] = WATER_RIVER;
        // Pools are crossed on a causeway or bridge, never forded.
        riverSize[cell] = Math.max(1, maxOrder, pool ? 3 : 0);
      }
    }
  }
  const vegetation = new Float32Array(total);
  const cover = dem.vegetationCover;
  if (cover && cover.width > 0 && cover.height > 0) {
    for (let gy = 0; gy < height; gy++) {
      const cy = Math.min(cover.height - 1, Math.floor(((gy + 0.5) / height) * cover.height));
      for (let gx = 0; gx < width; gx++) {
        const cx = Math.min(cover.width - 1, Math.floor(((gx + 0.5) / width) * cover.width));
        vegetation[gy * width + gx] = cover.data[cy * cover.width + cx] / 255;
      }
    }
  }
  // Wide channels carry their Strahler order only near the centerline. Spread
  // the order across each channel so every bridge cell knows the river size.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let index = 0; index < total; index++) {
      if (water[index] !== WATER_RIVER) continue;
      const x = index % width;
      const y = (index - x) / width;
      let best = riverSize[index];
      if (x > 0 && water[index - 1] === WATER_RIVER) best = Math.max(best, riverSize[index - 1]);
      if (x < width - 1 && water[index + 1] === WATER_RIVER) best = Math.max(best, riverSize[index + 1]);
      if (y > 0 && water[index - width] === WATER_RIVER) best = Math.max(best, riverSize[index - width]);
      if (y < height - 1 && water[index + width] === WATER_RIVER) best = Math.max(best, riverSize[index + width]);
      if (best !== riverSize[index]) {
        riverSize[index] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return {
    width,
    height,
    cellWidthM: Math.max(1e-6, dem.dxMeters) * factor,
    cellHeightM: Math.max(1e-6, dem.dyMeters) * factor,
    elevation,
    water,
    riverSize,
    terrainFactor,
    vegetation,
  };
}

export interface RoutingParams {
  /** Comfortable grade as a fraction (0.12 = 12 %). */
  maxGrade: number;
  slopeAvoidance: number;
  bridgePenaltyM: number;
  allowFords: boolean;
  forestAvoidance: number;
  /** Longest crossing, bank to bank, in metres. */
  maxBridgeM: number;
  /** Bridge length beyond which each extra metre gets steeply dearer. */
  typicalBridgeM: number;
  /** Extra cost (fraction) a straightened climbing leg may add over the routed path. */
  straightenTolerance: number;
  /** Shortest leg between two turns on a climb, in metres. */
  minLegM: number;
}

export function resolveRoutingParams(
  settings: RoutingSettings,
  kind: RoadKind,
): RoutingParams {
  return {
    maxGrade: Math.max(0.01, (settings.maxGradePct / 100) * ROAD_KIND_GRADE_SCALE[kind]),
    slopeAvoidance: Math.max(0, settings.slopeAvoidance),
    bridgePenaltyM: Math.max(0, settings.bridgeReluctanceKm * 1000),
    allowFords: settings.allowFords,
    forestAvoidance: Math.max(0, settings.forestAvoidance ?? 0),
    maxBridgeM: Math.max(10, settings.maxBridgeLengthM ?? 300),
    typicalBridgeM: Math.max(10, settings.typicalBridgeLengthM ?? 150),
    straightenTolerance: 0.02 + 0.25 * Math.max(0, Math.min(1, settings.straightness ?? 0.5)),
    minLegM: Math.max(0, settings.minLegLengthM ?? 200),
  };
}

/** Grades above this multiple of the comfortable maximum are a last resort. */
export const HARD_GRADE_RATIO = 1.6;

/** Cost multiplier for climbing at `grade` (rise over run). */
function slopeCostFactor(grade: number, params: RoutingParams): number {
  const ratio = grade / params.maxGrade;
  let factor = 1 + params.slopeAvoidance * ratio * ratio;
  if (ratio > 1) factor += 10 * (ratio - 1);
  if (grade > params.maxGrade * HARD_GRADE_RATIO) factor *= 25;
  return factor;
}

const MOVES: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 1], [2, -1], [-2, 1], [-2, -1],
  [1, 2], [1, -2], [-1, 2], [-1, -2],
];

function isFord(terrain: RoutingTerrain, cell: number, params: RoutingParams): boolean {
  return params.allowFords && terrain.riverSize[cell] <= 2;
}

/**
 * Cost of one crossing, in metres of equivalent detour. `waterM` is the
 * length over water; `size` is the largest river order crossed.
 */
function crossingCost(waterM: number, size: number, ford: boolean, params: RoutingParams): number {
  if (ford) {
    // Cheap enough to beat a long detour, but not so cheap that a road
    // weaves back and forth across one stream.
    return params.bridgePenaltyM * 0.25 * size + waterM * 3;
  }
  // Bigger rivers ask a little more of every bridge (piers, approaches);
  // most of the difference is already in their width.
  const fixed = params.bridgePenaltyM * (0.7 + 0.1 * Math.min(6, size));
  const relative = waterM / params.typicalBridgeM;
  return fixed + waterM * 4 * (1 + relative * relative);
}

/** Unit directions crossing jumps are tried along: the 16 move headings. */
const JUMP_DIRECTIONS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 1], [2, -1], [-2, 1], [-2, -1],
  [1, 2], [1, -2], [-1, 2], [-1, -2],
].map(([dx, dy]) => {
  const length = Math.hypot(dx, dy);
  return [dx / length, dy / length] as const;
});

/** Cells a non-orthogonal move sweeps across between its endpoints. */
function intermediateCells(
  x: number,
  y: number,
  dx: number,
  dy: number,
  width: number,
): [number, number] | null {
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
    return [y * width + x + sx, (y + sy) * width + x];
  }
  if (Math.abs(dx) === 2) {
    return [y * width + x + sx, (y + sy) * width + x + sx];
  }
  if (Math.abs(dy) === 2) {
    return [(y + sy) * width + x, (y + sy) * width + x + sx];
  }
  return null;
}

class MinHeap {
  private keys = new Float64Array(1024);
  private values = new Int32Array(1024);
  size = 0;

  push(key: number, value: number): void {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.keys = keys;
      const values = new Int32Array(this.size * 2);
      values.set(this.values);
      this.values = values;
    }
    let index = this.size++;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[index] = this.keys[parent];
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.keys[index] = key;
    this.values[index] = value;
  }

  pop(): number {
    const top = this.values[0];
    const lastKey = this.keys[--this.size];
    const lastValue = this.values[this.size];
    let index = 0;
    for (;;) {
      let child = index * 2 + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= lastKey) break;
      this.keys[index] = this.keys[child];
      this.values[index] = this.values[child];
      index = child;
    }
    this.keys[index] = lastKey;
    this.values[index] = lastValue;
    return top;
  }
}

export function pointToCell(terrain: RoutingTerrain, point: MapPoint): number {
  const x = Math.max(0, Math.min(terrain.width - 1, Math.floor(point.u * terrain.width)));
  const y = Math.max(0, Math.min(terrain.height - 1, Math.floor(point.v * terrain.height)));
  return y * terrain.width + x;
}

/** Nearest dry land cell, searched in growing rings. */
function nearestPassableCell(terrain: RoutingTerrain, cell: number, maxRadius = 48): number {
  if (terrain.water[cell] === WATER_LAND) return cell;
  const { width, height } = terrain;
  const cx = cell % width;
  const cy = (cell - cx) / width;
  for (let radius = 1; radius <= maxRadius; radius++) {
    let best = -1;
    let bestDistance = Infinity;
    for (let y = cy - radius; y <= cy + radius; y++) {
      if (y < 0 || y >= height) continue;
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x < 0 || x >= width) continue;
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== radius) continue;
        const index = y * width + x;
        if (terrain.water[index] !== WATER_LAND) continue;
        const distance = (x - cx) ** 2 + (y - cy) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
    }
    if (best >= 0) return best;
  }
  return cell;
}

export interface SegmentRoute {
  /** Routing-grid cell indices from start to goal, inclusive. */
  cells: number[];
  /** False when no passable path exists and a straight line was used. */
  found: boolean;
}

function straightCells(terrain: RoutingTerrain, start: number, goal: number): number[] {
  const { width } = terrain;
  let x0 = start % width;
  let y0 = (start - x0) / width;
  const x1 = goal % width;
  const y1 = (goal - x1) / width;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  const cells: number[] = [];
  for (;;) {
    cells.push(y0 * width + x0);
    if (x0 === x1 && y0 === y1) break;
    const doubled = error * 2;
    if (doubled >= dy) {
      error += dy;
      x0 += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y0 += sy;
    }
  }
  return cells;
}

/** Least-cost route between two map points. */
export function routeSegment(
  terrain: RoutingTerrain,
  from: MapPoint,
  to: MapPoint,
  params: RoutingParams,
): SegmentRoute {
  const { width, height, cellWidthM, cellHeightM, elevation, water, terrainFactor, vegetation } = terrain;
  const forestWeight = params.forestAvoidance * 2;
  const start = nearestPassableCell(terrain, pointToCell(terrain, from));
  const goal = nearestPassableCell(terrain, pointToCell(terrain, to));
  if (start === goal) return { cells: [start], found: true };
  if (water[start] !== WATER_LAND || water[goal] !== WATER_LAND) {
    return { cells: straightCells(terrain, start, goal), found: false };
  }
  const total = width * height;
  const gScore = new Float64Array(total).fill(Infinity);
  const cameFrom = new Int32Array(total).fill(-1);
  // 1 where a cell was reached by a crossing jump from its `cameFrom` cell.
  const reachedByJump = new Uint8Array(total);
  const closed = new Uint8Array(total);
  const jumpStep = 0.5;
  const cellMinM = Math.min(cellWidthM, cellHeightM);
  const jumpLanding = new Int32Array(JUMP_DIRECTIONS.length);
  const jumpSpanM = new Float64Array(JUMP_DIRECTIONS.length);
  const jumpSize = new Uint8Array(JUMP_DIRECTIONS.length);
  const jumpFordable = new Uint8Array(JUMP_DIRECTIONS.length);
  const maxJumpCells = Math.max(2, Math.ceil(params.maxBridgeM / Math.min(cellWidthM, cellHeightM)) + 1);
  const heap = new MinHeap();
  const goalX = goal % width;
  const goalY = (goal - goalX) / width;
  // A slightly inflated heuristic keeps searches bounded on large grids at a
  // negligible cost in route quality.
  const heuristic = (cell: number): number => {
    const x = cell % width;
    const y = (cell - x) / width;
    return Math.hypot((x - goalX) * cellWidthM, (y - goalY) * cellHeightM) * 1.05;
  };
  const moveDistance = MOVES.map(([dx, dy]) => Math.hypot(dx * cellWidthM, dy * cellHeightM));
  const relax = (from: number, to: number, cost: number, jump: boolean) => {
    if (cost >= gScore[to]) return;
    gScore[to] = cost;
    cameFrom[to] = from;
    reachedByJump[to] = jump ? 1 : 0;
    heap.push(cost + heuristic(to), to);
  };
  gScore[start] = 0;
  heap.push(heuristic(start), start);
  while (heap.size > 0) {
    const current = heap.pop();
    if (closed[current]) continue;
    if (current === goal) break;
    closed[current] = 1;
    const x = current % width;
    const y = (current - x) / width;
    const currentElevation = elevation[current];
    let nextToWater = false;
    for (let move = 0; move < MOVES.length; move++) {
      const [dx, dy] = MOVES[move];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (closed[next]) continue;
      if (water[next] !== WATER_LAND) {
        nextToWater = true;
        continue;
      }
      const between = intermediateCells(x, y, dx, dy, width);
      // No corner-cutting across water: a diagonal or knight move must sweep
      // over land only.
      if (between && (water[between[0]] !== WATER_LAND || water[between[1]] !== WATER_LAND)) {
        nextToWater = true;
        continue;
      }
      const distance = moveDistance[move];
      const grade = Math.abs(elevation[next] - currentElevation) / distance;
      const cost = distance * slopeCostFactor(grade, params) * terrainFactor[next] * (1 + forestWeight * vegetation[next]);
      relax(current, next, gScore[current] + cost, false);
    }
    if (!nextToWater) continue;
    // Crossing jumps: straight over water to the first land cell beyond.
    // Only jumps close to the shortest crossing from this bank are kept, so
    // a crossing runs across the water rather than along it.
    let jumpCount = 0;
    let shortestSpanM = Infinity;
    for (const [ux, uy] of JUMP_DIRECTIONS) {
      let landing = -1;
      let maxSize = 0;
      let allFordable = true;
      let crossed = false;
      for (let t = jumpStep; t <= maxJumpCells; t += jumpStep) {
        const cx = Math.round(x + ux * t);
        const cy = Math.round(y + uy * t);
        if (cx < 0 || cy < 0 || cx >= width || cy >= height) break;
        const cell = cy * width + cx;
        if (cell === current) continue;
        const kind = water[cell];
        if (kind === WATER_BLOCKED) break;
        if (kind === WATER_LAND) {
          if (crossed) landing = cell;
          break;
        }
        crossed = true;
        maxSize = Math.max(maxSize, terrain.riverSize[cell]);
        if (!isFord(terrain, cell, params)) allFordable = false;
      }
      if (landing < 0) continue;
      const lx = landing % width;
      const ly = (landing - lx) / width;
      const spanM = Math.hypot((lx - x) * cellWidthM, (ly - y) * cellHeightM);
      if (spanM > params.maxBridgeM) continue;
      shortestSpanM = Math.min(shortestSpanM, spanM);
      jumpLanding[jumpCount] = landing;
      jumpSpanM[jumpCount] = spanM;
      jumpSize[jumpCount] = maxSize;
      jumpFordable[jumpCount] = allFordable ? 1 : 0;
      jumpCount++;
    }
    const spanLimitM = shortestSpanM * 1.5 + Math.min(cellWidthM, cellHeightM) * 1.5;
    for (let jump = 0; jump < jumpCount; jump++) {
      const landing = jumpLanding[jump];
      const spanM = jumpSpanM[jump];
      if (closed[landing] || spanM > spanLimitM) continue;
      // Bridges and fords climb like the road: a steep crossing pays for it.
      const grade = Math.abs(elevation[landing] - currentElevation) / spanM;
      const fordable = jumpFordable[jump] === 1;
      // Bank cells are measured centre to centre; the water is one cell less.
      const waterM = Math.max(cellMinM * 0.5, spanM - cellMinM);
      const cost = crossingCost(waterM, jumpSize[jump], fordable, params) *
        slopeCostFactor(grade, params) * terrainFactor[landing];
      relax(current, landing, gScore[current] + cost, true);
    }
  }
  if (cameFrom[goal] < 0) {
    return { cells: straightCells(terrain, start, goal), found: false };
  }
  const cells: number[] = [];
  for (let cell = goal; cell >= 0; cell = cameFrom[cell]) {
    cells.push(cell);
    if (cell === start) break;
    if (reachedByJump[cell]) {
      // Spell out the crossing so the route knows which cells are water.
      const span = straightCells(terrain, cameFrom[cell], cell);
      for (let index = span.length - 2; index >= 1; index--) cells.push(span[index]);
    }
  }
  cells.reverse();
  return { cells, found: true };
}

function cellCenter(terrain: RoutingTerrain, cell: number): MapPoint {
  const x = cell % terrain.width;
  const y = (cell - x) / terrain.width;
  return { u: (x + 0.5) / terrain.width, v: (y + 0.5) / terrain.height };
}

/** Cost of one land step between two cells, priced like an A* move. */
function landStepCost(terrain: RoutingTerrain, from: number, to: number, params: RoutingParams): number {
  const { width, cellWidthM, cellHeightM, elevation, terrainFactor, vegetation } = terrain;
  const fx = from % width;
  const tx = to % width;
  const distance = Math.hypot((tx - fx) * cellWidthM, ((to - tx) / width - (from - fx) / width) * cellHeightM);
  if (distance <= 0) return 0;
  const grade = Math.abs(elevation[to] - elevation[from]) / distance;
  return distance * slopeCostFactor(grade, params) * terrainFactor[to] *
    (1 + params.forestAvoidance * 2 * vegetation[to]);
}

/** Elevation between cell centres, bilinearly interpolated. */
function sampleElevation(terrain: RoutingTerrain, x: number, y: number): number {
  const { width, height, elevation } = terrain;
  const fx = Math.max(0, Math.min(width - 1, x - 0.5));
  const fy = Math.max(0, Math.min(height - 1, y - 0.5));
  const x0 = Math.min(width - 2, Math.floor(fx));
  const y0 = Math.min(height - 2, Math.floor(fy));
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const index = y0 * width + x0;
  const top = elevation[index] * (1 - tx) + elevation[index + 1] * tx;
  const bottom = elevation[index + width] * (1 - tx) + elevation[index + width + 1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Cost of a straight leg between two cell centres, or Infinity across water. */
function straightLegCost(
  terrain: RoutingTerrain,
  from: number,
  to: number,
  params: RoutingParams,
  capGrade: boolean,
): number {
  const { width } = terrain;
  return legCostBetween(
    terrain,
    { x: (from % width) + 0.5, y: Math.floor(from / width) + 0.5 },
    { x: (to % width) + 0.5, y: Math.floor(to / width) + 0.5 },
    params,
    capGrade,
  );
}

/**
 * Prefix count of path steps steeper than the hard grade. A straightened leg
 * may only be that steep where the routed path already had to be.
 */
function hardStepPrefix(terrain: RoutingTerrain, runCells: readonly number[], params: RoutingParams): Int32Array {
  const { width, cellWidthM, cellHeightM, elevation } = terrain;
  const prefix = new Int32Array(runCells.length);
  for (let index = 1; index < runCells.length; index++) {
    const a = runCells[index - 1];
    const b = runCells[index];
    const ax = a % width;
    const bx = b % width;
    const run = Math.hypot((bx - ax) * cellWidthM, ((b - bx) / width - (a - ax) / width) * cellHeightM);
    const steep = run > 0 && Math.abs(elevation[b] - elevation[a]) / run > params.maxGrade * HARD_GRADE_RATIO;
    prefix[index] = prefix[index - 1] + (steep ? 1 : 0);
  }
  return prefix;
}

/** Cumulative cost of walking a cell path, step by step. */
function pathCostPrefix(terrain: RoutingTerrain, runCells: readonly number[], params: RoutingParams): Float64Array {
  const prefix = new Float64Array(runCells.length);
  for (let index = 1; index < runCells.length; index++) {
    prefix[index] = prefix[index - 1] + landStepCost(terrain, runCells[index - 1], runCells[index], params);
  }
  return prefix;
}

interface CellPoint {
  x: number;
  y: number;
}

/**
 * Cost of a straight leg between two continuous cell positions. Infinity when
 * the leg touches water, leaves the map, or (with `capGrade`) climbs steeper
 * than the hard grade anywhere along it.
 */
function legCostBetween(
  terrain: RoutingTerrain,
  a: CellPoint,
  b: CellPoint,
  params: RoutingParams,
  capGrade = false,
): number {
  const { width, height, cellWidthM, cellHeightM, water, terrainFactor, vegetation } = terrain;
  if (b.x < 0 || b.y < 0 || b.x >= width || b.y >= height) return Infinity;
  const lengthCells = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(lengthCells));
  for (let sample = 1; sample < steps * 2; sample++) {
    const t = sample / (steps * 2);
    const cell = Math.floor(a.y + (b.y - a.y) * t) * width + Math.floor(a.x + (b.x - a.x) * t);
    if (water[cell] !== WATER_LAND) return Infinity;
  }
  const stepM = Math.hypot((b.x - a.x) * cellWidthM, (b.y - a.y) * cellHeightM) / steps;
  // The hard-grade cap looks over a few samples so one noisy cell on a
  // mountain face does not veto a whole leg.
  const capWindow = Math.min(3, steps);
  const elevations = [sampleElevation(terrain, a.x, a.y)];
  let cost = 0;
  let previousElevation = elevations[0];
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const elevationHere = sampleElevation(terrain, x, y);
    elevations.push(elevationHere);
    const grade = Math.abs(elevationHere - previousElevation) / Math.max(1e-6, stepM);
    if (capGrade && step >= capWindow) {
      const windowGrade = Math.abs(elevationHere - elevations[step - capWindow]) / Math.max(1e-6, stepM * capWindow);
      if (windowGrade > params.maxGrade * HARD_GRADE_RATIO) return Infinity;
    }
    previousElevation = elevationHere;
    const cell = Math.min(height - 1, Math.floor(y)) * width + Math.min(width - 1, Math.floor(x));
    cost += stepM * slopeCostFactor(grade, params) * terrainFactor[cell] *
      (1 + params.forestAvoidance * 2 * vegetation[cell]);
  }
  return cost;
}

/** How far a switchback may swing beyond the stretch it replaces, in metres. */
const SWITCHBACK_MAX_SWING_M = 600;
/** Legs shorter than this many cells are always grid jitter, not road. */
const MIN_LEG_CELLS = 4;
/** Extra cost a cleaner layout may add on top of the straightening tolerance. */
const SHAPE_COST_ALLOWANCE = 0.5;

/** Headings tried by the long-leg search. */
const LEG_HEADINGS = Array.from({ length: 32 }, (_, index) => {
  const angle = (index / 32) * Math.PI * 2;
  return [Math.cos(angle), Math.sin(angle)] as const;
});
/** Upper bound on long-leg search expansions per stretch. */
const LEG_SEARCH_BUDGET = 25000;
/** Greedier goal estimate: a little optimality traded for a bounded search. */
const LEG_HEURISTIC_WEIGHT = 1.3;

/**
 * Least-cost path from `start` to `finish` made only of straight legs at
 * least `legCells` long. Each leg is priced along its true line, so the
 * search climbs a slope in proper switchbacks: long legs at a comfortable
 * grade, turning only where a leg ends. The search stays within `margin`
 * cells of the stretch's bounding box. Returns the vertices after `start`,
 * or null when the finish cannot be reached.
 */
function longLegPath(
  terrain: RoutingTerrain,
  start: CellPoint,
  finish: CellPoint,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  legCells: number,
  params: RoutingParams,
  capGrade: boolean,
): CellPoint[] | null {
  const { width, height, cellWidthM, cellHeightM } = terrain;
  const metres = (a: CellPoint, b: CellPoint) => Math.hypot((b.x - a.x) * cellWidthM, (b.y - a.y) * cellHeightM);
  const nodes: CellPoint[] = [start];
  const parents: number[] = [-1];
  const costs: number[] = [0];
  const best = new Map<number, number>();
  const key = (point: CellPoint) => Math.floor(point.y) * width + Math.floor(point.x);
  best.set(key(start), 0);
  const closed = new Set<number>();
  const heap = new MinHeap();
  heap.push(metres(start, finish) * LEG_HEURISTIC_WEIGHT, 0);
  // Price of one more turn, in metres of equivalent detour.
  const turnCost = legCells * Math.min(cellWidthM, cellHeightM) * 0.3;
  let expansions = 0;
  let reached = -1;
  while (heap.size > 0 && expansions < LEG_SEARCH_BUDGET) {
    const node = heap.pop();
    if (node === nodes.length) continue;
    if (closed.has(node)) continue;
    closed.add(node);
    expansions++;
    const here = nodes[node];
    if (here === finish) {
      reached = node;
      break;
    }
    const push = (next: CellPoint, legCost: number) => {
      if (!Number.isFinite(legCost)) return;
      const total = costs[node] + legCost;
      const nextKey = next === finish ? -1 : key(next);
      const known = best.get(nextKey);
      if (known !== undefined && costs[known] <= total) return;
      const index = nodes.length;
      nodes.push(next);
      parents.push(node);
      costs.push(total);
      best.set(nextKey, index);
      heap.push(total + metres(next, finish) * LEG_HEURISTIC_WEIGHT, index);
    };
    // Close in on the finish once it is within reach of one leg.
    if (Math.hypot(finish.x - here.x, finish.y - here.y) <= legCells * 1.6) {
      push(finish, legCostBetween(terrain, here, finish, params, capGrade));
    }
    for (const [dx, dy] of LEG_HEADINGS) {
      // Longer legs are offered too; a small fixed cost per leg makes the
      // search prefer few long legs, i.e. few turns, where terrain allows.
      for (const multiple of [1, 2, 3]) {
        const reach = legCells * multiple;
        const next = { x: here.x + dx * reach, y: here.y + dy * reach };
        if (next.x < bounds.minX || next.y < bounds.minY || next.x > bounds.maxX || next.y > bounds.maxY) break;
        if (next.x < 0.5 || next.y < 0.5 || next.x > width - 0.5 || next.y > height - 0.5) break;
        if (closed.has(best.get(key(next)) ?? -2)) continue;
        const legCost = legCostBetween(terrain, here, next, params, capGrade);
        if (!Number.isFinite(legCost)) break;
        push(next, legCost + turnCost);
      }
    }
  }
  if (reached < 0) return null;
  const path: CellPoint[] = [];
  for (let node = reached; node > 0; node = parents[node]) path.push(nodes[node]);
  path.reverse();
  // Merge legs that continue at (almost) the same heading into one.
  const merged: CellPoint[] = [];
  let previous = start;
  for (let index = 0; index < path.length; index++) {
    const vertex = path[index];
    const next = path[index + 1];
    if (next) {
      const inHeading = Math.atan2(vertex.y - previous.y, vertex.x - previous.x);
      const outHeading = Math.atan2(next.y - vertex.y, next.x - vertex.x);
      let turn = Math.abs(inHeading - outHeading);
      turn = Math.min(turn, Math.PI * 2 - turn);
      if (turn < (6 * Math.PI) / 180) continue;
    }
    merged.push(vertex);
    previous = vertex;
  }
  return merged;
}

/**
 * Replace stretches of short zigzag legs with switchbacks.
 *
 * On a slope steeper than the road allows, the grid search climbs in small
 * zigzags: a short leg is as cheap as a long one, so nothing prefers long
 * legs. Each stretch of legs shorter than the minimum leg length is rerouted
 * with the long-leg search, which only knows legs of at least that length.
 * The result is kept when it reaches the end of the stretch.
 */
function buildSwitchbacks(
  terrain: RoutingTerrain,
  runCells: readonly number[],
  kept: readonly number[],
  params: RoutingParams,
  anchors: ReadonlySet<number>,
): CellPoint[] {
  const { width, cellWidthM, cellHeightM } = terrain;
  const cellM = Math.min(cellWidthM, cellHeightM);
  const minLegCells = Math.max(MIN_LEG_CELLS, params.minLegM / cellM);
  const marginCells = SWITCHBACK_MAX_SWING_M / cellM;
  const toPoint = (index: number): CellPoint => {
    const cell = runCells[index];
    const x = cell % width;
    return { x: x + 0.5, y: (cell - x) / width + 0.5 };
  };
  const hardSteps = hardStepPrefix(terrain, runCells, params);
  const result: CellPoint[] = [toPoint(kept[0])];
  let corner = 0;
  while (corner < kept.length - 1) {
    // Gather a stretch of consecutive short legs, stopping at waypoints.
    let end = corner;
    while (end < kept.length - 1) {
      const a = toPoint(kept[end]);
      const b = toPoint(kept[end + 1]);
      if (Math.hypot(b.x - a.x, b.y - a.y) >= minLegCells) break;
      end++;
      if (anchors.has(kept[end])) break;
    }
    if (end - corner < 2) {
      // Not a zigzag: keep the next corner as it is.
      result.push(toPoint(kept[corner + 1]));
      corner++;
      continue;
    }
    const start = toPoint(kept[corner]);
    const finish = toPoint(kept[end]);
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (let index = kept[corner]; index <= kept[end]; index++) {
      const point = toPoint(index);
      bounds.minX = Math.min(bounds.minX, point.x - marginCells);
      bounds.minY = Math.min(bounds.minY, point.y - marginCells);
      bounds.maxX = Math.max(bounds.maxX, point.x + marginCells);
      bounds.maxY = Math.max(bounds.maxY, point.y + marginCells);
    }
    const capGrade = hardSteps[kept[end]] === hardSteps[kept[corner]];
    // Rough faces may not fit legs of the full minimum length; shorter legs
    // are still far better than the grid zigzag.
    let legs: CellPoint[] | null = null;
    for (const share of [1, 0.6, 0.35]) {
      const legCells = Math.max(MIN_LEG_CELLS, minLegCells * share);
      legs = longLegPath(terrain, start, finish, bounds, legCells, params, capGrade);
      if (legs || legCells === MIN_LEG_CELLS) break;
    }
    if (legs) {
      result.push(...legs);
    } else {
      for (let index = corner + 1; index <= end; index++) result.push(toPoint(kept[index]));
    }
    corner = end;
  }
  return result;
}

/**
 * Straighten a land run into long legs. From each corner the run is pulled
 * as far ahead as a straight leg stays dry and costs at most the routed path
 * plus the straightening tolerance. Wiggles collapse into straight legs,
 * while the hairpins of a switchback survive: cutting one would make the leg
 * far steeper and therefore far more expensive. Indices in `anchors` (the
 * user's waypoints) are always kept.
 */
function pullStraightLegs(
  terrain: RoutingTerrain,
  runCells: readonly number[],
  params: RoutingParams,
  anchors: ReadonlySet<number>,
): number[] {
  const count = runCells.length;
  if (count <= 2) return runCells.map((_, index) => index);
  const prefix = pathCostPrefix(terrain, runCells, params);
  const hardSteps = hardStepPrefix(terrain, runCells, params);
  const slack = Math.min(terrain.cellWidthM, terrain.cellHeightM) * 0.5;
  const legFits = (from: number, to: number): boolean => {
    const capGrade = hardSteps[to] === hardSteps[from];
    const cost = straightLegCost(terrain, runCells[from], runCells[to], params, capGrade);
    return cost <= (prefix[to] - prefix[from]) * (1 + params.straightenTolerance) + slack;
  };
  const kept = [0];
  let corner = 0;
  while (corner < count - 1) {
    // The next waypoint bounds how far this leg may reach.
    let limit = count - 1;
    for (let index = corner + 1; index < count - 1; index++) {
      if (anchors.has(index)) {
        limit = index;
        break;
      }
    }
    let good = corner + 1;
    let bad = -1;
    for (let step = 2; ; step *= 2) {
      const probe = Math.min(limit, corner + step);
      if (legFits(corner, probe)) {
        good = probe;
        if (probe === limit) break;
      } else {
        bad = probe;
        break;
      }
    }
    while (bad > good + 1) {
      const middle = (good + bad) >> 1;
      if (legFits(corner, middle)) good = middle;
      else bad = middle;
    }
    kept.push(good);
    corner = good;
  }
  return kept;
}

/**
 * Round each corner with a short curve. The curve radius is fixed in map
 * terms and capped at a third of the shorter neighbouring leg, so long legs
 * stay straight and hairpins keep their place.
 */
function filletCorners(points: readonly { x: number; y: number }[], radius: number): { x: number; y: number }[] {
  if (points.length <= 2) return points.slice();
  const result = [points[0]];
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const cut = Math.min(radius, inLength / 3, outLength / 3);
    if (cut <= 1e-6) {
      result.push(corner);
      continue;
    }
    const start = {
      x: corner.x + (previous.x - corner.x) * (cut / inLength),
      y: corner.y + (previous.y - corner.y) * (cut / inLength),
    };
    const end = {
      x: corner.x + (next.x - corner.x) * (cut / outLength),
      y: corner.y + (next.y - corner.y) * (cut / outLength),
    };
    // Quadratic curve from `start` to `end` with the corner as control point.
    for (let step = 0; step <= 4; step++) {
      const t = step / 4;
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      const c = t * t;
      result.push({
        x: a * start.x + b * corner.x + c * end.x,
        y: a * start.y + b * corner.y + c * end.y,
      });
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

/** Share of the maximum grade above which a stretch counts as a climb. */
const CLIMB_GRADE_SHARE = 0.55;
/** Stretches shorter than this many cells join their neighbour. */
const MIN_STRETCH_CELLS = 12;

/**
 * Split a land run into climbs and normal stretches by local grade. Short
 * stretches are absorbed by the stretch before them so the road does not
 * flick between the two styles every few cells.
 */
function classifyStretches(
  terrain: RoutingTerrain,
  runCells: readonly number[],
  params: RoutingParams,
): { start: number; end: number; climb: boolean }[] {
  const { width, cellWidthM, cellHeightM, elevation } = terrain;
  const count = runCells.length;
  const climb = new Uint8Array(count);
  const reach = 3;
  for (let index = 0; index < count; index++) {
    const a = runCells[Math.max(0, index - reach)];
    const b = runCells[Math.min(count - 1, index + reach)];
    const ax = a % width;
    const bx = b % width;
    const run = Math.hypot((bx - ax) * cellWidthM, ((b - bx) / width - (a - ax) / width) * cellHeightM);
    if (run <= 0) continue;
    climb[index] = Math.abs(elevation[b] - elevation[a]) / run >= params.maxGrade * CLIMB_GRADE_SHARE ? 1 : 0;
  }
  const stretches: { start: number; end: number; climb: boolean }[] = [];
  let start = 0;
  for (let index = 1; index <= count; index++) {
    if (index < count && climb[index] === climb[start]) continue;
    const stretch = { start, end: Math.min(count - 1, index), climb: climb[start] === 1 };
    const previous = stretches[stretches.length - 1];
    if (previous && (stretch.end - stretch.start < MIN_STRETCH_CELLS ||
      previous.end - previous.start < MIN_STRETCH_CELLS)) {
      // Absorb a short stretch; a climb wins so steep bits keep switchbacks.
      previous.end = stretch.end;
      previous.climb = previous.climb || stretch.climb;
    } else {
      stretches.push(stretch);
    }
    start = index;
  }
  return stretches;
}

/** Douglas-Peucker in cell units: keeps the shape within `tolerance` cells. */
function simplifyCells(points: readonly CellPoint[], tolerance: number): CellPoint[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const a = points[first];
    const b = points[last];
    const lengthSquared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let index = first + 1; index < last; index++) {
      const p = points[index];
      const t = lengthSquared > 0
        ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / lengthSquared))
        : 0;
      const distance = Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t));
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = index;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

/** Chaikin corner cutting; the end points stay put. */
function chaikinCells(points: CellPoint[], passes: number): CellPoint[] {
  let current = points;
  for (let pass = 0; pass < passes && current.length > 2; pass++) {
    const next: CellPoint[] = [current[0]];
    for (let index = 0; index < current.length - 1; index++) {
      const a = current[index];
      const b = current[index + 1];
      next.push(
        { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 },
        { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 },
      );
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

/**
 * Remove turns that leave a climbing leg shorter than the minimum leg
 * length. A corner goes when the merged leg stays dry, keeps within the hard
 * grade, and costs no more than the two legs it replaces plus the shape
 * allowance. Corners at the user's waypoints (`fixed`) always stay.
 */
function dropShortLegs(
  terrain: RoutingTerrain,
  corners: CellPoint[],
  params: RoutingParams,
  fixed: ReadonlySet<string>,
): CellPoint[] {
  const minLegCells = Math.max(MIN_LEG_CELLS, params.minLegM / Math.min(terrain.cellWidthM, terrain.cellHeightM));
  const points = corners.slice();
  const length = (a: CellPoint, b: CellPoint) => Math.hypot(b.x - a.x, b.y - a.y);
  for (let pass = 0; pass < 4; pass++) {
    let removed = false;
    for (let index = 1; index < points.length - 1; index++) {
      const previous = points[index - 1];
      const corner = points[index];
      const next = points[index + 1];
      if (fixed.has(`${corner.x},${corner.y}`)) continue;
      if (length(previous, corner) >= minLegCells && length(corner, next) >= minLegCells) continue;
      const current = legCostBetween(terrain, previous, corner, params) + legCostBetween(terrain, corner, next, params);
      const merged = legCostBetween(terrain, previous, next, params, true);
      if (merged <= current * (1 + params.straightenTolerance + SHAPE_COST_ALLOWANCE)) {
        points.splice(index, 1);
        index--;
        removed = true;
      }
    }
    if (!removed) break;
  }
  return points;
}

/** Turns sharper than this count as hairpins. */
const HAIRPIN_TURN = (100 * Math.PI) / 180;
/**
 * Closest spacing, in routing cells, between the two legs of a hairpin. A
 * routing cell is about two pixels of the 2048 px frame, so legs any closer
 * blur into one smear of road.
 */
const HAIRPIN_SPACING_CELLS = 3;

/**
 * Cut straight through stacks of hairpins packed too close together. A
 * hairpin is tight when its legs run closer together than the hairpin
 * spacing: the road folds back onto itself instead of climbing in properly
 * spaced switchbacks. Each run of tight hairpins is dropped so the road
 * climbs the stack in one steep, straight cut, provided the cut stays dry.
 * The user's waypoints (`fixed`) always stay.
 */
function cutThroughHairpinStacks(
  terrain: RoutingTerrain,
  corners: CellPoint[],
  params: RoutingParams,
  fixed: ReadonlySet<string>,
): CellPoint[] {
  const points = corners.slice();
  const tight = (index: number): boolean => {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    if (fixed.has(`${corner.x},${corner.y}`)) return false;
    // Compare the legs at the shorter one's length, so a spike that runs out
    // and back along a longer leg counts as well.
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const reach = Math.min(inLength, outLength);
    if (reach <= 0) return true;
    const inShare = reach / inLength;
    const outShare = reach / outLength;
    const gap = Math.hypot(
      (next.x - corner.x) * outShare - (previous.x - corner.x) * inShare,
      (next.y - corner.y) * outShare - (previous.y - corner.y) * inShare,
    );
    if (gap >= HAIRPIN_SPACING_CELLS) return false;
    let turn = Math.abs(
      Math.atan2(next.y - corner.y, next.x - corner.x) - Math.atan2(corner.y - previous.y, corner.x - previous.x),
    );
    turn = Math.min(turn, Math.PI * 2 - turn);
    return turn > HAIRPIN_TURN;
  };
  // Dropping a run shortens its neighbours' legs, so repeat until stable.
  for (let pass = 0; pass < 8; pass++) {
    let removed = false;
    for (let first = 1; first < points.length - 1; first++) {
      if (!tight(first)) continue;
      let last = first;
      while (last + 1 < points.length - 1 && tight(last + 1)) last++;
      // Drop the run, or as much of it as keeps the cut dry.
      for (let end = last; end >= first; end--) {
        if (Number.isFinite(legCostBetween(terrain, points[first - 1], points[end + 1], params))) {
          points.splice(first, end - first + 1);
          removed = true;
          break;
        }
      }
    }
    if (!removed) break;
  }
  return points;
}

/**
 * Shape a land run for drawing. Normal stretches keep the routed line,
 * lightly simplified and smoothed into natural curves. Climbs are pulled
 * into long straight legs and switchbacks with rounded hairpins; where the
 * hairpins would crowd together, the road cuts straight up instead.
 */
function shapeLandRun(
  terrain: RoutingTerrain,
  runCells: readonly number[],
  params: RoutingParams,
  anchors: ReadonlySet<number>,
): CellPoint[] {
  const { width } = terrain;
  const toPoint = (cell: number): CellPoint => {
    const x = cell % width;
    return { x: x + 0.5, y: (cell - x) / width + 0.5 };
  };
  const result: CellPoint[] = [];
  for (const stretch of classifyStretches(terrain, runCells, params)) {
    const cells = runCells.slice(stretch.start, stretch.end + 1);
    let shaped: CellPoint[];
    if (stretch.climb && cells.length > 2) {
      const stretchAnchors = new Set<number>();
      for (const anchor of anchors) {
        if (anchor > stretch.start && anchor < stretch.end) stretchAnchors.add(anchor - stretch.start);
      }
      const kept = pullStraightLegs(terrain, cells, params, stretchAnchors);
      const corners = buildSwitchbacks(terrain, cells, kept, params, stretchAnchors);
      const fixed = new Set([...stretchAnchors].map((index) => {
        const point = toPoint(cells[index]);
        return `${point.x},${point.y}`;
      }));
      const cleaned = cutThroughHairpinStacks(terrain, dropShortLegs(terrain, corners, params, fixed), params, fixed);
      shaped = filletCorners(cleaned, 2.5);
    } else {
      shaped = chaikinCells(simplifyCells(cells.map(toPoint), 0.75), 2);
    }
    for (let index = result.length > 0 ? 1 : 0; index < shaped.length; index++) result.push(shaped[index]);
  }
  return result;
}

/** Window used for reported grades, so single-cell DEM noise is not reported. */
const GRADE_WINDOW_M = 120;

/**
 * Length, total climb and steepest grade of the drawn road. Climb and grade
 * are sampled along the final geometry on land only: over a crossing the
 * DEM holds the channel bed, which would read as a false dip.
 */
function measureRoad(
  terrain: RoutingTerrain,
  points: readonly MapPoint[],
  bridges: readonly RouteCrossing[],
): { lengthM: number; ascentM: number; maxGrade: number } {
  const { width, height, cellWidthM, cellHeightM } = terrain;
  const onCrossing = (index: number) => bridges.some((bridge) => index >= bridge.from && index < bridge.to);
  const gradeWindow = Math.max(GRADE_WINDOW_M, 3 * Math.max(cellWidthM, cellHeightM));
  let lengthM = 0;
  let ascentM = 0;
  let maxGrade = 0;
  // Land samples: distance along the road and elevation, per land stretch.
  let samples: { distance: number; elevation: number }[] = [];
  const closeStretch = () => {
    let windowEnd = 0;
    for (let index = 0; index < samples.length; index++) {
      windowEnd = Math.max(windowEnd, index);
      while (windowEnd < samples.length - 1 && samples[windowEnd].distance - samples[index].distance < gradeWindow) windowEnd++;
      const span = samples[windowEnd].distance - samples[index].distance;
      if (span >= gradeWindow * 0.5) {
        maxGrade = Math.max(maxGrade, Math.abs(samples[windowEnd].elevation - samples[index].elevation) / span);
      }
    }
    samples = [];
  };
  for (let index = 0; index + 1 < points.length; index++) {
    const ax = points[index].u * width;
    const ay = points[index].v * height;
    const bx = points[index + 1].u * width;
    const by = points[index + 1].v * height;
    const segmentM = Math.hypot((bx - ax) * cellWidthM, (by - ay) * cellHeightM);
    if (onCrossing(index)) {
      closeStretch();
      lengthM += segmentM;
      continue;
    }
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    if (samples.length === 0) samples.push({ distance: lengthM, elevation: sampleElevation(terrain, ax, ay) });
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const elevation = sampleElevation(terrain, ax + (bx - ax) * t, ay + (by - ay) * t);
      ascentM += Math.max(0, elevation - samples[samples.length - 1].elevation);
      samples.push({ distance: lengthM + segmentM * t, elevation });
    }
    lengthM += segmentM;
  }
  closeStretch();
  return { lengthM, ascentM, maxGrade };
}

/**
 * Turn a routing-grid cell path into a road with crossing spans and travel
 * statistics. Bridge spans stay straight; land runs are pulled into long
 * straight legs whose corners are rounded. `anchors` holds the indices of
 * the user's waypoints in `cells`, which the road keeps passing through.
 */
export function finalizeRoute(
  terrain: RoutingTerrain,
  cells: readonly number[],
  params: RoutingParams,
  blocked = false,
  anchors: ReadonlySet<number> = new Set(),
): RoadRoute {
  const { water } = terrain;
  // Split into land runs and water spans. A span includes the bank cell on
  // each side so the bridge abuts the land run.
  interface Run { start: number; end: number; crossing: boolean; ford: boolean }
  const runs: Run[] = [];
  let index = 0;
  while (index < cells.length) {
    if (water[cells[index]] === WATER_RIVER) {
      let end = index;
      let ford = true;
      while (end < cells.length && water[cells[end]] === WATER_RIVER) {
        if (!isFord(terrain, cells[end], params)) ford = false;
        end++;
      }
      runs.push({
        start: Math.max(0, index - 1),
        end: Math.min(cells.length - 1, end),
        crossing: true,
        ford,
      });
      index = end;
    } else {
      let end = index;
      while (end + 1 < cells.length && water[cells[end + 1]] !== WATER_RIVER) end++;
      runs.push({ start: index, end, crossing: false, ford: false });
      index = end + 1;
    }
  }

  const points: MapPoint[] = [];
  const bridges: RouteCrossing[] = [];
  let bridgeCount = 0;
  let fordCount = 0;
  for (const run of runs) {
    if (run.crossing) {
      const from = cellCenter(terrain, cells[run.start]);
      const to = cellCenter(terrain, cells[run.end]);
      if (points.length === 0) points.push(from);
      const fromIndex = points.length - 1;
      points.push(to);
      bridges.push({ from: fromIndex, to: points.length - 1, ford: run.ford });
      if (run.ford) fordCount++;
      else bridgeCount++;
      continue;
    }
    // Land runs share their end cells with the neighbouring spans.
    const runCells = cells.slice(run.start, run.end + 1);
    const runAnchors = new Set<number>();
    for (const anchor of anchors) {
      if (anchor > run.start && anchor < run.end) runAnchors.add(anchor - run.start);
    }
    const shaped = shapeLandRun(terrain, runCells, params, runAnchors);
    const skipFirst = points.length > 0 ? 1 : 0;
    for (let point = skipFirst; point < shaped.length; point++) {
      points.push({ u: shaped[point].x / terrain.width, v: shaped[point].y / terrain.height });
    }
  }
  if (points.length === 1) points.push({ ...points[0] });
  const stats = measureRoad(terrain, points, bridges);

  return {
    points,
    bridges,
    lengthKm: stats.lengthM / 1000,
    ascentM: stats.ascentM,
    maxGradePct: stats.maxGrade * 100,
    bridgeCount,
    fordCount,
    blocked,
  };
}

/** Route a road through every waypoint in order. */
export function routeRoad(
  terrain: RoutingTerrain,
  waypoints: readonly MapPoint[],
  params: RoutingParams,
  routeSegmentFn: (from: MapPoint, to: MapPoint) => SegmentRoute = (from, to) =>
    routeSegment(terrain, from, to, params),
): RoadRoute {
  const cells: number[] = [];
  const anchors = new Set<number>();
  let blocked = false;
  for (let index = 0; index + 1 < waypoints.length; index++) {
    const segment = routeSegmentFn(waypoints[index], waypoints[index + 1]);
    if (!segment.found) blocked = true;
    if (cells.length > 0) anchors.add(cells.length - 1);
    const skip = cells.length > 0 && cells[cells.length - 1] === segment.cells[0] ? 1 : 0;
    for (let cell = skip; cell < segment.cells.length; cell++) cells.push(segment.cells[cell]);
  }
  if (cells.length === 0) {
    return {
      points: waypoints.map((point) => ({ u: point.u, v: point.v })),
      bridges: [],
      lengthKm: 0,
      ascentM: 0,
      maxGradePct: 0,
      bridgeCount: 0,
      fordCount: 0,
      blocked: false,
    };
  }
  return finalizeRoute(terrain, cells, params, blocked, anchors);
}

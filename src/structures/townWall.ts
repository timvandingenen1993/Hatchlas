/**
 * Town wall for walled towns and cities: an irregular octagon on the grid,
 * its sides running along i, along j or on either diagonal. Every piece is
 * a whole SVG part of town-parts, so it can be tweaked there: a straight
 * wall ("wall-<direction>-N", the same walls the castle uses) between each
 * pair of round pieces, a drum ("wall-drum") or a roofed tower
 * ("wall-tower") on every corner and partway along long sides, and a
 * gatehouse ("wall-gate-i" or "-j") on one of the two sides beside the one
 * facing the viewer. This module only decides where each goes.
 *
 * The wall's centre line runs through whole grid points with a round piece
 * on each; the walls either side stop WALL_PIECE_GAP short of its middle,
 * and the gatehouse spans two cells, so the files fit without cutting.
 */
import { GROUND, type IsoShape, WALL, WALL_PIECE_GAP, WALL_PIECE_RADIUS, type Vec2, type WallDirection } from "./isoDraw";
import { partNamed, PARTS, type TownPart } from "./townParts";

/** A town part with its grid point (0, 0) on (i, j); i and j may be fractional. */
export interface PlacedPart {
  part: TownPart;
  i: number;
  j: number;
}

export interface TownWallOptions {
  /** Grid point at the middle of the town; whole numbers. */
  centreI: number;
  centreJ: number;
  /** Distance from the middle to the wall's centre line, in cells. */
  radius: number;
  /** What stands on the corners: drums, or roofed towers. */
  corners: "pier" | "tower";
  random: () => number;
}

export interface TownWall {
  /** Ground inside the wall, the wall behind the town, the wall in front. */
  ground: IsoShape;
  back: PlacedPart[];
  front: PlacedPart[];
  /** Corner points of the wall's centre line. */
  outline: Vec2[];
  /** Radius inside which buildings clear every wall piece. */
  clearRadius: number;
}

/** Whole wall files by direction and length in grid steps. */
const RUNS = new Map<WallDirection, Map<number, TownPart>>();
for (const part of PARTS) {
  const found = /^wall-(i|j|flat|steep)-(\d+)$/.exec(part.name);
  if (!found) continue;
  const direction = found[1] as WallDirection;
  if (!RUNS.has(direction)) RUNS.set(direction, new Map());
  RUNS.get(direction)!.set(Number(found[2]), part);
}
const longest = (direction: WallDirection) => Math.max(...RUNS.get(direction)!.keys());

/** How far a gatehouse reaches into the town from the wall's centre line. */
const GATE_INWARD = WALL.thickness / 2 + 0.22;
/** Half the length of a gatehouse along its wall. */
const GATE_HALF = 1;

const viewward = (v: Vec2) => v[0] + v[1];

/**
 * Outward normals of the octagon's sides in order round it; a side lies on
 * normal · (p - centre) = limit. Axis normals are unit; diagonal ones are
 * (±1, ±1), so every limit, and so every corner, is a whole number.
 */
const NORMALS: readonly Vec2[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** Where side `a` meets side `b` (offsets from the centre). */
function corner(na: Vec2, la: number, nb: Vec2, lb: number): Vec2 {
  const det = na[0] * nb[1] - na[1] * nb[0];
  return [(la * nb[1] - lb * na[1]) / det, (na[0] * lb - nb[0] * la) / det];
}

function directionOf(step: Vec2): WallDirection {
  if (step[1] === 0) return "i";
  if (step[0] === 0) return "j";
  return step[0] === step[1] ? "steep" : "flat";
}

/** An element of the wall, in order round it. */
interface Element {
  placed: PlacedPart;
  /** Middle of the element on the ground, for front/back and depth. */
  centre: Vec2;
}

/**
 * Corners of an irregular octagon round the centre: each side pushed out by
 * a cell or not, retried until every side is at least two steps long
 * (three for the sides that may hold the gate).
 */
function octagon(radius: number, random: () => number): Vec2[] {
  const diagonal = Math.round(radius * Math.SQRT2);
  for (let attempt = 0; attempt < 30; attempt++) {
    // Sides only ever move out, so the town inside keeps at least its full room.
    const limits = NORMALS.map((normal) => (normal[0] && normal[1] ? diagonal : radius) + Math.floor(random() * 2));
    const corners = NORMALS.map((normal, index) => {
      const next = (index + 1) % NORMALS.length;
      return corner(normal, limits[index], NORMALS[next], limits[next]);
    });
    const valid = corners.every((point, index) => {
      const from = corners[(index + NORMALS.length - 1) % NORMALS.length];
      // Side `index` runs from the previous corner to this one, at a right angle to its normal.
      const [di, dj] = [point[0] - from[0], point[1] - from[1]];
      const steps = Math.max(Math.abs(di), Math.abs(dj));
      const [ni, nj] = NORMALS[index];
      // The two sides that may hold the gate need a cell clear of each corner.
      const shortest = index === 0 || index === 2 ? 3 : 2;
      return steps >= shortest && di * ni + dj * nj === 0 && (di === 0 || dj === 0 || Math.abs(di) === Math.abs(dj));
    });
    if (valid) return corners;
  }
  // A regular octagon always works.
  return octagon(radius, () => 0.5);
}

export function buildTownWall(options: TownWallOptions): TownWall {
  const { centreI, centreJ, radius, random } = options;
  const corners = octagon(radius, random).map(([i, j]): Vec2 => [centreI + i, centreJ + j]);
  const cornerPart = partNamed(options.corners === "tower" ? "wall-tower" : "wall-drum");
  const drum = partNamed("wall-drum");

  // The gate goes on the side beside the one facing the viewer, left or right.
  const gateSide = random() < 0.5 ? 0 : 2;
  const gateAt = 0.35 + random() * 0.3;

  const chain: Element[] = [];
  const along = (point: Vec2, unit: Vec2, distance: number): Vec2 => [point[0] + unit[0] * distance, point[1] + unit[1] * distance];
  const pieceAt = (part: TownPart, point: Vec2) => chain.push({ placed: { part, i: point[0], j: point[1] }, centre: point });
  /** The wall file `n` of `direction` running from `start` to `end`. */
  const wallFile = (direction: WallDirection, n: number, start: Vec2, end: Vec2) => {
    // Each file starts at its end with the smaller i (the smaller j, along j).
    const origin = direction === "j" ? (start[1] < end[1] ? start : end) : (start[0] < end[0] ? start : end);
    chain.push({
      placed: { part: RUNS.get(direction)!.get(n)!, i: origin[0], j: origin[1] },
      centre: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2],
    });
  };
  /**
   * A wall `length` cells long along i or j from `start`, with a drum
   * partway along if it is longer than the longest file.
   */
  const straight = (start: Vec2, unit: Vec2, length: number) => {
    const direction = directionOf(unit);
    if (length > longest(direction)) {
      const first = Math.floor((length - 1) / 2);
      straight(start, unit, first);
      pieceAt(drum, along(start, unit, first + WALL_PIECE_GAP));
      straight(along(start, unit, first + 1), unit, length - first - 1);
      return;
    }
    if (length > 0) wallFile(direction, length, start, along(start, unit, length));
  };
  /** The walls between round pieces on `from` and `steps` grid steps on along `step`. */
  const between = (from: Vec2, step: Vec2, steps: number) => {
    const direction = directionOf(step);
    const unit: Vec2 = [step[0] / Math.hypot(...step), step[1] / Math.hypot(...step)];
    if (direction === "i" || direction === "j") {
      straight(along(from, unit, WALL_PIECE_GAP), unit, steps - 1);
      return;
    }
    if (steps > longest(direction)) {
      const half = Math.floor(steps / 2);
      const middle: Vec2 = [from[0] + step[0] * half, from[1] + step[1] * half];
      between(from, step, half);
      pieceAt(drum, middle);
      between(middle, step, steps - half);
      return;
    }
    const length = steps * Math.SQRT2;
    wallFile(direction, steps, along(from, unit, WALL_PIECE_GAP), along(from, unit, length - WALL_PIECE_GAP));
  };

  corners.forEach((to, index) => {
    const from = corners[(index + corners.length - 1) % corners.length];
    pieceAt(cornerPart, from);
    const steps = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]));
    const step: Vec2 = [(to[0] - from[0]) / steps, (to[1] - from[1]) / steps];
    if (index !== gateSide) {
      between(from, step, steps);
      return;
    }
    // The gatehouse straddles cell `cell` of the side, two cells long, clear
    // of both corners; the walls either side meet its ends.
    const cell = Math.min(steps - 2, Math.max(1, Math.round((steps - 1) * gateAt)));
    const middle = along(from, step, cell + 0.5);
    straight(along(from, step, WALL_PIECE_GAP), step, cell - 1);
    chain.push({ placed: { part: partNamed(step[1] === 0 ? "wall-gate-i" : "wall-gate-j"), i: middle[0], j: middle[1] }, centre: middle });
    straight(along(middle, step, GATE_HALF), step, steps - cell - 2);
  });

  const ordered = paintChain(chain, (index) => {
    const a = chain[index].centre;
    const b = chain[(index + 1) % chain.length].centre;
    return [b[0] - a[0], b[1] - a[1]];
  });
  const back: PlacedPart[] = [];
  const front: PlacedPart[] = [];
  for (const element of ordered) {
    // Elements on the far side of the town, side corners included, go behind it.
    const isFront = viewward([element.centre[0] - centreI, element.centre[1] - centreJ]) > 0.05;
    (isFront ? front : back).push(element.placed);
  }

  // Buildings keep inside the nearest side's inner reach: the wall, the
  // round pieces and the gatehouse.
  const nearest = Math.min(...NORMALS.map((normal, index) => {
    const point = corners[index];
    return ((point[0] - centreI) * normal[0] + (point[1] - centreJ) * normal[1]) / Math.hypot(normal[0], normal[1]);
  }));
  const reach = Math.max(WALL_PIECE_RADIUS, GATE_INWARD);
  return {
    ground: { points: corners.map(([i, j]) => [i, j, 0] as const), fill: GROUND, seamless: true },
    back,
    front,
    outline: corners,
    clearRadius: nearest - reach - 0.1,
  };
}

/**
 * Paint order for a closed chain of wall elements. Of two neighbours, the
 * one further along `towardsNext(index)` (from element `index` to the next)
 * is the nearer when that direction points at the viewer, so it goes
 * second. Non-neighbours fall back to depth.
 */
export function paintChain<T extends { centre: Vec2 }>(chain: readonly T[], towardsNext: (index: number) => Vec2): T[] {
  const count = chain.length;
  const before = new Map<number, Set<number>>();
  const require = (first: number, second: number) => {
    if (!before.has(second)) before.set(second, new Set());
    before.get(second)!.add(first);
  };
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    if (viewward(towardsNext(index)) > 1e-9) require(index, next);
    else require(next, index);
  }
  const depth = (element: T) => element.centre[0] + element.centre[1];
  const done = new Set<number>();
  const ordered: T[] = [];
  while (ordered.length < count) {
    let pick = -1;
    for (let index = 0; index < count; index++) {
      if (done.has(index)) continue;
      const blocked = [...(before.get(index) ?? [])].some((first) => !done.has(first));
      if (!blocked && (pick === -1 || depth(chain[index]) < depth(chain[pick]))) pick = index;
    }
    if (pick === -1) pick = [...Array(count).keys()].find((index) => !done.has(index))!;
    done.add(pick);
    ordered.push(chain[pick]);
  }
  return ordered;
}

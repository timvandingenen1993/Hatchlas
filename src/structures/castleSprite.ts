/**
 * Castle sprite: a courtyard inside a curtain wall whose sides run along i,
 * along j or on a diagonal. The great keep rises on the back corner, round
 * towers stand on the corners furthest left, right and to the front, slim
 * turrets on the other square outer corners, and wall drums on the rest:
 * inner corners, the bends where a diagonal side meets a straight one, and
 * partway along long sides. A gatehouse stands out from a front wall.
 * Castle buildings can stand in the wall itself, their outer wall the
 * castle's, with no wall drawn where they stand: a hall in each back wall
 * and sometimes a house in a front one. One more stands in the yard.
 *
 * The outline starts as a rectangle, then gets corners cut off on the
 * diagonal or notched in, and sometimes a bay pushed out of a front side.
 * Every piece is a whole SVG part of town-parts, the walls ("wall-...")
 * shared with walled towns and cities; this module only decides where each
 * one goes.
 *
 * The wall's centre line runs through cell centres. Walls stop at each
 * corner piece: WALL_PIECE_GAP short of a drum or turret's middle, at the
 * face of a tower, the keep or a building. Buildings stand on whole cells.
 * Pieces are painted back to front by their outlines on the ground.
 */
import { mulberry } from "../rendering/forestStandGeometry";
import {
  CASTLE_SLATE,
  HAND_STYLES,
  type IsoShape,
  project,
  ROOF_CSS,
  shapeBounds,
  shapesToSvg,
  SOFT_WOBBLE,
  type Vec2,
  WALL,
  WALL_PIECE_GAP,
  type WallDirection,
} from "./isoDraw";
import { gabled, partNamed, PARTS, type TownPart } from "./townParts";

const GATE_LENGTH = 3;
/** Cells from the back corner kept whole, for the keep and the halls beside it. */
const BACK_CLEAR = 5;
/** Radius of the slim turrets and wall drums, for clearances and paint order. */
const PIECE_RADIUS = 0.62;
const COURTYARD = "#bdab88";
const PATH = "#a99673";
const SHADOW = "#2a1e1638";

const fmt = (value: number) => (Math.round(value * 100) / 100).toString();
const key = (i: number, j: number) => `${i},${j}`;
const add = (point: Vec2, direction: Vec2, distance: number): Vec2 =>
  [point[0] + direction[0] * distance, point[1] + direction[1] * distance];
const viewward = (v: Vec2) => v[0] + v[1];

/** Cells from (i0, j0) to (i1, j1) as an outline on the ground. */
const rect = (i0: number, j0: number, i1: number, j1: number): Vec2[] => [[i0, j0], [i1, j0], [i1, j1], [i0, j1]];
const disc = (centre: Vec2, radius: number): Vec2[] => Array.from({ length: 8 }, (_, step) => {
  const angle = ((step + 0.5) * Math.PI) / 4;
  return [centre[0] + Math.cos(angle) * radius, centre[1] + Math.sin(angle) * radius];
});

/** A piece of the castle and its outline on the ground. */
export interface CastlePiece {
  name: string;
  footprint: Vec2[];
}

interface Item extends CastlePiece {
  svg: string;
  /** Screen-space extent of what this item draws, in viewBox units. */
  extent: { minX: number; minY: number; maxX: number; maxY: number };
}

/** `part` with its grid point (0, 0) on `at`. */
function partItem(part: TownPart, at: Vec2, footprint: Vec2[]): Item {
  const [x, y] = project([at[0], at[1], 0]);
  const left = x - part.originX;
  const top = y - part.originY;
  return {
    name: part.name,
    footprint,
    svg: `<g class="p${CASTLE_SLATE}" data-part="${part.name}" transform="translate(${fmt(left)} ${fmt(top)})">${part.body}</g>`,
    extent: { minX: left, minY: top, maxX: left + part.width, maxY: top + part.height },
  };
}

/** Castle buildings by length, longest first; each comes in both orientations. */
const BACK_BUILDINGS = ["castle-hall", "castle-chapel", "castle-house", "castle-lodge"]
  .map((name) => ({ name, length: partNamed(`${name}-gable-right`).cellsI }));
const EXTRAS = gabled("castle-house", "castle-lodge");
/** Buildings that may stand in a front wall, by length, longest first. */
const FRONT_BUILDINGS = BACK_BUILDINGS.filter(({ name }) => name === "castle-house" || name === "castle-lodge");
const TOWERS = [partNamed("turret"), partNamed("turret-tall")];
const KEEP = partNamed("great-keep");
const TURRET = partNamed("turret-small");
const DRUM = partNamed("wall-drum");

/** Whole wall files by direction and length. */
const WALLS = new Map<WallDirection, Map<number, TownPart>>();
for (const part of PARTS) {
  const found = /^wall-(i|j|flat|steep)-(\d+)$/.exec(part.name);
  if (!found) continue;
  const direction = found[1] as WallDirection;
  if (!WALLS.has(direction)) WALLS.set(direction, new Map());
  WALLS.get(direction)!.set(Number(found[2]), part);
}
const longest = (direction: WallDirection) => Math.max(...WALLS.get(direction)!.keys());

function directionOf(step: Vec2): WallDirection {
  if (step[1] === 0) return "i";
  if (step[0] === 0) return "j";
  return step[0] === step[1] ? "steep" : "flat";
}

export type CornerKind = "keep" | "tower" | "turret" | "drum";
/** How far from a corner piece's middle the walls either side of it stop. */
const TRIM: Record<CornerKind, number> = { keep: KEEP.cellsI - 0.5, tower: 1.5, turret: WALL_PIECE_GAP, drum: WALL_PIECE_GAP };

/** Directions of the sides leaving the back, right, front and left corners of the rectangle. */
const ALONG: readonly Vec2[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
/** Outward normal of a side heading along `d` (the outline runs counter-clockwise in (i, j)). */
const outward = (d: Vec2): Vec2 => [d[1], -d[0]];

/**
 * Corner points of the wall's centre line, back corner first: a rectangle
 * with its right, front and left corners each kept, cut off on the diagonal
 * or notched in (at least one cut), and sometimes a bay out of a front side.
 */
function shapeOutline(between: (low: number, high: number) => number, random: () => number): Vec2[] {
  const LI = between(8, 10);
  const LJ = between(7, 9);
  const rectangle: Vec2[] = [[-0.5, -0.5], [LI + 0.5, -0.5], [LI + 0.5, LJ + 0.5], [-0.5, LJ + 0.5]];
  // The front corner is usually cut: its diagonal wall runs across the
  // screen, face on. Cut side corners run straight down it, seen nearly
  // edge on, so they come up less.
  const styles = [0.25, 0.65, 0.25].map((cut) => {
    const roll = random();
    return roll < cut ? "cut" : roll < cut + 0.2 ? "notch" : "plain";
  });
  if (!styles.includes("cut")) styles[1] = "cut";
  // Never all three, so at least one square corner keeps a tower.
  if (styles.filter((style) => style === "cut").length === 3) styles[random() < 0.5 ? 0 : 2] = "plain";
  const corners: Vec2[][] = [[rectangle[0]]];
  styles.forEach((style, index) => {
    const corner = rectangle[index + 1];
    const into = ALONG[index], out = ALONG[index + 1];
    if (style === "cut") {
      const size = between(2, 3);
      corners.push([add(corner, into, -size), add(corner, out, size)]);
    } else if (style === "notch") {
      const [back, side] = [between(2, 3), between(2, 3)];
      const inner = add(add(corner, into, -back), out, side);
      corners.push([add(corner, into, -back), inner, add(corner, out, side)]);
    } else {
      corners.push([corner]);
    }
  });
  // A bay pushed out of the front-right (side 1) or front-left (side 2) side.
  const baySide = random() < 0.3 ? (random() < 0.5 ? 1 : 2) : -1;
  const outline: Vec2[] = [];
  corners.forEach((points, side) => {
    outline.push(...points);
    if (side !== baySide) return;
    const from = points[points.length - 1];
    const to = corners[side + 1][0];
    const d = ALONG[side];
    const room = Math.abs(to[0] - from[0]) + Math.abs(to[1] - from[1]);
    const length = between(4, 5);
    if (room - length < 4) return;
    const start = between(2, room - length - 2);
    const depth = between(2, 3);
    const n = outward(d);
    const near = add(from, d, start);
    const far = add(from, d, start + length);
    outline.push(near, add(near, n, depth), add(far, n, depth), far);
  });
  return outline;
}

/** Whether two convex outlines are apart (touching counts as apart). */
function apart(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  return [a, b].some((shape) => shape.some((point, index) => {
    const next = shape[(index + 1) % shape.length];
    const normal: Vec2 = [next[1] - point[1], point[0] - next[0]];
    const along = (outline: readonly Vec2[]) => outline.map((p) => p[0] * normal[0] + p[1] * normal[1]);
    const [pa, pb] = [along(a), along(b)];
    return Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6;
  }));
}

/** Whether segments pq and rs cross or touch. */
function crosses(p: Vec2, q: Vec2, r: Vec2, s: Vec2): boolean {
  const side = (a: Vec2, b: Vec2, c: Vec2) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const within = (a: Vec2, b: Vec2, c: Vec2) =>
    Math.min(a[0], b[0]) - 1e-9 <= c[0] && c[0] <= Math.max(a[0], b[0]) + 1e-9
    && Math.min(a[1], b[1]) - 1e-9 <= c[1] && c[1] <= Math.max(a[1], b[1]) + 1e-9;
  const [d1, d2, d3, d4] = [side(r, s, p), side(r, s, q), side(p, q, r), side(p, q, s)];
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (d1 === 0 && within(r, s, p)) || (d2 === 0 && within(r, s, q)) || (d3 === 0 && within(p, q, r)) || (d4 === 0 && within(p, q, s));
}

function insidePolygon(point: Vec2, outline: readonly Vec2[]): boolean {
  let inside = false;
  outline.forEach((a, index) => {
    const b = outline[(index + 1) % outline.length];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < a[0] + ((point[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside;
  });
  return inside;
}

/** Distance from segment pq (or point p, when q is p) to the cell square at (i, j). */
function cellDistance(p: Vec2, q: Vec2, i: number, j: number): number {
  // Sample the segment finely; walls are short and cells whole, so this is plenty.
  const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.05));
  let nearest = Infinity;
  for (let step = 0; step <= steps; step++) {
    const point = add(p, [q[0] - p[0], q[1] - p[1]], step / steps);
    const di = Math.max(i - point[0], 0, point[0] - (i + 1));
    const dj = Math.max(j - point[1], 0, point[1] - (j + 1));
    nearest = Math.min(nearest, Math.hypot(di, dj));
  }
  return nearest;
}

/** A gatehouse spot: its cells, the part, and the way in through it. */
interface Gate {
  part: TownPart;
  cells: Vec2[];
  at: Vec2;
  /** Whether the wall faces +j (else +i), its row (or column) of cells, and the middle of the span along it. */
  facesJ: boolean;
  line: number;
  centre: number;
}

interface CastlePlan {
  outline: Vec2[];
  kinds: CornerKind[];
  items: Item[];
  court: Set<string>;
  gate: Gate;
}

/** Pieces of a castle wall with this outline, or null when they do not fit together. */
function planWall(outline: Vec2[], pickTower: () => TownPart, choose: (count: number) => number): Omit<CastlePlan, "court"> | null {
  const count = outline.length;
  if (outline[0][0] !== -0.5 || outline[0][1] !== -0.5) return null;
  // Sides run along i, j or a diagonal, and the outline never crosses itself.
  const steps: Vec2[] = [];
  const lengths: number[] = [];
  for (let index = 0; index < count; index++) {
    const [a, b] = [outline[index], outline[(index + 1) % count]];
    const [di, dj] = [b[0] - a[0], b[1] - a[1]];
    if ((di === 0 && dj === 0) || (di !== 0 && dj !== 0 && Math.abs(di) !== Math.abs(dj))) return null;
    const length = Math.max(Math.abs(di), Math.abs(dj));
    steps.push([di / length, dj / length]);
    lengths.push(length);
    for (let other = index + 2; other < count; other++) {
      if (index === 0 && other === count - 1) continue;
      if (crosses(a, b, outline[other], outline[(other + 1) % count])) return null;
    }
  }
  const diagonalSide = (index: number) => steps[index][0] !== 0 && steps[index][1] !== 0;

  // What stands on each corner: the keep on the back one; on square outer
  // corners between straight sides a tower if furthest out, else a turret;
  // a drum everywhere else.
  const squareOuter = (index: number) => {
    const [into, out] = [steps[(index + count - 1) % count], steps[index]];
    const convex = into[0] * out[1] - into[1] * out[0] > 0;
    return convex && into[0] * out[0] + into[1] * out[1] === 0 && !diagonalSide(index) && !diagonalSide((index + count - 1) % count);
  };
  if (!squareOuter(0)) return null;
  const candidates = outline.map((_, index) => index).filter((index) => index > 0 && squareOuter(index));
  const furthest = (score: (point: Vec2) => number) =>
    candidates.reduce<number | null>((best, index) => (best === null || score(outline[index]) > score(outline[best]) ? index : best), null);
  const framing = new Set([furthest(([i, j]) => i - j), furthest(([i, j]) => j - i), furthest(([i, j]) => i + j)]);
  const kinds: CornerKind[] = outline.map((_, index) =>
    index === 0 ? "keep" : framing.has(index) ? "tower" : candidates.includes(index) ? "turret" : "drum");
  const trimAt = (index: number) => TRIM[kinds[index % count]];

  // Room for wall along each straight side; a diagonal one runs between drums or turrets only.
  const rooms = lengths.map((length, index) => length - trimAt(index) - trimAt(index + 1));
  for (let index = 0; index < count; index++) {
    if (diagonalSide(index) ? trimAt(index) !== WALL_PIECE_GAP || trimAt(index + 1) !== WALL_PIECE_GAP : rooms[index] < 0) return null;
  }

  // Gate: on a straight side facing +i or +j, with room for it clear of the corner pieces.
  const gateSides = rooms.map((room, index) => ({ room, index })).filter(({ room, index }) => {
    const n = outward(steps[index]);
    return !diagonalSide(index) && ((n[0] === 0 && n[1] === 1) || (n[0] === 1 && n[1] === 0)) && room >= GATE_LENGTH;
  });
  if (gateSides.length === 0) return null;
  const gateSide = gateSides[choose(gateSides.length)];
  const spare = gateSide.room - GATE_LENGTH;
  const gateOffset = spare >= 2 ? 1 + choose(spare - 1) : choose(spare + 1);

  // Buildings standing in the wall, their outer wall the castle's: a hall
  // in each back wall (the larger in one, the smaller in the other), and
  // sometimes a house in a front wall the gate is not in.
  const inWall = new Map<number, { part: TownPart; offset: number }>();
  const buildInto = (index: number, choices: typeof BACK_BUILDINGS, below: number): number => {
    for (const building of choices) {
      if (building.length > rooms[index] || building.length >= below) continue;
      const part = partNamed(`${building.name}-gable-${steps[index][1] === 0 ? "right" : "left"}`);
      inWall.set(index, { part, offset: choose(rooms[index] - building.length + 1) });
      return building.length;
    }
    return 0;
  };
  const [firstBack, secondBack] = choose(2) === 0 ? [0, count - 1] : [count - 1, 0];
  const hall = buildInto(firstBack, BACK_BUILDINGS, Infinity);
  buildInto(secondBack, BACK_BUILDINGS, hall || Infinity);
  const fronts = gateSides.filter(({ index }) => index !== gateSide.index);
  if (fronts.length > 0 && choose(2) === 0) buildInto(fronts[choose(fronts.length)].index, FRONT_BUILDINGS, Infinity);

  const items: Item[] = [];
  const piece = (kind: CornerKind, at: Vec2) => {
    if (kind === "keep") items.push(partItem(KEEP, [at[0] - 0.5, at[1] - 0.5], rect(at[0] - 0.5, at[1] - 0.5, at[0] + TRIM.keep, at[1] + TRIM.keep)));
    else if (kind === "tower") items.push(partItem(pickTower(), [at[0] - 1.5, at[1] - 1.5], rect(at[0] - 1.5, at[1] - 1.5, at[0] + 1.5, at[1] + 1.5)));
    else if (kind === "turret") items.push(partItem(TURRET, [at[0] - 0.5, at[1] - 0.5], disc(at, PIECE_RADIUS)));
    else items.push(partItem(DRUM, at, disc(at, PIECE_RADIUS)));
  };
  /** The wall file `n` of `direction` from `start` to `end`; its outline stops a little short of the pieces either side. */
  const wallFile = (direction: WallDirection, n: number, start: Vec2, end: Vec2) => {
    // Each file starts at its end with the smaller i (the smaller j, along j).
    const origin = direction === "j" ? (start[1] < end[1] ? start : end) : (start[0] < end[0] ? start : end);
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const d: Vec2 = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
    const half = WALL.thickness / 2;
    const [p, q] = [add(start, d, 0.15), add(end, d, -0.15)];
    const across: Vec2 = [-d[1] * half, d[0] * half];
    items.push(partItem(WALLS.get(direction)!.get(n)!, origin, [
      [p[0] - across[0], p[1] - across[1]], [q[0] - across[0], q[1] - across[1]],
      [q[0] + across[0], q[1] + across[1]], [p[0] + across[0], p[1] + across[1]],
    ]));
  };
  /** A wall `length` cells along i or j from `start`, with a drum partway along if it is longer than the longest file. */
  const straight = (start: Vec2, unit: Vec2, length: number) => {
    const direction = directionOf(unit);
    if (length > longest(direction)) {
      const first = Math.floor((length - 1) / 2);
      straight(start, unit, first);
      piece("drum", add(start, unit, first + 0.5));
      straight(add(start, unit, first + 1), unit, length - first - 1);
      return;
    }
    if (length > 0) wallFile(direction, length, start, add(start, unit, length));
  };
  /** The walls along a diagonal side between two pieces `stepCount` grid steps apart. */
  const diagonal = (from: Vec2, step: Vec2, stepCount: number) => {
    const direction = directionOf(step);
    if (stepCount > longest(direction)) {
      const half = Math.floor(stepCount / 2);
      const middle = add(from, step, half);
      diagonal(from, step, half);
      piece("drum", middle);
      diagonal(middle, step, stepCount - half);
      return;
    }
    const unit: Vec2 = [step[0] / Math.SQRT2, step[1] / Math.SQRT2];
    wallFile(direction, stepCount, add(from, unit, WALL_PIECE_GAP), add(from, unit, stepCount * Math.SQRT2 - WALL_PIECE_GAP));
  };

  /**
   * A building standing in the wall from `from` along `step`: it covers the
   * wall's row of cells and the one inside it, ridge along the wall.
   */
  const building = (part: TownPart, from: Vec2, step: Vec2) => {
    const length = step[1] === 0 ? part.cellsI : part.cellsJ;
    const end = add(from, step, length);
    const inside = outward(step).map((v) => -v);
    if (step[1] === 0) {
      const row = from[1] - 0.5;
      const [i0, j0] = [Math.min(from[0], end[0]), inside[1] > 0 ? row : row - 1];
      items.push(partItem(part, [i0, j0], rect(i0, j0, i0 + length, j0 + 2)));
    } else {
      const column = from[0] - 0.5;
      const [i0, j0] = [inside[0] > 0 ? column : column - 1, Math.min(from[1], end[1])];
      items.push(partItem(part, [i0, j0], rect(i0, j0, i0 + 2, j0 + length)));
    }
    return length;
  };

  let gate: Gate | null = null;
  outline.forEach((a, index) => {
    const step = steps[index];
    piece(kinds[index], a);
    if (diagonalSide(index)) {
      diagonal(a, step, lengths[index]);
      return;
    }
    const start = add(a, step, trimAt(index));
    const standing = inWall.get(index);
    if (standing) {
      straight(start, step, standing.offset);
      const length = building(standing.part, add(start, step, standing.offset), step);
      straight(add(start, step, standing.offset + length), step, rooms[index] - standing.offset - length);
      return;
    }
    if (index !== gateSide.index) {
      straight(start, step, rooms[index]);
      return;
    }
    straight(start, step, gateOffset);
    const [gateStart, gateEnd] = [add(start, step, gateOffset), add(start, step, gateOffset + GATE_LENGTH)];
    const facesJ = step[1] === 0;
    if (facesJ) {
      const [i0, j0] = [Math.min(gateStart[0], gateEnd[0]), a[1] - 0.5];
      gate = { part: partNamed("gatehouse-gable-left"), cells: rect(i0, j0, i0 + GATE_LENGTH, j0 + 2), at: [i0, j0], facesJ, line: j0, centre: i0 + GATE_LENGTH / 2 };
    } else {
      const [i0, j0] = [a[0] - 0.5, Math.min(gateStart[1], gateEnd[1])];
      gate = { part: partNamed("gatehouse-gable-right"), cells: rect(i0, j0, i0 + 2, j0 + GATE_LENGTH), at: [i0, j0], facesJ, line: i0, centre: j0 + GATE_LENGTH / 2 };
    }
    items.push(partItem(gate.part, gate.at, gate.cells));
    straight(gateEnd, step, rooms[index] - gateOffset - GATE_LENGTH);
  });

  // Nothing on the wall may overlap anything else on it.
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) if (!apart(items[a].footprint, items[b].footprint)) return null;
  }
  return { outline, kinds, items, gate: gate! };
}

/** Footprints of everything in a castle, with the part each one is. */
export function castleLayout(seed: number): CastlePiece[] {
  return layoutCastle(seed).items.map(({ name, footprint }) => ({ name, footprint }));
}

/** Corner points of the castle wall's centre line, back corner first, and what stands on each. */
export function castleOutline(seed: number): { outline: Vec2[]; kinds: CornerKind[] } {
  const { outline, kinds } = layoutCastle(seed);
  return { outline, kinds };
}

function layoutCastle(seed: number): CastlePlan {
  const random = mulberry((seed ^ 0x7a11ed) + 0xca571e);
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const choose = (count: number) => Math.floor(random() * count);

  let plan: Omit<CastlePlan, "court"> | null = null;
  let court = new Set<string>();
  for (let attempt = 0; attempt < 40 && !plan; attempt++) {
    // A rectangle with its front corner cut is the last resort; it always fits.
    const outline: Vec2[] = attempt < 39
      ? shapeOutline(between, random)
      : [[-0.5, -0.5], [8.5, -0.5], [8.5, 5.5], [5.5, 8.5], [-0.5, 8.5]];
    const candidate = planWall(outline, () => pick(TOWERS), choose);
    if (!candidate) continue;
    // The yard: whole cells inside the wall, clear of it and its round pieces.
    const yard = new Set<string>();
    const lo = Math.floor(Math.min(...outline.flat()));
    const hi = Math.ceil(Math.max(...outline.flat()));
    const rounds = candidate.items.filter(({ name }) => name === DRUM.name || name === TURRET.name)
      .map(({ footprint }) => footprint.reduce<Vec2>((sum, p) => [sum[0] + p[0] / footprint.length, sum[1] + p[1] / footprint.length], [0, 0]));
    for (let i = lo; i < hi; i++) {
      for (let j = lo; j < hi; j++) {
        if (!insidePolygon([i + 0.5, j + 0.5], outline)) continue;
        const clearOfWall = outline.every((a, index) => cellDistance(a, outline[(index + 1) % outline.length], i, j) >= WALL.thickness / 2);
        const clearOfPieces = rounds.every((centre) => cellDistance(centre, centre, i, j) >= PIECE_RADIUS);
        if (clearOfWall && clearOfPieces) yard.add(key(i, j));
      }
    }
    let backWhole = true;
    for (let i = 0; i < BACK_CLEAR; i++) {
      for (let j = 0; j < BACK_CLEAR; j++) if (!yard.has(key(i, j))) backWhole = false;
    }
    if (!backWhole) continue;
    plan = candidate;
    court = yard;
  }
  const { outline, kinds, items, gate } = plan!;

  // The yard minus what the keep, towers and gatehouse stand on; the way in
  // from the gate stays clear so the door shows.
  const occupied = new Set<string>();
  for (const { footprint } of items) {
    if (footprint.length !== 4) continue;
    const [i0, j0] = [Math.min(...footprint.map((p) => p[0])), Math.min(...footprint.map((p) => p[1]))];
    const [i1, j1] = [Math.max(...footprint.map((p) => p[0])), Math.max(...footprint.map((p) => p[1]))];
    for (const cell of court) {
      const [i, j] = cell.split(",").map(Number);
      if (i + 1 > i0 + 1e-6 && i < i1 - 1e-6 && j + 1 > j0 + 1e-6 && j < j1 - 1e-6) occupied.add(cell);
    }
  }
  const lanes = new Set<string>();
  for (let along = gate.centre - GATE_LENGTH / 2 - 1; along < gate.centre + GATE_LENGTH / 2 + 1; along++) {
    for (let depth = 1; depth <= 2; depth++) lanes.add(gate.facesJ ? key(along, gate.line - depth) : key(gate.line - depth, along));
  }
  const cellsOf = (part: TownPart, i: number, j: number) => {
    const cells: string[] = [];
    for (let di = 0; di < part.cellsI; di++) {
      for (let dj = 0; dj < part.cellsJ; dj++) cells.push(key(i + di, j + dj));
    }
    return cells;
  };
  const fits = (part: TownPart, i: number, j: number) =>
    cellsOf(part, i, j).every((cell) => court.has(cell) && !occupied.has(cell) && !lanes.has(cell));
  const claim = (part: TownPart, i: number, j: number) => {
    for (const cell of cellsOf(part, i, j)) occupied.add(cell);
    items.push(partItem(part, [i, j], rect(i, j, i + part.cellsI, j + part.cellsJ)));
  };
  const span = Math.max(...[...court].map((cell) => Math.max(...cell.split(",").map(Number)))) + 1;

  /** Places `part` near the back corner, among the others rather than out in the yard. */
  const tuckIn = (part: TownPart) => {
    let best: { score: number; i: number; j: number } | null = null;
    for (let i = 0; i < span; i++) {
      for (let j = 0; j < span; j++) {
        if (!fits(part, i, j)) continue;
        const score = -(i + j) + random() * 1.5;
        if (!best || score > best.score) best = { score, i, j };
      }
    }
    if (best) claim(part, best.i, best.j);
  };
  tuckIn(pick(EXTRAS));

  return { outline, kinds, items, court, gate };
}

/**
 * Back-to-front order for pieces standing on disjoint convex outlines. Two
 * pieces that can overlap on screen are ordered by a line between their
 * outlines: the one on the viewer's side of it is drawn second. The rest
 * fall back to depth.
 */
export function paintByOutline<T extends CastlePiece>(pieces: readonly T[]): T[] {
  const count = pieces.length;
  const across = pieces.map(({ footprint }) => {
    const xs = footprint.map(([i, j]) => i - j);
    return [Math.min(...xs), Math.max(...xs)];
  });
  const before = Array.from({ length: count }, () => new Set<number>());
  /** +1 when `a` is behind `b`, -1 when in front, 0 when no line between them says. */
  const order = (a: readonly Vec2[], b: readonly Vec2[]) => {
    let sign = 0;
    for (const shape of [a, b]) {
      for (let index = 0; index < shape.length; index++) {
        const [p, q] = [shape[index], shape[(index + 1) % shape.length]];
        const normal: Vec2 = [q[1] - p[1], p[0] - q[0]];
        const dots = (outline: readonly Vec2[]) => outline.map((point) => point[0] * normal[0] + point[1] * normal[1]);
        const [pa, pb] = [dots(a), dots(b)];
        let towardsB = 0;
        if (Math.max(...pa) <= Math.min(...pb) + 1e-6) towardsB = viewward(normal);
        else if (Math.max(...pb) <= Math.min(...pa) + 1e-6) towardsB = -viewward(normal);
        else continue;
        if (Math.abs(towardsB) < 1e-9) return 0;
        if (sign !== 0 && Math.sign(towardsB) !== sign) return 0;
        sign = Math.sign(towardsB);
      }
    }
    return sign;
  };
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      // Pieces apart across the screen never overlap, however tall.
      if (across[a][1] <= across[b][0] + 0.3 || across[b][1] <= across[a][0] + 0.3) continue;
      const sign = order(pieces[a].footprint, pieces[b].footprint);
      if (sign > 0) before[b].add(a);
      else if (sign < 0) before[a].add(b);
    }
  }
  const depth = ({ footprint }: T) => footprint.reduce((sum, [i, j]) => sum + i + j, 0) / footprint.length;
  const done = new Set<number>();
  const ordered: T[] = [];
  while (ordered.length < count) {
    let pick = -1;
    for (let index = 0; index < count; index++) {
      if (done.has(index) || [...before[index]].some((first) => !done.has(first))) continue;
      if (pick === -1 || depth(pieces[index]) < depth(pieces[pick])) pick = index;
    }
    // A cycle: take the shallowest piece left.
    if (pick === -1) {
      for (let index = 0; index < count; index++) {
        if (!done.has(index) && (pick === -1 || depth(pieces[index]) < depth(pieces[pick]))) pick = index;
      }
    }
    done.add(pick);
    ordered.push(pieces[pick]);
  }
  return ordered;
}

/** Composes a castle as a standalone SVG document; `seed` picks its layout. */
export function composeCastle(seed: number): string {
  const { outline, items, court, gate } = layoutCastle(seed);
  const ordered = paintByOutline(items);

  // Ground: a cast shadow off to the right and behind, the courtyard inside
  // the wall's centre line, and a darker path in from the gate.
  const shadow: IsoShape = { points: outline.map(([i, j]) => [i + 0.8, j - 0.8, 0] as const), fill: SHADOW, seamless: true };
  const ground: IsoShape = { points: outline.map(([i, j]) => [i, j, 0] as const), fill: COURTYARD, seamless: true };
  let depth = 0;
  const middle = Math.floor(gate.centre);
  while (depth < 5 && court.has(gate.facesJ ? key(middle, gate.line - depth - 1) : key(gate.line - depth - 1, middle))) depth++;
  const reach = Math.max(0.5, Math.min(4.2, depth - 0.3));
  const [a, b, near, far] = [gate.centre - 0.6, gate.centre + 0.6, gate.line + 0.7, gate.line - reach];
  const path: IsoShape = {
    points: gate.facesJ
      ? [[a, near, 0], [b, near, 0], [b, far, 0], [a, far, 0]]
      : [[near, a, 0], [near, b, 0], [far, b, 0], [far, a, 0]],
    fill: PATH,
    seamless: true,
  };
  const bounds = shapeBounds([shadow, ground]);
  for (const { extent } of ordered) {
    bounds.minX = Math.min(bounds.minX, extent.minX);
    bounds.minY = Math.min(bounds.minY, extent.minY);
    bounds.maxX = Math.max(bounds.maxX, extent.maxX);
    bounds.maxY = Math.max(bounds.maxY, extent.maxY);
  }
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const style = HAND_STYLES.soft;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width * 3)}" height="${fmt(height * 3)}" `
    + `viewBox="${fmt(bounds.minX)} ${fmt(bounds.minY)} ${fmt(width)} ${fmt(height)}" ${style.root}>`
    + `<defs>${style.filter}</defs><style>${ROOF_CSS}</style>`
    + `<g filter="url(#hand)">${shapesToSvg([shadow, ground, path], 0, 0, SOFT_WOBBLE)}\n`
    + `${ordered.map((item) => item.svg).join("\n")}</g></svg>`;
}

/**
 * Settlement sprites. Each building is its own SVG under
 * assets/structures/town-parts (authored by scripts/generate-town-parts.ts
 * and editable by hand); this module packs a seeded mix of them onto an
 * isometric grid, so every seed gives a different settlement drawn in the
 * same hand.
 *
 * Grid: cells (i, j) with i running down-right and j down-left on screen.
 * Hamlets, villages and keeps stand on a patch of bare ground; walled towns,
 * castles and cities sit inside a wall (see townWall.ts and castleSprite.ts),
 * built from whole wall, tower and gatehouse parts, and buildings take the
 * cells that fit inside it.
 */
import { mulberry } from "../rendering/forestStandGeometry";
import { gabled, type GridFootprint, paintOrder, partNamed, PARTS, parseTownPart, type TownPart } from "./townParts";
import {
  CASTLE_SLATE,
  GROUND,
  HAND_STYLES,
  type IsoShape,
  project,
  ROOF_CSS,
  ROOF_PALETTES,
  shapeBounds,
  shapesToSvg,
  type Vec2,
} from "./isoDraw";
import { composeCastle } from "./castleSprite";
import { buildTownWall, type PlacedPart } from "./townWall";
import { SETTLEMENT_KINDS, type SettlementKind } from "./types";

export { paintOrder, parseTownPart };
export type { GridFootprint, TownPart };

/** Kinds drawn with the finer finish; the rest keep the rougher hand-inked look. */
const SOFT_KINDS: ReadonlySet<SettlementKind> = new Set(["keep", "castle"]);

const LANDMARK = /^(tower|turret|keep|great-keep|church|gatehouse)\b/;
/** Keeps always take the slate roof, as castle roofs do. */
const SLATE_ROOFED = /^(keep|great-keep)$/;
/** Castle halls and houses, and the wall pieces: never houses. */
const CASTLE_ONLY = /^(castle|wall)-/;
const HOUSES = PARTS.filter((part) => !LANDMARK.test(part.name) && !CASTLE_ONLY.test(part.name));
/** Sheds and huts: they fill gaps and reserve no lane. */
const FILLERS = HOUSES.filter((part) => part.cellsI * part.cellsJ <= 2);
const LARGE_HOUSES = HOUSES.filter((part) => part.cellsI * part.cellsJ > 2);
const RURAL_HOUSES = gabled("cottage", "house", "longhouse", "hall");

interface Placed extends GridFootprint {
  part: TownPart;
  i: number;
  j: number;
  palette: number;
}

/** Cells wholly inside a circle of `radius` around the grid centre, keyed `i,j`. */
function interiorCells(size: number, radius: number): Set<string> {
  const cells = new Set<string>();
  const centre = size / 2;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const corners = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]];
      if (corners.every(([ci, cj]) => Math.hypot(ci - centre, cj - centre) <= radius)) cells.add(`${i},${j}`);
    }
  }
  return cells;
}

interface WallSpec {
  /** Wall radius beyond half the grid, in cells. */
  pad: number;
  /** What stands on the wall's corners. */
  corners: "pier" | "tower";
}

interface LandmarkSpec {
  parts: readonly TownPart[];
  /** Chance the settlement has it. */
  chance: number;
  /** Where it stands: the middle, or the back half so it shows over the roofs. */
  near: "centre" | "back";
}

interface SettlementSpec {
  /** Cells along each side of the grid. */
  grid: number;
  /** Walled settlements; the rest stand on a patch of bare ground. */
  wall?: WallSpec;
  ground: string;
  landmarks: readonly LandmarkSpec[];
  towers: readonly [number, number];
  towerParts: readonly TownPart[];
  houses: readonly [number, number];
  houseParts: readonly TownPart[];
  /** 0 packs houses round the middle, 1 scatters them evenly. */
  spread: number;
  /** "sweep" fills every leftover cell; "around" only cells beside a building. */
  fillers: "sweep" | "around";
  /** Share of filler cells kept open as yards. */
  yards: number;
  /** Houses keep lanes on both visible sides, not just one: an open, rural look. */
  roomy?: boolean;
  /** Radius of an open square kept just in front of the middle. */
  plaza?: number;
}

const TOWER = [partNamed("tower")];
/** Roof colour of the town wall's towers. */
const WALL_PALETTE = 0;

const SETTLEMENTS: Record<Exclude<SettlementKind, "castle">, SettlementSpec> = {
  hamlet: {
    grid: 11,
    ground: GROUND,
    landmarks: [],
    towers: [0, 0],
    towerParts: [],
    houses: [2, 3],
    houseParts: RURAL_HOUSES,
    spread: 0.08,
    fillers: "around",
    yards: 0.75,
    roomy: true,
  },
  village: {
    grid: 15,
    ground: GROUND,
    landmarks: [{ parts: gabled("church"), chance: 0.45, near: "centre" }],
    towers: [0, 0],
    towerParts: [],
    houses: [5, 8],
    houseParts: LARGE_HOUSES,
    spread: 0.12,
    fillers: "around",
    yards: 0.55,
    roomy: true,
  },
  keep: {
    grid: 12,
    ground: GROUND,
    landmarks: [{ parts: [partNamed("keep")], chance: 1, near: "back" }],
    towers: [0, 0],
    towerParts: [],
    houses: [1, 2],
    // The keep's own outbuildings: stone, plain roofs, no huts or sheds round them.
    houseParts: gabled("castle-house", "castle-lodge"),
    spread: 0.06,
    fillers: "around",
    yards: 1,
    roomy: true,
  },
  "walled-town": {
    grid: 12,
    wall: { pad: 1, corners: "pier" },
    ground: GROUND,
    landmarks: [{ parts: gabled("church"), chance: 0.35, near: "centre" }],
    towers: [1, 2],
    towerParts: TOWER,
    houses: [20, 24],
    houseParts: LARGE_HOUSES,
    spread: 1,
    fillers: "sweep",
    yards: 0.15,
  },
  city: {
    grid: 18,
    wall: { pad: 1, corners: "tower" },
    ground: GROUND,
    landmarks: [
      { parts: gabled("church"), chance: 1, near: "centre" },
      { parts: [partNamed("keep")], chance: 0.7, near: "back" },
    ],
    towers: [2, 3],
    towerParts: TOWER,
    houses: [55, 70],
    // Cities build up: townhouses come up three times as often.
    houseParts: [...LARGE_HOUSES, ...gabled("townhouse", "townhouse")],
    spread: 1,
    fillers: "sweep",
    yards: 0.1,
    plaza: 1.7,
  },
};

const key = (i: number, j: number) => `${i},${j}`;

/**
 * Bare ground under an open settlement: a rounded patch hugging the
 * occupied cells, the radius in each direction set by the farthest corner.
 */
function groundPatch(cells: readonly Vec2[], margin: number, fill: string, random: () => number): IsoShape {
  const corners = cells.flatMap(([i, j]) => [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]] as const);
  const ci = corners.reduce((sum, p) => sum + p[0], 0) / corners.length;
  const cj = corners.reduce((sum, p) => sum + p[1], 0) / corners.length;
  const steps = 28;
  const points = Array.from({ length: steps }, (_, step) => {
    const angle = (step / steps) * Math.PI * 2;
    const di = Math.cos(angle), dj = Math.sin(angle);
    const reach = Math.max(...corners.map(([i, j]) => (i - ci) * di + (j - cj) * dj));
    const radius = reach + margin * (0.75 + random() * 0.5);
    return [ci + di * radius, cj + dj * radius, 0] as const;
  });
  return { points, fill, seamless: true };
}

/** Composes a settlement of `kind` as a standalone SVG document; `seed` picks its layout. */
export function composeSettlement(kind: SettlementKind, seed: number): string {
  if (kind === "castle") return composeCastle(seed);
  const spec = SETTLEMENTS[kind];
  const style = SOFT_KINDS.has(kind) ? HAND_STYLES.soft : HAND_STYLES.classic;
  const salt = SETTLEMENT_KINDS.findIndex((info) => info.kind === kind) * 0x9e37;
  const random = mulberry((seed ^ 0x7a11ed) + salt);
  const between = ([low, high]: readonly [number, number]) => low + Math.floor(random() * (high - low + 1));
  const G = spec.grid;
  const centre = G / 2;

  // Wall: an irregular octagon round the grid centre; the gate goes in a
  // side beside the one facing the viewer.
  const wall = spec.wall
    ? buildTownWall({ centreI: centre, centreJ: centre, radius: centre + spec.wall.pad, corners: spec.wall.corners, random })
    : null;
  const clear = wall ? wall.clearRadius : centre;
  // Buildings take cells wholly inside the clear radius. Huts may also take
  // cells the wall clips, as long as their middle is well inside; they tuck
  // against the wall like lean-tos.
  const free = interiorCells(G, clear);
  const hutCells = new Set<string>();
  for (let i = 0; i < G; i++) {
    for (let j = 0; j < G; j++) {
      if (Math.hypot(i + 0.5 - centre, j + 0.5 - centre) <= clear - 0.25) hutCells.add(key(i, j));
    }
  }

  // Each house keeps a one-cell lane along one of its visible sides so that
  // wall is not buried behind the next roof. Huts and sheds reserve no lane:
  // they fill the gaps, and one half hidden behind a roof does no harm.
  const occupied = new Set<string>();
  const lanes = new Set<string>();
  const placed: Placed[] = [];
  if (spec.plaza) {
    const plazaI = centre + 0.8, plazaJ = centre + 0.8;
    for (let i = 0; i < G; i++) {
      for (let j = 0; j < G; j++) {
        if (Math.hypot(i + 0.5 - plazaI, j + 0.5 - plazaJ) <= spec.plaza) lanes.add(key(i, j));
      }
    }
  }
  const place = (part: TownPart, i: number, j: number): boolean => {
    const cells: string[] = [];
    for (let di = 0; di < part.cellsI; di++) {
      for (let dj = 0; dj < part.cellsJ; dj++) cells.push(key(i + di, j + dj));
    }
    const allowed = part.cellsI * part.cellsJ === 1 ? hutCells : free;
    if (!cells.every((cell) => allowed.has(cell) && !occupied.has(cell) && !lanes.has(cell))) return false;
    const lane: string[] = [];
    if (part.cellsI * part.cellsJ > 2) {
      const both = spec.roomy;
      const side = random() < 0.5;
      if (both || side) for (let di = 0; di <= part.cellsI - (both ? 0 : 1); di++) lane.push(key(i + di, j + part.cellsJ));
      if (both || !side) for (let dj = 0; dj < part.cellsJ; dj++) lane.push(key(i + part.cellsI, j + dj));
      if (lane.some((cell) => occupied.has(cell))) return false;
    }
    for (const cell of cells) occupied.add(cell);
    for (const cell of lane) lanes.add(cell);
    const palette = Math.floor(random() * ROOF_PALETTES.length);
    placed.push({ part, i, j, palette: SLATE_ROOFED.test(part.name) ? CASTLE_SLATE : palette });
    return true;
  };
  /** Tries spots in order of distance to (ti, tj), shuffled by `spread`. */
  const placeNear = (part: TownPart, ti: number, tj: number, spread: number): boolean => {
    const spots: [number, number, number][] = [];
    for (let i = 0; i + part.cellsI <= G; i++) {
      for (let j = 0; j + part.cellsJ <= G; j++) {
        const distance = Math.hypot(i + part.cellsI / 2 - ti, j + part.cellsJ / 2 - tj);
        spots.push([distance + random() * spread * G, i, j]);
      }
    }
    spots.sort((a, b) => a[0] - b[0]);
    return spots.some(([, i, j]) => place(part, i, j));
  };
  const pick = (parts: readonly TownPart[]) => parts[Math.floor(random() * parts.length)];

  // Landmarks first, then towers in the back half, then houses.
  const back = centre * 0.6;
  for (const landmark of spec.landmarks) {
    if (random() >= landmark.chance) continue;
    const target = landmark.near === "back" ? back : centre;
    placeNear(pick(landmark.parts), target, target, 0.08);
  }
  const towers = between(spec.towers);
  for (let count = 0; count < towers; count++) placeNear(pick(spec.towerParts), back, back, 0.4);
  const houseTarget = between(spec.houses);
  let houses = 0;
  let misses = 0;
  while (houses < houseTarget && misses < 30) {
    if (placeNear(pick(spec.houseParts), centre, centre, spec.spread)) houses++;
    else misses++;
  }

  // Sweep the cells left over, largest pieces first, so pockets too small
  // for a house still get a shed or a hut. A few stay open as yards. Open
  // settlements only fill cells beside a building, so they keep their edge.
  const sweep = [...hutCells].map((cell) => cell.split(",").map(Number) as [number, number]);
  for (let index = sweep.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [sweep[index], sweep[swap]] = [sweep[swap], sweep[index]];
  }
  const sweepParts = spec.fillers === "sweep"
    ? [...spec.houseParts, ...FILLERS].sort((a, b) => b.cellsI * b.cellsJ - a.cellsI * a.cellsJ)
    : [...FILLERS].sort((a, b) => b.cellsI * b.cellsJ - a.cellsI * a.cellsJ);
  const besideBuilding = (i: number, j: number) => {
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) if (occupied.has(key(i + di, j + dj))) return true;
    }
    return false;
  };
  for (const [i, j] of sweep) {
    if (random() < spec.yards) continue;
    if (spec.fillers === "around" && !besideBuilding(i, j)) continue;
    for (const part of sweepParts) {
      if (random() < 0.5 && part.cellsI * part.cellsJ > 1) continue;
      if (place(part, i, j)) break;
    }
  }

  let ground: IsoShape;
  if (wall) {
    ground = { ...wall.ground, fill: spec.ground };
  } else {
    const cells = [...occupied].map((cell) => cell.split(",").map(Number) as unknown as Vec2);
    ground = groundPatch(cells.length > 0 ? cells : [[centre, centre]], 0.7, spec.ground, random);
  }

  // Wall behind the town, the buildings back to front, the wall in front.
  const layers: (PlacedPart & { palette: number })[] = [
    ...(wall?.back ?? []).map((piece) => ({ ...piece, palette: WALL_PALETTE })),
    ...paintOrder(placed),
    ...(wall?.front ?? []).map((piece) => ({ ...piece, palette: WALL_PALETTE })),
  ];
  const bounds = shapeBounds([ground]);
  const body = [shapesToSvg([ground])];
  for (const { part, i, j, palette } of layers) {
    const [x, y] = project([i, j, 0]);
    const left = x - part.originX;
    const top = y - part.originY;
    bounds.minX = Math.min(bounds.minX, left);
    bounds.minY = Math.min(bounds.minY, top);
    bounds.maxX = Math.max(bounds.maxX, left + part.width);
    bounds.maxY = Math.max(bounds.maxY, top + part.height);
    body.push(`<g class="p${palette}" data-part="${part.name}" transform="translate(${fmt(left)} ${fmt(top)})">${part.body}</g>`);
  }

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width * 3)}" height="${fmt(height * 3)}" `
    + `viewBox="${fmt(bounds.minX)} ${fmt(bounds.minY)} ${fmt(width)} ${fmt(height)}" ${style.root}>`
    + `<defs>${style.filter}</defs><style>${ROOF_CSS}</style>`
    + `<g filter="url(#hand)">${body.join("\n")}</g></svg>`;
}

const fmt = (value: number) => (Math.round(value * 100) / 100).toString();

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

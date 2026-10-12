/**
 * Settlement sprites. Each building is its own SVG under
 * assets/structures/town-parts (authored by scripts/generate-town-parts.ts
 * and editable by hand); this module packs a seeded mix of them onto an
 * isometric grid, so every seed gives a different settlement drawn in the
 * same hand.
 *
 * Grid: cells (i, j) with i running down-right and j down-left on screen.
 * Hamlets, villages and keeps stand open on the map; walled towns,
 * castles and cities sit inside a wall (see townWall.ts and castleSprite.ts),
 * built from whole wall, tower and gatehouse parts, and buildings take the
 * cells that fit inside it.
 */
import { mulberry } from "../rendering/forestStandGeometry";
import { gabled, type GridFootprint, paintOrder, partNamed, PARTS, parseTownPart, type TownPart } from "./townParts";
import {
  CASTLE_SLATE,
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
import { allowedIn, isKeepOrTowerPart, isLayoutPart, placementPool, type PlacementRules } from "./partPlacement";

export { paintOrder, parseTownPart };
export type { GridFootprint, TownPart };

/** Kinds drawn with the finer finish; the rest keep the rougher hand-inked look. */
const SOFT_KINDS: ReadonlySet<SettlementKind> = new Set(["keep", "castle"]);

const LANDMARK = /^(tower|turret|keep|great-keep|church|cathedral|gatehouse)\b/;
/** Keeps always take the slate roof, as castle roofs do. */
const SLATE_ROOFED = /^(keep|great-keep)$/;
/** Castle halls and houses, and the wall pieces: never houses. */
const CASTLE_ONLY = /^(castle|wall)-/;
const HOUSES = PARTS.filter((part) => !LANDMARK.test(part.name) && !CASTLE_ONLY.test(part.name));
/** Sheds and huts: smaller buildings that also respect the settlement's spacing. */
const FILLERS = HOUSES.filter((part) => part.cellsI * part.cellsJ <= 2);
const LARGE_HOUSES = HOUSES.filter((part) => part.cellsI * part.cellsJ > 2);
const RURAL_HOUSES = gabled("cottage", "house", "longhouse", "hall");
/** Townhouses also count as large because their extra storey dominates the skyline. */
const isLargeHouse = (part: TownPart) => !LANDMARK.test(part.name)
  && (part.cellsI * part.cellsJ > 4 || /^townhouse-/.test(part.name));

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
  /** Walled settlements; the rest are open. */
  wall?: WallSpec;
  landmarks: readonly LandmarkSpec[];
  towers: readonly [number, number];
  towerParts: readonly TownPart[];
  houses: readonly [number, number];
  houseParts: readonly TownPart[];
  /** Seeded total building budget, including landmarks and small outbuildings. */
  buildings?: readonly [number, number];
  /** Limit larger residential buildings while leaving room for civic landmarks. */
  maxLargeHouses?: number;
  /** 0 packs houses round the middle, 1 scatters them evenly. */
  spread: number;
  /** "sweep" fills every leftover cell; "around" only cells beside a building. */
  fillers: "sweep" | "around";
  /** Share of filler cells kept open as yards. */
  yards: number;
}

const TOWER = [partNamed("tower")];
/** Roof colour of the town wall's towers. */
const WALL_PALETTE = 0;

const SETTLEMENTS: Record<Exclude<SettlementKind, "castle">, SettlementSpec> = {
  hamlet: {
    grid: 11,
    landmarks: [],
    towers: [0, 0],
    towerParts: [],
    houses: [2, 3],
    houseParts: RURAL_HOUSES,
    buildings: [2, 4],
    spread: 0.08,
    fillers: "around",
    yards: 0.75,
  },
  village: {
    grid: 15,
    landmarks: [{ parts: gabled("church"), chance: 0.45, near: "centre" }],
    towers: [0, 0],
    towerParts: [],
    houses: [3, 5],
    houseParts: LARGE_HOUSES,
    buildings: [5, 8],
    spread: 0.12,
    fillers: "around",
    yards: 0.55,
  },
  keep: {
    grid: 12,
    landmarks: [{ parts: [partNamed("keep")], chance: 1, near: "back" }],
    towers: [0, 0],
    towerParts: [],
    houses: [1, 2],
    // The keep's own outbuildings: stone, plain roofs, no huts or sheds round them.
    houseParts: gabled("castle-house"),
    spread: 0.06,
    fillers: "around",
    yards: 1,
  },
  "walled-town": {
    grid: 14,
    wall: { pad: 1, corners: "pier" },
    landmarks: [{ parts: gabled("church"), chance: 0.35, near: "centre" }],
    towers: [1, 2],
    towerParts: TOWER,
    // A few full-size homes; most of the enclosure is filled by small buildings.
    houses: [4, 6],
    houseParts: [...gabled("cottage", "cottage", "cottage"), ...LARGE_HOUSES],
    maxLargeHouses: 2,
    spread: 1,
    fillers: "sweep",
    yards: 0,
  },
  city: {
    grid: 18,
    wall: { pad: 1, corners: "tower" },
    landmarks: [
      { parts: gabled("cathedral"), chance: 1, near: "centre" },
      { parts: [partNamed("keep")], chance: 0.7, near: "back" },
    ],
    towers: [2, 3],
    towerParts: TOWER,
    houses: [55, 70],
    // Cities build up: townhouses come up three times as often.
    houseParts: [...LARGE_HOUSES, ...gabled("townhouse", "townhouse")],
    spread: 1,
    fillers: "sweep",
    yards: 0,
  },
};

const key = (i: number, j: number) => `${i},${j}`;

/**
 * Footprint of an open settlement: a rounded outline hugging the occupied
 * cells, the radius in each direction set by the farthest corner. It is not
 * drawn; it only sizes the sprite.
 */
function groundPatch(cells: readonly Vec2[], cellSize: number, margin: number, random: () => number): IsoShape {
  const corners = cells.flatMap(([i, j]) => [[i, j], [i + cellSize, j], [i, j + cellSize], [i + cellSize, j + cellSize]] as const);
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
  return { points, fill: "none", seamless: true };
}

/** Composes a settlement of `kind` as a standalone SVG document; `seed` picks its layout. */
export function composeSettlement(kind: SettlementKind, seed: number, rules: PlacementRules = {}): string {
  if (kind === "castle") return composeCastle(seed, rules);
  const spec = SETTLEMENTS[kind];
  const packed = kind === "walled-town" || kind === "city";
  const buildings = PARTS.filter((part) => !isLayoutPart(part.name) && !LANDMARK.test(part.name));
  const houseParts = placementPool(spec.houseParts, buildings.filter((part) => kind === "keep" || part.cellsI * part.cellsJ > 2), kind, rules);
  const fillers = placementPool(FILLERS, buildings.filter((part) => part.cellsI * part.cellsJ <= 2), kind, rules);
  const towerParts = placementPool(spec.towerParts, TOWER, kind, rules);
  const landmarks = spec.landmarks.map((landmark) => ({
    ...landmark, parts: landmark.parts.filter((part) => allowedIn(part, kind, rules)),
  }));
  for (const part of placementPool([], PARTS.filter((part) => LANDMARK.test(part.name) && part.name !== "tower"), kind, rules)) {
    if (!spec.landmarks.some(({ parts }) => parts.some(({ name }) => name === part.name))) {
      landmarks.push({ parts: [part], chance: 0.5, near: "back" });
    }
  }
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
  // Urban buildings use every safe whole cell inside the wall, including its
  // corner pockets. Open settlements are sized by a rounded footprint.
  const free = wall ? new Set(wall.interiorCells) : interiorCells(G, clear);
  const hutCells = wall ? new Set(wall.interiorCells) : new Set<string>();
  if (!wall) {
    for (let i = 0; i < G; i++) {
      for (let j = 0; j < G; j++) {
        if (Math.hypot(i + 0.5 - centre, j + 0.5 - centre) <= clear - 0.25) hutCells.add(key(i, j));
      }
    }
  }

  // Urban buildings leave a whole cell for streets; rural buildings leave half.
  // Half-cell origins still let buildings fit into the wall's corner pockets.
  const buildingGap = kind === "keep" ? 0 : packed ? 1 : 0.5;
  const placementStep = kind === "keep" ? 1 : 0.5;
  const occupied = new Set<string>();
  const placed: Placed[] = [];
  const buildingLimit = spec.buildings ? between(spec.buildings) : Infinity;
  const canAddPart = (part: TownPart) => placed.length < buildingLimit && allowedIn(part, kind, rules)
    && (!isKeepOrTowerPart(part.name) || !placed.some(({ part }) => isKeepOrTowerPart(part.name)))
    && (spec.maxLargeHouses === undefined || !isLargeHouse(part)
      || placed.filter(({ part }) => isLargeHouse(part)).length < spec.maxLargeHouses);
  const place = (part: TownPart, i: number, j: number): boolean => {
    if (!canAddPart(part)) return false;
    if (placed.some((other) => !(i + part.cellsI + buildingGap <= other.i
      || other.i + other.part.cellsI + buildingGap <= i
      || j + part.cellsJ + buildingGap <= other.j
      || other.j + other.part.cellsJ + buildingGap <= j))) return false;
    const cells: string[] = [];
    for (let di = 0; di < part.cellsI; di += placementStep) {
      for (let dj = 0; dj < part.cellsJ; dj += placementStep) cells.push(key(i + di, j + dj));
    }
    const allowed = part.cellsI * part.cellsJ === 1 ? hutCells : free;
    if (!cells.every((cell) => {
      const [ci, cj] = cell.split(",").map(Number);
      return allowed.has(key(Math.floor(ci), Math.floor(cj))) && !occupied.has(cell);
    })) return false;
    for (const cell of cells) occupied.add(cell);
    const palette = Math.floor(random() * ROOF_PALETTES.length);
    placed.push({ part, i, j, palette: SLATE_ROOFED.test(part.name) ? CASTLE_SLATE : palette });
    return true;
  };
  /** Tries spots in order of distance to (ti, tj), shuffled by `spread`. */
  const placeNear = (part: TownPart, ti: number, tj: number, spread: number): boolean => {
    if (!canAddPart(part)) return false;
    const spots: [number, number, number][] = [];
    for (let i = 0; i + part.cellsI <= G; i += placementStep) {
      for (let j = 0; j + part.cellsJ <= G; j += placementStep) {
        const distance = Math.hypot(i + part.cellsI / 2 - ti, j + part.cellsJ / 2 - tj);
        spots.push([distance + random() * spread * G, i, j]);
      }
    }
    spots.sort((a, b) => a[0] - b[0]);
    return spots.some(([, i, j]) => place(part, i, j));
  };
  /** Put defensive landmarks just inside a rear wall, where they show over the houses. */
  const placeNearWall = (part: TownPart): boolean => {
    if (!wall) return placeNear(part, centre * 0.6, centre * 0.6, 0.4);
    const sides = wall.outline.map((a, index) => {
      const b = wall.outline[(index + 1) % wall.outline.length];
      return { a, b, di: b[0] - a[0], dj: b[1] - a[1] };
    }).filter(({ a, b }) => a[0] + a[1] + b[0] + b[1] <= centre * 4);
    if (!canAddPart(part)) return false;
    const spots: [number, number, number][] = [];
    for (let i = 0; i + part.cellsI <= G; i += placementStep) {
      for (let j = 0; j + part.cellsJ <= G; j += placementStep) {
        const corners = [[i, j], [i + part.cellsI, j], [i, j + part.cellsJ], [i + part.cellsI, j + part.cellsJ]];
        if (i + j + (part.cellsI + part.cellsJ) / 2 > centre * 2) continue;
        const distance = Math.min(...sides.map(({ a, di, dj }) => {
          const length = Math.hypot(di, dj);
          return Math.min(...corners.map(([ci, cj]) => (di * (cj - a[1]) - dj * (ci - a[0])) / length));
        }));
        spots.push([distance + random() * 0.35, i, j]);
      }
    }
    spots.sort((a, b) => a[0] - b[0]);
    return spots.some(([, i, j]) => place(part, i, j));
  };
  const pick = (parts: readonly TownPart[]) => parts[Math.floor(random() * parts.length)];

  // A keep is one joined complex: the wing projects from a short end,
  // with the main keep consuming the shared keep/tower slot.
  if (kind === "keep") {
    const main = partNamed("keep");
    const i = centre - 2, j = centre - 2;
    place(main, i, j);
    const alongI = random() < 0.5;
    const preferredWing = partNamed(`castle-house-gable-${alongI ? "right" : "left"}`);
    const customWings = houseParts.filter((part) => !spec.houseParts.some(({ name }) => name === part.name));
    const wing = customWings.length > 0
      ? pick([...houseParts.filter(({ name }) => name === preferredWing.name), ...customWings])
      : houseParts.find(({ name }) => name === preferredWing.name) ?? houseParts[0];
    const offset = between([0, 1]);
    if (wing) place(wing, alongI ? i + main.cellsI : i + offset, alongI ? j + offset : j + main.cellsJ);
    for (const landmark of landmarks) {
      if (landmark.parts.some(({ name }) => name === "keep") || landmark.parts.length === 0) continue;
      if (random() < landmark.chance) placeNear(pick(landmark.parts), centre, centre, 0.08);
    }
  } else {
    // Civic landmarks in the centre, defensive landmarks beside the rear walls, then houses.
    const back = centre * 0.6;
    for (const landmark of landmarks) {
      if (landmark.parts.length === 0) continue;
      if (random() >= landmark.chance) continue;
      const target = landmark.near === "back" ? back : centre;
      const part = pick(landmark.parts);
      if (wall && isKeepOrTowerPart(part.name)) placeNearWall(part);
      else placeNear(part, target, target, 0.08);
    }
    const towers = Math.max(between(spec.towers), towerParts.length > 0 && spec.towerParts.length === 0 ? 1 : 0);
    for (let count = 0; count < towers && towerParts.length > 0; count++) {
      const part = pick(towerParts);
      if (wall) placeNearWall(part);
      else placeNear(part, back, back, 0.4);
    }
    const houseTarget = between(spec.houses);
    let houses = 0;
    let misses = 0;
    while (houses < houseTarget && placed.length < buildingLimit && misses < 30 && houseParts.length > 0) {
      const availableHouses = spec.maxLargeHouses === undefined ? houseParts : houseParts.filter(canAddPart);
      if (availableHouses.length === 0) break;
      if (placeNear(pick(availableHouses), centre, centre, spec.spread)) houses++;
      else misses++;
    }
  }

  // Try every half-cell origin with smaller buildings, sheds before huts,
  // filling as much as the clearance allows. Open settlements retain yards.
  const sweep = [...hutCells].flatMap((cell) => {
    const [i, j] = cell.split(",").map(Number);
    const origins: [number, number][] = [];
    for (let di = 0; di < 1; di += placementStep) {
      for (let dj = 0; dj < 1; dj += placementStep) origins.push([i + di, j + dj]);
    }
    return origins;
  });
  for (let index = sweep.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [sweep[index], sweep[swap]] = [sweep[swap], sweep[index]];
  }
  const sweepParts = [...fillers].sort((a, b) => b.cellsI * b.cellsJ - a.cellsI * a.cellsJ);
  const besideBuilding = (i: number, j: number) => {
    const reach = buildingGap + 1;
    for (let di = -reach; di <= reach; di += placementStep) {
      for (let dj = -reach; dj <= reach; dj += placementStep) if (occupied.has(key(i + di, j + dj))) return true;
    }
    return false;
  };
  for (const [i, j] of sweep) {
    if (placed.length >= buildingLimit) break;
    if (!packed && random() < spec.yards) continue;
    if (spec.fillers === "around" && !besideBuilding(i, j)) continue;
    for (const part of sweepParts) {
      if (!packed && random() < 0.5 && part.cellsI * part.cellsJ > 1) continue;
      if (place(part, i, j)) break;
    }
  }

  // The settlement stands on the map itself: its footprint sizes the sprite and
  // is kept as an invisible path, but no coloured base is drawn.
  let ground: IsoShape;
  if (wall) {
    ground = wall.ground;
  } else {
    const cells = [...occupied].map((cell) => cell.split(",").map(Number) as unknown as Vec2);
    ground = groundPatch(cells.length > 0 ? cells : [[centre, centre]], placementStep, 0.7, random);
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

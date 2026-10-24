/**
 * Writes the town building SVGs in src/assets/structures/town-parts.
 * Run with `node scripts/generate-town-parts.ts` after changing a design
 * below. Files edited in /structure-lab carry `data-edited` and are left
 * alone; `--force` overwrites them too. `--only=name,name` limits generation
 * to the selected parts.
 *
 * Each file carries what the composer needs to put it on the iso grid:
 * `data-footprint` (cells along i and j) and `data-origin` (where grid
 * point (0, 0) of the footprint sits in the viewBox). Every path names its
 * layer (`data-layer`), which the lab lists for reordering and swapping.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  box,
  doorway,
  gableHouse,
  HAND_FILTER,
  INK,
  keep,
  named,
  PLASTER,
  ROOF_PALETTES,
  roundTower,
  shapeBounds,
  shapesToSvg,
  SOFT_WOBBLE,
  STONE,
  SVG_ROOT_ATTRIBUTES,
  tower,
  translateShapes,
  WALL,
  WALL_PIECE_RADIUS,
  WALL_STEPS,
  wallGate,
  wallLength,
  wallOpening,
  wallRun,
  type GableHouse,
  type IsoShape,
  type WallDirection,
} from "../src/structures/isoDraw.ts";

const OUT = new URL("../src/assets/structures/town-parts/", import.meta.url);
const FORCE = process.argv.includes("--force");
// Regenerate selected designs without touching unrelated building assets.
const ONLY = process.argv.find((argument) => argument.startsWith("--only="))?.slice(7).split(",");
const skipped: string[] = [];

const fmt = (value: number) => (Math.round(value * 100) / 100).toString();

/** `wobble` lets edges stray from straight, for the freehand look of castle parts. */
function writePart(name: string, shapes: IsoShape[], footprint: [number, number], wobble = 0) {
  if (ONLY && !ONLY.includes(name)) return;
  const file = new URL(`${name}.svg`, OUT);
  if (!FORCE && existsSync(file) && /<svg\b[^>]*\sdata-edited=/.test(readFileSync(file, "utf8"))) {
    skipped.push(name);
    return;
  }
  const bounds = shapeBounds(shapes);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width * 3)}" height="${fmt(height * 3)}" `
    + `viewBox="0 0 ${fmt(width)} ${fmt(height)}" data-footprint="${footprint.join(" ")}" `
    + `data-origin="${fmt(-bounds.minX)} ${fmt(-bounds.minY)}" ${SVG_ROOT_ATTRIBUTES}>\n`
    + `<defs>${HAND_FILTER}</defs>\n`
    + `<g class="part" filter="url(#hand)">\n${shapesToSvg(shapes, -bounds.minX, -bounds.minY, wobble)}\n</g>\n</svg>\n`;
  writeFileSync(file, svg);
}

const HOUSES: Record<string, Omit<GableHouse, "ridge">> = {
  cottage: { length: 2, width: 2, wall: 1.1, rise: 1.05, chimney: 0.3, door: 0.7 },
  house: { length: 3, width: 2, wall: 1.25, rise: 1.1, chimney: 0.75, door: 0.3 },
  townhouse: { length: 2, width: 2, wall: 2.1, rise: 1.15, floors: 2, door: 0.4 },
  longhouse: { length: 4, width: 2, wall: 1.15, rise: 1.05, chimney: 0.2, door: 0.6 },
  hall: { length: 3, width: 3, wall: 1.5, rise: 1.45, chimney: 0.8, door: 0.5 },
  // Small fillers for the gaps between houses.
  shed: { length: 2, width: 1, wall: 0.85, rise: 0.6, door: 0.25 },
  hut: { length: 1, width: 1, wall: 0.75, rise: 0.65 },
};

mkdirSync(OUT, { recursive: true });
for (const [name, house] of Object.entries(HOUSES)) {
  // Ridge along i puts the gable on the right, along j on the left.
  writePart(`${name}-gable-right`, gableHouse({ ...house, ridge: "i" }), [house.length, house.width]);
  writePart(`${name}-gable-left`, gableHouse({ ...house, ridge: "j" }), [house.width, house.length]);
}
writePart("tower", tower({ size: 2, height: 3.8, rise: 1.9 }), [2, 2]);

// Keeps: tall plain hip-roofed blocks, slate by default.
writePart("keep", keep({ sizeI: 3, sizeJ: 3, height: 4.4, rise: 2.4, door: true }), [3, 3], SOFT_WOBBLE);
writePart("great-keep", keep({ sizeI: 4, sizeJ: 4, height: 5.4, rise: 3, door: true }), [4, 4], SOFT_WOBBLE);

// Round towers with a cone roof for the castle corners; two builds so the
// corners are not all alike.
writePart("turret", translateShapes(roundTower({ radius: 1.2, height: 3.4, roof: 2.5, flare: 0.3, slits: 3 }), 1.5, 1.5), [3, 3], SOFT_WOBBLE);
writePart("turret-tall", translateShapes(roundTower({ radius: 1.1, height: 4, roof: 2.8, flare: 0.32, slits: 3 }), 1.5, 1.5), [3, 3], SOFT_WOBBLE);

// A slim turret for the inside corners of the curtain wall, one cell across.
writePart("turret-small", translateShapes(roundTower({ radius: 0.62, height: 3.1, roof: 1.6, flare: 0.12, flareHeight: 0.35, slits: 1 }), 0.5, 0.5), [1, 1], SOFT_WOBBLE);

// Walls, shared by castles, walled towns and cities: each file is one whole
// straight wall, "wall-<direction>-N", centred on the line from its grid
// point (0, 0) (the end with the smaller i, or j along j). Along i and j it
// is N cells long; "flat" (across the screen) and "steep" (down it) are the
// diagonals of a town wall, the wall between two round pieces N steps apart.
const WALL_LENGTHS: Record<WallDirection, number> = { i: 6, j: 6, flat: 4, steep: 4 };
for (const direction of Object.keys(WALL_STEPS) as WallDirection[]) {
  const [si, sj] = WALL_STEPS[direction];
  for (let n = 1; n <= WALL_LENGTHS[direction]; n++) {
    const footprint: [number, number] = [Math.max(1, Math.abs(si) * n), Math.max(1, Math.abs(sj) * n)];
    writePart(`wall-${direction}-${n}`, wallRun(WALL, direction, wallLength(direction, n)), footprint);
  }
}
// The round pieces on a town wall's corners and partway along long sides,
// a drum or a roofed tower, and the town gatehouses, two cells of wall long.
writePart("wall-drum", roundTower({ radius: WALL_PIECE_RADIUS, height: WALL.height + 0.25, roof: 0, flare: 0.06, flareHeight: 0.25, slits: 0, palette: STONE }), [1, 1]);
writePart("wall-tower", roundTower({ radius: WALL_PIECE_RADIUS, height: WALL.height + 1.05, roof: 1.3, flare: 0.08, flareHeight: 0.3, overhang: 0.16, slits: 1, palette: STONE }), [1, 1]);
writePart("wall-gate-i", wallGate(WALL, "i"), [2, 1]);
writePart("wall-gate-j", wallGate(WALL, "j"), [1, 2]);

// Gatehouses stand across a wall, the gate in the gable end facing out:
// "gable-right" for a wall facing +i, "gable-left" for one facing +j.
const gatehouse: Omit<GableHouse, "ridge"> = { length: 2, width: 3, wall: 2.7, rise: 1.6, gate: "gable", streaks: false, boards: false, arched: true };
writePart("gatehouse-gable-right", gableHouse({ ...gatehouse, ridge: "i" }), [2, 3], SOFT_WOBBLE);
writePart("gatehouse-gable-left", gableHouse({ ...gatehouse, ridge: "j" }), [3, 2], SOFT_WOBBLE);

// Castle buildings: plain slate roofs and tall arched windows, their eaves
// above the curtain wall (2.1) so their walls show over it.
const CASTLE_BUILDINGS: Record<string, Omit<GableHouse, "ridge">> = {
  "castle-hall": { length: 5, width: 2, wall: 2.8, rise: 1.5, chimney: 0.78, door: 0.25 },
  "castle-chapel": { length: 4, width: 2, wall: 3, rise: 1.6, door: 0.9 },
  "castle-house": { length: 3, width: 2, wall: 2.5, rise: 1.4, chimney: 0.3, door: 0.6 },
  "castle-lodge": { length: 2, width: 2, wall: 2.4, rise: 1.3, door: 0.3 },
};
for (const [name, building] of Object.entries(CASTLE_BUILDINGS)) {
  const plain = { ...building, streaks: false, boards: false, arched: true };
  writePart(`${name}-gable-right`, gableHouse({ ...plain, ridge: "i" }), [building.length, building.width], SOFT_WOBBLE);
  writePart(`${name}-gable-left`, gableHouse({ ...plain, ridge: "j" }), [building.width, building.length], SOFT_WOBBLE);
}

// Church: a bell tower behind a long nave, so the nave is drawn over its foot.
const nave: Omit<GableHouse, "ridge"> = { length: 4, width: 1.6, wall: 1.8, rise: 1.2, door: 0.5, arched: true, streaks: false };
const belfry = tower({ size: 1.6, height: 2.88, rise: 1.84, slits: 2 }).map((shape) => ({ ...shape, layer: `tower ${shape.layer}` }));
writePart("church-gable-right", [...belfry, ...translateShapes(gableHouse({ ...nave, ridge: "i" }), 1.6, 0)], [6, 2]);
writePart("church-gable-left", [...belfry, ...translateShapes(gableHouse({ ...nave, ridge: "j" }), 0, 1.6)], [2, 6]);

/** A city cathedral: low side aisles, a raised nave and paired spires flanking a rose window. */
function cathedral(ridge: "i" | "j"): IsoShape[] {
  const stone = (shapes: IsoShape[], prefix: string) => shapes.map((shape) => ({
    ...shape,
    fill: shape.fill === PLASTER.lit ? STONE.lit : shape.fill === PLASTER.shade ? STONE.shade : shape.fill,
    layer: `${prefix} ${shape.layer ?? "walls"}`,
  }));
  const aisle = (j: number, prefix: string) => stone(translateShapes(gableHouse({
    length: 6, width: 0.6, wall: 1.55, rise: 0.5, ridge: "i", boards: false, streaks: false,
  }), 0.3, j), prefix).filter(({ layer }) => !/windows|door/.test(layer));
  const spire = (j: number, prefix: string) => stone(translateShapes(tower({
    size: 1.35, height: 4.2, rise: 1.9, palette: STONE, slits: 2,
  }), 6.25, j), prefix).filter(({ layer }) => !layer.endsWith("roof lines"));
  const nave = stone(translateShapes(gableHouse({
    length: 7.4, width: 2.4, wall: 2.9, rise: 1.65, ridge: "i", boards: false, streaks: false,
  }), 0.3, 0.8), "nave").filter(({ layer }) => !/windows|door/.test(layer));
  const shapes = [...aisle(0.2, "far aisle"), ...spire(0.2, "far belfry"), ...nave, ...aisle(3.2, "near aisle")];
  // Buttresses and paired pointed windows along the visible aisle and clerestory.
  const lancet = (u: number, width: number, height: number): [number, number][] => [
    [u - width / 2, 0], [u + width / 2, 0], [u + width / 2, height * 0.65],
    [u + width * 0.3, height * 0.87], [u, height],
    [u - width * 0.3, height * 0.87], [u - width / 2, height * 0.65],
  ];
  const buttresses: IsoShape[] = [], aisleWindows: IsoShape[] = [], clerestoryWindows: IsoShape[] = [];
  for (const i of [1, 2.2, 3.4, 4.6, 5.8]) {
    buttresses.push(...named("buttresses", box(i - 0.12, 3.65, i + 0.12, 3.95, 0, 1.8, STONE)));
    if (i > 5) continue;
    for (const offset of [-0.17, 0.17]) {
      aisleWindows.push({ ...wallOpening([0, 3.8, 0.5], [1, 0], lancet(i + 0.6 + offset, 0.18, 0.85)), layer: "aisle windows" });
      clerestoryWindows.push({ ...wallOpening([0, 3.2, 2.1], [1, 0], lancet(i + 0.6 + offset, 0.17, 0.5)), layer: "clerestory windows" });
    }
  }
  shapes.push(...buttresses, ...aisleWindows, ...clerestoryWindows);
  shapes.push(...named("portal", doorway([7.7, 0, 0], [0, 1], 2, 0.9, 1.5)));
  const circle = (radius: number): [number, number][] => Array.from({ length: 16 }, (_, index) => {
    const angle = index / 16 * Math.PI * 2;
    return [2 + Math.cos(angle) * radius, 2.65 + Math.sin(angle) * radius];
  });
  shapes.push({ ...wallOpening([7.7, 0, 0], [0, 1], circle(0.52), STONE.lit), layer: "rose window stone" });
  shapes.push({ ...wallOpening([7.7, 0, 0], [0, 1], circle(0.36), INK), layer: "rose window" });
  shapes.push(...spire(2.45, "near belfry"));
  if (ridge === "i") return shapes;
  // Mirror the geometry and lighting together, keeping light from screen left.
  return shapes.map((shape) => ({
    ...shape,
    points: shape.points.map(([i, j, z]) => [j, i, z] as const),
    fill: shape.fill === STONE.lit ? STONE.shade : shape.fill === STONE.shade ? STONE.lit
      : shape.fill === ROOF_PALETTES[0].lit ? ROOF_PALETTES[0].shade
        : shape.fill === ROOF_PALETTES[0].shade ? ROOF_PALETTES[0].lit : shape.fill,
    className: shape.className === "roof-lit" ? "roof-shade" : shape.className === "roof-shade" ? "roof-lit" : shape.className,
  }));
}
writePart("cathedral-gable-right", cathedral("i"), [8, 4]);
writePart("cathedral-gable-left", cathedral("j"), [4, 8]);

if (skipped.length > 0) console.log(`Kept hand-edited parts (--force overwrites them): ${skipped.join(", ")}`);

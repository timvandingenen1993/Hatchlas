/**
 * Isometric drawing kit for town sprites. Points are (i, j, z) in grid
 * cells: i runs down-right on screen, j down-left, z up. Shapes are
 * polygons in that space; each primitive emits only the faces turned to the
 * viewer, ordered back to front, so a primitive paints correctly on its own.
 *
 * This module has no imports so `scripts/generate-town-parts.ts` can run it
 * directly under Node to author the building SVGs.
 */
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

/** Screen units per grid cell edge. */
export const CELL = 10;
const COS30 = Math.sqrt(3) / 2;

export const INK = "#2a1e16";
/** The one ink width. Every outline, window edge and course line uses it. */
export const STROKE_WIDTH = 1.1;

export interface Palette {
  /** Faces turned towards the light, which comes from screen left. */
  lit: string;
  mid: string;
  shade: string;
  top: string;
}

export const PLASTER: Palette = { lit: "#ece1c9", mid: "#ddcfb1", shade: "#c4b393", top: "#e6dac0" };
export const STONE: Palette = { lit: "#e4d8bd", mid: "#d3c4a3", shade: "#b9a684", top: "#ddd0b3" };
export const GROUND = "#a8916e";

/** Roof colours; the composer recolours these by class per building. */
export interface RoofPalette {
  lit: string;
  /** Steps between lit and shade, so a cone's slopes turn smoothly. */
  lm: string;
  mid: string;
  ms: string;
  shade: string;
}

/** Roof tones from the light round to the shade; each is a `roof-<tone>` class. */
const ROOF_TONES = ["lit", "lm", "mid", "ms", "shade"] as const;
type RoofTone = (typeof ROOF_TONES)[number];

function mix(from: string, to: string, t: number): string {
  const channel = (hex: string, index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return "#" + [0, 1, 2].map((index) =>
    Math.round(channel(from, index) + (channel(to, index) - channel(from, index)) * t).toString(16).padStart(2, "0")).join("");
}

const roofPalette = (lit: string, shade: string): RoofPalette =>
  ({ lit, lm: mix(lit, shade, 0.25), mid: mix(lit, shade, 0.5), ms: mix(lit, shade, 0.75), shade });

export const ROOF_PALETTES: readonly RoofPalette[] = [
  roofPalette("#a07f5f", "#7b5e45"),
  roofPalette("#797c81", "#565a5f"),
  roofPalette("#b39470", "#8e7353"),
  roofPalette("#a56f52", "#82543d"),
];

/**
 * Warm weathered slate for castles and keeps, as `.p${CASTLE_SLATE}`. It
 * sits after the palettes settlements pick from at random, so it is only
 * ever chosen on purpose.
 */
export const CASTLE_SLATE = ROOF_PALETTES.length;
const ALL_ROOF_PALETTES = [...ROOF_PALETTES, roofPalette("#8c8178", "#564d48")];

/** Rules that colour the roof classes inside a `.pN` group by palette. */
export const ROOF_CSS = ALL_ROOF_PALETTES.map((palette, index) => ROOF_TONES.map((tone) =>
  `.p${index} .roof-${tone}{fill:${palette[tone]}}`
  // Seams between the facets of a cone take the facet's own colour, never ink.
  + `.p${index} .roof-seam.roof-${tone}{stroke:${palette[tone]}}`).join("")).join("");

export const WOOD = "#7a4b2c";

export interface IsoShape {
  points: readonly Vec3[];
  fill?: string;
  className?: string;
  /** Open ink line for surface texture: same colour and width as every outline. */
  detail?: boolean;
  /** Ink outline only, no fill; drawn over facets so it keeps its full width. */
  outline?: boolean;
  /** Fill without ink outline. */
  seamless?: boolean;
  /** Part of the building it draws ("roof", "windows"), written as `data-layer` for /structure-lab. */
  layer?: string;
}

/** Gives `shapes` the layer `name`, keeping the layer of any shape that already has one. */
export function named(name: string, shapes: readonly IsoShape[]): IsoShape[] {
  return shapes.map((shape) => ({ ...shape, layer: shape.layer ?? name }));
}

export function project(point: Vec3): Vec2 {
  return [(point[0] - point[1]) * COS30 * CELL, ((point[0] + point[1]) * 0.5 - point[2]) * CELL];
}

export function translateShapes(shapes: readonly IsoShape[], di: number, dj: number, dz = 0): IsoShape[] {
  return shapes.map((shape) => ({
    ...shape,
    points: shape.points.map(([i, j, z]) => [i + di, j + dj, z + dz] as const),
  }));
}

/** Light falls from screen left, i.e. from -i/+j. */
function tone(ni: number, nj: number): "lit" | "mid" | "shade" {
  const facing = (nj - ni) / Math.hypot(ni, nj);
  return facing > 0.35 ? "lit" : facing < -0.35 ? "shade" : "mid";
}

function faceFill(palette: Palette, ni: number, nj: number): string {
  return palette[tone(ni, nj)];
}

function roofFace(ni: number, nj: number): Pick<IsoShape, "fill" | "className"> {
  const lit = tone(ni, nj) === "lit";
  return { fill: lit ? ROOF_PALETTES[0].lit : ROOF_PALETTES[0].shade, className: lit ? "roof-lit" : "roof-shade" };
}

const ROOF_EDGE: Pick<IsoShape, "fill" | "className"> = { fill: ROOF_PALETTES[0].shade, className: "roof-shade" };

/** Visible faces of a convex vertical prism over `footprint` (i, j). */
export function prism(footprint: readonly Vec2[], z0: number, z1: number, palette: Palette, top = true): IsoShape[] {
  const ci = footprint.reduce((sum, p) => sum + p[0], 0) / footprint.length;
  const cj = footprint.reduce((sum, p) => sum + p[1], 0) / footprint.length;
  const shapes: IsoShape[] = [];
  footprint.forEach((a, index) => {
    const b = footprint[(index + 1) % footprint.length];
    let ni = b[1] - a[1];
    let nj = a[0] - b[0];
    if (((a[0] + b[0]) / 2 - ci) * ni + ((a[1] + b[1]) / 2 - cj) * nj < 0) {
      ni = -ni;
      nj = -nj;
    }
    if (ni + nj <= 1e-9) return;
    shapes.push({
      points: [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]],
      fill: faceFill(palette, ni, nj),
    });
  });
  if (top) shapes.push({ points: footprint.map(([i, j]) => [i, j, z1] as const), fill: palette.top });
  return shapes;
}

export function box(i0: number, j0: number, i1: number, j1: number, z0: number, z1: number, palette: Palette, top = true): IsoShape[] {
  return prism([[i0, j0], [i1, j0], [i1, j1], [i0, j1]], z0, z1, palette, top);
}

/**
 * Points of a 2D outline drawn on a wall plane: `origin` is the outline's
 * (0, 0), `along` the horizontal unit direction on the wall, z is up.
 */
function onWall(origin: Vec3, along: Vec2, outline: readonly Vec2[]): Vec3[] {
  return outline.map(([u, v]) => [origin[0] + along[0] * u, origin[1] + along[1] * u, origin[2] + v] as const);
}

function rect(u: number, v: number, width: number, height: number): Vec2[] {
  return [[u, v], [u + width, v], [u + width, v + height], [u, v + height]];
}

/** Round-headed opening, `u` at its centre. */
export function arch(u: number, width: number, height: number): Vec2[] {
  const radius = width / 2;
  const spring = Math.max(0, height - radius);
  const points: Vec2[] = [[u - radius, 0]];
  for (let step = 0; step <= 8; step++) {
    const angle = Math.PI - (step / 8) * Math.PI;
    points.push([u + Math.cos(angle) * radius, spring + Math.sin(angle) * radius]);
  }
  points.push([u + radius, 0]);
  return points;
}

export function wallOpening(origin: Vec3, along: Vec2, outline: readonly Vec2[], fill = INK): IsoShape {
  return { points: onWall(origin, along, outline), fill };
}

/** Small deterministic jitter so texture lines do not look ruled. */
function jitter(index: number, salt: number): number {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value) - 0.5;
}

export interface GableHouse {
  /** Cells along the ridge. */
  length: number;
  /** Cells across the ridge. */
  width: number;
  /** Eave height in cells. */
  wall: number;
  /** Ridge height above the eaves. */
  rise: number;
  /** Ridge direction on the grid. */
  ridge: "i" | "j";
  floors?: number;
  /** Ridge position (0..1) of a chimney on the back slope. */
  chimney?: number;
  /** Door slot along the eave wall (0..1). */
  door?: number;
  /**
   * A gatehouse: one wide wooden arch, on the eave wall (no other openings
   * there) or in the gable end, which then faces out of the wall.
   */
  gate?: "eave" | "gable";
  /** Ink streaks down the front slope; off for the plain slate of castle roofs. */
  streaks?: boolean;
  /** Tall round-headed windows set high in the wall, as in a hall or chapel. */
  arched?: boolean;
  /**
   * Thin boards under the roof edges. Their two ink lines sit close enough
   * to read as one heavy edge, so castle buildings leave them off.
   */
  boards?: boolean;
}

/**
 * An arched wooden door in a dressed stone surround, with plank joints:
 * `u` is its centre along the wall.
 */
export function doorway(origin: Vec3, along: Vec2, u: number, width: number, height: number, stone = STONE): IsoShape[] {
  const rim = Math.min(0.14, width * 0.16);
  const shapes: IsoShape[] = [
    wallOpening(origin, along, arch(u, width + rim * 2, height + rim), stone.lit),
    wallOpening(origin, along, arch(u, width, height), WOOD),
  ];
  const planks = Math.max(1, Math.round(width / 0.4));
  for (let index = 1; index < planks; index++) {
    const x = u - width / 2 + (index / planks) * width;
    const radius = width / 2;
    const top = Math.max(0, height - radius) + Math.sqrt(Math.max(0, radius * radius - (x - u) ** 2)) - 0.08;
    shapes.push({ points: onWall(origin, along, [[x, 0.06], [x, top]]), detail: true });
  }
  return shapes;
}

/** A short spike with a knob, standing on `apex`. */
export function finial(apex: Vec3, height = 0.55): IsoShape[] {
  const knobZ = apex[2] + height * 0.55;
  const radius = 0.07;
  // A disc facing the viewer: across the screen is (+i, -j), up is z.
  const knob: Vec3[] = Array.from({ length: 8 }, (_, step) => {
    const angle = (step / 8) * Math.PI * 2;
    const across = (Math.cos(angle) * radius) / Math.SQRT2;
    return [apex[0] + across, apex[1] - across, knobZ + Math.sin(angle) * radius * 1.15] as const;
  });
  return named("finial", [
    { points: [apex, [apex[0], apex[1], apex[2] + height]], detail: true },
    { points: knob, fill: INK },
  ]);
}

export function gableHouse(house: GableHouse): IsoShape[] {
  const { length: L, width: W, wall: H, rise: R } = house;
  const floors = house.floors ?? 1;
  const overhang = 0.2;
  const eave = 0.16;
  const board = 0.1;
  const slope = R / (W / 2);
  const ridgeZ = H + R;
  const eaveZ = H - eave * slope;
  // Authored with the ridge along i; swapping axes turns it to j.
  const swap = house.ridge === "j";
  const at = (i: number, j: number, z: number): Vec3 => (swap ? [j, i, z] : [i, j, z]);
  const dir = (i: number, j: number): Vec2 => (swap ? [j, i] : [i, j]);
  const normal = (ni: number, nj: number): [number, number] => (swap ? [nj, ni] : [ni, nj]);
  const shapes: IsoShape[] = [];

  const R0 = at(-overhang, W / 2, ridgeZ), R1 = at(L + overhang, W / 2, ridgeZ);
  const F0 = at(-overhang, W + eave, eaveZ), F1 = at(L + overhang, W + eave, eaveZ);
  const B0 = at(-overhang, -eave, eaveZ), B1 = at(L + overhang, -eave, eaveZ);
  const down = (p: Vec3): Vec3 => [p[0], p[1], p[2] - board];

  // Back slope shows only when the roof is flatter than the view.
  if (R < W / 2) shapes.push({ points: [R0, R1, B1, B0], ...roofFace(...normal(0, -1)), layer: "back roof" });

  if (house.chimney !== undefined) {
    const c = house.chimney * L;
    const corners: Vec2[] = [dir(c - 0.18, W / 2 - 0.62), dir(c + 0.18, W / 2 - 0.62), dir(c + 0.18, W / 2 - 0.22), dir(c - 0.18, W / 2 - 0.22)];
    shapes.push(...named("chimney", prism(corners, H, ridgeZ + 0.4, STONE)));
  }

  // Eave wall and gable end.
  const [eni, enj] = normal(0, 1);
  const [gni, gnj] = normal(1, 0);
  shapes.push(...named("walls", [
    { points: [at(0, W, 0), at(L, W, 0), at(L, W, H), at(0, W, H)], fill: faceFill(PLASTER, eni, enj) },
    { points: [at(L, 0, 0), at(L, W, 0), at(L, W, H), at(L, W / 2, ridgeZ), at(L, 0, H)], fill: faceFill(PLASTER, gni, gnj) },
  ]));

  // Openings on the eave wall: windows per floor, one door on the ground.
  // Openings never overlap, so the doors can follow all the windows and
  // each is one layer.
  const windows: IsoShape[] = [];
  const doors: IsoShape[] = [];
  const eaveOrigin = at(0, W, 0);
  const eaveAlong = dir(1, 0);
  const slots = Math.max(1, Math.round(L / 0.85));
  const doorSlot = Math.min(slots - 1, Math.floor((house.door ?? 0.5) * slots));
  const floorHeight = H / floors;
  if (house.gate === "eave") {
    doors.push(...doorway(eaveOrigin, eaveAlong, (house.door ?? 0.5) * L, Math.min(1.3, L * 0.42), Math.min(1.9, H * 0.72)));
  }
  /** A window on a wall; arched ones stand tall in the upper part of the floor. */
  const windowAt = (origin: Vec3, along: Vec2, u: number, floor: number, salt: number): IsoShape => {
    if (house.arched) {
      const height = Math.min(0.85, floorHeight * 0.34);
      const base = floor * floorHeight + floorHeight * 0.42 + jitter(salt, L + W) * 0.08;
      return wallOpening(origin, along, arch(u, 0.22, height).map(([x, y]) => [x, y + base] as const));
    }
    const base = floor * floorHeight + floorHeight * 0.3;
    return wallOpening(origin, along, rect(u - 0.1, base, 0.2, Math.min(0.34, floorHeight * 0.36)));
  };
  for (let floor = 0; floor < floors && house.gate !== "eave"; floor++) {
    for (let slot = 0; slot < slots; slot++) {
      const u = ((slot + 0.5) / slots) * L;
      if (floor === 0 && slot === doorSlot && !house.gate) {
        if (house.arched) doors.push(...doorway(eaveOrigin, eaveAlong, u, 0.42, Math.min(0.85, floorHeight * 0.4)));
        else doors.push(wallOpening(eaveOrigin, eaveAlong, arch(u, 0.36, Math.min(0.72, floorHeight * 0.68))));
      } else {
        windows.push(windowAt(eaveOrigin, eaveAlong, u, floor, slot + floor * 7));
      }
    }
  }
  // Gable end: a window per floor, or the gate, and one in the gable.
  const gableOrigin = at(L, 0, 0);
  const gableAlong = dir(0, 1);
  if (house.gate === "gable") {
    doors.push(...doorway(gableOrigin, gableAlong, W / 2, Math.min(1.2, W * 0.4), Math.min(1.8, H * 0.7)));
  } else {
    for (let floor = 0; floor < floors; floor++) windows.push(windowAt(gableOrigin, gableAlong, W / 2, floor, 31 + floor));
  }
  if (R > 0.7) windows.push(wallOpening(gableOrigin, gableAlong, rect(W / 2 - 0.08, H + R * 0.22, 0.16, 0.24)));
  shapes.push(...named("windows", windows), ...named(house.gate ? "gate" : "door", doors));

  // Roof boards along the gable end and the front eave, then the front slope.
  if (house.boards !== false) {
    shapes.push(...named("eaves", [
      { points: [R1, B1, down(B1), down(R1)], ...ROOF_EDGE },
      { points: [R1, F1, down(F1), down(R1)], ...ROOF_EDGE },
      { points: [F0, F1, down(F1), down(F0)], ...ROOF_EDGE },
    ]));
  }
  shapes.push({ points: [R0, R1, F1, F0], ...roofFace(...normal(0, 1)), layer: "roof" });

  if (house.streaks === false) return shapes;
  // Streaks down the front slope.
  const span = L + overhang * 2;
  const count = Math.round(span / 0.5);
  for (let index = 1; index < count; index++) {
    const i = -overhang + (index / count) * span + jitter(index, L) * 0.08;
    const start = 0.12 + Math.abs(jitter(index, W)) * 0.25;
    const end = 0.92 - Math.abs(jitter(index, R)) * 0.2;
    const point = (t: number) => at(i, W / 2 + t * (W / 2 + eave), ridgeZ - t * (R + eave * slope));
    shapes.push({ points: [point(start), point(end)], detail: true, layer: "roof lines" });
  }
  return shapes;
}

export interface Tower {
  size: number;
  height: number;
  rise: number;
  palette?: Palette;
  /** Slit windows stacked up the tower. */
  slits?: number;
}

export function tower(definition: Tower): IsoShape[] {
  const { size: s, height: H, rise: R } = definition;
  const palette = definition.palette ?? PLASTER;
  const overhang = Math.min(0.22, s * 0.16);
  const board = 0.1;
  const shapes = named("walls", box(0, 0, s, s, 0, H, palette, false));
  const slits = definition.slits ?? Math.max(1, Math.floor(H / 1.1));
  for (let level = 0; level < slits; level++) {
    const height = Math.min(0.42, H * 0.12);
    const base = slits === 1 ? H * 0.45 : H * 0.2 + ((H * 0.75 - height - H * 0.2) * level) / (slits - 1);
    shapes.push(...named("windows", [
      wallOpening([s, 0, 0], [0, 1], rect(s / 2 - 0.07, base, 0.14, height)),
      wallOpening([0, s, 0], [1, 0], rect(s / 2 - 0.07, base, 0.14, height)),
    ]));
  }
  const lo = -overhang, hi = s + overhang, z = H - 0.05;
  const apex: Vec3 = [s / 2, s / 2, H + R];
  const right: Vec3 = [hi, lo, z], front: Vec3 = [hi, hi, z], left: Vec3 = [lo, hi, z];
  const down = (p: Vec3): Vec3 => [p[0], p[1], p[2] - board];
  shapes.push(...named("eaves", [
    { points: [right, front, down(front), down(right)], ...ROOF_EDGE },
    { points: [front, left, down(left), down(front)], ...ROOF_EDGE },
  ]));
  shapes.push(...named("roof", [
    { points: [right, front, apex], ...roofFace(1, 0) },
    { points: [front, left, apex], ...roofFace(0, 1) },
  ]));
  const count = Math.max(3, Math.round(s / 0.5));
  for (let index = 1; index < count; index++) {
    const t = index / count;
    for (const [a, b] of [[right, front], [front, left]] as const) {
      const base: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z];
      const k = 0.18 + Math.abs(jitter(index, s)) * 0.2;
      const from: Vec3 = [apex[0] + (base[0] - apex[0]) * k, apex[1] + (base[1] - apex[1]) * k, apex[2] + (base[2] - apex[2]) * k];
      shapes.push({ points: [from, [base[0] + (apex[0] - base[0]) * 0.06, base[1] + (apex[1] - base[1]) * 0.06, z + (apex[2] - z) * 0.06]], detail: true, layer: "roof lines" });
    }
  }
  return shapes;
}

/** Pyramid roof over a convex footprint; only the slopes facing the viewer. */
export function pyramid(footprint: readonly Vec2[], z: number, rise: number): IsoShape[] {
  const ci = footprint.reduce((sum, p) => sum + p[0], 0) / footprint.length;
  const cj = footprint.reduce((sum, p) => sum + p[1], 0) / footprint.length;
  const apex: Vec3 = [ci, cj, z + rise];
  const shapes: IsoShape[] = [];
  footprint.forEach((a, index) => {
    const b = footprint[(index + 1) % footprint.length];
    let ni = b[1] - a[1];
    let nj = a[0] - b[0];
    if (((a[0] + b[0]) / 2 - ci) * ni + ((a[1] + b[1]) / 2 - cj) * nj < 0) {
      ni = -ni;
      nj = -nj;
    }
    if (ni + nj <= 1e-9) return;
    shapes.push({ points: [[a[0], a[1], z], [b[0], b[1], z], apex], ...roofFace(ni, nj), layer: "roof" });
  });
  return shapes;
}

const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Darker band across the two visible faces of a rectangle, for plinths and
 * for the shadow a roof throws under its eaves.
 */
export function faceBand(i0: number, j0: number, i1: number, j1: number, z0: number, z1: number, palette: Palette, darken = 0.18): IsoShape[] {
  // Half the ink width, in cells, so the band stops short of the face's edge line.
  const gap = STROKE_WIDTH / CELL / 2 + 0.02;
  const [a0, a1, b0, b1, y0, y1] = [j0 + gap, j1 - gap, i0 + gap, i1 - gap, z0 + gap, z1 - gap];
  return [
    { points: [[i1, a0, y0], [i1, a1, y0], [i1, a1, y1], [i1, a0, y1]], fill: mix(palette.shade, INK, darken), seamless: true },
    { points: [[b0, j1, y0], [b1, j1, y0], [b1, j1, y1], [b0, j1, y1]], fill: mix(palette.lit, INK, darken), seamless: true },
  ];
}

/** How far up the slope (0..1) the eave kick ends, and how much flatter it lies there. */
const KICK = 0.22;
const KICK_FLATTEN = 0.55;

/**
 * Pyramid-style hip roof over a rectangle: plain slopes that flatten a
 * little towards the eaves, and a finial on the point.
 */
export function hipRoof(i0: number, j0: number, i1: number, j1: number, z: number, rise: number, overhang = 0.14): IsoShape[] {
  const eaveZ = z - 0.05;
  const apex: Vec3 = [(i0 + i1) / 2, (j0 + j1) / 2, z + rise];
  const right: Vec3 = [i1 + overhang, j0 - overhang, eaveZ];
  const front: Vec3 = [i1 + overhang, j1 + overhang, eaveZ];
  const left: Vec3 = [i0 - overhang, j1 + overhang, eaveZ];
  /** Where the kick meets the steeper upper slope, above eave corner `p`. */
  const kick = (p: Vec3): Vec3 => {
    const along = lerp3(p, apex, KICK);
    return [along[0], along[1], eaveZ + (apex[2] - eaveZ) * KICK * KICK_FLATTEN];
  };
  const shapes: IsoShape[] = [];
  for (const [a, b, ni, nj] of [[right, front, 1, 0], [front, left, 0, 1]] as const) {
    // Both pieces of a slope are one surface: filled seamless, inked once round the whole.
    const lit = roofFace(ni, nj);
    const face = { ...lit, className: `${lit.className} roof-seam` };
    shapes.push({ points: [a, b, kick(b), kick(a)], ...face, seamless: true });
    shapes.push({ points: [kick(a), kick(b), apex], ...face, seamless: true });
    shapes.push({ points: [a, b, kick(b), apex, kick(a)], outline: true });
  }
  return [...named("roof", shapes), ...finial(apex)];
}

/** The four directions a wall runs in on the grid, and one step along each. */
export const WALL_STEPS = {
  i: [1, 0],
  j: [0, 1],
  /** Across the screen: from back-left to front-right is +i, -j. */
  flat: [1, -1],
  /** Straight down the screen: +i, +j. */
  steep: [1, 1],
} as const satisfies Record<string, Vec2>;
export type WallDirection = keyof typeof WALL_STEPS;

export interface WallSpec {
  height: number;
  thickness: number;
  /** Height of the darker band at the foot. */
  plinth: number;
  palette?: Palette;
}

/** The one wall, shared by castles, walled towns and cities, and by the part generator. */
export const WALL: WallSpec = { height: 1.7, thickness: 0.6, plinth: 0.25 };
/** Radius of the round drums and towers on a town wall's corners. */
export const WALL_PIECE_RADIUS = 0.6;
/** How far from the middle of a round piece the walls either side of it stop. */
export const WALL_PIECE_GAP = 0.5;

/**
 * Length of the wall file "wall-<direction>-<n>". Along i or j it is n
 * cells. On a diagonal it is the wall between two round pieces n steps
 * apart, so a little short of n steps.
 */
export function wallLength(direction: WallDirection, n: number): number {
  return direction === "i" || direction === "j" ? n : n * Math.SQRT2 - 2 * WALL_PIECE_GAP;
}

/**
 * A whole straight wall `length` long, from grid point (0, 0) along
 * `direction`, centred on that line: a plain block, a darker band at the
 * foot of the face the viewer sees, its top a single inked edge.
 */
export function wallRun(wall: WallSpec, direction: WallDirection, length: number): IsoShape[] {
  const palette = wall.palette ?? STONE;
  const [si, sj] = WALL_STEPS[direction];
  const d: Vec2 = [si / Math.hypot(si, sj), sj / Math.hypot(si, sj)];
  const across: Vec2 = [-d[1], d[0]];
  const at = (u: number, side: number): Vec2 =>
    [d[0] * u + across[0] * side * wall.thickness / 2, d[1] * u + across[1] * side * wall.thickness / 2];
  const shapes = named("walls", prism([at(0, -1), at(length, -1), at(length, 1), at(0, 1)], 0, wall.height, palette));
  // The plinth band, inset by half the ink width so it stops short of the face's edges.
  const gap = STROKE_WIDTH / CELL / 2 + 0.02;
  for (const side of [-1, 1]) {
    const [ni, nj] = [across[0] * side, across[1] * side];
    if (ni + nj <= 1e-9) continue;
    const [p, q] = [at(gap, side), at(length - gap, side)];
    shapes.push({
      points: [[p[0], p[1], gap], [q[0], q[1], gap], [q[0], q[1], wall.plinth], [p[0], p[1], wall.plinth]],
      fill: mix(faceFill(palette, ni, nj), INK, 0.16),
      seamless: true,
      layer: "plinth",
    });
  }
  return shapes;
}

/**
 * A town gatehouse on a wall along `direction` ("i" or "j"), centred on
 * grid point (0, 0) and two cells long. The gate faces out on the +j side
 * of an "i" wall and the +i side of a "j" wall: the sides facing the viewer.
 */
export function wallGate(wall: WallSpec, direction: "i" | "j", rise = 0.8): IsoShape[] {
  const half = 1;
  const inward = wall.thickness / 2 + 0.22;
  const outward = wall.thickness / 2 + 0.32;
  const at = (u: number, out: number): Vec2 => (direction === "i" ? [u, out] : [out, u]);
  const shapes = named("walls", prism([at(-half, -inward), at(half, -inward), at(half, outward), at(-half, outward)], 0, wall.height + rise, wall.palette ?? STONE));
  const face = at(-half, outward);
  shapes.push({ ...wallOpening([face[0], face[1], 0], direction === "i" ? [1, 0] : [0, 1], arch(half, 0.8, 1.05)), layer: "gate" });
  return shapes;
}

export interface RoundTower {
  radius: number;
  /** Shaft height; the flared foot sits within it and the cone roof above it. */
  height: number;
  /** Cone roof height; 0 for a flat-topped drum. */
  roof: number;
  /** Extra radius at the foot, and how high the flare rises. */
  flare?: number;
  flareHeight?: number;
  /** How far the cone's eaves overhang the shaft. */
  overhang?: number;
  palette?: Palette;
  /** Arrow slits up the front. */
  slits?: number;
}

/** Ground directions of the right and left silhouette of a round shape. */
const SILHOUETTE_RIGHT = -Math.PI / 4;
const SILHOUETTE_LEFT = (3 * Math.PI) / 4;
const ARC_STEPS = 10;

/** Tone of a curved face: -1 in shade, 0 side-on, 1 in light. */
function facing(angle: number): number {
  return (Math.sin(angle) - Math.cos(angle)) / Math.SQRT2;
}

function curvedFill(palette: Palette, tone: number): string {
  return tone >= 0 ? mix(palette.mid, palette.lit, tone) : mix(palette.mid, palette.shade, -tone);
}

/**
 * Round tower with a flared foot and a cone roof, centred on grid point
 * (0, 0). Each band (foot, shaft, cone) is an inked outline filled with
 * seamless facets, so curved faces read as one surface.
 */
export function roundTower(definition: RoundTower): IsoShape[] {
  const { radius: r, height: H, roof } = definition;
  const flare = definition.flare ?? 0.26;
  const flareHeight = definition.flareHeight ?? 0.55;
  const overhang = definition.overhang ?? 0.28;
  const palette = definition.palette ?? PLASTER;
  const ring = (radius: number, z: number, angle: number): Vec3 => [Math.cos(angle) * radius, Math.sin(angle) * radius, z];
  const angles = Array.from({ length: ARC_STEPS + 1 }, (_, step) =>
    SILHOUETTE_RIGHT + ((SILHOUETTE_LEFT - SILHOUETTE_RIGHT) * step) / ARC_STEPS);
  const shapes: IsoShape[] = [];

  /** A wall band between two profile rings, as layer `layer`. `shadow` darkens it. */
  const band = (layer: string, r0: number, z0: number, r1: number, z1: number, shadow = 0) => {
    const tint = (color: string) => (shadow > 0 ? mix(color, INK, shadow) : color);
    const outline: Vec3[] = [...angles.map((angle) => ring(r0, z0, angle)), ...[...angles].reverse().map((angle) => ring(r1, z1, angle))];
    const pieces: IsoShape[] = [{ points: outline, fill: tint(palette.mid) }];
    for (let step = 0; step < ARC_STEPS; step++) {
      const a0 = angles[step], a1 = angles[step + 1];
      const points: Vec3[] = [ring(r0, z0, a0), ring(r0, z0, a1), ring(r1, z1, a1), ring(r1, z1, a0)];
      pieces.push({ points, fill: tint(curvedFill(palette, facing((a0 + a1) / 2))), seamless: true });
    }
    // The facets cover half the band's ink edge; draw the edge again on top.
    pieces.push({ points: outline, outline: true });
    shapes.push(...named(layer, pieces));
  };

  const shadowHeight = roof > 0 ? Math.min(0.35, H * 0.12) : 0;
  band("base", r + flare, 0, r, flareHeight);
  band("walls", r, flareHeight, r, H - shadowHeight);
  if (shadowHeight > 0) band("eave shadow", r, H - shadowHeight, r, H, 0.2);

  const slits = definition.slits ?? 1;
  for (let level = 0; level < slits; level++) {
    const height = Math.min(0.5, H * 0.14);
    const base = slits === 1 ? H * 0.5 : H * 0.3 + ((H * 0.5 - height) * level) / (slits - 1);
    const half = 0.07 / r;
    const angle = FACING_VIEWER + (level % 2 === 0 ? 0 : 0.5);
    shapes.push({
      points: [ring(r, base, angle - half), ring(r, base, angle + half), ring(r, base + height, angle + half), ring(r, base + height, angle - half)],
      fill: INK,
      layer: "windows",
    });
  }

  if (roof <= 0) {
    // Flat top: the whole disc shows from above.
    const disc = Array.from({ length: ARC_STEPS * 2 }, (_, step) => ring(r, H, (step / (ARC_STEPS * 2)) * Math.PI * 2));
    shapes.push({ points: disc, fill: palette.top, layer: "top" });
    return shapes;
  }
  const eave = r + overhang;
  const eaveZ = H - 0.05;
  const apex: Vec3 = [0, 0, H + roof];
  // Cone: concave, so it flares out to the eaves and draws up to a spire.
  const rings = CONE_PROFILE.slice(0, -1).map((t) => ({ radius: eave * (1 - t) ** CONE_CURVE, z: eaveZ + (apex[2] - eaveZ) * t }));
  const outline: Vec3[] = [
    ...angles.map((angle) => ring(eave, eaveZ, angle)),
    ...rings.slice(1).map(({ radius, z }) => ring(radius, z, SILHOUETTE_LEFT)),
    apex,
    ...rings.slice(1).reverse().map(({ radius, z }) => ring(radius, z, SILHOUETTE_RIGHT)),
  ];
  const cone: IsoShape[] = [{ points: outline, fill: ROOF_PALETTES[0].mid, className: "roof-mid" }];
  rings.forEach((low, index) => {
    const high = rings[index + 1];
    for (let step = 0; step < ARC_STEPS; step++) {
      const a0 = angles[step], a1 = angles[step + 1];
      const tone = roofTone(facing((a0 + a1) / 2));
      const points: Vec3[] = high
        ? [ring(low.radius, low.z, a0), ring(low.radius, low.z, a1), ring(high.radius, high.z, a1), ring(high.radius, high.z, a0)]
        : [ring(low.radius, low.z, a0), ring(low.radius, low.z, a1), apex];
      cone.push({ points, fill: ROOF_PALETTES[0][tone], className: `roof-${tone} roof-seam`, seamless: true });
    }
  });
  cone.push({ points: outline, outline: true });
  shapes.push(...named("roof", cone), ...finial(apex));
  return shapes;
}

/** Shares of a cone's height where its profile rings lie, eave to point. */
const CONE_PROFILE = [0, 0.08, 0.2, 0.38, 0.62, 1];
/** Above 1 the cone is concave: flat at the skirt, steep at the spire. */
const CONE_CURVE = 1.12;

/** One of the five roof tones for a curved face's facing (-1 shade .. 1 lit). */
function roofTone(value: number): RoofTone {
  return value > 0.6 ? "lit" : value > 0.2 ? "lm" : value > -0.2 ? "mid" : value > -0.6 ? "ms" : "shade";
}

export interface Keep {
  /** Cells along i and j. */
  sizeI: number;
  sizeJ: number;
  /** Wall height up to the eaves. */
  height: number;
  /** Hip roof height. */
  rise: number;
  palette?: Palette;
  /** Arched wooden door on the front-left face. */
  door?: boolean;
}

/**
 * Stone keep: a tall plain block with a few round-headed windows set
 * irregularly, a row of tall ones under the eaves, and a steep hip roof.
 */
export function keep(definition: Keep): IsoShape[] {
  const { sizeI: a, sizeJ: b, height: H, rise } = definition;
  const palette = definition.palette ?? PLASTER;
  const shapes = named("walls", box(0, 0, a, b, 0, H, palette, false));
  shapes.push(...named("plinth", faceBand(0, 0, a, b, 0, 0.3, palette, 0.16)));
  shapes.push(...named("eave shadow", faceBand(0, 0, a, b, H - 0.3, H, palette, 0.2)));
  const opening = (origin: Vec3, along: Vec2, u: number, base: number, width: number, height: number) =>
    wallOpening(origin, along, arch(u, width, height).map(([x, y]) => [x, y + base] as const));
  // Openings never overlap, so the door can follow the windows as one layer.
  const windows: IsoShape[] = [];
  const doors: IsoShape[] = [];
  for (const [origin, along, width, front] of [[[a, 0, 0], [0, 1], b, false], [[0, b, 0], [1, 0], a, true]] as const) {
    const salt = front ? 3 : 17;
    // Upper storey: two tall windows, not quite evenly spaced.
    const upper = H - 0.45 - 0.8;
    for (const [slot, share] of [[0, 0.3], [1, 0.7]] as const) {
      windows.push(opening(origin, along, width * (share + jitter(slot, salt) * 0.06), upper + jitter(slot, salt + 1) * 0.1, 0.24, 0.8));
    }
    // Lower down, one small window off to a side; the door on the front face.
    const doorAt = width * 0.62;
    if (definition.door && front) doors.push(...doorway(origin, along, doorAt, 0.5, 0.95));
    const lowAt = width * (front ? 0.28 : 0.4 + jitter(2, salt) * 0.15);
    windows.push(opening(origin, along, lowAt, H * 0.42 + jitter(3, salt) * 0.15, 0.18, 0.5));
  }
  shapes.push(...named("windows", windows), ...named("door", doors));
  shapes.push(...hipRoof(0, 0, a, b, H, rise, 0.24));
  return shapes;
}

/** Ground direction pointing straight at the viewer; angle 0 is +i, PI/2 is +j. */
export const FACING_VIEWER = Math.PI / 4;

const fmt = (value: number) => (Math.round(value * 100) / 100).toString();

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function shapeBounds(shapes: readonly IsoShape[], pad = STROKE_WIDTH * 2): Bounds {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const shape of shapes) {
    for (const point of shape.points) {
      const [x, y] = project(point);
      bounds.minX = Math.min(bounds.minX, x - pad);
      bounds.minY = Math.min(bounds.minY, y - pad);
      bounds.maxX = Math.max(bounds.maxX, x + pad);
      bounds.maxY = Math.max(bounds.maxY, y + pad);
    }
  }
  return bounds;
}

/** Longest straight piece, in screen units, a wobbled edge is drawn with. */
const WOBBLE_STEP = 2.5;

/**
 * A smooth, slow drift of the screen plane, about ±1 at most, so long
 * edges bow a little as if drawn freehand. It depends only on screen
 * position, so two faces that share an edge keep sharing it.
 */
function drift(x: number, y: number): Vec2 {
  return [
    0.6 * Math.sin(0.19 * x + 0.11 * y + 1.3) + 0.4 * Math.sin(-0.07 * x + 0.23 * y + 4.2),
    0.6 * Math.sin(0.13 * x - 0.21 * y + 2.1) + 0.4 * Math.sin(0.24 * x + 0.05 * y + 0.7),
  ];
}

/**
 * Screen points of a polygon or line, with every edge cut into pieces of at
 * most WOBBLE_STEP and nudged by `drift`. A shared edge is cut at the same
 * points from either end, so neighbouring faces stay sealed.
 */
function wobbled(points: readonly Vec2[], closed: boolean, amount: number): Vec2[] {
  const nudge = ([x, y]: Vec2): Vec2 => {
    const [ox, oy] = drift(x, y);
    return [x + ox * amount, y + oy * amount];
  };
  const out: Vec2[] = [];
  const edges = closed ? points.length : points.length - 1;
  for (let index = 0; index < edges; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / WOBBLE_STEP));
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      out.push(nudge([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
    }
  }
  if (!closed) out.push(nudge(points[points.length - 1]));
  return out;
}

/**
 * SVG paths for `shapes`, shifted by (dx, dy) on screen. `wobble` is how
 * far, in screen units, edges may stray from straight.
 */
export function shapesToSvg(shapes: readonly IsoShape[], dx = 0, dy = 0, wobble = 0): string {
  return shapes.map((shape) => {
    const open = shape.detail === true;
    const projected = shape.points.map(project);
    const points = wobble > 0 ? wobbled(projected, !open, wobble) : projected;
    const d = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${fmt(x + dx)} ${fmt(y + dy)}`).join("");
    const attributes: string[] = [];
    if (shape.layer) attributes.push(`data-layer="${shape.layer}"`);
    if (shape.className) attributes.push(`class="${shape.className}"`);
    if (shape.detail) return `<path ${attributes.join(" ")} d="${d}"/>`;
    if (shape.outline) return `<path ${attributes.join(" ")} d="${d}Z"/>`;
    if (shape.fill) attributes.push(`fill="${shape.fill}"`);
    if (shape.seamless) attributes.push(`stroke="${shape.fill}"`, `stroke-width="0.4"`);
    return `<path ${attributes.join(" ")} d="${d}Z"/>`;
  }).join("\n");
}

/**
 * Hand-drawn finish: a slight wobble on every edge plus a dark speckle over
 * the fills, after the stippled look of the reference art.
 */
export const HAND_FILTER = `<filter id="hand" x="-4%" y="-4%" width="108%" height="108%">`
  + `<feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="2" seed="4" result="warp"/>`
  + `<feDisplacementMap in="SourceGraphic" in2="warp" scale="1.3" xChannelSelector="R" yChannelSelector="G" result="wobble"/>`
  + `<feTurbulence type="fractalNoise" baseFrequency="1.2" numOctaves="2" seed="9" result="grain"/>`
  + `<feColorMatrix in="grain" type="matrix" values="0 0 0 0 0.16 0 0 0 0 0.11 0 0 0 0 0.07 2.2 0 0 0 -1.18" result="specks"/>`
  + `<feComposite in="specks" in2="wobble" operator="in" result="speckled"/>`
  + `<feMerge><feMergeNode in="wobble"/><feMergeNode in="speckled"/></feMerge>`
  + `</filter>`;

export function rootAttributes(strokeWidth = STROKE_WIDTH): string {
  return `fill="none" stroke="${INK}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"`;
}

export const SVG_ROOT_ATTRIBUTES = rootAttributes();

/**
 * Finer finish for keeps and castles: a gentler wobble, a fine paper grain
 * instead of dense speckle, and faint rust-brown weathering over the fills,
 * so flat faces are not flat colour.
 */
export const SOFT_HAND_FILTER = `<filter id="hand" x="-4%" y="-4%" width="108%" height="108%">`
  + `<feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="4" result="warp"/>`
  + `<feDisplacementMap in="SourceGraphic" in2="warp" scale="0.8" xChannelSelector="R" yChannelSelector="G" result="wobble"/>`
  // Weathering multiplies by a near-white warm noise, so it only darkens a
  // little and the ink stays solid.
  + `<feTurbulence type="fractalNoise" baseFrequency="0.12" numOctaves="3" seed="21" result="weather"/>`
  + `<feColorMatrix in="weather" type="matrix" values="0.3 0 0 0 0.84 0.32 0 0 0 0.82 0.36 0 0 0 0.78 0 0 0 0 1" result="tint"/>`
  + `<feBlend in="wobble" in2="tint" mode="multiply" result="tinted"/>`
  + `<feComposite in="tinted" in2="wobble" operator="in" result="weathered"/>`
  + `<feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="2" seed="9" result="grain"/>`
  + `<feColorMatrix in="grain" type="matrix" values="0 0 0 0 0.16 0 0 0 0 0.11 0 0 0 0 0.07 1.3 0 0 0 -0.78" result="specks"/>`
  + `<feComposite in="specks" in2="wobble" operator="in" result="speckled"/>`
  + `<feMerge><feMergeNode in="weathered"/><feMergeNode in="speckled"/></feMerge>`
  + `</filter>`;

/** How far, in screen units, the soft finish lets edges stray from straight. */
export const SOFT_WOBBLE = 0.4;

export interface HandStyle {
  /** Filter definitions for `<defs>`, defining `#hand`. */
  filter: string;
  root: string;
}

export const HAND_STYLES: Record<"classic" | "soft", HandStyle> = {
  classic: { filter: HAND_FILTER, root: SVG_ROOT_ATTRIBUTES },
  soft: { filter: SOFT_HAND_FILTER, root: SVG_ROOT_ATTRIBUTES },
};

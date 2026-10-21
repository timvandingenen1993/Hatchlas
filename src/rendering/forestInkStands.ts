import { SimplexNoise } from "../core/noise";
import {
  boxBlur,
  clamp01,
  clusterLight,
  FOREST_STAND_REFERENCE_TREE_SIZE,
  mulberry,
  sample,
  smoothStep,
  type Point,
} from "./forestStandGeometry";

/**
 * Pen-and-ink forest stands: the stand is drawn only with small marks, no
 * wash. Every tree is the same long teardrop, pointed at the top and round
 * at the foot. Along the front (lower) edge the trees are drawn whole; along
 * the back (upper) edge and loosely filling the inside only their pointed
 * tops show, the rest hidden by the trees in front. A clearing flips this,
 * since it is just a hole in the mask: its upper rim is a front edge. Lone
 * trees on open ground stand in ones, twos and threes, and dotted runs of
 * grass trail out from the stands.
 *
 * Two pens: a heavy one for the outline marks and lone trees, a fine one for
 * the fill and the grass. Some tops are drawn two or three together in one
 * connected stroke. Every mark carries its own shape seed, so no two
 * trees are drawn alike, and every random choice is resolved here: a render
 * is deterministic. Lengths scale with `markSize`, the width of a tree.
 */

/** "oval": a whole tree; "cap": only its top; "dot": a grass dot. */
export type ForestInkMarkKind = "cap" | "oval" | "dot";

/**
 * What a mark stands for, so each kind of tree can get its own line weight:
 * the front row, the second row behind it, the back edge, the fill (blending
 * toward its near-edge look by `edge`), lone trees and grass dots.
 */
export type ForestInkRole = "front" | "second" | "back" | "fill" | "lone" | "grass";

/**
 * Kind of forest, which sets the tree shape: deciduous long teardrops,
 * coniferous notched cones, shrubs low round scalloped clumps. Placement is the
 * same for all three.
 */
export type ForestInkType = "deciduous" | "conifer" | "shrub";

interface ForestInkStyle {
  /** Tree height for its width. */
  length: [number, number];
  /** Share of the tree that shows: fill deep inside, fill by an edge, back edge. */
  fillCut: [number, number];
  edgeCut: [number, number];
  /** Fill tip shape (deciduous only: lower is rounder). */
  fillTip: number;
  /** Chance a fill mark is a connected pair or triple. */
  pairs: number;
  triples: number;
  /** Crown width relative to the mark size. */
  crown: number;
}

const FOREST_STYLES: Record<ForestInkType, ForestInkStyle> = {
  deciduous: { length: [2, 2.6], fillCut: [0.24, 0.34], edgeCut: [0.55, 0.75], fillTip: 0.62, pairs: 0.28, triples: 0.1, crown: 1 },
  conifer: { length: [2.4, 3.1], fillCut: [0.22, 0.32], edgeCut: [0.5, 0.7], fillTip: 1, pairs: 0.3, triples: 0.12, crown: 1 },
  shrub: { length: [1, 1.3], fillCut: [0.45, 0.6], edgeCut: [0.7, 0.9], fillTip: 1, pairs: 0.4, triples: 0.2, crown: 1.3 },
};

const between = (range: [number, number], rng: () => number) => range[0] + rng() * (range[1] - range[0]);

export interface ForestInkMark {
  kind: ForestInkMarkKind;
  /** Centre x. */
  x: number;
  /** Bottom of the visible mark (the foot of a whole tree, the cut of a top). */
  y: number;
  /** Width of the tree at its widest. */
  width: number;
  /** Visible height: the whole tree, or just the part of it above the cut. */
  height: number;
  /** Share of the tree's height that shows, from the tip down (1 = whole tree). */
  cut: number;
  /** Tops drawn together in one stroke (1 = a single tree). */
  count: number;
  /** Tip shape: 1 = pointed (edge trees), lower = rounder (fill tops). */
  tip: number;
  role: ForestInkRole;
  /** Fill only: 0 deep inside a stand, 1 right by an edge. */
  edge: number;
  forest: ForestInkType;
  /** Rotation in radians around the foot. */
  tilt: number;
  /** Pen width as a multiple of the outline pen. */
  pen: number;
  /** Seed of the mark's hand-drawn shape (see inkMarkOutline). */
  shape: number;
}

/**
 * Stand tree size per ink mark size, as in /forest-lab (tree size 7.5 for
 * marks 5.5). The wash's splotches and light clusters were tuned against the
 * tree size, so they are sized from the marks through it.
 */
export const INK_WASH_TREE_SIZE_PER_MARK = 7.5 / 5.5;

export interface ForestInkGeometry {
  markSize: number;
  /** Seed of the stand; the wash's splotches follow it. */
  seed: number;
  /**
   * Terrain light per mask cell, one tone per light cluster: 0.2 on the
   * shadow side, 0.8 lit, 0.5 outside stands. Unset without terrain light.
   */
  shade?: Float32Array;
  /** The rounded stand mask the marks follow (edge at 0.5), in map pixels. */
  mask: Float32Array;
  maskWidth: number;
  maskHeight: number;
  /** Sorted back to front: later marks paint over earlier ones. */
  marks: ForestInkMark[];
  /** Output pixel = map pixel * scale - offset (see mapForestInkGeometry). */
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Re-express ink stands in another pixel space (a preview scale or an
 * export tile): output = input * scale - offset, composed with any earlier
 * mapping. Marks stay in map pixels; only those near the view are kept.
 */
export function mapForestInkGeometry(
  geometry: ForestInkGeometry,
  scaleX: number,
  scaleY: number,
  offsetX: number,
  offsetY: number,
  viewWidth: number,
  viewHeight: number,
): ForestInkGeometry {
  const mapped = {
    ...geometry,
    scaleX: geometry.scaleX * scaleX,
    scaleY: geometry.scaleY * scaleY,
    offsetX: geometry.offsetX * scaleX + offsetX,
    offsetY: geometry.offsetY * scaleY + offsetY,
  };
  // A tree reaches about three mark sizes above its foot; keep a margin.
  const margin = geometry.markSize * 4;
  const left = mapped.offsetX / mapped.scaleX - margin;
  const top = mapped.offsetY / mapped.scaleY - margin;
  const right = (mapped.offsetX + viewWidth) / mapped.scaleX + margin;
  const bottom = (mapped.offsetY + viewHeight) / mapped.scaleY + margin;
  mapped.marks = geometry.marks.filter((mark) => mark.x >= left && mark.x <= right && mark.y >= top && mark.y <= bottom);
  return mapped;
}

export interface ForestInkSettings {
  /** Width of a tree in map pixels. */
  markSize: number;
  /** Fill density inside stands (1 = loose rows with paper between). */
  density: number;
  /** Second, half-hidden row of trees behind the front edge. */
  edgeRows: number;
  /** How tightly trees pack along the front and back edges (1 = touching). */
  edgeDensity: number;
  /** How far edge trees stand in front of or behind the outline (0 = on it). */
  edgeDepth: number;
  /** Lone trees on open ground around stands. */
  meadowTrees: number;
  /** Dotted grass runs around stands. */
  grass: number;
  /** Tree shape; deciduous when unset. */
  type?: ForestInkType;
}

export interface ForestInkInput {
  width: number;
  height: number;
  /** Raw stand coverage, 0..1 (> 0.5 is forest). */
  forest: Float32Array;
  seed: number;
  settings: ForestInkSettings;
  /** Optional 0..1 terrain light per cell (0.5 = flat ground). */
  light?: Float32Array;
  /** How strongly terrain light thins and weights the fill. */
  lightStrength?: number;
  /** Optional slope in degrees; lone trees avoid cliffs. */
  slope?: Float32Array;
  /**
   * Optional 0..1 ground trees can stand on (0 on water, snow, cliffs;
   * a soft step at its edge). Stands are cut back to where it crosses 0.5
   * and no mark is drawn off it. All ground when unset.
   */
  ground?: Float32Array;
  /**
   * Optional 0..1 suitability for lone trees and grass well away from any
   * stand. Without it they only gather around the stands.
   */
  suitability?: Float32Array;
  /**
   * Optional 0..1 open land a stand gives way to, such as river silt: the
   * stand is cut back to where it crosses 0.5, but lone trees and grass may
   * still stand on it.
   */
  clearing?: Float32Array;
  /** Optional 0..1 share of lone trees and grass dropped per cell (thin ground). */
  sparse?: Float32Array;
  /** Plants already placed on open ground; each becomes a lone tree. */
  loneTrees?: Point[];
  /**
   * Share of front-row and lone plants drawn as deciduous trees instead
   * (trees among shrubs).
   */
  accentShare?: number;
}

/** Pen weights (multiples of the outline pen) for each kind of tree, and for the fill right by an edge. */
export type ForestInkPens = Record<ForestInkRole | "nearEdge", number>;

/**
 * Default line weights: the front row boldest, the back edge just under it,
 * the second row and near-edge trees in a middle pen, lone trees a touch
 * lighter and the fill finest. Each mark varies a little around its weight.
 */
export const DEFAULT_FOREST_INK_PENS: ForestInkPens = {
  front: 1.25,
  back: 1.12,
  second: 1.05,
  nearEdge: 1.02,
  lone: 0.95,
  fill: 0.74,
  grass: 1.1,
};

/** A mark's weight in `pens`; the fill blends from `fill` to `nearEdge` toward an edge. */
export function inkMarkPen(mark: Pick<ForestInkMark, "role" | "edge">, pens: Partial<ForestInkPens> = {}): number {
  const weight = (key: keyof ForestInkPens) => {
    const value = pens[key];
    return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : DEFAULT_FOREST_INK_PENS[key];
  };
  if (mark.role !== "fill") return weight(mark.role);
  return weight("fill") * (1 - mark.edge) + weight("nearEdge") * mark.edge;
}

const PEN = DEFAULT_FOREST_INK_PENS;

// --- mark shapes ------------------------------------------------------------

/**
 * Half width (0..1) of a tree at `s` down its height (0 = tip, 1 = foot): a
 * long teardrop. `peak` sets where it is widest (0.5^(1/peak) down), and
 * `sharpness` how pointed the tip is; the foot always rounds off.
 */
export function treeProfile(s: number, peak: number, sharpness: number): number {
  const base = Math.sin(Math.PI * Math.pow(clamp01(s), peak));
  const exponent = sharpness + (0.5 - sharpness) * s;
  return Math.pow(Math.max(0, base), exponent);
}

/**
 * Half width (0..1) of a conifer at `s` down its height: a cone widening to
 * its foot, which rounds off, with a notch at each branch tier.
 */
function coneProfile(s: number, tiers: number): number {
  const t = clamp01(s);
  const cone = Math.pow(Math.min(t, 0.88) / 0.88, 0.95);
  const foot = t <= 0.88 ? 1 : Math.sqrt(Math.max(0, 1 - ((t - 0.88) / 0.12) ** 2));
  // Each tier flares out and steps back in, like branches seen side on.
  const tier = t * tiers - Math.floor(t * tiers);
  const notch = t < 0.12 ? 1 : 0.72 + 0.28 * tier;
  return cone * foot * notch;
}

/** Half width (0..1) of a shrub at `s`: a round clump with scalloped lobes. */
function cloudProfile(s: number, lobes: number, phase: number): number {
  const t = clamp01(s);
  const dome = Math.sqrt(Math.max(0, Math.sin(Math.PI * t)));
  const scallop = 1 - 0.3 * (1 - Math.abs(Math.sin(lobes * Math.PI * t + phase))) ** 1.5;
  return dome * scallop;
}

/** Centre spacing of the trees in a connected group, in tree widths. */
const GROUP_STEP = 0.42;

interface TopTree {
  forest: ForestInkType;
  /** Conifer branch tiers; shrub lobes. */
  tiers: number;
  centre: number;
  half: number;
  /** Visible height above the cut. */
  visible: number;
  peak: number;
  sharpness: number;
  lean: number;
  left: number;
  right: number;
  wobble: number;
  phase: number;
}

function topTree(rng: () => number, centre: number, half: number, visible: number, tip: number, forest: ForestInkType): TopTree {
  const peak = 1.35 + rng() * 0.4;
  return {
    forest,
    tiers: forest === "shrub" ? 2.5 + rng() * 1.5 : 3 + Math.floor(rng() * 3),
    centre,
    half,
    visible,
    peak,
    // peak * sharpness near 1 makes a pointed arch: a corner at the tip with
    // sides bulging out below it. Much above 1 the sides cave in to a spike;
    // below 1 the sides meet in a rounded top.
    sharpness: tip * (0.85 + rng() * 0.25) / peak,
    lean: (rng() - 0.5) * 0.35,
    left: 1 + (rng() - 0.5) * 0.22,
    right: 1 + (rng() - 0.5) * 0.22,
    wobble: (rng() - 0.5) * 0.12,
    phase: rng() * Math.PI * 2,
  };
}

/** A point on one side of a tree, `s` down from its tip (local: foot or cut at y = 0). */
function treeSide(tree: TopTree, cut: number, s: number, side: number): Point {
  const profile = tree.forest === "conifer" ? coneProfile(s, tree.tiers)
    : tree.forest === "shrub" ? cloudProfile(s, tree.tiers, tree.phase + side * 0.7)
    : treeProfile(s, tree.peak, tree.sharpness);
  const w = tree.half * profile * (side < 0 ? tree.left : tree.right) *
    (1 + tree.wobble * Math.sin(s * 9 + tree.phase + side));
  return {
    x: tree.centre + side * w + tree.lean * tree.half * 2 * (1 - s) ** 2,
    y: -(cut - s) * tree.visible / cut,
  };
}

/**
 * The stroke of a mark as a polyline in map pixels. `corners` are the
 * indices the renderer keeps sharp (tips and valleys); between them it
 * draws smooth curves. A whole tree runs from its tip round the foot back to
 * the tip (`closed`), unless the pen lifted early. A top runs from one side
 * of the cut over the tip to the other; a connected group of tops dips into
 * a valley where each crown meets the next and runs on over the next tip.
 * Each tree's seed picks where it is widest, how sharp its tip is, a lean,
 * uneven sides and a slight wobble.
 */
export function inkMarkOutline(mark: ForestInkMark, steps = mark.forest === "deciduous" ? 12 : 20): { points: Point[]; corners: number[]; closed: boolean } {
  const rng = mulberry(mark.shape);
  const cut = mark.cut;
  const cos = Math.cos(mark.tilt);
  const sin = Math.sin(mark.tilt);
  const place = (point: Point): Point => ({ x: mark.x + point.x * cos - point.y * sin, y: mark.y + point.x * sin + point.y * cos });
  // Points crowd toward the tip, where the outline turns fastest.
  const ladder = (to: number) => {
    const count = Math.max(3, Math.round(steps * to / cut));
    return Array.from({ length: count + 1 }, (_, index) => to * (index / count) ** 1.3);
  };

  if (cut >= 1) {
    const tree = topTree(rng, 0, mark.width / 2, mark.height, mark.tip, mark.forest);
    const points: Point[] = [];
    for (const s of ladder(1)) points.push(place(treeSide(tree, 1, s, 1)));
    for (const s of ladder(1).reverse().slice(1)) points.push(place(treeSide(tree, 1, s, -1)));
    // Some trees keep the small gap where the pen lifted before the tip.
    const gap = rng() < 0.3 ? 2 + Math.floor(rng() * 2) : 0;
    return { points: gap ? points.slice(0, points.length - gap) : points, corners: [0], closed: gap === 0 };
  }

  const count = Math.max(1, mark.count);
  const treeWidth = mark.width / (1 + (count - 1) * GROUP_STEP);
  const trees: TopTree[] = [];
  for (let index = 0; index < count; index++) {
    const visible = mark.height * (index === 0 ? 1 : 0.75 + rng() * 0.35);
    const tree = topTree(rng, 0, treeWidth * (0.88 + rng() * 0.24) / 2, visible, mark.tip, mark.forest);
    const previous = trees[index - 1];
    if (previous) {
      // Overlap the neighbour's crown at the cut, so the two always meet in a
      // valley above it whatever their lean and width.
      const reach = treeSide(previous, cut, cut, 1).x;
      const overlap = (reach - previous.centre) * (0.45 + rng() * 0.35);
      tree.centre = reach - overlap - treeSide(tree, cut, cut, -1).x;
    }
    trees.push(tree);
  }
  const shift = -(trees[0].centre + trees[trees.length - 1].centre) / 2;
  for (const tree of trees) tree.centre += shift;
  // Where each crown's right side meets the next crown's left side.
  const valleys = trees.slice(1).map((next, index) => {
    const tree = trees[index];
    for (let step = 1; step <= 48; step++) {
      const sTree = cut * step / 48;
      const right = treeSide(tree, cut, sTree, 1);
      const sNext = cut + right.y * cut / next.visible;
      if (sNext < 0) continue;
      if (right.x >= treeSide(next, cut, sNext, -1).x) return { sTree, sNext };
    }
    return { sTree: cut, sNext: cut };
  });
  const points: Point[] = [];
  const corners: number[] = [];
  for (const s of ladder(cut).reverse()) points.push(place(treeSide(trees[0], cut, s, -1)));
  trees.forEach((tree, index) => {
    corners.push(points.length - 1);
    const down = index < valleys.length ? valleys[index].sTree : cut;
    for (const s of ladder(down).slice(1)) points.push(place(treeSide(tree, cut, s, 1)));
    if (index < valleys.length) {
      corners.push(points.length - 1);
      const next = trees[index + 1];
      for (const s of ladder(valleys[index].sNext).reverse().slice(1)) points.push(place(treeSide(next, cut, s, -1)));
    }
  });
  return { points, corners, closed: false };
}

// --- fields -----------------------------------------------------------------

/**
 * The stand outline the marks follow: the raw coverage lightly rounded, as
 * the hand-drawn stands always were (about a quarter of a tree). Rounding
 * harder erases the small stands a few placed trees form on the map.
 */
function roundedMask(forest: Float32Array, width: number, height: number, size: number): Float32Array {
  const unit = size * INK_WASH_TREE_SIZE_PER_MARK / FOREST_STAND_REFERENCE_TREE_SIZE;
  return boxBlur(boxBlur(forest, width, height, Math.max(1, Math.round(3 * unit))), width, height, Math.max(1, Math.round(2 * unit)));
}

/** Chamfer distance (in cells) from every cell to the nearest cell where `inside` holds. */
function distanceTo(mask: Float32Array, width: number, height: number, inside: (value: number) => boolean): Float32Array {
  const far = width + height;
  const distance = new Float32Array(width * height);
  for (let index = 0; index < distance.length; index++) distance[index] = inside(mask[index]) ? 0 : far;
  const diagonal = Math.SQRT2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      let best = distance[index];
      if (x > 0) best = Math.min(best, distance[index - 1] + 1);
      if (y > 0) {
        best = Math.min(best, distance[index - width] + 1);
        if (x > 0) best = Math.min(best, distance[index - width - 1] + diagonal);
        if (x < width - 1) best = Math.min(best, distance[index - width + 1] + diagonal);
      }
      distance[index] = best;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const index = y * width + x;
      let best = distance[index];
      if (x < width - 1) best = Math.min(best, distance[index + 1] + 1);
      if (y < height - 1) {
        best = Math.min(best, distance[index + width] + 1);
        if (x < width - 1) best = Math.min(best, distance[index + width + 1] + diagonal);
        if (x > 0) best = Math.min(best, distance[index + width - 1] + diagonal);
      }
      distance[index] = best;
    }
  }
  return distance;
}

/**
 * Outlines where `mask` crosses 0.5, as polylines (marching squares). Each
 * crossing lies on one grid edge shared by two cells, so segments chain
 * through their shared edges.
 */
function traceOutlines(mask: Float32Array, width: number, height: number): Point[][] {
  const level = 0.5;
  // Edge ids: 2 * corner for the edge to the right of a corner, + 1 for the edge below it.
  const horizontal = (x: number, y: number) => (y * width + x) * 2;
  const vertical = (x: number, y: number) => (y * width + x) * 2 + 1;
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    const fromA = links.get(a);
    if (fromA) fromA.push(b);
    else links.set(a, [b]);
    const fromB = links.get(b);
    if (fromB) fromB.push(a);
    else links.set(b, [a]);
  };
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = mask[y * width + x] >= level;
      const b = mask[y * width + x + 1] >= level;
      const c = mask[(y + 1) * width + x + 1] >= level;
      const d = mask[(y + 1) * width + x] >= level;
      // Most cells lie wholly inside or outside a stand: no crossing.
      if (a === b && b === c && c === d) continue;
      const top = a !== b ? horizontal(x, y) : -1;
      const right = b !== c ? vertical(x + 1, y) : -1;
      const bottom = d !== c ? horizontal(x, y + 1) : -1;
      const left = a !== d ? vertical(x, y) : -1;
      const crossings = [top, right, bottom, left].filter((edge) => edge >= 0);
      if (crossings.length === 2) {
        link(crossings[0], crossings[1]);
      } else if (crossings.length === 4) {
        const centre = (mask[y * width + x] + mask[y * width + x + 1] + mask[(y + 1) * width + x + 1] + mask[(y + 1) * width + x]) / 4 >= level;
        if (a === centre) {
          link(top, right);
          link(bottom, left);
        } else {
          link(top, left);
          link(right, bottom);
        }
      }
    }
  }
  const position = (edge: number): Point => {
    const corner = edge >> 1;
    const x = corner % width;
    const y = Math.floor(corner / width);
    const v0 = mask[corner];
    if (edge & 1) {
      const v1 = mask[corner + width];
      return { x, y: y + (level - v0) / (v1 - v0) };
    }
    const v1 = mask[corner + 1];
    return { x: x + (level - v0) / (v1 - v0), y };
  };
  const visited = new Set<number>();
  const outlines: Point[][] = [];
  const walk = (start: number) => {
    const chain = [start];
    visited.add(start);
    let current = start;
    for (;;) {
      const next = (links.get(current) ?? []).find((edge) => !visited.has(edge));
      if (next === undefined) break;
      visited.add(next);
      chain.push(next);
      current = next;
    }
    // A closed loop ends next to its start.
    if (chain.length > 2 && (links.get(current) ?? []).includes(start)) chain.push(start);
    outlines.push(chain.map(position));
  };
  // Open chains (cut by the map border) first, from an end.
  for (const [edge, neighbours] of links) if (neighbours.length === 1 && !visited.has(edge)) walk(edge);
  for (const edge of links.keys()) if (!visited.has(edge)) walk(edge);
  return outlines;
}

// --- placement --------------------------------------------------------------

/** Placed marks, kept in a grid so new marks can avoid them. */
class MarkField {
  readonly marks: ForestInkMark[] = [];
  private readonly grid = new Map<number, ForestInkMark[]>();
  private readonly cell: number;
  private readonly cols: number;

  constructor(cell: number, width: number) {
    this.cell = cell;
    this.cols = Math.ceil(width / cell) + 4;
  }

  private key(gx: number, gy: number): number {
    return (gy + 2) * this.cols + gx + 2;
  }

  /** True when a mark of this box fits with at most `overlap` (0..1) of squeeze. */
  fits(x: number, y: number, width: number, height: number, overlap: number): boolean {
    const cy = y - height / 2;
    const gx = Math.floor(x / this.cell);
    const gy = Math.floor(cy / this.cell);
    const reach = 2;
    for (let oy = -reach; oy <= reach; oy++) {
      for (let ox = -reach; ox <= reach; ox++) {
        for (const other of this.grid.get(this.key(gx + ox, gy + oy)) ?? []) {
          const dx = (other.x - x) / ((other.width + width) / 2);
          const dy = (other.y - other.height / 2 - cy) / ((other.height + height) / 2);
          if (dx * dx + dy * dy < (1 - overlap) ** 2) return false;
        }
      }
    }
    return true;
  }

  add(mark: ForestInkMark): void {
    this.marks.push(mark);
    const key = this.key(Math.floor(mark.x / this.cell), Math.floor((mark.y - mark.height / 2) / this.cell));
    const bucket = this.grid.get(key);
    if (bucket) bucket.push(mark);
    else this.grid.set(key, [mark]);
  }

  tryAdd(mark: ForestInkMark, overlap: number): boolean {
    if (!this.fits(mark.x, mark.y, mark.width, mark.height, overlap)) return false;
    this.add(mark);
    return true;
  }
}

const shapeSeed = (rng: () => number) => Math.floor(rng() * 0xffffffff) >>> 0;

/** A whole tree standing on (x, y). */
function treeMark(x: number, y: number, width: number, pen: number, rng: () => number, role: ForestInkRole, forest: ForestInkType): ForestInkMark {
  return {
    kind: "oval", x, y, width, height: width * between(FOREST_STYLES[forest].length, rng), cut: 1, count: 1, tip: 1, role, edge: 0,
    forest, pen, tilt: (rng() - 0.5) * 0.16, shape: shapeSeed(rng),
  };
}

/** The top `cut` of a tree (or of `count` trees side by side, `width` each), its cut at y. */
function topMark(
  x: number, y: number, width: number, cut: number, pen: number, rng: () => number,
  role: ForestInkRole, forest: ForestInkType, count = 1, tip = 1, edge = 0,
): ForestInkMark {
  return {
    kind: "cap", x, y, width: width * (1 + (count - 1) * GROUP_STEP),
    height: width * between(FOREST_STYLES[forest].length, rng) * cut, cut, count, tip,
    role, edge, forest, pen, tilt: (rng() - 0.5) * 0.16, shape: shapeSeed(rng),
  };
}

/** One, two or three tops in a stroke. */
const groupSize = (rng: () => number, pairs: number, triples: number) => {
  const roll = rng();
  return roll < triples ? 3 : roll < triples + pairs ? 2 : 1;
};

function dotMark(x: number, y: number, length: number, pen: number): ForestInkMark {
  return { kind: "dot", x, y, width: length, height: length * 0.6, cut: 1, count: 1, tip: 1, role: "grass", edge: 0, forest: "deciduous", pen, tilt: 0, shape: 0 };
}

/** Walk an outline at varying steps; `place` returns the step to the next mark. */
function walkOutline(points: Point[], startOffset: number, place: (point: Point) => number): void {
  if (points.length < 2) return;
  const lengths = [0];
  for (let index = 1; index < points.length; index++) {
    lengths.push(lengths[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
  }
  const total = lengths[lengths.length - 1];
  let t = startOffset;
  let segment = 1;
  while (t < total) {
    while (segment < points.length - 1 && lengths[segment] < t) segment++;
    const a = points[segment - 1];
    const b = points[segment];
    const span = lengths[segment] - lengths[segment - 1] || 1;
    const f = (t - lengths[segment - 1]) / span;
    const step = place({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    // A bad step would end the walk after one mark; keep going instead.
    t += Number.isFinite(step) ? Math.max(0.5, step) : 0.5;
  }
}

export function buildForestInkGeometry(input: ForestInkInput): ForestInkGeometry {
  const { width, height, settings } = input;
  const size = settings.markSize;
  // Settings saved before a control existed arrive without it: fall back to 1.
  const edgeDensity = Number.isFinite(settings.edgeDensity) ? Math.max(0.2, settings.edgeDensity) : 1;
  const edgeDepth = Number.isFinite(settings.edgeDepth) ? Math.max(0, settings.edgeDepth) : 1;
  const forest: ForestInkType = settings.type && settings.type in FOREST_STYLES ? settings.type : "deciduous";
  const style = FOREST_STYLES[forest];
  const accentShare = Number.isFinite(input.accentShare) ? clamp01(input.accentShare ?? 0) : 0;
  /** A front-row or lone plant: now and then a deciduous tree among other plants. */
  const plantKind = (): ForestInkType => forest !== "deciduous" && accentShare > 0 && rng() < accentShare ? "deciduous" : forest;
  /** Crown width scale: shrubs are broader than the trees. */
  const crown = size * style.crown;
  const rng = mulberry(input.seed ^ 0x1a2b3c4d);
  const ground = input.ground?.length === width * height ? input.ground : undefined;
  const clearing = input.clearing?.length === width * height ? input.clearing : undefined;
  /** Where the stand itself may spread: on ground, off any clearing. */
  const standRoom = ground || clearing
    ? input.forest.map((_, index) => (ground ? ground[index] : 1) * (clearing ? 1 - clamp01(clearing[index]) : 1))
    : undefined;
  const mask = roundedMask(standRoom ? input.forest.map((value, index) => value * standRoom[index]) : input.forest, width, height, size);
  // Rounding bleeds the stand back over a narrow river, a lake shore or a
  // silt channel; cut it off again where its room ends.
  if (standRoom) for (let index = 0; index < mask.length; index++) mask[index] = Math.min(mask[index], standRoom[index]);
  /**
   * True when a mark's foot (or its cut) stands on ground across its width.
   * Only the foot counts, as for placed plants: a crown on the near shore
   * may rise over the water behind it.
   */
  const onGround = (x: number, y: number, halfWidth: number) => !ground || (
    sample(ground, width, height, x, y) >= 0.5 &&
    sample(ground, width, height, x - halfWidth, y) >= 0.5 &&
    sample(ground, width, height, x + halfWidth, y) >= 0.5
  );
  const groundAt = (x: number, y: number) => !ground || sample(ground, width, height, x, y) >= 0.5;
  /**
   * True when a whole tree stands on ground: its foot, and its lower half
   * above the foot. Only its top may rise over the water behind it; a tree
   * on a thin strip of bank would otherwise stand in the river.
   */
  const treeOnGround = (tree: ForestInkMark, halfWidth: number) => onGround(tree.x, tree.y, halfWidth) &&
    groundAt(tree.x, tree.y - tree.height * 0.25) && groundAt(tree.x, tree.y - tree.height * 0.5);
  const sparse = input.sparse?.length === width * height ? input.sparse : undefined;
  const sparseAt = (x: number, y: number) => sparse ? clamp01(sample(sparse, width, height, x, y)) : 0;
  const field = new MarkField(size, width);
  const lightAt = (x: number, y: number) => input.light ? sample(input.light, width, height, x, y) : 0.5;
  const lightStrength = input.lightStrength ?? 0.7;
  const inward = (point: Point): Point => {
    const gx = sample(mask, width, height, point.x + 1.5, point.y) - sample(mask, width, height, point.x - 1.5, point.y);
    const gy = sample(mask, width, height, point.x, point.y + 1.5) - sample(mask, width, height, point.x, point.y - 1.5);
    const length = Math.hypot(gx, gy) || 1;
    return { x: gx / length, y: gy / length };
  };

  // 1. The outline: ovals along the front, caps along the back. The front
  // goes first so its marks win where the two meet at a corner.
  const outlines = traceOutlines(mask, width, height).filter((outline) => outline.length > size * 1.5);
  const frontRow: ForestInkMark[] = [];
  const frontWidth = () => {
    const roll = rng();
    return crown * (roll < 0.3 ? 0.4 + rng() * 0.1 : roll < 0.85 ? 0.55 + rng() * 0.15 : 0.75 + rng() * 0.1);
  };
  let nextFrontWidth = frontWidth();
  for (const pass of ["front", "back"] as const) {
    for (const outline of outlines) {
      walkOutline(outline, rng() * size, (point) => {
        const normal = inward(point);
        // Inward pointing up: forest above, open ground below. Steep sides
        // get ovals too (stacked down the flank) unless they lean back.
        const facing = normal.y < 0.1 ? "front" : "back";
        if (facing !== pass) return size * 0.5;
        if (pass === "front") {
          // A packed chain of mixed sizes ("0o0O0"), each crown slightly
          // overlapping the last. The next size is drawn ahead so the step
          // fits both neighbours.
          const w = nextFrontWidth;
          nextFrontWidth = frontWidth();
          const tree = treeMark(0, 0, w, PEN.front * (0.97 + rng() * 0.06), rng, "front", plantKind());
          // The tree's rim touches the outline: its foot on a front edge, its
          // flank on a side.
          const reach = w / 2 + (tree.height - w) / 2 * Math.abs(normal.y);
          // Each tree stands at its own depth: most a little in front of or
          // behind the outline, the odd one stepped well forward.
          const depth = edgeDepth * (rng() < 0.12 ? size * (0.5 + rng() * 0.3) : size * (rng() * 0.55 - 0.2));
          tree.x = point.x + normal.x * (reach - depth);
          tree.y = point.y + normal.y * (reach - depth) + tree.height / 2 + size * 0.04;
          if (!treeOnGround(tree, w * 0.35) || !field.tryAdd(tree, 0.5)) return size * 0.15;
          frontRow.push(tree);
          return (w + nextFrontWidth) / 2 * (0.8 + rng() * 0.1) / edgeDensity;
        }
        const w = crown * (0.6 + rng() * 0.25);
        // Edge tops show more of the tree than the tops deep inside.
        // The back edge: packed, and drawn just under the front row's weight.
        const top = topMark(0, 0, w, between(style.edgeCut, rng), PEN.back * (0.95 + rng() * 0.1), rng, "back", forest, groupSize(rng, 0.2, 0.05));
        // Tops sit at their own depths too: some sink behind the outline,
        // some poke up above it, so the back silhouette is ragged.
        const resting = top.height * 0.85;
        const sink = resting + edgeDepth *
          ((rng() < 0.15 ? -size * (0.15 + rng() * 0.2) : top.height * (0.35 + rng() * 0.9)) - resting);
        top.x = point.x + normal.x * sink * 0.6;
        top.y = point.y + normal.y * sink;
        if (onGround(top.x, top.y, top.width * 0.35)) field.tryAdd(top, 0.15);
        return top.width * (0.72 + rng() * 0.28) / edgeDensity;
      });
    }
  }

  // 2. A second row set into the dips of the front chain, half hidden by it,
  // so the front reads as a doubled band.
  frontRow.forEach((front, index) => {
    const next = frontRow[index + 1];
    if (!next || Math.hypot(next.x - front.x, next.y - front.y) > (front.width + next.width) * 0.9) return;
    if (rng() > settings.edgeRows) return;
    const normal = inward({ x: (front.x + next.x) / 2, y: (front.y + next.y) / 2 - front.height * 0.5 });
    const tree = treeMark(0, 0, (front.width + next.width) / 2 * (0.75 + rng() * 0.3), PEN.second * (0.95 + rng() * 0.1), rng, "second", forest);
    const lift = Math.min(front.height, next.height) * (0.3 + rng() * 0.15);
    tree.x = (front.x + next.x) / 2 + normal.x * lift;
    tree.y = Math.min(front.y, next.y) + normal.y * lift;
    if (sample(mask, width, height, tree.x, tree.y - tree.height * 0.5) < 0.5) return;
    if (!treeOnGround(tree, tree.width * 0.35)) return;
    field.tryAdd(tree, 0.45);
  });

  // 3. The fill: loose rows of caps. Each row is walked with its own uneven
  // steps (no lattice), and a slow noise opens thinner patches.
  const fillDensity = Math.max(0.2, settings.density);
  // Near any edge the trees show more than their tops, in the middle pen,
  // easing to short fine tops three or four trees in.
  const inside = distanceTo(mask, width, height, (value) => value < 0.5);
  const rowStep = size * 0.72 / Math.sqrt(fillDensity);
  const rowWarp = new SimplexNoise(input.seed + 1301);
  const thinning = new SimplexNoise(input.seed + 1302);
  const rows = Math.ceil(height / rowStep) + 2;
  for (let row = -1; row < rows; row++) {
    let x = -size * rng() * 2;
    const baseY = row * rowStep;
    while (x < width + size) {
      // Only the pointed top of each tree shows inside the stand.
      // Now and then two or three tops run together in one stroke.
      const w = crown * (0.7 + rng() * 0.3);
      const count = groupSize(rng, style.pairs, style.triples);
      const span = w * (1 + (count - 1) * GROUP_STEP);
      const y = baseY + rowWarp.noise2D(x / (size * 16), baseY / (size * 16)) * size * 1.0 + (rng() - 0.5) * rowStep * 0.2;
      const cx = x + span / 2;
      const edge = 1 - smoothStep(size, size * 3.5, sample(inside, width, height, cx, y - w * 0.4));
      const cut = between(style.fillCut, rng) * (1 - edge) + between(style.edgeCut, rng) * edge;
      const h = w * (style.length[0] + style.length[1]) / 2 * cut;
      x += (span + w * rng() * 0.6) / Math.sqrt(fillDensity);
      if (sample(mask, width, height, cx, y - h * 0.5) < 0.56) continue;
      if (!onGround(cx, y, span * 0.4)) continue;
      // Lit ground and the thin patches drop marks; shade keeps and weights them.
      const light = lightAt(cx, y);
      const lit = clamp01((light - 0.5) * 2) * lightStrength;
      const shaded = clamp01((0.5 - light) * 2) * lightStrength;
      const thin = smoothStep(0, 0.7, thinning.noise2D(cx / (size * 9), y / (size * 9))) * 0.55;
      if (rng() < 0.08 + lit * 0.35 + thin) continue;
      const pen = inkMarkPen({ role: "fill", edge }) * (0.95 + shaded * 0.3 * (1 - edge) + rng() * 0.1);
      // Fill tops are rounder than the pointed edge trees, sharpening again
      // toward an edge.
      const tip = style.fillTip * (1 - edge) + edge;
      field.tryAdd(topMark(cx, y, w, cut, pen, rng, "fill", forest, count, tip, edge), 0);
    }
  }

  // 4. Lone trees: ovals in ones, twos and threes, more of them near the stands.
  const outside = distanceTo(mask, width, height, (value) => value >= 0.5);
  const clumps = new SimplexNoise(input.seed + 1303);
  const suitability = input.suitability?.length === width * height ? input.suitability : undefined;
  const farSuitability = (index: number) => suitability ? clamp01(suitability[index]) : 0;
  const footDots = (x: number, y: number, direction: number, count: number) => {
    for (let index = 0; index < count; index++) {
      const dot = dotMark(x + direction * size * (0.3 + index * (0.4 + rng() * 0.12)), y + (rng() - 0.5) * size * 0.06, size * rng() * 0.06, PEN.grass);
      if (!groundAt(dot.x, dot.y)) break;
      field.tryAdd(dot, 0.3);
    }
  };
  // Plants placed on their own stand as lone trees where they were placed.
  for (const plant of input.loneTrees ?? []) {
    const w = crown * (0.5 + rng() * 0.22);
    const tree = treeMark(plant.x, plant.y, w, PEN.lone * (0.9 + rng() * 0.2), rng, "lone", plantKind());
    if (sample(mask, width, height, plant.x, plant.y) < 0.3 && treeOnGround(tree, w * 0.35)) field.tryAdd(tree, 0.1);
  }
  const treeAttempts = Math.round(width * height / (size * size) * 0.3 * settings.meadowTrees);
  for (let attempt = 0; attempt < treeAttempts; attempt++) {
    const x = rng() * width;
    const y = rng() * height;
    const index = Math.floor(y) * width + Math.floor(x);
    const distance = outside[index] / size;
    if (distance < 0.6) continue;
    const clump = smoothStep(-0.2, 0.6, clumps.noise2D(x / (size * 10), y / (size * 10)));
    // Lone trees gather around the stands; well away from them only where
    // the ground suits trees, as in the old stands.
    const chance = (Math.exp(-distance / 2.2) * 0.35 + 0.01 * farSuitability(index)) * (0.3 + clump) *
      (1 - smoothStep(35, 50, input.slope?.[index] ?? 0)) * (1 - sparseAt(x, y));
    if (rng() > chance) continue;
    const roll = rng();
    const count = roll < 0.55 ? 1 : roll < 0.88 ? 2 : 3;
    let cursor = x;
    const group: ForestInkMark[] = [];
    for (let member = 0; member < count; member++) {
      const small = rng() < 0.3;
      const w = crown * (small ? 0.38 + rng() * 0.1 : 0.5 + rng() * 0.22);
      group.push(treeMark(cursor + w / 2, y + (rng() - 0.5) * size * 0.12, w, PEN.lone * (0.9 + rng() * 0.2), rng, "lone", plantKind()));
      cursor += w * (0.95 + rng() * 0.25);
    }
    if (!group.every((mark) => field.fits(mark.x, mark.y, mark.width, mark.height, 0) &&
      sample(mask, width, height, mark.x, mark.y) < 0.3 && treeOnGround(mark, mark.width * 0.35))) continue;
    for (const mark of group) field.add(mark);
    if (rng() < 0.45 * settings.grass) {
      const left = rng() < 0.5;
      const edge = left ? group[0].x - group[0].width / 2 : group[group.length - 1].x + group[group.length - 1].width / 2;
      footDots(edge, y, left ? -1 : 1, 1 + Math.floor(rng() * 3));
    }
  }

  // 5. Grass: dotted runs trailing out from the foot of the front row where
  // open ground lies beside it, then short runs scattered near the stands.
  for (const front of frontRow) {
    if (rng() > 0.12 * settings.grass) continue;
    const direction = rng() < 0.5 ? -1 : 1;
    const startX = front.x + direction * front.width * 0.6;
    if (sample(mask, width, height, startX + direction * size * 0.4, front.y - size * 0.3) >= 0.4) continue;
    footDots(startX - direction * size * 0.3, front.y, direction, 2 + Math.floor(rng() * 5));
  }
  const grassAttempts = Math.round(width * height / (size * size) * 0.25 * settings.grass);
  for (let attempt = 0; attempt < grassAttempts; attempt++) {
    const x = rng() * width;
    const y = rng() * height;
    const cell = Math.floor(y) * width + Math.floor(x);
    const distance = outside[cell] / size;
    if (distance < 0.3) continue;
    if (rng() > (Math.exp(-distance / 1.8) * 0.5 + 0.01 * farSuitability(cell)) * (1 - sparseAt(x, y))) continue;
    const count = 2 + Math.floor(rng() * 5);
    const step = size * (0.38 + rng() * 0.15);
    for (let index = 0; index < count; index++) {
      const dx = x + index * step;
      if (sample(mask, width, height, dx, y) >= 0.4 || !groundAt(dx, y)) break;
      field.tryAdd(dotMark(dx, y + (rng() - 0.5) * size * 0.08, size * rng() * 0.1, PEN.grass), 0.2);
    }
  }

  const marks = field.marks.slice().sort((a, b) => a.y - b.y);
  // Light clusters for the wash: each patch of the stand is lit or shaded as
  // a whole, as the hand-drawn stands always were.
  const shade = input.light
    ? clusterLight(mask, input.light, width, height, size * INK_WASH_TREE_SIZE_PER_MARK, input.seed)
    : undefined;
  return {
    markSize: size, seed: input.seed, shade, mask, maskWidth: width, maskHeight: height, marks,
    scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0,
  };
}

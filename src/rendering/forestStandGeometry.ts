import { SimplexNoise } from "../core/noise";

/**
 * Hand-drawn style forest stands, shared by /forest-lab and the vegetation
 * pattern layer. A stand is mostly wash: a continuous L4 line of simple
 * tops closes its upper edge (with L3 tops set into it and a loose row of
 * L2/L3 below), L1/L2 trees stand along its lower edge with a low L4 line
 * where none stands, and a few L2/L3 break up the interior. Lone trees on
 * open ground are L1.
 *
 * Tree levels come from the authored SVG templates in
 * assets/BiomeProps/ForestLab (every lodN-*.svg is a variant of level N):
 * L1 full tree, L2 in-between tree, L3 one to three tops in one stroke.
 * A `StandProfile` bundles the templates with the L4 top shape, so other
 * plants reuse the same stand workflow: shrubs use the ShrubLab templates
 * and a rounded L4.
 *
 * The builder resolves every random choice into plain fills and strokes,
 * so rendering is deterministic and a stand cut by a tile edge draws the
 * same in both tiles. Lengths scale with `treeSize`; the lab's tuning was
 * done at a tree size of 13 map pixels.
 */

export type Point = { x: number; y: number };

export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
export const smoothStep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

export function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fbm(noise: SimplexNoise, x: number, y: number, octaves: number): number {
  let total = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    total += amplitude * noise.noise2D(x * frequency, y * frequency);
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return total;
}

export function boxBlur(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius <= 0) return source.slice();
  const temp = new Float32Array(source.length);
  const out = new Float32Array(source.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += source[y * width + Math.max(0, Math.min(width - 1, x))];
    for (let x = 0; x < width; x++) {
      temp[y * width + x] = sum / span;
      sum += source[y * width + Math.min(width - 1, x + radius + 1)] -
        source[y * width + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += temp[Math.max(0, Math.min(height - 1, y)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / span;
      sum += temp[Math.min(height - 1, y + radius + 1) * width + x] -
        temp[Math.max(0, y - radius) * width + x];
    }
  }
  return out;
}

export function sample(field: Float32Array, width: number, height: number, x: number, y: number): number {
  const cx = Math.max(0, Math.min(width - 1.001, x));
  const cy = Math.max(0, Math.min(height - 1.001, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const i = y0 * width + x0;
  return (field[i] * (1 - fx) + field[i + 1] * fx) * (1 - fy) +
    (field[i + width] * (1 - fx) + field[i + width + 1] * fx) * fy;
}

/** Tree size the lab was tuned at; fixed pixel constants scale from it. */
export const FOREST_STAND_REFERENCE_TREE_SIZE = 13;

// --- resolved primitives -----------------------------------------------------

/**
 * How a fill is painted. Colours come from the paint settings at render
 * time: `wash` = stand wash, `shadow` = darkened tree body, `ground` = ink
 * cast shadow, `lit` = body lit across x (`from`..`to`), `fade` = body
 * fading out down y (`from`..`to`), `accent` = accent plant body,
 * `trunk` = accent plant trunk.
 */
export type ForestStandFillStyle = "wash" | "shadow" | "ground" | "lit" | "fade" | "accent" | "trunk";

export interface ForestStandFill {
  style: ForestStandFillStyle;
  points: Point[];
  alpha: number;
  tone?: number;
  from?: number;
  to?: number;
}

export interface ForestStandStroke {
  /** Flat x0, y0, x1, y1, widthFactor per segment; width is a multiple of the ink width. */
  segments: number[];
  alpha: number;
}

export interface ForestStandItem {
  sortY: number;
  /** Terrain light at the tree's centre: 0 = deep shadow, 0.5 = flat ground, 1 = fully lit. */
  light: number;
  /** Light of the cluster the item sits in (its wash fills use it). */
  washLight: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  fills: ForestStandFill[];
  strokes: ForestStandStroke[];
}

export interface ForestStandGeometry {
  /** Soft stand mask in its own domain; the wash edge sits at 0.5. */
  mask: Float32Array;
  maskWidth: number;
  maskHeight: number;
  /**
   * Wash light per mask cell, one tone per light cluster: 0.2 for a cluster
   * on the shadow side, 0.8 for a lit one (0.5 outside stands).
   */
  shade?: Float32Array;
  /** Plant size in mask units. */
  treeSize: number;
  /**
   * Stand tree size in mask units (treeSize / profile.size). Ink width scales
   * from it, so one ink weight draws the same line for trees and shrubs.
   */
  inkSize: number;
  /** Output pixel = mask coordinate * scale - offset. Items are already in output pixels. */
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  seed: number;
  items: ForestStandItem[];
}

export interface ForestStandPlacementSettings {
  /** Spacing between trees, as in the lab's "Mark spacing". */
  markSpacing: number;
  /** Trees along the top and bottom edges. */
  edgeTrees: number;
  /** Sparse L2/L3 inside stands. */
  interiorTrees: number;
  /** L1 trees scattered in the meadow around stands. */
  meadowTrees: number;
  /** Share of plants that become the profile's accent trees (profiles with an accent only). */
  accentTrees?: number;
}

export interface ForestStandInput {
  width: number;
  height: number;
  /** Raw stand coverage, 0..1 (> 0.5 is forest). */
  forest: Float32Array;
  treeSize: number;
  seed: number;
  settings: ForestStandPlacementSettings;
  /** Optional 0..1 ground suitability for meadow clumps. */
  suitability?: Float32Array;
  /** Optional slope in degrees; meadow trees avoid cliffs. */
  slope?: Float32Array;
  /** Optional 0..1 terrain light per cell (0.5 = flat ground). */
  light?: Float32Array;
  /** Plants already placed on open ground; each becomes an L1. */
  loneTrees?: Point[];
  /** Templates and L4 shape; trees when omitted. */
  profile?: StandProfile;
}

// --- templates ---------------------------------------------------------------

export interface TreeTemplate {
  /** Subpaths in units of the template height: y from -1 (top) to 0 (ground). */
  paths: Point[][];
  /** Fill-only trunk polygons (`<path class="trunk">`), same units. */
  trunk?: Point[][];
}

/** Polylines from every path `d` in an SVG; curves are reduced to their end points. */
export function parseSvgPolylines(svg: string): Point[][] {
  const argCounts: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7 };
  const result: Point[][] = [];
  for (const match of svg.matchAll(/\sd="([^"]+)"/g)) {
    const tokens = match[1].match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
    let command = "M";
    let index = 0;
    let current: Point = { x: 0, y: 0 };
    let start = current;
    let path: Point[] = [];
    while (index < tokens.length) {
      if (/[a-zA-Z]/.test(tokens[index])) command = tokens[index++];
      const lower = command.toLowerCase();
      const relative = command === lower;
      if (lower === "z") {
        path.push(start);
        current = start;
        if (index < tokens.length && !/[a-zA-Z]/.test(tokens[index])) break;
        continue;
      }
      const count = argCounts[lower];
      if (count === undefined) break;
      const args = tokens.slice(index, index + count).map(Number);
      index += count;
      if (args.length < count || args.some(Number.isNaN)) break;
      let { x, y } = current;
      if (lower === "h") x = relative ? x + args[0] : args[0];
      else if (lower === "v") y = relative ? y + args[0] : args[0];
      else {
        x = relative ? x + args[count - 2] : args[count - 2];
        y = relative ? y + args[count - 1] : args[count - 1];
      }
      current = { x, y };
      if (lower === "m") {
        if (path.length > 1) result.push(path);
        path = [current];
        start = current;
        // Coordinates after a moveto are implicit linetos.
        command = relative ? "l" : "L";
      } else {
        path.push(current);
      }
    }
    if (path.length > 1) result.push(path);
  }
  return result;
}

function loadTreeTemplate(svg: string): TreeTemplate {
  const trunkPattern = /<path[^>]*class="trunk"[^>]*>/g;
  const trunk = parseSvgPolylines((svg.match(trunkPattern) ?? []).join(" "));
  const polylines = parseSvgPolylines(svg.replace(trunkPattern, ""));
  const all = polylines.flat();
  const minX = Math.min(...all.map((point) => point.x));
  const maxX = Math.max(...all.map((point) => point.x));
  const minY = Math.min(...all.map((point) => point.y));
  const maxY = Math.max(...all.map((point) => point.y));
  const height = Math.max(1e-6, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const normalise = (path: Point[]) => path.map((point) => ({
    x: (point.x - centerX) / height,
    y: (point.y - maxY) / height,
  }));
  return { paths: polylines.map(normalise), trunk: trunk.length ? trunk.map(normalise) : undefined };
}

export interface StandTemplates {
  /** L1 */
  full: TreeTemplate[];
  /** L2 */
  half: TreeTemplate[];
  /** L3 */
  pair: TreeTemplate[];
}

/** What a kind of plant looks like in a stand; placement is shared. */
export interface StandProfile {
  /** Plant height relative to a stand tree (1 for trees); one scale drives every profile. */
  size: number;
  templates: StandTemplates;
  /** L4 line: pointed tops or rounded bumps. */
  topShape: "spiked" | "rounded";
  /** Taller plants scattered among the L1s (e.g. trees among shrubs). */
  accent?: {
    templates: TreeTemplate[];
    /** Height relative to the stand's plant size. */
    size: number;
    /** Chance that an L1 (patch edge or open ground) is an accent instead. */
    share: number;
  };
}

// Every lodN-*.svg in a folder is a variant of that level; add a file to
// add a variant. (import.meta.glob needs literal patterns.)
const templateFiles = (files: Record<string, string>) => Object.values(files).map(loadTreeTemplate);

export const TREE_STAND_PROFILE: StandProfile = {
  size: 1,
  templates: {
    full: templateFiles(import.meta.glob<string>("../assets/BiomeProps/ForestLab/lod1-*.svg", { query: "?raw", import: "default", eager: true })),
    half: templateFiles(import.meta.glob<string>("../assets/BiomeProps/ForestLab/lod2-*.svg", { query: "?raw", import: "default", eager: true })),
    pair: templateFiles(import.meta.glob<string>("../assets/BiomeProps/ForestLab/lod3-*.svg", { query: "?raw", import: "default", eager: true })),
  },
  topShape: "spiked",
};

// Shrub templates are about three times wider for their height than trees;
// at this height a shrub is a bit narrower and much lower than a tree.
const SHRUB_SIZE = 0.36;

export const SHRUB_STAND_PROFILE: StandProfile = {
  size: SHRUB_SIZE,
  templates: {
    full: templateFiles(import.meta.glob<string>("../assets/BiomeProps/ShrubLab/lod1-*.svg", { query: "?raw", import: "default", eager: true })),
    half: templateFiles(import.meta.glob<string>("../assets/BiomeProps/ShrubLab/lod2-*.svg", { query: "?raw", import: "default", eager: true })),
    pair: templateFiles(import.meta.glob<string>("../assets/BiomeProps/ShrubLab/lod3-*.svg", { query: "?raw", import: "default", eager: true })),
  },
  topShape: "rounded",
  // Wetland trees along the shrub patches and on the open ground around them.
  accent: {
    templates: templateFiles(import.meta.glob<string>("../assets/BiomeProps/ShrubLab/accent-*.svg", { query: "?raw", import: "default", eager: true })),
    // As tall as a stand tree.
    size: 1 / SHRUB_SIZE,
    share: 0.18,
  },
};

const meanTemplateWidth = (templates: TreeTemplate[]): number => templates.reduce((sum, template) => {
  const xs = template.paths.flat().map((point) => point.x);
  return sum + Math.max(...xs) - Math.min(...xs);
}, 0) / Math.max(1, templates.length);

const profileSpreads = new WeakMap<StandProfile, Record<TreeLevel, number>>();

/**
 * How much wider a profile's plants are than trees, per level (exactly 1
 * for trees). Placement spacing, tuned on trees, scales with it so wide
 * plants keep the same gaps.
 */
function spreadOf(profile: StandProfile): Record<TreeLevel, number> {
  let spread = profileSpreads.get(profile);
  if (!spread) {
    const tree = TREE_STAND_PROFILE.templates;
    const level = (key: TreeLevel) => meanTemplateWidth(profile.templates[key]) / meanTemplateWidth(tree[key]);
    spread = { full: level("full"), half: level("half"), pair: level("pair") };
    profileSpreads.set(profile, spread);
  }
  return spread;
}

/** One instance of a random variant: scaled to height `h`, stretched a little, every vertex nudged. */
function templateInstance(variants: TreeTemplate[], h: number, rng: () => number): Point[][] {
  return instantiate(variants, h, rng).paths;
}

/** Like templateInstance, plus the trunk scaled the same way (without jitter). */
function instantiate(variants: TreeTemplate[], h: number, rng: () => number): { paths: Point[][]; trunk?: Point[][] } {
  const template = variants[Math.floor(rng() * variants.length)];
  const width = h * (0.85 + rng() * 0.3);
  const jitter = h * 0.025;
  const paths = template.paths.map((path) => path.map((point) => ({
    x: point.x * width + (rng() - 0.5) * jitter,
    // Keep the ground line level so trees stand on it.
    y: point.y * h + (point.y < -0.02 ? (rng() - 0.5) * jitter : 0),
  })));
  const trunk = template.trunk?.map((path) => path.map((point) => ({ x: point.x * width, y: point.y * h })));
  return { paths, trunk };
}

// --- item construction -------------------------------------------------------

const translate = (points: Point[], x: number, y: number): Point[] => points.map((point) => ({ x: point.x + x, y: point.y + y }));

function finishItem(sortY: number, fills: ForestStandFill[], strokes: ForestStandStroke[]): ForestStandItem {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const fill of fills) for (const point of fill.points) grow(point.x, point.y);
  for (const stroke of strokes) {
    for (let index = 0; index < stroke.segments.length; index += 5) {
      grow(stroke.segments[index], stroke.segments[index + 1]);
      grow(stroke.segments[index + 2], stroke.segments[index + 3]);
    }
  }
  return { sortY, light: 0.5, washLight: 0.5, minX, minY, maxX, maxY, fills, strokes };
}

/** Ink along a template path (local to the tree), heavier on the shadow (right) side. */
function inkTemplatePath(points: Point[], x: number, y: number, width: number, rng: () => number): number[] {
  const segments: number[] = [];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    segments.push(a.x + x, a.y + y, b.x + x, b.y + y, width * ((a.x + b.x) > 0 ? 1.15 : 0.85) * (0.85 + rng() * 0.3));
  }
  return segments;
}

/** Pen line with per-segment pressure, wobble and occasional lifts. */
function inkPenLine(points: Point[], keep: number, width: number, inkUnit: number, rng: () => number): number[] {
  const segments: number[] = [];
  const jitter = width * inkUnit * 0.3;
  let previous = { x: points[0].x + (rng() - 0.5) * jitter, y: points[0].y + (rng() - 0.5) * jitter };
  for (let index = 1; index < points.length; index++) {
    const next = { x: points[index].x + (rng() - 0.5) * jitter, y: points[index].y + (rng() - 0.5) * jitter };
    if (rng() < keep) segments.push(previous.x, previous.y, next.x, next.y, width * (0.6 + rng() * 0.8));
    previous = next;
  }
  return segments;
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Point[] {
  return Array.from({ length: 16 }, (_, index) => {
    const angle = index / 16 * Math.PI * 2;
    return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });
}

/** L1: body lit through the middle, ink along the drawn outline only, cast shadow at the foot. */
function fullTreeItem(x: number, y: number, size: number, rng: () => number, variants: TreeTemplate[]): ForestStandItem {
  const h = size * (1.2 + rng() * 0.12);
  const paths = templateInstance(variants, h, rng);
  const outline = paths.flat();
  const minX = Math.min(...outline.map((point) => point.x));
  const maxX = Math.max(...outline.map((point) => point.x));
  const tone = 0.95 + (rng() - 0.5) * 0.14;
  const fills: ForestStandFill[] = [
    { style: "ground", alpha: 0.4, points: ellipsePoints(x + maxX * 0.35, y - h * 0.01, (maxX - minX) * 0.45, h * 0.045) },
    { style: "lit", alpha: 1, tone, from: x + minX, to: x + maxX, points: translate(outline, x, y) },
  ];
  const strokes = paths.map((path) => ({ alpha: 0.95, segments: inkTemplatePath(path, x, y, 1.1, rng) }));
  return finishItem(y, fills, strokes);
}

/** L2: wash base, body fading toward the ground, ink including the broken lit side. */
function halfTreeItem(x: number, y: number, size: number, rng: () => number, templates: StandTemplates): ForestStandItem {
  const h = size * (1.15 + rng() * 0.12);
  const paths = templateInstance(templates.half, h, rng);
  const outline = translate(paths.flat(), x, y);
  const fills: ForestStandFill[] = [
    { style: "wash", alpha: 1, points: outline },
    { style: "fade", alpha: 0.75, from: y - h, to: y, points: outline },
  ];
  const strokes = paths.map((path) => ({ alpha: 0.95, segments: inkTemplatePath(path, x, y, 1, rng) }));
  return finishItem(y, fills, strokes);
}

/** L3: tops in one continuous stroke over a wash fill. */
function pairItem(x: number, y: number, paths: Point[][], sortY: number, rng: () => number, style: ForestStandFillStyle = "wash"): ForestStandItem {
  const fills: ForestStandFill[] = [{ style, alpha: 1, points: translate(paths.flat(), x, y) }];
  const strokes = paths.map((path) => ({ alpha: 0.95, segments: inkTemplatePath(path, x, y, 1, rng) }));
  return finishItem(sortY, fills, strokes);
}

type TreeLevel = "full" | "half" | "pair";

type StandAccent = NonNullable<StandProfile["accent"]>;

/** A whole accent tree (on a patch rim or in the open): accent body, trunk, ink, cast shadow. */
function accentItem(x: number, y: number, size: number, rng: () => number, accent: StandAccent): ForestStandItem {
  const h = size * accent.size * (1.2 + rng() * 0.12);
  const { paths, trunk } = instantiate(accent.templates, h, rng);
  const outline = paths.flat();
  const minX = Math.min(...outline.map((point) => point.x));
  const maxX = Math.max(...outline.map((point) => point.x));
  const fills: ForestStandFill[] = [
    { style: "ground", alpha: 0.4, points: ellipsePoints(x + maxX * 0.35, y - h * 0.01, (maxX - minX) * 0.45, h * 0.045) },
    { style: "accent", alpha: 1, points: translate(outline, x, y) },
    ...(trunk ?? []).map((points) => ({ style: "trunk" as const, alpha: 1, points: translate(points, x, y) })),
  ];
  const strokes = paths.map((path) => ({ alpha: 0.95, segments: inkTemplatePath(path, x, y, 1.1, rng) }));
  return finishItem(y, fills, strokes);
}

/**
 * The top two thirds of an accent tree, for one standing inside a patch: the
 * trunk and lower crown are hidden by the stand. Shifted so the cut sits on y = 0, like an L3.
 */
function accentTopPaths(size: number, rng: () => number, accent: StandAccent): Point[][] {
  const h = size * accent.size * (1.2 + rng() * 0.12);
  const cut = -h / 3;
  const pieces: Point[][] = [];
  for (const path of instantiate(accent.templates, h, rng).paths) {
    let piece: Point[] = [];
    for (let index = 0; index < path.length; index++) {
      const point = path[index];
      const previous = path[index - 1];
      if (previous && (previous.y < cut) !== (point.y < cut)) {
        const t = (cut - previous.y) / (point.y - previous.y);
        piece.push({ x: previous.x + (point.x - previous.x) * t, y: cut });
        if (point.y >= cut) {
          if (piece.length > 1) pieces.push(piece);
          piece = [];
        }
      }
      if (point.y < cut) piece.push(point);
    }
    if (piece.length > 1) pieces.push(piece);
  }
  return pieces.map((piece) => piece.map((point) => ({ x: point.x, y: point.y - cut })));
}

function levelItems(level: TreeLevel, x: number, y: number, size: number, rng: () => number, profile: StandProfile): ForestStandItem[] {
  const templates = profile.templates;
  if (level === "full") {
    const accent = profile.accent;
    if (accent && rng() < accent.share) return [accentItem(x, y, size, rng, accent)];
    if (rng() >= 0.25) return [fullTreeItem(x, y, size, rng, templates.full)];
    // L1 as hand-drawn maps group them in the open: a row of 2–4 trees, slightly overlapping.
    const count = 2 + Math.floor(rng() * 3);
    const step = size * (0.52 + rng() * 0.1) * spreadOf(profile).full;
    return Array.from({ length: count }, (_, index) => fullTreeItem(
      x + (index - (count - 1) / 2) * step,
      y + (rng() - 0.5) * size * 0.12,
      size * (0.95 + rng() * 0.1),
      rng,
      templates.full,
    ));
  }
  // Accents standing among the L2/L3 (inside the patch) show only their upper part.
  if (profile.accent && rng() < profile.accent.share) return [pairItem(x, y, accentTopPaths(size, rng, profile.accent), y, rng, "accent")];
  if (level === "half") return [halfTreeItem(x, y, size, rng, templates)];
  return [pairItem(x, y, templateInstance(templates.pair, size * (1 + rng() * 0.1), rng), y, rng)];
}

// --- L4 runs -----------------------------------------------------------------

interface TopRun {
  points: Point[];
  spikes: { tipX: number; tipY: number; rightX: number; rightY: number; baseY: number }[];
  floor: (x: number) => number;
  startX: number;
  endX: number;
}

/** L4: a continuous run of simple tops following a baseline. */
function buildTopRun(
  baseline: (x: number) => number,
  startX: number,
  endX: number,
  size: number,
  rng: () => number,
  /** x ranges taken by L3 tops; the run stays low and hidden there. */
  gaps: [number, number][] = [],
  /** Spike height scale; widths stay as for a full-height run. */
  amplitude = 1,
  /** How far (in tree sizes) the wash fill reaches below the baseline. */
  floorDepth = 0.45,
  /** "rounded": wide bumps with shallow valleys instead of pointed tops. */
  shape: StandProfile["topShape"] = "spiked",
): TopRun {
  const rounded = shape === "rounded";
  const points: Point[] = [{ x: startX, y: baseline(startX) }];
  const spikes: TopRun["spikes"] = [];
  let cursor = startX;
  // Runs taper at both ends so a patch reads as a mound, not a box.
  const taper = (x: number) => smoothStep(0, size * 0.9, Math.min(x - startX, endX - x));
  while (cursor < endX - size * 0.1) {
    const inGap = gaps.some(([from, to]) => cursor + size * 0.1 >= from && cursor <= to);
    const fullHeight = inGap ? size * 0.12 : (0.4 + 0.6 * taper(cursor + size * 0.15)) * size * (0.4 + rng() * rng() * 0.6);
    const h = inGap ? fullHeight : fullHeight * amplitude;
    const halfWidth = Math.min((endX - cursor) * 0.5, fullHeight * (rounded ? 0.5 + rng() * 0.2 : 0.22 + rng() * 0.1));
    const tipX = cursor + halfWidth;
    const tipY = baseline(tipX) - h;
    const rightX = Math.min(endX, tipX + halfWidth * (0.9 + rng() * 0.4));
    const last = rightX >= endX - size * 0.1;
    const valleyY = last ? baseline(rightX) : baseline(rightX) - h * (rounded ? 0.55 + rng() * 0.25 : 0.35 + rng() * 0.4);
    if (rounded) {
      // Arc from the previous valley over the top to the next valley.
      const from = points[points.length - 1];
      const lift = (from.y + valleyY) / 2 - tipY;
      for (let step = 1; step < 6; step++) {
        const t = step / 6;
        points.push({
          x: from.x + (rightX - from.x) * t,
          y: from.y + (valleyY - from.y) * t - lift * Math.sin(Math.PI * t) ** 0.7,
        });
      }
    } else {
      points.push({ x: tipX, y: tipY });
    }
    points.push({ x: rightX, y: valleyY });
    spikes.push({ tipX, tipY, rightX, rightY: valleyY, baseY: baseline(tipX) });
    cursor = rightX;
  }
  return { points, spikes, floor: (x) => baseline(x) + size * floorDepth * taper(x), startX, endX: cursor };
}

function topRunItem(run: TopRun, sortY: number, inkUnit: number, rng: () => number, gaps: [number, number][] = []): ForestStandItem {
  const inGap = (x: number) => gaps.some(([from, to]) => x >= from && x <= to);
  // Wash colour under the tops so the ink never sits over meadow colour.
  const washPoints = [...run.points];
  const steps = Math.max(2, Math.ceil(run.endX - run.startX));
  for (let step = steps; step >= 0; step--) {
    const x = run.startX + (run.endX - run.startX) * step / steps;
    washPoints.push({ x, y: run.floor(x) });
  }
  const fills: ForestStandFill[] = [{ style: "wash", alpha: 1, points: washPoints }];
  // Ink the run in pieces, leaving the L3 gaps to the L3 strokes.
  const strokes: ForestStandStroke[] = [];
  let piece: Point[] = [];
  const flush = () => {
    if (piece.length > 1) strokes.push({ alpha: 0.9, segments: inkPenLine(piece, 0.99, 0.9, inkUnit, rng) });
    piece = [];
  };
  for (let index = 0; index < run.points.length; index++) {
    const point = run.points[index];
    const previous = run.points[index - 1];
    if (previous && inGap((previous.x + point.x) / 2)) flush();
    piece.push(point);
  }
  flush();
  return finishItem(sortY, fills, strokes);
}

// --- placement ---------------------------------------------------------------

/** The soft stand mask the wash is painted from; the edge sits at 0.5. */
function standWashMask(forest: Float32Array, width: number, height: number, unit: number): Float32Array {
  return boxBlur(boxBlur(forest, width, height, Math.max(1, Math.round(3 * unit))), width, height, Math.max(1, Math.round(2 * unit)));
}

/** Space already taken by an earlier pass (centre and half extents). */
interface Footprint { x: number; y: number; halfWidth: number; halfHeight: number }

function footprintIndex(footprints: Footprint[], cell: number) {
  const grid = new Map<string, Footprint[]>();
  for (const footprint of footprints) {
    for (let gx = Math.floor((footprint.x - footprint.halfWidth) / cell); gx <= Math.floor((footprint.x + footprint.halfWidth) / cell); gx++) {
      for (let gy = Math.floor((footprint.y - footprint.halfHeight) / cell); gy <= Math.floor((footprint.y + footprint.halfHeight) / cell); gy++) {
        const key = `${gx},${gy}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(footprint);
        else grid.set(key, [footprint]);
      }
    }
  }
  return (x: number, y: number, halfWidth: number, halfHeight: number): boolean => {
    for (let gx = Math.floor((x - halfWidth) / cell); gx <= Math.floor((x + halfWidth) / cell); gx++) {
      for (let gy = Math.floor((y - halfHeight) / cell); gy <= Math.floor((y + halfHeight) / cell); gy++) {
        for (const other of grid.get(`${gx},${gy}`) ?? []) {
          if (Math.abs(other.x - x) < other.halfWidth + halfWidth && Math.abs(other.y - y) < other.halfHeight + halfHeight) return true;
        }
      }
    }
    return false;
  };
}

interface TreeMark { x: number; y: number; level: TreeLevel; halfWidth: number }

function placeTreeMarks(input: ForestStandInput, rng: () => number, reserved: Footprint[], profile: StandProfile): TreeMark[] {
  const { width, height, forest, settings } = input;
  const size = input.treeSize;
  // Wider plants (shrubs) are spaced further apart; collision widths below
  // keep them from overlapping, so only part of the width goes into spacing.
  const spacing = size * 1.1 * settings.markSpacing * 2 * spreadOf(profile).full ** 0.75;
  const isReserved = footprintIndex(reserved, size * 2);
  const inside = boxBlur(forest, width, height, Math.round(size * 0.8));
  const near = boxBlur(forest, width, height, Math.round(size * 2.2));
  const clumpNoise = new SimplexNoise(input.seed + 606);
  const clumpScale = 25 * size / FOREST_STAND_REFERENCE_TREE_SIZE;
  const marks: TreeMark[] = [];
  const cell = spacing;
  const cols = Math.ceil(width / cell);
  const buckets = new Map<number, TreeMark[]>();
  const attempts = Math.round(width * height / (spacing * spacing) * 5);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const x = rng() * width;
    const y = rng() * height;
    const i = Math.floor(y) * width + Math.floor(x);
    const inForest = forest[i] > 0.5;
    const depth = sample(inside, width, height, x, y);
    const below = sample(inside, width, height, x, y + size * 0.8);
    const above = sample(inside, width, height, x, y - size * 0.8);
    const upperEdge = inForest ? clamp01((below - above) * 2.5) : 0;
    const lowerEdge = inForest || depth > 0.3 ? clamp01((above - below) * 2.5) * smoothStep(0.2, 0.45, depth) : 0;

    let level: TreeLevel;
    let keep: number;
    if (lowerEdge > 0.25) {
      const roll = rng();
      // The bottom edge is mostly L1/L2. L1 has a solid body, so it can
      // stand right on the rim; L2/L3 have none and need to stand inside
      // the wash. Rim left bare gets the low bottom line.
      level = roll < 0.4 ? "full" : roll < 0.85 ? "half" : "pair";
      if (depth < (level === "full" ? 0.35 : level === "half" ? 0.5 : 0.6) || (!inForest && level !== "full")) continue;
      keep = settings.edgeTrees * (0.4 + lowerEdge) * 1.8;
    } else if (inForest) {
      // The top edge is handled by the traced L4 run.
      if (upperEdge > 0.12) continue;
      level = rng() < 0.5 ? "half" : "pair";
      keep = settings.interiorTrees * 3;
    } else {
      const nearness = clamp01(sample(near, width, height, x, y) * 1.6);
      const clump = smoothStep(0.3, 0.7, clumpNoise.noise2D(x / clumpScale, y / clumpScale));
      // Lone trees on open ground need a body: always L1.
      level = "full";
      keep = settings.meadowTrees * (nearness * nearness * 0.3 + clump * (input.suitability?.[i] ?? 0) * 0.06) *
        (1 - smoothStep(40, 55, input.slope?.[i] ?? 0));
    }
    if (rng() > keep) continue;

    const halfWidth = size * (level === "pair" ? 0.55 : level === "half" ? 0.3 : 0.6) * spreadOf(profile)[level];
    // A mark stands on y and reaches about 1.2 tree sizes up.
    if (isReserved(x, y - size * 0.6, halfWidth, size * 0.6)) continue;
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    const minY = size * (level === "full" || level === "half" ? 0.35 : 0.6);
    let clear = true;
    for (let oy = -2; oy <= 2 && clear; oy++) {
      for (let ox = -2; ox <= 2 && clear; ox++) {
        for (const other of buckets.get((gy + oy) * cols + gx + ox) ?? []) {
          if (Math.abs(other.x - x) < other.halfWidth + halfWidth + size * 0.05 && Math.abs(other.y - y) < minY) {
            clear = false;
            break;
          }
        }
      }
    }
    if (!clear) continue;
    const mark = { x, y, level, halfWidth };
    marks.push(mark);
    const key = gy * cols + gx;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(mark);
    else buckets.set(key, [mark]);
  }
  return marks;
}

/**
 * Upper (or, with `lower`, lower) boundaries of the stands as polylines,
 * one point per column, found where the wash mask turns on (off) going down
 * the screen. Nearby crossings in neighbouring columns are chained so steep
 * stretches stay connected.
 */
function traceStandEdges(mask: Float32Array, width: number, height: number, minLength: number, tolerance: number, lower = false): Point[][] {
  const finished: Point[][] = [];
  let active: Point[][] = [];
  for (let x = 0; x < width; x++) {
    const next: Point[][] = [];
    for (let y = 1; y < height; y++) {
      const a = mask[(y - 1) * width + x];
      const b = mask[y * width + x];
      if (lower ? !(a >= 0.5 && b < 0.5) : !(a < 0.5 && b >= 0.5)) continue;
      const crossing = { x, y: y - 1 + (0.5 - a) / (b - a) };
      let best = -1;
      for (let index = 0; index < active.length; index++) {
        const last = active[index][active[index].length - 1];
        if (Math.abs(last.y - crossing.y) <= tolerance && (best < 0 ||
          Math.abs(last.y - crossing.y) < Math.abs(active[best][active[best].length - 1].y - crossing.y))) best = index;
      }
      if (best >= 0) {
        const chain = active[best];
        chain.push(crossing);
        next.push(chain);
        active.splice(best, 1);
      } else {
        next.push([crossing]);
      }
    }
    finished.push(...active);
    active = next;
  }
  finished.push(...active);
  return finished.filter((chain) => chain.length >= minLength);
}

/**
 * Light clusters: every stand is split into organic cells about four trees
 * across (jittered seeds, warped ragged borders), independent of the
 * terrain. Each cell's mean hillshade then decides whether the whole cell,
 * wash and trees, is dark (0.2) or lit (0.8); 0.5 outside stands. The
 * borders come from the cells, so the result never traces the hillshade.
 */
/**
 * How far below flat-ground light (0.5) a cluster or lone plant must sit to
 * go to the shadow side. Without a margin, near-flat valley floors flip to
 * shadow on tiny tilts or DEM noise. 0.1 is hillshade about 13% darker than
 * flat ground, i.e. a slope actually turned away from the sun.
 */
const SHADOW_MARGIN = 0.1;

function clusterLight(mask: Float32Array, light: Float32Array, width: number, height: number, size: number, seed: number): Float32Array {
  const result = new Float32Array(width * height).fill(0.5);
  const rng = mulberry(seed ^ 0x1c1a57e2);
  const spacing = size * (3.5 + rng());
  const cols = Math.ceil(width / spacing) + 1;
  const rows = Math.ceil(height / spacing) + 1;
  const seedX = new Float32Array(cols * rows);
  const seedY = new Float32Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      seedX[gy * cols + gx] = (gx + 0.15 + rng() * 0.7) * spacing;
      seedY[gy * cols + gx] = (gy + 0.15 + rng() * 0.7) * spacing;
    }
  }
  const warp = new SimplexNoise(seed + 919);
  const warpScale = spacing * 0.9;
  const warpAmount = spacing * 0.35;
  const owner = new Int32Array(width * height).fill(-1);
  const sum = new Float64Array(cols * rows);
  const weight = new Float64Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const m = mask[index];
      if (m <= 0.02) continue;
      // Warp the lookup point so cell borders wander like brush edges.
      const wx = x + warp.noise2D(x / warpScale, y / warpScale) * warpAmount;
      const wy = y + warp.noise2D(x / warpScale + 40, y / warpScale - 40) * warpAmount;
      const cx = Math.floor(wx / spacing);
      const cy = Math.floor(wy / spacing);
      let best = -1;
      let bestDistance = Infinity;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          const gy = cy + oy;
          if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
          const cell = gy * cols + gx;
          const distance = (seedX[cell] - wx) ** 2 + (seedY[cell] - wy) ** 2;
          if (distance < bestDistance) { bestDistance = distance; best = cell; }
        }
      }
      if (best < 0) continue;
      owner[index] = best;
      sum[best] += light[index] * m;
      weight[best] += m;
    }
  }
  for (let index = 0; index < result.length; index++) {
    const cell = owner[index];
    if (cell < 0) continue;
    result[index] = weight[cell] > 0 && sum[cell] / weight[cell] < 0.5 - SHADOW_MARGIN ? 0.2 : 0.8;
  }
  // Carry each cluster's tone a little past the stand edge, so tree tops
  // and top lines that stick out above it keep their cluster's tone.
  const reach = Math.max(2, Math.round(size * 2));
  const distance = new Int32Array(width * height).fill(-1);
  let frontier: number[] = [];
  for (let index = 0; index < result.length; index++) {
    if (result[index] !== 0.5) { distance[index] = 0; frontier.push(index); }
  }
  for (let step = 1; step <= reach && frontier.length; step++) {
    const next: number[] = [];
    for (const index of frontier) {
      const x = index % width;
      for (const neighbour of [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, index - width, index + width]) {
        if (neighbour < 0 || neighbour >= result.length || distance[neighbour] >= 0) continue;
        distance[neighbour] = step;
        result[neighbour] = result[index];
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return result;
}

export function buildForestStandGeometry(input: ForestStandInput): ForestStandGeometry {
  const { width, height, forest, settings } = input;
  const size = input.treeSize;
  const unit = size / FOREST_STAND_REFERENCE_TREE_SIZE;
  const inkUnit = 0.935 * unit;
  const rng = mulberry(input.seed ^ 0x5f0e57);
  const baseProfile = input.profile ?? TREE_STAND_PROFILE;
  const profile: StandProfile = baseProfile.accent && settings.accentTrees !== undefined
    ? { ...baseProfile, accent: { ...baseProfile.accent, share: settings.accentTrees } }
    : baseProfile;
  const spread = spreadOf(profile);
  const items: ForestStandItem[] = [];
  const reserved: Footprint[] = [];
  /** Where each standalone L1/L2/L3 stands (not the ones set into the top line). */
  const trees: Point[] = [];
  const push = (list: ForestStandItem[]) => { for (const item of list) items.push(item); };

  // L4 along each stand's upper boundary, broken up by L3 tops (and the odd
  // L2) standing on the same baseline, their tops level with the line.
  const washMask = standWashMask(forest, width, height, unit);
  const tolerance = Math.max(8, 8 * unit);
  const edges = traceStandEdges(washMask, width, height, Math.round(size * 0.6), tolerance);
  for (const chain of edges) {
    const startX = chain[0].x;
    const baseline = (x: number) => chain[Math.max(0, Math.min(chain.length - 1, Math.round(x - startX)))].y + size * 0.3;
    const runStart = startX - size * 0.1;
    const runEnd = chain[chain.length - 1].x + size * 0.1;
    const gaps: [number, number][] = [];
    const breakers: ForestStandItem[] = [];
    let x = runStart + size * (0.6 + rng() * 1.2);
    while (x < runEnd - size * 0.9) {
      const y = baseline(x) + size * 0.08;
      if (rng() < 0.85) {
        const accentTop = profile.accent !== undefined && rng() < profile.accent.share;
        const paths = accentTop
          ? accentTopPaths(size, rng, profile.accent!)
          : templateInstance(profile.templates.pair, size * (0.75 + rng() * 0.17), rng);
        const xs = paths.flat().map((point) => point.x);
        const left = Math.min(...xs);
        const right = Math.max(...xs);
        // Never start before the previous L3 ends.
        const previousEnd = gaps.length ? gaps[gaps.length - 1][1] + size * 0.15 : -Infinity;
        if (x + left < previousEnd) x = previousEnd - left;
        const from = x + left;
        const to = x + right;
        if (to > runEnd - size * 0.3) break;
        gaps.push([from, to]);
        breakers.push(pairItem(x, baseline(x) + size * 0.08, paths, baseline(x) + size * 0.68, rng, accentTop ? "accent" : "wash"));
        // Next anchor: a short stretch of L4, then roughly half a pair width.
        x = to + size * (0.3 + rng() * 1.4 / Math.max(0.2, settings.edgeTrees)) + (right - left) * 0.5;
      } else {
        for (const item of levelItems("half", x, y, size * (0.7 + rng() * 0.15), rng, profile)) {
          breakers.push({ ...item, sortY: y + size * 0.6 });
        }
        x += size * (1 + rng() * 1.4 / Math.max(0.2, settings.edgeTrees)) * spread.half;
      }
    }
    const run = buildTopRun(baseline, runStart, runEnd, size, rng, gaps, 1, 0.45, profile.topShape);
    const minY = Math.min(...run.points.map((point) => point.y));
    items.push(topRunItem(run, minY + size, inkUnit, rng, gaps));
    push(breakers);
    for (let rx = runStart; rx <= runEnd; rx += size * 0.5) {
      reserved.push({ x: rx, y: baseline(rx) - size * 0.35, halfWidth: size * 0.3, halfHeight: size * 0.55 });
    }
    // A loose second row of L2/L3 just below the top line, only where the
    // patch runs well below it; thin patches keep just their top line.
    let belowX = runStart + size * (0.4 + rng() * 1.2);
    while (belowX < runEnd - size * 0.4) {
      const at = belowX;
      const y = baseline(at) + size * (0.55 + rng() * 0.6);
      let depth = 0;
      const top = baseline(at);
      while (depth < size * 2.4) {
        const probe = Math.floor(top + depth);
        if (probe >= height || forest[probe * width + Math.floor(at)] < 0.5) break;
        depth += 1;
      }
      if (depth >= size * 2.4 && rng() < 0.8) {
        const level: TreeLevel = rng() < 0.5 ? "half" : "pair";
        push(levelItems(level, at, y, size * (0.9 + rng() * 0.1), rng, profile));
        trees.push({ x: at, y });
        reserved.push({ x: at, y: y - size * 0.5, halfWidth: size * 0.35 * spread[level], halfHeight: size * 0.5 });
      }
      belowX += size * (0.8 + rng() * 1.2 / Math.max(0.2, settings.edgeTrees)) * Math.max(spread.half, spread.pair);
    }
  }

  const marks = placeTreeMarks(input, rng, reserved, profile);
  for (const mark of marks) {
    push(levelItems(mark.level, mark.x, mark.y, size * (0.95 + rng() * 0.1), rng, profile));
    trees.push(mark);
  }
  for (const tree of input.loneTrees ?? []) {
    push(levelItems("full", tree.x, tree.y, size * (0.95 + rng() * 0.1), rng, profile));
    trees.push(tree);
  }

  // A low L4-style line along the bottom of each stand, only where no L1/L2
  // stands on the edge (typically the sloping sides of a patch).
  const standing = marks.filter((mark) => mark.level !== "pair");
  for (const chain of traceStandEdges(washMask, width, height, Math.round(size * 0.8), tolerance, true)) {
    const startX = chain[0].x;
    const edgeY = (x: number) => chain[Math.max(0, Math.min(chain.length - 1, Math.round(x - startX)))].y;
    const covered = new Uint8Array(chain.length);
    for (const mark of standing) {
      if (mark.x < startX - mark.halfWidth || mark.x > startX + chain.length + mark.halfWidth) continue;
      if (Math.abs(mark.y - edgeY(mark.x)) > size * 1.3) continue;
      const from = Math.max(0, Math.floor(mark.x - mark.halfWidth - startX));
      const to = Math.min(chain.length - 1, Math.ceil(mark.x + mark.halfWidth - startX));
      for (let index = from; index <= to; index++) covered[index] = 1;
    }
    let index = 0;
    while (index < chain.length) {
      if (covered[index]) { index++; continue; }
      const from = index;
      while (index < chain.length && !covered[index]) index++;
      if (index - from < size * 0.8) continue;
      const run = buildTopRun((x) => edgeY(x) + size * 0.12, startX + from, startX + index - 1, size, rng, [], 0.35, 0.12, profile.topShape);
      items.push(topRunItem(run, edgeY(startX + from) + size * 0.2, inkUnit, rng));
    }
  }

  // Every patch shows at least one standalone L2/L3: a top line with no
  // tree in the forest just below it gets one at the deepest spot there.
  const depthField = boxBlur(forest, width, height, Math.round(size * 0.8));
  const treeColumns = new Map<number, Point[]>();
  const column = (x: number) => Math.floor(x / (size * 4));
  for (const tree of trees) {
    const bucket = treeColumns.get(column(tree.x));
    if (bucket) bucket.push(tree);
    else treeColumns.set(column(tree.x), [tree]);
  }
  for (const chain of edges) {
    if (chain.length < size * 1.2) continue;
    const startX = chain[0].x;
    const endX = chain[chain.length - 1].x;
    const lineY = (x: number) => chain[Math.max(0, Math.min(chain.length - 1, Math.round(x - startX)))].y;
    let hasTree = false;
    for (let c = column(startX); c <= column(endX) && !hasTree; c++) {
      hasTree = (treeColumns.get(c) ?? []).some((tree) =>
        tree.x >= startX && tree.x <= endX && tree.y >= lineY(tree.x) && tree.y <= lineY(tree.x) + size * 3.5);
    }
    if (hasTree) continue;
    let best: Point | null = null;
    let bestDepth = 0;
    const step = Math.max(2, Math.round(2 * unit));
    for (let x = startX + size * 0.4; x <= endX - size * 0.4; x += step) {
      for (let y = lineY(x) + size * 0.5; y <= lineY(x) + size * 2.5 && y < height; y += step) {
        const index = Math.floor(y) * width + Math.floor(x);
        if (forest[index] > 0.5 && depthField[index] > bestDepth) {
          bestDepth = depthField[index];
          best = { x, y };
        }
      }
    }
    if (best) push(levelItems(rng() < 0.5 ? "half" : "pair", best.x, best.y, size * (0.9 + rng() * 0.1), rng, profile));
  }

  // Stands are split into light clusters, each dark or lit as a whole from
  // its mean hillshade; every tree takes its cluster's tone. Lone trees
  // outside stands take the terrain light at their foot.
  const washLight = input.light ? clusterLight(washMask, input.light, width, height, size, input.seed) : undefined;
  if (input.light && washLight) {
    for (const item of items) {
      const cx = Math.max(0, Math.min(width - 1, Math.round((item.minX + item.maxX) / 2)));
      const cy = Math.max(0, Math.min(height - 1, Math.round((item.minY + item.maxY) / 2)));
      const cluster = washLight[cy * width + cx];
      item.washLight = cluster;
      item.light = cluster !== 0.5
        ? cluster
        : sample(input.light, width, height, cx, item.sortY) < 0.5 - SHADOW_MARGIN ? 0.2 : 0.8;
    }
  }
  items.sort((a, b) => a.sortY - b.sortY);
  return {
    mask: washMask,
    maskWidth: width,
    maskHeight: height,
    shade: washLight,
    treeSize: size,
    inkSize: size / baseProfile.size,
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
    seed: input.seed,
    items,
  };
}

/**
 * Re-express stands in another pixel space (a preview scale or an export
 * tile): output = input * scale - offset. Items outside the view (plus a
 * margin) are dropped; the mask stays shared and is sampled through the
 * combined transform.
 */
export function mapForestStandGeometry(
  stands: ForestStandGeometry,
  scaleX: number,
  scaleY: number,
  offsetX: number,
  offsetY: number,
  viewWidth: number,
  viewHeight: number,
): ForestStandGeometry {
  const margin = stands.treeSize * Math.max(scaleX, scaleY) * 0.5 + 3;
  const mapPoints = (points: Point[]) => points.map((point) => ({ x: point.x * scaleX - offsetX, y: point.y * scaleY - offsetY }));
  const items: ForestStandItem[] = [];
  for (const item of stands.items) {
    const minX = item.minX * scaleX - offsetX;
    const maxX = item.maxX * scaleX - offsetX;
    const minY = item.minY * scaleY - offsetY;
    const maxY = item.maxY * scaleY - offsetY;
    if (maxX < -margin || maxY < -margin || minX > viewWidth + margin || minY > viewHeight + margin) continue;
    items.push({
      sortY: item.sortY * scaleY - offsetY,
      light: item.light,
      washLight: item.washLight,
      minX,
      minY,
      maxX,
      maxY,
      fills: item.fills.map((fill) => ({
        ...fill,
        points: mapPoints(fill.points),
        from: fill.from === undefined ? undefined : fill.style === "lit" ? fill.from * scaleX - offsetX : fill.from * scaleY - offsetY,
        to: fill.to === undefined ? undefined : fill.style === "lit" ? fill.to * scaleX - offsetX : fill.to * scaleY - offsetY,
      })),
      strokes: item.strokes.map((stroke) => {
        const segments = stroke.segments.slice();
        for (let index = 0; index < segments.length; index += 5) {
          segments[index] = segments[index] * scaleX - offsetX;
          segments[index + 1] = segments[index + 1] * scaleY - offsetY;
          segments[index + 2] = segments[index + 2] * scaleX - offsetX;
          segments[index + 3] = segments[index + 3] * scaleY - offsetY;
        }
        return { ...stroke, segments };
      }),
    });
  }
  return {
    ...stands,
    scaleX: stands.scaleX * scaleX,
    scaleY: stands.scaleY * scaleY,
    offsetX: stands.offsetX * scaleX + offsetX,
    offsetY: stands.offsetY * scaleY + offsetY,
    items,
  };
}

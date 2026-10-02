import { SimplexNoise } from "../core/noise";
import {
  boxBlur,
  buildForestStandGeometry,
  clamp01,
  fbm,
  mapForestStandGeometry,
  mulberry,
  SHRUB_STAND_PROFILE,
  smoothStep,
  TREE_STAND_PROFILE,
  type ForestStandGeometry,
} from "./forestStandGeometry";
import { renderForestStandCanvas } from "./forestStandRenderer";

/**
 * /forest-lab: a synthetic alpine slope (ground, form lines, crest lines)
 * with the shared hand-drawn stand renderer on top. The stands are the
 * same code the vegetation pattern layer uses, so tuning here carries over.
 */

export const FOREST_LAB_WIDTH = 960;
export const FOREST_LAB_HEIGHT = 560;

export interface ForestLabSettings {
  seed: number;
  /** Which stand profile to draw: the same code paints both in the map. */
  standKind: "trees" | "shrubs";
  /** Tree height in map pixels. */
  treeSize: number;
  /** Shrub height as a fraction of the tree height (the map uses about 0.36). */
  shrubScale: number;
  /** 0..1: how much of the suitable ground becomes forest. */
  forestCover: number;
  /** Height (0..1) above which forest thins into scattered trees. */
  treeline: number;
  /** How strongly hollows/gullies attract forest and ridges repel it. */
  gullyAffinity: number;
  /** Spacing between treetop marks. */
  standSpacing: number;
  /** Scattered trees on the stand fringe and in meadows. */
  fringeDensity: number;
  inkWeight: number;
  /** Treetop marks along the uphill edge of stands. */
  edgeMarks: number;
  /** Sparse treetop marks inside stands; the wash carries the rest. */
  interiorMarks: number;
  washStrength: number;
  /** 0 = flat wash, 1 = default splotches, 2 = strong colour/value variation. */
  washVariation: number;
  /** 0 = crisp patch edge and splotch edges, 1 = very soft, bleeding wash. */
  washSoftness: number;
  formLineDensity: number;
  /** Strength of the ground hillshade (0 = flat ground). */
  groundShade: number;
  /** How strongly terrain light colours trees and wash. */
  treeLight: number;
  meadowColor: string;
  rockColor: string;
  washColor: string;
  shrubWashColor: string;
  /** Wetland trees among the shrubs: share of plants, body and trunk colours. */
  accentTrees: number;
  accentColor: string;
  trunkColor: string;
  inkColor: string;
}

export const DEFAULT_FOREST_LAB_SETTINGS: ForestLabSettings = {
  seed: 7,
  standKind: "trees",
  treeSize: 13,
  shrubScale: SHRUB_STAND_PROFILE.size,
  forestCover: 0.5,
  treeline: 0.56,
  gullyAffinity: 0.7,
  standSpacing: 0.5,
  fringeDensity: 0.5,
  inkWeight: 0.9,
  edgeMarks: 0.9,
  interiorMarks: 0.08,
  washStrength: 0.85,
  washVariation: 1,
  washSoftness: 0.25,
  formLineDensity: 0.9,
  groundShade: 1,
  treeLight: 0.7,
  meadowColor: "#98a262",
  rockColor: "#a29682",
  washColor: "#435f38",
  shrubWashColor: "#6b7148",
  accentTrees: 0.18,
  accentColor: "#9aab68",
  trunkColor: "#7a5a3c",
  inkColor: "#1d1c15",
};

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Fields {
  width: number;
  height: number;
  height01: Float32Array;
  shade: Float32Array;
  slope: Float32Array;
  /** Downhill direction (unit) per cell. */
  gradX: Float32Array;
  gradY: Float32Array;
  /** Positive in hollows, negative on ridges, roughly -1..1. */
  curvature: Float32Array;
  /** 0..1 forest suitability before thresholding. */
  suitability: Float32Array;
  /** 0..1 soft stand mask. */
  forest: Float32Array;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Synthetic slope rising to the upper left, cut by diagonal gullies and spurs. */
function buildFields(settings: ForestLabSettings): Fields {
  const width = FOREST_LAB_WIDTH;
  const height = FOREST_LAB_HEIGHT;
  const noise = new SimplexNoise(settings.seed);
  const warpNoise = new SimplexNoise(settings.seed + 101);
  const size = width * height;
  const height01 = new Float32Array(size);
  // Downhill runs toward the lower left so the upper-left light rakes
  // across the spurs instead of along them.
  const downX = -0.7;
  const downY = 0.72;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / width;
      const along = (u - 1) * downX + v * downY;
      const across = -u * downY + v * downX;
      const warp = fbm(warpNoise, u * 1.6, v * 1.6, 3) * 0.12;
      const ramp = 1 - along * 1.05;
      const q = (across + warp) * 6;
      const q2 = (across + warp * 1.4 + fbm(warpNoise, u * 4, v * 4, 2) * 0.03) * 15;
      const spur = 1 - Math.abs(2 * (q - Math.floor(q)) - 1);
      const subSpur = 1 - Math.abs(2 * (q2 - Math.floor(q2)) - 1);
      const dissection = 0.3 + 0.7 * clamp01(ramp * 1.3);
      const detail = fbm(noise, u * 6, v * 6, 4);
      const spurStrength = 0.65 + 0.35 * noise.noise2D(u * 2.5 + 40, v * 2.5);
      height01[y * width + x] = ramp * 0.8 +
        (Math.pow(spur, 0.8) * 0.13 * spurStrength + subSpur * 0.02) * dissection + detail * 0.018;
    }
  }

  // Round off the triangle-wave creases so faces blend like eroded slopes.
  height01.set(boxBlur(boxBlur(height01, width, height, 2), width, height, 2));

  const relief = 520;
  const shade = new Float32Array(size);
  const slope = new Float32Array(size);
  const gradX = new Float32Array(size);
  const gradY = new Float32Array(size);
  const lightX = -0.62;
  const lightY = -0.62;
  const lightZ = 0.48;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const dx = (height01[y * width + Math.min(width - 1, x + 1)] -
        height01[y * width + Math.max(0, x - 1)]) * relief * 0.5;
      const dy = (height01[Math.min(height - 1, y + 1) * width + x] -
        height01[Math.max(0, y - 1) * width + x]) * relief * 0.5;
      const length = Math.hypot(dx, dy, 1);
      shade[i] = clamp01((-dx * lightX - dy * lightY + lightZ) / length / 0.95);
      slope[i] = Math.atan(Math.hypot(dx, dy)) * 180 / Math.PI;
      const g = Math.hypot(dx, dy) || 1;
      gradX[i] = -dx / g;
      gradY[i] = -dy / g;
    }
  }

  const smooth = boxBlur(height01, width, height, 7);
  const wide = boxBlur(smooth, width, height, 7);
  const curvature = new Float32Array(size);
  for (let i = 0; i < size; i++) curvature[i] = Math.max(-1, Math.min(1, (wide[i] - smooth[i]) * 140));

  const patchNoise = new SimplexNoise(settings.seed + 202);
  const suitability = new Float32Array(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const u = x / width;
      const v = y / width;
      const edgeJitter = fbm(patchNoise, u * 9, v * 9, 3) * 0.06;
      const belowTreeline = smoothStep(settings.treeline + 0.05, settings.treeline - 0.08,
        height01[i] + edgeJitter);
      const notCliff = 1 - smoothStep(38, 55, slope[i]);
      const hollow = curvature[i] * settings.gullyAffinity;
      const patches = fbm(patchNoise, u * 4.5 + 17, v * 4.5, 4);
      suitability[i] = clamp01(belowTreeline * notCliff * (0.5 + hollow * 0.9 + patches * 0.55));
    }
  }
  const threshold = 1 - settings.forestCover * 0.75;
  const raggedNoise = new SimplexNoise(settings.seed + 303);
  const rawForest = new Float32Array(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const ragged = raggedNoise.noise2D(x / 7, y / 7) * 0.05 + raggedNoise.noise2D(x / 2.5, y / 2.5) * 0.025;
      rawForest[i] = smoothStep(threshold - 0.02, threshold + 0.02, suitability[i] + ragged);
    }
  }
  return {
    width, height, height01, shade, slope, gradX, gradY, curvature, suitability,
    forest: boxBlur(rawForest, width, height, 1),
  };
}

const PALE = [222, 216, 186] as const;
const COOL = [98, 90, 78] as const;

function paintGround(fields: Fields, settings: ForestLabSettings): ImageData {
  const { width, height } = fields;
  const image = new ImageData(width, height);
  const meadow = hexToRgb(settings.meadowColor);
  const rock = hexToRgb(settings.rockColor);
  const snow: [number, number, number] = [214, 208, 190];
  const mottle = new SimplexNoise(settings.seed + 404);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const n = fbm(mottle, x / 90, y / 90, 4);
      const upper = smoothStep(0.25, 0.65, fields.height01[i]);
      const rockMix = clamp01(
        smoothStep(settings.treeline - 0.02, settings.treeline + 0.2, fields.height01[i] + n * 0.1) * 0.85 +
        smoothStep(30, 46, fields.slope[i] + n * 8) * (0.25 + 0.6 * upper) -
        fields.curvature[i] * 0.3,
      );
      const snowMix = smoothStep(0.86, 0.98, fields.height01[i] + n * 0.05);
      // Layered glazes: shade snaps toward a few wash levels with soft but
      // visible boundaries, and pigment pools slightly at each boundary.
      const levels = 4;
      const scaled = fields.shade[i] * levels + n * 0.15;
      const band = Math.floor(scaled);
      const within = scaled - band;
      const glazed = (band + smoothStep(0.42, 0.58, within)) / levels;
      const pool = (1 - Math.abs(within - 0.5) * 2) > 0.85 ? 0.04 : 0;
      const shade = 0.5 + (clamp01(glazed * 0.45 + fields.shade[i] * 0.55 - pool) - 0.5) * settings.groundShade;
      const light = 0.64 + shade * 0.42 + n * 0.06;
      // Watercolor lighting: lit faces go pale and warm, shadowed faces
      // cool grey-brown rather than just darker.
      const highlight = Math.pow(shade, 2.5) * 0.2;
      const cool = Math.pow(1 - shade, 1.6) * 0.3;
      const warm = mottle.noise2D(x / 40 + 9, y / 40) * 8;
      for (let c = 0; c < 3; c++) {
        let value = meadow[c] * (1 - rockMix) + rock[c] * rockMix;
        value = value * (1 - snowMix) + snow[c] * snowMix;
        value = value * light;
        value = value * (1 - highlight) + PALE[c] * highlight;
        value = value * (1 - cool) + COOL[c] * cool;
        value += c === 0 ? warm : c === 2 ? -warm * 0.6 : 0;
        image.data[i * 4 + c] = Math.max(0, Math.min(255, value));
      }
      image.data[i * 4 + 3] = 255;
    }
  }
  return image;
}

/**
 * Evenly spaced streamlines along the contour direction, drawn as broken
 * dashes: denser and darker on steep, shaded ground, sparse on lit slopes.
 */
function drawFormLines(ctx: Ctx, fields: Fields, settings: ForestLabSettings, rng: () => number): void {
  if (settings.formLineDensity <= 0) return;
  const { width, height } = fields;
  const separation = 7 / settings.formLineDensity;
  const cell = separation * 0.5;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const owner = new Int32Array(cols * rows).fill(-1);
  const lines: { x: number; y: number }[][] = [];
  const blocked = (x: number, y: number, id: number): boolean => {
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return true;
    const i = Math.floor(y) * width + Math.floor(x);
    if (fields.forest[i] > 0.35 || fields.slope[i] < 8) return true;
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = gx + ox;
        const cy = gy + oy;
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
        const other = owner[cy * cols + cx];
        if (other >= 0 && other !== id) return true;
      }
    }
    return false;
  };
  const trace = (x: number, y: number, direction: number, id: number) => {
    const points: { x: number; y: number }[] = [];
    let px = x;
    let py = y;
    for (let step = 0; step < 90; step++) {
      const i = Math.floor(py) * width + Math.floor(px);
      px += -fields.gradY[i] * direction * 1.3;
      py += fields.gradX[i] * direction * 1.3;
      if (blocked(px, py, id)) break;
      points.push({ x: px, y: py });
    }
    return points;
  };
  const seeds = Math.round(width * height / (separation * separation) * 1.5);
  for (let seed = 0; seed < seeds; seed++) {
    const x = rng() * width;
    const y = rng() * height;
    const id = lines.length;
    if (blocked(x, y, id)) continue;
    const line = [...trace(x, y, -1, id).reverse(), { x, y }, ...trace(x, y, 1, id)];
    if (line.length < 8) continue;
    for (const point of line) owner[Math.floor(point.y / cell) * cols + Math.floor(point.x / cell)] = id;
    lines.push(line);
  }

  ctx.save();
  ctx.strokeStyle = settings.inkColor;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const line of lines) {
    // Each line gets its own hand: a slow wobble across the stroke and a
    // dash style, some lines broken into dotted runs like stippled scree.
    const dotted = rng() < 0.3;
    const wobbleFreq = 0.08 + rng() * 0.12;
    const wobblePhase = rng() * Math.PI * 2;
    const wobbleAmp = 0.3 + rng() * 0.7;
    const offset = (k: number) => {
      const a = line[Math.max(0, k - 1)];
      const b = line[Math.min(line.length - 1, k + 1)];
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const w = Math.sin(k * wobbleFreq + wobblePhase) * wobbleAmp;
      return { x: line[k].x - (b.y - a.y) / length * w, y: line[k].y + (b.x - a.x) / length * w };
    };
    let index = 0;
    while (index < line.length - 1) {
      const point = line[index];
      const i = Math.floor(point.y) * width + Math.floor(point.x);
      const steep = smoothStep(10, 40, fields.slope[i]);
      const dark = 1 - fields.shade[i];
      const rocky = smoothStep(0.35, 0.7, fields.height01[i]) * steep;
      const dash = dotted ? 0 : 2 + Math.floor(rng() * (3 + steep * 10));
      const gap = dotted ? 1 + Math.floor(rng() * 2) : 1 + Math.floor(rng() * (1 + (1 - dark) * 4));
      if (rng() < 0.05 + steep * 0.25 + dark * 0.6 + rocky * 0.4) {
        ctx.globalAlpha = Math.min(1, 0.35 + 0.5 * dark + rocky * 0.2) * (0.7 + rng() * 0.3);
        ctx.lineWidth = 0.3 + settings.inkWeight * (0.25 + dark * 0.6 + rocky * 0.3) * (0.6 + rng() * 0.8);
        ctx.beginPath();
        const start = offset(index);
        ctx.moveTo(start.x, start.y);
        const end = Math.min(line.length - 1, index + Math.max(1, dash));
        if (dash === 0) {
          ctx.lineTo(start.x + 0.2, start.y + 0.1);
        } else {
          for (let k = index + 1; k <= end; k++) {
            const next = offset(k);
            ctx.lineTo(next.x, next.y);
          }
        }
        ctx.stroke();
      }
      index += Math.max(1, dash) + gap;
    }
  }
  ctx.restore();
}

/**
 * Ink lines down the spur crests: the strongest marks in the hand-drawn terrain look.
 * Seeds sit on convex ground and follow the downhill direction while the
 * ground stays convex.
 */
function drawCrestLines(ctx: Ctx, fields: Fields, settings: ForestLabSettings, rng: () => number): void {
  const { width, height } = fields;
  const cell = 5;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const taken = new Uint8Array(cols * rows);
  // Normalize by the strongest convex ground so thresholds hold for any relief.
  const convex = Array.from(fields.curvature, (value) => -value).filter((value) => value > 0).sort((a, b) => a - b);
  const crestScale = convex[Math.floor(convex.length * 0.97)] || 1;
  const crestAt = (x: number, y: number): number => {
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return 0;
    const i = Math.floor(y) * width + Math.floor(x);
    if (fields.forest[i] > 0.4) return 0;
    return -fields.curvature[i] / crestScale;
  };
  const trace = (x: number, y: number, direction: number) => {
    const points: { x: number; y: number }[] = [];
    let px = x;
    let py = y;
    for (let step = 0; step < 160; step++) {
      const i = Math.floor(py) * width + Math.floor(px);
      px += fields.gradX[i] * direction * 1.2;
      py += fields.gradY[i] * direction * 1.2;
      if (crestAt(px, py) < 0.35) break;
      if (taken[Math.floor(py / cell) * cols + Math.floor(px / cell)]) break;
      points.push({ x: px, y: py });
    }
    return points;
  };
  ctx.save();
  ctx.strokeStyle = settings.inkColor;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let attempt = 0; attempt < 5000; attempt++) {
    const x = rng() * width;
    const y = rng() * height;
    if (crestAt(x, y) < 0.7) continue;
    if (taken[Math.floor(y / cell) * cols + Math.floor(x / cell)]) continue;
    const line = [...trace(x, y, -1).reverse(), { x, y }, ...trace(x, y, 1)];
    if (line.length < 14) continue;
    for (const point of line) {
      const gx = Math.floor(point.x / cell);
      const gy = Math.floor(point.y / cell);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const cx = gx + ox;
        const cy = gy + oy;
        if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) taken[cy * cols + cx] = 1;
      }
    }
    // Broken pen runs with pressure varying along the crest.
    let index = 0;
    while (index < line.length - 1) {
      const run = 4 + Math.floor(rng() * 16);
      const end = Math.min(line.length - 1, index + run);
      ctx.globalAlpha = 0.6 + rng() * 0.3;
      ctx.lineWidth = 0.35 + settings.inkWeight * (0.5 + rng() * 0.6);
      ctx.beginPath();
      ctx.moveTo(line[index].x, line[index].y);
      for (let k = index + 1; k <= end; k++) {
        ctx.lineTo(line[k].x + (rng() - 0.5) * 0.4, line[k].y + (rng() - 0.5) * 0.4);
      }
      ctx.stroke();
      index = end + 1 + Math.floor(rng() * 4);
    }
  }
  ctx.restore();
}

function buildPaperGrain(pixelWidth: number, pixelHeight: number, seed: number): Float32Array {
  const grain = new Float32Array(pixelWidth * pixelHeight);
  const rng = mulberry(seed ^ 0x9e3779b9);
  const noise = new SimplexNoise(seed + 707);
  for (let y = 0; y < pixelHeight; y++) {
    for (let x = 0; x < pixelWidth; x++) {
      grain[y * pixelWidth + x] = (rng() - 0.5) * 10 + noise.noise2D(x / 3.5, y / 3.5) * 6;
    }
  }
  return grain;
}

function paintPaperGrain(ctx: Ctx, pixelWidth: number, pixelHeight: number, grain: Float32Array): void {
  const image = ctx.getImageData(0, 0, pixelWidth, pixelHeight);
  for (let pixel = 0; pixel < grain.length; pixel++) {
    const i = pixel * 4;
    image.data[i] += grain[pixel];
    image.data[i + 1] += grain[pixel];
    image.data[i + 2] += grain[pixel] * 0.9;
  }
  ctx.putImageData(image, 0, 0);
}

// Keep only the current inputs per preview; releasing the canvas releases its caches.
interface LabCache {
  fieldsKey?: string;
  fields?: Fields;
  standsKey?: string;
  stands?: ForestStandGeometry;
  mappedKey?: string;
  mapped?: ForestStandGeometry;
  groundKey?: string;
  ground?: OffscreenCanvas;
  grainKey?: string;
  grain?: Float32Array;
}
const labCaches = new WeakMap<HTMLCanvasElement, LabCache>();

function imageDataCanvas(image: ImageData): OffscreenCanvas {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext("2d")!.putImageData(image, 0, 0);
  return canvas;
}

/** Render the lab scene at `scale` device pixels per map pixel. */
export function renderForestLab(canvas: HTMLCanvasElement, settings: ForestLabSettings, scale: number): void {
  let cache = labCaches.get(canvas);
  if (!cache) {
    cache = {};
    labCaches.set(canvas, cache);
  }
  const fieldsKey = JSON.stringify([settings.seed, settings.treeline, settings.gullyAffinity, settings.forestCover]);
  if (!cache.fields || cache.fieldsKey !== fieldsKey) {
    cache.fields = buildFields(settings);
    cache.fieldsKey = fieldsKey;
  }
  const fields = cache.fields;
  canvas.width = Math.round(FOREST_LAB_WIDTH * scale);
  canvas.height = Math.round(FOREST_LAB_HEIGHT * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const groundKey = JSON.stringify([fieldsKey, scale, settings.meadowColor, settings.rockColor,
    settings.groundShade, settings.formLineDensity, settings.inkColor, settings.inkWeight]);
  if (!cache.ground || cache.groundKey !== groundKey) {
    const ground = new OffscreenCanvas(canvas.width, canvas.height);
    const groundCtx = ground.getContext("2d")!;
    const rng = mulberry(settings.seed);
    groundCtx.imageSmoothingEnabled = true;
    groundCtx.imageSmoothingQuality = "high";
    groundCtx.setTransform(scale, 0, 0, scale, 0, 0);
    groundCtx.drawImage(imageDataCanvas(paintGround(fields, settings)), 0, 0);
    drawFormLines(groundCtx, fields, settings, rng);
    drawCrestLines(groundCtx, fields, settings, rng);
    cache.ground = ground;
    cache.groundKey = groundKey;
  }
  ctx.drawImage(cache.ground, 0, 0);
  const shrubs = settings.standKind === "shrubs";
  const standsKey = JSON.stringify([fieldsKey, settings.standKind, shrubs ? settings.shrubScale : 1, settings.treeSize, settings.standSpacing,
    settings.edgeMarks, settings.interiorMarks, settings.fringeDensity, settings.accentTrees]);
  if (!cache.stands || cache.standsKey !== standsKey) {
    cache.stands = buildForestStandGeometry({
      width: fields.width,
      height: fields.height,
      forest: fields.forest,
      treeSize: settings.treeSize * (shrubs ? settings.shrubScale : 1),
      seed: settings.seed,
      settings: {
        markSpacing: settings.standSpacing,
        edgeTrees: settings.edgeMarks,
        interiorTrees: settings.interiorMarks,
        meadowTrees: settings.fringeDensity,
        accentTrees: settings.accentTrees,
      },
      suitability: fields.suitability,
      slope: fields.slope,
      light: fields.shade,
      profile: shrubs ? SHRUB_STAND_PROFILE : TREE_STAND_PROFILE,
    });
    cache.standsKey = standsKey;
  }
  const mappedKey = JSON.stringify([standsKey, scale]);
  if (!cache.mapped || cache.mappedKey !== mappedKey) {
    cache.mapped = mapForestStandGeometry(cache.stands, scale, scale, 0, 0, canvas.width, canvas.height);
    cache.mappedKey = mappedKey;
  }
  const forestLayer = renderForestStandCanvas(
    canvas.width,
    canvas.height,
    cache.mapped,
    {
      washColor: shrubs ? settings.shrubWashColor : settings.washColor,
      washStrength: settings.washStrength,
      washVariation: settings.washVariation,
      washSoftness: settings.washSoftness,
      inkColor: settings.inkColor,
      inkWeight: settings.inkWeight,
      lightStrength: settings.treeLight,
      accentColor: settings.accentColor,
      trunkColor: settings.trunkColor,
    },
  );
  if (forestLayer) ctx.drawImage(forestLayer, 0, 0);
  const grainKey = JSON.stringify([settings.seed, canvas.width, canvas.height]);
  if (!cache.grain || cache.grainKey !== grainKey) {
    cache.grain = buildPaperGrain(canvas.width, canvas.height, settings.seed);
    cache.grainKey = grainKey;
  }
  paintPaperGrain(ctx, canvas.width, canvas.height, cache.grain);
}

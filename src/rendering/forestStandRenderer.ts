import { SimplexNoise } from "../core/noise";
import type { MountainProfiler } from "./mountainProfiler";
import {
  FOREST_STAND_REFERENCE_TREE_SIZE,
  boxBlur,
  clamp01,
  fbm,
  smoothStep,
  type ForestStandGeometry,
  type Point,
} from "./forestStandGeometry";

/** Paint-only stand settings: changing these never moves a tree. */
export interface ForestStandPaint {
  washColor: string;
  washStrength: number;
  /** 0 = flat wash, 1 = default splotches, 2 = strong colour/value variation. */
  washVariation: number;
  /** 0 = crisp patch and splotch edges, 1 = very soft, bleeding wash. */
  washSoftness: number;
  inkColor: string;
  inkWeight: number;
  /** Body and trunk colours of accent plants (e.g. trees among shrubs). */
  accentColor?: string;
  trunkColor?: string;
  /** How strongly terrain light colours trees and wash (the "Terrain shade on props" control, default 0.7). */
  lightStrength: number;
}

/** Two tones only: sunlit side (brightness 1) or shadow side (darker). */
function isShadowed(light: number): boolean {
  return light < 0.5;
}

function lightTone(light: number, strength: number): number {
  return isShadowed(light) ? 1 - 0.28 * strength / 0.7 : 1;
}


function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Stand wash for mask cells [x0, x1) × [y0, y1) as RGBA. Noise is sampled in
 * mask coordinates (scaled by tree size), so neighbouring tiles agree and
 * splotches keep their size relative to the trees at any resolution.
 */
export function forestStandWashCells(
  stands: ForestStandGeometry,
  paint: ForestStandPaint,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  /** Colour every cell at full opacity (the tree fill), not just the stand. */
  opaque = false,
  /** Optional wash output alongside the opaque fill, sharing the noise evaluation. */
  washCells?: Uint8ClampedArray<ArrayBuffer>,
): Uint8ClampedArray<ArrayBuffer> {
  const { maskWidth, maskHeight } = stands;
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const out = new Uint8ClampedArray(width * height * 4);
  if (width === 0 || height === 0) return out;
  const unit = stands.treeSize / FOREST_STAND_REFERENCE_TREE_SIZE;
  // Softness beyond the default blurs the patch edge further; the alpha
  // ramp widens with it, so low values give a crisper edge.
  const extraBlur = Math.round(Math.max(0, paint.washSoftness - 0.25) * 12 * unit);
  const mx0 = Math.max(0, x0 - extraBlur);
  const my0 = Math.max(0, y0 - extraBlur);
  const mx1 = Math.min(maskWidth, x1 + extraBlur);
  const my1 = Math.min(maskHeight, y1 + extraBlur);
  const mw = mx1 - mx0;
  const mh = my1 - my0;
  let local: Float32Array = new Float32Array(Math.max(0, mw * mh));
  for (let y = 0; y < mh; y++) {
    local.set(stands.mask.subarray((my0 + y) * maskWidth + mx0, (my0 + y) * maskWidth + mx1), y * mw);
  }
  if (extraBlur > 0 && mw > 0 && mh > 0) local = boxBlur(local, mw, mh, extraBlur);
  const edgeSpan = 0.1 + paint.washSoftness * 1.6;
  const edgeFrom = Math.max(0, 0.5 - edgeSpan);
  const edgeTo = Math.min(1, 0.5 + edgeSpan * 0.6);
  // Splotch edges: the default 0.25 gives the original crisp blooms.
  const bloomEdge = 0.05 + paint.washSoftness * 0.4;
  const variation = paint.washVariation;
  const wash = hexToRgb(paint.washColor);
  const warm: [number, number, number] = [wash[0] * 1.25, wash[1] * 1.12, wash[2] * 0.85];
  const mottle = new SimplexNoise(stands.seed + 505);
  const blooms = new SimplexNoise(stands.seed + 515);
  for (let y = y0; y < y1; y++) {
    if (y < 0 || y >= maskHeight) continue;
    for (let x = x0; x < x1; x++) {
      if (x < 0 || x >= maskWidth) continue;
      const m = local[(y - my0) * mw + (x - mx0)];
      if (m <= 0.002 && !opaque) continue;
      const nx = x / unit;
      const ny = y / unit;
      // Splotchy watercolor: fine mottle, plus larger blooms with fairly
      // crisp edges that shift value and lean some patches warmer.
      const n = fbm(mottle, nx / 14, ny / 14, 4);
      const bloom = blooms.noise2D(nx / 38, ny / 38) + blooms.noise2D(nx / 11 + 50, ny / 11) * 0.35;
      const dark = smoothStep(0.1, 0.1 + bloomEdge, bloom) * 0.22 * variation;
      const pale = smoothStep(-0.2, -0.2 - bloomEdge, bloom) * 0.2 * variation;
      const warmMix = Math.min(1, smoothStep(0.2, 0.2 + bloomEdge * 2, blooms.noise2D(nx / 60 + 90, ny / 60)) * 0.5 * variation);
      const shade = stands.shade?.[y * maskWidth + x] ?? 0.5;
      // Cluster tone scales the whole wash value, exactly as it scales the trees.
      const light = lightTone(shade, paint.lightStrength) * (0.93 + n * 0.2 * variation - dark + pale);
      const offset = ((y - y0) * width + (x - x0)) * 4;
      for (let c = 0; c < 3; c++) {
        const base = wash[c] * (1 - warmMix) + warm[c] * warmMix;
        out[offset + c] = base * light;
      }
      // Near-opaque inside the patch at the default strength, so the
      // shaded ground underneath never reads through the wash.
      // Even opacity across the interior (only the edge ramps), so a tree
      // filled at the interior opacity matches the wash exactly.
      out[offset + 3] = opaque ? 255 : 255 * clamp01(smoothStep(edgeFrom, edgeTo, m) * paint.washStrength * 1.15);
      if (washCells && m > 0.002) {
        washCells[offset] = out[offset];
        washCells[offset + 1] = out[offset + 1];
        washCells[offset + 2] = out[offset + 2];
        washCells[offset + 3] = 255 * clamp01(smoothStep(edgeFrom, edgeTo, m) * paint.washStrength * 1.15);
      }
    }
  }
  return out;
}

type Ctx = OffscreenCanvasRenderingContext2D;

// One current tile/paint per mask. Ink edits reuse the wash, and old geometry
// can be collected without retaining full-map textures in a global cache.
const washCache = new WeakMap<Float32Array, {
  key: string;
  shade: Float32Array | undefined;
  wash: OffscreenCanvas;
  fill: OffscreenCanvas;
}>();

function tracePolygon(ctx: Ctx, points: Point[]): void {
  ctx.beginPath();
  points.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
  ctx.closePath();
}

/**
 * Paint stands to a canvas. Canvas callers can composite it directly without
 * reading every pixel back to JavaScript and uploading it again.
 */
export function renderForestStandCanvas(
  width: number,
  height: number,
  stands: ForestStandGeometry,
  paint: ForestStandPaint,
  profiler?: MountainProfiler,
): OffscreenCanvas | null {
  if (width <= 0 || height <= 0 || typeof OffscreenCanvas === "undefined") return null;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const washStop = profiler?.begin("vegetation forest stand wash texture");

  // Wash: computed per mask cell for the cells under this output, then
  // drawn scaled with smoothing (as the lab upsamples it).
  const { scaleX, scaleY, offsetX, offsetY } = stands;
  const gx0 = Math.max(0, Math.floor(offsetX / scaleX) - 2);
  const gy0 = Math.max(0, Math.floor(offsetY / scaleY) - 2);
  const gx1 = Math.min(stands.maskWidth, Math.ceil((width + offsetX) / scaleX) + 3);
  const gy1 = Math.min(stands.maskHeight, Math.ceil((height + offsetY) / scaleY) + 3);
  // Tree fills use the wash colour (an opaque copy of the wash) at the
  // wash's interior opacity, so inside a stand a tree is pixel-identical to
  // the wash around it, and tops above the stand edge look the same.
  let solidPattern: CanvasPattern | null = null;
  if (gx1 > gx0 && gy1 > gy0) {
    const key = JSON.stringify([gx0, gy0, gx1, gy1, stands.maskWidth, stands.maskHeight,
      stands.seed, stands.treeSize, paint.washColor, paint.washStrength,
      paint.washVariation, paint.washSoftness, paint.lightStrength]);
    let cached = washCache.get(stands.mask);
    if (!cached || cached.key !== key || cached.shade !== stands.shade) {
      const cellWidth = gx1 - gx0;
      const cellHeight = gy1 - gy0;
      const washCells = new Uint8ClampedArray(cellWidth * cellHeight * 4);
      const fillCells = forestStandWashCells(stands, paint, gx0, gy0, gx1, gy1, true, washCells);
      const wash = new OffscreenCanvas(cellWidth, cellHeight);
      const fill = new OffscreenCanvas(cellWidth, cellHeight);
      // The output is read back on the CPU. Keep its pattern sources on the
      // CPU too, otherwise each tree can trigger a GPU texture readback.
      wash.getContext("2d", { willReadFrequently: true })!.putImageData(new ImageData(washCells, cellWidth, cellHeight), 0, 0);
      fill.getContext("2d", { willReadFrequently: true })!.putImageData(new ImageData(fillCells, cellWidth, cellHeight), 0, 0);
      cached = { key, shade: stands.shade, wash, fill };
      washCache.set(stands.mask, cached);
    }
    const transform = new DOMMatrix([scaleX, 0, 0, scaleY, gx0 * scaleX - offsetX, gy0 * scaleY - offsetY]);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.save();
    ctx.setTransform(transform);
    ctx.drawImage(cached.wash, 0, 0);
    ctx.restore();
    solidPattern = ctx.createPattern(cached.fill, "no-repeat");
    solidPattern?.setTransform(transform);
  }
  const fillAlpha = clamp01(paint.washStrength * 1.15);
  washStop?.();
  const treesStop = profiler?.begin("vegetation forest stand tree painting");

  const inkPx = (0.35 + 0.65 * paint.inkWeight) * stands.inkSize / FOREST_STAND_REFERENCE_TREE_SIZE * scaleX;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = paint.inkColor;
  for (const item of stands.items) {
    if (item.maxX < -inkPx * 3 || item.maxY < -inkPx * 3 || item.minX > width + inkPx * 3 || item.minY > height + inkPx * 3) continue;
    // A lone tree away from every stand is darkened by the same factor a
    // dark cluster applies to its wash.
    const loneShade = item.washLight === 0.5 ? 1 - lightTone(item.light, paint.lightStrength) : 0;
    for (const fill of item.fills) {
      if (fill.style === "accent" || fill.style === "trunk") {
        // Own colours, so accent trees stand out from the stand; darkened on
        // the shadow side like everything else in their cluster.
        tracePolygon(ctx, fill.points);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "#000";
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = fillAlpha;
        ctx.fillStyle = (fill.style === "trunk" ? paint.trunkColor : paint.accentColor) ?? paint.washColor;
        ctx.fill();
        const shade = 1 - lightTone(item.light, paint.lightStrength);
        if (shade > 0) {
          ctx.globalCompositeOperation = "source-atop";
          ctx.globalAlpha = shade;
          ctx.fillStyle = "#000";
          ctx.fill();
          ctx.globalCompositeOperation = "source-over";
        }
        continue;
      }
      if (fill.style === "ground") {
        ctx.globalAlpha = fill.alpha;
        ctx.fillStyle = paint.inkColor;
        tracePolygon(ctx, fill.points);
        ctx.fill();
        continue;
      }
      tracePolygon(ctx, fill.points);
      // Replace (not blend) what is under the tree, so its pixels equal the
      // wash's: the wash colour at the wash's interior opacity.
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "#000";
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = fillAlpha;
      ctx.fillStyle = solidPattern ?? "rgba(0, 0, 0, 0)";
      ctx.fill();
      if (loneShade > 0) {
        // Darken colour only (not opacity).
        ctx.globalCompositeOperation = "source-atop";
        ctx.globalAlpha = loneShade;
        ctx.fillStyle = "#000";
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
    }
    for (const stroke of item.strokes) {
      ctx.globalAlpha = stroke.alpha;
      const segments = stroke.segments;
      for (let index = 0; index < segments.length; index += 5) {
        ctx.lineWidth = segments[index + 4] * inkPx;
        ctx.beginPath();
        ctx.moveTo(segments[index], segments[index + 1]);
        ctx.lineTo(segments[index + 2], segments[index + 3]);
        ctx.stroke();
      }
    }
  }
  treesStop?.();
  return canvas;
}

/** RGBA adapter for the main map's pixel compositing pipeline. */
export function renderForestStandLayer(
  width: number,
  height: number,
  stands: ForestStandGeometry,
  paint: ForestStandPaint,
  profiler?: MountainProfiler,
): Uint8ClampedArray<ArrayBuffer> | null {
  const canvas = renderForestStandCanvas(width, height, stands, paint, profiler);
  const readbackStop = profiler?.begin("vegetation forest stand readback");
  const pixels = canvas?.getContext("2d")?.getImageData(0, 0, width, height).data ?? null;
  readbackStop?.();
  return pixels;
}

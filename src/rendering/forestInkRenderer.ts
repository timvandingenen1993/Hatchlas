import { charcoalStrokePressureAt, createCharcoalStrokeRuns, hash01 } from "./cartographicStrokeRenderer";
import { mulberry, type ForestStandGeometry, type Point } from "./forestStandGeometry";
import { forestStandWashCells, type ForestStandPaint } from "./forestStandRenderer";
import {
  INK_WASH_TREE_SIZE_PER_MARK,
  inkMarkOutline,
  inkMarkPen,
  type ForestInkGeometry,
  type ForestInkMark,
  type ForestInkPens,
} from "./forestInkStands";

/**
 * A mark's pen with the chosen weight for its kind of tree, keeping the
 * mark's own small variation around the default weight.
 */
export function inkMarkThickness(mark: ForestInkMark, pens: Partial<ForestInkPens> = {}): number {
  const base = inkMarkPen(mark);
  return base > 0 ? mark.pen / base * inkMarkPen(mark, pens) : mark.pen;
}

/** Paint-only ink stand settings. */
export interface ForestInkPaint {
  inkColor: string;
  inkWeight: number;
  /** Optional watercolour wash under the stands and inside every crown (on coloured ground). */
  washColor?: string;
  /**
   * Optional wash colour per place, blended across biome borders. The wash
   * keeps its splotches and light tones, shifted from `washColor` to the
   * local colour.
   */
  washField?: ForestInkWashField;
  /**
   * Wash strength: how far the wash and crowns shift from the ground below
   * toward the wash colour. 0 leaves the marks on bare ground, as on paper.
   */
  washAlpha?: number;
  /** 0 = flat wash, 1 = default splotches, 2 = strong colour and value variation. */
  washVariation?: number;
  /** 0 = crisp stand edge and splotches, 1 = very soft, bleeding wash. */
  washSoftness?: number;
  /** How strongly terrain light darkens the wash of shaded patches. */
  lightStrength?: number;
  /** 0..1: dry charcoal grain in the ink and pressure tapering toward each stroke's ends. */
  charcoal?: number;
  /** 0..1: how often a stroke breaks where the pen skipped (more inside stands). */
  interruptions?: number;
  /** Line weight per kind of tree (defaults: DEFAULT_FOREST_INK_PENS). */
  thickness?: Partial<ForestInkPens>;
}

/** Wash colours on a coarse grid in the geometry's map pixels. */
export interface ForestInkWashField {
  /** Cell size in map pixels; cell (column, row) is centred at ((column + 0.5) · step, (row + 0.5) · step). */
  step: number;
  columns: number;
  rows: number;
  /** RGB per cell; NaN where the field has no colour (no plants nearby). */
  rgb: Float32Array;
  /** Identifies the colours, for the wash cache. */
  key: string;
}

/**
 * Shift wash cells (x0, y0 in map pixels, `width` cells per row) from the
 * `base` colour to the field's colour at each cell, keeping their variation.
 */
function shiftWashCells(cells: Uint8ClampedArray, width: number, x0: number, y0: number, base: readonly number[], field: ForestInkWashField): void {
  const { step, columns, rows, rgb } = field;
  const height = cells.length / 4 / width;
  const target = [0, 0, 0];
  let weight = 0;
  const corner = (cell: number, w: number) => {
    if (w <= 0 || Number.isNaN(rgb[cell * 3])) return;
    weight += w;
    target[0] += rgb[cell * 3] * w;
    target[1] += rgb[cell * 3 + 1] * w;
    target[2] += rgb[cell * 3 + 2] * w;
  };
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, Math.min(rows - 1, (y0 + y + 0.5) / step - 0.5));
    const r0 = Math.floor(fy);
    const r1 = Math.min(rows - 1, r0 + 1);
    const ty = fy - r0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, Math.min(columns - 1, (x0 + x + 0.5) / step - 0.5));
      const c0 = Math.floor(fx);
      const c1 = Math.min(columns - 1, c0 + 1);
      const tx = fx - c0;
      // Bilinear over the corners that have a colour.
      weight = 0;
      target[0] = target[1] = target[2] = 0;
      corner(r0 * columns + c0, (1 - tx) * (1 - ty));
      corner(r0 * columns + c1, tx * (1 - ty));
      corner(r1 * columns + c0, (1 - tx) * ty);
      corner(r1 * columns + c1, tx * ty);
      if (weight <= 1e-6) continue;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        cells[offset + channel] += target[channel] / weight - base[channel];
      }
    }
  }
}

function washBaseRgb(hex: string): [number, number, number] | null {
  const match = hex.trim().match(/^#([0-9a-f]{6})$/i);
  return match ? [0, 2, 4].map((index) => Number.parseInt(match[1].slice(index, index + 2), 16)) as [number, number, number] : null;
}

/** Outline pen width as a share of the mark size (a 0.1 mm pen on marks about 2 mm wide). */
const PEN_WIDTH = 0.2;

/**
 * Trees drawn narrower than this many output pixels are too small to show
 * charcoal tapering, pen skips or a finely curved outline: they get a
 * coarser outline and are drawn in batches (see renderForestInkCanvas).
 */
const DETAIL_MIN_MARK_PX = 6;

type Ctx = OffscreenCanvasRenderingContext2D;
type PathTarget = Ctx | Path2D;

/** A mark's stroke as flat x, y pairs, with the distance along it at every point. */
interface MarkLine {
  points: Float32Array;
  lengths: Float32Array;
  closed: boolean;
}

/**
 * Stroke lines per mark and detail level. Marks are shared by every mapped
 * view of a geometry (preview, export tiles), so each line is built once
 * and paint edits only redraw.
 */
const detailedLines = new WeakMap<ForestInkMark, MarkLine>();
const simpleLines = new WeakMap<ForestInkMark, MarkLine>();

/**
 * The mark's stroke as a dense polyline: quadratic curves between the
 * midpoints of the outline points, broken at every corner (tips and valleys
 * stay sharp). A closed stroke ends back on its first point.
 */
function markLine(mark: ForestInkMark, detailed: boolean): MarkLine {
  const cache = detailed ? detailedLines : simpleLines;
  const cached = cache.get(mark);
  if (cached) return cached;
  const { points, corners, closed } = detailed
    ? inkMarkOutline(mark)
    : inkMarkOutline(mark, mark.forest === "deciduous" ? 6 : 10);
  const samples = detailed ? 3 : 1;
  const flat: number[] = [points[0].x, points[0].y];
  const breaks = [...new Set([0, ...corners.filter((index) => index > 0 && index < points.length - 1), points.length - 1])].sort((a, b) => a - b);
  for (let piece = 0; piece < breaks.length - 1; piece++) {
    const from = breaks[piece];
    const to = breaks[piece + 1];
    let start: Point = points[from];
    for (let index = from + 1; index < to; index++) {
      const control = points[index];
      const next = points[index + 1];
      const end = index + 1 === to ? next : { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 };
      for (let step = 1; step <= samples; step++) {
        const t = step / samples;
        const u = 1 - t;
        flat.push(u * u * start.x + 2 * u * t * control.x + t * t * end.x, u * u * start.y + 2 * u * t * control.y + t * t * end.y);
      }
      start = end;
    }
    if (to === from + 1) flat.push(points[to].x, points[to].y);
  }
  if (closed) flat.push(flat[0], flat[1]);
  const line = { points: Float32Array.from(flat), lengths: new Float32Array(flat.length / 2), closed };
  for (let index = 1; index < line.lengths.length; index++) {
    line.lengths[index] = line.lengths[index - 1] +
      Math.hypot(flat[index * 2] - flat[index * 2 - 2], flat[index * 2 + 1] - flat[index * 2 - 1]);
  }
  cache.set(mark, line);
  return line;
}

/** Add the line to a path (or a context's current path) as one subpath. */
function traceLine(target: PathTarget, line: MarkLine, close: boolean): void {
  const { points } = line;
  target.moveTo(points[0], points[1]);
  for (let index = 2; index < points.length; index += 2) target.lineTo(points[index], points[index + 1]);
  if (close) target.closePath();
}

/** Stroke the part of the line between two distances along it. */
function strokeSpan(ctx: Ctx, line: MarkLine, from: number, to: number, width: number): void {
  const { points, lengths } = line;
  const at = (distance: number, index: number) => {
    const span = lengths[index] - lengths[index - 1] || 1;
    const f = (distance - lengths[index - 1]) / span;
    return [points[index * 2 - 2] + (points[index * 2] - points[index * 2 - 2]) * f,
      points[index * 2 - 1] + (points[index * 2 + 1] - points[index * 2 - 1]) * f];
  };
  let index = 1;
  while (index < lengths.length - 1 && lengths[index] < from) index++;
  ctx.lineWidth = width;
  ctx.beginPath();
  const [x0, y0] = at(from, index);
  ctx.moveTo(x0, y0);
  while (index < lengths.length - 1 && lengths[index] < to) {
    ctx.lineTo(points[index * 2], points[index * 2 + 1]);
    index++;
  }
  const [x1, y1] = at(Math.min(to, lengths[lengths.length - 1]), index);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Where a run's tapered ends are split: three steps of width at each end. */
const TAPER_STEPS = [0, 0.067, 0.133, 0.2, 0.8, 0.867, 0.933, 1];

/**
 * Ink one mark like a charcoal-dipped pen: the stroke breaks where the pen
 * skipped (seeded runs, as for the other charcoal marks), and each run
 * thins toward ends that border a gap or the stroke's own ends, in three
 * steps of width per end.
 */
function strokeCharcoal(ctx: Ctx, mark: ForestInkMark, line: MarkLine, width: number, charcoal: number, breakProbability: number, size: number): void {
  const total = line.lengths[line.lengths.length - 1];
  if (total <= 0) return;
  let runs = createCharcoalStrokeRuns(total, mark.shape | 0, 1, {
    breakProbability,
    dashMin: size * 0.45,
    dashMax: size * 1.5,
    gapMin: size * 0.1,
    gapMax: size * 0.26,
  });
  // A mark the gaps would nearly erase keeps its line.
  if (runs.reduce((sum, run) => sum + run.end - run.start, 0) < total * 0.5) runs = [{ start: 0, end: total }];
  for (const [runIndex, run] of runs.entries()) {
    ctx.globalAlpha = 0.84 + hash01(mark.shape | 0, 401 + runIndex) * 0.16;
    const span = run.end - run.start;
    if (charcoal <= 0) {
      strokeSpan(ctx, line, run.start, run.end, width);
      continue;
    }
    for (let step = 0; step < TAPER_STEPS.length - 1; step++) {
      const from = run.start + span * TAPER_STEPS[step];
      const to = run.start + span * TAPER_STEPS[step + 1];
      const pressure = charcoalStrokePressureAt((TAPER_STEPS[step] + TAPER_STEPS[step + 1]) / 2);
      // The middle (step 3) is the full-width body.
      strokeSpan(ctx, line, from, to, step === 3 ? width : width * (1 - charcoal * 0.55 * (1 - pressure)));
    }
  }
  ctx.globalAlpha = 1;
}

/** A tile of speckles; cut out of the ink it leaves the dry, broken edge of charcoal. */
let grainTile: OffscreenCanvas | null = null;

function charcoalGrain(): OffscreenCanvas {
  if (grainTile) return grainTile;
  const size = 128;
  const rng = mulberry(0x6c8e9cf5);
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < size * size; index++) {
    // Mostly light tooth, with the odd bare fleck.
    const tooth = rng() ** 2.4;
    const fleck = rng() < 0.035 ? 0.9 : 0;
    pixels[index * 4 + 3] = Math.min(1, tooth * 0.75 + fleck) * 255;
  }
  grainTile = new OffscreenCanvas(size, size);
  grainTile.getContext("2d")!.putImageData(new ImageData(pixels, size, size), 0, 0);
  return grainTile;
}

interface StandWash {
  key: string;
  /** Wash and opaque fill textures in mask cells, from (gx0, gy0). */
  wash: OffscreenCanvas;
  fill: OffscreenCanvas;
  gx0: number;
  gy0: number;
}

/** One current wash per mask: ink-only edits reuse it. */
const standWashes = new WeakMap<Float32Array, StandWash>();

/**
 * The hand-drawn stands' watercolour wash for the cells under the view:
 * splotches, soft or crisp edges and two light tones, from the shared stand
 * wash painter.
 */
function standWash(geometry: ForestInkGeometry, paint: ForestInkPaint, width: number, height: number): StandWash | null {
  const { scaleX, scaleY, offsetX, offsetY, maskWidth, maskHeight } = geometry;
  const gx0 = Math.max(0, Math.floor(offsetX / scaleX) - 2);
  const gy0 = Math.max(0, Math.floor(offsetY / scaleY) - 2);
  const gx1 = Math.min(maskWidth, Math.ceil((width + offsetX) / scaleX) + 3);
  const gy1 = Math.min(maskHeight, Math.ceil((height + offsetY) / scaleY) + 3);
  if (gx1 <= gx0 || gy1 <= gy0) return null;
  const treeSize = geometry.markSize * INK_WASH_TREE_SIZE_PER_MARK;
  const standPaint: ForestStandPaint = {
    washColor: paint.washColor!,
    washStrength: paint.washAlpha ?? 0,
    washVariation: paint.washVariation ?? 0,
    washSoftness: paint.washSoftness ?? 0.25,
    lightStrength: paint.lightStrength ?? 0,
    inkColor: paint.inkColor,
    inkWeight: paint.inkWeight,
  };
  const key = JSON.stringify([gx0, gy0, gx1, gy1, maskWidth, maskHeight, geometry.seed, treeSize,
    standPaint.washColor, standPaint.washStrength, standPaint.washVariation, standPaint.washSoftness, standPaint.lightStrength,
    paint.washField?.key ?? null]);
  const cached = standWashes.get(geometry.mask);
  if (cached && cached.key === key) return cached;
  // The painter reads only the mask, light clusters, seed and tree size.
  const stands = {
    mask: geometry.mask, maskWidth, maskHeight, shade: geometry.shade, treeSize, inkSize: treeSize,
    scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, seed: geometry.seed, items: [],
  } satisfies ForestStandGeometry;
  const cellWidth = gx1 - gx0;
  const cellHeight = gy1 - gy0;
  const washCells = new Uint8ClampedArray(cellWidth * cellHeight * 4);
  const fillCells = forestStandWashCells(stands, standPaint, gx0, gy0, gx1, gy1, true, washCells);
  const base = paint.washField ? washBaseRgb(standPaint.washColor) : null;
  if (paint.washField && base) {
    shiftWashCells(washCells, cellWidth, gx0, gy0, base, paint.washField);
    shiftWashCells(fillCells, cellWidth, gx0, gy0, base, paint.washField);
  }
  const wash = new OffscreenCanvas(cellWidth, cellHeight);
  const fill = new OffscreenCanvas(cellWidth, cellHeight);
  wash.getContext("2d", { willReadFrequently: true })!.putImageData(new ImageData(washCells, cellWidth, cellHeight), 0, 0);
  fill.getContext("2d", { willReadFrequently: true })!.putImageData(new ImageData(fillCells, cellWidth, cellHeight), 0, 0);
  const result = { key, wash, fill, gx0, gy0 };
  standWashes.set(geometry.mask, result);
  return result;
}

/** Scratch ink and wash canvases, reused across stands and renders of one size. */
let scratch: { width: number; height: number; ink: Ctx; tint: Ctx } | null = null;

function scratchContexts(width: number, height: number): { ink: Ctx; tint: Ctx } | null {
  if (!scratch || scratch.width !== width || scratch.height !== height) {
    const ink = new OffscreenCanvas(width, height).getContext("2d");
    const tint = new OffscreenCanvas(width, height).getContext("2d");
    if (!ink || !tint) return null;
    scratch = { width, height, ink, tint };
  }
  for (const ctx of [scratch.ink, scratch.tint]) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, width, height);
  }
  return scratch;
}

/**
 * Draw ink stands back to front. Every cap and oval first clears what lies
 * under it, so a crown in front hides the ones behind as on paper; the
 * layer stays transparent there and shows the ground, or the optional wash
 * under the stands and crowns.
 *
 * Trees large enough on screen are drawn one by one with charcoal tapering
 * and pen skips. Smaller ones (DETAIL_MIN_MARK_PX) get a coarser outline and
 * are drawn in thin horizontal bands: each band's bodies are cleared in one
 * fill and its lines stroked once per line width. Within a band a tree in
 * front does not hide a neighbour's line, which is invisible at that size.
 *
 * With `target`, the stand is drawn onto it (several stands share one
 * canvas and one readback); otherwise onto a new canvas. The geometry's own
 * mapping places it (see mapForestInkGeometry).
 *
 * With `cover`, every crown body is also filled onto it, opaque: the map
 * shows its ground colours without linework there, under the crown's wash,
 * so the wash strength mixes the ground into the crowns rather than letting
 * contours and other lines show through them.
 */
export function renderForestInkCanvas(
  width: number,
  height: number,
  geometry: ForestInkGeometry,
  paint: ForestInkPaint,
  target?: Ctx,
  cover?: Ctx,
): OffscreenCanvas | null {
  if (width <= 0 || height <= 0 || typeof OffscreenCanvas === "undefined") return null;
  const contexts = scratchContexts(width, height);
  if (!contexts) return null;
  const { ink: ctx } = contexts;
  const { scaleX, scaleY, offsetX, offsetY } = geometry;
  ctx.setTransform(scaleX, 0, 0, scaleY, -offsetX, -offsetY);
  if (cover) {
    cover.save();
    cover.setTransform(scaleX, 0, 0, scaleY, -offsetX, -offsetY);
    cover.globalAlpha = 1;
    cover.globalCompositeOperation = "source-over";
    cover.fillStyle = "#000";
  }
  const washAlpha = paint.washColor ? Math.max(0, Math.min(1, paint.washAlpha ?? 0)) : 0;
  // The wash goes on its own canvas under the ink. Each crown replaces the
  // wash under it with the opaque wash colour at the wash's interior
  // strength, so a crown matches the wash around it and tops above the
  // stand edge look the same.
  const washTexture = washAlpha > 0 ? standWash(geometry, paint, width, height) : null;
  const tint = washTexture ? contexts.tint : null;
  let crownFill: CanvasPattern | null = null;
  const crownAlpha = Math.min(1, washAlpha * 1.15);
  if (tint && washTexture) {
    tint.setTransform(scaleX, 0, 0, scaleY, -offsetX, -offsetY);
    tint.imageSmoothingEnabled = true;
    tint.imageSmoothingQuality = "high";
    tint.drawImage(washTexture.wash, washTexture.gx0, washTexture.gy0);
    crownFill = tint.createPattern(washTexture.fill, "no-repeat");
    crownFill?.setTransform(new DOMMatrix([1, 0, 0, 1, washTexture.gx0, washTexture.gy0]));
  }
  const clearBodies = (bodies: Path2D | null) => {
    if (tint && crownFill) {
      tint.globalAlpha = 1;
      tint.globalCompositeOperation = "destination-out";
      if (bodies) tint.fill(bodies);
      else tint.fill();
      tint.globalCompositeOperation = "source-over";
      tint.globalAlpha = crownAlpha;
      tint.fillStyle = crownFill;
      if (bodies) tint.fill(bodies);
      else tint.fill();
    }
    if (cover) {
      if (bodies) cover.fill(bodies);
      else cover.fill();
    }
    ctx.globalCompositeOperation = "destination-out";
    if (bodies) ctx.fill(bodies);
    else ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  };
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = paint.inkColor;
  ctx.fillStyle = "#000";
  const pen = geometry.markSize * PEN_WIDTH * paint.inkWeight;
  const charcoal = Math.max(0, Math.min(1, paint.charcoal ?? 0));
  const interruptions = Math.max(0, Math.min(1, paint.interruptions ?? 0));
  const scale = Math.min(scaleX, scaleY);
  const detailed = geometry.markSize * scale >= DETAIL_MIN_MARK_PX;
  // At least a hairline in output pixels, so the fine pen never vanishes.
  const minimum = 0.6 / scale;
  const margin = geometry.markSize * 4;
  const left = offsetX / scaleX - margin;
  const top = offsetY / scaleY - margin;
  const right = (offsetX + width) / scaleX + margin;
  const bottom = (offsetY + height) / scaleY + margin;

  // Small trees: one band of bodies and per-width line paths at a time.
  const bandHeight = geometry.markSize * 0.6;
  let bandBottom = -Infinity;
  let bodies = new Path2D();
  let lines = new Map<number, Path2D>();
  // Line widths in steps of a tenth of an output pixel share a path.
  const widthStep = 0.1 / scale;
  const flushBand = () => {
    clearBodies(bodies);
    for (const [step, path] of lines) {
      ctx.lineWidth = step * widthStep;
      ctx.stroke(path);
    }
    bodies = new Path2D();
    lines = new Map();
  };

  for (const mark of geometry.marks) {
    if (mark.x < left || mark.x > right || mark.y < top || mark.y > bottom) continue;
    const lineWidth = Math.max(minimum, pen * inkMarkThickness(mark, paint.thickness));
    if (!detailed) {
      if (mark.y > bandBottom) {
        flushBand();
        bandBottom = mark.y + bandHeight;
      }
      const step = Math.max(1, Math.round(lineWidth / widthStep));
      let path = lines.get(step);
      if (!path) {
        path = new Path2D();
        lines.set(step, path);
      }
      if (mark.kind === "dot") {
        path.moveTo(mark.x - mark.width / 2, mark.y);
        path.lineTo(mark.x + mark.width / 2, mark.y);
        continue;
      }
      const line = markLine(mark, false);
      traceLine(bodies, line, true);
      traceLine(path, line, false);
      continue;
    }
    ctx.lineWidth = lineWidth;
    if (mark.kind === "dot") {
      ctx.beginPath();
      ctx.moveTo(mark.x - mark.width / 2, mark.y);
      ctx.lineTo(mark.x + mark.width / 2, mark.y);
      ctx.stroke();
      continue;
    }
    const line = markLine(mark, true);
    // The body (closed over the stroke's ends) hides what lies behind.
    if (tint) tint.beginPath();
    if (cover) cover.beginPath();
    ctx.beginPath();
    traceLine(ctx, line, true);
    if (tint) traceLine(tint, line, true);
    if (cover) traceLine(cover, line, true);
    clearBodies(null);
    // The fine pen inside stands skips often, the outline pen less, and the
    // bold front chain hardly at all.
    const breaks = interruptions * (mark.role === "fill" ? 1.5 * (1 - mark.edge) + 0.7 * mark.edge : mark.role === "front" ? 0.25 : 0.7);
    strokeCharcoal(ctx, mark, line, lineWidth, charcoal, breaks, geometry.markSize);
  }
  if (!detailed) flushBand();
  cover?.restore();
  if (charcoal > 0) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = charcoal * 0.35;
    ctx.fillStyle = ctx.createPattern(charcoalGrain(), "repeat")!;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
  const output = target ?? new OffscreenCanvas(width, height).getContext("2d");
  if (!output) return null;
  output.save();
  output.setTransform(1, 0, 0, 1, 0, 0);
  output.globalAlpha = 1;
  output.globalCompositeOperation = "source-over";
  if (tint) output.drawImage(tint.canvas, 0, 0);
  output.drawImage(ctx.canvas, 0, 0);
  output.restore();
  return output.canvas as OffscreenCanvas;
}

/** What the stand builder started from, kept for the stand debug view. */
export interface ForestInkStandDebug {
  /** x, y and lone (1) or in a stand (0) per placed plant, in map pixels. */
  plants: Float32Array;
  /** Stand area the placed plants form, before rounding (edge at 0.5). */
  area: Float32Array;
  /** One line describing the stand. */
  label: string;
}

/** Cells at or above 0.5 in one grey, the rest transparent. */
function maskImage(mask: Float32Array, width: number, height: number, grey: number): OffscreenCanvas {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] < 0.5) continue;
    pixels[index * 4] = grey;
    pixels[index * 4 + 1] = grey;
    pixels[index * 4 + 2] = grey;
    pixels[index * 4 + 3] = 255;
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas;
}

/**
 * Stand debug view in black and white: light grey is the stand area the
 * placed plants form, darker grey the area left after rounding (the stand
 * the ink is drawn on), black dots plants in a stand, hollow circles lone
 * plants. `row` places the stand's summary line; `background` paints white
 * under everything (give it to the stand drawn underneath the others).
 */
export function renderForestInkDebugCanvas(
  width: number,
  height: number,
  geometry: ForestInkGeometry,
  debug: ForestInkStandDebug,
  row: number,
  background: boolean,
): OffscreenCanvas | null {
  if (width <= 0 || height <= 0 || typeof OffscreenCanvas === "undefined") return null;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (background) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  const { scaleX, scaleY, offsetX, offsetY, maskWidth, maskHeight } = geometry;
  ctx.setTransform(scaleX, 0, 0, scaleY, -offsetX, -offsetY);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(maskImage(debug.area, maskWidth, maskHeight, 214), 0, 0);
  ctx.drawImage(maskImage(geometry.mask, maskWidth, maskHeight, 140), 0, 0);
  const radius = geometry.markSize * 0.3;
  ctx.fillStyle = "#000000";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = radius * 0.45;
  for (let index = 0; index < debug.plants.length; index += 3) {
    ctx.beginPath();
    ctx.arc(debug.plants[index], debug.plants[index + 1] - radius, radius, 0, Math.PI * 2);
    if (debug.plants[index + 2] > 0) ctx.stroke();
    else ctx.fill();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const lineHeight = Math.max(14, Math.round(Math.min(width, height) / 80));
  ctx.font = `${lineHeight - 2}px sans-serif`;
  const y = 8 + row * (lineHeight + 4);
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.fillRect(6, y - 2, ctx.measureText(debug.label).width + 8, lineHeight + 4);
  ctx.fillStyle = "#000000";
  ctx.textBaseline = "top";
  ctx.fillText(debug.label, 10, y);
  return canvas;
}

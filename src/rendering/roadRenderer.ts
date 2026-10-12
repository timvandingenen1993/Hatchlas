/**
 * Rasterizes user roads into a map-space layer for the final composite.
 *
 * Roads arrive as smoothed polylines in normalized map coordinates. A point
 * maps to the raster through the global texture domain, so preview frames and
 * every export tile place the same road on the same output pixels. Widths are
 * authored against a 2048px long edge and scale with the domain.
 *
 * The layer holds coverage passes, composited in this order:
 * - clear: corridor where trees and shrubs are removed (not drawn itself)
 * - shadow: soft drop shadow beneath the road
 * - outline: optional casing beneath the road
 * - ink: road lines
 * - fill: bridge decks
 * - bridgeOutline: bridge edges and side sections, in their own colour
 *
 * Every road kind uses the same pen. Per-type settings control its width,
 * color, casing, dashes and shadow. Dashes are measured in global pixels,
 * so export tiles agree on where every stroke starts and ends.
 */
import {
  paintInkSegment,
  type CharcoalStrokeRun,
} from "./cartographicStrokeRenderer";
import {
  DEFAULT_ROAD_STYLE,
  roadKindStyle,
  type MapPoint,
  type RoadRenderPath,
  type RoadStyle,
} from "../structures/types";

export const ROAD_REFERENCE_LONG_EDGE = 2048;

type RGB = readonly [number, number, number];

export interface RoadAccentLayer {
  alpha: Uint8Array;
  colorIndex: Uint8Array;
  colors: RGB[];
}

export interface RoadLayer {
  clear: Uint8Array | null;
  outline: Uint8Array | null;
  ink: Uint8Array;
  fill: Uint8Array;
  /** Bridge outlines (side sections and their edges), drawn above the deck in `bridgeOutlineColor`. */
  bridgeOutline: Uint8Array | null;
  bridgeOutlineColor: RGB;
  /** Index into `inkColors` of the road that last painted ink at each pixel. */
  inkColorIndex: Uint8Array;
  inkColors: RGB[];
  outlineColorIndex: Uint8Array | null;
  outlineColors: RGB[];
  shadow: RoadAccentLayer | null;
  bridgeColor: RGB;
  opacity: number;
}

export interface RoadRasterTarget {
  width: number;
  height: number;
  /** Global pixel origin of this raster inside the full domain. */
  offsetX: number;
  offsetY: number;
  domainWidth: number;
  domainHeight: number;
}

export function parseRoadColor(color: string | undefined, fallback: RGB): RGB {
  const match = color?.match(/^#([0-9a-f]{6})$/i);
  if (!match) return fallback;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

type Segment = (x0: number, y0: number, x1: number, y1: number) => void;
/** A clipped piece of a stroke; t0/t1 give its position within the stroke. */
type StrokePiece = (x0: number, y0: number, x1: number, y1: number, t0: number, t1: number) => void;

interface Polyline {
  points: readonly { x: number; y: number }[];
  cumulative: number[];
  length: number;
}

function measurePolyline(points: readonly { x: number; y: number }[]): Polyline {
  const cumulative = [0];
  for (let index = 1; index < points.length; index++) {
    cumulative.push(cumulative[index - 1] + Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    ));
  }
  return { points, cumulative, length: cumulative[cumulative.length - 1] ?? 0 };
}

function pointAtDistance(line: Polyline, distance: number): { x: number; y: number } {
  const { points, cumulative } = line;
  let index = 1;
  while (index < points.length - 1 && cumulative[index] < distance) index++;
  const a = points[index - 1];
  const b = points[index];
  const span = cumulative[index] - cumulative[index - 1];
  const t = span > 1e-9 ? Math.max(0, Math.min(1, (distance - cumulative[index - 1]) / span)) : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Calls `paint` for the parts of each polyline segment inside [start, end]. */
function strokeRange(line: Polyline, start: number, end: number, paint: StrokePiece): void {
  const { points, cumulative } = line;
  const range = Math.max(1e-9, end - start);
  for (let index = 1; index < points.length; index++) {
    const d0 = Math.max(start, cumulative[index - 1]);
    const d1 = Math.min(end, cumulative[index]);
    if (d1 <= d0) continue;
    const a = pointAtDistance(line, d0);
    const b = pointAtDistance(line, d1);
    paint(a.x, a.y, b.x, b.y, (d0 - start) / range, (d1 - start) / range);
  }
}

/** Periodic on/off intervals along a line of `length`. */
function periodicRuns(length: number, on: number, off: number): CharcoalStrokeRun[] {
  const runs: CharcoalStrokeRun[] = [];
  for (let start = 0; start < length; start += on + off) runs.push({ start, end: Math.min(length, start + on) });
  return runs;
}

/** A dash's square end planes: a point and the unit direction of travel at each end. */
interface DashEnds {
  start: { x: number; y: number; tx: number; ty: number };
  end: { x: number; y: number; tx: number; ty: number };
}

/** Distance past the dash's nearer end plane; negative inside the dash. */
function dashOvershoot(ends: DashEnds, x: number, y: number): number {
  return Math.max(
    -((x - ends.start.x) * ends.start.tx + (y - ends.start.y) * ends.start.ty),
    (x - ends.end.x) * ends.end.tx + (y - ends.end.y) * ends.end.ty,
  );
}

/**
 * Crisp solid stroke with exact edge coverage, so the road line and dashes are
 * sharp but not jagged. Coverage is measured at each pixel centre, which keeps a
 * dash exactly as long as it is set (a pixel-centre in/out test is up to a whole
 * pixel off) and stays a pure function of global coordinates for export tiles.
 * Overlapping strokes keep the strongest value.
 */
function paintCleanSegment(
  alpha: Uint8Array, tags: Uint8Array | undefined, width: number, height: number,
  x0: number, y0: number, x1: number, y1: number,
  radius: number, opacity: number, paletteIndex: number, ends?: DashEnds,
): void {
  const reach = radius + 1;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - reach));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + reach));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - reach));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + reach));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const along = lengthSquared > 1e-9
        ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lengthSquared))
        : 0;
      const perpendicular = Math.hypot(x - (x0 + dx * along), y - (y0 + dy * along));
      let coverage = Math.max(0, Math.min(1, 0.5 - (perpendicular - radius)));
      if (coverage <= 0) continue;
      if (ends) coverage *= Math.max(0, Math.min(1, 0.5 - dashOvershoot(ends, x, y)));
      const value = Math.round(coverage * opacity * 255);
      const index = y * width + x;
      if (value > alpha[index]) {
        alpha[index] = value;
        if (tags) tags[index] = paletteIndex;
      }
    }
  }
}

/**
 * Soft-edged capsule for drop shadows: solid inside `radius - blur`, fading out
 * by `radius + blur`. Coverage is a pure function of the pixel's distance to the
 * segment, so export tiles agree. Overlaps keep the strongest value, which stops
 * shadows doubling up where strokes join.
 */
function paintSoftSegment(
  layer: RoadAccentLayer, width: number, height: number,
  x0: number, y0: number, x1: number, y1: number,
  radius: number, blur: number, opacity: number, paletteIndex: number,
  ends?: DashEnds,
): void {
  const reach = radius + blur;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - reach));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + reach));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - reach));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + reach));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const along = lengthSquared > 1e-9
        ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lengthSquared))
        : 0;
      const perpendicular = Math.hypot(x - (x0 + dx * along), y - (y0 + dy * along));
      // Signed distance to the stroke edge: negative inside. Past a dash's flat
      // end planes the edge is square, so the shadow fades there instead of rounding off.
      let distance = perpendicular - radius;
      if (ends) {
        const overshoot = dashOvershoot(ends, x, y);
        if (overshoot > 0) distance = Math.hypot(Math.max(distance, 0), overshoot);
      }
      // Half a pixel of feathering keeps a zero blur from aliasing.
      const t = Math.max(0, Math.min(1, (blur - distance) / (2 * Math.max(blur, 0.5))));
      const alpha = Math.round(t * t * (3 - 2 * t) * opacity * 255);
      const index = y * width + x;
      if (alpha > layer.alpha[index]) {
        layer.alpha[index] = alpha;
        layer.colorIndex[index] = paletteIndex;
      }
    }
  }
}

function strokePolyline(points: readonly { x: number; y: number }[], paint: Segment): void {
  for (let index = 0; index + 1 < points.length; index++) {
    paint(points[index].x, points[index].y, points[index + 1].x, points[index + 1].y);
  }
}

export function rasterizeRoadLayer(
  roads: readonly RoadRenderPath[],
  target: RoadRasterTarget,
  style: RoadStyle = DEFAULT_ROAD_STYLE,
): RoadLayer | null {
  if (roads.length === 0) return null;
  const { width, height, offsetX, offsetY, domainWidth, domainHeight } = target;
  const total = width * height;
  const ink = new Uint8Array(total);
  const fill = new Uint8Array(total);
  const bridgeOutline = roads.some((road) => road.bridges.some((span) => !span.ford)) ? new Uint8Array(total) : null;
  const settings = roads.map((road) => roadKindStyle(style, road.kind));
  const outline = settings.some((value) => value.outline && value.outlineWidth > 0) ? new Uint8Array(total) : null;
  const clear = style.clearance > 0 ? new Uint8Array(total) : null;
  const inkColorIndex = new Uint8Array(total);
  const outlineColorIndex = outline ? new Uint8Array(total) : null;
  const outlineColors: RGB[] = [];
  const accentLayer = (): RoadAccentLayer => ({ alpha: new Uint8Array(total), colorIndex: new Uint8Array(total), colors: [] });
  const shadow = settings.some((value) => value.shadowOpacity > 0) ? accentLayer() : null;
  const clip = new Uint8Array(total).fill(1);
  const defaultInk = parseRoadColor(style.color, [86, 58, 38]);
  const inkColors: RGB[] = [];
  const scale = Math.max(domainWidth, domainHeight) / ROAD_REFERENCE_LONG_EDGE;
  const toLocal = (point: MapPoint) => ({
    x: point.u * (domainWidth - 1) - offsetX,
    y: point.v * (domainHeight - 1) - offsetY,
  });
  let painted = false;

  roads.forEach((road, roadIndex) => {
    if (road.points.length < 2) return;
    const kindStyle = settings[roadIndex];
    const inkRadius = Math.max(0.1, kindStyle.width / 2) * scale;
    const hasOutline = kindStyle.outline && kindStyle.outlineWidth > 0;
    const outlineRadius = inkRadius + kindStyle.outlineWidth * scale;
    const clearRadius = (hasOutline ? outlineRadius : inkRadius) + style.clearance * scale;
    const shadowReach = kindStyle.shadowOpacity > 0 ? (kindStyle.shadowOffset * Math.SQRT2 + kindStyle.shadowBlur) * scale : 0;
    const margin = clearRadius * 2 + shadowReach + 12 * scale;
    const local = road.points.map(toLocal);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of local) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
    if (maxX < -margin || maxY < -margin || minX > width + margin || minY > height + margin) return;
    const paletteIndex = inkColors.length < 255 ? inkColors.push(parseRoadColor(kindStyle.color, defaultInk)) - 1 : 0;
    outlineColors[paletteIndex] = parseRoadColor(kindStyle.outlineColor, [244, 236, 214]);
    if (shadow) shadow.colors[paletteIndex] = parseRoadColor(kindStyle.shadowColor, [40, 28, 20]);
    const seed = 7919 * (roadIndex + 1);
    // Flat caps cut a stroke square at its ends, for crisp dash boundaries.
    const paint = (alpha: Uint8Array, radius: number, solid: boolean, opacity = 1, tags?: Uint8Array,
      flatStart = false, flatEnd = false): Segment => (x0, y0, x1, y1) => {
      paintInkSegment(
        alpha, clip, width, height, x0, y0, x1, y1, radius, seed, 2, 0.5, 0.5, false, false,
        offsetX, offsetY, domainWidth, opacity, solid ? 0 : 0.02, flatStart, flatEnd, solid, undefined, undefined, 0, tags, paletteIndex,
      );
    };
    // Set while a dash is being drawn so its shadow ends square like the dash.
    let dashEnds: DashEnds | undefined;
    // Drop shadow: the stroke's footprint pushed down-right and softened.
    const paintShadow = (radius: number, opacity: number, x0: number, y0: number, x1: number, y1: number) => {
      const strength = kindStyle.shadowOpacity * opacity;
      if (!shadow || strength <= 0) return;
      const shift = kindStyle.shadowOffset * scale;
      const ends = dashEnds && {
        start: { ...dashEnds.start, x: dashEnds.start.x + shift, y: dashEnds.start.y + shift },
        end: { ...dashEnds.end, x: dashEnds.end.x + shift, y: dashEnds.end.y + shift },
      };
      paintSoftSegment(shadow, width, height, x0 + shift, y0 + shift, x1 + shift, y1 + shift,
        radius + (hasOutline ? kindStyle.outlineWidth * scale : 0), kindStyle.shadowBlur * scale, strength, paletteIndex, ends);
    };
    // The outline is the only charcoal-textured part; lines, dashes and rails stay clean.
    const paintOutline = (radius: number, flatStart = false, flatEnd = false): Segment => (x0, y0, x1, y1) => {
      if (!outline || !outlineColorIndex || !hasOutline) return;
      paint(outline, radius, !style.handDrawn, 1, outlineColorIndex, flatStart, flatEnd)(x0, y0, x1, y1);
    };
    const paintInk = (radius: number, opacity = 1, flatStart = false, flatEnd = false): Segment => (x0, y0, x1, y1) => {
      paintOutline(radius + kindStyle.outlineWidth * scale, flatStart, flatEnd)(x0, y0, x1, y1);
      paintCleanSegment(ink, inkColorIndex, width, height, x0, y0, x1, y1, radius, opacity, paletteIndex, dashEnds);
      paintShadow(radius, opacity, x0, y0, x1, y1);
      painted = true;
    };

    // The cleared corridor follows the whole road, bridges included.
    if (clear) strokePolyline(local, paint(clear, clearRadius, true));

    // Split the road into land runs and crossing spans.
    const spans = [...road.bridges].sort((a, b) => a.from - b.from);
    const landRuns: { x: number; y: number }[][] = [];
    let cursor = 0;
    for (const span of spans) {
      if (span.from > cursor) landRuns.push(local.slice(cursor, span.from + 1));
      cursor = Math.max(cursor, span.to);
    }
    if (cursor < local.length - 1) landRuns.push(local.slice(cursor));

    const drawLane = (points: readonly { x: number; y: number }[], radius: number) => {
      const line = measurePolyline(points);
      if (line.length <= 1e-6) return;
      // Zero spacing is a continuous line.
      if (kindStyle.dashSpacing <= 0) {
        strokePolyline(points, paintInk(radius));
        return;
      }
      // Clean sections, square-cut at both ends so length and gap read as set.
      // Every piece is flat-ended: round caps at the joins inside a dash would
      // bulge past its ends whenever the dash is shorter than the line is wide.
      // Interior joins overlap by a hair so bends leave no seam.
      const dashLength = kindStyle.dashLength * scale;
      const overlap = 0.75 * scale;
      for (const stroke of periodicRuns(line.length, dashLength, kindStyle.dashSpacing * scale)) {
        // A sliver left over at the end of the road reads as an artifact.
        if (stroke.end - stroke.start < dashLength * 0.35) continue;
        const endPlane = (at: number, toward: number) => {
          const point = pointAtDistance(line, at);
          const ahead = pointAtDistance(line, toward);
          const span = Math.hypot(ahead.x - point.x, ahead.y - point.y) || 1;
          return { x: point.x, y: point.y, tx: (ahead.x - point.x) / span, ty: (ahead.y - point.y) / span };
        };
        const probe = Math.min(stroke.end - stroke.start, Math.max(0.5, radius * 0.5));
        dashEnds = {
          start: endPlane(stroke.start, stroke.start + probe),
          end: endPlane(stroke.end, stroke.end - probe),
        };
        // The end plane's normal points outward, away from the dash.
        dashEnds.end.tx = -dashEnds.end.tx;
        dashEnds.end.ty = -dashEnds.end.ty;
        strokeRange(line, stroke.start, stroke.end, (x0, y0, x1, y1, t0, t1) => {
          const length = Math.hypot(x1 - x0, y1 - y0);
          const ux = length > 1e-9 ? (x1 - x0) / length : 0;
          const uy = length > 1e-9 ? (y1 - y0) / length : 0;
          const back = t0 > 0 ? overlap : 0;
          const forward = t1 < 1 ? overlap : 0;
          paintInk(radius, 1, true, true)(x0 - ux * back, y0 - uy * back, x1 + ux * forward, y1 + uy * forward);
        });
      }
      dashEnds = undefined;
    };

    for (const run of landRuns) {
      if (run.length >= 2) drawLane(run, inkRadius);
    }

    for (const span of spans) {
      const a = local[span.from];
      const b = local[span.to];
      if (!a || !b) continue;
      if (span.ford) {
        // Fords: the road continues as a faint broken line through the water.
        const ford = measurePolyline([a, b]);
        for (const stroke of periodicRuns(ford.length, inkRadius * 1.5, inkRadius * 1.5)) {
          strokeRange(ford, stroke.start, stroke.end, (x0, y0, x1, y1) => paintInk(inkRadius * 0.8, 0.7)(x0, y0, x1, y1));
        }
        continue;
      }
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length <= 1e-6) continue;
      const tx = (b.x - a.x) / length;
      const ty = (b.y - a.y) / length;
      const nx = -ty;
      const ny = tx;
      const railRadius = Math.max(0.1, style.bridgeOutlineWidth / 2) * scale;
      // The bridge only spans the water, with no overhang onto the banks. The
      // main deck matches the road's width so the road flows onto it, with a
      // narrow outlined section, a quarter of the road width, along each side.
      const mainHalf = inkRadius;
      const stripWidth = Math.max(0.3 * scale, kindStyle.width / 4 * scale);
      const outerHalf = mainHalf + stripWidth;
      const casing = kindStyle.outlineWidth * scale;
      // Points are `along` the bridge from its start and `across` from its centreline.
      const at = (along: number, across: number) => ({
        x: a.x + tx * along + nx * across, y: a.y + ty * along + ny * across,
      });
      const flatEnds = (from: { x: number; y: number }, to: { x: number; y: number }): DashEnds => ({
        start: { x: from.x, y: from.y, tx, ty },
        end: { x: to.x, y: to.y, tx, ty },
      });
      // Deck fill hides the water beneath; the outline layer draws above it.
      const fillBand = (centre: number, half: number) => {
        const from = at(0, centre);
        const to = at(length, centre);
        paintCleanSegment(fill, undefined, width, height, from.x, from.y, to.x, to.y, half, 1, paletteIndex, flatEnds(from, to));
      };
      const line = (along0: number, across0: number, along1: number, across1: number) => {
        const from = at(along0, across0);
        const to = at(along1, across1);
        paintCleanSegment(bridgeOutline!, undefined, width, height, from.x, from.y, to.x, to.y, railRadius, 1, paletteIndex);
      };

      const head = at(0, 0);
      const tail = at(length, 0);
      paintOutline(outerHalf + railRadius + casing, true, true)(head.x, head.y, tail.x, tail.y);
      dashEnds = flatEnds(head, tail);
      paintShadow(outerHalf + railRadius, 1, head.x, head.y, tail.x, tail.y);
      dashEnds = undefined;

      fillBand(0, mainHalf);
      for (const side of [-1, 1]) {
        fillBand(side * (mainHalf + outerHalf) / 2, stripWidth / 2);
        // Each side section is a closed outlined box; the main deck stays open at both ends.
        line(0, side * outerHalf, length, side * outerHalf);
        line(0, side * mainHalf, length, side * mainHalf);
        line(0, side * mainHalf, 0, side * outerHalf);
        line(length, side * mainHalf, length, side * outerHalf);
      }
      painted = true;
    }
  });

  if (!painted) return null;
  return {
    clear,
    outline,
    ink,
    fill,
    bridgeOutline,
    bridgeOutlineColor: parseRoadColor(style.bridgeOutlineColor, [86, 58, 38]),
    inkColorIndex,
    inkColors,
    outlineColorIndex,
    outlineColors,
    shadow,
    bridgeColor: parseRoadColor(style.bridgeColor, [238, 226, 196]),
    opacity: Math.max(0, Math.min(1, style.opacity)),
  };
}

/** Share of a pixel that roads keep clear of props (trees, shrubs, boulders). */
export function roadPropClearanceAt(layer: RoadLayer, index: number): number {
  return Math.max(
    layer.clear?.[index] ?? 0,
    layer.outline?.[index] ?? 0,
    layer.ink[index],
    layer.fill[index],
    layer.bridgeOutline?.[index] ?? 0,
  ) / 255;
}

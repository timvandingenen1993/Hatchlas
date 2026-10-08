/**
 * Rasterizes user roads into a map-space layer for the final composite.
 *
 * Roads arrive as smoothed polylines in normalized map coordinates. A point
 * maps to the raster through the global texture domain, so preview frames and
 * every export tile place the same road on the same output pixels. Widths are
 * authored against a 2048px long edge and scale with the domain.
 *
 * The layer holds four coverage passes, composited in this order:
 * - clear: corridor where trees and shrubs are removed (not drawn itself)
 * - outline: optional casing beneath the road
 * - ink: road lines and bridge rails
 * - fill: centre of double-line roads and bridge decks
 *
 * Hand-drawn roads use the map's charcoal pen: each road is split into
 * seeded strokes (the same schedule as rivers and forest outlines), every
 * stroke tapers through the brush pressure curve, and some gaps carry a
 * single ink dot. Breaks are measured along the full road in global pixels,
 * so export tiles agree on where every stroke starts and ends.
 */
import {
  createCharcoalStrokeRuns,
  hash01,
  paintInkDisk,
  paintInkSegment,
  type CharcoalStrokeRun,
} from "./cartographicStrokeRenderer";
import {
  DEFAULT_ROAD_STYLE,
  type MapPoint,
  type RoadKind,
  type RoadLineStyle,
  type RoadRenderPath,
  type RoadStyle,
} from "../structures/types";

export const ROAD_REFERENCE_LONG_EDGE = 2048;

type RGB = readonly [number, number, number];

export interface RoadLayer {
  clear: Uint8Array | null;
  outline: Uint8Array | null;
  ink: Uint8Array;
  fill: Uint8Array;
  /** Index into `inkColors` of the road that last painted ink at each pixel. */
  inkColorIndex: Uint8Array;
  inkColors: RGB[];
  /** 1 where the fill belongs to a bridge deck, 0 for a road centre. */
  fillIsBridge: Uint8Array;
  outlineColor: RGB;
  fillColor: RGB;
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

/** Ink half-width per road kind, in reference pixels. */
const KIND_RADIUS: Record<RoadKind, number> = {
  track: 1.5,
  road: 2.1,
  highway: 2.6,
};

const KIND_LINE_STYLE: Record<RoadKind, Exclude<RoadLineStyle, "auto">> = {
  track: "dashed",
  road: "solid",
  highway: "double",
};

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

/**
 * Parallel copy of a polyline at a signed distance (positive is to the left
 * of the direction of travel), with mitred joins limited at sharp bends.
 */
function offsetPolyline(points: readonly { x: number; y: number }[], distance: number): { x: number; y: number }[] {
  const normals: { x: number; y: number }[] = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const dx = points[index + 1].x - points[index].x;
    const dy = points[index + 1].y - points[index].y;
    const length = Math.hypot(dx, dy) || 1;
    normals.push({ x: -dy / length, y: dx / length });
  }
  return points.map((point, index) => {
    const before = normals[Math.max(0, index - 1)];
    const after = normals[Math.min(normals.length - 1, index)];
    let nx = before.x + after.x;
    let ny = before.y + after.y;
    const length = Math.hypot(nx, ny);
    if (length < 1e-6) {
      nx = after.x;
      ny = after.y;
    } else {
      nx /= length;
      ny /= length;
    }
    // Mitre length grows as 1/cos(half angle); cap it so hairpins stay tidy.
    const cosine = Math.max(0.5, nx * after.x + ny * after.y);
    return { x: point.x + nx * distance / cosine, y: point.y + ny * distance / cosine };
  });
}

/** Periodic on/off intervals along a line of `length`. */
function periodicRuns(length: number, on: number, off: number): CharcoalStrokeRun[] {
  const runs: CharcoalStrokeRun[] = [];
  for (let start = 0; start < length; start += on + off) runs.push({ start, end: Math.min(length, start + on) });
  return runs;
}

function strokePolyline(points: readonly { x: number; y: number }[], paint: Segment): void {
  for (let index = 0; index + 1 < points.length; index++) {
    paint(points[index].x, points[index].y, points[index + 1].x, points[index + 1].y);
  }
}

/** Sets `tags` to `value` wherever `alpha` is painted inside a segment's footprint. */
function tagFootprint(
  alpha: Uint8Array,
  tags: Uint8Array,
  value: number,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): void {
  const pad = Math.ceil(radius * 1.6 + 2);
  const xa = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
  const xb = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + pad));
  const ya = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
  const yb = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + pad));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const index = y * width + x;
      if (alpha[index] > 0) tags[index] = value;
    }
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
  const outline = style.outline && style.outlineWidth > 0 ? new Uint8Array(total) : null;
  const clear = style.clearance > 0 ? new Uint8Array(total) : null;
  const inkColorIndex = new Uint8Array(total);
  const fillIsBridge = new Uint8Array(total);
  const clip = new Uint8Array(total).fill(1);
  const defaultInk = parseRoadColor(style.color, [86, 58, 38]);
  const inkColors: RGB[] = [];
  const scale = Math.max(domainWidth, domainHeight) / ROAD_REFERENCE_LONG_EDGE;
  const toLocal = (point: MapPoint) => ({
    x: point.u * (domainWidth - 1) - offsetX,
    y: point.v * (domainHeight - 1) - offsetY,
  });
  const smoothCore = !style.handDrawn;
  let painted = false;

  roads.forEach((road, roadIndex) => {
    if (road.points.length < 2) return;
    const lineStyle = !road.lineStyle || road.lineStyle === "auto" ? KIND_LINE_STYLE[road.kind] : road.lineStyle;
    const inkRadius = KIND_RADIUS[road.kind] * Math.max(0.1, style.widthScale) * Math.max(0.1, road.widthScale ?? 1) * scale;
    // A double road is a wide ink stroke with a narrower fill on top.
    const strokeRadius = lineStyle === "double" ? inkRadius * 1.3 : inkRadius;
    const outlineRadius = strokeRadius + style.outlineWidth * scale;
    const clearRadius = (outline ? outlineRadius : strokeRadius) + style.clearance * scale;
    const margin = clearRadius * 2 + 12 * scale;
    const local = road.points.map(toLocal);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of local) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
    if (maxX < -margin || maxY < -margin || minX > width + margin || minY > height + margin) return;
    const paletteIndex = inkColors.length < 255 ? inkColors.push(parseRoadColor(road.color, defaultInk)) - 1 : 0;
    const seed = 7919 * (roadIndex + 1);
    const paint = (alpha: Uint8Array, radius: number, solid: boolean, opacity = 1): Segment => (x0, y0, x1, y1) => {
      paintInkSegment(
        alpha, clip, width, height, x0, y0, x1, y1, radius, seed, 2, 0.5, 0.5, false, false,
        offsetX, offsetY, domainWidth, opacity, solid ? 0 : 0.02, false, false, solid,
      );
    };
    const paintInk = (radius: number, opacity = 1): Segment => (x0, y0, x1, y1) => {
      paint(ink, radius, smoothCore, opacity)(x0, y0, x1, y1);
      tagFootprint(ink, inkColorIndex, paletteIndex, width, height, x0, y0, x1, y1, radius);
      painted = true;
    };
    // One charcoal stroke: pressure swells from a tapered start to a tapered end.
    const paintStroke = (radius: number, strokeSeed: number, opacity = 1): StrokePiece =>
      (x0, y0, x1, y1, t0, t1) => {
        paintInkSegment(
          ink, clip, width, height, x0, y0, x1, y1, radius, strokeSeed, 2, t0, t1, true, true,
          offsetX, offsetY, domainWidth, opacity, 0.05,
        );
        tagFootprint(ink, inkColorIndex, paletteIndex, width, height, x0, y0, x1, y1, radius);
        painted = true;
      };
    const paintDot = (x: number, y: number, radius: number, dotSeed: number) => {
      paintInkDisk(ink, clip, width, height, x, y, radius, dotSeed, offsetX, offsetY, domainWidth);
      tagFootprint(ink, inkColorIndex, paletteIndex, width, height, x, y, x, y, radius);
      painted = true;
    };
    const paintFill = (radius: number, bridge: boolean): Segment => (x0, y0, x1, y1) => {
      paint(fill, radius, true)(x0, y0, x1, y1);
      tagFootprint(fill, fillIsBridge, bridge ? 1 : 0, width, height, x0, y0, x1, y1, radius);
    };

    // The cleared corridor and casing follow the whole road, bridges included.
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

    // Charcoal stroke lengths follow the pen width so wide roads keep the
    // same rhythm; the schedule is the river/forest one with longer marks.
    const markScale = Math.max(0.5, strokeRadius / scale / KIND_RADIUS.road) * scale;
    const breakProbability = style.handDrawn ? Math.max(0, Math.min(1, style.interruptions)) : 0;
    // One ink lane per drawn line. A double road has two edge lanes, each
    // with its own seed, so their breaks, tapers and dots never line up.
    const drawLane = (lanePoints: readonly { x: number; y: number }[], laneSeed: number, radius: number) => {
      const line = measurePolyline(lanePoints);
      if (line.length <= 1e-6) return;
      if (lineStyle === "dotted") {
        // True charcoal dots, evenly spaced along the road.
        const spacing = radius * 3.4;
        let index = 0;
        for (let distance = spacing * 0.5; distance < line.length; distance += spacing, index++) {
          const point = pointAtDistance(line, distance);
          const dotSeed = (laneSeed + index * 131) | 0;
          const dotRadius = radius * (style.handDrawn ? 0.9 + hash01(dotSeed, 389) * 0.25 : 1);
          if (style.handDrawn) paintDot(point.x, point.y, dotRadius, dotSeed);
          else paintInk(dotRadius)(point.x, point.y, point.x, point.y);
        }
        return;
      }
      if (!style.handDrawn) {
        const runs = lineStyle === "dashed"
          ? periodicRuns(line.length, radius * 6.5, radius * 4.5)
          : [{ start: 0, end: line.length }];
        const solid = paintInk(radius);
        for (const stroke of runs) strokeRange(line, stroke.start, stroke.end, (x0, y0, x1, y1) => solid(x0, y0, x1, y1));
        return;
      }
      const runs = lineStyle === "dashed"
        // Dashes are already broken; each dash is its own tapered stroke.
        ? periodicRuns(line.length, radius * 6.5, radius * 4.5)
        : createCharcoalStrokeRuns(line.length, laneSeed, markScale, {
            breakProbability,
            dashMin: 14,
            dashMax: 46,
            gapMin: 1.6,
            gapMax: 3.4,
          });
      runs.forEach((stroke, strokeIndex) => {
        const strokeSeed = (laneSeed + strokeIndex * 977) | 0;
        strokeRange(line, stroke.start, stroke.end, paintStroke(radius, strokeSeed));
        // Like river marks, some breaks carry a single ink dot.
        const next = runs[strokeIndex + 1];
        if (style.gapDots && lineStyle !== "dashed" && next && hash01(strokeSeed, 401) < 0.45) {
          const middle = pointAtDistance(line, (stroke.end + next.start) * 0.5);
          paintDot(middle.x, middle.y, radius * 0.7, strokeSeed ^ 0x5f3);
        }
      });
    };

    // A double road: two thinner edge lines whose outer edges match the
    // single wide stroke, with the fill reaching to their inner edges.
    const edgeRadius = inkRadius * 0.55;
    const edgeOffset = strokeRadius - edgeRadius;
    landRuns.forEach((run, runIndex) => {
      if (run.length < 2) return;
      const runSeed = (seed ^ Math.imul(runIndex + 1, 2654435761)) | 0;
      if (outline) strokePolyline(run, paint(outline, outlineRadius, true));
      if (lineStyle === "double") {
        drawLane(offsetPolyline(run, edgeOffset), runSeed, edgeRadius);
        drawLane(offsetPolyline(run, -edgeOffset), (runSeed ^ 0x3c6ef372) | 0, edgeRadius);
        strokePolyline(run, paintFill(Math.max(0.5, edgeOffset - edgeRadius * 0.6), false));
      } else {
        drawLane(run, runSeed, strokeRadius);
      }
    });

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
      const halfWidth = Math.max(strokeRadius, 1.2 * scale) + 1.8 * scale;
      const overhang = 2.5 * scale;
      const startX = a.x - tx * overhang;
      const startY = a.y - ty * overhang;
      const endX = b.x + tx * overhang;
      const endY = b.y + ty * overhang;
      const railRadius = Math.max(0.6, 0.75 * scale * Math.max(0.5, Math.min(2, style.widthScale)));
      if (outline) paint(outline, halfWidth + railRadius + style.outlineWidth * scale, true)(startX, startY, endX, endY);
      // Deck: fill between the rails hides the water beneath.
      paintFill(Math.max(0.5, halfWidth - railRadius * 1.5), true)(startX, startY, endX, endY);
      const rail = paintInk(railRadius);
      const flare = 2.2 * scale;
      for (const side of [-1, 1]) {
        const ox = nx * halfWidth * side;
        const oy = ny * halfWidth * side;
        rail(startX + ox, startY + oy, endX + ox, endY + oy);
        // End ticks flare outwards like a drawn bridge abutment.
        rail(startX + ox, startY + oy, startX + ox - tx * flare + nx * flare * side, startY + oy - ty * flare + ny * flare * side);
        rail(endX + ox, endY + oy, endX + ox + tx * flare + nx * flare * side, endY + oy + ty * flare + ny * flare * side);
      }
    }
  });

  if (!painted) return null;
  return {
    clear,
    outline,
    ink,
    fill,
    inkColorIndex,
    inkColors,
    fillIsBridge,
    outlineColor: parseRoadColor(style.outlineColor, [244, 236, 214]),
    fillColor: parseRoadColor(style.fillColor, [238, 226, 196]),
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
  ) / 255;
}

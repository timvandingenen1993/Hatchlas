/**
 * Traces the borders of the grass ground so the vegetation ink can draw them
 * with the same bent SVG marks as its flow lines.
 *
 * Ground is a material per pixel: its biome, or silt where the river silt
 * overlay covers it (silt is bare sediment painted over the biome, so its
 * edge is a border too). Each grass material's mask is blurred and contoured
 * at one half (marching squares), which turns the stair-stepped raster edge
 * into a smooth line. A contour is kept only where it separates the grass
 * from other land: shorelines belong to the water ink, and a border between
 * two grass biomes is traced once, from one side.
 */
import type { MountainDEMData } from "../terrain/mountainBaseDEM";
import { boxBlur } from "./forestStandGeometry";
import type { VegetationStrokePoint } from "./vegetationRenderer";

/** Material of silt-covered ground; above every biome id. */
export const SILT_MATERIAL = 255;

/** Braided river gravel and ocean: water classes, outlined by the water ink. */
const WATER_BIOME_IDS: ReadonlySet<number> = new Set([6, 8]);

/** Mask blur in pixels; enough to round off single-pixel stair steps. */
const MASK_BLUR_RADIUS = 2;
/** How far either side of the contour the two biomes are sampled. */
const SIDE_SAMPLE_DISTANCE = 2.5;
/** Shorter border runs are specks of noise, not borders. */
const MIN_BORDER_LENGTH = 8;

export interface BiomeBorderPath {
  /** The grass biome; its marks are drawn on this border. */
  biomeId: number;
  /** Oriented so the grass lies on the side of (-dy, dx) of each segment. */
  points: VegetationStrokePoint[];
}

type BorderDem = Pick<MountainDEMData, "width" | "height" | "biomeType"> &
  Partial<Pick<
    MountainDEMData,
    | "siltDepth"
    | "isOcean"
    | "isRiverChannel"
    | "visualWaterMask"
    | "visualWaterCoverage"
    | "wetlandPoolMask"
    | "wetlandPoolCoverage"
  >>;

function isWaterIndex(dem: BorderDem, index: number): boolean {
  return Boolean(
    dem.isOcean?.[index] === 1 ||
    dem.isRiverChannel?.[index] === 1 ||
    dem.visualWaterMask?.[index] === 1 ||
    (dem.visualWaterCoverage?.[index] ?? 0) > 0.1 ||
    dem.wetlandPoolMask?.[index] === 1 ||
    (dem.wetlandPoolCoverage?.[index] ?? 0) > 0.1,
  );
}

function sampleField(field: Float32Array, width: number, height: number, x: number, y: number): number {
  const cx = Math.max(0, Math.min(width - 1.001, x));
  const cy = Math.max(0, Math.min(height - 1.001, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const tx = cx - x0;
  const ty = cy - y0;
  const index = y0 * width + x0;
  const top = field[index] * (1 - tx) + field[index + 1] * tx;
  const bottom = field[index + width] * (1 - tx) + field[index + width + 1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Contour `field` at 0.5 and join the cell segments into polylines. Crossings
 * live on cell edges: edge 2i is the horizontal edge right of pixel i, edge
 * 2i+1 the vertical edge below it. Each edge borders at most two cells, so a
 * crossing joins at most two segments and the chains never branch.
 */
function contourPolylines(field: Float32Array, width: number, height: number): VegetationStrokePoint[][] {
  const links = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    const fromA = links.get(a);
    if (fromA) fromA.push(b); else links.set(a, [b]);
    const fromB = links.get(b);
    if (fromB) fromB.push(a); else links.set(b, [a]);
  };
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const index = y * width + x;
      const a = field[index] >= 0.5 ? 1 : 0;
      const b = field[index + 1] >= 0.5 ? 1 : 0;
      const c = field[index + width + 1] >= 0.5 ? 1 : 0;
      const d = field[index + width] >= 0.5 ? 1 : 0;
      const kind = a | (b << 1) | (c << 2) | (d << 3);
      if (kind === 0 || kind === 15) continue;
      const top = index * 2;
      const bottom = (index + width) * 2;
      const left = index * 2 + 1;
      const right = (index + 1) * 2 + 1;
      switch (kind) {
        case 1: case 14: link(left, top); break;
        case 2: case 13: link(top, right); break;
        case 3: case 12: link(left, right); break;
        case 4: case 11: link(right, bottom); break;
        case 6: case 9: link(top, bottom); break;
        case 7: case 8: link(left, bottom); break;
        case 5: case 10: {
          // Saddle: the cell centre decides which corners are joined.
          const centre = (field[index] + field[index + 1] + field[index + width] + field[index + width + 1]) * 0.25;
          const joinedA = (centre >= 0.5) === (kind === 5);
          if (joinedA) { link(left, bottom); link(top, right); }
          else { link(left, top); link(right, bottom); }
          break;
        }
      }
    }
  }

  const pointOf = (edge: number): VegetationStrokePoint => {
    const pixel = edge >> 1;
    const x = pixel % width;
    const y = (pixel - x) / width;
    const neighbour = edge & 1 ? pixel + width : pixel + 1;
    const v0 = field[pixel];
    const v1 = field[neighbour];
    const t = Math.abs(v1 - v0) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (0.5 - v0) / (v1 - v0)));
    return edge & 1 ? { x, y: y + t } : { x: x + t, y };
  };

  const visited = new Set<number>();
  const walk = (start: number): VegetationStrokePoint[] => {
    const points: VegetationStrokePoint[] = [];
    let previous = -1;
    let current = start;
    while (current !== -1 && !visited.has(current)) {
      visited.add(current);
      points.push(pointOf(current));
      const next = (links.get(current) ?? []).find((edge) => edge !== previous && !visited.has(edge));
      previous = current;
      current = next ?? -1;
    }
    // Close a loop back onto its start.
    if (points.length > 2 && links.get(previous)?.includes(start)) points.push(points[0]);
    return points;
  };

  const polylines: VegetationStrokePoint[][] = [];
  // Open chains first, from an end, so no chain is entered in its middle.
  for (const [edge, neighbours] of links) {
    if (neighbours.length === 1 && !visited.has(edge)) polylines.push(walk(edge));
  }
  for (const edge of links.keys()) {
    if (!visited.has(edge)) polylines.push(walk(edge));
  }
  return polylines;
}

function polylineLength(points: readonly VegetationStrokePoint[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}

/** One corner-cutting pass that keeps both end points. */
function chaikin(points: readonly VegetationStrokePoint[]): VegetationStrokePoint[] {
  if (points.length < 3) return [...points];
  const smoothed: VegetationStrokePoint[] = [points[0]];
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index];
    const end = points[index + 1];
    if (index > 0) smoothed.push({ x: start.x * 0.75 + end.x * 0.25, y: start.y * 0.75 + end.y * 0.25 });
    if (index < points.length - 2) smoothed.push({ x: start.x * 0.25 + end.x * 0.75, y: start.y * 0.25 + end.y * 0.75 });
  }
  smoothed.push(points[points.length - 1]);
  return smoothed;
}

/** Drop points closer than `spacing` to the last kept one; keeps both ends. */
function thin(points: readonly VegetationStrokePoint[], spacing: number): VegetationStrokePoint[] {
  if (points.length < 3) return [...points];
  const thinned: VegetationStrokePoint[] = [points[0]];
  for (let index = 1; index < points.length - 1; index++) {
    const last = thinned[thinned.length - 1];
    if (Math.hypot(points[index].x - last.x, points[index].y - last.y) >= spacing) thinned.push(points[index]);
  }
  thinned.push(points[points.length - 1]);
  return thinned;
}

/**
 * Borders between grass ground and any other land, as smooth polylines.
 * `grassBiomeIds` are the biomes whose ground the flow lines draw as grass.
 * Between two grass biomes the one with the lower `drawOrder` draws the
 * border (ties: the lower id), so its marks grow into that side.
 */
export function traceGrassBiomeBorders(
  dem: BorderDem,
  grassBiomeIds: ReadonlySet<number>,
  drawOrder: (biomeId: number) => number = () => 0,
): BiomeBorderPath[] {
  const { width, height, biomeType } = dem;
  if (width < 3 || height < 3) return [];
  const material = new Uint8Array(width * height);
  const present = new Set<number>();
  for (let index = 0; index < material.length; index++) {
    // Any silt at all counts: its coverage fades in from zero depth, and the
    // vegetation ink is faded out under it, so the line sits just outside.
    material[index] = (dem.siltDepth?.[index] ?? 0) > 0 ? SILT_MATERIAL : biomeType[index];
    if (grassBiomeIds.has(material[index])) present.add(material[index]);
  }
  const drawsBefore = (a: number, b: number): boolean => {
    const orderA = drawOrder(a);
    const orderB = drawOrder(b);
    return orderA !== orderB ? orderA < orderB : a < b;
  };
  const borders: BiomeBorderPath[] = [];
  const mask = new Float32Array(width * height);
  const biomeAtPoint = (x: number, y: number): number | undefined => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return undefined;
    const index = iy * width + ix;
    return isWaterIndex(dem, index) ? undefined : material[index];
  };

  for (const biomeId of [...present].sort((a, b) => a - b)) {
    for (let index = 0; index < mask.length; index++) mask[index] = material[index] === biomeId ? 1 : 0;
    const field = boxBlur(mask, width, height, MASK_BLUR_RADIUS);
    for (const chain of contourPolylines(field, width, height)) {
      // Split the chain where it stops being a drawable border. `inward`
      // records, per kept segment, whether the grass lies along (-dy, dx).
      let run: VegetationStrokePoint[] = [];
      let inwardVotes = 0;
      const flush = (): void => {
        if (run.length >= 2 && polylineLength(run) >= MIN_BORDER_LENGTH) {
          // The corner cuts quarter the point spacing; one pixel is plenty
          // for the marks bent along the line.
          const points = thin(chaikin(chaikin(run)), 1);
          borders.push({ biomeId, points: inwardVotes >= 0 ? points : points.reverse() });
        }
        run = [];
        inwardVotes = 0;
      };
      for (let index = 1; index < chain.length; index++) {
        const start = chain[index - 1];
        const end = chain[index];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        if (length < 1e-6) continue;
        const normalX = -dy / length;
        const normalY = dx / length;
        const midX = (start.x + end.x) * 0.5;
        const midY = (start.y + end.y) * 0.5;
        const ahead = sampleField(field, width, height, midX + normalX, midY + normalY);
        const behind = sampleField(field, width, height, midX - normalX, midY - normalY);
        const inwardSign = ahead >= behind ? 1 : -1;
        const inside = biomeAtPoint(
          midX + normalX * inwardSign * SIDE_SAMPLE_DISTANCE,
          midY + normalY * inwardSign * SIDE_SAMPLE_DISTANCE,
        );
        const outside = biomeAtPoint(
          midX - normalX * inwardSign * SIDE_SAMPLE_DISTANCE,
          midY - normalY * inwardSign * SIDE_SAMPLE_DISTANCE,
        );
        const drawable =
          inside === biomeId &&
          outside !== undefined &&
          outside !== biomeId &&
          !WATER_BIOME_IDS.has(outside) &&
          // Two grass biomes share one border; only one of them draws it.
          !(grassBiomeIds.has(outside) && drawsBefore(outside, biomeId));
        if (!drawable) {
          flush();
          continue;
        }
        if (run.length === 0) run.push(start);
        run.push(end);
        inwardVotes += inwardSign;
      }
      flush();
    }
  }
  return borders;
}

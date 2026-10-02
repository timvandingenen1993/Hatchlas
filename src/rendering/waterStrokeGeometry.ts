/**
 * Immutable, packed paths shared by the water geometry and paint stages.
 *
 * Keeping the path coordinates separate from ink settings means that changing
 * thickness, opacity, or interruption settings can repaint the same paths
 * without tracing the DEM again.  The typed arrays are owned by the returned
 * value and must be treated as read-only by callers.
 */

export type WaterStrokeFamily = "river" | "inland" | "coastal" | "offshore";

export interface WaterStrokePathPoint {
  x: number;
  y: number;
  /** Optional width guide carried by routed river paths. */
  radius?: number;
}

export interface WaterStrokePath {
  id: number;
  family: WaterStrokeFamily;
  points: readonly WaterStrokePathPoint[];
}

export interface WaterStrokeGeometry {
  /** Number of output pixels the paths were generated for. */
  width: number;
  height: number;
  /** Flat x/y coordinates, grouped by path using pathOffsets. */
  pointX: Float32Array;
  pointY: Float32Array;
  pointRadius: Float32Array;
  /** One extra entry gives the exclusive end for the final path. */
  pathOffsets: Uint32Array;
  /** Stable path identifiers, useful for deterministic tile rejection. */
  stableIds: Uint32Array;
  /** Encoded family for each path: river 1, inland 2, coastal 3, offshore 4. */
  families: Uint8Array;
  /** Per-path [minX, minY, maxX, maxY] bounds in output pixels. */
  bounds: Float32Array;
}

const FAMILY_CODE: Record<WaterStrokeFamily, number> = {
  river: 1,
  inland: 2,
  coastal: 3,
  offshore: 4,
};

/** Pack paths into immutable typed arrays for reuse by paint passes. */
export function buildWaterStrokeGeometry(
  width: number,
  height: number,
  paths: readonly WaterStrokePath[],
): WaterStrokeGeometry {
  const validPaths = paths.filter((path) => path.points.length >= 2);
  let pointCount = 0;
  for (const path of validPaths) pointCount += path.points.length;

  const pointX = new Float32Array(pointCount);
  const pointY = new Float32Array(pointCount);
  const pointRadius = new Float32Array(pointCount);
  const pathOffsets = new Uint32Array(validPaths.length + 1);
  const stableIds = new Uint32Array(validPaths.length);
  const families = new Uint8Array(validPaths.length);
  const bounds = new Float32Array(validPaths.length * 4);

  let pointOffset = 0;
  for (let pathIndex = 0; pathIndex < validPaths.length; pathIndex++) {
    const path = validPaths[pathIndex];
    pathOffsets[pathIndex] = pointOffset;
    stableIds[pathIndex] = path.id >>> 0;
    families[pathIndex] = FAMILY_CODE[path.family];

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of path.points) {
      pointX[pointOffset] = point.x;
      pointY[pointOffset] = point.y;
      pointRadius[pointOffset] = point.radius ?? 0;
      pointOffset++;
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    const boundsOffset = pathIndex * 4;
    bounds[boundsOffset] = minX;
    bounds[boundsOffset + 1] = minY;
    bounds[boundsOffset + 2] = maxX;
    bounds[boundsOffset + 3] = maxY;
  }
  pathOffsets[validPaths.length] = pointOffset;

  return {
    width,
    height,
    pointX,
    pointY,
    pointRadius,
    pathOffsets,
    stableIds,
    families,
    bounds,
  };
}

/** Return an owned empty geometry for raw/no-detail water surfaces. */
export function emptyWaterStrokeGeometry(
  width: number,
  height: number,
): WaterStrokeGeometry {
  return buildWaterStrokeGeometry(width, height, []);
}

/**
 * Grid-bucket spatial index for stroke paths, so overlap queries do not scan every path.
 */
import type { MountainStrokePath } from './mountainPatternRenderer';

const CELL_SIZE = 256;
const MAX_BUCKETS_PER_PATH = 16;

interface MountainPathBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface MountainPathSpatialIndex {
  paths: readonly MountainStrokePath[];
  bounds: readonly (MountainPathBounds | undefined)[];
  buckets: Map<number, number[]>;
  overflow: number[];
  columns: number;
  rows: number;
  totalPoints: number;
}

export interface MountainPathSpatialQuery {
  paths: MountainStrokePath[];
  totalPaths: number;
  totalPoints: number;
  selectedPoints: number;
}

/** Build once for an export. Complete paths retain global dash and join phase. */
export function createMountainPathSpatialIndex(
  paths: readonly MountainStrokePath[],
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
): MountainPathSpatialIndex {
  const scaleX = (outputWidth - 1) / Math.max(1, sourceWidth - 1);
  const scaleY = (outputHeight - 1) / Math.max(1, sourceHeight - 1);
  const strokeScale = Math.min(
    outputWidth / Math.max(1, sourceWidth),
    outputHeight / Math.max(1, sourceHeight),
  );
  const columns = Math.max(1, Math.ceil(outputWidth / CELL_SIZE));
  const rows = Math.max(1, Math.ceil(outputHeight / CELL_SIZE));
  const buckets = new Map<number, number[]>();
  const overflow: number[] = [];
  const bounds: (MountainPathBounds | undefined)[] = new Array(paths.length);
  let totalPoints = 0;

  for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
    const path = paths[pathIndex];
    totalPoints += path.points.length;
    if (path.points.length === 0) continue;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let uncertain = false;
    for (const point of path.points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        uncertain = true;
        break;
      }
      const x = point.x * scaleX;
      const y = point.y * scaleY;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (uncertain) {
      overflow.push(pathIndex);
      continue;
    }

    // Covers the widest primary crest pen, brush footprint and the dab radius
    // for dots while leaving path points and stroke phase untouched.
    const brushSupport = Math.max(
      4,
      strokeScale * 4 + 8,
      path.width * strokeScale * 8 + 8,
    );
    const pathBounds = {
      minX: minX - brushSupport,
      minY: minY - brushSupport,
      maxX: maxX + brushSupport,
      maxY: maxY + brushSupport,
    };
    bounds[pathIndex] = pathBounds;

    const minCellX = Math.max(0, Math.floor(pathBounds.minX / CELL_SIZE));
    const maxCellX = Math.min(columns - 1, Math.floor(pathBounds.maxX / CELL_SIZE));
    const minCellY = Math.max(0, Math.floor(pathBounds.minY / CELL_SIZE));
    const maxCellY = Math.min(rows - 1, Math.floor(pathBounds.maxY / CELL_SIZE));
    const bucketCount = (maxCellX - minCellX + 1) * (maxCellY - minCellY + 1);
    if (bucketCount <= 0) continue;
    if (bucketCount > MAX_BUCKETS_PER_PATH) {
      overflow.push(pathIndex);
      continue;
    }
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        const key = cellY * columns + cellX;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(pathIndex);
        else buckets.set(key, [pathIndex]);
      }
    }
  }
  return { paths, bounds, buckets, overflow, columns, rows, totalPoints };
}

/** Return whole paths whose conservative output-space bounds touch a region. */
export function queryMountainPathSpatialIndex(
  index: MountainPathSpatialIndex,
  x: number,
  y: number,
  width: number,
  height: number,
  support: number,
): MountainPathSpatialQuery {
  const minX = x - support;
  const minY = y - support;
  const maxX = x + width + support;
  const maxY = y + height + support;
  const firstCellX = Math.max(0, Math.floor(minX / CELL_SIZE));
  const firstCellY = Math.max(0, Math.floor(minY / CELL_SIZE));
  const lastCellX = Math.min(index.columns - 1, Math.floor(maxX / CELL_SIZE));
  const lastCellY = Math.min(index.rows - 1, Math.floor(maxY / CELL_SIZE));
  const candidates = new Set<number>(index.overflow);

  for (let cellY = firstCellY; cellY <= lastCellY; cellY++) {
    for (let cellX = firstCellX; cellX <= lastCellX; cellX++) {
      const bucket = index.buckets.get(cellY * index.columns + cellX);
      if (bucket) for (const pathIndex of bucket) candidates.add(pathIndex);
    }
  }

  const selected: number[] = [];
  for (const pathIndex of candidates) {
    const pathBounds = index.bounds[pathIndex];
    // Unknown coordinates are kept conservatively. Empty paths have no raster
    // effect and are omitted from the internal tile rendering path.
    if (!pathBounds || (
      pathBounds.maxX >= minX && pathBounds.minX <= maxX
      && pathBounds.maxY >= minY && pathBounds.minY <= maxY
    )) selected.push(pathIndex);
  }
  selected.sort((left, right) => left - right);
  const paths = selected.map(pathIndex => index.paths[pathIndex]);
  let selectedPoints = 0;
  for (const path of paths) selectedPoints += path.points.length;
  return {
    paths,
    totalPaths: index.paths.length,
    totalPoints: index.totalPoints,
    selectedPoints,
  };
}

/**
 * Maps between normalized map coordinates (u, v) and the displayed frame.
 *
 * In the top-down view the frame is the map, so the mapping is the identity.
 * The tilted full-terrain camera reprojects the map, so the preview worker
 * sends a downsampled copy of the camera mesh ("camera grid") with each
 * frame. Grid node (i, j) holds the frame position, as 0..1 ratios, of map
 * point u = i / (columns - 1), v = j / (rows - 1), plus its camera depth
 * (larger is closer to the camera).
 */
import type { MapPoint } from "./types";

export interface CameraGrid {
  columns: number;
  rows: number;
  x: Float32Array;
  y: Float32Array;
  depth: Float32Array;
}

/** Structural subset of `FullTerrainCameraProjection`. */
export interface CameraMeshProjection {
  width: number;
  fullHeight: number;
  meshWidth: number;
  meshHeight: number;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  depth: ArrayLike<number>;
}

export interface FramePoint {
  /** Output position in pixels of the projection's frame. */
  x: number;
  y: number;
  depth: number;
}

/** Exact projection of a map point through the full camera mesh, in output pixels. */
export function projectThroughMesh(projection: CameraMeshProjection, point: MapPoint): FramePoint {
  const { meshWidth, meshHeight } = projection;
  const mx = Math.max(0, Math.min(meshWidth - 1, point.u * (meshWidth - 1)));
  const my = Math.max(0, Math.min(meshHeight - 1, point.v * (meshHeight - 1)));
  const x0 = Math.min(meshWidth - 2, Math.floor(mx));
  const y0 = Math.min(meshHeight - 2, Math.floor(my));
  const tx = mx - x0;
  const ty = my - y0;
  const a = y0 * meshWidth + x0;
  const b = a + 1;
  const c = a + meshWidth;
  const d = c + 1;
  const lerp = (field: ArrayLike<number>): number =>
    (field[a] * (1 - tx) + field[b] * tx) * (1 - ty) + (field[c] * (1 - tx) + field[d] * tx) * ty;
  return { x: lerp(projection.x), y: lerp(projection.y), depth: lerp(projection.depth) };
}

export function buildCameraGrid(projection: CameraMeshProjection, maxNodes = 257): CameraGrid {
  const columns = Math.max(2, Math.min(maxNodes, projection.meshWidth));
  const rows = Math.max(2, Math.min(maxNodes, projection.meshHeight));
  const x = new Float32Array(columns * rows);
  const y = new Float32Array(columns * rows);
  const depth = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const point = projectThroughMesh(projection, {
        u: column / (columns - 1),
        v: row / (rows - 1),
      });
      const index = row * columns + column;
      x[index] = point.x / Math.max(1, projection.width - 1);
      y[index] = point.y / Math.max(1, projection.fullHeight - 1);
      depth[index] = point.depth;
    }
  }
  return { columns, rows, x, y, depth };
}

/** Frame position (0..1 ratios) of a map point. */
export function sourceToScreen(grid: CameraGrid | null | undefined, point: MapPoint): { x: number; y: number } {
  if (!grid) return { x: point.u, y: point.v };
  const { columns, rows } = grid;
  const gx = Math.max(0, Math.min(columns - 1, point.u * (columns - 1)));
  const gy = Math.max(0, Math.min(rows - 1, point.v * (rows - 1)));
  const x0 = Math.min(columns - 2, Math.floor(gx));
  const y0 = Math.min(rows - 2, Math.floor(gy));
  const tx = gx - x0;
  const ty = gy - y0;
  const a = y0 * columns + x0;
  const b = a + 1;
  const c = a + columns;
  const d = c + 1;
  const lerp = (field: Float32Array): number =>
    (field[a] * (1 - tx) + field[b] * tx) * (1 - ty) + (field[c] * (1 - tx) + field[d] * tx) * ty;
  return { x: lerp(grid.x), y: lerp(grid.y) };
}

/**
 * Map point under a frame position (0..1 ratios), or null when the position
 * misses the terrain. Where terrain overlaps itself the surface nearest the
 * camera wins, matching what the user sees.
 */
export function screenToSource(grid: CameraGrid | null | undefined, x: number, y: number): MapPoint | null {
  if (!grid) {
    if (x < 0 || y < 0 || x > 1 || y > 1) return null;
    return { u: x, v: y };
  }
  const { columns, rows } = grid;
  let best: MapPoint | null = null;
  let bestDepth = -Infinity;
  const testTriangle = (i0: number, i1: number, i2: number): void => {
    const x0 = grid.x[i0], y0 = grid.y[i0];
    const x1 = grid.x[i1], y1 = grid.y[i1];
    const x2 = grid.x[i2], y2 = grid.y[i2];
    if (x < Math.min(x0, x1, x2) || x > Math.max(x0, x1, x2)) return;
    if (y < Math.min(y0, y1, y2) || y > Math.max(y0, y1, y2)) return;
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(det) < 1e-14) return;
    const w0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / det;
    const w1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / det;
    const w2 = 1 - w0 - w1;
    const epsilon = -1e-6;
    if (w0 < epsilon || w1 < epsilon || w2 < epsilon) return;
    const depth = grid.depth[i0] * w0 + grid.depth[i1] * w1 + grid.depth[i2] * w2;
    if (depth <= bestDepth) return;
    bestDepth = depth;
    const u = (column(i0) * w0 + column(i1) * w1 + column(i2) * w2) / (columns - 1);
    const v = (row(i0) * w0 + row(i1) * w1 + row(i2) * w2) / (rows - 1);
    best = { u: Math.max(0, Math.min(1, u)), v: Math.max(0, Math.min(1, v)) };
  };
  const column = (index: number): number => index % columns;
  const row = (index: number): number => Math.floor(index / columns);
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < columns - 1; c++) {
      const a = r * columns + c;
      const b = a + 1;
      const d = a + columns;
      const e = d + 1;
      testTriangle(a, b, e);
      testTriangle(a, e, d);
    }
  }
  return best;
}

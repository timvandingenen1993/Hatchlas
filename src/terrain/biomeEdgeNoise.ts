/**
 * Cheap hashed value noise that roughens biome borders so they do not follow straight grid lines.
 */
export const DEFAULT_BIOME_EDGE_NOISE_SCALE_M = 800;

function hashGrid(gx: number, gy: number, seed: number): number {
  let hash = Math.imul(gx, 374761393) + Math.imul(gy, 668265263) + seed;
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
}

function sampleValueNoise(x: number, y: number, scale: number, seed: number): number {
  const px = x / scale;
  const py = y / scale;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const tx = fx * fx * (3 - 2 * fx);
  const ty = fy * fy * (3 - 2 * fy);
  const topLeft = hashGrid(ix, iy, seed);
  const topRight = hashGrid(ix + 1, iy, seed);
  const bottomLeft = hashGrid(ix, iy + 1, seed);
  const bottomRight = hashGrid(ix + 1, iy + 1, seed);
  return (topLeft * (1 - tx) + topRight * tx) * (1 - ty) +
    (bottomLeft * (1 - tx) + bottomRight * tx) * ty;
}

/** One world-space noise field for ecological edges, coastal width and paint. */
export function biomeEdgeNoise(x: number, y: number, scaleM: number, seed = 613): number {
  const scale = Math.max(1, scaleM);
  return (
    sampleValueNoise(x, y, scale, seed) * 0.7 +
    sampleValueNoise(x, y, scale * 0.27, seed) * 0.3 -
    0.5
  ) * 2;
}

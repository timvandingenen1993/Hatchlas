import { latLonRadToVec3, normalize3, vec3, type Vec3 } from './coordinates';
import type { TopologyData } from '../types/worldV2';

/**
 * Cubed-Sphere 6-Face Spherical Grid System
 * Reference: Ronchi, Iacono & Paolucci (1996), "The 'Cubed Sphere': A New Method for the Solution of Partial Differential Equations in Spherical Geometry", J. Comput. Phys.
 * 
 * Cube Faces:
 * - Face 0: +X (0° Lon Equator)
 * - Face 1: -X (180° Lon Equator)
 * - Face 2: +Y (+90° Lon East Equator)
 * - Face 3: -Y (-90° Lon West Equator)
 * - Face 4: +Z (North Pole)
 * - Face 5: -Z (South Pole)
 */

export interface CubedSphereGrid {
  resolution: number;        // N (cells per edge per face)
  cellsPerFace: number;      // N * N
  totalCells: number;        // 6 * N * N
  radiusMeters: number;      // e.g. 6,371,000 m
  cellPositions: Float32Array; // [cellIdx * 3 + 0..2] unit vectors on S^2
  cellLatitudes: Float32Array; // Latitude in radians [-PI/2, +PI/2]
  cellLongitudes: Float32Array;// Longitude in radians [-PI, +PI]
  cellAreas: Float32Array;   // Surface area in m^2 (Ronchi metric)
  edgeLengths: Float32Array; // [cellIdx * 4 + 0..3] Interface length in meters
  edgeNormals: Float32Array; // [(cellIdx * 4 + 0..3) * 3 + 0..2] Unit tangent normal from cell to neighbor
  minCellDistanceM: number;  // Global minimum distance between any two adjacent cell centers
  neighbors: Int32Array;     // Flattened 4-neighbor graph: [cellIdx * 4 + 0..3] (0:Left, 1:Right, 2:Down, 3:Up)
  faceOffsets: Int32Array;
  topology: TopologyData;
}

/**
 * Map local face coordinates (face, u, v) with u, v in [-1, 1] to 3D Cartesian coordinates
 */
export function faceUVToCubeXYZ(face: number, u: number, v: number): Vec3 {
  switch (face) {
    case 0: return vec3(1.0, u, v);       // +X
    case 1: return vec3(-1.0, -u, v);     // -X
    case 2: return vec3(-u, 1.0, v);      // +Y
    case 3: return vec3(u, -1.0, v);      // -Y
    case 4: return vec3(-v, u, 1.0);      // +Z (North Pole)
    case 5: return vec3(v, u, -1.0);      // -Z (South Pole)
    default: return vec3(1.0, 0, 0);
  }
}

/**
 * Map 3D point on S^2 to (face, u, v) in [-1, 1]
 */
export function cubeXYZToFaceUV(x: number, y: number, z: number): { face: number; u: number; v: number } {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);

  if (ax >= ay && ax >= az) {
    if (x > 0) {
      return { face: 0, u: y / x, v: z / x };
    } else {
      return { face: 1, u: y / x, v: -z / x };
    }
  } else if (ay >= ax && ay >= az) {
    if (y > 0) {
      return { face: 2, u: -x / y, v: z / y };
    } else {
      return { face: 3, u: -x / y, v: -z / y };
    }
  } else {
    if (z > 0) {
      return { face: 4, u: y / z, v: -x / z };
    } else {
      return { face: 5, u: -y / z, v: -x / z };
    }
  }
}

/**
 * Reciprocal seam neighbor calculation across the 12 edges and 8 corners of the cubed sphere
 * Uses exact 3D cube projection to guarantee 100% neighbor reciprocity across all seams.
 */
export function getSeamNeighbor(
  face: number,
  i: number,
  j: number,
  N: number,
  dir: 0 | 1 | 2 | 3 // 0: Left (-i), 1: Right (+i), 2: Down (-j), 3: Up (+j)
): { face: number; i: number; j: number } {
  let ti = i;
  let tj = j;

  if (dir === 0) ti--;      // Left
  else if (dir === 1) ti++; // Right
  else if (dir === 2) tj--; // Down
  else if (dir === 3) tj++; // Up

  // If inside current face bounds, return immediately
  if (ti >= 0 && ti < N && tj >= 0 && tj < N) {
    return { face, i: ti, j: tj };
  }

  // Convert stepped coordinate (ti, tj) to continuous angle in [-PI/4, +PI/4]
  const alpha = -Math.PI / 4 + ((ti + 0.5) / N) * (Math.PI / 2);
  const beta = -Math.PI / 4 + ((tj + 0.5) / N) * (Math.PI / 2);
  const u = Math.tan(alpha);
  const v = Math.tan(beta);

  // 3D Cartesian point on the cube
  const cubePt = faceUVToCubeXYZ(face, u, v);

  // Project onto the target cube face
  const { face: targetFace, u: targetU, v: targetV } = cubeXYZToFaceUV(cubePt[0], cubePt[1], cubePt[2]);

  const targetAlpha = Math.atan(targetU);
  const targetBeta = Math.atan(targetV);

  const targetI = Math.max(0, Math.min(N - 1, Math.floor(((targetAlpha + Math.PI / 4) / (Math.PI / 2)) * N)));
  const targetJ = Math.max(0, Math.min(N - 1, Math.floor(((targetBeta + Math.PI / 4) / (Math.PI / 2)) * N)));

  return { face: targetFace, i: targetI, j: targetJ };
}

/**
 * Return a diagonal or cardinal neighbor by stepping in the equiangular
 * coordinate system and projecting the result back onto the cube.  Unlike
 * face-local array arithmetic this remains seam-aware for all eight stencil
 * directions, including the corners where two cube edges meet.
 */
export function getCubedSphereNeighbor(
  grid: Pick<CubedSphereGrid, 'resolution' | 'cellsPerFace'>,
  cellIndex: number,
  di: -1 | 0 | 1,
  dj: -1 | 0 | 1,
): number {
  if (di === 0 && dj === 0) return cellIndex;

  const N = grid.resolution;
  const face = Math.floor(cellIndex / grid.cellsPerFace);
  const local = cellIndex - face * grid.cellsPerFace;
  const i = local % N;
  const j = Math.floor(local / N);
  const delta = (Math.PI / 2) / N;
  const alpha = -Math.PI / 4 + (i + 0.5) * delta + di * delta;
  const beta = -Math.PI / 4 + (j + 0.5) * delta + dj * delta;

  const cubePoint = faceUVToCubeXYZ(face, Math.tan(alpha), Math.tan(beta));
  const target = cubeXYZToFaceUV(cubePoint[0], cubePoint[1], cubePoint[2]);
  const targetAlpha = Math.atan(target.u);
  const targetBeta = Math.atan(target.v);
  const targetI = Math.max(0, Math.min(N - 1, Math.floor(((targetAlpha + Math.PI / 4) / (Math.PI / 2)) * N)));
  const targetJ = Math.max(0, Math.min(N - 1, Math.floor(((targetBeta + Math.PI / 4) / (Math.PI / 2)) * N)));
  return target.face * grid.cellsPerFace + targetJ * N + targetI;
}

/** Great-circle distance between two cell centres in metres. */
export function cellCenterDistanceMeters(grid: Pick<CubedSphereGrid, 'cellPositions' | 'radiusMeters'>, idxA: number, idxB: number): number {
  const a = idxA * 3;
  const b = idxB * 3;
  const dot = Math.max(-1, Math.min(1,
    grid.cellPositions[a] * grid.cellPositions[b] +
    grid.cellPositions[a + 1] * grid.cellPositions[b + 1] +
    grid.cellPositions[a + 2] * grid.cellPositions[b + 2],
  ));
  return Math.acos(dot) * grid.radiusMeters;
}

const gridCache = new Map<string, CubedSphereGrid>();

/**
 * Initialize a complete CubedSphereGrid instance with exact topology, metric areas, and coordinates.
 * Cached by resolution and radius to ensure zero-latency grid retrieval.
 */
export function buildCubedSphereGrid(resolution: number = 192, radiusMeters: number = 6371000): CubedSphereGrid {
  const cacheKey = `${resolution}_${radiusMeters}`;
  const cached = gridCache.get(cacheKey);
  if (cached) {
    console.log(`%c[Grid] ⚡ CubedSphereGrid cache hit (N=${resolution}) - 0ms`, 'color: #38bdf8;');
    return cached;
  }

  const tStart = performance.now();
  console.log(`%c[Grid] 🔨 Building CubedSphereGrid (N=${resolution}, cells=${6 * resolution * resolution})...`, 'color: #38bdf8; font-weight: bold;');

  const N = resolution;
  const cellsPerFace = N * N;
  const totalCells = 6 * cellsPerFace;

  const cellPositions = new Float32Array(totalCells * 3);
  const cellLatitudes = new Float32Array(totalCells);
  const cellLongitudes = new Float32Array(totalCells);
  const cellAreas = new Float32Array(totalCells);
  const neighbors = new Int32Array(totalCells * 4);
  const faceOffsets = new Int32Array(6);

  for (let f = 0; f < 6; f++) {
    faceOffsets[f] = f * cellsPerFace;
  }

  const sphereSurfaceArea = 4 * Math.PI * radiusMeters * radiusMeters;
  let sumAreaWeight = 0;
  const rawAreas = new Float64Array(totalCells);

  const tStep1 = performance.now();
  // 1. Generate 3D unit positions, spherical coordinates, and metric tensors
  for (let f = 0; f < 6; f++) {
    const faceOffset = f * cellsPerFace;

    for (let j = 0; j < N; j++) {
      // Equiangular grid coordinate mapping: alpha, beta in [-PI/4, +PI/4]
      const beta = -Math.PI / 4 + ((j + 0.5) / N) * (Math.PI / 2);
      const tanBeta = Math.tan(beta);

      for (let i = 0; i < N; i++) {
        const alpha = -Math.PI / 4 + ((i + 0.5) / N) * (Math.PI / 2);
        const tanAlpha = Math.tan(alpha);

        const cellIdx = faceOffset + j * N + i;

        // Cube face point
        const cubePt = faceUVToCubeXYZ(f, tanAlpha, tanBeta);
        const unitPt = normalize3(cubePt);

        cellPositions[cellIdx * 3 + 0] = unitPt[0];
        cellPositions[cellIdx * 3 + 1] = unitPt[1];
        cellPositions[cellIdx * 3 + 2] = unitPt[2];

        const lat = Math.asin(Math.max(-1.0, Math.min(1.0, unitPt[2])));
        const lon = Math.atan2(unitPt[1], unitPt[0]);
        cellLatitudes[cellIdx] = lat;
        cellLongitudes[cellIdx] = lon;

        // Ronchi et al. (1996) equiangular metric tensor Jacobian determinant
        // dA = (sec^2(alpha) * sec^2(beta) / (1 + tan^2(alpha) + tan^2(beta))^(3/2)) * dAlpha * dBeta
        const delta = (Math.PI / 2) / N;
        const sec2Alpha = 1.0 + tanAlpha * tanAlpha;
        const sec2Beta = 1.0 + tanBeta * tanBeta;
        const denom = Math.pow(1.0 + tanAlpha * tanAlpha + tanBeta * tanBeta, 1.5);
        const metricArea = (sec2Alpha * sec2Beta / denom) * delta * delta;

        rawAreas[cellIdx] = metricArea;
        sumAreaWeight += metricArea;
      }
    }
  }

  // Normalize cell areas so that sum(cellAreas) exactly equals 4*PI*R^2
  const areaScale = sphereSurfaceArea / sumAreaWeight;
  for (let idx = 0; idx < totalCells; idx++) {
    cellAreas[idx] = (rawAreas[idx] * areaScale);
  }
  console.log(`[Grid] Step 1 (Positions, Coordinates & Ronchi Areas): ${(performance.now() - tStep1).toFixed(2)}ms`);

  const tStep2 = performance.now();
  // 2. Build reciprocal neighbor graph across seams
  for (let f = 0; f < 6; f++) {
    const faceOffset = f * cellsPerFace;

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const cellIdx = faceOffset + j * N + i;

        // 4 cardinal neighbors: Left (0), Right (1), Down (2), Up (3)
        const leftN  = getSeamNeighbor(f, i, j, N, 0);
        const rightN = getSeamNeighbor(f, i, j, N, 1);
        const downN  = getSeamNeighbor(f, i, j, N, 2);
        const upN    = getSeamNeighbor(f, i, j, N, 3);

        neighbors[cellIdx * 4 + 0] = leftN.face * cellsPerFace + leftN.j * N + leftN.i;
        neighbors[cellIdx * 4 + 1] = rightN.face * cellsPerFace + rightN.j * N + rightN.i;
        neighbors[cellIdx * 4 + 2] = downN.face * cellsPerFace + downN.j * N + downN.i;
        neighbors[cellIdx * 4 + 3] = upN.face * cellsPerFace + upN.j * N + upN.i;
      }
    }
  }
  console.log(`[Grid] Step 2 (Seam Neighbor Graph): ${(performance.now() - tStep2).toFixed(2)}ms`);

  const tStep3 = performance.now();
  // 3. Compute interface metric lengths, tangent unit normals, and global minimum distance
  const edgeLengths = new Float32Array(totalCells * 4);
  const edgeNormals = new Float32Array(totalCells * 4 * 3);
  const minCellDistanceM = (radiusMeters * Math.PI) / (2 * N * 1.41421356);

  for (let idx = 0; idx < totalCells; idx++) {
    const p3 = idx * 3;
    const px = cellPositions[p3];
    const py = cellPositions[p3 + 1];
    const pz = cellPositions[p3 + 2];
    const areaI = cellAreas[idx];
    const base4 = idx * 4;

    for (let k = 0; k < 4; k++) {
      const nb = neighbors[base4 + k];
      const nb3 = nb * 3;
      const nx = cellPositions[nb3];
      const ny = cellPositions[nb3 + 1];
      const nz = cellPositions[nb3 + 2];
      const areaJ = cellAreas[nb];

      edgeLengths[base4 + k] = Math.sqrt(0.5 * (areaI + areaJ));

      const dot = px * nx + py * ny + pz * nz;
      const tx = nx - dot * px;
      const ty = ny - dot * py;
      const tz = nz - dot * pz;
      const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
      const norm3 = (base4 + k) * 3;
      if (tLen > 1e-7) {
        const invLen = 1.0 / tLen;
        edgeNormals[norm3] = tx * invLen;
        edgeNormals[norm3 + 1] = ty * invLen;
        edgeNormals[norm3 + 2] = tz * invLen;
      } else {
        edgeNormals[norm3] = 1.0;
        edgeNormals[norm3 + 1] = 0.0;
        edgeNormals[norm3 + 2] = 0.0;
      }
    }
  }
  console.log(`[Grid] Step 3 (Edge Metric Lengths & Tangent Normals): ${(performance.now() - tStep3).toFixed(2)}ms`);

  const topology: TopologyData = {
    resolution: N,
    totalCells,
    cellAreas,
    faceOffsets,
    neighbors,
  };

  const gridInstance: CubedSphereGrid = {
    resolution: N,
    cellsPerFace,
    totalCells,
    radiusMeters,
    cellPositions,
    cellLatitudes,
    cellLongitudes,
    cellAreas,
    edgeLengths,
    edgeNormals,
    minCellDistanceM: Number.isFinite(minCellDistanceM) ? minCellDistanceM : (radiusMeters * Math.PI) / (2 * N),
    neighbors,
    faceOffsets,
    topology,
  };

  gridCache.set(cacheKey, gridInstance);
  console.log(`%c[Grid] ✅ CubedSphereGrid complete in ${(performance.now() - tStart).toFixed(2)}ms`, 'color: #38bdf8; font-weight: bold;');
  return gridInstance;
}

/**
 * Sample a scalar field on the cubed-sphere given spherical coordinates (lat, lon in radians)
 * Uses bilinear subpixel interpolation across the corresponding cube face.
 */
export function sampleCubedSphereField(
  grid: CubedSphereGrid,
  field: Float32Array | Uint8Array | Int32Array,
  latRad: number,
  lonRad: number
): number {
  const pt = latLonRadToVec3(latRad, lonRad);
  const { face, u, v } = cubeXYZToFaceUV(pt[0], pt[1], pt[2]);

  // Convert u, v (tan(angle)) to face sub-pixel indices in [0, N-1]
  const alpha = Math.atan(u);
  const beta = Math.atan(v);

  const N = grid.resolution;
  const fi = ((alpha + Math.PI / 4) / (Math.PI / 2)) * N - 0.5;
  const fj = ((beta + Math.PI / 4) / (Math.PI / 2)) * N - 0.5;

  const i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  const i1 = i0 + 1;
  const j1 = j0 + 1;

  const fx = Math.max(0, Math.min(1, fi - i0));
  const fy = Math.max(0, Math.min(1, fj - j0));

  const valueAt = (localI: number, localJ: number): number => {
    const resolved = resolveFaceCell(face, localI, localJ, N);
    return field[resolved.face * grid.cellsPerFace + resolved.j * N + resolved.i];
  };

  // Resolve the four samples through cube-face seams instead of clamping to
  // the current face. Clamping creates visible discontinuities in projected
  // rasters exactly where a face edge crosses a continent or climate field.
  const v00 = valueAt(i0, j0);
  const v10 = valueAt(i1, j0);
  const v01 = valueAt(i0, j1);
  const v11 = valueAt(i1, j1);

  return (1 - fx) * (1 - fy) * v00 + fx * (1 - fy) * v10 + (1 - fx) * fy * v01 + fx * fy * v11;
}

/**
 * Sample a discrete categorical field on the cubed sphere using Nearest-Neighbor lookup.
 * Preserves exact integer category IDs (e.g. Biome ID, Crust Type, Basin ID, Boundary Type)
 * without spurious interpolated intermediate categories.
 */
export function sampleCubedSphereNearest(
  grid: CubedSphereGrid,
  field: Float32Array | Uint8Array | Int32Array,
  latRad: number,
  lonRad: number
): number {
  const pt = latLonRadToVec3(latRad, lonRad);
  const { face, u, v } = cubeXYZToFaceUV(pt[0], pt[1], pt[2]);

  const alpha = Math.atan(u);
  const beta = Math.atan(v);

  const N = grid.resolution;
  const i = Math.max(0, Math.min(N - 1, Math.floor(((alpha + Math.PI / 4) / (Math.PI / 2)) * N)));
  const j = Math.max(0, Math.min(N - 1, Math.floor(((beta + Math.PI / 4) / (Math.PI / 2)) * N)));

  return field[face * grid.cellsPerFace + j * N + i];
}

function resolveFaceCell(
  initialFace: number,
  initialI: number,
  initialJ: number,
  N: number
): { face: number; i: number; j: number } {
  let face = initialFace;
  let i = initialI;
  let j = initialJ;

  // A bilinear stencil can be at most one cell outside the face in either
  // direction. Resolve one edge at a time so corner samples also work.
  if (i < 0) {
    const next = getSeamNeighbor(face, 0, Math.max(0, Math.min(N - 1, j)), N, 0);
    face = next.face;
    i = next.i;
    j = next.j;
  } else if (i >= N) {
    const next = getSeamNeighbor(face, N - 1, Math.max(0, Math.min(N - 1, j)), N, 1);
    face = next.face;
    i = next.i;
    j = next.j;
  }

  if (j < 0) {
    const next = getSeamNeighbor(face, Math.max(0, Math.min(N - 1, i)), 0, N, 2);
    face = next.face;
    i = next.i;
    j = next.j;
  } else if (j >= N) {
    const next = getSeamNeighbor(face, Math.max(0, Math.min(N - 1, i)), N - 1, N, 3);
    face = next.face;
    i = next.i;
    j = next.j;
  }

  return { face, i: Math.max(0, Math.min(N - 1, i)), j: Math.max(0, Math.min(N - 1, j)) };
}

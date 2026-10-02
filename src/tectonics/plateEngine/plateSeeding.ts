/**
 * Seeds rigid plates with Euler rotation poles and checks that each plate is connected.
 */
import { dot3, normalize3, type Vec3 } from '../../geometry/coordinates';
import type { CubedSphereGrid } from '../../geometry/cubedSphere';
import { Mulberry32 } from '../../utils/rng';
import type { PlateEngineConfig, RigidEulerPlate } from './types';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export const DISTINCT_PLATE_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#0ea5e9', '#6366f1', '#a855f7',
  '#ec4899', '#f43f5e', '#84cc16', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#d946ef', '#78716c',
  '#10b981', '#f59e0b', '#64748b', '#475569',
];

function fibonacciSpherePoint(index: number, count: number): Vec3 {
  const z = 1 - (2 * index + 1) / count;
  const radius = Math.sqrt(Math.max(0, 1 - z * z));
  const longitude = index * GOLDEN_ANGLE;
  return [radius * Math.cos(longitude), radius * Math.sin(longitude), z];
}

function tangentPerturb(center: Vec3, angleRad: number, azimuthRad: number): Vec3 {
  let east = normalize3([-center[1], center[0], 0]);
  if (Math.hypot(east[0], east[1], east[2]) < 0.5) east = [1, 0, 0];
  const north: Vec3 = [
    center[1] * east[2] - center[2] * east[1],
    center[2] * east[0] - center[0] * east[2],
    center[0] * east[1] - center[1] * east[0],
  ];
  const tangent: Vec3 = [
    east[0] * Math.cos(azimuthRad) + north[0] * Math.sin(azimuthRad),
    east[1] * Math.cos(azimuthRad) + north[1] * Math.sin(azimuthRad),
    east[2] * Math.cos(azimuthRad) + north[2] * Math.sin(azimuthRad),
  ];
  return normalize3([
    center[0] * Math.cos(angleRad) + tangent[0] * Math.sin(angleRad),
    center[1] * Math.cos(angleRad) + tangent[1] * Math.sin(angleRad),
    center[2] * Math.cos(angleRad) + tangent[2] * Math.sin(angleRad),
  ]);
}

/**
 * Generates a realistic heterogeneous population of rigid plates with Euler poles.
 * Plate weights follow a power-law / multi-scale distribution (major, minor, microplates).
 */
export function seedRigidEulerPlates(config: PlateEngineConfig): RigidEulerPlate[] {
  const count = Math.max(3, Math.min(32, Math.floor(config.plateCount)));
  const rng = new Mulberry32((config.seed ^ 0x9e3779b9) >>> 0);
  const plates: RigidEulerPlate[] = [];

  // Categorize plates into major (top ~30%), minor (~50%), micro (~20%)
  const majorCount = Math.max(1, Math.round(count * 0.3));
  const microCount = Math.max(1, Math.round(count * 0.2));

  for (let id = 0; id < count; id++) {
    const base = fibonacciSpherePoint(id, count);
    const seedPosition = tangentPerturb(base, rng.range(0, 0.18), rng.range(0, Math.PI * 2));

    // Power-law / hierarchical territory weight
    let weight: number;
    if (id < majorCount) {
      weight = rng.range(1.8, 2.6); // Major plates
    } else if (id >= count - microCount) {
      weight = rng.range(0.4, 0.7); // Microplates
    } else {
      weight = rng.range(0.9, 1.4); // Minor plates
    }

    // Euler pole: uniform random unit vector on sphere
    const z = rng.range(-1, 1);
    const phi = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const eulerPole: Vec3 = normalize3([r * Math.cos(phi), r * Math.sin(phi), z]);

    // Angular velocity: 0.0035 to 0.012 rad/Myr (~22 to 76 mm/yr at Earth equator)
    const speed = rng.range(0.0035, 0.012);
    const direction = rng.next() < 0.5 ? -1 : 1;
    const angularVelocityRadPerMyr = speed * direction;

    plates.push({
      id,
      name: `Plate ${id + 1}`,
      seedPosition,
      weight,
      eulerPole,
      angularVelocityRadPerMyr,
      color: DISTINCT_PLATE_COLORS[id % DISTINCT_PLATE_COLORS.length],
    });
  }

  return plates;
}

export interface PlateConnectivityResult {
  isConnected: boolean;
  componentCounts: number[];
  invalidPlates: number[];
}

/**
 * Validates full graph connectivity per plate using BFS over the cubed sphere dual graph.
 * Returns true only if every plate consists of exactly 1 connected component.
 */
export function validatePlateConnectivity(
  grid: CubedSphereGrid,
  primaryPlateIds: Uint16Array,
  plateCount: number,
): PlateConnectivityResult {
  const visited = new Uint8Array(grid.totalCells);
  const componentCounts = new Array(plateCount).fill(0);
  const invalidPlates: number[] = [];

  for (let p = 0; p < plateCount; p++) {
    for (let cell = 0; cell < grid.totalCells; cell++) {
      if (primaryPlateIds[cell] !== p || visited[cell]) continue;

      componentCounts[p]++;
      const queue: number[] = [cell];
      visited[cell] = 1;

      let head = 0;
      while (head < queue.length) {
        const curr = queue[head++];
        for (let dir = 0; dir < 4; dir++) {
          const nb = grid.neighbors[curr * 4 + dir];
          if (primaryPlateIds[nb] === p && !visited[nb]) {
            visited[nb] = 1;
            queue.push(nb);
          }
        }
      }
    }

    if (componentCounts[p] !== 1) {
      invalidPlates.push(p);
    }
  }

  return {
    isConnected: invalidPlates.length === 0,
    componentCounts,
    invalidPlates,
  };
}

/**
 * Assigns primary plate IDs using weighted spherical geodesic Voronoi partitioning,
 * and eliminates all disconnected satellite components via graph-component merging
 * to guarantee 100% single-component connectivity per plate.
 */
export function partitionGridPlates(
  grid: CubedSphereGrid,
  plates: RigidEulerPlate[],
): { primaryPlateId: Uint16Array; plateAreaFraction: Float32Array } {
  const totalCells = grid.totalCells;
  const numPlates = plates.length;
  const primaryPlateId = new Uint16Array(totalCells);

  // 1. Initial Voronoi assignment using weighted spherical distance
  for (let cell = 0; cell < totalCells; cell++) {
    const p: Vec3 = [
      grid.cellPositions[cell * 3],
      grid.cellPositions[cell * 3 + 1],
      grid.cellPositions[cell * 3 + 2],
    ];

    let minWeightedDistance = Infinity;
    let bestPlate = 0;

    for (let i = 0; i < numPlates; i++) {
      const plate = plates[i];
      const d = dot3(p, plate.seedPosition);
      const angle = Math.acos(Math.max(-1, Math.min(1, d)));
      const weightedDist = angle / plate.weight;
      if (weightedDist < minWeightedDistance) {
        minWeightedDistance = weightedDist;
        bestPlate = plate.id;
      }
    }
    primaryPlateId[cell] = bestPlate;
  }

  // 2. Full connected component topological resolution
  for (let iter = 0; iter < 10; iter++) {
    let hasMerged = false;

    for (let p = 0; p < numPlates; p++) {
      // Find all connected components of plate p
      const visited = new Uint8Array(totalCells);
      const components: number[][] = [];

      for (let cell = 0; cell < totalCells; cell++) {
        if (primaryPlateId[cell] !== p || visited[cell]) continue;

        const comp: number[] = [cell];
        visited[cell] = 1;
        let head = 0;

        while (head < comp.length) {
          const curr = comp[head++];
          for (let dir = 0; dir < 4; dir++) {
            const nb = grid.neighbors[curr * 4 + dir];
            if (primaryPlateId[nb] === p && !visited[nb]) {
              visited[nb] = 1;
              comp.push(nb);
            }
          }
        }
        components.push(comp);
      }

      // If plate p has multiple disconnected components
      if (components.length > 1) {
        // Sort descending by size: keep largest component [0]
        components.sort((a, b) => b.length - a.length);

        // Merge all smaller components into their surrounding majority neighbor plate
        for (let cIdx = 1; cIdx < components.length; cIdx++) {
          const minorComp = components[cIdx];
          hasMerged = true;

          // Find adjacent neighbor plate frequencies around this minor component
          const neighborCounts: Record<number, number> = {};
          for (const cell of minorComp) {
            for (let dir = 0; dir < 4; dir++) {
              const nb = grid.neighbors[cell * 4 + dir];
              const nbPid = primaryPlateId[nb];
              if (nbPid !== p) {
                neighborCounts[nbPid] = (neighborCounts[nbPid] || 0) + 1;
              }
            }
          }

          let bestReplacementPid = (p + 1) % numPlates;
          let maxCount = 0;
          for (const nbPidStr in neighborCounts) {
            const count = neighborCounts[nbPidStr];
            if (count > maxCount) {
              maxCount = count;
              bestReplacementPid = Number(nbPidStr);
            }
          }

          // Reassign all cells in the minor component
          for (const cell of minorComp) {
            primaryPlateId[cell] = bestReplacementPid;
          }
        }
      }
    }

    if (!hasMerged) break;
  }

  // 3. Initialize initial ownership fractions (1.0 for assigned plate, 0.0 for others)
  const plateAreaFraction = new Float32Array(totalCells * numPlates);
  for (let cell = 0; cell < totalCells; cell++) {
    const pid = primaryPlateId[cell];
    plateAreaFraction[cell * numPlates + pid] = 1.0;
  }

  return { primaryPlateId, plateAreaFraction };
}

/**
 * Creates rigid plates, assigns cells to plates and initializes crust.
 */
import { dot3, normalize3, type Vec3 } from '../../geometry/coordinates';
import type { CubedSphereGrid } from '../../geometry/cubedSphere';
import { Mulberry32 } from '../../utils/rng';
import {
  CRUST_CONTINENTAL,
  CRUST_OCEANIC,
  type CrustState,
  type PlateCoreConfig,
  type RigidPlate,
} from './types';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function fibonacciDirection(index: number, count: number): Vec3 {
  const z = 1 - (2 * index + 1) / count;
  const radius = Math.sqrt(Math.max(0, 1 - z * z));
  const longitude = index * GOLDEN_ANGLE;
  return [radius * Math.cos(longitude), radius * Math.sin(longitude), z];
}

function tangentOffset(center: Vec3, angle: number, azimuth: number): Vec3 {
  let east = normalize3([-center[1], center[0], 0]);
  if (Math.hypot(east[0], east[1], east[2]) < 0.5) east = [1, 0, 0];
  const north: Vec3 = [
    center[1] * east[2] - center[2] * east[1],
    center[2] * east[0] - center[0] * east[2],
    center[0] * east[1] - center[1] * east[0],
  ];
  const tangent: Vec3 = [
    east[0] * Math.cos(azimuth) + north[0] * Math.sin(azimuth),
    east[1] * Math.cos(azimuth) + north[1] * Math.sin(azimuth),
    east[2] * Math.cos(azimuth) + north[2] * Math.sin(azimuth),
  ];
  return normalize3([
    center[0] * Math.cos(angle) + tangent[0] * Math.sin(angle),
    center[1] * Math.cos(angle) + tangent[1] * Math.sin(angle),
    center[2] * Math.cos(angle) + tangent[2] * Math.sin(angle),
  ]);
}

export function createRigidPlates(config: PlateCoreConfig): RigidPlate[] {
  const count = Math.max(4, Math.min(32, Math.floor(config.plateCount)));
  const rng = new Mulberry32(config.seed ^ 0x6a09e667);
  const plates: RigidPlate[] = [];

  for (let id = 0; id < count; id++) {
    const base = fibonacciDirection(id, count);
    const seedPosition = tangentOffset(base, rng.range(0, 0.12), rng.range(0, Math.PI * 2));
    const pole = normalize3([
      rng.range(-1, 1),
      rng.range(-1, 1),
      rng.range(-1, 1),
    ]);
    const speed = rng.range(0.0035, 0.0105);
    plates.push({
      id,
      seedPosition,
      eulerPole: pole,
      angularVelocityRadPerMyr: speed * (rng.next() < 0.5 ? -1 : 1),
    });
  }
  return plates;
}

export function assignPlateIds(grid: CubedSphereGrid, plates: RigidPlate[]): Uint16Array {
  const plateId = new Uint16Array(grid.totalCells);
  for (let cell = 0; cell < grid.totalCells; cell++) {
    const p: Vec3 = [
      grid.cellPositions[cell * 3],
      grid.cellPositions[cell * 3 + 1],
      grid.cellPositions[cell * 3 + 2],
    ];
    let bestDot = -Infinity;
    let bestPlate = 0;
    for (const plate of plates) {
      const score = dot3(p, plate.seedPosition);
      if (score > bestDot) {
        bestDot = score;
        bestPlate = plate.id;
      }
    }
    plateId[cell] = bestPlate;
  }
  return plateId;
}

interface ContinentalLobe {
  center: Vec3;
  radiusRad: number;
}

function createContinentalLobes(plates: RigidPlate[], config: PlateCoreConfig): ContinentalLobe[] {
  const rng = new Mulberry32(config.seed ^ 0xbb67ae85);
  const shuffled = plates.map((plate) => plate.id);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.rangeInt(0, i);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const continentalPlateCount = Math.max(2, Math.round(plates.length * 0.48));
  const lobes: ContinentalLobe[] = [];
  for (let i = 0; i < continentalPlateCount; i++) {
    const plate = plates[shuffled[i]] ?? plates[0];
    if (!plate) continue;
    const mainRadius = rng.range(0.38, 0.58);
    lobes.push({ center: plate.seedPosition, radiusRad: mainRadius });
    const satelliteCount = rng.rangeInt(1, 3);
    for (let lobe = 0; lobe < satelliteCount; lobe++) {
      lobes.push({
        center: tangentOffset(
          plate.seedPosition,
          mainRadius * rng.range(0.35, 0.70),
          rng.range(0, Math.PI * 2),
        ),
        radiusRad: mainRadius * rng.range(0.45, 0.72),
      });
    }
  }
  return lobes;
}

export function initializeCrust(
  grid: CubedSphereGrid,
  plates: RigidPlate[],
  plateId: Uint16Array,
  config: PlateCoreConfig,
): CrustState {
  const lobes = createContinentalLobes(plates, config);
  const score = new Float32Array(grid.totalCells);

  for (let cell = 0; cell < grid.totalCells; cell++) {
    const p: Vec3 = [
      grid.cellPositions[cell * 3],
      grid.cellPositions[cell * 3 + 1],
      grid.cellPositions[cell * 3 + 2],
    ];
    let best = 0;
    for (const lobe of lobes) {
      const distance = Math.acos(Math.max(-1, Math.min(1, dot3(p, lobe.center))));
      const normalized = distance / lobe.radiusRad;
      if (normalized < 1) {
        const compactSupport = 1 - 3 * normalized * normalized + 2 * normalized * normalized * normalized;
        best = Math.max(best, compactSupport);
      }
    }
    score[cell] = best;
  }

  const indices = new Int32Array(grid.totalCells);
  for (let i = 0; i < grid.totalCells; i++) indices[i] = i;
  indices.sort((a, b) => score[b] - score[a] || a - b);

  const continentalCells = Math.max(1, Math.min(grid.totalCells - 1, Math.round(config.continentalFraction * grid.totalCells)));
  const isContinental = new Uint8Array(grid.totalCells);
  for (let i = 0; i < continentalCells; i++) isContinental[indices[i]] = 1;

  const crustType = new Uint8Array(grid.totalCells);
  const continentalThicknessM = new Float32Array(grid.totalCells);
  const oceanicThicknessM = new Float32Array(grid.totalCells);
  const arcThicknessM = new Float32Array(grid.totalCells);
  const oceanicAgeMyr = new Float32Array(grid.totalCells);

  for (let cell = 0; cell < grid.totalCells; cell++) {
    if (isContinental[cell]) {
      crustType[cell] = CRUST_CONTINENTAL;
      continentalThicknessM[cell] = 32_000 + 8_000 * Math.min(1, score[cell]);
      oceanicAgeMyr[cell] = 0;
    } else {
      crustType[cell] = CRUST_OCEANIC;
      oceanicThicknessM[cell] = 7_000;
      oceanicAgeMyr[cell] = 100;
    }
  }

  return {
    plateId: new Uint16Array(plateId),
    crustType,
    continentalThicknessM,
    oceanicThicknessM,
    arcThicknessM,
    oceanicAgeMyr,
  };
}

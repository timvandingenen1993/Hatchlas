/**
 * Initial continental material and thickness, and classification of geological boundaries.
 */
import { normalize3, type Vec3 } from '../../geometry/coordinates';
import type { CubedSphereGrid } from '../../geometry/cubedSphere';
import {
  GEOLOGICAL_BOUNDARY_COLLISION,
  GEOLOGICAL_BOUNDARY_NONE,
  GEOLOGICAL_BOUNDARY_RIDGE,
  GEOLOGICAL_BOUNDARY_RIFT,
  GEOLOGICAL_BOUNDARY_SUBDUCTION,
  GEOLOGICAL_BOUNDARY_TRANSFORM,
  KINEMATIC_BOUNDARY_CONVERGENT,
  KINEMATIC_BOUNDARY_DIVERGENT,
  type KinematicBoundaryField,
  type PlateStateReservoirs,
  type RigidEulerPlate,
} from './types';

export const DEFAULT_CONTINENTAL_THICKNESS_M = 35_000;

function proceduralDirection(seed: number, plateId: number): Vec3 {
  const phase = seed * 0.754877666 + plateId * 2.39996323;
  return normalize3([
    Math.sin(phase * 1.17 + 0.3),
    Math.sin(phase * 1.73 + 2.1),
    Math.cos(phase * 1.31 - 0.7),
  ]);
}

/**
 * Deterministic procedural initial condition for Phase 2 continental material.
 *
 * This is not a tectonic reconstruction. Each plate receives the configured
 * fraction of its initial owned area, preferentially in its interior. A final
 * partially filled cell makes the requested area exact without normalization.
 */
export function initializeContinentalMaterial(
  grid: CubedSphereGrid,
  plates: RigidEulerPlate[],
  plateAreaFraction: Float32Array | Float64Array,
  requestedFraction = 0.35,
  thicknessM = DEFAULT_CONTINENTAL_THICKNESS_M,
  seed = 0,
): Float64Array {
  const plateCount = plates.length;
  const valueCount = grid.totalCells * plateCount;
  const result = new Float64Array(valueCount);
  const fraction = Math.max(0, Math.min(1, Number.isFinite(requestedFraction) ? requestedFraction : 0.35));
  if (fraction === 0) return result;
  if (!Number.isFinite(thicknessM) || thicknessM <= 0) {
    throw new Error(`Continental reference thickness must be positive: ${thicknessM}`);
  }

  const ownedAreaByPlate = new Float64Array(plateCount);
  const remainingAreaByPlate = new Float64Array(plateCount);
  const score = new Float64Array(grid.totalCells);
  const order = new Int32Array(grid.totalCells);
  const directions = plates.map((plate) => proceduralDirection(seed, plate.id));

  for (let cell = 0; cell < grid.totalCells; cell++) {
    order[cell] = cell;
    const base = cell * plateCount;
    let owner = 0;
    let ownerFraction = -Infinity;
    for (let plate = 0; plate < plateCount; plate++) {
      const owned = plateAreaFraction[base + plate];
      ownedAreaByPlate[plate] += owned * grid.cellAreas[cell];
      if (owned > ownerFraction) {
        ownerFraction = owned;
        owner = plate;
      }
    }
    const k = cell * 3;
    const p = plates[owner];
    const d = directions[owner];
    const x = grid.cellPositions[k];
    const y = grid.cellPositions[k + 1];
    const z = grid.cellPositions[k + 2];
    const interior = x * p.seedPosition[0] + y * p.seedPosition[1] + z * p.seedPosition[2];
    const lobe = x * d[0] + y * d[1] + z * d[2];
    const texture = Math.sin((x + owner * 0.17) * 11.0)
      * Math.cos((y - owner * 0.11) * 9.0)
      * Math.sin((z + owner * 0.07) * 7.0);
    score[cell] = interior * 0.68 + lobe * 0.24 + texture * 0.08;
  }
  for (let plate = 0; plate < plateCount; plate++) {
    remainingAreaByPlate[plate] = ownedAreaByPlate[plate] * fraction;
  }

  order.sort((a, b) => score[b] - score[a] || a - b);
  for (let rank = 0; rank < order.length; rank++) {
    const cell = order[rank];
    const area = grid.cellAreas[cell];
    const base = cell * plateCount;
    for (let plate = 0; plate < plateCount; plate++) {
      const remaining = remainingAreaByPlate[plate];
      if (remaining <= 0) continue;
      const availableArea = plateAreaFraction[base + plate] * area;
      if (availableArea <= 0) continue;
      const continentalArea = Math.min(availableArea, remaining);
      result[base + plate] = continentalArea * thicknessM;
      remainingAreaByPlate[plate] -= continentalArea;
    }
  }
  return result;
}

/** Geological interpretation of the kinematic edges using active material. */
export function classifyGeologicalBoundaries(
  boundaryField: KinematicBoundaryField,
  reservoirs: PlateStateReservoirs,
): Uint8Array {
  const result = new Uint8Array(reservoirs.totalCells);
  const strongest = new Float32Array(reservoirs.totalCells);
  const plateCount = reservoirs.plateCount;
  for (const edge of boundaryField.edges) {
    const volumeA = reservoirs.continentalVolumeM3[edge.cellA * plateCount + edge.plateA] ?? 0;
    const volumeB = reservoirs.continentalVolumeM3[edge.cellB * plateCount + edge.plateB] ?? 0;
    const continentalA = volumeA > 0;
    const continentalB = volumeB > 0;
    let geologicalType = GEOLOGICAL_BOUNDARY_NONE;
    if (edge.kinematicType === KINEMATIC_BOUNDARY_CONVERGENT) {
      geologicalType = continentalA && continentalB
        ? GEOLOGICAL_BOUNDARY_COLLISION
        : GEOLOGICAL_BOUNDARY_SUBDUCTION;
    } else if (edge.kinematicType === KINEMATIC_BOUNDARY_DIVERGENT) {
      geologicalType = continentalA || continentalB
        ? GEOLOGICAL_BOUNDARY_RIFT
        : GEOLOGICAL_BOUNDARY_RIDGE;
    } else {
      geologicalType = GEOLOGICAL_BOUNDARY_TRANSFORM;
    }
    edge.geologicalType = geologicalType;
    const magnitude = Math.max(Math.abs(edge.normalVelocityMmYr), edge.shearVelocityMmYr);
    for (const cell of [edge.cellA, edge.cellB]) {
      if (magnitude >= strongest[cell]) {
        strongest[cell] = magnitude;
        result[cell] = geologicalType;
      }
    }
  }
  return result;
}

export function sumContinentalVolume(volume: Float64Array): number {
  let total = 0;
  for (let index = 0; index < volume.length; index++) total += volume[index];
  return total;
}

export function deriveContinentalThickness(
  grid: CubedSphereGrid,
  reservoirs: PlateStateReservoirs,
  target = new Float32Array(grid.totalCells),
): Float32Array {
  if (target.length !== grid.totalCells) throw new Error('Continental thickness target has invalid length');
  const plateCount = reservoirs.plateCount;
  for (let cell = 0; cell < grid.totalCells; cell++) {
    let volume = 0;
    const base = cell * plateCount;
    for (let plate = 0; plate < plateCount; plate++) {
      volume += reservoirs.continentalVolumeM3[base + plate] ?? 0;
    }
    target[cell] = volume / grid.cellAreas[cell];
  }
  return target;
}

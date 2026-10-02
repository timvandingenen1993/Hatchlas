/**
 * Uplift fields for mountain belts from collision and subduction boundaries.
 */
import { cellCenterDistanceMeters, type CubedSphereGrid } from '../geometry/cubedSphere';
import type { TectonicPlateData } from '../types/worldV2';
import {
  BOUNDARY_COLLISION,
  BOUNDARY_SUBDUCTION,
  classifyPlateBoundaries,
  type BoundaryKinematicsResult,
} from './plateKinematics';

interface FrontState {
  cell: number;
  distanceM: number;
  amplitude: number;
  plateId: number;
}

class FrontHeap {
  private readonly values: FrontState[] = [];

  get length(): number { return this.values.length; }

  push(value: FrontState): void {
    let index = this.values.length;
    this.values.push(value);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent].distanceM <= value.distanceM) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): FrontState {
    const first = this.values[0];
    const last = this.values.pop()!;
    if (this.values.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= this.values.length) break;
        const right = left + 1;
        const child = right < this.values.length && this.values[right].distanceM < this.values[left].distanceM
          ? right
          : left;
        if (this.values[child].distanceM >= last.distanceM) break;
        this.values[index] = this.values[child];
        index = child;
      }
      this.values[index] = last;
    }
    return first;
  }
}

function propagateFront(
  grid: CubedSphereGrid,
  plateIds: Uint8Array,
  seeds: FrontState[],
  maximumDistanceM: number,
): { distanceM: Float64Array; amplitude: Float32Array } {
  const distanceM = new Float64Array(grid.totalCells);
  distanceM.fill(Infinity);
  const amplitude = new Float32Array(grid.totalCells);
  const sourcePlate = new Int16Array(grid.totalCells);
  sourcePlate.fill(-1);
  const heap = new FrontHeap();

  for (const seed of seeds) {
    if (seed.amplitude <= amplitude[seed.cell] && distanceM[seed.cell] === 0) continue;
    distanceM[seed.cell] = 0;
    amplitude[seed.cell] = Math.max(amplitude[seed.cell], seed.amplitude);
    sourcePlate[seed.cell] = seed.plateId;
    heap.push(seed);
  }

  while (heap.length > 0) {
    const current = heap.pop();
    if (current.distanceM !== distanceM[current.cell] || current.plateId !== sourcePlate[current.cell]) continue;
    for (let edge = 0; edge < 4; edge++) {
      const neighbor = grid.neighbors[current.cell * 4 + edge];
      if (plateIds[neighbor] !== current.plateId) continue;
      const nextDistance = current.distanceM + cellCenterDistanceMeters(grid, current.cell, neighbor);
      if (nextDistance > maximumDistanceM) continue;
      if (nextDistance < distanceM[neighbor]) {
        distanceM[neighbor] = nextDistance;
        amplitude[neighbor] = current.amplitude;
        sourcePlate[neighbor] = current.plateId;
        heap.push({ cell: neighbor, distanceM: nextDistance, amplitude: current.amplitude, plateId: current.plateId });
      } else if (Math.abs(nextDistance - distanceM[neighbor]) < grid.minCellDistanceM && current.amplitude > amplitude[neighbor]) {
        amplitude[neighbor] = current.amplitude;
      }
    }
  }
  return { distanceM, amplitude };
}

/**
 * Construct finite-width orogenic forcing on the actual output grid.
 * Collision belts occupy 150 km on each plate. Subduction arcs occur only on
 * the overriding plate and peak 166 km landward of the trench.
 */
export function buildMetricOrogenicUplift(
  grid: CubedSphereGrid,
  plates: TectonicPlateData[],
  plateIds: Uint8Array,
  crustType: Uint8Array,
  crustAge: Float32Array,
  maximumUpliftRateMmYr: number,
): { upliftRate: Float32Array; kinematics: BoundaryKinematicsResult } {
  const kinematics = classifyPlateBoundaries(grid, plates, plateIds, crustType, crustAge);
  const collisionSeeds: FrontState[] = [];
  const subductionSeeds: FrontState[] = [];

  for (const edge of kinematics.edges) {
    const amplitude = Math.max(0, maximumUpliftRateMmYr)
      * Math.min(1, Math.max(0, -edge.normalVelocityMmYr) / 50);
    if (amplitude === 0) continue;
    if (edge.type === BOUNDARY_COLLISION) {
      collisionSeeds.push({ cell: edge.cellA, distanceM: 0, amplitude, plateId: edge.plateA });
      collisionSeeds.push({ cell: edge.cellB, distanceM: 0, amplitude, plateId: edge.plateB });
    } else if (edge.type === BOUNDARY_SUBDUCTION) {
      const overridingCell = edge.overridingPlateId === edge.plateA ? edge.cellA : edge.cellB;
      subductionSeeds.push({
        cell: overridingCell,
        distanceM: 0,
        amplitude,
        plateId: edge.overridingPlateId,
      });
    }
  }

  const collision = propagateFront(grid, plateIds, collisionSeeds, 150_000);
  const subduction = propagateFront(grid, plateIds, subductionSeeds, 346_000);
  const upliftRate = new Float32Array(grid.totalCells);

  for (let idx = 0; idx < grid.totalCells; idx++) {
    if (Number.isFinite(collision.distanceM[idx])) {
      const x = Math.min(1, collision.distanceM[idx] / 150_000);
      const profile = 1 - 3 * x * x + 2 * x * x * x;
      upliftRate[idx] = collision.amplitude[idx] * profile;
    }
    if (Number.isFinite(subduction.distanceM[idx])) {
      const normalized = (subduction.distanceM[idx] - 166_000) / 60_000;
      const profile = Math.exp(-0.5 * normalized * normalized);
      upliftRate[idx] = Math.max(upliftRate[idx], subduction.amplitude[idx] * profile);
    }
  }

  return { upliftRate, kinematics };
}

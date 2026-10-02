/**
 * Estimates seafloor age by spreading it outward from ridges along plate motion.
 */
import { cellCenterDistanceMeters, type CubedSphereGrid } from '../geometry/cubedSphere';
import { BOUNDARY_RIDGE, type BoundaryKinematicsResult } from './plateKinematics';

interface AgeState { cell: number; ageMyr: number; speedMPerMyr: number; plateId: number }

/** Metric ridge-to-cell travel time using the local half-spreading velocity. */
export function solveOceanicCrustAge(
  grid: CubedSphereGrid,
  plateIds: Uint8Array,
  crustType: Uint8Array,
  inheritedAge: Float32Array,
  kinematics: BoundaryKinematicsResult,
): Float32Array {
  const result = new Float32Array(inheritedAge);
  const bestAge = new Float64Array(grid.totalCells);
  bestAge.fill(Infinity);
  const heap: AgeState[] = [];

  const push = (state: AgeState): void => {
    let index = heap.length;
    heap.push(state);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (heap[parent].ageMyr <= state.ageMyr) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = state;
  };
  const pop = (): AgeState => {
    const first = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= heap.length) break;
        const right = left + 1;
        const child = right < heap.length && heap[right].ageMyr < heap[left].ageMyr ? right : left;
        if (heap[child].ageMyr >= last.ageMyr) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = last;
    }
    return first;
  };

  for (let idx = 0; idx < grid.totalCells; idx++) {
    if (crustType[idx] !== 0 || kinematics.boundaryType[idx] !== BOUNDARY_RIDGE) continue;
    const halfSpreadingMmYr = Math.max(5, Math.max(0, kinematics.normalVelocity[idx]) * 0.5);
    const state = { cell: idx, ageMyr: 0, speedMPerMyr: halfSpreadingMmYr * 1000, plateId: plateIds[idx] };
    bestAge[idx] = 0;
    push(state);
  }

  while (heap.length > 0) {
    const current = pop();
    if (current.ageMyr !== bestAge[current.cell] || current.ageMyr > 80) continue;
    for (let edge = 0; edge < 4; edge++) {
      const neighbor = grid.neighbors[current.cell * 4 + edge];
      if (crustType[neighbor] !== 0 || plateIds[neighbor] !== current.plateId) continue;
      const travelMyr = cellCenterDistanceMeters(grid, current.cell, neighbor) / current.speedMPerMyr;
      const nextAge = current.ageMyr + travelMyr;
      if (nextAge < bestAge[neighbor] && nextAge <= 80) {
        bestAge[neighbor] = nextAge;
        push({ ...current, cell: neighbor, ageMyr: nextAge });
      }
    }
  }

  for (let idx = 0; idx < grid.totalCells; idx++) {
    if (crustType[idx] === 0) result[idx] = Number.isFinite(bestAge[idx]) ? bestAge[idx] : 80;
  }
  return result;
}

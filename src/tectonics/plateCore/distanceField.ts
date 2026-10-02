/**
 * Geodesic distance fields from boundary seeds, constrained to stay within a plate.
 */
import { cellCenterDistanceMeters, type CubedSphereGrid } from '../../geometry/cubedSphere';

export interface DistanceSeed {
  cell: number;
  plateId: number;
  strength: number;
}

export interface PlateDistanceField {
  distanceM: Float64Array;
  sourceStrength: Float32Array;
  sourcePlateId: Int16Array;
}

export function plateConstrainedDistanceField(
  grid: CubedSphereGrid,
  plateId: Uint16Array,
  seeds: DistanceSeed[],
  maxDistanceM: number,
  allowed?: (cell: number) => boolean,
): PlateDistanceField {
  const distanceM = new Float64Array(grid.totalCells);
  distanceM.fill(Infinity);
  const sourceStrength = new Float32Array(grid.totalCells);
  const sourcePlateId = new Int16Array(grid.totalCells);
  sourcePlateId.fill(-1);

  // Flat binary min-heap with zero object allocations
  let heapSize = 0;
  const initialCap = Math.max(1024, seeds.length * 4);
  let heapCell = new Int32Array(initialCap);
  let heapDist = new Float64Array(initialCap);

  let outCell = 0;
  let outDist = 0;

  const push = (cell: number, dist: number): void => {
    if (heapSize >= heapCell.length) {
      const newCap = heapCell.length * 2;
      const newCell = new Int32Array(newCap);
      const newDist = new Float64Array(newCap);
      newCell.set(heapCell);
      newDist.set(heapDist);
      heapCell = newCell;
      heapDist = newDist;
    }
    let child = heapSize++;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (heapDist[parent] <= dist) break;
      heapCell[child] = heapCell[parent];
      heapDist[child] = heapDist[parent];
      child = parent;
    }
    heapCell[child] = cell;
    heapDist[child] = dist;
  };

  const pop = (): boolean => {
    if (heapSize <= 0) return false;
    outCell = heapCell[0];
    outDist = heapDist[0];
    heapSize--;
    if (heapSize > 0) {
      const tailCell = heapCell[heapSize];
      const tailDist = heapDist[heapSize];
      let parent = 0;
      while (true) {
        const left = parent * 2 + 1;
        if (left >= heapSize) break;
        const right = left + 1;
        const child = right < heapSize && heapDist[right] < heapDist[left] ? right : left;
        if (heapDist[child] >= tailDist) break;
        heapCell[parent] = heapCell[child];
        heapDist[parent] = heapDist[child];
        parent = child;
      }
      heapCell[parent] = tailCell;
      heapDist[parent] = tailDist;
    }
    return true;
  };

  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    if (plateId[seed.cell] !== seed.plateId || (allowed && !allowed(seed.cell))) continue;
    if (distanceM[seed.cell] === 0 && sourceStrength[seed.cell] >= seed.strength) continue;
    distanceM[seed.cell] = 0;
    sourceStrength[seed.cell] = seed.strength;
    sourcePlateId[seed.cell] = seed.plateId;
    push(seed.cell, 0);
  }

  while (pop()) {
    const currentCell = outCell;
    const currentDist = outDist;
    if (currentDist !== distanceM[currentCell] || currentDist >= maxDistanceM) continue;

    const sourcePlate = sourcePlateId[currentCell];
    for (let direction = 0; direction < 4; direction++) {
      const neighbor = grid.neighbors[currentCell * 4 + direction];
      if (plateId[neighbor] !== sourcePlate || (allowed && !allowed(neighbor))) continue;
      const candidate = currentDist + cellCenterDistanceMeters(grid, currentCell, neighbor);
      if (candidate > maxDistanceM || candidate >= distanceM[neighbor]) continue;
      distanceM[neighbor] = candidate;
      sourceStrength[neighbor] = sourceStrength[currentCell];
      sourcePlateId[neighbor] = sourcePlate;
      push(neighbor, candidate);
    }
  }

  return { distanceM, sourceStrength, sourcePlateId };
}

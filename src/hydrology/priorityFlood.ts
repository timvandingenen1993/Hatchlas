import type { CubedSphereGrid } from '../geometry/cubedSphere';
import type { LakeData } from '../types/worldV2';

/**
 * Min-Heap Priority Queue for Priority-Flood on Cubed Sphere
 */
class MinHeap {
  private indices: Int32Array;
  private priorities: Float32Array;
  public size: number = 0;

  constructor(capacity: number) {
    this.indices = new Int32Array(capacity);
    this.priorities = new Float32Array(capacity);
  }

  push(index: number, priority: number): void {
    let i = this.size++;
    this.indices[i] = index;
    this.priorities[i] = priority;

    // Sift up
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.priorities[i] < this.priorities[p]) {
        const tmpIdx = this.indices[i];
        const tmpPri = this.priorities[i];
        this.indices[i] = this.indices[p];
        this.priorities[i] = this.priorities[p];
        this.indices[p] = tmpIdx;
        this.priorities[p] = tmpPri;
        i = p;
      } else {
        break;
      }
    }
  }

  pop(): { index: number; priority: number } {
    const topIdx = this.indices[0];
    const topPri = this.priorities[0];

    this.size--;
    if (this.size > 0) {
      this.indices[0] = this.indices[this.size];
      this.priorities[0] = this.priorities[this.size];

      // Sift down
      let i = 0;
      while (true) {
        let smallest = i;
        const left = (i << 1) + 1;
        const right = left + 1;

        if (left < this.size && this.priorities[left] < this.priorities[smallest]) {
          smallest = left;
        }
        if (right < this.size && this.priorities[right] < this.priorities[smallest]) {
          smallest = right;
        }

        if (smallest !== i) {
          const tmpIdx = this.indices[i];
          const tmpPri = this.priorities[i];
          this.indices[i] = this.indices[smallest];
          this.priorities[i] = this.priorities[smallest];
          this.indices[smallest] = tmpIdx;
          this.priorities[smallest] = tmpPri;
          i = smallest;
        } else {
          break;
        }
      }
    }

    return { index: topIdx, priority: topPri };
  }
}

// A fixed epsilon can disappear when the filled DEM is stored at kilometre-
// scale elevations. Use the next representable Float32 value instead.
function nextFloat32Above(x: number): number {
  if (!Number.isFinite(x)) return x;
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, x, true);
  let bits = view.getUint32(0, true);
  if (x >= 0) bits += 1;
  else if (bits > 0) bits -= 1;
  view.setUint32(0, bits >>> 0, true);
  return view.getFloat32(0, true);
}

export interface PriorityFloodResult {
  filledElevation: Float32Array; // Hydro-conditioned depression-free elevation
  isLakeMask: Uint8Array;        // 1 if submerged in a lake, 0 otherwise
  lakes: LakeData[];             // Explicit lake polygons
}

/**
 * Priority-Flood Depression Filling & Topographic Lake Identification
 * 
 * Note: Implements the Priority-Flood algorithm (Barnes et al. 2014) adapted to the
 * cubed-sphere mesh with a min-heap priority queue seeded from oceanic / base-level cells.
 * Depressions are hydro-conditioned to guarantee monotonic drainage, and flooded
 * contiguous components are extracted as topographic lake features.
 * 
 * Reference:
 * Barnes, Lehman & Mulla (2014), "Priority-flood: An optimal depression-filling and flow-routing algorithm", Comput. Geosci.
 */
export function runPriorityFlood(
  grid: CubedSphereGrid,
  elevation: Float32Array,
  seaLevelMeters: number = 0,
  annualPrecipitationMm?: Float32Array,
  annualEvaporationMm?: Float32Array,
): PriorityFloodResult {
  const totalCells = grid.totalCells;
  const filledElevation = new Float32Array(elevation);
  const visited = new Uint8Array(totalCells);
  const isLakeMask = new Uint8Array(totalCells);
  const lakes: LakeData[] = [];

  const heap = new MinHeap(totalCells);

  // 1. Seed heap with all ocean cells (elevation <= seaLevel)
  for (let idx = 0; idx < totalCells; idx++) {
    if (elevation[idx] <= seaLevelMeters) {
      heap.push(idx, elevation[idx]);
      visited[idx] = 1;
    }
  }

  // If no ocean cells (entirely land world), seed with the global minimum elevation cell
  if (heap.size === 0) {
    let minIdx = 0;
    let minElev = elevation[0];
    for (let idx = 1; idx < totalCells; idx++) {
      if (elevation[idx] < minElev) {
        minElev = elevation[idx];
        minIdx = idx;
      }
    }
    heap.push(minIdx, minElev);
    visited[minIdx] = 1;
  }

  // 2. Expand priority front inward
  while (heap.size > 0) {
    const { index: curr, priority: waterH } = heap.pop();

    for (let k = 0; k < 4; k++) {
      const nIdx = grid.neighbors[curr * 4 + k];
      if (visited[nIdx] === 0) {
        visited[nIdx] = 1;
        const origH = elevation[nIdx];
        if (origH < waterH) {
          // True depression pit: fill to spill level with minimal acyclic DAG gradient
          const baseH = Math.max(waterH, filledElevation[curr]);
          filledElevation[nIdx] = nextFloat32Above(baseH);
          // Mark as candidate lake only if depression depth exceeds 1.5m
          if (waterH - origH > 1.5) {
            isLakeMask[nIdx] = 1;
          }
          heap.push(nIdx, waterH);
        } else {
          // Normal sloping terrain
          filledElevation[nIdx] = origH;
          heap.push(nIdx, origH);
        }
      }
    }
  }

  // 3. Extract discrete lake polygons with spill points
  const lakeVisited = new Uint8Array(totalCells);
  const validatedLakeMask = new Uint8Array(totalCells);
  let nextLakeId = 1;

  for (let idx = 0; idx < totalCells; idx++) {
    if (isLakeMask[idx] === 1 && lakeVisited[idx] === 0 && elevation[idx] > seaLevelMeters) {
      const lakeCells: number[] = [];
      const queue = [idx];
      lakeVisited[idx] = 1;
      let minBed = elevation[idx];
      let maxSpill = filledElevation[idx];
      let spillNode = -1;
      let spillLevel = Infinity;

      for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
        const c = queue[queueIndex];
        lakeCells.push(c);
        if (elevation[c] < minBed) minBed = elevation[c];
        if (filledElevation[c] > maxSpill) maxSpill = filledElevation[c];

        for (let k = 0; k < 4; k++) {
          const nIdx = grid.neighbors[c * 4 + k];
          if (isLakeMask[nIdx] === 1 && lakeVisited[nIdx] === 0) {
            lakeVisited[nIdx] = 1;
            queue.push(nIdx);
          } else if (isLakeMask[nIdx] === 0) {
            const candidateLevel = filledElevation[nIdx];
            if (candidateLevel < spillLevel) {
              spillLevel = candidateLevel;
              spillNode = nIdx;
            }
          }
        }
      }

      const physicalWaterLevel = spillLevel < Infinity ? spillLevel : maxSpill;

      let annualNetInflowM3 = 0.0;
      if (annualPrecipitationMm && annualEvaporationMm) {
        for (const c of lakeCells) {
          annualNetInflowM3 += Math.max(0.0, annualPrecipitationMm[c] - annualEvaporationMm[c]) / 1000.0 * grid.cellAreas[c];
        }
      } else {
        // Without climate fields this remains a topographic depression
        // diagnostic, preserving backwards-compatible geometry tooling.
        annualNetInflowM3 = Infinity;
      }

      // Valid lake must have at least 3 cells and genuine water depth
      if (lakeCells.length >= 3 && (physicalWaterLevel - minBed) >= 2.0 && annualNetInflowM3 > 0.0) {
        let estVolume = 0;
        for (const c of lakeCells) {
          const depth = Math.max(0, physicalWaterLevel - elevation[c]);
          estVolume += depth * grid.cellAreas[c];
          validatedLakeMask[c] = 1;
        }

        lakes.push({
          id: nextLakeId++,
          cellIndices: lakeCells,
          bedElevation: minBed,
          waterLevel: physicalWaterLevel,
          volume: estVolume,
          annualNetInflowM3,
          spillCellIndex: spillNode >= 0 ? spillNode : idx,
          outletCellIndex: spillNode >= 0 ? spillNode : idx,
        });
      }
    }
  }

  return { filledElevation, isLakeMask: validatedLakeMask, lakes };
}

/**
 * Steepest-descent flow receivers and a topologically sorted order for discharge accumulation.
 */
import { cellCenterDistanceMeters, getCubedSphereNeighbor, type CubedSphereGrid } from '../geometry/cubedSphere';

const stencilCache = new WeakMap<object, Int32Array>();

function getRoutingStencil(grid: CubedSphereGrid): Int32Array {
  const cached = stencilCache.get(grid);
  if (cached) return cached;

  const stencil = new Int32Array(grid.totalCells * 8);
  let offset = 0;
  for (let idx = 0; idx < grid.totalCells; idx++) {
    for (const di of [-1, 0, 1] as const) {
      for (const dj of [-1, 0, 1] as const) {
        if (di === 0 && dj === 0) continue;
        stencil[offset++] = getCubedSphereNeighbor(grid, idx, di, dj);
      }
    }
  }
  stencilCache.set(grid, stencil);
  return stencil;
}

export interface FlowRoutingResult {
  flowReceivers: Int32Array;      // Directed acyclic flow receiver index (-1 for ocean/sinks)
  topologicalOrder: Int32Array;   // Cells sorted from highest mountain ridge down to coastal mouth
  slopes: Float32Array;           // Local hydraulic gradient magnitude (rise/run)
}

/**
 * Single-Flow Direction (SFD / D8-like) Steepest Descent & Topological DAG Routing
 * 
 * Note: Computes single steepest-descent flow receivers (SFD) over a seam-aware 8-neighborhood
 * and builds an acyclic directed graph sorted in
 * topological order via Kahn's algorithm for downstream flux accumulation.
 * 
 * References:
 * 1. O'Callaghan & Mark (1984), "The extraction of drainage networks from digital elevation data", Comput. Vision Graph. Image Process. - D8 steepest descent concept.
 * 2. Kahn (1962), "Topological sorting of large networks", Commun. ACM - Acyclic topological sorting.
 * 3. Salles (2019), "eSCAPE v2.0", Geosci. Model Dev. - DAG flow accumulation background.
 */
export function computeFlowRouting(
  grid: CubedSphereGrid,
  filledElevation: Float32Array,
  seaLevelMeters: number = 0
): FlowRoutingResult {
  const totalCells = grid.totalCells;
  const flowReceivers = new Int32Array(totalCells).fill(-1);
  const slopes = new Float32Array(totalCells);
  const inDegree = new Int32Array(totalCells);
  const routingStencil = getRoutingStencil(grid);

  // 1. Metric-Aware Steepest Descent Flow Routing
  for (let idx = 0; idx < totalCells; idx++) {
        const elev = filledElevation[idx];

        if (elev <= seaLevelMeters) {
          continue;
        }

        let maxSlope = 0.0;
        let bestNeighbor = -1;

        // Check all eight projected neighbors. The projection keeps diagonal
        // candidates continuous across cube-face seams.
        const stencilOffset = idx * 8;
        for (let candidate = 0; candidate < 8; candidate++) {
          const nIdx = routingStencil[stencilOffset + candidate];
          const nH = filledElevation[nIdx];
          if (nH < elev) {
            const distM = Math.max(1.0, cellCenterDistanceMeters(grid, idx, nIdx));
            const slope = (elev - nH) / distM;
            if (slope > maxSlope) {
              maxSlope = slope;
              bestNeighbor = nIdx;
            }
          }
        }

        if (bestNeighbor >= 0) {
          flowReceivers[idx] = bestNeighbor;
          inDegree[bestNeighbor]++;
          slopes[idx] = Math.max(0.0001, maxSlope);
        } else {
          slopes[idx] = 0.0001;
        }
  }

  // 2. Exact Topological Sort (Kahn's Algorithm for DAG)
  const topologicalOrder = new Int32Array(totalCells);
  let queueHead = 0;
  let queueTail = 0;

  // Enqueue all source nodes (cells with no incoming upstream runoff)
  for (let idx = 0; idx < totalCells; idx++) {
    if (inDegree[idx] === 0) {
      topologicalOrder[queueTail++] = idx;
    }
  }

  while (queueHead < queueTail) {
    const curr = topologicalOrder[queueHead++];
    const receiver = flowReceivers[curr];

    if (receiver >= 0) {
      inDegree[receiver]--;
      if (inDegree[receiver] === 0) {
        topologicalOrder[queueTail++] = receiver;
      }
    }
  }

  // A strictly descending receiver graph should always be acyclic. Do not
  // silently delete edges when this invariant is violated: that would lose
  // water and hide a topological defect from the caller.
  if (queueTail < totalCells) {
    throw new Error(`Flow routing receiver graph contains ${totalCells - queueTail} cyclic cells`);
  }

  return { flowReceivers, topologicalOrder, slopes };
}

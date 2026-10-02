/**
 * Accumulates discharge and drainage area down the flow-routing tree and labels drainage basins.
 */
import type { CubedSphereGrid } from '../geometry/cubedSphere';

export interface DrainageResult {
  discharge: Float32Array;      // River flow volume in m^3/s
  drainageAreaM2: Float64Array; // Physical contributing area routed through each cell
  strahlerOrder: Uint8Array;    // Strahler stream hierarchy order (1 to 6+)
  drainageBasin: Int32Array;    // Watershed ID per cell
}

/**
 * River Discharge Accumulation, Strahler Stream Ordering & Watershed Drainage Basins
 * References:
 * 1. Génevaux et al. (2013), "Terrain Generation using Procedural Models based on Hydrology", ACM SIGGRAPH.
 * 2. Strahler (1957), "Quantitative analysis of watershed geomorphology", Eos Trans. AGU.
 */
export function computeDrainageNetworks(
  grid: CubedSphereGrid,
  flowReceivers: Int32Array,
  topologicalOrder: Int32Array,
  annualPrecipitationMm: Float32Array,
  annualEvaporationMm: Float32Array | undefined,
  elevation: Float32Array,
  seaLevelMeters: number = 0
): DrainageResult {
  const totalCells = grid.totalCells;
  const discharge = new Float32Array(totalCells);
  const drainageAreaM2 = new Float64Array(totalCells);
  const strahlerOrder = new Uint8Array(totalCells);
  const drainageBasin = new Int32Array(totalCells);

  const SECONDS_PER_YEAR = 31536000;

  // 1. Initialize local water runoff input per cell in m^3/s
  for (let idx = 0; idx < totalCells; idx++) {
    if (elevation[idx] > seaLevelMeters) {
      drainageAreaM2[idx] = grid.cellAreas[idx];
      const pMm = Math.max(0.0, annualPrecipitationMm[idx]);
      // If evaporation is unavailable, do not invent a hidden fraction of
      // precipitation. Callers must provide the climate water balance.
      const eMm = annualEvaporationMm ? Math.max(0.0, annualEvaporationMm[idx]) : 0.0;

      // Net water balance: Runoff = max(0, Precipitation - Evaporation)
      const runoffMm = Math.max(0.0, pMm - eMm);
      const runoffMeters = runoffMm / 1000.0;
      const cellArea = grid.cellAreas[idx];
      discharge[idx] = (runoffMeters * cellArea) / SECONDS_PER_YEAR;
      strahlerOrder[idx] = 1;
    }
  }

  // 2. Downstream discharge accumulation in topological DAG order
  for (let i = 0; i < totalCells; i++) {
    const idx = topologicalOrder[i];
    const receiver = flowReceivers[idx];

    if (receiver >= 0 && elevation[receiver] > seaLevelMeters) {
      discharge[receiver] += discharge[idx];
      drainageAreaM2[receiver] += drainageAreaM2[idx];
    }
  }

  // 3. Strahler Stream Hierarchy Computation
  const maxIncomingOrder = new Uint8Array(totalCells);
  const orderCount = new Uint8Array(totalCells);

  for (let i = 0; i < totalCells; i++) {
    const idx = topologicalOrder[i];
    const receiver = flowReceivers[idx];

    if (receiver >= 0) {
      const myOrder = strahlerOrder[idx];
      const recMax = maxIncomingOrder[receiver];

      if (myOrder > recMax) {
        maxIncomingOrder[receiver] = myOrder;
        orderCount[receiver] = 1;
        strahlerOrder[receiver] = myOrder;
      } else if (myOrder === recMax) {
        orderCount[receiver]++;
        if (orderCount[receiver] >= 2) {
          strahlerOrder[receiver] = Math.min(8, myOrder + 1);
        }
      }
    }
  }

  // 4. Drainage Basin (Watershed) Identification
  let nextBasinId = 1;

  // Assign basin seeds at river mouths entering the ocean or terminal sinks
  for (let idx = 0; idx < totalCells; idx++) {
    if (elevation[idx] > seaLevelMeters) {
      const receiver = flowReceivers[idx];
      if (receiver < 0 || elevation[receiver] <= seaLevelMeters) {
        drainageBasin[idx] = nextBasinId++;
      }
    }
  }

  // Propagate basin IDs upstream (in reverse topological order: from river mouth to summits)
  for (let i = totalCells - 1; i >= 0; i--) {
    const idx = topologicalOrder[i];
    const receiver = flowReceivers[idx];

    if (receiver >= 0 && drainageBasin[receiver] > 0 && drainageBasin[idx] === 0) {
      drainageBasin[idx] = drainageBasin[receiver];
    }
  }

  return { discharge, drainageAreaM2, strahlerOrder, drainageBasin };
}

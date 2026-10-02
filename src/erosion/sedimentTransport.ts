/**
 * Moves eroded sediment downstream and deposits it as alluvium and deltas.
 */
import { cellCenterDistanceMeters, type CubedSphereGrid } from '../geometry/cubedSphere';
import type { SimulationConfig } from '../types/config';

export interface SedimentTransportResult {
  sedimentThickness: Float32Array;
  bedrockElevation: Float32Array;
  initialSedimentM3: number;
  depositedSedimentM3: number;
  exportedSedimentM3: number;
  residualSedimentM3: number;
  coastalErodedSedimentM3: number;
  marineDepositedSedimentM3: number;
}

/**
 * Volumetric sediment transport and aggradation along the receiver DAG.
 *
 * The only source in this stage is the bedrock depth explicitly returned by
 * the incision solver. Weathering/regolith production is intentionally not
 * invented here: it needs its own mass and residence-time state. Every source
 * volume is either deposited, exported to an ocean/outlet, or reported as a
 * residual, making the source-to-sink budget auditable.
 */
export function applySedimentTransport(
  grid: CubedSphereGrid,
  elevation: Float32Array,
  discharge: Float32Array,
  slopes: Float32Array,
  flowReceivers: Int32Array,
  topologicalOrder: Int32Array,
  config: SimulationConfig,
  erodedBedrockDepth?: Float32Array,
  dtMyr: number = 1.0,
  enableCoastalProcesses: boolean = false,
): SedimentTransportResult {
  const totalCells = grid.totalCells;
  const sedimentLoadM3 = new Float64Array(totalCells);
  const localSedimentSourceM3 = new Float64Array(totalCells);
  const sedimentThickness = new Float32Array(totalCells);
  const dtYears = Math.max(0.0, dtMyr) * 1_000_000.0;
  const capacityScale = Math.max(0.0, config.sedimentDepositionRate);

  let initialSedimentM3 = 0.0;
  let depositedSedimentM3 = 0.0;
  let exportedSedimentM3 = 0.0;
  let coastalErodedSedimentM3 = 0.0;
  let marineDepositedSedimentM3 = 0.0;

  for (let idx = 0; idx < totalCells; idx++) {
    if (elevation[idx] <= 0.0 || !erodedBedrockDepth) continue;
    const sourceM3 = Math.max(0.0, erodedBedrockDepth[idx]) * grid.cellAreas[idx];
    localSedimentSourceM3[idx] = sourceM3;
    initialSedimentM3 += sourceM3;
  }

  // Empirical shoreline wave-abrasion source. It is intentionally small and
  // mass-accounted; a true spectral wave/cliff model would require fetch,
  // bathymetry and storm time series that are not present in this pipeline.
  if (enableCoastalProcesses) {
    const dtYears = Math.max(0.0, dtMyr) * 1_000_000.0;
    for (let idx = 0; idx < totalCells; idx++) {
      if (elevation[idx] <= 0.0) continue;
      let touchesOcean = false;
      for (let k = 0; k < 4; k++) {
        if (elevation[grid.neighbors[idx * 4 + k]] <= 0.0) {
          touchesOcean = true;
          break;
        }
      }
      if (!touchesOcean) continue;
      const exposure = 0.5 + 0.5 * Math.abs(Math.sin(grid.cellLatitudes[idx]));
      const erosionDepthM = Math.min(Math.max(0.0, elevation[idx] - 0.5),
        2.0e-7 * Math.max(0.0, config.windStrength) * exposure * dtYears);
      const sourceM3 = erosionDepthM * grid.cellAreas[idx];
      elevation[idx] -= erosionDepthM;
      localSedimentSourceM3[idx] += sourceM3;
      initialSedimentM3 += sourceM3;
      coastalErodedSedimentM3 += sourceM3;
    }
  }

  const bedrockBeforeDeposition = new Float32Array(elevation);

  for (let i = 0; i < totalCells; i++) {
    const idx = topologicalOrder[i];
    let loadM3 = sedimentLoadM3[idx];
    const localSourceM3 = localSedimentSourceM3[idx];
    if (loadM3 <= 0.0 && localSourceM3 <= 0.0) continue;

    // Ocean cells are terminal sinks for terrestrial sediment in this stage.
    if (elevation[idx] <= 0.0) {
      exportedSedimentM3 += loadM3 + localSourceM3;
      sedimentLoadM3[idx] = 0.0;
      continue;
    }

    const receiver = flowReceivers[idx];
    const terminalLoadM3 = loadM3 + localSourceM3;
    // A terminal root has no downstream alluvial accommodation in this SFD
    // model. Export its load instead of constructing a sediment tower at a
    // routing sink. Coastal loads enter the marine sink directly.
    if (receiver < 0) {
      exportedSedimentM3 += terminalLoadM3;
      sedimentLoadM3[idx] = 0;
      continue;
    }
    if (elevation[receiver] <= 0) {
      const marineFraction = enableCoastalProcesses
        ? Math.min(0.35, 0.25 * Math.exp(-Math.max(0, -elevation[receiver]) / 5000))
        : 0;
      const marineAccommodationM3 = Math.max(0, -elevation[receiver]) * grid.cellAreas[receiver];
      const marineDepositM3 = Math.min(terminalLoadM3 * marineFraction, marineAccommodationM3);
      if (marineDepositM3 > 0) {
        sedimentThickness[receiver] += marineDepositM3 / grid.cellAreas[receiver];
        elevation[receiver] += marineDepositM3 / grid.cellAreas[receiver];
        depositedSedimentM3 += marineDepositM3;
        marineDepositedSedimentM3 += marineDepositM3;
      }
      exportedSedimentM3 += terminalLoadM3 - marineDepositM3;
      sedimentLoadM3[idx] = 0;
      continue;
    }

    const q = Math.max(0.0, discharge[idx]);
    const slope = Math.max(1.0e-7, slopes[idx]);
    const cellArea = grid.cellAreas[idx];
    const linkLengthM = Math.max(1, cellCenterDistanceMeters(grid, idx, receiver));
    // Empirical capacity scale, but with explicit volume and time dimensions:
    // Q^0.6 S^0.8 gives the transport tendency and dtYears gives residence
    // time. The coefficient is a user-facing procedural calibration.
    const capacityM3 = 1.0e-5 * capacityScale * Math.pow(q, 0.6) * Math.pow(slope, 0.8) * dtYears * cellArea;

    // Deposition acts on sediment delivered from upstream. Freshly incised
    // material leaves its source cell before it can aggrade the same bedrock
    // surface that produced it; otherwise a long aggregated timestep rebuilds
    // an eroded summit as an unphysical kilometre-thick sediment pile.
    if (loadM3 > capacityM3) {
      // Fluvial accommodation is the volume below a low alluvial equilibrium
      // grade to the receiver. This is a geometric base-level constraint, not
      // an output-height clamp: excess load remains mobile and is exported.
      const equilibriumGrade = elevation[receiver] + 1e-3 * linkLengthM;
      const accommodationM3 = Math.max(0, equilibriumGrade - elevation[idx]) * cellArea;
      const depositedM3 = Math.min(loadM3, loadM3 - capacityM3, loadM3 * 0.75, accommodationM3);
      const thicknessM = depositedM3 / cellArea;
      sedimentThickness[idx] += thicknessM;
      elevation[idx] += thicknessM;
      loadM3 -= depositedM3;
      depositedSedimentM3 += depositedM3;
    }

    loadM3 += localSourceM3;

    sedimentLoadM3[idx] = loadM3;
    sedimentLoadM3[receiver] += loadM3;
    sedimentLoadM3[idx] = 0.0;
  }

  let residualSedimentM3 = 0.0;
  for (let idx = 0; idx < totalCells; idx++) residualSedimentM3 += sedimentLoadM3[idx];

  return {
    sedimentThickness,
    bedrockElevation: bedrockBeforeDeposition,
    initialSedimentM3,
    depositedSedimentM3,
    exportedSedimentM3,
    residualSedimentM3,
    coastalErodedSedimentM3,
    marineDepositedSedimentM3,
  };
}

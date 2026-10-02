/**
 * Hillslope soil creep: explicit diffusion of elevation with a spherical Laplacian.
 */
import { cellCenterDistanceMeters, type CubedSphereGrid } from '../geometry/cubedSphere';
import type { SimulationConfig } from '../types/config';

export interface HillslopeDiffusionResult {
  transportedVolumeM3: number;
}

/**
 * Explicit, conservative hillslope sediment diffusion.
 *
 * The configuration value is the diffusivity D in m²/yr. Fluxes are computed
 * once per undirected edge and converted from m³ to an elevation change using
 * each cell's actual area, so land-to-land diffusion conserves volume and is
 * independent of traversal order.
 *
 * Salles (2019), eSCAPE v2.0, uses the linear creep law q = -D grad(z)
 * with example hillslope diffusivities of 0.01-0.1 m²/yr. The explicit update
 * here enforces its mesh-local monotonicity/CFL bound by substepping.
 */
export function applyHillslopeDiffusion(
  grid: CubedSphereGrid,
  elevation: Float32Array,
  rockHardness: Float32Array,
  config: SimulationConfig,
  iterations: number = 1,
  dtMyr: number = 1.0,
): HillslopeDiffusionResult {
  const totalCells = grid.totalCells;
  const requestedDtYears = Math.max(0.0, dtMyr * 1_000_000.0);

  // A hillslope diffusivity is not a relief multiplier. The previous value of
  // 5,000 m²/yr, combined with 125 Myr pipeline steps, exceeded the explicit
  // stability limit by orders of magnitude at production resolution. The
  // resulting capped edge fluxes conserved volume but violated the diffusion
  // maximum principle and manufactured multi-kilometre peaks.
  const diffusivityM2Yr = Math.max(0.0, config.hillslopeDiffusionRate);
  let transportedVolumeM3 = 0.0;

  if (requestedDtYears === 0.0 || diffusivityM2Yr === 0.0 || iterations <= 0) {
    return { transportedVolumeM3 };
  }

  // Symmetric edge conductance makes every transfer exactly conservative.
  // For dz/dt = sum(c_ij (z_j-z_i)) / A_i, forward Euler is monotone when
  // dt * sum(c_ij) / A_i <= 1. Use a safety factor below that bound and split
  // the requested geological interval into as many substeps as necessary.
  const edgeConductance = new Float64Array(totalCells * 4);
  const conductanceSum = new Float64Array(totalCells);
  let maxConductancePerArea = 0.0;

  for (let idx = 0; idx < totalCells; idx++) {
    if (elevation[idx] <= 0.0) continue;
    for (let k = 0; k < 4; k++) {
      const neighbor = grid.neighbors[idx * 4 + k];
      if (elevation[neighbor] <= 0.0) continue;

      const distanceM = Math.max(1.0, cellCenterDistanceMeters(grid, idx, neighbor));
      const edgeLengthM = 0.5 * (Math.sqrt(grid.cellAreas[idx]) + Math.sqrt(grid.cellAreas[neighbor]));
      const meanHardness = 0.5 * (
        Math.max(0.2, rockHardness[idx]) + Math.max(0.2, rockHardness[neighbor])
      );
      const mobility = 1.25 - 0.5 * Math.min(1.0, meanHardness);
      const conductance = diffusivityM2Yr * mobility * edgeLengthM / distanceM;
      edgeConductance[idx * 4 + k] = conductance;
      conductanceSum[idx] += conductance;
    }
    maxConductancePerArea = Math.max(
      maxConductancePerArea,
      conductanceSum[idx] / Math.max(1.0, grid.cellAreas[idx]),
    );
  }

  if (maxConductancePerArea === 0.0) return { transportedVolumeM3 };

  const stableDtYears = 0.45 / maxConductancePerArea;
  const requestedIterations = Math.max(1, Math.floor(iterations));
  const numericalSubsteps = Math.max(
    requestedIterations,
    Math.ceil(requestedDtYears / stableDtYears),
  );
  const substepDtYears = requestedDtYears / numericalSubsteps;

  for (let iter = 0; iter < numericalSubsteps; iter++) {
    const deltaVolume = new Float64Array(totalCells);

    for (let idx = 0; idx < totalCells; idx++) {
      const elevationA = elevation[idx];
      if (elevationA <= 0.0) continue;

      for (let k = 0; k < 4; k++) {
        const neighbor = grid.neighbors[idx * 4 + k];
        if (neighbor <= idx || elevation[neighbor] <= 0.0) continue;

        const elevationB = elevation[neighbor];
        if (elevationA === elevationB) continue;

        const source = elevationA > elevationB ? idx : neighbor;
        const receiver = source === idx ? neighbor : idx;
        const conductance = edgeConductance[idx * 4 + k];
        const flux = conductance * Math.abs(elevationA - elevationB) * substepDtYears;

        if (flux > 0.0) {
          deltaVolume[source] -= flux;
          deltaVolume[receiver] += flux;
          transportedVolumeM3 += flux;
        }
      }
    }

    for (let idx = 0; idx < totalCells; idx++) {
      if (elevation[idx] > 0.0) {
        elevation[idx] += deltaVolume[idx] / grid.cellAreas[idx];
      }
    }
  }

  return { transportedVolumeM3 };
}

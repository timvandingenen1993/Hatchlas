/**
 * Crust-column isostasy (mantle, continental and oceanic densities) and the sea-level solver.
 */
import type { CubedSphereGrid } from '../../geometry/cubedSphere';
import type { CrustState } from './types';

const RHO_MANTLE = 3300;
const RHO_CONTINENTAL = 2800;
const RHO_OCEANIC = 2950;
const RHO_ARC = 2850;
const REFERENCE_CONTINENTAL_THICKNESS_M = 35_000;
const REFERENCE_OCEANIC_THICKNESS_M = 7_000;

export function crustColumnElevationM(crust: CrustState): Float32Array {
  const rawElevationM = new Float32Array(crust.crustType.length);
  for (let cell = 0; cell < rawElevationM.length; cell++) {
    const continental = crust.continentalThicknessM[cell];
    const oceanic = crust.oceanicThicknessM[cell];
    const arc = crust.arcThicknessM[cell];
    if (continental >= 1_000) {
      const continentalRootRelief =
        (continental - REFERENCE_CONTINENTAL_THICKNESS_M)
        * (RHO_MANTLE - RHO_CONTINENTAL) / RHO_MANTLE;
      const arcRelief = arc * (RHO_MANTLE - RHO_ARC) / RHO_MANTLE;
      rawElevationM[cell] = 250 + continentalRootRelief + arcRelief;
    } else {
      const age = Math.max(0, crust.oceanicAgeMyr[cell]);
      const thermalSubsidence = -2_500 - 350 * Math.sqrt(age);
      const thicknessRelief =
        (oceanic - REFERENCE_OCEANIC_THICKNESS_M)
        * (RHO_MANTLE - RHO_OCEANIC) / RHO_MANTLE;
      const arcRelief = arc * (RHO_MANTLE - RHO_ARC) / RHO_MANTLE;
      rawElevationM[cell] = thermalSubsidence + thicknessRelief + arcRelief;
    }
  }
  return rawElevationM;
}

export function waterVolumeAtSeaLevel(
  grid: CubedSphereGrid,
  rawElevationM: Float32Array,
  seaLevelM: number,
): number {
  let volumeM3 = 0;
  for (let cell = 0; cell < grid.totalCells; cell++) {
    const depth = seaLevelM - rawElevationM[cell];
    if (depth > 0) volumeM3 += depth * grid.cellAreas[cell];
  }
  return volumeM3;
}

export function solveSeaLevelM(
  grid: CubedSphereGrid,
  rawElevationM: Float32Array,
  waterVolumeM3: number,
): number {
  let low = -20_000;
  let high = 20_000;
  for (let iteration = 0; iteration < 80; iteration++) {
    const middle = 0.5 * (low + high);
    if (waterVolumeAtSeaLevel(grid, rawElevationM, middle) < waterVolumeM3) low = middle;
    else high = middle;
  }
  return 0.5 * (low + high);
}

export function referenceToSeaLevel(
  rawElevationM: Float32Array,
  seaLevelM: number,
): Float32Array {
  const elevationM = new Float32Array(rawElevationM.length);
  for (let cell = 0; cell < rawElevationM.length; cell++) {
    elevationM[cell] = rawElevationM[cell] - seaLevelM;
  }
  return elevationM;
}

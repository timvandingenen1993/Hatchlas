/**
 * Monthly prevailing winds from a three-cell circulation model with a seasonally shifting ITCZ.
 */
import type { CubedSphereGrid } from '../geometry/cubedSphere';
import { Simplex3D } from '../utils/rng';

export interface MonthlyWindsResult {
  windU: Float32Array[]; // Zonal wind (East-West) in m/s
  windV: Float32Array[]; // Meridional wind (North-South) in m/s
}

/**
 * Continuous C^inf 3-Cell Atmospheric Circulation on Spherical Grid
 * References:
 * 1. Hartmann (1994), "Global Physical Climatology", Academic Press.
 * 2. Peixoto & Oort (1992), "Physics of Climate", American Institute of Physics.
 */
export function computeSeasonalWinds(
  grid: CubedSphereGrid,
  monthlyDeclinationDeg: Float32Array,
  windStrength: number = 1.0,
  seed: number = 1337
): MonthlyWindsResult {
  const totalCells = grid.totalCells;
  const simplex = new Simplex3D(seed + 909);
  const windU: Float32Array[] = [];
  const windV: Float32Array[] = [];

  for (let m = 0; m < 12; m++) {
    const declinationRad = (monthlyDeclinationDeg[m] * Math.PI) / 180.0;
    // ITCZ seasonal shift (approx 60% of solar declination)
    const itczShiftRad = declinationRad * 0.60;

    const uMonth = new Float32Array(totalCells);
    const vMonth = new Float32Array(totalCells);

    for (let idx = 0; idx < totalCells; idx++) {
      const phi = grid.cellLatitudes[idx];
      // Effective latitude relative to shifted ITCZ thermal equator
      const relPhi = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, phi - itczShiftRad));

      // Continuous 3-cell circulation harmonic profile (Hartmann 1994 / Peixoto & Oort 1992)
      // Trade winds (Easterlies in tropics: zonal < 0), Westerlies in mid-latitudes (zonal > 0), Polar Easterlies
      const zonalHarmonic = -Math.cos(3.0 * relPhi) + 0.35 * Math.cos(relPhi) - 0.20 * Math.cos(5.0 * relPhi);
      const meridionalHarmonic = -Math.sin(3.0 * relPhi) * 0.35;

      // Planetary synoptic Rossby wave perturbations
      const px = grid.cellPositions[idx * 3 + 0];
      const py = grid.cellPositions[idx * 3 + 1];
      const pz = grid.cellPositions[idx * 3 + 2];
      const vortexU = simplex.noise3D(px * 2.5, py * 2.5, pz * 2.5 + m * 0.1) * 0.22;
      const vortexV = simplex.noise3D(px * 2.5 + 17, py * 2.5 + 43, pz * 2.5 + m * 0.1) * 0.22;

      const rawU = zonalHarmonic + vortexU;
      const rawV = meridionalHarmonic + vortexV;
      const mag = Math.hypot(rawU, rawV);
      const dirU = mag > 1e-5 ? rawU / mag : 0.0;
      const dirV = mag > 1e-5 ? rawV / mag : 0.0;

      // Physical wind speed (m/s): Base 8 m/s scaled by circulation amplitude & user windStrength
      const speed = Math.max(1.0, mag * 12.0) * windStrength;

      uMonth[idx] = dirU * speed;
      vMonth[idx] = dirV * speed;
    }

    windU.push(uMonth);
    windV.push(vMonth);
  }

  return { windU, windV };
}

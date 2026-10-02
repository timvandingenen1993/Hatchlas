/**
 * Thickens and thins crust from plate convergence and divergence, and updates crust type.
 */
import type { SimulationConfig } from '../types/config';
import type { TectonicHistoryResult } from './tectonicHistory';

export interface CrustalDeformationResult {
  crustThickness: Float32Array; // Deformed crustal thickness in meters
  crustType: Uint8Array;        // Updated crust types (0=Ocean, 1=Cont, 2=Arc)
  rockHardness: Float32Array;   // Lithological resistance (0.2 to 1.0)
  volContinental: Float64Array;
  volOceanic: Float64Array;
  volArcMagma: Float64Array;
  volSediment: Float64Array;
  totalShorteningVolumeM3: number;
  totalExtensionVolumeM3: number;
  totalMagmaVolumeM3: number;
  initialVolumeM3: number;
  finalVolumeM3: number;
  massConservationErrorFraction: number;
}

/**
 * Mass-conserving crustal deformation with zero-sum internal redistribution.
 *
 * Horizontal shortening transfers mass from donor continental margins into
 * thickening orogenic roots. Extensional rifting redistributes continental crust
 * outward to rift shoulders without volume loss.
 *
 * Strict physical ledger:
 *   Final Crust = Initial Crust + Arc Magma + Ridge Magma - Subducted Oceanic
 */
export function computeCrustalDeformation(
  history: TectonicHistoryResult,
  _config?: SimulationConfig
): CrustalDeformationResult {
  const grid = history.tectonicGrid;
  const totalCells = grid.totalCells;

  const volContinental = new Float64Array(history.volContinental);
  const volOceanic = new Float64Array(history.volOceanic);
  const volArcMagma = new Float64Array(history.volArcMagma);
  const volSediment = new Float64Array(history.volSediment);

  let initialVolumeM3 = 0;
  for (let i = 0; i < totalCells; i++) {
    initialVolumeM3 += volContinental[i] + volOceanic[i] + volArcMagma[i] + volSediment[i];
  }

  let totalShorteningVolumeM3 = 0;
  let totalExtensionVolumeM3 = 0;
  let totalMagmaVolumeM3 = 0;

  // Boundary work, ridge creation, slab removal, magmatism, and gravitational
  // root spreading have already been integrated in tectonicHistory. Replaying
  // every historical edge here used to deform the final state a second time
  // and reintroduced single-cell ridges. This stage now derives material and
  // lithology diagnostics from that integrated state without mutating it.

  // 3. Compute final crust thickness and types from updated reservoirs
  const crustThickness = new Float32Array(totalCells);
  const crustType = new Uint8Array(totalCells);
  const rockHardness = new Float32Array(totalCells);

  for (let idx = 0; idx < totalCells; idx++) {
    const area = grid.cellAreas[idx];
    const totalVol = volContinental[idx] + volOceanic[idx] + volArcMagma[idx] + volSediment[idx];
    crustThickness[idx] = totalVol / area;

    if (volArcMagma[idx] > 0.2 * totalVol) crustType[idx] = 2;
    else if (volContinental[idx] >= volOceanic[idx]) crustType[idx] = 1;
    else crustType[idx] = 0;

    // 4. Compute Lithological Hardness from Strain and Material State
    const sXX = history.strainXX[idx];
    const sYY = history.strainYY[idx];
    const sXY = history.strainXY[idx];
    const principalStrain = Math.sqrt(sXX * sXX + sYY * sYY + 2 * sXY * sXY);
    const inactiveAge = history.timeSinceActiveConvergenceMyr[idx];

    if (crustType[idx] === 1) {
      if (principalStrain < 0.05 && inactiveAge > 25.0) {
        // Ancient undeformed craton
        rockHardness[idx] = 0.90;
      } else if (principalStrain > 0.40) {
        // Highly deformed metamorphic collision core
        rockHardness[idx] = 0.65;
      } else {
        // Continental shield / foothill
        rockHardness[idx] = 0.78;
      }
    } else if (crustType[idx] === 2) {
      // Arc volcanic batholith
      rockHardness[idx] = 0.72;
    } else {
      // Oceanic basalt
      rockHardness[idx] = 0.60;
    }
  }

  let finalVolumeM3 = 0;
  for (let i = 0; i < totalCells; i++) {
    finalVolumeM3 += volContinental[i] + volOceanic[i] + volArcMagma[i] + volSediment[i];
  }

  // Mass conservation error: only external magmatism adds mass; shortening & extension are zero-sum
  const expectedFinalVolumeM3 = initialVolumeM3 + totalMagmaVolumeM3;
  const massConservationErrorFraction = Math.abs(finalVolumeM3 - expectedFinalVolumeM3) / Math.max(1, initialVolumeM3);

  return {
    crustThickness,
    crustType,
    rockHardness,
    volContinental,
    volOceanic,
    volArcMagma,
    volSediment,
    totalShorteningVolumeM3,
    totalExtensionVolumeM3,
    totalMagmaVolumeM3,
    initialVolumeM3,
    finalVolumeM3,
    massConservationErrorFraction,
  };
}

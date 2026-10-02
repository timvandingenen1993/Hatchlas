/**
 * Projects tectonic snapshot fields onto the cubed-sphere grid.
 */
import {
  sampleCubedSphereField,
  sampleCubedSphereNearest,
  type CubedSphereGrid,
} from '../geometry/cubedSphere';
import type { TectonicPlateData } from '../types/worldV2';
import type { CrustalDeformationResult } from './crustalDeformation';
import type { TectonicHistoryResult, TectonicSnapshot } from './tectonicHistory';
import { buildMetricOrogenicUplift } from './orogenicUplift';
import { solveOceanicCrustAge } from './oceanCrustAge';

export interface ProjectedTectonicState {
  plateIds: Uint8Array;
  crustType: Uint8Array;
  crustThickness: Float32Array;
  crustAge: Float32Array;
  boundaryType: Uint8Array;
  tectonicUpliftRate: Float32Array;
  rockHardness: Float32Array;
  normalVelocity: Float32Array;
  shearVelocity: Float32Array;
  strainXX: Float32Array;
  strainXY: Float32Array;
  strainYY: Float32Array;
  plates: TectonicPlateData[];
  snapshots: TectonicSnapshot[];
}

export function projectTectonicScalar(
  sourceGrid: CubedSphereGrid,
  field: Float32Array | Uint8Array | Int32Array,
  outputGrid: CubedSphereGrid,
): Float32Array {
  const projected = new Float32Array(outputGrid.totalCells);
  for (let idx = 0; idx < outputGrid.totalCells; idx++) {
    projected[idx] = sampleCubedSphereField(sourceGrid, field, outputGrid.cellLatitudes[idx], outputGrid.cellLongitudes[idx]);
  }
  return projected;
}

/** Conservative lateral distribution of finite-width orogenic uplift. */
function projectCategory(sourceGrid: CubedSphereGrid, field: Uint8Array, outputGrid: CubedSphereGrid): Uint8Array {
  const projected = new Uint8Array(outputGrid.totalCells);
  for (let idx = 0; idx < outputGrid.totalCells; idx++) {
    projected[idx] = sampleCubedSphereNearest(sourceGrid, field, outputGrid.cellLatitudes[idx], outputGrid.cellLongitudes[idx]);
  }
  return projected;
}

function projectReservoir(sourceGrid: CubedSphereGrid, sourceVolume: Float64Array, outputGrid: CubedSphereGrid): Float64Array {
  const equivalentThickness = new Float32Array(sourceGrid.totalCells);
  let sourceIntegral = 0;
  for (let idx = 0; idx < sourceGrid.totalCells; idx++) {
    equivalentThickness[idx] = sourceVolume[idx] / sourceGrid.cellAreas[idx];
    sourceIntegral += sourceVolume[idx];
  }

  const sampled = projectTectonicScalar(sourceGrid, equivalentThickness, outputGrid);
  let sampledIntegral = 0;
  for (let idx = 0; idx < outputGrid.totalCells; idx++) {
    sampled[idx] = Math.max(0, sampled[idx]);
    sampledIntegral += sampled[idx] * outputGrid.cellAreas[idx];
  }
  const scale = sampledIntegral > 0 ? sourceIntegral / sampledIntegral : 0;
  const projectedVolume = new Float64Array(outputGrid.totalCells);
  for (let idx = 0; idx < outputGrid.totalCells; idx++) {
    projectedVolume[idx] = sampled[idx] * scale * outputGrid.cellAreas[idx];
  }
  return projectedVolume;
}

/** Seam-aware, independently mass-conserving material projection. */
export function projectTectonicState(
  history: TectonicHistoryResult,
  deformation: CrustalDeformationResult,
  outputGrid: CubedSphereGrid,
  maximumUpliftRateMmYr?: number,
): ProjectedTectonicState {
  const sourceGrid = history.tectonicGrid;
  const plateIds = projectCategory(sourceGrid, history.plateIds, outputGrid);
  const sourceCrustType = projectCategory(sourceGrid, deformation.crustType, outputGrid);
  let crustAge = projectTectonicScalar(sourceGrid, history.crustAge, outputGrid);
  const rockHardness = projectTectonicScalar(sourceGrid, deformation.rockHardness, outputGrid);
  const strainXX = projectTectonicScalar(sourceGrid, history.strainXX, outputGrid);
  const strainXY = projectTectonicScalar(sourceGrid, history.strainXY, outputGrid);
  const strainYY = projectTectonicScalar(sourceGrid, history.strainYY, outputGrid);

  const continental = projectReservoir(sourceGrid, deformation.volContinental, outputGrid);
  const oceanic = projectReservoir(sourceGrid, deformation.volOceanic, outputGrid);
  const arc = projectReservoir(sourceGrid, deformation.volArcMagma, outputGrid);
  const sediment = projectReservoir(sourceGrid, deformation.volSediment, outputGrid);
  const crustThickness = new Float32Array(outputGrid.totalCells);
  const crustType = new Uint8Array(outputGrid.totalCells);

  for (let idx = 0; idx < outputGrid.totalCells; idx++) {
    const totalVolume = continental[idx] + oceanic[idx] + arc[idx] + sediment[idx];
    crustThickness[idx] = totalVolume / outputGrid.cellAreas[idx];
    const arcFraction = totalVolume > 0 ? arc[idx] / totalVolume : 0;
    // Bilinear remapping naturally mixes a little continental material into
    // the first ocean pixel. That is a coastline, not a volcanic arc. Keep the
    // categorical source state unless actual arc magma dominates the mixture.
    crustType[idx] = arcFraction > 0.2 ? 2 : sourceCrustType[idx];
  }

  let inferredMaximumUplift = 0;
  for (let idx = 0; idx < history.tectonicUpliftRate.length; idx++) {
    inferredMaximumUplift = Math.max(inferredMaximumUplift, history.tectonicUpliftRate[idx]);
  }
  let metricOrogens = buildMetricOrogenicUplift(
    outputGrid,
    history.plates,
    plateIds,
    crustType,
    crustAge,
    maximumUpliftRateMmYr ?? inferredMaximumUplift,
  );
  crustAge = solveOceanicCrustAge(
    outputGrid,
    plateIds,
    crustType,
    crustAge,
    metricOrogens.kinematics,
  );
  metricOrogens = buildMetricOrogenicUplift(
    outputGrid,
    history.plates,
    plateIds,
    crustType,
    crustAge,
    maximumUpliftRateMmYr ?? inferredMaximumUplift,
  );
  const boundaryType = metricOrogens.kinematics.boundaryType;
  const normalVelocity = metricOrogens.kinematics.normalVelocity;
  const shearVelocity = metricOrogens.kinematics.shearVelocity;
  const tectonicUpliftRate = metricOrogens.upliftRate;

  return {
    plateIds, crustType, crustThickness, crustAge, boundaryType, tectonicUpliftRate,
    rockHardness, normalVelocity, shearVelocity, strainXX, strainXY, strainYY,
    plates: history.plates, snapshots: history.snapshots,
  };
}

export function projectSnapshotOrogenicUplift(
  history: TectonicHistoryResult,
  snapshot: TectonicSnapshot,
  outputGrid: CubedSphereGrid,
  maximumUpliftRateMmYr: number,
): Float32Array {
  const plateIds = projectCategory(history.tectonicGrid, snapshot.plateIds, outputGrid);
  const crustType = projectCategory(history.tectonicGrid, snapshot.crustType, outputGrid);
  let crustAge = projectTectonicScalar(history.tectonicGrid, snapshot.crustAge, outputGrid);
  let metricOrogens = buildMetricOrogenicUplift(
    outputGrid,
    history.plates,
    plateIds,
    crustType,
    crustAge,
    maximumUpliftRateMmYr,
  );
  crustAge = solveOceanicCrustAge(outputGrid, plateIds, crustType, crustAge, metricOrogens.kinematics);
  metricOrogens = buildMetricOrogenicUplift(
    outputGrid,
    history.plates,
    plateIds,
    crustType,
    crustAge,
    maximumUpliftRateMmYr,
  );
  return metricOrogens.upliftRate;
}

export interface ProjectedSnapshotCrustState {
  plateIds: Uint8Array;
  crustType: Uint8Array;
  crustThickness: Float32Array;
  crustAge: Float32Array;
  boundaryType: Uint8Array;
  normalVelocity: Float32Array;
  shearVelocity: Float32Array;
  upliftRate: Float32Array;
}

export function projectSnapshotCrustState(
  history: TectonicHistoryResult,
  snapshot: TectonicSnapshot,
  outputGrid: CubedSphereGrid,
  maximumUpliftRateMmYr: number,
): ProjectedSnapshotCrustState {
  const sourceGrid = history.tectonicGrid;
  const plateIds = projectCategory(sourceGrid, snapshot.plateIds, outputGrid);
  const crustType = projectCategory(sourceGrid, snapshot.crustType, outputGrid);
  const crustThickness = projectTectonicScalar(sourceGrid, snapshot.crustThickness, outputGrid);
  let sourceVolume = 0;
  let projectedVolume = 0;
  for (let idx = 0; idx < sourceGrid.totalCells; idx++) {
    sourceVolume += snapshot.crustThickness[idx] * sourceGrid.cellAreas[idx];
  }
  for (let idx = 0; idx < outputGrid.totalCells; idx++) {
    projectedVolume += crustThickness[idx] * outputGrid.cellAreas[idx];
  }
  const volumeScale = projectedVolume > 0 ? sourceVolume / projectedVolume : 1;
  for (let idx = 0; idx < outputGrid.totalCells; idx++) crustThickness[idx] *= volumeScale;

  let crustAge = projectTectonicScalar(sourceGrid, snapshot.crustAge, outputGrid);
  let metricOrogens = buildMetricOrogenicUplift(
    outputGrid,
    history.plates,
    plateIds,
    crustType,
    crustAge,
    maximumUpliftRateMmYr,
  );
  crustAge = solveOceanicCrustAge(outputGrid, plateIds, crustType, crustAge, metricOrogens.kinematics);
  metricOrogens = buildMetricOrogenicUplift(
    outputGrid,
    history.plates,
    plateIds,
    crustType,
    crustAge,
    maximumUpliftRateMmYr,
  );

  return {
    plateIds,
    crustType,
    crustThickness,
    crustAge,
    boundaryType: metricOrogens.kinematics.boundaryType,
    normalVelocity: metricOrogens.kinematics.normalVelocity,
    shearVelocity: metricOrogens.kinematics.shearVelocity,
    upliftRate: metricOrogens.upliftRate,
  };
}

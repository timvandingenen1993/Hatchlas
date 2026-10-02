/**
 * Runs only the tectonic stage of the pipeline, for quick previews.
 */
import type { CubedSphereGrid } from '../geometry/cubedSphere';
import {
  runTectonicSimulation,
  type PlateEngineConfig,
} from '../tectonics/plateEngine';
import type { SimulationConfig } from '../types/config';
import type { StageTiming, TectonicPlateData, WorldV2 } from '../types/worldV2';

export type StageCallback = (
  stageName: string,
  stageIndex: number,
  totalStages: number,
  stageProgress: number,
  overallProgress: number,
) => void;

export interface SimulationResult {
  world: WorldV2;
  grid: CubedSphereGrid;
}

/**
 * Tectonics-only world generation entry point using the consolidated time-stepped plateEngine.
 * Generates time-evolving plate kinematics and records timeline snapshots across geological time.
 */
export async function runTectonicsOnlySimulation(
  config: SimulationConfig,
  onProgress?: StageCallback,
  checkCancellation?: () => boolean,
): Promise<SimulationResult> {
  const startedAt = performance.now();
  const stageTimings: StageTiming[] = [];
  const totalStages = 2;

  if (checkCancellation?.()) throw new Error('Simulation cancelled by user');
  onProgress?.('Running time-stepped plate kinematics & transport...', 1, totalStages, 0, 0.05);

  const tectonicsStartedAt = performance.now();
  const engineConfig: Partial<PlateEngineConfig> = {
    seed: config.seed,
    resolution: config.faceResolution,
    radiusMeters: config.planetRadiusKm * 1_000,
    plateCount: config.plateCount,
    continentalFraction: config.continentalFraction,
    durationMyr: config.tectonicEvolutionMyr ?? 35,
    timeStepMyr: 1.0,
    activeVelocityThresholdMmYr: 2.0,
  };

  // Intermediate timeline frames were a development diagnostic and are
  // intentionally disabled in the production path. Retain only t=0 and the
  // final state; numerical CFL stepping and final material are unchanged.
  const snapshotIntervalMyr = engineConfig.durationMyr ?? 35;
  const simulation = runTectonicSimulation(engineConfig, snapshotIntervalMyr);
  stageTimings.push({
    stage: 'Time-stepped spherical plate transport',
    durationMs: performance.now() - tectonicsStartedAt,
  });

  if (checkCancellation?.()) throw new Error('Simulation cancelled by user');
  onProgress?.('Packaging tectonic world and timeline...', 2, totalStages, 0, 0.90);
  const packagingStartedAt = performance.now();

  const { grid, plates: enginePlates, boundaries, ledger, timeline, reservoirs } = simulation;
  const totalCells = grid.totalCells;

  // Derive latest dominant plate IDs
  const latestSnapshot = timeline?.snapshots[timeline.snapshots.length - 1];
  const dominantPlateIds = latestSnapshot
    ? latestSnapshot.dominantPlateId
    : new Uint16Array(totalCells);

  const plateIds = new Uint8Array(dominantPlateIds);
  const boundaryType = new Uint8Array(
    latestSnapshot ? latestSnapshot.boundaryClass : boundaries.cellBoundaryType,
  );
  const normalVelocity = new Float32Array(
    latestSnapshot ? latestSnapshot.normalVelocityMmYr : boundaries.cellNormalVelocityMmYr,
  );

  const continentalThicknessM = latestSnapshot?.continentalThicknessM
    ?? new Float32Array(totalCells);
  const crustType = new Uint8Array(totalCells);
  const crustThickness = new Float32Array(totalCells);
  for (let cell = 0; cell < totalCells; cell++) {
    const continental = continentalThicknessM[cell];
    crustType[cell] = continental > 0 ? 1 : 0;
    crustThickness[cell] = continental > 0 ? continental : 7_000;
  }
  const crustAge = new Float32Array(totalCells).fill(100);          // 100 Myr baseline
  const flatElevation = new Float32Array(totalCells).fill(0);       // 0 m datum (elevation deferred to Stage 5)
  const zeroSlope = new Float32Array(totalCells);
  const rockHardness = new Float32Array(totalCells).fill(0.8);

  const plates: TectonicPlateData[] = enginePlates.map((plate) => ({
    id: plate.id,
    name: plate.name,
    eulerPole: [plate.eulerPole[0], plate.eulerPole[1], plate.eulerPole[2]],
    angularVelocity: plate.angularVelocityRadPerMyr,
    isOceanic: false,
    color: plate.color,
  }));

  stageTimings.push({
    stage: 'WorldV2 tectonic packaging',
    durationMs: performance.now() - packagingStartedAt,
  });

  const world: WorldV2 = {
    version: 2,
    seed: config.seed,
    config: { ...config },
    radiusMeters: grid.radiusMeters,
    seaLevelMeters: 0,
    topology: grid.topology,
    geology: {
      plateCount: plates.length,
      plates,
      plateIds,
      crustType,
      crustThickness,
      crustAge,
      boundaryType,
      tectonicUpliftRate: normalVelocity,
      continentalThicknessM,
      plateAreaFraction: reservoirs.plateAreaFraction as Float64Array,
      continentalVolumeByPlateM3: reservoirs.continentalVolumeM3,
      ownershipClosure: latestSnapshot?.closureResidual ?? new Float32Array(totalCells),
      dominanceConfidence: latestSnapshot?.dominanceConfidence ?? new Float32Array(totalCells).fill(1),
    },
    terrain: {
      elevation: flatElevation,
      bedrockElevation: flatElevation,
      sedimentThickness: new Float32Array(totalCells),
      slope: zeroSlope,
      rockHardness,
    },
    hydrology: {
      flowReceivers: new Int32Array(totalCells).fill(-1),
      discharge: new Float32Array(totalCells),
      strahlerOrder: new Uint8Array(totalCells),
      drainageBasin: new Int32Array(totalCells),
      lakes: [],
      isLakeMask: new Uint8Array(totalCells),
    },
    climate: {
      axialTiltDeg: config.axialTiltDeg,
      monthlyTemperature: Array.from({ length: 12 }, () => new Float32Array(totalCells)),
      monthlyPrecipitation: Array.from({ length: 12 }, () => new Float32Array(totalCells)),
      meanAnnualTemperature: new Float32Array(totalCells),
      annualPrecipitation: new Float32Array(totalCells),
      annualEvaporation: new Float32Array(totalCells),
      temperatureSeasonality: new Float32Array(totalCells),
      iceThickness: new Float32Array(totalCells),
      seaIceFraction: new Float32Array(totalCells),
    },
    ecology: { biomes: new Uint8Array(totalCells) },
    diagnostics: {
      totalExecutionTimeMs: performance.now() - startedAt,
      stageTimings,
      peakMemoryMB: Math.round((totalCells * 4 * 16) / (1024 * 1024)),
      continentalFraction: config.continentalFraction,
      meanElevationM: 0,
      maxElevationM: 0,
      minElevationM: 0,
      oceanVolumeM3: 1.332e18,
      totalRiverDischargeM3s: 0,
      lakeCount: 0,
      meanAnnualTempC: 15,
      meanAnnualPrecipMm: 1000,
      perennialIceAreaKm2: 0,
      sedimentInputM3: 0,
      sedimentDepositedM3: 0,
      sedimentExportedM3: 0,
      sedimentResidualM3: 0,
      coastalErodedSedimentM3: 0,
      marineDepositedSedimentM3: 0,
      initialCrustVolumeM3: ledger.initialContinentalVolumeM3 + ledger.initialOceanicVolumeM3,
      finalCrustVolumeM3: ledger.finalContinentalVolumeM3 + ledger.finalOceanicVolumeM3,
      magmaticAdditionM3: 0,
      subductedCrustM3: ledger.subductedOceanicVolumeM3,
      crustVolumeResidualM3: ledger.oceanicVolumeResidualM3,
      tectonicSubsteps: ledger.totalSubsteps,
      tectonicTimeStepMyr: ledger.dtMyr,
      tectonicTargetTimeStepMyr: ledger.targetTimeStepMyr,
      tectonicMinimumTimeStepMyr: ledger.minimumActualTimeStepMyr,
      tectonicMaximumTimeStepMyr: ledger.maximumActualTimeStepMyr,
      tectonicMinCellDistanceM: ledger.minCellDistanceM,
      tectonicMaxPlateSpeedMPerMyr: ledger.maxPlateSpeedMPerMyr,
      initialContinentalVolumeM3: ledger.initialContinentalVolumeM3,
      finalContinentalVolumeM3: ledger.finalContinentalVolumeM3,
      continentalTransportedVolumeM3: ledger.continentalTransportedVolumeM3,
      continentalRoutedVolumeM3: ledger.continentalRoutedVolumeM3 + ledger.continentalTopologyRoutedVolumeM3,
      continentalSourceVolumeM3: ledger.continentalSourceVolumeM3,
      continentalSinkVolumeM3: ledger.continentalSinkVolumeM3,
      continentalLimitedVolumeM3: ledger.continentalLimitedVolumeM3,
      continentalCorrectionVolumeM3: ledger.continentalCorrectionVolumeM3,
      tectonicRawMinContinentalVolumeM3: ledger.rawMinContinentalVolumeM3,
      continentalVolumeResidualM3: ledger.continentalVolumeResidualM3,
      continentalVolumeRelativeError: ledger.continentalVolumeRelativeError,
      tectonicConservation: ledger,
    },
    timeline,
  };

  onProgress?.('Time-stepped tectonic world ready', 2, totalStages, 1, 1);
  return { world, grid };
}

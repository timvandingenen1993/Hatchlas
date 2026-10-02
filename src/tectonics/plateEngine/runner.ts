/**
 * Runs the plate engine through time and captures snapshots of the tectonic state.
 */
import { buildCubedSphereGrid, type CubedSphereGrid } from '../../geometry/cubedSphere';
import { extractKinematicBoundaries } from './boundaries';
import { partitionGridPlates, seedRigidEulerPlates } from './plateSeeding';
import {
  computeCFLMetrics,
  derivePrimaryPlateIds,
  stepConservativeTransport,
  type StepAreaLedger,
} from './transport';
import {
  classifyGeologicalBoundaries,
  DEFAULT_CONTINENTAL_THICKNESS_M,
  initializeContinentalMaterial,
  sumContinentalVolume,
} from './material';
import type {
  ContinentalStepLedger,
  PlateEngineConfig,
  PlateStateReservoirs,
  RigidEulerPlate,
  TectonicConservationLedger,
  TectonicSimulationResult,
  TectonicSimulationTimeline,
  TectonicTimeSnapshot,
} from './types';

export const DEFAULT_PLATE_ENGINE_CONFIG: PlateEngineConfig = {
  seed: 42,
  resolution: 32,
  radiusMeters: 6_371_000,
  plateCount: 8,
  continentalFraction: 0.35,
  durationMyr: 30,
  timeStepMyr: 1.0,
  activeVelocityThresholdMmYr: 2.0,
  continentalThicknessM: DEFAULT_CONTINENTAL_THICKNESS_M,
};

interface SnapshotMaterialDiagnostics {
  volumeM3: number;
  transportedVolumeM3: number;
  routedVolumeM3: number;
  limitedVolumeM3: number;
  correctionVolumeM3: number;
  residualM3: number;
}

/**
 * Creates an immutable lightweight display snapshot from current plate state.
 */
export function captureTimeSnapshot(
  grid: CubedSphereGrid,
  plates: RigidEulerPlate[],
  reservoirs: PlateStateReservoirs,
  timeMyr: number,
  stepIndex: number,
  activeThresholdMmYr = 2.0,
  rawMinOwnership = 0.0,
  rawMaxClosureResidual = 0.0,
  maxClosureCorrection = 0.0,
  topologyCorrectionAreaM2 = 0.0,
  topologyFragmentsRemoved = 0,
  topologyPlatesReseeded = 0,
  materialDiagnostics?: SnapshotMaterialDiagnostics,
): TectonicTimeSnapshot {
  const totalCells = grid.totalCells;
  const numPlates = plates.length;

  const dominantPlateId = derivePrimaryPlateIds(
    totalCells,
    numPlates,
    reservoirs.plateAreaFraction,
    new Uint8Array(totalCells),
  );
  const boundaryField = extractKinematicBoundaries(
    grid,
    plates,
    dominantPlateId,
    activeThresholdMmYr,
    true,
    false,
  );
  const geologicalBoundaryClass = classifyGeologicalBoundaries(boundaryField, reservoirs);
  const continentalThicknessM = new Float32Array(totalCells);

  // Compute per-plate surface area percentage, closure residual, and dominance confidence
  const plateAreas = new Float64Array(numPlates);
  const closureResidual = new Float32Array(totalCells);
  const dominanceConfidence = new Float32Array(totalCells);
  let totalSurfaceAreaM2 = 0;
  let maxPartitionResidual = 0;

  for (let cell = 0; cell < totalCells; cell++) {
    const area = grid.cellAreas[cell];
    totalSurfaceAreaM2 += area;
    let sumFrac = 0;
    let maxFrac = 0;
    let continentalVolumeM3 = 0;

    for (let p = 0; p < numPlates; p++) {
      const index = cell * numPlates + p;
      const frac = reservoirs.plateAreaFraction[index];
      sumFrac += frac;
      if (frac > maxFrac) maxFrac = frac;
      plateAreas[p] += frac * area;
      continentalVolumeM3 += reservoirs.continentalVolumeM3[index] ?? 0;
    }
    continentalThicknessM[cell] = continentalVolumeM3 / area;
    const diff = sumFrac - 1.0;
    closureResidual[cell] = diff;
    dominanceConfidence[cell] = maxFrac;

    const absDiff = Math.abs(diff);
    if (absDiff > maxPartitionResidual) maxPartitionResidual = absDiff;
  }

  const plateAreaPercentages = Array.from(plateAreas).map(
    (a) => (a / totalSurfaceAreaM2) * 100,
  );

  let maxSpeedMmYr = 0;
  for (const p of plates) {
    const speedMmYr = Math.abs(p.angularVelocityRadPerMyr) * grid.radiusMeters * 1e-3;
    if (speedMmYr > maxSpeedMmYr) maxSpeedMmYr = speedMmYr;
  }

  return {
    timeMyr: Number(timeMyr.toFixed(4)),
    stepIndex,
    dominantPlateId,
    boundaryClass: geologicalBoundaryClass,
    normalVelocityMmYr: boundaryField.cellNormalVelocityMmYr,
    closureResidual,
    dominanceConfidence,
    continentalThicknessM,
    continentalVolumeM3: materialDiagnostics?.volumeM3 ?? sumContinentalVolume(reservoirs.continentalVolumeM3),
    continentalTransportedVolumeM3: materialDiagnostics?.transportedVolumeM3 ?? 0,
    continentalRoutedVolumeM3: materialDiagnostics?.routedVolumeM3 ?? 0,
    continentalLimitedVolumeM3: materialDiagnostics?.limitedVolumeM3 ?? 0,
    continentalCorrectionVolumeM3: materialDiagnostics?.correctionVolumeM3 ?? 0,
    continentalResidualM3: materialDiagnostics?.residualM3 ?? 0,
    plateAreaPercentages,
    partitionOfUnityMaxResidual: maxPartitionResidual,
    rawMinOwnership,
    rawMaxClosureResidual,
    maxClosureCorrection,
    topologyCorrectionAreaM2,
    topologyFragmentsRemoved,
    topologyPlatesReseeded,
    maxPlateVelocityMmYr: maxSpeedMmYr,
    boundaryEdgeCount: boundaryField.edgeCount,
  };
}

/**
 * Runs a complete time-stepped tectonic simulation and records immutable snapshots
 * for 60fps timeline scrubbing across geological time.
 */
export function runTectonicSimulation(
  userConfig: Partial<PlateEngineConfig> = {},
  snapshotIntervalMyr = 1.0,
): TectonicSimulationResult {
  const config: PlateEngineConfig = { ...DEFAULT_PLATE_ENGINE_CONFIG, ...userConfig };
  config.plateCount = Math.max(3, Math.min(32, Math.floor(config.plateCount)));
  const durationMyr = Math.max(1, config.durationMyr ?? 30);

  const grid = buildCubedSphereGrid(config.resolution, config.radiusMeters);
  const totalCells = grid.totalCells;
  const totalSurfaceAreaM2 = 4 * Math.PI * grid.radiusMeters * grid.radiusMeters;

  // 1. Seed plates and initial partition
  const plates = seedRigidEulerPlates(config);
  const numPlates = plates.length;
  const { plateAreaFraction } = partitionGridPlates(grid, plates);

  const reservoirs: PlateStateReservoirs = {
    plateCount: numPlates,
    totalCells,
    // Float64 ownership prevents storage roundoff from masquerading as a
    // transport closure defect. Display snapshots remain compact typed arrays.
    plateAreaFraction: new Float64Array(plateAreaFraction),
    continentalVolumeM3: initializeContinentalMaterial(
      grid,
      plates,
      plateAreaFraction,
      config.continentalFraction ?? 0.35,
      config.continentalThicknessM ?? DEFAULT_CONTINENTAL_THICKNESS_M,
      config.seed,
    ),
    oceanicVolumeM3: new Float64Array(0),
    oceanicAgeMomentM3Myr: new Float64Array(0),
    inheritedOceanicVolumeM3: new Float64Array(0),
  };
  const initialContinentalVolumeM3 = sumContinentalVolume(reservoirs.continentalVolumeM3);

  // 2. Compute CFL time stepping
  const cfl = computeCFLMetrics(grid, plates, durationMyr, config.timeStepMyr ?? 1.0);
  const snapshots: TectonicTimeSnapshot[] = [];

  // Capture initial snapshot at t = 0 Myr
  snapshots.push(
    captureTimeSnapshot(
      grid,
      plates,
      reservoirs,
      0.0,
      0,
      config.activeVelocityThresholdMmYr ?? 2.0,
      0.0,
      0.0,
      0.0,
      0.0,
      0,
      0,
      {
        volumeM3: initialContinentalVolumeM3,
        transportedVolumeM3: 0,
        routedVolumeM3: 0,
        limitedVolumeM3: 0,
        correctionVolumeM3: 0,
        residualM3: 0,
      },
    ),
  );

  // Output sampling is independent from the numerical CFL clock. Changing the
  // timeline cadence must not add transport steps or alter the final state.
  const safeSnapshotIntervalMyr = Number.isFinite(snapshotIntervalMyr) && snapshotIntervalMyr > 0
    ? snapshotIntervalMyr
    : durationMyr;
  const numIntervals = Math.max(1, Math.ceil(durationMyr / safeSnapshotIntervalMyr));
  const snapshotTimes = new Float64Array(numIntervals + 1);
  for (let index = 1; index <= numIntervals; index++) {
    snapshotTimes[index] = Math.min(durationMyr, index * safeSnapshotIntervalMyr);
  }
  let cumulativeOpeningAreaM2 = 0;
  let cumulativeConvergenceAreaM2 = 0;
  let globalMaxPartitionResidual = 0;
  let globalRawMinOwnership = 1.0;
  let globalRawMaxClosureResidual = 0.0;
  let globalMaxClosureCorrection = 0.0;
  let cumulativeClosureCorrection = 0.0;
  let cumulativeRidgeAccretionAreaM2 = 0;
  let cumulativeTrenchConsumptionAreaM2 = 0;
  let cumulativeOwnershipOpeningAreaM2 = 0;
  let cumulativeOwnershipConvergenceAreaM2 = 0;
  let cumulativeTopologyCorrectionAreaM2 = 0;
  let cumulativeTopologyFragmentsRemoved = 0;
  let cumulativeTopologyPlatesReseeded = 0;
  let cumulativeContinentalTransportedVolumeM3 = 0;
  let cumulativeContinentalRoutedVolumeM3 = 0;
  let cumulativeContinentalTopologyRoutedVolumeM3 = 0;
  let cumulativeContinentalLimitedVolumeM3 = 0;
  let cumulativeContinentalCorrectionVolumeM3 = 0;
  let cumulativeContinentalResidualM3 = 0;
  let globalRawMinContinentalVolumeM3 = 0;
  const continentalSteps: ContinentalStepLedger[] = [];
  const cumulativeOpeningByPlateM2 = new Float64Array(numPlates);
  const cumulativeConvergenceByPlateM2 = new Float64Array(numPlates);
  const initialPlateAreasM2 = new Float64Array(numPlates);
  for (let cell = 0; cell < totalCells; cell++) {
    const area = grid.cellAreas[cell];
    for (let plate = 0; plate < numPlates; plate++) {
      initialPlateAreasM2[plate] += reservoirs.plateAreaFraction[cell * numPlates + plate] * area;
    }
  }
  let totalStepsExecuted = 0;
  let nextSnapshotIndex = 1;
  let intervalRawMinOwnership = 1.0;
  let intervalRawMaxClosureResidual = 0.0;
  let intervalMaxClosureCorrection = 0.0;
  let intervalTopologyCorrectionAreaM2 = 0.0;
  let intervalTopologyFragmentsRemoved = 0;
  let intervalTopologyPlatesReseeded = 0;
  const stepLedger: StepAreaLedger = {
    openingAreaM2: 0,
    convergenceAreaM2: 0,
    ridgeAccretionAreaM2: 0,
    trenchConsumptionAreaM2: 0,
    ownershipOpeningAreaM2: 0,
    ownershipConvergenceAreaM2: 0,
    openingByPlateM2: cumulativeOpeningByPlateM2,
    convergenceByPlateM2: cumulativeConvergenceByPlateM2,
    topologyCorrectionAreaM2: 0,
    topologyFragmentsRemoved: 0,
    topologyPlatesReseeded: 0,
    continentalTransportedVolumeM3: 0,
    continentalRoutedVolumeM3: 0,
    continentalTopologyRoutedVolumeM3: 0,
    continentalLimitedVolumeM3: 0,
    continentalCorrectionVolumeM3: 0,
  };

  let numericalTimeMyr = 0;
  let previousContinentalVolumeM3 = initialContinentalVolumeM3;
  let minimumActualTimeStepMyr = Number.POSITIVE_INFINITY;
  let maximumActualTimeStepMyr = 0;
  for (let step = 1; step <= cfl.numSubsteps; step++) {
      const actualDtMyr = Math.min(cfl.dtMyr, durationMyr - numericalTimeMyr);
      const stepInitialContinentalVolumeM3 = previousContinentalVolumeM3;
      stepLedger.openingAreaM2 = 0;
      stepLedger.convergenceAreaM2 = 0;
      stepLedger.ridgeAccretionAreaM2 = 0;
      stepLedger.trenchConsumptionAreaM2 = 0;
      stepLedger.ownershipOpeningAreaM2 = 0;
      stepLedger.ownershipConvergenceAreaM2 = 0;
      stepLedger.topologyCorrectionAreaM2 = 0;
      stepLedger.topologyFragmentsRemoved = 0;
      stepLedger.topologyPlatesReseeded = 0;
      stepLedger.continentalTransportedVolumeM3 = 0;
      stepLedger.continentalRoutedVolumeM3 = 0;
      stepLedger.continentalTopologyRoutedVolumeM3 = 0;
      stepLedger.continentalLimitedVolumeM3 = 0;
      stepLedger.continentalCorrectionVolumeM3 = 0;
      const rawDiag = stepConservativeTransport(grid, plates, reservoirs, actualDtMyr, stepLedger);
      const stepFinalContinentalVolumeM3 = sumContinentalVolume(reservoirs.continentalVolumeM3);
      previousContinentalVolumeM3 = stepFinalContinentalVolumeM3;
      const stepCorrectionM3 = stepLedger.continentalCorrectionVolumeM3 ?? 0;
      const stepResidualM3 = stepFinalContinentalVolumeM3
        - stepInitialContinentalVolumeM3
        - stepCorrectionM3;
      continentalSteps.push({
        stepIndex: step,
        startTimeMyr: numericalTimeMyr,
        durationMyr: actualDtMyr,
        initialVolumeM3: stepInitialContinentalVolumeM3,
        boundaryFluxM3: 0,
        explicitSourceM3: 0,
        explicitSinkM3: 0,
        transportedVolumeM3: stepLedger.continentalTransportedVolumeM3 ?? 0,
        routedVolumeM3: stepLedger.continentalRoutedVolumeM3 ?? 0,
        topologyRoutedVolumeM3: stepLedger.continentalTopologyRoutedVolumeM3 ?? 0,
        limitedVolumeM3: stepLedger.continentalLimitedVolumeM3 ?? 0,
        correctedVolumeM3: stepCorrectionM3,
        finalVolumeM3: stepFinalContinentalVolumeM3,
        residualM3: stepResidualM3,
      });
      numericalTimeMyr += actualDtMyr;
      minimumActualTimeStepMyr = Math.min(minimumActualTimeStepMyr, actualDtMyr);
      maximumActualTimeStepMyr = Math.max(maximumActualTimeStepMyr, actualDtMyr);

      cumulativeOpeningAreaM2 += stepLedger.openingAreaM2;
      cumulativeConvergenceAreaM2 += stepLedger.convergenceAreaM2;
      cumulativeRidgeAccretionAreaM2 += stepLedger.ridgeAccretionAreaM2 ?? 0;
      cumulativeTrenchConsumptionAreaM2 += stepLedger.trenchConsumptionAreaM2 ?? 0;
      cumulativeOwnershipOpeningAreaM2 += stepLedger.ownershipOpeningAreaM2 ?? 0;
      cumulativeOwnershipConvergenceAreaM2 += stepLedger.ownershipConvergenceAreaM2 ?? 0;
      cumulativeClosureCorrection += rawDiag.totalClosureCorrection;
      cumulativeTopologyCorrectionAreaM2 += rawDiag.topologyCorrectionAreaM2;
      cumulativeTopologyFragmentsRemoved += rawDiag.topologyFragmentsRemoved;
      cumulativeTopologyPlatesReseeded += rawDiag.topologyPlatesReseeded;
      cumulativeContinentalTransportedVolumeM3 += stepLedger.continentalTransportedVolumeM3 ?? 0;
      cumulativeContinentalRoutedVolumeM3 += stepLedger.continentalRoutedVolumeM3 ?? 0;
      cumulativeContinentalTopologyRoutedVolumeM3 += stepLedger.continentalTopologyRoutedVolumeM3 ?? 0;
      cumulativeContinentalLimitedVolumeM3 += stepLedger.continentalLimitedVolumeM3 ?? 0;
      cumulativeContinentalCorrectionVolumeM3 += stepCorrectionM3;
      cumulativeContinentalResidualM3 += stepResidualM3;
      globalRawMinContinentalVolumeM3 = Math.min(
        globalRawMinContinentalVolumeM3,
        rawDiag.rawMinContinentalVolumeM3,
      );
      intervalTopologyCorrectionAreaM2 += rawDiag.topologyCorrectionAreaM2;
      intervalTopologyFragmentsRemoved += rawDiag.topologyFragmentsRemoved;
      intervalTopologyPlatesReseeded += rawDiag.topologyPlatesReseeded;
      totalStepsExecuted = step;

      if (rawDiag.rawMinOwnership < intervalRawMinOwnership) {
        intervalRawMinOwnership = rawDiag.rawMinOwnership;
      }
      if (rawDiag.rawMaxClosureResidual > intervalRawMaxClosureResidual) {
        intervalRawMaxClosureResidual = rawDiag.rawMaxClosureResidual;
      }
      if (rawDiag.maxClosureCorrection > intervalMaxClosureCorrection) {
        intervalMaxClosureCorrection = rawDiag.maxClosureCorrection;
      }
    if (intervalRawMinOwnership < globalRawMinOwnership) {
      globalRawMinOwnership = intervalRawMinOwnership;
    }
    if (intervalRawMaxClosureResidual > globalRawMaxClosureResidual) {
      globalRawMaxClosureResidual = intervalRawMaxClosureResidual;
    }
    if (intervalMaxClosureCorrection > globalMaxClosureCorrection) {
      globalMaxClosureCorrection = intervalMaxClosureCorrection;
    }

    const nearestSampleLimit = step === cfl.numSubsteps
      ? durationMyr
      : numericalTimeMyr + actualDtMyr * 0.5;
    while (nextSnapshotIndex <= numIntervals
      && snapshotTimes[nextSnapshotIndex] <= nearestSampleLimit + 1e-12) {
      const snap = captureTimeSnapshot(
        grid,
        plates,
        reservoirs,
        snapshotTimes[nextSnapshotIndex],
        totalStepsExecuted,
        config.activeVelocityThresholdMmYr ?? 2.0,
        intervalRawMinOwnership,
        intervalRawMaxClosureResidual,
        intervalMaxClosureCorrection,
        intervalTopologyCorrectionAreaM2,
        intervalTopologyFragmentsRemoved,
        intervalTopologyPlatesReseeded,
        {
          volumeM3: stepFinalContinentalVolumeM3,
          transportedVolumeM3: cumulativeContinentalTransportedVolumeM3,
          routedVolumeM3: cumulativeContinentalRoutedVolumeM3 + cumulativeContinentalTopologyRoutedVolumeM3,
          limitedVolumeM3: cumulativeContinentalLimitedVolumeM3,
          correctionVolumeM3: cumulativeContinentalCorrectionVolumeM3,
          residualM3: cumulativeContinentalResidualM3,
        },
      );

      if (snap.partitionOfUnityMaxResidual > globalMaxPartitionResidual) {
        globalMaxPartitionResidual = snap.partitionOfUnityMaxResidual;
      }
      snapshots.push(snap);
      nextSnapshotIndex++;
      intervalRawMinOwnership = 1.0;
      intervalRawMaxClosureResidual = 0.0;
      intervalMaxClosureCorrection = 0.0;
      intervalTopologyCorrectionAreaM2 = 0.0;
      intervalTopologyFragmentsRemoved = 0;
      intervalTopologyPlatesReseeded = 0;
    }
  }

  // 4. Final state extraction
  const finalDominantPlateId = derivePrimaryPlateIds(totalCells, numPlates, reservoirs.plateAreaFraction);
  const boundaries = extractKinematicBoundaries(
    grid,
    plates,
    finalDominantPlateId,
    config.activeVelocityThresholdMmYr ?? 2.0,
  );
  const finalGeologicalBoundaryClass = classifyGeologicalBoundaries(boundaries, reservoirs);
  boundaries.cellBoundaryType.set(finalGeologicalBoundaryClass);

  const timeline: TectonicSimulationTimeline = {
    durationMyr,
    snapshotIntervalMyr: safeSnapshotIntervalMyr,
    snapshots,
    plates,
  };

  const finalPlateAreasM2 = new Float64Array(numPlates);
  for (let cell = 0; cell < totalCells; cell++) {
    const area = grid.cellAreas[cell];
    for (let plate = 0; plate < numPlates; plate++) {
      finalPlateAreasM2[plate] += reservoirs.plateAreaFraction[cell * numPlates + plate] * area;
    }
  }
  const plateAreaChangeM2 = Array.from(finalPlateAreasM2, (area, plate) => (
    area - initialPlateAreasM2[plate]
  ));
  const globalAreaResidualM2 = plateAreaChangeM2.reduce((sum, change) => sum + change, 0);
  const finalContinentalVolumeM3 = sumContinentalVolume(reservoirs.continentalVolumeM3);
  const continentalVolumeResidualM3 = finalContinentalVolumeM3
    - initialContinentalVolumeM3
    - cumulativeContinentalCorrectionVolumeM3;

  const ledger: TectonicConservationLedger = {
    timeMyr: durationMyr,
    stepIndex: totalStepsExecuted,
    dtMyr: maximumActualTimeStepMyr,
    totalSubsteps: totalStepsExecuted,
    totalSurfaceAreaM2,
    openingAreaM2: cumulativeOpeningAreaM2,
    convergenceAreaM2: cumulativeConvergenceAreaM2,
    ridgeAccretionAreaM2: cumulativeRidgeAccretionAreaM2,
    trenchConsumptionAreaM2: cumulativeTrenchConsumptionAreaM2,
    ownershipOpeningAreaM2: cumulativeOwnershipOpeningAreaM2,
    ownershipConvergenceAreaM2: cumulativeOwnershipConvergenceAreaM2,
    openingByPlateM2: Array.from(cumulativeOpeningByPlateM2),
    convergenceByPlateM2: Array.from(cumulativeConvergenceByPlateM2),
    plateAreaChangeM2,
    topologyCorrectionAreaM2: cumulativeTopologyCorrectionAreaM2,
    topologyFragmentsRemoved: cumulativeTopologyFragmentsRemoved,
    topologyPlatesReseeded: cumulativeTopologyPlatesReseeded,
    netAreaResidualM2: globalAreaResidualM2,
    maxPartitionResidual: globalMaxPartitionResidual,
    rawMinOwnership: globalRawMinOwnership,
    rawMaxClosureResidual: globalRawMaxClosureResidual,
    maxClosureCorrection: globalMaxClosureCorrection,
    totalClosureCorrection: cumulativeClosureCorrection,
    initialContinentalVolumeM3,
    continentalTransportedVolumeM3: cumulativeContinentalTransportedVolumeM3,
    continentalRoutedVolumeM3: cumulativeContinentalRoutedVolumeM3,
    continentalTopologyRoutedVolumeM3: cumulativeContinentalTopologyRoutedVolumeM3,
    continentalSourceVolumeM3: 0,
    continentalSinkVolumeM3: 0,
    continentalLimitedVolumeM3: cumulativeContinentalLimitedVolumeM3,
    continentalCorrectionVolumeM3: cumulativeContinentalCorrectionVolumeM3,
    rawMinContinentalVolumeM3: globalRawMinContinentalVolumeM3,
    finalContinentalVolumeM3,
    continentalVolumeResidualM3,
    continentalVolumeRelativeError: Math.abs(continentalVolumeResidualM3)
      / Math.max(1, Math.abs(initialContinentalVolumeM3)),
    continentalSteps,
    initialOceanicVolumeM3: 0,
    createdOceanicVolumeM3: 0,
    subductedOceanicVolumeM3: 0,
    finalOceanicVolumeM3: 0,
    oceanicVolumeResidualM3: 0,
    inheritedCrustFraction: 1.0,
    maxPlateSpeedMPerMyr: cfl.maxPlateSpeedMPerMyr,
    maxDisplacementKm: (cfl.maxPlateSpeedMPerMyr * maximumActualTimeStepMyr) / 1000,
    minCellDistanceM: cfl.minCellDistanceM,
    cflDisplacementRatio: (cfl.maxPlateSpeedMPerMyr * maximumActualTimeStepMyr) / cfl.minCellDistanceM,
    targetTimeStepMyr: cfl.targetTimeStepMyr,
    minimumActualTimeStepMyr,
    maximumActualTimeStepMyr,
    integratedDurationMyr: numericalTimeMyr,
  };

  return {
    config,
    grid,
    plates,
    boundaries,
    reservoirs,
    ledger,
    timeline,
  };
}

/**
 * Runs the spherical pipeline stage by stage: tectonics, erosion, hydrology, climate, biomes.
 */
import type { SimulationConfig } from '../types/config';
import type { StageTiming, WorldV2 } from '../types/worldV2';
import { buildCubedSphereGrid, type CubedSphereGrid } from '../geometry/cubedSphere';
import { simulateTectonicHistory } from '../tectonics/tectonicHistory';
import { buildOrogenRegions } from '../tectonics/orogenRegions';
import { computeCrustalDeformation } from '../tectonics/crustalDeformation';
import { projectSnapshotCrustState, projectSnapshotOrogenicUplift, projectTectonicState } from '../tectonics/gridProjection';
import { computeIsostasyAndTopography, solveElasticFlexure } from '../tectonics/isostasy';
import { computeMonthlyInsolation } from '../climate/insolation';
import { computeSeasonalWinds } from '../climate/atmosphericCirculation';
import { simulateSeasonalClimate } from '../climate/seasonalMoisture';
import { runPriorityFlood } from '../hydrology/priorityFlood';
import { computeFlowRouting } from '../hydrology/flowRouting';
import { computeDrainageNetworks } from '../hydrology/drainageBasins';
import { applyGlacialIncision, applyStreamPowerIncision } from '../erosion/streamPower';
import { applyHillslopeDiffusion } from '../erosion/hillslopeDiffusion';
import { applySedimentTransport } from '../erosion/sedimentTransport';
import { classifySphericalBiomes } from '../ecology/biomes';

export type StageCallback = (
  stageName: string,
  stageIndex: number,
  totalStages: number,
  stageProgress: number,
  overallProgress: number
) => void;

export interface SimulationResult {
  world: WorldV2;
  grid: CubedSphereGrid;
}

/**
 * Orchestrated Multi-Physics Spherical Simulation Pipeline
 */
export async function runWorldV2Simulation(
  config: SimulationConfig,
  onProgress?: StageCallback,
  checkCancellation?: () => boolean
): Promise<SimulationResult> {
  const totalStages = 7;
  const stageTimings: StageTiming[] = [];
  const startTotalTime = performance.now();

  function stageStart(name: string, index: number, progress: number) {
    if (checkCancellation?.()) throw new Error('Simulation cancelled by user');
    onProgress?.(name, index, totalStages, 0.0, progress);
  }

  // --- Stage 1: Cubed-Sphere Geometry & Metric Tensors ---
  stageStart('Building Cubed-Sphere Grid & Seam Graph...', 1, 0.05);
  const t0 = performance.now();
  const grid = buildCubedSphereGrid(config.faceResolution, config.planetRadiusKm * 1000.0);
  const totalCells = grid.totalCells;
  stageTimings.push({ stage: 'Geometry & Topology', durationMs: performance.now() - t0 });

  // --- Stage 2: Spherical Plate Tectonics, Orogeny & Isostasy ---
  stageStart('Simulating Spherical Plate Kinematics, Orogeny & Isostasy...', 2, 0.20);
  const t1 = performance.now();
  // 1. Simulate time-stepped plate kinematics & boundary history on fixed N=64 reference grid
  const tectonicHistory = simulateTectonicHistory(config, 64);
  // 2. Classify structural orogen regions and strike kinematics
  buildOrogenRegions(tectonicHistory);
  // 3. Compute mass-conserving crustal deformation and rock hardness
  const crustalDeformation = computeCrustalDeformation(tectonicHistory, config);
  // 4. Project physical tectonic state from fixed N=64 to the output resolution grid
  const projected = projectTectonicState(tectonicHistory, crustalDeformation, grid, config.tectonicUpliftRateMmYr);
  const tectonicDurationMyr = tectonicHistory.snapshots.at(-1)?.timeMyr ?? 0;
  const landscapeEvolutionMyr = config.landscapeEvolutionMyr ?? 25;
  const landscapeHistoryStartMyr = Math.max(0, tectonicDurationMyr - landscapeEvolutionMyr);
  let initialSnapshotIndex = tectonicHistory.snapshots.findIndex(
    (snapshot) => snapshot.timeMyr >= landscapeHistoryStartMyr,
  );
  if (initialSnapshotIndex < 0) initialSnapshotIndex = tectonicHistory.snapshots.length - 1;
  if (initialSnapshotIndex < 0) throw new Error('Tectonic history produced no snapshots');
  const initialProjected = projectSnapshotCrustState(
    tectonicHistory,
    tectonicHistory.snapshots[initialSnapshotIndex],
    grid,
    config.tectonicUpliftRateMmYr,
  );
  // 5. Begin from the crustal state at the start of the active landscape
  // window. Initializing with the final root and replaying 25 Myr of uplift
  // counted the same shortening twice.
  const isostasy = computeIsostasyAndTopography(
    grid,
    projected.plates,
    initialProjected.plateIds,
    initialProjected.crustType,
    initialProjected.crustThickness,
    initialProjected.crustAge,
    initialProjected.boundaryType,
    config,
    initialProjected.normalVelocity,
    initialProjected.shearVelocity,
    tectonicHistory.edges,
    initialProjected.upliftRate,
  );
  const { initialElevation, isostaticBaseElevation } = isostasy;
  const geology = {
    ...isostasy.geology,
    plateIds: projected.plateIds,
    crustType: projected.crustType,
    crustThickness: projected.crustThickness,
    crustAge: projected.crustAge,
    boundaryType: projected.boundaryType,
    tectonicUpliftRate: projected.tectonicUpliftRate,
  };
  stageTimings.push({ stage: 'Tectonics & Isostasy', durationMs: performance.now() - t1 });

  // Lithological rock hardness field from tectonic deformation
  const rockHardness = projected.rockHardness;

  // --- Stage 3: Preliminary Seasonal Climatology ---
  stageStart('Calculating Orbital Insolation & Seasonal Winds...', 3, 0.35);
  const t2 = performance.now();
  const { monthlyDeclinationDeg, insolationWm2 } = computeMonthlyInsolation(
    grid.cellLatitudes,
    config.axialTiltDeg,
    config.solarConstantWm2
  );
  const { windU, windV } = computeSeasonalWinds(
    grid,
    monthlyDeclinationDeg,
    config.windStrength,
    config.seed
  );
  const prelimClimate = simulateSeasonalClimate(
    grid,
    insolationWm2,
    windU,
    windV,
    initialElevation,
    config
  );
  stageTimings.push({ stage: 'Preliminary Climate', durationMs: performance.now() - t2 });

  // --- Stage 4: Coupled Landscape Evolution Loop (Hydrology + Erosion + Deposition) ---
  stageStart('Simulating Coupled Fluvial Incision & Sediment Transport...', 4, 0.55);
  const t3 = performance.now();
  const currentElevation = new Float32Array(initialElevation);
  const accumulatedErodedDepth = new Float32Array(grid.totalCells);
  const incrementalLoadAnomaly = new Float32Array(grid.totalCells);
  const previousWaterDepth = new Float32Array(grid.totalCells);
  const previousIceThickness = new Float32Array(grid.totalCells);
  const landscapeSteps = Math.max(1, Math.round(landscapeEvolutionMyr / 0.25));
  const landscapeDtMyr = landscapeEvolutionMyr / landscapeSteps;
  let landscapeClimate = prelimClimate;
  let projectedSnapshotIndex = -1;
  let projectedSnapshotUplift = projected.tectonicUpliftRate;

  // Coupled landscape evolution loop consuming tectonic uplift field

  for (let iter = 0; iter < landscapeSteps; iter++) {
    if (checkCancellation?.()) throw new Error('Simulation cancelled by user');

    // Replay the time-varying forcing over the final landscape-evolution
    // window. Reusing the final snapshot for every iteration turns transient
    // plate boundaries into permanently active linear mountain painters.
    const forcingTimeMyr = landscapeHistoryStartMyr + (iter + 0.5) * landscapeDtMyr;
    let snapshotIndex = tectonicHistory.snapshots.findIndex((snapshot) => snapshot.timeMyr >= forcingTimeMyr);
    if (snapshotIndex < 0) snapshotIndex = tectonicHistory.snapshots.length - 1;
    if (snapshotIndex >= 0 && snapshotIndex !== projectedSnapshotIndex) {
      projectedSnapshotUplift = projectSnapshotOrogenicUplift(
        tectonicHistory,
        tectonicHistory.snapshots[snapshotIndex],
        grid,
        config.tectonicUpliftRateMmYr,
      );
      projectedSnapshotIndex = snapshotIndex;
    }
    const currentUpliftRate = projectedSnapshotUplift;

    // Priority-Flood Depression Filling
    const { filledElevation } = runPriorityFlood(
      grid,
      currentElevation,
      0.0,
      landscapeClimate.annualPrecipitation,
      landscapeClimate.annualEvaporation,
    );
    for (let idx = 0; idx < totalCells; idx++) {
      const waterDepth = Math.max(0, filledElevation[idx] - currentElevation[idx]);
      incrementalLoadAnomaly[idx] += 1000 * 9.81 * (waterDepth - previousWaterDepth[idx]);
      previousWaterDepth[idx] = waterDepth;
      const iceThickness = Math.max(0, landscapeClimate.iceThickness[idx]);
      incrementalLoadAnomaly[idx] += 917 * 9.81 * (iceThickness - previousIceThickness[idx]);
      previousIceThickness[idx] = iceThickness;
    }
    // Acyclic Flow Routing
    const { flowReceivers, topologicalOrder, slopes } = computeFlowRouting(grid, filledElevation, 0.0);
    // Drainage Networks
    const { drainageAreaM2 } = computeDrainageNetworks(
      grid,
      flowReceivers,
      topologicalOrder,
      landscapeClimate.annualPrecipitation,
      landscapeClimate.annualEvaporation,
      currentElevation,
      0.0
    );

    // Fluvial and glacial bedrock incision
    const fluvial = applyStreamPowerIncision(
      grid,
      currentElevation,
      drainageAreaM2,
      flowReceivers,
      topologicalOrder,
      rockHardness,
      currentUpliftRate,
      isostaticBaseElevation,
      config,
      landscapeDtMyr
    );
    const glacial = applyGlacialIncision(
      grid,
      currentElevation,
      slopes,
      rockHardness,
      landscapeClimate.iceThickness,
      config,
      landscapeDtMyr,
    );

    // Track cumulative eroded mass and surface load anomaly decrement
    for (let idx = 0; idx < totalCells; idx++) {
      const dE = fluvial.erodedDepth[idx] + glacial.erodedDepth[idx];
      accumulatedErodedDepth[idx] += dE;
      // Kinematic uplift is internally supported by shortening/root growth;
      // treating an arbitrary fraction as a new surface load was a tuning
      // parameter and double-counted its flexural response. Only material
      // actually removed from the column changes this incremental load ledger.
      incrementalLoadAnomaly[idx] -= 2700 * 9.81 * dE;
    }

    // Hillslope Diffusion
    applyHillslopeDiffusion(grid, currentElevation, rockHardness, config, 1, landscapeDtMyr);

    // Periodic Dynamic Flexural Unburdening & Climate Feedback
    if ((iter + 1) % 10 === 0 || iter === landscapeSteps - 1) {
      // Solve incremental flexural isostatic response to eroded unburdening
      const deltaDeflection = solveElasticFlexure(
        grid,
        incrementalLoadAnomaly,
        95.0,
        geology.crustType,
        5e-3,
        30,
      );
      for (let idx = 0; idx < totalCells; idx++) {
        currentElevation[idx] -= deltaDeflection[idx];
        isostaticBaseElevation[idx] -= deltaDeflection[idx];
        incrementalLoadAnomaly[idx] = 0;
      }

      landscapeClimate = simulateSeasonalClimate(
        grid,
        insolationWm2,
        windU,
        windV,
        currentElevation,
        config,
      );
    }
  }
  stageTimings.push({ stage: 'Coupled Landscape Evolution', durationMs: performance.now() - t3 });

  // --- Stage 5: Final Post-Erosion Hydrology & Sediment Layering ---
  stageStart('Recomputing Final Hydro-Conditioned Drainage Networks...', 5, 0.75);
  const t4 = performance.now();
  const { filledElevation: preSedimentFilledElev } = runPriorityFlood(
    grid,
    currentElevation,
    0.0,
    landscapeClimate.annualPrecipitation,
    landscapeClimate.annualEvaporation,
  );
  const preSedimentFlow = computeFlowRouting(grid, preSedimentFilledElev, 0.0);
  const preSedimentDrainage = computeDrainageNetworks(
    grid,
    preSedimentFlow.flowReceivers,
    preSedimentFlow.topologicalOrder,
    landscapeClimate.annualPrecipitation,
    landscapeClimate.annualEvaporation,
    currentElevation,
    0.0
  );

  // Sediment aggradation coupled directly to accumulated eroded bedrock mass
  const sedimentResult = applySedimentTransport(
    grid,
    currentElevation,
    preSedimentDrainage.discharge,
    preSedimentFlow.slopes,
    preSedimentFlow.flowReceivers,
    preSedimentFlow.topologicalOrder,
    config,
    accumulatedErodedDepth,
    landscapeEvolutionMyr,
    true,
  );
  const { sedimentThickness, bedrockElevation } = sedimentResult;

  // Sediment deposition changes the DEM. Rebuild the receiver graph after
  // aggradation so final hydrology never references a stale elevation field.
  const { filledElevation: finalFilledElev, isLakeMask, lakes: finalLakes } = runPriorityFlood(
    grid,
    currentElevation,
    0.0,
    landscapeClimate.annualPrecipitation,
    landscapeClimate.annualEvaporation,
  );
  const { flowReceivers, topologicalOrder, slopes } = computeFlowRouting(grid, finalFilledElev, 0.0);
  stageTimings.push({ stage: 'Final Hydrology & Sediment', durationMs: performance.now() - t4 });

  // --- Stage 6: Final Climatology & Biomes from Final Terrain ---
  stageStart('Re-Evaluating Final Climatology & Ecoclimatic Biomes...', 6, 0.90);
  const t5 = performance.now();
  const finalClimate = simulateSeasonalClimate(
    grid,
    insolationWm2,
    windU,
    windV,
    currentElevation,
    config
  );

  const { discharge, strahlerOrder, drainageBasin } = computeDrainageNetworks(
    grid,
    flowReceivers,
    topologicalOrder,
    finalClimate.annualPrecipitation,
    finalClimate.annualEvaporation,
    currentElevation,
    0.0
  );

  const { biomes } = classifySphericalBiomes(grid, currentElevation, finalClimate, 0.0);
  stageTimings.push({ stage: 'Final Climate & Biomes', durationMs: performance.now() - t5 });

  // --- Stage 7: Diagnostics & Final Packaging ---
  stageStart('Synthesizing Planet Diagnostics...', 7, 0.98);
  const t6 = performance.now();

  let landCount = 0;
  let sumElev = 0;
  let maxElev = -1e9;
  let minElev = 1e9;
  let sumOceanVol = 0;
  let sumDischarge = 0;
  let sumTemp = 0;
  let sumPrecip = 0;
  let iceAreaKm2 = 0;

  for (let idx = 0; idx < totalCells; idx++) {
    const elev = currentElevation[idx];
    sumElev += elev;
    if (elev > maxElev) maxElev = elev;
    if (elev < minElev) minElev = elev;

    if (elev > 0) {
      landCount++;
      const receiver = flowReceivers[idx];
      if (receiver < 0 || currentElevation[receiver] <= 0) {
        sumDischarge += discharge[idx];
      }
    } else {
      sumOceanVol += (-elev) * grid.cellAreas[idx];
    }

    sumTemp += finalClimate.meanAnnualTemperature[idx];
    sumPrecip += finalClimate.annualPrecipitation[idx];

    if (finalClimate.iceThickness[idx] > 0.1) {
      iceAreaKm2 += grid.cellAreas[idx] / 1e6;
    }
  }

  const totalSimTime = performance.now() - startTotalTime;
  stageTimings.push({ stage: 'Diagnostics & Metadata', durationMs: performance.now() - t6 });

  const world: WorldV2 = {
    version: 2,
    seed: config.seed,
    config: { ...config, landscapeEvolutionMyr },
    radiusMeters: config.planetRadiusKm * 1000.0,
    seaLevelMeters: 0.0,
    topology: grid.topology,
    geology,
    terrain: {
      elevation: currentElevation,
      bedrockElevation,
      sedimentThickness,
      slope: slopes,
      rockHardness,
    },
    hydrology: {
      flowReceivers,
      discharge,
      strahlerOrder,
      drainageBasin,
      lakes: finalLakes,
      isLakeMask,
    },
    climate: finalClimate,
    ecology: {
      biomes,
    },
    diagnostics: {
      totalExecutionTimeMs: totalSimTime,
      stageTimings,
      peakMemoryMB: Math.round((totalCells * 4 * 40) / (1024 * 1024)),
      continentalFraction: landCount / totalCells,
      meanElevationM: sumElev / totalCells,
      maxElevationM: maxElev,
      minElevationM: minElev,
      oceanVolumeM3: sumOceanVol,
      totalRiverDischargeM3s: sumDischarge,
      lakeCount: finalLakes.length,
      meanAnnualTempC: sumTemp / totalCells,
      meanAnnualPrecipMm: sumPrecip / totalCells,
      perennialIceAreaKm2: iceAreaKm2,
      sedimentInputM3: sedimentResult.initialSedimentM3,
      sedimentDepositedM3: sedimentResult.depositedSedimentM3,
      sedimentExportedM3: sedimentResult.exportedSedimentM3,
      sedimentResidualM3: sedimentResult.residualSedimentM3,
      coastalErodedSedimentM3: sedimentResult.coastalErodedSedimentM3,
      marineDepositedSedimentM3: sedimentResult.marineDepositedSedimentM3,
    },
  };

  return { world, grid };
}

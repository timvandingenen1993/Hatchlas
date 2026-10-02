import { describe, it, expect } from 'vitest';
import { buildCubedSphereGrid, cellCenterDistanceMeters } from '../src/geometry/cubedSphere';
import { runPriorityFlood } from '../src/hydrology/priorityFlood';
import { computeFlowRouting } from '../src/hydrology/flowRouting';
import { computeDrainageNetworks } from '../src/hydrology/drainageBasins';
import { applyStreamPowerIncision } from '../src/erosion/streamPower';
import { applySedimentTransport } from '../src/erosion/sedimentTransport';
import { applyHillslopeDiffusion } from '../src/erosion/hillslopeDiffusion';
import { DEFAULT_SIMULATION_CONFIG } from '../src/types/config';

describe('Spherical Hydrology & Priority-Flood (Barnes et al. 2014)', () => {
  it('should guarantee strictly acyclic flow routing to lake outlets or the sea', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const totalCells = grid.totalCells;

    // Create a synthetic terrain with an intentional depression
    const elev = new Float32Array(totalCells);
    for (let i = 0; i < totalCells; i++) {
      const z = grid.cellPositions[i * 3 + 2];
      elev[i] = z * 2000; // North = high, South = low ocean
    }
    // Put an artificial bowl in the northern hemisphere
    elev[Math.floor(totalCells * 0.75)] = -500;

    const { filledElevation } = runPriorityFlood(grid, elev, 0.0);
    const { flowReceivers } = computeFlowRouting(grid, filledElevation, 0.0);

    // Verify all land cells terminate at an ocean or lake outlet without cycles
    for (let idx = 0; idx < totalCells; idx++) {
      if (filledElevation[idx] > 0) {
        let curr = idx;
        let steps = 0;
        const maxSteps = totalCells;

        while (curr >= 0 && filledElevation[curr] > 0 && steps < maxSteps) {
          curr = flowReceivers[curr];
          steps++;
        }

        expect(steps).toBeLessThan(maxSteps); // No infinite loop/cycle
      }
    }
  });

  it('should conserve river discharge with non-decreasing downstream accumulation', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const totalCells = grid.totalCells;

    const elev = new Float32Array(totalCells);
    const precip = new Float32Array(totalCells).fill(1200); // 1200 mm/yr uniform

    for (let i = 0; i < totalCells; i++) {
      const z = grid.cellPositions[i * 3 + 2];
      elev[i] = z > 0 ? z * 3000 : -1000; // Land in north, ocean in south
    }

    const { filledElevation } = runPriorityFlood(grid, elev, 0.0);
    const { flowReceivers, topologicalOrder } = computeFlowRouting(grid, filledElevation, 0.0);
    // Correct signature: (grid, flowReceivers, topologicalOrder, annualPrecipitation, annualEvaporation, elevation, seaLevelMeters)
    const { discharge } = computeDrainageNetworks(grid, flowReceivers, topologicalOrder, precip, undefined, elev, 0.0);

    let landCells = 0;
    for (let idx = 0; idx < totalCells; idx++) {
      if (elev[idx] > 0) {
        landCells++;
        expect(discharge[idx]).toBeGreaterThan(0); // All land cells with precip must have non-zero discharge
        const receiver = flowReceivers[idx];
        if (receiver >= 0 && elev[receiver] > 0) {
          expect(discharge[receiver]).toBeGreaterThanOrEqual(discharge[idx]);
        }
      }
    }
    expect(landCells).toBeGreaterThan(0);
  });

  it('should properly modulate runoff and discharge when annualEvaporation is provided', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const totalCells = grid.totalCells;

    const elev = new Float32Array(totalCells);
    for (let i = 0; i < totalCells; i++) {
      const z = grid.cellPositions[i * 3 + 2];
      elev[i] = z > 0 ? z * 2000 : -1000;
    }

    const precip = new Float32Array(totalCells).fill(1000); // 1000 mm/yr
    const lowEvap = new Float32Array(totalCells).fill(100);  // 100 mm/yr
    const highEvap = new Float32Array(totalCells).fill(900); // 900 mm/yr

    const { filledElevation } = runPriorityFlood(grid, elev, 0.0);
    const { flowReceivers, topologicalOrder } = computeFlowRouting(grid, filledElevation, 0.0);

    const lowEvapDrainage = computeDrainageNetworks(grid, flowReceivers, topologicalOrder, precip, lowEvap, elev, 0.0);
    const highEvapDrainage = computeDrainageNetworks(grid, flowReceivers, topologicalOrder, precip, highEvap, elev, 0.0);

    for (let idx = 0; idx < totalCells; idx++) {
      if (elev[idx] > 0) {
        expect(lowEvapDrainage.discharge[idx]).toBeGreaterThan(highEvapDrainage.discharge[idx]);
      }
    }
  });

  it('should conserve watershed mass balance between local runoff generation and river mouth flux', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const totalCells = grid.totalCells;

    const elev = new Float32Array(totalCells);
    for (let i = 0; i < totalCells; i++) {
      const z = grid.cellPositions[i * 3 + 2];
      elev[i] = z > 0 ? z * 2500 : -500;
    }

    const precip = new Float32Array(totalCells).fill(800);
    const evap = new Float32Array(totalCells).fill(300);

    const { filledElevation } = runPriorityFlood(grid, elev, 0.0);
    const { flowReceivers, topologicalOrder } = computeFlowRouting(grid, filledElevation, 0.0);
    const { discharge, drainageAreaM2 } = computeDrainageNetworks(grid, flowReceivers, topologicalOrder, precip, evap, elev, 0.0);

    const SECONDS_PER_YEAR = 31536000;
    let totalGeneratedDischarge = 0;
    let totalMouthDischarge = 0;
    let totalLandAreaM2 = 0;
    let totalMouthAreaM2 = 0;

    for (let idx = 0; idx < totalCells; idx++) {
      if (elev[idx] > 0) {
        const pMm = precip[idx];
        const eMm = evap[idx];
        const runoffMm = Math.max(0.0, pMm - eMm);
        const cellArea = grid.cellAreas[idx];
        const localQ = (runoffMm / 1000.0 * cellArea) / SECONDS_PER_YEAR;
        totalGeneratedDischarge += localQ;
        totalLandAreaM2 += cellArea;

        const receiver = flowReceivers[idx];
        // If receiver is ocean or sink, this cell is a river mouth / outlet
        if (receiver < 0 || elev[receiver] <= 0) {
          totalMouthDischarge += discharge[idx];
          totalMouthAreaM2 += drainageAreaM2[idx];
        }
      }
    }

    expect(totalGeneratedDischarge).toBeGreaterThan(0);
    // Mass conservation: total generated runoff on land must equal sum of discharge at outlets (within Float32 precision)
    const relativeError = Math.abs(totalMouthDischarge - totalGeneratedDischarge) / totalGeneratedDischarge;
    expect(relativeError).toBeLessThan(1e-4);
    expect(Math.abs(totalMouthAreaM2 - totalLandAreaM2) / totalLandAreaM2).toBeLessThan(1e-10);
  });

  it('should compute physical planetary distances and metric slopes in flow routing', () => {
    const radiusMeters = 6371000;
    const grid = buildCubedSphereGrid(32, radiusMeters);
    const totalCells = grid.totalCells;

    const elev = new Float32Array(totalCells);
    // North pole high (3000m), South pole low (-1000m)
    for (let i = 0; i < totalCells; i++) {
      const z = grid.cellPositions[i * 3 + 2];
      elev[i] = z > 0 ? z * 3000 : -1000;
    }

    const { filledElevation } = runPriorityFlood(grid, elev, 0.0);
    const { slopes } = computeFlowRouting(grid, filledElevation, 0.0);

    let maxObservedSlope = 0;
    for (let idx = 0; idx < totalCells; idx++) {
      if (elev[idx] > 0) {
        if (slopes[idx] > maxObservedSlope) maxObservedSlope = slopes[idx];
        // Physical land slopes on ~300km cell spacing with 3000m elevation must be < 0.20 (20%)
        expect(slopes[idx]).toBeLessThan(0.20);
        expect(slopes[idx]).toBeGreaterThanOrEqual(1e-5);
      }
    }
    expect(maxObservedSlope).toBeGreaterThan(0.001);
  });

  it('should produce zero runoff in arid zones where evaporation exceeds precipitation', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const totalCells = grid.totalCells;

    const elev = new Float32Array(totalCells).fill(100.0); // Land everywhere
    const precip = new Float32Array(totalCells).fill(150.0); // 150 mm/yr (desert)
    const evap = new Float32Array(totalCells).fill(800.0);   // 800 mm/yr

    const { filledElevation } = runPriorityFlood(grid, elev, 0.0);
    const { flowReceivers, topologicalOrder } = computeFlowRouting(grid, filledElevation, 0.0);
    const { discharge } = computeDrainageNetworks(grid, flowReceivers, topologicalOrder, precip, evap, elev, 0.0);

    for (let idx = 0; idx < totalCells; idx++) {
      expect(discharge[idx]).toBe(0.0);
    }
  });

  it('should match the implicit one-link stream-power solution and track uplift separately', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const totalCells = grid.totalCells;

    const elev = new Float32Array(totalCells).fill(-500.0);
    elev[0] = 1500;
    elev[1] = 500;
    const drainageArea = new Float64Array(totalCells);
    drainageArea[0] = grid.cellAreas[0] * 4;
    const receivers = new Int32Array(totalCells).fill(-1);
    receivers[0] = 1;
    const hardness = new Float32Array(totalCells).fill(0.7);
    const topologicalOrder = new Int32Array(totalCells);
    for (let i = 0; i < totalCells; i++) topologicalOrder[i] = i;
    const upliftRate = new Float32Array(totalCells);
    upliftRate[0] = 0.5;
    const baseElevation = new Float32Array(totalCells).fill(-500);
    baseElevation[0] = 0;
    baseElevation[1] = 0;

    const config = {
      ...DEFAULT_SIMULATION_CONFIG,
      fluvialErosionRate: 1.0,
      glacialErosionStrength: 0.0,
    };

    const result = applyStreamPowerIncision(
      grid,
      elev,
      drainageArea,
      receivers,
      topologicalOrder,
      hardness,
      upliftRate,
      baseElevation,
      config,
      0.25,
    );

    const dtYears = 250_000;
    const uplift = 0.5e-3 * dtYears;
    const K = 5.61e-7 / 0.7;
    const c = K * Math.sqrt(drainageArea[0]) * dtYears / cellCenterDistanceMeters(grid, 0, 1);
    const expected = (1500 + uplift + c * 500) / (1 + c);
    expect(elev[0]).toBeCloseTo(expected, 3);
    expect(result.erodedVolumeM3).toBeGreaterThan(0);
    expect(result.upliftedDepth[0]).toBeCloseTo(uplift, 5);
    expect(result.erodedDepth).toBeDefined();
    expect(result.erodedDepth.length).toBe(totalCells);
    expect(result.erodedDepth[0]).toBeGreaterThan(0);
  });

  it('should conserve land volume and obey the diffusion maximum principle', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const elevation = new Float32Array(grid.totalCells);
    const hardness = new Float32Array(grid.totalCells).fill(0.7);

    for (let idx = 0; idx < grid.totalCells; idx++) {
      const x = grid.cellPositions[idx * 3];
      const y = grid.cellPositions[idx * 3 + 1];
      const z = grid.cellPositions[idx * 3 + 2];
      elevation[idx] = 2000 + 1400 * x - 700 * y + 350 * z;
    }

    let volumeBefore = 0.0;
    let minBefore = Infinity;
    let maxBefore = -Infinity;
    for (let idx = 0; idx < grid.totalCells; idx++) {
      volumeBefore += elevation[idx] * grid.cellAreas[idx];
      minBefore = Math.min(minBefore, elevation[idx]);
      maxBefore = Math.max(maxBefore, elevation[idx]);
    }

    const result = applyHillslopeDiffusion(
      grid,
      elevation,
      hardness,
      { ...DEFAULT_SIMULATION_CONFIG, hillslopeDiffusionRate: 0.1 },
      1,
      200.0,
    );

    let volumeAfter = 0.0;
    let minAfter = Infinity;
    let maxAfter = -Infinity;
    for (let idx = 0; idx < grid.totalCells; idx++) {
      volumeAfter += elevation[idx] * grid.cellAreas[idx];
      minAfter = Math.min(minAfter, elevation[idx]);
      maxAfter = Math.max(maxAfter, elevation[idx]);
    }

    expect(result.transportedVolumeM3).toBeGreaterThan(0.0);
    expect(maxAfter).toBeLessThanOrEqual(maxBefore + 1e-3);
    expect(minAfter).toBeGreaterThanOrEqual(minBefore - 1e-3);
    expect(Math.abs(volumeAfter - volumeBefore) / volumeBefore).toBeLessThan(1e-7);
  });

  it('should transport volumetric sediment and aggrade deposits in low-gradient basins', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const totalCells = grid.totalCells;

    const elev = new Float32Array(totalCells);
    const discharge = new Float32Array(totalCells).fill(25.0);
    const slopes = new Float32Array(totalCells);
    const flowReceivers = new Int32Array(totalCells).fill(-1);
    const topologicalOrder = new Int32Array(totalCells);

    // 11-cell land chain followed by an ocean outlet. Cell 9 is below the
    // low equilibrium grade to cell 10 and therefore has accommodation.
    for (let i = 0; i < 11; i++) {
      elev[i] = 1000 - i * 80;
      slopes[i] = i < 5 ? 0.05 : 0.0002; // Steep upstream, flat downstream
      flowReceivers[i] = i + 1;
      topologicalOrder[i] = i;
    }
    elev[9] = 100;
    elev[10] = 200;
    elev[11] = -500;
    for (let i = 11; i < totalCells; i++) {
      topologicalOrder[i] = i;
    }

    const config = {
      ...DEFAULT_SIMULATION_CONFIG,
      sedimentDepositionRate: 1.0,
    };

    const erodedBedrock = new Float32Array(totalCells);
    erodedBedrock[0] = 50.0; // 50m eroded bedrock at summit

    const result = applySedimentTransport(
      grid,
      elev,
      discharge,
      slopes,
      flowReceivers,
      topologicalOrder,
      config,
      erodedBedrock
    );

    expect(result.sedimentThickness).toBeDefined();
    // Low-gradient downstream cell should receive sediment deposition
    expect(result.sedimentThickness[9]).toBeGreaterThan(0);
    const sourceVolume = 50.0 * grid.cellAreas[0];
    const accounted = result.depositedSedimentM3 + result.exportedSedimentM3 + result.residualSedimentM3;
    expect(result.initialSedimentM3).toBeCloseTo(sourceVolume, -2);
    expect(accounted).toBeCloseTo(result.initialSedimentM3, -2);
  });
});

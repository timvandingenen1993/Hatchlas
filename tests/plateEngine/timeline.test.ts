import { describe, expect, it } from 'vitest';
import {
  runTectonicSimulation,
  type PlateEngineConfig,
} from '../../src/tectonics/plateEngine';
import { rasterizeProjectedLayer } from '../../src/projections/rasterizer';
import { WorldStore } from '../../src/storage/worldStore';
import type { WorldV2 } from '../../src/types/worldV2';

const TEST_CONFIG: PlateEngineConfig = {
  seed: 42,
  resolution: 24,
  radiusMeters: 6_371_000,
  plateCount: 6,
  durationMyr: 20,
  timeStepMyr: 0.5,
};

describe('Geological Timeline & Snapshot Recording', () => {
  it('records immutable snapshots at regular geological time intervals and honors timeStepMyr', () => {
    const result = runTectonicSimulation(TEST_CONFIG, 2.0); // Snapshots every 2.0 Myr
    const timeline = result.timeline;

    expect(timeline).toBeDefined();
    expect(timeline!.snapshots.length).toBeGreaterThanOrEqual(11);

    // Regular snapshot timestamps: 0.0, 2.0, 4.0, ..., 20.0 Myr
    for (let i = 0; i < timeline!.snapshots.length; i++) {
      const snap = timeline!.snapshots[i];
      const expectedTime = i * 2.0;
      expect(snap.timeMyr).toBeCloseTo(expectedTime, 1);

      expect(snap.dominantPlateId.length).toBe(result.grid.totalCells);
      expect(snap.boundaryClass.length).toBe(result.grid.totalCells);
      expect(snap.normalVelocityMmYr.length).toBe(result.grid.totalCells);
      // Shear is not retained in compact timeline snapshots because no Phase 1
      // display consumes it; the final boundary field still carries it.
      expect(snap.shearVelocityMmYr).toBeUndefined();
      expect(snap.plateAreaPercentages.length).toBe(TEST_CONFIG.plateCount);

      // Strict local partition of unity on EVERY snapshot
      expect(snap.partitionOfUnityMaxResidual).toBeLessThan(1e-5);

      // Total plate area percentages must sum to exactly 100%
      const totalPercent = snap.plateAreaPercentages.reduce((a, b) => a + b, 0);
      expect(Math.abs(totalPercent - 100)).toBeLessThan(1e-3);
    }
  });

  it('handles non-divisible snapshot interval with exact regular timestamps (interval=0.7 Myr, timestep=0.5 Myr)', () => {
    const result = runTectonicSimulation(
      {
        ...TEST_CONFIG,
        durationMyr: 10,
        timeStepMyr: 0.5,
      },
      0.7, // Non-divisible snapshot interval
    );

    const timeline = result.timeline;
    expect(timeline).toBeDefined();

    const expectedTimes = [0.0, 0.7, 1.4, 2.1, 2.8, 3.5, 4.2, 4.9, 5.6, 6.3, 7.0, 7.7, 8.4, 9.1, 9.8, 10.0];
    expect(timeline!.snapshots.length).toBe(expectedTimes.length);

    for (let i = 0; i < expectedTimes.length; i++) {
      const snap = timeline!.snapshots[i];
      expect(snap.timeMyr).toBeCloseTo(expectedTimes[i], 2);
      expect(snap.partitionOfUnityMaxResidual).toBeLessThan(1e-5);
      expect(snap.rawMinOwnership ?? 0).toBeGreaterThanOrEqual(-0.05);
      expect(snap.rawMaxClosureResidual ?? 0).toBeLessThan(0.10);
    }
  });


  it('demonstrates continuous plate boundary migration over geological time with zero partition failure', () => {
    const result = runTectonicSimulation(TEST_CONFIG, 5.0);
    const timeline = result.timeline!;
    const snap0 = timeline.snapshots[0];
    const snapEnd = timeline.snapshots[timeline.snapshots.length - 1];

    let switchedCells = 0;
    for (let cell = 0; cell < result.grid.totalCells; cell++) {
      if (snap0.dominantPlateId[cell] !== snapEnd.dominantPlateId[cell]) {
        switchedCells++;
      }
    }

    expect(switchedCells).toBeGreaterThan(0);
    expect(result.ledger.maxPartitionResidual).toBeLessThan(1e-5);
    expect(result.ledger.openingAreaM2).toBeGreaterThan(0);
    expect(result.ledger.ridgeAccretionAreaM2).toBe(result.ledger.openingAreaM2);
    expect(result.ledger.trenchConsumptionAreaM2).toBe(result.ledger.convergenceAreaM2);
    expect(result.ledger.plateAreaChangeM2).toHaveLength(TEST_CONFIG.plateCount);
    expect(result.ledger.plateAreaChangeM2!.every(Number.isFinite)).toBe(true);
  });

  it('automated UI integration: separated snapshots produce measurably different rendered plate pixels', () => {
    const result = runTectonicSimulation(
      {
        seed: 42,
        resolution: 32,
        radiusMeters: 6_371_000,
        plateCount: 8,
        durationMyr: 50,
        timeStepMyr: 1.0,
      },
      1.0,
    );

    const { grid, plates, timeline } = result;
    expect(timeline).toBeDefined();
    const finalSnapshot = timeline!.snapshots[timeline!.snapshots.length - 1];
    // A seeded identity may shrink through explicit trench consumption, but
    // Phase 1B must not silently delete it through rasterization/remapping.
    expect(Math.min(...finalSnapshot.plateAreaPercentages)).toBeGreaterThan(0);

    const world: WorldV2 = {
      version: 2,
      seed: 42,
      config: {} as any,
      radiusMeters: grid.radiusMeters,
      seaLevelMeters: 0,
      topology: grid.topology,
      geology: {
        plateCount: plates.length,
        plates: plates.map((p) => ({
          id: p.id,
          name: p.name,
          eulerPole: [p.eulerPole[0], p.eulerPole[1], p.eulerPole[2]],
          angularVelocity: p.angularVelocityRadPerMyr,
          isOceanic: true,
          color: p.color,
        })),
        plateIds: new Uint8Array(grid.totalCells),
        crustType: new Uint8Array(grid.totalCells),
        crustThickness: new Float32Array(grid.totalCells),
        crustAge: new Float32Array(grid.totalCells),
        boundaryType: new Uint8Array(grid.totalCells),
        tectonicUpliftRate: new Float32Array(grid.totalCells),
      },
      terrain: {
        elevation: new Float32Array(grid.totalCells),
        bedrockElevation: new Float32Array(grid.totalCells),
        sedimentThickness: new Float32Array(grid.totalCells),
        slope: new Float32Array(grid.totalCells),
        rockHardness: new Float32Array(grid.totalCells).fill(0.8),
      },
      hydrology: {} as any,
      climate: {} as any,
      ecology: {} as any,
      diagnostics: {} as any,
      timeline,
    };

    WorldStore.set(world, grid);

    // Render snapshot 0 (0 Myr)
    WorldStore.setSnapshotIndex(0);
    const img0 = rasterizeProjectedLayer(world, grid, {
      width: 400,
      height: 200,
      layer: 'plate_ids',
      projection: 'equal_earth',
      showHillshade: false,
    });
    const data0 = (img0 as any).data as Uint8ClampedArray;

    // Render snapshot 50 (50 Myr)
    WorldStore.setSnapshotIndex(timeline!.snapshots.length - 1);
    const img50 = rasterizeProjectedLayer(world, grid, {
      width: 400,
      height: 200,
      layer: 'plate_ids',
      projection: 'equal_earth',
      showHillshade: false,
    });
    const data50 = (img50 as any).data as Uint8ClampedArray;

    let differentPixels = 0;
    let totalInsidePixels = 0;

    for (let p = 0; p < 400 * 200; p++) {
      const a = data0[p * 4 + 3];
      if (a > 0) {
        totalInsidePixels++;
        const r0 = data0[p * 4 + 0], g0 = data0[p * 4 + 1], b0 = data0[p * 4 + 2];
        const r50 = data50[p * 4 + 0], g50 = data50[p * 4 + 1], b50 = data50[p * 4 + 2];
        if (r0 !== r50 || g0 !== g50 || b0 !== b50) {
          differentPixels++;
        }
      }
    }

    const changedFraction = differentPixels / totalInsidePixels;
    // Over 50 Myr, at least 15% of the planet surface must have migrated across plate territories
    expect(changedFraction).toBeGreaterThan(0.15);
  });
});

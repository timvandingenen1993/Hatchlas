import { describe, it, expect } from 'vitest';
import { DEFAULT_SIMULATION_CONFIG, type SimulationConfig } from '../src/types/config';
import { runWorldV2Simulation } from '../src/pipeline/stageRunner';
import { deserializeWorldV2, serializeWorldV2 } from '../src/storage/bundleV2';

describe('Multi-Physics Simulation Pipeline & Persistence', () => {
  it('should generate deterministic results across identical seeds', async () => {
    const testConfig: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, faceResolution: 32, seed: 4242 };

    const res1 = await runWorldV2Simulation(testConfig);
    const res2 = await runWorldV2Simulation(testConfig);

    const elev1 = res1.world.terrain.elevation;
    const elev2 = res2.world.terrain.elevation;

    expect(elev1.length).toBe(elev2.length);
    for (let i = 0; i < elev1.length; i++) {
      expect(elev1[i]).toBe(elev2[i]);
    }
  }, 20_000);

  it('should serialize and deserialize WorldV2 bundles without data loss', async () => {
    const testConfig: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, faceResolution: 32, seed: 9876 };
    const { world: originalWorld } = await runWorldV2Simulation(testConfig);

    const buffer = serializeWorldV2(originalWorld);
    expect(buffer.length).toBeGreaterThan(10000);

    const { world: restoredWorld } = deserializeWorldV2(buffer);

    expect(restoredWorld.version).toBe(2);
    expect(restoredWorld.seed).toBe(originalWorld.seed);
    expect(restoredWorld.topology.totalCells).toBe(originalWorld.topology.totalCells);

    // Verify elevation field precision
    for (let i = 0; i < restoredWorld.topology.totalCells; i++) {
      expect(restoredWorld.terrain.elevation[i]).toBeCloseTo(originalWorld.terrain.elevation[i], 4);
    }
  });

  it('should explicitly reject Version-1 save files with clear error messages', () => {
    const legacyV1Json = JSON.stringify({
      version: 1,
      width: 512,
      height: 512,
      seaLevel: 0.38,
      heightmap: [0.1, 0.2, 0.3],
    });

    const v1Bytes = new TextEncoder().encode(legacyV1Json);

    expect(() => {
      deserializeWorldV2(v1Bytes);
    }).toThrow(/Incompatible Version-1 Save File/);
  });
});

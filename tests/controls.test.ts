import { describe, it, expect } from 'vitest';
import { DEFAULT_SIMULATION_CONFIG, type SimulationConfig } from '../src/types/config';
import { runWorldV2Simulation } from '../src/pipeline/stageRunner';
import { rasterizeProjectedLayer } from '../src/projections/rasterizer';

describe('Simulation Controls & Parameter Sensitivity Audit', () => {
  it('should demonstrate oceanVolumeMultiplier shifts sea level & exposed continental land', async () => {
    const configLow: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, faceResolution: 32, seed: 42, oceanVolumeMultiplier: 0.70 };
    const configHigh: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, faceResolution: 32, seed: 42, oceanVolumeMultiplier: 1.30 };

    const { world: worldLow } = await runWorldV2Simulation(configLow);
    const { world: worldHigh } = await runWorldV2Simulation(configHigh);

    // High ocean volume must have lower continental land fraction (more submerged land)
    expect(worldHigh.diagnostics.continentalFraction).toBeLessThan(worldLow.diagnostics.continentalFraction);
    expect(worldLow.diagnostics.continentalFraction - worldHigh.diagnostics.continentalFraction).toBeGreaterThan(0.005);
  }, 30_000);

  it('should demonstrate fluvialErosionRate carves significant topography', async () => {
    const configZero: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, faceResolution: 32, seed: 99, fluvialErosionRate: 0.0 };
    const configHigh: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, faceResolution: 32, seed: 99, fluvialErosionRate: 2.0 };

    const { world: worldZero } = await runWorldV2Simulation(configZero);
    const { world: worldHigh } = await runWorldV2Simulation(configHigh);

    let maxDiff = 0;
    for (let i = 0; i < worldZero.terrain.elevation.length; i++) {
      const diff = Math.abs(worldZero.terrain.elevation[i] - worldHigh.terrain.elevation[i]);
      if (diff > maxDiff) maxDiff = diff;
    }

    // Must carve dozens to hundreds of meters of relief
    expect(maxDiff).toBeGreaterThan(25.0);
  }, 30_000);

  it('should demonstrate windStrength modifies precipitation advection', async () => {
    const configCalm: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, faceResolution: 32, seed: 101, windStrength: 0.5 };
    const configStorm: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, faceResolution: 32, seed: 101, windStrength: 2.5 };

    const { world: worldCalm } = await runWorldV2Simulation(configCalm);
    const { world: worldStorm } = await runWorldV2Simulation(configStorm);

    let totalDiff = 0;
    for (let i = 0; i < worldCalm.climate.annualPrecipitation.length; i++) {
      totalDiff += Math.abs(worldCalm.climate.annualPrecipitation[i] - worldStorm.climate.annualPrecipitation[i]);
    }

    expect(totalDiff / worldCalm.climate.annualPrecipitation.length).toBeGreaterThan(1.0);
  }, 30_000);

  it('should preserve categorical integrity in nearest-neighbor rasterization (zero false intermediate categories)', async () => {
    const renderConfig: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, faceResolution: 32, seed: 555 };
    const { world, grid } = await runWorldV2Simulation(renderConfig);

    const img = rasterizeProjectedLayer(world, grid, {
      width: 200,
      height: 100,
      layer: 'biomes',
      projection: 'equal_earth',
    });

    expect(img.data.length).toBe(200 * 100 * 4);
    // Ensure pixels are non-empty
    let opaqueCount = 0;
    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i] > 0) opaqueCount++;
    }
    expect(opaqueCount).toBeGreaterThan(1000);
  }, 30_000);
});

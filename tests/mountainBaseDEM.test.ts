import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi } from 'vitest';
import {
  decodeTiffHeightmap,
  getHeightmapExportAnalysisResolution,
  getMountainClimateZoneLabel,
  getHeightmapFitResolution,
  loadHeightmapImage,
  processMountainBaseDEM,
  rebuildMountainEvolutionStep,
  applyRiparianCorridors,
  separateDesertFromWetland,
  resampleHeightmapMask,
  type MountainEvolutionState,
  resampleHeightmapLuminance,
  sampleMountainElevationProfile,
  smoothHeightmapLuminance,
} from '../src/terrain/mountainBaseDEM';
import { renderMountainDetailDEM } from '../src/rendering/mountainDetailRenderer';

describe('2D Mountain Base DEM & Geomorphic Pipeline', () => {
  it('decodes uncompressed single-band float TIFF heightmaps', () => {
    const width = 2;
    const height = 2;
    const samples = [10, -9998.4, 30, 40];
    const entryCount = 11;
    const dataOffset = 8 + 2 + entryCount * 12 + 4;
    const buffer = new ArrayBuffer(dataOffset + samples.length * 4);
    const view = new DataView(buffer);

    view.setUint8(0, 0x49);
    view.setUint8(1, 0x49);
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, entryCount, true);

    const entries: Array<[number, number, number]> = [
      [256, 3, width],
      [257, 3, height],
      [258, 3, 32],
      [259, 3, 1],
      [262, 3, 1],
      [273, 4, dataOffset],
      [277, 3, 1],
      [278, 4, height],
      [279, 4, samples.length * 4],
      [284, 3, 1],
      [339, 3, 3],
    ];
    entries.forEach(([tag, type, value], index) => {
      const offset = 10 + index * 12;
      view.setUint16(offset, tag, true);
      view.setUint16(offset + 2, type, true);
      view.setUint32(offset + 4, 1, true);
      if (type === 3) view.setUint16(offset + 8, value, true);
      else view.setUint32(offset + 8, value, true);
    });
    samples.forEach((sample, index) => view.setFloat32(dataOffset + index * 4, sample, true));

    const decoded = decodeTiffHeightmap(buffer);
    expect(decoded?.width).toBe(width);
    expect(decoded?.height).toBe(height);
    expect(decoded?.rawLuminance[0]).toBeCloseTo(0.4);
    expect(decoded?.rawLuminance[1]).toBeCloseTo(0);
    expect(decoded?.oceanMask?.[1]).toBe(1);
    expect(decoded?.rawLuminance[2]).toBeCloseTo(0.8);
    expect(decoded?.rawLuminance[3]).toBeCloseTo(1);
  });

  it('preserves the 16-bit samples in the bundled 16-bit heightmap PNG', async () => {
    const pngBytes = await readFile(new URL('../src/assets/Heightmap2.png', import.meta.url));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      async () => new Response(new Blob([pngBytes.buffer as ArrayBuffer]), { status: 200 })
    );

    try {
      const decoded = await loadHeightmapImage('Heightmap2.png');
      expect(decoded.width).toBe(4096);
      expect(decoded.height).toBe(4096);
      expect(decoded.rawLuminance.length).toBe(4096 * 4096);
      expect(decoded.rawLuminance.some((sample) => Math.abs(sample * 255 - Math.round(sample * 255)) > 1e-6)).toBe(true);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('fits custom output sizes to the source aspect ratio and preserves heightmap edges', () => {
    const fitted = getHeightmapFitResolution(681, 1024, 8192);
    expect(fitted).toEqual({ width: 5448, height: 8192 });

    const fitted16K = getHeightmapFitResolution(681, 1024, 16384);
    expect(fitted16K).toEqual({ width: 10896, height: 16384 });

    const clamped = getHeightmapFitResolution(681, 1024, 32768);
    expect(clamped).toEqual(fitted16K);

    const source = new Float32Array([
      0.0, 0.25,
      0.75, 1.0,
    ]);
    const scaled = resampleHeightmapLuminance(source, 2, 2, 3, 3);

    expect(scaled.length).toBe(9);
    expect(scaled[0]).toBeCloseTo(0.0);
    expect(scaled[2]).toBeCloseTo(0.25);
    expect(scaled[6]).toBeCloseTo(0.75);
    expect(scaled[8]).toBeCloseTo(1.0);
    expect(scaled[4]).toBeCloseTo(0.5);
  });

  it('uses the highest available source resolution for export analysis', () => {
    expect(getHeightmapExportAnalysisResolution(4096, 4096, 8192, 8192)).toEqual({
      width: 4096,
      height: 4096,
    });
    // An 8K source is capped by cell count so the export DEM stays in memory.
    const capped = getHeightmapExportAnalysisResolution(8192, 8192, 8192, 8192);
    expect(capped.width * capped.height).toBeLessThanOrEqual(24_000_000);
    expect(capped.width).toBeGreaterThan(4800);
    expect(getHeightmapExportAnalysisResolution(8192, 4096, 4096, 2048)).toEqual({
      width: 4096,
      height: 2048,
    });
    expect(getHeightmapExportAnalysisResolution(1024, 1024, 8192, 8192)).toEqual({
      width: 1024,
      height: 1024,
    });
    expect(getHeightmapExportAnalysisResolution(4096, 4096, 8192, 8192, 2048)).toEqual({
      width: 2048,
      height: 2048,
    });
  });

  it('keeps source ocean cells as masked DEM substrate with a separate water datum', () => {
    const oceanMask = new Uint8Array([
      1, 0,
      0, 1,
    ]);
    const resampledMask = resampleHeightmapMask(oceanMask, 2, 2, 2, 2);
    const dem = processMountainBaseDEM(new Float32Array([
      0.0, 0.5,
      0.75, 1.0,
    ]), 2, 2, {
      minElevationM: 80,
      maxElevationM: 1080,
      oceanElevationM: -35,
      oceanMask: resampledMask,
      biomeRegionScaleKm: 0,
    });

    expect(dem.elevation[0]).toBeCloseTo(80);
    expect(dem.elevation[3]).toBeCloseTo(1080);
    expect(dem.oceanSurfaceElevationM).toBeCloseTo(-35);
    expect(dem.elevation[1]).toBeCloseTo(580);
    expect(dem.elevation[2]).toBeCloseTo(830);
    expect(dem.biomeType[0]).toBe(8);
    expect(dem.biomeType[3]).toBe(8);
    expect(dem.isOcean[0]).toBe(1);
    expect(dem.isOcean[1]).toBe(0);
    expect(dem.isRiverChannel[0]).toBe(0);
    expect(dem.isRiverChannel[3]).toBe(0);
    expect(dem.waterDepthM[0]).toBe(0);
    expect(dem.waterDepthM[3]).toBe(0);
  });

  it('classifies every terrain cell below the ocean height as ocean', () => {
    const dem = processMountainBaseDEM(new Float32Array([
      0.0, 0.5,
      0.75, 1.0,
    ]), 2, 2, {
      minElevationM: -100,
      maxElevationM: 100,
      oceanElevationM: 0,
      biomeRegionScaleKm: 0,
    });

    expect(dem.elevation[0]).toBeCloseTo(-100);
    expect(dem.biomeType[0]).toBe(8);
    expect(dem.isOcean[0]).toBe(1);
    expect(dem.elevation[1]).toBeCloseTo(0);
    expect(dem.biomeType[1]).toBe(8);
    expect(dem.elevation[2]).toBeCloseTo(50);
    expect(dem.biomeType[2]).not.toBe(8);
  });

  it('derives sandy shore and coastal cliff variants from the ocean edge shape', () => {
    const width = 24;
    const height = 24;
    const oceanMask = new Uint8Array(width * height);
    const flat = new Float32Array(width * height).fill(0.004);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < 3; x++) oceanMask[y * width + x] = 1;
    }

    const sandy = processMountainBaseDEM(flat, width, height, {
      domainWidthKm: 0.96,
      domainHeightKm: 0.96,
      minElevationM: 0,
      maxElevationM: 1200,
      oceanElevationM: 0,
      oceanMask,
      riverThresholdKm2: 100,
      biomeRegionScaleKm: 0,
    });

    expect(sandy.biomeType[12 * width + 3]).toBe(11);
    expect(sandy.biomeType[12 * width + 23]).not.toBe(11);

    const cliffHeightmap = flat.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 4; x < width; x++) cliffHeightmap[y * width + x] = 0.92;
    }
    const cliff = processMountainBaseDEM(cliffHeightmap, width, height, {
      domainWidthKm: 0.96,
      domainHeightKm: 0.96,
      minElevationM: 0,
      maxElevationM: 1200,
      oceanElevationM: 0,
      oceanMask,
      riverThresholdKm2: 100,
      biomeRegionScaleKm: 0,
    });

    expect(cliff.biomeType[12 * width + 3]).toBe(14);
  });

  it('denoises isolated height noise while preserving a sharp terrain edge', () => {
    const width = 9;
    const height = 9;
    const noisy = new Float32Array(width * height).fill(0.5);

    noisy[4 * width + 4] = 0.56;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x >= 6) noisy[y * width + x] = 0.9;
      }
    }

    const smoothed = smoothHeightmapLuminance(noisy, width, height, 2);
    expect(smoothed[4 * width + 4]).toBeLessThan(noisy[4 * width + 4]);
    expect(smoothed[4 * width + 7]).toBeGreaterThan(0.8);
    expect(smoothed[4 * width + 4]).toBeLessThan(0.7);
  });

  it('uses regional climate fields to keep biome boundaries zonal', () => {
    const W = 96;
    const H = 96;
    const rawLuminance = new Float32Array(W * H);
    // Holdridge boreal/cool temperate line (biotemperature 6 °C) at a 22 °C
    // base temperature and 6.5 °C/km lapse rate. The warm base lifts the line
    // above the meadow elevation limit, so the flat belt keeps its forests.
    const baseTemperatureC = 22;
    const threshold = (((baseTemperatureC - 6) / 6.5) * 1000) / 3000;

    // A broad elevation belt crosses that biome threshold. Add a
    // checker/noise signal around that threshold to model DEM-scale relief.
    // It should not turn the ecological boundary into a pixel checkerboard.
    for (let y = 0; y < H; y++) {
      const belt = (y - 44) * 0.0009 + Math.sin(y * 1.7) * 0.004;
      for (let x = 0; x < W; x++) {
        const pixelNoise = ((x + y) % 2 === 0 ? 1 : -1) * 0.012;
        rawLuminance[y * W + x] = Math.max(0.05, Math.min(0.95, threshold + belt + pixelNoise));
      }
    }

    const countTransitions = (biomes: Uint8Array): number => {
      let transitions = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const index = y * W + x;
          if (x + 1 < W && biomes[index] !== biomes[index + 1]) transitions++;
          if (y + 1 < H && biomes[index] !== biomes[index + W]) transitions++;
        }
      }
      return transitions;
    };

    const cellScale = processMountainBaseDEM(rawLuminance, W, H, {
      minElevationM: 0,
      maxElevationM: 3000,
      domainWidthKm: 45,
      riverThresholdKm2: 10_000,
      wetlandElevationThresholdM: 0,
      biomeRegionScaleKm: 0,
      baseTemperatureC,
    });
    const regional = processMountainBaseDEM(rawLuminance, W, H, {
      minElevationM: 0,
      maxElevationM: 3000,
      domainWidthKm: 45,
      riverThresholdKm2: 10_000,
      wetlandElevationThresholdM: 0,
      biomeRegionScaleKm: 1.5,
      baseTemperatureC,
    });

    const cellTransitions = countTransitions(cellScale.biomeType);
    const regionalTransitions = countTransitions(regional.biomeType);
    expect(cellTransitions).toBeGreaterThan(300);
    expect(regionalTransitions).toBeLessThan(cellTransitions * 0.35);
    expect(regionalTransitions).toBeLessThan(W * 2);
  });

  it('opens flat, low ground in the forest belts into montane meadow', () => {
    const W = 64;
    const H = 64;
    const options = {
      minElevationM: 0,
      maxElevationM: 3000,
      domainWidthKm: 3,
      domainHeightKm: 3,
      riverThresholdKm2: 10_000,
      wetlandElevationThresholdM: 0,
    };
    const share = (biomes: Uint8Array, biome: number): number =>
      biomes.filter((value) => value === biome).length / biomes.length;

    const flat = processMountainBaseDEM(new Float32Array(W * H).fill(0.3), W, H, options);
    expect(share(flat.biomeType, 20)).toBeGreaterThan(0.9);

    // An 1800 m rise over 3 km (about 31 degrees) keeps the forest belt but no flats.
    const ramp = new Float32Array(W * H);
    for (let y = 0; y < H; y++) ramp.fill(0.05 + (y / (H - 1)) * 0.6, y * W, (y + 1) * W);
    const steep = processMountainBaseDEM(ramp, W, H, options);
    expect(share(steep.biomeType, 20)).toBeLessThan(0.05);
  });

  it('varies beach width along a flat coast using the shared noise scale', () => {
    const width = 128, height = 112;
    const raw = new Float32Array(width * height).fill(0.005);
    const oceanMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) oceanMask.fill(1, y * width, y * width + 40);
    const options = { domainWidthKm: 3.2, domainHeightKm: 2.8,
      minElevationM: 0, maxElevationM: 1000, oceanElevationM: 0,
      oceanMask, riverThresholdKm2: 10000, biomeEdgeNoiseScaleM: 800 };
    const dem = processMountainBaseDEM(raw, width, height, options);
    const widths = Array.from({ length: height }, (_, y) =>
      dem.biomeType.slice(y * width + 40, (y + 1) * width).filter(value => value === 11).length);
    expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThan(2);
    const otherRegions = processMountainBaseDEM(raw, width, height, { ...options, biomeRegionScaleKm: 0.01 });
    expect(otherRegions.biomeType.map(value => value === 11 ? 1 : 0))
      .toEqual(dem.biomeType.map(value => value === 11 ? 1 : 0));
  });

  it('warps regional land-biome edges deterministically while preserving ocean cells', () => {
    const width = 128;
    const height = 112;
    const rawLuminance = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      // Centred on the Holdridge boreal/cool temperate line (see above).
      const band = (((18 - 6) / 6.5) * 1000) / 3000 + (height / 2 - y) * 0.0022;
      for (let x = 0; x < width; x++) rawLuminance[y * width + x] = band;
    }
    const oceanMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      oceanMask[y * width] = 1;
      oceanMask[y * width + 1] = 1;
    }
    const options = {
      minElevationM: 0,
      maxElevationM: 3000,
      domainWidthKm: 3.2,
      domainHeightKm: 2.8,
      riverThresholdKm2: 10_000,
      wetlandElevationThresholdM: 0,
      biomeRegionScaleKm: 0.5,
      oceanMask,
    };
    const first = processMountainBaseDEM(rawLuminance, width, height, options);
    const unwarped = processMountainBaseDEM(rawLuminance, width, height, { ...options, biomeEdgeStrength: 0 });
    expect(first.biomeType.some((value, index) => value >= 1 && value <= 5 &&
      unwarped.biomeType[index] >= 1 && unwarped.biomeType[index] <= 5 &&
      value !== unwarped.biomeType[index])).toBe(true);
    const second = processMountainBaseDEM(rawLuminance, width, height, options);
    let horizontalLandEdges = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 2; x < width - 1; x++) {
        const left = first.biomeType[y * width + x];
        const right = first.biomeType[y * width + x + 1];
        if (left !== right && left >= 1 && left <= 5 && right >= 1 && right <= 5) {
          horizontalLandEdges++;
        }
      }
    }

    expect(second.biomeType).toEqual(first.biomeType);
    expect(horizontalLandEdges).toBeGreaterThan(0);
    for (let y = 0; y < height; y++) {
      expect(first.biomeType[y * width]).toBe(8);
      expect(first.biomeType[y * width + 1]).toBe(8);
    }
  });

  it('uses base climate temperature to move the snowline and biome bands', () => {
    const W = 64;
    const H = 64;
    const rawLuminance = new Float32Array(W * H);

    for (let y = 0; y < H; y++) {
      const elevationBand = 0.05 + (y / (H - 1)) * 0.9;
      for (let x = 0; x < W; x++) rawLuminance[y * W + x] = elevationBand;
    }

    const options = {
      minElevationM: 0,
      maxElevationM: 4000,
      domainWidthKm: 45,
      riverThresholdKm2: 10_000,
      wetlandElevationThresholdM: 0,
      biomeRegionScaleKm: 0.5,
    };
    const warm = processMountainBaseDEM(rawLuminance, W, H, { ...options, baseTemperatureC: 24 });
    const cold = processMountainBaseDEM(rawLuminance, W, H, { ...options, baseTemperatureC: 4 });
    const countBiome = (biomes: Uint8Array, id: number): number =>
      biomes.reduce((count, biome) => count + (biome === id ? 1 : 0), 0);

    expect(cold.temperatureC[W * 32]).toBeLessThan(warm.temperatureC[W * 32]);
    expect(countBiome(cold.biomeType, 0)).toBeGreaterThan(countBiome(warm.biomeType, 0));
    expect(countBiome(cold.biomeType, 0) + countBiome(cold.biomeType, 2))
      .toBeGreaterThan(countBiome(warm.biomeType, 0) + countBiome(warm.biomeType, 2));
  });

  describe('Holdridge climate biomes', () => {
    const W = 64;
    const H = 64;
    // A gentle lowland plain with a shallow diagonal valley.
    const plain = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const valley = Math.abs(x - y) / W;
        plain[y * W + x] = 0.04 + 0.03 * ((x + y) / (W + H)) + 0.04 * valley;
      }
    }
    // Climate-only runs: no rivers and no valley-floor wetland rule.
    const climateOnly = {
      minElevationM: 0,
      maxElevationM: 2000,
      domainWidthKm: 20,
      riverThresholdKm2: 10_000,
      wetlandElevationThresholdM: 0,
      biomeRegionScaleKm: 0.5,
    };
    const countBiome = (biomes: Uint8Array, ids: number[]): number =>
      biomes.reduce((count, biome) => count + (ids.includes(biome) ? 1 : 0), 0);

    it('turns tropical desert scrub into desert, never wetland or woodland', () => {
      const dem = processMountainBaseDEM(plain, W, H, {
        ...climateOnly, wetlandElevationThresholdM: 400,
        baseTemperatureC: 28, basePrecipitationMmYr: 100,
      });
      expect(getMountainClimateZoneLabel(dem, 32 * W + 32)).toMatch(/^Tropical desert( scrub)?$/);
      expect(countBiome(dem.biomeType, [15, 16])).toBe(W * H);
    });

    it('maps warm temperate thorn steppe to dry steppe', () => {
      const dem = processMountainBaseDEM(plain, W, H, {
        ...climateOnly, baseTemperatureC: 18, basePrecipitationMmYr: 350,
      });
      expect(getMountainClimateZoneLabel(dem, 32 * W + 32)).toMatch(/thorn (steppe|woodland)/);
      expect(countBiome(dem.biomeType, [17])).toBe(W * H);
    });

    it('maps cool temperate steppe to grassland', () => {
      const dem = processMountainBaseDEM(plain, W, H, {
        ...climateOnly, baseTemperatureC: 10, basePrecipitationMmYr: 400,
      });
      expect(getMountainClimateZoneLabel(dem, 32 * W + 32)).toBe('Cool temperate steppe');
      expect(countBiome(dem.biomeType, [18])).toBe(W * H);
    });

    it('keeps valley wetlands in humid climates', () => {
      const humid = processMountainBaseDEM(plain, W, H, {
        ...climateOnly, wetlandElevationThresholdM: 400,
        baseTemperatureC: 18, basePrecipitationMmYr: 2400,
      });
      expect(countBiome(humid.biomeType, [7])).toBeGreaterThan(W * H * 0.5);
      expect(countBiome(humid.biomeType, [15, 16, 17, 18, 19])).toBe(0);
    });

    it('greens river banks with a shallow water table (HAND < 15 m) in a dry climate', () => {
      const RW = 160;
      const RH = 160;
      // A wet range in the west drains a river east across a dry plain.
      const terrain = new Float32Array(RW * RH);
      for (let y = 0; y < RH; y++) {
        for (let x = 0; x < RW; x++) {
          const range = Math.exp(-(((x - 18) / 16) ** 2)) * 0.85;
          terrain[y * RW + x] = 0.03 + range + 0.03 * Math.abs(y - RH / 2) / (RH / 2) + 0.04 * (1 - x / RW);
        }
      }
      const dem = processMountainBaseDEM(terrain, RW, RH, {
        minElevationM: 0, maxElevationM: 3500, domainWidthKm: 30, biomeRegionScaleKm: 0.5,
        riverThresholdKm2: 2, windAzimuthDeg: 270, windSpeedMs: 16,
        baseTemperatureC: 26, basePrecipitationMmYr: 500,
      });
      const hand = dem.heightAboveDrainageM!;
      let banks = 0;
      let dryUplands = 0;
      for (let y = 0; y < RH; y++) {
        for (let x = 80; x < RW; x++) {
          const index = y * RW + x;
          if (dem.isRiverChannel[index] === 1) continue;
          if (hand[index] < 15) {
            banks++;
            expect([15, 16, 17, 18]).not.toContain(dem.biomeType[index]);
          } else if ([15, 16, 17].includes(dem.biomeType[index])) {
            dryUplands++;
          }
        }
      }
      expect(banks).toBeGreaterThan(0);
      expect(dryUplands).toBeGreaterThan(banks);
    });

    it('keeps rain-shadow rainfall above a realistic floor', () => {
      const RW = 120;
      const RH = 120;
      const range = new Float32Array(RW * RH);
      for (let y = 0; y < RH; y++) {
        for (let x = 0; x < RW; x++) {
          const dx = (x - RW / 2) / (RW * 0.16);
          const dy = (y - RH / 2) / (RH * 0.38);
          range[y * RW + x] = 0.05 + 0.9 * Math.exp(-(dx * dx + dy * dy));
        }
      }
      const base = 1000;
      const dem = processMountainBaseDEM(range, RW, RH, {
        minElevationM: 80, maxElevationM: 3850, domainWidthKm: 45,
        riverThresholdKm2: 40, windAzimuthDeg: 225, windSpeedMs: 16,
        baseTemperatureC: 18, basePrecipitationMmYr: base,
      });
      // Without the floor the shadow falls to a few percent of base rainfall.
      expect(Math.min(...dem.precipitationMmYr)).toBeGreaterThanOrEqual(base * 0.4 - 1);
    });

    it('does not make wetland from a shallow water table in a desert climate', () => {
      const RW = 160;
      const RH = 160;
      const terrain = new Float32Array(RW * RH);
      for (let y = 0; y < RH; y++) {
        for (let x = 0; x < RW; x++) {
          const range = Math.exp(-(((x - 18) / 16) ** 2)) * 0.85;
          terrain[y * RW + x] = 0.03 + range + 0.03 * Math.abs(y - RH / 2) / (RH / 2) + 0.04 * (1 - x / RW);
        }
      }
      const dem = processMountainBaseDEM(terrain, RW, RH, {
        minElevationM: 0, maxElevationM: 3500, domainWidthKm: 30, biomeRegionScaleKm: 0.5,
        riverThresholdKm2: 2, windAzimuthDeg: 270, windSpeedMs: 16,
        baseTemperatureC: 30, basePrecipitationMmYr: 300, wetlandElevationThresholdM: 3500,
      });
      let waterloggedDesert = 0;
      for (let index = 0; index < RW * RH; index++) {
        if (dem.isOcean[index] === 1 || dem.isRiverChannel[index] === 1) continue;
        const zone = getMountainClimateZoneLabel(dem, index);
        if (!/desert|Bare soil/i.test(zone)) continue;
        if (dem.heightAboveDrainageM![index] < 5.3) waterloggedDesert++;
        expect(dem.biomeType[index]).not.toBe(7);
      }
      // Precondition: the scene does contain waterlogged ground in desert.
      expect(waterloggedDesert).toBeGreaterThan(0);
    });

    it('keeps a semi-arid buffer between desert and wetland', () => {
      const BW = 40;
      const BH = 9;
      const biomes = new Uint8Array(BW * BH).fill(15);
      for (let y = 0; y < BH; y++) biomes[y * BW + 2] = 7;
      separateDesertFromWetland(BW, BH, biomes, 5);
      const row = (x: number) => biomes[4 * BW + x];
      expect(row(2)).toBe(7);
      expect(row(7)).toBe(17); // within the buffer: dry steppe
      expect(row(8)).toBe(15); // beyond the buffer: still desert
      expect(row(0)).toBe(17);
      // Non-desert neighbours are left alone.
      const forest = new Uint8Array(BW * BH).fill(4);
      forest[4 * BW + 2] = 7;
      separateDesertFromWetland(BW, BH, forest, 5);
      expect(forest[4 * BW + 3]).toBe(4);
    });

    it('greens dry ground along a river out to a reach that grows with stream order', () => {
      const CW = 80;
      const CH = 6;
      const run = (order: number, dry: number) => {
        const biomes = new Uint8Array(CW * CH).fill(dry);
        const river = new Uint8Array(CW * CH);
        const orders = new Uint8Array(CW * CH);
        for (let y = 0; y < CH; y++) {
          river[y * CW] = 1;
          orders[y * CW] = order;
        }
        applyRiparianCorridors(CW, CH, biomes, new Uint8Array(CW * CH), river, orders, 100, 100, 800);
        // First column of ground that is still dry, i.e. the corridor width in cells.
        let x = 1;
        while (x < CW && biomes[2 * CW + x] !== dry) x++;
        return { biomes, edge: x };
      };
      const small = run(1, 17);
      const large = run(4, 17);
      // 100 m cells: reach is 300 m (order 1) and 750 m (order 4), +-30%.
      expect(small.edge).toBeGreaterThanOrEqual(2);
      expect(small.edge).toBeLessThanOrEqual(5);
      expect(large.edge).toBeGreaterThanOrEqual(5);
      expect(large.edge).toBeLessThanOrEqual(10);
      expect(large.edge).toBeGreaterThan(small.edge);
      expect(large.biomes[2 * CW + 1]).toBe(5); // steppe becomes riparian shrubland
      expect(large.biomes[2 * CW + 70]).toBe(17); // far ground stays dry
      expect(run(4, 15).biomes[2 * CW + 1]).toBe(19); // desert becomes oasis
    });

    it('dries the lee side of a range through the rain shadow', () => {
      const RW = 120;
      const RH = 120;
      const range = new Float32Array(RW * RH);
      for (let y = 0; y < RH; y++) {
        for (let x = 0; x < RW; x++) {
          const dx = (x - RW / 2) / (RW * 0.16);
          const dy = (y - RH / 2) / (RH * 0.38);
          range[y * RW + x] = 0.05 + 0.9 * Math.exp(-(dx * dx + dy * dy));
        }
      }
      // Wind from the south-west (225°) puts the rain shadow in the east.
      const dem = processMountainBaseDEM(range, RW, RH, {
        minElevationM: 80, maxElevationM: 3850, domainWidthKm: 45,
        riverThresholdKm2: 40, biomeRegionScaleKm: 1, windAzimuthDeg: 225, windSpeedMs: 16,
        baseTemperatureC: 18, basePrecipitationMmYr: 600,
      });
      // Smith & Barstad: rain rises on the windward (south-west) flank and
      // falls on the lee.
      expect(dem.precipitationMmYr[60 * RW + 40]).toBeGreaterThan(dem.precipitationMmYr[60 * RW + 100] * 3);
      const countSide = (fromX: number, toX: number): number => {
        let count = 0;
        for (let y = 30; y < 90; y++) {
          for (let x = fromX; x < toX; x++) {
            if ([15, 16, 17].includes(dem.biomeType[y * RW + x])) count++;
          }
        }
        return count;
      };
      expect(countSide(95, RW)).toBeGreaterThan(countSide(0, 25));
    });
  });

  it('processes raw heightmap luminance into complete geomorphic fields', () => {
    const W = 68;
    const H = 102;
    const rawLuminance = new Float32Array(W * H);

    // Create gradient synthetic heightmap (peaks at top, valleys in middle, basin at bottom)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const normY = y / (H - 1);
        rawLuminance[idx] = Math.max(0.0, Math.min(1.0, 1.0 - normY * 0.85 + 0.1 * Math.sin(x * 0.2)));
      }
    }

    const dem = processMountainBaseDEM(rawLuminance, W, H, {
      domainWidthKm: 45,
      minElevationM: 80,
      maxElevationM: 3850,
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 3.5,
    });

    expect(dem.width).toBe(W);
    expect(dem.height).toBe(H);
    expect(dem.elevation.length).toBe(W * H);
    expect(dem.slopeDeg.length).toBe(W * H);
    expect(dem.aspectDeg.length).toBe(W * H);
    expect(dem.hillshade.length).toBe(W * H);
    expect(dem.drainageAreaKm2.length).toBe(W * H);
    expect(dem.rainfallWeightedAreaKm2.length).toBe(W * H);
    expect(dem.runoffDepthMmYr.length).toBe(W * H);
    expect(dem.dischargeM3s.length).toBe(W * H);
    expect(dem.precipitationMmYr.length).toBe(W * H);
    expect(dem.solarInsolation.length).toBe(W * H);

    // Physical elevation bounds
    const minElev = Math.min(...dem.elevation);
    const maxElev = Math.max(...dem.elevation);
    expect(minElev).toBeGreaterThanOrEqual(79.0);
    expect(maxElev).toBeLessThanOrEqual(3851.0);

    // Flow accumulation must be strictly positive
    for (let i = 0; i < W * H; i++) {
      expect(dem.flowAccumulation[i]).toBeGreaterThanOrEqual(1.0);
      expect(dem.drainageAreaKm2[i]).toBeGreaterThan(0.0);
      expect(dem.rainfallWeightedAreaKm2[i]).toBeGreaterThanOrEqual(0.0);
      expect(dem.dischargeM3s[i]).toBeGreaterThanOrEqual(0.0);
    }
  });

  it('uses base precipitation to control runoff discharge and river initiation', () => {
    const W = 96;
    const H = 72;
    const rawLuminance = new Float32Array(W * H);

    for (let y = 0; y < H; y++) {
      const downhill = 0.72 * (1 - y / (H - 1));
      for (let x = 0; x < W; x++) {
        const tributaryRelief =
          0.055 * Math.sin(x * 0.31 + y * 0.08) +
          0.025 * Math.sin(x * 0.73 - y * 0.15);
        rawLuminance[y * W + x] = Math.max(
          0.02,
          Math.min(1, 0.12 + downhill + tributaryRelief),
        );
      }
    }

    const sharedOptions = {
      domainWidthKm: 48,
      minElevationM: 100,
      maxElevationM: 3300,
      riverThresholdKm2: 1.5,
      windAzimuthDeg: 270,
      windSpeedMs: 18,
    };
    const dry = processMountainBaseDEM(rawLuminance, W, H, {
      ...sharedOptions,
      basePrecipitationMmYr: 500,
    });
    const wet = processMountainBaseDEM(rawLuminance, W, H, {
      ...sharedOptions,
      basePrecipitationMmYr: 2600,
    });

    const dryChannels = dry.isRiverChannel.reduce(
      (count, channel) => count + (channel > 0 ? 1 : 0),
      0,
    );
    const wetChannels = wet.isRiverChannel.reduce(
      (count, channel) => count + (channel > 0 ? 1 : 0),
      0,
    );
    const dryOutletDischarge = Math.max(...dry.dischargeM3s);
    const wetOutletDischarge = Math.max(...wet.dischargeM3s);

    expect(Array.from(wet.flowDirection)).toEqual(Array.from(dry.flowDirection));
    expect(wetOutletDischarge).toBeGreaterThan(dryOutletDischarge * 3);
    expect(wetChannels).toBeGreaterThan(dryChannels);
  });

  it('reversing wind across a ridge activates a different rain-fed tributary network', () => {
    const W = 104;
    const H = 80;
    const rawLuminance = new Float32Array(W * H);
    const ridgeX = (W - 1) / 2;

    for (let y = 0; y < H; y++) {
      const downhill = 0.5 * (1 - y / (H - 1));
      for (let x = 0; x < W; x++) {
        const ridge = 0.34 * Math.exp(-Math.pow((x - ridgeX) / 9, 2));
        const drainageTexture =
          0.05 * Math.sin(x * 0.29 + y * 0.13) +
          0.018 * Math.sin(x * 0.67 - y * 0.19);
        rawLuminance[y * W + x] = Math.max(
          0.02,
          Math.min(1, 0.13 + downhill + ridge + drainageTexture),
        );
      }
    }

    const options = {
      domainWidthKm: 52,
      minElevationM: 100,
      maxElevationM: 3900,
      basePrecipitationMmYr: 1300,
      riverThresholdKm2: 1.25,
      windSpeedMs: 24,
    };
    const westWind = processMountainBaseDEM(rawLuminance, W, H, {
      ...options,
      windAzimuthDeg: 270,
    });
    const eastWind = processMountainBaseDEM(rawLuminance, W, H, {
      ...options,
      windAzimuthDeg: 90,
    });

    let changedRainCells = 0;
    let changedWeightedCatchments = 0;
    let changedChannelCells = 0;
    for (let i = 0; i < W * H; i++) {
      if (Math.abs(westWind.precipitationMmYr[i] - eastWind.precipitationMmYr[i]) > 25)
        changedRainCells++;
      if (
        Math.abs(
          westWind.rainfallWeightedAreaKm2[i] -
          eastWind.rainfallWeightedAreaKm2[i],
        ) > 0.05
      ) changedWeightedCatchments++;
      if (westWind.isRiverChannel[i] !== eastWind.isRiverChannel[i])
        changedChannelCells++;
    }

    // Wind changes water supply and channel initiation, not gravity itself.
    expect(Array.from(westWind.flowDirection)).toEqual(
      Array.from(eastWind.flowDirection),
    );
    expect(changedRainCells).toBeGreaterThan(W * H * 0.2);
    expect(changedWeightedCatchments).toBeGreaterThan(W);
    expect(changedChannelCells).toBeGreaterThan(20);
  });

  it('does not turn a lowland depression into a river when no routed flow reaches the threshold', () => {
    const W = 48;
    const H = 48;
    const rawLuminance = new Float32Array(W * H);
    const centerX = (W - 1) / 2;
    const centerY = (H - 1) / 2;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x - centerX) / centerX;
        const dy = (y - centerY) / centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        rawLuminance[y * W + x] = Math.min(0.4, 0.05 + distance * 0.35);
      }
    }

    const dem = processMountainBaseDEM(rawLuminance, W, H, {
      riverThresholdKm2: 10_000,
    });
    const centerIndex = Math.floor(centerY) * W + Math.floor(centerX);

    expect(dem.normalizedElevation[centerIndex]).toBeLessThan(0.14);
    expect(dem.tpi[centerIndex]).toBeLessThan(-0.4);

    let channelCells = 0;
    for (const channel of dem.isRiverChannel) channelCells += channel;
    expect(channelCells).toBe(0);
  });

  it('uses the configurable elevation ceiling for valley wetlands', () => {
    const W = 96;
    const H = 96;
    const rawLuminance = new Float32Array(W * H);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x - W / 2) / (W / 2);
        const dy = (y - H / 2) / (H / 2);
        const basin = 0.08 + 0.16 * (dx * dx + dy * dy);
        rawLuminance[y * W + x] = Math.min(1.0, basin + 0.01 * Math.sin(x * 0.25) * Math.sin(y * 0.2));
      }
    }

    const lowCeiling = processMountainBaseDEM(rawLuminance, W, H, {
      minElevationM: 0,
      maxElevationM: 2000,
      domainWidthKm: 120,
      riverThresholdKm2: 100,
      wetlandElevationThresholdM: 250,
    });

    const highCeiling = processMountainBaseDEM(rawLuminance, W, H, {
      minElevationM: 0,
      maxElevationM: 2000,
      domainWidthKm: 120,
      riverThresholdKm2: 100,
      wetlandElevationThresholdM: 700,
    });

    const lowCount = lowCeiling.biomeType.reduce((count, biome) => count + (biome === 7 ? 1 : 0), 0);
    const highCount = highCeiling.biomeType.reduce((count, biome) => count + (biome === 7 ? 1 : 0), 0);
    expect(lowCount).toBeGreaterThan(0);
    expect(highCount).toBeGreaterThan(lowCount);
  });

  it('caches cumulative water evolution steps that match a direct step build', () => {
    const W = 48;
    const H = 72;
    const rawLuminance = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const ny = y / (H - 1);
      for (let x = 0; x < W; x++) {
        const nx = x / (W - 1) - 0.5;
        rawLuminance[y * W + x] = Math.max(0.03, 0.98 - ny * 0.82 - 0.24 * Math.exp(-nx * nx * 75.0));
      }
    }
    const options = {
      riverThresholdKm2: 0.08,
      erosionStrength: 0.8,
      waterStageGrowthPerStep: 0.125,
    };
    const states: MountainEvolutionState[] = [];
    processMountainBaseDEM(rawLuminance, W, H, { ...options, erosionIterations: 3 }, undefined, undefined,
      (_step, _dem, state) => states.push(state));
    expect(states).toHaveLength(4);

    const direct = processMountainBaseDEM(rawLuminance, W, H, { ...options, erosionIterations: 2 });
    const cached = rebuildMountainEvolutionStep(states[2], W, H, options, 2);
    expect(Array.from(cached.elevation)).toEqual(Array.from(direct.elevation));
    expect(Array.from(cached.waterDepthM)).toEqual(Array.from(direct.waterDepthM));
    expect(Array.from(cached.erosionDepthM)).toEqual(Array.from(direct.erosionDepthM));
  });

  it('applies bounded fluvial incision and rebuilds the routed DEM', () => {
    const W = 68;
    const H = 102;
    const rawLuminance = new Float32Array(W * H);

    for (let y = 0; y < H; y++) {
      const ny = y / (H - 1);
      for (let x = 0; x < W; x++) {
        const nx = x / (W - 1) - 0.5;
        const valley = 0.24 * Math.exp(-nx * nx * 75.0);
        const sideRidges = 0.14 * Math.abs(Math.sin(nx * 16.0 + ny * 4.0));
        rawLuminance[y * W + x] = Math.max(0.03, Math.min(1.0, 0.98 - ny * 0.82 + sideRidges - valley));
      }
    }

    const untouched = processMountainBaseDEM(rawLuminance, W, H, { riverThresholdKm2: 0.08 });
    const eroded = processMountainBaseDEM(rawLuminance, W, H, {
      riverThresholdKm2: 0.08,
      erosionStrength: 0.8,
      erosionIterations: 2,
    });

    let totalErosionM = 0;
    let changedCells = 0;
    let changedFlowDirections = 0;
    let changedWaterwayCells = 0;
    let changedWaterDepthCells = 0;
    let changedRoutedCenterlines = 0;
    const erosionByBand = new Uint32Array(4);
    let lateralBedCells = 0;
    const cellAreaKm2 = (eroded.dxMeters * eroded.dyMeters) / 1_000_000;
    const minimumCatchmentKm2 = Math.max(cellAreaKm2 * 2, 0.08 * 0.12);
    for (let i = 0; i < eroded.elevation.length; i++) {
      totalErosionM += eroded.erosionDepthM[i];
      if (eroded.erosionDepthM[i] > 0) {
        changedCells++;
        erosionByBand[Math.min(3, Math.floor((Math.floor(i / W) * 4) / H))]++;
        if (eroded.isRiverChannel[i] > 0 && eroded.drainageAreaKm2[i] < minimumCatchmentKm2) {
          lateralBedCells++;
        }
        expect(eroded.elevation[i]).toBeLessThanOrEqual(untouched.elevation[i] + 0.001);
      }
      expect(Number.isFinite(eroded.elevation[i])).toBe(true);
      expect(Number.isFinite(eroded.drainageAreaKm2[i])).toBe(true);
      if (eroded.flowDirection[i] !== untouched.flowDirection[i]) changedFlowDirections++;
      if (eroded.isRiverChannel[i] !== untouched.isRiverChannel[i]) changedWaterwayCells++;
      if (Math.abs(eroded.waterDepthM[i] - untouched.waterDepthM[i]) > 0.001) changedWaterDepthCells++;
      const wasCenterline = untouched.flowDirection[i] >= 0 && untouched.drainageAreaKm2[i] >= 0.08;
      const isCenterline = eroded.flowDirection[i] >= 0 && eroded.drainageAreaKm2[i] >= 0.08;
      if (wasCenterline !== isCenterline) changedRoutedCenterlines++;
    }

    expect(changedCells).toBeGreaterThan(0);
    expect(totalErosionM).toBeGreaterThan(0);
    expect(Array.from(erosionByBand).every((count) => count > 0)).toBe(true);
    expect(lateralBedCells).toBeGreaterThan(0);
    expect(changedFlowDirections).toBeGreaterThan(0);
    expect(changedWaterwayCells + changedRoutedCenterlines).toBeGreaterThan(0);
    expect(changedWaterDepthCells).toBeGreaterThan(0);

    const shortTime = processMountainBaseDEM(rawLuminance, W, H, {
      riverThresholdKm2: 0.08,
      erosionStrength: 0.8,
      erosionIterations: 1,
      erosionTimeScale: 0.5,
    });
    const longTime = processMountainBaseDEM(rawLuminance, W, H, {
      riverThresholdKm2: 0.08,
      erosionStrength: 0.8,
      erosionIterations: 1,
      erosionTimeScale: 2.0,
    });
    const shortTotal = shortTime.erosionDepthM.reduce((total, depth) => total + depth, 0);
    const longTotal = longTime.erosionDepthM.reduce((total, depth) => total + depth, 0);
    expect(longTotal).toBeGreaterThan(shortTotal);

    const reliefOptions: Parameters<typeof renderMountainDetailDEM>[1] = {
      layer: 'swiss_relief',
      palette: 'swiss_topo',
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 3.5,
      ambientOcclusionStrength: 0.4,
      showRivers: false,
      riverThresholdKm2: 0.08,
      showContours: false,
      contourIntervalM: 100,
    };
    const plainRelief = renderMountainDetailDEM(eroded, reliefOptions);
    const annotatedRelief = renderMountainDetailDEM(eroded, {
      ...reliefOptions,
      erosionOverlayOpacity: 1,
    });
    expect(Array.from(annotatedRelief.data)).not.toEqual(Array.from(plainRelief.data));

    const erodedHeightmap = renderMountainDetailDEM(eroded, {
      ...reliefOptions,
      layer: 'eroded_heightmap',
      erosionOverlayOpacity: 0,
    });
    const plainHeightmap = renderMountainDetailDEM(eroded, {
      ...reliefOptions,
      layer: 'raw_heightmap',
      erosionOverlayOpacity: 0,
    });
    expect(Array.from(erodedHeightmap.data)).not.toEqual(Array.from(plainHeightmap.data));

  });

  it('fills the routed water stage across a channel bed as stage rises', () => {
    const W = 68;
    const H = 102;
    const rawLuminance = new Float32Array(W * H);

    for (let y = 0; y < H; y++) {
      const ny = y / (H - 1);
      for (let x = 0; x < W; x++) {
        const nx = x / (W - 1) - 0.5;
        const valley = 0.28 * Math.exp(-nx * nx * 70.0);
        rawLuminance[y * W + x] = Math.max(0.03, Math.min(1.0, 0.98 - ny * 0.82 - valley));
      }
    }

    const lowStage = processMountainBaseDEM(rawLuminance, W, H, {
      riverThresholdKm2: 4,
      waterStageScale: 0.35,
    });
    const highStage = processMountainBaseDEM(rawLuminance, W, H, {
      riverThresholdKm2: 4,
      waterStageScale: 3,
    });
    const fastFlow = processMountainBaseDEM(rawLuminance, W, H, {
      riverThresholdKm2: 4,
      waterStageScale: 3,
      flowRateScale: 1.0,
    });
    const slowFlow = processMountainBaseDEM(rawLuminance, W, H, {
      riverThresholdKm2: 4,
      waterStageScale: 3,
      flowRateScale: 0.25,
    });

    const lowWaterCells = lowStage.waterDepthM.reduce((count, depth) => count + (depth > 0 ? 1 : 0), 0);
    const highWaterCells = highStage.waterDepthM.reduce((count, depth) => count + (depth > 0 ? 1 : 0), 0);
    const lowWaterVolume = lowStage.waterDepthM.reduce((total, depth) => total + depth, 0);
    const highWaterVolume = highStage.waterDepthM.reduce((total, depth) => total + depth, 0);
    const fastWaterVolume = fastFlow.waterDepthM.reduce((total, depth) => total + depth, 0);
    const slowWaterVolume = slowFlow.waterDepthM.reduce((total, depth) => total + depth, 0);
    expect(highWaterCells).toBeGreaterThan(lowWaterCells);
    expect(highWaterVolume).toBeGreaterThan(lowWaterVolume);
    expect(slowWaterVolume).toBeGreaterThan(fastWaterVolume);

    let widestChannel = -1;
    for (let i = 0; i < highStage.drainageAreaKm2.length; i++) {
      if (highStage.isRiverChannel[i] > 0 && highStage.drainageAreaKm2[i] > (widestChannel >= 0 ? highStage.drainageAreaKm2[widestChannel] : 0)) {
        widestChannel = i;
      }
    }
    expect(widestChannel).toBeGreaterThanOrEqual(0);

    let wetNeighbors = 0;
    const cx = widestChannel % W;
    const cy = Math.floor(widestChannel / W);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H && highStage.waterDepthM[ny * W + nx] > 0) wetNeighbors++;
      }
    }
    expect(wetNeighbors).toBeGreaterThan(0);
  });

  it('routes flow through a valid receiver graph and exposes confluence-based stream order', () => {
    const W = 68;
    const H = 102;
    const rawLuminance = new Float32Array(W * H);

    for (let y = 0; y < H; y++) {
      const ny = y / (H - 1);
      for (let x = 0; x < W; x++) {
        const nx = x / (W - 1) - 0.5;
        const valley = 0.22 * Math.exp(-nx * nx * 70.0);
        const sideRidges = 0.18 * Math.abs(Math.sin(nx * 18.0 + ny * 5.0));
        rawLuminance[y * W + x] = Math.max(0.03, Math.min(1.0, 0.98 - ny * 0.82 + sideRidges - valley));
      }
    }

    const dem = processMountainBaseDEM(rawLuminance, W, H, { riverThresholdKm2: 0.08 });
    const channelThresholdKm2 = 0.08;
    const cellAreaKm2 = (dem.dxMeters * dem.dyMeters) / 1_000_000;
    let maxOrder = 0;
    let routedCenterlines = 0;
    for (let i = 0; i < dem.flowDirection.length; i++) {
      const dir = dem.flowDirection[i];
      expect(dir).toBeGreaterThanOrEqual(-1);
      expect(dir).toBeLessThan(8);
      if (dem.strahlerOrder[i] > maxOrder) maxOrder = dem.strahlerOrder[i];

      if (dir >= 0) {
        const x = i % W;
        const y = Math.floor(i / W);
        const offsets = [
          [0, -1], [1, -1], [1, 0], [1, 1],
          [0, 1], [-1, 1], [-1, 0], [-1, -1],
        ];
        const nx = x + offsets[dir][0];
        const ny = y + offsets[dir][1];
        expect(nx).toBeGreaterThanOrEqual(0);
        expect(nx).toBeLessThan(W);
        expect(ny).toBeGreaterThanOrEqual(0);
        expect(ny).toBeLessThan(H);

        if (dem.drainageAreaKm2[i] >= channelThresholdKm2) {
          routedCenterlines++;
          const receiver = ny * W + nx;
          expect(dem.drainageAreaKm2[receiver]).toBeGreaterThanOrEqual(
            dem.drainageAreaKm2[i] + cellAreaKm2 * 0.9,
          );
          expect(dem.drainageAreaKm2[receiver]).toBeGreaterThanOrEqual(channelThresholdKm2);
        }
      }
    }
    expect(routedCenterlines).toBeGreaterThan(0);
    expect(maxOrder).toBeGreaterThanOrEqual(2);
  });

  it('samples 2D continuous cross-section elevation profiles', () => {
    const W = 50;
    const H = 50;
    const rawLuminance = new Float32Array(W * H).fill(0.5);
    rawLuminance[0] = 1.0;
    rawLuminance[W * H - 1] = 0.1;

    const dem = processMountainBaseDEM(rawLuminance, W, H, {
      minElevationM: 100,
      maxElevationM: 4000,
    });

    const profile = sampleMountainElevationProfile(
      dem,
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 },
      50
    );

    expect(profile.distanceKm.length).toBe(51);
    expect(profile.elevationM.length).toBe(51);
    expect(profile.slopeDeg.length).toBe(51);
    expect(profile.biomeNames.length).toBe(51);
    expect(profile.distanceKm[0]).toBe(0);
    expect(profile.distanceKm[50]).toBeGreaterThan(0);
  });

  it('renders the cartographic layers without NaN or out-of-bound pixel values', () => {
    const W = 32;
    const H = 48;
    const rawLuminance = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) rawLuminance[i] = (i % W) / W;

    const dem = processMountainBaseDEM(rawLuminance, W, H);

    const layers: Parameters<typeof renderMountainDetailDEM>[1]['layer'][] = [
      'swiss_relief',
      'raw_heightmap',
      'eroded_heightmap',
      'slope',
      'aspect',
      'drainage_network',
      'erosion_depth',
      'precipitation',
      'solar_insolation',
      'biomes',
      'vegetation_patterns',
      'landforms_tpi',
    ];

    for (const layer of layers) {
      const img = renderMountainDetailDEM(dem, {
        layer,
        palette: 'swiss_topo',
        sunAzimuthDeg: 315,
        sunAltitudeDeg: 45,
        verticalExaggeration: 3.5,
        ambientOcclusionStrength: 0.4,
        showRivers: true,
        riverThresholdKm2: 0.5,
        showContours: true,
        contourIntervalM: 100,
      });

      expect(img.width).toBe(W);
      expect(img.height).toBe(H);
      expect(img.data.length).toBe(W * H * 4);

      for (let i = 0; i < img.data.length; i += 4) {
        expect(Number.isFinite(img.data[i])).toBe(true);
        expect(Number.isFinite(img.data[i + 1])).toBe(true);
        expect(Number.isFinite(img.data[i + 2])).toBe(true);
        expect(img.data[i + 3]).toBe(255); // Alpha
      }
    }
  });

  it('keeps the drainage diagnostic layer independent from the rain color overlay', () => {
    const W = 16;
    const H = 20;
    const rawLuminance = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        rawLuminance[y * W + x] = Math.max(0.02, 1.0 - y / H + x / (W * 4));
      }
    }

    const dem = processMountainBaseDEM(rawLuminance, W, H, { riverThresholdKm2: 0.08 });
    const baseOptions: Parameters<typeof renderMountainDetailDEM>[1] = {
      layer: 'drainage_network',
      palette: 'swiss_topo',
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 3.5,
      ambientOcclusionStrength: 0.4,
      showRivers: true,
      riverThresholdKm2: 0.08,
      showContours: false,
      contourIntervalM: 100,
    };
    const withoutRain = renderMountainDetailDEM(dem, baseOptions);
    const withRain = renderMountainDetailDEM(dem, { ...baseOptions, rainOverlayOpacity: 1.0 });

    expect(Array.from(withRain.data)).toEqual(Array.from(withoutRain.data));
  });

  it('shows shared water coverage over neutral terrain and optionally over the heightmap', () => {
    const width = 16;
    const height = 16;
    const oceanMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) oceanMask.fill(1, y * width, y * width + 4);
    const dem = processMountainBaseDEM(new Float32Array(width * height).fill(0.5), width, height, {
      oceanMask,
      minElevationM: 0,
      maxElevationM: 1000,
      riverThresholdKm2: 1000,
    });
    const options = {
      palette: 'swiss_topo' as const,
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 1,
      ambientOcclusionStrength: 0,
      hillshadeStrength: 0,
      showRivers: false,
      riverThresholdKm2: 1000,
      showWaterDetails: false,
      showOceanDetails: false,
      wetlandPuddleContours: false,
      showContours: false,
      contourIntervalM: 100,
    };
    const water = renderMountainDetailDEM(dem, { ...options, layer: 'drainage_network' });
    const heightmap = renderMountainDetailDEM(dem, { ...options, layer: 'raw_heightmap' });
    const heightmapWithWater = renderMountainDetailDEM(dem, {
      ...options, layer: 'raw_heightmap', showHeightmapWater: true,
    });
    const oceanPixel = (8 * width + 1) * 4;
    const landPixel = (8 * width + 12) * 4;
    expect(water.data.slice(oceanPixel, oceanPixel + 4)).toEqual(heightmapWithWater.data.slice(oceanPixel, oceanPixel + 4));
    expect(heightmapWithWater.data.slice(oceanPixel, oceanPixel + 4)).not.toEqual(heightmap.data.slice(oceanPixel, oceanPixel + 4));
    expect(heightmapWithWater.data.slice(landPixel, landPixel + 4)).toEqual(heightmap.data.slice(landPixel, landPixel + 4));
    expect(water.data[landPixel]).toBe(water.data[landPixel + 1]);
    expect(water.data[landPixel]).toBe(water.data[landPixel + 2]);
  });

  it('smooths contour placement without changing the underlying elevation layer', () => {
    const W = 48;
    const H = 48;
    const rawLuminance = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const slope = 0.18 + 0.68 * (x / (W - 1));
        const noise = (x + y) % 2 === 0 ? 0.02 : -0.02;
        rawLuminance[y * W + x] = Math.max(0.02, Math.min(0.98, slope + noise));
      }
    }

    // Rivers would cover these ~1 km² cells; contours are what is tested.
    const dem = processMountainBaseDEM(rawLuminance, W, H, { riverThresholdKm2: 10_000 });
    const baseOptions: Parameters<typeof renderMountainDetailDEM>[1] = {
      layer: 'raw_heightmap',
      palette: 'swiss_topo',
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 3.5,
      ambientOcclusionStrength: 0.4,
      showRivers: false,
      riverThresholdKm2: 0.5,
      showContours: true,
      contourIntervalM: 100,
      contourThicknessM: 2,
      contourIndexThicknessM: 3,
      contourOpacity: 1,
      contourColor: '#ff0000',
      contourIndexColor: '#00ff00',
    };

    const unsmoothed = renderMountainDetailDEM(dem, { ...baseOptions, contourSmoothingPasses: 0 });
    const smoothed = renderMountainDetailDEM(dem, { ...baseOptions, contourSmoothingPasses: 4 });
    let changedPixels = 0;
    for (let i = 0; i < unsmoothed.data.length; i += 4) {
      if (
        unsmoothed.data[i] !== smoothed.data[i] ||
        unsmoothed.data[i + 1] !== smoothed.data[i + 1] ||
        unsmoothed.data[i + 2] !== smoothed.data[i + 2]
      ) {
        changedPixels++;
      }
    }

    expect(changedPixels).toBeGreaterThan(0);
  });

  it('restricts beaches strictly to open ocean coasts and excludes flooded river regions', () => {
    const width = 60;
    const height = 60;
    const raw = new Float32Array(width * height);
    const oceanMask = new Uint8Array(width * height);

    // Bottom 10 rows are open ocean touching the map border
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (y >= 50) {
          oceanMask[idx] = 1;
          raw[idx] = 0.0;
        } else {
          // Central river valley
          const distToCenter = Math.abs(x - 30);
          raw[idx] = Math.min(1.0, 0.15 + (50 - y) * 0.015 + distToCenter * 0.02);
        }
      }
    }

    const dem = processMountainBaseDEM(raw, width, height, {
      domainWidthKm: 10,
      domainHeightKm: 10,
      minElevationM: 0,
      maxElevationM: 2000,
      oceanElevationM: 0,
      oceanMask,
      riverThresholdKm2: 0.2,
      waterStageScale: 2.0, // wide flooded river
    });

    // Verify open ocean shoreline (around y=45..49) has sandy beach (11) or coastal cliff
    let hasOpenCoastBeach = false;
    for (let y = 45; y < 50; y++) {
      for (let x = 0; x < 20; x++) { // far from central river
        const idx = y * width + x;
        if (dem.biomeType[idx] === 11 || dem.biomeType[idx] === 13 || dem.biomeType[idx] === 14) {
          hasOpenCoastBeach = true;
        }
      }
    }
    expect(hasOpenCoastBeach).toBe(true);

    // Verify inland flooded river corridor (y=10..40, near x=30) never has beach biomes
    for (let y = 10; y < 40; y++) {
      for (let x = 25; x <= 35; x++) {
        const idx = y * width + x;
        if (dem.isRiverChannel[idx] === 1 || dem.rainfallWeightedAreaKm2[idx] >= 0.2) {
          // Channel or immediate bank
          expect(dem.biomeType[idx]).not.toBe(11); // No Sandy Beach
          expect(dem.biomeType[idx]).not.toBe(12); // No Silty Beach
          expect(dem.biomeType[idx]).not.toBe(13); // No Rocky Shore
          expect(dem.biomeType[idx]).not.toBe(14); // No Coastal Cliff
        }
      }
    }
  });

  it('continues river erosion through ocean-covered downstream cells', () => {
    const width = 64;
    const height = 64;
    const centerX = (width - 1) / 2;
    const raw = new Float32Array(width * height);
    const oceanMask = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
      const downstreamElevation = 0.88 - (y / (height - 1)) * 0.66;
      for (let x = 0; x < width; x++) {
        const channelDistance = (x - centerX) / 4.0;
        const valley = 0.20 * Math.exp(-channelDistance * channelDistance);
        raw[y * width + x] = Math.max(
          0.04,
          Math.min(1.0, downstreamElevation - valley),
        );
        if (y >= 54) oceanMask[y * width + x] = 1;
      }
    }

    const baseline = processMountainBaseDEM(raw, width, height, {
      domainWidthKm: 64,
      domainHeightKm: 64,
      minElevationM: 0,
      maxElevationM: 2400,
      oceanElevationM: 0,
      oceanMask,
      basePrecipitationMmYr: 2200,
      riverThresholdKm2: 0.25,
    });
    const dem = processMountainBaseDEM(raw, width, height, {
      domainWidthKm: 64,
      domainHeightKm: 64,
      minElevationM: 0,
      maxElevationM: 2400,
      oceanElevationM: 0,
      oceanMask,
      basePrecipitationMmYr: 2200,
      riverThresholdKm2: 0.25,
      erosionStrength: 0.8,
      erosionIterations: 2,
    });

    let oceanCells = 0;
    let erodedOceanCells = 0;
    let widestErodedOceanRow = 0;
    let landErosionM = 0;
    let oceanErosionM = 0;
    let changedOceanHeightCells = 0;
    let submergedRiverMouthCells = 0;
    for (let index = 0; index < dem.elevation.length; index++) {
      if (dem.isOcean[index] === 1) {
        oceanCells++;
        oceanErosionM += dem.erosionDepthM[index];
        if (dem.erosionDepthM[index] > 0) erodedOceanCells++;
        if (dem.riverMouthMask?.[index] === 1) submergedRiverMouthCells++;
        if (dem.elevation[index] < baseline.elevation[index] - 0.0001)
          changedOceanHeightCells++;
      } else {
        landErosionM += dem.erosionDepthM[index];
      }
    }
    for (let y = 0; y < height; y++) {
      let rowWidth = 0;
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (dem.isOcean[index] === 1 && dem.erosionDepthM[index] > 0)
          rowWidth++;
      }
      widestErodedOceanRow = Math.max(widestErodedOceanRow, rowWidth);
    }
    const heightmapOptions: Parameters<typeof renderMountainDetailDEM>[1] = {
      layer: 'raw_heightmap',
      palette: 'swiss_topo',
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 3.5,
      ambientOcclusionStrength: 0.45,
      showRivers: false,
      riverThresholdKm2: 0.25,
      showContours: false,
      contourIntervalM: 100,
    };
    const baselineHeightmap = renderMountainDetailDEM(
      baseline,
      heightmapOptions,
    );
    const evolvedHeightmap = renderMountainDetailDEM(dem, heightmapOptions);
    let changedOceanHeightmapPixels = 0;
    for (let index = 0; index < dem.elevation.length; index++) {
      if (
        dem.isOcean[index] === 1 &&
        baselineHeightmap.data[index * 4] !== evolvedHeightmap.data[index * 4]
      ) {
        changedOceanHeightmapPixels++;
      }
    }

    expect(oceanCells).toBeGreaterThan(0);
    expect(erodedOceanCells).toBeGreaterThan(0);
    expect(widestErodedOceanRow).toBeGreaterThan(1);
    expect(oceanErosionM).toBeGreaterThan(0);
    expect(landErosionM).toBeGreaterThan(0);
    expect(changedOceanHeightCells).toBeGreaterThan(0);
    expect(changedOceanHeightmapPixels).toBeGreaterThan(0);
    expect(submergedRiverMouthCells).toBeGreaterThan(0);
    expect(erodedOceanCells).toBeLessThan(oceanCells);
  });

  it('retains a routed mouth when a higher ocean datum floods the lower river', () => {
    const width = 64;
    const height = 64;
    const centerX = (width - 1) / 2;
    const raw = new Float32Array(width * height);

    for (let y = 0; y < height; y++) {
      const downstreamElevation = 0.88 - (y / (height - 1)) * 0.66;
      for (let x = 0; x < width; x++) {
        const channelDistance = (x - centerX) / 4.0;
        const valley = 0.20 * Math.exp(-channelDistance * channelDistance);
        raw[y * width + x] = Math.max(
          0.04,
          Math.min(1.0, downstreamElevation - valley),
        );
      }
    }

    const dem = processMountainBaseDEM(raw, width, height, {
      domainWidthKm: 64,
      domainHeightKm: 64,
      minElevationM: 0,
      maxElevationM: 1000,
      oceanElevationM: 80,
      basePrecipitationMmYr: 2200,
      riverThresholdKm2: 0.25,
    });

    let submergedMouthCells = 0;
    for (let index = 0; index < dem.elevation.length; index++) {
      if (dem.riverMouthMask?.[index] === 1) {
        submergedMouthCells++;
        expect(dem.isOcean[index]).toBe(1);
        expect(dem.isRiverChannel[index]).toBe(1);
        expect(dem.riverMouthAreaKm2?.[index] ?? 0).toBeGreaterThanOrEqual(0.25);
      }
    }
    expect(submergedMouthCells).toBeGreaterThan(0);
  });

  it('applies marine erosion to exposed shoreline without eroding open ocean', () => {
    const width = 48;
    const height = 40;
    const raw = new Float32Array(width * height).fill(0.55);
    const oceanMask = new Uint8Array(width * height);
    for (let y = 32; y < height; y++) {
      for (let x = 0; x < width; x++) oceanMask[y * width + x] = 1;
    }

    const dem = processMountainBaseDEM(raw, width, height, {
      domainWidthKm: 48,
      domainHeightKm: 40,
      minElevationM: 0,
      maxElevationM: 1000,
      oceanElevationM: 0,
      oceanMask,
      // Disable routed river erosion so this test isolates the marine source.
      riverThresholdKm2: 1_000_000,
      marineErosionStrength: 1,
      erosionStrength: 0.8,
      erosionIterations: 1,
    });

    let erodedShorelineCells = 0;
    let erodedOceanCells = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (dem.isOcean[index] === 1) {
          if (dem.erosionDepthM[index] > 0) erodedOceanCells++;
          continue;
        }
        let touchesOcean = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (
              nx >= 0 &&
              nx < width &&
              ny >= 0 &&
              ny < height &&
              dem.isOcean[ny * width + nx] === 1
            ) {
              touchesOcean = true;
            }
          }
        }
        if (touchesOcean && dem.erosionDepthM[index] > 0)
          erodedShorelineCells++;
      }
    }

    expect(erodedShorelineCells).toBeGreaterThan(0);
    expect(erodedOceanCells).toBe(0);
  });

  it('keeps erosion continuous across flat routed river reaches', () => {
    const width = 56;
    const height = 56;
    const raw = new Float32Array(width * height).fill(0.5);
    const dem = processMountainBaseDEM(raw, width, height, {
      domainWidthKm: 56,
      domainHeightKm: 56,
      minElevationM: 0,
      maxElevationM: 1000,
      riverThresholdKm2: 0.25,
      erosionStrength: 0.8,
      erosionIterations: 1,
    });

    let routedRiverCells = 0;
    let erodedRiverCells = 0;
    for (let index = 0; index < dem.elevation.length; index++) {
      if (
        dem.isOcean[index] === 0 &&
        dem.isRiverChannel[index] === 1 &&
        dem.rainfallWeightedAreaKm2[index] >= 0.25
      ) {
        routedRiverCells++;
        if (dem.erosionDepthM[index] > 0) erodedRiverCells++;
      }
    }

    expect(routedRiverCells).toBeGreaterThan(0);
    expect(erodedRiverCells / routedRiverCells).toBeGreaterThan(0.75);
  });
  it('fills a river-fed heightmap basin as a lake at its spill level', () => {
    const width = 64;
    const height = 64;
    const luminance = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bowl = Math.max(0, 1 - Math.hypot(x - 32, y - 28) / 9);
        luminance[y * width + x] = 0.3 + 0.5 * (1 - y / height) - 0.12 * bowl;
      }
    }
    const dem = processMountainBaseDEM(luminance, width, height, {
      riverThresholdKm2: 0.01,
    });

    const lake = dem.lakeDepthM!;
    expect(lake[28 * width + 32]).toBeGreaterThan(2);
    expect(lake[28 * width + 30]).toBeGreaterThan(0);
    expect(lake[28 * width + 30]).toBeLessThan(lake[28 * width + 32]);
    expect(lake[4 * width + 32]).toBe(0);
    expect(lake[28 * width + 4]).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import type { MountainDEMData } from '../src/terrain/mountainBaseDEM';
import {
  renderWaterOverlay,
  buildWaterOverlayGeometry,
  renderWaterOverlayFromGeometry,
  paintedWaterAlphaFromGeometry,
  buildVisualWaterSurfaceDEM,
  buildWetlandPuddleContours,
  buildDistanceToCoast,
  buildSmoothShoreDistance,
  getContourTangentAt,
  paintOceanWavePath,
  type OceanWavePathPoint,
  suppressMicroKinks,
  simplifyRiverRDP,
  mergeCloseRiverPoints,
  simplifyAndSmoothRiverPoints,
  type RiverPoint,
  type RiverSpline,
} from '../src/rendering/waterRenderer';

function makeMeanderingRiver(width: number, height: number): MountainDEMData {
  const totalCells = width * height;
  const isRiverChannel = new Uint8Array(totalCells);
  const waterDepthM = new Float32Array(totalCells);
  const strahlerOrder = new Uint8Array(totalCells);
  const riverCenterlineMask = new Uint8Array(totalCells);
  const flowDirection = new Int8Array(totalCells).fill(-1);
  const drainageAreaKm2 = new Float32Array(totalCells);
  const biomeType = new Uint8Array(totalCells);

  for (let x = 0; x < width; x++) {
    const centerY = Math.round(height * 0.5 + Math.sin(x * 0.16) * height * 0.12);
    const radius = 2 + (x % 13 < 6 ? 1 : 0);
    for (let y = Math.max(0, centerY - radius); y <= Math.min(height - 1, centerY + radius); y++) {
      const index = y * width + x;
      isRiverChannel[index] = 1;
      waterDepthM[index] = Math.max(0.08, 2.5 - Math.abs(y - centerY) * 0.55);
      strahlerOrder[index] = x > width * 0.55 ? 4 : 2;
      drainageAreaKm2[index] = x > width * 0.55 ? 12 : 3;
      biomeType[index] = 6; // Braided River Gravel Bar & Channel
    }

    const centerIndex = centerY * width + x;
    riverCenterlineMask[centerIndex] = 1;
    flowDirection[centerIndex] = 2; // downstream / east
  }

  return {
    width,
    height,
    isRiverChannel,
    waterDepthM,
    strahlerOrder,
    riverCenterlineMask,
    flowDirection,
    drainageAreaKm2,
    biomeType,
  } as MountainDEMData;
}

describe('water renderer', () => {
  it('turns a 4px block staircase into a straight shoreline distance', () => {
    const size = 128;
    const coverage = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (Math.floor(x / 4) + Math.floor(y / 4) < 32) coverage[y * size + x] = 255;
      }
    }
    const signed = buildSmoothShoreDistance(coverage, size, size, 4, 6)!;
    // For a straight diagonal shoreline, distance * sqrt(2) = (x + y) - c.
    const offsets: number[] = [];
    for (let y = 24; y < 104; y++) {
      for (let x = 24; x < 104; x++) {
        const distance = signed[y * size + x];
        if (Math.abs(distance) < 3) offsets.push(distance * Math.SQRT2 - (x + y));
      }
    }
    const mean = offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
    const spread = Math.sqrt(
      offsets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / offsets.length,
    );
    expect(offsets.length).toBeGreaterThan(200);
    expect(spread).toBeLessThan(0.5);
  });

  it('creates deterministic water, varied bank ink, and broken flow marks', () => {
    const dem = makeMeanderingRiver(96, 44);
    const first = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 42,
      flowThickness: 0.2,
    });
    const second = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 42,
      flowThickness: 0.2,
    });

    expect(Array.from(first.waterAlpha)).toEqual(Array.from(second.waterAlpha));
    expect(Array.from(first.bankAlpha)).toEqual(Array.from(second.bankAlpha));
    expect(Array.from(first.flowAlpha)).toEqual(Array.from(second.flowAlpha));

    expect(first.waterAlpha.some((value) => value > 0)).toBe(true);
    expect(first.bankAlpha.some((value) => value > 0)).toBe(true);
    // Narrow rivers keep only fill and outline; no centreline charcoal dashes.
    expect(first.flowAlpha.some((value) => value > 0)).toBe(false);
    expect(first.riverContourAlpha?.some((value) => value > 0)).toBe(true);

    const bankValues = new Set(first.bankAlpha.filter((value) => value > 0));
    expect(bankValues.size).toBeGreaterThan(3);
  });

  it('keeps flow marks inside the routed water corridor', () => {
    const dem = makeMeanderingRiver(72, 36);
    const overlay = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 7,
      flowThickness: 0.2,
    });

    for (let index = 0; index < overlay.flowAlpha.length; index++) {
      if (overlay.flowAlpha[index] > 0) expect(dem.isRiverChannel[index]).toBe(1);
    }
  });

  it('derives the painted water alpha from geometry without painting', () => {
    const width = 96;
    const height = 48;
    const dem = makeMeanderingRiver(width, height);
    dem.isOcean = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 70 + Math.round(Math.sin(y * 0.3) * 4); x < width; x++) {
        dem.isOcean[y * width + x] = 1;
        dem.biomeType[y * width + x] = 8;
      }
    }
    const oceanMaskCoverage = new Float32Array(width * height);
    for (let index = 0; index < oceanMaskCoverage.length; index++) {
      oceanMaskCoverage[index] = dem.isOcean[index] * 0.93;
    }
    const baseOptions = {
      riverThresholdKm2: 2,
      seed: 11,
      showOceanDetails: true,
      deepOceanSwells: true,
    };
    for (const options of [baseOptions, { ...baseOptions, oceanMaskCoverageOverride: oceanMaskCoverage }]) {
      const geometry = buildWaterOverlayGeometry(dem, options);
      const painted = renderWaterOverlayFromGeometry(dem, options, geometry);
      expect(Array.from(paintedWaterAlphaFromGeometry(options, geometry)))
        .toEqual(Array.from(painted.waterAlpha));
    }
  });

  it('paints identical offshore waves inside a paint window', () => {
    const size = 160;
    const isOcean = new Uint8Array(size * size);
    const biomeType = new Uint8Array(size * size).fill(4);
    for (let y = 0; y < size; y++) {
      for (let x = 20 + Math.round(Math.sin(y / 11) * 6); x < size; x++) {
        isOcean[y * size + x] = 1;
        biomeType[y * size + x] = 8;
      }
    }
    const dem = {
      width: size, height: size, isOcean, biomeType,
      isRiverChannel: new Uint8Array(size * size), flowDirection: new Int8Array(size * size).fill(-1),
      drainageAreaKm2: new Float32Array(size * size), waterDepthM: new Float32Array(size * size),
      strahlerOrder: new Uint8Array(size * size),
    } as unknown as MountainDEMData;
    const options = {
      riverThresholdKm2: 2, seed: 42, deepOceanSwells: true, deepOceanSwellDensity: 0.5,
      oceanPixelScale: 2,
    };
    const window = { x0: 60, y0: 50, x1: 120, y1: 110 };
    const full = renderWaterOverlay(dem, options);
    const clipped = renderWaterOverlay(dem, { ...options, paintWindow: window });
    const fields = ['oceanWaveLightAlpha', 'oceanWaveShadowAlpha', 'oceanWaveInkAlpha', 'crestAlpha', 'oceanFlowAlpha'] as const;
    let painted = 0;
    for (const field of fields) {
      for (let y = window.y0; y < window.y1; y++) {
        for (let x = window.x0; x < window.x1; x++) {
          const index = y * size + x;
          expect(clipped[field]![index]).toBe(full[field]![index]);
          if (full[field]![index] > 0) painted++;
        }
      }
    }
    expect(painted).toBeGreaterThan(500);
  }, 30_000);

  it('unifies river mouths seamlessly into the ocean with continuous bank outlines', () => {
    const width = 72;
    const height = 36;
    const dem = makeMeanderingRiver(width, height);
    const oceanStartX = 58;
    dem.isOcean = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
      for (let x = oceanStartX; x < width; x++) {
        const index = y * width + x;
        dem.isOcean[index] = 1;
        dem.biomeType[index] = 8;
      }
    }

    const overlay = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 19,
      fillSmoothing: 2,
      outlineSmoothing: 2,
    });

    // Ocean water has unified water wash coverage
    for (let y = 0; y < height; y++) {
      for (let x = oceanStartX; x < width; x++) {
        const index = y * width + x;
        expect(overlay.waterAlpha[index]).toBe(255);
        // Bank outline is on the land side, not in open water
        if (x > oceanStartX + 2) {
          expect(overlay.bankAlpha[index]).toBe(0);
        }
      }
    }
  });

  it('recenters a bank-hugging routed path within the visible water body', () => {
    const width = 32;
    const height = 120;
    const totalCells = width * height;
    const isRiverChannel = new Uint8Array(totalCells);
    const waterDepthM = new Float32Array(totalCells);
    const strahlerOrder = new Uint8Array(totalCells);
    const flowDirection = new Int8Array(totalCells).fill(-1);
    const drainageAreaKm2 = new Float32Array(totalCells);
    const biomeType = new Uint8Array(totalCells);

    for (let y = 0; y < height; y++) {
      for (let x = 8; x <= 20; x++) {
        const index = y * width + x;
        isRiverChannel[index] = 1;
        waterDepthM[index] = 2;
        strahlerOrder[index] = 4;
        drainageAreaKm2[index] = 12;
        biomeType[index] = 6;
      }
      if (y + 1 < height) flowDirection[y * width + 8] = 4; // south, directly against the left bank
    }

    const dem = {
      width,
      height,
      isRiverChannel,
      waterDepthM,
      strahlerOrder,
      flowDirection,
      drainageAreaKm2,
      biomeType,
    } as MountainDEMData;
    const overlay = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 11,
      flowDensity: 2,
    });

    let markedCells = 0;
    let totalMarkedX = 0;
    for (let index = 0; index < overlay.flowAlpha.length; index++) {
      if (overlay.flowAlpha[index] === 0) continue;
      markedCells++;
      totalMarkedX += index % width;
    }

    expect(markedCells).toBeGreaterThan(0);
    expect(totalMarkedX / markedCells).toBeGreaterThan(12.5);
  });

  it('uses Outline thickness for inland water boundaries without mixing in Charcoal thickness', () => {
    const dem = makeMeanderingRiver(96, 44);
    const outlineThin = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 42,
      outlineThickness: 0.2,
      flowThickness: 1.2,
    });
    const outlineThick = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 42,
      outlineThickness: 3,
      flowThickness: 1.2,
    });
    const charcoalThick = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 42,
      outlineThickness: 0.2,
      flowThickness: 3,
    });
    const sumAlpha = (values: Uint8Array | undefined): number =>
      values?.reduce((sum, value) => sum + value, 0) ?? 0;

    expect(sumAlpha(outlineThick.outlineBankAlpha)).toBeGreaterThan(
      sumAlpha(outlineThin.outlineBankAlpha),
    );
    expect(Array.from(charcoalThick.outlineBankAlpha ?? [])).toEqual(
      Array.from(outlineThin.outlineBankAlpha ?? []),
    );
    expect(Array.from(outlineThick.flowAlpha)).toEqual(
      Array.from(outlineThin.flowAlpha),
    );
  });

  it('renders unified water coverage and outlines directly from DEM water channels', () => {
    const width = 64;
    const height = 28;
    const totalCells = width * height;
    const isRiverChannel = new Uint8Array(totalCells);
    const waterDepthM = new Float32Array(totalCells);
    const strahlerOrder = new Uint8Array(totalCells);
    const flowDirection = new Int8Array(totalCells).fill(-1);
    const drainageAreaKm2 = new Float32Array(totalCells);
    const biomeType = new Uint8Array(totalCells);
    const centerY = Math.floor(height / 2);

    for (let x = 2; x < width - 2; x++) {
      for (let y = centerY - 2; y <= centerY + 2; y++) {
        const index = y * width + x;
        isRiverChannel[index] = 1;
        waterDepthM[index] = 2;
        strahlerOrder[index] = 3;
        drainageAreaKm2[index] = 3 + x * 0.2;
        biomeType[index] = 6;
      }
      const center = centerY * width + x;
      flowDirection[center] = 2;
    }

    const overlay = renderWaterOverlay({
      width,
      height,
      isRiverChannel,
      waterDepthM,
      strahlerOrder,
      flowDirection,
      drainageAreaKm2,
      biomeType,
    } as MountainDEMData, {
      riverThresholdKm2: 2,
      flowThickness: 1,
    });

    expect(overlay.waterAlpha[centerY * width + 20]).toBe(255);
    // The spline fills the five-cell channel; the bank follows the outside of
    // its anti-aliased edge.
    expect(overlay.waterAlpha[(centerY - 2) * width + 20]).toBeGreaterThan(0);
    expect(overlay.waterAlpha[(centerY - 2) * width + 20]).toBeLessThan(255);
    expect(overlay.bankAlpha[(centerY - 3) * width + 20]).toBeGreaterThan(0);
  });

  it('stays within the water channel footprint and filters small disconnected pixels', () => {
    const dem = makeMeanderingRiver(128, 52);
    const overlay = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      flowThickness: 1,
    });

    let renderedWaterCells = 0;
    for (let index = 0; index < overlay.waterAlpha.length; index++) {
      if (overlay.waterAlpha[index] > 30) renderedWaterCells++;
    }

    expect(renderedWaterCells).toBeGreaterThan(100);
    expect(renderedWaterCells).toBeLessThan(128 * 52 * 0.35);
  });

  it('omits charcoal flow ink when the rendered water is too narrow', () => {
    const width = 84;
    const height = 18;
    const totalCells = width * height;
    const isRiverChannel = new Uint8Array(totalCells);
    const riverCenterlineMask = new Uint8Array(totalCells);
    const waterDepthM = new Float32Array(totalCells);
    const strahlerOrder = new Uint8Array(totalCells);
    const flowDirection = new Int8Array(totalCells).fill(-1);
    const drainageAreaKm2 = new Float32Array(totalCells);
    const biomeType = new Uint8Array(totalCells);
    const centerY = 9;

    for (let x = 2; x < width - 2; x++) {
      const index = centerY * width + x;
      isRiverChannel[index] = 1;
      riverCenterlineMask[index] = 1;
      waterDepthM[index] = 0.5;
      strahlerOrder[index] = 1;
      flowDirection[index] = 2;
      drainageAreaKm2[index] = 3;
      biomeType[index] = 6;
    }
    const overlay = renderWaterOverlay({
      width,
      height,
      isRiverChannel,
      riverCenterlineMask,
      waterDepthM,
      strahlerOrder,
      flowDirection,
      drainageAreaKm2,
      biomeType,
    } as MountainDEMData, {
      riverThresholdKm2: 2,
      flowDensity: 2,
      seed: 31,
    });

    expect(overlay.waterAlpha.some((alpha) => alpha > 0)).toBe(true);
    expect(overlay.flowAlpha.some((alpha) => alpha > 0)).toBe(false);
  });

  it('places flow ink off-center and sometimes uses two lanes in wide water', () => {
    const width = 112;
    const height = 34;
    const totalCells = width * height;
    const isRiverChannel = new Uint8Array(totalCells);
    const riverCenterlineMask = new Uint8Array(totalCells);
    const waterDepthM = new Float32Array(totalCells);
    const strahlerOrder = new Uint8Array(totalCells);
    const flowDirection = new Int8Array(totalCells).fill(-1);
    const drainageAreaKm2 = new Float32Array(totalCells);
    const biomeType = new Uint8Array(totalCells);
    const centerY = 17;

    for (let x = 0; x < width; x++) {
      for (let y = centerY - 5; y <= centerY + 5; y++) {
        const index = y * width + x;
        isRiverChannel[index] = 1;
        waterDepthM[index] = 3;
        strahlerOrder[index] = 5;
        drainageAreaKm2[index] = 18;
        biomeType[index] = 6;
      }
      if (x >= 2 && x < width - 6) {
        const center = centerY * width + x;
        riverCenterlineMask[center] = 1;
        flowDirection[center] = 2;
      }
    }
    const overlay = renderWaterOverlay({
      width,
      height,
      isRiverChannel,
      riverCenterlineMask,
      waterDepthM,
      strahlerOrder,
      flowDirection,
      drainageAreaKm2,
      biomeType,
    } as MountainDEMData, {
      riverThresholdKm2: 2,
      flowDensity: 2,
      flowLength: 1.5,
      seed: 37,
    });

    let hasPairedColumn = false;
    for (let x = Math.floor(width * 0.55); x < width - 3; x++) {
      let above = false;
      let below = false;
      for (let y = 0; y < height; y++) {
        if (overlay.flowAlpha[y * width + x] === 0) continue;
        if (y < centerY) above = true;
        if (y > centerY) below = true;
      }
      if (above && below) {
        hasPairedColumn = true;
        break;
      }
    }

    expect(overlay.flowAlpha.some((alpha) => alpha > 0)).toBe(true);
    expect(hasPairedColumn).toBe(true);
  });

  it('keeps generated wetland pools the requested distance from the ocean', () => {
    const width = 240;
    const height = 160;
    const dem = makeMeanderingRiver(width, height);
    dem.biomeType.fill(7);
    dem.isRiverChannel.fill(0);
    dem.riverCenterlineMask.fill(0);
    dem.isOcean = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < 40; x++) dem.isOcean[y * width + x] = 1;
    }
    // Pool grid cell is min(width, height) * 0.19 = 30.4px.
    const poolXs = (coastDistance: number) => {
      const { puddleMask } = buildWetlandPuddleContours(dem, {
        density: 2,
        seed: 42,
        coastDistance,
        geometryOnly: true,
      });
      const xs: number[] = [];
      puddleMask.forEach((value, index) => {
        if (value) xs.push(index % width);
      });
      return xs;
    };

    expect(poolXs(0).some((x) => x < 70)).toBe(true);
    const spaced = poolXs(1);
    expect(spaced.length).toBeGreaterThan(0);
    expect(spaced.every((x) => x >= 70)).toBe(true);
  });

  it('creates deterministic broken cellular contours only inside wetland biome cells', () => {
    const dem = makeMeanderingRiver(96, 44);
    dem.biomeType.fill(7); // Valley Floodplain & Wetland
    dem.isRiverChannel.fill(0);
    dem.riverCenterlineMask.fill(0);

    const first = buildWetlandPuddleContours(dem, {
      density: 1,
      opacity: 0.8,
      seed: 42,
    });
    const second = buildWetlandPuddleContours(dem, {
      density: 1,
      opacity: 0.8,
      seed: 42,
    });

    expect(Array.from(first.alpha)).toEqual(Array.from(second.alpha));
    expect(Array.from(first.tone)).toEqual(Array.from(second.tone));
    expect(first.alpha.some((value) => value > 0)).toBe(true);
    expect(first.tone.some((value) => value > 0)).toBe(true);
    expect(first.fillAlpha.some((value) => value > 0)).toBe(true);
    expect(first.fillTone.some((value) => value > 0)).toBe(true);

    const differentSeed = buildWetlandPuddleContours(dem, {
      density: 1,
      opacity: 0.8,
      seed: 43,
    });
    expect(
      differentSeed.alpha.some(
        (value, index) =>
          value !== first.alpha[index] ||
          differentSeed.fillAlpha[index] !== first.fillAlpha[index],
      ),
    ).toBe(true);

    const changedDensity = buildWetlandPuddleContours(dem, {
      density: 0.35,
      opacity: 0.8,
      seed: 42,
    });
    const changedScale = buildWetlandPuddleContours(dem, {
      density: 1,
      sizeMin: 0.3,
      sizeMax: 0.9,
      opacity: 0.8,
      seed: 42,
    });
    const changedThickness = buildWetlandPuddleContours(dem, {
      density: 1,
      thickness: 2.4,
      opacity: 0.8,
      seed: 42,
    });
    expect(Array.from(changedDensity.fillAlpha)).not.toEqual(
      Array.from(first.fillAlpha),
    );
    expect(Array.from(changedScale.fillAlpha)).not.toEqual(
      Array.from(first.fillAlpha),
    );
    expect(Array.from(changedThickness.alpha)).not.toEqual(
      Array.from(first.alpha),
    );

    const clippedDem = makeMeanderingRiver(96, 44);
    clippedDem.biomeType.fill(4);
    for (let y = 2; y < 42; y++) {
      for (let x = 2; x < 94; x++) clippedDem.biomeType[y * 96 + x] = 7;
    }
    const clipped = buildWetlandPuddleContours(clippedDem, { density: 2, seed: 42 });
    for (let index = 0; index < clipped.alpha.length; index++) {
      if (clipped.alpha[index] > 0) expect(clippedDem.biomeType[index]).toBe(7);
    }
    expect(clipped.alpha.some((value) => value > 0)).toBe(true);

    const disabled = buildWetlandPuddleContours(dem, { density: 0 });
    expect(disabled.alpha.some((value) => value > 0)).toBe(false);

    // Pool rings need a pool deep enough to hold them.
    const poolDem = makeMeanderingRiver(160, 120);
    poolDem.biomeType.fill(7);
    poolDem.isRiverChannel.fill(0);
    poolDem.riverCenterlineMask.fill(0);
    const overlay = renderWaterOverlay(poolDem, {
      riverThresholdKm2: 2,
      seed: 42,
      wetlandPuddleContours: true,
      wetlandPuddleSizeMin: 0.3,
      wetlandPuddleSizeMax: 1,
    });
    expect(overlay.waterAlpha.some((value) => value > 0)).toBe(true);
    expect(overlay.wetlandPuddleContourAlpha?.some((value) => value > 0)).toBe(true);
    expect(overlay.wetlandPuddleFillAlpha?.some((value) => value > 0)).toBe(false);
  });

  it('builds one water surface and outline for wetland pools and rivers', () => {
    const width = 240;
    const height = 180;
    const dem = {
      width,
      height,
      biomeType: new Uint8Array(width * height).fill(7),
      isRiverChannel: new Uint8Array(width * height),
      flowDirection: new Int8Array(width * height).fill(-1),
      drainageAreaKm2: new Float32Array(width * height),
      waterDepthM: new Float32Array(width * height),
      strahlerOrder: new Uint8Array(width * height),
    } as MountainDEMData;
    const seed = 42;
    const pools = buildWetlandPuddleContours(dem, {
      density: 1,
      seed,
      opacity: 1,
    });
    let poolIndex = -1;
    let deepestPoolDistance = 0;
    for (let index = 0; index < pools.puddleMask.length; index++) {
      const x = index % width;
      const y = Math.floor(index / width);
      if (
        pools.puddleMask[index] === 1 &&
        x > 24 &&
        x < width - 24 &&
        y > 24 &&
        y < height - 24 &&
        pools.interiorDistance[index] > deepestPoolDistance
      ) {
        deepestPoolDistance = pools.interiorDistance[index];
        poolIndex = index;
      }
    }
    expect(poolIndex).toBeGreaterThanOrEqual(0);

    const riverY = Math.floor(poolIndex / width);
    const river: RiverSpline = {
      key: 91,
      samples: [
        { x: 2, y: riverY, radius: 5, area: 20, order: 4, sourceIndex: 2 },
        {
          x: width - 3,
          y: riverY,
          radius: 5,
          area: 20,
          order: 4,
          sourceIndex: width - 3,
        },
      ],
    };

    const isolated = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      wetlandPuddleContours: true,
      wetlandPuddleDensity: 1,
      wetlandPuddleSeed: seed,
    });
    for (let x = 0; x < width; x++) {
      const index = riverY * width + x;
      dem.isRiverChannel[index] = 1;
      dem.drainageAreaKm2[index] = 20;
      dem.waterDepthM[index] = 1;
      dem.strahlerOrder[index] = 4;
    }
    const merged = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      wetlandPuddleContours: true,
      wetlandPuddleDensity: 1,
      wetlandPuddleSeed: seed,
      riverSplinesOverride: [river],
      outlineThickness: 1.4,
      flowThickness: 1.2,
    });

    // Pools are visual water even when isolated; adding a river only changes
    // the union geometry and never adds a second fill layer.
    expect(isolated.waterAlpha.some((value) => value > 0)).toBe(true);
    expect(isolated.wetlandPuddleFillAlpha?.some((value) => value > 0)).toBe(false);
    expect(isolated.wetlandPuddlePriorityAlpha?.some((value) => value > 0)).toBe(true);
    expect(merged.wetlandPuddleFillAlpha?.some((value) => value > 0)).toBe(false);
    let mergedWetlandWaterCells = 0;
    for (let index = 0; index < merged.waterAlpha.length; index++) {
      if (
        dem.biomeType[index] === 7 &&
        merged.waterAlpha[index] > 28 &&
        Math.abs(Math.floor(index / width) - riverY) > 7
      ) {
        mergedWetlandWaterCells++;
      }
    }
    expect(mergedWetlandWaterCells).toBeGreaterThan(20);
    // The pool centre is interior to the final joined surface, so neither the
    // original pool edge nor the crossing river can leave an outline there.
    expect(merged.waterTone[poolIndex]).toBeGreaterThan(150);
    expect(merged.wetlandPuddlePriorityAlpha?.[poolIndex] ?? 0).toBe(255);
    expect(merged.outlineBankAlpha?.[poolIndex] ?? 0).toBe(0);
    expect(merged.bankAlpha.some((value) => value > 0)).toBe(true);
    expect(merged.flowAlpha.some((value) => value > 0)).toBe(true);
    expect(merged.riverContourAlpha?.some((value) => value > 0)).toBe(true);
    expect(merged.wetlandPuddleContourAlpha?.some((value) => value > 0)).toBe(true);
    for (let index = 0; index < merged.waterAlpha.length; index++) {
      if ((merged.wetlandPuddleContourAlpha?.[index] ?? 0) > 0) {
        expect(merged.waterAlpha[index]).toBeGreaterThanOrEqual(128);
      }
      if (pools.puddleMask[index] === 1) {
        expect(merged.flowAlpha[index]).toBe(merged.wetlandPuddleContourAlpha?.[index]);
      }
    }
  });

  it('draws concentric inset charcoal rings only inside a wetland pool', () => {
    const width = 80;
    const height = 80;
    const totalCells = width * height;
    const poolMask = new Uint8Array(totalCells);
    for (let y = 10; y < 70; y++) {
      for (let x = 10; x < 70; x++) poolMask[y * width + x] = 1;
    }
    const dem = {
      width, height,
      biomeType: new Uint8Array(totalCells).fill(7),
      wetlandPoolMask: poolMask,
      isRiverChannel: new Uint8Array(totalCells),
      riverChannelRadius: new Uint8Array(totalCells),
      flowDirection: new Int8Array(totalCells).fill(-1),
      drainageAreaKm2: new Float32Array(totalCells),
      waterDepthM: new Float32Array(totalCells),
      strahlerOrder: new Uint8Array(totalCells),
    } as MountainDEMData;
    const overlay = renderWaterOverlay(dem, {
      wetlandPuddleContours: true,
      flowThickness: 1,
      flowDensity: 2,
      wetlandPuddleSeed: 42,
    });
    const markedDepths = new Set<number>();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (overlay.flowAlpha[y * width + x] === 0) continue;
        expect(poolMask[y * width + x]).toBe(1);
        markedDepths.add(Math.min(x - 9, 70 - x, y - 9, 70 - y));
      }
    }
    // Rings start clear of the shoreline and repeat inward.
    const depths = [...markedDepths].sort((a, b) => a - b);
    expect(depths[0]).toBeGreaterThan(1);
    expect(depths[depths.length - 1]).toBeGreaterThan(depths[0] + 4);
  });

  it('lets the DEM wetland-pool mask override an intersecting river biome strip', () => {
    const width = 180;
    const height = 140;
    const totalCells = width * height;
    const dem = {
      width,
      height,
      biomeType: new Uint8Array(totalCells).fill(7),
      isRiverChannel: new Uint8Array(totalCells),
      riverChannelRadius: new Uint8Array(totalCells),
      flowDirection: new Int8Array(totalCells).fill(-1),
      drainageAreaKm2: new Float32Array(totalCells),
      waterDepthM: new Float32Array(totalCells),
      strahlerOrder: new Uint8Array(totalCells),
    } as MountainDEMData;
    const seed = 42;
    const baseline = buildWetlandPuddleContours(dem, {
      density: 1,
      seed,
      geometryOnly: true,
    });

    let poolCentre = -1;
    let centreDepth = 0;
    for (let index = 0; index < totalCells; index++) {
      if (baseline.interiorDistance[index] > centreDepth) {
        centreDepth = baseline.interiorDistance[index];
        poolCentre = index;
      }
    }
    expect(centreDepth).toBeGreaterThan(5);

    const centreX = poolCentre % width;
    const centreY = Math.floor(poolCentre / width);
    const riverX = Math.min(
      width - 3,
      centreX + Math.max(2, Math.floor(centreDepth * 0.45)),
    );
    const crossingIndex = centreY * width + riverX;
    expect(baseline.puddleMask[crossingIndex]).toBe(1);

    for (let y = 0; y < height; y++) {
      for (let x = riverX - 1; x <= riverX + 1; x++) {
        const index = y * width + x;
        dem.biomeType[index] = 6;
        dem.isRiverChannel[index] = 1;
        dem.riverChannelRadius![index] = 2;
        dem.drainageAreaKm2[index] = 20;
      }
    }

    const waterDem = buildVisualWaterSurfaceDEM(dem, {
      enabled: true,
      density: 1,
      seed,
      riverThresholdKm2: 2,
    });

    // The river cell remains river routing data; the final DEM water union is
    // what gives the wetland pool surface priority over that biome boundary.
    expect(waterDem.wetlandPoolMask?.[crossingIndex]).toBe(0);
    expect(waterDem.visualWaterMask?.[crossingIndex]).toBe(1);
    const overlay = renderWaterOverlay(waterDem, {
      riverThresholdKm2: 2,
      wetlandPuddleContours: true,
    });
    expect(overlay.waterAlpha[crossingIndex]).toBeGreaterThan(128);
    expect(overlay.wetlandPuddlePriorityAlpha?.[crossingIndex]).toBe(0);
    expect(overlay.outlineBankAlpha?.[crossingIndex]).toBe(0);
  });

  it('computes distance to coast and contour tangent vectors accurately', () => {
    const width = 40;
    const height = 40;
    const isOcean = new Uint8Array(width * height);
    // Island in the center (radius 8, center at 20, 20)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const distToCenter = Math.hypot(x - 20, y - 20);
        if (distToCenter > 8) {
          isOcean[y * width + x] = 1;
        }
      }
    }

    const distance = buildDistanceToCoast(isOcean, width, height);

    // Island interior should have distance 0
    expect(distance[20 * width + 20]).toBe(0);
    // Ocean adjacent to island should have distance ~ 1..2
    expect(distance[20 * width + 29]).toBeGreaterThan(0);
    expect(distance[20 * width + 29]).toBeLessThan(3);
    // Far ocean corner should have larger distance
    expect(distance[0]).toBeGreaterThan(10);

    // Tangent at point (20, 29) - directly east of circular island
    // Gradient points east (+X, 0), so tangent should point north or south (0, +1 or 0, -1)
    const tangentEast = getContourTangentAt(distance, width, height, 29, 20);
    expect(tangentEast.valid).toBe(true);
    expect(Math.abs(tangentEast.tx)).toBeLessThan(0.35);
    expect(Math.abs(tangentEast.ty)).toBeGreaterThan(0.9);

    // Tangent at point (20, 11) - directly north of circular island
    // Gradient points north (0, -Y), so tangent should point east or west (+1, 0 or -1, 0)
    const tangentNorth = getContourTangentAt(distance, width, height, 20, 11);
    expect(tangentNorth.valid).toBe(true);
    expect(Math.abs(tangentNorth.tx)).toBeGreaterThan(0.9);
    expect(Math.abs(tangentNorth.ty)).toBeLessThan(0.35);
  });

  it('generates ocean watercolor wash, outline coastline, charcoal coastal contours, and painted waves', () => {
    const width = 60;
    const height = 60;
    const totalCells = width * height;
    const isRiverChannel = new Uint8Array(totalCells);
    const isOcean = new Uint8Array(totalCells);
    const biomeType = new Uint8Array(totalCells);

    // Land on the left half, ocean on the right half
    for (let y = 0; y < height; y++) {
      for (let x = 30; x < width; x++) {
        const index = y * width + x;
        isOcean[index] = 1;
        biomeType[index] = 8;
      }
    }

    const dem = {
      width,
      height,
      isRiverChannel,
      isOcean,
      biomeType,
      flowDirection: new Int8Array(totalCells).fill(-1),
      drainageAreaKm2: new Float32Array(totalCells),
      waterDepthM: new Float32Array(totalCells),
      strahlerOrder: new Uint8Array(totalCells),
    } as unknown as MountainDEMData;

    const overlay = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      outlineThickness: 1.2,
      outlineOpacity: 0.9,
      flowThickness: 1.2,
      flowOpacity: 0.9,
      oceanRippleCount: 5,
      oceanRippleDensity: 1.2,
      oceanWaveOpacity: 0.85,
      seed: 42,
    });

    expect(overlay.oceanWaterAlpha).toBeDefined();
    expect(overlay.oceanWaterTone).toBeDefined();
    expect(overlay.oceanBankAlpha).toBeDefined();
    expect(overlay.oceanFlowAlpha).toBeDefined();

    // Ocean water wash covers the right half
    expect(overlay.oceanWaterAlpha![30 * width + 45]).toBe(255);
    expect(overlay.oceanWaterAlpha![30 * width + 15]).toBe(0);

    // Watercolor depth tone is higher (shallower) near x=30 and lower further out at x=58
    expect(overlay.oceanWaterTone![30 * width + 31]).toBeGreaterThan(overlay.oceanWaterTone![30 * width + 58]);

    // The traced shoreline sits on the x=29/30 pixel boundary, and the
    // requested stroke is centered on it rather than displaced across a fringe.
    expect(overlay.waterAlpha![30 * width + 29]).toBeLessThan(255);
    expect(overlay.waterAlpha![30 * width + 30]).toBe(255);
    expect(overlay.oceanBankAlpha![30 * width + 28]).toBe(0);
    expect(overlay.oceanBankAlpha![30 * width + 29]).toBeGreaterThan(50);
    expect(overlay.oceanBankAlpha![30 * width + 30]).toBeGreaterThan(50);
    expect(overlay.oceanBankAlpha![30 * width + 31]).toBe(0);
    expect(overlay.oceanBankAlpha![30 * width + 10]).toBe(0);
    expect(overlay.oceanBankAlpha![30 * width + 55]).toBe(0);

    // Near-coast charcoal contour marks are disabled for now
    // (OCEAN_COASTAL_CONTOUR_OPACITY = 0), so only their confinement is checked.

    // Coastal contour marks are strictly confined to ocean cells.
    for (let i = 0; i < totalCells; i++) {
      if (overlay.flowAlpha[i] > 0) {
        expect(isOcean[i]).toBe(1);
      }
    }
  });

  it('keeps the ocean shoreline antialias band to the outline width', () => {
    const width = 48;
    const height = 24;
    const oceanStartX = 24;
    const totalCells = width * height;
    const isOcean = new Uint8Array(totalCells);
    const biomeType = new Uint8Array(totalCells);

    for (let y = 0; y < height; y++) {
      for (let x = oceanStartX; x < width; x++) {
        const index = y * width + x;
        isOcean[index] = 1;
        biomeType[index] = 8;
      }
    }

    const dem = {
      width,
      height,
      isOcean,
      biomeType,
      isRiverChannel: new Uint8Array(totalCells),
      flowDirection: new Int8Array(totalCells).fill(-1),
      drainageAreaKm2: new Float32Array(totalCells),
      waterDepthM: new Float32Array(totalCells),
      strahlerOrder: new Uint8Array(totalCells),
    } as unknown as MountainDEMData;

    const overlay = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      flowThickness: 1,
      fillSmoothing: 0,
      deepOceanSwells: false,
      seed: 11,
    });
    const center = Math.floor(height / 2) * width;

    // The fill ends on the traced 50% boundary and the bank is centered on it
    // instead of being pushed outside it.
    expect(overlay.waterAlpha[center + oceanStartX - 1]).toBeLessThan(255);
    expect(overlay.waterAlpha[center + oceanStartX]).toBe(255);
    expect(overlay.waterAlpha[center + oceanStartX - 2]).toBe(0);
    expect(overlay.bankAlpha[center + oceanStartX - 1]).toBeGreaterThan(0);
    expect(overlay.bankAlpha[center + oceanStartX - 2]).toBe(0);
  });

  it('does not turn pre-smoothed export coverage into a wide bank halo', () => {
    const width = 64;
    const height = 20;
    const oceanStartX = 32;
    const totalCells = width * height;
    const isOcean = new Uint8Array(totalCells);
    const biomeType = new Uint8Array(totalCells);
    const oceanMaskCoverageOverride = new Float32Array(totalCells);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (x >= oceanStartX) {
          isOcean[index] = 1;
          biomeType[index] = 8;
        }
        oceanMaskCoverageOverride[index] = Math.max(
          0,
          Math.min(1, (x - (oceanStartX - 6)) / 12),
        );
      }
    }

    const dem = {
      width,
      height,
      isOcean,
      biomeType,
      isRiverChannel: new Uint8Array(totalCells),
      flowDirection: new Int8Array(totalCells).fill(-1),
      drainageAreaKm2: new Float32Array(totalCells),
      waterDepthM: new Float32Array(totalCells),
      strahlerOrder: new Uint8Array(totalCells),
    } as unknown as MountainDEMData;
    const overlay = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      flowThickness: 1,
      fillSmoothing: 0,
      deepOceanSwells: false,
      oceanMaskCoverageOverride,
      seed: 11,
    });
    const center = Math.floor(height / 2) * width;
    const fringeX = oceanStartX - 4;

    expect(overlay.bankAlpha[center + fringeX]).toBe(0);
    expect(overlay.bankAlpha[center + oceanStartX - 1]).toBeGreaterThan(0);
  });

  // Re-enable with OCEAN_COASTAL_CONTOUR_OPACITY in waterRenderer.ts.
  it.skip('keeps coastal charcoal contours separate from painted offshore waves', () => {
    const width = 96;
    const height = 72;
    const totalCells = width * height;
    const isOcean = new Uint8Array(totalCells);
    const biomeType = new Uint8Array(totalCells);
    for (let y = 0; y < height; y++) {
      for (let x = 24; x < width; x++) {
        const index = y * width + x;
        isOcean[index] = 1;
        biomeType[index] = 8;
      }
    }

    const dem = {
      width,
      height,
      isOcean,
      biomeType,
      isRiverChannel: new Uint8Array(totalCells),
      flowDirection: new Int8Array(totalCells).fill(-1),
      drainageAreaKm2: new Float32Array(totalCells),
      waterDepthM: new Float32Array(totalCells),
      strahlerOrder: new Uint8Array(totalCells),
    } as unknown as MountainDEMData;
    const sumAlpha = (values: Uint8Array | undefined): number =>
      values?.reduce((sum, value) => sum + value, 0) ?? 0;

    const coastalOutlineThin = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 123,
      oceanRippleCount: 12,
      flowDensity: 1.6,
      flowThickness: 1.2,
      flowLength: 1.1,
      outlineThickness: 0.2,
      outlineLength: 0.5,
      deepOceanSwells: false,
    });
    const coastalOutlineThick = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 123,
      oceanRippleCount: 12,
      flowDensity: 1.6,
      flowThickness: 1.2,
      flowLength: 1.1,
      outlineThickness: 3.0,
      outlineLength: 2.0,
      deepOceanSwells: false,
    });

    expect(Array.from(coastalOutlineThick.flowAlpha)).toEqual(
      Array.from(coastalOutlineThin.flowAlpha),
    );
    expect(sumAlpha(coastalOutlineThick.bankAlpha)).toBeGreaterThan(
      sumAlpha(coastalOutlineThin.bankAlpha),
    );
    expect(sumAlpha(coastalOutlineThick.oceanBankAlpha)).toBeGreaterThan(
      sumAlpha(coastalOutlineThin.oceanBankAlpha),
    );
    expect(sumAlpha(coastalOutlineThin.oceanFlowAlpha)).toBe(0);
    expect(sumAlpha(coastalOutlineThick.oceanFlowAlpha)).toBe(0);

    const charcoalThin = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 123,
      oceanRippleCount: 12,
      flowThickness: 0.2,
      outlineThickness: 1.4,
      outlineLength: 1.1,
      deepOceanSwells: false,
    });
    const charcoalThick = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 123,
      oceanRippleCount: 12,
      flowThickness: 3.0,
      outlineThickness: 1.4,
      outlineLength: 1.1,
      deepOceanSwells: false,
    });
    expect(Array.from(charcoalThick.oceanFlowAlpha ?? [])).toEqual(
      Array.from(charcoalThin.oceanFlowAlpha ?? []),
    );
    expect(sumAlpha(charcoalThick.flowAlpha)).toBeGreaterThan(
      sumAlpha(charcoalThin.flowAlpha),
    );
    expect(Array.from(charcoalThick.bankAlpha)).toEqual(
      Array.from(charcoalThin.bankAlpha),
    );

    const charcoalShort = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 123,
      oceanRippleCount: 12,
      flowLength: 0.5,
      outlineThickness: 1.4,
      deepOceanSwells: false,
    });
    const charcoalLong = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 123,
      oceanRippleCount: 12,
      flowLength: 2.0,
      outlineThickness: 1.4,
      deepOceanSwells: false,
    });
    expect(Array.from(charcoalLong.flowAlpha)).not.toEqual(
      Array.from(charcoalShort.flowAlpha),
    );

    const deepThin = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 123,
      flowDensity: 0,
      deepOceanSwells: true,
      deepOceanSwellDensity: 1,
      outlineLength: 0.5,
      outlineThickness: 0.2,
    });
    const deepThick = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 123,
      flowDensity: 0,
      deepOceanSwells: true,
      deepOceanSwellDensity: 1,
      outlineLength: 2,
      outlineThickness: 3.5,
    });

    expect(sumAlpha(deepThick.oceanFlowAlpha)).toBeGreaterThan(sumAlpha(deepThin.oceanFlowAlpha));
    expect(sumAlpha(deepThin.flowAlpha)).toBe(0);
    expect(sumAlpha(deepThick.flowAlpha)).toBe(0);

    const deepShort = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 123,
      flowDensity: 0,
      deepOceanSwells: true,
      deepOceanSwellDensity: 1,
      outlineLength: 1,
      outlineThickness: 1,
      deepOceanWaveLength: 0.4,
      deepOceanStrokeThickness: 1,
    });
    const deepLong = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 123,
      flowDensity: 0,
      deepOceanSwells: true,
      deepOceanSwellDensity: 1,
      outlineLength: 1,
      outlineThickness: 1,
      deepOceanWaveLength: 3,
      deepOceanStrokeThickness: 1,
    });
    const deepNarrow = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 123,
      flowDensity: 0,
      deepOceanSwells: true,
      deepOceanSwellDensity: 1,
      outlineLength: 1,
      outlineThickness: 1,
      deepOceanWaveLength: 1,
      deepOceanStrokeThickness: 0.2,
    });
    const deepWide = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      seed: 123,
      flowDensity: 0,
      deepOceanSwells: true,
      deepOceanSwellDensity: 1,
      outlineLength: 1,
      outlineThickness: 1,
      deepOceanWaveLength: 1,
      deepOceanStrokeThickness: 3,
    });

    expect(Array.from(deepLong.oceanFlowAlpha ?? [])).not.toEqual(
      Array.from(deepShort.oceanFlowAlpha ?? []),
    );
    expect(sumAlpha(deepWide.oceanFlowAlpha)).toBeGreaterThan(
      sumAlpha(deepNarrow.oceanFlowAlpha),
    );
  });

  it('respects showOceanDetails: false to disable ocean waves and outline bank', () => {
    const width = 40;
    const height = 40;
    const totalCells = width * height;
    const isRiverChannel = new Uint8Array(totalCells);
    const isOcean = new Uint8Array(totalCells).fill(1);
    const biomeType = new Uint8Array(totalCells).fill(8);

    const dem = {
      width,
      height,
      isRiverChannel,
      isOcean,
      biomeType,
      flowDirection: new Int8Array(totalCells).fill(-1),
      drainageAreaKm2: new Float32Array(totalCells),
      waterDepthM: new Float32Array(totalCells),
      strahlerOrder: new Uint8Array(totalCells),
    } as unknown as MountainDEMData;

    const overlay = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      showOceanDetails: false,
    });

    expect(overlay.oceanBankAlpha?.some((v) => v > 0)).toBe(false);
    expect(overlay.oceanFlowAlpha?.some((v) => v > 0)).toBe(false);
    expect(overlay.oceanWaveLightAlpha?.some((v) => v > 0)).toBe(false);
    expect(overlay.oceanWaveShadowAlpha?.some((v) => v > 0)).toBe(false);
    expect(overlay.oceanWaveInkAlpha?.some((v) => v > 0)).toBe(false);
    expect(overlay.crestAlpha?.some((v) => v > 0)).toBe(false);
  });

  it('clips ridge shading and broken foam to ocean pixels and disables them with water details', () => {
    const width = 288;
    const height = 288;
    const totalCells = width * height;
    const isOcean = new Uint8Array(totalCells);
    const biomeType = new Uint8Array(totalCells);
    for (let y = 0; y < height; y++) {
      for (let x = 8; x < width; x++) {
        if (x >= 76 && x < 92 && y >= 48 && y < 72) continue;
        const index = y * width + x;
        isOcean[index] = 1;
        biomeType[index] = 8;
      }
    }
    const dem = {
      width,
      height,
      isOcean,
      biomeType,
      isRiverChannel: new Uint8Array(totalCells),
      flowDirection: new Int8Array(totalCells).fill(-1),
      drainageAreaKm2: new Float32Array(totalCells),
      waterDepthM: new Float32Array(totalCells),
      strahlerOrder: new Uint8Array(totalCells),
    } as unknown as MountainDEMData;
    const options = {
      riverThresholdKm2: 2,
      deepOceanSwells: true,
      deepOceanSwellDensity: 0.4,
      deepOceanWaveLength: 1.2,
      deepOceanStrokeThickness: 1.5,
      seed: 42,
    };
    const distanceToCoast = buildDistanceToCoast(isOcean, width, height);
    const maxDistance = distanceToCoast.reduce(
      (maximum, value) => Math.max(maximum, value),
      0,
    );
    const stableOptions = {
      ...options,
      oceanDistanceToCoastOverride: distanceToCoast,
      oceanDistanceNormalizationMax: maxDistance,
      oceanCoordinateStride: width,
    };
    const overlay = renderWaterOverlay(dem, stableOptions);
    const sumMask = (mask: Uint8Array | undefined): number => {
      let total = 0;
      if (mask) for (const value of mask) total += value;
      return total;
    };
    const shadeCoverage = (value: typeof overlay): number =>
      sumMask(value.oceanWaveLightAlpha) + sumMask(value.oceanWaveShadowAlpha);
    const baseShading = renderWaterOverlay(dem, {
      ...stableOptions,
      deepOceanWaveShadingScale: 1,
      deepOceanWaveShadingIntensity: 1,
    });
    const widerShading = renderWaterOverlay(dem, {
      ...stableOptions,
      deepOceanWaveShadingScale: 2,
      deepOceanWaveShadingIntensity: 1,
    });
    const strongerShading = renderWaterOverlay(dem, {
      ...stableOptions,
      deepOceanWaveShadingScale: 1,
      deepOceanWaveShadingIntensity: 2.5,
    });
    const hiddenShading = renderWaterOverlay(dem, {
      ...stableOptions,
      deepOceanWaveShadingIntensity: 0,
    });
    expect(shadeCoverage(widerShading)).toBeGreaterThan(shadeCoverage(baseShading));
    expect(shadeCoverage(strongerShading)).toBeGreaterThan(shadeCoverage(baseShading));
    expect(shadeCoverage(hiddenShading)).toBe(0);
    const hiddenTurbulence = renderWaterOverlay(dem, {
      ...stableOptions,
      deepOceanTurbulenceIntensity: 0,
    });
    expect(hiddenTurbulence.oceanTurbulenceAlpha?.some((value) => value > 0)).toBe(false);

    const waveLayers = [
      overlay.oceanFlowAlpha,
      overlay.oceanWaveLightAlpha,
      overlay.oceanWaveShadowAlpha,
      overlay.oceanWaveInkAlpha,
      overlay.oceanTurbulenceAlpha,
      overlay.crestAlpha,
    ];
    for (const layer of waveLayers) {
      expect(layer?.some((value) => value > 0)).toBe(true);
      for (let index = 0; index < totalCells; index++) {
        if ((layer?.[index] ?? 0) > 0) expect(isOcean[index]).toBe(1);
      }
    }

    const tileX = 112;
    const tileY = 112;
    const tileWidth = 32;
    const tileHeight = 32;
    const padding = 112;
    const expandedX = tileX - padding;
    const expandedY = tileY - padding;
    const expandedWidth = tileWidth + padding * 2;
    const expandedHeight = tileHeight + padding * 2;
    const cropBytes = (
      field: Uint8Array,
      x: number,
      y: number,
      cropWidth: number,
      cropHeight: number,
    ): Uint8Array => {
      const cropped = new Uint8Array(cropWidth * cropHeight);
      for (let row = 0; row < cropHeight; row++) {
        cropped.set(
          field.subarray((y + row) * width + x, (y + row) * width + x + cropWidth),
          row * cropWidth,
        );
      }
      return cropped;
    };
    const cropFloats = (
      field: Float32Array,
      x: number,
      y: number,
      cropWidth: number,
      cropHeight: number,
    ): Float32Array => {
      const cropped = new Float32Array(cropWidth * cropHeight);
      for (let row = 0; row < cropHeight; row++) {
        cropped.set(
          field.subarray((y + row) * width + x, (y + row) * width + x + cropWidth),
          row * cropWidth,
        );
      }
      return cropped;
    };
    const tileDem = {
      width: expandedWidth,
      height: expandedHeight,
      isOcean: cropBytes(isOcean, expandedX, expandedY, expandedWidth, expandedHeight),
      biomeType: cropBytes(biomeType, expandedX, expandedY, expandedWidth, expandedHeight),
      isRiverChannel: new Uint8Array(expandedWidth * expandedHeight),
      flowDirection: new Int8Array(expandedWidth * expandedHeight).fill(-1),
      drainageAreaKm2: new Float32Array(expandedWidth * expandedHeight),
      waterDepthM: new Float32Array(expandedWidth * expandedHeight),
      strahlerOrder: new Uint8Array(expandedWidth * expandedHeight),
    } as unknown as MountainDEMData;
    const tile = renderWaterOverlay(tileDem, {
      ...options,
      oceanCoordinateOffsetX: expandedX,
      oceanCoordinateOffsetY: expandedY,
      oceanCoordinateStride: width,
      oceanDistanceToCoastOverride: cropFloats(
        distanceToCoast,
        expandedX,
        expandedY,
        expandedWidth,
        expandedHeight,
      ),
      oceanDistanceNormalizationMax: maxDistance,
    });
    const seamLayers = [
      [overlay.oceanFlowAlpha, tile.oceanFlowAlpha],
      [overlay.oceanWaveLightAlpha, tile.oceanWaveLightAlpha],
      [overlay.oceanWaveShadowAlpha, tile.oceanWaveShadowAlpha],
      [overlay.oceanWaveInkAlpha, tile.oceanWaveInkAlpha],
      [overlay.crestAlpha, tile.crestAlpha],
    ] as const;
    for (const [wholeLayer, tileLayer] of seamLayers) {
      for (let y = tileY; y < tileY + tileHeight; y++) {
        for (let x = tileX; x < tileX + tileWidth; x++) {
          expect(Math.abs(
            (wholeLayer?.[y * width + x] ?? 0) -
              (tileLayer?.[(y - expandedY) * expandedWidth + x - expandedX] ?? 0),
          )).toBe(0);
        }
      }
    }

    const disabled = renderWaterOverlay(dem, {
      ...stableOptions,
      showWaterDetails: false,
    });
    expect(disabled.oceanFlowAlpha?.some((value) => value > 0)).toBe(false);
    expect(disabled.oceanWaveLightAlpha?.some((value) => value > 0)).toBe(false);
    expect(disabled.oceanWaveShadowAlpha?.some((value) => value > 0)).toBe(false);
    expect(disabled.oceanWaveInkAlpha?.some((value) => value > 0)).toBe(false);
    expect(disabled.oceanTurbulenceAlpha?.some((value) => value > 0)).toBe(false);
    expect(disabled.crestAlpha?.some((value) => value > 0)).toBe(false);
  });

  it('uses only the original DEM water mask when water details are disabled', () => {
    const width = 7;
    const height = 3;
    const totalCells = width * height;
    const isOcean = new Uint8Array(totalCells);
    isOcean[0] = 1;
    isOcean[1] = 1;
    const isRiverChannel = new Uint8Array(totalCells);
    isRiverChannel[10] = 1;
    const biomeType = new Uint8Array(totalCells);
    biomeType[11] = 6;

    const dem = {
      width,
      height,
      isRiverChannel,
      isOcean,
      biomeType,
      flowDirection: new Int8Array(totalCells).fill(-1),
      drainageAreaKm2: new Float32Array(totalCells).fill(10),
      waterDepthM: new Float32Array(totalCells),
      strahlerOrder: new Uint8Array(totalCells),
    } as unknown as MountainDEMData;

    const overlay = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      showWaterDetails: false,
    });

    expect(Array.from(overlay.waterAlpha)).toEqual(
      Array.from({ length: totalCells }, (_, index) => [0, 1, 10, 11].includes(index) ? 255 : 0),
    );
    expect(overlay.bankAlpha.some((value) => value > 0)).toBe(false);
    expect(overlay.flowAlpha.some((value) => value > 0)).toBe(false);
  });

  it('keeps wetland pool fill visible when water detail marks are disabled', () => {
    const width = 120;
    const height = 96;
    const totalCells = width * height;
    const dem = {
      width,
      height,
      biomeType: new Uint8Array(totalCells).fill(7),
      isRiverChannel: new Uint8Array(totalCells),
      flowDirection: new Int8Array(totalCells).fill(-1),
      drainageAreaKm2: new Float32Array(totalCells),
      waterDepthM: new Float32Array(totalCells),
      strahlerOrder: new Uint8Array(totalCells),
    } as MountainDEMData;

    const overlay = renderWaterOverlay(dem, {
      riverThresholdKm2: 2,
      showWaterDetails: false,
      wetlandPuddleContours: true,
      wetlandPuddleDensity: 1,
      wetlandPuddleSeed: 42,
    });

    expect(overlay.waterAlpha.some((value) => value > 0)).toBe(true);
    expect(overlay.wetlandPuddlePriorityAlpha?.some((value) => value > 0)).toBe(true);
    expect(overlay.outlineBankAlpha?.some((value) => value > 0)).toBe(false);
    expect(overlay.flowAlpha.some((value) => value > 0)).toBe(false);
  });

  it('simplifies tight raster Z/S zig-zag stair-steps and merges close points', () => {
    // Generate a 1-pixel stair-stepping path (classic D8 raster diagonal jitter: (0,0)->(1,0)->(1,1)->(2,1)->(2,2)...)
    const rawPoints: RiverPoint[] = [];
    let curX = 0;
    let curY = 0;
    for (let i = 0; i < 20; i++) {
      rawPoints.push({
        x: curX,
        y: curY,
        radius: 1.5,
        area: 5 + i * 0.5,
        order: 2,
        sourceIndex: i,
      });
      if (i % 2 === 0) curX += 1;
      else curY += 1;
    }

    expect(rawPoints.length).toBe(20);

    // Test micro-kink suppression
    const unkinked = suppressMicroKinks(rawPoints);
    expect(unkinked[0].x).toBe(rawPoints[0].x);
    expect(unkinked[0].y).toBe(rawPoints[0].y);
    expect(unkinked[unkinked.length - 1].x).toBe(rawPoints[rawPoints.length - 1].x);
    expect(unkinked[unkinked.length - 1].y).toBe(rawPoints[rawPoints.length - 1].y);

    // Test RDP simplification
    const rdp = simplifyRiverRDP(rawPoints, 0.8);
    expect(rdp.length).toBeLessThan(rawPoints.length);

    // Test merge close points
    const merged = mergeCloseRiverPoints(rawPoints, 2.5);
    expect(merged.length).toBeLessThan(rawPoints.length);
    expect(merged[0].x).toBe(rawPoints[0].x);
    expect(merged[merged.length - 1].x).toBe(rawPoints[rawPoints.length - 1].x);

    // Test full simplification pipeline across smoothing levels
    const smoothed0 = simplifyAndSmoothRiverPoints(rawPoints, 0);
    const smoothed2 = simplifyAndSmoothRiverPoints(rawPoints, 2);
    const smoothed4 = simplifyAndSmoothRiverPoints(rawPoints, 4);

    expect(smoothed0.length).toBeLessThanOrEqual(rawPoints.length);
    expect(smoothed2.length).toBeLessThan(rawPoints.length);
    expect(smoothed4.length).toBeLessThan(rawPoints.length);

    // Preserves source and mouth exactly
    expect(smoothed2[0].x).toBeCloseTo(rawPoints[0].x, 3);
    expect(smoothed2[0].y).toBeCloseTo(rawPoints[0].y, 3);
    expect(smoothed2[smoothed2.length - 1].x).toBeCloseTo(rawPoints[rawPoints.length - 1].x, 3);
    expect(smoothed2[smoothed2.length - 1].y).toBeCloseTo(rawPoints[rawPoints.length - 1].y, 3);

    // Check that alternating Z/S turn inflection oscillations are eliminated
    let rawInflections = 0;
    for (let i = 1; i < rawPoints.length - 2; i++) {
      const u = { x: rawPoints[i].x - rawPoints[i - 1].x, y: rawPoints[i].y - rawPoints[i - 1].y };
      const v = { x: rawPoints[i + 1].x - rawPoints[i].x, y: rawPoints[i + 1].y - rawPoints[i].y };
      const w = { x: rawPoints[i + 2].x - rawPoints[i + 1].x, y: rawPoints[i + 2].y - rawPoints[i + 1].y };
      const c1 = u.x * v.y - u.y * v.x;
      const c2 = v.x * w.y - v.y * w.x;
      if (c1 * c2 < 0) rawInflections++;
    }

    let smoothInflections = 0;
    for (let i = 1; i < smoothed2.length - 2; i++) {
      const u = { x: smoothed2[i].x - smoothed2[i - 1].x, y: smoothed2[i].y - smoothed2[i - 1].y };
      const v = { x: smoothed2[i + 1].x - smoothed2[i].x, y: smoothed2[i + 1].y - smoothed2[i].y };
      const w = { x: smoothed2[i + 2].x - smoothed2[i + 1].x, y: smoothed2[i + 2].y - smoothed2[i + 1].y };
      const c1 = u.x * v.y - u.y * v.x;
      const c2 = v.x * w.y - v.y * w.x;
      if (c1 * c2 < 0) smoothInflections++;
    }

    expect(rawInflections).toBeGreaterThan(5);
    expect(smoothInflections).toBeLessThan(rawInflections);
  });

  it('disables epicenters and generates a coastline-distance wave field', () => {
    const dem = makeMeanderingRiver(80, 80);
    // Mark bottom half as ocean
    dem.isOcean = new Uint8Array(80 * 80);
    for (let y = 40; y < 80; y++) {
      for (let x = 0; x < 80; x++) {
        dem.isOcean[y * 80 + x] = 1;
      }
    }

    const overlay = renderWaterOverlay(dem, {
      customEpicenters: [
        { id: 'disabled', normX: 0.5, normY: 0.75, strength: 2.0 },
      ],
      showOceanDetails: true,
      oceanRippleCount: 12,
    });

    expect(overlay.seedOrigins).toBeDefined();
    expect(overlay.seedOrigins?.length).toBe(0);

    // Verify the coastline-derived wave field exists, has non-zero amplitude,
    // and contains no destructive negative energy.
    expect(overlay.waveField).toBeDefined();
    let hasNonZeroWave = false;
    for (let i = 0; i < (overlay.waveField?.length ?? 0); i++) {
      expect(overlay.waveField![i]).toBeGreaterThanOrEqual(0);
      if (overlay.waveField![i] > 0.01) {
        hasNonZeroWave = true;
        break;
      }
    }
    expect(hasNonZeroWave).toBe(true);
  });

  it('keeps ocean wave marks on the stroke where a shore normal lies along it', () => {
    // A wobble offset that folds the path leaves a point's normal (taken from
    // the unfolded path) nearly along the stroke; marks then streaked straight
    // across the sea, perpendicular to the wave.
    const size = 320;
    const markScale = 2;
    const cases: Array<[string, (i: number) => [number, number], boolean]> = [
      ['tilted normal', (i) => (i === 40 ? [Math.sqrt(1 - 0.05 ** 2), 0.05] : [0, 1]), false],
      ['zero normal', (i) => (i === 40 ? [0, 0] : [0, 1]), false],
      // A stalled sample: a zero-length segment has no direction to bound it.
      ['stalled sample', () => [1, 0], true],
    ];
    for (const [label, normalAt, stall] of cases) {
      const path: OceanWavePathPoint[] = Array.from({ length: 80 }, (_, i) => {
        const [shoreNormalX, shoreNormalY] = normalAt(i);
        const step = stall && i > 40 ? i - 1 : i;
        return { x: 140 + step * 0.45, y: 160, along: step * 0.45, shoreNormalX, shoreNormalY, coastDistance: 100 };
      });
      const total = size * size;
      const [alpha, tone, light, shadow, foam, ink] = Array.from({ length: 6 }, () => new Uint8Array(total));
      paintOceanWavePath(
        path, alpha, tone, light, shadow, foam, ink, new Uint8Array(total).fill(1),
        size, size, 777, markScale, markScale, 4.5, 1, 0, 0, 0, size,
      );
      for (const [name, field] of [['ridge', alpha], ['foam', foam], ['ink', ink]] as const) {
        let farthest = 0;
        for (let index = 0; index < total; index++) {
          if (field[index] > 20) farthest = Math.max(farthest, Math.abs(Math.floor(index / size) - 160));
        }
        expect(farthest, `${label} ${name}`).toBeLessThanOrEqual(3 * markScale);
      }
    }
  });


});

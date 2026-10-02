import { describe, expect, it } from 'vitest';
import { processMountainBaseDEM, type MountainDEMData } from '../src/terrain/mountainBaseDEM';
import {
  getCameraBandTextureTileKeys,
  processFullTerrainCameraBandWithinTextureBudget,
  prepareFullTerrainCameraBand,
  prepareFullTerrainCameraProjection,
  renderFullTerrainCameraBand,
  renderFullTerrainCamera,
  renderFullTerrainOrthographicCamera,
} from '../src/rendering/fullTerrainCameraRenderer';
import {
  createMountainRenderStageCache,
  renderMountainDetailDEM,
  renderMountainDetailDEMWithCache,
} from '../src/rendering/mountainDetailRenderer';

function makeDem(width = 24, height = 24): MountainDEMData {
  const raw = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ridge = Math.exp(-(((x - width * 0.5) / (width * 0.2)) ** 2));
    raw[y * width + x] = 0.14 + ridge * (0.65 + 0.12 * Math.cos(y / 4));
  }
  const dem = processMountainBaseDEM(raw, width, height, {
    domainWidthKm: 4,
    domainHeightKm: 4,
    minElevationM: 300,
    maxElevationM: 3200,
    riverThresholdKm2: 100,
  });
  dem.isOcean.fill(0);
  dem.isRiverChannel.fill(0);
  dem.visualWaterMask?.fill(0);
  return dem;
}

function sourceImage(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    data[index] = x * 8;
    data[index + 1] = y * 8;
    data[index + 2] = 80;
    data[index + 3] = 255;
  }
  return { width, height, data } as unknown as ImageData;
}

describe('full terrain orthographic camera', () => {
  it('reuses prepared ridge strokes without changing split camera bands', () => {
    const dem = makeDem(12, 8);
    const source = sourceImage(46, 256);
    const ridgePaths = [
      {
        kind: 'ridge' as const,
        key: 17,
        width: 1.4,
        opacity: 0.8,
        primary: true,
        points: [{ x: 0, y: 0 }, { x: 5, y: 2.5 }, { x: 11, y: 7 }],
      },
      {
        kind: 'ridge' as const,
        key: 29,
        width: 1.1,
        opacity: 0.7,
        primary: true,
        points: [{ x: 0, y: 7 }, { x: 6, y: 4 }, { x: 11, y: 0 }],
      },
    ];
    const settings = {
      cameraType: 'orthographic' as const,
      elevationDeg: 65,
      heightExaggeration: 1,
      outputWidth: source.width,
      outputHeight: source.height,
      ridgePaths,
      ridgeColor: '#2b3842',
      ridgeThicknessScale: 0.75,
      charcoalRidges: true,
    };
    const projection = prepareFullTerrainCameraProjection(dem, settings);
    const full = renderFullTerrainCamera(dem, source, { ...settings, projection });
    const stitched = new Uint8ClampedArray(full.data.length);
    for (let y = 0; y < source.height; y += 64) {
      const band = renderFullTerrainCameraBand(dem, source, y, Math.min(source.height, y + 64), {
        ...settings,
        projection,
      });
      stitched.set(band.data, y * source.width * 4);
    }
    expect(stitched).toEqual(full.data);
  });

  it('renders the same pixels inside a column-clipped region preview', () => {
    const dem = makeDem(12, 8);
    const source = sourceImage(46, 96);
    const settings = {
      cameraType: 'orthographic' as const,
      elevationDeg: 65,
      outputWidth: source.width,
      outputHeight: source.height,
    };
    const projection = prepareFullTerrainCameraProjection(dem, settings);
    const full = renderFullTerrainCamera(dem, source, { ...settings, projection });
    const [rowStart, rowEnd, colStart, colEnd] = [20, 70, 13, 31];
    const clipped = renderFullTerrainCameraBand(dem, source, rowStart, rowEnd, {
      ...settings,
      projection,
      colStart,
      colEnd,
    });
    for (let y = rowStart; y < rowEnd; y++) {
      const fullRow = full.data.subarray((y * source.width + colStart) * 4, (y * source.width + colEnd) * 4);
      const clippedRow = clipped.data.subarray(
        ((y - rowStart) * source.width + colStart) * 4,
        ((y - rowStart) * source.width + colEnd) * 4,
      );
      expect(clippedRow).toEqual(fullRow);
    }
  });

  it('does not drop the last row of a band when a mesh block starts inside it', () => {
    // Flat terrain puts every mesh-block edge on one output row; single-row
    // bands make each band end on some block's fractional start.
    const dem = makeDem(8, 100);
    dem.elevation.fill(500);
    const source = sourceImage(40, 700);
    const settings = {
      cameraType: 'orthographic' as const,
      elevationDeg: 75,
      outputWidth: source.width,
      outputHeight: source.height,
    };
    const projection = prepareFullTerrainCameraProjection(dem, settings);
    const full = renderFullTerrainCamera(dem, source, { ...settings, projection });
    const stitched = new Uint8ClampedArray(full.data.length);
    for (let y = 0; y < source.height; y++) {
      const band = renderFullTerrainCameraBand(dem, source, y, y + 1, { ...settings, projection });
      stitched.set(band.data, y * source.width * 4);
    }
    expect(stitched).toEqual(full.data);
  });

  it('composites the transparent foreground prop source after camera ridge ink', () => {
    const dem = makeDem(12, 8);
    const source = sourceImage(46, 64);
    const foregroundData = new Uint8ClampedArray(source.width * source.height * 4);
    for (let index = 0; index < source.width * source.height; index++) {
      foregroundData[index * 4] = 16;
      foregroundData[index * 4 + 1] = 220;
      foregroundData[index * 4 + 2] = 44;
      foregroundData[index * 4 + 3] = 255;
    }
    const foreground = { width: source.width, height: source.height, data: foregroundData } as unknown as ImageData;
    const ridgePaths = [{
      kind: 'ridge' as const,
      key: 17,
      width: 1.4,
      opacity: 0.8,
      primary: true,
      points: [{ x: 0, y: 0 }, { x: 5, y: 2.5 }, { x: 11, y: 7 }],
    }];
    const settings = {
      cameraType: 'orthographic' as const,
      elevationDeg: 65,
      heightExaggeration: 1,
      outputWidth: source.width,
      outputHeight: source.height,
      ridgePaths,
      ridgeColor: '#2b3842',
      ridgeThicknessScale: 0.75,
      charcoalRidges: true,
      foregroundSource: foreground,
    };
    const projected = renderFullTerrainCamera(dem, source, settings);
    let foregroundPixels = 0;
    for (let index = 0; index < projected.data.length; index += 4) {
      if (
        projected.data[index] === 16 &&
        projected.data[index + 1] === 220 &&
        projected.data[index + 2] === 44
      ) foregroundPixels++;
    }
    expect(foregroundPixels).toBeGreaterThan(0);

    const projection = prepareFullTerrainCameraProjection(dem, settings);
    const band = renderFullTerrainCameraBand(dem, source, 0, source.height, {
      ...settings,
      projection,
    });
    expect(band.data).toEqual(projected.data);
    const plan = prepareFullTerrainCameraBand(dem, 0, source.height, {
      ...settings,
      projection,
    });
    expect(plan.finish(source).data).toEqual(projected.data);
  });

  it('finishes prepared orthographic and perspective bands from only the visible texture tiles', () => {
    const dem = makeDem(24, 24);
    const source = sourceImage(64, 128);
    const rowStart = 24;
    const rowEnd = 104;
    const tileSize = 16;
    const ridgePaths = [{
      kind: 'ridge' as const,
      key: 41,
      width: 1.5,
      opacity: 0.8,
      primary: true,
      points: [{ x: 1, y: 2 }, { x: 12, y: 11 }, { x: 22, y: 21 }],
    }];

    for (const cameraType of ['orthographic', 'perspective'] as const) {
      const settings = {
        cameraType,
        elevationDeg: 61,
        heightExaggeration: 1.2,
        outputWidth: source.width,
        outputHeight: source.height,
        ridgePaths,
        ridgeColor: '#263640',
        ridgeThicknessScale: 0.75,
        charcoalRidges: true,
      };
      const projection = prepareFullTerrainCameraProjection(dem, settings);
      const direct = renderFullTerrainCameraBand(dem, source, rowStart, rowEnd, {
        ...settings,
        projection,
      });
      const plan = prepareFullTerrainCameraBand(dem, rowStart, rowEnd, {
        ...settings,
        projection,
      });
      const keys = getCameraBandTextureTileKeys(plan, source.width, source.height, tileSize);
      const keySet = new Set(keys);
      const tiles = new Map<string, ImageData>();
      for (const key of keys) {
        const [tileX, tileY] = key.split(',').map(Number);
        const width = Math.min(tileSize, source.width - tileX);
        const height = Math.min(tileSize, source.height - tileY);
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
          const sourceOffset = ((tileY + y) * source.width + tileX) * 4;
          data.set(source.data.subarray(sourceOffset, sourceOffset + width * 4), y * width * 4);
        }
        tiles.set(key, { width, height, data } as unknown as ImageData);
      }
      let sampledAcrossTileBoundary = false;
      const tiledSource = {
        width: source.width,
        height: source.height,
        sampleRGBA(x: number, y: number, output: Uint8ClampedArray, offset: number): void {
          const clampedX = Math.max(0, Math.min(source.width - 1, x));
          const clampedY = Math.max(0, Math.min(source.height - 1, y));
          const x0 = Math.floor(clampedX);
          const y0 = Math.floor(clampedY);
          const x1 = Math.min(source.width - 1, x0 + 1);
          const y1 = Math.min(source.height - 1, y0 + 1);
          const origins = [
            [Math.floor(x0 / tileSize) * tileSize, Math.floor(y0 / tileSize) * tileSize],
            [Math.floor(x1 / tileSize) * tileSize, Math.floor(y0 / tileSize) * tileSize],
            [Math.floor(x0 / tileSize) * tileSize, Math.floor(y1 / tileSize) * tileSize],
            [Math.floor(x1 / tileSize) * tileSize, Math.floor(y1 / tileSize) * tileSize],
          ] as const;
          for (const [tileX, tileY] of origins) {
            const key = `${tileX},${tileY}`;
            if (!keySet.has(key)) throw new Error(`Missing visible camera texture tile ${key}`);
          }
          if (origins.some(([tileX, tileY]) => tileX !== origins[0][0] || tileY !== origins[0][1])) {
            sampledAcrossTileBoundary = true;
          }
          const samples = origins.map(([tileX, tileY], index) => {
            const tile = tiles.get(`${tileX},${tileY}`);
            if (!tile) throw new Error(`Missing rendered camera texture tile ${tileX},${tileY}`);
            const px = index % 2 === 0 ? x0 : x1;
            const py = index < 2 ? y0 : y1;
            return tile!.data.subarray(((py - tileY) * tile!.width + px - tileX) * 4,
              ((py - tileY) * tile!.width + px - tileX) * 4 + 4);
          });
          const tx = clampedX - x0;
          const ty = clampedY - y0;
          for (let channel = 0; channel < 4; channel++) {
            const top = samples[0][channel] * (1 - tx) + samples[1][channel] * tx;
            const bottom = samples[2][channel] * (1 - tx) + samples[3][channel] * tx;
            output[offset + channel] = Math.round(top * (1 - ty) + bottom * ty);
          }
        },
      };
      const deferred = plan.finish(tiledSource);
      expect(deferred.data).toEqual(direct.data);
      expect(sampledAcrossTileBoundary).toBe(true);
    }
  });

  it('subdivides camera bands until every pinned texture working set fits the cache budget', async () => {
    const dem = makeDem(24, 24);
    const source = sourceImage(256, 128);
    const tileSize = 16;
    const budget = 40 * 1024;
    const settings = {
      cameraType: 'orthographic' as const,
      elevationDeg: 58,
      heightExaggeration: 1,
      outputWidth: source.width,
      outputHeight: source.height,
    };
    const projection = prepareFullTerrainCameraProjection(dem, settings);
    const direct = renderFullTerrainCameraBand(dem, source, 0, source.height, {
      ...settings,
      projection,
    });
    const assembled = new Uint8ClampedArray(direct.data.length);
    const regions: Array<{ rowStart: number; rowEnd: number; workingSetBytes: number }> = [];
    const count = await processFullTerrainCameraBandWithinTextureBudget(
      dem,
      0,
      source.height,
      { ...settings, projection },
      tileSize,
      budget,
      async (plan, _tileKeys, workingSetBytes) => {
        regions.push({ rowStart: plan.rowStart, rowEnd: plan.rowStart + plan.height, workingSetBytes });
        const image = plan.finish(source);
        assembled.set(image.data, plan.rowStart * source.width * 4);
      },
    );
    expect(count).toBeGreaterThan(1);
    expect(regions).toHaveLength(count);
    expect(regions.every(region => region.workingSetBytes <= budget)).toBe(true);
    expect(regions[0].rowStart).toBe(0);
    expect(regions.at(-1)?.rowEnd).toBe(source.height);
    expect(assembled).toEqual(direct.data);
  });

  it('reprojects the complete raster with finite pixels and preserves the source', () => {
    const dem = makeDem();
    const source = sourceImage(dem.width, dem.height);
    const original = source.data.slice();
    const output = renderFullTerrainOrthographicCamera(dem, source, {
      elevationDeg: 75,
      heightExaggeration: 1,
    });

    expect(output.width).toBe(source.width);
    expect(output.height).toBe(source.height);
    expect(output.data.length).toBe(source.data.length);
    expect(Array.from(source.data)).toEqual(Array.from(original));
    expect(Array.from(output.data).every(Number.isFinite)).toBe(true);
    expect(output.data.some((value, index) => value !== source.data[index])).toBe(true);
  });

  it('keeps the projected result deterministic across camera height settings', () => {
    const dem = makeDem(18, 18);
    const source = sourceImage(dem.width, dem.height);
    const first = renderFullTerrainOrthographicCamera(dem, source, {
      elevationDeg: 75,
      heightExaggeration: 1.25,
    });
    const second = renderFullTerrainOrthographicCamera(dem, source, {
      elevationDeg: 75,
      heightExaggeration: 1.25,
    });
    const exaggerated = renderFullTerrainOrthographicCamera(dem, source, {
      elevationDeg: 75,
      heightExaggeration: 2,
    });
    expect(Array.from(first.data)).toEqual(Array.from(second.data));
    expect(Array.from(exaggerated.data)).not.toEqual(Array.from(first.data));
  });

  it('supports a true perspective camera with finite, depth-tested output', () => {
    const dem = makeDem(24, 24);
    const source = sourceImage(dem.width, dem.height);
    const perspective = renderFullTerrainCamera(dem, source, {
      cameraType: 'perspective',
      elevationDeg: 75,
      fieldOfViewDeg: 35,
      heightExaggeration: 1,
    });
    const orthographic = renderFullTerrainOrthographicCamera(dem, source, {
      elevationDeg: 75,
      heightExaggeration: 1,
    });
    expect(Array.from(perspective.data).every(Number.isFinite)).toBe(true);
    expect(Array.from(perspective.data)).not.toEqual(Array.from(orthographic.data));
  });

  it('projects an analysis mesh into an independently sized compositor texture', () => {
    const dem = makeDem(12, 8);
    const source = sourceImage(30, 22);
    const output = renderFullTerrainCamera(dem, source, {
      cameraType: 'orthographic',
      elevationDeg: 75,
      outputWidth: 46,
      outputHeight: 34,
    });

    expect(output.width).toBe(46);
    expect(output.height).toBe(34);
    expect(output.data.length).toBe(46 * 34 * 4);
    expect(Array.from(output.data).every(Number.isFinite)).toBe(true);
    expect(output.data.some((value, index) => value !== 247 && index % 4 === 0)).toBe(true);
  });

  it('applies the camera after the complete terrain compositor', () => {
    const dem = makeDem(20, 20);
    const options = {
      layer: 'swiss_relief' as const,
      palette: 'swiss_topo' as const,
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 1,
      ambientOcclusionStrength: 0.35,
      showRivers: false,
      riverThresholdKm2: 100,
      showWaterDetails: false,
      showContours: false,
      contourIntervalM: 100,
      fullTerrainCameraElevationDeg: 75,
      fullTerrainCameraHeightExaggeration: 1,
      fullTerrainCameraRenderStyle: 'study',
    };
    const flat = renderMountainDetailDEM(dem, {
      ...options,
      fullTerrainCameraElevationDeg: undefined,
      fullTerrainCameraHeightExaggeration: undefined,
    });
    const camera = renderMountainDetailDEM(dem, options);
    const compositor = renderMountainDetailDEM(dem, {
      ...options,
      fullTerrainCameraRenderStyle: 'compositor' as const,
    });
    expect(camera.width).toBe(flat.width);
    expect(camera.height).toBe(flat.height);
    expect(Array.from(camera.data)).not.toEqual(Array.from(flat.data));
    expect(Array.from(camera.data)).toEqual(Array.from(compositor.data));
  });

  it('carries ridge, hatch, and 100-step snow passes through the full map', () => {
    const dem = makeDem(96, 96);
    const cache = createMountainRenderStageCache();
    renderMountainDetailDEMWithCache(dem, {
      layer: 'vegetation_patterns',
      palette: 'swiss_topo',
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 3.8,
      ambientOcclusionStrength: 0.45,
      showRivers: false,
      riverThresholdKm2: 100,
      showWaterDetails: false,
      showContours: false,
      contourIntervalM: 100,
      fullTerrainCameraElevationDeg: 75,
      fullTerrainCameraHeightExaggeration: 1,
      snowRedistributionSteps: 100,
      vegetation: {
        seed: 23817,
        density: 1,
        strokeThickness: 1,
        strokeOpacity: 0.72,
      },
    }, cache);

    expect(cache.mountainPattern).toBeDefined();
    expect(cache.mountainIllustration).toBeDefined();
    expect(cache.mountainPattern!.snow.some(value => value > 0)).toBe(true);
    expect(cache.mountainIllustration!.charcoalAlpha.some(value => value > 0)).toBe(true);
    expect(cache.mountainIllustration!.snowCoverageAlpha.some(value => value > 0)).toBe(true);
  });

  it('applies hatch palette and opacity controls after the camera texture pass', () => {
    const dem = makeDem(64, 64);
    const options = {
      layer: 'swiss_relief' as const,
      palette: 'swiss_topo' as const,
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 1,
      ambientOcclusionStrength: 0.35,
      showRivers: false,
      riverThresholdKm2: 100,
      showWaterDetails: false,
      showContours: false,
      contourIntervalM: 100,
      fullTerrainCameraElevationDeg: 75,
      fullTerrainCameraHeightExaggeration: 1,
      mountainRidgeColor: '#2b3842',
    };
    const colored = renderMountainDetailDEM(dem, {
      ...options,
      mountainHatchColor: '#ff0000',
      mountainHatchOpacity: 1,
    });
    const hidden = renderMountainDetailDEM(dem, {
      ...options,
      mountainHatchColor: '#00ff00',
      mountainHatchOpacity: 0,
    });

    expect(Array.from(colored.data)).not.toEqual(Array.from(hidden.data));
  });

  it('keeps camera geometry stable between cached and uncached composition', () => {
    const dem = makeDem(40, 32);
    const options = {
      layer: 'swiss_relief' as const,
      palette: 'swiss_topo' as const,
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 1.4,
      ambientOcclusionStrength: 0.35,
      showRivers: false,
      riverThresholdKm2: 100,
      showWaterDetails: false,
      showContours: false,
      contourIntervalM: 100,
      fullTerrainCameraElevationDeg: 75,
      fullTerrainCameraHeightExaggeration: 1,
      fullTerrainCameraType: 'orthographic' as const,
    };
    const uncached = renderMountainDetailDEM(dem, options);
    const cache = createMountainRenderStageCache();
    const cached = renderMountainDetailDEMWithCache(dem, options, cache);
    expect(Array.from(cached.data)).toEqual(Array.from(uncached.data));
  });
});

import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processMountainBaseDEM, type MountainDEMData } from '../src/terrain/mountainBaseDEM';
import { joinMountainChains, renderMountainPatternOverlay, renderMountainPatternShadow } from '../src/rendering/mountainPatternRenderer';
import { createMountainRenderStageCache, getMountainPatternOptions, renderMountainDetailDEMWithCache, type MountainRenderOptions } from '../src/rendering/mountainDetailRenderer';
import { encodeRgbaPngRows } from '../src/utils/pngEncoding';
import { renderMountainIllustration, fractureMountainPath, connectMountainCrests, type MountainIllustrationOptions } from '../src/rendering/mountainIllustrationRenderer';

const illustrationOptions: MountainIllustrationOptions = {
  scale: 1, sunAzimuthDeg: 315, sunAltitudeDeg: 45, inkColor: [65, 62, 49],
  strokeThickness: 1, strokeOpacity: 0.8, offsetX: 0, offsetY: 0, stride: 96, seed: 23817,
};

function mountain(width = 96, height = 80): MountainDEMData {
  const raw = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ridge = width * (0.5 + 0.12 * Math.sin(y / height * 6));
      raw[y * width + x] = 0.15 + 0.75 * Math.exp(-(((x - ridge) / (width * 0.19)) ** 2))
        * (0.8 + 0.2 * Math.cos(y / height * 12));
    }
  }
  const dem = processMountainBaseDEM(raw, width, height, {
    domainWidthKm: 3, domainHeightKm: 3 * height / width, minElevationM: 400, maxElevationM: 3800, riverThresholdKm2: 100,
  });
  dem.biomeType.fill(1);
  dem.isRiverChannel.fill(0);
  dem.visualWaterMask?.fill(0);
  return dem;
}

const options: MountainRenderOptions = {
  layer: 'vegetation_patterns', palette: 'swiss_topo', sunAzimuthDeg: 315,
  sunAltitudeDeg: 45, verticalExaggeration: 3.5, ambientOcclusionStrength: 0.35,
  showRivers: false, riverThresholdKm2: 100, showWaterDetails: false,
  showContours: false, contourIntervalM: 100,
};

describe('mountain cartographic patterns', () => {
  it('joins a large export chain set without overflowing the argument stack', () => {
    const chains = Array.from({ length: 130_000 }, (_, index) => {
      const base = Math.floor(index / 2) * 10 + (index % 2 === 0 ? 0 : 1.75);
      return [
        { x: base, y: 0 },
        { x: base + 1, y: 0 },
      ];
    });

    expect(() => joinMountainChains(chains, 1.5)).not.toThrow();
  });

  it('keeps neutral linework settings byte-identical to the legacy pattern', () => {
    const dem = mountain(160, 200);
    const legacy = renderMountainPatternOverlay(dem);
    const neutral = renderMountainPatternOverlay(dem, {
      hatchDensity: 1,
      hatchThickness: 1,
      ridgeDensity: 1,
      ridgeThickness: 0.75,
    });
    expect(neutral.coverage).toEqual(legacy.coverage);
    expect(neutral.ink).toEqual(legacy.ink);
    expect(neutral.snow).toEqual(legacy.snow);
    expect(neutral.paths).toEqual(legacy.paths);
  });

  it('keeps automatic local detail at a 1x floor and honors its controls', () => {
    const dem = mountain(160, 200);
    dem.biomeType.fill(4);
    const defaultPattern = renderMountainPatternOverlay(dem);
    expect(defaultPattern.detailDensity).toBeDefined();
    expect(defaultPattern.detailDensity!.every(value => value >= 1)).toBe(true);
    expect(Math.max(...defaultPattern.detailDensity!)).toBeGreaterThan(1);

    const baseline = renderMountainPatternOverlay(dem, {
      localDetailDensityMax: 1,
      foothillDetailMultiplier: 2.5,
      biomeDetailMultiplier: 2,
    });
    expect(baseline.detailDensity!.every(value => value === 1)).toBe(true);

    const capped = renderMountainPatternOverlay(dem, { localDetailDensityMax: 1.2 });
    expect(Math.max(...capped.detailDensity!)).toBeLessThanOrEqual(1.200001);
  });

  it('separates hatch density from primary ridges', () => {
    const dem = mountain(160, 200);
    const sparse = renderMountainPatternOverlay(dem, { hatchDensity: 0 });
    expect(sparse.paths!.some(path => path.kind === 'ridge')).toBe(true);
    expect(sparse.paths!.some(path => path.kind === 'charcoal')).toBe(false);
    expect(sparse.ink.some(value => value > 0)).toBe(true);
  });

  it('keeps horizontal contour alpha when the vertical family is disabled', () => {
    const dem = mountain(160, 200);
    dem.temperatureC.fill(12);
    const pattern = renderMountainPatternOverlay(dem, {
      hatchDensity: 1,
      horizontalHatchOpacity: 1,
      verticalHatchOpacity: 0,
    });
    expect(pattern.paths!.some(path => path.kind === 'contour')).toBe(true);
    const illustration = renderMountainIllustration(dem, pattern,
      renderMountainPatternShadow(pattern, dem.width, dem.height, 315),
      { ...illustrationOptions, horizontalHatchOpacity: 1, verticalHatchOpacity: 0 });
    expect(illustration.horizontalHatchAlpha?.some(value => value > 0)).toBe(true);
  });

  it('keeps hatch path opacity independent of terrain angle', () => {
    const dem = mountain(160, 200);
    dem.temperatureC.fill(12);
    const pattern = renderMountainPatternOverlay(dem, {
      hatchDensity: 1,
      horizontalHatchOpacity: 0.42,
      verticalHatchOpacity: 0.73,
    });
    const contours = pattern.paths!.filter(path => path.kind === 'contour');
    const verticalHatches = pattern.paths!.filter(path => path.kind === 'charcoal' && path.parentKey === undefined);
    expect(contours.length).toBeGreaterThan(0);
    expect(verticalHatches.length).toBeGreaterThan(0);
    expect(contours.every(path => Math.abs(path.opacity - 0.42) < 1e-6)).toBe(true);
    expect(verticalHatches.every(path => Math.abs(path.opacity - 0.73) < 1e-6)).toBe(true);
  });

  it('keeps hatching on montane broadleaf woodland faces', () => {
    const dem = mountain(160, 200);
    dem.biomeType.fill(4);
    dem.temperatureC.fill(12);
    const pattern = renderMountainPatternOverlay(dem, {
      hatchDensity: 1,
      horizontalHatchOpacity: 1,
      verticalHatchOpacity: 1,
    });
    expect(pattern.coverage.some(value => value > 0)).toBe(true);
    expect(pattern.paths!.some(path => path.kind === 'contour')).toBe(true);
    const illustration = renderMountainIllustration(dem, pattern,
      renderMountainPatternShadow(pattern, dem.width, dem.height, 315),
      { ...illustrationOptions, horizontalHatchOpacity: 1, verticalHatchOpacity: 1 });
    expect(illustration.horizontalHatchAlpha?.some(value => value > 0)).toBe(true);
  });

  it('uses main ridge density for structural lines and keeps their pen separate', () => {
    const dem = mountain(160, 200);
    const sparse = renderMountainPatternOverlay(dem, { ridgeDensity: 0, hatchDensity: 1 });
    const normal = renderMountainPatternOverlay(dem, { ridgeDensity: 1, hatchDensity: 1 });
    const dense = renderMountainPatternOverlay(dem, { ridgeDensity: 6, hatchDensity: 1 });
    const sparseRidges = sparse.paths!.filter(path => path.kind === 'ridge');
    const normalRidges = normal.paths!.filter(path => path.kind === 'ridge');
    const denseRidges = dense.paths!.filter(path => path.kind === 'ridge');
    expect(sparseRidges).toHaveLength(0);
    expect(normalRidges.length).toBeGreaterThan(0);
    expect(denseRidges.length).toBeGreaterThanOrEqual(normalRidges.length);
    const topNormal = normalRidges.filter(path => path.points.some(point => point.y < 50)).length;
    const topDense = denseRidges.filter(path => path.points.some(point => point.y < 50)).length;
    expect(topDense).toBeGreaterThan(topNormal);
    const thin = renderMountainPatternOverlay(dem, {
      ridgeDensity: 1, hatchDensity: 1, ridgeThickness: 0.25, hatchThickness: 1,
    });
    const thick = renderMountainPatternOverlay(dem, {
      ridgeDensity: 1, hatchDensity: 1, ridgeThickness: 2, hatchThickness: 1,
    });
    expect(Math.max(...thick.paths!.filter(path => path.kind === 'ridge').map(path => path.width)))
      .toBeGreaterThan(Math.max(...thin.paths!.filter(path => path.kind === 'ridge').map(path => path.width)));
    const thinHatches = thin.paths!.filter(path => path.kind === 'charcoal').map(path => path.width);
    const thickHatches = thick.paths!.filter(path => path.kind === 'charcoal').map(path => path.width);
    expect(thickHatches).toEqual(thinHatches);
    const hatchDense = renderMountainPatternOverlay(dem, { ridgeDensity: 1, hatchDensity: 6 });
    expect(hatchDense.paths!.filter(path => path.kind === 'charcoal').length)
      .toBeGreaterThanOrEqual(thinHatches.length);
  });

  it('uses the linework scale consistently in path widths', () => {
    const dem = mountain(160, 200);
    const surface = { ...dem, dxMeters: 8000 / 1024, dyMeters: 8000 / 1024 };
    const base = renderMountainPatternOverlay(surface, getMountainPatternOptions(surface, {
      fullTerrainCameraElevationDeg: 75,
      mountainLineworkScale: 1,
    } as MountainRenderOptions));
    const enlarged = renderMountainPatternOverlay(surface, getMountainPatternOptions(surface, {
      fullTerrainCameraElevationDeg: 75,
      mountainLineworkScale: 1.5,
    } as MountainRenderOptions));
    const baseWidths = base.paths!.map(path => path.width);
    const enlargedWidths = enlarged.paths!.map(path => path.width);
    expect(enlargedWidths.length).toBeGreaterThan(0);
    expect(Math.max(...enlargedWidths)).toBeGreaterThan(Math.max(...baseWidths));
  });

  it('keeps simplified side paths on the terrain chain without synthetic offsets', () => {
    const path = Array.from({ length: 100 }, (_, y) => ({ x: 50, y: y + 20 }));
    const fractured = fractureMountainPath(path, 1, 0, 0, 23817);
    expect(fractured[0]).toEqual(path[0]);
    expect(fractured[fractured.length - 1]).toEqual(path[path.length - 1]);
    expect(fractured.every(p => p.x === 50)).toBe(true);
    expect(fractured.length).toBeLessThan(path.length);
    const local = fractureMountainPath(path.map(p => ({ x: p.x - 30, y: p.y - 10 })), 1, 30, 10, 23817);
    local.forEach((p, i) => {
      expect(p.x + 30).toBeCloseTo(fractured[i].x, 8);
      expect(p.y + 10).toBeCloseTo(fractured[i].y, 8);
    });
  });

  it('joins facing crest ends without joining parallel neighbouring ridges', () => {
    const paths = [[{ x: 0, y: 10 }, { x: 20, y: 10 }],
      [{ x: 27, y: 10 }, { x: 50, y: 10 }],
      [{ x: 0, y: 14 }, { x: 20, y: 14 }]];
    expect(connectMountainCrests(paths, 1)).toEqual([[paths[0][1], paths[1][0]]]);
  });
  it('anchors projected faces on their own side of a river corridor', () => {
    const dem = mountain(96, 120);
    const riverY = 50;
    for (let x = 0; x < dem.width; x++) dem.isRiverChannel[riverY * dem.width + x] = 1;
    const pattern = renderMountainPatternOverlay(dem);
    const result = renderMountainIllustration(dem, pattern,
      renderMountainPatternShadow(pattern, dem.width, dem.height, 315), illustrationOptions);
    let visible = 0;
    for (let y = 0; y < riverY; y++) for (let x = 0; x < dem.width; x++) {
      const source = result.sourceY[y * dem.width + x];
      if (source >= 0) visible++;
      expect(source).toBeLessThan(riverY);
    }
    expect(visible).toBeGreaterThan(500);
  });

  it('joins secondary creases to their parent instead of copying parallel strokes', () => {
    const dem = mountain(160, 200);
    dem.slopeDeg.fill(25);
    for (let y = 0; y < dem.height; y++) for (let x = 0; x < dem.width; x++) {
      dem.elevation[y * dem.width + x] = 1000 + (x - 80) ** 2 * 0.4 + y * 4;
    }
    const paths = renderMountainPatternOverlay(dem).paths!;
    const branches = paths.filter(p => p.parentKey !== undefined);
    expect(branches.length).toBeGreaterThan(0);
    const primary = paths.filter(p => p.kind === 'charcoal' && p.parentKey === undefined);
    expect(new Set(primary.map(p => p.key)).size).toBe(primary.length);
    for (const branch of branches) {
      const parent = primary.find(p => p.key === branch.parentKey)!;
      expect(parent.points).toContain(branch.points[branch.points.length - 1]);
      expect(branch.width).toBeLessThan(parent.width);
    }
  });

  it('keeps raised rock off visible water in front of the mountain', () => {
    const dem = mountain();
    const pattern = renderMountainPatternOverlay(dem);
    for (let x = 0; x < dem.width; x++) dem.isRiverChannel[30 * dem.width + x] = 1;
    const result = renderMountainIllustration(dem, pattern,
      renderMountainPatternShadow(pattern, dem.width, dem.height, 315), illustrationOptions);
    for (let x = 0; x < dem.width; x++) {
      expect(result.rgba[(30 * dem.width + x) * 4 + 3]).toBe(0);
    }
  });

  it('updates cached illustrated mountain shading when hillshade strength reaches zero', () => {
    const dem = mountain();
    const cache = createMountainRenderStageCache();
    renderMountainDetailDEMWithCache(dem, { ...options, hillshadeStrength: 1 }, cache);
    const shaded = cache.mountainIllustration!;
    renderMountainDetailDEMWithCache(dem, { ...options, hillshadeStrength: 0 }, cache);
    const unshaded = cache.mountainIllustration!;
    expect(unshaded).not.toBe(shaded);
    expect(unshaded.materialRgba).not.toEqual(shaded.materialRgba);
    const pattern = renderMountainPatternOverlay(dem);
    const flat = renderMountainIllustration(dem, pattern,
      new Float32Array(dem.width * dem.height), {
        ...illustrationOptions, hillshadeStrength: 0, snowfallAmount: 0,
      });
    const colors = new Set<string>();
    for (let i = 0; i < flat.materialRgba.length; i += 4) {
      if (flat.materialRgba[i + 3] > 0) colors.add(Array.from(flat.materialRgba.subarray(i, i + 3)).join(','));
    }
    expect(colors.size).toBe(1);
  });

  it('keeps material pixels separate from composited mountain ink', () => {
    const dem = mountain();
    const pattern = renderMountainPatternOverlay(dem);
    const illustration = renderMountainIllustration(dem, pattern,
      renderMountainPatternShadow(pattern, dem.width, dem.height, 315), illustrationOptions);
    expect(illustration.materialRgba).not.toBe(illustration.rgba);
    const inkChangedPixel = illustration.silhouetteAlpha.findIndex((value, index) => {
      if (value === 0) return false;
      const offset = index * 4;
      return illustration.materialRgba[offset] !== illustration.rgba[offset]
        || illustration.materialRgba[offset + 1] !== illustration.rgba[offset + 1]
        || illustration.materialRgba[offset + 2] !== illustration.rgba[offset + 2];
    });
    expect(inkChangedPixel).toBeGreaterThanOrEqual(0);
  });

  it('keeps an unshadowed snowfield paper white rather than rock-tinted blue', () => {
    const dem = mountain();
    dem.elevation.fill(3000);
    dem.slopeDeg.fill(0);
    dem.temperatureC.fill(-10);
    const pattern = renderMountainPatternOverlay(dem);
    const result = renderMountainIllustration(dem, pattern,
      new Float32Array(dem.width * dem.height), illustrationOptions);
    const i = (40 * dem.width + 40) * 4;
    expect(result.rgba[i]).toBeGreaterThan(245);
    expect(result.rgba[i + 1]).toBeGreaterThan(245);
    expect(result.rgba[i + 2]).toBeGreaterThan(238);
  });

  it('draws long continuous downhill charcoal chains after projection', () => {
    const dem = mountain(160, 200);
    dem.temperatureC.fill(12);
    dem.slopeDeg.fill(25);
    for (let y = 0; y < dem.height; y++) for (let x = 0; x < dem.width; x++) {
      dem.elevation[y * dem.width + x] = 1000 + y * 4;
    }
    const pattern = renderMountainPatternOverlay(dem);
    const paths = pattern.paths!.filter(path => path.kind === 'charcoal');
    expect(paths.some(path => path.points.length > 80)).toBe(true);
    for (const path of paths) {
      for (let i = 1; i < path.points.length; i++) expect(path.points[i].y).toBeLessThan(path.points[i - 1].y);
    }
    const illustration = renderMountainIllustration(dem, pattern,
      renderMountainPatternShadow(pattern, dem.width, dem.height, 315), { ...illustrationOptions, stride: dem.width });
    const longest = illustration.charcoalPaths.reduce((a, b) => a.length > b.length ? a : b, []);
    expect(longest.length).toBeGreaterThan(80);
    const middle = longest.slice(10, -10);
    const painted = middle.filter(p => {
      for (let dx = -5; dx <= 5; dx++) {
        const x = Math.round(p.x) + dx;
        if (x >= 0 && x < dem.width && illustration.charcoalAlpha[Math.round(p.y) * dem.width + x] > 10) return true;
      }
      return false;
    });
    // Charcoal has deliberate dry interruptions along a continuous geometry.
    expect(painted.length / middle.length).toBeGreaterThan(0.65);
    expect(illustration.charcoalAlpha).not.toBe(illustration.silhouetteAlpha);
  });

  it('keeps visible face hatches joined at the small camera analysis scale', () => {
    const dem = mountain(160, 200);
    dem.temperatureC.fill(12);
    dem.slopeDeg.fill(25);
    for (let y = 0; y < dem.height; y++) for (let x = 0; x < dem.width; x++) {
      dem.elevation[y * dem.width + x] = 1000 + y * 4;
    }
    const pattern = renderMountainPatternOverlay(dem);
    const illustration = renderMountainIllustration(dem, pattern,
      renderMountainPatternShadow(pattern, dem.width, dem.height, 315),
      { ...illustrationOptions, scale: 0.25, stride: dem.width });
    const longest = illustration.charcoalPaths.reduce((a, b) => a.length > b.length ? a : b, []);
    expect(longest.length).toBeGreaterThan(80);
    const middle = longest.slice(10, -10);
    const painted = middle.filter(point => {
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.round(point.x) + dx;
        if (x >= 0 && x < dem.width
          && illustration.charcoalAlpha[Math.round(point.y) * dem.width + x] > 10) return true;
      }
      return false;
    });
    expect(painted.length / middle.length).toBeGreaterThan(0.65);
  });

  it('changes the grain-filtered wash without changing projected pen paths', () => {
    const dem = mountain();
    const pattern = renderMountainPatternOverlay(dem);
    const shadow = renderMountainPatternShadow(pattern, dem.width, dem.height, 315);
    const pale = renderMountainIllustration(dem, pattern, shadow,
      { ...illustrationOptions, washDarkStrength: 0.1, washNoiseStrength: 0 });
    const mottled = renderMountainIllustration(dem, pattern, shadow,
      { ...illustrationOptions, washDarkStrength: 0.7, washNoiseStrength: 1 });
    expect(mottled.rgba).not.toEqual(pale.rgba);
    expect(mottled.silhouetteAlpha).toEqual(pale.silhouetteAlpha);
    expect(mottled.charcoalAlpha).toEqual(pale.charcoalAlpha);
    expect(mottled.sourceY).toEqual(pale.sourceY);
  });
  it('raises mountain faces but leaves a flat surface at its source position', () => {
    const dem = mountain();
    const pattern = renderMountainPatternOverlay(dem);
    const shadow = renderMountainPatternShadow(pattern, dem.width, dem.height, 315);
    const illustration = renderMountainIllustration(dem, pattern, shadow, illustrationOptions);
    let raised = 0;
    for (let i = 0; i < illustration.sourceY.length; i++) {
      if (illustration.sourceY[i] > Math.floor(i / dem.width) + 5) raised++;
    }
    expect(raised).toBeGreaterThan(500);
    dem.elevation.fill(2000);
    const flat = renderMountainPatternOverlay(dem);
    const result = renderMountainIllustration(dem, flat, shadow, illustrationOptions);
    for (let y = 1; y < dem.height - 1; y++) {
      expect(result.sourceY[y * dem.width + 48]).toBe(y);
    }
    dem.biomeType.fill(4);
    const empty = renderMountainPatternOverlay(dem);
    expect(renderMountainIllustration(dem, empty, shadow, illustrationOptions).rgba.every(value => value === 0)).toBe(true);
  });

  it('keeps the projected surface identical across vertical export tile cuts', () => {
    const dem = mountain(96, 1480);
    const fullPattern = renderMountainPatternOverlay(dem);
    const full = renderMountainIllustration(dem, fullPattern,
      renderMountainPatternShadow(fullPattern, dem.width, dem.height, 315), illustrationOptions);
    const startY = 50, height = 1380;
    const crop = <T extends Float32Array | Uint8Array>(field: T): T => field.slice(startY * dem.width, (startY + height) * dem.width) as T;
    const tile = { ...dem, height, elevation: crop(dem.elevation),
      slopeDeg: crop(dem.slopeDeg), temperatureC: crop(dem.temperatureC),
      biomeType: crop(dem.biomeType), isOcean: crop(dem.isOcean), isRiverChannel: crop(dem.isRiverChannel),
      visualWaterMask: dem.visualWaterMask ? crop(dem.visualWaterMask) : undefined,
    };
    const pattern = renderMountainPatternOverlay(tile, { offsetY: startY });
    const actual = renderMountainIllustration(tile, pattern,
      renderMountainPatternShadow(pattern, tile.width, tile.height, 315), { ...illustrationOptions, offsetY: startY });
    for (let y = 672; y < height - 672; y++) {
      const expectedRow = full.rgba.subarray(((y + startY) * dem.width) * 4, ((y + startY + 1) * dem.width) * 4);
      expect(actual.rgba.subarray(y * dem.width * 4, (y + 1) * dem.width * 4)).toEqual(expectedRow);
    }
  });
  it('keeps warm flat rock clear and sheds snow from steep cold cliffs', () => {
    const dem = mountain();
    dem.elevation.fill(1800);
    dem.slopeDeg.fill(0);
    dem.temperatureC.fill(12);
    const warm = renderMountainPatternOverlay(dem);
    expect(warm.snow.some(value => value > 0)).toBe(false);
    expect(warm.ink.some(value => value > 0)).toBe(false);
    dem.temperatureC.fill(-10);
    const cold = renderMountainPatternOverlay(dem);
    expect(cold.snow.every(value => value > 0.9)).toBe(true);
    dem.slopeDeg.fill(70);
    expect(renderMountainPatternOverlay(dem).snow.every(value => value === 0)).toBe(true);
  });

  it('follows curved crests across ordinary land while excluding water', () => {
    const dem = mountain();
    for (let y = 0; y < dem.height; y++) {
      const crest = dem.width * (0.5 + 0.12 * Math.sin(y / dem.height * 6));
      for (let x = 0; x < dem.width; x++) dem.elevation[y * dem.width + x] = 3000 - (x - crest) ** 2;
    }
    dem.temperatureC.fill(12);
    const result = renderMountainPatternOverlay(dem);
    let hits = 0;
    for (let y = 8; y < dem.height - 8; y++) {
      const crest = Math.round(dem.width * (0.5 + 0.12 * Math.sin(y / dem.height * 6)));
      if ([-1, 0, 1].some(dx => result.ink[y * dem.width + crest + dx] > 50)) hits++;
    }
    expect(hits).toBeGreaterThan(35);
    for (let i = 0; i < dem.elevation.length; i++) {
      if (i % 3 === 0) dem.isOcean[i] = 1;
      if (i % 3 === 1) dem.biomeType[i] = 4;
      if (i % 3 === 2) dem.isRiverChannel[i] = 1;
    }
    const clipped = renderMountainPatternOverlay(dem);
    expect(clipped.coverage.some((value, i) => i % 3 === 1 && value > 0)).toBe(true);
    expect(clipped.ink.some((value, i) => i % 3 === 1 && value > 0)).toBe(true);
    expect(clipped.coverage.every((value, i) => i % 3 === 1 || value === 0)).toBe(true);
    expect(clipped.ink.every((value, i) => i % 3 === 1 || value === 0)).toBe(true);
    expect(clipped.snow.some(value => value > 0)).toBe(false);
  });

  it('matches a cropped tile with sufficient stroke and derivative support', () => {
    const dem = mountain(520, 100);
    const full = renderMountainPatternOverlay(dem);
    const x0 = 35, tileWidth = 450;
    function crop<T extends Float32Array | Uint8Array>(field: T): T {
      const result = field.slice(0, tileWidth * dem.height) as T;
      for (let y = 0; y < dem.height; y++) result.set(field.subarray(y * dem.width + x0, y * dem.width + x0 + tileWidth), y * tileWidth);
      return result;
    }
    const tile = { ...dem, width: tileWidth,
      elevation: crop(dem.elevation), slopeDeg: crop(dem.slopeDeg),
      temperatureC: crop(dem.temperatureC), biomeType: crop(dem.biomeType),
      isOcean: crop(dem.isOcean), isRiverChannel: crop(dem.isRiverChannel),
      visualWaterMask: dem.visualWaterMask ? crop(dem.visualWaterMask) : undefined,
    };
    const local = renderMountainPatternOverlay(tile, { offsetX: x0, stride: dem.width });
    const fullShadow = renderMountainPatternShadow(full, dem.width, dem.height, 315);
    const localShadow = renderMountainPatternShadow(local, tileWidth, dem.height, 315);
    for (let y = 5; y < dem.height - 5; y++) {
      // Long groups need their complete downhill trajectory and smoothing
      // neighbourhood. Exercise the same 176px support used by exports.
      for (let x = 176; x < tileWidth - 176; x++) {
        expect(local.ink[y * tileWidth + x]).toBe(full.ink[y * dem.width + x + x0]);
        expect(local.snow[y * tileWidth + x]).toBe(full.snow[y * dem.width + x + x0]);
        expect(local.wash[y * tileWidth + x]).toBe(full.wash[y * dem.width + x + x0]);
        expect(localShadow[y * tileWidth + x]).toBeCloseTo(fullShadow[y * dem.width + x + x0], 6);
      }
    }
  });

  it('casts a soft shadow away from the sun and clips it to mountain land', () => {
    const width = 21, height = 21;
    const overlay = { coverage: new Uint8Array(width * height).fill(255),
      ink: new Uint8Array(width * height), snow: new Float32Array(width * height),
      wash: new Float32Array(width * height) };
    overlay.ink[10 * width + 10] = 255;
    const eastSun = renderMountainPatternShadow(overlay, width, height, 90);
    const westSun = renderMountainPatternShadow(overlay, width, height, 270);
    expect(eastSun[10 * width + 8]).toBeGreaterThan(0.05);
    expect(eastSun[10 * width + 9]).toBeGreaterThan(0);
    expect(eastSun[10 * width + 12]).toBe(0);
    expect(westSun[10 * width + 12]).toBeCloseTo(eastSun[10 * width + 8]);
    overlay.coverage.fill(0);
    expect(renderMountainPatternShadow(overlay, width, height, 90).every(value => value === 0)).toBe(true);
  });

  it('suppresses pixel-scale relief speckles while retaining the main ridge', () => {
    const dem = mountain();
    dem.temperatureC.fill(12);
    dem.slopeDeg.fill(0);
    for (let y = 0; y < dem.height; y++) for (let x = 0; x < dem.width; x++) {
      dem.elevation[y * dem.width + x] = 2000 + ((x + y) % 2 ? 8 : -8);
    }
    const flat = renderMountainPatternOverlay(dem);
    expect(flat.ink.some(value => value > 0)).toBe(false);
    for (let y = 0; y < dem.height; y++) for (let x = 0; x < dem.width; x++) {
      dem.elevation[y * dem.width + x] -= (x - dem.width / 2) ** 2;
    }
    const ridge = renderMountainPatternOverlay(dem);
    let continuousRows = 0;
    for (let y = 10; y < dem.height - 10; y++) {
      if (ridge.ink[y * dem.width + dem.width / 2] > 40) continuousRows++;
    }
    expect(continuousRows).toBeGreaterThan(dem.height - 25);
  });

  it('keeps cold snowfields connected over rough ground and exposes broad cliffs', () => {
    const dem = mountain();
    dem.biomeType.fill(0);
    dem.temperatureC.fill(-8);
    dem.elevation.fill(3000);
    for (let y = 0; y < dem.height; y++) for (let x = 0; x < dem.width; x++) {
      dem.slopeDeg[y * dem.width + x] = x > 60 ? 75 : (x + y) % 2 ? 50 : 15;
    }
    const overlay = renderMountainPatternOverlay(dem);
    for (let y = 10; y < dem.height - 10; y++) {
      for (let x = 10; x < 50; x++) {
        expect(overlay.snow[y * dem.width + x]).toBeGreaterThan(0.95);
        expect(overlay.ink[y * dem.width + x]).toBe(0);
      }
      expect(overlay.snow[y * dem.width + 80]).toBe(0);
    }
  });

  it('disables both directional shading and ambient occlusion at zero hillshade strength', () => {
    const dem = mountain();
    const settings: MountainRenderOptions = {
      ...options, layer: 'swiss_relief', hillshadeStrength: 0, ambientOcclusionStrength: 1,
    };
    dem.hillshade.fill(0.25);
    dem.ambientOcclusion.fill(0.2);
    const unshaded = renderMountainDetailDEMWithCache(dem, settings);
    const shaded = renderMountainDetailDEMWithCache(dem, { ...settings, hillshadeStrength: 1 });
    dem.hillshade.fill(1);
    dem.ambientOcclusion.fill(1);
    const fullyLit = renderMountainDetailDEMWithCache(dem, { ...settings, hillshadeStrength: 1 });
    expect(unshaded.data).toEqual(fullyLit.data);
    expect(shaded.data).not.toEqual(unshaded.data);
  });

  it('keeps the watercolor wash when outline ink is disabled', () => {
    const dem = mountain();
    const painted = renderMountainPatternOverlay(dem);
    const noInk = renderMountainPatternOverlay(dem, { strokeOpacity: 0 });
    expect(noInk.ink.every(value => value === 0)).toBe(true);
    expect(noInk.wash).toEqual(painted.wash);
    expect(Math.max(...noInk.wash) - Math.min(...noInk.wash)).toBeGreaterThan(0.4);
  });

  it('blends broad land-biome color transitions while keeping snow edges crisp', async () => {
    const dem = mountain();
    dem.biomeRegionScaleKm = 0.8;
    dem.biomeType.fill(3);
    for (let y = 0; y < dem.height; y++) {
      for (let x = 48; x < dem.width; x++) dem.biomeType[y * dem.width + x] = 4;
      for (let x = 75; x < dem.width; x++) dem.biomeType[y * dem.width + x] = 0;
    }
    dem.isOcean.fill(0);
    dem.isRiverChannel.fill(0);
    dem.hillshade.fill(1);
    dem.ambientOcclusion.fill(0);
    const mountainIllustrationRGBA = new Uint8ClampedArray(dem.width * dem.height * 4);
    for (let y = 0; y < dem.height; y++) {
      for (let x = 42; x < 55; x++) {
        const offset = (y * dem.width + x) * 4;
        mountainIllustrationRGBA[offset] = 100;
        mountainIllustrationRGBA[offset + 1] = 100;
        mountainIllustrationRGBA[offset + 2] = 100;
        mountainIllustrationRGBA[offset + 3] = 255;
      }
    }
    const renderOptions: MountainRenderOptions = {
      ...options,
      ambientOcclusionStrength: 0,
      mountainHatchOpacity: 0,
      mountainIllustrationRGBA,
      vegetationBiomeTransitionStrength: 2,
      vegetationBiomeColors: {
        0: '#f0f0f0',
        3: '#205020',
        4: '#dcba78',
      },
      vegetation: {
        strokeOpacity: 0,
        flowWashStrength: 0,
        flowWashDarkStrength: 0,
        flowWashLightStrength: 0,
        flowWashNoiseStrength: 0,
        washShadowStrength: 0,
      },
    };
    const image = renderMountainDetailDEMWithCache(dem, renderOptions);
    const noTransitionImage = renderMountainDetailDEMWithCache(dem, {
      ...renderOptions,
      vegetationBiomeTransitionStrength: 0,
    });
    const pixel = (source: typeof image, x: number, y: number): [number, number, number] => {
      const offset = (y * source.width + x) * 4;
      return [source.data[offset], source.data[offset + 1], source.data[offset + 2]];
    };
    const interiorForest = pixel(image, 30, 40);
    const transition = pixel(image, 47, 40);
    const interiorWoodland = pixel(image, 64, 40);
    const noTransition = pixel(noTransitionImage, 47, 40);
    expect(transition[0]).toBeGreaterThan(interiorForest[0] + 20);
    expect(transition[0]).toBeLessThan(interiorWoodland[0] - 20);
    expect(Math.max(...transition.map((channel, index) => Math.abs(channel - noTransition[index]))))
      .toBeGreaterThan(20);
    expect(pixel(image, 74, 40)).toEqual(interiorWoodland);
    expect(pixel(image, 75, 40)).toEqual([240, 240, 240]);
    const wash = renderMountainDetailDEMWithCache(dem, {
      ...renderOptions,
      mountainIllustrationRGBA: undefined,
      skipMountainIllustrationStage: true,
    });
    const crossings: number[] = [];
    for (let y = 10; y < dem.height - 10; y++) {
      for (let x = 25; x < 65; x++) {
        if (pixel(wash, x, y)[0] >= 126) {
          crossings.push(x);
          break;
        }
      }
    }
    // A variable blur radius alone leaves this midpoint on a straight line.
    expect(Math.max(...crossings) - Math.min(...crossings)).toBeGreaterThan(2);
    if (process.env.ARTIFACTS_DIR) {
      const rowBytes = wash.width * 4 + 1;
      const rows = new Uint8Array(rowBytes * wash.height);
      for (let y = 0; y < wash.height; y++) {
        rows.set(wash.data.subarray(y * wash.width * 4, (y + 1) * wash.width * 4), y * rowBytes + 1);
      }
      mkdirSync(process.env.ARTIFACTS_DIR, { recursive: true });
      const png = await encodeRgbaPngRows(wash.width, wash.height, [rows]);
      writeFileSync(join(process.env.ARTIFACTS_DIR, 'biome-transition.png'), new Uint8Array(await png.arrayBuffer()));
    }
  });

  it('reuses geometry for lighting edits and renders an inspection artifact', async () => {
    const dem = mountain(320, 240);
    const cache = createMountainRenderStageCache();
    const image = renderMountainDetailDEMWithCache(dem, options, cache);
    const overlay = cache.mountainPattern;
    const originalShadow = cache.mountainShadow;
    const second = renderMountainDetailDEMWithCache(dem, { ...options, ambientOcclusionStrength: 0.7 }, cache);
    expect(cache.mountainPattern).toBe(overlay);
    expect(second.data).not.toEqual(image.data);
    expect(renderMountainDetailDEMWithCache(dem, options).data).toEqual(image.data);
    const originalIllustration = cache.mountainIllustration;
    renderMountainDetailDEMWithCache(dem, { ...options, vegetation: { flowWashNoiseStrength: 0.9 } }, cache);
    expect(cache.mountainPattern).toBe(overlay);
    expect(cache.mountainIllustration).not.toBe(originalIllustration);
    renderMountainDetailDEMWithCache(dem, { ...options, sunAzimuthDeg: 135 }, cache);
    expect(cache.mountainPattern).toBe(overlay);
    expect(cache.mountainShadow).not.toBe(originalShadow);
    renderMountainDetailDEMWithCache(dem, { ...options, waterOutlineThickness: 2 }, cache);
    expect(cache.mountainPattern).not.toBe(overlay);
    const directory = process.env.ARTIFACTS_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      const rowBytes = image.width * 4 + 1;
      const band = new Uint8Array(rowBytes * image.height);
      for (let y = 0; y < image.height; y++) {
        band.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * rowBytes + 1);
      }
      const png = await encodeRgbaPngRows(image.width, image.height, [band]);
      writeFileSync(join(directory, 'mountain-pattern.png'), new Uint8Array(await png.arrayBuffer()));
    }
  }, 15000);
});

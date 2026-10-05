import { describe, expect, it } from 'vitest';
import { processMountainBaseDEM, type MountainDEMData } from '../src/terrain/mountainBaseDEM';
import {
  createMountainRenderStageCache,
  renderMountainDetailDEMWithCache,
  type MountainRenderOptions,
} from '../src/rendering/mountainDetailRenderer';
import {
  MOUNTAIN_HEIGHT_EXAGGERATION_DEFAULT,
  MOUNTAIN_MAX_LIFT_PIXELS,
  MOUNTAIN_SNOW_REDISTRIBUTION_STEPS_DEFAULT,
  MOUNTAIN_VIEW_ANGLE_DEFAULT_DEG,
  mountainProjectionLift,
  mountainProjectionLiftCoefficient,
  mountainProjectionSupportPixels,
  normalizeMountainSnowfallSettings,
  MOUNTAIN_LINEWORK_SCALE_DEFAULT,
  MOUNTAIN_LINEWORK_OPACITY_DEFAULT,
  MOUNTAIN_HATCH_DENSITY_DEFAULT,
  MOUNTAIN_HATCH_OPACITY_DEFAULT,
  MOUNTAIN_HATCH_THICKNESS_DEFAULT,
  MOUNTAIN_RIDGE_DENSITY_DEFAULT,
  MOUNTAIN_RIDGE_THICKNESS_DEFAULT,
  MOUNTAIN_REFERENCE_PAPER_RGB,
  MOUNTAIN_REFERENCE_PAPER_RGBA,
  normalizeMountainLineworkSettings,
  normalizeMountainProjectionSettings,
} from '../src/rendering/mountainProjection';
import { renderMountainIllustration } from '../src/rendering/mountainIllustrationRenderer';
import { renderMountainPatternOverlay, renderMountainPatternShadow } from '../src/rendering/mountainPatternRenderer';
import { renderMountainExportTile } from '../src/rendering/mountainExportRenderer';

function makeDem(width = 96, height = 96): MountainDEMData {
  const raw = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw[y * width + x] = 0.16 + 0.68 * Math.exp(-(((x - 48) / 22) ** 2))
        * (0.82 + 0.18 * Math.cos(y / 12));
    }
  }
  const dem = processMountainBaseDEM(raw, width, height, {
    domainWidthKm: 3,
    domainHeightKm: 3,
    minElevationM: 400,
    maxElevationM: 3800,
    riverThresholdKm2: 100,
  });
  dem.biomeType.fill(1);
  dem.isRiverChannel.fill(0);
  dem.visualWaterMask?.fill(0);
  return dem;
}

const illustrationOptions = {
  scale: 1,
  sunAzimuthDeg: 315,
  sunAltitudeDeg: 45,
  inkColor: [65, 62, 49],
  strokeThickness: 1,
  strokeOpacity: 0.8,
  offsetX: 0,
  offsetY: 0,
  stride: 96,
  seed: 23817,
};

const renderOptions: MountainRenderOptions = {
  layer: 'vegetation_patterns',
  palette: 'swiss_topo',
  sunAzimuthDeg: 315,
  sunAltitudeDeg: 45,
  verticalExaggeration: 3.5,
  ambientOcclusionStrength: 0.35,
  showRivers: false,
  riverThresholdKm2: 100,
  showWaterDetails: false,
  showContours: false,
  contourIntervalM: 100,
  vegetation: { seed: 23817 },
};

describe('selective mountain projection', () => {
  it('keeps the supplied reference paper substrate', () => {
    expect(MOUNTAIN_REFERENCE_PAPER_RGB).toEqual([247, 244, 232]);
    expect(MOUNTAIN_REFERENCE_PAPER_RGBA).toEqual([247, 244, 232, 255]);
  });
  it('uses 100 downhill passes for the default snow redistribution', () => {
    expect(MOUNTAIN_SNOW_REDISTRIBUTION_STEPS_DEFAULT).toBe(100);
    expect(normalizeMountainSnowfallSettings(undefined, undefined, undefined))
      .toMatchObject({ redistributionSteps: 100 });
  });

  it('normalizes independent linework controls and keeps neutral defaults', () => {
    expect(normalizeMountainLineworkSettings(undefined, undefined, undefined, undefined, undefined, undefined)).toEqual({
      scale: MOUNTAIN_LINEWORK_SCALE_DEFAULT,
      opacity: MOUNTAIN_LINEWORK_OPACITY_DEFAULT,
      hatchOpacity: MOUNTAIN_HATCH_OPACITY_DEFAULT,
      horizontalHatchOpacity: MOUNTAIN_HATCH_OPACITY_DEFAULT,
      verticalHatchOpacity: MOUNTAIN_HATCH_OPACITY_DEFAULT,
      hatchDensity: MOUNTAIN_HATCH_DENSITY_DEFAULT,
      hatchThickness: MOUNTAIN_HATCH_THICKNESS_DEFAULT,
      ridgeDensity: MOUNTAIN_RIDGE_DENSITY_DEFAULT,
      ridgeThickness: MOUNTAIN_RIDGE_THICKNESS_DEFAULT,
    });
    // Typed overrides may exceed the slider ranges; only validity limits apply.
    expect(normalizeMountainLineworkSettings(20, 3, -1, 10, 10, 0)).toEqual({
      scale: 20,
      opacity: 1,
      hatchOpacity: 1,
      horizontalHatchOpacity: 1,
      verticalHatchOpacity: 1,
      hatchDensity: 0,
      hatchThickness: 10,
      ridgeDensity: 10,
      ridgeThickness: 0.01,
    });
    expect(normalizeMountainLineworkSettings(1, 0.2, 1, 1, 1, 1, 0.65, 0.25, 0.9))
      .toMatchObject({ hatchOpacity: 0.65, horizontalHatchOpacity: 0.25, verticalHatchOpacity: 0.9 });
  });

  it('uses cot(angle) × exaggeration and reaches zero at overhead view', () => {
    const defaultCoefficient = mountainProjectionLiftCoefficient();
    expect(defaultCoefficient).toBeCloseTo(Math.tan(12 * Math.PI / 180), 8);
    expect(mountainProjectionLiftCoefficient(90, 2)).toBe(0);
    expect(mountainProjectionLiftCoefficient(78, 1.5))
      .toBeCloseTo(defaultCoefficient * 1.5, 8);
    expect(normalizeMountainProjectionSettings(40, 8)).toEqual({
      viewAngleDeg: 40,
      heightExaggeration: 8,
    });
    expect(normalizeMountainProjectionSettings(120, -1)).toEqual({
      viewAngleDeg: 90,
      heightExaggeration: 0,
    });
    expect(normalizeMountainProjectionSettings(undefined, undefined)).toEqual({
      viewAngleDeg: MOUNTAIN_VIEW_ANGLE_DEFAULT_DEG,
      heightExaggeration: MOUNTAIN_HEIGHT_EXAGGERATION_DEFAULT,
    });
  });

  it('changes lift monotonically while preserving the bounded safeguard', () => {
    const settings = normalizeMountainProjectionSettings(78, 1);
    const defaultLift = mountainProjectionLift(900, 30, 1000, 1, settings);
    const exaggeratedLift = mountainProjectionLift(900, 30, 1000, 1,
      normalizeMountainProjectionSettings(78, 1.5));
    const topDownLift = mountainProjectionLift(900, 30, 1000, 1,
      normalizeMountainProjectionSettings(90, 2));
    expect(defaultLift).toBeGreaterThan(0);
    expect(exaggeratedLift).toBeGreaterThan(defaultLift);
    expect(topDownLift).toBe(0);
    expect(mountainProjectionLift(1e9, 1, 1e9, 1, normalizeMountainProjectionSettings(75, 2)))
      .toBe(MOUNTAIN_MAX_LIFT_PIXELS);
    expect(mountainProjectionSupportPixels(1.5)).toBeGreaterThanOrEqual(
      (160 + MOUNTAIN_MAX_LIFT_PIXELS + 96) * 1.5,
    );
  });

  it('keeps 90° at the source rows and raises the default face', () => {
    const dem = makeDem();
    const pattern = renderMountainPatternOverlay(dem);
    const shadow = renderMountainPatternShadow(pattern, dem.width, dem.height, 315);
    const overhead = renderMountainIllustration(dem, pattern, shadow, {
      ...illustrationOptions,
      mountainViewAngleDeg: 90,
      mountainHeightExaggeration: 2,
    });
    const defaultView = renderMountainIllustration(dem, pattern, shadow, {
      ...illustrationOptions,
      mountainViewAngleDeg: 78,
      mountainHeightExaggeration: 1,
    });
    let raised = 0;
    for (let y = 1; y < dem.height - 1; y++) {
      for (let x = 0; x < dem.width; x++) {
        const index = y * dem.width + x;
        if (overhead.sourceY[index] >= 0) expect(overhead.sourceY[index]).toBeCloseTo(y, 5);
        if (defaultView.sourceY[index] > y + 2) raised++;
      }
    }
    expect(raised).toBeGreaterThan(100);
  });

  it('invalidates only the illustrated stage when projection settings change', () => {
    const dem = makeDem(64, 64);
    const cache = createMountainRenderStageCache();
    renderMountainDetailDEMWithCache(dem, {
      ...renderOptions,
      mountainViewAngleDeg: 78,
      mountainHeightExaggeration: 1,
    }, cache);
    const pattern = cache.mountainPattern;
    const illustration = cache.mountainIllustration;
    renderMountainDetailDEMWithCache(dem, {
      ...renderOptions,
      mountainViewAngleDeg: 80,
      mountainHeightExaggeration: 1.5,
    }, cache);
    expect(cache.mountainPattern).toBe(pattern);
    expect(cache.mountainIllustration).not.toBe(illustration);
  });

  it('uses the same projection settings across a complete export and tile cuts', () => {
    const dem = makeDem(48, 48);
    const render = {
      ...renderOptions,
      mountainViewAngleDeg: 78,
      mountainHeightExaggeration: 1.5,
    };
    const context = {
      dem,
      source: {
        width: dem.width,
        height: dem.height,
        luminance: Float32Array.from(dem.normalizedElevation),
      },
      render,
      outputWidth: dem.width,
      outputHeight: dem.height,
    };
    const full = renderMountainExportTile(context, {
      x: 0, y: 0, width: dem.width, height: dem.height, halo: 0,
    });
    const top = renderMountainExportTile(context, {
      x: 0, y: 0, width: dem.width, height: 24, halo: 0,
    });
    const bottom = renderMountainExportTile(context, {
      x: 0, y: 24, width: dem.width, height: 24, halo: 0,
    });
    expect(top.data).toEqual(full.data.subarray(0, top.data.length));
    expect(bottom.data).toEqual(full.data.subarray(top.data.length));
  });
});

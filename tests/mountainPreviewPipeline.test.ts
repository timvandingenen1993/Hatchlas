import { describe, expect, it } from "vitest";
import {
  processMountainBaseDEM,
  recomputeMountainLighting,
} from "../src/terrain/mountainBaseDEM";
import {
  buildMountainIllustrationStageInputs,
  createMountainRenderStageCache,
  renderMountainIllustrationStageFromInputs,
  renderMountainDetailDEM,
  renderMountainDetailDEMWithCache,
  type MountainRenderOptions,
} from "../src/rendering/mountainDetailRenderer";
import type { VegetationMotifAsset } from "../src/rendering/vegetationRenderer";
import { LatestRequestCoordinator } from "../src/rendering/mountainPreviewCoordinator";
import { MountainProfiler } from "../src/rendering/mountainProfiler";

function makeDem(width = 28, height = 20) {
  const raw = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw[y * width + x] = Math.max(
        0,
        Math.min(1, 0.18 + x / width * 0.45 + y / height * 0.22),
      );
    }
  }
  return processMountainBaseDEM(raw, width, height, {
    domainWidthKm: 12,
    minElevationM: -80,
    maxElevationM: 2200,
    oceanElevationM: 0,
    riverThresholdKm2: 0.02,
  });
}

function options(overrides: Partial<MountainRenderOptions> = {}): MountainRenderOptions {
  return {
    layer: "swiss_relief",
    palette: "swiss_topo",
    sunAzimuthDeg: 315,
    sunAltitudeDeg: 45,
    verticalExaggeration: 3.5,
    ambientOcclusionStrength: 0.45,
    showRivers: true,
    riverThresholdKm2: 0.02,
    showWaterDetails: true,
    showOceanDetails: true,
    showContours: false,
    contourIntervalM: 100,
    ...overrides,
  };
}

describe("mountain preview staged rendering", () => {
  it("is byte-equivalent to the one-shot renderer", () => {
    const dem = makeDem();
    const renderOptions = options({ showContours: true });
    const expected = renderMountainDetailDEM(dem, renderOptions);
    const actual = renderMountainDetailDEMWithCache(
      dem,
      renderOptions,
      createMountainRenderStageCache(),
    );
    expect(Array.from(actual.data)).toEqual(Array.from(expected.data));
  });

  it("keeps cpuExact byte-identical to the reference renderer", () => {
    const dem = makeDem();
    const cpuExact = options({ gpuRenderMode: "cpuExact", showContours: true });
    const expected = renderMountainDetailDEM(dem, { ...cpuExact, gpuRenderMode: undefined });
    const actual = renderMountainDetailDEMWithCache(
      dem,
      cpuExact,
      createMountainRenderStageCache(),
    );
    expect(Array.from(actual.data)).toEqual(Array.from(expected.data));
  });

  it("keeps the first cached vegetation frame byte-equivalent", () => {
    const dem = makeDem();
    const renderOptions = options({
      layer: "vegetation_patterns",
      vegetation: { seed: 17, density: 0.35, motifShadowStrength: 0.3 },
    });
    const expected = renderMountainDetailDEM(dem, renderOptions);
    const actual = renderMountainDetailDEMWithCache(
      dem,
      renderOptions,
      createMountainRenderStageCache(),
    );
    expect(Array.from(actual.data)).toEqual(Array.from(expected.data));
  });

  it("keeps a pre-rendered illustration cache byte-equivalent", () => {
    const dem = makeDem();
    const renderOptions = options({
      layer: "vegetation_patterns",
      vegetation: { seed: 17, density: 0.35 },
    });
    const cache = createMountainRenderStageCache();
    const inputs = buildMountainIllustrationStageInputs(
      dem,
      renderOptions,
      cache,
    );
    renderMountainIllustrationStageFromInputs(inputs);

    const preRendered = renderMountainDetailDEMWithCache(
      dem,
      renderOptions,
      cache,
    );
    const direct = renderMountainDetailDEM(dem, renderOptions);
    expect(Array.from(preRendered.data)).toEqual(Array.from(direct.data));
  });

  it("reuses water geometry for compositor-only color changes", () => {
    const dem = makeDem();
    const cache = createMountainRenderStageCache();
    renderMountainDetailDEMWithCache(dem, options(), cache);
    expect(cache.stats.waterOverlayBuilds).toBe(1);

    renderMountainDetailDEMWithCache(
      dem,
      options({ waterOutlineColor: "#ff00ff", waterFlowColor: "#00ffff" }),
      cache,
    );
    expect(cache.stats.waterOverlayBuilds).toBe(1);
    expect(cache.stats.composites).toBe(2);
  });

  it("applies per-biome and water endpoint palette overrides", () => {
    const dem = makeDem();
    const base = renderMountainDetailDEM(
      dem,
      options({ layer: "vegetation_patterns" }),
    );
    const landBiome = Array.from(dem.biomeType).find(
      (biomeId) => biomeId !== 6 && biomeId !== 8,
    );
    expect(landBiome).toBeDefined();
    const overridden = renderMountainDetailDEM(
      dem,
      options({
        layer: "vegetation_patterns",
        vegetationBiomeColors: {
          [landBiome ?? 2]: "#ff00ff",
        },
        waterShallowColor: "#00ffff",
        waterDeepColor: "#000022",
      }),
    );

    expect(Array.from(overridden.data)).not.toEqual(Array.from(base.data));
  });

  it("keeps pixels and cache behavior unchanged when profiling is enabled", () => {
    const dem = makeDem();
    const renderOptions = options({
      layer: "vegetation_patterns",
      showContours: true,
      vegetation: { seed: 17, density: 0.35 },
    });
    const plainCache = createMountainRenderStageCache();
    const profiledCache = createMountainRenderStageCache();
    const profiler = new MountainProfiler(true, {
      requestId: 1,
      width: dem.width,
      height: dem.height,
      layer: renderOptions.layer,
    });

    const plainFirst = renderMountainDetailDEMWithCache(dem, renderOptions, plainCache);
    const profiledFirst = renderMountainDetailDEMWithCache(
      dem,
      renderOptions,
      profiledCache,
      profiler,
    );
    const plainSecond = renderMountainDetailDEMWithCache(dem, renderOptions, plainCache);
    const profiledSecond = renderMountainDetailDEMWithCache(
      dem,
      renderOptions,
      profiledCache,
      profiler,
    );

    expect(Array.from(profiledFirst.data)).toEqual(Array.from(plainFirst.data));
    expect(Array.from(profiledSecond.data)).toEqual(Array.from(plainSecond.data));
    expect(profiledCache.stats).toEqual(plainCache.stats);
    expect(profiler.finish("completed", false)?.stages.length).toBeGreaterThan(0);
  });

  it("reuses shared mountain fields across stroke and wind edits", () => {
    const dem = makeDem();
    const cache = createMountainRenderStageCache();
    const vegetation = { seed: 17, density: 0.35, strokeThickness: 1 };
    renderMountainDetailDEMWithCache(
      dem,
      options({ layer: "vegetation_patterns", vegetation }),
      cache,
    );
    const broadElevation = cache.mountainFieldCache.entries.get("pattern broad elevation")?.value;
    const roughness = cache.mountainFieldCache.entries.get("illustration snow roughness")?.value;
    const windShelter = cache.mountainFieldCache.entries.get("illustration wind shelter")?.value;

    renderMountainDetailDEMWithCache(
      dem,
      options({
        layer: "vegetation_patterns",
        vegetation: { ...vegetation, strokeThickness: 1.7 },
        windAzimuthDeg: 135,
      }),
      cache,
    );

    expect(cache.mountainFieldCache.entries.get("pattern broad elevation")?.value)
      .toBe(broadElevation);
    expect(cache.mountainFieldCache.entries.get("illustration snow roughness")?.value)
      .toBe(roughness);
    expect(cache.mountainFieldCache.entries.get("illustration wind shelter")?.value)
      .not.toBe(windShelter);
  });

  it("preserves pixels for cached lighting, snow, wind, and stroke edits", () => {
    const dem = makeDem();
    const cache = createMountainRenderStageCache();
    const baseVegetation = { seed: 17, density: 0.35, strokeThickness: 1 };
    const scenarios: MountainRenderOptions[] = [
      options({ layer: "vegetation_patterns", vegetation: baseVegetation }),
      options({
        layer: "vegetation_patterns",
        sunAzimuthDeg: 210,
        sunAltitudeDeg: 32,
        vegetation: baseVegetation,
      }),
      options({
        layer: "vegetation_patterns",
        snowfallAmount: 0.72,
        snowfallDrift: 0.4,
        vegetation: baseVegetation,
      }),
      options({
        layer: "vegetation_patterns",
        windAzimuthDeg: 135,
        vegetation: baseVegetation,
      }),
      options({
        layer: "vegetation_patterns",
        vegetation: { ...baseVegetation, strokeThickness: 1.7 },
      }),
    ];

    for (const renderOptions of scenarios) {
      const expected = renderMountainDetailDEM(dem, renderOptions);
      const actual = renderMountainDetailDEMWithCache(dem, renderOptions, cache);
      expect(Array.from(actual.data)).toEqual(Array.from(expected.data));
    }
  });

  it("invalidates mountain fields when a DEM source array changes in place", () => {
    const dem = makeDem();
    const cache = createMountainRenderStageCache();
    const renderOptions = options({
      layer: "vegetation_patterns",
      vegetation: { seed: 17, density: 0.35 },
    });
    renderMountainDetailDEMWithCache(dem, renderOptions, cache);
    const firstPattern = cache.mountainPattern;
    dem.elevation[dem.elevation.length - 1] += 1;
    const actual = renderMountainDetailDEMWithCache(dem, renderOptions, cache);
    const expected = renderMountainDetailDEM(dem, renderOptions);
    expect(Array.from(actual.data)).toEqual(Array.from(expected.data));
    expect(cache.mountainPattern).not.toBe(firstPattern);
  });

  it("reuses vegetation geometry and raster for ink-color changes", () => {
    const dem = makeDem();
    const cache = createMountainRenderStageCache();
    const vegetation = {
      seed: 7,
      density: 0.35,
      patternScale: 1,
      inkColor: "#202820",
    };
    renderMountainDetailDEMWithCache(
      dem,
      options({ layer: "vegetation_patterns", vegetation }),
      cache,
    );
    renderMountainDetailDEMWithCache(
      dem,
      options({
        layer: "vegetation_patterns",
        vegetation: { ...vegetation, inkColor: "#704020" },
      }),
      cache,
    );
    expect(cache.stats.vegetationGeometryBuilds).toBe(1);
    expect(cache.stats.vegetationOverlayBuilds).toBe(1);
    expect(cache.stats.composites).toBe(2);
  });

  it("reuses vegetation flow fields when only shadow strength changes", () => {
    const dem = makeDem();
    const cache = createMountainRenderStageCache();
    const vegetation = {
      seed: 19,
      density: 0.35,
      patternScale: 1,
      motifShadowStrength: 0.2,
      washShadowStrength: 0.2,
    };
    renderMountainDetailDEMWithCache(
      dem,
      options({ layer: "vegetation_patterns", vegetation }),
      cache,
    );
    const background = cache.vegetationStages.background;
    const shadowCoverage = cache.vegetationStages.shadowCoverage;
    const washShadowCoverage = cache.vegetationStages.washShadowCoverage;

    renderMountainDetailDEMWithCache(
      dem,
      options({
        layer: "vegetation_patterns",
        vegetation: {
          ...vegetation,
          motifShadowStrength: 0.65,
          washShadowStrength: 0.7,
        },
      }),
      cache,
    );

    expect(cache.vegetationStages.background).toBe(background);
    expect(cache.vegetationStages.shadowCoverage).toBe(shadowCoverage);
    expect(cache.vegetationStages.washShadowCoverage).toBe(
      washShadowCoverage,
    );
    expect(cache.stats.vegetationGeometryBuilds).toBe(1);
    expect(cache.stats.vegetationOverlayBuilds).toBe(2);
  });

  it("invalidates the final vegetation overlay when same-sized SVG geometry changes", () => {
    const dem = makeDem();
    const path = {
      key: 9201,
      biomeId: 7,
      width: 1,
      dashPhase: 0,
      points: [{ x: 8, y: 28 }, { x: 48, y: 28 }],
    };
    const geometry = {
      width: dem.width,
      height: dem.height,
      paths: [path],
      motifs: [{
        x: 28,
        y: 28,
        rotation: 0,
        size: 20,
        opacity: 1,
        biomeId: 7,
        assetKey: "reeds-01",
        pathKey: path.key,
        pathT: 0.5,
      }],
      wetlandProps: [],
    };
    const makeAsset = (y: number): VegetationMotifAsset => ({
      key: "reeds-01",
      family: "reeds",
      width: 64,
      height: 40,
      data: new Uint8ClampedArray(),
      vectorPaths: [{
        strokeWidth: 3,
        points: [{ x: 8, y }, { x: 56, y }],
      }],
    });
    const firstOptions = options({
      layer: "vegetation_patterns",
      vegetation: {
        density: 0,
        motifDensity: 1,
        motifShadowStrength: 0,
        washShadowStrength: 0,
        strokeOpacity: 1,
        motifAssets: [makeAsset(20)],
      },
      vegetationGeometryOverride: geometry,
    });
    const cache = createMountainRenderStageCache();
    renderMountainDetailDEMWithCache(dem, firstOptions, cache);
    renderMountainDetailDEMWithCache(
      dem,
      {
        ...firstOptions,
        vegetation: {
          ...firstOptions.vegetation,
          motifAssets: [makeAsset(10)],
        },
      },
      cache,
    );

    expect(cache.stats.vegetationOverlayBuilds).toBe(2);
    expect(cache.vegetationStages.inkKey).toContain("8,10;56,10");
  });

  it("does not invalidate vegetation when only water line styling changes", () => {
    const dem = makeDem();
    const cache = createMountainRenderStageCache();
    const renderOptions = options({
      layer: "vegetation_patterns",
      vegetation: { seed: 11, density: 0.3 },
    });
    renderMountainDetailDEMWithCache(dem, renderOptions, cache);
    renderMountainDetailDEMWithCache(
      dem,
      { ...renderOptions, waterOutlineThickness: 2.5 },
      cache,
    );
    expect(cache.stats.waterOverlayBuilds).toBe(2);
    expect(cache.stats.vegetationGeometryBuilds).toBe(1);
    expect(cache.stats.vegetationOverlayBuilds).toBe(1);
  });

  it("reuses the smoothed contour field for color changes", () => {
    const dem = makeDem();
    const cache = createMountainRenderStageCache();
    renderMountainDetailDEMWithCache(
      dem,
      options({ showContours: true, contourSmoothingPasses: 2 }),
      cache,
    );
    renderMountainDetailDEMWithCache(
      dem,
      options({
        showContours: true,
        contourSmoothingPasses: 2,
        contourColor: "#ff0000",
      }),
      cache,
    );
    expect(cache.stats.contourFieldBuilds).toBe(1);
  });

  it("recomputes lighting without replacing routing or climate fields", () => {
    const dem = makeDem();
    const flowDirection = dem.flowDirection;
    const precipitation = dem.precipitationMmYr;
    const before = dem.hillshade.slice();
    recomputeMountainLighting(dem, {
      sunAzimuthDeg: 120,
      sunAltitudeDeg: 28,
      verticalExaggeration: 5,
    });
    expect(dem.flowDirection).toBe(flowDirection);
    expect(dem.precipitationMmYr).toBe(precipitation);
    expect(Array.from(dem.hillshade)).not.toEqual(Array.from(before));
  });
});

describe("LatestRequestCoordinator", () => {
  it("runs at most one active and one latest pending request", async () => {
    const scheduled: Array<() => void> = [];
    const releases: Array<() => void> = [];
    const seen: number[] = [];
    const coordinator = new LatestRequestCoordinator<{ requestId: number }>(
      async (request) => {
        seen.push(request.requestId);
        await new Promise<void>((resolve) => releases.push(resolve));
      },
      (callback) => scheduled.push(callback),
    );

    coordinator.enqueue({ requestId: 1 });
    coordinator.enqueue({ requestId: 2 });
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await Promise.resolve();
    expect(seen).toEqual([2]);

    coordinator.enqueue({ requestId: 3 });
    coordinator.enqueue({ requestId: 4 });
    releases.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await Promise.resolve();
    expect(seen).toEqual([2, 4]);
    releases.shift()!();
  });
});

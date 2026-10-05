import { createMountainRenderStageCache, renderMountainDetailDEMWithCache } from "../src/rendering/mountainDetailRenderer";
import { describe, expect, it } from "vitest";
import { buildForestStandGeometry, SHRUB_STAND_PROFILE } from "../src/rendering/forestStandGeometry";
import type { MountainDEMData } from "../src/terrain/mountainBaseDEM";
import { makeMountainFoothillReviewAssets } from "./mountainFoothillReviewAssets";
import {
  buildVegetationGeometry,
  buildVegetationRasterPropPlacements,
  buildMountainFoothillPropPlacements,
  buildMountainFoothillTransportField,
  isRasterPropPlacementValid,
  mapVegetationGeometryToTile,
  propStandColorPartition,
  rasterPropSettingsForBiome,
  rasterPropFootprintBounds,
  rasterPropShadowMetrics,
  renderVegetationOverlay,
  resolveVegetationPatternOptions,
  MOUNTAIN_FOOTHILL_TRANSPORT_STEPS_DEFAULT,
  sampleAlpineForestTerrainSuitability,
  type VegetationRasterPropAsset,
  type VegetationRasterPropPlacement,
  sampleMountainFoothillTerrain,
} from "../src/rendering/vegetationRenderer";
import {
  trimRasterPropPadding,
  MOUNTAIN_FOOTHILL_PROP_DEFINITIONS,
  VEGETATION_RASTER_PROP_DEFINITIONS,
} from "../src/rendering/vegetationMotifs";

function makeMountainFoothillDem(): MountainDEMData {
  const dem = makeDem(320, 240, 3);
  for (let y = 42; y < 198; y++) {
    for (let x = 62; x < 258; x++) {
      const index = y * dem.width + x;
      dem.biomeType[index] = 2;
      dem.elevation[index] = 500;
      dem.normalizedElevation[index] = 0.5;
      dem.slopeDeg[index] = 18;
    }
  }
  for (let y = 86; y < 154; y++) {
    for (let x = 112; x < 208; x++) {
      const index = y * dem.width + x;
      dem.biomeType[index] = 1;
      dem.elevation[index] = 700;
      dem.normalizedElevation[index] = 0.7;
      dem.slopeDeg[index] = 34;
    }
  }
  return dem;
}

function makeDem(width = 320, height = 240, biome = 3): MountainDEMData {
  const total = width * height;
  return {
    width,
    height,
    domainWidthKm: 32,
    domainHeightKm: 24,
    dxMeters: 100,
    dyMeters: 100,
    minElevationM: 0,
    maxElevationM: 1000,
    oceanSurfaceElevationM: 0,
    elevation: new Float32Array(total).fill(400),
    normalizedElevation: new Float32Array(total).fill(0.4),
    slopeDeg: new Float32Array(total).fill(3),
    aspectDeg: new Float32Array(total),
    normals: new Float32Array(total * 3),
    hillshade: new Float32Array(total).fill(0.85),
    ambientOcclusion: new Float32Array(total).fill(0.9),
    curvature: new Float32Array(total),
    tpi: new Float32Array(total),
    flowAccumulation: new Float32Array(total),
    drainageAreaKm2: new Float32Array(total),
    rainfallWeightedAreaKm2: new Float32Array(total),
    runoffDepthMmYr: new Float32Array(total),
    dischargeM3s: new Float32Array(total),
    strahlerOrder: new Uint8Array(total),
    riverCenterlineMask: new Uint8Array(total),
    riverChannelRadius: new Uint8Array(total),
    riverMouthMask: new Uint8Array(total),
    riverMouthAreaKm2: new Float32Array(total),
    isRiverChannel: new Uint8Array(total),
    waterDepthM: new Float32Array(total),
    flowDirection: new Int8Array(total).fill(-1),
    erosionDepthM: new Float32Array(total),
    precipitationMmYr: new Float32Array(total).fill(1200),
    solarInsolation: new Float32Array(total).fill(0.6),
    temperatureC: new Float32Array(total).fill(12),
    biomeType: new Uint8Array(total).fill(biome),
    isOcean: new Uint8Array(total),
    visualWaterMask: new Uint8Array(total),
    visualWaterCoverage: new Float32Array(total),
  };
}

function standAsset(
  key: string,
  outlineGroup: "alpine-forest" | "wetland-forest",
  eligibleBiomeIds: readonly number[],
): VegetationRasterPropAsset {
  return {
    ...makeAsset(key, eligibleBiomeIds),
    placementRole: outlineGroup === "wetland-forest" ? "wetland" : undefined,
    footprintWidthCells: 1,
    footprintHeightCells: 1,
    heightCells: 0.8,
    outlineGroup,
  };
}

function makeAsset(
  key: string,
  eligibleBiomeIds: readonly number[] = [3],
): VegetationRasterPropAsset {
  const width = 32;
  const height = 32;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    data[index * 4] = 92;
    data[index * 4 + 1] = 146;
    data[index * 4 + 2] = 118;
    data[index * 4 + 3] = 255;
  }
  return {
    key,
    family: "shrub",
    width,
    height,
    data,
    kind: "raster-prop",
    footprintWidthCells: 5,
    footprintHeightCells: 5,
    heightCells: 4,
    anchorX: 0.5,
    anchorY: 0.5,
    eligibleBiomeIds,
  };
}

function placement(x = 160, y = 120): VegetationRasterPropPlacement {
  return {
    x,
    y,
    rotation: 0,
    cellSize: 16,
    opacity: 1,
    biomeId: 3,
    assetKey: "test-tree",
  };
}

describe("grid-authored raster vegetation props", () => {
  it("keeps foothill rocks deterministic, grid-aligned, randomly rotated, and tied to a mountain core", () => {
    const dem = makeMountainFoothillDem();
    const asset = {
      ...makeAsset("mountain-boulder-01", [1, 2, 3]),
      family: "universal" as const,
      placementRole: "mountain-foothill" as const,
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 0.45,
    };
    const resolved = resolveVegetationPatternOptions({
      seed: 1947,
      rasterPropDensity: 0.42,
      rasterPropCellSize: 16,
      rasterPropAssets: [asset],
    });
    const first = buildMountainFoothillPropPlacements(dem, resolved);
    const second = buildMountainFoothillPropPlacements(dem, resolved);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(first.every((prop) =>
      prop.cellSize === 8 &&
      prop.rotation >= 0 &&
      prop.rotation < Math.PI * 2 &&
      prop.assetKey === asset.key,
    )).toBe(true);
    expect(new Set(first.map((prop) => prop.rotation)).size).toBeGreaterThan(1);
    expect(first.every((prop) => prop.biomeId === 1 || prop.biomeId === 2 || prop.biomeId === 3)).toBe(true);

    const geometry = {
      width: dem.width,
      height: dem.height,
      paths: [],
      motifs: [],
      rasterProps: first,
    };
    const fullTile = mapVegetationGeometryToTile(
      geometry,
      dem.width,
      dem.height,
      0,
      0,
      dem.width,
      dem.height,
      [asset],
    );
    expect(fullTile.rasterProps).toEqual(first);
    const exportTile = mapVegetationGeometryToTile(
      geometry,
      dem.width * 2,
      dem.height * 2,
      0,
      0,
      dem.width * 2,
      dem.height * 2,
      [asset],
    );
    expect(exportTile.rasterProps).toHaveLength(first.length);
    const exportScale = (dem.width * 2 - 1) / (dem.width - 1);
    exportTile.rasterProps?.forEach((prop, index) =>
      expect(prop.cellSize).toBeCloseTo(first[index].cellSize * exportScale, 5),
    );

    const water = first[0];
    dem.visualWaterMask![Math.round(water.y) * dem.width + Math.round(water.x)] = 1;
    expect(buildMountainFoothillPropPlacements(dem, resolved)).not.toContainEqual(water);
  });

  it("uses dedicated boulder density and size controls", () => {
    expect(MOUNTAIN_FOOTHILL_TRANSPORT_STEPS_DEFAULT).toBe(100);
    const dem = makeMountainFoothillDem();
    const asset = {
      ...makeAsset("mountain-boulder-01", [1, 2, 3]),
      family: "universal" as const,
      placementRole: "mountain-foothill" as const,
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 0.45,
    };
    const baseOptions = {
      seed: 1947,
      rasterPropDensity: 0.42,
      mountainBoulderDensity: 0.42,
      rasterPropCellSize: 16,
      rasterPropAssets: [asset],
    };

    expect(
      buildMountainFoothillPropPlacements(
        dem,
        resolveVegetationPatternOptions({
          ...baseOptions,
          mountainBoulderDensity: 0,
        }),
      ),
    ).toEqual([]);

    const smaller = buildMountainFoothillPropPlacements(
      dem,
      resolveVegetationPatternOptions({
        ...baseOptions,
        rasterPropDensity: 0,
        mountainBoulderSize: 0.5,
      }),
    );
    expect(smaller.length).toBeGreaterThan(0);
    expect(smaller.every((prop) => prop.cellSize === 4)).toBe(true);
  });

  it("registers native SVG boulder footprints and varied cluster sizes", () => {
    expect(MOUNTAIN_FOOTHILL_PROP_DEFINITIONS).toHaveLength(10);
    expect(MOUNTAIN_FOOTHILL_PROP_DEFINITIONS.map((definition) => definition.footprintWidthCells))
      .toEqual([1, 2, 3, 1, 1, 2, 2, 2, 2, 2]);
    const reviewAssets = makeMountainFoothillReviewAssets();
    expect(reviewAssets.every((asset) =>
      asset.width === 64 &&
      asset.height === 64 &&
      (asset.vectorPaths?.length ?? 0) >= 1 &&
      (asset.vectorPaths?.length ?? 0) <= 5,
    )).toBe(true);
    expect(reviewAssets.map((asset) => asset.vectorPaths?.length ?? 0))
      .toEqual([1, 3, 1, 1, 2, 3, 4, 5, 2, 3]);

    const assets = MOUNTAIN_FOOTHILL_PROP_DEFINITIONS.map((definition) => {
      const size = definition.footprintWidthCells * 8;
      const data = new Uint8ClampedArray(size * size * 4);
      for (let index = 0; index < size * size; index++) {
        data[index * 4] = 74;
        data[index * 4 + 1] = 64;
        data[index * 4 + 2] = 54;
        data[index * 4 + 3] = 255;
      }
      return {
        ...makeAsset(definition.key, [1, 2, 3]),
        ...definition,
        width: size,
        height: size,
        data,
        kind: "raster-prop" as const,
      };
    });
    const dem = makeMountainFoothillDem();
    const resolved = resolveVegetationPatternOptions({
      seed: 1947,
      rasterPropDensity: 0.42,
      rasterPropCellSize: 16,
      rasterPropAssets: assets,
    });
    const placements = buildMountainFoothillPropPlacements(dem, resolved);
    const assetByKey = new Map(assets.map((asset) => [asset.key, asset]));
    expect(placements.length).toBeGreaterThan(0);
    expect(new Set(placements.map((prop) => prop.assetKey)).size).toBeGreaterThan(1);
    expect(placements.every((prop) => prop.cellSize === 8)).toBe(true);
    for (const prop of placements) {
      const asset = assetByKey.get(prop.assetKey)!;
      const bounds = rasterPropFootprintBounds(prop, asset);
      const footprintWidth = prop.cellSize * asset.footprintWidthCells;
      const footprintHeight = prop.cellSize * asset.footprintHeightCells;
      const cos = Math.abs(Math.cos(prop.rotation));
      const sin = Math.abs(Math.sin(prop.rotation));
      expect(bounds.maxX - bounds.minX).toBeCloseTo(
        footprintWidth * cos + footprintHeight * sin,
        5,
      );
      expect(bounds.maxY - bounds.minY).toBeCloseTo(
        footprintWidth * sin + footprintHeight * cos,
        5,
      );
    }
  });

  it("renders SVG boulders through the charcoal prop layer", () => {
    const dem = makeDem(96, 96, 3);
    const asset = makeMountainFoothillReviewAssets()[0];
    const overlay = renderVegetationOverlay(
      dem,
      {
        width: dem.width,
        height: dem.height,
        paths: [],
        motifs: [],
        rasterProps: [{
          x: 48,
          y: 48,
          rotation: 0,
          cellSize: 8,
          opacity: 1,
          biomeId: 3,
          assetKey: asset.key,
        }],
      },
      {
        rasterPropAssets: [asset],
        strokeThickness: 1,
        strokeOpacity: 1,
        lineInterruptionProbability: 0,
        motifShadowStrength: 0,
      },
    );

    expect(overlay.rasterPropCharcoalAlpha.some((value) => value > 0)).toBe(true);
    expect(overlay.rasterPropRGBA.every((value) => value === 0)).toBe(true);
  });

  it("routes steep rock supply into a downstream slope-break deposit", () => {
    const dem = makeDem(96, 96, 2);
    for (let y = 0; y < dem.height; y++) {
      for (let x = 0; x < dem.width; x++) {
        const index = y * dem.width + x;
        dem.elevation[index] = 900 - y * 3;
        dem.normalizedElevation[index] = 0.6;
        dem.slopeDeg[index] = y < 44 ? 38 : 16;
        dem.flowDirection[index] = y + 1 < dem.height ? 4 : -1;
        dem.flowAccumulation[index] = 1;
        dem.strahlerOrder[index] = 1;
      }
    }

    const field = buildMountainFoothillTransportField(dem);
    const upper = sampleMountainFoothillTerrain(dem, 48, 20, field);
    const lower = sampleMountainFoothillTerrain(dem, 48, 44, field);
    expect(lower.depositionPotential).toBeGreaterThan(upper.depositionPotential);
    expect(lower.flowAlignment).toBeGreaterThan(0);

    let maximumIndex = 0;
    for (let index = 1; index < field.deposition.length; index++) {
      if (field.deposition[index] > field.deposition[maximumIndex]) maximumIndex = index;
    }
    expect(Math.floor(maximumIndex / dem.width)).toBeGreaterThanOrEqual(40);
  });

  it("builds connected woodland stands with mixed variants and open clearings", () => {
    const dem = makeDem(640, 480, 3);
    const assets = [makeAsset("fir"), makeAsset("pine"), makeAsset("spruce")];
    const options = { density: 0, motifDensity: 0, rasterPropCellSize: 4,
      rasterPropDensity: 0.65, rasterPropClustering: 0.9, rasterPropAssets: assets };
    const props = buildVegetationGeometry(dem, options).rasterProps!;
    expect(props.length).toBeGreaterThan(100);
    expect(new Set(props.map(p => p.assetKey)).size).toBe(3);
    const unvisited = new Set(props.map((_, index) => index));
    let largest = 0;
    while (unvisited.size > 0) {
      const first = unvisited.values().next().value!;
      unvisited.delete(first);
      const queue = [first];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const current = props[queue[cursor]];
        for (const index of unvisited) {
          if (Math.hypot(current.x - props[index].x, current.y - props[index].y) < 20) {
            unvisited.delete(index);
            queue.push(index);
          }
        }
      }
      largest = Math.max(largest, queue.length);
    }
    expect(largest / props.length).toBeGreaterThan(0.2);
    let clearCells = 0;
    for (let y = 40; y < 440; y += 20) for (let x = 40; x < 600; x += 20) {
      if (props.every(p => Math.hypot(p.x - x, p.y - y) > 30)) clearCells++;
    }
    expect(clearCells).toBeGreaterThan(20);
    const disabled = buildVegetationGeometry(dem, { ...options, rasterPropDensity: 0 });
    expect(disabled.rasterProps).toEqual([]);
  });

  it("increases forest population above the old density saturation point", () => {
    const dem = makeDem(640, 480, 3);
    const options = { density: 0, motifDensity: 0, rasterPropCellSize: 4,
      rasterPropClustering: 0.72, rasterPropAssets: [makeAsset("fir")] };
    const sparse = buildVegetationGeometry(dem, { ...options, rasterPropDensity: 0.8 }).rasterProps!;
    const dense = buildVegetationGeometry(dem, { ...options, rasterPropDensity: 1.5 }).rasterProps!;
    expect(dense.length).toBeGreaterThan(sparse.length * 1.15);
    expect(sparse.length).toBeGreaterThan(800);
    expect(buildVegetationGeometry(dem, { ...options, rasterPropDensity: 0.8 }).rasterProps).toEqual(sparse);
  });

  it("calibrates padded foliage to the same visible cell size", () => {
    const original = makeAsset("padded", [7]);
    original.data.fill(0);
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) original.data.set([92, 146, 118, 255], (y * 32 + x) * 4);
    }
    const asset = { ...original, ...trimRasterPropPadding(original), footprintWidthCells: 1, footprintHeightCells: 1 };
    expect(asset.width).toBe(16);
    expect(original.width).toBe(32);
    const dem = makeDem(320, 240, 7);
    const stages = {};
    for (const cellSize of [8, 16, 32, 64]) {
      const geometry = { width: 320, height: 240, paths: [], motifs: [],
        rasterProps: [{ ...placement(), biomeId: 7, assetKey: asset.key, cellSize }] };
      const overlay = renderVegetationOverlay(dem, geometry, { rasterPropAssets: [asset], rasterPropCellSize: cellSize }, 315, stages);
      const painted = [];
      for (let x = 0; x < 320; x++) {
        if (overlay.rasterPropRGBA[(120 * 320 + x) * 4 + 3]) painted.push(x);
      }
      expect(painted.length).toBe(cellSize);
      expect(Math.max(...painted) - Math.min(...painted) + 1).toBe(cellSize);
    }
  });

  it("refreshes every prop family when the cached preview scale changes", () => {
    for (const biome of [2, 5, 7]) {
      const dem = makeDem(400, 400, biome);
      const cache = createMountainRenderStageCache();
      const asset = { ...makeAsset(`biome-${biome}`, [biome]), footprintWidthCells: 1, footprintHeightCells: 1 };
      for (const scale of [8, 16, 32, 64]) {
        renderMountainDetailDEMWithCache(dem, {
          layer: "vegetation_patterns", palette: "swiss_topo", sunAzimuthDeg: 315, sunAltitudeDeg: 45,
          verticalExaggeration: 1, ambientOcclusionStrength: 0, showRivers: false, riverThresholdKm2: 1,
          showWaterDetails: false, wetlandPuddleContours: false, showContours: false, contourIntervalM: 100,
          vegetation: { density: 0, motifDensity: 0, rasterPropAssets: [asset], rasterPropDensity: 0.42,
            rasterPropCellSize: scale, wetlandImagePropDrynessBias: 1 },
        }, cache);
        expect(cache.vegetationGeometry!.rasterProps!.length).toBeGreaterThan(0);
        expect(cache.vegetationGeometry!.rasterProps!.every(p => p.cellSize === scale)).toBe(true);
        expect(cache.vegetationOverlay!.rasterPropRGBA.some(v => v > 0)).toBe(true);
      }
      expect(cache.stats.vegetationGeometryBuilds).toBe(4);
      expect(cache.stats.vegetationOverlayBuilds).toBe(4);
    }
  });

  it("isolates density and clustering changes to the selected biome", () => {
    const dem = makeDem(400, 300, 2);
    for (let y = 0; y < 300; y++) for (let x = 200; x < 400; x++) dem.biomeType[y * 400 + x] = 3;
    const asset = { ...makeAsset("shared-tree", [2, 3]), footprintWidthCells: 1, footprintHeightCells: 1 };
    const options = { density: 0, motifDensity: 0, rasterPropAssets: [asset], rasterPropCellSize: 8 };
    const base = buildVegetationGeometry(dem, options).rasterProps!;
    expect(base.filter(p => p.biomeId === 2).length).toBeGreaterThan(0);
    expect(base.filter(p => p.biomeId === 3).length).toBeGreaterThan(0);
    for (const settings of [{ density: 0 }, { clustering: 0 }]) {
      const changed = buildVegetationGeometry(dem, { ...options, rasterPropBiomeSettings: { 2: settings } }).rasterProps!;
      expect(changed.filter(p => p.biomeId === 3)).toEqual(base.filter(p => p.biomeId === 3));
      expect(changed.filter(p => p.biomeId === 2)).not.toEqual(base.filter(p => p.biomeId === 2));
      if (settings.density === 0) expect(changed.filter(p => p.biomeId === 2)).toEqual([]);
    }
    const enabled = buildVegetationGeometry(dem, { ...options, rasterPropDensity: 0, rasterPropBiomeSettings: { 2: { density: 1 } } }).rasterProps!;
    expect(enabled.length).toBeGreaterThan(0);
    expect(enabled.every(p => p.biomeId === 2)).toBe(true);
  });



  it("allows the supplied alpine tree in montane broadleaf woodland", () => {
    const alpineDefinitions = VEGETATION_RASTER_PROP_DEFINITIONS.filter(
      (definition) => definition.key === "alpine-tree-75",
    );
    expect(alpineDefinitions).toHaveLength(1);
    expect(
      alpineDefinitions.every((definition) =>
        definition.eligibleBiomeIds.includes(4),
      ),
    ).toBe(true);

    const dem = makeDem(320, 240, 4);
    const asset = {
      ...makeAsset("alpine-tree", [2, 3, 4]),
      outlineGroup: "alpine-forest",
    };
    const options = {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 1,
      rasterPropCellSize: 16,
      rasterPropAssets: [asset],
    };
    const placements = buildVegetationRasterPropPlacements(dem, options);
    expect(placements.length).toBeGreaterThan(0);
    expect(placements.every((prop) => prop.biomeId === 4)).toBe(true);
    expect(new Set(placements.map((prop) => prop.rotation))).toEqual(new Set([0]));
    // The vegetation geometry draws alpine forest as stands, not per-tree props.
    const geometry = buildVegetationGeometry(dem, options);
    expect(geometry.stands?.find((stand) => stand.group === "alpine-forest")?.geometry.items.length).toBeGreaterThan(0);
    expect(geometry.rasterProps?.some((prop) => prop.assetKey === asset.key)).toBe(false);
  });

  it("draws wetland shrubs as shrub stands through the same stand workflow", () => {
    const dem = makeDem(320, 240, 7);
    const asset = {
      ...makeAsset("wetland-shrub", [7]),
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 0.8,
      outlineGroup: "wetland-forest",
    };
    const options = {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 1,
      rasterPropCellSize: 16,
      rasterPropAssets: [asset],
      wetlandImagePropDrynessBias: 1,
    };
    const geometry = buildVegetationGeometry(dem, options);
    expect(geometry.stands?.map((stand) => stand.group)).toEqual(["wetland-shrubs"]);
    expect(geometry.stands?.[0].geometry.items.length).toBeGreaterThan(0);
    // Neighbouring shrubs must form washed patches, not only lone L1s. With
    // the mask sized from the small shrub plant, only ~16% was washed here.
    const mask = geometry.stands![0].geometry.mask;
    expect(Array.from(mask).filter((value) => value > 0.5).length / mask.length).toBeGreaterThan(0.4);
    expect(geometry.rasterProps?.some((prop) => prop.assetKey === asset.key)).toBe(false);
  });

  it("gives dry steppe shrub stands by default, sparser than the wetland's", () => {
    const shrubDefinition = VEGETATION_RASTER_PROP_DEFINITIONS.find((definition) =>
      definition.placementRole === "wetland");
    expect(shrubDefinition?.eligibleBiomeIds).toContain(17);
    const asset = standAsset("wetland-shrub", "wetland-forest", shrubDefinition!.eligibleBiomeIds);
    const options = {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 1,
      rasterPropCellSize: 16,
      rasterPropAssets: [asset],
      // Full wetland shrub density, so the steppe's lower default shows.
      wetlandShrubDensity: 2,
      wetlandImagePropDrynessBias: 1,
    };
    const steppe = buildVegetationRasterPropPlacements(makeDem(320, 240, 17), options);
    const wetland = buildVegetationRasterPropPlacements(makeDem(320, 240, 7), options);
    expect(steppe.length).toBeGreaterThan(0);
    expect(steppe.every((prop) => prop.biomeId === 17 && prop.rotation === 0)).toBe(true);
    expect(steppe.length).toBeLessThan(wetland.length * 0.8);

    const geometry = buildVegetationGeometry(makeDem(320, 240, 17), options);
    expect(geometry.stands?.map((stand) => [stand.group, stand.biomeIds])).toEqual([["wetland-shrubs", [17]]]);
    expect(geometry.stands?.[0].geometry.items.length).toBeGreaterThan(0);
    expect(geometry.rasterProps?.some((prop) => prop.assetKey === asset.key)).toBe(false);
  });

  it("keeps the wetland's former shrub density and the forest biomes' tree density as defaults", () => {
    const options = {
      rasterPropDensity: 1.5,
      rasterPropBiomeSettings: { 3: { density: 1.8 }, 7: { density: 2 } },
      wetlandShrubDensity: 1,
    };
    expect(rasterPropSettingsForBiome(options, 3)).toMatchObject({ treeDensity: 1.8, shrubDensity: 0 });
    // The old shrub factor saturated at 2: density × min(1, shrub / 2).
    expect(rasterPropSettingsForBiome(options, 7)).toMatchObject({ treeDensity: 0, shrubDensity: 1 });
    expect(rasterPropSettingsForBiome({ ...options, wetlandShrubDensity: 4 }, 7).shrubDensity).toBe(2);
    expect(rasterPropSettingsForBiome(options, 18)).toMatchObject({ treeDensity: 0, shrubDensity: 0 });
  });

  it("places trees and shrubs in any stand biome from its own densities", () => {
    const dem = makeDem(400, 300, 18);
    for (let y = 0; y < 300; y++) for (let x = 200; x < 400; x++) dem.biomeType[y * 400 + x] = 4;
    const tree = standAsset("tree", "alpine-forest", [4, 18]);
    const shrub = standAsset("shrub", "wetland-forest", [4, 18]);
    const options = {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 1,
      rasterPropCellSize: 16,
      rasterPropAssets: [tree, shrub],
    };
    const count = (placements: VegetationRasterPropPlacement[], biome: number, key: string) =>
      placements.filter((prop) => prop.biomeId === biome && prop.assetKey === key).length;

    // Defaults: trees in the woodland, nothing in the prairie.
    const base = buildVegetationRasterPropPlacements(dem, options);
    expect(count(base, 4, "tree")).toBeGreaterThan(0);
    expect(count(base, 4, "shrub") + count(base, 18, "tree") + count(base, 18, "shrub")).toBe(0);

    const mixed = buildVegetationRasterPropPlacements(dem, {
      ...options,
      rasterPropBiomeSettings: { 4: { treeDensity: 0, shrubDensity: 1 }, 18: { treeDensity: 1, shrubDensity: 1 } },
    });
    expect(count(mixed, 4, "tree")).toBe(0);
    expect(count(mixed, 4, "shrub")).toBeGreaterThan(0);
    // Trees and shrubs sharing a biome both find room.
    expect(count(mixed, 18, "tree")).toBeGreaterThan(0);
    expect(count(mixed, 18, "shrub")).toBeGreaterThan(count(mixed, 4, "shrub") * 0.25);
  });

  it("draws trees among shrubs from each biome's own share", () => {
    const shrub = standAsset("shrub", "wetland-forest", [7, 17]);
    const options = {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 1,
      rasterPropCellSize: 16,
      rasterPropAssets: [shrub],
      wetlandShrubDensity: 2,
      rasterPropBiomeSettings: { 17: { shrubDensity: 1 } },
    };
    const accentTrees = (biome: number, settings: typeof options) =>
      buildVegetationGeometry(makeDem(320, 240, biome), settings).stands!
        .flatMap((stand) => stand.geometry.items)
        .filter((item) => item.fills.some((fill) => fill.style === "accent")).length;
    // The wetland keeps the stand setting; other biomes have none until set.
    expect(accentTrees(7, options)).toBeGreaterThan(0);
    expect(accentTrees(17, options)).toBe(0);
    expect(accentTrees(17, { ...options, rasterPropBiomeSettings: { 17: { shrubDensity: 1, shrubTreeShare: 0.3 } } }))
      .toBeGreaterThan(0);
  });

  it("splits stands only between biomes painted differently", () => {
    const dem = makeDem(400, 300, 7);
    for (let y = 0; y < 300; y++) for (let x = 200; x < 400; x++) dem.biomeType[y * 400 + x] = 17;
    const shrub = standAsset("shrub", "wetland-forest", [7, 17]);
    const options = {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 1,
      rasterPropCellSize: 16,
      rasterPropAssets: [shrub],
      wetlandShrubDensity: 2,
      // The wetland's share of trees among shrubs, so only colour differs.
      rasterPropBiomeSettings: { 17: { shrubDensity: 1, shrubTreeShare: 0.18 } },
    };
    const shared = buildVegetationGeometry(dem, options);
    expect(shared.stands?.map((stand) => stand.biomeIds)).toEqual([[7, 17]]);

    const painted = { ...options, rasterPropBiomeSettings: { 17: { shrubDensity: 1, shrubTreeShare: 0.18, shrubColor: "#c0a060" } } };
    const split = buildVegetationGeometry(dem, painted);
    expect(split.stands?.map((stand) => stand.biomeIds).sort()).toEqual([[17], [7]]);

    // Recolouring keeps the geometry unless it changes which biomes share a stand.
    expect(propStandColorPartition(painted)).not.toBe(propStandColorPartition(options));
    expect(propStandColorPartition({ ...painted, rasterPropBiomeSettings: { 17: { shrubTreeShare: 0.18, shrubColor: "#806040" } } }))
      .toBe(propStandColorPartition(painted));
  });

  it("keeps stands on near-flat ground lit and shades only clearly darker slopes", () => {
    const width = 200;
    const height = 120;
    const forest = new Float32Array(width * height);
    const light = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        forest[index] = x > 10 && x < 190 && y > 20 && y < 100 ? 1 : 0;
        // Left half: flat valley floor with DEM-noise-sized wobble around
        // flat-ground light. Right half: a slope turned away from the sun.
        light[index] = x < 100 ? 0.5 + Math.sin(x * 1.7 + y * 2.3) * 0.04 : 0.3;
      }
    }
    const stands = buildForestStandGeometry({
      width, height, forest, light, treeSize: 8, seed: 3,
      settings: { markSpacing: 0.5, edgeTrees: 0.9, interiorTrees: 0.08, meadowTrees: 0 },
    });
    const shadedAt = (x0: number, x1: number) => {
      let shaded = 0;
      for (let y = 30; y < 90; y++) for (let x = x0; x < x1; x++) if (stands.shade![y * width + x] < 0.5) shaded++;
      return shaded;
    };
    expect(shadedAt(20, 80)).toBe(0);
    expect(shadedAt(120, 180)).toBeGreaterThan(0);
  });

  it("sizes shrub stands from the alpine stand tree size at small prop scales", () => {
    const dem = makeDem(320, 240, 4);
    for (let y = 0; y < 240; y++) for (let x = 160; x < 320; x++) dem.biomeType[y * 320 + x] = 7;
    const alpine = { ...makeAsset("alpine-tree", [4]), outlineGroup: "alpine-forest" };
    const shrub = {
      ...makeAsset("wetland-shrub", [7]),
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 0.8,
      outlineGroup: "wetland-forest",
    };
    const geometry = buildVegetationGeometry(dem, {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 1,
      // Small enough that a per-group 4 px floor would enlarge only the shrubs.
      rasterPropCellSize: 4,
      rasterPropAssets: [alpine, shrub],
      wetlandImagePropDrynessBias: 1,
    });
    const size = (group: string) => geometry.stands?.find((stand) => stand.group === group)?.geometry.treeSize ?? NaN;
    expect(size("wetland-shrubs") / size("alpine-forest")).toBeCloseTo(SHRUB_STAND_PROFILE.size, 5);
  });

  it("rejects alpine trees from cliffs, including the sparse coverage fallback", () => {
    const dem = makeDem(320, 240, 3);
    dem.slopeDeg.fill(60);
    const asset = {
      ...makeAsset("alpine-tree", [2, 3]),
      outlineGroup: "alpine-forest",
    };
    const placements = buildVegetationRasterPropPlacements(dem, {
      seed: 23817,
      rasterPropDensity: 1,
      rasterPropCellSize: 8,
      rasterPropAssets: [asset],
    });

    expect(placements).toEqual([]);
  });

  it("keeps alpine trees viable on moderate slopes", () => {
    const dem = makeDem(320, 240, 3);
    dem.slopeDeg.fill(40);
    const asset = {
      ...makeAsset("alpine-tree", [2, 3]),
      outlineGroup: "alpine-forest",
    };
    const placements = buildVegetationRasterPropPlacements(dem, {
      seed: 23817,
      rasterPropDensity: 1,
      rasterPropCellSize: 8,
      rasterPropAssets: [asset],
    });

    expect(placements.length).toBeGreaterThan(0);
    expect(placements.every(({ x, y }) => dem.slopeDeg[Math.round(y) * dem.width + Math.round(x)] < 50)).toBe(true);
  });

  it("favors wetter terrain using local precipitation and runoff", () => {
    const dryDem = makeDem(64, 64, 3);
    dryDem.precipitationMmYr.fill(350);
    dryDem.runoffDepthMmYr.fill(0);
    const wetDem = makeDem(64, 64, 3);
    wetDem.precipitationMmYr.fill(1800);
    wetDem.runoffDepthMmYr.fill(1000);

    const dry = sampleAlpineForestTerrainSuitability(dryDem, 32, 32);
    const wet = sampleAlpineForestTerrainSuitability(wetDem, 32, 32);

    expect(wet.habitatWeight).toBeGreaterThan(dry.habitatWeight);
  });

  it("retains more trees in a sheltered hollow than on an equally sloped crest", () => {
    const makeReliefDem = () => {
      const dem = makeDem(768, 384, 3);
      dem.slopeDeg.fill(18);
      const sigma = 3;
      for (let y = 0; y < dem.height; y++) {
        for (let x = 0; x < dem.width; x++) {
          const crestDistance = Math.hypot(x - 192, y - 192);
          const hollowDistance = Math.hypot(x - 576, y - 192);
          const crest = Math.exp(-(crestDistance ** 2) / (2 * sigma ** 2));
          const hollow = Math.exp(-(hollowDistance ** 2) / (2 * sigma ** 2));
          dem.elevation[y * dem.width + x] = 400 + 100 * crest - 100 * hollow;
        }
      }
      return dem;
    };
    const dem = makeReliefDem();
    const asset = {
      ...makeAsset("alpine-tree", [3]),
      outlineGroup: "alpine-forest",
    };
    const options = {
      seed: 7919,
      rasterPropDensity: 1,
      rasterPropCellSize: 8,
      rasterPropClustering: 0.55,
      rasterPropAssets: [asset],
    };
    const placements = buildVegetationRasterPropPlacements(dem, options);
    const replay = buildVegetationRasterPropPlacements(makeReliefDem(), options);
    const inWindow = (x: number, y: number, centerX: number) =>
      Math.abs(x - centerX) <= 64 && Math.abs(y - 192) <= 64;
    const crestCount = placements.filter(({ x, y }) => inWindow(x, y, 192)).length;
    const hollowCount = placements.filter(({ x, y }) => inWindow(x, y, 576)).length;

    expect(replay).toEqual(placements);
    expect(hollowCount).toBeGreaterThan(crestCount);
  });

  it("renders the tree suitability heatmap only when its diagnostic is enabled", () => {
    const dem = makeDem(48, 48, 3);
    dem.slopeDeg.fill(60);
    const options = {
      layer: "vegetation_patterns" as const,
      palette: "swiss_topo" as const,
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 1,
      ambientOcclusionStrength: 0,
      showRivers: false,
      riverThresholdKm2: 1,
      showContours: false,
      contourIntervalM: 100,
      showWaterDetails: false,
      wetlandPuddleContours: false,
      skipMountainIllustrationStage: true,
      vegetation: {
        density: 0,
        motifDensity: 0,
        rasterPropDensity: 0,
        rasterPropAssets: [],
      },
    };
    const regular = renderMountainDetailDEMWithCache(dem, options);
    const heatmap = renderMountainDetailDEMWithCache(dem, {
      ...options,
      vegetation: {
        ...options.vegetation,
        showAlpineTreeSuitabilityOverlay: true,
      },
    });
    const sampleOffset = (24 * dem.width + 24) * 4;

    expect(heatmap.data).not.toEqual(regular.data);
    expect(heatmap.data[sampleOffset]).toBeGreaterThan(regular.data[sampleOffset]);
    expect(heatmap.data[sampleOffset + 1]).toBeLessThan(regular.data[sampleOffset + 1]);
  });

  it("uses full rotated footprints for bounds, biome, and water rejection", () => {
    const dem = makeDem();
    const asset = makeAsset("test-tree");
    const rotated = { ...placement(), rotation: Math.PI / 4 };
    const bounds = rasterPropFootprintBounds(rotated, asset);
    expect(bounds.maxX - bounds.minX).toBeCloseTo(Math.hypot(80, 80));
    expect(bounds.maxY - bounds.minY).toBeCloseTo(Math.hypot(80, 80));
    expect(isRasterPropPlacementValid(dem, rotated, asset)).toBe(true);

    dem.visualWaterMask![120 * dem.width + 160] = 1;
    expect(isRasterPropPlacementValid(dem, rotated, asset)).toBe(false);

    const biomeDem = makeDem(320, 240, 4);
    expect(isRasterPropPlacementValid(biomeDem, placement(), asset)).toBe(false);
  });

  it("places registered props only in eligible biomes and reserves variable radii", () => {
    const dem = makeDem();
    const asset = makeAsset("test-tree");
    const geometry = buildVegetationGeometry(dem, {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 1,
      rasterPropCellSize: 16,
      rasterPropAssets: [asset],
    });
    expect(geometry.rasterProps?.length).toBeGreaterThan(0);
    expect(
      geometry.rasterProps?.every((prop) => prop.cellSize === 16),
    ).toBe(true);

    const ineligible = buildVegetationGeometry(makeDem(320, 240, 4), {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 1,
      rasterPropAssets: [asset],
    });
    expect(ineligible.rasterProps).toEqual([]);
  });

  it("finds alpine interiors when clustered sampling misses a small biome region", () => {
    const dem = makeDem(320, 240, 4);
    for (let y = 40; y < 200; y++) {
      for (let x = 80; x < 240; x++) {
        dem.biomeType[y * dem.width + x] = 2;
      }
    }
    const asset = makeAsset("alpine-tree", [2, 3]);
    const geometry = buildVegetationGeometry(dem, {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 0.42,
      rasterPropCellSize: 4,
      rasterPropAssets: [asset],
    });

    expect(geometry.rasterProps?.length).toBeGreaterThan(0);
    expect(geometry.rasterProps?.every((prop) => prop.biomeId === 2)).toBe(true);
    expect(geometry.rasterProps?.every((prop) => prop.cellSize === 4)).toBe(true);
  });

  it("places alpine trees in narrow habitat and honors the scale control", () => {
    const dem = makeDem(320, 240, 4);
    for (let y = 0; y < dem.height; y++) {
      for (let x = 150; x < 170; x++) dem.biomeType[y * dem.width + x] = 2;
    }
    const asset = makeAsset("alpine-tree", [2, 3]);
    for (const cellSize of [4, 16]) {
      const geometry = buildVegetationGeometry(dem, {
        density: 0, motifDensity: 0, rasterPropDensity: 1,
        rasterPropCellSize: cellSize, rasterPropAssets: [asset],
      });
      expect(geometry.rasterProps!.length).toBeGreaterThan(0);
      expect(geometry.rasterProps!.every(p => p.cellSize === cellSize && p.biomeId === 2)).toBe(true);
    }
    const center = { ...placement(), biomeId: 2 };
    expect(isRasterPropPlacementValid(dem, center, asset)).toBe(true);
    for (let y = 80; y < 160; y++) {
      for (let x = 130; x < 145; x++) dem.visualWaterMask![y * dem.width + x] = 1;
    }
    expect(isRasterPropPlacementValid(dem, center, asset)).toBe(false);
  });

  it("applies the normalized tree scale to generated alpine placement size", () => {
    const dem = makeDem(512, 512, 3);
    const asset = {
      ...makeAsset("scaled-alpine-tree", [3]),
      outlineGroup: "alpine-forest",
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 1,
    };
    const options = {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 0.8,
      rasterPropCellSize: 16,
      rasterPropAssets: [asset],
    };
    const base = buildVegetationRasterPropPlacements(dem, { ...options, rasterPropScale: 1 });
    const large = buildVegetationRasterPropPlacements(dem, { ...options, rasterPropScale: 2 });
    expect(base.length).toBeGreaterThan(0);
    expect(large.length).toBeGreaterThan(0);
    expect(new Set(base.map((prop) => prop.cellSize))).toEqual(new Set([4]));
    expect(new Set(large.map((prop) => prop.cellSize))).toEqual(new Set([8]));
  });


  it("forms deterministic overlapping raster clusters", () => {
    const options = {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 1,
      rasterPropCellSize: 16,
      rasterPropAssets: [makeAsset("test-tree")],
    };
    const first = buildVegetationGeometry(makeDem(), options);
    const second = buildVegetationGeometry(makeDem(), options);
    const loose = buildVegetationGeometry(makeDem(), {
      ...options,
      rasterPropClustering: 0,
    });
    const tight = buildVegetationGeometry(makeDem(), {
      ...options,
      rasterPropClustering: 1,
    });
    const broadStands = buildVegetationGeometry(makeDem(), {
      ...options,
      rasterPropStandSize: 1,
    });
    const placements = first.rasterProps ?? [];
    expect(placements.length).toBeGreaterThan(2);
    expect(second.rasterProps).toEqual(placements);
    expect(tight.rasterProps).not.toEqual(loose.rasterProps);
    expect(broadStands.rasterProps).not.toEqual(first.rasterProps);

    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < placements.length; index++) {
      for (let other = index + 1; other < placements.length; other++) {
        nearestDistance = Math.min(
          nearestDistance,
          Math.hypot(
            placements[index].x - placements[other].x,
            placements[index].y - placements[other].y,
          ),
        );
      }
    }
    // The full 5x5 footprint diagonal is 113px. A smaller centre distance
    // proves that accepted props visibly overlap inside a cluster.
    expect(nearestDistance).toBeLessThan(Math.hypot(80, 80));
  });

  it("scales shadow offset by height and softness by square-root height", () => {
    const tree = makeAsset("tree");
    const shrub = {
      ...tree,
      key: "shrub",
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 0.75,
      eligibleBiomeIds: [5, 7],
    };
    const treeMetrics = rasterPropShadowMetrics(placement(), tree, 2.2, 1.1);
    const shrubMetrics = rasterPropShadowMetrics(placement(), shrub, 2.2, 1.1);
    expect(treeMetrics.offset / shrubMetrics.offset).toBeCloseTo(4 / 0.75);
    expect(treeMetrics.softness / shrubMetrics.softness).toBeCloseTo(
      Math.sqrt(4 / 0.75),
    );
  });

  it("renders prop RGBA without raster-prop shadows", () => {
    const dem = makeDem();
    const asset = makeAsset("test-tree");
    const geometry = {
      width: dem.width,
      height: dem.height,
      paths: [],
      motifs: [],
      rasterProps: [placement()],
    };
    const northwestSun = renderVegetationOverlay(dem, geometry, {
      rasterPropAssets: [asset],
      motifShadowStrength: 1,
      motifShadowDistance: 2.2,
      motifShadowSoftness: 1.1,
    }, 315);
    const southeastSun = renderVegetationOverlay(dem, geometry, {
      rasterPropAssets: [asset],
      motifShadowStrength: 1,
      motifShadowDistance: 2.2,
      motifShadowSoftness: 1.1,
    }, 135);
    const noShadow = renderVegetationOverlay(dem, geometry, {
      rasterPropAssets: [asset],
      motifShadowStrength: 1,
      motifShadowDistance: 0,
    });
    expect(northwestSun.rasterPropRGBA.some((value) => value > 0)).toBe(true);
    expect(northwestSun.rasterPropShadowAlpha.every((value) => value === 0)).toBe(true);
    expect(southeastSun.rasterPropShadowAlpha.every((value) => value === 0)).toBe(true);
    expect(noShadow.rasterPropShadowAlpha.every((value) => value === 0)).toBe(true);
  });

  it("draws one outer ring around an isolated or overlapping forest union", () => {
    const dem = makeDem(96, 72, 3);
    const asset = {
      ...makeAsset("outline-tree"),
      renderWidthCells: 1,
      renderHeightCells: 1,
      renderAnchorX: 0.5,
      renderAnchorY: 0.5,
      outlineMode: "alpha-dilation" as const,
      outlineGroup: "forest-outline",
    };
    const isolatedGeometry = {
      width: dem.width,
      height: dem.height,
      paths: [],
      motifs: [],
      rasterProps: [{ ...placement(48, 36), assetKey: asset.key }],
    };
    const isolated = renderVegetationOverlay(dem, isolatedGeometry, {
      rasterPropAssets: [asset],
      strokeOpacity: 1,
    });
    const isolatedCentre = 36 * dem.width + 48;
    expect(isolated.rasterPropRGBA[isolatedCentre * 4 + 3]).toBeGreaterThan(0);
    expect(isolated.rasterPropCharcoalAlpha[isolatedCentre]).toBe(0);
    expect(isolated.rasterPropCharcoalAlpha[36 * dem.width + 39]).toBeGreaterThan(0);

    const overlapping = renderVegetationOverlay(dem, {
      ...isolatedGeometry,
      rasterProps: [
        { ...placement(48, 36), assetKey: asset.key },
        { ...placement(56, 36), assetKey: asset.key },
      ],
    }, {
      rasterPropAssets: [asset],
      strokeOpacity: 1,
    });
    const sharedInterior = 36 * dem.width + 56;
    expect(overlapping.rasterPropRGBA[sharedInterior * 4 + 3]).toBeGreaterThan(0);
    expect(overlapping.rasterPropCharcoalAlpha[sharedInterior]).toBe(0);
  });

  it("includes a footprint crossing a tile seam and excludes distant props", () => {
    const dem = makeDem(128, 128);
    const asset = makeAsset("test-tree");
    const geometry = {
      width: dem.width,
      height: dem.height,
      paths: [],
      motifs: [],
      rasterProps: [placement(64, 64)],
    };
    const seamTile = mapVegetationGeometryToTile(
      geometry,
      128,
      128,
      65,
      0,
      16,
      128,
      [asset],
    );
    const distantTile = mapVegetationGeometryToTile(
      geometry,
      128,
      128,
      150,
      0,
      16,
      128,
      [asset],
    );
    expect(seamTile.rasterProps).toHaveLength(1);
    expect(distantTile.rasterProps).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildVegetationGeometry,
  placeRasterPropsInBiomes,
  rasterPropPlacementBiomes,
  type VegetationRasterPropAsset,
} from "../src/rendering/vegetationRenderer";
import type { MountainDEMData } from "../src/terrain/mountainBaseDEM";
import { groupBiomesForPlacement } from "../src/rendering/parallelPropPlacement";

/** Bands of alpine forest, woodland, grassland and wetland on rolling terrain. */
function mixedBiomeDem(width = 320, height = 240): MountainDEMData {
  const total = width * height;
  const field = (f: (x: number, y: number) => number) => {
    const values = new Float32Array(total);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values[y * width + x] = f(x, y);
    return values;
  };
  const biomeType = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      biomeType[y * width + x] = x < 80 ? 2 : x < 160 ? 4 : x < 240 ? 5 : 7;
    }
  }
  return {
    width, height, domainWidthKm: 32, domainHeightKm: 24, dxMeters: 100, dyMeters: 100,
    minElevationM: 0, maxElevationM: 1000, oceanSurfaceElevationM: 0,
    elevation: field((x, y) => 400 + Math.sin(x * 0.05) * 60 + y * 0.4),
    normalizedElevation: field((x, y) => 0.4 + Math.sin(x * 0.05) * 0.06 + y * 0.0004),
    slopeDeg: field((x) => 3 + Math.abs(Math.sin(x * 0.07)) * 9),
    aspectDeg: field(() => 0), normals: new Float32Array(total * 3), hillshade: field(() => 0.8),
    ambientOcclusion: field(() => 0.8), curvature: field(() => 0), tpi: field(() => 0),
    flowAccumulation: field(() => 0), drainageAreaKm2: field(() => 0), rainfallWeightedAreaKm2: field(() => 0),
    runoffDepthMmYr: field((x, y) => 300 + ((x * 7 + y) % 400)), dischargeM3s: field(() => 0),
    strahlerOrder: new Uint8Array(total), riverCenterlineMask: new Uint8Array(total),
    riverChannelRadius: new Uint8Array(total), riverMouthMask: new Uint8Array(total),
    riverMouthAreaKm2: field(() => 0), isRiverChannel: new Uint8Array(total), waterDepthM: field(() => 0),
    flowDirection: new Int8Array(total).fill(-1), erosionDepthM: field(() => 0),
    precipitationMmYr: field((x) => 900 + 400 * Math.sin(x * 0.02)), solarInsolation: field(() => 0.5),
    temperatureC: field((_x, y) => 14 - y * 0.02), biomeType, isOcean: new Uint8Array(total),
    visualWaterMask: new Uint8Array(total), visualWaterCoverage: field(() => 0),
  };
}

function asset(
  key: string,
  eligibleBiomeIds: number[],
  extra: Partial<VegetationRasterPropAsset> = {},
): VegetationRasterPropAsset {
  const size = 16;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < size * size; index++) data.set([92, 146, 118, 255], index * 4);
  return {
    key, family: "shrub", width: size, height: size, data, kind: "raster-prop",
    footprintWidthCells: 1, footprintHeightCells: 1, heightCells: 0.8, anchorX: 0.5, anchorY: 0.5,
    eligibleBiomeIds, ...extra,
  };
}

const serialize = (value: unknown): string => JSON.stringify(
  value,
  (_key, item) => ArrayBuffer.isView(item) ? Array.from(item as unknown as ArrayLike<number>) : item,
);

describe("biome grouping for parallel placement", () => {
  it("balances biome area times prop kinds over the groups and keeps every biome once", () => {
    // Biome 2 covers 60 cells, 4 covers 30, 5 and 7 cover 5 each.
    const biomeType = [...Array(60).fill(2), ...Array(30).fill(4), ...Array(5).fill(5), ...Array(5).fill(7)];
    const groups = groupBiomesForPlacement(biomeType, [2, 4, 5, 7], new Map([[2, 1], [4, 2], [5, 1], [7, 1]]), 2);
    expect(groups.flat().sort()).toEqual([2, 4, 5, 7]);
    // 60 vs 60 (+5 +5): the two big biomes land in different groups.
    expect(groups.find(group => group.includes(2))).not.toContain(4);
  });
});

describe("parallel raster prop placement", () => {
  it("joins per-biome placements into exactly the single-pass prop geometry", () => {
    const dem = mixedBiomeDem();
    const options = {
      density: 0,
      motifDensity: 0,
      rasterPropDensity: 1.4,
      rasterPropCellSize: 8,
      rasterPropAssets: [
        asset("alpine-tree", [2, 4], { outlineGroup: "alpine-forest" }),
        asset("grass-tuft", [4, 5], { footprintWidthCells: 2, footprintHeightCells: 2 }),
        asset("wetland-shrub", [7], { outlineGroup: "wetland-forest", placementRole: "wetland" }),
      ],
    };
    const whole = buildVegetationGeometry(dem, options, undefined, undefined, "props");
    const biomes = rasterPropPlacementBiomes(options);
    expect(biomes.length).toBeGreaterThan(2);
    // Any grouping works: place odd and even biomes separately, then join in biome order.
    const groups = [biomes.filter((_, index) => index % 2 === 0), biomes.filter((_, index) => index % 2 === 1)];
    const byBiome = new Map<number, unknown[]>();
    for (const group of groups) {
      placeRasterPropsInBiomes(dem, options, group).forEach((list, index) => byBiome.set(group[index], list));
    }
    const joined = biomes.flatMap(biome => byBiome.get(biome) ?? []) as NonNullable<typeof whole.rasterProps>;
    expect(joined.length).toBeGreaterThan(0);
    const split = buildVegetationGeometry(dem, options, undefined, undefined, "props", joined);
    expect(serialize(split)).toBe(serialize(whole));
  });
});

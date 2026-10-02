import { describe, expect, it } from "vitest";
import type { MountainDEMData } from "../src/terrain/mountainBaseDEM";
import {
  buildVegetationGeometry,
  buildVegetationRasterPropPlacements,
  type VegetationRasterPropAsset,
} from "../src/rendering/vegetationRenderer";
import { buildForestPreviewGeometry } from "../src/rendering/forestPropScene";

function makeUniformDem(width: number, height: number): MountainDEMData {
  const total = width * height;
  const floats = () => new Float32Array(total);
  return {
    width,
    height,
    domainWidthKm: 8,
    domainHeightKm: 6,
    dxMeters: 20,
    dyMeters: 20,
    minElevationM: 900,
    maxElevationM: 1300,
    elevation: floats().fill(1100),
    normalizedElevation: floats().fill(0.5),
    slopeDeg: floats().fill(7),
    aspectDeg: floats().fill(180),
    normals: new Float32Array(total * 3),
    hillshade: floats().fill(0.68),
    ambientOcclusion: floats().fill(0.8),
    curvature: floats(),
    tpi: floats(),
    flowAccumulation: floats(),
    drainageAreaKm2: floats(),
    rainfallWeightedAreaKm2: floats(),
    runoffDepthMmYr: floats(),
    dischargeM3s: floats(),
    strahlerOrder: new Uint8Array(total),
    riverCenterlineMask: new Uint8Array(total),
    isRiverChannel: new Uint8Array(total),
    waterDepthM: floats(),
    flowDirection: new Int8Array(total).fill(-1),
    erosionDepthM: floats(),
    precipitationMmYr: floats().fill(1100),
    solarInsolation: floats().fill(0.6),
    temperatureC: floats().fill(5),
    biomeType: new Uint8Array(total).fill(3),
    isOcean: new Uint8Array(total),
  };
}

function makeAlpineAsset(): VegetationRasterPropAsset {
  return {
    key: "alpine-test-tree",
    family: "shrub",
    width: 12,
    height: 16,
    data: new Uint8ClampedArray(12 * 16 * 4),
    kind: "raster-prop",
    footprintWidthCells: 5,
    footprintHeightCells: 6,
    heightCells: 5,
    anchorX: 0.5,
    anchorY: 0.5,
    eligibleBiomeIds: [2, 3],
    outlineGroup: "alpine-forest",
  };
}

describe("forest prop placement preparation", () => {
  it("matches the full vegetation pipeline while using the habitat-only path", () => {
    const dem = makeUniformDem(360, 270);
    const assets = [makeAlpineAsset()];
    const options = {
      seed: 23817,
      density: 0,
      motifDensity: 0,
      wetlandPropDensity: 0,
      wetlandImagePropDensity: 0,
      rasterPropAssets: assets,
      rasterPropDensity: 0.82,
      rasterPropCellSize: 16,
      rasterPropClustering: 0.71,
      rasterPropStandSize: 0.72,
      strokeOpacity: 0.9,
      inkColor: "#30452f",
      flowWashStrength: 0,
      motifShadowStrength: 0,
      showFlowGuides: false,
    };
    const completePipeline = buildVegetationGeometry(dem, options).rasterProps;
    const specializedPipeline = buildVegetationRasterPropPlacements(dem, options);

    expect(specializedPipeline).toEqual(completePipeline);
  });

  it("keeps the forest route's fixed simulation dimensions and placement format", () => {
    const geometry = buildForestPreviewGeometry(0.42, 0.65, 23817, [makeAlpineAsset()]);

    expect(geometry.width).toBe(1536);
    expect(geometry.height).toBe(1152);
    expect(geometry.rasterProps.length).toBeGreaterThan(0);
    expect(geometry.rasterProps.every((placement) => placement.biomeId === 3)).toBe(true);
  });
});

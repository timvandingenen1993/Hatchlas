import { describe, expect, it } from "vitest";
import { cloneLayerDEM } from "../src/rendering/mountainLayerWorkerPool";
import {
  buildVegetationGeometry,
  mergeVegetationGeometry,
  type VegetationRasterPropAsset,
} from "../src/rendering/vegetationRenderer";
import type { MountainDEMData } from "../src/terrain/mountainBaseDEM";

/** Alpine terrain where every field varies, including the ones a default snapshot drops. */
function makeVariedDem(width = 320, height = 240): MountainDEMData {
  const total = width * height;
  const field = (f: (x: number, y: number) => number) => {
    const values = new Float32Array(total);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) values[y * width + x] = f(x, y);
    }
    return values;
  };
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
    elevation: field((x, y) => 400 + Math.sin(x * 0.05) * 60 + y * 0.4),
    normalizedElevation: field((x, y) => 0.4 + Math.sin(x * 0.05) * 0.06 + y * 0.0004),
    slopeDeg: field((x) => 3 + Math.abs(Math.sin(x * 0.07)) * 9),
    aspectDeg: field((x, y) => (x * 7 + y * 3) % 360),
    normals: new Float32Array(total * 3).fill(0.5),
    hillshade: field((x, y) => 0.5 + 0.4 * Math.sin(x * 0.09) * Math.cos(y * 0.07)),
    ambientOcclusion: field((x) => 0.7 + 0.2 * Math.sin(x * 0.03)),
    curvature: field((x, y) => Math.sin(x * 0.1 + y * 0.05) * 0.01),
    tpi: field((x, y) => Math.cos(x * 0.06 - y * 0.04) * 5),
    flowAccumulation: field((x) => (x % 40) * 3),
    drainageAreaKm2: field((x) => (x % 40) * 0.1),
    rainfallWeightedAreaKm2: field((x) => (x % 40) * 0.1),
    runoffDepthMmYr: field((x, y) => 200 + 700 * Math.abs(Math.sin(x * 0.04 + y * 0.03))),
    dischargeM3s: field((x) => (x % 40) * 0.2),
    strahlerOrder: new Uint8Array(total),
    riverCenterlineMask: new Uint8Array(total),
    riverChannelRadius: new Uint8Array(total),
    riverMouthMask: new Uint8Array(total),
    riverMouthAreaKm2: new Float32Array(total),
    isRiverChannel: new Uint8Array(total),
    waterDepthM: field((x) => (x % 50 === 0 ? 1 : 0)),
    flowDirection: new Int8Array(total).fill(-1),
    erosionDepthM: field((x, y) => ((x + y) % 9) * 0.1),
    precipitationMmYr: field((x) => 900 + 400 * Math.sin(x * 0.02)),
    solarInsolation: field((_x, y) => 0.5 + 0.3 * Math.sin(y * 0.05)),
    temperatureC: field((_x, y) => 14 - y * 0.02),
    biomeType: new Uint8Array(total).fill(4),
    isOcean: new Uint8Array(total),
    visualWaterMask: new Uint8Array(total),
    visualWaterCoverage: new Float32Array(total),
  };
}

function alpineTreeAsset(): VegetationRasterPropAsset {
  const size = 32;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < size * size; index++) data.set([92, 146, 118, 255], index * 4);
  return {
    key: "alpine-tree",
    family: "shrub",
    width: size,
    height: size,
    data,
    kind: "raster-prop",
    footprintWidthCells: 1,
    footprintHeightCells: 1,
    heightCells: 0.8,
    anchorX: 0.5,
    anchorY: 0.5,
    eligibleBiomeIds: [4],
    outlineGroup: "alpine-forest",
  };
}

const serialize = (value: unknown): string => JSON.stringify(
  value,
  (_key, item) => ArrayBuffer.isView(item) ? Array.from(item as unknown as ArrayLike<number>) : item,
);

describe("layer worker DEM snapshot", () => {
  const options = {
    density: 0.8,
    motifDensity: 0,
    rasterPropDensity: 1.5,
    rasterPropCellSize: 8,
    rasterPropAssets: [alpineTreeAsset()],
  };

  it("builds export vegetation halves identical to a local build", () => {
    const dem = makeVariedDem();
    const local = buildVegetationGeometry(dem, options);
    expect(local.stands?.length).toBeGreaterThan(0);
    const snapshot = cloneLayerDEM(dem, undefined, true);
    const halves = mergeVegetationGeometry(
      buildVegetationGeometry(snapshot, options, undefined, undefined, "flow"),
      buildVegetationGeometry(snapshot, options, undefined, undefined, "props"),
    );
    expect(serialize(halves)).toBe(serialize(local));
  });

  it("differs without hillshade and runoff, so the fidelity test can fail", () => {
    const dem = makeVariedDem();
    const local = buildVegetationGeometry(dem, options);
    const reduced = buildVegetationGeometry(cloneLayerDEM(dem), options);
    expect(serialize(reduced)).not.toBe(serialize(local));
  });
});

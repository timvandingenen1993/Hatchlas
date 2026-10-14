import { describe, expect, it } from "vitest";
import { traceGrassBiomeBorders as traceBorders, type BiomeBorderPath } from "../src/rendering/biomeBorderInk";
import {
  buildVegetationGeometry,
  GRASS_GROUND_BIOME_IDS,
  withMountainGrassGround,
  type VegetationMotifAsset,
} from "../src/rendering/vegetationRenderer";

const traceGrassBiomeBorders = (dem: MountainDEMData): BiomeBorderPath[] => traceBorders(dem, GRASS_GROUND_BIOME_IDS);
import type { MountainDEMData } from "../src/terrain/mountainBaseDEM";

const lineMotif: VegetationMotifAsset = {
  key: "line",
  family: "universal",
  width: 64,
  height: 40,
  data: new Uint8ClampedArray(),
  vectorPaths: [{ strokeWidth: 3, points: [{ x: 0, y: 20 }, { x: 64, y: 20 }] }],
};

const WIDTH = 120;
const HEIGHT = 90;

/** A biome map from a per-pixel rule, with optional water. */
function biomeDem(
  biomeAt: (x: number, y: number) => number,
  waterAt: (x: number, y: number) => boolean = () => false,
  siltAt: (x: number, y: number) => number = () => 0,
): MountainDEMData {
  const total = WIDTH * HEIGHT;
  const biomeType = new Uint8Array(total);
  const visualWaterMask = new Uint8Array(total);
  const siltDepth = new Float32Array(total);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      biomeType[y * WIDTH + x] = biomeAt(x, y);
      visualWaterMask[y * WIDTH + x] = waterAt(x, y) ? 1 : 0;
      siltDepth[y * WIDTH + x] = siltAt(x, y);
    }
  }
  return {
    width: WIDTH,
    height: HEIGHT,
    domainWidthKm: 12,
    domainHeightKm: 9,
    dxMeters: 100,
    dyMeters: 100,
    minElevationM: 0,
    maxElevationM: 500,
    elevation: new Float32Array(total).fill(200),
    normalizedElevation: new Float32Array(total).fill(0.4),
    slopeDeg: new Float32Array(total).fill(2),
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
    isRiverChannel: new Uint8Array(total),
    waterDepthM: new Float32Array(total),
    flowDirection: new Int8Array(total).fill(-1),
    erosionDepthM: new Float32Array(total),
    precipitationMmYr: new Float32Array(total).fill(1000),
    solarInsolation: new Float32Array(total).fill(0.6),
    temperatureC: new Float32Array(total).fill(12),
    biomeType,
    isOcean: new Uint8Array(total),
    visualWaterMask,
    visualWaterCoverage: new Float32Array(total),
    siltDepth,
  };
}

function totalLength(borders: readonly BiomeBorderPath[]): number {
  let length = 0;
  for (const border of borders) {
    for (let index = 1; index < border.points.length; index++) {
      const a = border.points[index - 1];
      const b = border.points[index];
      length += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return length;
}

/** Biome a few pixels along each segment's (-dy, dx) normal. */
function biomesOnNormalSide(dem: MountainDEMData, border: BiomeBorderPath, distance = 4): number[] {
  const biomes: number[] = [];
  for (let index = 1; index < border.points.length; index++) {
    const a = border.points[index - 1];
    const b = border.points[index];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-6) continue;
    const x = Math.round((a.x + b.x) / 2 - ((b.y - a.y) / length) * distance);
    const y = Math.round((a.y + b.y) / 2 + ((b.x - a.x) / length) * distance);
    if (x < 0 || y < 0 || x >= dem.width || y >= dem.height) continue;
    biomes.push(dem.biomeType[y * dem.width + x]);
  }
  return biomes;
}

describe("grass biome border tracing", () => {
  it("counts every biome whose flow lines draw grass, but not deserts or forest", () => {
    for (const biomeId of [2, 4, 5, 7, 17, 18, 19, 20]) expect(GRASS_GROUND_BIOME_IDS.has(biomeId)).toBe(true);
    for (const biomeId of [0, 1, 3, 6, 8, 9, 15, 16]) expect(GRASS_GROUND_BIOME_IDS.has(biomeId)).toBe(false);
  });

  it("traces a grass/forest border as one smooth line with the grass on its normal side", () => {
    // A stair-stepped diagonal between grassland (18) and conifer forest (3).
    const dem = biomeDem((x, y) => (x + Math.floor(y / 3) * 3 < 70 ? 18 : 3));
    const borders = traceGrassBiomeBorders(dem);
    expect(borders.length).toBe(1);
    expect(borders[0].biomeId).toBe(18);
    expect(totalLength(borders)).toBeGreaterThan(HEIGHT * 0.8);
    const normalSide = biomesOnNormalSide(dem, borders[0]);
    expect(normalSide.length).toBeGreaterThan(20);
    expect(normalSide.every((biome) => biome === 18)).toBe(true);
    // Smoothed: consecutive headings never turn by a right angle, as the
    // raw raster steps would.
    const points = borders[0].points;
    for (let index = 2; index < points.length; index++) {
      const h0 = Math.atan2(points[index - 1].y - points[index - 2].y, points[index - 1].x - points[index - 2].x);
      const h1 = Math.atan2(points[index].y - points[index - 1].y, points[index].x - points[index - 1].x);
      const turn = Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0)));
      expect(turn).toBeLessThan(Math.PI / 3);
    }
  });

  it("ignores borders that have no grass biome on either side", () => {
    // Subalpine conifer forest against bare rock.
    const dem = biomeDem((x) => (x < 60 ? 3 : 1));
    expect(traceGrassBiomeBorders(dem)).toEqual([]);
  });

  it("leaves shorelines to the water ink", () => {
    // Grassland meets a lake on the right instead of another biome.
    const dem = biomeDem(() => 18, (x) => x >= 60);
    expect(traceGrassBiomeBorders(dem)).toEqual([]);
  });

  it("does not ink a grass border where it runs along water", () => {
    // Grass/forest border at x = 60; the lower half of it is a river.
    const withRiver = biomeDem(
      (x) => (x < 60 ? 18 : 3),
      (x, y) => y >= 45 && x >= 56 && x <= 64,
    );
    const dry = biomeDem((x) => (x < 60 ? 18 : 3));
    const dryLength = totalLength(traceGrassBiomeBorders(dry));
    const riverLength = totalLength(traceGrassBiomeBorders(withRiver));
    expect(riverLength).toBeGreaterThan(dryLength * 0.3);
    expect(riverLength).toBeLessThan(dryLength * 0.65);
  });

  it("draws a border between two grass biomes once, from the lower biome id", () => {
    const dem = biomeDem((x) => (x < 60 ? 20 : 18));
    const borders = traceGrassBiomeBorders(dem);
    expect(borders.length).toBe(1);
    expect(borders[0].biomeId).toBe(18);
    expect(biomesOnNormalSide(dem, borders[0]).every((biome) => biome === 18)).toBe(true);
  });

  it("inks the edge of river silt laid over a grass biome, with the grass outside", () => {
    // Wetland everywhere; a silted old channel runs down the middle.
    const silt = (x: number): number => Math.max(0, 1 - Math.abs(x - 60) / 12);
    const dem = biomeDem(() => 7, () => false, silt);
    const borders = traceGrassBiomeBorders(dem);
    expect(borders.length).toBe(2);
    expect(borders.every((border) => border.biomeId === 7)).toBe(true);
    for (const border of borders) {
      // Each line runs along a silt edge, at x = 48 or x = 72.
      const meanX = border.points.reduce((sum, point) => sum + point.x, 0) / border.points.length;
      expect(Math.min(Math.abs(meanX - 48), Math.abs(meanX - 72))).toBeLessThan(1.5);
      const sideX = biomesOnNormalSide(dem, border).length;
      expect(sideX).toBeGreaterThan(20);
      // The grass side has no silt.
      for (let index = 1; index < border.points.length; index++) {
        const a = border.points[index - 1];
        const b = border.points[index];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length < 1e-6) continue;
        const x = Math.round((a.x + b.x) / 2 - ((b.y - a.y) / length) * 4);
        expect(silt(x)).toBe(0);
      }
    }
    expect(traceGrassBiomeBorders(biomeDem(() => 7))).toEqual([]);
  });

  it("closes the border of an enclosed grass patch", () => {
    const dem = biomeDem((x, y) => (Math.hypot(x - 60, y - 45) < 20 ? 17 : 3));
    const borders = traceGrassBiomeBorders(dem);
    expect(borders.length).toBe(1);
    const points = borders[0].points;
    const first = points[0];
    const last = points[points.length - 1];
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(1.5);
    expect(totalLength(borders)).toBeGreaterThan(2 * Math.PI * 20 * 0.9);
    expect(biomesOnNormalSide(dem, borders[0]).every((biome) => biome === 17)).toBe(true);
  });
});

describe("grass flats in the mountain belts", () => {
  it("draws the land tint's flat green ground as meadow with an inked border", () => {
    // Bare rock (1) everywhere; the left half is flat, the right half steep.
    const dem = biomeDem(() => 1);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      dem.slopeDeg[y * WIDTH + x] = x < 60 ? 3 : 30;
    }
    const ground = withMountainGrassGround(dem);
    expect(ground.biomeType[30 * WIDTH + 20]).toBe(20);
    expect(ground.biomeType[30 * WIDTH + 100]).toBe(1);
    expect(dem.biomeType[30 * WIDTH + 20]).toBe(1);
    const borders = traceGrassBiomeBorders(ground);
    expect(borders.length).toBe(1);
    expect(borders[0].biomeId).toBe(20);
    const geometry = buildVegetationGeometry(dem, { density: 1.5, motifAssets: [lineMotif] }, undefined, undefined, "flow");
    expect(geometry.paths.some((path) => path.border && path.biomeId === 20)).toBe(true);
    // The flats also get ordinary flow lines, which bare rock never has.
    expect(geometry.paths.some((path) => !path.border)).toBe(true);
  });

  it("lets the side without stands draw a border between two grass biomes", () => {
    // Montane woodland (4) carries tree stands by default; meadow (20) does not.
    const dem = biomeDem((x) => (x < 60 ? 20 : 4));
    const geometry = buildVegetationGeometry(dem, { density: 0, motifAssets: [lineMotif] }, undefined, undefined, "flow");
    const borders = geometry.paths.filter((path) => path.border);
    expect(borders.length).toBe(1);
    expect(borders[0].biomeId).toBe(20);
  });
});

describe("inked biome borders in the vegetation geometry", () => {
  const options = { density: 0, motifAssets: [lineMotif], motifDensity: 0.4 };

  it("strings the grass biome's marks end to end along its border", () => {
    const dem = biomeDem((x) => (x < 60 ? 18 : 3));
    const geometry = buildVegetationGeometry(dem, options, undefined, undefined, "flow");
    expect(geometry.paths.length).toBe(1);
    const path = geometry.paths[0];
    expect(path.biomeId).toBe(18);
    expect(path.border).toBe(true);
    const motifs = geometry.motifs.filter((motif) => motif.pathKey === path.key);
    expect(motifs.length).toBe(geometry.motifs.length);
    expect(motifs.every((motif) => motif.biomeId === 18)).toBe(true);
    // Packed like a line, not spaced out by the low motif density.
    let length = 0;
    for (let index = 1; index < path.points.length; index++) {
      length += Math.hypot(path.points[index].x - path.points[index - 1].x, path.points[index].y - path.points[index - 1].y);
    }
    const largestMark = 14;
    const gaps = motifs.slice(1).map((motif, index) => (motif.pathT! - motifs[index].pathT!) * length);
    expect(Math.max(...gaps)).toBeLessThan(largestMark * 1.6);
  });

  it("follows the flow-line motif density", () => {
    const dem = biomeDem((x) => (x < 60 ? 18 : 3));
    const geometry = buildVegetationGeometry(dem, { ...options, motifDensity: 0 }, undefined, undefined, "flow");
    expect(geometry.paths).toEqual([]);
    expect(geometry.motifs).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SimplexNoise } from "../src/core/noise";
import type { MountainDEMData } from "../src/terrain/mountainBaseDEM";
import {
  PoissonGrid,
  createCharcoalStrokeRuns,
  getContourTangentAt,
  hash01,
} from "../src/rendering/cartographicStrokeRenderer";
import { renderMountainDetailDEM } from "../src/rendering/mountainDetailRenderer";
import { encodeRgbaPngRows } from "../src/utils/pngEncoding";
import {
  buildVegetationGeometry,
  mergeVegetationGeometry,
  mergeVegetationOverlay,
  buildForestCandidates,
  createVegetationPathDistanceTesterForTesting,
  mapVegetationGeometryToTile,
  placeMotifsAlongPath,
  rasterPropFootprintBounds,
  rasterPropRenderBounds,
  renderVegetationOverlay,
  resolveVegetationPatternOptions,
  sampleVegetationDirectionAt,
  type VegetationMotifAsset,
  type VegetationMotifFamily,
  type VegetationGeometry,
  type VegetationRasterPropAsset,
  type VegetationStrokePath,
} from "../src/rendering/vegetationRenderer";

function makeVegetationDem(width = 96, height = 72): MountainDEMData {
  const total = width * height;
  const elevation = new Float32Array(total);
  const slopeDeg = new Float32Array(total);
  const biomeType = new Uint8Array(total);
  const isOcean = new Uint8Array(total);
  const isRiverChannel = new Uint8Array(total);
  const visualWaterMask = new Uint8Array(total);
  const visualWaterCoverage = new Float32Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      elevation[index] = 300 + y * 2 + Math.sin(x * 0.11) * 24;
      slopeDeg[index] = 3 + Math.abs(Math.sin(x * 0.08)) * 6;
      biomeType[index] = y < height / 3 ? 2 : y < (height * 2) / 3 ? 5 : 7;
      if (x >= 45 && x <= 49) {
        isRiverChannel[index] = 1;
        visualWaterMask[index] = 1;
        visualWaterCoverage[index] = 1;
        biomeType[index] = 6;
      }
      if (x < 4 || x >= width - 4 || y < 4 || y >= height - 4) biomeType[index] = 3;
    }
  }
  return {
    width,
    height,
    domainWidthKm: 18,
    domainHeightKm: 13.5,
    dxMeters: 187.5,
    dyMeters: 187.5,
    minElevationM: 100,
    maxElevationM: 1000,
    elevation,
    normalizedElevation: new Float32Array(total).fill(0.4),
    slopeDeg,
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
    isRiverChannel,
    waterDepthM: new Float32Array(total),
    flowDirection: new Int8Array(total).fill(-1),
    erosionDepthM: new Float32Array(total),
    precipitationMmYr: new Float32Array(total).fill(1250),
    solarInsolation: new Float32Array(total).fill(0.6),
    temperatureC: new Float32Array(total).fill(12),
    biomeType,
    isOcean,
    visualWaterMask,
    visualWaterCoverage,
  };
}

const dotAsset: VegetationMotifAsset = {
  key: "grass-blades",
  family: "grass",
  width: 1,
  height: 1,
  data: new Uint8ClampedArray([0, 0, 0, 255]),
};

const grassDotAssets: VegetationMotifAsset[] = [
  dotAsset,
  { ...dotAsset, key: "grass-hook" },
  { ...dotAsset, key: "grass-seedheads" },
];

function makeAuditMotif(key: string, family: VegetationMotifFamily): VegetationMotifAsset {
  const width = 64;
  const height = 40;
  const data = new Uint8ClampedArray(width * height * 4);
  const plot = (x: number, y: number, radius = 1): void => {
    for (let oy = -radius; oy <= radius; oy++) {
      for (let ox = -radius; ox <= radius; ox++) {
        const px = Math.round(x + ox);
        const py = Math.round(y + oy);
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        data[(py * width + px) * 4 + 3] = 255;
      }
    }
  };
  const line = (x0: number, y0: number, x1: number, y1: number): void => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.5));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      plot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  };
  const polyline = (points: readonly [number, number][]): void => {
    for (let index = 1; index < points.length; index++) {
      line(points[index - 1][0], points[index - 1][1], points[index][0], points[index][1]);
    }
  };

  if (key === "line-01") {
    polyline([[4, 21], [15, 19], [31, 19], [48, 18], [63, 17]]);
  } else if (key === "dots-01") {
    for (const x of [7, 21, 33, 46]) line(x, 26, x, 23 + (x % 3));
  } else if (key === "shrub-02") {
    polyline([[3, 25], [11, 18], [21, 13], [25, 13], [19, 23], [31, 20], [46, 21]]);
    line(50, 22, 61, 21);
  } else if (key === "shrub-03") {
    polyline([[8, 29], [9, 12], [21, 22], [31, 14], [40, 24], [53, 21]]);
  } else if (key === "reeds-01") {
    // The current reeds01.svg is a single horizontal scalloped stroke (the
    // same source artwork as shrub04.svg), so keep the audit silhouette honest
    // until that asset is replaced with dedicated reed artwork.
    const points: [number, number][] = [];
    for (let x = 6; x <= 58; x += 1) {
      points.push([x, 27 - Math.abs(Math.sin((x - 6) * 0.42)) * 7]);
    }
    polyline(points);
  } else {
    // Scalloped shrub silhouettes matching the production shrub-01/-04 role,
    // rather than the old identical post-and-diagonal placeholder.
    const points: [number, number][] = [];
    for (let x = 6; x <= 58; x += 1) {
      const wave = Math.abs(Math.sin((x - 6) * (key === "shrub-04" ? 0.42 : 0.34)));
      points.push([x, 27 - wave * (key === "shrub-04" ? 7 : 10)]);
    }
    polyline(points);
  }
  return { key, family, width, height, data };
}

describe("procedural vegetation flow renderer", () => {
  it("computes an analytic isoline tangent with the expected orientation", () => {
    const width = 20;
    const height = 14;
    const field = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) field[y * width + x] = x;
    }
    const tangent = getContourTangentAt(field, width, height, 9.5, 7);
    expect(tangent.valid).toBe(true);
    expect(Math.abs(tangent.tx)).toBeLessThan(1e-6);
    expect(tangent.ty).toBeCloseTo(1, 6);
  });

  it("keeps flow-line exclusion radii separated by their sum", () => {
    const poisson = new PoissonGrid(100, 100, 5);
    poisson.add(20, 20, 5);

    expect(poisson.isClear(29.99, 20, 5)).toBe(false);
    expect(poisson.isClear(30, 20, 5)).toBe(true);
    expect(poisson.isClear(27.99, 20, 3)).toBe(false);
    expect(poisson.isClear(28, 20, 3)).toBe(true);
  });

  it("keeps sparse Poisson buckets equivalent to the original dense grid", () => {
    const width = 73;
    const height = 59;
    const minimumRadius = 3.7;
    const cellSize = Math.max(1, minimumRadius / Math.SQRT2);
    const columns = Math.ceil(width / cellSize);
    const rows = Math.ceil(height / cellSize);
    const denseGrid = Array.from({ length: columns * rows }, () => [] as number[]);
    const points: Array<{ x: number; y: number; radius: number }> = [];
    let maximumRadius = 0;
    const denseIsClear = (x: number, y: number, radius: number): boolean => {
      if (x < 0 || x >= width || y < 0 || y >= height) return false;
      const gx = Math.floor(x / cellSize);
      const gy = Math.floor(y / cellSize);
      const reach = Math.ceil((radius + maximumRadius) / cellSize) + 1;
      for (let oy = -reach; oy <= reach; oy++) {
        const row = gy + oy;
        if (row < 0 || row >= rows) continue;
        for (let ox = -reach; ox <= reach; ox++) {
          const column = gx + ox;
          if (column < 0 || column >= columns) continue;
          for (const pointIndex of denseGrid[row * columns + column]) {
            const point = points[pointIndex];
            const required = radius + point.radius;
            const dx = x - point.x;
            const dy = y - point.y;
            if (dx * dx + dy * dy < required * required) return false;
          }
        }
      }
      return true;
    };
    const denseAdd = (x: number, y: number, radius: number): void => {
      const index = points.length;
      points.push({ x, y, radius });
      maximumRadius = Math.max(maximumRadius, radius);
      denseGrid[Math.floor(y / cellSize) * columns + Math.floor(x / cellSize)].push(index);
    };
    const sparse = new PoissonGrid(width, height, minimumRadius);
    const probes = [
      [-0.01, 4, 2], [width, 8, 2], [0, 0, 0.5], [width - 0.01, height - 0.01, 1],
      ...Array.from({ length: 700 }, (_, index) => [
        (index * 37.13) % (width + 3) - 1.5,
        (index * 19.77) % (height + 3) - 1.5,
        0.25 + (index % 11) * 0.63,
      ] as const),
    ];

    for (const [x, y, radius] of probes) {
      const expected = denseIsClear(x, y, radius);
      expect(sparse.isClear(x, y, radius)).toBe(expected);
      if (expected) {
        denseAdd(x, y, radius);
        sparse.add(x, y, radius);
      }
    }
  });

  it("keeps indexed forest clearings identical to checking every clearing", () => {
    const width = 96;
    const height = 72;
    const canopySize = 28;
    const options = resolveVegetationPatternOptions({
      seed: 19273,
      rasterPropDensity: 0.85,
      rasterPropStandSize: 0.7,
      rasterPropClustering: 0.62,
    });
    const gapScale = Math.min(
      canopySize * (3.5 + options.rasterPropStandSize * 7),
      Math.min(width, height) * (0.2 + options.rasterPropStandSize * 0.24),
    );
    const gaps = Array.from({ length: Math.ceil(width * height / (gapScale * gapScale) * 0.7) }, (_, index) => {
      const key = Math.imul(index + 1, 1597334677) ^ options.seed ^ 0x3c6ef372;
      const angle = hash01(key, 901) * Math.PI * 2;
      return {
        x: hash01(key, 903) * width,
        y: hash01(key, 907) * height,
        radius: gapScale * (0.4 + hash01(key, 909) * 0.8),
        aspect: 0.45 + hash01(key, 913) * 0.5,
        cos: Math.cos(angle),
        sin: Math.sin(angle),
        phase: hash01(key, 917) * Math.PI * 2,
      };
    });
    const smoothStep = (edge0: number, edge1: number, value: number): number => {
      const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(1e-6, edge1 - edge0)));
      return t * t * (3 - 2 * t);
    };
    const attempts = Math.ceil(width * height / Math.max(16, canopySize * canopySize * 0.11) * options.rasterPropDensity);
    const expected: Array<{ key: number; x: number; y: number }> = [];
    for (let index = 0; index < attempts; index++) {
      const key = Math.imul(index + 1, 3812015801) ^ options.seed;
      const x = hash01(key, 911) * width;
      const y = hash01(key, 919) * height;
      let woodland = 1;
      for (const gap of gaps) {
        const dx = x - gap.x;
        const dy = y - gap.y;
        const u = (dx * gap.cos + dy * gap.sin) / gap.radius;
        const v = (-dx * gap.sin + dy * gap.cos) / (gap.radius * gap.aspect);
        const angle = Math.atan2(v, u);
        const edge = 1 + 0.18 * Math.sin(angle * 3 + gap.phase) + 0.1 * Math.sin(angle * 5 - gap.phase);
        woodland = Math.min(woodland, smoothStep(0.8, 1.25, Math.hypot(u, v) / edge));
      }
      const scatteredFraction = (1 - options.rasterPropClustering) ** 3;
      const presence = scatteredFraction + (1 - scatteredFraction) * woodland;
      if (hash01(key, 929) < presence) expected.push({ key, x, y });
    }

    expect(buildForestCandidates({ width, height }, canopySize, options)).toEqual(expected);
  });

  it("uses placement noise scale to change clearing size while staying seeded", () => {
    const base = {
      seed: 6412,
      rasterPropDensity: 0.8,
      rasterPropClustering: 0.72,
      rasterPropStandSize: 0.5,
    };
    const fineOptions = resolveVegetationPatternOptions({
      ...base,
      rasterPropPlacementNoiseScale: 0.5,
    });
    const broadOptions = resolveVegetationPatternOptions({
      ...base,
      rasterPropPlacementNoiseScale: 2,
    });
    const fine = buildForestCandidates({ width: 160, height: 120 }, 18, fineOptions);
    const fineReplay = buildForestCandidates({ width: 160, height: 120 }, 18, fineOptions);
    const broad = buildForestCandidates({ width: 160, height: 120 }, 18, broadOptions);

    expect(fine).toEqual(fineReplay);
    expect(fine).not.toEqual(broad);
  });

  it("is deterministic for one seed and changes for another", () => {
    const dem = makeVegetationDem();
    const first = buildVegetationGeometry(dem, { seed: 42, density: 1.7 });
    const replay = buildVegetationGeometry(dem, { seed: 42, density: 1.7 });
    const changed = buildVegetationGeometry(dem, { seed: 43, density: 1.7 });
    expect(first.paths.length).toBeGreaterThan(0);
    expect(first).toEqual(replay);
    expect(changed.paths).not.toEqual(first.paths);
  });

  it("keeps every generated point in eligible dry biomes", () => {
    const dem = makeVegetationDem();
    const geometry = buildVegetationGeometry(dem, { seed: 77, density: 2 });
    for (const path of geometry.paths) {
      for (const point of path.points) {
        const x = Math.round(point.x);
        const y = Math.round(point.y);
        const index = y * dem.width + x;
        expect([2, 5, 7]).toContain(dem.biomeType[index]);
        expect(dem.isRiverChannel[index]).toBe(0);
        expect(dem.visualWaterCoverage?.[index]).toBe(0);
      }
    }
  });

  it("returns finite unit flow directions and responds to controls", () => {
    const dem = makeVegetationDem();
    const landMask = new Uint8Array(dem.width * dem.height).fill(1);
    for (let index = 0; index < landMask.length; index++) {
      if (dem.isRiverChannel[index] === 1) landMask[index] = 0;
    }
    const waterDistance = new Float32Array(landMask.length).fill(20);
    const options = resolveVegetationPatternOptions({ swirlStrength: 0.8, terrainFollowing: 0.4 });
    const direction = sampleVegetationDirectionAt(
      dem,
      waterDistance,
      new SimplexNoise(99),
      30,
      30,
      options,
    );
    expect(direction.valid).toBe(true);
    expect(Number.isFinite(direction.x)).toBe(true);
    expect(Number.isFinite(direction.y)).toBe(true);
    expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(1, 6);
    expect(buildVegetationGeometry(dem, { density: 0 }).paths).toHaveLength(0);
  });

  it("allows lower vegetation flow stroke thickness", () => {
    expect(
      resolveVegetationPatternOptions({ strokeThickness: 0.1 }).strokeThickness,
    ).toBe(0.1);
    expect(
      resolveVegetationPatternOptions({ strokeThickness: 0 }).strokeThickness,
    ).toBe(0.1);
    const extended = resolveVegetationPatternOptions({ density: 3, patternScale: 3, strokeLength: 4,
      flowWashNoiseScale: 4, wetlandDryDistanceEnd: 240, motifShadowSoftness: 10,
      washShadowDistance: 12, washShadowGap: 10 });
    expect(extended).toMatchObject({ density: 3, patternScale: 3, strokeLength: 4,
      flowWashNoiseScale: 4, wetlandDryDistanceEnd: 240, motifShadowSoftness: 10,
      washShadowDistance: 12, washShadowGap: 10 });
  });

  it("applies density, scale, flow, length, thickness, and motif controls independently", () => {
    const dem = makeVegetationDem();
    const sparse = buildVegetationGeometry(dem, { seed: 501, density: 0.45 });
    const dense = buildVegetationGeometry(dem, { seed: 501, density: 2 });
    expect(dense.paths.length).toBeGreaterThan(sparse.paths.length);

    const short = buildVegetationGeometry(dem, { seed: 502, density: 2, strokeLength: 0.4 });
    const long = buildVegetationGeometry(dem, { seed: 502, density: 2, strokeLength: 2.5 });
    const averageLength = (paths: typeof short.paths) =>
      paths.reduce((sum, path) => sum + path.points.length, 0) / Math.max(1, paths.length);
    expect(averageLength(long.paths)).toBeGreaterThan(averageLength(short.paths));

    const calm = buildVegetationGeometry(dem, {
      seed: 503,
      density: 2,
      patternScale: 0.6,
      swirlStrength: 0,
      terrainFollowing: 1,
      motifDensity: 0,
    });
    const swirling = buildVegetationGeometry(dem, {
      seed: 503,
      density: 2,
      patternScale: 1.4,
      swirlStrength: 1,
      terrainFollowing: 0,
      motifDensity: 1.5,
      motifSize: 2,
    });
    expect(swirling.paths).not.toEqual(calm.paths);
    expect(calm.motifs).toHaveLength(0);
    expect(swirling.motifs.length).toBeGreaterThan(0);
    expect(swirling.motifs.length).toBeGreaterThanOrEqual(swirling.paths.length);
    expect(swirling.motifs.every((motif) => motif.size >= 18)).toBe(true);

    const geometry = buildVegetationGeometry(dem, { seed: 504, density: 2, motifDensity: 0 });
    const thin = renderVegetationOverlay(dem, geometry, { strokeThickness: 0.1, strokeOpacity: 1 });
    const thick = renderVegetationOverlay(dem, geometry, { strokeThickness: 3, strokeOpacity: 1 });
    expect(thick.alpha.filter((value) => value > 0).length).toBeGreaterThan(
      thin.alpha.filter((value) => value > 0).length,
    );
  });

  it("keeps the requested long, low-density marks as separated fragments", () => {
    const dem = makeVegetationDem(240, 180);
    const geometry = buildVegetationGeometry(dem, {
      seed: 23817,
      density: 1,
      patternScale: 1.35,
      swirlStrength: 0.1,
      terrainFollowing: 0.2,
      strokeLength: 2.3,
      motifDensity: 0.25,
      motifSize: 0.8,
    });
    expect(geometry.paths.length).toBeGreaterThan(0);
    expect(geometry.motifs.length).toBeGreaterThan(0);

    const motifsPerPath = new Map<number, number>();
    for (const motif of geometry.motifs) {
      expect(motif.pathKey).toBeTypeOf("number");
      motifsPerPath.set(
        motif.pathKey!,
        (motifsPerPath.get(motif.pathKey!) ?? 0) + 1,
      );
    }
    expect(Math.max(...motifsPerPath.values())).toBeLessThanOrEqual(2);
  });

  it("spaces flow marks by their rendered length plus twice the stroke radius", () => {
    const dem = makeVegetationDem(240, 72);
    const asset: VegetationMotifAsset = {
      key: "spacing-line",
      family: "universal",
      width: 64,
      height: 40,
      data: new Uint8ClampedArray(),
      vectorPaths: [{
        strokeWidth: 3,
        points: [{ x: 0, y: 20 }, { x: 64, y: 20 }],
      }],
    };
    const path = {
      key: 8701,
      biomeId: 5,
      width: 1,
      dashPhase: 0,
      points: [{ x: 10, y: 24 }, { x: 230, y: 24 }],
    };
    const options = resolveVegetationPatternOptions({
      preset: "universal",
      motifAssets: [asset],
      motifDensity: 1.5,
      motifSize: 1,
      patternScale: 1,
      strokeLength: 1,
      strokeThickness: 1,
    });
    const geometry: VegetationGeometry = {
      width: dem.width,
      height: dem.height,
      paths: [path],
      motifs: [],
    };

    placeMotifsAlongPath(geometry, dem, path, options);

    const maximumRenderedLength = 14;
    const maximumStrokeRadius = 3 * (14 / 64) * 1.6;
    const minimumSpacing = maximumRenderedLength + maximumStrokeRadius * 2;
    expect(geometry.motifs.length).toBeGreaterThan(2);
    for (let index = 1; index < geometry.motifs.length; index++) {
      const previous = geometry.motifs[index - 1];
      const current = geometry.motifs[index];
      const distance = (current.pathT! - previous.pathT!) * 220;
      expect(distance).toBeGreaterThanOrEqual(minimumSpacing - 1e-6);
    }
  });

  it("restricts a forced preset to that motif family and applies opacity", () => {
    const dem = makeVegetationDem();
    const geometry = buildVegetationGeometry(dem, {
      seed: 91,
      density: 2,
      motifDensity: 1.5,
      preset: "grass",
      motifAssets: grassDotAssets,
    });
    expect(geometry.motifs.length).toBeGreaterThan(0);
    expect(geometry.motifs.every((motif) => motif.assetKey.startsWith("grass-"))).toBe(true);
    expect(new Set(geometry.motifs.map((motif) => motif.assetKey))).toEqual(
      new Set(grassDotAssets.map((asset) => asset.key)),
    );
    const visible = renderVegetationOverlay(dem, geometry, {
      motifAssets: grassDotAssets,
      strokeOpacity: 1,
    });
    const hidden = renderVegetationOverlay(dem, geometry, {
      motifAssets: grassDotAssets,
      strokeOpacity: 0,
    });
    expect(visible.alpha.some((value) => value > 0)).toBe(true);
    expect(hidden.alpha.some((value) => value > 0)).toBe(false);
  });

  it("uses supplied universal motifs where their biome ratio allows them", () => {
    const dem = makeVegetationDem();
    const universalAssets = [
      makeAuditMotif("dots-01", "universal"),
      makeAuditMotif("line-01", "universal"),
    ];
    const adaptive = buildVegetationGeometry(dem, {
      seed: 915,
      density: 2,
      motifDensity: 1.2,
      preset: "adaptive",
      motifAssets: universalAssets,
    });
    const forced = buildVegetationGeometry(dem, {
      seed: 915,
      density: 2,
      motifDensity: 1.2,
      preset: "universal",
      motifAssets: universalAssets,
    });
    const universalKeys = new Set(universalAssets.map((asset) => asset.key));
    expect(adaptive.motifs.length).toBeGreaterThan(0);
    expect(adaptive.motifs.every((motif) => universalKeys.has(motif.assetKey))).toBe(true);
    expect(forced.motifs.every((motif) => universalKeys.has(motif.assetKey))).toBe(true);
    expect(new Set(adaptive.motifs.map((motif) => motif.biomeId))).toEqual(new Set([2, 5]));
  });

  it("uses only reeds-01 for wetland flow motifs when the asset is available", () => {
    const dem = makeVegetationDem();
    const reedsAsset = makeAuditMotif("reeds-01", "reeds");
    const geometry = buildVegetationGeometry(dem, {
      seed: 916,
      density: 2,
      motifDensity: 1.2,
      preset: "adaptive",
      motifAssets: [
        ...grassDotAssets,
        makeAuditMotif("dots-01", "universal"),
        makeAuditMotif("line-01", "universal"),
        reedsAsset,
      ],
    });
    const wetlandMotifs = geometry.motifs.filter((motif) => motif.biomeId === 7);
    expect(wetlandMotifs.length).toBeGreaterThan(0);
    expect(wetlandMotifs.every((motif) => motif.assetKey === reedsAsset.key)).toBe(true);
  });

  it("renders a single supplied SVG motif with a partial manifest", () => {
    const dem = makeVegetationDem();
    const singleAsset: VegetationMotifAsset = {
      ...dotAsset,
      key: "shrub-scallop",
      family: "shrub",
    };
    const geometry = buildVegetationGeometry(dem, {
      seed: 92,
      density: 2,
      motifDensity: 1.2,
      motifAssets: [singleAsset],
    });

    expect(geometry.motifs.length).toBeGreaterThan(0);
    expect(geometry.motifs.every((motif) => motif.assetKey === singleAsset.key)).toBe(true);
    const rendered = renderVegetationOverlay(dem, geometry, {
      motifAssets: [singleAsset],
      strokeOpacity: 1,
    });
    expect(rendered.alpha.some((value) => value > 0)).toBe(true);
  });

  it("flips every flow-following SVG motif on its local Y axis", () => {
    const dem = makeVegetationDem();
    const asset: VegetationMotifAsset = {
      key: "shrub-01",
      family: "shrub",
      width: 5,
      height: 5,
      data: new Uint8ClampedArray(5 * 5 * 4),
    };
    // A single asymmetric source pixel makes the local Y flip observable.
    asset.data[2 * 4 + 3] = 255;
    const centreX = 30;
    const centreY = 30;
    const rendered = renderVegetationOverlay(
      dem,
      {
        width: dem.width,
        height: dem.height,
        paths: [],
        motifs: [{
          x: centreX,
          y: centreY,
          rotation: 0,
          size: 12,
          opacity: 1,
          biomeId: 2,
          assetKey: asset.key,
        }],
      },
      {
        motifAssets: [asset],
        motifShadowStrength: 0,
      },
    );

    expect(rendered.alpha[(centreY - 5) * dem.width + centreX]).toBe(0);
    expect(rendered.alpha[(centreY + 5) * dem.width + centreX]).toBeGreaterThan(0);
  });


  it("keeps indexed wetland flow clearance identical to the brute-force scan", () => {
    const paths: VegetationStrokePath[] = [
      {
        key: 1,
        biomeId: 7,
        width: 1,
        dashPhase: 0,
        points: [
          { x: -10, y: 20 },
          { x: 5, y: 20 },
          { x: 32, y: 0 },
          { x: 64, y: 0 },
        ],
      },
      {
        key: 2,
        biomeId: 7,
        width: 1,
        dashPhase: 0,
        points: [
          { x: 32, y: 32 },
          { x: 32, y: 96 },
          { x: 64, y: 96 },
          { x: 64, y: 96 },
        ],
      },
    ];
    const tester = createVegetationPathDistanceTesterForTesting(paths, 32);
    const boundaryQueries = [
      [-10, 21, 1],
      [31, 1, 1],
      [32, 16, 16],
      [63, 64, 32],
      [96, 96, 4],
    ] as const;
    for (const [x, y, maximumDistance] of boundaryQueries) {
      expect(tester.indexed(x, y, maximumDistance)).toBe(
        tester.bruteForce(x, y, maximumDistance),
      );
    }

    let state = 0x51f15e;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) | 0;
      return (state >>> 0) / 0x100000000;
    };
    for (let query = 0; query < 250; query++) {
      const x = next() * 140 - 20;
      const y = next() * 140 - 20;
      const maximumDistance = 0.25 + next() * 40;
      expect(tester.indexed(x, y, maximumDistance)).toBe(
        tester.bruteForce(x, y, maximumDistance),
      );
    }
  });





  it("warps a motif along its parent streamline instead of only rotating it", () => {
    const dem = makeVegetationDem();
    const asset = makeAuditMotif("curved-test", "shrub");
    const path = {
      key: 7001,
      biomeId: 5,
      width: 1,
      dashPhase: 0,
      points: [
        { x: 15, y: 35 },
        { x: 25, y: 20 },
        { x: 35, y: 35 },
        { x: 45, y: 20 },
        { x: 55, y: 35 },
      ],
    };
    const curved: VegetationGeometry = {
      width: dem.width,
      height: dem.height,
      paths: [path],
      motifs: [
        {
          x: 35,
          y: 35,
          rotation: Math.atan2(15, 10),
          size: 20,
          opacity: 1,
          biomeId: 5,
          assetKey: asset.key,
          pathKey: path.key,
          pathT: 0.5,
        },
      ],
    };
    const flat = {
      ...curved,
      motifs: curved.motifs.map(({ pathKey: _pathKey, pathT: _pathT, ...motif }) => motif),
    };
    const curvedOverlay = renderVegetationOverlay(dem, curved, {
      motifAssets: [asset],
      strokeOpacity: 1,
      motifShadowStrength: 0,
    });
    const flatOverlay = renderVegetationOverlay(dem, flat, {
      motifAssets: [asset],
      strokeOpacity: 1,
      motifShadowStrength: 0,
    });
    expect(curvedOverlay.alpha.some((value) => value > 0)).toBe(true);
    expect(flatOverlay.alpha.some((value) => value > 0)).toBe(true);
    expect(curvedOverlay.alpha).not.toEqual(flatOverlay.alpha);
  });

  it("renders vector motif curves along the parent streamline", () => {
    const dem = makeVegetationDem();
    const asset: VegetationMotifAsset = {
      key: "vector-curl",
      family: "shrub",
      width: 64,
      height: 40,
      data: new Uint8ClampedArray(),
      vectorPaths: [{
        strokeWidth: 3,
        points: [
          { x: 8, y: 22 },
          { x: 20, y: 14 },
          { x: 32, y: 27 },
          { x: 44, y: 11 },
          { x: 56, y: 22 },
        ],
      }],
    };
    const path = {
      key: 7301,
      biomeId: 5,
      width: 1,
      dashPhase: 0,
      points: [{ x: 12, y: 30 }, { x: 88, y: 30 }],
    };
    const rendered = renderVegetationOverlay(dem, {
      width: dem.width,
      height: dem.height,
      paths: [path],
      motifs: [{
        x: 50,
        y: 30,
        rotation: 0,
        size: 20,
        opacity: 1,
        biomeId: 5,
        assetKey: asset.key,
        pathKey: path.key,
        pathT: 0.5,
      }],
    }, {
      motifAssets: [asset],
      strokeOpacity: 1,
      lineInterruptionProbability: 0,
      motifShadowStrength: 0,
    });
    let minY = dem.height;
    let maxY = -1;
    for (let y = 0; y < dem.height; y++) {
      for (let x = 0; x < dem.width; x++) {
        if (rendered.alpha[y * dem.width + x] === 0) continue;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    expect(maxY - minY).toBeGreaterThan(5);
  });

  it("preserves intentional vector gaps between motif subpaths", () => {
    const dem = makeVegetationDem();
    const asset: VegetationMotifAsset = {
      key: "vector-gap",
      family: "universal",
      width: 64,
      height: 40,
      data: new Uint8ClampedArray(),
      vectorPaths: [
        {
          strokeWidth: 3,
          points: [{ x: 8, y: 20 }, { x: 35, y: 20 }],
        },
        {
          strokeWidth: 3,
          points: [{ x: 48, y: 20 }, { x: 60, y: 20 }],
        },
      ],
    };
    const path = {
      key: 7302,
      biomeId: 5,
      width: 1,
      dashPhase: 0,
      points: [{ x: 12, y: 30 }, { x: 88, y: 30 }],
    };
    const rendered = renderVegetationOverlay(dem, {
      width: dem.width,
      height: dem.height,
      paths: [path],
      motifs: [{
        x: 50,
        y: 30,
        rotation: 0,
        size: 11,
        opacity: 1,
        biomeId: 5,
        assetKey: asset.key,
        pathKey: path.key,
        pathT: 0.5,
      }],
    }, {
      motifAssets: [asset],
      strokeOpacity: 1,
      lineInterruptionProbability: 0,
      motifShadowStrength: 0,
    });
    expect(rendered.alpha[30 * dem.width + 52]).toBe(0);
  });

  it("keeps parent-path charcoal gaps empty across overlapping vector motifs", () => {
    const dem = makeVegetationDem(180, 80);
    const asset: VegetationMotifAsset = {
      key: "overlapping-vector-line",
      family: "universal",
      width: 64,
      height: 40,
      data: new Uint8ClampedArray(),
      vectorPaths: [{
        strokeWidth: 3,
        points: [{ x: 0, y: 20 }, { x: 64, y: 20 }],
      }],
    };
    const path = {
      key: 7311,
      biomeId: 5,
      width: 1,
      dashPhase: 0,
      points: [{ x: 20, y: 40 }, { x: 160, y: 40 }],
    };
    const seed = 23817;
    const runs = createCharcoalStrokeRuns(
      140,
      (path.key ^ Math.imul(seed, 17)) | 0,
      1,
      { breakProbability: 1 },
    );
    expect(runs.length).toBeGreaterThan(1);
    const widestGap = runs.slice(0, -1).reduce<{
      start: number;
      end: number;
      width: number;
    }>(
      (widest, run, index) => {
        const next = runs[index + 1];
        const width = next.start - run.end;
        return width > widest.width
          ? { start: run.end, end: next.start, width }
          : widest;
      },
      { start: 0, end: 0, width: 0 },
    );
    expect(widestGap.width).toBeGreaterThan(0);

    const motifs = Array.from({ length: 15 }, (_, index) => {
      const pathT = index / 14;
      return {
        x: 20 + pathT * 140,
        y: 40,
        rotation: 0,
        size: 32,
        opacity: 0.2,
        biomeId: 5,
        assetKey: asset.key,
        pathKey: path.key,
        pathT,
      };
    });
    const rendered = renderVegetationOverlay(
      dem,
      { width: dem.width, height: dem.height, paths: [path], motifs },
      {
        seed,
        motifAssets: [asset],
        strokeOpacity: 1,
        lineInterruptionProbability: 1,
        motifShadowStrength: 0,
      },
    );
    const gapX = Math.round(20 + (widestGap.start + widestGap.end) * 0.5);
    expect(rendered.alpha[40 * dem.width + gapX]).toBe(0);

    const inkDistance = (runs[0].start + runs[0].end) * 0.5;
    const inkX = Math.round(20 + inkDistance);
    expect(rendered.alpha[40 * dem.width + inkX]).toBeGreaterThan(0);
  });

  it("renders all SVG motifs with charcoal taper and grain", () => {
    const dem = makeVegetationDem();
    const lineAsset = makeAuditMotif("line-01", "universal");
    const shrubAsset: VegetationMotifAsset = {
      key: "shrub-01",
      family: "shrub",
      width: 64,
      height: 40,
      data: new Uint8ClampedArray(64 * 40 * 4).fill(255),
    };
    const path = {
      key: 8201,
      biomeId: 5,
      width: 1,
      dashPhase: 0,
      points: [
        { x: 18, y: 35 },
        { x: 28, y: 35 },
        { x: 38, y: 35 },
        { x: 48, y: 35 },
        { x: 58, y: 35 },
      ],
    };
    const geometry: VegetationGeometry = {
      width: dem.width,
      height: dem.height,
      paths: [path],
      motifs: [
        {
          x: 38,
          y: 35,
          rotation: 0,
          size: 18,
          opacity: 1,
          biomeId: 5,
          assetKey: lineAsset.key,
          pathKey: path.key,
          pathT: 0.5,
        },
        {
          x: 38,
          y: 52,
          rotation: 0,
          size: 18,
          opacity: 1,
          biomeId: 5,
          assetKey: shrubAsset.key,
        },
      ],
    };
    const overlay = renderVegetationOverlay(
      dem,
      geometry,
      {
        motifAssets: [lineAsset, shrubAsset],
        strokeLength: 1,
        strokeThickness: 1,
        strokeOpacity: 1,
        motifShadowStrength: 0,
      },
    );
    const centre = overlay.alpha[35 * dem.width + 38];
    const nearStart = overlay.alpha[35 * dem.width + 31];
    const nearEnd = overlay.alpha[35 * dem.width + 45];
    const lineValues = overlay.alpha.slice(35 * dem.width + 28, 35 * dem.width + 49);
    const shrubCentre = overlay.alpha[52 * dem.width + 38];
    const shrubNearStart = overlay.alpha[52 * dem.width + 31];
    const shrubNearEnd = overlay.alpha[52 * dem.width + 45];
    expect(centre).toBeGreaterThan(nearStart);
    expect(centre).toBeGreaterThan(nearEnd);
    expect(shrubCentre).toBeGreaterThan(shrubNearStart);
    expect(shrubCentre).toBeGreaterThan(shrubNearEnd);
    expect(new Set(lineValues.filter((value) => value > 0)).size).toBeGreaterThan(3);

    // line-01 must use the supplied SVG through the same charcoal motif path;
    // there is no hidden procedural fallback for this asset key anymore.
    const emptyLine = {
      ...lineAsset,
      data: new Uint8ClampedArray(lineAsset.width * lineAsset.height * 4),
    };
    const emptyLineOverlay = renderVegetationOverlay(
      dem,
      { ...geometry, motifs: [geometry.motifs[0]] },
      {
        motifAssets: [emptyLine],
        strokeOpacity: 1,
        motifShadowStrength: 0,
      },
    );
    expect(emptyLineOverlay.alpha.some((value) => value > 0)).toBe(false);

    const short = renderVegetationOverlay(dem, {
      ...geometry,
      motifs: [geometry.motifs[1]],
    }, {
      motifAssets: [shrubAsset],
      strokeLength: 0.4,
      strokeOpacity: 1,
      motifShadowStrength: 0,
    });
    const long = renderVegetationOverlay(dem, {
      ...geometry,
      motifs: [geometry.motifs[1]],
    }, {
      motifAssets: [shrubAsset],
      strokeLength: 2.5,
      strokeOpacity: 1,
      motifShadowStrength: 0,
    });
    const occupiedWidth = (rendered: typeof overlay): number => {
      let minX = dem.width;
      let maxX = -1;
      for (let x = 0; x < dem.width; x++) {
        if (rendered.alpha[52 * dem.width + x] <= 0) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
      return maxX - minX + 1;
    };
    expect(occupiedWidth(long)).toBeGreaterThan(occupiedWidth(short));
  });

  it("uses paths only as invisible motif guides unless assets are unavailable", () => {
    const dem = makeVegetationDem();
    const generated = buildVegetationGeometry(dem, {
      seed: 93,
      density: 2,
      motifDensity: 1,
      preset: "grass",
    });
    expect(generated.paths.length).toBeGreaterThan(0);
    const guidesOnly = { ...generated, motifs: [] };
    const withAssets = renderVegetationOverlay(dem, guidesOnly, {
      motifAssets: grassDotAssets,
      strokeOpacity: 1,
    });
    const fallback = renderVegetationOverlay(dem, guidesOnly, {
      motifAssets: [],
      strokeOpacity: 1,
    });
    expect(withAssets.alpha.some((value) => value > 0)).toBe(false);
    expect(fallback.alpha.some((value) => value > 0)).toBe(true);
  });

  it("exposes complete streamline guides only when requested", () => {
    const dem = makeVegetationDem();
    const geometry = buildVegetationGeometry(dem, { seed: 94, density: 2 });
    const hidden = renderVegetationOverlay(dem, geometry, {
      showFlowGuides: false,
    });
    const shown = renderVegetationOverlay(dem, geometry, {
      showFlowGuides: true,
    });
    expect(hidden.flowGuideAlpha.some((value) => value > 0)).toBe(false);
    expect(shown.flowGuideAlpha.some((value) => value > 0)).toBe(true);
  });

  it("builds a deterministic flow-centre wash and sun-directed shadow", () => {
    const dem = makeVegetationDem(64, 48);
    const geometry = buildVegetationGeometry(dem, {
      seed: 294,
      density: 2,
      motifDensity: 0,
    });
    const first = renderVegetationOverlay(dem, geometry, {
      seed: 294,
      motifShadowStrength: 1,
      motifShadowDistance: 4,
      washShadowStrength: 0.85,
      washShadowDistance: 4,
      washShadowGap: 1,
      washShadowGrain: 1,
    }, 315);
    const replay = renderVegetationOverlay(dem, geometry, {
      seed: 294,
      motifShadowStrength: 1,
      motifShadowDistance: 4,
      washShadowStrength: 0.85,
      washShadowDistance: 4,
      washShadowGap: 1,
      washShadowGrain: 1,
    }, 315);
    expect(first.backgroundTone.some((value) => value > 0.1 && value < 0.9)).toBe(true);
    expect(first.backgroundNoise.some((value) => Math.abs(value) > 0.1)).toBe(true);
    expect(first.backgroundTone).toEqual(replay.backgroundTone);
    expect(first.backgroundNoise).toEqual(replay.backgroundNoise);
    expect(first.washShadowAlpha).toEqual(replay.washShadowAlpha);
    expect(first.shadowAlpha).toEqual(replay.shadowAlpha);
    expect(first.washShadowAlpha.some((value) => value > 0)).toBe(true);
    expect(first.shadowAlpha.some((value) => value > 0)).toBe(true);
    const extended = renderVegetationOverlay(dem, geometry, {
      seed: 294, motifShadowStrength: 1, motifShadowSoftness: 10,
      washShadowStrength: 0.85, washShadowDistance: 12, washShadowGap: 10,
    }, 315);
    expect(extended.washShadowAlpha.some((value) => value > 0)).toBe(true);
    const oppositeSun = renderVegetationOverlay(dem, geometry, {
      seed: 294,
      motifShadowStrength: 1,
      motifShadowDistance: 4,
      washShadowStrength: 0.85,
      washShadowDistance: 4,
      washShadowGap: 1,
      washShadowGrain: 1,
    }, 135);
    expect(oppositeSun.washShadowAlpha).not.toEqual(first.washShadowAlpha);
    expect(oppositeSun.shadowAlpha).not.toEqual(first.shadowAlpha);

    const noWashShadow = renderVegetationOverlay(dem, geometry, {
      seed: 294,
      motifShadowStrength: 1,
      motifShadowDistance: 4,
      washShadowStrength: 0,
    }, 315);
    expect(noWashShadow.washShadowAlpha.every((value) => value === 0)).toBe(true);

    const smoothWashShadow = renderVegetationOverlay(dem, geometry, {
      seed: 294,
      motifShadowStrength: 1,
      motifShadowDistance: 4,
      washShadowStrength: 0.85,
      washShadowDistance: 4,
      washShadowGap: 1,
      washShadowGrain: 0,
    }, 315);
    expect(smoothWashShadow.washShadowAlpha).not.toEqual(first.washShadowAlpha);
  });

  it("creates noisy yellowish wetland dry patches from water distance", () => {
    const dem = makeVegetationDem(96, 72);
    const geometry = buildVegetationGeometry(dem, { density: 0 });
    const broadNoise = renderVegetationOverlay(dem, geometry, {
      wetlandDryNoiseScale: 0.5,
    });
    const fineNoise = renderVegetationOverlay(dem, geometry, {
      wetlandDryNoiseScale: 2.5,
    });
    const wetlandDryness: number[] = [];
    for (let y = 48; y < 68; y++) {
      for (let x = 6; x < 90; x++) wetlandDryness.push(broadNoise.backgroundDryness[y * dem.width + x]);
    }
    expect(wetlandDryness.some((value) => value < 0.1)).toBe(true);
    expect(wetlandDryness.some((value) => value > 0.5)).toBe(true);
    expect(broadNoise.backgroundDryness).not.toEqual(fineNoise.backgroundDryness);
    const distanceRamp = renderVegetationOverlay(dem, geometry, {
      wetlandDryDistanceStart: 0,
      wetlandDryDistanceEnd: 8,
    });
    const diagnosticDryness: number[] = [];
    for (let y = 48; y < 68; y++) {
      for (let x = 6; x < 90; x++) {
        diagnosticDryness.push(distanceRamp.wetlandDryness[y * dem.width + x]);
      }
    }
    expect(diagnosticDryness.some((value) => value < 0.1)).toBe(true);
    expect(diagnosticDryness.some((value) => value > 0.9)).toBe(true);
    const noDryPatches = renderVegetationOverlay(dem, geometry, {
      wetlandDryNoiseStrength: 0,
    });
    expect(noDryPatches.backgroundDryness.every((value) => value === 0)).toBe(true);
    const distantOnly = renderVegetationOverlay(dem, geometry, {
      wetlandDryDistanceStart: 100,
      wetlandDryDistanceEnd: 120,
    });
    expect(distantOnly.backgroundDryness.every((value) => value === 0)).toBe(true);
  });

  it("ignores simulation-only channels when calculating wetland dry patches", () => {
    const dem = makeVegetationDem(144, 108);
    const hiddenChannelDem: MountainDEMData = {
      ...dem,
      isRiverChannel: dem.isRiverChannel.slice(),
    };
    for (let x = 10; x < dem.width - 4; x += 12) {
      for (let y = 72; y < dem.height - 4; y++) {
        const index = y * dem.width + x;
        if (dem.visualWaterMask?.[index] === 0)
          hiddenChannelDem.isRiverChannel[index] = 1;
      }
    }
    const geometry: VegetationGeometry = {
      width: dem.width,
      height: dem.height,
      paths: [],
      motifs: [],
    };
    const options = {
      wetlandDryDistanceStart: 8,
      wetlandDryDistanceEnd: 32,
      wetlandDryNoiseStrength: 1,
    };
    const baseline = renderVegetationOverlay(dem, geometry, options);
    const withHiddenChannels = renderVegetationOverlay(
      hiddenChannelDem,
      geometry,
      options,
    );

    let comparedDryCells = 0;
    for (let index = 0; index < dem.biomeType.length; index++) {
      if (
        dem.biomeType[index] !== 7 ||
        hiddenChannelDem.isRiverChannel[index] !== dem.isRiverChannel[index]
      ) {
        continue;
      }
      expect(withHiddenChannels.backgroundDryness[index]).toBe(
        baseline.backgroundDryness[index],
      );
      comparedDryCells++;
    }
    expect(comparedDryCells).toBeGreaterThan(0);
  });

  it("confines wetland dryness to the vegetation flow bands", () => {
    const dem = makeVegetationDem(96, 72);
    const geometry = buildVegetationGeometry(dem, { seed: 616, density: 2 });
    const overlay = renderVegetationOverlay(dem, geometry, {
      wetlandDryDistanceStart: 0,
      wetlandDryDistanceEnd: 1,
      wetlandDryNoiseStrength: 1,
    });
    let dryPixels = 0;
    let outsideFlowPixels = 0;
    for (let index = 0; index < overlay.backgroundDryness.length; index++) {
      if (overlay.backgroundDryness[index] <= 0) continue;
      dryPixels++;
      if (overlay.backgroundTone[index] < 0.42) outsideFlowPixels++;
    }
    expect(dryPixels).toBeGreaterThan(0);
    expect(outsideFlowPixels).toBe(0);
  });

  it("retains sparse flow marks inside the dark wash corridors", () => {
    const dem = makeVegetationDem(144, 108);
    const options = {
      seed: 616,
      density: 2,
      patternScale: 1.35,
      swirlStrength: 0.1,
      terrainFollowing: 0.2,
    };
    const geometry = buildVegetationGeometry(dem, options);
    const overlay = renderVegetationOverlay(dem, geometry, options);
    let darkPathPoints = 0;
    for (const path of geometry.paths) {
      for (const point of path.points) {
        const x = Math.max(0, Math.min(dem.width - 1, Math.round(point.x)));
        const y = Math.max(0, Math.min(dem.height - 1, Math.round(point.y)));
        if (overlay.backgroundTone[y * dem.width + x] < 0.28) {
          darkPathPoints++;
        }
      }
    }
    expect(darkPathPoints).toBeGreaterThan(0);
  });

  it("maps one global geometry source into overlapping export tiles", () => {
    const dem = makeVegetationDem();
    const geometry = buildVegetationGeometry(dem, { seed: 123, density: 3, patternScale: 3,
      strokeLength: 4, motifShadowSoftness: 10, washShadowDistance: 12, washShadowGap: 10 });
    const left = mapVegetationGeometryToTile(geometry, 192, 144, -8, -8, 112, 160);
    const right = mapVegetationGeometryToTile(geometry, 192, 144, 88, -8, 112, 160);
    const leftKeys = new Set(left.paths.map((path) => path.key));
    const shared = right.paths.filter((path) => leftKeys.has(path.key));
    expect(shared.length).toBeGreaterThan(0);
    for (const rightPath of shared) {
      const leftPath = left.paths.find((path) => path.key === rightPath.key)!;
      expect(rightPath.points[0].x - leftPath.points[0].x).toBeCloseTo(-96, 6);
      expect(rightPath.points[0].y).toBeCloseTo(leftPath.points[0].y, 6);
    }
  });

  it("maps indexed tile candidates exactly like the full geometry scan", () => {
    const geometry: VegetationGeometry = {
      width: 512,
      height: 384,
      paths: Array.from({ length: 240 }, (_, index) => {
        const x = (index * 73) % 512;
        const y = (index * 47) % 384;
        return {
          key: index,
          biomeId: index % 8,
          width: 0.4 + (index % 13) * 0.23,
          dashPhase: index * 0.7,
          points: index % 19 === 0
            ? [{ x: 0, y }, { x, y: 190 }, { x: 511, y: 383 - y }]
            : [{ x, y }, { x: Math.min(511, x + 18), y: Math.min(383, y + 9) }],
        };
      }),
      motifs: Array.from({ length: 1800 }, (_, index) => ({
        x: (index * 73) % 512,
        y: (index * 47) % 384,
        rotation: index * 0.17,
        size: 0.1 + (index % 67) * 0.9,
        opacity: 0.2 + (index % 8) * 0.1,
        biomeId: index % 8,
        assetKey: `motif-${index % 5}`,
        pathKey: index % 3 === 0 ? index : undefined,
        pathT: index % 3 === 0 ? (index % 100) / 100 : undefined,
      })),
      rasterProps: Array.from({ length: 360 }, (_, index) => ({
        x: (index * 89) % 512,
        y: (index * 53) % 384,
        rotation: index * 0.07,
        cellSize: 0.5 + (index % 21) * 0.8,
        opacity: 0.5,
        biomeId: index % 8,
        assetKey: index % 2 === 0 ? "large-tree" : "unknown-prop",
      })),
    };
    const rasterAssets: VegetationRasterPropAsset[] = [{
      key: "large-tree",
      family: "shrub",
      width: 8,
      height: 8,
      data: new Uint8ClampedArray(8 * 8 * 4),
      kind: "raster-prop",
      footprintWidthCells: 2.5,
      footprintHeightCells: 2,
      heightCells: 3,
      anchorX: 0.5,
      anchorY: 1,
      renderWidthCells: 6,
      renderHeightCells: 5,
      renderAnchorX: 0.5,
      renderAnchorY: 0.95,
      outlineGroup: "alpine-forest",
      eligibleBiomeIds: [3, 4],
    }];
    const tiles = [
      { x: -12, y: -9, width: 240, height: 190 },
      { x: 214, y: 103, width: 260, height: 210 },
      { x: 823, y: 511, width: 220, height: 180 },
    ];
    const boundsIntersectReference = (
      minX: number,
      minY: number,
      maxX: number,
      maxY: number,
      width: number,
      height: number,
      margin: number,
    ) => maxX >= -margin && maxY >= -margin && minX <= width + margin && minY <= height + margin;

    for (const tile of tiles) {
      const outputWidth = 1024;
      const outputHeight = 768;
      const scaleX = (outputWidth - 1) / (geometry.width - 1);
      const scaleY = (outputHeight - 1) / (geometry.height - 1);
      const scale = Math.min(scaleX, scaleY);
      const expectedPaths = geometry.paths.flatMap((path) => {
        const points = path.points.map(point => ({
          x: point.x * scaleX - tile.x,
          y: point.y * scaleY - tile.y,
        }));
        const xs = points.map(point => point.x);
        const ys = points.map(point => point.y);
        return boundsIntersectReference(
          Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys),
          tile.width, tile.height, path.width * scale + 3,
        ) ? [{ ...path, width: path.width * scale, dashPhase: path.dashPhase * scale, points }] : [];
      });
      const expectedPointProps = <T extends { x: number; y: number; size: number }>(items: readonly T[] = []) =>
        items.map(item => ({
          ...item,
          x: item.x * scaleX - tile.x,
          y: item.y * scaleY - tile.y,
          size: item.size * scale,
        })).filter(item => boundsIntersectReference(
          item.x, item.y, item.x, item.y, tile.width, tile.height, item.size,
        ));
      const expectedRasterProps = (geometry.rasterProps ?? []).map(prop => ({
        ...prop,
        x: prop.x * scaleX - tile.x,
        y: prop.y * scaleY - tile.y,
        cellSize: prop.cellSize * scale,
      })).filter(prop => {
        const asset = rasterAssets.find(candidate => candidate.key === prop.assetKey);
        const bounds = asset
          ? asset.outlineGroup === "alpine-forest"
            ? rasterPropRenderBounds(prop, asset)
            : rasterPropFootprintBounds(prop, asset)
          : {
              minX: prop.x - prop.cellSize * 2.5,
              minY: prop.y - prop.cellSize * 2.5,
              maxX: prop.x + prop.cellSize * 2.5,
              maxY: prop.y + prop.cellSize * 2.5,
            };
        return boundsIntersectReference(
          bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, tile.width, tile.height,
          asset?.outlineGroup === "alpine-forest" ? Math.max(3, prop.cellSize * 3) : 3,
        );
      });
      expect(mapVegetationGeometryToTile(
        geometry, outputWidth, outputHeight, tile.x, tile.y, tile.width, tile.height, rasterAssets,
      )).toEqual({
        width: tile.width,
        height: tile.height,
        paths: expectedPaths,
        motifs: expectedPointProps(geometry.motifs),
        rasterProps: expectedRasterProps,
      });
    }
  });

  it("renders a fixed-seed visual audit artifact when requested", async () => {
    const dem = makeVegetationDem(480, 360);
    const motifAssets = [
      makeAuditMotif("shrub-01", "shrub"),
      makeAuditMotif("shrub-02", "shrub"),
      makeAuditMotif("shrub-03", "shrub"),
      makeAuditMotif("shrub-04", "shrub"),
      makeAuditMotif("dots-01", "universal"),
      makeAuditMotif("line-01", "universal"),
      makeAuditMotif("reeds-01", "reeds"),
    ];
    const image = renderMountainDetailDEM(dem, {
      layer: "vegetation_patterns",
      palette: "swiss_topo",
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 2,
      ambientOcclusionStrength: 0.35,
      showRivers: false,
      riverThresholdKm2: 1,
      showWaterDetails: false,
      showContours: false,
      contourIntervalM: 80,
      contourOpacity: 0.35,
      vegetation: {
        seed: 23817,
        density: 1,
        patternScale: 1.35,
        swirlStrength: 0.1,
        terrainFollowing: 0.2,
        strokeLength: 2.3,
        strokeThickness: 0.8,
        motifDensity: 0.25,
        motifSize: 0.8,
        flowWashStrength: 0.2,
        flowWashDarkStrength: 0.2,
        flowWashLightStrength: 0.05,
        flowWashNoiseStrength: 0.95,
        flowWashNoiseScale: 2.5,
        wetlandDryDistanceStart: 31,
        wetlandDryDistanceEnd: 140,
        wetlandDryNoiseScale: 1.1,
        wetlandDryNoiseStrength: 0.35,
        motifShadowStrength: 0.4,
        motifShadowDistance: 1.4,
        motifShadowSoftness: 5.8,
        washShadowStrength: 0.15,
        washShadowDistance: 7.7,
        washShadowGap: 6,
        washShadowGrain: 1,
        motifAssets,
      },
    });
    const inkPixels = Array.from(image.data).filter((value, index) => index % 4 !== 3 && value < 110).length;
    expect(inkPixels).toBeGreaterThan(100);

    const artifactsDirectory = process.env.ARTIFACTS_DIR;
    if (artifactsDirectory) {
      mkdirSync(artifactsDirectory, { recursive: true });
      const rowBytes = image.width * 4 + 1;
      const band = new Uint8Array(rowBytes * image.height);
      for (let y = 0; y < image.height; y++) {
        const destination = y * rowBytes;
        band[destination] = 0;
        band.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), destination + 1);
      }
      const blob = await encodeRgbaPngRows(image.width, image.height, [band]);
      writeFileSync(
        join(artifactsDirectory, "vegetation-pattern-seed-23817.png"),
        Buffer.from(await blob.arrayBuffer()),
      );
    }
  });
});

describe("vegetation flow and prop halves", () => {
  it("merges independently built halves into the same geometry and overlay as one pass", () => {
    const dem = makeVegetationDem(480, 360);
    const options = {
      rasterPropAssets: [{
        key: "test-rock",
        family: "shrub",
        width: 8,
        height: 8,
        data: new Uint8ClampedArray(8 * 8 * 4).fill(180),
        kind: "raster-prop",
        footprintWidthCells: 2.5,
        footprintHeightCells: 2,
        heightCells: 3,
        anchorX: 0.5,
        anchorY: 1,
        eligibleBiomeIds: [2, 5, 7],
      }] satisfies VegetationRasterPropAsset[],
    };
    const serialize = (value: unknown): string => JSON.stringify(
      value,
      (_key, item) => ArrayBuffer.isView(item) ? Array.from(item as unknown as ArrayLike<number>) : item,
    );
    const whole = buildVegetationGeometry(dem, options);
    const flow = buildVegetationGeometry(dem, options, undefined, undefined, "flow");
    const props = buildVegetationGeometry(dem, options, undefined, undefined, "props");
    expect(whole.paths.length).toBeGreaterThan(0);
    expect(whole.rasterProps?.length).toBeGreaterThan(0);
    expect(flow.rasterProps).toHaveLength(0);
    expect(props.paths).toHaveLength(0);
    const merged = mergeVegetationGeometry(flow, props);
    expect(serialize(merged)).toBe(serialize(whole));

    const wholeOverlay = renderVegetationOverlay(dem, whole, options);
    const mergedOverlay = mergeVegetationOverlay(
      renderVegetationOverlay(dem, flow, options, 315, {}, "", undefined, "flow"),
      renderVegetationOverlay(dem, props, options, 315, {}, "", undefined, "props"),
    );
    expect(serialize(mergedOverlay)).toBe(serialize(wholeOverlay));
  });
});

describe("forest stands across export tiles", () => {
  it("draws the same wash and items on both sides of a tile seam", async () => {
    const { buildForestStandGeometry, mapForestStandGeometry } = await import("../src/rendering/forestStandGeometry");
    const { forestStandWashCells } = await import("../src/rendering/forestStandRenderer");
    const width = 160;
    const height = 120;
    const forest = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (((x - 80) / 55) ** 2 + ((y - 64) / 34) ** 2 < 1) forest[y * width + x] = 1;
      }
    }
    const stands = buildForestStandGeometry({
      width, height, forest, treeSize: 13, seed: 11,
      settings: { markSpacing: 0.5, edgeTrees: 0.9, interiorTrees: 0.08, meadowTrees: 0 },
    });
    expect(stands.items.length).toBeGreaterThan(0);

    // Wash: a tile's cells (with its locally blurred soft edge) match the
    // same cells computed for the whole map.
    const paint = {
      washColor: "#435f38", washStrength: 0.85, washVariation: 1, washSoftness: 0.8,
      inkColor: "#1d1c15", inkWeight: 0.9, lightStrength: 0.7,
    };
    const whole = forestStandWashCells(stands, paint, 0, 0, width, height);
    const sharedWash = new Uint8ClampedArray(width * height * 4);
    const sharedFill = forestStandWashCells(stands, paint, 0, 0, width, height, true, sharedWash);
    expect(sharedWash).toEqual(whole);
    expect(sharedFill).toEqual(forestStandWashCells(stands, paint, 0, 0, width, height, true));
    const tile = forestStandWashCells(stands, paint, 70, 20, 110, 100);
    for (let y = 20; y < 100; y++) {
      for (let x = 70; x < 110; x++) {
        for (let c = 0; c < 4; c++) {
          expect(tile[((y - 20) * 40 + (x - 70)) * 4 + c]).toBe(whole[(y * width + x) * 4 + c]);
        }
      }
    }

    // Items: at 2x export scale, an item crossing the seam at x = 160 is in
    // both tiles, at the same map position.
    const left = mapForestStandGeometry(stands, 2, 2, 0, 0, 160, 240);
    const right = mapForestStandGeometry(stands, 2, 2, 160, 0, 160, 240);
    const crossing = stands.items.filter((item) => item.minX * 2 < 160 && item.maxX * 2 > 160);
    expect(crossing.length).toBeGreaterThan(0);
    for (const item of crossing) {
      const inLeft = left.items.find((candidate) => candidate.sortY === item.sortY * 2 && candidate.minX === item.minX * 2);
      const inRight = right.items.find((candidate) => candidate.sortY === item.sortY * 2 && candidate.minX === item.minX * 2 - 160);
      expect(inLeft).toBeDefined();
      expect(inRight).toBeDefined();
      const leftSegments = inLeft!.strokes.flatMap((stroke) => stroke.segments);
      const rightSegments = inRight!.strokes.flatMap((stroke) => stroke.segments);
      expect(rightSegments.length).toBe(leftSegments.length);
      rightSegments.forEach((value, index) => {
        const shift = index % 5 === 0 || index % 5 === 2 ? 160 : 0;
        expect(value + shift).toBeCloseTo(leftSegments[index], 9);
      });
    }
    expect(right.offsetX).toBe(160);
  });
});

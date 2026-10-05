import { describe, expect, it } from "vitest";
import type { MountainDEMData } from "../src/terrain/mountainBaseDEM";
import {
  paintDesertDunes,
  resolveDesertDuneOptions,
  type DesertDuneOptions,
} from "../src/rendering/desertDunes";
import { buildVegetationGeometry, type VegetationMotifAsset } from "../src/rendering/vegetationRenderer";
import { getMountainPatternOptions, renderMountainDetailDEM, type MountainRenderOptions } from "../src/rendering/mountainDetailRenderer";
import { renderMountainPatternOverlay } from "../src/rendering/mountainPatternRenderer";

function desertDem(
  width: number,
  height: number,
  metresPerPixel: number,
  elevation: (x: number, y: number) => number = () => 500,
): MountainDEMData {
  const total = width * height;
  const z = (value = 0) => new Float32Array(total).fill(value);
  const heights = z();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) heights[y * width + x] = elevation(x, y);
  }
  return {
    width, height,
    domainWidthKm: (width * metresPerPixel) / 1000,
    domainHeightKm: (height * metresPerPixel) / 1000,
    dxMeters: metresPerPixel, dyMeters: metresPerPixel,
    minElevationM: 0, maxElevationM: 2000, elevation: heights,
    normalizedElevation: z(0.4), slopeDeg: z(1), aspectDeg: z(), normals: new Float32Array(total * 3),
    hillshade: z(0.85), ambientOcclusion: z(0.9), curvature: z(), tpi: z(), flowAccumulation: z(),
    drainageAreaKm2: z(), rainfallWeightedAreaKm2: z(), runoffDepthMmYr: z(), dischargeM3s: z(),
    strahlerOrder: new Uint8Array(total), riverCenterlineMask: new Uint8Array(total),
    isRiverChannel: new Uint8Array(total), waterDepthM: z(), flowDirection: new Int8Array(total).fill(-1),
    erosionDepthM: z(), precipitationMmYr: z(100), solarInsolation: z(0.8), temperatureC: z(26),
    biomeType: new Uint8Array(total).fill(15), isOcean: new Uint8Array(total),
    visualWaterMask: new Uint8Array(total), visualWaterCoverage: z(),
  } as MountainDEMData;
}

function paint(dem: MountainDEMData, options: DesertDuneOptions = {}): Uint8Array {
  const alpha = new Uint8Array(dem.width * dem.height);
  const clip = new Uint8Array(dem.width * dem.height).fill(1);
  const sourceXByPixel = Float64Array.from({ length: dem.width }, (_, x) => x);
  const sourceYByPixel = Float64Array.from({ length: dem.height }, (_, y) => y);
  paintDesertDunes(
    alpha, clip, dem, resolveDesertDuneOptions(options),
    { sourceXByPixel, sourceYByPixel, sourcePerPixel: 1 }, 7, 1,
  );
  return alpha;
}

/** Crest lines crossed per km along vertical (downwind for wind from north) transects. */
function crestsPerKm(dem: MountainDEMData, alpha: Uint8Array): number {
  let crossings = 0;
  let columns = 0;
  for (let x = 8; x < dem.width - 8; x += 7) {
    columns++;
    let inside = false;
    for (let y = 0; y < dem.height; y++) {
      // The crest is the darkest ink; hatching and ripples stay lighter.
      const dark = alpha[y * dem.width + x] > 200;
      if (dark && !inside) crossings++;
      inside = dark;
    }
  }
  const lengthKm = (dem.height * dem.dxMeters) / 1000;
  return crossings / columns / lengthKm;
}

const straightNorthWind: DesertDuneOptions = {
  desertDuneSpacingKm: 1.6,
  desertWindFromDeg: 0,
  desertCrestScallop: 0,
  desertTerrainFollowing: 0,
  desertRippleLines: 0,
  desertShadowStrength: 0.5,
};

describe("procedural desert dunes", () => {
  it("keeps the same number of dunes per km at any resolution", () => {
    const coarse = desertDem(240, 240, 60);
    const fine = desertDem(480, 480, 30);
    const coarseRate = crestsPerKm(coarse, paint(coarse, straightNorthWind));
    const fineRate = crestsPerKm(fine, paint(fine, straightNorthWind));
    expect(coarseRate).toBeGreaterThan(0.2);
    expect(fineRate / coarseRate).toBeGreaterThan(0.75);
    expect(fineRate / coarseRate).toBeLessThan(1.33);
  });

  it("follows the dune spacing setting", () => {
    const dem = desertDem(400, 400, 40);
    const wide = crestsPerKm(dem, paint(dem, { ...straightNorthWind, desertDuneSpacingKm: 3 }));
    const tight = crestsPerKm(dem, paint(dem, { ...straightNorthWind, desertDuneSpacingKm: 1 }));
    expect(tight / wide).toBeGreaterThan(2);
  });

  it("does not fold crests into loops on bumpy ground at full terrain bend", () => {
    // Hills about 8 km across with flanks up to ~4.5 degrees: large enough to
    // survive the terrain smoothing. Contour-following crests would loop
    // around them and multiply the crest crossings.
    const bumpy = (x: number, y: number) =>
      500 + 100 * Math.sin((2 * Math.PI * x) / 200) * Math.cos((2 * Math.PI * y) / 220);
    const flat = desertDem(300, 300, 40);
    const rough = desertDem(300, 300, 40, bumpy);
    const options = { ...straightNorthWind, desertTerrainFollowing: 1 };
    const flatRate = crestsPerKm(flat, paint(flat, options));
    const roughRate = crestsPerKm(rough, paint(rough, options));
    expect(roughRate / flatRate).toBeLessThan(1.35);
  });

  it("hatches the slip face on the downwind side of each crest", () => {
    const dem = desertDem(300, 300, 40);
    // Wind from the north: slip faces sit just south (below) each crest.
    const alpha = paint(dem, { ...straightNorthWind, desertShadowStrength: 1, desertHatchDensity: 2 });
    let below = 0;
    let above = 0;
    for (let x = 10; x < dem.width - 10; x++) {
      for (let y = 12; y < dem.height - 12; y++) {
        if (alpha[y * dem.width + x] <= 200) continue;
        for (let d = 2; d <= 10; d++) {
          below += alpha[(y + d) * dem.width + x];
          above += alpha[(y - d) * dem.width + x];
        }
      }
    }
    expect(below).toBeGreaterThan(above * 2);
  });

  it("lights dune faces by their angle to the sun", () => {
    const dem = desertDem(240, 480, 40);
    const toneFor = (sunAzimuthDeg: number): Float32Array => {
      const tone = new Float32Array(dem.width * dem.height).fill(0.5);
      paintDesertDunes(
        undefined, new Uint8Array(dem.width * dem.height).fill(1), dem,
        resolveDesertDuneOptions({ ...straightNorthWind, desertDuneSpacingKm: 2 }),
        {
          sourceXByPixel: Float64Array.from({ length: dem.width }, (_, x) => x),
          sourceYByPixel: Float64Array.from({ length: dem.height }, (_, y) => y),
          sourcePerPixel: 1,
        },
        7, 1, tone, undefined, sunAzimuthDeg,
      );
      return tone;
    };
    const share = (tone: Float32Array, test: (value: number) => boolean) =>
      tone.reduce((count, value) => count + (test(value) ? 1 : 0), 0) / tone.length;
    // Wind from the north: windward faces tilt towards the north, slip faces
    // towards the south.
    const sunUpwind = toneFor(0);
    const sunDownwind = toneFor(180);
    // Sun on the upwind side: the long windward faces are the bright
    // majority, the short slip faces are dark.
    expect(share(sunUpwind, (v) => v > 0.55)).toBeGreaterThan(0.4);
    expect(share(sunUpwind, (v) => v < 0.45)).toBeLessThan(0.3);
    // Move the sun downwind and the same faces swap.
    expect(share(sunDownwind, (v) => v < 0.45)).toBeGreaterThan(0.4);
    expect(share(sunDownwind, (v) => v > 0.55)).toBeLessThan(0.3);
  });

  it("lights each windward face evenly instead of ramping it", () => {
    const dem = desertDem(240, 480, 40);
    const tone = new Float32Array(dem.width * dem.height).fill(0.5);
    paintDesertDunes(
      undefined, new Uint8Array(dem.width * dem.height).fill(1), dem,
      resolveDesertDuneOptions({ ...straightNorthWind, desertDuneSpacingKm: 2 }),
      {
        sourceXByPixel: Float64Array.from({ length: dem.width }, (_, x) => x),
        sourceYByPixel: Float64Array.from({ length: dem.height }, (_, y) => y),
        sourcePerPixel: 1,
      },
      7, 1, tone, undefined, 0,
    );
    // Walk down columns (downwind). Just upwind of each crest the tone drops
    // sharply. Compare tone a little below the crest with tone further down
    // the same windward face: a planar face lit by one sun has the same value.
    let differences = 0;
    let faces = 0;
    for (let x = 5; x < dem.width; x += 9) {
      let previousBrink = -1;
      for (let y = 1; y < dem.height; y++) {
        const drop = tone[(y - 1) * dem.width + x] - tone[y * dem.width + x];
        if (drop < 0.25) continue;
        if (previousBrink >= 0) {
          const gap = y - previousBrink;
          const high = tone[Math.round(y - 1 - 0.08 * gap) * dem.width + x];
          // 25% down the gap stays on the planar face, above the trough bend.
          const low = tone[Math.round(y - 1 - 0.25 * gap) * dem.width + x];
          differences += Math.abs(high - low);
          faces++;
        }
        previousBrink = y;
      }
    }
    expect(faces).toBeGreaterThan(10);
    expect(differences / faces).toBeLessThan(0.04);
  });

  it("sizes the sand colour patches in km with Patch size", () => {
    const patchSignChangesPerKm = (dem: MountainDEMData, scaleKm: number): number => {
      const tone = new Float32Array(dem.width * dem.height);
      const noise = new Float32Array(dem.width * dem.height);
      const clip = new Uint8Array(dem.width * dem.height).fill(1);
      paintDesertDunes(
        undefined, clip, dem, resolveDesertDuneOptions({ desertColorScaleKm: scaleKm }),
        {
          sourceXByPixel: Float64Array.from({ length: dem.width }, (_, x) => x),
          sourceYByPixel: Float64Array.from({ length: dem.height }, (_, y) => y),
          sourcePerPixel: 1,
        },
        7, 1, tone, noise,
      );
      let changes = 0;
      let rows = 0;
      for (let y = 0; y < dem.height; y += 10) {
        rows++;
        for (let x = 1; x < dem.width; x++) {
          if (Math.sign(noise[y * dem.width + x]) !== Math.sign(noise[y * dem.width + x - 1])) changes++;
        }
      }
      return changes / rows / ((dem.width * dem.dxMeters) / 1000);
    };
    const coarse = desertDem(300, 300, 100);
    const fine = desertDem(600, 600, 50);
    const small = patchSignChangesPerKm(coarse, 2);
    const large = patchSignChangesPerKm(coarse, 8);
    expect(small / large).toBeGreaterThan(2.5);
    // Same km size at another resolution gives about the same patch rate.
    const smallFine = patchSignChangesPerKm(fine, 2);
    expect(smallFine / small).toBeGreaterThan(0.7);
    expect(smallFine / small).toBeLessThan(1.4);
  });

  it("keeps line weight and tone when exported at a higher resolution", () => {
    // The same 20 km desert at preview resolution and at 4x, as an export
    // maps it: finer pixels, source coordinates still in preview units.
    const inkCoverage = (size: number, scale: number): number => {
      const dem = desertDem(size, size, 20000 / size);
      const alpha = new Uint8Array(size * size);
      paintDesertDunes(
        alpha, new Uint8Array(size * size).fill(1), dem,
        resolveDesertDuneOptions({ desertWindFromDeg: 0 }),
        {
          sourceXByPixel: Float64Array.from({ length: size }, (_, x) => x / scale),
          sourceYByPixel: Float64Array.from({ length: size }, (_, y) => y / scale),
          sourcePerPixel: 1 / scale,
        },
        7, 1, undefined, undefined, 315, scale,
      );
      return alpha.reduce((sum, value) => sum + value, 0) / (alpha.length * 255);
    };
    const preview = inkCoverage(200, 1);
    const exported = inkCoverage(800, 4);
    expect(preview).toBeGreaterThan(0.01);
    expect(exported / preview).toBeGreaterThan(0.8);
    expect(exported / preview).toBeLessThan(1.25);
  });

  it("places no flow-line marks in sand desert, even from streamlines seeded next door", () => {
    // Left half rocky desert (flow lines), right half sand desert (dunes).
    const dem = desertDem(240, 160, 60);
    for (let y = 0; y < dem.height; y++) {
      for (let x = 0; x < dem.width / 2; x++) dem.biomeType[y * dem.width + x] = 16;
    }
    const lineMark: VegetationMotifAsset = {
      key: "arid-test-line",
      family: "arid",
      width: 64,
      height: 40,
      data: new Uint8ClampedArray(),
      vectorPaths: [{ strokeWidth: 2, points: [{ x: 2, y: 20 }, { x: 62, y: 20 }] }],
    };
    const options = { density: 3, motifDensity: 1.5, motifAssets: [lineMark] };
    const withDunes = buildVegetationGeometry(dem, options);
    const withoutDunes = buildVegetationGeometry(dem, { ...options, desertDunes: false });
    expect(withDunes.motifs.some((motif) => motif.biomeId === 16)).toBe(true);
    expect(withDunes.motifs.filter((motif) => motif.biomeId === 15)).toHaveLength(0);
    expect(withoutDunes.motifs.some((motif) => motif.biomeId === 15)).toBe(true);
  });

  it("keeps mountain ridge and hatch linework off sand desert while dunes are on", () => {
    // A steep ridge through sand desert: the mountain linework pass would
    // stroke its crest and flanks, a second kind of line next to the dunes.
    const dem = desertDem(160, 160, 60, (x, y) =>
      300 + 900 * Math.exp(-(((x - 80) / 18) ** 2)) + 40 * Math.sin(y * 0.2));
    for (let i = 0; i < dem.slopeDeg.length; i++) dem.slopeDeg[i] = 25;
    const inkFor = (desertDunes: boolean): number => {
      const pattern = renderMountainPatternOverlay(
        dem,
        getMountainPatternOptions(dem, {
          layer: "vegetation_patterns",
          vegetation: { desertDunes },
        } as MountainRenderOptions),
      );
      return pattern.ink.reduce((count, value) => count + (value > 0 ? 1 : 0), 0);
    };
    expect(inkFor(false)).toBeGreaterThan(50);
    expect(inkFor(true)).toBe(0);
  });

  it("casts no flow-line motif or wash shadows on dunes", () => {
    // Shadows offset from every crest read as thick untapered strokes; the
    // dunes carry their own sun shading instead.
    const dem = desertDem(160, 160, 60);
    const render = (motifShadowStrength: number, washShadowStrength: number) =>
      renderMountainDetailDEM(dem, {
        layer: "vegetation_patterns", palette: "swiss_topo", sunAzimuthDeg: 315, sunAltitudeDeg: 45,
        verticalExaggeration: 2, ambientOcclusionStrength: 0.35, showRivers: false, riverThresholdKm2: 1,
        showWaterDetails: false, showContours: false, contourIntervalM: 80, contourOpacity: 0.35,
        vegetation: {
          desertWindFromDeg: 0, desertDuneSpacingKm: 1.5,
          motifShadowStrength, motifShadowDistance: 3, washShadowStrength, washShadowDistance: 6,
        },
      });
    const plain = render(0, 0);
    const shadowed = render(1, 1);
    let differing = 0;
    for (let i = 0; i < plain.data.length; i++) if (plain.data[i] !== shadowed.data[i]) differing++;
    expect(differing).toBe(0);
  });

  it("leaves sand desert out of the flow-line pattern while dunes are on", () => {
    const dem = desertDem(200, 160, 60);
    const withDunes = buildVegetationGeometry(dem, { density: 2 });
    const withoutDunes = buildVegetationGeometry(dem, { density: 2, desertDunes: false });
    expect(withDunes.paths.length).toBe(0);
    expect(withoutDunes.paths.length).toBeGreaterThan(0);
  });
});

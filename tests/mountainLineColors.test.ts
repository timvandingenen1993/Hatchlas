import { expect, it } from "vitest";
import { processMountainBaseDEM, type MountainDEMData } from "../src/terrain/mountainBaseDEM";
import {
  renderMountainIllustration,
  type MountainIllustrationOptions,
} from "../src/rendering/mountainIllustrationRenderer";
import type { MountainPatternOverlay } from "../src/rendering/mountainPatternRenderer";

function makeMountain(): MountainDEMData {
  const width = 64;
  const height = 64;
  const dem = processMountainBaseDEM(
    new Float32Array(width * height).fill(0.5),
    width,
    height,
    {
      domainWidthKm: 3,
      domainHeightKm: 3,
      minElevationM: 400,
      maxElevationM: 3800,
      riverThresholdKm2: 100,
    },
  );
  dem.biomeType.fill(1);
  dem.slopeDeg.fill(25);
  dem.isRiverChannel.fill(0);
  dem.visualWaterMask?.fill(0);
  return dem;
}

function strongestIndex(values: Uint8Array): number {
  let index = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[index]) index = i;
  }
  return index;
}

it.each([255, 48])("renders hatch and main ridge paths with separate palette colors at material coverage %i", (materialCoverage) => {
  const dem = makeMountain();
  const coverage = new Uint8Array(dem.width * dem.height).fill(materialCoverage);
  const points = (x: number) =>
    Array.from({ length: 40 }, (_, index) => ({ x, y: 12 + index }));
  const pattern: MountainPatternOverlay = {
    coverage,
    snow: new Float32Array(coverage.length),
    ink: new Uint8Array(coverage.length),
    wash: new Float32Array(coverage.length),
    paths: [
      { kind: "ridge", key: 1, width: 1, opacity: 1, primary: true, points: points(24) },
      { kind: "charcoal", key: 2, width: 1, opacity: 1, points: points(40) },
    ],
  };
  const options: MountainIllustrationOptions = {
    scale: 1,
    sunAzimuthDeg: 315,
    sunAltitudeDeg: 45,
    inkColor: [43, 56, 66],
    hatchColor: [255, 0, 0],
    ridgeColor: [0, 255, 0],
    strokeThickness: 1,
    strokeOpacity: 0.8,
    offsetX: 0,
    offsetY: 0,
    stride: dem.width,
    seed: 23817,
    snowfallAmount: 0,
  };

  const result = renderMountainIllustration(
    dem,
    pattern,
    new Float32Array(coverage.length),
    options,
  );
  const ridgeIndex = strongestIndex(result.silhouetteAlpha);
  const hatchIndex = strongestIndex(result.faceStrokeAlpha);
  const ridgeR = result.rgba[ridgeIndex * 4];
  const ridgeG = result.rgba[ridgeIndex * 4 + 1];
  const hatchR = result.rgba[hatchIndex * 4];
  const hatchG = result.rgba[hatchIndex * 4 + 1];

  expect(ridgeG).toBeGreaterThan(ridgeR);
  expect(hatchR).toBeGreaterThan(hatchG);
});

it('keeps an opaque black hatch on top of snow and interior ridge ink', () => {
  const dem = makeMountain();
  dem.temperatureC.fill(-20);
  const coverage = new Uint8Array(dem.width * dem.height).fill(255);
  const points = Array.from({ length: 40 }, (_, index) => ({ x: 32, y: 12 + index }));
  const pattern: MountainPatternOverlay = {
    coverage,
    snow: new Float32Array(coverage.length),
    ink: new Uint8Array(coverage.length),
    wash: new Float32Array(coverage.length),
    paths: [
      { kind: 'ridge', key: 3, width: 1, opacity: 1, points },
      { kind: 'charcoal', key: 4, width: 2, opacity: 1, points },
    ],
  };

  const result = renderMountainIllustration(dem, pattern, new Float32Array(coverage.length), {
    scale: 1,
    sunAzimuthDeg: 315,
    sunAltitudeDeg: 45,
    inkColor: [255, 0, 0],
    hatchColor: [0, 0, 0],
    ridgeColor: [255, 0, 0],
    hatchOpacity: 1,
    horizontalHatchOpacity: 1,
    verticalHatchOpacity: 1,
    strokeThickness: 1,
    strokeOpacity: 1,
    offsetX: 0,
    offsetY: 0,
    stride: dem.width,
    seed: 23817,
    snowfallAmount: 0,
  });

  const strongestHatch = Math.max(...result.faceStrokeAlpha);
  expect(strongestHatch).toBeGreaterThan(0);
  const hasExactBlackHatch = result.faceStrokeAlpha.some((alpha, index) =>
    alpha === strongestHatch && result.rgba[index * 4] === 0
      && result.rgba[index * 4 + 1] === 0 && result.rgba[index * 4 + 2] === 0,
  );
  expect(hasExactBlackHatch).toBe(true);
});

it('lets snow reduce hatch opacity even at the maximum hatch setting', () => {
  const dem = makeMountain();
  dem.temperatureC.fill(-20);
  dem.normalizedElevation.fill(0.8);
  dem.elevation.fill(3200);
  const coverage = new Uint8Array(dem.width * dem.height).fill(255);
  const points = Array.from({ length: 40 }, (_, index) => ({ x: 32, y: 12 + index }));
  const pattern: MountainPatternOverlay = {
    coverage,
    snow: new Float32Array(coverage.length),
    ink: new Uint8Array(coverage.length),
    wash: new Float32Array(coverage.length),
    paths: [{ kind: 'charcoal', key: 5, width: 2, opacity: 1, points }],
  };
  const render = (snowfallAmount: number) => renderMountainIllustration(dem, pattern,
    new Float32Array(coverage.length), {
      scale: 1,
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      inkColor: [0, 0, 0],
      hatchColor: [0, 0, 0],
      hatchOpacity: 1,
      horizontalHatchOpacity: 1,
      verticalHatchOpacity: 1,
      strokeThickness: 1,
      strokeOpacity: 1,
      offsetX: 0,
      offsetY: 0,
      stride: dem.width,
      seed: 23817,
      snowfallAmount,
    });
  const clear = render(0);
  const snowy = render(1);
  expect(Math.max(...snowy.faceStrokeAlpha)).toBeLessThan(Math.max(...clear.faceStrokeAlpha));
});

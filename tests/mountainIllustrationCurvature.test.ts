import { expect, it } from 'vitest';
import { processMountainBaseDEM, type MountainDEMData } from '../src/terrain/mountainBaseDEM';
import { renderMountainPatternShadow, type MountainPatternOverlay } from '../src/rendering/mountainPatternRenderer';
import { connectMountainCrests, fractureMountainPath, renderMountainIllustration, type MountainIllustrationOptions } from '../src/rendering/mountainIllustrationRenderer';

const illustrationOptions: MountainIllustrationOptions = {
  scale: 1, sunAzimuthDeg: 315, sunAltitudeDeg: 45, inkColor: [65, 62, 49],
  strokeThickness: 1, strokeOpacity: 0.8, offsetX: 0, offsetY: 0, stride: 96, seed: 23817,
};

function referenceConnectMountainCrests(paths: { x: number; y: number }[][], scale: number): { x: number; y: number }[][] {
  const ends = paths.flatMap((points, path) => points.length < 2 ? [] : [
    { path, point: points[0], inside: points[Math.min(4, points.length - 1)] },
    { path, point: points[points.length - 1], inside: points[Math.max(0, points.length - 5)] },
  ]);
  const nearest = new Int32Array(ends.length).fill(-1);
  for (let i = 0; i < ends.length; i++) {
    const a = ends[i];
    let best = 12 * scale;
    for (let j = 0; j < ends.length; j++) {
      const b = ends[j];
      if (a.path === b.path) continue;
      const dx = b.point.x - a.point.x, dy = b.point.y - a.point.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 0.5 * scale || distance >= best) continue;
      const ax = a.point.x - a.inside.x, ay = a.point.y - a.inside.y;
      const bx = b.point.x - b.inside.x, by = b.point.y - b.inside.y;
      if ((ax * dx + ay * dy) / Math.max(1e-6, Math.hypot(ax, ay) * distance) < 0.5
        || -(bx * dx + by * dy) / Math.max(1e-6, Math.hypot(bx, by) * distance) < 0.5) continue;
      nearest[i] = j;
      best = distance;
    }
  }
  return ends.flatMap((a, i) => {
    const j = nearest[i];
    return j > i && nearest[j] === i ? [[a.point, ends[j].point]] : [];
  });
}

it('preserves crest joins at spatial bucket boundaries and ties', () => {
  const paths = Array.from({ length: 24 }, (_, index) => {
    const x = (index % 6) * 12 - 18;
    const y = Math.floor(index / 6) * 18;
    return [{ x, y: y + 4 }, { x, y: y + 8 }, { x: x + (index % 2 ? 2 : -2), y: y + 12 }];
  });
  expect(connectMountainCrests(paths, 1)).toEqual(referenceConnectMountainCrests(paths, 1));
});

it('does not promote an interior ridge to a solid depth silhouette', () => {
  const dem = flatMountain();
  const coverage = new Uint8Array(dem.width * dem.height).fill(255);
  const pattern: MountainPatternOverlay = {
    coverage, snow: new Float32Array(coverage.length), ink: new Uint8Array(coverage.length),
    wash: new Float32Array(coverage.length), paths: [{ kind: 'ridge', key: 23817,
      width: 1, opacity: 0.8,
      points: Array.from({ length: 60 }, (_, i) => ({ x: 48, y: 18 + i })),
    }],
  };
  const result = renderMountainIllustration(dem, pattern, new Float32Array(coverage.length), illustrationOptions);
  expect(result.silhouetteAlpha.some(value => value > 0)).toBe(false);
  expect(result.interiorRidgeAlpha.some(value => value > 0)).toBe(true);
  expect(Math.max(...result.interiorRidgeAlpha)).toBeLessThan(150);
});

it('uses explicit opacity tiers for general and unlit hatches', () => {
  const dem = flatMountain();
  dem.temperatureC.fill(20);
  dem.normalizedElevation.fill(0.25);
  const coverage = new Uint8Array(dem.width * dem.height).fill(255);
  const hatch = (x: number, key: number) => ({
    kind: 'charcoal' as const,
    key,
    width: 1,
    opacity: 1,
    points: Array.from({ length: 52 }, (_, index) => ({ x, y: 22 + index })),
  });
  const level = (x: number, key: number) => ({
    kind: 'ridge' as const,
    key,
    width: 1,
    opacity: 1,
    points: Array.from({ length: 52 }, (_, index) => ({ x, y: 22 + index })),
  });
  const pattern: MountainPatternOverlay = {
    coverage,
    snow: new Float32Array(coverage.length),
    ink: new Uint8Array(coverage.length),
    wash: new Float32Array(coverage.length),
    paths: [hatch(40, 11), level(56, 12)],
  };
  const render = (surfaceElevation?: Float32Array) => renderMountainIllustration(
    dem,
    surfaceElevation ? { ...pattern, surfaceElevation } : pattern,
    new Float32Array(coverage.length),
    { ...illustrationOptions, sunAzimuthDeg: 90, snowfallAmount: 0, stride: dem.width },
  );
  const shadowSurface = new Float32Array(coverage.length);
  for (let y = 0; y < dem.height; y++) for (let x = 0; x < dem.width; x++) {
    shadowSurface[y * dem.width + x] = 400 + x / (dem.width - 1) * 3400;
  }
  const maximum = (values: ArrayLike<number>): number => {
    let result = 0;
    for (let i = 0; i < values.length; i++) result = Math.max(result, values[i]);
    return result;
  };
  const general = render();
  const shadow = render(shadowSurface);
  const generalDownhill = maximum(general.faceStrokeAlpha);
  const shadowDownhill = maximum(shadow.faceStrokeAlpha);
  const generalLevel = maximum(general.interiorRidgeAlpha);
  const shadowLevel = maximum(shadow.interiorRidgeAlpha);
  expect(shadowDownhill).toBeGreaterThan(generalDownhill * 1.35);
  expect(shadowLevel).toBeGreaterThan(generalLevel * 1.35);
  expect(generalDownhill).toBeLessThanOrEqual(128);
  expect(shadowDownhill).toBeLessThanOrEqual(192);
  expect(generalLevel).toBeLessThanOrEqual(64);
  expect(shadowLevel).toBeLessThanOrEqual(128);
});

it('dims downhill hatches and removes level hatches under snow', () => {
  const dem = flatMountain();
  dem.temperatureC.fill(-20);
  dem.normalizedElevation.fill(0.8);
  dem.elevation.fill(3200);
  const coverage = new Uint8Array(dem.width * dem.height).fill(255);
  const hatch = (x: number, key: number) => ({
    kind: 'charcoal' as const,
    key,
    width: 1, opacity: 1,
    points: Array.from({ length: 52 }, (_, index) => ({ x, y: 22 + index })),
  });
  const pattern: MountainPatternOverlay = {
    coverage,
    snow: new Float32Array(coverage.length),
    ink: new Uint8Array(coverage.length),
    wash: new Float32Array(coverage.length),
    paths: [hatch(48, 21), {
      kind: 'ridge', key: 22, width: 1, opacity: 1,
      points: Array.from({ length: 52 }, (_, index) => ({ x: 64, y: 22 + index })),
    }],
  };
  const result = renderMountainIllustration(dem, pattern, new Float32Array(coverage.length), {
    ...illustrationOptions, snowfallAmount: 1, stride: dem.width,
  });
  let maximumDownhill = 0;
  let maximumLevel = 0;
  for (const value of result.faceStrokeAlpha) maximumDownhill = Math.max(maximumDownhill, value);
  for (const value of result.interiorRidgeAlpha) maximumLevel = Math.max(maximumLevel, value);
  expect(maximumDownhill).toBeGreaterThan(0);
  expect(maximumDownhill).toBeLessThanOrEqual(64);
  expect(maximumLevel).toBe(0);
});

it('ramps main ridge thickness from 1x at the bottom to 2x at the top', () => {
  const dem = flatMountain();
  dem.temperatureC.fill(20);
  const coverage = new Uint8Array(dem.width * dem.height).fill(255);
  const surfaceElevation = new Float32Array(coverage.length);
  for (let y = 0; y < dem.height; y++) for (let x = 0; x < dem.width; x++) {
    surfaceElevation[y * dem.width + x] = 400 + x / (dem.width - 1) * 3400;
  }
  const pattern: MountainPatternOverlay = {
    coverage,
    snow: new Float32Array(coverage.length),
    ink: new Uint8Array(coverage.length),
    wash: new Float32Array(coverage.length),
    surfaceElevation,
    paths: [{
      kind: 'ridge', key: 23, width: 1, opacity: 1, primary: true,
      points: Array.from({ length: 76 }, (_, index) => ({ x: 10 + index, y: 48 })),
    }],
  };
  const result = renderMountainIllustration(dem, pattern, new Float32Array(coverage.length), {
    ...illustrationOptions, snowfallAmount: 0, stride: dem.width,
  });
  const widthAt = (x: number): number => {
    let count = 0;
    for (let y = 0; y < dem.height; y++) if (result.silhouetteAlpha[y * dem.width + x] > 0) count++;
    return count;
  };
  const widths = [24, 40, 56, 72].map(widthAt);
  expect(widths.every(value => value > 0)).toBe(true);
  expect(widths[0]).toBeLessThan(widths[widths.length - 1]);
  expect(widths[widths.length - 1] - widths[0]).toBeGreaterThanOrEqual(1);
});

it('keeps ridge and hatch ink opaque at a fading mountain edge', () => {
  const dem = flatMountain();
  const coverage = new Uint8Array(dem.width * dem.height);
  for (let y = 0; y < 82; y++) for (let x = 0; x < dem.width; x++) coverage[y * dem.width + x] = 255;
  const ridge = Array.from({ length: 12 }, (_, index) => ({ x: 48, y: 69 + index }));
  const hatch = Array.from({ length: 12 }, (_, index) => ({ x: 56, y: 69 + index }));
  const pattern: MountainPatternOverlay = {
    coverage,
    snow: new Float32Array(coverage.length),
    ink: new Uint8Array(coverage.length),
    wash: new Float32Array(coverage.length),
    paths: [
      { kind: 'ridge', key: 31, width: 1, opacity: 0.8, primary: true, points: ridge },
      { kind: 'charcoal', key: 32, width: 1, opacity: 0.8, points: hatch },
    ],
  };
  const result = renderMountainIllustration(dem, pattern, new Float32Array(coverage.length), illustrationOptions);
  const edgeLinePixels: number[] = [];
  for (let y = 76; y < 82; y++) for (let x = 0; x < dem.width; x++) {
    const index = y * dem.width + x;
    if (Math.max(result.silhouetteAlpha[index], result.faceStrokeAlpha[index], result.interiorRidgeAlpha[index]) > 0) {
      edgeLinePixels.push(index);
    }
  }
  expect(edgeLinePixels.length).toBeGreaterThan(0);
  expect(edgeLinePixels.every(index => result.rgba[index * 4 + 3] === 255)).toBe(true);
});

function flatMountain(width = 96, height = 96): MountainDEMData {
  const dem = processMountainBaseDEM(new Float32Array(width * height).fill(0.5), width, height, {
    domainWidthKm: 3, domainHeightKm: 3, minElevationM: 400, maxElevationM: 3800, riverThresholdKm2: 100,
  });
  dem.biomeType.fill(1);
  dem.slopeDeg.fill(25);
  dem.isRiverChannel.fill(0);
  dem.visualWaterMask?.fill(0);
  return dem;
}

it('keeps natural charcoal curvature instead of rendering the angularized path', () => {
  const dem = flatMountain();
  const coverage = new Uint8Array(dem.width * dem.height).fill(255);
  const points = Array.from({ length: 72 }, (_, index) => {
    const y = 12 + index;
    return { x: 42 + 0.008 * (index - 36) ** 2, y };
  });
  const pattern: MountainPatternOverlay = {
    coverage, snow: new Float32Array(coverage.length), ink: new Uint8Array(coverage.length),
    wash: new Float32Array(coverage.length), paths: [{ kind: 'charcoal', key: 23817, width: 1, opacity: 1, points }],
  };
  const shadow = renderMountainPatternShadow(pattern, dem.width, dem.height, 315);
  const natural = renderMountainIllustration(dem, pattern, shadow, { ...illustrationOptions, stride: dem.width });
  const angularized = renderMountainIllustration(dem, {
    ...pattern,
    paths: pattern.paths?.map(path => path.kind === 'charcoal'
      ? { ...path, points: fractureMountainPath(path.points, 1, 0, 0, path.key) }
      : path),
  }, shadow, { ...illustrationOptions, stride: dem.width });
  let changed = 0;
  for (let i = 0; i < natural.charcoalAlpha.length; i++) {
    if (natural.charcoalAlpha[i] !== angularized.charcoalAlpha[i]) changed++;
  }
  expect(changed).toBeGreaterThan(20);
});

it('does not draw a hidden ridge across the foreground mountain face', () => {
  const dem = flatMountain();
  for (let y = 0; y < dem.height; y++) for (let x = 0; x < dem.width; x++) {
    dem.elevation[y * dem.width + x] = y < 60 ? 1500 : 3500;
  }
  const pattern: MountainPatternOverlay = {
    coverage: new Uint8Array(dem.width * dem.height).fill(255),
    snow: new Float32Array(dem.width * dem.height),
    ink: new Uint8Array(dem.width * dem.height),
    wash: new Float32Array(dem.width * dem.height),
    surfaceElevation: dem.elevation,
    paths: [],
  };
  const shadow = new Float32Array(dem.width * dem.height);
  const baseline = renderMountainIllustration(dem, pattern, shadow, illustrationOptions);
  const hiddenY = Array.from({ length: 30 }, (_, i) => i + 25)
    .find(y => baseline.sourceY[y * dem.width + 48] > y + 8);
  expect(hiddenY).toBeDefined();
  const hidden = renderMountainIllustration(dem, { ...pattern, paths: [{
    kind: 'ridge', key: 23817, width: 1, opacity: 1,
    points: Array.from({ length: 60 }, (_, i) => ({ x: 18 + i, y: hiddenY! })),
  }] }, shadow, illustrationOptions);
  expect(hidden.silhouetteAlpha).toEqual(baseline.silhouetteAlpha);
});

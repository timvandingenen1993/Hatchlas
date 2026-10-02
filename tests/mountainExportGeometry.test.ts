import { expect, it } from 'vitest';
import { processMountainBaseDEM } from '../src/terrain/mountainBaseDEM';
import { getMountainPatternOptions, type MountainRenderOptions } from '../src/rendering/mountainDetailRenderer';
import { renderMountainPatternOverlay } from '../src/rendering/mountainPatternRenderer';
import { mapMountainPatternToExportTile, renderMountainExportTile } from '../src/rendering/mountainExportRenderer';

function makeContext(width = 128, height = 96, scale = 4) {
  const luminance = Float32Array.from({ length: width * height }, (_, i) => {
    const x = i % width, y = Math.floor(i / width);
    return 0.2 + 0.7 * Math.exp(-(((x - 64 - 10 * Math.sin(y / 14)) / 23) ** 2));
  });
  const dem = processMountainBaseDEM(luminance, width, height, {
    domainWidthKm: 3, minElevationM: 0, maxElevationM: 5650, riverThresholdKm2: 100,
  });
  dem.biomeType.fill(1);
  const render: MountainRenderOptions = {
    layer: 'vegetation_patterns', palette: 'swiss_topo', sunAzimuthDeg: 315,
    sunAltitudeDeg: 45, verticalExaggeration: 3.8, ambientOcclusionStrength: 0.45,
    showRivers: false, riverThresholdKm2: 100, showWaterDetails: false,
    showContours: false, contourIntervalM: 100,
  };
  return { dem, source: { width, height, luminance }, render,
    outputWidth: width * scale, outputHeight: height * scale };
}

it('shortens regional marks without changing relief or hatching density through export', () => {
  const { dem, render } = makeContext();
  const reference = getMountainPatternOptions({ ...dem, dxMeters: 7.8125, dyMeters: 7.8125 }, render);
  const regional = getMountainPatternOptions({ ...dem, dxMeters: 22, dyMeters: 22 }, render);
  const exported = getMountainPatternOptions({ ...dem, dxMeters: 5.5, dyMeters: 5.5 },
    { ...render, oceanPixelScale: 4 });
  expect(reference.scale).toBe(1);
  expect(regional.scale).toBe(reference.scale);
  expect(regional.detailLengthScale).toBeLessThan(reference.detailLengthScale);
  expect(exported.scale).toBeCloseTo(regional.scale * 4);
  expect(exported.detailLengthScale).toBeCloseTo(regional.detailLengthScale);
  const fullLength = renderMountainPatternOverlay(dem, { ...regional, detailLengthScale: 1 });
  const shorter = renderMountainPatternOverlay(dem, regional);
  expect(shorter.coverage).toEqual(fullLength.coverage);
  expect(shorter.snow).toEqual(fullLength.snow);
  expect(shorter.surfaceElevation).toEqual(fullLength.surfaceElevation);
  expect(shorter.paths!.filter(path => path.kind === 'ridge')).toEqual(
    fullLength.paths!.filter(path => path.kind === 'ridge'));
  expect(shorter.paths!.filter(path => path.kind === 'charcoal').length).toBeLessThanOrEqual(
    fullLength.paths!.filter(path => path.kind === 'charcoal').length);
});

it('preserves preview ridge and charcoal topology at 4x export resolution across tile cuts', () => {
  const context = makeContext();
  const { dem, render } = context;
  const { width, height } = dem;
  const preview = renderMountainPatternOverlay(dem, getMountainPatternOptions(dem, render));
  expect(preview.paths!.filter(path => path.kind === 'ridge').length).toBeGreaterThan(0);
  expect(preview.paths!.filter(path => path.kind === 'charcoal').length).toBeGreaterThan(0);
  const full = mapMountainPatternToExportTile(context, 0, 0, width * 4, height * 4);
  expect(full.paths!.map(path => [path.kind, path.key, path.points.length]))
    .toEqual(preview.paths!.map(path => [path.kind, path.key, path.points.length]));
  // Overlapping crops must sample the same snow and surface, and must keep
  // the same complete chains even when a crest lies outside the tile.
  const tileX = 173, tileY = 91, tileWidth = 80, tileHeight = 60;
  const tile = mapMountainPatternToExportTile(context, tileX, tileY, tileWidth, tileHeight);
  for (const field of ['coverage', 'snow', 'wash', 'surfaceElevation'] as const) {
    for (let y = 0; y < tileHeight; y++) {
      expect(tile[field]!.slice(y * tileWidth, (y + 1) * tileWidth)).toEqual(
        full[field]!.slice((y + tileY) * width * 4 + tileX, (y + tileY) * width * 4 + tileX + tileWidth));
    }
  }
  tile.paths!.forEach((path, index) => path.points.forEach((point, p) => {
    expect(point.x + tileX).toBeCloseTo(full.paths![index].points[p].x, 8);
    expect(point.y + tileY).toBeCloseTo(full.paths![index].points[p].y, 8);
  }));
});

it('matches the original bilinear arithmetic when a reusable sample grid maps pattern tiles', () => {
  const context = makeContext(19, 13, 3);
  const { dem } = context;
  const preview = renderMountainPatternOverlay(dem, getMountainPatternOptions(dem, context.render));
  const tileX = 11, tileY = 7, tileWidth = 23, tileHeight = 17;
  const tile = mapMountainPatternToExportTile(context, tileX, tileY, tileWidth, tileHeight);
  const expected = new Float32Array(tileWidth * tileHeight);
  for (let y = 0; y < tileHeight; y++) {
    const gy = Math.max(0, Math.min(1, (tileY + y) / (context.outputHeight - 1))) * (dem.height - 1);
    const y0 = Math.max(0, Math.min(dem.height - 1, Math.floor(gy)));
    const y1 = Math.min(dem.height - 1, y0 + 1);
    const ty = gy - y0;
    for (let x = 0; x < tileWidth; x++) {
      const gx = Math.max(0, Math.min(1, (tileX + x) / (context.outputWidth - 1))) * (dem.width - 1);
      const x0 = Math.max(0, Math.min(dem.width - 1, Math.floor(gx)));
      const x1 = Math.min(dem.width - 1, x0 + 1);
      const tx = gx - x0;
      const top = preview.snow[y0 * dem.width + x0] * (1 - tx)
        + preview.snow[y0 * dem.width + x1] * tx;
      const bottom = preview.snow[y1 * dem.width + x0] * (1 - tx)
        + preview.snow[y1 * dem.width + x1] * tx;
      expected[y * tileWidth + x] = top * (1 - ty) + bottom * ty;
    }
  }
  expect(tile.snow).toEqual(expected);
});

it('matches the continuous mountain render across an interior export tile boundary', () => {
  const context = makeContext(96, 1152, 1);
  const full = renderMountainExportTile(context, { x: 0, y: 0, width: 96, height: 1152, halo: 0 });
  // Both tiles omit terrain outside their support, unlike small fixtures
  // whose halos accidentally include the entire map.
  for (const y of [512, 576]) {
    const tile = renderMountainExportTile(context, { x: 0, y, width: 96, height: 64, halo: 0 });
    let differences = 0;
    for (let i = 0; i < tile.data.length; i++) {
      if (tile.data[i] !== full.data[y * 96 * 4 + i]) differences++;
    }
    expect(differences).toBe(0);
  }
}, 30000);

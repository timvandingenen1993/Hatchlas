import { expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildMountainFaceGeometry, renderMountainFaceGeometry } from '../src/rendering/mountainFaceGeometry';
import { processMountainBaseDEM, loadHeightmapFile, resampleHeightmapLuminance } from '../src/terrain/mountainBaseDEM';
import { encodeRgbaPngRows } from '../src/utils/pngEncoding';

function mountain() {
  const size = 128;
  const values = Float32Array.from({ length: size * size }, (_, i) => {
    const x = i % size, y = Math.floor(i / size);
    const crestY = 42 + 7 * Math.cos(x / 14);
    return Math.max(0, (1 - Math.abs(x - 64) / 52) * (1 - Math.abs(y - crestY) / 55));
  });
  return processMountainBaseDEM(values, size, size, {
    domainWidthKm: 5, minElevationM: 800, maxElevationM: 4800, riverThresholdKm2: 100,
  });
}

it('builds connected crest-to-foot panels from shared vertices', () => {
  const dem = mountain();
  const mesh = buildMountainFaceGeometry(dem);
  expect(mesh.ribs.length).toBeGreaterThan(5);
  expect(mesh.panels.length).toBeGreaterThan(50);
  mesh.ribs.forEach((rib, index) => {
    expect(rib[0]).toBe(mesh.crest[index]);
    expect(rib.at(-1)).toBe(mesh.foot[index]);
    for (let i = 1; i < rib.length; i++) {
      expect(mesh.vertices[rib[i]].elevationM).toBeLessThanOrEqual(mesh.vertices[rib[i - 1]].elevationM);
      expect(mesh.vertices[rib[i]].y).toBeGreaterThanOrEqual(mesh.vertices[rib[i - 1]].y);
    }
  });
  for (const panel of mesh.panels) {
    expect(Math.hypot(...panel.normal)).toBeCloseTo(1, 6);
    expect(panel.vertices.every(index => index >= 0 && index < mesh.vertices.length)).toBe(true);
  }
  expect(buildMountainFaceGeometry(dem)).toEqual(mesh);
});

it('does not invent a mountain on flat terrain', () => {
  const dem = mountain();
  dem.elevation.fill(800);
  expect(buildMountainFaceGeometry(dem).panels).toHaveLength(0);
});

it('renders a dry face without missing panels from non-finite water clearance', () => {
  const dem = mountain();
  dem.isOcean.fill(0);
  dem.isRiverChannel.fill(0);
  dem.visualWaterMask?.fill(0);
  const before = dem.elevation.slice();
  const geometry = buildMountainFaceGeometry(dem);
  const image = renderMountainFaceGeometry(geometry, dem, { viewAngleDeg: 90, ink: false });
  for (const panel of geometry.panels) {
    const points = panel.vertices.map(index => geometry.vertices[index]);
    const x = Math.floor(points.reduce((sum, point) => sum + point.x, 0) / 3);
    const y = Math.floor(points.reduce((sum, point) => sum + point.y, 0) / 3);
    // At overhead view, every interior panel centroid must be covered. Permit
    // a neighbouring pixel for subpixel triangles at the crest and foot.
    let covered = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (image.data[((y + dy) * image.width + x + dx) * 4 + 3] === 255) covered = true;
    }
    expect(covered).toBe(true);
  }
  expect(dem.elevation).toEqual(before);
});

it('keeps the mesh and ground feet fixed across camera settings and output sizes', () => {
  const dem = mountain();
  const geometry = buildMountainFaceGeometry(dem);
  const before = JSON.stringify(geometry);
  for (const index of geometry.foot) {
    expect(geometry.vertices[index].elevationM).toBe(geometry.vertices[index].baseM);
  }
  const overhead = renderMountainFaceGeometry(geometry, dem, { viewAngleDeg: 90 });
  const oblique = renderMountainFaceGeometry(geometry, dem, { viewAngleDeg: 78 });
  expect(oblique.data).not.toEqual(overhead.data);
  const large = renderMountainFaceGeometry(geometry, dem, { outputScale: 2 });
  expect(large.width).toBe(oblique.width * 2);
  expect(large.height).toBe(oblique.height * 2);
  expect(JSON.stringify(geometry)).toBe(before);
});

it('renders two plane values without snow, texture, or ink and protects water', () => {
  const dem = mountain();
  const mesh = buildMountainFaceGeometry(dem);
  const plain = renderMountainFaceGeometry(mesh, dem, { ink: false });
  const colors = new Set<number>();
  for (let i = 0; i < plain.data.length; i += 4) if (plain.data[i + 3]) colors.add(plain.data[i]);
  expect(colors.size).toBe(2);
  expect(plain.data.filter((v, i) => i % 4 === 3 && v === 255).length).toBeGreaterThan(500);
  const withInk = renderMountainFaceGeometry(mesh, dem);
  expect(withInk.data).not.toEqual(plain.data);
  for (let y = 0; y < dem.height; y++) dem.isRiverChannel[y * dem.width + 64] = 1;
  const protectedWater = renderMountainFaceGeometry(mesh, dem);
  for (let y = 0; y < dem.height; y++) expect(protectedWater.data[(y * dem.width + 64) * 4 + 3]).toBe(0);
});

it.skipIf(!process.env.MOUNTAIN_FACE_REVIEW_DIR)('renders a real-heightmap structural comparison', async () => {
  const directory = process.env.MOUNTAIN_FACE_REVIEW_DIR!;
  mkdirSync(directory, { recursive: true });
  const source = await loadHeightmapFile(new Blob([readFileSync('src/assets/Heightmap2.png')]));
  let min = Infinity, max = -Infinity;
  for (const value of source.rawLuminance) { min = Math.min(min, value); max = Math.max(max, value); }
  const original = Float32Array.from(source.rawLuminance, v => (v - min) / (max - min));
  let left = source.width, right = 0, upper = source.height, lower = 0;
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    if (original[y * source.width + x] < 0.22) continue;
    left = Math.min(left, x); right = Math.max(right, x); upper = Math.min(upper, y); lower = Math.max(lower, y);
  }
  const cropSize = Math.min(source.width, source.height, Math.ceil(Math.max(right - left + 1, lower - upper + 1) * 1.24));
  const cropX = Math.max(0, Math.min(source.width - cropSize, Math.floor((left + right - cropSize) / 2)));
  const cropY = Math.max(0, Math.min(source.height - cropSize, Math.floor((upper + lower - cropSize) / 2)));
  const luminance = new Float32Array(cropSize * cropSize);
  for (let y = 0; y < cropSize; y++) luminance.set(original.subarray((y + cropY) * source.width + cropX,
    (y + cropY) * source.width + cropX + cropSize), y * cropSize);
  const dem = processMountainBaseDEM(resampleHeightmapLuminance(luminance, cropSize, cropSize, 1024, 1024), 1024, 1024,
    { domainWidthKm: 8, domainHeightKm: 8, minElevationM: 800, maxElevationM: 4800,
      baseTemperatureC: 18, riverThresholdKm2: 100 });
  const geometry = buildMountainFaceGeometry(dem);
  expect(geometry.panels.length).toBeGreaterThan(0);
  for (const [name, options] of [
    ['planes', { ink: false }], ['structure', {}], ['lighting', { twoTone: false }],
    ['structure-2x', { outputScale: 2 }],
  ] as const) {
    const image = renderMountainFaceGeometry(geometry, dem, options);
    const rows = new Uint8Array((image.width * 4 + 1) * image.height);
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4, dest = y * (image.width * 4 + 1) + 1 + x * 4;
      const alpha = image.data[i + 3] / 255;
      for (let c = 0; c < 3; c++) rows[dest + c] = image.data[i + c] * alpha + [247, 244, 232][c] * (1 - alpha);
      rows[dest + 3] = 255;
    }
    const png = await encodeRgbaPngRows(image.width, image.height, [rows]);
    writeFileSync(`${directory}/${name}.png`, new Uint8Array(await png.arrayBuffer()));
  }
  writeFileSync(`${directory}/geometry.json`, JSON.stringify(geometry));
  writeFileSync(`${directory}/settings.json`, JSON.stringify({ source: 'src/assets/Heightmap2.png', cropX, cropY, cropSize,
    viewAngleDeg: 78, heightExaggeration: 1, crownWidthFactor: 0.5, crestPlanDepthFactor: 0.2,
    shoulderReliefReduction: 0.4, scope: 'Single dominant camera-facing ridge; no snow or texture' }, null, 2));
  writeFileSync(`${directory}/index.html`, `<!doctype html><meta charset="utf-8"><title>Mountain face structure</title>
<style>body{background:#292923;color:#eee;font:16px system-ui;margin:24px}img{max-width:100%}section{max-width:1100px}a{color:#ddd}.compare{display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:1400px}figure{margin:0}figcaption{padding:10px 0}@media(max-width:700px){.compare{grid-template-columns:1fr}}</style>
<h1>One ridge, shared face geometry</h1><p>Real Heightmap2 crop, 78° view. This is a single camera-facing ridge study, not a complete range renderer. No snow, grain, props, or hatching.</p>
<p>The crest is deliberately narrowed and foreshortened for illustration; feet follow the terrain. This study is separate from the application's current renderer.</p>
<p><a href="../mountain-linework-single/index.html">Previous renderer</a> · <a href="geometry.json">Shared geometry</a></p>
<div class="compare"><figure><img src="structure.png"><figcaption>Structural prototype: one bare face, with the same geometry used for ink and shading.</figcaption></figure></div>
<section><h2>Two flat face values, no ink</h2><img src="planes.png"></section>
<section><h2>Same planes with their crest and ribs</h2><img src="structure.png"></section>
<section><h2>Continuous lighting from the same geometry</h2><img src="lighting.png"></section>
<section><h2>Native 2× rendering of the same geometry</h2><img src="structure-2x.png"></section>`);
}, 60000);

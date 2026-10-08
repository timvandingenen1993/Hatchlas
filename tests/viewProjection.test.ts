import { describe, expect, it } from 'vitest';
import { processMountainBaseDEM } from '../src/terrain/mountainBaseDEM';
import { prepareFullTerrainCameraProjection } from '../src/rendering/fullTerrainCameraRenderer';
import {
  buildCameraGrid,
  projectThroughMesh,
  screenToSource,
  sourceToScreen,
} from '../src/structures/viewProjection';

function makeDem(width = 48, height = 40) {
  const raw = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    raw[y * width + x] = 0.2 + 0.5 * Math.exp(-(((x - width * 0.5) / (width * 0.25)) ** 2)) + 0.05 * Math.sin(y / 5);
  }
  return processMountainBaseDEM(raw, width, height, {
    domainWidthKm: 6,
    domainHeightKm: 5,
    minElevationM: 200,
    maxElevationM: 1800,
    riverThresholdKm2: 100,
  });
}

const samples = [
  { u: 0.2, v: 0.3 },
  { u: 0.5, v: 0.5 },
  { u: 0.81, v: 0.66 },
  { u: 0.35, v: 0.9 },
];

describe('view projection', () => {
  it('is the identity without a camera grid', () => {
    for (const point of samples) {
      const screen = sourceToScreen(null, point);
      expect(screenToSource(null, screen.x, screen.y)).toEqual(point);
    }
    expect(screenToSource(null, 1.2, 0.5)).toBeNull();
  });

  for (const cameraType of ['orthographic', 'perspective'] as const) {
    it(`round-trips map points through the ${cameraType} camera grid`, () => {
      const dem = makeDem();
      const projection = prepareFullTerrainCameraProjection(dem, {
        cameraType,
        elevationDeg: 70,
        outputWidth: 640,
        outputHeight: 480,
      });
      const grid = buildCameraGrid(projection);
      for (const point of samples) {
        const screen = sourceToScreen(grid, point);
        const exact = projectThroughMesh(projection, point);
        expect(screen.x).toBeCloseTo(exact.x / 639, 4);
        expect(screen.y).toBeCloseTo(exact.y / 479, 4);
        const back = screenToSource(grid, screen.x, screen.y);
        expect(back).not.toBeNull();
        expect(back!.u).toBeCloseTo(point.u, 2);
        expect(back!.v).toBeCloseTo(point.v, 2);
      }
    });
  }

  it('downsamples the grid for large meshes', () => {
    const dem = makeDem(300, 280);
    const projection = prepareFullTerrainCameraProjection(dem, { elevationDeg: 75 });
    const grid = buildCameraGrid(projection, 65);
    expect(grid.columns).toBe(65);
    expect(grid.rows).toBe(65);
    const back = screenToSource(grid, ...Object.values(sourceToScreen(grid, { u: 0.4, v: 0.6 })) as [number, number]);
    expect(back!.u).toBeCloseTo(0.4, 2);
    expect(back!.v).toBeCloseTo(0.6, 2);
  });
});

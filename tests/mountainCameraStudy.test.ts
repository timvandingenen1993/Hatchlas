import { describe, expect, it } from 'vitest';
import {
  buildMountainPerspectiveMesh,
  mountainCameraFrame,
  mountainCameraProjectedBounds,
  mountainStudyFrame,
  projectMountainCameraMesh,
  renderMountainCameraMesh,
  type MountainPerspectiveMesh,
} from '../src/rendering/mountainPerspectiveStudy';
import { processMountainBaseDEM, type MountainDEMData } from '../src/terrain/mountainBaseDEM';
import type { MountainIllustration } from '../src/rendering/mountainIllustrationRenderer';
import type { MountainPatternOverlay } from '../src/rendering/mountainPatternRenderer';

function makeDem(width = 48, height = 48): MountainDEMData {
  const raw = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ridge = Math.exp(-(((x - width * 0.5) / (width * 0.24)) ** 2));
    raw[y * width + x] = 0.18 + 0.68 * ridge * (0.75 + 0.25 * Math.cos(y / 8));
  }
  const dem = processMountainBaseDEM(raw, width, height, {
    domainWidthKm: 4,
    domainHeightKm: 4,
    minElevationM: 300,
    maxElevationM: 3200,
    riverThresholdKm2: 100,
  });
  dem.isRiverChannel.fill(0);
  dem.isOcean.fill(0);
  dem.visualWaterMask?.fill(0);
  return dem;
}

function terrainMesh(dem: MountainDEMData): MountainPerspectiveMesh {
  return buildMountainPerspectiveMesh(dem, {
    terrainPatch: true,
    deformationStrength: 0,
    sampleStride: 4,
  });
}

function overlappingCameraMesh(): MountainPerspectiveMesh {
  const makeVertex = (sourceX: number, sourceY: number, elevationM: number) => ({
    sourceX,
    sourceY,
    illustratedX: sourceX,
    illustratedY: sourceY,
    elevationM,
    baseM: 0,
    reliefM: elevationM,
    active: true,
    fixed: true,
  });
  // At 45 degrees, moving ten source-Y units toward the camera and raising
  // the surface by ten metres preserves screen position while increasing
  // camera-space depth. The second triangle must therefore win the z test.
  const vertices = [
    makeVertex(8, 8, 100), makeVertex(20, 8, 100), makeVertex(8, 18, 100),
    makeVertex(8, 18, 110), makeVertex(20, 18, 110), makeVertex(8, 28, 110),
  ];
  return {
    vertices,
    triangles: [
      { vertices: [0, 1, 2], normal: [0, 0, 1], active: true },
      { vertices: [3, 4, 5], normal: [0, 0, 1], active: true },
    ],
    edges: [],
    crestPath: [],
    anchorVertices: [],
    crestControls: [],
    sourceWidth: 32,
    sourceHeight: 32,
    sourceGridX: [8, 20],
    sourceGridY: [8, 28],
    dxMeters: 1,
    dyMeters: 1,
    sampleStride: 1,
    deformationStrengthRequested: 0,
    deformationStrengthEffective: 0,
    deformationFallback: false,
  };
}

describe('conventional mountain camera study', () => {
  it('projects higher terrain toward screen-up and keeps all camera coordinates finite', () => {
    const mesh = terrainMesh(makeDem());
    const projected = projectMountainCameraMesh(mesh, {
      cameraType: 'orthographic',
      cameraElevationDeg: 45,
      heightExaggeration: 1,
    });
    let compared = false;
    for (let left = 0; left < mesh.vertices.length && !compared; left++) {
      for (let right = left + 1; right < mesh.vertices.length; right++) {
        const first = mesh.vertices[left];
        const second = mesh.vertices[right];
        if (!first.active || !second.active || first.illustratedY !== second.illustratedY) continue;
        if (Math.abs(first.elevationM - second.elevationM) < 20) continue;
        const higher = first.elevationM > second.elevationM ? left : right;
        const lower = higher === left ? right : left;
        expect(projected.points[higher].y).toBeLessThan(projected.points[lower].y);
        compared = true;
        break;
      }
    }
    expect(compared).toBe(true);
    for (const point of projected.points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(Number.isFinite(point.depth)).toBe(true);
    }
  });

  it('uses positive camera-space distances and perspective-correct depth ordering', () => {
    const mesh = terrainMesh(makeDem());
    const projected = projectMountainCameraMesh(mesh, {
      cameraType: 'perspective',
      cameraElevationDeg: 30,
      heightExaggeration: 1.5,
      fieldOfViewDeg: 35,
    });
    expect(projected.settings.cameraDistanceM).toBeGreaterThan(0);
    expect(projected.settings.fieldOfViewDeg).toBe(35);
    for (const point of projected.points) {
      expect(point.cameraDistanceM).toBeGreaterThan(0);
      expect(point.inverseCameraDistance).toBeCloseTo(1 / point.cameraDistanceM, 8);
    }
    const near = projected.points.reduce((best, point) => point.depth > best.depth ? point : best, projected.points[0]);
    const far = projected.points.reduce((best, point) => point.depth < best.depth ? point : best, projected.points[0]);
    expect(near.depth).toBeGreaterThanOrEqual(far.depth);
  });

  it('keeps the nearer overlapping surface in the camera depth buffer', () => {
    const dem = makeDem(32, 32);
    const mesh = overlappingCameraMesh();
    const projection = { cameraType: 'orthographic' as const, cameraElevationDeg: 45, heightExaggeration: 1 };
    const frame = mountainCameraFrame(mesh, [projection], 4);
    const projected = projectMountainCameraMesh(mesh, projection, frame);
    const centerX = Math.round((projected.points[0].x + projected.points[1].x + projected.points[2].x) / 3);
    const centerY = Math.round((projected.points[0].y + projected.points[1].y + projected.points[2].y) / 3);
    const rendered = renderMountainCameraMesh(mesh, dem, projection, frame, {
      showFaces: true,
      showSilhouette: false,
      showCreases: false,
      showCrest: false,
    });
    expect(rendered.visibleTriangle[centerY * rendered.width + centerX]).toBe(1);
    expect(rendered.sourceY[centerY * rendered.width + centerX]).toBeGreaterThan(10);
  });

  it('keeps orthographic and perspective renders in one finite shared frame', () => {
    const dem = makeDem();
    const mesh = terrainMesh(dem);
    const orthographic = { cameraType: 'orthographic' as const, cameraElevationDeg: 60, heightExaggeration: 1 };
    const perspective = { cameraType: 'perspective' as const, cameraElevationDeg: 60, heightExaggeration: 1, fieldOfViewDeg: 35 };
    const cameraFrame = mountainCameraFrame(mesh, [orthographic, perspective], 12);
    const studyFrame = mountainStudyFrame(mesh, [
      { mode: 'existing', settings: { viewAngleDeg: 78, heightExaggeration: 1 } },
      { mode: 'orthographic', settings: orthographic },
      { mode: 'perspective', settings: perspective },
    ], 12);
    for (const value of [studyFrame.originX, studyFrame.originY, studyFrame.width, studyFrame.height]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(cameraFrame.width).toBeGreaterThan(0);
    expect(cameraFrame.height).toBeGreaterThan(0);
    expect(studyFrame.width).toBeGreaterThanOrEqual(cameraFrame.width);
    expect(studyFrame.height).toBeGreaterThanOrEqual(cameraFrame.height);
    expect(mountainCameraProjectedBounds(mesh, perspective).maxX).toBeGreaterThan(
      mountainCameraProjectedBounds(mesh, perspective).minX,
    );
    const rendered = renderMountainCameraMesh(mesh, dem, perspective, studyFrame, {
      showFaces: true,
      showSilhouette: true,
      showCreases: false,
      showCrest: false,
    });
    expect(rendered.width).toBe(studyFrame.width);
    expect(rendered.height).toBe(studyFrame.height);
    expect(rendered.visibleTriangle.some(value => value >= 0)).toBe(true);
    for (const value of rendered.depth) {
      if (value > -Infinity) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('supersamples camera output and preserves finished illustration ink layers', () => {
    const dem = makeDem(32, 32);
    const mesh = terrainMesh(dem);
    const projection = { cameraType: 'perspective' as const, cameraElevationDeg: 75, heightExaggeration: 1, fieldOfViewDeg: 35 };
    const frame = mountainCameraFrame(mesh, [projection], 4);
    const rgba = new Uint8ClampedArray(dem.width * dem.height * 4);
    const materialRgba = new Uint8ClampedArray(dem.width * dem.height * 4);
    for (let index = 0; index < dem.width * dem.height; index++) {
      rgba[index * 4] = 18;
      rgba[index * 4 + 1] = 24;
      rgba[index * 4 + 2] = 30;
      rgba[index * 4 + 3] = 255;
      materialRgba[index * 4] = 220;
      materialRgba[index * 4 + 1] = 220;
      materialRgba[index * 4 + 2] = 220;
      materialRgba[index * 4 + 3] = 255;
    }
    const illustration: MountainIllustration = {
      rgba,
      materialRgba,
      sourceY: new Float32Array(dem.width * dem.height),
      silhouetteAlpha: new Uint8Array(dem.width * dem.height),
      charcoalAlpha: new Uint8Array(dem.width * dem.height),
      snowCoverageAlpha: new Uint8Array(dem.width * dem.height),
      depthSilhouetteAlpha: new Uint8Array(dem.width * dem.height),
      interiorRidgeAlpha: new Uint8Array(dem.width * dem.height),
      faceStrokeAlpha: new Uint8Array(dem.width * dem.height),
      silhouettePaths: [],
      charcoalPaths: [],
    };
    const rendered = renderMountainCameraMesh(mesh, dem, projection, frame, {
      showSilhouette: false,
      showCreases: false,
      showCrest: false,
      illustration,
      illustrationLayer: 'final',
      outputScale: 1.5,
    });
    expect(rendered.width).toBe(Math.ceil(frame.width * 1.5));
    expect(rendered.height).toBe(Math.ceil(frame.height * 1.5));
    const visible = rendered.visibleTriangle.findIndex(value => value >= 0);
    expect(visible).toBeGreaterThanOrEqual(0);
    expect(rendered.data[visible * 4]).toBeLessThan(80);
  });

  it('thickens structural ridge strokes with source elevation', () => {
    const dem = makeDem(32, 32);
    const mesh = terrainMesh(dem);
    const projection = { cameraType: 'orthographic' as const, cameraElevationDeg: 75, heightExaggeration: 1 };
    const frame = mountainCameraFrame(mesh, [projection], 4);
    const fieldLength = dem.width * dem.height;
    const pattern: MountainPatternOverlay = {
      coverage: new Uint8Array(fieldLength).fill(255),
      snow: new Float32Array(fieldLength),
      ink: new Uint8Array(fieldLength),
      wash: new Float32Array(fieldLength),
      paths: [{
        kind: 'ridge',
        key: 1,
        width: 0.8,
        opacity: 1,
        primary: true,
        points: [{ x: 4, y: 12 }, { x: 16, y: 12 }, { x: 28, y: 12 }],
      }],
    };
    const render = (heightBasedThickness: boolean, ridgeThicknessScale = 1) => renderMountainCameraMesh(mesh, dem, projection, frame, {
      showFaces: false,
      showSilhouette: false,
      showCreases: false,
      showCrest: false,
      pattern,
      showPatternPaths: false,
      showPrimaryRidge: true,
      heightBasedThickness,
      ridgeThicknessScale,
    });
    const flat = render(false);
    const heightBased = render(true);
    const doubledBase = render(false, 2);
    const flatInk = flat.data.reduce((count, value, index) => count + (index % 4 === 3 && value > 0 ? 1 : 0), 0);
    const heightBasedInk = heightBased.data.reduce((count, value, index) => count + (index % 4 === 3 && value > 0 ? 1 : 0), 0);
    const doubledBaseInk = doubledBase.data.reduce((count, value, index) => count + (index % 4 === 3 && value > 0 ? 1 : 0), 0);
    expect(heightBasedInk).toBeGreaterThan(flatInk);
    expect(doubledBaseInk).toBeGreaterThan(flatInk);
  });
});

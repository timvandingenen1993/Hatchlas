/**
 * Standalone page that compares camera angles and projections for mountain renders.
 */
import {
  buildMountainPerspectiveMesh,
  MOUNTAIN_CAMERA_ELEVATION_PRESETS,
  mountainStudyFrame,
  renderMountainCameraMesh,
  renderMountainPerspectiveMesh,
  type MountainCameraRenderResult,
  type MountainPerspectiveFrame,
  type MountainPerspectiveMesh,
  type MountainPerspectiveRenderOptions,
  type MountainPerspectiveRenderResult,
  type MountainStudyProjection,
} from '../rendering/mountainPerspectiveStudy';
import { renderMountainPatternOverlay, renderMountainPatternShadow } from '../rendering/mountainPatternRenderer';
import { renderMountainIllustration } from '../rendering/mountainIllustrationRenderer';
import {
  loadHeightmapFile,
  processMountainBaseDEM,
  resampleHeightmapLuminance,
  type MountainDEMData,
} from '../terrain/mountainBaseDEM';

const SOURCE_CROP = { x: 383, y: 630, size: 3241 } as const;
const ANALYSIS_SIZE = 1024;
const ANALYSIS_OPTIONS = {
  domainWidthKm: 8,
  domainHeightKm: 8,
  minElevationM: 800,
  maxElevationM: 4800,
  baseTemperatureC: 18,
  riverThresholdKm2: 100,
} as const;
const EXISTING_VIEW_ANGLE = 78;
const CAMERA_FOV_DEG = 35;
const PAPER = '#f7f4e8';

type StudyRenderResult = MountainPerspectiveRenderResult | MountainCameraRenderResult;

let dem: MountainDEMData;
let terrainMesh: MountainPerspectiveMesh;
let frame: MountainPerspectiveFrame;
let pattern: ReturnType<typeof renderMountainPatternOverlay>;
let illustration: ReturnType<typeof renderMountainIllustration>;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing study element #${id}`);
  return element as T;
};

const status = (message: string): void => { byId<HTMLElement>('status').textContent = message; };

function setCanvas(
  canvas: HTMLCanvasElement,
  result: StudyRenderResult,
  mesh: MountainPerspectiveMesh,
  showAnchors: boolean,
): void {
  canvas.width = result.width;
  canvas.height = result.height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = PAPER;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const image = new ImageData(result.width, result.height);
  image.data.set(result.data);
  context.putImageData(image, 0, 0);
  if (!showAnchors) return;
  context.save();
  context.fillStyle = 'rgba(30, 110, 170, 0.9)';
  for (const index of mesh.anchorVertices) {
    const point = result.projected.points[index];
    if (!mesh.vertices[index].active || point.x < 0 || point.y < 0 || point.x >= canvas.width || point.y >= canvas.height) continue;
    context.fillRect(Math.round(point.x) - 1, Math.round(point.y) - 1, 3, 3);
  }
  context.restore();
}

function renderOptions(): MountainPerspectiveRenderOptions {
  return {
    showFaces: byId<HTMLInputElement>('faces').checked,
    showSilhouette: byId<HTMLInputElement>('silhouette').checked,
    showCreases: byId<HTMLInputElement>('creases').checked,
    showCrest: byId<HTMLInputElement>('crest').checked,
    showWireframe: byId<HTMLInputElement>('wireframe').checked,
    lightingMode: byId<HTMLInputElement>('continuous').checked ? 'continuous' : 'two-tone',
    pattern,
    showPatternPaths: false,
    illustration,
    illustrationLayer: 'hatching',
    showPrimaryRidge: true,
    heightBasedThickness: true,
    ridgeThicknessScale: 2,
  };
}

function cameraElevation(): number {
  return Number(byId<HTMLSelectElement>('camera-elevation').value);
}

function heightExaggeration(): number {
  return Number(byId<HTMLInputElement>('height').value);
}

function updateReadouts(): void {
  byId<HTMLElement>('camera-elevation-value').textContent = `${cameraElevation()} deg`;
  byId<HTMLElement>('height-value').textContent = `${heightExaggeration().toFixed(2)}x`;
  byId<HTMLElement>('fov-value').textContent = `${CAMERA_FOV_DEG} deg`;
}

function comparisonProjections(): MountainStudyProjection[] {
  const elevation = cameraElevation();
  const height = heightExaggeration();
  return [
    { mode: 'existing', settings: { viewAngleDeg: EXISTING_VIEW_ANGLE, heightExaggeration: height } },
    { mode: 'orthographic', settings: { cameraType: 'orthographic', cameraElevationDeg: elevation, heightExaggeration: height } },
    { mode: 'perspective', settings: { cameraType: 'perspective', cameraElevationDeg: elevation, heightExaggeration: height, fieldOfViewDeg: CAMERA_FOV_DEG } },
  ];
}

function renderSelectedDownload(result: StudyRenderResult): void {
  const canvas = document.createElement('canvas');
  canvas.width = result.width;
  canvas.height = result.height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = PAPER;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const image = new ImageData(result.width, result.height);
  image.data.set(result.data);
  context.putImageData(image, 0, 0);
  canvas.toBlob(blob => {
    if (!blob) return;
    const download = byId<HTMLAnchorElement>('download-selected');
    if (download.href) URL.revokeObjectURL(download.href);
    download.href = URL.createObjectURL(blob);
  }, 'image/png');
}

function renderComparison(): void {
  if (!dem || !terrainMesh || !frame) return;
  frame = mountainStudyFrame(terrainMesh, comparisonProjections(), 24);
  const options = renderOptions();
  const elevation = cameraElevation();
  const height = heightExaggeration();
  const existing = renderMountainPerspectiveMesh(terrainMesh, dem, {
    viewAngleDeg: EXISTING_VIEW_ANGLE,
    heightExaggeration: height,
  }, frame, options);
  const orthographic = renderMountainCameraMesh(terrainMesh, dem, {
    cameraType: 'orthographic', cameraElevationDeg: elevation, heightExaggeration: height,
  }, frame, options);
  const perspective = renderMountainCameraMesh(terrainMesh, dem, {
    cameraType: 'perspective', cameraElevationDeg: elevation, heightExaggeration: height, fieldOfViewDeg: CAMERA_FOV_DEG,
  }, frame, options);
  const showAnchors = byId<HTMLInputElement>('anchors').checked;
  setCanvas(byId<HTMLCanvasElement>('canvas-existing'), existing, terrainMesh, showAnchors);
  setCanvas(byId<HTMLCanvasElement>('canvas-orthographic'), orthographic, terrainMesh, showAnchors);
  setCanvas(byId<HTMLCanvasElement>('canvas-perspective'), perspective, terrainMesh, showAnchors);
  byId<HTMLElement>('existing-meta').textContent = `Legacy oblique projection - ${height.toFixed(2)}x - ${existing.width}x${existing.height}`;
  byId<HTMLElement>('orthographic-meta').textContent = `Orthographic - ${elevation} deg - ${height.toFixed(2)}x`;
  byId<HTMLElement>('perspective-meta').textContent = `Perspective - ${elevation} deg - ${height.toFixed(2)}x - ${CAMERA_FOV_DEG} deg FOV`;
  renderSelectedDownload(perspective);
}

function cropLuminance(raw: Float32Array, width: number, crop: typeof SOURCE_CROP): Float32Array {
  const cropped = new Float32Array(crop.size * crop.size);
  for (let y = 0; y < crop.size; y++) {
    const sourceStart = (crop.y + y) * width + crop.x;
    cropped.set(raw.subarray(sourceStart, sourceStart + crop.size), y * crop.size);
  }
  return cropped;
}

async function loadStudyDEM(): Promise<MountainDEMData> {
  const response = await fetch('/src/assets/Heightmap2.png');
  if (!response.ok) throw new Error(`Heightmap request failed (${response.status})`);
  const source = await loadHeightmapFile(await response.blob());
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of source.rawLuminance) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const range = Math.max(1e-6, maximum - minimum);
  const normalized = Float32Array.from(source.rawLuminance, value => (value - minimum) / range);
  const cropped = cropLuminance(normalized, source.width, SOURCE_CROP);
  const luminance = resampleHeightmapLuminance(cropped, SOURCE_CROP.size, SOURCE_CROP.size, ANALYSIS_SIZE, ANALYSIS_SIZE);
  return processMountainBaseDEM(luminance, ANALYSIS_SIZE, ANALYSIS_SIZE, ANALYSIS_OPTIONS);
}

function settingsJSON(): string {
  return JSON.stringify({
    source: 'src/assets/Heightmap2.png',
    sourceCrop: SOURCE_CROP,
    analysis: { ...ANALYSIS_OPTIONS, resolution: ANALYSIS_SIZE },
    terrainPatch: true,
    camera: {
      elevationPresets: MOUNTAIN_CAMERA_ELEVATION_PRESETS,
      selectedElevationDeg: cameraElevation(),
      heightExaggeration: heightExaggeration(),
      fieldOfViewDeg: CAMERA_FOV_DEG,
    },
    illustrationPasses: {
      layer: 'hatching',
      lightingMode: byId<HTMLInputElement>('continuous').checked ? 'continuous' : 'two-tone',
      primaryRidgeFlatten: 0,
      heightBasedThickness: true,
      ridgeThicknessScale: 2,
      ridgeAndHatching: true,
      snowAndColor: true,
    },
    existingProjection: { viewAngleDeg: EXISTING_VIEW_ANGLE, heightExaggeration: heightExaggeration() },
    mesh: {
      sampleStride: terrainMesh.sampleStride,
      vertexCount: terrainMesh.vertices.length,
      activeVertexCount: terrainMesh.vertices.filter(vertex => vertex.active).length,
      triangleCount: terrainMesh.triangles.length,
      activeTriangleCount: terrainMesh.triangles.filter(triangle => triangle.active).length,
    },
  }, null, 2);
}

function updateStudy(): void {
  terrainMesh = buildMountainPerspectiveMesh(dem, {
    deformationStrength: 0,
    terrainPatch: true,
  });
  frame = mountainStudyFrame(terrainMesh, comparisonProjections(), 24);
  byId<HTMLElement>('mesh-meta').textContent = `${terrainMesh.vertices.length.toLocaleString()} vertices - ${terrainMesh.triangles.filter(triangle => triangle.active).length.toLocaleString()} active triangles - full terrain patch`;
  byId<HTMLAnchorElement>('download-settings').href = `data:application/json;charset=utf-8,${encodeURIComponent(settingsJSON())}`;
  renderComparison();
}

function wireControls(): void {
  byId<HTMLSelectElement>('camera-elevation').addEventListener('change', () => { updateReadouts(); renderComparison(); });
  byId<HTMLInputElement>('height').addEventListener('input', () => { updateReadouts(); renderComparison(); });
  for (const id of ['faces', 'silhouette', 'creases', 'crest', 'wireframe', 'continuous', 'anchors']) {
    byId<HTMLInputElement>(id).addEventListener('change', renderComparison);
  }
  updateReadouts();
}

async function start(): Promise<void> {
  wireControls();
  try {
    status('Loading Heightmap2 and deriving the study DEM...');
    dem = await loadStudyDEM();
    status('Building structure-aware ridge, hatch, snow, and color passes...');
    pattern = renderMountainPatternOverlay(dem, { seed: 23817, strokeOpacity: 0.8 });
    const shadow = renderMountainPatternShadow(pattern, dem.width, dem.height, 315);
    illustration = renderMountainIllustration(dem, pattern, shadow, {
      scale: 1,
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      inkColor: [43, 56, 66],
      strokeThickness: 1,
      strokeOpacity: 0.8,
      mountainViewAngleDeg: 90,
      mountainHeightExaggeration: 1,
      snowfallAmount: 1,
      snowfallDrift: 1,
      snowfallPersistence: 1,
      snowRedistributionSteps: 20,
      windAzimuthDeg: 225,
      offsetX: 0,
      offsetY: 0,
      stride: 4,
      seed: 23817,
    });
    status('Building the undeformed terrain patch...');
    updateStudy();
    status('Ready');
  } catch (error) {
    status(`Study failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

void start();

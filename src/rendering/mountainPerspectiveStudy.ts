import type { MountainDEMData } from '../terrain/mountainBaseDEM';
import { clamp01, sampleScalarField } from './cartographicStrokeRenderer';
import { mountainHatchCoreAlpha, MOUNTAIN_HATCH_INK, paintMountainCameraSegment } from './mountainCameraLinework';
import { smoothMountainField, type MountainPatternOverlay, type MountainStrokePath } from './mountainPatternRenderer';
import type { MountainIllustration } from './mountainIllustrationRenderer';
import {
  DEFAULT_MOUNTAIN_LIGHTING_MODE,
  stylizeMountainLight,
  type MountainLightingMode,
} from './mountainLighting';

/**
 * A bounded, illustrated-terrain study.  The production mountain renderer
 * remains untouched: this module keeps source coordinates beside every
 * deformed vertex so the study can be compared with the map without changing
 * the DEM or saved map settings.
 */

export interface MountainPerspectiveStudySettings {
  crownWidth?: number;
  crestDepth?: number;
  deformationStrength?: number;
  /** Include the complete study rectangle so a camera can show valley floors. */
  terrainPatch?: boolean;
  sampleStride?: number;
  crestMergeDistance?: number;
  minimumProminenceRatio?: number;
}

export interface MountainPerspectiveProjectionSettings {
  viewAngleDeg?: number;
  heightExaggeration?: number;
}

export interface MountainPerspectiveFrame {
  originX: number;
  originY: number;
  width: number;
  height: number;
  padding: number;
}

export interface MountainPerspectiveVertex {
  sourceX: number;
  sourceY: number;
  illustratedX: number;
  illustratedY: number;
  elevationM: number;
  baseM: number;
  reliefM: number;
  active: boolean;
  fixed: boolean;
}

export interface MountainPerspectiveTriangle {
  vertices: [number, number, number];
  normal: [number, number, number];
  active: boolean;
}

export interface MountainPerspectiveEdge {
  a: number;
  b: number;
  boundary: boolean;
  crease: boolean;
}

export interface MountainPerspectiveMesh {
  vertices: MountainPerspectiveVertex[];
  triangles: MountainPerspectiveTriangle[];
  edges: MountainPerspectiveEdge[];
  crestPath: number[];
  anchorVertices: number[];
  crestControls: Array<{ x: number; y: number; z: number; peakX: number; peakY: number }>;
  sourceWidth: number;
  sourceHeight: number;
  sourceGridX: number[];
  sourceGridY: number[];
  dxMeters: number;
  dyMeters: number;
  sampleStride: number;
  deformationStrengthRequested: number;
  deformationStrengthEffective: number;
  deformationFallback: boolean;
}

export interface MountainPerspectiveProjectedPoint {
  x: number;
  y: number;
  depth: number;
}

export interface MountainPerspectiveProjectedMesh {
  points: MountainPerspectiveProjectedPoint[];
  frame: MountainPerspectiveFrame;
  settings: Required<MountainPerspectiveProjectionSettings>;
}

export interface MountainPerspectiveRenderOptions {
  showFaces?: boolean;
  showSilhouette?: boolean;
  showCreases?: boolean;
  showCrest?: boolean;
  showWireframe?: boolean;
  /** Stylized face-light remap; continuousLighting remains a legacy alias. */
  lightingMode?: MountainLightingMode;
  continuousLighting?: boolean;
  /** Existing terrain ridge and downhill hatch paths, remapped through study geometry. */
  pattern?: MountainPatternOverlay;
  showPatternPaths?: boolean;
  patternOpacity?: number;
  /** Production material/snow pass sampled at each visible camera pixel. */
  illustration?: MountainIllustration;
  /** Which production layer to sample for camera faces. */
  illustrationLayer?: 'material' | 'hatching' | 'final';
  /** Draw the primary crest as a separate structural pass. */
  showPrimaryRidge?: boolean;
  /** Optional screen-coherence blend for comparison variants. */
  primaryRidgeFlatten?: number;
  /** Match production crest pens: 1x at the base, 2x at maximum elevation. */
  heightBasedThickness?: boolean;
  /** Scale the base width of structural crest and primary ridge pens. */
  ridgeThicknessScale?: number;
  /** Supersampling factor for camera exports; 1 keeps the study resolution. */
  outputScale?: number;
}

export interface MountainPerspectiveRenderResult {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  depth: Float32Array;
  visibleTriangle: Int32Array;
  sourceX: Float32Array;
  sourceY: Float32Array;
  waterClipped: Uint8Array;
  projected: MountainPerspectiveProjectedMesh;
}

const DEFAULT_STUDY_SETTINGS: Required<MountainPerspectiveStudySettings> = {
  crownWidth: 0.70,
  crestDepth: 0.45,
  deformationStrength: 1,
  terrainPatch: false,
  sampleStride: 4,
  crestMergeDistance: 32,
  minimumProminenceRatio: 0.05,
};

const DEFAULT_PROJECTION_SETTINGS: Required<MountainPerspectiveProjectionSettings> = {
  viewAngleDeg: 60,
  heightExaggeration: 1,
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

const smoothStep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
};

function waterAt(dem: MountainDEMData, x: number, y: number): boolean {
  const ix = clamp(Math.round(x), 0, dem.width - 1);
  const iy = clamp(Math.round(y), 0, dem.height - 1);
  const index = iy * dem.width + ix;
  return !!(dem.isOcean[index] || dem.isRiverChannel[index] || dem.visualWaterMask?.[index]);
}

interface CrestPoint {
  x: number;
  y: number;
  z: number;
}

interface FootPoint extends CrestPoint {
  frontY: number;
  frontX: number;
  backY: number;
  backX: number;
}

function interpolatePath(points: readonly FootPoint[], x: number, field: 'y' | 'frontY' | 'backY' | 'frontX' | 'backX'): number {
  if (points.length === 0) return 0;
  if (x <= points[0].x) return points[0][field];
  if (x >= points[points.length - 1].x) return points[points.length - 1][field];
  for (let index = 1; index < points.length; index++) {
    const right = points[index];
    if (x > right.x) continue;
    const left = points[index - 1];
    const t = clamp01((x - left.x) / Math.max(1e-6, right.x - left.x));
    return left[field] * (1 - t) + right[field] * t;
  }
  return points[points.length - 1][field];
}

function extractDominantCrest(
  field: Float32Array,
  dem: MountainDEMData,
  scale: number,
): { points: CrestPoint[]; summit: CrestPoint; base: number } {
  let summitIndex = -1;
  let base = Infinity;
  for (let index = 0; index < field.length; index++) {
    if (dem.isOcean[index]) continue;
    base = Math.min(base, field[index]);
    if (!waterAt(dem, index % dem.width, Math.floor(index / dem.width))
      && (summitIndex < 0 || field[index] > field[summitIndex])) summitIndex = index;
  }
  if (summitIndex < 0) summitIndex = 0;
  const summit: CrestPoint = {
    x: summitIndex % dem.width,
    y: Math.floor(summitIndex / dem.width),
    z: field[summitIndex],
  };
  const relief = Math.max(1, summit.z - base);
  const step = Math.max(8, Math.round(8 * scale));
  const traceDirection = (direction: -1 | 1): CrestPoint[] => {
    const result: CrestPoint[] = [];
    let previousY = summit.y;
    for (let x = summit.x + direction * step; x > 2 && x < dem.width - 3; x += direction * step) {
      if (Math.abs(x - summit.x) > dem.width * 0.42) break;
      let bestY = previousY;
      let bestScore = -Infinity;
      const radius = Math.max(8, step * 2.1);
      for (let y = Math.max(2, Math.floor(previousY - radius)); y <= Math.min(dem.height - 3, Math.ceil(previousY + radius)); y++) {
        if (waterAt(dem, x, y)) continue;
        const score = field[y * dem.width + x]
          - Math.abs(y - previousY) * relief / Math.max(1, dem.height * 1.6);
        if (score > bestScore) {
          bestScore = score;
          bestY = y;
        }
      }
      const z = field[bestY * dem.width + x];
      if (z < base + relief * 0.18 || waterAt(dem, x, bestY)) break;
      result.push({ x, y: bestY, z });
      previousY = bestY;
    }
    return result;
  };
  const left = traceDirection(-1).reverse();
  const right = traceDirection(1);
  const points = [...left, summit, ...right];
  return { points, summit, base };
}

function detectCrestPeaks(
  crest: readonly CrestPoint[],
  relief: number,
  mergeDistance: number,
  minimumProminenceRatio: number,
): CrestPoint[] {
  if (crest.length < 3) return crest.length > 0 ? [crest[Math.floor(crest.length / 2)]] : [];
  const smoothed = crest.map((point, index) => {
    const previous = crest[Math.max(0, index - 1)].z;
    const next = crest[Math.min(crest.length - 1, index + 1)].z;
    return (previous + point.z * 2 + next) / 4;
  });
  const candidates: CrestPoint[] = [];
  for (let index = 1; index < crest.length - 1; index++) {
    const prominence = smoothed[index] - Math.max(
      Math.min(smoothed[index - 1], smoothed[index]),
      Math.min(smoothed[index + 1], smoothed[index]),
    );
    if (smoothed[index] >= smoothed[index - 1] && smoothed[index] >= smoothed[index + 1]
      && prominence >= relief * minimumProminenceRatio) {
      candidates.push(crest[index]);
    }
  }
  if (candidates.length === 0) {
    return [crest.reduce((highest, point) => point.z > highest.z ? point : highest, crest[0])];
  }
  const selected: CrestPoint[] = [];
  for (const candidate of candidates.slice().sort((a, b) => b.z - a.z)) {
    if (selected.every(point => Math.abs(point.x - candidate.x) > mergeDistance)) selected.push(candidate);
  }
  return selected.sort((a, b) => a.x - b.x);
}

function traceFoot(
  crest: CrestPoint,
  direction: -1 | 1,
  summit: CrestPoint,
  field: Float32Array,
  dem: MountainDEMData,
  base: number,
  relief: number,
  scale: number,
): { x: number; y: number } {
  const step = Math.max(3, Math.round(4 * scale));
  let footX = crest.x;
  let footY = crest.y;
  let lastZ = crest.z;
  const fan = (crest.x - summit.x) / Math.max(1, dem.width * 0.5);
  for (let distance = step; distance < dem.height * 0.42; distance += step) {
    const y = crest.y + direction * distance;
    if (y < 2 || y >= dem.height - 2) break;
    const x = clamp(crest.x + fan * distance, 2, dem.width - 3);
    if (waterAt(dem, x, y)) break;
    const z = sampleScalarField(field, dem.width, dem.height, x, y);
    if (z > lastZ + relief * 0.08 && distance > step * 2) break;
    footX = x;
    footY = y;
    lastZ = Math.min(lastZ, z);
    if (z <= base + relief * 0.13) break;
  }
  return { x: footX, y: footY };
}

function computeBaseElevation(field: Float32Array, width: number, height: number, x: number, y: number, radius: number): number {
  return Math.min(
    sampleScalarField(field, width, height, x - radius, y),
    sampleScalarField(field, width, height, x + radius, y),
    sampleScalarField(field, width, height, x, y - radius),
    sampleScalarField(field, width, height, x, y + radius),
  );
}

function normalFor(
  vertices: readonly MountainPerspectiveVertex[],
  triangle: [number, number, number],
  dxMeters: number,
  dyMeters: number,
): [number, number, number] {
  const p = vertices[triangle[0]], q = vertices[triangle[1]], r = vertices[triangle[2]];
  const ux = (q.illustratedX - p.illustratedX) * dxMeters;
  const uy = (q.illustratedY - p.illustratedY) * dyMeters;
  const vx = (r.illustratedX - p.illustratedX) * dxMeters;
  const vy = (r.illustratedY - p.illustratedY) * dyMeters;
  const uz = q.elevationM - p.elevationM;
  const vz = r.elevationM - p.elevationM;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  if (nz < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const length = Math.max(1e-9, Math.hypot(nx, ny, nz));
  return [nx / length, ny / length, nz / length];
}

function buildEdges(triangles: readonly MountainPerspectiveTriangle[]): MountainPerspectiveEdge[] {
  const edgeMap = new Map<string, { a: number; b: number; triangle: number; other?: number }>();
  for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex++) {
    const triangle = triangles[triangleIndex];
    if (!triangle.active) continue;
    const [a, b, c] = triangle.vertices;
    for (const [left, right] of [[a, b], [b, c], [c, a]] as const) {
      const low = Math.min(left, right);
      const high = Math.max(left, right);
      const key = `${low}:${high}`;
      const previous = edgeMap.get(key);
      if (previous) previous.other = triangleIndex;
      else edgeMap.set(key, { a: left, b: right, triangle: triangleIndex });
    }
  }
  return [...edgeMap.values()].map(edge => {
    const first = triangles[edge.triangle];
    const second = edge.other === undefined ? undefined : triangles[edge.other];
    const dot = second
      ? first.normal[0] * second.normal[0] + first.normal[1] * second.normal[1] + first.normal[2] * second.normal[2]
      : -1;
    return { a: edge.a, b: edge.b, boundary: edge.other === undefined, crease: edge.other === undefined || dot < 0.72 };
  });
}

function hasInvertedTriangles(vertices: readonly MountainPerspectiveVertex[], triangles: readonly MountainPerspectiveTriangle[]): boolean {
  for (const triangle of triangles) {
    if (!triangle.active) continue;
    const [a, b, c] = triangle.vertices;
    const p = vertices[a], q = vertices[b], r = vertices[c];
    const area = (q.illustratedX - p.illustratedX) * (r.illustratedY - p.illustratedY)
      - (q.illustratedY - p.illustratedY) * (r.illustratedX - p.illustratedX);
    if (!(area > 1e-4)) return true;
  }
  return false;
}

/** Build a continuous shared grid around one dominant ridge. */
export function buildMountainPerspectiveMesh(
  dem: MountainDEMData,
  requested: MountainPerspectiveStudySettings = {},
): MountainPerspectiveMesh {
  const settings = {
    ...DEFAULT_STUDY_SETTINGS,
    ...requested,
    crownWidth: clamp(requested.crownWidth ?? DEFAULT_STUDY_SETTINGS.crownWidth, 0.25, 1.25),
    crestDepth: clamp(requested.crestDepth ?? DEFAULT_STUDY_SETTINGS.crestDepth, 0.15, 1.25),
    deformationStrength: clamp(requested.deformationStrength ?? DEFAULT_STUDY_SETTINGS.deformationStrength, 0, 1),
    sampleStride: Math.max(2, Math.round(requested.sampleStride ?? DEFAULT_STUDY_SETTINGS.sampleStride)),
    crestMergeDistance: Math.max(4, requested.crestMergeDistance ?? DEFAULT_STUDY_SETTINGS.crestMergeDistance),
    minimumProminenceRatio: clamp(requested.minimumProminenceRatio ?? DEFAULT_STUDY_SETTINGS.minimumProminenceRatio, 0, 0.5),
  };
  const scale = Math.min(dem.width, dem.height) / 1024;
  const field = smoothMountainField(dem.elevation, dem.width, dem.height, Math.max(1.5, 5 * scale));
  const { points: crest, summit, base } = extractDominantCrest(field, dem, scale);
  const relief = Math.max(1, crest.reduce((highest, point) => Math.max(highest, point.z), summit.z) - base);
  const peaks = detectCrestPeaks(crest, relief, settings.crestMergeDistance * scale, settings.minimumProminenceRatio);
  const feet: FootPoint[] = crest.map(point => {
    const front = traceFoot(point, 1, summit, field, dem, base, relief, scale);
    const back = traceFoot(point, -1, summit, field, dem, base, relief, scale);
    return { ...point, frontX: front.x, frontY: front.y, backX: back.x, backY: back.y };
  });
  const minX = Math.max(0, Math.floor(Math.min(...feet.map(point => Math.min(point.x, point.frontX, point.backX))) - dem.width * 0.06));
  const maxX = Math.min(dem.width - 1, Math.ceil(Math.max(...feet.map(point => Math.max(point.x, point.frontX, point.backX))) + dem.width * 0.06));
  const minY = Math.max(0, Math.floor(Math.min(...feet.map(point => point.backY)) - dem.height * 0.025));
  const maxY = Math.min(dem.height - 1, Math.ceil(Math.max(...feet.map(point => point.frontY)) + dem.height * 0.025));
  const stride = settings.sampleStride;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = minX; x <= maxX; x += stride) xs.push(x);
  if (xs.at(-1) !== maxX) xs.push(maxX);
  for (let y = minY; y <= maxY; y += stride) ys.push(y);
  if (ys.at(-1) !== maxY) ys.push(maxY);
  const baseRadius = Math.max(16, Math.round(96 * scale));
  const originalVertices: MountainPerspectiveVertex[] = [];
  const activeGrid = new Uint8Array(xs.length * ys.length);
  const anchorGrid = new Uint8Array(activeGrid.length);
  for (let row = 0; row < ys.length; row++) {
    for (let column = 0; column < xs.length; column++) {
      const sourceX = xs[column];
      const sourceY = ys[row];
      const elevationM = sampleScalarField(field, dem.width, dem.height, sourceX, sourceY);
      const baseM = Math.min(elevationM, computeBaseElevation(field, dem.width, dem.height, sourceX, sourceY, baseRadius));
      const reliefM = Math.max(0, elevationM - baseM);
      const crestY = interpolatePath(feet, sourceX, 'y');
      const frontY = Math.max(crestY + stride, interpolatePath(feet, sourceX, 'frontY'));
      const backY = Math.min(crestY - stride, interpolatePath(feet, sourceX, 'backY'));
      const ratio = reliefM / relief;
      const inSupport = sourceY >= backY && sourceY <= frontY && ratio >= 0.065 && !waterAt(dem, sourceX, sourceY);
      const active = settings.terrainPatch
        ? !waterAt(dem, sourceX, sourceY)
        : inSupport;
      const distanceToFoot = Math.min(sourceY - backY, frontY - sourceY);
      const edgeFade = smoothStep(stride * 0.75, stride * 4, distanceToFoot);
      const fixed = !inSupport || ratio < 0.12 || edgeFade < 0.18;
      const index = row * xs.length + column;
      activeGrid[index] = active ? 1 : 0;
      anchorGrid[index] = fixed ? 1 : 0;
      originalVertices.push({ sourceX, sourceY, illustratedX: sourceX, illustratedY: sourceY,
        elevationM, baseM, reliefM, active: inSupport, fixed });
    }
  }
  const crestControls = crest.map(point => {
    const peak = peaks.reduce((closest, candidate) =>
      Math.abs(candidate.x - point.x) < Math.abs(closest.x - point.x) ? candidate : closest, peaks[0]);
    return {
      x: point.x,
      y: point.y,
      z: point.z,
      peakX: peak.x,
      peakY: peak.y,
    };
  });
  const displacement = originalVertices.map(vertex => {
    if (!vertex.active) return { x: 0, y: 0, influence: 0 };
    let weightSum = 0;
    let dx = 0;
    let dy = 0;
    for (const control of crestControls) {
      const targetX = control.peakX + (control.x - control.peakX) * settings.crownWidth;
      const targetY = control.peakY + (control.y - control.peakY) * settings.crestDepth;
      const distanceX = (vertex.sourceX - control.x) / Math.max(8, stride * 4);
      const distanceY = (vertex.sourceY - control.y) / Math.max(12, stride * 8);
      const weight = 1 / (0.6 + distanceX * distanceX + distanceY * distanceY);
      weightSum += weight;
      dx += (targetX - control.x) * weight;
      dy += (targetY - control.y) * weight;
    }
    const ratio = vertex.reliefM / relief;
    const influence = smoothStep(0.08, 0.48, ratio);
    return { x: dx / Math.max(1e-6, weightSum), y: dy / Math.max(1e-6, weightSum), influence };
  });
  const buildAttempt = (strength: number): {
    vertices: MountainPerspectiveVertex[];
    triangles: MountainPerspectiveTriangle[];
    crestPath: number[];
    anchors: number[];
  } => {
    const vertices = originalVertices.map((vertex, index) => {
      const movement = displacement[index];
      const support = anchorGrid[index] ? 0 : movement.influence;
      return {
        ...vertex,
        illustratedX: vertex.sourceX + movement.x * strength * support,
        illustratedY: vertex.sourceY + movement.y * strength * support,
      };
    });
    const triangles: MountainPerspectiveTriangle[] = [];
    for (let row = 0; row < ys.length - 1; row++) {
      for (let column = 0; column < xs.length - 1; column++) {
        const a = row * xs.length + column;
        const b = a + 1;
        const c = a + xs.length;
        const d = c + 1;
        const first: [number, number, number] = [a, b, c];
        const second: [number, number, number] = [b, d, c];
        for (const triangle of [first, second]) {
          const active = triangle.every(index => activeGrid[index] === 1);
          triangles.push({ vertices: triangle, normal: normalFor(vertices, triangle, dem.dxMeters, dem.dyMeters), active });
        }
      }
    }
    const nearestGridVertex = (point: CrestPoint): number => {
      let best = 0;
      let distance = Infinity;
      for (let index = 0; index < vertices.length; index++) {
        const candidate = vertices[index];
        const nextDistance = (candidate.sourceX - point.x) ** 2 + (candidate.sourceY - point.y) ** 2;
        if (nextDistance < distance) {
          distance = nextDistance;
          best = index;
        }
      }
      return best;
    };
    return {
      vertices,
      triangles,
      crestPath: crest.map(nearestGridVertex),
      anchors: vertices.flatMap((vertex, index) => vertex.fixed ? [index] : []),
    };
  };
  let effectiveStrength = settings.deformationStrength;
  let attempt = buildAttempt(effectiveStrength);
  let fallback = false;
  for (let pass = 0; pass < 8 && hasInvertedTriangles(attempt.vertices, attempt.triangles); pass++) {
    effectiveStrength *= 0.5;
    attempt = buildAttempt(effectiveStrength);
  }
  if (hasInvertedTriangles(attempt.vertices, attempt.triangles)) {
    effectiveStrength = 0;
    attempt = buildAttempt(0);
    fallback = true;
  }
  for (const triangle of attempt.triangles) {
    triangle.normal = normalFor(attempt.vertices, triangle.vertices, dem.dxMeters, dem.dyMeters);
  }
  return {
    vertices: attempt.vertices,
    triangles: attempt.triangles,
    edges: buildEdges(attempt.triangles),
    crestPath: attempt.crestPath,
    anchorVertices: attempt.anchors,
    crestControls,
    sourceWidth: dem.width,
    sourceHeight: dem.height,
    sourceGridX: xs,
    sourceGridY: ys,
    dxMeters: dem.dxMeters,
    dyMeters: dem.dyMeters,
    sampleStride: stride,
    deformationStrengthRequested: settings.deformationStrength,
    deformationStrengthEffective: effectiveStrength,
    deformationFallback: fallback,
  };
}

function normalizeProjectionSettings(requested: MountainPerspectiveProjectionSettings): Required<MountainPerspectiveProjectionSettings> {
  return {
    viewAngleDeg: clamp(requested.viewAngleDeg ?? DEFAULT_PROJECTION_SETTINGS.viewAngleDeg, 45, 90),
    heightExaggeration: clamp(requested.heightExaggeration ?? DEFAULT_PROJECTION_SETTINGS.heightExaggeration, 0.25, 3),
  };
}

function rawProjectionPoint(vertex: MountainPerspectiveVertex, settings: Required<MountainPerspectiveProjectionSettings>, dyMeters: number): MountainPerspectiveProjectedPoint {
  const coefficient = Math.tan((90 - settings.viewAngleDeg) * Math.PI / 180) * settings.heightExaggeration;
  const reliefPixels = vertex.reliefM / Math.max(1e-6, dyMeters);
  return {
    x: vertex.illustratedX,
    y: vertex.illustratedY - reliefPixels * coefficient,
    depth: vertex.illustratedY * Math.cos(settings.viewAngleDeg * Math.PI / 180)
      + reliefPixels * Math.sin(settings.viewAngleDeg * Math.PI / 180),
  };
}

export function mountainPerspectiveProjectedBounds(
  mesh: MountainPerspectiveMesh,
  requested: MountainPerspectiveProjectionSettings,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const settings = normalizeProjectionSettings(requested);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const vertex of mesh.vertices) {
    if (!vertex.active) continue;
    const point = rawProjectionPoint(vertex, settings, mesh.dyMeters);
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: mesh.sourceWidth, maxY: mesh.sourceHeight };
  return { minX, minY, maxX, maxY };
}

export function mountainPerspectiveFrame(
  mesh: MountainPerspectiveMesh,
  projections: readonly MountainPerspectiveProjectionSettings[],
  padding = 24,
): MountainPerspectiveFrame {
  const bounds = projections.map(projection => mountainPerspectiveProjectedBounds(mesh, projection));
  const minX = Math.min(...bounds.map(value => value.minX));
  const minY = Math.min(...bounds.map(value => value.minY));
  const maxX = Math.max(...bounds.map(value => value.maxX));
  const maxY = Math.max(...bounds.map(value => value.maxY));
  return {
    originX: Math.floor(minX - padding),
    originY: Math.floor(minY - padding),
    width: Math.ceil(maxX - minX + padding * 2),
    height: Math.ceil(maxY - minY + padding * 2),
    padding,
  };
}

export function projectMountainPerspectiveMesh(
  mesh: MountainPerspectiveMesh,
  requested: MountainPerspectiveProjectionSettings,
  frame?: MountainPerspectiveFrame,
): MountainPerspectiveProjectedMesh {
  const settings = normalizeProjectionSettings(requested);
  const resolvedFrame = frame ?? mountainPerspectiveFrame(mesh, [settings]);
  return {
    points: mesh.vertices.map(vertex => {
      const point = rawProjectionPoint(vertex, settings, mesh.dyMeters);
      return { x: point.x - resolvedFrame.originX, y: point.y - resolvedFrame.originY, depth: point.depth };
    }),
    frame: resolvedFrame,
    settings,
  };
}

function bracketGrid(values: readonly number[], value: number): { index: number; fraction: number } | undefined {
  if (values.length < 2 || value < values[0] || value > values[values.length - 1]) return undefined;
  let low = 0;
  let high = values.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= value) low = middle;
    else high = middle;
  }
  return {
    index: Math.min(values.length - 2, low),
    fraction: clamp01((value - values[low]) / Math.max(1e-6, values[Math.min(values.length - 1, low + 1)] - values[low])),
  };
}

function projectSourcePoint(
  mesh: MountainPerspectiveMesh,
  projected: MountainPerspectiveProjectedMesh,
  sourceX: number,
  sourceY: number,
): { point: MountainPerspectiveProjectedPoint; triangleIndex: number } | undefined {
  const column = bracketGrid(mesh.sourceGridX, sourceX);
  const row = bracketGrid(mesh.sourceGridY, sourceY);
  if (!column || !row) return undefined;
  const columns = mesh.sourceGridX.length;
  const cell = row.index * (columns - 1) + column.index;
  const topLeft = row.index * columns + column.index;
  const topRight = topLeft + 1;
  const bottomLeft = topLeft + columns;
  const bottomRight = bottomLeft + 1;
  const u = column.fraction;
  const v = row.fraction;
  const firstTriangle = u + v <= 1;
  const indices: [number, number, number] = firstTriangle
    ? [topLeft, topRight, bottomLeft]
    : [topRight, bottomRight, bottomLeft];
  const weights: [number, number, number] = firstTriangle
    ? [1 - u - v, u, v]
    : [1 - v, u + v - 1, 1 - u];
  const triangleIndex = cell * 2 + (firstTriangle ? 0 : 1);
  if (!mesh.triangles[triangleIndex]?.active) return undefined;
  const points = indices.map(index => projected.points[index]);
  return {
    triangleIndex,
    point: {
      x: points[0].x * weights[0] + points[1].x * weights[1] + points[2].x * weights[2],
      y: points[0].y * weights[0] + points[1].y * weights[1] + points[2].y * weights[2],
      depth: points[0].depth * weights[0] + points[1].depth * weights[1] + points[2].depth * weights[2],
    },
  };
}

function colorForLight(
  light: number,
  mode: MountainLightingMode,
): [number, number, number] {
  const dark: [number, number, number] = [82, 76, 67];
  const middle: [number, number, number] = [151, 139, 119];
  const lightTone: [number, number, number] = [218, 208, 184];
  const stylized = stylizeMountainLight(light, mode);
  if (mode === 'two-tone') return stylized >= 0.5 ? lightTone : dark;
  if (mode === 'three-tone') return stylized >= 0.75 ? lightTone : stylized >= 0.25 ? middle : dark;
  const value = stylized;
  const from = value < 0.5 ? dark : middle;
  const to = value < 0.5 ? middle : lightTone;
  const t = value < 0.5 ? value * 2 : (value - 0.5) * 2;
  return [
    Math.round(from[0] * (1 - t) + to[0] * t),
    Math.round(from[1] * (1 - t) + to[1] * t),
    Math.round(from[2] * (1 - t) + to[2] * t),
  ];
}

interface SampledIllustrationMaterial {
  color: [number, number, number];
  alpha: number;
}

/** Bilinearly sample the production material layer in source DEM space. */
function sampleIllustrationMaterial(
  illustration: MountainIllustration,
  width: number,
  height: number,
  sourceX: number,
  sourceY: number,
  layer: 'material' | 'hatching' | 'final' = 'material',
): SampledIllustrationMaterial | undefined {
  const field = layer === 'material' ? illustration.materialRgba : illustration.rgba;
  if (field.length < width * height * 4) return undefined;
  const x = Math.max(0, Math.min(width - 1, sourceX));
  const y = Math.max(0, Math.min(height - 1, sourceY));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const sample = (channel: number): number => {
    const topLeft = field[(y0 * width + x0) * 4 + channel];
    const topRight = field[(y0 * width + x1) * 4 + channel];
    const bottomLeft = field[(y1 * width + x0) * 4 + channel];
    const bottomRight = field[(y1 * width + x1) * 4 + channel];
    const top = topLeft * (1 - tx) + topRight * tx;
    const bottom = bottomLeft * (1 - tx) + bottomRight * tx;
    return top * (1 - ty) + bottom * ty;
  };
  const alpha = sample(3) / 255;
  if (alpha <= 1e-3) return undefined;
  const sampled: SampledIllustrationMaterial = {
    color: [sample(0), sample(1), sample(2)],
    alpha,
  };
  if (layer === 'hatching') {
    // The production final layer intentionally tints snow hatches toward the
    // blue snow-shadow stop. The camera study keeps the material/snow color,
    // then reapplies the stroke masks with the cartographic dark ink base.
    const crest = illustration.silhouetteAlpha.length >= width * height
      ? sampleScalarField(illustration.silhouetteAlpha, width, height, sourceX, sourceY) / 255
      : 0;
    if (crest > 0.08) return sampleIllustrationMaterial(illustration, width, height, sourceX, sourceY, 'material');
    const downhill = illustration.faceStrokeAlpha.length >= width * height
      ? sampleScalarField(illustration.faceStrokeAlpha, width, height, sourceX, sourceY) / 255
      : 0;
    const level = illustration.interiorRidgeAlpha.length >= width * height
      ? sampleScalarField(illustration.interiorRidgeAlpha, width, height, sourceX, sourceY) / 255
      : 0;
    // Keep only the centre of each production stroke. The source masks are
    // intentionally soft and wide enough for the normal map renderer; using
    // their low-opacity fringe here made camera hatches read as broad blue
    // bands beside the much finer structural ridge pen. A nonlinear core
    // preserves antialiasing while making the visible mark both darker and
    // narrower.
    const hatchAlpha = mountainHatchCoreAlpha(downhill, level);
    const ink = MOUNTAIN_HATCH_INK;
    return {
      color: [
        sampled.color[0] * (1 - hatchAlpha) + ink[0] * hatchAlpha,
        sampled.color[1] * (1 - hatchAlpha) + ink[1] * hatchAlpha,
        sampled.color[2] * (1 - hatchAlpha) + ink[2] * hatchAlpha,
      ],
      alpha: sampled.alpha,
    };
  }
  return sampled;
}

/** Production-compatible 1..2 height ramp for structural mountain strokes. */
function heightBasedMountainStrokeThickness(
  dem: MountainDEMData,
  sourceX: number,
  sourceY: number,
): number {
  const elevation = sampleScalarField(dem.elevation, dem.width, dem.height, sourceX, sourceY);
  const elevationRange = Math.max(1, dem.maxElevationM - dem.minElevationM);
  return 1 + clamp01((elevation - dem.minElevationM) / elevationRange);
}

/** Rasterize the deformed surface, its depth-tested faces, and structural edges. */
export function renderMountainPerspectiveMesh(
  mesh: MountainPerspectiveMesh,
  dem: MountainDEMData,
  projection: MountainPerspectiveProjectionSettings,
  frame: MountainPerspectiveFrame,
  options: MountainPerspectiveRenderOptions = {},
): MountainPerspectiveRenderResult {
  const projected = projectMountainPerspectiveMesh(mesh, projection, frame);
  const width = frame.width;
  const height = frame.height;
  const data = new Uint8ClampedArray(width * height * 4);
  const depth = new Float32Array(width * height).fill(-Infinity);
  const visibleTriangle = new Int32Array(width * height).fill(-1);
  const sourceX = new Float32Array(width * height).fill(-1);
  const sourceY = new Float32Array(width * height).fill(-1);
  const waterClipped = new Uint8Array(width * height);
  const edge = (a: MountainPerspectiveProjectedPoint, b: MountainPerspectiveProjectedPoint, x: number, y: number) =>
    (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
  const drawFaces = options.showFaces !== false;
  const lightingMode = options.lightingMode
    ?? (options.continuousLighting === true ? 'continuous' : DEFAULT_MOUNTAIN_LIGHTING_MODE);
  for (let triangleIndex = 0; triangleIndex < mesh.triangles.length; triangleIndex++) {
    const triangle = mesh.triangles[triangleIndex];
    if (!triangle.active) continue;
    const [aIndex, bIndex, cIndex] = triangle.vertices;
    const a = projected.points[aIndex], b = projected.points[bIndex], c = projected.points[cIndex];
    const area = edge(a, b, c.x, c.y);
    if (Math.abs(area) <= 1e-7) continue;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    const light = clamp01(triangle.normal[0] * -0.54 + triangle.normal[1] * -0.54 + triangle.normal[2] * 0.65 + 0.35);
    const color = colorForLight(light, lightingMode);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const wa = edge(b, c, x + 0.5, y + 0.5) / area;
      const wb = edge(c, a, x + 0.5, y + 0.5) / area;
      const wc = 1 - wa - wb;
      if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) continue;
      const sx = wa * mesh.vertices[aIndex].sourceX + wb * mesh.vertices[bIndex].sourceX + wc * mesh.vertices[cIndex].sourceX;
      const sy = wa * mesh.vertices[aIndex].sourceY + wb * mesh.vertices[bIndex].sourceY + wc * mesh.vertices[cIndex].sourceY;
      if (waterAt(dem, sx, sy)) {
        waterClipped[y * width + x] = 1;
        continue;
      }
      const pixelDepth = wa * a.depth + wb * b.depth + wc * c.depth;
      const index = y * width + x;
      if (pixelDepth < depth[index]) continue;
      depth[index] = pixelDepth;
      visibleTriangle[index] = triangleIndex;
      sourceX[index] = sx;
      sourceY[index] = sy;
      if (drawFaces) {
        data[index * 4] = color[0];
        data[index * 4 + 1] = color[1];
        data[index * 4 + 2] = color[2];
        data[index * 4 + 3] = 255;
      }
    }
  }
  const drawProjectedLine = (a: MountainPerspectiveProjectedPoint, b: MountainPerspectiveProjectedPoint,
    radius: number, color: [number, number, number], opacity: number, depthTolerance = 2.5) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(length * 1.8));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const x = a.x * (1 - t) + b.x * t;
      const y = a.y * (1 - t) + b.y * t;
      const lineDepth = a.depth * (1 - t) + b.depth * t;
      const left = Math.max(0, Math.floor(x - radius - 1));
      const right = Math.min(width - 1, Math.ceil(x + radius + 1));
      const top = Math.max(0, Math.floor(y - radius - 1));
      const bottom = Math.min(height - 1, Math.ceil(y + radius + 1));
      for (let py = top; py <= bottom; py++) for (let px = left; px <= right; px++) {
        const distance = Math.hypot(px + 0.5 - x, py + 0.5 - y);
        if (distance > radius) continue;
        const index = py * width + px;
        if (visibleTriangle[index] < 0 || depth[index] < lineDepth - depthTolerance) continue;
        const alpha = clamp01((radius + 1 - distance) * opacity);
        for (let channel = 0; channel < 3; channel++) data[index * 4 + channel] =
          data[index * 4 + channel] * (1 - alpha) + color[channel] * alpha;
        data[index * 4 + 3] = 255;
      }
    }
  };
  const drawLine = (aIndex: number, bIndex: number, radius: number, color: [number, number, number], opacity: number) => {
    drawProjectedLine(projected.points[aIndex], projected.points[bIndex], radius, color, opacity);
  };
  for (const edgeValue of mesh.edges) {
    if (options.showWireframe) drawLine(edgeValue.a, edgeValue.b, 0.45, [104, 96, 83], 0.48);
    else if (options.showSilhouette !== false && edgeValue.boundary) drawLine(edgeValue.a, edgeValue.b, 1.45, [53, 47, 39], 0.95);
    else if (options.showCreases !== false && edgeValue.crease) drawLine(edgeValue.a, edgeValue.b, 0.68, [81, 69, 55], 0.7);
  }
  if (options.showCrest !== false) {
    for (let index = 1; index < mesh.crestPath.length; index++) {
      drawLine(mesh.crestPath[index - 1], mesh.crestPath[index], 1.65, [45, 41, 35], 0.95);
    }
  }
  if (options.pattern && options.showPatternPaths !== false) {
    const patternOpacity = clamp01(options.patternOpacity ?? 1);
    const drawRidge = (
      points: MountainPerspectiveProjectedPoint[],
      radius: number,
      color: [number, number, number],
      opacity: number,
    ) => {
      if (points.length < 2) return;
      for (let index = 1; index < points.length; index++) {
        drawProjectedLine(points[index - 1], points[index], Math.max(1.15, radius), color,
          Math.min(1, opacity * 1.12), 4);
      }
    };
    const drawPatternPath = (path: MountainStrokePath) => {
      if (path.points.length === 0) return;
      const ridge = path.kind === 'ridge';
      const dot = path.kind === 'dot';
      const color: [number, number, number] = ridge
        ? (path.primary ? [45, 40, 33] : [73, 62, 49])
        : path.kind === 'contour' ? [99, 86, 67] : [67, 57, 46];
      const width = Math.max(0.35, path.width * (ridge ? 1.15 : 1.0));
      const opacity = patternOpacity * path.opacity * (ridge ? 0.9 : 0.72);
      if (ridge && path.primary) {
        const projectedPath = path.points
          .map(point => projectSourcePoint(mesh, projected, point.x, point.y)?.point)
          .filter((point): point is MountainPerspectiveProjectedPoint => !!point);
        drawRidge(projectedPath, Math.max(1.05, width * 1.2), color, Math.min(1, opacity * 1.12));
        return;
      }
      for (let index = 1; index < path.points.length; index++) {
        const previous = projectSourcePoint(mesh, projected, path.points[index - 1].x, path.points[index - 1].y);
        const current = projectSourcePoint(mesh, projected, path.points[index].x, path.points[index].y);
        if (!previous || !current) continue;
        drawProjectedLine(previous.point, current.point, dot ? Math.max(0.8, width * 1.4) : width, color, opacity, 4);
      }
    };
    for (const path of options.pattern.paths ?? []) drawPatternPath(path);
  }
  return { width, height, data, depth, visibleTriangle, sourceX, sourceY, waterClipped, projected };
}

/**
 * Conventional camera projections used by the isolated 3D study. The camera
 * looks from positive source-Y toward negative source-Y, matching the
 * screen-up direction of the legacy mountain projection above.
 */
export type MountainCameraType = 'orthographic' | 'perspective';

export interface MountainCameraProjectionSettings {
  cameraType: MountainCameraType;
  /** Camera elevation above the terrain plane, in degrees. */
  cameraElevationDeg?: number;
  /** Vertical relief multiplier applied around the camera target elevation. */
  heightExaggeration?: number;
  /** Vertical field of view used by the perspective camera. */
  fieldOfViewDeg?: number;
}

export interface MountainCameraResolvedSettings {
  cameraType: MountainCameraType;
  cameraElevationDeg: number;
  heightExaggeration: number;
  fieldOfViewDeg: number;
  cameraDistanceM: number;
  targetElevationM: number;
}

export interface MountainCameraProjectedPoint extends MountainPerspectiveProjectedPoint {
  /** Positive distance from the camera to this vertex along the view axis. */
  cameraDistanceM: number;
  /** Reciprocal camera distance for perspective-correct interpolation. */
  inverseCameraDistance: number;
}

export interface MountainCameraProjectedMesh {
  points: MountainCameraProjectedPoint[];
  frame: MountainPerspectiveFrame;
  settings: MountainCameraResolvedSettings;
}

export interface MountainCameraRenderResult {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  depth: Float32Array;
  visibleTriangle: Int32Array;
  sourceX: Float32Array;
  sourceY: Float32Array;
  waterClipped: Uint8Array;
  projected: MountainCameraProjectedMesh;
}

export type MountainStudyProjection =
  | { mode: 'existing'; settings: MountainPerspectiveProjectionSettings }
  | { mode: MountainCameraType; settings: MountainCameraProjectionSettings };

export const MOUNTAIN_CAMERA_ELEVATION_PRESETS = [30, 45, 60, 75, 80] as const;
export const MOUNTAIN_CAMERA_ELEVATION_DEFAULT_DEG = 45;
export const MOUNTAIN_CAMERA_ELEVATION_MAX_DEG = 85;
export const MOUNTAIN_CAMERA_HEIGHT_DEFAULT = 1;
export const MOUNTAIN_CAMERA_FOV_DEFAULT_DEG = 35;

function normalizeCameraProjectionSettings(
  requested: MountainCameraProjectionSettings,
): Omit<MountainCameraResolvedSettings, 'cameraDistanceM' | 'targetElevationM'> {
  return {
    cameraType: requested.cameraType,
    cameraElevationDeg: clamp(requested.cameraElevationDeg ?? MOUNTAIN_CAMERA_ELEVATION_DEFAULT_DEG, 15, MOUNTAIN_CAMERA_ELEVATION_MAX_DEG),
    heightExaggeration: clamp(requested.heightExaggeration ?? MOUNTAIN_CAMERA_HEIGHT_DEFAULT, 0.25, 3),
    fieldOfViewDeg: clamp(requested.fieldOfViewDeg ?? MOUNTAIN_CAMERA_FOV_DEFAULT_DEG, 20, 70),
  };
}

interface CameraTarget {
  x: number;
  y: number;
  elevationM: number;
}

interface CameraVertexSpace {
  xM: number;
  upM: number;
  depthM: number;
}

interface CameraProjectionContext {
  settings: MountainCameraResolvedSettings;
  target: CameraTarget;
  focalLengthM: number;
  spaces: CameraVertexSpace[];
}

function cameraActiveVertices(mesh: MountainPerspectiveMesh): MountainPerspectiveVertex[] {
  const active = mesh.vertices.filter(vertex => vertex.active);
  return active.length > 0 ? active : mesh.vertices;
}

function cameraTargetFor(mesh: MountainPerspectiveMesh): CameraTarget {
  const vertices = cameraActiveVertices(mesh);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minElevation = Infinity;
  let maxElevation = -Infinity;
  for (const vertex of vertices) {
    minX = Math.min(minX, vertex.illustratedX);
    maxX = Math.max(maxX, vertex.illustratedX);
    minY = Math.min(minY, vertex.illustratedY);
    maxY = Math.max(maxY, vertex.illustratedY);
    minElevation = Math.min(minElevation, vertex.elevationM);
    maxElevation = Math.max(maxElevation, vertex.elevationM);
  }
  return {
    x: Number.isFinite(minX) ? (minX + maxX) * 0.5 : mesh.sourceWidth * 0.5,
    y: Number.isFinite(minY) ? (minY + maxY) * 0.5 : mesh.sourceHeight * 0.5,
    elevationM: Number.isFinite(minElevation) ? (minElevation + maxElevation) * 0.5 : 0,
  };
}

function cameraSpaceFor(
  vertex: MountainPerspectiveVertex,
  mesh: MountainPerspectiveMesh,
  target: CameraTarget,
  settings: Omit<MountainCameraResolvedSettings, 'cameraDistanceM' | 'targetElevationM'>,
): CameraVertexSpace {
  const elevationM = (vertex.elevationM - target.elevationM) * settings.heightExaggeration;
  const xM = (vertex.illustratedX - target.x) * mesh.dxMeters;
  const yM = (vertex.illustratedY - target.y) * mesh.dyMeters;
  const angle = settings.cameraElevationDeg * Math.PI / 180;
  // Source Y points down the map. Positive `upM` is screen-up and positive
  // `depthM` points toward the camera placed on the source-Y side.
  return {
    xM,
    upM: -yM * Math.sin(angle) + elevationM * Math.cos(angle),
    depthM: yM * Math.cos(angle) + elevationM * Math.sin(angle),
  };
}

function buildCameraProjectionContext(
  mesh: MountainPerspectiveMesh,
  requested: MountainCameraProjectionSettings,
): CameraProjectionContext {
  const normalized = normalizeCameraProjectionSettings(requested);
  const target = cameraTargetFor(mesh);
  const spaces = mesh.vertices.map(vertex => cameraSpaceFor(vertex, mesh, target, normalized));
  let maxAbsDepth = 0;
  let maxAbsExtent = 0;
  for (const space of spaces) {
    maxAbsDepth = Math.max(maxAbsDepth, Math.abs(space.depthM));
    maxAbsExtent = Math.max(maxAbsExtent, Math.abs(space.xM), Math.abs(space.upM));
  }
  const tangent = Math.tan(normalized.fieldOfViewDeg * Math.PI / 360);
  const margin = Math.max(1, maxAbsExtent * 0.04, maxAbsDepth * 0.08);
  const cameraDistanceM = normalized.cameraType === 'perspective'
    ? Math.max(maxAbsDepth + margin, maxAbsExtent / Math.max(1e-6, tangent) + margin) * 1.08
    : 1;
  return {
    settings: {
      ...normalized,
      cameraDistanceM,
      targetElevationM: target.elevationM,
    },
    target,
    focalLengthM: cameraDistanceM / Math.max(1e-6, tangent),
    spaces,
  };
}

function rawCameraProjectionPoint(
  context: CameraProjectionContext,
  vertexIndex: number,
  mesh: MountainPerspectiveMesh,
): MountainCameraProjectedPoint {
  const space = context.spaces[vertexIndex];
  const tangent = Math.tan(context.settings.fieldOfViewDeg * Math.PI / 360);
  // Match the orthographic camera's target-plane scale to the perspective
  // camera at its aim point. This keeps the three study cards comparable
  // while perspective still changes scale with camera-space distance.
  const targetPlaneScale = 1 / Math.max(1e-6, tangent);
  const xPixels = space.xM / Math.max(1e-6, mesh.dxMeters);
  const upPixels = space.upM / Math.max(1e-6, mesh.dyMeters);
  if (context.settings.cameraType === 'orthographic') {
    return {
      x: context.target.x + xPixels * targetPlaneScale,
      y: context.target.y - upPixels * targetPlaneScale,
      depth: space.depthM / Math.max(1e-6, mesh.dyMeters),
      cameraDistanceM: 1,
      inverseCameraDistance: 1,
    };
  }
  const cameraDistanceM = Math.max(1e-4, context.settings.cameraDistanceM - space.depthM);
  const perspectiveScale = context.focalLengthM / cameraDistanceM;
  return {
    x: context.target.x + xPixels * perspectiveScale,
    y: context.target.y - upPixels * perspectiveScale,
    depth: context.settings.cameraDistanceM - cameraDistanceM,
    cameraDistanceM,
    inverseCameraDistance: 1 / cameraDistanceM,
  };
}

export function mountainCameraProjectedBounds(
  mesh: MountainPerspectiveMesh,
  requested: MountainCameraProjectionSettings,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const context = buildCameraProjectionContext(mesh, requested);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < mesh.vertices.length; index++) {
    if (!mesh.vertices[index].active) continue;
    const point = rawCameraProjectionPoint(context, index, mesh);
    if (![point.x, point.y].every(Number.isFinite)) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: mesh.sourceWidth, maxY: mesh.sourceHeight };
  return { minX, minY, maxX, maxY };
}

export function mountainCameraFrame(
  mesh: MountainPerspectiveMesh,
  projections: readonly MountainCameraProjectionSettings[],
  padding = 24,
): MountainPerspectiveFrame {
  const bounds = projections.map(projection => mountainCameraProjectedBounds(mesh, projection));
  const minX = Math.min(...bounds.map(value => value.minX));
  const minY = Math.min(...bounds.map(value => value.minY));
  const maxX = Math.max(...bounds.map(value => value.maxX));
  const maxY = Math.max(...bounds.map(value => value.maxY));
  return {
    originX: Math.floor(minX - padding),
    originY: Math.floor(minY - padding),
    width: Math.ceil(maxX - minX + padding * 2),
    height: Math.ceil(maxY - minY + padding * 2),
    padding,
  };
}

export function mountainStudyProjectedBounds(
  mesh: MountainPerspectiveMesh,
  projection: MountainStudyProjection,
): { minX: number; minY: number; maxX: number; maxY: number } {
  return projection.mode === 'existing'
    ? mountainPerspectiveProjectedBounds(mesh, projection.settings)
    : mountainCameraProjectedBounds(mesh, projection.settings);
}

export function mountainStudyFrame(
  mesh: MountainPerspectiveMesh,
  projections: readonly MountainStudyProjection[],
  padding = 24,
): MountainPerspectiveFrame {
  const bounds = projections.map(projection => mountainStudyProjectedBounds(mesh, projection));
  const minX = Math.min(...bounds.map(value => value.minX));
  const minY = Math.min(...bounds.map(value => value.minY));
  const maxX = Math.max(...bounds.map(value => value.maxX));
  const maxY = Math.max(...bounds.map(value => value.maxY));
  return {
    originX: Math.floor(minX - padding),
    originY: Math.floor(minY - padding),
    width: Math.ceil(maxX - minX + padding * 2),
    height: Math.ceil(maxY - minY + padding * 2),
    padding,
  };
}

export function projectMountainCameraMesh(
  mesh: MountainPerspectiveMesh,
  requested: MountainCameraProjectionSettings,
  frame?: MountainPerspectiveFrame,
): MountainCameraProjectedMesh {
  const context = buildCameraProjectionContext(mesh, requested);
  const resolvedFrame = frame ?? mountainCameraFrame(mesh, [requested]);
  return {
    points: mesh.vertices.map((_, index) => {
      const point = rawCameraProjectionPoint(context, index, mesh);
      return {
        ...point,
        x: point.x - resolvedFrame.originX,
        y: point.y - resolvedFrame.originY,
      };
    }),
    frame: resolvedFrame,
    settings: context.settings,
  };
}

function cameraTriangleWeights(
  a: MountainCameraProjectedPoint,
  b: MountainCameraProjectedPoint,
  c: MountainCameraProjectedPoint,
  wa: number,
  wb: number,
  wc: number,
  perspective: boolean,
): { a: number; b: number; c: number; cameraDistanceM: number; depth: number } {
  if (!perspective) {
    return {
      a: wa,
      b: wb,
      c: wc,
      cameraDistanceM: 1,
      depth: wa * a.depth + wb * b.depth + wc * c.depth,
    };
  }
  const weightedA = wa * a.inverseCameraDistance;
  const weightedB = wb * b.inverseCameraDistance;
  const weightedC = wc * c.inverseCameraDistance;
  const denominator = Math.max(1e-12, weightedA + weightedB + weightedC);
  const correctedA = weightedA / denominator;
  const correctedB = weightedB / denominator;
  const correctedC = weightedC / denominator;
  const cameraDistanceM = 1 / denominator;
  return { a: correctedA, b: correctedB, c: correctedC, cameraDistanceM, depth: 0 };
}

/** Project a source-space stroke onto the same camera surface as the faces. */
function projectCameraSourcePoint(
  mesh: MountainPerspectiveMesh,
  projected: MountainCameraProjectedMesh,
  sourceX: number,
  sourceY: number,
): { point: MountainCameraProjectedPoint; triangleIndex: number } | undefined {
  const column = bracketGrid(mesh.sourceGridX, sourceX);
  const row = bracketGrid(mesh.sourceGridY, sourceY);
  if (!column || !row) return undefined;
  const columns = mesh.sourceGridX.length;
  const cell = row.index * (columns - 1) + column.index;
  const topLeft = row.index * columns + column.index;
  const topRight = topLeft + 1;
  const bottomLeft = topLeft + columns;
  const bottomRight = bottomLeft + 1;
  const u = column.fraction;
  const v = row.fraction;
  const firstTriangle = u + v <= 1;
  const indices: [number, number, number] = firstTriangle
    ? [topLeft, topRight, bottomLeft]
    : [topRight, bottomRight, bottomLeft];
  const barycentric: [number, number, number] = firstTriangle
    ? [1 - u - v, u, v]
    : [1 - v, u + v - 1, 1 - u];
  const triangleIndex = cell * 2 + (firstTriangle ? 0 : 1);
  if (!mesh.triangles[triangleIndex]?.active) return undefined;
  const [a, b, c] = indices.map(index => projected.points[index]);
  const weights = cameraTriangleWeights(
    a, b, c, barycentric[0], barycentric[1], barycentric[2],
    projected.settings.cameraType === 'perspective',
  );
  const cameraDistanceM = projected.settings.cameraType === 'perspective'
    ? weights.cameraDistanceM
    : 1;
  return {
    triangleIndex,
    point: {
      x: a.x * weights.a + b.x * weights.b + c.x * weights.c,
      y: a.y * weights.a + b.y * weights.b + c.y * weights.c,
      depth: projected.settings.cameraType === 'perspective'
        ? projected.settings.cameraDistanceM - cameraDistanceM
        : weights.depth,
      cameraDistanceM,
      inverseCameraDistance: projected.settings.cameraType === 'perspective'
        ? 1 / Math.max(1e-12, cameraDistanceM)
        : 1,
    },
  };
}

/** Rasterize a complete terrain patch through a conventional camera. */
export function renderMountainCameraMesh(
  mesh: MountainPerspectiveMesh,
  dem: MountainDEMData,
  projection: MountainCameraProjectionSettings,
  frame: MountainPerspectiveFrame,
  options: MountainPerspectiveRenderOptions = {},
): MountainCameraRenderResult {
  const requestedScale = options.outputScale ?? 1;
  const outputScale = Number.isFinite(requestedScale)
    ? Math.max(1, Math.min(4, requestedScale))
    : 1;
  const baseProjected = projectMountainCameraMesh(mesh, projection, frame);
  const projected = outputScale === 1
    ? baseProjected
    : {
        ...baseProjected,
        points: baseProjected.points.map(point => ({
          ...point,
          x: point.x * outputScale,
          y: point.y * outputScale,
        })),
        frame: {
          ...baseProjected.frame,
          width: Math.ceil(baseProjected.frame.width * outputScale),
          height: Math.ceil(baseProjected.frame.height * outputScale),
          padding: baseProjected.frame.padding * outputScale,
        },
      };
  const width = projected.frame.width;
  const height = projected.frame.height;
  const data = new Uint8ClampedArray(width * height * 4);
  const depth = new Float32Array(width * height).fill(-Infinity);
  const visibleTriangle = new Int32Array(width * height).fill(-1);
  const sourceX = new Float32Array(width * height).fill(-1);
  const sourceY = new Float32Array(width * height).fill(-1);
  const waterClipped = new Uint8Array(width * height);
  const perspective = projected.settings.cameraType === 'perspective';
  const edge = (a: MountainCameraProjectedPoint, b: MountainCameraProjectedPoint, x: number, y: number) =>
    (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
  const drawFaces = options.showFaces !== false;
  const lightingMode = options.lightingMode
    ?? (options.continuousLighting === true ? 'continuous' : DEFAULT_MOUNTAIN_LIGHTING_MODE);
  const maximumRelief = mesh.vertices.reduce((maximum, vertex) => Math.max(maximum, vertex.reliefM), 0);
  const silhouetteReliefThreshold = maximumRelief * 0.10;
  const useHeightBasedThickness = options.heightBasedThickness !== false;
  const requestedRidgeThicknessScale = options.ridgeThicknessScale ?? 1;
  const ridgeThicknessScale = Number.isFinite(requestedRidgeThicknessScale)
    ? Math.max(0.25, Math.min(4, requestedRidgeThicknessScale))
    : 1;
  const vertexStrokeThickness = (index: number): number => useHeightBasedThickness
    ? heightBasedMountainStrokeThickness(dem, mesh.vertices[index].sourceX, mesh.vertices[index].sourceY)
    : 1;
  for (let triangleIndex = 0; triangleIndex < mesh.triangles.length; triangleIndex++) {
    const triangle = mesh.triangles[triangleIndex];
    if (!triangle.active) continue;
    const [aIndex, bIndex, cIndex] = triangle.vertices;
    const a = projected.points[aIndex];
    const b = projected.points[bIndex];
    const c = projected.points[cIndex];
    const area = edge(a, b, c.x, c.y);
    if (Math.abs(area) <= 1e-7) continue;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    const light = clamp01(triangle.normal[0] * -0.54 + triangle.normal[1] * -0.54 + triangle.normal[2] * 0.65 + 0.35);
    const color = colorForLight(light, lightingMode);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const wa = edge(b, c, x + 0.5, y + 0.5) / area;
      const wb = edge(c, a, x + 0.5, y + 0.5) / area;
      const wc = 1 - wa - wb;
      if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) continue;
      const weights = cameraTriangleWeights(a, b, c, wa, wb, wc, perspective);
      const sx = weights.a * mesh.vertices[aIndex].sourceX
        + weights.b * mesh.vertices[bIndex].sourceX
        + weights.c * mesh.vertices[cIndex].sourceX;
      const sy = weights.a * mesh.vertices[aIndex].sourceY
        + weights.b * mesh.vertices[bIndex].sourceY
        + weights.c * mesh.vertices[cIndex].sourceY;
      if (waterAt(dem, sx, sy)) {
        waterClipped[y * width + x] = 1;
        continue;
      }
      const pixelDepth = perspective
        ? projected.settings.cameraDistanceM - weights.cameraDistanceM
        : weights.depth;
      const index = y * width + x;
      if (pixelDepth < depth[index]) continue;
      depth[index] = pixelDepth;
      visibleTriangle[index] = triangleIndex;
      sourceX[index] = sx;
      sourceY[index] = sy;
      if (drawFaces) {
        const material = options.illustration
          ? sampleIllustrationMaterial(options.illustration, dem.width, dem.height, sx, sy,
            options.illustrationLayer)
          : undefined;
        const materialAlpha = material?.alpha ?? 0;
        data[index * 4] = color[0] * (1 - materialAlpha) + (material?.color[0] ?? 0) * materialAlpha;
        data[index * 4 + 1] = color[1] * (1 - materialAlpha) + (material?.color[1] ?? 0) * materialAlpha;
        data[index * 4 + 2] = color[2] * (1 - materialAlpha) + (material?.color[2] ?? 0) * materialAlpha;
        data[index * 4 + 3] = 255;
      }
    }
  }
  const drawProjectedLine = (
    a: MountainCameraProjectedPoint,
    b: MountainCameraProjectedPoint,
    radius: number,
    color: [number, number, number],
    opacity: number,
    depthTolerance = 2.5,
  ) => {
    paintMountainCameraSegment(data, width, height, a, b, radius * outputScale, color, opacity,
      (index, t) => {
        const lineDepth = perspective
          ? projected.settings.cameraDistanceM - 1 / Math.max(1e-12,
            a.inverseCameraDistance * (1 - t) + b.inverseCameraDistance * t)
          : a.depth * (1 - t) + b.depth * t;
        return visibleTriangle[index] >= 0 && depth[index] >= lineDepth - depthTolerance;
      });
  };
  const drawLine = (aIndex: number, bIndex: number, radius: number, color: [number, number, number], opacity: number) => {
    const thickness = (vertexStrokeThickness(aIndex) + vertexStrokeThickness(bIndex)) * 0.5;
    drawProjectedLine(projected.points[aIndex], projected.points[bIndex], radius * thickness, color, opacity);
  };
  for (const edgeValue of mesh.edges) {
    if (options.showWireframe) drawLine(edgeValue.a, edgeValue.b, 0.45, [104, 96, 83], 0.48);
    else if (options.showSilhouette !== false && edgeValue.boundary
      && (mesh.vertices[edgeValue.a].reliefM >= silhouetteReliefThreshold
        || mesh.vertices[edgeValue.b].reliefM >= silhouetteReliefThreshold)) {
      drawLine(edgeValue.a, edgeValue.b, 1.45, [53, 47, 39], 0.95);
    }
    else if (options.showCreases !== false && edgeValue.crease) drawLine(edgeValue.a, edgeValue.b, 0.68, [81, 69, 55], 0.7);
  }
  if (options.showCrest !== false) {
    for (let index = 1; index < mesh.crestPath.length; index++) {
      drawLine(mesh.crestPath[index - 1], mesh.crestPath[index], 1.65 * ridgeThicknessScale, [45, 41, 35], 0.95);
    }
  }
  if (options.pattern && options.showPatternPaths !== false) {
    const patternOpacity = clamp01(options.patternOpacity ?? 1);
    const drawRidge = (
      points: MountainCameraProjectedPoint[],
      radius: number,
      color: [number, number, number],
      opacity: number,
    ) => {
      if (points.length < 2) return;
      for (let index = 1; index < points.length; index++) {
        drawProjectedLine(points[index - 1], points[index], Math.max(1.15, radius), color,
          Math.min(1, opacity * 1.12), 4);
      }
    };
    const drawPatternPath = (path: MountainStrokePath) => {
      if (path.points.length === 0) return;
      const ridge = path.kind === 'ridge';
      const dot = path.kind === 'dot';
      const color: [number, number, number] = ridge
        ? (path.primary ? [45, 40, 33] : [73, 62, 49])
        : path.kind === 'contour' ? [99, 86, 67] : [67, 57, 46];
      const width = Math.max(0.35, path.width * (ridge ? 1.15 : 1));
      const opacity = patternOpacity * path.opacity * (ridge ? 0.9 : 0.82);
      if (ridge && path.primary) {
        const projectedPath = path.points
          .map(point => projectCameraSourcePoint(mesh, projected, point.x, point.y)?.point)
          .filter((point): point is MountainCameraProjectedPoint => !!point);
        drawRidge(projectedPath, Math.max(1.05, width * 1.2), color, opacity);
        return;
      }
      for (let index = 1; index < path.points.length; index++) {
        const previous = projectCameraSourcePoint(mesh, projected, path.points[index - 1].x, path.points[index - 1].y);
        const current = projectCameraSourcePoint(mesh, projected, path.points[index].x, path.points[index].y);
        if (!previous || !current) continue;
        drawProjectedLine(previous.point, current.point,
          dot ? Math.max(0.8, width * 1.4) : width, color, opacity, 4);
      }
    };
    for (const path of options.pattern.paths ?? []) drawPatternPath(path);
  }
  if (options.showPrimaryRidge && options.pattern) {
    const patternOpacity = clamp01(options.patternOpacity ?? 1);
    const primaryRidgeFlatten = clamp01(options.primaryRidgeFlatten ?? 0);
    for (const path of options.pattern.paths ?? []) {
      if (path.kind !== 'ridge' || !path.primary || path.points.length < 2) continue;
      const projectedPath = path.points
        .map(point => projectCameraSourcePoint(mesh, projected, point.x, point.y)?.point)
        .filter((point): point is MountainCameraProjectedPoint => !!point);
      if (projectedPath.length < 2) continue;
      const orderedPath = primaryRidgeFlatten > 1e-3
        ? projectedPath.slice().sort((a, b) => a.x - b.x)
        : projectedPath;
      const minX = orderedPath[0].x;
      const maxX = orderedPath[orderedPath.length - 1].x;
      if (primaryRidgeFlatten > 1e-3 && maxX - minX < 12 * outputScale) continue;
      const meanY = orderedPath.reduce((sum, point) => sum + point.y, 0) / orderedPath.length;
      const trend = (orderedPath[orderedPath.length - 1].y - orderedPath[0].y) * 0.16;
      const opacity = patternOpacity * path.opacity * 0.9;
      for (let index = 1; index < orderedPath.length; index++) {
        const previous = orderedPath[index - 1];
        const current = orderedPath[index];
        const previousT = clamp01((previous.x - minX) / Math.max(1e-6, maxX - minX));
        const currentT = clamp01((current.x - minX) / Math.max(1e-6, maxX - minX));
        const previousTargetY = meanY + trend * (previousT - 0.5);
        const currentTargetY = meanY + trend * (currentT - 0.5);
        const previousPoint = primaryRidgeFlatten > 1e-3
          ? { ...previous, y: previous.y * (1 - primaryRidgeFlatten) + previousTargetY * primaryRidgeFlatten }
          : previous;
        const currentPoint = primaryRidgeFlatten > 1e-3
          ? { ...current, y: current.y * (1 - primaryRidgeFlatten) + currentTargetY * primaryRidgeFlatten }
          : current;
        const thickness = useHeightBasedThickness
          ? (heightBasedMountainStrokeThickness(dem, path.points[index - 1].x, path.points[index - 1].y)
            + heightBasedMountainStrokeThickness(dem, path.points[index].x, path.points[index].y)) * 0.5
          : 1;
        drawProjectedLine(previousPoint, currentPoint,
          Math.max(1.15, path.width * (primaryRidgeFlatten > 1e-3 ? 1.4 : 1.2)
            * ridgeThicknessScale * thickness),
          [45, 40, 33], Math.min(1, opacity * 1.18), primaryRidgeFlatten > 1e-3 ? 9 : 4);
      }
    }
  }
  return { width, height, data, depth, visibleTriangle, sourceX, sourceY, waterClipped, projected };
}

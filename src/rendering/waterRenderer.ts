/**
 * Water rendering: rivers, lakes and shorelines as ink strokes, with wave marks and splines.
 */
import { INSPECTOR_BOUNDS } from "../config/inspectorBounds";
import type { MountainDEMData } from "../terrain/mountainBaseDEM";
import {
  extractDeepOpenOceanMask,
  filterSmallOceanComponents,
} from "../terrain/mountainBaseDEM";
import { buildRiverSiltCreaseField, buildRiverSiltDepth } from "./riverSilt";
import {
  buildDistanceField,
  charcoalStrokePressureAt,
  charcoalStrokePressureFast,
  createCharcoalInterruptionPattern,
  getContourTangentAt,
  hash01,
  isCharcoalInkActiveAtDistance,
  sampleScalarField,
} from "./cartographicStrokeRenderer";
import type { MountainProfiler } from "./mountainProfiler";
import {
  buildWaterStrokeGeometry,
  emptyWaterStrokeGeometry,
  type WaterStrokeGeometry,
} from "./waterStrokeGeometry";
export type {
  WaterStrokeFamily,
  WaterStrokeGeometry,
  WaterStrokePath,
  WaterStrokePathPoint,
} from "./waterStrokeGeometry";
export { getContourTangentAt, hash01 } from "./cartographicStrokeRenderer";

export interface WaterPaintWindow {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface WaterRendererOptions {
  riverThresholdKm2?: number;
  seed?: number;
  useEcologicalBiomeWater?: boolean;
  outlineThickness?: number;
  /** Length multiplier for near-shore marks and offshore wave runs. */
  outlineLength?: number;
  outlineOpacity?: number;
  flowDensity?: number;
  flowLength?: number;
  /** Independent charcoal mark length for inland pools. */
  poolContourLength?: number;
  flowThickness?: number;
  flowOpacity?: number;
  /** Relaxes routed control points and the measured downstream width profile. */
  fillSmoothing?: number;
  /** Smooths ocean wave geometry and outline-style ink variation. */
  outlineSmoothing?: number;
  /** Smooths charcoal contour and river-flow geometry. */
  flowSmoothing?: number;
  /** Use the unified smoothed water surface and its detail layers (default: true). */
  showWaterDetails?: boolean;
  /** Enable / disable ocean coastline bank and contour ripples (default: true). */
  showOceanDetails?: boolean;
  /** Optional precomputed river geometry, used by tiled exports to keep every tile on the same splines. */
  riverSplinesOverride?: readonly RiverSpline[];
  /** Pixel scale used for high-resolution wave mark spacing and geometry. */
  oceanPixelScale?: number;
  /** Global output-pixel origin/stride for deterministic tiled wave marks. */
  oceanCoordinateOffsetX?: number;
  oceanCoordinateOffsetY?: number;
  oceanCoordinateStride?: number;
  /** Set to 0 for tiled export's bounded separable smoothing path. */
  distanceSmoothingIterations?: number;
  effectiveDistanceSmoothingIterations?: number;
  /** Optional tile-local sample of a global ocean distance field. */
  oceanDistanceToCoastOverride?: Float32Array;
  /** Optional tile-local sample (0..1) of the global open-sea mask used for waves. */
  openOceanMaskOverride?: Float32Array;
  /** Global maximum shoreline distance used to keep tiled contour bands coherent. */
  oceanDistanceNormalizationMax?: number;
  /** Optional tile-local bilinear ocean coverage for antialiased coasts. */
  oceanMaskCoverageOverride?: Float32Array;
  /** Local pixels the caller keeps (export tile core). Ocean waves are still
   * placed over the whole region but only painted near this window. */
  paintWindow?: WaterPaintWindow;
  /** Procedural wetland geometry scale in output pixels (1 for preview). */
  wetlandPuddleCoordinateScale?: number;
  /** Output pixels per source DEM cell (1 for preview); sizes the river fallback smoothing. */
  riverCellPx?: number;
  /** Global output-pixel origin for tiled wetland geometry. */
  wetlandPuddleCoordinateOffsetX?: number;
  wetlandPuddleCoordinateOffsetY?: number;
  /** Full output dimensions used for procedural geometry edge tests. */
  wetlandPuddleCoordinateDomainWidth?: number;
  wetlandPuddleCoordinateDomainHeight?: number;
  /** Number of concentric contour ripple bands in ocean (default: 5, range: 1 to 7). */
  oceanRippleCount?: number;
  /** Legacy ocean-wave density control. */
  oceanRippleDensity?: number;
  /** @deprecated Ocean wave thickness follows outlineThickness. */
  oceanWaveThickness?: number;
  /** @deprecated Deep ocean wave thickness follows outlineThickness. */
  deepOceanWaveThickness?: number;
  /** @deprecated Ocean wave opacity follows outlineOpacity. */
  oceanWaveOpacity?: number;
  /** Lake depth in meters that reaches the full deep-water tone (default: 15). */
  lakeFullDepthM?: number;
  /** Enable / disable deep ocean swell clusters (default: true). */
  deepOceanSwells?: boolean;
  /** Density of deep ocean swell clusters (default: 0.18, range: 0 to 1). */
  deepOceanSwellDensity?: number;
  /** Minimum clearance distance from any wave epicenter (default: 32, range: 10 to 200px). */
  /** Independent deep-ocean stroke length multiplier (falls back to outlineLength). */
  deepOceanWaveLength?: number;
  /** Independent deep-ocean stroke thickness in output pixels (falls back to outlineThickness). */
  deepOceanStrokeThickness?: number;
  /** Multiplier for the width of deep-ocean wave face and trough bands. */
  deepOceanWaveShadingScale?: number;
  /** Coverage multiplier for deep-ocean wave face and trough shading. */
  deepOceanWaveShadingIntensity?: number;
  /** Scale of the low-contrast flow-aligned turbulence across ocean water. */
  deepOceanTurbulenceScale?: number;
  /** Coverage multiplier for the flow-aligned ocean turbulence. */
  deepOceanTurbulenceIntensity?: number;
  /** @deprecated Deep ocean wave length follows outlineLength. */
  deepOceanLineLength?: number;
  /** User-configured wave epicenters. If provided and non-empty, replaces automatic Poisson seeds. */
  customEpicenters?: WaveEpicenter[];
  /** Draw generated cellular puddle contours inside the wetland biome. */
  wetlandPuddleContours?: boolean;
  /** Accepted cellular pockets per wetland region, 0 to 2. */
  wetlandPuddleDensity?: number;
  /** Smallest generated pocket radius, as a fraction of the pool grid cell. */
  wetlandPuddleSizeMin?: number;
  /** Largest generated pocket radius, as a fraction of the pool grid cell. */
  wetlandPuddleSizeMax?: number;
  /** Extra gap between pools and the ocean, as a fraction of the pool grid cell. */
  wetlandPuddleCoastDistance?: number;
  /** @deprecated Use flowThickness for the shared charcoal style. */
  wetlandPuddleThickness?: number;
  /** Deterministic seed used only for wetland pocket placement and shape. */
  wetlandPuddleSeed?: number;
  /** @deprecated Use flowOpacity for the shared charcoal style. */
  wetlandPuddleOpacity?: number;
}

export interface WaveEpicenter {
  id: string;
  /** Normalized X position [0..1] across the map */
  normX: number;
  /** Normalized Y position [0..1] across the map */
  normY: number;
  /** Strength multiplier (default: 1.0, range: 0.0 to 2.5) */
  strength: number;
  /** Optional custom wavelength in pixels (default: 22) */
  wavelength?: number;
  /** Optional custom max propagation radius in pixels */
  maxRadius?: number;
}

export interface WaterOverlay {
  width: number;
  height: number;
  waterAlpha: Uint8Array;
  waterTone: Uint8Array;
  /** Combined bank alpha retained for compatibility and diagnostics. */
  bankAlpha: Uint8Array;
  /** Ocean, river, lake, and wetland-water boundaries using Outline style. */
  outlineBankAlpha?: Uint8Array;
  flowAlpha: Uint8Array;
  flowTone: Uint8Array;
  crestAlpha?: Uint8Array;
  /** Ocean-only directional blue wave shading, clipped to the source ocean. */
  oceanWaveLightAlpha?: Uint8Array;
  oceanWaveShadowAlpha?: Uint8Array;
  /** Broken charcoal strokes and sparse dots aligned to offshore ridges. */
  oceanWaveInkAlpha?: Uint8Array;
  /** Subtle flow-aligned darkening texture across ocean water. */
  oceanTurbulenceAlpha?: Uint8Array;
  waveField?: Float32Array;
  distanceToCoast?: Float32Array;
  /** Longitudinal contour strokes following routed river splines. */
  riverContourAlpha?: Uint8Array;
  /** Unified broken charcoal contour inside all inland water (legacy field name). */
  wetlandPuddleContourAlpha?: Uint8Array;
  wetlandPuddleContourTone?: Uint8Array;
  /** Opaque top-priority wetland-pool fill footprint. */
  wetlandPuddlePriorityAlpha?: Uint8Array;
  /** @deprecated Wetland pools now use the shared waterAlpha/waterTone surface. */
  wetlandPuddleFillAlpha?: Uint8Array;
  wetlandPuddleFillTone?: Uint8Array;
  seedOrigins?: Array<{ x: number; y: number }>;
  oceanWaterAlpha?: Uint8Array;
  oceanWaterTone?: Uint8Array;
  oceanBankAlpha?: Uint8Array;
  oceanFlowAlpha?: Uint8Array;
  oceanFlowTone?: Uint8Array;
}

/**
 * DEM-derived water data that can be reused while only line styling changes.
 * The arrays are treated as immutable by the paint stage; mutable tone and ink
 * buffers remain owned by each WaterOverlay result.
 */
export interface WaterOverlayGeometry {
  width: number;
  height: number;
  raw: boolean;
  sourceOceanMask: Uint8Array;
  sourceOceanCoverage: Float32Array;
  sourceRiverMask: Uint8Array;
  rawWaterMask?: Uint8Array;
  filteredOceanMask: Uint8Array;
  sourceWaterMask: Uint8Array;
  oceanGeometrySource: Uint8Array | Float32Array;
  riverSplines: readonly RiverSpline[];
  riverFillCoverage: Uint8Array;
  riverWaterTone: Uint8Array;
  wetlandPuddleMask: Uint8Array;
  wetlandPuddleFillAlpha: Uint8Array;
  wetlandPuddleFillTone: Uint8Array;
  wetlandPuddleInteriorDistance: Float32Array;
  distanceToWetlandPool: Float32Array;
  riverContourAlpha: Uint8Array;
  /** Packed, immutable paths reused by paint-only water updates. */
  strokeGeometry?: WaterStrokeGeometry;
  /** Immutable coast guidance field; waveField is retained as a legacy alias. */
  coastWaveField?: Float32Array;
  waveField: Float32Array;
  waveFieldKey?: string;
  waterAlpha: Uint8Array;
  oceanCoverage: Uint8Array;
  cleanWaterMask: Uint8Array;
  bankWaterMask: Uint8Array;
  distanceToWater: Float32Array;
  distanceToLand: Float32Array;
  /** Signed distance (negative in water) to the smoothed shoreline; absent for raw water. */
  shoreSignedDistance?: Float32Array;
  oceanBankWaterMask: Uint8Array;
  oceanDistanceToWater: Float32Array;
  oceanDistanceToLand: Float32Array;
  hasOceanBank: boolean;
  oceanDetailMask: Uint8Array;
  /** Outer open sea (same test as the beach classification); waves stay inside it. */
  openOceanMask?: Uint8Array;
  distanceToCoast: Float32Array;
  effectiveDistanceToCoast: Float32Array;
}

/** Near-shore charcoal contour marks. Disabled for now; set to 1 to restore. */
const OCEAN_COASTAL_CONTOUR_OPACITY = 0;
/** Open-sea opening radius in pixels of the 2048px reference preview DEM. */
const OPEN_OCEAN_REFERENCE_RADIUS = 30;
const OPEN_OCEAN_REFERENCE_LONG_EDGE = 2048;

type WaterOverlayRenderMode = "geometry" | "paint";

function paintRawWaterOverlay(geometry: WaterOverlayGeometry): WaterOverlay {
  const { width, height } = geometry;
  const totalCells = width * height;
  const waterAlpha = new Uint8Array(totalCells);
  const waterTone = new Uint8Array(totalCells).fill(128);
  const oceanWaterAlpha = new Uint8Array(totalCells);
  const oceanWaterTone = new Uint8Array(totalCells).fill(128);
  const rawWaterMask = geometry.rawWaterMask ?? geometry.waterAlpha;
  for (let index = 0; index < totalCells; index++) {
    if (rawWaterMask[index] === 1) waterAlpha[index] = 255;
    if (geometry.sourceOceanMask[index] === 1) oceanWaterAlpha[index] = 255;
  }
  return {
    width,
    height,
    waterAlpha,
    waterTone,
    bankAlpha: new Uint8Array(totalCells),
    outlineBankAlpha: new Uint8Array(totalCells),
    flowAlpha: new Uint8Array(totalCells),
    flowTone: new Uint8Array(totalCells),
    crestAlpha: new Uint8Array(totalCells),
    oceanWaveLightAlpha: new Uint8Array(totalCells),
    oceanWaveShadowAlpha: new Uint8Array(totalCells),
    oceanWaveInkAlpha: new Uint8Array(totalCells),
    oceanTurbulenceAlpha: new Uint8Array(totalCells),
    waveField: new Float32Array(totalCells),
    distanceToCoast: geometry.distanceToCoast,
    riverContourAlpha: new Uint8Array(totalCells),
    wetlandPuddleContourAlpha: new Uint8Array(totalCells),
    wetlandPuddleContourTone: new Uint8Array(totalCells),
    wetlandPuddlePriorityAlpha: new Uint8Array(totalCells),
    wetlandPuddleFillAlpha: new Uint8Array(totalCells),
    wetlandPuddleFillTone: new Uint8Array(totalCells),
    seedOrigins: [],
    oceanWaterAlpha,
    oceanWaterTone,
    oceanBankAlpha: new Uint8Array(totalCells),
    oceanFlowAlpha: new Uint8Array(totalCells),
    oceanFlowTone: new Uint8Array(totalCells),
  };
}

export interface RiverPoint {
  x: number;
  y: number;
  radius: number;
  area: number;
  order: number;
  sourceIndex: number;
}

export interface RiverSpline {
  key: number;
  samples: RiverPoint[];
}

interface PathLocation {
  x: number;
  y: number;
  tangentX: number;
  tangentY: number;
  radius: number;
  order: number;
}

const D8_OFFSETS: readonly [number, number][] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function coastalWaveFieldKey(
  seed: number,
  outlineLength: number,
  oceanPixelScale: number | undefined,
  offsetX: number | undefined,
  offsetY: number | undefined,
): string {
  return JSON.stringify([
    seed,
    outlineLength,
    oceanPixelScale,
    offsetX,
    offsetY,
  ]);
}

function isOceanCell(dem: MountainDEMData, index: number): boolean {
  return dem.isOcean?.[index] === 1;
}

function routedAreaAt(dem: MountainDEMData, index: number): number {
  return (
    dem.rainfallWeightedAreaKm2?.[index] ?? dem.drainageAreaKm2[index] ?? 0
  );
}

function getReceiver(dem: MountainDEMData, index: number): number {
  const direction = dem.flowDirection[index];
  if (direction < 0 || direction >= D8_OFFSETS.length) return -1;
  const x = index % dem.width;
  const y = Math.floor(index / dem.width);
  const [dx, dy] = D8_OFFSETS[direction];
  const nx = x + dx;
  const ny = y + dy;
  return nx < 0 || nx >= dem.width || ny < 0 || ny >= dem.height
    ? -1
    : ny * dem.width + nx;
}

/**
 * Resolve the next routed centreline cell without letting a one-cell raster
 * offset terminate a perfectly valid river.  D8 receivers are still preferred
 * exactly; the short neighbourhood search is only used for explicit
 * centreline masks whose medial point can move to the next diagonal cell.
 */
function getRiverReceiver(
  dem: MountainDEMData,
  index: number,
  active: Uint8Array,
  allowCentrelineRecovery: boolean,
): number {
  const direct = getReceiver(dem, index);
  if (direct >= 0 && active[direct] === 1) return direct;
  if (!allowCentrelineRecovery || direct < 0) return direct;

  const direction = dem.flowDirection[index];
  if (direction < 0 || direction >= D8_OFFSETS.length) return direct;
  const [dx, dy] = D8_OFFSETS[direction];
  const receiverX = (index % dem.width) + dx;
  const receiverY = Math.floor(index / dem.width) + dy;
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let offsetY = -1; offsetY <= 1; offsetY++) {
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      const x = receiverX + offsetX;
      const y = receiverY + offsetY;
      if (x < 0 || x >= dem.width || y < 0 || y >= dem.height) continue;
      const candidate = y * dem.width + x;
      if (candidate === index || active[candidate] === 0) continue;

      const fromCurrentX = x - (index % dem.width);
      const fromCurrentY = y - Math.floor(index / dem.width);
      const downstreamProgress = fromCurrentX * dx + fromCurrentY * dy;
      if (downstreamProgress <= 0) continue;

      const distance = Math.hypot(offsetX, offsetY);
      const score = distance + Math.max(0, 1.5 - downstreamProgress) * 0.35;
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }
  return best >= 0 ? best : direct;
}

function hasEcologicalWaterBiome(dem: MountainDEMData): boolean {
  if (!dem.biomeType || dem.biomeType.length !== dem.width * dem.height)
    return false;
  for (const biome of dem.biomeType) if (biome === 6) return true;
  return false;
}

function buildWaterWidthGuide(
  dem: MountainDEMData,
  ecological: boolean,
): Uint8Array {
  const guide = new Uint8Array(dem.width * dem.height);
  for (let index = 0; index < guide.length; index++) {
    if (isOceanCell(dem, index)) {
      // Ocean is normally excluded from river-width measurement. A routed
      // mouth is the exception: it carries the land channel's stored width
      // through the flooded overlap so the river cannot pinch at the datum.
      if (dem.riverMouthMask?.[index] === 1) guide[index] = 1;
      continue;
    }
    if (
      dem.isRiverChannel[index] === 1 ||
      (ecological && dem.biomeType[index] === 6)
    )
      guide[index] = 1;
  }

  // Let the land-side width measurement see the receiving water at a mouth.
  // Ocean remains a separate water body, but excluding every ocean pixel from
  // this guide makes a channel lose half of its measured radius exactly where
  // it meets the sea. Only ocean pixels directly touching a routed channel are
  // included; this cannot turn the open ocean into a river guide.
  const landRiverGuide = guide.slice();
  for (let index = 0; index < guide.length; index++) {
    if (!isOceanCell(dem, index)) continue;
    const x = index % dem.width;
    const y = Math.floor(index / dem.width);
    let touchesRiver = false;
    for (const [dx, dy] of D8_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= dem.width || ny < 0 || ny >= dem.height) continue;
      const neighbor = ny * dem.width + nx;
      if (!isOceanCell(dem, neighbor) && landRiverGuide[neighbor] === 1) {
        touchesRiver = true;
        break;
      }
    }
    if (touchesRiver) guide[index] = 1;
  }
  return guide;
}

/** Approximate Euclidean distance from each water pixel to its nearest dry bank. */
function buildDistanceToBank(
  guide: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const distance = new Float32Array(guide.length);
  const diagonal = Math.SQRT2;
  for (let index = 0; index < guide.length; index++)
    distance[index] = guide[index] ? 1e6 : 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (distance[index] === 0) continue;
      let best = distance[index];
      if (x > 0) best = Math.min(best, distance[index - 1] + 1);
      if (y > 0) best = Math.min(best, distance[index - width] + 1);
      if (x > 0 && y > 0)
        best = Math.min(best, distance[index - width - 1] + diagonal);
      if (x + 1 < width && y > 0)
        best = Math.min(best, distance[index - width + 1] + diagonal);
      distance[index] = best;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const index = y * width + x;
      if (distance[index] === 0) continue;
      let best = distance[index];
      if (x + 1 < width) best = Math.min(best, distance[index + 1] + 1);
      if (y + 1 < height) best = Math.min(best, distance[index + width] + 1);
      if (x + 1 < width && y + 1 < height)
        best = Math.min(best, distance[index + width + 1] + diagonal);
      if (x > 0 && y + 1 < height)
        best = Math.min(best, distance[index + width - 1] + diagonal);
      distance[index] = best;
    }
  }
  return distance;
}

/**
 * Recenter the routed cell onto the ecological mask's local medial axis and
 * use nearest-bank distance as half-width. This cannot accidentally measure
 * along a bend or through a confluence as a cross-section can.
 */
function measureMedialWidth(
  guide: Uint8Array,
  distanceToBank: Float32Array,
  width: number,
  height: number,
  index: number,
  direction: number,
): { x: number; y: number; radius: number } {
  const x = index % width;
  const y = Math.floor(index / width);
  if (direction < 0 || direction >= D8_OFFSETS.length || guide[index] === 0) {
    return { x, y, radius: 0.5 };
  }
  const [flowX, flowY] = D8_OFFSETS[direction];
  const px = -flowY;
  const py = flowX;
  let bestX = x;
  let bestY = y;
  let bestDistance = distanceToBank[index];
  let bestScore = bestDistance;
  // Keep the medial correction local. A long search can cross a nearby
  // tributary at a confluence and pull the fill into a detached lobe.
  for (let offset = -8; offset <= 8; offset++) {
    const nx = x + px * offset;
    const ny = y + py * offset;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
    const candidate = ny * width + nx;
    if (guide[candidate] === 0) continue;
    const bankDistance = distanceToBank[candidate];
    const score = bankDistance - Math.abs(offset) * 0.015;
    if (score > bestScore) {
      bestScore = score;
      bestDistance = bankDistance;
      bestX = nx;
      bestY = ny;
    }
  }
  return {
    x: bestX,
    y: bestY,
    radius: Math.max(0.5, bestDistance - 0.5),
  };
}

export function suppressMicroKinks(points: RiverPoint[]): RiverPoint[] {
  if (points.length <= 3) return points.map((p) => ({ ...p }));
  const current = points.map((p) => ({ ...p }));
  const result: RiverPoint[] = [current[0]];

  for (let i = 1; i < current.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = current[i];
    const next = current[i + 1];

    const ux = curr.x - prev.x;
    const uy = curr.y - prev.y;
    const vx = next.x - curr.x;
    const vy = next.y - curr.y;

    const cross1 = ux * vy - uy * vx;
    const d1 = Math.hypot(ux, uy);
    const d2 = Math.hypot(vx, vy);

    if (i < current.length - 2) {
      const next2 = current[i + 2];
      const wx = next2.x - next.x;
      const wy = next2.y - next.y;
      const cross2 = vx * wy - vy * wx;
      const d3 = Math.hypot(wx, wy);

      if (cross1 * cross2 < -1e-4 && d1 + d2 + d3 < 5.0) {
        curr.x = prev.x * 0.6 + next2.x * 0.4;
        curr.y = prev.y * 0.6 + next2.y * 0.4;
      }
    }

    const dot = ux * vx + uy * vy;
    const mag = d1 * d2;
    if (mag > 1e-4 && dot / mag < -0.3 && d1 + d2 < 3.5) {
      curr.x = (prev.x + next.x) * 0.5;
      curr.y = (prev.y + next.y) * 0.5;
    }

    result.push(curr);
  }

  result.push(current[current.length - 1]);
  return result;
}

export function simplifyRiverRDP(
  points: RiverPoint[],
  epsilon: number,
): RiverPoint[] {
  if (points.length <= 2 || epsilon <= 0) return points.map((p) => ({ ...p }));

  const findMaxDistance = (
    start: number,
    end: number,
  ): { index: number; maxDist: number } => {
    const pStart = points[start];
    const pEnd = points[end];
    const dx = pEnd.x - pStart.x;
    const dy = pEnd.y - pStart.y;
    const lenSq = dx * dx + dy * dy;
    let maxDist = 0;
    let index = start;

    for (let i = start + 1; i < end; i++) {
      const p = points[i];
      let dist: number;
      if (lenSq < 1e-6) {
        dist = Math.hypot(p.x - pStart.x, p.y - pStart.y);
      } else {
        const num = Math.abs(
          dy * p.x - dx * p.y + pEnd.x * pStart.y - pEnd.y * pStart.x,
        );
        dist = num / Math.sqrt(lenSq);
      }
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    return { index, maxDist };
  };

  const rdpHelper = (
    start: number,
    end: number,
    output: RiverPoint[],
  ): void => {
    const { index, maxDist } = findMaxDistance(start, end);
    if (maxDist > epsilon && index !== start && index !== end) {
      rdpHelper(start, index, output);
      output.push({ ...points[index] });
      rdpHelper(index, end, output);
    }
  };

  const result: RiverPoint[] = [{ ...points[0] }];
  rdpHelper(0, points.length - 1, result);
  result.push({ ...points[points.length - 1] });
  return result;
}

export function mergeCloseRiverPoints(
  points: RiverPoint[],
  minDistance: number,
): RiverPoint[] {
  if (points.length <= 2 || minDistance <= 0)
    return points.map((p) => ({ ...p }));

  const result: RiverPoint[] = [{ ...points[0] }];
  const endPoint = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const last = result[result.length - 1];
    const curr = points[i];
    const distToLast = Math.hypot(curr.x - last.x, curr.y - last.y);
    const distToEnd = Math.hypot(curr.x - endPoint.x, curr.y - endPoint.y);

    if (distToLast >= minDistance && distToEnd >= minDistance * 0.5) {
      result.push({ ...curr });
    }
  }

  if (result.length > 1) {
    const last = result[result.length - 1];
    const dist = Math.hypot(endPoint.x - last.x, endPoint.y - last.y);
    if (dist < minDistance * 0.6 && result.length > 2) {
      result.pop();
    }
  }

  result.push({ ...endPoint });
  return result;
}

export function simplifyAndSmoothRiverPoints(
  points: RiverPoint[],
  requestedSmoothing: number,
): RiverPoint[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const smoothing = Math.max(0, Math.min(4, Math.round(requestedSmoothing)));

  if (smoothing === 0) {
    const deduped = mergeCloseRiverPoints(points, 0.8);
    return simplifyRiverRDP(deduped, 0.25);
  }

  // 1. Suppress micro-kinks (Z-curves / S-curves from D8 stair stepping and raster jitter)
  const unkinked = suppressMicroKinks(points);

  // 2. RDP simplification with epsilon scaling with smoothing level
  const epsilon = 0.35 + smoothing * 0.35;
  const rdpSimplified = simplifyRiverRDP(unkinked, epsilon);

  // 3. Merge points closer than minimum chord spacing
  const minSpacing = 1.3 + smoothing * 0.6;
  const merged = mergeCloseRiverPoints(rdpSimplified, minSpacing);

  // 4. Laplacian smoothing passes on simplified control points
  let current = merged.map((p) => ({ ...p }));
  const passes = smoothing;
  for (let pass = 0; pass < passes; pass++) {
    const next = current.map((p) => ({ ...p }));
    for (let index = 1; index < current.length - 1; index++) {
      next[index].x =
        current[index].x * 0.5 +
        (current[index - 1].x + current[index + 1].x) * 0.25;
      next[index].y =
        current[index].y * 0.5 +
        (current[index - 1].y + current[index + 1].y) * 0.25;
    }
    current = next;
  }
  return current;
}

export function smoothRiverPoints(
  points: RiverPoint[],
  requestedPasses: number,
): RiverPoint[] {
  return simplifyAndSmoothRiverPoints(points, requestedPasses);
}

function centripetalCatmullRom2D(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  tFraction: number,
): { x: number; y: number } {
  const d01 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const d23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);

  const t0 = 0;
  const t1 = t0 + Math.max(1e-4, Math.sqrt(d01));
  const t2 = t1 + Math.max(1e-4, Math.sqrt(d12));
  const t3 = t2 + Math.max(1e-4, Math.sqrt(d23));

  const t = t1 + (t2 - t1) * tFraction;

  const a1x = ((t1 - t) * p0.x + (t - t0) * p1.x) / (t1 - t0);
  const a1y = ((t1 - t) * p0.y + (t - t0) * p1.y) / (t1 - t0);

  const a2x = ((t2 - t) * p1.x + (t - t1) * p2.x) / (t2 - t1);
  const a2y = ((t2 - t) * p1.y + (t - t1) * p2.y) / (t2 - t1);

  const a3x = ((t3 - t) * p2.x + (t - t2) * p3.x) / (t3 - t2);
  const a3y = ((t3 - t) * p2.y + (t - t2) * p3.y) / (t3 - t2);

  const b1x = ((t2 - t) * a1x + (t - t0) * a2x) / (t2 - t0);
  const b1y = ((t2 - t) * a1y + (t - t0) * a2y) / (t2 - t0);

  const b2x = ((t3 - t) * a2x + (t - t1) * a3x) / (t3 - t1);
  const b2y = ((t3 - t) * a2y + (t - t1) * a3y) / (t3 - t1);

  const cx = ((t2 - t) * b1x + (t - t1) * b2x) / (t2 - t1);
  const cy = ((t2 - t) * b1y + (t - t1) * b2y) / (t2 - t1);

  return { x: cx, y: cy };
}

function sampleSpline(
  points: RiverPoint[],
  requestedSmoothing: number,
): RiverPoint[] {
  if (points.length <= 1) return points.map((point) => ({ ...point }));
  const smoothing = Math.max(0, Math.min(4, Math.round(requestedSmoothing)));
  const samples: RiverPoint[] = [{ ...points[0] }];
  for (let segment = 0; segment < points.length - 1; segment++) {
    const p0 = points[Math.max(0, segment - 1)];
    const p1 = points[segment];
    const p2 = points[segment + 1];
    const p3 = points[Math.min(points.length - 1, segment + 2)];
    const segDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const subdivisions =
      smoothing === 0
        ? Math.max(1, Math.round(segDist))
        : Math.max(
            2,
            Math.min(10, Math.round(segDist * (1 + smoothing * 0.4))),
          );
    for (let step = 1; step <= subdivisions; step++) {
      const t = step / subdivisions;
      const pt =
        smoothing === 0
          ? { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t }
          : centripetalCatmullRom2D(p0, p1, p2, p3, t);
      samples.push({
        x: pt.x,
        y: pt.y,
        radius: p1.radius + (p2.radius - p1.radius) * t,
        area: p1.area + (p2.area - p1.area) * t,
        order: Math.round(p1.order + (p2.order - p1.order) * t),
        sourceIndex: t < 0.5 ? p1.sourceIndex : p2.sourceIndex,
      });
    }
  }
  return samples;
}

/** Build a spline segment between every source, confluence, and outlet. */
function buildRiverSplines(
  dem: MountainDEMData,
  guide: Uint8Array,
  thresholdKm2: number,
  minimumRadius: number,
  smoothing: number,
): RiverSpline[] {
  const totalCells = dem.width * dem.height;
  const active = new Uint8Array(totalCells);
  const distanceToBank = buildDistanceToBank(guide, dem.width, dem.height);
  const hasExplicitCenterline = dem.riverCenterlineMask?.length === totalCells;
  const canRecoverCenterlineFromRunoff =
    dem.rainfallWeightedAreaKm2?.length === totalCells;
  // Resolve the routed-area and water arrays once. River topology revisits
  // these values in several passes; repeated optional-property lookups were
  // measurable on preview-sized DEMs and become costly for export tiles.
  const routedAreas = dem.rainfallWeightedAreaKm2 ?? dem.drainageAreaKm2;
  const oceanMask = dem.isOcean;
  const riverChannel = dem.isRiverChannel;
  const mouthMask = dem.riverMouthMask;
  const mouthAreas = dem.riverMouthAreaKm2;
  const riverAreaAt = (index: number): number => {
    if (oceanMask?.[index] === 1 && mouthMask?.[index] === 1) {
      return Math.max(
        thresholdKm2,
        mouthAreas?.[index] ?? thresholdKm2,
      );
    }
    return routedAreas?.[index] ?? 0;
  };
  // Reject laterally flooded bank cells unless their receiver continues into
  // an equal-or-larger routed channel. This retains real tributaries and trunks.
  for (let index = 0; index < totalCells; index++) {
    const ocean = oceanMask?.[index] === 1;
    const area = riverAreaAt(index);
    if (
      riverChannel[index] !== 1 ||
      area < thresholdKm2 ||
      (ocean && mouthMask?.[index] !== 1)
    )
      continue;
    if (hasExplicitCenterline) {
      if (dem.riverCenterlineMask[index] === 1) active[index] = 1;
      continue;
    }
    // Existing hot-reloaded DEM objects predate riverCenterlineMask, but the
    // original centerline condition was exactly this runoff threshold.
    if (canRecoverCenterlineFromRunoff) {
      active[index] = 1;
      continue;
    }
    const receiver = getReceiver(dem, index);
    if (receiver < 0) continue;
    if (
      oceanMask?.[receiver] === 1 ||
      (riverChannel[receiver] === 1 &&
        riverAreaAt(receiver) + 1e-6 >= area)
    )
      active[index] = 1;
  }
  // Keep a final non-ocean receiver even when it is a pit/outlet with no D8 edge.
  for (
    let index = 0;
    !hasExplicitCenterline &&
    !canRecoverCenterlineFromRunoff &&
    index < totalCells;
    index++
  ) {
    if (active[index] === 0) continue;
    const receiver = getReceiver(dem, index);
    if (
      receiver >= 0 &&
      oceanMask?.[receiver] !== 1 &&
      riverChannel[receiver] === 1 &&
      riverAreaAt(receiver) >= thresholdKm2
    )
      active[receiver] = 1;
  }

  const riverReceiver = new Int32Array(totalCells).fill(-1);
  for (let index = 0; index < totalCells; index++) {
    if (active[index] === 1) {
      riverReceiver[index] = getRiverReceiver(
        dem,
        index,
        active,
        hasExplicitCenterline,
      );
    }
  }

  const upstreamCount = new Uint16Array(totalCells);
  const firstUpstream = new Int32Array(totalCells).fill(-1);
  const primaryUpstream = new Int32Array(totalCells).fill(-1);
  for (let index = 0; index < totalCells; index++) {
    if (active[index] === 0) continue;
    const receiver = riverReceiver[index];
    if (receiver < 0 || active[receiver] === 0) continue;
    upstreamCount[receiver]++;
    if (firstUpstream[receiver] < 0) firstUpstream[receiver] = index;
    const currentPrimary = primaryUpstream[receiver];
    const area = riverAreaAt(index);
    if (
      currentPrimary < 0 ||
      area > riverAreaAt(currentPrimary) ||
      (area === riverAreaAt(currentPrimary) &&
        dem.strahlerOrder[index] > dem.strahlerOrder[currentPrimary])
    ) {
      primaryUpstream[receiver] = index;
    }
  }

  const centerX = new Float32Array(totalCells);
  const centerY = new Float32Array(totalCells);
  const radius = new Float32Array(totalCells);
  for (let index = 0; index < totalCells; index++) {
    if (active[index] === 0) continue;
    let direction = dem.flowDirection[index];
    if (
      (direction < 0 || direction >= D8_OFFSETS.length) &&
      firstUpstream[index] >= 0
    ) {
      direction = dem.flowDirection[firstUpstream[index]];
    }
    const measured = measureMedialWidth(
      guide,
      distanceToBank,
      dem.width,
      dem.height,
      index,
      direction,
    );
    const area = riverAreaAt(index);
    const widthCeiling = Math.max(2.5, 3 + Math.sqrt(Math.max(0, area)) * 1.2);
    const storedRadius = dem.riverChannelRadius?.[index] ?? 0;
    centerX[index] = measured.x;
    centerY[index] = measured.y;
    radius[index] = Math.max(
      minimumRadius,
      Math.min(widthCeiling, Math.max(measured.radius, storedRadius)),
    );
  }

  const sections: { key: number; points: RiverPoint[]; finalRadius: number }[] =
    [];
  for (let start = 0; start < totalCells; start++) {
    // Start one strand at every hydrological source. At a confluence only the
    // largest contributing upstream strand continues as the same spline;
    // smaller tributaries include the junction point and terminate there.
    if (active[start] === 0 || upstreamCount[start] !== 0) continue;
    const points: RiverPoint[] = [];
    let current = start;
    let guard = 0;
    while (current >= 0 && active[current] === 1 && guard++ <= totalCells) {
      points.push({
        x: centerX[current],
        y: centerY[current],
        radius: radius[current],
        area: riverAreaAt(current),
        order: Math.max(1, dem.strahlerOrder[current]),
        sourceIndex: current,
      });
      const receiver = riverReceiver[current];
      if (receiver < 0 || active[receiver] === 0) break;
      if (
        upstreamCount[receiver] > 1 &&
        primaryUpstream[receiver] !== current
      ) {
        points.push({
          x: centerX[receiver],
          y: centerY[receiver],
          radius: radius[receiver],
          area: riverAreaAt(receiver),
          order: Math.max(1, dem.strahlerOrder[receiver]),
          sourceIndex: receiver,
        });
        break;
      }
      current = receiver;
    }
    if (points.length === 0) continue;

    const tailSamples = Math.min(points.length, Math.max(3, 2 + smoothing * 2));
    let tailRadiusTotal = 0;
    for (
      let index = points.length - tailSamples;
      index < points.length;
      index++
    ) {
      tailRadiusTotal += points[index].radius;
    }
    sections.push({
      key: start,
      points: smoothRiverPoints(points, smoothing),
      finalRadius: Math.max(
        minimumRadius,
        tailRadiusTotal / Math.max(1, tailSamples),
      ),
    });
  }

  // Assign the longest/highest-discharge trunks first. Side streams can then
  // inherit an already established width wherever either endpoint collides
  // with one of those routed strands.
  const sectionLength = (section: { points: RiverPoint[] }) => {
    let length = 0;
    for (let index = 1; index < section.points.length; index++) {
      length += Math.hypot(
        section.points[index].x - section.points[index - 1].x,
        section.points[index].y - section.points[index - 1].y,
      );
    }
    return length;
  };
  sections.sort((a, b) => {
    const areaDifference =
      b.points[b.points.length - 1].area - a.points[a.points.length - 1].area;
    return Math.abs(areaDifference) > 1e-6
      ? areaDifference
      : sectionLength(b) - sectionLength(a);
  });

  const splines: RiverSpline[] = [];
  const assignedRadius = new Float32Array(totalCells);
  const collisionRadiusAt = (point: RiverPoint): number => {
    let existing = assignedRadius[point.sourceIndex];
    const centerX = Math.round(point.x);
    const centerY = Math.round(point.y);
    for (let offsetY = -1; offsetY <= 1; offsetY++) {
      const y = centerY + offsetY;
      if (y < 0 || y >= dem.height) continue;
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        const x = centerX + offsetX;
        if (x < 0 || x >= dem.width) continue;
        existing = Math.max(existing, assignedRadius[y * dem.width + x]);
      }
    }
    return existing;
  };
  const registerRadius = (point: RiverPoint): void => {
    assignedRadius[point.sourceIndex] = Math.max(
      assignedRadius[point.sourceIndex],
      point.radius,
    );
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    if (x >= 0 && x < dem.width && y >= 0 && y < dem.height) {
      const index = y * dem.width + x;
      assignedRadius[index] = Math.max(assignedRadius[index], point.radius);
    }
  };

  for (const section of sections) {
    const points = section.points.map((point) => ({ ...point }));
    const cumulative = new Float32Array(points.length);
    for (let index = 1; index < points.length; index++) {
      cumulative[index] =
        cumulative[index - 1] +
        Math.hypot(
          points[index].x - points[index - 1].x,
          points[index].y - points[index - 1].y,
        );
    }
    const sectionLength = cumulative[cumulative.length - 1];
    const inheritedStartRadius = collisionRadiusAt(points[0]);
    const inheritedEndRadius = collisionRadiusAt(points[points.length - 1]);
    const startRadius =
      inheritedStartRadius > 0
        ? Math.max(inheritedStartRadius, points[0].radius)
        : Math.max(minimumRadius, points[0].radius);
    const finalRadius =
      inheritedEndRadius > 0
        ? Math.max(inheritedEndRadius, section.finalRadius)
        : Math.max(startRadius, section.finalRadius);
    for (let index = 0; index < points.length; index++) {
      const t = sectionLength > 1e-6 ? cumulative[index] / sectionLength : 0;
      const profileRadius = startRadius + (finalRadius - startRadius) * t;
      // Preserve measured channel width while gently enforcing downstream
      // growth. Flattening every section to a minimum-to-tail ramp makes
      // otherwise wide straight rivers pinch near their sources.
      points[index].radius = Math.max(points[index].radius, profileRadius);
    }
    const samples = sampleSpline(points, smoothing);
    for (const point of points) registerRadius(point);
    for (const sample of samples) registerRadius(sample);
    splines.push({ key: section.key, samples });
  }
  return splines;
}

/**
 * Builds routed river geometry for a bounded global DEM. Tiled export uses
 * this once and then scales the resulting vectors into each output tile,
 * preventing a river from changing shape at tile boundaries.
 */
export function buildRiverSplinesForExport(
  dem: MountainDEMData,
  options: {
    riverThresholdKm2?: number;
    outlineThickness?: number;
    fillSmoothing?: number;
    useEcologicalBiomeWater?: boolean;
  } = {},
): RiverSpline[] {
  const threshold = Math.max(0.001, options.riverThresholdKm2 ?? 0.8);
  const outlineThickness = Math.max(0, options.outlineThickness ?? 1);
  const ecological =
    options.useEcologicalBiomeWater !== false && hasEcologicalWaterBiome(dem);
  const guide = buildWaterWidthGuide(dem, ecological);
  return buildRiverSplines(
    dem,
    guide,
    threshold,
    Math.max(0.5, outlineThickness * 0.5),
    Math.max(0, Math.min(4, Math.round(options.fillSmoothing ?? 1))),
  );
}

/**
 * Where one river is traced as several strands, their rounded ends meet with
 * a one- or two-pixel waist that reads as a break once the outline follows the
 * fill. A 3x3 grey-scale closing (max then min) fills those notches without
 * moving straight edges, and is limited to raster river cells so it can only
 * add water where the source already has river.
 */
function closeRiverFillNotches(
  coverage: Uint8Array,
  tone: Uint8Array,
  riverMask: Uint8Array,
  width: number,
  height: number,
): void {
  const dilated = new Uint8Array(coverage.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const sy = Math.max(0, Math.min(height - 1, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const sx = Math.max(0, Math.min(width - 1, x + dx));
          value = Math.max(value, coverage[sy * width + sx]);
        }
      }
      dilated[y * width + x] = value;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (riverMask[index] !== 1) continue;
      let value = 255;
      for (let dy = -1; dy <= 1; dy++) {
        const sy = Math.max(0, Math.min(height - 1, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const sx = Math.max(0, Math.min(width - 1, x + dx));
          value = Math.min(value, dilated[sy * width + sx]);
        }
      }
      if (value <= coverage[index]) continue;
      coverage[index] = value;
      if (tone[index] === 0) tone[index] = 125;
    }
  }
}

/** Rasterize an antialiased variable-width segment. */
function paintCoverageSegment(
  coverage: Uint8Array,
  tone: Uint8Array | null,
  dem: MountainDEMData,
  x0: number,
  y0: number,
  radius0: number,
  tone0: number,
  x1: number,
  y1: number,
  radius1: number,
  tone1: number,
): void {
  const maxRadius = Math.max(radius0, radius1);
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - maxRadius - 1));
  const maxX = Math.min(
    dem.width - 1,
    Math.ceil(Math.max(x0, x1) + maxRadius + 1),
  );
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - maxRadius - 1));
  const maxY = Math.min(
    dem.height - 1,
    Math.ceil(Math.max(y0, y1) + maxRadius + 1),
  );
  const sx = x1 - x0;
  const sy = y1 - y0;
  const lengthSquared = sx * sx + sy * sy;
  const hasDirection = lengthSquared > 1e-6;
  // Four sub-pixel taps remove the hard diagonal staircase produced when a
  // one-pixel raster cell is tested only at its centre.  The spline remains
  // the source of truth; this only improves its coverage at the final pixel
  // boundary.
  for (let y = minY; y <= maxY; y++) {
    const rowOffset = y * dem.width;
    for (let x = minX; x <= maxX; x++) {
      const index = rowOffset + x;
      let coverageSum = 0;
      let toneT = 0;
      // Keep the original row-major subpixel order, but inline the four fixed
      // taps. This removes two iterator allocations and four offset reads per
      // output cell in the water geometry hotspot.
      const sampleX0 = x - 0.25;
      const sampleX1 = x + 0.25;
      const sampleY0 = y - 0.25;
      const sampleY1 = y + 0.25;

      let t = hasDirection
        ? clamp01(((sampleX0 - x0) * sx + (sampleY0 - y0) * sy) / lengthSquared)
        : 0;
      let cx = x0 + sx * t;
      let cy = y0 + sy * t;
      let radius = radius0 + (radius1 - radius0) * t;
      const dx00 = sampleX0 - cx, dy00 = sampleY0 - cy;
      coverageSum += clamp01(radius - Math.sqrt(dx00 * dx00 + dy00 * dy00) + 0.5);
      toneT += t;

      t = hasDirection
        ? clamp01(((sampleX1 - x0) * sx + (sampleY0 - y0) * sy) / lengthSquared)
        : 0;
      cx = x0 + sx * t;
      cy = y0 + sy * t;
      radius = radius0 + (radius1 - radius0) * t;
      const dx10 = sampleX1 - cx, dy10 = sampleY0 - cy;
      coverageSum += clamp01(radius - Math.sqrt(dx10 * dx10 + dy10 * dy10) + 0.5);
      toneT += t;

      t = hasDirection
        ? clamp01(((sampleX0 - x0) * sx + (sampleY1 - y0) * sy) / lengthSquared)
        : 0;
      cx = x0 + sx * t;
      cy = y0 + sy * t;
      radius = radius0 + (radius1 - radius0) * t;
      const dx01 = sampleX0 - cx, dy01 = sampleY1 - cy;
      coverageSum += clamp01(radius - Math.sqrt(dx01 * dx01 + dy01 * dy01) + 0.5);
      toneT += t;

      t = hasDirection
        ? clamp01(((sampleX1 - x0) * sx + (sampleY1 - y0) * sy) / lengthSquared)
        : 0;
      cx = x0 + sx * t;
      cy = y0 + sy * t;
      radius = radius0 + (radius1 - radius0) * t;
      const dx11 = sampleX1 - cx, dy11 = sampleY1 - cy;
      coverageSum += clamp01(radius - Math.sqrt(dx11 * dx11 + dy11 * dy11) + 0.5);
      toneT += t;
      const value = Math.round(coverageSum * 0.25 * 255);
      if (value <= coverage[index]) continue;
      coverage[index] = value;
      if (tone)
        tone[index] = Math.round(tone0 + (tone1 - tone0) * (toneT * 0.25));
    }
  }
}

/** Rasterize one flow-aligned river contour stroke, clipped to river fill. */
function paintRiverContourSegment(
  alpha: Uint8Array,
  waterCoverage: Uint8Array,
  dem: MountainDEMData,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  lineRadius: number,
): void {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - lineRadius - 1));
  const maxX = Math.min(
    dem.width - 1,
    Math.ceil(Math.max(x0, x1) + lineRadius + 1),
  );
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - lineRadius - 1));
  const maxY = Math.min(
    dem.height - 1,
    Math.ceil(Math.max(y0, y1) + lineRadius + 1),
  );
  const sx = x1 - x0;
  const sy = y1 - y0;
  const lengthSquared = sx * sx + sy * sy;
  const hasDirection = lengthSquared > 1e-6;
  for (let y = minY; y <= maxY; y++) {
    const rowOffset = y * dem.width;
    for (let x = minX; x <= maxX; x++) {
      const index = rowOffset + x;
      if (waterCoverage[index] <= 28) continue;
      let coverageSum = 0;
      const sampleX0 = x - 0.25;
      const sampleX1 = x + 0.25;
      const sampleY0 = y - 0.25;
      const sampleY1 = y + 0.25;

      let t = hasDirection
        ? clamp01(((sampleX0 - x0) * sx + (sampleY0 - y0) * sy) / lengthSquared)
        : 0;
      let cx = x0 + sx * t;
      let cy = y0 + sy * t;
      const dx00 = sampleX0 - cx, dy00 = sampleY0 - cy;
      coverageSum += clamp01(lineRadius - Math.sqrt(dx00 * dx00 + dy00 * dy00) + 0.5);

      t = hasDirection
        ? clamp01(((sampleX1 - x0) * sx + (sampleY0 - y0) * sy) / lengthSquared)
        : 0;
      cx = x0 + sx * t;
      cy = y0 + sy * t;
      const dx10 = sampleX1 - cx, dy10 = sampleY0 - cy;
      coverageSum += clamp01(lineRadius - Math.sqrt(dx10 * dx10 + dy10 * dy10) + 0.5);

      t = hasDirection
        ? clamp01(((sampleX0 - x0) * sx + (sampleY1 - y0) * sy) / lengthSquared)
        : 0;
      cx = x0 + sx * t;
      cy = y0 + sy * t;
      const dx01 = sampleX0 - cx, dy01 = sampleY1 - cy;
      coverageSum += clamp01(lineRadius - Math.sqrt(dx01 * dx01 + dy01 * dy01) + 0.5);

      t = hasDirection
        ? clamp01(((sampleX1 - x0) * sx + (sampleY1 - y0) * sy) / lengthSquared)
        : 0;
      cx = x0 + sx * t;
      cy = y0 + sy * t;
      const dx11 = sampleX1 - cx, dy11 = sampleY1 - cy;
      coverageSum += clamp01(lineRadius - Math.sqrt(dx11 * dx11 + dy11 * dy11) + 0.5);
      alpha[index] = Math.max(
        alpha[index],
        Math.round(coverageSum * 0.25 * 255),
      );
    }
  }
}

function buildRiverStrokeGeometry(
  width: number,
  height: number,
  splines: readonly RiverSpline[],
): WaterStrokeGeometry {
  return buildWaterStrokeGeometry(
    width,
    height,
    splines.map((spline) => ({
      id: spline.key,
      family: "river" as const,
      points: spline.samples,
    })),
  );
}

/** Create contour strokes that run along the river instead of across it. */
function buildRiverContourAlpha(
  splines: readonly RiverSpline[],
  waterCoverage: Uint8Array,
  dem: MountainDEMData,
  pixelScale = 1,
  strokeGeometry?: WaterStrokeGeometry,
): Uint8Array {
  const alpha = new Uint8Array(waterCoverage.length);
  const markScale = Math.max(0.25, pixelScale);

  if (strokeGeometry) {
    for (let pathIndex = 0; pathIndex < strokeGeometry.stableIds.length; pathIndex++) {
      if (strokeGeometry.families[pathIndex] !== 1) continue;
      const startOffset = strokeGeometry.pathOffsets[pathIndex];
      const endOffset = strokeGeometry.pathOffsets[pathIndex + 1];
      for (let pointOffset = startOffset; pointOffset + 1 < endOffset; pointOffset++) {
        const startRadius = strokeGeometry.pointRadius[pointOffset];
        const endRadius = strokeGeometry.pointRadius[pointOffset + 1];
        const lineRadius = Math.max(
          0.16 * markScale,
          Math.min(
            0.34 * markScale,
            (0.2 + Math.min(startRadius, endRadius) * 0.025) * markScale,
          ),
        );
        paintRiverContourSegment(
          alpha,
          waterCoverage,
          dem,
          strokeGeometry.pointX[pointOffset],
          strokeGeometry.pointY[pointOffset],
          strokeGeometry.pointX[pointOffset + 1],
          strokeGeometry.pointY[pointOffset + 1],
          lineRadius,
        );
      }
    }
    return alpha;
  }

  for (const spline of splines) {
    if (spline.samples.length < 2) continue;
    for (let segment = 0; segment < spline.samples.length - 1; segment++) {
      const start = spline.samples[segment];
      const end = spline.samples[segment + 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-4) continue;
      const lineRadius = Math.max(
        0.16 * markScale,
        Math.min(
          0.34 * markScale,
          (0.2 + Math.min(start.radius, end.radius) * 0.025) * markScale,
        ),
      );

      // Use one centered longitudinal contour. The bank outline already
      // describes both river edges; two offset interior strokes make narrow
      // rivers read as a pair of rails rather than one watercourse.
      paintRiverContourSegment(
        alpha,
        waterCoverage,
        dem,
        start.x,
        start.y,
        end.x,
        end.y,
        lineRadius,
      );
    }
  }
  return alpha;
}

/**
 * Supplies a softly antialiased fallback for channel cells that are not part
 * of a traceable routed strand (for example an isolated ecological water
 * patch). It is intentionally local: it cannot invent long-distance river
 * branches or redirect flow.
 */
function buildSoftMaskCoverage(
  mask: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const coverage = new Uint8Array(mask.length);
  const weights = [1, 2, 1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let weighted = 0;
      let weightTotal = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const sampleY = Math.max(0, Math.min(height - 1, y + offsetY));
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const sampleX = Math.max(0, Math.min(width - 1, x + offsetX));
          const weight = weights[offsetX + 1] * weights[offsetY + 1];
          weighted += mask[sampleY * width + sampleX] * weight;
          weightTotal += weight;
        }
      }
      coverage[y * width + x] = Math.round((weighted / weightTotal) * 255);
    }
  }
  return coverage;
}

/**
 * Smooth coverage used by every water body. Unlike a binary majority filter,
 * this keeps the source pixels and their partial edge coverage, so a river
 * mouth can meet an ocean without a one-pixel seam or a square step.
 */
function buildSmoothedWaterCoverage(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  passes: number,
): Uint8Array {
  let source = new Float32Array(mask.length);
  for (let index = 0; index < mask.length; index++) source[index] = mask[index];

  for (let pass = 0; pass < Math.max(1, passes); pass++) {
    const result = new Float32Array(mask.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let offsetY = -1; offsetY <= 1; offsetY++) {
          const sampleY = Math.max(0, Math.min(height - 1, y + offsetY));
          for (let offsetX = -1; offsetX <= 1; offsetX++) {
            const sampleX = Math.max(0, Math.min(width - 1, x + offsetX));
            const weight = (offsetX === 0 ? 2 : 1) * (offsetY === 0 ? 2 : 1);
            sum += source[sampleY * width + sampleX] * weight;
          }
        }
        result[y * width + x] = sum / 16;
      }
    }
    source = result;
  }

  const coverage = new Uint8Array(mask.length);
  for (let index = 0; index < coverage.length; index++) {
    coverage[index] = Math.round(clamp01(source[index]) * 255);
  }
  return coverage;
}

/**
 * Signed shoreline distance in pixels (negative inside water) that follows
 * the antialiased 50% isoline of `coverage` instead of binary pixel edges.
 * Far from the shore the binary EDT is kept; within the coverage ramp the
 * linear estimate (0.5 - a) / |grad a| gives sub-pixel placement, so rings
 * derived from it no longer stair-step.
 */
export function buildSubpixelShoreDistance(
  coverage: Uint8Array,
  waterMask: Uint8Array,
  distanceToWater: Float32Array,
  distanceToLand: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const signed = new Float32Array(coverage.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const binary = waterMask[index] === 1
        ? -(distanceToLand[index] - 0.5)
        : distanceToWater[index] - 0.5;
      signed[index] = binary;
      if (Math.abs(binary) > 2.5) continue;
      const left = coverage[y * width + Math.max(0, x - 1)];
      const right = coverage[y * width + Math.min(width - 1, x + 1)];
      const up = coverage[Math.max(0, y - 1) * width + x];
      const down = coverage[Math.min(height - 1, y + 1) * width + x];
      const gx = (right - left) / 510;
      const gy = (down - up) / 510;
      const gradient = Math.hypot(gx, gy);
      if (gradient < 0.08) continue;
      const estimate = (0.5 - coverage[index] / 255) / gradient;
      if (Math.abs(estimate) < 2) signed[index] = estimate;
    }
  }
  return smoothFieldSeparable(signed, width, height, 1, 1);
}

/** Marks pixels the smooth shoreline distance did not reach. */
const SHORE_UNREACHED = 1e6;

interface ShorePolyline {
  xs: Float32Array;
  ys: Float32Array;
  closed: boolean;
}

/**
 * Marching squares at the 50% level of a coverage field. Segments are linked
 * through the grid edges they cross, with water on the left of each one, so
 * every shoreline comes out as an oriented polyline. Shorelines that run off
 * the grid stay open and end on its border.
 */
function traceShorelines(
  coverage: Uint8Array,
  width: number,
  height: number,
): ShorePolyline[] {
  const total = width * height;
  const segFrom: number[] = [];
  const segTo: number[] = [];
  const inside = (index: number): boolean => coverage[index] >= 128;
  const crossings = [0, 0, 0, 0];
  const enters = [false, false, false, false];
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = y * width + x;
      const b = a + 1;
      const d = a + width;
      const c = d + 1;
      const ia = inside(a);
      const ib = inside(b);
      const ic = inside(c);
      const id = inside(d);
      if (ia === ib && ib === ic && ic === id) continue;
      // Clockwise around the cell: top, right, bottom, left. A crossing
      // "enters" water when the corner it leads to is water.
      let count = 0;
      if (ia !== ib) { crossings[count] = a; enters[count++] = ib; }
      if (ib !== ic) { crossings[count] = total + b; enters[count++] = ic; }
      if (ic !== id) { crossings[count] = d; enters[count++] = id; }
      if (id !== ia) { crossings[count] = total + a; enters[count++] = ia; }
      if (count === 2) {
        const enter = enters[0] ? 0 : 1;
        segFrom.push(crossings[enter]);
        segTo.push(crossings[1 - enter]);
      } else {
        // Saddle: water joins through the middle when the average is water.
        const connected =
          coverage[a] + coverage[b] + coverage[c] + coverage[d] >= 510;
        for (let k = 0; k < 4; k++) {
          if (!enters[k]) continue;
          const partner = connected ? (k + 3) & 3 : (k + 1) & 3;
          segFrom.push(crossings[k]);
          segTo.push(crossings[partner]);
        }
      }
    }
  }
  if (segFrom.length === 0) return [];

  const outgoing = new Map<number, number>();
  const hasIncoming = new Set<number>();
  for (let s = 0; s < segFrom.length; s++) {
    outgoing.set(segFrom[s], s);
    hasIncoming.add(segTo[s]);
  }
  const position = (edge: number, out: number[]): void => {
    if (edge < total) {
      const x = edge % width;
      const y = (edge - x) / width;
      const lo = coverage[edge];
      out.push(x + (127.5 - lo) / (coverage[edge + 1] - lo), y);
    } else {
      const index = edge - total;
      const x = index % width;
      const y = (index - x) / width;
      const lo = coverage[index];
      out.push(x, y + (127.5 - lo) / (coverage[index + width] - lo));
    }
  };

  const polylines: ShorePolyline[] = [];
  const used = new Uint8Array(segFrom.length);
  const emit = (points: number[], closed: boolean): void => {
    const count = points.length >> 1;
    const xs = new Float32Array(count);
    const ys = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      xs[i] = points[i * 2];
      ys[i] = points[i * 2 + 1];
    }
    polylines.push({ xs, ys, closed });
  };
  // Open shorelines start where nothing leads into the first crossing.
  for (let s = 0; s < segFrom.length; s++) {
    if (used[s] || hasIncoming.has(segFrom[s])) continue;
    const points: number[] = [];
    position(segFrom[s], points);
    let current: number | undefined = s;
    while (current !== undefined && !used[current]) {
      used[current] = 1;
      position(segTo[current], points);
      current = outgoing.get(segTo[current]);
    }
    emit(points, false);
  }
  for (let s = 0; s < segFrom.length; s++) {
    if (used[s]) continue;
    const points: number[] = [];
    let current = s;
    do {
      used[current] = 1;
      position(segFrom[current], points);
      current = outgoing.get(segTo[current])!;
    } while (!used[current]);
    emit(points, true);
  }
  return polylines;
}

/**
 * Laplacian smoothing of the shoreline vertices; `passes` half-steps act like
 * a Gaussian of sigma = sqrt(passes / 2) pixels along the curve. Taubin's
 * lambda/mu filter avoids the shrinkage but leaves anything wider than ~13
 * vertices alone, which is exactly the width of a stair step. Open shorelines
 * keep their end points on the grid border.
 */
function smoothShorelines(polylines: ShorePolyline[], passes: number): void {
  for (const line of polylines) {
    const count = line.xs.length;
    // Tiny shorelines are below the grid's resolution; smoothing them would
    // only erase them.
    if (count < 8) continue;
    let xs = line.xs;
    let ys = line.ys;
    let nextXs: Float32Array = new Float32Array(count);
    let nextYs: Float32Array = new Float32Array(count);
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < count; i++) {
        if (!line.closed && (i === 0 || i === count - 1)) {
          nextXs[i] = xs[i];
          nextYs[i] = ys[i];
          continue;
        }
        const prev = i === 0 ? count - 1 : i - 1;
        const next = i === count - 1 ? 0 : i + 1;
        nextXs[i] = (xs[prev] + xs[next]) * 0.25 + xs[i] * 0.5;
        nextYs[i] = (ys[prev] + ys[next]) * 0.25 + ys[i] * 0.5;
      }
      const swapX = xs;
      xs = nextXs;
      nextXs = swapX;
      const swapY = ys;
      ys = nextYs;
      nextYs = swapY;
    }
    line.xs = xs;
    line.ys = ys;
  }
}

/**
 * Signed distance (negative in water) to the smoothed shorelines within
 * `band` pixels of them; every other pixel is `SHORE_UNREACHED`. The sign
 * comes from the water-side normal of the nearest segment, or the averaged
 * normal of the nearest vertex, so it needs no inside/outside fill and works
 * for shorelines that leave the grid.
 */
function shorelineBandDistance(
  polylines: ShorePolyline[],
  width: number,
  height: number,
  band: number,
): Float32Array {
  const signed = new Float32Array(width * height).fill(SHORE_UNREACHED);
  for (const { xs, ys, closed } of polylines) {
    const count = xs.length;
    const segments = closed ? count : count - 1;
    const segNx = new Float32Array(segments);
    const segNy = new Float32Array(segments);
    for (let i = 0; i < segments; i++) {
      const j = i + 1 === count ? 0 : i + 1;
      const dx = xs[j] - xs[i];
      const dy = ys[j] - ys[i];
      const length = Math.hypot(dx, dy);
      if (length > 1e-6) {
        segNx[i] = dy / length;
        segNy[i] = -dx / length;
      }
    }
    const vertexNormal = (i: number): [number, number] => {
      let nx = 0;
      let ny = 0;
      const before = i === 0 ? (closed ? segments - 1 : -1) : i - 1;
      if (before >= 0) { nx += segNx[before]; ny += segNy[before]; }
      if (i < segments) { nx += segNx[i]; ny += segNy[i]; }
      const length = Math.hypot(nx, ny);
      return length > 1e-6 ? [nx / length, ny / length] : [0, 0];
    };
    for (let i = 0; i < segments; i++) {
      const j = i + 1 === count ? 0 : i + 1;
      const ax = xs[i];
      const ay = ys[i];
      const abx = xs[j] - ax;
      const aby = ys[j] - ay;
      const lengthSq = abx * abx + aby * aby;
      const minX = Math.max(0, Math.floor(Math.min(ax, xs[j]) - band));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, xs[j]) + band));
      const minY = Math.max(0, Math.floor(Math.min(ay, ys[j]) - band));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, ys[j]) + band));
      let startNormal: [number, number] | null = null;
      let endNormal: [number, number] | null = null;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const t = lengthSq > 1e-12
            ? Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / lengthSq))
            : 0;
          const qx = ax + abx * t;
          const qy = ay + aby * t;
          const distance = Math.hypot(x - qx, y - qy);
          const index = y * width + x;
          if (distance >= band || distance >= Math.abs(signed[index])) continue;
          let nx = segNx[i];
          let ny = segNy[i];
          if (t <= 0) {
            startNormal ??= vertexNormal(i);
            [nx, ny] = startNormal;
          } else if (t >= 1) {
            endNormal ??= vertexNormal(j);
            [nx, ny] = endNormal;
          }
          signed[index] = (x - qx) * nx + (y - qy) * ny > 0 ? -distance : distance;
        }
      }
    }
  }
  return signed;
}

/**
 * Traces the 50% shoreline of `coverage`, smooths it over about one source
 * cell (`cellPx` output pixels), and returns the signed distance to it within
 * `band` pixels (other pixels hold `SHORE_UNREACHED`), or null when the field
 * has no shoreline. The raster threshold only picks where the shoreline is;
 * its stair steps never reach the result.
 */
export function buildSmoothShoreDistance(
  coverage: Uint8Array,
  width: number,
  height: number,
  cellPx: number,
  band: number,
): Float32Array | null {
  const polylines = traceShorelines(coverage, width, height);
  if (polylines.length === 0) return null;
  // Smooth over about one and a half source cells, and never under 2 px.
  const sigma = Math.max(2, 1.5 * Math.max(1, cellPx));
  smoothShorelines(polylines, Math.min(300, Math.ceil(2 * sigma * sigma)));
  return shorelineBandDistance(polylines, width, height, band);
}

function cumulativeLengths(samples: RiverPoint[]): Float32Array {
  const cumulative = new Float32Array(samples.length);
  for (let index = 1; index < samples.length; index++) {
    cumulative[index] =
      cumulative[index - 1] +
      Math.hypot(
        samples[index].x - samples[index - 1].x,
        samples[index].y - samples[index - 1].y,
      );
  }
  return cumulative;
}

function locateOnSpline(
  samples: RiverPoint[],
  cumulative: Float32Array,
  distance: number,
): PathLocation {
  const target = Math.max(
    0,
    Math.min(cumulative[cumulative.length - 1], distance),
  );
  let low = 0;
  let high = cumulative.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (cumulative[middle] < target) low = middle;
    else high = middle;
  }
  const start = samples[low];
  const end = samples[Math.min(samples.length - 1, low + 1)];
  const length = Math.max(
    1e-6,
    cumulative[Math.min(cumulative.length - 1, low + 1)] - cumulative[low],
  );
  const t = clamp01((target - cumulative[low]) / length);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const tangentLength = Math.hypot(dx, dy) || 1;
  return {
    x: start.x + dx * t,
    y: start.y + dy * t,
    tangentX: dx / tangentLength,
    tangentY: dy / tangentLength,
    radius: start.radius + (end.radius - start.radius) * t,
    order: Math.round(start.order + (end.order - start.order) * t),
  };
}

function paintInkDisk(
  alpha: Uint8Array,
  tone: Uint8Array,
  waterClip: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  toneValue: number,
  dotSeed: number = 0,
): void {
  const rBound = Math.ceil(radius * 2.2 + 2.5);
  const maximumRadius = radius * 1.175;
  const maximumDistanceSquared = (maximumRadius + 0.65) * (maximumRadius + 0.65);
  for (
    let y = Math.max(0, Math.floor(cy - rBound));
    y <= Math.min(height - 1, Math.ceil(cy + rBound));
    y++
  ) {
    const rowOffset = y * width;
    for (
      let x = Math.max(0, Math.floor(cx - rBound));
      x <= Math.min(width - 1, Math.ceil(cx + rBound));
      x++
    ) {
      const index = rowOffset + x;
      if (waterClip[index] === 0) continue;
      const dx = x - cx;
      const dy = y - cy;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > maximumDistanceSquared) continue;
      const tooth = (hash01(index * 13 + dotSeed, 541) - 0.5) * 0.35;
      const localRadius = radius * (1.0 + tooth);
      if (distanceSquared >= (localRadius + 0.65) * (localRadius + 0.65)) continue;
      const rawCoverage = localRadius > 0.35 && distanceSquared <= (localRadius - 0.35) * (localRadius - 0.35)
        ? 1
        : clamp01(localRadius - Math.sqrt(distanceSquared) + 0.65);
      const coverage = rawCoverage *
        (0.85 + 0.15 * hash01(index, dotSeed + 991));
      alpha[index] = Math.max(alpha[index], Math.round(coverage * 255));
      if (coverage > 0.15) tone[index] = Math.max(tone[index], toneValue);
    }
  }
}

function paintInkSegment(
  alpha: Uint8Array,
  tone: Uint8Array,
  waterClip: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  toneValue: number,
  markSeed: number,
  smoothing: number,
  strokeT0: number = 0,
  strokeT1: number = 1,
  taperStart: boolean = true,
  taperEnd: boolean = true,
): void {
  const sx = x1 - x0;
  const sy = y1 - y0;
  const lengthSquared = sx * sx + sy * sy || 1;
  const invLengthSquared = 1 / lengthSquared;
  const variation = 0.6 / (1 + smoothing * 0.8);
  const searchRadius = Math.max(3.0, radius * 2.6 + 2.5);
  const maxLocalRadius = radius * (1 + variation * 0.65 + 0.0825);
  const maxDistanceSquared = (maxLocalRadius + 0.65) * (maxLocalRadius + 0.65);

  for (
    let y = Math.max(0, Math.floor(Math.min(y0, y1) - searchRadius));
    y <= Math.min(height - 1, Math.ceil(Math.max(y0, y1) + searchRadius));
    y++
  ) {
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - searchRadius));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + searchRadius));
    let dot = (minX - x0) * sx + (y - y0) * sy;
    for (
      let x = minX;
      x <= maxX;
      x++
    ) {
      const currentDot = dot;
      dot += sx;
      const index = y * width + x;
      if (waterClip[index] === 0) continue;

      const t = clamp01(currentDot * invLengthSquared);
      const cx = x0 + sx * t;
      const cy = y0 + sy * t;
      const distanceX = x - cx;
      const distanceY = y - cy;
      const distanceSquared = distanceX * distanceX + distanceY * distanceY;
      if (distanceSquared > maxDistanceSquared) continue;

      // 1. Brush-like pressure follows the complete mark, not each tiny
      // raster segment. Keep joined wave segments full at their shared seed
      // and taper only at the exposed end when requested.
      const strokeT = clamp01(strokeT0 + (strokeT1 - strokeT0) * t);
      const startFade = taperStart ? smoothstep(0.0, 0.2, strokeT) : 1.0;
      const endFade = taperEnd ? smoothstep(0.0, 0.2, 1.0 - strokeT) : 1.0;
      const edgeFade = Math.min(startFade, endFade);
      const pressure = radius > 1000
        ? charcoalStrokePressureAt(strokeT, taperStart, taperEnd)
        : charcoalStrokePressureFast(strokeT, taperStart, taperEnd);

      // 2. High-frequency paper-tooth texture & ink grain
      const paperTooth =
        (hash01(index * 17 + markSeed, 541) - 0.5) * 0.35 +
        (hash01(index * 31, 733) - 0.5) * 0.2;

      // 3. Rough ragged edge variation
      const localRadius =
        radius *
        pressure *
        (1.0 -
          variation * 0.35 +
          hash01(index, markSeed + 1) * variation +
          paperTooth * 0.3);

      if (distanceSquared >= (localRadius + 0.65) * (localRadius + 0.65)) continue;

      // 4. Micro dry-ink stippling and paper skips
      const drySkipChance = 0.05 * (1.0 - edgeFade);
      if (hash01(index + markSeed * 7, 317) < drySkipChance) continue;

      // 5. Alpha coverage with natural ragged edge falloff
      const rawCoverage = localRadius > 0.35 && distanceSquared <= (localRadius - 0.35) * (localRadius - 0.35)
        ? 1
        : clamp01(localRadius - Math.sqrt(distanceSquared) + 0.65);
      const inkTexture = 0.78 + 0.22 * hash01(index, markSeed + 991);
      const coverage = Math.min(1.0, rawCoverage * inkTexture * 0.95);

      alpha[index] = Math.max(alpha[index], Math.round(coverage * 255));
      if (coverage > 0.15) tone[index] = Math.max(tone[index], toneValue);
    }
  }
}

interface WetlandCellFeature {
  x: number;
  y: number;
  radius: number;
  key: number;
  phase: number;
  majorAxis: number;
  minorAxis: number;
  axisCos: number;
  axisSin: number;
}

interface WetlandMergeBridge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  controlX: number;
  controlY: number;
  radius: number;
}

interface WetlandPuddleNoiseField {
  unionSignedDistance: Float32Array;
}

// Keep generated geometry separate from the final ink pass. Style controls
// such as thickness and opacity can then be adjusted without rebuilding the
// cellular field; changing seed/density/scale naturally selects a new entry.
const wetlandPuddleNoiseCache = new WeakMap<
  MountainDEMData,
  Map<string, WetlandPuddleNoiseField>
>();

function hashWetlandMask(mask: Uint8Array): number {
  let hash = 2166136261;
  for (const value of mask) hash = Math.imul(hash ^ value, 16777619);
  return hash >>> 0;
}

/** Smooth deterministic value noise used to group nearby cellular features. */
function sampleWetlandValueNoise(
  x: number,
  y: number,
  seed: number,
  salt: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const smoothX = tx * tx * (3 - 2 * tx);
  const smoothY = ty * ty * (3 - 2 * ty);
  const corner = (cornerX: number, cornerY: number): number => {
    const key = (
      Math.imul(cornerX, 374761393) ^
      Math.imul(cornerY, 668265263) ^
      seed
    ) | 0;
    return hash01(key, salt);
  };
  const north =
    corner(x0, y0) * (1 - smoothX) + corner(x0 + 1, y0) * smoothX;
  const south =
    corner(x0, y0 + 1) * (1 - smoothX) + corner(x0 + 1, y0 + 1) * smoothX;
  return north * (1 - smoothY) + south * smoothY;
}

function wetlandFeatureSignedDistance(
  feature: WetlandCellFeature,
  x: number,
  y: number,
  nearestDistance = Number.POSITIVE_INFINITY,
): number {
  const deltaX = x - feature.x;
  const deltaY = y - feature.y;
  const axisCos = feature.axisCos;
  const axisSin = feature.axisSin;
  const axisX = deltaX * axisCos + deltaY * axisSin;
  const axisY = -deltaX * axisSin + deltaY * axisCos;
  const baseShapeX = axisX / feature.majorAxis;
  const baseShapeY = axisY / feature.minorAxis;
  const baseDistance = Math.hypot(baseShapeX, baseShapeY);
  // Domain warp moves this point by at most sqrt(2) * 0.17 radii;
  // radial and boundary noise expand the radius by at most 0.355 + 0.16.
  // A feature farther away than that cannot improve the current union.
  if (baseDistance - feature.radius * 1.76 > nearestDistance) return Number.POSITIVE_INFINITY;
  const warpEnvelope = smoothstep(
    feature.radius * 0.18,
    feature.radius * 0.92,
    baseDistance,
  );
  const noiseX =
    (sampleWetlandValueNoise(
      baseShapeX / Math.max(1, feature.radius) * 1.35 + feature.phase,
      baseShapeY / Math.max(1, feature.radius) * 1.35 - feature.phase * 0.7,
      feature.key,
      503,
    ) - 0.5) * feature.radius * 0.34 * warpEnvelope;
  const noiseY =
    (sampleWetlandValueNoise(
      baseShapeX / Math.max(1, feature.radius) * 1.35 - feature.phase * 0.45,
      baseShapeY / Math.max(1, feature.radius) * 1.35 + feature.phase,
      feature.key,
      509,
    ) - 0.5) * feature.radius * 0.34 * warpEnvelope;
  const shapeX = baseShapeX + noiseX;
  const shapeY = baseShapeY + noiseY;
  const shapeDistance = Math.hypot(shapeX, shapeY);
  const angle = Math.atan2(shapeY, shapeX);
  const radialWarp =
    Math.sin(angle * 2 + feature.phase) * 0.16 +
    Math.sin(angle * 3 - feature.phase * 1.1) * 0.10 +
    Math.sin(angle * 5 + feature.phase * 0.35) * 0.065 +
    Math.sin(angle * 7 - feature.phase * 0.8) * 0.03;
  const boundaryNoise =
    (sampleWetlandValueNoise(
      Math.cos(angle) * 1.8 + feature.phase,
      Math.sin(angle) * 1.8 - feature.phase,
      feature.key,
      521,
    ) - 0.5) * 0.22 +
    (sampleWetlandValueNoise(
      Math.cos(angle) * 4.6 - feature.phase * 0.8,
      Math.sin(angle) * 4.6 + feature.phase * 0.8,
      feature.key,
      523,
    ) - 0.5) * 0.10;
  return shapeDistance - feature.radius * (1 + radialWarp + boundaryNoise);
}

function wetlandBridgeSignedDistance(
  bridge: WetlandMergeBridge,
  x: number,
  y: number,
): number {
  const endpointDistance = Math.hypot(
    bridge.x1 - bridge.x0,
    bridge.y1 - bridge.y0,
  );
  const curveDistance = Math.hypot(
    bridge.controlX - (bridge.x0 + bridge.x1) * 0.5,
    bridge.controlY - (bridge.y0 + bridge.y1) * 0.5,
  );
  const steps = Math.max(8, Math.ceil((endpointDistance + curveDistance) / 4));
  let nearestDistance = Number.POSITIVE_INFINITY;
  let previousX = bridge.x0;
  let previousY = bridge.y0;
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const inverseT = 1 - t;
    const pointX =
      inverseT * inverseT * bridge.x0 +
      2 * inverseT * t * bridge.controlX +
      t * t * bridge.x1;
    const pointY =
      inverseT * inverseT * bridge.y0 +
      2 * inverseT * t * bridge.controlY +
      t * t * bridge.y1;
    const segmentX = pointX - previousX;
    const segmentY = pointY - previousY;
    const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY || 1;
    const segmentT = clamp01(
      ((x - previousX) * segmentX + (y - previousY) * segmentY) /
        segmentLengthSquared,
    );
    nearestDistance = Math.min(
      nearestDistance,
      Math.hypot(
        x - (previousX + segmentX * segmentT),
        y - (previousY + segmentY * segmentT),
      ),
    );
    previousX = pointX;
    previousY = pointY;
  }
  return nearestDistance - bridge.radius;
}

function wetlandInkSegment(
  x: number,
  y: number,
  seed: number,
  salt: number,
  pixelScale = 1,
): { open: boolean; point: boolean } {
  // Correlated breaks remove short chunks of ink instead of randomly
  // peppering every pixel. A few survivors in a closed chunk become the
  // small charcoal points visible in hand-drawn map linework.
  const markScale = Math.max(0.25, pixelScale);
  const segmentX = Math.floor(x / (3.2 * markScale));
  const segmentY = Math.floor(y / (3.2 * markScale));
  const segmentKey = (
    Math.imul(segmentX, 374761393) ^
    Math.imul(segmentY, 668265263) ^
    seed
  ) | 0;
  const segmentNoise = hash01(segmentKey, salt);
  if (segmentNoise >= 0.22) return { open: true, point: false };
  const pointKey = (
    Math.imul(x / markScale, 1274126177) ^
    Math.imul(y / markScale, 1597334677) ^
    seed
  ) | 0;
  return {
    open: false,
    point: hash01(pointKey, salt + 17) > 0.78,
  };
}

/**
 * Generates hand-inked pond shorelines from a small Worley/F1 field.
 *
 * The wetland biome remains the source of truth for placement. Each accepted
 * jittered cell feature becomes a small, medium, or large irregular pocket;
 * their signed-distance union removes internal seams when neighbouring pools
 * overlap, so the result receives one combined outline and contour field.
 */
export function buildWetlandPuddleContours(
  dem: MountainDEMData,
  options: {
    density?: number;
    sizeMin?: number;
    sizeMax?: number;
    coastDistance?: number;
    opacity?: number;
    thickness?: number;
    seed?: number;
    coordinateScale?: number;
    coordinateOffsetX?: number;
    coordinateOffsetY?: number;
    coordinateDomainWidth?: number;
    coordinateDomainHeight?: number;
    /** Build only the procedural pool geometry; final ink/fill comes later. */
    geometryOnly?: boolean;
  } = {},
): {
  alpha: Uint8Array;
  tone: Uint8Array;
  fillAlpha: Uint8Array;
  fillTone: Uint8Array;
  /** Binary procedural pool geometry, unioned into the final visual water mask. */
  puddleMask: Uint8Array;
  /** Fractional coverage from the procedural signed-distance boundary. */
  puddleCoverage: Float32Array;
  interiorDistance: Float32Array;
} {
  const { width, height } = dem;
  const totalCells = width * height;
  const alpha = new Uint8Array(totalCells);
  const tone = new Uint8Array(totalCells);
  const fillAlpha = new Uint8Array(totalCells);
  const fillTone = new Uint8Array(totalCells);
  const puddleMask = new Uint8Array(totalCells);
  const puddleCoverage = new Float32Array(totalCells);
  const density = Math.max(0, Math.min(2, options.density ?? 0.85));
  const sizeMin = Math.max(INSPECTOR_BOUNDS.poolSizeMin, Math.min(1, options.sizeMin ?? 0.1));
  const sizeMax = Math.max(sizeMin, Math.min(1, options.sizeMax ?? 0.6));
  const coastDistance = Math.max(0, Math.min(2, options.coastDistance ?? 0));
  const opacity = clamp01(options.opacity ?? 0.78);
  const coordinateScale = Math.max(0.25, options.coordinateScale ?? 1);
  const thickness = Math.max(
    0.2 * coordinateScale,
    Math.min(3.5 * coordinateScale, options.thickness ?? 1),
  );
  const seed = Math.round(options.seed ?? 23817);
  const coordinateOffsetX = options.coordinateOffsetX ?? 0;
  const coordinateOffsetY = options.coordinateOffsetY ?? 0;
  const coordinateDomainWidth = Math.max(
    1,
    Math.round(options.coordinateDomainWidth ?? width),
  );
  const coordinateDomainHeight = Math.max(
    1,
    Math.round(options.coordinateDomainHeight ?? height),
  );
  if (
    density <= 0 ||
    !dem.biomeType ||
    (!options.geometryOnly && opacity <= 0)
  ) {
    return {
      alpha,
      tone,
      fillAlpha,
      fillTone,
      puddleMask,
      puddleCoverage,
      interiorDistance: new Float32Array(totalCells),
    };
  }

  const wetlandMask = dem.biomeType;
  const isPoolPlacementCell = (index: number): boolean =>
    wetlandMask[index] === 7;
  // In a tiled export the local tile (plus halo) is smaller than the global
  // domain. Derive the source cell size from the full preview-domain extent
  // so a short edge tile cannot change pool size or density relative to its
  // neighboring tiles. Direct preview callers retain the local behavior.
  const hasCoordinateDomain =
    options.coordinateDomainWidth !== undefined &&
    options.coordinateDomainHeight !== undefined;
  const minimumDimension = hasCoordinateDomain
    ? Math.min(coordinateDomainWidth, coordinateDomainHeight) /
      Math.max(0.25, coordinateScale)
    : Math.min(width, height);
  const cellSize = Math.max(
    20,
    Math.min(180, minimumDimension * 0.19),
  ) * coordinateScale;
  const cacheKey = [
    width,
    height,
    hashWetlandMask(wetlandMask),
    density.toFixed(3),
    sizeMin.toFixed(3),
    sizeMax.toFixed(3),
    coastDistance.toFixed(3),
    coordinateScale.toFixed(3),
    coordinateOffsetX,
    coordinateOffsetY,
    coordinateDomainWidth,
    coordinateDomainHeight,
    seed,
  ].join(":");
  const cacheEntries = wetlandPuddleNoiseCache.get(dem);
  const cachedNoiseField = cacheEntries?.get(cacheKey);
  let unionSignedDistance: Float32Array;
  const strokeHalfWidth = Math.max(
    0.2 * coordinateScale,
    0.55 * thickness,
  );

  if (cachedNoiseField) {
    unionSignedDistance = cachedNoiseField.unionSignedDistance;
  } else {
    // Keep the procedural shape away from the biome edge. The renderer clips
    // water to the wetland mask later, so accepting a pocket that crosses that
    // edge would turn its shoreline into a visibly straight raster cutoff.
    const wetlandEdgeDistance = buildDistanceToCoast(
      wetlandMask,
      width,
      height,
    );
    // Optional extra gap between pool shorelines and the ocean, in the same
    // pool-grid units as the size range.
    let oceanDistance: Float32Array | null = null;
    if (coastDistance > 0 && coordinateScale === 1 && dem.isOcean?.length === totalCells) {
      const landMask = new Uint8Array(totalCells);
      for (let index = 0; index < totalCells; index++) {
        landMask[index] = dem.isOcean[index] ? 0 : 1;
      }
      oceanDistance = buildDistanceToCoast(landMask, width, height);
    }
    // Density controls how many cells are accepted, rather than changing the
    // scale of every contour. This keeps the puddles legible when density is
    // tuned in the studio.
    // Use a smooth saturating curve: the default density retains a healthy
    // wetland population, while the upper end of the 0..2 studio range still
    // produces more accepted cells instead of hitting 100% too early.
    const acceptance = 1 - Math.exp(-density * 1.67);
    const gridMinX = Math.floor(coordinateOffsetX / cellSize) - 1;
    const gridMinY = Math.floor(coordinateOffsetY / cellSize) - 1;
    const gridMaxX = Math.ceil((coordinateOffsetX + width) / cellSize) + 1;
    const gridMaxY = Math.ceil((coordinateOffsetY + height) / cellSize) + 1;
    const featureColumns = gridMaxX - gridMinX + 1;
    const featureRows = gridMaxY - gridMinY + 1;
    // Every sampled cell lies in this small padded lattice. An indexed array
    // avoids hundreds of thousands of transient "x:y" strings during the
    // full-resolution union pass while preserving the row-major insertion
    // order used by the feature and bridge passes below.
    const features: Array<WetlandCellFeature | null | undefined> =
      new Array(featureColumns * featureRows);
    const featureIndexAt = (cellX: number, cellY: number): number => {
      const column = cellX - gridMinX;
      const row = cellY - gridMinY;
      return column < 0 || row < 0 || column >= featureColumns || row >= featureRows
        ? -1
        : row * featureColumns + column;
    };

  const cellFeature = (cellX: number, cellY: number): WetlandCellFeature | null => {
    const featureIndex = featureIndexAt(cellX, cellY);
    if (featureIndex < 0) return null;
    const cached = features[featureIndex];
    if (cached !== undefined) return cached;

    const cellKey = (
      Math.imul(cellX, 374761393) ^
      Math.imul(cellY, 668265263) ^
      seed
    ) | 0;
    const clusterValue = sampleWetlandValueNoise(
      cellX * 0.52 + 0.17,
      cellY * 0.52 - 0.31,
      seed,
      401,
    );
    const localAcceptance = clamp01(
      acceptance * (0.68 + clusterValue * 0.72),
    );
    if (hash01(cellKey, 405) > localAcceptance) {
      features[featureIndex] = null;
      return null;
    }

    const domainWarpX =
      (sampleWetlandValueNoise(cellX * 0.68 + 4.3, cellY * 0.68 - 2.1, seed, 409) - 0.5) * 0.22;
    const domainWarpY =
      (sampleWetlandValueNoise(cellX * 0.68 - 1.7, cellY * 0.68 + 5.2, seed, 419) - 0.5) * 0.22;
    const featureX =
      (cellX + 0.12 + hash01(cellKey, 423) * 0.76 + domainWarpX) * cellSize -
      coordinateOffsetX;
    const featureY =
      (cellY + 0.12 + hash01(cellKey, 429) * 0.76 + domainWarpY) * cellSize -
      coordinateOffsetY;
    const sampleX = Math.max(0, Math.min(width - 1, Math.round(featureX)));
    const sampleY = Math.max(0, Math.min(height - 1, Math.round(featureY)));
    const sizeRoll = hash01(cellKey, 431);
    // Few large, some medium, many small pockets, spread across the
    // user's min..max radius range.
    const sizeT = sizeRoll < 0.16
      ? 0.62 + hash01(cellKey, 433) * 0.38
      : sizeRoll < 0.54
        ? 0.24 + hash01(cellKey, 435) * 0.27
        : hash01(cellKey, 437) * 0.2;
    const majorAxis = 1.08 + hash01(cellKey, 445) * 0.34;
    const minorAxis = 0.62 + hash01(cellKey, 451) * 0.27;
    const radius = cellSize * (sizeMin + (sizeMax - sizeMin) * sizeT);
    // The warped boundary can extend farther than the nominal ellipse. Use a
    // generous clearance margin so the union is never cut flat by the mask.
    const requiredClearance =
      radius * majorAxis * 1.8 + 2 * coordinateScale;
    const globalFeatureX = featureX + coordinateOffsetX;
    const globalFeatureY = featureY + coordinateOffsetY;
    const canvasEdgeDistance = Math.min(
      globalFeatureX,
      globalFeatureY,
      coordinateDomainWidth - 1 - globalFeatureX,
      coordinateDomainHeight - 1 - globalFeatureY,
    );
    if (
      !isPoolPlacementCell(sampleY * width + sampleX) ||
      Math.min(
        coordinateScale === 1
          ? wetlandEdgeDistance[sampleY * width + sampleX]
          : Number.POSITIVE_INFINITY,
        canvasEdgeDistance,
      ) < requiredClearance ||
      (oceanDistance !== null &&
        oceanDistance[sampleY * width + sampleX] <
          requiredClearance + coastDistance * cellSize)
    ) {
      features[featureIndex] = null;
      return null;
    }

    const axisAngle = hash01(cellKey, 457) * Math.PI;
    const feature: WetlandCellFeature = {
      x: featureX,
      y: featureY,
      radius,
      key: cellKey,
      phase: hash01(cellKey, 439) * Math.PI * 2,
      majorAxis,
      minorAxis,
      axisCos: Math.cos(axisAngle),
      axisSin: Math.sin(axisAngle),
    };
    features[featureIndex] = feature;
    return feature;
  };

  for (let cellY = gridMinY; cellY <= gridMaxY; cellY++) {
    for (let cellX = gridMinX; cellX <= gridMaxX; cellX++) {
      cellFeature(cellX, cellY);
    }
  }

  const wetlandFeatures: WetlandCellFeature[] = [];
  for (const feature of features) {
    if (feature) wetlandFeatures.push(feature);
  }
  const bridgesByCell: Array<WetlandMergeBridge[] | undefined> =
    new Array(features.length);
  for (let first = 0; first < wetlandFeatures.length; first++) {
    const featureA = wetlandFeatures[first];
    for (let second = first + 1; second < wetlandFeatures.length; second++) {
      const featureB = wetlandFeatures[second];
      const centerDistance = Math.hypot(
        featureA.x - featureB.x,
        featureA.y - featureB.y,
      );
      const extentA = featureA.radius * featureA.majorAxis;
      const extentB = featureB.radius * featureB.majorAxis;
      // Only bridge a small shoreline gap. A previous large-pocket shortcut
      // could connect two distant lakes with a long, ruler-straight neck.
      const shorelineGap = centerDistance - extentA - extentB;
      const maximumGap = Math.min(
        cellSize * 0.04,
        Math.max(2, Math.min(extentA, extentB) * 0.10),
      );
      if (
        shorelineGap < 0 ||
        shorelineGap > maximumGap ||
        hash01(featureA.key ^ featureB.key, 487) < 0.58
      ) continue;

      const bridgeRadius = Math.max(
        1.8,
        Math.min(
          cellSize * 0.045,
          Math.min(extentA, extentB) * 0.16,
        ),
      );
      const directionX = (featureB.x - featureA.x) / Math.max(1, centerDistance);
      const directionY = (featureB.y - featureA.y) / Math.max(1, centerDistance);
      const curveDirection = hash01(featureA.key ^ featureB.key, 491) < 0.5 ? -1 : 1;
      const curveAmount = Math.min(
        cellSize * 0.14,
        Math.max(2.5, shorelineGap * 0.7),
      );
      const bridge: WetlandMergeBridge = {
        x0: featureA.x,
        y0: featureA.y,
        x1: featureB.x,
        y1: featureB.y,
        controlX: 0,
        controlY: 0,
        radius: bridgeRadius,
      };
      bridge.controlX =
        (bridge.x0 + bridge.x1) * 0.5 - directionY * curveAmount * curveDirection;
      bridge.controlY =
        (bridge.y0 + bridge.y1) * 0.5 + directionX * curveAmount * curveDirection;
      const bridgeSteps = Math.max(
        8,
        Math.ceil(
          (Math.hypot(bridge.x1 - bridge.x0, bridge.y1 - bridge.y0) +
            curveAmount) /
            4,
        ),
      );
      let bridgeIsInsideWetland = true;
      for (let step = 0; step <= bridgeSteps; step++) {
        const t = step / bridgeSteps;
        const inverseT = 1 - t;
        const sampleX = Math.round(
          inverseT * inverseT * bridge.x0 +
            2 * inverseT * t * bridge.controlX +
            t * t * bridge.x1,
        );
        const sampleY = Math.round(
          inverseT * inverseT * bridge.y0 +
            2 * inverseT * t * bridge.controlY +
            t * t * bridge.y1,
        );
        const globalSampleX = sampleX + coordinateOffsetX;
        const globalSampleY = sampleY + coordinateOffsetY;
        const canvasEdgeDistance = Math.min(
          globalSampleX,
          globalSampleY,
          coordinateDomainWidth - 1 - globalSampleX,
          coordinateDomainHeight - 1 - globalSampleY,
        );
        if (
          sampleX < 0 ||
          sampleX >= width ||
          sampleY < 0 ||
          sampleY >= height ||
          !isPoolPlacementCell(sampleY * width + sampleX) ||
          Math.min(
            coordinateScale === 1
              ? wetlandEdgeDistance[sampleY * width + sampleX]
              : Number.POSITIVE_INFINITY,
            canvasEdgeDistance,
          ) < bridge.radius + 1.5
        ) {
          bridgeIsInsideWetland = false;
          break;
        }
      }
      if (!bridgeIsInsideWetland) continue;

      const minCellX = Math.floor(
        (Math.min(bridge.x0, bridge.x1, bridge.controlX) +
          coordinateOffsetX -
          bridge.radius) /
          cellSize,
      );
      const maxCellX = Math.floor(
        (Math.max(bridge.x0, bridge.x1, bridge.controlX) +
          coordinateOffsetX +
          bridge.radius) /
          cellSize,
      );
      const minCellY = Math.floor(
        (Math.min(bridge.y0, bridge.y1, bridge.controlY) +
          coordinateOffsetY -
          bridge.radius) /
          cellSize,
      );
      const maxCellY = Math.floor(
        (Math.max(bridge.y0, bridge.y1, bridge.controlY) +
          coordinateOffsetY +
          bridge.radius) /
          cellSize,
      );
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
          const bridgeCellIndex = featureIndexAt(cellX, cellY);
          if (bridgeCellIndex < 0) continue;
          const cellBridges = bridgesByCell[bridgeCellIndex];
          if (cellBridges) cellBridges.push(bridge);
          else bridgesByCell[bridgeCellIndex] = [bridge];
        }
      }
    }
  }

  unionSignedDistance = new Float32Array(totalCells).fill(
    Number.POSITIVE_INFINITY,
  );

  // First build a continuous union field. Taking the minimum signed distance
  // is the important part here: overlapping pockets become one body instead
  // of retaining separate outlines where their shapes intersect.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!isPoolPlacementCell(index)) continue;

      const cellX = Math.floor((x + coordinateOffsetX) / cellSize);
      const cellY = Math.floor((y + coordinateOffsetY) / cellSize);
      let nearestSignedDistance = Number.POSITIVE_INFINITY;
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const candidate = cellFeature(cellX + offsetX, cellY + offsetY);
          if (!candidate) continue;
          nearestSignedDistance = Math.min(
            nearestSignedDistance,
            wetlandFeatureSignedDistance(candidate, x, y, nearestSignedDistance),
          );
        }
      }
      const bridgeCellIndex = featureIndexAt(cellX, cellY);
      const cellBridges = bridgeCellIndex < 0
        ? undefined
        : bridgesByCell[bridgeCellIndex];
      if (cellBridges) {
        for (const bridge of cellBridges) {
          nearestSignedDistance = Math.min(
            nearestSignedDistance,
            wetlandBridgeSignedDistance(bridge, x, y),
          );
        }
      }
      unionSignedDistance[index] = nearestSignedDistance;
    }
  }
    const noiseCache =
      cacheEntries ?? new Map<string, WetlandPuddleNoiseField>();
    noiseCache.set(cacheKey, { unionSignedDistance });
    if (noiseCache.size > 3) {
      const oldestKey = noiseCache.keys().next().value;
      if (oldestKey !== undefined) noiseCache.delete(oldestKey);
    }
    wetlandPuddleNoiseCache.set(dem, noiseCache);
  }

  for (let index = 0; index < totalCells; index++) {
    const signedDistance = unionSignedDistance[index];
    if (signedDistance <= 0) puddleMask[index] = 1;
    // The procedural union is already a continuous signed-distance field.
    // Preserve its sub-pixel edge instead of throwing it away here and later
    // trying to blur a thresholded, analysis-resolution silhouette.
    puddleCoverage[index] = clamp01(0.5 - signedDistance);
  }
  // This distance is measured to the outside of the union, not to each
  // feature. It therefore gives combined pools a single shared outline and
  // lets their inner bands flow around the merged shape.
  const distanceInsidePuddle = buildDistanceToCoast(puddleMask, width, height);
  if (options.geometryOnly) {
    return {
      alpha,
      tone,
      fillAlpha,
      fillTone,
      puddleMask,
      puddleCoverage,
      interiorDistance: distanceInsidePuddle,
    };
  }
  const innerStrokeHalfWidth = Math.max(
    0.2 * coordinateScale,
    strokeHalfWidth * 0.68,
  );
  const innerBandGap = Math.max(
    2.5 * coordinateScale,
    Math.min(4.5 * coordinateScale, cellSize * 0.04),
  );
  const innerBands = [
    // Keep one lighter inner mark a few actual pixels inside the shoreline.
    // Its position is tied to stroke width so the two layers cannot merge
    // when the charcoal thickness slider is increased.
    {
      depth: strokeHalfWidth + innerStrokeHalfWidth + innerBandGap,
      strength: 0.42,
      gap: 0.36,
      salt: 463,
    },
  ];
  const innerBandSpacing = Math.max(
    3.2 * coordinateScale,
    Math.min(8.5 * coordinateScale, cellSize * 0.075),
  );

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      // Procedural marks must be evaluated in export-global coordinates. A
      // tile-local noise/hash origin makes the pattern restart at every 1024
      // px boundary even though the signed-distance pool geometry is global.
      const globalPixelX = x + coordinateOffsetX;
      const globalPixelY = y + coordinateOffsetY;
      const globalPixelIndex =
        Math.round(globalPixelY) * coordinateDomainWidth +
        Math.round(globalPixelX);
      if (wetlandMask[index] !== 7) continue;
      const signedDistance = unionSignedDistance[index];
      if (!Number.isFinite(signedDistance)) continue;

      // The generated pocket is a translucent wash rather than a new DEM
      // water body. It is strongest toward the centre and softly anti-aliased
      // at the shared irregular shore.
      if (signedDistance <= 0.9 * coordinateScale) {
        const depth = clamp01(
          distanceInsidePuddle[index] / Math.max(1, cellSize * 0.30),
        );
        const edgeCoverage = clamp01(
          1.0 - signedDistance / (1.35 * coordinateScale),
        );
        const waterCoverage = (0.58 + depth * 0.18) * opacity * edgeCoverage;
        const value = Math.round(waterCoverage * 255);
        if (value > fillAlpha[index]) {
          fillAlpha[index] = value;
          fillTone[index] = Math.round(188 + depth * 44);
        }
      }

      // One continuous outer outline follows the union field. It is kept
      // whole so two touching pools read as one marsh body instead of two
      // overlapping balloons.
      const outerDistance = Math.abs(signedDistance);
      if (outerDistance <= strokeHalfWidth + 0.72 * coordinateScale) {
        const inkSegment = wetlandInkSegment(
          globalPixelX,
          globalPixelY,
          seed,
          439,
          coordinateScale,
        );
        if (inkSegment.open || inkSegment.point) {
          const edgeCoverage = clamp01(
            (strokeHalfWidth + 0.72 * coordinateScale - outerDistance) /
              (1.15 * coordinateScale),
          );
          const tooth = 0.80 + 0.20 * hash01(globalPixelIndex, 449);
          const pointStrength = inkSegment.point ? 0.62 : 1.0;
          const value = Math.round(
            edgeCoverage * tooth * opacity * pointStrength * 255,
          );
          if (value > alpha[index]) {
            alpha[index] = value;
            tone[index] = Math.round(15 + hash01(globalPixelIndex, 457) * 70);
          }
        }
      }

      // Inner bands use the distance to the combined boundary, so no feature
      // seam is drawn inside a merged puddle. Value noise creates stable,
      // irregular breaks instead of a regular circular dash pattern.
      if (puddleMask[index] !== 1) continue;
      const boundaryDistance = distanceInsidePuddle[index];
      for (const band of innerBands) {
        const distanceToBand = Math.abs(boundaryDistance - band.depth);
        if (
          distanceToBand > innerStrokeHalfWidth + 0.58 * coordinateScale
        )
          continue;
        const breakNoise = sampleWetlandValueNoise(
          globalPixelX / innerBandSpacing + band.depth,
          globalPixelY / innerBandSpacing - band.depth,
          seed + band.salt,
          band.salt,
        );
        if (breakNoise < band.gap) continue;
        const inkSegment = wetlandInkSegment(
          globalPixelX,
          globalPixelY,
          seed + band.salt,
          band.salt + 31,
          coordinateScale,
        );
        if (!inkSegment.open && !inkSegment.point) continue;
        const edgeCoverage = clamp01(
          (innerStrokeHalfWidth + 0.58 * coordinateScale - distanceToBand) /
            coordinateScale,
        );
        const tooth = 0.78 + 0.22 * hash01(globalPixelIndex, band.salt + 6);
        const pointStrength = inkSegment.point ? 0.62 : 1.0;
        const value = Math.round(
          edgeCoverage * tooth * opacity * band.strength * pointStrength * 255,
        );
        if (value > alpha[index]) {
          alpha[index] = value;
          tone[index] = Math.round(18 + hash01(index, band.salt + 14) * 68);
        }
      }
    }
  }

  return {
    alpha,
    tone,
    fillAlpha,
    fillTone,
    puddleMask,
    puddleCoverage,
    interiorDistance: distanceInsidePuddle,
  };
}

/**
 * Builds the authoritative visual-water classification carried by the DEM.
 * Wetland pools are generated once in analysis coordinates, then unioned with
 * routed/ecological water before either the viewport or an export tile renders.
 */
export function buildVisualWaterSurfaceDEM(
  dem: MountainDEMData,
  options: {
    enabled?: boolean;
    density?: number;
    sizeMin?: number;
    sizeMax?: number;
    coastDistance?: number;
    seed?: number;
    riverThresholdKm2?: number;
    siltReachM?: number;
    siltTopRemoved?: number;
  } = {},
  profiler?: MountainProfiler,
): MountainDEMData {
  const totalCells = dem.width * dem.height;
  const threshold = Math.max(0.001, options.riverThresholdKm2 ?? 0.8);
  const poolGeometryStop = profiler?.begin("visual water pool geometry");
  const wetlandPoolGeometry =
    options.enabled !== false && dem.biomeType?.some((biome) => biome === 7)
      ? buildWetlandPuddleContours(dem, {
          density: options.density,
          sizeMin: options.sizeMin,
          sizeMax: options.sizeMax,
          coastDistance: options.coastDistance,
          seed: options.seed,
          opacity: 1,
          geometryOnly: true,
        })
      : null;
  poolGeometryStop?.();
  const wetlandPoolMask =
    wetlandPoolGeometry?.puddleMask ?? new Uint8Array(totalCells);
  const wetlandPoolCoverage =
    wetlandPoolGeometry?.puddleCoverage ?? new Float32Array(totalCells);
  // Routed lakes share the pool surface so every renderer (fill, outline,
  // river-ink cut-off, vegetation exclusion, export tiles) treats them alike.
  if (dem.lakeDepthM?.length === totalCells) {
    for (let index = 0; index < totalCells; index++) {
      if (dem.lakeDepthM[index] <= 0) continue;
      wetlandPoolMask[index] = 1;
      wetlandPoolCoverage[index] = 1;
    }
  }

  const visualWaterMask = new Uint8Array(totalCells);
  const outsidePoolMask = new Uint8Array(totalCells);
  // Reuse this mask as the outside-river input after coverage has captured the
  // river classification. That avoids another full-resolution byte buffer.
  const riverSurfaceMask = new Uint8Array(totalCells);
  const visualWaterCoverage = new Float32Array(totalCells);
  let hasPool = false;
  let hasRiver = false;
  const classificationStop = profiler?.begin("visual water classification masks");
  for (let index = 0; index < totalCells; index++) {
    const isPool = wetlandPoolMask[index] === 1;
    const routed =
      dem.isRiverChannel?.[index] === 1 &&
      routedAreaAt(dem, index) >= threshold;
    const isRiver = routed || dem.biomeType?.[index] === 6;
    if (isPool) hasPool = true;
    else outsidePoolMask[index] = 1;
    if (isRiver) hasRiver = true;
    riverSurfaceMask[index] = isRiver ? 1 : 0;
    if (
      dem.isOcean?.[index] === 1 ||
      isRiver ||
      isPool
    ) {
      visualWaterMask[index] = 1;
    }
    visualWaterCoverage[index] = Math.max(dem.isOcean?.[index] ?? 0, isRiver ? 1 : 0);
  }
  classificationStop?.();
  const siltStop = profiler?.begin("visual water river silt layers");
  const siltDepth = buildRiverSiltDepth(dem, riverSurfaceMask, {
    reachM: options.siltReachM,
    topRemoved: options.siltTopRemoved,
  });
  siltStop?.();

  // Biome classification can leave a very small dry seam between a wetland
  // pool and the routed channel it intersects. Close that seam in the DEM
  // classification itself so every renderer sees the same connected water.
  if (hasPool && hasRiver) {
    const distanceStop = profiler?.begin("visual water seam distance fields");
    const distanceToPool = buildDistanceToCoast(
      outsidePoolMask,
      dem.width,
      dem.height,
    );
    // The river labels are no longer needed after their contribution was
    // folded into visualWaterCoverage above.
    for (let index = 0; index < totalCells; index++) {
      riverSurfaceMask[index] = riverSurfaceMask[index] === 0 ? 1 : 0;
    }
    const distanceToRiver = buildDistanceToCoast(
      riverSurfaceMask,
      dem.width,
      dem.height,
    );
    distanceStop?.();
    const seamStop = profiler?.begin("visual water seam closure");
    const maximumClassificationGap = 3.5;
    for (let index = 0; index < totalCells; index++) {
      if (
        visualWaterMask[index] === 0 &&
        distanceToPool[index] + distanceToRiver[index] <=
          maximumClassificationGap
      ) {
        visualWaterMask[index] = 1;
      }
    }
    seamStop?.();
  }

  const coverageStop = profiler?.begin("visual water coverage merge");
  for (let index = 0; index < totalCells; index++) {
    visualWaterCoverage[index] = Math.max(
      visualWaterCoverage[index],
      wetlandPoolCoverage[index],
      visualWaterMask[index] && wetlandPoolCoverage[index] === 0 ? 1 : 0,
    );
  }
  coverageStop?.();

  return {
    ...dem,
    wetlandPoolMask,
    visualWaterMask,
    wetlandPoolCoverage,
    visualWaterCoverage,
    siltDepth: siltDepth ?? undefined,
    siltCreaseDepth: siltDepth ? buildRiverSiltCreaseField(siltDepth, dem) : undefined,
  };
}

/**
 * Draw broken charcoal contours inside the final inland-water union, in the
 * style of a hand-inked pool: pools get up to four concentric rings of short,
 * tapered, slightly bowed arcs that thin out toward the centre; rivers get one
 * inset line along each bank where they are wide enough to hold it. Depth
 * comes from the sub-pixel shore distance, so the arcs are smooth.
 */
function buildUnifiedInlandWaterContours(
  waterMask: Uint8Array,
  oceanCoverage: Uint8Array,
  shoreSignedDistance: Float32Array,
  width: number,
  height: number,
  options: {
    thickness: number;
    opacity: number;
    density: number;
    length: number;
    poolLength: number;
    poolMask: Uint8Array;
    smoothing: number;
    seed: number;
    coordinateScale?: number;
    coordinateOffsetX?: number;
    coordinateOffsetY?: number;
    coordinateStride?: number;
  },
): { alpha: Uint8Array; tone: Uint8Array } {
  const alpha = new Uint8Array(waterMask.length);
  const tone = new Uint8Array(waterMask.length);
  if (
    options.opacity <= 0 ||
    options.thickness <= 0 ||
    options.density <= 0
  ) {
    return { alpha, tone };
  }

  const coordinateScale = Math.max(0.25, options.coordinateScale ?? 1);
  const coordinateOffsetX = options.coordinateOffsetX ?? 0;
  const coordinateOffsetY = options.coordinateOffsetY ?? 0;
  const coordinateStride = Math.max(
    1,
    Math.round(options.coordinateStride ?? width),
  );
  // Every length below scales with coordinateScale only, so the preview and
  // any export size draw the same rings at the same share of the map. A line
  // thinner than a pixel is drawn one pixel wide but proportionally lighter,
  // which keeps its apparent weight resolution-independent too.
  const trueHalfWidth = Math.max(
    0.1 * coordinateScale,
    options.thickness * 0.34,
  );
  const halfWidth = Math.max(0.5, trueHalfWidth);
  const thinLineInk = Math.min(1, trueHalfWidth / 0.5);
  const edgeSoftness = 0.5;
  const edgeFalloff = 1;
  const targetDepth = halfWidth * 1.5 + 2.2 * coordinateScale;
  const nonOceanMask = new Uint8Array(waterMask.length);
  for (let index = 0; index < nonOceanMask.length; index++) {
    if (oceanCoverage[index] < 128) nonOceanMask[index] = 1;
  }
  const distanceToOcean = buildDistanceToCoast(
    nonOceanMask,
    width,
    height,
  );
  const mouthClearance = targetDepth + halfWidth + coordinateScale;
  const depthAt = (x: number, y: number): number => {
    const sampleX = Math.max(0, Math.min(width - 1, Math.round(x)));
    const sampleY = Math.max(0, Math.min(height - 1, Math.round(y)));
    return -shoreSignedDistance[sampleY * width + sampleX];
  };

  // Length changes the size of correlated uninterrupted chunks along the
  // contour; it must not turn curved chunks into straight tangent chords.
  const lengthScale = (value: number) => Math.max(0.2, value);
  // Density only shortens or lengthens the gaps between arcs.
  const densityShift = (Math.min(2, Math.max(0, options.density)) - 0.5) * 0.2;
  const bandBreakBase = [0.5, 0.57, 0.63, 0.68];
  // Pool rings start clear of the outline so they never read as a second
  // shoreline, then repeat inward.
  const poolFirstDepth = halfWidth + 5 * coordinateScale;
  const poolRingSpacing = 8 * coordinateScale;
  const toothVariation = Math.min(
    0.24,
    Math.max(0.06, 0.16 / Math.max(0.35, options.smoothing)),
  );

  // The ring layout above needs a pool this deep to show all four rings.
  // Shallower pools get the same layout compressed to their own depth (ring
  // offsets, spacing, wobble and arc breaks shrink together; stroke width
  // does not), so one set of settings reads the same on a lake and a puddle.
  const fullPoolDepth = poolFirstDepth + 3 * poolRingSpacing + halfWidth +
    2 * coordinateScale;
  const poolFit = new Float32Array(waterMask.length);
  {
    const component = new Int32Array(waterMask.length).fill(-1);
    const stack: number[] = [];
    const members: number[] = [];
    for (let start = 0; start < waterMask.length; start++) {
      if (
        component[start] !== -1 ||
        options.poolMask[start] !== 1 ||
        waterMask[start] === 0
      ) {
        continue;
      }
      component[start] = start;
      stack.push(start);
      members.length = 0;
      let maxDepth = 0;
      while (stack.length > 0) {
        const index = stack.pop()!;
        members.push(index);
        maxDepth = Math.max(maxDepth, -shoreSignedDistance[index]);
        const x = index % width;
        const neighbours = [
          x > 0 ? index - 1 : -1,
          x < width - 1 ? index + 1 : -1,
          index - width,
          index + width,
        ];
        for (const next of neighbours) {
          if (
            next < 0 ||
            next >= waterMask.length ||
            component[next] !== -1 ||
            options.poolMask[next] !== 1 ||
            waterMask[next] === 0
          ) {
            continue;
          }
          component[next] = start;
          stack.push(next);
        }
      }
      const fit = Math.min(1, maxDepth / fullPoolDepth);
      for (const index of members) poolFit[index] = fit;
    }
  }
  const minPoolFirstDepth = halfWidth + 1.5 * coordinateScale;
  const minPoolRingSpacing = 2 * halfWidth + 1.5 * coordinateScale;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (
        waterMask[index] === 0 ||
        oceanCoverage[index] >= 128 ||
        distanceToOcean[index] <= mouthClearance
      ) {
        continue;
      }
      const isPool = options.poolMask[index] === 1;
      const depth = -shoreSignedDistance[index];
      const globalX = x + coordinateOffsetX;
      const globalY = y + coordinateOffsetY;
      // Length controls arrive already multiplied by the output pixel scale
      // (scaleWaterPresentationOptions). Divide it back out so arc length is
      // the same share of the map in the preview and in any export size.
      const segmentLength = lengthScale(
        (isPool ? options.poolLength : options.length) / coordinateScale,
      );

      // Shore normal from the depth field. Near a pool's medial axis the
      // gradient collapses and concentric rings would degenerate into blobs.
      const gx = depthAt(x + 1, y) - depthAt(x - 1, y);
      const gy = depthAt(x, y + 1) - depthAt(x, y - 1);
      const gradient = Math.hypot(gx, gy);
      if (gradient < 1.2) continue;

      let band = 0;
      let bandCenter = targetDepth;
      const fit = isPool ? Math.max(0.05, poolFit[index]) : 1;
      if (isPool) {
        // Pools: several concentric rings of short bowed arcs, sparser
        // toward the centre, like hand-drawn ripple contours. A slow wobble
        // bends each arc slightly off the shoreline curve.
        const firstDepth = Math.max(minPoolFirstDepth, poolFirstDepth * fit);
        const ringSpacing = Math.max(minPoolRingSpacing, poolRingSpacing * fit);
        const wobbleSpacing = 8 * coordinateScale * segmentLength * fit;
        const wobble =
          (sampleWetlandValueNoise(
            globalX / wobbleSpacing,
            globalY / wobbleSpacing,
            options.seed + 517,
            517,
          ) - 0.5) *
          2 *
          Math.min(ringSpacing * 0.35, 2.4 * coordinateScale * fit);
        band = Math.max(
          0,
          Math.round((depth - wobble - firstDepth) / ringSpacing),
        );
        if (band > 3) continue;
        bandCenter = firstDepth + band * ringSpacing + wobble;
      } else {
        // Rivers: one line along each bank, only where the channel is at
        // least ~1.6x as wide as the inset (depth there is 2W - 2d).
        const inward = depthAt(
          x + (gx / gradient) * targetDepth,
          y + (gy / gradient) * targetDepth,
        );
        if (inward < targetDepth * 1.2) continue;
      }
      const distanceToBand = Math.abs(depth - bandCenter);
      if (distanceToBand > halfWidth + edgeSoftness) continue;

      const arcSpacing = (isPool ? 16 * fit : 20) * coordinateScale *
        segmentLength * (1 - 0.15 * band);
      const breakNoise = sampleWetlandValueNoise(
        globalX / arcSpacing + band * 7.3,
        globalY / arcSpacing - band * 3.1,
        options.seed + 463,
        463,
      );
      const threshold = Math.min(
        0.85,
        Math.max(0.1, bandBreakBase[Math.min(3, band)] - densityShift),
      );
      if (breakNoise < threshold) continue;
      // Taper: arcs thin out and fade toward their broken ends.
      const strength = smoothstep(threshold, threshold + 0.1, breakNoise);
      const strokeHalfWidth = halfWidth * (0.45 + 0.55 * strength);
      if (distanceToBand > strokeHalfWidth + edgeSoftness) continue;

      const globalIndex =
        Math.round(globalY) * coordinateStride + Math.round(globalX);
      const edgeCoverage = clamp01(
        (strokeHalfWidth + edgeSoftness - distanceToBand) / edgeFalloff,
      );
      const tooth =
        1 - toothVariation + toothVariation * hash01(globalIndex, 469);
      const ringFade =
        thinLineInk * 0.82 * Math.pow(0.88, band) * (0.55 + 0.45 * strength);
      alpha[index] = Math.round(edgeCoverage * tooth * ringFade * 255);
      tone[index] = Math.round(60 + hash01(globalIndex, 477) * 50);
    }
  }

  if (options.opacity < 1) {
    for (let index = 0; index < alpha.length; index++) {
      alpha[index] = Math.round(alpha[index] * options.opacity);
    }
  }

  return { alpha, tone };
}

/** @deprecated River flow ink now renders through the unified inland-water contour pass. */
export function paintFlowInk(
  splines: readonly RiverSpline[],
  waterCoverage: Uint8Array,
  width: number,
  height: number,
  density: number,
  lengthScale: number,
  opacity: number,
  smoothing: number,
  seed: number,
  thickness: number = 1,
  pixelScale: number = 1,
): { alpha: Uint8Array; tone: Uint8Array } {
  const alpha = new Uint8Array(width * height);
  const tone = new Uint8Array(width * height);
  if (density <= 0 || opacity <= 0) return { alpha, tone };
  const markScale = Math.max(0.25, pixelScale);
  const waterClip = new Uint8Array(waterCoverage.length);
  for (let index = 0; index < waterClip.length; index++)
    if (waterCoverage[index] > 28) waterClip[index] = 1;

  for (const spline of splines) {
    if (spline.samples.length < 2) continue;
    const cumulative = cumulativeLengths(spline.samples);
    const totalLength = cumulative[cumulative.length - 1];
    if (totalLength < 0.5) continue;
    // Use the same first coastal-band spacing and minimum Poisson clearance.
    // The spline is the only geometric difference: rivers follow their
    // routed centreline while ocean marks follow the coast tangent field.
    const spacing = Math.max(
      6.0 * markScale,
      (4.2 / Math.max(0.25, density)) * 0.78,
    );
    let distance = hash01(spline.key + seed, 131) * spacing;
    let markNumber = 0;
    while (distance < totalLength) {
      const markSeed = spline.key * 31 + seed * 17 + markNumber * 101;
      const location = locateOnSpline(spline.samples, cumulative, distance);
      const toneValue = Math.round(18 + hash01(markSeed, 137) * 65);
      // Flow ink needs enough water on both sides to read as an interior mark.
      // Headwaters narrower than this retain only fill and bank outline.
      const minimumInkRadius = 1.35 * markScale;
      if (location.radius < minimumInkRadius) {
        distance += spacing * (0.72 + hash01(markSeed, 173) * 0.72);
        markNumber++;
        continue;
      }

      const expanseRatio = Math.min(
        1.0,
        Math.max(0.35, location.radius / (7.0 * markScale)),
      );
      // Match the coastline painter's shoreline thinning. Narrow water gets
      // fewer accepted marks even though the shared density control is the
      // same, preventing rivers from reading as a solid charcoal bundle.
      if (hash01(markSeed, 131) > expanseRatio) {
        distance += spacing * (0.72 + hash01(markSeed, 173) * 0.72);
        markNumber++;
        continue;
      }
      // Narrow river corridors clip the outer half of an offset brush. The
      // coast painter has open water on that side, so use a small raster
      // compensation here to preserve the same visible charcoal width.
      const riverClipCompensation = location.radius < 4.0 ? 1.28 : 1.12;
      const baseInkRadius = 0.85 * thickness * riverClipCompensation;
      const inkRadius = Math.max(
        0.35,
        baseInkRadius * (0.8 + 0.2 * expanseRatio),
      );
      // Reserve room for the complete textured brush, including its maximum
      // per-segment radius variation. This prevents narrow rivers from
      // silently shaving one side off the shared charcoal stroke.
      const fullStrokeRadius = inkRadius * 1.13;
      const riverCharcoalBankClearance =
        thickness * RIVER_CHARCOAL_BANK_CLEARANCE_FACTOR;
      const usableCharcoalRadius =
        location.radius - fullStrokeRadius - riverCharcoalBankClearance;
      if (usableCharcoalRadius <= 0) {
        distance += spacing * (0.72 + hash01(markSeed, 173) * 0.72);
        markNumber++;
        continue;
      }
      // Use exactly one lane on the river centreline. The old offset lane made
      // a broad channel read as a second contour instead of one flow mark.
      const offset = 0;
      const laneOffsets = [offset];
      // Rivers are intentionally more interrupted and stippled than the
      // coastline: 2x the break rate and 4x the dot rate.
      const riverDotProbability = Math.min(1.0, 0.12 * 4.0);
      if (hash01(markSeed, 239) < riverDotProbability) {
        const numDots = 1 + Math.floor(hash01(markSeed, 241) * 3);
        const dotSpacing =
          (3.5 + hash01(markSeed, 251) * 2.5) * markScale;
        for (let dot = 0; dot < numDots; dot++) {
          const along = (dot - (numDots - 1) * 0.5) * dotSpacing;
          const dotDistance = distance + along;
          if (dotDistance < 0 || dotDistance > totalLength) continue;
          const dotLocation = locateOnSpline(
            spline.samples,
            cumulative,
            dotDistance,
          );
          paintInkDisk(
            alpha,
            tone,
            waterClip,
            width,
            height,
            dotLocation.x - dotLocation.tangentY * offset,
            dotLocation.y + dotLocation.tangentX * offset,
            inkRadius * 0.88,
            toneValue,
            markSeed + dot * 19,
          );
        }
      } else {
        const markLength = Math.max(
          3.2 * markScale,
          COASTAL_MARK_BASE_LENGTH * lengthScale,
        ) * (0.6 + 0.4 * expanseRatio);
        const halfLength = markLength * 0.5;
        const numSteps = Math.max(2, Math.round(halfLength / 0.42));
        const stepSize = halfLength / numSteps;
        const interruption = createCharcoalInterruptionPattern(
          markSeed,
          markScale,
        );

        const paintDirection = (direction: number, directionSeed: number): void => {
          for (let lane = 0; lane < laneOffsets.length; lane++) {
            const laneOffset = laneOffsets[lane];
            let previous = location;
            let previousOffset = laneOffset;
            for (let step = 0; step < numSteps; step++) {
              const travelled = step * stepSize;
              const next = locateOnSpline(
                spline.samples,
                cumulative,
                distance + direction * Math.min(halfLength, travelled + stepSize),
              );
              const nextDistance =
                distance + direction * Math.min(halfLength, travelled + stepSize);
              if (nextDistance < 0 || nextDistance > totalLength) break;
              const wobble =
                (hash01(
                  markSeed + directionSeed + lane * 997 + step * 37,
                  167,
                ) -
                  0.5) *
                ((0.22 * markScale) / (1 + smoothing));
              const nextOffset = laneOffset + wobble;
              if (isCharcoalInkActiveAtDistance(travelled, interruption)) {
                paintInkSegment(
                  alpha,
                  tone,
                  waterClip,
                  width,
                  height,
                  previous.x - previous.tangentY * previousOffset,
                  previous.y + previous.tangentX * previousOffset,
                  next.x - next.tangentY * nextOffset,
                  next.y + next.tangentX * nextOffset,
                  inkRadius * (0.88 + hash01(markSeed + step * 17, 169) * 0.25),
                  toneValue,
                  markSeed + directionSeed + lane * 509 + step * 13,
                  smoothing,
                  travelled / Math.max(0.001, halfLength),
                  Math.min(1, (travelled + stepSize) / Math.max(0.001, halfLength)),
                  false,
                  true,
                );
              } else if (
                hash01(markSeed + directionSeed + step * 23, 277) <
                riverDotProbability
              ) {
                paintInkDisk(
                  alpha,
                  tone,
                  waterClip,
                  width,
                  height,
                  (previous.x + next.x) * 0.5 -
                    next.tangentY * nextOffset,
                  (previous.y + next.y) * 0.5 +
                    next.tangentX * nextOffset,
                  inkRadius * 0.75,
                  toneValue,
                  markSeed + directionSeed + lane * 509 + step * 11,
                );
              }

              previous = next;
              previousOffset = nextOffset;
            }
          }
        };

        paintDirection(1, 0);
        paintDirection(-1, 101);
      }
      distance += spacing * (0.72 + hash01(markSeed, 173) * 0.72);
      markNumber++;
    }
  }
  if (opacity < 1)
    for (let index = 0; index < alpha.length; index++)
      alpha[index] = Math.round(alpha[index] * opacity);
  return { alpha, tone };
}

/**
 * Euclidean distance from each ocean pixel to its nearest dry land cell.
 *
 * The old two-pass chamfer approximation was fast, but its 1/1.414 step
 * pattern leaked into the coastline tangent and made high-resolution wave
 * strokes visibly stair-step.  A separable squared-distance transform keeps
 * the same linear-time behaviour while producing a continuous gradient for
 * bilinear tile sampling.
 */
export function buildDistanceToCoast(
  isOcean: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  return buildDistanceField(isOcean, width, height);
}

/**
 * Fast O(W x H) separable Gaussian-approximate box smoothing over arbitrary radii.
 * Replaces sharp medial axis ridges and Voronoi kinks with smooth, continuous rounded curves
 * while preserving shoreline boundaries via optional masking.
 */
// Smoothing is used for many independent DEM fields during one render. Keep
// the scratch horizontal pass alive between calls so a style edit does not
// repeatedly allocate another full-size Float32Array. Returned fields retain
// their ownership and are never put back into this pool.
const smoothingBufferPool = new Map<number, Float32Array[]>();

function acquireSmoothingBuffer(length: number): Float32Array {
  const bucket = smoothingBufferPool.get(length);
  const buffer = bucket?.pop();
  return buffer ?? new Float32Array(length);
}

function releaseSmoothingBuffer(buffer: Float32Array): void {
  let bucket = smoothingBufferPool.get(buffer.length);
  if (!bucket) {
    bucket = [];
    smoothingBufferPool.set(buffer.length, bucket);
  }
  // Keep the pool bounded. A second buffer of the same size is enough for
  // the sequential smoothing calls used by the renderer.
  if (bucket.length < 2) bucket.push(buffer);
}

export function smoothFieldSeparable(
  field: Float32Array,
  width: number,
  height: number,
  radius: number,
  passes: number = 3,
  mask?: Uint8Array | null,
): Float32Array {
  if (radius <= 0 || passes <= 0) return field;
  let src = new Float32Array(field);
  const tmp = acquireSmoothingBuffer(width * height);
  const r = Math.max(
    1,
    Math.min(Math.floor(radius), Math.floor(Math.min(width, height) / 4)),
  );

  for (let p = 0; p < passes; p++) {
    // Horizontal pass
    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      let sum = 0;
      let count = 0;
      for (let k = -r; k <= r; k++) {
        const x = Math.max(0, Math.min(width - 1, k));
        const idx = rowOffset + x;
        if (!mask || mask[idx] > 0) {
          sum += src[idx];
          count++;
        }
      }
      for (let x = 0; x < width; x++) {
        const idx = rowOffset + x;
        tmp[idx] = count > 0 ? sum / count : src[idx];
        const xOut = Math.max(0, x - r);
        const xIn = Math.min(width - 1, x + r + 1);
        const idxOut = rowOffset + xOut;
        const idxIn = rowOffset + xIn;
        if (!mask || mask[idxOut] > 0) {
          sum -= src[idxOut];
          count--;
        }
        if (!mask || mask[idxIn] > 0) {
          sum += src[idxIn];
          count++;
        }
      }
    }

    // Vertical pass. Keep one accumulator per column but emit complete rows so
    // the large field is traversed linearly in memory. The masked count array
    // preserves the old zero-valid-samples fallback exactly.
    const sums = new Float64Array(width);
    const counts = mask ? new Int32Array(width) : undefined;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let k = -r; k <= r; k++) {
        const y = Math.max(0, Math.min(height - 1, k));
        const idx = y * width + x;
        if (!mask || mask[idx] > 0) {
          sum += tmp[idx];
          count++;
        }
      }
      sums[x] = sum;
      if (counts) counts[x] = count;
    }
    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        const count = counts ? counts[x] : 2 * r + 1;
        src[rowOffset + x] = count > 0 ? sums[x] / count : tmp[rowOffset + x];
      }
      const enteringRow = Math.min(height - 1, y + r + 1) * width;
      const leavingRow = Math.max(0, y - r) * width;
      for (let x = 0; x < width; x++) {
        const entering = enteringRow + x;
        const leaving = leavingRow + x;
        if (!mask || mask[leaving] > 0) {
          sums[x] -= tmp[leaving];
          if (counts) counts[x]--;
        }
        if (!mask || mask[entering] > 0) {
          sums[x] += tmp[entering];
          if (counts) counts[x]++;
        }
      }
    }
  }

  releaseSmoothingBuffer(tmp);
  return src;
}

/**
 * Smooths the distance field using Laplacian heat diffusion.
 * Specifically relaxes high-curvature Voronoi ridges and medial axis creases where
 * multiple coastal wave fronts collide, turning sharp V-corners into smooth, fluid curves.
 */
interface LaplacianStencil {
  activeIndices: Int32Array;
  northIndices: Int32Array;
  southIndices: Int32Array;
  westIndices: Int32Array;
  eastIndices: Int32Array;
}

function buildLaplacianStencil(
  isOcean: Uint8Array,
  width: number,
  height: number,
): LaplacianStencil {
  const totalCells = width * height;
  let activeCount = 0;
  for (let index = 0; index < totalCells; index++) {
    if (isOcean[index] !== 0) activeCount++;
  }
  const activeIndices = new Int32Array(activeCount);
  const northIndices = new Int32Array(activeCount);
  const southIndices = new Int32Array(activeCount);
  const westIndices = new Int32Array(activeCount);
  const eastIndices = new Int32Array(activeCount);
  let activeIndex = 0;
  for (let y = 0; y < height; y++) {
    const yC = y * width;
    const yN = Math.max(0, y - 1) * width;
    const yS = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) {
      const index = yC + x;
      if (isOcean[index] === 0) continue;
      activeIndices[activeIndex] = index;
      northIndices[activeIndex] = yN + x;
      southIndices[activeIndex] = yS + x;
      westIndices[activeIndex] = yC + Math.max(0, x - 1);
      eastIndices[activeIndex] = yC + Math.min(width - 1, x + 1);
      activeIndex++;
    }
  }
  return {
    activeIndices,
    northIndices,
    southIndices,
    westIndices,
    eastIndices,
  };
}

export function smoothDistanceFieldLaplacian(
  field: Float32Array,
  isOcean: Uint8Array,
  width: number,
  height: number,
  iterations: number = 80,
  dt: number = 0.22,
  stencil?: LaplacianStencil,
): Float32Array {
  let src = new Float32Array(field);
  // Ocean membership never changes during diffusion. Keep only those cells in
  // the hot loop and initialize both buffers with the source field so masked
  // cells retain the same values after every buffer swap.
  const totalCells = width * height;
  const resolvedStencil = stencil ?? buildLaplacianStencil(isOcean, width, height);
  const {
    activeIndices,
    northIndices,
    southIndices,
    westIndices,
    eastIndices,
  } = resolvedStencil;
  const activeCount = activeIndices.length;
  let dst = new Float32Array(totalCells);
  dst.set(field.subarray(0, totalCells));

  for (let iter = 0; iter < iterations; iter++) {
    for (let active = 0; active < activeCount; active++) {
      const idx = activeIndices[active];
      if (src[idx] <= 1.2) {
        dst[idx] = src[idx];
        continue;
      }

      const valC = src[idx];
      const valN = src[northIndices[active]];
      const valS = src[southIndices[active]];
      const valW = src[westIndices[active]];
      const valE = src[eastIndices[active]];

      // 5-point discrete Laplace-Beltrami operator
      const laplacian = valN + valS + valW + valE - 4.0 * valC;
      dst[idx] = valC + dt * laplacian;
    }

    const tmp = src;
    src = dst;
    dst = tmp;
  }

  return src;
}

/** Smooth distance field using Gaussian-weighted box passes for hand-inked line quality. */
export function smoothDistanceField(
  field: Float32Array,
  width: number,
  height: number,
  passes: number,
): Float32Array {
  if (passes <= 0) return field;
  let src = new Float32Array(field);
  let dst = new Float32Array(width * height);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - 1) * width;
      const y1 = y * width;
      const y2 = Math.min(height - 1, y + 1) * width;
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - 1);
        const x1 = x;
        const x2 = Math.min(width - 1, x + 1);
        dst[y1 + x1] =
          (src[y0 + x0] +
            src[y0 + x1] * 2 +
            src[y0 + x2] +
            src[y1 + x0] * 2 +
            src[y1 + x1] * 4 +
            src[y1 + x2] * 2 +
            src[y2 + x0] +
            src[y2 + x1] * 2 +
            src[y2 + x2]) /
          16.0;
      }
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  return src;
}

/**
 * Computes the wave front tangent vector perpendicular to the local gradient of
 * the continuous wave field, guaranteeing lines are drawn precisely along the wave ridges.
 */
function getWaveFieldTangentAt(
  waveField: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): { tx: number; ty: number; valid: boolean } {
  const ix = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const iy = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const xW = Math.max(0, ix - 1);
  const xE = Math.min(width - 1, ix + 1);
  const yN = Math.max(0, iy - 1);
  const yS = Math.min(height - 1, iy + 1);

  const ddx =
    (waveField[iy * width + xE] - waveField[iy * width + xW]) / (xE - xW || 1);
  const ddy =
    (waveField[yS * width + ix] - waveField[yN * width + ix]) / (yS - yN || 1);
  const gradLen = Math.hypot(ddx, ddy);
  if (gradLen < 1e-4) {
    return { tx: 1, ty: 0, valid: false };
  }
  return {
    tx: -ddy / gradLen,
    ty: ddx / gradLen,
    valid: true,
  };
}

export interface OceanLineRenderParams {
  rippleCount: number;
  coastalDensity: number;
  coastalLength: number;
  waveThickness?: number;
  deepOceanEnabled: boolean;
  deepOceanDensity: number;
  deepOceanLength: number;
  deepOceanMinDist: number;
  waveOpacity: number;
  smoothing: number;
  seed: number;
  waveField?: Float32Array;
  pixelScale?: number;
  coordinateOffsetX?: number;
  coordinateOffsetY?: number;
  coordinateStride?: number;
  /** Global maximum shoreline distance for tile-stable nonlinear bands. */
  distanceNormalizationMax?: number;
  /** Only pixels inside this window are painted by the offshore wave pass. */
  paintWindow?: WaterPaintWindow;
  /** Number of coastal bands before offshore orientation begins to relax. */
  coastalTransitionBands?: number;
  deepOceanWaveShadingScale?: number;
  deepOceanWaveShadingIntensity?: number;
}

const OCEAN_RIPPLE_BANDS: readonly number[] = [
  2.2, 10.0, 24.0, 44.0, 72.0, 108.0, 152.0, 204.0, 264.0, 332.0, 408.0, 492.0,
];
const COAST_WAVE_MAX_RANGE = 520.0;
// Coastal marks use one larger base length across every contour band. The
// user-controlled coastal length multiplier remains active, but band index no
// longer makes the inner wave marks disproportionately short.
const COASTAL_MARK_BASE_LENGTH = 18.0;
const COASTAL_MARK_BAND_GROWTH = 0.12;
const RIVER_CHARCOAL_BANK_CLEARANCE_FACTOR = 3.0;

type WaveSeed = {
  x: number;
  y: number;
  strength?: number;
  lambda?: number;
  maxRadius?: number;
};

interface OceanWavePathPoint {
  x: number;
  y: number;
  along: number;
  shoreNormalX: number;
  shoreNormalY: number;
  coastDistance: number;
}

interface OceanLineMarksResult {
  alpha: Uint8Array;
  tone: Uint8Array;
  lightAlpha?: Uint8Array;
  shadowAlpha?: Uint8Array;
  foamAlpha?: Uint8Array;
  inkAlpha?: Uint8Array;
}

function sampleSmoothWaveNoise(seed: number, coordinate: number): number {
  const lattice = Math.floor(coordinate);
  const t = smoothstep(0, 1, coordinate - lattice);
  const a = hash01(seed + lattice * 374761393, 6689) * 2 - 1;
  const b = hash01(seed + (lattice + 1) * 374761393, 6689) * 2 - 1;
  return a + (b - a) * t;
}

function sampleCoastDistanceGradient(
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): { x: number; y: number; strength: number } {
  const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
  const x0 = Math.max(0, ix - 2);
  const x1 = Math.min(width - 1, ix + 2);
  const y0 = Math.max(0, iy - 2);
  const y1 = Math.min(height - 1, iy + 2);
  const gx =
    (distanceToCoast[iy * width + x1] - distanceToCoast[iy * width + x0]) /
    Math.max(1, x1 - x0);
  const gy =
    (distanceToCoast[y1 * width + ix] - distanceToCoast[y0 * width + ix]) /
    Math.max(1, y1 - y0);
  return { x: gx, y: gy, strength: Math.hypot(gx, gy) };
}

function prepareOceanWavePath(
  samples: Array<{ x: number; y: number; along: number }>,
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  seed: number,
  markScale: number,
  smoothing: number,
  inheritedNormal?: { x: number; y: number },
): OceanWavePathPoint[] {
  const path: OceanWavePathPoint[] = [];
  let previousNormal = inheritedNormal;
  const fineStrength = 1 / (1 + Math.max(0, smoothing) * 0.25);
  for (let i = 0; i < samples.length; i++) {
    const current = samples[i];
    const previous = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(samples.length - 1, i + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    let nx = -dy / length;
    let ny = dx / length;
    const gradient = sampleCoastDistanceGradient(
      distanceToCoast, width, height, current.x, current.y,
    );
    if (previousNormal) {
      if (nx * previousNormal.x + ny * previousNormal.y < 0) {
        nx *= -1;
        ny *= -1;
      }
      if (gradient.strength > 0.08) {
        const dot = nx * gradient.x + ny * gradient.y;
        if (dot < -0.16 * gradient.strength) {
          const candidateX = -nx;
          const candidateY = -ny;
          // Retain side continuity around ambiguous coast-distance saddles.
          if (candidateX * previousNormal.x + candidateY * previousNormal.y > 0.15) {
            nx = candidateX;
            ny = candidateY;
          }
        }
      }
    } else if (gradient.strength > 0.08) {
      if (nx * gradient.x + ny * gradient.y < 0) {
        nx *= -1;
        ny *= -1;
      }
    } else if (hash01(seed, 907) < 0.5) {
      nx *= -1;
      ny *= -1;
    }
    previousNormal = { x: nx, y: ny };
    const endpointDistance = Math.min(i, samples.length - 1 - i) * 0.45;
    const endpointFade = smoothstep(0, 5 * markScale, endpointDistance);
    const broad = sampleSmoothWaveNoise(seed + 401, current.along / (8 * markScale));
    const fine = sampleSmoothWaveNoise(seed + 733, current.along / (2.3 * markScale));
    const offset = (2.2 * broad + 0.55 * fine * fineStrength) * markScale * endpointFade;
    const x = current.x + nx * offset;
    const y = current.y + ny * offset;
    const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
    path.push({
      x, y, along: current.along,
      shoreNormalX: nx,
      shoreNormalY: ny,
      coastDistance: distanceToCoast[iy * width + ix],
    });
  }
  return path;
}

function makeOceanWaveFork(
  path: OceanWavePathPoint[],
  seed: number,
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  markScale: number,
): OceanWavePathPoint[] | undefined {
  if (path.length < 20 || hash01(seed, 271) > 0.16) return undefined;
  const start = Math.floor(path.length * (0.18 + hash01(seed, 281) * 0.48));
  const end = Math.min(
    path.length - 1,
    start + Math.max(10, Math.floor(path.length * (0.24 + hash01(seed, 283) * 0.2))),
  );
  if (end - start < 8) return undefined;
  const side = hash01(seed, 293) < 0.5 ? -1 : 1;
  const amplitude = (2.6 + hash01(seed, 307) * 2.2) * markScale;
  const samples: Array<{ x: number; y: number; along: number }> = [];
  for (let i = start; i <= end; i++) {
    const parent = path[i];
    const t = (i - start) / (end - start);
    const envelope = Math.sin(Math.PI * t) ** 2;
    const depthFade = smoothstep(12 * markScale, 34 * markScale, parent.coastDistance);
    const offset = side * amplitude * envelope * depthFade;
    samples.push({
      x: parent.x + parent.shoreNormalX * offset,
      y: parent.y + parent.shoreNormalY * offset,
      along: parent.along,
    });
  }
  return prepareOceanWavePath(
    samples, distanceToCoast, width, height, seed + 1709, markScale, 0,
    { x: path[start].shoreNormalX, y: path[start].shoreNormalY },
  );
}

function waveFoamCoverage(seed: number, along: number, markScale: number): number {
  const clusters = sampleSmoothWaveNoise(seed + 991, along / (9 * markScale));
  const fragments = sampleSmoothWaveNoise(seed + 1297, along / (2.4 * markScale));
  return smoothstep(0.12, 0.55, clusters) *
    (0.48 + 0.52 * smoothstep(-0.4, 0.4, fragments));
}

function waveInkCoverage(seed: number, along: number, markScale: number): number {
  const interruptions = sampleSmoothWaveNoise(seed + 2857, along / (16 * markScale));
  const texture = sampleSmoothWaveNoise(seed + 2903, along / (3.8 * markScale));
  return smoothstep(-0.45, 0.2, interruptions) *
    (0.5 + 0.5 * smoothstep(-0.35, 0.45, texture));
}

function findOceanWavePointAt(
  path: OceanWavePathPoint[],
  along: number,
): OceanWavePathPoint {
  let low = 0;
  let high = path.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (path[middle].along < along) low = middle;
    else high = middle;
  }
  return Math.abs(path[low].along - along) <= Math.abs(path[high].along - along)
    ? path[low]
    : path[high];
}

function paintTaperedOceanFoam(
  alpha: Uint8Array,
  oceanClip: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  strength: number,
  seed: number,
  markScale: number,
  offsetX: number,
  offsetY: number,
  coordinateStride: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy || 1;
  const reach = radius + 1.5 * markScale;
  for (let y = Math.max(0, Math.floor(Math.min(y0, y1) - reach));
    y <= Math.min(height - 1, Math.ceil(Math.max(y0, y1) + reach)); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(x0, x1) - reach));
      x <= Math.min(width - 1, Math.ceil(Math.max(x0, x1) + reach)); x++) {
      const index = y * width + x;
      if (oceanClip[index] === 0) continue;
      const t = clamp01(((x - x0) * dx + (y - y0) * dy) / lengthSquared);
      const cross = Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t));
      const globalIndex =
        Math.floor(y + offsetY) * coordinateStride + Math.floor(x + offsetX);
      const rough = (hash01(Math.imul(globalIndex, 13) + seed, 541) - 0.5) * 0.5;
      const localRadius = radius * (0.82 + rough);
      if (cross >= localRadius) continue;
      const taper = smoothstep(0, 0.24, t) * smoothstep(0, 0.24, 1 - t);
      const edge = clamp01((localRadius - cross) / Math.max(0.4, markScale));
      alpha[index] = Math.max(alpha[index], Math.round(strength * taper * edge * 255));
    }
  }
}

function paintOceanWaveInkDot(
  alpha: Uint8Array,
  oceanClip: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
  strength: number,
  seed: number,
  offsetX: number,
  offsetY: number,
  coordinateStride: number,
): void {
  for (let y = Math.max(0, Math.floor(centerY - radius - 1));
    y <= Math.min(height - 1, Math.ceil(centerY + radius + 1)); y++) {
    for (let x = Math.max(0, Math.floor(centerX - radius - 1));
      x <= Math.min(width - 1, Math.ceil(centerX + radius + 1)); x++) {
      const index = y * width + x;
      if (oceanClip[index] === 0) continue;
      const globalIndex =
        Math.floor(y + offsetY) * coordinateStride + Math.floor(x + offsetX);
      const localRadius = radius * (0.9 + hash01(Math.imul(globalIndex, 11) + seed, 2957) * 0.16);
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance >= localRadius) continue;
      const edge = 1 - smoothstep(localRadius * 0.52, localRadius, distance);
      alpha[index] = Math.max(alpha[index], Math.round(clamp01(strength * edge) * 255));
    }
  }
}

function paintOceanWavePath(
  path: OceanWavePathPoint[],
  alpha: Uint8Array,
  tone: Uint8Array,
  lightAlpha: Uint8Array,
  shadowAlpha: Uint8Array,
  foamAlpha: Uint8Array,
  inkAlpha: Uint8Array,
  oceanClip: Uint8Array,
  width: number,
  height: number,
  seed: number,
  markScale: number,
  waveThickness: number,
  shadingScale: number,
  shadingIntensity: number,
  smoothing: number,
  coordinateOffsetX: number,
  coordinateOffsetY: number,
  coordinateStride: number,
  window?: WaterPaintWindow,
): void {
  if (path.length < 2) return;
  const windowX0 = Math.max(0, window?.x0 ?? 0);
  const windowY0 = Math.max(0, window?.y0 ?? 0);
  const windowX1 = Math.min(width, window?.x1 ?? width);
  const windowY1 = Math.min(height, window?.y1 ?? height);
  const softScale = 1 / (1 + Math.max(0, smoothing) * 0.2);
  const pathLength = Math.max(0, path[path.length - 1].along - path[0].along);
  const shadingFadeLength = Math.min(
    pathLength * 0.48,
    Math.max(12 * markScale, pathLength * 0.34),
  );
  const ridgeWidth = Math.max(0.45 * markScale, waveThickness * 0.52);
  const inkWidth = Math.max(0.65 * markScale, waveThickness * 0.5);
  const shadowBase = Math.max(2.5 * markScale, waveThickness * 2.7);
  const lightBase = Math.max(2.2 * markScale, waveThickness * 2.2);
  const bandScale = Math.max(0.25, shadingScale * 1.9);
  const maxReach = Math.max(
    shadowBase * bandScale + 3.2 * markScale * bandScale,
    lightBase * bandScale + 2.8 * markScale * bandScale,
  ) + 1.15 * markScale * bandScale;
  // Nothing is painted beyond the widest band a pixel's turbulence can reach
  // (|texture| <= 1, broad noise in [-1, 1]); skip those before sampling noise.
  const acrossLimit = Math.max(
    shadowBase * bandScale + 3.3 * markScale * bandScale,
    lightBase * bandScale + 2.7 * markScale * bandScale,
  ) + 1.15 * markScale * bandScale;
  // Samples are 0.45px apart while each segment shades 1×markScale past its
  // ends, so at export scale every pixel of the wide shading bands was shaded
  // ~19 times. Shade those bands from every floor(markScale)-th sample (the
  // preview's overlap), and draw the thin ridge/ink/foam marks from every
  // sample in a separate narrow pass so their edges stay exactly as before.
  const shadingStride = Math.max(1, Math.floor(markScale));
  const marksReach = Math.max(ridgeWidth, inkWidth, 0.5 * markScale, waveThickness * 1.02);
  const passes = shadingStride === 1
    ? [{ points: path, shading: true, marks: true, limit: acrossLimit, reach: maxReach }]
    : [
        {
          points: path.filter((_, index) => index % shadingStride === 0 || index === path.length - 1),
          shading: true, marks: false, limit: acrossLimit, reach: maxReach,
        },
        // Keep the full reach: `across` follows the interpolated shore normal,
        // which can be rotated against the segment, so a mark pixel is not
        // necessarily geometrically near it.
        { points: path, shading: false, marks: true, limit: marksReach, reach: maxReach },
      ];

  for (const pass of passes) for (let segment = 0; segment < pass.points.length - 1; segment++) {
    const a = pass.points[segment];
    const b = pass.points[segment + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy || 1;
    const segmentLength = Math.sqrt(lengthSquared);
    let reach = pass.reach + 1.5 * markScale;
    if (!pass.shading) {
      // Bound the thin marks even when the shore normal is tilted against
      // the segment. Same-sign endpoint cross products bound every normalized
      // interpolated normal; add the end-cap allowance before dividing.
      const crossA = (dx * a.shoreNormalY - dy * a.shoreNormalX) / segmentLength;
      const crossB = (dx * b.shoreNormalY - dy * b.shoreNormalX) / segmentLength;
      if (crossA * crossB > 0) {
        const normalMax = Math.max(Math.hypot(a.shoreNormalX, a.shoreNormalY),
          Math.hypot(b.shoreNormalX, b.shoreNormalY));
        const alignment = Math.min(Math.abs(crossA), Math.abs(crossB)) / normalMax;
        reach = Math.min(reach, (pass.limit + markScale) / alignment + markScale + 1);
      }
    }
    const capProjection = markScale * segmentLength;
    const minX = Math.max(windowX0, Math.floor(Math.min(a.x, b.x) - reach));
    const maxX = Math.min(windowX1 - 1, Math.ceil(Math.max(a.x, b.x) + reach));
    if (maxX < minX) continue;
    for (let y = Math.max(windowY0, Math.floor(Math.min(a.y, b.y) - reach));
      y <= Math.min(windowY1 - 1, Math.ceil(Math.max(a.y, b.y) + reach)); y++) {
      // Intersect each scanline with the segment's short end caps before
      // visiting pixels. Most of the expanded rectangle lies beyond them.
      const rowProjection = (y - a.y) * dy;
      let rowMinX = minX;
      let rowMaxX = maxX;
      if (dx !== 0) {
        const capStart = a.x + (-capProjection - rowProjection) / dx;
        const capEnd = a.x + (lengthSquared + capProjection - rowProjection) / dx;
        // Round outward; the original pixel test handles boundary precision.
        rowMinX = Math.max(minX, Math.floor(Math.min(capStart, capEnd)));
        rowMaxX = Math.min(maxX, Math.ceil(Math.max(capStart, capEnd)));
      } else if (rowProjection < -capProjection || rowProjection > lengthSquared + capProjection) {
        continue;
      }
      for (let x = rowMinX; x <= rowMaxX; x++) {
        const index = y * width + x;
        if (oceanClip[index] === 0) continue;
        const rawT = ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared;
        const t = clamp01(rawT);
        const beyondSegment = Math.abs(rawT - t) * segmentLength;
        // A short subpixel extension keeps adjacent samples joined without
        // letting every tiny segment cast a long rectangular cap.
        if (beyondSegment > 1.0 * markScale) continue;
        const centerX = a.x + dx * t;
        const centerY = a.y + dy * t;
        const rawNx = a.shoreNormalX + (b.shoreNormalX - a.shoreNormalX) * t;
        const rawNy = a.shoreNormalY + (b.shoreNormalY - a.shoreNormalY) * t;
        const normalLength = Math.hypot(rawNx, rawNy) || 1;
        const nx = rawNx / normalLength;
        const ny = rawNy / normalLength;
        const across = (x - centerX) * nx + (y - centerY) * ny;
        const acrossMagnitude = Math.abs(across);
        if (acrossMagnitude >= pass.limit) continue;
        const along = a.along + (b.along - a.along) * t;
        const endpointDistance = Math.min(
          along - path[0].along,
          path[path.length - 1].along - along,
        );
        const endpointFade = smoothstep(0, 3.5 * markScale, endpointDistance);
        if (pass.shading && endpointDistance > 0 && shadingIntensity > 0) {
          const shadingEndpointFade = smoothstep(
            0,
            shadingFadeLength,
            endpointDistance,
          );
          const broad = sampleSmoothWaveNoise(seed + 1601, along / (11 * markScale));
          const tangentX = ny;
          const tangentY = -nx;
          const globalX = x + coordinateOffsetX;
          const globalY = y + coordinateOffsetY;
          const noiseAlong = (globalX * tangentX + globalY * tangentY) /
            (25 * markScale);
          const noiseAcross = (globalX * nx + globalY * ny) /
            (16 * markScale);
          const broadTexture =
            (sampleWetlandValueNoise(noiseAlong, noiseAcross, seed + 1877, 547) - 0.5) * 2;
          const fineTexture =
            (sampleWetlandValueNoise(
              noiseAlong * 3.0,
              noiseAcross * 2.8,
              seed + 1999,
              557,
            ) - 0.5) * 2;
          const turbulence = broadTexture * 0.68 + fineTexture * 0.32;
          const edgeNoise = turbulence;
          const turbulentAcross = across +
            turbulence * 1.15 * markScale * bandScale;
          const shadowTexture = clamp01(0.58 + broadTexture * 0.45 + fineTexture * 0.2);
          const lightTexture = clamp01(0.58 - broadTexture * 0.42 - fineTexture * 0.15);
          const shadingStrength =
            (0.78 + 0.22 * (broad + 1) * 0.5) * shadingEndpointFade * softScale;
          const shadowWidth = shadowBase * bandScale +
            ((0.5 + 0.5 * broad) * 2.3 + edgeNoise * 1.0) * markScale * bandScale;
          const lightWidth = lightBase * bandScale +
            ((0.5 + 0.5 * broad) * 1.8 + edgeNoise * 0.9) * markScale * bandScale;

          const ridgeGap = 0.24 * markScale;
          if (turbulentAcross > ridgeGap && turbulentAcross < shadowWidth) {
            const shadowCenter = shadowWidth * 0.52;
            const shadowSigma = Math.max(0.8 * markScale, shadowWidth * 0.27);
            const startFade = smoothstep(
              ridgeGap, ridgeGap + 0.75 * markScale, turbulentAcross,
            );
            const outerFade = 1 - smoothstep(
              shadowWidth * 0.56,
              shadowWidth,
              turbulentAcross,
            );
            const profile = Math.exp(-0.5 * ((turbulentAcross - shadowCenter) / shadowSigma) ** 2);
            const coverage = shadingStrength * startFade * outerFade * profile *
              (0.28 + 0.1 * (broad + 1) * 0.5) * shadowTexture * shadingIntensity;
            shadowAlpha[index] = Math.max(shadowAlpha[index], Math.round(clamp01(coverage) * 255));
          }
          if (turbulentAcross < -ridgeGap && turbulentAcross > -lightWidth) {
            const shoreward = -turbulentAcross;
            const lightCenter = lightWidth * 0.5;
            const lightSigma = Math.max(0.8 * markScale, lightWidth * 0.29);
            const startFade = smoothstep(ridgeGap, ridgeGap + 0.75 * markScale, shoreward);
            const outerFade = 1 - smoothstep(
              lightWidth * 0.56,
              lightWidth,
              shoreward,
            );
            const profile = Math.exp(-0.5 * ((shoreward - lightCenter) / lightSigma) ** 2);
            const coverage = shadingStrength * startFade * outerFade * profile *
              (0.27 + 0.1 * (broad + 1) * 0.5) * lightTexture * shadingIntensity;
            lightAlpha[index] = Math.max(lightAlpha[index], Math.round(clamp01(coverage) * 255));
          }
        }
        if (!pass.marks || acrossMagnitude >= marksReach) continue;

        const ripple = sampleSmoothWaveNoise(seed + 2017, along / (2.8 * markScale));
        const ridgeEdge = 1 - smoothstep(ridgeWidth * 0.45, ridgeWidth, acrossMagnitude);
        const ridge = ridgeEdge * endpointFade * (0.18 + 0.08 * (ripple + 1) * 0.5);
        if (ridge > 0.01) {
          alpha[index] = Math.max(alpha[index], Math.round(ridge * 255));
          tone[index] = Math.max(tone[index], Math.round(82 + 38 * (ripple + 1) * 0.5));
        }

        if (acrossMagnitude < inkWidth && endpointFade > 0) {
          const inkEdge = 1 - smoothstep(inkWidth * 0.38, inkWidth, acrossMagnitude);
          const ink = inkEdge * endpointFade * waveInkCoverage(seed, along, markScale) * 0.9;
          if (ink > 0.012) {
            inkAlpha[index] = Math.max(inkAlpha[index], Math.round(clamp01(ink) * 255));
          }
        }

        const cluster = waveFoamCoverage(seed, along, markScale);
        const foamWidth = Math.max(0.5 * markScale, waveThickness * (0.48 + 0.27 * (ripple + 1)));
        const foamEdge = 1 - smoothstep(foamWidth * 0.45, foamWidth, acrossMagnitude);
        const foam = cluster * foamEdge * endpointFade * 0.82;
        if (foam > 0.015) foamAlpha[index] = Math.max(foamAlpha[index], Math.round(foam * 255));
      }
    }
  }

  // Sparse, nearby fragments share the ridge direction and global slot seed.
  const spacing = 5.5 * markScale;
  for (let slot = Math.ceil(path[0].along / spacing);
    slot <= Math.floor(path[path.length - 1].along / spacing); slot++) {
    const along = slot * spacing;
    const closest = findOceanWavePointAt(path, along);
    const cluster = waveFoamCoverage(seed, along, markScale);
    const slotSeed = seed + slot * 17431;
    if (cluster < 0.48 || hash01(slotSeed, 2029) > 0.22) continue;
    const side = hash01(slotSeed, 2039) < 0.5 ? -1 : 1;
    const offset = side * (0.9 + hash01(slotSeed, 2053) * 1.5) * markScale;
    const length = (1.4 + hash01(slotSeed, 2063) * 2.8) * markScale;
    const tx = closest.shoreNormalY;
    const ty = -closest.shoreNormalX;
    const cx = closest.x + closest.shoreNormalX * offset;
    const cy = closest.y + closest.shoreNormalY * offset;
    paintTaperedOceanFoam(
      foamAlpha, oceanClip, width, height,
      cx - tx * length * 0.5, cy - ty * length * 0.5,
      cx + tx * length * 0.5, cy + ty * length * 0.5,
      (0.38 + hash01(slotSeed, 2081) * 0.35) * markScale,
      cluster * 0.48, slotSeed, markScale,
      coordinateOffsetX, coordinateOffsetY, coordinateStride,
    );
  }

  // Occasional map-ink dots sit beside the ridge and continue its direction.
  const inkDotSpacing = 4.4 * markScale;
  for (let slot = Math.ceil(path[0].along / inkDotSpacing);
    slot <= Math.floor(path[path.length - 1].along / inkDotSpacing); slot++) {
    const slotSeed = seed + slot * 23197;
    if (hash01(slotSeed, 2963) > 0.16) continue;
    const along = slot * inkDotSpacing;
    const closest = findOceanWavePointAt(path, along);
    const side = hash01(slotSeed, 2971) < 0.5 ? -1 : 1;
    const offset = side * (0.2 + hash01(slotSeed, 2999) * 0.65) * markScale;
    const centerX = closest.x + closest.shoreNormalX * offset;
    const centerY = closest.y + closest.shoreNormalY * offset;
    paintOceanWaveInkDot(
      inkAlpha,
      oceanClip,
      width,
      height,
      centerX,
      centerY,
      (0.95 + hash01(slotSeed, 3011) * 0.4) * markScale,
      0.5 + hash01(slotSeed, 3023) * 0.18,
      slotSeed,
      coordinateOffsetX,
      coordinateOffsetY,
      coordinateStride,
    );
  }
}

function softenOceanWaveBand(
  alpha: Uint8Array,
  oceanClip: Uint8Array,
  width: number,
  height: number,
  markScale: number,
): void {
  const field = new Float32Array(alpha.length);
  for (let index = 0; index < alpha.length; index++) {
    field[index] = alpha[index] / 255;
  }
  const softened = smoothFieldSeparable(
    field,
    width,
    height,
    Math.max(1, 1.25 * markScale),
    2,
    oceanClip,
  );
  for (let index = 0; index < alpha.length; index++) {
    alpha[index] = oceanClip[index] === 1
      ? Math.round(clamp01(softened[index]) * 255)
      : 0;
  }
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3.0 - 2.0 * t);
}

function wavePropagationWeight(
  distance: number,
  wavelength: number,
  maxRadius: number,
): number {
  const fade = 1.0 - smoothstep(maxRadius * 0.72, maxRadius, distance);
  return (
    fade * (0.35 + 0.65 * Math.exp(-distance / Math.max(1, wavelength * 5.0)))
  );
}

interface CoastWaveEmitter {
  x: number;
  y: number;
  nx: number;
  ny: number;
  angle: number;
  wavelength: number;
  phase: number;
  maxReach: number;
}

/**
 * Extracts representative coastal wave emitters distributed along the land/ocean
 * boundary. Each coastal segment with a distinct orientation/angle emits its own
 * wave train outward into the ocean, allowing wave fronts from different angles to
 * cross and overlap naturally.
 */
function extractCoastalWaveEmitters(
  cleanWaterMask: Uint8Array,
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  flowLength: number,
  seed: number,
): CoastWaveEmitter[] {
  const emitters: CoastWaveEmitter[] = [];
  const coastPoints: Array<{
    x: number;
    y: number;
    nx: number;
    ny: number;
    angle: number;
  }> = [];

  for (let y = 1; y < height - 1; y++) {
    const yOffset = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = yOffset + x;
      if (cleanWaterMask[idx] !== 1) continue;

      const isCoastEdge =
        cleanWaterMask[idx - 1] === 0 ||
        cleanWaterMask[idx + 1] === 0 ||
        cleanWaterMask[idx - width] === 0 ||
        cleanWaterMask[idx + width] === 0;

      if (!isCoastEdge) continue;

      const ddx =
        (distanceToCoast[yOffset + x + 1] - distanceToCoast[yOffset + x - 1]) *
        0.5;
      const ddy =
        (distanceToCoast[(y + 1) * width + x] -
          distanceToCoast[(y - 1) * width + x]) *
        0.5;
      const len = Math.hypot(ddx, ddy);
      if (len < 1e-3) continue;

      const nx = ddx / len;
      const ny = ddy / len;
      const angle = Math.atan2(ny, nx);
      coastPoints.push({ x, y, nx, ny, angle });
    }
  }

  if (coastPoints.length === 0) return [];

  const minSpacing = Math.max(16, Math.min(width, height) * 0.035);
  const shuffledIndices = Array.from(
    { length: coastPoints.length },
    (_, i) => i,
  );
  for (let i = shuffledIndices.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(seed + i * 19, 733) * (i + 1));
    const tmp = shuffledIndices[i];
    shuffledIndices[i] = shuffledIndices[j];
    shuffledIndices[j] = tmp;
  }

  const maxEmitters = 18;
  for (const idx of shuffledIndices) {
    if (emitters.length >= maxEmitters) break;
    const pt = coastPoints[idx];

    let tooClose = false;
    for (const em of emitters) {
      const dist = Math.hypot(pt.x - em.x, pt.y - em.y);
      const angleDiff = Math.abs(pt.angle - em.angle);
      const wrappedDiff = Math.min(angleDiff, Math.PI * 2 - angleDiff);

      if (dist < minSpacing * 0.7) {
        tooClose = true;
        break;
      }
      if (dist < minSpacing * 1.5 && wrappedDiff < 0.35) {
        tooClose = true;
        break;
      }
    }

    if (tooClose) continue;

    const eSeed = seed + emitters.length * 131;
    const wavelength =
      (22.0 + hash01(eSeed, 409) * 12.0) * Math.max(0.6, flowLength * 0.75);
    const phase = hash01(eSeed, 419) * Math.PI * 2.0;
    const maxReach = Math.max(
      180,
      Math.max(width, height) * (0.6 + hash01(eSeed, 431) * 0.35),
    );

    emitters.push({
      x: pt.x,
      y: pt.y,
      nx: pt.nx,
      ny: pt.ny,
      angle: pt.angle,
      wavelength,
      phase,
      maxReach,
    });
  }

  return emitters;
}

/**
 * Builds a clean, high-clarity wave field where parallel coastal wave fronts clearly
 * dominate and win out along all shorelines and ocean approaches, modulated with a
 * subtle coherent crossing swell offshore for organic interference without chaos.
 */
function buildCoastWaveField(
  isOcean: Uint8Array,
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  flowLength: number,
  seed: number,
  coordinateOffsetX = 0,
  coordinateOffsetY = 0,
  pixelScale = 1,
): Float32Array {
  const field = new Float32Array(width * height);
  const markScale = Math.max(0.25, pixelScale);
  const maxRange =
    COAST_WAVE_MAX_RANGE * Math.max(0.5 * markScale, flowLength);
  const wavelength = 28.0 * Math.max(0.6 * markScale, flowLength);
  const phase = hash01(seed, 431) * Math.PI * 2.0;

  const angPhase1 = hash01(seed, 503) * Math.PI * 2.0;
  const angPhase2 = hash01(seed, 509) * Math.PI * 2.0;

  for (let y = 0; y < height; y++) {
    const yOffset = y * width;

    for (let x = 0; x < width; x++) {
      const index = yOffset + x;
      if (isOcean[index] === 0) continue;

      const dist = distanceToCoast[index];
      if (dist >= maxRange) continue;

      const rangeMask =
        1.0 - smoothstep(maxRange - 72.0 * markScale, maxRange, dist);
      if (rangeMask <= 0) continue;

      // Smooth continuous organic phase modulation without any gradient angle discontinuities
      const globalX = (x + coordinateOffsetX) / markScale;
      const globalY = (y + coordinateOffsetY) / markScale;
      const dPhase =
        0.35 * Math.sin(globalX * 0.035 + globalY * 0.022 + angPhase1) +
        0.2 * Math.cos(globalX * 0.022 - globalY * 0.035 + angPhase2);

      // Dominant parallel coastal wave front (pure smooth sinusoidal wavefront)
      const primaryCoastWave =
        0.5 -
        0.5 * Math.cos((Math.PI * 2.0 * dist) / wavelength + phase + dPhase);

      field[index] = rangeMask * primaryCoastWave;
    }
  }

  return smoothFieldSeparable(field, width, height, 4 * markScale, 2);
}

/**
 * Renders near-shore ink contours and offshore painted wave ridges. Offshore
 * paths use deterministic smooth scattering, occasional reconnecting forks,
 * directional water-color bands, and clustered crest foam.
 */
function paintOceanLineMarks(
  isOcean: Uint8Array,
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  params: OceanLineRenderParams,
): OceanLineMarksResult {
  const alpha = new Uint8Array(width * height);
  const tone = new Uint8Array(width * height);
  const lightAlpha = params.deepOceanEnabled ? new Uint8Array(width * height) : undefined;
  const shadowAlpha = params.deepOceanEnabled ? new Uint8Array(width * height) : undefined;
  const foamAlpha = params.deepOceanEnabled ? new Uint8Array(width * height) : undefined;
  const inkAlpha = params.deepOceanEnabled ? new Uint8Array(width * height) : undefined;
  const {
    rippleCount,
    coastalDensity,
    coastalLength,
    waveThickness = 1.0,
    deepOceanEnabled,
    deepOceanDensity,
    deepOceanLength,
    deepOceanMinDist,
    waveOpacity,
    smoothing,
    seed,
    pixelScale = 1,
    deepOceanWaveShadingScale = 4.5,
    deepOceanWaveShadingIntensity = 2.5,
    coordinateOffsetX = 0,
    coordinateOffsetY = 0,
    coordinateStride = width,
    distanceNormalizationMax,
    coastalTransitionBands = rippleCount,
  } = params;
  const markScale = Math.max(0.25, pixelScale);
  const stride = Math.max(1, Math.round(coordinateStride));
  // Waves painted outside the caller's window only feed the band blur below
  // (two box passes of radius floor(1.25 × markScale)); pad by that support.
  const blurSupport = 2 * Math.max(1, Math.floor(1.25 * markScale)) + 2;
  const waveWindow = params.paintWindow
    ? {
        x0: params.paintWindow.x0 - blurSupport,
        y0: params.paintWindow.y0 - blurSupport,
        x1: params.paintWindow.x1 + blurSupport,
        y1: params.paintWindow.y1 + blurSupport,
      }
    : undefined;

  if (waveOpacity <= 0) return { alpha, tone };

  const oceanClip = isOcean;

  // Spatial exclusion grid for Poisson-disc sampling across all ocean wave lines
  const minClearance = Math.max(
    7.0 * markScale,
    16.0 / Math.max(0.3, coastalDensity),
  );
  const cellSize = minClearance / Math.SQRT2;
  const gridW = Math.ceil(width / cellSize);
  const gridH = Math.ceil(height / cellSize);
  const poissonGrid = new Int32Array(gridW * gridH).fill(-1);
  const placedSeeds: Array<{
    x: number;
    y: number;
    rClearance: number;
    tx: number;
    ty: number;
    halfLength: number;
  }> = [];

  function isPoissonClear(
    x: number,
    y: number,
    rClearance: number,
    tx = 0,
    ty = 0,
    halfLength = 0,
  ): boolean {
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
    const checkRadius = Math.ceil(rClearance / cellSize);

    for (let dy = -checkRadius; dy <= checkRadius; dy++) {
      const ngy = gy + dy;
      if (ngy < 0 || ngy >= gridH) continue;
      for (let dx = -checkRadius; dx <= checkRadius; dx++) {
        const ngx = gx + dx;
        if (ngx < 0 || ngx >= gridW) continue;
        const neighborIdx = poissonGrid[ngy * gridW + ngx];
        if (neighborIdx >= 0) {
          const p = placedSeeds[neighborIdx];
          const reqDist = Math.max(rClearance, p.rClearance);
          if (halfLength > 0 && p.halfLength > 0) {
            const dx = x - p.x;
            const dy = y - p.y;
            const along = Math.abs(dx * tx + dy * ty);
            const across = Math.abs(dx * ty - dy * tx);
            if (
              along < halfLength + p.halfLength &&
              across < reqDist
            ) {
              return false;
            }
          }
          const dSq = (x - p.x) * (x - p.x) + (y - p.y) * (y - p.y);
          if (dSq < reqDist * reqDist) {
            return false;
          }
        }
      }
    }
    return true;
  }

  function registerPoissonSeed(
    x: number,
    y: number,
    rClearance: number,
    tx = 0,
    ty = 0,
    halfLength = 0,
  ): void {
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
    if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) {
      poissonGrid[gy * gridW + gx] = placedSeeds.length;
    }
    placedSeeds.push({ x, y, rClearance, tx, ty, halfLength });
  }

  // -------------------------------------------------------------------------
  // 1. Coastal Terrain Contour Wave Fronts (Poisson-Disc Sampled)
  // -------------------------------------------------------------------------
  if (coastalDensity > 0) {
    const numBands = Math.max(
      1,
      Math.min(OCEAN_RIPPLE_BANDS.length, Math.round(rippleCount)),
    );

    for (let bandIdx = 0; bandIdx < numBands; bandIdx++) {
      const targetDist = OCEAN_RIPPLE_BANDS[bandIdx] * markScale;
      const bandHalfWidth =
        (bandIdx === 0 ? 1.4 : Math.max(0.8, 0.6 + bandIdx * 0.15)) *
        markScale;
      const bandSpacing = Math.max(
        3.0 * markScale,
        (4.2 + bandIdx * 2.2) / Math.max(0.25, coastalDensity),
      );
      const bandClearance = Math.max(6.0 * markScale, bandSpacing * 0.78);
      const bandLengthScale = 1.0 + bandIdx * COASTAL_MARK_BAND_GROWTH;
      const markLength = Math.max(
        3.2 * markScale,
        COASTAL_MARK_BASE_LENGTH * coastalLength * bandLengthScale,
      );
      const baseInkRadius = 0.85;
      const inkRadius =
        Math.max(0.4, baseInkRadius - bandIdx * 0.04) * waveThickness;
      const stepGrid = Math.max(
        2,
        Math.round(Math.max(2 * markScale, bandSpacing * 0.6)),
      );

      const firstY = Math.max(
        1,
        Math.ceil((1 + coordinateOffsetY) / stepGrid) * stepGrid - coordinateOffsetY,
      );
      const firstX = Math.max(
        1,
        Math.ceil((1 + coordinateOffsetX) / stepGrid) * stepGrid - coordinateOffsetX,
      );
      for (let y = firstY; y < height - 1; y += stepGrid) {
        for (let x = firstX; x < width - 1; x += stepGrid) {
          const globalX = x + coordinateOffsetX;
          const globalY = y + coordinateOffsetY;
          // `isOcean` is the local tile clip mask. Keep the deterministic
          // random seed in global output coordinates, but never use that
          // global index to address the tile-sized array (which would make
          // every non-origin tile appear empty).
          const localSeedIndex = y * width + x;
          const seedIndex = globalY * stride + globalX;
          if (isOcean[localSeedIndex] === 0) continue;

          const jx = Math.max(
            1,
            Math.min(
              width - 2,
              x +
                Math.round(
                  (hash01(seedIndex, seed + 71) - 0.5) * (stepGrid - 1),
                ),
            ),
          );
          const jy = Math.max(
            1,
            Math.min(
              height - 2,
              y +
                Math.round(
                  (hash01(seedIndex, seed + 73) - 0.5) * (stepGrid - 1),
                ),
            ),
          );
          const idx = jy * width + jx;
          if (isOcean[idx] === 0) continue;

          const dist = distanceToCoast[idx];
          if (Math.abs(dist - targetDist) > bandHalfWidth) continue;

          // Poisson-disc non-overlap guarantee
          if (!isPoissonClear(jx, jy, bandClearance)) continue;

          const markSeed =
            bandIdx * 99991 +
            seed * 1013 +
            (jy + coordinateOffsetY) * stride +
            (jx + coordinateOffsetX);
          const expanseRatio = Math.min(
            1.0,
            Math.max(0.35, dist / (7.0 * markScale)),
          );
          if (hash01(markSeed, 131) > expanseRatio) continue;

          const toneValue = Math.round(18 + hash01(markSeed, 137) * 65);
          const effectiveMarkLength = markLength * (0.6 + 0.4 * expanseRatio);
          const effectiveInkRadius = Math.max(
            0.35,
            inkRadius * (0.8 + 0.2 * expanseRatio),
          );

          const { tx, ty, valid } = getContourTangentAt(
            distanceToCoast,
            width,
            height,
            jx,
            jy,
          );
          if (!valid) continue;
          if (
            !isPoissonClear(
              jx,
              jy,
              bandClearance,
              tx,
              ty,
              effectiveMarkLength * 0.5,
            )
          ) {
            continue;
          }
          registerPoissonSeed(
            jx,
            jy,
            bandClearance,
            tx,
            ty,
            effectiveMarkLength * 0.5,
          );

          const styleRoll = hash01(markSeed, 239);

          // Dot Stipple Archetype (12% probability in coastal bands: 10-15% range)
          if (styleRoll < 0.12) {
            const numDots = 1 + Math.floor(hash01(markSeed, 241) * 3);
            const dotSpacing =
              (3.5 + hash01(markSeed, 251) * 2.5) * markScale;
            for (let d = 0; d < numDots; d++) {
              const offset = (d - (numDots - 1) * 0.5) * dotSpacing;
              const px = jx + tx * offset;
              const py = jy + ty * offset;
              if (px >= 0 && px < width && py >= 0 && py < height) {
                paintInkDisk(
                  alpha,
                  tone,
                  oceanClip,
                  width,
                  height,
                  px,
                  py,
                  effectiveInkRadius * 0.88,
                  toneValue,
                  markSeed + d * 19,
                );
              }
            }
            continue;
          }

          // Continuous & Smooth Flowing Stroke with only occasional subtle micro-breaks
          const halfLen = effectiveMarkLength * 0.5;
          const numSteps = Math.max(2, Math.round(halfLen / 0.42));
          const stepSize = halfLen / numSteps;
          const interruption = createCharcoalInterruptionPattern(
            markSeed,
            markScale,
            {
              breakProbability: 0.15,
              dashMin: 16,
              dashMax: 40,
            },
          );

          // Forward stroke
          let curX = jx;
          let curY = jy;
          let prevTx = tx;
          let prevTy = ty;
          for (let s = 0; s < numSteps; s++) {
            const t = getContourTangentAt(
              distanceToCoast,
              width,
              height,
              curX,
              curY,
            );
            if (!t.valid) break;
            const dot = t.tx * prevTx + t.ty * prevTy;
            const dir = dot < 0 ? -1 : 1;
            const alignedTx = t.tx * dir;
            const alignedTy = t.ty * dir;
            const blendTx = prevTx * 0.5 + alignedTx * 0.5;
            const blendTy = prevTy * 0.5 + alignedTy * 0.5;
            const bLen = Math.hypot(blendTx, blendTy) || 1;
            const curTx = blendTx / bLen;
            const curTy = blendTy / bLen;
            prevTx = curTx;
            prevTy = curTy;

            const wobble =
              (hash01(markSeed + s * 37, 167) - 0.5) *
              ((0.22 * markScale) / (1 + smoothing));
            const nextX = curX + (curTx - curTy * wobble) * stepSize;
            const nextY = curY + (curTy + curTx * wobble) * stepSize;
            if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height)
              break;
            const nextIdx = Math.floor(nextY) * width + Math.floor(nextX);
            if (isOcean[nextIdx] === 0) break;

            const travelled = s * stepSize;
            if (isCharcoalInkActiveAtDistance(travelled, interruption)) {
              paintInkSegment(
                alpha,
                tone,
                oceanClip,
                width,
                height,
                curX,
                curY,
                nextX,
                nextY,
                effectiveInkRadius *
                  (0.88 + hash01(markSeed + s * 17, 169) * 0.25),
                toneValue,
                markSeed + s * 13,
                smoothing,
                s / numSteps,
                (s + 1) / numSteps,
                false,
                true,
              );
            } else if (hash01(markSeed + s * 23, 277) < 0.12) {
              paintInkDisk(
                alpha,
                tone,
                oceanClip,
                width,
                height,
                (curX + nextX) * 0.5,
                (curY + nextY) * 0.5,
                effectiveInkRadius * 0.75,
                toneValue,
                markSeed + s * 11,
              );
            }

            curX = nextX;
            curY = nextY;
          }

          // Backward stroke
          curX = jx;
          curY = jy;
          prevTx = tx;
          prevTy = ty;
          for (let s = 0; s < numSteps; s++) {
            const t = getContourTangentAt(
              distanceToCoast,
              width,
              height,
              curX,
              curY,
            );
            if (!t.valid) break;
            const dot = t.tx * prevTx + t.ty * prevTy;
            const dir = dot < 0 ? -1 : 1;
            const alignedTx = t.tx * dir;
            const alignedTy = t.ty * dir;
            const blendTx = prevTx * 0.5 + alignedTx * 0.5;
            const blendTy = prevTy * 0.5 + alignedTy * 0.5;
            const bLen = Math.hypot(blendTx, blendTy) || 1;
            const curTx = blendTx / bLen;
            const curTy = blendTy / bLen;
            prevTx = curTx;
            prevTy = curTy;

            const wobble =
              (hash01(markSeed + 101 + s * 43, 173) - 0.5) *
              ((0.22 * markScale) / (1 + smoothing));
            const nextX = curX - (curTx - curTy * wobble) * stepSize;
            const nextY = curY - (curTy + curTx * wobble) * stepSize;
            if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height)
              break;
            const nextIdx = Math.floor(nextY) * width + Math.floor(nextX);
            if (isOcean[nextIdx] === 0) break;

            const travelled = s * stepSize;
            if (isCharcoalInkActiveAtDistance(travelled, interruption)) {
              paintInkSegment(
                alpha,
                tone,
                oceanClip,
                width,
                height,
                curX,
                curY,
                nextX,
                nextY,
                effectiveInkRadius *
                  (0.88 + hash01(markSeed + 101 + s * 17, 179) * 0.25),
                toneValue,
                markSeed + 101 + s * 13,
                smoothing,
                s / numSteps,
                (s + 1) / numSteps,
                false,
                true,
              );
            } else if (hash01(markSeed + 101 + s * 23, 277) < 0.12) {
              paintInkDisk(
                alpha,
                tone,
                oceanClip,
                width,
                height,
                (curX + nextX) * 0.5,
                (curY + nextY) * 0.5,
                effectiveInkRadius * 0.75,
                toneValue,
                markSeed + 101 + s * 11,
              );
            }

            curX = nextX;
            curY = nextY;
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Feature-Aligned Offshore Contour Hatching (Poisson-Disc Sampled)
  // -------------------------------------------------------------------------
  if (deepOceanEnabled && deepOceanDensity > 0) {
    const wavelength = 28.0 * Math.max(0.6 * markScale, coastalLength);
    const deepSpacing = Math.max(
      5.0 * markScale,
      Math.round((7.2 / Math.max(0.12, Math.sqrt(deepOceanDensity))) * markScale),
    );
    const deepClearance = Math.max(10.0 * markScale, deepSpacing * 0.85);
    // Keep the paper-inspired distance layers, but give each offshore hatch
    // enough run to read as a deliberate cartographic stroke at preview scale.
    // The deep-ocean length control changes only the offshore family, leaving
    // the near-coast contour spacing and mark lengths independent.
    const markLength = Math.max(12.0 * markScale, 40.0 * deepOceanLength);
    // Deep-ocean lines retain the outline ink treatment, while their stroke
    // width can be tuned independently of the coast outline thickness.
    const deepMultiplier = Math.max(0.1, waveThickness);
    const inkRad = Math.max(0.35, 0.85 * deepMultiplier);
    let maxFiniteOceanDistance = Math.max(
      0,
      distanceNormalizationMax ?? 0,
    );
    let finiteOceanSamples = 0;
    for (let index = 0; index < isOcean.length; index++) {
      if (isOcean[index] !== 1) continue;
      const distance = distanceToCoast[index];
      if (distance >= 1e5) continue;
      finiteOceanSamples++;
      if (distance > maxFiniteOceanDistance) {
        maxFiniteOceanDistance = distance;
      }
    }
    const hasFeatureDistance =
      (finiteOceanSamples > 0 || (distanceNormalizationMax ?? 0) > 0) &&
      maxFiniteOceanDistance > deepOceanMinDist + 1;
    const featureDistanceSpan = Math.max(
      1,
      maxFiniteOceanDistance - deepOceanMinDist,
    );
    // A power-law band coordinate is the discrete version of the paper's
    // non-linear step function: bands are close near shore and spread toward
    // the medial axis instead of repeating at one fixed wavelength.
    const contourBandCount = hasFeatureDistance
      ? Math.max(
          4,
          Math.ceil(featureDistanceSpan / (28.0 * markScale)),
        )
      : 0;

    const firstDeepY = Math.max(
      2,
      Math.ceil((2 + coordinateOffsetY) / deepSpacing) * deepSpacing - coordinateOffsetY,
    );
    const firstDeepX = Math.max(
      2,
      Math.ceil((2 + coordinateOffsetX) / deepSpacing) * deepSpacing - coordinateOffsetX,
    );
    for (let y = firstDeepY; y < height - 2; y += deepSpacing) {
      for (let x = firstDeepX; x < width - 2; x += deepSpacing) {
        const cellSeed =
          (y + coordinateOffsetY) * stride +
          (x + coordinateOffsetX) +
          seed * 1999 +
          307;
        const jx = Math.max(
          2,
          Math.min(
            width - 3,
            x + Math.round((hash01(cellSeed, 71) - 0.5) * (deepSpacing - 1)),
          ),
        );
        const jy = Math.max(
          2,
          Math.min(
            height - 3,
            y + Math.round((hash01(cellSeed, 73) - 0.5) * (deepSpacing - 1)),
          ),
        );
        const idx = jy * width + jx;
        if (isOcean[idx] === 0) continue;

        const dist = distanceToCoast[idx];
        if (dist < deepOceanMinDist) continue;

        const normalizedDistance = hasFeatureDistance
          ? clamp01((dist - deepOceanMinDist) / featureDistanceSpan)
          : 0.5;
        if (hasFeatureDistance) {
          const bandCoordinate =
            Math.pow(normalizedDistance, 0.72) * contourBandCount;
          const bandPhase = bandCoordinate - Math.floor(bandCoordinate);
          const distanceToBand = Math.min(bandPhase, 1.0 - bandPhase);
          const bandHalfWidth = 0.11 + normalizedDistance * 0.045;
          if (distanceToBand > bandHalfWidth) continue;
        } else {
          // With no finite shoreline (an all-ocean tile), retain a sparse
          // deterministic fallback rather than inventing a distance ramp.
          const fallbackPhase = ((dist % wavelength) + wavelength) % wavelength;
          if (Math.abs(fallbackPhase - wavelength * 0.5) > 2.6 * markScale) {
            continue;
          }
        }

        // The paper uses three hatching layers: dense/solid near shore,
        // irregular in the middle, and shorter/looser near the medial axis.
        const layerDensity =
          deepOceanDensity *
          (normalizedDistance < 0.33
            ? 1.15
            : normalizedDistance < 0.72
              ? 0.82
              : 0.5);
        if (hash01(cellSeed, 131) > Math.min(1.0, layerDensity * 3.4))
          continue;

        const layerLengthScale =
          normalizedDistance < 0.33
            ? 1.0
            : normalizedDistance < 0.72
              ? 0.78
              : 0.52;
        const effectiveMarkLength = Math.max(
          8.0 * markScale,
          markLength *
            layerLengthScale *
            (0.82 + hash01(cellSeed, 149) * 0.28),
        );

        // Poisson-disc non-overlap guarantee
        if (!isPoissonClear(jx, jy, deepClearance)) continue;

        const { tx, ty, valid } = getPaperAlignedWaterTangent(
          jx,
          jy,
          distanceToCoast,
          width,
          height,
          seed,
          markScale,
          coastalTransitionBands,
          deepSpacing,
          coordinateOffsetX,
          coordinateOffsetY,
        );
        if (!valid) continue;

        if (
          !isPoissonClear(
            jx,
            jy,
            deepClearance,
            tx,
            ty,
            effectiveMarkLength * 0.5,
          )
        ) {
          continue;
        }
        registerPoissonSeed(
          jx,
          jy,
          deepClearance,
          tx,
          ty,
          effectiveMarkLength * 0.5,
        );

        if (!lightAlpha || !shadowAlpha || !foamAlpha) continue;
        const halfLen = effectiveMarkLength * 0.5;
        const numSteps = Math.max(3, Math.round(halfLen / 0.45));
        const stepSize = halfLen / numSteps;
        const traceDirection = (
          direction: -1 | 1,
        ): Array<{ x: number; y: number; along: number }> => {
          const samples = [{ x: jx, y: jy, along: 0 }];
          let curX = jx;
          let curY = jy;
          let prevTx = tx;
          let prevTy = ty;
          for (let s = 0; s < numSteps; s++) {
            const tangent = getPaperAlignedWaterTangent(
              curX, curY, distanceToCoast, width, height, seed, markScale,
              coastalTransitionBands, deepSpacing, coordinateOffsetX, coordinateOffsetY,
            );
            if (!tangent.valid) break;
            const sign = tangent.tx * prevTx + tangent.ty * prevTy < 0 ? -1 : 1;
            const alignedTx = tangent.tx * sign;
            const alignedTy = tangent.ty * sign;
            const blendedTx = prevTx * 0.5 + alignedTx * 0.5;
            const blendedTy = prevTy * 0.5 + alignedTy * 0.5;
            const length = Math.hypot(blendedTx, blendedTy) || 1;
            const curTx = blendedTx / length;
            const curTy = blendedTy / length;
            prevTx = curTx;
            prevTy = curTy;
            const travelled = direction * (s + 0.5) * stepSize;
            const wobble = sampleSmoothWaveNoise(
              cellSeed + 313, travelled / (7 * markScale),
            ) * (0.16 / (1 + smoothing));
            const nextX = curX + direction * (curTx - curTy * wobble) * stepSize;
            const nextY = curY + direction * (curTy + curTx * wobble) * stepSize;
            if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) break;
            const nextIndex = Math.floor(nextY) * width + Math.floor(nextX);
            if (oceanClip[nextIndex] === 0) break;
            curX = nextX;
            curY = nextY;
            samples.push({ x: curX, y: curY, along: direction * (s + 1) * stepSize });
          }
          return samples;
        };
        const backward = traceDirection(-1);
        const forward = traceDirection(1);
        const rawPath = [
          ...backward.slice(1).reverse(),
          { x: jx, y: jy, along: 0 },
          ...forward.slice(1),
        ];
        const ridgePath = prepareOceanWavePath(
          rawPath, distanceToCoast, width, height, cellSeed, markScale, smoothing,
        );
        paintOceanWavePath(
          ridgePath, alpha, tone, lightAlpha!, shadowAlpha!, foamAlpha!, inkAlpha!,
          oceanClip, width, height, cellSeed, markScale, inkRad,
          deepOceanWaveShadingScale, deepOceanWaveShadingIntensity, smoothing,
          coordinateOffsetX, coordinateOffsetY, stride, waveWindow,
        );
        const fork = makeOceanWaveFork(
          ridgePath, cellSeed, distanceToCoast, width, height, markScale,
        );
        if (fork) {
          paintOceanWavePath(
            fork, alpha, tone, lightAlpha!, shadowAlpha!, foamAlpha!, inkAlpha!,
            oceanClip, width, height, cellSeed + 1709, markScale, inkRad,
            deepOceanWaveShadingScale, deepOceanWaveShadingIntensity, smoothing,
            coordinateOffsetX, coordinateOffsetY, stride, waveWindow,
          );
        }
      }
    }
  }

  // Segment rasterization gives each short path sample a crisp edge. A small
  // ocean-only blur joins those samples into the soft painted bands; clipping
  // afterwards prevents the blur from tinting islands or shoreline land.
  if (lightAlpha && shadowAlpha) {
    softenOceanWaveBand(lightAlpha, oceanClip, width, height, markScale);
    softenOceanWaveBand(shadowAlpha, oceanClip, width, height, markScale);
  }

  if (waveOpacity < 1.0) {
    for (let i = 0; i < alpha.length; i++) {
      alpha[i] = Math.round(alpha[i] * waveOpacity);
      if (lightAlpha) lightAlpha[i] = Math.round(lightAlpha[i] * waveOpacity);
      if (shadowAlpha) shadowAlpha[i] = Math.round(shadowAlpha[i] * waveOpacity);
      if (foamAlpha) foamAlpha[i] = Math.round(foamAlpha[i] * waveOpacity);
      if (inkAlpha) inkAlpha[i] = Math.round(inkAlpha[i] * waveOpacity);
    }
  }

  return { alpha, tone, lightAlpha, shadowAlpha, foamAlpha, inkAlpha };
}

/**
 * Samples 4 to 6 broad Poisson-disk origin centers in deep ocean far from the coast (>= 38px).
 */
function samplePoissonDeepOceanSeeds(
  isOcean: Uint8Array,
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  minDist: number = 200,
  seed: number = 42,
): Array<{
  x: number;
  y: number;
  lambda: number;
  maxRadius: number;
  phase: number;
}> {
  const seeds: Array<{
    x: number;
    y: number;
    lambda: number;
    maxRadius: number;
    phase: number;
  }> = [];

  const maxDim = Math.max(width, height);
  const sampleRadius = Math.max(140, minDist);

  let minCoastDist = Math.max(38.0, Math.min(width, height) * 0.11);
  let maxOceanDist = 0;
  for (let i = 0; i < width * height; i++) {
    if (isOcean[i] === 1 && distanceToCoast[i] > maxOceanDist) {
      maxOceanDist = distanceToCoast[i];
    }
  }
  if (maxOceanDist < minCoastDist) {
    minCoastDist = maxOceanDist * 0.7;
  }

  const candidateSeeds: Array<{ x: number; y: number; distToCoast: number }> =
    [];
  const cols = Math.max(2, Math.round(width / sampleRadius));
  const rows = Math.max(2, Math.round(height / sampleRadius));
  const cellW = width / cols;
  const cellH = height / rows;

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cellSeed = gy * cols + gx + seed * 997;
      const jx = Math.max(
        8,
        Math.min(
          width - 9,
          (gx + 0.5 + (hash01(cellSeed, 101) - 0.5) * 0.75) * cellW,
        ),
      );
      const jy = Math.max(
        8,
        Math.min(
          height - 9,
          (gy + 0.5 + (hash01(cellSeed, 103) - 0.5) * 0.75) * cellH,
        ),
      );
      const idx = Math.floor(jy) * width + Math.floor(jx);
      if (isOcean[idx] === 1 && distanceToCoast[idx] >= minCoastDist) {
        candidateSeeds.push({
          x: jx,
          y: jy,
          distToCoast: distanceToCoast[idx],
        });
      }
    }
  }

  candidateSeeds.sort((a, b) => b.distToCoast - a.distToCoast);

  for (let i = 0; i < candidateSeeds.length; i++) {
    const cand = candidateSeeds[i];
    const sSeed = seed + i * 1973;
    seeds.push({
      x: cand.x,
      y: cand.y,
      lambda: 22.0 + hash01(sSeed, 107) * 6.0,
      maxRadius: maxDim * (0.7 + hash01(sSeed, 109) * 0.3),
      phase: hash01(sSeed, 113) * Math.PI * 2,
    });
  }

  if (seeds.length === 0) {
    const candidateIndices: number[] = [];
    for (let y = 8; y < height - 8; y += 8) {
      for (let x = 8; x < width - 8; x += 8) {
        const idx = y * width + x;
        if (isOcean[idx] === 1 && distanceToCoast[idx] >= minCoastDist * 0.6) {
          candidateIndices.push(idx);
        }
      }
    }
    const numToPick = Math.min(
      4,
      Math.max(1, Math.floor(candidateIndices.length / 10)),
    );
    for (let k = 0; k < numToPick; k++) {
      const pickIdx =
        candidateIndices[
          Math.floor(hash01(seed + k * 31, 911) * candidateIndices.length)
        ];
      const sSeed = seed + k * 1973;
      seeds.push({
        x: pickIdx % width,
        y: Math.floor(pickIdx / width),
        lambda: 22.0 + hash01(sSeed, 107) * 6.0,
        maxRadius: maxDim * 0.75,
        phase: hash01(sSeed, 113) * Math.PI * 2,
      });
    }
  }

  return seeds;
}

/**
 * Multi-point wave energy field: renders broken charcoal dry-brush ink strokes
 * and luminous wave crest highlights without destructive interference.
 */
/**
 * Computes analytical wave propagation normal and wave front tangent from active disturbance epicenters.
 * Normal vector points radially outward along wave propagation direction.
 * Tangent vector points along the concentric circular wave front.
 */
function getWaveNormalAndTangent(
  x: number,
  y: number,
  seeds: WaveSeed[],
): { tx: number; ty: number; weightSum: number } {
  let nx = 0;
  let ny = 0;
  let weightSum = 0;

  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i];
    const str = s.strength ?? 1.0;
    if (str <= 0) continue;

    const dx = x - s.x;
    const dy = y - s.y;
    const d = Math.hypot(dx, dy);
    const rMax = s.maxRadius ?? 600.0;
    if (d < 0.5 || d >= rMax) continue;

    const lambda = s.lambda ?? 22.0;
    const weight = str * wavePropagationWeight(d, lambda, rMax);

    nx += (dx / d) * weight;
    ny += (dy / d) * weight;
    weightSum += weight;
  }

  const nLen = Math.hypot(nx, ny);
  if (nLen < 0.0001) return { tx: 1, ty: 0, weightSum: 0 };
  return { tx: -ny / nLen, ty: nx / nLen, weightSum };
}

/**
 * Returns the tangent of the actual composite wave field. This is more
 * faithful than averaging epicenter radii when several swells interfere:
 * wave lines should run perpendicular to the local field gradient.
 */
function getWaveFieldTangent(
  waveField: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): { tx: number; ty: number; valid: boolean } {
  const sample = (sampleX: number, sampleY: number): number => {
    const clampedX = Math.max(0, Math.min(width - 1, sampleX));
    const clampedY = Math.max(0, Math.min(height - 1, sampleY));
    const x0 = Math.floor(clampedX);
    const y0 = Math.floor(clampedY);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = clampedX - x0;
    const ty = clampedY - y0;
    const top =
      waveField[y0 * width + x0] * (1 - tx) + waveField[y0 * width + x1] * tx;
    const bottom =
      waveField[y1 * width + x0] * (1 - tx) + waveField[y1 * width + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };

  const xW = Math.max(0, x - 1);
  const xE = Math.min(width - 1, x + 1);
  const yN = Math.max(0, y - 1);
  const yS = Math.min(height - 1, y + 1);
  const ddx = (sample(xE, y) - sample(xW, y)) / (xE - xW || 1);
  const ddy = (sample(x, yS) - sample(x, yN)) / (yS - yN || 1);
  const gradientLength = Math.hypot(ddx, ddy);
  if (gradientLength < 1e-4) return { tx: 1, ty: 0, valid: false };
  return { tx: -ddy / gradientLength, ty: ddx / gradientLength, valid: true };
}

/**
 * Computes coastal refracted wave tangent.
 * In open deep ocean (dCoast >= 95px), follows pure epicenter swell wavefronts.
 * As waves approach coastlines, islands, or shallow terrain (dCoast < 95px),
 * waves strongly refract and align parallel to the terrain coastline contours.
 */
function getRefractedWaveTangent(
  x: number,
  y: number,
  seeds: WaveSeed[],
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  waveField?: Float32Array,
): { tx: number; ty: number; weightSum: number } {
  const analyticTangent = getWaveNormalAndTangent(x, y, seeds);
  let swellTx = analyticTangent.tx;
  let swellTy = analyticTangent.ty;

  // Follow the phase of the composite field rather than only an ideal
  // epicenter circle. Aligning vectors avoids 180-degree flips between
  // adjacent pixels when the local field gradient changes sign.
  if (waveField) {
    const fieldTangent = getWaveFieldTangent(waveField, width, height, x, y);
    if (fieldTangent.valid) {
      const dot = fieldTangent.tx * swellTx + fieldTangent.ty * swellTy;
      const sign = dot < 0 ? -1.0 : 1.0;
      const alignedFieldTx = fieldTangent.tx * sign;
      const alignedFieldTy = fieldTangent.ty * sign;
      const fieldBlend = analyticTangent.weightSum > 0.0001 ? 0.82 : 1.0;
      const blendedTx =
        swellTx * (1.0 - fieldBlend) + alignedFieldTx * fieldBlend;
      const blendedTy =
        swellTy * (1.0 - fieldBlend) + alignedFieldTy * fieldBlend;
      const blendedLength = Math.hypot(blendedTx, blendedTy);
      if (blendedLength > 1e-4) {
        swellTx = blendedTx / blendedLength;
        swellTy = blendedTy / blendedLength;
      }
    }
  }

  const { weightSum } = analyticTangent;

  const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
  const dCoast = distanceToCoast[iy * width + ix];

  // In deep ocean beyond coastal refraction zone (95px)
  if (dCoast >= 95.0 || dCoast <= 0) {
    return { tx: swellTx, ty: swellTy, weightSum };
  }

  // Strong coastal wave refraction with wide reach (95px) and fast-onset power curve
  const coastRatio = Math.max(0, Math.min(1.0, 1.0 - (dCoast - 4.0) / 90.0));
  const alphaCoast = Math.pow(coastRatio, 0.7);

  const coastTangent = getContourTangentAt(
    distanceToCoast,
    width,
    height,
    x,
    y,
  );
  if (!coastTangent.valid) {
    return { tx: swellTx, ty: swellTy, weightSum };
  }

  // Align orientation of coastal contour tangent with swell tangent
  const dot = coastTangent.tx * swellTx + coastTangent.ty * swellTy;
  const sign = dot < 0 ? -1.0 : 1.0;
  const alignedCoastTx = coastTangent.tx * sign;
  const alignedCoastTy = coastTangent.ty * sign;

  // Strong blend: up to 98% alignment with terrain contours in coastal waters
  const blendWeight = Math.min(1.0, alphaCoast * 0.98);
  const bx = (1.0 - blendWeight) * swellTx + blendWeight * alignedCoastTx;
  const by = (1.0 - blendWeight) * swellTy + blendWeight * alignedCoastTy;
  const bLen = Math.hypot(bx, by);

  if (bLen < 1e-4) {
    return { tx: swellTx, ty: swellTy, weightSum };
  }

  return { tx: bx / bLen, ty: by / bLen, weightSum };
}

/**
 * Samples the shoreline-distance gradient at progressively wider supports.
 * A one-pixel gradient is the right choice beside a normal coast, but it can
 * vanish on a medial axis where two shorelines are equally close. Wider
 * supports preserve a stable level-set tangent in those areas.
 */
function getStableCoastTangentAt(
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): { tx: number; ty: number; valid: boolean } {
  const supports = [1, 2, 4, 8, 16];
  for (const support of supports) {
    const ddx =
      (sampleScalarField(distanceToCoast, width, height, x + support, y) -
        sampleScalarField(distanceToCoast, width, height, x - support, y)) /
      (2 * support);
    const ddy =
      (sampleScalarField(distanceToCoast, width, height, x, y + support) -
        sampleScalarField(distanceToCoast, width, height, x, y - support)) /
      (2 * support);
    const gradientLength = Math.hypot(ddx, ddy);
    if (gradientLength >= 1e-4) {
      return {
        tx: -ddy / gradientLength,
        ty: ddx / gradientLength,
        valid: true,
      };
    }
  }
  return { tx: 1, ty: 0, valid: false };
}

/**
 * Prefer the existing coast-following path orientation, using the directional
 * swell field only where no usable shoreline gradient exists.
 */
function getPaperAlignedWaterTangent(
  x: number,
  y: number,
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  seed: number,
  markScale: number,
  coastalTransitionBands: number,
  localSpacing: number,
  coordinateOffsetX: number,
  coordinateOffsetY: number,
): { tx: number; ty: number; valid: boolean } {
  const coastTangent = getStableCoastTangentAt(
    distanceToCoast,
    width,
    height,
    x,
    y,
  );
  if (coastTangent.valid) return coastTangent;
  return getDirectionalWaveTangent(
    x,
    y,
    distanceToCoast,
    width,
    height,
    seed,
    markScale,
    coastalTransitionBands,
    localSpacing,
    coordinateOffsetX,
    coordinateOffsetY,
  );
}

/**
 * Deterministic fallback for a water body with no usable distance gradient.
 * Normal shoreline hatching uses getPaperAlignedWaterTangent above; this path
 * only keeps all-ocean tiles from losing their marks entirely.
 */
function getDirectionalWaveTangent(
  x: number,
  y: number,
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  seed: number,
  markScale: number,
  coastalTransitionBands: number,
  localSpacing: number,
  coordinateOffsetX: number,
  coordinateOffsetY: number,
): { tx: number; ty: number; valid: boolean } {
  const globalAngle =
    seed * 0.037 +
    Math.sin((x + coordinateOffsetX + seed * 13.0) * 0.008) * 0.34 +
    Math.cos((y + coordinateOffsetY - seed * 7.0) * 0.006) * 0.28 +
    Math.sin((x + coordinateOffsetX + y + coordinateOffsetY) * 0.003) * 0.14;
  // The seeded field describes the direction the swell travels. A drawn
  // wave mark is its crest, so the stroke tangent is perpendicular to that
  // direction. Keeping this conversion here also leaves the coastal tangent
  // blend in the same coordinate convention.
  const openTx = -Math.sin(globalAngle);
  const openTy = Math.cos(globalAngle);
  const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
  const coastDistance = distanceToCoast[iy * width + ix];
  const outerBand =
    OCEAN_RIPPLE_BANDS[
      Math.max(
        0,
        Math.min(
          OCEAN_RIPPLE_BANDS.length - 1,
          Math.round(Math.max(1, coastalTransitionBands)) - 1,
        ),
      )
    ] * markScale;
  const transitionStart = Math.max(24 * markScale, outerBand + localSpacing);
  const transitionEnd = transitionStart + 4 * localSpacing;
  const openBlend = smoothstep(transitionStart, transitionEnd, coastDistance);
  const coastTangent = getContourTangentAt(
    distanceToCoast,
    width,
    height,
    x,
    y,
  );
  if (!coastTangent.valid) return { tx: openTx, ty: openTy, valid: true };

  const alignment = coastTangent.tx * openTx + coastTangent.ty * openTy;
  const sign = alignment < 0 ? -1 : 1;
  const alignedOpenTx = openTx * sign;
  const alignedOpenTy = openTy * sign;
  const tx = coastTangent.tx * (1 - openBlend) + alignedOpenTx * openBlend;
  const ty = coastTangent.ty * (1 - openBlend) + alignedOpenTy * openBlend;
  const length = Math.hypot(tx, ty);
  return length > 1e-4
    ? { tx: tx / length, ty: ty / length, valid: true }
    : { tx: coastTangent.tx, ty: coastTangent.ty, valid: true };
}

function buildOceanTurbulenceAlpha(
  oceanClip: Uint8Array,
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  seed: number,
  markScale: number,
  turbulenceScale: number,
  turbulenceIntensity: number,
  opacity: number,
  deepOceanDensity: number,
  coastalTransitionBands: number,
  coordinateOffsetX: number,
  coordinateOffsetY: number,
): Uint8Array {
  const alpha = new Uint8Array(width * height);
  const strengthScale = Math.max(0, Math.min(1.5, turbulenceIntensity / 2.5)) *
    clamp01(opacity);
  if (strengthScale === 0) return alpha;

  const spacing = Math.max(
    5 * markScale,
    Math.round((7.2 / Math.max(0.12, Math.sqrt(deepOceanDensity))) * markScale),
  );
  const textureScale = Math.sqrt(Math.max(0.5, turbulenceScale)) * markScale;
  const alongPeriod = 36 * textureScale;
  const acrossPeriod = 14 * textureScale;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (oceanClip[index] !== 1) continue;

      const x0 = Math.max(0, x - 2);
      const x1 = Math.min(width - 1, x + 2);
      const y0 = Math.max(0, y - 2);
      const y1 = Math.min(height - 1, y + 2);
      const gradientX =
        (distanceToCoast[y * width + x1] - distanceToCoast[y * width + x0]) /
        Math.max(1, x1 - x0);
      const gradientY =
        (distanceToCoast[y1 * width + x] - distanceToCoast[y0 * width + x]) /
        Math.max(1, y1 - y0);
      const gradientStrength = Math.hypot(gradientX, gradientY);
      let tx: number;
      let ty: number;
      if (gradientStrength > 1e-4) {
        tx = -gradientY / gradientStrength;
        ty = gradientX / gradientStrength;
      } else {
        const tangent = getPaperAlignedWaterTangent(
          x,
          y,
          distanceToCoast,
          width,
          height,
          seed,
          markScale,
          coastalTransitionBands,
          spacing,
          coordinateOffsetX,
          coordinateOffsetY,
        );
        tx = tangent.valid ? tangent.tx : 1;
        ty = tangent.valid ? tangent.ty : 0;
      }
      const nx = ty;
      const ny = -tx;
      const globalX = x + coordinateOffsetX;
      const globalY = y + coordinateOffsetY;
      const along = (globalX * tx + globalY * ty) / alongPeriod;
      const across = (globalX * nx + globalY * ny) / acrossPeriod;
      const broad =
        (sampleWetlandValueNoise(along, across, seed + 2381, 601) - 0.5) * 2;
      const fine =
        (sampleWetlandValueNoise(along * 2.7, across * 2.4, seed + 2671, 613) - 0.5) * 2;
      const turbulence = broad * 0.72 + fine * 0.28;
      const darken = (0.04 + 0.05 * (turbulence + 1) * 0.5) * strengthScale;
      alpha[index] = Math.round(clamp01(darken) * 255);
    }
  }
  return alpha;
}

/**
 * Renders randomly placed charcoal wave lines across open ocean based on density,
 * strictly excluding a minimum radius from all wave epicenters, and tracing lines
 * along the composite wave-field phase while refracting naturally near coastlines.
 */
function paintOceanRandomWaveMarks(
  isOcean: Uint8Array,
  distanceToCoast: Float32Array,
  width: number,
  height: number,
  waveField: Float32Array,
  seedOrigins: WaveSeed[],
  alpha: Uint8Array,
  tone: Uint8Array,
  density: number = 1.0,
  lengthScale: number = 1.0,
  waveOpacity: number = 0.85,
  minEpicenterDist: number = 32.0,
  seed: number = 42,
): void {
  if (density <= 0 || waveOpacity <= 0) return;

  const minCoastDist = 8.0; // Beyond immediate shoreline

  // Sample grid cell size determined by density
  const spacing = Math.max(
    8,
    Math.round(5.5 / Math.max(0.04, Math.sqrt(density))),
  );
  const markLength = Math.max(4.5, 10.0 * lengthScale);
  const inkRadius = 0.42;

  for (let y = 3; y < height - 3; y += spacing) {
    for (let x = 3; x < width - 3; x += spacing) {
      const cellSeed = y * width + x + seed * 9973;

      // Jitter position within cell
      const jx = Math.max(
        2,
        Math.min(
          width - 3,
          x + Math.round((hash01(cellSeed, 71) - 0.5) * (spacing - 1)),
        ),
      );
      const jy = Math.max(
        2,
        Math.min(
          height - 3,
          y + Math.round((hash01(cellSeed, 73) - 0.5) * (spacing - 1)),
        ),
      );
      const idx = jy * width + jx;

      if (isOcean[idx] === 0 || distanceToCoast[idx] < minCoastDist) continue;

      // Never draw within min distance from an epicenter
      let tooCloseToEpicenter = false;
      for (let k = 0; k < seedOrigins.length; k++) {
        const epic = seedOrigins[k];
        if (Math.hypot(jx - epic.x, jy - epic.y) < minEpicenterDist) {
          tooCloseToEpicenter = true;
          break;
        }
      }
      if (tooCloseToEpicenter) continue;

      // Random density gate
      if (hash01(cellSeed, 131) > Math.min(1.0, density * 6.5)) continue;

      const {
        tx: initTx,
        ty: initTy,
        weightSum,
      } = getRefractedWaveTangent(
        jx,
        jy,
        seedOrigins,
        distanceToCoast,
        width,
        height,
        waveField,
      );
      if (weightSum < 0.0001) continue;

      const toneValue = Math.round(20 + hash01(cellSeed, 163) * 55);
      const halfLen = markLength * 0.5 * (0.8 + hash01(cellSeed, 167) * 0.4);
      const stepSize = 0.5;
      const numSteps = Math.max(3, Math.round(halfLen / stepSize));

      // Forward stroke following wave curvature and coastal refraction
      let curX = jx;
      let curY = jy;
      let previousTx = initTx;
      let previousTy = initTy;
      for (let s = 0; s < numSteps; s++) {
        const { tx, ty } = getRefractedWaveTangent(
          curX,
          curY,
          seedOrigins,
          distanceToCoast,
          width,
          height,
          waveField,
        );
        const direction = tx * previousTx + ty * previousTy < 0 ? -1.0 : 1.0;
        const alignedTx = tx * direction;
        const alignedTy = ty * direction;
        const stableTx = previousTx * 0.35 + alignedTx * 0.65;
        const stableTy = previousTy * 0.35 + alignedTy * 0.65;
        const stableLength = Math.hypot(stableTx, stableTy) || 1;
        const nextTx = stableTx / stableLength;
        const nextTy = stableTy / stableLength;
        const wobble = (hash01(cellSeed + s * 37, 179) - 0.5) * 0.035;
        const nextX = curX + (nextTx - nextTy * wobble) * stepSize;
        const nextY = curY + (nextTy + nextTx * wobble) * stepSize;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) break;
        const nextIdx = Math.floor(nextY) * width + Math.floor(nextX);
        if (isOcean[nextIdx] === 0) break;

        paintInkSegment(
          alpha,
          tone,
          isOcean,
          width,
          height,
          curX,
          curY,
          nextX,
          nextY,
          inkRadius,
          toneValue,
          cellSeed + s * 11,
          1,
          s / numSteps,
          (s + 1) / numSteps,
          false,
          true,
        );

        curX = nextX;
        curY = nextY;
        previousTx = nextTx;
        previousTy = nextTy;
      }

      // Backward stroke following wave curvature and coastal refraction
      curX = jx;
      curY = jy;
      previousTx = initTx;
      previousTy = initTy;
      for (let s = 0; s < numSteps; s++) {
        const { tx, ty } = getRefractedWaveTangent(
          curX,
          curY,
          seedOrigins,
          distanceToCoast,
          width,
          height,
          waveField,
        );
        const direction = tx * previousTx + ty * previousTy < 0 ? -1.0 : 1.0;
        const alignedTx = tx * direction;
        const alignedTy = ty * direction;
        const stableTx = previousTx * 0.35 + alignedTx * 0.65;
        const stableTy = previousTy * 0.35 + alignedTy * 0.65;
        const stableLength = Math.hypot(stableTx, stableTy) || 1;
        const nextTx = stableTx / stableLength;
        const nextTy = stableTy / stableLength;
        const wobble = (hash01(cellSeed + 101 + s * 43, 191) - 0.5) * 0.035;
        const nextX = curX - (nextTx - nextTy * wobble) * stepSize;
        const nextY = curY - (nextTy + nextTx * wobble) * stepSize;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) break;
        const nextIdx = Math.floor(nextY) * width + Math.floor(nextX);
        if (isOcean[nextIdx] === 0) break;

        paintInkSegment(
          alpha,
          tone,
          isOcean,
          width,
          height,
          curX,
          curY,
          nextX,
          nextY,
          inkRadius,
          toneValue,
          cellSeed + 101 + s * 11,
          1,
          s / numSteps,
          (s + 1) / numSteps,
          false,
          true,
        );

        curX = nextX;
        curY = nextY;
        previousTx = nextTx;
        previousTy = nextTy;
      }
    }
  }
}

// These legacy ocean helpers remain available for callers that may hot-reload
// this module with the experimental epicentre renderer. Keep their symbols
// live without invoking a second ocean pass in the unified renderer.
// paintFlowInk is retained only as legacy code; river marks are generated by
// buildUnifiedInlandWaterContours and this function is never invoked.
void paintFlowInk;
void getWaveFieldTangentAt;
void extractCoastalWaveEmitters;
void samplePoissonDeepOceanSeeds;
void paintOceanRandomWaveMarks;

/**
 * Unified Water Renderer: uses one smoothed coverage and bank rasterizer for
 * ocean, rivers, and their mouths. Routed splines add the hydrologically
 * meaningful centreline and variable width; the ocean is the same continuous
 * water surface around that geometry, not a separate edge treatment.
 */
function renderWaterOverlayInternal(
  dem: MountainDEMData,
  options: WaterRendererOptions,
  profiler?: MountainProfiler,
  geometryOverride?: WaterOverlayGeometry,
  mode: WaterOverlayRenderMode = "paint",
): WaterOverlay | WaterOverlayGeometry {
  const { width, height } = dem;
  const totalCells = width * height;
  const seed = Math.round(options.seed ?? 23817);
  const threshold = Math.max(0.001, options.riverThresholdKm2 ?? 0.8);
  const hasWetland = Boolean(
    dem.wetlandPoolMask?.some((value) => value === 1) ||
      dem.biomeType?.some((biome) => biome === 7),
  );
  const fillSmoothing = Math.max(
    0,
    Math.min(4, Math.round(options.fillSmoothing ?? 1)),
  );
  const outlineSmoothing = Math.max(
    0,
    Math.min(4, Math.round(options.outlineSmoothing ?? 1)),
  );
  const flowSmoothing = Math.max(
    0,
    Math.min(4, Math.round(options.flowSmoothing ?? 1)),
  );
  const outlineThickness = Math.max(
    0,
    options.outlineThickness ??
      options.oceanWaveThickness ??
      options.deepOceanWaveThickness ??
      1,
  );
  const outlineLength = Math.max(
    0.1,
    options.outlineLength ?? options.deepOceanLineLength ?? 1,
  );
  const deepOceanLength = Math.max(
    0.1,
    options.deepOceanWaveLength ?? options.deepOceanLineLength ?? outlineLength,
  );
  const deepOceanThickness = Math.max(
    0,
    options.deepOceanStrokeThickness ?? outlineThickness,
  );
  const deepOceanWaveShadingScale = Math.max(
    0.5,
    Math.min(8, options.deepOceanWaveShadingScale ?? 4.5),
  );
  const deepOceanWaveShadingIntensity = Math.max(
    0,
    Math.min(4, options.deepOceanWaveShadingIntensity ?? 2.5),
  );
  const deepOceanTurbulenceScale = Math.max(
    0.5,
    Math.min(8, options.deepOceanTurbulenceScale ?? 4.5),
  );
  const deepOceanTurbulenceIntensity = Math.max(
    0,
    Math.min(INSPECTOR_BOUNDS.oceanTurbulence, options.deepOceanTurbulenceIntensity ?? 2.5),
  );
  const outlineOpacity = clamp01(
    options.outlineOpacity ?? options.oceanWaveOpacity ?? 1,
  );
  const showWaterDetails =
    options.showWaterDetails !== false && options.showOceanDetails !== false;
  // Water boundaries retain Outline, coastal/river marks retain Charcoal,
  // and offshore wave paths use blue paint and foam.
  const charcoalDensity = Math.max(0, options.flowDensity ?? 1);
  const charcoalOpacity = clamp01(options.flowOpacity ?? 0.85);
  const charcoalThickness = Math.max(
    0.2,
    options.flowThickness ?? 1,
  );
  const charcoalLength = Math.max(0.1, options.flowLength ?? 1.0);

  const sourceOceanMask =
    geometryOverride?.sourceOceanMask ?? new Uint8Array(totalCells);
  const sourceOceanCoverage =
    geometryOverride?.sourceOceanCoverage ?? new Float32Array(totalCells);
  const sourceRiverMask =
    geometryOverride?.sourceRiverMask ?? new Uint8Array(totalCells);
  const riverFallbackMask = new Uint8Array(totalCells);
  let sourceOceanCells = 0;
  let sourceRiverCells = 0;
  let riverFallbackCells = 0;
  profiler?.recordMetric("water total cells", totalCells, "count");
  const sourceMaskStop = profiler?.begin("water source mask preparation");
  if (!geometryOverride) {
    for (let index = 0; index < totalCells; index++) {
      const oceanCell = isOceanCell(dem, index);
      if (oceanCell) {
        sourceOceanMask[index] = 1;
        sourceOceanCoverage[index] = 1;
        if (profiler) sourceOceanCells++;
      }
      if (
        options.oceanMaskCoverageOverride?.length === totalCells &&
        Number.isFinite(options.oceanMaskCoverageOverride[index])
      ) {
        sourceOceanCoverage[index] = clamp01(
          options.oceanMaskCoverageOverride[index],
        );
      }
      if (oceanCell) continue;
      const routed =
        dem.isRiverChannel?.[index] === 1 &&
        routedAreaAt(dem, index) >= threshold;
      const ecologicalWater = dem.biomeType?.[index] === 6;
      if (routed || ecologicalWater) {
        sourceRiverMask[index] = 1;
        if (profiler) sourceRiverCells++;
      }
      // Bank-stage cells inherit the river biome but are not routed centreline
      // cells. They must not be painted as a second broad fill underneath the
      // spline; reserve fallback coverage for genuinely isolated ecological
      // patches that are not part of the routed channel raster at all.
      if (!routed && ecologicalWater && dem.isRiverChannel?.[index] !== 1) {
        riverFallbackMask[index] = 1;
        if (profiler) riverFallbackCells++;
      }
    }
  }
  sourceMaskStop?.();
  profiler?.recordMetric("water source ocean cells", sourceOceanCells, "count");
  profiler?.recordMetric("water source river cells", sourceRiverCells, "count");
  profiler?.recordMetric("water river fallback cells", riverFallbackCells, "count");

  // The controls are also the switch between the legacy DEM water and the
  // generated surface.  Do not leave the smoothed mask underneath the raw
  // water when details are disabled: return one exact source-water layer.
  const keepWetlandPoolFill =
    hasWetland && options.wetlandPuddleContours !== false;
  if (!showWaterDetails && !keepWetlandPoolFill) {
    const originalWaterMask = new Uint8Array(totalCells);
    for (let index = 0; index < totalCells; index++) {
      if (sourceOceanMask[index] === 1 || sourceRiverMask[index] === 1)
        originalWaterMask[index] = 1;
    }
    const distanceToCoast = buildDistanceToCoast(
      originalWaterMask,
      width,
      height,
    );
    const rawGeometry: WaterOverlayGeometry = {
      width,
      height,
      raw: true,
      sourceOceanMask,
      sourceOceanCoverage,
      sourceRiverMask,
      rawWaterMask: originalWaterMask,
      filteredOceanMask: sourceOceanMask,
      sourceWaterMask: originalWaterMask,
      oceanGeometrySource: sourceOceanCoverage,
      riverSplines: options.riverSplinesOverride ?? [],
      riverFillCoverage: new Uint8Array(totalCells),
      riverWaterTone: new Uint8Array(totalCells),
      wetlandPuddleMask: new Uint8Array(totalCells),
      wetlandPuddleFillAlpha: new Uint8Array(totalCells),
      wetlandPuddleFillTone: new Uint8Array(totalCells),
      wetlandPuddleInteriorDistance: new Float32Array(totalCells),
      distanceToWetlandPool: new Float32Array(totalCells),
      riverContourAlpha: new Uint8Array(totalCells),
      strokeGeometry: emptyWaterStrokeGeometry(width, height),
      waveField: new Float32Array(totalCells),
      waterAlpha: originalWaterMask,
      oceanCoverage: new Uint8Array(totalCells),
      cleanWaterMask: new Uint8Array(totalCells),
      bankWaterMask: new Uint8Array(totalCells),
      distanceToWater: new Float32Array(totalCells),
      distanceToLand: new Float32Array(totalCells),
      oceanBankWaterMask: new Uint8Array(totalCells),
      oceanDistanceToWater: new Float32Array(totalCells),
      oceanDistanceToLand: new Float32Array(totalCells),
      hasOceanBank: false,
      oceanDetailMask: new Uint8Array(totalCells),
      distanceToCoast,
      effectiveDistanceToCoast: distanceToCoast,
    };
    if (mode === "geometry") return rawGeometry;
    return paintRawWaterOverlay(rawGeometry);
  }

  // Only remove isolated ocean speckles. The raw river mask remains available
  // for the disabled-controls fallback, but routed rivers are rasterized from
  // their spline in the generated surface below.
  const oceanFilteringStop = geometryOverride
    ? undefined
    : profiler?.begin("water ocean filtering and source mask");
  const filteredOceanMask =
    geometryOverride?.filteredOceanMask ??
    filterSmallOceanComponents(sourceOceanMask, width, height, 16);
  const sourceWaterMask =
    geometryOverride?.sourceWaterMask ?? new Uint8Array(totalCells);
  let filteredOceanCells = 0;
  if (!geometryOverride) {
    for (let index = 0; index < totalCells; index++) {
      // Routed rivers are represented by their spline below. Keeping their raw
      // raster cells in this mask would create a second, wider fill underneath
      // the spline and make the visible water disagree with its outline.
      if (filteredOceanMask[index] === 1) {
        sourceWaterMask[index] = 1;
        if (profiler) filteredOceanCells++;
      }
    }
  }
  oceanFilteringStop?.();
  profiler?.recordMetric(
    "water filtered ocean cells",
    geometryOverride ? 0 : filteredOceanCells,
    "count",
  );
  const oceanGeometrySource: ArrayLike<number> =
    geometryOverride?.oceanGeometrySource ??
    (options.oceanMaskCoverageOverride?.length === totalCells
      ? sourceOceanCoverage
      : sourceWaterMask);

  // This is the common fill algorithm for the ocean. The spline rasterizer
  // adds routed rivers into the same final field below, so there is only one
  // visible water coverage at a river mouth.
  const coveragePasses = Math.max(
    1,
    Math.min(3, 1 + Math.round(fillSmoothing * 0.35)),
  );
  const baseCoverageStop = geometryOverride
    ? undefined
    : profiler?.begin("water base coverage smoothing");
  const waterCoverage =
    geometryOverride?.waterAlpha ??
    buildSmoothedWaterCoverage(sourceWaterMask, width, height, coveragePasses);
  baseCoverageStop?.();

  const waterAlpha = waterCoverage.slice();
  const waterTone = new Uint8Array(totalCells).fill(125);
  const bankAlpha = new Uint8Array(totalCells);
  const outlineBankAlpha = new Uint8Array(totalCells);
  const crestAlpha = new Uint8Array(totalCells);
  const oceanWaveLightAlpha = new Uint8Array(totalCells);
  const oceanWaveShadowAlpha = new Uint8Array(totalCells);
  const oceanWaveInkAlpha = new Uint8Array(totalCells);
  const oceanTurbulenceAlpha = new Uint8Array(totalCells);
  const oceanWaterAlpha = new Uint8Array(totalCells);
  const oceanWaterTone = new Uint8Array(totalCells);
  const oceanBankAlpha = new Uint8Array(totalCells);
  const oceanFlowAlpha = new Uint8Array(totalCells);
  const oceanFlowTone = new Uint8Array(totalCells);
  if (geometryOverride) oceanWaterAlpha.set(geometryOverride.oceanCoverage);

  const ecological =
    options.useEcologicalBiomeWater !== false && hasEcologicalWaterBiome(dem);
  const riverGuideStop = geometryOverride
    ? undefined
    : profiler?.begin("water river width guide");
  const riverGuide = geometryOverride
    ? undefined
    : buildWaterWidthGuide(dem, ecological);
  riverGuideStop?.();
  // Line-style thickness must never change the underlying water geometry.
  const minimumRadius = 0.5;
  const riverSplineStop = geometryOverride
    ? undefined
    : profiler?.begin("water river spline generation");
  const riverSplines =
    geometryOverride?.riverSplines ??
    (options.riverSplinesOverride
      ? options.riverSplinesOverride
      : buildRiverSplines(
          dem,
          riverGuide!,
          threshold,
          minimumRadius,
          fillSmoothing,
        ));
  riverSplineStop?.();
  const strokeGeometry =
    geometryOverride?.strokeGeometry ??
    buildRiverStrokeGeometry(width, height, riverSplines);
  profiler?.recordMetric(
    "water packed stroke paths",
    strokeGeometry.stableIds.length,
    "count",
  );
  profiler?.recordMetric(
    "water packed stroke points",
    strokeGeometry.pointX.length,
    "count",
  );
  profiler?.recordMetric("water river splines", riverSplines.length, "count");
  if (profiler) {
    let riverSplineSegments = 0;
    for (const spline of riverSplines) {
      if (spline.samples.length >= 2) {
        riverSplineSegments += spline.samples.length - 1;
      }
    }
    profiler.recordMetric(
      "water river spline segments",
      riverSplineSegments,
      "count",
    );
  }
  const riverFillCoverage =
    geometryOverride?.riverFillCoverage ?? new Uint8Array(totalCells);
  const riverWaterTone =
    geometryOverride?.riverWaterTone ?? new Uint8Array(totalCells);

  const riverFillStop = geometryOverride
    ? undefined
    : profiler?.begin("water river fill rasterization");
  if (!geometryOverride) for (const spline of riverSplines) {
    // A one-point section is an orphaned raster cell, not a river segment.
    // Rendering it as a disk creates the isolated blue blobs visible beside
    // otherwise continuous channels.
    if (spline.samples.length < 2) continue;
    for (let segment = 0; segment < spline.samples.length - 1; segment++) {
      const start =
        spline.samples[Math.min(segment, spline.samples.length - 1)];
      const end =
        spline.samples[Math.min(segment + 1, spline.samples.length - 1)];
      const startTone = Math.min(
        245,
        Math.round(
          105 +
            start.order * 14 +
            Math.min(9, start.radius) * 8 +
            (hash01(start.sourceIndex + seed, 181) - 0.5) * 18,
        ),
      );
      const endTone = Math.min(
        245,
        Math.round(
          105 +
            end.order * 14 +
            Math.min(9, end.radius) * 8 +
            (hash01(end.sourceIndex + seed, 181) - 0.5) * 18,
        ),
      );
      paintCoverageSegment(
        riverFillCoverage,
        riverWaterTone,
        dem,
        start.x,
        start.y,
        start.radius,
        startTone,
        end.x,
        end.y,
        end.radius,
        endTone,
      );
    }
  }

  // An unroutable ecological patch still uses the same antialiased mask. It
  // cannot create a new flow strand because flow remains spline-only below.
  if (!geometryOverride) {
    // A DEM can carry a valid routed-water mask without a usable D8 centreline
    // (for example a short exported strip or a mouth whose receiver is outside
    // the tile). Keep that water visible with the same soft local fallback
    // instead of dropping the cell from the shared surface.
    for (let index = 0; index < totalCells; index++) {
      if (
        sourceRiverMask[index] === 1 &&
        !isOceanCell(dem, index) &&
        riverFillCoverage[index] === 0
      ) {
        riverFallbackMask[index] = 1;
      }
    }
    const softRiverCoverage = buildSoftMaskCoverage(
      riverFallbackMask,
      width,
      height,
    );
    for (let index = 0; index < totalCells; index++) {
      if (riverFallbackMask[index] === 1 && riverFillCoverage[index] < 32) {
        riverFillCoverage[index] = softRiverCoverage[index];
        riverWaterTone[index] = 125;
      }
    }
    closeRiverFillNotches(
      riverFillCoverage,
      riverWaterTone,
      sourceRiverMask,
      width,
      height,
    );
    for (let index = 0; index < totalCells; index++) {
      if (
        !isOceanCell(dem, index) &&
        riverFillCoverage[index] > waterAlpha[index]
      ) {
        waterAlpha[index] = riverFillCoverage[index];
      }
      if (riverFillCoverage[index] > 0) waterTone[index] = riverWaterTone[index];
    }
  } else {
    for (let index = 0; index < totalCells; index++) {
      if (riverFillCoverage[index] > 0) waterTone[index] = riverWaterTone[index];
    }
  }
  riverFillStop?.();

  const wetlandGeometryStop = profiler?.begin("water wetland geometry");
  const authoritativeWetlandPoolMask =
    dem.wetlandPoolMask?.length === totalCells
      ? dem.wetlandPoolMask
      : null;
  const wetlandPuddleGeometry = geometryOverride
    ? {
        alpha: new Uint8Array(totalCells),
        tone: new Uint8Array(totalCells),
        fillAlpha: geometryOverride.wetlandPuddleFillAlpha,
        fillTone: geometryOverride.wetlandPuddleFillTone,
        puddleMask: geometryOverride.wetlandPuddleMask,
        interiorDistance: geometryOverride.wetlandPuddleInteriorDistance,
      }
    : authoritativeWetlandPoolMask
    ? {
        alpha: new Uint8Array(totalCells),
        tone: new Uint8Array(totalCells),
        fillAlpha: new Uint8Array(totalCells),
        fillTone: new Uint8Array(totalCells),
        puddleMask: authoritativeWetlandPoolMask,
        interiorDistance: buildDistanceToCoast(
          authoritativeWetlandPoolMask,
          width,
          height,
        ),
      }
    : hasWetland && options.wetlandPuddleContours !== false
      ? buildWetlandPuddleContours(dem, {
          density: options.wetlandPuddleDensity,
          sizeMin: options.wetlandPuddleSizeMin,
          sizeMax: options.wetlandPuddleSizeMax,
          coastDistance: options.wetlandPuddleCoastDistance,
          // Wetland pocket shorelines are charcoal contours, so they share the
          // same thickness as river flow marks instead of having a second style.
          thickness: charcoalThickness,
          // Wetland shoreline ink is part of the shared charcoal style. Its
          // density and shape remain wetland-specific, but opacity does not.
          opacity: charcoalOpacity,
          seed: options.wetlandPuddleSeed ?? seed,
          coordinateScale: options.wetlandPuddleCoordinateScale,
          coordinateOffsetX: options.wetlandPuddleCoordinateOffsetX,
          coordinateOffsetY: options.wetlandPuddleCoordinateOffsetY,
          coordinateDomainWidth: options.wetlandPuddleCoordinateDomainWidth,
          coordinateDomainHeight: options.wetlandPuddleCoordinateDomainHeight,
          geometryOnly: true,
        })
      : {
          alpha: new Uint8Array(totalCells),
          tone: new Uint8Array(totalCells),
          fillAlpha: new Uint8Array(totalCells),
          fillTone: new Uint8Array(totalCells),
          puddleMask: new Uint8Array(totalCells),
          interiorDistance: new Float32Array(totalCells),
        };
  wetlandGeometryStop?.();

  // Distance measured from non-pool cells to the nearest generated pool.
  // River flow ink uses this to stop cleanly before entering an open pool;
  // carrying channel strokes through the pool reads as a leftover river bank
  // even though the fill and true outline have already been unioned.
  const wetlandDistanceStop = profiler?.begin(
    "water wetland and river distance fields",
  );
  let distanceToWetlandPool: Float32Array;
  let distanceToRiver: Float32Array | null = null;
  const waterBridgeMask = new Uint8Array(totalCells);
  let wetlandPoolCells = 0;
  if (geometryOverride) {
    distanceToWetlandPool = geometryOverride.distanceToWetlandPool;
  } else {
    const outsideWetlandPoolMask = new Uint8Array(totalCells);
    for (let index = 0; index < totalCells; index++) {
      if (wetlandPuddleGeometry.puddleMask[index] === 0) {
        outsideWetlandPoolMask[index] = 1;
      } else {
        if (profiler) wetlandPoolCells++;
      }
    }
    distanceToWetlandPool = buildDistanceToCoast(
      outsideWetlandPoolMask,
      width,
      height,
    );
    // Close only the small land slivers between a generated pool and the
    // visible river raster. Those slivers are usually classification pixels
    // (wetland versus river-channel biome), not intentional terrain. Bridging
    // them before smoothing lets the final outline follow one water body.
    const outsideRiverMask = new Uint8Array(totalCells);
    let hasVisibleRiver = false;
    for (let index = 0; index < totalCells; index++) {
      if (riverFillCoverage[index] > 28) {
        hasVisibleRiver = true;
      } else {
        outsideRiverMask[index] = 1;
      }
    }
    distanceToRiver = hasVisibleRiver
      ? buildDistanceToCoast(outsideRiverMask, width, height)
      : null;
    const poolRiverBridgeGap = Math.max(
      2.5,
      Math.min(
        7,
        3.5 *
          Math.max(
            0.25,
            options.wetlandPuddleCoordinateScale ?? options.oceanPixelScale ?? 1,
          ),
      ),
    );

    // Build the complete visual water geometry before any fill, outline, or
    // contour pass. Wetland pools stay visual-only (they never enter the DEM's
    // routing data), but every pool now participates in the exact same rendered
    // surface as rivers and ocean. Intersections therefore have no source edge
    // left for a later pass to accidentally draw or recolour.
    for (let index = 0; index < totalCells; index++) {
      if (
        oceanGeometrySource[index] < 0.5 &&
        riverFillCoverage[index] <= 28 &&
        wetlandPuddleGeometry.puddleMask[index] === 0 &&
        distanceToRiver &&
        distanceToWetlandPool[index] + distanceToRiver[index] <=
          poolRiverBridgeGap
      ) {
        waterBridgeMask[index] = 1;
      }
    }
  }
  wetlandDistanceStop?.();
  profiler?.recordMetric("water wetland pool cells", wetlandPoolCells, "count");

  // Union continuous coverages, not their thresholded masks. Export tiles
  // carry a low-resolution authoritative visualWaterMask for classification,
  // but using that mask as rendered geometry discards the mapped river
  // splines and repeats analysis-grid stair steps at output resolution. Ocean,
  // vector river, and pool coverage now meet before the shared smoothing pass,
  // so the 50% shoreline and its outline are derived from one sub-pixel field.
  const unionStop = geometryOverride
    ? undefined
    : profiler?.begin("water-body union and smoothing");
  let oceanCoverage: Uint8Array;
  let cleanWaterMask: Uint8Array;
  let bankWaterMask: Uint8Array;
  let smoothShore: Float32Array | null = null;
  if (geometryOverride) {
    oceanCoverage = geometryOverride.oceanCoverage;
    cleanWaterMask = geometryOverride.cleanWaterMask;
    bankWaterMask = geometryOverride.bankWaterMask;
  } else {
    const combinedWaterSource = new Float32Array(totalCells);
    for (let index = 0; index < totalCells; index++) {
      combinedWaterSource[index] = Math.max(
        oceanGeometrySource[index],
        riverFillCoverage[index] / 255,
        dem.wetlandPoolCoverage?.[index] ??
          wetlandPuddleGeometry.puddleMask[index],
        waterBridgeMask[index],
      );
    }
    const combinedCoverage = buildSmoothedWaterCoverage(
      combinedWaterSource,
      width,
      height,
      coveragePasses,
    );
    // Use the same coverage pass for ocean and rivers. A separate, wider ocean
    // blur makes the fractional water fill spill onto land and turns the shared
    // outline into a shadow-like halo. Global Outline thickness must be the only
    // control that changes the visible shoreline stroke width.
    oceanCoverage = buildSmoothedWaterCoverage(
      oceanGeometrySource,
      width,
      height,
      coveragePasses,
    );
    // Preserve the continuous ocean surface separately from the combined water
    // alpha. The detail renderer uses this discriminator at antialiased coast
    // pixels so they do not get mistaken for river water merely because their
    // binary DEM cell is land.
    for (let index = 0; index < totalCells; index++) {
      oceanWaterAlpha[index] = oceanCoverage[index];
    }
    for (let index = 0; index < totalCells; index++) {
      // Preserve opaque routed cores while retaining the smoothed fractional
      // edge from the shared union field.
      waterAlpha[index] = Math.max(
        combinedCoverage[index],
        oceanCoverage[index],
        riverFillCoverage[index],
      );
    }

    // Every later pass uses the actual final fill. This keeps the bank ring,
    // coast distance, and ocean/river mouth transition aligned with the pixels
    // that were painted as water rather than with a separate source mask.
    cleanWaterMask = new Uint8Array(totalCells);
    for (let index = 0; index < totalCells; index++) {
      if (waterAlpha[index] > 28) cleanWaterMask[index] = 1;
    }

    // Bank geometry follows the actual 50% fill boundary, not every pixel in
    // the antialias fringe. Export coverage is intentionally pre-smoothed; using
    // the low-alpha fringe as shoreline turns that smoothing into a wide dark
    // halo whose width grows with export resolution.
    bankWaterMask = new Uint8Array(totalCells);
    for (let index = 0; index < totalCells; index++) {
      if (waterAlpha[index] >= 128) bankWaterMask[index] = 1;
    }

    // The raster fill and every mask above end on source-cell boundaries, and
    // blurring them cannot remove steps wider than the blur. Trace the 50%
    // shoreline instead, smooth that curve over about one source cell, and
    // derive the fill edge, bank mask and outline distance from the curve.
    smoothShore = buildSmoothShoreDistance(
      waterAlpha,
      width,
      height,
      options.riverCellPx ?? 1,
      outlineThickness * 0.5 + 2.5 + 2 * Math.max(1, options.riverCellPx ?? 1),
    );
    if (smoothShore) {
      for (let index = 0; index < totalCells; index++) {
        const distance = smoothShore[index];
        if (Math.abs(distance) >= SHORE_UNREACHED) continue;
        waterAlpha[index] = Math.round(clamp01(0.5 - distance) * 255);
        bankWaterMask[index] = distance < 0 ? 1 : 0;
        cleanWaterMask[index] = waterAlpha[index] > 28 ? 1 : 0;
      }
    }
  }
  unionStop?.();

  const riverContourStop = geometryOverride
    ? undefined
    : profiler?.begin("water river contour field");
  const riverContourAlpha = geometryOverride?.riverContourAlpha
    ? geometryOverride.riverContourAlpha.slice()
    : buildRiverContourAlpha(
        riverSplines,
        waterAlpha,
        dem,
        options.oceanPixelScale,
        strokeGeometry,
      );
  riverContourStop?.();

  // Inland water outlines follow the combined surface, while the ocean coast
  // uses the same global Outline style. Near-coast contour marks are a
  // separate charcoal layer and never participate in this boundary pass.
  const shorelineDistanceStop = geometryOverride
    ? undefined
    : profiler?.begin("water shoreline distance fields");
  const distanceToWater =
    geometryOverride?.distanceToWater ?? (() => {
      const landMask = new Uint8Array(totalCells);
      for (let index = 0; index < totalCells; index++) {
        if (bankWaterMask[index] === 0) landMask[index] = 1;
      }
      return buildDistanceToCoast(landMask, width, height);
    })();
  const distanceToLand =
    geometryOverride?.distanceToLand ??
    buildDistanceToCoast(bankWaterMask, width, height);
  // Sub-pixel shoreline shared by the outline ring and inland contours.
  let smoothShoreSigned: Float32Array | null =
    geometryOverride?.shoreSignedDistance ?? null;
  if (!smoothShoreSigned && smoothShore) {
    smoothShoreSigned = smoothShore;
    for (let index = 0; index < totalCells; index++) {
      if (Math.abs(smoothShoreSigned[index]) < SHORE_UNREACHED) continue;
      smoothShoreSigned[index] = bankWaterMask[index] === 1
        ? -(distanceToLand[index] - 0.5)
        : distanceToWater[index] - 0.5;
    }
  }
  const shoreSignedDistance = mode === "geometry"
    ? null
    : smoothShoreSigned ?? buildSubpixelShoreDistance(
        waterAlpha,
        bankWaterMask,
        distanceToWater,
        distanceToLand,
        width,
        height,
      );
  shorelineDistanceStop?.();

  // Derive inland colour from the final union's shoreline distance. This is
  // one continuous tone field, so a river entering a pool cannot retain a
  // discharge-colour rectangle or split the pool into two washes.
  const inlandToneScale = Math.max(
    0.25,
    options.wetlandPuddleCoordinateScale ?? options.oceanPixelScale ?? 1,
  );
  // Lakes additionally deepen with the DEM basin below them, using the
  // ocean's cosine shallow-to-deep wash so both water bodies read alike.
  const lakeDepthM =
    dem.lakeDepthM?.length === totalCells ? dem.lakeDepthM : null;
  const lakeFullDepthM = Math.max(0.5, options.lakeFullDepthM ?? 15);
  if (mode !== "geometry") {
    for (let index = 0; index < totalCells; index++) {
      if (waterAlpha[index] === 0 || oceanCoverage[index] >= 128) continue;
      const inlandDepth = smoothstep(
        0.5,
        14 * inlandToneScale,
        distanceToLand[index],
      );
      let tone = 222 - inlandDepth * 34;
      const lakeDepth = lakeDepthM?.[index] ?? 0;
      if (lakeDepth > 0) {
        const lakeT = clamp01(lakeDepth / lakeFullDepthM) * inlandDepth;
        tone = Math.min(tone, 127.5 * (1 + Math.cos(lakeT * Math.PI)));
      }
      waterTone[index] = Math.round(tone);
    }
  }

  const riverCenterlineCoverage = new Uint8Array(totalCells);
  const poolFlowClearance = Math.max(
    2.5 * inlandToneScale,
    charcoalThickness * 1.5,
  );
  if (mode !== "geometry") {
    for (let index = 0; index < totalCells; index++) {
      const oceanBlend = clamp01(oceanCoverage[index] / 255);
      if (
        dem.isRiverChannel?.[index] === 1 &&
        oceanBlend < 1 &&
        distanceToWetlandPool[index] > poolFlowClearance
      ) {
        riverCenterlineCoverage[index] = Math.round(
          Math.max(riverFillCoverage[index], waterAlpha[index]) *
            (1 - smoothstep(0.08, 0.82, oceanBlend)),
        );
      }
    }
  }

  // Inland water gets an inner contour; pools get two rings following their
  // own shoreline, without river centreline ink inside the pool footprint.
  const inlandContoursStop = mode === "geometry"
    ? undefined
    : profiler?.begin("water inland contours");
  const inlandWaterContours = mode === "geometry"
    ? { alpha: new Uint8Array(totalCells), tone: new Uint8Array(totalCells) }
    : buildUnifiedInlandWaterContours(
        bankWaterMask,
        oceanCoverage,
        shoreSignedDistance!,
        width,
        height,
        {
          thickness: charcoalThickness,
          opacity: showWaterDetails ? charcoalOpacity : 0,
          density: charcoalDensity,
          length: charcoalLength,
          poolMask: wetlandPuddleGeometry.puddleMask,
          poolLength: Math.max(
            0.1,
            options.poolContourLength ?? charcoalLength,
          ),
          smoothing: flowSmoothing,
          seed: options.wetlandPuddleSeed ?? seed,
          coordinateScale:
            options.wetlandPuddleCoordinateScale ?? options.oceanPixelScale,
          coordinateOffsetX:
            options.wetlandPuddleCoordinateOffsetX ??
            options.oceanCoordinateOffsetX,
          coordinateOffsetY:
            options.wetlandPuddleCoordinateOffsetY ??
            options.oceanCoordinateOffsetY,
          coordinateStride:
            options.wetlandPuddleCoordinateDomainWidth ??
            options.oceanCoordinateStride,
        },
      );
  inlandContoursStop?.();

  const oceanDistanceStop = geometryOverride
    ? undefined
    : profiler?.begin("water ocean shoreline distance fields");
  const oceanBankWaterMask =
    geometryOverride?.oceanBankWaterMask ?? new Uint8Array(totalCells);
  const oceanLandMask = new Uint8Array(totalCells);
  let hasOceanBank = geometryOverride?.hasOceanBank ?? false;
  let oceanBankCells = 0;
  if (!geometryOverride) {
    for (let index = 0; index < totalCells; index++) {
      if (oceanCoverage[index] >= 128) {
        oceanBankWaterMask[index] = 1;
        hasOceanBank = true;
        if (profiler) oceanBankCells++;
      } else {
        oceanLandMask[index] = 1;
      }
    }
  }
  const oceanDistanceToWater =
    geometryOverride?.oceanDistanceToWater ??
    buildDistanceToCoast(oceanLandMask, width, height);
  const oceanDistanceToLand =
    geometryOverride?.oceanDistanceToLand ??
    buildDistanceToCoast(oceanBankWaterMask, width, height);
  oceanDistanceStop?.();
  profiler?.recordMetric("water ocean bank cells", oceanBankCells, "count");

  const bankMarkScale = Math.max(0.25, options.oceanPixelScale ?? 1);
  const bankCoordinateOffsetX = options.oceanCoordinateOffsetX ?? 0;
  const bankCoordinateOffsetY = options.oceanCoordinateOffsetY ?? 0;
  const bankCoordinateStride = Math.max(
    1,
    Math.round(options.oceanCoordinateStride ?? width),
  );

  const paintBankRing = (
    target: Uint8Array,
    signedShoreDistance: Float32Array,
    coverage: Uint8Array,
    thickness: number,
    opacity: number,
    smoothing: number,
  ): void => {
    if (thickness <= 0 || opacity <= 0 || !showWaterDetails) return;
    const halfThickness = thickness * 0.5;
    for (let index = 0; index < totalCells; index++) {
      const distance = Math.abs(signedShoreDistance[index]);
      if (distance > halfThickness + 0.5) continue;

      let adjacentCoverage = 0;
      const x = index % width;
      const y = Math.floor(index / width);
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const sampleY = y + offsetY;
        if (sampleY < 0 || sampleY >= height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const sampleX = x + offsetX;
          if (sampleX < 0 || sampleX >= width) continue;
          adjacentCoverage = Math.max(
            adjacentCoverage,
            coverage[sampleY * width + sampleX],
          );
        }
      }
      const ring = clamp01(halfThickness - distance + 0.5);
      const edgeStrength = 0.55 + 0.45 * (adjacentCoverage / 255);
      // Correlate paper-tooth variation in output space. Hashing the local
      // tile index independently made a high-resolution coast look noisy and
      // could change its edge at a tile boundary; a scaled global coordinate
      // keeps the hand-ink texture smooth and deterministic across tiles.
      const globalX = Math.floor(
        (x + bankCoordinateOffsetX) / bankMarkScale,
      );
      const globalY = Math.floor(
        (y + bankCoordinateOffsetY) / bankMarkScale,
      );
      const bankNoiseIndex = globalY * bankCoordinateStride + globalX;
      const ink =
        0.86 +
        (hash01(bankNoiseIndex + seed, 193) - 0.5) *
          (0.06 / (1 + smoothing));
      target[index] = Math.round(
        clamp01(ring * edgeStrength * opacity * ink) * 255,
      );
    }
  };

  const bankRingStop = mode === "geometry"
    ? undefined
    : profiler?.begin("water bank ring rasterization");
  if (mode !== "geometry") {
    paintBankRing(
      outlineBankAlpha,
      shoreSignedDistance!,
      waterAlpha,
      outlineThickness,
      outlineOpacity,
      outlineSmoothing,
    );
    const halfOutlineThickness = outlineThickness * 0.5;
    for (let index = 0; index < totalCells; index++) {
      bankAlpha[index] = outlineBankAlpha[index];
      if (outlineBankAlpha[index] === 0 || !hasOceanBank) continue;
      const oceanDistance = (
        oceanBankWaterMask[index] === 1
          ? oceanDistanceToLand[index]
          : oceanDistanceToWater[index]
      ) - 0.5;
      if (oceanDistance <= halfOutlineThickness + 0.75) {
        oceanBankAlpha[index] = outlineBankAlpha[index];
      }
    }
  }
  bankRingStop?.();

  const coastalFieldsStop = geometryOverride
    ? undefined
    : profiler?.begin("water coastal wave fields");
  const oceanDetailMask =
    geometryOverride?.oceanDetailMask ?? new Uint8Array(totalCells);
  let oceanDetailCells = 0;
  if (geometryOverride) {
    if (profiler) {
      for (let index = 0; index < totalCells; index++) {
        if (oceanDetailMask[index] === 1) oceanDetailCells++;
      }
    }
  } else {
    for (let index = 0; index < totalCells; index++) {
      if (filteredOceanMask[index] === 1 && cleanWaterMask[index] === 1) {
        oceanDetailMask[index] = 1;
        if (profiler) oceanDetailCells++;
      }
    }
  }
  // Waves run up to the shore, but only on the outer open sea. Flooded river
  // valleys, estuaries and lagoons are excluded by the same morphological
  // opening that decides where sandy beaches form.
  let openOceanMask = geometryOverride?.openOceanMask;
  if (!geometryOverride) {
    const override = options.openOceanMaskOverride;
    if (override?.length === totalCells) {
      openOceanMask = new Uint8Array(totalCells);
      for (let index = 0; index < totalCells; index++) {
        if (override[index] >= 0.5) openOceanMask[index] = 1;
      }
    } else if (oceanDetailMask.includes(1)) {
      const openOceanStop = profiler?.begin("water open ocean mask");
      openOceanMask = extractDeepOpenOceanMask(
        filteredOceanMask,
        dem.isRiverChannel ?? new Uint8Array(totalCells),
        width,
        height,
        OPEN_OCEAN_REFERENCE_RADIUS *
          Math.max(width, height) / OPEN_OCEAN_REFERENCE_LONG_EDGE,
      );
      openOceanStop?.();
    }
  }
  // Separable smoothing is the bounded default. The Laplacian path remains
  // available when an export explicitly requests diffusion iterations.
  const smoothingIterations = Math.max(
    0,
    Math.floor(options.distanceSmoothingIterations ?? 0),
  );
  const effectiveSmoothingIterations = Math.max(
    0,
    Math.floor(options.effectiveDistanceSmoothingIterations ?? 0),
  );
  profiler?.recordMetric(
    "water coast diffusion iterations",
    smoothingIterations + effectiveSmoothingIterations,
    "iterations",
  );
  let distanceToCoast: Float32Array;
  let effectiveDistanceToCoast: Float32Array;
  let coastWaveField: Float32Array;
  if (geometryOverride) {
    distanceToCoast = geometryOverride.distanceToCoast;
    effectiveDistanceToCoast = geometryOverride.effectiveDistanceToCoast;
    const requestedWaveFieldKey = coastalWaveFieldKey(
      seed,
      outlineLength,
      options.oceanPixelScale,
      options.oceanCoordinateOffsetX,
      options.oceanCoordinateOffsetY,
    );
    if (
      geometryOverride.waveFieldKey === requestedWaveFieldKey &&
      (geometryOverride.coastWaveField ?? geometryOverride.waveField).length ===
        totalCells
    ) {
      // Guidance is immutable. The paint stage writes its own output field,
      // so a style-only update no longer clones the cached guidance array.
      coastWaveField =
        geometryOverride.coastWaveField ?? geometryOverride.waveField;
    } else {
      const coastWaveFieldStop = profiler?.begin(
        "water coast wave field construction",
      );
      coastWaveField = buildCoastWaveField(
        oceanDetailMask,
        distanceToCoast,
        width,
        height,
        outlineLength,
        seed,
        options.oceanCoordinateOffsetX,
        options.oceanCoordinateOffsetY,
        options.oceanPixelScale,
      );
      coastWaveFieldStop?.();
    }
  } else {
    const rawDistanceToCoast =
      options.oceanDistanceToCoastOverride?.length === totalCells
        ? options.oceanDistanceToCoastOverride
        : buildDistanceToCoast(cleanWaterMask, width, height);
    const coastStencilStop = profiler?.begin("water coast diffusion stencil");
    const coastLaplacianStencil =
      smoothingIterations === 0 && effectiveSmoothingIterations === 0
        ? undefined
        : buildLaplacianStencil(cleanWaterMask, width, height);
    coastStencilStop?.();
    const baseCoastSmoothingStop = profiler?.begin(
      "water coast base distance smoothing",
    );
    const baseDistanceToCoast = smoothDistanceField(
      rawDistanceToCoast,
      width,
      height,
      Math.max(2, outlineSmoothing + 1),
    );
    baseCoastSmoothingStop?.();
    const coastDistanceSmoothingStop = profiler?.begin(
      "water coast distance smoothing",
    );
    distanceToCoast =
      smoothingIterations === 0
        ? smoothFieldSeparable(
            baseDistanceToCoast,
            width,
            height,
            Math.max(2, outlineSmoothing + 1) *
              Math.max(0.25, options.oceanPixelScale ?? 1),
            2,
            cleanWaterMask,
          )
        : smoothDistanceFieldLaplacian(
            baseDistanceToCoast,
            cleanWaterMask,
            width,
            height,
            smoothingIterations,
            0.23,
            coastLaplacianStencil,
          );
    coastDistanceSmoothingStop?.();
    const coastWaveFieldStop = profiler?.begin(
      "water coast wave field construction",
    );
    coastWaveField = buildCoastWaveField(
      oceanDetailMask,
      distanceToCoast,
      width,
      height,
      outlineLength,
      seed,
      options.oceanCoordinateOffsetX,
      options.oceanCoordinateOffsetY,
      options.oceanPixelScale,
    );
    coastWaveFieldStop?.();
    const effectiveCoastSmoothingStop = profiler?.begin(
      "water effective coast distance smoothing",
    );
    effectiveDistanceToCoast =
      effectiveSmoothingIterations === 0
        ? smoothFieldSeparable(
            distanceToCoast,
            width,
            height,
            Math.max(2, outlineSmoothing + 1) *
              Math.max(0.25, options.oceanPixelScale ?? 1),
            1,
            cleanWaterMask,
          )
        : smoothDistanceFieldLaplacian(
            distanceToCoast,
            cleanWaterMask,
            width,
            height,
            effectiveSmoothingIterations,
            0.22,
            coastLaplacianStencil,
          );
    effectiveCoastSmoothingStop?.();
  }
  coastalFieldsStop?.();
  profiler?.recordMetric("water ocean detail cells", oceanDetailCells, "count");

  if (mode === "geometry") {
    return {
      width,
      height,
      raw: false,
      sourceOceanMask,
      sourceOceanCoverage,
      sourceRiverMask,
      filteredOceanMask,
      sourceWaterMask,
      oceanGeometrySource: oceanGeometrySource as Uint8Array | Float32Array,
      riverSplines,
      riverFillCoverage,
      riverWaterTone,
      wetlandPuddleMask: wetlandPuddleGeometry.puddleMask,
      wetlandPuddleFillAlpha: wetlandPuddleGeometry.fillAlpha,
      wetlandPuddleFillTone: wetlandPuddleGeometry.fillTone,
      wetlandPuddleInteriorDistance: wetlandPuddleGeometry.interiorDistance,
      distanceToWetlandPool,
      riverContourAlpha,
      strokeGeometry,
      coastWaveField,
      // Retain the historical geometry field alias for callers that inspect
      // it directly. Paint passes use coastWaveField and never mutate it.
      waveField: coastWaveField,
      waveFieldKey: coastalWaveFieldKey(
        seed,
        outlineLength,
        options.oceanPixelScale,
        options.oceanCoordinateOffsetX,
        options.oceanCoordinateOffsetY,
      ),
      waterAlpha,
      oceanCoverage,
      cleanWaterMask,
      bankWaterMask,
      distanceToWater,
      distanceToLand,
      shoreSignedDistance: smoothShoreSigned ?? undefined,
      oceanBankWaterMask,
      oceanDistanceToWater,
      oceanDistanceToLand,
      hasOceanBank,
      oceanDetailMask,
      openOceanMask,
      distanceToCoast,
      effectiveDistanceToCoast,
    };
  }

  // The visible output field is separate from the immutable coast guidance.
  // It is only allocated for a paint pass and is filled by the final tone
  // stage below.
  const waveField = new Float32Array(totalCells);

  const flowAlpha = new Uint8Array(totalCells);
  const flowTone = new Uint8Array(totalCells);
  const oceanDetailsStop = profiler?.begin("water ocean detail marks");
  if (showWaterDetails) {
    const oceanRippleCount = Math.max(
      1,
      Math.min(
        OCEAN_RIPPLE_BANDS.length,
        Math.round(options.oceanRippleCount ?? 5),
      ),
    );
    // Near-coast contour/ripple bands are charcoal marks. Keep this pass
    // completely separate from actual deep-ocean wave strokes so the two
    // styles cannot affect or recolor each other.
    const oceanContours = paintOceanLineMarks(
      oceanDetailMask,
      effectiveDistanceToCoast,
      width,
      height,
      {
        rippleCount: oceanRippleCount,
        coastalDensity: charcoalDensity,
        coastalLength: charcoalLength,
        deepOceanEnabled: false,
        deepOceanDensity: 0,
        deepOceanLength: 1,
        deepOceanMinDist: 0,
        waveThickness: charcoalThickness,
        waveOpacity: charcoalOpacity * OCEAN_COASTAL_CONTOUR_OPACITY,
        smoothing: flowSmoothing,
        seed,
        waveField: coastWaveField,
        pixelScale: options.oceanPixelScale,
        coordinateOffsetX: options.oceanCoordinateOffsetX,
        coordinateOffsetY: options.oceanCoordinateOffsetY,
        coordinateStride: options.oceanCoordinateStride,
      },
    );

    // Offshore waves use a separate path pass so their blue paint and foam
    // remain independent from the charcoal coastal contours.
    const oceanClipStop = profiler?.begin("water offshore ocean clip");
    const waveOceanClip = new Uint8Array(totalCells);
    for (let index = 0; index < totalCells; index++) {
      if (
        oceanDetailMask[index] === 1 &&
        riverCenterlineCoverage[index] <= 28 &&
        (!openOceanMask || openOceanMask[index] === 1)
      ) {
        waveOceanClip[index] = 1;
      }
    }
    oceanClipStop?.();
    if (options.deepOceanSwells !== false && outlineOpacity > 0) {
      const turbulenceStop = profiler?.begin("water ocean turbulence field");
      oceanTurbulenceAlpha.set(
        buildOceanTurbulenceAlpha(
          waveOceanClip,
          effectiveDistanceToCoast,
          width,
          height,
          seed,
          Math.max(0.25, options.oceanPixelScale ?? 1),
          deepOceanTurbulenceScale,
          deepOceanTurbulenceIntensity,
          outlineOpacity,
          Math.max(0, options.deepOceanSwellDensity ?? 0.18),
          oceanRippleCount,
          options.oceanCoordinateOffsetX ?? 0,
          options.oceanCoordinateOffsetY ?? 0,
        ),
      );
      turbulenceStop?.();
    }
    const wavePathStop = profiler?.begin("water ocean wave path rasterization");
    const oceanWaves = paintOceanLineMarks(
      waveOceanClip,
      effectiveDistanceToCoast,
      width,
      height,
      {
        rippleCount: 1,
        coastalDensity: 0,
        coastalLength: outlineLength,
        deepOceanEnabled: options.deepOceanSwells !== false,
        // Keep the default offshore field legible at preview scale. Explicit
        // values remain untouched so existing maps can preserve their density.
        deepOceanDensity: Math.max(0, options.deepOceanSwellDensity ?? 0.18),
        deepOceanLength,
        // No shoreline gap: the open-sea clip keeps waves out of rivers.
        deepOceanMinDist: 0,
        waveThickness: deepOceanThickness,
        deepOceanWaveShadingScale,
        deepOceanWaveShadingIntensity,
        waveOpacity: outlineOpacity,
        smoothing: outlineSmoothing,
        seed,
        waveField: coastWaveField,
        coastalTransitionBands: oceanRippleCount,
        pixelScale: options.oceanPixelScale,
        coordinateOffsetX: options.oceanCoordinateOffsetX,
        coordinateOffsetY: options.oceanCoordinateOffsetY,
        coordinateStride: options.oceanCoordinateStride,
        distanceNormalizationMax: options.oceanDistanceNormalizationMax,
        paintWindow: options.paintWindow,
      },
    );
    wavePathStop?.();
    if (oceanWaves.lightAlpha) oceanWaveLightAlpha.set(oceanWaves.lightAlpha);
    if (oceanWaves.shadowAlpha) oceanWaveShadowAlpha.set(oceanWaves.shadowAlpha);
    if (oceanWaves.foamAlpha) crestAlpha.set(oceanWaves.foamAlpha);
    if (oceanWaves.inkAlpha) oceanWaveInkAlpha.set(oceanWaves.inkAlpha);
    for (let index = 0; index < totalCells; index++) {
      // Reserve routed river cells at an outlet. Ocean contour and wave
      // strokes can approach the mouth but never paint back over the channel.
      if (riverCenterlineCoverage[index] <= 28) {
        if (oceanContours.alpha[index] > flowAlpha[index]) {
          flowAlpha[index] = oceanContours.alpha[index];
          flowTone[index] = oceanContours.tone[index];
        }
        oceanFlowAlpha[index] = oceanWaves.alpha[index];
        oceanFlowTone[index] = oceanWaves.tone[index];
      }
    }
  }
  oceanDetailsStop?.();

  // All charcoal geometry shares one alpha/tone buffer and therefore one
  // compositor. This prevents pools, river centrelines, and coastal marks
  // from acquiring different color/tooth treatment after rasterization.
  for (let index = 0; index < totalCells; index++) {
    if (inlandWaterContours.alpha[index] <= flowAlpha[index]) continue;
    flowAlpha[index] = inlandWaterContours.alpha[index];
    flowTone[index] = inlandWaterContours.tone[index];
  }

  // Apply the ocean's depth/wave tone only to ocean pixels. River colour and
  // routed flow geometry remain intact right up to the shared mouth boundary.
  const finalToneStop = profiler?.begin("water final ocean tone");
  const markScale = Math.max(0.25, options.oceanPixelScale ?? 1);
  for (let index = 0; index < totalCells; index++) {
    if (oceanDetailMask[index] !== 1) continue;
    // Keep the bilinear edge coverage in tiled exports instead of snapping
    // every source ocean cell back to opaque.  Interior cells remain fully
    // covered, while the fractional edge survives into the final PNG and
    // removes the hard staircase that a binary 2048 mask would introduce.
    // Next to the traced shoreline the fill already follows the smooth curve.
    if (smoothShoreSigned && Math.abs(smoothShoreSigned[index]) < 1.5) {
      // keep the traced edge
    } else if (options.oceanMaskCoverageOverride?.length === totalCells) {
    waterAlpha[index] = Math.max(
        waterAlpha[index],
        Math.round(sourceOceanCoverage[index] * 255),
      );
    } else {
      waterAlpha[index] = 255;
    }
    const dist = distanceToCoast[index];
    const coastT = Math.max(
      0,
      Math.min(1.0, dist / (95.0 * markScale)),
    );
    // Keep the broad coast-depth wash; wave shading now follows the actual
    // traced ridges in oceanWaveLightAlpha and oceanWaveShadowAlpha.
    const coastShallow = 0.5 * (1.0 + Math.cos(coastT * Math.PI));
    const toneVal = Math.round(clamp01(coastShallow) * 255);
    waterTone[index] = toneVal;
    oceanWaterAlpha[index] = 255;
    oceanWaterTone[index] = toneVal;
    waveField[index] = Math.max(0, coastWaveField[index] ?? 0, oceanFlowAlpha[index] / 255);
  }
  finalToneStop?.();

  const wetlandPuddlePriorityAlpha = new Uint8Array(totalCells);
  for (let index = 0; index < totalCells; index++) {
    wetlandPuddlePriorityAlpha[index] = Math.round(
      clamp01(
        dem.wetlandPoolCoverage?.[index] ??
          wetlandPuddleGeometry.puddleMask[index],
      ) * 255,
    );
  }

  return {
    width,
    height,
    waterAlpha,
    waterTone,
    bankAlpha,
    outlineBankAlpha,
    flowAlpha,
    flowTone,
    crestAlpha,
    oceanWaveLightAlpha,
    oceanWaveShadowAlpha,
    oceanWaveInkAlpha,
    oceanTurbulenceAlpha,
    waveField,
    distanceToCoast,
    riverContourAlpha,
    wetlandPuddleContourAlpha: inlandWaterContours.alpha,
    wetlandPuddleContourTone: inlandWaterContours.tone,
    wetlandPuddlePriorityAlpha,
    // Kept as empty compatibility buffers for consumers compiled against the
    // old separate-puddle compositor. Pool fill now lives in waterAlpha.
    wetlandPuddleFillAlpha: geometryOverride
      ? wetlandPuddleGeometry.fillAlpha.slice()
      : wetlandPuddleGeometry.fillAlpha,
    wetlandPuddleFillTone: geometryOverride
      ? wetlandPuddleGeometry.fillTone.slice()
      : wetlandPuddleGeometry.fillTone,
    seedOrigins: [],
    oceanWaterAlpha,
    oceanWaterTone,
    oceanBankAlpha,
    oceanFlowAlpha,
    oceanFlowTone,
  };
}

export function renderWaterOverlay(
  dem: MountainDEMData,
  options: WaterRendererOptions,
  profiler?: MountainProfiler,
): WaterOverlay {
  return renderWaterOverlayInternal(dem, options, profiler) as WaterOverlay;
}

export function buildWaterOverlayGeometry(
  dem: MountainDEMData,
  options: WaterRendererOptions,
  profiler?: MountainProfiler,
): WaterOverlayGeometry {
  return renderWaterOverlayInternal(
    dem,
    options,
    profiler,
    undefined,
    "geometry",
  ) as WaterOverlayGeometry;
}

export function renderWaterOverlayFromGeometry(
  dem: MountainDEMData,
  options: WaterRendererOptions,
  geometry: WaterOverlayGeometry,
  profiler?: MountainProfiler,
): WaterOverlay {
  if (geometry.raw) return paintRawWaterOverlay(geometry);
  return renderWaterOverlayInternal(
    dem,
    options,
    profiler,
    geometry,
    "paint",
  ) as WaterOverlay;
}

/**
 * The `waterAlpha` a paint pass would produce, without painting any marks.
 * Painting only promotes ocean-detail cells (the final ocean tone step), so
 * vegetation can start from geometry while the ocean waves are still drawn.
 */
export function paintedWaterAlphaFromGeometry(
  options: WaterRendererOptions,
  geometry: WaterOverlayGeometry,
): Uint8Array {
  if (geometry.raw) return paintRawWaterOverlay(geometry).waterAlpha;
  const totalCells = geometry.width * geometry.height;
  const waterAlpha = geometry.waterAlpha.slice();
  const keepCoverage = options.oceanMaskCoverageOverride?.length === totalCells;
  const shore = geometry.shoreSignedDistance;
  for (let index = 0; index < totalCells; index++) {
    if (geometry.oceanDetailMask[index] !== 1) continue;
    if (shore && Math.abs(shore[index]) < 1.5) continue;
    waterAlpha[index] = keepCoverage
      ? Math.max(waterAlpha[index], Math.round(geometry.sourceOceanCoverage[index] * 255))
      : 255;
  }
  return waterAlpha;
}

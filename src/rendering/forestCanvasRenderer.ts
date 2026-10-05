/**
 * Draws forest stands to a canvas and holds the forest render settings.
 */
import { MIN_POSITIVE_SCALE as P } from "../config/inspectorBounds";
import { buildForestLightField, getForestLightTextureCanvas } from "./forestPropLighting";
import {
  buildForestPropStandGeometry,
  findForestPropOverlapFlags,
  forestPropInkRetentionAtDepth,
  thinForestInkRuns,
  type ForestPropCrown,
} from "./forestPropDensity";
import { createCharcoalStrokeRuns } from "./cartographicStrokeRenderer";
import { parseHexColor, varyColorHsv } from "./propColorVariation";
import type { MountainProfiler } from "./mountainProfiler";
import type {
  VegetationMotifVectorPath,
  VegetationRasterPropAsset,
  VegetationRasterPropPlacement,
  VegetationStrokePoint,
} from "./vegetationRenderer";

export interface ForestRenderSettings {
  seed: number;
  density: number;
  clustering: number;
  canopyMerging: number;
  canopyEdgeNoiseSize: number;
  canopyWashNoiseSize: number;
  canopyWashStrength: number;
  outlineShadowStrength: number;
  outlineInsetStrength: number;
  outlineInsetBlurRadius: number;
  lightStrength: number;
  sunAzimuthDeg: number;
  lightEdgeDepth: number;
  lightSoftness: number;
  lightNoise: number;
  lightColor: string;
  /** Charcoal outline color supplied by the Mountain palette. */
  outlineColor: string;
  /** Palette color for alpine tree foliage (replaces the SVG's authored fill). */
  alpineCanopyColor: string;
  /** Palette colors for wetland tree crowns and trunks (the shrub stands' accent trees). */
  wetlandCanopyColor: string;
  wetlandWoodColor: string;
  /** Palette color for wetland shrub stands (the wash is this colour darkened). */
  wetlandShrubColor: string;
  /** Opacity multiplier shared by charcoal marks on raster props. */
  propCharcoalAlpha: number;
  /** Full per-prop fill variation ranges: hue in degrees, saturation/value in 0..1. */
  hueVariance: number;
  saturationVariance: number;
  valueVariance: number;
  /** How strongly DEM hillshade darkens props on shadow-side slopes. */
  terrainShadeStrength: number;
  centerLightGradientMultiplier: number;
  charcoalThickness: number;
  charcoalInterruptionProbability: number;
  centerInterruptionAmountBoost: number;
  centerInterruptionLengthMultiplier: number;
  centerDepthThreshold: number;
  minCenterOutlineChance: number;
  centerSegmentRemoval: number;
  showCenterDebug: boolean;
  showFootprints: boolean;
  overlapLowerInterruptionMultiplier: number;
  charcoalInterruptionLength: number;
  /**
   * Alpine forest stands (forestStandGeometry): placement controls rebuild
   * the vegetation geometry; the wash and ink controls only repaint.
   * Stand trees use `alpineCanopyColor` for their body (the wash is that
   * colour darkened) and `outlineColor` for ink.
   */
  standMarkSpacing: number;
  standEdgeTrees: number;
  standInteriorTrees: number;
  standMeadowTrees: number;
  /** Share of shrub-stand plants drawn as wetland trees. */
  standAccentTrees: number;
  standInkWeight: number;
  standWashStrength: number;
  standWashVariation: number;
  standWashSoftness: number;
  /** How strongly terrain light colours stand trees and wash. */
  standLightStrength: number;
}

/**
 * The normalized forest scale is authored against the live mountain preview
 * analysis domain. Export geometry converts it to its own map resolution.
 */
export const FOREST_REFERENCE_LONG_EDGE = 2048;

export const DEFAULT_FOREST_RENDER_SETTINGS: ForestRenderSettings = {
  seed: 23817,
  density: 0.8,
  clustering: 0.72,
  canopyMerging: 23,
  canopyEdgeNoiseSize: 1.1,
  canopyWashNoiseSize: 1.7,
  canopyWashStrength: 1.96,
  outlineShadowStrength: 1,
  outlineInsetStrength: 0.25,
  outlineInsetBlurRadius: 2.5,
  lightStrength: 0.42,
  sunAzimuthDeg: 330,
  lightEdgeDepth: 0.075,
  lightSoftness: 0.68,
  lightNoise: 0.82,
  lightColor: "#91ab84",
  outlineColor: "#283b29",
  alpineCanopyColor: "#567b54",
  wetlandCanopyColor: "#a5ac71",
  wetlandWoodColor: "#b19f69",
  wetlandShrubColor: "#8f9660",
  propCharcoalAlpha: 1,
  hueVariance: 0,
  saturationVariance: 0.12,
  valueVariance: 0.1,
  terrainShadeStrength: 0.7,
  centerLightGradientMultiplier: -1.9,
  charcoalThickness: 0.5,
  charcoalInterruptionProbability: 0.05,
  centerInterruptionAmountBoost: 0.43,
  centerInterruptionLengthMultiplier: 6,
  centerDepthThreshold: 0.39,
  minCenterOutlineChance: 0,
  centerSegmentRemoval: 0.7,
  showCenterDebug: false,
  showFootprints: false,
  overlapLowerInterruptionMultiplier: 3,
  charcoalInterruptionLength: 2.5,
  standMarkSpacing: 0.5,
  standEdgeTrees: 0.9,
  standInteriorTrees: 0.08,
  standMeadowTrees: 0.5,
  standAccentTrees: 0.18,
  standInkWeight: 0.9,
  standWashStrength: 0.85,
  standWashVariation: 1,
  standWashSoftness: 0.25,
  standLightStrength: 0.7,
};

export function forestRenderSettingsSignature(
  settings: Partial<ForestRenderSettings> | undefined,
): string {
  return JSON.stringify({ ...DEFAULT_FOREST_RENDER_SETTINGS, ...settings });
}

/**
 * Validity limits for forest settings. Inspector sliders cover a narrower
 * range, but typed values may use anything inside these limits.
 */
export const FOREST_SETTING_LIMITS: Partial<Record<keyof ForestRenderSettings, readonly [number, number]>> = {
  seed: [0, 2147483647], density: [0, Infinity], clustering: [0, 1], canopyMerging: [0, Infinity],
  canopyEdgeNoiseSize: [P, Infinity], canopyWashNoiseSize: [P, Infinity], canopyWashStrength: [0, Infinity],
  outlineShadowStrength: [0, 1], outlineInsetStrength: [0, 1], outlineInsetBlurRadius: [0, Infinity],
  lightStrength: [0, 1], sunAzimuthDeg: [0, 360], lightEdgeDepth: [0, 1],
  lightSoftness: [P, 1], lightNoise: [0, 1], centerLightGradientMultiplier: [-Infinity, -P],
  charcoalThickness: [P, Infinity], charcoalInterruptionProbability: [0, 1],
  centerInterruptionAmountBoost: [0, 1], centerInterruptionLengthMultiplier: [1, Infinity],
  centerDepthThreshold: [0, 1], minCenterOutlineChance: [0, 1], centerSegmentRemoval: [0, 1],
  overlapLowerInterruptionMultiplier: [1, Infinity], charcoalInterruptionLength: [P, Infinity],
  propCharcoalAlpha: [0, 1], hueVariance: [0, 360], saturationVariance: [0, 1],
  valueVariance: [0, 1], terrainShadeStrength: [0, 1],
  standMarkSpacing: [0.05, Infinity], standEdgeTrees: [0, Infinity], standInteriorTrees: [0, Infinity],
  standMeadowTrees: [0, Infinity], standAccentTrees: [0, Infinity], standInkWeight: [0, Infinity], standWashStrength: [0, 1],
  standWashVariation: [0, Infinity], standWashSoftness: [0, 1], standLightStrength: [0, Infinity],
};

export function normalizeForestRenderSettings(
  value: unknown,
  fallback: ForestRenderSettings = DEFAULT_FOREST_RENDER_SETTINGS,
): ForestRenderSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const saved = value as Record<string, unknown>;
  const normalized = { ...fallback };
  for (const [key, range] of Object.entries(FOREST_SETTING_LIMITS) as Array<[keyof ForestRenderSettings, readonly [number, number]]>) {
    const candidate = saved[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) continue;
    (normalized as unknown as Record<string, unknown>)[key] = Math.max(range[0], Math.min(range[1], candidate));
  }
  for (const key of ["showCenterDebug", "showFootprints"] as const) {
    if (typeof saved[key] === "boolean") normalized[key] = saved[key] as never;
  }
  if (typeof saved.lightColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.lightColor))
    normalized.lightColor = saved.lightColor;
  if (typeof saved.outlineColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.outlineColor))
    normalized.outlineColor = saved.outlineColor;
  if (typeof saved.alpineCanopyColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.alpineCanopyColor))
    normalized.alpineCanopyColor = saved.alpineCanopyColor;
  if (typeof saved.wetlandCanopyColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.wetlandCanopyColor))
    normalized.wetlandCanopyColor = saved.wetlandCanopyColor;
  if (typeof saved.wetlandWoodColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.wetlandWoodColor))
    normalized.wetlandWoodColor = saved.wetlandWoodColor;
  if (typeof saved.wetlandShrubColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.wetlandShrubColor))
    normalized.wetlandShrubColor = saved.wetlandShrubColor;
  return normalized;
}

export function readInitialForestRenderSettings(): ForestRenderSettings {
  if (typeof window === "undefined") return DEFAULT_FOREST_RENDER_SETTINGS;
  let savedMountainSettings: Record<string, unknown> | null = null;
  try {
    const mountain = window.localStorage.getItem("fantasy-map-builder:mountain-detail-settings:v1");
    if (mountain) savedMountainSettings = JSON.parse(mountain) as Record<string, unknown>;
  } catch {
    // A malformed Mountain snapshot should not block legacy forest migration.
  }
  if (savedMountainSettings?.forestSettings)
    return normalizeForestRenderSettings(savedMountainSettings.forestSettings);
  try {
    const legacy = window.localStorage.getItem("forest-props-controls-v1");
    if (!legacy) return DEFAULT_FOREST_RENDER_SETTINGS;
    const saved = JSON.parse(legacy) as Record<string, unknown>;
    const light = typeof saved.lightSettings === "object" && saved.lightSettings !== null
      ? saved.lightSettings as Record<string, unknown> : {};
    return normalizeForestRenderSettings({
      ...saved,
      lightStrength: light.strength,
      sunAzimuthDeg: light.sunAzimuthDeg,
      lightEdgeDepth: light.edgeDepth,
      lightSoftness: light.softness,
      lightNoise: light.noise,
      lightColor: light.color,
    });
  } catch {
    // A malformed prior snapshot falls back to the maintained defaults.
  }
  return DEFAULT_FOREST_RENDER_SETTINGS;
}

interface CanvasTarget {
  width: number;
  height: number;
  getContext(type: "2d", options?: CanvasRenderingContext2DSettings):
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
}

function createCanvas(width: number, height: number): CanvasTarget | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

function hash(seed: number, x: number, y: number, salt: number): number {
  let value = Math.imul(x | 0, 0x45d9f3b) ^ Math.imul(y | 0, 0x119de1f3) ^ seed ^ salt;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}

interface ForestTreeVariant {
  displacementSource: number;
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  lean: number;
}

function forestHash01(value: number, salt: number): number {
  let hashed = Math.imul(value ^ salt, 0x45d9f3b);
  hashed = Math.imul(hashed ^ (hashed >>> 16), 0x45d9f3b);
  hashed ^= hashed >>> 16;
  return (hashed >>> 0) / 0xffffffff;
}

function createTreeVariant(
  placement: VegetationRasterPropPlacement,
  seed: number,
  coordinateOffsetX: number,
  coordinateOffsetY: number,
  coordinateScaleX: number,
  coordinateScaleY: number,
  deform = true,
): ForestTreeVariant {
  const worldX = (placement.x + coordinateOffsetX) * coordinateScaleX;
  const worldY = (placement.y + coordinateOffsetY) * coordinateScaleY;
  const placementSeed = (
    Math.imul(Math.round(worldX), 374761393) ^
    Math.imul(Math.round(worldY), 668265263) ^ seed ^ 0x6d2b79f5
  ) | 0;
  return {
    displacementSource: deform ? 4 + forestHash01(placementSeed, 719) * 4 : 0,
    offsetX: forestHash01(placementSeed, 701) * 100,
    offsetY: forestHash01(placementSeed, 709) * 100,
    scaleX: deform ? 0.94 + forestHash01(placementSeed, 727) * 0.12 : 1,
    scaleY: deform ? 0.94 + forestHash01(placementSeed, 733) * 0.12 : 1,
    lean: deform ? (forestHash01(placementSeed, 739) - 0.5) * 0.07 : 0,
  };
}

function transformTreePoint(
  point: VegetationStrokePoint,
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
  variant: ForestTreeVariant,
): VegetationStrokePoint {
  const sourceNoiseX = Math.sin(point.x * 0.025 + variant.offsetX) * 0.65 +
    Math.sin(point.y * 0.017 + variant.offsetY) * 0.35;
  const sourceNoiseY = Math.sin(point.x * 0.021 + variant.offsetX + 31.7) * 0.65 +
    Math.sin(point.y * 0.019 + variant.offsetY - 17.3) * 0.35;
  const sourceX = point.x + sourceNoiseX * variant.displacementSource;
  const sourceY = point.y + sourceNoiseY * variant.displacementSource;
  const envelopeWidth = placement.cellSize * (asset.renderWidthCells ?? asset.footprintWidthCells);
  const envelopeHeight = placement.cellSize * (asset.renderHeightCells ?? asset.footprintHeightCells);
  const anchorX = asset.renderAnchorX ?? asset.anchorX;
  const anchorY = asset.renderAnchorY ?? asset.anchorY;
  const localY = (sourceY / Math.max(1, asset.height) - anchorY) * envelopeHeight * variant.scaleY;
  const localX = (sourceX / Math.max(1, asset.width) - anchorX) * envelopeWidth * variant.scaleX + localY * variant.lean;
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  return {
    x: placement.x + localX * cos - localY * sin,
    y: placement.y + localX * sin + localY * cos,
  };
}

function pathLength(points: readonly VegetationStrokePoint[]): { cumulative: number[]; length: number } {
  const cumulative = [0];
  for (let index = 1; index < points.length; index++) {
    cumulative.push(cumulative[index - 1] + Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    ));
  }
  return { cumulative, length: cumulative[cumulative.length - 1] ?? 0 };
}

function pointAtDistance(
  points: readonly VegetationStrokePoint[],
  cumulative: readonly number[],
  distance: number,
): VegetationStrokePoint {
  if (distance <= 0) return points[0];
  const last = points.length - 1;
  if (distance >= cumulative[last]) return points[last];
  let index = 1;
  while (index < cumulative.length && cumulative[index] < distance) index++;
  const segmentLength = cumulative[index] - cumulative[index - 1];
  const t = segmentLength > 0 ? (distance - cumulative[index - 1]) / segmentLength : 0;
  return {
    x: points[index - 1].x + (points[index].x - points[index - 1].x) * t,
    y: points[index - 1].y + (points[index].y - points[index - 1].y) * t,
  };
}

function drawInterruptedPath(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: readonly VegetationStrokePoint[],
  closed: boolean,
  seed: number,
  settings: ForestRenderSettings,
  interiorWeight: number,
  overlap: boolean,
  outline: boolean,
  canopyCenter: VegetationStrokePoint,
  opacity: number,
  renderScale: number,
): void {
  if (points.length < (closed ? 3 : 2)) return;
  const pathPoints = closed ? [...points, points[0]] : [...points];
  const { cumulative, length } = pathLength(pathPoints);
  if (length < 0.035) return;
  const centerFadeProgress = Math.max(0, Math.min(1,
    interiorWeight / Math.max(0.01, settings.centerDepthThreshold),
  ));
  const interruptionProbability = Math.min(1,
    settings.charcoalInterruptionProbability + centerFadeProgress * settings.centerInterruptionAmountBoost,
  );
  const gapLengthMultiplier = 1 + centerFadeProgress * (settings.centerInterruptionLengthMultiplier - 1);
  const retention = 1 - settings.centerSegmentRemoval * (1 - Math.max(
    settings.minCenterOutlineChance,
    forestPropInkRetentionAtDepth(interiorWeight, settings.centerDepthThreshold),
  ));
  const interruptionLengthScale = Math.max(0.5, Math.min(3,
    settings.charcoalInterruptionLength * Math.max(0.7, settings.charcoalThickness / 0.72),
  ));
  const pathSeed = seed ^ Math.imul(outline ? 0 : 1, 2246822519);
  const runs = createCharcoalStrokeRuns(length, pathSeed,
    Math.max(0.35, settings.charcoalThickness / 0.72) * renderScale, {
      breakProbability: overlap && !outline
        ? Math.min(1, interruptionProbability * settings.overlapLowerInterruptionMultiplier)
        : interruptionProbability,
      dashMin: (outline ? 0.72 : 0.24) * interruptionLengthScale,
      dashMax: (outline ? 2.2 : 0.72) * interruptionLengthScale,
      gapMin: (outline ? 0.24 : 0.12) * interruptionLengthScale * gapLengthMultiplier,
      gapMax: (outline ? 0.62 : 0.3) * interruptionLengthScale * gapLengthMultiplier,
    });
  const centerDistances = runs.map((run) => {
    const midpoint = pointAtDistance(pathPoints, cumulative, (run.start + run.end) * 0.5);
    return Math.hypot(midpoint.x - canopyCenter.x, midpoint.y - canopyCenter.y);
  });
  const retainedRuns = thinForestInkRuns(runs, retention, pathSeed, centerDistances);
  context.save();
  context.globalAlpha = opacity;
  context.strokeStyle = settings.outlineColor;
  context.lineWidth = outline
    ? Math.max(0.55, settings.charcoalThickness * 1.55 * renderScale)
    : Math.max(0.45, settings.charcoalThickness * renderScale);
  context.lineJoin = "round";
  context.lineCap = "round";
  for (const run of retainedRuns) {
    context.beginPath();
    const first = pointAtDistance(pathPoints, cumulative, run.start);
    context.moveTo(first.x, first.y);
    for (let index = 1; index < pathPoints.length - 1; index++) {
      if (cumulative[index] > run.start && cumulative[index] < run.end) {
        context.lineTo(pathPoints[index].x, pathPoints[index].y);
      }
    }
    const last = pointAtDistance(pathPoints, cumulative, run.end);
    context.lineTo(last.x, last.y);
    context.stroke();
  }
  context.restore();
}

function rgb(color: readonly [number, number, number] | undefined, fallback: string): string {
  return color ? `rgb(${color[0]},${color[1]},${color[2]})` : fallback;
}

function forestCanopyPath(
  asset: VegetationRasterPropAsset,
): VegetationMotifVectorPath | undefined {
  const requested = asset.forestCanopyPathIndex === undefined
    ? undefined
    : asset.vectorPaths?.[asset.forestCanopyPathIndex];
  if (requested?.closed && requested.fillColor) return requested;
  return asset.vectorPaths?.find((path) => path.closed && path.fillColor);
}

function rgbaFromHex(hex: string, alpha: number, multiplier = 1): string {
  const match = hex.trim().match(/^#([0-9a-f]{6})$/i);
  const source = match?.[1] ?? "283b29";
  const channels = [0, 2, 4].map((start) =>
    Math.max(
      0,
      Math.min(
        255,
        Math.round(Number.parseInt(source.slice(start, start + 2), 16) * multiplier),
      ),
    ),
  );
  return `rgba(${channels[0]},${channels[1]},${channels[2]},${Math.max(0, Math.min(1, alpha))})`;
}

function varyPropColor(
  color: string | readonly [number, number, number],
  colorSeed: number,
  index: number,
  asset: VegetationRasterPropAsset,
  settings: ForestRenderSettings,
): [number, number, number] {
  return varyColorHsv(
    color,
    (hash(colorSeed, index, asset.key.length, 761) - 0.5) * settings.hueVariance,
    (hash(colorSeed, index, asset.key.length, 769) - 0.5) * settings.saturationVariance,
    (hash(colorSeed, index, asset.key.length, 787) - 0.5) * settings.valueVariance,
  );
}

/** Canopy base color for a stand member, before per-prop variation. */
function canopyBaseColor(
  asset: VegetationRasterPropAsset,
  settings: ForestRenderSettings,
): readonly [number, number, number] | undefined {
  if (asset.outlineGroup === "alpine-forest") return parseHexColor(settings.alpineCanopyColor);
  return undefined;
}

// Offscreen distance used to draw only a shape's canvas shadow.
const SHADOW_ONLY_OFFSET = 100_000;

/**
 * Cast a soft ground shadow from the prop silhouette, away from the sun.
 * Closed fills share one path so overlapping trunk/crown parts do not
 * darken twice; open paths (reeds) cast a stroke shadow.
 */
function drawCastShadow(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  shapes: ReadonlyArray<{ points: readonly VegetationStrokePoint[]; closed: boolean }>,
  settings: ForestRenderSettings,
  renderScale: number,
  opacity: number,
): void {
  if (opacity <= 0 || settings.showCenterDebug) return;
  const angle = settings.sunAzimuthDeg * Math.PI / 180;
  context.save();
  context.globalAlpha = Math.min(1, opacity);
  context.shadowColor = rgbaFromHex(settings.outlineColor, 0.55, 0.9);
  context.shadowBlur = 3.6 * renderScale;
  context.shadowOffsetX = SHADOW_ONLY_OFFSET - Math.sin(angle) * 4 * renderScale;
  context.shadowOffsetY = Math.cos(angle) * 4 * renderScale;
  context.translate(-SHADOW_ONLY_OFFSET, 0);
  context.fillStyle = "#000";
  context.beginPath();
  let hasFill = false;
  for (const { points, closed } of shapes) {
    if (!closed || points.length < 3) continue;
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) context.lineTo(points[index].x, points[index].y);
    context.closePath();
    hasFill = true;
  }
  if (hasFill) context.fill();
  context.strokeStyle = "#000";
  context.lineWidth = Math.max(0.55, settings.charcoalThickness * 1.55 * renderScale);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const { points, closed } of shapes) {
    if (closed || points.length < 2) continue;
    tracePath(context, points, false);
    context.stroke();
  }
  context.restore();
}

function tracePath(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: readonly VegetationStrokePoint[],
  closed: boolean,
): void {
  if (points.length < 2) return;
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index++) {
    context.lineTo(points[index].x, points[index].y);
  }
  if (closed) context.closePath();
}

// Canvas pixels are the transport format between the worker forest pass and
// the vegetation compositor. Encode the visual-bottom coordinate in a second
// transparent canvas so trees can be compared with vector/raster rock props
// without introducing a DOM dependency or a per-pixel object allocation.
const FOREST_DEPTH_OFFSET = 65_536;
const FOREST_DEPTH_SCALE = 16;
const FOREST_DEPTH_MAX_CODE = 0xffffff;

function encodeForestDepth(depth: number): string {
  const code = Math.max(
    1,
    Math.min(
      FOREST_DEPTH_MAX_CODE,
      Math.round((depth + FOREST_DEPTH_OFFSET) * FOREST_DEPTH_SCALE),
    ),
  );
  return `rgb(${code >> 16},${(code >> 8) & 0xff},${code & 0xff})`;
}

function decodeForestDepth(red: number, green: number, blue: number): number {
  return ((red << 16) | (green << 8) | blue) / FOREST_DEPTH_SCALE - FOREST_DEPTH_OFFSET;
}

function drawDepthCrown(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: readonly VegetationStrokePoint[],
  depth: number,
  opacity: number,
  renderScale: number,
  settings: ForestRenderSettings,
  closed = true,
): void {
  if (points.length < (closed ? 3 : 2) || !Number.isFinite(depth)) return;
  const color = encodeForestDepth(depth);
  context.save();
  // Depth describes the placement order, so a translucent crown still wins
  // the ordering test wherever its rendered pixels are present. Keep zero
  // opacity placements out of the map entirely.
  context.globalAlpha = opacity > 0 ? 1 : 0;
  context.fillStyle = color;
  if (closed) {
    tracePath(context, points, true);
    context.fill();
  }
  // Include the placement-dependent charcoal edge in the same depth test. A
  // small stroke is enough to cover antialiased outline pixels while keeping
  // neighboring crowns' depth independent.
  context.strokeStyle = color;
  context.lineWidth = Math.max(1, settings.charcoalThickness * 1.8 * renderScale);
  context.lineJoin = "round";
  context.lineCap = "round";
  tracePath(context, points, true);
  context.stroke();
  context.restore();
}

function drawCrown(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
  index: number,
  settings: ForestRenderSettings,
  interiorWeight: number,
  overlap: boolean,
  canopyCenter: VegetationStrokePoint,
  coordinateOffsetX: number,
  coordinateOffsetY: number,
  coordinateScaleX: number,
  coordinateScaleY: number,
  renderScale: number,
  lightTexture?: { canvas: HTMLCanvasElement | OffscreenCanvas; padding: number },
  preparedPaths?: Array<{ path: VegetationMotifVectorPath; points: VegetationStrokePoint[] }>,
  preparedVariant?: ForestTreeVariant,
): void {
  const fillPath = forestCanopyPath(asset);
  const variantSeed = (
    Math.imul(Math.round((placement.x + coordinateOffsetX) * coordinateScaleX * 10), 374761393) ^
    Math.imul(Math.round((placement.y + coordinateOffsetY) * coordinateScaleY * 10), 668265263) ^ settings.seed
  ) | 0;
  if (!fillPath) return;
  const colorSeed = variantSeed ^ Math.imul(index + 1, 0x27d4eb2d);
  const canopyColor = varyPropColor(settings.alpineCanopyColor, colorSeed, index, asset, settings);
  const variant = preparedVariant ?? createTreeVariant(
    placement, settings.seed, coordinateOffsetX, coordinateOffsetY,
    coordinateScaleX, coordinateScaleY,
  );
  const getPreparedPoints = (path: VegetationMotifVectorPath): VegetationStrokePoint[] | undefined =>
    preparedPaths?.find((entry) => entry.path === path)?.points;
  const transformedFill = getPreparedPoints(fillPath) ??
    fillPath.points.map((point) => transformTreePoint(point, placement, asset, variant));
  const fill = rgb(canopyColor, "#567449");
  const scaledSettings = {
    ...settings,
    charcoalThickness: settings.charcoalThickness * renderScale,
    charcoalInterruptionLength: settings.charcoalInterruptionLength * renderScale,
    outlineInsetBlurRadius: settings.outlineInsetBlurRadius * renderScale,
  };
  const centerFadeProgress = Math.max(0, Math.min(1,
    interiorWeight / Math.max(0.01, settings.centerDepthThreshold),
  ));
  const centerLightMultiplier = Math.pow(
    1 - centerFadeProgress,
    -1 / settings.centerLightGradientMultiplier,
  );

  context.save();
  context.globalAlpha = placement.opacity;
  const fillPathIndex = asset.vectorPaths?.indexOf(fillPath) ?? -1;
  const paintSolidFill = (sourcePath: VegetationMotifVectorPath): void => {
    const points = getPreparedPoints(sourcePath) ?? sourcePath.points.map((point) =>
      transformTreePoint(point, placement, asset, variant),
    );
    tracePath(context, points, true);
    context.fillStyle = rgb(sourcePath.fillColor, "#76543b");
    context.fill();
  };
  for (let pathIndex = 0; pathIndex < fillPathIndex; pathIndex++) {
    const path = asset.vectorPaths?.[pathIndex];
    if (path?.closed && path.fillColor) paintSolidFill(path);
  }
  tracePath(context, transformedFill, true);
  if (settings.showCenterDebug) {
    const depth = Math.max(0, Math.min(1, interiorWeight / Math.max(0.01, settings.centerDepthThreshold)));
    context.fillStyle = `hsl(${Math.round(190 * (1 - depth))} 86% 54%)`;
  } else {
    context.fillStyle = fill;
  }
  context.fill();
  if (!settings.showCenterDebug && lightTexture && centerLightMultiplier > 0) {
    context.save();
    context.clip();
    context.globalAlpha = placement.opacity * centerLightMultiplier;
    const envelopeWidth = placement.cellSize * (asset.renderWidthCells ?? asset.footprintWidthCells);
    const envelopeHeight = placement.cellSize * (asset.renderHeightCells ?? asset.footprintHeightCells);
    const sx = envelopeWidth * variant.scaleX / Math.max(1, asset.width);
    const sy = envelopeHeight * variant.scaleY / Math.max(1, asset.height);
    const oy = -(asset.renderAnchorY ?? asset.anchorY) * envelopeHeight * variant.scaleY;
    const ox = -(asset.renderAnchorX ?? asset.anchorX) * envelopeWidth * variant.scaleX + oy * variant.lean;
    const cos = Math.cos(placement.rotation);
    const sin = Math.sin(placement.rotation);
    context.transform(cos * sx, sin * sx, cos * variant.lean * sy - sin * sy,
      sin * variant.lean * sy + cos * sy,
      placement.x + cos * ox - sin * oy, placement.y + sin * ox + cos * oy);
    context.drawImage(lightTexture.canvas, -lightTexture.padding, -lightTexture.padding);
    context.restore();
  }
  for (let pathIndex = fillPathIndex + 1; pathIndex < (asset.vectorPaths?.length ?? 0); pathIndex++) {
    const path = asset.vectorPaths?.[pathIndex];
    if (path?.closed && path.fillColor) paintSolidFill(path);
  }
  context.restore();

  if (!settings.showCenterDebug && settings.outlineInsetStrength > 0) {
    context.save();
    tracePath(context, transformedFill, true);
    context.clip();
    context.globalAlpha = placement.opacity * settings.outlineInsetStrength * settings.propCharcoalAlpha;
    context.strokeStyle = settings.outlineColor;
    context.lineWidth = Math.max(1, scaledSettings.outlineInsetBlurRadius * 2);
    context.shadowColor = rgbaFromHex(settings.outlineColor, 0.8, 0.6);
    context.shadowBlur = scaledSettings.outlineInsetBlurRadius * 1.2;
    context.shadowOffsetX = Math.sin(settings.sunAzimuthDeg * Math.PI / 180) * scaledSettings.outlineInsetBlurRadius * 0.6;
    context.shadowOffsetY = -Math.cos(settings.sunAzimuthDeg * Math.PI / 180) * scaledSettings.outlineInsetBlurRadius * 0.6;
    tracePath(context, transformedFill, true);
    context.stroke();
    context.restore();
  }

  const outlineSeed = variantSeed ^ Math.imul(0, 2246822519);
  drawInterruptedPath(context, transformedFill, true, outlineSeed, settings, interiorWeight,
    overlap, true, canopyCenter, placement.opacity * (settings.showCenterDebug ? 0.95 : 1) * settings.propCharcoalAlpha, renderScale);

  for (let pathIndex = 0; pathIndex < (asset.vectorPaths ?? []).length; pathIndex++) {
    const path = asset.vectorPaths![pathIndex];
    if (path === fillPath) continue;
    const points = getPreparedPoints(path) ?? path.points.map((point) =>
      transformTreePoint(point, placement, asset, variant),
    );
    const pathMeanY = path.points.reduce((sum, point) => sum + point.y, 0) / Math.max(1, path.points.length);
    drawInterruptedPath(context, points, Boolean(path.closed), variantSeed ^ Math.imul(pathIndex + 1, 2246822519),
      settings, interiorWeight, overlap && pathMeanY >= asset.height * 0.5, false,
      canopyCenter, placement.opacity * (settings.showCenterDebug ? 0.95 : 0.78) * settings.propCharcoalAlpha, renderScale);
  }

  if (settings.showFootprints) {
    context.globalAlpha = 0.8;
    context.strokeStyle = "#d2ed62";
    context.lineWidth = Math.max(0.5, renderScale);
    const envelopeWidth = placement.cellSize * asset.footprintWidthCells;
    const envelopeHeight = placement.cellSize * asset.footprintHeightCells;
    const left = -envelopeWidth * asset.anchorX;
    const top = -envelopeHeight * asset.anchorY;
    const right = left + envelopeWidth;
    const bottom = top + envelopeHeight;
    const cos = Math.cos(placement.rotation);
    const sin = Math.sin(placement.rotation);
    const corners = [[left, top], [right, top], [right, bottom], [left, bottom]] as const;
    context.beginPath();
    corners.forEach(([x, y], corner) => {
      const px = placement.x + x * cos - y * sin;
      const py = placement.y + x * sin + y * cos;
      if (corner === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    });
    context.closePath();
    context.stroke();
  }
  context.restore();
}

/** Draw a deterministic, worker-safe forest layer and return its transparent pixels. */
export function renderForestCanvasLayer(
  width: number,
  height: number,
  placements: readonly VegetationRasterPropPlacement[],
  assets: readonly VegetationRasterPropAsset[],
  rawSettings?: Partial<ForestRenderSettings>,
  landMask?: Uint8Array,
  coordinateOffsetX = 0,
  coordinateOffsetY = 0,
  coordinateScaleX = 1,
  coordinateScaleY = 1,
  renderScale = 1,
  depthOutput?: Float32Array,
  profiler?: MountainProfiler,
): Uint8ClampedArray | null {
  const settings = { ...DEFAULT_FOREST_RENDER_SETTINGS, ...rawSettings };
  if (width <= 0 || height <= 0) return null;
  if (depthOutput && depthOutput.length >= width * height) {
    depthOutput.fill(Number.NEGATIVE_INFINITY, 0, width * height);
  }
  const forestAssets = assets.filter((asset) => asset.outlineGroup === "alpine-forest");
  const assetByKey = new Map(forestAssets.map((asset) => [asset.key, asset]));
  const trees = placements.filter((placement) => assetByKey.has(placement.assetKey));
  if (trees.length === 0) return null;
  const canvas = createCanvas(width, height);
  const context = canvas?.getContext("2d", { willReadFrequently: true });
  if (!canvas || !context) return null;
  context.clearRect(0, 0, width, height);
  const depthCanvas = depthOutput && depthOutput.length >= width * height
    ? createCanvas(width, height)
    : null;
  const depthContext = depthCanvas?.getContext("2d", { willReadFrequently: true });
  if (depthContext) depthContext.clearRect(0, 0, width, height);

  const variants = trees.map((placement) => createTreeVariant(
    placement,
    settings.seed,
    coordinateOffsetX,
    coordinateOffsetY,
    coordinateScaleX,
    coordinateScaleY,
    assetByKey.get(placement.assetKey)?.placementRole !== "wetland",
  ));
  const transformedPaths: Array<Array<{
    path: VegetationMotifVectorPath;
    points: VegetationStrokePoint[];
  }>> = [];
  const bounds: Array<{ minX: number; minY: number; maxX: number; maxY: number } | null> = [];
  const crowns: ForestPropCrown[] = [];
  const transformStop = profiler?.begin("vegetation forest path transforms");
  for (let index = 0; index < trees.length; index++) {
    const placement = trees[index];
    const asset = assetByKey.get(placement.assetKey)!;
    const canopy = forestCanopyPath(asset);
    const paths = (asset.vectorPaths ?? []).map((path) => ({
      path,
      points: path.points.map((point) =>
        transformTreePoint(point, placement, asset, variants[index]),
      ),
    }));
    transformedPaths[index] = paths;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const { points } of paths) {
      for (const point of points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }
    bounds[index] = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
    if (
      !canopy ||
      asset.outlineGroup !== "alpine-forest"
    ) continue;
    const canopyPoints = paths.find((entry) => entry.path === canopy)?.points ?? [];
    crowns.push({
      placementIndex: index,
      points: canopyPoints.map((point) => ({
        x: point.x + coordinateOffsetX,
        y: point.y + coordinateOffsetY,
      })),
    });
  }
  transformStop?.();
  const standStop = profiler?.begin("vegetation forest stand geometry");
  const stand = buildForestPropStandGeometry(
    crowns,
    width,
    height,
    settings.canopyMerging,
    settings.seed,
    coordinateOffsetX - 2,
    coordinateOffsetY - 2,
    settings.canopyEdgeNoiseSize,
  );
  standStop?.();

  // Painted after the crowns (behind them via destination-over) so each
  // stand's fill can be measured from the trees exactly as they rendered.
  const paintStandWash = (): void => {
  const washStop = profiler?.begin("vegetation forest wash preparation");
  if (!settings.showCenterDebug && stand.canopyPath && stand.canopyRegions.length > 0) {
    // Fallback: mean base fill of the member trees.
    const colorSums = new Map<number, [number, number, number, number]>();
    for (let index = 0; index < trees.length; index++) {
      const regionId = stand.regionIds[index] ?? 0;
      if (!regionId) continue;
      const color = canopyBaseColor(assetByKey.get(trees[index].assetKey)!, settings);
      if (!color) continue;
      const sum = colorSums.get(regionId) ?? [0, 0, 0, 0];
      sum[0] += color[0]; sum[1] += color[1]; sum[2] += color[2]; sum[3] += 1;
      colorSums.set(regionId, sum);
    }
    // Measured: the body color of the rendered crowns in the stand. Opaque
    // pixels between the 35th and 95th luminance percentile skip charcoal,
    // cast shadows, and dark rims, leaving the lit foliage the eye reads.
    for (const region of stand.canopyRegions) {
      const left = Math.max(0, Math.floor(region.centerX - region.width * 0.5 - coordinateOffsetX));
      const top = Math.max(0, Math.floor(region.centerY - region.height * 0.5 - coordinateOffsetY));
      const right = Math.min(width, Math.ceil(region.centerX + region.width * 0.5 - coordinateOffsetX));
      const bottom = Math.min(height, Math.ceil(region.centerY + region.height * 0.5 - coordinateOffsetY));
      if (right - left < 2 || bottom - top < 2) continue;
      const data = context.getImageData(left, top, right - left, bottom - top).data;
      const stride = Math.max(1, Math.round(Math.sqrt((right - left) * (bottom - top) / 20000)));
      const offsets: number[] = [];
      const luminances: number[] = [];
      for (let y = 0; y < bottom - top; y += stride) {
        for (let x = 0; x < right - left; x += stride) {
          const offset = (y * (right - left) + x) * 4;
          if (data[offset + 3] < 250) continue;
          offsets.push(offset);
          luminances.push(data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114);
        }
      }
      if (offsets.length < 16) continue;
      const sorted = [...luminances].sort((a, b) => a - b);
      const low = sorted[Math.floor(sorted.length * 0.35)];
      const high = sorted[Math.floor(sorted.length * 0.95)];
      const sum: [number, number, number, number] = [0, 0, 0, 0];
      for (let sample = 0; sample < offsets.length; sample++) {
        if (luminances[sample] < low || luminances[sample] > high) continue;
        const offset = offsets[sample];
        sum[0] += data[offset]; sum[1] += data[offset + 1]; sum[2] += data[offset + 2]; sum[3] += 1;
      }
      if (sum[3] > 0) colorSums.set(region.id, sum);
    }
    const washCanvas = createCanvas(width, height);
    const maskCanvas = createCanvas(width, height);
    const washContext = washCanvas?.getContext("2d", { willReadFrequently: true });
    const maskContext = maskCanvas?.getContext("2d", { willReadFrequently: true });
    if (washCanvas && maskCanvas && washContext && maskContext && typeof Path2D !== "undefined") {
      washContext.save();
      washContext.translate(-coordinateOffsetX, -coordinateOffsetY);
      const regionMargin = 24 * renderScale;
      for (const region of stand.canopyRegions) {
        const sum = colorSums.get(region.id);
        if (!sum || sum[3] <= 0) continue;
        washContext.fillStyle = `rgb(${Math.round(sum[0] / sum[3])},${Math.round(sum[1] / sum[3])},${Math.round(sum[2] / sum[3])})`;
        washContext.fillRect(
          region.centerX - region.width * 0.5 - regionMargin,
          region.centerY - region.height * 0.5 - regionMargin,
          region.width + regionMargin * 2,
          region.height + regionMargin * 2,
        );
        // Subtle watercolor mottling in the same hue.
        const grainCount = Math.round(Math.min(1200, region.width * region.height / (40 * renderScale * renderScale)) * settings.canopyWashNoiseSize);
        washContext.globalAlpha = Math.min(0.1, settings.canopyWashNoiseSize * 0.025) * settings.canopyWashStrength;
        const regionSeed = settings.seed ^ Math.imul(Math.round(region.centerX), 374761393) ^ Math.imul(Math.round(region.centerY), 668265263);
        for (let grain = 0; grain < grainCount; grain++) {
          const x = region.centerX + (hash(regionSeed, Math.round(region.centerX), grain, 53) - 0.5) * region.width;
          const y = region.centerY + (hash(regionSeed, Math.round(region.centerY), grain, 59) - 0.5) * region.height;
          const size = Math.max(0.5, settings.canopyEdgeNoiseSize * renderScale *
            (0.35 + hash(regionSeed, Math.round(region.centerX), grain, 61) * 0.65));
          washContext.fillStyle = grain % 2 === 0 ? "rgba(255,255,235,1)" : "rgba(20,35,20,1)";
          washContext.fillRect(x, y, size, size);
        }
        washContext.globalAlpha = 1;
      }
      washContext.restore();

      // The fill only bridges gaps between neighbouring crowns: the stand
      // outline is intersected with the member crowns grown by a quarter of
      // their width, so it cannot spread past the outer trees.
      maskContext.save();
      maskContext.translate(-coordinateOffsetX, -coordinateOffsetY);
      maskContext.fillStyle = "#000";
      maskContext.strokeStyle = "#000";
      maskContext.lineJoin = "round";
      for (const crown of crowns) {
        if (!stand.regionIds[crown.placementIndex] || crown.points.length < 3) continue;
        const box = bounds[crown.placementIndex];
        maskContext.lineWidth = box ? (box.maxX - box.minX) * 0.5 : 0;
        maskContext.beginPath();
        maskContext.moveTo(crown.points[0].x, crown.points[0].y);
        for (let point = 1; point < crown.points.length; point++) maskContext.lineTo(crown.points[point].x, crown.points[point].y);
        maskContext.closePath();
        maskContext.fill();
        if (maskContext.lineWidth > 0) maskContext.stroke();
      }
      maskContext.globalCompositeOperation = "destination-in";
      maskContext.fill(new Path2D(stand.canopyPath), "evenodd");
      maskContext.restore();
      washContext.globalCompositeOperation = "destination-in";
      washContext.filter = `blur(${(0.6 * renderScale).toFixed(2)}px)`;
      washContext.drawImage(maskCanvas as CanvasImageSource, 0, 0);
      washContext.filter = "none";
      washContext.globalCompositeOperation = "source-over";
      context.save();
      context.globalCompositeOperation = "destination-over";
      context.drawImage(washCanvas as CanvasImageSource, 0, 0);
      context.restore();
    }
  }
  washStop?.();
  };
  const lightTextures = new Map<string, { canvas: HTMLCanvasElement | OffscreenCanvas; padding: number }>();
  const lightStop = profiler?.begin("vegetation forest light texture preparation");
  if (!settings.showCenterDebug && settings.lightStrength > 0) {
    for (const asset of new Set(trees.map((tree) => assetByKey.get(tree.assetKey)!))) {
      const field = buildForestLightField(asset, settings.seed);
      if (!field) continue;
      lightTextures.set(asset.key, {
        canvas: getForestLightTextureCanvas(field, {
          strength: settings.lightStrength, sunAzimuthDeg: settings.sunAzimuthDeg,
          edgeDepth: settings.lightEdgeDepth, softness: settings.lightSoftness,
          noise: settings.lightNoise, color: settings.lightColor,
        }),
        padding: field.padding,
      });
    }
  }
  lightStop?.();

  const crownPaintStop = profiler?.begin("vegetation forest crown and depth painting");
  const overlaps = findForestPropOverlapFlags(bounds);
  const order = trees.map((placement, index) => ({ placement, index })).sort((a, b) =>
    (bounds[a.index]?.maxY ?? a.placement.y) - (bounds[b.index]?.maxY ?? b.placement.y) || a.index - b.index,
  );
  const regionById = new Map(stand.canopyRegions.map((region) => [region.id, region]));
  for (const { placement, index } of order) {
    // Each prop casts its shadow onto whatever is already drawn, including
    // the trees behind it.
    if (settings.outlineShadowStrength > 0) {
      drawCastShadow(context, (transformedPaths[index] ?? []).map(({ path, points }) => ({
        points,
        closed: Boolean(path.closed && path.fillColor),
      })), settings, renderScale, placement.opacity * settings.outlineShadowStrength);
    }
    const asset = assetByKey.get(placement.assetKey);
    if (!asset) continue;
    const region = regionById.get(stand.regionIds[index] ?? 0);
    drawCrown(context, placement, asset, index, settings,
      stand.interiorWeights[index] ?? 0, overlaps[index] ?? false,
      region
        ? { x: region.centerX - coordinateOffsetX, y: region.centerY - coordinateOffsetY }
        : { x: placement.x, y: placement.y },
      coordinateOffsetX, coordinateOffsetY, coordinateScaleX, coordinateScaleY, renderScale,
      lightTextures.get(asset.key), transformedPaths[index], variants[index]);
    if (depthContext) {
      const depth = bounds[index]?.maxY ?? placement.y;
      for (const { path, points } of transformedPaths[index] ?? []) {
        drawDepthCrown(
          depthContext,
          points,
          depth,
          placement.opacity,
          renderScale,
          settings,
          Boolean(path.closed && path.fillColor),
        );
      }
    }
  }
  crownPaintStop?.();
  paintStandWash();
  const readbackStop = profiler?.begin("vegetation forest canvas readback");
  if ("commit" in context && typeof context.commit === "function") context.commit();
  if (depthContext && "commit" in depthContext && typeof depthContext.commit === "function") depthContext.commit();
  const pixels = context.getImageData(0, 0, width, height).data;
  const depthPixels = depthContext?.getImageData(0, 0, width, height).data;
  if (landMask && landMask.length >= width * height) {
    for (let pixel = 0; pixel < width * height; pixel++) {
      if (landMask[pixel] !== 0) continue;
      pixels[pixel * 4 + 3] = 0;
      if (depthOutput) depthOutput[pixel] = Number.NEGATIVE_INFINITY;
    }
  }
  if (depthOutput && depthPixels) {
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = pixel * 4;
      if (
        depthPixels[offset + 3] === 0 ||
        (landMask && landMask.length >= width * height && landMask[pixel] === 0)
      ) continue;
      depthOutput[pixel] = decodeForestDepth(
        depthPixels[offset],
        depthPixels[offset + 1],
        depthPixels[offset + 2],
      );
    }
  }
  readbackStop?.();
  return pixels;
}

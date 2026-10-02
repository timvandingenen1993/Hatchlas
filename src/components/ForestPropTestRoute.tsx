/**
 * Dev page (/forest-props) for reviewing forest prop geometry, lighting and rasters.
 */
import {
  useCallback,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  Profiler,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForestRasterPreview } from "./ForestRasterPreview";
import {
  ALPINE_TREE_75_ASSET_URLS,
  loadAlpineVegetationRasterPropAssets,
} from "../rendering/vegetationMotifs";
import {
  rasterPropRenderBounds,
  type VegetationGeometry,
  type VegetationRasterPropAsset,
} from "../rendering/vegetationRenderer";
import {
  buildForestPreviewGeometry,
  FOREST_SIMULATION_HEIGHT as SIMULATION_HEIGHT,
  FOREST_SIMULATION_WIDTH as SIMULATION_WIDTH,
} from "../rendering/forestPropScene";
import {
  charcoalStrokePressureAt,
  createCharcoalStrokeRuns,
} from "../rendering/cartographicStrokeRenderer";
import {
  buildForestLightField,
  DEFAULT_FOREST_LIGHT_SETTINGS,
  renderForestLightTexture,
  type ForestLightSettings,
  type ForestLightTexture,
} from "../rendering/forestPropLighting";
import { embedForestLightingDataUrls } from "../rendering/forestSvgSnapshot";
import {
  buildForestPropStandGeometry,
  DEFAULT_FOREST_PROP_INK_REMOVAL_DEPTH,
  findForestPropOverlapFlags,
  forestPropInkReductionStartDepth,
  forestPropInkRetentionAtDepth,
  thinForestInkRuns,
  type ForestPropCanopyRegion,
  type ForestPropCrown,
} from "../rendering/forestPropDensity";
import {
  addMountainProfileStage,
  createMountainProfiler,
  diffMountainProfileSettings,
  logMountainProfileReport,
  type MountainProfiler,
} from "../rendering/mountainProfiler";

const PREVIEW_8K_WIDTH = 7680;
const PREVIEW_8K_HEIGHT = 5760;
const PREVIEW_16K_WIDTH = 15360;
const PREVIEW_16K_HEIGHT = 11520;
const DEFAULT_CHARCOAL_OUTLINE_WIDTH = 0.72;
const DEFAULT_CHARCOAL_INTERRUPTION_PROBABILITY = 0.58;
const DEFAULT_OVERLAP_LOWER_INTERRUPTION_MULTIPLIER = 2;
const DEFAULT_CHARCOAL_INTERRUPTION_LENGTH = 1;
const CANOPY_NOISE_SIZE_MULTIPLIER = 0.1;
const DEFAULT_FOREST_CENTER_LIGHT_GRADIENT_MULTIPLIER = -1;
const MIN_FOREST_CENTER_LIGHT_GRADIENT_MULTIPLIER = -4;
const MAX_FOREST_CENTER_LIGHT_GRADIENT_MULTIPLIER = -0.25;
const DEFAULT_MIN_CENTER_OUTLINE_CHANCE = 0.02;
const MAX_MIN_CENTER_OUTLINE_CHANCE = 0.1;

type ForestPreviewGeometry = Pick<
  VegetationGeometry,
  "width" | "height" | "rasterProps"
>;

interface ForestWorkerResponse {
  type: "ready" | "assets-ready" | "geometry" | "lighting" | "lighting-error" | "error";
  requestId?: number;
  count?: number;
  receiveMs?: number;
  width?: number;
  height?: number;
  rasterProps?: NonNullable<VegetationGeometry["rasterProps"]>;
  computeMs?: number;
  fieldMs?: number;
  renderMs?: number;
  totalMs?: number;
  cacheHits?: number;
  cacheMisses?: number;
  textures?: Array<{
    key: string;
    width: number;
    height: number;
    padding: number;
    blob: Blob;
  }>;
  message?: string;
}

const TREE_LABEL = "supplied alpine tree path";
const EMPTY_FOREST_PLACEMENTS: NonNullable<VegetationGeometry["rasterProps"]> = [];
const FOREST_PROP_CONTROLS_STORAGE_KEY = "forest-props-controls-v1";
const FOREST_PROFILE_QUERY =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("forestProfile")
    : null;
const FOREST_PROFILE_ENABLED =
  FOREST_PROFILE_QUERY === "1" || FOREST_PROFILE_QUERY === "2";
let forestProfileRequestId = 0;

function forestGeometrySettingsSignature(
  density: number,
  clustering: number,
  seed: number,
): string {
  return JSON.stringify([density, clustering, seed]);
}

function forestLightingSettingsSignature(
  seed: number,
  settings: ForestLightSettings,
): string {
  return JSON.stringify([seed, settings]);
}

async function blobUrlToDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not read a forest lighting texture.");
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not embed a forest lighting texture."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not embed a forest lighting texture."));
    reader.readAsDataURL(blob);
  });
}

async function embedForestLightingTextures(
  svgMarkup: string,
  textures: ReadonlyMap<string, ForestLightTexture>,
): Promise<{ svgMarkup: string; encodedBytes: number }> {
  const dataUrls = new Map<string, string>();
  await Promise.all([...textures].map(async ([key, texture]) => {
    dataUrls.set(key, await blobUrlToDataUrl(texture.url));
  }));
  return embedForestLightingDataUrls(svgMarkup, textures, dataUrls);
}

function createForestProfile(
  metadata: Parameters<typeof createMountainProfiler>[1],
): MountainProfiler | undefined {
  return createMountainProfiler(FOREST_PROFILE_ENABLED, {
    requestId: ++forestProfileRequestId,
    layer: "forest-props",
    width: SIMULATION_WIDTH,
    height: SIMULATION_HEIGHT,
    renderer: "svg-canvas",
    ...metadata,
  });
}

function publishForestLightingTextures(
  assets: readonly VegetationRasterPropAsset[],
  previousMap: ReadonlyMap<string, ForestLightTexture>,
  textureUrls: Set<string>,
  textures: readonly (ForestLightTexture & { key: string })[],
): { lightTextures: Map<string, ForestLightTexture>; encodedBytes: number } {
  const previousTextures = [...previousMap.values()];
  const lightTextures = new Map<string, ForestLightTexture>();
  for (const texture of textures) {
    lightTextures.set(texture.key, texture);
    if (texture.url.startsWith("blob:")) textureUrls.add(texture.url);
  }

  for (const [index, asset] of assets.entries()) {
    const texture = lightTextures.get(asset.key);
    const image = document.getElementById(`forest-source-shade-${index}`);
    if (!image) continue;
    if (texture) {
      image.setAttribute("href", texture.url);
      image.setAttribute("x", String(-texture.padding));
      image.setAttribute("y", String(-texture.padding));
      image.setAttribute("width", String(texture.width));
      image.setAttribute("height", String(texture.height));
    } else {
      image.removeAttribute("href");
      image.setAttribute("x", "0");
      image.setAttribute("y", "0");
      image.setAttribute("width", String(asset.width));
      image.setAttribute("height", String(asset.height));
    }
  }

  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    const currentUrls = new Set([...lightTextures.values()].map((texture) => texture.url));
    for (const texture of previousTextures) {
      if (!texture.url.startsWith("blob:") || currentUrls.has(texture.url)) continue;
      URL.revokeObjectURL(texture.url);
      textureUrls.delete(texture.url);
    }
  }));
  return {
    lightTextures,
    encodedBytes: textures.reduce((sum, texture) => sum + texture.byteLength, 0),
  };
}

interface ForestPropControlSettings {
  density: number;
  clustering: number;
  canopyMerging: number;
  canopyEdgeNoiseSize: number;
  canopyWashNoiseSize: number;
  canopyWashStrength: number;
  outlineShadowStrength: number;
  outlineInsetStrength: number;
  outlineInsetBlurRadius: number;
  seed: number;
  mapZoom: number;
  sourceZoom: number;
  showFootprints: boolean;
  lightSettings: ForestLightSettings;
  centerLightGradientMultiplier: number;
  targetResolution: "8k" | "16k";
  charcoalThickness: number;
  charcoalInterruptionProbability: number;
  centerInterruptionAmountBoost: number;
  centerInterruptionLengthMultiplier: number;
  centerDepthThreshold: number;
  minCenterOutlineChance: number;
  centerSegmentRemoval: number;
  showCenterDebug: boolean;
  overlapLowerInterruptionMultiplier: number;
  charcoalInterruptionLength: number;
}

const DEFAULT_FOREST_PROP_CONTROLS: ForestPropControlSettings = {
  density: 0.8,
  clustering: 0.72,
  canopyMerging: 65,
  canopyEdgeNoiseSize: 1,
  canopyWashNoiseSize: 1,
  canopyWashStrength: 1,
  outlineShadowStrength: 0.32,
  outlineInsetStrength: 0.25,
  outlineInsetBlurRadius: 2.5,
  seed: 23817,
  mapZoom: 1,
  sourceZoom: 1,
  showFootprints: false,
  lightSettings: DEFAULT_FOREST_LIGHT_SETTINGS,
  centerLightGradientMultiplier: DEFAULT_FOREST_CENTER_LIGHT_GRADIENT_MULTIPLIER,
  targetResolution: "8k",
  charcoalThickness: DEFAULT_CHARCOAL_OUTLINE_WIDTH,
  charcoalInterruptionProbability: DEFAULT_CHARCOAL_INTERRUPTION_PROBABILITY,
  centerInterruptionAmountBoost: 0.7,
  centerInterruptionLengthMultiplier: 9,
  centerDepthThreshold: DEFAULT_FOREST_PROP_INK_REMOVAL_DEPTH,
  minCenterOutlineChance: DEFAULT_MIN_CENTER_OUTLINE_CHANCE,
  centerSegmentRemoval: 0.5,
  showCenterDebug: false,
  overlapLowerInterruptionMultiplier: DEFAULT_OVERLAP_LOWER_INTERRUPTION_MULTIPLIER,
  charcoalInterruptionLength: DEFAULT_CHARCOAL_INTERRUPTION_LENGTH,
};

function savedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function readForestPropControlSettings(): ForestPropControlSettings {
  if (typeof window === "undefined") return DEFAULT_FOREST_PROP_CONTROLS;
  try {
    const serialized = window.localStorage.getItem(
      FOREST_PROP_CONTROLS_STORAGE_KEY,
    );
    if (!serialized) return DEFAULT_FOREST_PROP_CONTROLS;
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_FOREST_PROP_CONTROLS;
    }
    const saved = parsed as Record<string, unknown>;
    const savedLight =
      typeof saved.lightSettings === "object" && saved.lightSettings !== null
        ? (saved.lightSettings as Record<string, unknown>)
        : {};
    const lightDefaults = DEFAULT_FOREST_LIGHT_SETTINGS;
    const lightSettings: ForestLightSettings = {
      strength: savedNumber(savedLight.strength, lightDefaults.strength, 0, 1),
      sunAzimuthDeg: savedNumber(
        savedLight.sunAzimuthDeg,
        lightDefaults.sunAzimuthDeg,
        0,
        360,
      ),
      edgeDepth: savedNumber(savedLight.edgeDepth, lightDefaults.edgeDepth, 0.02, 0.18),
      softness: savedNumber(savedLight.softness, lightDefaults.softness, 0.1, 1),
      noise: savedNumber(savedLight.noise, lightDefaults.noise, 0, 1),
      color:
        typeof savedLight.color === "string" && /^#[\da-f]{6}$/i.test(savedLight.color)
          ? savedLight.color
          : lightDefaults.color,
    };
    return {
      density: savedNumber(saved.density, 0.8, 0.2, 1.5),
      clustering: savedNumber(saved.clustering, 0.72, 0, 1),
      canopyMerging: savedNumber(saved.canopyMerging, 65, 0, 100),
      canopyEdgeNoiseSize: savedNumber(saved.canopyEdgeNoiseSize, 1, 0.5, 2),
      canopyWashNoiseSize: savedNumber(saved.canopyWashNoiseSize, 1, 0.5, 2),
      canopyWashStrength: savedNumber(saved.canopyWashStrength, 1, 0, 2),
      outlineShadowStrength: savedNumber(saved.outlineShadowStrength, 0.32, 0, 1),
      outlineInsetStrength: savedNumber(saved.outlineInsetStrength, 0.25, 0, 1),
      outlineInsetBlurRadius: savedNumber(saved.outlineInsetBlurRadius, 2.5, 0, 8),
      seed:
        typeof saved.seed === "number" && Number.isFinite(saved.seed)
          ? Math.trunc(saved.seed)
          : 23817,
      mapZoom: savedNumber(saved.mapZoom, 1, 1, 16),
      sourceZoom: savedNumber(saved.sourceZoom, 1, 1, 16),
      showFootprints:
        typeof saved.showFootprints === "boolean"
          ? saved.showFootprints
          : false,
      lightSettings,
      centerLightGradientMultiplier: savedNumber(
        saved.centerLightGradientMultiplier ?? saved.centerLightFadeMultiplier,
        DEFAULT_FOREST_CENTER_LIGHT_GRADIENT_MULTIPLIER,
        MIN_FOREST_CENTER_LIGHT_GRADIENT_MULTIPLIER,
        MAX_FOREST_CENTER_LIGHT_GRADIENT_MULTIPLIER,
      ),
      targetResolution: saved.targetResolution === "16k" ? "16k" : "8k",
      charcoalThickness: savedNumber(
        saved.charcoalThickness,
        DEFAULT_CHARCOAL_OUTLINE_WIDTH,
        0.25,
        1.5,
      ),
      charcoalInterruptionProbability: savedNumber(
        saved.charcoalInterruptionProbability,
        DEFAULT_CHARCOAL_INTERRUPTION_PROBABILITY,
        0,
        0.9,
      ),
      centerInterruptionAmountBoost: savedNumber(
        saved.centerInterruptionAmountBoost,
        0.7,
        0,
        0.95,
      ),
      centerInterruptionLengthMultiplier: savedNumber(
        saved.centerInterruptionLengthMultiplier,
        9,
        1,
        12,
      ),
      centerDepthThreshold: savedNumber(
        saved.centerDepthThreshold,
        DEFAULT_FOREST_PROP_INK_REMOVAL_DEPTH,
        0.05,
        1,
      ),
      centerSegmentRemoval: savedNumber(saved.centerSegmentRemoval, 0.5, 0, 1),
      minCenterOutlineChance: savedNumber(
        saved.minCenterOutlineChance,
        DEFAULT_MIN_CENTER_OUTLINE_CHANCE,
        0,
        MAX_MIN_CENTER_OUTLINE_CHANCE,
      ),
      showCenterDebug:
        typeof saved.showCenterDebug === "boolean"
          ? saved.showCenterDebug
          : false,
      overlapLowerInterruptionMultiplier: savedNumber(
        saved.overlapLowerInterruptionMultiplier,
        DEFAULT_OVERLAP_LOWER_INTERRUPTION_MULTIPLIER,
        1,
        3,
      ),
      charcoalInterruptionLength: savedNumber(
        saved.charcoalInterruptionLength,
        DEFAULT_CHARCOAL_INTERRUPTION_LENGTH,
        0.5,
        2.5,
      ),
    };
  } catch {
    return DEFAULT_FOREST_PROP_CONTROLS;
  }
}

function saveForestPropControlSettings(settings: ForestPropControlSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      FOREST_PROP_CONTROLS_STORAGE_KEY,
      JSON.stringify(settings),
    );
  } catch {
    // Storage may be disabled or unavailable; the controls remain usable in memory.
  }
}

function compassHeading(degrees: number): string {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];
}

type ForestVectorPath = NonNullable<
  VegetationRasterPropAsset["vectorPaths"]
>[number];

interface ForestPoint {
  x: number;
  y: number;
}

function forestHash01(value: number, salt: number): number {
  let hashed = Math.imul(value ^ salt, 0x45d9f3b);
  hashed = Math.imul(hashed ^ (hashed >>> 16), 0x45d9f3b);
  hashed ^= hashed >>> 16;
  return (hashed >>> 0) / 0xffffffff;
}

interface ForestTreeVariant {
  displacementSource: number;
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  lean: number;
}

function createForestTreeVariant(
  placement: { x: number; y: number },
  seed: number,
): ForestTreeVariant {
  const placementSeed =
    (Math.imul(Math.round(placement.x), 374761393) ^
      Math.imul(Math.round(placement.y), 668265263) ^
      seed ^
      0x6d2b79f5) |
    0;
  return {
    displacementSource: 4 + forestHash01(placementSeed, 719) * 4,
    offsetX: forestHash01(placementSeed, 701) * 100,
    offsetY: forestHash01(placementSeed, 709) * 100,
    scaleX: 0.94 + forestHash01(placementSeed, 727) * 0.12,
    scaleY: 0.94 + forestHash01(placementSeed, 733) * 0.12,
    lean: (forestHash01(placementSeed, 739) - 0.5) * 0.07,
  };
}

function transformForestTreePoint(
  point: { x: number; y: number },
  placement: {
    x: number;
    y: number;
    rotation: number;
    cellSize: number;
  },
  asset: VegetationRasterPropAsset,
  variant: ForestTreeVariant,
): { x: number; y: number } {
  const sourceNoiseX =
    Math.sin(point.x * 0.025 + variant.offsetX) * 0.65 +
    Math.sin(point.y * 0.017 + variant.offsetY) * 0.35;
  const sourceNoiseY =
    Math.sin(point.x * 0.021 + variant.offsetX + 31.7) * 0.65 +
    Math.sin(point.y * 0.019 + variant.offsetY - 17.3) * 0.35;
  const sourceX = point.x + sourceNoiseX * variant.displacementSource;
  const sourceY = point.y + sourceNoiseY * variant.displacementSource;
  const envelopeWidth =
    placement.cellSize * (asset.renderWidthCells ?? asset.footprintWidthCells);
  const envelopeHeight =
    placement.cellSize * (asset.renderHeightCells ?? asset.footprintHeightCells);
  const anchorX = asset.renderAnchorX ?? asset.anchorX;
  const anchorY = asset.renderAnchorY ?? asset.anchorY;
  const localY =
    (sourceY / Math.max(1, asset.height) - anchorY) *
    envelopeHeight *
    variant.scaleY;
  const localX =
    (sourceX / Math.max(1, asset.width) - anchorX) *
      envelopeWidth *
      variant.scaleX +
    localY * variant.lean;
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  return {
    x: placement.x + localX * cos - localY * sin,
    y: placement.y + localX * sin + localY * cos,
  };
}

/** Match the tree's affine placement; the silhouette clip retains its fine warp. */
function forestTextureTransform(
  placement: { x: number; y: number; rotation: number; cellSize: number },
  asset: VegetationRasterPropAsset,
  variant: ForestTreeVariant,
): string {
  const envelopeWidth =
    placement.cellSize * (asset.renderWidthCells ?? asset.footprintWidthCells);
  const envelopeHeight =
    placement.cellSize * (asset.renderHeightCells ?? asset.footprintHeightCells);
  const anchorX = asset.renderAnchorX ?? asset.anchorX;
  const anchorY = asset.renderAnchorY ?? asset.anchorY;
  const scaleX = envelopeWidth * variant.scaleX / Math.max(1, asset.width);
  const scaleY = envelopeHeight * variant.scaleY / Math.max(1, asset.height);
  const offsetY = -anchorY * envelopeHeight * variant.scaleY;
  const offsetX = -anchorX * envelopeWidth * variant.scaleX +
    offsetY * variant.lean;
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  const values = [
    cos * scaleX,
    sin * scaleX,
    cos * variant.lean * scaleY - sin * scaleY,
    sin * variant.lean * scaleY + cos * scaleY,
    placement.x + cos * offsetX - sin * offsetY,
    placement.y + sin * offsetX + cos * offsetY,
  ];
  return `matrix(${values.map((value) => value.toFixed(6)).join(" ")})`;
}

function transformForestVectorPathPoints(
  path: ForestVectorPath,
  placement: {
    x: number;
    y: number;
    rotation: number;
    cellSize: number;
  },
  asset: VegetationRasterPropAsset,
  variant: ForestTreeVariant,
): ForestPoint[] {
  return path.points.map((point) =>
    transformForestTreePoint(point, placement, asset, variant),
  );
}

function forestVectorPathD(
  path: ForestVectorPath,
  placement: {
    x: number;
    y: number;
    rotation: number;
    cellSize: number;
  },
  asset: VegetationRasterPropAsset,
  variant: ForestTreeVariant,
): string {
  const points = transformForestVectorPathPoints(
    path,
    placement,
    asset,
    variant,
  );
  return forestPathD(points, Boolean(path.closed));
}

function forestPathD(
  points: readonly ForestPoint[],
  closed: boolean,
): string {
  if (points.length === 0) return "";
  const commands = points.map((point, index) =>
    `${index === 0 ? "M" : "L"}${point.x.toFixed(3)} ${point.y.toFixed(3)}`,
  );
  return `${commands.join(" ")}${closed ? " Z" : ""}`;
}

function forestCumulativePathLengths(points: readonly ForestPoint[]): number[] {
  const cumulative = [0];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    cumulative.push(
      cumulative[index - 1] +
        Math.hypot(current.x - previous.x, current.y - previous.y),
    );
  }
  return cumulative;
}

function sampleForestPathAtDistance(
  points: readonly ForestPoint[],
  cumulativeLengths: readonly number[],
  distance: number,
): ForestPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];

  const totalLength = cumulativeLengths[cumulativeLengths.length - 1] ?? 0;
  const target = Math.max(0, Math.min(totalLength, distance));
  if (target <= 0) return points[0];
  if (target >= totalLength) return points[points.length - 1];

  let low = 1;
  let high = cumulativeLengths.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cumulativeLengths[middle] < target) low = middle + 1;
    else high = middle;
  }

  const segmentEnd = low;
  const segmentStart = segmentEnd - 1;
  const segmentLength =
    cumulativeLengths[segmentEnd] - cumulativeLengths[segmentStart];
  if (segmentLength < 1e-6) return points[segmentEnd];
  const segmentT =
    (target - cumulativeLengths[segmentStart]) / segmentLength;
  const start = points[segmentStart];
  const end = points[segmentEnd];
  return {
    x: start.x + (end.x - start.x) * segmentT,
    y: start.y + (end.y - start.y) * segmentT,
  };
}

function forestCharcoalRunPathD(
  points: readonly ForestPoint[],
  cumulativeLengths: readonly number[],
  run: { start: number; end: number },
  thickness: number,
  taperPathEnds = true,
): string {
  const runLength = run.end - run.start;
  if (points.length < 2 || runLength < 0.035) return "";

  const totalLength = cumulativeLengths[cumulativeLengths.length - 1] ?? 0;
  if (totalLength < 1e-6) return "";

  const sampleDistances = [run.start, run.end];
  // Short interruption runs still need a full-width middle sample; without
  // it, tapering both endpoints collapses the entire run into a dot.
  sampleDistances.push(run.start + runLength * 0.5);
  for (let index = 1; index < cumulativeLengths.length - 1; index++) {
    const distance = cumulativeLengths[index];
    if (distance > run.start && distance < run.end) {
      sampleDistances.push(distance);
    }
  }
  const sampleStep = Math.max(0.22, thickness * 0.62);
  for (
    let distance = run.start + sampleStep;
    distance < run.end;
    distance += sampleStep
  ) {
    sampleDistances.push(distance);
  }
  sampleDistances.sort((left, right) => left - right);

  const distances: number[] = [];
  for (const distance of sampleDistances) {
    if (
      distances.length === 0 ||
      Math.abs(distance - distances[distances.length - 1]) > 1e-4
    ) {
      distances.push(distance);
    }
  }

  const leftPoints: ForestPoint[] = [];
  const rightPoints: ForestPoint[] = [];
  for (const distance of distances) {
    const point = sampleForestPathAtDistance(
      points,
      cumulativeLengths,
      distance,
    );
    const tangentStep = Math.min(sampleStep, Math.max(0.04, runLength * 0.25));
    const previous = sampleForestPathAtDistance(
      points,
      cumulativeLengths,
      distance - tangentStep,
    );
    const next = sampleForestPathAtDistance(
      points,
      cumulativeLengths,
      distance + tangentStep,
    );
    const tangentLength = Math.hypot(
      next.x - previous.x,
      next.y - previous.y,
    );
    const normalX = tangentLength > 1e-5 ? -(next.y - previous.y) / tangentLength : 0;
    const normalY = tangentLength > 1e-5 ? (next.x - previous.x) / tangentLength : 1;
    const runT = (distance - run.start) / runLength;
    const pathT = distance / totalLength;
    const normalizedRunT = Math.max(0, Math.min(1, runT));
    const taperWindow = 0.18;
    const taperStart = Math.max(
      0,
      Math.min(1, normalizedRunT / taperWindow),
    );
    const taperEnd = Math.max(
      0,
      Math.min(1, (1 - normalizedRunT) / taperWindow),
    );
    const startTaper = taperStart * taperStart * (3 - 2 * taperStart);
    const endTaper = taperEnd * taperEnd * (3 - 2 * taperEnd);
    const runTaper = Math.pow(Math.min(startTaper, endTaper), 0.78);
    const pathPressure = taperPathEnds
      ? charcoalStrokePressureAt(pathT, true, true)
      : 1;
    const pressure =
      runTaper * pathPressure;
    const halfWidth = thickness * 0.56 * pressure;
    leftPoints.push({
      x: point.x + normalX * halfWidth,
      y: point.y + normalY * halfWidth,
    });
    rightPoints.push({
      x: point.x - normalX * halfWidth,
      y: point.y - normalY * halfWidth,
    });
  }

  if (leftPoints.length < 2) return "";
  const formatPoint = (point: ForestPoint): string =>
    `${point.x.toFixed(3)} ${point.y.toFixed(3)}`;
  return `M${leftPoints.map(formatPoint).join(" L")} L${rightPoints
    .reverse()
    .map(formatPoint)
    .join(" L")} Z`;
}

function createForestCharcoalPathSeed(
  placement: { x: number; y: number },
  forestSeed: number,
  pathIndex: number,
): number {
  return (
    Math.imul(Math.round(placement.x * 10), 374761393) ^
    Math.imul(Math.round(placement.y * 10), 668265263) ^
    Math.imul(pathIndex + 1, 2246822519) ^
    forestSeed
  );
}

function createForestCharcoalDetailPathDs(
  path: ForestVectorPath,
  placement: {
    x: number;
    y: number;
    rotation: number;
    cellSize: number;
  },
  asset: VegetationRasterPropAsset,
  variant: ForestTreeVariant,
  forestSeed: number,
  pathIndex: number,
  thickness: number,
  interruptionLengthScale: number,
  gapLengthMultiplier: number,
  interruptionProbability: number,
  inkRetention: number,
  inkCenter: ForestPoint,
): string[] {
  const points = transformForestVectorPathPoints(
    path,
    placement,
    asset,
    variant,
  );
  const cumulativeLengths = forestCumulativePathLengths(points);
  const totalLength = cumulativeLengths[cumulativeLengths.length - 1] ?? 0;
  if (totalLength < 0.035) return [];

  const thicknessScale = Math.max(
    0.35,
    thickness / DEFAULT_CHARCOAL_OUTLINE_WIDTH,
  );
  const runs = createCharcoalStrokeRuns(
    totalLength,
    createForestCharcoalPathSeed(placement, forestSeed, pathIndex),
    thicknessScale,
    {
      // The source detail paths are short, so use map-space marks rather than
      // the larger cartographic dashes used by long terrain strokes.
      breakProbability: interruptionProbability,
      dashMin: 0.24 * interruptionLengthScale,
      dashMax: 0.72 * interruptionLengthScale,
      gapMin: 0.12 * interruptionLengthScale * gapLengthMultiplier,
      gapMax: 0.3 * interruptionLengthScale * gapLengthMultiplier,
    },
  );
  const centerDistances = runs.map((run) => {
    const midpoint = sampleForestPathAtDistance(
      points,
      cumulativeLengths,
      (run.start + run.end) * 0.5,
    );
    return Math.hypot(midpoint.x - inkCenter.x, midpoint.y - inkCenter.y);
  });
  return thinForestInkRuns(
    runs,
    inkRetention,
    createForestCharcoalPathSeed(placement, forestSeed, pathIndex),
    centerDistances,
  ).map((run) =>
      forestCharcoalRunPathD(
        points,
        cumulativeLengths,
        run,
        thickness,
      ),
    )
    .filter((pathD) => pathD.length > 0);
}

function createForestCharcoalOutlinePathDs(
  path: ForestVectorPath,
  placement: {
    x: number;
    y: number;
    rotation: number;
    cellSize: number;
  },
  asset: VegetationRasterPropAsset,
  variant: ForestTreeVariant,
  forestSeed: number,
  thickness: number,
  interruptionLengthScale: number,
  gapLengthMultiplier: number,
  interruptionProbability: number,
  inkRetention: number,
  inkCenter: ForestPoint,
): string[] {
  if (!path.closed || path.points.length < 3) return [];
  const transformed = transformForestVectorPathPoints(
    path,
    placement,
    asset,
    variant,
  );
  const points = [...transformed, transformed[0]];
  const cumulativeLengths = forestCumulativePathLengths(points);
  const totalLength = cumulativeLengths[cumulativeLengths.length - 1] ?? 0;
  if (totalLength < 0.035) return [];
  const thicknessScale = Math.max(
    0.35,
    thickness / DEFAULT_CHARCOAL_OUTLINE_WIDTH,
  );
  const runs = createCharcoalStrokeRuns(
    totalLength,
    createForestCharcoalPathSeed(placement, forestSeed, -1),
    thicknessScale,
    {
      breakProbability: interruptionProbability,
      dashMin: 0.72 * interruptionLengthScale,
      dashMax: 2.2 * interruptionLengthScale,
      gapMin: 0.24 * interruptionLengthScale * gapLengthMultiplier,
      gapMax: 0.62 * interruptionLengthScale * gapLengthMultiplier,
    },
  );
  const centerDistances = runs.map((run) => {
    const midpoint = sampleForestPathAtDistance(
      points,
      cumulativeLengths,
      (run.start + run.end) * 0.5,
    );
    return Math.hypot(midpoint.x - inkCenter.x, midpoint.y - inkCenter.y);
  });
  return thinForestInkRuns(
    runs,
    inkRetention,
    createForestCharcoalPathSeed(placement, forestSeed, -1),
    centerDistances,
  ).map((run) =>
      forestCharcoalRunPathD(
        points,
        cumulativeLengths,
        run,
        thickness,
        false,
      ),
    )
    .filter((pathD) => pathD.length > 0);
}

function forestFillColor(
  path: ForestVectorPath,
  shadeAmount = 0,
): string {
  const color = path.fillColor ?? [86, 123, 84];
  const shade = 1 - shadeAmount * 0.42;
  return `rgb(${Math.round(color[0] * shade)} ${Math.round(color[1] * shade)} ${Math.round(color[2] * shade)})`;
}

function forestCanopyWashColor(
  path: ForestVectorPath | undefined,
  tint: "base" | "light" | "cool" | "shadow",
): string {
  const color = path?.fillColor ?? [86, 123, 84];
  const multipliers = {
    base: [1, 1, 1],
    light: [1.28, 1.34, 1.17],
    cool: [0.83, 1.04, 1.18],
    shadow: [0.7, 0.82, 0.68],
  }[tint];
  return `rgb(${color.map((channel, index) => Math.max(0, Math.min(255, Math.round(channel * multipliers[index])))).join(" ")})`;
}

function forestCenterDebugColor(
  interiorWeight: number,
  centerDepthThreshold: number,
): string {
  const depth = Math.max(
    0,
    Math.min(1, interiorWeight / centerDepthThreshold),
  );
  return `hsl(${Math.round(190 * (1 - depth))} 86% 54%)`;
}

interface ForestCanopyWashPatch {
  id: string;
  regionId: number;
  centerX: number;
  centerY: number;
  radius: number;
  tone: "mass" | "light" | "shadow";
}

function createForestCanopyWashPatches(
  regions: readonly ForestPropCanopyRegion[],
): ForestCanopyWashPatch[] {
  return regions.flatMap((region) => [
    {
      id: `forest-canopy-wash-${region.id}-mass`,
      regionId: region.id,
      centerX: region.centerX,
      centerY: region.centerY,
      radius: Math.max(24, region.radius * 1.12),
      tone: "mass" as const,
    },
    {
      id: `forest-canopy-wash-${region.id}-light`,
      regionId: region.id,
      centerX: region.centerX - region.width * 0.17,
      centerY: region.centerY - region.height * 0.12,
      radius: Math.max(16, region.radius * 0.46),
      tone: "light" as const,
    },
    {
      id: `forest-canopy-wash-${region.id}-shadow`,
      regionId: region.id,
      centerX: region.centerX + region.width * 0.19,
      centerY: region.centerY + region.height * 0.14,
      radius: Math.max(16, region.radius * 0.42),
      tone: "shadow" as const,
    },
  ]);
}

function ForestLightFill({
  pathD,
  clipId,
  baseColor,
  shadedColor,
  opacity,
  id,
  textureId,
  textureTransform,
  textureOpacity = 1,
}: {
  pathD: string;
  clipId?: string;
  baseColor: string;
  shadedColor: string;
  opacity: number;
  id: string;
  textureId?: string;
  textureTransform?: string;
  textureOpacity?: number;
}) {
  const resolvedClipId = clipId ?? `${id}-clip`;
  return (
    <g opacity={opacity}>
      <path
        d={pathD}
        fill={textureId ? baseColor : shadedColor}
        fillRule="nonzero"
      />
      {textureId ? (
        <>
          {!clipId ? (
            <defs>
              <clipPath id={resolvedClipId} clipPathUnits="userSpaceOnUse">
                <path d={pathD} fillRule="nonzero" />
              </clipPath>
            </defs>
          ) : null}
          <g clipPath={`url(#${resolvedClipId})`}>
            <use
              href={`#${textureId}`}
              transform={textureTransform}
              opacity={textureOpacity}
            />
          </g>
        </>
      ) : null}
    </g>
  );
}

interface ForestVectorPreviewProps {
  geometry: ForestPreviewGeometry | null;
  assets: readonly VegetationRasterPropAsset[];
  profile?: MountainProfiler;
  seed: number;
  charcoalThickness: number;
  charcoalInterruptionProbability: number;
  overlapLowerInterruptionMultiplier: number;
  charcoalInterruptionLength: number;
  centerInterruptionAmountBoost: number;
  centerInterruptionLengthMultiplier: number;
  centerDepthThreshold: number;
  minCenterOutlineChance: number;
  centerSegmentRemoval: number;
  centerLightGradientMultiplier: number;
  canopyMerging: number;
  canopyEdgeNoiseSize: number;
  canopyWashNoiseSize: number;
  canopyWashStrength: number;
  outlineShadowStrength: number;
  outlineInsetStrength: number;
  outlineInsetBlurRadius: number;
  showCenterDebug: boolean;
  showFootprints: boolean;
  lightStrength: number;
  sunAzimuthDeg: number;
  targetWidth: number;
  targetHeight: number;
}

const ForestVectorPreview = memo(function ForestVectorPreview({
  geometry,
  assets,
  profile,
  seed,
  charcoalThickness,
  charcoalInterruptionProbability,
  overlapLowerInterruptionMultiplier,
  charcoalInterruptionLength,
  centerInterruptionAmountBoost,
  centerInterruptionLengthMultiplier,
  centerDepthThreshold,
  minCenterOutlineChance,
  centerSegmentRemoval,
  centerLightGradientMultiplier,
  canopyMerging,
  canopyEdgeNoiseSize,
  canopyWashNoiseSize,
  canopyWashStrength,
  outlineShadowStrength,
  outlineInsetStrength,
  outlineInsetBlurRadius,
  showCenterDebug,
  showFootprints,
  lightStrength,
  sunAzimuthDeg,
  targetWidth,
  targetHeight,
}: ForestVectorPreviewProps) {
  const alpineAssets = useMemo(
    () => assets.filter((candidate) => candidate.key.startsWith("alpine-tree-75")),
    [assets],
  );
  const assetByKey = useMemo(
    () => new Map(alpineAssets.map((candidate) => [candidate.key, candidate])),
    [alpineAssets],
  );
  const placements = geometry?.rasterProps ?? EMPTY_FOREST_PLACEMENTS;
  const forestStandGeometry = useMemo(() => {
    const prepareCrowns = () => {
      const crowns: ForestPropCrown[] = [];
      for (let placementIndex = 0; placementIndex < placements.length; placementIndex++) {
        const placement = placements[placementIndex];
        const asset = assetByKey.get(placement.assetKey);
        const fillPath = asset?.vectorPaths?.find(
          (path) => path.closed && path.fillColor,
        );
        if (!asset || !fillPath) continue;
        const variant = createForestTreeVariant(placement, seed);
        crowns.push({
          placementIndex,
          points: transformForestVectorPathPoints(
            fillPath,
            placement,
            asset,
            variant,
          ),
        });
      }
      return crowns;
    };
    const crowns = profile
      ? profile.measure("tree crown coordinate transforms", prepareCrowns)
      : prepareCrowns();
    const build = () => buildForestPropStandGeometry(
        crowns,
        SIMULATION_WIDTH,
        SIMULATION_HEIGHT,
        canopyMerging,
        seed,
      );
    return profile
      ? profile.measure("canopy coverage and contour construction", build)
      : build();
  }, [assetByKey, canopyMerging, placements, profile, seed]);
  const canopyFillPath = alpineAssets[0]?.vectorPaths?.find(
    (path) => path.closed && path.fillColor,
  );
  const canopyWashPatches = useMemo(() => {
    const build = () => createForestCanopyWashPatches(forestStandGeometry.canopyRegions);
    return profile ? profile.measure("canopy wash patch generation", build) : build();
  }, [forestStandGeometry.canopyRegions, profile]);
  const canopyBaseColor = forestCanopyWashColor(canopyFillPath, "base");
  const canopyLightWashColor = forestCanopyWashColor(canopyFillPath, "light");
  const canopyCoolWashColor = forestCanopyWashColor(canopyFillPath, "cool");
  const canopyShadowWashColor = forestCanopyWashColor(canopyFillPath, "shadow");
  const forestPropInteriorWeights = forestStandGeometry.interiorWeights;
  const placementBounds = useMemo(() => {
    const build = () => placements.map((placement) => {
        const asset = assetByKey.get(placement.assetKey);
        return asset ? rasterPropRenderBounds(placement, asset) : null;
      });
    return profile ? profile.measure("tree bounds", build) : build();
  }, [assetByKey, placements, profile]);
  const overlappingPlacements = useMemo(() => {
    const find = () => findForestPropOverlapFlags(placementBounds);
    return profile ? profile.measure("tree overlap detection", find) : find();
  }, [placementBounds, profile]);
  const inkColor = "#283b29";
  const charcoalFilterPadding = 2.28;
  const shadowFilterPadding = 3 * 3.6 + 8 + 2;
  const insetFilterPadding = 3 * outlineInsetBlurRadius + outlineInsetBlurRadius * 0.6 + 2;
  const filterObjectBoundsPadding = useMemo(() => {
    let shadowX = 0;
    let shadowY = 0;
    let insetX = 0;
    let insetY = 0;
    let inkX = 0;
    let inkY = 0;
    for (const bounds of placementBounds) {
      if (!bounds) continue;
      const width = Math.max(1, bounds.maxX - bounds.minX);
      const height = Math.max(1, bounds.maxY - bounds.minY);
      inkX = Math.max(inkX, charcoalFilterPadding / width);
      inkY = Math.max(inkY, charcoalFilterPadding / height);
      if (outlineShadowStrength > 0 && !showCenterDebug) {
        shadowX = Math.max(shadowX, shadowFilterPadding / width);
        shadowY = Math.max(shadowY, shadowFilterPadding / height);
      }
      if (outlineInsetStrength > 0 && !showCenterDebug) {
        insetX = Math.max(insetX, insetFilterPadding / width);
        insetY = Math.max(insetY, insetFilterPadding / height);
      }
    }
    return { shadowX, shadowY, insetX, insetY, inkX, inkY };
  }, [
    charcoalFilterPadding,
    insetFilterPadding,
    outlineInsetStrength,
    outlineShadowStrength,
    placementBounds,
    shadowFilterPadding,
    showCenterDebug,
  ]);
  const interruptionLengthScale = Math.max(
    0.5,
    Math.min(
      3,
      charcoalInterruptionLength *
        Math.max(0.7, charcoalThickness / DEFAULT_CHARCOAL_OUTLINE_WIDTH),
    ),
  );
  const orderedPlacementEntries = useMemo(
    () => placements
      .map((placement, index) => ({ placement, index }))
      .sort((first, second) => {
        const firstBottomY =
          placementBounds[first.index]?.maxY ?? first.placement.y;
        const secondBottomY =
          placementBounds[second.index]?.maxY ?? second.placement.y;
        // SVG paints later siblings on top. Keep the largest visual-bottom Y
        // last so the foreground/deeper prop wins every overlap.
        return firstBottomY - secondBottomY || first.index - second.index;
      }),
    [placementBounds, placements],
  );

  const canopyRegionById = useMemo(
    () => new Map(forestStandGeometry.canopyRegions.map((region) => [region.id, region])),
    [forestStandGeometry.canopyRegions],
  );
  const forestInkGeometry = useMemo(() => {
    const build = () => placements.map((placement, index) => {
      const placementAsset = assetByKey.get(placement.assetKey);
      const fillPath = placementAsset?.vectorPaths?.find(
        (path) => path.closed && path.fillColor,
      );
      if (!placementAsset || !fillPath) return null;
      const variant = createForestTreeVariant(placement, seed);
      const interiorWeight = forestPropInteriorWeights[index] ?? 0;
      const canopyRegionId = forestStandGeometry.regionIds[index] ?? 0;
      const canopyRegion = canopyRegionById.get(canopyRegionId);
      const inkCenter = canopyRegion
        ? { x: canopyRegion.centerX, y: canopyRegion.centerY }
        : { x: placement.x, y: placement.y };
      const centerFadeProgress = Math.max(
        0,
        Math.min(1, interiorWeight / Math.max(0.01, centerDepthThreshold)),
      );
      const centerThinningProgress = centerFadeProgress * centerSegmentRemoval;
      const propInterruptionProbability = Math.min(
        1,
        charcoalInterruptionProbability +
          centerThinningProgress * centerInterruptionAmountBoost,
      );
      const propGapLengthMultiplier =
        1 + centerThinningProgress * (centerInterruptionLengthMultiplier - 1);
      const propInkRetention = 1 - centerSegmentRemoval * (1 - Math.max(
        minCenterOutlineChance,
        forestPropInkRetentionAtDepth(interiorWeight, centerDepthThreshold),
      ));
      const lowerOverlapInterruptionProbability = Math.min(
        1,
        propInterruptionProbability * overlapLowerInterruptionMultiplier,
      );
      const outlinePathDs = createForestCharcoalOutlinePathDs(
        fillPath,
        placement,
        placementAsset,
        variant,
        seed,
        charcoalThickness,
        interruptionLengthScale,
        propGapLengthMultiplier,
        propInterruptionProbability,
        propInkRetention,
        inkCenter,
      );
      const detailPaths = placementAsset.vectorPaths?.filter(
        (path) => path !== fillPath,
      ) ?? [];
      const detailPathDs = detailPaths.flatMap((path, pathIndex) => {
        const pathMeanY = path.points.reduce((sum, point) => sum + point.y, 0) /
          Math.max(1, path.points.length);
        const pathInterruptionProbability =
          overlappingPlacements[index] && pathMeanY >= placementAsset.height * 0.5
            ? lowerOverlapInterruptionProbability
            : propInterruptionProbability;
        return createForestCharcoalDetailPathDs(
          path,
          placement,
          placementAsset,
          variant,
          seed,
          pathIndex,
          charcoalThickness,
          interruptionLengthScale,
          propGapLengthMultiplier,
          pathInterruptionProbability,
          propInkRetention,
          inkCenter,
        ).map((pathD, runIndex) => ({ pathIndex, runIndex, pathD }));
      });
      return {
        silhouetteD: forestVectorPathD(fillPath, placement, placementAsset, variant),
        outlinePathDs,
        detailPathDs,
      };
    });
    return profile ? profile.measure("tree silhouette and charcoal geometry", build) : build();
  }, [
    assetByKey,
    centerDepthThreshold,
    centerInterruptionAmountBoost,
    centerInterruptionLengthMultiplier,
    centerSegmentRemoval,
    charcoalInterruptionProbability,
    charcoalThickness,
    canopyRegionById,
    forestPropInteriorWeights,
    forestStandGeometry,
    interruptionLengthScale,
    minCenterOutlineChance,
    overlapLowerInterruptionMultiplier,
    overlappingPlacements,
    placements,
    profile,
    seed,
  ]);

  const renderForestProp = ({ placement, index }: (typeof orderedPlacementEntries)[number]) => {
    const placementAsset = assetByKey.get(placement.assetKey);
    const fillPath = placementAsset?.vectorPaths?.find(
      (path) => path.closed && path.fillColor,
    );
    if (!placementAsset || !fillPath) return null;
    const inkGeometry = forestInkGeometry[index];
    if (!inkGeometry) return null;
    const variant = createForestTreeVariant(placement, seed);
    const silhouetteD = inkGeometry.silhouetteD;
    const textureEnabled = lightStrength > 0;
    const interiorWeight = forestPropInteriorWeights[index] ?? 0;
    const canopyRegionId = forestStandGeometry.regionIds[index] ?? 0;
    const centerFadeProgress = Math.max(
      0,
      Math.min(1, interiorWeight / Math.max(0.01, centerDepthThreshold)),
    );
    const centerLightStrengthMultiplier =
      (1 - centerFadeProgress) ** (-1 / centerLightGradientMultiplier);
    const standSunStrength =
      lightStrength * centerLightStrengthMultiplier;
    const lightTextureOpacity = centerLightStrengthMultiplier;
    // Sample the same world-space pigment as the canopy instead of covering
    // it with each asset's solid fill. Lighting remains above this surface.
    const propBaseColor = canopyRegionId
      ? "url(#forest-canopy-wash-surface)"
      : forestFillColor(fillPath);
    const outlinePathDs = inkGeometry.outlinePathDs;
    const outlineShapeId = `forest-prop-outline-${index}`;
    const fillClipId = `forest-prop-fill-clip-${index}`;
    const renderOutline = () => outlinePathDs.length > 0 ? (
      <g
        filter="url(#charcoal-outline-treatment)"
        fill={inkColor}
        fillRule="nonzero"
      >
        <use href={`#${outlineShapeId}`} />
      </g>
    ) : null;
    const detailElements = inkGeometry.detailPathDs.map(({ pathIndex, runIndex, pathD }) => (
        <path
          key={`${placement.assetKey}-detail-${index}-${pathIndex}-${runIndex}`}
          d={pathD}
        />
      ));

    return (
      <g
        key={`${placement.assetKey}-prop-${index}`}
        data-center-depth={showCenterDebug ? interiorWeight.toFixed(3) : undefined}
      >
        {outlinePathDs.length > 0 ||
          (!showCenterDebug && (textureEnabled || outlineInsetStrength > 0)) ? (
          <defs>
            {!showCenterDebug && (textureEnabled || outlineInsetStrength > 0) ? (
              <clipPath id={fillClipId} clipPathUnits="userSpaceOnUse">
                <path d={silhouetteD} fillRule="nonzero" />
              </clipPath>
            ) : null}
            {outlinePathDs.length > 0 ? (
              <g id={outlineShapeId} fill={inkColor} fillRule="nonzero">
                {outlinePathDs.map((pathD, pathIndex) => (
                  <path
                    key={`${placement.assetKey}-outline-${index}-${pathIndex}`}
                    d={pathD}
                  />
                ))}
              </g>
            ) : null}
          </defs>
        ) : null}
        {!showCenterDebug && outlineShadowStrength > 0 && outlinePathDs.length > 0 ? (
          <g
            filter="url(#forest-prop-cast-shadow)"
            fill={inkColor}
            fillRule="nonzero"
            opacity={placement.opacity * outlineShadowStrength}
            pointerEvents="none"
          >
            <use href={`#${outlineShapeId}`} />
          </g>
        ) : null}
        {showCenterDebug ? (
          <path
            d={silhouetteD}
            fill={forestCenterDebugColor(interiorWeight, centerDepthThreshold)}
            fillRule="nonzero"
          />
        ) : (
          <ForestLightFill
            pathD={silhouetteD}
            clipId={textureEnabled ? fillClipId : undefined}
            baseColor={propBaseColor}
            shadedColor={canopyRegionId
              ? propBaseColor
              : forestFillColor(fillPath, standSunStrength)}
            opacity={placement.opacity}
            id={`forest-stand-light-${index}`}
            textureId={textureEnabled ? `forest-shade-${placementAsset.key}` : undefined}
            textureTransform={textureEnabled
              ? forestTextureTransform(placement, placementAsset, variant)
              : undefined}
            textureOpacity={lightTextureOpacity}
          />
        )}
        {!showCenterDebug && outlineInsetStrength > 0 && outlinePathDs.length > 0 ? (
          <g clipPath={`url(#${fillClipId})`}>
            <g
              filter="url(#forest-prop-outline-inset)"
              fill={inkColor}
              fillRule="nonzero"
              opacity={placement.opacity * outlineInsetStrength}
              pointerEvents="none"
            >
              <use href={`#${outlineShapeId}`} />
            </g>
          </g>
        ) : null}
        {renderOutline()}
        {detailElements.length > 0 ? (
          <g
            filter="url(#charcoal-outline-treatment)"
            fill={inkColor}
            fillRule="nonzero"
          >
            {detailElements}
          </g>
        ) : null}
      </g>
    );
  };

  const renderProps = () => orderedPlacementEntries.map((entry) => renderForestProp(entry));
  const forestPropElements = profile
    ? profile.measure("tree charcoal paths and SVG elements", renderProps)
    : renderProps();

  return (
    <svg
      width={targetWidth}
      height={targetHeight}
      viewBox={`0 0 ${SIMULATION_WIDTH} ${SIMULATION_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      className="absolute inset-0 block h-full w-full"
      shapeRendering="geometricPrecision"
      aria-label={`Vector forest preview at ${targetWidth}x${targetHeight}`}
    >
      <defs>
        {outlineShadowStrength > 0 && !showCenterDebug ? (
          <filter
            id="forest-prop-cast-shadow"
            x={-filterObjectBoundsPadding.shadowX}
            y={-filterObjectBoundsPadding.shadowY}
            width={1 + filterObjectBoundsPadding.shadowX * 2}
            height={1 + filterObjectBoundsPadding.shadowY * 2}
            filterUnits="objectBoundingBox"
            primitiveUnits="userSpaceOnUse"
          >
            <feGaussianBlur in="SourceAlpha" stdDeviation="3.6" result="forestPropShadowBlur" />
            <feOffset
              id="forest-prop-shadow-offset"
              in="forestPropShadowBlur"
              dx={-Math.sin(sunAzimuthDeg * Math.PI / 180) * 8}
              dy={Math.cos(sunAzimuthDeg * Math.PI / 180) * 8}
              result="forestPropShadowOffset"
            />
            <feFlood floodColor="#18251a" floodOpacity="0.72" result="forestPropShadowColor" />
            <feComposite
              in="forestPropShadowColor"
              in2="forestPropShadowOffset"
              operator="in"
            />
          </filter>
        ) : null}
        {outlineInsetStrength > 0 && !showCenterDebug ? (
          <filter
            id="forest-prop-outline-inset"
            x={-filterObjectBoundsPadding.insetX}
            y={-filterObjectBoundsPadding.insetY}
            width={1 + filterObjectBoundsPadding.insetX * 2}
            height={1 + filterObjectBoundsPadding.insetY * 2}
            filterUnits="objectBoundingBox"
            primitiveUnits="userSpaceOnUse"
          >
            <feGaussianBlur
              in="SourceAlpha"
              stdDeviation={outlineInsetBlurRadius}
              result="forestPropInsetBlur"
            />
            <feOffset
              id="forest-prop-inset-offset"
              in="forestPropInsetBlur"
              dx={Math.sin(sunAzimuthDeg * Math.PI / 180) * outlineInsetBlurRadius * 0.6}
              dy={-Math.cos(sunAzimuthDeg * Math.PI / 180) * outlineInsetBlurRadius * 0.6}
              result="forestPropInsetOffset"
            />
            <feFlood floodColor="#18251a" floodOpacity="0.8" result="forestPropInsetColor" />
            <feComposite
              in="forestPropInsetColor"
              in2="forestPropInsetOffset"
              operator="in"
            />
          </filter>
        ) : null}
        {alpineAssets.map((asset) => {
          return (
            <image
              key={asset.key}
              id={`forest-shade-${asset.key}`}
              x="0"
              y="0"
              width={asset.width}
              height={asset.height}
            />
          );
        })}
        {canopyWashPatches.map((patch) => {
          const stops = patch.tone === "mass"
              ? [
                { offset: "0%", color: canopyLightWashColor, opacity: 0.35 },
                { offset: "38%", color: canopyCoolWashColor, opacity: 0.24 },
                { offset: "74%", color: canopyShadowWashColor, opacity: 0.3 },
                { offset: "100%", color: canopyShadowWashColor, opacity: 0 },
              ]
              : patch.tone === "light"
                ? [
                  { offset: "0%", color: canopyLightWashColor, opacity: 0.3 },
                  { offset: "54%", color: canopyCoolWashColor, opacity: 0.16 },
                  { offset: "100%", color: canopyLightWashColor, opacity: 0 },
                ]
                : [
                  { offset: "0%", color: canopyShadowWashColor, opacity: 0.28 },
                  { offset: "52%", color: canopyCoolWashColor, opacity: 0.15 },
                  { offset: "100%", color: canopyShadowWashColor, opacity: 0 },
                ];
          return (
            <radialGradient
              key={patch.id}
              id={patch.id}
              gradientUnits="userSpaceOnUse"
              cx={patch.centerX}
              cy={patch.centerY}
              r={patch.radius}
            >
              {stops.map((stop) => (
                <stop
                  key={`${patch.id}-${stop.offset}`}
                  offset={stop.offset}
                  stopColor={stop.color}
                  stopOpacity={stop.opacity * canopyWashStrength}
                />
              ))}
            </radialGradient>
          );
        })}
        {forestStandGeometry.canopyRegions.length > 0 ? (
          <pattern
            id="forest-canopy-wash-surface"
            patternUnits="userSpaceOnUse"
            patternContentUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={SIMULATION_WIDTH}
            height={SIMULATION_HEIGHT}
          >
            <g filter="url(#forest-canopy-watercolor)">
              <rect
                width={SIMULATION_WIDTH}
                height={SIMULATION_HEIGHT}
                fill={canopyBaseColor}
              />
              {canopyWashPatches.map((patch) => (
                <rect
                  key={patch.id}
                  width={SIMULATION_WIDTH}
                  height={SIMULATION_HEIGHT}
                  fill={`url(#${patch.id})`}
                />
              ))}
            </g>
          </pattern>
        ) : null}
        <filter
          id="forest-canopy-edge-grain"
          x={-8}
          y={-8}
          width={SIMULATION_WIDTH + 16}
          height={SIMULATION_HEIGHT + 16}
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency={
              0.045 / (canopyEdgeNoiseSize * CANOPY_NOISE_SIZE_MULTIPLIER)
            }
            numOctaves="2"
            seed={seed + 71}
            result="forestCanopyGrain"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="forestCanopyGrain"
            scale="4.2"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
        <filter
          id="forest-canopy-watercolor"
          x={0}
          y={0}
          width={SIMULATION_WIDTH}
          height={SIMULATION_HEIGHT}
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency={
              0.045 / (canopyWashNoiseSize * CANOPY_NOISE_SIZE_MULTIPLIER)
            }
            numOctaves="3"
            seed={seed + 127}
            result="forestCanopyWashNoise"
          />
          <feColorMatrix
            in="forestCanopyWashNoise"
            type="matrix"
            values="0.27 0.12 0.04 0 0.16
                    0.10 0.30 0.05 0 0.18
                    0.04 0.13 0.25 0 0.13
                    0 0 0 0 0.2"
            result="forestCanopyPigment"
          />
          <feComposite
            in="forestCanopyPigment"
            in2="SourceAlpha"
            operator="in"
            result="forestCanopyPigmentMask"
          />
          <feBlend
            in="SourceGraphic"
            in2="forestCanopyPigmentMask"
            mode="soft-light"
          />
        </filter>
        <filter
          id="forest-canopy-edge-transition"
          x={-32}
          y={-32}
          width={SIMULATION_WIDTH + 64}
          height={SIMULATION_HEIGHT + 64}
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
        >
          <feGaussianBlur
            in="SourceAlpha"
            stdDeviation="5.5"
            result="forestCanopySoftEdge"
          />
          <feTurbulence
            type="fractalNoise"
            baseFrequency={
              0.055 / (canopyEdgeNoiseSize * CANOPY_NOISE_SIZE_MULTIPLIER)
            }
            numOctaves="2"
            seed={seed + 211}
            result="forestCanopyEdgeNoise"
          />
          <feDisplacementMap
            in="forestCanopySoftEdge"
            in2="forestCanopyEdgeNoise"
            scale="14"
            xChannelSelector="R"
            yChannelSelector="G"
            result="forestCanopyNoisySoftEdge"
          />
          <feComponentTransfer
            in="forestCanopyNoisySoftEdge"
            result="forestCanopyEdgeAlpha"
          >
            <feFuncA type="linear" slope="1.15" intercept="-0.075" />
          </feComponentTransfer>
          <feComposite
            in="SourceGraphic"
            in2="forestCanopyEdgeAlpha"
            operator="in"
          />
        </filter>
        <filter
          id="charcoal-outline-treatment"
          x={-filterObjectBoundsPadding.inkX}
          y={-filterObjectBoundsPadding.inkY}
          width={1 + filterObjectBoundsPadding.inkX * 2}
          height={1 + filterObjectBoundsPadding.inkY * 2}
          filterUnits="objectBoundingBox"
          primitiveUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.12"
            numOctaves="1"
            seed={seed + 11}
            result="charcoalOutlineGrain"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="charcoalOutlineGrain"
            scale="0.28"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
      <rect
        width={SIMULATION_WIDTH}
        height={SIMULATION_HEIGHT}
        fill="#dcdab7"
      />
      <path
        d={`M0 ${SIMULATION_HEIGHT * 0.18} C${SIMULATION_WIDTH * 0.25} ${SIMULATION_HEIGHT * 0.1}, ${SIMULATION_WIDTH * 0.54} ${SIMULATION_HEIGHT * 0.25}, ${SIMULATION_WIDTH} ${SIMULATION_HEIGHT * 0.16}`}
        fill="none"
        stroke="#c3c79e"
        strokeWidth="1.2"
        opacity="0.55"
      />
      {forestStandGeometry.canopyPath ? (
        <g filter="url(#forest-canopy-edge-transition)" pointerEvents="none">
          <g filter="url(#forest-canopy-watercolor)">
            <g filter="url(#forest-canopy-edge-grain)">
              <path
                d={forestStandGeometry.canopyPath}
                fill={canopyBaseColor}
                fillRule="evenodd"
              />
              {canopyWashPatches.map((patch) => (
                <path
                  key={patch.id}
                  d={forestStandGeometry.canopyPath}
                  fill={`url(#${patch.id})`}
                  fillRule="evenodd"
                />
              ))}
            </g>
          </g>
        </g>
      ) : null}
      <g>
        {alpineAssets.length > 0 ? forestPropElements : null}
      </g>
      {showFootprints
        ? placements.map((placement, index) => {
          const placementAsset = assetByKey.get(placement.assetKey);
            if (!placementAsset) return null;
            const width =
              placement.cellSize * placementAsset.footprintWidthCells;
            const height =
              placement.cellSize * placementAsset.footprintHeightCells;
            return (
              <rect
                key={`${placement.assetKey}-footprint-${index}`}
                x={-width * placementAsset.anchorX}
                y={-height * placementAsset.anchorY}
                width={width}
                height={height}
                transform={`translate(${placement.x} ${placement.y}) rotate(${(placement.rotation * 180) / Math.PI})`}
                fill="none"
                stroke="#53462a"
                strokeWidth="0.35"
                strokeDasharray="2 1.5"
                opacity="0.65"
              />
            );
          })
        : null}
    </svg>
  );
});

const ForestSourcePreview = memo(function ForestSourcePreview({
  asset,
  texture,
  url,
  index,
  zoom,
  lightSettings,
}: {
  asset: VegetationRasterPropAsset | undefined;
  texture: ForestLightTexture | undefined;
  url: string;
  index: number;
  zoom: number;
  lightSettings: ForestLightSettings;
}) {
  const label = `Supplied alpine tree 75-degree ${index === 0 ? "original" : `variant ${index.toString().padStart(2, "0")}`}`;
  const fillPath = asset?.vectorPaths?.find(
    (path) => path.closed && path.fillColor,
  );
  const style = {
    width: `${220 * zoom}px`,
    height: `${220 * zoom}px`,
  };
  if (!asset || !fillPath) {
    return <img src={url} alt={label} className="block max-w-none" style={style} />;
  }

  const textureId = `forest-source-shade-${index}`;
  const fillPathD = forestPathD(fillPath.points, true);
  return (
    <svg
      viewBox={`0 0 ${asset.width} ${asset.height}`}
      className="block max-w-none"
      style={style}
      role="img"
      aria-label={label}
    >
      <defs>
        <image
          id={textureId}
          href={texture?.url}
          x={texture ? -texture.padding : 0}
          y={texture ? -texture.padding : 0}
          width={texture?.width ?? asset.width}
          height={texture?.height ?? asset.height}
        />
      </defs>
      <ForestLightFill
        pathD={fillPathD}
        baseColor={forestFillColor(fillPath)}
        shadedColor={forestFillColor(fillPath, lightSettings.strength)}
        opacity={1}
        id={`forest-source-light-${index}`}
        textureId={lightSettings.strength > 0 ? textureId : undefined}
      />
      <path
        d={fillPathD}
        fill="none"
        stroke="#283b2b"
        strokeWidth="5"
        strokeLinejoin="round"
        opacity="0.85"
      />
      {asset.vectorPaths?.filter((path) => path !== fillPath).map((path, pathIndex) => (
        <path
          key={`forest-source-detail-${index}-${pathIndex}`}
          d={forestPathD(path.points, Boolean(path.closed))}
          fill="none"
          stroke="#30452f"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.8"
        />
      ))}
    </svg>
  );
});

export function ForestPropTestRoute() {
  const previewViewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    clientX: number;
    clientY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const [initialControls] = useState(readForestPropControlSettings);
  const [assets, setAssets] = useState<readonly VegetationRasterPropAsset[]>([]);
  const [previewGeometry, setPreviewGeometry] = useState<ForestPreviewGeometry | null>(null);
  const [previewGeometrySignature, setPreviewGeometrySignature] = useState("");
  const [workerError, setWorkerError] = useState(false);
  const [lightingWorkerError, setLightingWorkerError] = useState(false);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [density, setDensity] = useState(initialControls.density);
  const [clustering, setClustering] = useState(initialControls.clustering);
  const [canopyMerging, setCanopyMerging] = useState(initialControls.canopyMerging);
  const [canopyEdgeNoiseSize, setCanopyEdgeNoiseSize] = useState(
    initialControls.canopyEdgeNoiseSize,
  );
  const [canopyWashNoiseSize, setCanopyWashNoiseSize] = useState(
    initialControls.canopyWashNoiseSize,
  );
  const [canopyWashStrength, setCanopyWashStrength] = useState(
    initialControls.canopyWashStrength,
  );
  const [outlineShadowStrength, setOutlineShadowStrength] = useState(
    initialControls.outlineShadowStrength,
  );
  const [outlineInsetStrength, setOutlineInsetStrength] = useState(
    initialControls.outlineInsetStrength,
  );
  const [outlineInsetBlurRadius, setOutlineInsetBlurRadius] = useState(
    initialControls.outlineInsetBlurRadius,
  );
  const [seed, setSeed] = useState(initialControls.seed);
  const [mapZoom, setMapZoom] = useState(initialControls.mapZoom);
  const [sourceZoom, setSourceZoom] = useState(initialControls.sourceZoom);
  const [showFootprints, setShowFootprints] = useState(initialControls.showFootprints);
  const [lightSettings, setLightSettings] = useState<ForestLightSettings>(
    initialControls.lightSettings,
  );
  const [centerLightGradientMultiplier, setCenterLightGradientMultiplier] = useState(
    initialControls.centerLightGradientMultiplier,
  );
  const [targetResolution, setTargetResolution] = useState<"8k" | "16k">(
    initialControls.targetResolution,
  );
  const [charcoalThickness, setCharcoalThickness] = useState(
    initialControls.charcoalThickness,
  );
  const [charcoalInterruptionProbability, setCharcoalInterruptionProbability] =
    useState(initialControls.charcoalInterruptionProbability);
  const [centerInterruptionAmountBoost, setCenterInterruptionAmountBoost] =
    useState(initialControls.centerInterruptionAmountBoost);
  const [centerInterruptionLengthMultiplier, setCenterInterruptionLengthMultiplier] =
    useState(initialControls.centerInterruptionLengthMultiplier);
  const [centerDepthThreshold, setCenterDepthThreshold] = useState(
    initialControls.centerDepthThreshold,
  );
  const [centerSegmentRemoval, setCenterSegmentRemoval] = useState(
    initialControls.centerSegmentRemoval,
  );
  const [minCenterOutlineChance, setMinCenterOutlineChance] = useState(
    initialControls.minCenterOutlineChance,
  );
  const [showCenterDebug, setShowCenterDebug] = useState(initialControls.showCenterDebug);
  const [overlapLowerInterruptionMultiplier, setOverlapLowerInterruptionMultiplier] =
    useState(initialControls.overlapLowerInterruptionMultiplier);
  const [charcoalInterruptionLength, setCharcoalInterruptionLength] = useState(
    initialControls.charcoalInterruptionLength,
  );
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const profileSettings = useMemo(() => ({
    density,
    clustering,
    canopyMerging,
    canopyEdgeNoiseSize,
    canopyWashNoiseSize,
    canopyWashStrength,
    outlineShadowStrength,
    outlineInsetStrength,
    outlineInsetBlurRadius,
    seed,
    showFootprints,
    lightSettings,
    centerLightGradientMultiplier,
    targetResolution,
    charcoalThickness,
    charcoalInterruptionProbability,
    centerInterruptionAmountBoost,
    centerInterruptionLengthMultiplier,
    centerDepthThreshold,
    minCenterOutlineChance,
    centerSegmentRemoval,
    showCenterDebug,
    overlapLowerInterruptionMultiplier,
    charcoalInterruptionLength,
    assetCount: assets.length,
  }), [
    density,
    clustering,
    canopyMerging,
    canopyEdgeNoiseSize,
    canopyWashNoiseSize,
    canopyWashStrength,
    outlineShadowStrength,
    outlineInsetStrength,
    outlineInsetBlurRadius,
    seed,
    showFootprints,
    lightSettings,
    centerLightGradientMultiplier,
    targetResolution,
    charcoalThickness,
    charcoalInterruptionProbability,
    centerInterruptionAmountBoost,
    centerInterruptionLengthMultiplier,
    centerDepthThreshold,
    minCenterOutlineChance,
    centerSegmentRemoval,
    showCenterDebug,
    overlapLowerInterruptionMultiplier,
    charcoalInterruptionLength,
    assets.length,
  ]);
  const previousProfileSettingsRef = useRef<Record<string, unknown> | undefined>(undefined);
  const navigationStartRef = useRef<{
    kind: "pan" | "zoom";
    startedAt: number;
  } | null>(null);
  const navigationFrameRef = useRef<number | null>(null);
  const navigationFrameAtRef = useRef<number | null>(null);
  const navigationFrameIntervalRef = useRef<number | null>(null);
  const pendingNavigationRef = useRef<{
    pan: { x: number; y: number };
    zoom: number;
  } | null>(null);
  const navigationSamplesRef = useRef<Array<{
    kind: "pan" | "zoom";
    latencyMs: number;
    reactMs: number;
    frameIntervalMs: number | null;
    zoom: number;
    stages: Record<string, number>;
  }>>([]);
  const assetLoadProfiledRef = useRef(false);
  const pendingControlSettingsRef = useRef(initialControls);
  const longTaskSamplesRef = useRef<number[]>([]);
  const forestWorkerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const workerBusyRef = useRef(false);
  const latestWorkerRequestIdRef = useRef(0);
  const pendingWorkerBuildRef = useRef<{
    type: "build";
    requestId: number;
    density: number;
    clustering: number;
    seed: number;
    settingsSignature: string;
  } | null>(null);
  const workerPostedAtRef = useRef(new Map<number, number>());
  const workerAssetsPostedAtRef = useRef<number | null>(null);
  const latestLightingRequestIdRef = useRef(0);
  const lightingProfilesRef = useRef(new Map<number, {
    profiler?: MountainProfiler;
    postedAt: number;
    settingsSignature: string;
  }>());
  const [forestProfiler] = useState(() =>
    createForestProfile({ changedSettings: ["route open"] }),
  );
  const routeOpenedAtRef = useRef(0);
  const firstCompleteForestCommitProfiledRef = useRef(false);
  const assetsRef = useRef(assets);
  const [lightTextures, setLightTextures] = useState(
    () => new Map<string, ForestLightTexture>(),
  );
  const [lightTextureSettingsSignature, setLightTextureSettingsSignature] = useState("");
  const [forestSnapshot, setForestSnapshot] = useState<{
    revision: number;
    svgMarkup: string;
    sourceProps: ForestVectorPreviewProps;
    geometrySettingsSignature: string;
    lightingSettingsSignature: string;
    retryRevision: number;
  } | null>(null);
  const [forestSnapshotError, setForestSnapshotError] = useState<string | null>(null);
  const [forestSnapshotRetryRevision, setForestSnapshotRetryRevision] = useState(0);
  const forestSnapshotRevisionRef = useRef(0);
  const desiredGeometrySettingsSignatureRef = useRef(
    forestGeometrySettingsSignature(density, clustering, seed),
  );
  useLayoutEffect(() => {
    desiredGeometrySettingsSignatureRef.current = forestGeometrySettingsSignature(
      density,
      clustering,
      seed,
    );
  }, [clustering, density, seed]);
  const lightTexturesRef = useRef(lightTextures);
  const lightTextureUrlsRef = useRef(new Set<string>());

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  useEffect(() => {
    lightTexturesRef.current = lightTextures;
  }, [lightTextures]);

  useEffect(() => {
    const textureUrls = lightTextureUrlsRef.current;
    routeOpenedAtRef.current = performance.now();
    return () => {
      for (const url of textureUrls) URL.revokeObjectURL(url);
      textureUrls.clear();
    };
  }, []);

  useEffect(() => {
    if (!forestProfiler || typeof PerformanceObserver === "undefined") return;
    if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
    const observer = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        longTaskSamplesRef.current.push(entry.duration);
      }
    });
    observer.observe({ type: "longtask", buffered: true });
    return () => observer.disconnect();
  }, [forestProfiler]);

  const placementCount = previewGeometry?.rasterProps?.length ?? 0;

  const targetWidth =
    targetResolution === "16k" ? PREVIEW_16K_WIDTH : PREVIEW_8K_WIDTH;
  const targetHeight =
    targetResolution === "16k" ? PREVIEW_16K_HEIGHT : PREVIEW_8K_HEIGHT;
  const desiredGeometrySettingsSignature = forestGeometrySettingsSignature(
    density,
    clustering,
    seed,
  );
  const forestCamera = useMemo(
    () => ({ panX: previewPan.x, panY: previewPan.y, zoom: mapZoom }),
    [mapZoom, previewPan.x, previewPan.y],
  );

  const forestPreviewProps = useMemo<ForestVectorPreviewProps | null>(() => {
    if (!previewGeometry) return null;
    return {
      geometry: previewGeometry,
      assets,
      profile: forestProfiler,
      seed,
      charcoalThickness,
      charcoalInterruptionProbability,
      overlapLowerInterruptionMultiplier,
      charcoalInterruptionLength,
      centerInterruptionAmountBoost,
      centerInterruptionLengthMultiplier,
      centerDepthThreshold,
      minCenterOutlineChance,
      centerSegmentRemoval,
      canopyMerging,
      canopyEdgeNoiseSize,
      canopyWashNoiseSize,
      canopyWashStrength,
      outlineShadowStrength,
      outlineInsetStrength,
      outlineInsetBlurRadius,
      showCenterDebug,
      showFootprints,
      lightStrength: lightSettings.strength,
      sunAzimuthDeg: lightSettings.sunAzimuthDeg,
      centerLightGradientMultiplier,
      targetWidth,
      targetHeight,
    };
  }, [
    assets,
    canopyEdgeNoiseSize,
    canopyMerging,
    canopyWashNoiseSize,
    canopyWashStrength,
    centerDepthThreshold,
    centerInterruptionAmountBoost,
    centerInterruptionLengthMultiplier,
    centerLightGradientMultiplier,
    centerSegmentRemoval,
    charcoalInterruptionLength,
    charcoalInterruptionProbability,
    charcoalThickness,
    forestProfiler,
    lightSettings.strength,
    lightSettings.sunAzimuthDeg,
    minCenterOutlineChance,
    outlineInsetBlurRadius,
    outlineInsetStrength,
    outlineShadowStrength,
    overlapLowerInterruptionMultiplier,
    previewGeometry,
    seed,
    showCenterDebug,
    showFootprints,
    targetHeight,
    targetWidth,
  ]);

  const currentLightingSettingsSignature = forestPreviewProps?.lightStrength
    ? forestLightingSettingsSignature(seed, lightSettings)
    : "";
  const forestSnapshotUpdating = Boolean(
    forestPreviewProps && (
      !forestSnapshot ||
      forestSnapshot.sourceProps !== forestPreviewProps ||
      forestSnapshot.geometrySettingsSignature !== desiredGeometrySettingsSignature ||
      forestSnapshot.lightingSettingsSignature !== currentLightingSettingsSignature ||
      forestSnapshot.retryRevision !== forestSnapshotRetryRevision
    ),
  );

  useEffect(() => {
    if (!forestPreviewProps) return;
    let cancelled = false;
    if (
      previewGeometrySignature !== desiredGeometrySettingsSignature ||
      (forestPreviewProps.lightStrength > 0 &&
        lightTextureSettingsSignature !==
          forestLightingSettingsSignature(seed, lightSettings))
    ) return () => {
      cancelled = true;
    };

    const timer = window.setTimeout(() => {
      setForestSnapshotError(null);
      void (async () => {
        try {
          const svgStartedAt = performance.now();
          const svgMarkup = renderToStaticMarkup(
            <ForestVectorPreview {...forestPreviewProps} />,
          );
          forestProfiler?.recordExternalStage(
            "forest SVG snapshot generation",
            performance.now() - svgStartedAt,
          );
          forestProfiler?.recordMetric(
            "Forest SVG snapshot characters",
            svgMarkup.length,
            "characters",
          );
          const textureStartedAt = performance.now();
          const embedded = await embedForestLightingTextures(
            svgMarkup,
            forestPreviewProps.lightStrength > 0 ? lightTextures : new Map(),
          );
          forestProfiler?.recordExternalStage(
            "forest lighting texture embedding",
            performance.now() - textureStartedAt,
          );
          forestProfiler?.recordMetric(
            "Embedded lighting texture bytes",
            embedded.encodedBytes,
            "bytes",
          );
          if (cancelled) return;
          setForestSnapshot({
            revision: ++forestSnapshotRevisionRef.current,
            svgMarkup: embedded.svgMarkup,
            sourceProps: forestPreviewProps,
            geometrySettingsSignature: desiredGeometrySettingsSignature,
            lightingSettingsSignature: currentLightingSettingsSignature,
            retryRevision: forestSnapshotRetryRevision,
          });
          setForestSnapshotError(null);
        } catch (error) {
          if (cancelled) return;
          setForestSnapshotError(
            error instanceof Error
              ? error.message
              : "Could not generate the forest SVG snapshot.",
          );
        }
      })();
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    assets,
    forestPreviewProps,
    forestProfiler,
    forestSnapshotRetryRevision,
    desiredGeometrySettingsSignature,
    lightSettings,
    currentLightingSettingsSignature,
    lightTextureSettingsSignature,
    lightTextures,
    previewGeometrySignature,
    seed,
  ]);

  const flushPendingWorkerBuild = useCallback(() => {
    const worker = forestWorkerRef.current;
    const request = pendingWorkerBuildRef.current;
    if (!worker || !workerReadyRef.current || workerBusyRef.current || !request) return;
    pendingWorkerBuildRef.current = null;
    workerBusyRef.current = true;
    workerPostedAtRef.current.set(request.requestId, performance.now());
    worker.postMessage(request);
  }, []);

  useEffect(() => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("../rendering/forestProps.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      let cancelled = false;
      const retry = window.setTimeout(() => {
        if (!cancelled) setWorkerError(true);
      }, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(retry);
      };
    }
    forestWorkerRef.current = worker;
    const workerPostedAt = workerPostedAtRef.current;
    const disableWorker = () => {
      worker.terminate();
      if (forestWorkerRef.current === worker) forestWorkerRef.current = null;
      workerReadyRef.current = false;
      workerBusyRef.current = false;
      pendingWorkerBuildRef.current = null;
      workerPostedAt.clear();
      setWorkerError(true);
    };
    worker.onmessage = (event: MessageEvent<ForestWorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        workerReadyRef.current = true;
        flushPendingWorkerBuild();
        return;
      }
      if (message.type === "assets-ready") {
        const postedAt = workerAssetsPostedAtRef.current;
        workerAssetsPostedAtRef.current = null;
        if (postedAt !== null) {
          forestProfiler?.recordExternalStage(
            "forest worker assets transfer to ready",
            performance.now() - postedAt,
          );
        }
        if (message.receiveMs !== undefined) {
          forestProfiler?.recordExternalStage(
            "forest worker asset message handling",
            message.receiveMs,
          );
        }
        return;
      }
      if (message.type === "lighting-error") {
        const requestId = message.requestId;
        if (requestId === undefined) return;
        const profileRequest = lightingProfilesRef.current.get(requestId);
        lightingProfilesRef.current.delete(requestId);
        if (requestId !== latestLightingRequestIdRef.current) {
          const report = profileRequest?.profiler?.finish("cancelled", false);
          if (report) logMountainProfileReport(report);
          return;
        }
        console.error("Forest worker lighting failed; retrying on the main thread.", message.message);
        const report = profileRequest?.profiler?.finish("failed", false);
        if (report) logMountainProfileReport(report);
        setLightingWorkerError(true);
        return;
      }
      if (message.type === "lighting") {
        const requestId = message.requestId;
        if (requestId === undefined) return;
        const profileRequest = lightingProfilesRef.current.get(requestId);
        lightingProfilesRef.current.delete(requestId);
        const lightingProfiler = profileRequest?.profiler;
        if (requestId !== latestLightingRequestIdRef.current) {
          const report = lightingProfiler?.finish("cancelled", false);
          if (report) logMountainProfileReport(report);
          return;
        }
        if (lightingProfiler) {
          lightingProfiler.recordExternalStage("lighting field preparation", message.fieldMs ?? 0);
          for (let index = 0; index < (message.cacheHits ?? 0); index++) {
            lightingProfiler.recordCache("lighting fields", true);
          }
          for (let index = 0; index < (message.cacheMisses ?? 0); index++) {
            lightingProfiler.recordCache("lighting fields", false);
          }
          lightingProfiler.recordExternalStage(
            "lighting texture render and async PNG encoding",
            message.renderMs ?? 0,
          );
          if (profileRequest) {
            lightingProfiler.recordExternalStage(
              "lighting worker request to response",
              performance.now() - profileRequest.postedAt,
            );
          }
        }
        const publicationStartedAt = performance.now();
        const texturePayloads = message.textures ?? [];
        const textures = texturePayloads.map(({ key, width, height, padding, blob }) => ({
          key,
          url: URL.createObjectURL(blob),
          width,
          height,
          padding,
          byteLength: blob.size,
        }));
        const publishedTextures = publishForestLightingTextures(
          assetsRef.current,
          lightTexturesRef.current,
          lightTextureUrlsRef.current,
          textures,
        );
        setLightTextures(publishedTextures.lightTextures);
        if (profileRequest) {
          setLightTextureSettingsSignature(profileRequest.settingsSignature);
        }
        if (lightingProfiler) {
          lightingProfiler.recordExternalStage(
            "lighting texture publication",
            performance.now() - publicationStartedAt,
          );
          lightingProfiler.recordMetric(
            "Encoded lighting textures",
            publishedTextures.encodedBytes,
            "bytes",
          );
          lightingProfiler.recordMetric("Lighting textures", textures.length, "assets");
          const report = lightingProfiler.finish("completed", false);
          if (report) window.requestAnimationFrame(() => logMountainProfileReport(report));
        }
        return;
      }
      if (message.type === "error") {
        workerBusyRef.current = false;
        if (message.requestId === latestWorkerRequestIdRef.current) disableWorker();
        else flushPendingWorkerBuild();
        return;
      }
      if (message.type !== "geometry" || message.requestId === undefined) return;
      workerBusyRef.current = false;
      const postedAt = workerPostedAtRef.current.get(message.requestId);
      workerPostedAtRef.current.delete(message.requestId);
      if (forestProfiler) {
        forestProfiler.recordExternalStage(
          "forest placement worker computation",
          message.computeMs ?? 0,
        );
        if (postedAt !== undefined) {
          forestProfiler.recordExternalStage(
            "forest worker request to response",
            performance.now() - postedAt,
          );
        }
      }
      if (message.requestId === latestWorkerRequestIdRef.current) {
        setPreviewGeometry({
          width: message.width ?? SIMULATION_WIDTH,
          height: message.height ?? SIMULATION_HEIGHT,
          rasterProps: message.rasterProps ?? [],
        });
        setPreviewGeometrySignature(desiredGeometrySettingsSignatureRef.current);
      }
      flushPendingWorkerBuild();
    };
    worker.onerror = disableWorker;
    return () => {
      worker.terminate();
      forestWorkerRef.current = null;
      workerReadyRef.current = false;
      workerBusyRef.current = false;
      pendingWorkerBuildRef.current = null;
      workerAssetsPostedAtRef.current = null;
      workerPostedAt.clear();
    };
  }, [flushPendingWorkerBuild, forestProfiler]);

  useEffect(() => {
    if (assets.length === 0) return;
    const worker = forestWorkerRef.current;
    if (!worker) return;
    const transferStartedAt = performance.now();
    workerAssetsPostedAtRef.current = transferStartedAt;
    worker.postMessage({ type: "assets", assets: [...assets] });
    forestProfiler?.recordExternalStage(
      "forest worker asset transfer",
      performance.now() - transferStartedAt,
    );
    forestProfiler?.recordMetric(
      "Forest worker asset payload",
      assets.reduce((total, asset) => total + asset.data.byteLength, 0),
      "bytes",
    );
  }, [assets, forestProfiler]);

  useEffect(() => {
    if (assets.length === 0) return;
    const requestId = ++latestLightingRequestIdRef.current;
    const settingsSignature = forestLightingSettingsSignature(seed, lightSettings);
    let cancelled = false;
    let published = false;
    let fallbackTimer: number | null = null;
    const fallbackTextures: Array<ForestLightTexture & { key: string }> = [];
    const lightingProfiler = createForestProfile({
      layer: "forest-props-lighting",
      renderer: workerError || lightingWorkerError ? "svg-cpu" : "worker-cpu",
      changedSettings: ["lightSettings"],
      assetCount: assets.length,
      seed,
    });
    const worker = forestWorkerRef.current;
    let workerPostTimer: number | null = null;

    const cleanupProfileRequest = () => {
      const request = lightingProfilesRef.current.get(requestId);
      if (!request) return;
      lightingProfilesRef.current.delete(requestId);
      const report = request.profiler?.finish("cancelled", false);
      if (report) logMountainProfileReport(report);
    };

    if (!workerError && !lightingWorkerError && worker) {
      // Let the placement effect enqueue its request first on route startup.
      workerPostTimer = window.setTimeout(() => {
        workerPostTimer = null;
        if (cancelled) return;
        lightingProfilesRef.current.set(requestId, {
          profiler: lightingProfiler,
          postedAt: performance.now(),
          settingsSignature,
        });
        try {
          worker.postMessage({ type: "lighting", requestId, seed, settings: lightSettings });
        } catch (error) {
          cleanupProfileRequest();
          console.error("Could not send forest lighting to the worker.", error);
          fallbackTimer = window.setTimeout(() => {
            fallbackTimer = null;
            setLightingWorkerError(true);
          }, 0);
        }
      }, 0);
      return () => {
        cancelled = true;
        if (workerPostTimer !== null) {
          window.clearTimeout(workerPostTimer);
          const report = lightingProfiler?.finish("cancelled", false);
          if (report) logMountainProfileReport(report);
        }
        if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
        cleanupProfileRequest();
      };
    }

    const prepareOnMainThread = async () => {
      try {
        const prepareFields = () => assets.flatMap((asset) => {
          const field = buildForestLightField(asset, seed);
          return field ? [field] : [];
        });
        const fields = lightingProfiler
          ? lightingProfiler.measure("lighting field preparation", prepareFields)
          : prepareFields();
        const renderTextures = async () => {
          if (lightSettings.strength <= 0) return;
          for (const field of fields) {
            if (cancelled) return;
            const texture = await renderForestLightTexture(field, lightSettings);
            fallbackTextures.push({ key: field.key, ...texture });
          }
        };
        if (lightingProfiler) {
          await lightingProfiler.measureAsync(
            "lighting texture render and async PNG encoding",
            renderTextures,
          );
        } else {
          await renderTextures();
        }
        if (cancelled || requestId !== latestLightingRequestIdRef.current) return;
        const publicationStartedAt = performance.now();
        const publishedTextures = publishForestLightingTextures(
          assets,
          lightTexturesRef.current,
          lightTextureUrlsRef.current,
          fallbackTextures,
        );
        setLightTextures(publishedTextures.lightTextures);
        setLightTextureSettingsSignature(settingsSignature);
        published = true;
        if (lightingProfiler) {
          lightingProfiler.recordExternalStage(
            "lighting texture publication",
            performance.now() - publicationStartedAt,
          );
          lightingProfiler.recordMetric(
            "Encoded lighting textures",
            publishedTextures.encodedBytes,
            "bytes",
          );
          lightingProfiler.recordMetric("Lighting textures", fallbackTextures.length, "assets");
          const report = lightingProfiler.finish("completed", false);
          if (report) window.requestAnimationFrame(() => logMountainProfileReport(report));
        }
      } catch (error) {
        if (!cancelled) console.error("Could not prepare forest lighting textures.", error);
        const report = lightingProfiler?.finish(cancelled ? "cancelled" : "failed", false);
        if (report) logMountainProfileReport(report);
      } finally {
        if (!published) {
          for (const texture of fallbackTextures) {
            if (texture.url.startsWith("blob:")) URL.revokeObjectURL(texture.url);
          }
        }
      }
    };
    void prepareOnMainThread();
    return () => {
      cancelled = true;
    };
  }, [
    assets,
    lightSettings,
    lightingWorkerError,
    seed,
    workerError,
  ]);

  useEffect(() => {
    if (assets.length === 0) return;
    const request = {
      type: "build" as const,
      requestId: ++latestWorkerRequestIdRef.current,
      density,
      clustering,
      seed,
      settingsSignature: forestGeometrySettingsSignature(density, clustering, seed),
    };
    if (workerError) {
      let cancelled = false;
      const fallback = window.setTimeout(() => {
        if (cancelled) return;
        const build = () => buildForestPreviewGeometry(density, clustering, seed, assets);
        setPreviewGeometry(forestProfiler
          ? forestProfiler.measure("CPU fallback placement generation", build)
          : build());
        setPreviewGeometrySignature(request.settingsSignature);
      }, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(fallback);
      };
    }
    pendingWorkerBuildRef.current = request;
    flushPendingWorkerBuild();
  }, [assets, clustering, density, flushPendingWorkerBuild, forestProfiler, seed, workerError]);

  useEffect(() => {
    let cancelled = false;
    const profileThisLoad = !assetLoadProfiledRef.current;
    assetLoadProfiledRef.current = true;
    const loadAssets = forestProfiler && profileThisLoad
      ? forestProfiler.measureAsync("vegetation SVG parsing and fill rasterization", () =>
          loadAlpineVegetationRasterPropAssets())
      : loadAlpineVegetationRasterPropAssets();
    void loadAssets
      .then((loadedAssets) => {
        if (cancelled) return;
        const alpineAssets = loadedAssets;
        setAssets(alpineAssets);
        forestProfiler?.recordMetric("Loaded raster prop assets", alpineAssets.length, "assets");
        forestProfiler?.recordMetric(
          "Parsed vector path points",
          alpineAssets.reduce(
            (total, asset) => total + (asset.vectorPaths?.reduce(
              (pathTotal, path) => pathTotal + path.points.length,
              0,
            ) ?? 0),
            0,
          ),
          "points",
        );
        forestProfiler?.recordMetric(
          "Rasterized asset pixels",
          alpineAssets.reduce((total, asset) => total + asset.data.length / 4, 0),
          "pixels",
        );
        if (alpineAssets.length === 0) {
          setAssetError("The supplied alpine-tree-75 SVGs did not load.");
        }
      })
      .catch(() => {
        if (profileThisLoad) forestProfiler?.finish("failed");
        if (!cancelled) {
          setAssetError("Could not load the supplied alpine-tree-75 SVGs.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [forestProfiler]);

  useEffect(() => {
    const nextSettings: ForestPropControlSettings = {
      density,
      clustering,
      canopyMerging,
      canopyEdgeNoiseSize,
      canopyWashNoiseSize,
      canopyWashStrength,
      outlineShadowStrength,
      outlineInsetStrength,
      outlineInsetBlurRadius,
      seed,
      mapZoom,
      sourceZoom,
      showFootprints,
      lightSettings,
      centerLightGradientMultiplier,
      targetResolution,
      charcoalThickness,
      charcoalInterruptionProbability,
      centerInterruptionAmountBoost,
      centerInterruptionLengthMultiplier,
      centerDepthThreshold,
      minCenterOutlineChance,
      centerSegmentRemoval,
      showCenterDebug,
      overlapLowerInterruptionMultiplier,
      charcoalInterruptionLength,
    };
    pendingControlSettingsRef.current = nextSettings;
    const timer = window.setTimeout(() => {
      saveForestPropControlSettings(nextSettings);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    density,
    clustering,
    canopyMerging,
    canopyEdgeNoiseSize,
    canopyWashNoiseSize,
    canopyWashStrength,
    outlineShadowStrength,
    outlineInsetStrength,
    outlineInsetBlurRadius,
    seed,
    mapZoom,
    sourceZoom,
    showFootprints,
    lightSettings,
    centerLightGradientMultiplier,
    targetResolution,
    charcoalThickness,
    charcoalInterruptionProbability,
    centerInterruptionAmountBoost,
    centerInterruptionLengthMultiplier,
    centerDepthThreshold,
    minCenterOutlineChance,
    centerSegmentRemoval,
    showCenterDebug,
    overlapLowerInterruptionMultiplier,
    charcoalInterruptionLength,
  ]);

  useEffect(() => () => {
    saveForestPropControlSettings(pendingControlSettingsRef.current);
  }, []);

  const scheduleNavigationCommit = () => {
    if (navigationFrameRef.current !== null) return;
    navigationFrameRef.current = window.requestAnimationFrame(() => {
      navigationFrameRef.current = null;
      const frameAt = performance.now();
      navigationFrameIntervalRef.current = navigationFrameAtRef.current === null
        ? null
        : frameAt - navigationFrameAtRef.current;
      navigationFrameAtRef.current = frameAt;
      const pending = pendingNavigationRef.current;
      pendingNavigationRef.current = null;
      if (!pending) return;
      setMapZoom(pending.zoom);
      setPreviewPan(pending.pan);
    });
  };

  const cancelScheduledNavigationFrame = useCallback(() => {
    const frame = navigationFrameRef.current;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      navigationFrameRef.current = null;
    }
  }, []);
  useEffect(() => cancelScheduledNavigationFrame, [cancelScheduledNavigationFrame]);

  const handlePreviewWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    navigationStartRef.current = { kind: "zoom", startedAt: performance.now() };
    const viewport = previewViewportRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const cursorX = event.clientX - bounds.left;
    const cursorY = event.clientY - bounds.top;
    const current = pendingNavigationRef.current ?? {
      zoom: mapZoom,
      pan: previewPan,
    };
    const nextZoom = Math.max(
      1,
      Math.min(16, current.zoom * Math.exp(-event.deltaY * 0.0015)),
    );
    pendingNavigationRef.current = {
      zoom: nextZoom,
      pan: {
        x: cursorX - (cursorX - current.pan.x) * (nextZoom / current.zoom),
        y: cursorY - (cursorY - current.pan.y) * (nextZoom / current.zoom),
      },
    };
    scheduleNavigationCommit();
  };

  const handlePreviewPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
    dragRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      panX: previewPan.x,
      panY: previewPan.y,
    };
  };

  const handlePreviewPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    navigationStartRef.current = { kind: "pan", startedAt: performance.now() };
    pendingNavigationRef.current = {
      zoom: mapZoom,
      pan: {
        x: drag.panX + event.clientX - drag.clientX,
        y: drag.panY + event.clientY - drag.clientY,
      },
    };
    scheduleNavigationCommit();
  };

  const stopPreviewDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDragging(false);
    dragRef.current = null;
  };

  const handleForestRasterProfile = useCallback((event: {
    stage: string;
    durationMs: number;
    pixels?: number;
    stale?: boolean;
  }) => {
    forestProfiler?.recordExternalStage(event.stage, event.durationMs);
    if (event.pixels !== undefined) {
      forestProfiler?.recordMetric(`${event.stage} pixels`, event.pixels, "pixels");
    }
    if (event.stale) {
      forestProfiler?.recordMetric("Stale forest raster jobs", 1, "jobs");
    }
  }, [forestProfiler]);

  const handleForestProfilerRender = (
    id: string,
    _phase: string,
    actualDuration: number,
    baseDuration: number,
    _startTime: number,
    commitTime: number,
  ) => {
    if (!forestProfiler) return;
    if (id !== "forest-navigation") return;
    const navigation = navigationStartRef.current;
    const settingsChanged = diffMountainProfileSettings(
      previousProfileSettingsRef.current,
      profileSettings,
    );
    previousProfileSettingsRef.current = profileSettings;
    const canvas = previewViewportRef.current?.querySelector("canvas");
    const placementTotal = previewGeometry?.rasterProps?.length ?? 0;
    forestProfiler.setMetadata({
      changedSettings: navigation ? [navigation.kind] : settingsChanged,
      density,
      clustering,
      seed,
      assetCount: assets.length,
      placementCount: placementTotal,
      zoom: mapZoom,
    });
    forestProfiler.recordExternalStage("React forest preview render", actualDuration);
    forestProfiler.recordMetric("React forest preview base duration", baseDuration, "ms");
    forestProfiler.recordMetric("Forest placements", placementTotal, "trees");
    forestProfiler.recordMetric("Loaded tree assets", assets.length, "assets");
    forestProfiler.recordMetric(
      "Configured export resolution area",
      targetWidth * targetHeight,
      "pixels",
    );
    const isFirstCompleteForestCommit =
      !firstCompleteForestCommitProfiledRef.current &&
      assets.length > 0 &&
      previewGeometry !== null;
    if (isFirstCompleteForestCommit) {
      firstCompleteForestCommitProfiledRef.current = true;
      forestProfiler.recordExternalStage(
        "Route mount to first forest snapshot commit",
        performance.now() - routeOpenedAtRef.current,
      );
    }
    const extendedPerformance = performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
    };
    if (extendedPerformance.memory) {
      forestProfiler.recordMetric(
        "JavaScript heap in use",
        extendedPerformance.memory.usedJSHeapSize,
        "bytes",
      );
    }
    forestProfiler.recordMetric(
      "Encoded lighting textures",
      [...lightTextures.values()].reduce((sum, texture) =>
        sum + texture.byteLength,
      0),
      "bytes",
    );
    if (canvas) {
      forestProfiler.recordMetric(
        "Visible preview canvas pixels",
        canvas.width * canvas.height,
        "pixels",
      );
    }
    for (const duration of longTaskSamplesRef.current.splice(0)) {
      forestProfiler.recordMetric("Observed long task", duration, "ms");
    }
    const report = forestProfiler.finish("completed", false);
    forestProfiler.reset({
      requestId: ++forestProfileRequestId,
      layer: "forest-props",
      width: SIMULATION_WIDTH,
      height: SIMULATION_HEIGHT,
      renderer: "svg-canvas",
      changedSettings: [],
    });
    if (!report) return;

    if (!navigation) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        addMountainProfileStage(
          report,
            isFirstCompleteForestCommit
            ? "Forest snapshot commit-to-second-frame latency"
            : "React commit-to-second-frame latency",
          Math.max(0, performance.now() - commitTime),
        );
        logMountainProfileReport(report);
      }));
      return;
    }
    navigationStartRef.current = null;
    navigationSamplesRef.current.push({
      kind: navigation.kind,
      latencyMs: performance.now() - navigation.startedAt,
      reactMs: actualDuration,
      frameIntervalMs: navigationFrameIntervalRef.current,
      zoom: mapZoom,
      stages: Object.fromEntries(report.stages.map((stage) => [stage.stage, stage.durationMs])),
    });
    if (navigationSamplesRef.current.length < 20) return;

    const samples = navigationSamplesRef.current.splice(0);
    const percentile95 = (values: number[]) => {
      const sorted = [...values].sort((first, second) => first - second);
      return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
    };
    console.groupCollapsed(`Forest navigation profile (${samples.length} interactions)`);
    console.log({
      placements: previewGeometry?.rasterProps?.length ?? 0,
      rasterCanvasPixels: canvas ? canvas.width * canvas.height : 0,
      recentLongTasks: longTaskSamplesRef.current.splice(0),
    });
    console.table(["pan", "zoom"].map((kind) => {
      const group = samples.filter((sample) => sample.kind === kind);
      const latencies = group.map((sample) => sample.latencyMs);
      const reactDurations = group.map((sample) => sample.reactMs);
      const frameIntervals = group.flatMap((sample) =>
        sample.frameIntervalMs === null ? [] : [sample.frameIntervalMs],
      );
      return {
        interaction: kind,
        samples: group.length,
        latencyAverageMs: group.length
          ? Number((latencies.reduce((sum, value) => sum + value, 0) / group.length).toFixed(2))
          : 0,
        latencyP95Ms: group.length ? Number(percentile95(latencies).toFixed(2)) : 0,
        latencyMaxMs: group.length ? Number(Math.max(...latencies).toFixed(2)) : 0,
        reactAverageMs: group.length
          ? Number((reactDurations.reduce((sum, value) => sum + value, 0) / group.length).toFixed(2))
          : 0,
        reactP95Ms: group.length ? Number(percentile95(reactDurations).toFixed(2)) : 0,
        frameP95Ms: frameIntervals.length
          ? Number(percentile95(frameIntervals).toFixed(2))
          : 0,
        zoom: group.length ? group[group.length - 1].zoom : mapZoom,
      };
    }));
    const stageNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.stages)))];
    console.table(stageNames.map((stage) => {
      const durations = samples
        .map((sample) => sample.stages[stage])
        .filter((duration): duration is number => duration !== undefined);
      return {
        stage,
        samples: durations.length,
        averageMs: Number((durations.reduce((sum, duration) => sum + duration, 0) / durations.length).toFixed(2)),
        p95Ms: Number(percentile95(durations).toFixed(2)),
        maxMs: Number(Math.max(...durations).toFixed(2)),
      };
    }));
    console.groupEnd();
  };

  return (
    <div className="h-screen w-full overflow-x-hidden overflow-y-auto bg-[#1d2820] px-5 py-6 text-[#e9e3c6]">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#9eaf8a]">
              Forest prop test route
            </p>
            <h1 className="mt-1 text-2xl font-semibold">
              New alpine-tree-75 grouping review
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#c5c9a9]">
              Dense stands form a soft green canopy with full tree props drawn
              over it. Outline breaks grow more frequent and larger toward the
              center; individual trees keep adjustable shading and foliage texture.
              Use the mouse wheel to zoom the preview and drag to pan; tree
              rotation is intentionally fixed. Scroll outside the preview to
              reach the source artwork below.
            </p>
          </div>
          <button
            type="button"
            className="rounded border border-[#819374] px-3 py-2 text-xs font-semibold text-[#d8dfbf] hover:bg-[#304234]"
            onClick={() => {
              window.location.href = "/";
            }}
          >
            Back to map
          </button>
        </header>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <section className="rounded-xl border border-[#536650] bg-[#dcdab7] p-3 shadow-2xl">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[#4b5b42]">
              <span>
                Procedural forest stand · cached raster preview · {targetWidth}×{targetHeight} target
              </span>
              <span>Preview zoom {mapZoom.toFixed(1)}×</span>
            </div>
            <div
              ref={previewViewportRef}
              className="relative h-[min(70vh,760px)] w-full overflow-hidden rounded border border-[#9da37a] bg-[#dcdab7] select-none"
              style={{
                touchAction: "none",
                cursor: isDragging ? "grabbing" : "grab",
              }}
              onWheel={handlePreviewWheel}
              onPointerDown={handlePreviewPointerDown}
              onPointerMove={handlePreviewPointerMove}
              onPointerUp={stopPreviewDrag}
              onPointerCancel={stopPreviewDrag}
              onDoubleClick={() => {
                setMapZoom(1);
                setPreviewPan({ x: 0, y: 0 });
              }}
            >
              {assets.length === 0 ? (
                <div className="flex min-h-64 items-center justify-center text-sm text-[#4b5b42]">
                  Loading the supplied alpine-tree-75 SVG...
                </div>
              ) : previewGeometry === null ? (
                <div className="flex min-h-64 items-center justify-center text-sm text-[#4b5b42]">
                  Building the procedural forest stand...
                </div>
              ) : (
                <Profiler id="forest-navigation" onRender={handleForestProfilerRender}>
                  <ForestRasterPreview
                    snapshot={forestSnapshot}
                    camera={forestCamera}
                    updating={forestSnapshotUpdating}
                    generationError={forestSnapshotError}
                    onRetryGeneration={() => setForestSnapshotRetryRevision((revision) => revision + 1)}
                    onProfile={handleForestRasterProfile}
                  />
                </Profiler>
              )}
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[#59664b]">
              Scroll to zoom, drag to move, and double-click to reset. The
              vector source is rasterized for navigation; detail refreshes when
              you stop moving. Dashed boxes show ground reservations.
            </p>
          </section>

          <aside className="rounded-xl border border-[#536650] bg-[#26352a] p-4 text-sm shadow-xl">
            <h2 className="font-semibold text-[#f0e8c5]">Forest test controls</h2>
            <label className="mt-5 block text-xs text-[#c8d0b1]">
              Prop density <span className="float-right tabular-nums">{density.toFixed(2)}</span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0.2"
                max="1.5"
                step="0.05"
                value={density}
                onChange={(event) => setDensity(Number(event.target.value))}
              />
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Stand clustering <span className="float-right tabular-nums">{clustering.toFixed(2)}</span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={clustering}
                onChange={(event) => setClustering(Number(event.target.value))}
              />
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Canopy merging <span className="float-right tabular-nums">{canopyMerging}%</span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0"
                max="100"
                step="1"
                value={canopyMerging}
                onChange={(event) => setCanopyMerging(Number(event.target.value))}
              />
              <span className="mt-1 block text-[10px] leading-4 text-[#aab79b]">
                Merge connected stands of at least five trees; full props stay on top.
              </span>
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Canopy edge noise size
              <span className="float-right tabular-nums">
                {canopyEdgeNoiseSize.toFixed(1)}×
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0.5"
                max="2"
                step="0.1"
                value={canopyEdgeNoiseSize}
                onChange={(event) =>
                  setCanopyEdgeNoiseSize(Number(event.target.value))
                }
              />
              <span className="mt-1 block text-[10px] leading-4 text-[#aab79b]">
                Larger values make wider, softer edge breakup.
              </span>
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Canopy wash noise size
              <span className="float-right tabular-nums">
                {canopyWashNoiseSize.toFixed(1)}×
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0.5"
                max="2"
                step="0.1"
                value={canopyWashNoiseSize}
                onChange={(event) =>
                  setCanopyWashNoiseSize(Number(event.target.value))
                }
              />
              <span className="mt-1 block text-[10px] leading-4 text-[#aab79b]">
                Larger values make broader color mottling.
              </span>
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Canopy wash strength
              <span className="float-right tabular-nums">
                {Math.round(canopyWashStrength * 100)}%
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0"
                max="2"
                step="0.01"
                value={canopyWashStrength}
                onChange={(event) => setCanopyWashStrength(Number(event.target.value))}
              />
              <span className="mt-1 block text-[10px] leading-4 text-[#aab79b]">
                Controls the strength of the canopy's light and shadow color washes.
              </span>
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Center depth threshold
              <span className="float-right tabular-nums">
                {centerDepthThreshold.toFixed(2)}
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0.05"
                max="1"
                step="0.01"
                value={centerDepthThreshold}
                onChange={(event) =>
                  setCenterDepthThreshold(Number(event.target.value))
                }
              />
              <span className="mt-1 block text-[10px] leading-4 text-[#aab79b]">
                Lower values expand the center zone; higher values limit it to deeper canopy.
              </span>
            </label>
            <label className="mt-4 flex cursor-pointer items-center gap-2 text-xs text-[#c8d0b1]">
              <input
                className="accent-[#a8bd82]"
                type="checkbox"
                checked={showCenterDebug}
                onChange={(event) => setShowCenterDebug(event.target.checked)}
              />
              Debug cluster-center gradient
            </label>
            {showCenterDebug ? (
              <div className="mt-2 rounded border border-[#536650] bg-[#1c2a21] p-2 text-[10px] leading-4 text-[#c8d0b1]">
                <div
                  className="h-3 rounded-sm"
                  style={{
                    background:
                      "linear-gradient(to right, hsl(190 86% 54%) 0%, hsl(95 86% 54%) 50%, hsl(0 86% 54%) 100%)",
                  }}
                />
                <div className="mt-1 flex justify-between gap-2">
                  <span>Edge 0</span>
                  <span>
                    Thin {forestPropInkReductionStartDepth(centerDepthThreshold).toFixed(2)}
                  </span>
                  <span>Core {centerDepthThreshold.toFixed(2)}+</span>
                </div>
                <p className="mt-1">Each prop shows its measured stand-center depth; red is the minimum-ink threshold.</p>
              </div>
            ) : null}
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Seed
              <input
                className="mt-2 w-full rounded border border-[#61745c] bg-[#1c2a21] px-2 py-1.5 text-[#e9e3c6]"
                type="number"
                value={seed}
                onChange={(event) => setSeed(Number(event.target.value) || 0)}
              />
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Preview zoom <span className="float-right tabular-nums">{mapZoom.toFixed(1)}x</span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="1"
                max="16"
                step="0.1"
                value={mapZoom}
                onChange={(event) => setMapZoom(Number(event.target.value))}
              />
            </label>
            <div className="mt-5 border-t border-[#536650] pt-4">
              <h3 className="font-semibold text-[#f0e8c5]">Cone shading</h3>
              <p className="mt-1 text-xs leading-5 text-[#c8d0b1]">
                A raised center, sun-facing inset edge, and mottled foliage.
                Tree light settings update the individual previews below.
              </p>
              <label className="mt-4 block text-xs text-[#c8d0b1]">
                Sun direction
                <span className="float-right tabular-nums text-[#f0e8c5]">
                  {lightSettings.sunAzimuthDeg}° ({compassHeading(lightSettings.sunAzimuthDeg)})
                </span>
                <input
                  className="mt-2 w-full accent-amber-400"
                  type="range"
                  min="0"
                  max="360"
                  step="5"
                  value={lightSettings.sunAzimuthDeg}
                  onChange={(event) =>
                    setLightSettings((current) => ({
                      ...current,
                      sunAzimuthDeg: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="mt-4 block text-xs text-[#c8d0b1]">
                Strength
                <span className="float-right tabular-nums">
                  {Math.round(lightSettings.strength * 100)}%
                </span>
                <input
                  className="mt-2 w-full accent-[#a8bd82]"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={lightSettings.strength}
                  onChange={(event) =>
                    setLightSettings((current) => ({
                      ...current,
                      strength: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="mt-4 block text-xs text-[#c8d0b1]">
                Tree outline shadow strength
                <span className="float-right tabular-nums">
                  {Math.round(outlineShadowStrength * 100)}%
                </span>
                <input
                  className="mt-2 w-full accent-[#a8bd82]"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={outlineShadowStrength}
                  onChange={(event) => setOutlineShadowStrength(Number(event.target.value))}
                />
              </label>
              <label className="mt-4 block text-xs text-[#c8d0b1]">
                Outline inset strength
                <span className="float-right tabular-nums">
                  {Math.round(outlineInsetStrength * 100)}%
                </span>
                <input
                  className="mt-2 w-full accent-[#a8bd82]"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={outlineInsetStrength}
                  onChange={(event) => setOutlineInsetStrength(Number(event.target.value))}
                />
              </label>
              <label className="mt-4 block text-xs text-[#c8d0b1]">
                Outline inset blur radius
                <span className="float-right tabular-nums">
                  {outlineInsetBlurRadius.toFixed(1)}u
                </span>
                <input
                  className="mt-2 w-full accent-[#a8bd82]"
                  type="range"
                  min="0"
                  max="8"
                  step="0.1"
                  value={outlineInsetBlurRadius}
                  onChange={(event) => setOutlineInsetBlurRadius(Number(event.target.value))}
                />
                <span className="mt-1 block text-[10px] leading-4 text-[#aab79b]">
                  Softens only the inward shadow from drawn outline segments.
                </span>
              </label>
              <label className="mt-4 block text-xs text-[#c8d0b1]">
                Inset width
                <span className="float-right tabular-nums">
                  {(lightSettings.edgeDepth * 100).toFixed(1)}%
                </span>
                <input
                  className="mt-2 w-full accent-[#a8bd82]"
                  type="range"
                  min="0.02"
                  max="0.18"
                  step="0.005"
                  value={lightSettings.edgeDepth}
                  onChange={(event) =>
                    setLightSettings((current) => ({
                      ...current,
                      edgeDepth: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="mt-4 block text-xs text-[#c8d0b1]">
                Edge softness
                <span className="float-right tabular-nums">
                  {Math.round(lightSettings.softness * 100)}%
                </span>
                <input
                  className="mt-2 w-full accent-[#a8bd82]"
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.01"
                  value={lightSettings.softness}
                  onChange={(event) =>
                    setLightSettings((current) => ({
                      ...current,
                      softness: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="mt-4 block text-xs text-[#c8d0b1]">
                Noise amount
                <span className="float-right tabular-nums">
                  {Math.round(lightSettings.noise * 100)}%
                </span>
                <input
                  className="mt-2 w-full accent-[#a8bd82]"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={lightSettings.noise}
                  onChange={(event) =>
                    setLightSettings((current) => ({
                      ...current,
                      noise: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="mt-4 flex items-center justify-between gap-3 text-xs text-[#c8d0b1]">
                Light color
                <span className="flex items-center gap-2">
                  <span className="font-mono tabular-nums">{lightSettings.color}</span>
                  <input
                    className="h-8 w-10 cursor-pointer rounded border border-[#61745c] bg-transparent"
                    type="color"
                    value={lightSettings.color}
                    onChange={(event) =>
                      setLightSettings((current) => ({
                        ...current,
                        color: event.target.value,
                      }))
                    }
                  />
                </span>
              </label>
            </div>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Charcoal thickness
              <span className="float-right tabular-nums">
                {charcoalThickness.toFixed(2)}u · {Math.round(
                  charcoalThickness * (targetWidth / SIMULATION_WIDTH),
                )}px @ target
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0.25"
                max="1.5"
                step="0.05"
                value={charcoalThickness}
                onChange={(event) =>
                  setCharcoalThickness(Number(event.target.value))
                }
              />
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Edge interruption amount
              <span className="float-right tabular-nums">
                {Math.round(charcoalInterruptionProbability * 100)}% gaps
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0"
                max="0.9"
                step="0.05"
                value={charcoalInterruptionProbability}
                onChange={(event) =>
                  setCharcoalInterruptionProbability(
                    Number(event.target.value),
                  )
                }
              />
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Center interruption boost
              <span className="float-right tabular-nums">
                +{Math.round(centerInterruptionAmountBoost * 100)} points
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0"
                max="0.95"
                step="0.01"
                value={centerInterruptionAmountBoost}
                onChange={(event) =>
                  setCenterInterruptionAmountBoost(Number(event.target.value))
                }
              />
              <span className="mt-1 block text-[10px] leading-4 text-[#aab79b]">
                Adds more breaks toward the center while progressively removing ink segments. Drawn ink stays fully opaque.
              </span>
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Center segment removal
              <span className="float-right tabular-nums">
                {Math.round(centerSegmentRemoval * 100)}%
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={centerSegmentRemoval}
                onChange={(event) => setCenterSegmentRemoval(Number(event.target.value))}
              />
              <span className="mt-1 block text-[10px] leading-4 text-[#aab79b]">
                Removes whole ink segments progressively toward the center. 0% disables center thinning and the extra center gaps; 100% applies the full removal and interruption settings. Surviving marks keep their length and opacity.
              </span>
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Minimum center ink segments
              <span className="float-right tabular-nums">
                {(minCenterOutlineChance * 100).toFixed(1)}%
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0"
                max={MAX_MIN_CENTER_OUTLINE_CHANCE}
                step="0.001"
                value={minCenterOutlineChance}
                onChange={(event) =>
                  setMinCenterOutlineChance(Number(event.target.value))
                }
              />
              <span className="mt-1 block text-[10px] leading-4 text-[#aab79b]">
                Fraction of outline and detail segments retained in the deepest canopy.
              </span>
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Overlap lower-half multiplier
              <span className="float-right tabular-nums">
                {overlapLowerInterruptionMultiplier.toFixed(1)}x base
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="1"
                max="3"
                step="0.1"
                value={overlapLowerInterruptionMultiplier}
                onChange={(event) =>
                  setOverlapLowerInterruptionMultiplier(
                    Number(event.target.value),
                  )
                }
              />
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Edge interruption length
              <span className="float-right tabular-nums">
                {charcoalInterruptionLength.toFixed(1)}x · linked to thickness
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="0.5"
                max="2.5"
                step="0.1"
                value={charcoalInterruptionLength}
                onChange={(event) =>
                  setCharcoalInterruptionLength(Number(event.target.value))
                }
              />
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Center gap length
              <span className="float-right tabular-nums">
                {centerInterruptionLengthMultiplier.toFixed(1)}x at center
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="1"
                max="12"
                step="0.5"
                value={centerInterruptionLengthMultiplier}
                onChange={(event) =>
                  setCenterInterruptionLengthMultiplier(
                    Number(event.target.value),
                  )
                }
              />
              <span className="mt-1 block text-[10px] leading-4 text-[#aab79b]">
                Gap size grows from the edge value toward this center multiplier.
              </span>
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Center light gradient multiplier
              <span className="float-right tabular-nums">
                {centerLightGradientMultiplier.toFixed(2)}x
              </span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min={MIN_FOREST_CENTER_LIGHT_GRADIENT_MULTIPLIER}
                max={MAX_FOREST_CENTER_LIGHT_GRADIENT_MULTIPLIER}
                step="0.05"
                value={centerLightGradientMultiplier}
                onChange={(event) =>
                  setCenterLightGradientMultiplier(Number(event.target.value))
                }
              />
              <span className="mt-1 block text-[10px] leading-4 text-[#aab79b]">
                The center-depth threshold sets where light reaches 0. More negative values keep it brighter until a sharper cutoff.
              </span>
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Export framing
              <select
                className="mt-2 w-full rounded border border-[#61745c] bg-[#1c2a21] px-2 py-1.5 text-[#e9e3c6]"
                value={targetResolution}
                onChange={(event) => {
                  setTargetResolution(event.target.value as "8k" | "16k");
                }}
              >
                <option value="8k">8K · 7680×5760</option>
                <option value="16k">16K · 15360×11520</option>
              </select>
            </label>
            <label className="mt-4 block text-xs text-[#c8d0b1]">
              Source zoom <span className="float-right tabular-nums">{sourceZoom.toFixed(1)}x</span>
              <input
                className="mt-2 w-full accent-[#a8bd82]"
                type="range"
                min="1"
                max="16"
                step="0.1"
                value={sourceZoom}
                onChange={(event) => setSourceZoom(Number(event.target.value))}
              />
            </label>
            <label className="mt-5 flex items-center gap-2 text-xs text-[#c8d0b1]">
              <input
                type="checkbox"
                checked={showFootprints}
                onChange={(event) => setShowFootprints(event.target.checked)}
              />
              Show ground reservations
            </label>
            <dl className="mt-6 space-y-2 border-t border-[#536650] pt-4 text-xs text-[#c8d0b1]">
              <div className="flex justify-between gap-3">
                <dt>Placed trees</dt>
                <dd className="font-semibold tabular-nums text-[#f0e8c5]">{placementCount}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Source artwork</dt>
                <dd className="font-semibold text-[#f0e8c5]">SVG path + adjustable light</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Source coordinate space</dt>
                <dd className="font-semibold text-[#f0e8c5]">512x512 SVG</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Outline</dt>
                <dd className="font-semibold text-[#f0e8c5]">
                  Green canopy with individual props
                </dd>
              </div>
            </dl>
            {assetError ? (
              <p className="mt-4 rounded border border-[#9d6659] bg-[#422d29] p-2 text-xs text-[#f3c0a8]">
                {assetError}
              </p>
            ) : null}
          </aside>
        </div>

        <section className="rounded-xl border border-[#536650] bg-[#26352a] p-4 shadow-xl">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-semibold text-[#f0e8c5]">New source artwork</h2>
              <p className="mt-1 text-xs text-[#c8d0b1]">
                These previews show the source paths with adjustable mottled
                light and ink detail. The source SVG files are unchanged.
              </p>
            </div>
            <span className="text-xs tabular-nums text-[#c8d0b1]">{sourceZoom.toFixed(1)}x review</span>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {ALPINE_TREE_75_ASSET_URLS.map((url, index) => (
              <figure key={url} className="overflow-auto rounded border border-[#536650] bg-[#18231b] p-3">
                <div className="flex min-h-56 min-w-[220px] items-center justify-center bg-[conic-gradient(#354936_25%,#26352a_0_50%,#354936_0_75%,#26352a_0)] bg-[length:20px_20px]">
                  <ForestSourcePreview
                    asset={assets[index]}
                    texture={assets[index] ? lightTextures.get(assets[index].key) : undefined}
                    url={url}
                    index={index}
                    zoom={sourceZoom}
                    lightSettings={lightSettings}
                  />
                </div>
                <figcaption className="mt-2 text-xs capitalize text-[#d8dfbf]">
                  {TREE_LABEL} · {index === 0 ? "original" : `variant ${index.toString().padStart(2, "0")}`}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

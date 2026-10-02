/**
 * Builds a light field over the forest canopy and renders it as a texture for the props.
 */
import { SimplexNoise } from "../core/noise";
import type { VegetationRasterPropAsset } from "./vegetationRenderer";

export interface ForestLightSettings {
  strength: number;
  sunAzimuthDeg: number;
  edgeDepth: number;
  softness: number;
  noise: number;
  color: string;
}

export const DEFAULT_FOREST_LIGHT_SETTINGS: ForestLightSettings = {
  strength: 0.7,
  sunAzimuthDeg: 315,
  edgeDepth: 0.075,
  softness: 0.68,
  noise: 0.82,
  color: "#91ab84",
};

export interface ForestLightTexture {
  url: string;
  width: number;
  height: number;
  padding: number;
  byteLength: number;
}

export interface ForestLightField {
  key: string;
  width: number;
  height: number;
  padding: number;
  canopyWidth: number;
  baseColor: readonly [number, number, number];
  rowCenters: Float32Array;
  rowHalfWidths: Float32Array;
  /** Distances are stored in thirty-seconds of a source pixel. */
  edgeDistances: Uint16Array;
  /** Signed noise is quantized to [-32767, 32767] to keep cached fields compact. */
  coarseNoise: Int16Array;
  mixedNoise: Int16Array;
}

const LIGHT_TEXTURE_PADDING = 16;
const DIAGONAL_DISTANCE = Math.SQRT2;
const EDGE_DISTANCE_SCALE = 32;
const NOISE_SCALE = 32767;
// Render options are structured-cloned when they cross worker boundaries, so
// object identity cannot identify a reusable source shape. Cache by a compact
// signature of the exact vector silhouette inputs instead. The byte budget
// bounds worker-local retention across assets and seed changes.
const LIGHT_FIELD_CACHE_BYTE_BUDGET = 32 * 1024 * 1024;
const lightFieldCache = new Map<string, { field: ForestLightField; byteLength: number }>();
let lightFieldCacheBytes = 0;
const lightTextureCache = new WeakMap<ForestLightField, Map<string, HTMLCanvasElement | OffscreenCanvas>>();
const revisionFloat = new Float64Array(1);
const revisionWords = new Uint32Array(revisionFloat.buffer);

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hashAssetKey(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  }
  return hash | 0;
}

function forestLightFieldSourceKey(
  asset: VegetationRasterPropAsset,
  seed: number,
  fillPath: NonNullable<VegetationRasterPropAsset["vectorPaths"]>[number],
): string {
  let firstHash = 2166136261;
  let secondHash = 0x9e3779b9;
  const mixWord = (word: number): void => {
    firstHash = Math.imul(firstHash ^ word, 16777619);
    secondHash = Math.imul(secondHash ^ word, 2246822519);
  };
  const mixNumber = (value: number): void => {
    revisionFloat[0] = value;
    mixWord(revisionWords[0]);
    mixWord(revisionWords[1]);
  };
  const mixString = (value: string): void => {
    for (let index = 0; index < value.length; index++) {
      mixWord(value.charCodeAt(index));
    }
  };
  mixString(asset.key);
  mixNumber(asset.width);
  mixNumber(asset.height);
  mixNumber(seed);
  for (const channel of fillPath.fillColor ?? []) mixNumber(channel);
  mixNumber(fillPath.points.length);
  for (const point of fillPath.points) {
    mixNumber(point.x);
    mixNumber(point.y);
  }
  return `${asset.key}:${firstHash >>> 0}:${secondHash >>> 0}`;
}

/** Stable source revision key for worker caches that outlive one asset clone. */
export function forestLightFieldSourceRevisionKey(
  asset: VegetationRasterPropAsset,
  seed: number,
): string | undefined {
  const fillPath = asset.vectorPaths?.find((path) => path.closed && path.fillColor);
  if (!fillPath || fillPath.points.length < 3) return undefined;
  return forestLightFieldSourceKey(asset, seed, fillPath);
}

function forestLightFieldByteLength(field: ForestLightField): number {
  return field.edgeDistances.byteLength + field.coarseNoise.byteLength +
    field.mixedNoise.byteLength + field.rowCenters.byteLength +
    field.rowHalfWidths.byteLength;
}

function createForestLightingCanvas(
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function forestLightingContext(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  readFrequently = false,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  return canvas.getContext("2d", { willReadFrequently: readFrequently }) as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
}

/** Build shape coordinates once; sliders only recolor these cached fields. */
export function buildForestLightField(
  asset: VegetationRasterPropAsset,
  seed: number,
): ForestLightField | null {
  const fillPath = asset.vectorPaths?.find((path) => path.closed && path.fillColor);
  if (!fillPath || fillPath.points.length < 3) return null;
  const cacheKey = forestLightFieldSourceKey(asset, seed, fillPath);
  const cached = lightFieldCache.get(cacheKey);
  if (cached) {
    lightFieldCache.delete(cacheKey);
    lightFieldCache.set(cacheKey, cached);
    return cached.field;
  }

  const padding = LIGHT_TEXTURE_PADDING;
  const width = Math.round(asset.width) + padding * 2;
  const height = Math.round(asset.height) + padding * 2;
  const canvas = createForestLightingCanvas(width, height);
  const context = forestLightingContext(canvas, true);
  if (!context) return null;
  context.fillStyle = "#fff";
  context.beginPath();
  for (const [index, point] of fillPath.points.entries()) {
    if (index === 0) context.moveTo(point.x + padding, point.y + padding);
    else context.lineTo(point.x + padding, point.y + padding);
  }
  context.closePath();
  context.fill();
  const alpha = context.getImageData(0, 0, width, height).data;
  const count = width * height;
  const floatEdgeDistances = new Float32Array(count);
  const rowLeft = new Float32Array(height).fill(Number.POSITIVE_INFINITY);
  const rowRight = new Float32Array(height).fill(Number.NEGATIVE_INFINITY);
  let canopyWidth = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (alpha[index * 4 + 3] < 128) continue;
      floatEdgeDistances[index] = 10000;
      rowLeft[y] = Math.min(rowLeft[y], x);
      rowRight[y] = Math.max(rowRight[y], x);
    }
    if (Number.isFinite(rowLeft[y])) {
      canopyWidth = Math.max(canopyWidth, rowRight[y] - rowLeft[y]);
    }
  }

  // Chamfer distance gives the dark inset a width measured from the actual
  // scalloped silhouette, rather than from a circular or rectangular mask.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (floatEdgeDistances[index] === 0) continue;
      let distance = floatEdgeDistances[index];
      if (x > 0) distance = Math.min(distance, floatEdgeDistances[index - 1] + 1);
      if (y > 0) {
        distance = Math.min(distance, floatEdgeDistances[index - width] + 1);
        if (x > 0) distance = Math.min(distance, floatEdgeDistances[index - width - 1] + DIAGONAL_DISTANCE);
        if (x + 1 < width) distance = Math.min(distance, floatEdgeDistances[index - width + 1] + DIAGONAL_DISTANCE);
      }
      floatEdgeDistances[index] = distance;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const index = y * width + x;
      if (floatEdgeDistances[index] === 0) continue;
      let distance = floatEdgeDistances[index];
      if (x + 1 < width) distance = Math.min(distance, floatEdgeDistances[index + 1] + 1);
      if (y + 1 < height) {
        distance = Math.min(distance, floatEdgeDistances[index + width] + 1);
        if (x > 0) distance = Math.min(distance, floatEdgeDistances[index + width - 1] + DIAGONAL_DISTANCE);
        if (x + 1 < width) distance = Math.min(distance, floatEdgeDistances[index + width + 1] + DIAGONAL_DISTANCE);
      }
      floatEdgeDistances[index] = distance;
    }
  }
  const edgeDistances = new Uint16Array(count);
  for (let index = 0; index < count; index++) {
    edgeDistances[index] = Math.min(
      0xffff,
      Math.round(floatEdgeDistances[index] * EDGE_DISTANCE_SCALE),
    );
  }

  const rawRowCenters = new Float32Array(height);
  const rawRowHalfWidths = new Float32Array(height);
  let firstFilledRow = rowLeft.findIndex(Number.isFinite);
  if (firstFilledRow < 0) return null;
  let previousLeft = rowLeft[firstFilledRow];
  let previousRight = rowRight[firstFilledRow];
  for (let y = 0; y < height; y++) {
    if (Number.isFinite(rowLeft[y])) {
      previousLeft = rowLeft[y];
      previousRight = rowRight[y];
    }
    rawRowCenters[y] = (previousLeft + previousRight) * 0.5;
    rawRowHalfWidths[y] = Math.max(1, (previousRight - previousLeft) * 0.5);
  }
  const rowCenters = new Float32Array(height);
  const rowHalfWidths = new Float32Array(height);
  const smoothingRadius = Math.max(8, Math.round(asset.height * 0.085));
  const smoothingSigma = smoothingRadius * 0.42;
  for (let y = 0; y < height; y++) {
    let centerSum = 0;
    let halfWidthSum = 0;
    let weightSum = 0;
    for (let offset = -smoothingRadius; offset <= smoothingRadius; offset++) {
      const sampleY = Math.max(0, Math.min(height - 1, y + offset));
      const weight = Math.exp(-0.5 * (offset / smoothingSigma) ** 2);
      centerSum += rawRowCenters[sampleY] * weight;
      halfWidthSum += rawRowHalfWidths[sampleY] * weight;
      weightSum += weight;
    }
    rowCenters[y] = centerSum / weightSum;
    rowHalfWidths[y] = halfWidthSum / weightSum;
  }

  const noise = new SimplexNoise(seed ^ hashAssetKey(asset.key));
  const coarseNoise = new Int16Array(count);
  const mixedNoise = new Int16Array(count);
  const encodeNoise = (value: number) => Math.max(
    -NOISE_SCALE,
    Math.min(NOISE_SCALE, Math.round(value * NOISE_SCALE)),
  );
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const sourceX = x - padding;
      const sourceY = y - padding;
      const coarse = noise.fbm(sourceX / 116, sourceY / 116, 3, 1.92, 0.55);
      const medium = noise.fbm((sourceX + 31) / 31, (sourceY - 47) / 31, 2, 1.9, 0.5);
      const vertical = noise.fbm((sourceX - 13) / 22, (sourceY + 41) / 47, 2, 1.9, 0.5);
      const grain = noise.noise2D((sourceX - 19) / 7, (sourceY + 23) / 7);
      coarseNoise[index] = encodeNoise(coarse);
      mixedNoise[index] = encodeNoise(
        coarse * 0.4 + medium * 0.3 + vertical * 0.22 + grain * 0.08,
      );
    }
  }

  const field: ForestLightField = {
    key: asset.key,
    width,
    height,
    padding,
    canopyWidth,
    baseColor: fillPath.fillColor ?? [86, 123, 84],
    rowCenters,
    rowHalfWidths,
    edgeDistances,
    coarseNoise,
    mixedNoise,
  };
  const byteLength = forestLightFieldByteLength(field);
  if (byteLength <= LIGHT_FIELD_CACHE_BYTE_BUDGET) {
    while (
      lightFieldCache.size > 0 &&
      lightFieldCacheBytes + byteLength > LIGHT_FIELD_CACHE_BYTE_BUDGET
    ) {
      const oldestKey = lightFieldCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = lightFieldCache.get(oldestKey);
      if (oldest) lightFieldCacheBytes -= oldest.byteLength;
      lightFieldCache.delete(oldestKey);
    }
    lightFieldCache.set(cacheKey, { field, byteLength });
    lightFieldCacheBytes += byteLength;
  }
  return field;
}

function parseLightColor(hex: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return [166, 186, 148];
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16),
  ];
}

export function renderForestLightTextureCanvas(
  field: ForestLightField,
  settings: ForestLightSettings,
): HTMLCanvasElement | OffscreenCanvas {
  const canvas = createForestLightingCanvas(field.width, field.height);
  // Forest rendering repeatedly draws this source into a CPU-backed canvas.
  // A GPU-backed source can force a readback for each tree placement.
  const context = forestLightingContext(canvas, true);
  if (!context) throw new Error("Could not render forest light texture.");
  const image = context.createImageData(field.width, field.height);
  const lightColor = parseLightColor(settings.color);
  const edgeWidth = Math.max(3, field.canopyWidth * settings.edgeDepth);
  const shadowScale = 1 - settings.strength * 0.38;
  // Match the main renderer: 0 degrees is north, 90 degrees is east.
  const azimuth = settings.sunAzimuthDeg * Math.PI / 180;
  const sunX = Math.sin(azimuth);
  const sunY = -Math.cos(azimuth);
  for (let y = 0; y < field.height; y++) {
    for (let x = 0; x < field.width; x++) {
      const index = y * field.width + x;
      const side = Math.max(-1, Math.min(1,
        (x - field.rowCenters[y]) / field.rowHalfWidths[y],
      ));
      const warpedSide = Math.max(-1, Math.min(1,
      side + (field.coarseNoise[index] / NOISE_SCALE) * settings.noise * 0.16,
      ));
      const frontNormal = Math.sqrt(Math.max(0, 1 - warpedSide * warpedSide));
      const coneLight = clamp01(
        frontNormal * 0.8 + warpedSide * sunX * 0.34 +
          (y / field.height - 0.5) * sunY * 0.24 + 0.04,
      );
      const edgeDistance = field.edgeDistances[index] / EDGE_DISTANCE_SCALE;
      const edgeT = clamp01(edgeDistance / edgeWidth);
      const smoothEdge = edgeT * edgeT * (3 - 2 * edgeT);
      const inset = 0.1 + 0.9 * (
        edgeT * (1 - settings.softness) + smoothEdge * settings.softness
      );
      const noise = (field.mixedNoise[index] / NOISE_SCALE) * settings.noise *
        settings.strength * 0.86 * (0.6 + Math.abs(side) * 0.7);
      let bevel = 0;
      if (edgeT < 1 && x > 0 && x + 1 < field.width && y > 0 && y + 1 < field.height) {
        const dx = (field.edgeDistances[index + 1] - field.edgeDistances[index - 1]) /
          EDGE_DISTANCE_SCALE;
        const dy = (field.edgeDistances[index + field.width] - field.edgeDistances[index - field.width]) /
          EDGE_DISTANCE_SCALE;
        const length = Math.hypot(dx, dy);
        if (length > 0.01) {
          // Distance gradients point inward. The outward normal faces the sun
          // on the bright side of the silhouette and away on the shaded side.
          const facing = -(dx * sunX + dy * sunY) / length;
          bevel = facing * (1 - smoothEdge) * settings.strength * 0.16;
        }
      }
      const lightMix = clamp01(
        settings.strength * (0.06 + coneLight * 0.82) * inset + noise + bevel,
      );
      const pixel = index * 4;
      for (let channel = 0; channel < 3; channel++) {
        const shadow = field.baseColor[channel] * shadowScale;
        image.data[pixel + channel] = Math.round(
          shadow + (lightColor[channel] - shadow) * lightMix,
        );
      }
      image.data[pixel + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/** Reuse recolored per-asset textures between preview updates and export tiles. */
export function getForestLightTextureCanvas(
  field: ForestLightField,
  settings: ForestLightSettings,
): HTMLCanvasElement | OffscreenCanvas {
  const key = JSON.stringify([
    settings.strength,
    settings.sunAzimuthDeg,
    settings.edgeDepth,
    settings.softness,
    settings.noise,
    settings.color,
  ]);
  let cache = lightTextureCache.get(field);
  const cached = cache?.get(key);
  if (cached) return cached;
  const canvas = renderForestLightTextureCanvas(field, settings);
  if (!cache) {
    cache = new Map();
    lightTextureCache.set(field, cache);
  }
  cache.set(key, canvas);
  if (cache.size > 3) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  return canvas;
}

export async function renderForestLightTextureBlob(
  field: ForestLightField,
  settings: ForestLightSettings,
): Promise<Blob> {
  const canvas = renderForestLightTextureCanvas(field, settings);
  const blob = "convertToBlob" in canvas
    ? await canvas.convertToBlob({ type: "image/png" })
    : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error(`Could not encode forest lighting texture ${field.key}.`);
  return blob;
}

export async function renderForestLightTexture(
  field: ForestLightField,
  settings: ForestLightSettings,
): Promise<ForestLightTexture> {
  const blob = await renderForestLightTextureBlob(field, settings);
  return {
    url: URL.createObjectURL(blob),
    width: field.width,
    height: field.height,
    padding: field.padding,
    byteLength: blob.size,
  };
}

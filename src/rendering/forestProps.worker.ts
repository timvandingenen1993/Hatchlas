/**
 * Worker that loads forest assets, builds prop geometry and computes lighting off the main thread.
 */
import {
  buildForestPreviewGeometry,
  FOREST_SIMULATION_HEIGHT,
  FOREST_SIMULATION_WIDTH,
} from "./forestPropScene";
import {
  buildForestLightField,
  forestLightFieldSourceRevisionKey,
  renderForestLightTextureBlob,
  type ForestLightField,
  type ForestLightSettings,
} from "./forestPropLighting";
import type { VegetationRasterPropAsset } from "./vegetationRenderer";

interface AssetMessage {
  type: "assets";
  assets: VegetationRasterPropAsset[];
}

interface BuildMessage {
  type: "build";
  requestId: number;
  density: number;
  clustering: number;
  seed: number;
}

interface LightingMessage {
  type: "lighting";
  requestId: number;
  seed: number;
  settings: ForestLightSettings;
}

type ForestWorkerMessage = AssetMessage | BuildMessage | LightingMessage;

let rasterPropAssets: readonly VegetationRasterPropAsset[] = [];
let latestLightingRequestId = 0;
const FOREST_LIGHT_FIELD_CACHE_LIMIT = 128 * 1024 * 1024;
const forestLightFieldCache = new Map<string, ForestLightField>();
let forestLightFieldCacheBytes = 0;

function cachedForestLightField(
  asset: VegetationRasterPropAsset,
  seed: number,
): { field: ForestLightField | null; hit: boolean; buildMs: number } {
  const cacheKey = forestLightFieldSourceRevisionKey(asset, seed);
  if (!cacheKey) {
    const startedAt = performance.now();
    const field = buildForestLightField(asset, seed);
    return { field, hit: false, buildMs: performance.now() - startedAt };
  }
  const cached = forestLightFieldCache.get(cacheKey);
  if (cached) {
    forestLightFieldCache.delete(cacheKey);
    forestLightFieldCache.set(cacheKey, cached);
    return { field: cached, hit: true, buildMs: 0 };
  }
  const startedAt = performance.now();
  const field = buildForestLightField(asset, seed);
  const buildMs = performance.now() - startedAt;
  if (!field) return { field: null, hit: false, buildMs };
  const bytes = field.edgeDistances.byteLength + field.coarseNoise.byteLength +
    field.mixedNoise.byteLength + field.rowCenters.byteLength + field.rowHalfWidths.byteLength;
  if (bytes <= FOREST_LIGHT_FIELD_CACHE_LIMIT) {
    while (
      forestLightFieldCache.size > 0 &&
      forestLightFieldCacheBytes + bytes > FOREST_LIGHT_FIELD_CACHE_LIMIT
    ) {
      const oldestKey = forestLightFieldCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = forestLightFieldCache.get(oldestKey);
      if (oldest) {
        forestLightFieldCacheBytes -= oldest.edgeDistances.byteLength +
          oldest.coarseNoise.byteLength + oldest.mixedNoise.byteLength +
          oldest.rowCenters.byteLength + oldest.rowHalfWidths.byteLength;
      }
      forestLightFieldCache.delete(oldestKey);
    }
    forestLightFieldCache.set(cacheKey, field);
    forestLightFieldCacheBytes += bytes;
  }
  return { field, hit: false, buildMs };
}

async function buildLightingTextures(message: LightingMessage): Promise<void> {
  latestLightingRequestId = message.requestId;
  const startedAt = performance.now();
  let fieldMs = 0;
  let renderMs = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const textures: Array<{
    key: string;
    width: number;
    height: number;
    padding: number;
    blob: Blob;
  }> = [];

  try {
    if (message.settings.strength > 0) {
      for (const asset of rasterPropAssets) {
        if (message.requestId !== latestLightingRequestId) return;
        const result = cachedForestLightField(asset, message.seed);
        fieldMs += result.buildMs;
        if (result.hit) cacheHits++;
        else cacheMisses++;
        const field = result.field;
        if (!field) continue;
        const renderStartedAt = performance.now();
        const blob = await renderForestLightTextureBlob(field, message.settings);
        renderMs += performance.now() - renderStartedAt;
        if (message.requestId !== latestLightingRequestId) return;
        textures.push({
          key: field.key,
          width: field.width,
          height: field.height,
          padding: field.padding,
          blob,
        });
        // Yield between assets so a newer slider value can supersede this job.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    if (message.requestId !== latestLightingRequestId) return;
    self.postMessage({
      type: "lighting",
      requestId: message.requestId,
      fieldMs,
      renderMs,
      cacheHits,
      cacheMisses,
      totalMs: performance.now() - startedAt,
      textures,
    });
  } catch (error) {
    if (message.requestId !== latestLightingRequestId) return;
    self.postMessage({
      type: "lighting-error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

self.addEventListener("message", (event: MessageEvent<ForestWorkerMessage>) => {
  const message = event.data;
  if (message.type === "assets") {
    const receivedAt = performance.now();
    rasterPropAssets = message.assets;
    latestLightingRequestId++;
    forestLightFieldCache.clear();
    forestLightFieldCacheBytes = 0;
    self.postMessage({
      type: "assets-ready",
      count: rasterPropAssets.length,
      receiveMs: performance.now() - receivedAt,
    });
    return;
  }

  if (message.type === "lighting") {
    void buildLightingTextures(message);
    return;
  }

  const startedAt = performance.now();
  try {
    const geometry = buildForestPreviewGeometry(
      message.density,
      message.clustering,
      message.seed,
      rasterPropAssets,
    );
    self.postMessage({
      type: "geometry",
      requestId: message.requestId,
      width: FOREST_SIMULATION_WIDTH,
      height: FOREST_SIMULATION_HEIGHT,
      rasterProps: geometry.rasterProps ?? [],
      computeMs: performance.now() - startedAt,
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

self.postMessage({ type: "ready" });

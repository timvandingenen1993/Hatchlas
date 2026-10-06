import { MIN_POSITIVE_SCALE } from "../config/inspectorBounds";
/**
 * Mountain Base DEM Processing & Analysis Pipeline
 * Loads the user's high-resolution mountain heightmap base and derives:
 * - Elevation scaling & spatial metrics
 * - Slopes, aspect angles, and 3D surface normals
 * - Multidirectional Swiss hillshading & ambient occlusion
 * - Priority-Flood conditioned drainage network, flow accumulation & Strahler stream orders
 * - Flow-backed channel width and braided-fan rendering
 * - Bounded routed fluvial incision with optional DEM rerouting
 * - Orographic windward/leeward precipitation & rain shadow
 * - Solar irradiance & insolation micro-climate
 * - Ecological biomes & landform classification (TPI)
 * - Contour lines & elevation cross-sections
 */

import { biomeEdgeNoise, DEFAULT_BIOME_EDGE_NOISE_SCALE_M } from "./biomeEdgeNoise";
import { openDrainageToFloor } from "./drainageOpening";
import {
  computeOrographicPrecipitationRate,
  OROGRAPHIC_DEFAULTS,
} from "./orographicPrecipitation";
import {
  classifyHoldridgeLifeZone,
  HOLDRIDGE_ZONE_CODES,
  holdridgeBiotemperatureFromAnnualMean,
  holdridgeZoneName,
  holdridgePetRatio,
} from "./holdridgeLifeZones";
import type { MountainProfiler } from "../rendering/mountainProfiler";

export interface MountainDEMData {
  width: number;
  height: number;
  domainWidthKm: number;
  domainHeightKm: number;
  /** Half-width used when regional climate fields classify biome zones. */
  biomeEdgeNoiseScaleM?: number;
  biomeEdgeStrength?: number;
  biomeRegionScaleKm?: number;
  dxMeters: number;
  dyMeters: number;
  minElevationM: number;
  maxElevationM: number;
  /** Water datum used for routing/classification; not written into elevation. */
  oceanSurfaceElevationM?: number;
  elevation: Float32Array; // Physical elevation in meters
  normalizedElevation: Float32Array; // 0.0 to 1.0
  slopeDeg: Float32Array; // Slope angle in degrees (0 to 90)
  aspectDeg: Float32Array; // Compass aspect in degrees (0 to 360, 0=N, 90=E, 180=S, 270=W)
  normals: Float32Array; // 3 floats per cell (nx, ny, nz)
  hillshade: Float32Array; // Multidirectional Swiss relief shade (0.0 to 1.0)
  ambientOcclusion: Float32Array; // Sky view factor / valley shadow (0.0 to 1.0)
  // Four-neighbour Laplacian profile curvature (negative=convex crest/ridge,
  // positive=concave valley/hollow).
  curvature: Float32Array;
  tpi: Float32Array; // Topographic Position Index (ridge vs slope vs valley)
  flowAccumulation: Float32Array; // Upstream contributing cell count
  drainageAreaKm2: Float32Array; // Drainage basin area in km^2
  rainfallWeightedAreaKm2: Float32Array; // Accumulated runoff expressed as an equivalent wet-climate catchment
  runoffDepthMmYr: Float32Array; // Local precipitation available to streams after climatic water loss
  dischargeM3s: Float32Array; // Accumulated mean annual runoff discharge
  strahlerOrder: Uint8Array; // Strahler stream order (0=none, 1=rill to 6=braided trunk)
  riverCenterlineMask: Uint8Array; // 1 = routed thalweg, including submerged mouth continuation
  isRiverChannel: Uint8Array; // 1 = river / submerged continuation / braided channel, 0 = dry land
  riverChannelRadius?: Uint8Array; // Bank-full raster radius used by the water-stage calculation
  riverMouthMask?: Uint8Array; // 1 = ocean cell belonging to a routed river mouth
  riverMouthAreaKm2?: Float32Array; // Inherited terrestrial catchment carried into the mouth
  waterDepthM: Float32Array; // Estimated water depth in channels
  flowDirection: Int8Array; // D8 flow direction (0-7, -1=pit/edge)
  erosionDepthM: Float32Array; // Cumulative fluvial and marine incision applied to the DEM
  precipitationMmYr: Float32Array; // Orographic precipitation
  solarInsolation: Float32Array; // Incident solar radiation index (0.0 to 1.0)
  temperatureC: Float32Array; // Temperature with lapse rate
  biomeType: Uint8Array; // Ecological biome ID
  /** Holdridge life zone per cell, as an index into HOLDRIDGE_ZONE_CODES. */
  holdridgeZone?: Uint8Array;
  /** Height above the nearest river or lake along the flow path, m (Infinity = none). */
  heightAboveDrainageM?: Float32Array;
  isOcean: Uint8Array; // 1 = source no-data/ocean cell, 0 = land
  /** River-fed lake water depth in meters (spill level minus bed), 0 = no lake. */
  lakeDepthM?: Float32Array;
  /** Authoritative generated wetland-pool cells at DEM resolution. */
  wetlandPoolMask?: Uint8Array;
  /** Authoritative union of ocean, routed water, and wetland pools. */
  visualWaterMask?: Uint8Array;
  /** Optional antialiased pool coverage used by scaled export tiles. */
  wetlandPoolCoverage?: Float32Array;
  /** Optional antialiased visual-water coverage used by scaled export tiles. */
  visualWaterCoverage?: Float32Array;
  /** Layered river silt depth, 0 = none, 1 = at the river (land cells only). */
  siltDepth?: Float32Array;
  /** Smoothed silt depth the silt crease lines are traced from. */
  siltCreaseDepth?: Float32Array;
}

export type MountainBiomeId =
  | 0 // Permanent Glacier & Ice Summit
  | 1 // Alpine Bare Rock & Arête Scree
  | 2 // Alpine Tundra & Meadow
  | 3 // Subalpine Conifer Forest
  | 4 // Montane Broadleaf Woodland
  | 5 // Riparian Canyon & Shrubland
  | 6 // Braided River Gravel Bar & Channel
  | 7 // Valley Floodplain & Wetland
  | 8 // Ocean
  | 9 // River Silt & Alluvial Soil
  | 10 // River Rock & Scree Bank
  | 11 // Sandy Beach
  | 12 // Silty Beach & River Mouth
  | 13 // Rocky Shore
  | 14 // Coastal Cliff
  | 15 // Sand Desert & Dunes
  | 16 // Rocky Desert & Hamada
  | 17 // Dry Steppe
  | 18 // Grassland & Prairie
  | 19 // Desert Oasis
  | 20; // Montane Meadow

/** Stable labels shared by the hover inspector and elevation profiles. */
export const MOUNTAIN_BIOME_LABELS: readonly string[] = [
  "Glacier & Permanent Snow",
  "Alpine Bare Rock / Arete Scree",
  "Alpine Tundra & Meadow",
  "Subalpine Conifer Forest",
  "Montane Broadleaf Woodland",
  "Riparian Canyon Shrubland",
  "Braided River Fan & Channels",
  "Valley Floodplain & Wetland",
  "Ocean",
  "River Silt & Alluvial Soil",
  "River Rock & Scree Bank",
  "Sandy Beach",
  "Silty Beach & River Mouth",
  "Rocky Shore",
  "Coastal Cliff",
  "Sand Desert & Dunes",
  "Rocky Desert & Hamada",
  "Dry Steppe",
  "Grassland & Prairie",
  "Desert Oasis",
  "Montane Meadow",
];

/** Holdridge life zone name of a DEM cell for inspection, or "—" if none. */
export function getMountainClimateZoneLabel(dem: MountainDEMData, index: number): string {
  const code = HOLDRIDGE_ZONE_CODES[dem.holdridgeZone?.[index] ?? 255];
  return code ? holdridgeZoneName(code) : "—";
}

/** Biome name with its numeric ID, e.g. "Dry Steppe (17)", for inspection. */
export function getMountainBiomeLabel(biomeId: number): string {
  return `${MOUNTAIN_BIOME_LABELS[biomeId] ?? "Unknown biome"} (${biomeId})`;
}

export interface BaseDEMOptions {
  domainWidthKm?: number;
  domainHeightKm?: number;
  minElevationM?: number;
  maxElevationM?: number;
  oceanElevationM?: number; // Water-surface datum for classification/routing; never overwrites DEM substrate
  oceanMask?: Uint8Array;
  /** Internal submerged-bed override carried between erosion passes. */
  oceanFloorElevationM?: Float32Array;
  sunAzimuthDeg?: number;
  sunAltitudeDeg?: number;
  verticalExaggeration?: number;
  windAzimuthDeg?: number;
  windSpeedMs?: number;
  basePrecipitationMmYr?: number;
  baseTemperatureC?: number;
  riverThresholdKm2?: number;
  waterStageScale?: number; // 0.2 to 3.0 (controls channel water volume & width)
  flowRateScale?: number; // 0.2 to 1.0; slower flow raises residence time and bank stage
  wetlandElevationThresholdM?: number; // Maximum elevation for the legacy valley floodplain/wetland rule
  biomeEdgeNoiseScaleM?: number;
  biomeEdgeStrength?: number;
  biomeRegionScaleKm?: number; // Half-width of the regional climate window used for biome zones
  erosionStrength?: number; // 0 = disabled, 1 = full bounded fluvial incision
  marineErosionStrength?: number; // 0 = disabled, 1 = marine erosion at the evolution strength
  erosionIterations?: number; // Number of water-driven terrain evolution/rerouting passes
  erosionTimeScale?: number; // Relative geomorphic duration; 1 = one baseline pass
  waterStageGrowthPerStep?: number; // Bank-full stage growth per evolution pass (0 = constant stage)
}

/** Number of water evolution steps the studio exposes and precomputes. */
export const MOUNTAIN_WATER_EVOLUTION_STEPS = 5;

/**
 * Minimal per-step evolution state. A full DEM is ~110 bytes per cell, so
 * callers that keep every step retain this instead and rebuild on demand.
 */
export interface MountainEvolutionState {
  luminance: Float32Array;
  oceanFloorElevationM?: Float32Array;
  erosionDepthM: Float32Array;
}

/**
 * Smooths a scalar field with a separable box filter. Biomes describe
 * vegetation/climate regions, so their inputs need a larger spatial support
 * than the cell-scale DEM used for relief, drainage, and shading.
 */
function smoothBiomeField(
  source: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  if (radius <= 0) return source.slice();

  const horizontal = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  const prefix = new Float64Array(Math.max(width, height) + 1);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    prefix[0] = 0;
    for (let x = 0; x < width; x++)
      prefix[x + 1] = prefix[x] + source[rowOffset + x];

    for (let x = 0; x < width; x++) {
      const start = Math.max(0, x - radius);
      const end = Math.min(width - 1, x + radius);
      horizontal[rowOffset + x] =
        (prefix[end + 1] - prefix[start]) / (end - start + 1);
    }
  }

  for (let x = 0; x < width; x++) {
    prefix[0] = 0;
    for (let y = 0; y < height; y++)
      prefix[y + 1] = prefix[y] + horizontal[y * width + x];

    for (let y = 0; y < height; y++) {
      const start = Math.max(0, y - radius);
      const end = Math.min(height - 1, y + radius);
      result[y * width + x] =
        (prefix[end + 1] - prefix[start]) / (end - start + 1);
    }
  }

  return result;
}

/** Calculates broad-relief slope from a regional elevation field. */
function calculateRegionalSlope(
  elevation: Float32Array,
  width: number,
  height: number,
  dxMeters: number,
  dyMeters: number,
): Float32Array {
  const slopeDeg = new Float32Array(elevation.length);

  for (let y = 0; y < height; y++) {
    const yPrev = Math.max(0, y - 1);
    const yNext = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const xPrev = Math.max(0, x - 1);
      const xNext = Math.min(width - 1, x + 1);
      const dzdx =
        (elevation[y * width + xNext] - elevation[y * width + xPrev]) /
        ((xNext - xPrev) * dxMeters || dxMeters);
      const dzdy =
        (elevation[yNext * width + x] - elevation[yPrev * width + x]) /
        ((yNext - yPrev) * dyMeters || dyMeters);
      slopeDeg[y * width + x] =
        Math.atan(Math.hypot(dzdx, dzdy)) * (180 / Math.PI);
    }
  }

  return slopeDeg;
}

/**
 * Removes isolated non-river biome pixels after climate-scale classification.
 * Routed channels are deliberately excluded: they are linear hydrology
 * overlays, not ecological region boundaries.
 */
function stabilizeBiomeZones(
  width: number,
  height: number,
  biomeType: Uint8Array,
  riverMask: Uint8Array,
  passes: number,
): void {
  let current = biomeType.slice();
  const neighborOffsets = [
    -1,
    1,
    -width,
    width,
    -width - 1,
    -width + 1,
    width - 1,
    width + 1,
  ];

  for (let pass = 0; pass < passes; pass++) {
    const next = current.slice();

    for (let index = 0; index < current.length; index++) {
      if (riverMask[index] === 1) continue;
      if (current[index] === 8) continue;

      const x = index % width;
      const y = Math.floor(index / width);
      const counts = new Uint8Array(MOUNTAIN_BIOME_LABELS.length);
      let bestBiome = current[index];
      let bestCount = 0;
      let centerCount = 0;

      for (const offset of neighborOffsets) {
        const neighbor = index + offset;
        if (
          neighbor < 0 ||
          neighbor >= current.length ||
          riverMask[neighbor] === 1
        )
          continue;
        const neighborX = neighbor % width;
        const neighborY = Math.floor(neighbor / width);
        if (
          neighborY < 0 ||
          neighborY >= height ||
          Math.abs(neighborX - x) > 1 ||
          Math.abs(neighborY - y) > 1
        )
          continue;

        const biome = current[neighbor];
        if (biome === 8) continue;
        counts[biome]++;
        if (biome === current[index]) centerCount++;
        if (counts[biome] > bestCount) {
          bestBiome = biome;
          bestCount = counts[biome];
        }
      }

      // Require a clear local majority. This rounds pixel stair-steps at a
      // regional boundary without erasing narrow legitimate bands.
      if (
        bestBiome !== current[index] &&
        bestCount >= 4 &&
        bestCount > centerCount + 1
      ) {
        next[index] = bestBiome;
      }
    }

    current = next;
  }

  biomeType.set(current);
}

/**
 * Removes isolated micro-puddles and speckles of ocean water that are smaller
 * than minimum contiguous cell threshold (e.g. 16 cells).
 */
export function filterSmallOceanComponents(
  isOcean: Uint8Array,
  width: number,
  height: number,
  minCells: number = 16,
): Uint8Array {
  const totalCells = width * height;
  if (totalCells <= 36 || width < 4 || height < 4) return isOcean;
  const effectiveMinCells = Math.min(
    minCells,
    Math.max(1, Math.floor(totalCells * 0.05)),
  );
  const cleaned = isOcean.slice();
  const visited = new Uint8Array(totalCells);
  const queue = new Int32Array(totalCells);

  for (let i = 0; i < totalCells; i++) {
    if (cleaned[i] !== 1 || visited[i] === 1) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;

    while (head < tail) {
      const idx = queue[head++];
      const cx = idx % width;
      const cy = Math.floor(idx / width);

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (cleaned[nIdx] === 1 && visited[nIdx] === 0) {
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          }
        }
      }
    }

    // If this ocean puddle is smaller than the minimum threshold, remove it
    if (tail < effectiveMinCells) {
      for (let k = 0; k < tail; k++) {
        cleaned[queue[k]] = 0;
      }
    }
  }

  return cleaned;
}

/**
 * Smoothes jagged 1-pixel staircase corners and spurs along the ocean coastline.
 */
export function smoothOceanMask(
  isOcean: Uint8Array,
  width: number,
  height: number,
  passes: number = 2,
): Uint8Array {
  if (width < 3 || height < 3) return isOcean;
  let src = isOcean;
  let dst = new Uint8Array(width * height);

  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - 1) * width;
      const y1 = y * width;
      const y2 = Math.min(height - 1, y + 1) * width;

      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - 1);
        const x1 = x;
        const x2 = Math.min(width - 1, x + 1);

        // Count 3x3 ocean neighbors with center weighting
        const count =
          src[y0 + x0] +
          src[y0 + x1] * 2 +
          src[y0 + x2] +
          src[y1 + x0] * 2 +
          src[y1 + x1] * 4 +
          src[y1 + x2] * 2 +
          src[y2 + x0] +
          src[y2 + x1] * 2 +
          src[y2 + x2];

        // 8 is exactly half of total weight 16
        dst[y1 + x1] = count >= 8 ? 1 : 0;
      }
    }
    src = dst.slice();
  }

  return src;
}

/**
 * Exact Separable 2D Euclidean Distance Transform (Meijster / Saito Algorithm).
 * Computes mathematically exact Euclidean distance and nearest-source coordinates
 * for every cell on the grid in linear O(N) time with zero directional bias and
 * zero raster scanline artifacts.
 */
export function exactEuclideanDistanceTransform(
  sourceMask: Uint8Array,
  width: number,
  height: number,
): { distance: Float32Array; nearestX: Int16Array; nearestY: Int16Array } {
  const totalCells = width * height;
  const distance = new Float32Array(totalCells).fill(1e9);
  const nearestX = new Int16Array(totalCells).fill(-1);
  const nearestY = new Int16Array(totalCells).fill(-1);

  let hasSource = false;
  for (let i = 0; i < totalCells; i++) {
    if (sourceMask[i] === 1) {
      hasSource = true;
      break;
    }
  }
  if (!hasSource) return { distance, nearestX, nearestY };

  // 1. Column pass: compute 1D vertical squared distance and nearest Y
  const gY = new Int32Array(totalCells);
  const srcY = new Int16Array(totalCells).fill(-1);
  const INF = 1e8;

  for (let x = 0; x < width; x++) {
    // Forward scan along column
    let lastY = -INF;
    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      if (sourceMask[idx] === 1) lastY = y;
      gY[idx] = lastY >= 0 ? (y - lastY) * (y - lastY) : INF;
      srcY[idx] = lastY >= 0 ? lastY : -1;
    }
    // Backward scan along column
    lastY = INF;
    for (let y = height - 1; y >= 0; y--) {
      const idx = y * width + x;
      if (sourceMask[idx] === 1) lastY = y;
      if (lastY < height) {
        const distSq = (lastY - y) * (lastY - y);
        if (distSq < gY[idx]) {
          gY[idx] = distSq;
          srcY[idx] = lastY;
        }
      }
    }
  }

  // 2. Row pass: compute lower envelope of parabolas using Meijster algorithm
  const s = new Int32Array(width);
  const t = new Int32Array(width);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    let q = 0;
    s[0] = 0;
    t[0] = 0;

    // Separation function between parabolas from column u and column i
    const f = (i: number, u: number): number => {
      const gi = gY[rowOffset + i];
      const gu = gY[rowOffset + u];
      if (gi >= INF && gu >= INF) return 0;
      if (gi >= INF) return -INF;
      if (gu >= INF) return INF;
      return (u * u - i * i + gu - gi) / (2 * (u - i));
    };

    for (let u = 1; u < width; u++) {
      while (q >= 0 && f(s[q], u) <= t[q]) q--;
      if (q < 0) {
        q = 0;
        s[0] = u;
        t[0] = 0;
      } else {
        const w = 1 + Math.floor(f(s[q], u));
        if (w < width) {
          q++;
          s[q] = u;
          t[q] = w;
        }
      }
    }

    for (let u = width - 1; u >= 0; u--) {
      const bestX = s[q];
      const bestY = srcY[rowOffset + bestX];
      const idx = rowOffset + u;
      if (bestY >= 0 && gY[rowOffset + bestX] < INF) {
        const dx = u - bestX;
        const dy = y - bestY;
        distance[idx] = Math.hypot(dx, dy);
        nearestX[idx] = bestX;
        nearestY[idx] = bestY;
      } else {
        distance[idx] = 1e9;
      }
      if (u === t[q] && q > 0) q--;
    }
  }

  return { distance, nearestX, nearestY };
}

/**
 * Extracts connected open ocean bodies (major sea expanses touching world boundaries
 * or exceeding minimum contiguous size). Excludes inland flooded river channels and depressions.
 */
/**
 * Isolates the true outer marine ocean using morphological opening.
 * Narrow backwater bays, lagoons behind barrier islands, estuaries, and river valleys
 * are eliminated during erosion (width < minMarineClearance), so only the large,
 * open sea survives and reconstructs back to the outer shoreline.
 */
export function extractDeepOpenOceanMask(
  isOcean: Uint8Array,
  isRiverChannel: Uint8Array,
  width: number,
  height: number,
  erosionRadius = 30,
): Uint8Array {
  const totalCells = width * height;

  // 1. Non-ocean barrier (dry land and active river channels)
  const barrierMask = new Uint8Array(totalCells);
  for (let i = 0; i < totalCells; i++) {
    if (isOcean[i] === 0 || isRiverChannel[i] === 1) {
      barrierMask[i] = 1;
    }
  }

  // 2. Distance from any barrier to find open sea core
  const barrierEDT = exactEuclideanDistanceTransform(
    barrierMask,
    width,
    height,
  );

  // 3. Erode ocean by opening radius R (e.g. 8.5 pixels = open water must be >= 17px wide)
  // Only the vast outer ocean has room to survive this erosion.
  const queue = new Int32Array(totalCells);
  const visited = new Uint8Array(totalCells);
  let tail = 0;

  for (let i = 0; i < totalCells; i++) {
    if (
      isOcean[i] === 1 &&
      isRiverChannel[i] === 0 &&
      barrierEDT.distance[i] >= erosionRadius
    ) {
      visited[i] = 1;
      queue[tail++] = i;
    }
  }

  // Fallback for smaller domains if no cell has full erosion radius
  if (tail === 0) {
    for (let i = 0; i < totalCells; i++) {
      if (
        isOcean[i] === 1 &&
        isRiverChannel[i] === 0 &&
        barrierEDT.distance[i] >= 4.5
      ) {
        visited[i] = 1;
        queue[tail++] = i;
      }
    }
  }
  if (tail === 0) {
    for (let i = 0; i < totalCells; i++) {
      if (
        isOcean[i] === 1 &&
        isRiverChannel[i] === 0 &&
        barrierEDT.distance[i] >= 2.5
      ) {
        visited[i] = 1;
        queue[tail++] = i;
      }
    }
  }
  if (tail === 0) {
    for (let i = 0; i < totalCells; i++) {
      if (isOcean[i] === 1 && isRiverChannel[i] === 0) {
        const cx = i % width;
        const cy = Math.floor(i / width);
        if (cx === 0 || cx === width - 1 || cy === 0 || cy === height - 1) {
          visited[i] = 1;
          queue[tail++] = i;
        }
      }
    }
  }

  // 4. Retain only the outer open ocean core
  const openSeaCore = new Uint8Array(totalCells);
  for (let k = 0; k < tail; k++) {
    openSeaCore[queue[k]] = 1;
  }

  // 5. Dilate the open sea core back to the outer shoreline
  // Only cells where isOcean === 1 that are within erosionRadius + 2.0 of the open sea core are restored.
  // Because the open sea core exists only in the open ocean, dilation reaches the outer beach but
  // CANNOT reach into the enclosed lagoon, back bays, or river valleys!
  const coreEDT = exactEuclideanDistanceTransform(openSeaCore, width, height);
  const outerOceanMask = new Uint8Array(totalCells);

  for (let i = 0; i < totalCells; i++) {
    if (
      isOcean[i] === 1 &&
      isRiverChannel[i] === 0 &&
      coreEDT.distance[i] <= erosionRadius + 2.0
    ) {
      outerOceanMask[i] = 1;
    }
  }

  return outerOceanMask;
}

export const getOpenOceanMask = extractDeepOpenOceanMask;

/**
 * Default catchment, in reference wet-climate km2, at which a stream becomes a
 * mapped river (3.2 km2 is about 77 L/s of mean flow). The orographic rain
 * model made the water budget roughly four times wetter than the earlier
 * aspect-based one, so the scale was raised four-fold to keep the same river
 * density (Heightmap2 at 2048 px: about 0.4 km of channel per km2 of land).
 */
export const DEFAULT_RIVER_THRESHOLD_KM2 = 3.2;

/**
 * Analysis cell size, in metres, that the raster-cell water widths were tuned
 * on (45–80 km maps at the 2048 px preview). Coarser cells keep that ground
 * width rather than the cell count, so a regional map does not paint every
 * river, pool and coastal shallow kilometres wide.
 */
export const WATER_REFERENCE_CELL_M = 40;

/**
 * Factor for a water width tuned in cells: 1 up to the reference cell size,
 * then shrinking so the width stays the same on the ground.
 */
export function waterWidthCellScale(cellSizeM: number): number {
  return cellSizeM > 0 ? Math.min(1, WATER_REFERENCE_CELL_M / cellSizeM) : 1;
}

/**
 * Lee-side rainfall floor, as a fraction of the base precipitation. The linear
 * orographic model removes moisture without limit (its raw floor is 0.14% of
 * the background rate), so any large ridge produced hyper-arid desert. Real
 * rain shadows keep roughly 20-50% of windward rainfall; 0.4 keeps a warm
 * (17 C) lowland out of steppe at the default 1500 mm. True desert needs a
 * dry base climate or heat, not just a ridge upwind.
 */
const MIN_OROGRAPHIC_RAIN_RATIO = 0.4;
/** Holdridge PET ratio from which a climate is desert (desert scrub and drier). */
const DESERT_PET_RATIO = 4;
/** Riparian reach beside a river: base plus a step per stream order, capped. */
const RIPARIAN_BASE_REACH_M = 150;
const RIPARIAN_REACH_PER_ORDER_M = 150;
const RIPARIAN_MAX_REACH_M = 900;
/** Fractional wobble of the corridor edge from the shared biome noise. */
const RIPARIAN_EDGE_NOISE = 0.3;
/** Width of the semi-arid transition kept between desert and wetland. */
const DESERT_WETLAND_BUFFER_M = 600;

// Rennó et al. (2008), HAND classes for terra firme: below 5.3 m above the
// nearest drainage the ground is waterlogged (water table at the surface);
// 5.3–15 m is the ecotone with a shallow water table that bank vegetation
// can reach. Nobre et al. (2011) J Hydrol 404:13–29.
const WATERLOGGED_HAND_M = 5.3;
const SHALLOW_WATER_TABLE_HAND_M = 15;
// Heuristic, not from a reference: loose sand settles on gentle ground.
const DUNE_MAX_SLOPE_DEG = 6.0;
// Flat, low-to-mid ground in the tundra and forest belts opens into meadow.
// The limits are the midpoints of the land tint's flat-slope band (6-16 deg)
// and its elevation fade (0.55-0.85), so the meadow biome covers the ground
// the tint paints green (mountainTerrainTint.ts).
const MEADOW_MAX_SLOPE_DEG = 11.0;
const MEADOW_MAX_NORMALIZED_ELEVATION = 0.7;

/**
 * Mountain biome for a Holdridge life zone (see holdridgeLifeZones.ts). The
 * altitudinal belts follow Holdridge's naming: subpolar = alpine, boreal =
 * subalpine, cool temperate = montane. Deserts and desert scrub are desert;
 * thorn steppe, thorn woodland, dry scrub and very dry forest are the
 * semi-arid formations; cool temperate steppe is grassland.
 */
export function mountainBiomeForHoldridgeZone(
  zoneCode: string,
  biotemperatureC: number,
  petRatio: number,
  slopeDeg: number,
): MountainBiomeId {
  const desert: MountainBiomeId = slopeDeg < DUNE_MAX_SLOPE_DEG ? 15 : 16;
  switch (zoneCode) {
    case "PD":
      return 1; // Polar desert: the nival belt of rock and scree
    case "SpDt": case "SpMt": case "SpWt": case "SpRt":
      return 2;
    case "BD": case "CtD": case "CtDs": case "WtD": case "WtDs":
    case "StD": case "StDs": case "TD": case "TDs":
      return desert;
    case "BDs": case "WtTs": case "StTw": case "TTw": case "TVdf":
      return 17;
    case "CtS":
      return 18;
    case "BMf": case "BWf": case "BRf":
      return 3;
    case "BaSl":
      // Bare soil sits beyond the dry or the wet edge of the chart: desert
      // on the dry side, the forest of its belt on the wet side.
      if (petRatio >= 1) return desert;
      return biotemperatureC < 1.5 ? 1 : biotemperatureC < 6 ? 3 : 4;
    default:
      return 4; // Temperate, subtropical and tropical forests
  }
}

// Horizontal reach of the relative elevation model, in cells.
const REM_MAX_DISTANCE_CELLS = 15;

/**
 * Height above the nearest river or lake, the lower of two published
 * measures. HAND (Rennó et al. 2008): elevation minus that of the first
 * drainage cell on the D8 flow path. REM (relative elevation model, Olson et
 * al. 2014, Washington Dept of Ecology channel migration zones): elevation
 * minus that of the horizontally nearest drainage cell. On flat floodplains
 * D8 paths can run beside a river and join it far downstream, which inflates
 * HAND; REM catches those banks. Cells reached by neither are Infinity.
 */
function computeHeightAboveNearestDrainage(
  width: number,
  height: number,
  elevation: Float32Array,
  flowDirection: Int8Array,
  drainageMask: Uint8Array,
  d8Offsets: readonly (readonly number[])[],
): Float32Array {
  const totalCells = width * height;
  const drainageElevation = new Float32Array(totalCells).fill(Number.NaN);
  const path = new Int32Array(totalCells);
  for (let start = 0; start < totalCells; start++) {
    if (!Number.isNaN(drainageElevation[start])) continue;
    let length = 0;
    let cell = start;
    let reached = Number.POSITIVE_INFINITY;
    while (length < totalCells) {
      if (!Number.isNaN(drainageElevation[cell])) {
        reached = drainageElevation[cell];
        break;
      }
      if (drainageMask[cell] === 1) {
        reached = elevation[cell];
        drainageElevation[cell] = reached;
        break;
      }
      path[length++] = cell;
      const direction = flowDirection[cell];
      if (direction < 0) break;
      const x = (cell % width) + d8Offsets[direction][0];
      const y = Math.floor(cell / width) + d8Offsets[direction][1];
      if (x < 0 || x >= width || y < 0 || y >= height) break;
      cell = y * width + x;
    }
    for (let index = 0; index < length; index++) drainageElevation[path[index]] = reached;
  }
  const nearest = exactEuclideanDistanceTransform(drainageMask, width, height);
  const hand = new Float32Array(totalCells);
  for (let index = 0; index < totalCells; index++) {
    const drainage = drainageElevation[index];
    let heightAbove = Number.isFinite(drainage)
      ? elevation[index] - drainage
      : Number.POSITIVE_INFINITY;
    if (nearest.distance[index] <= REM_MAX_DISTANCE_CELLS && nearest.nearestX[index] >= 0) {
      const nearestIndex = nearest.nearestY[index] * width + nearest.nearestX[index];
      heightAbove = Math.min(heightAbove, elevation[index] - elevation[nearestIndex]);
    }
    hand[index] = Math.max(0, heightAbove);
  }
  return hand;
}

/**
 * Ground beside a river or lake with a shallow water table (HAND below 15 m,
 * Rennó's waterlogged and ecotone classes) is not short of water whatever the
 * climate: desert there becomes oasis, steppe and grassland become riparian
 * shrubland. Runs after the smoothing passes so the narrow banks survive.
 */
function applyWaterloggedBankBiomes(
  biomeType: Uint8Array,
  heightAboveDrainageM: Float32Array,
  isOcean: Uint8Array,
  isRiverChannel: Uint8Array,
): void {
  for (let index = 0; index < biomeType.length; index++) {
    if (isOcean[index] === 1 || isRiverChannel[index] === 1) continue;
    if (!(heightAboveDrainageM[index] < SHALLOW_WATER_TABLE_HAND_M)) continue;
    const biome = biomeType[index];
    if (biome === 15 || biome === 16) biomeType[index] = 19;
    else if (biome === 17 || biome === 18) biomeType[index] = 5;
  }
}

/**
 * Desert does not meet wetland directly: ground between them is semi-arid, so
 * desert within the buffer of a wetland becomes dry steppe. Two separable
 * passes dilate the wetland mask by the buffer radius (Chebyshev distance).
 */
export function separateDesertFromWetland(
  width: number,
  height: number,
  biomeType: Uint8Array,
  radius: number,
): void {
  const total = width * height;
  const wetland = new Uint8Array(total);
  let hasWetland = false;
  for (let index = 0; index < total; index++) {
    if (biomeType[index] === 7) {
      wetland[index] = 1;
      hasWetland = true;
    }
  }
  if (!hasWetland) return;

  const horizontal = new Uint8Array(total);
  const near = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let last = -Infinity;
    const lastWetland = new Float64Array(width);
    for (let x = 0; x < width; x++) {
      if (wetland[row + x] === 1) last = x;
      lastWetland[x] = last;
    }
    let next = Infinity;
    for (let x = width - 1; x >= 0; x--) {
      if (wetland[row + x] === 1) next = x;
      if (x - lastWetland[x] <= radius || next - x <= radius) horizontal[row + x] = 1;
    }
  }
  for (let x = 0; x < width; x++) {
    let last = -Infinity;
    const lastWetland = new Float64Array(height);
    for (let y = 0; y < height; y++) {
      if (horizontal[y * width + x] === 1) last = y;
      lastWetland[y] = last;
    }
    let next = Infinity;
    for (let y = height - 1; y >= 0; y--) {
      if (horizontal[y * width + x] === 1) next = y;
      if (y - lastWetland[y] <= radius || next - y <= radius) near[y * width + x] = 1;
    }
  }
  for (let index = 0; index < total; index++) {
    if (near[index] === 1 && (biomeType[index] === 15 || biomeType[index] === 16)) {
      biomeType[index] = 17;
    }
  }
}

/**
 * Green corridor along rivers. HAND only reaches ground a few metres above the
 * water, and its horizontal fallback is a fixed 15 cells, so across a wide
 * valley floor dry steppe or desert could start right behind a thin riparian
 * strip. Dry ground within a distance of the river, growing with stream order
 * and roughened by the shared edge noise, becomes riparian shrubland (steppe
 * and grassland) or oasis (desert).
 */
export function applyRiparianCorridors(
  width: number,
  height: number,
  biomeType: Uint8Array,
  isOcean: Uint8Array,
  isRiverChannel: Uint8Array,
  strahlerOrder: Uint8Array,
  dxMeters: number,
  dyMeters: number,
  noiseScaleM: number,
): void {
  const total = width * height;
  const riverMask = new Uint8Array(total);
  let hasRiver = false;
  for (let index = 0; index < total; index++) {
    if (isRiverChannel[index] === 1 && isOcean[index] === 0) {
      riverMask[index] = 1;
      hasRiver = true;
    }
  }
  if (!hasRiver) return;

  const nearest = exactEuclideanDistanceTransform(riverMask, width, height);
  const cellM = Math.sqrt(dxMeters * dyMeters);
  const maximumReachM = RIPARIAN_MAX_REACH_M * (1 + RIPARIAN_EDGE_NOISE);
  for (let index = 0; index < total; index++) {
    const biome = biomeType[index];
    if (biome < 15 || biome > 18) continue;
    if (isOcean[index] === 1 || riverMask[index] === 1) continue;
    const distanceM = nearest.distance[index] * cellM;
    if (distanceM > maximumReachM) continue;
    const source = nearest.nearestY[index] * width + nearest.nearestX[index];
    const order = Math.max(1, strahlerOrder[source]);
    const x = index % width;
    const y = (index - x) / width;
    const reachM =
      Math.min(RIPARIAN_MAX_REACH_M, RIPARIAN_BASE_REACH_M + RIPARIAN_REACH_PER_ORDER_M * order) *
      (1 + RIPARIAN_EDGE_NOISE * biomeEdgeNoise(x * dxMeters, y * dyMeters, noiseScaleM, 4421));
    if (distanceM > reachM) continue;
    biomeType[index] = biome === 15 || biome === 16 ? 19 : 5;
  }
}

function classifyCoastalBiomes(
  width: number,
  height: number,
  biomeType: Uint8Array,
  isOcean: Uint8Array,
  isRiverChannel: Uint8Array,
  slopeDeg: Float32Array,
  elevation: Float32Array,
  oceanElevationM: number,
  minElevationM: number,
  maxElevationM: number,
  dxMeters: number,
  dyMeters: number,
  noiseScaleM = DEFAULT_BIOME_EDGE_NOISE_SCALE_M,
  edgeStrength = 1,
): void {
  const cellSizeM = Math.max(1, Math.min(dxMeters, dyMeters));
  const totalCells = width * height;

  // 1. Extract true outer ocean surface (excludes lagoons, back bays, and rivers)
  const outerOceanMask = extractDeepOpenOceanMask(
    isOcean,
    isRiverChannel,
    width,
    height,
  );
  const coastEDT = exactEuclideanDistanceTransform(
    outerOceanMask,
    width,
    height,
  );

  // On coarse cells a real shore is narrower than one cell. Like a river's
  // thalweg it still keeps the first coastal row (1.5 cells reaches diagonals)
  // so the coast reads as a band, not as scattered sand where noise widens it.
  const minimumShoreWidthM =
    cellSizeM > WATER_REFERENCE_CELL_M ? 1.5 * cellSizeM : 0;
  const maximumCoastWidthM = Math.max(600, minimumShoreWidthM);
  const elevationRangeM = Math.max(1, maxElevationM - minElevationM);

  // 2. Outer Coastline processing:
  // ONLY land directly bordering the outer open ocean receives sandy beaches/cliffs.
  for (let index = 0; index < totalCells; index++) {
    if (
      isOcean[index] === 1 ||
      isRiverChannel[index] === 1 ||
      biomeType[index] === 0
    )
      continue;

    const coastDistanceCells = coastEDT.distance[index];

    if (coastDistanceCells * cellSizeM <= maximumCoastWidthM) {
      const noise = biomeEdgeNoise((index % width) * dxMeters,
        Math.floor(index / width) * dyMeters, noiseScaleM);
      const widthVariation = Math.exp(noise * Math.min(3, edgeStrength) * 1.6);
      const shoreWidthM = Math.max(
        minimumShoreWidthM,
        Math.min(maximumCoastWidthM, 180 * widthVariation),
      );
      const localSlope = slopeDeg[index];
      // Coastal material follows physical terrain, not climate-region smoothing.
      const materialSlope = localSlope;
      const coastalReliefM = Math.max(0, elevation[index] - oceanElevationM);
      const isCliff =
        materialSlope >= 30.0 ||
        localSlope >= 45.0 ||
        (materialSlope >= 12.0 && coastalReliefM > elevationRangeM * 0.06);

      if (coastDistanceCells * cellSizeM > shoreWidthM) continue;
      if (isCliff) {
        biomeType[index] = 14; // Coastal Cliff
      } else if (materialSlope >= 14.0) {
        biomeType[index] = 13; // Rocky Shore
      } else if (coastalReliefM <= 12 + 8 * (noise + 1) &&
        coastDistanceCells * cellSizeM <= Math.max(
          minimumShoreWidthM,
          shoreWidthM / (1 + materialSlope * 0.12),
        )) {
        biomeType[index] = 11; // Sandy Beach
      }
    }
  }
}

/**
 * Turns the per-cell wetland rule into readable map regions. The raw heightmap
 * can have tiny slope/elevation changes that otherwise produce checkerboards of
 * wetland pixels. A local support pass keeps only candidates attached to a
 * neighboring patch, then removes very small disconnected islands.
 */
function stabilizeWetlandBiomes(
  width: number,
  height: number,
  biomeType: Uint8Array,
  wetlandCandidates: Uint8Array,
): void {
  const integralWidth = width + 1;
  const integral = new Int32Array(integralWidth * (height + 1));

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += wetlandCandidates[y * width + x];
      const integralIndex = (y + 1) * integralWidth + (x + 1);
      integral[integralIndex] = integral[y * integralWidth + (x + 1)] + rowSum;
    }
  }

  const radius = Math.max(
    1,
    Math.min(4, Math.round(Math.min(width, height) / 320)),
  );
  const neighborhoodArea = (radius * 2 + 1) ** 2;
  const minimumSupport = Math.max(3, Math.ceil(neighborhoodArea * 0.12));
  const stableWetlands = new Uint8Array(wetlandCandidates.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (wetlandCandidates[index] === 0) continue;

      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      const support =
        integral[(y1 + 1) * integralWidth + (x1 + 1)] -
        integral[y0 * integralWidth + (x1 + 1)] -
        integral[(y1 + 1) * integralWidth + x0] +
        integral[y0 * integralWidth + x0];

      const hasCardinalNeighbor =
        (x > 0 && wetlandCandidates[index - 1] === 1) ||
        (x + 1 < width && wetlandCandidates[index + 1] === 1) ||
        (y > 0 && wetlandCandidates[index - width] === 1) ||
        (y + 1 < height && wetlandCandidates[index + width] === 1);

      if (support >= minimumSupport && hasCardinalNeighbor)
        stableWetlands[index] = 1;
    }
  }

  // Remove tiny islands after smoothing. A percentage-based threshold scales
  // naturally from preview resolutions to the 2K analysis grid.
  const minimumComponentSize = Math.max(
    4,
    Math.round(Math.min(width, height) * 0.04),
  );
  const visited = new Uint8Array(stableWetlands.length);
  const stack = new Int32Array(stableWetlands.length);
  const component: number[] = [];
  const neighborOffsets = [
    -1,
    1,
    -width,
    width,
    -width - 1,
    -width + 1,
    width - 1,
    width + 1,
  ];

  for (let start = 0; start < stableWetlands.length; start++) {
    if (stableWetlands[start] === 0 || visited[start] === 1) continue;

    let stackSize = 0;
    let componentSize = 0;
    component.length = 0;
    stack[stackSize++] = start;
    visited[start] = 1;

    while (stackSize > 0) {
      const current = stack[--stackSize];
      component[componentSize++] = current;
      const x = current % width;
      const y = Math.floor(current / width);

      for (const offset of neighborOffsets) {
        const next = current + offset;
        if (
          next < 0 ||
          next >= stableWetlands.length ||
          visited[next] === 1 ||
          stableWetlands[next] === 0
        )
          continue;
        const nextX = next % width;
        const nextY = Math.floor(next / width);
        if (Math.abs(nextX - x) > 1 || Math.abs(nextY - y) > 1) continue;
        visited[next] = 1;
        stack[stackSize++] = next;
      }
    }

    if (componentSize < minimumComponentSize) {
      for (let i = 0; i < componentSize; i++) stableWetlands[component[i]] = 0;
    }
  }

  for (let index = 0; index < stableWetlands.length; index++) {
    if (stableWetlands[index] === 1) biomeType[index] = 7;
  }
}

/** Maximum long edge supported by the mountain detail renderer/exporter. */
export const MAX_MOUNTAIN_RENDER_RESOLUTION = 16384;

export interface HeightmapFitResolution {
  width: number;
  height: number;
}

/**
 * Calculates a target size that fits the source aspect ratio into a requested
 * long-edge resolution. The source is never stretched or cropped.
 */
export function getHeightmapFitResolution(
  sourceWidth: number,
  sourceHeight: number,
  requestedLongEdge: number,
  maxLongEdge: number = MAX_MOUNTAIN_RENDER_RESOLUTION,
): HeightmapFitResolution {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1
  ) {
    throw new Error("Heightmap dimensions must be positive finite numbers");
  }

  const width = Math.max(1, Math.round(sourceWidth));
  const height = Math.max(1, Math.round(sourceHeight));
  const safeMaxLongEdge = Math.max(1, Math.floor(maxLongEdge));
  const requestedEdge = Number.isFinite(requestedLongEdge)
    ? Math.round(requestedLongEdge)
    : Math.max(width, height);
  const longEdge = Math.max(1, Math.min(safeMaxLongEdge, requestedEdge));
  const scale = longEdge / Math.max(width, height);

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function isWarpableLandBiome(biome: number): boolean {
  return biome >= 1 && biome <= 5 || biome === 7 || biome >= 15 && biome <= 18 || biome === 20;
}

/**
 * Bends established land-biome boundaries with two deterministic world-space
 * noise fields. Classification interiors remain stable, and protected snow,
 * ocean, and river cells cannot be sampled through during the warp.
 */
function warpBiomeBoundaries(
  width: number,
  height: number,
  biomeType: Uint8Array,
  isOcean: Uint8Array,
  isRiverChannel: Uint8Array,
  dxMeters: number,
  dyMeters: number,
  noiseScaleM: number,
  strength: number,
): void {
  if (strength <= 0) return;
  const maxDisplacementM = noiseScaleM * 0.65 * strength;
  const source = biomeType.slice();
  const boundaryMask = new Uint8Array(source.length);

  const isBarrier = (index: number): boolean =>
    isOcean[index] === 1 || isRiverChannel[index] === 1 ||
    source[index] === 0 || source[index] === 6 || source[index] === 8;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!isWarpableLandBiome(source[index]) || isBarrier(index)) continue;
      for (let dy = -1; dy <= 1 && boundaryMask[index] === 0; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbour = ny * width + nx;
          if (
            isWarpableLandBiome(source[neighbour]) &&
            !isBarrier(neighbour) &&
            source[neighbour] !== source[index]
          ) {
            boundaryMask[index] = 1;
            break;
          }
        }
      }
    }
  }
  if (!boundaryMask.some((value) => value === 1)) return;
  const boundaryDistance = exactEuclideanDistanceTransform(boundaryMask, width, height).distance;
  const boundarySupport = Math.hypot(maxDisplacementM / dxMeters, maxDisplacementM / dyMeters) + 1;

  for (let y = 0; y < height; y++) {
    const worldY = y * dyMeters;
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!isWarpableLandBiome(source[index]) || isBarrier(index)) continue;
      if (boundaryDistance[index] > boundarySupport) continue;
      const worldX = x * dxMeters;
      const offsetX = biomeEdgeNoise(worldX, worldY, noiseScaleM, 613) * maxDisplacementM / dxMeters;
      const offsetY = biomeEdgeNoise(worldX, worldY, noiseScaleM, 1297) * maxDisplacementM / dyMeters;
      const sourceX = Math.max(0, Math.min(width - 1, Math.round(x + offsetX)));
      const sourceY = Math.max(0, Math.min(height - 1, Math.round(y + offsetY)));
      const candidateIndex = sourceY * width + sourceX;
      if (!isWarpableLandBiome(source[candidateIndex]) || isBarrier(candidateIndex)) continue;

      // A displaced sample may cross other land classes, but never a protected
      // snow, ocean, or channel cell. The warp distance is small, so this short
      // deterministic DDA check stays inexpensive.
      const steps = Math.max(Math.abs(sourceX - x), Math.abs(sourceY - y));
      let crossedBarrier = false;
      let previousX = x;
      let previousY = y;
      for (let step = 1; step < steps; step++) {
        const t = step / steps;
        const pathX = Math.round(x + (sourceX - x) * t);
        const pathY = Math.round(y + (sourceY - y) * t);
        const crossedCorner =
          pathX !== previousX && pathY !== previousY &&
          (isBarrier(previousY * width + pathX) || isBarrier(pathY * width + previousX));
        if (isBarrier(pathY * width + pathX) || crossedCorner) {
          crossedBarrier = true;
          break;
        }
        previousX = pathX;
        previousY = pathY;
      }
      if (!crossedBarrier && sourceX !== previousX && sourceY !== previousY) {
        crossedBarrier =
          isBarrier(previousY * width + sourceX) || isBarrier(sourceY * width + previousX);
      }
      if (!crossedBarrier) biomeType[index] = source[candidateIndex];
    }
  }
}

/**
 * Chooses the global DEM resolution for an export. The export should not
 * analyze more samples than either the requested output can display or the
 * source heightmap actually contains, while an explicit analysis cap remains
 * available for callers that need a bounded export. The global DEM holds
 * roughly 110 bytes per cell, so the cell count is also capped: an 8K source
 * would otherwise push the export worker into multi-gigabyte memory pressure.
 * Tiles still sample elevation from the full-resolution source heightmap.
 */
/** Global export DEM cell budget (~2.6 GB of analysis fields). */
export const MAX_EXPORT_ANALYSIS_CELLS = 24_000_000;

export function getHeightmapExportAnalysisResolution(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
  requestedLongEdge?: number,
): HeightmapFitResolution {
  const sourceLongEdge = Math.max(1, Math.max(Math.round(sourceWidth), Math.round(sourceHeight)));
  const outputLongEdge = Math.max(1, Math.max(Math.round(outputWidth), Math.round(outputHeight)));
  const explicitLongEdge = Number.isFinite(requestedLongEdge)
    ? Math.max(1, Math.round(requestedLongEdge!))
    : outputLongEdge;
  const aspect =
    Math.max(1, Math.min(sourceWidth, sourceHeight)) / sourceLongEdge;
  const cellCapLongEdge = Math.floor(
    Math.sqrt(MAX_EXPORT_ANALYSIS_CELLS / aspect),
  );
  const analysisLongEdge = Math.min(
    sourceLongEdge,
    outputLongEdge,
    explicitLongEdge,
    cellCapLongEdge,
    MAX_MOUNTAIN_RENDER_RESOLUTION,
  );
  return getHeightmapFitResolution(
    sourceWidth,
    sourceHeight,
    analysisLongEdge,
    MAX_MOUNTAIN_RENDER_RESOLUTION,
  );
}

/**
 * Resamples a grayscale heightmap with bilinear interpolation. Sampling at
 * pixel centers keeps the outermost source pixels anchored at the edges,
 * which avoids a one-cell crop when the image is enlarged for 4K/8K/16K output.
 */
export function resampleHeightmapLuminance(
  source: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Float32Array {
  if (source.length !== sourceWidth * sourceHeight) {
    throw new Error("Heightmap data length does not match its dimensions");
  }
  if (
    !Number.isInteger(targetWidth) ||
    !Number.isInteger(targetHeight) ||
    targetWidth < 1 ||
    targetHeight < 1
  ) {
    throw new Error("Target heightmap dimensions must be positive integers");
  }

  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return source.slice();
  }

  const target = new Float32Array(targetWidth * targetHeight);
  const xScale =
    sourceWidth > 1 ? (sourceWidth - 1) / (targetWidth - 1 || 1) : 0;
  const yScale =
    sourceHeight > 1 ? (sourceHeight - 1) / (targetHeight - 1 || 1) : 0;

  for (let y = 0; y < targetHeight; y++) {
    const sourceY = y * yScale;
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const yWeight = sourceY - y0;
    const rowOffset = y * targetWidth;
    const sourceRow0 = y0 * sourceWidth;
    const sourceRow1 = y1 * sourceWidth;

    for (let x = 0; x < targetWidth; x++) {
      const sourceX = x * xScale;
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const xWeight = sourceX - x0;

      const top =
        source[sourceRow0 + x0] * (1 - xWeight) +
        source[sourceRow0 + x1] * xWeight;
      const bottom =
        source[sourceRow1 + x0] * (1 - xWeight) +
        source[sourceRow1 + x1] * xWeight;
      target[rowOffset + x] = top * (1 - yWeight) + bottom * yWeight;
    }
  }

  return target;
}

/** Resamples a binary source mask with nearest-neighbor selection. */
export function resampleHeightmapMask(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  if (source.length !== sourceWidth * sourceHeight) {
    throw new Error("Heightmap mask length does not match its dimensions");
  }
  if (
    !Number.isInteger(targetWidth) ||
    !Number.isInteger(targetHeight) ||
    targetWidth < 1 ||
    targetHeight < 1
  ) {
    throw new Error(
      "Target heightmap mask dimensions must be positive integers",
    );
  }
  if (sourceWidth === targetWidth && sourceHeight === targetHeight)
    return source.slice();

  const target = new Uint8Array(targetWidth * targetHeight);
  const xScale =
    sourceWidth > 1 ? (sourceWidth - 1) / (targetWidth - 1 || 1) : 0;
  const yScale =
    sourceHeight > 1 ? (sourceHeight - 1) / (targetHeight - 1 || 1) : 0;
  for (let y = 0; y < targetHeight; y++) {
    const sourceY = Math.min(sourceHeight - 1, Math.round(y * yScale));
    for (let x = 0; x < targetWidth; x++) {
      const sourceX = Math.min(sourceWidth - 1, Math.round(x * xScale));
      target[y * targetWidth + x] = source[sourceY * sourceWidth + sourceX];
    }
  }
  return target;
}

/**
 * Lowest source sample under each target cell, on the same corner-aligned
 * grid as `resampleHeightmapLuminance`; footprints cover every source sample.
 */
export function resampleHeightmapMinimum(
  source: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Float32Array {
  const xScale = sourceWidth > 1 ? (sourceWidth - 1) / (targetWidth - 1 || 1) : 0;
  const yScale = sourceHeight > 1 ? (sourceHeight - 1) / (targetHeight - 1 || 1) : 0;
  const span = (index: number, scale: number, size: number) => [
    Math.max(0, Math.round(index * scale - scale / 2)),
    Math.min(size - 1, Math.round(index * scale + scale / 2)),
  ];
  const target = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y++) {
    const [y0, y1] = span(y, yScale, sourceHeight);
    for (let x = 0; x < targetWidth; x++) {
      const [x0, x1] = span(x, xScale, sourceWidth);
      let lowest = Number.POSITIVE_INFINITY;
      for (let sy = y0; sy <= y1; sy++) {
        for (let sx = x0; sx <= x1; sx++) {
          lowest = Math.min(lowest, source[sy * sourceWidth + sx]);
        }
      }
      target[y * targetWidth + x] = lowest;
    }
  }
  return target;
}

/**
 * Resamples and denoises a heightmap for analysis. When it shrinks, valleys
 * narrower than the new cells are reopened against the lowest source sample,
 * so resampling cannot dam a river into a false lake.
 */
export function prepareAnalysisHeightmap(
  luminance: Float32Array,
  oceanMask: Uint8Array | undefined,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  smoothingPasses: number,
): { luminance: Float32Array; oceanMask?: Uint8Array } {
  const prepared = smoothHeightmapLuminance(
    resampleHeightmapLuminance(luminance, sourceWidth, sourceHeight, targetWidth, targetHeight),
    targetWidth,
    targetHeight,
    smoothingPasses,
  );
  const targetOcean = oceanMask
    ? resampleHeightmapMask(oceanMask, sourceWidth, sourceHeight, targetWidth, targetHeight)
    : undefined;
  if (targetWidth < sourceWidth || targetHeight < sourceHeight) {
    const floor = resampleHeightmapMinimum(luminance, sourceWidth, sourceHeight, targetWidth, targetHeight);
    // Ocean cells are the outlets (NaN) and keep their resampled bed.
    const bed = targetOcean ? prepared.slice() : undefined;
    targetOcean?.forEach((ocean, index) => { if (ocean === 1) prepared[index] = Number.NaN; });
    openDrainageToFloor(prepared, floor, targetWidth, targetHeight);
    targetOcean?.forEach((ocean, index) => { if (ocean === 1) prepared[index] = bed![index]; });
  }
  return { luminance: prepared, oceanMask: targetOcean };
}

/**
 * Applies an edge-preserving denoise pass to normalized height samples.
 * A cross-shaped neighborhood is used so narrow terrain features retain
 * their banks while small, isolated pixel-scale variations are averaged out.
 */
export function smoothHeightmapLuminance(
  source: Float32Array,
  width: number,
  height: number,
  passes: number,
): Float32Array {
  if (source.length !== width * height) {
    throw new Error("Heightmap data length does not match its dimensions");
  }
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error("Heightmap dimensions must be positive integers");
  }

  const passCount = Math.max(0, Math.min(4, Math.floor(passes)));
  if (passCount === 0) return source.slice();

  // Height differences above this scale are treated as likely terrain edges.
  // The rational falloff avoids expensive exponential calls for multi-megapixel
  // source images while still giving gentle noise a strong smoothing weight.
  const edgeSigma = 0.04;
  let current = source;

  for (let pass = 0; pass < passCount; pass++) {
    const smoothed = new Float32Array(source.length);

    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        const index = rowOffset + x;
        const center = current[index];
        let weightedSum = center * 2.0;
        let totalWeight = 2.0;

        if (x > 0) {
          const neighbor = current[index - 1];
          const difference = Math.abs(neighbor - center);
          const weight = 1 / (1 + (difference / edgeSigma) ** 2);
          weightedSum += neighbor * weight;
          totalWeight += weight;
        }
        if (x + 1 < width) {
          const neighbor = current[index + 1];
          const difference = Math.abs(neighbor - center);
          const weight = 1 / (1 + (difference / edgeSigma) ** 2);
          weightedSum += neighbor * weight;
          totalWeight += weight;
        }
        if (y > 0) {
          const neighbor = current[index - width];
          const difference = Math.abs(neighbor - center);
          const weight = 1 / (1 + (difference / edgeSigma) ** 2);
          weightedSum += neighbor * weight;
          totalWeight += weight;
        }
        if (y + 1 < height) {
          const neighbor = current[index + width];
          const difference = Math.abs(neighbor - center);
          const weight = 1 / (1 + (difference / edgeSigma) ** 2);
          weightedSum += neighbor * weight;
          totalWeight += weight;
        }

        smoothed[index] = weightedSum / totalWeight;
      }
    }

    current = smoothed;
  }

  return current;
}

interface TiffField {
  type: number;
  count: number;
  valueOffset: number;
}

interface TiffHeightmapHeader {
  littleEndian: boolean;
  width: number;
  height: number;
  bitsPerSample: number;
  photometricInterpretation: number;
  sampleFormat: number;
  rowsPerStrip: number;
  stripOffsets: number[];
  stripByteCounts: number[];
  noDataValue: number | null;
  /** Ground footprint of a GeoTIFF; absent for plain TIFF images. */
  groundExtent: { widthKm: number; heightKm: number } | null;
}

const TIFF_FIELD_TYPE_SIZES: readonly number[] = [
  0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8,
];
const TIFF_TAG_IMAGE_WIDTH = 256;
const TIFF_TAG_IMAGE_LENGTH = 257;
const TIFF_TAG_BITS_PER_SAMPLE = 258;
const TIFF_TAG_COMPRESSION = 259;
const TIFF_TAG_PHOTOMETRIC = 262;
const TIFF_TAG_STRIP_OFFSETS = 273;
const TIFF_TAG_ROWS_PER_STRIP = 278;
const TIFF_TAG_STRIP_BYTE_COUNTS = 279;
const TIFF_TAG_SAMPLES_PER_PIXEL = 277;
const TIFF_TAG_PLANAR_CONFIGURATION = 284;
const TIFF_TAG_SAMPLE_FORMAT = 339;
const TIFF_TAG_GDAL_NODATA = 42113;
const TIFF_TAG_MODEL_PIXEL_SCALE = 33550;
const TIFF_TAG_MODEL_TIEPOINT = 33922;
const TIFF_TAG_GEO_KEY_DIRECTORY = 34735;
const GEO_KEY_MODEL_TYPE = 1024;
const GEO_KEY_PROJECTED_CRS = 3072;
const GEO_KEY_PROJECTED_LINEAR_UNITS = 3076;
const WEB_MERCATOR_CRS_CODES = new Set([3857, 3785, 900913, 102100, 102113]);
const WGS84_RADIUS_M = 6378137;
const MIN_TIFF_ELEVATION_M = -10;

function isTiff(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d))
  );
}

function tiffTypeSize(type: number): number {
  return TIFF_FIELD_TYPE_SIZES[type] ?? 0;
}

function readTiffFieldValues(
  view: DataView,
  field: TiffField,
  littleEndian: boolean,
): number[] {
  const typeSize = tiffTypeSize(field.type);
  if (typeSize === 0 || field.count < 1)
    throw new Error("Unsupported TIFF field type");
  const byteLength = typeSize * field.count;
  if (
    !Number.isSafeInteger(byteLength) ||
    field.valueOffset + byteLength > view.byteLength
  ) {
    throw new Error("TIFF field points outside the file");
  }

  const values: number[] = [];
  for (let index = 0; index < field.count; index++) {
    const offset = field.valueOffset + index * typeSize;
    switch (field.type) {
      case 1:
      case 7:
        values.push(view.getUint8(offset));
        break;
      case 2:
        values.push(view.getUint8(offset));
        break;
      case 3:
        values.push(view.getUint16(offset, littleEndian));
        break;
      case 4:
        values.push(view.getUint32(offset, littleEndian));
        break;
      case 5: {
        const numerator = view.getUint32(offset, littleEndian);
        const denominator = view.getUint32(offset + 4, littleEndian);
        values.push(denominator === 0 ? Number.NaN : numerator / denominator);
        break;
      }
      case 6:
        values.push(view.getInt8(offset));
        break;
      case 8:
        values.push(view.getInt16(offset, littleEndian));
        break;
      case 9:
        values.push(view.getInt32(offset, littleEndian));
        break;
      case 10: {
        const numerator = view.getInt32(offset, littleEndian);
        const denominator = view.getInt32(offset + 4, littleEndian);
        values.push(denominator === 0 ? Number.NaN : numerator / denominator);
        break;
      }
      case 11:
        values.push(view.getFloat32(offset, littleEndian));
        break;
      case 12:
        values.push(view.getFloat64(offset, littleEndian));
        break;
      default:
        throw new Error(`Unsupported TIFF field type: ${field.type}`);
    }
  }
  return values;
}

function readTiffAscii(view: DataView, field: TiffField): string {
  if (field.type !== 2) return "";
  return readTiffFieldValues(view, field, true)
    .map((byte) => String.fromCharCode(byte))
    .join("")
    .replace(/\0+$/, "")
    .trim();
}

/**
 * Reads the ground footprint from GeoTIFF pixel scale, tiepoint and GeoKeys.
 * Geographic rasters are measured at their centre latitude, and Web Mercator
 * spans are shrunk by the Mercator scale at their centre, so both report
 * approximate ground kilometres. Unknown linear units are not guessed.
 */
function readTiffGroundExtent(
  view: DataView,
  fields: Map<number, TiffField>,
  littleEndian: boolean,
  width: number,
  height: number,
): { widthKm: number; heightKm: number } | null {
  const scaleField = fields.get(TIFF_TAG_MODEL_PIXEL_SCALE);
  const tiepointField = fields.get(TIFF_TAG_MODEL_TIEPOINT);
  const keyField = fields.get(TIFF_TAG_GEO_KEY_DIRECTORY);
  if (!scaleField || !tiepointField || !keyField) return null;
  const [scaleX, scaleY] = readTiffFieldValues(view, scaleField, littleEndian);
  const tiepoint = readTiffFieldValues(view, tiepointField, littleEndian);
  if (!(scaleX > 0) || !(scaleY > 0) || tiepoint.length < 6) return null;

  const directory = readTiffFieldValues(view, keyField, littleEndian);
  const geoKeys = new Map<number, number>();
  for (let entry = 4; entry + 3 < directory.length && entry < 4 + directory[3] * 4; entry += 4) {
    // Location 0 stores the SHORT value inline; the keys used here all do.
    if (directory[entry + 1] === 0) geoKeys.set(directory[entry], directory[entry + 3]);
  }

  const spanX = scaleX * width;
  const spanY = scaleY * height;
  const centerY = tiepoint[4] - tiepoint[1] * scaleY - spanY / 2;
  const modelType = geoKeys.get(GEO_KEY_MODEL_TYPE);
  if (modelType === 2) {
    if (Math.abs(centerY) > 90) return null;
    const metresPerDegree = (Math.PI * WGS84_RADIUS_M) / 180;
    return {
      widthKm: (spanX * metresPerDegree * Math.cos((centerY * Math.PI) / 180)) / 1000,
      heightKm: (spanY * metresPerDegree) / 1000,
    };
  }
  if (modelType !== 1) return null;

  const linearUnit = geoKeys.get(GEO_KEY_PROJECTED_LINEAR_UNITS) ?? 9001;
  const metresPerUnit =
    linearUnit === 9001 ? 1 : linearUnit === 9002 ? 0.3048 : linearUnit === 9003 ? 1200 / 3937 : null;
  if (metresPerUnit === null) return null;
  const crs = geoKeys.get(GEO_KEY_PROJECTED_CRS);
  const groundScale =
    crs !== undefined && WEB_MERCATOR_CRS_CODES.has(crs)
      ? 1 / Math.cosh((centerY * metresPerUnit) / WGS84_RADIUS_M)
      : 1;
  return {
    widthKm: (spanX * metresPerUnit * groundScale) / 1000,
    heightKm: (spanY * metresPerUnit * groundScale) / 1000,
  };
}

function readTiffHeader(buffer: ArrayBuffer): TiffHeightmapHeader | null {
  const bytes = new Uint8Array(buffer);
  if (!isTiff(bytes)) return null;

  const littleEndian = bytes[0] === 0x49;
  const view = new DataView(buffer);
  const readU16 = (offset: number) => view.getUint16(offset, littleEndian);
  const readU32 = (offset: number) => view.getUint32(offset, littleEndian);
  if (readU16(2) !== 42)
    throw new Error(
      "BigTIFF files are not supported; export a classic TIFF DEM",
    );

  const ifdOffset = readU32(4);
  if (ifdOffset + 2 > view.byteLength)
    throw new Error("TIFF image directory is outside the file");
  const fieldCount = readU16(ifdOffset);
  const directoryEnd = ifdOffset + 2 + fieldCount * 12;
  if (directoryEnd + 4 > view.byteLength)
    throw new Error("TIFF image directory is truncated");

  const fields = new Map<number, TiffField>();
  for (let index = 0; index < fieldCount; index++) {
    const entryOffset = ifdOffset + 2 + index * 12;
    const tag = readU16(entryOffset);
    const type = readU16(entryOffset + 2);
    const count = readU32(entryOffset + 4);
    const typeSize = tiffTypeSize(type);
    if (typeSize === 0 || count < 1)
      throw new Error(`TIFF tag ${tag} has an invalid type or count`);
    const byteLength = typeSize * count;
    if (!Number.isSafeInteger(byteLength))
      throw new Error(`TIFF tag ${tag} is too large`);
    const valueOffset =
      byteLength <= 4 ? entryOffset + 8 : readU32(entryOffset + 8);
    if (valueOffset + byteLength > view.byteLength)
      throw new Error(`TIFF tag ${tag} points outside the file`);
    fields.set(tag, { type, count, valueOffset });
  }

  const requiredNumber = (tag: number): number => {
    const field = fields.get(tag);
    if (!field) throw new Error(`TIFF is missing required tag ${tag}`);
    const value = readTiffFieldValues(view, field, littleEndian)[0];
    if (!Number.isFinite(value)) throw new Error(`TIFF tag ${tag} is invalid`);
    return value;
  };
  const optionalNumber = (tag: number, fallback: number): number => {
    const field = fields.get(tag);
    if (!field) return fallback;
    const value = readTiffFieldValues(view, field, littleEndian)[0];
    return Number.isFinite(value) ? value : fallback;
  };

  const width = requiredNumber(TIFF_TAG_IMAGE_WIDTH);
  const height = requiredNumber(TIFF_TAG_IMAGE_LENGTH);
  const bitsPerSample = requiredNumber(TIFF_TAG_BITS_PER_SAMPLE);
  const compression = optionalNumber(TIFF_TAG_COMPRESSION, 1);
  const photometricInterpretation = optionalNumber(TIFF_TAG_PHOTOMETRIC, 1);
  const samplesPerPixel = optionalNumber(TIFF_TAG_SAMPLES_PER_PIXEL, 1);
  const planarConfiguration = optionalNumber(TIFF_TAG_PLANAR_CONFIGURATION, 1);
  const sampleFormat = optionalNumber(TIFF_TAG_SAMPLE_FORMAT, 1);
  const rowsPerStrip = requiredNumber(TIFF_TAG_ROWS_PER_STRIP);
  const stripOffsetsField = fields.get(TIFF_TAG_STRIP_OFFSETS);
  const stripByteCountsField = fields.get(TIFF_TAG_STRIP_BYTE_COUNTS);
  if (!stripOffsetsField || !stripByteCountsField) {
    throw new Error(
      "TIFF tiled DEMs are not supported; export the raster as stripped TIFF",
    );
  }

  const stripOffsets = readTiffFieldValues(
    view,
    stripOffsetsField,
    littleEndian,
  );
  const stripByteCounts = readTiffFieldValues(
    view,
    stripByteCountsField,
    littleEndian,
  );
  if (stripOffsets.length !== stripByteCounts.length)
    throw new Error("TIFF strip metadata does not match");

  let noDataValue: number | null = null;
  const noDataField = fields.get(TIFF_TAG_GDAL_NODATA);
  if (noDataField) {
    const parsed = Number.parseFloat(readTiffAscii(view, noDataField));
    if (Number.isFinite(parsed)) noDataValue = parsed;
  }

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error("TIFF dimensions must be positive integers");
  }
  if (width * height > 100_000_000)
    throw new Error("TIFF heightmap is too large to process in the browser");
  if (![8, 16, 32, 64].includes(bitsPerSample))
    throw new Error(`Unsupported TIFF bit depth: ${bitsPerSample}`);
  if (compression !== 1)
    throw new Error(
      "Compressed TIFF DEMs are not supported; export an uncompressed TIFF",
    );
  if (photometricInterpretation !== 0 && photometricInterpretation !== 1) {
    throw new Error("Only grayscale TIFF DEMs are supported");
  }
  if (samplesPerPixel !== 1 || planarConfiguration !== 1) {
    throw new Error("Only single-band contiguous TIFF DEMs are supported");
  }
  if (![1, 2, 3].includes(sampleFormat))
    throw new Error(`Unsupported TIFF sample format: ${sampleFormat}`);
  if (
    sampleFormat !== 3 &&
    bitsPerSample !== 8 &&
    bitsPerSample !== 16 &&
    bitsPerSample !== 32
  ) {
    throw new Error(
      "Integer TIFF DEMs must use 8-bit, 16-bit, or 32-bit samples",
    );
  }
  if (sampleFormat === 3 && bitsPerSample !== 32 && bitsPerSample !== 64) {
    throw new Error(
      "Floating-point TIFF DEMs must use 32-bit or 64-bit samples",
    );
  }
  if (stripOffsets.length === 0 || rowsPerStrip < 1)
    throw new Error("TIFF has no usable raster strips");

  return {
    littleEndian,
    width,
    height,
    bitsPerSample,
    photometricInterpretation,
    sampleFormat,
    rowsPerStrip,
    stripOffsets,
    stripByteCounts,
    noDataValue,
    groundExtent: readTiffGroundExtent(view, fields, littleEndian, width, height),
  };
}

function readTiffSample(
  view: DataView,
  offset: number,
  bitsPerSample: number,
  sampleFormat: number,
  littleEndian: boolean,
): number {
  if (sampleFormat === 3) {
    return bitsPerSample === 32
      ? view.getFloat32(offset, littleEndian)
      : view.getFloat64(offset, littleEndian);
  }
  if (sampleFormat === 2) {
    if (bitsPerSample === 8) return view.getInt8(offset);
    if (bitsPerSample === 16) return view.getInt16(offset, littleEndian);
    return view.getInt32(offset, littleEndian);
  }
  if (bitsPerSample === 8) return view.getUint8(offset);
  if (bitsPerSample === 16) return view.getUint16(offset, littleEndian);
  return view.getUint32(offset, littleEndian);
}

function isTiffMissingSample(
  sample: number,
  noDataValue: number | null,
  sampleFormat: number,
): boolean {
  if (!Number.isFinite(sample)) return true;
  if (noDataValue !== null && sample === noDataValue) return true;
  if (sample <= MIN_TIFF_ELEVATION_M) return true;
  return sampleFormat !== 1 && sample === -9999;
}

/**
 * Real-world scale of a georeferenced heightmap. `rawLuminance` spans
 * `minElevationM`..`maxElevationM`, so using them as valley floor and summit
 * restores the source elevations.
 */
export interface HeightmapGeoMetadata {
  minElevationM: number;
  maxElevationM: number;
  widthKm: number;
  heightKm: number;
}

export interface HeightmapRaster {
  width: number;
  height: number;
  rawLuminance: Float32Array;
  oceanMask?: Uint8Array;
  /** Present only for georeferenced sources, never for plain images. */
  metadata?: HeightmapGeoMetadata;
}

/**
 * Normalizes a grid of elevations in metres (NaN = missing) with the same
 * rules as the GeoTIFF decoder: missing or deep cells become ocean at the
 * minimum elevation, and the range is recorded as metadata.
 */
export function heightmapFromElevations(
  elevations: Float32Array,
  width: number,
  height: number,
  extent: { widthKm: number; heightKm: number },
): HeightmapRaster {
  if (elevations.length !== width * height)
    throw new Error("Elevation grid size does not match its dimensions");
  const rawLuminance = new Float32Array(elevations.length);
  const oceanMask = new Uint8Array(elevations.length);
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < elevations.length; i++) {
    const sample = elevations[i];
    if (isTiffMissingSample(sample, null, 3)) {
      oceanMask[i] = 1;
      rawLuminance[i] = MIN_TIFF_ELEVATION_M;
    } else {
      rawLuminance[i] = sample;
    }
    minimum = Math.min(minimum, rawLuminance[i]);
    maximum = Math.max(maximum, rawLuminance[i]);
  }
  const range = maximum - minimum;
  for (let i = 0; i < rawLuminance.length; i++) {
    rawLuminance[i] = range <= 0 ? 0 : (rawLuminance[i] - minimum) / range;
  }
  return {
    width,
    height,
    rawLuminance,
    oceanMask,
    metadata: { minElevationM: minimum, maxElevationM: maximum, ...extent },
  };
}

/** Decodes an uncompressed, single-band classic TIFF/GeoTIFF DEM. */
export function decodeTiffHeightmap(
  buffer: ArrayBuffer,
): HeightmapRaster | null {
  const header = readTiffHeader(buffer);
  if (!header) return null;

  const view = new DataView(buffer);
  const bytesPerSample = header.bitsPerSample / 8;
  const totalCells = header.width * header.height;
  const rawLuminance = new Float32Array(totalCells);
  const oceanMask = new Uint8Array(totalCells);
  const noData = header.noDataValue;
  let outputRow = 0;

  const visitSamples = (
    visit: (index: number, sample: number) => void,
  ): void => {
    outputRow = 0;
    for (
      let strip = 0;
      strip < header.stripOffsets.length && outputRow < header.height;
      strip++
    ) {
      const stripOffset = header.stripOffsets[strip];
      const stripByteCount = header.stripByteCounts[strip];
      const rowsInStrip = Math.min(
        header.rowsPerStrip,
        header.height - outputRow,
      );
      const expectedBytes = rowsInStrip * header.width * bytesPerSample;
      if (
        stripByteCount < expectedBytes ||
        stripOffset + expectedBytes > view.byteLength
      ) {
        throw new Error("TIFF raster strip is truncated");
      }

      let byteOffset = stripOffset;
      for (let row = 0; row < rowsInStrip; row++) {
        const rowOffset = (outputRow + row) * header.width;
        for (let column = 0; column < header.width; column++) {
          const sample = readTiffSample(
            view,
            byteOffset,
            header.bitsPerSample,
            header.sampleFormat,
            header.littleEndian,
          );
          visit(rowOffset + column, sample);
          byteOffset += bytesPerSample;
        }
      }
      outputRow += rowsInStrip;
    }
    if (outputRow !== header.height)
      throw new Error("TIFF strips do not cover the complete image");
  };

  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  visitSamples((_index, sample) => {
    const isNoData = isTiffMissingSample(sample, noData, header.sampleFormat);
    if (isNoData || !Number.isFinite(sample)) {
      sample = MIN_TIFF_ELEVATION_M;
    }
    const clampedSample = Math.max(MIN_TIFF_ELEVATION_M, sample);
    minimum = Math.min(minimum, clampedSample);
    maximum = Math.max(maximum, clampedSample);
  });
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum))
    throw new Error("TIFF contains no finite elevation samples");

  const range = maximum - minimum;
  visitSamples((index, sample) => {
    const isNoData = isTiffMissingSample(sample, noData, header.sampleFormat);
    if (isNoData) oceanMask[index] = 1;
    const clampedSample =
      isNoData || !Number.isFinite(sample)
        ? MIN_TIFF_ELEVATION_M
        : Math.max(MIN_TIFF_ELEVATION_M, sample);
    const normalized = range <= 0 ? 0 : (clampedSample - minimum) / range;
    rawLuminance[index] =
      header.photometricInterpretation === 0
        ? Math.max(0, Math.min(1, 1 - normalized))
        : Math.max(0, Math.min(1, normalized));
  });

  // Only a GeoTIFF's samples are trusted as metres; a plain 16-bit image
  // TIFF would otherwise claim a 65 km summit.
  const metadata =
    header.groundExtent && header.photometricInterpretation === 1
      ? { minElevationM: minimum, maxElevationM: maximum, ...header.groundExtent }
      : undefined;
  return {
    width: header.width,
    height: header.height,
    rawLuminance,
    oceanMask,
    metadata,
  };
}

interface Png16BitHeightmapHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaceMethod: number;
  idatChunks: Uint8Array[];
}

function readPngUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  );
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function parsePng16BitHeightmapHeader(
  bytes: Uint8Array,
): Png16BitHeightmapHeader | null {
  if (!isPng(bytes)) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idatChunks: Uint8Array[] = [];

  while (offset + 12 <= bytes.length) {
    const chunkLength = readPngUint32(bytes, offset);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd + 4 > bytes.length)
      throw new Error("Invalid PNG chunk length");

    const chunkType = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );

    if (chunkType === "IHDR") {
      if (chunkLength !== 13) throw new Error("Invalid PNG header");
      width = readPngUint32(bytes, chunkStart);
      height = readPngUint32(bytes, chunkStart + 4);
      bitDepth = bytes[chunkStart + 8];
      colorType = bytes[chunkStart + 9];
      interlaceMethod = bytes[chunkStart + 12];
    } else if (chunkType === "IDAT") {
      idatChunks.push(bytes.slice(chunkStart, chunkEnd));
    } else if (chunkType === "IEND") {
      break;
    }

    offset = chunkEnd + 4;
  }

  if (width < 1 || height < 1 || idatChunks.length === 0)
    throw new Error("PNG is missing image data");
  if (bitDepth !== 16 || colorType !== 0) return null;
  if (interlaceMethod !== 0)
    throw new Error("Interlaced 16-bit heightmaps are not supported");

  return { width, height, bitDepth, colorType, interlaceMethod, idatChunks };
}

function concatByteArrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function paethPredictor(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpperLeft = Math.abs(estimate - upperLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpperLeft)
    return left;
  if (distanceUp <= distanceUpperLeft) return up;
  return upperLeft;
}

async function inflatePngData(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decode compressed 16-bit PNG data");
  }

  const compressedBlob = new Blob([
    new Uint8Array(compressed).buffer as ArrayBuffer,
  ]);
  const stream = compressedBlob
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decodes an un-interlaced, grayscale, 16-bit PNG without going through a
 * canvas. Canvas ImageData is only 8-bit, so using it for a 16-bit heightmap
 * would discard half of the source precision before terrain processing.
 */
async function decode16BitGrayscalePng(buffer: ArrayBuffer): Promise<{
  width: number;
  height: number;
  rawLuminance: Float32Array;
} | null> {
  const bytes = new Uint8Array(buffer);
  const header = parsePng16BitHeightmapHeader(bytes);
  if (!header) return null;

  const compressed = concatByteArrays(header.idatChunks);
  const inflated = await inflatePngData(compressed);
  const rowBytes = header.width * 2;
  const expectedBytes = header.height * (rowBytes + 1);
  if (inflated.length < expectedBytes)
    throw new Error("16-bit PNG pixel data is truncated");

  const rawLuminance = new Float32Array(header.width * header.height);
  let inflatedOffset = 0;
  let previousRow = new Uint8Array(rowBytes);
  let currentRow = new Uint8Array(rowBytes);

  for (let y = 0; y < header.height; y++) {
    const filterType = inflated[inflatedOffset++];
    for (let x = 0; x < rowBytes; x++) {
      const filtered = inflated[inflatedOffset++];
      const left = x >= 2 ? currentRow[x - 2] : 0;
      const up = previousRow[x];
      const upperLeft = x >= 2 ? previousRow[x - 2] : 0;

      let value: number;
      switch (filterType) {
        case 0:
          value = filtered;
          break;
        case 1:
          value = filtered + left;
          break;
        case 2:
          value = filtered + up;
          break;
        case 3:
          value = filtered + Math.floor((left + up) / 2);
          break;
        case 4:
          value = filtered + paethPredictor(left, up, upperLeft);
          break;
        default:
          throw new Error(`Unsupported PNG row filter: ${filterType}`);
      }
      currentRow[x] = value & 0xff;
    }

    const outputRowOffset = y * header.width;
    for (let x = 0; x < header.width; x++) {
      const sample = currentRow[x * 2] * 256 + currentRow[x * 2 + 1];
      rawLuminance[outputRowOffset + x] = sample / 65535;
    }

    const completedRow = previousRow;
    previousRow = currentRow;
    currentRow = completedRow;
  }

  return { width: header.width, height: header.height, rawLuminance };
}

/**
 * Loads an image from a URL or Asset path and extracts pixel luminance data into Float32Array.
 * Grayscale 16-bit PNGs are decoded from their source bytes to preserve the
 * additional height precision; other image formats use the browser canvas path.
 */
export async function loadHeightmapImage(
  imageSrc: string,
): Promise<HeightmapRaster> {
  if (/\.(?:png|tif|tiff)(?:[?#]|$)/i.test(imageSrc)) {
    try {
      const response = await fetch(imageSrc);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const tiff = decodeTiffHeightmap(buffer);
        if (tiff) return tiff;
        const png = await decode16BitGrayscalePng(buffer);
        if (png) return png;
      }
    } catch (error) {
      console.warn(
        "Falling back to browser image decoding for heightmap:",
        error,
      );
    }
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        reject(new Error("Failed to create canvas 2D context for heightmap"));
        return;
      }

      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, width, height);
      const pixels = imgData.data;
      const totalCells = width * height;
      const rawLuminance = new Float32Array(totalCells);

      for (let i = 0; i < totalCells; i++) {
        const r = pixels[i * 4 + 0];
        const g = pixels[i * 4 + 1];
        const b = pixels[i * 4 + 2];
        // Standard perceptual luminance formula
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        rawLuminance[i] = lum / 255.0;
      }

      resolve({ width, height, rawLuminance });
    };
    img.onerror = (err) => reject(err);
    img.src = imageSrc;
  });
}

/** Loads a user-selected PNG, TIFF, or GeoTIFF heightmap without a server upload. */
export async function loadHeightmapFile(file: Blob): Promise<HeightmapRaster> {
  const buffer = await file.arrayBuffer();
  const tiff = decodeTiffHeightmap(buffer);
  if (tiff) return tiff;

  const png = await decode16BitGrayscalePng(buffer);
  if (png) return png;

  const objectUrl = URL.createObjectURL(file);
  try {
    return await loadHeightmapImage(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function mountainEvolutionStepOptions(
  options: BaseDEMOptions,
  step: number,
): BaseDEMOptions {
  const growth = options.waterStageGrowthPerStep ?? 0;
  const baseStage = options.waterStageScale ?? 1;
  return {
    ...options,
    erosionStrength: 0,
    erosionIterations: 0,
    waterStageScale:
      growth > 0 ? Math.min(3, baseStage * (1 + step * growth)) : baseStage,
  };
}

/** Rebuilds the DEM of one evolution step from its retained state. */
export function rebuildMountainEvolutionStep(
  state: MountainEvolutionState,
  width: number,
  height: number,
  options: BaseDEMOptions,
  step: number,
  profiler?: MountainProfiler,
): MountainDEMData {
  const stepOptions = mountainEvolutionStepOptions(options, step);
  if (state.oceanFloorElevationM) {
    stepOptions.oceanFloorElevationM = state.oceanFloorElevationM;
  }
  const dem = processMountainBaseDEM(state.luminance, width, height, stepOptions, profiler);
  dem.erosionDepthM = state.erosionDepthM;
  return dem;
}

/**
 * Processes raw heightmap luminance into a complete scientific geomorphic DEM dataset.
 */
export function processMountainBaseDEM(
  rawLuminance: Float32Array,
  width: number,
  height: number,
  options: BaseDEMOptions = {},
  profiler?: MountainProfiler,
  onStage?: (stage: string) => void,
  onEvolutionStep?: (
    step: number,
    dem: MountainDEMData,
    state: MountainEvolutionState,
  ) => void,
): MountainDEMData {
  const erosionStrength = Math.max(
    0,
    Math.min(1, options.erosionStrength ?? 0),
  );
  const requestedErosionIterations = Math.max(
    0,
    Math.min(8, Math.floor(options.erosionIterations ?? 0)),
  );
  const erosionTimeScale = Math.max(
    0,
    Math.min(4, options.erosionTimeScale ?? 1),
  );
  const erosionIterations =
    requestedErosionIterations > 0 && erosionTimeScale > 0
      ? Math.max(
          1,
          Math.min(8, Math.ceil(requestedErosionIterations * erosionTimeScale)),
        )
      : 0;
  const erosionPassStrength =
    erosionIterations > 0
      ? (erosionStrength * (requestedErosionIterations * erosionTimeScale)) /
        erosionIterations
      : 0;
  const marineErosionScale = Math.max(
    0,
    Math.min(1, options.marineErosionStrength ?? 0.35),
  );

  // Erosion changes the DEM, so derive the complete hydrology again after
  // every pass. The recursive call is explicitly disabled to keep this
  // bounded and deterministic rather than allowing an accidental feedback
  // loop through the public processor.
  if (erosionStrength > 0 && erosionIterations > 0) {
    onStage?.("Applying erosion and rebuilding terrain");
    const erosionStop = profiler?.begin("DEM erosion and recursive rebuild");
    const evolvedLuminance = rawLuminance.slice();
    const initialRebuildStop = profiler?.begin("DEM recursive terrain rebuild");
    let evolvedDEM = processMountainBaseDEM(
      evolvedLuminance,
      width,
      height,
      mountainEvolutionStepOptions(options, 0),
      profiler,
    );
    initialRebuildStop?.();
    onEvolutionStep?.(0, evolvedDEM, {
      luminance: rawLuminance,
      erosionDepthM: evolvedDEM.erosionDepthM,
    });
    const cumulativeErosionM = new Float32Array(width * height);
    const evolvedOceanFloorElevationM = evolvedDEM.elevation.slice();
    const elevationRange = Math.max(
      1,
      evolvedDEM.maxElevationM - evolvedDEM.minElevationM,
    );

    for (let pass = 0; pass < erosionIterations; pass++) {
      const fluvialIncisionM = computeMountainFluvialIncision(
        evolvedDEM,
        erosionPassStrength,
        options.basePrecipitationMmYr ?? 1400,
        options.riverThresholdKm2 ?? DEFAULT_RIVER_THRESHOLD_KM2,
      );
      const marineIncisionM = computeMountainMarineIncision(
        evolvedDEM,
        erosionPassStrength * marineErosionScale,
      );
      let changed = false;

      for (let i = 0; i < fluvialIncisionM.length; i++) {
        // River and marine processes act on the same evolving bed. They are
        // independent sources of energy, so their bounded contributions can
        // combine at a river mouth or exposed coastal channel bank.
        const incision = fluvialIncisionM[i] + marineIncisionM[i];
        if (incision <= 0) continue;
        changed = true;
        cumulativeErosionM[i] += incision;
        if (evolvedDEM.isOcean[i] === 1) {
          // Keep the sea surface classification, but retain the carved
          // submerged river bed for the next hydrology rebuild and export.
          evolvedOceanFloorElevationM[i] = Math.min(
            evolvedOceanFloorElevationM[i],
            evolvedDEM.elevation[i] - incision,
          );
          continue;
        }
        const nextElevation = Math.max(
          evolvedDEM.minElevationM,
          evolvedDEM.elevation[i] - incision,
        );
        evolvedLuminance[i] = Math.max(
          0,
          Math.min(
            1,
            (nextElevation - evolvedDEM.minElevationM) / elevationRange,
          ),
        );
      }

      if (!changed) break;
      const rebuildStop = profiler?.begin("DEM recursive terrain rebuild");
      // Each step builds on the previous one, and the bank-full stage grows
      // as the channel matures, so the chain yields every intermediate step.
      evolvedDEM = processMountainBaseDEM(evolvedLuminance, width, height, {
        ...mountainEvolutionStepOptions(options, pass + 1),
        oceanFloorElevationM: evolvedOceanFloorElevationM,
      }, profiler);
      rebuildStop?.();
      if (onEvolutionStep) {
        const erosionDepthM = cumulativeErosionM.slice();
        evolvedDEM.erosionDepthM = erosionDepthM;
        onEvolutionStep(pass + 1, evolvedDEM, {
          luminance: evolvedLuminance.slice(),
          oceanFloorElevationM: evolvedOceanFloorElevationM.slice(),
          erosionDepthM,
        });
      }
    }

    evolvedDEM.erosionDepthM = cumulativeErosionM;
    erosionStop?.();
    return evolvedDEM;
  }

  const domainWidthKm = options.domainWidthKm ?? 45.0;
  const domainHeightKm = options.domainHeightKm ?? 45.0 * (height / width);
  const minElevM = options.minElevationM ?? 80.0;
  const maxElevM = options.maxElevationM ?? 3850.0;
  // Inspector values may be typed beyond their slider range; only physically
  // meaningless values are rejected below.
  const oceanElevationM = options.oceanElevationM ?? -10.0;

  const sunAzimuth = options.sunAzimuthDeg ?? 315.0;
  const sunAltitude = options.sunAltitudeDeg ?? 45.0;
  const vertExagg = options.verticalExaggeration ?? 3.5;
  const windAzimuth = options.windAzimuthDeg ?? 225.0;
  const windSpeed = options.windSpeedMs ?? 15.0;
  const basePrecip = options.basePrecipitationMmYr ?? 1400.0;
  const baseTempC = options.baseTemperatureC ?? 18.0;
  const riverThresholdKm2 = options.riverThresholdKm2 ?? DEFAULT_RIVER_THRESHOLD_KM2;
  const wetlandElevationThresholdM = Math.max(0.0, options.wetlandElevationThresholdM ?? 400.0);
  const biomeRegionScaleKm = Math.max(0.0, options.biomeRegionScaleKm ?? 1.0);

  const totalCells = width * height;
  if (options.oceanMask && options.oceanMask.length !== totalCells) {
    throw new Error("Ocean mask length does not match heightmap dimensions");
  }
  if (
    options.oceanFloorElevationM &&
    options.oceanFloorElevationM.length !== totalCells
  ) {
    throw new Error("Ocean floor elevation length does not match heightmap dimensions");
  }
  const isOcean = options.oceanMask
    ? options.oceanMask.slice()
    : new Uint8Array(totalCells);
  const dxMeters = (domainWidthKm * 1000.0) / width;
  const dyMeters = (domainHeightKm * 1000.0) / height;

  const elevation = new Float32Array(totalCells);
  const normalizedElevation = new Float32Array(totalCells);
  const slopeDeg = new Float32Array(totalCells);
  const aspectDeg = new Float32Array(totalCells);
  const normals = new Float32Array(totalCells * 3);
  const hillshade = new Float32Array(totalCells);
  const ambientOcclusion = new Float32Array(totalCells);
  const curvature = new Float32Array(totalCells);
  const tpi = new Float32Array(totalCells);
  const precipitationMmYr = new Float32Array(totalCells);
  const runoffDepthMmYr = new Float32Array(totalCells);
  const solarInsolation = new Float32Array(totalCells);
  const temperatureC = new Float32Array(totalCells);
  const biomeType = new Uint8Array(totalCells);

  // 1. Compute Physical Elevation (Meters)
  onStage?.("Calculating terrain elevation");
  const physicalElevationStop = profiler?.begin("DEM physical elevation");
  const elevRange = maxElevM - minElevM;
  for (let i = 0; i < totalCells; i++) {
    const norm = Math.max(0.0, Math.min(1.0, rawLuminance[i]));
    if (isOcean[i] === 1) {
      const configuredOceanFloor = options.oceanFloorElevationM?.[i];
      // Ocean cells retain their source/submerged-bed value. The ocean
      // surface is a separate routing datum and must not flatten the DEM.
      elevation[i] =
        configuredOceanFloor !== undefined &&
        Number.isFinite(configuredOceanFloor)
          ? configuredOceanFloor
          : minElevM + norm * elevRange;
      normalizedElevation[i] = norm;
    } else {
      normalizedElevation[i] = norm;
      elevation[i] = minElevM + norm * elevRange;
    }
    if (elevation[i] <= oceanElevationM) isOcean[i] = 1;
  }
  physicalElevationStop?.();

  // Filter tiny micro-puddles / speckles and smooth jagged ocean edges
  onStage?.("Filtering ocean and coastline mask");
  const oceanMaskStop = profiler?.begin("DEM ocean mask filtering");
  const filteredOcean = filterSmallOceanComponents(isOcean, width, height, 16);
  const smoothedOcean = smoothOceanMask(filteredOcean, width, height, 2);
  for (let i = 0; i < totalCells; i++) isOcean[i] = smoothedOcean[i];

  // Keep the stored DEM substrate separate from the sea surface used by
  // routing. Ocean cells are masked water, even when their source sample is
  // missing or lies above the chosen water datum.
  const analysisElevation = elevation.slice();
  for (let i = 0; i < totalCells; i++) {
    if (isOcean[i] === 1) analysisElevation[i] = oceanElevationM;
  }
  oceanMaskStop?.();

  // 2. Compute Slopes, Aspects, 3D Normals, Curvature & TPI
  const sunRad1 = (sunAzimuth * Math.PI) / 180.0;
  const altRad1 = (sunAltitude * Math.PI) / 180.0;
  const sun1 = [
    Math.sin(sunRad1) * Math.cos(altRad1),
    -Math.cos(sunRad1) * Math.cos(altRad1),
    Math.sin(altRad1),
  ];

  const sunRad2 = ((sunAzimuth + 90.0) * Math.PI) / 180.0;
  const altRad2 = (Math.max(10.0, sunAltitude - 15.0) * Math.PI) / 180.0;
  const sun2 = [
    Math.sin(sunRad2) * Math.cos(altRad2),
    -Math.cos(sunRad2) * Math.cos(altRad2),
    Math.sin(altRad2),
  ];

  const xPrevIndices = new Int32Array(width);
  const xNextIndices = new Int32Array(width);
  const yPrevIndices = new Int32Array(height);
  const yNextIndices = new Int32Array(height);
  for (let x = 0; x < width; x++) {
    xPrevIndices[x] = Math.max(0, x - 1);
    xNextIndices[x] = Math.min(width - 1, x + 1);
  }
  for (let y = 0; y < height; y++) {
    yPrevIndices[y] = Math.max(0, y - 1);
    yNextIndices[y] = Math.min(height - 1, y + 1);
  }

  const lightingStop = profiler?.begin("lighting updates");
  onStage?.("Calculating slopes and terrain lighting");
  for (let y = 0; y < height; y++) {
    const yPrev = yPrevIndices[y];
    const yNext = yNextIndices[y];

    for (let x = 0; x < width; x++) {
      const xPrev = xPrevIndices[x];
      const xNext = xNextIndices[x];

      const idx = y * width + x;
      const zC = analysisElevation[idx];

      const zNW = analysisElevation[yPrev * width + xPrev];
      const zN = analysisElevation[yPrev * width + x];
      const zNE = analysisElevation[yPrev * width + xNext];
      const zW = analysisElevation[y * width + xPrev];
      const zE = analysisElevation[y * width + xNext];
      const zSW = analysisElevation[yNext * width + xPrev];
      const zS = analysisElevation[yNext * width + x];
      const zSE = analysisElevation[yNext * width + xNext];

      // Horn's 3x3 weighted gradient
      const dzdx =
        (zNE + 2.0 * zE + zSE - (zNW + 2.0 * zW + zSW)) / (8.0 * dxMeters);
      const dzdy =
        (zSW + 2.0 * zS + zSE - (zNW + 2.0 * zN + zNE)) / (8.0 * dyMeters);

      const dzdxEx = dzdx * vertExagg;
      const dzdyEx = dzdy * vertExagg;
      const lenEx = Math.sqrt(dzdxEx * dzdxEx + dzdyEx * dzdyEx + 1.0);

      const nx = -dzdxEx / lenEx;
      const ny = -dzdyEx / lenEx;
      const nz = 1.0 / lenEx;

      normals[idx * 3 + 0] = nx;
      normals[idx * 3 + 1] = ny;
      normals[idx * 3 + 2] = nz;

      const gradMag = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
      const slopeAngle = (Math.atan(gradMag) * 180.0) / Math.PI;
      slopeDeg[idx] = slopeAngle;

      let aspect = (Math.atan2(dzdx, -dzdy) * 180.0) / Math.PI;
      if (aspect < 0) aspect += 360.0;
      aspectDeg[idx] = aspect;

      // Multidirectional Swiss Hillshade
      const dot1 = Math.max(0.0, nx * sun1[0] + ny * sun1[1] + nz * sun1[2]);
      const dot2 = Math.max(0.0, nx * sun2[0] + ny * sun2[1] + nz * sun2[2]);
      const shade = 0.22 + 0.65 * Math.pow(dot1, 0.95) + 0.13 * dot2;
      hillshade[idx] = Math.max(0.0, Math.min(1.0, shade));

      // Ambient Occlusion / Valley Infill
      const avgSurround = (zNW + zN + zNE + zW + zE + zSW + zS + zSE) / 8.0;
      const elevDiff = zC - avgSurround;
      const aoFactor = 1.0 / (1.0 + Math.exp(-elevDiff / 40.0));
      ambientOcclusion[idx] = Math.max(
        0.1,
        Math.min(1.0, 0.4 + 0.6 * aoFactor),
      );

      // Curvature & TPI
      curvature[idx] = (zN + zS + zW + zE - 4.0 * zC) / (dxMeters * dxMeters);
      tpi[idx] = elevDiff;
    }
  }
  lightingStop?.();

  // 3. Orographic precipitation and local runoff. Climate must be solved
  // before drainage accumulation: otherwise every cell contributes the same
  // amount of water and the wind/rain controls can only recolor the map.
  // Smith & Barstad (2004) linear orographic precipitation. Rain varies over
  // the cloud drift distance (wind × ~1000 s, kilometres), so the model runs
  // on a coarse grid and is resampled to the DEM. The base precipitation is
  // the background annual total on flat ground; relief scales it by the
  // ratio of the orographic event rate to the background event rate.
  const orographicLongEdge = Math.min(512, Math.max(width, height));
  const orographicScale = orographicLongEdge / Math.max(width, height);
  const orographicWidth = Math.max(1, Math.round(width * orographicScale));
  const orographicHeight = Math.max(1, Math.round(height * orographicScale));
  const surfaceElevation = new Float32Array(totalCells);
  for (let index = 0; index < totalCells; index++) {
    // Sea level is the reference surface; water bodies count as flat water.
    surfaceElevation[index] = isOcean[index] === 1
      ? Math.max(0, oceanElevationM)
      : Math.max(0, analysisElevation[index]);
  }
  const coarseRate = computeOrographicPrecipitationRate(
    resampleHeightmapLuminance(surfaceElevation, width, height, orographicWidth, orographicHeight),
    orographicWidth,
    orographicHeight,
    (dxMeters * width) / orographicWidth,
    (dyMeters * height) / orographicHeight,
    { windSpeedMs: windSpeed, windFromDeg: windAzimuth },
  );
  const orographicRatio = resampleHeightmapLuminance(
    coarseRate.map((rate) => rate / OROGRAPHIC_DEFAULTS.backgroundRateMmH),
    orographicWidth,
    orographicHeight,
    width,
    height,
  );

  const climateStop = profiler?.begin("DEM climate and runoff");
  onStage?.("Calculating climate and runoff");
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const z = analysisElevation[idx];
      const slope = slopeDeg[idx];
      const aspect = aspectDeg[idx];
      const slopeFactor = Math.sin((slope * Math.PI) / 180.0);
      const precipitation =
        basePrecip * Math.max(MIN_OROGRAPHIC_RAIN_RATIO, orographicRatio[idx]);
      precipitationMmYr[idx] = precipitation;

      const sunFacing = Math.cos(((aspect - 180.0) * Math.PI) / 180.0);
      solarInsolation[idx] = Math.max(
        0.1,
        0.65 + 0.35 * sunFacing * slopeFactor,
      );
      const temperature = baseTempC - (z / 1000.0) * 6.5;
      temperatureC[idx] = temperature;

      // Represent annual interception, infiltration, and evapotranspiration
      // as a climatic loss. This deliberately makes arid rain-shadow cells
      // weak or zero river sources instead of equal contributors.
      const climaticLossMm = 260 + Math.max(0, temperature) * 7.0;
      runoffDepthMmYr[idx] =
        isOcean[idx] === 1
          ? 0
          : Math.max(0, precipitation - climaticLossMm) * 0.72;
    }
  }
  climateStop?.();

  // 4. Robust Hydrological Flow Routing
  const hydrologyStop = profiler?.begin("DEM hydrology and river routing");
  onStage?.("Routing water and rivers");
  // Condition closed depressions to the image edge before routing. A raw
  // heightmap contains small one-pixel pits and broad flat fans; sending a
  // pit to its highest neighbour makes the flow graph point uphill and then
  // silently loses its accumulation because the graph is no longer a DAG.
  // Priority-flood gives those cells an outlet while retaining the original
  // DEM for all rendering and terrain metrics.
  const d8Offsets = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];
  const d8Distances = d8Offsets.map(([dx, dy]) =>
    Math.sqrt(
      dx * dxMeters * (dx * dxMeters) + dy * dyMeters * (dy * dyMeters),
    ),
  );

  const conditionedElevation = analysisElevation.slice();
  const flatReceiver = new Int8Array(totalCells).fill(-1);
  const floodVisited = new Uint8Array(totalCells);
  const floodHeapIndices = new Int32Array(totalCells);
  const floodHeapKeys = new Float32Array(totalCells);
  let floodHeapSize = 0;

  function pushFloodCell(idx: number, key: number): void {
    let pos = floodHeapSize++;
    floodHeapIndices[pos] = idx;
    floodHeapKeys[pos] = key;

    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (
        floodHeapKeys[parent] < key ||
        (floodHeapKeys[parent] === key && floodHeapIndices[parent] <= idx)
      )
        break;
      floodHeapIndices[pos] = floodHeapIndices[parent];
      floodHeapKeys[pos] = floodHeapKeys[parent];
      pos = parent;
    }
    floodHeapIndices[pos] = idx;
    floodHeapKeys[pos] = key;
  }

  function popFloodCell(): { idx: number; key: number } {
    const idx = floodHeapIndices[0];
    const key = floodHeapKeys[0];
    floodHeapSize--;

    if (floodHeapSize > 0) {
      const lastIdx = floodHeapIndices[floodHeapSize];
      const lastKey = floodHeapKeys[floodHeapSize];
      let pos = 0;
      while (true) {
        const left = pos * 2 + 1;
        if (left >= floodHeapSize) break;
        const right = left + 1;
        let child = left;
        if (
          right < floodHeapSize &&
          (floodHeapKeys[right] < floodHeapKeys[left] ||
            (floodHeapKeys[right] === floodHeapKeys[left] &&
              floodHeapIndices[right] < floodHeapIndices[left]))
        ) {
          child = right;
        }
        if (
          floodHeapKeys[child] > lastKey ||
          (floodHeapKeys[child] === lastKey &&
            floodHeapIndices[child] >= lastIdx)
        )
          break;
        floodHeapIndices[pos] = floodHeapIndices[child];
        floodHeapKeys[pos] = floodHeapKeys[child];
        pos = child;
      }
      floodHeapIndices[pos] = lastIdx;
      floodHeapKeys[pos] = lastKey;
    }

    return { idx, key };
  }

  function seedFloodCell(idx: number): void {
    if (floodVisited[idx] === 1) return;
    floodVisited[idx] = 1;
    pushFloodCell(idx, conditionedElevation[idx]);
  }

  for (let x = 0; x < width; x++) {
    seedFloodCell(x);
    seedFloodCell((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    seedFloodCell(y * width);
    seedFloodCell(y * width + width - 1);
  }

  while (floodHeapSize > 0) {
    const { idx: currentIdx } = popFloodCell();
    const cx = currentIdx % width;
    const cy = Math.floor(currentIdx / width);

    for (let d = 0; d < 8; d++) {
      const nx = cx + d8Offsets[d][0];
      const ny = cy + d8Offsets[d][1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

      const neighborIdx = ny * width + nx;
      if (floodVisited[neighborIdx] === 1) continue;
      floodVisited[neighborIdx] = 1;

      const filled = Math.max(
        elevation[neighborIdx],
        conditionedElevation[currentIdx],
      );
      conditionedElevation[neighborIdx] = filled;
      // The parent is a valid receiver for a flat filled depression. The
      // parent relation is a tree because each cell is visited once.
      flatReceiver[neighborIdx] = (d + 4) % 8;
      pushFloodCell(neighborIdx, filled);
    }
  }

  const flowDirection = new Int8Array(totalCells).fill(-1);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const zC = conditionedElevation[idx];

      let maxSlope = -Infinity;
      let bestDir = -1;
      for (let d = 0; d < 8; d++) {
        const nx = x + d8Offsets[d][0];
        const ny = y + d8Offsets[d][1];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

        const nIdx = ny * width + nx;
        const zN = conditionedElevation[nIdx];
        const drop = zC - zN;
        if (drop > 0.0001) {
          const slope = drop / (d8Distances[d] * dxMeters);
          if (slope > maxSlope) {
            maxSlope = slope;
            bestDir = d;
          }
        }
      }

      if (bestDir >= 0) {
        flowDirection[idx] = bestDir;
      } else if (flatReceiver[idx] >= 0) {
        // Filled flats follow the priority-flood tree to their spill outlet.
        flowDirection[idx] = flatReceiver[idx];
      }
    }
  }

  // Build an explicit upstream-to-downstream order. Sorting by raw elevation
  // is not sufficient after depression conditioning because many valid flat
  // receivers share the same elevation.
  const incomingEdges = new Uint16Array(totalCells);
  for (let idx = 0; idx < totalCells; idx++) {
    const dir1 = flowDirection[idx];
    if (dir1 < 0) continue;

    const x = idx % width;
    const y = Math.floor(idx / width);
    const targetX1 = x + d8Offsets[dir1][0];
    const targetY1 = y + d8Offsets[dir1][1];
    if (
      targetX1 >= 0 &&
      targetX1 < width &&
      targetY1 >= 0 &&
      targetY1 < height
    ) {
      incomingEdges[targetY1 * width + targetX1]++;
    }
  }

  const pendingEdges = incomingEdges.slice();
  const routingQueue = new Int32Array(totalCells);
  let queueRead = 0;
  let queueWrite = 0;
  for (let i = 0; i < totalCells; i++) {
    if (pendingEdges[i] === 0) routingQueue[queueWrite++] = i;
  }

  // Route the complete upstream catchment through one continuous D8 receiver.
  // Splitting lowland flow made accumulation shrink along the primary route,
  // which could turn a visible river off and leave detached blue fragments.
  const cellAreaKm2 = (dxMeters * dyMeters) / 1_000_000.0;
  const cellAreaM2 = dxMeters * dyMeters;
  const referenceRunoffMmYr = (1400 - 350) * 0.72;
  const flowAccumulation = new Float32Array(totalCells).fill(1.0);
  const rainfallWeightedAreaKm2 = new Float32Array(totalCells);
  const dischargeM3s = new Float32Array(totalCells);
  const secondsPerYear = 365.25 * 24 * 60 * 60;
  for (let i = 0; i < totalCells; i++) {
    rainfallWeightedAreaKm2[i] =
      (cellAreaKm2 * runoffDepthMmYr[i]) / referenceRunoffMmYr;
    dischargeM3s[i] =
      ((runoffDepthMmYr[i] / 1000) * cellAreaM2) / secondsPerYear;
  }
  const topologicalOrder = new Int32Array(totalCells);
  let topologicalCount = 0;
  while (queueRead < queueWrite) {
    const idx = routingQueue[queueRead++];
    topologicalOrder[topologicalCount++] = idx;
    const accum = flowAccumulation[idx];
    const dir1 = flowDirection[idx];

    if (dir1 >= 0) {
      const x = idx % width;
      const y = Math.floor(idx / width);
      const nx1 = x + d8Offsets[dir1][0];
      const ny1 = y + d8Offsets[dir1][1];
      if (nx1 >= 0 && nx1 < width && ny1 >= 0 && ny1 < height) {
        const targetIdx1 = ny1 * width + nx1;
        flowAccumulation[targetIdx1] += accum;
        rainfallWeightedAreaKm2[targetIdx1] += rainfallWeightedAreaKm2[idx];
        dischargeM3s[targetIdx1] += dischargeM3s[idx];
        pendingEdges[targetIdx1]--;
        if (pendingEdges[targetIdx1] === 0)
          routingQueue[queueWrite++] = targetIdx1;
      }
    }
  }

  // This should be a DAG after priority-flood conditioning. Keep a safe
  // deterministic fallback for malformed/degenerate one-cell inputs without
  // ever routing the remaining cells uphill.
  if (topologicalCount < totalCells) {
    for (let i = 0; i < totalCells; i++) {
      if (pendingEdges[i] > 0) topologicalOrder[topologicalCount++] = i;
    }
  }

  const drainageAreaKm2 = new Float32Array(totalCells);
  for (let i = 0; i < totalCells; i++) {
    drainageAreaKm2[i] = flowAccumulation[i] * cellAreaKm2;
  }

  const waterStageScale = Math.max(MIN_POSITIVE_SCALE, options.waterStageScale ?? 1.0);
  const flowRateScale = Math.max(MIN_POSITIVE_SCALE, options.flowRateScale ?? 0.55);
  // This is a static water-stage approximation: slower flow retains more water
  // over each raster cell, raising the stage and allowing the bounded channel
  // corridor to wet its banks instead of leaving only a fast thalweg line.
  const residenceStageScale = 1 / Math.sqrt(flowRateScale);
  const effectiveWaterStageScale = waterStageScale * residenceStageScale;

  // Calculate true Strahler order from routed upstream branches. This is kept
  // separate from the area-based display sizing below: a long single channel
  // can remain order 1 while still needing a visibly wider water stage.
  const isRiverChannel = new Uint8Array(totalCells);
  const strahlerOrder = new Uint8Array(totalCells);
  const waterDepthM = new Float32Array(totalCells);
  const maxUpstreamOrder = new Uint8Array(totalCells);
  const matchingUpstreamCount = new Uint8Array(totalCells);

  for (let orderIndex = 0; orderIndex < topologicalCount; orderIndex++) {
    const idx = topologicalOrder[orderIndex];
    // Stream order belongs to the active, rain-fed network. Dry headwater
    // twigs must not raise the order of a downstream river merely because
    // their geometric receiver happens to join it.
    const isActiveStream =
      isOcean[idx] === 0 && rainfallWeightedAreaKm2[idx] >= riverThresholdKm2;
    const upstreamMax = maxUpstreamOrder[idx];
    const order = !isActiveStream
      ? 0
      : upstreamMax === 0
        ? 1
        : matchingUpstreamCount[idx] >= 2
          ? Math.min(255, upstreamMax + 1)
          : upstreamMax;
    strahlerOrder[idx] = order;

    const dir1 = flowDirection[idx];
    if (dir1 < 0 || order === 0) continue;
    const x = idx % width;
    const y = Math.floor(idx / width);
    const targetX = x + d8Offsets[dir1][0];
    const targetY = y + d8Offsets[dir1][1];
    if (targetX < 0 || targetX >= width || targetY < 0 || targetY >= height)
      continue;
    const targetIdx = targetY * width + targetX;
    if (order > maxUpstreamOrder[targetIdx]) {
      maxUpstreamOrder[targetIdx] = order;
      matchingUpstreamCount[targetIdx] = 1;
    } else if (
      order === maxUpstreamOrder[targetIdx] &&
      matchingUpstreamCount[targetIdx] < 255
    ) {
      matchingUpstreamCount[targetIdx]++;
    }
  }

  const centerlineMask = new Uint8Array(totalCells);
  const distanceToCenterline = new Uint8Array(totalCells).fill(255);
  const inheritedChannelRadius = new Uint8Array(totalCells);
  const inheritedChannelOrder = new Uint8Array(totalCells);
  const inheritedWaterSurfaceM = new Float32Array(totalCells);
  const riverMouthMask = new Uint8Array(totalCells);
  const riverMouthAreaKm2 = new Float32Array(totalCells);
  // A coarse analysis pixel spans many real meters. This small resolution
  // allowance prevents a perfectly valid bank-full surface from vanishing
  // merely because the neighboring DEM sample sits several meters higher.
  const rasterStageAllowanceM = Math.min(
    12,
    Math.max(2, Math.min(dxMeters, dyMeters) * 0.035),
  );
  const stageWidthScale = Math.sqrt(effectiveWaterStageScale);
  // Radius 0 keeps only the thalweg once a cell is wider than the channel.
  const channelRadiusCellScale = waterWidthCellScale(Math.min(dxMeters, dyMeters));

  for (let i = 0; i < totalCells; i++) {
    const area = rainfallWeightedAreaKm2[i];
    // Every centerline is backed by accumulated routed flow. The former
    // elevation/TPI-only braided-bed shortcut painted whole lowland basins as
    // water, even when no upstream cell reached them.
    if (isOcean[i] === 0 && area >= riverThresholdKm2) {
      let displayOrder = Math.max(1, Math.min(6, strahlerOrder[i]));
      let depth = 0.4 * effectiveWaterStageScale;
      let radius = Math.min(3, Math.max(1, Math.round(0.5 * stageWidthScale)));

      if (area >= 40.0) {
        displayOrder = Math.max(displayOrder, 6); // Grand trunk / delta channels
        depth = 4.2 * effectiveWaterStageScale;
        radius = Math.min(9, Math.max(2, Math.round(3.5 * stageWidthScale)));
      } else if (area >= 15.0) {
        displayOrder = Math.max(displayOrder, 5); // Main river stem
        depth = 3.0 * effectiveWaterStageScale;
        radius = Math.min(6, Math.max(2, Math.round(2.4 * stageWidthScale)));
      } else if (area >= 6.0) {
        displayOrder = Math.max(displayOrder, 4); // Canyon gorge river
        depth = 2.0 * effectiveWaterStageScale;
        radius = Math.min(4, Math.max(1, Math.round(1.5 * stageWidthScale)));
      } else if (area >= 2.0) {
        displayOrder = Math.max(displayOrder, 3); // Mountain stream
        depth = 1.2 * effectiveWaterStageScale;
        radius = Math.min(3, Math.max(1, Math.round(0.8 * stageWidthScale)));
      } else if (area >= 0.6) {
        displayOrder = Math.max(displayOrder, 2); // Brook
        depth = 0.7 * effectiveWaterStageScale;
        radius = Math.min(2, Math.max(1, Math.round(0.65 * stageWidthScale)));
      }

      const waterSurfaceM = elevation[i] + depth + rasterStageAllowanceM;
      centerlineMask[i] = 1;
      distanceToCenterline[i] = 0;
      inheritedChannelRadius[i] = Math.round(radius * channelRadiusCellScale);
      inheritedChannelOrder[i] = displayOrder;
      inheritedWaterSurfaceM[i] = waterSurfaceM;
      isRiverChannel[i] = 1;
      waterDepthM[i] = Math.max(waterDepthM[i], waterSurfaceM - elevation[i]);
      strahlerOrder[i] = Math.max(strahlerOrder[i], displayOrder);
    }
  }

  // Flood laterally from every routed centerline through adjacent low bank
  // cells. The former reverse-receiver fill followed tiny uphill drainage
  // twigs and rendered them as star-shaped blue splatches beside the river.
  // This queue measures connected distance across the channel bed instead, so
  // stage widens the river as one ribbon without inventing extra flow paths.
  const bankFillQueue = new Int32Array(totalCells);
  let bankQueueRead = 0;
  let bankQueueWrite = 0;
  for (let i = 0; i < totalCells; i++) {
    if (centerlineMask[i] === 1) bankFillQueue[bankQueueWrite++] = i;
  }

  while (bankQueueRead < bankQueueWrite) {
    const idx = bankFillQueue[bankQueueRead++];
    const currentDistance = distanceToCenterline[idx];
    const radius = inheritedChannelRadius[idx];
    if (currentDistance >= radius) continue;

    const x = idx % width;
    const y = Math.floor(idx / width);
    const waterSurfaceM = inheritedWaterSurfaceM[idx];
    const channelOrder = inheritedChannelOrder[idx];
    const nextDistance = currentDistance + 1;

    for (let direction = 0; direction < d8Offsets.length; direction++) {
      const nx = x + d8Offsets[direction][0];
      const ny = y + d8Offsets[direction][1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbor = ny * width + nx;
      if (distanceToCenterline[neighbor] !== 255) continue;
      // The ocean is the receiving water body, not another stretch of river
      // bank. Stop the channel corridor at the shoreline so it opens directly
      // into the ocean instead of tracing a second water edge over it.
      if (isOcean[neighbor] === 1) continue;
      if (elevation[neighbor] >= waterSurfaceM) continue;

      distanceToCenterline[neighbor] = nextDistance;
      inheritedChannelRadius[neighbor] = radius;
      inheritedChannelOrder[neighbor] = channelOrder;
      inheritedWaterSurfaceM[neighbor] = waterSurfaceM;
      isRiverChannel[neighbor] = 1;
      waterDepthM[neighbor] = Math.max(
        0.05,
        waterSurfaceM - elevation[neighbor],
      );
      strahlerOrder[neighbor] = Math.max(strahlerOrder[neighbor], channelOrder);
      bankFillQueue[bankQueueWrite++] = neighbor;
    }
  }

  // Keep the routed river present when the selected sea datum floods its
  // lower cells. The ocean mask remains authoritative for the water body;
  // these two fields only identify the narrow, catchment-backed continuation
  // of a land river through that water body.
  extendRoutedRiverMouth(
    width,
    height,
    isOcean,
    flowDirection,
    centerlineMask,
    isRiverChannel,
    inheritedChannelRadius,
    inheritedChannelOrder,
    inheritedWaterSurfaceM,
    waterDepthM,
    rainfallWeightedAreaKm2,
    riverMouthMask,
    riverMouthAreaKm2,
    riverThresholdKm2,
    oceanElevationM,
    Math.min(dxMeters, dyMeters),
  );
  const lakeDepthM = extractRiverFedLakes(
    width,
    height,
    elevation,
    conditionedElevation,
    isOcean,
    rainfallWeightedAreaKm2,
    riverThresholdKm2,
    cellAreaKm2,
    // Routing is finished; reuse its full-size scratch buffers.
    floodVisited,
    routingQueue,
  );
  hydrologyStop?.();

  // 5. Regionalized microclimate and biomes
  const biomeStop = profiler?.begin("DEM regional biomes and coasts");
  onStage?.("Classifying biomes and coasts");
  const wetlandCandidates = new Uint8Array(totalCells);
  const holdridgeZone = new Uint8Array(totalCells).fill(255);

  // Relief is intentionally high frequency, but vegetation zones are not.
  // Classifying directly from z/slope/aspect made every small DEM facet a
  // biome boundary. Build climate-scale fields for ecological rules while
  // retaining the original fields for terrain, rivers, inspection, and shading.
  const biomeCellSizeM = Math.min(dxMeters, dyMeters);
  const biomeRegionRadius =
    biomeCellSizeM > 0
      ? Math.max(0, Math.round((biomeRegionScaleKm * 1000.0) / biomeCellSizeM))
      : 0;
  const regionalElevation = smoothBiomeField(
    analysisElevation,
    width,
    height,
    biomeRegionRadius,
  );
  const regionalPrecipitation = smoothBiomeField(
    precipitationMmYr,
    width,
    height,
    biomeRegionRadius,
  );
  const regionalSlopeDeg = calculateRegionalSlope(
    regionalElevation,
    width,
    height,
    dxMeters,
    dyMeters,
  );
  // Meadows follow the local flats the eye reads, lightly smoothed so single
  // DEM facets do not become meadow patches.
  const meadowSlopeDeg = smoothBiomeField(
    slopeDeg,
    width,
    height,
    Math.max(1, Math.round(biomeRegionRadius / 4)),
  );
  const elevationRangeM = Math.max(1, maxElevM - minElevM);

  // Perennial drainage: routed river channels and lakes, not the sea.
  const drainageMask = new Uint8Array(totalCells);
  for (let index = 0; index < totalCells; index++) {
    if (isOcean[index] === 0 && (isRiverChannel[index] === 1 || lakeDepthM[index] > 0)) {
      drainageMask[index] = 1;
    }
  }
  const heightAboveDrainageM = computeHeightAboveNearestDrainage(
    width,
    height,
    conditionedElevation,
    flowDirection,
    drainageMask,
    d8Offsets,
  );

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const isRiver = isRiverChannel[idx];
      const strahler = strahlerOrder[idx];
      const biomeElevation = regionalElevation[idx];
      const biomePrecipitation = regionalPrecipitation[idx];
      const biomeSlope = regionalSlopeDeg[idx];

      if (isOcean[idx] === 1) {
        isOcean[idx] = 1;
        biomeType[idx] = 8;
        continue;
      }

      const biomeTemp = baseTempC - (biomeElevation / 1000.0) * 6.5;
      // Base temperature shifts the climatic snowline. Previously the 3000 m
      // cutoff was effectively fixed, so changing the temperature slider only
      // changed a diagnostic field without moving most biome boundaries.
      const climateSnowlineM = Math.max(
        900,
        Math.min(maxElevM, 3000 + (baseTempC - 18.0) * 100.0),
      );
      const isGlacial =
        biomeElevation >= climateSnowlineM ||
        (biomeElevation >= climateSnowlineM - 350.0 &&
          biomeTemp <= 0.0 &&
          biomePrecipitation > 900.0);
      // Holdridge life zone from biotemperature and the rain-shadowed annual
      // precipitation. Only the annual mean temperature is simulated, so it
      // stands in for the monthly means of the biotemperature definition.
      const biotemperature = holdridgeBiotemperatureFromAnnualMean(biomeTemp);
      const lifeZone = classifyHoldridgeLifeZone(biotemperature, biomePrecipitation);
      holdridgeZone[idx] = HOLDRIDGE_ZONE_CODES.indexOf(lifeZone);
      const petRatio = holdridgePetRatio(biotemperature, biomePrecipitation);
      const holdridgeBiome = mountainBiomeForHoldridgeZone(lifeZone, biotemperature, petRatio, biomeSlope);
      const isMeadow =
        !isRiver &&
        (holdridgeBiome === 2 || holdridgeBiome === 3 || holdridgeBiome === 4) &&
        meadowSlopeDeg[idx] < MEADOW_MAX_SLOPE_DEG &&
        (biomeElevation - minElevM) / elevationRangeM < MEADOW_MAX_NORMALIZED_ELEVATION;
      const climateBiome: MountainBiomeId = isMeadow ? 20 : holdridgeBiome;
      const isDesertClimate = climateBiome === 15 || climateBiome === 16;
      // Wetlands need at least a subhumid climate (PET ratio below 2, the
      // semi-arid boundary) or a water table at the surface. A water table
      // does not make a wetland in a desert climate (PET ratio 4 and above):
      // there the banks become oasis or riparian shrub instead.
      const supportsWetland =
        petRatio < 2 ||
        (heightAboveDrainageM[idx] < WATERLOGGED_HAND_M && petRatio < DESERT_PET_RATIO);

      if (isGlacial) {
        biomeType[idx] = 0; // Permanent Glacier / Ice Horn
      } else if (biomeSlope > 38.0) {
        biomeType[idx] = 1; // Alpine Bare Rock & Arête Scree
      } else if (isRiver && strahler >= 3) {
        biomeType[idx] = 6; // Braided River Channel & Gravel Bars
      } else if (isRiver && isDesertClimate) {
        biomeType[idx] = 19; // Desert Oasis
      } else if (isRiver && biomeElevation < 1000) {
        biomeType[idx] = 5; // Riparian Canyon Shrubland
      } else if (
        !isRiver &&
        supportsWetland &&
        biomeElevation < wetlandElevationThresholdM &&
        biomeSlope < 8.0
      ) {
        // Hold the candidate until the whole field has been classified so
        // isolated threshold hits can be removed as a spatial pass; rejected
        // candidates keep their climate biome.
        wetlandCandidates[idx] = 1;
        biomeType[idx] = climateBiome;
      } else {
        biomeType[idx] = climateBiome;
      }
    }
  }

  stabilizeWetlandBiomes(width, height, biomeType, wetlandCandidates);
  if (biomeRegionRadius > 0) {
    stabilizeBiomeZones(
      width,
      height,
      biomeType,
      isRiverChannel,
      biomeRegionRadius >= 16 ? 2 : 1,
    );
  }
  warpBiomeBoundaries(
    width,
    height,
    biomeType,
    isOcean,
    isRiverChannel,
    dxMeters,
    dyMeters,
    Math.max(1, options.biomeEdgeNoiseScaleM ?? DEFAULT_BIOME_EDGE_NOISE_SCALE_M),
    Math.max(0, options.biomeEdgeStrength ?? 1),
  );

  separateDesertFromWetland(
    width,
    height,
    biomeType,
    Math.max(1, Math.round(DESERT_WETLAND_BUFFER_M / biomeCellSizeM)),
  );
  applyWaterloggedBankBiomes(biomeType, heightAboveDrainageM, isOcean, isRiverChannel);
  applyRiparianCorridors(
    width,
    height,
    biomeType,
    isOcean,
    isRiverChannel,
    strahlerOrder,
    dxMeters,
    dyMeters,
    Math.max(1, options.biomeEdgeNoiseScaleM ?? DEFAULT_BIOME_EDGE_NOISE_SCALE_M),
  );

  // Add shoreline materials after regional smoothing, preserving routed water.
  classifyCoastalBiomes(
    width,
    height,
    biomeType,
    isOcean,
    isRiverChannel,
    slopeDeg,
    elevation,
    oceanElevationM,
    minElevM,
    maxElevM,
    dxMeters,
    dyMeters,
    Math.max(1, options.biomeEdgeNoiseScaleM ?? DEFAULT_BIOME_EDGE_NOISE_SCALE_M),
    Math.max(0, options.biomeEdgeStrength ?? 1),
  );
  biomeStop?.();

  return {
    width,
    height,
    domainWidthKm,
    domainHeightKm,
    biomeRegionScaleKm,
    biomeEdgeNoiseScaleM: Math.max(1, options.biomeEdgeNoiseScaleM ?? DEFAULT_BIOME_EDGE_NOISE_SCALE_M),
    biomeEdgeStrength: Math.max(0, options.biomeEdgeStrength ?? 1),
    dxMeters,
    dyMeters,
    minElevationM: minElevM,
    maxElevationM: maxElevM,
    oceanSurfaceElevationM: oceanElevationM,
    elevation,
    normalizedElevation,
    slopeDeg,
    aspectDeg,
    normals,
    hillshade,
    ambientOcclusion,
    curvature,
    tpi,
    flowAccumulation,
    drainageAreaKm2,
    rainfallWeightedAreaKm2,
    runoffDepthMmYr,
    dischargeM3s,
    strahlerOrder,
    riverCenterlineMask: centerlineMask,
    isRiverChannel,
    riverChannelRadius: inheritedChannelRadius,
    riverMouthMask,
    riverMouthAreaKm2,
    waterDepthM,
    flowDirection,
    erosionDepthM: new Float32Array(totalCells),
    precipitationMmYr,
    solarInsolation,
    temperatureC,
    biomeType,
    holdridgeZone,
    heightAboveDrainageM,
    isOcean,
    lakeDepthM,
  };
}

/**
 * Turns priority-flood depressions into lakes. The filled surface is the
 * basin's spill level, so every connected cell below it is standing water.
 * Only basins large and deep enough to be real, and fed by a routed river
 * (the spill outlet carries the whole inflow), become lakes; small raster
 * pits stay filled for routing only. Returns water depth per lake cell.
 */
export function extractRiverFedLakes(
  width: number,
  height: number,
  elevation: Float32Array,
  filledElevation: Float32Array,
  isOcean: Uint8Array,
  rainfallWeightedAreaKm2: Float32Array,
  riverThresholdKm2: number,
  cellAreaKm2: number,
  visited = new Uint8Array(width * height),
  component = new Int32Array(width * height),
): Float32Array {
  const totalCells = width * height;
  const lakeDepthM = new Float32Array(totalCells);
  const minWaterDepthM = 0.25;
  const minLakeDepthM = 2;
  const minLakeCells = Math.max(6, Math.ceil(0.02 / Math.max(1e-9, cellAreaKm2)));
  const isBasin = (i: number): boolean =>
    isOcean[i] === 0 && filledElevation[i] - elevation[i] > minWaterDepthM;

  visited.fill(0);
  for (let start = 0; start < totalCells; start++) {
    if (visited[start] === 1 || !isBasin(start)) continue;
    visited[start] = 1;
    component[0] = start;
    let count = 1;
    let read = 0;
    let maxDepth = 0;
    let inflowKm2 = 0;
    while (read < count) {
      const idx = component[read++];
      maxDepth = Math.max(maxDepth, filledElevation[idx] - elevation[idx]);
      inflowKm2 = Math.max(inflowKm2, rainfallWeightedAreaKm2[idx]);
      const x = idx % width;
      const y = (idx - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (visited[n] === 1 || !isBasin(n)) continue;
          visited[n] = 1;
          component[count++] = n;
        }
      }
    }
    if (
      count >= minLakeCells &&
      maxDepth >= minLakeDepthM &&
      inflowKm2 >= riverThresholdKm2
    ) {
      for (let k = 0; k < count; k++) {
        const idx = component[k];
        lakeDepthM[idx] = filledElevation[idx] - elevation[idx];
      }
    }
  }
  return lakeDepthM;
}

/**
 * Rebuild only lighting-dependent DEM fields. Slope, aspect, routing, climate,
 * channels, and biomes are deliberately left untouched so interactive sun and
 * exaggeration controls do not rerun the scientific pipeline.
 */
export function recomputeMountainLighting(
  dem: MountainDEMData,
  options: Pick<
    BaseDEMOptions,
    "sunAzimuthDeg" | "sunAltitudeDeg" | "verticalExaggeration"
  >,
  profiler?: MountainProfiler,
): void {
  const sunAzimuth = options.sunAzimuthDeg ?? 315;
  const sunAltitude = options.sunAltitudeDeg ?? 45;
  const verticalExaggeration = options.verticalExaggeration ?? 3.5;
  const sunRad1 = (sunAzimuth * Math.PI) / 180;
  const altitudeRad1 = (sunAltitude * Math.PI) / 180;
  const sun1 = [
    Math.sin(sunRad1) * Math.cos(altitudeRad1),
    -Math.cos(sunRad1) * Math.cos(altitudeRad1),
    Math.sin(altitudeRad1),
  ];
  const sunRad2 = ((sunAzimuth + 90) * Math.PI) / 180;
  const altitudeRad2 = (Math.max(10, sunAltitude - 15) * Math.PI) / 180;
  const sun2 = [
    Math.sin(sunRad2) * Math.cos(altitudeRad2),
    -Math.cos(sunRad2) * Math.cos(altitudeRad2),
    Math.sin(altitudeRad2),
  ];
  const oceanSurface = dem.oceanSurfaceElevationM ?? -10;
  const xPrevIndices = new Int32Array(dem.width);
  const xNextIndices = new Int32Array(dem.width);
  const yPrevIndices = new Int32Array(dem.height);
  const yNextIndices = new Int32Array(dem.height);
  for (let x = 0; x < dem.width; x++) {
    xPrevIndices[x] = Math.max(0, x - 1);
    xNextIndices[x] = Math.min(dem.width - 1, x + 1);
  }
  for (let y = 0; y < dem.height; y++) {
    yPrevIndices[y] = Math.max(0, y - 1);
    yNextIndices[y] = Math.min(dem.height - 1, y + 1);
  }
  const sampleElevation = (index: number): number =>
    dem.isOcean[index] === 1 ? oceanSurface : dem.elevation[index];

  const lightingStop = profiler?.begin("lighting updates");
  for (let y = 0; y < dem.height; y++) {
    const yPrev = yPrevIndices[y];
    const yNext = yNextIndices[y];
    for (let x = 0; x < dem.width; x++) {
      const xPrev = xPrevIndices[x];
      const xNext = xNextIndices[x];
      const zNW = sampleElevation(yPrev * dem.width + xPrev);
      const zN = sampleElevation(yPrev * dem.width + x);
      const zNE = sampleElevation(yPrev * dem.width + xNext);
      const zW = sampleElevation(y * dem.width + xPrev);
      const zE = sampleElevation(y * dem.width + xNext);
      const zSW = sampleElevation(yNext * dem.width + xPrev);
      const zS = sampleElevation(yNext * dem.width + x);
      const zSE = sampleElevation(yNext * dem.width + xNext);
      const dzdx =
        (zNE + 2 * zE + zSE - (zNW + 2 * zW + zSW)) /
        (8 * dem.dxMeters);
      const dzdy =
        (zSW + 2 * zS + zSE - (zNW + 2 * zN + zNE)) /
        (8 * dem.dyMeters);
      const dx = dzdx * verticalExaggeration;
      const dy = dzdy * verticalExaggeration;
      const length = Math.sqrt(dx * dx + dy * dy + 1);
      const nx = -dx / length;
      const ny = -dy / length;
      const nz = 1 / length;
      const index = y * dem.width + x;
      dem.normals[index * 3] = nx;
      dem.normals[index * 3 + 1] = ny;
      dem.normals[index * 3 + 2] = nz;
      const primary = Math.max(
        0,
        nx * sun1[0] + ny * sun1[1] + nz * sun1[2],
      );
      const secondary = Math.max(
        0,
        nx * sun2[0] + ny * sun2[1] + nz * sun2[2],
      );
      dem.hillshade[index] = Math.max(
        0,
        Math.min(1, 0.22 + 0.65 * Math.pow(primary, 0.95) + 0.13 * secondary),
      );
    }
  }
  lightingStop?.();
}

/**
 * Extends each routed land river into the ocean as a narrow mouth corridor.
 *
 * The ocean surface datum can classify many source DEM cells as submerged,
 * but that must not erase the river that routed through them. This mask is a
 * rendering and erosion companion to isOcean: it preserves the river's
 * centreline, width, and inherited catchment without changing the substrate
 * elevation or converting the surrounding sea into river cells.
 */
function extendRoutedRiverMouth(
  width: number,
  height: number,
  isOcean: Uint8Array,
  flowDirection: Int8Array,
  centerlineMask: Uint8Array,
  isRiverChannel: Uint8Array,
  channelRadius: Uint8Array,
  channelOrder: Uint8Array,
  waterSurfaceM: Float32Array,
  waterDepthM: Float32Array,
  rainfallWeightedAreaKm2: Float32Array,
  riverMouthMask: Uint8Array,
  riverMouthAreaKm2: Float32Array,
  riverThresholdKm2: number,
  oceanSurfaceElevationM: number,
  cellSizeM: number,
): void {
  const totalCells = width * height;
  const d8Offsets = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];
  const receiver = new Int32Array(totalCells).fill(-1);
  const oceanReceiver = new Int32Array(totalCells).fill(-1);
  const oceanDistanceToBoundary = new Int32Array(totalCells).fill(-1);
  const queue = new Int32Array(totalCells);
  let queueRead = 0;
  let queueWrite = 0;

  const getReceiver = (index: number): number => {
    const direction = flowDirection[index];
    if (direction < 0 || direction >= d8Offsets.length) return -1;
    const x = index % width;
    const y = Math.floor(index / width);
    const nx = x + d8Offsets[direction][0];
    const ny = y + d8Offsets[direction][1];
    return nx < 0 || nx >= width || ny < 0 || ny >= height
      ? -1
      : ny * width + nx;
  };

  for (let index = 0; index < totalCells; index++) {
    receiver[index] = getReceiver(index);
    if (isOcean[index] !== 1) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
      oceanDistanceToBoundary[index] = 0;
      queue[queueWrite++] = index;
    }
  }

  // A flat priority-flood ocean often has a valid receiver to the map edge,
  // but a source ocean mask can also leave an interior water pocket without
  // one. Build a deterministic ocean-only fallback in either case.
  while (queueRead < queueWrite) {
    const current = queue[queueRead++];
    const x = current % width;
    const y = Math.floor(current / width);
    const nextDistance = oceanDistanceToBoundary[current] + 1;
    for (const [dx, dy] of d8Offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const target = ny * width + nx;
      if (isOcean[target] !== 1 || oceanDistanceToBoundary[target] >= 0)
        continue;
      oceanDistanceToBoundary[target] = nextDistance;
      oceanReceiver[target] = current;
      queue[queueWrite++] = target;
    }
  }

  const openOceanMask = extractDeepOpenOceanMask(
    isOcean,
    isRiverChannel,
    width,
    height,
  );
  const maximumReachCells = Math.max(
    16,
    Math.min(96, Math.ceil(2500 / Math.max(1, cellSizeM))),
  );
  const mouthQueue = new Int32Array(totalCells);
  const submergedDistance = new Uint8Array(totalCells);
  const inheritedAreaKm2 = new Float32Array(totalCells);
  const visited = new Uint8Array(totalCells);
  let mouthRead = 0;
  let mouthWrite = 0;

  const adjacentOceanTarget = (current: number): number => {
    const x = current % width;
    const y = Math.floor(current / width);
    const direct = receiver[current];
    let fallback = -1;
    let fallbackDistance = Number.POSITIVE_INFINITY;
    for (const [dx, dy] of d8Offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const target = ny * width + nx;
      if (isOcean[target] !== 1) continue;
      if (target === direct) return target;
      const distance = oceanDistanceToBoundary[target] >= 0
        ? oceanDistanceToBoundary[target]
        : Number.POSITIVE_INFINITY;
      if (distance < fallbackDistance) {
        fallback = target;
        fallbackDistance = distance;
      }
    }
    return fallback;
  };

  // Every land centreline is a valid possible inlet. A target is visited once
  // so multiple tributaries cannot widen the same mouth by repeatedly tracing
  // the same ocean path.
  for (let index = 0; index < totalCells; index++) {
    if (
      isOcean[index] === 0 &&
      centerlineMask[index] === 1 &&
      rainfallWeightedAreaKm2[index] >= riverThresholdKm2
    ) {
      visited[index] = 1;
      inheritedAreaKm2[index] = rainfallWeightedAreaKm2[index];
      mouthQueue[mouthWrite++] = index;
    }
  }

  while (mouthRead < mouthWrite) {
    const current = mouthQueue[mouthRead++];
    const direct = receiver[current];
    let target = -1;
    if (isOcean[current] === 1) {
      if (direct >= 0 && isOcean[direct] === 1) target = direct;
      else if (oceanReceiver[current] >= 0) target = oceanReceiver[current];
      else target = adjacentOceanTarget(current);
    } else if (
      direct >= 0 &&
      (isOcean[direct] === 1 || isRiverChannel[direct] === 1)
    ) {
      target = direct;
    } else {
      target = adjacentOceanTarget(current);
    }

    if (target < 0 || visited[target] === 1) continue;
    const targetIsOcean = isOcean[target] === 1;
    if (!targetIsOcean && isRiverChannel[target] !== 1) continue;
    // A river that simply exits through an image-edge ocean pixel is an
    // outlet, not a submerged mouth. Requiring one interior ocean cell keeps
    // tiny source-mask islands from being relabelled as river channels while
    // still allowing normal coastlines that lie inside the map.
    if (
      targetIsOcean &&
      oceanDistanceToBoundary[target] === 0
    )
      continue;
    if (
      targetIsOcean &&
      isOcean[current] === 1 &&
      submergedDistance[current] >= maximumReachCells
    )
      continue;

    const area = Math.max(
      riverThresholdKm2,
      rainfallWeightedAreaKm2[target],
      inheritedAreaKm2[current],
    );
    visited[target] = 1;
    inheritedAreaKm2[target] = area;
    centerlineMask[target] = 1;
    isRiverChannel[target] = 1;
    channelRadius[target] = Math.max(
      1,
      targetIsOcean ? channelRadius[current] : channelRadius[target],
    );
    if (!targetIsOcean) {
      channelRadius[target] = Math.max(
        channelRadius[target],
        channelRadius[current],
      );
    }
    channelOrder[target] = Math.max(1, channelOrder[current]);

    if (targetIsOcean) {
      riverMouthMask[target] = 1;
      riverMouthAreaKm2[target] = Math.max(
        riverMouthAreaKm2[target],
        area,
      );
      submergedDistance[target] = Math.min(
        255,
        submergedDistance[current] + 1,
      );
      const mouthDepth = Math.max(
        0.05,
        Math.min(8, waterDepthM[current] || 0.4),
      );
      waterDepthM[target] = Math.max(waterDepthM[target], mouthDepth);
      waterSurfaceM[target] = oceanSurfaceElevationM + mouthDepth;
    } else {
      waterSurfaceM[target] = Math.max(
        waterSurfaceM[target],
        waterSurfaceM[current],
      );
      waterDepthM[target] = Math.max(
        waterDepthM[target],
        Math.max(0.05, waterDepthM[current]),
      );
    }

    // The first genuinely open-sea cell is enough to make the transition
    // continuous. Keep the surrounding sea an ordinary ocean surface.
    if (targetIsOcean && openOceanMask[target] === 1) continue;
    mouthQueue[mouthWrite++] = target;
  }
}

/**
 * Computes one bounded, routed fluvial incision pass. This intentionally
 * operates on the already-routed DEM: rain falling on a cell contributes only
 * through its catchment, and incision is limited by the local downstream
 * relief so it cannot invert a channel or carve isolated puddles.
 */
function computeMountainFluvialIncision(
  dem: MountainDEMData,
  erosionStrength: number,
  basePrecipitationMmYr: number,
  riverThresholdKm2: number,
): Float32Array {
  const totalCells = dem.width * dem.height;
  const incisionM = new Float32Array(totalCells);
  const cellAreaKm2 = (dem.dxMeters * dem.dyMeters) / 1_000_000;
  const cellAreaM2 = dem.dxMeters * dem.dyMeters;
  const minimumCatchmentKm2 = Math.max(
    cellAreaKm2 * 2,
    riverThresholdKm2 * 0.12,
  );
  const safeBasePrecip = Math.max(1, basePrecipitationMmYr);
  const d8Offsets = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];
  const receiver = new Int32Array(totalCells).fill(-1);
  const pendingReceivers = new Uint16Array(totalCells);

  // Rebuild the primary receiver graph locally. The public DEM keeps the
  // direction field, but not the temporary topological order used while
  // routing accumulation. Incision must use that same downstream order so an
  // upstream cell can feed erosion into lower channel sections.
  for (let i = 0; i < totalCells; i++) {
    const direction = dem.flowDirection[i];
    if (direction < 0) continue;
    const x = i % dem.width;
    const y = Math.floor(i / dem.width);
    const nx = x + d8Offsets[direction][0];
    const ny = y + d8Offsets[direction][1];
    if (nx < 0 || nx >= dem.width || ny < 0 || ny >= dem.height) continue;
    const target = ny * dem.width + nx;
    if (target === i) continue;
    receiver[i] = target;
    pendingReceivers[target]++;
  }

  const routingOrder = new Int32Array(totalCells);
  const routingQueue = new Int32Array(totalCells);
  let queueRead = 0;
  let queueWrite = 0;
  let routingCount = 0;
  for (let i = 0; i < totalCells; i++) {
    if (pendingReceivers[i] === 0) routingQueue[queueWrite++] = i;
  }
  while (queueRead < queueWrite) {
    const i = routingQueue[queueRead++];
    routingOrder[routingCount++] = i;
    const target = receiver[i];
    if (target >= 0 && --pendingReceivers[target] === 0)
      routingQueue[queueWrite++] = target;
  }
  // Priority-flood routing should be acyclic. If a malformed edge field ever
  // contains a cycle, process the remaining cells once as local sources so
  // erosion remains finite and deterministic instead of disappearing.
  if (routingCount < totalCells) {
    const routed = new Uint8Array(totalCells);
    for (let i = 0; i < routingCount; i++) routed[routingOrder[i]] = 1;
    for (let i = 0; i < totalCells; i++) {
      if (routed[i] === 0) routingOrder[routingCount++] = i;
    }
  }

  // Priority-flood leaves edge cells without a receiver. That is correct for
  // ordinary drainage, but it makes a river disappear as soon as its mouth
  // reaches a flat ocean cell. Build an ocean-only fallback receiver that
  // points toward the nearest ocean boundary. The normal DEM receiver remains
  // preferred; this is only used when the flat ocean has no usable edge.
  const oceanReceiver = new Int32Array(totalCells).fill(-1);
  const oceanDistanceToBoundary = new Int32Array(totalCells).fill(-1);
  const oceanQueue = new Int32Array(totalCells);
  let oceanQueueRead = 0;
  let oceanQueueWrite = 0;
  for (let i = 0; i < totalCells; i++) {
    const x = i % dem.width;
    const y = Math.floor(i / dem.width);
    if (
      dem.isOcean[i] === 1 &&
      (x === 0 || x === dem.width - 1 || y === 0 || y === dem.height - 1)
    ) {
      oceanDistanceToBoundary[i] = 0;
      oceanQueue[oceanQueueWrite++] = i;
    }
  }
  while (oceanQueueRead < oceanQueueWrite) {
    const current = oceanQueue[oceanQueueRead++];
    const x = current % dem.width;
    const y = Math.floor(current / dem.width);
    const nextDistance = oceanDistanceToBoundary[current] + 1;
    for (const [dx, dy] of d8Offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= dem.width || ny < 0 || ny >= dem.height) continue;
      const target = ny * dem.width + nx;
      if (
        dem.isOcean[target] === 1 &&
        oceanDistanceToBoundary[target] < 0
      ) {
        oceanDistanceToBoundary[target] = nextDistance;
        oceanQueue[oceanQueueWrite++] = target;
      }
    }
  }
  for (let i = 0; i < totalCells; i++) {
    if (dem.isOcean[i] === 0) continue;
    const x = i % dem.width;
    const y = Math.floor(i / dem.width);
    let bestDistance = oceanDistanceToBoundary[i];
    for (const [dx, dy] of d8Offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= dem.width || ny < 0 || ny >= dem.height) continue;
      const target = ny * dem.width + nx;
      if (
        dem.isOcean[target] === 1 &&
        oceanDistanceToBoundary[target] >= 0 &&
        oceanDistanceToBoundary[target] < bestDistance
      ) {
        bestDistance = oceanDistanceToBoundary[target];
        oceanReceiver[i] = target;
      }
    }
  }

  const routedElevationAt = (index: number): number =>
    dem.isOcean[index] === 1
      ? dem.oceanSurfaceElevationM ?? dem.elevation[index]
      : dem.elevation[index];

  // Ocean cells are intentionally excluded from the visible river mask, but
  // the river's routed load must not disappear at the shoreline. Trace each
  // land-channel receiver into the ocean so erosion can continue across a
  // submerged river mouth without turning the whole ocean into a river.
  const riverErosionMask = new Uint8Array(totalCells);
  const riverErosionCenterlineMask = new Uint8Array(totalCells);
  const riverErosionRadius = new Uint8Array(totalCells);
  const riverErosionAreaKm2 = new Float32Array(totalCells);
  const riverErosionSubmergedDistance = new Uint8Array(totalCells);
  const riverErosionQueue = new Int32Array(totalCells);
  let riverErosionRead = 0;
  let riverErosionWrite = 0;
  const minimumRiverCatchmentKm2 = Math.max(
    minimumCatchmentKm2,
    riverThresholdKm2,
  );
  const radiusAtRiverCell = (index: number): number => {
    const storedRadius = dem.riverChannelRadius?.[index] ?? 0;
    if (storedRadius > 0) return storedRadius;
    return Math.max(
      1,
      Math.min(
        9,
        Math.round(0.75 + Math.sqrt(Math.max(0.25, dem.waterDepthM[index]))),
      ),
    );
  };
  const openOceanMask = extractDeepOpenOceanMask(
    dem.isOcean,
    dem.isRiverChannel,
    dem.width,
    dem.height,
  );
  // The open-ocean mask provides the natural end of a submerged river mouth.
  // The distance cap is only a malformed/closed-mask safeguard; it is no
  // longer the normal reason for a valid ocean connection to stop.
  const maximumSubmergedRiverReachCells = Math.max(
    16,
    Math.min(
      96,
      Math.ceil(2500 / Math.max(1, Math.min(dem.dxMeters, dem.dyMeters))),
    ),
  );
  const adjacentOceanTarget = (current: number): number => {
    const x = current % dem.width;
    const y = Math.floor(current / dem.width);
    const direct = receiver[current];
    let fallback = -1;
    let fallbackDistance = Number.POSITIVE_INFINITY;
    for (const [dx, dy] of d8Offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= dem.width || ny < 0 || ny >= dem.height) continue;
      const target = ny * dem.width + nx;
      if (dem.isOcean[target] !== 1) continue;
      if (target === direct) return target;
      const distance = oceanDistanceToBoundary[target] >= 0
        ? oceanDistanceToBoundary[target]
        : Number.POSITIVE_INFINITY;
      if (distance < fallbackDistance) {
        fallback = target;
        fallbackDistance = distance;
      }
    }
    return fallback;
  };
  const nextRiverTarget = (current: number): number => {
    const direct = receiver[current];
    if (dem.isOcean[current] === 1) {
      if (direct >= 0 && dem.isOcean[direct] === 1) return direct;
      if (oceanReceiver[current] >= 0) return oceanReceiver[current];
      return adjacentOceanTarget(current);
    }
    if (
      direct >= 0 &&
      (dem.isOcean[direct] === 1 || dem.isRiverChannel[direct] === 1)
    ) {
      return direct;
    }
    // A bank-stage corridor can touch the ocean even when the raw D8 receiver
    // points at a one-pixel dry gap. Bridge that shoreline gap locally.
    return adjacentOceanTarget(current);
  };
  for (let i = 0; i < totalCells; i++) {
    if (
      dem.isOcean[i] === 0 &&
      (dem.riverCenterlineMask?.[i] === 1 || dem.isRiverChannel[i] === 1) &&
      dem.rainfallWeightedAreaKm2[i] >= minimumRiverCatchmentKm2
    ) {
      riverErosionMask[i] = 1;
      riverErosionCenterlineMask[i] = 1;
      riverErosionRadius[i] = radiusAtRiverCell(i);
      riverErosionAreaKm2[i] = dem.rainfallWeightedAreaKm2[i];
      riverErosionQueue[riverErosionWrite++] = i;
    }
  }
  while (riverErosionRead < riverErosionWrite) {
    const current = riverErosionQueue[riverErosionRead++];
    const target = nextRiverTarget(current);
    if (target < 0 || riverErosionCenterlineMask[target] === 1) continue;
    const targetIsOcean = dem.isOcean[target] === 1;
    const targetIsLandRiver = dem.isRiverChannel[target] === 1;
    if (!targetIsOcean && !targetIsLandRiver) continue;
    if (
      targetIsOcean &&
      dem.isOcean[current] === 1 &&
      riverErosionSubmergedDistance[current] >=
        maximumSubmergedRiverReachCells
    )
      continue;
    const inheritedRiverAreaKm2 = Math.max(
      dem.rainfallWeightedAreaKm2[target],
      riverErosionAreaKm2[current],
    );
    if (
      inheritedRiverAreaKm2 + 1e-6 < minimumRiverCatchmentKm2
    )
      continue;

    riverErosionMask[target] = 1;
    riverErosionCenterlineMask[target] = 1;
    riverErosionSubmergedDistance[target] = targetIsOcean
      ? Math.min(
          255,
          riverErosionSubmergedDistance[current] + 1,
        )
      : riverErosionSubmergedDistance[current];
    riverErosionRadius[target] = targetIsOcean
      ? riverErosionRadius[current]
      : Math.max(
          riverErosionRadius[current],
          radiusAtRiverCell(target),
    );
    riverErosionAreaKm2[target] = inheritedRiverAreaKm2;
    riverErosionQueue[riverErosionWrite++] = target;

    // Once the trace reaches genuinely open sea, there is no longer a
    // river-shaped submerged bed to follow. The open-sea cell itself remains
    // part of the eroded mouth, but the entire ocean is not converted into a
    // river merely because it is connected to the coastline.
    if (targetIsOcean && openOceanMask[target] === 1) {
      riverErosionSubmergedDistance[target] = maximumSubmergedRiverReachCells;
    }
  }

  // Carry the same bank-full water width across the submerged continuation.
  // Only ocean cells around the traced centreline are added; this prevents a
  // large open sea from becoming an artificial erosion field.
  for (let i = 0; i < totalCells; i++) {
    if (
      riverErosionCenterlineMask[i] === 0 ||
      dem.isOcean[i] === 0
    )
      continue;
    const radius = Math.max(1, riverErosionRadius[i]);
    const cx = i % dem.width;
    const cy = Math.floor(i / dem.width);
    const flowAreaKm2 = riverErosionAreaKm2[i];
    for (let dy = -radius; dy <= radius; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= dem.height) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= dem.width) continue;
        if (Math.hypot(dx, dy) > radius) continue;
        const target = y * dem.width + x;
        if (dem.isOcean[target] === 0) continue;
        riverErosionMask[target] = 1;
        riverErosionAreaKm2[target] = Math.max(
          riverErosionAreaKm2[target],
          flowAreaKm2,
        );
      }
    }
  }

  const localPotentialM = new Float32Array(totalCells);
  const reliefLimitM = new Float32Array(totalCells);
  const linkLengthM = Math.min(dem.dxMeters, dem.dyMeters) * Math.SQRT2;

  for (let i = 0; i < incisionM.length; i++) {
    const isSubmergedRiverCell =
      dem.isOcean[i] === 1 && riverErosionCenterlineMask[i] === 1;
    const areaKm2 = isSubmergedRiverCell
      ? Math.max(
          dem.rainfallWeightedAreaKm2[i],
          riverErosionAreaKm2[i],
        )
      : dem.rainfallWeightedAreaKm2[i];
    if (
      receiver[i] < 0 ||
      areaKm2 < minimumCatchmentKm2 ||
      (dem.isOcean[i] === 1 && !isSubmergedRiverCell)
    )
      continue;

    const downstreamDropM =
      routedElevationAt(i) - routedElevationAt(receiver[i]);

    // Area gives the routed water volume; slope and precipitation provide the
    // stream-power terms. Do not reject flat raw neighbors here: priority
    // flooding can legitimately route a channel across a raw flat or a tiny
    // uphill quantization step, and rejecting those cells breaks erosion
    // exactly where the visible downstream channel should continue.
    const areaFactor = Math.min(
      6,
      Math.pow(
        Math.max(areaKm2, minimumCatchmentKm2) / minimumCatchmentKm2,
        0.33,
      ),
    );
    const measuredSlopeFactor = Math.min(
      1.25,
      Math.tan((dem.slopeDeg[i] * Math.PI) / 180) / 0.65,
    );
    // A water-stage corridor can be visibly wet across a quantized/raw-flat
    // reach. Give routed river cells the same conservative low-gradient floor
    // used for submerged mouths; otherwise slope=0 makes the whole incision
    // potential zero before the flat-reach relief allowance is reached.
    const slopeFactor = isSubmergedRiverCell || dem.isRiverChannel[i] === 1
      ? Math.max(0.15, measuredSlopeFactor)
      : measuredSlopeFactor;
    const rainFactor = Math.sqrt(
      Math.max(0.2, dem.precipitationMmYr[i] / safeBasePrecip),
    );
    const channelFactor = areaKm2 >= riverThresholdKm2 ? 1.0 : 0.35;
    const proposedIncision =
      1.4 *
      erosionStrength *
      areaFactor *
      Math.max(0, slopeFactor) *
      rainFactor *
      channelFactor;
    localPotentialM[i] = proposedIncision;

    // On a true drop, preserve a fraction of the local relief. On a raw flat
    // conditioned channel, use the measured slope and a conservative floor so
    // the channel can still incise instead of becoming a non-eroding shelf.
    reliefLimitM[i] = isSubmergedRiverCell
      ? Math.min(3.0, Math.max(0.15, linkLengthM * 0.04))
      : downstreamDropM > 0
        ? Math.max(0.15, downstreamDropM * 0.2)
        : Math.min(
            3.0,
            Math.max(
              0.15,
              Math.tan((dem.slopeDeg[i] * Math.PI) / 180) * linkLengthM * 0.04,
            ),
          );
  }

  // Route a bounded equivalent incision load downstream. Rainfall-weighted
  // area already represents accumulated runoff, while this signal preserves the visual
  // effect of sediment-laden flow continuing through flat lower reaches.
  const routedLoadM2 = new Float64Array(totalCells);
  for (let orderIndex = 0; orderIndex < routingCount; orderIndex++) {
    const i = routingOrder[orderIndex];
    const localPotential = localPotentialM[i];
    const incomingEquivalentM = Math.min(8.0, routedLoadM2[i] / cellAreaM2);
    if (localPotential <= 0 && incomingEquivalentM <= 0) continue;

    const routedBoostM = Math.min(
      localPotential * 0.75,
      incomingEquivalentM * 0.18,
    );
    // Ocean elevation is a fixed rendering datum rather than an erodible
    // terrain value. Give only traced river-mouth cells a bounded virtual bed
    // allowance so their erosion depth is recorded without lowering sea level.
    const isSubmergedRiverCell =
      dem.isOcean[i] === 1 && riverErosionCenterlineMask[i] === 1;
    const availableElevationM = isSubmergedRiverCell
      ? Math.min(8.0, Math.max(0.15, linkLengthM * 0.08))
      : Math.max(0, dem.elevation[i] - dem.minElevationM);
    incisionM[i] = Math.min(
      localPotential + routedBoostM,
      reliefLimitM[i],
      availableElevationM,
    );

    const target = receiver[i];
    if (target >= 0) {
      const outgoingLoadM = Math.min(12.0, incomingEquivalentM + incisionM[i]);
      routedLoadM2[target] += outgoingLoadM * cellAreaM2 * 0.78;
    }
  }

  // Incision is solved on the routed thalweg, but the exported erosion map
  // should describe the worn bed rather than a one-pixel centerline. Spread a
  // bounded fraction across the existing flow-backed water corridor. This is
  // deliberately constrained by isRiverChannel: it cannot turn ordinary rain
  // or an unrelated lowland into erosion.
  const bedIncisionM = incisionM.slice();
  for (let i = 0; i < totalCells; i++) {
    const centerIncision = incisionM[i];
    if (
      centerIncision <= 0 ||
      (dem.isRiverChannel[i] === 0 && riverErosionMask[i] === 0)
    )
      continue;

    const erosionAreaKm2 =
      dem.isOcean[i] === 1
        ? Math.max(dem.rainfallWeightedAreaKm2[i], riverErosionAreaKm2[i])
        : dem.rainfallWeightedAreaKm2[i];
    const areaRatio = Math.max(
      1,
      erosionAreaKm2 /
        Math.max(minimumCatchmentKm2, riverThresholdKm2),
    );
    const radius = Math.min(
      8,
      Math.max(1, Math.round(0.75 + Math.sqrt(areaRatio) * 0.55)),
    );
    const cx = i % dem.width;
    const cy = Math.floor(i / dem.width);
    const bankAllowanceM = Math.max(3, dem.waterDepthM[i] * 1.8 + 2.0);

    for (let dy = -radius; dy <= radius; dy++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= dem.height) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = cx + dx;
        if (nx < 0 || nx >= dem.width) continue;
        const distance = Math.hypot(dx, dy);
        if (distance > radius) continue;

        const target = ny * dem.width + nx;
        if (
          target === i ||
          (dem.isRiverChannel[target] === 0 && riverErosionMask[target] === 0)
        )
          continue;
        if (
          routedElevationAt(target) >
          routedElevationAt(i) + bankAllowanceM
        )
          continue;

        const falloff = 1 - distance / (radius + 0.5);
        const bedShare = 0.18 + 0.42 * Math.max(0, falloff);
        const targetIsSubmergedRiver =
          dem.isOcean[target] === 1 && riverErosionMask[target] === 1;
        const targetAvailableElevation = targetIsSubmergedRiver
          ? Math.min(8.0, Math.max(0.15, linkLengthM * 0.08))
          : Math.max(0, dem.elevation[target] - dem.minElevationM);
        const sideIncision = Math.min(
          centerIncision * bedShare,
          targetAvailableElevation,
        );
        if (sideIncision > bedIncisionM[target])
          bedIncisionM[target] = sideIncision;
      }
    }
  }

  return bedIncisionM;
}

/**
 * Computes a bounded marine/coastal erosion pass. The open ocean is an energy
 * source at the shoreline, not a rainfall source in the river graph: only
 * nearby land receives this incision, with exposure and distance from the
 * outer marine boundary controlling its strength.
 */
function computeMountainMarineIncision(
  dem: MountainDEMData,
  erosionStrength: number,
): Float32Array {
  const totalCells = dem.width * dem.height;
  const incisionM = new Float32Array(totalCells);
  if (erosionStrength <= 0) return incisionM;

  const d8Offsets = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];
  const marineSourceMask = extractDeepOpenOceanMask(
    dem.isOcean,
    dem.isRiverChannel,
    dem.width,
    dem.height,
  );
  const maximumReachCells = 3;
  const shoreDistance = new Uint8Array(totalCells).fill(255);
  const queue = new Int32Array(totalCells);
  let queueRead = 0;
  let queueWrite = 0;

  // Start from open-ocean cells. This deliberately excludes isolated inland
  // depressions that happen to carry the ocean classification.
  for (let i = 0; i < totalCells; i++) {
    if (marineSourceMask[i] === 1) {
      shoreDistance[i] = 0;
      queue[queueWrite++] = i;
    }
  }

  // Measure distance across land from the open marine source. Ocean cells are
  // already seeded, so the propagation only needs to cross coastal terrain.
  while (queueRead < queueWrite) {
    const current = queue[queueRead++];
    const currentDistance = shoreDistance[current];
    if (currentDistance >= maximumReachCells) continue;

    const cx = current % dem.width;
    const cy = Math.floor(current / dem.width);
    for (const [dx, dy] of d8Offsets) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= dem.width || y < 0 || y >= dem.height) continue;
      const target = y * dem.width + x;
      if (dem.isOcean[target] === 1 || shoreDistance[target] !== 255)
        continue;
      shoreDistance[target] = currentDistance + 1;
      queue[queueWrite++] = target;
    }
  }

  for (let i = 0; i < totalCells; i++) {
    if (dem.isOcean[i] === 1) continue;
    const distance = shoreDistance[i];
    if (distance === 0 || distance > maximumReachCells) continue;

    const cx = i % dem.width;
    const cy = Math.floor(i / dem.width);
    let exposedOceanNeighbors = 0;
    for (const [dx, dy] of d8Offsets) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= dem.width || y < 0 || y >= dem.height) continue;
      if (marineSourceMask[y * dem.width + x] === 1)
        exposedOceanNeighbors++;
    }

    const distanceFactor =
      1 - (distance - 1) / (maximumReachCells + 0.5);
    const exposureFactor =
      exposedOceanNeighbors > 0
        ? exposedOceanNeighbors / d8Offsets.length
        : 0.25;
    const slopeFactor = Math.min(
      1,
      Math.tan((dem.slopeDeg[i] * Math.PI) / 180) / 0.65,
    );
    const riverMouthFactor = dem.isRiverChannel[i] === 1 ? 1.25 : 1;
    const potentialIncisionM =
      1.1 *
      erosionStrength *
      Math.max(0, distanceFactor) *
      (0.35 + 0.65 * exposureFactor) *
      (0.55 + 0.45 * Math.max(0, slopeFactor)) *
      riverMouthFactor;
    const availableElevationM = Math.max(
      0,
      dem.elevation[i] - dem.minElevationM,
    );
    incisionM[i] = Math.min(potentialIncisionM, availableElevationM);
  }

  return incisionM;
}

/**
 * Samples a continuous elevation profile along a 2D line from Point A (x0, y0) to Point B (x1, y1).
 */
export function sampleMountainElevationProfile(
  dem: MountainDEMData,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  numSamples = 200,
): {
  distanceKm: number[];
  elevationM: number[];
  slopeDeg: number[];
  biomeNames: string[];
  points: { x: number; y: number }[];
} {
  const distanceKm: number[] = [];
  const elevationM: number[] = [];
  const slopeDeg: number[] = [];
  const biomeNames: string[] = [];
  const points: { x: number; y: number }[] = [];

  const dx = (p1.x - p0.x) * dem.domainWidthKm;
  const dy = (p1.y - p0.y) * dem.domainHeightKm;
  const totalDistKm = Math.hypot(dx, dy);

  for (let i = 0; i <= numSamples; i++) {
    const t = i / numSamples;
    const px = Math.round(
      p0.x * (dem.width - 1) + t * (p1.x - p0.x) * (dem.width - 1),
    );
    const py = Math.round(
      p0.y * (dem.height - 1) + t * (p1.y - p0.y) * (dem.height - 1),
    );
    const clx = Math.max(0, Math.min(dem.width - 1, px));
    const cly = Math.max(0, Math.min(dem.height - 1, py));
    const idx = cly * dem.width + clx;

    distanceKm.push(t * totalDistKm);
    elevationM.push(dem.elevation[idx]);
    slopeDeg.push(dem.slopeDeg[idx]);
    biomeNames.push(MOUNTAIN_BIOME_LABELS[dem.biomeType[idx]] || "Unknown");
    points.push({ x: clx, y: cly });
  }

  return { distanceKm, elevationM, slopeDeg, biomeNames, points };
}

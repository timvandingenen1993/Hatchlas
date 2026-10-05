/**
 * Hand-drawn style mountain illustration: roughness, snow transport and wind fields turned into ink and wash.
 */
import type { MountainDEMData } from '../terrain/mountainBaseDEM';
import { MIN_POSITIVE_SCALE } from '../config/inspectorBounds';
import {
  clamp01,
  createCharcoalInterruptionPattern,
  hash01,
  isCharcoalInkActiveAtDistance,
  paintInkSegment,
  paintInkSegmentsBatched,
  sampleScalarField,
  createCharcoalStrokeRuns,
  type BatchedInkSegment,
} from './cartographicStrokeRenderer';
import {
  smoothMountainField,
  chainMountainSegments,
  cachedMountainField,
  createMountainFieldCacheSession,
  type MountainFieldCache,
  type MountainFieldCacheSession,
  type MountainPatternOverlay,
} from './mountainPatternRenderer';
import { SimplexNoise } from '../core/noise';
import { tintMountainLand, type TintRGB } from './mountainTerrainTint';
import { sampleCartographicGrain,sampleCartographicWashNoise, sampleCartographicPatchNoise, filterCartographicGradient, filterCartographicSignedGradient } from './cartographicWash';
import {
  mountainProjectionLift,
  mountainProjectionLiftCoefficient,
  normalizeMountainProjectionSettings,
  normalizeMountainSnowfallSettings,
} from './mountainProjection';
import type { MountainProfiler } from './mountainProfiler';
import { stylizeMountainLight, type MountainLightingMode } from './mountainLighting';
import {
  type MountainIllustrationFieldInputs,
  isMountainIllustrationPreparedFieldsCompatible,
  type MountainIllustrationPreparedFields,
} from './mountainIllustrationFields';

export type { MountainIllustrationPreparedFields } from './mountainIllustrationFields';
export type {
  MountainIllustrationFieldInputs,
  MountainIllustrationFieldRadii,
} from './mountainIllustrationFields';

export interface MountainIllustration {
  rgba: Uint8ClampedArray;
  /** Material and shading pixels before any mountain ink is composited. */
  materialRgba: Uint8ClampedArray;
  /** Source row of the visible surface; near faces occlude distant terrain. */
  sourceY: Float32Array;
  /** Resolved camera surface used to keep projection stable across caches. */
  surfaceElevation?: Float32Array;
  /** Global source-space ridge paths for the final camera ink pass. */
  cameraRidgePaths?: MountainPatternOverlay['paths'];
  silhouetteAlpha: Uint8Array;
  charcoalAlpha: Uint8Array;
  /** Final projected snow coverage used by the material compositor. */
  snowCoverageAlpha: Uint8Array;
  /** Diagnostic layers: true depth boundaries versus interior terrain ribs. */
  depthSilhouetteAlpha: Uint8Array;
  interiorRidgeAlpha: Uint8Array;
  faceStrokeAlpha: Uint8Array;
  /** Rasterized horizontal contour hatch coverage before camera projection. */
  horizontalHatchAlpha?: Uint8Array;
  /** Rasterized downhill/vertical hatch coverage before camera projection. */
  verticalHatchAlpha?: Uint8Array;
  /** Hatch controls used to produce the two alpha buffers. */
  horizontalHatchOpacity?: number;
  verticalHatchOpacity?: number;
  silhouettePaths: { x: number; y: number }[][];
  charcoalPaths: { x: number; y: number }[][];
}

/** Layers consumed by the full-terrain camera after mountain material paint. */
export interface MountainCameraIllustrationLayers {
  materialRgba: Uint8ClampedArray;
  silhouetteAlpha: Uint8Array;
  interiorRidgeAlpha: Uint8Array;
  horizontalHatchAlpha: Uint8Array;
  verticalHatchAlpha: Uint8Array;
  horizontalHatchOpacity: number;
  verticalHatchOpacity: number;
}

export interface MountainIllustrationOptions {
  scale: number;
  sunAzimuthDeg: number;
  sunAltitudeDeg: number;
  /** Converts continuous face light into the selected illustrated bands. */
  lightingMode?: MountainLightingMode;
  /** Master intensity for face lighting, surface shadows, and ridge highlights. */
  hillshadeStrength?: number;
  inkColor: readonly number[];
  /** Colour used for downhill and interior hatch/ridge marks. */
  hatchColor?: readonly number[];
  /** Colour used for the connected primary/main ridge line. */
  ridgeColor?: readonly number[];
  /** Legacy shared hatch opacity used when family-specific values are absent. */
  hatchOpacity?: number;
  /** Opacity used for near-horizontal contour hatches. */
  horizontalHatchOpacity?: number;
  /** Opacity used for downhill/vertical hatches. */
  verticalHatchOpacity?: number;
  strokeThickness: number;
  strokeOpacity: number;
  /** Thickness multiplier for automatic and projected main crest outlines. */
  mainRidgeThickness?: number;
  /** Resolved primary-ridge pen multiplier, independent of hatch thickness. */
  ridgeStrokeThickness?: number;
  /** Selective mountain-only projection angle; 90° is straight down. */
  mountainViewAngleDeg?: number;
  /** Selective mountain-only height exaggeration, independent of DEM shading. */
  mountainHeightExaggeration?: number;
  /** Overall snowfall multiplier, independent of projection angle. */
  snowfallAmount?: number;
  /** Routed drift/deposition multiplier for snow. */
  snowfallDrift?: number;
  /** Retention multiplier for sheltered snow on exposed slopes. */
  snowfallPersistence?: number;
  /** Number of downhill D8 receiver steps used by the gravity pass. */
  snowRedistributionSteps?: number;
  /** Prevailing winter wind direction, expressed as the direction it comes from. */
  windAzimuthDeg?: number;
  /** Native-resolution wind fields prepared once for an export snapshot. */
  windFieldsOverride?: MountainWindFields;
  /** Native-resolution snow predictors prepared once for an export snapshot. */
  snowTransportOverride?: MountainSnowTransportFields;
  offsetX: number;
  offsetY: number;
  stride: number;
  seed: number;
  washStrength?: number;
  washDarkStrength?: number;
  washLightStrength?: number;
  washNoiseStrength?: number;
  washNoiseScale?: number;
  /** Palette green that flat, low rock faces are tinted toward. Unset keeps the plain rock ramp. */
  landGreenColor?: readonly number[];
  /** Optional fields prepared by the benchmark WebGPU experiment. */
  preparedFields?: MountainIllustrationPreparedFields;
}

type Point = { x: number; y: number };

/** Centralized illustrated-mountain material palette. */
export const MOUNTAIN_ILLUSTRATION_PALETTE = {
  ink: [43, 56, 66],
  rockDeep: [61, 72, 80],
  rockShadow: [105, 103, 95],
  rockMid: [157, 143, 119],
  rockLight: [207, 185, 143],
  snowShadow: [153, 181, 202],
  snowMid: [247, 249, 247],
  snowLight: [255, 254, 248],
} as const;

function blendIllustrationColor(
  a: readonly number[],
  b: readonly number[],
  amount: number,
): number[] {
  const t = clamp01(amount);
  return a.map((value, index) => value * (1 - t) + b[index] * t);
}

export interface MountainSnowTransportFields {
  /** Multi-scale DEM roughness; high values provide ledges and pockets. */
  roughness: Float32Array;
  /** Positive shelter/load potential on the lee side of terrain. */
  windShelter: Float32Array;
  /** Combined wind loading after exposure and slope-break weighting. */
  windLoading: Float32Array;
  /** Upwind slope-break signal used to make lee deposits coherent. */
  slopeBreak: Float32Array;
}

const MOUNTAIN_D8_OFFSETS: readonly [number, number][] = [
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

function mountainSnowStep(edge0: number, edge1: number, value: number): number {
  const span = Math.abs(edge1 - edge0) < 1e-6 ? 1e-6 : edge1 - edge0;
  const t = clamp01((value - edge0) / span);
  return t * t * (3 - 2 * t);
}

/**
 * Lookup tables for the fixed-radius samples used by the illustration's
 * raster passes. The normal sampler is intentionally kept for arbitrary path
 * points, while these tables avoid repeating clamp/floor work for every cell
 * in the broad valley, light, and snow-gradient fields.
 */
interface IllustrationAxisLookup {
  lower: Int32Array;
  upper: Int32Array;
  weight: Float64Array;
}

function createIllustrationAxisLookup(
  length: number,
  offset: number,
): IllustrationAxisLookup {
  const lower = new Int32Array(length);
  const upper = new Int32Array(length);
  const weight = new Float64Array(length);
  for (let index = 0; index < length; index++) {
    const coordinate = Math.max(0, Math.min(length - 1, index + offset));
    const base = Math.floor(coordinate);
    lower[index] = base;
    upper[index] = Math.min(length - 1, base + 1);
    weight[index] = coordinate - base;
  }
  return { lower, upper, weight };
}

function createIllustrationAxisLookupFromCoordinates(
  coordinates: ArrayLike<number>,
  length: number,
): IllustrationAxisLookup {
  const lower = new Int32Array(length);
  const upper = new Int32Array(length);
  const weight = new Float64Array(length);
  for (let index = 0; index < length; index++) {
    const coordinate = Math.max(0, Math.min(length - 1, coordinates[index]));
    const base = Math.floor(coordinate);
    lower[index] = base;
    upper[index] = Math.min(length - 1, base + 1);
    weight[index] = coordinate - base;
  }
  return { lower, upper, weight };
}

function sampleIllustrationFieldLookup(
  field: ArrayLike<number>,
  width: number,
  xLookup: IllustrationAxisLookup,
  yLookup: IllustrationAxisLookup,
  x: number,
  y: number,
): number {
  const x0 = xLookup.lower[x];
  const x1 = xLookup.upper[x];
  const y0 = yLookup.lower[y];
  const y1 = yLookup.upper[y];
  const tx = xLookup.weight[x];
  const ty = yLookup.weight[y];
  const row0 = y0 * width;
  const row1 = y1 * width;
  const top = field[row0 + x0] * (1 - tx) + field[row0 + x1] * tx;
  const bottom = field[row1 + x0] * (1 - tx) + field[row1 + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Build the DEM-only snow transport fields used by the illustration layer.
 *
 * This is intentionally a reduced-order version of the terrain predictors
 * used by Winstral et al. (Sx/Sb), Lehning et al. (elevation plus roughness),
 * and the wind-driven cell transport described by Purves et al. It samples
 * terrain in a narrow upwind fan instead of following D8 water drainage:
 * positive upwind horizon angles indicate shelter, while negative angles
 * indicate exposed ridges. The field is smooth at terrain-unit scale so a
 * one-pixel heightmap artifact cannot become a white snow island.
 */
export function buildMountainRoughnessField(
  dem: MountainDEMData,
  normalizedElevation = dem.normalizedElevation,
): Float32Array {
  const { width, height } = dem;
  const total = width * height;
  const cellSizeM = Math.max(1, Math.min(dem.dxMeters, dem.dyMeters));

  // A local standard deviation is a useful DEM proxy for the roughness term
  // in Lehning et al. Use a second, wider smoothing pass to turn pixel-scale
  // noise into a terrain-unit field instead of a salt-and-pepper mask.
  const roughRadius = Math.max(2, Math.min(18, Math.round(85 / cellSizeM)));
  const roughBroadRadius = Math.max(2, Math.min(26, Math.round(180 / cellSizeM)));
  const terrain = normalizedElevation;
  const mean = smoothMountainField(terrain, width, height, roughRadius);
  const squared = new Float32Array(total);
  for (let i = 0; i < total; i++) squared[i] = terrain[i] * terrain[i];
  const meanSquared = smoothMountainField(squared, width, height, roughRadius);
  const roughnessRaw = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const variance = Math.max(0, meanSquared[i] - mean[i] * mean[i]);
    const standardDeviation = Math.sqrt(variance);
    // Around 1% of the DEM range is a gentle surface; 4.5% is visibly rough.
    roughnessRaw[i] = mountainSnowStep(0.008, 0.045, standardDeviation);
  }
  const roughness = smoothMountainField(
    roughnessRaw,
    width,
    height,
    Math.max(1, roughBroadRadius * 0.55),
  );
  return roughness;
}

export interface MountainWindFields {
  windShelter: Float32Array;
  windLoading: Float32Array;
  slopeBreak: Float32Array;
}

export function buildMountainWindFields(
  dem: MountainDEMData,
  windAzimuthDeg: number,
): MountainWindFields {
  const { width, height } = dem;
  const total = width * height;

  const windShelterRaw = new Float32Array(total);
  const windLoadingRaw = new Float32Array(total);
  const slopeBreakRaw = new Float32Array(total);
  const windRad = (windAzimuthDeg * Math.PI) / 180;
  const rayOffsets = [-0.28, -0.14, 0, 0.14, 0.28];
  const distancesM = [35, 65, 105, 160, 250, 380, 560, 780];
  const rays = rayOffsets.flatMap(offset => {
    const rayRad = windRad + offset;
    const directionX = Math.sin(rayRad);
    const directionY = -Math.cos(rayRad);
    return distancesM.map((distanceM, sampleIndex) => ({
      x: directionX * distanceM / Math.max(1, dem.dxMeters),
      y: directionY * distanceM / Math.max(1, dem.dyMeters),
      distanceM,
      inverseDistance: 1 / distanceM,
      sampleIndex,
    }));
  });
  const rayOffsetX = new Int16Array(rays.length);
  const rayOffsetY = new Int16Array(rays.length);
  const rayOffsetsLinear = new Int32Array(rays.length);
  const rayInverseDistance = new Float32Array(rays.length);
  const raySampleIndex = new Uint8Array(rays.length);
  let interiorMinX = 0;
  let interiorMaxX = width - 1;
  let interiorMinY = 0;
  let interiorMaxY = height - 1;
  for (let rayIndex = 0; rayIndex < rays.length; rayIndex++) {
    const ray = rays[rayIndex];
    rayOffsetX[rayIndex] = Math.round(ray.x);
    rayOffsetY[rayIndex] = Math.round(ray.y);
    rayOffsetsLinear[rayIndex] = rayOffsetY[rayIndex] * width + rayOffsetX[rayIndex];
    rayInverseDistance[rayIndex] = ray.inverseDistance;
    raySampleIndex[rayIndex] = ray.sampleIndex;
    interiorMinX = Math.max(interiorMinX, -rayOffsetX[rayIndex]);
    interiorMaxX = Math.min(interiorMaxX, width - 1 - rayOffsetX[rayIndex]);
    interiorMinY = Math.max(interiorMinY, -rayOffsetY[rayIndex]);
    interiorMaxY = Math.min(interiorMaxY, height - 1 - rayOffsetY[rayIndex]);
  }
  const degrees = 180 / Math.PI;

  const evaluatePixel = (x: number, y: number, interior: boolean): void => {
    const index = y * width + x;
    const elevation = dem.elevation[index];
    let maximum = -Infinity;
    let nearMaximum = -Infinity;
    let farMaximum = -Infinity;
    for (let rayIndex = 0; rayIndex < rays.length; rayIndex++) {
      const sampleIndex = interior
        ? index + rayOffsetsLinear[rayIndex]
        : (x + rayOffsetX[rayIndex] >= 0 && y + rayOffsetY[rayIndex] >= 0
          && x + rayOffsetX[rayIndex] < width && y + rayOffsetY[rayIndex] < height
          ? index + rayOffsetsLinear[rayIndex]
          : -1);
      if (sampleIndex < 0) continue;
      const upwindSlope = (dem.elevation[sampleIndex] - elevation) * rayInverseDistance[rayIndex];
      maximum = Math.max(maximum, upwindSlope);
      if (raySampleIndex[rayIndex] <= 3) nearMaximum = Math.max(nearMaximum, upwindSlope);
      else farMaximum = Math.max(farMaximum, upwindSlope);
    }
    if (!Number.isFinite(maximum)) maximum = 0;
    if (!Number.isFinite(nearMaximum)) nearMaximum = maximum;
    if (!Number.isFinite(farMaximum)) farMaximum = maximum;
    const horizonAngle = Math.atan(maximum) * degrees;
    const nearAngle = Math.atan(nearMaximum) * degrees;
    const farAngle = Math.atan(farMaximum) * degrees;
    const shelter = mountainSnowStep(-7, 7, horizonAngle);
    const exposure = mountainSnowStep(-13, -1, horizonAngle);
    const slopeBreak = mountainSnowStep(1.5, 8, nearAngle - farAngle);
    const leeLoading = shelter * (0.72 + 0.28 * slopeBreak);
    windShelterRaw[index] = shelter;
    slopeBreakRaw[index] = slopeBreak;
    windLoadingRaw[index] = clamp01(0.48 + leeLoading * 0.46 - exposure * 0.34);
  };
  if (interiorMinX <= interiorMaxX && interiorMinY <= interiorMaxY) {
    for (let y = interiorMinY; y <= interiorMaxY; y++) {
      for (let x = interiorMinX; x <= interiorMaxX; x++) evaluatePixel(x, y, true);
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= interiorMinX && x <= interiorMaxX && y >= interiorMinY && y <= interiorMaxY) continue;
      evaluatePixel(x, y, false);
    }
  }

  return {
    windShelter: smoothMountainField(windShelterRaw, width, height, 1.8),
    windLoading: smoothMountainField(windLoadingRaw, width, height, 2.2),
    slopeBreak: smoothMountainField(slopeBreakRaw, width, height, 2.2),
  };
}

/** Prepare the native-resolution snow predictors once per export snapshot. */
export function buildMountainSnowTransportFields(
  dem: MountainDEMData,
  windAzimuthDeg: number,
): MountainSnowTransportFields {
  return {
    roughness: buildMountainRoughnessField(dem),
    ...buildMountainWindFields(dem, windAzimuthDeg),
  };
}

/**
 * Establish broad cartographic faces before pigment or ink. A small amount of
 * world-anchored triangulation keeps the illustrated edge language, while the
 * broad and regional fields prevent a regular mesh from becoming the visible
 * mountain structure. Connected crests and downhill ribs are supplied by the
 * pattern stage and are painted separately at their final screen positions.
 */
function buildMountainFaces(field: Float32Array, width: number, height: number,
  scale: number, offsetX: number, offsetY: number,
  fieldSession?: ReturnType<typeof createMountainFieldCacheSession>,
  spacingX = 0,
  spacingY = 0): Float32Array {
  const result = new Float32Array(field.length);
  const broadField = cachedMountainField(
    fieldSession,
    'illustration face broad field',
    [field],
    width,
    height,
    `spacing:${spacingX},${spacingY}:radius:${5 * scale}`,
    () => smoothMountainField(field, width, height, 5 * scale),
  );
  const regionalField = cachedMountainField(
    fieldSession,
    'illustration face regional field',
    [field],
    width,
    height,
    `spacing:${spacingX},${spacingY}:radius:${14 * scale}`,
    () => smoothMountainField(field, width, height, 14 * scale),
  );
  const spacing = 10 * scale;
  const x0Coordinates = new Float64Array(width);
  const x1Coordinates = new Float64Array(width);
  const xWeights = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const globalX = x + offsetX;
    const x0 = Math.floor(globalX / spacing) * spacing;
    x0Coordinates[x] = x0 - offsetX;
    x1Coordinates[x] = x0 + spacing - offsetX;
    xWeights[x] = (globalX - x0) / spacing;
  }
  const y0Coordinates = new Float64Array(height);
  const y1Coordinates = new Float64Array(height);
  const yWeights = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    const globalY = y + offsetY;
    const y0 = Math.floor(globalY / spacing) * spacing;
    y0Coordinates[y] = y0 - offsetY;
    y1Coordinates[y] = y0 + spacing - offsetY;
    yWeights[y] = (globalY - y0) / spacing;
  }
  const x0Lookup = createIllustrationAxisLookupFromCoordinates(x0Coordinates, width);
  const x1Lookup = createIllustrationAxisLookupFromCoordinates(x1Coordinates, width);
  const y0Lookup = createIllustrationAxisLookupFromCoordinates(y0Coordinates, height);
  const y1Lookup = createIllustrationAxisLookupFromCoordinates(y1Coordinates, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = xWeights[x], v = yWeights[y];
    const a = sampleIllustrationFieldLookup(field, width, x0Lookup, y0Lookup, x, y);
    const b = sampleIllustrationFieldLookup(field, width, x1Lookup, y0Lookup, x, y);
    const c = sampleIllustrationFieldLookup(field, width, x0Lookup, y1Lookup, x, y);
    const d = sampleIllustrationFieldLookup(field, width, x1Lookup, y1Lookup, x, y);
    const triangulated = a + d >= b + c
      ? u > v ? a * (1 - u) + b * (u - v) + d * v : a * (1 - v) + c * (v - u) + d * u
      : u + v < 1 ? a * (1 - u - v) + b * u + c * v : b * (1 - v) + c * (1 - u) + d * (u + v - 1);
    const i = y * width + x;
    const broad = broadField[i];
    const regional = regionalField[i];
    // Keep the actual ridge/valley relief, but let it influence the plane only
    // gently. This preserves saddles without turning every local fold into a
    // triangular tower or uniformly smoothed dome.
    // Keep a broad regional plane, but retain enough of the medium-scale
    // relief for the renderer to read separate buttresses and saddles. The
    // small triangulated contribution is deliberately subordinate to the
    // terrain; it breaks up broad domes without exposing a regular mesh.
    const broadFace = broad * 0.68 + regional * 0.32;
    result[i] = broadFace
      + (field[i] - broad) * 0.72
      + (triangulated - broadFace) * 0.20;
  }
  return result;
}

/**
 * Builds the face field used by the illustration support-field preparation.
 * Exporting this narrow CPU step lets the opt-in GPU experiment keep the
 * topology-dependent face construction on the CPU while moving only the
 * separable raster filters to WebGPU.
 */
export function buildMountainIllustrationFaceField(
  field: Float32Array,
  width: number,
  height: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  fieldSession?: ReturnType<typeof createMountainFieldCacheSession>,
  spacingX = 0,
  spacingY = 0,
): Float32Array {
  return buildMountainFaces(
    field,
    width,
    height,
    scale,
    offsetX,
    offsetY,
    fieldSession,
    spacingX,
    spacingY,
  );
}

/**
 * Resolve the face field through the same cache entry used by the painter.
 * GPU preparation and synchronous painting therefore share the expensive
 * topology-dependent CPU work instead of constructing it twice.
 */
export function getMountainIllustrationFaceField(
  dem: MountainDEMData,
  naturalElevation: Float32Array,
  scale: number,
  offsetX: number,
  offsetY: number,
  fieldCache?: MountainFieldCache,
  fieldSessionOverride?: MountainFieldCacheSession,
): Float32Array {
  const fieldSession = fieldSessionOverride ?? createMountainFieldCacheSession(fieldCache);
  const width = dem.width;
  const height = dem.height;
  return cachedMountainField(
    fieldSession,
    'illustration face field',
    [naturalElevation],
    width,
    height,
    `cellSize:${dem.dxMeters},${dem.dyMeters}:scale:${scale}:offset:${offsetX},${offsetY}`,
    () => buildMountainIllustrationFaceField(
      naturalElevation,
      width,
      height,
      scale,
      offsetX,
      offsetY,
      fieldSession,
      dem.dxMeters,
      dem.dyMeters,
    ),
  );
}

export function createMountainIllustrationFieldInputs(
  dem: MountainDEMData,
  pattern: MountainPatternOverlay,
  faceField: Float32Array,
  scale: number,
  offsetX = 0,
  offsetY = 0,
): MountainIllustrationFieldInputs {
  return {
    width: dem.width,
    height: dem.height,
    cellSizeX: dem.dxMeters,
    cellSizeY: dem.dyMeters,
    scale,
    offsetX,
    offsetY,
    faceField,
    reliefElevation: pattern.surfaceElevation ?? dem.elevation,
    ridgeInk: pattern.ridgeInk ?? pattern.ink,
    ink: pattern.ink,
    coverage: pattern.coverage,
    lineworkCoverage: pattern.lineworkCoverage ?? pattern.coverage,
    radii: {
      lighting: 3.5 * scale,
      relief: 13 * scale,
      rib: 3 * scale,
      crease: 4.5 * scale,
      footprint: 1 * scale,
      lineworkFootprint: 1 * scale,
      snowRidge: 5.5 * scale,
    },
  };
}

export function prepareMountainIllustrationFieldsCpuFromInputs(
  inputs: MountainIllustrationFieldInputs,
  fieldSession?: ReturnType<typeof createMountainFieldCacheSession>,
): MountainIllustrationPreparedFields {
  const {
    width,
    height,
    cellSizeX,
    cellSizeY,
    faceField,
    reliefElevation,
    ridgeInk,
    ink,
    coverage,
    lineworkCoverage,
    radii,
  } = inputs;
  const normalized = (source: ArrayLike<number>): Float32Array =>
    Float32Array.from(source, value => value / 255);
  return {
    width,
    height,
    lightingElevation: cachedMountainField(
      fieldSession,
      'illustration lighting elevation',
      [faceField],
      width,
      height,
      `cellSize:${cellSizeX},${cellSizeY}:radius:${radii.lighting}`,
      () => smoothMountainField(faceField, width, height, radii.lighting),
    ),
    reliefReference: cachedMountainField(
      fieldSession,
      'illustration relief reference',
      [reliefElevation],
      width,
      height,
      `cellSize:${cellSizeX},${cellSizeY}:radius:${radii.relief}`,
      () => smoothMountainField(reliefElevation, width, height, radii.relief),
    ),
    ribField: cachedMountainField(
      fieldSession,
      'illustration rib field',
      [ridgeInk],
      width,
      height,
      `cellSize:${cellSizeX},${cellSizeY}:radius:${radii.rib}`,
      () => smoothMountainField(normalized(ridgeInk), width, height, radii.rib),
    ),
    creaseField: cachedMountainField(
      fieldSession,
      'illustration crease field',
      [ink],
      width,
      height,
      `cellSize:${cellSizeX},${cellSizeY}:radius:${radii.crease}`,
      () => smoothMountainField(normalized(ink), width, height, radii.crease),
    ),
    footprint: cachedMountainField(
      fieldSession,
      'illustration footprint field',
      [coverage],
      width,
      height,
      `cellSize:${cellSizeX},${cellSizeY}:radius:${radii.footprint}`,
      () => smoothMountainField(normalized(coverage), width, height, radii.footprint),
    ),
    lineworkFootprint: cachedMountainField(
      fieldSession,
      'illustration linework footprint field',
      [lineworkCoverage],
      width,
      height,
      `cellSize:${cellSizeX},${cellSizeY}:radius:${radii.lineworkFootprint}`,
      () => smoothMountainField(
        normalized(lineworkCoverage),
        width,
        height,
        radii.lineworkFootprint,
      ),
    ),
    snowRidgeField: cachedMountainField(
      fieldSession,
      'illustration snow ridge field',
      [ridgeInk],
      width,
      height,
      `cellSize:${cellSizeX},${cellSizeY}:radius:${radii.snowRidge}`,
      () => smoothMountainField(normalized(ridgeInk), width, height, radii.snowRidge),
    ),
  };
}

/**
 * Prepare the independent support fields used by the mountain painter.
 *
 * This is intentionally the CPU reference implementation. The WebGPU
 * experiment supplies an equivalent object and the painter consumes either
 * object through the same interface.
 */
export function prepareMountainIllustrationFieldsCpu(
  dem: MountainDEMData,
  pattern: MountainPatternOverlay,
  scale: number,
  elevation: Float32Array,
  fieldSession?: ReturnType<typeof createMountainFieldCacheSession>,
  offsetX = 0,
  offsetY = 0,
): MountainIllustrationPreparedFields {
  return prepareMountainIllustrationFieldsCpuFromInputs(
    createMountainIllustrationFieldInputs(dem, pattern, elevation, scale, offsetX, offsetY),
    fieldSession,
  );
}


/** Piecewise straight rock edges. Retain terrain bends without rounding them
 * into splines; all decisions use a bounded neighbourhood for tile stability. */
function angularMountainPath(points: Point[], scale: number, ox: number, oy: number): Point[] {
  if (points.length < 4) return points;
  const result: Point[] = [points[0]];
  const cellX = (p: Point) => Math.floor((p.x + ox) / (8 * scale));
  const cellY = (p: Point) => Math.floor((p.y + oy) / (8 * scale));
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], p = points[i], b = points[i + 1];
    const bend = ((p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y))
      / Math.max(1e-6, Math.hypot(p.x - a.x, p.y - a.y) * Math.hypot(b.x - p.x, b.y - p.y));
    if (cellX(a) !== cellX(b) || cellY(a) !== cellY(b) || bend < 0.92) result.push(p);
  }
  result.push(points[points.length - 1]);
  return result;
}

/** Kept as a compatibility name for review helpers. It now only retains
 * bends that are already present in the terrain path; no synthetic offsets. */
export function fractureMountainPath(points: Point[], scale: number, ox: number, oy: number, _key: number): Point[] {
  return angularMountainPath(points, scale, ox, oy);
}

/** Join nearby, facing crest ends only. Mutual nearest choices prevent fans
 * of connectors where several mountain spurs meet. */
export function connectMountainCrests(paths: Point[][], scale: number): Point[][] {
  const ends = paths.flatMap((points, path) => points.length < 2 ? [] : [
    { path, point: points[0], inside: points[Math.min(4, points.length - 1)] },
    { path, point: points[points.length - 1], inside: points[Math.max(0, points.length - 5)] },
  ]);
  const nearest = new Int32Array(ends.length).fill(-1);
  const maximumGap = 12 * scale;
  const cellSize = Math.max(1, maximumGap);
  const cellX = (point: Point) => Math.floor(point.x / cellSize);
  const cellY = (point: Point) => Math.floor(point.y / cellSize);
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < ends.length; index++) {
    const end = ends[index];
    const key = `${cellX(end.point)},${cellY(end.point)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  }
  for (let i = 0; i < ends.length; i++) {
    const a = ends[i];
    let best = maximumGap;
    const candidates: number[] = [];
    const cx = cellX(a.point), cy = cellY(a.point);
    for (let by = cy - 1; by <= cy + 1; by++) {
      for (let bx = cx - 1; bx <= cx + 1; bx++) {
        const bucket = buckets.get(`${bx},${by}`);
        if (bucket) {
          // Keep candidate collection iterative: a dense high-resolution
          // export can make one spatial bucket larger than the call stack's
          // supported argument count.
          for (const candidate of bucket) candidates.push(candidate);
        }
      }
    }
    // The old implementation visited every endpoint by ascending index. Keep
    // that order inside the bounded candidate set so equal-distance ties and
    // mutual-nearest decisions remain byte-equivalent.
    candidates.sort((left, right) => left - right);
    for (const j of candidates) {
      const b = ends[j];
      if (a.path === b.path) continue;
      const dx = b.point.x - a.point.x, dy = b.point.y - a.point.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 0.5 * scale || distance >= best) continue;
      const ax = a.point.x - a.inside.x, ay = a.point.y - a.inside.y;
      const bx = b.point.x - b.inside.x, by = b.point.y - b.inside.y;
      if ((ax * dx + ay * dy) / Math.max(1e-6, Math.hypot(ax, ay) * distance) < 0.5
        || -(bx * dx + by * dy) / Math.max(1e-6, Math.hypot(bx, by) * distance) < 0.5) continue;
      nearest[i] = j; best = distance;
    }
  }
  return ends.flatMap((a, i) => {
    const j = nearest[i];
    return j > i && nearest[j] === i ? [[a.point, ends[j].point]] : [];
  });
}

/** Paint one small charcoal stipple at a projected lower-face position. */
function paintMountainDot(
  alpha: Uint8Array, clip: Uint8Array, width: number, height: number,
  point: Point, radius: number, opacity: number,
): void {
  if (radius <= 0 || opacity <= 0) return;
  const left = Math.max(0, Math.floor(point.x - radius - 1));
  const right = Math.min(width - 1, Math.ceil(point.x + radius + 1));
  const top = Math.max(0, Math.floor(point.y - radius - 1));
  const bottom = Math.min(height - 1, Math.ceil(point.y + radius + 1));
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const index = y * width + x;
    if (!clip[index]) continue;
    const coverage = clamp01(radius + 0.65 - Math.hypot(x - point.x, y - point.y));
    alpha[index] = Math.max(alpha[index], Math.round(coverage * opacity * 255));
  }
}

/** Rasterize a complete screen-space chain, with one pressure envelope per
 * charcoal run. Silhouettes use a solid antialiased pen; charcoal uses tooth. */
function paintMountainChain(
  alpha: Uint8Array, clip: Uint8Array, width: number, height: number,
  points: Point[], radius: number, opacity: number, key: number,
  charcoal: boolean, options: MountainIllustrationOptions,
  taperStart = false, taperEnd = false,
  interior?: Float32Array,
  radiusScaleAt?: (point: Point) => number,
  solidCore = false,
  oceanCharcoal = false,
  batchedSegments?: BatchedInkSegment[],
): boolean {
  if (radius <= 0 || opacity <= 0 || points.length < 2) return false;
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1]
    + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const total = distances[distances.length - 1];
  if (total < (charcoal ? 14 : 10) * options.scale) return false;
  const interruption = charcoal && oceanCharcoal
    ? createCharcoalInterruptionPattern(key, options.scale,
      { breakProbability: 0.15, dashMin: 20, dashMax: 48, gapMin: 2.4, gapMax: 4.6 })
    : undefined;
  const runs = charcoal && !oceanCharcoal ? createCharcoalStrokeRuns(total, key, options.scale,
    { breakProbability: 0.9, dashMin: 8, dashMax: 22, gapMin: 2, gapMax: 4 }) : [{ start: 0, end: total }];
  // The deep-ocean brush uses a slightly wider 0.85px base pen than the
  // legacy mountain ridge width (0.8 x the default 0.75 ridge control).
  // Normalize only the primary charcoal pass so the ridge control still
  // scales the pen, while its default appearance matches ocean ink.
  const brushRadius = oceanCharcoal
    ? Math.max(0.35 * options.scale, radius * 1.4)
    : radius;
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1], end = points[i];
    const length = distances[i] - distances[i - 1];
    if (length < 1e-6) continue;
    for (const run of runs) {
      const from = Math.max(run.start, distances[i - 1]), to = Math.min(run.end, distances[i]);
      if (to <= from) continue;
      if (interruption && !isCharcoalInkActiveAtDistance((from + to) * 0.5, interruption)) continue;
      const a = (from - distances[i - 1]) / length, b = (to - distances[i - 1]) / length;
      let x0 = start.x + (end.x - start.x) * a, y0 = start.y + (end.y - start.y) * a;
      let x1 = start.x + (end.x - start.x) * b, y1 = start.y + (end.y - start.y) * b;
      if (charcoal) {
        const edge = interior ? sampleScalarField(interior, width, height, (x0 + x1) / 2, (y0 + y1) / 2) : 1;
        const edgeKey = Math.imul(Math.floor((x0 + options.offsetX) / (8 * options.scale)), 73856093)
          ^ Math.imul(Math.floor((y0 + options.offsetY) / (8 * options.scale)), 19349663) ^ key;
        if (hash01(edgeKey, 941) > 0.08 + 0.92 * edge * edge) continue;
        if (edge < 0.35) {
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          x0 = cx; y0 = cy; x1 = cx + 0.15 * options.scale; y1 = cy;
        }
        const pressureKey = Math.imul(Math.floor((x0 + options.offsetX) / (8 * options.scale)), 73856093)
          ^ Math.imul(Math.floor((y0 + options.offsetY) / (8 * options.scale)), 19349663) ^ key;
        const pressure = oceanCharcoal
          ? 0.85 + hash01(pressureKey, 169) * 0.3
          : 0.7 + hash01(pressureKey, 911) * 0.65;
        const midpoint = (from + to) * 0.5;
        const taper = Math.min(
          taperStart ? clamp01(midpoint / (14 * options.scale)) : 1,
          taperEnd ? clamp01((total - midpoint) / (14 * options.scale)) : 1,
        );
        if (taper <= 0) continue;
        const segment: BatchedInkSegment = {
          x0,
          y0,
          x1,
          y1,
          radius: brushRadius * pressure * taper,
          seed: key,
          smoothing: oceanCharcoal ? 1 : 2,
          strokeT0: (from - run.start) / (run.end - run.start),
          strokeT1: (to - run.start) / (run.end - run.start),
          taperStart: oceanCharcoal ? taperStart : true,
          taperEnd: oceanCharcoal ? taperEnd : true,
          coordinateOffsetX: options.offsetX,
          coordinateOffsetY: options.offsetY,
          coordinateStride: options.stride,
          opacity,
          drySkipProbability: oceanCharcoal ? 0.05 : (solidCore ? 0 : 0.01),
          clipStartCap: false,
          clipEndCap: oceanCharcoal,
          solidCore,
        };
        if (batchedSegments) batchedSegments.push(segment);
        else {
          paintInkSegment(alpha, clip, width, height,
            segment.x0, segment.y0, segment.x1, segment.y1,
            segment.radius, segment.seed, segment.smoothing,
            segment.strokeT0, segment.strokeT1,
            segment.taperStart, segment.taperEnd,
            segment.coordinateOffsetX, segment.coordinateOffsetY,
            segment.coordinateStride, segment.opacity,
            segment.drySkipProbability, segment.clipStartCap,
            segment.clipEndCap, segment.solidCore);
        }
      } else {
        const dx = x1 - x0, dy = y1 - y0, square = dx * dx + dy * dy;
        const startScale = Math.max(0.01, radiusScaleAt?.(start) ?? 1);
        const endScale = Math.max(0.01, radiusScaleAt?.(end) ?? 1);
        const maxRadius = radius * Math.max(startScale, endScale);
        for (let y = Math.max(0, Math.floor(Math.min(y0, y1) - maxRadius - 1)); y <= Math.min(height - 1, Math.ceil(Math.max(y0, y1) + maxRadius + 1)); y++) {
          for (let x = Math.max(0, Math.floor(Math.min(x0, x1) - maxRadius - 1)); x <= Math.min(width - 1, Math.ceil(Math.max(x0, x1) + maxRadius + 1)); x++) {
            const index = y * width + x;
            if (!clip[index]) continue;
            const t = clamp01(((x - x0) * dx + (y - y0) * dy) / Math.max(1e-8, square));
            const pathT = a + (b - a) * t;
            const localRadius = radius * (startScale * (1 - pathT) + endScale * pathT);
            const distance = from + (to - from) * t;
            const taper = Math.min(taperStart ? clamp01(distance / (14 * options.scale)) : 1,
              taperEnd ? clamp01((total - distance) / (14 * options.scale)) : 1);
            const coverage = clamp01(localRadius * taper + 0.65 - Math.hypot(x - x0 - t * dx, y - y0 - t * dy)) * Math.min(1, taper * 4);
            alpha[index] = Math.max(alpha[index], Math.round(coverage * opacity * 255));
          }
        }
      }
    }
  }
  return true;
}

/** A shallow oblique terrain surface, keeping the range's real XY footprint.
 * Columns are painted from far to near. Folding projected rows form cliffs
 * and occluding crests, rather than treating snow boundaries as silhouettes.
 */
export function renderMountainIllustration(
  dem: MountainDEMData, pattern: MountainPatternOverlay,
  shadow: Float32Array, options: MountainIllustrationOptions,
  profiler?: MountainProfiler,
  fieldCache?: MountainFieldCache,
  fieldSessionOverride?: MountainFieldCacheSession,
): MountainIllustration {
  return renderMountainIllustrationInternal(
    dem, pattern, shadow, options, profiler, fieldCache, fieldSessionOverride, false,
  ) as MountainIllustration;
}

/** Camera export variant: retain material and linework layers, omit the final
 * full illustration image that the camera texture path does not consume. */
export function renderMountainCameraIllustration(
  dem: MountainDEMData, pattern: MountainPatternOverlay,
  shadow: Float32Array, options: MountainIllustrationOptions,
  profiler?: MountainProfiler,
  fieldCache?: MountainFieldCache,
  fieldSessionOverride?: MountainFieldCacheSession,
  onStage?: (stage: 'terrain fields' | 'lighting and snow' | 'projection and material' | 'stroke painting') => void,
): MountainCameraIllustrationLayers {
  return renderMountainIllustrationInternal(
    dem, pattern, shadow, options, profiler, fieldCache, fieldSessionOverride, true, onStage,
  ) as MountainCameraIllustrationLayers;
}

function renderMountainIllustrationInternal(
  dem: MountainDEMData, pattern: MountainPatternOverlay,
  shadow: Float32Array, options: MountainIllustrationOptions,
  profiler?: MountainProfiler,
  fieldCache?: MountainFieldCache,
  fieldSessionOverride?: MountainFieldCacheSession,
  cameraLayersOnly = false,
  onStage?: (stage: 'terrain fields' | 'lighting and snow' | 'projection and material' | 'stroke painting') => void,
): MountainIllustration | MountainCameraIllustrationLayers {
  const { width, height } = dem;
  const fieldSession = fieldSessionOverride ?? createMountainFieldCacheSession(fieldCache);
  const illustrationStop = profiler?.begin('mountain illustration total');
  const scale = Math.max(0.25, options.scale);
  // The primary crest is the map's structural pen. Its actual default control
  // value is 0.75, while its terrain-relative line scale grows linearly from
  // 1x at the bottom of the terrain to 2x at the top.
  const userMainRidgeThickness = Math.max(MIN_POSITIVE_SCALE, options.mainRidgeThickness ?? 0.75);
  const mainRidgeThickness = userMainRidgeThickness;
  const ridgeStrokeThickness = Math.max(0,
    options.ridgeStrokeThickness ?? options.strokeThickness * mainRidgeThickness);
  const projection = normalizeMountainProjectionSettings(
    options.mountainViewAngleDeg,
    options.mountainHeightExaggeration,
  );
  const snowfall = normalizeMountainSnowfallSettings(
    options.snowfallAmount,
    options.snowfallDrift,
    options.snowfallPersistence,
    options.snowRedistributionSteps,
  );
  // Direct illustration callers retain the painterly continuous default;
  // the production stage supplies the flatter two-tone default explicitly.
  const lightingMode = options.lightingMode ?? 'continuous';
  const hillshadeStrength = clamp01(options.hillshadeStrength ?? 1);
  const naturalElevation = pattern.surfaceElevation ?? dem.elevation;
  // Export tiles may carry the full DEM metadata while their per-cell
  // normalized array is absent or still points at the uncropped source. The
  // physical elevation is the authoritative, world-aligned value for all
  // local material fields, so derive the normalized helper here.
  const elevationRange = Math.max(1, dem.maxElevationM - dem.minElevationM);
  // Physical elevation is the shared source of truth for both full renders
  // and cropped export tiles. Re-deriving this helper avoids a one-byte
  // shading seam when a full DEM's precomputed normalization used a slightly
  // different floating-point path than a cropped tile.
  const normalizedElevation = new Float32Array(width * height);
  for (let index = 0; index < normalizedElevation.length; index++) {
    normalizedElevation[index] = clamp01(
      (dem.elevation[index] - dem.minElevationM) / elevationRange,
    );
  }
  // Some export callers keep auxiliary DEM fields at the source stride while
  // cropping only the fields needed by the pattern pass. Resolve those
  // arrays into the current tile using the world offset; this keeps snow and
  // lighting decisions tied to the same physical cell as the projected face.
  const localizeField = (field: ArrayLike<number>): ArrayLike<number> => {
    if (field.length === width * height) return field;
    const result = new Float32Array(width * height);
    const sourceStride = Math.max(width, options.stride);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sourceX = x + options.offsetX;
      const sourceY = y + options.offsetY;
      const sourceIndex = sourceY * sourceStride + sourceX;
      const localIndex = y * width + x;
      result[localIndex] = sourceX >= 0 && sourceY >= 0
        && sourceX < sourceStride && sourceIndex >= 0 && sourceIndex < field.length
        ? field[sourceIndex]
        : field[localIndex] ?? 0;
    }
    return result;
  };
  const precipitation = localizeField(dem.precipitationMmYr);
  const aspect = localizeField(dem.aspectDeg);
  const solarInsolation = localizeField(dem.solarInsolation);
  const landGreen = options.landGreenColor
    ? [options.landGreenColor[0], options.landGreenColor[1], options.landGreenColor[2]] as TintRGB
    : undefined;
  const tpi = landGreen && dem.tpi ? localizeField(dem.tpi) : undefined;
  const flowDirection = localizeField(dem.flowDirection);
  // The painter queries the same water predicate in the snow, redistribution,
  // and projection passes. Resolve it once so those hot loops do not repeat
  // optional-array/property lookups for every cell.
  const waterMask = new Uint8Array(width * height);
  for (let index = 0; index < waterMask.length; index++) {
    waterMask[index] = dem.isOcean[index] > 0
      || dem.isRiverChannel[index] > 0
      || (dem.visualWaterMask?.[index] ?? 0) > 0
      || dem.biomeType[index] === 6
      || dem.biomeType[index] === 8
      ? 1
      : 0;
  }
  const isWaterCell = (index: number): boolean => waterMask[index] !== 0;
  const naturalSample = (x: number, y: number) => sampleScalarField(naturalElevation, width, height, x, y);
  const foregroundOcclusionThreshold = Math.max(
    120,
    (dem.maxElevationM - dem.minElevationM) * 0.05,
  );
  const isRidgeBehindForeground = (point: Point): boolean => {
    const sourceHeight = naturalSample(point.x, point.y);
    const lookAhead = Math.max(4, Math.ceil(12 * scale));
    for (let step = 1; step <= lookAhead; step++) {
      if (naturalSample(point.x, point.y + step) - sourceHeight
        > foregroundOcclusionThreshold) return true;
    }
    return false;
  };
  onStage?.('terrain fields');
  const faceSupportStop = profiler?.begin('mountain illustration face/support fields');
  const faceSupportMisses = fieldSession?.misses ?? 0;
  const elevation = getMountainIllustrationFaceField(
    dem,
    naturalElevation,
    scale,
    options.offsetX,
    options.offsetY,
    fieldCache,
    fieldSession,
  );
  // Keep enough of the triangulated face structure in the lighting field to
  // distinguish neighbouring sun-facing planes. The previous broad blur made
  // most of the bright side share one normal, so its snow collapsed to a
  // single pale tone even while the shaded side retained visible variation.
  const preparedFields = isMountainIllustrationPreparedFieldsCompatible(
    options.preparedFields,
    width,
    height,
  )
    ? options.preparedFields
    : prepareMountainIllustrationFieldsCpu(
        dem,
        pattern,
         scale,
         elevation,
         fieldSession,
         options.offsetX,
         options.offsetY,
       );
  const lightingElevation = preparedFields.lightingElevation;
  const zeroXLookup = createIllustrationAxisLookup(width, 0);
  const zeroYLookup = createIllustrationAxisLookup(height, 0);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const sourceY = new Float32Array(width * height).fill(-1);
  const lineworkClip = new Uint8Array(width * height);
  const material = new Float32Array(width * height * 3);
  const projectedMaterial = new Float32Array(width * height * 3);
  const lift = new Float32Array(width * height);
  // A broad topographic-position field adds a restrained ridge/valley bias to
  // the pigment. Directional light alone can be almost constant across a
  // windward snow face, while this signed field keeps its local planes legible
  // without affecting a genuinely flat snowfield.
  const reliefReference = preparedFields.reliefReference;
  const reliefScale = Math.max(60, Math.min(360,
    (dem.maxElevationM - dem.minElevationM) * 0.045));
  const ribField = preparedFields.ribField;
  const creaseField = preparedFields.creaseField;
  // Keep the heightmap-driven rock edge crisp enough to meet the surrounding
  // biome cleanly; the paper wash still supplies the softer interior texture.
  const footprint = preparedFields.footprint;
  const lineworkFootprint = preparedFields.lineworkFootprint;
  const snowRidgeField = preparedFields.snowRidgeField;
  if (fieldSession && profiler) {
    profiler.recordCache('mountain illustration terrain fields', fieldSession.misses === faceSupportMisses);
  }
  faceSupportStop?.();
  const windAzimuthDeg = ((options.windAzimuthDeg ?? 225) % 360 + 360) % 360;
  const roughnessStop = options.snowTransportOverride
    ? undefined
    : profiler?.begin('mountain illustration snow roughness');
  const roughnessMisses = fieldSession?.misses ?? 0;
  const roughness = options.snowTransportOverride?.roughness ?? cachedMountainField(
      fieldSession,
      'illustration snow roughness',
      [dem.elevation],
      width,
      height,
      `cellSize:${dem.dxMeters},${dem.dyMeters}`,
      () => buildMountainRoughnessField(dem, normalizedElevation),
    );
  if (profiler) {
    profiler.recordCache(
      'mountain illustration snow roughness',
      Boolean(options.snowTransportOverride) || (fieldSession !== undefined && fieldSession.misses === roughnessMisses),
    );
  }
  roughnessStop?.();
  const windStop = options.snowTransportOverride || options.windFieldsOverride
    ? undefined
    : profiler?.begin('mountain illustration wind shelter');
  const windMisses = fieldSession?.misses ?? 0;
  const windFields = options.snowTransportOverride ?? options.windFieldsOverride ?? cachedMountainField<MountainWindFields>(
    fieldSession,
    'illustration wind shelter',
    [dem.elevation],
    width,
    height,
    `wind:${windAzimuthDeg}:cellSize:${dem.dxMeters},${dem.dyMeters}`,
    () => buildMountainWindFields(dem, windAzimuthDeg),
  );
  if (profiler) {
    profiler.recordCache(
      'mountain illustration wind shelter',
      Boolean(options.snowTransportOverride || options.windFieldsOverride)
        || (fieldSession !== undefined && fieldSession.misses === windMisses),
    );
  }
  windStop?.();
  const snowTransport: MountainSnowTransportFields = options.snowTransportOverride ?? {
    roughness,
    ...windFields,
  };
  onStage?.('lighting and snow');
  const initialSnowStop = profiler?.begin('mountain illustration lighting and initial snow');
  // The temperature field supplies the broad snowline. A small elevation term
  // keeps the uppermost terrain cold in stylized DEMs whose lapse-rate field
  // is shallow, while the smoothing pass prevents a hard contour boundary.
  const snowlineRaw = new Float32Array(width * height);
  for (let i = 0; i < snowlineRaw.length; i++) {
    if (isWaterCell(i)) continue;
    const temperatureSnow = mountainSnowStep(5, -8, dem.temperatureC[i]);
    const elevationSnow = mountainSnowStep(0.46, 0.86, normalizedElevation[i]);
    snowlineRaw[i] = temperatureSnow * 0.86 + elevationSnow * 0.14;
  }
  const snowlineField = smoothMountainField(
    snowlineRaw,
    width,
    height,
    Math.max(1.25, 2.5 * scale),
  );
  // Material edge softness belongs to the material footprint. The separate
  // linework clip below controls ink visibility, so a structural stroke can
  // still exist over a zero-material face without turning that face into rock
  // or snow fill.
  const edgeDistance = new Float32Array(pattern.coverage.length);
  const initialEdgeDistance = 32 * scale;
  for (let index = 0; index < edgeDistance.length; index++) {
    edgeDistance[index] = pattern.coverage[index] === 0
      ? 0
      : initialEdgeDistance;
  }
  for (let pass = 0; pass < 2; pass++) {
    const direction = pass === 0 ? 1 : -1;
    for (let y = pass === 0 ? 0 : height - 1; y >= 0 && y < height; y += direction) {
      const row = y * width;
      const previousRow = (y - direction) * width;
      for (let x = pass === 0 ? 0 : width - 1; x >= 0 && x < width; x += direction) {
        const i = row + x, px = x - direction, py = y - direction;
        if (px >= 0 && px < width) edgeDistance[i] = Math.min(edgeDistance[i], edgeDistance[row + px] + 1);
        if (py >= 0 && py < height) {
          edgeDistance[i] = Math.min(edgeDistance[i], edgeDistance[previousRow + x] + 1);
          if (x > 0) edgeDistance[i] = Math.min(edgeDistance[i], edgeDistance[previousRow + x - 1] + Math.SQRT2);
          if (x + 1 < width) edgeDistance[i] = Math.min(edgeDistance[i], edgeDistance[previousRow + x + 1] + Math.SQRT2);
        }
      }
    }
  }
  const azimuth = options.sunAzimuthDeg * Math.PI / 180;
  const altitude = options.sunAltitudeDeg * Math.PI / 180;
  const sunX = Math.sin(azimuth) * Math.cos(altitude);
  const sunY = -Math.cos(azimuth) * Math.cos(altitude);
  const sunZ = Math.sin(altitude);
  // A straight-down view (camera exports) has no lift, so the valley anchor
  // and water clearance that only bound the lift are skipped entirely.
  const liftEnabled = mountainProjectionLiftCoefficient(
    projection.viewAngleDeg,
    projection.heightExaggeration,
  ) > 0;
  let base: Float32Array | undefined;
  let waterClearance: Float32Array | undefined;
  if (liftEnabled) {
    const valleyRadius = Math.min(160 * scale, 1200 / dem.dyMeters);
    const valleyFloor = new Float32Array(width * height);
    const valleyXMinusLookup = createIllustrationAxisLookup(width, -valleyRadius);
    const valleyXPlusLookup = createIllustrationAxisLookup(width, valleyRadius);
    const valleyYMinusLookup = createIllustrationAxisLookup(height, -valleyRadius);
    const valleyYPlusLookup = createIllustrationAxisLookup(height, valleyRadius);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      valleyFloor[y * width + x] = Math.min(
        sampleIllustrationFieldLookup(elevation, width, valleyXMinusLookup, zeroYLookup, x, y),
        sampleIllustrationFieldLookup(elevation, width, valleyXPlusLookup, zeroYLookup, x, y),
        sampleIllustrationFieldLookup(elevation, width, zeroXLookup, valleyYMinusLookup, x, y),
        sampleIllustrationFieldLookup(elevation, width, zeroXLookup, valleyYPlusLookup, x, y),
      );
    }
    // The base of a face varies slowly. An unsmoothed directional minimum
    // creates narrow towers where the nearest valley switches direction.
    base = smoothMountainField(valleyFloor, width, height, 8 * scale);
    waterClearance = new Float32Array(width * height);
    for (let x = 0; x < width; x++) {
      let lastWater = -Infinity;
      for (let y = 0; y < height; y++) {
        const i = y * width + x;
        if (isWaterCell(i)) lastWater = y;
        waterClearance[i] = Math.max(0, y - lastWater - 4 * scale);
      }
    }
  }
  // Compact gravity pass inputs. The first pass computes a local snow mass;
  // the short redistribution pass below moves only steep-slope excess.
  const snowMass = new Float32Array(width * height);
  const snowHoldingCapacity = new Float32Array(width * height);
  const snowSampleRadius = 4 * scale;
  const broadLightRadius = 14 * scale;
  const faceLightRadius = 4 * scale;
  const broadLightDenominator = 2 * broadLightRadius * dem.dxMeters;
  const broadLightVerticalDenominator = 2 * broadLightRadius * dem.dyMeters;
  const faceLightDenominator = 2 * faceLightRadius * dem.dxMeters;
  const faceLightVerticalDenominator = 2 * faceLightRadius * dem.dyMeters;
  const broadXMinusLookup = createIllustrationAxisLookup(width, -broadLightRadius);
  const broadXPlusLookup = createIllustrationAxisLookup(width, broadLightRadius);
  const broadYMinusLookup = createIllustrationAxisLookup(height, -broadLightRadius);
  const broadYPlusLookup = createIllustrationAxisLookup(height, broadLightRadius);
  const faceXMinusLookup = createIllustrationAxisLookup(width, -faceLightRadius);
  const faceXPlusLookup = createIllustrationAxisLookup(width, faceLightRadius);
  const faceYMinusLookup = createIllustrationAxisLookup(height, -faceLightRadius);
  const faceYPlusLookup = createIllustrationAxisLookup(height, faceLightRadius);
  const snowXMinusLookup = createIllustrationAxisLookup(width, -snowSampleRadius);
  const snowXPlusLookup = createIllustrationAxisLookup(width, snowSampleRadius);
  const snowYMinusLookup = createIllustrationAxisLookup(height, -snowSampleRadius);
  const snowYPlusLookup = createIllustrationAxisLookup(height, snowSampleRadius);
  // These values are only used by the material loop below. Keeping the
  // world-coordinate divisions out of that 2.3M-cell pass reduces scalar
  // arithmetic while preserving the original operation order and values.
  const materialWorldX = new Float64Array(width);
  const materialWorldY = new Float64Array(height);
  const materialStride = options.stride;
  for (let x = 0; x < width; x++) {
    materialWorldX[x] = x + options.offsetX;
  }
  for (let y = 0; y < height; y++) {
    materialWorldY[y] = y + options.offsetY;
  }

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    // Local relief anchors each range to its surrounding valleys. The lift is
    // explicit cot(view angle) × height exaggeration, then bounded so exports
    // can include every occluder in a fixed-size halo.
    // Empty cells are skipped by projection entirely. Avoid calculating a
    // lift for them, while retaining the lift for linework-only support so
    // ridge ink keeps the same projected placement at a fading edge.
    if (!footprint[i] && !lineworkFootprint[i]) {
      lift[i] = 0;
      continue;
    }
    // Anchor each face to its drainage corridor. A face may rise within its
    // land footprint, but cannot leap across a river and leave it on a crest.
    lift[i] = base && waterClearance
      ? mountainProjectionLift(
          Math.max(0, elevation[i] - base[i]),
          dem.dyMeters,
          waterClearance[i],
          scale,
          projection,
        )
      : 0;
    if (!footprint[i]) continue;
    // Stronger face modelling than the diffuse top-down relief. Broad and
    // local normals establish the planes; pigment gently breaks up each one.
    // Keep a broad light for the range's overall direction, then mix in the
    // normal of the local coarse face. Sampling only the broad field averaged
    // neighbouring planes into one normal, which is especially destructive
    // once the snow material is applied on the illuminated side.
    const broadGX = (
      sampleIllustrationFieldLookup(lightingElevation, width, broadXPlusLookup, zeroYLookup, x, y)
      - sampleIllustrationFieldLookup(lightingElevation, width, broadXMinusLookup, zeroYLookup, x, y)
    )
      / broadLightDenominator;
    const broadGY = (
      sampleIllustrationFieldLookup(lightingElevation, width, zeroXLookup, broadYPlusLookup, x, y)
      - sampleIllustrationFieldLookup(lightingElevation, width, zeroXLookup, broadYMinusLookup, x, y)
    )
      / broadLightVerticalDenominator;
    const broadNX = -broadGX * 4.5;
    const broadNY = -broadGY * 4.5;
    // Snow shedding remains based on the broad physical face, so the extra
    // local lighting detail does not turn every small facet into a separate
    // snow boundary.
    const broadLight = clamp01(
      (broadNX * sunX + broadNY * sunY + sunZ)
        / Math.sqrt(broadNX * broadNX + broadNY * broadNY + 1),
    );
    const faceGX = (
      sampleIllustrationFieldLookup(elevation, width, faceXPlusLookup, zeroYLookup, x, y)
      - sampleIllustrationFieldLookup(elevation, width, faceXMinusLookup, zeroYLookup, x, y)
    )
      / faceLightDenominator;
    const faceGY = (
      sampleIllustrationFieldLookup(elevation, width, zeroXLookup, faceYPlusLookup, x, y)
      - sampleIllustrationFieldLookup(elevation, width, zeroXLookup, faceYMinusLookup, x, y)
    )
      / faceLightVerticalDenominator;
    const faceNX = -faceGX * 5.5;
    const faceNY = -faceGY * 5.5;
    const faceLight = clamp01(
      (faceNX * sunX + faceNY * sunY + sunZ)
        / Math.sqrt(faceNX * faceNX + faceNY * faceNY + 1),
    );
    const light = clamp01(broadLight * 0.25 + faceLight * 0.75);
    const pigment = pattern.wash[i];
    // Snow drapes across shoulders and hollows while near-vertical rock ribs
    // remain exposed. It shades blue in recesses and white along sunlit crests.
    // Snow accumulation follows the natural hollows, not the triangulation:
    // mesh diagonals must never become artificial white patches.
    const snowGX = (
      sampleIllustrationFieldLookup(naturalElevation, width, snowXPlusLookup, zeroYLookup, x, y)
      - sampleIllustrationFieldLookup(naturalElevation, width, snowXMinusLookup, zeroYLookup, x, y)
    );
    const snowGY = (
      sampleIllustrationFieldLookup(naturalElevation, width, zeroXLookup, snowYPlusLookup, x, y)
      - sampleIllustrationFieldLookup(naturalElevation, width, zeroXLookup, snowYMinusLookup, x, y)
    );
    const gradient = Math.sqrt(snowGX * snowGX + snowGY * snowGY);
    const tx = gradient > 1e-5 ? -snowGY / gradient : 1;
    const ty = gradient > 1e-5 ? snowGX / gradient : 0;
    const shoulder = (naturalSample(x + tx * 12 * scale, y + ty * 12 * scale)
      + naturalSample(x - tx * 12 * scale, y - ty * 12 * scale)) / 2;
    const gully = clamp01((shoulder - naturalElevation[i] + 8) / 70);
    const snowline = snowlineField[i];
    const precipitationFactor = clamp01(
      (precipitation[i] - 450) / 1800,
    );
    const precipitationRetention = 0.9 + precipitationFactor * 0.12;
    const baseSnow = snowline * snowfall.amount * precipitationRetention;
    // Wind loading is a directional DEM field. Persistence raises the amount
    // left in sheltered terrain but cannot manufacture snow below the line.
    const windLoad = clamp01(
      snowTransport.windLoading[i]
        + (snowfall.drift - 1) * 0.18 * snowTransport.windShelter[i],
    );
    const windRetention = clamp01(
      0.36 + windLoad * 0.56
        + snowTransport.windShelter[i] * 0.1 * snowfall.persistence,
    );
    // Rough ledges provide small pockets for snow, so roughness raises the
    // available local mass. The final clamp keeps this as a modest loading
    // effect rather than allowing a single cell to manufacture a drift.
    const roughRetention = 1 + snowTransport.roughness[i]
      * (0.08 + snowTransport.windShelter[i] * 0.04);
    const steepAvalanchePenalty = mountainSnowStep(30, 64, dem.slopeDeg[i]);
    const slopeRetention = 1 - steepAvalanchePenalty * 0.38;
    const aspectRad = (aspect[i] * Math.PI) / 180;
    const slopeSin = Math.sin((dem.slopeDeg[i] * Math.PI) / 180);
    const sunFacing = Math.max(0, Math.cos(aspectRad - azimuth));
    const directSolarExposure = clamp01(0.35 + sunFacing * slopeSin * 0.65);
    const solarExposure = clamp01(
      directSolarExposure * 0.65 + clamp01(solarInsolation[i]) * 0.35,
    );
    const solarRetention = 1 - solarExposure * 0.16;
    const gullyRetention = 1 + gully * 0.18 + snowTransport.slopeBreak[i] * 0.08;
    // Keep the broad field continuous while allowing the existing pattern
    // overlay to seed a few structural snow bands at the painted ridges.
    const structuralAnchor = clamp01(
      pattern.snow[i] * 0.18 + snowRidgeField[i] * 0.12,
    );
    const snowDrift = clamp01(0.94 + pattern.wash[i] * 0.06);
    // Keep incoming snow in the mass field. Slope shedding belongs in the
    // holding capacity and buffered gravity pass below; multiplying it out
    // here would delete the excess that should reach a gully.
    const snowAmount = clamp01(
      baseSnow
        * windRetention
        * roughRetention
        * solarRetention
        * gullyRetention
        * snowDrift
        + structuralAnchor * snowfall.amount * 0.12,
    );
    snowMass[i] = snowAmount;
    // Above roughly 38° a portion of the snow is mobile. Rough ledges and
    // sheltered faces retain a little more, with a non-zero floor even on
    // near-vertical rock instead of an artificial hard cutoff.
    const mobileSlope = mountainSnowStep(38, 64, dem.slopeDeg[i]);
    const slopeCapacity = Math.min(
      1 - mobileSlope * 0.88,
      slopeRetention,
    );
    snowHoldingCapacity[i] = clamp01(
      slopeCapacity
        + snowTransport.roughness[i] * 0.14
        + snowTransport.windShelter[i] * 0.06,
    );
    // Keep the lower edge of a drift translucent rock wash. The old 0.18 /
    // 0.52 remap turned modest snow variation into a solid white face.
    // Swiss-style snow is read as a connected cap or drift plane. Lower the
    // threshold slightly so shallow sheltered shoulders join the main mass
    // instead of becoming isolated white slivers.
    const snowEdge = clamp01((snowAmount - 0.1) / 0.24);
    const snow = snowEdge * snowEdge * (3 - 2 * snowEdge);
    // Store gradient coordinates instead of pre-shaded RGB/ink. Paper grain
    // and pens are applied AFTER projection so cliff stretching cannot blur them.
    // Preserve the broad rock-to-light range, but retain the continuous
    // directional value inside it so adjacent lit facets do not posterise to
    // the same pigment tone.
    const planeTone = clamp01(
      0.23 + 0.7 * Math.pow(light, 1.18) + (faceLight - broadLight) * 0.18,
    );
    const topographicRelief = Math.tanh(
      (naturalElevation[i] - reliefReference[i]) / reliefScale,
    );
    const reliefWeight = clamp01((dem.slopeDeg[i] - 4) / 36);
    const ridgeTone = (ribField[i] - 0.22) * 0.2;
    const creaseTone = (creaseField[i] - 0.12) * -0.12;
    const reliefTone = topographicRelief * (0.08 + reliefWeight * 0.12);
    material[i * 3] = clamp01(
      planeTone + reliefTone + ridgeTone + creaseTone + pigment * (options.washStrength ?? 0.24) * 0.2,
    );
    material[i * 3 + 1] = snow;
    // The face lighting carries the main shadow. Small ink-offset shadows
    // are only a pigment accent, otherwise they become detached gray spots.
    material[i * 3 + 2] = shadow[i] * 0.25;
  }
  initialSnowStop?.();

  // Short, mass-conserving gravity pass. Each buffered pass is exactly one
  // receiver step: all transfers read the same source state, then are applied
  // together. This keeps the result independent of raster traversal order and
  // limits the visual avalanche to the configured number of D8 steps.
  const redistributionStop = profiler?.begin('mountain illustration snow redistribution');
  const totalSnowCells = width * height;
  const snowInflow = new Float32Array(totalSnowCells);
  // Donors are sparse after the first pass. A bitset keeps the visit order
  // raster-stable while avoiding a full DEM scan for every configured step.
  const snowWords = Math.ceil(totalSnowCells / 32);
  let activeDonors = new Uint32Array(snowWords);
  let nextActiveDonors = new Uint32Array(snowWords);
  const setSnowBit = (bits: Uint32Array, index: number): void => {
    bits[index >>> 5] |= 1 << (index & 31);
  };
  for (let index = 0; index < totalSnowCells; index++) {
    if (snowMass[index] - snowHoldingCapacity[index] > 0.01) {
      setSnowBit(activeDonors, index);
    }
  }
  const touchedReceivers: number[] = [];
  for (let pass = 0; pass < snowfall.redistributionSteps; pass++) {
    nextActiveDonors.fill(0);
    touchedReceivers.length = 0;
    let transfersThisPass = 0;
    for (let wordIndex = 0; wordIndex < activeDonors.length; wordIndex++) {
      let word = activeDonors[wordIndex] >>> 0;
      while (word !== 0) {
        const lowestBit = word & -word;
        const bit = 31 - Math.clz32(lowestBit);
        const index = wordIndex * 32 + bit;
        word = (word & (word - 1)) >>> 0;
        if (index >= totalSnowCells) continue;
        const excess = snowMass[index] - snowHoldingCapacity[index];
        if (excess <= 0.01) continue;
        const x = index % width;
        const y = Math.floor(index / width);
        const direction = flowDirection[index];
        if (direction < 0 || direction >= MOUNTAIN_D8_OFFSETS.length) continue;
        const [dx, dy] = MOUNTAIN_D8_OFFSETS[direction];
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
        const receiver = nextY * width + nextX;
        if (footprint[receiver] < 0.02
          || isWaterCell(receiver)
          || dem.elevation[receiver] >= dem.elevation[index]
          || snowlineField[receiver] < 0.12) continue;
        const coldReceiver = clamp01(0.25 + snowlineField[receiver] * 0.75);
        const transfer = Math.min(excess * 0.72 * coldReceiver, snowMass[index] * 0.72);
        if (transfer <= 0) continue;
        snowMass[index] -= transfer;
        // Do not attenuate or clamp the receiver: both would silently destroy
        // mass when several steep cells feed one gully. A receiver can exceed
        // one normalized unit and will then render as saturated snow.
        if (snowInflow[receiver] === 0) touchedReceivers.push(receiver);
        snowInflow[receiver] += transfer;
        transfersThisPass++;
        if (snowMass[index] - snowHoldingCapacity[index] > 0.01) {
          setSnowBit(nextActiveDonors, index);
        }
      }
    }
    // Apply only touched receivers, then make them eligible for the next pass.
    // Clearing each slot here removes the need for a full-array fill.
    for (const receiver of touchedReceivers) {
      snowMass[receiver] += snowInflow[receiver];
      snowInflow[receiver] = 0;
      if (snowMass[receiver] - snowHoldingCapacity[receiver] > 0.01) {
        setSnowBit(nextActiveDonors, receiver);
      }
    }
    if (transfersThisPass === 0) break;
    const previousActive = activeDonors;
    activeDonors = nextActiveDonors;
    nextActiveDonors = previousActive;
  }
  for (let i = 0; i < snowMass.length; i++) {
    const snowEdge = clamp01((snowMass[i] - 0.1) / 0.24);
    const snow = snowEdge * snowEdge * (3 - 2 * snowEdge);
    material[i * 3 + 1] = snow;
  }
  redistributionStop?.();

  onStage?.('projection and material');
  const projectionStop = profiler?.begin('mountain illustration projection');
  for (let x = 0; x < width; x++) for (let y = 0; y < height - 1; y++) {
    const i = y * width + x, next = i + width;
    const lineworkTop = lineworkFootprint[i], lineworkBottom = lineworkFootprint[next];
    if (footprint[i] < 0.02 && footprint[next] < 0.02
      && lineworkTop < 0.02 && lineworkBottom < 0.02) continue;
    const top = y - lift[i], bottom = y + 1 - lift[next];
    if (bottom <= top) continue; // Back-facing folds are hidden by the near face.
    for (let py = Math.max(0, Math.ceil(top)); py <= Math.min(height - 1, Math.floor(bottom)); py++) {
      const t = clamp01((py - top) / (bottom - top));
      const materialCoverage = footprint[i] * (1 - t) + footprint[next] * t;
      const lineworkCoverage = lineworkTop * (1 - t) + lineworkBottom * t;
      if (materialCoverage < 0.02 && lineworkCoverage < 0.02) continue;
      const destination = py * width + x;
      // The raised illustration must not paint over the map's visible rivers
      // or lakes, including water in front of a projected mountain footprint.
      if (isWaterCell(destination)) continue;
      sourceY[destination] = y + t;
      if (materialCoverage >= 0.02) {
        const destinationMaterial = destination * 3;
        const sourceMaterial = i * 3;
        const nextMaterial = next * 3;
        const inverseT = 1 - t;
        projectedMaterial[destinationMaterial] =
          material[sourceMaterial] * inverseT + material[nextMaterial] * t;
        projectedMaterial[destinationMaterial + 1] =
          material[sourceMaterial + 1] * inverseT + material[nextMaterial + 1] * t;
        projectedMaterial[destinationMaterial + 2] =
          material[sourceMaterial + 2] * inverseT + material[nextMaterial + 2] * t;
        // Material alpha remains independent of the dry linework support.
        rgba[destination * 4 + 3] = Math.round(
          Math.pow(clamp01(materialCoverage), 1.42) * 255,
        );
      }
      lineworkClip[destination] = Math.max(lineworkClip[destination],
        Math.round(clamp01(lineworkCoverage) * 255));
     }
   }
  projectionStop?.();

  // Use the source row behind a projected pixel so the ramp follows terrain
  // elevation rather than the raised screen-space position of the crest.
  const mainRidgeThicknessAt = (point: Point): number => {
    const x = Math.max(0, Math.min(width - 1, point.x));
    const y = Math.max(0, Math.min(height - 1, point.y));
    const sourceRow = sampleScalarField(sourceY, width, height, x, y);
    const terrainY = sourceRow >= 0 ? sourceRow : y;
    const terrainHeight = naturalSample(x, terrainY);
    const elevationRange = Math.max(1, dem.maxElevationM - dem.minElevationM);
    const heightFraction = clamp01((terrainHeight - dem.minElevationM) / elevationRange);
    return 1 + heightFraction;
  };
  // Interior hatches are quiet on level faces and gain strength on a genuine
  // terrain face. This uses the same physical spacing as the camera shadow,
  // so an oblique lowland cliff receives the same treatment as a mountain
  // face without introducing a screen-space vertical bias.
  const hatchTerrainOpacity = (points: Point[]): number => {
    if (points.length === 0) return 0.5;
    const radius = Math.max(1, 2 * scale);
    let slope = 0;
    let samples = 0;
    const stride = Math.max(1, Math.floor(points.length / 8));
    for (let index = 0; index < points.length; index += stride) {
      const point = points[index];
      const gx = (naturalSample(point.x + radius, point.y)
        - naturalSample(point.x - radius, point.y))
        / Math.max(1e-6, 2 * radius * dem.dxMeters);
      const gy = (naturalSample(point.x, point.y + radius)
        - naturalSample(point.x, point.y - radius))
        / Math.max(1e-6, 2 * radius * dem.dyMeters);
      slope += Math.hypot(gx, gy);
      samples++;
    }
    const faceStrength = clamp01((slope / Math.max(1, samples)) / 0.8);
    return 0.5 + faceStrength * 0.25;
  };

  const grainNoise = new SimplexNoise(options.seed + 3221);
  const washNoise = new SimplexNoise(options.seed + 1403);
  const patchNoise = new SimplexNoise(options.seed + 1801);
  const inkInterior = new Float32Array(width * height);
  const dark = clamp01(options.washDarkStrength ?? 0.22);
  const lightStrength = clamp01(options.washLightStrength ?? 0.12);
  const rockStops = [
    blendIllustrationColor(
      MOUNTAIN_ILLUSTRATION_PALETTE.rockShadow,
      MOUNTAIN_ILLUSTRATION_PALETTE.rockDeep,
      0.45 + dark * 0.55,
    ),
    blendIllustrationColor(
      MOUNTAIN_ILLUSTRATION_PALETTE.rockMid,
      MOUNTAIN_ILLUSTRATION_PALETTE.rockShadow,
      dark * 0.22,
    ),
    blendIllustrationColor(
      MOUNTAIN_ILLUSTRATION_PALETTE.rockLight,
      MOUNTAIN_ILLUSTRATION_PALETTE.snowShadow,
      lightStrength * 0.16,
    ),
  ];
  const snowStops = [
    [...MOUNTAIN_ILLUSTRATION_PALETTE.snowShadow],
    [...MOUNTAIN_ILLUSTRATION_PALETTE.snowMid],
    [...MOUNTAIN_ILLUSTRATION_PALETTE.snowLight],
  ];
  const snowToneAtMidpoint = 0.02 + Math.pow(0.5, 1.35) * 0.9;
  const snowCoverageAlpha = new Uint8Array(width * height);
  // User-selected line colours are final ink colours. Mixing them with the
  // illustration palette here made a requested #000 hatch render as dark
  // blue-grey before it ever reached the compositor.
  const hatchColor = (options.hatchColor ?? options.inkColor).map(value =>
    Math.max(0, Math.min(255, value)),
  );
  const ridgeColor = (options.ridgeColor ?? options.inkColor).map(value =>
    Math.max(0, Math.min(255, value)),
  );
  const horizontalHatchOpacity = clamp01(
    options.horizontalHatchOpacity ?? options.hatchOpacity ?? options.strokeOpacity,
  );
  const verticalHatchOpacity = clamp01(
    options.verticalHatchOpacity ?? options.hatchOpacity ?? options.strokeOpacity,
  );
  const materialShadingStop = profiler?.begin('mountain illustration material shading');
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!rgba[i * 4 + 3]) continue;
    const gx = materialWorldX[x], gy = materialWorldY[y];
    const scaledX = gx / scale, scaledY = gy / scale;
    const grain = sampleCartographicGrain(grainNoise, scaledX, scaledY,
      gy * materialStride + gx, options.seed);
    const noise = filterCartographicSignedGradient(sampleCartographicWashNoise(washNoise,
      scaledX, scaledY, 140 / Math.max(0.25, options.washNoiseScale ?? 1)), grain);
    const tone = filterCartographicGradient(clamp01(projectedMaterial[i * 3]
      + noise * (options.washNoiseStrength ?? 0.45) * 0.26), grain * 0.4);
    // Increase the separation between sunlit and shaded planes. The same remap
    // feeds stone and snow so the snowpack receives the lighting contrast
    // instead of becoming an unlit white overlay.
    const contrastTone = 1 - hillshadeStrength * (1 - stylizeMountainLight(
      clamp01(0.5 + (tone - 0.5) * 1.32),
      lightingMode,
    ));
    const snowBase = projectedMaterial[i * 3 + 1];
    const patch = sampleCartographicPatchNoise(patchNoise, scaledX, scaledY, 24);
    // Major snow masses are resolved by the physical field and shelter term;
    // this last pass only gives their boundary a restrained hand-painted edge.
    const roughEdge = ((patch - 0.5) * 0.38 + grain * 0.08) * 2 * snowBase * (1 - snowBase);
    const snow = clamp01((snowBase + roughEdge - 0.28) / 0.3);
    snowCoverageAlpha[i] = Math.round(snow * 255);
    const stop = contrastTone < 0.5 ? 0 : 1, t = contrastTone < 0.5 ? contrastTone * 2 : (contrastTone - 0.5) * 2;
    // Keep sunlit snow paper-white, but push shadowed snow much farther toward
    // the blue-grey stop. The previous linear offset kept most snow above the
    // middle stop, so shaded faces read almost as bright as their lit sides.
    const snowTone = contrastTone < 0.5
      ? 0.02 + Math.pow(contrastTone, 1.35) * 0.9
      : snowToneAtMidpoint
        + Math.pow((contrastTone - 0.5) * 2, 0.82) * (1 - snowToneAtMidpoint);
    const snowStop = snowTone < 0.5 ? 0 : 1;
    const snowT = snowTone < 0.5 ? snowTone * 2 : (snowTone - 0.5) * 2;
    const surfaceShadow = hillshadeStrength * clamp01(projectedMaterial[i * 3 + 2] * 3.2);
    const rockColor: TintRGB = [
      rockStops[stop][0] * (1 - t) + rockStops[stop + 1][0] * t,
      rockStops[stop][1] * (1 - t) + rockStops[stop + 1][1] * t,
      rockStops[stop][2] * (1 - t) + rockStops[stop + 1][2] * t,
    ];
    const rock = landGreen && snow < 1
      ? tintMountainLand(rockColor, {
        slopeDeg: dem.slopeDeg[i],
        normElev: normalizedElevation[i],
        tpi: tpi?.[i] ?? 0,
        insolation: solarInsolation[i] ?? 0.5,
        noise,
      }, landGreen)
      : rockColor;
    for (let c = 0; c < 3; c++) {
      const ice = snowStops[snowStop][c] * (1 - snowT) + snowStops[snowStop + 1][c] * snowT;
      rgba[i * 4 + c] = (rock[c] * (1 - snow) + ice * snow) * (1 - surfaceShadow * 0.42);
    }
    const distance = sampleScalarField(edgeDistance, width, height, x, sourceY[i]);
    inkInterior[i] = clamp01(distance / (28 * scale));
    const groundBreakup = clamp01(
      (dem.slopeDeg[i] - 3) / 26 +
      (normalizedElevation[i] - 0.26) * 0.24,
    );
    const edgeAlpha = clamp01(
      distance / (6 * scale) + (patch - 0.5) * (0.12 + groundBreakup * 0.08),
    );
    rgba[i * 4 + 3] = Math.round(filterCartographicGradient(rgba[i * 4 + 3] / 255 * edgeAlpha, grain) * 255);
  }
  materialShadingStop?.();

  // Keep the material diagnostic independent from the final illustration.
  // The passes below add crest, ridge, and charcoal ink directly to `rgba`.
  // In camera mode the material buffer is the final base layer. Reuse `rgba`
  // instead of copying it; the later color-only illustration composition is
  // skipped and cannot mutate these camera layers.
  const materialRgba = cameraLayersOnly ? rgba : rgba.slice();

  // Visible depth discontinuities are the dark upper lips of cliffs. Unlike
  // snow outlines, these can cross both white snow and bare stone.
  const crestInk = new Uint8Array(width * height);
  const ridgeLight = cameraLayersOnly ? undefined : new Uint8Array(width * height);
  const verticalHatchInk = new Uint8Array(width * height);
  const horizontalHatchInk = new Uint8Array(width * height);
  const interiorRidgeInk = new Uint8Array(width * height);
  const silhouettePaths: Point[][] = [];
  const projectedRidgePaths: Point[][] = [];
  const charcoalPaths: Point[][] | undefined = cameraLayersOnly ? undefined : [];
  // A projected crest can land in a one-pixel hole in the antialiased
  // surface. Keep a small land-only support mask for ridge ink so the main
  // outline remains continuous without opening a path across water.
  const ridgeClip = lineworkClip;
  const widenRidgeClip = (x: number, y: number, sourceX: number, sourceY: number): void => {
    const sourceIndex = Math.round(sourceY) * width + Math.round(sourceX);
    const sourceLinework = pattern.lineworkCoverage ?? pattern.coverage;
    if (sourceIndex < 0 || sourceIndex >= sourceLinework.length || sourceLinework[sourceIndex] === 0) return;
    const support = Math.max(2, Math.ceil(3 * scale));
    let nearLand = false;
    for (let dy = -support; dy <= support && !nearLand; dy++) for (let dx = -support; dx <= support; dx++) {
      const nx = Math.round(x) + dx, ny = Math.round(y) + dy;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height && lineworkClip[ny * width + nx] > 0) { nearLand = true; break; }
    }
    if (!nearLand) return;
    for (let dy = -support; dy <= support; dy++) for (let dx = -support; dx <= support; dx++) {
      const nx = Math.round(x) + dx, ny = Math.round(y) + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || dx * dx + dy * dy > support * support) continue;
      const index = ny * width + nx;
      if (isWaterCell(index)) continue;
      lineworkClip[index] = Math.max(lineworkClip[index], 200);
      ridgeClip[index] = Math.max(ridgeClip[index], 200);
    }
  };
  onStage?.('stroke painting');
  const silhouetteStop = profiler?.begin('mountain illustration silhouette detection');
  const silhouette = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    if (lineworkClip[i] < 160 || sourceY[i] < 0) continue;
    const above = sourceY[i - width];
    // Missing surface above water is a clipping edge, not a mountain crest.
    if (above < 0 || sourceY[i] - above < 3 * scale) continue;
    if (sourceY[i] - y < 3 * scale) continue;
    silhouette[i] = 1;
  }
  const silhouetteSegments: [Point, Point][] = [];
  // Bounded Chebyshev distance gives the same square neighbourhood test in
  // constant time per path point, including at native export resolution.
  const silhouetteDistance = new Float32Array(width * height);
  const initialSilhouetteDistance = Math.ceil(4 * scale) + 1;
  for (let index = 0; index < silhouetteDistance.length; index++) {
    silhouetteDistance[index] = silhouette[index]
      ? 0
      : initialSilhouetteDistance;
  }
  for (const direction of [1, -1]) {
    for (let y = direction === 1 ? 0 : height - 1; y >= 0 && y < height; y += direction) {
      for (let x = direction === 1 ? 0 : width - 1; x >= 0 && x < width; x += direction) {
        const i = y * width + x;
        const px = x - direction, py = y - direction;
        if (px >= 0 && px < width) silhouetteDistance[i] = Math.min(silhouetteDistance[i], silhouetteDistance[y * width + px] + 1);
        if (py >= 0 && py < height) for (let dx = -1; dx <= 1; dx++) {
          if (x + dx >= 0 && x + dx < width) silhouetteDistance[i] = Math.min(silhouetteDistance[i], silhouetteDistance[py * width + x + dx] + 1);
        }
      }
    }
  }
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    if (!silhouette[i]) continue;
    let nextY = -1, score = Infinity;
    for (let delta = -3; delta <= 3; delta++) {
      const py = y + delta;
      if (py < 0 || py >= height) continue;
      const next = py * width + x + 1;
      if (!silhouette[next] || Math.abs(sourceY[next] - sourceY[i]) > 8 * scale) continue;
      if (Math.abs(delta) < score) { nextY = py; score = Math.abs(delta); }
    }
    if (nextY < 0) continue;
    silhouetteSegments.push([
      { x, y },
      { x: x + 1, y: nextY },
    ]);
  }
  for (const points of chainMountainSegments(silhouetteSegments)) {
    const angular = angularMountainPath(points, scale, options.offsetX, options.offsetY);
    if (paintMountainChain(crestInk, lineworkClip, width, height, angular, 0.98 * scale * ridgeStrokeThickness,
      0.82, options.seed, false, options, false, false, undefined, mainRidgeThicknessAt)) {
      silhouettePaths.push(points);
      if (ridgeLight) {
        paintMountainChain(ridgeLight, lineworkClip, width, height, angular,
          2.1 * scale * ridgeStrokeThickness, options.strokeOpacity * 0.2,
          options.seed ^ 0x2b17, false, options, false, false, undefined, mainRidgeThicknessAt);
      }
    }
  }
  silhouetteStop?.();
  // Project vectors, split ONLY where another face actually occludes the path,
  // then stroke each entire visible chain at the final output resolution.
  const pathPaintingStop = profiler?.begin('mountain illustration path painting');
  // Temporary visual test: apply the charcoal brush to primary crest chains
  // while keeping their terrain-derived geometry and endpoint tapering.
  const charcoalPrimaryRidges = true;
  // Charcoal ridge/hatch strokes are independent within their layer. Collect
  // them while the geometry is being classified, then rasterize each family
  // through the spatially-binned painter once. This keeps the same segment
  // parameters and source order while avoiding a full setup/clip walk for
  // every tiny path fragment.
  const batchedCrestSegments: BatchedInkSegment[] = [];
  const batchedInteriorRidgeSegments: BatchedInkSegment[] = [];
  const batchedHorizontalHatchSegments: BatchedInkSegment[] = [];
  const batchedVerticalHatchSegments: BatchedInkSegment[] = [];
  for (const path of pattern.paths ?? []) {
    let visible: Point[] = [];
    let visibleStartsAtPathStart = false;
    const ridge = path.kind === 'ridge';
    const dot = path.kind === 'dot';
    let strongCrest = ridge && path.primary === true;
    const flush = (endsAtPathEnd = false) => {
      if (dot && visible.length > 0) {
        paintMountainDot(verticalHatchInk, lineworkClip, width, height, visible[0], path.width, path.opacity);
        charcoalPaths?.push(visible);
        visible = [];
        visibleStartsAtPathStart = false;
        return;
      }
      if (visible.length > 1) {
        // Main ridge paths benefit from the angular rock-edge simplification,
        // but downhill charcoal paths are already sampled from the terrain
        // gradient. Simplifying those paths on an 8px grid turns their small
        // natural bends into conspicuously straight chords.
        const points = ridge && strongCrest
          ? angularMountainPath(visible, scale, options.offsetX, options.offsetY)
          : visible;
        const heightAt = (p: Point) => naturalSample(p.x, p.y);
        const firstHeight = heightAt(visible[0]);
        const lastHeight = heightAt(visible[visible.length - 1]);
        const firstInner = heightAt(visible[Math.min(12, visible.length - 1)]);
        const lastInner = heightAt(visible[Math.max(0, visible.length - 13)]);
        // Hessian ridges include interior folds, not just silhouettes. Only
        // a visible depth boundary earns a solid crest pen and edge light.
        const crest = ridge && strongCrest;
        // A true chain endpoint receives the same brush taper as an ocean
        // mark. Occlusion and tile clipping ends stay square so they can join
        // the continuation rendered by the neighbouring segment/tile.
        const terrainTaperStart = ridge && firstHeight < firstInner - 25;
        const terrainTaperEnd = ridge && lastHeight < lastInner - 25;
        const taperStart = terrainTaperStart || (crest && visibleStartsAtPathStart);
        const taperEnd = terrainTaperEnd || (crest && endsAtPathEnd);
        const hatchInk = path.kind === 'contour' ? horizontalHatchInk : verticalHatchInk;
        const hatchFamilyOpacity = path.kind === 'contour'
          ? horizontalHatchOpacity
          : verticalHatchOpacity;
        const opaqueHatch = !crest && !ridge && !dot && hatchFamilyOpacity >= 1 - 1e-6;
        const terrainOpacity = crest || opaqueHatch ? 1 : hatchTerrainOpacity(points);
        const batchedSegments = crest
          ? batchedCrestSegments
          : ridge
            ? batchedInteriorRidgeSegments
            : path.kind === 'contour'
              ? batchedHorizontalHatchSegments
              : batchedVerticalHatchSegments;
        const painted = paintMountainChain(crest ? crestInk : ridge ? interiorRidgeInk : hatchInk,
          crest ? ridgeClip : lineworkClip, width, height,
          // Primary crests can overlap a coverage boundary and a bridge at
          // the same screen position. Keep the pen narrower and translucent
          // so those legitimate joins do not become black blocks.
          points, path.width * (crest ? 1.05 : ridge ? 0.65 : 1.05),
          crest ? Math.min(0.82, path.opacity * 0.9 + 0.06)
            : (ridge ? path.opacity * 0.48 : path.opacity * (opaqueHatch ? 1 : 0.92)) * terrainOpacity,
          path.key, (!crest && !dot) || (crest && charcoalPrimaryRidges), options,
          taperStart, taperEnd, crest || dot ? undefined : inkInterior,
          crest ? mainRidgeThicknessAt : undefined, opaqueHatch,
          crest && charcoalPrimaryRidges, batchedSegments);
        if (painted) {
          if (crest) {
            silhouettePaths.push(visible);
            projectedRidgePaths.push(visible);
            // A narrow cool wash shares the exact crest geometry. The dark
            // pen is composited later, leaving this light just at its edges.
            if (ridgeLight) {
              paintMountainChain(ridgeLight, ridgeClip, width, height, points,
                path.width * 2.5, path.opacity * 0.34, path.key ^ 0x2b17, false, options,
                taperStart, taperEnd, undefined, mainRidgeThicknessAt);
            }
          } else {
            charcoalPaths?.push(visible);
          }
        }
      }
      visible = [];
    };
    for (let pointIndex = 0; pointIndex < path.points.length; pointIndex++) {
      const point = path.points[pointIndex];
      // Interior ribs use short, globally indexed runs. A long ridge may
      // begin outside a tile's support; restarting its charcoal dash phase
      // at that clipped endpoint would otherwise change interior pixels.
      if (ridge && !path.primary && !strongCrest && pointIndex % 24 === 0 && visible.length > 1) {
        const previous = visible[visible.length - 1];
        flush();
        visible.push(previous);
        visibleStartsAtPathStart = false;
      }
      // A steep foreground rise hides a rear crest even when the two lifted
      // screen rows no longer overlap exactly. This preserves open valleys
      // and prevents a hidden ridge from drawing across a nearer face.
      if (ridge && isRidgeBehindForeground(point)) {
        flush();
        continue;
      }
      const y = point.y - sampleScalarField(lift, width, height, point.x, point.y);
      const x = point.x;
      if (x < 0 || x > width - 1 || y < 0 || y > height - 1) {
        flush(); continue;
      }
      if (ridge) widenRidgeClip(x, y, point.x, point.y);
      const index = Math.round(y) * width + Math.round(x);
      const depth = sourceY[index];
      // The illustration scale is expressed in the fixed 8 km study frame.
      // At preview/export scales below one, the old proportional tolerance
      // became sub-pixel and split an otherwise visible hatch whenever the
      // projected source row landed on the neighbouring raster sample. Keep
      // a small source-cell floor so depth testing still stops genuine folds
      // while a line remains continuous across the same visible face.
      const depthTolerance = ridge
        ? Math.max(3 * scale, 2)
        : Math.max(2.5 * scale, 2);
      if (depth < 0 || Math.abs(depth - point.y) > depthTolerance) {
        // A crest on the hidden face must stop at the depth boundary. Forcing
        // it through the foreground paints angular diagonals over the slope.
        flush(); continue;
      }
      // Keep each visible portion continuous; hidden portions ended above.
      if (ridge && !path.primary) {
        // Use the same actual depth discontinuities as the automatic outline,
        // with bounded support so classification agrees across export tiles.
        const nearSilhouette = silhouetteDistance[index] <= Math.ceil(4 * scale);
        if (visible.length && nearSilhouette !== strongCrest) flush();
        strongCrest = nearSilhouette;
      }
      if (visible.length === 0) visibleStartsAtPathStart = pointIndex === 0;
      visible.push({ x, y });
    }
    flush(true);
  }
  paintInkSegmentsBatched(
    crestInk,
    ridgeClip,
    width,
    height,
    batchedCrestSegments,
  );
  paintInkSegmentsBatched(
    interiorRidgeInk,
    lineworkClip,
    width,
    height,
    batchedInteriorRidgeSegments,
  );
  paintInkSegmentsBatched(
    horizontalHatchInk,
    lineworkClip,
    width,
    height,
    batchedHorizontalHatchSegments,
  );
  paintInkSegmentsBatched(
    verticalHatchInk,
    lineworkClip,
    width,
    height,
    batchedVerticalHatchSegments,
  );
  pathPaintingStop?.();
  // Register the pale side of each crest with the material that is actually
  // snow covered after projection. A centred highlight can drift onto the
  // dark face when a ridge crosses a broad plane; this offset follows the
  // brighter neighbouring side instead.
  const projectedSnowAt = (point: Point): number => {
    const x = Math.max(0, Math.min(width - 1, Math.round(point.x)));
    const y = Math.max(0, Math.min(height - 1, Math.round(point.y)));
    return projectedMaterial[(y * width + x) * 3 + 1];
  };
  const crestJoiningStop = profiler?.begin('mountain illustration crest joining');
  if (ridgeLight) {
    for (const path of projectedRidgePaths) {
      if (path.length < 2) continue;
      const lightPath = path.map((point, index) => {
        const before = path[Math.max(0, index - 1)], after = path[Math.min(path.length - 1, index + 1)];
        const tx = after.x - before.x, ty = after.y - before.y;
        const length = Math.max(1e-6, Math.hypot(tx, ty));
        const nx = -ty / length, ny = tx / length;
        const offset = 3 * scale;
        const plus = projectedSnowAt({ x: point.x + nx * offset, y: point.y + ny * offset });
        const minus = projectedSnowAt({ x: point.x - nx * offset, y: point.y - ny * offset });
        const side = plus >= minus ? 1 : -1;
        return { x: point.x + nx * side * 1.25 * scale, y: point.y + ny * side * 1.25 * scale };
      });
      paintMountainChain(ridgeLight, ridgeClip, width, height, lightPath,
        1.8 * scale * ridgeStrokeThickness, options.strokeOpacity * 0.24,
        options.seed ^ 0x5a31, false, options, false, false, undefined, mainRidgeThicknessAt);
    }
  }
  // Restore continuity across a projected saddle with a short, clip-tested
  // bridge. The ordinary silhouette cleanup below has a smaller radius; this
  // ridge-only pass closes the occasional visible one-pixel seam without
  // connecting neighbouring face outlines.
  for (const [a, b] of connectMountainCrests(projectedRidgePaths, scale * 1.8)) {
    const depthA = sampleScalarField(sourceY, width, height, a.x, a.y);
    const depthB = sampleScalarField(sourceY, width, height, b.x, b.y);
    if (depthA < 0 || depthB < 0 || Math.abs(depthA - depthB) > 20 * scale) continue;
    let clear = true;
    for (let t = 0; t <= 1; t += 0.1) {
      if (sampleScalarField(ridgeClip, width, height, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < 160) clear = false;
    }
    if (!clear) continue;
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.max(1e-6, Math.hypot(dx, dy));
    const overlap = Math.max(0, (10 * scale - length) / 2 + 0.1);
    const bridge = [{ x: a.x - dx / length * overlap, y: a.y - dy / length * overlap },
      a, b, { x: b.x + dx / length * overlap, y: b.y + dy / length * overlap }];
    paintMountainChain(crestInk, ridgeClip, width, height, bridge, 0.82 * scale * ridgeStrokeThickness,
       0.78, options.seed, charcoalPrimaryRidges, options, false, false, undefined, mainRidgeThicknessAt,
       false, charcoalPrimaryRidges);
    if (ridgeLight) {
      paintMountainChain(ridgeLight, ridgeClip, width, height, bridge, 1.9 * scale * ridgeStrokeThickness,
        options.strokeOpacity * 0.28, options.seed ^ 0x2b17, false, options, false, false, undefined, mainRidgeThicknessAt);
    }
  }
  const joins = connectMountainCrests(silhouettePaths, scale);
  for (const points of joins) {
    const [a, b] = points;
    const depthA = sampleScalarField(sourceY, width, height, a.x, a.y);
    const depthB = sampleScalarField(sourceY, width, height, b.x, b.y);
    if (Math.abs(depthA - depthB) > 20 * scale) continue;
    let clear = true;
    for (let t = 0; t <= 1; t += 0.1) {
      if (sampleScalarField(lineworkClip, width, height, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < 180) clear = false;
    }
    if (!clear) continue;
    // Include a short overlap into each existing stroke, so the normal
    // minimum-length filter does not discard a legitimate small connection.
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.max(1e-6, Math.hypot(dx, dy));
    const overlap = Math.max(0, (10 * scale - length) / 2 + 0.1);
    const bridge = [{ x: a.x - dx / length * overlap, y: a.y - dy / length * overlap },
      a, b, { x: b.x + dx / length * overlap, y: b.y + dy / length * overlap }];
    paintMountainChain(crestInk, ridgeClip, width, height, bridge, 0.82 * scale * ridgeStrokeThickness,
       0.78, options.seed, charcoalPrimaryRidges, options, false, false, undefined, mainRidgeThicknessAt,
       false, charcoalPrimaryRidges);
    if (ridgeLight) {
      paintMountainChain(ridgeLight, ridgeClip, width, height, bridge, 1.9 * scale * ridgeStrokeThickness,
        options.strokeOpacity * 0.28, options.seed ^ 0x2b17, false, options, false, false, undefined, mainRidgeThicknessAt);
    }
     silhouettePaths.push(points);
  }
  crestJoiningStop?.();
  if (cameraLayersOnly) {
    // These opacity adjustments affect the camera hatch layers themselves;
    // the remaining work below only paints them into the discarded full RGBA.
    for (let i = 0; i < lineworkClip.length; i++) {
      const snow = projectedMaterial[i * 3 + 1];
      verticalHatchInk[i] = Math.round(verticalHatchInk[i] * (1 - snow * 0.75));
      horizontalHatchInk[i] = Math.round(horizontalHatchInk[i] * (1 - snow * 0.75));
      interiorRidgeInk[i] = Math.round(interiorRidgeInk[i] * (1 - snow));
    }
    illustrationStop?.();
    return {
      materialRgba,
      silhouetteAlpha: crestInk,
      interiorRidgeAlpha: interiorRidgeInk,
      horizontalHatchAlpha: horizontalHatchInk,
      verticalHatchAlpha: verticalHatchInk,
      horizontalHatchOpacity: clamp01(options.horizontalHatchOpacity ?? options.hatchOpacity ?? options.strokeOpacity),
      verticalHatchOpacity: clamp01(options.verticalHatchOpacity ?? options.hatchOpacity ?? options.strokeOpacity),
    };
  }
  // A crest edge casts a restrained down-sun pencil wash. This is separate
  // from the terrain pigment shadow: only primary depth boundaries contribute,
  // and the blur is sampled in world coordinates so the offset remains stable
  // across preview and export tiles.
  const finalInkStop = profiler?.begin('mountain illustration shadow and final ink composition');
  const ridgeShadow = new Float32Array(width * height);
  const shadowAzimuth = options.sunAzimuthDeg * Math.PI / 180;
  const shadowAltitude = clamp01((options.sunAltitudeDeg - 15) / 65);
  const shadowLength = scale * (5.5 + (1 - shadowAltitude) * 9);
  const shadowDx = -Math.sin(shadowAzimuth) * shadowLength;
  const shadowDy = Math.cos(shadowAzimuth) * shadowLength;
  const shadowDistance = Math.max(1e-6, Math.hypot(shadowDx, shadowDy));
  const shadowPerpX = -shadowDy / shadowDistance;
  const shadowPerpY = shadowDx / shadowDistance;
  const shadowSamples: readonly [number, number, number][] = [
    [0.58, -1.15, 0.12],
    [0.78, -0.45, 0.2],
    [1.0, 0, 0.28],
    [1.22, 0.45, 0.2],
    [1.42, 1.15, 0.12],
  ];
  const sample0 = shadowSamples[0];
  const sample1 = shadowSamples[1];
  const sample2 = shadowSamples[2];
  const sample3 = shadowSamples[3];
  const sample4 = shadowSamples[4];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!lineworkClip[i]) continue;
    const value =
      sampleScalarField(
        crestInk,
        width,
        height,
        x - shadowDx * sample0[0] + shadowPerpX * sample0[1] * scale,
        y - shadowDy * sample0[0] + shadowPerpY * sample0[1] * scale,
      ) * sample0[2]
      + sampleScalarField(
        crestInk,
        width,
        height,
        x - shadowDx * sample1[0] + shadowPerpX * sample1[1] * scale,
        y - shadowDy * sample1[0] + shadowPerpY * sample1[1] * scale,
      ) * sample1[2]
      + sampleScalarField(
        crestInk,
        width,
        height,
        x - shadowDx * sample2[0] + shadowPerpX * sample2[1] * scale,
        y - shadowDy * sample2[0] + shadowPerpY * sample2[1] * scale,
      ) * sample2[2]
      + sampleScalarField(
        crestInk,
        width,
        height,
        x - shadowDx * sample3[0] + shadowPerpX * sample3[1] * scale,
        y - shadowDy * sample3[0] + shadowPerpY * sample3[1] * scale,
      ) * sample3[2]
      + sampleScalarField(
        crestInk,
        width,
        height,
        x - shadowDx * sample4[0] + shadowPerpX * sample4[1] * scale,
        y - shadowDy * sample4[0] + shadowPerpY * sample4[1] * scale,
      ) * sample4[2];
    ridgeShadow[i] = clamp01(value / 255) * (0.42 + (1 - shadowAltitude) * 0.28);
  }
  // Snow remains an intentional environmental opacity modifier for the face
  // hatches. A 100% hatch setting is the maximum ink strength, not a request
  // to bypass the snow and shaded-material passes. Primary crests stay solid.
  for (let i = 0; i < lineworkClip.length; i++) {
    const snow = projectedMaterial[i * 3 + 1];
    const pen = crestInk[i] / 255;
    // Downhill charcoal follows the face flow and remains legible over snow.
    // Interior height/ridge lines retain their lighter, snow-transparent
    // treatment so the snowfield is not boxed in by contour geometry.
    const verticalSnowFactor = 1 - snow * 0.75;
    const horizontalSnowFactor = 1 - snow * 0.75;
    verticalHatchInk[i] = Math.round(verticalHatchInk[i] * verticalSnowFactor);
    horizontalHatchInk[i] = Math.round(horizontalHatchInk[i] * horizontalSnowFactor);
    // Height/ridge marks are the light interior family; they disappear into
    // a continuous snow plane while downhill strokes retain a faint trace.
    interiorRidgeInk[i] = Math.round(interiorRidgeInk[i] * (1 - snow));
    const verticalHatch = verticalHatchInk[i] / 255;
    const horizontalHatch = horizontalHatchInk[i] / 255;
    const charcoal = Math.max(verticalHatch, horizontalHatch);
    const heightLines = interiorRidgeInk[i] / 255;
    const light = hillshadeStrength * ridgeLight![i] / 255 * (0.65 + snow * 0.35);
    const lightColor = snow > 0.35
      ? MOUNTAIN_ILLUSTRATION_PALETTE.snowMid
      : MOUNTAIN_ILLUSTRATION_PALETTE.rockLight;
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = rgba[i * 4 + c] * (1 - light * 0.38) + lightColor[c] * light * 0.38;
    const softShadow = hillshadeStrength * ridgeShadow[i];
    if (softShadow > 0) {
      const shadowColor = snow > 0.35
        ? MOUNTAIN_ILLUSTRATION_PALETTE.snowShadow
        : MOUNTAIN_ILLUSTRATION_PALETTE.rockDeep;
      for (let c = 0; c < 3; c++) {
        const shadowBlend = softShadow * 0.82;
        rgba[i * 4 + c] = rgba[i * 4 + c] * (1 - shadowBlend)
          + shadowColor[c] * shadowBlend;
      }
    }
    for (let c = 0; c < 3; c++) {
      // Interior ridge ribs keep their quiet snow treatment, but hatches are
      // the explicit top ink family. Compositing hatches after the ribs keeps
      // a second lighter layer from washing out a black hatch at overlaps.
      const interiorPigment = hatchColor[c] * (1 - snow * 0.6)
        + MOUNTAIN_ILLUSTRATION_PALETTE.snowShadow[c] * snow * 0.6;
      const withInterior = rgba[i * 4 + c] * (1 - heightLines)
        + interiorPigment * heightLines;
      const shaded = withInterior * (1 - charcoal) + hatchColor[c] * charcoal;
      // Primary crest ink is a solid black cartographic pen. Anti-aliasing is
      // retained at the edge, but its colour is never diluted by the hatch
      // ink or by the material underneath.
      rgba[i * 4 + c] = shaded * (1 - pen) + ridgeColor[c] * pen;
    }
  }
  // Mountain ink is a topmost cartographic layer. The material footprint can
  // fade at the lower edge of the raised face, but that fade must not dilute
  // a ridge or hatch that was deliberately painted there.
  for (let i = 0; i < lineworkClip.length; i++) {
    if (Math.max(crestInk[i], verticalHatchInk[i], horizontalHatchInk[i], interiorRidgeInk[i]) > 0) {
      rgba[i * 4 + 3] = 255;
    }
  }
  finalInkStop?.();
  const combinedFaceHatch = verticalHatchInk.map((value, i) => Math.max(value, horizontalHatchInk[i]));
  const combinedCharcoal = combinedFaceHatch.map((value, i) => Math.max(value, interiorRidgeInk[i]));
  illustrationStop?.();
  return { rgba, materialRgba, sourceY, silhouetteAlpha: crestInk, charcoalAlpha: combinedCharcoal,
    snowCoverageAlpha,
    depthSilhouetteAlpha: crestInk, interiorRidgeAlpha: interiorRidgeInk,
    faceStrokeAlpha: combinedFaceHatch,
    horizontalHatchAlpha: horizontalHatchInk,
    verticalHatchAlpha: verticalHatchInk,
    horizontalHatchOpacity: clamp01(options.horizontalHatchOpacity ?? options.hatchOpacity ?? options.strokeOpacity),
    verticalHatchOpacity: clamp01(options.verticalHatchOpacity ?? options.hatchOpacity ?? options.strokeOpacity),
    silhouettePaths, charcoalPaths };
}

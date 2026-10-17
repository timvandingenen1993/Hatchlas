/**
 * Main-thread side of mountain export: tile dimensions, camera framing and mapping patterns onto tiles.
 */
import { DEFAULT_BIOME_EDGE_NOISE_SCALE_M } from "../terrain/biomeEdgeNoise";
import type { MountainDEMData } from "../terrain/mountainBaseDEM";
import type {
  MountainDetailImageData,
  MountainRenderOptions,
} from "./mountainDetailRenderer";
import {
  buildMountainIllustrationStageInputs,
  renderMountainDetailDEM,
  renderMountainIllustrationStageFromInputs,
  renderMountainCameraIllustrationStageFromInputs,
  getMountainPatternOptions,
  renderMountainWaterOverlay,
  scaleWaterPresentationOptions,
  WATER_REFERENCE_LONG_EDGE,
} from "./mountainDetailRenderer";
import {
  createMountainFieldCache,
  renderMountainPatternOverlay,
  type MountainFieldCache,
  type MountainPatternOverlay,
} from "./mountainPatternRenderer";
import type {
  MountainIllustration,
  MountainCameraIllustrationLayers,
} from "./mountainIllustrationRenderer";
import type { MountainIllustrationPreparedFieldSet } from "./mountainIllustrationFields";
import type { MountainIllustrationFieldInputs } from "./mountainIllustrationFields";
import type { RiverSpline, WaterOverlay } from "./waterRenderer";
import type {
  MountainExportGlobalContext,
  MountainExportTile,
} from "./mountainExportTypes";
import {
  mapVegetationGeometryToTile,
} from "./vegetationRenderer";
import { FOREST_REFERENCE_LONG_EDGE } from "./forestCanvasRenderer";
import type { MountainProfiler } from "./mountainProfiler";
import {
  MOUNTAIN_MAX_LIFT_PIXELS,
  mountainProjectionLiftCoefficient,
  mountainProjectionSupportPixels,
  normalizeMountainSnowfallSettings,
} from "./mountainProjection";
import {
  mountainCameraIllustrationInkAlpha,
  mountainCameraIllustrationTexture,
  mountainIllustrationInkAlpha,
  type MountainCameraIllustrationStyle,
} from './mountainCameraLinework';
import {
  createMountainPathSpatialIndex,
  queryMountainPathSpatialIndex,
  type MountainPathSpatialIndex,
} from './mountainPathSpatialIndex';

export interface MountainExportIllustrationPreparationRequest {
  dem: MountainDEMData;
  options: MountainRenderOptions;
  pattern: MountainPatternOverlay;
  fieldCache: MountainFieldCache;
  fieldInputs: MountainIllustrationFieldInputs;
}

export type MountainExportIllustrationPreparation = (
  request: MountainExportIllustrationPreparationRequest,
) => Promise<MountainIllustrationPreparedFieldSet | undefined>
  | MountainIllustrationPreparedFieldSet
  | undefined;

export interface MountainExportTileDimensions {
  presentationScale: number;
  /** Output pixels per live-preview DEM pixel; water controls use this scale. */
  waterScale: number;
  illustrated: boolean;
  detailHalo: number;
  /** `detailHalo` without the ocean-wave reach, which only the water overlay needs. */
  compositeHalo: number;
  mountainHalo: number;
  /** Region around the core that the mountain illustration needs. */
  mountainSupport: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Shared dimension calculation for rendering and bounded-worker estimates. */
export function getMountainExportTileDimensions(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
): MountainExportTileDimensions {
  const global = context.dem;
  const outputWidth = context.outputWidth;
  const outputHeight = context.outputHeight;
  const presentationScale = Math.min(
    outputWidth / Math.max(1, global.width),
    outputHeight / Math.max(1, global.height),
  );
  // The export DEM follows the output size, but water controls are authored
  // against the fixed-size live preview DEM.
  const waterScale = presentationScale *
    Math.max(global.width, global.height) / WATER_REFERENCE_LONG_EDGE;
  const illustrated =
    context.render.layer === 'vegetation_patterns' ||
    context.render.fullTerrainCameraElevationDeg !== undefined;
  const requestedHalo = Math.max(0, Math.floor(tile.halo));
  const maximumForestRadius = getMaximumForestRadius(context);
  const forestSettings = context.render.vegetation?.forestSettings;
  const forestFilterSupport = Math.max(
    forestSettings?.outlineShadowStrength === 0 ? 0 : 3 * 3.6 + 8 + 2,
    forestSettings?.outlineInsetStrength === 0
      ? 0
      : 3 * (forestSettings?.outlineInsetBlurRadius ?? 2.5) + (forestSettings?.outlineInsetBlurRadius ?? 2.5) * 0.6 + 2,
    2.28,
  ) * presentationScale;
  const forestHalo = maximumForestRadius > 0
    ? Math.ceil(maximumForestRadius * presentationScale * 1.2 + forestFilterSupport)
    : 0;
  const oceanWavesEnabled = context.render.showWaterDetails !== false &&
    context.render.showOceanDetails !== false &&
    context.render.deepOceanSwells !== false;
  const waveLengthPixels = Math.max(
    0,
    context.render.deepOceanWaveLength ?? context.render.waterOutlineLength ?? 1,
  ) * waterScale;
  const waveThicknessPixels = Math.max(
    0,
    context.render.deepOceanStrokeThickness ?? context.render.waterOutlineThickness ?? 1,
  ) * waterScale;
  const waveShadingScale = Math.max(
    0.5,
    Math.min(8, context.render.deepOceanWaveShadingScale ?? 4.5),
  );
  const wavePathReach = Math.max(
    12 * waterScale,
    20.2 * waveLengthPixels + 8 * waterScale,
  );
  const waveShadingReach = (
    Math.max(2.5 * waterScale, 2.7 * waveThicknessPixels) +
    3.2 * waterScale +
    1.15 * waterScale
  ) * waveShadingScale * 1.9 + 1.5 * waterScale;
  const wavePaintReach = Math.max(
    4.8 * waterScale,
    3.2 * waveThicknessPixels + 2.5 * waterScale,
    waveShadingReach + 2 * waterScale,
  );
  // Waves only ever paint ocean pixels, so a tile whose core holds no ocean
  // cannot receive any wave ink and needs no wave support region.
  const oceanWaveHalo = oceanWavesEnabled && exportTileTouchesOcean(context, tile)
    ? Math.ceil(wavePathReach + wavePaintReach + 2 * waterScale)
    : 0;
  const biomeWashHalo = context.render.layer === 'vegetation_patterns'
    ? Math.ceil(
        ((context.dem.biomeEdgeNoiseScaleM ?? DEFAULT_BIOME_EDGE_NOISE_SCALE_M) * 0.25 *
          Math.max(0, Math.min(3, context.render.vegetationBiomeTransitionStrength ?? 1)) /
          Math.max(
            1,
            Math.min(
              (global.domainWidthKm * 1000) / Math.max(1, outputWidth),
              (global.domainHeightKm * 1000) / Math.max(1, outputHeight),
            ),
          )) * 2.4 +
          Math.ceil(Math.sqrt((outputWidth * outputHeight) / 1_000_000)) +
          2,
      )
    : 0;
  // Pool charcoal rings are placed by distance to the shore and fitted to
  // each pool's deepest point (full layout ~33 preview px deep). A tile must
  // see the whole of any pool smaller than that, or its rings shift at the
  // tile seam.
  const poolSupport = Math.ceil(70 * Math.max(1, waterScale));
  const poolCoverage = global.wetlandPoolCoverage ?? global.wetlandPoolMask;
  const poolRingHalo = poolCoverage && exportTileTouchesMask(context, tile, poolCoverage, poolSupport)
    ? poolSupport : 0;
  // The water renderer smooths each shoreline over about 1.5 source cells and
  // pins it at the tile border, so a tile needs that reach of context for
  // neighbouring tiles to trace the same curve.
  const shoreHalo = context.render.showWaterDetails !== false
    ? Math.ceil(6 * Math.max(1, presentationScale)) + 8
    : 0;
  const compositeHalo = illustrated
    ? Math.max(requestedHalo, 32, forestHalo, biomeWashHalo, poolRingHalo, shoreHalo)
    : Math.max(requestedHalo, poolRingHalo, shoreHalo);
  const detailHalo = Math.max(compositeHalo, oceanWaveHalo);
  // Support the mountain illustration needs around the core. The terrain
  // arrays cover the larger of this and the compositor's detail region.
  const mountainSupport = illustrated
    ? mountainProjectionSupportPixels(
        Math.max(presentationScale,
          getMountainPatternOptions(context.dem, context.render).scale * presentationScale),
        mountainExportLiftEnabled(context),
        normalizeMountainSnowfallSettings(
          context.render.snowfallAmount,
          context.render.snowfallDrift,
          context.render.snowfallPersistence,
          context.render.snowRedistributionSteps,
        ).redistributionSteps,
      )
      + Math.ceil(2 * Math.max(1, context.render.waterOutlineThickness ?? 1) * waterScale)
      + 4
    : 0;
  // Illustrated tiles composite on a smaller frame than the ocean-wave reach;
  // the wave frame then gets its own water-only terrain (see
  // planMountainExportTileSampling), so the full terrain arrays only need to
  // cover the compositor and the illustration.
  const separateWaveFrame = illustrated && compositeHalo < detailHalo;
  const mountainHalo = Math.max(separateWaveFrame ? compositeHalo : detailHalo, mountainSupport);
  const x = illustrated ? Math.max(0, tile.x - mountainHalo) : tile.x - mountainHalo;
  const y = illustrated ? Math.max(0, tile.y - mountainHalo) : tile.y - mountainHalo;
  const width = illustrated
    ? Math.min(outputWidth, tile.x + tile.width + mountainHalo) - x
    : tile.width + mountainHalo * 2;
  const height = illustrated
    ? Math.min(outputHeight, tile.y + tile.height + mountainHalo) - y
    : tile.height + mountainHalo * 2;
  return {
    presentationScale,
    waterScale,
    illustrated,
    detailHalo,
    compositeHalo,
    mountainHalo,
    mountainSupport,
    x,
    y,
    width,
    height,
  };
}

const exportTileOceanPresence = new WeakMap<MountainExportGlobalContext, Map<string, boolean>>();

/** Whether any ocean coverage reaches the tile core (plus bilinear support). */
function exportTileTouchesOcean(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
): boolean {
  let byTile = exportTileOceanPresence.get(context);
  if (!byTile) {
    byTile = new Map();
    exportTileOceanPresence.set(context, byTile);
  }
  const key = `${tile.x},${tile.y},${tile.width},${tile.height}`;
  const cached = byTile.get(key);
  if (cached !== undefined) return cached;
  const dem = context.dem;
  const coverage = context.oceanMaskCoverage ?? dem.isOcean;
  const touches = exportTileTouchesMask(context, tile, coverage);
  byTile.set(key, touches);
  return touches;
}

/** Include bilinear support and any effect that can reach the retained core. */
function exportTileTouchesMask(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
  coverage: ArrayLike<number>,
  padding = 0,
): boolean {
  const dem = context.dem;
  const x0 = Math.max(0, Math.floor(mapCoordinate(tile.x - padding, context.outputWidth, dem.width)) - 2);
  const x1 = Math.min(dem.width - 1,
    Math.ceil(mapCoordinate(tile.x + tile.width - 1 + padding, context.outputWidth, dem.width)) + 2);
  const y0 = Math.max(0, Math.floor(mapCoordinate(tile.y - padding, context.outputHeight, dem.height)) - 2);
  const y1 = Math.min(dem.height - 1,
    Math.ceil(mapCoordinate(tile.y + tile.height - 1 + padding, context.outputHeight, dem.height)) + 2);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (coverage[y * dem.width + x] > 0) return true;
    }
  }
  return false;
}

/** Camera exports draw straight down (90°), so the 2D oblique lift is zero. */
function mountainExportLiftEnabled(context: MountainExportGlobalContext): boolean {
  return mountainProjectionLiftCoefficient(
    context.render.mountainViewAngleDeg,
    context.render.mountainHeightExaggeration,
  ) > 0;
}

function cameraIllustrationStageLabel(
  stage: 'terrain fields' | 'lighting and snow' | 'projection and material' | 'stroke painting',
): string {
  switch (stage) {
    case 'terrain fields': return 'Preparing mountain terrain fields';
    case 'lighting and snow': return 'Preparing mountain lighting and snow';
    case 'projection and material': return 'Projecting mountain material';
    case 'stroke painting': return 'Painting mountain strokes';
  }
}

interface AxisSamplePlan {
  first: Uint32Array;
  second: Uint32Array;
  nearest: Uint32Array;
  weight: Float64Array;
}

interface TileSamplePlan {
  x: AxisSamplePlan;
  y: AxisSamplePlan;
}

function createAxisSamplePlan(
  start: number,
  length: number,
  outputSize: number,
  sourceSize: number,
): AxisSamplePlan {
  const first = new Uint32Array(length);
  const second = new Uint32Array(length);
  const nearest = new Uint32Array(length);
  const weight = new Float64Array(length);
  for (let index = 0; index < length; index++) {
    const coordinate = mapCoordinate(start + index, outputSize, sourceSize);
    const low = Math.max(0, Math.min(sourceSize - 1, Math.floor(coordinate)));
    first[index] = low;
    second[index] = Math.min(sourceSize - 1, low + 1);
    nearest[index] = Math.max(0, Math.min(sourceSize - 1, Math.round(coordinate)));
    weight[index] = coordinate - low;
  }
  return { first, second, nearest, weight };
}

function createTileSamplePlan(
  x: number,
  y: number,
  width: number,
  height: number,
  outputWidth: number,
  outputHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): TileSamplePlan {
  return {
    x: createAxisSamplePlan(x, width, outputWidth, sourceWidth),
    y: createAxisSamplePlan(y, height, outputHeight, sourceHeight),
  };
}

function samplePlannedBilinear(
  field: ArrayLike<number>,
  width: number,
  plan: TileSamplePlan,
  x: number,
  y: number,
): number {
  const x0 = plan.x.first[x];
  const x1 = plan.x.second[x];
  const y0 = plan.y.first[y];
  const y1 = plan.y.second[y];
  const tx = plan.x.weight[x];
  const ty = plan.y.weight[y];
  const top = field[y0 * width + x0] * (1 - tx) + field[y0 * width + x1] * tx;
  const bottom = field[y1 * width + x0] * (1 - tx) + field[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

function samplePlannedNearest<T extends ArrayLike<number>>(
  field: T,
  width: number,
  plan: TileSamplePlan,
  x: number,
  y: number,
): number {
  return field[plan.y.nearest[y] * width + plan.x.nearest[x]];
}

// An export context is a fixed request snapshot. Its mountain drawing is built
// once, at the selected global export-analysis resolution, just like
// vegetation geometry, and kept on the context (see ensureMountainExportPattern).
const exportMountainPathIndexes = new WeakMap<MountainExportGlobalContext, MountainPathSpatialIndex>();
const exportMaximumForestRadius = new WeakMap<MountainExportGlobalContext, number>();

function getMaximumForestRadius(context: MountainExportGlobalContext): number {
  const cached = exportMaximumForestRadius.get(context);
  if (cached !== undefined) return cached;
  const forestAssetByKey = new Map(
    (context.render.vegetation?.rasterPropAssets ?? [])
      .filter((asset) => asset.outlineGroup === 'alpine-forest')
      .map((asset) => [asset.key, asset]),
  );
  let maximumRadius = 0;
  for (const placement of context.vegetationGeometry?.rasterProps ?? []) {
    const asset = forestAssetByKey.get(placement.assetKey);
    if (!asset) continue;
    const crownWidth = placement.cellSize * (asset.renderWidthCells ?? asset.footprintWidthCells);
    const crownHeight = placement.cellSize * (asset.renderHeightCells ?? asset.footprintHeightCells);
    maximumRadius = Math.max(maximumRadius, Math.hypot(crownWidth * 0.5, crownHeight));
  }
  exportMaximumForestRadius.set(context, maximumRadius);
  return maximumRadius;
}

/**
 * The global mountain drawing for an export. It needs only the DEM and render
 * options, so the export can build it while vegetation is still being placed
 * and hand it to the context as `mountainPattern`.
 */
export function buildMountainExportPattern(
  dem: MountainDEMData,
  render: MountainRenderOptions,
  profiler?: MountainProfiler,
): MountainPatternOverlay {
  return renderMountainPatternOverlay(dem, getMountainPatternOptions(dem, render), profiler);
}

function ensureMountainExportPattern(context: MountainExportGlobalContext): MountainPatternOverlay {
  let pattern = context.mountainPattern;
  if (!pattern) {
    pattern = buildMountainExportPattern(context.dem, context.render, context.profiler);
    context.mountainPattern = pattern;
  }
  return pattern;
}

/** Returns the global surface used by the deferred export camera. */
export function getMountainExportCameraElevation(
  context: MountainExportGlobalContext,
): ArrayLike<number> {
  return ensureMountainExportPattern(context).surfaceElevation ?? context.dem.elevation;
}

/** Original global paths, never the halo-relative paths of individual tiles. */
export function getMountainExportCameraRidges(context: MountainExportGlobalContext): MountainPatternOverlay['paths'] {
  const pattern = ensureMountainExportPattern(context);
  return pattern.cameraRidgePaths ?? pattern.paths;
}

export function mapMountainPatternToExportTile(
  context: MountainExportGlobalContext,
  x: number, y: number, width: number, height: number,
): MountainPatternOverlay {
  return mapMountainPatternToExportTileWithPlan(
    context,
    x,
    y,
    width,
    height,
    createTileSamplePlan(
      x, y, width, height, context.outputWidth, context.outputHeight,
      context.dem.width, context.dem.height,
    ),
  );
}

function mapMountainPatternToExportTileWithPlan(
  context: MountainExportGlobalContext,
  x: number, y: number, width: number, height: number,
  samplePlan: TileSamplePlan,
  pathRegion?: { x: number; y: number; width: number; height: number; support: number },
): MountainPatternOverlay {
  const dem = context.dem;
  context.profiler?.recordCache('export mountain pattern', Boolean(context.mountainPattern));
  const patternStop = context.profiler?.begin('export mountain pattern');
  const pattern = ensureMountainExportPattern(context);
  patternStop?.();
  const mappingStop = context.profiler?.begin('export mountain pattern tile mapping');
  const scaleX = (context.outputWidth - 1) / Math.max(1, dem.width - 1);
  const scaleY = (context.outputHeight - 1) / Math.max(1, dem.height - 1);
  const scale = Math.min(context.outputWidth / dem.width, context.outputHeight / dem.height);
  let selectedPaths = pattern.paths;
  if (pathRegion && pattern.paths) {
    let pathIndex = exportMountainPathIndexes.get(context);
    if (!pathIndex || pathIndex.paths !== pattern.paths) {
      pathIndex = createMountainPathSpatialIndex(
        pattern.paths, dem.width, dem.height, context.outputWidth, context.outputHeight,
      );
      exportMountainPathIndexes.set(context, pathIndex);
    }
    const query = queryMountainPathSpatialIndex(
      pathIndex,
      pathRegion.x,
      pathRegion.y,
      pathRegion.width,
      pathRegion.height,
      pathRegion.support,
    );
    selectedPaths = query.paths;
    context.profiler?.recordMetric('mountain paths available', query.totalPaths, 'paths');
    context.profiler?.recordMetric('mountain path points available', query.totalPoints, 'points');
    context.profiler?.recordMetric('mountain paths selected', query.paths.length, 'paths');
    context.profiler?.recordMetric('mountain path points selected', query.selectedPoints, 'points');
  }
  const mapFloat = (field: ArrayLike<number>) => {
    const result = new Float32Array(width * height);
    for (let ty = 0; ty < height; ty++) for (let tx = 0; tx < width; tx++) {
      result[ty * width + tx] = samplePlannedBilinear(field, dem.width, samplePlan, tx, ty);
    }
    return result;
  };
  const mapByte = (field: ArrayLike<number>) => {
    const result = new Uint8Array(width * height);
    for (let ty = 0; ty < height; ty++) for (let tx = 0; tx < width; tx++) {
      // Match the prior Float32 staging array before rounding into Uint8.
      result[ty * width + tx] = Math.round(
        Math.fround(samplePlannedBilinear(field, dem.width, samplePlan, tx, ty)),
      );
    }
    return result;
  };
  const mapped = {
    coverage: mapByte(pattern.coverage),
    lineworkCoverage: mapByte(pattern.lineworkCoverage ?? pattern.coverage),
    snow: mapFloat(pattern.snow),
    wash: mapFloat(pattern.wash),
    ink: mapByte(pattern.ink),
    ridgeInk: pattern.ridgeInk
      ? mapByte(pattern.ridgeInk)
      : undefined,
    surfaceElevation: mapFloat(pattern.surfaceElevation ?? dem.elevation),
    paths: selectedPaths?.map(path => ({
      ...path,
      width: path.width * scale,
      points: path.points.map(point => ({ x: point.x * scaleX - x, y: point.y * scaleY - y })),
    })),
    cameraRidgePaths: pathRegion ? undefined : pattern.cameraRidgePaths?.map(path => ({
      ...path,
      width: path.width * scale,
      points: path.points.map(point => ({ x: point.x * scaleX - x, y: point.y * scaleY - y })),
    })),
  };
  mappingStop?.();
  return mapped;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mapCoordinate(value: number, outputSize: number, sourceSize: number): number {
  if (outputSize <= 1 || sourceSize <= 1) return 0;
  return clamp01(value / (outputSize - 1)) * (sourceSize - 1);
}

function createMappedRiverSplines(
  splines: readonly RiverSpline[] | undefined,
  globalWidth: number,
  globalHeight: number,
  outputWidth: number,
  outputHeight: number,
  tileX: number,
  tileY: number,
  tileWidth: number,
  tileHeight: number,
): RiverSpline[] | undefined {
  if (!splines) return undefined;
  const scaleX = (outputWidth - 1) / Math.max(1, globalWidth - 1);
  const scaleY = (outputHeight - 1) / Math.max(1, globalHeight - 1);
  const radiusScale = Math.min(scaleX, scaleY);
  const mapped: RiverSpline[] = [];
  for (const spline of splines) {
    if (spline.samples.length === 0) continue;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxRadius = 0;
    const samples = spline.samples.map((sample) => {
      const x = sample.x * scaleX - tileX;
      const y = sample.y * scaleY - tileY;
      const radius = sample.radius * radiusScale;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      maxRadius = Math.max(maxRadius, radius);
      return { ...sample, x, y, radius };
    });
    // `tileWidth`/`tileHeight` are the size of the whole mapped region (core
    // plus halo) measured from `tileX`/`tileY`. Keep only splines whose
    // segment bounds can touch it; the extra margin covers the raster brush.
    // Passing the core size here dropped every spline in the last halo-width
    // of a tile's right and bottom edge and left a seam of fallback water.
    const margin = maxRadius + 2;
    if (
      maxX < -margin ||
      minX > tileWidth + margin ||
      maxY < -margin ||
      minY > tileHeight + margin
    )
      continue;
    mapped.push({ key: spline.key, samples });
  }
  return mapped;
}

/** `deriveLocalTerrain`'s slope alone, with identical arithmetic, for water-only terrain. */
function deriveLocalSlope(
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
      const zNW = elevation[yPrev * width + xPrev];
      const zN = elevation[yPrev * width + x];
      const zNE = elevation[yPrev * width + xNext];
      const zW = elevation[y * width + xPrev];
      const zE = elevation[y * width + xNext];
      const zSW = elevation[yNext * width + xPrev];
      const zS = elevation[yNext * width + x];
      const zSE = elevation[yNext * width + xNext];
      const dzdx = (zNE + 2 * zE + zSE - zNW - 2 * zW - zSW) / (8 * dxMeters);
      const dzdy = (zSW + 2 * zS + zSE - zNW - 2 * zN - zNE) / (8 * dyMeters);
      slopeDeg[y * width + x] = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * (180 / Math.PI);
    }
  }
  return slopeDeg;
}

function deriveLocalTerrain(
  elevation: Float32Array,
  width: number,
  height: number,
  dxMeters: number,
  dyMeters: number,
  options: MountainRenderOptions,
): Pick<MountainDEMData, "slopeDeg" | "aspectDeg" | "normals" | "hillshade" | "ambientOcclusion" | "curvature" | "tpi"> {
  const slopeDeg = new Float32Array(elevation.length);
  const aspectDeg = new Float32Array(elevation.length);
  const normals = new Float32Array(elevation.length * 3);
  const hillshade = new Float32Array(elevation.length);
  const ambientOcclusion = new Float32Array(elevation.length);
  const curvature = new Float32Array(elevation.length);
  const tpi = new Float32Array(elevation.length);
  const verticalExaggeration = options.verticalExaggeration ?? 1;
  const sunAzimuth = ((options.sunAzimuthDeg ?? 315) * Math.PI) / 180;
  const sunAltitude = ((options.sunAltitudeDeg ?? 45) * Math.PI) / 180;
  const sun1 = [Math.sin(sunAzimuth) * Math.cos(sunAltitude), -Math.cos(sunAzimuth) * Math.cos(sunAltitude), Math.sin(sunAltitude)];
  const sun2Azimuth = sunAzimuth + Math.PI / 2;
  const sun2Altitude = (Math.max(10, (options.sunAltitudeDeg ?? 45) - 15) * Math.PI) / 180;
  const sun2 = [Math.sin(sun2Azimuth) * Math.cos(sun2Altitude), -Math.cos(sun2Azimuth) * Math.cos(sun2Altitude), Math.sin(sun2Altitude)];

  for (let y = 0; y < height; y++) {
    const yPrev = Math.max(0, y - 1);
    const yNext = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const xPrev = Math.max(0, x - 1);
      const xNext = Math.min(width - 1, x + 1);
      const index = y * width + x;
      const zC = elevation[index];
      const zNW = elevation[yPrev * width + xPrev];
      const zN = elevation[yPrev * width + x];
      const zNE = elevation[yPrev * width + xNext];
      const zW = elevation[y * width + xPrev];
      const zE = elevation[y * width + xNext];
      const zSW = elevation[yNext * width + xPrev];
      const zS = elevation[yNext * width + x];
      const zSE = elevation[yNext * width + xNext];
      const dzdx = (zNE + 2 * zE + zSE - zNW - 2 * zW - zSW) / (8 * dxMeters);
      const dzdy = (zSW + 2 * zS + zSE - zNW - 2 * zN - zNE) / (8 * dyMeters);
      const ex = dzdx * verticalExaggeration;
      const ey = dzdy * verticalExaggeration;
      const length = Math.sqrt(ex * ex + ey * ey + 1);
      const nx = -ex / length;
      const ny = -ey / length;
      const nz = 1 / length;
      normals[index * 3] = nx;
      normals[index * 3 + 1] = ny;
      normals[index * 3 + 2] = nz;
      const gradient = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
      slopeDeg[index] = Math.atan(gradient) * (180 / Math.PI);
      let aspect = Math.atan2(dzdx, -dzdy) * (180 / Math.PI);
      if (aspect < 0) aspect += 360;
      aspectDeg[index] = aspect;
      const dot1 = Math.max(0, nx * sun1[0] + ny * sun1[1] + nz * sun1[2]);
      const dot2 = Math.max(0, nx * sun2[0] + ny * sun2[1] + nz * sun2[2]);
      hillshade[index] = Math.max(0, Math.min(1, 0.22 + 0.65 * Math.pow(dot1, 0.95) + 0.13 * dot2));
      const average = (zNW + zN + zNE + zW + zE + zSW + zS + zSE) / 8;
      const elevationDifference = zC - average;
      ambientOcclusion[index] = Math.max(0.1, Math.min(1, 0.4 + 0.6 / (1 + Math.exp(-elevationDifference / 40))));
      curvature[index] = (zN + zS + zW + zE - 4 * zC) / (dxMeters * dxMeters);
      tpi[index] = elevationDifference;
    }
  }
  return { slopeDeg, aspectDeg, normals, hillshade, ambientOcclusion, curvature, tpi };
}

type NumericTileField = Float32Array | Uint8Array | Uint8ClampedArray | Int8Array;

function cropNumericTileField<T extends NumericTileField>(
  field: T,
  sourceWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
  components = 1,
): T {
  const Constructor = field.constructor as { new(length: number): T };
  const result = new Constructor(width * height * components);
  for (let row = 0; row < height; row++) {
    const sourceOffset = ((y + row) * sourceWidth + x) * components;
    const targetOffset = row * width * components;
    result.set(field.subarray(sourceOffset, sourceOffset + width * components), targetOffset);
  }
  return result;
}

function cropMountainDEM(
  source: MountainDEMData,
  x: number,
  y: number,
  width: number,
  height: number,
): MountainDEMData {
  // A full-frame crop (coastal tiles, where the wave halo equals the terrain
  // region) is read-only downstream; copying ~30 fields of a 19 Mpx tile cost
  // ~15 s and gigabytes.
  if (x === 0 && y === 0 && width === source.width && height === source.height) return source;
  const crop = <T extends NumericTileField>(field: T, components = 1): T =>
    cropNumericTileField(field, source.width, x, y, width, height, components);
  return {
    width,
    height,
    domainWidthKm: (width * source.dxMeters) / 1000,
    domainHeightKm: (height * source.dyMeters) / 1000,
    dxMeters: source.dxMeters,
    dyMeters: source.dyMeters,
    biomeRegionScaleKm: source.biomeRegionScaleKm,
    biomeEdgeNoiseScaleM: source.biomeEdgeNoiseScaleM,
    biomeEdgeStrength: source.biomeEdgeStrength,
    minElevationM: source.minElevationM,
    maxElevationM: source.maxElevationM,
    oceanSurfaceElevationM: source.oceanSurfaceElevationM,
    elevation: crop(source.elevation),
    normalizedElevation: crop(source.normalizedElevation),
    slopeDeg: crop(source.slopeDeg),
    aspectDeg: crop(source.aspectDeg),
    normals: crop(source.normals, 3),
    hillshade: crop(source.hillshade),
    ambientOcclusion: crop(source.ambientOcclusion),
    curvature: crop(source.curvature),
    tpi: crop(source.tpi),
    flowAccumulation: crop(source.flowAccumulation),
    drainageAreaKm2: crop(source.drainageAreaKm2),
    rainfallWeightedAreaKm2: crop(source.rainfallWeightedAreaKm2),
    runoffDepthMmYr: crop(source.runoffDepthMmYr),
    dischargeM3s: crop(source.dischargeM3s),
    strahlerOrder: crop(source.strahlerOrder),
    riverCenterlineMask: crop(source.riverCenterlineMask),
    isRiverChannel: crop(source.isRiverChannel),
    riverChannelRadius: source.riverChannelRadius ? crop(source.riverChannelRadius) : undefined,
    riverMouthMask: source.riverMouthMask ? crop(source.riverMouthMask) : undefined,
    riverMouthAreaKm2: source.riverMouthAreaKm2 ? crop(source.riverMouthAreaKm2) : undefined,
    waterDepthM: crop(source.waterDepthM),
    flowDirection: crop(source.flowDirection),
    erosionDepthM: crop(source.erosionDepthM),
    precipitationMmYr: crop(source.precipitationMmYr),
    solarInsolation: crop(source.solarInsolation),
    temperatureC: crop(source.temperatureC),
    biomeType: crop(source.biomeType),
    isOcean: crop(source.isOcean),
    lakeDepthM: source.lakeDepthM ? crop(source.lakeDepthM) : undefined,
    wetlandPoolMask: source.wetlandPoolMask ? crop(source.wetlandPoolMask) : undefined,
    visualWaterMask: source.visualWaterMask ? crop(source.visualWaterMask) : undefined,
    wetlandPoolCoverage: source.wetlandPoolCoverage ? crop(source.wetlandPoolCoverage) : undefined,
    visualWaterCoverage: source.visualWaterCoverage ? crop(source.visualWaterCoverage) : undefined,
    siltDepth: source.siltDepth ? crop(source.siltDepth) : undefined,
    siltCreaseDepth: source.siltCreaseDepth ? crop(source.siltCreaseDepth) : undefined,
  };
}

/** Crop every full-frame buffer of a water overlay to a sub-frame. */
function cropWaterOverlay(
  overlay: WaterOverlay,
  sourceWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
): WaterOverlay {
  const cropped: Record<string, unknown> = { ...overlay, width, height };
  for (const [key, value] of Object.entries(overlay)) {
    if (ArrayBuffer.isView(value) && (value as unknown as ArrayLike<number>).length === overlay.width * overlay.height) {
      cropped[key] = cropNumericTileField(value as unknown as NumericTileField, sourceWidth, x, y, width, height);
    }
  }
  return cropped as unknown as WaterOverlay;
}

/** Copy the illustration into the detail frame; pixels it doesn't cover stay
 * transparent (they lie in the halo, which is cropped after compositing). */
function placeMountainIllustrationPixels<T extends Uint8Array | Uint8ClampedArray>(
  pixels: T,
  channels: number,
  sourceX: number,
  sourceY: number,
  sourceWidth: number,
  sourceHeight: number,
  targetX: number,
  targetY: number,
  targetWidth: number,
  targetHeight: number,
): T {
  const result = new (pixels.constructor as new (length: number) => T)(
    targetWidth * targetHeight * channels,
  );
  const x0 = Math.max(sourceX, targetX);
  const x1 = Math.min(sourceX + sourceWidth, targetX + targetWidth);
  if (x1 <= x0) return result;
  for (let y = Math.max(sourceY, targetY); y < Math.min(sourceY + sourceHeight, targetY + targetHeight); y++) {
    const sourceOffset = ((y - sourceY) * sourceWidth + (x0 - sourceX)) * channels;
    result.set(
      pixels.subarray(sourceOffset, sourceOffset + (x1 - x0) * channels),
      ((y - targetY) * targetWidth + (x0 - targetX)) * channels,
    );
  }
  return result;
}

/** Hooks the render half of a tile reports through. */
export interface MountainExportTileHooks {
  profiler?: MountainProfiler;
  onTileStage?: (label: string) => void;
}

/** One compositor frame of an illustrated tile, with the global fields it needs. */
export interface PreparedDetailFrame {
  waterOnly: boolean;
  frame: { x: number; y: number; width: number; height: number; offsetX: number; offsetY: number };
  /**
   * Water-only frames wider than the tile terrain: just the fields the water
   * overlay reads, sampled over the whole frame, with its ocean overrides.
   */
  water?: {
    dem: MountainDEMData;
    oceanMaskCoverage: Float32Array;
    openOceanMask?: Float32Array;
    oceanDistanceToCoast?: Float32Array;
  };
  vegetationWaterDistance?: Float32Array;
  riverSplines: ReturnType<typeof createMappedRiverSplines>;
  vegetationGeometry?: ReturnType<typeof mapVegetationGeometryToTile>;
}

/**
 * Everything the render half of a tile needs, as tile-sized data: it never
 * touches the multi-GB export context, so it can be posted to another worker
 * whatever the size of the export.
 */
export interface PreparedMountainExportTile {
  tile: MountainExportTile;
  dimensions: MountainExportTileDimensions;
  outputWidth: number;
  outputHeight: number;
  /** Handed over to the renderer, which clears them to let the memory go. */
  tileDem?: MountainDEMData;
  renderOptions?: MountainRenderOptions;
  oceanDistanceToCoastMax?: number;
  /** Illustrated tiles only. */
  illustration?: {
    mountainX: number;
    mountainY: number;
    mountainWidth: number;
    mountainHeight: number;
    mappedSlopeDeg: Float32Array;
    mappedSnowTransport: MountainRenderOptions["snowTransportOverride"];
    mountainPattern: MountainPatternOverlay;
    cameraTile: boolean;
    frames: PreparedDetailFrame[];
  };
}

/** One global raster resampled onto an output-space rectangle of a tile. */
export interface ExportFieldSampleRequest {
  source: ArrayLike<number>;
  sourceWidth: number;
  sourceHeight: number;
  /** Output-pixel rectangle the samples cover. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Nearest-cell lookup for categorical fields; bilinear otherwise. */
  nearest?: boolean;
  /** Multiplies bilinear samples (e.g. distances into output pixels). */
  scale?: number;
  /**
   * Keep full precision on the CPU: these samples feed thresholds and sums,
   * so storing them as float32 first would change the tile.
   */
  precise?: boolean;
  output?: "f32" | "u8" | "i8";
}

export type ExportFieldSample = Float32Array | Float64Array | Uint8Array | Int8Array;

/** Samples tile requests, on the CPU or on the GPU; results follow request order. */
export type ExportFieldSampler = (
  requests: readonly ExportFieldSampleRequest[],
  outputWidth: number,
  outputHeight: number,
) => Promise<ExportFieldSample[]>;

/** The output-to-source sample positions of one axis, shared with the GPU sampler. */
export function createExportAxisSamplePlan(
  start: number,
  length: number,
  outputSize: number,
  sourceSize: number,
): AxisSamplePlan {
  return createAxisSamplePlan(start, length, outputSize, sourceSize);
}

/** Reference sampler: the same plan and arithmetic tile preparation always used. */
export function sampleExportFieldsCpu(
  requests: readonly ExportFieldSampleRequest[],
  outputWidth: number,
  outputHeight: number,
): ExportFieldSample[] {
  const plans = new Map<string, TileSamplePlan>();
  return requests.map((request) => {
    const planKey = `${request.x},${request.y},${request.width},${request.height},${request.sourceWidth},${request.sourceHeight}`;
    let plan = plans.get(planKey);
    if (!plan) {
      plan = createTileSamplePlan(
        request.x, request.y, request.width, request.height,
        outputWidth, outputHeight, request.sourceWidth, request.sourceHeight,
      );
      plans.set(planKey, plan);
    }
    const total = request.width * request.height;
    const output = request.precise
      ? new Float64Array(total)
      : request.output === "u8"
        ? new Uint8Array(total)
        : request.output === "i8"
          ? new Int8Array(total)
          : new Float32Array(total);
    const scale = request.scale ?? 1;
    for (let y = 0; y < request.height; y++) {
      for (let x = 0; x < request.width; x++) {
        output[y * request.width + x] = request.nearest
          ? samplePlannedNearest(request.source, request.sourceWidth, plan, x, y)
          : samplePlannedBilinear(request.source, request.sourceWidth, plan, x, y) * scale;
      }
    }
    return output;
  });
}

/** Fallback rasters for optional river fields, one per global DEM so GPU uploads are reused. */
const exportZeroFields = new WeakMap<MountainDEMData, { u8: Uint8Array; f32: Float32Array }>();

function zeroFieldsFor(dem: MountainDEMData): { u8: Uint8Array; f32: Float32Array } {
  let fields = exportZeroFields.get(dem);
  if (!fields) {
    fields = {
      u8: new Uint8Array(dem.elevation.length),
      f32: new Float32Array(dem.elevation.length),
    };
    exportZeroFields.set(dem, fields);
  }
  return fields;
}

type SampleRect = { x: number; y: number; width: number; height: number };

/** Every global field a tile samples, with the request index of each. */
interface MountainExportTileSamplingPlan {
  dimensions: MountainExportTileDimensions;
  requests: ExportFieldSampleRequest[];
  terrain: {
    oceanCoverage: number;
    openOcean?: number;
    oceanDistance?: number;
    sourceNorm: number;
    erosion: number;
    globalElevation: number;
    float: Record<
      "precipitationMmYr" | "rainfallWeightedAreaKm2" | "runoffDepthMmYr" | "dischargeM3s"
      | "flowAccumulation" | "drainageAreaKm2" | "waterDepthM" | "solarInsolation" | "temperatureC"
      | "riverMouthAreaKm2",
      number
    >;
    byte: Record<
      "biomeType" | "strahlerOrder" | "riverCenterlineMask" | "isRiverChannel"
      | "riverChannelRadius" | "riverMouthMask",
      number
    >;
    flowDirection: number;
    wetlandCoverage?: number;
    visualCoverage?: number;
    siltDepth?: number;
    siltCreaseDepth?: number;
    lakeDepthM?: number;
  };
  /** Non-illustrated tiles: wetland water distance over the whole tile. */
  vegetationWaterDistance?: number;
  /** Illustrated tiles: the mountain region and the compositor frames. */
  illustration?: {
    mountain: SampleRect;
    snow?: { roughness: number; windShelter: number; windLoading: number; slopeBreak: number };
    slopeDeg: number;
    frames: Array<{
      waterOnly: boolean;
      frame: SampleRect & { offsetX: number; offsetY: number };
      vegetationWaterDistance?: number;
      water?: WaterTerrainSlots;
    }>;
  };
}

/** Samples that compose a terrain surface: elevation, ocean and water coverage. */
interface SurfaceSlots {
  oceanCoverage: number;
  sourceNorm: number;
  erosion: number;
  globalElevation: number;
  wetlandCoverage?: number;
  visualCoverage?: number;
}

/** The fields the water overlay reads (renderWaterOverlay), for a water-only frame. */
interface WaterTerrainSlots extends SurfaceSlots {
  openOcean?: number;
  oceanDistance?: number;
  float: Record<"rainfallWeightedAreaKm2" | "drainageAreaKm2" | "riverMouthAreaKm2", number>;
  byte: Record<
    "biomeType" | "strahlerOrder" | "riverCenterlineMask" | "isRiverChannel"
    | "riverChannelRadius" | "riverMouthMask",
    number
  >;
  flowDirection: number;
  lakeDepthM?: number;
}

function planMountainExportTileSampling(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
): MountainExportTileSamplingPlan {
  const global = context.dem;
  const source = context.source;
  const outputWidth = context.outputWidth;
  const outputHeight = context.outputHeight;
  const dimensions = getMountainExportTileDimensions(context, tile);
  const {
    presentationScale,
    illustrated,
    detailHalo,
    compositeHalo,
    mountainSupport,
    x: tileX,
    y: tileY,
    width,
    height,
  } = dimensions;
  const requests: ExportFieldSampleRequest[] = [];
  const add = (
    field: ArrayLike<number>,
    rect: SampleRect,
    options: Partial<ExportFieldSampleRequest> = {},
  ): number => requests.push({
    source: field,
    sourceWidth: global.width,
    sourceHeight: global.height,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    ...options,
  }) - 1;
  const tileRect = { x: tileX, y: tileY, width, height };
  const zeros = zeroFieldsFor(global);
  const globalWetlandPoolCoverage =
    global.wetlandPoolCoverage?.length === global.elevation.length
      ? global.wetlandPoolCoverage
      : global.wetlandPoolMask;
  const globalVisualWaterCoverage =
    global.visualWaterCoverage?.length === global.elevation.length
      ? global.visualWaterCoverage
      : global.visualWaterMask;
  // The samples a terrain surface is composed from (composeTileSurface).
  const addSurface = (rect: SampleRect): SurfaceSlots => ({
    oceanCoverage: add(context.oceanMaskCoverage ?? global.isOcean, rect, { precise: true }),
    sourceNorm: add(source.luminance, rect, {
      sourceWidth: source.width,
      sourceHeight: source.height,
      precise: true,
    }),
    erosion: add(global.erosionDepthM, rect, { precise: true }),
    globalElevation: add(global.elevation, rect, { precise: true }),
    wetlandCoverage: global.wetlandPoolMask && globalWetlandPoolCoverage
      ? add(globalWetlandPoolCoverage, rect, { precise: true })
      : undefined,
    visualCoverage: global.visualWaterMask && globalVisualWaterCoverage
      ? add(globalVisualWaterCoverage, rect, { precise: true })
      : undefined,
  });
  const terrain: MountainExportTileSamplingPlan["terrain"] = {
    ...addSurface(tileRect),
    openOcean: context.openOceanMask ? add(context.openOceanMask, tileRect) : undefined,
    oceanDistance: context.oceanDistanceToCoast
      ? add(context.oceanDistanceToCoast, tileRect, { scale: presentationScale })
      : undefined,
    float: {
      precipitationMmYr: add(global.precipitationMmYr, tileRect),
      rainfallWeightedAreaKm2: add(global.rainfallWeightedAreaKm2, tileRect),
      runoffDepthMmYr: add(global.runoffDepthMmYr, tileRect),
      dischargeM3s: add(global.dischargeM3s, tileRect),
      flowAccumulation: add(global.flowAccumulation, tileRect),
      drainageAreaKm2: add(global.drainageAreaKm2, tileRect),
      waterDepthM: add(global.waterDepthM, tileRect),
      solarInsolation: add(global.solarInsolation, tileRect),
      temperatureC: add(global.temperatureC, tileRect),
      riverMouthAreaKm2: add(global.riverMouthAreaKm2 ?? zeros.f32, tileRect),
    },
    byte: {
      biomeType: add(global.biomeType, tileRect, { nearest: true, output: "u8" }),
      strahlerOrder: add(global.strahlerOrder, tileRect, { nearest: true, output: "u8" }),
      riverCenterlineMask: add(global.riverCenterlineMask, tileRect, { nearest: true, output: "u8" }),
      isRiverChannel: add(global.isRiverChannel, tileRect, { nearest: true, output: "u8" }),
      riverChannelRadius: add(global.riverChannelRadius ?? zeros.u8, tileRect, { nearest: true, output: "u8" }),
      riverMouthMask: add(global.riverMouthMask ?? zeros.u8, tileRect, { nearest: true, output: "u8" }),
    },
    flowDirection: add(global.flowDirection, tileRect, { nearest: true, output: "i8" }),
    // Silt depth is smooth, so bilinear upsampling keeps the layer edges
    // crisp at the tile's resolution.
    siltDepth: global.siltDepth ? add(global.siltDepth, tileRect) : undefined,
    siltCreaseDepth: global.siltCreaseDepth ? add(global.siltCreaseDepth, tileRect) : undefined,
    lakeDepthM: global.lakeDepthM ? add(global.lakeDepthM, tileRect) : undefined,
  };
  const plan: MountainExportTileSamplingPlan = { dimensions, requests, terrain };
  if (!illustrated) {
    if (context.vegetationWaterDistance) {
      plan.vegetationWaterDistance = add(context.vegetationWaterDistance, tileRect);
    }
    return plan;
  }
  // The illustration only has to be correct on the core; the compositor
  // uses it per pixel and the detail halo is cropped away. Build it on the
  // core plus its own support rather than on the (often much wider, e.g.
  // ocean-wave) detail region, reusing the already-sampled terrain arrays.
  const mountainX = Math.max(tileX, tile.x - mountainSupport);
  const mountainY = Math.max(tileY, tile.y - mountainSupport);
  const mountain = {
    x: mountainX,
    y: mountainY,
    width: Math.min(tileX + width, tile.x + tile.width + mountainSupport) - mountainX,
    height: Math.min(tileY + height, tile.y + tile.height + mountainSupport) - mountainY,
  };
  // The compositor frame: the core plus `halo` pixels, clipped to the output.
  const detailFrame = (halo: number) => {
    const x = Math.max(0, tile.x - halo);
    const y = Math.max(0, tile.y - halo);
    return {
      x,
      y,
      width: Math.min(outputWidth, tile.x + tile.width + halo) - x,
      height: Math.min(outputHeight, tile.y + tile.height + halo) - y,
      offsetX: x - tileX,
      offsetY: y - tileY,
    };
  };
  // Ocean waves reach far beyond every other halo, so the compositor runs on
  // a smaller frame and takes the overlay computed on the wave-sized frame.
  const splitWaveFrame = compositeHalo < detailHalo;
  const frameHalos = splitWaveFrame
    ? [{ halo: compositeHalo, waterOnly: false }, { halo: detailHalo, waterOnly: true }]
    : [{ halo: detailHalo, waterOnly: false }];
  plan.illustration = {
    mountain,
    snow: context.snowTransport
      ? {
          roughness: add(context.snowTransport.roughness, mountain),
          windShelter: add(context.snowTransport.windShelter, mountain),
          windLoading: add(context.snowTransport.windLoading, mountain),
          slopeBreak: add(context.snowTransport.slopeBreak, mountain),
        }
      : undefined,
    slopeDeg: add(global.slopeDeg, mountain),
    frames: frameHalos.map(({ halo, waterOnly }) => {
      const frame = detailFrame(halo);
      // A wave frame reaching past the tile terrain samples the water
      // overlay's own fields over its full extent instead.
      const beyondTerrain = frame.x < tileX || frame.y < tileY
        || frame.x + frame.width > tileX + width || frame.y + frame.height > tileY + height;
      return {
        waterOnly,
        frame,
        vegetationWaterDistance: context.vegetationWaterDistance && !waterOnly
          ? add(context.vegetationWaterDistance, frame)
          : undefined,
        water: waterOnly && beyondTerrain
          ? {
              ...addSurface(frame),
              openOcean: context.openOceanMask ? add(context.openOceanMask, frame) : undefined,
              oceanDistance: context.oceanDistanceToCoast
                ? add(context.oceanDistanceToCoast, frame, { scale: presentationScale })
                : undefined,
              float: {
                rainfallWeightedAreaKm2: add(global.rainfallWeightedAreaKm2, frame),
                drainageAreaKm2: add(global.drainageAreaKm2, frame),
                riverMouthAreaKm2: add(global.riverMouthAreaKm2 ?? zeros.f32, frame),
              },
              byte: {
                biomeType: add(global.biomeType, frame, { nearest: true, output: "u8" }),
                strahlerOrder: add(global.strahlerOrder, frame, { nearest: true, output: "u8" }),
                riverCenterlineMask: add(global.riverCenterlineMask, frame, { nearest: true, output: "u8" }),
                isRiverChannel: add(global.isRiverChannel, frame, { nearest: true, output: "u8" }),
                riverChannelRadius: add(global.riverChannelRadius ?? zeros.u8, frame, { nearest: true, output: "u8" }),
                riverMouthMask: add(global.riverMouthMask ?? zeros.u8, frame, { nearest: true, output: "u8" }),
              },
              flowDirection: add(global.flowDirection, frame, { nearest: true, output: "i8" }),
              lakeDepthM: global.lakeDepthM ? add(global.lakeDepthM, frame) : undefined,
            }
          : undefined,
      };
    }),
  };
  return plan;
}

/**
 * First half of rendering a tile: samples the global export context into
 * tile-sized terrain, vector and pattern inputs.
 */
export function prepareMountainExportTile(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
): PreparedMountainExportTile {
  const preparationStop = context.profiler?.begin("export tile preparation");
  const plan = planMountainExportTileSampling(context, tile);
  logMountainExportTile(context, tile, plan.dimensions);
  context.onTileStage?.("Preparing tile terrain arrays");
  const samplingStop = context.profiler?.begin("export tile field sampling");
  const samples = sampleExportFieldsCpu(plan.requests, context.outputWidth, context.outputHeight);
  samplingStop?.();
  const prepared = finishMountainExportTile(context, tile, plan, samples);
  preparationStop?.();
  return prepared;
}

/**
 * `prepareMountainExportTile` with the field sampling done by `sampler`
 * (the GPU sampler in exports). Everything after sampling is shared.
 */
export async function prepareMountainExportTileWithSampler(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
  sampler: ExportFieldSampler,
): Promise<PreparedMountainExportTile> {
  const plan = planMountainExportTileSampling(context, tile);
  logMountainExportTile(context, tile, plan.dimensions);
  context.onTileStage?.("Sampling tile terrain on the GPU");
  const samplingStarted = performance.now();
  const samples = await sampler(plan.requests, context.outputWidth, context.outputHeight);
  context.profiler?.recordExternalStage("export tile GPU field sampling", performance.now() - samplingStarted);
  const preparationStop = context.profiler?.begin("export tile preparation");
  const prepared = finishMountainExportTile(context, tile, plan, samples);
  preparationStop?.();
  return prepared;
}

/** The request list a tile samples, for checking a sampler against the CPU. */
export function getMountainExportTileSampleRequests(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
): ExportFieldSampleRequest[] {
  return planMountainExportTileSampling(context, tile).requests;
}

function logMountainExportTile(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
  dimensions: MountainExportTileDimensions,
): void {
  const { presentationScale, detailHalo, mountainSupport, width, height } = dimensions;
  const total = width * height;
  // Printed immediately (not in the end-of-export report) so a crash still
  // leaves the size of the tile that was being built.
  if (context.profiler) {
    console.log(
      `[mountain export] tile ${tile.x},${tile.y} core ${tile.width}x${tile.height} ` +
      `expanded ${width}x${height} (${(total / 1e6).toFixed(1)} Mpx) ` +
      `detailHalo ${detailHalo} mountainSupport ${mountainSupport} scale ${presentationScale.toFixed(2)}`,
    );
  }
  context.profiler?.recordMetric('tile interior width', tile.width, 'pixels');
  context.profiler?.recordMetric('tile interior height', tile.height, 'pixels');
  context.profiler?.recordMetric('tile expanded width', width, 'pixels');
  context.profiler?.recordMetric('tile expanded height', height, 'pixels');
  context.profiler?.recordMetric('tile interior pixels', tile.width * tile.height, 'pixels');
  context.profiler?.recordMetric('tile expanded pixels', width * height, 'pixels');
  context.profiler?.recordMetric('tile halo pixels', Math.max(0, width * height - tile.width * tile.height), 'pixels');
}

/**
 * Elevation, ocean and water coverage of a tile region from its surface
 * samples. Thresholds and the elevation sum use the samples as given, so the
 * CPU path keeps its double-precision results.
 */
function composeTileSurface(
  global: MountainDEMData,
  total: number,
  samples: readonly ExportFieldSample[],
  slots: SurfaceSlots,
) {
  const elevation = new Float32Array(total);
  const normalizedElevation = new Float32Array(total);
  const isOcean = new Uint8Array(total);
  const oceanMaskCoverage = new Float32Array(total);
  const erosionDepthM = new Float32Array(total);
  const wetlandPoolMask = global.wetlandPoolMask ? new Uint8Array(total) : undefined;
  const wetlandPoolCoverage = global.wetlandPoolMask ? new Float32Array(total) : undefined;
  const visualWaterMask = global.visualWaterMask ? new Uint8Array(total) : undefined;
  const visualWaterCoverage = global.visualWaterMask ? new Float32Array(total) : undefined;
  const oceanCoverageSamples = samples[slots.oceanCoverage];
  const sourceNormSamples = samples[slots.sourceNorm];
  const erosionSamples = samples[slots.erosion];
  const globalElevationSamples = samples[slots.globalElevation];
  const wetlandSamples = slots.wetlandCoverage !== undefined ? samples[slots.wetlandCoverage] : undefined;
  const visualSamples = slots.visualCoverage !== undefined ? samples[slots.visualCoverage] : undefined;
  const minElevationM = global.minElevationM;
  const elevationRange = Math.max(1, global.maxElevationM - minElevationM);
  for (let index = 0; index < total; index++) {
    const coverage = oceanCoverageSamples[index];
    const ocean = coverage >= 0.5;
    oceanMaskCoverage[index] = coverage;
    isOcean[index] = ocean ? 1 : 0;
    const baseElevation = minElevationM + clamp01(sourceNormSamples[index]) * elevationRange;
    const erosion = erosionSamples[index];
    elevation[index] = ocean
      ? globalElevationSamples[index]
      : Math.max(minElevationM, baseElevation - erosion);
    normalizedElevation[index] = clamp01((elevation[index] - minElevationM) / elevationRange);
    erosionDepthM[index] = erosion;
    if (wetlandPoolMask && wetlandPoolCoverage && wetlandSamples) {
      const wetland = wetlandSamples[index];
      wetlandPoolCoverage[index] = wetland;
      wetlandPoolMask[index] = wetland >= 0.5 ? 1 : 0;
    }
    if (visualWaterMask && visualWaterCoverage && visualSamples) {
      const visual = visualSamples[index];
      visualWaterCoverage[index] = visual;
      visualWaterMask[index] = visual >= 0.5 ? 1 : 0;
    }
  }
  return {
    elevation,
    normalizedElevation,
    isOcean,
    oceanMaskCoverage,
    erosionDepthM,
    wetlandPoolMask,
    wetlandPoolCoverage,
    visualWaterMask,
    visualWaterCoverage,
  };
}

/**
 * The water overlay's terrain for a wave frame wider than the tile terrain:
 * only the fields renderWaterOverlay reads, the rest left empty.
 */
function composeWaterFrameTerrain(
  global: MountainDEMData,
  samples: readonly ExportFieldSample[],
  slots: WaterTerrainSlots,
  width: number,
  height: number,
  dxMeters: number,
  dyMeters: number,
): NonNullable<PreparedDetailFrame["water"]> {
  const surface = composeTileSurface(global, width * height, samples, slots);
  const float = (index: number): Float32Array => samples[index] as Float32Array;
  const empty = () => new Float32Array(0);
  const dem: MountainDEMData = {
    width,
    height,
    domainWidthKm: (width * dxMeters) / 1000,
    domainHeightKm: (height * dyMeters) / 1000,
    dxMeters,
    dyMeters,
    biomeRegionScaleKm: global.biomeRegionScaleKm,
    biomeEdgeNoiseScaleM: global.biomeEdgeNoiseScaleM,
    biomeEdgeStrength: global.biomeEdgeStrength,
    minElevationM: global.minElevationM,
    maxElevationM: global.maxElevationM,
    oceanSurfaceElevationM: global.oceanSurfaceElevationM,
    elevation: surface.elevation,
    normalizedElevation: surface.normalizedElevation,
    slopeDeg: deriveLocalSlope(surface.elevation, width, height, dxMeters, dyMeters),
    aspectDeg: empty(),
    normals: empty(),
    hillshade: empty(),
    ambientOcclusion: empty(),
    curvature: empty(),
    tpi: empty(),
    flowAccumulation: empty(),
    drainageAreaKm2: float(slots.float.drainageAreaKm2),
    rainfallWeightedAreaKm2: float(slots.float.rainfallWeightedAreaKm2),
    runoffDepthMmYr: empty(),
    dischargeM3s: empty(),
    strahlerOrder: samples[slots.byte.strahlerOrder] as Uint8Array,
    riverCenterlineMask: samples[slots.byte.riverCenterlineMask] as Uint8Array,
    isRiverChannel: samples[slots.byte.isRiverChannel] as Uint8Array,
    riverChannelRadius: samples[slots.byte.riverChannelRadius] as Uint8Array,
    riverMouthMask: samples[slots.byte.riverMouthMask] as Uint8Array,
    riverMouthAreaKm2: float(slots.float.riverMouthAreaKm2),
    waterDepthM: empty(),
    flowDirection: samples[slots.flowDirection] as Int8Array,
    erosionDepthM: surface.erosionDepthM,
    precipitationMmYr: empty(),
    solarInsolation: empty(),
    temperatureC: empty(),
    biomeType: samples[slots.byte.biomeType] as Uint8Array,
    isOcean: surface.isOcean,
    ...(surface.wetlandPoolMask && surface.wetlandPoolCoverage
      ? { wetlandPoolMask: surface.wetlandPoolMask, wetlandPoolCoverage: surface.wetlandPoolCoverage }
      : {}),
    ...(surface.visualWaterMask && surface.visualWaterCoverage
      ? { visualWaterMask: surface.visualWaterMask, visualWaterCoverage: surface.visualWaterCoverage }
      : {}),
    lakeDepthM: slots.lakeDepthM !== undefined ? float(slots.lakeDepthM) : undefined,
  };
  return {
    dem,
    oceanMaskCoverage: surface.oceanMaskCoverage,
    openOceanMask: slots.openOcean !== undefined ? float(slots.openOcean) : undefined,
    oceanDistanceToCoast: slots.oceanDistance !== undefined ? float(slots.oceanDistance) : undefined,
  };
}

/** Second step of tile preparation: builds the tile DEM and maps vectors from the samples. */
function finishMountainExportTile(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
  plan: MountainExportTileSamplingPlan,
  samples: readonly ExportFieldSample[],
): PreparedMountainExportTile {
  const global = context.dem;
  const outputWidth = context.outputWidth;
  const outputHeight = context.outputHeight;
  const { dimensions, terrain } = plan;
  const {
    presentationScale,
    waterScale,
    illustrated,
    x: tileX,
    y: tileY,
    width,
    height,
  } = dimensions;
  const total = width * height;
  const terrainPreparationStop = context.profiler?.begin('export tile terrain preparation');
  const float = (index: number): Float32Array => samples[index] as Float32Array;
  const {
    elevation,
    normalizedElevation,
    isOcean,
    oceanMaskCoverage,
    erosionDepthM,
    wetlandPoolMask,
    wetlandPoolCoverage,
    visualWaterMask,
    visualWaterCoverage,
  } = composeTileSurface(global, total, samples, terrain);
  const oceanDistanceToCoast = terrain.oceanDistance !== undefined ? float(terrain.oceanDistance) : undefined;
  const openOceanMask = terrain.openOcean !== undefined ? float(terrain.openOcean) : undefined;
  const arrays = {
    precipitationMmYr: float(terrain.float.precipitationMmYr),
    rainfallWeightedAreaKm2: float(terrain.float.rainfallWeightedAreaKm2),
    runoffDepthMmYr: float(terrain.float.runoffDepthMmYr),
    dischargeM3s: float(terrain.float.dischargeM3s),
    flowAccumulation: float(terrain.float.flowAccumulation),
    drainageAreaKm2: float(terrain.float.drainageAreaKm2),
    waterDepthM: float(terrain.float.waterDepthM),
    erosionDepthM,
    solarInsolation: float(terrain.float.solarInsolation),
    temperatureC: float(terrain.float.temperatureC),
    biomeType: samples[terrain.byte.biomeType] as Uint8Array,
    strahlerOrder: samples[terrain.byte.strahlerOrder] as Uint8Array,
    riverCenterlineMask: samples[terrain.byte.riverCenterlineMask] as Uint8Array,
    isRiverChannel: samples[terrain.byte.isRiverChannel] as Uint8Array,
    riverChannelRadius: samples[terrain.byte.riverChannelRadius] as Uint8Array,
    riverMouthMask: samples[terrain.byte.riverMouthMask] as Uint8Array,
    riverMouthAreaKm2: float(terrain.float.riverMouthAreaKm2),
    flowDirection: samples[terrain.flowDirection] as Int8Array,
  };
  const dxMeters = (global.domainWidthKm * 1000) / outputWidth;
  const dyMeters = (global.domainHeightKm * 1000) / outputHeight;
  const siltDepth = terrain.siltDepth !== undefined ? float(terrain.siltDepth) : undefined;
  const siltCreaseDepth = terrain.siltCreaseDepth !== undefined ? float(terrain.siltCreaseDepth) : undefined;
  const lakeDepthM = terrain.lakeDepthM !== undefined ? float(terrain.lakeDepthM) : undefined;
  const localTerrain = deriveLocalTerrain(elevation, width, height, dxMeters, dyMeters, context.render);
  let tileDem: MountainDEMData | undefined = {
    width,
    height,
    domainWidthKm: (width * dxMeters) / 1000,
    domainHeightKm: (height * dyMeters) / 1000,
    dxMeters,
    dyMeters,
    biomeRegionScaleKm: global.biomeRegionScaleKm,
    biomeEdgeNoiseScaleM: global.biomeEdgeNoiseScaleM,
    biomeEdgeStrength: global.biomeEdgeStrength,
    minElevationM: global.minElevationM,
    maxElevationM: global.maxElevationM,
    oceanSurfaceElevationM: global.oceanSurfaceElevationM,
    elevation,
    normalizedElevation,
    ...localTerrain,
    ...arrays,
    isOcean,
    ...(wetlandPoolMask && wetlandPoolCoverage
      ? { wetlandPoolMask, wetlandPoolCoverage }
      : {}),
    ...(visualWaterMask && visualWaterCoverage
      ? { visualWaterMask, visualWaterCoverage }
      : {}),
    siltDepth,
    siltCreaseDepth,
    lakeDepthM,
  };
  terrainPreparationStop?.();
  context.onTileStage?.("Mapping tile vectors and props");
  const tileMappingStop = context.profiler?.begin('export tile mapping');
  const mappedRiverSplines = illustrated
    ? undefined
    : createMappedRiverSplines(
        context.riverSplines,
        global.width,
        global.height,
        outputWidth,
        outputHeight,
        tileX,
        tileY,
        width,
        height,
      );
  const mappedVegetationGeometry = !illustrated && context.vegetationGeometry
    ? mapVegetationGeometryToTile(
        context.vegetationGeometry,
        outputWidth,
        outputHeight,
        tileX,
        tileY,
        width,
        height,
        context.render.vegetation?.rasterPropAssets,
      )
    : undefined;
  const mappedVegetationWaterDistance = plan.vegetationWaterDistance !== undefined
    ? float(plan.vegetationWaterDistance)
    : undefined;
  tileMappingStop?.();
  // Presentation controls are authored in preview pixels. Scale physical
  // stroke/radius/mark lengths and adjust density so the same visual spacing
  // survives at the output resolution; counts, smoothing passes, and material
  // UV scale remain resolution-independent.
  const forestOutputScale = presentationScale *
    (Math.max(global.width, global.height) / FOREST_REFERENCE_LONG_EDGE);
  let renderOptions: MountainRenderOptions | undefined = {
    ...context.render,
    deferFullTerrainCamera: context.render.fullTerrainCameraElevationDeg !== undefined,
    vegetation: context.render.vegetation || illustrated
      ? {
          ...context.render.vegetation,
          // Geometry is already mapped globally; only the raster dash cadence
          // still needs the presentation scale at export resolution.
          patternScale:
            (context.render.vegetation?.patternScale ?? 1) * presentationScale,
          coordinateOffsetX: tileX,
          coordinateOffsetY: tileY,
          coordinateStride: outputWidth,
          coordinateHeight: outputHeight,
          coordinateSourceWidth: global.width,
          coordinateSourceHeight: global.height,
          coordinatePatternScale: context.render.vegetation?.patternScale ?? 1,
          // Keep charcoal, shadows, and texture marks at the same map-relative
          // size as the 2048px live preview.
          forestRenderScale: forestOutputScale,
          waterDistanceOverride: mappedVegetationWaterDistance,
        }
      : undefined,
    ...scaleWaterPresentationOptions(context.render, waterScale),
    mountainPatternPixelScale: presentationScale,
    oceanCoordinateOffsetX: tileX,
    oceanCoordinateOffsetY: tileY,
    oceanCoordinateStride: outputWidth,
    distanceSmoothingIterations: 0,
    effectiveDistanceSmoothingIterations: 0,
    oceanDistanceToCoastOverride: oceanDistanceToCoast,
    openOceanMaskOverride: openOceanMask,
    oceanDistanceNormalizationMax: context.oceanDistanceToCoastMax
      ? context.oceanDistanceToCoastMax * presentationScale
      : undefined,
    oceanMaskCoverageOverride: oceanMaskCoverage,
    riverSplinesOverride: mappedRiverSplines,
    vegetationGeometryOverride: mappedVegetationGeometry,
    textureCoordinateOffsetX: tileX,
    textureCoordinateOffsetY: tileY,
    textureCoordinateDomainWidth: outputWidth,
    textureCoordinateDomainHeight: outputHeight,
    wetlandPuddleCoordinateOffsetX: tileX,
    wetlandPuddleCoordinateOffsetY: tileY,
    wetlandPuddleCoordinateDomainWidth: outputWidth,
    wetlandPuddleCoordinateDomainHeight: outputHeight,
  };
  let illustration: PreparedMountainExportTile["illustration"];
  if (plan.illustration) {
    const { mountain, snow } = plan.illustration;
    const { x: mountainX, y: mountainY, width: mountainWidth, height: mountainHeight } = mountain;
    const expandedSamplePlan = createTileSamplePlan(
      mountainX, mountainY, mountainWidth, mountainHeight,
      outputWidth, outputHeight, global.width, global.height,
    );
    const mappedSnowTransport = snow
      ? {
          roughness: float(snow.roughness),
          windShelter: float(snow.windShelter),
          windLoading: float(snow.windLoading),
          slopeBreak: float(snow.slopeBreak),
        }
      : undefined;
    // Preserve ridge topology, charcoal seeds, and snow accumulation from
    // the global preview. Re-detecting them per tile changes the drawing when
    // a distant crest enters a tile's support region or output size changes.
    const cameraTile = context.render.fullTerrainCameraElevationDeg !== undefined;
    const exportScale = Math.max(
      outputWidth / Math.max(1, global.width),
      outputHeight / Math.max(1, global.height),
    );
    const pathProjectionScale = Math.max(
      exportScale,
      getMountainPatternOptions(context.dem, context.render).scale * exportScale,
    );
    context.onTileStage?.("Mapping mountain pattern and nearby paths");
    const mountainPattern = mapMountainPatternToExportTileWithPlan(
      context,
      mountainX,
      mountainY,
      mountainWidth,
      mountainHeight,
      expandedSamplePlan,
      cameraTile
        ? {
            x: mountainX,
            y: mountainY,
            width: mountainWidth,
            height: mountainHeight,
            // Keep projected path points, the largest ridge join bridge and
            // its endpoint overlap. Valley support applies to terrain-field
            // construction, while these global vectors move at most max lift.
            support: ((mountainExportLiftEnabled(context) ? MOUNTAIN_MAX_LIFT_PIXELS : 0) + 44)
              * pathProjectionScale,
          }
        : undefined,
    );

    const mappedSlopeDeg = float(plan.illustration.slopeDeg);
    // The global fields each compositor frame maps for itself.
    const frames = plan.illustration.frames.map(({ waterOnly, frame, vegetationWaterDistance, water }): PreparedDetailFrame => {
      const { x: detailTileX, y: detailTileY, width: detailWidth, height: detailHeight } = frame;
      return {
        waterOnly,
        frame,
        water: water
          ? composeWaterFrameTerrain(global, samples, water, detailWidth, detailHeight, dxMeters, dyMeters)
          : undefined,
        vegetationWaterDistance: vegetationWaterDistance !== undefined
          ? float(vegetationWaterDistance)
          : undefined,
        riverSplines: createMappedRiverSplines(
          context.riverSplines,
          global.width,
          global.height,
          outputWidth,
          outputHeight,
          detailTileX,
          detailTileY,
          detailWidth,
          detailHeight,
        ),
        vegetationGeometry: context.vegetationGeometry && !waterOnly
          ? mapVegetationGeometryToTile(
              context.vegetationGeometry,
              outputWidth,
              outputHeight,
              detailTileX,
              detailTileY,
              detailWidth,
              detailHeight,
              context.render.vegetation?.rasterPropAssets,
            )
          : undefined,
      };
    });
    illustration = {
      mountainX,
      mountainY,
      mountainWidth,
      mountainHeight,
      mappedSlopeDeg,
      mappedSnowTransport,
      mountainPattern,
      cameraTile,
      frames,
    };
  }
  return {
    tile,
    dimensions,
    outputWidth,
    outputHeight,
    tileDem,
    renderOptions,
    oceanDistanceToCoastMax: context.oceanDistanceToCoastMax,
    illustration,
  };
}

/**
 * Second half of rendering a tile: works only on the prepared inputs. Illustrated
 * mountain geometry gets an expanded support region, while the regular map
 * compositor keeps its modest requested halo before the core is cropped.
 */
export function renderPreparedMountainExportTile(
  prepared: PreparedMountainExportTile,
  hooks: MountainExportTileHooks,
  prepareMountainIllustration?: MountainExportIllustrationPreparation,
): MountainDetailImageData | Promise<MountainDetailImageData> {
  const tileStop = hooks.profiler?.begin("export tile rendering");
  const { tile, dimensions } = prepared;
  const {
    presentationScale,
    illustrated,
    detailHalo,
    compositeHalo,
    x: tileX,
    y: tileY,
    width,
    height,
  } = dimensions;
  let tileDem: MountainDEMData | undefined = prepared.tileDem;
  let renderOptions: MountainRenderOptions | undefined = prepared.renderOptions;
  const oceanMaskCoverage = renderOptions!.oceanMaskCoverageOverride as Float32Array;
  const openOceanMask = renderOptions!.openOceanMaskOverride;
  const oceanDistanceToCoast = renderOptions!.oceanDistanceToCoastOverride;
  // The caller keeps no reference, so these can be freed once the tile is done.
  prepared.tileDem = undefined;
  prepared.renderOptions = undefined;
  let rendered: MountainDetailImageData;
  let renderedX = tileX;
  let renderedY = tileY;
  let renderedWidth = width;
  let renderedHeight = height;
  const finishTile = (): MountainDetailImageData => {
    const sourceX = tile.x - renderedX;
    const sourceY = tile.y - renderedY;
    if (
      sourceX === 0 &&
      sourceY === 0 &&
      renderedWidth === tile.width &&
      renderedHeight === tile.height
    ) {
      tileStop?.();
      return rendered;
    }
    hooks.onTileStage?.("Cropping camera texture tile");
    const assemblyStop = hooks.profiler?.begin('export tile assembly');
    const core = new Uint8ClampedArray(tile.width * tile.height * 4);
    const foreground = rendered.foregroundPropsRGBA;
    const foregroundCore = foreground && foreground.length === renderedWidth * renderedHeight * 4
      ? new Uint8ClampedArray(tile.width * tile.height * 4)
      : undefined;
    const cover = rendered.standCover;
    const coverCore = cover && cover.length === renderedWidth * renderedHeight
      ? new Uint8Array(tile.width * tile.height)
      : undefined;
    for (let y = 0; y < tile.height; y++) {
      const sourceOffset = ((y + sourceY) * renderedWidth + sourceX) * 4;
      core.set(rendered.data.subarray(sourceOffset, sourceOffset + tile.width * 4), y * tile.width * 4);
      if (foregroundCore && foreground) {
        foregroundCore.set(
          foreground.subarray(sourceOffset, sourceOffset + tile.width * 4),
          y * tile.width * 4,
        );
      }
      if (coverCore && cover) {
        const coverOffset = (y + sourceY) * renderedWidth + sourceX;
        coverCore.set(cover.subarray(coverOffset, coverOffset + tile.width), y * tile.width);
      }
    }
    assemblyStop?.();
    tileStop?.();
    const result = (typeof ImageData !== "undefined"
      ? new ImageData(core, tile.width, tile.height)
      : { width: tile.width, height: tile.height, data: core } as unknown as ImageData) as MountainDetailImageData;
    if (foregroundCore) result.foregroundPropsRGBA = foregroundCore;
    if (coverCore) result.standCover = coverCore;
    return result;
  };
  if (illustrated) {
    hooks.onTileStage?.("Preparing mountain tile detail");
    const illustrationPreparationStop = hooks.profiler?.begin('export tile illustration preparation');
    const expandedTileDem = tileDem!;
    const expandedRenderOptions = renderOptions!;
    // Over the tile terrain and any wider wave-frame terrain together, which
    // is the region a single terrain covered before the wave frame split off.
    let heightmapLowerLimitM = -10;
    let maxErosionDepthM = 0;
    const extentDems = [
      expandedTileDem,
      ...prepared.illustration!.frames.flatMap(frame => (frame.water ? [frame.water.dem] : [])),
    ];
    for (const extentDem of extentDems) {
      for (const elevationValue of extentDem.elevation) {
        heightmapLowerLimitM = Math.min(heightmapLowerLimitM, elevationValue);
      }
      for (const erosionDepth of extentDem.erosionDepthM) {
        maxErosionDepthM = Math.max(maxErosionDepthM, erosionDepth);
      }
    }
    const {
      mountainX,
      mountainY,
      mountainWidth,
      mountainHeight,
      mappedSlopeDeg,
      mappedSnowTransport,
      mountainPattern,
      cameraTile,
    } = prepared.illustration!;
    const mountainDem = cropMountainDEM(
      expandedTileDem,
      mountainX - tileX,
      mountainY - tileY,
      mountainWidth,
      mountainHeight,
    );
    const stageDem: MountainDEMData = {
      ...mountainDem,
      slopeDeg: mappedSlopeDeg,
    };
    const stageOptions: MountainRenderOptions = {
      ...expandedRenderOptions,
      snowTransportOverride: mappedSnowTransport,
      // World-anchored grain and noise follow the region's own origin.
      oceanCoordinateOffsetX: mountainX,
      oceanCoordinateOffsetY: mountainY,
      textureCoordinateOffsetX: mountainX,
      textureCoordinateOffsetY: mountainY,
      wetlandPuddleCoordinateOffsetX: mountainX,
      wetlandPuddleCoordinateOffsetY: mountainY,
      vegetation: expandedRenderOptions.vegetation
        ? {
            ...expandedRenderOptions.vegetation,
            coordinateOffsetX: mountainX,
            coordinateOffsetY: mountainY,
          }
        : undefined,
    };
    const fieldCache = createMountainFieldCache();
    hooks.onTileStage?.("Preparing mountain illustration fields");
    const stageInputs = buildMountainIllustrationStageInputs(
      stageDem,
      stageOptions,
      undefined,
      mountainPattern,
      hooks.profiler,
      fieldCache,
    );
    const finishIllustrated = (
      mountainStage: MountainIllustration | MountainCameraIllustrationLayers | undefined,
    ): ImageData => {
    hooks.onTileStage?.(cameraTile ? "Composing camera illustration texture" : "Preparing mountain illustration texture");
    const cameraStyle: MountainCameraIllustrationStyle = {
      hatchColor: expandedRenderOptions.mountainHatchColor ?? expandedRenderOptions.vegetation?.inkColor,
      hatchOpacity:
        expandedRenderOptions.mountainHatchOpacity ??
        expandedRenderOptions.mountainLineworkOpacity ??
        expandedRenderOptions.vegetation?.strokeOpacity ??
        expandedRenderOptions.waterOutlineOpacity ??
        0.8,
      horizontalHatchOpacity:
        expandedRenderOptions.mountainHatchHorizontalOpacity ??
        expandedRenderOptions.mountainHatchOpacity ??
        expandedRenderOptions.mountainLineworkOpacity ??
        expandedRenderOptions.vegetation?.strokeOpacity ??
        expandedRenderOptions.waterOutlineOpacity ??
        0.8,
      verticalHatchOpacity:
        expandedRenderOptions.mountainHatchVerticalOpacity ??
        expandedRenderOptions.mountainHatchOpacity ??
        expandedRenderOptions.mountainLineworkOpacity ??
        expandedRenderOptions.vegetation?.strokeOpacity ??
        expandedRenderOptions.waterOutlineOpacity ??
        0.8,
    };
    const cameraTexture = mountainStage && cameraTile
      ? mountainCameraIllustrationTexture(mountainStage as MountainCameraIllustrationLayers, cameraStyle)
      : undefined;
    // Ink coverage of the same texture keeps the compositor's washes off it.
    const mountainInkAlpha = mountainStage
      ? cameraTile
        ? mountainCameraIllustrationInkAlpha(mountainStage as MountainCameraIllustrationLayers, cameraStyle)
        : mountainIllustrationInkAlpha(mountainStage as MountainIllustration)
      : undefined;
    // `waterOnly` frames feed just the ocean-wave water overlay, so they skip
    // the illustration and vegetation inputs that the compositor frame needs.
    const buildDetailFrame = (waterOnly: boolean) => {
    const preparedFrame = prepared.illustration!.frames.find(candidate => candidate.waterOnly === waterOnly)!;
    const frame = preparedFrame.frame;
    const {
      x: detailTileX,
      y: detailTileY,
      width: detailWidth,
      height: detailHeight,
      offsetX: detailOffsetX,
      offsetY: detailOffsetY,
    } = frame;
    const water = preparedFrame.water;
    const detailDem = water
      ? water.dem
      : cropMountainDEM(
          expandedTileDem,
          detailOffsetX,
          detailOffsetY,
          detailWidth,
          detailHeight,
        );
    const mountainIllustrationRGBA = mountainStage && !waterOnly
      ? placeMountainIllustrationPixels(
          cameraTile
            ? cameraTexture!
            : (mountainStage as MountainIllustration).rgba,
          4,
          mountainX, mountainY, mountainWidth, mountainHeight,
          detailTileX, detailTileY, detailWidth, detailHeight,
        )
      : undefined;
    const mountainIllustrationInkAlpha = mountainInkAlpha && !waterOnly
      ? placeMountainIllustrationPixels(
          mountainInkAlpha,
          1,
          mountainX, mountainY, mountainWidth, mountainHeight,
          detailTileX, detailTileY, detailWidth, detailHeight,
        )
      : undefined;
    // The rock and snow without linework, for the ground under forest stands.
    const mountainIllustrationMaterialRGBA = mountainStage && !waterOnly
      ? placeMountainIllustrationPixels(
          mountainStage.materialRgba,
          4,
          mountainX, mountainY, mountainWidth, mountainHeight,
          detailTileX, detailTileY, detailWidth, detailHeight,
        )
      : undefined;
    const detailOceanMaskCoverage = water
      ? water.oceanMaskCoverage
      : cropNumericTileField(
          oceanMaskCoverage,
          width,
          detailOffsetX,
          detailOffsetY,
          detailWidth,
          detailHeight,
        );
    const detailOpenOceanMask = water
      ? water.openOceanMask
      : openOceanMask
        ? cropNumericTileField(
            openOceanMask,
            width,
            detailOffsetX,
            detailOffsetY,
            detailWidth,
            detailHeight,
          )
        : undefined;
    const detailOceanDistanceToCoast = water
      ? water.oceanDistanceToCoast
      : oceanDistanceToCoast
        ? cropNumericTileField(
            oceanDistanceToCoast,
            width,
            detailOffsetX,
            detailOffsetY,
            detailWidth,
            detailHeight,
          )
        : undefined;
    const detailVegetationWaterDistance = preparedFrame.vegetationWaterDistance;
    const detailRiverSplines = preparedFrame.riverSplines;
    const detailVegetationGeometry = preparedFrame.vegetationGeometry;
    const coreWindow = {
      x0: tile.x - detailTileX,
      y0: tile.y - detailTileY,
      x1: tile.x - detailTileX + tile.width,
      y1: tile.y - detailTileY + tile.height,
    };
    const detailOptions: MountainRenderOptions = {
      ...expandedRenderOptions,
      // The illustration is supplied below; the compositor never rebuilds
      // snow from these fields.
      snowTransportOverride: undefined,
      vegetation: expandedRenderOptions.vegetation
        ? {
            ...expandedRenderOptions.vegetation,
            coordinateOffsetX: detailTileX,
            coordinateOffsetY: detailTileY,
            waterDistanceOverride: detailVegetationWaterDistance,
          }
        : undefined,
      oceanCoordinateOffsetX: detailTileX,
      oceanCoordinateOffsetY: detailTileY,
      oceanDistanceToCoastOverride: detailOceanDistanceToCoast,
      openOceanMaskOverride: detailOpenOceanMask,
      oceanDistanceNormalizationMax: prepared.oceanDistanceToCoastMax
        ? prepared.oceanDistanceToCoastMax * presentationScale
        : undefined,
      oceanMaskCoverageOverride: detailOceanMaskCoverage,
      riverSplinesOverride: detailRiverSplines,
      vegetationGeometryOverride: detailVegetationGeometry,
      textureCoordinateOffsetX: detailTileX,
      textureCoordinateOffsetY: detailTileY,
      wetlandPuddleCoordinateOffsetX: detailTileX,
      wetlandPuddleCoordinateOffsetY: detailTileY,
      waterPaintWindow: coreWindow,
      compositionWindow: coreWindow,
      heightmapLowerLimitMOverride: heightmapLowerLimitM,
      maxErosionDepthMOverride: maxErosionDepthM,
      mountainIllustrationRGBA,
      mountainIllustrationInkAlpha,
      mountainIllustrationMaterialRGBA,
    };
    return { frame, dem: detailDem, options: detailOptions };
    };
    // Ocean waves reach far beyond every other halo (and only the water overlay
    // needs that reach), so the compositor runs on the smaller frame and takes
    // the overlay computed on the wave-sized frame, cropped to match.
    const splitWaveFrame = compositeHalo < detailHalo;
    const compositeFrame = buildDetailFrame(false);
    const waveFrame = splitWaveFrame ? buildDetailFrame(true) : undefined;
    illustrationPreparationStop?.();
    tileDem = undefined;
    renderOptions = undefined;
    hooks.onTileStage?.("Compositing mountain tile");
    const detailRenderStop = hooks.profiler?.begin('export tile detail composition');
    if (waveFrame) {
      const waveOverlay = renderMountainWaterOverlay(waveFrame.dem, waveFrame.options, hooks.profiler);
      if (waveOverlay) {
        compositeFrame.options.waterOverlayOverride = cropWaterOverlay(
          waveOverlay,
          waveFrame.frame.width,
          compositeFrame.frame.x - waveFrame.frame.x,
          compositeFrame.frame.y - waveFrame.frame.y,
          compositeFrame.frame.width,
          compositeFrame.frame.height,
        );
      }
    }
    rendered = renderMountainDetailDEM(compositeFrame.dem, compositeFrame.options, hooks.profiler);
    detailRenderStop?.();
    renderedX = compositeFrame.frame.x;
    renderedY = compositeFrame.frame.y;
    renderedWidth = compositeFrame.frame.width;
    renderedHeight = compositeFrame.frame.height;
    return finishTile();
    };
    const preparation = prepareMountainIllustration?.({
      dem: stageDem,
      options: stageOptions,
      pattern: mountainPattern,
      fieldCache,
      fieldInputs: stageInputs.fieldInputs,
    });
    if (preparation && typeof (preparation as PromiseLike<MountainIllustrationPreparedFieldSet | undefined>).then === 'function') {
      return Promise.resolve(preparation).then(
        prepared => finishIllustrated(
          cameraTile
            ? renderMountainCameraIllustrationStageFromInputs(
                stageInputs,
                prepared,
                hooks.profiler,
                stage => hooks.onTileStage?.(cameraIllustrationStageLabel(stage)),
              )
            : renderMountainIllustrationStageFromInputs(stageInputs, prepared, hooks.profiler),
        ),
        error => {
          illustrationPreparationStop?.();
          throw error;
        },
      );
    }
    return finishIllustrated(
      cameraTile
        ? renderMountainCameraIllustrationStageFromInputs(
            stageInputs,
            preparation as MountainIllustrationPreparedFieldSet | undefined,
            hooks.profiler,
            stage => hooks.onTileStage?.(cameraIllustrationStageLabel(stage)),
          )
        : renderMountainIllustrationStageFromInputs(
            stageInputs,
            preparation as MountainIllustrationPreparedFieldSet | undefined,
            hooks.profiler,
          ),
    );
  } else {
    const detailRenderStop = hooks.profiler?.begin('export tile detail composition');
    rendered = renderMountainDetailDEM(tileDem!, renderOptions!, hooks.profiler);
    detailRenderStop?.();
  }
  return finishTile();
}

/**
 * Renders one high-resolution tile. Illustrated mountain geometry gets an
 * expanded support region, while the regular map compositor keeps its modest
 * requested halo before the core is cropped for PNG encoding.
 */
export function renderMountainExportTile(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
): MountainDetailImageData;
export function renderMountainExportTile(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
  prepareMountainIllustration: MountainExportIllustrationPreparation,
): Promise<MountainDetailImageData>;
export function renderMountainExportTile(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
  prepareMountainIllustration?: MountainExportIllustrationPreparation,
): MountainDetailImageData | Promise<MountainDetailImageData> {
  return renderPreparedMountainExportTile(
    prepareMountainExportTile(context, tile),
    { profiler: context.profiler, onTileStage: context.onTileStage },
    prepareMountainIllustration,
  );
}

/** Async ordinary-export entry point. Camera exports intentionally keep using
 * the two-argument synchronous overload above. */
export function renderMountainExportTileAsync(
  context: MountainExportGlobalContext,
  tile: MountainExportTile,
  prepareMountainIllustration: MountainExportIllustrationPreparation,
): Promise<MountainDetailImageData> {
  return Promise.resolve(renderMountainExportTile(context, tile, prepareMountainIllustration));
}


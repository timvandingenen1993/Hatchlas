/**
 * Renders the mountain DEM into layered output (terrain, water, vegetation) with a staged cache.
 */
import { biomeEdgeNoise, DEFAULT_BIOME_EDGE_NOISE_SCALE_M } from "../terrain/biomeEdgeNoise";
import type { MountainDEMData } from '../terrain/mountainBaseDEM';
import {
  DEFAULT_SILT_LAYERS,
  riverSiltCoverage,
  riverSiltCreaseAlpha,
  type RiverSiltLineStyle,
  shadeRiverSilt,
} from './riverSilt';
import {
  createMountainFieldCache,
  createMountainFieldCacheSession,
  getMountainFieldFingerprint,
  renderMountainPatternOverlay,
  renderMountainPatternShadow,
  type MountainFieldCache,
  type MountainFieldCacheSession,
  type MountainPatternOverlay,
} from './mountainPatternRenderer';
import {
  createMountainIllustrationFieldInputs,
  getMountainIllustrationFaceField,
  renderMountainIllustration,
  renderMountainCameraIllustration,
  type MountainCameraIllustrationLayers,
  type MountainIllustration,
  type MountainIllustrationOptions,
  type MountainSnowTransportFields,
  type MountainWindFields,
} from './mountainIllustrationRenderer';
import { tintMountainLand } from './mountainTerrainTint';
import { mountainCameraIllustrationTexture } from './mountainCameraLinework';
import {
  normalizeMountainProjectionSettings,
  normalizeMountainLineworkSettings,
  normalizeMountainSnowfallSettings,
  MOUNTAIN_REFERENCE_PAPER_RGBA,
} from './mountainProjection';
import {
  DEFAULT_MOUNTAIN_LIGHTING_MODE,
  type MountainLightingMode,
} from './mountainLighting';
import {
  renderFullTerrainCamera,
  type FullTerrainCameraRenderStyle,
  type FullTerrainCameraTextureSource,
  type FullTerrainCameraType,
} from './fullTerrainCameraRenderer';
import type { MountainProfiler } from './mountainProfiler';
import type { MountainGpuRenderMode } from './mountainGpuRenderer';
import { forestRenderSettingsSignature } from './forestCanvasRenderer';
import {
  getMountainIllustrationFieldDependencySignature,
  isMountainIllustrationPreparedFieldsCompatible,
  type MountainIllustrationPreparedFieldSet,
} from './mountainIllustrationFields';
import {
  buildWaterOverlayGeometry,
  renderWaterOverlay,
  renderWaterOverlayFromGeometry,
  hash01,
  type WaterRendererOptions,
  type WaterPaintWindow,
  type WaterOverlay,
  type WaterOverlayGeometry,
  type RiverSpline,
  type WaveEpicenter,
} from './waterRenderer';
import {
  buildVegetationGeometry,
  renderVegetationOverlay,
  sampleAlpineForestTerrainSuitability,
  type VegetationGeometry,
  type VegetationOverlayStageCache,
  type VegetationPatternOptions,
  type VegetationOverlay,
  vegetationMotifAssetSignature,
  vegetationRasterPropAssetSignature,
} from './vegetationRenderer';

export type MountainDetailLayer =
  | 'swiss_relief'
  | 'raw_heightmap'
  | 'eroded_heightmap'
  | 'slope'
  | 'aspect'
  | 'drainage_network'
  | 'erosion_depth'
  | 'precipitation'
  | 'solar_insolation'
  | 'biomes'
  | 'vegetation_patterns'
  | 'landforms_tpi'
  | 'wave_patterns';

export type MountainColorPalette =
  | 'swiss_topo'
  | 'european_topo'
  | 'physical_satellite'
  | 'alpine_glacial'
  | 'thermal_magma'
  | 'viridis'
  | 'slope_hazard';

export interface MountainRenderOptions {
  layer: MountainDetailLayer;
  palette: MountainColorPalette;
  /** Select the optional GPU-resident compositor for preview/export rendering. */
  gpuRenderMode?: MountainGpuRenderMode;
  sunAzimuthDeg: number;
  sunAltitudeDeg: number;
  /** Face-light remap used by the illustrated mountain material. */
  mountainLightingMode?: MountainLightingMode;
  verticalExaggeration: number;
  /** Selective mountain-only projection angle; 90° preserves overhead relief. */
  mountainViewAngleDeg?: number;
  /** Selective mountain-only height exaggeration, independent of DEM shading. */
  mountainHeightExaggeration?: number;
  /** Presentation multiplier applied after physical preview/export scaling. */
  mountainLineworkScale?: number;
  /** Independent mountain ink opacity. */
  mountainLineworkOpacity?: number;
  /** Independent opacity for repeated downhill/contour hatch marks. */
  mountainHatchOpacity?: number;
  /** Opacity for near-horizontal contour hatches. */
  mountainHatchHorizontalOpacity?: number;
  /** Opacity for downhill/vertical hatches. */
  mountainHatchVerticalOpacity?: number;
  /** Density multiplier for downhill and contour hatch families. */
  mountainHatchDensity?: number;
  /** Upper bound for automatic local mountain detail; 1x is the baseline. */
  mountainLocalDetailDensityMax?: number;
  /** Multiplier for extra detail on lower-relief/foothill faces. */
  mountainFoothillDetailMultiplier?: number;
  /** Multiplier for the soft biome-specific detail bias. */
  mountainBiomeDetailMultiplier?: number;
  /** Independent hatch pen multiplier. */
  mountainHatchThickness?: number;
  /** Density/strength threshold multiplier for primary structural ridges. */
  mountainRidgeDensity?: number;
  /** Native-resolution wind fields prepared once for an export snapshot. */
  windFieldsOverride?: MountainWindFields;
  /** Native-resolution snow predictors prepared once for an export snapshot. */
  snowTransportOverride?: MountainSnowTransportFields;
  /** Pen multiplier for connected primary ridges. */
  mountainRidgeThickness?: number;
  /** Colour for downhill and interior mountain hatch marks. */
  mountainHatchColor?: string;
  /** Colour for connected primary/main mountain ridges. */
  mountainRidgeColor?: string;
  /** Preview experiment: reproject the complete composited terrain surface. */
  fullTerrainCameraElevationDeg?: number;
  /** Extra vertical multiplier; the renderer's verticalExaggeration is applied too. */
  fullTerrainCameraHeightExaggeration?: number;
  /** Projection used by the complete-terrain camera. */
  fullTerrainCameraType?: FullTerrainCameraType;
  /** @deprecated Legacy setting retained for saved render options; ignored. */
  fullTerrainCameraRenderStyle?: FullTerrainCameraRenderStyle | string;
  /** Internal export flag: compose the image now and project it globally later. */
  deferFullTerrainCamera?: boolean;
  /** Internal GPU fast path: the supplied RGBA layer already replaces the CPU painter. */
  skipMountainIllustrationStage?: boolean;
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
  ambientOcclusionStrength: number;
  /** Combined terrain shading intensity; 0 disables relief shading, 1 preserves it. */
  hillshadeStrength?: number;
  showRivers: boolean;
  /** Optional water coverage over the otherwise unstyled elevation raster. */
  showHeightmapWater?: boolean;
  riverThresholdKm2: number;
  /** Draw water boundaries, coastal ink details, and painted offshore waves. */
  showWaterDetails?: boolean;
  showOceanDetails?: boolean;
  /** Reuse export-global river vectors rather than rebuilding them per tile. */
  riverSplinesOverride?: readonly RiverSpline[];
  /** Internal asynchronous-stage result; synchronous callers leave this unset. */
  waterGeometryOverride?: WaterOverlayGeometry | null;
  /** Internal asynchronous-stage result; synchronous callers leave this unset. */
  waterOverlayOverride?: WaterOverlay | null;
  /** Pixel scale used for high-resolution ocean wave marks. */
  oceanPixelScale?: number;
  /** Raster pixels per DEM pixel for mountain linework (falls back to oceanPixelScale). */
  mountainPatternPixelScale?: number;
  oceanCoordinateOffsetX?: number;
  oceanCoordinateOffsetY?: number;
  oceanCoordinateStride?: number;
  /** Use bounded separable ocean-distance smoothing for high-resolution tiles. */
  distanceSmoothingIterations?: number;
  effectiveDistanceSmoothingIterations?: number;
  /** Precomputed global ocean distance field sampled into an export tile. */
  oceanDistanceToCoastOverride?: Float32Array;
  /** Tile-local sample of the global open-sea wave mask (export only). */
  openOceanMaskOverride?: Float32Array;
  /** Global maximum ocean distance used to keep nonlinear water bands tile-stable. */
  oceanDistanceNormalizationMax?: number;
  /** Bilinear ocean coverage sampled from the global export mask. */
  oceanMaskCoverageOverride?: Float32Array;
  oceanRippleCount?: number;
  /** Legacy ocean-wave density control retained for saved/export compatibility. */
  oceanRippleDensity?: number;
  /** @deprecated Ocean wave width follows waterOutlineThickness. */
  oceanWaveThickness?: number;
  /** @deprecated Ocean wave strength follows waterOutlineOpacity. */
  oceanWaveOpacity?: number;
  deepOceanSwells?: boolean;
  deepOceanSwellDensity?: number;
  /** Lake depth in meters that reaches the full deep-water tone. */
  lakeFullDepthM?: number;
  /** Independent deep-ocean stroke length multiplier; falls back to waterOutlineLength. */
  deepOceanWaveLength?: number;
  /** Independent deep-ocean stroke thickness; falls back to waterOutlineThickness. */
  deepOceanStrokeThickness?: number;
  deepOceanWaveShadingScale?: number;
  deepOceanWaveShadingIntensity?: number;
  deepOceanTurbulenceScale?: number;
  deepOceanTurbulenceIntensity?: number;
  /** @deprecated Deep ocean run length follows waterOutlineLength. */
  deepOceanLineLength?: number;
  /** @deprecated Deep ocean stroke width follows waterOutlineThickness. */
  deepOceanWaveThickness?: number;
  customEpicenters?: WaveEpicenter[];
  /** River silt: how far the outermost silt pass reaches from the river, in metres. */
  siltReachM?: number;
  /** River silt: how strongly old channels in the height data pull silt outward. */
  siltTopRemoved?: number;
  /** River silt: number of visible silt passes (layers). */
  siltLayers?: number;
  wetlandPuddleContours?: boolean;
  wetlandPuddleDensity?: number;
  wetlandPuddleSizeMin?: number;
  wetlandPuddleSizeMax?: number;
  wetlandPuddleCoastDistance?: number;
  wetlandPoolContourLength?: number;
  /** @deprecated Wetland contours use the shared charcoal thickness. */
  wetlandPuddleThickness?: number;
  wetlandPuddleSeed?: number;
  waterFillSmoothing?: number;
  /** Darkens all water on shadow-side terrain like the prop terrain shade, 0 to 1. */
  waterTerrainShadeStrength?: number;
  waterOutlineThickness?: number;
  waterOutlineLength?: number;
  waterOutlineSmoothing?: number;
  waterOutlineOpacity?: number;
  waterFlowDensity?: number;
  waterFlowLength?: number;
  waterFlowThickness?: number;
  waterFlowSmoothing?: number;
  waterFlowOpacity?: number;
  waterOutlineColor?: string;
  waterFlowColor?: string;
  /** Optional per-biome wash overrides used by the vegetation pattern renderer. */
  vegetationBiomeColors?: Readonly<Record<number, string>>;
  /** Scales the width and face tint of land-biome color transitions. */
  vegetationBiomeTransitionStrength?: number;
  /** Shallow and deep endpoints for the shared river/lake/ocean wash. */
  waterShallowColor?: string;
  waterDeepColor?: string;
  rainOverlayOpacity?: number; // 0.0 to 1.0 (overlays orographic storm precipitation onto terrain)
  erosionOverlayOpacity?: number; // 0.0 to 1.0 (flow incision overlay on map views)
  showContours: boolean;
  contourIntervalM: number;
  /** Number of small blur passes applied only to the contour elevation field. */
  contourSmoothingPasses?: number;
  /** Half-width of minor contour bands in elevation metres. */
  contourThicknessM?: number;
  /** Half-width of index contour bands in elevation metres. */
  contourIndexThicknessM?: number;
  /** Draw a darker index contour every N minor intervals. */
  showIndexContours?: boolean;
  contourIndexEvery?: number;
  contourOpacity?: number;
  contourColor?: string;
  contourIndexColor?: string;
  crossSectionLine?: { p0: { x: number; y: number }; p1: { x: number; y: number } } | null;
  activeDroplets?: { x: number; y: number; age: number }[];
  vegetation?: VegetationPatternOptions;
  /** Global vegetation geometry mapped into an export tile. */
  vegetationGeometryOverride?: VegetationGeometry;
  /** Internal asynchronous-stage result; synchronous callers leave this unset. */
  vegetationOverlayOverride?: VegetationOverlay | null;
  /** Global pixel origin for deterministic tiled texture coordinates. */
  textureCoordinateOffsetX?: number;
  textureCoordinateOffsetY?: number;
  /** Full output dimensions used to keep procedural texture sampling tile-stable. */
  textureCoordinateDomainWidth?: number;
  textureCoordinateDomainHeight?: number;
  /** Precomputed mountain illustration pixels for tiled export compositing. */
  mountainIllustrationRGBA?: Uint8ClampedArray;
  /** Local pixels an export tile keeps; offshore waves paint only near it. */
  waterPaintWindow?: WaterPaintWindow;
  /** Internal export crop: intermediate fields retain halos, final pixels do not. */
  compositionWindow?: WaterPaintWindow;
  /** Preserve tile-independent normalization when a cropped DEM is composited. */
  heightmapLowerLimitMOverride?: number;
  maxErosionDepthMOverride?: number;
  /** Output-pixel scale/origin for procedural wetland geometry in tiled exports. */
  wetlandPuddleCoordinateScale?: number;
  wetlandPuddleCoordinateOffsetX?: number;
  wetlandPuddleCoordinateOffsetY?: number;
  wetlandPuddleCoordinateDomainWidth?: number;
  wetlandPuddleCoordinateDomainHeight?: number;
}

export interface MountainRenderStageStats {
  waterGeometryBuilds: number;
  waterOverlayBuilds: number;
  vegetationGeometryBuilds: number;
  vegetationOverlayBuilds: number;
  contourFieldBuilds: number;
  composites: number;
}

/** Persistent cache used by the interactive preview. */
export interface MountainRenderStageCache {
  mountainFieldCache: MountainFieldCache;
  demElevationFingerprint?: number;
  demSlopeFingerprint?: number;
  /** Water-only dependency for the biome-independent geometric linework pass. */
  demLineworkFingerprint?: number;
  mountainPatternKey?: string;
  mountainPattern?: MountainPatternOverlay;
  mountainShadowKey?: string;
  mountainShadow?: Float32Array;
  mountainIllustrationKey?: string;
  mountainIllustration?: MountainIllustration;
  mountainIllustrationPreparedFieldSet?: MountainIllustrationPreparedFieldSet;
  dem?: MountainDEMData;
  waterKey?: string;
  waterGeometryKey?: string;
  waterGeometry?: WaterOverlayGeometry | null;
  waterGeometryRiverSplinesOverride?: readonly RiverSpline[];
  waterGeometryOceanDistanceOverride?: Float32Array;
  waterGeometryOceanMaskCoverageOverride?: Float32Array;
  waterPaintKey?: string;
  waterOverlay?: WaterOverlay | null;
  /** Final water coverage shared by vegetation placement and compositing. */
  vegetationWaterCoverage?: Float32Array;
  vegetationWaterCoverageOverlay?: WaterOverlay | null;
  vegetationGeometryKey?: string;
  vegetationGeometry?: VegetationGeometry | null;
  vegetationOverlayKey?: string;
  vegetationOverlay?: VegetationOverlay | null;
  vegetationStages: VegetationOverlayStageCache;
  contourKey?: string;
  contourElevation?: Float32Array;
  stats: MountainRenderStageStats;
}

export function createMountainRenderStageCache(): MountainRenderStageCache {
  return {
    mountainFieldCache: createMountainFieldCache(),
    stats: {
      waterGeometryBuilds: 0,
      waterOverlayBuilds: 0,
      vegetationGeometryBuilds: 0,
      vegetationOverlayBuilds: 0,
      contourFieldBuilds: 0,
      composites: 0,
    },
    vegetationStages: {},
  };
}

export function waterGeometryStageKey(options: MountainRenderOptions): string {
  return JSON.stringify([
    options.showRivers,
    options.riverThresholdKm2,
    options.showWaterDetails,
    options.showOceanDetails,
    options.waterFillSmoothing,
    options.waterOutlineSmoothing,
    options.oceanPixelScale,
    options.oceanCoordinateOffsetX,
    options.oceanCoordinateOffsetY,
    options.oceanCoordinateStride,
    options.distanceSmoothingIterations,
    options.effectiveDistanceSmoothingIterations,
    options.wetlandPuddleContours,
    options.wetlandPuddleDensity,
    options.wetlandPuddleSizeMin,
    options.wetlandPuddleSizeMax,
    options.wetlandPuddleCoastDistance,
    options.wetlandPuddleSeed,
    options.wetlandPuddleCoordinateScale,
    options.wetlandPuddleCoordinateOffsetX,
    options.wetlandPuddleCoordinateOffsetY,
    options.wetlandPuddleCoordinateDomainWidth,
    options.wetlandPuddleCoordinateDomainHeight,
  ]);
}

/** Image returned by the detail compositor with an optional foreground prop
 * layer retained for the full-terrain camera pass. */
export type MountainDetailImageData = ImageData & {
  foregroundPropsRGBA?: Uint8ClampedArray;
};

/**
 * Controls the optional split between CPU stage preparation and GPU layer
 * composition. The normal renderer keeps its exact all-CPU behavior when this
 * value is omitted.
 */
export interface MountainDetailRenderControl {
  /** Leave the prepared mountain illustration for a following GPU layer pass. */
  omitMountainIllustration?: boolean;
}

export function waterPaintStageKey(
  options: MountainRenderOptions,
  geometryKey: string,
): string {
  return JSON.stringify([
    geometryKey,
    options.showWaterDetails,
    options.showOceanDetails,
    options.waterOutlineThickness,
    options.waterOutlineLength,
    options.waterOutlineSmoothing,
    options.waterOutlineOpacity,
    options.waterFlowDensity,
    options.waterFlowLength,
    options.wetlandPoolContourLength,
    options.waterFlowThickness,
    options.waterFlowSmoothing,
    options.waterFlowOpacity,
    options.oceanRippleCount,
    options.deepOceanSwells,
    options.deepOceanSwellDensity,
    options.lakeFullDepthM,
    options.deepOceanWaveLength,
    options.deepOceanStrokeThickness,
    options.deepOceanWaveShadingScale,
    options.deepOceanWaveShadingIntensity,
    options.deepOceanTurbulenceScale,
    options.deepOceanTurbulenceIntensity,
    options.customEpicenters,
    options.wetlandPuddleContours,
    options.wetlandPuddleSeed,
    options.oceanPixelScale,
    options.oceanCoordinateOffsetX,
    options.oceanCoordinateOffsetY,
    options.oceanCoordinateStride,
    options.oceanDistanceNormalizationMax,
    options.wetlandPuddleCoordinateScale,
    options.wetlandPuddleCoordinateOffsetX,
    options.wetlandPuddleCoordinateOffsetY,
    options.wetlandPuddleCoordinateDomainWidth,
    options.wetlandPuddleCoordinateDomainHeight,
  ]);
}

export function vegetationGeometryStageKey(options: MountainRenderOptions): string {
  const vegetation = options.vegetation;
  return JSON.stringify([
    options.layer,
    // Vegetation masks and distance fields sample the resolved visual-water
    // coverage. Keep geometry invalidation tied to water geometry inputs while
    // leaving water paint-only changes cacheable.
    waterGeometryStageKey(options),
    vegetation?.preset,
    vegetation?.seed,
    vegetation?.density,
    vegetation?.patternScale,
    vegetation?.swirlStrength,
    vegetation?.terrainFollowing,
    vegetation?.strokeLength,
    vegetation?.strokeThickness,
    vegetation?.motifDensity,
    vegetation?.motifSize,
    vegetation?.wetlandShrubDensity,
    vegetation?.wetlandImagePropDrynessBias,
    vegetationMotifAssetSignature(vegetation?.motifAssets),
    vegetationRasterPropAssetSignature(vegetation?.rasterPropAssets),
    vegetation?.rasterPropBiomeSettings,
    vegetation?.rasterPropDensity,
    vegetation?.mountainBoulderDensity,
    vegetation?.mountainBoulderSize,
    vegetation?.rasterPropCellSize,
    vegetation?.rasterPropScale,
    vegetation?.rasterPropClustering,
    vegetation?.rasterPropStandSize,
    vegetation?.rasterPropPlacementNoiseScale,
    vegetation?.coordinateOffsetX,
    vegetation?.coordinateOffsetY,
    vegetation?.coordinateStride,
    vegetation?.coordinateHeight,
    vegetation?.coordinateSourceWidth,
    vegetation?.coordinateSourceHeight,
    vegetation?.coordinatePatternScale,
    // Forest stand placement lives in the geometry; its paint settings only
    // affect the overlay stage.
    vegetation?.forestSettings?.seed,
    vegetation?.forestSettings?.standMarkSpacing,
    vegetation?.forestSettings?.standEdgeTrees,
    vegetation?.forestSettings?.standInteriorTrees,
    vegetation?.forestSettings?.standMeadowTrees,
    vegetation?.forestSettings?.standAccentTrees,
  ]);
}

export function vegetationOverlayStageKey(
  options: MountainRenderOptions,
  geometryKey: string,
): string {
  const vegetation = options.vegetation;
  return JSON.stringify([
    geometryKey,
    options.sunAzimuthDeg,
    vegetation?.strokeThickness,
    vegetation?.strokeOpacity,
    vegetation?.drySkipProbability,
    vegetation?.lineInterruptionProbability,
    vegetation?.flowWashNoiseScale,
    vegetation?.wetlandDryDistanceStart,
    vegetation?.wetlandDryDistanceEnd,
    vegetation?.wetlandDryNoiseScale,
    vegetation?.wetlandDryNoiseStrength,
    vegetation?.showFlowGuides,
    vegetation?.motifShadowStrength,
    vegetation?.motifShadowDistance,
    vegetation?.motifShadowSoftness,
    vegetation?.washShadowStrength,
    vegetation?.washShadowDistance,
    vegetation?.washShadowGap,
    vegetation?.washShadowGrain,
    forestRenderSettingsSignature(vegetation?.forestSettings),
    vegetation?.forestRenderScale,
    vegetationMotifAssetSignature(vegetation?.motifAssets),
    vegetationRasterPropAssetSignature(vegetation?.rasterPropAssets),
  ]);
}

/**
 * Shared water-stage inputs used by the synchronous compositor and the
 * optional helper worker. Keeping this construction in one place prevents a
 * parallel preparation from drifting from the serial renderer's dependency
 * keys or option defaults.
 */
export interface MountainWaterStageInputs {
  shouldBuildWater: boolean;
  options: WaterRendererOptions;
  geometryKey: string;
  paintKey: string;
}

export function buildMountainWaterStageInputs(
  dem: MountainDEMData,
  options: MountainRenderOptions,
): MountainWaterStageInputs {
  const isPureHeightmapLayer = options.layer === 'raw_heightmap'
    || options.layer === 'eroded_heightmap';
  const hasOcean = Boolean(dem.isOcean && dem.isOcean.some((v) => v === 1));
  const hasWetland = Boolean(
    dem.wetlandPoolMask?.some((value) => value === 1)
      || dem.biomeType?.some((value) => value === 7),
  );
  const shouldBuildWater = (
    options.showRivers || hasOcean || hasWetland
  ) && (!isPureHeightmapLayer || options.showHeightmapWater === true);
  const waterOptions: WaterRendererOptions = {
    riverThresholdKm2: options.riverThresholdKm2,
    useEcologicalBiomeWater: true,
    fillSmoothing: options.waterFillSmoothing,
    outlineThickness: options.waterOutlineThickness,
    outlineLength: options.waterOutlineLength,
    outlineSmoothing: options.waterOutlineSmoothing,
    outlineOpacity: options.waterOutlineOpacity,
    flowDensity: options.waterFlowDensity,
    flowLength: options.waterFlowLength,
    poolContourLength: options.wetlandPoolContourLength,
    flowThickness: options.waterFlowThickness,
    flowSmoothing: options.waterFlowSmoothing,
    flowOpacity: options.waterFlowOpacity,
    showWaterDetails: options.showWaterDetails,
    showOceanDetails: options.showOceanDetails,
    paintWindow: options.waterPaintWindow,
    riverSplinesOverride: options.riverSplinesOverride,
    oceanPixelScale: options.oceanPixelScale,
    riverCellPx: options.mountainPatternPixelScale,
    oceanCoordinateOffsetX: options.oceanCoordinateOffsetX,
    oceanCoordinateOffsetY: options.oceanCoordinateOffsetY,
    oceanCoordinateStride: options.oceanCoordinateStride,
    distanceSmoothingIterations: options.distanceSmoothingIterations,
    effectiveDistanceSmoothingIterations: options.effectiveDistanceSmoothingIterations,
    oceanDistanceToCoastOverride: options.oceanDistanceToCoastOverride,
    openOceanMaskOverride: options.openOceanMaskOverride,
    oceanDistanceNormalizationMax: options.oceanDistanceNormalizationMax,
    oceanMaskCoverageOverride: options.oceanMaskCoverageOverride,
    oceanRippleCount: options.oceanRippleCount,
    deepOceanSwells: options.deepOceanSwells,
    deepOceanSwellDensity: options.deepOceanSwellDensity,
    lakeFullDepthM: options.lakeFullDepthM,
    deepOceanWaveLength: options.deepOceanWaveLength,
    deepOceanStrokeThickness: options.deepOceanStrokeThickness,
    deepOceanWaveShadingScale: options.deepOceanWaveShadingScale,
    deepOceanWaveShadingIntensity: options.deepOceanWaveShadingIntensity,
    deepOceanTurbulenceScale: options.deepOceanTurbulenceScale,
    deepOceanTurbulenceIntensity: options.deepOceanTurbulenceIntensity,
    customEpicenters: options.customEpicenters,
    wetlandPuddleContours: options.wetlandPuddleContours,
    wetlandPuddleDensity: options.wetlandPuddleDensity,
    wetlandPuddleSizeMin: options.wetlandPuddleSizeMin,
    wetlandPuddleSizeMax: options.wetlandPuddleSizeMax,
    wetlandPuddleCoastDistance: options.wetlandPuddleCoastDistance,
    wetlandPuddleSeed: options.wetlandPuddleSeed,
    wetlandPuddleCoordinateScale: options.wetlandPuddleCoordinateScale,
    wetlandPuddleCoordinateOffsetX: options.wetlandPuddleCoordinateOffsetX,
    wetlandPuddleCoordinateOffsetY: options.wetlandPuddleCoordinateOffsetY,
    wetlandPuddleCoordinateDomainWidth: options.wetlandPuddleCoordinateDomainWidth,
    wetlandPuddleCoordinateDomainHeight: options.wetlandPuddleCoordinateDomainHeight,
  };
  const geometryKey = shouldBuildWater ? waterGeometryStageKey(options) : 'none';
  return {
    shouldBuildWater,
    options: waterOptions,
    geometryKey,
    paintKey: shouldBuildWater ? waterPaintStageKey(options, geometryKey) : 'none',
  };
}

/**
 * The water overlay the compositor would build for `dem`, for callers that
 * need it over a larger region than the one they composite (ocean waves reach
 * much further than any other halo) and pass it back as `waterOverlayOverride`.
 */
export function renderMountainWaterOverlay(
  dem: MountainDEMData,
  options: MountainRenderOptions,
  profiler?: MountainProfiler,
): WaterOverlay | null {
  const { shouldBuildWater, options: waterOptions } = buildMountainWaterStageInputs(dem, options);
  return shouldBuildWater ? renderWaterOverlay(dem, waterOptions, profiler) : null;
}

type RGB = [number, number, number];

function parseHexColor(value: string | undefined, fallback: RGB): RGB {
  if (!value) return fallback;
  const match = value.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return fallback;
  const hex = match[1].length === 3
    ? match[1].split('').map(channel => channel + channel).join('')
    : match[1];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function mixRGB(a: RGB, b: RGB, amount: number): RGB {
  const t = Math.max(0, Math.min(1, amount));
  return [
    a[0] * (1 - t) + b[0] * t,
    a[1] * (1 - t) + b[1] * t,
    a[2] * (1 - t) + b[2] * t,
  ];
}

function createForegroundPropRGBA(
  overlay: VegetationOverlay | null,
  width: number,
  height: number,
  inkColor: RGB,
  terrainShade?: Float32Array,
): Uint8ClampedArray | undefined {
  const rasterPixels = overlay?.rasterPropRGBA;
  const charcoalAlpha = overlay?.rasterPropCharcoalAlpha;
  if (!rasterPixels && !charcoalAlpha) return undefined;
  const total = width * height;
  const foreground = new Uint8ClampedArray(total * 4);
  if (rasterPixels) foreground.set(rasterPixels);
  if (rasterPixels && terrainShade) {
    const standShare = overlay?.rasterPropStandShare;
    for (let index = 0; index < total; index++) {
      // Forest stands are lit per tree already; only the rest is shaded.
      const shade = 1 - (1 - terrainShade[index]) * (1 - (standShare?.[index] ?? 0) / 255);
      if (shade >= 1) continue;
      foreground[index * 4] *= shade;
      foreground[index * 4 + 1] *= shade;
      foreground[index * 4 + 2] *= shade;
    }
  }
  if (charcoalAlpha) {
    for (let index = 0; index < total; index++) {
      const sourceAlpha = charcoalAlpha[index] / 255;
      if (sourceAlpha <= 0) continue;
      const offset = index * 4;
      const destinationAlpha = foreground[offset + 3] / 255;
      const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      if (outputAlpha <= 0) continue;
      foreground[offset] = Math.round(
        (inkColor[0] * sourceAlpha +
          foreground[offset] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
      );
      foreground[offset + 1] = Math.round(
        (inkColor[1] * sourceAlpha +
          foreground[offset + 1] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
      );
      foreground[offset + 2] = Math.round(
        (inkColor[2] * sourceAlpha +
          foreground[offset + 2] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
      );
      foreground[offset + 3] = Math.round(outputAlpha * 255);
    }
  }
  return foreground;
}

const FULL_TERRAIN_CAMERA_BACKGROUND: readonly [number, number, number, number] = MOUNTAIN_REFERENCE_PAPER_RGBA;

// The mountain DEM has a richer ecological vocabulary than the vegetation
// wash used to expose. This reference-map palette uses moss/forest greens,
// warm ochres, sand, and quiet neutral edge classes so the paper texture and
// the independent water wash remain visible. Keep the string form exported so
// the studio can expose the same defaults in its palette popup.
export const MOUNTAIN_REFERENCE_BIOME_COLORS: Readonly<Record<number, string>> = {
  0: "#dde7e9", // Glacier / permanent snow
  1: "#978b79", // Alpine bare rock / scree
  2: "#779452", // Alpine tundra / meadow
  3: "#2f502c", // Subalpine conifer forest
  4: "#4c6c38", // Montane woodland / shrubland
  5: "#608543", // Riparian canyon shrubland
  // Aquatic classes stay neutral here. Their water overlay owns the final
  // blue color; painting them into the land wash can create large,
  // polygonal patches when a resampled DEM marks a shoreline cell as water.
  6: "#c7d5cd", // Braided river gravel / channel
  7: "#6f8f4a", // Valley floodplain / wetland
  8: "#c7d5cd", // Ocean
  9: "#c1aa77", // River silt / alluvial soil
  10: "#7e7563", // River rock / scree bank
  11: "#e7cf96", // Sandy beach
  12: "#d0b784", // Silty beach / river mouth
  13: "#918673", // Rocky shore
  14: "#5d5d52", // Coastal cliff
};

export const MOUNTAIN_REFERENCE_WATER_COLORS = {
  shallow: "#60a0d0",
  deep: "#1d527e",
} as const;

const DEFAULT_MOUNTAIN_BIOME_RGB: RGB = [119, 148, 82];
const DEFAULT_WATER_SHALLOW_RGB: RGB = [96, 160, 208];
const DEFAULT_WATER_DEEP_RGB: RGB = [29, 82, 126];
const MOUNTAIN_BIOME_WASH_COLORS: Readonly<Record<number, RGB>> =
  Object.entries(MOUNTAIN_REFERENCE_BIOME_COLORS).reduce<Record<number, RGB>>(
    (colors, [biomeId, color]) => {
      colors[Number(biomeId)] = parseHexColor(color, DEFAULT_MOUNTAIN_BIOME_RGB);
      return colors;
    },
    {},
  );

function resolveMountainBiomeWashColors(
  overrides?: Readonly<Record<number, string>>,
): Readonly<Record<number, RGB>> {
  if (!overrides) return MOUNTAIN_BIOME_WASH_COLORS;
  const colors: Record<number, RGB> = { ...MOUNTAIN_BIOME_WASH_COLORS };
  for (const [biomeIdText, color] of Object.entries(overrides)) {
    const biomeId = Number(biomeIdText);
    if (!Number.isInteger(biomeId) || biomeId < 0 || biomeId > 14) continue;
    colors[biomeId] = parseHexColor(
      color,
      colors[biomeId] ?? DEFAULT_MOUNTAIN_BIOME_RGB,
    );
  }
  return colors;
}

function getVegetationWashRGB(
  biomeId: number,
  colors: Readonly<Record<number, RGB>> = MOUNTAIN_BIOME_WASH_COLORS,
): RGB {
  return colors[biomeId] ?? DEFAULT_MOUNTAIN_BIOME_RGB;
}

interface VegetationWashSample {
  color: RGB;
  transition: number;
}

interface VegetationWashField {
  sample(index: number): VegetationWashSample;
}

function summedAreaTable(values: Uint32Array, width: number, height: number): void {
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const index = rowOffset + x;
      const left = x > 0 ? values[index - 1] : 0;
      const above = y > 0 ? values[index - width] : 0;
      const diagonal = x > 0 && y > 0 ? values[index - width - 1] : 0;
      values[index] = values[index] + left + above - diagonal;
    }
  }
}

function summedAreaRect(
  values: Uint32Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const bottomRight = values[y1 * width + x1];
  const above = y0 > 0 ? values[(y0 - 1) * width + x1] : 0;
  const left = x0 > 0 ? values[y1 * width + x0 - 1] : 0;
  const corner = x0 > 0 && y0 > 0 ? values[(y0 - 1) * width + x0 - 1] : 0;
  return bottomRight - above - left + corner;
}

/**
 * Builds a broad, noise-distorted land-color blend. A compact summed-area
 * field keeps the work linear in map size, while the barrier mask prevents
 * colors from blending across snow, ocean, and routed channels.
 */
function createVegetationWashField(
  dem: MountainDEMData,
  colors: Readonly<Record<number, RGB>>,
  transitionStrength: number,
  offsetX: number,
  offsetY: number,
  coordinateDomainWidth: number,
  coordinateDomainHeight: number,
): VegetationWashField {
  const noiseScaleM = dem.biomeEdgeNoiseScaleM ?? DEFAULT_BIOME_EDGE_NOISE_SCALE_M;
  const radiusM = Math.max(0, noiseScaleM * 0.25 * transitionStrength);
  const maxGridCells = 1_000_000;
  const stride = Math.max(1, Math.ceil(Math.sqrt((coordinateDomainWidth * coordinateDomainHeight) / maxGridCells)));
  const gridStartX = Math.floor(offsetX / stride);
  const gridStartY = Math.floor(offsetY / stride);
  const gridWidth = Math.max(1, Math.ceil((offsetX + dem.width) / stride) - gridStartX);
  const gridHeight = Math.max(1, Math.ceil((offsetY + dem.height) / stride) - gridStartY);
  const gridSize = gridWidth * gridHeight;
  const red = new Uint32Array(gridSize);
  const green = new Uint32Array(gridSize);
  const blue = new Uint32Array(gridSize);
  const count = new Uint32Array(gridSize);
  const barrier = new Uint32Array(gridSize);

  for (let y = 0; y < dem.height; y++) {
    const globalY = offsetY + y;
    const gridY = Math.floor(globalY / stride) - gridStartY;
    for (let x = 0; x < dem.width; x++) {
      const index = y * dem.width + x;
      const biome = dem.biomeType[index];
      const gridX = Math.floor((offsetX + x) / stride) - gridStartX;
      const gridIndex = gridY * gridWidth + gridX;
      if (
        biome === 0 || biome === 6 || biome === 8 ||
        dem.isOcean[index] || dem.isRiverChannel[index]
      ) {
        barrier[gridIndex] = 1;
        continue;
      }
      const color = getVegetationWashRGB(biome, colors);
      red[gridIndex] += color[0];
      green[gridIndex] += color[1];
      blue[gridIndex] += color[2];
      count[gridIndex]++;
    }
  }

  const sourceRGB = new Uint8ClampedArray(gridSize * 3);
  for (let index = 0; index < gridSize; index++) {
    const validCount = count[index];
    if (validCount > 0) {
      sourceRGB[index * 3] = Math.round(red[index] / validCount);
      sourceRGB[index * 3 + 1] = Math.round(green[index] / validCount);
      sourceRGB[index * 3 + 2] = Math.round(blue[index] / validCount);
      // Each coarse grid cell represents one spatial sample in the summed
      // area table, so store its mean instead of the raw pixel-color sum.
      red[index] = sourceRGB[index * 3];
      green[index] = sourceRGB[index * 3 + 1];
      blue[index] = sourceRGB[index * 3 + 2];
      count[index] = 1;
    }
  }
  summedAreaTable(red, gridWidth, gridHeight);
  summedAreaTable(green, gridWidth, gridHeight);
  summedAreaTable(blue, gridWidth, gridHeight);
  summedAreaTable(count, gridWidth, gridHeight);
  summedAreaTable(barrier, gridWidth, gridHeight);

  const blurredRGB = new Uint8ClampedArray(gridSize * 3);
  const baseRadiusX = radiusM / Math.max(1, dem.dxMeters);
  const baseRadiusY = radiusM / Math.max(1, dem.dyMeters);
  for (let gridY = 0; gridY < gridHeight; gridY++) {
    const globalY = (gridStartY + gridY) * stride + (stride - 1) * 0.5;
    for (let gridX = 0; gridX < gridWidth; gridX++) {
      const index = gridY * gridWidth + gridX;
      const globalX = (gridStartX + gridX) * stride + (stride - 1) * 0.5;
      const variation = 1 + biomeEdgeNoise(globalX * dem.dxMeters, globalY * dem.dyMeters, noiseScaleM) * 0.28;
      const worldX = globalX * dem.dxMeters;
      const worldY = globalY * dem.dyMeters;
      const warp = (seed: number): number => biomeEdgeNoise(worldX, worldY, noiseScaleM, seed);
      const warpX = warp(613) * baseRadiusX;
      const warpY = warp(1297) * baseRadiusY;
      // Move the sampling centre as well as varying its radius: changing only
      // the radius leaves the midpoint of a straight biome border straight.
      let support = 1;
      let minX = 0, maxX = 0, minY = 0, maxY = 0;
      let barrierCount = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        const sampleX = globalX + warpX * support;
        const sampleY = globalY + warpY * support;
        minX = Math.min(gridWidth - 1, Math.max(0, Math.floor((sampleX - baseRadiusX * variation * support) / stride) - gridStartX));
        maxX = Math.max(0, Math.min(gridWidth - 1, Math.floor((sampleX + baseRadiusX * variation * support) / stride) - gridStartX));
        minY = Math.min(gridHeight - 1, Math.max(0, Math.floor((sampleY - baseRadiusY * variation * support) / stride) - gridStartY));
        maxY = Math.max(0, Math.min(gridHeight - 1, Math.floor((sampleY + baseRadiusY * variation * support) / stride) - gridStartY));
        // Include the route from the destination to its displaced sample.
        barrierCount = summedAreaRect(barrier, gridWidth,
          Math.min(minX, gridX), Math.min(minY, gridY),
          Math.max(maxX, gridX), Math.max(maxY, gridY));
        if (barrierCount === 0) break;
        support *= 0.5;
      }
      const outputOffset = index * 3;
      const validCount = summedAreaRect(count, gridWidth, minX, minY, maxX, maxY);
      if (barrierCount > 0 || validCount <= 0) {
        blurredRGB[outputOffset] = sourceRGB[outputOffset];
        blurredRGB[outputOffset + 1] = sourceRGB[outputOffset + 1];
        blurredRGB[outputOffset + 2] = sourceRGB[outputOffset + 2];
      } else {
        blurredRGB[outputOffset] = summedAreaRect(red, gridWidth, minX, minY, maxX, maxY) / validCount;
        blurredRGB[outputOffset + 1] = summedAreaRect(green, gridWidth, minX, minY, maxX, maxY) / validCount;
        blurredRGB[outputOffset + 2] = summedAreaRect(blue, gridWidth, minX, minY, maxX, maxY) / validCount;
      }
    }
  }

  return {
    sample(index: number): VegetationWashSample {
      const biome = dem.biomeType[index];
      const center = getVegetationWashRGB(biome, colors);
      if (
        radiusM <= 0 || biome === 0 || biome === 6 || biome === 8 ||
        dem.isOcean[index] || dem.isRiverChannel[index]
      ) return { color: center, transition: 0 };

      const x = index % dem.width;
      const y = Math.floor(index / dem.width);
      const globalX = offsetX + x;
      const globalY = offsetY + y;
      // Kernels already shrink around barriers. Only protect the interpolation
      // footprint here; a distant river must not disable the entire transition.
      const minX = Math.max(0, Math.floor(globalX / stride) - gridStartX);
      const maxX = Math.min(gridWidth - 1, minX + 1);
      const minY = Math.max(0, Math.floor(globalY / stride) - gridStartY);
      const maxY = Math.min(gridHeight - 1, minY + 1);
      if (summedAreaRect(barrier, gridWidth, minX, minY, maxX, maxY) > 0) {
        return { color: center, transition: 0 };
      }

      const sampleX = Math.max(0, Math.min(gridWidth - 1, globalX / stride - gridStartX));
      const sampleY = Math.max(0, Math.min(gridHeight - 1, globalY / stride - gridStartY));
      const x0 = Math.floor(sampleX);
      const y0 = Math.floor(sampleY);
      const x1 = Math.min(gridWidth - 1, x0 + 1);
      const y1 = Math.min(gridHeight - 1, y0 + 1);
      const tx = sampleX - x0;
      const ty = sampleY - y0;
      const topLeft = (y0 * gridWidth + x0) * 3;
      const topRight = (y0 * gridWidth + x1) * 3;
      const bottomLeft = (y1 * gridWidth + x0) * 3;
      const bottomRight = (y1 * gridWidth + x1) * 3;
      const sampleChannel = (channel: number): number => {
        const top = blurredRGB[topLeft + channel] * (1 - tx) + blurredRGB[topRight + channel] * tx;
        const bottom = blurredRGB[bottomLeft + channel] * (1 - tx) + blurredRGB[bottomRight + channel] * tx;
        return top * (1 - ty) + bottom * ty;
      };
      const color: RGB = [sampleChannel(0), sampleChannel(1), sampleChannel(2)];
      const difference = Math.max(
        Math.abs(color[0] - center[0]),
        Math.abs(color[1] - center[1]),
        Math.abs(color[2] - center[2]),
      );
      return { color, transition: Math.min(1, difference / 36) };
    },
  };
}

function blendContourColor(base: number, contour: number, alpha: number): number {
  return Math.round(base * (1.0 - alpha) + contour * alpha);
}

function smoothstep01(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

/** Anti-aliased strength for a periodic distance contour. */
function periodicContourStrength(
  distance: number,
  spacing: number,
  halfWidth: number,
): number {
  const wrapped = ((distance % spacing) + spacing) % spacing;
  const nearest = Math.min(wrapped, spacing - wrapped);
  return 1 - smoothstep01(nearest / Math.max(0.001, halfWidth));
}

function smoothContourElevation(
  elevation: Float32Array,
  width: number,
  height: number,
  passes: number
): Float32Array {
  if (passes <= 0) return elevation;

  let source = elevation;
  for (let pass = 0; pass < passes; pass++) {
    const smoothed = new Float32Array(source.length);

    for (let y = 0; y < height; y++) {
      const yNorth = Math.max(0, y - 1);
      const ySouth = Math.min(height - 1, y + 1);
      for (let x = 0; x < width; x++) {
        const xWest = Math.max(0, x - 1);
        const xEast = Math.min(width - 1, x + 1);
        const center = source[y * width + x];
        const north = source[yNorth * width + x];
        const south = source[ySouth * width + x];
        const west = source[y * width + xWest];
        const east = source[y * width + xEast];
        const northWest = source[yNorth * width + xWest];
        const northEast = source[yNorth * width + xEast];
        const southWest = source[ySouth * width + xWest];
        const southEast = source[ySouth * width + xEast];

        // A compact Gaussian-like kernel: center 4, edges 2, corners 1.
        smoothed[y * width + x] = (
          center * 4.0 +
          (north + south + west + east) * 2.0 +
          northWest + northEast + southWest + southEast
        ) / 16.0;
      }
    }

    source = smoothed;
  }

  return source;
}

// 1. Swiss Topo Color Palette Ramp
const SWISS_TOPO_RAMP: [number, [number, number, number]][] = [
  [0.00, [68, 138, 72]],    // Deep river plain green
  [0.12, [118, 172, 85]],   // Lush meadow
  [0.25, [178, 206, 112]],  // Pasture green
  [0.40, [232, 222, 142]],  // Foothills ochre
  [0.55, [224, 155, 72]],   // Terracotta slope
  [0.70, [196, 96, 38]],    // Rust alpine rock
  [0.85, [148, 140, 140]],  // Granite peak
  [1.00, [250, 252, 255]],  // Snow summit
];

// 2. European Topo Classic DEM Ramp
const EUROPEAN_TOPO_RAMP: [number, [number, number, number]][] = [
  [0.00, [42, 108, 55]],
  [0.15, [95, 155, 68]],
  [0.30, [165, 195, 95]],
  [0.45, [235, 215, 130]],
  [0.60, [215, 135, 55]],
  [0.75, [165, 65, 25]],
  [0.90, [105, 35, 15]],
  [1.00, [245, 248, 252]],
];

// 3. Physical Satellite Ramp
const PHYSICAL_SATELLITE_RAMP: [number, [number, number, number]][] = [
  [0.00, [32, 75, 28]],
  [0.18, [58, 110, 42]],
  [0.35, [115, 130, 65]],
  [0.52, [155, 135, 80]],
  [0.70, [130, 110, 90]],
  [0.85, [105, 95, 90]],
  [1.00, [240, 245, 255]],
];

// 4. Alpine Glacial Ramp
const ALPINE_GLACIAL_RAMP: [number, [number, number, number]][] = [
  [0.00, [50, 90, 75]],
  [0.20, [80, 135, 120]],
  [0.40, [140, 175, 170]],
  [0.60, [190, 210, 215]],
  [0.80, [220, 235, 245]],
  [1.00, [255, 255, 255]],
];

// 5. Thermal Magma / Inferno Ramp
const THERMAL_MAGMA_RAMP: [number, [number, number, number]][] = [
  [0.00, [0, 0, 4]],
  [0.18, [40, 11, 84]],
  [0.36, [101, 21, 110]],
  [0.54, [159, 42, 99]],
  [0.72, [212, 72, 66]],
  [0.90, [245, 125, 21]],
  [1.00, [252, 255, 164]],
];

// 6. Viridis Scientific Ramp
const VIRIDIS_RAMP: [number, [number, number, number]][] = [
  [0.00, [68, 1, 84]],
  [0.20, [59, 82, 139]],
  [0.40, [33, 145, 140]],
  [0.60, [94, 201, 98]],
  [0.80, [180, 222, 44]],
  [1.00, [253, 231, 37]],
];

// 7. Slope Hazard Ramp (Green flat -> Yellow -> Red cliff -> Purple abyss)
const SLOPE_HAZARD_RAMP: [number, [number, number, number]][] = [
  [0.00, [34, 197, 94]],   // 0 deg: Emerald green (flat valley)
  [0.18, [132, 204, 22]],  // 15 deg: Lime green (gentle slope)
  [0.35, [234, 179, 8]],   // 30 deg: Yellow (moderate incline)
  [0.55, [249, 115, 22]],  // 45 deg: Orange (steep scree)
  [0.75, [239, 68, 68]],   // 60 deg: Red (precipitous cliff)
  [1.00, [147, 51, 234]],  // 80+ deg: Purple (vertical horn)
];

const TREE_SUITABILITY_RAMP: [number, [number, number, number]][] = [
  [0.00, [165, 0, 38]],
  [0.25, [244, 109, 67]],
  [0.50, [254, 224, 139]],
  [0.75, [166, 217, 106]],
  [1.00, [26, 152, 80]],
];

function sampleColorRamp(
  ramp: [number, [number, number, number]][],
  t: number
): [number, number, number] {
  const ct = Math.max(0.0, Math.min(1.0, t));
  if (ct <= ramp[0][0]) return ramp[0][1];
  const last = ramp[ramp.length - 1];
  if (ct >= last[0]) return last[1];

  for (let i = 0; i < ramp.length - 1; i++) {
    const [t0, c0] = ramp[i];
    const [t1, c1] = ramp[i + 1];
    if (ct >= t0 && ct <= t1) {
      const alpha = (ct - t0) / (t1 - t0);
      return [
        Math.round(c0[0] * (1 - alpha) + c1[0] * alpha),
        Math.round(c0[1] * (1 - alpha) + c1[1] * alpha),
        Math.round(c0[2] * (1 - alpha) + c1[2] * alpha),
      ];
    }
  }
  return last[1];
}

function getRampForPalette(palette: MountainColorPalette): [number, [number, number, number]][] {
  switch (palette) {
    case 'european_topo': return EUROPEAN_TOPO_RAMP;
    case 'physical_satellite': return PHYSICAL_SATELLITE_RAMP;
    case 'alpine_glacial': return ALPINE_GLACIAL_RAMP;
    case 'thermal_magma': return THERMAL_MAGMA_RAMP;
    case 'viridis': return VIRIDIS_RAMP;
    case 'slope_hazard': return SLOPE_HAZARD_RAMP;
    case 'swiss_topo':
    default:
      return SWISS_TOPO_RAMP;
  }
}

/**
 * Aspect color wheel mapping compass direction (0 to 360 deg) to distinctive hues.
 */
function getAspectRGB(aspectDeg: number): [number, number, number] {
  const rad = (aspectDeg * Math.PI) / 180.0;
  const r = Math.round(128 + 127 * Math.sin(rad));
  const g = Math.round(128 + 127 * Math.sin(rad + (2 * Math.PI) / 3));
  const b = Math.round(128 + 127 * Math.sin(rad + (4 * Math.PI) / 3));
  return [r, g, b];
}

/**
 * Shared antique watercolor wash for rivers and ocean:
 * shallowness = 1.0 (shallow / headwaters / coastal shore) -> [96, 160, 208] (clear map blue)
 * shallowness = 0.0 (deep channel / trunk river / open ocean) -> [29, 82, 126] (deep navy blue)
 */
function getWaterWashRGB(
  shallowness: number,
  shallowColor: RGB = DEFAULT_WATER_SHALLOW_RGB,
  deepColor: RGB = DEFAULT_WATER_DEEP_RGB,
): RGB {
  const t = Math.max(0, Math.min(1, shallowness));
  return [
    Math.round(deepColor[0] * (1 - t) + shallowColor[0] * t),
    Math.round(deepColor[1] * (1 - t) + shallowColor[1] * t),
    Math.round(deepColor[2] * (1 - t) + shallowColor[2] * t),
  ];
}

/**
 * Biome color mapping for ecological classification layer.
 */
function getBiomeRGB(
  biomeId: number,
  biomeColors: Readonly<Record<number, RGB>> = MOUNTAIN_BIOME_WASH_COLORS,
  waterShallowColor: RGB = DEFAULT_WATER_SHALLOW_RGB,
  waterDeepColor: RGB = DEFAULT_WATER_DEEP_RGB,
): RGB {
  if (biomeId === 6) return waterShallowColor;
  if (biomeId === 8) return waterDeepColor;
  if (biomeId >= 0 && biomeId <= 14) {
    return getVegetationWashRGB(biomeId, biomeColors);
  }
  return [100, 100, 100];
}

/** Dark ink lines on deep-ocean waves. Disabled for now; set to 1 to restore. */
const OCEAN_WAVE_INK_OPACITY = 0;

/** Long edge (px) of the live preview DEM that water controls are authored at. */
export const WATER_REFERENCE_LONG_EDGE = 2048;

/**
 * Water controls are authored in pixels of the 2048px live preview DEM. When a
 * raster is rendered at `scale` × that resolution (the reduced internal
 * preview, or an export whose DEM and output size differ), scale pixel lengths
 * and inverse-scale densities so marks keep the same map-relative size and
 * spacing.
 */
export function scaleWaterPresentationOptions(
  options: MountainRenderOptions,
  scale: number,
): Partial<MountainRenderOptions> {
  const pixels = (value: number | undefined, fallback: number) =>
    (value ?? fallback) * scale;
  return {
    waterOutlineThickness: pixels(options.waterOutlineThickness, 1),
    waterOutlineLength: pixels(options.waterOutlineLength, 1),
    waterFlowThickness: pixels(options.waterFlowThickness, 1),
    waterFlowDensity: (options.waterFlowDensity ?? 1) / Math.max(0.25, scale),
    waterFlowLength: pixels(options.waterFlowLength, 1),
    wetlandPoolContourLength: pixels(options.wetlandPoolContourLength, 1.8),
    deepOceanWaveLength: pixels(
      options.deepOceanWaveLength ?? options.waterOutlineLength,
      1,
    ),
    deepOceanStrokeThickness: pixels(
      options.deepOceanStrokeThickness ?? options.waterOutlineThickness,
      1,
    ),
    deepOceanWaveShadingScale: options.deepOceanWaveShadingScale ?? 4.5,
    deepOceanWaveShadingIntensity: options.deepOceanWaveShadingIntensity ?? 2.5,
    oceanPixelScale: scale,
    wetlandPuddleCoordinateScale: scale,
  };
}

/** Shared preview/export controls for the global mountain drawing. */
export function getMountainPatternOptions(
  dem: MountainDEMData,
  options: MountainRenderOptions,
) {
  // The study resolves its pens and terrain filters at 1024 samples over 8 km.
  // Keep that physical support at other analysis/export resolutions; otherwise
  // a 2K preview detects twice as fine a ridge network as the reference.
  const cameraEnabled = options.fullTerrainCameraElevationDeg !== undefined;
  const linework = normalizeMountainLineworkSettings(
    options.mountainLineworkScale,
    options.mountainLineworkOpacity,
    options.mountainHatchDensity,
    options.mountainHatchThickness ?? options.vegetation?.strokeThickness
      ?? (options.waterOutlineThickness ?? (options.oceanPixelScale ?? 1)) / (options.oceanPixelScale ?? 1),
    options.mountainRidgeDensity ?? options.vegetation?.mountainSideRidgeDensity,
    options.mountainRidgeThickness ?? options.vegetation?.mountainMainRidgeThickness,
    options.mountainHatchOpacity ?? options.mountainLineworkOpacity
      ?? options.vegetation?.strokeOpacity ?? options.waterOutlineOpacity,
    options.mountainHatchHorizontalOpacity,
    options.mountainHatchVerticalOpacity,
  );
  const hasIndependentLineworkSettings = options.mountainHatchThickness !== undefined
    || options.mountainRidgeDensity !== undefined
    || options.mountainRidgeThickness !== undefined
    || options.mountainLineworkScale !== undefined
    || options.mountainLineworkOpacity !== undefined
    || options.mountainHatchOpacity !== undefined
    || options.mountainHatchHorizontalOpacity !== undefined
    || options.mountainHatchVerticalOpacity !== undefined
    || options.mountainHatchDensity !== undefined;
  const pixelScale = cameraEnabled
    ? Math.max(0.25, (8000 / 1024) / Math.max(1e-6, dem.dxMeters, dem.dyMeters))
    : options.mountainPatternPixelScale ?? options.oceanPixelScale ?? 1;
  // Keep the same seed placement and terrain tracing, but give each hachure
  // family twice the former integration length. The upper bound is raised
  // with the multiplier so the value is not silently clamped back to one.
  const detailLengthScale = 2 * (cameraEnabled ? 1 : Math.max(0.65, Math.min(1,
    8 / (Math.max(dem.dxMeters, dem.dyMeters) * pixelScale))));
  return {
    scale: pixelScale,
    hatchDensity: linework.hatchDensity,
    localDetailDensityMax: options.mountainLocalDetailDensityMax,
    foothillDetailMultiplier: options.mountainFoothillDetailMultiplier,
    biomeDetailMultiplier: options.mountainBiomeDetailMultiplier,
    hatchOpacity: linework.hatchOpacity,
    horizontalHatchOpacity: linework.horizontalHatchOpacity,
    verticalHatchOpacity: linework.verticalHatchOpacity,
    hatchThickness: linework.hatchThickness * linework.scale,
    ridgeDensity: linework.ridgeDensity,
    ridgeThickness: linework.ridgeThickness,
    ridgeStrokeThickness: hasIndependentLineworkSettings
      ? linework.ridgeThickness * linework.scale
      : linework.hatchThickness * linework.ridgeThickness * linework.scale,
    detailLengthScale,
    offsetX: options.oceanCoordinateOffsetX ?? 0,
    offsetY: options.oceanCoordinateOffsetY ?? 0,
    stride: options.oceanCoordinateStride ?? dem.width,
    seed: options.vegetation?.seed ?? 23817,
    // Mountain charcoal has its own normalized pen. Keep the vegetation and
    // water fallbacks for older saved render requests that predate the
    // independent mountain controls.
    strokeThickness: linework.hatchThickness * linework.scale,
    // Once the studio supplies the independent mountain controls, vegetation
    // stroke opacity no longer changes mountain ink. Older render requests
    // retain their historical fallback for compatibility.
    strokeOpacity: hasIndependentLineworkSettings
      ? linework.opacity
      : options.vegetation?.strokeOpacity ?? options.waterOutlineOpacity ?? 0.8,
    drySkipProbability: options.vegetation?.drySkipProbability ?? 0.05,
    sideRidgeDensity: linework.ridgeDensity,
    mainRidgeThickness: linework.ridgeThickness,
  };
}

/**
 * Validate all DEM-dependent stage caches before any asynchronous preparation
 * starts. This is shared by the synchronous renderer and worker prepasses so
 * a changed DEM cannot invalidate fields after they have been prepared.
 */
export function validateMountainRenderStageCache(
  dem: MountainDEMData,
  cache?: MountainRenderStageCache,
): void {
  if (!cache) return;
  const demElevationFingerprint = getMountainFieldFingerprint(dem.elevation);
  const demSlopeFingerprint = getMountainFieldFingerprint(dem.slopeDeg);
  const lineworkInput = Uint8Array.from(dem.elevation, (_, index) => (
    dem.isOcean[index] > 0
    || dem.isRiverChannel[index] > 0
    || (dem.visualWaterMask?.[index] ?? 0) > 0
    || dem.biomeType[index] === 6
    || dem.biomeType[index] === 8
  ) ? 1 : 0);
  const demLineworkFingerprint = getMountainFieldFingerprint(lineworkInput);
  const demSourceChanged = cache.dem === dem && (
    cache.demElevationFingerprint !== demElevationFingerprint
    || cache.demSlopeFingerprint !== demSlopeFingerprint
    || cache.demLineworkFingerprint !== demLineworkFingerprint
  );
  if (cache.dem === dem && !demSourceChanged) return;
  cache.mountainFieldCache = createMountainFieldCache();
  cache.demElevationFingerprint = demElevationFingerprint;
  cache.demSlopeFingerprint = demSlopeFingerprint;
  cache.demLineworkFingerprint = demLineworkFingerprint;
  cache.mountainPatternKey = undefined;
  cache.mountainPattern = undefined;
  cache.mountainShadowKey = undefined;
  cache.mountainShadow = undefined;
  cache.mountainIllustrationKey = undefined;
  cache.mountainIllustration = undefined;
  cache.mountainIllustrationPreparedFieldSet = undefined;
  cache.dem = dem;
  cache.waterKey = undefined;
  cache.waterGeometryKey = undefined;
  cache.waterGeometry = null;
  cache.waterGeometryRiverSplinesOverride = undefined;
  cache.waterGeometryOceanDistanceOverride = undefined;
  cache.waterGeometryOceanMaskCoverageOverride = undefined;
  cache.waterPaintKey = undefined;
  cache.waterOverlay = null;
  cache.vegetationWaterCoverage = undefined;
  cache.vegetationWaterCoverageOverlay = undefined;
  cache.vegetationGeometryKey = undefined;
  cache.vegetationGeometry = null;
  cache.vegetationOverlayKey = undefined;
  cache.vegetationOverlay = null;
  cache.vegetationStages = {};
  cache.contourKey = undefined;
  cache.contourElevation = undefined;
}

/** Whether the detail compositor will consume the mountain illustration stage. */
export function needsMountainIllustrationStage(
  options: MountainRenderOptions,
): boolean {
  if (options.skipMountainIllustrationStage) return false;
  const isPureHeightmapLayer = options.layer === 'raw_heightmap'
    || options.layer === 'eroded_heightmap';
  const shouldRenderFullTerrainIllustration =
    options.fullTerrainCameraElevationDeg !== undefined && !isPureHeightmapLayer;
  return (options.layer === 'vegetation_patterns' && !options.mountainIllustrationRGBA)
    || (shouldRenderFullTerrainIllustration
      && (!options.mountainIllustrationRGBA || !options.deferFullTerrainCamera));
}

/** Builds mountain pixels independently of the water/vegetation compositor. */
export interface MountainIllustrationStageInputs {
  dem: MountainDEMData;
  options: MountainRenderOptions;
  pattern: MountainPatternOverlay;
  shadow: Float32Array;
  patternOptions: ReturnType<typeof getMountainPatternOptions>;
  illustrationOptions: MountainIllustrationOptions;
  fieldInputs: ReturnType<typeof createMountainIllustrationFieldInputs>;
  mountainIllustrationKey: string;
  illustrationCacheHit: boolean;
  cache?: MountainRenderStageCache;
  fieldCache?: MountainFieldCache;
  fieldSession?: MountainFieldCacheSession;
}

/** Build pattern, shadow, painter options, and shared field dependencies once. */
export function buildMountainIllustrationStageInputs(
  dem: MountainDEMData,
  options: MountainRenderOptions,
  cache?: MountainRenderStageCache,
  patternOverride?: MountainPatternOverlay,
  profiler?: MountainProfiler,
  fieldCacheOverride?: MountainFieldCache,
): MountainIllustrationStageInputs {
  // Override geometry belongs to a specific export tile, whereas preview
  // cache keys describe only the DEM and presentation controls.
  const stageCache = patternOverride ? undefined : cache;
  const fieldCache = fieldCacheOverride ?? stageCache?.mountainFieldCache;
  const fieldSession = createMountainFieldCacheSession(fieldCache);
  const { width, height } = dem;
  const mountainPatternOptions = getMountainPatternOptions(dem, options);
  const mountainPatternKey = JSON.stringify(mountainPatternOptions);
  const patternCacheHit = Boolean(
    patternOverride ||
      (stageCache?.mountainPatternKey === mountainPatternKey && stageCache.mountainPattern),
  );
  profiler?.recordCache('mountain pattern', patternCacheHit);
  const patternStop = profiler?.begin('mountain pattern');
  const mountainPattern = patternOverride ?? (patternCacheHit
    ? stageCache!.mountainPattern!
    : renderMountainPatternOverlay(
      dem,
      mountainPatternOptions,
      profiler,
      fieldCache,
    ));
  patternStop?.();
  if (stageCache) {
    stageCache.mountainPatternKey = mountainPatternKey;
    stageCache.mountainPattern = mountainPattern;
  }
  const mountainShadowKey = `${mountainPatternKey}:${options.sunAzimuthDeg}`;
  const shadowCacheHit = Boolean(
    stageCache?.mountainShadowKey === mountainShadowKey && stageCache.mountainShadow,
  );
  profiler?.recordCache('mountain shadow', shadowCacheHit);
  const shadowStop = profiler?.begin('mountain shadow');
  const mountainShadow = shadowCacheHit
    ? stageCache!.mountainShadow!
    : renderMountainPatternShadow(
        mountainPattern,
        width,
        height,
        options.sunAzimuthDeg,
        mountainPatternOptions.scale,
        profiler,
      );
  shadowStop?.();
  if (stageCache) {
    stageCache.mountainShadowKey = mountainShadowKey;
    stageCache.mountainShadow = mountainShadow;
  }
  // Mountain ridge and hatch marks default to the shared charcoal/vegetation
  // ink for backwards compatibility, but can now use independent palette
  // colours. Water outlines keep their own blue color in the compositor below.
  const mountainInkColor = parseHexColor(options.vegetation?.inkColor, [43, 56, 66]);
  const mountainHatchColor = parseHexColor(options.mountainHatchColor, mountainInkColor);
  const mountainRidgeColor = parseHexColor(options.mountainRidgeColor, mountainInkColor);
  const mountainWashOptions = {
    washStrength: options.vegetation?.flowWashStrength ?? 0.24,
    washDarkStrength: options.vegetation?.flowWashDarkStrength ?? 0.22,
    washLightStrength: options.vegetation?.flowWashLightStrength ?? 0.12,
    washNoiseStrength: options.vegetation?.flowWashNoiseStrength ?? 0.45,
    washNoiseScale: options.vegetation?.flowWashNoiseScale ?? 1,
    // Flat, low rock faces pick up the palette's woodland green.
    landGreenColor: getVegetationWashRGB(4, resolveMountainBiomeWashColors(options.vegetationBiomeColors)),
  };
  const mountainProjection = normalizeMountainProjectionSettings(
    options.mountainViewAngleDeg,
    options.mountainHeightExaggeration,
  );
  const snowfall = normalizeMountainSnowfallSettings(
    options.snowfallAmount,
    options.snowfallDrift,
    options.snowfallPersistence,
    options.snowRedistributionSteps,
  );
  const windAzimuthDeg = ((options.windAzimuthDeg ?? 225) % 360 + 360) % 360;
  const mountainIllustrationKey = JSON.stringify([
    mountainShadowKey,
    options.sunAltitudeDeg,
    options.hillshadeStrength ?? 1,
    mountainInkColor,
    mountainHatchColor,
    mountainRidgeColor,
    mountainWashOptions,
    mountainProjection,
    snowfall,
    windAzimuthDeg,
    options.mountainLightingMode ?? DEFAULT_MOUNTAIN_LIGHTING_MODE,
  ]);
  const illustrationCacheHit = Boolean(
    !options.snowTransportOverride &&
      stageCache?.mountainIllustrationKey === mountainIllustrationKey &&
      stageCache.mountainIllustration,
  );
  const naturalElevation = mountainPattern.surfaceElevation ?? dem.elevation;
  const faceField = getMountainIllustrationFaceField(
    dem,
    naturalElevation,
    mountainPatternOptions.scale,
    mountainPatternOptions.offsetX,
    mountainPatternOptions.offsetY,
    fieldCache,
    fieldSession,
  );
  return {
    dem,
    options,
    pattern: mountainPattern,
    shadow: mountainShadow,
    patternOptions: mountainPatternOptions,
    illustrationOptions: {
      ...mountainPatternOptions,
      ...mountainWashOptions,
      sunAzimuthDeg: options.sunAzimuthDeg,
      sunAltitudeDeg: options.sunAltitudeDeg,
      hillshadeStrength: options.hillshadeStrength,
      inkColor: mountainInkColor,
      hatchColor: mountainHatchColor,
      ridgeColor: mountainRidgeColor,
      mountainViewAngleDeg: mountainProjection.viewAngleDeg,
      mountainHeightExaggeration: mountainProjection.heightExaggeration,
      lightingMode: options.mountainLightingMode ?? DEFAULT_MOUNTAIN_LIGHTING_MODE,
      snowfallAmount: snowfall.amount,
      snowfallDrift: snowfall.drift,
      snowfallPersistence: snowfall.persistence,
      snowRedistributionSteps: snowfall.redistributionSteps,
      windAzimuthDeg,
      windFieldsOverride: options.windFieldsOverride,
      snowTransportOverride: options.snowTransportOverride,
    },
    fieldInputs: createMountainIllustrationFieldInputs(
      dem,
      mountainPattern,
      faceField,
      mountainPatternOptions.scale,
      mountainPatternOptions.offsetX,
      mountainPatternOptions.offsetY,
    ),
    mountainIllustrationKey,
    illustrationCacheHit,
    cache: stageCache,
    fieldCache,
  };
}

function preparedFieldSetMatches(
  inputs: MountainIllustrationStageInputs,
  prepared?: MountainIllustrationPreparedFieldSet,
): boolean {
  return Boolean(
    prepared &&
      isMountainIllustrationPreparedFieldsCompatible(
        prepared.fields,
        inputs.dem.width,
        inputs.dem.height,
      ) &&
      prepared.dependencySignature ===
        getMountainIllustrationFieldDependencySignature(inputs.fieldInputs),
  );
}

export function renderMountainIllustrationStageFromInputs(
  inputs: MountainIllustrationStageInputs,
  prepared?: MountainIllustrationPreparedFieldSet,
  profiler?: MountainProfiler,
): MountainIllustration | undefined {
  return (
    renderMountainIllustrationStageFromInputsInternal(
      inputs,
      prepared,
      profiler,
      false,
    )
  ) as MountainIllustration | undefined;
}

/** Internal export entry point returning only the layers used by the camera. */
export function renderMountainCameraIllustrationStageFromInputs(
  inputs: MountainIllustrationStageInputs,
  prepared?: MountainIllustrationPreparedFieldSet,
  profiler?: MountainProfiler,
  onStage?: (stage: 'terrain fields' | 'lighting and snow' | 'projection and material' | 'stroke painting') => void,
): MountainCameraIllustrationLayers | undefined {
  return (
    renderMountainIllustrationStageFromInputsInternal(
      inputs,
      prepared,
      profiler,
      true,
      onStage,
    )
  ) as MountainCameraIllustrationLayers | undefined;
}

function renderMountainIllustrationStageFromInputsInternal(
  inputs: MountainIllustrationStageInputs,
  prepared: MountainIllustrationPreparedFieldSet | undefined,
  profiler: MountainProfiler | undefined,
  cameraLayersOnly: boolean,
  onStage?: (stage: 'terrain fields' | 'lighting and snow' | 'projection and material' | 'stroke painting') => void,
): MountainIllustration | MountainCameraIllustrationLayers | undefined {
  profiler?.recordCache('mountain illustration', !cameraLayersOnly && inputs.illustrationCacheHit);
  const illustrationStageStop = profiler?.begin('mountain illustration');
  if (cameraLayersOnly) {
    const cameraLayers = renderMountainCameraIllustration(
        inputs.dem,
        inputs.pattern,
        inputs.shadow,
        {
          ...inputs.illustrationOptions,
          preparedFields: preparedFieldSetMatches(inputs, prepared)
            ? prepared!.fields
            : undefined,
        },
        profiler,
        inputs.fieldCache,
        inputs.fieldSession,
        onStage,
      );
    illustrationStageStop?.();
    return cameraLayers;
  }
  const mountainIllustration = inputs.illustrationCacheHit
    ? inputs.cache!.mountainIllustration!
    : renderMountainIllustration(
        inputs.dem,
        inputs.pattern,
        inputs.shadow,
        {
          ...inputs.illustrationOptions,
          preparedFields: preparedFieldSetMatches(inputs, prepared)
            ? prepared!.fields
            : undefined,
        },
        profiler,
        inputs.fieldCache,
        inputs.fieldSession,
      );
  if (mountainIllustration && !mountainIllustration.surfaceElevation) {
    mountainIllustration.surfaceElevation = inputs.pattern.surfaceElevation;
  }
  illustrationStageStop?.();
  if (inputs.cache && !inputs.options.snowTransportOverride) {
    inputs.cache.mountainIllustrationKey = inputs.mountainIllustrationKey;
    inputs.cache.mountainIllustration = mountainIllustration;
    if (preparedFieldSetMatches(inputs, prepared)) {
      inputs.cache.mountainIllustrationPreparedFieldSet = prepared;
    }
  }
  if (mountainIllustration) {
    mountainIllustration.cameraRidgePaths =
      inputs.pattern.cameraRidgePaths ?? inputs.pattern.paths;
  }
  return mountainIllustration;
}

export function renderMountainIllustrationStage(
  dem: MountainDEMData,
  options: MountainRenderOptions,
  cache?: MountainRenderStageCache,
  patternOverride?: MountainPatternOverlay,
  profiler?: MountainProfiler,
  fieldCacheOverride?: MountainFieldCache,
  preparedFieldSet?: MountainIllustrationPreparedFieldSet,
): MountainIllustration | undefined {
  const inputs = buildMountainIllustrationStageInputs(
    dem,
    options,
    cache,
    patternOverride,
    profiler,
    fieldCacheOverride,
  );
  return renderMountainIllustrationStageFromInputs(
    inputs,
    preparedFieldSet ?? inputs.cache?.mountainIllustrationPreparedFieldSet,
    profiler,
  );
}

/**
 * Renders the mountain DEM onto an ImageData buffer based on active layer and options.
 */
export function renderMountainDetailDEM(
  dem: MountainDEMData,
  options: MountainRenderOptions,
  profiler?: MountainProfiler,
): MountainDetailImageData {
  return renderMountainDetailDEMWithCache(dem, options, undefined, profiler, undefined);
}

export function renderMountainDetailDEMWithCache(
  dem: MountainDEMData,
  options: MountainRenderOptions,
  cache?: MountainRenderStageCache,
  profiler?: MountainProfiler,
  preparedFieldSet?: MountainIllustrationPreparedFieldSet,
  control?: MountainDetailRenderControl,
): MountainDetailImageData {
  const detailStop = profiler?.begin('mountain detail renderer total');
  // A global camera owns the final relief projection. Keep all local
  // illustration passes in map space so the relief is applied exactly once,
  // including when an export tile defers the camera to the assembled image.
  if (options.fullTerrainCameraElevationDeg !== undefined &&
      (options.mountainViewAngleDeg !== 90 || options.mountainHeightExaggeration !== 1)) {
    options = {
      ...options,
      mountainViewAngleDeg: 90,
      mountainHeightExaggeration: 1,
    };
  }
  // Validate the DEM before any stage work or asynchronous GPU preparation.
  validateMountainRenderStageCache(dem, cache);
  const { width, height } = dem;
  const totalCells = width * height;
  const pixels = new Uint8ClampedArray(totalCells * 4);

  const ramp = getRampForPalette(options.palette);
  const layer = options.layer;
  const aoStrength = options.ambientOcclusionStrength;
  const hillshadeStrength = Math.max(0, Math.min(1, options.hillshadeStrength ?? 1));
  const isPureHeightmapLayer = layer === 'raw_heightmap' || layer === 'eroded_heightmap';
  // Include carved submerged beds in the grayscale range. Without this, the
  // fixed sea-level floor clamps every ocean incision to the same black value.
  let heightmapLowerLimitM = options.heightmapLowerLimitMOverride ?? -10.0;
  if (options.heightmapLowerLimitMOverride === undefined) {
    for (const elevation of dem.elevation) {
      heightmapLowerLimitM = Math.min(heightmapLowerLimitM, elevation);
    }
  }
  const heightmapElevationRange = Math.max(1.0, dem.maxElevationM - heightmapLowerLimitM);
  const rainOpacity = options.rainOverlayOpacity ?? 0.0;
  const erosionOverlayOpacity = options.erosionOverlayOpacity ?? 0.0;
  const showContours = options.showContours;
  const contourInt = Math.max(1.0, options.contourIntervalM || 100.0);
  const contourSmoothingPasses = Math.max(0, Math.min(4, Math.round(options.contourSmoothingPasses ?? 0)));
  const nextContourKey = showContours
    ? `${contourSmoothingPasses}`
    : "none";
  const canReuseContour = Boolean(
    cache && cache.contourKey === nextContourKey && cache.contourElevation,
  );
  profiler?.recordCache('contours', canReuseContour);
  const contourStop = profiler?.begin('contours');
  const contourElevation = canReuseContour
    ? cache!.contourElevation!
    : showContours
      ? smoothContourElevation(
          dem.elevation,
          width,
          height,
          contourSmoothingPasses,
        )
      : dem.elevation;
  contourStop?.();
  if (cache && !canReuseContour) {
    cache.contourKey = nextContourKey;
    cache.contourElevation = contourElevation;
    cache.stats.contourFieldBuilds++;
  }
  const contourThicknessM = Math.max(0.1, options.contourThicknessM ?? 4.0);
  const contourIndexThicknessM = Math.max(0.1, options.contourIndexThicknessM ?? 6.0);
  const showIndexContours = options.showIndexContours ?? true;
  const contourIndexEvery = Math.max(2, Math.round(options.contourIndexEvery ?? 5));
  const contourOpacity = Math.max(0.0, Math.min(1.0, options.contourOpacity ?? 1.0));
  const contourColor = parseHexColor(options.contourColor, [60, 60, 60]);
  const contourIndexColor = parseHexColor(options.contourIndexColor, [40, 40, 40]);
  const mountainHatchOpacity = Math.max(
    0,
    Math.min(
      1,
      options.mountainHatchOpacity ??
        options.mountainLineworkOpacity ??
        options.vegetation?.strokeOpacity ??
        options.waterOutlineOpacity ??
        0.8,
    ),
  );
  const mountainHatchHorizontalOpacity = Math.max(
    0,
    Math.min(1, options.mountainHatchHorizontalOpacity ?? mountainHatchOpacity),
  );
  const mountainHatchVerticalOpacity = Math.max(
    0,
    Math.min(1, options.mountainHatchVerticalOpacity ?? mountainHatchOpacity),
  );
  const waterOutlineColor = parseHexColor(options.waterOutlineColor, [23, 58, 88]);
  const waterFlowColor = parseHexColor(options.waterFlowColor, [31, 64, 90]);
  const oceanWaveInkColor = mixRGB(waterFlowColor, [24, 32, 38], 0.5);
  const vegetationBiomeColors = resolveMountainBiomeWashColors(
    options.vegetationBiomeColors,
  );
  const siltColor = getVegetationWashRGB(9, vegetationBiomeColors);
  const siltLayers = options.siltLayers ?? DEFAULT_SILT_LAYERS;
  const vegetationBiomeTransitionStrength = Math.max(
    0,
    Math.min(3, options.vegetationBiomeTransitionStrength ?? 1),
  );
  const vegetationWashField = layer === 'vegetation_patterns'
    ? createVegetationWashField(
        dem,
        vegetationBiomeColors,
        vegetationBiomeTransitionStrength,
        Math.floor(options.textureCoordinateOffsetX ?? 0),
        Math.floor(options.textureCoordinateOffsetY ?? 0),
        Math.max(1, Math.floor(options.textureCoordinateDomainWidth ?? dem.width)),
        Math.max(1, Math.floor(options.textureCoordinateDomainHeight ?? dem.height)),
      )
    : undefined;
  const waterShallowColor = parseHexColor(
    options.waterShallowColor,
    DEFAULT_WATER_SHALLOW_RGB,
  );
  const waterDeepColor = parseHexColor(
    options.waterDeepColor,
    DEFAULT_WATER_DEEP_RGB,
  );
  let maxErosionDepthM = options.maxErosionDepthMOverride ?? 0;
  if (options.maxErosionDepthMOverride === undefined) {
    for (const depth of dem.erosionDepthM) maxErosionDepthM = Math.max(maxErosionDepthM, depth);
  }

  // Build the restrained cartographic water layer once, then composite it
  // after terrain contours. All visible water uses the ecological biome mask;
  // the overlay contributes river bank/flow marks and ocean watercolor/ripples.
  const waterStageInputs = buildMountainWaterStageInputs(dem, options);
  const { shouldBuildWater, options: waterOptions } = waterStageInputs;
  const waterStop = profiler?.begin('water overlay');
  const nextWaterGeometryKey = shouldBuildWater
    ? waterStageInputs.geometryKey
    : 'none';
  const canReuseWaterGeometry = Boolean(
    cache &&
      cache.dem === dem &&
      cache.waterGeometryKey === nextWaterGeometryKey &&
      cache.waterGeometry &&
      cache.waterGeometryRiverSplinesOverride === options.riverSplinesOverride &&
      cache.waterGeometryOceanDistanceOverride === options.oceanDistanceToCoastOverride &&
      cache.waterGeometryOceanMaskCoverageOverride === options.oceanMaskCoverageOverride,
  );
  const hasWaterGeometryOverride = options.waterGeometryOverride !== undefined;
  profiler?.recordCache(
    'water geometry',
    hasWaterGeometryOverride || canReuseWaterGeometry || !shouldBuildWater,
  );
  const waterGeometryStop = cache ? profiler?.begin('water geometry') : undefined;
  const waterGeometry: WaterOverlayGeometry | null = hasWaterGeometryOverride
    ? options.waterGeometryOverride ?? null
    : cache
    ? canReuseWaterGeometry
      ? cache!.waterGeometry ?? null
      : shouldBuildWater
        ? buildWaterOverlayGeometry(dem, waterOptions, profiler)
        : null
    : null;
  waterGeometryStop?.();
  if (cache && (hasWaterGeometryOverride || !canReuseWaterGeometry)) {
    cache.waterGeometryKey = nextWaterGeometryKey;
    cache.waterGeometry = waterGeometry;
    cache.waterGeometryRiverSplinesOverride = options.riverSplinesOverride;
    cache.waterGeometryOceanDistanceOverride = options.oceanDistanceToCoastOverride;
    cache.waterGeometryOceanMaskCoverageOverride = options.oceanMaskCoverageOverride;
    cache.waterPaintKey = undefined;
    cache.waterOverlay = null;
    cache.waterKey = undefined;
    if (shouldBuildWater && !hasWaterGeometryOverride) cache.stats.waterGeometryBuilds++;
  }
  const nextWaterPaintKey = shouldBuildWater
    ? waterStageInputs.paintKey
    : 'none';
  const canReuseWaterPaint = Boolean(
    cache &&
      cache.dem === dem &&
      cache.waterGeometryKey === nextWaterGeometryKey &&
      cache.waterGeometry &&
      cache.waterPaintKey === nextWaterPaintKey &&
      cache.waterOverlay,
  );
  const hasWaterOverlayOverride = options.waterOverlayOverride !== undefined;
  profiler?.recordCache(
    'water overlay',
    hasWaterOverlayOverride || canReuseWaterPaint || !shouldBuildWater,
  );
  const waterOverlay: WaterOverlay | null = hasWaterOverlayOverride
    ? options.waterOverlayOverride ?? null
    : !cache
    ? shouldBuildWater
      ? renderWaterOverlay(dem, waterOptions, profiler)
      : null
    : canReuseWaterPaint
      ? cache!.waterOverlay ?? null
      : shouldBuildWater && waterGeometry
        ? renderWaterOverlayFromGeometry(dem, waterOptions, waterGeometry, profiler)
        : null;
  waterStop?.();
  if (cache && (hasWaterOverlayOverride || !canReuseWaterPaint)) {
    cache.waterPaintKey = nextWaterPaintKey;
    cache.waterOverlay = waterOverlay;
    cache.waterKey = nextWaterPaintKey;
    if (cache.vegetationWaterCoverageOverlay !== waterOverlay) {
      cache.vegetationWaterCoverage = undefined;
      cache.vegetationWaterCoverageOverlay = undefined;
    }
    if (shouldBuildWater && !hasWaterOverlayOverride) cache.stats.waterOverlayBuilds++;
  }
  let vegetationDem = dem;
  // A complete asynchronous overlay already contains the water coverage used
  // by vegetation. Avoid rebuilding the full-resolution merge on that path.
  if (
    layer === 'vegetation_patterns' &&
    waterOverlay &&
    options.vegetationOverlayOverride === undefined
  ) {
    const cachedWaterCoverage = cache &&
      cache.dem === dem &&
      cache.vegetationWaterCoverageOverlay === waterOverlay
      ? cache.vegetationWaterCoverage
      : undefined;
    const finalWaterCoverage = cachedWaterCoverage ?? new Float32Array(totalCells);
    if (!cachedWaterCoverage) {
      for (let index = 0; index < totalCells; index++) {
        finalWaterCoverage[index] = Math.max(
          dem.visualWaterCoverage?.[index] ?? dem.visualWaterMask?.[index] ?? 0,
          waterOverlay.waterAlpha[index] / 255,
        );
      }
      if (cache) {
        cache.vegetationWaterCoverage = finalWaterCoverage;
        cache.vegetationWaterCoverageOverlay = waterOverlay;
      }
    }
    vegetationDem = { ...dem, visualWaterCoverage: finalWaterCoverage };
  }
  waterStop?.();
  const nextVegetationGeometryKey = vegetationGeometryStageKey(options);
  const canReuseVegetationGeometry = Boolean(
    cache &&
      cache.dem === dem &&
      cache.vegetationGeometryKey === nextVegetationGeometryKey,
  );
  const hasVegetationGeometryOverride = options.vegetationGeometryOverride !== undefined;
  profiler?.recordCache('vegetation geometry', canReuseVegetationGeometry || layer !== 'vegetation_patterns');
  const vegetationGeometryStop = profiler?.begin('vegetation geometry');
  const vegetationGeometry = layer === 'vegetation_patterns'
    ? options.vegetationGeometryOverride ??
      (canReuseVegetationGeometry
        ? cache!.vegetationGeometry ?? null
        : buildVegetationGeometry(vegetationDem, options.vegetation, profiler))
    : null;
  vegetationGeometryStop?.();
  if (cache && layer === 'vegetation_patterns' && (hasVegetationGeometryOverride || !canReuseVegetationGeometry)) {
    cache.vegetationGeometryKey = nextVegetationGeometryKey;
    cache.vegetationGeometry = vegetationGeometry;
    if (!hasVegetationGeometryOverride) cache.stats.vegetationGeometryBuilds++;
    cache.vegetationOverlayKey = undefined;
    cache.vegetationOverlay = null;
  }
  const nextVegetationOverlayKey = vegetationOverlayStageKey(
    options,
    nextVegetationGeometryKey,
  );
  const canReuseVegetationOverlay = Boolean(
    cache &&
      cache.dem === dem &&
      cache.vegetationOverlayKey === nextVegetationOverlayKey,
  );
  const hasVegetationOverlayOverride = options.vegetationOverlayOverride !== undefined;
  profiler?.recordCache('vegetation rasterization', canReuseVegetationOverlay || !vegetationGeometry);
  const vegetationOverlayStop = profiler?.begin('vegetation rasterization');
  const vegetationOverlay: VegetationOverlay | null = hasVegetationOverlayOverride
    ? options.vegetationOverlayOverride ?? null
    : vegetationGeometry
    ? canReuseVegetationOverlay
      ? cache!.vegetationOverlay ?? null
      : renderVegetationOverlay(
        vegetationDem,
        vegetationGeometry,
        options.vegetation,
        options.sunAzimuthDeg,
        cache?.vegetationStages,
        nextVegetationGeometryKey,
        profiler,
      )
    : null;
  vegetationOverlayStop?.();
  if (cache && vegetationGeometry && (hasVegetationOverlayOverride || !canReuseVegetationOverlay)) {
    cache.vegetationOverlayKey = nextVegetationOverlayKey;
    cache.vegetationOverlay = vegetationOverlay;
    if (!hasVegetationOverlayOverride) cache.stats.vegetationOverlayBuilds++;
  }
  const vegetationInkColor = parseHexColor(options.vegetation?.inkColor, [47, 74, 45]);
  // Every prop (forest canopy, deciduous tree, shrub, boulder) shares one
  // outline color; vegetation ink stays for the non-prop linework.
  const propOutlineColor = parseHexColor(
    options.vegetation?.forestSettings?.outlineColor,
    vegetationInkColor,
  );
  const vegetationFlowGuideColor: RGB = [103, 72, 151];
  // The full-terrain camera must carry the illustrated cartography over the
  // complete land surface. Previously this stage was limited to the
  // vegetation diagnostic layer, leaving the default relief view without
  // ridges, hatching, or snow. Keep pure heightmap diagnostics untouched.
  const shouldRenderFullTerrainIllustration =
    options.fullTerrainCameraElevationDeg !== undefined &&
    !isPureHeightmapLayer;
  const needsMountainStage = needsMountainIllustrationStage(options);
  const mountainIllustration = needsMountainStage
    ? renderMountainIllustrationStage(
        dem,
        options,
        cache,
        undefined,
        profiler,
        undefined,
        preparedFieldSet,
      )
    : undefined;
  const mountainIllustrationRGBA = control?.omitMountainIllustration
    ? undefined
    : options.mountainIllustrationRGBA?.length === totalCells * 4
      ? options.mountainIllustrationRGBA
      : mountainIllustration && shouldRenderFullTerrainIllustration
        ? mountainCameraIllustrationTexture(mountainIllustration, {
            hatchColor: options.mountainHatchColor ?? options.vegetation?.inkColor,
            hatchOpacity: mountainHatchOpacity,
            horizontalHatchOpacity: mountainHatchHorizontalOpacity,
            verticalHatchOpacity: mountainHatchVerticalOpacity,
        })
        : mountainIllustration?.rgba;
  const vegetationTransitionWashRGB =
    layer === 'vegetation_patterns' && mountainIllustrationRGBA
      ? new Uint8ClampedArray(totalCells * 3)
      : undefined;
  const vegetationTransitionStrength = vegetationTransitionWashRGB
    ? new Uint8Array(totalCells)
    : undefined;

  const compositionStop = profiler?.begin('final composition');
  // Props sit on the terrain, so shadow-side slopes darken them like the
  // ground: the prop fill is scaled by how much darker the DEM shading is
  // than flat land (lit and flat areas stay unchanged).
  const propTerrainShadeStrength = Math.max(0, Math.min(1,
    options.vegetation?.forestSettings?.terrainShadeStrength ?? 0.7,
  ));
  // Water uses the same relative darkening so pools, rivers, lakes and ocean
  // pick up shadow-side terrain exactly like the props standing beside them.
  const waterTerrainShadeStrength = Math.max(0, Math.min(1,
    options.waterTerrainShadeStrength ?? 0.7,
  ));
  const needsPropShade = propTerrainShadeStrength > 0 && !!vegetationOverlay?.rasterPropRGBA;
  let propTerrainShade: Float32Array | undefined;
  let terrainDarkness: Float32Array | undefined;
  if (needsPropShade || waterTerrainShadeStrength > 0) {
    let flatSum = 0;
    let flatCount = 0;
    for (let i = 0; i < totalCells; i++) {
      if (dem.slopeDeg[i] >= 3 || dem.isOcean?.[i] === 1) continue;
      flatSum += 1 - hillshadeStrength * (1 - dem.hillshade[i] * (1.0 - aoStrength + aoStrength * dem.ambientOcclusion[i]));
      flatCount++;
    }
    const flatShade = flatCount > 0 ? flatSum / flatCount : 1 - hillshadeStrength * 0.3;
    terrainDarkness = new Float32Array(totalCells);
    for (let i = 0; i < totalCells; i++) {
      const terrainShade = 1 - hillshadeStrength * (1 - dem.hillshade[i] * (1.0 - aoStrength + aoStrength * dem.ambientOcclusion[i]));
      terrainDarkness[i] = Math.max(0, Math.min(1, (flatShade - terrainShade) / Math.max(0.01, flatShade)));
    }
    if (needsPropShade) {
      propTerrainShade = new Float32Array(totalCells);
      for (let i = 0; i < totalCells; i++) {
        propTerrainShade[i] = 1 - propTerrainShadeStrength * terrainDarkness[i];
      }
    }
  }
  const showWaterDetails = (options.showWaterDetails ?? true) &&
    options.showOceanDetails !== false;
  const siltLayerActive = layer === 'vegetation_patterns';
  // Silt lines use the ground pattern pen; defaults match vegetationRenderer.
  const siltLineOpacity = Math.max(0, Math.min(1, options.vegetation?.strokeOpacity ?? 0.72));
  // In export, patternScale carries the output upscale (see vegetationRenderer).
  const siltLinePixelScale = Math.max(
    0.25,
    (options.vegetation?.patternScale ?? 1) /
      Math.max(0.5, options.vegetation?.coordinatePatternScale ?? options.vegetation?.patternScale ?? 1),
  );
  const siltLineStyle: RiverSiltLineStyle = {
    // Vegetation flow strokes use radius = path width (avg 0.93) x strokeThickness.
    radiusPx: 0.93 * Math.max(0.1, Math.min(3, options.vegetation?.strokeThickness ?? 1)) * siltLinePixelScale,
    dashScale: Math.max(0.4, options.vegetation?.strokeLength ?? 1) * siltLinePixelScale,
    gapScale: siltLinePixelScale,
    drySkipProbability: Math.max(0, Math.min(1, options.vegetation?.drySkipProbability ?? 0.05)),
    layers: siltLayers,
  };
  const siltLineOffsetX = options.textureCoordinateOffsetX ?? 0;
  const siltLineOffsetY = options.textureCoordinateOffsetY ?? 0;
  const compositionWindow = options.compositionWindow;
  const x0 = Math.max(0, Math.floor(compositionWindow?.x0 ?? 0));
  const y0 = Math.max(0, Math.floor(compositionWindow?.y0 ?? 0));
  const x1 = Math.min(width, Math.ceil(compositionWindow?.x1 ?? width));
  const y1 = Math.min(height, Math.ceil(compositionWindow?.y1 ?? height));
  for (let y = y0; y < y1; y++) for (let i = y * width + x0; i < y * width + x1; i++) {
    const idx4 = i * 4;
    // Props are the foreground surface of the map. Keep this coverage value
    // available before the water detail pass so shoreline/river ink cannot
    // be painted through a tree crown or a boulder outline. The underlying
    // water wash remains visible through anti-aliased prop edges, preserving
    // the authored raster appearance while making draw order unambiguous.
    const rasterPropCoverage = Math.max(
      (vegetationOverlay?.rasterPropRGBA?.[idx4 + 3] ?? 0) / 255,
      (vegetationOverlay?.rasterPropCharcoalAlpha?.[i] ?? 0) / 255,
    );
    const normElev = dem.normalizedElevation[i];
    const shade = dem.hillshade[i];
    const ao = dem.ambientOcclusion[i];
    const effectiveShade = 1 - hillshadeStrength * (1 - shade * (1.0 - aoStrength + aoStrength * ao));
    const isOcean = dem.isOcean?.[i] === 1;
    const isRoutedWater = dem.isRiverChannel?.[i] === 1 && (
      dem.rainfallWeightedAreaKm2?.[i] ?? dem.drainageAreaKm2[i] ?? 0
    ) >= Math.max(0.001, options.riverThresholdKm2);
    const isOriginalWater = isOcean || isRoutedWater || dem.biomeType?.[i] === 6 || dem.biomeType?.[i] === 8;
    const heightmapNorm = Math.max(
      0.0,
      Math.min(1.0, (dem.elevation[i] - heightmapLowerLimitM) / heightmapElevationRange),
    );

    let r = 200;
    let g = 200;
    let b = 200;

    switch (layer) {
      case 'swiss_relief': {
        const [cr, cg, cb] = sampleColorRamp(ramp, normElev);
        // Moisture modulation for natural windward vs rain-shadow vegetation
        const precip = dem.precipitationMmYr[i];
        const moistDelta = Math.max(-0.25, Math.min(0.25, (precip - 1400.0) / 2500.0));
        let baseR = cr;
        let baseG = cg;
        let baseB = cb;
        if (normElev < 0.70) {
          baseR = Math.max(0, Math.min(255, cr * (1.0 - moistDelta * 0.35)));
          baseG = Math.max(0, Math.min(255, cg * (1.0 + moistDelta * 0.30)));
          baseB = Math.max(0, Math.min(255, cb * (1.0 - moistDelta * 0.2)));
        }
        r = Math.round(baseR * effectiveShade);
        g = Math.round(baseG * effectiveShade);
        b = Math.round(baseB * effectiveShade);
        break;
      }

      case 'raw_heightmap': {
        const val = Math.round(heightmapNorm * 255);
        r = val;
        g = val;
        b = val;
        break;
      }

      case 'eroded_heightmap': {
        // Keep the post-erosion DEM readable as a grayscale heightmap while
        // tinting the measured incision depth. This gives a direct visual
        // comparison between terrain height and the exported erosion effect.
        const heightValue = Math.round(heightmapNorm * 255);
        const erosionNorm = maxErosionDepthM > 0
          ? Math.sqrt(Math.max(0, dem.erosionDepthM[i] / maxErosionDepthM))
          : 0;
        const erosionAlpha = erosionNorm > 0
          ? Math.min(0.88, 0.16 + 0.72 * erosionNorm)
          : 0;
        r = Math.round(heightValue * (1 - erosionAlpha) + 245 * erosionAlpha);
        g = Math.round(heightValue * (1 - erosionAlpha) + 116 * erosionAlpha);
        b = Math.round(heightValue * (1 - erosionAlpha) + 22 * erosionAlpha);
        break;
      }

      case 'slope': {
        const slopeNorm = Math.min(1.0, dem.slopeDeg[i] / 75.0);
        const [cr, cg, cb] = sampleColorRamp(SLOPE_HAZARD_RAMP, slopeNorm);
        r = Math.round(cr * (0.4 + 0.6 * effectiveShade));
        g = Math.round(cg * (0.4 + 0.6 * effectiveShade));
        b = Math.round(cb * (0.4 + 0.6 * effectiveShade));
        break;
      }

      case 'aspect': {
        const [cr, cg, cb] = getAspectRGB(dem.aspectDeg[i]);
        r = Math.round(cr * (0.35 + 0.65 * effectiveShade));
        g = Math.round(cg * (0.35 + 0.65 * effectiveShade));
        b = Math.round(cb * (0.35 + 0.65 * effectiveShade));
        break;
      }

      case 'drainage_network': {
        // Shared water coverage is composited below, over quiet neutral terrain.
        const ground = Math.round((185 + heightmapNorm * 35) * (0.7 + 0.3 * effectiveShade));
        r = ground;
        g = ground;
        b = ground;
        break;
      }

      case 'erosion_depth': {
        // A routed bed contains many cells with less incision than the
        // thalweg maximum. Square-root scaling keeps that real lateral erosion
        // visible in the diagnostic/export raster instead of reducing it to a
        // one-pixel orange outline.
        const erosionNorm = maxErosionDepthM > 0
          ? Math.sqrt(Math.max(0, dem.erosionDepthM[i] / maxErosionDepthM))
          : 0;
        const [cr, cg, cb] = sampleColorRamp(
          [
            [0.00, [18, 24, 38]],
            [0.15, [30, 150, 180]],
            [0.45, [250, 204, 21]],
            [0.75, [249, 115, 22]],
            [1.00, [220, 38, 127]],
          ],
          erosionNorm
        );
        r = Math.round(cr * (0.45 + 0.55 * effectiveShade));
        g = Math.round(cg * (0.45 + 0.55 * effectiveShade));
        b = Math.round(cb * (0.45 + 0.55 * effectiveShade));
        break;
      }

      case 'precipitation': {
        const precip = dem.precipitationMmYr[i];
        const precipNorm = Math.max(0.0, Math.min(1.0, (precip - 200.0) / 3200.0));
        const [cr, cg, cb] = sampleColorRamp(
          [
            [0.00, [254, 240, 138]], // Arid rain shadow yellow
            [0.20, [253, 224, 71]],  // Semi-arid dry grassland
            [0.40, [187, 247, 208]], // Moderate moist green
            [0.60, [56, 189, 248]],  // Moist montane cyan
            [0.80, [37, 99, 235]],   // Heavy orographic deluge cobalt
            [1.00, [147, 51, 234]],  // Extreme glacial storm violet
          ],
          precipNorm
        );
        r = Math.round(cr * (0.4 + 0.6 * effectiveShade));
        g = Math.round(cg * (0.4 + 0.6 * effectiveShade));
        b = Math.round(cb * (0.4 + 0.6 * effectiveShade));
        break;
      }

      case 'solar_insolation': {
        const insolation = dem.solarInsolation[i];
        const [cr, cg, cb] = sampleColorRamp(
          [
            [0.1, [30, 27, 75]],   // Cold shaded valley blue
            [0.4, [168, 85, 247]], // Moderate slope
            [0.7, [249, 115, 22]], // Warm sunlit ridge
            [1.0, [254, 240, 138]],// High irradiance golden peak
          ],
          insolation
        );
        r = Math.round(cr * (0.4 + 0.6 * effectiveShade));
        g = Math.round(cg * (0.4 + 0.6 * effectiveShade));
        b = Math.round(cb * (0.4 + 0.6 * effectiveShade));
        break;
      }

      case 'biomes': {
        const [cr, cg, cb] = getBiomeRGB(
          dem.biomeType[i],
          vegetationBiomeColors,
          waterShallowColor,
          waterDeepColor,
        );
        r = Math.round(cr * (0.35 + 0.65 * effectiveShade));
        g = Math.round(cg * (0.35 + 0.65 * effectiveShade));
        b = Math.round(cb * (0.35 + 0.65 * effectiveShade));
        break;
      }

      case 'vegetation_patterns': {
        const wetSample = vegetationWashField!.sample(i);
        const wetColor = wetSample.color;
        const dryAmount = dem.biomeType[i] === 7
          ? (vegetationOverlay?.backgroundDryness[i] ?? 0)
          : 0;
        const dryColor = getVegetationWashRGB(4, vegetationBiomeColors);
        const [cr, cg, cb] = shadeRiverSilt(
          mixRGB(wetColor, dryColor, dryAmount),
          dem.siltDepth?.[i] ?? 0,
          siltColor,
          siltLayers,
        );
        const flowTone = vegetationOverlay?.backgroundTone[i] ?? 0.5;
        const flowStrength = options.vegetation?.flowWashStrength ?? 0.24;
        const darkWashStrength = Math.max(
          0,
          Math.min(1, options.vegetation?.flowWashDarkStrength ?? 0.22),
        );
        const lightWashStrength = Math.max(
          0,
          Math.min(1, options.vegetation?.flowWashLightStrength ?? 0.12),
        );
        const washNoise = vegetationOverlay?.backgroundNoise[i] ?? 0;
        const washNoiseStrength = options.vegetation?.flowWashNoiseStrength ?? 0.45;
        // Use three related stops: darker outer wash, neutral middle wash, and
        // a pale centre. The curl-field tone is intentionally centre-light.
        const outer: RGB = [
          cr * (1 - darkWashStrength),
          cg * (1 - darkWashStrength * 0.73),
          cb * (1 - darkWashStrength * 1.27),
        ];
        const middle: RGB = [
          cr * (1 - darkWashStrength * 0.14),
          cg * (1 - darkWashStrength * 0.09),
          cb * (1 - darkWashStrength * 0.36),
        ];
        const centre: RGB = [
          Math.min(255, cr * (1 + lightWashStrength)),
          Math.min(255, cg * (1 + lightWashStrength * 0.83)),
          Math.min(255, cb * (1 + lightWashStrength * 0.33)),
        ];
        const baseFlowPosition = Math.max(
          0,
          Math.min(1, 0.5 + (flowTone - 0.5) * flowStrength * 2),
        );
        // The color-noise field is a gradient-coordinate warp, not a second
        // RGB texture painted over the result. This keeps the shared grain
        // visible inside the wash transition itself.
        const flowPosition = Math.max(
          0,
          Math.min(1, baseFlowPosition + washNoise * washNoiseStrength * 0.26),
        );
        const washColor =
          flowPosition < 0.5
            ? mixRGB(outer, middle, flowPosition * 2)
            : mixRGB(middle, centre, (flowPosition - 0.5) * 2);
        // Keep the vegetation wash readable while letting the DEM's sun and
        // ambient-occlusion field model the full terrain, rather than only
        // tinting the flow field by a barely perceptible amount.
        const washShade = 0.55 + 0.45 * effectiveShade;
        const biomeId = dem.biomeType[i];
        const tinted = biomeId >= 1 && biomeId <= 5
          ? tintMountainLand(washColor, {
            slopeDeg: dem.slopeDeg[i],
            normElev,
            tpi: dem.tpi?.[i] ?? 0,
            insolation: dem.solarInsolation?.[i] ?? 0.5,
            noise: washNoise,
          }, getVegetationWashRGB(4, vegetationBiomeColors))
          : washColor;
        r = Math.max(0, Math.min(255, Math.round(tinted[0] * washShade)));
        g = Math.max(0, Math.min(255, Math.round(tinted[1] * washShade)));
        b = Math.max(0, Math.min(255, Math.round(tinted[2] * washShade)));
        if (wetSample.transition > 0 && vegetationTransitionWashRGB && vegetationTransitionStrength) {
          const washOffset = i * 3;
          vegetationTransitionWashRGB[washOffset] = r;
          vegetationTransitionWashRGB[washOffset + 1] = g;
          vegetationTransitionWashRGB[washOffset + 2] = b;
          vegetationTransitionStrength[i] = Math.round(wetSample.transition * 255);
        }
        break;
      }

      case 'landforms_tpi': {
        const tpiVal = dem.tpi[i];
        const normTpi = Math.max(0.0, Math.min(1.0, 0.5 + tpiVal / 120.0));
        const [cr, cg, cb] = sampleColorRamp(
          [
            [0.0, [30, 58, 138]],  // Deep canyon valley (blue)
            [0.35, [34, 197, 94]], // Lower slope & alluvial plain (green)
            [0.50, [234, 179, 8]],  // Mid slope (yellow)
            [0.70, [239, 68, 68]],  // Upper ridge shoulder (red)
            [1.0, [255, 255, 255]], // Sharp crest / summit horn (white)
          ],
          normTpi
        );
        r = Math.round(cr * (0.35 + 0.65 * effectiveShade));
        g = Math.round(cg * (0.35 + 0.65 * effectiveShade));
        b = Math.round(cb * (0.35 + 0.65 * effectiveShade));
        break;
      }

      case 'wave_patterns': {
        const isWaterPixel = waterOverlay ? waterOverlay.waterAlpha[i] > 0 : isOriginalWater;
        if (!isWaterPixel) {
          // Land: clean Swiss relief terrain
          const [cr, cg, cb] = sampleColorRamp(SWISS_TOPO_RAMP, normElev);
          r = Math.round(cr * (0.40 + 0.60 * effectiveShade));
          g = Math.round(cg * (0.40 + 0.60 * effectiveShade));
          b = Math.round(cb * (0.40 + 0.60 * effectiveShade));
        } else {
          // Water: continuous wave interference scalar field + coastal distance isolines
          const waveVal = waterOverlay?.waveField?.[i] ?? 0;
          const rawDist = waterOverlay?.distanceToCoast?.[i] ?? 0;
          const waterPatternScale = Math.max(
            0.25,
            options.oceanPixelScale ?? 1,
          );
          const normWave = Math.max(0.0, Math.min(1.0, (waveVal + 1.0) * 0.5));
          const isOceanSurface = Boolean(
            waterOverlay &&
            waterOverlay.waterAlpha[i] > 0 &&
            (waterOverlay.oceanWaterAlpha?.[i] ?? 0) > 0,
          );
          const isRiverWater = Boolean(
            waterOverlay && waterOverlay.waterAlpha[i] > 0 && !isOceanSurface,
          );

          // Marine wave interference heat map (Navy trough -> Blue mid -> Cyan crest -> White peak)
          const [wr, wg, wb] = sampleColorRamp(
            [
              [0.00, [15, 23, 42]],   // Deep wave trough (navy)
              [0.35, [30, 64, 175]],  // Submerged swell (blue)
              [0.65, [14, 165, 233]], // Rising wave front (sky cyan)
              [0.85, [56, 238, 248]], // High wave ridge (bright cyan)
              [1.00, [248, 250, 252]],// Wave crest peak (white)
            ],
            normWave
          );

          r = wr;
          g = wg;
          b = wb;

          // Coastal contours are dynamically modulated by incoming wave strength:
          // Wave crests expand/undulate the contour lines; troughs compress them
          const waveModulation =
            waveVal *
            3.2 *
            waterPatternScale *
            Math.min(1.0, rawDist / (3.0 * waterPatternScale));
          const dist = Math.max(0.1, rawDist + waveModulation);

          // Water distance contour isoline rings (including small rivers and narrow channels)
          // For narrow rivers (dist < 7.5px): fine contour isolines at dist ≈ 1.6, 3.6, 5.6
          // For open coastal waters (dist >= 7.5px): contour isolines every 8px (8, 16, 24, 32, 40, 48, 56, 64)
          // The shared ocean distance field is intentionally zero on land;
          // it must not be reused as a river-bank distance. River contours
          // come from the spline-derived alpha below, which remains valid on
          // both sides of a river mouth and is already antialiased.
          const riverContourStrength = 0;
          const oceanContourSpacing = 8.0 * waterPatternScale;
          const oceanContourStrength =
            !isRiverWater &&
            dist >= 7.5 * waterPatternScale &&
            dist < 65.0 * waterPatternScale
              ? periodicContourStrength(
                  dist,
                  oceanContourSpacing,
                  0.95 * waterPatternScale,
                )
              : 0;
          const coastContourStrength = Math.max(
            riverContourStrength,
            oceanContourStrength,
          );

          if (coastContourStrength > 0) {
            const contourAlpha = Math.max(
              0.40,
              1.0 - rawDist / (65.0 * waterPatternScale),
            ) * coastContourStrength;
            r = Math.round(r * (1 - contourAlpha) + 245 * contourAlpha);
            g = Math.round(g * (1 - contourAlpha) + 158 * contourAlpha);
            b = Math.round(b * (1 - contourAlpha) + 11 * contourAlpha);
          }

          // River contours are longitudinal strokes generated from spline
          // tangents. Apply them on either side of an outlet as well as in the
          // inland channel so the river and coastline outlines meet as one
          // continuous contour instead of stopping at a binary mask edge.
          const riverContour = (waterOverlay?.riverContourAlpha?.[i] ?? 0) / 255;
          if (riverContour > 0) {
            const contourAlpha = Math.min(0.82, riverContour * 0.82);
            r = Math.round(r * (1 - contourAlpha) + 245 * contourAlpha);
            g = Math.round(g * (1 - contourAlpha) + 158 * contourAlpha);
            b = Math.round(b * (1 - contourAlpha) + 11 * contourAlpha);
          }

          // Disturbance origin center indicators (glowing gold marker)
          if (waterOverlay?.seedOrigins && rasterPropCoverage < 0.01) {
            const px = i % width;
            const py = Math.floor(i / width);
            for (const origin of waterOverlay.seedOrigins) {
              const dSeed = Math.hypot(px - origin.x, py - origin.y);
              if (dSeed <= 4.0) {
                r = 254;
                g = 240;
                b = 138;
              } else if (dSeed >= 6.5 && dSeed <= 8.5) {
                r = 245;
                g = 158;
                b = 11;
              }
            }
          }
        }
        break;
      }
    }

    // Cast a faint shadow from bright flow-wash regions before water and
    // cartographic line details are composited. This uses the same sun angle
    // as terrain hillshade and stays clipped to dry vegetation land.
    if (layer === 'vegetation_patterns') {
      const washShadowAlpha =
        (vegetationOverlay?.washShadowAlpha[i] ?? 0) / 255;
      if (washShadowAlpha > 0) {
        const shadowFactor = 1 - washShadowAlpha * 0.52;
        r = Math.round(r * shadowFactor);
        g = Math.round(g * shadowFactor);
        b = Math.round(b * shadowFactor);
      }
    }

    // One visual water wash covers rivers, lakes, ocean, and generated wetland
    // pools. The pool geometry remains separate from hydrological routing,
    // but it has already been unioned into this rendered surface. Pool cells
    // are also an explicit priority fill so another biome cannot show through
    // at a river junction.
    const wetlandPriorityAlpha = waterOverlay?.wetlandPuddlePriorityAlpha?.[i] ?? 0;
    const hasWaterWash = waterOverlay
      ? waterOverlay.waterAlpha[i] > 0 || wetlandPriorityAlpha > 0
      : isOriginalWater;

    if (hasWaterWash && (!isPureHeightmapLayer || options.showHeightmapWater) && layer !== 'slope' && layer !== 'aspect' && layer !== 'wave_patterns') {
      const waterAlpha = waterOverlay
        ? Math.max(waterOverlay.waterAlpha[i], wetlandPriorityAlpha) / 255
        : 1.0;
      const toneValue = waterOverlay?.waterTone?.[i] ?? 128;
      const toneNorm = toneValue / 255;
      const [baseWaterR, baseWaterG, baseWaterB] = getWaterWashRGB(
        toneNorm,
        waterShallowColor,
        waterDeepColor,
      );

      const waterShade = 1 - waterTerrainShadeStrength * (terrainDarkness?.[i] ?? 0);

      let waterR = Math.round(baseWaterR * waterShade);
      let waterG = Math.round(baseWaterG * waterShade);
      let waterB = Math.round(baseWaterB * waterShade);

      const waveShadow = showWaterDetails
        ? (waterOverlay?.oceanWaveShadowAlpha?.[i] ?? 0) / 255
        : 0;
      if (waveShadow > 0) {
        const [deepR, deepG, deepB] = getWaterWashRGB(
          0,
          waterShallowColor,
          waterDeepColor,
        );
        // Keep the trough a softly painted, palette-derived blue. A restrained
        // darkening reads as water movement without turning the band into ink.
        const shadowR = Math.round(deepR * 0.72);
        const shadowG = Math.round(deepG * 0.72);
        const shadowB = Math.round(deepB * 0.72);
        const amount = Math.min(0.76, waveShadow * 0.82);
        waterR = Math.round(waterR * (1 - amount) + shadowR * amount);
        waterG = Math.round(waterG * (1 - amount) + shadowG * amount);
        waterB = Math.round(waterB * (1 - amount) + shadowB * amount);
      }
      const waveLight = showWaterDetails
        ? (waterOverlay?.oceanWaveLightAlpha?.[i] ?? 0) / 255
        : 0;
      if (waveLight > 0) {
        const [faceR, faceG, faceB] = mixRGB(
          getWaterWashRGB(0, waterShallowColor, waterDeepColor),
          getWaterWashRGB(1, waterShallowColor, waterDeepColor),
          0.82,
        );
        const amount = Math.min(0.62, waveLight * 0.64);
        waterR = Math.round(waterR * (1 - amount) + faceR * amount);
        waterG = Math.round(waterG * (1 - amount) + faceG * amount);
        waterB = Math.round(waterB * (1 - amount) + faceB * amount);
      }

      const oceanTurbulence = showWaterDetails
        ? (waterOverlay?.oceanTurbulenceAlpha?.[i] ?? 0) / 255
        : 0;
      if (oceanTurbulence > 0) {
        const turbulenceShade = 1 - oceanTurbulence;
        waterR = Math.round(waterR * turbulenceShade);
        waterG = Math.round(waterG * turbulenceShade);
        waterB = Math.round(waterB * turbulenceShade);
      }

      if (waterAlpha < 1.0) {
        r = Math.round(r * (1 - waterAlpha) + waterR * waterAlpha);
        g = Math.round(g * (1 - waterAlpha) + waterG * waterAlpha);
        b = Math.round(b * (1 - waterAlpha) + waterB * waterAlpha);
      } else {
        r = waterR;
        g = waterG;
        b = waterB;
      }
    }

    // Diagnostic overlay for the exact visible-water dryness response used
    // by raster wetland shrub placement. Keep it below every ink layer and
    // below the final image-prop composite so the diagnostic never changes
    // the authored prop colours or hides the cartographic marks.
    if (
      layer === 'vegetation_patterns' &&
      options.vegetation?.showWetlandDrynessOverlay &&
      dem.biomeType[i] === 7 &&
      !hasWaterWash
    ) {
      const wetlandDryness = Math.max(
        0,
        Math.min(1, vegetationOverlay?.wetlandDryness[i] ?? 0),
      );
      const shrubHabitat = Math.max(
        0,
        Math.min(1, vegetationOverlay?.wetlandImagePropHabitat[i] ?? 0),
      );
      const [drynessR, drynessG, drynessB] = sampleColorRamp(
        [
          [0.00, [26, 145, 190]], // Damp margin / closest to visible water
          [0.28, [38, 190, 177]],
          [0.55, [245, 205, 72]],
          [0.78, [239, 126, 47]],
          [1.00, [211, 52, 45]],
        ],
        wetlandDryness,
      );
      // Only highlight locations that fit the current damp/dry bias. This
      // makes 0% read as a narrow damp-margin band and 100% as a dry-side
      // band, while the hue still shows where each band sits by distance.
      const overlayAlpha = shrubHabitat * 0.78;
      if (overlayAlpha > 0) {
        r = blendContourColor(r, drynessR, overlayAlpha);
        g = blendContourColor(g, drynessG, overlayAlpha);
        b = blendContourColor(b, drynessB, overlayAlpha);
      }
    }

    // Optional scientific incision overlay. The water-evolution workflow
    // leaves this disabled so the user sees blue water over the evolved DEM.
    if (erosionOverlayOpacity > 0 && maxErosionDepthM > 0 && layer !== 'erosion_depth' && layer !== 'eroded_heightmap' && layer !== 'drainage_network') {
      const erosionNorm = maxErosionDepthM > 0 ? dem.erosionDepthM[i] / maxErosionDepthM : 0;
      const erosionAlpha = erosionNorm > 0
        ? Math.min(0.9, erosionOverlayOpacity * (0.08 + 0.82 * erosionNorm))
        : 0;
      const erosionR = 245;
      const erosionG = 116;
      const erosionB = 22;
      r = Math.round(r * (1 - erosionAlpha) + erosionR * erosionAlpha);
      g = Math.round(g * (1 - erosionAlpha) + erosionG * erosionAlpha);
      b = Math.round(b * (1 - erosionAlpha) + erosionB * erosionAlpha);
    }

    // Rain / Precipitation Weather Overlay on topographic layers. Keep the
    // diagnostic drainage view unblended: precipitation is a field over the
    // whole DEM, while water should only appear on routed channel cells.
    if (rainOpacity > 0 && layer !== 'precipitation' && layer !== 'drainage_network' && layer !== 'erosion_depth' && layer !== 'eroded_heightmap') {
      const precip = dem.precipitationMmYr[i];
      const pNorm = Math.max(0.0, Math.min(1.0, (precip - 300.0) / 2800.0));
      const [rainR, rainG, rainB] = sampleColorRamp(
        [
          [0.0, [186, 230, 253]], // Light mist
          [0.35, [56, 189, 248]], // Moist cyan
          [0.70, [37, 99, 235]],  // Heavy rain cobalt
          [1.0, [147, 51, 234]],  // Mountain deluge violet
        ],
        pNorm
      );
      const effectiveRainAlpha = rainOpacity * Math.min(0.85, 0.20 + 0.65 * pNorm);
      r = Math.round(r * (1 - effectiveRainAlpha) + rainR * effectiveRainAlpha);
      g = Math.round(g * (1 - effectiveRainAlpha) + rainG * effectiveRainAlpha);
      b = Math.round(b * (1 - effectiveRainAlpha) + rainB * effectiveRainAlpha);
    }

    // Contour Lines Generator
    if (!hasWaterWash && showContours && contourOpacity > 0) {
      const elev = contourElevation[i];
      const mod = ((elev % contourInt) + contourInt) % contourInt;
      const distanceToContour = Math.min(mod, contourInt - mod);
      const isContour = distanceToContour <= contourThicknessM;
      const indexInterval = contourInt * contourIndexEvery;
      const indexMod = ((elev % indexInterval) + indexInterval) % indexInterval;
      const distanceToIndexContour = Math.min(indexMod, indexInterval - indexMod);
      const isIndexContour = showIndexContours && distanceToIndexContour <= contourIndexThicknessM;

      if (isIndexContour) {
        const alpha = contourOpacity * 0.55;
        r = blendContourColor(r, contourIndexColor[0], alpha);
        g = blendContourColor(g, contourIndexColor[1], alpha);
        b = blendContourColor(b, contourIndexColor[2], alpha);
      } else if (isContour) {
        const alpha = contourOpacity * 0.30;
        r = blendContourColor(r, contourColor[0], alpha);
        g = blendContourColor(g, contourColor[1], alpha);
        b = blendContourColor(b, contourColor[2], alpha);
      }
    }

    // Silted old channels are bare sediment: trace the DEM creases through
    // them with the vegetation flow pen and keep vegetation ink out.
    const siltCoverage = siltLayerActive
      ? riverSiltCoverage(dem.siltDepth?.[i] ?? 0, siltLayers)
      : 0;
    if (siltCoverage > 0 && dem.siltCreaseDepth) {
      const waterCover = (waterOverlay?.waterAlpha[i] ?? 0) / 255;
      const crease = riverSiltCreaseAlpha(
        dem.siltCreaseDepth,
        width,
        height,
        i % width,
        Math.floor(i / width),
        siltLineOffsetX,
        siltLineOffsetY,
        siltLineStyle,
      ) * siltCoverage * siltLineOpacity * (1 - waterCover);
      if (crease > 0) {
        r = blendContourColor(r, vegetationInkColor[0], crease);
        g = blendContourColor(g, vegetationInkColor[1], crease);
        b = blendContourColor(b, vegetationInkColor[2], crease);
      }
    }
    const vegetationSiltClip = 1 - siltCoverage;

    // Optional debug guides expose the exact streamlines used to bend SVG
    // motifs. They sit above the wash/contours but below guide shadows and
    // motifs, so enabling the button does not obscure the generated artwork.
    const vegetationFlowGuideAlpha =
      (vegetationOverlay?.flowGuideAlpha[i] ?? 0) / 255 * vegetationSiltClip;
    if (vegetationFlowGuideAlpha > 0) {
      const alpha = vegetationFlowGuideAlpha * 0.78;
      r = blendContourColor(r, vegetationFlowGuideColor[0], alpha);
      g = blendContourColor(g, vegetationFlowGuideColor[1], alpha);
      b = blendContourColor(b, vegetationFlowGuideColor[2], alpha);
    }

    // Grainy motif/guide shadows sit below the actual ink and are clipped to
    // the same dry-land mask. Their displacement follows the detail renderer's
    // sun, while the renderer breaks the footprint into printed specks.
    const vegetationShadowAlpha =
      (vegetationOverlay?.shadowAlpha[i] ?? 0) / 255 * vegetationSiltClip;
    if (vegetationShadowAlpha > 0) {
      const shadow = [
        Math.max(0, Math.round(vegetationInkColor[0] * 0.62)),
        Math.max(0, Math.round(vegetationInkColor[1] * 0.62)),
        Math.max(0, Math.round(vegetationInkColor[2] * 0.62)),
      ];
      r = blendContourColor(r, shadow[0], vegetationShadowAlpha);
      g = blendContourColor(g, shadow[1], vegetationShadowAlpha);
      b = blendContourColor(b, shadow[2], vegetationShadowAlpha);
    }

    // Vegetation is a standalone cartographic ink layer. It sits above the
    // pale flow wash and optional terrain contours, while final water outlines
    // are still composited last so shorelines remain authoritative.
    const vegetationAlpha = (vegetationOverlay?.alpha[i] ?? 0) / 255 * vegetationSiltClip;
    if (vegetationAlpha > 0) {
      r = blendContourColor(r, vegetationInkColor[0], vegetationAlpha);
      g = blendContourColor(g, vegetationInkColor[1], vegetationAlpha);
      b = blendContourColor(b, vegetationInkColor[2], vegetationAlpha);
    }

    // Water boundaries and coastal ink retain their configured styles; the
    // offshore ridge accents and foam use the ocean palette.
    if (waterOverlay) {
      // Ocean, river, lake, and wetland-water boundaries use Outline style.
      const outlineBankAlpha = showWaterDetails
        ? ((waterOverlay.outlineBankAlpha?.[i] ?? waterOverlay.bankAlpha[i]) / 255) *
          (1 - rasterPropCoverage)
        : 0;
      if (outlineBankAlpha > 0) {
        r = blendContourColor(r, waterOutlineColor[0], outlineBankAlpha);
        g = blendContourColor(g, waterOutlineColor[1], outlineBankAlpha);
        b = blendContourColor(b, waterOutlineColor[2], outlineBankAlpha);
      }

      // River flow and near-coast contour/ripple bands share charcoal.
      const charcoalFlowAlpha = showWaterDetails
        ? (waterOverlay.flowAlpha[i] / 255) * (1 - rasterPropCoverage)
        : 0;
      const oceanWaveAlpha = showWaterDetails
        ? ((waterOverlay.oceanFlowAlpha?.[i] ?? 0) / 255) * (1 - rasterPropCoverage)
        : 0;
      if (charcoalFlowAlpha > 0) {
        const flowTone = waterOverlay.flowTone[i] / 255;
        const tooth = 0.85 + 0.30 * hash01(i, 991);
        const finalAlpha = Math.min(1.0, charcoalFlowAlpha * tooth);
        r = blendContourColor(r, Math.min(255, Math.round(waterFlowColor[0] + flowTone * 18)), finalAlpha);
        g = blendContourColor(g, Math.min(255, Math.round(waterFlowColor[1] + flowTone * 16)), finalAlpha);
        b = blendContourColor(b, Math.min(255, Math.round(waterFlowColor[2] + flowTone * 14)), finalAlpha);
      }

      // Offshore ridge accents use a blue derived from the selected water
      // palette; broken charcoal strokes and foam follow the same paths.
      if (oceanWaveAlpha > 0) {
        const waveTone = (waterOverlay.oceanFlowTone?.[i] ?? 0) / 255;
        const tooth = 0.85 + 0.30 * hash01(i, 991);
        const finalAlpha = Math.min(1.0, oceanWaveAlpha * tooth);
        const waveColor = mixRGB(
          waterDeepColor,
          waterShallowColor,
          0.18 + waveTone * 0.28,
        );
        r = blendContourColor(r, Math.round(waveColor[0]), finalAlpha);
        g = blendContourColor(g, Math.round(waveColor[1]), finalAlpha);
        b = blendContourColor(b, Math.round(waveColor[2]), finalAlpha);
      }
      const oceanWaveInkAlpha = showWaterDetails
        ? ((waterOverlay.oceanWaveInkAlpha?.[i] ?? 0) / 255) *
          (1 - rasterPropCoverage) * OCEAN_WAVE_INK_OPACITY
        : 0;
      if (oceanWaveInkAlpha > 0) {
        const finalAlpha = Math.min(0.72, oceanWaveInkAlpha);
        r = blendContourColor(r, oceanWaveInkColor[0], finalAlpha);
        g = blendContourColor(g, oceanWaveInkColor[1], finalAlpha);
        b = blendContourColor(b, oceanWaveInkColor[2], finalAlpha);
      }
      const foamAlpha = showWaterDetails
        ? ((waterOverlay.crestAlpha?.[i] ?? 0) / 255) * (1 - rasterPropCoverage)
        : 0;
      if (foamAlpha > 0) {
        const foamColor = mixRGB(waterShallowColor, [246, 242, 224], 0.78);
        const finalAlpha = Math.min(0.9, foamAlpha);
        r = blendContourColor(r, Math.round(foamColor[0]), finalAlpha);
        g = blendContourColor(g, Math.round(foamColor[1]), finalAlpha);
        b = blendContourColor(b, Math.round(foamColor[2]), finalAlpha);
      }

      // Pool contours and river centrelines have already been merged into
      // flowAlpha, so every charcoal mark uses this exact compositor once.
    }

    // Raised mountain faces can occlude the map behind their crests. Foreground
    // vegetation props remain above the illustration, as in the other layers.
    let mountainIllustrationAlpha = 0;
    if (mountainIllustrationRGBA) {
      mountainIllustrationAlpha = mountainIllustrationRGBA[idx4 + 3] / 255;
      r = blendContourColor(r, mountainIllustrationRGBA[idx4], mountainIllustrationAlpha);
      g = blendContourColor(g, mountainIllustrationRGBA[idx4 + 1], mountainIllustrationAlpha);
      b = blendContourColor(b, mountainIllustrationRGBA[idx4 + 2], mountainIllustrationAlpha);
    }

    // Mountain faces sit above the vegetation wash. Reintroduce a restrained
    // portion of the noisy biome transition over those faces so the regional
    // color boundary remains legible without flattening their relief.
    if (
      mountainIllustrationAlpha > 0 &&
      vegetationTransitionWashRGB &&
      vegetationTransitionStrength
    ) {
      const transitionAlpha =
        (vegetationTransitionStrength[i] / 255) *
        mountainIllustrationAlpha * Math.min(1, 0.72 * vegetationBiomeTransitionStrength);
      if (transitionAlpha > 0) {
        const washOffset = i * 3;
        r = blendContourColor(r, vegetationTransitionWashRGB[washOffset], transitionAlpha);
        g = blendContourColor(g, vegetationTransitionWashRGB[washOffset + 1], transitionAlpha);
        b = blendContourColor(b, vegetationTransitionWashRGB[washOffset + 2], transitionAlpha);
      }
    }

    // This preview-only diagnostic colors the placement suitability score
    // beneath the actual trees, using the same terrain sampler as placement.
    const biomeId = dem.biomeType[i];
    if (
      layer === 'vegetation_patterns' &&
      options.vegetation?.showAlpineTreeSuitabilityOverlay &&
      (biomeId === 2 || biomeId === 3 || biomeId === 4) &&
      !hasWaterWash
    ) {
      const suitability = sampleAlpineForestTerrainSuitability(
        dem,
        i % width,
        Math.floor(i / width),
      ).habitatWeight;
      const [heatR, heatG, heatB] = sampleColorRamp(
        TREE_SUITABILITY_RAMP,
        suitability,
      );
      const heatAlpha = 0.76;
      r = blendContourColor(r, heatR, heatAlpha);
      g = blendContourColor(g, heatG, heatAlpha);
      b = blendContourColor(b, heatB, heatAlpha);
    }

    // Raster props are the topmost map-space prop layer. Their authored
    // watercolor/canvas pixels may cover the water wash and shoreline outline,
    // matching the intended prop-over-water order. Raster prop shadows are
    // currently disabled in the vegetation overlay.
    const rasterPropShadowAlpha =
      ((vegetationOverlay?.rasterPropShadowAlpha?.[i] ?? 0) / 255) *
      (options.vegetation?.motifShadowStrength ?? 0);
    if (rasterPropShadowAlpha > 0) {
      const shadow = [
        Math.max(0, Math.round(vegetationInkColor[0] * 0.62)),
        Math.max(0, Math.round(vegetationInkColor[1] * 0.62)),
        Math.max(0, Math.round(vegetationInkColor[2] * 0.62)),
      ];
      r = blendContourColor(r, shadow[0], rasterPropShadowAlpha);
      g = blendContourColor(g, shadow[1], rasterPropShadowAlpha);
      b = blendContourColor(b, shadow[2], rasterPropShadowAlpha);
    }

    const rasterPropPixelIndex = i * 4;
    const rasterPropAlpha =
      (vegetationOverlay?.rasterPropRGBA?.[rasterPropPixelIndex + 3] ?? 0) / 255;
    if (rasterPropAlpha > 0) {
      const rasterPropPixels = vegetationOverlay!.rasterPropRGBA!;
      // Forest stands are lit per tree already; only the rest is shaded.
      const standShare = (vegetationOverlay?.rasterPropStandShare?.[i] ?? 0) / 255;
      const propShade = 1 - (1 - (propTerrainShade?.[i] ?? 1)) * (1 - standShare);
      r = blendContourColor(
        r,
        rasterPropPixels[rasterPropPixelIndex] * propShade,
        rasterPropAlpha,
      );
      g = blendContourColor(
        g,
        rasterPropPixels[rasterPropPixelIndex + 1] * propShade,
        rasterPropAlpha,
      );
      b = blendContourColor(
        b,
        rasterPropPixels[rasterPropPixelIndex + 2] * propShade,
        rasterPropAlpha,
      );
    }

    // SVG mountain boulders use the same charcoal path renderer as the
    // vegetation linework, but remain in the topmost prop layer so a raised
    // mountain face cannot occlude their outline.
    const rasterPropCharcoalAlpha =
      (vegetationOverlay?.rasterPropCharcoalAlpha?.[i] ?? 0) / 255;
    if (rasterPropCharcoalAlpha > 0) {
      r = blendContourColor(r, propOutlineColor[0], rasterPropCharcoalAlpha);
      g = blendContourColor(g, propOutlineColor[1], rasterPropCharcoalAlpha);
      b = blendContourColor(b, propOutlineColor[2], rasterPropCharcoalAlpha);
    }

    pixels[idx4 + 0] = r;
    pixels[idx4 + 1] = g;
    pixels[idx4 + 2] = b;
    pixels[idx4 + 3] = 255;
  }

  compositionStop?.();

  if (cache) cache.stats.composites++;
  const image = typeof ImageData !== 'undefined'
    ? new ImageData(pixels, width, height)
    : { width, height, data: pixels } as unknown as ImageData;
  const foregroundPropsRGBA = options.fullTerrainCameraElevationDeg !== undefined
    ? createForegroundPropRGBA(vegetationOverlay, width, height, propOutlineColor, propTerrainShade)
    : undefined;
  if (foregroundPropsRGBA) {
    (image as MountainDetailImageData).foregroundPropsRGBA = foregroundPropsRGBA;
  }
  if (options.fullTerrainCameraElevationDeg === undefined || options.deferFullTerrainCamera) {
    detailStop?.();
    return image as MountainDetailImageData;
  }

  const foregroundSource: FullTerrainCameraTextureSource | undefined = foregroundPropsRGBA
    ? {
        width,
        height,
        sampleRGBA(x, y, output, offset): void {
          const clampedX = Math.max(0, Math.min(width - 1, x));
          const clampedY = Math.max(0, Math.min(height - 1, y));
          const x0 = Math.floor(clampedX);
          const y0 = Math.floor(clampedY);
          const x1 = Math.min(width - 1, x0 + 1);
          const y1 = Math.min(height - 1, y0 + 1);
          const tx = clampedX - x0;
          const ty = clampedY - y0;
          const topLeft = (y0 * width + x0) * 4;
          const topRight = (y0 * width + x1) * 4;
          const bottomLeft = (y1 * width + x0) * 4;
          const bottomRight = (y1 * width + x1) * 4;
          for (let channel = 0; channel < 4; channel++) {
            const top = foregroundPropsRGBA[topLeft + channel] * (1 - tx)
              + foregroundPropsRGBA[topRight + channel] * tx;
            const bottom = foregroundPropsRGBA[bottomLeft + channel] * (1 - tx)
              + foregroundPropsRGBA[bottomRight + channel] * tx;
            output[offset + channel] = Math.round(top * (1 - ty) + bottom * ty);
          }
        },
      }
    : undefined;

  const cameraImage = renderFullTerrainCamera(dem, image, {
    ridgePaths: mountainIllustration?.cameraRidgePaths,
    ridgeColor: options.mountainRidgeColor ?? options.vegetation?.inkColor,
    // Pattern path widths already contain the user's ridge thickness.
    ridgeThicknessScale: 0.75,
    charcoalRidges: true,
    cameraType: options.fullTerrainCameraType ?? 'orthographic',
    elevationDeg: options.fullTerrainCameraElevationDeg,
    fieldOfViewDeg: 35,
    heightExaggeration:
      (options.fullTerrainCameraHeightExaggeration ?? 1) *
      Math.max(0.25, options.verticalExaggeration ?? 1),
    // The stage resolves the same surface for cached and uncached renders;
    // raw DEM elevation remains the fallback for diagnostic layers.
    elevationField:
      mountainIllustration?.surfaceElevation ??
      cache?.mountainPattern?.surfaceElevation ??
      dem.elevation,
    background: FULL_TERRAIN_CAMERA_BACKGROUND,
    foregroundSource,
  });
  detailStop?.();
  return cameraImage as MountainDetailImageData;
}

/**
 * Places and draws vegetation: trees, shrubs, reeds and stands, using the motif registry.
 */
import { INSPECTOR_BOUNDS } from "../config/inspectorBounds";
import { SimplexNoise } from "../core/noise";
import { sampleCartographicGrain, sampleCartographicWashNoise, sampleCartographicPatchNoise,
  filterCartographicGradient as filterVegetationGradient,
  filterCartographicSignedGradient as filterVegetationSignedGradient } from './cartographicWash';
import type { MountainDEMData } from "../terrain/mountainBaseDEM";
import {
  PoissonGrid,
  buildDistanceField,
  charcoalStrokePressureFast,
  charcoalStrokePressureAt,
  clamp01,
  createCharcoalInterruptionPattern,
  createCharcoalStrokeRuns,
  findCharcoalStrokeRunAtDistance,
  getContourTangentAt,
  hash01,
  isCharcoalInkActiveAtDistance,
  paintInkSegment,
  paintInkSegmentsBatched,
  sampleScalarField,
  type BatchedInkSegment,
  type CharcoalStrokeRun,
} from "./cartographicStrokeRenderer";
import { VEGETATION_MOTIF_DEFINITIONS } from "./vegetationMotifs";
import { parseHexColor } from "./propColorVariation";

import {
  DEFAULT_FOREST_RENDER_SETTINGS,
  FOREST_REFERENCE_LONG_EDGE,
  forestRenderSettingsSignature,
  renderForestCanvasLayer,
  type ForestRenderSettings,
} from "./forestCanvasRenderer";
import type { MountainProfiler } from "./mountainProfiler";
import {
  boxBlur as standBoxBlur,
  buildForestStandGeometry,
  mapForestStandGeometry,
  sample as sampleStandField,
  SHRUB_STAND_PROFILE,
  TREE_STAND_PROFILE,
  type ForestStandGeometry,
  type StandProfile,
} from "./forestStandGeometry";
import { renderForestStandLayer } from "./forestStandRenderer";

export type VegetationMotifFamily = "grass" | "reeds" | "shrub" | "universal";
export type VegetationPatternPreset = "adaptive" | VegetationMotifFamily;

export interface VegetationMotifAsset {
  key: string;
  family: VegetationMotifFamily;
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Vector source paths used by flow-following motifs. */
  vectorPaths?: readonly VegetationMotifVectorPath[];
}

/** Metadata for a raster prop whose size is authored in map grid cells. */
export interface VegetationRasterPropAsset extends VegetationMotifAsset {
  kind: "raster-prop";
  /** Placement pipeline used by the shared raster-prop compositor. */
  placementRole?: "vegetation" | "mountain-foothill" | "wetland";
  /** Visible canopy envelope, independent from the conservative grid footprint. */
  renderWidthCells?: number;
  renderHeightCells?: number;
  /** Visual anchor in the render envelope; (0.5, 1) means bottom-center. */
  renderAnchorX?: number;
  renderAnchorY?: number;
  /** Optional per-prop alpha-dilation outline for transparent forest props. */
  outlineMode?: "none" | "alpha-dilation";
  /** Identifies the visual treatment family; dilation remains per placement. */
  outlineGroup?: string;
  /** Which filled vector silhouette the forest canvas should treat as canopy. */
  forestCanopyPathIndex?: number;
  /** Paint closed vector fills using their authored SVG colors. */
  paintVectorFills?: boolean;
  footprintWidthCells: number;
  footprintHeightCells: number;
  heightCells: number;
  anchorX: number;
  anchorY: number;
  eligibleBiomeIds: readonly number[];
}

export interface VegetationRasterPropPlacement {
  x: number;
  y: number;
  rotation: number;
  cellSize: number;
  opacity: number;
  biomeId: number;
  assetKey: string;
}

export interface VegetationMotifVectorPath {
  points: readonly VegetationStrokePoint[];
  strokeWidth: number;
  /** True when the source path explicitly closes back to its start point. */
  closed?: boolean;
  /** Fill used by enclosed source regions, expressed as RGB. */
  fillColor?: readonly [number, number, number];
}

export interface VegetationStrokePoint {
  x: number;
  y: number;
}

/**
 * Cache identity for an SVG motif. Dimensions alone are not sufficient: two
 * different SVG paths can share the same viewBox, and reusing the old alpha
 * would make a changed motif keep its previous silhouette.
 */
export function vegetationMotifAssetSignature(
  assets: readonly VegetationMotifAsset[] | undefined,
): string {
  return (assets ?? [])
    .map((asset) => {
      const vectorSignature = asset.vectorPaths
        ?.map(
          (path) =>
            `${path.strokeWidth}:${path.points
              .map((point) => `${point.x},${point.y}`)
              .join(";")}:${path.closed ? "closed" : "open"}:${path.fillColor?.join(",") ?? ""}`,
        )
        .join("|");
      const rasterAsset = asset as Partial<VegetationRasterPropAsset>;
      const raster = rasterAsset.kind === "raster-prop"
        ? `:${rasterAsset.placementRole ?? "vegetation"}:${rasterAsset.footprintWidthCells}x${rasterAsset.footprintHeightCells}:${rasterAsset.heightCells}:${rasterAsset.anchorX},${rasterAsset.anchorY}:${rasterAsset.renderWidthCells ?? ""}x${rasterAsset.renderHeightCells ?? ""}:${rasterAsset.renderAnchorX ?? ""},${rasterAsset.renderAnchorY ?? ""}:${rasterAsset.outlineMode ?? "none"}:${rasterAsset.outlineGroup ?? ""}:${rasterAsset.forestCanopyPathIndex ?? ""}:${rasterAsset.paintVectorFills ?? false}:${rasterAsset.eligibleBiomeIds?.join(",") ?? ""}`
        : "";
      return `${asset.key}:${asset.width}x${asset.height}:${vectorSignature ?? ""}${raster}`;
    })
    .join("|");
}

export function vegetationRasterPropAssetSignature(
  assets: readonly VegetationRasterPropAsset[] | undefined,
): string {
  return (assets ?? [])
    .map(
      (asset) => {
        const vectorSignature = asset.vectorPaths
          ?.map(
            (path) =>
            `${path.strokeWidth}:${path.points
                .map((point) => `${point.x},${point.y}`)
                .join(";")}:${path.closed ? "closed" : "open"}:${path.fillColor?.join(",") ?? ""}`,
          )
          .join("|");
        return `${asset.key}:${asset.width}x${asset.height}:${asset.placementRole ?? "vegetation"}:${asset.footprintWidthCells}x${asset.footprintHeightCells}:${asset.heightCells}:${asset.anchorX},${asset.anchorY}:${asset.renderWidthCells ?? ""}x${asset.renderHeightCells ?? ""}:${asset.renderAnchorX ?? ""},${asset.renderAnchorY ?? ""}:${asset.outlineMode ?? "none"}:${asset.outlineGroup ?? ""}:${asset.forestCanopyPathIndex ?? ""}:${asset.paintVectorFills ?? false}:${asset.eligibleBiomeIds.join(",")}:${vectorSignature ?? ""}`;
      },
    )
    .join("|");
}

export interface VegetationStrokePath {
  key: number;
  biomeId: number;
  width: number;
  dashPhase: number;
  points: VegetationStrokePoint[];
}

export interface VegetationMotifPlacement {
  x: number;
  y: number;
  rotation: number;
  size: number;
  opacity: number;
  biomeId: number;
  assetKey: string;
  /** Parent streamline used to bend the SVG instead of applying one rotation. */
  pathKey?: number;
  /** Normalized arc-length position on the parent streamline. */
  pathT?: number;
}

export interface VegetationGeometry {
  width: number;
  height: number;
  /** Shared two-pixel procedural field used by the broad wash and overlays. */
  flowCache?: VegetationFlowCache;
  paths: VegetationStrokePath[];
  motifs: VegetationMotifPlacement[];
  /** Generic raster props with explicit grid-cell footprints. */
  rasterProps?: VegetationRasterPropPlacement[];
  /** Stand groups (alpine forest, wetland shrubs) drawn as hand-drawn stands instead of per-prop art. */
  stands?: VegetationPropStand[];
}

export interface VegetationPropStand {
  /** Id of the stand group the geometry was built for. */
  group: string;
  geometry: ForestStandGeometry;
}

/**
 * The raster prop placement pass only needs categorical habitat and water
 * masks. Keeping this shape separate avoids fabricating the many unrelated
 * DEM fields when a caller is interested in prop coordinates alone.
 */
export type VegetationPlacementTerrain = Pick<
  MountainDEMData,
  "width" | "height" | "biomeType"
> & Partial<Pick<
  MountainDEMData,
  | "elevation"
  | "slopeDeg"
  | "dxMeters"
  | "dyMeters"
  | "precipitationMmYr"
  | "runoffDepthMmYr"
  | "isOcean"
  | "isRiverChannel"
  | "visualWaterMask"
  | "visualWaterCoverage"
  | "wetlandPoolMask"
  | "wetlandPoolCoverage"
>>;

export type RasterPropBiomeSettings = Partial<Record<number, {
  density?: number;
  clustering?: number;
}>>;

export function rasterPropSettingsForBiome(options: {
  rasterPropDensity?: number;
  rasterPropClustering?: number;
  rasterPropBiomeSettings?: RasterPropBiomeSettings;
} | undefined, biomeId: number) {
  const override = options?.rasterPropBiomeSettings?.[biomeId];
  return {
    density: Math.max(0, Math.min(INSPECTOR_BOUNDS.propDensity, override?.density ?? options?.rasterPropDensity ?? 0.42)),
    clustering: clamp01(override?.clustering ?? options?.rasterPropClustering ?? 0.65),
  };
}

export interface VegetationPatternOptions {
  preset?: VegetationPatternPreset;
  seed?: number;
  density?: number;
  patternScale?: number;
  swirlStrength?: number;
  terrainFollowing?: number;
  strokeLength?: number;
  strokeThickness?: number;
  strokeOpacity?: number;
  /** Density multiplier for terrain-following mountain side creases. */
  mountainSideRidgeDensity?: number;
  /** Thickness multiplier for the connected mountain crest outline. */
  mountainMainRidgeThickness?: number;
  /** Probability of seeded charcoal-style dry-ink skips. */
  drySkipProbability?: number;
  /** Probability that each water-sized flow mark introduces a real line gap. */
  lineInterruptionProbability?: number;
  motifDensity?: number;
  motifSize?: number;
  /** Density of the wetland shrubs that make up the wetland shrub stands. */
  wetlandShrubDensity?: number;
  /** 0 favours damp margins; 1 favours the driest wetland patches. */
  wetlandImagePropDrynessBias?: number;
  /** Generic grid-authored raster props, including biome-aware trees. */
  rasterPropAssets?: readonly VegetationRasterPropAsset[];
  /** Density of generic grid-authored raster props. */
  rasterPropDensity?: number;
  /** Density of terrain-led mountain foothill boulders. */
  mountainBoulderDensity?: number;
  /** Scale multiplier for mountain foothill boulder footprints. */
  mountainBoulderSize?: number;
  rasterPropBiomeSettings?: RasterPropBiomeSettings;
  /** Map pixels represented by one authored vegetation grid cell. */
  rasterPropCellSize?: number;
  /** Normalized forest prop size authored against the live preview map. */
  rasterPropScale?: number;
  /** 0 keeps props broadly distributed; 1 concentrates them into tight stands. */
  rasterPropClustering?: number;
  /** 0 keeps stands compact; 1 grows broad, populous vegetation stands. */
  rasterPropStandSize?: number;
  /** Spatial scale of the seeded forest clearing/placement noise. */
  rasterPropPlacementNoiseScale?: number;
  /** Canvas forest appearance. Placement density remains governed by the raster-prop biome controls. */
  forestSettings?: Partial<ForestRenderSettings>;
  /** Scale forest ink, shadows, and texture marks with mapped export geometry. */
  forestRenderScale?: number;
  inkColor?: string;
  /** Subtle tonal lift around curl-field centres. */
  flowWashStrength?: number;
  /** Strength of the darker outer flow-wash colour stop. */
  flowWashDarkStrength?: number;
  /** Strength of the lighter centre flow-wash colour stop. */
  flowWashLightStrength?: number;
  /** Broad warm/cool variation in the vegetation wash. */
  flowWashNoiseStrength?: number;
  /** Spatial scale of the broad warm/cool variation. */
  flowWashNoiseScale?: number;
  /** Minimum water distance at which wetland dry patches may appear. */
  wetlandDryDistanceStart?: number;
  /** Water distance at which wetland dry patches use their full frequency. */
  wetlandDryDistanceEnd?: number;
  /** Spatial scale of wetland dry-patch noise. */
  wetlandDryNoiseScale?: number;
  /** Contrast of the wetland dry-patch classification. */
  wetlandDryNoiseStrength?: number;
  /** Draw generated streamlines as a debug overlay in the detail studio. */
  showFlowGuides?: boolean;
  /** Show the visible-water dryness field used by wetland image-prop placement. */
  showWetlandDrynessOverlay?: boolean;
  /** Show the terrain suitability field used by alpine forest prop placement. */
  showAlpineTreeSuitabilityOverlay?: boolean;
  /** Global visible-water distance field supplied by tiled exports. */
  waterDistanceOverride?: Float32Array;
  /** Directional grain-shadow strength for the final motif/line alpha. */
  motifShadowStrength?: number;
  /** Shadow displacement in source-map pixels before export scaling. */
  motifShadowDistance?: number;
  /** Grain spread around the displaced motif in source-map pixels. */
  motifShadowSoftness?: number;
  /** Strength of the shadow cast by bright flow-wash regions. */
  washShadowStrength?: number;
  /** Down-sun displacement of the flow-wash shadow in source-map pixels. */
  washShadowDistance?: number;
  /** Extra separation between the neutral wash and its shadow receiver. */
  washShadowGap?: number;
  /** Amount of shared grain modulation applied to the flow-wash shadow. */
  washShadowGrain?: number;
  motifAssets?: readonly VegetationMotifAsset[];
  /** Internal global pixel domain used by deterministic tiled rasterization. */
  coordinateOffsetX?: number;
  coordinateOffsetY?: number;
  coordinateStride?: number;
  coordinateHeight?: number;
  coordinateSourceWidth?: number;
  coordinateSourceHeight?: number;
  /** Unscaled pattern control used for world-space flow fields in exports. */
  coordinatePatternScale?: number;
}

export interface ResolvedVegetationPatternOptions {
  preset: VegetationPatternPreset;
  seed: number;
  density: number;
  patternScale: number;
  swirlStrength: number;
  terrainFollowing: number;
  strokeLength: number;
  strokeThickness: number;
  strokeOpacity: number;
  mountainSideRidgeDensity: number;
  mountainMainRidgeThickness: number;
  drySkipProbability: number;
  lineInterruptionProbability: number;
  motifDensity: number;
  motifSize: number;
  wetlandShrubDensity: number;
  wetlandImagePropDrynessBias: number;
  rasterPropAssets: readonly VegetationRasterPropAsset[];
  rasterPropDensity: number;
  mountainBoulderDensity: number;
  mountainBoulderSize: number;
  rasterPropBiomeSettings: RasterPropBiomeSettings;
  rasterPropCellSize: number;
  rasterPropScale?: number;
  rasterPropClustering: number;
  rasterPropStandSize: number;
  rasterPropPlacementNoiseScale: number;
  forestSettings: ForestRenderSettings;
  forestRenderScale: number;
  inkColor: string;
  flowWashStrength: number;
  flowWashNoiseStrength: number;
  flowWashNoiseScale: number;
  wetlandDryDistanceStart: number;
  wetlandDryDistanceEnd: number;
  wetlandDryNoiseScale: number;
  wetlandDryNoiseStrength: number;
  showFlowGuides: boolean;
  showWetlandDrynessOverlay: boolean;
  showAlpineTreeSuitabilityOverlay: boolean;
  waterDistanceOverride?: Float32Array;
  motifShadowStrength: number;
  motifShadowDistance: number;
  motifShadowSoftness: number;
  washShadowStrength: number;
  washShadowDistance: number;
  washShadowGap: number;
  washShadowGrain: number;
  motifAssets: readonly VegetationMotifAsset[];
  coordinateOffsetX: number;
  coordinateOffsetY: number;
  coordinateStride: number;
  coordinateHeight: number;
  coordinateSourceWidth: number;
  coordinateSourceHeight: number;
  coordinatePatternScale: number;
}

export interface VegetationOverlay {
  width: number;
  height: number;
  alpha: Uint8Array;
  /** Smooth 0..1 flow-centre tone used beneath the ink layer. */
  backgroundTone: Float32Array;
  /** Signed warm/cool wash variation with shared integrated texture grain. */
  backgroundNoise: Float32Array;
  /** 0..1 mottled dry classification for wetland biome pixels. */
  backgroundDryness: Float32Array;
  /** 0..1 visible-water distance gradient for wetland biome pixels. */
  wetlandDryness: Float32Array;
  /** Current distance-based shrub habitat fit before colony/footprint checks. */
  wetlandImagePropHabitat: Float32Array;
  /** Directional shadow cast by bright flow-wash regions. */
  washShadowAlpha: Uint8Array;
  /** Directionally displaced, grain-modulated motif/guide shadow alpha. */
  shadowAlpha: Uint8Array;
  /** Optional visible debug overlay for the generated vegetation streamlines. */
  flowGuideAlpha: Uint8Array;
  /** RGBA pixels for generic raster props, composited as the topmost prop layer. */
  rasterPropRGBA: Uint8ClampedArray;
  /** Charcoal alpha for vector props that share the topmost prop layer. */
  rasterPropCharcoalAlpha: Uint8Array;
  /** Reserved shadow coverage buffer for generic raster props. */
  rasterPropShadowAlpha: Uint8Array;
  /**
   * Share (0..255) of each raster prop pixel that comes from forest stands.
   * Stands are already lit per tree, so the map's per-pixel terrain shade
   * skips this share.
   */
  rasterPropStandShare?: Uint8Array;
}

/**
 * Reusable buffers for the vegetation overlay pipeline.
 *
 * The interactive preview changes presentation controls much more often than
 * it changes the DEM or the flow pattern. Keep the expensive pixel fields
 * (flow wash and directional shadows) separate from the cheap compositor so
 * a stroke/guide/shadow adjustment does not evaluate every simplex sample
 * again. The owning mountain render cache controls the lifetime of this
 * object; one-shot callers simply omit it.
 */
export interface VegetationOverlayStageCache {
  clipKey?: string;
  clip?: Uint8Array;
  inkKey?: string;
  alpha?: Uint8Array;
  backgroundKey?: string;
  backgroundWaterDistance?: Float32Array;
  background?: {
    tone: Float32Array;
    noise: Float32Array;
    dryness: Float32Array;
    /** Continuous 0..1 visible-water distance gradient. */
    wetlandDryness: Float32Array;
    /** Current distance-based shrub habitat fit before colony/footprint checks. */
    wetlandImagePropHabitat: Float32Array;
  };
  washShadowCoverageKey?: string;
  washShadowCoverage?: Float32Array;
  washShadowKey?: string;
  washShadowAlpha?: Uint8Array;
  shadowCoverageKey?: string;
  shadowCoverage?: Float32Array;
  shadowKey?: string;
  shadowAlpha?: Uint8Array;
  guideKey?: string;
  flowGuideAlpha?: Uint8Array;
  rasterPropKey?: string;
  rasterPropRGBA?: Uint8ClampedArray;
  rasterPropCharcoalAlpha?: Uint8Array;
  rasterPropShadowAlpha?: Uint8Array;
  rasterPropStandShare?: Uint8Array;
}

const BIOME_SUITABILITY: Readonly<Record<number, number>> = {
  2: 0.65,
  4: 0.7,
  5: 0.8,
  7: 1,
};

type VegetationMotifPercentages = Readonly<
  Record<VegetationMotifFamily, number>
>;

/**
 * Percentage chance for each motif family when the adaptive preset is active.
 *
 * Keep each biome's values at a total of 100. Values are normalized if they
 * do not total 100, so temporarily editing one value remains safe.
 *
 * Mountain biome IDs:
 * 2 = Alpine Tundra & Meadow
 * 4 = Montane Broadleaf Woodland
 * 5 = Riparian Canyon & Shrubland
 * 7 = Valley Floodplain & Wetland
 */
export const BIOME_MOTIF_PERCENTAGES: Readonly<
  Record<number, VegetationMotifPercentages>
> = {
  2: { grass: 67, reeds: 0, shrub: 11, universal: 22 },
  4: { grass: 30, reeds: 0, shrub: 48, universal: 22 },
  5: { grass: 25, reeds: 0, shrub: 53, universal: 22 },
  7: { grass: 0, reeds: 0, shrub: 80, universal: 20 },
};

export function resolveVegetationPatternOptions(
  options: VegetationPatternOptions | undefined,
): ResolvedVegetationPatternOptions {
  return {
    preset: options?.preset ?? "adaptive",
    seed: Math.round(options?.seed ?? 23817),
    density: Math.max(0, Math.min(INSPECTOR_BOUNDS.groundDensity, options?.density ?? 1)),
    patternScale: Math.max(0.5, Math.min(INSPECTOR_BOUNDS.patternScale, options?.patternScale ?? 1)),
    swirlStrength: clamp01(options?.swirlStrength ?? 0.65),
    terrainFollowing: clamp01(options?.terrainFollowing ?? 0.35),
    strokeLength: Math.max(0.4, Math.min(INSPECTOR_BOUNDS.strokeLength, options?.strokeLength ?? 1)),
    strokeThickness: Math.max(0.1, Math.min(3, options?.strokeThickness ?? 1)),
    strokeOpacity: clamp01(options?.strokeOpacity ?? 0.72),
    mountainSideRidgeDensity: Math.max(
      0,
      Math.min(2, options?.mountainSideRidgeDensity ?? 1),
    ),
    mountainMainRidgeThickness: Math.max(
      0.25,
      Math.min(2, options?.mountainMainRidgeThickness ?? 0.75),
    ),
    drySkipProbability: clamp01(options?.drySkipProbability ?? 0.05),
    lineInterruptionProbability: clamp01(
      options?.lineInterruptionProbability ?? 0.3,
    ),
    motifDensity: Math.max(0, Math.min(1.5, options?.motifDensity ?? 0.8)),
    motifSize: Math.max(0.1, Math.min(5, options?.motifSize ?? 1)),
    wetlandShrubDensity: Math.max(0, Math.min(INSPECTOR_BOUNDS.propDensity, options?.wetlandShrubDensity ?? 0.55)),
    wetlandImagePropDrynessBias: clamp01(
      options?.wetlandImagePropDrynessBias ?? 0.65,
    ),
    rasterPropAssets: options?.rasterPropAssets ?? [],
    rasterPropBiomeSettings: options?.rasterPropBiomeSettings ?? {},
    rasterPropDensity: Math.max(
      0,
      Math.min(INSPECTOR_BOUNDS.propDensity, options?.rasterPropDensity ?? 0.42),
    ),
    mountainBoulderDensity: Math.max(
      0,
      Math.min(
        2,
        options?.mountainBoulderDensity ??
          options?.rasterPropDensity ??
          0.42,
      ),
    ),
    mountainBoulderSize: Math.max(
      0.5,
      Math.min(2, options?.mountainBoulderSize ?? 1),
    ),
    rasterPropCellSize: Math.max(
      4,
      Math.min(256, options?.rasterPropCellSize ?? 16),
    ),
    rasterPropScale:
      options?.rasterPropScale === undefined
        ? undefined
        : Math.max(INSPECTOR_BOUNDS.propScaleMin, Math.min(4, options.rasterPropScale)),
    rasterPropClustering: clamp01(options?.rasterPropClustering ?? 0.65),
    rasterPropStandSize: clamp01(options?.rasterPropStandSize ?? 0.5),
    rasterPropPlacementNoiseScale: Math.max(
      0.25,
      Math.min(4, options?.rasterPropPlacementNoiseScale ?? 1),
    ),
    forestSettings: { ...DEFAULT_FOREST_RENDER_SETTINGS, ...options?.forestSettings },
    forestRenderScale: Math.max(0.25, Math.min(128, options?.forestRenderScale ?? 1)),
    inkColor: options?.inkColor ?? "#2f4a2d",
    flowWashStrength: clamp01(options?.flowWashStrength ?? 0.24),
    flowWashNoiseStrength: clamp01(options?.flowWashNoiseStrength ?? 0.45),
    flowWashNoiseScale: Math.max(
      0.5,
      Math.min(INSPECTOR_BOUNDS.washNoiseScale, options?.flowWashNoiseScale ?? 1),
    ),
    wetlandDryDistanceStart: Math.max(
      0,
      Math.min(100, options?.wetlandDryDistanceStart ?? 8),
    ),
    wetlandDryDistanceEnd: Math.max(
      1,
      Math.min(INSPECTOR_BOUNDS.wetlandDryEnd, options?.wetlandDryDistanceEnd ?? 32),
    ),
    wetlandDryNoiseScale: Math.max(
      0.5,
      Math.min(3, options?.wetlandDryNoiseScale ?? 1.4),
    ),
    wetlandDryNoiseStrength: clamp01(options?.wetlandDryNoiseStrength ?? 0.9),
    showFlowGuides: options?.showFlowGuides ?? false,
    showWetlandDrynessOverlay: options?.showWetlandDrynessOverlay ?? false,
    showAlpineTreeSuitabilityOverlay:
      options?.showAlpineTreeSuitabilityOverlay ?? false,
    waterDistanceOverride: options?.waterDistanceOverride,
    motifShadowStrength: clamp01(options?.motifShadowStrength ?? 0.2),
    motifShadowDistance: Math.max(
      0,
      Math.min(8, options?.motifShadowDistance ?? 2.2),
    ),
    motifShadowSoftness: Math.max(
      0,
      Math.min(INSPECTOR_BOUNDS.markShadowSoftness, options?.motifShadowSoftness ?? 1.1),
    ),
    washShadowStrength: clamp01(options?.washShadowStrength ?? 0.2),
    washShadowDistance: Math.max(
      0,
      Math.min(INSPECTOR_BOUNDS.washShadowOffset, options?.washShadowDistance ?? 2.2),
    ),
    washShadowGap: Math.max(0, Math.min(INSPECTOR_BOUNDS.washShadowGap, options?.washShadowGap ?? 1)),
    washShadowGrain: clamp01(options?.washShadowGrain ?? 1),
    motifAssets: options?.motifAssets ?? [],
    coordinateOffsetX: Math.round(options?.coordinateOffsetX ?? 0),
    coordinateOffsetY: Math.round(options?.coordinateOffsetY ?? 0),
    coordinateStride: Math.max(1, Math.round(options?.coordinateStride ?? 1)),
    coordinateHeight: Math.max(1, Math.round(options?.coordinateHeight ?? 1)),
    coordinateSourceWidth: Math.max(
      1,
      Math.round(options?.coordinateSourceWidth ?? 1),
    ),
    coordinateSourceHeight: Math.max(
      1,
      Math.round(options?.coordinateSourceHeight ?? 1),
    ),
    coordinatePatternScale: Math.max(
      0.5,
      Math.min(
        2,
        options?.coordinatePatternScale ?? options?.patternScale ?? 1,
      ),
    ),
  };
}

function biomeAt(dem: VegetationPlacementTerrain, x: number, y: number): number {
  const ix = Math.max(0, Math.min(dem.width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(dem.height - 1, Math.round(y)));
  return dem.biomeType[iy * dem.width + ix];
}

function isWaterAt(dem: VegetationPlacementTerrain, x: number, y: number): boolean {
  const ix = Math.max(0, Math.min(dem.width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(dem.height - 1, Math.round(y)));
  const index = iy * dem.width + ix;
  return Boolean(
    dem.isOcean?.[index] === 1 ||
    dem.isRiverChannel?.[index] === 1 ||
    dem.visualWaterMask?.[index] === 1 ||
    (dem.visualWaterCoverage?.[index] ?? 0) > 0.1 ||
    dem.wetlandPoolMask?.[index] === 1 ||
    (dem.wetlandPoolCoverage?.[index] ?? 0) > 0.1,
  );
}

function slopeSuitability(biomeId: number, slopeDeg: number): number {
  const fadeStart = biomeId === 7 ? 4 : biomeId === 5 ? 16 : 18;
  const fadeEnd = biomeId === 7 ? 14 : biomeId === 5 ? 36 : 40;
  return 1 - clamp01((slopeDeg - fadeStart) / Math.max(1, fadeEnd - fadeStart));
}

function sampleVegetationSuitabilityDirect(
  dem: MountainDEMData,
  x: number,
  y: number,
  densityNoise: SimplexNoise,
  options: ResolvedVegetationPatternOptions,
): number {
  if (
    x < 1 ||
    y < 1 ||
    x >= dem.width - 1 ||
    y >= dem.height - 1 ||
    isWaterAt(dem, x, y)
  )
    return 0;
  const biomeId = biomeAt(dem, x, y);
  const biomeWeight = BIOME_SUITABILITY[biomeId] ?? 0;
  if (biomeWeight <= 0) return 0;
  const slope = sampleScalarField(dem.slopeDeg, dem.width, dem.height, x, y);
  const slopeWeight = slopeSuitability(biomeId, slope);
  if (slopeWeight <= 0) return 0;

  const minDomainKm = Math.max(
    1,
    Math.min(dem.domainWidthKm, dem.domainHeightKm),
  );
  const worldX = (x / Math.max(1, dem.width - 1)) * dem.domainWidthKm;
  const worldY = (y / Math.max(1, dem.height - 1)) * dem.domainHeightKm;
  const macroScaleKm =
    Math.max(0.8, minDomainKm * 0.085) / options.patternScale;
  const warp = densityNoise.domainWarp(
    worldX / macroScaleKm,
    worldY / macroScaleKm,
    0.48,
  );
  const macro = clamp01(
    0.5 + densityNoise.fbm(warp.x, warp.y, 4, 2.03, 0.52) * 0.5,
  );
  const concentration = 0.3 + 0.7 * (macro * macro * (3 - 2 * macro));
  const precipitation = sampleScalarField(
    dem.precipitationMmYr,
    dem.width,
    dem.height,
    x,
    y,
  );
  const moisture = 0.78 + 0.22 * clamp01((precipitation - 350) / 1450);
  return clamp01(biomeWeight * slopeWeight * concentration * moisture);
}

/**
 * A two-pixel procedural grid is safe in homogeneous terrain, but categorical
 * biome and water masks must never be interpolated across their boundary. Keep
 * those boundary samples analytic so a streamline cannot step from eligible
 * wetland/grass into an excluded biome between cached grid points.
 */
function isNearVegetationMaterialBoundary(
  dem: MountainDEMData,
  x: number,
  y: number,
  radius = 2,
  boundary?: Uint8Array,
): boolean {
  const centreX = Math.max(0, Math.min(dem.width - 1, Math.round(x)));
  const centreY = Math.max(0, Math.min(dem.height - 1, Math.round(y)));
  if (boundary) return boundary[centreY * dem.width + centreX] !== 0;
  if (isWaterAt(dem, x, y)) return true;
  const centreBiome = dem.biomeType[centreY * dem.width + centreX];
  const minX = Math.max(0, centreX - radius);
  const maxX = Math.min(dem.width - 1, centreX + radius);
  const minY = Math.max(0, centreY - radius);
  const maxY = Math.min(dem.height - 1, centreY + radius);
  for (let sampleY = minY; sampleY <= maxY; sampleY++) {
    for (let sampleX = minX; sampleX <= maxX; sampleX++) {
      const index = sampleY * dem.width + sampleX;
      if (dem.biomeType[index] !== centreBiome || isWaterAt(dem, sampleX, sampleY)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build the categorical fallback region once instead of scanning a 5x5
 * neighbourhood for every suitability and direction sample. A cell is a
 * boundary when its material changes across a four-neighbour edge; two
 * separable dilations reproduce the old Chebyshev-radius-two guard.
 */
function buildVegetationMaterialBoundary(dem: MountainDEMData): Uint8Array {
  const { width, height } = dem;
  const total = width * height;
  const edge = new Uint8Array(total);
  const waterAtIndex = (index: number): boolean => Boolean(
    dem.isOcean?.[index] === 1 ||
    dem.isRiverChannel?.[index] === 1 ||
    dem.visualWaterMask?.[index] === 1 ||
    (dem.visualWaterCoverage?.[index] ?? 0) > 0.1 ||
    dem.wetlandPoolMask?.[index] === 1 ||
    (dem.wetlandPoolCoverage?.[index] ?? 0) > 0.1,
  );
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const index = row + x;
      const water = waterAtIndex(index);
      const biome = dem.biomeType[index];
      let changed = water;
      if (!changed && x > 0) {
        const neighbour = index - 1;
        changed = waterAtIndex(neighbour) || dem.biomeType[neighbour] !== biome;
      }
      if (!changed && x + 1 < width) {
        const neighbour = index + 1;
        changed = waterAtIndex(neighbour) || dem.biomeType[neighbour] !== biome;
      }
      if (!changed && y > 0) {
        const neighbour = index - width;
        changed = waterAtIndex(neighbour) || dem.biomeType[neighbour] !== biome;
      }
      if (!changed && y + 1 < height) {
        const neighbour = index + width;
        changed = waterAtIndex(neighbour) || dem.biomeType[neighbour] !== biome;
      }
      edge[index] = changed ? 1 : 0;
    }
  }

  const horizontal = new Uint8Array(total);
  const radius = 2;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x < width; x++) {
      count += edge[row + x];
      if (x > radius) count -= edge[row + x - radius - 1];
      horizontal[row + x] = count > 0 ? 1 : 0;
    }
  }
  const boundary = new Uint8Array(total);
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < height; y++) {
      const index = y * width + x;
      count += horizontal[index];
      if (y > radius) count -= horizontal[(y - radius - 1) * width + x];
      boundary[index] = count > 0 ? 1 : 0;
    }
  }
  return boundary;
}

type VegetationCachedFieldPopulate = (
  gridX: number,
  gridY: number,
  index: number,
) => number;

function ensureCachedVegetationFieldValue(
  cache: VegetationFlowCache,
  values: Float32Array,
  ready: Uint8Array,
  gx: number,
  gy: number,
  populate: VegetationCachedFieldPopulate,
): number {
  const index = gy * cache.width + gx;
  if (ready[index] === 0) {
    values[index] = populate(
      Math.max(0, Math.min(cache.sourceWidth - 1,
        (cache.gridOriginX + gx) * cache.stride - cache.originX)),
      Math.max(0, Math.min(cache.sourceHeight - 1,
        (cache.gridOriginY + gy) * cache.stride - cache.originY)),
      index,
    );
    ready[index] = 1;
  }
  return values[index];
}

function sampleCachedVegetationField(
  cache: VegetationFlowCache,
  values: Float32Array,
  ready: Uint8Array,
  x: number,
  y: number,
  populate: VegetationCachedFieldPopulate,
  lookup?: VegetationCachedFieldLookup,
): number {
  if (
    lookup &&
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    x < lookup.x0.length &&
    y >= 0 &&
    y < lookup.y0.length
  ) {
    const x0 = lookup.x0[x];
    const x1 = lookup.x1[x];
    const y0 = lookup.y0[y];
    const y1 = lookup.y1[y];
    const tx = lookup.tx[x];
    const ty = lookup.ty[y];
    const top = ensureCachedVegetationFieldValue(cache, values, ready, x0, y0, populate) * (1 - tx)
      + ensureCachedVegetationFieldValue(cache, values, ready, x1, y0, populate) * tx;
    const bottom = ensureCachedVegetationFieldValue(cache, values, ready, x0, y1, populate) * (1 - tx)
      + ensureCachedVegetationFieldValue(cache, values, ready, x1, y1, populate) * tx;
    return top * (1 - ty) + bottom * ty;
  }
  const maxX = cache.width - 1;
  const maxY = cache.height - 1;
  const worldGridX = (x + cache.originX) / cache.stride;
  const worldGridY = (y + cache.originY) / cache.stride;
  const gridX = Math.max(0, Math.min(maxX, worldGridX - cache.gridOriginX));
  const gridY = Math.max(0, Math.min(maxY, worldGridY - cache.gridOriginY));
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const x1 = Math.min(maxX, x0 + 1);
  const y1 = Math.min(maxY, y0 + 1);
  const tx = gridX - x0;
  const ty = gridY - y0;
  const top = ensureCachedVegetationFieldValue(cache, values, ready, x0, y0, populate) * (1 - tx)
    + ensureCachedVegetationFieldValue(cache, values, ready, x1, y0, populate) * tx;
  const bottom = ensureCachedVegetationFieldValue(cache, values, ready, x0, y1, populate) * (1 - tx)
    + ensureCachedVegetationFieldValue(cache, values, ready, x1, y1, populate) * tx;
  return top * (1 - ty) + bottom * ty;
}

export function sampleVegetationSuitabilityAt(
  dem: MountainDEMData,
  x: number,
  y: number,
  densityNoise: SimplexNoise,
  options: ResolvedVegetationPatternOptions,
  sampling?: VegetationFlowSampling,
): number {
  const cache = sampling?.flowCache;
  if (!cache) {
    return sampleVegetationSuitabilityDirect(dem, x, y, densityNoise, options);
  }
  if (isNearVegetationMaterialBoundary(dem, x, y, 2, sampling?.materialBoundary)) {
    return sampleVegetationSuitabilityDirect(dem, x, y, densityNoise, options);
  }
  const cached = sampleCachedVegetationField(
    cache,
    cache.suitability,
    cache.suitabilityReady,
    x,
    y,
    sampling.suitabilityPopulate ?? ((gridX, gridY) => sampleVegetationSuitabilityDirect(
      dem,
      gridX,
      gridY,
      densityNoise,
      options,
    )),
    sampling.cachedFieldLookup,
  );
  // Streamline seeds stop at a narrow suitability threshold. Re-evaluate
  // those few ambiguous cells analytically so coarse interpolation cannot
  // move a path across the boundary.
  return Math.abs(cached - 0.12) <= 0.03
    ? sampleVegetationSuitabilityDirect(dem, x, y, densityNoise, options)
    : cached;
}

function alignDirection(
  direction: { x: number; y: number },
  reference: { x: number; y: number },
): { x: number; y: number } {
  return direction.x * reference.x + direction.y * reference.y < 0
    ? { x: -direction.x, y: -direction.y }
    : direction;
}

function sampleVegetationDirectionAtWithSampling(
  dem: MountainDEMData,
  waterDistance: Float32Array,
  flowNoise: SimplexNoise,
  x: number,
  y: number,
  options: ResolvedVegetationPatternOptions,
  sampling?: VegetationFlowSampling,
): { x: number; y: number; valid: boolean } {
  const epsilon = 1.4;
  const waterClearance = sampleScalarField(
    waterDistance,
    dem.width,
    dem.height,
    x,
    y,
  );
  const useDirectPotential = waterClearance < 4
    || isNearVegetationMaterialBoundary(dem, x, y, 2, sampling?.materialBoundary)
    || x < 4 || y < 4 || x > dem.width - 5 || y > dem.height - 5;
  const gradientX = useDirectPotential
    ? flowPotentialAtDirect(dem, flowNoise, x + epsilon, y, options, sampling) -
      flowPotentialAtDirect(dem, flowNoise, x - epsilon, y, options, sampling)
    : flowPotentialAt(dem, flowNoise, x + epsilon, y, options, sampling) -
      flowPotentialAt(dem, flowNoise, x - epsilon, y, options, sampling);
  const gradientY = useDirectPotential
    ? flowPotentialAtDirect(dem, flowNoise, x, y + epsilon, options, sampling) -
      flowPotentialAtDirect(dem, flowNoise, x, y - epsilon, options, sampling)
    : flowPotentialAt(dem, flowNoise, x, y + epsilon, options, sampling) -
      flowPotentialAt(dem, flowNoise, x, y - epsilon, options, sampling);
  const curlLength = Math.hypot(gradientX, gradientY);
  let curl =
    curlLength > 1e-5
      ? { x: -gradientY / curlLength, y: gradientX / curlLength }
      : { x: 1, y: 0 };

  const terrain = getContourTangentAt(
    dem.elevation,
    dem.width,
    dem.height,
    x,
    y,
  );
  const water = getContourTangentAt(waterDistance, dem.width, dem.height, x, y);
  if (terrain.valid) {
    const aligned = alignDirection({ x: terrain.tx, y: terrain.ty }, curl);
    terrain.tx = aligned.x;
    terrain.ty = aligned.y;
  }
  if (water.valid) {
    const aligned = alignDirection({ x: water.tx, y: water.ty }, curl);
    water.tx = aligned.x;
    water.ty = aligned.y;
  }

  const curlWeight = 0.35 + options.swirlStrength * 0.65;
  const terrainWeight = terrain.valid ? options.terrainFollowing * 0.85 : 0;
  const waterWeight = water.valid
    ? (1 - clamp01((waterClearance - 3) / 25)) * 0.55
    : 0;
  curl = {
    x:
      curl.x * curlWeight + terrain.tx * terrainWeight + water.tx * waterWeight,
    y:
      curl.y * curlWeight + terrain.ty * terrainWeight + water.ty * waterWeight,
  };
  const length = Math.hypot(curl.x, curl.y);
  return length < 1e-5
    ? { x: 1, y: 0, valid: false }
    : { x: curl.x / length, y: curl.y / length, valid: true };
}

export function sampleVegetationDirectionAt(
  dem: MountainDEMData,
  waterDistance: Float32Array,
  flowNoise: SimplexNoise,
  x: number,
  y: number,
  options: ResolvedVegetationPatternOptions,
): { x: number; y: number; valid: boolean } {
  return sampleVegetationDirectionAtWithSampling(
    dem,
    waterDistance,
    flowNoise,
    x,
    y,
    options,
  );
}

function createLandMask(dem: MountainDEMData): Uint8Array {
  const mask = new Uint8Array(dem.width * dem.height);
  for (let index = 0; index < mask.length; index++) {
    const water =
      dem.isOcean?.[index] === 1 ||
      dem.isRiverChannel?.[index] === 1 ||
      (dem.visualWaterCoverage?.[index] ?? dem.visualWaterMask?.[index] ?? 0) >
        0.1 ||
      (dem.wetlandPoolCoverage?.[index] ?? dem.wetlandPoolMask?.[index] ?? 0) >
        0.1;
    mask[index] = water ? 0 : 1;
  }
  return mask;
}

/** Distance from each dry cell to the nearest final visual-water cell. */
export function buildVegetationWaterDistance(
  dem: MountainDEMData,
  profiler?: MountainProfiler,
): Float32Array {
  const maskStop = profiler?.begin("vegetation water land mask");
  const landMask = createLandMask(dem);
  maskStop?.();
  const distanceStop = profiler?.begin("vegetation water distance transform");
  const distance = buildDistanceField(landMask, dem.width, dem.height);
  distanceStop?.();
  return distance;
}

function isVisibleWaterAt(dem: MountainDEMData, x: number, y: number): boolean {
  const ix = Math.max(0, Math.min(dem.width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(dem.height - 1, Math.round(y)));
  const index = iy * dem.width + ix;
  const hasVisualWaterClassification = Boolean(
    dem.visualWaterCoverage || dem.visualWaterMask,
  );
  return Boolean(
    dem.isOcean?.[index] === 1 ||
    dem.visualWaterMask?.[index] === 1 ||
    (dem.visualWaterCoverage?.[index] ?? 0) > 0.1 ||
    dem.wetlandPoolMask?.[index] === 1 ||
    (dem.wetlandPoolCoverage?.[index] ?? 0) > 0.1 ||
    (!hasVisualWaterClassification && dem.isRiverChannel?.[index] === 1)
  );
}

/** Distance to water that is actually visible on the rendered map. Internal
 * sub-threshold drainage channels must not make the entire wetland read as a
 * shoreline habitat for raster props. */
export function buildWetlandImageWaterDistance(
  dem: MountainDEMData,
  profiler?: MountainProfiler,
): Float32Array {
  const landMask = new Uint8Array(dem.width * dem.height);
  const maskStop = profiler?.begin("vegetation wetland image land mask");
  for (let index = 0; index < landMask.length; index++) {
    const x = index % dem.width;
    const y = Math.floor(index / dem.width);
    landMask[index] = isVisibleWaterAt(dem, x, y) ? 0 : 1;
  }
  maskStop?.();
  const distanceStop = profiler?.begin(
    "vegetation wetland image distance transform",
  );
  const distance = buildDistanceField(landMask, dem.width, dem.height);
  distanceStop?.();
  return distance;
}

interface SourceCoordinate {
  x: number;
  y: number;
}

interface VegetationCachedFieldLookup {
  x0: Int32Array;
  x1: Int32Array;
  tx: Float64Array;
  y0: Int32Array;
  y1: Int32Array;
  ty: Float64Array;
}

interface VegetationFlowSampling {
  outputWidth: number;
  outputHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  outputXDenominator: number;
  outputYDenominator: number;
  sourceXRange: number;
  sourceYRange: number;
  flowScale: number;
  swirlScale: number;
  cellSize: number;
  washNoiseScale: number;
  dryPatchScale: number;
  grainStride: number;
  /**
   * Affine source-domain coordinates for integer raster cells. The flow
   * integrator still uses sourceCoordinateAt for fractional path samples, but
   * the large wash/shadow raster passes can reuse these values without
   * repeating clamp, offset, and division work for every channel.
   */
  sourceXByPixel: Float64Array;
  sourceYByPixel: Float64Array;
  materialBoundary?: Uint8Array;
  /** Optional lazily populated two-pixel samples for safe field consumers. */
  flowCache?: VegetationFlowCache;
  /** Reused cache-population callbacks for broad raster passes. */
  potentialPopulate?: (gridX: number, gridY: number) => number;
  suitabilityPopulate?: (gridX: number, gridY: number) => number;
  /** Integer output-cell interpolation indices for broad raster passes. */
  cachedFieldLookup?: VegetationCachedFieldLookup;
}

export interface VegetationFlowCache {
  stride: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Integer world-coordinate origin of the local DEM. */
  originX: number;
  originY: number;
  /** World grid coordinate represented by local cache cell zero. */
  gridOriginX: number;
  gridOriginY: number;
  potential: Float32Array;
  potentialReady: Uint8Array;
  suitability: Float32Array;
  suitabilityReady: Uint8Array;
  materialBoundary: Uint8Array;
}

function createVegetationFlowCache(
  dem: MountainDEMData,
  originX = 0,
  originY = 0,
  materialBoundary = buildVegetationMaterialBoundary(dem),
): VegetationFlowCache {
  const stride = 2;
  const resolvedOriginX = Math.round(originX);
  const resolvedOriginY = Math.round(originY);
  const gridOriginX = Math.floor(resolvedOriginX / stride);
  const gridOriginY = Math.floor(resolvedOriginY / stride);
  const gridEndX = Math.floor((resolvedOriginX + Math.max(0, dem.width - 1)) / stride);
  const gridEndY = Math.floor((resolvedOriginY + Math.max(0, dem.height - 1)) / stride);
  const width = Math.max(1, gridEndX - gridOriginX + 1);
  const height = Math.max(1, gridEndY - gridOriginY + 1);
  const total = width * height;
  return {
    stride,
    width,
    height,
    sourceWidth: dem.width,
    sourceHeight: dem.height,
    originX: resolvedOriginX,
    originY: resolvedOriginY,
    gridOriginX,
    gridOriginY,
    potential: new Float32Array(total),
    potentialReady: new Uint8Array(total),
    suitability: new Float32Array(total),
    suitabilityReady: new Uint8Array(total),
    materialBoundary,
  };
}

function createVegetationCachedFieldLookup(
  cache: VegetationFlowCache,
  width: number,
  height: number,
): VegetationCachedFieldLookup {
  const x0 = new Int32Array(width);
  const x1 = new Int32Array(width);
  const tx = new Float64Array(width);
  const y0 = new Int32Array(height);
  const y1 = new Int32Array(height);
  const ty = new Float64Array(height);
  const maxX = cache.width - 1;
  const maxY = cache.height - 1;
  for (let x = 0; x < width; x++) {
    const grid = Math.max(
      0,
      Math.min(maxX, (x + cache.originX) / cache.stride - cache.gridOriginX),
    );
    const lower = Math.floor(grid);
    x0[x] = lower;
    x1[x] = Math.min(maxX, lower + 1);
    tx[x] = grid - lower;
  }
  for (let y = 0; y < height; y++) {
    const grid = Math.max(
      0,
      Math.min(maxY, (y + cache.originY) / cache.stride - cache.gridOriginY),
    );
    const lower = Math.floor(grid);
    y0[y] = lower;
    y1[y] = Math.min(maxY, lower + 1);
    ty[y] = grid - lower;
  }
  return { x0, x1, tx, y0, y1, ty };
}

function vegetationFlowScale(
  dem: MountainDEMData,
  options: ResolvedVegetationPatternOptions,
): number {
  const sourceWidth =
    options.coordinateSourceWidth > 1
      ? options.coordinateSourceWidth
      : dem.width;
  const sourceHeight =
    options.coordinateSourceHeight > 1
      ? options.coordinateSourceHeight
      : dem.height;
  return (
    Math.max(28, Math.min(sourceWidth, sourceHeight) * 0.095) /
      Math.pow(options.coordinatePatternScale, 1.35)
  ) * 0.5;
}

function createVegetationFlowSampling(
  dem: MountainDEMData,
  options: ResolvedVegetationPatternOptions,
  materialBoundary?: Uint8Array,
): VegetationFlowSampling {
  const outputWidth =
    options.coordinateStride > 1 ? options.coordinateStride : dem.width;
  const outputHeight =
    options.coordinateHeight > 1 ? options.coordinateHeight : dem.height;
  const sourceWidth =
    options.coordinateSourceWidth > 1
      ? options.coordinateSourceWidth
      : dem.width;
  const sourceHeight =
    options.coordinateSourceHeight > 1
      ? options.coordinateSourceHeight
      : dem.height;
  const flowScale = vegetationFlowScale(dem, options);
  const outputXDenominator = Math.max(1, outputWidth - 1);
  const outputYDenominator = Math.max(1, outputHeight - 1);
  const sourceXRange = Math.max(1, sourceWidth - 1);
  const sourceYRange = Math.max(1, sourceHeight - 1);
  const sourceXByPixel = new Float64Array(dem.width);
  const sourceYByPixel = new Float64Array(dem.height);
  for (let x = 0; x < dem.width; x++) {
    const globalX = Math.max(
      0,
      Math.min(outputWidth - 1, x + options.coordinateOffsetX),
    );
    sourceXByPixel[x] = (globalX / outputXDenominator) * sourceXRange;
  }
  for (let y = 0; y < dem.height; y++) {
    const globalY = Math.max(
      0,
      Math.min(outputHeight - 1, y + options.coordinateOffsetY),
    );
    sourceYByPixel[y] = (globalY / outputYDenominator) * sourceYRange;
  }
  return {
    outputWidth,
    outputHeight,
    sourceWidth,
    sourceHeight,
    outputXDenominator,
    outputYDenominator,
    sourceXRange,
    sourceYRange,
    flowScale,
    swirlScale: flowScale * 1.45,
    cellSize: flowScale * 2.05,
    washNoiseScale:
      Math.max(42, Math.min(sourceWidth, sourceHeight) * 0.3) /
      options.flowWashNoiseScale,
    dryPatchScale:
      Math.max(18, Math.min(sourceWidth, sourceHeight) * 0.09) /
      options.wetlandDryNoiseScale,
    grainStride: Math.max(
      1,
      options.coordinateStride > 1 ? options.coordinateStride : dem.width,
    ),
    sourceXByPixel,
    sourceYByPixel,
    materialBoundary,
  };
}

function sourceCoordinateAt(
  dem: MountainDEMData,
  x: number,
  y: number,
  options: ResolvedVegetationPatternOptions,
  sampling?: VegetationFlowSampling,
): SourceCoordinate {
  // Raster callers pass integer local coordinates. Reuse the precomputed
  // affine mapping in that case; fractional streamline samples continue
  // through the exact clamped calculation below.
  if (
    sampling &&
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    x < sampling.sourceXByPixel.length &&
    y >= 0 &&
    y < sampling.sourceYByPixel.length
  ) {
    return {
      x: sampling.sourceXByPixel[x],
      y: sampling.sourceYByPixel[y],
    };
  }
  const outputWidth = sampling?.outputWidth ?? (
    options.coordinateStride > 1 ? options.coordinateStride : dem.width
  );
  const outputHeight = sampling?.outputHeight ?? (
    options.coordinateHeight > 1 ? options.coordinateHeight : dem.height
  );
  const outputXDenominator = sampling?.outputXDenominator ?? Math.max(1, outputWidth - 1);
  const outputYDenominator = sampling?.outputYDenominator ?? Math.max(1, outputHeight - 1);
  const sourceXRange = sampling?.sourceXRange ?? Math.max(
    1,
    (options.coordinateSourceWidth > 1
      ? options.coordinateSourceWidth
      : dem.width) - 1,
  );
  const sourceYRange = sampling?.sourceYRange ?? Math.max(
    1,
    (options.coordinateSourceHeight > 1
      ? options.coordinateSourceHeight
      : dem.height) - 1,
  );
  const globalX = Math.max(
    0,
    Math.min(outputWidth - 1, x + options.coordinateOffsetX),
  );
  const globalY = Math.max(
    0,
    Math.min(outputHeight - 1, y + options.coordinateOffsetY),
  );
  return {
    x: (globalX / outputXDenominator) * sourceXRange,
    y: (globalY / outputYDenominator) * sourceYRange,
  };
}

function flowPotentialAtDirect(
  dem: MountainDEMData,
  flowNoise: SimplexNoise,
  x: number,
  y: number,
  options: ResolvedVegetationPatternOptions,
  sampling?: VegetationFlowSampling,
  source?: SourceCoordinate,
): number {
  const resolvedSource = source ?? sourceCoordinateAt(dem, x, y, options, sampling);
  const roundedPotential =
    1 -
    smoothStep(
      0.08,
      0.67,
      roundedFlowCellDistanceAt(
        dem,
        flowNoise,
        x,
        y,
        options,
        sampling,
        resolvedSource,
      ),
    );
  const flowScale = sampling?.flowScale ?? vegetationFlowScale(dem, options);
  const swirlScale = sampling?.swirlScale ?? flowScale * 1.45;
  const warped = flowNoise.domainWarp(
    resolvedSource.x / swirlScale + 13.7,
    resolvedSource.y / swirlScale - 9.3,
    0.48,
  );
  const swirlPotential = clamp01(
    0.5 + flowNoise.fbm(warped.x, warped.y, 3, 1.92, 0.54) * 0.5,
  );
  const regionalMix = clamp01(
    0.5 +
      flowNoise.noise2D(
        resolvedSource.x / (flowScale * 4.6) - 21.1,
        resolvedSource.y / (flowScale * 4.6) + 17.4,
      ) *
        0.5,
  );
  // Every consumer sees this same hybrid potential. Most regions retain a
  // rounded open centre; others receive enough warped influence to elongate,
  // connect, or open the contour into the looser swirls seen in the reference.
  const swirlMix = 0.25 + options.swirlStrength * 0.18 + regionalMix * 0.2;
  return clamp01(roundedPotential * (1 - swirlMix) + swirlPotential * swirlMix);
}

function flowPotentialAt(
  dem: MountainDEMData,
  flowNoise: SimplexNoise,
  x: number,
  y: number,
  options: ResolvedVegetationPatternOptions,
  sampling?: VegetationFlowSampling,
  source?: SourceCoordinate,
  forceDirect = false,
): number {
  const cache = sampling?.flowCache;
  if (!cache || forceDirect) {
    return flowPotentialAtDirect(dem, flowNoise, x, y, options, sampling, source);
  }
  return sampleCachedVegetationField(
    cache,
    cache.potential,
    cache.potentialReady,
    x,
    y,
    sampling.potentialPopulate ?? ((gridX, gridY) => flowPotentialAtDirect(
      dem,
      flowNoise,
      gridX,
      gridY,
      options,
      // The direct sampler still needs the coordinate-domain constants, but
      // must not recurse into this cache while it is being populated.
      sampling,
    )),
    sampling.cachedFieldLookup,
  );
}

/**
 * Return the normalized distance to the nearest jittered flow-cell centre.
 * This is the single geometry source for line tangents, line placement, and
 * wash tone, so their rounded centres and narrow corridors stay registered.
 */
function roundedFlowCellDistanceAt(
  dem: MountainDEMData,
  flowNoise: SimplexNoise,
  x: number,
  y: number,
  options: ResolvedVegetationPatternOptions,
  sampling?: VegetationFlowSampling,
  source?: SourceCoordinate,
): number {
  const resolvedSource = source ?? sourceCoordinateAt(dem, x, y, options, sampling);
  const cellSize = sampling?.cellSize ?? vegetationFlowScale(dem, options) * 2.05;
  // A small shared warp keeps the cells organic without turning their centres
  // back into the long, unrelated swirls produced by the previous potential.
  const warped = flowNoise.domainWarp(
    resolvedSource.x / cellSize,
    resolvedSource.y / cellSize,
    0.23 + options.swirlStrength * 0.16,
  );
  const cellX = Math.floor(warped.x);
  const cellY = Math.floor(warped.y);
  let nearest = Number.POSITIVE_INFINITY;

  for (let offsetY = -1; offsetY <= 1; offsetY++) {
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      const candidateX = cellX + offsetX;
      const candidateY = cellY + offsetY;
      const key =
        (Math.imul(candidateX, 374761393) ^
          Math.imul(candidateY, 668265263) ^
          (options.seed + 1907)) |
        0;
      const jitterX = (hash01(key, 601) - 0.5) * 0.28;
      const jitterY = (hash01(key, 607) - 0.5) * 0.28;
      const centreX = candidateX + 0.5 + jitterX;
      const centreY = candidateY + 0.5 + jitterY;
      nearest = Math.min(
        nearest,
        Math.hypot(warped.x - centreX, warped.y - centreY),
      );
    }
  }

  return nearest;
}

/**
 * Return how strongly a point belongs to a rounded flow-cell contour.
 *
 * The old sampler seeded streamlines throughout the eligible land mask, which
 * made the vegetation marks read like a universal texture. Flow directions are
 * tangent to the potential contours, so the potential gradient is a useful
 * edge signal: it is quiet at the centre of a cell and stronger on the bands
 * surrounding it. Keeping this separate from suitability lets biome clipping
 * continue to decide where vegetation is legal without filling every legal
 * pixel with a line. Both the tangent and this placement weight sample the
 * same potential used by the wash.
 */
function sampleVegetationFlowEdgeWeightAt(
  dem: MountainDEMData,
  flowNoise: SimplexNoise,
  x: number,
  y: number,
  options: ResolvedVegetationPatternOptions,
  sampling?: VegetationFlowSampling,
): number {
  const flowScale = sampling?.flowScale ?? vegetationFlowScale(dem, options);
  const radius = Math.max(4, Math.min(10, flowScale * 0.34));
  const forceDirect = isNearVegetationMaterialBoundary(
    dem,
    x,
    y,
    2,
    sampling?.materialBoundary,
  );
  const cached = evaluateVegetationFlowEdgeWeight(
    dem, flowNoise, x, y, radius, options, sampling, forceDirect,
  );
  return !forceDirect && Math.abs(cached - 0.12) <= 0.03
    ? evaluateVegetationFlowEdgeWeight(
        dem, flowNoise, x, y, radius, options, sampling, true,
      )
    : cached;
}

function evaluateVegetationFlowEdgeWeight(
  dem: MountainDEMData,
  flowNoise: SimplexNoise,
  x: number,
  y: number,
  radius: number,
  options: ResolvedVegetationPatternOptions,
  sampling: VegetationFlowSampling | undefined,
  forceDirect: boolean,
): number {
  const potential = flowPotentialAt(dem, flowNoise, x, y, options, sampling, undefined, forceDirect);
  const left = flowPotentialAt(dem, flowNoise, x - radius, y, options, sampling, undefined, forceDirect);
  const right = flowPotentialAt(dem, flowNoise, x + radius, y, options, sampling, undefined, forceDirect);
  const up = flowPotentialAt(dem, flowNoise, x, y - radius, options, sampling, undefined, forceDirect);
  const down = flowPotentialAt(dem, flowNoise, x, y + radius, options, sampling, undefined, forceDirect);
  const localMean = (left + right + up + down) * 0.25;
  const gradient = Math.hypot(right - left, down - up) * 0.5;
  const gradientBand = smoothStep(0.025, 0.16, gradient);
  const contourBand =
    smoothStep(0.04, 0.28, potential) * (1 - smoothStep(0.72, 0.96, potential));
  const darkBand = 1 - smoothStep(0.18, 0.46, potential);
  // Keep a slight local-change term so broad flat parts of the contour do not
  // become uniformly dense, without inventing a second pattern.
  const localChange = smoothStep(0.012, 0.12, Math.abs(potential - localMean));
  const placementBand = Math.max(contourBand, darkBand * 0.55);
  const gradientSupport = Math.max(gradientBand, darkBand * 0.38);
  return clamp01(gradientSupport * placementBand * (0.72 + localChange * 0.28));
}

function flowWashNoiseAt(
  dem: MountainDEMData,
  noise: SimplexNoise,
  x: number,
  y: number,
  options: ResolvedVegetationPatternOptions,
  sampling?: VegetationFlowSampling,
  source?: SourceCoordinate,
): number {
  const resolvedSource = source ?? sourceCoordinateAt(dem, x, y, options, sampling);
  const scale = sampling?.washNoiseScale ?? (
    Math.max(
      42,
      Math.min(
        options.coordinateSourceWidth > 1
          ? options.coordinateSourceWidth
          : dem.width,
        options.coordinateSourceHeight > 1
          ? options.coordinateSourceHeight
          : dem.height,
      ) * 0.3,
    ) / options.flowWashNoiseScale
  );
  return sampleCartographicWashNoise(noise, resolvedSource.x, resolvedSource.y, scale);
}

/**
 * Shared high-frequency texture used to keep every vegetation material from
 * looking digitally smooth. The coarse simplex component makes connected
 * grain patches, while the fine hash component breaks their edges into
 * printed specks. Coordinates are mapped through the export source domain so
 * tiled renders keep the same pattern as the preview.
 */
function sampleVegetationTextureGrainAt(
  dem: MountainDEMData,
  grainNoise: SimplexNoise,
  x: number,
  y: number,
  options: ResolvedVegetationPatternOptions,
  sampling?: VegetationFlowSampling,
  source?: SourceCoordinate,
): number {
  const resolvedSource = source ?? sourceCoordinateAt(dem, x, y, options, sampling);
  const globalX = Math.round(x + options.coordinateOffsetX);
  const globalY = Math.round(y + options.coordinateOffsetY);
  const grainStride = sampling?.grainStride ?? Math.max(
    1,
    options.coordinateStride > 1 ? options.coordinateStride : dem.width,
  );
  return sampleCartographicGrain(grainNoise, resolvedSource.x, resolvedSource.y,
    globalY * grainStride + globalX, options.seed, options.coordinatePatternScale);
}

function wetlandDryPatchNoiseAt(
  dem: MountainDEMData,
  noise: SimplexNoise,
  x: number,
  y: number,
  options: ResolvedVegetationPatternOptions,
  sampling?: VegetationFlowSampling,
  source?: SourceCoordinate,
): number {
  const resolvedSource = source ?? sourceCoordinateAt(dem, x, y, options, sampling);
  const baseScale = sampling?.dryPatchScale ?? (
    Math.max(
      18,
      Math.min(
        options.coordinateSourceWidth > 1
          ? options.coordinateSourceWidth
          : dem.width,
        options.coordinateSourceHeight > 1
          ? options.coordinateSourceHeight
          : dem.height,
      ) * 0.09,
    ) / options.wetlandDryNoiseScale
  );
  return sampleCartographicPatchNoise(noise, resolvedSource.x, resolvedSource.y, baseScale);
}

function smoothStep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function wetlandDistanceDrynessAtDistance(
  distance: number,
  options: ResolvedVegetationPatternOptions,
): number {
  const start = Math.min(
    options.wetlandDryDistanceStart,
    options.wetlandDryDistanceEnd - 1,
  );
  const end = Math.max(start + 1, options.wetlandDryDistanceEnd);
  // Shared blue-to-red water-distance position for the diagnostic overlay and
  // image-prop habitat targeting.
  return smoothStep(start, end, distance);
}

function wetlandImagePropHabitatAtDistance(
  distance: number,
  options: ResolvedVegetationPatternOptions,
): number {
  const gradientPosition = wetlandDistanceDrynessAtDistance(distance, options);
  const biasDistance = Math.abs(
    gradientPosition - options.wetlandImagePropDrynessBias,
  );
  // Treat the bias as a target position on the same blue-to-red gradient.
  // The narrow falloff keeps endpoint settings categorical while allowing
  // intermediate bias values to move colonies through the transition band.
  return 1 - smoothStep(0.08, 0.26, biasDistance);
}

function buildFlowBackgroundTone(
  dem: MountainDEMData,
  clip: Uint8Array,
  options: ResolvedVegetationPatternOptions,
  profiler?: MountainProfiler,
  sharedFlowCache?: VegetationFlowCache,
): {
  tone: Float32Array;
  noise: Float32Array;
  dryness: Float32Array;
  wetlandDryness: Float32Array;
  wetlandImagePropHabitat: Float32Array;
} {
  const tone = new Float32Array(dem.width * dem.height);
  const noise = new Float32Array(dem.width * dem.height);
  const dryness = new Float32Array(dem.width * dem.height);
  const wetlandDryness = new Float32Array(dem.width * dem.height);
  const wetlandImagePropHabitat = new Float32Array(dem.width * dem.height);
  const flowNoise = new SimplexNoise(options.seed + 907);
  const washNoise = new SimplexNoise(options.seed + 1403);
  const dryPatchNoise = new SimplexNoise(options.seed + 1801);
  const grainNoise = new SimplexNoise(options.seed + 3221);
  const waterDistance =
    options.waterDistanceOverride?.length === dem.width * dem.height
      ? options.waterDistanceOverride
      : profiler
        ? profiler.measure("vegetation wetland image distance", () =>
            buildWetlandImageWaterDistance(dem, profiler),
          )
        : buildWetlandImageWaterDistance(dem, profiler);
  // Sample a much wider neighbourhood so the three-stop wash reads as broad
  // cartographic shading rather than a second line pattern.
  // Keep the support within the export halo (16px minimum in regression
  // renders, 32px in production exports) while still broadening the prior
  // 10px neighbourhood.
  const blurRadius = Math.min(
    14,
    Math.max(10, 18 / options.coordinatePatternScale),
  );
  const materialBoundary = sharedFlowCache?.materialBoundary
    ?? buildVegetationMaterialBoundary(dem);
  const flowSampling = createVegetationFlowSampling(
    dem,
    options,
    materialBoundary,
  );
  // Reuse the same two-pixel potential grid as streamline tracing. Wash
  // gradients and trace directions therefore share deterministic samples.
  const sharedCacheMatchesDomain = sharedFlowCache
    && sharedFlowCache.sourceWidth === dem.width
    && sharedFlowCache.sourceHeight === dem.height
    && sharedFlowCache.originX === options.coordinateOffsetX
    && sharedFlowCache.originY === options.coordinateOffsetY;
  flowSampling.flowCache = sharedCacheMatchesDomain
    ? sharedFlowCache
    : createVegetationFlowCache(
        dem,
        options.coordinateOffsetX,
        options.coordinateOffsetY,
        materialBoundary,
      );
  // The wash/background pass samples this cache at every output cell. Build
  // the interpolation indices once so the hot raster loop does not repeat
  // coordinate division, clamping, and flooring for each field channel.
  flowSampling.cachedFieldLookup = createVegetationCachedFieldLookup(
    flowSampling.flowCache,
    dem.width,
    dem.height,
  );
  // Bind the direct population function once. Without this, every cached
  // raster sample creates a new closure even though all samples share the
  // same DEM, noise object, options, and sampling domain.
  flowSampling.potentialPopulate = (gridX, gridY) => flowPotentialAtDirect(
    dem,
    flowNoise,
    gridX,
    gridY,
    options,
    flowSampling,
  );
  const leftX = new Int32Array(dem.width);
  const rightX = new Int32Array(dem.width);
  for (let x = 0; x < dem.width; x++) {
    leftX[x] = Math.max(
      0,
      Math.min(dem.width - 1, Math.round(x - blurRadius)),
    );
    rightX[x] = Math.max(
      0,
      Math.min(dem.width - 1, Math.round(x + blurRadius)),
    );
  }
  const upY = new Int32Array(dem.height);
  const downY = new Int32Array(dem.height);
  for (let y = 0; y < dem.height; y++) {
    upY[y] = Math.max(
      0,
      Math.min(dem.height - 1, Math.round(y - blurRadius)),
    );
    downY[y] = Math.max(
      0,
      Math.min(dem.height - 1, Math.round(y + blurRadius)),
    );
  }
  const potentialSupport = new Uint8Array(dem.width * dem.height);
  for (let y = 0; y < dem.height; y++) {
    const row = y * dem.width;
    for (let x = 0; x < dem.width; x++) {
      const index = row + x;
      if (clip[index] === 0) continue;
      potentialSupport[index] = 1;
      potentialSupport[row + leftX[x]] = 1;
      potentialSupport[row + rightX[x]] = 1;
      potentialSupport[upY[y] * dem.width + x] = 1;
      potentialSupport[downY[y] * dem.width + x] = 1;
    }
  }
  const dryDistanceStart = Math.min(
    options.wetlandDryDistanceStart,
    options.wetlandDryDistanceEnd - 1,
  );
  const dryDistanceEnd = Math.max(dryDistanceStart + 1, options.wetlandDryDistanceEnd);
  const potentialField = new Float32Array(dem.width * dem.height);
  const potentialStop = profiler?.begin("vegetation wash potential field");
  let potentialCellsEvaluated = 0;
  // All samples in these raster passes are consumed synchronously. Reusing a
  // single coordinate pair avoids allocating an object for every supported
  // cell (which is millions of short-lived objects at preview resolution).
  const source: SourceCoordinate = { x: 0, y: 0 };
  for (let y = 0; y < dem.height; y++) {
    const row = y * dem.width;
    for (let x = 0; x < dem.width; x++) {
      const index = row + x;
      if (potentialSupport[index] === 0) continue;
      source.x = flowSampling.sourceXByPixel[x];
      source.y = flowSampling.sourceYByPixel[y];
      potentialField[index] = flowPotentialAt(
        dem,
        flowNoise,
        x,
        y,
        options,
        flowSampling,
        source,
      );
      if (profiler) potentialCellsEvaluated++;
    }
  }
  potentialStop?.();
  profiler?.recordMetric(
    "vegetation wash potential cells evaluated",
    potentialCellsEvaluated,
    "count",
  );
  const toneStop = profiler?.begin("vegetation wash tone and dryness field");
  for (let y = 0; y < dem.height; y++) {
    for (let x = 0; x < dem.width; x++) {
      const index = y * dem.width + x;
      if (dem.biomeType[index] === 7) {
        // Keep the diagnostic independent from the vegetation ink clip. The
        // clip intentionally excludes simulation-only channels, while shrub
        // placement treats those cells as land when they are not visibly
        // covered by water.
        const gradientPosition = smoothStep(
          dryDistanceStart,
          dryDistanceEnd,
          waterDistance[index],
        );
        wetlandDryness[index] = gradientPosition;
        wetlandImagePropHabitat[index] =
          1 -
          smoothStep(
            0.08,
            0.26,
            Math.abs(gradientPosition - options.wetlandImagePropDrynessBias),
          );
      }
      if (clip[index] === 0) continue;
      source.x = flowSampling.sourceXByPixel[x];
      source.y = flowSampling.sourceYByPixel[y];
      const potential = potentialField[index];
      const left = potentialField[y * dem.width + leftX[x]];
      const right = potentialField[y * dem.width + rightX[x]];
      const up = potentialField[upY[y] * dem.width + x];
      const down = potentialField[downY[y] * dem.width + x];
      const localMean = (left + right + up + down) * 0.25;
      const broadCentre = smoothStep(0.06, 0.92, potential);
      const localCentre = smoothStep(
        0.025,
        0.22,
        Math.abs(potential - localMean),
      );
      const sharedGrain = sampleVegetationTextureGrainAt(
        dem,
        grainNoise,
        x,
        y,
        options,
        flowSampling,
        source,
      );
      const baseTone = 0.9 * broadCentre + 0.1 * localCentre;
      // Evaluate the gradient through the shared grain instead of adding a
      // second visible texture layer on top of it.
      tone[index] = filterVegetationGradient(baseTone, sharedGrain);
      const baseWashNoise = flowWashNoiseAt(
        dem,
        washNoise,
        x,
        y,
        options,
        flowSampling,
        source,
      );
      noise[index] = filterVegetationSignedGradient(baseWashNoise, sharedGrain);
      if (dem.biomeType[index] === 7) {
        const distance = waterDistance[index];
        const distanceBand =
          distance < dryDistanceStart
            ? 0
            : distance < dryDistanceEnd
              ? 0.38
              : 1;
        if (distanceBand > 0) {
          const patch = filterVegetationGradient(
            wetlandDryPatchNoiseAt(
              dem,
              dryPatchNoise,
              x,
              y,
              options,
              flowSampling,
              source,
            ),
            sharedGrain,
          );
          const threshold = 0.64 - distanceBand * 0.22;
          const classified = smoothStep(-0.055, 0.055, patch - threshold);
          // Dryness is a secondary material inside the same broad flow
          // channels as the vegetation wash. Without this gate, the wetland
          // noise reads as unrelated yellow blobs that ignore the curl/contour
          // structures used by the vegetation marks. The tone is high in flow
          // centres, so a soft threshold keeps the patch edges organic while
          // suppressing dry colour in the spaces between flows.
          const flowBand = smoothStep(0.42, 0.62, tone[index]);
          dryness[index] =
            classified * options.wetlandDryNoiseStrength * flowBand;
        }
      }
    }
  }
  toneStop?.();
  return { tone, noise, dryness, wetlandDryness, wetlandImagePropHabitat };
}

type VegetationTraceDirection = ReturnType<typeof sampleVegetationDirectionAt>;

interface VegetationTraceSeedState {
  suitability: number;
  edgeWeight: number;
  direction?: VegetationTraceDirection;
}

function traceHalfPath(
  dem: MountainDEMData,
  waterDistance: Float32Array,
  densityNoise: SimplexNoise,
  flowNoise: SimplexNoise,
  options: ResolvedVegetationPatternOptions,
  sampling: VegetationFlowSampling,
  startX: number,
  startY: number,
  directionSign: number,
  maximumSteps: number,
  seedState?: VegetationTraceSeedState,
): VegetationStrokePoint[] {
  const points: VegetationStrokePoint[] = [];
  const stepSize = Math.max(0.8, 1.35 * options.patternScale);
  let x = startX;
  let y = startY;
  let previous: { x: number; y: number } | null = null;
  let cachedSuitability = seedState?.suitability;
  let cachedEdgeWeight = seedState?.edgeWeight;
  for (let step = 0; step < maximumSteps; step++) {
    const suitability =
      cachedSuitability ??
      sampleVegetationSuitabilityAt(dem, x, y, densityNoise, options, sampling);
    cachedSuitability = undefined;
    if (suitability < 0.12) break;
    // Streamlines are accents on the perimeter of a flow cell. Stopping when
    // the trace reaches a quiet centre prevents a seed on the edge from
    // dragging a continuous mark across the clear interior.
    const edgeWeight =
      cachedEdgeWeight ??
      sampleVegetationFlowEdgeWeightAt(
        dem,
        flowNoise,
        x,
        y,
        options,
        sampling,
      );
    cachedEdgeWeight = undefined;
    if (edgeWeight < 0.12) break;
    const direction =
      step === 0 && seedState
        ? (seedState.direction ??= sampleVegetationDirectionAtWithSampling(
            dem,
            waterDistance,
            flowNoise,
            x,
            y,
            options,
            sampling,
          ))
        : sampleVegetationDirectionAtWithSampling(
            dem,
            waterDistance,
            flowNoise,
            x,
            y,
            options,
            sampling,
          );
    if (!direction.valid) break;
    let dx = direction.x * directionSign;
    let dy = direction.y * directionSign;
    if (previous && dx * previous.x + dy * previous.y < 0) {
      dx = -dx;
      dy = -dy;
    }
    if (previous && dx * previous.x + dy * previous.y < 0.26) break;
    const midpointX = x + dx * stepSize * 0.5;
    const midpointY = y + dy * stepSize * 0.5;
    const midpointDirection = sampleVegetationDirectionAtWithSampling(
      dem,
      waterDistance,
      flowNoise,
      midpointX,
      midpointY,
      options,
      sampling,
    );
    if (!midpointDirection.valid) break;
    let mx = midpointDirection.x * directionSign;
    let my = midpointDirection.y * directionSign;
    if (mx * dx + my * dy < 0) {
      mx = -mx;
      my = -my;
    }
    if (
      sampleVegetationFlowEdgeWeightAt(
        dem,
        flowNoise,
        midpointX,
        midpointY,
        options,
        sampling,
      ) < 0.1
    )
      break;
    x += mx * stepSize;
    y += my * stepSize;
    if (x < 1 || y < 1 || x >= dem.width - 1 || y >= dem.height - 1) break;
    const endpointSuitability = sampleVegetationSuitabilityAt(
      dem,
      x,
      y,
      densityNoise,
      options,
      sampling,
    );
    if (endpointSuitability < 0.12) break;
    cachedSuitability = endpointSuitability;
    points.push({ x, y });
    previous = { x: mx, y: my };
  }
  return points;
}

/**
 * Round the sampled streamline with a corner-cutting pass. The integrator is
 * intentionally conservative and samples in map pixels, so leaving the raw
 * samples as a polyline makes every change in heading visible as a hard bend.
 * Chaikin's pass keeps the curve inside the local point pairs and therefore
 * avoids the overshoot that a cubic spline could introduce across water or a
 * biome boundary.
 */
function smoothVegetationPath(
  points: readonly VegetationStrokePoint[],
  dem: MountainDEMData,
  densityNoise: SimplexNoise,
  options: ResolvedVegetationPatternOptions,
  sampling?: VegetationFlowSampling,
): VegetationStrokePoint[] {
  if (points.length < 5) return [...points];
  const smoothed: VegetationStrokePoint[] = [points[0]];
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index];
    const end = points[index + 1];
    smoothed.push({
      x: start.x * 0.75 + end.x * 0.25,
      y: start.y * 0.75 + end.y * 0.25,
    });
    smoothed.push({
      x: start.x * 0.25 + end.x * 0.75,
      y: start.y * 0.25 + end.y * 0.75,
    });
  }
  smoothed.push(points[points.length - 1]);

  // A corner-cutting curve can only move inside each adjacent pair, but a
  // narrow eligible strip can still be crossed at a boundary. In that rare
  // case keep the original traced path so water/biome clipping remains exact.
  for (const point of smoothed) {
    if (
      sampleVegetationSuitabilityAt(
        dem,
        point.x,
        point.y,
        densityNoise,
        options,
        sampling,
      ) < 0.12
    ) {
      return [...points];
    }
  }
  return smoothed;
}

type MotifChoice = Pick<VegetationMotifAsset, "key" | "family">;

/**
 * Pick a registered motif using the biome's family ratios. Family selection
 * and asset selection are deliberately separate: every placement first picks
 * a family by its configured percentage, then independently picks one of that
 * family's definitions. Therefore a family with three SVGs gives each SVG a
 * 1/3 chance whenever that family is selected.
 *
 * When a caller supplies a partial raster manifest (as focused tests do), the
 * supplied assets are the available definitions. Normal application renders
 * pass the complete VEGETATION_MOTIF_DEFINITIONS manifest as raster assets.
 */
function chooseMotifKey(
  biomeId: number,
  preset: VegetationPatternPreset,
  motifAssets: readonly VegetationMotifAsset[],
  familyRandom: number,
  assetRandom: number,
): string | undefined {
  const definitions: readonly MotifChoice[] = motifAssets.length
    ? motifAssets
    : VEGETATION_MOTIF_DEFINITIONS;
  const percentages = BIOME_MOTIF_PERCENTAGES[biomeId];
  const families = new Set<VegetationMotifFamily>();
  for (const definition of definitions) {
    families.add(definition.family);
  }

  const weightedFamilies = [...families].map((family) => {
    const familyWeight =
      preset === "adaptive"
        ? Math.max(0, percentages?.[family] ?? 0)
        : family === preset
          ? 100
          : 0;
    return { family, weight: familyWeight };
  });
  const total = weightedFamilies.reduce(
    (sum, choice) => sum + choice.weight,
    0,
  );
  if (total <= 0) return undefined;

  // Wetland flow marks have a distinct authored reed treatment whenever the
  // manifest supplies it. A partial audit manifest containing only universal
  // assets cannot represent that wetland family, so leave those placements
  // empty instead of silently turning them into unrelated universal marks.
  if (biomeId === 7 && preset === "adaptive") {
    const reeds = definitions.filter((definition) => definition.family === "reeds");
    if (reeds.length > 0) {
      const assetIndex = Math.min(
        reeds.length - 1,
        Math.floor(clamp01(assetRandom) * reeds.length),
      );
      return reeds[assetIndex]?.key;
    }
    if (!definitions.some((definition) => definition.family === "shrub")) {
      return undefined;
    }
  }

  let target = clamp01(familyRandom) * total;
  let selectedFamily = weightedFamilies[weightedFamilies.length - 1]?.family;
  for (const choice of weightedFamilies) {
    target -= choice.weight;
    if (target < 0) {
      selectedFamily = choice.family;
      break;
    }
  }

  if (!selectedFamily) return undefined;
  const familyDefinitions = definitions.filter(
    (definition) => definition.family === selectedFamily,
  );
  if (familyDefinitions.length === 0) return undefined;
  const assetIndex = Math.min(
    familyDefinitions.length - 1,
    Math.floor(clamp01(assetRandom) * familyDefinitions.length),
  );
  return familyDefinitions[assetIndex]?.key;
}

interface StrokeSample {
  x: number;
  y: number;
  rotation: number;
}

function sampleStrokeAtDistance(
  points: readonly VegetationStrokePoint[],
  cumulativeLengths: readonly number[],
  distance: number,
  segmentRotations?: readonly number[],
): StrokeSample {
  const result: StrokeSample = { x: 0, y: 0, rotation: 0 };
  sampleStrokeAtDistanceInto(
    points,
    cumulativeLengths,
    distance,
    result,
    segmentRotations,
  );
  return result;
}

/**
 * Fill a caller-owned sample record. Curved vegetation motifs call this once
 * per candidate raster cell, so reusing the record avoids allocating a small
 * object for every pixel while keeping the public sampling result unchanged.
 */
function sampleStrokeAtDistanceInto(
  points: readonly VegetationStrokePoint[],
  cumulativeLengths: readonly number[],
  distance: number,
  result: StrokeSample,
  segmentRotations?: readonly number[],
): void {
  const totalLength = cumulativeLengths[cumulativeLengths.length - 1] ?? 0;
  const target = Math.max(0, Math.min(totalLength, distance));
  // Find the first segment boundary at or after the target. This mirrors the
  // old forward scan's strict `< target` rule: an exact boundary belongs to
  // the segment before it and receives t=1.
  let low = 1;
  let high = Math.max(1, cumulativeLengths.length - 1);
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cumulativeLengths[middle] < target) low = middle + 1;
    else high = middle;
  }
  const segmentIndex = Math.max(0, Math.min(points.length - 2, low - 1));
  const start = points[segmentIndex];
  const end = points[Math.min(points.length - 1, segmentIndex + 1)];
  const segmentStart = cumulativeLengths[segmentIndex] ?? 0;
  const segmentLength = Math.max(
    1e-6,
    (cumulativeLengths[segmentIndex + 1] ?? segmentStart) - segmentStart,
  );
  const t = Math.max(0, Math.min(1, (target - segmentStart) / segmentLength));
  result.x = start.x + (end.x - start.x) * t;
  result.y = start.y + (end.y - start.y) * t;
  result.rotation = segmentRotations?.[segmentIndex]
    ?? Math.atan2(end.y - start.y, end.x - start.x);
}

interface VegetationPathSampler {
  path: VegetationStrokePath;
  cumulativeLengths: number[];
  segmentRotations: number[];
  totalLength: number;
}

function createVegetationPathSampler(
  path: VegetationStrokePath,
): VegetationPathSampler {
  const cumulativeLengths = new Array<number>(path.points.length).fill(0);
  const segmentRotations = new Array<number>(Math.max(0, path.points.length - 1));
  for (let index = 1; index < path.points.length; index++) {
    const previous = path.points[index - 1];
    const point = path.points[index];
    segmentRotations[index - 1] = Math.atan2(
      point.y - previous.y,
      point.x - previous.x,
    );
    cumulativeLengths[index] =
      cumulativeLengths[index - 1] +
        Math.hypot(point.x - previous.x, point.y - previous.y);
  }
  return {
    path,
    cumulativeLengths,
    segmentRotations,
    totalLength: cumulativeLengths[cumulativeLengths.length - 1] ?? 0,
  };
}

function sampleVegetationPathAtDistance(
  sampler: VegetationPathSampler,
  distance: number,
): StrokeSample {
  return sampleStrokeAtDistance(
    sampler.path.points,
    sampler.cumulativeLengths,
    distance,
    sampler.segmentRotations,
  );
}

function sampleVegetationPathAtDistanceInto(
  sampler: VegetationPathSampler,
  distance: number,
  result: StrokeSample,
): void {
  sampleStrokeAtDistanceInto(
    sampler.path.points,
    sampler.cumulativeLengths,
    distance,
    result,
    sampler.segmentRotations,
  );
}

/** Largest brush radius produced by the registered flow-line SVGs. */
function maximumRenderedFlowStrokeRadius(
  options: ResolvedVegetationPatternOptions,
): number {
  const maximumMotifSize = 14 * options.patternScale * options.motifSize;
  let maximumRadius = 0.28;
  for (const asset of options.motifAssets) {
    if (!asset.vectorPaths?.length) continue;
    const flowScale =
      (maximumMotifSize / Math.max(1, asset.width)) *
      Math.max(0.4, options.strokeLength);
    const normalScale = maximumMotifSize / Math.max(1, asset.height);
    for (const vectorPath of asset.vectorPaths) {
      maximumRadius = Math.max(
        maximumRadius,
        vectorPath.strokeWidth *
          Math.min(flowScale, normalScale) *
          options.strokeThickness *
          1.6,
      );
    }
  }
  return maximumRadius;
}

export function placeMotifsAlongPath(
  geometry: VegetationGeometry,
  dem: MountainDEMData,
  path: VegetationStrokePath,
  options: ResolvedVegetationPatternOptions,
): void {
  if (options.motifDensity <= 0 || path.points.length < 2) return;

  const cumulativeLengths = new Array<number>(path.points.length).fill(0);
  for (let index = 1; index < path.points.length; index++) {
    const previous = path.points[index - 1];
    const point = path.points[index];
    cumulativeLengths[index] =
      cumulativeLengths[index - 1] +
      Math.hypot(point.x - previous.x, point.y - previous.y);
  }
  const totalLength = cumulativeLengths[cumulativeLengths.length - 1];
  if (totalLength <= 0) return;

  const maximumSize = 14 * options.patternScale * options.motifSize;
  // SVGs are stretched along the flow axis during rasterization. Spacing by
  // their unstretched size made high Stroke length values overlap into one
  // continuous contour, especially with a low Motif density such as 0.25.
  // Use the largest possible rendered mark, then add a thickness-sized paper
  // gap. The length prevents end-to-end overlap; thickness controls only the
  // extra breathing room instead of multiplying the entire motif footprint.
  const renderedLength = maximumSize * options.strokeLength;
  const thicknessGap = maximumRenderedFlowStrokeRadius(options) * 2;
  const densitySpacing = 0.72 / Math.sqrt(Math.max(0.08, options.motifDensity));
  const spacing = Math.max(
    renderedLength + thicknessGap,
    renderedLength * densitySpacing,
  );
  const startDistance = Math.min(
    totalLength * 0.5,
    spacing * (0.2 + hash01(path.key, 61) * 0.55),
  );
  let placementIndex = 0;

  for (
    let distance = startDistance;
    distance <= totalLength;
    distance += spacing
  ) {
    const placementKey =
      (path.key ^ Math.imul(placementIndex + 1, 2246822519)) | 0;
    const sample = sampleStrokeAtDistance(
      path.points,
      cumulativeLengths,
      distance,
    );
    const placementBiome = biomeAt(dem, sample.x, sample.y);
    const assetKey = chooseMotifKey(
      placementBiome,
      options.preset,
      options.motifAssets,
      hash01(placementKey, 71),
      hash01(placementKey, 89),
    );
    if (!assetKey) {
      placementIndex++;
      continue;
    }
    geometry.motifs.push({
      x: sample.x,
      y: sample.y,
      rotation: sample.rotation + (hash01(placementKey, 73) - 0.5) * 0.24,
      size:
        (9 + hash01(placementKey, 79) * 5) *
        options.patternScale *
        options.motifSize,
      opacity: 0.7 + hash01(placementKey, 83) * 0.3,
      biomeId: placementBiome,
      assetKey,
      pathKey: path.key,
      pathT: distance / totalLength,
    });
    placementIndex++;
  }
}

function distanceToSegment(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared <= 1e-6
      ? 0
      : Math.max(
          0,
          Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lengthSquared),
        );
  return Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t));
}

interface VegetationPathSegmentIndex {
  readonly cellSize: number;
  readonly originX: number;
  readonly originY: number;
  readonly columns: number;
  readonly rows: number;
  readonly cells: Map<number, number[]>;
  readonly starts: VegetationStrokePoint[];
  readonly ends: VegetationStrokePoint[];
  readonly visited: Uint32Array;
  visitToken: number;
}

function buildVegetationPathSegmentIndex(
  paths: readonly VegetationStrokePath[],
  cellSize = 32,
): VegetationPathSegmentIndex {
  const starts: VegetationStrokePoint[] = [];
  const ends: VegetationStrokePoint[] = [];
  const cells = new Map<number, number[]>();
  let minimumCellX = Number.POSITIVE_INFINITY;
  let minimumCellY = Number.POSITIVE_INFINITY;
  let maximumCellX = Number.NEGATIVE_INFINITY;
  let maximumCellY = Number.NEGATIVE_INFINITY;

  for (const path of paths) {
    for (let index = 0; index < path.points.length - 1; index++) {
      const start = path.points[index];
      const end = path.points[index + 1];
      starts.push(start);
      ends.push(end);
      minimumCellX = Math.min(
        minimumCellX,
        Math.floor(Math.min(start.x, end.x) / cellSize),
      );
      minimumCellY = Math.min(
        minimumCellY,
        Math.floor(Math.min(start.y, end.y) / cellSize),
      );
      maximumCellX = Math.max(
        maximumCellX,
        Math.floor(Math.max(start.x, end.x) / cellSize),
      );
      maximumCellY = Math.max(
        maximumCellY,
        Math.floor(Math.max(start.y, end.y) / cellSize),
      );
    }
  }

  const originX = Number.isFinite(minimumCellX) ? minimumCellX : 0;
  const originY = Number.isFinite(minimumCellY) ? minimumCellY : 0;
  const columns =
    starts.length === 0
      ? 1
      : Math.max(1, maximumCellX - originX + 1);
  const rows =
    starts.length === 0
      ? 1
      : Math.max(1, maximumCellY - originY + 1);
  for (let segmentIndex = 0; segmentIndex < starts.length; segmentIndex++) {
    const start = starts[segmentIndex];
    const end = ends[segmentIndex];
    const minCellX = Math.floor(Math.min(start.x, end.x) / cellSize);
    const maxCellX = Math.floor(Math.max(start.x, end.x) / cellSize);
    const minCellY = Math.floor(Math.min(start.y, end.y) / cellSize);
    const maxCellY = Math.floor(Math.max(start.y, end.y) / cellSize);
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        const key =
          (cellY - originY) * columns + (cellX - originX);
        const bucket = cells.get(key);
        if (bucket) bucket.push(segmentIndex);
        else cells.set(key, [segmentIndex]);
      }
    }
  }

  return {
    cellSize,
    originX,
    originY,
    columns,
    rows,
    cells,
    starts,
    ends,
    visited: new Uint32Array(starts.length),
    visitToken: 0,
  };
}

function distanceToVegetationPaths(
  x: number,
  y: number,
  paths: readonly VegetationStrokePath[],
  maximumDistance: number,
): number {
  if (paths.length === 0) return Number.POSITIVE_INFINITY;
  // Keep the sentinel just above the rejection radius. This lets the
  // bounding-box shortcut distinguish "no nearby segment" from an exact
  // distance equal to the requested maximum.
  let nearest = maximumDistance + 1e-6;
  for (const path of paths) {
    for (let index = 0; index < path.points.length - 1; index++) {
      const start = path.points[index];
      const end = path.points[index + 1];
      if (
        x < Math.min(start.x, end.x) - nearest ||
        x > Math.max(start.x, end.x) + nearest ||
        y < Math.min(start.y, end.y) - nearest ||
        y > Math.max(start.y, end.y) + nearest
      ) {
        continue;
      }
      nearest = Math.min(
        nearest,
        distanceToSegment(x, y, start.x, start.y, end.x, end.y),
      );
      if (nearest <= 0.01) return 0;
    }
  }
  return nearest;
}

function distanceToIndexedVegetationPaths(
  x: number,
  y: number,
  index: VegetationPathSegmentIndex,
  maximumDistance: number,
  stats?: { segmentsExamined: number },
): number {
  if (index.starts.length === 0) {
    if (stats) stats.segmentsExamined = 0;
    return Number.POSITIVE_INFINITY;
  }
  index.visitToken++;
  if (index.visitToken === 0xffffffff) {
    index.visited.fill(0);
    index.visitToken = 1;
  }
  const token = index.visitToken;
  let nearest = maximumDistance + 1e-6;
  let segmentsExamined = 0;
  const minCellX = Math.max(
    index.originX,
    Math.floor((x - maximumDistance) / index.cellSize),
  );
  const maxCellX = Math.min(
    index.originX + index.columns - 1,
    Math.floor((x + maximumDistance) / index.cellSize),
  );
  const minCellY = Math.max(
    index.originY,
    Math.floor((y - maximumDistance) / index.cellSize),
  );
  const maxCellY = Math.min(
    index.originY + index.rows - 1,
    Math.floor((y + maximumDistance) / index.cellSize),
  );
  for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      const bucket = index.cells.get(
        (cellY - index.originY) * index.columns +
          (cellX - index.originX),
      );
      if (!bucket) continue;
      for (const segmentIndex of bucket) {
        if (index.visited[segmentIndex] === token) continue;
        index.visited[segmentIndex] = token;
        segmentsExamined++;
        const start = index.starts[segmentIndex];
        const end = index.ends[segmentIndex];
        nearest = Math.min(
          nearest,
          distanceToSegment(x, y, start.x, start.y, end.x, end.y),
        );
        if (nearest <= 0.01) {
          if (stats) stats.segmentsExamined = segmentsExamined;
          return 0;
        }
      }
    }
  }
  if (stats) stats.segmentsExamined = segmentsExamined;
  return nearest;
}

/** Internal test hook for checking the indexed query against the reference scan. */
export function createVegetationPathDistanceTesterForTesting(
  paths: readonly VegetationStrokePath[],
  cellSize = 32,
): {
  bruteForce: (x: number, y: number, maximumDistance: number) => number;
  indexed: (x: number, y: number, maximumDistance: number) => number;
} {
  const index = buildVegetationPathSegmentIndex(paths, cellSize);
  return {
    bruteForce: (x, y, maximumDistance) =>
      distanceToVegetationPaths(x, y, paths, maximumDistance),
    indexed: (x, y, maximumDistance) =>
      distanceToIndexedVegetationPaths(x, y, index, maximumDistance),
  };
}

export interface VegetationRasterPropBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function rasterPropRenderEnvelope(
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
): { width: number; height: number; anchorX: number; anchorY: number } {
  return {
    width: Math.max(
      0.5,
      placement.cellSize * (asset.renderWidthCells ?? asset.footprintWidthCells),
    ),
    height: Math.max(
      0.5,
      placement.cellSize * (asset.renderHeightCells ?? asset.footprintHeightCells),
    ),
    anchorX: asset.renderAnchorX ?? asset.anchorX,
    anchorY: asset.renderAnchorY ?? asset.anchorY,
  };
}

/** Rotated bounds of the visible raster artwork, excluding its logical footprint. */
function isForestCanvasProp(asset: VegetationRasterPropAsset): boolean {
  return asset.outlineGroup === "alpine-forest";
}

export function rasterPropRenderBounds(
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
): VegetationRasterPropBounds {
  const envelope = rasterPropRenderEnvelope(placement, asset);
  const left = -envelope.width * envelope.anchorX;
  const right = envelope.width * (1 - envelope.anchorX);
  const top = -envelope.height * envelope.anchorY;
  const bottom = envelope.height * (1 - envelope.anchorY);
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  const corners = [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ] as const;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [localX, localY] of corners) {
    const x = placement.x + localX * cos - localY * sin;
    const y = placement.y + localX * sin + localY * cos;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

export function rasterPropFootprintBounds(
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
): VegetationRasterPropBounds {
  const width = Math.max(0, placement.cellSize * asset.footprintWidthCells);
  const height = Math.max(0, placement.cellSize * asset.footprintHeightCells);
  const left = -width * asset.anchorX;
  const right = width * (1 - asset.anchorX);
  const top = -height * asset.anchorY;
  const bottom = height * (1 - asset.anchorY);
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  const corners = [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ] as const;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [localX, localY] of corners) {
    const x = placement.x + localX * cos - localY * sin;
    const y = placement.y + localX * sin + localY * cos;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function rasterPropFootprintRadius(
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
): number {
  return Math.hypot(
    placement.cellSize * asset.footprintWidthCells,
    placement.cellSize * asset.footprintHeightCells,
  ) * 0.5;
}

function rasterPropRenderRadius(
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
): number {
  const envelope = rasterPropRenderEnvelope(placement, asset);
  return Math.hypot(envelope.width, envelope.height) * 0.5;
}

function sampleRasterPropFootprint(
  dem: VegetationPlacementTerrain,
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
  predicate: (x: number, y: number) => boolean,
): boolean {
  const width = Math.max(0, placement.cellSize * asset.footprintWidthCells);
  const height = Math.max(0, placement.cellSize * asset.footprintHeightCells);
  const left = -width * asset.anchorX;
  const right = width * (1 - asset.anchorX);
  const top = -height * asset.anchorY;
  const bottom = height * (1 - asset.anchorY);
  const step = Math.max(2, placement.cellSize * 0.5);
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  const xSamples = [left];
  const ySamples = [top];
  for (let localX = left + step; localX < right; localX += step)
    xSamples.push(localX);
  for (let localY = top + step; localY < bottom; localY += step)
    ySamples.push(localY);
  xSamples.push(right);
  ySamples.push(bottom);
  for (const localY of ySamples) {
    for (const localX of xSamples) {
      const x = placement.x + localX * cos - localY * sin;
      const y = placement.y + localX * sin + localY * cos;
      if (x < 0 || y < 0 || x >= dem.width || y >= dem.height) return false;
      if (predicate(x, y)) return true;
    }
  }
  return false;
}

function rasterPropBiomesAreEligible(
  dem: VegetationPlacementTerrain,
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
): boolean {
  const eligible = new Set(asset.eligibleBiomeIds);
  if (eligible.size === 0) return false;
  const bounds = rasterPropFootprintBounds(placement, asset);
  if (
    bounds.minX < 0 ||
    bounds.minY < 0 ||
    bounds.maxX >= dem.width ||
    bounds.maxY >= dem.height
  ) return false;
  // Forest canopies may straddle habitat boundaries; their centers must
  // remain in their eligible biome. Water is still checked over the footprint.
  if (isForestCanvasProp(asset)) {
    return eligible.has(biomeAt(dem, placement.x, placement.y));
  }
  let hasSample = false;
  const invalid = sampleRasterPropFootprint(
    dem,
    placement,
    asset,
    (x, y) => {
      hasSample = true;
      return !eligible.has(biomeAt(dem, x, y));
    },
  );
  return hasSample && !invalid;
}

export function isRasterPropPlacementValid(
  dem: VegetationPlacementTerrain,
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
): boolean {
  return (
    rasterPropBiomesAreEligible(dem, placement, asset) &&
    !sampleRasterPropFootprint(dem, placement, asset, (x, y) =>
      isWaterAt(dem, x, y),
    )
  );
}

/**
 * Generate an inhomogeneous Thomas-style cluster process for raster props.
 *
 * A jittered grid is useful for guaranteeing coverage, but it also leaves a
 * detectable rhythm in the final map: every cell gets one chance and the
 * collision pass only removes points. Vegetation usually has a two-stage
 * distribution instead. A sparse parent process establishes patches, then a
 * small number of offspring are scattered around each parent. The density
 * parameter still controls the expected number of props, while the parent
 * activation and offspring count create broad gaps between groups.
 */
export function buildClusteredRasterPropCandidates(
  dem: Pick<VegetationPlacementTerrain, "width" | "height">,
  spacing: number,
  density: number,
  clustering: number,
  standSize: number,
  seed: number,
  seedSalt: number,
): Array<{ key: number; x: number; y: number; habitatWeight?: number }> {
  const candidates: Array<{ key: number; x: number; y: number; habitatWeight?: number }> = [];
  const clusterStrength = clamp01(clustering);
  const standStrength = clamp01(standSize);
  const parentSpacing = Math.max(
    18,
    spacing *
      Math.max(
        1,
        1.2 + clusterStrength * 0.62 + (standStrength - 0.5) * 1.3,
      ),
  );
  // Keep at least two parent cells on each axis. This matters for small
  // preview tiles where a literal coarse grid would collapse into one patch.
  const columns = Math.max(2, Math.ceil(dem.width / parentSpacing));
  const rows = Math.max(2, Math.ceil(dem.height / parentSpacing));
  const expectedCellPresence = Math.min(1, density * 0.9);
  const sourceColumns = Math.ceil(dem.width / spacing) + 1;
  const sourceRows = Math.ceil(dem.height / spacing) + 1;
  const parentAreaRatio = Math.max(
    0.2,
    (sourceColumns * sourceRows) / Math.max(1, columns * rows),
  );
  const activation = Math.min(
    1,
    (0.18 + 0.55 * Math.sqrt(Math.max(0, expectedCellPresence))) *
      (1 - clusterStrength * 0.45),
  );
  const patchNoise = new SimplexNoise(seed ^ seedSalt ^ 0x6a09e667);
  const patchInfluence = standStrength * 0.78;
  const patchScale = 2.5 + standStrength * 2.5;
  // Larger stands carry a little extra local population. At the neutral
  // midpoint this is 1x, while the broadest setting makes each surviving
  // parent visibly denser instead of merely moving the same few props apart.
  const standMemberBoost = 0.55 + standStrength * 0.9;
  const expectedMembers = Math.max(
    0,
    ((expectedCellPresence * parentAreaRatio) / Math.max(1e-6, activation)) *
      standMemberBoost,
  );

  const parentCellWidth = dem.width / columns;
  const parentCellHeight = dem.height / rows;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const parentKey =
        (Math.imul(column, 1597334677) ^
          Math.imul(row, 3812015801) ^
          seed ^
          seedSalt ^
          0x51ed270b) |
        0;
      const patchValue = clamp01(
        0.5 +
          patchNoise.fbm(
            column / patchScale,
            row / patchScale,
            3,
            1.9,
            0.55,
          ) *
            0.5,
      );
      const patchFactor =
        1 + patchInfluence * (patchValue - 0.5) * 1.6;
      if (hash01(parentKey, 853) > activation * patchFactor) continue;

      const centreX =
        (column + 0.5 + (hash01(parentKey, 857) - 0.5) * 0.28) *
        parentCellWidth;
      const centreY =
        (row + 0.5 + (hash01(parentKey, 859) - 0.5) * 0.28) *
        parentCellHeight;
      const memberCount = deterministicPoissonCount(
        expectedMembers,
        parentKey,
        863,
      );
      if (memberCount === 0) continue;
      const clusterRadius = Math.max(
        spacing *
          (0.76 - clusterStrength * 0.25) *
          (0.7 + standStrength * 0.6),
        spacing *
          ((0.76 - clusterStrength * 0.25) *
            (0.7 + standStrength * 0.6) +
            hash01(parentKey, 867) * 0.18),
      );

      for (let member = 0; member < memberCount; member++) {
        const key =
          (parentKey ^ Math.imul(member + 1, 2246822519) ^ 0x27d4eb2d) | 0;
        // Box-Muller gives a Thomas process its characteristic dense centre
        // and soft edge. The radius is capped so distant offspring do not
        // create isolated outliers that defeat the grouping effect.
        const radialSeed = Math.max(1e-4, hash01(key, 871));
        const radialDistance = Math.min(
          clusterRadius * 1.8,
          Math.sqrt(-2 * Math.log(radialSeed)) * clusterRadius * 0.55,
        );
        const angle = hash01(key, 877) * Math.PI * 2;
        candidates.push({
          key,
          x: centreX + Math.cos(angle) * radialDistance,
          y: centreY + Math.sin(angle) * radialDistance,
        });
      }
    }
  }
  return candidates;
}

/** Deterministic Poisson sampler used for a reproducible offspring count. */
function deterministicPoissonCount(
  mean: number,
  key: number,
  salt: number,
): number {
  if (mean <= 0) return 0;
  const threshold = Math.exp(-Math.min(24, mean));
  let product = 1;
  let count = 0;
  // Knuth's product method; the cap protects malformed inputs while leaving
  // the practical tail of the configured density range untouched.
  while (product > threshold && count < 32) {
    product *= Math.max(1e-6, hash01(key, salt + count));
    count++;
  }
  return Math.max(0, count - 1);
}

/** Shared woodland envelope: all tree variants inhabit the same stands and clearings. */
export type VegetationPreparationReporter = (
  stage: string,
  completed?: number,
  total?: number,
) => void;

function createThrottledPreparationReporter(
  onProgress?: VegetationPreparationReporter,
): VegetationPreparationReporter | undefined {
  if (!onProgress) return undefined;
  let activeStage = "";
  let lastUpdate = 0;
  return (stage, completed, total) => {
    const now = performance.now();
    if (stage !== activeStage || now - lastUpdate >= 250 || completed === total) {
      activeStage = stage;
      lastUpdate = now;
      onProgress(stage, completed, total);
    }
  };
}

/** @internal Deterministic forest stand candidates shared by all forest assets. */
export function buildForestCandidates(
  dem: Pick<VegetationPlacementTerrain, "width" | "height">,
  canopySize: number,
  options: ResolvedVegetationPatternOptions,
  reportProgress?: VegetationPreparationReporter,
  terrain?: VegetationPlacementTerrain,
  targetBiome?: number,
): Array<{ key: number; x: number; y: number }> {
  const candidates: Array<{ key: number; x: number; y: number }> = [];
  const density = options.rasterPropDensity;
  if (density <= 0) return candidates;
  // Art-directed gap process: overlapping, irregular ellipses carve clearings
  // out of continuous woodland. No thresholded noise contours or candidate grid.
  const gapScale = Math.min(
    canopySize * (3.5 + options.rasterPropStandSize * 7),
    Math.min(dem.width, dem.height) * (0.2 + options.rasterPropStandSize * 0.24),
  ) * options.rasterPropPlacementNoiseScale;
  const gaps = Array.from({ length: Math.ceil(
    dem.width * dem.height / (gapScale * gapScale) * 0.7,
  ) }, (_, index) => {
    const key = Math.imul(index + 1, 1597334677) ^ options.seed ^ 0x3c6ef372;
    const angle = hash01(key, 901) * Math.PI * 2;
    return {
      x: hash01(key, 903) * dem.width,
      y: hash01(key, 907) * dem.height,
      radius: gapScale * (0.4 + hash01(key, 909) * 0.8),
      aspect: 0.45 + hash01(key, 913) * 0.5,
      cos: Math.cos(angle), sin: Math.sin(angle),
      phase: hash01(key, 917) * Math.PI * 2,
    };
  });
  // A gap's influence ends once its normalized radius reaches 1.25. Since
  // edge modulation is bounded by 1.28 and the minor axis is at most 0.95 of
  // the major axis, a point farther than 2 * radius on either axis cannot
  // change the woodland value. Add those conservative boxes to a sparse grid.
  const gapCellSize = Math.max(1, gapScale * 2);
  const gapPadding = 2;
  const gapColumns = Math.ceil(dem.width / gapCellSize) + gapPadding * 2 + 1;
  const gapCells = new Map<number, number[]>();
  for (let gapIndex = 0; gapIndex < gaps.length; gapIndex++) {
    const gap = gaps[gapIndex];
    const firstColumn = Math.floor((gap.x - gap.radius * 2) / gapCellSize);
    const lastColumn = Math.floor((gap.x + gap.radius * 2) / gapCellSize);
    const firstRow = Math.floor((gap.y - gap.radius * 2) / gapCellSize);
    const lastRow = Math.floor((gap.y + gap.radius * 2) / gapCellSize);
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        const cellIndex = (row + gapPadding) * gapColumns + column + gapPadding;
        let occupants = gapCells.get(cellIndex);
        if (!occupants) {
          occupants = [];
          gapCells.set(cellIndex, occupants);
        }
        occupants.push(gapIndex);
      }
    }
  }
  const attempts = Math.ceil(dem.width * dem.height /
    Math.max(16, canopySize * canopySize * 0.11) * density);
  const scatteredFraction = (1 - options.rasterPropClustering) ** 3;
  reportProgress?.("Generating forest candidates", 0, attempts);
  for (let index = 0; index < attempts; index++) {
    const key = Math.imul(index + 1, 3812015801) ^ options.seed;
    const x = hash01(key, 911) * dem.width;
    const y = hash01(key, 919) * dem.height;
    // Candidate coordinates and keys stay unchanged, but points that cannot
    // produce a placement skip shelter and clearing work entirely.
    if (terrain && targetBiome !== undefined && biomeAt(terrain, x, y) !== targetBiome) {
      if ((index & 4095) === 4095 || index === attempts - 1) {
        reportProgress?.("Generating forest candidates", index + 1, attempts);
      }
      continue;
    }
    const terrainSuitability = terrain
      ? sampleAlpineForestTerrainSuitability(terrain, x, y)
      : undefined;
    const terrainShelter = terrainSuitability?.shelter ?? 0.5;
    // Shelter protects stands from the broad clearings in this existing
    // process; exposed terrain lets those gaps open farther into the canopy.
    const clearingInfluence = 1.5 - terrainShelter;
    let woodland = 1;
    const column = Math.floor(x / gapCellSize) + gapPadding;
    const row = Math.floor(y / gapCellSize) + gapPadding;
    const cellIndex = row * gapColumns + column;
    const nearbyGaps = gapCells.get(cellIndex);
    if (nearbyGaps) {
      for (let gapPosition = 0; gapPosition < nearbyGaps.length; gapPosition++) {
        const gap = gaps[nearbyGaps[gapPosition]];
        const dx = x - gap.x, dy = y - gap.y;
        const u = (dx * gap.cos + dy * gap.sin) / gap.radius;
        const v = (-dx * gap.sin + dy * gap.cos) / (gap.radius * gap.aspect);
        const angle = Math.atan2(v, u);
        const edge = 1 + 0.18 * Math.sin(angle * 3 + gap.phase) +
          0.1 * Math.sin(angle * 5 - gap.phase);
        woodland = Math.min(woodland, smoothStep(0.8, 1.25, Math.hypot(u, v) / edge));
      }
    }
    woodland = clamp01(1 - (1 - woodland) * clearingInfluence);
    const presence = scatteredFraction + (1 - scatteredFraction) * woodland;
    if (hash01(key, 929) < presence) {
      candidates.push({
        key,
        x,
        y,
        ...(terrainSuitability ? { habitatWeight: terrainSuitability.habitatWeight } : {}),
      });
    }
    if ((index & 4095) === 4095 || index === attempts - 1) {
      reportProgress?.("Generating forest candidates", index + 1, attempts);
    }
  }
  return candidates;
}

const MOUNTAIN_FOOTHILL_PROP_CELL_SIZE = 8;
/** Default maximum receiver steps for the mountain boulder transport pass. */
export const MOUNTAIN_FOOTHILL_TRANSPORT_STEPS_DEFAULT = 100;

export interface MountainFoothillTerrainFeatures {
  slope: number;
  nearbySteepness: number;
  concavity: number;
  sourceBias: number;
  mountainProximity: number;
  /** Normalized routed-flow strength near the candidate. */
  flowAlignment: number;
  /** Downstream slope-break / hollow score where transported rock can settle. */
  depositionPotential: number;
  /** Upstream energy score used to distinguish scree source areas. */
  transportPotential: number;
  featureScore: number;
}

const MOUNTAIN_D8_OFFSETS: readonly [number, number][] = [
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

/**
 * A compact, DEM-only rockfall field shared by preview and export. The
 * mountain illustration has a separate stroke pipeline, but both layers use
 * the same conditioned D8 receiver graph. Keeping the field here means a
 * boulder cluster follows the illustrated fall lines without making the SVG
 * or raster compositor responsible for geomorphic decisions.
 */
export interface MountainFoothillTransportField {
  /** Normalized supply generated on steep, exposed source cells. */
  source: Float32Array;
  /** Normalized material that arrived after downhill transport. */
  deposition: Float32Array;
  /** Normalized routed path strength, including the lateral fan spread. */
  routedFlow: Float32Array;
}

// Evans & Hungr's empirical minimum rockfall shadow angle for talus slopes;
// use it as a visual runout threshold, not as a universal stability limit.
const MOUNTAIN_ROCKFALL_RUNOUT_ANGLE_DEG = 27.5;
const MOUNTAIN_TALUS_ANGLE_DEG = 34;

function mountainFlowReceiver(dem: MountainDEMData, index: number): number {
  const x = index % dem.width;
  const y = Math.floor(index / dem.width);
  const direction = dem.flowDirection[index];
  if (direction >= 0 && direction < MOUNTAIN_D8_OFFSETS.length) {
    const [dx, dy] = MOUNTAIN_D8_OFFSETS[direction];
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < dem.width && ny < dem.height) {
      const next = ny * dem.width + nx;
      // A malformed or hand-built DEM can contain an uphill receiver. The
      // fallback below keeps the rock path downhill in that case.
      if (dem.elevation[next] <= dem.elevation[index] + 1e-3) return next;
    }
  }

  let receiver = -1;
  let lowest = dem.elevation[index];
  for (let candidateDirection = 0; candidateDirection < MOUNTAIN_D8_OFFSETS.length; candidateDirection++) {
    const [dx, dy] = MOUNTAIN_D8_OFFSETS[candidateDirection];
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= dem.width || ny >= dem.height) continue;
    const candidate = ny * dem.width + nx;
    if (dem.elevation[candidate] < lowest - 1e-3) {
      lowest = dem.elevation[candidate];
      receiver = candidate;
    }
  }
  return receiver;
}

function addMountainTransportDeposit(
  dem: MountainDEMData,
  field: Float32Array,
  index: number,
  amount: number,
  direction: number,
): void {
  if (amount <= 0 || index < 0 || index >= field.length) return;
  field[index] += amount;
  if (direction < 0 || direction >= MOUNTAIN_D8_OFFSETS.length) return;

  // A block fan is wider than a water pixel. Put a small, deterministic share
  // on either side of the receiver so adjacent gullies form a connected talus
  // patch instead of a one-cell line.
  const [dx, dy] = MOUNTAIN_D8_OFFSETS[direction];
  const x = index % dem.width;
  const y = Math.floor(index / dem.width);
  const lateralWeight = amount * 0.16;
  for (const sign of [-1, 1]) {
    const nx = x - dy * sign;
    const ny = y + dx * sign;
    if (nx < 0 || ny < 0 || nx >= dem.width || ny >= dem.height) continue;
    const lateral = ny * dem.width + nx;
    if (dem.isOcean[lateral] || dem.isRiverChannel[lateral] || dem.visualWaterMask?.[lateral]) continue;
    field[lateral] += lateralWeight;
  }
}

/**
 * Route a sparse set of rock sources through the mountain streamline graph.
 * This is intentionally an accumulated visual field rather than a physical
 * block solver: many steep cells feed the same receivers, and a slope break
 * converts that converging supply into a visible boulder/talus concentration.
 */
export function buildMountainFoothillTransportField(
  dem: MountainDEMData,
): MountainFoothillTransportField {
  const total = dem.width * dem.height;
  const source = new Float32Array(total);
  const deposition = new Float32Array(total);
  const routedFlow = new Float32Array(total);
  const minDimension = Math.min(dem.width, dem.height);
  // Keep the source count bounded for large export DEMs while allowing each
  // rockfall route enough receiver steps to reach a distant deposition fan.
  const sourceStride = Math.max(4, Math.round(minDimension / 180));
  const maxSteps = MOUNTAIN_FOOTHILL_TRANSPORT_STEPS_DEFAULT;
  const range = Math.max(1, dem.maxElevationM - dem.minElevationM);
  const logAccumulationScale = Math.log1p(Math.max(1, total));

  const sourcePotentialAt = (index: number): number => {
    if (dem.isOcean[index] || dem.isRiverChannel[index] || dem.visualWaterMask?.[index]) return 0;
    if (dem.biomeType[index] === 0) return 0;
    const slopePotential = clamp01((dem.slopeDeg[index] - 16) / 28);
    if (slopePotential <= 0) return 0;
    const mountainBand = clamp01((dem.normalizedElevation[index] - 0.18) / 0.64);
    const ruggedness = clamp01(
      Math.abs(dem.tpi[index]) / Math.max(1, range * 0.018) +
        Math.abs(dem.curvature[index]) / Math.max(1, range * 0.002),
    );
    const accumulation = clamp01(
      Math.log1p(Math.max(0, dem.flowAccumulation[index])) / logAccumulationScale,
    );
    const order = clamp01((dem.strahlerOrder[index] - 1) / 5);
    return clamp01(
      slopePotential *
        (0.38 + mountainBand * 0.38 + ruggedness * 0.24) *
        (0.68 + accumulation * 0.18 + order * 0.14),
    );
  };

  for (let sourceY = 1; sourceY < dem.height - 1; sourceY += sourceStride) {
    for (let sourceX = 1; sourceX < dem.width - 1; sourceX += sourceStride) {
      const sourceIndex = sourceY * dem.width + sourceX;
      const supply = sourcePotentialAt(sourceIndex);
      if (supply < 0.045) continue;
      source[sourceIndex] = Math.max(source[sourceIndex], supply);

      let current = sourceIndex;
      let energy = 0.34 + supply * 0.86;
      let previousSlope = dem.slopeDeg[current];
      for (let step = 0; step < maxSteps && energy > 0.035; step++) {
        if (dem.isOcean[current] || dem.isRiverChannel[current] || dem.visualWaterMask?.[current]) break;
        const receiver = mountainFlowReceiver(dem, current);
        const direction = receiver >= 0
          ? MOUNTAIN_D8_OFFSETS.findIndex(([dx, dy]) => {
              const x = current % dem.width;
              const y = Math.floor(current / dem.width);
              return y + dy === Math.floor(receiver / dem.width) &&
                x + dx === receiver % dem.width;
            })
          : -1;
        const currentSlope = dem.slopeDeg[current];
        const receiverSlope = receiver >= 0 ? dem.slopeDeg[receiver] : currentSlope;
        const slopeBreak = clamp01((currentSlope - receiverSlope - 1.0) / 18);
        const runoutSettling = clamp01(
          (MOUNTAIN_TALUS_ANGLE_DEG + 8 - receiverSlope) / 20,
        );
        const valley = clamp01(
          -dem.tpi[current] / Math.max(1, range * 0.025),
        );
        const accumulation = clamp01(
          Math.log1p(Math.max(0, dem.flowAccumulation[current])) / logAccumulationScale,
        );
        const residence = clamp01(
          0.08 + runoutSettling * 0.48 + slopeBreak * 0.48 +
            valley * 0.14 + accumulation * 0.14,
        );
        const depositIndex = receiver >= 0 ? receiver : current;
        const depositAmount = energy * residence * (0.82 + step * 0.012);
        addMountainTransportDeposit(dem, deposition, depositIndex, depositAmount, direction);
        addMountainTransportDeposit(dem, routedFlow, current, energy * (0.42 + accumulation * 0.58), direction);

        const mobility = clamp01((receiverSlope - MOUNTAIN_ROCKFALL_RUNOUT_ANGLE_DEG) / 30);
        const energyRetention = Math.max(
          0.52,
          Math.min(0.91, 0.61 + mobility * 0.22 + (1 - residence) * 0.08),
        );
        energy *= energyRetention;
        if (receiver < 0 || receiver === current) break;
        // Conditioned D8 flow should be acyclic. This guard also protects
        // small synthetic DEMs used by previews and tests.
        if (step > 0 && Math.abs(currentSlope - previousSlope) < 1e-6 && receiver === sourceIndex) break;
        previousSlope = currentSlope;
        current = receiver;
      }
    }
  }

  let maxDeposition = 0;
  let maxRouted = 0;
  for (let index = 0; index < total; index++) {
    maxDeposition = Math.max(maxDeposition, deposition[index]);
    maxRouted = Math.max(maxRouted, routedFlow[index]);
  }
  const depositionScale = Math.log1p(maxDeposition);
  const routedScale = Math.log1p(maxRouted);
  for (let index = 0; index < total; index++) {
    deposition[index] = depositionScale > 0
      ? clamp01(Math.log1p(deposition[index]) / depositionScale)
      : 0;
    routedFlow[index] = routedScale > 0
      ? clamp01(Math.log1p(routedFlow[index]) / routedScale)
      : 0;
  }
  return { source, deposition, routedFlow };
}

function sampleMountainFlowDeposition(
  dem: MountainDEMData,
  x: number,
  y: number,
  transportField?: MountainFoothillTransportField,
): Pick<MountainFoothillTerrainFeatures, 'flowAlignment' | 'depositionPotential' | 'transportPotential'> {
  if (transportField) {
    return {
      flowAlignment: clamp01(sampleScalarField(transportField.routedFlow, dem.width, dem.height, x, y)),
      depositionPotential: clamp01(sampleScalarField(transportField.deposition, dem.width, dem.height, x, y)),
      transportPotential: clamp01(
        sampleScalarField(transportField.source, dem.width, dem.height, x, y) * 0.62 +
          sampleScalarField(transportField.routedFlow, dem.width, dem.height, x, y) * 0.38,
      ),
    };
  }
  const startX = Math.max(0, Math.min(dem.width - 1, Math.round(x)));
  const startY = Math.max(0, Math.min(dem.height - 1, Math.round(y)));
  const total = dem.width * dem.height;
  const logAccumulationScale = Math.log1p(Math.max(1, total));
  let current = startY * dem.width + startX;
  let previousSlope = dem.slopeDeg[current];
  let deposition = 0;
  let transport = 0;
  let flowAlignment = 0;
  for (
    let step = 0;
    step < MOUNTAIN_FOOTHILL_TRANSPORT_STEPS_DEFAULT;
    step++
  ) {
    const cellX = current % dem.width;
    const cellY = Math.floor(current / dem.width);
    if (dem.isOcean[current] || dem.isRiverChannel[current] || dem.visualWaterMask?.[current]) break;
    const slope = dem.slopeDeg[current];
    const accumulation = clamp01(
      Math.log1p(Math.max(0, dem.flowAccumulation[current])) / logAccumulationScale,
    );
    const valley = clamp01(
      -dem.tpi[current] / Math.max(1, (dem.maxElevationM - dem.minElevationM) * 0.025),
    );
    const flat = 1 - clamp01((slope - 6) / 28);
    const slopeBreak = step === 0
      ? 0
      : clamp01((previousSlope - slope - 1.5) / 20);
    const residence = clamp01(flat * 0.44 + valley * 0.28 + slopeBreak * 0.42);
    const stepWeight = 0.72 + step * 0.045;
    deposition = Math.max(deposition, residence * stepWeight);
    transport = Math.max(
      transport,
      clamp01((slope - 12) / 34) * (0.42 + accumulation * 0.58),
    );
    flowAlignment = Math.max(flowAlignment, accumulation * (0.54 + step * 0.035));

    const direction = dem.flowDirection[current];
    if (direction < 0 || direction >= MOUNTAIN_D8_OFFSETS.length) break;
    const [dx, dy] = MOUNTAIN_D8_OFFSETS[direction];
    const nextX = cellX + dx;
    const nextY = cellY + dy;
    if (nextX < 0 || nextY < 0 || nextX >= dem.width || nextY >= dem.height) break;
    previousSlope = slope;
    current = nextY * dem.width + nextX;
  }
  return {
    flowAlignment: clamp01(flowAlignment),
    depositionPotential: clamp01(deposition),
    transportPotential: clamp01(transport),
  };
}

/**
 * Terrain signal for the small rock family. It deliberately samples a broad
 * neighbourhood: a boulder belongs below a face or at a gully outlet, not to
 * every individual pixel of a noisy slope raster.
 */
export function sampleMountainFoothillTerrain(
  dem: MountainDEMData,
  x: number,
  y: number,
  transportField?: MountainFoothillTransportField,
): MountainFoothillTerrainFeatures {
  const radius = Math.max(5, Math.min(18, Math.min(dem.width, dem.height) * 0.035));
  const range = Math.max(1, dem.maxElevationM - dem.minElevationM);
  const centreElevation = sampleScalarField(dem.elevation, dem.width, dem.height, x, y);
  const slope = sampleScalarField(dem.slopeDeg, dem.width, dem.height, x, y);
  let nearbySteepness = slope;
  let neighbourSum = 0;
  let neighbourCount = 0;
  for (let direction = 0; direction < 8; direction++) {
    const angle = direction * Math.PI / 4;
    for (const distance of [radius, radius * 1.8]) {
      const sampleX = x + Math.cos(angle) * distance;
      const sampleY = y + Math.sin(angle) * distance;
      nearbySteepness = Math.max(
        nearbySteepness,
        sampleScalarField(dem.slopeDeg, dem.width, dem.height, sampleX, sampleY),
      );
      neighbourSum += sampleScalarField(
        dem.elevation,
        dem.width,
        dem.height,
        sampleX,
        sampleY,
      );
      neighbourCount++;
    }
  }
  const neighbourAverage = neighbourSum / Math.max(1, neighbourCount);
  const concavity = clamp01((neighbourAverage - centreElevation) / (range * 0.018));
  const localRuggedness = clamp01(
    (Math.abs(neighbourAverage - centreElevation) / (range * 0.014) +
      (nearbySteepness - 18) / 34) * 0.5,
  );
  const footSuitability = 1 - clamp01((slope - 25) / 22);
  const sourceBias = clamp01(
    Math.max(
      (nearbySteepness - 22) / 28,
      concavity * 0.9,
      localRuggedness * 0.7,
    ) * footSuitability,
  );
  const normalized = sampleScalarField(
    dem.normalizedElevation,
    dem.width,
    dem.height,
    x,
    y,
  );
  const mountainBand = clamp01((normalized - 0.22) / 0.62);
  // A rugged patch elsewhere in the DEM is not automatically a mountain
  // foothill. Require a nearby highland core so the small rock marks do not
  // scatter across unrelated lowland terrain.
  const coreRadius = Math.max(
    8,
    Math.min(24, Math.min(dem.width, dem.height) * 0.025),
  );
  let mountainProximity = 0;
  const coreSamples = [
    [0, 0],
    [coreRadius, 0],
    [-coreRadius, 0],
    [0, coreRadius],
    [0, -coreRadius],
    [coreRadius * 0.72, coreRadius * 0.72],
    [-coreRadius * 0.72, coreRadius * 0.72],
    [coreRadius * 0.72, -coreRadius * 0.72],
    [-coreRadius * 0.72, -coreRadius * 0.72],
  ] as const;
  for (const [offsetX, offsetY] of coreSamples) {
    const sampleX = x + offsetX;
    const sampleY = y + offsetY;
    const ix = Math.max(0, Math.min(dem.width - 1, Math.round(sampleX)));
    const iy = Math.max(0, Math.min(dem.height - 1, Math.round(sampleY)));
    const index = iy * dem.width + ix;
    const coreBiome = dem.biomeType[index];
    const coreElevation = dem.normalizedElevation[index];
    const core = !isWaterAt(dem, sampleX, sampleY) &&
      (coreBiome === 0 || coreBiome === 1 ||
        (coreBiome === 2 && coreElevation > 0.42));
    if (!core) continue;
    const distance = Math.hypot(offsetX, offsetY);
    mountainProximity = Math.max(
      mountainProximity,
      clamp01(1 - distance / (coreRadius * 1.8)),
    );
  }
  const flowProcess = sampleMountainFlowDeposition(dem, x, y, transportField);
  return {
    slope,
    nearbySteepness,
    concavity,
    sourceBias,
    mountainProximity,
    ...flowProcess,
    featureScore: clamp01(
      sourceBias * (0.34 + mountainBand * 0.4) *
        (0.28 + mountainProximity * 0.5) *
        (0.76 + flowProcess.transportPotential * 0.24) +
        flowProcess.depositionPotential * 0.3 +
        flowProcess.flowAlignment * 0.1 +
        flowProcess.transportPotential * 0.08,
    ),
  };
}

function isMountainPermanentSnowAt(
  dem: MountainDEMData,
  x: number,
  y: number,
): boolean {
  const ix = Math.max(0, Math.min(dem.width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(dem.height - 1, Math.round(y)));
  const index = iy * dem.width + ix;
  const biome = dem.biomeType[index];
  const normalized = dem.normalizedElevation[index];
  const temperature = dem.temperatureC[index];
  return biome === 0 || (normalized > 0.72 && temperature < -2);
}

function chooseMountainFoothillAsset(
  assets: readonly VegetationRasterPropAsset[],
  key: number,
  salt: number,
): VegetationRasterPropAsset | undefined {
  if (assets.length === 0) return undefined;
  return assets[Math.min(assets.length - 1, Math.floor(hash01(key, salt) * assets.length))];
}

/**
 * Place terrain-led rock marks through the existing raster-prop path. The
 * boulder assets carry their 1x, 2x, and 3x footprints in the SVG metadata;
 * placements share a configurable cell scale and receive a deterministic
 * full-turn rotation so repeated charcoal outlines do not all face the same
 * direction.
 */
export function buildMountainFoothillPropPlacements(
  dem: MountainDEMData,
  options: ResolvedVegetationPatternOptions,
  profiler?: MountainProfiler,
  reportProgress?: VegetationPreparationReporter,
): VegetationRasterPropPlacement[] {
  const assets = options.rasterPropAssets.filter((asset) =>
    asset.placementRole === "mountain-foothill",
  );
  if (assets.length === 0 || options.mountainBoulderDensity <= 0) return [];

  const boulders = assets.filter((asset) => asset.key.includes("boulder"));
  const outcrops = assets.filter((asset) => asset.key.includes("outcrop"));
  const scree = assets.filter((asset) => asset.key.includes("scree"));
  const fallbackRockAssets = boulders.length > 0 ? boulders : assets;
  const chooseAvailableRockAsset = (
    candidates: readonly VegetationRasterPropAsset[],
    key: number,
    salt: number,
  ): VegetationRasterPropAsset | undefined =>
    chooseMountainFoothillAsset(
      candidates.length > 0 ? candidates : fallbackRockAssets,
      key,
      salt,
    );
  const densityScale = options.mountainBoulderDensity / 0.42;
  const mapReferenceScale = options.rasterPropScale === undefined
    ? Math.max(0.25, options.forestRenderScale)
    : Math.max(0.25, Math.max(dem.width, dem.height) / FOREST_REFERENCE_LONG_EDGE);
  const spacing = Math.max(16, 28 - Math.min(2, densityScale) * 7);
  const collisionGrid = new PoissonGrid(dem.width, dem.height, 4);
  reportProgress?.("Building mountain transport field");
  const transportFieldStop = profiler?.begin(
    "vegetation mountain foothill transport field",
  );
  const transportField = buildMountainFoothillTransportField(dem);
  transportFieldStop?.();
  const placements: VegetationRasterPropPlacement[] = [];

  const columns = Math.ceil(dem.width / spacing);
  const rows = Math.ceil(dem.height / spacing);
  reportProgress?.("Sampling mountain foothill placements", 0, (rows + 1) * (columns + 1));
  const candidateSamplingStop = profiler?.begin(
    "vegetation mountain foothill candidate sampling",
  );
  for (let row = 0; row <= rows; row++) {
    reportProgress?.(
      "Sampling mountain foothill placements",
      row * (columns + 1),
      (rows + 1) * (columns + 1),
    );
    for (let column = 0; column <= columns; column++) {
      const key = (
        Math.imul(column, 1103515245) ^
        Math.imul(row, 12345) ^
        options.seed ^
        0x4f1bbcdc
      ) | 0;
      const x = (column + 0.5 + (hash01(key, 941) - 0.5) * 0.72) * spacing;
      const y = (row + 0.5 + (hash01(key, 947) - 0.5) * 0.72) * spacing;
      if (x < 2 || y < 2 || x >= dem.width - 2 || y >= dem.height - 2) continue;
      const biome = biomeAt(dem, x, y);
      if (!assets.some((asset) => asset.eligibleBiomeIds.includes(biome))) continue;
      if (isWaterAt(dem, x, y) || isMountainPermanentSnowAt(dem, x, y)) continue;

      const terrain = sampleMountainFoothillTerrain(dem, x, y, transportField);
      if (
        terrain.slope > 39 ||
        terrain.mountainProximity < 0.28 ||
        terrain.featureScore < 0.05
      ) continue;
      const presence = (
        0.26 + terrain.featureScore * 0.34 + terrain.sourceBias * 0.12 +
        terrain.depositionPotential * 0.46 + terrain.flowAlignment * 0.1 +
        terrain.transportPotential * 0.12
      ) * Math.min(1.8, densityScale);
      if (hash01(key, 953) > presence) continue;

      const categoryRoll = hash01(key, 967);
      const sourceDriven = terrain.sourceBias > 0.48 || terrain.transportPotential > 0.5;
      const deposited = terrain.depositionPotential > 0.28;
      const asset = deposited && categoryRoll < 0.82
        ? chooseAvailableRockAsset(fallbackRockAssets, key, 969)
        : sourceDriven && categoryRoll < 0.06
        ? chooseAvailableRockAsset(scree, key, 971)
        : terrain.sourceBias > 0.34 && categoryRoll < 0.12
        ? chooseAvailableRockAsset(outcrops, key, 977)
          : chooseAvailableRockAsset(fallbackRockAssets, key, 983);
      if (!asset) continue;

      const placement: VegetationRasterPropPlacement = {
        x,
        y,
        rotation: hash01(key, 997) * Math.PI * 2,
        cellSize:
          MOUNTAIN_FOOTHILL_PROP_CELL_SIZE * options.mountainBoulderSize *
          mapReferenceScale,
        opacity: 0.84 + hash01(key, 991) * 0.12,
        biomeId: biome,
        assetKey: asset.key,
      };
      if (!isRasterPropPlacementValid(dem, placement, asset)) continue;
      const collisionRadius = Math.max(
        3,
        rasterPropFootprintRadius(placement, asset) * 0.46,
      );
      if (!collisionGrid.isClear(placement.x, placement.y, collisionRadius)) continue;
      collisionGrid.add(placement.x, placement.y, collisionRadius);
      placements.push(placement);
    }
  }
  reportProgress?.(
    "Sampling mountain foothill placements",
    (rows + 1) * (columns + 1),
    (rows + 1) * (columns + 1),
  );
  candidateSamplingStop?.();
  profiler?.recordMetric(
    "vegetation mountain foothill candidates",
    (columns + 1) * (rows + 1),
    "count",
  );
  profiler?.recordMetric(
    "vegetation mountain foothill props accepted",
    placements.length,
    "count",
  );
  return placements;
}

function placeRasterProps(
  geometry: VegetationGeometry,
  dem: VegetationPlacementTerrain,
  options: ResolvedVegetationPatternOptions,
  targetBiome?: number,
  profiler?: MountainProfiler,
  reportProgress?: VegetationPreparationReporter,
): void {
  const vegetationAssets = options.rasterPropAssets.filter((asset) =>
    (asset.placementRole ?? "vegetation") !== "mountain-foothill",
  );
  if (vegetationAssets.length === 0) return;
  if (targetBiome === undefined) {
    const biomes = new Set(
      vegetationAssets.flatMap((asset) => [...asset.eligibleBiomeIds]),
    );
    for (const biome of biomes) {
      const settings = rasterPropSettingsForBiome(options, biome);
      const biomeAssets = vegetationAssets.filter((asset) =>
        asset.eligibleBiomeIds.includes(biome),
      );
      if (biomeAssets.length === 0) continue;
      placeRasterProps(
        geometry,
        dem,
        {
          ...options,
          rasterPropAssets: biomeAssets,
          rasterPropDensity: settings.density,
          rasterPropClustering: settings.clustering,
        },
        biome,
        profiler,
        reportProgress,
      );
    }
    return;
  }
  if (options.rasterPropAssets.length === 0) return;
  const placements = (geometry.rasterProps ??= []);
  // The normalized forest control is authored against the live 2048px map.
  // Convert it to the current DEM domain before spacing, collision, and
  // placement geometry are generated. Legacy callers without the control keep
  // their existing pixel-valued behavior.
  const mapReferenceScale = options.rasterPropScale === undefined
    ? 1
    : Math.max(
        0.25,
        Math.max(dem.width, dem.height) / FOREST_REFERENCE_LONG_EDGE,
      ) * options.rasterPropScale;
  const propCellSize = options.rasterPropCellSize * mapReferenceScale;
  const collisionGrid = new PoissonGrid(
    dem.width,
    dem.height,
    Math.max(4, propCellSize * 0.5),
  );
  const hasWetlandHabitatRasterProps = vegetationAssets.some((asset) =>
    asset.eligibleBiomeIds.includes(7) && asset.placementRole !== "wetland",
  );
  const wetlandWaterDistance = hasWetlandHabitatRasterProps
    ? profiler
      ? profiler.measure("vegetation wetland image distance", () =>
          buildWetlandImageWaterDistance(dem as MountainDEMData, profiler),
        )
      : buildWetlandImageWaterDistance(dem as MountainDEMData, profiler)
    : undefined;
  const forestAssets = vegetationAssets.filter((asset) =>
    asset.eligibleBiomeIds.includes(targetBiome) && (
      targetBiome === 7
        ? asset.outlineGroup === "wetland-forest"
        : (targetBiome === 2 || targetBiome === 3 || targetBiome === 4) &&
          asset.outlineGroup === "alpine-forest"
    ),
  );
  const forestCandidatesByAsset = new Map<
    VegetationRasterPropAsset,
    Array<{ key: number; x: number; y: number; habitatWeight?: number }>
  >();
  const forestCandidateStop = forestAssets.length > 0
    ? profiler?.begin("vegetation forest candidate generation and grouping")
    : undefined;
  if (forestAssets.length > 0) {
    const forestCandidates = buildForestCandidates(
      dem,
      propCellSize * Math.max(
        ...forestAssets.map(asset => Math.max(
          asset.renderWidthCells ?? asset.footprintWidthCells,
          asset.renderHeightCells ?? asset.footprintHeightCells,
        )),
      ),
      options,
      reportProgress,
      targetBiome === 2 || targetBiome === 3 || targetBiome === 4
        ? dem
        : undefined,
      targetBiome,
    );
    reportProgress?.("Grouping forest candidates");
    for (let index = 0; index < forestCandidates.length; index++) {
      const candidate = forestCandidates[index];
      const assetIndex = Math.floor(hash01(candidate.key, 937) * forestAssets.length);
      // hash01 can produce exactly 1 for its maximum uint value. The previous
      // per-asset filter then matched no asset for that candidate.
      if (assetIndex >= forestAssets.length) continue;
      const asset = forestAssets[assetIndex];
      let grouped = forestCandidatesByAsset.get(asset);
      if (!grouped) {
        grouped = [];
        forestCandidatesByAsset.set(asset, grouped);
      }
      grouped.push(candidate);
      if ((index & 4095) === 4095 || index === forestCandidates.length - 1) {
        reportProgress?.("Grouping forest candidates", index + 1, forestCandidates.length);
      }
    }
  }
  forestCandidateStop?.();
  for (let assetIndex = 0; assetIndex < vegetationAssets.length; assetIndex++) {
    const asset = vegetationAssets[assetIndex];
    if (!asset.eligibleBiomeIds.includes(targetBiome)) continue;
    const forest = forestAssets.includes(asset);
    const wetlandTypeDensity = targetBiome === 7 && asset.placementRole === "wetland"
      ? options.wetlandShrubDensity
      : undefined;
    const propDensity = wetlandTypeDensity === undefined
      ? options.rasterPropDensity
      : wetlandTypeDensity * options.rasterPropDensity;
    if (propDensity <= 0) continue;
    const footprint = Math.max(
      asset.footprintWidthCells,
      asset.footprintHeightCells,
    );
    const spacing = Math.max(
      12,
      propCellSize * footprint *
        (footprint > 1 ? 1.25 : 1.1) /
        Math.sqrt(Math.max(0.08, propDensity)),
    );
    const candidateGenerationStop = profiler?.begin(
      "vegetation raster prop candidate generation",
    );
    const candidates = forest
      ? forestCandidatesByAsset.get(asset) ?? []
      : buildClusteredRasterPropCandidates(
          dem,
          spacing,
          propDensity,
          options.rasterPropClustering,
          options.rasterPropStandSize,
          options.seed,
          0x4f1bbcdc ^ Math.imul(assetIndex + 1, 0x27d4eb2d),
        );
    candidateGenerationStop?.();
    profiler?.recordMetric(
      "vegetation raster prop candidates",
      candidates.length,
      "count",
    );
    let acceptedForAsset = 0;
    const tryPlaceCandidate = (candidate: {
      key: number;
      x: number;
      y: number;
      habitatWeight?: number;
    }): boolean => {
      const candidateBiome = biomeAt(dem, candidate.x, candidate.y);
      if (candidateBiome !== targetBiome) return false;
      if (
        forest && asset.outlineGroup === "alpine-forest" &&
        (targetBiome === 2 || targetBiome === 3 || targetBiome === 4)
      ) {
        const habitatWeight = candidate.habitatWeight ??
          sampleAlpineForestTerrainSuitability(dem, candidate.x, candidate.y).habitatWeight;
        if (hash01(candidate.key, 941) >= habitatWeight) return false;
      }
      const placement: VegetationRasterPropPlacement = {
        x: candidate.x,
        y: candidate.y,
        rotation: forest || asset.placementRole === "wetland"
          ? 0
          : hash01(candidate.key, 829) * Math.PI * 2,
        cellSize: propCellSize,
        opacity: 1,
        biomeId: candidateBiome,
        assetKey: asset.key,
      };
      if (
        forest && wetlandTypeDensity !== undefined &&
        hash01(candidate.key, 839) >= clamp01(wetlandTypeDensity / 2)
      ) return false;
      if (placement.biomeId === 7 && wetlandWaterDistance) {
        const index =
          Math.round(placement.y) * dem.width + Math.round(placement.x);
        const habitatAffinity = wetlandImagePropHabitatAtDistance(
          wetlandWaterDistance[index],
          options,
        );
        // Keep active wetland shrubs on the same normalized distance-gradient
        // band that is shown by the dryness-map diagnostic.
        if (
          habitatAffinity <= 0 ||
          hash01(candidate.key, 839) > habitatAffinity
        ) {
          return false;
        }
      }
      if (!isRasterPropPlacementValid(dem, placement, asset)) return false;
      // Authored raster footprints describe the visible envelope, but natural
      // stands are allowed to overlap that envelope. Reserve only a fraction
      // of it so members of one cluster can interleave while separate patches
      // still remain legible.
      const footprintRadius = rasterPropFootprintRadius(placement, asset);
      const overlapFactor = forest ? 0.23 :
        footprint > 1
          ? 0.72 -
            options.rasterPropClustering * 0.15 -
            options.rasterPropStandSize * 0.08
          : 0.46 -
            options.rasterPropClustering * 0.12 -
            options.rasterPropStandSize * 0.06;
      const collisionRadius = forest
        ? Math.max(2, rasterPropRenderRadius(placement, asset) * 0.30)
        : footprintRadius * overlapFactor;
      if (!collisionGrid.isClear(placement.x, placement.y, collisionRadius)) {
        return false;
      }
      collisionGrid.add(placement.x, placement.y, collisionRadius);
      placements.push(placement);
      acceptedForAsset++;
      return true;
    };
    const candidateValidationStop = profiler?.begin(
      "vegetation raster prop candidate validation",
    );
    const forestValidationStop = forest
      ? profiler?.begin("vegetation forest placement validation")
      : undefined;
    reportProgress?.(`Checking ${asset.key} placements`, 0, candidates.length);
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const candidate = candidates[candidateIndex];
      tryPlaceCandidate(candidate);
      if ((candidateIndex & 1023) === 1023 || candidateIndex === candidates.length - 1) {
        reportProgress?.(`Checking ${asset.key} placements`, candidateIndex + 1, candidates.length);
      }
    }

    // Forest props can be sparse relative to the whole DEM. A single candidate
    // pass can miss narrow valid interiors, so sample a coarse grid only when
    // the normal pass found nothing.
    const needsCoverageFallback = asset.outlineGroup === "wetland-forest" ||
      asset.eligibleBiomeIds.some((biomeId) => biomeId === 2 || biomeId === 3);
    if (acceptedForAsset === 0 && needsCoverageFallback) {
      const coverageSpacing = Math.max(
        12,
        Math.min(spacing * 0.5, propCellSize * 2),
      );
      const columns = Math.ceil(dem.width / coverageSpacing);
      const rows = Math.ceil(dem.height / coverageSpacing);
      const targetPlacements = Math.max(
        3,
        Math.round(
          (dem.width * dem.height) /
            Math.max(1, spacing * spacing) *
            propDensity *
            0.15,
        ),
      );
      for (let row = 0; row <= rows && acceptedForAsset < targetPlacements; row++) {
        for (
          let column = 0;
          column <= columns && acceptedForAsset < targetPlacements;
          column++
        ) {
          const key =
            (Math.imul(column, 1103515245) ^
              Math.imul(row, 12345) ^
              options.seed ^
              0x6d2b79f5 ^
              Math.imul(assetIndex + 1, 0x27d4eb2d)) |
            0;
          tryPlaceCandidate({
            key,
            x:
              (column + 0.5 + (hash01(key, 881) - 0.5) * 0.54) *
              coverageSpacing,
            y:
              (row + 0.5 + (hash01(key, 883) - 0.5) * 0.54) *
              coverageSpacing,
          });
        }
      }
    }
    forestValidationStop?.();
    candidateValidationStop?.();
    profiler?.recordMetric(
      "vegetation raster props accepted",
      acceptedForAsset,
      "count",
    );
  }
}

/** Build only raster prop coordinates without the broader vegetation fields. */
export function buildVegetationRasterPropPlacements(
  terrain: VegetationPlacementTerrain,
  rawOptions?: VegetationPatternOptions,
  profiler?: MountainProfiler,
): VegetationRasterPropPlacement[] {
  const options = resolveVegetationPatternOptions(rawOptions);
  const geometry: VegetationGeometry = {
    width: terrain.width,
    height: terrain.height,
    paths: [],
    motifs: [],
    rasterProps: [],
  };
  placeRasterProps(geometry, terrain, options, undefined, profiler);
  return geometry.rasterProps ?? [];
}

/**
 * Which half of the vegetation pipeline to run. Streamline paths and motifs
 * ("flow") and raster props with their forest stands ("props") share no
 * state, so two workers can build them side by side and merge the halves.
 */
export type VegetationLayerPart = "all" | "flow" | "props";

function buildVegetationFlowGeometry(
  geometry: VegetationGeometry,
  dem: MountainDEMData,
  options: ResolvedVegetationPatternOptions,
  profiler: MountainProfiler | undefined,
  reportProgress: VegetationPreparationReporter | undefined,
): void {
  const densityNoise = new SimplexNoise(options.seed + 101);
  const flowNoise = new SimplexNoise(options.seed + 907);
  reportProgress?.("Preparing vegetation boundaries");
  const materialBoundary = buildVegetationMaterialBoundary(dem);
  const flowSampling = createVegetationFlowSampling(
    dem,
    options,
    materialBoundary,
  );
  // Keep seed/trace topology on the analytic sampler. Categorical biome and
  // water masks are part of the geometry contract; interpolating a coarse
  // procedural field can move a streamline far enough to change prop
  // clearance even when the raster appearance is close. The shared two-pixel
  // cache is attached after topology is complete and reused by the broad wash
  // and overlay consumers, where interpolation is safe and most samples are
  // repeated.
  reportProgress?.("Preparing vegetation distance fields");
  const waterDistanceStop = profiler?.begin("vegetation water distance");
  const waterDistance = buildVegetationWaterDistance(dem, profiler);
  waterDistanceStop?.();
  let flowGridCandidates = 0;
  let flowSuitabilityPasses = 0;
  let flowTraceAttempts = 0;
  let flowTracedPaths = 0;
  let flowCollisionRejects = 0;
  if (options.density > 0) {
    const spacing = Math.max(
      7,
      17 / Math.sqrt(Math.max(0.08, options.density)) / options.patternScale,
    );
    const seedPoisson = new PoissonGrid(dem.width, dem.height, spacing * 0.72);
    const maximumFlowStrokeRadius = maximumRenderedFlowStrokeRadius(options);
    const pathPoisson = new PoissonGrid(
      dem.width,
      dem.height,
      maximumFlowStrokeRadius,
    );
    const columns = Math.ceil(dem.width / spacing);
    const rows = Math.ceil(dem.height / spacing);
    const totalFlowCandidates = (rows + 1) * (columns + 1);
    reportProgress?.("Tracing vegetation patterns", 0, totalFlowCandidates);
    const maximumSteps = Math.max(
      5,
      Math.round((11 * options.strokeLength) / options.patternScale),
    );

    const flowSamplingStop = profiler?.begin("vegetation flow seed sampling");
    for (let row = 0; row <= rows; row++) {
      reportProgress?.(
        "Tracing vegetation patterns",
        row * (columns + 1),
        totalFlowCandidates,
      );
      for (let column = 0; column <= columns; column++) {
        flowGridCandidates++;
        const key =
          (Math.imul(column, 374761393) ^
            Math.imul(row, 668265263) ^
            options.seed) |
          0;
        const x = (column + 0.5 + (hash01(key, 41) - 0.5) * 0.74) * spacing;
        const y = (row + 0.5 + (hash01(key, 43) - 0.5) * 0.74) * spacing;
        if (x < 1 || y < 1 || x >= dem.width - 1 || y >= dem.height - 1)
          continue;
        const suitability = sampleVegetationSuitabilityAt(
          dem,
          x,
          y,
          densityNoise,
          options,
          flowSampling,
        );
        const edgeWeight = sampleVegetationFlowEdgeWeightAt(
          dem,
          flowNoise,
          x,
          y,
          options,
          flowSampling,
        );
        // Keep a small chance of an isolated mark, then strongly favour the
        // contour bands around each flow cell. This is what leaves the centres
        // legible instead of coating the entire biome with universal hatching.
        const edgePresence = Math.min(1, 0.08 + edgeWeight * 1.3);
        if (
          hash01(key, 47) >
          Math.min(1, suitability * options.density * 0.94 * edgePresence)
        )
          continue;
        flowSuitabilityPasses++;
        const clearance = spacing * (0.62 + (1 - suitability) * 0.28);
        // PoissonGrid now treats values as physical radii. Halving the old
        // seed clearance preserves the intended density-based centre spacing.
        const seedRadius = clearance * 0.5;
        if (!seedPoisson.isClear(x, y, seedRadius)) continue;

        flowTraceAttempts++;
        const traceSeedState: VegetationTraceSeedState = {
          suitability,
          edgeWeight,
        };
        const traceStop = profiler?.begin("vegetation flow path tracing");
        const backward = traceHalfPath(
          dem,
          waterDistance,
          densityNoise,
          flowNoise,
          options,
          flowSampling,
          x,
          y,
          -1,
          maximumSteps,
          traceSeedState,
        ).reverse();
        const forward = traceHalfPath(
          dem,
          waterDistance,
          densityNoise,
          flowNoise,
          options,
          flowSampling,
          x,
          y,
          1,
          maximumSteps,
          traceSeedState,
        );
        const tracedPoints = [...backward, { x, y }, ...forward];
        traceStop?.();
        if (tracedPoints.length < 5) continue;
        flowTracedPaths++;
        const smoothingStop = profiler?.begin("vegetation path smoothing");
        const points = smoothVegetationPath(
          tracedPoints,
          dem,
          densityNoise,
          options,
          flowSampling,
        );
        smoothingStop?.();
        const pathWidth = 0.72 + hash01(key, 53) * 0.42;
        const lineRadius = Math.max(
          maximumFlowStrokeRadius,
          pathWidth * options.strokeThickness,
        );
        // A traced streamline can curve toward an older one after its seed
        // passes. Check the sampled centreline with the actual ink radius;
        // pairwise radius sums give 2x thickness for equal-width lines.
        if (
          points.some(
            (point) => !pathPoisson.isClear(point.x, point.y, lineRadius),
          )
        ) {
          flowCollisionRejects++;
          continue;
        }
        seedPoisson.add(x, y, seedRadius);
        for (const point of points) {
          pathPoisson.add(point.x, point.y, lineRadius);
        }
        const biomeId = biomeAt(dem, x, y);
        const path: VegetationStrokePath = {
          key,
          biomeId,
          width: pathWidth,
          dashPhase: hash01(key, 59) * 19,
          points,
        };
        geometry.paths.push(path);
        const motifPlacementStop = profiler?.begin(
          "vegetation motif placement",
        );
        placeMotifsAlongPath(geometry, dem, path, options);
        motifPlacementStop?.();
      }
    }
    reportProgress?.("Tracing vegetation patterns", totalFlowCandidates, totalFlowCandidates);
    flowSamplingStop?.();
  }
  reportProgress?.("Caching vegetation fields");
  geometry.flowCache = createVegetationFlowCache(
    dem,
    options.coordinateOffsetX,
    options.coordinateOffsetY,
    materialBoundary,
  );
  if (profiler) {
    profiler.recordMetric("vegetation flow grid candidates", flowGridCandidates, "count");
    profiler.recordMetric("vegetation flow suitability passes", flowSuitabilityPasses, "count");
    profiler.recordMetric("vegetation flow trace attempts", flowTraceAttempts, "count");
    profiler.recordMetric("vegetation flow traced paths", flowTracedPaths, "count");
    profiler.recordMetric("vegetation flow collision rejects", flowCollisionRejects, "count");
    profiler.recordMetric("vegetation paths", geometry.paths.length, "count");
    profiler.recordMetric(
      "vegetation path points",
      geometry.paths.reduce((total, path) => total + path.points.length, 0),
      "count",
    );
    profiler.recordMetric(
      "vegetation path segments",
      geometry.paths.reduce(
        (total, path) => total + Math.max(0, path.points.length - 1),
        0,
      ),
      "count",
    );
    profiler.recordMetric("vegetation motifs", geometry.motifs.length, "count");
  }
}

function buildVegetationPropGeometry(
  geometry: VegetationGeometry,
  dem: MountainDEMData,
  options: ResolvedVegetationPatternOptions,
  profiler: MountainProfiler | undefined,
  reportProgress: VegetationPreparationReporter | undefined,
): void {
  const rasterPlacementStop = profiler?.begin(
    "vegetation raster prop placement",
  );
  reportProgress?.("Placing raster vegetation");
  placeRasterProps(geometry, dem, options, undefined, profiler, reportProgress);
  rasterPlacementStop?.();
  const foothillPlacementStop = profiler?.begin(
    "vegetation mountain foothill placement",
  );
  const foothillPlacements = buildMountainFoothillPropPlacements(
    dem,
    options,
    profiler,
    reportProgress,
  );
  foothillPlacementStop?.();
  if (geometry.rasterProps) {
    // Foothill placement counts scale with export resolution. Appending with
    // spread syntax turns the whole placement list into call arguments and
    // can overflow the JavaScript argument stack on large exports.
    for (const placement of foothillPlacements) {
      geometry.rasterProps.push(placement);
    }
  }
  const standStop = profiler?.begin("vegetation forest stand geometry");
  reportProgress?.("Building forest stands");
  buildPropStands(geometry, dem, options);
  standStop?.();
  if (profiler) {
    profiler.recordMetric(
      "vegetation raster props",
      Math.max(0, (geometry.rasterProps?.length ?? 0) - foothillPlacements.length),
      "count",
    );
    profiler.recordMetric(
      "vegetation mountain foothill props",
      foothillPlacements.length,
      "count",
    );
  }
}

/** Joins the halves built by two `buildVegetationGeometry` parts. */
export function mergeVegetationGeometry(
  flow: VegetationGeometry,
  props: VegetationGeometry,
): VegetationGeometry {
  return { ...flow, rasterProps: props.rasterProps, stands: props.stands };
}

export function buildVegetationGeometry(
  dem: MountainDEMData,
  rawOptions?: VegetationPatternOptions,
  profiler?: MountainProfiler,
  onProgress?: VegetationPreparationReporter,
  part: VegetationLayerPart = "all",
): VegetationGeometry {
  const reportProgress = createThrottledPreparationReporter(onProgress);
  const options = resolveVegetationPatternOptions(rawOptions);
  const geometry: VegetationGeometry = {
    width: dem.width,
    height: dem.height,
    paths: [],
    motifs: [],
    rasterProps: [],
  };
  if (part !== "props") buildVegetationFlowGeometry(geometry, dem, options, profiler, reportProgress);
  if (part !== "flow") buildVegetationPropGeometry(geometry, dem, options, profiler, reportProgress);
  return geometry;
}

/** Raster props drawn as hand-drawn stands instead of one by one. */
interface PropStandGroup {
  id: string;
  isMember: (asset: VegetationRasterPropAsset) => boolean;
  /** Templates, L4 shape and plant size relative to a stand tree. */
  profile: StandProfile;
  seedSalt: number;
  /** Palette colour the wash and plant bodies are shaded from. */
  color: (settings: ForestRenderSettings) => string;
  /** Palette colours of the profile's accent plants. */
  accentColors?: (settings: ForestRenderSettings) => { body: string; trunk: string };
}

/**
 * Every stand group shares one workflow (placement, stand mask, geometry,
 * painting); a new plant kind is a new row here plus its lodN templates.
 */
const PROP_STAND_GROUPS: readonly PropStandGroup[] = [
  {
    id: "alpine-forest",
    isMember: (asset) => asset.outlineGroup === "alpine-forest",
    profile: TREE_STAND_PROFILE,
    seedSalt: 0,
    color: (settings) => settings.alpineCanopyColor,
  },
  {
    id: "wetland-shrubs",
    isMember: (asset) => asset.outlineGroup === "wetland-forest" && asset.family === "shrub",
    profile: SHRUB_STAND_PROFILE,
    seedSalt: 0x5a1b7e,
    color: (settings) => settings.wetlandShrubColor,
    accentColors: (settings) => ({ body: settings.wetlandCanopyColor, trunk: settings.wetlandWoodColor }),
  },
];

/**
 * Stand tree height in prop cells: the alpine tree's rendered height (1.65
 * cells) × 0.8, as tuned in /forest-lab. Every group's plants are sized from
 * it through their profile, so the one prop scale drives all biomes alike.
 */
const STAND_TREE_SIZE_CELLS = 1.65 * 0.8;

/**
 * Placements of every stand group become hand-drawn stands: plants
 * standing in company mark the stand area, isolated ones stay lone (L1),
 * and the stand renderer draws both instead of the per-prop art. Placement
 * itself (biomes, clearings, suitability, water clearance) is unchanged.
 */
function buildPropStands(
  geometry: VegetationGeometry,
  dem: MountainDEMData,
  options: ResolvedVegetationPatternOptions,
): void {
  const assets = new Map(options.rasterPropAssets.map((asset) => [asset.key, asset]));
  const members = PROP_STAND_GROUPS.map(() => [] as VegetationRasterPropPlacement[]);
  const kept: VegetationRasterPropPlacement[] = [];
  for (const placement of geometry.rasterProps ?? []) {
    const asset = assets.get(placement.assetKey);
    const group = asset ? PROP_STAND_GROUPS.findIndex((candidate) => candidate.isMember(asset)) : -1;
    (group >= 0 ? members[group] : kept).push(placement);
  }
  if (members.every((list) => list.length === 0)) return;
  geometry.rasterProps = kept;

  const { width, height } = geometry;
  // Terrain light relative to flat ground (the same reference the map's
  // prop shading uses): 0.5 on flat ground, lower in shadow, higher when lit.
  let light: Float32Array | undefined;
  if (dem.hillshade && dem.hillshade.length === width * height) {
    let flatSum = 0;
    let flatCount = 0;
    for (let index = 0; index < dem.hillshade.length; index++) {
      if ((dem.slopeDeg?.[index] ?? 0) >= 3) continue;
      flatSum += dem.hillshade[index];
      flatCount++;
    }
    const flat = Math.max(0.01, flatCount > 0 ? flatSum / flatCount : 0.7);
    light = new Float32Array(width * height);
    for (let index = 0; index < light.length; index++) {
      light[index] = Math.max(0, Math.min(1, 0.5 + 0.75 * (dem.hillshade[index] - flat) / flat));
    }
  }

  const settings = options.forestSettings;
  const stands: VegetationPropStand[] = [];
  PROP_STAND_GROUPS.forEach((group, groupIndex) => {
    const placements = members[groupIndex];
    if (placements.length === 0) return;
    const cellSizes = placements.map((placement) => placement.cellSize).sort((a, b) => a - b);
    // The floor applies to the shared tree size, never to one group alone,
    // so small preview scales keep every group in proportion.
    const standTreeSize = Math.max(4, cellSizes[Math.floor(cellSizes.length / 2)] * STAND_TREE_SIZE_CELLS);
    const treeSize = standTreeSize * group.profile.size;
    // The stand mask follows placement spacing, which the shared prop scale
    // sets for every group alike, so it is sized from the stand tree, not
    // from this group's plant size (small shrubs would all read as lone).
    const radius = standTreeSize * 0.45;
    const stamp = (target: Float32Array, placement: VegetationRasterPropPlacement) => {
      const cy = placement.y - radius;
      for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(height - 1, Math.ceil(cy + radius)); y++) {
        for (let x = Math.max(0, Math.floor(placement.x - radius)); x <= Math.min(width - 1, Math.ceil(placement.x + radius)); x++) {
          if ((x - placement.x) ** 2 + (y - cy) ** 2 <= radius * radius) target[y * width + x] = 1;
        }
      }
    };
    // Plants with neighbours form stands; one on its own stays a lone L1.
    const all = new Float32Array(width * height);
    for (const placement of placements) stamp(all, placement);
    const company = standBoxBlur(all, width, height, Math.round(standTreeSize * 1.2));
    const standing = new Float32Array(width * height);
    const loneTrees: Array<{ x: number; y: number }> = [];
    for (const placement of placements) {
      if (sampleStandField(company, width, height, placement.x, placement.y - radius) < 0.25) {
        loneTrees.push({ x: placement.x, y: placement.y });
      } else {
        stamp(standing, placement);
      }
    }
    // Bridge the gaps between neighbouring plants into one stand area.
    const bridged = standBoxBlur(standing, width, height, Math.round(standTreeSize * 0.5));
    const forest = new Float32Array(width * height);
    for (let index = 0; index < forest.length; index++) forest[index] = smoothStep(0.25, 0.45, bridged[index]);

    stands.push({
      group: group.id,
      geometry: buildForestStandGeometry({
        width,
        height,
        forest,
        treeSize,
        seed: ((options.seed ^ Math.imul(settings.seed, 2654435761)) ^ group.seedSalt) >>> 0,
        settings: {
          markSpacing: settings.standMarkSpacing,
          edgeTrees: settings.standEdgeTrees,
          interiorTrees: settings.standInteriorTrees,
          meadowTrees: settings.standMeadowTrees,
          accentTrees: settings.standAccentTrees,
        },
        slope: dem.slopeDeg,
        light,
        loneTrees,
        profile: group.profile,
      }),
    });
  });
  geometry.stands = stands;
}

function boundsIntersect(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  width: number,
  height: number,
  margin: number,
): boolean {
  return (
    maxX >= -margin &&
    maxY >= -margin &&
    minX <= width + margin &&
    minY <= height + margin
  );
}

export interface AlpineForestTerrainSuitability {
  /** Fraction retained after applying slope and terrain shelter. */
  habitatWeight: number;
  /** Shelter score used to soften or strengthen existing forest clearings. */
  shelter: number;
}

const ALPINE_SHELTER_DIAGONAL = Math.cos(Math.PI / 4);
const ALPINE_SHELTER_DIRECTIONS = [
  [1, 0], [ALPINE_SHELTER_DIAGONAL, ALPINE_SHELTER_DIAGONAL], [0, 1],
  [-ALPINE_SHELTER_DIAGONAL, ALPINE_SHELTER_DIAGONAL], [-1, 0],
  [-ALPINE_SHELTER_DIAGONAL, -ALPINE_SHELTER_DIAGONAL], [0, -1],
  [ALPINE_SHELTER_DIAGONAL, -ALPINE_SHELTER_DIAGONAL],
] as const;
const ALPINE_SHELTER_RADII_METERS = [150, 450] as const;

/**
 * Estimate rootable, sheltered terrain from the DEM at the tree's ground
 * position. The two physical sampling scales distinguish small benches from
 * broader ridges and hollows without allocating another terrain raster.
 */
export function sampleAlpineForestTerrainSuitability(
  dem: VegetationPlacementTerrain,
  x: number,
  y: number,
): AlpineForestTerrainSuitability {
  if (x < 0 || y < 0 || x >= dem.width || y >= dem.height) {
    return { habitatWeight: 0, shelter: 0.5 };
  }
  const centerX = Math.max(0, Math.min(dem.width - 1, Math.round(x)));
  const centerY = Math.max(0, Math.min(dem.height - 1, Math.round(y)));
  const centerIndex = centerY * dem.width + centerX;
  const slope = dem.slopeDeg?.[centerIndex];
  const slopeWeight = slope === undefined || !Number.isFinite(slope)
    ? 1
    : 1 - smoothStep(20, 50, slope);
  if (slopeWeight <= 0) return { habitatWeight: 0, shelter: 0.5 };

  // Local climate is a small habitat modifier: rainfall supports root-zone
  // moisture, while local runoff distinguishes wetter climates without using
  // accumulated catchment flow that would pull trees toward channels.
  const precipitation = dem.precipitationMmYr?.[centerIndex];
  const runoff = dem.runoffDepthMmYr?.[centerIndex];
  const hasPrecipitation = precipitation !== undefined && Number.isFinite(precipitation);
  const hasRunoff = runoff !== undefined && Number.isFinite(runoff);
  const moistureSignalCount = Number(hasPrecipitation) + Number(hasRunoff);
  const moistureSignalSum =
    (hasPrecipitation ? clamp01((precipitation! - 350) / 1450) : 0) +
    (hasRunoff ? clamp01(runoff! / 1000) : 0);
  const moistureWeight = moistureSignalCount > 0
    ? 0.84 + 0.16 * moistureSignalSum / moistureSignalCount
    : 1;
  const baseHabitatWeight = slopeWeight * moistureWeight;

  const elevation = dem.elevation;
  const dxMeters = dem.dxMeters;
  const dyMeters = dem.dyMeters;
  if (
    !elevation || dxMeters === undefined || dyMeters === undefined ||
    !Number.isFinite(dxMeters) || !Number.isFinite(dyMeters) ||
    dxMeters <= 0 || dyMeters <= 0
  ) {
    return { habitatWeight: baseHabitatWeight, shelter: 0.5 };
  }

  const centerElevation = elevation[centerIndex];
  let exposure = 0;
  let hollow = 0;
  let measuredScales = 0;
  for (const radiusMeters of ALPINE_SHELTER_RADII_METERS) {
    let neighbourElevation = 0;
    let neighbourCount = 0;
    for (const [directionX, directionY] of ALPINE_SHELTER_DIRECTIONS) {
      const sampleX = x + directionX * radiusMeters / dxMeters;
      const sampleY = y + directionY * radiusMeters / dyMeters;
      if (
        sampleX < 0 || sampleY < 0 ||
        sampleX >= dem.width || sampleY >= dem.height ||
        isWaterAt(dem, sampleX, sampleY)
      ) continue;
      const sampleIndex =
        Math.max(0, Math.min(dem.height - 1, Math.round(sampleY))) * dem.width +
        Math.max(0, Math.min(dem.width - 1, Math.round(sampleX)));
      neighbourElevation += elevation[sampleIndex];
      neighbourCount++;
    }
    if (neighbourCount < 4) continue;
    const relativeRelief =
      (centerElevation - neighbourElevation / neighbourCount) / radiusMeters;
    exposure += smoothStep(0.015, 0.1, relativeRelief);
    hollow += smoothStep(0.015, 0.1, -relativeRelief);
    measuredScales++;
  }

  if (measuredScales === 0) {
    return { habitatWeight: baseHabitatWeight, shelter: 0.5 };
  }
  exposure /= measuredScales;
  hollow /= measuredScales;
  const shelter = clamp01(0.5 + (hollow - exposure) * 0.5);
  // Neutral slopes keep their density. Hollow shelter modestly improves
  // retention while clearly exposed crests lose most candidates.
  const terrainWeight = clamp01(1 - exposure * 0.72 + hollow * 0.12);
  return { habitatWeight: baseHabitatWeight * terrainWeight, shelter };
}

interface VegetationSpatialBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface VegetationBoundsIndex {
  query(bounds: VegetationSpatialBounds): number[];
}

interface VegetationGeometryTileIndex {
  paths: VegetationBoundsIndex;
  motifs: VegetationBoundsIndex;
  rasterProps: VegetationBoundsIndex;
  maxPathWidth: number;
  maxMotifSize: number;
  maxRasterSupport: number;
  assetsByKey: Map<string, VegetationRasterPropAsset>;
}

const VEGETATION_TILE_INDEX_CELL_SIZE = 128;
const EMPTY_VEGETATION_RASTER_ASSETS: readonly VegetationRasterPropAsset[] = [];
const vegetationGeometryTileIndexes = new WeakMap<
  VegetationGeometry,
  WeakMap<readonly VegetationRasterPropAsset[], VegetationGeometryTileIndex>
>();

/** Build an immutable uniform-grid lookup while retaining source-list indexes. */
function createVegetationBoundsIndex(
  count: number,
  width: number,
  height: number,
  boundsAt: (index: number) => VegetationSpatialBounds,
): VegetationBoundsIndex {
  const cellSize = VEGETATION_TILE_INDEX_CELL_SIZE;
  const columns = Math.max(1, Math.ceil(Math.max(1, width) / cellSize)) + 2;
  const rows = Math.max(1, Math.ceil(Math.max(1, height) / cellSize)) + 2;
  const buckets = new Map<number, number[]>();
  const overflow: number[] = [];
  const cellX = (x: number) => Math.max(0, Math.min(columns - 1, Math.floor(x / cellSize) + 1));
  const cellY = (y: number) => Math.max(0, Math.min(rows - 1, Math.floor(y / cellSize) + 1));

  for (let index = 0; index < count; index++) {
    const bounds = boundsAt(index);
    if (
      !Number.isFinite(bounds.minX) ||
      !Number.isFinite(bounds.minY) ||
      !Number.isFinite(bounds.maxX) ||
      !Number.isFinite(bounds.maxY)
    ) continue;
    const firstX = cellX(bounds.minX);
    const lastX = cellX(bounds.maxX);
    const firstY = cellY(bounds.minY);
    const lastY = cellY(bounds.maxY);
    if ((lastX - firstX + 1) * (lastY - firstY + 1) > 16) {
      overflow.push(index);
      continue;
    }
    for (let y = firstY; y <= lastY; y++) {
      for (let x = firstX; x <= lastX; x++) {
        const key = y * columns + x;
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, bucket = []);
        bucket.push(index);
      }
    }
  }

  return {
    query(bounds): number[] {
      const firstX = cellX(bounds.minX);
      const lastX = cellX(bounds.maxX);
      const firstY = cellY(bounds.minY);
      const lastY = cellY(bounds.maxY);
      const matches = new Set<number>(overflow);
      for (let y = firstY; y <= lastY; y++) {
        for (let x = firstX; x <= lastX; x++) {
          for (const index of buckets.get(y * columns + x) ?? []) matches.add(index);
        }
      }
      return [...matches].sort((a, b) => a - b);
    },
  };
}

function pointBounds(x: number, y: number, radius = 0): VegetationSpatialBounds {
  return {
    minX: x - radius,
    minY: y - radius,
    maxX: x + radius,
    maxY: y + radius,
  };
}

function getVegetationGeometryTileIndex(
  geometry: VegetationGeometry,
  rasterPropAssets: readonly VegetationRasterPropAsset[],
): VegetationGeometryTileIndex {
  let assetIndexes = vegetationGeometryTileIndexes.get(geometry);
  if (!assetIndexes) {
    assetIndexes = new WeakMap();
    vegetationGeometryTileIndexes.set(geometry, assetIndexes);
  }
  const cached = assetIndexes.get(rasterPropAssets);
  if (cached) return cached;

  const assetsByKey = new Map<string, VegetationRasterPropAsset>();
  for (const asset of rasterPropAssets) {
    if (!assetsByKey.has(asset.key)) assetsByKey.set(asset.key, asset);
  }
  const pathBounds: VegetationSpatialBounds[] = [];
  let maxPathWidth = 0;
  for (const path of geometry.paths) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of path.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    pathBounds.push({ minX, minY, maxX, maxY });
    maxPathWidth = Math.max(maxPathWidth, path.width);
  }
  let maxMotifSize = 0;
  for (const motif of geometry.motifs) maxMotifSize = Math.max(maxMotifSize, motif.size);
  let maxRasterSupport = 0;
  for (const prop of geometry.rasterProps ?? []) {
    const asset = assetsByKey.get(prop.assetKey);
    if (!asset) {
      maxRasterSupport = Math.max(maxRasterSupport, prop.cellSize * 2.5 * 2 + prop.cellSize * 3);
      continue;
    }
    const useRenderedEnvelope = isForestCanvasProp(asset);
    const widthCells = useRenderedEnvelope
      ? asset.renderWidthCells ?? asset.footprintWidthCells
      : asset.footprintWidthCells;
    const heightCells = useRenderedEnvelope
      ? asset.renderHeightCells ?? asset.footprintHeightCells
      : asset.footprintHeightCells;
    const width = Math.max(0.5, prop.cellSize * widthCells);
    const height = Math.max(0.5, prop.cellSize * heightCells);
    const anchorX = useRenderedEnvelope ? asset.renderAnchorX ?? asset.anchorX : asset.anchorX;
    const anchorY = useRenderedEnvelope ? asset.renderAnchorY ?? asset.anchorY : asset.anchorY;
    const extentX = width * Math.max(Math.abs(anchorX), Math.abs(1 - anchorX));
    const extentY = height * Math.max(Math.abs(anchorY), Math.abs(1 - anchorY));
    const brushSupport = useRenderedEnvelope ? Math.max(3, prop.cellSize * 3) : 3;
    maxRasterSupport = Math.max(
      maxRasterSupport,
      Math.hypot(extentX, extentY) + brushSupport,
    );
  }

  const index: VegetationGeometryTileIndex = {
    paths: createVegetationBoundsIndex(
      pathBounds.length,
      geometry.width,
      geometry.height,
      item => pathBounds[item],
    ),
    motifs: createVegetationBoundsIndex(
      geometry.motifs.length,
      geometry.width,
      geometry.height,
      item => pointBounds(geometry.motifs[item].x, geometry.motifs[item].y),
    ),
    rasterProps: createVegetationBoundsIndex(
      geometry.rasterProps?.length ?? 0,
      geometry.width,
      geometry.height,
      item => pointBounds(geometry.rasterProps![item].x, geometry.rasterProps![item].y),
    ),
    maxPathWidth,
    maxMotifSize,
    maxRasterSupport,
    assetsByKey,
  };
  assetIndexes.set(rasterPropAssets, index);
  return index;
}

export function mapVegetationGeometryToTile(
  geometry: VegetationGeometry,
  outputWidth: number,
  outputHeight: number,
  tileX: number,
  tileY: number,
  tileWidth: number,
  tileHeight: number,
  rasterPropAssets: readonly VegetationRasterPropAsset[] = EMPTY_VEGETATION_RASTER_ASSETS,
): VegetationGeometry {
  const scaleX = (outputWidth - 1) / Math.max(1, geometry.width - 1);
  const scaleY = (outputHeight - 1) / Math.max(1, geometry.height - 1);
  const scale = Math.min(scaleX, scaleY);
  const index = getVegetationGeometryTileIndex(geometry, rasterPropAssets);
  const canQuerySpatially = scaleX > 0 && scaleY > 0;
  const tileSourceBounds = canQuerySpatially
    ? {
        minX: tileX / scaleX,
        minY: tileY / scaleY,
        maxX: (tileX + tileWidth) / scaleX,
        maxY: (tileY + tileHeight) / scaleY,
      }
    : undefined;
  const queryIndex = (
    spatialIndex: VegetationBoundsIndex,
    margin: number,
    fallbackCount: number,
  ): number[] => tileSourceBounds
    ? spatialIndex.query({
        minX: tileSourceBounds.minX - margin,
        minY: tileSourceBounds.minY - margin,
        maxX: tileSourceBounds.maxX + margin,
        maxY: tileSourceBounds.maxY + margin,
      })
    : Array.from({ length: fallbackCount }, (_, item) => item);
  const minScale = Math.max(1e-9, Math.min(scaleX, scaleY));
  const pathIndexes = queryIndex(index.paths, index.maxPathWidth + 3 / minScale, geometry.paths.length);
  const motifIndexes = queryIndex(index.motifs, index.maxMotifSize, geometry.motifs.length);
  const rasterPropIndexes = queryIndex(
    index.rasterProps,
    index.maxRasterSupport + 3 / minScale,
    geometry.rasterProps?.length ?? 0,
  );
  const paths: VegetationStrokePath[] = [];
  for (const pathIndex of pathIndexes) {
    const path = geometry.paths[pathIndex];
    const points = path.points.map((point) => ({
      x: point.x * scaleX - tileX,
      y: point.y * scaleY - tileY,
    }));
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    if (
      boundsIntersect(
        minX,
        minY,
        maxX,
        maxY,
        tileWidth,
        tileHeight,
        path.width * scale + 3,
      )
    ) {
      paths.push({
        ...path,
        width: path.width * scale,
        dashPhase: path.dashPhase * scale,
        points,
      });
    }
  }
  const motifs = motifIndexes
    .map((index) => geometry.motifs[index])
    .map((motif) => ({
      ...motif,
      x: motif.x * scaleX - tileX,
      y: motif.y * scaleY - tileY,
      size: motif.size * scale,
    }))
    .filter((motif) =>
      boundsIntersect(
        motif.x,
        motif.y,
        motif.x,
        motif.y,
        tileWidth,
        tileHeight,
        motif.size,
      ),
    );
  const rasterProps = rasterPropIndexes
    .map((index) => geometry.rasterProps![index])
    .map((prop) => ({
      ...prop,
      x: prop.x * scaleX - tileX,
      y: prop.y * scaleY - tileY,
      cellSize: prop.cellSize * scale,
    }))
    .filter((prop) => {
      const asset = index.assetsByKey.get(prop.assetKey);
      const bounds = asset
        ? isForestCanvasProp(asset)
          ? rasterPropRenderBounds(prop, asset)
          : rasterPropFootprintBounds(prop, asset)
        : {
            minX: prop.x - prop.cellSize * 2.5,
            minY: prop.y - prop.cellSize * 2.5,
            maxX: prop.x + prop.cellSize * 2.5,
            maxY: prop.y + prop.cellSize * 2.5,
          };
      return boundsIntersect(
        bounds.minX,
        bounds.minY,
        bounds.maxX,
        bounds.maxY,
        tileWidth,
        tileHeight,
        asset && isForestCanvasProp(asset)
          ? Math.max(3, prop.cellSize * 3)
          : 3,
      );
    });
  return {
    width: tileWidth,
    height: tileHeight,
    paths,
    motifs,
    rasterProps,
    stands: geometry.stands?.map((stand) => ({
      group: stand.group,
      geometry: mapForestStandGeometry(stand.geometry, scaleX, scaleY, tileX, tileY, tileWidth, tileHeight),
    })),
  };
}

interface TransformedMotifPoint extends VegetationStrokePoint {
  pathDistance?: number;
}

interface CharcoalRunIntersection {
  run: CharcoalStrokeRun;
  segmentT0: number;
  segmentT1: number;
}

function charcoalRunIntersections(
  startDistance: number,
  endDistance: number,
  runs: readonly CharcoalStrokeRun[],
): CharcoalRunIntersection[] {
  const delta = endDistance - startDistance;
  if (Math.abs(delta) < 1e-6) {
    const run = findCharcoalStrokeRunAtDistance(runs, startDistance);
    return run ? [{ run, segmentT0: 0, segmentT1: 1 }] : [];
  }

  const minimum = Math.min(startDistance, endDistance);
  const maximum = Math.max(startDistance, endDistance);
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (runs[middle].end <= minimum) low = middle + 1;
    else high = middle;
  }

  const intersections: CharcoalRunIntersection[] = [];
  for (let index = low; index < runs.length; index++) {
    const run = runs[index];
    if (run.start >= maximum) break;
    const overlapStart = Math.max(minimum, run.start);
    const overlapEnd = Math.min(maximum, run.end);
    if (overlapEnd <= overlapStart) continue;
    const firstT = (overlapStart - startDistance) / delta;
    const secondT = (overlapEnd - startDistance) / delta;
    intersections.push({
      run,
      segmentT0: Math.min(firstT, secondT),
      segmentT1: Math.max(firstT, secondT),
    });
  }
  return intersections;
}

function paintVectorCharcoalMotif(
  alpha: Uint8Array,
  clip: Uint8Array,
  width: number,
  height: number,
  motif: VegetationMotifPlacement,
  asset: VegetationMotifAsset,
  pathSampler: VegetationPathSampler | undefined,
  pathStrokeRuns: readonly CharcoalStrokeRun[] | undefined,
  options: ResolvedVegetationPatternOptions,
  thicknessScale = 1,
  flowStretch = true,
  batchedSegments?: BatchedInkSegment[],
  depthValue?: number,
): void {
  const vectorPaths = asset.vectorPaths;
  if (!vectorPaths || vectorPaths.length === 0) return;

  const curved =
    pathSampler !== undefined &&
    pathSampler.totalLength > 0 &&
    motif.pathT !== undefined;
  // Fit the SVG viewBox to the motif's nominal size on each local axis. The
  // flow assets use a 64x40 viewBox; using one width-based scale made every
  // curl only 62.5% as tall as intended.
  const flowScale =
    (motif.size / Math.max(1, asset.width)) *
    (curved || flowStretch ? Math.max(0.4, options.strokeLength) : 1);
  const normalScale = motif.size / Math.max(1, asset.height);
  const centreDistance = curved
    ? Math.max(
        0,
        Math.min(
          pathSampler.totalLength,
          motif.pathT! * pathSampler.totalLength,
        ),
      )
    : 0;
  const centrePathSample = curved
    ? sampleVegetationPathAtDistance(pathSampler, centreDistance)
    : undefined;
  const curveRotationOffset = centrePathSample
    ? motif.rotation - centrePathSample.rotation
    : 0;
  const coordinateStride =
    options.coordinateStride === 1 ? width : options.coordinateStride;
  const globalMotifX = Math.round(motif.x + options.coordinateOffsetX);
  const globalMotifY = Math.round(motif.y + options.coordinateOffsetY);
  const motifSeed =
    (Math.imul(globalMotifX, 374761393) ^
      Math.imul(globalMotifY, 668265263) ^
      (motif.pathKey ?? 0)) |
    0;
  // Water's interruption lengths are authored in output pixels. In tiled
  // export, patternScale carries the output upscale while
  // coordinatePatternScale retains the preview-authored value.
  const outputPixelScale = Math.max(
    0.25,
    options.patternScale / Math.max(0.5, options.coordinatePatternScale),
  );

  const transformPoint = (
    point: VegetationStrokePoint,
  ): TransformedMotifPoint => {
    const localX = (point.x - asset.width * 0.5) * flowScale;
    const localY = (asset.height * 0.5 - point.y) * normalScale;
    if (curved && pathSampler) {
      const pathDistance = Math.max(
        0,
        Math.min(pathSampler.totalLength, centreDistance + localX),
      );
      const pathPoint = sampleVegetationPathAtDistance(
        pathSampler,
        pathDistance,
      );
      const rotation = pathPoint.rotation + curveRotationOffset;
      const normalX = -Math.sin(rotation);
      const normalY = Math.cos(rotation);
      return {
        x: pathPoint.x + normalX * localY,
        y: pathPoint.y + normalY * localY,
        pathDistance,
      };
    }
    const cos = Math.cos(motif.rotation);
    const sin = Math.sin(motif.rotation);
    return {
      x: motif.x + localX * cos - localY * sin,
      y: motif.y + localX * sin + localY * cos,
    };
  };

  for (let pathIndex = 0; pathIndex < vectorPaths.length; pathIndex++) {
    const vectorPath = vectorPaths[pathIndex];
    const points = vectorPath.points;
    const transformedPoints = points.map(transformPoint);
    const cumulativeLengths = new Array<number>(points.length).fill(0);
    for (let pointIndex = 1; pointIndex < points.length; pointIndex++) {
      const previous = transformedPoints[pointIndex - 1];
      const point = transformedPoints[pointIndex];
      cumulativeLengths[pointIndex] =
        cumulativeLengths[pointIndex - 1] +
        Math.hypot(point.x - previous.x, point.y - previous.y);
    }
    const vectorPathLength =
      cumulativeLengths[cumulativeLengths.length - 1] ?? 0;
    if (vectorPathLength <= 0) continue;
    const localInterruption = curved
      ? undefined
      : createCharcoalInterruptionPattern(
          motifSeed + pathIndex * 1009,
          outputPixelScale,
          { breakProbability: options.lineInterruptionProbability },
    );
    const radius = Math.max(
      0.28,
      vectorPath.strokeWidth *
        Math.min(flowScale, normalScale) *
        options.strokeThickness *
        1.6 *
        thicknessScale,
    );
    for (let pointIndex = 1; pointIndex < points.length; pointIndex++) {
      const start = transformedPoints[pointIndex - 1];
      const end = transformedPoints[pointIndex];
      const segmentDx = end.x - start.x;
      const segmentDy = end.y - start.y;
      const segmentLength = Math.hypot(segmentDx, segmentDy);
      if (segmentLength < 1e-4) continue;
      const segmentStart = cumulativeLengths[pointIndex - 1];
      const segmentEnd = cumulativeLengths[pointIndex];
      const segmentVectorLength = segmentEnd - segmentStart;
      const drawSegment = (
        segmentT0: number,
        segmentT1: number,
        run?: CharcoalStrokeRun,
      ): void => {
        const clippedLength =
          segmentLength * Math.abs(segmentT1 - segmentT0);
        // The line rasterizer already evaluates distance, taper, and pressure
        // continuously along a segment. Curved flow art keeps the finer
        // subdivision because its frame changes per sample; standalone
        // wetland/foothill SVGs can use a longer span without changing their
        // silhouette, cutting the number of tiny stroke records substantially.
        const steps = Math.max(1, Math.ceil(
          clippedLength / (curved ? 0.7 : 1.6),
        ));
        const stepT = (segmentT1 - segmentT0) / steps;
        for (let step = 0; step < steps; step++) {
          const localT0 = segmentT0 + stepT * step;
          const localT1 = localT0 + stepT;
          const x0 = start.x + segmentDx * localT0;
          const y0 = start.y + segmentDy * localT0;
          const x1 = start.x + segmentDx * localT1;
          const y1 = start.y + segmentDy * localT1;
          const sourceT0 =
            (segmentStart + segmentVectorLength * localT0) / vectorPathLength;
          const sourceT1 =
            (segmentStart + segmentVectorLength * localT1) / vectorPathLength;
          let runPressure = 1;

          if (
            run &&
            start.pathDistance !== undefined &&
            end.pathDistance !== undefined
          ) {
            const runLength = Math.max(1e-6, run.end - run.start);
            const pathDistance0 =
              start.pathDistance +
              (end.pathDistance - start.pathDistance) * localT0;
            const pathDistance1 =
              start.pathDistance +
              (end.pathDistance - start.pathDistance) * localT1;
            const runT = clamp01(
              ((pathDistance0 + pathDistance1) * 0.5 - run.start) / runLength,
            );
            // Keep the SVG subpath's own start/end pressure inside
            // paintInkSegment, then multiply it by the pressure of the parent
            // charcoal run. Both M-created gaps and random gaps therefore get
            // tapered ends without collapsing a long straight SVG segment.
            runPressure = charcoalStrokePressureAt(runT, true, true);
          }

          const segment: BatchedInkSegment = {
            x0,
            y0,
            x1,
            y1,
            radius: radius * runPressure,
            seed: motifSeed + pathIndex * 1009 + pointIndex * 17 + step * 131,
            smoothing: 1.2,
            strokeT0: sourceT0,
            strokeT1: sourceT1,
            taperStart: true,
            taperEnd: true,
            coordinateOffsetX: options.coordinateOffsetX,
            coordinateOffsetY: options.coordinateOffsetY,
            coordinateStride,
            // Flow motifs are charcoal geometry, not translucent stamps.
            // Overall intensity remains controlled by strokeOpacity below.
            opacity: curved ? 1 : motif.opacity,
            drySkipProbability: 0,
            clipStartCap: true,
            clipEndCap: true,
            depth: depthValue,
          };
          if (batchedSegments) batchedSegments.push(segment);
          else {
            paintInkSegment(
              alpha,
              clip,
              width,
              height,
              segment.x0,
              segment.y0,
              segment.x1,
              segment.y1,
              segment.radius,
              segment.seed,
              segment.smoothing,
              segment.strokeT0,
              segment.strokeT1,
              true,
              true,
              segment.coordinateOffsetX,
              segment.coordinateOffsetY,
              segment.coordinateStride,
              segment.opacity,
              0,
              true,
              true,
            );
          }
        }
      };

      if (
        curved &&
        pathStrokeRuns &&
        start.pathDistance !== undefined &&
        end.pathDistance !== undefined
      ) {
        for (const intersection of charcoalRunIntersections(
          start.pathDistance,
          end.pathDistance,
          pathStrokeRuns,
        )) {
          drawSegment(
            intersection.segmentT0,
            intersection.segmentT1,
            intersection.run,
          );
        }
      } else if (
        !localInterruption ||
        isCharcoalInkActiveAtDistance(
          (segmentStart + segmentEnd) * 0.5,
          localInterruption,
        )
      ) {
        drawSegment(0, 1);
      }
    }
  }
}

/**
 * Paint one SVG motif as charcoal ink. Flow motifs are projected through the
 * parent path sampler; standalone props use the same pressure, taper, grain,
 * and thickness treatment without a path sampler.
 */
function paintCharcoalMotif(
  alpha: Uint8Array,
  clip: Uint8Array,
  width: number,
  height: number,
  motif: VegetationMotifPlacement,
  asset: VegetationMotifAsset,
  pathSampler: VegetationPathSampler | undefined,
  options: ResolvedVegetationPatternOptions,
  thicknessScale = 1,
  flowStretch = true,
): void {
  // Derive one uniform scale from the SVG's native dimensions. Stroke length
  // controls only how many fixed-size tiles occupy the flow span; it never
  // applies a second, horizontal-only stretch to the source artwork.
  const sourceMaxDimension = Math.max(1, asset.width, asset.height);
  const uniformScale = motif.size / sourceMaxDimension;
  const tileWidth = Math.max(1e-6, asset.width * uniformScale);
  const tileHeight = Math.max(1e-6, asset.height * uniformScale);
  const curved =
    pathSampler !== undefined &&
    pathSampler.totalLength > 0 &&
    motif.pathT !== undefined;
  const targetWidth =
    tileWidth *
    (curved || flowStretch ? Math.max(0.4, options.strokeLength) : 1);
  const centreDistance = curved
    ? Math.max(
        0,
        Math.min(
          pathSampler.totalLength,
          motif.pathT! * pathSampler.totalLength,
        ),
      )
    : 0;
  const centrePathSample = curved
    ? sampleVegetationPathAtDistance(pathSampler, centreDistance)
    : undefined;
  // Reuse the per-pixel path sample while rasterizing a curved bitmap motif.
  // The values are consumed immediately, so retaining one mutable record is
  // equivalent to the previous allocation-per-pixel behavior.
  const arcSample = curved
    ? ({ x: 0, y: 0, rotation: 0 } satisfies StrokeSample)
    : undefined;
  // Curved motifs can extend farther than their bitmap diagonal when the
  // parent path turns sharply. Include the full arc span in the search bound.
  const bound = Math.ceil(
    curved
      ? Math.hypot(targetWidth, tileHeight) * 0.7 + targetWidth * 0.24 + 2
      : Math.hypot(targetWidth, tileHeight) * 0.55 + 1,
  );
  const cos = Math.cos(motif.rotation);
  const sin = Math.sin(motif.rotation);
  const curveRotationOffset = centrePathSample
    ? motif.rotation - centrePathSample.rotation
    : 0;
  const coordinateStride =
    options.coordinateStride === 1 ? width : options.coordinateStride;
  const globalMotifX = Math.round(motif.x + options.coordinateOffsetX);
  const globalMotifY = Math.round(motif.y + options.coordinateOffsetY);
  const motifSeed =
    (Math.imul(globalMotifX, 374761393) ^
      Math.imul(globalMotifY, 668265263) ^
      (motif.pathKey ?? 0)) |
    0;
  const outputPixelScale = Math.max(
    0.25,
    options.patternScale / Math.max(0.5, options.coordinatePatternScale),
  );
  const interruption = createCharcoalInterruptionPattern(
    motifSeed,
    outputPixelScale,
    { breakProbability: options.lineInterruptionProbability },
  );
  const textureVariation = 0.6 / (1 + 0.75 * 0.8);

  // Standalone wetland/raster motifs use a fixed affine frame. Keep the
  // arithmetic and seeded sampling identical to the general loop, but move
  // the row-only rotation terms and global index base out of the inner pixel
  // loop. Curved flow motifs continue through the sampler below.
  if (!curved) {
    const minX = Math.max(0, Math.floor(motif.x - bound));
    const maxX = Math.min(width - 1, Math.ceil(motif.x + bound));
    const minY = Math.max(0, Math.floor(motif.y - bound));
    const maxY = Math.min(height - 1, Math.ceil(motif.y + bound));
    const halfTargetWidth = targetWidth * 0.5;
    for (let y = minY; y <= maxY; y++) {
      const rowOffset = y * width;
      const dy = y - motif.y;
      const rowLocalX = dy * sin;
      const rowLocalY = dy * cos;
      const globalRowBase =
        (y + options.coordinateOffsetY) * coordinateStride +
        options.coordinateOffsetX;
      for (let x = minX; x <= maxX; x++) {
        const index = rowOffset + x;
        if (clip[index] === 0) continue;
        const dx = x - motif.x;
        const localX = dx * cos + rowLocalX;
        const localY = -dx * sin + rowLocalY;
        if (localX < -halfTargetWidth || localX > halfTargetWidth) continue;
        const v = localY / tileHeight + 0.5;
        if (v < 0 || v > 1) continue;
        if (
          interruption &&
          !isCharcoalInkActiveAtDistance(
            localX + halfTargetWidth,
            interruption,
          )
        ) {
          continue;
        }
        const u = (((localX / tileWidth + 0.5) % 1) + 1) % 1;
        const sourceX = Math.max(
          0,
          Math.min(asset.width - 1, Math.round(u * (asset.width - 1))),
        );
        const sourceY = Math.max(
          0,
          Math.min(asset.height - 1, Math.round((1 - v) * (asset.height - 1))),
        );
        const sourceAlpha = sampleMotifSourceAlpha(
          asset,
          sourceX,
          sourceY,
          thicknessScale,
        );
        if (sourceAlpha <= 0) continue;
        const pressure = charcoalStrokePressureFast(u, true, true);
        const globalIndex = globalRowBase + x;
        const paperTooth =
          (hash01(globalIndex * 17 + motifSeed, 541) - 0.5) * 0.35 +
          (hash01(globalIndex * 31, 733) - 0.5) * 0.2;
        const localInk =
          1 -
          textureVariation * 0.35 +
          hash01(globalIndex, motifSeed + 1) * textureVariation +
          paperTooth * 0.3;
        const inkTexture = 0.78 + 0.22 * hash01(globalIndex, motifSeed + 991);
        const coverage = clamp01(
          sourceAlpha * motif.opacity * pressure * localInk * inkTexture,
        );
        alpha[index] = Math.max(alpha[index], Math.round(coverage * 255));
      }
    }
    return;
  }

  for (
    let y = Math.max(0, Math.floor(motif.y - bound));
    y <= Math.min(height - 1, Math.ceil(motif.y + bound));
    y++
  ) {
    for (
      let x = Math.max(0, Math.floor(motif.x - bound));
      x <= Math.min(width - 1, Math.ceil(motif.x + bound));
      x++
    ) {
      const index = y * width + x;
      if (clip[index] === 0) continue;
      const dx = x - motif.x;
      const dy = y - motif.y;
      let localX = dx * cos + dy * sin;
      let localY = -dx * sin + dy * cos;
      if (curved && centrePathSample && arcSample) {
        // Treat the SVG's local X axis as arc length along the streamline.
        // The Y axis remains perpendicular to that streamline at each arc
        // sample, which bends horizontal SVG strokes with the flow.
        const arcDistance = centreDistance + localX;
        sampleVegetationPathAtDistanceInto(pathSampler!, arcDistance, arcSample);
        const frameRotation = arcSample.rotation + curveRotationOffset;
        const frameCos = Math.cos(frameRotation);
        const frameSin = Math.sin(frameRotation);
        const normalX = -frameSin;
        const normalY = frameCos;
        const expectedX = arcSample.x + normalX * localY;
        const expectedY = arcSample.y + normalY * localY;
        // Inverse projection onto a curved strip is approximate. Rejecting
        // pixels far from the reconstructed point prevents a sharp turn from
        // smearing the motif outside its parent flow.
        if (Math.hypot(x - expectedX, y - expectedY) > 1.65) continue;
        localX = arcDistance - centreDistance;
        localY = (x - arcSample.x) * normalX + (y - arcSample.y) * normalY;
      }
      // Repeat the source SVG around the placement centre. The half-tile phase
      // keeps a complete tile centred on the sampled streamline, while the
      // target-width bounds allow fractional stroke lengths to crop cleanly.
      const u = (((localX / tileWidth + 0.5) % 1) + 1) % 1;
      const v = localY / tileHeight + 0.5;
      if (Math.abs(localX) > targetWidth * 0.5 || v < 0 || v > 1) continue;
      if (
        interruption &&
        !isCharcoalInkActiveAtDistance(localX + targetWidth * 0.5, interruption)
      ) {
        continue;
      }
      const sourceX = Math.max(
        0,
        Math.min(asset.width - 1, Math.round(u * (asset.width - 1))),
      );
      // Flow SVGs are authored with their local Y axis pointing upward,
      // while raster image rows increase downward. Mirror that axis when
      // sampling every flow-following motif so each SVG keeps its intended
      // orientation after it is aligned to a streamline.
      const sourceY = Math.max(
        0,
        Math.min(asset.height - 1, Math.round((1 - v) * (asset.height - 1))),
      );
      const sourceAlpha = sampleMotifSourceAlpha(
        asset,
        sourceX,
        sourceY,
        thicknessScale,
      );
      if (sourceAlpha <= 0) continue;

      // Apply the same brush pressure and paper-tooth treatment used by the
      // charcoal renderer to every SVG silhouette. Using the motif's local X
      // axis makes both straight and flow-bent artwork narrow at its exposed
      // ends without changing the underlying SVG shape.
      // The motif raster loop evaluates taper pressure once per candidate
      // pixel. Use the same deterministic LUT as segment rasterization; the
      // interpolation error is below 0.00002 and avoids a Math.pow call for
      // every pixel of every wetland prop.
      const pressure = charcoalStrokePressureFast(u, true, true);
      const globalIndex =
        (y + options.coordinateOffsetY) * coordinateStride +
        x +
        options.coordinateOffsetX;
      const paperTooth =
        (hash01(globalIndex * 17 + motifSeed, 541) - 0.5) * 0.35 +
        (hash01(globalIndex * 31, 733) - 0.5) * 0.2;
      const localInk =
        1 -
        textureVariation * 0.35 +
        hash01(globalIndex, motifSeed + 1) * textureVariation +
        paperTooth * 0.3;
      const inkTexture = 0.78 + 0.22 * hash01(globalIndex, motifSeed + 991);
      const coverage = clamp01(
        sourceAlpha * motif.opacity * pressure * localInk * inkTexture,
      );
      alpha[index] = Math.max(alpha[index], Math.round(coverage * 255));
    }
  }
}

/**
 * Adjust the stroke weight of a rasterized SVG without changing its overall
 * placement. The source SVGs are line art, so a small source-space dilation
 * produces a more useful thickness change than scaling the whole prop.
 */
function sampleMotifSourceAlpha(
  asset: VegetationMotifAsset,
  sourceX: number,
  sourceY: number,
  thicknessScale: number,
): number {
  const centreAlpha =
    asset.data[(sourceY * asset.width + sourceX) * 4 + 3] / 255;
  if (thicknessScale === 1) return centreAlpha;
  if (thicknessScale < 1) return centreAlpha * thicknessScale;

  const radius = Math.min(6, (thicknessScale - 1) * 2.2);
  const sampleRadius = Math.ceil(radius);
  let alpha = centreAlpha;
  for (let offsetY = -sampleRadius; offsetY <= sampleRadius; offsetY++) {
    for (let offsetX = -sampleRadius; offsetX <= sampleRadius; offsetX++) {
      if (offsetX * offsetX + offsetY * offsetY > radius * radius) continue;
      const x = Math.max(0, Math.min(asset.width - 1, sourceX + offsetX));
      const y = Math.max(0, Math.min(asset.height - 1, sourceY + offsetY));
      alpha = Math.max(alpha, asset.data[(y * asset.width + x) * 4 + 3] / 255);
    }
  }
  return alpha;
}

function sampleAlphaNearest(
  alpha: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= width || iy >= height) return 0;
  return alpha[iy * width + ix] / 255;
}

// These taps are shared by every motif-shadow pixel. Keeping them immutable
// avoids allocating a nested array for each sample while preserving the
// original order and weights.
const ALPHA_FOOTPRINT_OFFSETS = [
  [0, 0, 1],
  [1, 0, 0.78],
  [-1, 0, 0.78],
  [0, 1, 0.78],
  [0, -1, 0.78],
  [0.72, 0.72, 0.58],
  [-0.72, 0.72, 0.58],
  [0.72, -0.72, 0.58],
  [-0.72, -0.72, 0.58],
] as const;

const RASTER_PROP_SOFT_ALPHA_OFFSETS = [
  [0, 0, 1],
  [1, 0, 0.86],
  [-1, 0, 0.86],
  [0, 1, 0.86],
  [0, -1, 0.86],
  [0.7, 0.7, 0.64],
  [-0.7, 0.7, 0.64],
  [0.7, -0.7, 0.64],
  [-0.7, -0.7, 0.64],
] as const;

function sampleAlphaFootprint(
  alpha: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): number {
  // A small max-filter gives the grain a halo around thin SVG strokes without
  // turning the shadow into a second, recognisable copy of the SVG.
  let strongest = 0;
  for (const [offsetX, offsetY, weight] of ALPHA_FOOTPRINT_OFFSETS) {
    strongest = Math.max(
      strongest,
      sampleAlphaNearest(
        alpha,
        width,
        height,
        x + offsetX * radius,
        y + offsetY * radius,
      ) * weight,
    );
  }
  return strongest;
}

export interface VegetationRasterPropShadowMetrics {
  offset: number;
  softness: number;
}

/** Resolve a raster prop's shadow size from authored map-cell height. The
 * divisor keeps the existing preview shadow controls in their familiar pixel
 * range at the default 16-pixel cell size while preserving physical ratios. */
export function rasterPropShadowMetrics(
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
  motifShadowDistance: number,
  motifShadowSoftness: number,
): VegetationRasterPropShadowMetrics {
  const cellScale = Math.max(0, placement.cellSize) / 16;
  const height = Math.max(0, asset.heightCells);
  return {
    offset: Math.max(0, motifShadowDistance) * cellScale * height,
    softness: Math.max(
      0,
      motifShadowSoftness * cellScale * Math.sqrt(height),
    ),
  };
}

// Raster prop shadows are temporarily disabled while the authored prop
// treatment is being calibrated. Keep the toggle local so regular vegetation
// motif shadows remain controlled by motifShadowStrength.
const RASTER_PROP_SHADOWS_ENABLED = false;

function sampleRasterPropAlphaAt(
  asset: VegetationRasterPropAsset,
  placement: VegetationRasterPropPlacement,
  x: number,
  y: number,
): number {
  const envelope = rasterPropRenderEnvelope(placement, asset);
  const dx = x - placement.x;
  const dy = y - placement.y;
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  const sourceX = Math.floor(
    ((localX / envelope.width + envelope.anchorX) * asset.width),
  );
  const sourceY = Math.floor(
    ((localY / envelope.height + envelope.anchorY) * asset.height),
  );
  if (
    sourceX < 0 ||
    sourceX >= asset.width ||
    sourceY < 0 ||
    sourceY >= asset.height
  ) {
    return 0;
  }
  return asset.data[(sourceY * asset.width + sourceX) * 4 + 3] / 255;
}

function sampleRasterPropSoftAlpha(
  asset: VegetationRasterPropAsset,
  placement: VegetationRasterPropPlacement,
  x: number,
  y: number,
  radius: number,
): number {
  if (radius <= 0.01) return sampleRasterPropAlphaAt(asset, placement, x, y);
  const offsets = RASTER_PROP_SOFT_ALPHA_OFFSETS;
  let strongest = 0;
  for (const [offsetX, offsetY, weight] of offsets) {
    strongest = Math.max(
      strongest,
      sampleRasterPropAlphaAt(
        asset,
        placement,
        x + offsetX * radius,
        y + offsetY * radius,
      ) * weight,
    );
  }
  return strongest;
}

function compositeRasterPropSourcePixel(
  pixels: Uint8ClampedArray,
  destinationIndex: number,
  asset: VegetationRasterPropAsset,
  sourceIndex: number,
  opacity: number,
): void {
  const sourceAlpha = (asset.data[sourceIndex + 3] / 255) * opacity;
  if (sourceAlpha <= 0) return;
  const inverseAlpha = 1 - sourceAlpha;
  pixels[destinationIndex] = Math.round(
    asset.data[sourceIndex] * sourceAlpha + pixels[destinationIndex] * inverseAlpha,
  );
  pixels[destinationIndex + 1] = Math.round(
    asset.data[sourceIndex + 1] * sourceAlpha + pixels[destinationIndex + 1] * inverseAlpha,
  );
  pixels[destinationIndex + 2] = Math.round(
    asset.data[sourceIndex + 2] * sourceAlpha + pixels[destinationIndex + 2] * inverseAlpha,
  );
  pixels[destinationIndex + 3] = Math.round(
    (sourceAlpha + pixels[destinationIndex + 3] / 255 * inverseAlpha) * 255,
  );
}

interface RasterPropOutlineCoverage {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  alpha: Uint8Array;
  depth: number;
  visualDepth: number;
}

function createRasterPropOutlineCoverage(
  width: number,
  height: number,
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
  depth: number,
): RasterPropOutlineCoverage | undefined {
  const bounds = rasterPropRenderBounds(placement, asset);
  const minX = Math.max(0, Math.floor(bounds.minX) - 1);
  const maxX = Math.min(width - 1, Math.ceil(bounds.maxX) + 1);
  const minY = Math.max(0, Math.floor(bounds.minY) - 1);
  const maxY = Math.min(height - 1, Math.ceil(bounds.maxY) + 1);
  if (maxX < minX || maxY < minY) return undefined;
  const coverageWidth = maxX - minX + 1;
  const coverageHeight = maxY - minY + 1;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: coverageWidth,
    height: coverageHeight,
    alpha: new Uint8Array(coverageWidth * coverageHeight),
    depth,
    visualDepth: bounds.maxY,
  };
}

function updateRasterPropOutlineCoverage(
  coverage: RasterPropOutlineCoverage,
  x: number,
  y: number,
  value: number,
): void {
  if (
    x < coverage.minX ||
    x > coverage.maxX ||
    y < coverage.minY ||
    y > coverage.maxY
  ) {
    return;
  }
  const index = (y - coverage.minY) * coverage.width + (x - coverage.minX);
  coverage.alpha[index] = Math.max(coverage.alpha[index], value);
}

/** Paint one outer contour around one transparent prop's local alpha. */
function paintRasterPropAlphaDilationOutline(
  target: Uint8Array,
  coverage: RasterPropOutlineCoverage,
  clip: Uint8Array,
  depth: Uint32Array,
  width: number,
  height: number,
  depthBuffer?: Float32Array,
  depthValue = 0,
): void {
  for (let localY = 0; localY < coverage.height; localY++) {
    const y = coverage.minY + localY;
    if (y < 0 || y >= height) continue;
    for (let localX = 0; localX < coverage.width; localX++) {
      const x = coverage.minX + localX;
      if (x < 0 || x >= width) continue;
      const index = y * width + x;
      const coverageIndex = localY * coverage.width + localX;
      if (
        clip[index] === 0 ||
        coverage.alpha[coverageIndex] > 0 ||
        depth[index] > coverage.depth
      ) {
        continue;
      }
      let strongest = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const sampleY = localY + offsetY;
        if (sampleY < 0 || sampleY >= coverage.height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const sampleX = localX + offsetX;
          if (sampleX < 0 || sampleX >= coverage.width) continue;
          strongest = Math.max(
            strongest,
            coverage.alpha[sampleY * coverage.width + sampleX],
          );
        }
      }
      if (strongest > 0) {
        target[index] = Math.max(target[index], Math.round(strongest * 0.86));
        if (depthBuffer && Number.isFinite(depthValue)) {
          depthBuffer[index] = Math.max(depthBuffer[index], depthValue);
        }
      }
    }
  }
}

function rasterPropToVectorMotif(
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
): VegetationMotifPlacement {
  // Mountain SVGs use square viewBoxes and square authored footprints. Keep
  // the smallest footprint axis as the nominal motif size so a future
  // non-square grid prop still stays inside its placement envelope.
  const footprintWidth = placement.cellSize * asset.footprintWidthCells;
  const footprintHeight = placement.cellSize * asset.footprintHeightCells;
  return {
    x: placement.x,
    y: placement.y,
    rotation: placement.rotation,
    size: Math.min(footprintWidth, footprintHeight),
    opacity: placement.opacity,
    biomeId: placement.biomeId,
    assetKey: placement.assetKey,
  };
}

interface RasterPropVectorVariation {
  noise: SimplexNoise;
  noiseOffsetX: number;
  noiseOffsetY: number;
  displacementSource: number;
  scaleX: number;
  scaleY: number;
  lean: number;
}

function createRasterPropVectorVariation(
  placement: VegetationRasterPropPlacement,
  options: ResolvedVegetationPatternOptions,
): RasterPropVectorVariation {
  const placementSeed =
    (Math.imul(Math.round(placement.x), 374761393) ^
      Math.imul(Math.round(placement.y), 668265263) ^
      options.seed ^
      0x6d2b79f5) |
    0;
  return {
    noise: new SimplexNoise(placementSeed),
    noiseOffsetX: hash01(placementSeed, 701) * 100,
    noiseOffsetY: hash01(placementSeed, 709) * 100,
    // Keep the displacement in the same restrained range as the proposed
    // feTurbulence/feDisplacementMap treatment: broad, readable bends rather
    // than noisy pixel-level damage.
    displacementSource: 4 + hash01(placementSeed, 719) * 4,
    scaleX: 0.94 + hash01(placementSeed, 727) * 0.12,
    scaleY: 0.94 + hash01(placementSeed, 733) * 0.12,
    lean: (hash01(placementSeed, 739) - 0.5) * 0.07,
  };
}

function transformRasterPropVectorPoint(
  point: VegetationStrokePoint,
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
  envelope: { width: number; height: number; anchorX: number; anchorY: number },
  variation: RasterPropVectorVariation,
): VegetationStrokePoint {
  const noiseX = variation.noise.fbm(
    point.x * 0.025 + variation.noiseOffsetX,
    point.y * 0.025 + variation.noiseOffsetY,
    1,
    2,
    0.5,
  );
  const noiseY = variation.noise.fbm(
    point.x * 0.025 + variation.noiseOffsetX + 31.7,
    point.y * 0.025 + variation.noiseOffsetY - 17.3,
    1,
    2,
    0.5,
  );
  const sourceX = point.x + noiseX * variation.displacementSource;
  const sourceY = point.y + noiseY * variation.displacementSource;
  const localY =
    (sourceY / Math.max(1, asset.height) - envelope.anchorY) *
    envelope.height *
    variation.scaleY;
  const localX =
    (sourceX / Math.max(1, asset.width) - envelope.anchorX) *
      envelope.width *
      variation.scaleX +
    localY * variation.lean;
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  return {
    x: placement.x + localX * cos - localY * sin,
    y: placement.y + localX * sin + localY * cos,
  };
}

function compositeRasterPropColor(
  pixels: Uint8ClampedArray,
  destinationIndex: number,
  color: readonly [number, number, number],
  opacity: number,
): void {
  const sourceAlpha = clamp01(opacity);
  if (sourceAlpha <= 0) return;
  const inverseAlpha = 1 - sourceAlpha;
  pixels[destinationIndex] = Math.round(
    color[0] * sourceAlpha + pixels[destinationIndex] * inverseAlpha,
  );
  pixels[destinationIndex + 1] = Math.round(
    color[1] * sourceAlpha + pixels[destinationIndex + 1] * inverseAlpha,
  );
  pixels[destinationIndex + 2] = Math.round(
    color[2] * sourceAlpha + pixels[destinationIndex + 2] * inverseAlpha,
  );
  pixels[destinationIndex + 3] = Math.round(
    (sourceAlpha + pixels[destinationIndex + 3] / 255 * inverseAlpha) * 255,
  );
}


function paintRasterPropVectorFill(
  pixels: Uint8ClampedArray,
  coverage: RasterPropOutlineCoverage | undefined,
  clip: Uint8Array,
  width: number,
  height: number,
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
  options: ResolvedVegetationPatternOptions,
  propDepth?: Uint32Array,
  propDepthValue = 0,
  depthBuffer?: Float32Array,
  depthValue = 0,
): boolean {
  const vectorPaths = asset.vectorPaths;
  if (!vectorPaths || vectorPaths.length === 0) return false;
  const envelope = rasterPropRenderEnvelope(placement, asset);
  const variation = createRasterPropVectorVariation(placement, options);
  let painted = false;
  for (const vectorPath of vectorPaths) {
    if (!vectorPath.closed || !vectorPath.fillColor || vectorPath.points.length < 3) {
      continue;
    }
    const points = vectorPath.points.map((point) =>
      transformRasterPropVectorPoint(point, placement, asset, envelope, variation),
    );
    const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((point) => point.y))));
    for (let y = minY; y <= maxY; y++) {
      const scanY = y + 0.5;
      const intersections: number[] = [];
      for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex++) {
        const start = points[pointIndex];
        const end = points[pointIndex + 1];
        if ((start.y > scanY) === (end.y > scanY)) continue;
        const fraction = (scanY - start.y) / (end.y - start.y);
        intersections.push(start.x + (end.x - start.x) * fraction);
      }
      intersections.sort((left, right) => left - right);
      for (let intersectionIndex = 0; intersectionIndex + 1 < intersections.length; intersectionIndex += 2) {
        const minX = Math.max(0, Math.ceil(intersections[intersectionIndex] - 0.5));
        const maxX = Math.min(width - 1, Math.floor(intersections[intersectionIndex + 1] - 0.5));
        for (let x = minX; x <= maxX; x++) {
          const pixelIndex = y * width + x;
          if (clip[pixelIndex] === 0) continue;
          compositeRasterPropColor(
            pixels,
            pixelIndex * 4,
            vectorPath.fillColor,
            placement.opacity,
          );
          if (propDepth && placement.opacity > 0) {
            propDepth[pixelIndex] = propDepthValue;
          }
          if (depthBuffer && placement.opacity > 0 && Number.isFinite(depthValue)) {
            depthBuffer[pixelIndex] = Math.max(depthBuffer[pixelIndex], depthValue);
          }
          if (coverage) {
            updateRasterPropOutlineCoverage(
              coverage,
              x,
              y,
              Math.round(clamp01(placement.opacity) * 255),
            );
          }
          painted = true;
        }
      }
    }
  }
  return painted;
}

/**
 * Paint the supplied tree's internal marks in source-image coordinates. The
 * legacy SVG motif path flips its y-axis for cartographic flow art; raster
 * props need the SVG top-left coordinate system so these lines stay aligned
 * with the transparent green fill. The closed silhouette is deliberately
 * omitted here: the forest outline is produced once from the union alpha pass.
 */
function paintRasterPropCharcoalPaths(
  width: number,
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
  options: ResolvedVegetationPatternOptions,
  segments: BatchedInkSegment[],
  depthValue?: number,
): void {
  const vectorPaths = asset.vectorPaths;
  if (!vectorPaths || vectorPaths.length === 0) return;
  const envelope = rasterPropRenderEnvelope(placement, asset);
  const variation = createRasterPropVectorVariation(placement, options);
  const sourceScale = Math.min(
    (envelope.width / Math.max(1, asset.width)) * variation.scaleX,
    (envelope.height / Math.max(1, asset.height)) * variation.scaleY,
  );
  const coordinateStride =
    options.coordinateStride === 1 ? width : options.coordinateStride;
  const motifSeed =
    (Math.imul(Math.round(placement.x), 374761393) ^
      Math.imul(Math.round(placement.y), 668265263) ^
      placement.assetKey.length) |
    0;
  const transformPoint = (point: VegetationStrokePoint): VegetationStrokePoint =>
    transformRasterPropVectorPoint(
      point,
      placement,
      asset,
      envelope,
      variation,
    );

  for (let pathIndex = 0; pathIndex < vectorPaths.length; pathIndex++) {
    const vectorPath = vectorPaths[pathIndex];
    // The closed first path is the filled silhouette. A single shared alpha
    // dilation around all tree fills avoids dark seams inside a stand.
    if (pathIndex === 0 && vectorPath.closed) continue;
    if (vectorPath.points.length < 2) continue;
    const points = vectorPath.points.map(transformPoint);
    const cumulativeLengths = new Array<number>(points.length).fill(0);
    for (let pointIndex = 1; pointIndex < points.length; pointIndex++) {
      const previous = points[pointIndex - 1];
      const point = points[pointIndex];
      cumulativeLengths[pointIndex] =
        cumulativeLengths[pointIndex - 1] +
        Math.hypot(point.x - previous.x, point.y - previous.y);
    }
    const pathLength = cumulativeLengths.at(-1) ?? 0;
    if (pathLength <= 1e-4) continue;
    const radius = Math.max(
      0.3,
      vectorPath.strokeWidth * sourceScale * options.strokeThickness * 1.08,
    );
    for (let pointIndex = 1; pointIndex < points.length; pointIndex++) {
      const start = points[pointIndex - 1];
      const end = points[pointIndex];
      if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-4) continue;
      segments.push({
        x0: start.x,
        y0: start.y,
        x1: end.x,
        y1: end.y,
        radius,
        seed: motifSeed + pathIndex * 1009 + pointIndex * 17,
        smoothing: 1.2,
        strokeT0: cumulativeLengths[pointIndex - 1] / pathLength,
        strokeT1: cumulativeLengths[pointIndex] / pathLength,
        taperStart: true,
        taperEnd: true,
        coordinateOffsetX: options.coordinateOffsetX,
        coordinateOffsetY: options.coordinateOffsetY,
        coordinateStride,
        opacity: placement.opacity,
        drySkipProbability: 0,
        clipStartCap: true,
        clipEndCap: true,
        depth: depthValue,
      });
    }
  }
}

function paintRasterProp(
  pixels: Uint8ClampedArray,
  shadowAlpha: Uint8Array,
  clip: Uint8Array,
  width: number,
  height: number,
  placement: VegetationRasterPropPlacement,
  asset: VegetationRasterPropAsset,
  options: ResolvedVegetationPatternOptions,
  sunAzimuthDeg: number,
  outlineCoverage?: RasterPropOutlineCoverage,
  propDepth?: Uint32Array,
  propDepthValue = 0,
  depthBuffer?: Float32Array,
  depthValue = 0,
): void {
  if (asset.width <= 0 || asset.height <= 0) return;
  const bounds = rasterPropRenderBounds(placement, asset);
  const minX = Math.max(0, Math.floor(bounds.minX) - 1);
  const maxX = Math.min(width - 1, Math.ceil(bounds.maxX) + 1);
  const minY = Math.max(0, Math.floor(bounds.minY) - 1);
  const maxY = Math.min(height - 1, Math.ceil(bounds.maxY) + 1);
  const envelope = rasterPropRenderEnvelope(placement, asset);
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const index = y * width + x;
      if (clip[index] === 0) continue;
      const dx = x + 0.5 - placement.x;
      const dy = y + 0.5 - placement.y;
      const localX = dx * cos + dy * sin;
      const localY = -dx * sin + dy * cos;
      const sourceX = Math.floor(
        ((localX / envelope.width + envelope.anchorX) * asset.width),
      );
      const sourceY = Math.floor(
        ((localY / envelope.height + envelope.anchorY) * asset.height),
      );
      if (
        sourceX < 0 ||
        sourceX >= asset.width ||
        sourceY < 0 ||
        sourceY >= asset.height
      ) continue;
      if (outlineCoverage) {
        updateRasterPropOutlineCoverage(
          outlineCoverage,
          x,
          y,
          Math.round(
            (asset.data[(sourceY * asset.width + sourceX) * 4 + 3] / 255) *
              placement.opacity *
              255,
          ),
        );
      }
      compositeRasterPropSourcePixel(
        pixels,
        index * 4,
        asset,
        (sourceY * asset.width + sourceX) * 4,
        placement.opacity,
      );
      if (propDepth && placement.opacity > 0 && asset.data[(sourceY * asset.width + sourceX) * 4 + 3] > 0) {
        propDepth[index] = propDepthValue;
      }
      if (depthBuffer && placement.opacity > 0 && asset.data[(sourceY * asset.width + sourceX) * 4 + 3] > 0 && Number.isFinite(depthValue)) {
        depthBuffer[index] = Math.max(depthBuffer[index], depthValue);
      }
    }
  }

  if (!RASTER_PROP_SHADOWS_ENABLED) return;

  const metrics = rasterPropShadowMetrics(
    placement,
    asset,
    options.motifShadowDistance,
    options.motifShadowSoftness,
  );
  if (metrics.offset <= 0) return;
  const azimuth = (sunAzimuthDeg * Math.PI) / 180;
  const shadowX = -Math.sin(azimuth);
  const shadowY = Math.cos(azimuth);
  const shadowBounds = {
    minX: bounds.minX + Math.min(0, shadowX * metrics.offset) - metrics.softness - 2,
    minY: bounds.minY + Math.min(0, shadowY * metrics.offset) - metrics.softness - 2,
    maxX: bounds.maxX + Math.max(0, shadowX * metrics.offset) + metrics.softness + 2,
    maxY: bounds.maxY + Math.max(0, shadowY * metrics.offset) + metrics.softness + 2,
  };
  const shadowMinX = Math.max(0, Math.floor(shadowBounds.minX));
  const shadowMaxX = Math.min(width - 1, Math.ceil(shadowBounds.maxX));
  const shadowMinY = Math.max(0, Math.floor(shadowBounds.minY));
  const shadowMaxY = Math.min(height - 1, Math.ceil(shadowBounds.maxY));
  for (let y = shadowMinY; y <= shadowMaxY; y++) {
    for (let x = shadowMinX; x <= shadowMaxX; x++) {
      const index = y * width + x;
      if (clip[index] === 0) continue;
      const sourceX = x - shadowX * metrics.offset;
      const sourceY = y - shadowY * metrics.offset;
      const footprint = sampleRasterPropSoftAlpha(
        asset,
        placement,
        sourceX,
        sourceY,
        metrics.softness,
      );
      if (footprint <= 0) continue;
      const grain = 0.72 +
        0.28 * hash01(
          Math.round(sourceX) * 374761393 ^ Math.round(sourceY) * 668265263,
          options.seed ^ asset.key.length ^ 0x78d4a2,
        );
      shadowAlpha[index] = Math.max(
        shadowAlpha[index],
        Math.round(footprint * grain * 255),
      );
    }
  }
}

function buildNoisyDirectionalShadowCoverage(
  dem: MountainDEMData,
  alpha: Uint8Array,
  clip: Uint8Array,
  width: number,
  height: number,
  options: ResolvedVegetationPatternOptions,
  sunAzimuthDeg: number,
): Float32Array {
  const shadow = new Float32Array(alpha.length);
  if (options.motifShadowDistance <= 0) return shadow;
  const azimuth = (sunAzimuthDeg * Math.PI) / 180;
  // Screen coordinates have Y down. A 315° northwest sun therefore casts
  // southeast (+X,+Y), matching the terrain hillshade convention.
  const shadowX = -Math.sin(azimuth);
  const shadowY = Math.cos(azimuth);
  const distance = options.motifShadowDistance * options.patternScale;
  const grainRadius = Math.max(
    0.65,
    Math.min(
      3.2,
      (0.45 + options.motifShadowSoftness * 0.7) * options.patternScale,
    ),
  );
  const grainNoise = new SimplexNoise(options.seed + 3221);
  const grainSampling = createVegetationFlowSampling(dem, options);
  const occupancyBlockSize = 32;
  const occupancyColumns = Math.ceil(width / occupancyBlockSize);
  const occupancyRows = Math.ceil(height / occupancyBlockSize);
  const occupiedBlocks = new Uint8Array(occupancyColumns * occupancyRows);
  for (let index = 0; index < alpha.length; index++) {
    if (alpha[index] === 0) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    occupiedBlocks[
      Math.floor(y / occupancyBlockSize) * occupancyColumns
        + Math.floor(x / occupancyBlockSize)
    ] = 1;
  }
  // The displaced source is an affine translation of the output grid. Resolve
  // its coordinates and occupancy-block bounds once per axis; the old version
  // repeated four divisions/floors for every candidate shadow pixel.
  const sourceXByPixel = new Float64Array(width);
  const sourceXMinBlock = new Int32Array(width);
  const sourceXMaxBlock = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    const sourceX = x - shadowX * distance;
    sourceXByPixel[x] = sourceX;
    sourceXMinBlock[x] = Math.max(
      0,
      Math.floor((sourceX - grainRadius) / occupancyBlockSize),
    );
    sourceXMaxBlock[x] = Math.min(
      occupancyColumns - 1,
      Math.floor((sourceX + grainRadius) / occupancyBlockSize),
    );
  }
  const sourceYByPixel = new Float64Array(height);
  const sourceYMinBlock = new Int32Array(height);
  const sourceYMaxBlock = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    const sourceY = y - shadowY * distance;
    sourceYByPixel[y] = sourceY;
    sourceYMinBlock[y] = Math.max(
      0,
      Math.floor((sourceY - grainRadius) / occupancyBlockSize),
    );
    sourceYMaxBlock[y] = Math.min(
      occupancyRows - 1,
      Math.floor((sourceY + grainRadius) / occupancyBlockSize),
    );
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (clip[index] === 0) continue;
      const sourceX = sourceXByPixel[x];
      const sourceY = sourceYByPixel[y];
      let occupied = false;
      for (
        let blockY = sourceYMinBlock[y];
        blockY <= sourceYMaxBlock[y] && !occupied;
        blockY++
      ) {
        for (
          let blockX = sourceXMinBlock[x];
          blockX <= sourceXMaxBlock[x];
          blockX++
        ) {
          if (occupiedBlocks[blockY * occupancyColumns + blockX]) {
            occupied = true;
            break;
          }
        }
      }
      if (!occupied) continue;
      const footprint = sampleAlphaFootprint(
        alpha,
        width,
        height,
        sourceX,
        sourceY,
        grainRadius,
      );
      if (footprint <= 0) continue;

      const grain =
        0.5 +
        sampleVegetationTextureGrainAt(
          // The shadow samples the same texture at its displaced source
          // position, keeping its grain coherent with the wash beneath it.
          dem,
          grainNoise,
          sourceX,
          sourceY,
          options,
          grainSampling,
        ) *
          0.5;
      // Keep the shadow visibly broken up. Strong source coverage gets a few
      // more grains, while the low-coverage halo remains a sparse border.
      const threshold = 0.46 - footprint * 0.12;
      if (grain <= threshold) continue;
      const grainCoverage = smoothStep(threshold, 0.94, grain);
      shadow[index] = footprint * grainCoverage * (0.3 + grain * 0.7);
    }
  }
  return shadow;
}

interface VegetationAxisLookup {
  lower: Int32Array;
  upper: Int32Array;
  weight: Float64Array;
}

function createVegetationAxisLookup(
  length: number,
  offset: number,
): VegetationAxisLookup {
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

function sampleVegetationFieldLookup(
  field: ArrayLike<number>,
  width: number,
  xLookup: VegetationAxisLookup,
  yLookup: VegetationAxisLookup,
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
 * Cast a subtle, independent shadow from the neutral wash into a separate
 * down-sun receiver. The shadow is kept as its own alpha field so it does not
 * reshape or suppress any of the wash's dark, neutral, or light bands.
 */
function buildDirectionalWashShadowCoverage(
  dem: MountainDEMData,
  tone: Float32Array,
  clip: Uint8Array,
  width: number,
  height: number,
  options: ResolvedVegetationPatternOptions,
  sunAzimuthDeg: number,
): Float32Array {
  const shadow = new Float32Array(tone.length);
  if (options.washShadowDistance + options.washShadowGap <= 0) return shadow;

  const azimuth = (sunAzimuthDeg * Math.PI) / 180;
  // A 315° northwest sun casts southeast (+X,+Y) in screen coordinates.
  const shadowX = -Math.sin(azimuth);
  const shadowY = Math.cos(azimuth);
  const distance =
    (options.washShadowDistance + options.washShadowGap) * options.patternScale;
  const spread = Math.max(
    0.75,
    (0.9 + options.washShadowDistance * 0.28) * options.patternScale,
  );
  const perpendicularX = -shadowY;
  const perpendicularY = shadowX;
  const grainNoise = new SimplexNoise(options.seed + 3221);
  const grainSampling = createVegetationFlowSampling(dem, options);
  const receiverXOffset = -shadowX * distance;
  const receiverYOffset = -shadowY * distance;
  // The three receiver taps are affine translations of the output grid.
  // Resolve their clamped bilinear indices once instead of repeating the
  // clamp/floor work for every tap in every output cell.
  const minusXLookup = createVegetationAxisLookup(
    width,
    receiverXOffset - perpendicularX * spread,
  );
  const centreXLookup = createVegetationAxisLookup(width, receiverXOffset);
  const plusXLookup = createVegetationAxisLookup(
    width,
    receiverXOffset + perpendicularX * spread,
  );
  const minusYLookup = createVegetationAxisLookup(
    height,
    receiverYOffset - perpendicularY * spread,
  );
  const centreYLookup = createVegetationAxisLookup(height, receiverYOffset);
  const plusYLookup = createVegetationAxisLookup(
    height,
    receiverYOffset + perpendicularY * spread,
  );

  const sampleNeutralWash = (
    xLookup: VegetationAxisLookup,
    yLookup: VegetationAxisLookup,
    x: number,
    y: number,
  ): number => {
    const value = sampleVegetationFieldLookup(
      tone,
      width,
      xLookup,
      yLookup,
      x,
      y,
    );
    // The middle stop is centred at 0.5. Keep this mask broad enough to
    // follow the wash, but remove the bright centre and dark outer stop from
    // the caster itself.
    return 1 - smoothStep(0.05, 0.2, Math.abs(value - 0.5));
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (clip[index] === 0) continue;

      // Look back past the gap toward the neutral wash. Three laterally
      // spread taps form a receiver shape instead of copying a single light
      // gradient edge one-to-one.
      const receiverX = x - shadowX * distance;
      const receiverY = y - shadowY * distance;
      const band =
        sampleNeutralWash(
          minusXLookup,
          minusYLookup,
          x,
          y,
        ) *
          0.25 +
        sampleNeutralWash(centreXLookup, centreYLookup, x, y) * 0.5 +
        sampleNeutralWash(
          plusXLookup,
          plusYLookup,
          x,
          y,
        ) *
          0.25;
      if (band <= 0) continue;

      const grain =
        0.5 +
        sampleVegetationTextureGrainAt(
          dem,
          grainNoise,
          receiverX,
          receiverY,
          options,
          grainSampling,
        ) *
          0.5;
      // Keep the cast shape continuous, but let the shared grain break up its
      // density so it feels printed rather than like a smooth blurred copy.
      const noisyBand =
        band * (1 - options.washShadowGrain * (0.42 - grain * 0.42));
      shadow[index] = noisyBand * 0.8;
    }
  }
  return shadow;
}

function buildFlowGuideAlpha(
  paths: readonly VegetationStrokePath[],
  clip: Uint8Array,
  width: number,
  height: number,
  options: ResolvedVegetationPatternOptions,
): Uint8Array {
  const guides = new Uint8Array(width * height);
  if (!options.showFlowGuides) return guides;

  // Guides deliberately use the complete streamline rather than the dashed
  // fallback treatment. This makes the direction field easy to inspect while
  // keeping the normal motif layer visually unchanged when the toggle is off.
  const segments: BatchedInkSegment[] = [];
  for (const path of paths) {
    const radius = Math.max(0.65, path.width * 0.8);
    for (let index = 0; index < path.points.length - 1; index++) {
      const start = path.points[index];
      const end = path.points[index + 1];
      segments.push({
        x0: start.x,
        y0: start.y,
        x1: end.x,
        y1: end.y,
        radius,
        seed: path.key + index * 101,
        smoothing: 0.25,
        strokeT0: 0,
        strokeT1: 1,
        taperStart: false,
        taperEnd: false,
        coordinateOffsetX: options.coordinateOffsetX,
        coordinateOffsetY: options.coordinateOffsetY,
        coordinateStride: options.coordinateStride === 1 ? width : options.coordinateStride,
        opacity: 1,
      });
    }
  }
  paintInkSegmentsBatched(guides, clip, width, height, segments);
  return guides;
}

interface RasterPropLayers {
  rasterPropRGBA: Uint8ClampedArray;
  rasterPropCharcoalAlpha: Uint8Array;
  rasterPropShadowAlpha: Uint8Array;
  rasterPropStandShare?: Uint8Array;
}

/**
 * Paints raster props and forest stands. Independent of the flow ink and
 * wash layers, so a worker can render it without the streamline geometry.
 */
function renderRasterPropLayers(
  dem: MountainDEMData,
  geometry: VegetationGeometry,
  options: ResolvedVegetationPatternOptions,
  sunAzimuthDeg: number,
  stageCache: VegetationOverlayStageCache | undefined,
  geometryKey: string,
  profiler: MountainProfiler | undefined,
): RasterPropLayers {
  const rasterPropKey = JSON.stringify([
    geometryKey,
    sunAzimuthDeg,
    options.motifShadowDistance,
    options.motifShadowSoftness,
    options.strokeThickness,
    options.strokeOpacity,
    options.lineInterruptionProbability,
    options.seed,
    options.coordinateOffsetX,
    options.coordinateOffsetY,
    options.coordinateStride,
    options.patternScale,
    options.coordinatePatternScale,
    options.rasterPropCellSize,
    options.rasterPropScale,
    options.forestRenderScale,
    forestRenderSettingsSignature(options.forestSettings),
    vegetationRasterPropAssetSignature(options.rasterPropAssets),
    (geometry.stands ?? []).map((stand) => stand.geometry.items.length),
    (geometry.rasterProps ?? []).map((placement) => [
      placement.x,
      placement.y,
      placement.rotation,
      placement.cellSize,
      placement.opacity,
      placement.assetKey,
    ]),
  ]);
  let rasterPropRGBA =
    stageCache?.rasterPropKey === rasterPropKey && stageCache.rasterPropRGBA
      ? stageCache.rasterPropRGBA
      : undefined;
  let rasterPropShadowAlpha =
    stageCache?.rasterPropKey === rasterPropKey &&
    stageCache.rasterPropShadowAlpha
      ? stageCache.rasterPropShadowAlpha
      : undefined;
  let rasterPropCharcoalAlpha =
    stageCache?.rasterPropKey === rasterPropKey &&
    stageCache.rasterPropCharcoalAlpha
      ? stageCache.rasterPropCharcoalAlpha
      : undefined;
  let rasterPropStandShare =
    stageCache?.rasterPropKey === rasterPropKey
      ? stageCache.rasterPropStandShare
      : undefined;
  const rasterPropsCacheHit = Boolean(
    rasterPropRGBA && rasterPropShadowAlpha && rasterPropCharcoalAlpha,
  );
  profiler?.recordCache(
    "vegetation raster prop rasterization",
    rasterPropsCacheHit,
  );
  const rasterPropsStop = profiler?.begin(
    "vegetation raster prop rasterization",
  );
  if (!rasterPropRGBA || !rasterPropShadowAlpha || !rasterPropCharcoalAlpha) {
    // Placement already excludes water at ground level. Raised silhouettes
    // may overlap water and are composited above its fill and shoreline ink.
    const propClip = new Uint8Array(dem.width * dem.height).fill(1);
    rasterPropRGBA = new Uint8ClampedArray(dem.width * dem.height * 4);
    rasterPropCharcoalAlpha = new Uint8Array(dem.width * dem.height);
    rasterPropShadowAlpha = new Uint8Array(dem.width * dem.height);
    const rasterAssets = new Map(
      options.rasterPropAssets.map((asset) => [asset.key, asset]),
    );
    const rasterPaintingStop = profiler?.begin(
      "vegetation raster prop painting",
    );
    const rasterPropSegments: BatchedInkSegment[] = [];
    const outlineCoverages: RasterPropOutlineCoverage[] = [];
    const propDepth = new Uint32Array(dem.width * dem.height);
    // Visual-bottom depth for every non-forest prop pixel. The forest canvas
    // fills a matching map so fills and charcoal edges can be interleaved by
    // the same back-to-front rule instead of painting all rocks beneath all
    // trees.
    const rasterPropDepth = new Float32Array(dem.width * dem.height);
    rasterPropDepth.fill(Number.NEGATIVE_INFINITY);
    const rasterPropPlacements = [...(geometry.rasterProps ?? [])].sort(
      (first, second) => {
        const firstAsset = rasterAssets.get(first.assetKey);
        const secondAsset = rasterAssets.get(second.assetKey);
        const firstDepth = firstAsset
          ? rasterPropRenderBounds(first, firstAsset).maxY
          : first.y;
        const secondDepth = secondAsset
          ? rasterPropRenderBounds(second, secondAsset).maxY
          : second.y;
        // Raster compositing is back-to-front; larger visual-bottom Y is
        // painted later so the foreground prop covers background outlines.
        return firstDepth - secondDepth;
      },
    );
    for (const [placementIndex, placement] of rasterPropPlacements.entries()) {
      const asset = rasterAssets.get(placement.assetKey);
      if (!asset) continue;
      // Vector forest and wetland props are drawn once by the shared forest
      // canvas. Keeping them out of the legacy raster pass prevents doubled
      // charcoal and preserves the authored multi-colour fills.
      if (isForestCanvasProp(asset)) continue;
      const depth = placementIndex + 1;
      const visualDepth = rasterPropRenderBounds(placement, asset).maxY;
      const outlineCoverage =
        asset.outlineMode === "alpha-dilation" && asset.outlineGroup
          ? createRasterPropOutlineCoverage(
              dem.width,
              dem.height,
              placement,
              asset,
              depth,
            )
          : undefined;
      if (outlineCoverage) outlineCoverages.push(outlineCoverage);
      if (
        asset.vectorPaths &&
        asset.vectorPaths.length > 0 &&
        asset.paintVectorFills
      ) {
        const vectorFillPainted = paintRasterPropVectorFill(
          rasterPropRGBA,
          outlineCoverage,
          propClip,
          dem.width,
          dem.height,
          placement,
          asset,
           options,
           propDepth,
           depth,
           rasterPropDepth,
           visualDepth,
         );
        if (!vectorFillPainted && asset.data.length >= asset.width * asset.height * 4) {
          paintRasterProp(
            rasterPropRGBA,
            rasterPropShadowAlpha,
            propClip,
            dem.width,
            dem.height,
            placement,
            asset,
            options,
            sunAzimuthDeg,
            outlineCoverage,
            propDepth,
            depth,
            rasterPropDepth,
            visualDepth,
          );
        }
        paintRasterPropCharcoalPaths(
          dem.width,
          placement,
          asset,
          options,
          rasterPropSegments,
          visualDepth,
        );
      } else if (asset.vectorPaths && asset.vectorPaths.length > 0) {
        paintVectorCharcoalMotif(
          rasterPropCharcoalAlpha,
          propClip,
          dem.width,
          dem.height,
          rasterPropToVectorMotif(placement, asset),
          asset,
          undefined,
          undefined,
          options,
           1,
           false,
           rasterPropSegments,
           visualDepth,
         );
      } else {
        paintRasterProp(
          rasterPropRGBA,
          rasterPropShadowAlpha,
          propClip,
          dem.width,
          dem.height,
          placement,
          asset,
          options,
          sunAzimuthDeg,
           outlineCoverage,
           propDepth,
           depth,
           rasterPropDepth,
           visualDepth,
         );
      }
    }
    paintInkSegmentsBatched(
      rasterPropCharcoalAlpha,
      propClip,
      dem.width,
      dem.height,
      rasterPropSegments,
      64,
      rasterPropDepth,
    );
    rasterPropSegments.length = 0;
    rasterPaintingStop?.();
    for (const coverage of outlineCoverages) {
      paintRasterPropAlphaDilationOutline(
        rasterPropCharcoalAlpha,
        coverage,
        propClip,
        propDepth,
        dem.width,
        dem.height,
        rasterPropDepth,
        coverage.visualDepth,
      );
    }
    const forestStop = profiler?.begin("vegetation forest canvas layer");
    // A depth readback is only needed when a non-forest prop can compete with
    // a tree. Tree-only scenes keep the single canvas pass and its cheaper
    // memory footprint.
    const hasInterleavedProps = rasterPropPlacements.some((placement) => {
      const asset = rasterAssets.get(placement.assetKey);
      return !asset || !isForestCanvasProp(asset);
    });
    const forestDepth = hasInterleavedProps
      ? new Float32Array(dem.width * dem.height)
      : undefined;
    const forestPixels = renderForestCanvasLayer(
      dem.width,
      dem.height,
      geometry.rasterProps ?? [],
      options.rasterPropAssets,
      options.forestSettings,
      undefined,
      options.coordinateOffsetX,
      options.coordinateOffsetY,
      options.coordinateStride > 1 && options.coordinateSourceWidth > 1
        ? (options.coordinateSourceWidth - 1) / (options.coordinateStride - 1)
        : 1,
      options.coordinateHeight > 1 && options.coordinateSourceHeight > 1
        ? (options.coordinateSourceHeight - 1) / (options.coordinateHeight - 1)
        : 1,
      options.forestRenderScale,
      forestDepth,
      profiler,
    );
    if (forestPixels) {
      for (let pixel = 0; pixel < dem.width * dem.height; pixel++) {
        const offset = pixel * 4;
        const sourceAlpha = forestPixels[offset + 3] / 255;
        if (sourceAlpha <= 0) continue;
        const treeDepth = forestDepth?.[pixel] ?? Number.NEGATIVE_INFINITY;
        const propDepthAtPixel = rasterPropDepth[pixel];
        const hasTreeDepth = Number.isFinite(treeDepth);
        const hasPropDepth = Number.isFinite(propDepthAtPixel);
        // Canopy washes are background treatment and must remain behind a
        // rock outline/fill. A tree crown competes only where its depth map
        // contains a silhouette pixel.
        if (
          hasPropDepth &&
          (!hasTreeDepth || treeDepth < propDepthAtPixel)
        ) continue;
        if (hasTreeDepth && (!hasPropDepth || treeDepth >= propDepthAtPixel)) {
          // The tree canvas already contains its own charcoal. Fade a
          // background rock edge by the tree's coverage so translucent prop
          // pixels still reveal the correctly ordered ink underneath.
          rasterPropCharcoalAlpha[pixel] = Math.round(
            rasterPropCharcoalAlpha[pixel] * (1 - sourceAlpha),
          );
        }
        const destinationAlpha = rasterPropRGBA[offset + 3] / 255;
        const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
        if (outputAlpha <= 0) continue;
        for (let channel = 0; channel < 3; channel++) {
          rasterPropRGBA[offset + channel] = Math.round(
            (forestPixels[offset + channel] * sourceAlpha +
              rasterPropRGBA[offset + channel] * destinationAlpha * (1 - sourceAlpha)) /
              outputAlpha,
          );
        }
        rasterPropRGBA[offset + 3] = Math.round(outputAlpha * 255);
      }
    }
    forestStop?.();
    for (const stand of geometry.stands ?? []) {
      const group = PROP_STAND_GROUPS.find((candidate) => candidate.id === stand.group);
      if (!group) continue;
      const standStop = profiler?.begin("vegetation forest stands");
      const settings = options.forestSettings;
      // Wash and plant fills share one colour: the group's palette foliage,
      // darkened to the value the lab was tuned with.
      const foliage = parseHexColor(group.color(settings)) ?? [86, 123, 84];
      const standPixels = renderForestStandLayer(dem.width, dem.height, stand.geometry, {
        washColor: `#${foliage.map((channel) => Math.round(channel * 0.75).toString(16).padStart(2, "0")).join("")}`,
        washStrength: settings.standWashStrength,
        washVariation: settings.standWashVariation,
        washSoftness: settings.standWashSoftness,
        inkColor: settings.outlineColor,
        inkWeight: settings.standInkWeight,
        lightStrength: settings.standLightStrength,
        accentColor: group.accentColors?.(settings).body,
        trunkColor: group.accentColors?.(settings).trunk,
      }, profiler);
      if (standPixels) {
        rasterPropStandShare ??= new Uint8Array(dem.width * dem.height);
        // Stands are background: composite them beneath every other prop.
        for (let pixel = 0; pixel < dem.width * dem.height; pixel++) {
          const offset = pixel * 4;
          const standAlpha = standPixels[offset + 3] / 255;
          if (standAlpha <= 0) continue;
          const propAlpha = rasterPropRGBA[offset + 3] / 255;
          const outputAlpha = propAlpha + standAlpha * (1 - propAlpha);
          for (let channel = 0; channel < 3; channel++) {
            rasterPropRGBA[offset + channel] = Math.round(
              (rasterPropRGBA[offset + channel] * propAlpha +
                standPixels[offset + channel] * standAlpha * (1 - propAlpha)) /
                outputAlpha,
            );
          }
          rasterPropRGBA[offset + 3] = Math.round(outputAlpha * 255);
          // Share of the pixel that is stand paint, including stands composited before.
          rasterPropStandShare[pixel] = Math.round(
            (rasterPropStandShare[pixel] / 255 * propAlpha + standAlpha * (1 - propAlpha)) / outputAlpha * 255,
          );
        }
      }
      standStop?.();
    }
    const rasterInkOpacityStop = profiler?.begin(
      "vegetation raster prop ink opacity",
    );
    // Match the forest canvas outlines: prop charcoal opacity alone.
    const rasterPropCharcoalOpacity = options.forestSettings.propCharcoalAlpha;
    if (rasterPropCharcoalOpacity < 1) {
      for (let index = 0; index < rasterPropCharcoalAlpha.length; index++) {
        rasterPropCharcoalAlpha[index] = Math.round(
          rasterPropCharcoalAlpha[index] * rasterPropCharcoalOpacity,
        );
      }
    }
    rasterInkOpacityStop?.();
    if (stageCache) {
      stageCache.rasterPropKey = rasterPropKey;
      stageCache.rasterPropRGBA = rasterPropRGBA;
      stageCache.rasterPropCharcoalAlpha = rasterPropCharcoalAlpha;
      stageCache.rasterPropShadowAlpha = rasterPropShadowAlpha;
      stageCache.rasterPropStandShare = rasterPropStandShare;
    }
  }
  rasterPropsStop?.();
  return { rasterPropRGBA, rasterPropCharcoalAlpha, rasterPropShadowAlpha, rasterPropStandShare };
}

function emptyRasterPropLayers(): RasterPropLayers {
  return {
    rasterPropRGBA: new Uint8ClampedArray(0),
    rasterPropCharcoalAlpha: new Uint8Array(0),
    rasterPropShadowAlpha: new Uint8Array(0),
  };
}

/** Joins the halves rendered by two `renderVegetationOverlay` parts. */
export function mergeVegetationOverlay(
  flow: VegetationOverlay,
  props: VegetationOverlay,
): VegetationOverlay {
  return {
    ...flow,
    rasterPropRGBA: props.rasterPropRGBA,
    rasterPropCharcoalAlpha: props.rasterPropCharcoalAlpha,
    rasterPropShadowAlpha: props.rasterPropShadowAlpha,
    rasterPropStandShare: props.rasterPropStandShare,
  };
}

export function renderVegetationOverlay(
  dem: MountainDEMData,
  geometry: VegetationGeometry,
  rawOptions?: VegetationPatternOptions,
  sunAzimuthDeg = 315,
  stageCache?: VegetationOverlayStageCache,
  geometryKey = "",
  profiler?: MountainProfiler,
  part: VegetationLayerPart = "all",
): VegetationOverlay {
  const options = resolveVegetationPatternOptions(rawOptions);
  if (part === "props") {
    // Only the prop layers are rendered; the flow layers come from the
    // matching "flow" part and are joined by mergeVegetationOverlay.
    return {
      width: dem.width,
      height: dem.height,
      alpha: new Uint8Array(0),
      backgroundTone: new Float32Array(0),
      backgroundNoise: new Float32Array(0),
      backgroundDryness: new Float32Array(0),
      wetlandDryness: new Float32Array(0),
      wetlandImagePropHabitat: new Float32Array(0),
      washShadowAlpha: new Uint8Array(0),
      shadowAlpha: new Uint8Array(0),
      flowGuideAlpha: new Uint8Array(0),
      ...renderRasterPropLayers(dem, geometry, options, sunAzimuthDeg, stageCache, geometryKey, profiler),
    };
  }
  const clipKey = `${dem.width}x${dem.height}`;
  const clipCacheHit = Boolean(stageCache?.clipKey === clipKey && stageCache.clip);
  profiler?.recordCache("vegetation land mask", clipCacheHit);
  const clipStop = profiler?.begin("vegetation land mask");
  const clip =
    clipCacheHit && stageCache?.clip
      ? stageCache.clip
      : createLandMask(dem);
  if (stageCache && stageCache.clipKey !== clipKey) {
    stageCache.clipKey = clipKey;
    stageCache.clip = clip;
  }
  clipStop?.();

  const inkKey = JSON.stringify([
    geometryKey,
    options.strokeThickness,
    options.strokeOpacity,
    options.drySkipProbability,
    options.lineInterruptionProbability,
    vegetationMotifAssetSignature(options.motifAssets),
  ]);
  const cachedAlpha =
    stageCache?.inkKey === inkKey && stageCache.alpha
      ? stageCache.alpha
      : undefined;
  const alpha = cachedAlpha ?? new Uint8Array(dem.width * dem.height);
  const inkCacheHit = Boolean(cachedAlpha);
  profiler?.recordCache("vegetation ink", inkCacheHit);
  const inkStop = profiler?.begin("vegetation ink");
  if (!cachedAlpha) {

    const assets = new Map(
      options.motifAssets.map((asset) => [asset.key, asset]),
    );
    const pathSamplers = new Map<number, VegetationPathSampler>();
    const pathStrokeRuns = new Map<number, readonly CharcoalStrokeRun[]>();
    const outputPixelScale = Math.max(
      0.25,
      options.patternScale / Math.max(0.5, options.coordinatePatternScale),
    );
    const samplerStop = profiler?.begin("vegetation path sampler preparation");
    for (const path of geometry.paths) {
      const sampler = createVegetationPathSampler(path);
      pathSamplers.set(path.key, sampler);
      pathStrokeRuns.set(
        path.key,
        createCharcoalStrokeRuns(
          sampler.totalLength,
          (path.key ^ Math.imul(options.seed, 17)) | 0,
          outputPixelScale,
          { breakProbability: options.lineInterruptionProbability },
        ),
      );
    }
    samplerStop?.();

    // Paths are placement guides, not visible marks. They become ink only when SVG
    // assets failed to load, preserving the documented procedural fallback.
    if (assets.size === 0) {
      const fallbackStop = profiler?.begin(
        "vegetation fallback stroke rasterization",
      );
      for (const path of geometry.paths) {
        let travelled = path.dashPhase;
        const totalSegments = path.points.length - 1;
        for (let index = 0; index < totalSegments; index++) {
          const start = path.points[index];
          const end = path.points[index + 1];
          const length = Math.hypot(end.x - start.x, end.y - start.y);
          const cycle = 17 * options.patternScale;
          const draw = travelled % cycle < cycle * 0.78;
          if (draw) {
            paintInkSegment(
              alpha,
              clip,
              dem.width,
              dem.height,
              start.x,
              start.y,
              end.x,
              end.y,
              path.width * options.strokeThickness,
              path.key + index * 101,
              1.2,
              index / totalSegments,
              (index + 1) / totalSegments,
              true,
              true,
              options.coordinateOffsetX,
              options.coordinateOffsetY,
              options.coordinateStride === 1
                ? dem.width
                : options.coordinateStride,
              1,
              options.drySkipProbability,
            );
          }
          travelled += length;
        }
      }
      fallbackStop?.();
    }

    const motifStop = profiler?.begin(
      "vegetation flow motif rasterization",
    );
    const flowMotifSegments: BatchedInkSegment[] = [];
    for (const motif of geometry.motifs) {
      const asset = assets.get(motif.assetKey);
      if (asset) {
        const pathSampler =
          motif.pathKey === undefined
            ? undefined
            : pathSamplers.get(motif.pathKey);
        if (asset.vectorPaths && asset.vectorPaths.length > 0) {
          paintVectorCharcoalMotif(
            alpha,
            clip,
            dem.width,
            dem.height,
            motif,
            asset,
            pathSampler,
            motif.pathKey === undefined
              ? undefined
              : pathStrokeRuns.get(motif.pathKey),
            options,
            1,
            true,
            flowMotifSegments,
          );
        } else {
          paintCharcoalMotif(
            alpha,
            clip,
            dem.width,
            dem.height,
            motif,
            asset,
            pathSampler,
            options,
          );
        }
      }
    }
    motifStop?.();
    paintInkSegmentsBatched(
      alpha,
      clip,
      dem.width,
      dem.height,
      flowMotifSegments,
    );
    const inkOpacityStop = profiler?.begin("vegetation ink opacity");
    if (options.strokeOpacity < 1) {
      for (let index = 0; index < alpha.length; index++) {
        alpha[index] = Math.round(alpha[index] * options.strokeOpacity);
      }
    }
    inkOpacityStop?.();
    if (stageCache) {
      stageCache.inkKey = inkKey;
      stageCache.alpha = alpha;
    }
  }
  inkStop?.();

  const backgroundKey = JSON.stringify([
    dem.width,
    dem.height,
    options.seed,
    options.patternScale,
    options.swirlStrength,
    options.coordinateOffsetX,
    options.coordinateOffsetY,
    options.coordinateStride,
    options.coordinateHeight,
    options.coordinateSourceWidth,
    options.coordinateSourceHeight,
    options.coordinatePatternScale,
    options.flowWashNoiseScale,
    options.wetlandDryDistanceStart,
    options.wetlandDryDistanceEnd,
    options.wetlandDryNoiseScale,
    options.wetlandDryNoiseStrength,
    options.wetlandImagePropDrynessBias,
  ]);
  let background =
    stageCache?.backgroundKey === backgroundKey &&
    stageCache.background &&
    stageCache.backgroundWaterDistance === options.waterDistanceOverride
      ? stageCache.background
      : undefined;
  const backgroundCacheHit = Boolean(background);
  profiler?.recordCache("vegetation flow background", backgroundCacheHit);
  const backgroundStop = profiler?.begin("vegetation flow background");
  if (!background) {
    background = buildFlowBackgroundTone(
      dem,
      clip,
      options,
      profiler,
      geometry.flowCache,
    );
    if (stageCache) {
      stageCache.backgroundKey = backgroundKey;
      stageCache.backgroundWaterDistance = options.waterDistanceOverride;
      stageCache.background = background;
    }
  }
  backgroundStop?.();
  if (!background) throw new Error("Vegetation background was not built");

  const washShadowCoverageKey = JSON.stringify([
    backgroundKey,
    sunAzimuthDeg,
    options.washShadowDistance,
    options.washShadowGap,
    options.washShadowGrain,
    options.patternScale,
    options.seed,
    options.coordinateOffsetX,
    options.coordinateOffsetY,
    options.coordinateStride,
    options.coordinateHeight,
    options.coordinateSourceWidth,
    options.coordinateSourceHeight,
    options.coordinatePatternScale,
  ]);
  const washShadowKey = JSON.stringify([
    washShadowCoverageKey,
    options.washShadowStrength,
  ]);
  let washShadowAlpha =
    stageCache?.washShadowKey === washShadowKey && stageCache.washShadowAlpha
      ? stageCache.washShadowAlpha
      : undefined;
  const washShadowCacheHit = Boolean(washShadowAlpha);
  profiler?.recordCache("vegetation wash shadow", washShadowCacheHit);
  const washShadowStop = profiler?.begin("vegetation wash shadow");
  if (!washShadowAlpha) {
    if (
      options.washShadowStrength <= 0 ||
      options.washShadowDistance + options.washShadowGap <= 0
    ) {
      washShadowAlpha = new Uint8Array(dem.width * dem.height);
    } else {
      let coverage =
        stageCache?.washShadowCoverageKey === washShadowCoverageKey &&
        stageCache.washShadowCoverage
          ? stageCache.washShadowCoverage
          : undefined;
      const coverageCacheHit = Boolean(coverage);
      profiler?.recordCache(
        "vegetation wash shadow coverage",
        coverageCacheHit,
      );
      const coverageStop = profiler?.begin(
        "vegetation wash shadow coverage",
      );
      if (!coverage) {
        coverage = buildDirectionalWashShadowCoverage(
          dem,
          background.tone,
          clip,
          dem.width,
          dem.height,
          options,
          sunAzimuthDeg,
        );
        if (stageCache) {
          stageCache.washShadowCoverageKey = washShadowCoverageKey;
          stageCache.washShadowCoverage = coverage;
        }
      }
      coverageStop?.();
      const alphaStop = profiler?.begin("vegetation wash shadow alpha");
      washShadowAlpha = new Uint8Array(coverage.length);
      for (let index = 0; index < coverage.length; index++) {
        washShadowAlpha[index] = Math.round(
          coverage[index] * options.washShadowStrength * 255,
        );
      }
      alphaStop?.();
    }
    if (stageCache) {
      stageCache.washShadowKey = washShadowKey;
      stageCache.washShadowAlpha = washShadowAlpha;
    }
  }
  washShadowStop?.();

  const shadowCoverageKey = JSON.stringify([
    inkKey,
    sunAzimuthDeg,
    options.patternScale,
    options.seed,
    options.motifShadowDistance,
    options.motifShadowSoftness,
    options.coordinateOffsetX,
    options.coordinateOffsetY,
    options.coordinateStride,
    options.coordinateHeight,
    options.coordinateSourceWidth,
    options.coordinateSourceHeight,
    options.coordinatePatternScale,
  ]);
  const shadowKey = JSON.stringify([
    shadowCoverageKey,
    options.motifShadowStrength,
  ]);
  let shadowAlpha =
    stageCache?.shadowKey === shadowKey && stageCache.shadowAlpha
      ? stageCache.shadowAlpha
      : undefined;
  const shadowCacheHit = Boolean(shadowAlpha);
  profiler?.recordCache("vegetation motif shadow", shadowCacheHit);
  const shadowStop = profiler?.begin("vegetation motif shadow");
  if (!shadowAlpha) {
    if (options.motifShadowStrength <= 0 || options.motifShadowDistance <= 0) {
      shadowAlpha = new Uint8Array(dem.width * dem.height);
    } else {
      let coverage =
        stageCache?.shadowCoverageKey === shadowCoverageKey &&
        stageCache.shadowCoverage
          ? stageCache.shadowCoverage
          : undefined;
      const coverageCacheHit = Boolean(coverage);
      profiler?.recordCache(
        "vegetation motif shadow coverage",
        coverageCacheHit,
      );
      const coverageStop = profiler?.begin(
        "vegetation motif shadow coverage",
      );
      if (!coverage) {
        coverage = buildNoisyDirectionalShadowCoverage(
          dem,
          alpha,
          clip,
          dem.width,
          dem.height,
          options,
          sunAzimuthDeg,
        );
        if (stageCache) {
          stageCache.shadowCoverageKey = shadowCoverageKey;
          stageCache.shadowCoverage = coverage;
        }
      }
      coverageStop?.();
      const alphaStop = profiler?.begin("vegetation motif shadow alpha");
      shadowAlpha = new Uint8Array(coverage.length);
      for (let index = 0; index < coverage.length; index++) {
        shadowAlpha[index] = Math.round(
          coverage[index] * options.motifShadowStrength * 255,
        );
      }
      alphaStop?.();
    }
    if (stageCache) {
      stageCache.shadowKey = shadowKey;
      stageCache.shadowAlpha = shadowAlpha;
    }
  }
  shadowStop?.();

  const propLayers = part === "flow"
    ? emptyRasterPropLayers()
    : renderRasterPropLayers(dem, geometry, options, sunAzimuthDeg, stageCache, geometryKey, profiler);

  const guideKey = JSON.stringify([
    geometryKey,
    options.showFlowGuides,
    options.coordinateOffsetX,
    options.coordinateOffsetY,
    options.coordinateStride,
  ]);
  let flowGuideAlpha =
    stageCache?.guideKey === guideKey && stageCache.flowGuideAlpha
      ? stageCache.flowGuideAlpha
      : undefined;
  const guideCacheHit = Boolean(flowGuideAlpha);
  profiler?.recordCache("vegetation flow guides", guideCacheHit);
  const guideStop = profiler?.begin("vegetation flow guides");
  if (!flowGuideAlpha) {
    flowGuideAlpha = buildFlowGuideAlpha(
      geometry.paths,
      clip,
      dem.width,
      dem.height,
      options,
    );
    if (stageCache) {
      stageCache.guideKey = guideKey;
      stageCache.flowGuideAlpha = flowGuideAlpha;
    }
  }
  guideStop?.();
  return {
    width: dem.width,
    height: dem.height,
    alpha,
    backgroundTone: background.tone,
    backgroundNoise: background.noise,
    backgroundDryness: background.dryness,
    wetlandDryness: background.wetlandDryness,
    wetlandImagePropHabitat: background.wetlandImagePropHabitat,
    washShadowAlpha,
    shadowAlpha,
    flowGuideAlpha,
    rasterPropRGBA: propLayers.rasterPropRGBA,
    rasterPropCharcoalAlpha: propLayers.rasterPropCharcoalAlpha,
    rasterPropShadowAlpha: propLayers.rasterPropShadowAlpha,
    rasterPropStandShare: propLayers.rasterPropStandShare,
  };
}

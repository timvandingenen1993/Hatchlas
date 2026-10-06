/**
 * Mountain Studio: loads a heightmap, previews it, and exports high-resolution mountain maps.
 */
import { INSPECTOR_BOUNDS } from "../config/inspectorBounds";
import { DESERT_DEFAULT_SPOT_COLOR, DESERT_DUNE_DEFAULTS } from "../rendering/desertDunes";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  MOUNTAIN_BIOME_LABELS,
  getMountainBiomeLabel,
  getMountainClimateZoneLabel,
  loadHeightmapFile,
  loadHeightmapImage,
  getHeightmapFitResolution,
  MAX_MOUNTAIN_RENDER_RESOLUTION,
  MOUNTAIN_WATER_EVOLUTION_STEPS,
  resampleHeightmapLuminance,
  type HeightmapGeoMetadata,
  type HeightmapRaster,
  type MountainDEMData,
} from "../terrain/mountainBaseDEM";
import {
  MOUNTAIN_REFERENCE_BIOME_COLORS,
  MOUNTAIN_REFERENCE_WATER_COLORS,
  renderMountainDetailDEM,
  type MountainDetailLayer,
  type MountainColorPalette,
  type MountainRenderOptions,
} from "../rendering/mountainDetailRenderer";
import {
  VEGETATION_MOTIF_DEFINITIONS,
  VEGETATION_RASTER_PROP_DEFINITIONS,
  ALPINE_TREE_75_ASSET_URLS,
  WETLAND_VEGETATION_PROP_DEFINITIONS,
  loadVegetationMotifAssets,
  loadMountainDetailPropAssets,
} from "../rendering/vegetationMotifs";
import {
  FOREST_REFERENCE_LONG_EDGE,
  normalizeForestRenderSettings,
  readInitialForestRenderSettings,
  type ForestRenderSettings,
} from "../rendering/forestCanvasRenderer";
import { ForestRenderControls } from "./ForestRenderControls";
import { NumericControl } from "./NumericControl";
import { PreviewStatus, type PreviewStatusValue } from "./PreviewStatus";
import { InspectorColor, InspectorFold, InspectorNote, InspectorSection, InspectorSeed, InspectorSelect, InspectorToggle } from "./InspectorParts";
import { Check, ChevronDown, Crop, Download, Hand, Minus, PanelRightClose, PanelRightOpen, Plus, RotateCcw, Ruler, X } from "lucide-react";
import {
  propStandStyleForBiome,
  rasterPropSettingsForBiome,
  type RasterPropBiomeSettings,
  type VegetationMotifAsset,
  type VegetationRasterPropAsset,
  type VegetationPatternPreset,
} from "../rendering/vegetationRenderer";
import {
  buildVisualWaterSurfaceDEM,
  type WaveEpicenter,
} from "../rendering/waterRenderer";
import {
  DEFAULT_SILT_LAYERS,
  DEFAULT_SILT_REACH_M,
  DEFAULT_SILT_TOP_REMOVED,
} from "../rendering/riverSilt";
import type {
  MountainPreviewBackendStatus,
  MountainPreviewFlowSnapshot,
  MountainPreviewMetadata,
  MountainPreviewProfileResult,
  MountainPreviewRequest,
  MountainPreviewResponse,
} from "../rendering/mountainPreviewTypes";
import type {
  MountainExportRequest,
  MountainExportProgress,
  MountainExportStageTiming,
  MountainExportWaterSurface,
  MountainExportWorkerResponse,
} from "../rendering/mountainExportTypes";
import {
  addMountainProfileStage,
  logMountainProfileReport,
  createMountainProfiler,
} from "../rendering/mountainProfiler";
import {
  MOUNTAIN_HATCH_DENSITY_DEFAULT,
  MOUNTAIN_HATCH_DENSITY_MAX,
  MOUNTAIN_HATCH_DENSITY_MIN,
  MOUNTAIN_HATCH_OPACITY_DEFAULT,
  MOUNTAIN_HATCH_OPACITY_MAX,
  MOUNTAIN_HATCH_OPACITY_MIN,
  MOUNTAIN_HATCH_THICKNESS_DEFAULT,
  MOUNTAIN_HATCH_THICKNESS_MAX,
  MOUNTAIN_HATCH_THICKNESS_MIN,
  MOUNTAIN_BIOME_DETAIL_MULTIPLIER_DEFAULT,
  MOUNTAIN_BIOME_DETAIL_MULTIPLIER_MAX,
  MOUNTAIN_BIOME_DETAIL_MULTIPLIER_MIN,
  MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_DEFAULT,
  MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_MAX,
  MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_MIN,
  MOUNTAIN_LOCAL_DETAIL_DENSITY_DEFAULT,
  MOUNTAIN_LOCAL_DETAIL_DENSITY_MAX,
  MOUNTAIN_LOCAL_DETAIL_DENSITY_MIN,
  MOUNTAIN_LINEWORK_SCALE_DEFAULT,
  MOUNTAIN_LINEWORK_SCALE_MAX,
  MOUNTAIN_LINEWORK_SCALE_MIN,
  MOUNTAIN_LINEWORK_OPACITY_DEFAULT,
  MOUNTAIN_LINEWORK_OPACITY_MAX,
  MOUNTAIN_LINEWORK_OPACITY_MIN,
  MOUNTAIN_RIDGE_DENSITY_DEFAULT,
  MOUNTAIN_RIDGE_DENSITY_MAX,
  MOUNTAIN_RIDGE_DENSITY_MIN,
  MOUNTAIN_RIDGE_THICKNESS_DEFAULT,
  MOUNTAIN_RIDGE_THICKNESS_MAX,
  MOUNTAIN_RIDGE_THICKNESS_MIN,
  MOUNTAIN_SNOW_REDISTRIBUTION_STEPS_DEFAULT,
} from "../rendering/mountainProjection";
import type { MountainLightingMode } from "../rendering/mountainLighting";
import type {
  FullTerrainCameraRenderStyle,
  FullTerrainCameraType,
} from "../rendering/fullTerrainCameraRenderer";
import { downloadGrayscale16BitPng } from "../utils/heightmapExport";
import defaultHeightmapUrl from "../assets/nz-linz-dem.tif";
import currentSettingsText from "../../currentSettings?raw";
const baselineSettings = JSON.parse(currentSettingsText) as Record<string, unknown>;
/** Default tree, shrub and clustering values of one biome, for the inspector's reset. */
function baselineRasterPropSettings(biome: number) {
  return rasterPropSettingsForBiome({
    rasterPropDensity: baselineSettings.vegetationRasterPropDensity as number | undefined,
    rasterPropClustering: baselineSettings.vegetationRasterPropClustering as number | undefined,
    rasterPropBiomeSettings: baselineSettings.vegetationRasterPropBiomeSettings as RasterPropBiomeSettings | undefined,
    wetlandShrubDensity: baselineSettings.vegetationWetlandShrubDensity as number | undefined,
  }, biome);
}
import { calibrateBundledMountainHeightmap } from "../terrain/mountainHeightmapCalibration";

// The map picker brings Leaflet and MapLibre, so it loads only when opened.
const GlobalDemDialog = lazy(() => import("./GlobalDemDialog"));

const EPICENTER_WAVES_ENABLED = false;

function formatExportTime(milliseconds: number): string {
  const elapsedMs = Math.max(0, milliseconds);
  const seconds = elapsedMs / 1000;
  if (seconds < 1) return `${Math.round(elapsedMs)}ms`;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

interface DropletParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  maxAge: number;
}

const MOUNTAIN_RESOLUTION_PRESETS = [1024, 2048, 4096, 8192, 16384] as const;
const MIN_MOUNTAIN_RENDER_RESOLUTION = 256;
const SMOOTHING_LABELS = [
  "Off",
  "Light",
  "Medium",
  "Strong",
  "Very strong",
] as const;
// Keep interactive rendering responsive; export resolution is handled by the
// worker and never feeds back into the visible canvases.
const MOUNTAIN_PREVIEW_ANALYSIS_LONG_EDGE = FOREST_REFERENCE_LONG_EDGE;
// Opt-in because console tables and timing snapshots are intentionally absent
// from the normal preview/export path.
const MOUNTAIN_PROFILE_QUERY =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("mountainProfile")
    : null;
// Keep the profiler opt-in, but accept both documented profile URL values.
// The render pipeline emits the analysis and vegetation snapshots from one
// enabled run; `2` is therefore an alias for enabling the same profiler.
const MOUNTAIN_PROFILE_ENABLED =
  MOUNTAIN_PROFILE_QUERY === "1" || MOUNTAIN_PROFILE_QUERY === "2";
// Use the fast GPU path by default; URL options can still select CPU or approximate rendering.
const MOUNTAIN_GPU_RENDER_MODE: MountainRenderOptions["gpuRenderMode"] =
  typeof window !== "undefined"
    ? (() => {
        const mode = new URLSearchParams(window.location.search).get("mountainGpu");
        return mode === "fast"
          ? "gpuFast"
          : mode === "approx"
            ? "gpuApprox"
            : mode === "cpu"
              ? "cpuExact"
              : "gpuFast";
      })()
    : "gpuFast";
const RASTER_PROP_BIOMES = [...new Set([
  ...VEGETATION_RASTER_PROP_DEFINITIONS.flatMap((asset) => [...asset.eligibleBiomeIds]),
])].sort((a, b) => a - b);
const VEGETATION_RASTER_PROP_DENSITY = 0.8;
// Forest size is authored as a multiplier of the map-relative reference
// crown. The renderer converts it to the current DEM/output scale, so the
// same value survives preview reduction and 8K/16K export.
const FOREST_TREE_REFERENCE_CELL_SIZE = 16;
const FOREST_TREE_SCALE_DEFAULT = 1;
const VEGETATION_RASTER_PROP_CLUSTERING = 0.72;
const VEGETATION_RASTER_PROP_STAND_SIZE = 0.5;
const VEGETATION_RASTER_PROP_PLACEMENT_NOISE_SCALE = 1;
const MOUNTAIN_DEFAULT_VIEW_ZOOM = 1.1462548777757673;
const MOUNTAIN_DEFAULT_OUTPUT_LONG_EDGE = 8192;
const MOUNTAIN_DEFAULT_SUN_AZIMUTH_DEG = 330;
const MOUNTAIN_BOULDER_DENSITY = 0.42;
const MOUNTAIN_BOULDER_SIZE = 1;
const MOUNTAIN_SETTINGS_STORAGE_KEY =
  "fantasy-map-builder:mountain-detail-settings:v1";
const DIAGNOSTIC_VIEWS = [
  ["slope", "Slope"],
  ["aspect", "Aspect"],
  ["precipitation", "Rainfall"],
  ["solar_insolation", "Solar exposure"],
  ["landforms_tpi", "Landforms (TPI)"],
  ["erosion_depth", "Erosion depth"],
  ["wave_patterns", "Wave field"],
] as const satisfies readonly (readonly [MountainDetailLayer, string])[];
const PRIMARY_VIEWS = [
  ["vegetation_patterns", "Map"],
  ["swiss_relief", "Relief"],
  ["raw_heightmap", "Heightmap"],
  ["drainage_network", "Water"],
  ["biomes", "Biomes"],
] as const satisfies readonly (readonly [MountainDetailLayer, string])[];
const TOOLS = [
  { id: "pan", label: "Pan", key: "H", Icon: Hand },
  { id: "profile", label: "Elevation profile", key: "P", Icon: Ruler },
  { id: "region", label: "Export region", key: "R", Icon: Crop },
] as const;

const PERSISTED_MOUNTAIN_LAYERS: readonly MountainDetailLayer[] = [
  "swiss_relief",
  "raw_heightmap",
  "eroded_heightmap",
  "slope",
  "aspect",
  "drainage_network",
  "erosion_depth",
  "precipitation",
  "solar_insolation",
  "biomes",
  "vegetation_patterns",
  "landforms_tpi",
  ...(MOUNTAIN_PROFILE_ENABLED ? ["wave_patterns" as const] : []),
];
const PERSISTED_MOUNTAIN_PALETTES: readonly MountainColorPalette[] = [
  "swiss_topo",
  "european_topo",
  "physical_satellite",
  "alpine_glacial",
  "thermal_magma",
  "viridis",
  "slope_hazard",
];

const MOUNTAIN_PALETTE_BIOME_IDS = Array.from(
  { length: MOUNTAIN_BIOME_LABELS.length },
  (_, biomeId) => biomeId,
);
const MOUNTAIN_REFERENCE_LINE_COLORS = {
  vegetationInk: "#2b3842",
  aridInk: "#3a2b1e",
  forestOutline: "#283b29",
  mountainHatch: "#2b3842",
  mountainRidge: "#2b3842",
  waterOutline: "#173a58",
  waterFlow: "#1f405a",
} as const;

/** Biome colours that used to be the default, kept so saved copies of them upgrade. */
const RETIRED_BIOME_DEFAULT_COLORS: Readonly<Record<number, string>> = {
  15: "#d8b878",
};

/** Eight-point compass name for a bearing in degrees. */
function compassLabel(degrees: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];
}

function createReferenceBiomeColorState(): Record<number, string> {
  return MOUNTAIN_PALETTE_BIOME_IDS.reduce<Record<number, string>>(
    (colors, biomeId) => {
      colors[biomeId] = MOUNTAIN_REFERENCE_BIOME_COLORS[biomeId] ?? "#779452";
      return colors;
    },
    {},
  );
}

interface MountainDetailSettingsSnapshot {
  version: 2;
  activeLayer: MountainDetailLayer;
  activePalette: MountainColorPalette;
  vegetationPreset: VegetationPatternPreset;
  vegetationSeed: number;
  vegetationDensity: number;
  vegetationPatternScale: number;
  vegetationSwirlStrength: number;
  vegetationTerrainFollowing: number;
  vegetationDesertDunes: boolean;
  vegetationDesertDuneSpacingKm: number;
  vegetationDesertHighlight: number;
  vegetationDesertWashShadow: number;
  vegetationDesertLineBreaks: number;
  vegetationDesertDots: number;
  vegetationDesertColorVariation: number;
  vegetationDesertColorScaleKm: number;
  vegetationDesertSpotColor: string;
  vegetationDesertCrestScallop: number;
  vegetationDesertTerrainFollowing: number;
  vegetationDesertShadowLength: number;
  vegetationDesertShadowStrength: number;
  vegetationDesertHatchDensity: number;
  vegetationDesertRippleLines: number;
  vegetationStrokeLength: number;
  vegetationStrokeThickness: number;
  vegetationStrokeOpacity: number;
  vegetationMountainSideRidgeDensity: number;
  vegetationMountainMainRidgeThickness: number;
  vegetationMotifDensity: number;
  vegetationMotifSize: number;
  vegetationRasterPropBiomeSettings: RasterPropBiomeSettings;
  vegetationRasterPropDensity: number;
  vegetationMountainBoulderDensity: number;
  vegetationMountainBoulderSize: number;
  vegetationWetlandShrubDensity: number;
  vegetationRasterPropScale: number;
  vegetationRasterPropClustering: number;
  vegetationRasterPropStandSize: number;
  vegetationRasterPropPlacementNoiseScale: number;
  forestSettings: ForestRenderSettings;
  forestSourceZoom: number;
  vegetationInkColor: string;
  vegetationAridInkColor: string;
  forestOutlineColor: string;
  mountainHatchColor: string;
  mountainRidgeColor: string;
  vegetationBiomeColors: Record<number, string>;
  vegetationBiomeTransitionStrength: number;
  biomeEdgeNoiseScaleM: number;
  waterShallowColor: string;
  waterDeepColor: string;
  vegetationFlowWashStrength: number;
  vegetationFlowWashDarkStrength: number;
  vegetationFlowWashLightStrength: number;
  vegetationFlowWashNoiseStrength: number;
  vegetationFlowWashNoiseScale: number;
  vegetationWetlandDryDistanceStart: number;
  vegetationWetlandDryDistanceEnd: number;
  vegetationWetlandDryNoiseScale: number;
  vegetationWetlandDryNoiseStrength: number;
  vegetationShowFlowGuides: boolean;
  vegetationMotifShadowStrength: number;
  vegetationMotifShadowDistance: number;
  vegetationMotifShadowSoftness: number;
  vegetationWashShadowStrength: number;
  vegetationWashShadowDistance: number;
  vegetationWashShadowGap: number;
  vegetationWashShadowGrain: number;
  minElevM: number;
  maxElevM: number;
  oceanElevationM: number;
  domainWidthKm: number;
  outputLongEdge: number;
  heightmapSmoothingPasses: number;
  sunAzimuthDeg: number;
  sunAltitudeDeg: number;
  mountainLightingMode: MountainLightingMode;
  mountainViewAngleDeg: number;
  mountainHeightExaggeration: number;
  mountainLineworkScale?: number;
  mountainLineworkOpacity?: number;
  mountainHatchOpacity?: number;
  mountainHatchHorizontalOpacity?: number;
  mountainHatchVerticalOpacity?: number;
  mountainHatchDensity?: number;
  mountainLocalDetailDensityMax?: number;
  mountainFoothillDetailMultiplier?: number;
  mountainBiomeDetailMultiplier?: number;
  mountainHatchThickness?: number;
  mountainRidgeDensity?: number;
  mountainRidgeThickness?: number;
  fullTerrainCameraEnabled: boolean;
  fullTerrainCameraElevationDeg: number;
  fullTerrainCameraHeightExaggeration: number;
  fullTerrainCameraType: FullTerrainCameraType;
  fullTerrainCameraRenderStyle: FullTerrainCameraRenderStyle;
  vertExagg: number;
  aoStrength: number;
  hillshadeStrength: number;
  showRivers: boolean;
  showHeightmapWater: boolean;
  riverThresholdKm2: number;
  showWaterDetails: boolean;
  showOceanDetails: boolean;
  siltReachM: number;
  siltTopRemoved: number;
  siltLayers: number;
  showWetlandPuddleContours: boolean;
  wetlandPuddleDensity: number;
  wetlandPuddleSizeMin: number;
  wetlandPuddleSizeMax: number;
  wetlandPuddleCoastDistance: number;
  wetlandPoolContourLength: number;
  wetlandPuddleSeed: number;
  oceanRippleCount: number;
  deepOceanSwells: boolean;
  deepOceanSwellDensity: number;
  lakeFullDepthM: number;
  deepOceanWaveLength: number;
  deepOceanStrokeThickness: number;
  deepOceanWaveShadingScale: number;
  deepOceanWaveShadingIntensity: number;
  deepOceanTurbulenceScale: number;
  deepOceanTurbulenceIntensity: number;
  customEpicenters?: WaveEpicenter[];
  waterFillSmoothing: number;
  waterTerrainShadeStrength: number;
  waterOutlineThickness: number;
  waterOutlineLength: number;
  waterOutlineSmoothing: number;
  waterOutlineOpacity: number;
  waterFlowDensity: number;
  waterFlowLength: number;
  waterFlowThickness: number;
  waterFlowSmoothing: number;
  waterFlowOpacity: number;
  waterOutlineColor: string;
  waterFlowColor: string;
  wetlandElevationThresholdM: number;
  biomeRegionScaleKm: number;
  waterStageScale: number;
  flowRateScale: number;
  waterLandscapeImpact: number;
  waterEvolutionStep: number;
  rainOverlayOpacity: number;
  windAzimuthDeg: number;
  windSpeedMs: number;
  basePrecipMm: number;
  baseTemperatureC: number;
  showContours: boolean;
  contourIntervalM: number;
  contourSmoothingPasses: number;
  contourThicknessM: number;
  contourIndexThicknessM: number;
  showIndexContours: boolean;
  contourIndexEvery: number;
  contourOpacity: number;
  contourColor: string;
  contourIndexColor: string;
  animateWater: boolean;
  zoom: number;
  pan: { x: number; y: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Reads a saved number. [min, max] is the control's slider range, which typed values may exceed,
 * so an unsigned range only rejects negatives; `hard` clamps to [min, max] for true limits.
 */
function readStoredNumber(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  hard = false,
): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (hard) return Math.max(min, Math.min(max, value));
  return min >= 0 ? Math.max(0, value) : value;
}

function readStoredBoolean(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  return typeof source[key] === "boolean" ? (source[key] as boolean) : fallback;
}

function readStoredString(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  return typeof source[key] === "string" ? (source[key] as string) : fallback;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim());
}

function readStoredColor(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = source[key];
  return isHexColor(value) ? value : fallback;
}

function readStoredEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const value = source[key];
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : fallback;
}

function drawPreviewRaster(
  canvas: HTMLCanvasElement,
  raster: HTMLCanvasElement,
  profileA: { x: number; y: number } | null,
  profileB: { x: number; y: number } | null,
): void {
  if (canvas.width !== raster.width || canvas.height !== raster.height) {
    canvas.width = raster.width;
    canvas.height = raster.height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(raster, 0, 0);
  if (!profileA || !profileB) return;
  const x0 = profileA.x * canvas.width;
  const y0 = profileA.y * canvas.height;
  const x1 = profileB.x * canvas.width;
  const y1 = profileB.y * canvas.height;
  context.save();
  context.strokeStyle = "rgba(0, 0, 0, 0.75)";
  context.lineWidth = 4.5;
  context.beginPath();
  context.moveTo(x0, y0);
  context.lineTo(x1, y1);
  context.stroke();
  context.strokeStyle = "#38bdf8";
  context.lineWidth = 2.5;
  context.setLineDash([6, 4]);
  context.beginPath();
  context.moveTo(x0, y0);
  context.lineTo(x1, y1);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "#10b981";
  context.beginPath();
  context.arc(x0, y0, 6, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ef4444";
  context.beginPath();
  context.arc(x1, y1, 6, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

interface MountainDetailStudioProps {
  isExportOpen?: boolean;
  onCloseExport?: () => void;
  onMountainBackendStatusChange?: (status: {
    backend: MountainPreviewBackendStatus;
    reason?: string;
  }) => void;
}

export function MountainDetailStudio({
  isExportOpen = false,
  onCloseExport = () => undefined,
  onMountainBackendStatusChange,
}: MountainDetailStudioProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rasterCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const exportWorkerRef = useRef<Worker | null>(null);
  const exportRequestIdRef = useRef(0);
  // Resolves the pending part of a (split) export when the user cancels it.
  const exportPartAbortRef = useRef<(() => void) | null>(null);
  const previewWorkerRef = useRef<Worker | null>(null);
  const previewRequestIdRef = useRef(0);
  const analysisRevisionRef = useRef(0);
  const renderRequestIdRef = useRef(0);
  const settingsRevisionRef = useRef(0);
  const inspectRequestIdRef = useRef(0);
  const profileRequestIdRef = useRef(0);
  const previewRequestSentAtRef = useRef<Map<number, number>>(new Map());
  const mountainBackendStatusChangeRef = useRef(onMountainBackendStatusChange);

  useEffect(() => {
    mountainBackendStatusChangeRef.current = onMountainBackendStatusChange;
  }, [onMountainBackendStatusChange]);

  // Active 2D Cartographic Layer & Palette
  const [inspectorTab, setInspectorTab] = useState<"Terrain" | "Ink" | "Water" | "Lighting">("Ink");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [activeLayer, setActiveLayer] =
    useState<MountainDetailLayer>("vegetation_patterns");
  const [activePalette, setActivePalette] =
    useState<MountainColorPalette>("swiss_topo");
  const [vegetationBiomeColors, setVegetationBiomeColors] = useState<
    Record<number, string>
  >(createReferenceBiomeColorState);
  const [biomeEdgeNoiseScaleM, setBiomeEdgeNoiseScaleM] = useState<number>(800);
  const [vegetationBiomeTransitionStrength, setVegetationBiomeTransitionStrength] =
    useState<number>(1);
  const [waterShallowColor, setWaterShallowColor] = useState<string>(
    MOUNTAIN_REFERENCE_WATER_COLORS.shallow,
  );
  const [waterDeepColor, setWaterDeepColor] = useState<string>(
    MOUNTAIN_REFERENCE_WATER_COLORS.deep,
  );
  const [vegetationMotifAssets, setVegetationMotifAssets] =
    useState<VegetationMotifAsset[] | null>(null);
  const [vegetationMotifLoadError, setVegetationMotifLoadError] =
    useState<string | null>(null);
  const [rasterPropAssets, setRasterPropAssets] =
    useState<VegetationRasterPropAsset[] | null>(null);
  const [, setRasterPropLoadError] =
    useState<string | null>(null);
  const [vegetationPreset, setVegetationPreset] =
    useState<VegetationPatternPreset>("adaptive");
  const [vegetationSeed, setVegetationSeed] = useState<number>(() => readInitialForestRenderSettings().seed);
  const [vegetationDensity, setVegetationDensity] = useState<number>(1);
  const [vegetationPatternScale, setVegetationPatternScale] = useState<number>(1);
  const [vegetationSwirlStrength, setVegetationSwirlStrength] = useState<number>(0.65);
  const [vegetationTerrainFollowing, setVegetationTerrainFollowing] = useState<number>(0.35);
  const [vegetationDesertDunes, setVegetationDesertDunes] = useState<boolean>(DESERT_DUNE_DEFAULTS.enabled);
  const [vegetationDesertDuneSpacingKm, setVegetationDesertDuneSpacingKm] = useState<number>(DESERT_DUNE_DEFAULTS.spacingKm);
  const [vegetationDesertHighlight, setVegetationDesertHighlight] = useState<number>(DESERT_DUNE_DEFAULTS.highlight);
  const [vegetationDesertWashShadow, setVegetationDesertWashShadow] = useState<number>(DESERT_DUNE_DEFAULTS.washShadow);
  const [vegetationDesertLineBreaks, setVegetationDesertLineBreaks] = useState<number>(DESERT_DUNE_DEFAULTS.lineBreaks);
  const [vegetationDesertDots, setVegetationDesertDots] = useState<number>(DESERT_DUNE_DEFAULTS.dots);
  const [vegetationDesertColorVariation, setVegetationDesertColorVariation] = useState<number>(DESERT_DUNE_DEFAULTS.colorVariation);
  const [vegetationDesertColorScaleKm, setVegetationDesertColorScaleKm] = useState<number>(DESERT_DUNE_DEFAULTS.colorScaleKm);
  const [vegetationDesertSpotColor, setVegetationDesertSpotColor] = useState<string>(DESERT_DEFAULT_SPOT_COLOR);
  const [vegetationDesertCrestScallop, setVegetationDesertCrestScallop] = useState<number>(DESERT_DUNE_DEFAULTS.crestScallop);
  const [vegetationDesertTerrainFollowing, setVegetationDesertTerrainFollowing] = useState<number>(DESERT_DUNE_DEFAULTS.terrainFollowing);
  const [vegetationDesertShadowLength, setVegetationDesertShadowLength] = useState<number>(DESERT_DUNE_DEFAULTS.shadowLength);
  const [vegetationDesertShadowStrength, setVegetationDesertShadowStrength] = useState<number>(DESERT_DUNE_DEFAULTS.shadowStrength);
  const [vegetationDesertHatchDensity, setVegetationDesertHatchDensity] = useState<number>(DESERT_DUNE_DEFAULTS.hatchDensity);
  const [vegetationDesertRippleLines, setVegetationDesertRippleLines] = useState<number>(DESERT_DUNE_DEFAULTS.rippleLines);
  const [vegetationStrokeLength, setVegetationStrokeLength] = useState<number>(1);
  const [vegetationStrokeThickness, setVegetationStrokeThickness] = useState<number>(1);
  const [vegetationStrokeOpacity, setVegetationStrokeOpacity] = useState<number>(0.72);
  const [vegetationMountainSideRidgeDensity, setVegetationMountainSideRidgeDensity] = useState<number>(1);
  const [vegetationMountainMainRidgeThickness, setVegetationMountainMainRidgeThickness] = useState<number>(0.75);
  const [vegetationMotifDensity, setVegetationMotifDensity] = useState<number>(0.8);
  const [vegetationMotifSize, setVegetationMotifSize] = useState<number>(1);
  const [rasterPropBiome, setRasterPropBiome] = useState<number>(2);
  const [vegetationRasterPropBiomeSettings, setVegetationRasterPropBiomeSettings] = useState<RasterPropBiomeSettings>({});
  const [vegetationRasterPropDensity, setVegetationRasterPropDensity] =
    useState<number>(VEGETATION_RASTER_PROP_DENSITY);
  const [vegetationMountainBoulderDensity, setVegetationMountainBoulderDensity] =
    useState<number>(MOUNTAIN_BOULDER_DENSITY);
  const [vegetationMountainBoulderSize, setVegetationMountainBoulderSize] =
    useState<number>(MOUNTAIN_BOULDER_SIZE);
  const [vegetationWetlandShrubDensity, setVegetationWetlandShrubDensity] =
    useState<number>(0.55);
  const [vegetationRasterPropScale, setVegetationRasterPropScale] =
    useState<number>(FOREST_TREE_SCALE_DEFAULT);
  const [vegetationRasterPropClustering, setVegetationRasterPropClustering] =
    useState<number>(VEGETATION_RASTER_PROP_CLUSTERING);
  const [vegetationRasterPropStandSize, setVegetationRasterPropStandSize] =
    useState<number>(VEGETATION_RASTER_PROP_STAND_SIZE);
  const [vegetationRasterPropPlacementNoiseScale, setVegetationRasterPropPlacementNoiseScale] =
    useState<number>(VEGETATION_RASTER_PROP_PLACEMENT_NOISE_SCALE);
  const [forestSettings, setForestSettings] = useState<ForestRenderSettings>(readInitialForestRenderSettings);
  const [forestSourceZoom, setForestSourceZoom] = useState(1);
  const selectedRasterSettings = rasterPropSettingsForBiome({
    rasterPropDensity: vegetationRasterPropDensity,
    rasterPropClustering: vegetationRasterPropClustering,
    rasterPropBiomeSettings: vegetationRasterPropBiomeSettings,
    wetlandShrubDensity: vegetationWetlandShrubDensity,
  }, rasterPropBiome);
  const baselineRasterSettings = baselineRasterPropSettings(rasterPropBiome);
  const selectedStandStyle = propStandStyleForBiome(
    forestSettings, vegetationRasterPropBiomeSettings, rasterPropBiome,
  );
  const updateRasterBiome = <K extends keyof NonNullable<RasterPropBiomeSettings[number]>>(
    setting: K,
    value: NonNullable<RasterPropBiomeSettings[number]>[K],
  ) => {
    setVegetationRasterPropBiomeSettings(previous => ({
      ...previous, [rasterPropBiome]: { ...previous[rasterPropBiome], [setting]: value },
    }));
  };
  const [vegetationInkColor, setVegetationInkColor] = useState<string>(
    MOUNTAIN_REFERENCE_LINE_COLORS.vegetationInk,
  );
  const [vegetationAridInkColor, setVegetationAridInkColor] = useState<string>(
    MOUNTAIN_REFERENCE_LINE_COLORS.aridInk,
  );
  const [forestOutlineColor, setForestOutlineColor] = useState<string>(
    MOUNTAIN_REFERENCE_LINE_COLORS.forestOutline,
  );
  const [mountainHatchColor, setMountainHatchColor] = useState<string>(
    MOUNTAIN_REFERENCE_LINE_COLORS.mountainHatch,
  );
  const [mountainRidgeColor, setMountainRidgeColor] = useState<string>(
    MOUNTAIN_REFERENCE_LINE_COLORS.mountainRidge,
  );
  const [vegetationFlowWashStrength, setVegetationFlowWashStrength] = useState<number>(0.24);
  const [vegetationFlowWashDarkStrength, setVegetationFlowWashDarkStrength] = useState<number>(0.22);
  const [vegetationFlowWashLightStrength, setVegetationFlowWashLightStrength] = useState<number>(0.12);
  const [vegetationFlowWashNoiseStrength, setVegetationFlowWashNoiseStrength] = useState<number>(0.45);
  const [vegetationFlowWashNoiseScale, setVegetationFlowWashNoiseScale] = useState<number>(1);
  const [vegetationWetlandDryDistanceStart, setVegetationWetlandDryDistanceStart] = useState<number>(8);
  const [vegetationWetlandDryDistanceEnd, setVegetationWetlandDryDistanceEnd] = useState<number>(32);
  const [vegetationWetlandDryNoiseScale, setVegetationWetlandDryNoiseScale] = useState<number>(1.4);
  const [vegetationWetlandDryNoiseStrength, setVegetationWetlandDryNoiseStrength] = useState<number>(0.9);
  const [vegetationShowFlowGuides, setVegetationShowFlowGuides] = useState<boolean>(false);
  const [vegetationShowWetlandDrynessOverlay, setVegetationShowWetlandDrynessOverlay] = useState<boolean>(false);
  const [vegetationShowAlpineTreeSuitability, setVegetationShowAlpineTreeSuitability] = useState<boolean>(false);
  const [vegetationMotifShadowStrength, setVegetationMotifShadowStrength] = useState<number>(0.2);
  const [vegetationMotifShadowDistance, setVegetationMotifShadowDistance] = useState<number>(2.2);
  const [vegetationMotifShadowSoftness, setVegetationMotifShadowSoftness] = useState<number>(1.1);
  const [vegetationWashShadowStrength, setVegetationWashShadowStrength] = useState<number>(0.2);
  const [vegetationWashShadowDistance, setVegetationWashShadowDistance] = useState<number>(2.2);
  const [vegetationWashShadowGap, setVegetationWashShadowGap] = useState<number>(1);
  const [vegetationWashShadowGrain, setVegetationWashShadowGrain] = useState<number>(1);

  // Physical DEM Calibration Parameters
  const [minElevM, setMinElevM] = useState<number>(80);
  const [maxElevM, setMaxElevM] = useState<number>(3850);
  const [oceanElevationM, setOceanElevationM] = useState<number>(-10);
  const [domainWidthKm, setDomainWidthKm] = useState<number>(45);
  const [outputLongEdge, setOutputLongEdge] = useState<number>(MOUNTAIN_DEFAULT_OUTPUT_LONG_EDGE);
  const [splitExportIntoStrips, setSplitExportIntoStrips] = useState(false);
  const [exportStrip, setExportStrip] = useState<"all" | "1" | "2" | "3" | "4">("all");
  const [heightmapSmoothingPasses, setHeightmapSmoothingPasses] =
    useState<number>(1);

  // Lighting & Cartographic Controls
  const [sunAzimuthDeg, setSunAzimuthDeg] = useState<number>(MOUNTAIN_DEFAULT_SUN_AZIMUTH_DEG);
  const [sunAltitudeDeg, setSunAltitudeDeg] = useState<number>(45);
  const [mountainLightingMode, setMountainLightingMode] = useState<MountainLightingMode>("two-tone");
  const [mountainViewAngleDeg, setMountainViewAngleDeg] = useState<number>(78);
  const [mountainHeightExaggeration, setMountainHeightExaggeration] = useState<number>(1);
  const [mountainLineworkScale, setMountainLineworkScale] = useState<number>(MOUNTAIN_LINEWORK_SCALE_DEFAULT);
  const [mountainLineworkOpacity, setMountainLineworkOpacity] = useState<number>(MOUNTAIN_LINEWORK_OPACITY_DEFAULT);
  const [mountainHatchOpacity, setMountainHatchOpacity] = useState<number>(MOUNTAIN_HATCH_OPACITY_DEFAULT);
  const [mountainHatchHorizontalOpacity, setMountainHatchHorizontalOpacity] = useState<number>(MOUNTAIN_HATCH_OPACITY_DEFAULT);
  const [mountainHatchVerticalOpacity, setMountainHatchVerticalOpacity] = useState<number>(MOUNTAIN_HATCH_OPACITY_DEFAULT);
  const [mountainHatchDensity, setMountainHatchDensity] = useState<number>(MOUNTAIN_HATCH_DENSITY_DEFAULT);
  const [mountainLocalDetailDensityMax, setMountainLocalDetailDensityMax] = useState<number>(MOUNTAIN_LOCAL_DETAIL_DENSITY_DEFAULT);
  const [mountainFoothillDetailMultiplier, setMountainFoothillDetailMultiplier] = useState<number>(MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_DEFAULT);
  const [mountainBiomeDetailMultiplier, setMountainBiomeDetailMultiplier] = useState<number>(MOUNTAIN_BIOME_DETAIL_MULTIPLIER_DEFAULT);
  const [mountainHatchThickness, setMountainHatchThickness] = useState<number>(MOUNTAIN_HATCH_THICKNESS_DEFAULT);
  const [mountainRidgeDensity, setMountainRidgeDensity] = useState<number>(MOUNTAIN_RIDGE_DENSITY_DEFAULT);
  const [mountainRidgeThickness, setMountainRidgeThickness] = useState<number>(MOUNTAIN_RIDGE_THICKNESS_DEFAULT);
  const [fullTerrainCameraEnabled, setFullTerrainCameraEnabled] = useState<boolean>(true);
  const [fullTerrainCameraElevationDeg, setFullTerrainCameraElevationDeg] = useState<number>(75);
  const [fullTerrainCameraHeightExaggeration, setFullTerrainCameraHeightExaggeration] = useState<number>(1);
  const [fullTerrainCameraType, setFullTerrainCameraType] = useState<FullTerrainCameraType>("orthographic");
  // Kept only as a compatibility value for older saved settings. Production
  // camera renders always use the final compositor image.
  const [fullTerrainCameraRenderStyle, setFullTerrainCameraRenderStyle] = useState<FullTerrainCameraRenderStyle>("compositor");
  const [vertExagg, setVertExagg] = useState<number>(3.8);
  const [hillshadeStrength, setHillshadeStrength] = useState<number>(1);
  const [aoStrength, setAoStrength] = useState<number>(0.45);

  // Hydrology & Micro-climate Controls
  const [showHeightmapWater, setShowHeightmapWater] = useState(false);
  const [showRivers, setShowRivers] = useState<boolean>(true);
  const [riverThresholdKm2, setRiverThresholdKm2] = useState<number>(16);
  const [showWaterDetails, setShowWaterDetails] = useState<boolean>(true);
  const [showOceanDetails, setShowOceanDetails] = useState<boolean>(true);
  const [showWetlandPuddleContours, setShowWetlandPuddleContours] =
    useState<boolean>(true);
  const [siltReachM, setSiltReachM] = useState<number>(DEFAULT_SILT_REACH_M);
  const [siltTopRemoved, setSiltTopRemoved] = useState<number>(DEFAULT_SILT_TOP_REMOVED);
  const [siltLayers, setSiltLayers] = useState<number>(DEFAULT_SILT_LAYERS);
  const [wetlandPuddleDensity, setWetlandPuddleDensity] =
    useState<number>(0.85);
  const [wetlandPuddleSizeMin, setWetlandPuddleSizeMin] =
    useState<number>(0.1);
  const [wetlandPuddleSizeMax, setWetlandPuddleSizeMax] =
    useState<number>(0.6);
  const [wetlandPuddleCoastDistance, setWetlandPuddleCoastDistance] =
    useState<number>(0);
  const [wetlandPoolContourLength, setWetlandPoolContourLength] =
    useState<number>(1.8);
  const [wetlandPuddleSeed, setWetlandPuddleSeed] =
    useState<number>(23817);
  const [oceanRippleCount, setOceanRippleCount] = useState<number>(5);
  const [deepOceanSwells, setDeepOceanSwells] = useState<boolean>(true);
  const [deepOceanSwellDensity, setDeepOceanSwellDensity] = useState<number>(0.18);
  const [lakeFullDepthM, setLakeFullDepthM] = useState<number>(15);
  const [deepOceanWaveLength, setDeepOceanWaveLength] = useState<number>(1.0);
  const [deepOceanStrokeThickness, setDeepOceanStrokeThickness] = useState<number>(1.0);
  const [deepOceanWaveShadingScale, setDeepOceanWaveShadingScale] = useState<number>(4.5);
  const [deepOceanWaveShadingIntensity, setDeepOceanWaveShadingIntensity] = useState<number>(2.5);
  const [deepOceanTurbulenceScale, setDeepOceanTurbulenceScale] = useState<number>(4.5);
  const [deepOceanTurbulenceIntensity, setDeepOceanTurbulenceIntensity] = useState<number>(2.5);
  const [customEpicenters, setCustomEpicenters] = useState<WaveEpicenter[]>([]);
  const [selectedEpicenterId, setSelectedEpicenterId] = useState<string | null>(null);
  const [draggingEpicenterId, setDraggingEpicenterId] = useState<string | null>(null);
  const [waterFillSmoothing, setWaterFillSmoothing] = useState<number>(1);
  const [waterTerrainShadeStrength, setWaterTerrainShadeStrength] = useState<number>(0.7);
  const [waterOutlineThickness, setWaterOutlineThickness] =
    useState<number>(1.0);
  const [waterOutlineLength, setWaterOutlineLength] = useState<number>(1.0);
  const [waterOutlineSmoothing, setWaterOutlineSmoothing] = useState<number>(1);
  const [waterOutlineOpacity, setWaterOutlineOpacity] = useState<number>(0.92);
  const [waterFlowDensity, setWaterFlowDensity] = useState<number>(0.8);
  const [waterFlowLength, setWaterFlowLength] = useState<number>(0.9);
  const [waterFlowThickness, setWaterFlowThickness] = useState<number>(1.0);
  const [waterFlowSmoothing, setWaterFlowSmoothing] = useState<number>(1);
  const [waterFlowOpacity, setWaterFlowOpacity] = useState<number>(0.82);
  const [waterOutlineColor, setWaterOutlineColor] = useState<string>(
    MOUNTAIN_REFERENCE_LINE_COLORS.waterOutline,
  );
  const [waterFlowColor, setWaterFlowColor] = useState<string>(
    MOUNTAIN_REFERENCE_LINE_COLORS.waterFlow,
  );
  const [wetlandElevationThresholdM, setWetlandElevationThresholdM] =
    useState<number>(454);
  const [biomeRegionScaleKm, setBiomeRegionScaleKm] = useState<number>(0.01);
  const [waterStageScale, setWaterStageScale] = useState<number>(0.8);
  const [flowRateScale, setFlowRateScale] = useState<number>(0.9);
  const [waterLandscapeImpact, setWaterLandscapeImpact] = useState<number>(1);
  const [waterEvolutionStep, setWaterEvolutionStep] = useState<number>(0);
  const [rainOverlayOpacity, setRainOverlayOpacity] = useState<number>(0.0);
  const [windAzimuthDeg, setWindAzimuthDeg] = useState<number>(225);
  const [windSpeedMs, setWindSpeedMs] = useState<number>(16);
  const [basePrecipMm, setBasePrecipMm] = useState<number>(1500);
  const [baseTemperatureC, setBaseTemperatureC] = useState<number>(17);

  // Contours
  const [showContours, setShowContours] = useState<boolean>(false);
  const [contourIntervalM, setContourIntervalM] = useState<number>(100);
  const [contourSmoothingPasses, setContourSmoothingPasses] =
    useState<number>(0);
  const [contourThicknessM, setContourThicknessM] = useState<number>(4);
  const [contourIndexThicknessM, setContourIndexThicknessM] =
    useState<number>(6);
  const [showIndexContours, setShowIndexContours] = useState<boolean>(true);
  const [contourIndexEvery, setContourIndexEvery] = useState<number>(5);
  const [contourOpacity, setContourOpacity] = useState<number>(1.0);
  const [contourColor, setContourColor] = useState<string>("#3c3c3c");
  const [contourIndexColor, setContourIndexColor] = useState<string>("#282828");

  const isHeightmapView = activeLayer === "raw_heightmap" || activeLayer === "eroded_heightmap";
  const terrainCameraActive = activeLayer === "vegetation_patterns" && fullTerrainCameraEnabled;
  const viewRainOpacity = activeLayer === "vegetation_patterns" || activeLayer === "swiss_relief" ? rainOverlayOpacity : 0;

  // Streamflow Animated Water Droplets (off by default)
  const [animateWater, setAnimateWater] = useState<boolean>(false);
  const particlesRef = useRef<DropletParticle[]>([]);

  // 2D Pan & Zoom State
  const [zoom, setZoom] = useState<number>(MOUNTAIN_DEFAULT_VIEW_ZOOM);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const panStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    startPanX: number;
    startPanY: number;
  }>({
    mouseX: 0,
    mouseY: 0,
    startPanX: 0,
    startPanY: 0,
  });

  // Raw Image Data & Processed DEM
  const [rawLuminance, setRawLuminance] = useState<{
    width: number;
    height: number;
    data: Float32Array;
    oceanMask?: Uint8Array;
  } | null>(null);
  const [heightmapSourceName, setHeightmapSourceName] = useState<string>(
    "nz-linz-dem.tif",
  );
  /** Real-world scale of the current heightmap; null for plain images and the bundled map. */
  const [heightmapMetadata, setHeightmapMetadata] = useState<HeightmapGeoMetadata | null>(null);
  const [globalDemOpen, setGlobalDemOpen] = useState(false);
  const [previewMetadata, setPreviewMetadata] =
    useState<MountainPreviewMetadata | null>(null);
  const demDataRef = useRef<MountainDEMData | null>(null);
  const demData = demDataRef.current;
  const [previewFlow, setPreviewFlow] =
    useState<MountainPreviewFlowSnapshot | null>(null);
  const [analysisRevision, setAnalysisRevision] = useState(0);
  const [frameVersion, setFrameVersion] = useState(0);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatusValue | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewWorkerGeneration, setPreviewWorkerGeneration] = useState(0);
  const [analysisCommitVersion, setAnalysisCommitVersion] = useState(0);
  const [profileData, setProfileData] =
    useState<MountainPreviewProfileResult | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<MountainExportProgress | null>(null);
  const [exportSummary, setExportSummary] = useState<MountainExportStageTiming[] | null>(null);
  const [exportClock, setExportClock] = useState(() => Date.now());
  const [exportError, setExportError] = useState<string | null>(null);
  // Region preview: a rectangle in viewport ratios, rendered at export size.
  const [regionDraft, setRegionDraft] = useState<
    { x0: number; y0: number; x1: number; y1: number } | null
  >(null);
  const [regionPreview, setRegionPreview] = useState<
    { url: string; filename: string } | null
  >(null);
  const exportIsActive = exportProgress !== null;
  useEffect(() => {
    if (!exportIsActive) return;
    const interval = window.setInterval(() => setExportClock(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [exportIsActive]);
  const sourceLoadIdRef = useRef<number>(0);

  // Interactive Tools State: Inspect vs Profile Cross-Section vs Rain Dropper vs Epicenter vs Pan
  const [activeTool, setActiveTool] = useState<
    "profile" | "epicenter" | "pan" | "region"
  >("pan");
  const [diagnosticsMenuOpen, setDiagnosticsMenuOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.metaKey || event.altKey || target?.closest("input, select, textarea")) return;
      const tool = TOOLS.find(({ key }) => key === event.key.toUpperCase());
      if (tool) setActiveTool(tool.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const [profileA, setProfileA] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [profileB, setProfileB] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [isDrawingProfile, setIsDrawingProfile] = useState<boolean>(false);
  const profileARef = useRef(profileA);
  const profileBRef = useRef(profileB);

  // Hover Tooltip Info
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    elevM: number;
    slopeDeg: number;
    aspectDeg: number;
    drainageAreaKm2: number;
    rainfallWeightedAreaKm2: number;
    runoffDepthMmYr: number;
    dischargeM3s: number;
    strahler: number;
    erosionDepthM: number;
    precipMm: number;
    tempC: number;
    solarFlux: number;
    biomeName: string;
    climateZone: string;
    heightAboveRiverM: number;
  } | null>(null);
  const [settingsReady, setSettingsReady] = useState<boolean>(false);
  const waterSnapshotResolversRef = useRef(
    new Map<number, (value: MountainExportWaterSurface | undefined) => void>(),
  );
  const heightmapResolversRef = useRef(
    new Map<
      number,
      (value: { width: number; height: number; data: Float32Array } | null) => void
    >(),
  );

  useEffect(() => {
    profileARef.current = profileA;
    profileBRef.current = profileB;
    const canvas = canvasRef.current;
    const raster = rasterCanvasRef.current;
    if (canvas && raster)
      drawPreviewRaster(canvas, raster, profileA, profileB);
  }, [profileA, profileB, frameVersion]);

  useEffect(() => {
    let disposed = false;
    let restartCount = 0;

    const startWorker = () => {
      const worker = new Worker(
        new URL("../rendering/mountainPreview.worker.ts", import.meta.url),
        { type: "module" },
      );
      previewWorkerRef.current = worker;
      worker.onmessage = (event: MessageEvent<MountainPreviewResponse>) => {
        const response = event.data;
        if (response.type === "backendStatus") {
          mountainBackendStatusChangeRef.current?.({
            backend: response.backend,
            reason: response.reason,
          });
          return;
        }
        if (response.type === "status") {
          if (
            response.requestId >= renderRequestIdRef.current &&
            (response.settingsRevision === undefined ||
              response.settingsRevision === settingsRevisionRef.current)
          )
            setPreviewStatus({
              phase: response.phase,
              step: response.step,
              stepIndex: response.stepIndex,
              stepCount: response.stepCount,
            });
          return;
        }
        if (response.type === "analysisReady") {
          if (response.analysisRevision !== analysisRevisionRef.current) return;
          setPreviewMetadata(response.metadata);
          if (response.flow) setPreviewFlow(response.flow);
          if (response.dem) demDataRef.current = response.dem;
          setAnalysisRevision(response.analysisRevision);
          setIsLoading(false);
          setLoadError(null);
          setPreviewError(null);
          return;
        }
        if (response.type === "frame") {
          if (
            response.analysisRevision !== analysisRevisionRef.current ||
            response.settingsRevision !== settingsRevisionRef.current ||
            response.requestId !== renderRequestIdRef.current
          ) {
            response.bitmap?.close();
            if (response.profile) {
              previewRequestSentAtRef.current.delete(response.requestId);
              logMountainProfileReport(response.profile);
            }
            return;
          }
          const displayStarted = MOUNTAIN_PROFILE_ENABLED ? performance.now() : 0;
          const raster =
            rasterCanvasRef.current ?? document.createElement("canvas");
          rasterCanvasRef.current = raster;
          raster.width = response.width;
          raster.height = response.height;
          const context = raster.getContext("2d");
          if (context) {
            if (response.bitmap) {
              context.drawImage(response.bitmap, 0, 0);
              response.bitmap.close();
            } else if (response.imageData) {
              context.putImageData(response.imageData, 0, 0);
            }
            setFrameVersion((version) => version + 1);
            const canvas = canvasRef.current;
            if (canvas) {
              drawPreviewRaster(
                canvas,
                raster,
                profileARef.current,
                profileBRef.current,
              );
            }
          }
          if (response.profile) {
            const displayedAt = performance.now();
            addMountainProfileStage(
              response.profile,
              "preview canvas drawing",
              displayedAt - displayStarted,
            );
            const sentAt = previewRequestSentAtRef.current.get(response.requestId);
            if (sentAt !== undefined) {
              addMountainProfileStage(
                response.profile,
                "request-to-display latency",
                displayedAt - sentAt,
              );
              previewRequestSentAtRef.current.delete(response.requestId);
            }
            logMountainProfileReport(response.profile);
          } else {
            previewRequestSentAtRef.current.delete(response.requestId);
          }
          setPreviewStatus(null);
          return;
        }
        if (response.type === "inspectResult") {
          if (
            response.analysisRevision === analysisRevisionRef.current &&
            response.requestId === inspectRequestIdRef.current
          )
            setHoverInfo(response.value);
          return;
        }
        if (response.type === "profileResult") {
          if (
            response.analysisRevision === analysisRevisionRef.current &&
            response.requestId === profileRequestIdRef.current
          )
            setProfileData(response.value);
          return;
        }
        if (response.type === "waterSnapshotResult") {
          const resolve = waterSnapshotResolversRef.current.get(
            response.requestId,
          );
          waterSnapshotResolversRef.current.delete(response.requestId);
          const value = response.value;
          resolve?.(
            value.wetlandPoolMask &&
              value.visualWaterMask &&
              value.wetlandPoolCoverage &&
              value.visualWaterCoverage
              ? {
                  width: value.width,
                  height: value.height,
                  wetlandPoolMask: value.wetlandPoolMask,
                  visualWaterMask: value.visualWaterMask,
                  wetlandPoolCoverage: value.wetlandPoolCoverage,
                  visualWaterCoverage: value.visualWaterCoverage,
                }
              : undefined,
          );
          return;
        }
        if (response.type === "heightmapResult") {
          const resolve = heightmapResolversRef.current.get(response.requestId);
          heightmapResolversRef.current.delete(response.requestId);
          resolve?.({
            width: response.width,
            height: response.height,
            data: response.normalizedElevation,
          });
          return;
        }
        waterSnapshotResolversRef.current.get(response.requestId)?.(undefined);
        waterSnapshotResolversRef.current.delete(response.requestId);
        heightmapResolversRef.current.get(response.requestId)?.(null);
        heightmapResolversRef.current.delete(response.requestId);
        setPreviewError(response.message);
        setPreviewStatus(null);
      };
      worker.onerror = () => {
        if (disposed) return;
        previewRequestSentAtRef.current.clear();
        worker.terminate();
        if (previewWorkerRef.current === worker) previewWorkerRef.current = null;
        if (restartCount < 1) {
          restartCount++;
          startWorker();
          setPreviewWorkerGeneration((generation) => generation + 1);
        } else {
          if (rasterCanvasRef.current) {
            setPreviewError("Mountain preview worker failed");
          } else {
            setLoadError("Mountain preview worker failed");
            setIsLoading(false);
          }
          setPreviewStatus(null);
        }
      };
    };

    startWorker();
    return () => {
      disposed = true;
      previewWorkerRef.current?.terminate();
      previewWorkerRef.current = null;
      exportWorkerRef.current?.terminate();
      exportWorkerRef.current = null;
      for (const resolve of waterSnapshotResolversRef.current.values())
        resolve(undefined);
      waterSnapshotResolversRef.current.clear();
      for (const resolve of heightmapResolversRef.current.values()) resolve(null);
      heightmapResolversRef.current.clear();
    };
  }, []);

  // Restore every configurable studio parameter before enabling persistence.
  // The readiness gate prevents the initial default render from overwriting a
  // saved style before these values have been applied.
  useEffect(() => {
    let stored: Record<string, unknown> | null = null;
    try {
      const raw = window.localStorage.getItem(MOUNTAIN_SETTINGS_STORAGE_KEY);
      const parsed: unknown = JSON.parse(raw ?? currentSettingsText);
      if (isRecord(parsed) && (parsed.version === 1 || parsed.version === 2)) stored = parsed;
    } catch {
      // Private browsing and blocked storage should not prevent the studio from loading.
    }

    if (stored) {
      setActiveLayer(
        readStoredEnum(
          stored,
          "activeLayer",
          "vegetation_patterns",
          PERSISTED_MOUNTAIN_LAYERS,
        ),
      );
      const restoredLayer = readStoredEnum(stored, "activeLayer", "vegetation_patterns", PERSISTED_MOUNTAIN_LAYERS);
      setInspectorTab(restoredLayer === "vegetation_patterns" ? "Ink" : restoredLayer === "drainage_network" ? "Water" : "Terrain");
      setActivePalette(
        readStoredEnum(
          stored,
          "activePalette",
          "swiss_topo",
          PERSISTED_MOUNTAIN_PALETTES,
        ),
      );
      setVegetationPreset(
        readStoredEnum(
          stored,
          "vegetationPreset",
          "adaptive",
          ["adaptive", "grass", "reeds", "shrub", "universal"] as const,
        ),
      );
      setVegetationSeed(readStoredNumber(stored, "vegetationSeed", 23817, 0, 2147483647, true));
      setVegetationDensity(readStoredNumber(stored, "vegetationDensity", 1, 0, INSPECTOR_BOUNDS.groundDensity));
      setVegetationPatternScale(readStoredNumber(stored, "vegetationPatternScale", 1, 0.5, INSPECTOR_BOUNDS.patternScale));
      setVegetationSwirlStrength(readStoredNumber(stored, "vegetationSwirlStrength", 0.65, 0, 1));
      setVegetationTerrainFollowing(readStoredNumber(stored, "vegetationTerrainFollowing", 0.35, 0, 1));
      setVegetationDesertDunes(readStoredBoolean(stored, "vegetationDesertDunes", DESERT_DUNE_DEFAULTS.enabled));
      setVegetationDesertDuneSpacingKm(readStoredNumber(stored, "vegetationDesertDuneSpacingKm", DESERT_DUNE_DEFAULTS.spacingKm, 0.05, 50));
      setVegetationDesertHighlight(readStoredNumber(stored, "vegetationDesertHighlight", DESERT_DUNE_DEFAULTS.highlight, 0, 1));
      setVegetationDesertWashShadow(readStoredNumber(stored, "vegetationDesertWashShadow", DESERT_DUNE_DEFAULTS.washShadow, 0, 1));
      setVegetationDesertLineBreaks(readStoredNumber(stored, "vegetationDesertLineBreaks", DESERT_DUNE_DEFAULTS.lineBreaks, 0, 1));
      setVegetationDesertDots(readStoredNumber(stored, "vegetationDesertDots", DESERT_DUNE_DEFAULTS.dots, 0, 1));
      setVegetationDesertColorVariation(readStoredNumber(stored, "vegetationDesertColorVariation", DESERT_DUNE_DEFAULTS.colorVariation, 0, 1));
      setVegetationDesertColorScaleKm(readStoredNumber(stored, "vegetationDesertColorScaleKm", DESERT_DUNE_DEFAULTS.colorScaleKm, 0.2, 200));
      setVegetationDesertSpotColor(readStoredColor(stored, "vegetationDesertSpotColor", DESERT_DEFAULT_SPOT_COLOR));
      setVegetationDesertCrestScallop(readStoredNumber(stored, "vegetationDesertCrestScallop", DESERT_DUNE_DEFAULTS.crestScallop, 0, 1));
      setVegetationDesertTerrainFollowing(readStoredNumber(stored, "vegetationDesertTerrainFollowing", DESERT_DUNE_DEFAULTS.terrainFollowing, 0, 1));
      setVegetationDesertShadowLength(readStoredNumber(stored, "vegetationDesertShadowLength", DESERT_DUNE_DEFAULTS.shadowLength, 0.05, 0.45));
      setVegetationDesertShadowStrength(readStoredNumber(stored, "vegetationDesertShadowStrength", DESERT_DUNE_DEFAULTS.shadowStrength, 0, 1));
      setVegetationDesertHatchDensity(readStoredNumber(stored, "vegetationDesertHatchDensity", DESERT_DUNE_DEFAULTS.hatchDensity, 0.25, 3));
      setVegetationDesertRippleLines(readStoredNumber(stored, "vegetationDesertRippleLines", DESERT_DUNE_DEFAULTS.rippleLines, 0, 3));
      setVegetationStrokeLength(readStoredNumber(stored, "vegetationStrokeLength", 1, 0.4, INSPECTOR_BOUNDS.strokeLength));
      setVegetationStrokeThickness(readStoredNumber(stored, "vegetationStrokeThickness", 1, 0.1, 3));
      setVegetationStrokeOpacity(readStoredNumber(stored, "vegetationStrokeOpacity", 0.72, 0, 1));
      setVegetationMountainSideRidgeDensity(
        readStoredNumber(stored, "vegetationMountainSideRidgeDensity", 1, 0, 2),
      );
      setVegetationMountainMainRidgeThickness(
        readStoredNumber(stored, "vegetationMountainMainRidgeThickness", 0.75, 0.25, 2),
      );
      setVegetationMotifDensity(readStoredNumber(stored, "vegetationMotifDensity", 0.8, 0, 1.5));
      setVegetationMotifSize(readStoredNumber(stored, "vegetationMotifSize", 1, 0.1, 5));
      const savedBiomeSettings = stored.vegetationRasterPropBiomeSettings;
      if (isRecord(savedBiomeSettings)) {
        const restored: RasterPropBiomeSettings = {};
        for (const biome of RASTER_PROP_BIOMES) {
          const entry = savedBiomeSettings[biome];
          if (!isRecord(entry)) continue;
          restored[biome] = {};
          if (typeof entry.density === "number" && Number.isFinite(entry.density))
            restored[biome]!.density = Math.max(0, entry.density);
          for (const key of ["treeDensity", "shrubDensity", "shrubTreeShare"] as const) {
            const value = entry[key];
            if (typeof value === "number" && Number.isFinite(value)) restored[biome]![key] = Math.max(0, value);
          }
          if (typeof entry.clustering === "number" && Number.isFinite(entry.clustering))
            restored[biome]!.clustering = Math.max(0, Math.min(1, entry.clustering));
          for (const key of ["treeColor", "shrubColor"] as const) {
            const value = entry[key];
            if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) restored[biome]![key] = value;
          }
        }
        setVegetationRasterPropBiomeSettings(restored);
      }
      setVegetationRasterPropDensity(
        readStoredNumber(
          stored,
          "vegetationRasterPropDensity",
          VEGETATION_RASTER_PROP_DENSITY,
          0,
          2,
        ),
      );
      setVegetationMountainBoulderDensity(
        readStoredNumber(
          stored,
          "vegetationMountainBoulderDensity",
          MOUNTAIN_BOULDER_DENSITY,
          0,
          2,
        ),
      );
      setVegetationMountainBoulderSize(
        readStoredNumber(
          stored,
          "vegetationMountainBoulderSize",
          MOUNTAIN_BOULDER_SIZE,
          0.5,
          2,
        ),
      );
      setVegetationWetlandShrubDensity(
        readStoredNumber(stored, "vegetationWetlandShrubDensity", 0.55, 0, INSPECTOR_BOUNDS.propDensity),
      );
      const storedForestScale = stored.vegetationRasterPropScale;
      if (typeof storedForestScale === "number" && Number.isFinite(storedForestScale)) {
        setVegetationRasterPropScale(storedForestScale > 0 ? storedForestScale : 1);
      } else {
        // Migrate the former pixel-valued control once. A legacy value of 16
        // becomes the map-relative 1× reference crown.
        const legacyCellSize = readStoredNumber(
          stored,
          "vegetationRasterPropCellSize",
          FOREST_TREE_REFERENCE_CELL_SIZE,
          4,
          64,
          true,
        );
        setVegetationRasterPropScale(
          Math.max(0.25, Math.min(4, legacyCellSize / FOREST_TREE_REFERENCE_CELL_SIZE)),
        );
      }
      setVegetationRasterPropClustering(
        readStoredNumber(
          stored,
          "vegetationRasterPropClustering",
          VEGETATION_RASTER_PROP_CLUSTERING,
          0,
          1,
        ),
      );
      setVegetationRasterPropStandSize(
        readStoredNumber(
          stored,
          "vegetationRasterPropStandSize",
          VEGETATION_RASTER_PROP_STAND_SIZE,
          0,
          1,
        ),
      );
      setVegetationRasterPropPlacementNoiseScale(
        readStoredNumber(
          stored,
          "vegetationRasterPropPlacementNoiseScale",
          VEGETATION_RASTER_PROP_PLACEMENT_NOISE_SCALE,
          0.25,
          4,
        ),
      );
      setVegetationInkColor(
        readStoredColor(
          stored,
          "vegetationInkColor",
          MOUNTAIN_REFERENCE_LINE_COLORS.vegetationInk,
        ),
      );
      setVegetationAridInkColor(
        readStoredColor(
          stored,
          "vegetationAridInkColor",
          MOUNTAIN_REFERENCE_LINE_COLORS.aridInk,
        ),
      );
      setForestOutlineColor(
        readStoredColor(
          stored,
          "forestOutlineColor",
          MOUNTAIN_REFERENCE_LINE_COLORS.forestOutline,
        ),
      );
      if (stored.forestSettings !== undefined)
        setForestSettings(normalizeForestRenderSettings(stored.forestSettings));
      setForestSourceZoom(readStoredNumber(stored, "forestSourceZoom", 1, 0.2, 1.5));
      setMountainHatchColor(
        readStoredColor(
          stored,
          "mountainHatchColor",
          MOUNTAIN_REFERENCE_LINE_COLORS.mountainHatch,
        ),
      );
      setMountainRidgeColor(
        readStoredColor(
          stored,
          "mountainRidgeColor",
          MOUNTAIN_REFERENCE_LINE_COLORS.mountainRidge,
        ),
      );
      const savedBiomeColors = stored.vegetationBiomeColors;
      if (isRecord(savedBiomeColors)) {
        const restored = createReferenceBiomeColorState();
        for (const biomeId of MOUNTAIN_PALETTE_BIOME_IDS) {
          const savedColor = savedBiomeColors[String(biomeId)];
          // A saved value equal to a retired default was never a deliberate
          // choice, so it takes the current default instead.
          if (
            isHexColor(savedColor) &&
            RETIRED_BIOME_DEFAULT_COLORS[biomeId] !== savedColor.toLowerCase()
          ) {
            restored[biomeId] = savedColor;
          }
        }
        setVegetationBiomeColors(restored);
      }
      setWaterShallowColor(
        readStoredColor(
          stored,
          "waterShallowColor",
          MOUNTAIN_REFERENCE_WATER_COLORS.shallow,
        ),
      );
      setWaterDeepColor(
        readStoredColor(
          stored,
          "waterDeepColor",
          MOUNTAIN_REFERENCE_WATER_COLORS.deep,
        ),
      );
      setBiomeEdgeNoiseScaleM(readStoredNumber(stored, "biomeEdgeNoiseScaleM", 800, 50, 5000));
      setVegetationBiomeTransitionStrength(
        readStoredNumber(stored, "vegetationBiomeTransitionStrength", 1, 0, INSPECTOR_BOUNDS.biomeBorder),
      );
      setVegetationFlowWashStrength(readStoredNumber(stored, "vegetationFlowWashStrength", 0.24, 0, 1));
      setVegetationFlowWashDarkStrength(readStoredNumber(stored, "vegetationFlowWashDarkStrength", 0.22, 0, 1));
      setVegetationFlowWashLightStrength(readStoredNumber(stored, "vegetationFlowWashLightStrength", 0.12, 0, 1));
      setVegetationFlowWashNoiseStrength(readStoredNumber(stored, "vegetationFlowWashNoiseStrength", 0.45, 0, 1));
      setVegetationFlowWashNoiseScale(readStoredNumber(stored, "vegetationFlowWashNoiseScale", 1, 0.5, INSPECTOR_BOUNDS.washNoiseScale));
      setVegetationWetlandDryDistanceStart(readStoredNumber(stored, "vegetationWetlandDryDistanceStart", 8, 0, 100));
      setVegetationWetlandDryDistanceEnd(readStoredNumber(stored, "vegetationWetlandDryDistanceEnd", 32, 1, INSPECTOR_BOUNDS.wetlandDryEnd));
      setVegetationWetlandDryNoiseScale(readStoredNumber(stored, "vegetationWetlandDryNoiseScale", 1.4, 0.5, 3));
      setVegetationWetlandDryNoiseStrength(readStoredNumber(stored, "vegetationWetlandDryNoiseStrength", 0.9, 0, 1));
      setVegetationShowFlowGuides(readStoredBoolean(stored, "vegetationShowFlowGuides", false));
      setVegetationMotifShadowStrength(readStoredNumber(stored, "vegetationMotifShadowStrength", 0.2, 0, 1));
      setVegetationMotifShadowDistance(readStoredNumber(stored, "vegetationMotifShadowDistance", 2.2, 0, 8));
      setVegetationMotifShadowSoftness(readStoredNumber(stored, "vegetationMotifShadowSoftness", 1.1, 0, INSPECTOR_BOUNDS.markShadowSoftness));
      setVegetationWashShadowStrength(readStoredNumber(stored, "vegetationWashShadowStrength", 0.2, 0, 1));
      setVegetationWashShadowDistance(readStoredNumber(stored, "vegetationWashShadowDistance", 2.2, 0, INSPECTOR_BOUNDS.washShadowOffset));
      setVegetationWashShadowGap(readStoredNumber(stored, "vegetationWashShadowGap", 1, 0, INSPECTOR_BOUNDS.washShadowGap));
      setVegetationWashShadowGrain(readStoredNumber(stored, "vegetationWashShadowGrain", 1, 0, 1));
      setMinElevM(readStoredNumber(stored, "minElevM", 80, 0, 10000));
      setMaxElevM(readStoredNumber(stored, "maxElevM", 3850, 1, 12000));
      setOceanElevationM(
        readStoredNumber(stored, "oceanElevationM", -10, -100, 100),
      );
      setDomainWidthKm(readStoredNumber(stored, "domainWidthKm", 45, 1, 1000));
      setOutputLongEdge(
        readStoredNumber(
          stored,
          "outputLongEdge",
          MOUNTAIN_DEFAULT_OUTPUT_LONG_EDGE,
          MIN_MOUNTAIN_RENDER_RESOLUTION,
          MAX_MOUNTAIN_RENDER_RESOLUTION,
          true,
        ),
      );
      setHeightmapSmoothingPasses(
        readStoredNumber(stored, "heightmapSmoothingPasses", 1, 0, 4, true),
      );
      setSunAzimuthDeg(readStoredNumber(stored, "sunAzimuthDeg", MOUNTAIN_DEFAULT_SUN_AZIMUTH_DEG, 0, 360));
      setSunAltitudeDeg(readStoredNumber(stored, "sunAltitudeDeg", 45, 0, 90, true));
      setMountainLightingMode(
        readStoredEnum(stored, "mountainLightingMode", "two-tone", ["two-tone", "three-tone", "continuous"] as const),
      );
      setMountainViewAngleDeg(readStoredNumber(stored, "mountainViewAngleDeg", 78, 1, 90, true));
      setMountainHeightExaggeration(
        readStoredNumber(stored, "mountainHeightExaggeration", 1, 1, 2),
      );
      setMountainLineworkScale(
        readStoredNumber(stored, "mountainLineworkScale", MOUNTAIN_LINEWORK_SCALE_DEFAULT,
          MOUNTAIN_LINEWORK_SCALE_MIN, MOUNTAIN_LINEWORK_SCALE_MAX),
      );
      setMountainLineworkOpacity(
        readStoredNumber(stored, "mountainLineworkOpacity",
          readStoredNumber(stored, "vegetationStrokeOpacity", MOUNTAIN_LINEWORK_OPACITY_DEFAULT,
            MOUNTAIN_LINEWORK_OPACITY_MIN, MOUNTAIN_LINEWORK_OPACITY_MAX),
          MOUNTAIN_LINEWORK_OPACITY_MIN, MOUNTAIN_LINEWORK_OPACITY_MAX),
      );
      const storedMountainHatchOpacity = readStoredNumber(stored, "mountainHatchOpacity",
        readStoredNumber(stored, "mountainLineworkOpacity",
          readStoredNumber(stored, "vegetationStrokeOpacity", MOUNTAIN_HATCH_OPACITY_DEFAULT,
            MOUNTAIN_HATCH_OPACITY_MIN, MOUNTAIN_HATCH_OPACITY_MAX),
          MOUNTAIN_HATCH_OPACITY_MIN, MOUNTAIN_HATCH_OPACITY_MAX),
        MOUNTAIN_HATCH_OPACITY_MIN, MOUNTAIN_HATCH_OPACITY_MAX);
      setMountainHatchOpacity(storedMountainHatchOpacity);
      // Settings saved before the split use the shared value for both families.
      setMountainHatchHorizontalOpacity(
        readStoredNumber(stored, "mountainHatchHorizontalOpacity", storedMountainHatchOpacity,
          MOUNTAIN_HATCH_OPACITY_MIN, MOUNTAIN_HATCH_OPACITY_MAX),
      );
      setMountainHatchVerticalOpacity(
        readStoredNumber(stored, "mountainHatchVerticalOpacity", storedMountainHatchOpacity,
          MOUNTAIN_HATCH_OPACITY_MIN, MOUNTAIN_HATCH_OPACITY_MAX),
      );
      setMountainHatchDensity(
        readStoredNumber(stored, "mountainHatchDensity", MOUNTAIN_HATCH_DENSITY_DEFAULT,
          MOUNTAIN_HATCH_DENSITY_MIN, MOUNTAIN_HATCH_DENSITY_MAX),
      );
      setMountainLocalDetailDensityMax(
        readStoredNumber(stored, "mountainLocalDetailDensityMax", MOUNTAIN_LOCAL_DETAIL_DENSITY_DEFAULT,
          MOUNTAIN_LOCAL_DETAIL_DENSITY_MIN, MOUNTAIN_LOCAL_DETAIL_DENSITY_MAX),
      );
      setMountainFoothillDetailMultiplier(
        readStoredNumber(stored, "mountainFoothillDetailMultiplier", MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_DEFAULT,
          MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_MIN, MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_MAX),
      );
      setMountainBiomeDetailMultiplier(
        readStoredNumber(stored, "mountainBiomeDetailMultiplier", MOUNTAIN_BIOME_DETAIL_MULTIPLIER_DEFAULT,
          MOUNTAIN_BIOME_DETAIL_MULTIPLIER_MIN, MOUNTAIN_BIOME_DETAIL_MULTIPLIER_MAX),
      );
      setMountainHatchThickness(
        readStoredNumber(stored, "mountainHatchThickness",
          readStoredNumber(stored, "vegetationStrokeThickness", MOUNTAIN_HATCH_THICKNESS_DEFAULT, MOUNTAIN_HATCH_THICKNESS_MIN, MOUNTAIN_HATCH_THICKNESS_MAX),
          MOUNTAIN_HATCH_THICKNESS_MIN, MOUNTAIN_HATCH_THICKNESS_MAX),
      );
      setMountainRidgeDensity(
        readStoredNumber(stored, "mountainRidgeDensity",
          readStoredNumber(stored, "vegetationMountainSideRidgeDensity", MOUNTAIN_RIDGE_DENSITY_DEFAULT, MOUNTAIN_RIDGE_DENSITY_MIN, MOUNTAIN_RIDGE_DENSITY_MAX),
          MOUNTAIN_RIDGE_DENSITY_MIN, MOUNTAIN_RIDGE_DENSITY_MAX),
      );
      setMountainRidgeThickness(
        readStoredNumber(stored, "mountainRidgeThickness",
          readStoredNumber(stored, "vegetationMountainMainRidgeThickness", MOUNTAIN_RIDGE_THICKNESS_DEFAULT, MOUNTAIN_RIDGE_THICKNESS_MIN, MOUNTAIN_RIDGE_THICKNESS_MAX),
          MOUNTAIN_RIDGE_THICKNESS_MIN, MOUNTAIN_RIDGE_THICKNESS_MAX),
      );
      setFullTerrainCameraEnabled(
        readStoredBoolean(stored, "fullTerrainCameraEnabled", true),
      );
      setFullTerrainCameraElevationDeg(
        readStoredNumber(stored, "fullTerrainCameraElevationDeg", 75, 1, 89, true),
      );
      setFullTerrainCameraHeightExaggeration(
        readStoredNumber(stored, "fullTerrainCameraHeightExaggeration", 1, 0.25, 3),
      );
      setFullTerrainCameraType(
        readStoredEnum(stored, "fullTerrainCameraType", "orthographic", ["orthographic", "perspective"] as const),
      );
      const storedCameraStyle = readStoredEnum(
        stored,
        "fullTerrainCameraRenderStyle",
        "compositor",
        ["study", "compositor"] as const,
      );
      setFullTerrainCameraRenderStyle(
        storedCameraStyle === "study" ? "compositor" : storedCameraStyle,
      );
      setVertExagg(readStoredNumber(stored, "vertExagg", 3.8, 1, 8));
      setHillshadeStrength(readStoredNumber(stored, "hillshadeStrength", 1, 0, 1));
      setAoStrength(readStoredNumber(stored, "aoStrength", 0.45, 0, 1));
      setShowHeightmapWater(readStoredBoolean(stored, "showHeightmapWater", false));
      setShowRivers(readStoredBoolean(stored, "showRivers", true));
      setRiverThresholdKm2(
        readStoredNumber(stored, "riverThresholdKm2", 16, 1, 200),
      );
      setShowWaterDetails(readStoredBoolean(stored, "showWaterDetails", true));
      setShowOceanDetails(readStoredBoolean(stored, "showOceanDetails", true));
      setShowWetlandPuddleContours(
        readStoredBoolean(stored, "showWetlandPuddleContours", true),
      );
      setSiltReachM(
        readStoredNumber(stored, "siltReachM", DEFAULT_SILT_REACH_M, 0, 6000),
      );
      setSiltTopRemoved(
        readStoredNumber(stored, "siltTopRemoved", DEFAULT_SILT_TOP_REMOVED, 0, 4),
      );
      setSiltLayers(
        readStoredNumber(stored, "siltLayers", DEFAULT_SILT_LAYERS, 1, Infinity, true),
      );
      setWetlandPuddleDensity(
        readStoredNumber(stored, "wetlandPuddleDensity", 0.85, 0, 2),
      );
      const storedPoolSizeMin = readStoredNumber(stored, "wetlandPuddleSizeMin", 0.1, INSPECTOR_BOUNDS.poolSizeMin, 1);
      setWetlandPuddleSizeMin(storedPoolSizeMin);
      setWetlandPuddleSizeMax(
        readStoredNumber(stored, "wetlandPuddleSizeMax", 0.6, storedPoolSizeMin, 1),
      );
      setWetlandPuddleCoastDistance(
        readStoredNumber(stored, "wetlandPuddleCoastDistance", 0, 0, 2),
      );
      setWetlandPoolContourLength(
        readStoredNumber(
          stored,
          "wetlandPoolContourLength",
          1.8,
          0.2,
          5,
        ),
      );
      setWetlandPuddleSeed(
        readStoredNumber(stored, "wetlandPuddleSeed", 23817, 0, 2147483647, true),
      );
      setOceanRippleCount(readStoredNumber(stored, "oceanRippleCount", 5, 1, 12, true));
      setDeepOceanSwells(readStoredBoolean(stored, "deepOceanSwells", true));
      setDeepOceanSwellDensity(readStoredNumber(stored, "deepOceanSwellDensity", 0.18, 0, 1.0));
      setLakeFullDepthM(readStoredNumber(stored, "lakeFullDepthM", 15, 1, 200));
      setDeepOceanWaveLength(
        readStoredNumber(
          stored,
          "deepOceanWaveLength",
          readStoredNumber(stored, "waterOutlineLength", 1, 0.2, 10),
          0.2,
          10,
        ),
      );
      setDeepOceanStrokeThickness(
        readStoredNumber(
          stored,
          "deepOceanStrokeThickness",
          readStoredNumber(stored, "waterOutlineThickness", 1, 0, 3),
          0,
          3,
        ),
      );
      setDeepOceanWaveShadingScale(
        readStoredNumber(stored, "deepOceanWaveShadingScale", 4.5, 0.5, 8),
      );
      setDeepOceanWaveShadingIntensity(
        readStoredNumber(stored, "deepOceanWaveShadingIntensity", 2.5, 0, 4),
      );
      setDeepOceanTurbulenceScale(
        readStoredNumber(stored, "deepOceanTurbulenceScale", 4.5, 0.5, 8),
      );
      setDeepOceanTurbulenceIntensity(
        readStoredNumber(stored, "deepOceanTurbulenceIntensity", 2.5, 0, INSPECTOR_BOUNDS.oceanTurbulence),
      );
      if (Array.isArray(stored.customEpicenters)) {
        const loaded: WaveEpicenter[] = (stored.customEpicenters as unknown[])
          .filter((e): e is Record<string, unknown> => isRecord(e) && typeof e.normX === "number" && typeof e.normY === "number")
          .map((e, idx) => ({
            id: typeof e.id === "string" ? e.id : `epic_${idx}`,
            normX: Math.max(0, Math.min(1, Number(e.normX))),
            normY: Math.max(0, Math.min(1, Number(e.normY))),
            strength: Math.max(0, Math.min(2.5, typeof e.strength === "number" ? e.strength : 0.5)),
            wavelength: typeof e.wavelength === "number" ? e.wavelength : undefined,
            maxRadius: typeof e.maxRadius === "number" ? e.maxRadius : undefined,
          }));
        setCustomEpicenters(loaded);
      }
      setWaterFillSmoothing(
        readStoredNumber(stored, "waterFillSmoothing", 1, 0, 4, true),
      );
      setWaterTerrainShadeStrength(
        readStoredNumber(stored, "waterTerrainShadeStrength", 0.7, 0, 1),
      );
      setWaterOutlineThickness(
        readStoredNumber(stored, "waterOutlineThickness", 1, 0, 2),
      );
      setWaterOutlineLength(
        readStoredNumber(stored, "waterOutlineLength", 1, 0.2, 10),
      );
      setWaterOutlineSmoothing(
        readStoredNumber(stored, "waterOutlineSmoothing", 1, 0, 4, true),
      );
      setWaterOutlineOpacity(
        readStoredNumber(stored, "waterOutlineOpacity", 0.92, 0, 1),
      );
      setWaterFlowDensity(
        readStoredNumber(stored, "waterFlowDensity", 0.8, 0, 2),
      );
      setWaterFlowLength(
        readStoredNumber(stored, "waterFlowLength", 0.9, 0.25, 2),
      );
      setWaterFlowThickness(
        readStoredNumber(stored, "waterFlowThickness", 1.0, 0.2, 3),
      );
      setWaterFlowSmoothing(
        readStoredNumber(stored, "waterFlowSmoothing", 1, 0, 4, true),
      );
      setWaterFlowOpacity(
        readStoredNumber(stored, "waterFlowOpacity", 0.82, 0, 1),
      );
      setWaterOutlineColor(
        readStoredColor(
          stored,
          "waterOutlineColor",
          MOUNTAIN_REFERENCE_LINE_COLORS.waterOutline,
        ),
      );
      setWaterFlowColor(
        readStoredColor(
          stored,
          "waterFlowColor",
          MOUNTAIN_REFERENCE_LINE_COLORS.waterFlow,
        ),
      );
      setWetlandElevationThresholdM(
        readStoredNumber(stored, "wetlandElevationThresholdM", 454, 0, 3000),
      );
      setBiomeRegionScaleKm(
        readStoredNumber(stored, "biomeRegionScaleKm", 0.01, 0.01, 1),
      );
      setWaterStageScale(
        readStoredNumber(stored, "waterStageScale", 0.8, 0.3, 3),
      );
      setFlowRateScale(readStoredNumber(stored, "flowRateScale", 0.9, 0.2, 1));
      setWaterLandscapeImpact(
        readStoredNumber(stored, "waterLandscapeImpact", 1, 0.1, 1),
      );
      setWaterEvolutionStep(
        readStoredNumber(stored, "waterEvolutionStep", 0, 0, MOUNTAIN_WATER_EVOLUTION_STEPS, true),
      );
      setRainOverlayOpacity(
        readStoredNumber(stored, "rainOverlayOpacity", 0, 0, 1),
      );
      setWindAzimuthDeg(
        readStoredNumber(stored, "windAzimuthDeg", 225, 0, 360),
      );
      setWindSpeedMs(readStoredNumber(stored, "windSpeedMs", 16, 0, 60));
      setBasePrecipMm(
        readStoredNumber(stored, "basePrecipMm", 1500, 100, 4000),
      );
      setBaseTemperatureC(
        readStoredNumber(stored, "baseTemperatureC", 17, -10, 30),
      );
      setShowContours(readStoredBoolean(stored, "showContours", false));
      setContourIntervalM(
        readStoredNumber(stored, "contourIntervalM", 100, 1, 1000, true),
      );
      setContourSmoothingPasses(
        readStoredNumber(stored, "contourSmoothingPasses", 0, 0, 4, true),
      );
      setContourThicknessM(
        readStoredNumber(stored, "contourThicknessM", 4, 1, 16),
      );
      setContourIndexThicknessM(
        readStoredNumber(stored, "contourIndexThicknessM", 6, 1, 20),
      );
      setShowIndexContours(
        readStoredBoolean(stored, "showIndexContours", true),
      );
      setContourIndexEvery(
        readStoredNumber(stored, "contourIndexEvery", 5, 2, 10, true),
      );
      setContourOpacity(readStoredNumber(stored, "contourOpacity", 1, 0, 1));
      setContourColor(readStoredString(stored, "contourColor", "#3c3c3c"));
      setContourIndexColor(
        readStoredString(stored, "contourIndexColor", "#282828"),
      );
      setAnimateWater(readStoredBoolean(stored, "animateWater", false));
      setZoom(readStoredNumber(stored, "zoom", MOUNTAIN_DEFAULT_VIEW_ZOOM, 0.4, 6, true));

      if (isRecord(stored.pan)) {
        setPan({
          x: readStoredNumber(stored.pan, "x", 0, -10000, 10000, true),
          y: readStoredNumber(stored.pan, "y", 0, -10000, 10000, true),
        });
      }
    }

    setSettingsReady(true);
  }, []);

  // Save changes as one debounced, versioned snapshot. This covers the full
  // style/simulation configuration rather than only the water controls.
  useEffect(() => {
    if (!settingsReady) return;

    const snapshot: MountainDetailSettingsSnapshot = {
      version: 2,
      activeLayer,
      activePalette,
      vegetationPreset,
      vegetationSeed,
      vegetationDensity,
      vegetationPatternScale,
      vegetationSwirlStrength,
      vegetationTerrainFollowing,
      vegetationDesertDunes,
      vegetationDesertDuneSpacingKm,
      vegetationDesertHighlight,
      vegetationDesertWashShadow,
      vegetationDesertLineBreaks,
      vegetationDesertDots,
      vegetationDesertColorVariation,
      vegetationDesertColorScaleKm,
      vegetationDesertSpotColor,
      vegetationDesertCrestScallop,
      vegetationDesertTerrainFollowing,
      vegetationDesertShadowLength,
      vegetationDesertShadowStrength,
      vegetationDesertHatchDensity,
      vegetationDesertRippleLines,
      vegetationStrokeLength,
      vegetationStrokeThickness,
      vegetationStrokeOpacity,
      vegetationMountainSideRidgeDensity,
      vegetationMountainMainRidgeThickness,
      vegetationMotifDensity,
      vegetationMotifSize,
      vegetationRasterPropBiomeSettings,
      vegetationRasterPropDensity,
      vegetationMountainBoulderDensity,
      vegetationMountainBoulderSize,
      vegetationWetlandShrubDensity,
      vegetationRasterPropScale,
      vegetationRasterPropClustering,
      vegetationRasterPropStandSize,
      vegetationRasterPropPlacementNoiseScale,
      forestSettings,
      forestSourceZoom,
      vegetationInkColor,
      vegetationAridInkColor,
      forestOutlineColor,
      mountainHatchColor,
      mountainRidgeColor,
      vegetationBiomeColors,
      vegetationBiomeTransitionStrength,
      biomeEdgeNoiseScaleM,
      waterShallowColor,
      waterDeepColor,
      vegetationFlowWashStrength,
      vegetationFlowWashDarkStrength,
      vegetationFlowWashLightStrength,
      vegetationFlowWashNoiseStrength,
      vegetationFlowWashNoiseScale,
      vegetationWetlandDryDistanceStart,
      vegetationWetlandDryDistanceEnd,
      vegetationWetlandDryNoiseScale,
      vegetationWetlandDryNoiseStrength,
      vegetationShowFlowGuides,
      vegetationMotifShadowStrength,
      vegetationMotifShadowDistance,
      vegetationMotifShadowSoftness,
      vegetationWashShadowStrength,
      vegetationWashShadowDistance,
      vegetationWashShadowGap,
      vegetationWashShadowGrain,
      minElevM,
      maxElevM,
      oceanElevationM,
      domainWidthKm,
      outputLongEdge,
      heightmapSmoothingPasses,
      sunAzimuthDeg,
      sunAltitudeDeg,
      mountainLightingMode,
      mountainViewAngleDeg,
      mountainHeightExaggeration,
      mountainLineworkScale,
      mountainLineworkOpacity,
      mountainHatchOpacity,
      mountainHatchHorizontalOpacity,
      mountainHatchVerticalOpacity,
      mountainHatchDensity,
      mountainLocalDetailDensityMax,
      mountainFoothillDetailMultiplier,
      mountainBiomeDetailMultiplier,
      mountainHatchThickness,
      mountainRidgeDensity,
      mountainRidgeThickness,
      fullTerrainCameraEnabled,
      fullTerrainCameraElevationDeg,
      fullTerrainCameraHeightExaggeration,
      fullTerrainCameraType,
      fullTerrainCameraRenderStyle,
      vertExagg,
      aoStrength,
      hillshadeStrength,
      showHeightmapWater,
      showRivers,
      riverThresholdKm2,
      showWaterDetails,
      showOceanDetails,
      siltReachM,
      siltTopRemoved,
      siltLayers,
      showWetlandPuddleContours,
      wetlandPuddleDensity,
      wetlandPuddleSizeMin,
      wetlandPuddleSizeMax,
      wetlandPuddleCoastDistance,
      wetlandPoolContourLength,
      wetlandPuddleSeed,
      oceanRippleCount,
      deepOceanSwells,
      deepOceanSwellDensity,
      lakeFullDepthM,
      deepOceanWaveLength,
      deepOceanStrokeThickness,
      deepOceanWaveShadingScale,
      deepOceanWaveShadingIntensity,
      deepOceanTurbulenceScale,
      deepOceanTurbulenceIntensity,
      customEpicenters,
      waterFillSmoothing,
      waterTerrainShadeStrength,
      waterOutlineThickness,
      waterOutlineLength,
      waterOutlineSmoothing,
      waterOutlineOpacity,
      waterFlowDensity,
      waterFlowLength,
      waterFlowThickness,
      waterFlowSmoothing,
      waterFlowOpacity,
      waterOutlineColor,
      waterFlowColor,
      wetlandElevationThresholdM,
      biomeRegionScaleKm,
      waterStageScale,
      flowRateScale,
      waterLandscapeImpact,
      waterEvolutionStep,
      rainOverlayOpacity,
      windAzimuthDeg,
      windSpeedMs,
      basePrecipMm,
      baseTemperatureC,
      showContours,
      contourIntervalM,
      contourSmoothingPasses,
      contourThicknessM,
      contourIndexThicknessM,
      showIndexContours,
      contourIndexEvery,
      contourOpacity,
      contourColor,
      contourIndexColor,
      animateWater,
      zoom,
      pan,
    };

    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          MOUNTAIN_SETTINGS_STORAGE_KEY,
          JSON.stringify(snapshot),
        );
      } catch {
        // Ignore quota/security errors; the in-memory controls still work.
      }
    }, 120);

    return () => window.clearTimeout(timer);
  }, [
    settingsReady,
    mountainLocalDetailDensityMax,
    mountainFoothillDetailMultiplier,
    mountainBiomeDetailMultiplier,
    activeLayer,
    activePalette,
    vegetationPreset,
    vegetationSeed,
    vegetationDensity,
    vegetationPatternScale,
    vegetationSwirlStrength,
    vegetationTerrainFollowing,
    vegetationDesertDunes,
    vegetationDesertDuneSpacingKm,
    vegetationDesertHighlight,
    vegetationDesertWashShadow,
    vegetationDesertLineBreaks,
    vegetationDesertDots,
    vegetationDesertColorVariation,
    vegetationDesertColorScaleKm,
    vegetationDesertSpotColor,
    vegetationDesertCrestScallop,
    vegetationDesertTerrainFollowing,
    vegetationDesertShadowLength,
    vegetationDesertShadowStrength,
    vegetationDesertHatchDensity,
    vegetationDesertRippleLines,
    vegetationStrokeLength,
    vegetationStrokeThickness,
    vegetationStrokeOpacity,
    vegetationMountainSideRidgeDensity,
    vegetationMountainMainRidgeThickness,
    vegetationMotifDensity,
    vegetationMotifSize,
    vegetationInkColor,
    vegetationAridInkColor,
    forestOutlineColor,
    mountainHatchColor,
    mountainRidgeColor,
    vegetationFlowWashStrength,
    vegetationFlowWashDarkStrength,
    vegetationFlowWashLightStrength,
    vegetationFlowWashNoiseStrength,
    vegetationFlowWashNoiseScale,
    vegetationWetlandDryDistanceStart,
    vegetationWetlandDryDistanceEnd,
    vegetationWetlandDryNoiseScale,
    vegetationWetlandDryNoiseStrength,
    vegetationShowFlowGuides,
    vegetationMotifShadowStrength,
    vegetationMotifShadowDistance,
    vegetationMotifShadowSoftness,
    vegetationWashShadowStrength,
    vegetationWashShadowDistance,
    vegetationWashShadowGap,
    vegetationWashShadowGrain,
    biomeEdgeNoiseScaleM,
    minElevM,
    maxElevM,
    oceanElevationM,
    domainWidthKm,
    outputLongEdge,
    heightmapSmoothingPasses,
    sunAzimuthDeg,
    sunAltitudeDeg,
    mountainLightingMode,
    mountainViewAngleDeg,
    mountainHeightExaggeration,
    mountainLineworkScale,
    mountainLineworkOpacity,
    mountainHatchOpacity,
    mountainHatchHorizontalOpacity,
    mountainHatchVerticalOpacity,
    mountainHatchDensity,
    mountainHatchThickness,
    mountainRidgeDensity,
    mountainRidgeThickness,
    fullTerrainCameraEnabled,
    fullTerrainCameraElevationDeg,
    fullTerrainCameraHeightExaggeration,
    fullTerrainCameraType,
    fullTerrainCameraRenderStyle,
    vertExagg,
    aoStrength,
    hillshadeStrength,
    showHeightmapWater,
    showRivers,
    riverThresholdKm2,
    showWaterDetails,
    showOceanDetails,
    siltReachM,
    siltTopRemoved,
    siltLayers,
    showWetlandPuddleContours,
    wetlandPuddleDensity,
    wetlandPuddleSizeMin,
    wetlandPuddleSizeMax,
    wetlandPuddleCoastDistance,
    wetlandPoolContourLength,
    wetlandPuddleSeed,
    vegetationRasterPropBiomeSettings,
    vegetationRasterPropDensity,
    vegetationMountainBoulderDensity,
    vegetationMountainBoulderSize,
    vegetationWetlandShrubDensity,
    vegetationRasterPropScale,
    vegetationRasterPropClustering,
    vegetationRasterPropStandSize,
    vegetationRasterPropPlacementNoiseScale,
    forestSettings,
    forestSourceZoom,
    vegetationBiomeColors,
    vegetationBiomeTransitionStrength,
    waterShallowColor,
    waterDeepColor,
    oceanRippleCount,
    deepOceanSwells,
    deepOceanSwellDensity,
    lakeFullDepthM,
    deepOceanWaveLength,
    deepOceanStrokeThickness,
    deepOceanWaveShadingScale,
    deepOceanWaveShadingIntensity,
    deepOceanTurbulenceScale,
    deepOceanTurbulenceIntensity,
    customEpicenters,
    waterFillSmoothing,
    waterTerrainShadeStrength,
    waterOutlineThickness,
    waterOutlineLength,
    waterOutlineSmoothing,
    waterOutlineOpacity,
    waterFlowDensity,
    waterFlowLength,
    waterFlowThickness,
    waterFlowSmoothing,
    waterFlowOpacity,
    waterOutlineColor,
    waterFlowColor,
    wetlandElevationThresholdM,
    biomeRegionScaleKm,
    waterStageScale,
    flowRateScale,
    waterLandscapeImpact,
    waterEvolutionStep,
    rainOverlayOpacity,
    windAzimuthDeg,
    windSpeedMs,
    basePrecipMm,
    baseTemperatureC,
    showContours,
    contourIntervalM,
    contourSmoothingPasses,
    contourThicknessM,
    contourIndexThicknessM,
    showIndexContours,
    contourIndexEvery,
    contourOpacity,
    contourColor,
    contourIndexColor,
    animateWater,
    zoom,
    pan,
  ]);

  const outputSize = rawLuminance
    ? getHeightmapFitResolution(
        rawLuminance.width,
        rawLuminance.height,
        outputLongEdge,
      )
    : null;
  // Preview analysis is intentionally independent from export resolution. An
  // 8K selection must never make the live map allocate an 8K/16K DEM.
  const analysisLongEdge = MOUNTAIN_PREVIEW_ANALYSIS_LONG_EDGE;

  // 1. Initial Load of Mountain Heightmap Image Base
  useEffect(() => {
    const requestId = ++sourceLoadIdRef.current;
    setIsLoading(true);
    setLoadError(null);

    loadHeightmapImage(defaultHeightmapUrl)
      .then(({ width, height, rawLuminance: data, oceanMask }) => {
        if (requestId !== sourceLoadIdRef.current) return;
        setRawLuminance({ width, height, data: calibrateBundledMountainHeightmap(data), oceanMask });
        setHeightmapSourceName("nz-linz-dem.tif");
        setHeightmapMetadata(null);
      })
      .catch((err) => {
        if (requestId !== sourceLoadIdRef.current) return;
        console.error("Failed to load mountain heightmap base:", err);
        setLoadError(err.message || "Failed to load heightmap image base");
        setIsLoading(false);
      });
  }, []);

  /** Stops work on the previous source; returns the id that later results must still match. */
  const beginHeightmapLoad = () => {
    exportWorkerRef.current?.terminate();
    exportWorkerRef.current = null;
    setExportProgress(null);
    setIsLoading(true);
    setLoadError(null);
    return ++sourceLoadIdRef.current;
  };

  /** Sets valley floor, summit and map width to a georeferenced heightmap's real values. */
  const applyHeightmapScale = (metadata: HeightmapGeoMetadata) => {
    const floor = Math.round(metadata.minElevationM);
    setMinElevM(floor);
    setMaxElevM(Math.max(floor + 1, Math.round(metadata.maxElevationM)));
    setDomainWidthKm(Math.round(metadata.widthKm * 100) / 100);
  };

  /** Shows a user-chosen heightmap; a georeferenced one also sets its real width and relief. */
  const applyLoadedHeightmap = (
    { width, height, rawLuminance: data, oceanMask, metadata }: HeightmapRaster,
    sourceName: string,
  ) => {
    setRawLuminance({ width, height, data, oceanMask });
    setHeightmapSourceName(sourceName);
    setHeightmapMetadata(metadata ?? null);
    if (metadata) applyHeightmapScale(metadata);
  };

  const handleHeightmapFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    const requestId = beginHeightmapLoad();
    loadHeightmapFile(file)
      .then((raster) => {
        if (requestId !== sourceLoadIdRef.current) return;
        applyLoadedHeightmap(raster, file.name);
      })
      .catch((err: unknown) => {
        if (requestId !== sourceLoadIdRef.current) return;
        const message =
          err instanceof Error ? err.message : "Failed to load heightmap file";
        setLoadError(message);
        setIsLoading(false);
      });
  };

  const handleGlobalDemLoad = (raster: HeightmapRaster, sourceName: string) => {
    beginHeightmapLoad();
    applyLoadedHeightmap(raster, sourceName);
    setGlobalDemOpen(false);
  };

  useEffect(() => {
    let cancelled = false;
    loadVegetationMotifAssets()
      .then((assets) => {
        if (!cancelled) setVegetationMotifAssets(assets);
      })
      .catch((error) => {
        if (!cancelled) {
          setVegetationMotifLoadError(
            error instanceof Error
              ? error.message
              : "Failed to load vegetation motifs",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadMountainDetailPropAssets()
      .then((assets) => {
        if (!cancelled) setRasterPropAssets(assets);
      })
      .catch((error) => {
        if (!cancelled) {
          setRasterPropLoadError(
            error instanceof Error
              ? error.message
              : "Failed to load raster vegetation props",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!previewWorkerRef.current) return;
    const request: MountainPreviewRequest = {
      type: "assets",
      vegetationMotifs: vegetationMotifAssets,
      rasterProps: rasterPropAssets,
    };
    previewWorkerRef.current.postMessage(request);
  }, [
    vegetationMotifAssets,
    rasterPropAssets,
    previewWorkerGeneration,
  ]);

  // Send the source once per load/restart. The worker retains its own copy so
  // subsequent control changes carry configuration only.
  useEffect(() => {
    if (!rawLuminance) return;
    previewRequestSentAtRef.current.clear();
    const request: MountainPreviewRequest = {
      type: "source",
      sourceRevision: sourceLoadIdRef.current,
      source: {
        width: rawLuminance.width,
        height: rawLuminance.height,
        luminance: rawLuminance.data.slice(),
        oceanMask: rawLuminance.oceanMask?.slice(),
      },
    };
    previewWorkerRef.current?.postMessage(request);
  }, [rawLuminance, previewWorkerGeneration]);

  // Scientific controls commit on release. Lighting is intentionally live:
  // the worker's lighting stage reuses terrain, routing, climate, and biomes.
  useEffect(() => {
    if (!rawLuminance || !previewWorkerRef.current) return;
    exportWorkerRef.current?.terminate();
    exportWorkerRef.current = null;
    setExportProgress(null);
    const nextAnalysisRevision = analysisRevisionRef.current + 1;
    analysisRevisionRef.current = nextAnalysisRevision;
    const requestId = ++previewRequestIdRef.current;
    const request: MountainPreviewRequest = {
      type: "analyze",
      requestId,
      sourceRevision: sourceLoadIdRef.current,
      analysisRevision: nextAnalysisRevision,
      analysisLongEdge,
      heightmapSmoothingPasses,
      profile: MOUNTAIN_PROFILE_ENABLED,
      options: {
        domainWidthKm,
        // Keep the physical DEM footprint proportional to the source map. The
        // base DEM fallback is 45 km high, which stretches a persisted wider
        // map into a shallow strip when the full-terrain camera is enabled.
        domainHeightKm:
          domainWidthKm * (rawLuminance.height / Math.max(1, rawLuminance.width)),
        minElevationM: minElevM,
        maxElevationM: maxElevM,
        oceanElevationM,
        sunAzimuthDeg,
        sunAltitudeDeg,
        verticalExaggeration: vertExagg,
        windAzimuthDeg,
        windSpeedMs,
        basePrecipitationMmYr: basePrecipMm,
        baseTemperatureC,
        riverThresholdKm2,
        wetlandElevationThresholdM,
        biomeRegionScaleKm,
        biomeEdgeNoiseScaleM,
        biomeEdgeStrength: vegetationBiomeTransitionStrength,
        waterStageScale,
        // A river widens as it matures: each evolution step raises the bank-full stage.
        waterStageGrowthPerStep: 0.125,
        flowRateScale,
        erosionStrength: waterLandscapeImpact,
        erosionIterations: waterEvolutionStep,
        erosionTimeScale: 1,
      },
    };
    previewWorkerRef.current.postMessage(request);
  }, [
    rawLuminance,
    analysisCommitVersion,
    sunAzimuthDeg,
    sunAltitudeDeg,
    vertExagg,
    previewWorkerGeneration,
  ]);

  // 3. Render DEM to Canvas 2D
  useEffect(() => {
    if (!demData) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const targetWidth = demData.width;
    const targetHeight = demData.height;

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const previewWorker = previewWorkerRef.current;
    const previewRiverThreshold =
      previewMetadata?.riverThresholdKm2 ?? riverThresholdKm2;
    const visualWaterDem = previewWorker
      ? demData
      : buildVisualWaterSurfaceDEM(demData, {
          enabled: showWetlandPuddleContours,
          density: wetlandPuddleDensity,
          sizeMin: wetlandPuddleSizeMin,
          sizeMax: wetlandPuddleSizeMax,
          coastDistance: wetlandPuddleCoastDistance,
          seed: wetlandPuddleSeed,
          riverThresholdKm2: previewRiverThreshold,
          siltReachM,
          siltTopRemoved,
        });

    const renderOpts: MountainRenderOptions = {
      layer: activeLayer,
      palette: activePalette,
      gpuRenderMode: MOUNTAIN_GPU_RENDER_MODE,
      sunAzimuthDeg,
      sunAltitudeDeg,
      windAzimuthDeg,
      mountainLightingMode,
      // A full-terrain camera replaces the selective mountain-only lift so
      // the same elevation is not applied twice.
      mountainViewAngleDeg: terrainCameraActive ? 90 : mountainViewAngleDeg,
      mountainHeightExaggeration: terrainCameraActive ? 1 : mountainHeightExaggeration,
      mountainLineworkScale,
      mountainLineworkOpacity,
      mountainHatchOpacity,
      mountainHatchHorizontalOpacity,
      mountainHatchVerticalOpacity,
      mountainHatchDensity,
      mountainLocalDetailDensityMax,
      mountainFoothillDetailMultiplier,
      mountainBiomeDetailMultiplier,
      mountainHatchThickness,
      mountainRidgeDensity,
      mountainRidgeThickness,
      mountainHatchColor,
      mountainRidgeColor,
      fullTerrainCameraElevationDeg: terrainCameraActive
        ? fullTerrainCameraElevationDeg
        : undefined,
      fullTerrainCameraHeightExaggeration: terrainCameraActive
        ? fullTerrainCameraHeightExaggeration
        : undefined,
      fullTerrainCameraType: terrainCameraActive
        ? fullTerrainCameraType
        : undefined,
      // Legacy saved "study" values are deliberately ignored. The camera
      // always receives the finished colored compositor image.
      fullTerrainCameraRenderStyle: terrainCameraActive
        ? "compositor"
        : undefined,
      // Keep the complete cartographic snow transport enabled in the live
      // full-terrain pass; the renderer's validated default is 100 steps.
      snowRedistributionSteps: MOUNTAIN_SNOW_REDISTRIBUTION_STEPS_DEFAULT,
      verticalExaggeration: vertExagg,
      ambientOcclusionStrength: aoStrength,
      hillshadeStrength,
      showHeightmapWater,
      showRivers,
      riverThresholdKm2: previewRiverThreshold,
      showWaterDetails,
      showOceanDetails,
      oceanRippleCount,
      deepOceanSwells,
      deepOceanSwellDensity,
      lakeFullDepthM,
      deepOceanWaveLength,
      deepOceanStrokeThickness,
      deepOceanWaveShadingScale,
      deepOceanWaveShadingIntensity,
      deepOceanTurbulenceScale,
      deepOceanTurbulenceIntensity,
      customEpicenters,
      siltReachM,
      siltTopRemoved,
      siltLayers,
      wetlandPuddleContours: showWetlandPuddleContours,
      wetlandPuddleDensity,
      wetlandPuddleSizeMin,
      wetlandPuddleSizeMax,
      wetlandPuddleCoastDistance,
      wetlandPoolContourLength,
      wetlandPuddleSeed,
      waterFillSmoothing,
      waterTerrainShadeStrength,
      waterOutlineThickness,
      waterOutlineLength,
      waterOutlineSmoothing,
      waterOutlineOpacity,
      waterFlowDensity,
      waterFlowLength,
      waterFlowThickness,
      waterFlowSmoothing,
      waterFlowOpacity,
      waterOutlineColor,
      waterFlowColor,
      vegetationBiomeColors,
      vegetationBiomeTransitionStrength,
      waterShallowColor,
      waterDeepColor,
      erosionOverlayOpacity: 0,
      rainOverlayOpacity: viewRainOpacity,
      showContours,
      contourIntervalM,
      contourSmoothingPasses,
      contourThicknessM,
      contourIndexThicknessM,
      showIndexContours,
      contourIndexEvery,
      contourOpacity,
      contourColor,
      contourIndexColor,
      vegetation: {
        preset: "adaptive",
        seed: vegetationSeed,
        density: vegetationDensity,
        patternScale: vegetationPatternScale,
        swirlStrength: vegetationSwirlStrength,
        terrainFollowing: vegetationTerrainFollowing,
        desertDunes: vegetationDesertDunes,
        desertDuneSpacingKm: vegetationDesertDuneSpacingKm,
        // Crests run across the climate wind (Terrain › Climate › Wind direction).
        desertWindFromDeg: windAzimuthDeg,
        desertHighlight: vegetationDesertHighlight,
        desertWashShadow: vegetationDesertWashShadow,
        desertLineBreaks: vegetationDesertLineBreaks,
        desertDots: vegetationDesertDots,
        desertColorVariation: vegetationDesertColorVariation,
        desertColorScaleKm: vegetationDesertColorScaleKm,
        desertSpotColor: vegetationDesertSpotColor,
        desertCrestScallop: vegetationDesertCrestScallop,
        desertTerrainFollowing: vegetationDesertTerrainFollowing,
        desertShadowLength: vegetationDesertShadowLength,
        desertShadowStrength: vegetationDesertShadowStrength,
        desertHatchDensity: vegetationDesertHatchDensity,
        desertRippleLines: vegetationDesertRippleLines,
        strokeLength: vegetationStrokeLength,
        strokeThickness: vegetationStrokeThickness,
        strokeOpacity: vegetationStrokeOpacity,
        mountainSideRidgeDensity: vegetationMountainSideRidgeDensity,
        mountainMainRidgeThickness: vegetationMountainMainRidgeThickness,
        motifDensity: vegetationMotifDensity,
        motifSize: vegetationMotifSize,
      rasterPropAssets: rasterPropAssets ?? undefined,
      rasterPropBiomeSettings: vegetationRasterPropBiomeSettings,
      rasterPropDensity: vegetationRasterPropDensity,
      mountainBoulderDensity: 0,
      mountainBoulderSize: vegetationMountainBoulderSize,
      wetlandShrubDensity: vegetationWetlandShrubDensity,
      rasterPropCellSize: FOREST_TREE_REFERENCE_CELL_SIZE,
      rasterPropScale: vegetationRasterPropScale,
      rasterPropClustering: vegetationRasterPropClustering,
      rasterPropStandSize: vegetationRasterPropStandSize,
      rasterPropPlacementNoiseScale: vegetationRasterPropPlacementNoiseScale,
      forestSettings: {
        ...forestSettings,
        seed: vegetationSeed,
        sunAzimuthDeg,
        outlineColor: forestOutlineColor,
      },
        inkColor: vegetationInkColor,
        aridInkColor: vegetationAridInkColor,
        flowWashStrength: vegetationFlowWashStrength,
        flowWashDarkStrength: vegetationFlowWashDarkStrength,
        flowWashLightStrength: vegetationFlowWashLightStrength,
        flowWashNoiseStrength: vegetationFlowWashNoiseStrength,
        flowWashNoiseScale: vegetationFlowWashNoiseScale,
        wetlandDryDistanceStart: vegetationWetlandDryDistanceStart,
        wetlandDryDistanceEnd: vegetationWetlandDryDistanceEnd,
        wetlandDryNoiseScale: vegetationWetlandDryNoiseScale,
        wetlandDryNoiseStrength: vegetationWetlandDryNoiseStrength,
        showFlowGuides: vegetationShowFlowGuides,
        showWetlandDrynessOverlay: vegetationShowWetlandDrynessOverlay,
        showAlpineTreeSuitabilityOverlay: vegetationShowAlpineTreeSuitability,
        motifShadowStrength: vegetationMotifShadowStrength,
        motifShadowDistance: vegetationMotifShadowDistance,
        motifShadowSoftness: vegetationMotifShadowSoftness,
        washShadowStrength: vegetationWashShadowStrength,
        washShadowDistance: vegetationWashShadowDistance,
        washShadowGap: vegetationWashShadowGap,
        washShadowGrain: vegetationWashShadowGrain,
        motifAssets: vegetationMotifAssets ?? undefined,
      },
    };

    if (previewWorker) {
      const finalRequestId = ++previewRequestIdRef.current;
      const settingsRevision = ++settingsRevisionRef.current;
      // The final compositor now uses a bounded 1536px internal raster and
      // publishes a 2048px frame. Sending a separate 768px draft would repeat
      // the complete water, vegetation, mountain-pattern, and illustration
      // pipelines before the final request can run on this single worker.
      renderRequestIdRef.current = finalRequestId;
      setPreviewStatus({
        phase: activeLayer === "vegetation_patterns" ? "vegetation" : "rendering",
      });
      const baseOptions: MountainRenderOptions = {
        ...renderOpts,
        vegetation: renderOpts.vegetation
            ? {
              ...renderOpts.vegetation,
              motifAssets: undefined,
              rasterPropAssets: undefined,
            }
          : undefined,
      };
      const makeRequest = (
        requestId: number,
        quality: "draft" | "final",
      ): MountainPreviewRequest => ({
        type: "render",
        requestId,
        settingsRevision,
        analysisRevision,
        quality,
        profile: MOUNTAIN_PROFILE_ENABLED,
        options: baseOptions,
      });
      const finalTimer = window.setTimeout(() => {
        // A newer settings revision owns the worker. Do not allow an old
        // final timer to publish an obsolete frame.
        if (renderRequestIdRef.current !== finalRequestId) return;
        const finalRequest = makeRequest(finalRequestId, "final");
        if (MOUNTAIN_PROFILE_ENABLED)
          previewRequestSentAtRef.current.set(finalRequestId, performance.now());
        previewWorker.postMessage(finalRequest);
      }, 350);
      return () => {
        window.clearTimeout(finalTimer);
      };
    }

    const fallbackProfiler = MOUNTAIN_PROFILE_ENABLED
      ? createMountainProfiler(true, {
          requestId: renderRequestIdRef.current,
          width: visualWaterDem.width,
          height: visualWaterDem.height,
          layer: renderOpts.layer,
          changedSettings: ["fallback renderer"],
        })
      : undefined;
    try {
      const imgData = renderMountainDetailDEM(visualWaterDem, renderOpts, fallbackProfiler);
      const rasterCanvas =
        rasterCanvasRef.current ?? document.createElement("canvas");
      rasterCanvasRef.current = rasterCanvas;
      rasterCanvas.width = imgData.width;
      rasterCanvas.height = imgData.height;
      const rasterCtx = rasterCanvas.getContext("2d");
      if (!rasterCtx) {
        fallbackProfiler?.finish("failed");
        return;
      }
      const drawStarted = MOUNTAIN_PROFILE_ENABLED ? performance.now() : 0;
      rasterCtx.putImageData(imgData, 0, 0);

      // Keep the live raster at the bounded analysis resolution. Export uses a
      // separate worker and never changes this canvas size.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, targetWidth, targetHeight);
      ctx.drawImage(rasterCanvas, 0, 0, targetWidth, targetHeight);
      const fallbackProfile = fallbackProfiler?.finish("completed", false);
      if (fallbackProfile) {
        addMountainProfileStage(fallbackProfile, "preview canvas drawing", performance.now() - drawStarted);
        logMountainProfileReport(fallbackProfile);
      }
    } catch (error) {
      fallbackProfiler?.finish("failed");
      throw error;
    }

    // Draw Cross-Section Profile Line if present
    if (profileA && profileB) {
      ctx.save();
      const x0 = profileA.x * targetWidth;
      const y0 = profileA.y * targetHeight;
      const x1 = profileB.x * targetWidth;
      const y1 = profileB.y * targetHeight;

      // Glow outline
      ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      // Dashed Line
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      // Point A marker (Start)
      ctx.fillStyle = "#10b981";
      ctx.beginPath();
      ctx.arc(x0, y0, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Point B marker (End)
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(x1, y1, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.restore();
    }

    // Draw Interactive Epicenter Markers on Canvas
    if (EPICENTER_WAVES_ENABLED && deepOceanSwells && customEpicenters.length > 0) {
      ctx.save();
      const scaleFactor = 1;
      customEpicenters.forEach((epic, idx) => {
        const cx = epic.normX * targetWidth;
        const cy = epic.normY * targetHeight;
        const isSelected = epic.id === selectedEpicenterId;
        const isDragging = epic.id === draggingEpicenterId;

        // Outer wave influence dashed ring
        ctx.beginPath();
        ctx.arc(cx, cy, 18 * scaleFactor, 0, Math.PI * 2);
        ctx.strokeStyle = isSelected ? "rgba(251, 191, 36, 0.95)" : "rgba(56, 189, 248, 0.75)";
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Inner solid handle dot
        ctx.beginPath();
        ctx.arc(cx, cy, (isDragging ? 7 : 5.5) * scaleFactor, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? "#f59e0b" : "#0284c7";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2 * scaleFactor;
        ctx.stroke();

        // Badge label
        ctx.font = `bold ${Math.max(10, Math.round(11 * scaleFactor))}px ui-monospace, SFMono-Regular, monospace`;
        ctx.fillStyle = isSelected ? "#fef08a" : "#ffffff";
        ctx.textAlign = "center";
        ctx.shadowColor = "rgba(0, 0, 0, 0.95)";
        ctx.shadowBlur = 4;
        ctx.fillText(`E${idx + 1} (${Math.round(epic.strength * 100)}%)`, cx, cy - 14 * scaleFactor);
        ctx.shadowBlur = 0;
      });
      ctx.restore();
    }
  }, [
    demData,
    previewMetadata,
    activeLayer,
    activePalette,
    sunAzimuthDeg,
    sunAltitudeDeg,
    mountainLightingMode,
    mountainViewAngleDeg,
    mountainHeightExaggeration,
    mountainLineworkScale,
    mountainLineworkOpacity,
    mountainHatchOpacity,
    mountainHatchHorizontalOpacity,
    mountainHatchVerticalOpacity,
    mountainHatchDensity,
    mountainLocalDetailDensityMax,
    mountainFoothillDetailMultiplier,
    mountainBiomeDetailMultiplier,
    mountainHatchThickness,
    mountainRidgeDensity,
    mountainRidgeThickness,
    mountainHatchColor,
    mountainRidgeColor,
    fullTerrainCameraEnabled,
    fullTerrainCameraElevationDeg,
    fullTerrainCameraHeightExaggeration,
    fullTerrainCameraType,
    fullTerrainCameraRenderStyle,
    vertExagg,
    aoStrength,
    hillshadeStrength,
    showHeightmapWater,
    showRivers,
    showWaterDetails,
    showOceanDetails,
    oceanRippleCount,
    deepOceanSwells,
    deepOceanSwellDensity,
    lakeFullDepthM,
    deepOceanWaveLength,
    deepOceanStrokeThickness,
    deepOceanWaveShadingScale,
    deepOceanWaveShadingIntensity,
    deepOceanTurbulenceScale,
    deepOceanTurbulenceIntensity,
    customEpicenters,
    siltReachM,
    siltTopRemoved,
    siltLayers,
    showWetlandPuddleContours,
    wetlandPuddleDensity,
    wetlandPuddleSizeMin,
    wetlandPuddleSizeMax,
    wetlandPuddleCoastDistance,
    wetlandPoolContourLength,
    wetlandPuddleSeed,
    vegetationRasterPropBiomeSettings,
    vegetationRasterPropDensity,
    vegetationMountainBoulderDensity,
    vegetationMountainBoulderSize,
    vegetationWetlandShrubDensity,
    vegetationRasterPropScale,
    vegetationRasterPropClustering,
    vegetationRasterPropStandSize,
    vegetationRasterPropPlacementNoiseScale,
    forestSettings,
    waterFillSmoothing,
    waterTerrainShadeStrength,
    waterOutlineThickness,
    waterOutlineLength,
    waterOutlineSmoothing,
    waterOutlineOpacity,
    waterFlowDensity,
    waterFlowLength,
    waterFlowThickness,
    waterFlowSmoothing,
    waterFlowOpacity,
    waterOutlineColor,
    waterFlowColor,
    vegetationBiomeColors,
    vegetationBiomeTransitionStrength,
    waterShallowColor,
    waterDeepColor,
    rainOverlayOpacity,
    showContours,
    contourIntervalM,
    contourSmoothingPasses,
    contourThicknessM,
    contourIndexThicknessM,
    showIndexContours,
    contourIndexEvery,
    contourOpacity,
    contourColor,
    contourIndexColor,
    vegetationMotifAssets,
    rasterPropAssets,
    vegetationPreset,
    vegetationSeed,
    vegetationDensity,
    vegetationPatternScale,
    vegetationSwirlStrength,
    vegetationTerrainFollowing,
    vegetationDesertDunes,
    vegetationDesertDuneSpacingKm,
    windAzimuthDeg,
    vegetationDesertHighlight,
    vegetationDesertWashShadow,
    vegetationDesertLineBreaks,
    vegetationDesertDots,
    vegetationDesertColorVariation,
    vegetationDesertColorScaleKm,
    vegetationDesertSpotColor,
    vegetationDesertCrestScallop,
    vegetationDesertTerrainFollowing,
    vegetationDesertShadowLength,
    vegetationDesertShadowStrength,
    vegetationDesertHatchDensity,
    vegetationDesertRippleLines,
    vegetationStrokeLength,
    vegetationStrokeThickness,
    vegetationStrokeOpacity,
    vegetationMountainSideRidgeDensity,
    vegetationMountainMainRidgeThickness,
    vegetationMotifDensity,
    vegetationMotifSize,
    vegetationInkColor,
    vegetationAridInkColor,
    forestOutlineColor,
    vegetationFlowWashStrength,
    vegetationFlowWashDarkStrength,
    vegetationFlowWashLightStrength,
    vegetationFlowWashNoiseStrength,
    vegetationFlowWashNoiseScale,
    vegetationWetlandDryDistanceStart,
    vegetationWetlandDryDistanceEnd,
    vegetationWetlandDryNoiseScale,
    vegetationWetlandDryNoiseStrength,
    vegetationShowFlowGuides,
    vegetationShowWetlandDrynessOverlay,
    vegetationShowAlpineTreeSuitability,
    vegetationMotifShadowStrength,
    vegetationMotifShadowDistance,
    vegetationMotifShadowSoftness,
    vegetationWashShadowStrength,
    vegetationWashShadowDistance,
    vegetationWashShadowGap,
    vegetationWashShadowGrain,
    analysisRevision,
  ]);

  // 4. Streamflow Animated Water Droplets on Overlay Canvas
  useEffect(() => {
    if (!demData) return;
    const pCanvas = particleCanvasRef.current;
    if (!pCanvas) return;

    const flow = previewFlow;
    const targetWidth = flow?.width ?? demData.width;
    const targetHeight = flow?.height ?? demData.height;
    const scaleX = targetWidth / demData.width;
    const scaleY = targetHeight / demData.height;

    if (pCanvas.width !== targetWidth || pCanvas.height !== targetHeight) {
      pCanvas.width = targetWidth;
      pCanvas.height = targetHeight;
    }

    const ctx = pCanvas.getContext("2d");
    if (!ctx) return;

    if (!animateWater && particlesRef.current.length === 0) {
      ctx.clearRect(0, 0, targetWidth, targetHeight);
      return;
    }

    let animId: number;

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

    function stepParticles() {
      if (!demData || !ctx || !pCanvas) return;

      // Clear the overlay canvas every single frame
      ctx.clearRect(0, 0, targetWidth, targetHeight);

      // Spawn background particles only if animateWater toggle is enabled
      if (animateWater && particlesRef.current.length < 90) {
        for (let i = 0; i < 2; i++) {
          const rx = Math.floor(Math.random() * demData.width);
          const ry = Math.floor(Math.random() * (demData.height * 0.35));
          const idx = ry * demData.width + rx;
          if (
            (flow?.isRiverChannel[idx] ?? demData.isRiverChannel[idx]) ||
            (flow?.slopeDeg[idx] ?? demData.slopeDeg[idx]) > 15.0
          ) {
            particlesRef.current.push({
              x: rx,
              y: ry,
              vx: 0,
              vy: 0,
              age: 0,
              maxAge: 160 + Math.random() * 80,
            });
          }
        }
      }

      for (let i = particlesRef.current.length - 1; i >= 0; i--) {
        const p = particlesRef.current[i];
        p.age++;

        if (
          p.age > p.maxAge ||
          p.x < 0 ||
          p.x >= demData.width ||
          p.y < 0 ||
          p.y >= demData.height
        ) {
          particlesRef.current.splice(i, 1);
          continue;
        }

        const ix = Math.max(0, Math.min(demData.width - 1, Math.floor(p.x)));
        const iy = Math.max(0, Math.min(demData.height - 1, Math.floor(p.y)));
        const idx = iy * demData.width + ix;
        const dir = flow?.flowDirection[idx] ?? demData.flowDirection[idx];

        if (dir >= 0) {
          const targetDx = d8Offsets[dir][0];
          const targetDy = d8Offsets[dir][1];
          p.vx = p.vx * 0.3 + targetDx * 0.7;
          p.vy = p.vy * 0.3 + targetDy * 0.7;
        } else {
          // A sink is not a hidden vertical waterfall. Remove the droplet so
          // animated water never leaves the routed drainage network.
          particlesRef.current.splice(i, 1);
          continue;
        }

        const particleSpeed = 1.8 * flowRateScale;
        p.x += p.vx * particleSpeed;
        p.y += p.vy * particleSpeed;

        const alpha = Math.max(0.0, 1.0 - p.age / p.maxAge);
        ctx.fillStyle = `rgba(56, 189, 248, ${alpha * 0.9})`;
        const r = (flow?.strahlerOrder[idx] ?? demData.strahlerOrder[idx]) >= 4 ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.arc(
          p.x * scaleX,
          p.y * scaleY,
          r * Math.min(scaleX, scaleY),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }

      if (animateWater || particlesRef.current.length > 0) {
        animId = requestAnimationFrame(stepParticles);
      }
    }

    animId = requestAnimationFrame(stepParticles);

    return () => {
      cancelAnimationFrame(animId);
      if (ctx) ctx.clearRect(0, 0, targetWidth, targetHeight);
    };
  }, [animateWater, demData, previewFlow, flowRateScale]);

  // Canvas Mouse & Click Interaction Handlers
  function getCanvasRelativeCoords(e: React.MouseEvent<HTMLElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { xRatio: 0, yRatio: 0, px: 0, py: 0 };
    const rect = canvas.getBoundingClientRect();
    const xRatio = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    const yRatio = Math.max(
      0,
      Math.min(1, (e.clientY - rect.top) / rect.height),
    );
    const width = demData?.width ?? 1;
    const height = demData?.height ?? 1;
    const px = Math.min(width - 1, Math.floor(xRatio * width));
    const py = Math.min(height - 1, Math.floor(yRatio * height));
    return { xRatio, yRatio, px, py };
  }

  function handleCanvasMouseMove(e: React.MouseEvent<HTMLElement>) {
    if (!demData) return;

    if (isPanning) {
      const dx = e.clientX - panStartRef.current.mouseX;
      const dy = e.clientY - panStartRef.current.mouseY;
      setPan({
        x: panStartRef.current.startPanX + dx,
        y: panStartRef.current.startPanY + dy,
      });
      return;
    }

    if (regionDraft) {
      const { xRatio, yRatio } = getCanvasRelativeCoords(e);
      setRegionDraft({ ...regionDraft, x1: xRatio, y1: yRatio });
      return;
    }

    const { px, py } = getCanvasRelativeCoords(e);
    const idx = py * demData.width + px;

    setHoverInfo({
      x: px,
      y: py,
      elevM: demData.elevation[idx],
      slopeDeg: demData.slopeDeg[idx],
      aspectDeg: demData.aspectDeg[idx],
      drainageAreaKm2: demData.drainageAreaKm2[idx],
      rainfallWeightedAreaKm2: demData.rainfallWeightedAreaKm2[idx],
      runoffDepthMmYr: demData.runoffDepthMmYr[idx],
      dischargeM3s: demData.dischargeM3s[idx],
      strahler: demData.strahlerOrder[idx],
      erosionDepthM: demData.erosionDepthM[idx],
      precipMm: demData.precipitationMmYr[idx],
      tempC: demData.temperatureC[idx],
      solarFlux: demData.solarInsolation[idx],
      biomeName: getMountainBiomeLabel(demData.biomeType[idx]),
      climateZone: getMountainClimateZoneLabel(demData, idx),
      heightAboveRiverM: demData.heightAboveDrainageM?.[idx] ?? Number.POSITIVE_INFINITY,
    });

    if (isDrawingProfile && profileA) {
      const { xRatio, yRatio } = getCanvasRelativeCoords(e);
      setProfileB({ x: xRatio, y: yRatio });
    }

    if (draggingEpicenterId) {
      const { xRatio, yRatio } = getCanvasRelativeCoords(e);
      const clampedX = Math.max(0.01, Math.min(0.99, xRatio));
      const clampedY = Math.max(0.01, Math.min(0.99, yRatio));
      setCustomEpicenters((prev) =>
        prev.map((epic) =>
          epic.id === draggingEpicenterId
            ? { ...epic, normX: clampedX, normY: clampedY }
            : epic
        )
      );
    }
  }

  function handleCanvasMouseDown(e: React.MouseEvent<HTMLElement>) {
    if (activeTool === "pan" || e.button === 1) {
      setIsPanning(true);
      panStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        startPanX: pan.x,
        startPanY: pan.y,
      };
      return;
    }

    const { xRatio, yRatio } = getCanvasRelativeCoords(e);
    if (activeTool === "region") {
      if (!exportProgress) setRegionDraft({ x0: xRatio, y0: yRatio, x1: xRatio, y1: yRatio });
      return;
    }
    const canvas = canvasRef.current;
    const cw = canvas?.width ?? 1024;
    const ch = canvas?.height ?? 1024;

    // Check if clicked near an existing epicenter handle (hit radius: 22px)
    const hitEpic = customEpicenters.find((epic) => {
      const dx = (epic.normX - xRatio) * cw;
      const dy = (epic.normY - yRatio) * ch;
      return Math.hypot(dx, dy) <= 22;
    });

    if (hitEpic) {
      setSelectedEpicenterId(hitEpic.id);
      setDraggingEpicenterId(hitEpic.id);
      return;
    }

    if (activeTool === "epicenter") {
      const newId = `epic_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const newEpic: WaveEpicenter = {
        id: newId,
        normX: Math.max(0.01, Math.min(0.99, xRatio)),
        normY: Math.max(0.01, Math.min(0.99, yRatio)),
        strength: 0.5,
      };
      setCustomEpicenters((prev) => [...prev, newEpic]);
      setSelectedEpicenterId(newId);
      setDraggingEpicenterId(newId);
      return;
    }

    if (activeTool === "profile") {
      setIsDrawingProfile(true);
      setProfileA({ x: xRatio, y: yRatio });
      setProfileB({ x: xRatio, y: yRatio });
    }
  }

  function handleCanvasMouseUp() {
    setIsPanning(false);
    if (regionDraft) {
      setRegionDraft(null);
      // Ignore clicks; a region needs a visible drag in both directions.
      if (Math.abs(regionDraft.x1 - regionDraft.x0) > 0.002 && Math.abs(regionDraft.y1 - regionDraft.y0) > 0.002) {
        void handleExportImage(regionDraft);
      }
    }
    if (isDrawingProfile) {
      setIsDrawingProfile(false);
    }
    if (draggingEpicenterId) {
      setDraggingEpicenterId(null);
    }
  }

  function handleWheel(e: React.WheelEvent<HTMLDivElement>) {
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
    setZoom((prev) => Math.max(0.4, Math.min(6.0, prev * zoomFactor)));
  }

  function handleResetView() {
    setZoom(MOUNTAIN_DEFAULT_VIEW_ZOOM);
    setPan({ x: 0, y: 0 });
  }

  function handleResetToCurrentSettings() {
    try {
      const parsed: unknown = JSON.parse(currentSettingsText);
      if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2)) {
        throw new Error("currentSettings must contain a version 1 or 2 snapshot");
      }
      window.localStorage.setItem(
        MOUNTAIN_SETTINGS_STORAGE_KEY,
        JSON.stringify(parsed),
      );
      window.location.reload();
    } catch (error) {
      console.error("Failed to reset to currentSettings:", error);
      setPreviewError("Could not load currentSettings as the reset preset.");
    }
  }

  function requestPreviewWaterSnapshot(): Promise<
    MountainExportWaterSurface | undefined
  > {
    const worker = previewWorkerRef.current;
    if (!worker) return Promise.resolve(undefined);
    const requestId = ++previewRequestIdRef.current;
    return new Promise((resolve) => {
      waterSnapshotResolversRef.current.set(requestId, resolve);
      const request: MountainPreviewRequest = {
        type: "waterSnapshot",
        requestId,
        analysisRevision,
        options: {
          siltReachM,
          siltTopRemoved,
          wetlandPuddleContours: showWetlandPuddleContours,
          wetlandPuddleDensity,
          wetlandPuddleSizeMin,
          wetlandPuddleSizeMax,
          wetlandPuddleCoastDistance,
          wetlandPuddleSeed,
          riverThresholdKm2:
            previewMetadata?.riverThresholdKm2 ?? riverThresholdKm2,
        },
      };
      worker.postMessage(request);
    });
  }

  async function handleExportImage(
    region?: { x0: number; y0: number; x1: number; y1: number },
  ) {
    if (!rawLuminance || !outputSize || isLoading) return;

    // Export must use the exact water surface currently visible in the
    // viewport. Rebuilding pools independently in the worker can classify a
    // river-crossing wetland differently and silently drop a large pocket.
    const exportWaterDem = await requestPreviewWaterSnapshot();

    // The procedural path fallback is intentionally useful while the
    // viewport is still loading, but it would make an export silently differ
    // from the SVG artwork. Resolve the same complete motif manifest before
    // handing the request to the worker.
    let exportVegetationMotifAssets = vegetationMotifAssets;
    if (activeLayer === "vegetation_patterns" && !exportVegetationMotifAssets) {
      try {
        exportVegetationMotifAssets = await loadVegetationMotifAssets();
        setVegetationMotifAssets(exportVegetationMotifAssets);
      } catch (error) {
        setExportError(
          error instanceof Error
            ? error.message
            : "Failed to load vegetation motifs for export",
        );
        return;
      }
    }
    let exportRasterPropAssets = rasterPropAssets;
    if (!exportRasterPropAssets) {
      try {
        exportRasterPropAssets = await loadMountainDetailPropAssets();
        setRasterPropAssets(exportRasterPropAssets);
      } catch (error) {
        setExportError(
          error instanceof Error
            ? error.message
            : "Failed to load raster vegetation props for export",
        );
        return;
      }
    }

    // 16K uses the same export path as 8K. Keep the explicit confirmation because a
    // full-camera 16K composition can require substantial pixel memory.
    if (outputLongEdge >= 16384 && !region) {
      const confirmed = window.confirm(
        "16K export needs roughly 4× the memory and time of 8K. Continue?",
      );
      if (!confirmed) return;
    }

    setExportError(null);
    setExportSummary(null);

    // A region preview renders one rectangle of the full-size export, so it
    // shows exactly the pixels a complete export would contain there.
    const regionPixels = region
      ? {
          colStart: Math.floor(Math.min(region.x0, region.x1) * outputSize.width),
          colEnd: Math.ceil(Math.max(region.x0, region.x1) * outputSize.width),
          rowStart: Math.floor(Math.min(region.y0, region.y1) * outputSize.height),
          rowEnd: Math.ceil(Math.max(region.y0, region.y1) * outputSize.height),
        }
      : undefined;

    const request: MountainExportRequest = {
      type: "export",
      id: 0,
      sourceRevision: sourceLoadIdRef.current,
      source: {
        width: rawLuminance.width,
        height: rawLuminance.height,
        // Keep the live source reusable for subsequent exports and worker
        // retries. The worker owns its structured-cloned copy.
        luminance: rawLuminance.data.slice(),
        oceanMask: rawLuminance.oceanMask?.slice(),
      },
      waterSurface: exportWaterDem
        ? {
            width: exportWaterDem.width,
            height: exportWaterDem.height,
            wetlandPoolMask: exportWaterDem.wetlandPoolMask.slice(),
            visualWaterMask: exportWaterDem.visualWaterMask.slice(),
            wetlandPoolCoverage: exportWaterDem.wetlandPoolCoverage.slice(),
            visualWaterCoverage: exportWaterDem.visualWaterCoverage.slice(),
          }
        : undefined,
      analysis: {
        domainWidthKm,
        // Keep export geometry proportional to the bundled source. The
        // preview uses the same physical footprint; omitting this falls back
        // to the DEM's legacy 45 km height and changes the camera framing.
        domainHeightKm:
          domainWidthKm * (rawLuminance.height / Math.max(1, rawLuminance.width)),
        minElevationM: minElevM,
        maxElevationM: maxElevM,
        oceanElevationM,
        sunAzimuthDeg,
        sunAltitudeDeg,
        verticalExaggeration: vertExagg,
        windAzimuthDeg,
        windSpeedMs,
        basePrecipitationMmYr: basePrecipMm,
        baseTemperatureC,
        riverThresholdKm2,
        wetlandElevationThresholdM,
        biomeRegionScaleKm,
        biomeEdgeNoiseScaleM,
        biomeEdgeStrength: vegetationBiomeTransitionStrength,
        waterStageScale,
        // A river widens as it matures: each evolution step raises the bank-full stage.
        waterStageGrowthPerStep: 0.125,
        flowRateScale,
        erosionStrength: waterLandscapeImpact,
        erosionIterations: waterEvolutionStep,
        erosionTimeScale: 1,
      },
      heightmapSmoothingPasses,
      render: {
        layer: activeLayer,
        palette: activePalette,
        gpuRenderMode: MOUNTAIN_GPU_RENDER_MODE,
        sunAzimuthDeg,
        sunAltitudeDeg,
        windAzimuthDeg,
        mountainLightingMode,
        // Compose export tiles in map space; the global camera is applied once
        // after their complete colored raster has been assembled.
        mountainViewAngleDeg: terrainCameraActive ? 90 : mountainViewAngleDeg,
        mountainHeightExaggeration: terrainCameraActive ? 1 : mountainHeightExaggeration,
        mountainLineworkScale,
        mountainLineworkOpacity,
        mountainHatchOpacity,
        mountainHatchHorizontalOpacity,
        mountainHatchVerticalOpacity,
        mountainHatchDensity,
        mountainLocalDetailDensityMax,
        mountainFoothillDetailMultiplier,
        mountainBiomeDetailMultiplier,
         mountainHatchThickness,
         mountainRidgeDensity,
         mountainRidgeThickness,
         mountainHatchColor,
         mountainRidgeColor,
         fullTerrainCameraElevationDeg: terrainCameraActive
          ? fullTerrainCameraElevationDeg
          : undefined,
        fullTerrainCameraHeightExaggeration: terrainCameraActive
          ? fullTerrainCameraHeightExaggeration
          : undefined,
        fullTerrainCameraType: terrainCameraActive
          ? fullTerrainCameraType
          : undefined,
        fullTerrainCameraRenderStyle: terrainCameraActive
          ? "compositor"
          : undefined,
        snowRedistributionSteps: MOUNTAIN_SNOW_REDISTRIBUTION_STEPS_DEFAULT,
        verticalExaggeration: vertExagg,
        ambientOcclusionStrength: aoStrength,
        hillshadeStrength,
        showHeightmapWater,
        showRivers,
        riverThresholdKm2,
        showWaterDetails,
        showOceanDetails,
        oceanRippleCount,
        deepOceanSwells,
        deepOceanSwellDensity,
        lakeFullDepthM,
        deepOceanWaveLength,
        deepOceanStrokeThickness,
        deepOceanWaveShadingScale,
        deepOceanWaveShadingIntensity,
        deepOceanTurbulenceScale,
        deepOceanTurbulenceIntensity,
        customEpicenters,
        siltReachM,
        siltTopRemoved,
        siltLayers,
        wetlandPuddleContours: showWetlandPuddleContours,
        wetlandPuddleDensity,
        wetlandPuddleSizeMin,
        wetlandPuddleSizeMax,
        wetlandPuddleCoastDistance,
        wetlandPoolContourLength,
        wetlandPuddleSeed,
        waterFillSmoothing,
        waterTerrainShadeStrength,
        waterOutlineThickness,
        waterOutlineLength,
        waterOutlineSmoothing,
        waterOutlineOpacity,
        waterFlowDensity,
        waterFlowLength,
        waterFlowThickness,
        waterFlowSmoothing,
        waterFlowOpacity,
        waterOutlineColor,
        waterFlowColor,
        vegetationBiomeColors,
        vegetationBiomeTransitionStrength,
        waterShallowColor,
        waterDeepColor,
        erosionOverlayOpacity: 0,
        rainOverlayOpacity: viewRainOpacity,
        showContours,
        contourIntervalM,
        contourSmoothingPasses,
        contourThicknessM,
        contourIndexThicknessM,
        showIndexContours,
        contourIndexEvery,
        contourOpacity,
        contourColor,
        contourIndexColor,
        vegetation: {
          preset: "adaptive",
          seed: vegetationSeed,
          density: vegetationDensity,
          patternScale: vegetationPatternScale,
          swirlStrength: vegetationSwirlStrength,
          terrainFollowing: vegetationTerrainFollowing,
        desertDunes: vegetationDesertDunes,
        desertDuneSpacingKm: vegetationDesertDuneSpacingKm,
        // Crests run across the climate wind (Terrain › Climate › Wind direction).
        desertWindFromDeg: windAzimuthDeg,
        desertHighlight: vegetationDesertHighlight,
        desertWashShadow: vegetationDesertWashShadow,
        desertLineBreaks: vegetationDesertLineBreaks,
        desertDots: vegetationDesertDots,
        desertColorVariation: vegetationDesertColorVariation,
        desertColorScaleKm: vegetationDesertColorScaleKm,
        desertSpotColor: vegetationDesertSpotColor,
        desertCrestScallop: vegetationDesertCrestScallop,
        desertTerrainFollowing: vegetationDesertTerrainFollowing,
        desertShadowLength: vegetationDesertShadowLength,
        desertShadowStrength: vegetationDesertShadowStrength,
        desertHatchDensity: vegetationDesertHatchDensity,
        desertRippleLines: vegetationDesertRippleLines,
          strokeLength: vegetationStrokeLength,
          strokeThickness: vegetationStrokeThickness,
          strokeOpacity: vegetationStrokeOpacity,
          mountainSideRidgeDensity: vegetationMountainSideRidgeDensity,
          mountainMainRidgeThickness: vegetationMountainMainRidgeThickness,
          motifDensity: vegetationMotifDensity,
          motifSize: vegetationMotifSize,
          rasterPropAssets: exportRasterPropAssets ?? undefined,
          rasterPropBiomeSettings: vegetationRasterPropBiomeSettings,
          rasterPropDensity: vegetationRasterPropDensity,
          mountainBoulderDensity: 0,
          mountainBoulderSize: vegetationMountainBoulderSize,
          wetlandShrubDensity: vegetationWetlandShrubDensity,
          rasterPropCellSize: FOREST_TREE_REFERENCE_CELL_SIZE,
          rasterPropScale: vegetationRasterPropScale,
          rasterPropClustering: vegetationRasterPropClustering,
          rasterPropStandSize: vegetationRasterPropStandSize,
          rasterPropPlacementNoiseScale: vegetationRasterPropPlacementNoiseScale,
          forestSettings: {
             ...forestSettings,
             seed: vegetationSeed,
             sunAzimuthDeg,
             outlineColor: forestOutlineColor,
           },
          inkColor: vegetationInkColor,
        aridInkColor: vegetationAridInkColor,
          flowWashStrength: vegetationFlowWashStrength,
          flowWashDarkStrength: vegetationFlowWashDarkStrength,
          flowWashLightStrength: vegetationFlowWashLightStrength,
          flowWashNoiseStrength: vegetationFlowWashNoiseStrength,
          flowWashNoiseScale: vegetationFlowWashNoiseScale,
          wetlandDryDistanceStart: vegetationWetlandDryDistanceStart,
          wetlandDryDistanceEnd: vegetationWetlandDryDistanceEnd,
          wetlandDryNoiseScale: vegetationWetlandDryNoiseScale,
          wetlandDryNoiseStrength: vegetationWetlandDryNoiseStrength,
          showFlowGuides: vegetationShowFlowGuides,
          motifShadowStrength: vegetationMotifShadowStrength,
          motifShadowDistance: vegetationMotifShadowDistance,
          motifShadowSoftness: vegetationMotifShadowSoftness,
          washShadowStrength: vegetationWashShadowStrength,
          washShadowDistance: vegetationWashShadowDistance,
          washShadowGap: vegetationWashShadowGap,
          washShadowGrain: vegetationWashShadowGrain,
          motifAssets: exportVegetationMotifAssets ?? undefined,
        },
      },
      outputWidth: outputSize.width,
      outputHeight: outputSize.height,
      // Export analysis follows the requested output up to the source's
      // native resolution; the worker clamps this to the available source
      // samples so a smaller heightmap is never artificially enlarged.
      analysisLongEdge: Math.max(outputSize.width, outputSize.height),
      tileSize: 1024,
      halo: 32,
      profile: MOUNTAIN_PROFILE_ENABLED,
      filename: `mountain_detail_${activeLayer}_${activePalette}_${outputSize.width}x${outputSize.height}.png`,
      ...(regionPixels && {
        ...regionPixels,
        filename: `mountain_detail_${activeLayer}_${activePalette}_${outputSize.width}x${outputSize.height}_region_x${regionPixels.colStart}-${regionPixels.colEnd}_y${regionPixels.rowStart}-${regionPixels.rowEnd}.png`,
      }),
    };

    // Each part gets a fresh worker so its memory is released before the next
    // strip starts. Resolves true once the part's PNG has been downloaded.
    const runExportPart = (
      request: MountainExportRequest,
      label: string,
    ): Promise<boolean> => new Promise((resolve) => {
    exportWorkerRef.current?.terminate();
    const worker = new Worker(
      new URL("../rendering/mountainExport.worker.ts", import.meta.url),
      { type: "module" },
    );
    exportWorkerRef.current = worker;
    const id = ++exportRequestIdRef.current;
    request.id = id;
    exportPartAbortRef.current = () => resolve(false);
    setExportProgress({
      type: "progress",
      id,
      completedTiles: 0,
      totalTiles: 1,
      phase: "analysis",
      message: `Preparing ${outputSize.width}×${outputSize.height} export${label}…`,
      stage: "Sending heightmap to export worker",
      stageStartedAt: Date.now(),
      completedStages: [],
    });
    worker.onmessage = (event: MessageEvent<MountainExportWorkerResponse>) => {
      const response = event.data;
      // A terminated worker can still have a queued message. Only the worker
      // currently owned by this request may update state or trigger a file
      // download.
      if (response.type === "cancelled") {
        if (response.id === id && exportWorkerRef.current === worker) {
          worker.terminate();
          exportWorkerRef.current = null;
        }
        resolve(false);
        return;
      }
      if (
        response.id !== id ||
        exportWorkerRef.current !== worker ||
        exportRequestIdRef.current !== id ||
        sourceLoadIdRef.current !== request.sourceRevision
      )
        return;
      if (response.type === "progress") {
        setExportClock(Date.now());
        setExportProgress({
          id,
          completedTiles: response.completedTiles,
          totalTiles: response.totalTiles,
          phase: response.phase,
          completedRows: response.completedRows,
          totalRows: response.totalRows,
          message: response.message,
          stage: response.stage,
          stageStartedAt: response.stageStartedAt,
          completedStages: response.completedStages,
          stageCompleted: response.stageCompleted,
          stageTotal: response.stageTotal,
          type: "progress",
        });
        return;
      }
      if (response.type === "error") {
        setExportError(`${response.message}${label}`);
        setExportProgress(null);
        worker.terminate();
        if (exportWorkerRef.current === worker) exportWorkerRef.current = null;
        resolve(false);
        return;
      }
      const url = URL.createObjectURL(response.blob);
      if (request.colStart !== undefined) {
        setRegionPreview((previous) => {
          if (previous) URL.revokeObjectURL(previous.url);
          return { url, filename: response.filename };
        });
      } else {
        const link = document.createElement("a");
        link.download = response.filename;
        link.href = url;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setExportProgress(null);
      setExportSummary(response.completedStages ?? null);
      worker.terminate();
      if (exportWorkerRef.current === worker) exportWorkerRef.current = null;
      resolve(true);
    };
    worker.onerror = () => {
      if (
        exportWorkerRef.current !== worker ||
        exportRequestIdRef.current !== id ||
        sourceLoadIdRef.current !== request.sourceRevision
      )
        return;
      setExportError(`Mountain export worker failed${label}`);
      setExportProgress(null);
      worker.terminate();
      if (exportWorkerRef.current === worker) exportWorkerRef.current = null;
      resolve(false);
    };
    worker.postMessage(request);
    });

    if (!splitExportIntoStrips || regionPixels) {
      await runExportPart(request, regionPixels ? " (region preview)" : "");
      return;
    }
    // Four full-width horizontal strips of the same image, stacked top to
    // bottom. Boundaries sit on the 1024px tile grid so every strip renders
    // exactly the rows of the unsplit export.
    const stripCount = 4;
    const stripHeight = Math.ceil(outputSize.height / stripCount / 1024) * 1024;
    const baseName = request.filename.replace(/\.png$/, "");
    for (let part = 0; part < stripCount; part++) {
      if (exportStrip !== "all" && part + 1 !== Number(exportStrip)) continue;
      const rowStart = part * stripHeight;
      if (rowStart >= outputSize.height) break;
      const rowEnd = Math.min(outputSize.height, rowStart + stripHeight);
      const ok = await runExportPart(
        {
          ...request,
          rowStart,
          rowEnd,
          filename: `${baseName}_part${part + 1}of${stripCount}_rows${rowStart}-${rowEnd}.png`,
        },
        ` (part ${part + 1}/${stripCount})`,
      );
      if (!ok) return;
    }
  }

  function cancelMountainExport() {
    const id = exportProgress?.id;
    if (id === undefined) return;
    // Each export owns its worker, so terminate it immediately even if it is
    // in a long synchronous tile or camera raster pass.
    exportWorkerRef.current?.terminate();
    exportWorkerRef.current = null;
    exportPartAbortRef.current?.();
    exportPartAbortRef.current = null;
    // Reject any message that was already queued before termination.
    exportRequestIdRef.current = Math.max(exportRequestIdRef.current, id + 1);
    setExportProgress(null);
  }

  async function handleExportWaterEvolvedHeightmap() {
    if (!demData) return;
    const exportWidth = outputSize?.width ?? demData.width;
    const exportHeight = outputSize?.height ?? demData.height;
    const worker = previewWorkerRef.current;
    if (worker) {
      const requestId = ++previewRequestIdRef.current;
      const result = await new Promise<{
        width: number;
        height: number;
        data: Float32Array;
      } | null>((resolve) => {
        heightmapResolversRef.current.set(requestId, resolve);
        const request: MountainPreviewRequest = {
          type: "heightmap",
          requestId,
          analysisRevision,
          outputWidth: exportWidth,
          outputHeight: exportHeight,
        };
        worker.postMessage(request);
      });
      if (!result) return;
      downloadGrayscale16BitPng(
        result.data,
        result.width,
        result.height,
        `mountain_water_evolved_heightmap_step-${waterEvolutionStep}_${result.width}x${result.height}_16bit.png`,
      );
      return;
    }
    let exportMinElevation = Math.min(demData.minElevationM, oceanElevationM);
    for (const elevation of demData.elevation) {
      exportMinElevation = Math.min(exportMinElevation, elevation);
    }
    const elevationRange = Math.max(
      1,
      demData.maxElevationM - exportMinElevation,
    );
    const normalizedElevation = new Float32Array(demData.elevation.length);
    for (let i = 0; i < demData.elevation.length; i++) {
      normalizedElevation[i] = Math.max(
        0,
        Math.min(
          1,
          (demData.elevation[i] - exportMinElevation) / elevationRange,
        ),
      );
    }
    const exportElevation =
      exportWidth === demData.width && exportHeight === demData.height
        ? normalizedElevation
        : resampleHeightmapLuminance(
            normalizedElevation,
            demData.width,
            demData.height,
            exportWidth,
            exportHeight,
          );
    downloadGrayscale16BitPng(
      exportElevation,
      exportWidth,
      exportHeight,
      `mountain_water_evolved_heightmap_step-${waterEvolutionStep}_${exportWidth}x${exportHeight}_16bit.png`,
    );
  }

  const commitAnalysisControls = () =>
    setAnalysisCommitVersion((version) => version + 1);
  /**
   * One inspector number row; `commit` regenerates terrain on release, `key` names the currentSettings reset value.
   * Typed values may leave the slider range; `limits` sets hard bounds where a value would be invalid.
   */
  const num = (label: string, value: number, onChange: (value: number) => void, min: number, max: number, step: number,
    options: { unit?: string; key?: string; commit?: boolean; log?: boolean; power?: number; disabled?: boolean; title?: string;
      limits?: readonly [number, number] } = {}) =>
    <NumericControl key={label} label={label} value={value} onChange={onChange} min={min} max={max} step={step}
      unit={options.unit} power={options.power} disabled={options.disabled} title={options.title} limits={options.limits}
      logarithmic={options.log ?? (options.unit !== "%" && min > 0 && max / min >= 8)}
      defaultValue={options.key ? baselineSettings[options.key] as number | undefined : undefined}
      onCommit={options.commit ? commitAnalysisControls : undefined} />;


  useEffect(() => {
    if (!profileA || !profileB || !previewWorkerRef.current) {
      setProfileData(null);
      return;
    }
    const requestId = ++previewRequestIdRef.current;
    profileRequestIdRef.current = requestId;
    const request: MountainPreviewRequest = {
      type: "profile",
      requestId,
      analysisRevision,
      p0: profileA,
      p1: profileB,
      samples: 220,
    };
    previewWorkerRef.current.postMessage(request);
  }, [profileA, profileB, analysisRevision]);

  return (
    <div className="flex h-full w-full bg-[#12151a] text-slate-100 overflow-hidden select-none">
      {/* Main 2D Map Workspace */}
      <main className="min-w-0 flex-1 relative h-full bg-[#12151a] flex flex-col overflow-hidden">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/5 bg-[#1b1f26] px-2 text-[12px]">
          <div role="radiogroup" aria-label="Map view" className="flex rounded-md bg-black/30 p-0.5">
            {PRIMARY_VIEWS.map(([id, label]) => {
              const selected = activeLayer === id || (id === "raw_heightmap" && isHeightmapView);
              return <button type="button" role="radio" key={id} aria-checked={selected}
                onClick={() => { setActiveLayer(id); setInspectorTab(id === "vegetation_patterns" ? "Ink" : id === "drainage_network" ? "Water" : "Terrain"); }}
                className={`rounded px-2.5 py-1 ${selected ? "bg-slate-600 text-white shadow" : "text-slate-400 hover:text-slate-100"}`}>{label}</button>;
            })}
          </div>
          <div className="relative">
            <button type="button" onClick={() => setDiagnosticsMenuOpen((open) => !open)} aria-expanded={diagnosticsMenuOpen}
              className={`flex items-center gap-1 rounded px-2 py-1 ${DIAGNOSTIC_VIEWS.some(([id]) => id === activeLayer) ? "bg-slate-600 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-100"}`}>
              {DIAGNOSTIC_VIEWS.find(([id]) => id === activeLayer)?.[1] ?? "Diagnostics"}<ChevronDown size={13} />
            </button>
            {diagnosticsMenuOpen && <>
              <div className="fixed inset-0 z-30" onClick={() => setDiagnosticsMenuOpen(false)} />
              <div role="menu" className="absolute left-0 top-8 z-40 w-44 rounded-md border border-white/10 bg-[#2a2f38] py-1 shadow-xl">
                {DIAGNOSTIC_VIEWS.filter(([id]) => id !== "wave_patterns" || MOUNTAIN_PROFILE_ENABLED).map(([id, label]) =>
                  <button type="button" role="menuitemradio" aria-checked={activeLayer === id} key={id}
                    onClick={() => { setActiveLayer(id); setDiagnosticsMenuOpen(false); }}
                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] text-slate-200 hover:bg-white/10">
                    <Check size={12} className={activeLayer === id ? "text-slate-100" : "invisible"} />{label}</button>)}
              </div>
            </>}
          </div>
          {isHeightmapView && <div className="flex items-center gap-3 border-l border-white/10 pl-3 text-slate-300">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={showHeightmapWater} onChange={(event) => setShowHeightmapWater(event.target.checked)} />Water</label>
            <label className={`flex items-center gap-1.5 ${waterEvolutionStep === 0 ? "opacity-40" : ""}`} title={waterEvolutionStep === 0 ? "Set a water evolution step in Terrain to compare erosion" : undefined}>
              <input type="checkbox" checked={activeLayer === "eroded_heightmap"} disabled={waterEvolutionStep === 0}
                onChange={(event) => setActiveLayer(event.target.checked ? "eroded_heightmap" : "raw_heightmap")} />Eroded</label>
          </div>}
          <button type="button" onClick={() => { setInspectorOpen(!inspectorOpen); setMobileInspectorOpen(!mobileInspectorOpen); }}
            aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"} title={inspectorOpen ? "Hide inspector" : "Show inspector"}
            className="ml-auto rounded p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-100">
            {inspectorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
        </div>
        <div className="relative flex min-h-0 flex-1">
          <nav aria-label="Tools" className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-white/5 bg-[#1b1f26] py-2">
            {TOOLS.map(({ id, label, key, Icon }) =>
              <button type="button" key={id} onClick={() => setActiveTool(id)} aria-pressed={activeTool === id}
                aria-label={label} title={`${label} (${key})`}
                className={`rounded-md p-1.5 ${activeTool === id ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-100"}`}>
                <Icon size={17} />
              </button>)}
          </nav>
          <div className="relative flex min-w-0 flex-1 flex-col">
        {(exportProgress || exportSummary || exportError) && (
          <div className="absolute right-3 top-3 z-30 w-80 rounded-md border border-white/10 bg-[#1f232b] p-3 text-[12px] text-slate-300 shadow-xl">
            {exportProgress ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-100">
                    Exporting {Math.round(Math.max(outputSize?.width ?? outputLongEdge, outputSize?.height ?? outputLongEdge) / 1024)}K
                  </span>
                  <span className="tabular-nums text-slate-400">
                    {exportProgress.phase === "analysis"
                      ? "Analysis"
                      : (exportProgress.phase === "projecting" || exportProgress.phase === "encoding") && exportProgress.totalRows !== undefined
                        ? `${(exportProgress.completedRows ?? 0).toLocaleString()}/${(exportProgress.totalRows ?? 0).toLocaleString()} rows`
                        : exportProgress.phase === "projecting"
                          ? "Camera"
                          : `${exportProgress.completedTiles}/${exportProgress.totalTiles} tiles`}
                  </span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full bg-sky-500 transition-[width]"
                    style={{
                      width: `${exportProgress.phase === "analysis"
                        ? 4
                        : (exportProgress.phase === "projecting" || (exportProgress.phase === "encoding" && exportProgress.totalRows !== undefined))
                          ? 4 + ((exportProgress.completedRows ?? 0) / Math.max(1, exportProgress.totalRows ?? 1)) * 92
                          : Math.max(4, (exportProgress.completedTiles / Math.max(1, exportProgress.totalTiles)) * 92)}%`,
                    }}
                  />
                </div>
                <div className="mt-2 flex items-start justify-between gap-2 text-[11px]">
                  <span>{exportProgress.stage ?? exportProgress.message ?? "Preparing export"}</span>
                  <span className="shrink-0 tabular-nums text-slate-400">
                    {exportProgress.stageTotal !== undefined
                      ? `${(exportProgress.stageCompleted ?? 0).toLocaleString()}/${exportProgress.stageTotal.toLocaleString()} · `
                      : ""}
                    {formatExportTime(exportClock - (exportProgress.stageStartedAt ?? exportClock))}
                  </span>
                </div>
                {(exportProgress.completedStages?.length ?? 0) > 0 && (
                  <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto border-t border-white/5 pt-2 text-[11px] text-slate-400">
                    {exportProgress.completedStages?.map((item, index) => (
                      <div key={index} className="flex justify-between gap-2">
                        <span>{item.label}</span>
                        <span className="shrink-0 tabular-nums text-slate-300">{formatExportTime(item.durationMs)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/5 pt-2 text-[11px]">
                  <span className="text-slate-400">Total</span>
                  <span className="tabular-nums text-slate-200">
                    {formatExportTime(
                      (exportProgress.completedStages?.reduce((total, item) => total + item.durationMs, 0) ?? 0)
                      + Math.max(0, exportClock - (exportProgress.stageStartedAt ?? exportClock)),
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={cancelMountainExport}
                  className="mt-2 w-full rounded border border-white/10 bg-white/5 py-1 text-[12px] text-slate-200 hover:bg-white/10"
                >
                  Cancel export
                </button>
              </>
            ) : exportSummary ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-100">Export complete</span>
                  <span className="tabular-nums text-slate-200">
                    {formatExportTime(exportSummary.reduce((total, item) => total + item.durationMs, 0))}
                  </span>
                </div>
                <div className="mt-2 max-h-56 space-y-0.5 overflow-y-auto border-t border-white/5 pt-2 text-[11px] text-slate-400">
                  {exportSummary.map((item, index) => (
                    <div key={index} className="flex justify-between gap-2">
                      <span>{item.label}</span>
                      <span className="shrink-0 tabular-nums text-slate-300">{formatExportTime(item.durationMs)}</span>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setExportSummary(null)}
                  className="mt-2 w-full rounded border border-white/10 bg-white/5 py-1 text-[12px] text-slate-200 hover:bg-white/10"
                >
                  Dismiss
                </button>
              </>
            ) : (
              <div className="flex items-start justify-between gap-2 text-red-300">
                <span>{exportError}</span>
                <button
                  type="button"
                  onClick={() => setExportError(null)}
                  className="rounded p-0.5 text-slate-400 hover:bg-white/5 hover:text-slate-100"
                  aria-label="Dismiss export error"
                >
                  <X size={13} />
                </button>
              </div>
            )}
          </div>
        )}
        {isLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400">
            <div className="w-10 h-10 border-2 border-white/10 border-t-slate-300 rounded-full animate-spin" />
            <span className="text-sm font-semibold">
              Loading heightmap…
            </span>
          </div>
        ) : loadError ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-red-400 p-8 text-center">
            <span className="text-2xl">⚠️</span>
            <span className="font-bold text-base">Error Loading Base DEM</span>
            <span className="text-xs text-slate-400 max-w-md">{loadError}</span>
          </div>
        ) : (
          <div
            ref={containerRef}
            className="flex-1 relative overflow-hidden overscroll-contain flex items-center justify-center p-4 bg-[#12151a]"
            onWheel={handleWheel}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={() => { setHoverInfo(null); setIsPanning(false); }}
          >
            {previewError && (
              <div className="absolute top-4 right-4 z-30 flex items-center gap-2 rounded-lg border border-red-800/70 bg-slate-950/95 px-3 py-1.5 text-[11px] text-red-300 shadow-lg">
                <span>{previewError}</span>
                <button
                  type="button"
                  onClick={() => setPreviewError(null)}
                  className="text-slate-400 hover:text-white"
                  aria-label="Dismiss preview error"
                >
                  ×
                </button>
              </div>
            )}
            {/* Transform Container for 2D Zoom & Pan */}
            <div
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "center center",
                transition: isPanning ? "none" : "transform 0.05s ease-out",
              }}
              className="relative shadow-2xl border border-slate-800/80 rounded-lg overflow-hidden flex items-center justify-center"
            >
              <canvas
                ref={canvasRef}
                className={`block max-h-[85vh] max-w-full object-contain ${
                  activeTool === "profile" || activeTool === "region"
                    ? "cursor-crosshair"
                    : activeTool === "pan" || isPanning
                        ? "cursor-grab active:cursor-grabbing"
                        : "cursor-default"
                }`}
              />
              <canvas
                ref={particleCanvasRef}
                className="absolute inset-0 pointer-events-none w-full h-full object-contain"
              />
              {regionDraft && (
                <div
                  className="absolute pointer-events-none border-2 border-dashed border-orange-400 bg-orange-400/10"
                  style={{
                    left: `${Math.min(regionDraft.x0, regionDraft.x1) * 100}%`,
                    top: `${Math.min(regionDraft.y0, regionDraft.y1) * 100}%`,
                    width: `${Math.abs(regionDraft.x1 - regionDraft.x0) * 100}%`,
                    height: `${Math.abs(regionDraft.y1 - regionDraft.y0) * 100}%`,
                  }}
                />
              )}
            </div>
            {regionPreview && (
              <div
                className="absolute inset-0 z-40 flex flex-col bg-slate-950/95"
                onMouseDown={(e) => e.stopPropagation()}
                onWheel={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2 text-xs text-slate-300">
                  <span className="truncate font-mono">{regionPreview.filename} · 1:1 pixels</span>
                  <div className="flex shrink-0 gap-2">
                    <a
                      href={regionPreview.url}
                      download={regionPreview.filename}
                      className="rounded-lg bg-slate-800 px-2 py-1 font-semibold hover:bg-slate-700"
                    >
                      Download
                    </a>
                    <button
                      onClick={() => {
                        URL.revokeObjectURL(regionPreview.url);
                        setRegionPreview(null);
                      }}
                      className="rounded-lg bg-slate-800 px-2 py-1 font-semibold hover:bg-slate-700"
                    >
                      ✕ Close
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-auto p-4">
                  <img src={regionPreview.url} alt="Export region preview" className="max-w-none" />
                </div>
              </div>
            )}
          </div>
        )}

        {hoverInfo && (
          <div className="pointer-events-none absolute left-3 top-3 z-20 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 rounded-md border border-white/10 bg-[#1b1f26]/95 px-2.5 py-2 text-[11px] shadow-lg">
            <span className="text-slate-500">Elevation</span>
            <span className="text-right tabular-nums text-slate-100">{Math.round(hoverInfo.elevM).toLocaleString()} m</span>
            <span className="text-slate-500">Slope</span>
            <span className="text-right tabular-nums text-slate-100">{hoverInfo.slopeDeg.toFixed(0)}° {getCompassHeading(hoverInfo.aspectDeg)}</span>
            <span className="text-slate-500">Biome</span>
            <span className="max-w-[240px] truncate text-right text-slate-100" title={hoverInfo.biomeName}>{hoverInfo.biomeName}</span>
            <span className="text-slate-500" title="Holdridge life zone from biotemperature and precipitation">Climate zone</span>
            <span className="max-w-[240px] truncate text-right text-slate-100" title={hoverInfo.climateZone}>{hoverInfo.climateZone}</span>
            <span className="text-slate-500">Rain / temp</span>
            <span className="text-right tabular-nums text-slate-100">{Math.round(hoverInfo.precipMm)} mm · {hoverInfo.tempC.toFixed(1)} °C</span>
            <span className="text-slate-500" title="Height above nearest river or lake (HAND/REM): below 5.3 m waterlogged, below 15 m shallow water table">Above river</span>
            <span className="text-right tabular-nums text-slate-100">{Number.isFinite(hoverInfo.heightAboveRiverM) ? `${hoverInfo.heightAboveRiverM.toFixed(1)} m` : "no river"}</span>
            {hoverInfo.strahler > 0 && <>
              <span className="text-slate-500">River order</span>
              <span className="text-right tabular-nums text-slate-100">{hoverInfo.strahler}</span>
            </>}
          </div>
        )}
          </div>
        </div>

        {/* Bottom Elevation Cross-Section Profile Drawer */}
        {profileData && (
          <div className="h-44 bg-slate-900/95 border-t border-slate-800 p-3 flex flex-col shrink-0 z-20 text-xs shadow-2xl">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <span className="font-bold text-cyan-400 flex items-center gap-1">
                  <span>📈</span> 2D Cross-Section Elevation Profile (A → B)
                </span>
                <span className="text-[11px] text-slate-400 font-mono">
                  Length:{" "}
                  {profileData.distanceKm[
                    profileData.distanceKm.length - 1
                  ].toFixed(1)}{" "}
                  km
                </span>
              </div>
              <button
                onClick={() => {
                  setProfileA(null);
                  setProfileB(null);
                }}
                className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] cursor-pointer"
              >
                Clear Profile
              </button>
            </div>

            {/* SVG Profile Chart */}
            <div className="flex-1 w-full relative">
              <svg
                className="w-full h-full"
                preserveAspectRatio="none"
                viewBox="0 0 400 100"
              >
                {/* Background Grid Lines */}
                <line
                  x1="0"
                  y1="20"
                  x2="400"
                  y2="20"
                  stroke="rgba(255,255,255,0.06)"
                  strokeDasharray="4 4"
                />
                <line
                  x1="0"
                  y1="50"
                  x2="400"
                  y2="50"
                  stroke="rgba(255,255,255,0.06)"
                  strokeDasharray="4 4"
                />
                <line
                  x1="0"
                  y1="80"
                  x2="400"
                  y2="80"
                  stroke="rgba(255,255,255,0.06)"
                  strokeDasharray="4 4"
                />

                {/* Filled Area under Curve */}
                <polygon
                  fill="url(#profileGrad2D)"
                  points={(() => {
                    const minP = Math.min(...profileData.elevationM);
                    const maxP = Math.max(...profileData.elevationM);
                    const pRange = Math.max(1, maxP - minP);
                    const pts = profileData.elevationM.map((elev, i) => {
                      const x = (i / (profileData.elevationM.length - 1)) * 400;
                      const y = 95 - ((elev - minP) / pRange) * 85;
                      return `${x.toFixed(1)},${y.toFixed(1)}`;
                    });
                    return `0,100 ${pts.join(" ")} 400,100`;
                  })()}
                />

                {/* Profile Line Stroke */}
                <polyline
                  fill="none"
                  stroke="#38bdf8"
                  strokeWidth="2"
                  points={(() => {
                    const minP = Math.min(...profileData.elevationM);
                    const maxP = Math.max(...profileData.elevationM);
                    const pRange = Math.max(1, maxP - minP);
                    return profileData.elevationM
                      .map((elev, i) => {
                        const x =
                          (i / (profileData.elevationM.length - 1)) * 400;
                        const y = 95 - ((elev - minP) / pRange) * 85;
                        return `${x.toFixed(1)},${y.toFixed(1)}`;
                      })
                      .join(" ");
                  })()}
                />

                <defs>
                  <linearGradient
                    id="profileGrad2D"
                    x1="0%"
                    y1="0%"
                    x2="0%"
                    y2="100%"
                  >
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.45" />
                    <stop offset="100%" stopColor="#0f172a" stopOpacity="0.8" />
                  </linearGradient>
                </defs>
              </svg>

              {/* Start & End Labels */}
              <div className="absolute top-1 left-2 text-[10px] text-emerald-400 font-bold">
                Point A: {profileData.elevationM[0].toFixed(0)}m
              </div>
              <div className="absolute top-1 right-2 text-[10px] text-red-400 font-bold">
                Point B:{" "}
                {profileData.elevationM[
                  profileData.elevationM.length - 1
                ].toFixed(0)}
                m
              </div>
            </div>
          </div>
        )}
        <footer className="relative flex h-7 shrink-0 items-center gap-3 border-t border-white/5 bg-[#1b1f26] px-3 text-[11px] text-slate-400">
          <PreviewStatus status={previewStatus} />
          {hoverInfo && <span className="tabular-nums">x {hoverInfo.x} · y {hoverInfo.y}</span>}
          <div className="ml-auto flex items-center gap-0.5">
            <button type="button" onClick={() => setZoom((z) => Math.max(0.4, z * 0.8))} aria-label="Zoom out" title="Zoom out"
              className="rounded p-1 hover:bg-white/5 hover:text-slate-100"><Minus size={12} /></button>
            <span className="w-11 text-center tabular-nums text-slate-200">{(zoom * 100).toFixed(0)}%</span>
            <button type="button" onClick={() => setZoom((z) => Math.min(6.0, z * 1.25))} aria-label="Zoom in" title="Zoom in"
              className="rounded p-1 hover:bg-white/5 hover:text-slate-100"><Plus size={12} /></button>
            <button type="button" onClick={handleResetView} title="Fit to window (0)"
              className="ml-1 rounded px-1.5 py-0.5 hover:bg-white/5 hover:text-slate-100">Fit</button>
          </div>
        </footer>
      </main>

      {/* Contextual inspector */}
      <aside aria-label="Inspector" className={`map-inspector ${inspectorOpen ? "lg:flex" : "lg:hidden"} ${mobileInspectorOpen ? "fixed inset-y-0 right-0 flex" : "hidden"} lg:static z-40 w-[min(360px,100vw)] shrink-0 flex-col border-l border-white/5 bg-[#1f232b] text-slate-200 shadow-2xl lg:w-[360px] lg:shadow-none`}>
        <div className="flex h-10 shrink-0 items-stretch gap-4 border-b border-white/5 px-4">
          <div role="tablist" aria-label="Inspector category" className="flex items-stretch gap-4">
            {(["Terrain", "Ink", "Water", "Lighting"] as const).map((tab) =>
              <button type="button" role="tab" key={tab} aria-selected={inspectorTab === tab} onClick={() => setInspectorTab(tab)}
                className={`-mb-px border-b-2 text-[12px] ${inspectorTab === tab ? "border-sky-500 text-white" : "border-transparent text-slate-400 hover:text-slate-200"}`}>{tab}</button>)}
          </div>
          <button type="button" onClick={() => { setInspectorOpen(false); setMobileInspectorOpen(false); }} aria-label="Close inspector"
            className="ml-auto self-center rounded p-1 text-slate-400 hover:bg-white/5 hover:text-slate-100 lg:hidden"><PanelRightClose size={16} /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
        {inspectorTab === "Terrain" && <>
          <InspectorSection title="Heightmap">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200" title={heightmapSourceName}>{heightmapSourceName}</span>
              <button type="button" onClick={() => setGlobalDemOpen(true)} title="Download real terrain for any place on Earth"
                className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[12px] text-slate-200 hover:bg-white/10">Get map…</button>
              <label htmlFor="mountain-heightmap-file" className="cursor-pointer rounded border border-white/10 bg-white/5 px-2 py-1 text-[12px] text-slate-200 hover:bg-white/10">Replace…</label>
              <input id="mountain-heightmap-file" className="sr-only" type="file" accept=".png,.tif,.tiff,image/png,image/tiff" onChange={handleHeightmapFile} />
            </div>
            <InspectorNote>Get map loads real terrain worldwide. Replace takes a PNG or single-band uncompressed TIFF; a GeoTIFF also sets map width, summit and valley floor.</InspectorNote>
            <InspectorSelect label="Denoising" value={heightmapSmoothingPasses}
              options={SMOOTHING_LABELS.map((label, passes) => [passes, label] as const)}
              onChange={(passes) => { setHeightmapSmoothingPasses(passes); commitAnalysisControls(); }} />
          </InspectorSection>

          <InspectorSection title="Elevation and scale" aside={
            <button type="button" disabled={!heightmapMetadata}
              onClick={() => { if (heightmapMetadata) { applyHeightmapScale(heightmapMetadata); commitAnalysisControls(); } }}
              title={heightmapMetadata
                ? `Use the heightmap's real values: summit ${Math.round(heightmapMetadata.maxElevationM)} m, valley floor ${Math.round(heightmapMetadata.minElevationM)} m, width ${Math.round(heightmapMetadata.widthKm * 100) / 100} km`
                : "Only a GeoTIFF or a map from Get map carries real elevations and size"}
              className="rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/5">From heightmap</button>}>
            {num("Summit height", maxElevM, (next) => { setMaxElevM(next); setMinElevM((floor) => Math.min(floor, next - 1)); }, 1500, 6000, 50, { unit: "m", key: "maxElevM", commit: true, limits: [1, Infinity] })}
            {num("Valley floor", minElevM, (next) => { setMinElevM(next); setMaxElevM((summit) => Math.max(summit, next + 1)); }, 0, 1500, 10, { unit: "m", key: "minElevM", commit: true })}
            {num("Sea level", oceanElevationM, setOceanElevationM, -100, 100, 1, { unit: "m", key: "oceanElevationM", commit: true })}
            {num("Map width", domainWidthKm, setDomainWidthKm, 8, 120, 1, { unit: "km", key: "domainWidthKm", commit: true, limits: [0.01, Infinity] })}
            <InspectorSelect label="Relief palette" value={activePalette} onChange={setActivePalette} options={[
              ["swiss_topo", "Swiss topo"], ["european_topo", "European topo"], ["physical_satellite", "Physical"],
              ["alpine_glacial", "Alpine glacial"], ["thermal_magma", "Thermal"], ["viridis", "Viridis"], ["slope_hazard", "Slope hazard"],
            ]} />
          </InspectorSection>

          <InspectorSection title="Climate">
            {num("Temperature", baseTemperatureC, setBaseTemperatureC, -10, 30, 1, { unit: "°C", key: "baseTemperatureC", commit: true, title: "Lower temperatures bring snow to lower elevations" })}
            {num("Precipitation", basePrecipMm, setBasePrecipMm, 100, 4000, 100, { unit: "mm/yr", key: "basePrecipMm", commit: true, log: false, title: "Drier and hotter climates turn valleys into steppe and desert" })}
            {num("Wind direction", windAzimuthDeg, setWindAzimuthDeg, 0, 360, 15, { unit: `° ${compassLabel(windAzimuthDeg)}`, key: "windAzimuthDeg", commit: true, title: "Where the wind comes from; it drives rain shadows and desert dune orientation" })}
            {num("Wind speed", windSpeedMs, setWindSpeedMs, 2, 40, 1, { unit: "m/s", key: "windSpeedMs", commit: true, log: false })}
          </InspectorSection>

          <InspectorSection title="Rivers and erosion">
            {num("Water evolution", waterEvolutionStep, (next) => setWaterEvolutionStep(Math.round(next)), 0, MOUNTAIN_WATER_EVOLUTION_STEPS, 1, { key: "waterEvolutionStep", commit: true, limits: [0, MOUNTAIN_WATER_EVOLUTION_STEPS], title: "0 is the initial terrain; later steps reroute rivers and erode the terrain" })}
            {num("River catchment", riverThresholdKm2, setRiverThresholdKm2, 1, 200, 0.01, { unit: "km²", key: "riverThresholdKm2", commit: true, log: true, title: "Wet-climate catchment area needed before a river appears. 1 km² carries about 24 L/s in the reference climate; raise it for fewer, longer rivers" })}
            {num("Erosion strength", waterLandscapeImpact, setWaterLandscapeImpact, 0.1, 1, 0.05, { unit: "%", key: "waterLandscapeImpact", commit: true, log: false })}
            <InspectorFold title="Channels and flow">
              {num("Channel width", waterStageScale, setWaterStageScale, 0.3, 3, 0.1, { unit: "×", key: "waterStageScale", commit: true })}
              {num("Flow rate", flowRateScale, setFlowRateScale, 0.2, 1, 0.05, { unit: "×", key: "flowRateScale", commit: true, title: "Lower flow retains water longer and fills the banks" })}
            </InspectorFold>
          </InspectorSection>

          <InspectorSection title="Biomes">
            {num("Wetland ceiling", wetlandElevationThresholdM, setWetlandElevationThresholdM, 0, 3000, 1, { unit: "m", key: "wetlandElevationThresholdM", commit: true, power: 2, title: "Flat terrain below this elevation can become wetland" })}
            {num("Region scale", biomeRegionScaleKm, setBiomeRegionScaleKm, 0.01, 1, 0.001, { unit: "km", key: "biomeRegionScaleKm", commit: true, log: true })}
            {num("Border noise scale", biomeEdgeNoiseScaleM, setBiomeEdgeNoiseScaleM, 50, 5000, 50, { unit: "m", key: "biomeEdgeNoiseScaleM", commit: true, log: true, limits: [1, Infinity] })}
            {num("Border irregularity", vegetationBiomeTransitionStrength, setVegetationBiomeTransitionStrength, 0, INSPECTOR_BOUNDS.biomeBorder, 0.05, { unit: "×", key: "vegetationBiomeTransitionStrength", commit: true })}
            <InspectorFold title="Biome colors">
              {MOUNTAIN_PALETTE_BIOME_IDS.filter((biomeId) => biomeId !== 6 && biomeId !== 8).map((biomeId) =>
                <InspectorColor key={biomeId} label={MOUNTAIN_BIOME_LABELS[biomeId] ?? `Biome ${biomeId}`} value={vegetationBiomeColors[biomeId]}
                  onChange={(color) => setVegetationBiomeColors((previous) => ({ ...previous, [biomeId]: color }))} />)}
            </InspectorFold>
          </InspectorSection>
        </>}

        {inspectorTab === "Ink" && <>
          <InspectorSection title="Ground pattern" aside={<span className={`text-[11px] ${vegetationMotifLoadError ? "text-red-300" : "text-slate-500"}`}>
            {vegetationMotifLoadError ? "Motif load error" : vegetationMotifAssets ? `${vegetationMotifAssets.length} motifs` : "Loading motifs…"}</span>}>
            {num("Density", vegetationDensity, setVegetationDensity, 0, INSPECTOR_BOUNDS.groundDensity, 0.05, { unit: "×", key: "vegetationDensity" })}
            {num("Pattern scale", vegetationPatternScale, setVegetationPatternScale, 0.5, INSPECTOR_BOUNDS.patternScale, 0.05, { unit: "×", key: "vegetationPatternScale" })}
            {num("Swirl", vegetationSwirlStrength, setVegetationSwirlStrength, 0, 1, 0.05, { unit: "%", key: "vegetationSwirlStrength" })}
            {num("Terrain following", vegetationTerrainFollowing, setVegetationTerrainFollowing, 0, 1, 0.05, { unit: "%", key: "vegetationTerrainFollowing" })}
            {num("Stroke length", vegetationStrokeLength, setVegetationStrokeLength, 0.4, INSPECTOR_BOUNDS.strokeLength, 0.05, { unit: "×", key: "vegetationStrokeLength" })}
            {num("Stroke thickness", vegetationStrokeThickness, setVegetationStrokeThickness, 0.1, 3, 0.01, { unit: "×", key: "vegetationStrokeThickness" })}
            <InspectorSeed value={vegetationSeed} onChange={(seed) => { setVegetationSeed(seed); setForestSettings((previous) => ({ ...previous, seed })); }} />
            <InspectorColor label="Ink" value={vegetationInkColor} onChange={setVegetationInkColor} />
            <InspectorFold title="Advanced wash, grain and shadows">
              {num("Stroke opacity", vegetationStrokeOpacity, setVegetationStrokeOpacity, 0, 1, 0.05, { unit: "%", key: "vegetationStrokeOpacity" })}
              {num("Motif density", vegetationMotifDensity, setVegetationMotifDensity, 0, 1.5, 0.05, { unit: "×", key: "vegetationMotifDensity" })}
              {num("Motif size", vegetationMotifSize, setVegetationMotifSize, 0.1, 5, 0.01, { unit: "×", key: "vegetationMotifSize" })}
              {num("Wash", vegetationFlowWashStrength, setVegetationFlowWashStrength, 0, 1, 0.05, { unit: "%", key: "vegetationFlowWashStrength" })}
              {num("Wash dark", vegetationFlowWashDarkStrength, setVegetationFlowWashDarkStrength, 0, 1, 0.05, { unit: "%", key: "vegetationFlowWashDarkStrength" })}
              {num("Wash light", vegetationFlowWashLightStrength, setVegetationFlowWashLightStrength, 0, 1, 0.05, { unit: "%", key: "vegetationFlowWashLightStrength" })}
              {num("Color noise", vegetationFlowWashNoiseStrength, setVegetationFlowWashNoiseStrength, 0, 1, 0.05, { unit: "%", key: "vegetationFlowWashNoiseStrength" })}
              {num("Noise scale", vegetationFlowWashNoiseScale, setVegetationFlowWashNoiseScale, 0.5, INSPECTOR_BOUNDS.washNoiseScale, 0.05, { unit: "×", key: "vegetationFlowWashNoiseScale" })}
              {num("Wetland dry start", vegetationWetlandDryDistanceStart, (next) => { setVegetationWetlandDryDistanceStart(next); setVegetationWetlandDryDistanceEnd((end) => Math.max(end, next)); }, 0, 100, 1, { key: "vegetationWetlandDryDistanceStart" })}
              {num("Wetland dry end", vegetationWetlandDryDistanceEnd, (next) => { setVegetationWetlandDryDistanceEnd(next); setVegetationWetlandDryDistanceStart((start) => Math.min(start, next)); }, 1, INSPECTOR_BOUNDS.wetlandDryEnd, 1, { key: "vegetationWetlandDryDistanceEnd" })}
              {num("Dry patch scale", vegetationWetlandDryNoiseScale, setVegetationWetlandDryNoiseScale, 0.5, 3, 0.05, { unit: "×", key: "vegetationWetlandDryNoiseScale" })}
              {num("Dry patch contrast", vegetationWetlandDryNoiseStrength, setVegetationWetlandDryNoiseStrength, 0, 1, 0.05, { unit: "%", key: "vegetationWetlandDryNoiseStrength" })}
              {num("Mark shadow", vegetationMotifShadowStrength, setVegetationMotifShadowStrength, 0, 1, 0.05, { unit: "%", key: "vegetationMotifShadowStrength" })}
              {num("Mark shadow offset", vegetationMotifShadowDistance, setVegetationMotifShadowDistance, 0, 8, 0.05, { unit: "px", key: "vegetationMotifShadowDistance" })}
              {num("Mark shadow softness", vegetationMotifShadowSoftness, setVegetationMotifShadowSoftness, 0, INSPECTOR_BOUNDS.markShadowSoftness, 0.05, { key: "vegetationMotifShadowSoftness" })}
              {num("Wash shadow", vegetationWashShadowStrength, setVegetationWashShadowStrength, 0, 1, 0.05, { unit: "%", key: "vegetationWashShadowStrength" })}
              {num("Wash shadow offset", vegetationWashShadowDistance, setVegetationWashShadowDistance, 0, INSPECTOR_BOUNDS.washShadowOffset, 0.05, { unit: "px", key: "vegetationWashShadowDistance" })}
              {num("Wash shadow gap", vegetationWashShadowGap, setVegetationWashShadowGap, 0, INSPECTOR_BOUNDS.washShadowGap, 0.05, { unit: "px", key: "vegetationWashShadowGap" })}
              {num("Wash shadow grain", vegetationWashShadowGrain, setVegetationWashShadowGrain, 0, 1, 0.05, { unit: "%", key: "vegetationWashShadowGrain" })}
            </InspectorFold>
          </InspectorSection>

          <InspectorSection title="Desert dunes" aside={<input type="checkbox" aria-label="Draw desert dunes" title="Draw sand desert as pen-and-ink dunes instead of flow lines" checked={vegetationDesertDunes} onChange={(event) => setVegetationDesertDunes(event.target.checked)} />}>
            {vegetationDesertDunes ? <>
              <InspectorNote>Sand desert only. Each dune is one crest line with hatching on its downwind slip face.</InspectorNote>
              <InspectorFold title="Shape" defaultOpen>
                {num("Dune spacing", vegetationDesertDuneSpacingKm, setVegetationDesertDuneSpacingKm, 0.2, 8, 0.05, { unit: "km", key: "vegetationDesertDuneSpacingKm", log: true, title: "Distance between crests" })}
                <InspectorNote>{`Wind from ${compassLabel(windAzimuthDeg)} (${Math.round(windAzimuthDeg)}°): crests run across it and slip faces face downwind. Change it under Terrain › Climate › Wind direction.`}</InspectorNote>
                {num("Crest scallops", vegetationDesertCrestScallop, setVegetationDesertCrestScallop, 0, 1, 0.05, { unit: "%", key: "vegetationDesertCrestScallop", title: "0 gives straight crests, higher values deep crescents with horns" })}
                {num("Terrain bend", vegetationDesertTerrainFollowing, setVegetationDesertTerrainFollowing, 0, 1, 0.05, { unit: "%", key: "vegetationDesertTerrainFollowing", title: "How much large landforms bend the crests" })}
              </InspectorFold>
              <InspectorFold title="Slip-face shading" defaultOpen>
                {num("Shadow length", vegetationDesertShadowLength, setVegetationDesertShadowLength, 0.1, 0.45, 0.01, { unit: "%", key: "vegetationDesertShadowLength", title: "Depth of the hatched slip face, as a share of the dune spacing" })}
                {num("Shadow strength", vegetationDesertShadowStrength, setVegetationDesertShadowStrength, 0, 1, 0.05, { unit: "%", key: "vegetationDesertShadowStrength" })}
                {num("Hatch density", vegetationDesertHatchDensity, setVegetationDesertHatchDensity, 0.25, 3, 0.05, { unit: "×", key: "vegetationDesertHatchDensity" })}
                {num("Ripple lines", vegetationDesertRippleLines, (next) => setVegetationDesertRippleLines(Math.round(next)), 0, 3, 1, { key: "vegetationDesertRippleLines", log: false, limits: [0, 3], title: "Faint broken lines on the windward side of each dune" })}
              </InspectorFold>
              <InspectorFold title="Line character" defaultOpen>
                {num("Line breaks", vegetationDesertLineBreaks, setVegetationDesertLineBreaks, 0, 1, 0.05, { unit: "%", key: "vegetationDesertLineBreaks", title: "How often crest and ripple lines break; every break tapers on both sides" })}
                {num("Dots", vegetationDesertDots, setVegetationDesertDots, 0, 1, 0.05, { unit: "%", key: "vegetationDesertDots", title: "Dotted trails through gaps and faded crest ends, plus scattered dots on the sand" })}
              </InspectorFold>
              <InspectorFold title="Wash" defaultOpen>
                {num("Highlight", vegetationDesertHighlight, setVegetationDesertHighlight, 0, 1, 0.05, { unit: "%", key: "vegetationDesertHighlight", title: "Brightening of dune faces turned towards the sun (Lighting tab)" })}
                {num("Color variation", vegetationDesertColorVariation, setVegetationDesertColorVariation, 0, 1, 0.05, { unit: "%", key: "vegetationDesertColorVariation", title: "Broad reddish-brown patches in the sand" })}
                {num("Patch size", vegetationDesertColorScaleKm, setVegetationDesertColorScaleKm, 0.5, 40, 0.1, { unit: "km", key: "vegetationDesertColorScaleKm", log: true, disabled: vegetationDesertColorVariation <= 0, title: "Typical size of the colour patches" })}
                {num("Shadow wash", vegetationDesertWashShadow, setVegetationDesertWashShadow, 0, 1, 0.05, { unit: "%", key: "vegetationDesertWashShadow", title: "Darkening of dune faces turned away from the sun" })}
              </InspectorFold>
              <InspectorFold title="Colors">
                <InspectorColor label="Sand" value={vegetationBiomeColors[15]} onChange={(color) => setVegetationBiomeColors((previous) => ({ ...previous, 15: color }))} />
                <InspectorColor label="Spots" value={vegetationDesertSpotColor} onChange={setVegetationDesertSpotColor} />
                <InspectorColor label="Ink" value={vegetationAridInkColor} onChange={setVegetationAridInkColor} />
              </InspectorFold>
            </> : <InspectorNote>Off: sand desert uses the ground pattern flow lines.</InspectorNote>}
          </InspectorSection>

          <InspectorSection title="Trees and shrubs">
            <ForestRenderControls
              settings={forestSettings}
              defaults={baselineSettings.forestSettings as ForestRenderSettings}
              treeDensityDefault={baselineRasterSettings.treeDensity}
              shrubDensityDefault={baselineRasterSettings.shrubDensity}
              biomeClusteringDefault={baselineRasterSettings.clustering}
              propScaleDefault={baselineSettings.vegetationRasterPropScale as number}
              standSizeDefault={baselineSettings.vegetationRasterPropStandSize as number}
              placementNoiseScaleDefault={baselineSettings.vegetationRasterPropPlacementNoiseScale as number}
              onSettingsChange={setForestSettings}
              treeDensity={selectedRasterSettings.treeDensity}
              onTreeDensityChange={(density) => {
                updateRasterBiome("treeDensity", density);
                setForestSettings((previous) => ({ ...previous, density }));
              }}
              shrubDensity={selectedRasterSettings.shrubDensity}
              onShrubDensityChange={(density) => updateRasterBiome("shrubDensity", density)}
              treeColor={selectedStandStyle.tree}
              onTreeColorChange={(color) => updateRasterBiome("treeColor", color)}
              shrubColor={selectedStandStyle.shrub}
              onShrubColorChange={(color) => updateRasterBiome("shrubColor", color)}
              shrubTreeShare={selectedStandStyle.shrubTreeShare}
              onShrubTreeShareChange={(share) => updateRasterBiome("shrubTreeShare", share)}
              shrubTreeShareDefault={propStandStyleForBiome(
                normalizeForestRenderSettings(baselineSettings.forestSettings),
                baselineSettings.vegetationRasterPropBiomeSettings as RasterPropBiomeSettings | undefined,
                rasterPropBiome,
              ).shrubTreeShare}
              clustering={selectedRasterSettings.clustering}
              onClusteringChange={(clustering) => {
                updateRasterBiome("clustering", clustering);
                setForestSettings((previous) => ({ ...previous, clustering }));
              }}
              placementNoiseScale={vegetationRasterPropPlacementNoiseScale}
              onPlacementNoiseScaleChange={setVegetationRasterPropPlacementNoiseScale}
              biome={rasterPropBiome}
              biomeOptions={RASTER_PROP_BIOMES.map((biome) => ({ id: biome, label: MOUNTAIN_BIOME_LABELS[biome] }))}
              onBiomeChange={setRasterPropBiome}
              treeScale={vegetationRasterPropScale}
              onTreeScaleChange={setVegetationRasterPropScale}
              standSize={vegetationRasterPropStandSize}
              onStandSizeChange={setVegetationRasterPropStandSize}
              sourceZoom={forestSourceZoom}
              onSourceZoomChange={setForestSourceZoom}
              sourceUrls={[
                ...ALPINE_TREE_75_ASSET_URLS,
                ...WETLAND_VEGETATION_PROP_DEFINITIONS.map((definition) => definition.url),
              ]}
            />
            <InspectorFold title="Colors">
              <InspectorColor label="Wood" value={forestSettings.wetlandWoodColor}
                onChange={(color) => setForestSettings((previous) => ({ ...previous, wetlandWoodColor: color }))} />
              <InspectorColor label="Outline" value={forestOutlineColor} onChange={setForestOutlineColor} />
            </InspectorFold>
          </InspectorSection>

          <InspectorSection title="Mountain linework">
            {num("Line scale", mountainLineworkScale, setMountainLineworkScale, MOUNTAIN_LINEWORK_SCALE_MIN, MOUNTAIN_LINEWORK_SCALE_MAX, 0.05, { unit: "×", key: "mountainLineworkScale" })}
            {num("Ridge density", mountainRidgeDensity, setMountainRidgeDensity, MOUNTAIN_RIDGE_DENSITY_MIN, MOUNTAIN_RIDGE_DENSITY_MAX, 0.05, { unit: "×", key: "mountainRidgeDensity" })}
            {num("Ridge thickness", mountainRidgeThickness, setMountainRidgeThickness, MOUNTAIN_RIDGE_THICKNESS_MIN, MOUNTAIN_RIDGE_THICKNESS_MAX, 0.01, { unit: "×", key: "mountainRidgeThickness" })}
            {num("Ridge opacity", mountainLineworkOpacity, setMountainLineworkOpacity, MOUNTAIN_LINEWORK_OPACITY_MIN, MOUNTAIN_LINEWORK_OPACITY_MAX, 0.05, { unit: "%", key: "mountainLineworkOpacity" })}
            {num("Hatch density", mountainHatchDensity, setMountainHatchDensity, MOUNTAIN_HATCH_DENSITY_MIN, MOUNTAIN_HATCH_DENSITY_MAX, 0.05, { unit: "×", key: "mountainHatchDensity" })}
            {num("Hatch thickness", mountainHatchThickness, setMountainHatchThickness, MOUNTAIN_HATCH_THICKNESS_MIN, MOUNTAIN_HATCH_THICKNESS_MAX, 0.01, { unit: "×", key: "mountainHatchThickness" })}
            {num("Contour hatch opacity", mountainHatchHorizontalOpacity, setMountainHatchHorizontalOpacity, MOUNTAIN_HATCH_OPACITY_MIN, MOUNTAIN_HATCH_OPACITY_MAX, 0.05, { unit: "%", key: "mountainHatchHorizontalOpacity" })}
            {num("Downhill hatch opacity", mountainHatchVerticalOpacity, setMountainHatchVerticalOpacity, MOUNTAIN_HATCH_OPACITY_MIN, MOUNTAIN_HATCH_OPACITY_MAX, 0.05, { unit: "%", key: "mountainHatchVerticalOpacity" })}
            <InspectorColor label="Ridge color" value={mountainRidgeColor} onChange={setMountainRidgeColor} />
            <InspectorColor label="Hatch color" value={mountainHatchColor} onChange={setMountainHatchColor} />
            <InspectorFold title="Advanced local mountain detail">
              <InspectorNote>Adds marks on lower-relief faces on top of the 1× mountain baseline.</InspectorNote>
              {num("Detail ceiling", mountainLocalDetailDensityMax, setMountainLocalDetailDensityMax, MOUNTAIN_LOCAL_DETAIL_DENSITY_MIN, MOUNTAIN_LOCAL_DETAIL_DENSITY_MAX, 0.05, { unit: "×", key: "mountainLocalDetailDensityMax", limits: [MOUNTAIN_LOCAL_DETAIL_DENSITY_MIN, Infinity] })}
              {num("Foothill multiplier", mountainFoothillDetailMultiplier, setMountainFoothillDetailMultiplier, MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_MIN, MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_MAX, 0.05, { unit: "×", key: "mountainFoothillDetailMultiplier", limits: [MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_MIN, Infinity] })}
              {num("Biome multiplier", mountainBiomeDetailMultiplier, setMountainBiomeDetailMultiplier, MOUNTAIN_BIOME_DETAIL_MULTIPLIER_MIN, MOUNTAIN_BIOME_DETAIL_MULTIPLIER_MAX, 0.05, { unit: "×", key: "mountainBiomeDetailMultiplier" })}
            </InspectorFold>
          </InspectorSection>

          <InspectorSection title="Contours" aside={<input type="checkbox" aria-label="Show contours" checked={showContours} onChange={(event) => setShowContours(event.target.checked)} />}>
            {showContours ? <>
              <InspectorSelect label="Interval" value={contourIntervalM} options={[25, 50, 100, 250].map((m) => [m, `${m} m`] as const)} onChange={setContourIntervalM} />
              <InspectorSelect label="Smoothing" value={contourSmoothingPasses} options={SMOOTHING_LABELS.map((label, passes) => [passes, label] as const)} onChange={setContourSmoothingPasses} />
              {num("Minor line weight", contourThicknessM, setContourThicknessM, 1, 16, 1, { unit: "m", key: "contourThicknessM" })}
              {num("Opacity", contourOpacity, setContourOpacity, 0.1, 1, 0.05, { unit: "%", key: "contourOpacity", log: false })}
              <InspectorColor label="Minor color" value={contourColor} onChange={setContourColor} />
              <InspectorToggle label="Index lines" checked={showIndexContours} onChange={setShowIndexContours} />
              {showIndexContours && <>
                <InspectorSelect label="Index every" value={contourIndexEvery} options={[2, 5, 10].map((n) => [n, `${n}th`] as const)} onChange={setContourIndexEvery} />
                {num("Index line weight", contourIndexThicknessM, setContourIndexThicknessM, 1, 20, 1, { unit: "m", key: "contourIndexThicknessM", log: false })}
                <InspectorColor label="Index color" value={contourIndexColor} onChange={setContourIndexColor} />
              </>}
            </> : <InspectorNote>Off</InspectorNote>}
          </InspectorSection>

          <InspectorSection title="Diagnostics">
            <InspectorToggle label="Flow lines" checked={vegetationShowFlowGuides} onChange={setVegetationShowFlowGuides} />
            <InspectorToggle label="Wetland dryness" checked={vegetationShowWetlandDrynessOverlay} onChange={setVegetationShowWetlandDrynessOverlay} />
            <InspectorToggle label="Tree suitability" checked={vegetationShowAlpineTreeSuitability} onChange={setVegetationShowAlpineTreeSuitability} />
            {vegetationShowAlpineTreeSuitability && <div>
              <div aria-hidden="true" className="h-1.5 rounded" style={{ background: "linear-gradient(90deg, #a50026 0%, #f46d43 25%, #fee08b 50%, #a6d96a 75%, #1a9850 100%)" }} />
              <div className="mt-0.5 flex justify-between text-[10px] text-slate-500"><span>Less suitable</span><span>More suitable</span></div>
            </div>}
            <InspectorFold title="Artwork previews">
              <div className="grid grid-cols-8 gap-1">
                {VEGETATION_MOTIF_DEFINITIONS.map((definition) =>
                  <img key={definition.key} src={definition.url} alt={definition.label} title={definition.label}
                    className="aspect-square w-full rounded bg-slate-200 object-contain p-0.5" />)}
              </div>
            </InspectorFold>
          </InspectorSection>
        </>}

        {inspectorTab === "Water" && <>
          <InspectorSection title="Water">
            <InspectorToggle label="Water details" checked={showWaterDetails} title="Water outlines, charcoal marks and waves"
              onChange={(checked) => { setShowWaterDetails(checked); setShowOceanDetails(checked); }} />
            <InspectorToggle label="Rivers" checked={showRivers} onChange={setShowRivers} />
            <InspectorColor label="Shallow water" value={waterShallowColor} onChange={setWaterShallowColor} />
            <InspectorColor label="Deep water" value={waterDeepColor} onChange={setWaterDeepColor} />
            {num("Terrain shade on water", waterTerrainShadeStrength, setWaterTerrainShadeStrength, 0, 1, 0.01, { unit: "%", key: "waterTerrainShadeStrength" })}
          </InspectorSection>

          <InspectorSection title="Rivers and coasts">
            {num("Outline thickness", waterOutlineThickness, setWaterOutlineThickness, 0, 3, 0.01, { unit: "px", key: "waterOutlineThickness", disabled: !showWaterDetails })}
            {num("Outline opacity", waterOutlineOpacity, setWaterOutlineOpacity, 0, 1, 0.05, { unit: "%", key: "waterOutlineOpacity", disabled: !showWaterDetails })}
            <InspectorColor label="Outline color" value={waterOutlineColor} onChange={setWaterOutlineColor} disabled={!showWaterDetails} />
            {num("Charcoal density", waterFlowDensity, setWaterFlowDensity, 0, 2.5, 0.05, { unit: "×", key: "waterFlowDensity", disabled: !showWaterDetails })}
            {num("Charcoal opacity", waterFlowOpacity, setWaterFlowOpacity, 0, 1, 0.05, { unit: "%", key: "waterFlowOpacity", disabled: !showWaterDetails })}
            <InspectorColor label="Charcoal color" value={waterFlowColor} onChange={setWaterFlowColor} disabled={!showWaterDetails} />
            <InspectorFold title="Advanced line settings">
              {num("Wave stroke length", waterOutlineLength, setWaterOutlineLength, 0.2, 10, 0.05, { unit: "×", key: "waterOutlineLength", disabled: !showWaterDetails })}
              <InspectorSelect label="Outline smoothing" value={waterOutlineSmoothing} disabled={!showWaterDetails}
                options={SMOOTHING_LABELS.map((label, passes) => [passes, label] as const)} onChange={setWaterOutlineSmoothing} />
              {num("Charcoal length", waterFlowLength, setWaterFlowLength, 0.2, 3, 0.05, { unit: "×", key: "waterFlowLength", disabled: !showWaterDetails })}
              {num("Charcoal thickness", waterFlowThickness, setWaterFlowThickness, 0.2, 3, 0.01, { unit: "×", key: "waterFlowThickness", disabled: !showWaterDetails })}
              <InspectorSelect label="Charcoal smoothing" value={waterFlowSmoothing} disabled={!showWaterDetails}
                options={SMOOTHING_LABELS.map((label, passes) => [passes, label] as const)} onChange={setWaterFlowSmoothing} />
              {num("Coastal bands", oceanRippleCount, (next) => setOceanRippleCount(Math.round(next)), 1, 12, 1, { key: "oceanRippleCount", limits: [1, 12], disabled: !showWaterDetails, log: false })}
              {num("Lake full depth", lakeFullDepthM, setLakeFullDepthM, 1, 200, 1, { unit: "m", key: "lakeFullDepthM", title: "Lake depth that reaches the deep water colour" })}
            </InspectorFold>
          </InspectorSection>

          <InspectorSection title="Ocean waves" aside={<input type="checkbox" aria-label="Show ocean waves" checked={deepOceanSwells} disabled={!showWaterDetails} onChange={(event) => setDeepOceanSwells(event.target.checked)} />}>
            {deepOceanSwells ? <>
              {num("Density", deepOceanSwellDensity, setDeepOceanSwellDensity, 0, 1, 0.02, { unit: "%", key: "deepOceanSwellDensity", disabled: !showWaterDetails })}
              {num("Length", deepOceanWaveLength, setDeepOceanWaveLength, 0.2, 10, 0.05, { unit: "×", key: "deepOceanWaveLength", disabled: !showWaterDetails })}
              {num("Thickness", deepOceanStrokeThickness, setDeepOceanStrokeThickness, 0, 3, 0.01, { unit: "px", key: "deepOceanStrokeThickness", disabled: !showWaterDetails })}
              <InspectorFold title="Advanced turbulence and shading">
                {num("Face / trough scale", deepOceanWaveShadingScale, setDeepOceanWaveShadingScale, 0.5, 8, 0.05, { unit: "×", key: "deepOceanWaveShadingScale", disabled: !showWaterDetails })}
                {num("Shading intensity", deepOceanWaveShadingIntensity, setDeepOceanWaveShadingIntensity, 0, 4, 0.05, { unit: "×", key: "deepOceanWaveShadingIntensity", disabled: !showWaterDetails })}
                {num("Turbulence scale", deepOceanTurbulenceScale, setDeepOceanTurbulenceScale, 0.5, 8, 0.05, { unit: "×", key: "deepOceanTurbulenceScale", disabled: !showWaterDetails })}
                {num("Turbulence intensity", deepOceanTurbulenceIntensity, setDeepOceanTurbulenceIntensity, 0, INSPECTOR_BOUNDS.oceanTurbulence, 0.05, { unit: "×", key: "deepOceanTurbulenceIntensity", disabled: !showWaterDetails })}
              </InspectorFold>
            </> : <InspectorNote>Off</InspectorNote>}
          </InspectorSection>

          <InspectorSection title="Wetland pools" aside={<input type="checkbox" aria-label="Show wetland pools" checked={showWetlandPuddleContours} disabled={!showWaterDetails} onChange={(event) => setShowWetlandPuddleContours(event.target.checked)} />}>
            {showWetlandPuddleContours ? <>
              {num("Density", wetlandPuddleDensity, setWetlandPuddleDensity, 0, 2, 0.05, { unit: "×", key: "wetlandPuddleDensity", disabled: !showWaterDetails })}
              {num("Minimum size", wetlandPuddleSizeMin, (next) => { setWetlandPuddleSizeMin(next); setWetlandPuddleSizeMax((current) => Math.max(current, next)); }, INSPECTOR_BOUNDS.poolSizeMin, 1, 0.005, { unit: "%", key: "wetlandPuddleSizeMin", limits: [INSPECTOR_BOUNDS.poolSizeMin, 1], disabled: !showWaterDetails })}
              {num("Maximum size", wetlandPuddleSizeMax, (next) => { setWetlandPuddleSizeMax(next); setWetlandPuddleSizeMin((current) => Math.min(current, next)); }, INSPECTOR_BOUNDS.poolSizeMin, 1, 0.005, { unit: "%", key: "wetlandPuddleSizeMax", limits: [INSPECTOR_BOUNDS.poolSizeMin, 1], disabled: !showWaterDetails })}
              {num("Coast clearance", wetlandPuddleCoastDistance, setWetlandPuddleCoastDistance, 0, 2, 0.05, { unit: "×", key: "wetlandPuddleCoastDistance", disabled: !showWaterDetails })}
              {num("Shoreline stroke length", wetlandPoolContourLength, setWetlandPoolContourLength, 0.2, 5, 0.05, { unit: "×", key: "wetlandPoolContourLength", disabled: !showWaterDetails })}
              <InspectorSeed value={wetlandPuddleSeed} onChange={setWetlandPuddleSeed} disabled={!showWaterDetails} />
            </> : <InspectorNote>Off</InspectorNote>}
          </InspectorSection>

          <InspectorSection title="River silt">
            {num("Reach", siltReachM, setSiltReachM, 0, 6000, 100, { unit: "m", key: "siltReachM", title: "How far floods laid down silt; 0 turns silt off" })}
            {num("Top layers removed", siltTopRemoved, setSiltTopRemoved, 0, 4, 0.1, { key: "siltTopRemoved" })}
            {num("Layers", siltLayers, (next) => setSiltLayers(Math.round(next)), 1, 10, 1, { key: "siltLayers", limits: [1, Infinity], log: false })}
          </InspectorSection>
        </>}

        {inspectorTab === "Lighting" && <>
          <InspectorSection title="Sun">
            {num("Azimuth", sunAzimuthDeg, setSunAzimuthDeg, 0, 360, 5, { unit: `° ${getCompassHeading(sunAzimuthDeg)}`, key: "sunAzimuthDeg" })}
            {num("Altitude", sunAltitudeDeg, setSunAltitudeDeg, 10, 85, 1, { unit: "°", key: "sunAltitudeDeg", limits: [0, 90], log: false })}
          </InspectorSection>

          <InspectorSection title="Terrain shading">
            {num("Hillshade", hillshadeStrength, setHillshadeStrength, 0, 1, 0.01, { unit: "%", key: "hillshadeStrength" })}
            {num("Ambient occlusion", aoStrength, setAoStrength, 0, 1, 0.05, { unit: "%", key: "aoStrength" })}
            {num("Relief exaggeration", vertExagg, setVertExagg, 1, 8, 0.2, { unit: "×", key: "vertExagg", log: false })}
            <InspectorSelect label="Mountain faces" value={mountainLightingMode} onChange={setMountainLightingMode}
              options={[["two-tone", "Two tone"], ["three-tone", "Three tone"], ["continuous", "Continuous"]]} />
          </InspectorSection>

          <InspectorSection title="Camera" aside={<label className="flex items-center gap-1.5 text-[12px] text-slate-300">Tilted
            <input type="checkbox" aria-label="Tilted full-terrain camera" checked={fullTerrainCameraEnabled} onChange={(event) => setFullTerrainCameraEnabled(event.target.checked)} /></label>}>
            {fullTerrainCameraEnabled ? <>
              <InspectorSelect label="Projection" value={fullTerrainCameraType} onChange={setFullTerrainCameraType}
                options={[["orthographic", "Orthographic"], ["perspective", "Perspective (35° FOV)"]]} />
              {num("Elevation", fullTerrainCameraElevationDeg, setFullTerrainCameraElevationDeg, 30, 85, 1, { unit: "°", key: "fullTerrainCameraElevationDeg", limits: [1, 89], log: false })}
              {num("Height exaggeration", fullTerrainCameraHeightExaggeration, setFullTerrainCameraHeightExaggeration, 0.25, 3, 0.05, { unit: "×", key: "fullTerrainCameraHeightExaggeration", log: false })}
              <InspectorNote>Effective terrain height {(fullTerrainCameraHeightExaggeration * vertExagg).toFixed(1)}×</InspectorNote>
            </> : <>
              {num("Mountain view angle", mountainViewAngleDeg, setMountainViewAngleDeg, 75, 90, 1, { unit: "°", key: "mountainViewAngleDeg", limits: [1, 90], log: false, title: "90° is overhead; lower angles lift only the mountain faces" })}
              {num("Mountain height", mountainHeightExaggeration, setMountainHeightExaggeration, 1, 2, 0.1, { unit: "×", key: "mountainHeightExaggeration" })}
            </>}
          </InspectorSection>
        </>}
        </div>

        <div className="shrink-0 border-t border-white/5 px-4 py-2">
          <button type="button" onClick={handleResetToCurrentSettings} title="Restore every setting from currentSettings"
            className="flex items-center gap-1.5 text-[12px] text-slate-400 hover:text-slate-100">
            <RotateCcw size={12} />Reset all to defaults
          </button>
        </div>
      </aside>

      {isExportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onCloseExport}>
          <div role="dialog" aria-modal="true" aria-labelledby="export-dialog-title" onMouseDown={(event) => event.stopPropagation()}
            className="flex w-full max-w-sm flex-col rounded-lg border border-white/10 bg-[#1f232b] text-slate-200 shadow-2xl">
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-white/5 pl-4 pr-2">
              <h2 id="export-dialog-title" className="text-[13px] font-semibold text-slate-100">Export</h2>
              <button type="button" onClick={onCloseExport} aria-label="Close export dialog"
                className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-slate-100"><X size={15} /></button>
            </div>

            <InspectorSection title="Resolution" collapsible={false} aside={<span className="text-[11px] tabular-nums text-slate-400">
              {outputSize ? `${outputSize.width} × ${outputSize.height} px` : "—"}</span>}>
              <div role="radiogroup" aria-label="Resolution preset" className="flex rounded-md bg-black/30 p-0.5">
                {MOUNTAIN_RESOLUTION_PRESETS.map((resolution) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={outputLongEdge === resolution}
                    key={resolution}
                    onClick={() => setOutputLongEdge(resolution)}
                    disabled={Boolean(exportProgress)}
                    title={resolution === 16384 ? "16K uses about 4× the memory of 8K" : `${resolution} px on the long edge`}
                    className={`flex-1 rounded py-1 text-[12px] disabled:opacity-40 ${outputLongEdge === resolution ? "bg-slate-600 text-white shadow" : "text-slate-400 hover:text-slate-100"}`}
                  >
                    {resolution >= 1024 ? `${resolution / 1024}K` : resolution}
                  </button>
                ))}
              </div>
              {num("Long edge", outputLongEdge, (next) => setOutputLongEdge(Math.round(next)), MIN_MOUNTAIN_RENDER_RESOLUTION, MAX_MOUNTAIN_RENDER_RESOLUTION, 1,
                { unit: "px", log: true, limits: [MIN_MOUNTAIN_RENDER_RESOLUTION, MAX_MOUNTAIN_RENDER_RESOLUTION], disabled: Boolean(exportProgress) })}
              <InspectorToggle label="Split into 4 horizontal strips" checked={splitExportIntoStrips}
                disabled={Boolean(exportProgress)} onChange={setSplitExportIntoStrips} />
              {splitExportIntoStrips && (
                <label className="flex flex-col gap-1 text-[12px] text-slate-300">
                  Parts to render
                  <select
                    value={exportStrip}
                    onChange={(event) => setExportStrip(event.target.value as typeof exportStrip)}
                    disabled={Boolean(exportProgress)}
                    className="rounded border border-white/10 bg-[#292e38] px-2 py-1.5 text-slate-100 disabled:opacity-40"
                  >
                    <option value="all">All 4 parts</option>
                    <option value="1">Part 1 (top)</option>
                    <option value="2">Part 2</option>
                    <option value="3">Part 3</option>
                    <option value="4">Part 4 (bottom)</option>
                  </select>
                </label>
              )}
              <InspectorNote>Exports re-analyze the source at the chosen size; 16K may need a lot of memory.</InspectorNote>
            </InspectorSection>

            <div className="flex flex-col gap-2 px-4 py-3">
              <button
                type="button"
                onClick={() => {
                  handleExportImage();
                  onCloseExport();
                }}
                disabled={isLoading || Boolean(exportProgress)}
                className="flex items-center justify-center gap-1.5 rounded bg-sky-600 py-1.5 text-[12px] font-medium text-white hover:bg-sky-500 disabled:opacity-40"
              >
                <Download size={13} /> Export map (PNG)
              </button>
              <button
                type="button"
                onClick={() => {
                  handleExportWaterEvolvedHeightmap();
                  onCloseExport();
                }}
                disabled={!demData}
                className="rounded border border-white/10 bg-white/5 py-1.5 text-[12px] text-slate-200 hover:bg-white/10 disabled:opacity-40"
              >
                Export water-evolved heightmap (16-bit PNG)
              </button>
            </div>
          </div>
        </div>
      )}

      {globalDemOpen && (
        <Suspense fallback={null}>
          <GlobalDemDialog onClose={() => setGlobalDemOpen(false)} onLoad={handleGlobalDemLoad} />
        </Suspense>
      )}
    </div>
  );
}

function getCompassHeading(deg: number): string {
  const norm = ((deg % 360) + 360) % 360;
  if (norm >= 337.5 || norm < 22.5) return "N";
  if (norm < 67.5) return "NE";
  if (norm < 112.5) return "E";
  if (norm < 157.5) return "SE";
  if (norm < 202.5) return "S";
  if (norm < 247.5) return "SW";
  if (norm < 292.5) return "W";
  return "NW";
}

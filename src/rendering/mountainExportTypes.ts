import type { BaseDEMOptions, MountainDEMData } from "../terrain/mountainBaseDEM";
import type { MountainRenderOptions, VegetationWashGrid } from "./mountainDetailRenderer";
import type { RiverSpline } from "./waterRenderer";
import type { VegetationGeometry } from "./vegetationRenderer";
import type { MountainProfiler } from "./mountainProfiler";
import type { MountainSnowTransportFields } from "./mountainIllustrationRenderer";
import type { MountainPatternOverlay } from "./mountainPatternRenderer";

/** A serialisable source heightmap snapshot used by the export worker. */
export interface MountainExportSource {
  width: number;
  height: number;
  luminance: Float32Array;
  oceanMask?: Uint8Array;
}

/** The viewport's authoritative DEM water surface, reused by export tiles. */
export interface MountainExportWaterSurface {
  width: number;
  height: number;
  wetlandPoolMask: Uint8Array;
  visualWaterMask: Uint8Array;
  wetlandPoolCoverage: Float32Array;
  visualWaterCoverage: Float32Array;
}

/** Analysis/presentation parameters are intentionally separate from output size. */
export interface MountainExportSettings {
  analysis: BaseDEMOptions;
  render: MountainRenderOptions;
  heightmapSmoothingPasses?: number;
  outputWidth: number;
  outputHeight: number;
  /** Maximum global analysis long edge. Kept separate from output resolution. */
  analysisLongEdge?: number;
  tileSize?: number;
  halo?: number;
}

export interface MountainExportRequest extends MountainExportSettings {
  type: "export";
  id: number;
  /** Monotonic source-load revision used to reject results for an old map. */
  sourceRevision: number;
  source: MountainExportSource;
  /** Viewport water decisions, resampled to the export analysis grid as needed. */
  waterSurface?: MountainExportWaterSurface;
  /**
   * The preview's finished analysis. Used instead of analysing again when it
   * has the export's analysis size (the live 4K preview sends it).
   */
  analysisDem?: MountainDEMData;
  filename: string;
  /**
   * Optional output row range [rowStart, rowEnd). The full output geometry is
   * still used, so strips stitch into exactly the unsplit image.
   */
  rowStart?: number;
  rowEnd?: number;
  /** Optional output column range [colStart, colEnd), used by region previews. */
  colStart?: number;
  colEnd?: number;
  /** Enable console timing for this export request. */
  profile?: boolean;
  /**
   * Optional camera-tile helper memory budget in GB. Without it the worker
   * derives the budget from the machine's reported RAM.
   */
  helperMemoryGb?: number;
  /**
   * Camera-tile helper workers chosen in the export dialog. Without it the
   * count follows the memory budget; with it the budget grows to admit that
   * many typical tiles, so it can exceed what the machine safely holds.
   */
  helperCount?: number;
  /** Internal diagnostic switch used to compare camera export scheduling. */
  debugForceSerialCameraTiles?: boolean;
  /**
   * `pixels` returns the raw RGBA image instead of a PNG, for the live 4K
   * preview, which draws it straight onto a canvas.
   */
  output?: "png" | "pixels";
  /**
   * Keep the camera band plans made while planning texture tiles (within
   * 256 MB) and draw from them instead of rasterizing each band again. The
   * live 4K preview sets it; exports keep their memory for the helpers.
   */
  reuseCameraBandPlans?: boolean;
}

export interface MountainExportProgress {
  type: "progress";
  id: number;
  completedTiles: number;
  totalTiles: number;
  phase: "analysis" | "rendering" | "projecting" | "encoding";
  completedRows?: number;
  totalRows?: number;
  message?: string;
  stage?: string;
  stageStartedAt?: number;
  completedStages?: MountainExportStageTiming[];
  stageCompleted?: number;
  stageTotal?: number;
}

export interface MountainExportStageTiming {
  label: string;
  durationMs: number;
}

export interface MountainExportResult {
  type: "result";
  id: number;
  filename: string;
  blob: Blob;
  completedStages?: MountainExportStageTiming[];
}

/** The finished image of an `output: "pixels"` request. */
export interface MountainExportPixelsResult {
  type: "pixels";
  id: number;
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
  completedStages?: MountainExportStageTiming[];
}

export interface MountainExportError {
  type: "error";
  id: number;
  message: string;
}

export interface MountainExportCancelled {
  type: "cancelled";
  id: number;
  completedTiles: number;
  totalTiles: number;
}

export type MountainExportWorkerResponse =
  | MountainExportProgress
  | MountainExportResult
  | MountainExportPixelsResult
  | MountainExportError
  | MountainExportCancelled;

export interface MountainExportTile {
  x: number;
  y: number;
  width: number;
  height: number;
  halo: number;
}

/** Internal hand-off shape used by the tile renderer. */
export interface MountainExportGlobalContext {
  dem: MountainDEMData;
  source: MountainExportSource;
  render: MountainRenderOptions;
  /** River vectors built once from the global DEM and transformed per tile. */
  riverSplines?: readonly RiverSpline[];
  /** Vegetation paths and motif placements generated once in global DEM coordinates. */
  vegetationGeometry?: VegetationGeometry;
  /** Visible-water distance field generated once for wetland dry patches. */
  vegetationWaterDistance?: Float32Array;
  /** Distance from global ocean cells to the nearest dry cell, in global pixels. */
  oceanDistanceToCoast?: Float32Array;
  /** Maximum finite value in the global ocean distance field, in source pixels. */
  oceanDistanceToCoastMax?: number;
  /** Global open-sea mask (beach classification test) that bounds ocean waves. */
  openOceanMask?: Uint8Array;
  /** Smoothed global ocean coverage used for antialiased tile coastlines. */
  oceanMaskCoverage?: Float32Array;
  /**
   * The vegetation layer's biome wash grid for the whole output, built once
   * (buildExportVegetationWashGrid). Tiles take their cells of it, so their
   * compositor frames need no biome-wash halo.
   */
  vegetationWashGrid?: VegetationWashGrid;
  /** Native-resolution snow predictors prepared once for the export snapshot. */
  snowTransport?: MountainSnowTransportFields;
  /**
   * Global mountain drawing, built lazily on first use. It lives on the
   * context so tile helper workers receive it with the cloned context rather
   * than each rebuilding it from the DEM.
   */
  mountainPattern?: MountainPatternOverlay;
  /** Optional internal stage callback for camera texture-tile work. */
  onTileStage?: (label: string) => void;
  outputWidth: number;
  outputHeight: number;
  profiler?: MountainProfiler;
}

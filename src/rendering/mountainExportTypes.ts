import type { BaseDEMOptions, MountainDEMData } from "../terrain/mountainBaseDEM";
import type { MountainRenderOptions } from "./mountainDetailRenderer";
import type { TownStampRaster } from "../structures/townStamp";
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
  /** Internal diagnostic switch used to compare camera export scheduling. */
  debugForceSerialCameraTiles?: boolean;
  /** Towns pre-rendered at export scale, drawn upright over the final image. */
  townStamps?: TownStampRaster[];
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

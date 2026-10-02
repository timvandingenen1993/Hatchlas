/**
 * Request, result and metadata types for the mountain preview worker.
 */
import type {
  BaseDEMOptions,
  MountainDEMData,
} from "../terrain/mountainBaseDEM";
import type {
  MountainRenderOptions,
  MountainRenderStageStats,
} from "./mountainDetailRenderer";
import type { MountainProfileReport } from "./mountainProfiler";
import type {
  VegetationMotifAsset,
  VegetationRasterPropAsset,
} from "./vegetationRenderer";

export interface MountainPreviewSource {
  width: number;
  height: number;
  luminance: Float32Array;
  oceanMask?: Uint8Array;
}

export interface MountainPreviewMetadata {
  width: number;
  height: number;
  domainWidthKm: number;
  domainHeightKm: number;
  minElevationM: number;
  maxElevationM: number;
  riverThresholdKm2: number;
}

export interface MountainPreviewFlowSnapshot {
  width: number;
  height: number;
  slopeDeg: Float32Array;
  flowDirection: Int8Array;
  isRiverChannel: Uint8Array;
  strahlerOrder: Uint8Array;
}

/**
 * Backend currently used for mountain support-field preparation in the
 * preview worker. The UI keeps the initial `checking` state until the first
 * mountain illustration request reports which backend was actually selected.
 */
export type MountainPreviewBackendStatus =
  | "checking"
  | "initializing"
  | "webgpu"
  | "cpu";

export interface MountainPreviewInspectResult {
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
}

export interface MountainPreviewProfileResult {
  distanceKm: number[];
  elevationM: number[];
  slopeDeg: number[];
  biomeNames: string[];
  points: { x: number; y: number }[];
}

export type MountainPreviewRequest =
  | {
      type: "source";
      sourceRevision: number;
      source: MountainPreviewSource;
    }
  | {
      type: "assets";
      vegetationMotifs?: VegetationMotifAsset[] | null;
      rasterProps?: VegetationRasterPropAsset[] | null;
    }
  | {
      type: "analyze";
      requestId: number;
      sourceRevision: number;
      analysisRevision: number;
      analysisLongEdge: number;
      heightmapSmoothingPasses: number;
      quality?: "draft" | "final";
      options: BaseDEMOptions;
      profile?: boolean;
    }
  | {
      type: "render";
      requestId: number;
      settingsRevision: number;
      analysisRevision: number;
      options: MountainRenderOptions;
      quality?: "draft" | "final";
      profile?: boolean;
    }
  | {
      type: "inspect";
      requestId: number;
      analysisRevision: number;
      x: number;
      y: number;
    }
  | {
      type: "profile";
      requestId: number;
      analysisRevision: number;
      p0: { x: number; y: number };
      p1: { x: number; y: number };
      samples: number;
    }
  | {
      type: "waterSnapshot";
      requestId: number;
      analysisRevision: number;
      options: Pick<
        MountainRenderOptions,
        | "wetlandPuddleContours"
        | "wetlandPuddleDensity"
        | "wetlandPuddleSizeMin"
        | "wetlandPuddleSizeMax"
        | "wetlandPuddleCoastDistance"
        | "wetlandPuddleSeed"
        | "riverThresholdKm2"
        | "siltReachM"
        | "siltTopRemoved"
      >;
    }
  | {
      type: "heightmap";
      requestId: number;
      analysisRevision: number;
      outputWidth: number;
      outputHeight: number;
    };

export type MountainPreviewResponse =
  | {
      type: "status";
      requestId: number;
      settingsRevision?: number;
      quality?: "draft" | "final";
      phase: "analysis" | "lighting" | "water" | "vegetation" | "rendering";
    }
  | {
      type: "backendStatus";
      requestId: number;
      backend: Exclude<MountainPreviewBackendStatus, "checking">;
      reason?: string;
    }
  | {
      type: "analysisReady";
      requestId: number;
      analysisRevision: number;
      quality?: "draft" | "final";
      metadata: MountainPreviewMetadata;
      flow?: MountainPreviewFlowSnapshot;
      dem?: MountainDEMData;
    }
  | {
      type: "frame";
      requestId: number;
      settingsRevision: number;
      analysisRevision: number;
      quality: "draft" | "final";
      width: number;
      height: number;
      bitmap?: ImageBitmap;
      imageData?: ImageData;
      stats: MountainRenderStageStats;
      elapsedMs: number;
      profile?: MountainProfileReport;
    }
  | {
      type: "inspectResult";
      requestId: number;
      analysisRevision: number;
      value: MountainPreviewInspectResult;
    }
  | {
      type: "profileResult";
      requestId: number;
      analysisRevision: number;
      value: MountainPreviewProfileResult;
    }
  | {
      type: "waterSnapshotResult";
      requestId: number;
      analysisRevision: number;
      value: Pick<
        MountainDEMData,
        | "width"
        | "height"
        | "wetlandPoolMask"
        | "visualWaterMask"
        | "wetlandPoolCoverage"
        | "visualWaterCoverage"
      >;
    }
  | {
      type: "heightmapResult";
      requestId: number;
      analysisRevision: number;
      width: number;
      height: number;
      normalizedElevation: Float32Array;
    }
  | {
      type: "error";
      requestId: number;
      message: string;
    };

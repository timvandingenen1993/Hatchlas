import type { SimulationConfig } from './config';
import type { TectonicConservationLedger, TectonicSimulationTimeline } from '../tectonics/plateEngine/types';

/**
 * WorldV2 Data Structure and Type Definitions
 * 
 * Physical units:
 * - Distance / Coordinates: Meters (m) on Earth-scale sphere (R = 6,371,000 m)
 * - Area: Square meters (m^2)
 * - Elevation / Topography: Meters (m) relative to sea level (0 m datum)
 * - Crust Thickness: Kilometers (km) or meters (m)
 * - Crust Density: kg/m^3 (Continental ~2750, Oceanic ~2950, Mantle ~3300)
 * - Crust Age: Million years (Myr)
 * - Temperature: Degrees Celsius (°C)
 * - Precipitation: Millimeters per month (mm/mo) or meters per year (m/yr)
 * - River Discharge Q: Cubic meters per second (m^3/s)
 * - Ice Thickness: Meters (m) of equivalent water/ice
 */

export type AnalysisLayer =
  | 'plate_ids'
  | 'plate_boundaries'
  | 'relative_velocity'
  | 'ownership_closure'
  | 'dominance_confidence'
  | 'continental_material'
  | 'crust_type'
  | 'crust_age'
  | 'elevation'
  | 'tectonic_uplift'
  | 'discharge'
  | 'lakes'
  | 'drainage_basins'
  | 'temperature_monthly'
  | 'precipitation_monthly'
  | 'ice_thickness'
  | 'biomes';



export interface TopologyData {
  resolution: number;        // Face resolution N (e.g. 96, 192, 256)
  totalCells: number;        // Total cells = 6 * N * N
  cellAreas: Float32Array;   // Surface area of each cell in m^2 (Ronchi 1996 metric)
  faceOffsets: Int32Array;   // Cell index offset for each of the 6 cube faces
  neighbors: Int32Array;     // Flattened 4-neighbor indices: [cellIdx * 4 + k] for k in [0..3]
}

export type BoundaryType = 'none' | 'convergent_subduction' | 'convergent_collision' | 'divergent_ridge' | 'divergent_rift' | 'transform';

export interface TectonicPlateData {
  id: number;
  name: string;
  eulerPole: [number, number, number]; // Unit vector [x, y, z] rotation axis on S^2
  angularVelocity: number;             // Radians per Myr (or deg/Myr)
  isOceanic: boolean;
  color: string;
}

export interface GeologyData {
  plateCount: number;
  plates: TectonicPlateData[];
  plateIds: Uint8Array;              // Plate index (0..255) for each cell
  crustType: Uint8Array;             // 0 = Oceanic, 1 = Continental, 2 = Transitional / Arc
  crustThickness: Float32Array;      // Crust thickness in meters (m)
  crustAge: Float32Array;            // Geological age in Myr
  boundaryType: Uint8Array;          // 0=None, 1=Subduction, 2=Collision, 3=Ridge, 4=Rift, 5=Transform
  tectonicUpliftRate: Float32Array;  // Dynamic tectonic uplift/subsidence rate in mm/yr
  /** Phase 2 aggregate continental thickness (volume / physical cell area), meters. */
  continentalThicknessM?: Float32Array;
  /** Dense conservative engine state, layout [cell * plateCount + plate]. */
  plateAreaFraction?: Float64Array;
  /** Dense Phase 2 reservoir, layout [cell * plateCount + plate], m^3. */
  continentalVolumeByPlateM3?: Float64Array;
  /** Dedicated timeline diagnostics; never stored in unrelated crust fields. */
  ownershipClosure?: Float32Array;
  dominanceConfidence?: Float32Array;
}

export interface LakeData {
  id: number;
  cellIndices: number[];
  bedElevation: number;     // Lowest bed elevation (m)
  waterLevel: number;       // Water surface elevation (m)
  volume: number;           // Estimated lake volume (m^3)
  annualNetInflowM3: number; // Positive annual P-E water available in the basin
  spillCellIndex: number;   // Spill point cell index
  outletCellIndex: number;  // Outflow receiver cell index
}

export interface TerrainData {
  elevation: Float32Array;           // Elevation in meters relative to sea level (0 m)
  bedrockElevation: Float32Array;    // Pre-sediment bedrock elevation (m)
  sedimentThickness: Float32Array;   // Sediment layer thickness (m)
  slope: Float32Array;               // Tangent slope magnitude (rise/run)
  rockHardness: Float32Array;        // Lithological erosion resistance factor (0.1 to 1.0)
}

export interface HydrologyData {
  flowReceivers: Int32Array;         // Acyclic receiver cell index (-1 for sinks/ocean)
  discharge: Float32Array;           // Annual river discharge volume in m^3/s
  strahlerOrder: Uint8Array;         // Strahler stream hierarchy order (1 to 6+)
  drainageBasin: Int32Array;         // Catchment watershed ID per cell
  lakes: LakeData[];                 // Explicit lake polygon features
  isLakeMask: Uint8Array;            // 1 if submerged beneath lake surface, 0 otherwise
}

export interface ClimateData {
  axialTiltDeg: number;              // Planetary obliquity in degrees (e.g. 23.44°)
  monthlyTemperature: Float32Array[];// 12 arrays (each totalCells length) in °C
  monthlyPrecipitation: Float32Array[]; // 12 arrays in mm/month
  meanAnnualTemperature: Float32Array; // Mean temperature in °C
  annualPrecipitation: Float32Array;   // Total annual precipitation in mm/yr
  annualEvaporation: Float32Array;     // Total annual evaporation in mm/yr
  temperatureSeasonality: Float32Array;// (T_max - T_min) in °C
  iceThickness: Float32Array;          // Glacial ice & perennial polar sea ice in meters (m)
  seaIceFraction: Float32Array;        // 0.0 (open water) to 1.0 (pack ice / ice shelf)
}

export interface EcologyData {
  biomes: Uint8Array;                // Biome ID enum per cell (0 to 19)
}

export interface StageTiming {
  stage: string;
  durationMs: number;
}

export interface SimulationDiagnostics {
  totalExecutionTimeMs: number;
  stageTimings: StageTiming[];
  peakMemoryMB: number;
  continentalFraction: number;       // Fraction of planetary surface above sea level
  meanElevationM: number;
  maxElevationM: number;
  minElevationM: number;
  oceanVolumeM3: number;
  totalRiverDischargeM3s: number;
  lakeCount: number;
  meanAnnualTempC: number;
  meanAnnualPrecipMm: number;
  perennialIceAreaKm2: number;
  sedimentInputM3: number;
  sedimentDepositedM3: number;
  sedimentExportedM3: number;
  sedimentResidualM3: number;
  coastalErodedSedimentM3: number;
  marineDepositedSedimentM3: number;
  /** Pipeline-internal tectonic state is summarized here without changing the V2 array payload. */
  tectonicSubsteps?: number;
  tectonicTimeStepMyr?: number;
  initialCrustVolumeM3?: number;
  finalCrustVolumeM3?: number;
  magmaticAdditionM3?: number;
  subductedCrustM3?: number;
  crustVolumeResidualM3?: number;
  activeOrogenCount?: number;
  paleoOrogenCount?: number;
  tectonicTargetTimeStepMyr?: number;
  tectonicMinimumTimeStepMyr?: number;
  tectonicMaximumTimeStepMyr?: number;
  tectonicMinCellDistanceM?: number;
  tectonicMaxPlateSpeedMPerMyr?: number;
  initialContinentalVolumeM3?: number;
  finalContinentalVolumeM3?: number;
  continentalTransportedVolumeM3?: number;
  continentalRoutedVolumeM3?: number;
  continentalSourceVolumeM3?: number;
  continentalSinkVolumeM3?: number;
  continentalLimitedVolumeM3?: number;
  continentalCorrectionVolumeM3?: number;
  tectonicRawMinContinentalVolumeM3?: number;
  continentalVolumeResidualM3?: number;
  continentalVolumeRelativeError?: number;
  tectonicConservation?: TectonicConservationLedger;
}

export interface WorldV2 {
  version: 2;
  seed: number;
  config: SimulationConfig;
  radiusMeters: number;              // Standard Earth radius = 6,371,000 m
  seaLevelMeters: number;            // 0 m datum
  topology: TopologyData;
  geology: GeologyData;
  terrain: TerrainData;
  hydrology: HydrologyData;
  climate: ClimateData;
  ecology: EcologyData;
  diagnostics: SimulationDiagnostics;
  timeline?: TectonicSimulationTimeline;
}

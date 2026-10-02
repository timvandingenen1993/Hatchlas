import type { Vec3 } from '../../geometry/coordinates';
import type { CubedSphereGrid } from '../../geometry/cubedSphere';

// Kinematic boundary classification (Stage 1: purely kinematic, before crust types exist)
export const KINEMATIC_BOUNDARY_NONE = 0;
export const KINEMATIC_BOUNDARY_CONVERGENT = 1;
export const KINEMATIC_BOUNDARY_DIVERGENT = 2;
export const KINEMATIC_BOUNDARY_TRANSFORM = 3;

// Geological boundary classification (Stage 2+: after crust lithology is coupled)
export const GEOLOGICAL_BOUNDARY_NONE = 0;
export const GEOLOGICAL_BOUNDARY_SUBDUCTION = 1;
export const GEOLOGICAL_BOUNDARY_COLLISION = 2;
export const GEOLOGICAL_BOUNDARY_RIDGE = 3;
export const GEOLOGICAL_BOUNDARY_RIFT = 4;
export const GEOLOGICAL_BOUNDARY_TRANSFORM = 5;

// Crust lithology types
export const CRUST_OCEANIC = 0;
export const CRUST_CONTINENTAL = 1;
export const CRUST_ARC = 2;

export interface PlateEngineConfig {
  seed: number;
  resolution: number;
  radiusMeters: number;
  plateCount: number;
  continentalFraction?: number;
  durationMyr?: number;
  timeStepMyr?: number;
  activeVelocityThresholdMmYr?: number;
  /** Reference thickness of the procedural Phase 2 continental reservoir. */
  continentalThicknessM?: number;
}

export interface RigidEulerPlate {
  id: number;
  name: string;
  seedPosition: Vec3;
  weight: number;
  eulerPole: Vec3; // Unit vector on S^2
  angularVelocityRadPerMyr: number; // Signed radians per Myr
  color: string;
}

export interface DualBoundaryEdge {
  cellA: number;
  cellB: number;
  plateA: number;
  plateB: number;
  midpoint: Vec3;
  normal: Vec3;   // Tangent unit vector pointing from A toward B
  tangent: Vec3;  // Tangent unit vector orthogonal to normal on sphere surface
  lengthM: number;
  normalVelocityMmYr: number; // v_B - v_A projected on normal: < 0 is convergent, > 0 is divergent
  shearVelocityMmYr: number;  // Magnitude of strike-slip speed
  signedShearVelocityMmYr: number; // Signed shear (+ for right-lateral, - for left-lateral)
  kinematicType: number;      // KINEMATIC_BOUNDARY_*
  geologicalType?: number;    // GEOLOGICAL_BOUNDARY_* (Stage 2+)
  subductingPlateId?: number; // Plate id of subducting plate (Stage 2+)
  overridingPlateId?: number; // Plate id of overriding plate (Stage 2+)
}


export interface KinematicBoundaryField {
  edges: DualBoundaryEdge[];
  edgeCount: number;
  cellBoundaryType: Uint8Array;
  cellNormalVelocityMmYr: Float32Array;
  cellShearVelocityMmYr: Float32Array;
}

export interface PlateStateReservoirs {
  plateCount: number;
  totalCells: number;
  /**
   * Ownership fraction per cell per plate.
   * Invariant: sum over plates = 1.0 for each cell.
   * Layout: [cell * plateCount + plateIndex]
   */
  plateAreaFraction: Float32Array | Float64Array;
  /**
   * Continental crust volume in m^3.
   * May be zero-length while the Phase 1 material system is dormant.
   * Layout: [cell * plateCount + plateIndex]
   */
  continentalVolumeM3: Float64Array;
  /**
   * Oceanic crust volume in m^3.
   * May be zero-length while the Phase 1 material system is dormant.
   * Layout: [cell * plateCount + plateIndex]
   */
  oceanicVolumeM3: Float64Array;
  /**
   * Oceanic age moment in m^3 * Myr.
   * oceanicAgeMyr = oceanicAgeMomentM3Myr / oceanicVolumeM3
   * Layout: [cell * plateCount + plateIndex]
   */
  oceanicAgeMomentM3Myr: Float64Array;
  /**
   * Inherited oceanic crust volume in m^3 for diagnostic tracking.
   * Layout: [cell * plateCount + plateIndex]
   */
  inheritedOceanicVolumeM3: Float64Array;
}

export interface TectonicConservationLedger {
  timeMyr: number;
  stepIndex: number;
  dtMyr: number;
  totalSubsteps: number;
  // Surface Area ledger (Milestone 1B)
  totalSurfaceAreaM2: number;
  openingAreaM2: number;
  convergenceAreaM2: number;
  ridgeAccretionAreaM2?: number;
  trenchConsumptionAreaM2?: number;
  ownershipOpeningAreaM2?: number;
  ownershipConvergenceAreaM2?: number;
  openingByPlateM2?: number[];
  convergenceByPlateM2?: number[];
  plateAreaChangeM2?: number[];
  topologyCorrectionAreaM2?: number;
  topologyFragmentsRemoved?: number;
  topologyPlatesReseeded?: number;
  netAreaResidualM2: number;
  maxPartitionResidual: number;
  rawMinOwnership?: number;
  rawMaxClosureResidual?: number;
  maxClosureCorrection?: number;
  totalClosureCorrection?: number;
  // Continental mass/volume (Stage 2)

  initialContinentalVolumeM3: number;
  continentalTransportedVolumeM3: number;
  continentalRoutedVolumeM3: number;
  continentalTopologyRoutedVolumeM3: number;
  continentalSourceVolumeM3: number;
  continentalSinkVolumeM3: number;
  continentalLimitedVolumeM3: number;
  continentalCorrectionVolumeM3: number;
  rawMinContinentalVolumeM3: number;
  finalContinentalVolumeM3: number;
  continentalVolumeResidualM3: number;
  continentalVolumeRelativeError: number;
  continentalSteps: ContinentalStepLedger[];
  // Oceanic mass/volume (Stage 3)
  initialOceanicVolumeM3: number;
  createdOceanicVolumeM3: number;
  subductedOceanicVolumeM3: number;
  finalOceanicVolumeM3: number;
  oceanicVolumeResidualM3: number;
  inheritedCrustFraction: number;
  // Kinematic & CFL metrics
  maxPlateSpeedMPerMyr: number;
  maxDisplacementKm: number;
  minCellDistanceM: number;
  cflDisplacementRatio: number;
  targetTimeStepMyr: number;
  minimumActualTimeStepMyr: number;
  maximumActualTimeStepMyr: number;
  integratedDurationMyr: number;
}

export interface ContinentalStepLedger {
  stepIndex: number;
  startTimeMyr: number;
  durationMyr: number;
  initialVolumeM3: number;
  boundaryFluxM3: number;
  explicitSourceM3: number;
  explicitSinkM3: number;
  transportedVolumeM3: number;
  routedVolumeM3: number;
  topologyRoutedVolumeM3: number;
  limitedVolumeM3: number;
  correctedVolumeM3: number;
  finalVolumeM3: number;
  residualM3: number;
}


export interface TectonicTimeSnapshot {
  timeMyr: number;
  stepIndex: number;
  // Compact per-cell fields (TypedArrays for zero-copy high performance)
  dominantPlateId: Uint8Array;           // [totalCells], config caps plate ids below 32
  boundaryClass: Uint8Array;            // [totalCells] 0=None, 1=Convergent, 2=Divergent, 3=Transform
  normalVelocityMmYr: Float32Array;     // [totalCells]
  /** Omitted from compact timeline snapshots; reconstructed only when needed. */
  shearVelocityMmYr?: Float32Array;     // [totalCells]
  closureResidual: Float32Array;        // [totalCells] per-cell: sum(fractions) - 1.0
  dominanceConfidence: Float32Array;    // [totalCells] per-cell: max(fractions)
  // Material fields (will expand in Stage 2 & 3)

  continentalFraction?: Float32Array;   // [totalCells]
  continentalThicknessM?: Float32Array; // [totalCells], aggregate volume / physical cell area
  continentalVolumeM3?: number;
  continentalTransportedVolumeM3?: number;
  continentalRoutedVolumeM3?: number;
  continentalLimitedVolumeM3?: number;
  continentalCorrectionVolumeM3?: number;
  continentalResidualM3?: number;
  oceanicAgeMyr?: Float32Array;         // [totalCells]
  // Diagnostics
  plateAreaPercentages: number[];       // [plateCount] area % per plate
  partitionOfUnityMaxResidual: number;  // max |sum_p f_p - 1.0| across all cells
  rawMinOwnership?: number;             // min raw fraction before any clamp/repair
  rawMaxClosureResidual?: number;       // max raw residual before any clamp/repair
  maxClosureCorrection?: number;        // legacy field; zero for conservative flux-form update
  topologyCorrectionAreaM2?: number;    // explicit raster topology projection area
  topologyFragmentsRemoved?: number;
  topologyPlatesReseeded?: number;
  maxPlateVelocityMmYr: number;

  boundaryEdgeCount: number;
}

export interface TectonicSimulationTimeline {
  durationMyr: number;
  snapshotIntervalMyr: number;
  snapshots: TectonicTimeSnapshot[];
  plates: RigidEulerPlate[];
}

export interface TectonicSimulationResult {
  grid: CubedSphereGrid;
  config: PlateEngineConfig;
  plates: RigidEulerPlate[];
  reservoirs: PlateStateReservoirs;
  boundaries: KinematicBoundaryField;
  ledger: TectonicConservationLedger;
  timeline?: TectonicSimulationTimeline;
}

/**
 * Crust-type and plate-boundary constants plus the plate-core state types.
 */
import type { Vec3 } from '../../geometry/coordinates';
import type { CubedSphereGrid } from '../../geometry/cubedSphere';

export const CRUST_OCEANIC = 0;
export const CRUST_CONTINENTAL = 1;
export const CRUST_ARC = 2;

export const BOUNDARY_NONE = 0;
export const BOUNDARY_SUBDUCTION = 1;
export const BOUNDARY_COLLISION = 2;
export const BOUNDARY_RIDGE = 3;
export const BOUNDARY_RIFT = 4;
export const BOUNDARY_TRANSFORM = 5;

export interface PlateCoreConfig {
  seed: number;
  resolution: number;
  radiusMeters: number;
  plateCount: number;
  continentalFraction: number;
  durationMyr: number;
  waterVolumeM3: number;
}

export interface RigidPlate {
  id: number;
  seedPosition: Vec3;
  eulerPole: Vec3;
  angularVelocityRadPerMyr: number;
}

export interface PlateBoundaryEdge {
  cellA: number;
  cellB: number;
  plateA: number;
  plateB: number;
  kind: number;
  normalVelocityMmYr: number;
  shearVelocityMmYr: number;
  subductingPlateId: number;
  overridingPlateId: number;
  lengthM: number;
}

export interface BoundaryField {
  edges: PlateBoundaryEdge[];
  boundaryType: Uint8Array;
  normalVelocityMmYr: Float32Array;
  shearVelocityMmYr: Float32Array;
}

export interface CrustState {
  plateId: Uint16Array;
  crustType: Uint8Array;
  continentalThicknessM: Float32Array;
  oceanicThicknessM: Float32Array;
  arcThicknessM: Float32Array;
  oceanicAgeMyr: Float32Array;
}

export interface TectonicMassLedger {
  initialContinentalM3: number;
  finalContinentalM3: number;
  collisionRedistributedM3: number;
  subductedOceanicM3: number;
  mantleArcAddedM3: number;
  finalOceanicM3: number;
  finalArcM3: number;
  continentalRelativeError: number;
}

export interface PlateTectonicWorld {
  grid: CubedSphereGrid;
  config: PlateCoreConfig;
  plates: RigidPlate[];
  crust: CrustState;
  boundaries: BoundaryField;
  elevationM: Float32Array;
  rawElevationM: Float32Array;
  seaLevelM: number;
  ledger: TectonicMassLedger;
}

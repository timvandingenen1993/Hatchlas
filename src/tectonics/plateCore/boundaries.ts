/**
 * Plate velocity from Euler poles and classification of boundaries (subduction, collision, ridge, rift).
 */
import { normalize3, type Vec3 } from '../../geometry/coordinates';
import type { CubedSphereGrid } from '../../geometry/cubedSphere';
import {
  BOUNDARY_COLLISION,
  BOUNDARY_RIDGE,
  BOUNDARY_RIFT,
  BOUNDARY_SUBDUCTION,
  BOUNDARY_TRANSFORM,
  CRUST_CONTINENTAL,
  type BoundaryField,
  type CrustState,
  type PlateBoundaryEdge,
  type RigidPlate,
} from './types';

export function plateVelocityMPerMyr(plate: RigidPlate | undefined, position: Vec3, radiusM: number): Vec3 {
  if (!plate || !plate.eulerPole) return [0, 0, 0];
  const pole = plate.eulerPole;
  const scale = (plate.angularVelocityRadPerMyr ?? 0) * radiusM;
  return [
    (pole[1] * position[2] - pole[2] * position[1]) * scale,
    (pole[2] * position[0] - pole[0] * position[2]) * scale,
    (pole[0] * position[1] - pole[1] * position[0]) * scale,
  ];
}

function isContinental(crust: CrustState, cell: number): boolean {
  return crust.crustType[cell] === CRUST_CONTINENTAL || crust.continentalThicknessM[cell] >= 20_000;
}

function polarity(
  cellA: number,
  cellB: number,
  plateA: number,
  plateB: number,
  crust: CrustState,
): { subductingPlateId: number; overridingPlateId: number } {
  const continentalA = isContinental(crust, cellA);
  const continentalB = isContinental(crust, cellB);
  if (continentalA !== continentalB) {
    return continentalA
      ? { subductingPlateId: plateB, overridingPlateId: plateA }
      : { subductingPlateId: plateA, overridingPlateId: plateB };
  }

  const ageA = crust.oceanicAgeMyr[cellA];
  const ageB = crust.oceanicAgeMyr[cellB];
  const aSubducts = ageA === ageB ? plateA < plateB : ageA > ageB;
  return aSubducts
    ? { subductingPlateId: plateA, overridingPlateId: plateB }
    : { subductingPlateId: plateB, overridingPlateId: plateA };
}

/**
 * Builds one record per physical interface. Relative normal velocity is
 * negative for convergence and positive for divergence.
 */
export function classifyPlateBoundariesCore(
  grid: CubedSphereGrid,
  plates: RigidPlate[],
  crust: CrustState,
  activeThresholdMmYr = 2,
): BoundaryField {
  const boundaryType = new Uint8Array(grid.totalCells);
  const normalVelocityMmYr = new Float32Array(grid.totalCells);
  const shearVelocityMmYr = new Float32Array(grid.totalCells);
  const strongest = new Float32Array(grid.totalCells);
  const edges: PlateBoundaryEdge[] = [];

  for (let cellA = 0; cellA < grid.totalCells; cellA++) {
    for (let direction = 0; direction < 4; direction++) {
      const cellB = grid.neighbors[cellA * 4 + direction];
      if (cellB <= cellA) continue;
      const plateA = crust.plateId[cellA];
      const plateB = crust.plateId[cellB];
      if (plateA === plateB) continue;

      const pa: Vec3 = [
        grid.cellPositions[cellA * 3],
        grid.cellPositions[cellA * 3 + 1],
        grid.cellPositions[cellA * 3 + 2],
      ];
      const pb: Vec3 = [
        grid.cellPositions[cellB * 3],
        grid.cellPositions[cellB * 3 + 1],
        grid.cellPositions[cellB * 3 + 2],
      ];
      const midpoint = normalize3([pa[0] + pb[0], pa[1] + pb[1], pa[2] + pb[2]]);
      const dot = pa[0] * pb[0] + pa[1] * pb[1] + pa[2] * pb[2];
      const tx = pb[0] - dot * pa[0];
      const ty = pb[1] - dot * pa[1];
      const tz = pb[2] - dot * pa[2];
      const tLen = Math.hypot(tx, ty, tz) || 1.0;
      const normal: Vec3 = [tx / tLen, ty / tLen, tz / tLen];
      const pA = plates[plateA] ?? plates[0];
      const pB = plates[plateB] ?? plates[0];
      if (!pA || !pB) continue;

      const velocityA = plateVelocityMPerMyr(pA, midpoint, grid.radiusMeters);
      const velocityB = plateVelocityMPerMyr(pB, midpoint, grid.radiusMeters);
      const dv: Vec3 = [
        velocityB[0] - velocityA[0],
        velocityB[1] - velocityA[1],
        velocityB[2] - velocityA[2],
      ];
      const normalMPerMyr = dv[0] * normal[0] + dv[1] * normal[1] + dv[2] * normal[2];
      const normalMmYr = normalMPerMyr * 1e-3;
      const sx = midpoint[1] * normal[2] - midpoint[2] * normal[1];
      const sy = midpoint[2] * normal[0] - midpoint[0] * normal[2];
      const sz = midpoint[0] * normal[1] - midpoint[1] * normal[0];
      const shearMmYr = Math.abs(dv[0] * sx + dv[1] * sy + dv[2] * sz) * 1e-3;

      const continentalA = isContinental(crust, cellA);
      const continentalB = isContinental(crust, cellB);
      let kind: number;
      if (normalMmYr < -activeThresholdMmYr) {
        kind = continentalA && continentalB ? BOUNDARY_COLLISION : BOUNDARY_SUBDUCTION;
      } else if (normalMmYr > activeThresholdMmYr) {
        kind = continentalA && continentalB ? BOUNDARY_RIFT : BOUNDARY_RIDGE;
      } else {
        kind = BOUNDARY_TRANSFORM;
      }

      const resolved = kind === BOUNDARY_SUBDUCTION
        ? polarity(cellA, cellB, plateA, plateB, crust)
        : { subductingPlateId: -1, overridingPlateId: -1 };
      const edge: PlateBoundaryEdge = {
        cellA,
        cellB,
        plateA,
        plateB,
        kind,
        normalVelocityMmYr: normalMmYr,
        shearVelocityMmYr: shearMmYr,
        subductingPlateId: resolved.subductingPlateId,
        overridingPlateId: resolved.overridingPlateId,
        lengthM: Math.sqrt(0.5 * (grid.cellAreas[cellA] + grid.cellAreas[cellB])),
      };
      edges.push(edge);

      for (const cell of [cellA, cellB]) {
        const magnitude = Math.max(Math.abs(normalMmYr), shearMmYr);
        if (magnitude > strongest[cell]) {
          strongest[cell] = magnitude;
          boundaryType[cell] = kind;
          normalVelocityMmYr[cell] = normalMmYr;
          shearVelocityMmYr[cell] = shearMmYr;
        }
      }
    }
  }

  return { edges, boundaryType, normalVelocityMmYr, shearVelocityMmYr };
}

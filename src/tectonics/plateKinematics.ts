/**
 * Plate boundary types and relative-motion kinematics along boundary edges.
 */
import { cross3, length3, normalize3, type Vec3 } from '../geometry/coordinates';
import type { CubedSphereGrid } from '../geometry/cubedSphere';
import type { TectonicPlateData } from '../types/worldV2';

export const BOUNDARY_NONE = 0;
export const BOUNDARY_SUBDUCTION = 1;
export const BOUNDARY_COLLISION = 2;
export const BOUNDARY_RIDGE = 3;
export const BOUNDARY_RIFT = 4;
export const BOUNDARY_TRANSFORM = 5;

/** A physical plate edge stored once, even though it borders two grid cells. */
export interface TectonicBoundaryEdge {
  cellA: number;
  cellB: number;
  plateA: number;
  plateB: number;
  type: number;
  normalVelocityMmYr: number;
  shearVelocityMmYr: number;
  subductingPlateId: number;
  overridingPlateId: number;
}

export interface BoundaryKinematicsResult {
  boundaryType: Uint8Array;
  normalVelocity: Float32Array;
  shearVelocity: Float32Array;
  edges: TectonicBoundaryEdge[];
}

function cellVelocity(grid: CubedSphereGrid, plates: TectonicPlateData[], plateIds: Uint8Array): Float32Array {
  const velocity = new Float32Array(grid.totalCells * 3);
  for (let idx = 0; idx < grid.totalCells; idx++) {
    const plate = plates[plateIds[idx]];
    const p: Vec3 = [
      grid.cellPositions[idx * 3],
      grid.cellPositions[idx * 3 + 1],
      grid.cellPositions[idx * 3 + 2],
    ];
    const tangent = cross3(plate.eulerPole, p);
    const scale = plate.angularVelocity * grid.radiusMeters * 1e-3;
    velocity[idx * 3] = tangent[0] * scale;
    velocity[idx * 3 + 1] = tangent[1] * scale;
    velocity[idx * 3 + 2] = tangent[2] * scale;
  }
  return velocity;
}

/** Resolve the descending and overriding plates for a subduction edge. */
export function resolveSubductionPolarity(
  edge: Pick<TectonicBoundaryEdge, 'cellA' | 'cellB' | 'plateA' | 'plateB'>,
  crustType: Uint8Array,
  crustAge?: Float32Array,
): { subductingPlateId: number; overridingPlateId: number } {
  const contA = crustType[edge.cellA] === 1;
  const contB = crustType[edge.cellB] === 1;
  if (contA !== contB) {
    return contA
      ? { subductingPlateId: edge.plateB, overridingPlateId: edge.plateA }
      : { subductingPlateId: edge.plateA, overridingPlateId: edge.plateB };
  }

  const ageA = crustAge?.[edge.cellA] ?? 0;
  const ageB = crustAge?.[edge.cellB] ?? 0;
  const aSubducts = ageA === ageB ? edge.plateA < edge.plateB : ageA > ageB;
  return aSubducts
    ? { subductingPlateId: edge.plateA, overridingPlateId: edge.plateB }
    : { subductingPlateId: edge.plateB, overridingPlateId: edge.plateA };
}

/**
 * Spherical plate kinematics and unique-edge boundary classification.
 * Relative normal velocity is negative for convergence and positive for
 * divergence, in mm/yr.
 */
export function classifyPlateBoundaries(
  grid: CubedSphereGrid,
  plates: TectonicPlateData[],
  plateIds: Uint8Array,
  crustType: Uint8Array,
  crustAge?: Float32Array,
): BoundaryKinematicsResult {
  const boundaryType = new Uint8Array(grid.totalCells);
  const normalVelocity = new Float32Array(grid.totalCells);
  const shearVelocity = new Float32Array(grid.totalCells);
  const strongestNormal = new Float32Array(grid.totalCells);
  const velocity = cellVelocity(grid, plates, plateIds);
  const edges: TectonicBoundaryEdge[] = [];

  for (let cellA = 0; cellA < grid.totalCells; cellA++) {
    for (let k = 0; k < 4; k++) {
      const cellB = grid.neighbors[cellA * 4 + k];
      if (cellB <= cellA || plateIds[cellA] === plateIds[cellB]) continue;

      const plateA = plateIds[cellA];
      const plateB = plateIds[cellB];
      const pA: Vec3 = [
        grid.cellPositions[cellA * 3],
        grid.cellPositions[cellA * 3 + 1],
        grid.cellPositions[cellA * 3 + 2],
      ];
      const pB: Vec3 = [
        grid.cellPositions[cellB * 3],
        grid.cellPositions[cellB * 3 + 1],
        grid.cellPositions[cellB * 3 + 2],
      ];
      const normal = normalize3([pA[0] - pB[0], pA[1] - pB[1], pA[2] - pB[2]]);
      const dv: Vec3 = [
        velocity[cellA * 3] - velocity[cellB * 3],
        velocity[cellA * 3 + 1] - velocity[cellB * 3 + 1],
        velocity[cellA * 3 + 2] - velocity[cellB * 3 + 2],
      ];
      const vn = dv[0] * normal[0] + dv[1] * normal[1] + dv[2] * normal[2];
      const shear: Vec3 = [dv[0] - vn * normal[0], dv[1] - vn * normal[1], dv[2] - vn * normal[2]];
      const vs = length3(shear);

      const contA = crustType[cellA] === 1;
      const contB = crustType[cellB] === 1;
      let type: number;
      if (vn < -3) type = contA && contB ? BOUNDARY_COLLISION : BOUNDARY_SUBDUCTION;
      else if (vn > 3) type = contA && contB ? BOUNDARY_RIFT : BOUNDARY_RIDGE;
      else type = BOUNDARY_TRANSFORM;

      const edge: TectonicBoundaryEdge = {
        cellA,
        cellB,
        plateA,
        plateB,
        type,
        normalVelocityMmYr: vn,
        shearVelocityMmYr: vs,
        subductingPlateId: -1,
        overridingPlateId: -1,
      };
      if (type === BOUNDARY_SUBDUCTION) {
        Object.assign(edge, resolveSubductionPolarity(edge, crustType, crustAge));
      }
      edges.push(edge);

      for (const idx of [cellA, cellB]) {
        if (Math.abs(vn) >= strongestNormal[idx]) {
          strongestNormal[idx] = Math.abs(vn);
          boundaryType[idx] = type;
          normalVelocity[idx] = vn;
          shearVelocity[idx] = vs;
        }
      }
    }
  }

  return { boundaryType, normalVelocity, shearVelocity, edges };
}

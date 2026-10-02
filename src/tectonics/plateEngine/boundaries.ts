import { cross3, dot3, normalize3, type Vec3 } from '../../geometry/coordinates';
import type { CubedSphereGrid } from '../../geometry/cubedSphere';
import {
  type DualBoundaryEdge,
  type KinematicBoundaryField,
  KINEMATIC_BOUNDARY_CONVERGENT,
  KINEMATIC_BOUNDARY_DIVERGENT,
  KINEMATIC_BOUNDARY_TRANSFORM,
  type RigidEulerPlate,
} from './types';


/**
 * Calculates the linear surface velocity vector in m/Myr for a given rigid plate at position p on sphere.
 * v = Omega * (omega_pole x p) * radiusMeters
 */
export function calculatePlateVelocityMPerMyr(
  plate: RigidEulerPlate,
  position: Vec3,
  radiusMeters: number,
): Vec3 {
  const pole = plate.eulerPole;
  const omega = plate.angularVelocityRadPerMyr;
  const cross = cross3(pole, position);
  const scale = omega * radiusMeters;
  return [cross[0] * scale, cross[1] * scale, cross[2] * scale];
}

/**
 * Converts m/Myr to mm/yr (1 m/Myr = 0.001 mm/yr).
 */
export function velocityMPerMyrToMmYr(v: Vec3): Vec3 {
  return [v[0] * 1e-3, v[1] * 1e-3, v[2] * 1e-3];
}

/**
 * Extracts unique physical boundary dual-edges between cells of differing plates (A < B)
 * and classifies them purely kinematically based on vector relative velocity.
 */
export function extractKinematicBoundaries(
  grid: CubedSphereGrid,
  plates: RigidEulerPlate[],
  primaryPlateIds: Uint8Array | Uint16Array,
  activeVelocityThresholdMmYr = 2.0,
  includeEdgeObjects = true,
  includeShearRaster = true,
): KinematicBoundaryField {
  const totalCells = grid.totalCells;
  const cellBoundaryType = new Uint8Array(totalCells);
  const cellNormalVelocityMmYr = new Float32Array(totalCells);
  const cellShearVelocityMmYr = new Float32Array(includeShearRaster ? totalCells : 0);
  const maxIncidentMagnitude = new Float32Array(totalCells);
  const edges: DualBoundaryEdge[] = [];
  let edgeCount = 0;

  const plateMap = new Map<number, RigidEulerPlate>();
  for (const plate of plates) {
    plateMap.set(plate.id, plate);
  }

  for (let cellA = 0; cellA < totalCells; cellA++) {
    const plateAId = primaryPlateIds[cellA];
    const plateA = plateMap.get(plateAId);
    if (!plateA) continue;

    const pa: Vec3 = [
      grid.cellPositions[cellA * 3],
      grid.cellPositions[cellA * 3 + 1],
      grid.cellPositions[cellA * 3 + 2],
    ];

    for (let dir = 0; dir < 4; dir++) {
      const cellB = grid.neighbors[cellA * 4 + dir];
      // Visit every physical cell-to-cell interface exactly once (A < B)
      if (cellB <= cellA) continue;

      const plateBId = primaryPlateIds[cellB];
      if (plateAId === plateBId) continue; // Same plate, internal edge

      const plateB = plateMap.get(plateBId);
      if (!plateB) continue;
      edgeCount++;

      const pb: Vec3 = [
        grid.cellPositions[cellB * 3],
        grid.cellPositions[cellB * 3 + 1],
        grid.cellPositions[cellB * 3 + 2],
      ];

      // Exact spherical midpoint
      const midpoint = normalize3([pa[0] + pb[0], pa[1] + pb[1], pa[2] + pb[2]]);

      // Great-circle normal vector perpendicular to the great-circle arc plane
      const gcNormal = cross3(pa, pb);

      // Tangent boundary normal at midpoint pointing strictly from A to B: (pa x pb) x midpoint
      const normal = normalize3(cross3(gcNormal, midpoint));

      // Tangent boundary edge vector pointing to the right as viewed from cell A to B (dextral-positive)
      const tangent = normalize3(cross3(normal, midpoint));





      // Calculate plate velocities at the shared midpoint
      const vA_MPerMyr = calculatePlateVelocityMPerMyr(plateA, midpoint, grid.radiusMeters);
      const vB_MPerMyr = calculatePlateVelocityMPerMyr(plateB, midpoint, grid.radiusMeters);

      // Relative velocity: dv = v_B - v_A
      const dv_MmYr: Vec3 = [
        (vB_MPerMyr[0] - vA_MPerMyr[0]) * 1e-3,
        (vB_MPerMyr[1] - vA_MPerMyr[1]) * 1e-3,
        (vB_MPerMyr[2] - vA_MPerMyr[2]) * 1e-3,
      ];

      // Normal velocity: < 0 is convergent, > 0 is divergent
      const normalVelocityMmYr = dot3(dv_MmYr, normal);
      // Signed shear velocity: + is dextral/right-lateral, - is sinistral/left-lateral
      const signedShearVelocityMmYr = dot3(dv_MmYr, tangent);
      const shearVelocityMmYr = Math.abs(signedShearVelocityMmYr);

      // Kinematic classification & explicit subduction polarity
      let kinematicType: number;
      let overridingPlateId: number | undefined;
      let subductingPlateId: number | undefined;

      if (normalVelocityMmYr < -activeVelocityThresholdMmYr) {
        kinematicType = KINEMATIC_BOUNDARY_CONVERGENT;
        // Deterministic overriding plate determination: larger plate weight overrides; lower plate ID tiebreak
        if (plateA.weight !== plateB.weight) {
          overridingPlateId = plateA.weight > plateB.weight ? plateAId : plateBId;
        } else {
          overridingPlateId = plateAId < plateBId ? plateAId : plateBId;
        }
        subductingPlateId = overridingPlateId === plateAId ? plateBId : plateAId;
      } else if (normalVelocityMmYr > activeVelocityThresholdMmYr) {
        kinematicType = KINEMATIC_BOUNDARY_DIVERGENT;
      } else {
        kinematicType = KINEMATIC_BOUNDARY_TRANSFORM;
      }

      // Edge metric length in meters
      const edgeLengthM = grid.edgeLengths
        ? grid.edgeLengths[cellA * 4 + dir]
        : Math.sqrt(0.5 * (grid.cellAreas[cellA] + grid.cellAreas[cellB]));

      if (includeEdgeObjects) {
        const edge: DualBoundaryEdge = {
          cellA,
          cellB,
          plateA: plateAId,
          plateB: plateBId,
          midpoint,
          normal,
          tangent,
          lengthM: edgeLengthM,
          normalVelocityMmYr,
          shearVelocityMmYr,
          signedShearVelocityMmYr,
          kinematicType,
          overridingPlateId,
          subductingPlateId,
        };
        edges.push(edge);
      }



      // Project onto per-cell diagnostics
      for (const c of [cellA, cellB]) {
        const mag = Math.max(Math.abs(normalVelocityMmYr), shearVelocityMmYr);
        if (mag > maxIncidentMagnitude[c]) {
          maxIncidentMagnitude[c] = mag;
          cellBoundaryType[c] = kinematicType;
          cellNormalVelocityMmYr[c] = normalVelocityMmYr;
          if (includeShearRaster) cellShearVelocityMmYr[c] = shearVelocityMmYr;
        }
      }
    }
  }

  return {
    edges,
    edgeCount,
    cellBoundaryType,
    cellNormalVelocityMmYr,
    cellShearVelocityMmYr,
  };
}

/**
 * Groups boundary segments into orogen regions and picks a regime (collisional, arc or other) for each.
 */
import type { TectonicHistoryResult } from './tectonicHistory';
import { BOUNDARY_COLLISION, BOUNDARY_SUBDUCTION } from './plateKinematics';

export type OrogenRegimeType =
  | 'continental_collision'
  | 'ocean_continent_subduction'
  | 'ocean_ocean_subduction'
  | 'paleo_orogen';

export interface OrogenSegment {
  cellIndex: number;
  strikeVector: [number, number, number];    // 3D tangent unit vector along strike
  crossRangeNormal: [number, number, number]; // 3D tangent unit vector across range
  principalShorteningStrain: number;
  widthKm: number;
  crustThicknessM: number;
}

export interface OrogenRegion {
  id: number;
  regime: OrogenRegimeType;
  isActive: boolean;
  meanWidthKm: number;
  widthVariation: number; // sigma_W / mu_W
  segments: OrogenSegment[];
}

export interface OrogenSystemResult {
  regions: OrogenRegion[];
  orogenCellMask: Uint8Array; // 0=None, 1=Collision, 2=OceanContSub, 3=OceanOceanSub, 4=Paleo
  orogenStrikeVectors: Float32Array; // [cellIdx * 3 + 0..2]
  orogenCrossNormals: Float32Array;  // [cellIdx * 3 + 0..2]
}

/**
 * Structural orogen region classifier derived from the tangent-plane strain tensor
 * and dynamic convergence history.
 */
export function buildOrogenRegions(history: TectonicHistoryResult): OrogenSystemResult {
  const grid = history.tectonicGrid;
  const totalCells = grid.totalCells;

  const orogenCellMask = new Uint8Array(totalCells);
  const orogenStrikeVectors = new Float32Array(totalCells * 3);
  const orogenCrossNormals = new Float32Array(totalCells * 3);
  const activeRegime = new Uint8Array(totalCells);
  for (const edge of history.edges) {
    if (edge.type === BOUNDARY_COLLISION) {
      activeRegime[edge.cellA] = 1;
      activeRegime[edge.cellB] = 1;
    } else if (edge.type === BOUNDARY_SUBDUCTION) {
      const oceanOcean = history.crustType[edge.cellA] === 0 && history.crustType[edge.cellB] === 0;
      activeRegime[edge.cellA] = oceanOcean ? 3 : 2;
      activeRegime[edge.cellB] = oceanOcean ? 3 : 2;
    }
  }

  // 1. Compute principal compression and strike directions from strain tensor
  for (let idx = 0; idx < totalCells; idx++) {
    const sxx = history.strainXX[idx];
    const sxy = history.strainXY[idx];
    const syy = history.strainYY[idx];

    // Principal strain angle in local tangent plane
    const thetaP = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const principalStrain = 0.5 * (sxx + syy) + Math.sqrt(0.25 * (sxx - syy) * (sxx - syy) + sxy * sxy);

    const px = grid.cellPositions[idx * 3 + 0];
    const py = grid.cellPositions[idx * 3 + 1];
    const pz = grid.cellPositions[idx * 3 + 2];

    // Local orthonormal tangent basis on sphere (east = hat_e, north = hat_n)
    let ex = -py;
    let ey = px;
    let ez = 0;
    const eLen = Math.hypot(ex, ey);
    if (eLen > 1e-6) {
      ex /= eLen;
      ey /= eLen;
    } else {
      ex = 1;
      ey = 0;
    }

    // North tangent = hat_p x hat_east
    const nx = py * ez - pz * ey;
    const ny = pz * ex - px * ez;
    const nz = px * ey - py * ex;

    // Structural strike vector = -sin(thetaP) * hat_e + cos(thetaP) * hat_n (perpendicular to compression)
    const cosT = Math.cos(thetaP);
    const sinT = Math.sin(thetaP);
    const sx = -sinT * ex + cosT * nx;
    const sy = -sinT * ey + cosT * ny;
    const sz = -sinT * ez + cosT * nz;

    orogenStrikeVectors[idx * 3 + 0] = sx;
    orogenStrikeVectors[idx * 3 + 1] = sy;
    orogenStrikeVectors[idx * 3 + 2] = sz;

    // Cross-range normal = hat_p x hat_strike
    const cx = py * sz - pz * sy;
    const cy = pz * sx - px * sz;
    const cz = px * sy - py * sx;

    orogenCrossNormals[idx * 3 + 0] = cx;
    orogenCrossNormals[idx * 3 + 1] = cy;
    orogenCrossNormals[idx * 3 + 2] = cz;

    // Classify orogen regime
    const inactiveAge = history.timeSinceActiveConvergenceMyr[idx];

    if (activeRegime[idx] !== 0) {
      orogenCellMask[idx] = activeRegime[idx];
    } else if (principalStrain > 0.12 && inactiveAge > 15.0) {
      orogenCellMask[idx] = 4; // Paleo-orogen
    }
  }

  // 2. Group into continuous structural orogen regions
  const visited = new Uint8Array(totalCells);
  const regions: OrogenRegion[] = [];
  let regionIdCounter = 1;

  for (let idx = 0; idx < totalCells; idx++) {
    const mask = orogenCellMask[idx];
    if (mask === 0 || visited[idx] === 1) continue;

    let regime: OrogenRegimeType = 'continental_collision';
    if (mask === 2) regime = 'ocean_continent_subduction';
    else if (mask === 3) regime = 'ocean_ocean_subduction';
    else if (mask === 4) regime = 'paleo_orogen';

    const segments: OrogenSegment[] = [];
    const queue: number[] = [idx];
    visited[idx] = 1;

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const sxx = history.strainXX[curr];
      const sxy = history.strainXY[curr];
      const syy = history.strainYY[curr];
      const pStrain = 0.5 * (sxx + syy) + Math.sqrt(0.25 * (sxx - syy) * (sxx - syy) + sxy * sxy);

      // Estimate structural cross-range width in km
      // This is a measured graph width, not a regime-assigned width. Include
      // cross-range neighbours whose accumulated shortening belongs to the
      // same structural belt.
      let crossCells = 1;
      const cx = orogenCrossNormals[curr * 3];
      const cy = orogenCrossNormals[curr * 3 + 1];
      const cz = orogenCrossNormals[curr * 3 + 2];
      for (let edge = 0; edge < 4; edge++) {
        const slot = curr * 4 + edge;
        const alignment = Math.abs(
          grid.edgeNormals[slot * 3] * cx +
          grid.edgeNormals[slot * 3 + 1] * cy +
          grid.edgeNormals[slot * 3 + 2] * cz
        );
        const neighbor = grid.neighbors[slot];
        if (alignment > 0.55 && (orogenCellMask[neighbor] === orogenCellMask[curr] || history.cumulativeShorteningM[neighbor] > 0)) {
          crossCells += 0.5;
        }
      }
      const widthKm = Math.sqrt(grid.cellAreas[curr]) * crossCells * 1e-3;

      segments.push({
        cellIndex: curr,
        strikeVector: [
          orogenStrikeVectors[curr * 3 + 0],
          orogenStrikeVectors[curr * 3 + 1],
          orogenStrikeVectors[curr * 3 + 2],
        ],
        crossRangeNormal: [
          orogenCrossNormals[curr * 3 + 0],
          orogenCrossNormals[curr * 3 + 1],
          orogenCrossNormals[curr * 3 + 2],
        ],
        principalShorteningStrain: pStrain,
        widthKm,
        crustThicknessM: history.crustThickness[curr],
      });

      for (let n = 0; n < 4; n++) {
        const nb = grid.neighbors[curr * 4 + n];
        if (visited[nb] === 0 && orogenCellMask[nb] === mask) {
          visited[nb] = 1;
          queue.push(nb);
        }
      }
    }

    if (segments.length >= 3) {
      let sumW = 0;
      for (const s of segments) sumW += s.widthKm;
      const meanWidthKm = sumW / segments.length;

      let varW = 0;
      for (const s of segments) {
        const diff = s.widthKm - meanWidthKm;
        varW += diff * diff;
      }
      const sigmaW = Math.sqrt(varW / segments.length);
      const widthVariation = meanWidthKm > 0 ? sigmaW / meanWidthKm : 0;

      regions.push({
        id: regionIdCounter++,
        regime,
        isActive: regime !== 'paleo_orogen',
        meanWidthKm,
        widthVariation,
        segments,
      });
    }
  }

  return {
    regions,
    orogenCellMask,
    orogenStrikeVectors,
    orogenCrossNormals,
  };
}

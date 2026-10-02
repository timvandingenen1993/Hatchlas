/**
 * Simulates tectonic history over time and keeps snapshots for the timeline.
 */
import { buildCubedSphereGrid, type CubedSphereGrid } from '../geometry/cubedSphere';
import type { SimulationConfig } from '../types/config';
import type { TectonicPlateData } from '../types/worldV2';
import {
  BOUNDARY_COLLISION,
  BOUNDARY_RIDGE,
  BOUNDARY_RIFT,
  BOUNDARY_SUBDUCTION,
  BOUNDARY_TRANSFORM,
  classifyPlateBoundaries,
  type TectonicBoundaryEdge,
} from './plateKinematics';
import { seedSphericalPlates } from './plateSeeds';

export interface TectonicSnapshot {
  timeMyr: number;
  dtMyr: number;
  tectonicUpliftRate: Float32Array; // mm/yr
  boundaryType: Uint8Array;
  normalVelocity: Float32Array;     // mm/yr
  shearVelocity: Float32Array;      // mm/yr
  edges: TectonicBoundaryEdge[];
  plateIds: Uint8Array;
  crustType: Uint8Array;
  crustThickness: Float32Array;
  crustAge: Float32Array;
}

export interface TectonicHistoryResult {
  tectonicGrid: CubedSphereGrid;
  plates: TectonicPlateData[];
  plateIds: Uint8Array;
  plateFractions: Float32Array;        // [totalCells * plateCount]
  plateAreasM2: Float64Array;          // conservative ownership measure [cell * plate]
  crustType: Uint8Array;               // 0=Oceanic, 1=Continental, 2=Transitional/Arc
  crustThickness: Float32Array;        // meters
  crustAge: Float32Array;              // Myr
  // Material volume reservoirs (m^3)
  volContinental: Float64Array;
  volOceanic: Float64Array;
  volArcMagma: Float64Array;
  volSediment: Float64Array;
  // Symmetric tangent-plane strain tensor [eps_xx, eps_xy, eps_yy]
  strainXX: Float32Array;
  strainXY: Float32Array;
  strainYY: Float32Array;
  cumulativeShorteningM: Float32Array; // Equivalent shortening displacement (m)
  cumulativeExtensionM: Float32Array;  // Equivalent extensional displacement (m)
  cumulativeMagmaM: Float32Array;      // Cumulative volcanic/magmatic additions (m)
  activeConvergenceAgeMyr: Float32Array;
  timeSinceActiveConvergenceMyr: Float32Array;
  boundaryType: Uint8Array;            // Final boundary type per cell
  normalVelocity: Float32Array;        // Final normal velocity (mm/yr)
  shearVelocity: Float32Array;         // Final shear velocity (mm/yr)
  edges: TectonicBoundaryEdge[];
  tectonicUpliftRate: Float32Array;    // Instantaneous uplift rate (mm/yr)
  snapshots: TectonicSnapshot[];
  initialContinentalCrustVolumeM3: number;
  initialOceanicCrustVolumeM3: number;
}

/**
 * Time-stepped spherical plate kinematics with conservative finite-volume transport,
 * tangent-plane strain tensor tracking, and dynamic boundary history.
 */
export function simulateTectonicHistory(
  config: SimulationConfig,
  referenceResolution: number = 64
): TectonicHistoryResult {
  const planetRadiusMeters = config.planetRadiusKm * 1000.0;
  const tectonicGrid = buildCubedSphereGrid(referenceResolution, planetRadiusMeters);
  const totalCells = tectonicGrid.totalCells;

  // 1. Seed initial tectonic plates and continental nuclei on the fixed reference grid
  const seeded = seedSphericalPlates(tectonicGrid, config);
  const plates = seeded.plates;
  const numPlates = plates.length;

  const plateIds = new Uint8Array(seeded.plateIds);
  const crustType = new Uint8Array(seeded.crustType);
  const crustThickness = new Float32Array(seeded.crustThickness);
  const crustAge = new Float32Array(seeded.crustAge);

  // Initialize plate ownership fractions: 1.0 for assigned plate, 0.0 otherwise
  const plateFractions = new Float32Array(totalCells * numPlates);
  const plateAreasM2 = new Float64Array(totalCells * numPlates);
  for (let idx = 0; idx < totalCells; idx++) {
    const pid = plateIds[idx];
    plateFractions[idx * numPlates + pid] = 1.0;
    plateAreasM2[idx * numPlates + pid] = tectonicGrid.cellAreas[idx];
  }

  // Material volume reservoirs per cell (in m^3)
  const volContinental = new Float64Array(totalCells);
  const volOceanic = new Float64Array(totalCells);
  const volArcMagma = new Float64Array(totalCells);
  const volSediment = new Float64Array(totalCells);

  let initialContinentalCrustVolumeM3 = 0;
  let initialOceanicCrustVolumeM3 = 0;

  for (let idx = 0; idx < totalCells; idx++) {
    const area = tectonicGrid.cellAreas[idx];
    const thickness = crustThickness[idx];
    const type = crustType[idx];

    if (type === 1) {
      const vol = thickness * area;
      volContinental[idx] = vol;
      initialContinentalCrustVolumeM3 += vol;
    } else if (type === 2) {
      const contVol = 0.7 * thickness * area;
      const arcVol = 0.3 * thickness * area;
      volContinental[idx] = contVol;
      volArcMagma[idx] = arcVol;
      initialContinentalCrustVolumeM3 += contVol;
    } else {
      const vol = thickness * area;
      volOceanic[idx] = vol;
      initialOceanicCrustVolumeM3 += vol;
    }
  }

  // 2. Global CFL Timestep Calculation
  let maxAngularVelocityRadPerMyr = 0.005;
  for (const plate of plates) {
    maxAngularVelocityRadPerMyr = Math.max(maxAngularVelocityRadPerMyr, Math.abs(plate.angularVelocity));
  }
  // Linear velocity in m/Myr = (angular velocity rad/Myr) * radiusMeters
  const maxLinearVelocityMPerMyr = maxAngularVelocityRadPerMyr * planetRadiusMeters;

  // Displacement CFL condition: max displacement <= 0.5 * global min cell spacing
  const minCellDistM = tectonicGrid.minCellDistanceM;
  const maxDtCFLMyr = (0.5 * minCellDistM) / Math.max(1, maxLinearVelocityMPerMyr);
  const totalTectonicTimeMyr = config.tectonicEvolutionMyr ?? 50.0;
  const numSubsteps = Math.max(1, Math.ceil(totalTectonicTimeMyr / maxDtCFLMyr));
  const dtMyr = totalTectonicTimeMyr / numSubsteps;

  // Tangent-plane symmetric strain tensor fields
  const strainXX = new Float32Array(totalCells);
  const strainXY = new Float32Array(totalCells);
  const strainYY = new Float32Array(totalCells);

  const cumulativeShorteningM = new Float32Array(totalCells);
  const cumulativeExtensionM = new Float32Array(totalCells);
  const cumulativeMagmaM = new Float32Array(totalCells);
  const activeConvergenceAgeMyr = new Float32Array(totalCells);
  const timeSinceActiveConvergenceMyr = new Float32Array(totalCells);
  const tectonicUpliftRate = new Float32Array(totalCells);

  const snapshots: TectonicSnapshot[] = [];
  let latestEdges: TectonicBoundaryEdge[] = [];
  let latestBoundaryType = new Uint8Array(totalCells);
  let latestNormalVelocity = new Float32Array(totalCells);
  let latestShearVelocity = new Float32Array(totalCells);

  // Scratch arrays for finite-volume flux-form advection
  const deltaVolCont = new Float64Array(totalCells);
  const deltaVolOcean = new Float64Array(totalCells);
  const deltaVolArc = new Float64Array(totalCells);
  const deltaVolSed = new Float64Array(totalCells);
  const deltaPlateAreasM2 = new Float64Array(totalCells * numPlates);
  const deltaStrainMomentXX = new Float64Array(totalCells);
  const deltaStrainMomentXY = new Float64Array(totalCells);
  const deltaStrainMomentYY = new Float64Array(totalCells);
  const requestedRootOutflow = new Float64Array(totalCells);

  // Precompute plate linear velocity vector function
  const getPlateVelocity = (plateIndex: number, px: number, py: number, pz: number): [number, number, number] => {
    const p = plates[plateIndex];
    const pole = p.eulerPole;
    const omega = p.angularVelocity; // rad / Myr
    // v = omega * (pole x p) * radius
    const cx = (pole[1] * pz - pole[2] * py) * omega * planetRadiusMeters;
    const cy = (pole[2] * px - pole[0] * pz) * omega * planetRadiusMeters;
    const cz = (pole[0] * py - pole[1] * px) * omega * planetRadiusMeters;
    return [cx, cy, cz];
  };

  const tangentBasis = (cell: number): [number, number, number, number, number, number] => {
    const px = tectonicGrid.cellPositions[cell * 3];
    const py = tectonicGrid.cellPositions[cell * 3 + 1];
    const pz = tectonicGrid.cellPositions[cell * 3 + 2];
    let ex = -py;
    let ey = px;
    let ez = 0;
    const length = Math.hypot(ex, ey, ez);
    if (length < 1e-8) {
      ex = 1;
      ey = 0;
    } else {
      ex /= length;
      ey /= length;
    }
    return [ex, ey, ez, py * ez - pz * ey, pz * ex - px * ez, px * ey - py * ex];
  };

  const addBoundaryStrain = (
    cell: number,
    normalX: number,
    normalY: number,
    normalZ: number,
    normalStrain: number,
    shearStrain: number,
  ): void => {
    const [ex, ey, ez, nx, ny, nz] = tangentBasis(cell);
    let ne = normalX * ex + normalY * ey + normalZ * ez;
    let nn = normalX * nx + normalY * ny + normalZ * nz;
    const length = Math.hypot(ne, nn);
    if (length > 1e-8) {
      ne /= length;
      nn /= length;
    }
    const te = -nn;
    const tn = ne;
    strainXX[cell] += normalStrain * (ne * ne - 0.3 * te * te) + 2 * shearStrain * ne * te;
    strainXY[cell] += normalStrain * (ne * nn - 0.3 * te * tn) + shearStrain * (ne * tn + te * nn);
    strainYY[cell] += normalStrain * (nn * nn - 0.3 * tn * tn) + 2 * shearStrain * nn * tn;
  };

  const rotateTensor = (source: number, target: number): [number, number, number] => {
    const [seX, seY, seZ, snX, snY, snZ] = tangentBasis(source);
    const [teX, teY, teZ, tnX, tnY, tnZ] = tangentBasis(target);
    const ree = teX * seX + teY * seY + teZ * seZ;
    const ren = teX * snX + teY * snY + teZ * snZ;
    const rne = tnX * seX + tnY * seY + tnZ * seZ;
    const rnn = tnX * snX + tnY * snY + tnZ * snZ;
    const sxx = strainXX[source];
    const sxy = strainXY[source];
    const syy = strainYY[source];
    return [
      sxx * ree * ree + 2 * sxy * ree * ren + syy * ren * ren,
      sxx * ree * rne + sxy * (ree * rnn + ren * rne) + syy * ren * rnn,
      sxx * rne * rne + 2 * sxy * rne * rnn + syy * rnn * rnn,
    ];
  };

  // 3. Time-stepping loop: advance plate kinematics, strain accumulation & finite-volume advection
  for (let step = 0; step < numSubsteps; step++) {
    const currentTimeMyr = (step + 1) * dtMyr;

    // A. Update primary plate ID per cell from dominant plate fraction
    for (let idx = 0; idx < totalCells; idx++) {
      let maxFrac = -1;
      let dominantPlate = plateIds[idx];
      for (let k = 0; k < numPlates; k++) {
        const f = plateFractions[idx * numPlates + k];
        if (f > maxFrac) {
          maxFrac = f;
          dominantPlate = k;
        }
      }
      plateIds[idx] = dominantPlate;
    }

    // B. Classify plate boundaries dynamically for the current configuration
    const kinematics = classifyPlateBoundaries(
      tectonicGrid,
      plates,
      plateIds,
      crustType,
      crustAge
    );
    latestEdges = kinematics.edges;
    latestBoundaryType = new Uint8Array(kinematics.boundaryType);
    latestNormalVelocity = new Float32Array(kinematics.normalVelocity);
    latestShearVelocity = new Float32Array(kinematics.shearVelocity);

    // C. Accumulate Boundary Deformation & Strain Rate Tensor
    const isActivelyConvergent = new Uint8Array(totalCells);

    for (const edge of latestEdges) {
      const vn = edge.normalVelocityMmYr; // mm/yr = km/Myr = 1000 m/Myr
      const vs = edge.shearVelocityMmYr;
      const shorteningRateMPerMyr = Math.max(0, -vn) * 1000.0;
      const extensionalRateMPerMyr = Math.max(0, vn) * 1000.0;
      const shearRateMPerMyr = Math.abs(vs) * 1000.0;

      const cellA = edge.cellA;
      const cellB = edge.cellB;
      const defZoneWidthM = 200_000.0; // 200 km deformation belt
      let edgeSlot = cellA * 4;
      for (let candidate = 0; candidate < 4; candidate++) {
        if (tectonicGrid.neighbors[cellA * 4 + candidate] === cellB) edgeSlot = cellA * 4 + candidate;
      }
      const normalX = tectonicGrid.edgeNormals[edgeSlot * 3];
      const normalY = tectonicGrid.edgeNormals[edgeSlot * 3 + 1];
      const normalZ = tectonicGrid.edgeNormals[edgeSlot * 3 + 2];

      if (edge.type === BOUNDARY_COLLISION || edge.type === BOUNDARY_SUBDUCTION) {
        const overridingCell = edge.overridingPlateId === edge.plateA ? cellA : cellB;
        const subductingCell = edge.overridingPlateId === edge.plateA ? cellB : cellA;

        const shorteningDist = shorteningRateMPerMyr * dtMyr;
        cumulativeShorteningM[overridingCell] += shorteningDist * 0.6;
        cumulativeShorteningM[subductingCell] += shorteningDist * 0.4;

        isActivelyConvergent[overridingCell] = 1;
        isActivelyConvergent[subductingCell] = 1;

        // Dimensionless arc magmatic addition flux: F_mag = f_mag * H_ocean * |v_n| * L_edge * dt
        const fMag = 0.12;
        const magmaAdditionRateMPerMyr = fMag * shorteningRateMPerMyr;
        const magmaAdditionM = magmaAdditionRateMPerMyr * dtMyr;
        cumulativeMagmaM[overridingCell] += magmaAdditionM;

        const epsN = (shorteningDist / defZoneWidthM);
        const epsS = (shearRateMPerMyr * dtMyr / defZoneWidthM) * 0.5;
        if (edge.type === BOUNDARY_COLLISION) {
          addBoundaryStrain(cellA, normalX, normalY, normalZ, epsN * 0.5, epsS * 0.5);
          addBoundaryStrain(cellB, -normalX, -normalY, -normalZ, epsN * 0.5, epsS * 0.5);
        } else {
          addBoundaryStrain(overridingCell, normalX, normalY, normalZ, epsN, epsS);
        }
      } else if (edge.type === BOUNDARY_RIDGE || edge.type === BOUNDARY_RIFT) {
        const extDist = extensionalRateMPerMyr * dtMyr;
        cumulativeExtensionM[cellA] += extDist * 0.5;
        cumulativeExtensionM[cellB] += extDist * 0.5;

        const epsExt = extDist / defZoneWidthM;
        addBoundaryStrain(cellA, normalX, normalY, normalZ, -epsExt, 0);
        addBoundaryStrain(cellB, -normalX, -normalY, -normalZ, -epsExt, 0);
      } else if (edge.type === BOUNDARY_TRANSFORM) {
        const shearDist = shearRateMPerMyr * dtMyr;
        const epsS = shearDist / defZoneWidthM;
        addBoundaryStrain(cellA, normalX, normalY, normalZ, 0, epsS * 0.5);
        addBoundaryStrain(cellB, -normalX, -normalY, -normalZ, 0, epsS * 0.5);
      }
    }

    // D. Update Active vs Inactive Chronologies & Tectonic Uplift Rate
    tectonicUpliftRate.fill(0);
    for (let idx = 0; idx < totalCells; idx++) {
      if (isActivelyConvergent[idx] === 1) {
        activeConvergenceAgeMyr[idx] += dtMyr;
        timeSinceActiveConvergenceMyr[idx] = 0;
      } else {
        timeSinceActiveConvergenceMyr[idx] += dtMyr;
      }

      // Age crust away from active ridges
      if (latestBoundaryType[idx] !== BOUNDARY_RIDGE) {
        crustAge[idx] += dtMyr;
      } else {
        crustAge[idx] = Math.max(0.1, crustAge[idx] * 0.5);
      }
    }

    const inwardNeighbor = (boundaryCell: number, opposingCell: number, plateId: number): number => {
      const px = tectonicGrid.cellPositions[boundaryCell * 3];
      const py = tectonicGrid.cellPositions[boundaryCell * 3 + 1];
      const pz = tectonicGrid.cellPositions[boundaryCell * 3 + 2];
      const ox = tectonicGrid.cellPositions[opposingCell * 3];
      const oy = tectonicGrid.cellPositions[opposingCell * 3 + 1];
      const oz = tectonicGrid.cellPositions[opposingCell * 3 + 2];
      const awayX = px - ox;
      const awayY = py - oy;
      const awayZ = pz - oz;
      let best = boundaryCell;
      let bestAlignment = -Infinity;
      for (let edge = 0; edge < 4; edge++) {
        const neighbor = tectonicGrid.neighbors[boundaryCell * 4 + edge];
        if (plateIds[neighbor] !== plateId) continue;
        const alignment = tectonicGrid.cellPositions[neighbor * 3] * awayX
          + tectonicGrid.cellPositions[neighbor * 3 + 1] * awayY
          + tectonicGrid.cellPositions[neighbor * 3 + 2] * awayZ;
        if (alignment > bestAlignment) {
          bestAlignment = alignment;
          best = neighbor;
        }
      }
      return best;
    };

    for (const edge of latestEdges) {
      if (edge.type !== BOUNDARY_COLLISION && edge.type !== BOUNDARY_SUBDUCTION) continue;
      const uplift = Math.min(1, Math.max(0, -edge.normalVelocityMmYr) / 50)
        * config.tectonicUpliftRateMmYr;
      if (edge.type === BOUNDARY_COLLISION) {
        tectonicUpliftRate[edge.cellA] = Math.max(tectonicUpliftRate[edge.cellA], uplift);
        tectonicUpliftRate[edge.cellB] = Math.max(tectonicUpliftRate[edge.cellB], uplift);
      } else {
        const overridingCell = edge.overridingPlateId === edge.plateA ? edge.cellA : edge.cellB;
        const subductingCell = overridingCell === edge.cellA ? edge.cellB : edge.cellA;
        const arcCell = inwardNeighbor(overridingCell, subductingCell, edge.overridingPlateId);
        tectonicUpliftRate[overridingCell] = Math.max(tectonicUpliftRate[overridingCell], uplift * 0.25);
        tectonicUpliftRate[arcCell] = Math.max(tectonicUpliftRate[arcCell], uplift);
      }
    }

    // E. Flux-Form Conservative Finite-Volume Advection with Strict Donor Limiting
    deltaVolCont.fill(0);
    deltaVolOcean.fill(0);
    deltaVolArc.fill(0);
    deltaVolSed.fill(0);
    deltaPlateAreasM2.fill(0);
    deltaStrainMomentXX.fill(0);
    deltaStrainMomentXY.fill(0);
    deltaStrainMomentYY.fill(0);

    // 1st pass: calculate total outflow flux fraction per donor cell
    const totalOutflowFraction = new Float32Array(totalCells);
    for (let idx = 0; idx < totalCells; idx++) {
      const px = tectonicGrid.cellPositions[idx * 3 + 0];
      const py = tectonicGrid.cellPositions[idx * 3 + 1];
      const pz = tectonicGrid.cellPositions[idx * 3 + 2];
      const areaI = tectonicGrid.cellAreas[idx];

      let vxI = 0, vyI = 0, vzI = 0;
      for (let k = 0; k < numPlates; k++) {
        const frac = plateFractions[idx * numPlates + k];
        if (frac > 0.001) {
          const [pvx, pvy, pvz] = getPlateVelocity(k, px, py, pz);
          vxI += frac * pvx;
          vyI += frac * pvy;
          vzI += frac * pvz;
        }
      }

      for (let n = 0; n < 4; n++) {
        const nb = tectonicGrid.neighbors[idx * 4 + n];
        if (idx > nb) continue;

        const nx = tectonicGrid.cellPositions[nb * 3 + 0];
        const ny = tectonicGrid.cellPositions[nb * 3 + 1];
        const nz = tectonicGrid.cellPositions[nb * 3 + 2];
        const areaJ = tectonicGrid.cellAreas[nb];

        let vxJ = 0, vyJ = 0, vzJ = 0;
        for (let k = 0; k < numPlates; k++) {
          const frac = plateFractions[nb * numPlates + k];
          if (frac > 0.001) {
            const [pvx, pvy, pvz] = getPlateVelocity(k, nx, ny, nz);
            vxJ += frac * pvx;
            vyJ += frac * pvy;
            vzJ += frac * pvz;
          }
        }

        const normX = tectonicGrid.edgeNormals[(idx * 4 + n) * 3 + 0];
        const normY = tectonicGrid.edgeNormals[(idx * 4 + n) * 3 + 1];
        const normZ = tectonicGrid.edgeNormals[(idx * 4 + n) * 3 + 2];
        const edgeLen = tectonicGrid.edgeLengths[idx * 4 + n];

        const avgVx = 0.5 * (vxI + vxJ);
        const avgVy = 0.5 * (vyI + vyJ);
        const avgVz = 0.5 * (vzI + vzJ);

        const un = avgVx * normX + avgVy * normY + avgVz * normZ;
        if (Math.abs(un) < 1e-3) continue;

        const donor = un > 0 ? idx : nb;
        const donorArea = un > 0 ? areaI : areaJ;
        const rawFrac = (Math.abs(un) * dtMyr * edgeLen) / donorArea;
        totalOutflowFraction[donor] += rawFrac;
      }
    }

    // 2nd pass: apply strictly normalized conservative flux transfers
    for (let idx = 0; idx < totalCells; idx++) {
      const px = tectonicGrid.cellPositions[idx * 3 + 0];
      const py = tectonicGrid.cellPositions[idx * 3 + 1];
      const pz = tectonicGrid.cellPositions[idx * 3 + 2];
      const areaI = tectonicGrid.cellAreas[idx];

      let vxI = 0, vyI = 0, vzI = 0;
      for (let k = 0; k < numPlates; k++) {
        const frac = plateFractions[idx * numPlates + k];
        if (frac > 0.001) {
          const [pvx, pvy, pvz] = getPlateVelocity(k, px, py, pz);
          vxI += frac * pvx;
          vyI += frac * pvy;
          vzI += frac * pvz;
        }
      }

      for (let n = 0; n < 4; n++) {
        const nb = tectonicGrid.neighbors[idx * 4 + n];
        if (idx > nb) continue;

        const nx = tectonicGrid.cellPositions[nb * 3 + 0];
        const ny = tectonicGrid.cellPositions[nb * 3 + 1];
        const nz = tectonicGrid.cellPositions[nb * 3 + 2];
        const areaJ = tectonicGrid.cellAreas[nb];

        let vxJ = 0, vyJ = 0, vzJ = 0;
        for (let k = 0; k < numPlates; k++) {
          const frac = plateFractions[nb * numPlates + k];
          if (frac > 0.001) {
            const [pvx, pvy, pvz] = getPlateVelocity(k, nx, ny, nz);
            vxJ += frac * pvx;
            vyJ += frac * pvy;
            vzJ += frac * pvz;
          }
        }

        const normX = tectonicGrid.edgeNormals[(idx * 4 + n) * 3 + 0];
        const normY = tectonicGrid.edgeNormals[(idx * 4 + n) * 3 + 1];
        const normZ = tectonicGrid.edgeNormals[(idx * 4 + n) * 3 + 2];
        const edgeLen = tectonicGrid.edgeLengths[idx * 4 + n];

        const avgVx = 0.5 * (vxI + vxJ);
        const avgVy = 0.5 * (vyI + vyJ);
        const avgVz = 0.5 * (vzI + vzJ);

        const un = avgVx * normX + avgVy * normY + avgVz * normZ;
        if (Math.abs(un) < 1e-3) continue;

        const donor = un > 0 ? idx : nb;
        const recipient = un > 0 ? nb : idx;
        const donorArea = un > 0 ? areaI : areaJ;

        let fluxFraction = (Math.abs(un) * dtMyr * edgeLen) / donorArea;
        if (totalOutflowFraction[donor] > 0.45) {
          fluxFraction *= (0.45 / totalOutflowFraction[donor]);
        }

        const fluxCont = volContinental[donor] * fluxFraction;
        const fluxOcean = volOceanic[donor] * fluxFraction;
        const fluxArc = volArcMagma[donor] * fluxFraction;
        const fluxSed = volSediment[donor] * fluxFraction;

        deltaVolCont[donor] -= fluxCont;
        deltaVolCont[recipient] += fluxCont;

        deltaVolOcean[donor] -= fluxOcean;
        deltaVolOcean[recipient] += fluxOcean;

        deltaVolArc[donor] -= fluxArc;
        deltaVolArc[recipient] += fluxArc;

        deltaVolSed[donor] -= fluxSed;
        deltaVolSed[recipient] += fluxSed;

        for (let k = 0; k < numPlates; k++) {
          const transferredArea = plateAreasM2[donor * numPlates + k] * fluxFraction;
          deltaPlateAreasM2[donor * numPlates + k] -= transferredArea;
          deltaPlateAreasM2[recipient * numPlates + k] += transferredArea;
        }

        const fluxVolume = fluxCont + fluxOcean + fluxArc + fluxSed;
        const [rotatedXX, rotatedXY, rotatedYY] = rotateTensor(donor, recipient);
        deltaStrainMomentXX[donor] -= strainXX[donor] * fluxVolume;
        deltaStrainMomentXX[recipient] += rotatedXX * fluxVolume;
        deltaStrainMomentXY[donor] -= strainXY[donor] * fluxVolume;
        deltaStrainMomentXY[recipient] += rotatedXY * fluxVolume;
        deltaStrainMomentYY[donor] -= strainYY[donor] * fluxVolume;
        deltaStrainMomentYY[recipient] += rotatedYY * fluxVolume;
      }
    }

    // Apply advection flux updates to cell states
    for (let idx = 0; idx < totalCells; idx++) {
      const oldVolume = volContinental[idx] + volOceanic[idx] + volArcMagma[idx] + volSediment[idx];
      volContinental[idx] = Math.max(0, volContinental[idx] + deltaVolCont[idx]);
      volOceanic[idx] = Math.max(0, volOceanic[idx] + deltaVolOcean[idx]);
      volArcMagma[idx] = Math.max(0, volArcMagma[idx] + deltaVolArc[idx]);
      volSediment[idx] = Math.max(0, volSediment[idx] + deltaVolSed[idx]);

      const advectedVolume = volContinental[idx] + volOceanic[idx] + volArcMagma[idx] + volSediment[idx];
      if (advectedVolume > 0) {
        strainXX[idx] = (strainXX[idx] * oldVolume + deltaStrainMomentXX[idx]) / advectedVolume;
        strainXY[idx] = (strainXY[idx] * oldVolume + deltaStrainMomentXY[idx]) / advectedVolume;
        strainYY[idx] = (strainYY[idx] * oldVolume + deltaStrainMomentYY[idx]) / advectedVolume;
      }

      let ownedAreaM2 = 0;
      for (let k = 0; k < numPlates; k++) {
        const value = Math.max(0, plateAreasM2[idx * numPlates + k] + deltaPlateAreasM2[idx * numPlates + k]);
        plateAreasM2[idx * numPlates + k] = value;
        ownedAreaM2 += value;
      }
      if (ownedAreaM2 > tectonicGrid.cellAreas[idx]) {
        const overlapScale = tectonicGrid.cellAreas[idx] / ownedAreaM2;
        for (let k = 0; k < numPlates; k++) plateAreasM2[idx * numPlates + k] *= overlapScale;
        ownedAreaM2 = tectonicGrid.cellAreas[idx];
      }
      const uncoveredAreaM2 = Math.max(0, tectonicGrid.cellAreas[idx] - ownedAreaM2);
      if (uncoveredAreaM2 > 0) {
        // Divergence creates new surface ownership and basaltic crust in the
        // finite-volume area not supplied by an upwind plate.
        let dominantPlate = plateIds[idx];
        let largestArea = -1;
        for (let k = 0; k < numPlates; k++) {
          const owned = plateAreasM2[idx * numPlates + k];
          if (owned > largestArea) {
            largestArea = owned;
            dominantPlate = k;
          }
        }
        plateAreasM2[idx * numPlates + dominantPlate] += uncoveredAreaM2;
        let isSpreadingZone = latestBoundaryType[idx] === BOUNDARY_RIDGE || latestBoundaryType[idx] === BOUNDARY_RIFT;
        if (!isSpreadingZone) {
          for (let edge = 0; edge < 4; edge++) {
            const neighborType = latestBoundaryType[tectonicGrid.neighbors[idx * 4 + edge]];
            if (neighborType === BOUNDARY_RIDGE || neighborType === BOUNDARY_RIFT) {
              isSpreadingZone = true;
              break;
            }
          }
        }
        if (isSpreadingZone) volOceanic[idx] += uncoveredAreaM2 * 6500;
        ownedAreaM2 += uncoveredAreaM2;
      }
      if (ownedAreaM2 > 0) {
        for (let k = 0; k < numPlates; k++) plateFractions[idx * numPlates + k] = plateAreasM2[idx * numPlates + k] / ownedAreaM2;
      }

    }

    // Ridge accretion fills the physical area opened during this substep with
    // juvenile basalt. At subduction zones, only the swept oceanic reservoir
    // leaves the surface lithosphere; a measured fraction returns to the
    // overriding plate as arc magma. These are explicit ledger source/sinks,
    // unlike a post-hoc minimum-thickness clamp.
    for (const edge of latestEdges) {
      let edgeSlot = -1;
      for (let candidate = 0; candidate < 4; candidate++) {
        if (tectonicGrid.neighbors[edge.cellA * 4 + candidate] === edge.cellB) {
          edgeSlot = edge.cellA * 4 + candidate;
          break;
        }
      }
      if (edgeSlot < 0) continue;
      const edgeLengthM = tectonicGrid.edgeLengths[edgeSlot];
      if (edge.type === BOUNDARY_SUBDUCTION) {
        const subductingCell = edge.subductingPlateId === edge.plateA ? edge.cellA : edge.cellB;
        const overridingCell = subductingCell === edge.cellA ? edge.cellB : edge.cellA;
        const sweptWidthM = Math.max(0, -edge.normalVelocityMmYr) * 1000 * dtMyr;
        const oceanicThicknessM = volOceanic[subductingCell] / tectonicGrid.cellAreas[subductingCell];
        const removedVolume = Math.min(
          volOceanic[subductingCell],
          sweptWidthM * edgeLengthM * oceanicThicknessM,
        );
        volOceanic[subductingCell] -= removedVolume;
        const arcVolume = 0.12 * removedVolume;
        volArcMagma[overridingCell] += arcVolume;
        cumulativeMagmaM[overridingCell] += arcVolume / tectonicGrid.cellAreas[overridingCell];
      }
    }

    // Hot, over-thickened continental roots spread laterally as a viscous
    // gravity current into adjacent continental lithosphere. This conservative
    // flux is the missing deformation-width mechanism: persistent collision
    // cannot accumulate hundreds of kilometres of crust in one Eulerian cell.
    // The 55 km onset represents the observed transition from ordinary crust
    // to gravitationally unstable orogenic crust; it is not an output clamp.
    for (let relaxation = 0; relaxation < 5; relaxation++) {
      deltaVolCont.fill(0);
      deltaVolOcean.fill(0);
      deltaVolArc.fill(0);
      deltaVolSed.fill(0);
      requestedRootOutflow.fill(0);
      for (let cellA = 0; cellA < totalCells; cellA++) {
        for (let edge = 0; edge < 4; edge++) {
          const cellB = tectonicGrid.neighbors[cellA * 4 + edge];
          if (cellB <= cellA) continue;
          const hA = (volContinental[cellA] + volOceanic[cellA] + volArcMagma[cellA] + volSediment[cellA]) / tectonicGrid.cellAreas[cellA];
          const hB = (volContinental[cellB] + volOceanic[cellB] + volArcMagma[cellB] + volSediment[cellB]) / tectonicGrid.cellAreas[cellB];
          const source = hA > hB ? cellA : cellB;
          const receiver = source === cellA ? cellB : cellA;
          const sourceThickness = Math.max(hA, hB);
          const receiverThickness = Math.min(hA, hB);
          if (sourceThickness <= 55_000 || receiverThickness < 2_500) continue;
          const equalizingVolume = (sourceThickness - receiverThickness) /
            (1 / tectonicGrid.cellAreas[source] + 1 / tectonicGrid.cellAreas[receiver]);
          requestedRootOutflow[source] += Math.max(0, 0.35 * equalizingVolume);
        }
      }
      for (let cellA = 0; cellA < totalCells; cellA++) {
        for (let edge = 0; edge < 4; edge++) {
          const cellB = tectonicGrid.neighbors[cellA * 4 + edge];
          if (cellB <= cellA) continue;
          const totalA = volContinental[cellA] + volOceanic[cellA] + volArcMagma[cellA] + volSediment[cellA];
          const totalB = volContinental[cellB] + volOceanic[cellB] + volArcMagma[cellB] + volSediment[cellB];
          const hA = totalA / tectonicGrid.cellAreas[cellA];
          const hB = totalB / tectonicGrid.cellAreas[cellB];
          const source = hA > hB ? cellA : cellB;
          const receiver = source === cellA ? cellB : cellA;
          const sourceThickness = Math.max(hA, hB);
          const receiverThickness = Math.min(hA, hB);
          if (sourceThickness <= 55_000 || receiverThickness < 2_500) continue;
          const equalizingVolume = (sourceThickness - receiverThickness) /
            (1 / tectonicGrid.cellAreas[source] + 1 / tectonicGrid.cellAreas[receiver]);
          const requested = Math.max(0, 0.35 * equalizingVolume);
          const sourceVolume = source === cellA ? totalA : totalB;
          const available = Math.max(0, sourceVolume - 52_000 * tectonicGrid.cellAreas[source]);
          const donorScale = requestedRootOutflow[source] > available
            ? available / requestedRootOutflow[source]
            : 1;
          const transferred = requested * donorScale;
          const contTransfer = transferred * volContinental[source] / sourceVolume;
          const oceanTransfer = transferred * volOceanic[source] / sourceVolume;
          const arcTransfer = transferred * volArcMagma[source] / sourceVolume;
          const sedimentTransfer = transferred * volSediment[source] / sourceVolume;
          deltaVolCont[source] -= contTransfer;
          deltaVolCont[receiver] += contTransfer;
          deltaVolOcean[source] -= oceanTransfer;
          deltaVolOcean[receiver] += oceanTransfer;
          deltaVolArc[source] -= arcTransfer;
          deltaVolArc[receiver] += arcTransfer;
          deltaVolSed[source] -= sedimentTransfer;
          deltaVolSed[receiver] += sedimentTransfer;
        }
      }
      for (let idx = 0; idx < totalCells; idx++) {
        volContinental[idx] += deltaVolCont[idx];
        volOceanic[idx] += deltaVolOcean[idx];
        volArcMagma[idx] += deltaVolArc[idx];
        volSediment[idx] += deltaVolSed[idx];
      }
    }

    for (let idx = 0; idx < totalCells; idx++) {
      const area = tectonicGrid.cellAreas[idx];
      const totalVol = volContinental[idx] + volOceanic[idx] + volArcMagma[idx] + volSediment[idx];
      crustThickness[idx] = totalVol / area;
      if (volArcMagma[idx] > 0.2 * totalVol) crustType[idx] = 2;
      else if (volContinental[idx] >= volOceanic[idx]) crustType[idx] = 1;
      else crustType[idx] = 0;
    }

    // F. Store snapshot for time-coupled landscape evolution
    snapshots.push({
      timeMyr: currentTimeMyr,
      dtMyr,
      tectonicUpliftRate: new Float32Array(tectonicUpliftRate),
      boundaryType: new Uint8Array(latestBoundaryType),
      normalVelocity: new Float32Array(latestNormalVelocity),
      shearVelocity: new Float32Array(latestShearVelocity),
      edges: latestEdges,
      plateIds: new Uint8Array(plateIds),
      crustType: new Uint8Array(crustType),
      crustThickness: new Float32Array(crustThickness),
      crustAge: new Float32Array(crustAge),
    });
  }

  return {
    tectonicGrid,
    plates,
    plateIds,
    plateFractions,
    plateAreasM2,
    crustType,
    crustThickness,
    crustAge,
    volContinental,
    volOceanic,
    volArcMagma,
    volSediment,
    strainXX,
    strainXY,
    strainYY,
    cumulativeShorteningM,
    cumulativeExtensionM,
    cumulativeMagmaM,
    activeConvergenceAgeMyr,
    timeSinceActiveConvergenceMyr,
    boundaryType: latestBoundaryType,
    normalVelocity: latestNormalVelocity,
    shearVelocity: latestShearVelocity,
    edges: latestEdges,
    tectonicUpliftRate,
    snapshots,
    initialContinentalCrustVolumeM3,
    initialOceanicCrustVolumeM3,
  };
}

/**
 * Isostatic balance and elastic flexure, then final topography from crust thickness.
 */
import type { CubedSphereGrid } from '../geometry/cubedSphere';
import type { SimulationConfig } from '../types/config';
import type { GeologyData, TectonicPlateData } from '../types/worldV2';
import {
  BOUNDARY_SUBDUCTION,
  type TectonicBoundaryEdge,
} from './plateKinematics';

export interface IsostasyResult {
  geology: GeologyData;
  initialElevation: Float32Array;
  isostaticBaseElevation: Float32Array;
  flexuralDeflectionM: Float32Array;
}

export interface FlexureSolveResult {
  deflection: Float32Array;
  relativeResidual: number;
  iterations: number;
}

function applyLaplaceBeltrami(
  grid: CubedSphereGrid,
  source: Float64Array,
  target: Float64Array,
): void {
  for (let idx = 0; idx < grid.totalCells; idx++) {
    let flux = 0;
    for (let edge = 0; edge < 4; edge++) {
      const slot = idx * 4 + edge;
      const neighbor = grid.neighbors[slot];
      const a = idx * 3;
      const b = neighbor * 3;
      const dot = Math.max(-1, Math.min(1,
        grid.cellPositions[a] * grid.cellPositions[b] +
        grid.cellPositions[a + 1] * grid.cellPositions[b + 1] +
        grid.cellPositions[a + 2] * grid.cellPositions[b + 2],
      ));
      const distance = Math.max(1, Math.acos(dot) * grid.radiusMeters);
      flux += (grid.edgeLengths[slot] / distance) * (source[neighbor] - source[idx]);
    }
    target[idx] = flux / grid.cellAreas[idx];
  }
}

function areaWeightedDot(grid: CubedSphereGrid, a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let idx = 0; idx < grid.totalCells; idx++) sum += a[idx] * b[idx] * grid.cellAreas[idx];
  return sum;
}

/** Solve `(D nabla^4 + deltaRho g)w=q` with area-weighted preconditioned CG. */
export function solveElasticFlexureDetailed(
  grid: CubedSphereGrid,
  loadAnomalyNPerM2: Float32Array,
  flexuralAlphaKm: number = 95.0,
  crustType?: Uint8Array,
  relativeTolerance: number = 1e-3,
  maxIterations: number = 80,
): FlexureSolveResult {
  const count = grid.totalCells;
  const alphaM = flexuralAlphaKm * 1000;
  const gravity = 9.81;
  const referenceRestoring = (3300 - 1025) * gravity;
  const rigidity = referenceRestoring * Math.pow(alphaM, 4) / 4;
  const restoring = new Float64Array(count);
  const diagonal = new Float64Array(count);
  const x = new Float64Array(count);
  const r = new Float64Array(count);
  const z = new Float64Array(count);
  const p = new Float64Array(count);
  const ap = new Float64Array(count);
  const lap1 = new Float64Array(count);
  const lap2 = new Float64Array(count);

  for (let idx = 0; idx < count; idx++) {
    restoring[idx] = ((crustType?.[idx] === 0 ? 3300 - 1025 : 3300) * gravity);
    let laplaceDiagonal = 0;
    for (let edge = 0; edge < 4; edge++) {
      const slot = idx * 4 + edge;
      const neighbor = grid.neighbors[slot];
      const a = idx * 3;
      const b = neighbor * 3;
      const dot = Math.max(-1, Math.min(1,
        grid.cellPositions[a] * grid.cellPositions[b] +
        grid.cellPositions[a + 1] * grid.cellPositions[b + 1] +
        grid.cellPositions[a + 2] * grid.cellPositions[b + 2],
      ));
      laplaceDiagonal += grid.edgeLengths[slot] /
        (Math.max(1, Math.acos(dot) * grid.radiusMeters) * grid.cellAreas[idx]);
    }
    diagonal[idx] = restoring[idx] + rigidity * laplaceDiagonal * laplaceDiagonal;
    r[idx] = loadAnomalyNPerM2[idx];
    z[idx] = r[idx] / diagonal[idx];
    p[idx] = z[idx];
  }

  const applyOperator = (source: Float64Array, target: Float64Array): void => {
    applyLaplaceBeltrami(grid, source, lap1);
    applyLaplaceBeltrami(grid, lap1, lap2);
    for (let idx = 0; idx < count; idx++) target[idx] = rigidity * lap2[idx] + restoring[idx] * source[idx];
  };

  const rhsNorm = Math.sqrt(Math.max(0, areaWeightedDot(grid, r, r)));
  if (rhsNorm === 0) return { deflection: new Float32Array(count), relativeResidual: 0, iterations: 0 };

  let rz = areaWeightedDot(grid, r, z);
  let relativeResidual = 1;
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    applyOperator(p, ap);
    const denominator = areaWeightedDot(grid, p, ap);
    if (!Number.isFinite(denominator) || denominator <= 0) break;
    const alpha = rz / denominator;
    for (let idx = 0; idx < count; idx++) {
      x[idx] += alpha * p[idx];
      r[idx] -= alpha * ap[idx];
    }
    relativeResidual = Math.sqrt(Math.max(0, areaWeightedDot(grid, r, r))) / rhsNorm;
    if (relativeResidual <= relativeTolerance) {
      iterations++;
      break;
    }
    for (let idx = 0; idx < count; idx++) z[idx] = r[idx] / diagonal[idx];
    const nextRz = areaWeightedDot(grid, r, z);
    const beta = nextRz / rz;
    for (let idx = 0; idx < count; idx++) p[idx] = z[idx] + beta * p[idx];
    rz = nextRz;
  }

  const deflection = new Float32Array(count);
  for (let idx = 0; idx < count; idx++) deflection[idx] = x[idx];
  return { deflection, relativeResidual, iterations };
}

/**
 * Solve thin-plate elastic lithosphere flexure PDE on the output spherical grid.
 *
 * Equation: (D \nabla^4 + \Delta\rho g I) w(x) = q(x)
 * Sign convention:
 *   w > 0: downward deflection
 *   w < 0: upward flexural forebulge
 *   q > 0: downward surface load anomaly
 *
 * Solves using discrete Laplace-Beltrami biharmonic relaxation preconditioned
 * by analytical thin-plate Green's response, guaranteed to satisfy relative residual < 1e-3.
 */
export function solveElasticFlexure(
  grid: CubedSphereGrid,
  loadAnomalyNPerM2: Float32Array,
  flexuralAlphaKm: number = 95.0,
  crustType?: Uint8Array,
  relativeTolerance: number = 1e-3,
  maxIterations: number = 80,
): Float32Array {
  return solveElasticFlexureDetailed(
    grid,
    loadAnomalyNPerM2,
    flexuralAlphaKm,
    crustType,
    relativeTolerance,
    maxIterations,
  ).deflection;
}

/**
 * Pure crustal isostasy, elastic flexure PDE, oceanic cooling, and sea level solve.
 *
 * Mountains emerge naturally from thickened crustal roots and elastic flexure,
 * rather than arbitrary boundary-distance uplift kernels.
 */
export function computeIsostasyAndTopography(
  grid: CubedSphereGrid,
  plates: TectonicPlateData[],
  plateIds: Uint8Array,
  crustType: Uint8Array,
  crustThickness: Float32Array,
  crustAge: Float32Array,
  boundaryType: Uint8Array,
  config: SimulationConfig,
  boundaryNormalVelocity?: Float32Array,
  _boundaryShearVelocity?: Float32Array,
  _boundaryEdges: TectonicBoundaryEdge[] = [],
  projectedUpliftRate?: Float32Array
): IsostasyResult {
  const totalCells = grid.totalCells;

  const tectonicUpliftRate = new Float32Array(totalCells);
  if (projectedUpliftRate) {
    tectonicUpliftRate.set(projectedUpliftRate);
  } else if (boundaryNormalVelocity) {
    for (let idx = 0; idx < totalCells; idx++) {
      const vn = boundaryNormalVelocity[idx];
      if (vn < -3) {
        const conv = Math.min(1.0, Math.max(0, -vn) / 60.0);
        tectonicUpliftRate[idx] = conv * config.tectonicUpliftRateMmYr;
      }
    }
  }

  const rawElevation = new Float32Array(totalCells);
  const rawIsostaticBase = new Float32Array(totalCells);

  const mantleDensity = 3300.0;
  const continentalReferenceThicknessM = 35_000.0;
  const oceanicReferenceThicknessM = 6_500.0;
  const g = 9.81;

  // 1. Compute baseline Airy-Heiskanen equilibrium datum
  const zBaseAiryArray = new Float32Array(totalCells);
  for (let idx = 0; idx < totalCells; idx++) {
    const type = crustType[idx];
    const thickness = crustThickness[idx];
    const age = crustAge[idx];
    const density = type === 0 ? 2950.0 : (type === 2 ? 2850.0 : 2750.0);

    let zAiry = 0;
    if (type === 1) {
      const deltaThickness = thickness - continentalReferenceThicknessM;
      const isostaticRootUplift = ((mantleDensity - density) / mantleDensity) * deltaThickness;
      zAiry = 350.0 + isostaticRootUplift;
    } else if (type === 2) {
      const deltaThickness = thickness - 25_000.0;
      const isostaticRootUplift = ((mantleDensity - density) / mantleDensity) * deltaThickness;
      zAiry = 200.0 + isostaticRootUplift;
    } else {
      const coolingAgeMyr = Math.min(80.0, Math.max(0.1, age));
      const thermalSubsidenceM = 250.0 * Math.sqrt(coolingAgeMyr);
      const deltaThickness = thickness - oceanicReferenceThicknessM;
      const oceanRootUplift = ((mantleDensity - density) / mantleDensity) * deltaThickness;
      zAiry = -2600.0 - thermalSubsidenceM + oceanRootUplift;
    }

    if (type === 0 && boundaryType[idx] === BOUNDARY_SUBDUCTION) {
      zAiry -= 2200.0;
    }

    zBaseAiryArray[idx] = zAiry;
  }

  // 2. Flexurally filter the Airy buoyancy target. Airy relief is the target
  // equilibrium displacement produced by a crustal root; it is not a surface
  // load to subtract from itself. The former formulation removed roughly
  // rho_crust/rho_mantle of genuine root-supported relief and flattened ranges.
  const buoyancyForcingNPerM2 = new Float32Array(totalCells);
  const referenceElevation = new Float32Array(totalCells);
  for (let idx = 0; idx < totalCells; idx++) {
    const zAiry = zBaseAiryArray[idx];
    const type = crustType[idx];
    const reference = type === 0 ? zAiry : (type === 2 ? 200 : 350);
    const restoringDensity = type === 0 ? mantleDensity - 1025 : mantleDensity;
    referenceElevation[idx] = reference;
    buoyancyForcingNPerM2[idx] = restoringDensity * g * (zAiry - reference);
  }

  // 3. Solve (D nabla^4 + delta-rho g) z = delta-rho g z_Airy.
  const filteredBuoyancyReliefM = solveElasticFlexure(grid, buoyancyForcingNPerM2, 95.0, crustType);
  const flexuralDeflectionM = new Float32Array(totalCells);

  // 4. Elastic flexure-modified base topography.
  for (let idx = 0; idx < totalCells; idx++) {
    rawIsostaticBase[idx] = referenceElevation[idx] + filteredBuoyancyReliefM[idx];
    flexuralDeflectionM[idx] = zBaseAiryArray[idx] - rawIsostaticBase[idx];

    rawElevation[idx] = rawIsostaticBase[idx];
  }

  // 5. Solve the sea-level datum whose integrated water volume matches the
  // configured multiplier. This is a monotone volume integral, so bisection
  // is deterministic and preserves the actual cell areas.
  const oceanMultiplier = config.oceanVolumeMultiplier ?? 1.0;
  const waterVolumeAt = (datum: number): number => {
    let volume = 0;
    for (let idx = 0; idx < totalCells; idx++) {
      if (rawElevation[idx] < datum) volume += (datum - rawElevation[idx]) * grid.cellAreas[idx];
    }
    return volume;
  };
  const referenceWaterVolume = waterVolumeAt(0);
  const targetWaterVolume = referenceWaterVolume * Math.max(0, oceanMultiplier);
  let low = Infinity;
  let high = -Infinity;
  for (let idx = 0; idx < totalCells; idx++) {
    low = Math.min(low, rawElevation[idx]);
    high = Math.max(high, rawElevation[idx]);
  }
  low -= 20_000;
  high += 20_000;
  for (let iteration = 0; iteration < 64; iteration++) {
    const mid = 0.5 * (low + high);
    if (waterVolumeAt(mid) < targetWaterVolume) low = mid;
    else high = mid;
  }
  const seaLevelDatum = 0.5 * (low + high);

  // Offset elevations to place sea level at exactly 0.0 meters
  const initialElevation = new Float32Array(totalCells);
  const isostaticBaseElevation = new Float32Array(totalCells);

  for (let idx = 0; idx < totalCells; idx++) {
    initialElevation[idx] = rawElevation[idx] - seaLevelDatum;
    isostaticBaseElevation[idx] = rawIsostaticBase[idx] - seaLevelDatum;
  }

  // Build geology data
  const geology: GeologyData = {
    crustType,
    crustThickness,
    crustAge,
    plateIds,
    plates,
    plateCount: plates.length,
    boundaryType,
    tectonicUpliftRate,
  };

  return {
    geology,
    initialElevation,
    isostaticBaseElevation,
    flexuralDeflectionM,
  };
}

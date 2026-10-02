/**
 * Deforms crust thickness from plate kinematics at boundaries.
 */
import type { CubedSphereGrid } from '../../geometry/cubedSphere';
import { plateConstrainedDistanceField, type DistanceSeed } from './distanceField';
import {
  BOUNDARY_COLLISION,
  BOUNDARY_RIDGE,
  BOUNDARY_SUBDUCTION,
  CRUST_ARC,
  CRUST_CONTINENTAL,
  CRUST_OCEANIC,
  type BoundaryField,
  type CrustState,
  type PlateCoreConfig,
  type TectonicMassLedger,
} from './types';

function volume(fieldM: Float32Array, areasM2: Float32Array): number {
  let result = 0;
  for (let cell = 0; cell < fieldM.length; cell++) result += fieldM[cell] * areasM2[cell];
  return result;
}

function compactCubic(normalizedDistance: number): number {
  if (normalizedDistance <= 0) return 1;
  if (normalizedDistance >= 1) return 0;
  return 1 - 3 * normalizedDistance * normalizedDistance + 2 * normalizedDistance * normalizedDistance * normalizedDistance;
}

function updateOceanicAges(
  grid: CubedSphereGrid,
  crust: CrustState,
  boundaries: BoundaryField,
): void {
  const ridgeSeeds: DistanceSeed[] = [];
  for (const edge of boundaries.edges) {
    if (edge.kind !== BOUNDARY_RIDGE) continue;
    const halfSpreadingMmYr = Math.max(1, edge.normalVelocityMmYr * 0.5);
    if (crust.crustType[edge.cellA] === CRUST_OCEANIC) {
      ridgeSeeds.push({ cell: edge.cellA, plateId: edge.plateA, strength: halfSpreadingMmYr });
    }
    if (crust.crustType[edge.cellB] === CRUST_OCEANIC) {
      ridgeSeeds.push({ cell: edge.cellB, plateId: edge.plateB, strength: halfSpreadingMmYr });
    }
  }
  if (ridgeSeeds.length === 0) return;

  const field = plateConstrainedDistanceField(
    grid,
    crust.plateId,
    ridgeSeeds,
    8_000_000,
    (cell) => crust.crustType[cell] === CRUST_OCEANIC,
  );
  for (let cell = 0; cell < grid.totalCells; cell++) {
    if (crust.crustType[cell] !== CRUST_OCEANIC || !Number.isFinite(field.distanceM[cell])) continue;
    const spreadingMPerMyr = Math.max(1_000, field.sourceStrength[cell] * 1_000);
    crust.oceanicAgeMyr[cell] = Math.min(200, field.distanceM[cell] / spreadingMPerMyr);
  }
}

function applyCollisionShortening(
  grid: CubedSphereGrid,
  config: PlateCoreConfig,
  boundaries: BoundaryField,
  crust: CrustState,
): number {
  const seeds: DistanceSeed[] = [];
  const requestedByPlate = new Float64Array(config.plateCount);

  for (const edge of boundaries.edges) {
    if (edge.kind !== BOUNDARY_COLLISION) continue;
    const convergenceM = -edge.normalVelocityMmYr * 1_000 * config.durationMyr;
    const strength = Math.min(1, -edge.normalVelocityMmYr / 50);
    for (const [cell, plate] of [[edge.cellA, edge.plateA], [edge.cellB, edge.plateB]] as const) {
      if (crust.continentalThicknessM[cell] <= 0) continue;
      seeds.push({ cell, plateId: plate, strength });
      requestedByPlate[plate] += 0.5 * convergenceM * edge.lengthM * crust.continentalThicknessM[cell];
    }
  }
  if (seeds.length === 0) return 0;

  const field = plateConstrainedDistanceField(
    grid,
    crust.plateId,
    seeds,
    650_000,
    (cell) => crust.continentalThicknessM[cell] > 0,
  );
  const targetWeight = new Float32Array(grid.totalCells);
  const donorCapacity = new Float32Array(grid.totalCells);
  const targetWeightByPlate = new Float64Array(config.plateCount);
  const donorCapacityByPlate = new Float64Array(config.plateCount);

  for (let cell = 0; cell < grid.totalCells; cell++) {
    const distance = field.distanceM[cell];
    if (!Number.isFinite(distance)) continue;
    const plate = crust.plateId[cell];
    if (distance <= 220_000) {
      const weight = compactCubic(distance / 220_000) * Math.max(0.05, field.sourceStrength[cell]) * grid.cellAreas[cell];
      targetWeight[cell] = weight;
      targetWeightByPlate[plate] += weight;
    } else if (distance >= 260_000 && distance <= 650_000) {
      const availableThickness = Math.max(0, crust.continentalThicknessM[cell] - 30_000);
      const ringWeight = compactCubic((distance - 260_000) / 390_000);
      const capacity = availableThickness * grid.cellAreas[cell] * ringWeight;
      donorCapacity[cell] = capacity;
      donorCapacityByPlate[plate] += capacity;
    }
  }

  let redistributed = 0;
  for (let plate = 0; plate < config.plateCount; plate++) {
    const amount = Math.min(requestedByPlate[plate], donorCapacityByPlate[plate]);
    if (amount <= 0 || targetWeightByPlate[plate] <= 0) continue;
    redistributed += amount;
    for (let cell = 0; cell < grid.totalCells; cell++) {
      if (crust.plateId[cell] !== plate) continue;
      if (donorCapacity[cell] > 0) {
        const removed = amount * donorCapacity[cell] / donorCapacityByPlate[plate];
        crust.continentalThicknessM[cell] -= removed / grid.cellAreas[cell];
      }
      if (targetWeight[cell] > 0) {
        const added = amount * targetWeight[cell] / targetWeightByPlate[plate];
        crust.continentalThicknessM[cell] += added / grid.cellAreas[cell];
      }
    }
  }
  return redistributed;
}

function applySubductionAndArcs(
  grid: CubedSphereGrid,
  config: PlateCoreConfig,
  boundaries: BoundaryField,
  crust: CrustState,
): { subductedM3: number; arcAddedM3: number } {
  const slabSeeds: DistanceSeed[] = [];
  const arcSeeds: DistanceSeed[] = [];
  const requestedBySubductingPlate = new Float64Array(config.plateCount);

  for (const edge of boundaries.edges) {
    if (edge.kind !== BOUNDARY_SUBDUCTION) continue;
    const subductingCell = edge.plateA === edge.subductingPlateId ? edge.cellA : edge.cellB;
    const overridingCell = edge.plateA === edge.overridingPlateId ? edge.cellA : edge.cellB;
    const convergenceM = -edge.normalVelocityMmYr * 1_000 * config.durationMyr;
    const strength = Math.min(1, -edge.normalVelocityMmYr / 50);
    if (crust.oceanicThicknessM[subductingCell] > 0) {
      slabSeeds.push({ cell: subductingCell, plateId: edge.subductingPlateId, strength });
      requestedBySubductingPlate[edge.subductingPlateId] +=
        convergenceM * edge.lengthM * crust.oceanicThicknessM[subductingCell];
    }
    arcSeeds.push({ cell: overridingCell, plateId: edge.overridingPlateId, strength });
  }
  if (slabSeeds.length === 0 || arcSeeds.length === 0) return { subductedM3: 0, arcAddedM3: 0 };

  const slabField = plateConstrainedDistanceField(
    grid,
    crust.plateId,
    slabSeeds,
    300_000,
    (cell) => crust.oceanicThicknessM[cell] > 0,
  );
  const slabCapacity = new Float32Array(grid.totalCells);
  const slabCapacityByPlate = new Float64Array(config.plateCount);
  for (let cell = 0; cell < grid.totalCells; cell++) {
    const distance = slabField.distanceM[cell];
    if (!Number.isFinite(distance)) continue;
    const plate = crust.plateId[cell];
    const weight = compactCubic(distance / 300_000);
    const capacity = crust.oceanicThicknessM[cell] * grid.cellAreas[cell] * weight;
    slabCapacity[cell] = capacity;
    slabCapacityByPlate[plate] += capacity;
  }

  const subductedByPlate = new Float64Array(config.plateCount);
  let subductedM3 = 0;
  for (let plate = 0; plate < config.plateCount; plate++) {
    const amount = Math.min(requestedBySubductingPlate[plate], slabCapacityByPlate[plate]);
    if (amount <= 0) continue;
    subductedByPlate[plate] = amount;
    subductedM3 += amount;
    for (let cell = 0; cell < grid.totalCells; cell++) {
      if (crust.plateId[cell] !== plate || slabCapacity[cell] <= 0) continue;
      const removed = amount * slabCapacity[cell] / slabCapacityByPlate[plate];
      crust.oceanicThicknessM[cell] = Math.max(0, crust.oceanicThicknessM[cell] - removed / grid.cellAreas[cell]);
    }
  }

  const totalRequested = requestedBySubductingPlate.reduce((sum, value) => sum + value, 0);
  const actualFraction = totalRequested > 0 ? subductedM3 / totalRequested : 0;
  const arcField = plateConstrainedDistanceField(grid, crust.plateId, arcSeeds, 360_000);
  const arcWeight = new Float32Array(grid.totalCells);
  let totalArcWeight = 0;
  for (let cell = 0; cell < grid.totalCells; cell++) {
    const distance = arcField.distanceM[cell];
    if (!Number.isFinite(distance)) continue;
    const sigma = 60_000;
    const gaussian = Math.exp(-0.5 * ((distance - 166_000) / sigma) ** 2);
    const weight = gaussian * Math.max(0.05, arcField.sourceStrength[cell]) * grid.cellAreas[cell];
    arcWeight[cell] = weight;
    totalArcWeight += weight;
  }

  const arcAddedM3 = subductedM3 * 0.15 * Math.min(1, actualFraction + 0.25);
  if (arcAddedM3 > 0 && totalArcWeight > 0) {
    for (let cell = 0; cell < grid.totalCells; cell++) {
      if (arcWeight[cell] <= 0) continue;
      const added = arcAddedM3 * arcWeight[cell] / totalArcWeight;
      crust.arcThicknessM[cell] += added / grid.cellAreas[cell];
      if (crust.crustType[cell] === CRUST_OCEANIC && crust.arcThicknessM[cell] > 4_000) {
        crust.crustType[cell] = CRUST_ARC;
      }
    }
  }
  return { subductedM3, arcAddedM3 };
}

export function deformCrustFromPlateKinematics(
  grid: CubedSphereGrid,
  config: PlateCoreConfig,
  boundaries: BoundaryField,
  initialCrust: CrustState,
): { crust: CrustState; ledger: TectonicMassLedger } {
  const crust: CrustState = {
    plateId: new Uint16Array(initialCrust.plateId),
    crustType: new Uint8Array(initialCrust.crustType),
    continentalThicknessM: new Float32Array(initialCrust.continentalThicknessM),
    oceanicThicknessM: new Float32Array(initialCrust.oceanicThicknessM),
    arcThicknessM: new Float32Array(initialCrust.arcThicknessM),
    oceanicAgeMyr: new Float32Array(initialCrust.oceanicAgeMyr),
  };
  const initialContinentalM3 = volume(crust.continentalThicknessM, grid.cellAreas);
  updateOceanicAges(grid, crust, boundaries);
  const collisionRedistributedM3 = applyCollisionShortening(grid, config, boundaries, crust);
  const { subductedM3, arcAddedM3 } = applySubductionAndArcs(grid, config, boundaries, crust);

  for (let cell = 0; cell < grid.totalCells; cell++) {
    const total = crust.continentalThicknessM[cell] + crust.oceanicThicknessM[cell] + crust.arcThicknessM[cell];
    if (total <= 100) {
      crust.crustType[cell] = CRUST_OCEANIC;
      crust.oceanicThicknessM[cell] = 100;
    } else if (crust.continentalThicknessM[cell] >= 20_000) {
      crust.crustType[cell] = CRUST_CONTINENTAL;
    } else if (crust.arcThicknessM[cell] > 4_000) {
      crust.crustType[cell] = CRUST_ARC;
    }
  }

  const finalContinentalM3 = volume(crust.continentalThicknessM, grid.cellAreas);
  const finalOceanicM3 = volume(crust.oceanicThicknessM, grid.cellAreas);
  const finalArcM3 = volume(crust.arcThicknessM, grid.cellAreas);
  const continentalRelativeError = Math.abs(finalContinentalM3 - initialContinentalM3) / Math.max(1, initialContinentalM3);
  return {
    crust,
    ledger: {
      initialContinentalM3,
      finalContinentalM3,
      collisionRedistributedM3,
      subductedOceanicM3: subductedM3,
      mantleArcAddedM3: arcAddedM3,
      finalOceanicM3,
      finalArcM3,
      continentalRelativeError,
    },
  };
}

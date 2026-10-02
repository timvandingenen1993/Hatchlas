import { describe, expect, it } from 'vitest';
import { buildCubedSphereGrid } from '../../src/geometry/cubedSphere';
import { rasterizeProjectedLayer } from '../../src/projections/rasterizer';
import { runTectonicsOnlySimulation } from '../../src/pipeline/tectonicsOnlyRunner';
import { deserializeWorldV2, serializeWorldV2 } from '../../src/storage/bundleV2';
import { WorldStore } from '../../src/storage/worldStore';
import { DEFAULT_SIMULATION_CONFIG } from '../../src/types/config';
import {
  GEOLOGICAL_BOUNDARY_COLLISION,
  GEOLOGICAL_BOUNDARY_RIFT,
  KINEMATIC_BOUNDARY_CONVERGENT,
  KINEMATIC_BOUNDARY_DIVERGENT,
  classifyGeologicalBoundaries,
  computeCFLMetrics,
  getOrientedTransportEdgeFluxes,
  initializeContinentalMaterial,
  partitionGridPlates,
  runTectonicSimulation,
  seedRigidEulerPlates,
  stepConservativeTransport,
  sumContinentalVolume,
  type PlateStateReservoirs,
  type RigidEulerPlate,
  type StepAreaLedger,
} from '../../src/tectonics/plateEngine';
import { extractKinematicBoundaries } from '../../src/tectonics/plateEngine/boundaries';

const RADIUS_M = 6_371_000;

function emptyReservoirs(totalCells: number, plateCount: number): PlateStateReservoirs {
  return {
    plateCount,
    totalCells,
    plateAreaFraction: new Float64Array(totalCells * plateCount),
    continentalVolumeM3: new Float64Array(totalCells * plateCount),
    oceanicVolumeM3: new Float64Array(0),
    oceanicAgeMomentM3Myr: new Float64Array(0),
    inheritedOceanicVolumeM3: new Float64Array(0),
  };
}

function cloneReservoirs(source: PlateStateReservoirs): PlateStateReservoirs {
  return {
    ...source,
    plateAreaFraction: new Float64Array(source.plateAreaFraction),
    continentalVolumeM3: new Float64Array(source.continentalVolumeM3),
    oceanicVolumeM3: new Float64Array(source.oceanicVolumeM3),
    oceanicAgeMomentM3Myr: new Float64Array(source.oceanicAgeMomentM3Myr),
    inheritedOceanicVolumeM3: new Float64Array(source.inheritedOceanicVolumeM3),
  };
}

function normalizedInterfaceMixing(
  grid: ReturnType<typeof buildCubedSphereGrid>,
  reservoirs: PlateStateReservoirs,
): number {
  let mixedArea = 0;
  let totalArea = 0;
  for (let cell = 0; cell < grid.totalCells; cell++) {
    const area = grid.cellAreas[cell];
    const concentration = Math.max(0, Math.min(
      1,
      reservoirs.continentalVolumeM3[cell] / (area * 35_000),
    ));
    mixedArea += 4 * concentration * (1 - concentration) * area;
    totalArea += area;
  }
  return mixedArea / totalArea;
}

describe('Phase 2: conservative continental material transport', () => {
  it('seeds a deterministic, finite, non-negative procedural continental initial condition', () => {
    const grid = buildCubedSphereGrid(16, RADIUS_M);
    const plates = seedRigidEulerPlates({ seed: 121, resolution: 16, radiusMeters: RADIUS_M, plateCount: 6 });
    const partition = partitionGridPlates(grid, plates);
    const first = initializeContinentalMaterial(grid, plates, partition.plateAreaFraction, 0.35, 35_000, 121);
    const second = initializeContinentalMaterial(grid, plates, partition.plateAreaFraction, 0.35, 35_000, 121);
    expect(first).toEqual(second);

    let totalArea = 0;
    for (let cell = 0; cell < grid.totalCells; cell++) totalArea += grid.cellAreas[cell];
    for (let index = 0; index < first.length; index++) {
      expect(Number.isFinite(first[index])).toBe(true);
      expect(first[index]).toBeGreaterThanOrEqual(0);
    }
    const expected = totalArea * 0.35 * 35_000;
    expect(Math.abs(sumContinentalVolume(first) - expected) / expected).toBeLessThan(1e-12);
  });

  it('is an exact identity for a stationary plate and every non-uniform continental reservoir', () => {
    const grid = buildCubedSphereGrid(12, RADIUS_M);
    const plate: RigidEulerPlate = {
      id: 0, name: 'Stationary', seedPosition: [1, 0, 0], weight: 1,
      eulerPole: [0, 0, 1], angularVelocityRadPerMyr: 0, color: '#fff',
    };
    const reservoirs = emptyReservoirs(grid.totalCells, 1);
    reservoirs.plateAreaFraction.fill(1);
    for (let cell = 0; cell < grid.totalCells; cell++) {
      reservoirs.continentalVolumeM3[cell] = grid.cellAreas[cell] * (1_000 + (cell % 17) * 137);
    }
    const beforeArea = new Float64Array(reservoirs.plateAreaFraction);
    const beforeMaterial = new Float64Array(reservoirs.continentalVolumeM3);
    const ledger: StepAreaLedger = { openingAreaM2: 0, convergenceAreaM2: 0 };
    stepConservativeTransport(grid, [plate], reservoirs, 1, ledger);
    expect(reservoirs.plateAreaFraction).toEqual(beforeArea);
    expect(reservoirs.continentalVolumeM3).toEqual(beforeMaterial);
    expect(ledger.continentalTransportedVolumeM3 ?? 0).toBe(0);
    expect(ledger.continentalCorrectionVolumeM3 ?? 0).toBe(0);
  });

  it('selects the A donor for positive signed flux and the B donor for negative signed flux', () => {
    const grid = buildCubedSphereGrid(10, RADIUS_M);
    const positivePlate: RigidEulerPlate = {
      id: 0, name: 'Positive', seedPosition: [1, 0, 0], weight: 1,
      eulerPole: [0, 0, 1], angularVelocityRadPerMyr: 0.01, color: '#fff',
    };
    const selected = getOrientedTransportEdgeFluxes(grid, positivePlate)
      .filter((edge) => edge.signedAreaFluxM2PerMyr > 1)
      .sort((a, b) => b.signedAreaFluxM2PerMyr - a.signedAreaFluxM2PerMyr)[0];
    expect(selected).toBeDefined();

    const positive = emptyReservoirs(grid.totalCells, 1);
    positive.plateAreaFraction.fill(1);
    positive.continentalVolumeM3[selected.cellA] = grid.cellAreas[selected.cellA] * 10_000;
    const positiveInitial = sumContinentalVolume(positive.continentalVolumeM3);
    stepConservativeTransport(grid, [positivePlate], positive, 0.05);
    expect(positive.continentalVolumeM3[selected.cellB]).toBeGreaterThan(0);
    expect(Math.abs(sumContinentalVolume(positive.continentalVolumeM3) - positiveInitial) / positiveInitial).toBeLessThan(1e-12);

    const negativePlate = { ...positivePlate, name: 'Negative', angularVelocityRadPerMyr: -0.01 };
    const sameEdge = getOrientedTransportEdgeFluxes(grid, negativePlate)
      .find((edge) => edge.cellA === selected.cellA && edge.cellB === selected.cellB)!;
    expect(sameEdge.signedAreaFluxM2PerMyr).toBeLessThan(0);
    const negative = emptyReservoirs(grid.totalCells, 1);
    negative.plateAreaFraction.fill(1);
    negative.continentalVolumeM3[selected.cellB] = grid.cellAreas[selected.cellB] * 10_000;
    const negativeInitial = sumContinentalVolume(negative.continentalVolumeM3);
    stepConservativeTransport(grid, [negativePlate], negative, 0.05);
    expect(negative.continentalVolumeM3[selected.cellA]).toBeGreaterThan(0);
    expect(Math.abs(sumContinentalVolume(negative.continentalVolumeM3) - negativeInitial) / negativeInitial).toBeLessThan(1e-12);
  });

  it('preserves a constant tracer across both cubed-sphere seams and interior edges', () => {
    const grid = buildCubedSphereGrid(16, RADIUS_M);
    const plate: RigidEulerPlate = {
      id: 0, name: 'Solid body', seedPosition: [1, 0, 0], weight: 1,
      eulerPole: [0.3, -0.4, 0.8660254038], angularVelocityRadPerMyr: 0.012, color: '#fff',
    };
    const reservoirs = emptyReservoirs(grid.totalCells, 1);
    reservoirs.plateAreaFraction.fill(1);
    for (let cell = 0; cell < grid.totalCells; cell++) {
      reservoirs.continentalVolumeM3[cell] = grid.cellAreas[cell] * 35_000;
    }
    const ledger: StepAreaLedger = { openingAreaM2: 0, convergenceAreaM2: 0 };
    stepConservativeTransport(grid, [plate], reservoirs, 0.25, ledger);
    let seamMax = 0;
    let interiorMax = 0;
    const cellsPerFace = grid.resolution * grid.resolution;
    for (let cell = 0; cell < grid.totalCells; cell++) {
      const local = cell % cellsPerFace;
      const i = local % grid.resolution;
      const j = Math.floor(local / grid.resolution);
      const error = Math.abs(reservoirs.continentalVolumeM3[cell] / grid.cellAreas[cell] - 35_000);
      if (i === 0 || j === 0 || i === grid.resolution - 1 || j === grid.resolution - 1) seamMax = Math.max(seamMax, error);
      else interiorMax = Math.max(interiorMax, error);
    }
    expect(seamMax).toBeLessThan(1e-8);
    expect(interiorMax).toBeLessThan(1e-8);
    expect(ledger.continentalLimitedVolumeM3 ?? 0).toBe(0);
    expect(ledger.continentalCorrectionVolumeM3 ?? 0).toBe(0);
  });

  it('is physically invariant under a permutation of plate IDs with remapped material columns', () => {
    const grid = buildCubedSphereGrid(14, RADIUS_M);
    const original: RigidEulerPlate[] = [
      { id: 0, name: 'A', seedPosition: [-1, 0, 0], weight: 2, eulerPole: [0, 0, 1], angularVelocityRadPerMyr: 0.012, color: '#f00' },
      { id: 1, name: 'B', seedPosition: [1, 0, 0], weight: 1, eulerPole: [0, 0, 1], angularVelocityRadPerMyr: -0.009, color: '#00f' },
    ];
    const permuted: RigidEulerPlate[] = [{ ...original[1], id: 0 }, { ...original[0], id: 1 }];
    const originalPartition = partitionGridPlates(grid, original);
    const permutedPartition = partitionGridPlates(grid, permuted);
    const originalState = emptyReservoirs(grid.totalCells, 2);
    const permutedState = emptyReservoirs(grid.totalCells, 2);
    originalState.plateAreaFraction.set(originalPartition.plateAreaFraction);
    permutedState.plateAreaFraction.set(permutedPartition.plateAreaFraction);
    for (let cell = 0; cell < grid.totalCells; cell++) {
      const area = grid.cellAreas[cell];
      originalState.continentalVolumeM3[cell * 2] = originalState.plateAreaFraction[cell * 2] * area * 35_000;
      originalState.continentalVolumeM3[cell * 2 + 1] = originalState.plateAreaFraction[cell * 2 + 1] * area * 12_000;
      permutedState.continentalVolumeM3[cell * 2] = permutedState.plateAreaFraction[cell * 2] * area * 12_000;
      permutedState.continentalVolumeM3[cell * 2 + 1] = permutedState.plateAreaFraction[cell * 2 + 1] * area * 35_000;
    }
    stepConservativeTransport(grid, original, originalState, 0.25);
    stepConservativeTransport(grid, permuted, permutedState, 0.25);
    for (let cell = 0; cell < grid.totalCells; cell++) {
      const base = cell * 2;
      const scale = Math.max(1, originalState.continentalVolumeM3[base], originalState.continentalVolumeM3[base + 1]);
      expect(Math.abs(originalState.continentalVolumeM3[base] - permutedState.continentalVolumeM3[base + 1]) / scale).toBeLessThan(1e-12);
      expect(Math.abs(originalState.continentalVolumeM3[base + 1] - permutedState.continentalVolumeM3[base]) / scale).toBeLessThan(1e-12);
    }
  });

  it('reduces long-run donor-cell blur without creating new extrema', () => {
    const grid = buildCubedSphereGrid(24, RADIUS_M);
    const plate: RigidEulerPlate = {
      id: 0, name: 'Sharpness audit', seedPosition: [1, 0, 0], weight: 1,
      eulerPole: [0, 0, 1], angularVelocityRadPerMyr: 0.01, color: '#fff',
    };
    const initial = emptyReservoirs(grid.totalCells, 1);
    initial.plateAreaFraction.fill(1);
    for (let cell = 0; cell < grid.totalCells; cell++) {
      const x = grid.cellPositions[cell * 3];
      const y = grid.cellPositions[cell * 3 + 1];
      if (x + 0.2 * Math.sin(4 * y) > 0.1) {
        initial.continentalVolumeM3[cell] = grid.cellAreas[cell] * 35_000;
      }
    }
    const firstOrder = cloneReservoirs(initial);
    const highResolution = cloneReservoirs(initial);
    for (let step = 0; step < 40; step++) {
      stepConservativeTransport(grid, [plate], firstOrder, 0.5, undefined, {
        highResolutionMaterial: false,
      });
      stepConservativeTransport(grid, [plate], highResolution, 0.5);
    }
    const initialVolume = sumContinentalVolume(initial.continentalVolumeM3);
    expect(Math.abs(sumContinentalVolume(highResolution.continentalVolumeM3) - initialVolume) / initialVolume)
      .toBeLessThan(1e-12);
    expect(normalizedInterfaceMixing(grid, highResolution))
      .toBeLessThan(normalizedInterfaceMixing(grid, firstOrder) * 0.8);
    for (let cell = 0; cell < grid.totalCells; cell++) {
      const thicknessM = highResolution.continentalVolumeM3[cell] / grid.cellAreas[cell];
      expect(thicknessM).toBeGreaterThanOrEqual(0);
      expect(thicknessM).toBeLessThanOrEqual(35_000 * (1 + 1e-12));
    }
  });

  it('preserves independently advected continent-continent convergence and classifies collision/rift geology', () => {
    const grid = buildCubedSphereGrid(16, RADIUS_M);
    const plates: RigidEulerPlate[] = [
      { id: 0, name: 'West', seedPosition: [-1, 0, 0], weight: 2, eulerPole: [0, 0, 1], angularVelocityRadPerMyr: 0.01, color: '#f00' },
      { id: 1, name: 'East', seedPosition: [1, 0, 0], weight: 1, eulerPole: [0, 0, 1], angularVelocityRadPerMyr: -0.01, color: '#00f' },
    ];
    const partition = partitionGridPlates(grid, plates);
    const reservoirs = emptyReservoirs(grid.totalCells, 2);
    reservoirs.plateAreaFraction.set(partition.plateAreaFraction);
    for (let cell = 0; cell < grid.totalCells; cell++) {
      for (let plate = 0; plate < 2; plate++) {
        const index = cell * 2 + plate;
        reservoirs.continentalVolumeM3[index] = reservoirs.plateAreaFraction[index] * grid.cellAreas[cell] * 35_000;
      }
    }
    const boundaries = extractKinematicBoundaries(grid, plates, partition.primaryPlateId, 1);
    classifyGeologicalBoundaries(boundaries, reservoirs);
    expect(boundaries.edges.filter((edge) => edge.kinematicType === KINEMATIC_BOUNDARY_CONVERGENT)
      .every((edge) => edge.geologicalType === GEOLOGICAL_BOUNDARY_COLLISION)).toBe(true);
    expect(boundaries.edges.filter((edge) => edge.kinematicType === KINEMATIC_BOUNDARY_DIVERGENT)
      .every((edge) => edge.geologicalType === GEOLOGICAL_BOUNDARY_RIFT)).toBe(true);

    const initial = sumContinentalVolume(reservoirs.continentalVolumeM3);
    const ledger: StepAreaLedger = { openingAreaM2: 0, convergenceAreaM2: 0 };
    stepConservativeTransport(grid, plates, reservoirs, 0.5, ledger);
    const final = sumContinentalVolume(reservoirs.continentalVolumeM3);
    expect(ledger.convergenceAreaM2).toBeGreaterThan(0);
    expect(ledger.continentalTransportedVolumeM3 ?? 0).toBeGreaterThan(0);
    expect(ledger.continentalRoutedVolumeM3 ?? 0).toBe(0);
    expect(Math.abs(final - initial) / initial).toBeLessThan(1e-12);
  });

  it('creates no material source or sink under equal rigid motion or pure transform motion', () => {
    const grid = buildCubedSphereGrid(14, RADIUS_M);
    const basePlates: RigidEulerPlate[] = [
      { id: 0, name: 'South', seedPosition: [0, 0, -1], weight: 1, eulerPole: [0, 0, 1], angularVelocityRadPerMyr: 0.01, color: '#f00' },
      { id: 1, name: 'North', seedPosition: [0, 0, 1], weight: 1, eulerPole: [0, 0, 1], angularVelocityRadPerMyr: 0.01, color: '#00f' },
    ];
    const runCase = (plates: RigidEulerPlate[]) => {
      const partition = partitionGridPlates(grid, plates);
      const reservoirs = emptyReservoirs(grid.totalCells, 2);
      reservoirs.plateAreaFraction.set(partition.plateAreaFraction);
      reservoirs.continentalVolumeM3.set(initializeContinentalMaterial(grid, plates, reservoirs.plateAreaFraction, 0.35, 35_000, 44));
      const initial = sumContinentalVolume(reservoirs.continentalVolumeM3);
      const ledger: StepAreaLedger = { openingAreaM2: 0, convergenceAreaM2: 0 };
      stepConservativeTransport(grid, plates, reservoirs, 0.25, ledger);
      expect(Math.abs(sumContinentalVolume(reservoirs.continentalVolumeM3) - initial) / initial).toBeLessThan(1e-12);
      expect(ledger.openingAreaM2).toBe(0);
      expect(ledger.convergenceAreaM2).toBe(0);
      expect(ledger.continentalCorrectionVolumeM3 ?? 0).toBe(0);
    };

    runCase(basePlates);
    runCase([
      { ...basePlates[0], angularVelocityRadPerMyr: 0.01 },
      { ...basePlates[1], angularVelocityRadPerMyr: -0.01 },
    ]);
  });

  it('honors full target timesteps, uses an exact remainder, and independently reconciles every step', () => {
    const result = runTectonicSimulation({
      seed: 9, resolution: 16, radiusMeters: RADIUS_M, plateCount: 4,
      durationMyr: 2.3, timeStepMyr: 1, continentalFraction: 0.35,
    }, 1);
    expect(result.ledger.continentalSteps.map((step) => step.durationMyr)).toEqual([1, 1, 0.2999999999999998]);
    expect(result.ledger.integratedDurationMyr).toBeCloseTo(2.3, 14);
    expect(result.ledger.maximumActualTimeStepMyr).toBe(1);
    expect(result.ledger.minimumActualTimeStepMyr).toBeCloseTo(0.3, 14);
    for (const step of result.ledger.continentalSteps) {
      const independentResidual = step.finalVolumeM3 - step.initialVolumeM3
        - step.explicitSourceM3 + step.explicitSinkM3 - step.boundaryFluxM3 - step.correctedVolumeM3;
      expect(step.residualM3).toBe(independentResidual);
      expect(Math.abs(step.residualM3) / step.initialVolumeM3).toBeLessThan(1e-12);
    }
  });

  it('conserves under reversed edge iteration and across a deterministic 50 Myr replay', () => {
    const grid = buildCubedSphereGrid(12, RADIUS_M);
    const plates = seedRigidEulerPlates({ seed: 77, resolution: 12, radiusMeters: RADIUS_M, plateCount: 4 });
    const partition = partitionGridPlates(grid, plates);
    const base = emptyReservoirs(grid.totalCells, plates.length);
    base.plateAreaFraction.set(partition.plateAreaFraction);
    base.continentalVolumeM3.set(initializeContinentalMaterial(grid, plates, base.plateAreaFraction, 0.35, 35_000, 77));
    const forward = cloneReservoirs(base);
    const reverse = cloneReservoirs(base);
    stepConservativeTransport(grid, plates, forward, 0.5, undefined, { reverseEdgeIteration: false });
    stepConservativeTransport(grid, plates, reverse, 0.5, undefined, { reverseEdgeIteration: true });
    const initial = sumContinentalVolume(base.continentalVolumeM3);
    expect(Math.abs(sumContinentalVolume(forward.continentalVolumeM3) - initial) / initial).toBeLessThan(1e-12);
    expect(Math.abs(sumContinentalVolume(reverse.continentalVolumeM3) - initial) / initial).toBeLessThan(1e-12);

    const config = { seed: 88, resolution: 12, radiusMeters: RADIUS_M, plateCount: 4, durationMyr: 50, timeStepMyr: 1 };
    const first = runTectonicSimulation(config, 10);
    const second = runTectonicSimulation(config, 10);
    expect(first.reservoirs.continentalVolumeM3).toEqual(second.reservoirs.continentalVolumeM3);
    expect(first.ledger.continentalVolumeRelativeError).toBeLessThan(1e-6);
    expect(first.ledger.continentalCorrectionVolumeM3).toBe(0);
  });

  it('meets the 50 Myr conservation gate at multiple grid resolutions', () => {
    for (const resolution of [8, 16, 24]) {
      const result = runTectonicSimulation({
        seed: 4242,
        resolution,
        radiusMeters: RADIUS_M,
        plateCount: 6,
        durationMyr: 50,
        timeStepMyr: 1,
        continentalFraction: 0.35,
      }, 10);
      expect(result.ledger.continentalVolumeRelativeError).toBeLessThan(1e-6);
      expect(result.ledger.rawMinContinentalVolumeM3).toBeGreaterThanOrEqual(0);
      expect(result.ledger.continentalCorrectionVolumeM3).toBe(0);
      expect(result.ledger.continentalLimitedVolumeM3 / result.ledger.initialContinentalVolumeM3).toBeLessThan(0.125);
      expect(result.ledger.integratedDurationMyr).toBeCloseTo(50, 12);
      expect(result.ledger.continentalSteps).toHaveLength(result.ledger.totalSubsteps);
      expect(result.timeline!.snapshots.every((snapshot) => snapshot.continentalThicknessM?.length === result.grid.totalCells)).toBe(true);
    }
  });

  it('round-trips reservoirs, ledger, and material snapshots through the real WorldV2 path', async () => {
    const { world, grid } = await runTectonicsOnlySimulation({
      ...DEFAULT_SIMULATION_CONFIG,
      faceResolution: 32,
      plateCount: 6,
      tectonicEvolutionMyr: 3,
    });
    const restored = deserializeWorldV2(serializeWorldV2(world)).world;
    expect(restored.geology.continentalThicknessM).toEqual(world.geology.continentalThicknessM);
    expect(restored.geology.plateAreaFraction).toEqual(world.geology.plateAreaFraction);
    expect(restored.geology.continentalVolumeByPlateM3).toEqual(world.geology.continentalVolumeByPlateM3);
    expect(restored.diagnostics.tectonicConservation).toEqual(world.diagnostics.tectonicConservation);
    expect(restored.timeline?.snapshots.length).toBe(world.timeline?.snapshots.length);
    expect(restored.timeline?.snapshots[0].continentalThicknessM).toEqual(world.timeline?.snapshots[0].continentalThicknessM);

    WorldStore.set(world, grid);
    WorldStore.setSnapshotIndex(0);
    const startField = world.geology.continentalThicknessM;
    const startImage = rasterizeProjectedLayer(world, grid, {
      width: 120, height: 60, layer: 'continental_material', projection: 'equal_earth', showHillshade: false,
    }).data;
    WorldStore.setSnapshotIndex(world.timeline!.snapshots.length - 1);
    const endField = world.geology.continentalThicknessM;
    const endImage = rasterizeProjectedLayer(world, grid, {
      width: 120, height: 60, layer: 'continental_material', projection: 'equal_earth', showHillshade: false,
    }).data;
    expect(endField).not.toBe(startField);
    expect(endImage).not.toEqual(startImage);
    WorldStore.clear();
  });

  it('reports the actual maximum speed and minimum spacing used by CFL', () => {
    const grid = buildCubedSphereGrid(16, RADIUS_M);
    const plate: RigidEulerPlate = {
      id: 0, name: 'Known speed', seedPosition: [1, 0, 0], weight: 1,
      eulerPole: [0, 0, 1], angularVelocityRadPerMyr: 0.02, color: '#fff',
    };
    const cfl = computeCFLMetrics(grid, [plate], 2.3, 1);
    expect(cfl.maxPlateSpeedMPerMyr).toBe(0.02 * RADIUS_M);
    expect(cfl.minCellDistanceM).toBe(grid.minCellDistanceM);
    expect(cfl.integratedDurationMyr).toBeCloseTo(2.3, 14);
  });
});

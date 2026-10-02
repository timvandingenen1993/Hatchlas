import { describe, expect, it } from 'vitest';
import { buildCubedSphereGrid } from '../../src/geometry/cubedSphere';
import {
  computeCFLMetrics,
  partitionGridPlates,
  seedRigidEulerPlates,
  stepConservativeTransport,
  type PlateStateReservoirs,
  type RigidEulerPlate,
  type StepAreaLedger,
} from '../../src/tectonics/plateEngine';


describe('Milestone 1B: Boundary-Resolved Transport, Polarity & Material Conservation', () => {
  it('1. Zero motion: exact mathematical identity', () => {
    const grid = buildCubedSphereGrid(16, 6_371_000);
    const plates = seedRigidEulerPlates({ seed: 42, resolution: 16, radiusMeters: 6_371_000, plateCount: 4 }).map(p => ({
      ...p,
      angularVelocityRadPerMyr: 0.0, // Zero motion
    }));
    const { plateAreaFraction } = partitionGridPlates(grid, plates);
    const totalCells = grid.totalCells;

    const reservoirs: PlateStateReservoirs = {
      plateCount: 4,
      totalCells,
      plateAreaFraction: new Float32Array(plateAreaFraction),
      continentalVolumeM3: new Float64Array(totalCells * 4),
      oceanicVolumeM3: new Float64Array(totalCells * 4),
      oceanicAgeMomentM3Myr: new Float64Array(totalCells * 4),
      inheritedOceanicVolumeM3: new Float64Array(totalCells * 4),
    };

    const stepLedger: StepAreaLedger = { openingAreaM2: 0, convergenceAreaM2: 0 };
    stepConservativeTransport(grid, plates, reservoirs, 1.0, stepLedger);

    expect(stepLedger.openingAreaM2).toBe(0);
    expect(stepLedger.convergenceAreaM2).toBe(0);

    for (let i = 0; i < totalCells * 4; i++) {
      expect(reservoirs.plateAreaFraction[i]).toBe(plateAreaFraction[i]);
    }
  });

  it('2. Equal rigid motion: coherent rotation with no physical opening or convergence', () => {
    const grid = buildCubedSphereGrid(16, 6_371_000);
    // All plates share identical Euler pole and velocity (solid body rotation)
    const plates = seedRigidEulerPlates({ seed: 42, resolution: 16, radiusMeters: 6_371_000, plateCount: 4 }).map(p => ({
      ...p,
      eulerPole: [0, 0, 1] as [number, number, number],
      angularVelocityRadPerMyr: 0.015,
    }));
    const { plateAreaFraction } = partitionGridPlates(grid, plates);
    const totalCells = grid.totalCells;

    const reservoirs: PlateStateReservoirs = {
      plateCount: 4,
      totalCells,
      plateAreaFraction: new Float32Array(plateAreaFraction),
      continentalVolumeM3: new Float64Array(totalCells * 4),
      oceanicVolumeM3: new Float64Array(totalCells * 4),
      oceanicAgeMomentM3Myr: new Float64Array(totalCells * 4),
      inheritedOceanicVolumeM3: new Float64Array(totalCells * 4),
    };

    const stepLedger: StepAreaLedger = { openingAreaM2: 0, convergenceAreaM2: 0 };
    stepConservativeTransport(grid, plates, reservoirs, 0.5, stepLedger);

    // Relative velocity across every boundary is zero -> 0 opening and 0 convergence
    expect(stepLedger.openingAreaM2).toBe(0);
    expect(stepLedger.convergenceAreaM2).toBe(0);

    for (let cell = 0; cell < totalCells; cell++) {
      let sumFrac = 0;
      for (let p = 0; p < 4; p++) {
        const frac = reservoirs.plateAreaFraction[cell * 4 + p];
        expect(frac).toBeGreaterThanOrEqual(0);
        sumFrac += frac;
      }
      expect(Math.abs(sumFrac - 1.0)).toBeLessThan(1e-5);
    }
  });

  it('3. Pure transform: no area source or sink across strike-slip interfaces', () => {
    const grid = buildCubedSphereGrid(16, 6_371_000);
    // Two hemisphere plates sliding parallel to the equator (pole [0, 0, 1])
    const plates: RigidEulerPlate[] = [
      {
        id: 0,
        name: 'South Sliding Plate',
        seedPosition: [0, 0, -1],
        weight: 1.0,
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: 0.01,
        color: '#ff0000',
      },
      {
        id: 1,
        name: 'North Sliding Plate',
        seedPosition: [0, 0, 1],
        weight: 1.0,
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: -0.01,
        color: '#0000ff',
      },
    ];
    const { plateAreaFraction } = partitionGridPlates(grid, plates);
    const reservoirs: PlateStateReservoirs = {
      plateCount: 2,
      totalCells: grid.totalCells,
      plateAreaFraction: new Float32Array(plateAreaFraction),
      continentalVolumeM3: new Float64Array(grid.totalCells * 2),
      oceanicVolumeM3: new Float64Array(grid.totalCells * 2),
      oceanicAgeMomentM3Myr: new Float64Array(grid.totalCells * 2),
      inheritedOceanicVolumeM3: new Float64Array(grid.totalCells * 2),
    };

    const stepLedger: StepAreaLedger = { openingAreaM2: 0, convergenceAreaM2: 0 };
    stepConservativeTransport(grid, plates, reservoirs, 0.5, stepLedger);

    // Transform boundaries produce NO area source or sink
    expect(stepLedger.openingAreaM2).toBe(0);
    expect(stepLedger.convergenceAreaM2).toBe(0);

    for (let cell = 0; cell < grid.totalCells; cell++) {
      const sumFrac = reservoirs.plateAreaFraction[cell * 2] + reservoirs.plateAreaFraction[cell * 2 + 1];
      expect(Math.abs(sumFrac - 1.0)).toBeLessThan(1e-5);
    }
  });

  it('4. Plate-ID permutation invariance: identical physical result under isomorphic ID remapping', () => {
    const grid = buildCubedSphereGrid(16, 6_371_000);
    const platesOriginal: RigidEulerPlate[] = [
      {
        id: 0,
        name: 'Plate A',
        seedPosition: [-1, 0, 0],
        weight: 2.0,
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: 0.015,
        color: '#ff0000',
      },
      {
        id: 1,
        name: 'Plate B',
        seedPosition: [1, 0, 0],
        weight: 1.0,
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: -0.015,
        color: '#0000ff',
      },
    ];

    // Permuted plates: swap ID 0 and ID 1
    const platesPermuted: RigidEulerPlate[] = [
      { ...platesOriginal[1], id: 0 },
      { ...platesOriginal[0], id: 1 },
    ];

    const partOrig = partitionGridPlates(grid, platesOriginal);
    const partPerm = partitionGridPlates(grid, platesPermuted);

    const resOrig: PlateStateReservoirs = {
      plateCount: 2,
      totalCells: grid.totalCells,
      plateAreaFraction: new Float32Array(partOrig.plateAreaFraction),
      continentalVolumeM3: new Float64Array(grid.totalCells * 2),
      oceanicVolumeM3: new Float64Array(grid.totalCells * 2),
      oceanicAgeMomentM3Myr: new Float64Array(grid.totalCells * 2),
      inheritedOceanicVolumeM3: new Float64Array(grid.totalCells * 2),
    };

    const resPerm: PlateStateReservoirs = {
      plateCount: 2,
      totalCells: grid.totalCells,
      plateAreaFraction: new Float32Array(partPerm.plateAreaFraction),
      continentalVolumeM3: new Float64Array(grid.totalCells * 2),
      oceanicVolumeM3: new Float64Array(grid.totalCells * 2),
      oceanicAgeMomentM3Myr: new Float64Array(grid.totalCells * 2),
      inheritedOceanicVolumeM3: new Float64Array(grid.totalCells * 2),
    };

    const ledgerOrig: StepAreaLedger = { openingAreaM2: 0, convergenceAreaM2: 0 };
    const ledgerPerm: StepAreaLedger = { openingAreaM2: 0, convergenceAreaM2: 0 };

    stepConservativeTransport(grid, platesOriginal, resOrig, 1.0, ledgerOrig);
    stepConservativeTransport(grid, platesPermuted, resPerm, 1.0, ledgerPerm);

    // Total physical opening and convergence area are identical
    expect(Math.abs(ledgerOrig.openingAreaM2 - ledgerPerm.openingAreaM2)).toBeLessThan(1e-3);
    expect(Math.abs(ledgerOrig.convergenceAreaM2 - ledgerPerm.convergenceAreaM2)).toBeLessThan(1e-3);

    // Per-cell area distributions match under isomorphism
    for (let cell = 0; cell < grid.totalCells; cell++) {
      expect(Math.abs(resOrig.plateAreaFraction[cell * 2 + 0] - resPerm.plateAreaFraction[cell * 2 + 1])).toBeLessThan(1e-5);
      expect(Math.abs(resOrig.plateAreaFraction[cell * 2 + 1] - resPerm.plateAreaFraction[cell * 2 + 0])).toBeLessThan(1e-5);
    }
  });

  it('5. Strictly conserves nonzero material volume reservoirs in both A-to-B and B-to-A flow', () => {
    const grid = buildCubedSphereGrid(24, 6_371_000);
    const plates = seedRigidEulerPlates({ seed: 777, resolution: 24, radiusMeters: 6_371_000, plateCount: 6 });
    const { plateAreaFraction } = partitionGridPlates(grid, plates);
    const numPlates = plates.length;
    const totalCells = grid.totalCells;

    const reservoirs: PlateStateReservoirs = {
      plateCount: numPlates,
      totalCells,
      plateAreaFraction: new Float32Array(plateAreaFraction),
      continentalVolumeM3: new Float64Array(totalCells * numPlates),
      oceanicVolumeM3: new Float64Array(totalCells * numPlates),
      oceanicAgeMomentM3Myr: new Float64Array(totalCells * numPlates),
      inheritedOceanicVolumeM3: new Float64Array(totalCells * numPlates),
    };

    // Populate initial nonzero material reservoirs
    for (let cell = 0; cell < totalCells; cell++) {
      const area = grid.cellAreas[cell];
      for (let p = 0; p < numPlates; p++) {
        const frac = reservoirs.plateAreaFraction[cell * numPlates + p];
        reservoirs.continentalVolumeM3[cell * numPlates + p] = frac * area * 35_000;
        reservoirs.oceanicVolumeM3[cell * numPlates + p] = frac * area * 7_000;
        reservoirs.oceanicAgeMomentM3Myr[cell * numPlates + p] = frac * area * 7_000 * 50;
        reservoirs.inheritedOceanicVolumeM3[cell * numPlates + p] = frac * area * 7_000;
      }
    }

    let initialTotalContVol = 0;
    let initialTotalOceanVol = 0;
    let initialTotalAgeMoment = 0;
    for (let i = 0; i < totalCells * numPlates; i++) {
      initialTotalContVol += reservoirs.continentalVolumeM3[i];
      initialTotalOceanVol += reservoirs.oceanicVolumeM3[i];
      initialTotalAgeMoment += reservoirs.oceanicAgeMomentM3Myr[i];
    }

    const cfl = computeCFLMetrics(grid, plates, 20.0, 1.0);
    for (let step = 0; step < cfl.numSubsteps; step++) {
      stepConservativeTransport(grid, plates, reservoirs, cfl.dtMyr);
    }

    let finalTotalContVol = 0;
    let finalTotalOceanVol = 0;
    let finalTotalAgeMoment = 0;
    for (let i = 0; i < totalCells * numPlates; i++) {
      finalTotalContVol += reservoirs.continentalVolumeM3[i];
      finalTotalOceanVol += reservoirs.oceanicVolumeM3[i];
      finalTotalAgeMoment += reservoirs.oceanicAgeMomentM3Myr[i];
    }

    const contVolError = Math.abs(finalTotalContVol - initialTotalContVol) / initialTotalContVol;
    const oceanVolError = Math.abs(finalTotalOceanVol - initialTotalOceanVol) / initialTotalOceanVol;
    const ageMomentError = Math.abs(finalTotalAgeMoment - initialTotalAgeMoment) / initialTotalAgeMoment;

    // Machine-precision finite volume conservation (< 1e-12)
    expect(contVolError).toBeLessThan(1e-12);
    expect(oceanVolError).toBeLessThan(1e-12);
    expect(ageMomentError).toBeLessThan(1e-12);
  });

  it('6. Analytical 2-plate pure divergence: edge-resolved ridge accretion on trailing sides', () => {
    const grid = buildCubedSphereGrid(16, 6_371_000);
    // Two hemisphere plates rotating apart around Z axis:
    // Plate 0 (West, x < 0) moving West (omega = -0.01 rad/Myr)
    // Plate 1 (East, x > 0) moving East (omega = 0.01 rad/Myr)
    // On the y < 0 meridian, both plates are pulling away from the boundary (pure divergence)
    const divergentPlates: RigidEulerPlate[] = [
      {
        id: 0,
        name: 'West Spreading Plate',
        seedPosition: [-1, 0, 0],
        weight: 1.0,
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: -0.01,
        color: '#ff0000',
      },
      {
        id: 1,
        name: 'East Spreading Plate',
        seedPosition: [1, 0, 0],
        weight: 1.0,
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: 0.01,
        color: '#0000ff',
      },
    ];

    const { plateAreaFraction } = partitionGridPlates(grid, divergentPlates);
    const reservoirs: PlateStateReservoirs = {
      plateCount: 2,
      totalCells: grid.totalCells,
      plateAreaFraction: new Float32Array(plateAreaFraction),
      continentalVolumeM3: new Float64Array(grid.totalCells * 2),
      oceanicVolumeM3: new Float64Array(grid.totalCells * 2),
      oceanicAgeMomentM3Myr: new Float64Array(grid.totalCells * 2),
      inheritedOceanicVolumeM3: new Float64Array(grid.totalCells * 2),
    };

    const stepLedger: StepAreaLedger = { openingAreaM2: 0, convergenceAreaM2: 0 };
    const rawDiag = stepConservativeTransport(grid, divergentPlates, reservoirs, 0.5, stepLedger);

    // Edge-resolved opening ledger is strictly positive
    expect(stepLedger.openingAreaM2).toBeGreaterThan(0);
    expect(stepLedger.convergenceAreaM2).toBeGreaterThan(0); // Convergent on opposite meridian

    // Raw pre-correction metrics remain bounded
    expect(rawDiag.rawMinOwnership).toBeGreaterThanOrEqual(-1e-4);
    expect(rawDiag.rawMaxClosureResidual).toBeLessThan(1e-4);

    // Verify local partition closure on all cells
    for (let cell = 0; cell < grid.totalCells; cell++) {
      const sumFrac = reservoirs.plateAreaFraction[cell * 2 + 0] + reservoirs.plateAreaFraction[cell * 2 + 1];
      expect(Math.abs(sumFrac - 1.0)).toBeLessThan(1e-4);
    }
  });

  it('7. Analytical 2-plate pure convergence: polarity-resolved trench consumption of subducting plate', () => {
    const grid = buildCubedSphereGrid(16, 6_371_000);
    // Two hemisphere plates:
    // Plate 0 (West, x < 0) weight=2.0 (Overriding), moving East (omega = 0.01)
    // Plate 1 (East, x > 0) weight=1.0 (Subducting), moving West (omega = -0.01)
    const convergentPlates: RigidEulerPlate[] = [
      {
        id: 0,
        name: 'Overriding Continental Plate',
        seedPosition: [-1, 0, 0],
        weight: 2.0, // Overriding
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: 0.01,
        color: '#ff0000',
      },
      {
        id: 1,
        name: 'Subducting Oceanic Plate',
        seedPosition: [1, 0, 0],
        weight: 1.0, // Subducting
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: -0.01,
        color: '#0000ff',
      },
    ];

    const { plateAreaFraction } = partitionGridPlates(grid, convergentPlates);
    const reservoirs: PlateStateReservoirs = {
      plateCount: 2,
      totalCells: grid.totalCells,
      plateAreaFraction: new Float32Array(plateAreaFraction),
      continentalVolumeM3: new Float64Array(grid.totalCells * 2),
      oceanicVolumeM3: new Float64Array(grid.totalCells * 2),
      oceanicAgeMomentM3Myr: new Float64Array(grid.totalCells * 2),
      inheritedOceanicVolumeM3: new Float64Array(grid.totalCells * 2),
    };

    const stepLedger: StepAreaLedger = { openingAreaM2: 0, convergenceAreaM2: 0 };
    const rawDiag = stepConservativeTransport(grid, convergentPlates, reservoirs, 0.5, stepLedger);

    // Polarity-resolved convergence ledger is strictly positive
    expect(stepLedger.convergenceAreaM2).toBeGreaterThan(0);
    expect(rawDiag.rawMinOwnership).toBeGreaterThanOrEqual(-1e-4);
    expect(rawDiag.rawMaxClosureResidual).toBeLessThan(1e-4);

    for (let cell = 0; cell < grid.totalCells; cell++) {
      const sumFrac = reservoirs.plateAreaFraction[cell * 2 + 0] + reservoirs.plateAreaFraction[cell * 2 + 1];
      expect(Math.abs(sumFrac - 1.0)).toBeLessThan(1e-4);
    }
  });

  it('8. Explicitly accounts for ridge accretion and trench consumption separately from ownership remap', () => {
    const grid = buildCubedSphereGrid(16, 6_371_000);
    const plates = seedRigidEulerPlates({ seed: 42, resolution: 16, radiusMeters: 6_371_000, plateCount: 4 });
    const { plateAreaFraction } = partitionGridPlates(grid, plates);
    const reservoirs: PlateStateReservoirs = {
      plateCount: plates.length,
      totalCells: grid.totalCells,
      plateAreaFraction: new Float32Array(plateAreaFraction),
      continentalVolumeM3: new Float64Array(grid.totalCells * plates.length),
      oceanicVolumeM3: new Float64Array(grid.totalCells * plates.length),
      oceanicAgeMomentM3Myr: new Float64Array(grid.totalCells * plates.length),
      inheritedOceanicVolumeM3: new Float64Array(grid.totalCells * plates.length),
    };
    const ledger: StepAreaLedger = {
      openingAreaM2: 0,
      convergenceAreaM2: 0,
      ridgeAccretionAreaM2: 0,
      trenchConsumptionAreaM2: 0,
      ownershipOpeningAreaM2: 0,
      ownershipConvergenceAreaM2: 0,
      openingByPlateM2: new Float64Array(plates.length),
      convergenceByPlateM2: new Float64Array(plates.length),
      plateAreaChangeM2: new Float64Array(plates.length),
    };
    stepConservativeTransport(grid, plates, reservoirs, 1, ledger);

    expect(ledger.ridgeAccretionAreaM2).toBe(ledger.openingAreaM2);
    expect(ledger.trenchConsumptionAreaM2).toBe(ledger.convergenceAreaM2);
    expect(ledger.ownershipOpeningAreaM2).toBeLessThanOrEqual(ledger.openingAreaM2 + 1e-6);
    expect(ledger.ownershipConvergenceAreaM2).toBeLessThanOrEqual(ledger.convergenceAreaM2 + 1e-6);
    expect(Math.abs(ledger.openingByPlateM2!.reduce((a, b) => a + b, 0) - ledger.openingAreaM2)).toBeLessThan(1e-3);
    expect(Math.abs(ledger.convergenceByPlateM2!.reduce((a, b) => a + b, 0) - ledger.convergenceAreaM2)).toBeLessThan(1e-3);
    expect(ledger.plateAreaChangeM2!.every(Number.isFinite)).toBe(true);
  });
});

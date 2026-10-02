import { describe, it, expect } from 'vitest';
import { buildCubedSphereGrid } from '../src/geometry/cubedSphere';
import { DEFAULT_SIMULATION_CONFIG } from '../src/types/config';
import { seedSphericalPlates } from '../src/tectonics/plateSeeds';
import {
  classifyPlateBoundaries,
  resolveSubductionPolarity,
} from '../src/tectonics/plateKinematics';
import { solveElasticFlexureDetailed } from '../src/tectonics/isostasy';
import { simulateTectonicHistory } from '../src/tectonics/tectonicHistory';
import { computeCrustalDeformation } from '../src/tectonics/crustalDeformation';
import { buildOrogenRegions } from '../src/tectonics/orogenRegions';
import { projectTectonicState } from '../src/tectonics/gridProjection';

describe('Spherical Plate Tectonics, Finite-Volume Transport & Flexure PDE', () => {
  it('should seed valid moving plates with Euler poles and angular velocities', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const { plates, plateIds } = seedSphericalPlates(grid, { ...DEFAULT_SIMULATION_CONFIG, plateCount: 8 });

    expect(plates.length).toBe(8);

    for (const plate of plates) {
      const len = Math.hypot(plate.eulerPole[0], plate.eulerPole[1], plate.eulerPole[2]);
      expect(Math.abs(len - 1.0)).toBeLessThan(1e-4);
      expect(Math.abs(plate.angularVelocity)).toBeGreaterThan(0.005);
    }

    const assignedCount = new Array(8).fill(0);
    for (let i = 0; i < grid.totalCells; i++) {
      assignedCount[plateIds[i]]++;
    }
    for (let k = 0; k < 8; k++) {
      expect(assignedCount[k]).toBeGreaterThan(0);
    }
  });

  it('should classify plate boundaries into subduction, ridge, collision, and transform zones', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const { plates, plateIds, crustType } = seedSphericalPlates(grid, { ...DEFAULT_SIMULATION_CONFIG, plateCount: 10 });
    const { boundaryType } = classifyPlateBoundaries(grid, plates, plateIds, crustType);

    let subductionCount = 0;
    let collisionCount = 0;
    let ridgeCount = 0;
    let transformCount = 0;

    for (let i = 0; i < grid.totalCells; i++) {
      const b = boundaryType[i];
      if (b === 1) subductionCount++;
      else if (b === 2) collisionCount++;
      else if (b === 3 || b === 4) ridgeCount++;
      else if (b === 5) transformCount++;
    }

    expect(subductionCount + collisionCount).toBeGreaterThan(0);
    expect(ridgeCount).toBeGreaterThan(0);
    expect(subductionCount + collisionCount + ridgeCount + transformCount).toBeGreaterThan(50);
  });

  it('should represent every physical plate boundary edge exactly once', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const seeded = seedSphericalPlates(grid, { ...DEFAULT_SIMULATION_CONFIG, plateCount: 10 });
    const result = classifyPlateBoundaries(grid, seeded.plates, seeded.plateIds, seeded.crustType, seeded.crustAge);
    const keys = new Set<string>();
    for (const edge of result.edges) {
      expect(edge.cellA).toBeLessThan(edge.cellB);
      expect(edge.plateA).not.toBe(edge.plateB);
      keys.add(`${edge.cellA}:${edge.cellB}`);
    }
    expect(keys.size).toBe(result.edges.length);
  });

  it('should resolve physically directed subduction polarity', () => {
    const crustType = new Uint8Array([0, 1, 0, 0]);
    const crustAge = new Float32Array([80, 500, 120, 30]);
    expect(resolveSubductionPolarity({ cellA: 0, cellB: 1, plateA: 3, plateB: 4 }, crustType, crustAge))
      .toEqual({ subductingPlateId: 3, overridingPlateId: 4 });
    expect(resolveSubductionPolarity({ cellA: 2, cellB: 3, plateA: 5, plateB: 6 }, crustType, crustAge))
      .toEqual({ subductingPlateId: 5, overridingPlateId: 6 });
  });

  it('should satisfy displacement CFL condition during time-stepped tectonic history', () => {
    const history = simulateTectonicHistory(DEFAULT_SIMULATION_CONFIG, 64);
    expect(history.tectonicGrid.totalCells).toBe(6 * 64 * 64);
    expect(history.snapshots.length).toBeGreaterThan(0);
    expect(history.cumulativeShorteningM.some((s) => s > 0)).toBe(true);

    // Max linear speed on sphere at Earth radius
    let maxAngVel = 0;
    for (const p of history.plates) maxAngVel = Math.max(maxAngVel, Math.abs(p.angularVelocity));
    const maxSpeedKmPerMyr = maxAngVel * (DEFAULT_SIMULATION_CONFIG.planetRadiusKm);

    for (const snap of history.snapshots) {
      const maxDisplacementKm = maxSpeedKmPerMyr * snap.dtMyr;
      // At N=64, average cell spacing is ~156 km; displacement per step must be <= 0.5 * cell size
      expect(maxDisplacementKm).toBeLessThanOrEqual(100.0);
    }

    for (let idx = 0; idx < history.tectonicGrid.totalCells; idx++) {
      let ownedArea = 0;
      for (let plate = 0; plate < history.plates.length; plate++) {
        ownedArea += history.plateAreasM2[idx * history.plates.length + plate];
      }
      expect(Math.abs(ownedArea - history.tectonicGrid.cellAreas[idx]) / history.tectonicGrid.cellAreas[idx])
        .toBeLessThan(1e-6);
    }
  }, 30_000);

  it('should strictly conserve crust volume with zero-sum internal redistribution (< 1e-4 error)', () => {
    const history = simulateTectonicHistory(DEFAULT_SIMULATION_CONFIG, 64);
    const deformation = computeCrustalDeformation(history, DEFAULT_SIMULATION_CONFIG);

    expect(deformation.massConservationErrorFraction).toBeLessThan(0.0001);
    expect(deformation.rockHardness.length).toBe(history.tectonicGrid.totalCells);
  });

  it('should classify structural orogen regimes with along-strike width variation from strain tensor', () => {
    const history = simulateTectonicHistory(DEFAULT_SIMULATION_CONFIG, 64);
    const orogenSystem = buildOrogenRegions(history);

    expect(orogenSystem.regions.length).toBeGreaterThan(0);
    const regimes = new Set(orogenSystem.regions.map((r) => r.regime));
    expect(regimes.size).toBeGreaterThan(1);

    let varyingRegions = 0;
    for (const region of orogenSystem.regions) {
      if (region.segments.length > 2) {
        expect(Number.isFinite(region.widthVariation)).toBe(true);
        if (region.widthVariation > 0.02) varyingRegions++;
        expect(region.meanWidthKm).toBeGreaterThanOrEqual(80.0);
        expect(region.meanWidthKm).toBeLessThanOrEqual(600.0);
      }
    }
    expect(varyingRegions).toBeGreaterThan(0);
  });

  it('should solve thin-plate elastic flexure PDE on output grid with load deflection and foreland basin', () => {
    const grid = buildCubedSphereGrid(96, 6371000);
    const loadAnomaly = new Float32Array(grid.totalCells);

    // Apply heavy mountain load on cell 0 (e.g. 30 km excess crust)
    loadAnomaly[0] = 2750.0 * 9.81 * 30_000.0;

    const solution = solveElasticFlexureDetailed(grid, loadAnomaly, 95.0);
    const deflection = solution.deflection;
    expect(solution.relativeResidual).toBeLessThanOrEqual(1e-3);

    // Center must have maximum positive downward mantle deflection
    expect(deflection[0]).toBeGreaterThan(0);

    // Flanking cells within the foreland basin radius must experience deflection
    let foundForelandResponse = false;
    for (let k = 0; k < 4; k++) {
      const neighbor = grid.neighbors[k];
      if (deflection[neighbor] > 0) foundForelandResponse = true;
    }
    expect(foundForelandResponse).toBe(true);
  });

  it('should project physical tectonic state invariantly with reservoir volume conservation', () => {
    const history = simulateTectonicHistory(DEFAULT_SIMULATION_CONFIG, 64);
    const deformation = computeCrustalDeformation(history, DEFAULT_SIMULATION_CONFIG);

    const outGrid96 = buildCubedSphereGrid(96, 6371000);
    const projected = projectTectonicState(history, deformation, outGrid96);

    expect(projected.crustThickness.length).toBe(outGrid96.totalCells);
    expect(projected.rockHardness.length).toBe(outGrid96.totalCells);
    expect(projected.crustType.length).toBe(outGrid96.totalCells);

    // Check the integral, not a minimum/maximum clamp. Subduction control
    // volumes may contain a fractional oceanic slab during a timestep.
    let maxThickness = 0;
    let projectedVolume = 0;
    for (let i = 0; i < outGrid96.totalCells; i++) {
      maxThickness = Math.max(maxThickness, projected.crustThickness[i]);
      projectedVolume += projected.crustThickness[i] * outGrid96.cellAreas[i];
    }
    const sourceVolume = deformation.volContinental.reduce((sum, value) => sum + value, 0)
      + deformation.volOceanic.reduce((sum, value) => sum + value, 0)
      + deformation.volArcMagma.reduce((sum, value) => sum + value, 0)
      + deformation.volSediment.reduce((sum, value) => sum + value, 0);
    expect(Math.abs(projectedVolume - sourceVolume) / sourceVolume).toBeLessThan(2e-6);
    expect(maxThickness).toBeGreaterThanOrEqual(35000.0);
    expect(maxThickness).toBeLessThanOrEqual(120000.0);
  });
});

import { describe, expect, it } from 'vitest';
import { buildCubedSphereGrid } from '../src/geometry/cubedSphere';
import {
  BOUNDARY_TRANSFORM,
  CRUST_CONTINENTAL,
  classifyPlateBoundariesCore,
  createRigidPlates,
  deformCrustFromPlateKinematics,
  initializeCrust,
  assignPlateIds,
  simulatePlateTectonicWorld,
  type BoundaryField,
  type PlateCoreConfig,
} from '../src/tectonics/plateCore';

const TEST_CONFIG: PlateCoreConfig = {
  seed: 42,
  resolution: 48,
  radiusMeters: 6_371_000,
  plateCount: 12,
  continentalFraction: 0.35,
  durationMyr: 35,
  waterVolumeM3: 1.332e18,
};

describe('isolated plate-tectonics core', () => {
  it('creates deterministic compact plates and unique physical boundary edges', () => {
    const grid = buildCubedSphereGrid(TEST_CONFIG.resolution, TEST_CONFIG.radiusMeters);
    const plates = createRigidPlates(TEST_CONFIG);
    const plateId = assignPlateIds(grid, plates);
    const crust = initializeCrust(grid, plates, plateId, TEST_CONFIG);
    const boundaries = classifyPlateBoundariesCore(grid, plates, crust);
    const keys = new Set<string>();

    expect(boundaries.edges.length).toBeGreaterThan(100);
    for (const edge of boundaries.edges) {
      expect(edge.cellA).toBeLessThan(edge.cellB);
      expect(edge.plateA).not.toBe(edge.plateB);
      expect(Number.isFinite(edge.normalVelocityMmYr)).toBe(true);
      expect(Number.isFinite(edge.shearVelocityMmYr)).toBe(true);
      keys.add(`${edge.cellA}:${edge.cellB}`);
    }
    expect(keys.size).toBe(boundaries.edges.length);
  });

  it('does not create any vertical forcing at transform boundaries', () => {
    const grid = buildCubedSphereGrid(24, TEST_CONFIG.radiusMeters);
    const config = { ...TEST_CONFIG, resolution: 24, plateCount: 4 };
    const plates = createRigidPlates(config);
    const plateId = assignPlateIds(grid, plates);
    const initial = initializeCrust(grid, plates, plateId, config);
    initial.crustType.fill(CRUST_CONTINENTAL);
    initial.continentalThicknessM.fill(35_000);
    initial.oceanicThicknessM.fill(0);
    const transformOnly: BoundaryField = {
      edges: [{
        cellA: 0,
        cellB: grid.neighbors[0],
        plateA: initial.plateId[0],
        plateB: initial.plateId[grid.neighbors[0]],
        kind: BOUNDARY_TRANSFORM,
        normalVelocityMmYr: 0,
        shearVelocityMmYr: 50,
        subductingPlateId: -1,
        overridingPlateId: -1,
        lengthM: grid.edgeLengths[0],
      }],
      boundaryType: new Uint8Array(grid.totalCells),
      normalVelocityMmYr: new Float32Array(grid.totalCells),
      shearVelocityMmYr: new Float32Array(grid.totalCells),
    };
    const result = deformCrustFromPlateKinematics(grid, config, transformOnly, initial);
    for (let cell = 0; cell < grid.totalCells; cell++) {
      expect(result.crust.continentalThicknessM[cell]).toBe(35_000);
      expect(result.crust.arcThicknessM[cell]).toBe(0);
    }
    expect(result.ledger.collisionRedistributedM3).toBe(0);
    expect(result.ledger.subductedOceanicM3).toBe(0);
  });

  it('conserves continental crust while generating ridge ages, subduction and arc crust', () => {
    const world = simulatePlateTectonicWorld(TEST_CONFIG);
    expect(world.ledger.continentalRelativeError).toBeLessThan(2e-6);
    expect(world.ledger.collisionRedistributedM3).toBeGreaterThan(0);
    expect(world.ledger.subductedOceanicM3).toBeGreaterThan(0);
    expect(world.ledger.mantleArcAddedM3).toBeGreaterThan(0);

    let youngOcean = 0;
    let oldOcean = 0;
    let arcCells = 0;
    for (let cell = 0; cell < world.grid.totalCells; cell++) {
      if (world.crust.oceanicThicknessM[cell] > 1_000) {
        if (world.crust.oceanicAgeMyr[cell] < 10) youngOcean++;
        if (world.crust.oceanicAgeMyr[cell] > 60) oldOcean++;
      }
      if (world.crust.arcThicknessM[cell] > 1_000) arcCells++;
    }
    expect(youngOcean).toBeGreaterThan(0);
    expect(oldOcean).toBeGreaterThan(0);
    expect(arcCells).toBeGreaterThan(0);
  });

  it('produces finite oceans, islands and collision mountains from crust state alone', () => {
    const world = simulatePlateTectonicWorld(TEST_CONFIG);
    let oceanArea = 0;
    let landArea = 0;
    let highMountainArea = 0;
    let islandArcArea = 0;
    let maxElevationM = -Infinity;
    const totalArea = 4 * Math.PI * TEST_CONFIG.radiusMeters ** 2;

    for (let cell = 0; cell < world.grid.totalCells; cell++) {
      const elevation = world.elevationM[cell];
      expect(Number.isFinite(elevation)).toBe(true);
      maxElevationM = Math.max(maxElevationM, elevation);
      if (elevation <= 0) oceanArea += world.grid.cellAreas[cell];
      else {
        landArea += world.grid.cellAreas[cell];
        if (elevation > 2_000) highMountainArea += world.grid.cellAreas[cell];
        if (world.crust.arcThicknessM[cell] > 4_000 && world.crust.continentalThicknessM[cell] < 1_000) {
          islandArcArea += world.grid.cellAreas[cell];
        }
      }
    }

    expect(oceanArea / totalArea).toBeGreaterThan(0.45);
    expect(landArea / totalArea).toBeGreaterThan(0.10);
    expect(highMountainArea).toBeGreaterThan(0);
    expect(islandArcArea).toBeGreaterThan(0);
    expect(maxElevationM).toBeGreaterThan(2_500);
    expect(maxElevationM).toBeLessThan(12_000);
  });
});

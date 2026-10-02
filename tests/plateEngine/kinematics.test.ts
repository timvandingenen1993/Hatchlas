import { describe, expect, it } from 'vitest';
import { buildCubedSphereGrid } from '../../src/geometry/cubedSphere';
import {
  extractKinematicBoundaries,
  partitionGridPlates,
  seedRigidEulerPlates,
  validatePlateConnectivity,
  KINEMATIC_BOUNDARY_CONVERGENT,
  KINEMATIC_BOUNDARY_DIVERGENT,
  KINEMATIC_BOUNDARY_TRANSFORM,
  type PlateEngineConfig,
  type RigidEulerPlate,
} from '../../src/tectonics/plateEngine';
import { dot3 } from '../../src/geometry/coordinates';

const TEST_CONFIG: PlateEngineConfig = {
  seed: 42,
  resolution: 32,
  radiusMeters: 6_371_000,
  plateCount: 8,
};

describe('Milestone 1A: Plate Topology & Kinematics', () => {
  it('generates valid rigid Euler plates with unit poles and plausible angular velocities', () => {
    const plates = seedRigidEulerPlates(TEST_CONFIG);
    expect(plates.length).toBe(TEST_CONFIG.plateCount);

    for (const plate of plates) {
      const poleLen = Math.hypot(plate.eulerPole[0], plate.eulerPole[1], plate.eulerPole[2]);
      expect(Math.abs(poleLen - 1.0)).toBeLessThan(1e-5);
      expect(Math.abs(plate.angularVelocityRadPerMyr)).toBeGreaterThan(0.002);
      expect(Math.abs(plate.angularVelocityRadPerMyr)).toBeLessThan(0.025);
    }
  });

  it('partitions grid with complete spherical coverage, no gaps or overlaps, and heterogeneous plate sizes', () => {
    const grid = buildCubedSphereGrid(TEST_CONFIG.resolution, TEST_CONFIG.radiusMeters);
    const plates = seedRigidEulerPlates(TEST_CONFIG);
    const { primaryPlateId, plateAreaFraction } = partitionGridPlates(grid, plates);

    expect(primaryPlateId.length).toBe(grid.totalCells);

    // 1. Complete spherical coverage & partition of unity
    const numPlates = plates.length;
    const plateAreas = new Float64Array(numPlates);

    for (let cell = 0; cell < grid.totalCells; cell++) {
      let sumFrac = 0;
      for (let p = 0; p < numPlates; p++) {
        const frac = plateAreaFraction[cell * numPlates + p];
        expect(frac).toBeGreaterThanOrEqual(0);
        sumFrac += frac;
        plateAreas[p] += frac * grid.cellAreas[cell];
      }
      expect(Math.abs(sumFrac - 1.0)).toBeLessThan(1e-6);
    }

    // 2. Heterogeneous plate distribution (multi-scale power-law size disparity)
    const sortedAreas = Array.from(plateAreas).sort((a, b) => a - b);
    const minArea = sortedAreas[0];
    const maxArea = sortedAreas[sortedAreas.length - 1];

    expect(minArea).toBeGreaterThan(0);
    expect(maxArea / minArea).toBeGreaterThan(2.5);

    // 3. Full connected-component graph validation per plate (no satellite fragments)
    const connectivity = validatePlateConnectivity(grid, primaryPlateId, numPlates);
    expect(connectivity.isConnected).toBe(true);
    expect(connectivity.invalidPlates.length).toBe(0);
    for (let p = 0; p < numPlates; p++) {
      expect(connectivity.componentCounts[p]).toBe(1);
    }
  });

  it('proves boundary normals are strictly tangent at the exact midpoint and oriented from cell A to B', () => {
    const grid = buildCubedSphereGrid(TEST_CONFIG.resolution, TEST_CONFIG.radiusMeters);
    const plates = seedRigidEulerPlates(TEST_CONFIG);
    const { primaryPlateId } = partitionGridPlates(grid, plates);
    const boundaryField = extractKinematicBoundaries(grid, plates, primaryPlateId, 2.0);

    expect(boundaryField.edges.length).toBeGreaterThan(50);

    for (const edge of boundaryField.edges) {
      const pa = [
        grid.cellPositions[edge.cellA * 3],
        grid.cellPositions[edge.cellA * 3 + 1],
        grid.cellPositions[edge.cellA * 3 + 2],
      ] as const;
      const pb = [
        grid.cellPositions[edge.cellB * 3],
        grid.cellPositions[edge.cellB * 3 + 1],
        grid.cellPositions[edge.cellB * 3 + 2],
      ] as const;

      // 1. Tangency at midpoint: n . m = 0
      const dotMidNormal = dot3(edge.midpoint, edge.normal);
      expect(Math.abs(dotMidNormal)).toBeLessThan(1e-6);

      // 2. Orthogonality of tangent frame: t . m = 0 and t . n = 0
      const dotMidTangent = dot3(edge.midpoint, edge.tangent);
      const dotNormalTangent = dot3(edge.normal, edge.tangent);
      expect(Math.abs(dotMidTangent)).toBeLessThan(1e-6);
      expect(Math.abs(dotNormalTangent)).toBeLessThan(1e-6);

      // 3. Consistent orientation from cell A to cell B: n . pb > 0 and n . pa < 0
      const dotNormalB = dot3(edge.normal, [pb[0], pb[1], pb[2]]);
      const dotNormalA = dot3(edge.normal, [pa[0], pa[1], pa[2]]);
      expect(dotNormalB).toBeGreaterThan(0);
      expect(dotNormalA).toBeLessThan(0);
    }
  });

  it('synthetic boundary tests independently verify normal and tangential relative velocity signs', () => {
    const grid = buildCubedSphereGrid(16, 6_371_000);

    // 1. Synthetic Rotating Hemisphere Plates (Divergent on y < 0, Convergent on y > 0)
    const hemispherePlates: RigidEulerPlate[] = [
      {
        id: 0,
        name: 'West Plate',
        seedPosition: [-1, 0, 0],
        weight: 2.0, // Overriding
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: -0.01,
        color: '#ff0000',
      },
      {
        id: 1,
        name: 'East Plate',
        seedPosition: [1, 0, 0],
        weight: 1.0, // Subducting
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: 0.01,
        color: '#0000ff',
      },
    ];
    const partHemi = partitionGridPlates(grid, hemispherePlates);
    const boundsHemi = extractKinematicBoundaries(grid, hemispherePlates, partHemi.primaryPlateId, 1.0);

    const divergentEdges = boundsHemi.edges.filter(e => e.kinematicType === KINEMATIC_BOUNDARY_DIVERGENT);
    const convergentEdges = boundsHemi.edges.filter(e => e.kinematicType === KINEMATIC_BOUNDARY_CONVERGENT);

    expect(divergentEdges.length).toBeGreaterThan(0);
    expect(convergentEdges.length).toBeGreaterThan(0);

    for (const e of divergentEdges) {
      expect(e.normalVelocityMmYr).toBeGreaterThan(0);
    }
    for (const e of convergentEdges) {
      expect(e.normalVelocityMmYr).toBeLessThan(0);
      expect(e.overridingPlateId).toBe(0);
      expect(e.subductingPlateId).toBe(1);
    }


    // 2. Synthetic Dextral (Right-Lateral) Transform Shear across Equator
    const dextralPlates: RigidEulerPlate[] = [
      {
        id: 0,
        name: 'South Plate',
        seedPosition: [0, 0, -1],
        weight: 1.0,
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: 0.0,
        color: '#ff0000',
      },
      {
        id: 1,
        name: 'North Plate',
        seedPosition: [0, 0, 1],
        weight: 1.0,
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: 0.02,
        color: '#0000ff',
      },
    ];
    const partDex = partitionGridPlates(grid, dextralPlates);
    const boundsDex = extractKinematicBoundaries(grid, dextralPlates, partDex.primaryPlateId, 1.0);
    expect(boundsDex.edges.length).toBeGreaterThan(0);
    for (const e of boundsDex.edges) {
      expect(Math.abs(e.normalVelocityMmYr)).toBeLessThan(1.0);
      expect(e.kinematicType).toBe(KINEMATIC_BOUNDARY_TRANSFORM);
      expect(e.signedShearVelocityMmYr).toBeGreaterThan(0); // Strictly positive for dextral
    }

    // 3. Synthetic Sinistral (Left-Lateral) Transform Shear across Equator
    const sinistralPlates: RigidEulerPlate[] = [
      {
        id: 0,
        name: 'South Plate',
        seedPosition: [0, 0, -1],
        weight: 1.0,
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: 0.0,
        color: '#ff0000',
      },
      {
        id: 1,
        name: 'North Plate',
        seedPosition: [0, 0, 1],
        weight: 1.0,
        eulerPole: [0, 0, 1],
        angularVelocityRadPerMyr: -0.02,
        color: '#0000ff',
      },
    ];
    const partSin = partitionGridPlates(grid, sinistralPlates);
    const boundsSin = extractKinematicBoundaries(grid, sinistralPlates, partSin.primaryPlateId, 1.0);
    expect(boundsSin.edges.length).toBeGreaterThan(0);
    for (const e of boundsSin.edges) {
      expect(Math.abs(e.normalVelocityMmYr)).toBeLessThan(1.0);
      expect(e.kinematicType).toBe(KINEMATIC_BOUNDARY_TRANSFORM);
      expect(e.signedShearVelocityMmYr).toBeLessThan(0); // Strictly negative for sinistral
    }

  });

  it('produces deterministic output for a fixed seed', () => {
    const grid = buildCubedSphereGrid(TEST_CONFIG.resolution, TEST_CONFIG.radiusMeters);
    const plates1 = seedRigidEulerPlates(TEST_CONFIG);
    const plates2 = seedRigidEulerPlates(TEST_CONFIG);
    expect(plates1).toEqual(plates2);

    const part1 = partitionGridPlates(grid, plates1);
    const part2 = partitionGridPlates(grid, plates2);
    expect(part1.primaryPlateId).toEqual(part2.primaryPlateId);

    const boundaries1 = extractKinematicBoundaries(grid, plates1, part1.primaryPlateId);
    const boundaries2 = extractKinematicBoundaries(grid, plates2, part2.primaryPlateId);
    expect(boundaries1.edges.length).toBe(boundaries2.edges.length);
    for (let i = 0; i < boundaries1.edges.length; i++) {
      expect(boundaries1.edges[i].cellA).toBe(boundaries2.edges[i].cellA);
      expect(boundaries1.edges[i].cellB).toBe(boundaries2.edges[i].cellB);
      expect(boundaries1.edges[i].kinematicType).toBe(boundaries2.edges[i].kinematicType);
    }
  });
});

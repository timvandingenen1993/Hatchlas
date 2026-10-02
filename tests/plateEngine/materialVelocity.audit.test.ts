import { expect, it } from 'vitest';
import { buildCubedSphereGrid } from '../../src/geometry/cubedSphere';
import {
  partitionGridPlates,
  stepConservativeTransport,
  type PlateStateReservoirs,
  type RigidEulerPlate,
} from '../../src/tectonics/plateEngine';

const normalize = (v: [number, number, number]): [number, number, number] => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};

const rotateZ = (v: [number, number, number], angle: number): [number, number, number] => [
  Math.cos(angle) * v[0] - Math.sin(angle) * v[1],
  Math.sin(angle) * v[0] + Math.cos(angle) * v[1],
  v[2],
];

const centroid = (
  grid: ReturnType<typeof buildCubedSphereGrid>,
  material: Float64Array,
  plate: number,
  plateCount: number,
): [number, number, number] => {
  const sum: [number, number, number] = [0, 0, 0];
  for (let cell = 0; cell < grid.totalCells; cell++) {
    const mass = material[cell * plateCount + plate];
    sum[0] += mass * grid.cellPositions[cell * 3];
    sum[1] += mass * grid.cellPositions[cell * 3 + 1];
    sum[2] += mass * grid.cellPositions[cell * 3 + 2];
  }
  return normalize(sum);
};

const angularDistance = (a: [number, number, number], b: [number, number, number]): number => (
  Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))
);

it('material follows its owning plate Euler motion, not the ensemble mean', () => {
  const grid = buildCubedSphereGrid(24, 6_371_000);
  const plates: RigidEulerPlate[] = [
    { id: 0, name: 'West', seedPosition: [-1, 0, 0], weight: 1, eulerPole: [0, 0, 1], angularVelocityRadPerMyr: 0.02, color: '#f00' },
    { id: 1, name: 'East', seedPosition: [1, 0, 0], weight: 1, eulerPole: [0, 0, 1], angularVelocityRadPerMyr: -0.02, color: '#00f' },
  ];
  const partition = partitionGridPlates(grid, plates);
  const reservoirs: PlateStateReservoirs = {
    plateCount: 2,
    totalCells: grid.totalCells,
    plateAreaFraction: new Float64Array(partition.plateAreaFraction),
    continentalVolumeM3: new Float64Array(grid.totalCells * 2),
    oceanicVolumeM3: new Float64Array(0),
    oceanicAgeMomentM3Myr: new Float64Array(0),
    inheritedOceanicVolumeM3: new Float64Array(0),
  };
  const center = normalize([-0.82, -0.5, 0.15]);
  for (let cell = 0; cell < grid.totalCells; cell++) {
    const dot = center[0] * grid.cellPositions[cell * 3]
      + center[1] * grid.cellPositions[cell * 3 + 1]
      + center[2] * grid.cellPositions[cell * 3 + 2];
    if (dot > Math.cos(0.24)) reservoirs.continentalVolumeM3[cell * 2] = grid.cellAreas[cell] * 35_000;
  }
  const start = centroid(grid, reservoirs.continentalVolumeM3, 0, 2);
  for (let step = 0; step < 10; step++) stepConservativeTransport(grid, plates, reservoirs, 0.25);
  const end = centroid(grid, reservoirs.continentalVolumeM3, 0, 2);
  const expected = rotateZ(start, 0.05);
  const stationaryError = angularDistance(start, expected);
  const transportedError = angularDistance(end, expected);
  console.info({ stationaryError, transportedError, actualDisplacement: angularDistance(start, end) });
  expect(transportedError).toBeLessThan(stationaryError * 0.5);
});

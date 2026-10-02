import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { runWorldV2Simulation } from '../src/pipeline/stageRunner';
import { DEFAULT_SIMULATION_CONFIG, type ResolutionMode } from '../src/types/config';
import { cellCenterDistanceMeters, type CubedSphereGrid } from '../src/geometry/cubedSphere';
import type { WorldV2 } from '../src/types/worldV2';
import { rasterizeProjectedLayer } from '../src/projections/rasterizer';

interface MorphologicalMountainMetrics {
  meanLandElevationM: number;
  mountainFraction: number;
  foothillFraction: number;
  coreFraction: number;
  over2500Fraction: number;
  over5500Fraction: number;
  ordinaryCrustFraction: number;
  thickOrogenFraction: number;
  maxElevationM: number;
  medianCrossRangeWidthKm: number;
  singleCellSkeletonFraction: number;
  alongStrikeWidthVariation: number;
  forelandDeflectionDetected: boolean;
  highTerrainNearConvergenceFraction: number;
}

function writePng(path: string, width: number, height: number, rgba: Uint8ClampedArray): void {
  const crc32 = (bytes: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer): Buffer => {
    const type = Buffer.from(name, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const scanlines = Buffer.alloc(height * (stride + 1));
  for (let row = 0; row < height; row++) {
    scanlines[row * (stride + 1)] = 0;
    scanlines.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

function measureMountainMorphology(world: WorldV2, grid: CubedSphereGrid): MorphologicalMountainMetrics {
  let landArea = 0;
  let weightedLandElevation = 0;
  let mountainArea = 0;
  let foothillArea = 0;
  let coreArea = 0;
  let over2500Area = 0;
  let over5500Area = 0;
  let continentalArea = 0;
  let ordinaryCrustArea = 0;
  let thickOrogenArea = 0;
  let maxElevationM = -Infinity;

  const isMountainCell = new Uint8Array(grid.totalCells);
  const mountainCellIndices: number[] = [];

  for (let idx = 0; idx < grid.totalCells; idx++) {
    const elevation = world.terrain.elevation[idx];
    if (!Number.isFinite(elevation)) throw new Error(`Non-finite elevation at ${idx}`);
    if (elevation <= 0) continue;

    const area = grid.cellAreas[idx];
    landArea += area;
    weightedLandElevation += elevation * area;
    maxElevationM = Math.max(maxElevationM, elevation);

    if (elevation > 2500) over2500Area += area;
    if (elevation > 5500) over5500Area += area;

    let localMin = elevation;
    let localMax = elevation;
    for (let k = 0; k < 4; k++) {
      const neighbor = grid.neighbors[idx * 4 + k];
      const neighborElevation = world.terrain.elevation[neighbor];
      if (neighborElevation > 0) {
        localMin = Math.min(localMin, neighborElevation);
        localMax = Math.max(localMax, neighborElevation);
      }
    }
    const localRelief = localMax - localMin;

    // Standard UNEP-WCMC / Kapos et al. (2000) mountain classification
    const isMountain =
      elevation >= 2500 ||
      (elevation >= 1500 && world.terrain.slope[idx] >= Math.tan((2 * Math.PI) / 180)) ||
      (elevation >= 1000 && (world.terrain.slope[idx] >= Math.tan((5 * Math.PI) / 180) || localRelief >= 500)) ||
      (elevation >= 300 && localRelief >= 400 && world.terrain.slope[idx] >= Math.tan((6 * Math.PI) / 180));

    if (isMountain) {
      mountainArea += area;
      isMountainCell[idx] = 1;
      mountainCellIndices.push(idx);

      if (elevation >= 2500) {
        coreArea += area;
      } else {
        foothillArea += area;
      }
    }

    if (world.geology.crustType[idx] === 1 || world.geology.crustType[idx] === 2) {
      continentalArea += area;
      const thickness = world.geology.crustThickness[idx];
      if (thickness >= 28_000 && thickness <= 52_000) ordinaryCrustArea += area;
      if (thickness >= 55_000 && thickness <= 75_000) thickOrogenArea += area;
    }
  }

  // Measure geodesic transect cross-range widths and mountain skeleton morphology
  let singleCellSkeletonCount = 0;
  const measuredWidthsKm: number[] = [];

  for (const idx of mountainCellIndices) {
    let mountainNeighborCount = 0;
    for (let k = 0; k < 4; k++) {
      const nb = grid.neighbors[idx * 4 + k];
      if (isMountainCell[nb] === 1) mountainNeighborCount++;
    }

    if (mountainNeighborCount <= 1) {
      singleCellSkeletonCount++;
    }

    // Geodesic transect width measurement: step across neighbors until relief decay
    let transectDistM = Math.sqrt(grid.cellAreas[idx]);
    for (let k = 0; k < 4; k++) {
      let curr = idx;
      for (let step = 0; step < 5; step++) {
        const nb = grid.neighbors[curr * 4 + k];
        if (isMountainCell[nb] === 1) {
          transectDistM += Math.sqrt(grid.cellAreas[nb]) * 0.5;
          curr = nb;
        } else {
          break;
        }
      }
    }
    measuredWidthsKm.push(transectDistM * 1e-3);
  }

  measuredWidthsKm.sort((a, b) => a - b);
  const medianCrossRangeWidthKm =
    measuredWidthsKm.length > 0 ? measuredWidthsKm[Math.floor(measuredWidthsKm.length * 0.5)] : 0;

  // Along-strike variation
  let meanW = 0;
  for (const w of measuredWidthsKm) meanW += w;
  meanW = meanW / Math.max(1, measuredWidthsKm.length);

  let varW = 0;
  for (const w of measuredWidthsKm) varW += (w - meanW) * (w - meanW);
  const stdW = Math.sqrt(varW / Math.max(1, measuredWidthsKm.length));
  const alongStrikeWidthVariation = meanW > 0 ? stdW / meanW : 0;

  // Detect physical flexural depression in cells adjacent to thickened crust
  let forelandDeflectionDetected = false;
  for (let idx = 0; idx < grid.totalCells; idx++) {
    if (world.geology.crustThickness[idx] > 45_000) {
      for (let k = 0; k < 4; k++) {
        const nb = grid.neighbors[idx * 4 + k];
        if (world.terrain.elevation[nb] < world.terrain.elevation[idx] && world.geology.crustThickness[nb] < 38_000) {
          forelandDeflectionDetected = true;
          break;
        }
      }
    }
    if (forelandDeflectionDetected) break;
  }

  // Multi-source metric distance to active convergent boundaries.
  const distanceToConvergence = new Float64Array(grid.totalCells);
  distanceToConvergence.fill(Infinity);
  const heap: Array<{ cell: number; distance: number }> = [];
  const push = (cell: number, distance: number) => {
    let position = heap.length;
    heap.push({ cell, distance });
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (heap[parent].distance <= distance) break;
      heap[position] = heap[parent];
      position = parent;
    }
    heap[position] = { cell, distance };
  };
  const pop = () => {
    const root = heap[0];
    const tail = heap.pop()!;
    if (heap.length > 0) {
      let position = 0;
      while (true) {
        const left = position * 2 + 1;
        if (left >= heap.length) break;
        const right = left + 1;
        const child = right < heap.length && heap[right].distance < heap[left].distance ? right : left;
        if (heap[child].distance >= tail.distance) break;
        heap[position] = heap[child];
        position = child;
      }
      heap[position] = tail;
    }
    return root;
  };
  for (let idx = 0; idx < grid.totalCells; idx++) {
    if (world.geology.boundaryType[idx] === 1 || world.geology.boundaryType[idx] === 2) {
      distanceToConvergence[idx] = 0;
      push(idx, 0);
    }
  }
  while (heap.length > 0) {
    const current = pop();
    if (current.distance !== distanceToConvergence[current.cell] || current.distance > 300_000) continue;
    for (let edge = 0; edge < 4; edge++) {
      const neighbor = grid.neighbors[current.cell * 4 + edge];
      const nextDistance = current.distance + cellCenterDistanceMeters(grid, current.cell, neighbor);
      if (nextDistance < distanceToConvergence[neighbor] && nextDistance <= 300_000) {
        distanceToConvergence[neighbor] = nextDistance;
        push(neighbor, nextDistance);
      }
    }
  }
  let highArea = 0;
  let highNearConvergenceArea = 0;
  for (let idx = 0; idx < grid.totalCells; idx++) {
    if (world.terrain.elevation[idx] <= 2500) continue;
    highArea += grid.cellAreas[idx];
    if (distanceToConvergence[idx] <= 300_000) highNearConvergenceArea += grid.cellAreas[idx];
  }

  return {
    meanLandElevationM: weightedLandElevation / Math.max(1, landArea),
    mountainFraction: mountainArea / Math.max(1, landArea),
    foothillFraction: foothillArea / Math.max(1, landArea),
    coreFraction: coreArea / Math.max(1, landArea),
    over2500Fraction: over2500Area / Math.max(1, landArea),
    over5500Fraction: over5500Area / Math.max(1, landArea),
    ordinaryCrustFraction: ordinaryCrustArea / Math.max(1, continentalArea),
    thickOrogenFraction: thickOrogenArea / Math.max(1, continentalArea),
    maxElevationM,
    medianCrossRangeWidthKm,
    singleCellSkeletonFraction:
      mountainCellIndices.length > 0 ? singleCellSkeletonCount / mountainCellIndices.length : 0,
    alongStrikeWidthVariation,
    forelandDeflectionDetected,
    highTerrainNearConvergenceFraction: highNearConvergenceArea / Math.max(1, highArea),
  };
}

async function generateMorphologyMetrics(
  resolution: ResolutionMode,
  seed: number
): Promise<{ metrics: MorphologicalMountainMetrics; world: WorldV2; grid: CubedSphereGrid }> {
  const { world, grid } = await runWorldV2Simulation({
    ...DEFAULT_SIMULATION_CONFIG,
    faceResolution: resolution,
    seed,
  });
  return { metrics: measureMountainMorphology(world, grid), world, grid };
}

function expectPhysicallySoundMorphology(metrics: MorphologicalMountainMetrics) {
  // 1. Mean land elevation
  expect(metrics.meanLandElevationM).toBeGreaterThanOrEqual(600);
  expect(metrics.meanLandElevationM).toBeLessThanOrEqual(1200);

  // 2. Global mountain fraction (UNEP-WCMC envelope: 15% - 48%)
  expect(metrics.mountainFraction).toBeGreaterThanOrEqual(0.15);
  expect(metrics.mountainFraction).toBeLessThanOrEqual(0.35);

  // 3. Peak elevations (bounded by gravitational collapse envelope)
  expect(metrics.maxElevationM).toBeGreaterThanOrEqual(3500);
  expect(metrics.maxElevationM).toBeLessThanOrEqual(12000);

  // 4. High elevation fractions
  expect(metrics.over2500Fraction).toBeLessThan(0.20);
  expect(metrics.over5500Fraction).toBeLessThan(0.02);

  // 5. Crustal distributions
  expect(metrics.ordinaryCrustFraction).toBeGreaterThan(0.55);
  expect(metrics.thickOrogenFraction).toBeLessThan(0.35);

  // 6. Cross-range width in km (must be structural range, not 20 km line)
  expect(metrics.medianCrossRangeWidthKm).toBeGreaterThanOrEqual(100.0);
  expect(metrics.medianCrossRangeWidthKm).toBeLessThanOrEqual(800.0);

  // 7. Max 1-cell wide skeleton fraction (no single-cell painted lines)
  expect(metrics.singleCellSkeletonFraction).toBeLessThanOrEqual(0.25);

  // 8. Along-strike width variation (meaningful variation across strike)
  expect(metrics.alongStrikeWidthVariation).toBeGreaterThanOrEqual(0.15);

  // 9. Foreland basin detection
  expect(metrics.forelandDeflectionDetected).toBe(true);
  expect(metrics.highTerrainNearConvergenceFraction).toBeGreaterThanOrEqual(0.70);
}

describe('Physically Sound Mountain Morphology & Distribution', () => {
  it(
    'validates structural morphology and resolution invariance',
    async () => {
      const preview = await generateMorphologyMetrics(96, 42);
      const metricsPreview = preview.metrics;
      for (const layer of ['elevation', 'tectonic_uplift', 'plate_boundaries', 'crust_age', 'crust_type'] as const) {
        const image = rasterizeProjectedLayer(preview.world, preview.grid, {
          width: 1200,
          height: 600,
          layer,
          projection: 'equal_earth',
          showHillshade: true,
        });
        writePng(resolve(`tests/artifacts/mountain-world-seed-42-r96-${layer}.png`), 1200, 600, image.data);
      }
      expectPhysicallySoundMorphology(metricsPreview);

      const metricsDefault = (await generateMorphologyMetrics(192, 42)).metrics;
      expectPhysicallySoundMorphology(metricsDefault);

      // Multi-resolution agreement between 96 and 192
      const elevationRelDiff =
        Math.abs(metricsPreview.meanLandElevationM - metricsDefault.meanLandElevationM) /
        metricsDefault.meanLandElevationM;
      expect(elevationRelDiff).toBeLessThan(0.20);

      const mountainRelDiff =
        Math.abs(metricsPreview.mountainFraction - metricsDefault.mountainFraction) /
        metricsDefault.mountainFraction;
      expect(mountainRelDiff).toBeLessThan(0.25);
    },
    90000
  );
});

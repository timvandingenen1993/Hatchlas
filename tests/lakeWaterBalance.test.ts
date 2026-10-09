import { describe, it, expect } from 'vitest';
import {
  lakeDepthFromBasins,
  prepareLakeBasins,
  resolveLakeBasin,
  routeLakeBasins,
} from '../src/terrain/lakeWaterBalance';
import { processMountainBaseDEM } from '../src/terrain/mountainBaseDEM';
import {
  LAKE_TEST_BASINS,
  LAKE_TEST_NOTCH,
  LAKE_TEST_RADIUS,
  lakeTestTerrain,
} from './fixtures/lakeTestTerrain';

// Two V-shaped pits in a walled trough, joined by a saddle at x = 6 and
// spilling over the rim cell at the right map edge:
//   x:     0   1 2 3 4 5   6   7 8 9 10 11  12
//   z:    10   2 1 0 1 2   3   2 1 0  1  2   4
const WIDTH = 13;
const HEIGHT = 3;
const ROW = [10, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 4];
const at = (x: number): number => WIDTH + x;

function twoPitBasin(inflow: number) {
  const elevation = new Float32Array(WIDTH * HEIGHT).fill(10);
  const filled = new Float32Array(WIDTH * HEIGHT).fill(10);
  for (let x = 0; x < WIDTH; x++) {
    elevation[at(x)] = ROW[x];
    filled[at(x)] = x >= 1 && x <= 11 ? 4 : ROW[x];
  }
  // The filled routing crosses the trough east and leaves over the rim.
  const flowDirection = new Int8Array(WIDTH * HEIGHT).fill(-1);
  for (let x = 1; x <= 11; x++) flowDirection[at(x)] = 2;
  const lakes = prepareLakeBasins(
    WIDTH, HEIGHT, elevation, filled, new Uint8Array(WIDTH * HEIGHT), flowDirection,
    new Float32Array(WIDTH * HEIGHT).fill(1), 1, 1, 0.25, 1, 2,
  );
  // A river delivers all of the inflow to the left pit.
  const ownInflow = new Float32Array(WIDTH * HEIGHT);
  ownInflow[at(3)] = inflow;
  const routed = ownInflow.slice();
  const outflow = resolveLakeBasin(lakes, 0, flowDirection, routed, 0);
  const depth = lakeDepthFromBasins(lakes, elevation, 0.25, 1, 0);
  routeLakeBasins(
    lakes, elevation, flowDirection, ownInflow, new Float32Array(WIDTH * HEIGHT).fill(1),
    routed, new Float32Array(WIDTH * HEIGHT), new Float32Array(WIDTH * HEIGHT), 1,
  );
  return { lakes, outflow, routed, depth, flowDirection };
}

describe('closed-basin lake water balance', () => {
  it('spills over the rim cell only', () => {
    const { lakes } = twoPitBasin(0);
    expect(lakes.spillCell[0]).toBe(at(12));
  });

  it('spills past a cell at exactly the spill height inside the lake', () => {
    // A 7 x 5 walled basin filled to 4, with an islet at (3, 2) that sits at
    // exactly 4 and so is no basin cell. The filled routing runs east from
    // the deepest cell over the islet and back into the basin before the
    // rim at (6, 2). Spilling onto the islet would make it wait on the basin
    // it drains back into, and the lake would never resolve.
    const width = 7;
    const height = 5;
    const cell = (x: number, y: number) => y * width + x;
    const elevation = new Float32Array(width * height).fill(10);
    const filled = new Float32Array(width * height).fill(10);
    for (let y = 1; y <= 3; y++) {
      for (let x = 1; x <= 5; x++) {
        elevation[cell(x, y)] = x === 1 && y === 2 ? 0 : 1;
        filled[cell(x, y)] = 4;
      }
    }
    elevation[cell(3, 2)] = 4;
    elevation[cell(6, 2)] = filled[cell(6, 2)] = 4;
    const flowDirection = new Int8Array(width * height).fill(-1);
    for (let x = 1; x <= 6; x++) flowDirection[cell(x, 2)] = 2;
    const lakes = prepareLakeBasins(
      width, height, elevation, filled, new Uint8Array(width * height), flowDirection,
      new Float32Array(width * height).fill(1), 1, 1, 0.25, 1, 2,
    );
    expect(lakes.basinOf[cell(3, 2)]).toBe(-1);
    expect(lakes.spillCell[0]).toBe(cell(6, 2));
    expect(lakes.exitCell[0]).toBe(cell(5, 2));
  });

  it('holds a small inflow in the pit it enters, below the saddle', () => {
    const { outflow, depth } = twoPitBasin(2);
    expect(outflow).toBe(0);
    expect(depth[at(3)]).toBeCloseTo(1);
    expect(depth[at(2)]).toBe(0);
    expect(depth[at(9)]).toBe(0);
  });

  it('spills a full pit into its neighbour and draws the connecting flow', () => {
    // The left pit's five cells absorb 5; the other 2 cross the saddle.
    const { outflow, depth, routed } = twoPitBasin(7);
    expect(outflow).toBe(0);
    expect(depth[at(3)]).toBeCloseTo(3);
    expect(depth[at(1)]).toBeCloseTo(1);
    expect(depth[at(9)]).toBeCloseTo(1);
    expect(depth[at(7)]).toBe(0);
    expect(routed[at(6)]).toBeCloseTo(2);
    expect(routed[at(7)]).toBeCloseTo(2);
    expect(routed[at(10)]).toBe(0);
  });

  it('rises as one lake and overflows the rim once both pits are full', () => {
    // Eleven wet cells absorb 11 of 20.
    const { outflow, depth, routed, flowDirection } = twoPitBasin(20);
    expect(outflow).toBeCloseTo(9);
    expect(depth[at(6)]).toBeCloseTo(1);
    expect(depth[at(3)]).toBeCloseTo(4);
    expect(depth[at(9)]).toBeCloseTo(4);
    // The river crosses the full lake as one channel and leaves over the
    // rim with what evaporation left.
    expect(routed[at(6)]).toBeCloseTo(20);
    expect(routed[at(11)]).toBeCloseTo(9);
    expect(flowDirection[at(11)]).toBe(2);
  });

  it('lowers a dry-climate heightmap lake below its spill and cuts its outflow', () => {
    const width = 64;
    const height = 64;
    const luminance = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bowl = Math.max(0, 1 - Math.hypot(x - 32, y - 28) / 9);
        luminance[y * width + x] = 0.3 + 0.5 * (1 - y / height) - 0.12 * bowl;
      }
    }
    const run = (lakeEvaporationScale: number) =>
      processMountainBaseDEM(luminance, width, height, {
        riverThresholdKm2: 0.01,
        minElevationM: 0,
        maxElevationM: 600,
        basePrecipitationMmYr: 500,
        baseTemperatureC: 25,
        lakeEvaporationScale,
      });
    const brimFull = run(0);
    const terminal = run(3);
    const wetCells = (lake: Float32Array) => lake.reduce((n, d) => n + (d > 0 ? 1 : 0), 0);
    // Water that leaves the map across its edges.
    const edgeOutflow = (dem: ReturnType<typeof run>) => {
      let sum = 0;
      for (let i = 0; i < width * height; i++) {
        const x = i % width;
        const y = Math.floor(i / width);
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) sum += dem.rainfallWeightedAreaKm2[i];
      }
      return sum;
    };

    const centre = 28 * width + 32;
    expect(brimFull.lakeDepthM![centre]).toBeGreaterThan(2);
    expect(terminal.lakeDepthM![centre]).toBeGreaterThan(0);
    expect(terminal.lakeDepthM![centre]).toBeLessThan(brimFull.lakeDepthM![centre] - 0.5);
    expect(wetCells(terminal.lakeDepthM!)).toBeLessThan(wetCells(brimFull.lakeDepthM!));
    expect(edgeOutflow(terminal)).toBeLessThan(edgeOutflow(brimFull));
  });
});

// A walled basin filled to 4 that spills over a rim cell in the middle of
// its east wall. The filled routing runs east and converges on the rim.
function walledBasin(width: number, height: number, floor: (x: number, y: number) => number) {
  const cell = (x: number, y: number) => y * width + x;
  const mid = (height - 1) / 2;
  const elevation = new Float32Array(width * height).fill(10);
  const filled = new Float32Array(width * height).fill(10);
  const flowDirection = new Int8Array(width * height).fill(-1);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      elevation[cell(x, y)] = floor(x, y);
      filled[cell(x, y)] = 4;
      flowDirection[cell(x, y)] = x < width - 2 || y === mid ? 2 : y < mid ? 3 : 1;
    }
  }
  elevation[cell(width - 1, mid)] = filled[cell(width - 1, mid)] = 4;
  const lakes = prepareLakeBasins(
    width, height, elevation, filled, new Uint8Array(width * height), flowDirection,
    new Float32Array(width * height).fill(1), 1, 1, 0.25, 1, 2,
  );
  // Follows the drawn flow field from a cell to where it ends.
  const end = (from: number) => {
    let c = from;
    for (let guard = 0; guard < width * height && flowDirection[c] >= 0; guard++) {
      const [dx, dy] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]][flowDirection[c]];
      c += dy * width + dx;
    }
    return c;
  };
  // A river of `inflow` enters at `entry` and runs down to its pit.
  const pour = (entry: number, inflow: number) => {
    const pit = end(entry);
    const routed = new Float32Array(width * height);
    routed[pit] = inflow;
    const outflow = resolveLakeBasin(lakes, 0, flowDirection, routed, 0);
    const depth = lakeDepthFromBasins(lakes, elevation, 0.25, 1, 0);
    const ownInflow = new Float32Array(width * height);
    ownInflow[entry] = inflow;
    routeLakeBasins(
      lakes, elevation, flowDirection, ownInflow, new Float32Array(width * height).fill(1),
      routed, new Float32Array(width * height), new Float32Array(width * height), 1,
    );
    const wet: number[] = [];
    depth.forEach((d, i) => {
      if (d > 0) wet.push(i);
    });
    // Drawn water forms one patch.
    const patch = new Set(wet.slice(0, 1));
    for (const c of patch) {
      for (const n of wet) {
        if (Math.abs((n % width) - (c % width)) <= 1 && Math.abs(Math.floor(n / width) - Math.floor(c / width)) <= 1) {
          patch.add(n);
        }
      }
    }
    return { outflow, depth, wet, connected: patch.size === wet.length, riverEnd: end(entry) };
  };
  return { cell, pour };
}

describe('terminal lakes on flat and nearly flat floors', () => {
  it('pools a flat floor around its middle, where the river ends', () => {
    // A 7 x 3 floor, all at 1: the water level is the floor itself.
    const { cell, pour } = walledBasin(9, 5, () => 1);
    const { outflow, depth, wet, connected, riverEnd } = pour(cell(1, 2), 5);
    expect(outflow).toBe(0);
    expect(wet.sort((a, b) => a - b)).toEqual(
      [cell(4, 1), cell(3, 2), cell(4, 2), cell(5, 2), cell(4, 3)],
    );
    for (const c of wet) expect(depth[c]).toBeCloseTo(0.25);
    expect(connected).toBe(true);
    expect(riverEnd).toBe(cell(4, 2));
  });

  it('draws a nearly flat floor as far as its balance wets complete height bands', () => {
    // A bowl 2 cm deep per cell step: all of it shallower than the depth floor.
    const { cell, pour } = walledBasin(9, 5, (x, y) => 1 + 0.01 * ((x - 4) ** 2 + (y - 2) ** 2));
    const five = pour(cell(1, 2), 5);
    expect(five.outflow).toBe(0);
    expect(five.wet.length).toBe(5);
    expect(five.wet).toContain(cell(4, 2));
    expect(five.connected).toBe(true);
    expect(five.riverEnd).toBe(cell(4, 2));
  });

  it('leaves a partly wet ring of equal-height cells as shoreline', () => {
    // Seven cells wet the pit, its four neighbours and half of the four
    // diagonals, which are no flat and so have no order to fill in.
    const { cell, pour } = walledBasin(9, 5, (x, y) => 1 + 0.01 * ((x - 4) ** 2 + (y - 2) ** 2));
    expect(pour(cell(1, 2), 7).wet.length).toBe(5);
  });

  it('spreads over a flat terrace outward from the pit it surrounds', () => {
    // A one-cell pit at 0 in a floor at 1. Its eight neighbours touch the pit
    // alike, so the terrace is drawn once that ring is wet and the water has
    // spread beyond it.
    const { cell, pour } = walledBasin(9, 5, (x, y) => (x === 4 && y === 2 ? 0 : 1));
    const partRing = pour(cell(1, 2), 6);
    expect(partRing.wet).toEqual([cell(4, 2)]);
    expect(partRing.riverEnd).toBe(cell(4, 2));

    const beyond = walledBasin(9, 5, (x, y) => (x === 4 && y === 2 ? 0 : 1));
    const { wet, connected, outflow } = beyond.pour(beyond.cell(1, 2), 12);
    expect(outflow).toBe(0);
    expect(wet.length).toBe(12);
    expect(connected).toBe(true);
    for (let x = 3; x <= 5; x++) {
      for (let y = 1; y <= 3; y++) expect(wet).toContain(cell(x, y));
    }
  });
});

describe('lake test terrain', () => {
  const size = 256;
  const terrain = lakeTestTerrain(size, size);
  const run = (precipitationMmYr: number, lakeEvaporationScale: number) =>
    processMountainBaseDEM(terrain, size, size, {
      domainWidthKm: 68,
      domainHeightKm: 68,
      minElevationM: 0,
      maxElevationM: 4050,
      windAzimuthDeg: 225,
      windSpeedMs: 16,
      basePrecipitationMmYr: precipitationMmYr,
      baseTemperatureC: 17,
      riverThresholdKm2: 16,
      lakeEvaporationScale,
    });
  type Basin = (typeof LAKE_TEST_BASINS)[number];
  const basinStats = (dem: ReturnType<typeof run>, basin: Basin) => {
    let lake = 0;
    let belowNotch = 0;
    for (let i = 0; i < size * size; i++) {
      const r = Math.hypot((i % size) / size - basin.u, Math.floor(i / size) / size - basin.v);
      if (r >= LAKE_TEST_RADIUS) continue;
      if (dem.elevation[i] < LAKE_TEST_NOTCH * 4050) belowNotch++;
      if (dem.lakeDepthM![i] > 0) lake++;
    }
    const centre = Math.round(basin.v * size) * size + Math.round(basin.u * size);
    return { lake, belowNotch, centreWet: dem.lakeDepthM![centre] > 0 };
  };

  it('fills every basin to its notch in a wet climate', () => {
    const dem = run(1500, 1);
    for (const basin of LAKE_TEST_BASINS) {
      const { lake, belowNotch } = basinStats(dem, basin);
      expect(lake, basin.name).toBeGreaterThan(0.9 * belowNotch);
    }
  });

  it('holds a lake below the notch in a dry climate, whatever the floor', () => {
    // Flat and gentle floors are shallower than the depth floor wherever the
    // water stands; their lakes show only because the balance wets them.
    const dem = run(600, 3);
    for (const basin of LAKE_TEST_BASINS) {
      const { lake, belowNotch, centreWet } = basinStats(dem, basin);
      expect(lake, basin.name).toBeGreaterThan(0.2 * belowNotch);
      expect(lake, basin.name).toBeLessThan(0.7 * belowNotch);
      expect(centreWet, basin.name).toBe(true);
    }
  });
});

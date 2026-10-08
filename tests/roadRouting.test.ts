import { describe, expect, it } from 'vitest';
import {
  buildRoutingTerrain,
  HARD_GRADE_RATIO,
  pointToCell,
  resolveRoutingParams,
  routeRoad,
  routeSegment,
  WATER_BLOCKED,
  WATER_RIVER,
  type RoutingDemFields,
} from '../src/structures/roadRouting';
import { DEFAULT_ROUTING_SETTINGS, type RoutingSettings } from '../src/structures/types';

const SIZE = 96;
const CELL_M = 20;

function makeDem(
  elevationAt: (x: number, y: number) => number,
  riverAt: (x: number, y: number) => number = () => 0,
  oceanAt: (x: number, y: number) => boolean = () => false,
): RoutingDemFields {
  const total = SIZE * SIZE;
  const elevation = new Float32Array(total);
  const isRiverChannel = new Uint8Array(total);
  const strahlerOrder = new Uint8Array(total);
  const isOcean = new Uint8Array(total);
  const biomeType = new Uint8Array(total).fill(2);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const index = y * SIZE + x;
      elevation[index] = elevationAt(x, y);
      const order = riverAt(x, y);
      if (order > 0) {
        isRiverChannel[index] = 1;
        strahlerOrder[index] = order;
      }
      if (oceanAt(x, y)) isOcean[index] = 1;
    }
  }
  return {
    width: SIZE,
    height: SIZE,
    dxMeters: CELL_M,
    dyMeters: CELL_M,
    elevation,
    isRiverChannel,
    strahlerOrder,
    isOcean,
    biomeType,
  };
}

const at = (x: number, y: number) => ({ u: (x + 0.5) / SIZE, v: (y + 0.5) / SIZE });

function settings(overrides: Partial<RoutingSettings> = {}): RoutingSettings {
  return { ...DEFAULT_ROUTING_SETTINGS, ...overrides };
}

describe('road routing', () => {
  it('crosses a ridge through its saddle', () => {
    // North-south ridge at x = 48, 300 m high except a low saddle near y = 70.
    const dem = makeDem((x, y) => {
      const ridge = Math.max(0, 1 - Math.abs(x - 48) / 14);
      const saddle = 1 - 0.85 * Math.exp(-((y - 70) ** 2) / 40);
      return 300 * ridge * saddle;
    });
    const terrain = buildRoutingTerrain(dem);
    const params = resolveRoutingParams(settings(), 'road');
    const segment = routeSegment(terrain, at(10, 30), at(86, 30), params);
    expect(segment.found).toBe(true);
    const crest = segment.cells.filter((cell) => cell % SIZE === 48);
    expect(crest.length).toBeGreaterThan(0);
    const crestY = Math.floor(crest[0] / SIZE);
    expect(Math.abs(crestY - 70)).toBeLessThan(10);
  });

  it('bridges a river once, at its narrow point', () => {
    // A vertical river, 9 cells wide, except a 2-cell neck at y = 20.
    const dem = makeDem(
      () => 10,
      (x, y) => {
        const halfWidth = Math.abs(y - 20) <= 1 ? 1 : 4;
        return Math.abs(x - 48) <= halfWidth ? 4 : 0;
      },
    );
    const terrain = buildRoutingTerrain(dem);
    const params = resolveRoutingParams(settings({ bridgeReluctanceKm: 0.5, allowFords: false }), 'road');
    const route = routeRoad(terrain, [at(20, 40), at(76, 40)], params);
    expect(route.bridgeCount).toBe(1);
    expect(route.fordCount).toBe(0);
    const bridge = route.bridges[0];
    const bridgeV = (route.points[bridge.from].v + route.points[bridge.to].v) / 2;
    expect(Math.abs(bridgeV * SIZE - 20.5)).toBeLessThan(3);
  });

  const bridgeRow = (route: ReturnType<typeof routeRoad>) => {
    expect(route.bridgeCount).toBe(1);
    const bridge = route.bridges[0];
    return ((route.points[bridge.from].v + route.points[bridge.to].v) / 2) * SIZE;
  };

  it('detours a little to halve a long bridge', () => {
    // 240 m of water on the direct line, a 60 m narrows ten cells north.
    const dem = makeDem(() => 10, (x, y) => (Math.abs(x - 48) <= (Math.abs(y - 30) <= 1 ? 1 : 6) ? 4 : 0));
    const route = routeRoad(buildRoutingTerrain(dem), [at(20, 40), at(76, 40)],
      resolveRoutingParams(settings({ allowFords: false }), 'road'));
    expect(Math.abs(bridgeRow(route) - 30.5)).toBeLessThan(3);
  });

  it('does not take a long detour to save a little bridge', () => {
    // 120 m of water on the direct line, a 40 m narrows forty cells north.
    const dem = makeDem(() => 10, (x, y) => (Math.abs(x - 48) <= (Math.abs(y - 10) <= 1 ? 1 : 3) ? 4 : 0));
    const route = routeRoad(buildRoutingTerrain(dem), [at(20, 50), at(76, 50)],
      resolveRoutingParams(settings({ allowFords: false }), 'road'));
    expect(Math.abs(bridgeRow(route) - 50.5)).toBeLessThan(6);
  });

  it('fords a small stream when fords are allowed', () => {
    const dem = makeDem(() => 10, (x) => (Math.abs(x - 48) <= 1 ? 1 : 0));
    const terrain = buildRoutingTerrain(dem);
    const params = resolveRoutingParams(settings({ allowFords: true }), 'road');
    const route = routeRoad(terrain, [at(20, 40), at(76, 40)], params);
    expect(route.fordCount).toBe(1);
    expect(route.bridgeCount).toBe(0);
  });

  it('bridges wetland pools instead of fording them', () => {
    // A long pool across the map: too long to detour around, too shallow an
    // order to count as a river, so it must be bridged rather than forded.
    const dem = makeDem(() => 10, (x) => (Math.abs(x - 48) <= 2 ? 1 : 0));
    dem.wetlandPoolMask = (dem.isRiverChannel as Uint8Array).slice();
    const terrain = buildRoutingTerrain(dem);
    const params = resolveRoutingParams(settings({ allowFords: true }), 'road');
    const route = routeRoad(terrain, [at(20, 40), at(76, 40)], params);
    expect(route.fordCount).toBe(0);
    expect(route.bridgeCount).toBe(1);
  });

  it('steers around forest stands when forest avoidance is on', () => {
    // A forest belt across the map with a clearing well off the direct line.
    const dem = makeDem(() => 10);
    const coverSize = 48;
    const data = new Uint8Array(coverSize * coverSize);
    for (let y = 0; y < coverSize; y++) {
      for (let x = 20; x < 28; x++) data[y * coverSize + x] = y >= 4 && y < 10 ? 0 : 255;
    }
    dem.vegetationCover = { width: coverSize, height: coverSize, data };
    const terrain = buildRoutingTerrain(dem);
    const crossingRow = (forestAvoidance: number) => {
      const params = resolveRoutingParams(settings({ forestAvoidance }), 'road');
      const segment = routeSegment(terrain, at(20, 70), at(76, 70), params);
      const middle = segment.cells.find((cell) => cell % SIZE === 48)!;
      return Math.floor(middle / SIZE);
    };
    // Without avoidance the road cuts straight through; with it, it detours
    // to the clearing near the top of the belt.
    expect(Math.abs(crossingRow(0) - 70)).toBeLessThan(4);
    expect(crossingRow(3)).toBeLessThan(22);
  });

  it('never runs along a river in a steep valley', () => {
    // The valley floor is all river; the walls are far steeper than any road.
    const dem = makeDem(
      (x) => (Math.abs(x - 48) <= 2 ? 0 : 30 * (Math.abs(x - 48) - 2)),
      (x) => (Math.abs(x - 48) <= 2 ? 3 : 0),
    );
    const terrain = buildRoutingTerrain(dem);
    const settingsWithLimit = settings({ maxBridgeLengthM: 200 });
    const params = resolveRoutingParams(settingsWithLimit, 'road');
    const route = routeRoad(terrain, [at(44, 4), at(52, 90)], params);
    for (const bridge of route.bridges) {
      const a = route.points[bridge.from];
      const b = route.points[bridge.to];
      const spanM = Math.hypot((a.u - b.u) * SIZE * CELL_M, (a.v - b.v) * SIZE * CELL_M);
      expect(spanM).toBeLessThanOrEqual(settingsWithLimit.maxBridgeLengthM + CELL_M * 1.5);
    }
    expect(route.bridgeCount + route.fordCount).toBeLessThanOrEqual(2);
  });

  it('crosses only bank to bank, never starting or ending in water', () => {
    const dem = makeDem(() => 10, (x) => (Math.abs(x - 48) <= 3 ? 4 : 0));
    const terrain = buildRoutingTerrain(dem);
    const params = resolveRoutingParams(settings(), 'road');
    // Waypoints dropped inside the river snap to the nearest bank.
    const segment = routeSegment(terrain, at(47, 10), at(49, 80), params);
    expect(terrain.water[segment.cells[0]]).toBe(0);
    expect(terrain.water[segment.cells[segment.cells.length - 1]]).toBe(0);
    let longestWaterRun = 0;
    let current = 0;
    for (const cell of segment.cells) {
      current = terrain.water[cell] === WATER_RIVER ? current + 1 : 0;
      longestWaterRun = Math.max(longestWaterRun, current);
    }
    expect(longestWaterRun).toBeLessThanOrEqual(9);
  });

  it('never crosses the ocean', () => {
    // An inlet blocks the direct line; the road must go around its head.
    const dem = makeDem(
      () => 5,
      () => 0,
      (x, y) => Math.abs(x - 48) <= 3 && y < 70,
    );
    const terrain = buildRoutingTerrain(dem);
    const params = resolveRoutingParams(settings(), 'road');
    const segment = routeSegment(terrain, at(20, 20), at(76, 20), params);
    expect(segment.found).toBe(true);
    for (const cell of segment.cells) expect(terrain.water[cell]).not.toBe(WATER_BLOCKED);
    expect(Math.max(...segment.cells.map((cell) => Math.floor(cell / SIZE)))).toBeGreaterThanOrEqual(70);
  });

  it('keeps the climb below the hard grade by switching back', () => {
    // A 30 % plane rising northwards.
    const dem = makeDem((_x, y) => (SIZE - y) * CELL_M * 0.3);
    const terrain = buildRoutingTerrain(dem);
    const params = resolveRoutingParams(settings({ maxGradePct: 12 }), 'road');
    const route = routeRoad(terrain, [at(48, 80), at(48, 50)], params);
    expect(route.maxGradePct / 100).toBeLessThanOrEqual(params.maxGrade * HARD_GRADE_RATIO + 1e-6);
    // The straight climb is 600 m long; switchbacks must lengthen it.
    expect(route.lengthKm).toBeGreaterThan(0.9);
  });

  it('keeps level ground on a smooth line without straightening it', () => {
    // 75 × 30 cells is not one of the 16 grid headings, so A* steps.
    const terrain = buildRoutingTerrain(makeDem(() => 0));
    const params = resolveRoutingParams(settings({ straightness: 1 }), 'road');
    const route = routeRoad(terrain, [at(10, 10), at(85, 40)], params);
    const a = route.points[0];
    const b = route.points[route.points.length - 1];
    const deviation = Math.max(...route.points.map((p) => {
      const t = ((p.u - a.u) * (b.u - a.u) + (p.v - a.v) * (b.v - a.v)) / ((b.u - a.u) ** 2 + (b.v - a.v) ** 2);
      return Math.hypot(p.u - (a.u + (b.u - a.u) * t), p.v - (a.v + (b.v - a.v) * t)) * SIZE;
    }));
    // Smoothed stair steps stay within about a cell of the direct line, and
    // no corner is sharper than the smoothing allows.
    expect(deviation).toBeLessThan(1.5);
    for (let index = 1; index + 1 < route.points.length; index++) {
      const p = route.points[index - 1];
      const q = route.points[index];
      const r = route.points[index + 1];
      const turn = Math.abs(Math.atan2(r.v - q.v, r.u - q.u) - Math.atan2(q.v - p.v, q.u - p.u));
      expect(Math.min(turn, Math.PI * 2 - turn)).toBeLessThan(Math.PI / 4);
    }
  });

  it('climbs in long switchback legs with few corners', () => {
    const dem = makeDem((_x, y) => (SIZE - y) * CELL_M * 0.3);
    const terrain = buildRoutingTerrain(dem);
    const params = resolveRoutingParams(settings({ maxGradePct: 12 }), 'road');
    const route = routeRoad(terrain, [at(48, 80), at(48, 50)], params);
    // Each rounded corner adds five points; a clean switchback needs only a
    // handful of hairpins for this climb.
    const corners = (route.points.length - 2) / 5;
    expect(corners).toBeLessThanOrEqual(10);
    expect(route.maxGradePct / 100).toBeLessThanOrEqual(params.maxGrade * HARD_GRADE_RATIO + 1e-6);
  });

  it('cuts straight through hairpins too crowded to draw', () => {
    // A 35 % face cut by gullies and spurs, where the grid search zigzags.
    const size = 160;
    const total = size * size;
    const elevation = new Float32Array(total);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      elevation[y * size + x] = (size - y) * CELL_M * 0.35 + 25 * Math.sin(x / 4.3) * Math.cos(y / 5.1) +
        8 * Math.sin(x * 1.7 + y * 2.3);
    }
    const terrain = buildRoutingTerrain({
      width: size, height: size, dxMeters: CELL_M, dyMeters: CELL_M, elevation,
      isRiverChannel: new Uint8Array(total), strahlerOrder: new Uint8Array(total),
      isOcean: new Uint8Array(total), biomeType: new Uint8Array(total).fill(2),
    });
    const point = (x: number, y: number) => ({ u: (x + 0.5) / size, v: (y + 0.5) / size });
    const turns = (minLegLengthM: number) => {
      const route = routeRoad(terrain, [point(80, 140), point(80, 40)],
        resolveRoutingParams(settings({ minLegLengthM }), 'road'));
      let count = 0;
      for (let index = 1; index + 1 < route.points.length; index++) {
        const [a, b, c] = [route.points[index - 1], route.points[index], route.points[index + 1]];
        let turn = Math.abs(Math.atan2(c.v - b.v, c.u - b.u) - Math.atan2(b.v - a.v, b.u - a.u));
        turn = Math.min(turn, Math.PI * 2 - turn);
        if (turn > Math.PI / 6) count++;
      }
      return count;
    };
    // Without the cut both climbs fold into combs of hairpins a cell or two
    // apart (80 and 45 turns); cut through, a handful of turns remain.
    expect(turns(0)).toBeLessThanOrEqual(20);
    expect(turns(400)).toBeLessThanOrEqual(20);
  }, 30000);

  it('removes more corners as straightness rises', () => {
    const dem = makeDem((x, y) => 40 * Math.sin(x / 5) * Math.cos(y / 7));
    const terrain = buildRoutingTerrain(dem);
    const corners = (straightness: number) => routeRoad(terrain, [at(5, 5), at(90, 88)],
      resolveRoutingParams(settings({ straightness }), 'road')).points.length;
    expect(corners(1)).toBeLessThanOrEqual(corners(0));
  });

  it('visits every waypoint in order', () => {
    const dem = makeDem(() => 0);
    const terrain = buildRoutingTerrain(dem);
    const params = resolveRoutingParams(settings(), 'road');
    const waypoints = [at(10, 10), at(80, 20), at(20, 80), at(85, 85)];
    const visited: number[] = [];
    routeRoad(terrain, waypoints, params, (from, to) => {
      const segment = routeSegment(terrain, from, to, params);
      visited.push(segment.cells[0], segment.cells[segment.cells.length - 1]);
      return segment;
    });
    expect(visited).toEqual([
      pointToCell(terrain, waypoints[0]), pointToCell(terrain, waypoints[1]),
      pointToCell(terrain, waypoints[1]), pointToCell(terrain, waypoints[2]),
      pointToCell(terrain, waypoints[2]), pointToCell(terrain, waypoints[3]),
    ]);
  });

  it('downsamples large DEMs and keeps river cells', () => {
    const dem = makeDem(() => 0, (x) => (x === 48 ? 3 : 0));
    const terrain = buildRoutingTerrain(dem, 32);
    expect(terrain.width).toBe(32);
    expect(terrain.cellWidthM).toBe(CELL_M * 3);
    expect(terrain.water[16 * 32 + 16]).toBe(WATER_RIVER);
    expect(terrain.riverSize[16 * 32 + 16]).toBe(3);
  });
});

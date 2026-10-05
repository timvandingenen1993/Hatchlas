import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  assembleGlobalDem,
  bboxError,
  decodeTerrarium,
  DEM_SOURCES,
  encodeGlobalDemGeoTiff,
  globalDemToHeightmap,
  maskEdgeConnectedSea,
  MERCATOR_MAX_LAT,
  planGlobalDem,
  type DemTile,
} from '../src/terrain/globalDem';
import { decodeTiffHeightmap } from '../src/terrain/mountainBaseDEM';

const montBlanc = { west: 6.75, south: 45.75, east: 7.05, north: 45.98 };
const signal = new AbortController().signal;

/** Exact in Float32 (integers below 2^24) and always land, so no cell counts as sea. */
const positionValue = (x: number, y: number) => 1 + (x % 2048) + (y % 2048) * 2048;

/** A synthetic world whose elevation encodes the global pixel position. */
const positionalLoader = (tileSize: number, missing?: (tile: DemTile) => boolean) =>
  async (tile: DemTile) => {
    if (missing?.(tile)) return null;
    const values = new Float32Array(tileSize * tileSize);
    for (let row = 0; row < tileSize; row++) {
      for (let col = 0; col < tileSize; col++) {
        values[row * tileSize + col] = positionValue(tile.x * tileSize + col, tile.y * tileSize + row);
      }
    }
    return values;
  };

describe('global DEM planning', () => {
  it('reaches about 30 m over the Alps within the tile budget', () => {
    const plan = planGlobalDem(montBlanc, DEM_SOURCES.mapzen, 30);
    expect(plan.groundCellSize).toBeLessThanOrEqual(30);
    expect(plan.groundCellSize).toBeGreaterThan(15);
    expect(plan.tiles.length).toBeGreaterThan(0);
    expect(plan.tiles.length).toBeLessThanOrEqual(256);
    // About 23 km wide and 26 km tall; snapping adds at most one cell per edge.
    expect(plan.widthKm).toBeGreaterThan(23.2);
    expect(plan.widthKm).toBeLessThan(23.4 + 2 * plan.groundCellSize / 1000);
    expect(plan.heightKm).toBeGreaterThan(25.5);
    expect(plan.heightKm).toBeLessThan(25.7 + 2 * plan.groundCellSize / 1000);
  });

  it('covers the crop window with exactly the planned tiles', () => {
    const plan = planGlobalDem(montBlanc, DEM_SOURCES.mapterhorn, 30);
    const size = plan.source.tileSize;
    const xs = plan.tiles.map((tile) => tile.x);
    const ys = plan.tiles.map((tile) => tile.y);
    expect(Math.min(...xs) * size).toBeLessThanOrEqual(plan.left);
    expect((Math.max(...xs) + 1) * size).toBeGreaterThanOrEqual(plan.left + plan.width);
    expect(Math.min(...ys) * size).toBeLessThanOrEqual(plan.top);
    expect((Math.max(...ys) + 1) * size).toBeGreaterThanOrEqual(plan.top + plan.height);
    expect(plan.tiles.length).toBe(new Set(xs).size * new Set(ys).size);
  });

  it('never exceeds a source native zoom or the download budget', () => {
    const summit = { west: 6.86, south: 45.83, east: 6.88, north: 45.84 };
    expect(planGlobalDem(summit, DEM_SOURCES.mapterhorn, 1).zoom).toBe(12);
    expect(planGlobalDem(summit, DEM_SOURCES.mapzen, 1).zoom).toBe(15);
    // A 23 km box at 1 m would need thousands of z15 tiles; the budget coarsens it.
    expect(planGlobalDem(montBlanc, DEM_SOURCES.mapzen, 1).tiles.length).toBeLessThanOrEqual(256);
    const world = { west: -180, south: -MERCATOR_MAX_LAT, east: 180, north: MERCATOR_MAX_LAT };
    for (const source of Object.values(DEM_SOURCES)) {
      const plan = planGlobalDem(world, source, 30);
      expect(plan.tiles.length * source.tileSize ** 2).toBeLessThanOrEqual(64 * 512 * 512);
    }
  });

  it('rejects invalid boxes', () => {
    expect(bboxError(montBlanc)).toBeNull();
    expect(bboxError({ ...montBlanc, east: 6 })).toMatch(/west smaller/);
    expect(bboxError({ ...montBlanc, north: 89 })).toMatch(/Latitude/);
    expect(bboxError({ ...montBlanc, west: Number.NaN })).toMatch(/valid/);
    expect(() => planGlobalDem({ ...montBlanc, west: 179, east: -179 }, DEM_SOURCES.mapzen)).toThrow();
    expect(() => planGlobalDem(montBlanc, DEM_SOURCES.mapzen, 0)).toThrow();
  });
});

describe('Terrarium decoding', () => {
  it('decodes elevations and treats black as missing', () => {
    const decoded = decodeTerrarium(new Uint8Array([
      128, 0, 0, 255,
      146, 200, 128, 255,
      127, 255, 0, 255,
      0, 0, 0, 255,
    ]));
    expect(Array.from(decoded.subarray(0, 3))).toEqual([0, 4808.5, -1]);
    expect(decoded[3]).toBeNaN();
  });
});

describe('global DEM assembly', () => {
  it('places every tile pixel at its global position in the crop', async () => {
    const plan = planGlobalDem(montBlanc, DEM_SOURCES.mapzen, 30);
    const mosaic = await assembleGlobalDem(plan, positionalLoader(256), signal);
    expect(mosaic.values.length).toBe(plan.width * plan.height);
    for (const [col, row] of [[0, 0], [plan.width - 1, 0], [0, plan.height - 1], [plan.width - 1, plan.height - 1], [301, 457]]) {
      expect(mosaic.values[row * plan.width + col]).toBe(positionValue(plan.left + col, plan.top + row));
    }
  });

  it('leaves tiles the provider lacks as missing ocean', async () => {
    const plan = planGlobalDem(montBlanc, DEM_SOURCES.mapzen, 30);
    const first = plan.tiles[0];
    const mosaic = await assembleGlobalDem(plan, positionalLoader(256, (tile) => tile === first), signal);
    expect(mosaic.values[0]).toBeNaN();
    expect(mosaic.values[mosaic.values.length - 1]).not.toBeNaN();
    const raster = globalDemToHeightmap(mosaic);
    expect(raster.oceanMask?.[0]).toBe(1);
    expect(raster.oceanMask?.[mosaic.values.length - 1]).toBe(0);
  });

  it('fails when the provider has no data at all', async () => {
    const plan = planGlobalDem(montBlanc, DEM_SOURCES.mapzen, 120);
    await expect(assembleGlobalDem(plan, async () => null, signal)).rejects.toThrow(/no elevation data/);
  });
});

describe('sea masking', () => {
  // 0 = sea level at the edge, 9 = land, negatives are below sea level.
  const grid = (rows: number[][]) => ({
    values: new Float32Array(rows.flat()), width: rows[0].length, height: rows.length,
  });
  const masked = (rows: number[][]) => {
    const { values, width, height } = grid(rows);
    maskEdgeConnectedSea(values, width, height);
    return Array.from(values, (value) => (Number.isNaN(value) ? 'sea' : value));
  };

  it('turns sea at 0 m that reaches the edge into NaN but keeps enclosed depressions', () => {
    expect(masked([
      [0, 0, 0, 0, 0],
      [0, 9, 9, 9, 0],
      [0, 9, -5, 9, 0],
      [0, 9, 9, 9, 0],
      [0, 0, 0, 0, 0],
    ])).toEqual([
      'sea', 'sea', 'sea', 'sea', 'sea',
      'sea', 9, 9, 9, 'sea',
      'sea', 9, -5, 9, 'sea',
      'sea', 9, 9, 9, 'sea',
      'sea', 'sea', 'sea', 'sea', 'sea',
    ]);
  });

  it('floods low land that touches the sea, and only through edge neighbours', () => {
    expect(masked([
      [-20, 9, 9, 9],
      [-3, -1, 9, 9],
      [9, 9, -1, 9],
      [9, 9, 9, 9],
    ])).toEqual([
      'sea', 9, 9, 9,
      'sea', 'sea', 9, 9,
      9, 9, -1, 9,
      9, 9, 9, 9,
    ]);
  });

  it('floods along channels in every direction', () => {
    // A winding channel entering from the west edge; rotated so it enters from each side.
    let rows = [
      [9, 9, 9, 9, 9],
      [0, -1, -1, 9, 9],
      [9, 9, -1, 9, 9],
      [9, 9, -1, -1, 9],
      [9, 9, 9, 9, 9],
    ];
    const rotate = (input: number[][]) => input[0].map((_, col) => input.map((row) => row[col]).reverse());
    for (let turn = 0; turn < 4; turn++) {
      const result = masked(rows);
      expect(result.filter((value) => value === 'sea')).toHaveLength(6);
      expect(result.filter((value) => value === 9)).toHaveLength(19);
      rows = rotate(rows);
    }
  });

  it('rejects a box that is entirely sea', async () => {
    const plan = planGlobalDem(montBlanc, DEM_SOURCES.mapzen, 120);
    await expect(assembleGlobalDem(plan, async () => new Float32Array(256 * 256), signal)).rejects.toThrow(/entirely sea/);
  });
});

describe('global DEM heightmap metadata', () => {
  const synthetic = async () => {
    const plan = planGlobalDem(montBlanc, DEM_SOURCES.mapzen, 60);
    const mosaic = await assembleGlobalDem(plan, async () => {
      const values = new Float32Array(256 * 256);
      for (let i = 0; i < values.length; i++) values[i] = 1000 + (i % 3800);
      values[5] = -2500; // bathymetry
      values[6] = Number.NaN;
      return values;
    }, signal);
    return mosaic;
  };

  it('restores real elevations from summit and valley floor', async () => {
    const mosaic = await synthetic();
    const raster = globalDemToHeightmap(mosaic);
    const meta = raster.metadata!;
    expect(meta.maxElevationM).toBe(mosaic.maxElevationM);
    // Bathymetry and gaps clamp to the decoder's ocean floor.
    expect(meta.minElevationM).toBe(-10);
    const land = mosaic.values.findIndex((value) => value > 2000);
    const restored = meta.minElevationM + raster.rawLuminance[land] * (meta.maxElevationM - meta.minElevationM);
    expect(restored).toBeCloseTo(mosaic.values[land], 2);
    expect(meta.widthKm).toBeCloseTo(mosaic.widthKm, 9);
  });

  it('round-trips the saved GeoTIFF through the heightmap loader with its scale', async () => {
    const mosaic = await synthetic();
    const fromMemory = globalDemToHeightmap(mosaic);
    const fromFile = decodeTiffHeightmap(encodeGlobalDemGeoTiff(mosaic))!;
    expect(fromFile.width).toBe(mosaic.width);
    expect(fromFile.height).toBe(mosaic.height);
    expect(fromFile.metadata!.widthKm).toBeCloseTo(mosaic.widthKm, 6);
    expect(fromFile.metadata!.heightKm).toBeCloseTo(mosaic.heightKm, 6);
    expect(fromFile.metadata!.minElevationM).toBe(fromMemory.metadata!.minElevationM);
    expect(fromFile.metadata!.maxElevationM).toBe(fromMemory.metadata!.maxElevationM);
    for (const index of [0, 5, 6, 777, mosaic.values.length - 1]) {
      expect(fromFile.rawLuminance[index]).toBeCloseTo(fromMemory.rawLuminance[index], 6);
      expect(fromFile.oceanMask?.[index]).toBe(fromMemory.oceanMask?.[index]);
    }
  });

  it('reads geographic GeoTIFFs in degrees as ground kilometres', async () => {
    const mosaic = await synthetic();
    const bytes = encodeGlobalDemGeoTiff(mosaic);
    const view = new DataView(bytes);
    const pixelScale = 8 + mosaic.width * mosaic.height * 4;
    // 0.001° cells with the top-left corner at 45.5°N: centre latitude 45.5 - span/2.
    view.setFloat64(pixelScale, 0.001, true);
    view.setFloat64(pixelScale + 8, 0.001, true);
    view.setFloat64(pixelScale + 24 + 24, 6.5, true);
    view.setFloat64(pixelScale + 24 + 32, 45.5, true);
    view.setUint16(pixelScale + 72 + 14, 2, true); // GTModelType: geographic
    const decoded = decodeTiffHeightmap(bytes)!;
    const centreLat = 45.5 - (mosaic.height * 0.001) / 2;
    const kmPerDegree = (Math.PI * 6378.137) / 180;
    expect(decoded.metadata!.widthKm).toBeCloseTo(mosaic.width * 0.001 * kmPerDegree * Math.cos(centreLat * Math.PI / 180), 6);
    expect(decoded.metadata!.heightKm).toBeCloseTo(mosaic.height * 0.001 * kmPerDegree, 6);
  });

  it('reports no scale for plain TIFFs such as the bundled DEM', async () => {
    const bytes = await readFile(new URL('../src/assets/nz-linz-dem.tif', import.meta.url));
    const decoded = decodeTiffHeightmap(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)!;
    expect(decoded.width).toBe(2367);
    expect(decoded.metadata).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { equalEarthForward, equalEarthInverse } from '../src/projections/equalEarth';
import {
  mercatorForward,
  mercatorInverse,
  MERCATOR_ASPECT_RATIO,
  MERCATOR_MAX_LAT_RAD,
  MERCATOR_MAX_LAT_DEG,
} from '../src/projections/mercator';
import {
  equirectangularForward,
  equirectangularInverse,
  EQUIRECTANGULAR_ASPECT_RATIO,
} from '../src/projections/equirectangular';
import { getProjection, PROJECTIONS, PROJECTION_LIST } from '../src/projections';
import { rasterizeHeightmap, rasterizeProjectedLayer } from '../src/projections/rasterizer';
import { buildCubedSphereGrid } from '../src/geometry/cubedSphere';
import { runWorldV2Simulation } from '../src/pipeline/stageRunner';
import { DEFAULT_SIMULATION_CONFIG, type SimulationConfig } from '../src/types/config';

describe('Equal Earth Map Projection (Šavrič, Patterson & Jenny 2019)', () => {
  it('should round-trip forward and inverse projection with high precision', () => {
    const lats = [-75, -45, -20, 0, 20, 45, 75].map((d) => (d * Math.PI) / 180);
    const lons = [-160, -90, -45, 0, 45, 90, 160].map((d) => (d * Math.PI) / 180);

    for (const lat of lats) {
      for (const lon of lons) {
        const { x, y } = equalEarthForward(lat, lon);
        const inv = equalEarthInverse(x, y);

        expect(inv).not.toBeNull();
        if (inv) {
          expect(Math.abs(inv.latRad - lat)).toBeLessThan(1e-6);
          expect(Math.abs(inv.lonRad - lon)).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('should return null for coordinates outside the projected globe', () => {
    expect(equalEarthInverse(5.0, 0.0)).toBeNull();
    expect(equalEarthInverse(0.0, 3.0)).toBeNull();
    expect(equalEarthInverse(-4.0, -2.5)).toBeNull();
  });
});

describe('Mercator Projection (Conformal 1:1)', () => {
  it('should have 1:1 aspect ratio and standard max latitude ~85.0511°', () => {
    expect(MERCATOR_ASPECT_RATIO).toBe(1.0);
    expect(MERCATOR_MAX_LAT_DEG).toBeCloseTo(85.051129, 4);
  });

  it('should project origin (0, 0) to (0, 0)', () => {
    const pt = mercatorForward(0, 0);
    expect(pt.x).toBeCloseTo(0, 6);
    expect(pt.y).toBeCloseTo(0, 6);

    const inv = mercatorInverse(0, 0);
    expect(inv).not.toBeNull();
    expect(inv!.latRad).toBeCloseTo(0, 6);
    expect(inv!.lonRad).toBeCloseTo(0, 6);
  });

  it('should round-trip forward and inverse projection accurately across valid latitudes', () => {
    const testLatsDeg = [-80, -60, -45, -30, 0, 30, 45, 60, 80];
    const testLonsDeg = [-170, -120, -60, 0, 60, 120, 170];

    for (const latDeg of testLatsDeg) {
      const latRad = (latDeg * Math.PI) / 180;
      for (const lonDeg of testLonsDeg) {
        const lonRad = (lonDeg * Math.PI) / 180;

        const { x, y } = mercatorForward(latRad, lonRad);
        const inv = mercatorInverse(x, y);

        expect(inv).not.toBeNull();
        if (inv) {
          expect(inv.latRad).toBeCloseTo(latRad, 5);
          expect(inv.lonRad).toBeCloseTo(lonRad, 5);
        }
      }
    }
  });

  it('should correctly clamp coordinates at the polar boundary', () => {
    const ptNorth = mercatorForward(MERCATOR_MAX_LAT_RAD, 0);
    expect(ptNorth.y).toBeCloseTo(Math.PI, 5);

    const ptSouth = mercatorForward(-MERCATOR_MAX_LAT_RAD, 0);
    expect(ptSouth.y).toBeCloseTo(-Math.PI, 5);
  });

  it('should return null for points outside projection bounds', () => {
    expect(mercatorInverse(Math.PI + 1.0, 0)).toBeNull();
    expect(mercatorInverse(0, Math.PI + 1.0)).toBeNull();
    expect(mercatorInverse(-4.0, 0)).toBeNull();
  });
});

describe('Equirectangular Projection (Plate Carrée 2:1)', () => {
  it('should have 2:1 aspect ratio', () => {
    expect(EQUIRECTANGULAR_ASPECT_RATIO).toBe(2.0);
  });

  it('should round-trip forward and inverse mapping linearly across full sphere', () => {
    const lats = [-85, -45, 0, 45, 85].map((d) => (d * Math.PI) / 180);
    const lons = [-180, -90, 0, 90, 180].map((d) => (d * Math.PI) / 180);

    for (const lat of lats) {
      for (const lon of lons) {
        const { x, y } = equirectangularForward(lat, lon);
        const inv = equirectangularInverse(x, y);

        expect(inv).not.toBeNull();
        if (inv) {
          expect(inv.latRad).toBeCloseTo(lat, 6);
          expect(inv.lonRad).toBeCloseTo(lon, 6);
        }
      }
    }
  });

  it('should return null for out-of-bounds coordinates', () => {
    expect(equirectangularInverse(Math.PI + 0.5, 0)).toBeNull();
    expect(equirectangularInverse(0, Math.PI / 2 + 0.5)).toBeNull();
  });
});

describe('Projection Registry & Metadata', () => {
  it('should register all three standard projections', () => {
    expect(PROJECTION_LIST.length).toBe(3);
    expect(PROJECTIONS.equal_earth).toBeDefined();
    expect(PROJECTIONS.mercator).toBeDefined();
    expect(PROJECTIONS.equirectangular).toBeDefined();

    expect(getProjection('mercator').name).toContain('Mercator');
    expect(getProjection('equal_earth').name).toContain('Equal Earth');
    expect(getProjection('equirectangular').name).toContain('Equirectangular');
  });
});

describe('Universal Rasterizer & Heightmap Generation', () => {
  it('should rasterize Mercator, Equirectangular, and Equal Earth layers and heightmaps', async () => {
    const testConfig: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, faceResolution: 32, plateCount: 6, seed: 1234 };
    const { world } = await runWorldV2Simulation(testConfig);
    const grid = buildCubedSphereGrid(32, world.radiusMeters);

    // 1. Mercator layer
    const mercatorImg = rasterizeProjectedLayer(world, grid, {
      width: 64,
      height: 64,
      layer: 'elevation',
      projection: 'mercator',
      showHillshade: true,
    });

    expect(mercatorImg.width).toBe(64);
    expect(mercatorImg.height).toBe(64);
    expect(mercatorImg.data.length).toBe(64 * 64 * 4);
    expect(mercatorImg.data[3]).toBe(255);

    // 2. Equirectangular layer
    const equirectImg = rasterizeProjectedLayer(world, grid, {
      width: 64,
      height: 32,
      layer: 'biomes',
      projection: 'equirectangular',
    });

    expect(equirectImg.width).toBe(64);
    expect(equirectImg.height).toBe(32);
    expect(equirectImg.data.length).toBe(64 * 32 * 4);
    expect(equirectImg.data[3]).toBe(255);

    // 3. Heightmap rasterization in Mercator
    const heightmap = rasterizeHeightmap(world, grid, {
      width: 32,
      height: 32,
      projection: 'mercator',
      mode: 'normalized',
    });

    expect(heightmap.width).toBe(32);
    expect(heightmap.height).toBe(32);
    expect(heightmap.data.length).toBe(32 * 32 * 4);

    const r = heightmap.data[0];
    const g = heightmap.data[1];
    const b = heightmap.data[2];
    const a = heightmap.data[3];

    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(a).toBe(255);
  }, 30_000);
});

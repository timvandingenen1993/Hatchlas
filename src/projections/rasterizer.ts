/**
 * Samples world fields into raster images for any supported projection, including heightmap export.
 */
import type { AnalysisLayer, WorldV2 } from '../types/worldV2';
import { sampleCubedSphereField, sampleCubedSphereNearest, type CubedSphereGrid } from '../geometry/cubedSphere';
import type { ProjectionType } from './types';
import { getProjection } from './index';
import {
  BASIN_PALETTE,
  BIOME_DEFINITIONS,
  CRUST_AGE_STOPS,
  ELEVATION_STOPS,
  PRECIPITATION_STOPS,
  sampleColorRamp,
  TEMPERATURE_STOPS,
  TECTONIC_UPLIFT_STOPS,
} from '../utils/colorRamps';

export interface RasterizeOptions {
  width: number;
  height: number;
  layer: AnalysisLayer;
  projection?: ProjectionType;
  selectedMonth?: number; // 0 to 11 (default 0 / January)
  showHillshade?: boolean;
}

export interface HeightmapExportOptions {
  width: number;
  height: number;
  projection?: ProjectionType;
  mode?: 'normalized' | 'sea_level_centered' | 'raw_land_only';
}

export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Universal Inverse Map Projection Rasterizer
 * Anti-aliased subpixel sampling from CubedSphereGrid onto Equal Earth, Mercator, or Equirectangular rasters.
 */
export function rasterizeProjectedLayer(
  world: WorldV2,
  grid: CubedSphereGrid,
  options: RasterizeOptions
): ImageData {
  const {
    width,
    height,
    layer,
    projection = 'equal_earth',
    selectedMonth = 0,
    showHillshade = true,
  } = options;

  const projDef = getProjection(projection);
  const data = new Uint8ClampedArray(width * height * 4);

  const { minX, maxX, minY, maxY } = projDef.extents;
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;

  // Hillshade lighting vector (Northwest illumination from azimuth 315°, altitude 45°)
  const lx = -0.5, ly = 0.5, lz = 0.7071;
  const R = world.radiusMeters;

  for (let py = 0; py < height; py++) {
    // py=0 is top (North, +Y), py=height-1 is bottom (South, -Y)
    const normY = height === 1 ? maxY : maxY - (py / (height - 1)) * rangeY;
    const rowOffset = py * width * 4;

    for (let px = 0; px < width; px++) {
      const normX = width === 1 ? minX : minX + (px / (width - 1)) * rangeX;
      const pixIdx = rowOffset + px * 4;

      const inv = projDef.inverse(normX, normY);
      if (!inv) {
        // Outside the projected globe bounds: Transparent
        data[pixIdx + 0] = 0;
        data[pixIdx + 1] = 0;
        data[pixIdx + 2] = 0;
        data[pixIdx + 3] = 0;
        continue;
      }

      const { latRad, lonRad } = inv;
      let r = 0, g = 0, b = 0, a = 255;

      switch (layer) {
        case 'plate_ids': {
          const pid = sampleCubedSphereNearest(grid, world.geology.plateIds, latRad, lonRad);
          const plate = world.geology.plates[pid];
          if (plate && plate.color) {
            const hex = plate.color.replace('#', '');
            r = Number.parseInt(hex.substring(0, 2), 16) || 128;
            g = Number.parseInt(hex.substring(2, 4), 16) || 128;
            b = Number.parseInt(hex.substring(4, 6), 16) || 128;
          } else {
            r = ((pid * 67) % 200) + 55;
            g = ((pid * 131) % 200) + 55;
            b = ((pid * 193) % 200) + 55;
          }
          break;
        }

        case 'ownership_closure': {
          const field = world.geology.ownershipClosure;
          const res = field ? sampleCubedSphereField(grid, field, latRad, lonRad) : 0;
          if (res < -1e-4) {
            // Gap (Blue)
            const t = Math.min(1.0, Math.abs(res) / 0.5);
            r = Math.round(250 * (1 - t) + 20 * t);
            g = Math.round(250 * (1 - t) + 100 * t);
            b = 255;
          } else if (res > 1e-4) {
            // Overlap (Red)
            const t = Math.min(1.0, res / 0.5);
            r = 255;
            g = Math.round(250 * (1 - t) + 20 * t);
            b = Math.round(250 * (1 - t) + 20 * t);
          } else {
            // Perfect Partition Closure (Pure White)
            r = 250; g = 250; b = 250;
          }
          break;
        }

        case 'dominance_confidence': {
          const field = world.geology.dominanceConfidence;
          const conf = field ? sampleCubedSphereField(grid, field, latRad, lonRad) : 1;
          if (conf >= 0.99) {
            // Pure interior plate cell (Bright Cyan)
            r = 34; g = 211; b = 238;
          } else {
            // Mixed interface margin
            const t = Math.max(0.0, Math.min(1.0, (conf - 0.5) / 0.5));
            r = Math.round(30 + 100 * t);
            g = Math.round(40 + 120 * t);
            b = Math.round(70 + 160 * t);
          }
          break;
        }

        case 'continental_material': {
          const field = world.geology.continentalThicknessM;
          const thicknessM = field ? sampleCubedSphereField(grid, field, latRad, lonRad) : 0;
          const t = Math.max(0, Math.min(1, thicknessM / 70_000));
          r = Math.round(18 + 222 * t);
          g = Math.round(42 + 146 * Math.sqrt(t));
          b = Math.round(88 - 54 * t);
          break;
        }

        case 'relative_velocity': {
          const bType = sampleCubedSphereNearest(grid, world.geology.boundaryType, latRad, lonRad);
          const vn = sampleCubedSphereField(grid, world.geology.tectonicUpliftRate, latRad, lonRad);
          if (bType > 0) {
            if (vn < -1.0) {
              // Convergent (Crimson Red / Orange)
              const t = Math.min(1.0, Math.abs(vn) / 50.0);
              r = Math.round(180 + 75 * t);
              g = Math.round(40 * (1 - t));
              b = Math.round(40 * (1 - t));
            } else if (vn > 1.0) {
              // Divergent (Vibrant Emerald Green)
              const t = Math.min(1.0, vn / 50.0);
              r = Math.round(16 * (1 - t));
              g = Math.round(160 + 95 * t);
              b = Math.round(80 + 40 * t);
            } else {
              // Transform (Cyan)
              r = 6; g = 200; b = 240;
            }
          } else {
            // Muted Plate Interior Background
            const pid = sampleCubedSphereNearest(grid, world.geology.plateIds, latRad, lonRad);
            const plate = world.geology.plates[pid];
            if (plate && plate.color) {
              const hex = plate.color.replace('#', '');
              r = Math.round(((Number.parseInt(hex.substring(0, 2), 16) || 128) * 0.15) + 10);
              g = Math.round(((Number.parseInt(hex.substring(2, 4), 16) || 128) * 0.15) + 10);
              b = Math.round(((Number.parseInt(hex.substring(4, 6), 16) || 128) * 0.15) + 15);
            } else {
              r = 20; g = 25; b = 35;
            }
          }
          break;
        }



        case 'elevation': {
          const elev = sampleCubedSphereField(grid, world.terrain.elevation, latRad, lonRad);
          const baseColor = sampleColorRamp(ELEVATION_STOPS, elev);
          r = baseColor.r;
          g = baseColor.g;
          b = baseColor.b;

          if (showHillshade && elev > world.seaLevelMeters) {
            const cosLat = Math.max(0.1, Math.cos(latRad));

            // The DEM contains one independent sample per cubed-sphere cell.
            // Sample at that actual angular spacing rather than inventing 5 km
            // detail by differentiating the bilinear interpolation surface.
            const dGrid = (Math.PI / 2) / grid.resolution;
            const dsLat = R * dGrid;
            const dsLon = R * dGrid * cosLat;
            const eN = sampleCubedSphereField(grid, world.terrain.elevation, latRad + dGrid, lonRad);
            const eS = sampleCubedSphereField(grid, world.terrain.elevation, latRad - dGrid, lonRad);
            const eE = sampleCubedSphereField(grid, world.terrain.elevation, latRad, lonRad + dGrid);
            const eW = sampleCubedSphereField(grid, world.terrain.elevation, latRad, lonRad - dGrid);

            const dzdx = (eE - eW) / (2 * dsLon);
            const dzdy = (eN - eS) / (2 * dsLat);

            const nLen = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1.0);
            const nx = -dzdx / nLen;
            const ny = -dzdy / nLen;
            const nz = 1.0 / nLen;

            const dot = Math.max(0.0, nx * lx + ny * ly + nz * lz);
            const shade = 0.30 + 0.70 * Math.pow(dot, 0.90);

            r = Math.min(255, Math.round(r * shade));
            g = Math.min(255, Math.round(g * shade));
            b = Math.min(255, Math.round(b * shade));
          }
          break;
        }

        case 'crust_type': {
          const cType = sampleCubedSphereNearest(grid, world.geology.crustType, latRad, lonRad);
          if (cType === 0) {
            // Oceanic Crust
            r = 30; g = 64; b = 115;
          } else if (cType === 1) {
            // Continental Crust
            r = 195; g = 135; b = 75;
          } else {
            // Volcanic Island Arc / Orogen
            r = 220; g = 38; b = 38;
          }
          break;
        }

        case 'crust_age': {
          const age = sampleCubedSphereField(grid, world.geology.crustAge, latRad, lonRad);
          const c = sampleColorRamp(CRUST_AGE_STOPS, age);
          r = c.r; g = c.g; b = c.b;
          break;
        }

        case 'plate_boundaries': {
          const bType = sampleCubedSphereNearest(grid, world.geology.boundaryType, latRad, lonRad);
          const pid = sampleCubedSphereNearest(grid, world.geology.plateIds, latRad, lonRad);
          const plate = world.geology.plates[pid];

          // Muted plate interior background
          if (plate && plate.color) {
            const hex = plate.color.replace('#', '');
            r = Math.round(((Number.parseInt(hex.substring(0, 2), 16) || 128) * 0.25) + 15);
            g = Math.round(((Number.parseInt(hex.substring(2, 4), 16) || 128) * 0.25) + 15);
            b = Math.round(((Number.parseInt(hex.substring(4, 6), 16) || 128) * 0.25) + 20);
          } else {
            r = 25; g = 32; b = 45;
          }

          if (bType === 1) {
            // Subduction (Crimson)
            r = 245; g = 50; b = 50;
          } else if (bType === 2) {
            // Continental collision (Orange)
            r = 249; g = 115; b = 22;
          } else if (bType === 3) {
            // Oceanic ridge (Emerald)
            r = 16; g = 225; b = 120;
          } else if (bType === 4) {
            // Continental rift (Lime)
            r = 132; g = 204; b = 22;
          } else if (bType === 5) {
            // Transform (Cyan)
            r = 6; g = 200; b = 240;
          }
          break;
        }


        case 'tectonic_uplift': {
          const uplift = sampleCubedSphereField(grid, world.geology.tectonicUpliftRate, latRad, lonRad);
          const c = sampleColorRamp(TECTONIC_UPLIFT_STOPS, uplift);
          r = c.r; g = c.g; b = c.b;
          break;
        }

        case 'discharge': {
          const elev = sampleCubedSphereField(grid, world.terrain.elevation, latRad, lonRad);
          const q = sampleCubedSphereField(grid, world.hydrology.discharge, latRad, lonRad);
          const strahler = sampleCubedSphereNearest(grid, world.hydrology.strahlerOrder, latRad, lonRad);
          const isLake = sampleCubedSphereNearest(grid, world.hydrology.isLakeMask, latRad, lonRad);

          if (elev <= world.seaLevelMeters) {
            // Deep ocean background
            r = 10; g = 25; b = 55;
          } else if (isLake > 0) {
            // Natural Turquoise Lake Surface
            r = 6; g = 182; b = 212;
          } else {
            // Land relief background
            const baseColor = sampleColorRamp(ELEVATION_STOPS, elev);
            r = Math.round(baseColor.r * 0.40);
            g = Math.round(baseColor.g * 0.40);
            b = Math.round(baseColor.b * 0.40);

            // Render prominent tributary networks and main river arteries (Q >= 180 m^3/s or Strahler >= 4)
            if (q >= 180.0 || strahler >= 4) {
              const logQ = Math.log10(Math.max(100.0, q));
              // Continuous river intensity factor in [0, 1] for 180 to 200,000 m^3/s
              const t = Math.min(1.0, Math.max(0.0, (logQ - 2.25) / 3.0));
              const riverR = Math.round(20 * (1 - t) + 8 * t);
              const riverG = Math.round(160 * (1 - t) + 215 * t);
              const riverB = Math.round(235 * (1 - t) + 255 * t);

              // Alpha blend river over topography
              const alpha = Math.min(1.0, 0.60 + t * 0.40);
              r = Math.round(r * (1 - alpha) + riverR * alpha);
              g = Math.round(g * (1 - alpha) + riverG * alpha);
              b = Math.round(b * (1 - alpha) + riverB * alpha);
            }
          }
          break;
        }

        case 'lakes': {
          const elev = sampleCubedSphereField(grid, world.terrain.elevation, latRad, lonRad);
          const isLake = sampleCubedSphereNearest(grid, world.hydrology.isLakeMask, latRad, lonRad);

          if (isLake > 0) {
            r = 6; g = 182; b = 212; // Vibrant Turquoise Lake
          } else if (elev <= world.seaLevelMeters) {
            r = 12; g = 30; b = 65;
          } else {
            const baseColor = sampleColorRamp(ELEVATION_STOPS, elev);
            r = Math.round(baseColor.r * 0.45);
            g = Math.round(baseColor.g * 0.45);
            b = Math.round(baseColor.b * 0.45);
          }
          break;
        }

        case 'drainage_basins': {
          const elev = sampleCubedSphereField(grid, world.terrain.elevation, latRad, lonRad);
          if (elev <= world.seaLevelMeters) {
            r = 10; g = 25; b = 55;
          } else {
            const basinId = sampleCubedSphereNearest(grid, world.hydrology.drainageBasin, latRad, lonRad);
            if (basinId > 0) {
              const c = BASIN_PALETTE[(basinId - 1) % BASIN_PALETTE.length];
              r = c.r; g = c.g; b = c.b;
            } else {
              r = 80; g = 80; b = 80;
            }
          }
          break;
        }

        case 'temperature_monthly': {
          const monthIdx = Math.max(0, Math.min(11, selectedMonth));
          const tempField = world.climate.monthlyTemperature[monthIdx];
          const temp = sampleCubedSphereField(grid, tempField, latRad, lonRad);
          const c = sampleColorRamp(TEMPERATURE_STOPS, temp);
          r = c.r; g = c.g; b = c.b;
          break;
        }

        case 'precipitation_monthly': {
          const monthIdx = Math.max(0, Math.min(11, selectedMonth));
          const precipField = world.climate.monthlyPrecipitation[monthIdx];
          const precip = sampleCubedSphereField(grid, precipField, latRad, lonRad);
          const c = sampleColorRamp(PRECIPITATION_STOPS, precip);
          r = c.r; g = c.g; b = c.b;
          break;
        }

        case 'ice_thickness': {
          const elev = sampleCubedSphereField(grid, world.terrain.elevation, latRad, lonRad);
          const ice = sampleCubedSphereField(grid, world.climate.iceThickness, latRad, lonRad);

          if (ice > 0.05) {
            const t = Math.min(1.0, ice / 50.0); // 50m thick ice cap
            r = Math.round(180 * (1 - t) + 255 * t);
            g = Math.round(220 * (1 - t) + 255 * t);
            b = Math.round(250 * (1 - t) + 255 * t);
          } else if (elev <= world.seaLevelMeters) {
            r = 15; g = 40; b = 80;
          } else {
            r = 60; g = 70; b = 65;
          }
          break;
        }

        case 'biomes': {
          const biomeId = sampleCubedSphereNearest(grid, world.ecology.biomes, latRad, lonRad);
          const meta = BIOME_DEFINITIONS[biomeId] || BIOME_DEFINITIONS[0];
          r = meta.color.r;
          g = meta.color.g;
          b = meta.color.b;
          break;
        }
      }

      data[pixIdx + 0] = r;
      data[pixIdx + 1] = g;
      data[pixIdx + 2] = b;
      data[pixIdx + 3] = a;
    }
  }

  if (typeof ImageData !== 'undefined') {
    return new ImageData(data, width, height);
  }
  return { width, height, data } as any;
}

/**
 * Backward compatibility alias for Equal Earth
 */
export function rasterizeEqualEarthLayer(
  world: WorldV2,
  grid: CubedSphereGrid,
  options: RasterizeOptions
): ImageData {
  return rasterizeProjectedLayer(world, grid, {
    ...options,
    projection: options.projection || 'equal_earth',
  });
}

/**
 * Grayscale Heightmap Rasterizer
 * Exports normalized heightmaps for 3D game engines (Unreal, Unity, Godot) & DCC tools (Blender, World Machine).
 */
export function rasterizeHeightmap(
  world: WorldV2,
  grid: CubedSphereGrid,
  options: HeightmapExportOptions
): ImageData {
  const {
    width,
    height,
    projection = 'mercator',
    mode = 'normalized',
  } = options;

  const projDef = getProjection(projection);
  const data = new Uint8ClampedArray(width * height * 4);

  const { minX, maxX, minY, maxY } = projDef.extents;
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;

  const minElev = world.diagnostics?.minElevationM ?? -8000;
  const maxElev = world.diagnostics?.maxElevationM ?? 8000;
  const elevSpan = Math.max(1, maxElev - minElev);

  for (let py = 0; py < height; py++) {
    const normY = height === 1 ? maxY : maxY - (py / (height - 1)) * rangeY;
    const rowOffset = py * width * 4;

    for (let px = 0; px < width; px++) {
      const normX = width === 1 ? minX : minX + (px / (width - 1)) * rangeX;
      const pixIdx = rowOffset + px * 4;

      const inv = projDef.inverse(normX, normY);
      if (!inv) {
        data[pixIdx + 0] = 0;
        data[pixIdx + 1] = 0;
        data[pixIdx + 2] = 0;
        data[pixIdx + 3] = 0;
        continue;
      }

      const { latRad, lonRad } = inv;
      const elev = sampleCubedSphereField(grid, world.terrain.elevation, latRad, lonRad);

      let gray = 0;
      if (mode === 'normalized') {
        // Full range minElev -> 0, maxElev -> 255
        const norm = Math.max(0, Math.min(1, (elev - minElev) / elevSpan));
        gray = Math.round(norm * 255);
      } else if (mode === 'sea_level_centered') {
        // 0m sea level at 128. Land > 128, Ocean < 128
        if (elev >= world.seaLevelMeters) {
          const landNorm = Math.min(1, elev / Math.max(1000, maxElev));
          gray = Math.round(128 + landNorm * 127);
        } else {
          const oceanNorm = Math.min(1, Math.abs(elev) / Math.max(1000, Math.abs(minElev)));
          gray = Math.round(128 - oceanNorm * 128);
        }
      } else if (mode === 'raw_land_only') {
        // Ocean is black (0), Land is 1..255
        if (elev <= world.seaLevelMeters) {
          gray = 0;
        } else {
          const landNorm = Math.min(1, elev / Math.max(1000, maxElev));
          gray = Math.round(1 + landNorm * 254);
        }
      }

      data[pixIdx + 0] = gray;
      data[pixIdx + 1] = gray;
      data[pixIdx + 2] = gray;
      data[pixIdx + 3] = 255;
    }
  }

  if (typeof ImageData !== 'undefined') {
    return new ImageData(data, width, height);
  }
  return { width, height, data } as any;
}

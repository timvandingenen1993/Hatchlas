/**
 * High-resolution landscape render with anti-aliased river trees drawn over a raster base.
 */
import type { HighResMountainData } from '../terrain/highResMountainSimulator';
import { ELEVATION_STOPS, sampleColorRamp } from '../utils/colorRamps';

export interface RenderOptions {
  layer: 'elevation' | 'rivers' | 'precipitation' | 'erosion' | 'biomes' | 'composite';
  showHillshade?: boolean;
  sunAzimuthDeg?: number;
  sunAltitudeDeg?: number;
}

/**
 * Draw an anti-aliased, thickness-scaled river segment connecting cell (x0, y0) to receiver (x1, y1)
 */
function drawRiverSegment(
  pixels: Uint8ClampedArray,
  N: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  alpha: number
): void {
  const minX = Math.max(0, Math.min(x0, x1) - Math.ceil(radius));
  const maxX = Math.min(N - 1, Math.max(x0, x1) + Math.ceil(radius));
  const minY = Math.max(0, Math.min(y0, y1) - Math.ceil(radius));
  const maxY = Math.min(N - 1, Math.max(y0, y1) + Math.ceil(radius));

  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let t = 0;
      if (lenSq > 0) {
        t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lenSq));
      }
      const projX = x0 + t * dx;
      const projY = y0 + t * dy;
      const dist = Math.hypot(x - projX, y - projY);

      if (dist <= radius) {
        const falloff = Math.cos((dist / radius) * (Math.PI / 2));
        const a = alpha * Math.pow(falloff, 1.2);
        const idx = (y * N + x) * 4;

        pixels[idx + 0] = Math.round(pixels[idx + 0] * (1 - a) + r * a);
        pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - a) + g * a);
        pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - a) + b * a);
      }
    }
  }
}

/**
 * High-Resolution Geomorphic Landscape Renderer with Continuous Vector-Raster River Trees
 */
export function renderHighResLandscape(
  data: HighResMountainData,
  options: RenderOptions
): ImageData {
  const N = data.resolution;
  const dxM = (data.domainSizeKm * 1000.0) / N;
  const pixels = new Uint8ClampedArray(N * N * 4);

  const sunAzimuth = ((options.sunAzimuthDeg ?? 315) * Math.PI) / 180.0;
  const sunAltitude = ((options.sunAltitudeDeg ?? 45) * Math.PI) / 180.0;
  const lx = Math.cos(sunAltitude) * Math.sin(sunAzimuth);
  const ly = -Math.cos(sunAltitude) * Math.cos(sunAzimuth);
  const lz = Math.sin(sunAltitude);

  // 1. Render Base Raster Layer (Elevation, Precipitation, Erosion, Biomes)
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      const pixelIdx = idx * 4;
      const elev = data.elevation[idx];

      let r = 0, g = 0, b = 0, a = 255;

      switch (options.layer) {
        case 'elevation':
        case 'composite':
        case 'rivers': {
          const baseColor = sampleColorRamp(ELEVATION_STOPS, elev);
          r = options.layer === 'rivers' ? Math.round(baseColor.r * 0.40) : baseColor.r;
          g = options.layer === 'rivers' ? Math.round(baseColor.g * 0.40) : baseColor.g;
          b = options.layer === 'rivers' ? Math.round(baseColor.b * 0.40) : baseColor.b;

          if (options.showHillshade !== false && i > 1 && i < N - 2 && j > 1 && j < N - 2) {
            const eNW = data.elevation[(j - 1) * N + (i - 1)];
            const eN  = data.elevation[(j - 1) * N + i];
            const eNE = data.elevation[(j - 1) * N + (i + 1)];
            const eW  = data.elevation[j * N + (i - 1)];
            const eE  = data.elevation[j * N + (i + 1)];
            const eSW = data.elevation[(j + 1) * N + (i - 1)];
            const eS  = data.elevation[(j + 1) * N + i];
            const eSE = data.elevation[(j + 1) * N + (i + 1)];

            const dzdxFine = ((eNE + 2 * eE + eSE) - (eNW + 2 * eW + eSW)) / (8.0 * dxM);
            const dzdyFine = ((eSW + 2 * eS + eSE) - (eNW + 2 * eN + eNE)) / (8.0 * dxM);

            const eN2 = data.elevation[(j - 2) * N + i];
            const eS2 = data.elevation[(j + 2) * N + i];
            const eE2 = data.elevation[j * N + (i + 2)];
            const eW2 = data.elevation[j * N + (i - 2)];

            const dzdxReg = (eE2 - eW2) / (4.0 * dxM);
            const dzdyReg = (eS2 - eN2) / (4.0 * dxM);

            const dzdx = (dzdxFine * 0.70 + dzdxReg * 0.30) * 3.8;
            const dzdy = (dzdyFine * 0.70 + dzdyReg * 0.30) * 3.8;

            const nLen = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1.0);
            const nx = -dzdx / nLen;
            const ny = -dzdy / nLen;
            const nz = 1.0 / nLen;

            const dot = Math.max(0.0, nx * lx + ny * ly + nz * lz);
            const shade = 0.22 + 0.78 * Math.pow(dot, 0.90);

            r = Math.min(255, Math.round(r * shade));
            g = Math.min(255, Math.round(g * shade));
            b = Math.min(255, Math.round(b * shade));
          }
          break;
        }

        case 'precipitation': {
          const p = data.precipitation[idx]; // 180 to 4500 mm
          const t = Math.min(1.0, Math.max(0.0, (p - 200.0) / 3200.0));

          if (t < 0.33) {
            const f = t / 0.33;
            r = Math.round(217 * (1 - f) + 234 * f);
            g = Math.round(179 * (1 - f) + 215 * f);
            b = Math.round(129 * (1 - f) + 140 * f);
          } else if (t < 0.66) {
            const f = (t - 0.33) / 0.33;
            r = Math.round(234 * (1 - f) + 34 * f);
            g = Math.round(215 * (1 - f) + 160 * f);
            b = Math.round(140 * (1 - f) + 90 * f);
          } else {
            const f = (t - 0.66) / 0.34;
            r = Math.round(34 * (1 - f) + 14 * f);
            g = Math.round(160 * (1 - f) + 165 * f);
            b = Math.round(90 * (1 - f) + 233 * f);
          }
          break;
        }

        case 'erosion': {
          const eroded = data.erodedDepthM[idx]; // 0 to 650 m
          const t = Math.min(1.0, eroded / 500.0);
          r = Math.round(25 * (1 - t) + 245 * t);
          g = Math.round(30 * (1 - t) + 60 * t);
          b = Math.round(40 * (1 - t) + 60 * t);
          break;
        }

        case 'biomes': {
          const p = data.precipitation[idx];
          const tempC = data.temperatureC[idx];
          const ice = data.iceThicknessM[idx];

          if (ice > 5.0 || tempC < -2.0) {
            // Glacial ice cap & perennial snow
            r = 240; g = 245; b = 255;
          } else if (tempC < 4.0) {
            // Alpine Tundra & Rock Arêtes
            r = 156; g = 163; b = 175;
          } else if (tempC < 10.0) {
            // Montane Coniferous Forest / Taiga
            r = 30; g = 81; b = 40;
          } else {
            if (p > 1800.0) {
              // Temperate / Tropical Rainforest
              r = 16; g = 120; b = 45;
            } else if (p > 850.0) {
              // Woodland & Grassland
              r = 100; g = 160; b = 60;
            } else {
              // Rain shadow shrubland / semi-arid scrub
              r = 190; g = 160; b = 95;
            }
          }
          break;
        }
      }

      pixels[pixelIdx + 0] = r;
      pixels[pixelIdx + 1] = g;
      pixels[pixelIdx + 2] = b;
      pixels[pixelIdx + 3] = a;
    }
  }

  // 2. Vector-Raster River Tree Rendering (Connecting every channel directly to receiver)
  if (options.layer === 'rivers' || options.layer === 'composite') {
    // Sort cells by drainage area ascending so main river arteries draw over headwater tributaries
    const riverIndices: number[] = [];
    for (let idx = 0; idx < N * N; idx++) {
      if (data.drainageAreaKm2[idx] >= 12.0 && data.flowReceivers[idx] >= 0) {
        riverIndices.push(idx);
      }
    }
    riverIndices.sort((a, b) => data.drainageAreaKm2[a] - data.drainageAreaKm2[b]);

    for (const idx of riverIndices) {
      const recIdx = data.flowReceivers[idx];
      const x0 = idx % N;
      const y0 = Math.floor(idx / N);
      const x1 = recIdx % N;
      const y1 = Math.floor(recIdx / N);

      // Skip boundary wrap edges
      if (Math.abs(x1 - x0) > 2 || Math.abs(y1 - y0) > 2) continue;

      const area = data.drainageAreaKm2[idx];
      const logA = Math.log10(Math.max(12.0, area));
      // Continuous scaling factor in [0, 1] for 12 km^2 to 25,000 km^2
      const t = Math.min(1.0, Math.max(0.0, (logA - 1.08) / 3.3));

      // Dynamic river width: 0.9px for mountain brooks -> 4.5px for major trunk rivers
      const radius = 0.90 + t * 3.5;

      const riverR = Math.round(15 * (1 - t) + 6 * t);
      const riverG = Math.round(180 * (1 - t) + 235 * t);
      const riverB = Math.round(245 * (1 - t) + 255 * t);
      const alpha = Math.min(1.0, 0.70 + t * 0.30);

      drawRiverSegment(pixels, N, x0, y0, x1, y1, radius, riverR, riverG, riverB, alpha);
    }
  }

  if (typeof ImageData !== 'undefined') {
    return new ImageData(pixels, N, N);
  }
  return {
    data: pixels,
    width: N,
    height: N,
    colorSpace: 'srgb',
  } as ImageData;
}

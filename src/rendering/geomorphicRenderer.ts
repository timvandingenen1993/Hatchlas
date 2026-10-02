/**
 * Geomorphic DEM renderer: hypsometric palettes, relief shading modes, rivers and contours.
 */
import type { GeomorphicLandscapeData } from '../terrain/geomorphicLandscapeEngine';

export type ReliefShadingMode = 'swiss_multidirectional' | 'ambient_occlusion' | 'classic';
export type GeomorphicPalette = 'european_topo' | 'swiss_alpine' | 'physical_satellite' | 'high_contrast';

export interface GeomorphicRenderOptions {
  sunAzimuthDeg?: number;
  sunAltitudeDeg?: number;
  verticalExaggeration?: number;
  showRivers?: boolean;
  shadingMode?: ReliefShadingMode;
  palette?: GeomorphicPalette;
  ambientOcclusionStrength?: number; // 0.0 to 1.0
}

// 1. European Topographic DEM Palette (Matching classic European DEM maps & user reference)
const EUROPEAN_TOPO_STOPS: [number, { r: number; g: number; b: number }][] = [
  [80,   { r: 72,  g: 142, b: 68 }],   // Deep lush lowland green
  [180,  { r: 118, g: 172, b: 85 }],   // Meadow green
  [340,  { r: 178, g: 206, b: 112 }],  // Pale yellow-green terrace
  [560,  { r: 232, g: 222, b: 142 }],  // Warm buff / ochre foothill
  [900,  { r: 224, g: 155, b: 72 }],   // Amber plateau & spur
  [1350, { r: 196, g: 96,  b: 38 }],   // Terracotta mountain ridge
  [1850, { r: 148, g: 44,  b: 20 }],   // Rust red alpine arête
  [2550, { r: 86,  g: 18,  b: 8 }],    // Deep burnt umber summit
];

// 2. Swiss Alpine Relief Palette
const SWISS_ALPINE_STOPS: [number, { r: number; g: number; b: number }][] = [
  [80,   { r: 90,  g: 140, b: 80 }],
  [250,  { r: 140, g: 180, b: 100 }],
  [600,  { r: 205, g: 215, b: 150 }],
  [1100, { r: 215, g: 205, b: 175 }],
  [1600, { r: 175, g: 165, b: 155 }],
  [2100, { r: 135, g: 130, b: 130 }],
  [2700, { r: 240, g: 245, b: 250 }],
];

// 3. Physical Satellite Palette
const PHYSICAL_SATELLITE_STOPS: [number, { r: number; g: number; b: number }][] = [
  [80,   { r: 45,  g: 95,  b: 40 }],
  [300,  { r: 75,  g: 125, b: 55 }],
  [700,  { r: 135, g: 145, b: 80 }],
  [1200, { r: 165, g: 140, b: 90 }],
  [1800, { r: 140, g: 110, b: 80 }],
  [2400, { r: 110, g: 95,  b: 85 }],
  [2800, { r: 225, g: 235, b: 245 }],
];

// 4. High-Contrast Geomorphology Palette
const HIGH_CONTRAST_STOPS: [number, { r: number; g: number; b: number }][] = [
  [80,   { r: 40,  g: 130, b: 60 }],
  [220,  { r: 100, g: 180, b: 70 }],
  [500,  { r: 240, g: 230, b: 110 }],
  [1000, { r: 240, g: 140, b: 40 }],
  [1600, { r: 210, g: 50,  b: 20 }],
  [2200, { r: 120, g: 20,  b: 15 }],
  [2700, { r: 60,  g: 10,  b: 10 }],
];

function sampleRamp(stops: [number, { r: number; g: number; b: number }][], elevation: number): { r: number; g: number; b: number } {
  if (elevation <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (elevation >= last[0]) return last[1];

  for (let i = 0; i < stops.length - 1; i++) {
    const [h0, c0] = stops[i];
    const [h1, c1] = stops[i + 1];
    if (elevation >= h0 && elevation <= h1) {
      const t = (elevation - h0) / (h1 - h0);
      return {
        r: Math.round(c0.r * (1 - t) + c1.r * t),
        g: Math.round(c0.g * (1 - t) + c1.g * t),
        b: Math.round(c0.b * (1 - t) + c1.b * t),
      };
    }
  }
  return last[1];
}

function getPaletteStops(palette?: GeomorphicPalette): [number, { r: number; g: number; b: number }][] {
  switch (palette) {
    case 'swiss_alpine': return SWISS_ALPINE_STOPS;
    case 'physical_satellite': return PHYSICAL_SATELLITE_STOPS;
    case 'high_contrast': return HIGH_CONTRAST_STOPS;
    case 'european_topo':
    default:
      return EUROPEAN_TOPO_STOPS;
  }
}

/**
 * Continuous Anti-Aliased 2D Capsule Segment Drawing for Crisp Sinuous River Networks
 */
function drawContinuousSegment(
  pixels: Uint8ClampedArray,
  N: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  coreRadius: number,
  outlineRadius: number,
  coreR: number,
  coreG: number,
  coreB: number,
  outlineR: number,
  outlineG: number,
  outlineB: number
): void {
  const minX = Math.max(0, Math.min(x0, x1) - Math.ceil(outlineRadius) - 1);
  const maxX = Math.min(N - 1, Math.max(x0, x1) + Math.ceil(outlineRadius) + 1);
  const minY = Math.max(0, Math.min(y0, y1) - Math.ceil(outlineRadius) - 1);
  const maxY = Math.min(N - 1, Math.max(y0, y1) + Math.ceil(outlineRadius) + 1);

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

      if (dist <= outlineRadius) {
        const idx = (y * N + x) * 4;

        if (dist <= coreRadius) {
          // Core water body (vibrant cobalt/royal blue)
          const falloff = Math.cos((dist / coreRadius) * (Math.PI / 2));
          const a = 0.88 + 0.12 * falloff;
          pixels[idx + 0] = Math.round(pixels[idx + 0] * (1 - a) + coreR * a);
          pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - a) + coreG * a);
          pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - a) + coreB * a);
        } else {
          // Dark riverbank outline
          const edgeDist = (dist - coreRadius) / Math.max(0.001, outlineRadius - coreRadius);
          const a = 0.75 * Math.pow(1.0 - edgeDist, 1.3);
          pixels[idx + 0] = Math.round(pixels[idx + 0] * (1 - a) + outlineR * a);
          pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - a) + outlineG * a);
          pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - a) + outlineB * a);
        }
      }
    }
  }
}

/**
 * Render High-Resolution Geomorphic Landscape Matching Classic Scientific Geomorphological DEM Maps
 */
export function renderGeomorphicDEM(
  data: GeomorphicLandscapeData,
  options: GeomorphicRenderOptions = {}
): ImageData {
  const N = data.resolution;
  const dxM = (data.domainSizeKm * 1000.0) / N;
  const pixels = new Uint8ClampedArray(N * N * 4);

  const stops = getPaletteStops(options.palette);
  const shadingMode = options.shadingMode ?? 'swiss_multidirectional';
  const vertExagg = options.verticalExaggeration ?? 3.8;
  const aoStrength = options.ambientOcclusionStrength ?? 0.45;

  // Primary Sun Vector (Key Light from NW: 315° default)
  const sunAzimuth = ((options.sunAzimuthDeg ?? 315) * Math.PI) / 180.0;
  const sunAltitude = ((options.sunAltitudeDeg ?? 45) * Math.PI) / 180.0;
  const lx1 = Math.cos(sunAltitude) * Math.sin(sunAzimuth);
  const ly1 = -Math.cos(sunAltitude) * Math.cos(sunAzimuth);
  const lz1 = Math.sin(sunAltitude);

  // Secondary Warm Fill Vector (WSW: sunAzimuth - 75°)
  const azFill = sunAzimuth - (75.0 * Math.PI) / 180.0;
  const altFill = (30.0 * Math.PI) / 180.0;
  const lx2 = Math.cos(altFill) * Math.sin(azFill);
  const ly2 = -Math.cos(altFill) * Math.cos(azFill);
  const lz2 = Math.sin(altFill);

  // Tertiary Cool Backlight Vector (NNE: sunAzimuth + 75°)
  const azBack = sunAzimuth + (75.0 * Math.PI) / 180.0;
  const altBack = (60.0 * Math.PI) / 180.0;
  const lx3 = Math.cos(altBack) * Math.sin(azBack);
  const ly3 = -Math.cos(altBack) * Math.cos(azBack);
  const lz3 = Math.sin(altBack);

  // 1. Render Base Hypsometric Color & Multi-Scale Directional Hillshade
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      const pixelIdx = idx * 4;
      const elev = data.elevation[idx];

      const baseColor = sampleRamp(stops, elev);
      let r = baseColor.r;
      let g = baseColor.g;
      let b = baseColor.b;

      if (i > 1 && i < N - 2 && j > 1 && j < N - 2) {
        // Fine stencil (3x3 Sobel) for knife-edge ridges and river gorges
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

        // Regional stencil (5x5) for large-scale mountain massifs and slopes
        const eN2 = data.elevation[(j - 2) * N + i];
        const eS2 = data.elevation[(j + 2) * N + i];
        const eE2 = data.elevation[j * N + (i + 2)];
        const eW2 = data.elevation[j * N + (i - 2)];

        const dzdxReg = (eE2 - eW2) / (4.0 * dxM);
        const dzdyReg = (eS2 - eN2) / (4.0 * dxM);

        const dzdx = (dzdxFine * 0.75 + dzdxReg * 0.25) * vertExagg;
        const dzdy = (dzdyFine * 0.75 + dzdyReg * 0.25) * vertExagg;

        const nLen = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1.0);
        const nx = -dzdx / nLen;
        const ny = -dzdy / nLen;
        const nz = 1.0 / nLen;

        let totalShade = 1.0;

        if (shadingMode === 'swiss_multidirectional') {
          // Swiss 3-Source Relief Shading (Imhof Style)
          const dot1 = Math.max(0.0, nx * lx1 + ny * ly1 + nz * lz1);
          const dot2 = Math.max(0.0, nx * lx2 + ny * ly2 + nz * lz2);
          const dot3 = Math.max(0.0, nx * lx3 + ny * ly3 + nz * lz3);

          const keyShade = Math.pow(dot1, 0.85);
          const fillShade = Math.pow(dot2, 0.75);
          const backShade = Math.pow(dot3, 0.65);

          totalShade = 0.22 + 0.56 * keyShade + 0.14 * fillShade + 0.08 * backShade;
        } else if (shadingMode === 'classic') {
          // Classic Single-Source Lambertian Hillshade
          const dot = Math.max(0.0, nx * lx1 + ny * ly1 + nz * lz1);
          totalShade = 0.25 + 0.75 * Math.pow(dot, 0.85);
        } else {
          // Ambient Occlusion / Openness Mode
          const dot = Math.max(0.0, nx * lx1 + ny * ly1 + nz * lz1);
          totalShade = 0.35 + 0.65 * dot;
        }

        // Topographic Ambient Occlusion (Valley darkening & ridge highlighting)
        if (aoStrength > 0.01) {
          const meanNeighborH = (eNW + eN + eNE + eW + eE + eSW + eS + eSE) / 8.0;
          const diff = elev - meanNeighborH;
          // Valley depression (diff < 0) gets shadow; ridge crest (diff > 0) gets highlight
          const ao = 1.0 + Math.max(-0.45, Math.min(0.40, (diff / (dxM * 0.45)))) * aoStrength;
          totalShade *= ao;
        }

        r = Math.min(255, Math.max(0, Math.round(r * totalShade)));
        g = Math.min(255, Math.max(0, Math.round(g * totalShade)));
        b = Math.min(255, Math.max(0, Math.round(b * totalShade)));
      }

      pixels[pixelIdx + 0] = r;
      pixels[pixelIdx + 1] = g;
      pixels[pixelIdx + 2] = b;
      pixels[pixelIdx + 3] = 255;
    }
  }

  // 2. Render Continuous Vector River Networks (Polylines)
  if (options.showRivers !== false) {
    // Sort polylines by order ascending so main trunk rivers draw over smaller tributaries
    const sortedLines = [...data.riverPolylines].sort((a, b) => a.order - b.order);

    for (const line of sortedLines) {
      const pts = line.points;
      const order = line.order;
      const area = line.maxAreaKm2;
      const isTrunk = line.isTrunk;

      let coreRadius = 0.55;
      let outlineRadius = 1.1;
      let coreR = 38, coreG = 95, coreB = 220;
      let outlineR = 15, outlineG = 35, outlineB = 85;

      if (order >= 6 || isTrunk || area >= 1500) {
        // Major Meandering Trunk River (Vibrant royal blue with solid banks)
        coreRadius = 3.2;
        outlineRadius = 4.8;
        coreR = 30; coreG = 75; coreB = 230;
        outlineR = 10; outlineG = 25; outlineB = 80;
      } else if (order >= 5 || area >= 400) {
        // Large Tributary River
        coreRadius = 2.1;
        outlineRadius = 3.2;
        coreR = 34; coreG = 82; coreB = 220;
        outlineR = 12; outlineG = 28; outlineB = 80;
      } else if (order >= 4 || area >= 100) {
        // Secondary River Branch
        coreRadius = 1.4;
        outlineRadius = 2.2;
        coreR = 38; coreG = 88; coreB = 210;
        outlineR = 15; outlineG = 32; outlineB = 82;
      } else if (order >= 3 || area >= 22) {
        // Mountain Stream
        coreRadius = 0.95;
        outlineRadius = 1.6;
        coreR = 44; coreG = 92; coreB = 200;
        outlineR = 18; outlineG = 36; outlineB = 85;
      } else if (order >= 2 || area >= 5) {
        // Valley Brook
        coreRadius = 0.65;
        outlineRadius = 1.2;
        coreR = 40; coreG = 80; coreB = 180;
        outlineR = 22; outlineG = 42; outlineB = 92;
      } else {
        // Headwater Rill / Mountain Gully
        coreRadius = 0.45;
        outlineRadius = 0.9;
        coreR = 35; coreG = 75; coreB = 160;
        outlineR = 25; outlineG = 45; outlineB = 95;
      }

      for (let p = 0; p < pts.length - 1; p++) {
        const p0 = pts[p];
        const p1 = pts[p + 1];
        drawContinuousSegment(pixels, N, p0.x, p0.y, p1.x, p1.y, coreRadius, outlineRadius, coreR, coreG, coreB, outlineR, outlineG, outlineB);
      }
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


/**
 * Linear theory of orographic precipitation.
 *
 * Smith RB, Barstad I (2004) A Linear Theory of Orographic Precipitation.
 * J Atmos Sci 61(12):1377–1391.
 *
 * The transfer function and parameter values follow the reference
 * implementation fastscape-lem/orographic-precipitation
 * (https://github.com/fastscape-lem/orographic-precipitation):
 *
 *   MIT License, Copyright (c) 2020 Raphael Lange
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit
 *   persons to whom the Software is furnished to do so, subject to the
 *   following conditions: The above copyright notice and this permission
 *   notice shall be included in all copies or substantial portions of the
 *   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 */

export interface OrographicPrecipitationParams {
  /** Wind speed, m/s. */
  windSpeedMs: number;
  /** Direction the wind blows from, degrees clockwise from north (grid up). */
  windFromDeg: number;
  /** Latitude for the Coriolis parameter, degrees. */
  latitudeDeg?: number;
  /** Cloud water to hydrometeor conversion time, s. */
  conversionTimeS?: number;
  /** Hydrometeor fallout time, s. */
  fallTimeS?: number;
  /** Moist stability (Brunt–Väisälä) frequency, 1/s. */
  moistStability?: number;
  /** Water vapour scale height, m. */
  waterVapourScaleHeightM?: number;
  /** Uplift sensitivity Cw, kg/m³. */
  upliftSensitivity?: number;
  /** Background (non-orographic) precipitation rate during events, mm/h. */
  backgroundRateMmH?: number;
  /** Minimum precipitation rate, mm/h. */
  minimumRateMmH?: number;
}

// Values from the reference implementation's test fixture: conversion and
// fallout times 1000 s, Nm 0.005 1/s, Hw 2500 m, and
// Cw = ref_density · Γm / γ = 7.4e-3 · (−6.5) / (−5.8) kg/m³.
export const OROGRAPHIC_DEFAULTS = {
  latitudeDeg: 0,
  conversionTimeS: 1000,
  fallTimeS: 1000,
  moistStability: 0.005,
  waterVapourScaleHeightM: 2500,
  upliftSensitivity: (7.4e-3 * -6.5e-3) / -5.8e-3,
  // Background rate from the reference's basic-usage example notebook.
  backgroundRateMmH: 7,
  minimumRateMmH: 0.01,
} as const;

const EARTH_ROTATION_RAD_S = 7.2921e-5;
const MAXIMUM_PAD_CELLS = 200;

/**
 * Precipitation rate (mm/h) during precipitation events over a regular grid
 * of elevations (m, row-major, row 0 at the top/north). Matches
 * `compute_orographic_precip` of the reference implementation.
 */
export function computeOrographicPrecipitationRate(
  elevationM: Float32Array | Float64Array,
  width: number,
  height: number,
  dxM: number,
  dyM: number,
  params: OrographicPrecipitationParams,
): Float32Array {
  const settings = { ...OROGRAPHIC_DEFAULTS, ...stripUndefined(params) } as Required<OrographicPrecipitationParams>;
  const windRad = (settings.windFromDeg * Math.PI) / 180;
  // Velocity towards which the air moves, in grid axes (x east, y down/south).
  const u0 = -Math.sin(windRad) * settings.windSpeedMs;
  const v0 = Math.cos(windRad) * settings.windSpeedMs;
  const coriolis = 2 * EARTH_ROTATION_RAD_S * Math.sin((settings.latitudeDeg * Math.PI) / 180);

  // Pad like the reference (half the summed shape, at most 200 cells), then
  // up to a power of two for the radix-2 FFT. The reference pads with 0 m,
  // which suits landscapes ringed by sea level but puts an artificial cliff
  // at every land edge of a cropped heightmap. Instead the padding continues
  // each edge's own height and blends smoothly to the opposite edge, so the
  // periodic transform wraps without a step. Sea-level edges still pad to 0.
  const pad = Math.min(Math.ceil((width + height) / 2), MAXIMUM_PAD_CELLS);
  const paddedWidth = nextPowerOfTwo(width + 2 * pad);
  const paddedHeight = nextPowerOfTwo(height + 2 * pad);
  const total = paddedWidth * paddedHeight;
  const real = new Float64Array(total);
  const imag = new Float64Array(total);
  const padX = paddedWidth - width;
  const padY = paddedHeight - height;
  for (let y = 0; y < height; y++) {
    const row = (y + pad) * paddedWidth;
    for (let x = 0; x < width; x++) {
      real[row + x + pad] = elevationM[y * width + x];
    }
    // Columns after the east edge wrap round to the west edge.
    const east = elevationM[y * width + width - 1];
    const west = elevationM[y * width];
    for (let step = 0; step < padX; step++) {
      const column = (pad + width + step) % paddedWidth;
      real[row + column] = east + (west - east) * smoothBlend((step + 1) / (padX + 1));
    }
  }
  for (let column = 0; column < paddedWidth; column++) {
    const south = real[(pad + height - 1) * paddedWidth + column];
    const north = real[pad * paddedWidth + column];
    for (let step = 0; step < padY; step++) {
      const row = (pad + height + step) % paddedHeight;
      real[row * paddedWidth + column] = south + (north - south) * smoothBlend((step + 1) / (padY + 1));
    }
  }

  fft2d(real, imag, paddedWidth, paddedHeight, false);

  const lengthX = paddedWidth * dxM;
  const lengthY = paddedHeight * dyM;
  const epsilon = Number.EPSILON;
  const cw = settings.upliftSensitivity;
  const hw = settings.waterVapourScaleHeightM;
  const tauC = settings.conversionTimeS;
  const tauF = settings.fallTimeS;
  const nm2 = settings.moistStability * settings.moistStability;
  for (let row = 0; row < paddedHeight; row++) {
    const ky = (2 * Math.PI * fftFrequencyIndex(row, paddedHeight)) / lengthY;
    for (let column = 0; column < paddedWidth; column++) {
      const kx = (2 * Math.PI * fftFrequencyIndex(column, paddedWidth)) / lengthX;
      const index = row * paddedWidth + column;
      const sigma = kx * u0 + ky * v0;
      let numerator = nm2 - sigma * sigma;
      if (numerator < 0) numerator = 0;
      let denominator = sigma * sigma - coriolis * coriolis;
      if (denominator >= 0 && denominator < epsilon) denominator = epsilon;
      if (denominator < 0 && denominator > -epsilon) denominator = -epsilon;
      const m = (sigma >= 0 ? 1 : -1) *
        Math.sqrt(Math.abs((numerator / denominator) * (kx * kx + ky * ky)));

      // P̂ = Cw·iσ·ĥ / ((1 − i·m·Hw)(1 + i·σ·τc)(1 + i·σ·τf))
      const hRe = real[index];
      const hIm = imag[index];
      // numerator: Cw·iσ·ĥ
      let nRe = -cw * sigma * hIm;
      let nIm = cw * sigma * hRe;
      // denominator product of three complex factors
      const [d1Re, d1Im] = [1, -m * hw];
      const [d2Re, d2Im] = [1, sigma * tauC];
      const [d3Re, d3Im] = [1, sigma * tauF];
      const d12Re = d1Re * d2Re - d1Im * d2Im;
      const d12Im = d1Re * d2Im + d1Im * d2Re;
      const dRe = d12Re * d3Re - d12Im * d3Im;
      const dIm = d12Re * d3Im + d12Im * d3Re;
      const dNorm = dRe * dRe + dIm * dIm;
      const qRe = (nRe * dRe + nIm * dIm) / dNorm;
      const qIm = (nIm * dRe - nRe * dIm) / dNorm;
      nRe = qRe;
      nIm = qIm;
      real[index] = nRe;
      imag[index] = nIm;
    }
  }

  fft2d(real, imag, paddedWidth, paddedHeight, true);

  // kg m⁻² s⁻¹ equals mm/s; convert to mm/h and add the background rate.
  const rate = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = real[(y + pad) * paddedWidth + x + pad] * 3600 + settings.backgroundRateMmH;
      rate[y * width + x] = value <= 0 ? settings.minimumRateMmH : value;
    }
  }
  return rate;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function smoothBlend(t: number): number {
  return t * t * (3 - 2 * t);
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

/** numpy.fft.fftfreq(n, 1/n): 0, 1, …, n/2−1, −n/2, …, −1. */
function fftFrequencyIndex(index: number, n: number): number {
  return index < n / 2 ? index : index - n;
}

/** In-place 2D FFT over rows then columns; the inverse is normalised by 1/N. */
function fft2d(
  real: Float64Array,
  imag: Float64Array,
  width: number,
  height: number,
  inverse: boolean,
): void {
  const rowRe = new Float64Array(width);
  const rowIm = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    const offset = y * width;
    rowRe.set(real.subarray(offset, offset + width));
    rowIm.set(imag.subarray(offset, offset + width));
    fft1d(rowRe, rowIm, inverse);
    real.set(rowRe, offset);
    imag.set(rowIm, offset);
  }
  const columnRe = new Float64Array(height);
  const columnIm = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      columnRe[y] = real[y * width + x];
      columnIm[y] = imag[y * width + x];
    }
    fft1d(columnRe, columnIm, inverse);
    for (let y = 0; y < height; y++) {
      real[y * width + x] = columnRe[y];
      imag[y * width + x] = columnIm[y];
    }
  }
}

/** Iterative radix-2 Cooley–Tukey FFT; length must be a power of two. */
function fft1d(real: Float64Array, imag: Float64Array, inverse: boolean): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    const half = size >> 1;
    for (let start = 0; start < n; start += size) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const tRe = real[b] * wRe - imag[b] * wIm;
        const tIm = real[b] * wIm + imag[b] * wRe;
        real[b] = real[a] - tRe;
        imag[b] = imag[a] - tIm;
        real[a] += tRe;
        imag[a] += tIm;
        const nextRe = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = nextRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

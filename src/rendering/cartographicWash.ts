import { SimplexNoise } from '../core/noise';
import { clamp01, hash01 } from './cartographicStrokeRenderer';

/** Shared wetland/mountain pigment grain, evaluated in the unwarped map domain. */
export function sampleCartographicGrain(
  noise: SimplexNoise, x: number, y: number, pixelIndex: number, seed: number, patternScale = 1,
): number {
  const scale = Math.max(1.6, 2.6 / patternScale);
  const coarse = clamp01(0.5 + noise.fbm(x / scale, y / scale, 3, 1.9, 0.56) * 0.5);
  const fine = hash01(pixelIndex, seed + 3379);
  return (coarse * 0.48 + fine * 0.52) * 2 - 1;
}

export function sampleCartographicWashNoise(noise: SimplexNoise, x: number, y: number, scale: number): number {
  const warp = noise.domainWarp(x / scale, y / scale, 0.38);
  return clamp01(0.5 + noise.fbm(warp.x, warp.y, 3, 1.9, 0.55) * 0.5) * 2 - 1;
}

/** The two warped scales used for wetland dry patches and broken snow edges. */
export function sampleCartographicPatchNoise(noise: SimplexNoise, x: number, y: number, scale: number): number {
  const coarse = noise.domainWarp(x / scale, y / scale, 0.6);
  const fine = noise.domainWarp(x / (scale * 0.42), y / (scale * 0.42), 0.35);
  const coarseValue = noise.fbm(coarse.x, coarse.y, 3, 1.95, 0.56);
  const fineValue = noise.fbm(fine.x, fine.y, 2, 1.9, 0.5);
  return clamp01(0.5 + (coarseValue * 0.68 + fineValue * 0.32) * 0.5);
}

/** Grain modulates transitions; pure material endpoints remain stable. */
export function filterCartographicGradient(value: number, grain: number): number {
  return clamp01(value + grain * 0.22 * (4 * value * (1 - value)));
}

export function filterCartographicSignedGradient(value: number, grain: number): number {
  return Math.max(-1, Math.min(1, value + grain * 0.22 * (1 - value * value)));
}

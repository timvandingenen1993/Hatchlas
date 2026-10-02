/**
 * Lighting remaps for the illustrated mountain surface.
 *
 * The geometry still receives a continuous normal/light calculation. These
 * modes only decide how that value becomes pigment, so snow coverage, depth,
 * silhouettes, and linework remain independent of the chosen art direction.
 */
export type MountainLightingMode = 'continuous' | 'three-tone' | 'two-tone';

/** Default for the illustrated renderer: a legible, drawn two-value face. */
export const DEFAULT_MOUNTAIN_LIGHTING_MODE: MountainLightingMode = 'two-tone';

export const MOUNTAIN_LIGHTING_MODES: readonly MountainLightingMode[] = [
  'two-tone',
  'three-tone',
  'continuous',
];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/**
 * Convert a physical light value into a stable illustrated value.
 *
 * The intermediate values are deliberately separated from the palette so
 * each renderer can use its own colors while sharing the same thresholds.
 */
export function stylizeMountainLight(
  light: number,
  mode: MountainLightingMode = 'continuous',
): number {
  const value = clamp01(light);
  if (mode === 'two-tone') return value >= 0.5 ? 0.84 : 0.24;
  if (mode === 'three-tone') return value >= 0.62 ? 1 : value >= 0.30 ? 0.5 : 0;
  return value;
}

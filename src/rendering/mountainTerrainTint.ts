/**
 * Ground color for the mountain illustration, from slope, elevation and biome inputs.
 */
export type TintRGB = [number, number, number];

export interface MountainTerrainTintInput {
  slopeDeg: number;
  /** 0..1 position in the DEM's elevation range, so it adapts to any map size. */
  normElev: number;
  /** Topographic position in meters: positive on ridges, negative in gullies. */
  tpi: number;
  /** 0..1 incident sun index. */
  insolation: number;
  /** Signed -1..1 pigment noise. */
  noise: number;
}

// Tuning knobs. Slope bands are in degrees, strengths are mix fractions.
const FLAT_SLOPE = [6, 16] as const;
const STEEP_SLOPE = [28, 45] as const;
const GREEN_FADE_ELEV = [0.55, 0.85] as const;
const COOL_ELEV = [0.5, 1] as const;
const GREEN_STRENGTH = 0.6;
const STEEP_COOL_STRENGTH = 0.35;
const ELEV_COOL_STRENGTH = 0.22;
const COOL_GREY_SHIFT: TintRGB = [0.94, 1, 1.1];

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function luminance(color: TintRGB): number {
  return color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114;
}

/**
 * Modulates a land color by local terrain instead of painting one flat color
 * per biome: flat low ground turns green, steep faces and high ground go cool
 * grey (Imhof-style aerial perspective), ridges/sunny slopes warm, gullies and
 * shaded slopes cool and dark. `green` is the palette's meadow/woodland color.
 * Shading in `base` is preserved by matching the green to its luminance.
 */
export function tintMountainLand(
  base: Readonly<TintRGB>,
  input: MountainTerrainTintInput,
  green: Readonly<TintRGB>,
): TintRGB {
  const baseLum = luminance(base as TintRGB);
  const flat = 1 - smoothstep(FLAT_SLOPE[0], FLAT_SLOPE[1], input.slopeDeg);
  const steep = smoothstep(STEEP_SLOPE[0], STEEP_SLOPE[1], input.slopeDeg);
  const highness = smoothstep(COOL_ELEV[0], COOL_ELEV[1], input.normElev);
  const ridge = Math.max(-1, Math.min(1, input.tpi / 60));

  let r = base[0], g = base[1], b = base[2];

  // Flat, low-to-mid ground and gullies: green at the base's own brightness.
  const greenLum = Math.max(1, luminance(green as TintRGB));
  const greenGain = Math.max(0.5, Math.min(1.6, baseLum / greenLum));
  const greenAmount = Math.max(0, Math.min(1,
    (flat * GREEN_STRENGTH + Math.max(0, -ridge) * 0.15)
    * (1 - smoothstep(GREEN_FADE_ELEV[0], GREEN_FADE_ELEV[1], input.normElev))
    * (1 + input.noise * 0.35)));
  r += (green[0] * greenGain - r) * greenAmount;
  g += (green[1] * greenGain - g) * greenAmount;
  b += (green[2] * greenGain - b) * greenAmount;

  // Steep faces and high ground: desaturate toward a cool grey of the same value.
  const lum = luminance([r, g, b]);
  const coolAmount = Math.min(1, steep * STEEP_COOL_STRENGTH + highness * ELEV_COOL_STRENGTH);
  r += (lum * COOL_GREY_SHIFT[0] - r) * coolAmount;
  g += (lum * COOL_GREY_SHIFT[1] - g) * coolAmount;
  b += (lum * COOL_GREY_SHIFT[2] - b) * coolAmount;

  // Sun-facing warm / shaded cool, ridges light, gullies dark, then grain.
  const warmth = (input.insolation - 0.5) * 2;
  const value = 1 + ridge * 0.08 + input.noise * 0.08;
  r *= value * (1 + warmth * 0.08 + input.noise * 0.03);
  g *= value * (1 + warmth * 0.03);
  b *= value * (1 - warmth * 0.08 - input.noise * 0.03);

  return [
    Math.max(0, Math.min(255, r)),
    Math.max(0, Math.min(255, g)),
    Math.max(0, Math.min(255, b)),
  ];
}

/**
 * Procedural pen-and-ink dunes for Sand Desert & Dunes (biome 15).
 *
 * Dunes are not drawn with the vegetation flow lines: those are seeded at a
 * fixed pixel spacing, so their count grows with map resolution while dunes
 * should keep a fixed physical size. Instead every pixel evaluates a dune
 * phase (one turn per crest) and inks a fixed set of features per dune:
 *
 * - one crisp crest (brink) line, scalloped into lobes whose horns point
 *   downwind;
 * - slip-face hatching on the downwind side, darkest under the crest and
 *   fading out, plus a little stipple;
 * - a few faint, broken ripple lines on the long windward side.
 *
 * Everything is keyed to shared source coordinates and physical spacing, so
 * preview, export tiles and resolutions agree.
 */
import { SimplexNoise } from "../core/noise";
import type { MountainDEMData } from "../terrain/mountainBaseDEM";
import { hash01 } from "./cartographicStrokeRenderer";

/** Sand Desert & Dunes. Rocky desert (16) keeps the flow-line marks. */
export const DESERT_DUNE_BIOME_ID = 15;

export interface DesertDuneOptions {
  /** Draw procedural dunes in sand desert. Off falls back to flow-line marks. */
  desertDunes?: boolean;
  /** Distance between crests, km. */
  desertDuneSpacingKm?: number;
  /** Compass direction the wind blows from, degrees (0 = north). */
  desertWindFromDeg?: number;
  /** 0 straight crests, 1 deeply scalloped crests with long horns. */
  desertCrestScallop?: number;
  /** 0 ignores terrain, 1 bends crests strongly along slopes. */
  desertTerrainFollowing?: number;
  /** Slip-face shadow depth as a share of the crest spacing. */
  desertShadowLength?: number;
  /** 0 to 1: darkness of slip-face hatching and stipple. */
  desertShadowStrength?: number;
  /** Hatch lines per unit; 1 is about one line every 3 pixels. */
  desertHatchDensity?: number;
  /** Faint windward ripple lines per dune, 0 to 3. */
  desertRippleLines?: number;
  /** 0 to 1: wash light on windward slopes, brightest at the crest. */
  desertHighlight?: number;
  /** 0 to 1: wash shade on slip faces, under the hatching. */
  desertWashShadow?: number;
  /** 0 to 1: how often crest and ripple lines break, with tapered gaps. */
  desertLineBreaks?: number;
  /** 0 to 1: dotted trails through gaps and faded crest ends, plus scattered sand dots. */
  desertDots?: number;
  /** 0 to 1: large patches where the sand drifts towards the spot colour. */
  desertColorVariation?: number;
  /** Typical size of those colour patches, km. */
  desertColorScaleKm?: number;
  /** Hex colour of the reddish-brown sand patches. */
  desertSpotColor?: string;
}

export interface ResolvedDesertDuneOptions {
  enabled: boolean;
  spacingKm: number;
  windFromDeg: number;
  crestScallop: number;
  terrainFollowing: number;
  shadowLength: number;
  shadowStrength: number;
  hatchDensity: number;
  rippleLines: number;
  highlight: number;
  washShadow: number;
  lineBreaks: number;
  dots: number;
  colorVariation: number;
  colorScaleKm: number;
}

export const DESERT_DUNE_DEFAULTS: ResolvedDesertDuneOptions = {
  enabled: true,
  spacingKm: 2.5,
  windFromDeg: 340,
  crestScallop: 0.8,
  terrainFollowing: 1,
  shadowLength: 0.36,
  shadowStrength: 0.5,
  hatchDensity: 1,
  rippleLines: 1,
  highlight: 0.4,
  washShadow: 0.3,
  lineBreaks: 0.35,
  dots: 0.5,
  colorVariation: 0.12,
  colorScaleKm: 8,
};

/** Default reddish-brown for sand colour patches. */
export const DESERT_DEFAULT_SPOT_COLOR = "#c4855a";

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export function resolveDesertDuneOptions(
  options: DesertDuneOptions | undefined,
): ResolvedDesertDuneOptions {
  const d = DESERT_DUNE_DEFAULTS;
  return {
    enabled: options?.desertDunes ?? d.enabled,
    spacingKm: clamp(options?.desertDuneSpacingKm ?? d.spacingKm, 0.05, 50),
    windFromDeg: (((options?.desertWindFromDeg ?? d.windFromDeg) % 360) + 360) % 360,
    crestScallop: clamp(options?.desertCrestScallop ?? d.crestScallop, 0, 1),
    terrainFollowing: clamp(options?.desertTerrainFollowing ?? d.terrainFollowing, 0, 1),
    shadowLength: clamp(options?.desertShadowLength ?? d.shadowLength, 0.05, 0.45),
    shadowStrength: clamp(options?.desertShadowStrength ?? d.shadowStrength, 0, 1),
    hatchDensity: clamp(options?.desertHatchDensity ?? d.hatchDensity, 0.25, 3),
    rippleLines: Math.round(clamp(options?.desertRippleLines ?? d.rippleLines, 0, 3)),
    highlight: clamp(options?.desertHighlight ?? d.highlight, 0, 1),
    washShadow: clamp(options?.desertWashShadow ?? d.washShadow, 0, 1),
    lineBreaks: clamp(options?.desertLineBreaks ?? d.lineBreaks, 0, 1),
    dots: clamp(options?.desertDots ?? d.dots, 0, 1),
    colorVariation: clamp(options?.desertColorVariation ?? d.colorVariation, 0, 1),
    colorScaleKm: clamp(options?.desertColorScaleKm ?? d.colorScaleKm, 0.2, 200),
  };
}

/** Stable cache/signature key for everything that changes the dune ink. */
export function desertDuneSignature(options: ResolvedDesertDuneOptions): string {
  return JSON.stringify(options);
}

/**
 * Sand colour with its large colour patches, then lit and shaded by the dune
 * wash tone (0.5 neutral).
 *
 * `patchNoise` is the dune patch noise (about -1 to 1, sized by
 * `colorScaleKm`): high values drift towards the reddish-brown `spot` colour,
 * low values bleach slightly, giving soft blotches like the flow-line wash. Highlights lift toward white; shade darkens all channels almost
 * equally, toward warm grey, so pale sand never drifts olive.
 */
export function shadeDuneSand(
  sand: readonly [number, number, number],
  tone: number,
  options: ResolvedDesertDuneOptions,
  patchNoise = 0,
  spot: readonly [number, number, number] = [196, 133, 90],
): [number, number, number] {
  const toSpot = smoothStep(0.0, 0.55, patchNoise) * options.colorVariation * 0.7;
  const bleach = smoothStep(0.15, 0.7, -patchNoise) * options.colorVariation * 0.3;
  const base = [0, 1, 2].map((channel) => {
    const spotted = sand[channel] + (spot[channel] - sand[channel]) * toSpot;
    return spotted + (255 - spotted) * bleach;
  });
  const light = Math.max(0, tone - 0.5) * 2 * options.highlight * 0.8;
  const shade = Math.max(0, 0.5 - tone) * 2 * options.washShadow;
  return [
    (base[0] + (255 - base[0]) * light) * (1 - shade * 0.4),
    (base[1] + (255 - base[1]) * light) * (1 - shade * 0.43),
    (base[2] + (255 - base[2]) * light) * (1 - shade * 0.43),
  ];
}

/** True when a pixel of `biomeId` is drawn by the dune renderer. */
export function isDesertDunePixel(
  options: ResolvedDesertDuneOptions,
  biomeId: number,
): boolean {
  return options.enabled && biomeId === DESERT_DUNE_BIOME_ID;
}

// The brink sits mid-phase. Lobes are chosen per crest row, which leaves a
// small seam where one row hands over to the next; with the brink at 0.5 that
// seam always falls in the blank windward part of the phase.
const BRINK = 0.5;
/** Maximum lobe depth, in crest spacings; must stay below BRINK. */
const MAX_LOBE_DEPTH = 0.42;
/** Lobe width along a crest, in crest spacings. */
const LOBE_PERIOD = 1.8;
/** Windward (stoss) slope of a dune, rise over run: about 10 degrees. */
const STOSS_SLOPE = 0.18;
/** Slip face at the angle of repose of dry sand: about 33 degrees. */
const LEE_SLOPE = 0.65;
/** Sun height for the dune wash, degrees: a classic relief-shading angle. */
const SUN_ALTITUDE_DEG = 40;
/** Change in lit fraction that maps to full highlight or full shade. */
const SUN_CONTRAST = 0.4;
/** Smoothed slope (rise over run) at which terrain following = 1 tilts crests ~30 degrees. */
const TERRAIN_REFERENCE_SLOPE = 0.09;

const smoothStep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / Math.max(1e-9, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Separable running-sum box blur, clamped at the edges; O(1) per pixel. */
function boxBlur(
  source: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const horizontal = new Float32Array(width * height);
  const result = new Float32Array(width * height);
  const size = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += source[row + clamp(k, 0, width - 1)];
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum / size;
      sum += source[row + clamp(x + radius + 1, 0, width - 1)];
      sum -= source[row + clamp(x - radius, 0, width - 1)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += horizontal[clamp(k, 0, height - 1) * width + x];
    for (let y = 0; y < height; y++) {
      result[y * width + x] = sum / size;
      sum += horizontal[clamp(y + radius + 1, 0, height - 1) * width + x];
      sum -= horizontal[clamp(y - radius, 0, height - 1) * width + x];
    }
  }
  return result;
}

export interface DesertDuneRaster {
  /** Source-coordinate x/y for each local pixel column/row. */
  sourceXByPixel: Float64Array;
  sourceYByPixel: Float64Array;
  /** Source units per local pixel (1 in the preview, below 1 in upscaled exports). */
  sourcePerPixel: number;
}

/**
 * Ink dunes into `alpha` (0-255, max-combined) and/or write their wash into
 * `tone`, for every sand-desert pixel that `clip` marks as land. `thickness`
 * scales line widths like Stroke thickness does for the flow marks.
 */
export function paintDesertDunes(
  alpha: Uint8Array | undefined,
  clip: Uint8Array,
  dem: MountainDEMData,
  options: ResolvedDesertDuneOptions,
  raster: DesertDuneRaster,
  seed: number,
  thickness: number,
  /**
   * Optional wash tone (0.5 neutral, flat ground): each dune face lit by the
   * sun, brighter when it faces the sun and darker when it faces away. It
   * follows the same phase as the ink, so light, shade and lines agree.
   */
  tone?: Float32Array,
  /** Optional colour-patch noise (-1 to 1), written for dune pixels. */
  patchNoise?: Float32Array,
  /** Sun lighting the wash; azimuth in degrees (0 = north), as for hillshade. */
  sunAzimuthDeg = 315,
  /**
   * Output pixels per preview pixel (1 in the preview, about 4 in an 8K
   * export). Line widths, hatch spacing and dots are authored in preview
   * pixels and scale by this, like the flow-line marks, so exports keep the
   * same weight and tone.
   */
  pixelScale = 1,
): void {
  if (!options.enabled) return;
  const { width, height } = dem;
  let any = false;
  for (let i = 0; i < dem.biomeType.length; i++) {
    if (dem.biomeType[i] === DESERT_DUNE_BIOME_ID && clip[i] !== 0) {
      any = true;
      break;
    }
  }
  if (!any) return;

  const metresPerPixel = Math.max(1e-6, dem.dxMeters);
  const spacingPixels = Math.max(4, (options.spacingKm * 1000) / metresPerPixel);
  const spacingSource = spacingPixels * raster.sourcePerPixel;
  const sourcePerPixel = raster.sourcePerPixel;

  // Downwind unit vector in screen space (y down, north up).
  const windFrom = (options.windFromDeg * Math.PI) / 180;
  const downX = -Math.sin(windFrom);
  const downY = Math.cos(windFrom);
  // Along-crest unit vector.
  const alongX = -downY;
  const alongY = downX;

  const noise = new SimplexNoise(seed + 5003);
  // Direction towards the sun (screen x right, y down, z up). Matches the
  // renderer's shadow direction (-sin az, cos az), which points away from it.
  const sunAzimuth = (sunAzimuthDeg * Math.PI) / 180;
  const sunAltitude = (SUN_ALTITUDE_DEG * Math.PI) / 180;
  const sunX = Math.sin(sunAzimuth) * Math.cos(sunAltitude);
  const sunY = -Math.cos(sunAzimuth) * Math.cos(sunAltitude);
  const sunZ = Math.sin(sunAltitude);
  const sunFlat = sunZ;
  const patchScaleSource =
    Math.max(1, (options.colorScaleKm * 1000) / metresPerPixel) * raster.sourcePerPixel;
  const lobeDepth = MAX_LOBE_DEPTH * options.crestScallop;
  const smoothingRadius = Math.max(2, Math.min(96, Math.round(spacingPixels)));
  const smoothed = options.terrainFollowing > 0
    ? boxBlur(dem.elevation, width, height, smoothingRadius)
    : undefined;
  // One phase turn per spacing at the reference slope gives a terrain gradient
  // of 0.55 of the across-wind term, so terrain bends crests but never folds
  // them into contour loops on ordinary ground.
  const terrainScale = (options.terrainFollowing * 0.55) /
    (TERRAIN_REFERENCE_SLOPE * metresPerPixel * spacingPixels);

  const crestHalfWidth = 0.6 * thickness * pixelScale;
  /**
   * The one pen every dune line uses: crisp edges, full ink in the middle,
   * and a stroke that narrows to a point and fades as `taper` falls to 0.
   */
  const penInk = (distance: number, baseHalfWidth: number, taper: number): number => {
    const halfWidth = baseHalfWidth * (0.2 + 0.8 * Math.sqrt(taper));
    if (distance >= halfWidth + 0.5) return 0;
    return (0.4 + 0.6 * taper) * (1 - smoothStep(halfWidth - 0.5, halfWidth + 0.5, distance));
  };
  const hatchPitch = Math.max(1.6, 2.8 / options.hatchDensity) * pixelScale;
  const hatchHalfWidth = 0.5 * thickness * pixelScale;
  // Stipple and sand dots sit on a preview-pixel grid, so an export draws
  // the same specks, just larger, instead of many more tiny ones.
  const speckCell = pixelScale * sourcePerPixel;
  const speckRadius = 0.55 * pixelScale + 0.3;
  /** Ink of a speck whose preview-pixel cell (picked by `chosen`) holds this pixel. */
  const speckInk = (sx: number, sy: number, salt: number, chance: number, strength: number): number => {
    const cellX = Math.floor(sx / speckCell);
    const cellY = Math.floor(sy / speckCell);
    if (hash01((cellX * 73856093) ^ (cellY * 19349663), salt) >= chance) return 0;
    const offsetX = (sx / speckCell - cellX - 0.5) * pixelScale;
    const offsetY = (sy / speckCell - cellY - 0.5) * pixelScale;
    return strength * (1 - smoothStep(speckRadius - 0.5, speckRadius + 0.3, Math.hypot(offsetX, offsetY)));
  };
  const rippleStart = BRINK + options.shadowLength + 0.06;
  const rippleSpan = Math.max(0.02, 0.97 - rippleStart);

  interface PhaseSample {
    along: number;
    /** Phase before lobes: across-wind distance plus warp and terrain. */
    base: number;
    crestRow: number;
    lobeShape: number;
    /** d(phase)/d(along) from the lobes, in crest spacings. */
    lobeSlope: number;
    phase: number;
  }
  const blank = (): PhaseSample => ({ along: 0, base: 0, crestRow: 0, lobeShape: 0, lobeSlope: 0, phase: 0 });
  const sampleHere = blank();
  const sampleX = blank();
  const sampleY = blank();
  interface RowLobe {
    /** Phase offset the lobe adds here. */
    offset: number;
    /** 0 at a horn, 1 in the middle of a lobe. */
    shape: number;
    /** d(offset)/d(along), in crest spacings. */
    slope: number;
  }
  const lobeHere: RowLobe = { offset: 0, shape: 0, slope: 0 };
  const lobeAhead: RowLobe = { offset: 0, shape: 0, slope: 0 };
  const lobeBehind: RowLobe = { offset: 0, shape: 0, slope: 0 };
  /**
   * The lobes of one crest row at a position along it. Lobes are constant
   * per row, so the phase stays monotonic across the wind and can never fold
   * into eddies. Every row, and every lobe on it, gets its own depth, so some
   * dunes are deep crescents and others nearly straight.
   */
  const rowLobe = (row: number, along: number, out: RowLobe): RowLobe => {
    const period = LOBE_PERIOD * (0.6 + 0.9 * hash01(row, 11));
    const lobePosition = along / period + hash01(row, 13) * 7;
    const lobeIndex = Math.floor(lobePosition);
    const lobeFraction = lobePosition - lobeIndex;
    const rowDepth = lobeDepth *
      (0.35 + 0.65 * hash01(row, 19)) *
      (0.55 + 0.45 * hash01((lobeIndex * 2654435761) ^ row, 29));
    out.shape = 4 * lobeFraction * (1 - lobeFraction);
    out.offset = rowDepth * out.shape;
    out.slope = (rowDepth * 4 * (1 - 2 * lobeFraction)) / period;
    return out;
  };
  /**
   * How present a crest row is at a position along it: crests die out in
   * places and leave open sand, as real crests end, merge and fork.
   */
  const rowPresence = (row: number, along: number): number => smoothStep(
    -0.45,
    0.05,
    noise.noise2D(along / 2.4 + row * 5.1, row * 1.7 - 3.3),
  );

  /** Dune phase at a local pixel, written into `out` to avoid allocation. */
  const evaluate = (px: number, py: number, out: PhaseSample): PhaseSample => {
    const sx = raster.sourceXByPixel[px];
    const sy = raster.sourceYByPixel[py];
    const across = (sx * downX + sy * downY) / spacingSource;
    const along = (sx * alongX + sy * alongY) / spacingSource;
    // Two scales of warp: a slow one bends whole crests, a mid one squeezes
    // and stretches the spacing so dunes are not evenly striped. Its
    // gradient stays well below the across-wind term, so the phase keeps
    // increasing downwind and crests never fold.
    const wander =
      noise.noise2D(sx / (spacingSource * 5), sy / (spacingSource * 5)) * 0.35 +
      noise.noise2D(sx / (spacingSource * 2.6) + 17.3, sy / (spacingSource * 2.6) - 9.1) * 0.45;
    const terrain = smoothed ? smoothed[py * width + px] * terrainScale : 0;
    const base = across + wander + terrain;
    const crestRow = Math.floor(base);
    const lobe = rowLobe(crestRow, along, lobeHere);
    out.along = along;
    out.base = base;
    out.crestRow = crestRow;
    out.lobeShape = lobe.shape;
    out.lobeSlope = lobe.slope;
    out.phase = base + lobe.offset;
    return out;
  };

  for (let y = 0; y < height; y++) {
    const sy = raster.sourceYByPixel[y];
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const index = row + x;
      if (dem.biomeType[index] !== DESERT_DUNE_BIOME_ID || clip[index] === 0) continue;
      const sx = raster.sourceXByPixel[x];
      if (patchNoise) {
        // Two octaves at a physical size, so patches keep their size in km
        // at any resolution and do not follow the flow-line wash scale.
        const psx = raster.sourceXByPixel[x] / patchScaleSource;
        const psy = raster.sourceYByPixel[y] / patchScaleSource;
        patchNoise[index] =
          noise.noise2D(psx + 91.7, psy - 33.1) * 0.75 +
          noise.noise2D(psx * 2.3 + 5.3, psy * 2.3 + 71.2) * 0.25;
      }

      const sample = evaluate(x, y, sampleHere);
      const { along, base, crestRow, lobeShape, lobeSlope, phase } = sample;
      const fraction = phase - Math.floor(phase);


      const presence = rowPresence(crestRow, along);
      // Slip faces are tallest in the middle of a lobe and shrink towards its
      // horns; crests that fade out leave a shorter slip face behind.
      const shadowLength = options.shadowLength * (0.45 + 0.75 * lobeShape) *
        (0.6 + 0.4 * presence);

      if (tone) {
        // Where are we between two crests? Row k's brink lies where
        // base + lobe_k = k + 0.5. The next brink downwind is row n or n + 1
        // and the previous one upwind is row n or n - 1, each judged with its
        // own lobes. Picking the nearest one on each side keeps both
        // distances continuous, with no seams where crest rows hand over.
        const n = Math.floor(base);
        const lobeN = rowLobe(n, along, lobeHere).offset;
        const toNext = n + BRINK - base - lobeN;
        const before = toNext >= 0
          ? toNext
          : n + 1 + BRINK - base - rowLobe(n + 1, along, lobeAhead).offset;
        const nextRow = toNext >= 0 ? n : n + 1;
        const fromPrevious = base + lobeN - n - BRINK;
        const previousRow = fromPrevious >= 0 ? n : n - 1;
        const previousLobe = fromPrevious >= 0
          ? rowLobe(n, along, lobeBehind)
          : rowLobe(n - 1, along, lobeBehind);
        const after = fromPrevious >= 0
          ? fromPrevious
          : base + previousLobe.offset - (n - 1) - BRINK;
        // Light a physical dune profile with the map's sun. A planar face
        // has one brightness, set by its angle to the sun, so the long
        // windward slope is evenly lit and the steep slip face is bright or
        // dark depending on where the sun is; the crest is the edge between.
        const gap = Math.max(1e-6, after + before);
        const previousPresence = rowPresence(previousRow, along);
        const nextPresence = rowPresence(nextRow, along);
        // Slip face: from the previous crest down to the trough, short and
        // steep. A faded crest leaves a lower, gentler face.
        const slipLength = options.shadowLength *
          (0.45 + 0.75 * previousLobe.shape) * (0.6 + 0.4 * previousPresence);
        // A short flat trough, then the long windward slope up to the next
        // crest, eased in so the trough-to-slope bend is soft.
        const stossStart = Math.min(gap * 0.9, slipLength + gap * 0.08);
        const stossEase = gap * 0.12;
        let rise = 0;
        let faceSlope = 0;
        if (after < slipLength) {
          rise = -LEE_SLOPE * previousPresence;
          faceSlope = previousLobe.slope;
        } else if (after > stossStart) {
          rise = STOSS_SLOPE * nextPresence *
            smoothStep(stossStart, stossStart + stossEase, after);
          faceSlope = (toNext >= 0 ? lobeHere : lobeAhead).slope;
        }
        let lit = sunFlat;
        if (rise !== 0) {
          // The face rises along the local phase gradient: downwind, turned
          // by the lobe so faces swing around each scallop.
          const gradientX = downX + faceSlope * alongX;
          const gradientY = downY + faceSlope * alongY;
          const gradientLength = Math.hypot(gradientX, gradientY);
          const heightX = (rise * gradientX) / gradientLength;
          const heightY = (rise * gradientY) / gradientLength;
          lit = Math.max(
            0,
            (-heightX * sunX - heightY * sunY + sunZ) / Math.hypot(heightX, heightY, 1),
          );
        }
        // 0.5 is flat ground; a face turned fully into or away from the sun
        // reaches 1 or 0.
        tone[index] = 0.5 + 0.5 * clamp((lit - sunFlat) / SUN_CONTRAST, -1, 1);
      }
      if (!alpha) continue;

      // Pixel distance to a phase isoline needs the true phase gradient:
      // terrain and spacing warp can steepen it well beyond 1 / spacing, and
      // an underestimate would skip crest pixels. Finite differences to the
      // next pixel give it; a jump of half a turn or more means the
      // neighbour sits across a row seam, so fall back to the plain estimate.
      const nominal = 1 / spacingPixels;
      let gx = evaluate(Math.min(width - 1, x + 1), y, sampleX).phase - phase;
      let gy = evaluate(x, Math.min(height - 1, y + 1), sampleY).phase - phase;
      if (x + 1 >= width || Math.abs(gx) >= 0.5) gx = nominal;
      if (y + 1 >= height || Math.abs(gy) >= 0.5) gy = nominal;
      const gradientPerPixel = Math.max(nominal * 0.25, Math.hypot(gx, gy));

      let ink = 0;
      // Position along the crest in pixels; strokes, gaps and dots are laid
      // out along it so they stay put while the crest bends.
      const alongPixels = (along * spacingSource) / sourcePerPixel;
      // Interruptions: gaps along each crest. Continuity falls to 0 inside a
      // gap and ramps over a short stretch, so both sides taper.
      const gapThreshold = -1 + 1.3 * options.lineBreaks;
      const continuity = options.lineBreaks <= 0
        ? 1
        : smoothStep(
            gapThreshold,
            gapThreshold + 0.3,
            noise.noise2D(alongPixels / (spacingPixels * 0.45) + crestRow * 13.7, crestRow * 2.3 + 40),
          );
      // Tapered ends: where a crest fades out or enters a gap, the line
      // narrows to a point as well as fading.
      const taper = continuity * presence;
      const crestDistance = Math.abs(fraction - BRINK) / gradientPerPixel;
      if (taper > 0.02) ink = Math.max(ink, penInk(crestDistance, crestHalfWidth, taper));
      // Dots: a dotted trail carries the crest through gaps and past its
      // faded ends, like a pen lifting off the paper.
      if (options.dots > 0 && taper < 0.6 && presence > 0.05 && crestDistance < 2 * pixelScale) {
        const dotPitch = 4.5 * Math.max(0.6, thickness) * pixelScale;
        const dotIndex = Math.round(alongPixels / dotPitch);
        const keep = hash01((dotIndex * 2654435761) ^ (crestRow * 40503), 31) <
          options.dots * (1 - taper / 0.6) * Math.min(1, presence * 3);
        if (keep) {
          const dotDistance = Math.hypot(alongPixels - dotIndex * dotPitch, crestDistance);
          const dotRadius = 0.75 * Math.max(0.6, thickness) * pixelScale;
          ink = Math.max(ink, 0.85 * (1 - smoothStep(dotRadius - 0.4, dotRadius + 0.5, dotDistance)));
        }
      }
      // Slip-face hatching and stipple, downwind of the brink.
      if (presence > 0.01 && fraction > BRINK && fraction < BRINK + shadowLength) {
        const t = (fraction - BRINK) / shadowLength;
        // Hatch strokes run down the slope, perpendicular to the local crest:
        // trace back along the phase gradient to the brink position the
        // stroke starts from, so strokes fan around each scallop.
        const strokeOrigin = along - lobeSlope * (fraction - BRINK);
        const strokePixels = (strokeOrigin * spacingSource) / sourcePerPixel;
        const stripe = Math.floor(strokePixels / hatchPitch);
        const offset = Math.abs(strokePixels - (stripe + 0.5) * hatchPitch);
        const stripeKey = (stripe * 73856093) ^ (crestRow * 19349663);
        const length = 0.3 + 0.7 * hash01(stripeKey, 17);
        if (t < length) {
          const progress = t / length;
          const fade = Math.pow(1 - progress, 0.6);
          // Each stroke tapers from its full width at the crest to a point.
          const strokeHalfWidth = hatchHalfWidth * (1 - 0.75 * progress);
          const line = 1 - smoothStep(strokeHalfWidth - 0.4, strokeHalfWidth + 0.4, offset);
          ink = Math.max(ink, line * fade * options.shadowStrength * presence);
        }
        ink = Math.max(
          ink,
          speckInk(sx, sy, 23, options.shadowStrength * presence * 0.2 * (1 - t) * (1 - t), 0.8 * options.shadowStrength),
        );
      }
      // Windward ripple lines: the crest pen, thinner and lighter, broken
      // into dashes that taper to a point at both ends like the crests do.
      for (let line = 0; line < options.rippleLines; line++) {
        const target = rippleStart + ((line + 0.5) / options.rippleLines) * rippleSpan;
        const distance = Math.abs(fraction - target) / gradientPerPixel;
        if (distance > crestHalfWidth + 1) continue;
        const rippleTaper = smoothStep(
          -0.3 + 0.5 * options.lineBreaks,
          0.25 + 0.5 * options.lineBreaks,
          noise.noise2D(along / 0.9 + line * 31.7, crestRow * 3.1 + line * 7.3),
        ) * presence;
        if (rippleTaper <= 0.02) continue;
        ink = Math.max(ink, 0.7 * penInk(distance, crestHalfWidth * 0.7, rippleTaper));
      }

      // A light scatter of single dots on open sand.
      if (options.dots > 0) {
        ink = Math.max(ink, speckInk(sx, sy, 37, options.dots * 0.0035, 0.6));
      }

      if (ink > 0) {
        const value = Math.round(clamp(ink, 0, 1) * 255);
        if (value > alpha[index]) alpha[index] = value;
      }
    }
  }
}

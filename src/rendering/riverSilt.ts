import {
  DEFAULT_RIVER_THRESHOLD_KM2,
  exactEuclideanDistanceTransform,
  type MountainDEMData,
} from "../terrain/mountainBaseDEM";

/**
 * Silt-filled old river channels. Floods lay silt over the ground around a
 * river up to a level; erosion then strips the top layers off. What survives
 * is the silt sitting in ground that lies below its surroundings: the old,
 * abandoned channels in the height data. Thickness is measured against the
 * locally smoothed floor (relative relief), so the fill follows each channel's
 * own shape instead of the distance to the river. The result is one smooth
 * thickness field (0 = none, 1 = deepest fill) that upsamples cleanly for
 * export tiles; the renderer slices it into visible layers.
 */

type RGB = [number, number, number];

export interface RiverSiltOptions {
  /** How far from the river the outermost silt pass reaches, in metres. */
  reachM?: number;
  /** How much of the top silt is stripped away, in typical channel depths. */
  topRemoved?: number;
}

export const DEFAULT_SILT_REACH_M = 2500;
export const DEFAULT_SILT_TOP_REMOVED = 1;
export const DEFAULT_SILT_LAYERS = 3;

/** Radius of the smoothed floor that old channels are measured against. */
const RELIEF_RADIUS_M = 600;
/** Floods never spread silt over ground steeper than this. */
const MAX_FLOODPLAIN_SLOPE_DEG = 6;
/** Smallest typical relief, in metres, that relief is normalised against. */
const MIN_RELIEF_SCALE_M = 0.5;
/** Ground this far above the nearest river never received silt. */
const MAX_HEIGHT_ABOVE_RIVER_M = 25;
/** Fill thickness (in typical channel depths) that maps to full silt depth. */
const FULL_FILL_DEPTH = 2;
/** Smoothing of the crease lines; kept small so they stay inside the silt. */
const CREASE_SMOOTH_M = 150;
/** Band edges are inked where their noise is above this (about 55% of their length). */
const CREASE_INKED_ABOVE = 0.47;
/** Inked stretches are dotted where their noise is below this (about 25% of them). */
const CREASE_DOTTED_BELOW = 0.337;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Masked box blur; pixels outside the mask are left at zero. */
function blurMasked(field: Float32Array, mask: Uint8Array, width: number, height: number, radius: number, passes: number): Float32Array {
  let src = field;
  const tmp = new Float32Array(field.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      let count = 0;
      for (let x = 0; x <= Math.min(radius, width - 1); x++) {
        if (mask[row + x]) { sum += src[row + x]; count++; }
      }
      for (let x = 0; x < width; x++) {
        const index = row + x;
        if (mask[index]) tmp[index] = sum / count;
        const leaving = x - radius;
        const entering = x + radius + 1;
        if (leaving >= 0 && mask[row + leaving]) { sum -= src[row + leaving]; count--; }
        if (entering < width && mask[row + entering]) { sum += src[row + entering]; count++; }
      }
    }
    const out = new Float32Array(field.length);
    // Slide the masked sum instead of rescanning every pixel's neighbourhood.
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let y = 0; y <= Math.min(radius, height - 1); y++) {
        if (mask[y * width + x]) { sum += tmp[y * width + x]; count++; }
      }
      for (let y = 0; y < height; y++) {
        const index = y * width + x;
        if (mask[index]) out[index] = sum / count;
        const leaving = y - radius;
        const entering = y + radius + 1;
        if (leaving >= 0 && mask[leaving * width + x]) { sum -= tmp[leaving * width + x]; count--; }
        if (entering < height && mask[entering * width + x]) { sum += tmp[entering * width + x]; count++; }
      }
    }
    src = out;
  }
  return src;
}

/**
 * Silt depth (0..1) for every land cell near `riverMask`, or null when the
 * DEM has no river.
 */
export function buildRiverSiltDepth(
  dem: MountainDEMData,
  riverMask: Uint8Array,
  options: RiverSiltOptions = {},
): Float32Array | null {
  const { width, height } = dem;
  const total = width * height;
  const reachM = options.reachM ?? DEFAULT_SILT_REACH_M;
  if (reachM <= 0 || dem.elevation?.length !== total || riverMask.length !== total || !riverMask.includes(1)) {
    return null;
  }
  const topRemoved = Math.max(0, options.topRemoved ?? DEFAULT_SILT_TOP_REMOVED);
  const cellM = Math.max(1e-6, Math.min(dem.dxMeters, dem.dyMeters));
  const nearest = exactEuclideanDistanceTransform(riverMask, width, height);

  // Pre-incision surface: the routed river's cut would otherwise dominate.
  const surface = new Float32Array(total);
  const zone = new Uint8Array(total);
  for (let index = 0; index < total; index++) {
    surface[index] = dem.elevation[index] + (dem.erosionDepthM?.[index] ?? 0);
    if (riverMask[index] || dem.isOcean?.[index] === 1 || nearest.nearestX[index] < 0) continue;
    // Floods only spread over the flat valley floor, never up hillsides.
    if (dem.slopeDeg[index] > MAX_FLOODPLAIN_SLOPE_DEG) continue;
    if (nearest.distance[index] * cellM <= reachM) zone[index] = 1;
  }

  // Relative relief: height minus the smoothed floor, normalised by the local
  // typical relief so shallow floodplain channels count as much as deep ones
  // elsewhere. The floor on the scale keeps flat noise from being amplified.
  const radius = Math.max(2, Math.min(16, Math.round(RELIEF_RADIUS_M / cellM)));
  const floor = blurMasked(surface, zone, width, height, radius, 2);
  const relief = new Float32Array(total);
  const absRelief = new Float32Array(total);
  for (let index = 0; index < total; index++) {
    if (!zone[index]) continue;
    relief[index] = surface[index] - floor[index];
    absRelief[index] = Math.abs(relief[index]);
  }
  const localScale = blurMasked(absRelief, zone, width, height, radius * 2, 2);

  const depth = new Float32Array(total);
  for (let index = 0; index < total; index++) {
    if (!zone[index]) continue;
    const river = nearest.nearestY[index] * width + nearest.nearestX[index];
    // Flood fill: silt tops out level with the local floor. Stripping the top
    // layers leaves only ground lying more than `topRemoved` below the floor.
    const fill = -relief[index] / Math.max(MIN_RELIEF_SCALE_M, localScale[index]) - topRemoved;
    if (fill <= 0) continue;
    // Floods thin out toward the reach and never top high terraces.
    const flood = 1 - smoothstep(0.6, 1, (nearest.distance[index] * cellM) / reachM);
    const heightAboveRiver = surface[index] - surface[river];
    const terrace = 1 - smoothstep(MAX_HEIGHT_ABOVE_RIVER_M * 0.5, MAX_HEIGHT_ABOVE_RIVER_M, heightAboveRiver);
    depth[index] = Math.min(1, fill / FULL_FILL_DEPTH) * flood * terrace;
  }
  return blurMasked(depth, zone, width, height, 1, 1);
}

/**
 * Field the crease lines are traced from: the silt depth lightly smoothed so
 * the lines run cleanly, but not so far that they drift out of the silt.
 */
export function buildRiverSiltCreaseField(depth: Float32Array, dem: MountainDEMData): Float32Array {
  const cellM = Math.max(1e-6, Math.min(dem.dxMeters, dem.dyMeters));
  const radius = Math.max(1, Math.min(2, Math.round(CREASE_SMOOTH_M / cellM)));
  return blurMasked(depth, new Uint8Array(depth.length).fill(1), dem.width, dem.height, radius, 2);
}

/** Silt depth from the DEM's own rivers (routed channels above `riverThresholdKm2` plus biome 6). */
export function buildRiverSiltDepthForDEM(
  dem: MountainDEMData,
  riverThresholdKm2: number | undefined,
  options: RiverSiltOptions = {},
): Float32Array | null {
  const threshold = Math.max(0.001, riverThresholdKm2 ?? DEFAULT_RIVER_THRESHOLD_KM2);
  const area = dem.rainfallWeightedAreaKm2 ?? dem.drainageAreaKm2;
  const rivers = new Uint8Array(dem.width * dem.height);
  for (let index = 0; index < rivers.length; index++) {
    if (dem.isOcean?.[index] === 1) continue;
    if ((dem.isRiverChannel[index] === 1 && (area?.[index] ?? 0) >= threshold) || dem.biomeType?.[index] === 6) {
      rivers[index] = 1;
    }
  }
  return buildRiverSiltDepth(dem, rivers, options);
}

/** How much of a pixel the silt fill covers (0..1); matches `shadeRiverSilt`. */
export function riverSiltCoverage(depth: number, layers: number): number {
  if (!(depth > 0)) return 0;
  return smoothstep(0, 0.35, depth * Math.max(1, Math.round(layers)));
}

function hash01(x: number, y: number, salt: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 144665);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in 0..1 on a `scale`-pixel lattice. */
function valueNoise(x: number, y: number, scale: number, salt: number): number {
  const px = x / scale;
  const py = y / scale;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const tx = fx * fx * (3 - 2 * fx);
  const ty = fy * fy * (3 - 2 * fy);
  const top = hash01(ix, iy, salt) * (1 - tx) + hash01(ix + 1, iy, salt) * tx;
  const bottom = hash01(ix, iy + 1, salt) * (1 - tx) + hash01(ix + 1, iy + 1, salt) * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Ground-pattern pen the silt lines are drawn with. */
export interface RiverSiltLineStyle {
  /** Pen radius in output pixels (ground pattern stroke thickness). */
  radiusPx: number;
  /** Ground pattern stroke length times the output pixel scale; sizes the marks. */
  dashScale: number;
  /** Output pixel scale alone; gaps stay this long however short the stroke length is. */
  gapScale: number;
  /** Chance of a dry-ink skip per pixel. */
  drySkipProbability: number;
  /** Silt passes; band edges between them are the candidate lines. */
  layers: number;
}

/**
 * Signed pixels from (gx, gy) to where a value noise field crosses `level`:
 * positive above it, negative below.
 */
function noiseLevelDistancePx(gx: number, gy: number, scale: number, salt: number, level: number): number {
  const slope = Math.hypot(
    valueNoise(gx + 1, gy, scale, salt) - valueNoise(gx - 1, gy, scale, salt),
    valueNoise(gx, gy + 1, scale, salt) - valueNoise(gx, gy - 1, scale, salt),
  ) * 0.5;
  return (valueNoise(gx, gy, scale, salt) - level) / Math.max(1e-5, slope);
}

/**
 * Charcoal lines inside silted channels, traced on the smoothed fill
 * (`buildRiverSiltCreaseField`) along the band edges, so they run along each
 * channel. Each edge is only inked along some stretches, which thins the
 * lines out and varies how many cross any one spot. Drawn with the ground
 * pattern pen: the same charcoal radius, soft 0.65 px edge, grain and dry
 * skips, in broken marks of the ground pattern's stroke length that taper to
 * a point at both ends, some of them dotted.
 *
 * `x`/`y` are local pixels in `depth`; `offsetX`/`offsetY` place them in the
 * global output so the dash pattern lines up across export tiles.
 */
export function riverSiltCreaseAlpha(
  depth: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  offsetX: number,
  offsetY: number,
  style: RiverSiltLineStyle,
): number {
  const index = y * width + x;
  const value = depth[index];
  if (!(value > 0.05)) return 0;
  const left = depth[y * width + Math.max(0, x - 1)];
  const right = depth[y * width + Math.min(width - 1, x + 1)];
  const up = depth[Math.max(0, y - 1) * width + x];
  const down = depth[Math.min(height - 1, y + 1) * width + x];
  const slope = Math.hypot(right - left, down - up) * 0.5;
  if (slope < 1e-4) return 0;
  // Distance to the nearest band edge (k / layers), in pixels via the local
  // gradient so every line keeps the same pen width.
  const lines = Math.max(1, Math.round(style.layers));
  const position = value * lines;
  const level = Math.round(position);
  if (level < 1 || level >= lines) return 0;
  const distancePx = Math.abs(position - level) / (lines * slope);
  if (distancePx > style.radiusPx * 1.5 + 0.65) return 0;
  const gx = x + offsetX;
  const gy = y + offsetY;
  if (hash01(gx, gy, 317) < style.drySkipProbability) return 0;
  // Same brush as paintInkSegment: pressure-scaled radius with per-pixel
  // tooth, a 0.65 px soft edge and 0.78..1 grain.
  const markScale = Math.max(0.25, style.dashScale);
  const pressure = 0.55 + 0.45 * valueNoise(gx, gy, 40 * markScale, 11);
  const tooth = (hash01(gx, gy, 541) - 0.5) * 0.35 + (hash01(gx, gy, 733) - 0.5) * 0.2;
  const localRadius = style.radiusPx * pressure * (0.85 + hash01(gx, gy, 13) * 0.3 + tooth * 0.3);
  const grain = 0.78 + 0.22 * hash01(gx, gy, 991);
  // Everything below uses smooth noise with its own salt per band edge, never
  // a grid, so neighbouring lines start, stop and break in different places.
  const pixelScale = Math.max(0.25, style.gapScale);
  const salt = 400 + level * 31;
  const taperPx = 3 * pixelScale;
  // Each band edge is inked along some stretches and bare along others; the
  // pen tapers in over `taperPx` wherever a stretch starts or ends.
  const fromStretchEndPx = noiseLevelDistancePx(gx, gy, 70 * pixelScale, salt, CREASE_INKED_ABOVE);
  if (fromStretchEndPx <= 0) return 0;
  if (valueNoise(gx, gy, 60 * pixelScale, salt + 1) < CREASE_DOTTED_BELOW) {
    // Dotted stretch: round dots right at the crossings of a fine noise field.
    const dotHalfPx = Math.max(1, localRadius * 1.2);
    const fromDotPx = Math.abs(noiseLevelDistancePx(gx, gy, 6 * pixelScale, salt + 2, 0.5));
    const dot = Math.max(0, Math.min(1, dotHalfPx - fromDotPx + 0.5));
    return Math.max(0, Math.min(1, localRadius - distancePx + 0.65)) * grain * dot;
  }
  // Broken dash: 7..14 px gaps where the line crosses the mid level of a
  // noise field; longer stroke lengths space them a little further apart.
  const strokeLength = markScale / pixelScale;
  const markPx = 13 * pixelScale * (0.75 + 0.25 * Math.min(3, strokeLength));
  const gapHalfPx = (3.5 + 3.5 * valueNoise(gx, gy, 50 * pixelScale, salt + 3)) * pixelScale;
  const fromGapPx = Math.abs(noiseLevelDistancePx(gx, gy, markPx, salt + 4, 0.5)) - gapHalfPx;
  if (fromGapPx <= 0) return 0;
  // Taper: the pen (and its soft edge) narrows to a point at both dash ends.
  const taper = Math.min(1, fromGapPx / taperPx, fromStretchEndPx / taperPx);
  const shaped = Math.sqrt(taper);
  return Math.max(0, Math.min(1, (localRadius + 0.65) * shaped - distancePx)) * grain;
}

/**
 * Colours a land pixel with `depth` of silt, sliced into `layers` passes:
 * each pass alternates tone slightly. The outermost edge stays soft.
 */
export function shadeRiverSilt(base: RGB, depth: number, silt: RGB, layers: number): RGB {
  if (!(depth > 0)) return base;
  const passes = Math.max(1, Math.round(layers));
  const position = depth * passes;
  const band = Math.min(passes - 1, Math.floor(position));
  const coverage = smoothstep(0, 0.35, position);
  const tone = 1 + (band % 2 === 0 ? 0.03 : -0.03) - band * 0.015;
  const amount = coverage * 0.9;
  return [
    base[0] + (silt[0] * tone - base[0]) * amount,
    base[1] + (silt[1] * tone - base[1]) * amount,
    base[2] + (silt[2] * tone - base[2]) * amount,
  ];
}

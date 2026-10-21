/**
 * Vegetation raster fields on the GPU.
 *
 * The wash background and the two directional shadows are per-pixel noise and
 * hash math, about 1.5 s of CPU time per 2048px preview and the same per
 * export tile area. The vegetation overlay is built synchronously inside the
 * compositor, so these passes run on WebGL2 in the worker (its readPixels
 * returns synchronously) rather than WebGPU, whose readback is asynchronous.
 *
 * Each pass reproduces its CPU counterpart in vegetationRenderer.ts: the
 * integer hashes match exactly and the simplex noise differs only by float32
 * rounding. Without WebGL2 or float render targets every function returns
 * null and the caller stays on the CPU.
 */
import { simplexPermutation } from "../core/noise";

/** Noise seeds of the wash passes, one permutation row each. */
export interface VegetationFieldNoiseSeeds {
  flow: number;
  wash: number;
  dryPatch: number;
  grain: number;
}

/** The affine map from local pixels to the shared source domain (see createVegetationFlowSampling). */
export interface VegetationFieldDomain {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  outputWidth: number;
  outputHeight: number;
  outputXDenominator: number;
  outputYDenominator: number;
  sourceXRange: number;
  sourceYRange: number;
  grainStride: number;
  /** (seed + 3379) | 0, the fine grain's hash salt. */
  grainSalt: number;
  /** max(1.6, 2.6 / coordinatePatternScale), the coarse grain's scale. */
  grainScale: number;
}

export interface VegetationBackgroundGlInput {
  domain: VegetationFieldDomain;
  seeds: VegetationFieldNoiseSeeds;
  clip: Uint8Array;
  biomeType: Uint8Array;
  waterDistance: Float32Array;
  /** The two-pixel potential grid (see createVegetationFlowCache). */
  gridOriginX: number;
  gridOriginY: number;
  gridWidth: number;
  gridHeight: number;
  /** (seed + 1907) | 0, the flow cells' hash salt. */
  flowSalt: number;
  swirlStrength: number;
  flowScale: number;
  swirlScale: number;
  cellSize: number;
  washNoiseScale: number;
  dryPatchScale: number;
  blurRadius: number;
  dryDistanceStart: number;
  dryDistanceEnd: number;
  dryNoiseStrength: number;
}

export interface VegetationWashShadowGlInput {
  domain: VegetationFieldDomain;
  grainSeed: number;
  clip: Uint8Array;
  tone: Float32Array;
  /** Receiver offsets of the three lateral taps, in pixels. */
  minus: readonly [number, number];
  centre: readonly [number, number];
  plus: readonly [number, number];
  /** Shadow direction times distance: the receiver is the pixel minus this. */
  shiftX: number;
  shiftY: number;
  washShadowGrain: number;
}

export interface VegetationMotifShadowGlInput {
  domain: VegetationFieldDomain;
  grainSeed: number;
  clip: Uint8Array;
  alpha: Uint8Array;
  shiftX: number;
  shiftY: number;
  grainRadius: number;
}

const VERTEX = /* glsl */ `#version 300 es
void main() {
  // One triangle covering the viewport.
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

const ROW_FLOW = 0;
const ROW_WASH = 1;
const ROW_DRY_PATCH = 2;
const ROW_GRAIN = 3;

/**
 * Hash, simplex noise, grain and the source-domain map shared by every pass
 * (also by the mountain illustration passes in mountainIllustrationGl.ts).
 */
export const COMMON = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;

#define ROW_FLOW ${ROW_FLOW}
#define ROW_WASH ${ROW_WASH}
#define ROW_DRY_PATCH ${ROW_DRY_PATCH}
#define ROW_GRAIN ${ROW_GRAIN}

uniform highp usampler2D uPerm;
uniform ivec2 uSize;
uniform ivec2 uOffset;
uniform ivec2 uOutputSize;
uniform vec2 uOutputDenominator;
uniform vec2 uSourceRange;
uniform int uGrainStride;
uniform int uGrainSalt;
uniform float uGrainScale;

float clamp01(float value) { return clamp(value, 0.0, 1.0); }

float smoothStep(float edge0, float edge1, float value) {
  float t = clamp01((value - edge0) / max(1e-6, edge1 - edge0));
  return t * t * (3.0 - 2.0 * t);
}

// hash01 in cartographicStrokeRenderer.ts, as its 32 bits (the value is
// bits / 2^32); uint arithmetic wraps like Math.imul.
uint hashBits(uint value, int salt) {
  uint h = (value ^ 0x9e3779b9u) * uint(salt) + 0x7f4a7c15u;
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  h = (h ^ (h >> 13u)) * 0x45d9f3bu;
  return h ^ (h >> 16u);
}

float hash01(uint value, int salt) {
  // The top 24 bits, so the value stays below 1 in float32.
  return float(hashBits(value, salt) >> 8u) * (1.0 / 16777216.0);
}

int permAt(int row, int index) {
  return int(texelFetch(uPerm, ivec2(index & 255, row), 0).r);
}

const vec2 GRAD3[12] = vec2[12](
  vec2(1.0, 1.0), vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(-1.0, -1.0),
  vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(1.0, 0.0), vec2(-1.0, 0.0),
  vec2(0.0, 1.0), vec2(0.0, -1.0), vec2(0.0, 1.0), vec2(0.0, -1.0));

float simplexCorner(int row, int index, float x, float y) {
  float t = 0.5 - x * x - y * y;
  if (t < 0.0) return 0.0;
  vec2 g = GRAD3[permAt(row, index) % 12];
  t *= t;
  return t * t * (g.x * x + g.y * y);
}

// SimplexNoise.noise2D in core/noise.ts.
float noise2D(int row, float xin, float yin) {
  const float F2 = 0.36602540378443865;
  const float G2 = 0.21132486540518713;
  float s = (xin + yin) * F2;
  float fi = floor(xin + s);
  float fj = floor(yin + s);
  float t = (fi + fj) * G2;
  float x0 = xin - (fi - t);
  float y0 = yin - (fj - t);
  int i1 = x0 > y0 ? 1 : 0;
  int j1 = 1 - i1;
  float x1 = x0 - float(i1) + G2;
  float y1 = y0 - float(j1) + G2;
  float x2 = x0 - 1.0 + 2.0 * G2;
  float y2 = y0 - 1.0 + 2.0 * G2;
  int ii = int(fi) & 255;
  int jj = int(fj) & 255;
  return 70.0 * (
    simplexCorner(row, ii + permAt(row, jj), x0, y0) +
    simplexCorner(row, ii + i1 + permAt(row, jj + j1), x1, y1) +
    simplexCorner(row, ii + 1 + permAt(row, jj + 1), x2, y2));
}

float fbm(int row, vec2 p, int octaves, float lacunarity, float gain) {
  float total = 0.0;
  float amplitude = gain;
  float px = p.x;
  float py = p.y;
  for (int octave = 0; octave < 8; octave++) {
    if (octave >= octaves) break;
    total += amplitude * noise2D(row, px, py);
    float nx = (px * 0.8 - py * 0.6) * lacunarity;
    float ny = (px * 0.6 + py * 0.8) * lacunarity;
    px = nx;
    py = ny;
    amplitude *= gain;
  }
  return total;
}

vec2 domainWarp(int row, vec2 p, float strength) {
  return vec2(
    p.x + noise2D(row, p.x, p.y) * strength,
    p.y + noise2D(row, p.x + 5.2, p.y + 1.3) * strength);
}

// sourceCoordinateAt in vegetationRenderer.ts.
vec2 sourceAt(vec2 p) {
  float globalX = clamp(p.x + float(uOffset.x), 0.0, float(uOutputSize.x - 1));
  float globalY = clamp(p.y + float(uOffset.y), 0.0, float(uOutputSize.y - 1));
  return vec2(
    globalX / uOutputDenominator.x * uSourceRange.x,
    globalY / uOutputDenominator.y * uSourceRange.y);
}

// sampleVegetationTextureGrainAt / sampleCartographicGrain.
float grainAt(vec2 p, vec2 source) {
  float coarse = clamp01(0.5 + fbm(ROW_GRAIN, source / uGrainScale, 3, 1.9, 0.56) * 0.5);
  int globalX = int(floor(p.x + float(uOffset.x) + 0.5));
  int globalY = int(floor(p.y + float(uOffset.y) + 0.5));
  float fine = hash01(uint(globalY) * uint(uGrainStride) + uint(globalX), uGrainSalt);
  return (coarse * 0.48 + fine * 0.52) * 2.0 - 1.0;
}
`;

/** flowPotentialAtDirect at every two-pixel grid point. */
const POTENTIAL_FRAGMENT = `${COMMON}
uniform ivec2 uGridOrigin;
uniform int uFlowSalt;
uniform float uSwirlStrength;
uniform float uFlowScale;
uniform float uSwirlScale;
uniform float uCellSize;
out vec4 outColor;

float roundedFlowCellDistance(vec2 source) {
  vec2 warped = domainWarp(ROW_FLOW, source / uCellSize, 0.23 + uSwirlStrength * 0.16);
  int cellX = int(floor(warped.x));
  int cellY = int(floor(warped.y));
  float nearest = 1e30;
  for (int offsetY = -1; offsetY <= 1; offsetY++) {
    for (int offsetX = -1; offsetX <= 1; offsetX++) {
      int candidateX = cellX + offsetX;
      int candidateY = cellY + offsetY;
      uint key = (uint(candidateX) * 374761393u) ^ (uint(candidateY) * 668265263u) ^ uint(uFlowSalt);
      vec2 centre = vec2(
        float(candidateX) + 0.5 + (hash01(key, 601) - 0.5) * 0.28,
        float(candidateY) + 0.5 + (hash01(key, 607) - 0.5) * 0.28);
      nearest = min(nearest, length(warped - centre));
    }
  }
  return nearest;
}

void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  vec2 p = vec2(
    clamp(float((uGridOrigin.x + cell.x) * 2 - uOffset.x), 0.0, float(uSize.x - 1)),
    clamp(float((uGridOrigin.y + cell.y) * 2 - uOffset.y), 0.0, float(uSize.y - 1)));
  vec2 source = sourceAt(p);
  float rounded = 1.0 - smoothStep(0.08, 0.67, roundedFlowCellDistance(source));
  vec2 warped = domainWarp(ROW_FLOW, vec2(source.x / uSwirlScale + 13.7, source.y / uSwirlScale - 9.3), 0.48);
  float swirl = clamp01(0.5 + fbm(ROW_FLOW, warped, 3, 1.92, 0.54) * 0.5);
  float regional = clamp01(0.5 + noise2D(ROW_FLOW,
    source.x / (uFlowScale * 4.6) - 21.1,
    source.y / (uFlowScale * 4.6) + 17.4) * 0.5);
  float swirlMix = 0.25 + uSwirlStrength * 0.18 + regional * 0.2;
  outColor = vec4(clamp01(rounded * (1.0 - swirlMix) + swirl * swirlMix), 0.0, 0.0, 1.0);
}
`;

/** The tone, wash noise and wetland dryness of buildFlowBackgroundTone. */
const BACKGROUND_FRAGMENT = `${COMMON}
uniform sampler2D uPotential;
uniform highp usampler2D uClip;
uniform highp usampler2D uBiome;
uniform sampler2D uWaterDistance;
uniform ivec2 uGridOrigin;
uniform ivec2 uGridMax;
uniform float uBlurRadius;
uniform float uWashNoiseScale;
uniform float uDryPatchScale;
uniform float uDryStart;
uniform float uDryEnd;
uniform float uDryStrength;
out vec4 outColor;

// The cached potential, interpolated like sampleCachedVegetationField.
float potentialAt(int x, int y) {
  float gridX = clamp(float(x + uOffset.x) / 2.0 - float(uGridOrigin.x), 0.0, float(uGridMax.x));
  float gridY = clamp(float(y + uOffset.y) / 2.0 - float(uGridOrigin.y), 0.0, float(uGridMax.y));
  int x0 = int(floor(gridX));
  int y0 = int(floor(gridY));
  int x1 = min(uGridMax.x, x0 + 1);
  int y1 = min(uGridMax.y, y0 + 1);
  float tx = gridX - float(x0);
  float ty = gridY - float(y0);
  float top = texelFetch(uPotential, ivec2(x0, y0), 0).r * (1.0 - tx)
    + texelFetch(uPotential, ivec2(x1, y0), 0).r * tx;
  float bottom = texelFetch(uPotential, ivec2(x0, y1), 0).r * (1.0 - tx)
    + texelFetch(uPotential, ivec2(x1, y1), 0).r * tx;
  return top * (1.0 - ty) + bottom * ty;
}

float filterGradient(float value, float grain) {
  return clamp01(value + grain * 0.22 * (4.0 * value * (1.0 - value)));
}

float filterSignedGradient(float value, float grain) {
  return clamp(value + grain * 0.22 * (1.0 - value * value), -1.0, 1.0);
}

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  if (texelFetch(uClip, pixel, 0).r == 0u) {
    outColor = vec4(0.0);
    return;
  }
  float potential = potentialAt(pixel.x, pixel.y);
  int left = clamp(int(floor(float(pixel.x) - uBlurRadius + 0.5)), 0, uSize.x - 1);
  int right = clamp(int(floor(float(pixel.x) + uBlurRadius + 0.5)), 0, uSize.x - 1);
  int up = clamp(int(floor(float(pixel.y) - uBlurRadius + 0.5)), 0, uSize.y - 1);
  int down = clamp(int(floor(float(pixel.y) + uBlurRadius + 0.5)), 0, uSize.y - 1);
  float localMean = (potentialAt(left, pixel.y) + potentialAt(right, pixel.y)
    + potentialAt(pixel.x, up) + potentialAt(pixel.x, down)) * 0.25;
  vec2 p = vec2(pixel);
  vec2 source = sourceAt(p);
  float grain = grainAt(p, source);
  float baseTone = 0.9 * smoothStep(0.06, 0.92, potential)
    + 0.1 * smoothStep(0.025, 0.22, abs(potential - localMean));
  float tone = filterGradient(baseTone, grain);
  vec2 washWarp = domainWarp(ROW_WASH, source / uWashNoiseScale, 0.38);
  float washNoise = clamp01(0.5 + fbm(ROW_WASH, washWarp, 3, 1.9, 0.55) * 0.5) * 2.0 - 1.0;
  float dryness = 0.0;
  if (texelFetch(uBiome, pixel, 0).r == 7u) {
    float waterDistance = texelFetch(uWaterDistance, pixel, 0).r;
    float band = waterDistance < uDryStart ? 0.0 : waterDistance < uDryEnd ? 0.38 : 1.0;
    if (band > 0.0) {
      vec2 coarse = domainWarp(ROW_DRY_PATCH, source / uDryPatchScale, 0.6);
      vec2 fine = domainWarp(ROW_DRY_PATCH, source / (uDryPatchScale * 0.42), 0.35);
      float patchNoise = clamp01(0.5 + (fbm(ROW_DRY_PATCH, coarse, 3, 1.95, 0.56) * 0.68
        + fbm(ROW_DRY_PATCH, fine, 2, 1.9, 0.5) * 0.32) * 0.5);
      float threshold = 0.64 - band * 0.22;
      float classified = smoothStep(-0.055, 0.055, filterGradient(patchNoise, grain) - threshold);
      dryness = classified * uDryStrength * smoothStep(0.42, 0.62, tone);
    }
  }
  outColor = vec4(tone, filterSignedGradient(washNoise, grain), dryness, 0.0);
}
`;

/**
 * Single-channel passes pack four neighbouring pixels into one RGBA texel,
 * which quarters the readback. PIXEL_VALUE(pixel) gives one pixel's value.
 */
function packedFragment(declarations: string, pixelValue: string): string {
  return `${COMMON}
${declarations}
out vec4 outColor;

float pixelValue(ivec2 pixel) {
${pixelValue}
}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  vec4 values = vec4(0.0);
  for (int lane = 0; lane < 4; lane++) {
    ivec2 pixel = ivec2(texel.x * 4 + lane, texel.y);
    if (pixel.x < uSize.x) values[lane] = pixelValue(pixel);
  }
  outColor = values;
}
`;
}

/** buildDirectionalWashShadowCoverage. */
const WASH_SHADOW_FRAGMENT = packedFragment(/* glsl */ `
uniform sampler2D uTone;
uniform highp usampler2D uClip;
uniform vec2 uMinus;
uniform vec2 uCentre;
uniform vec2 uPlus;
uniform vec2 uShift;
uniform float uWashShadowGrain;

// sampleVegetationFieldLookup over createVegetationAxisLookup offsets.
float neutralWash(ivec2 pixel, vec2 offset) {
  float x = clamp(float(pixel.x) + offset.x, 0.0, float(uSize.x - 1));
  float y = clamp(float(pixel.y) + offset.y, 0.0, float(uSize.y - 1));
  int x0 = int(floor(x));
  int y0 = int(floor(y));
  int x1 = min(uSize.x - 1, x0 + 1);
  int y1 = min(uSize.y - 1, y0 + 1);
  float tx = x - float(x0);
  float ty = y - float(y0);
  float top = texelFetch(uTone, ivec2(x0, y0), 0).r * (1.0 - tx) + texelFetch(uTone, ivec2(x1, y0), 0).r * tx;
  float bottom = texelFetch(uTone, ivec2(x0, y1), 0).r * (1.0 - tx) + texelFetch(uTone, ivec2(x1, y1), 0).r * tx;
  float value = top * (1.0 - ty) + bottom * ty;
  return 1.0 - smoothStep(0.05, 0.2, abs(value - 0.5));
}
`, /* glsl */ `
  if (texelFetch(uClip, pixel, 0).r == 0u) return 0.0;
  float band = neutralWash(pixel, uMinus) * 0.25 + neutralWash(pixel, uCentre) * 0.5
    + neutralWash(pixel, uPlus) * 0.25;
  if (band <= 0.0) return 0.0;
  vec2 receiver = vec2(pixel) - uShift;
  float grain = 0.5 + grainAt(receiver, sourceAt(receiver)) * 0.5;
  return band * (1.0 - uWashShadowGrain * (0.42 - grain * 0.42)) * 0.8;
`);

/** buildNoisyDirectionalShadowCoverage. */
const MOTIF_SHADOW_FRAGMENT = packedFragment(/* glsl */ `
uniform sampler2D uAlpha;
uniform highp usampler2D uClip;
uniform vec2 uShift;
uniform float uGrainRadius;

const vec3 FOOTPRINT_TAPS[9] = vec3[9](
  vec3(0.0, 0.0, 1.0), vec3(1.0, 0.0, 0.78), vec3(-1.0, 0.0, 0.78),
  vec3(0.0, 1.0, 0.78), vec3(0.0, -1.0, 0.78), vec3(0.72, 0.72, 0.58),
  vec3(-0.72, 0.72, 0.58), vec3(0.72, -0.72, 0.58), vec3(-0.72, -0.72, 0.58));

float alphaNearest(vec2 p) {
  int x = int(floor(p.x + 0.5));
  int y = int(floor(p.y + 0.5));
  if (x < 0 || y < 0 || x >= uSize.x || y >= uSize.y) return 0.0;
  return texelFetch(uAlpha, ivec2(x, y), 0).r;
}
`, /* glsl */ `
  if (texelFetch(uClip, pixel, 0).r == 0u) return 0.0;
  vec2 source = vec2(pixel) - uShift;
  float footprint = 0.0;
  for (int tap = 0; tap < 9; tap++) {
    vec3 offset = FOOTPRINT_TAPS[tap];
    footprint = max(footprint, alphaNearest(source + offset.xy * uGrainRadius) * offset.z);
  }
  if (footprint <= 0.0) return 0.0;
  float grain = 0.5 + grainAt(source, sourceAt(source)) * 0.5;
  float threshold = 0.46 - footprint * 0.12;
  if (grain <= threshold) return 0.0;
  return footprint * smoothStep(threshold, 0.94, grain) * (0.3 + grain * 0.7);
`);

export interface FieldGl {
  gl: WebGL2RenderingContext;
  programs: Map<string, WebGLProgram>;
  maxSize: number;
}

/** One WebGL2 context per worker; null once it proved unavailable. */
let fieldGl: FieldGl | null | undefined;

function getFieldGl(): FieldGl | null {
  if (fieldGl?.gl.isContextLost()) fieldGl = undefined;
  if (fieldGl !== undefined) return fieldGl;
  fieldGl = null;
  if (typeof OffscreenCanvas === "undefined") return null;
  try {
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null;
    gl.bindVertexArray(gl.createVertexArray());
    fieldGl = { gl, programs: new Map(), maxSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number };
  } catch {
    fieldGl = null;
  }
  return fieldGl;
}

/** A cached program; the vertex shader defaults to the viewport-covering triangle. */
export function program(field: FieldGl, key: string, fragmentSource: string, vertexSource = VERTEX): WebGLProgram {
  const cached = field.programs.get(key);
  if (cached) return cached;
  const { gl } = field;
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Vegetation ${key} shader: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };
  const linked = gl.createProgram()!;
  gl.attachShader(linked, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(linked, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(linked);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) {
    throw new Error(`Vegetation ${key} program: ${gl.getProgramInfoLog(linked)}`);
  }
  field.programs.set(key, linked);
  return linked;
}

type TextureKind = "u8" | "unorm8" | "f32" | "i32" | "rgba32f" | "rgba8";

export function texture(
  gl: WebGL2RenderingContext,
  kind: TextureKind,
  width: number,
  height: number,
  data: ArrayBufferView | null,
): WebGLTexture {
  const created = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, created);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  if (kind === "u8") {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
  } else if (kind === "unorm8") {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, data);
  } else if (kind === "f32") {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, data);
  } else if (kind === "i32") {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, width, height, 0, gl.RED_INTEGER, gl.INT, data);
  } else if (kind === "rgba8") {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
  }
  return created;
}

/** Permutation rows for the four wash noises, in ROW_* order. */
function permutationData(seeds: VegetationFieldNoiseSeeds): Uint8Array {
  return permutationRows([seeds.flow, seeds.wash, seeds.dryPatch, seeds.grain]);
}

/** One 256-entry permutation row per seed, for a 256 × rows R8UI texture. */
export function permutationRows(seeds: readonly number[]): Uint8Array {
  const data = new Uint8Array(256 * seeds.length);
  seeds.forEach((seed, row) => data.set(simplexPermutation(seed), row * 256));
  return data;
}

export type UniformValue = { int: number | readonly number[] } | number | readonly number[];

interface PassInput {
  key: string;
  fragment: string;
  width: number;
  height: number;
  textures: Record<string, WebGLTexture>;
  uniforms: Record<string, UniformValue>;
  /** One render target per fragment output (default: one RGBA32F). */
  formats?: ReadonlyArray<"rgba32f" | "rgba8">;
}

function domainUniforms(domain: VegetationFieldDomain): Record<string, UniformValue> {
  return {
    uSize: { int: [domain.width, domain.height] },
    uOffset: { int: [domain.offsetX, domain.offsetY] },
    uOutputSize: { int: [domain.outputWidth, domain.outputHeight] },
    uOutputDenominator: [domain.outputXDenominator, domain.outputYDenominator],
    uSourceRange: [domain.sourceXRange, domain.sourceYRange],
    uGrainStride: { int: domain.grainStride | 0 },
    uGrainSalt: { int: domain.grainSalt | 0 },
    uGrainScale: domain.grainScale,
  };
}

/**
 * Draws one pass into new width × height textures, one per output (see
 * PassInput.formats). The caller owns (and deletes) the returned textures and
 * framebuffer.
 */
export function drawPass(field: FieldGl, pass: PassInput): {
  target: WebGLTexture;
  targets: WebGLTexture[];
  framebuffer: WebGLFramebuffer;
} {
  const { gl } = field;
  const linked = program(field, pass.key, pass.fragment);
  const targets = (pass.formats ?? ["rgba32f"]).map((format) => texture(gl, format, pass.width, pass.height, null));
  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  targets.forEach((target, index) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, gl.TEXTURE_2D, target, 0);
  });
  gl.drawBuffers(targets.map((_, index) => gl.COLOR_ATTACHMENT0 + index));
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    for (const target of targets) gl.deleteTexture(target);
    throw new Error("Vegetation field framebuffer incomplete");
  }
  gl.useProgram(linked);
  let unit = 0;
  for (const [name, bound] of Object.entries(pass.textures)) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, bound);
    gl.uniform1i(gl.getUniformLocation(linked, name), unit);
    unit++;
  }
  for (const [name, value] of Object.entries(pass.uniforms)) {
    const location = gl.getUniformLocation(linked, name);
    if (!location) continue;
    if (typeof value === "number") {
      gl.uniform1f(location, value);
    } else if ("int" in value) {
      const ints = value.int;
      if (typeof ints === "number") gl.uniform1i(location, ints);
      else gl.uniform2i(location, ints[0], ints[1]);
    } else {
      const floats = value as readonly number[];
      if (floats.length === 3) gl.uniform3f(location, floats[0], floats[1], floats[2]);
      else gl.uniform2f(location, floats[0], floats[1]);
    }
  }
  gl.viewport(0, 0, pass.width, pass.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return { target: targets[0], targets, framebuffer };
}

export function readPass(gl: WebGL2RenderingContext, framebuffer: WebGLFramebuffer, width: number, height: number): Float32Array {
  const pixels = new Float32Array(width * height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);
  return pixels;
}

/** Reads an RGBA8 output of a drawPass framebuffer. */
export function readPassBytes(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer,
  attachment: number,
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBuffer> {
  const pixels = new Uint8ClampedArray(width * height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return pixels;
}

/** Unpacks a packedFragment readback (four pixels per texel) to one value per pixel. */
function unpackLanes(packed: Float32Array, width: number, height: number): Float32Array {
  const rowTexels = Math.ceil(width / 4) * 4;
  if (rowTexels === width) return packed.length === width * height ? packed : packed.slice(0, width * height);
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    values.set(packed.subarray(y * rowTexels, y * rowTexels + width), y * width);
  }
  return values;
}

export function withField<T>(width: number, height: number, run: (field: FieldGl) => T): T | null {
  const field = getFieldGl();
  if (!field || width <= 0 || height <= 0 || width > field.maxSize || height > field.maxSize) return null;
  try {
    const result = run(field);
    if (field.gl.isContextLost()) return null;
    return result;
  } catch (error) {
    console.warn("Vegetation GPU fields fell back to the CPU", error);
    // A failing pass would fail again; keep this worker on the CPU.
    fieldGl = null;
    return null;
  }
}

/**
 * The wash tone, wash noise and wetland dryness of buildFlowBackgroundTone,
 * zero outside `clip` as there. Null when the GPU is unavailable.
 */
export function renderVegetationBackgroundGl(
  input: VegetationBackgroundGlInput,
): { tone: Float32Array; noise: Float32Array; dryness: Float32Array } | null {
  const { domain } = input;
  const { width, height } = domain;
  return withField(width, height, (field) => {
    const { gl } = field;
    const owned: WebGLTexture[] = [];
    const framebuffers: WebGLFramebuffer[] = [];
    try {
      const perm = texture(gl, "u8", 256, 4, permutationData(input.seeds));
      owned.push(perm);
      const shared = domainUniforms(domain);
      const potential = drawPass(field, {
        key: "potential",
        fragment: POTENTIAL_FRAGMENT,
        width: input.gridWidth,
        height: input.gridHeight,
        textures: { uPerm: perm },
        uniforms: {
          ...shared,
          uGridOrigin: { int: [input.gridOriginX, input.gridOriginY] },
          uFlowSalt: { int: input.flowSalt | 0 },
          uSwirlStrength: input.swirlStrength,
          uFlowScale: input.flowScale,
          uSwirlScale: input.swirlScale,
          uCellSize: input.cellSize,
        },
      });
      owned.push(potential.target);
      framebuffers.push(potential.framebuffer);
      const clip = texture(gl, "u8", width, height, input.clip);
      const biome = texture(gl, "u8", width, height, input.biomeType);
      const waterDistance = texture(gl, "f32", width, height, input.waterDistance);
      owned.push(clip, biome, waterDistance);
      const background = drawPass(field, {
        key: "background",
        fragment: BACKGROUND_FRAGMENT,
        width,
        height,
        textures: {
          uPerm: perm,
          uPotential: potential.target,
          uClip: clip,
          uBiome: biome,
          uWaterDistance: waterDistance,
        },
        uniforms: {
          ...shared,
          uGridOrigin: { int: [input.gridOriginX, input.gridOriginY] },
          uGridMax: { int: [input.gridWidth - 1, input.gridHeight - 1] },
          uBlurRadius: input.blurRadius,
          uWashNoiseScale: input.washNoiseScale,
          uDryPatchScale: input.dryPatchScale,
          uDryStart: input.dryDistanceStart,
          uDryEnd: input.dryDistanceEnd,
          uDryStrength: input.dryNoiseStrength,
        },
      });
      owned.push(background.target);
      framebuffers.push(background.framebuffer);
      const pixels = readPass(gl, background.framebuffer, width, height);
      const total = width * height;
      const tone = new Float32Array(total);
      const noise = new Float32Array(total);
      const dryness = new Float32Array(total);
      for (let index = 0; index < total; index++) {
        tone[index] = pixels[index * 4];
        noise[index] = pixels[index * 4 + 1];
        dryness[index] = pixels[index * 4 + 2];
      }
      return { tone, noise, dryness };
    } finally {
      for (const framebuffer of framebuffers) gl.deleteFramebuffer(framebuffer);
      for (const owner of owned) gl.deleteTexture(owner);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  });
}

export interface VegetationPotentialGlInput {
  domain: VegetationFieldDomain;
  flowSeed: number;
  gridOriginX: number;
  gridOriginY: number;
  gridWidth: number;
  gridHeight: number;
  flowSalt: number;
  swirlStrength: number;
  flowScale: number;
  swirlScale: number;
  cellSize: number;
}

/**
 * The flow potential at every cell of the two-pixel flow cache grid
 * (flowPotentialAtDirect at the cache's cell positions), as the wash pass
 * computes it. Null when the GPU is unavailable.
 */
export function renderVegetationPotentialGl(input: VegetationPotentialGlInput): Float32Array | null {
  return withField(input.gridWidth, input.gridHeight, (field) => {
    const { gl } = field;
    const perm = texture(gl, "u8", 256, 1, permutationRows([input.flowSeed]));
    let pass: ReturnType<typeof drawPass> | undefined;
    try {
      pass = drawPass(field, {
        key: "potential",
        fragment: POTENTIAL_FRAGMENT,
        width: input.gridWidth,
        height: input.gridHeight,
        textures: { uPerm: perm },
        uniforms: {
          ...domainUniforms(input.domain),
          uGridOrigin: { int: [input.gridOriginX, input.gridOriginY] },
          uFlowSalt: { int: input.flowSalt | 0 },
          uSwirlStrength: input.swirlStrength,
          uFlowScale: input.flowScale,
          uSwirlScale: input.swirlScale,
          uCellSize: input.cellSize,
        },
      });
      const pixels = readPass(gl, pass.framebuffer, input.gridWidth, input.gridHeight);
      const potential = new Float32Array(input.gridWidth * input.gridHeight);
      for (let index = 0; index < potential.length; index++) potential[index] = pixels[index * 4];
      return potential;
    } finally {
      if (pass) {
        gl.deleteFramebuffer(pass.framebuffer);
        gl.deleteTexture(pass.target);
      }
      gl.deleteTexture(perm);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  });
}

function renderPackedPass(
  domain: VegetationFieldDomain,
  grainSeed: number,
  key: string,
  fragment: string,
  textures: (gl: WebGL2RenderingContext) => Record<string, WebGLTexture>,
  uniforms: Record<string, UniformValue>,
): Float32Array | null {
  const { width, height } = domain;
  const packedWidth = Math.ceil(width / 4);
  return withField(width, height, (field) => {
    const { gl } = field;
    const owned: WebGLTexture[] = [];
    let framebuffer: WebGLFramebuffer | undefined;
    try {
      const seeds = { flow: grainSeed, wash: grainSeed, dryPatch: grainSeed, grain: grainSeed };
      const perm = texture(gl, "u8", 256, 4, permutationData(seeds));
      owned.push(perm);
      const inputs = textures(gl);
      owned.push(...Object.values(inputs));
      const pass = drawPass(field, {
        key,
        fragment,
        width: packedWidth,
        height,
        textures: { uPerm: perm, ...inputs },
        uniforms: { ...domainUniforms(domain), ...uniforms },
      });
      owned.push(pass.target);
      framebuffer = pass.framebuffer;
      return unpackLanes(readPass(gl, framebuffer, packedWidth, height), width, height);
    } finally {
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      for (const owner of owned) gl.deleteTexture(owner);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  });
}

/** buildDirectionalWashShadowCoverage on the GPU, or null. */
export function renderVegetationWashShadowGl(input: VegetationWashShadowGlInput): Float32Array | null {
  const { width, height } = input.domain;
  return renderPackedPass(input.domain, input.grainSeed, "washShadow", WASH_SHADOW_FRAGMENT, (gl) => ({
    uTone: texture(gl, "f32", width, height, input.tone),
    uClip: texture(gl, "u8", width, height, input.clip),
  }), {
    uMinus: input.minus,
    uCentre: input.centre,
    uPlus: input.plus,
    uShift: [input.shiftX, input.shiftY],
    uWashShadowGrain: input.washShadowGrain,
  });
}

/** buildNoisyDirectionalShadowCoverage on the GPU, or null. */
export function renderVegetationMotifShadowGl(input: VegetationMotifShadowGlInput): Float32Array | null {
  const { width, height } = input.domain;
  return renderPackedPass(input.domain, input.grainSeed, "motifShadow", MOTIF_SHADOW_FRAGMENT, (gl) => ({
    uAlpha: texture(gl, "unorm8", width, height, input.alpha),
    uClip: texture(gl, "u8", width, height, input.clip),
  }), {
    uShift: [input.shiftX, input.shiftY],
    uGrainRadius: input.grainRadius,
  });
}

export interface StandWashGlInput {
  /** First mask cell and size of the painted region. */
  x0: number;
  y0: number;
  width: number;
  height: number;
  unit: number;
  /** Stand mask over [mx0, mx0 + mw) × [my0, my0 + mh), already blurred. */
  local: Float32Array;
  mx0: number;
  my0: number;
  mw: number;
  mh: number;
  edgeFrom: number;
  edgeTo: number;
  bloomEdge: number;
  variation: number;
  wash: readonly number[];
  warm: readonly number[];
  seed: number;
  /** Stand light per painted cell (width × height), or none for 0.5 everywhere. */
  shade?: Float32Array;
  lightStrength: number;
  washStrength: number;
  washCellStrength: number;
  shift?: {
    step: number;
    columns: number;
    rows: number;
    rgb: Float32Array;
    base: readonly number[];
  };
}

/** forestStandWashCells (opaque, with wash cells) and shiftWashCells, as bytes. */
const STAND_WASH_FRAGMENT = /* glsl */ `${COMMON}
uniform sampler2D uMask;
uniform sampler2D uShade;
uniform sampler2D uShift;
uniform ivec2 uOrigin;
uniform ivec2 uMaskOrigin;
uniform int uHasShade;
uniform int uHasShift;
uniform ivec2 uShiftSize;
uniform float uShiftStep;
uniform vec3 uShiftBase;
uniform float uUnit;
uniform float uBloomEdge;
uniform float uVariation;
uniform float uEdgeFrom;
uniform float uEdgeTo;
uniform float uWashStrength;
uniform float uWashCellStrength;
uniform float uLightStrength;
uniform vec3 uWash;
uniform vec3 uWarm;
layout(location = 0) out vec4 outFill;
layout(location = 1) out vec4 outWash;

// smoothStep in forestStandGeometry.ts (no guard: its edges never meet).
float rampStep(float edge0, float edge1, float value) {
  float t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3.0 - 2.0 * t);
}

// A Uint8ClampedArray store: round half to even, then clamp.
vec3 toBytes(vec3 value) { return clamp(roundEven(value), 0.0, 255.0); }

// fbm in forestStandGeometry.ts.
float standFbm(int row, float x, float y) {
  float total = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;
  for (int octave = 0; octave < 4; octave++) {
    total += amplitude * noise2D(row, x * frequency, y * frequency);
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return total;
}

vec4 shiftCorner(int column, int row, float weight) {
  vec4 texel = texelFetch(uShift, ivec2(column, row), 0);
  // Alpha marks the cells that have a colour.
  if (weight <= 0.0 || texel.a < 0.5) return vec4(0.0);
  return vec4(texel.rgb * weight, weight);
}

// shiftWashCells: the bilinear field colour, weighted over coloured corners.
vec4 shiftAt(ivec2 cell) {
  float fy = clamp((float(cell.y) + 0.5) / uShiftStep - 0.5, 0.0, float(uShiftSize.y - 1));
  int r0 = int(floor(fy));
  int r1 = min(uShiftSize.y - 1, r0 + 1);
  float ty = fy - float(r0);
  float fx = clamp((float(cell.x) + 0.5) / uShiftStep - 0.5, 0.0, float(uShiftSize.x - 1));
  int c0 = int(floor(fx));
  int c1 = min(uShiftSize.x - 1, c0 + 1);
  float tx = fx - float(c0);
  return shiftCorner(c0, r0, (1.0 - tx) * (1.0 - ty)) + shiftCorner(c1, r0, tx * (1.0 - ty))
    + shiftCorner(c0, r1, (1.0 - tx) * ty) + shiftCorner(c1, r1, tx * ty);
}

void main() {
  ivec2 local = ivec2(gl_FragCoord.xy);
  ivec2 cell = uOrigin + local;
  float m = texelFetch(uMask, cell - uMaskOrigin, 0).r;
  float nx = float(cell.x) / uUnit;
  float ny = float(cell.y) / uUnit;
  float n = standFbm(0, nx / 14.0, ny / 14.0);
  float bloom = noise2D(1, nx / 38.0, ny / 38.0) + noise2D(1, nx / 11.0 + 50.0, ny / 11.0) * 0.35;
  float dark = rampStep(0.1, 0.1 + uBloomEdge, bloom) * 0.22 * uVariation;
  float pale = rampStep(-0.2, -0.2 - uBloomEdge, bloom) * 0.2 * uVariation;
  float warmMix = min(1.0, rampStep(0.2, 0.2 + uBloomEdge * 2.0, noise2D(1, nx / 60.0 + 90.0, ny / 60.0)) * 0.5 * uVariation);
  float shade = uHasShade == 1 ? texelFetch(uShade, local, 0).r : 0.5;
  float tone = shade < 0.5 ? 1.0 - 0.28 * uLightStrength / 0.7 : 1.0;
  float light = tone * (0.93 + n * 0.2 * uVariation - dark + pale);
  vec3 fill = toBytes((uWash * (1.0 - warmMix) + uWarm * warmMix) * light);
  bool inStand = m > 0.002;
  vec3 wash = inStand ? fill : vec3(0.0);
  float washAlpha = inStand
    ? clamp(roundEven(255.0 * clamp01(rampStep(uEdgeFrom, uEdgeTo, m) * uWashStrength * uWashCellStrength)), 0.0, 255.0)
    : 0.0;
  if (uHasShift == 1) {
    vec4 shift = shiftAt(cell);
    if (shift.a > 1e-6) {
      vec3 delta = shift.rgb / shift.a - uShiftBase;
      fill = toBytes(fill + delta);
      wash = toBytes(wash + delta);
    }
  }
  outFill = vec4(fill, 255.0) / 255.0;
  outWash = vec4(wash, washAlpha) / 255.0;
}
`;

/**
 * The stand wash textures (opaque tree fill and the wash) on the GPU, byte
 * for byte as the CPU painter stores them. Null when the GPU is unavailable.
 */
export function renderStandWashGl(
  input: StandWashGlInput,
): { fill: Uint8ClampedArray<ArrayBuffer>; wash: Uint8ClampedArray<ArrayBuffer> } | null {
  const { width, height } = input;
  if (input.mw <= 0 || input.mh <= 0) return null;
  return withField(Math.max(width, input.mw), Math.max(height, input.mh), (field) => {
    const { gl } = field;
    const owned: WebGLTexture[] = [];
    let framebuffer: WebGLFramebuffer | undefined;
    try {
      const textures: Record<string, WebGLTexture> = {
        uPerm: texture(gl, "u8", 256, 2, permutationRows([input.seed + 505, input.seed + 515])),
        uMask: texture(gl, "f32", input.mw, input.mh, input.local),
        uShade: input.shade
          ? texture(gl, "f32", width, height, input.shade)
          : texture(gl, "f32", 1, 1, new Float32Array(1)),
      };
      const { shift } = input;
      if (shift) {
        // RGB per grid cell with alpha 1 where it has a colour (NaN red: none).
        const texels = new Float32Array(shift.columns * shift.rows * 4);
        for (let cell = 0; cell < shift.columns * shift.rows; cell++) {
          if (Number.isNaN(shift.rgb[cell * 3])) continue;
          texels[cell * 4] = shift.rgb[cell * 3];
          texels[cell * 4 + 1] = shift.rgb[cell * 3 + 1];
          texels[cell * 4 + 2] = shift.rgb[cell * 3 + 2];
          texels[cell * 4 + 3] = 1;
        }
        textures.uShift = texture(gl, "rgba32f", shift.columns, shift.rows, texels);
      } else {
        textures.uShift = texture(gl, "rgba32f", 1, 1, new Float32Array(4));
      }
      owned.push(...Object.values(textures));
      const pass = drawPass(field, {
        key: "standWash",
        fragment: STAND_WASH_FRAGMENT,
        width,
        height,
        formats: ["rgba8", "rgba8"],
        textures,
        uniforms: {
          uOrigin: { int: [input.x0, input.y0] },
          uMaskOrigin: { int: [input.mx0, input.my0] },
          uHasShade: { int: input.shade ? 1 : 0 },
          uHasShift: { int: shift ? 1 : 0 },
          uShiftSize: { int: [shift?.columns ?? 1, shift?.rows ?? 1] },
          uShiftStep: shift?.step ?? 1,
          uShiftBase: [shift?.base[0] ?? 0, shift?.base[1] ?? 0, shift?.base[2] ?? 0],
          uUnit: input.unit,
          uBloomEdge: input.bloomEdge,
          uVariation: input.variation,
          uEdgeFrom: input.edgeFrom,
          uEdgeTo: input.edgeTo,
          uWashStrength: input.washStrength,
          uWashCellStrength: input.washCellStrength,
          uLightStrength: input.lightStrength,
          uWash: [input.wash[0], input.wash[1], input.wash[2]],
          uWarm: [input.warm[0], input.warm[1], input.warm[2]],
        },
      });
      owned.push(...pass.targets);
      framebuffer = pass.framebuffer;
      return {
        fill: readPassBytes(gl, framebuffer, 0, width, height),
        wash: readPassBytes(gl, framebuffer, 1, width, height),
      };
    } finally {
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      for (const owner of owned) gl.deleteTexture(owner);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  });
}

/** The rasters the alpine forest suitability reads (see sampleAlpineForestTerrainSuitability). */
export interface ForestCandidateTerrain {
  width: number;
  height: number;
  biomeType: Uint8Array;
  slopeDeg?: ArrayLike<number>;
  precipitationMmYr?: ArrayLike<number>;
  runoffDepthMmYr?: ArrayLike<number>;
  elevation?: ArrayLike<number>;
  dxMeters?: number;
  dyMeters?: number;
  /** 1 where isWaterAt holds. */
  water: () => Uint8Array;
}

export interface ForestCandidateGlInput {
  attempts: number;
  seed: number;
  width: number;
  height: number;
  /** Gap ellipses: x, y, radius, aspect, cos, sin, phase per gap. */
  gaps: Float32Array;
  gapCellSize: number;
  gapColumns: number;
  /** Gap ids per grid cell index, as offsets into `gapIndices` (cells + 1 entries). */
  gapStarts: Int32Array;
  gapIndices: Int32Array;
  /** Tree candidates read the terrain and keep to their biome; shrubs do neither. */
  terrain?: ForestCandidateTerrain;
  targetBiome?: number;
  /** blendedBiomeLookup's warp, when the biome borders are blended. */
  biomeBlend?: { blend: number; seed: number };
}

/**
 * Per attempt: 0 no candidate, 1 a candidate, 2 too close to a rounding edge
 * or threshold to tell in float32 (the caller evaluates it exactly). For a
 * candidate, its habitat weight, or NaN when the weight is too close to the
 * placement roll to stand in for the exact one.
 */
export interface ForestCandidateGlResult {
  codes: Uint8Array;
  habitat: Float32Array;
}

/** Uniform rows of the integer and gap textures. */
const LAYOUT_WIDTH = 2048;
/** Output texels per row: one attempt each. */
const ATTEMPT_ROW = 4096;

const FOREST_CANDIDATE_FRAGMENT = /* glsl */ `${COMMON}
uniform highp usampler2D uBiome;
uniform highp usampler2D uWater;
uniform sampler2D uSlope;
uniform sampler2D uPrecipitation;
uniform sampler2D uRunoff;
uniform sampler2D uElevation;
uniform sampler2D uGaps;
uniform highp isampler2D uGapStarts;
uniform highp isampler2D uGapIndices;
uniform int uAttempts;
uniform int uSeed;
uniform ivec2 uDem;
uniform int uTargetBiome;
uniform float uBlend;
uniform int uHasTerrain;
uniform int uHasPrecipitation;
uniform int uHasRunoff;
uniform int uHasElevation;
uniform vec2 uCellMeters;
uniform float uGapCellSize;
uniform int uGapColumns;
uniform int uGapCells;
out vec4 outColor;

const int LAYOUT = ${LAYOUT_WIDTH};
const float ROUND_EPS = 1e-4;
const float WARP_EPS = 5e-3;
const float COMPARE_EPS = 4e-3;
// Rasters store non-finite values as this (see the absent checks).
const float ABSENT = -1e37;

bool fragile = false;

ivec2 layoutAt(int index) { return ivec2(index % LAYOUT, index / LAYOUT); }

// hash01(key, salt) * size, as a whole part and a fraction accurate to 2^-24:
// the CPU's coordinate h * size / 2^32 is exact in float64.
vec2 scaledHash(uint key, int salt, int size) {
  uint h = hashBits(key, salt);
  uint n = uint(size);
  uint high = (h >> 16u) * n;
  uint low = (h & 0xffffu) * n;
  uint middle = high + (low >> 16u);
  uint fraction = ((middle & 0xffffu) << 16u) | (low & 0xffffu);
  return vec2(float(middle >> 16u), float(fraction >> 8u) * (1.0 / 16777216.0));
}

// Math.round(whole + part), flagging a part this close to a half.
int roundCoordinate(float whole, float part, float eps) {
  float shift = floor(part);
  float fraction = part - shift;
  if (abs(fraction - 0.5) < eps) fragile = true;
  return int(whole + shift) + (fraction >= 0.5 ? 1 : 0);
}

int clampedRound(float whole, float part, float eps, int size) {
  return clamp(roundCoordinate(whole, part, eps), 0, size - 1);
}

// biomeAt, through blendedBiomeLookup's warp when it has one.
int biomeLookup(vec2 whole, vec2 part) {
  vec2 shift = vec2(0.0);
  float eps = ROUND_EPS;
  if (uBlend > 0.0) {
    vec2 p = (whole + part) / uBlend;
    shift = vec2(fbm(0, p, 3, 2.0, 0.5), fbm(1, p, 3, 2.0, 0.5)) * uBlend * 1.2;
    eps = WARP_EPS;
  }
  int x = clampedRound(whole.x, part.x + shift.x, eps, uDem.x);
  int y = clampedRound(whole.y, part.y + shift.y, eps, uDem.y);
  return int(texelFetch(uBiome, ivec2(x, y), 0).r);
}

// sampleAlpineForestTerrainSuitability: (habitat weight, shelter).
vec2 alpineSuitability(vec2 whole, vec2 part) {
  int centreX = clampedRound(whole.x, part.x, ROUND_EPS, uDem.x);
  int centreY = clampedRound(whole.y, part.y, ROUND_EPS, uDem.y);
  ivec2 centre = ivec2(centreX, centreY);
  float slope = texelFetch(uSlope, centre, 0).r;
  float slopeWeight = slope <= ABSENT ? 1.0 : 1.0 - smoothStep(20.0, 50.0, slope);
  if (slope > ABSENT && slope < 50.0 && slopeWeight < 1e-4) fragile = true;
  if (slopeWeight <= 0.0) return vec2(0.0, 0.5);
  float precipitation = uHasPrecipitation == 1 ? texelFetch(uPrecipitation, centre, 0).r : ABSENT;
  float runoff = uHasRunoff == 1 ? texelFetch(uRunoff, centre, 0).r : ABSENT;
  float signals = 0.0;
  float signalSum = 0.0;
  if (precipitation > ABSENT) { signals += 1.0; signalSum += clamp01((precipitation - 350.0) / 1450.0); }
  if (runoff > ABSENT) { signals += 1.0; signalSum += clamp01(runoff / 1000.0); }
  float moisture = signals > 0.0 ? 0.84 + 0.16 * signalSum / signals : 1.0;
  float base = slopeWeight * moisture;
  if (uHasElevation == 0) return vec2(base, 0.5);
  float centreElevation = texelFetch(uElevation, centre, 0).r;
  const float DIAGONAL = 0.7071067811865476;
  vec2 directions[8] = vec2[8](
    vec2(1.0, 0.0), vec2(DIAGONAL, DIAGONAL), vec2(0.0, 1.0), vec2(-DIAGONAL, DIAGONAL),
    vec2(-1.0, 0.0), vec2(-DIAGONAL, -DIAGONAL), vec2(0.0, -1.0), vec2(DIAGONAL, -DIAGONAL));
  float exposure = 0.0;
  float hollow = 0.0;
  float scales = 0.0;
  for (int scale = 0; scale < 2; scale++) {
    float radius = scale == 0 ? 150.0 : 450.0;
    float sum = 0.0;
    float count = 0.0;
    for (int direction = 0; direction < 8; direction++) {
      vec2 offset = directions[direction] * radius / uCellMeters;
      vec2 samplePart = part + offset;
      vec2 point = whole + samplePart;
      if (abs(point.x) < 1e-3 || abs(point.y) < 1e-3
        || abs(point.x - float(uDem.x)) < 1e-3 || abs(point.y - float(uDem.y)) < 1e-3) fragile = true;
      if (point.x < 0.0 || point.y < 0.0 || point.x >= float(uDem.x) || point.y >= float(uDem.y)) continue;
      ivec2 cell = ivec2(
        clampedRound(whole.x, samplePart.x, ROUND_EPS, uDem.x),
        clampedRound(whole.y, samplePart.y, ROUND_EPS, uDem.y));
      if (texelFetch(uWater, cell, 0).r != 0u) continue;
      sum += texelFetch(uElevation, cell, 0).r;
      count += 1.0;
    }
    if (count < 4.0) continue;
    float relief = (centreElevation - sum / count) / radius;
    exposure += smoothStep(0.015, 0.1, relief);
    hollow += smoothStep(0.015, 0.1, -relief);
    scales += 1.0;
  }
  if (scales == 0.0) return vec2(base, 0.5);
  exposure /= scales;
  hollow /= scales;
  float shelter = clamp01(0.5 + (hollow - exposure) * 0.5);
  return vec2(base * clamp01(1.0 - exposure * 0.72 + hollow * 0.12), shelter);
}

// woodlandAt in buildForestCandidates.
float woodlandAt(vec2 whole, vec2 part, float shelter) {
  vec2 point = whole + part;
  float woodland = 1.0;
  int column = int(floor(point.x / uGapCellSize)) + 2;
  int row = int(floor(point.y / uGapCellSize)) + 2;
  int cell = row * uGapColumns + column;
  if (cell >= 0 && cell < uGapCells) {
    int start = texelFetch(uGapStarts, layoutAt(cell), 0).r;
    int end = texelFetch(uGapStarts, layoutAt(cell + 1), 0).r;
    for (int entry = start; entry < end; entry++) {
      int gap = texelFetch(uGapIndices, layoutAt(entry), 0).r;
      vec4 shape = texelFetch(uGaps, layoutAt(gap * 2), 0);
      vec4 turn = texelFetch(uGaps, layoutAt(gap * 2 + 1), 0);
      vec2 d = (whole - shape.xy) + part;
      float u = (d.x * turn.x + d.y * turn.y) / shape.z;
      float v = (-d.x * turn.y + d.y * turn.x) / (shape.z * shape.w);
      if (u == 0.0 && v == 0.0) {
        woodland = 0.0;
        continue;
      }
      float angle = atan(v, u);
      float edge = 1.0 + 0.18 * sin(angle * 3.0 + turn.z) + 0.1 * sin(angle * 5.0 - turn.z);
      woodland = min(woodland, smoothStep(0.8, 1.25, length(vec2(u, v)) / edge));
    }
  }
  return clamp01(1.0 - (1.0 - woodland) * (1.5 - shelter));
}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  int index = texel.y * ${ATTEMPT_ROW} + texel.x;
  if (index >= uAttempts) {
    outColor = vec4(0.0);
    return;
  }
  uint key = (uint(index + 1) * 3812015801u) ^ uint(uSeed);
  vec2 x = scaledHash(key, 911, uDem.x);
  vec2 y = scaledHash(key, 919, uDem.y);
  vec2 whole = vec2(x.x, y.x);
  vec2 part = vec2(x.y, y.y);
  if (uTargetBiome >= 0) {
    int biome = biomeLookup(whole, part);
    if (fragile) { outColor = vec4(2.0, 0.0, 0.0, 0.0); return; }
    if (biome != uTargetBiome) { outColor = vec4(0.0); return; }
  }
  vec2 suitability = vec2(-1.0, 0.5);
  if (uHasTerrain == 1) {
    suitability = alpineSuitability(whole, part);
    if (fragile) { outColor = vec4(2.0, 0.0, 0.0, 0.0); return; }
  }
  float woodland = woodlandAt(whole, part, suitability.y);
  float roll = hash01(key, 929);
  if (abs(roll - woodland) < COMPARE_EPS) { outColor = vec4(2.0, 0.0, 0.0, 0.0); return; }
  if (roll >= woodland) { outColor = vec4(0.0); return; }
  // The placement keeps a tree when hash01(key, 941) < habitat weight.
  float habitatFragile = uHasTerrain == 1 && abs(hash01(key, 941) - suitability.x) < COMPARE_EPS ? 1.0 : 0.0;
  outColor = vec4(1.0, suitability.x, habitatFragile, 0.0);
}
`;

/** Terrain textures of the last DEM, reused by every biome and kind of a placement pass. */
let forestTerrainTextures: {
  gl: WebGL2RenderingContext;
  terrain: object;
  textures: Record<string, WebGLTexture>;
  flags: Record<string, number>;
} | undefined;

function finiteOrAbsent(values: ArrayLike<number> | undefined, total: number): Float32Array | undefined {
  if (!values || values.length < total) return undefined;
  const data = new Float32Array(total);
  for (let index = 0; index < total; index++) {
    const value = values[index];
    data[index] = Number.isFinite(value) ? value : -1e38;
  }
  return data;
}

function forestTerrainTexturesFor(gl: WebGL2RenderingContext, terrain: ForestCandidateTerrain) {
  if (forestTerrainTextures?.terrain === terrain && forestTerrainTextures.gl === gl) return forestTerrainTextures;
  if (forestTerrainTextures?.gl === gl) {
    for (const owned of Object.values(forestTerrainTextures.textures)) gl.deleteTexture(owned);
  }
  forestTerrainTextures = undefined;
  const { width, height } = terrain;
  const total = width * height;
  const empty = () => texture(gl, "f32", 1, 1, new Float32Array(1));
  const upload = (values: Float32Array | undefined) => values ? texture(gl, "f32", width, height, values) : empty();
  const slope = finiteOrAbsent(terrain.slopeDeg, total);
  const precipitation = finiteOrAbsent(terrain.precipitationMmYr, total);
  const runoff = finiteOrAbsent(terrain.runoffDepthMmYr, total);
  const elevation = !terrain.elevation || terrain.elevation.length < total
    ? undefined
    : terrain.elevation instanceof Float32Array
      ? terrain.elevation
      : Float32Array.from({ length: total }, (_, index) => terrain.elevation![index]);
  const cellMetersValid = [terrain.dxMeters, terrain.dyMeters].every((value) =>
    value !== undefined && Number.isFinite(value) && value > 0);
  forestTerrainTextures = {
    gl,
    terrain,
    textures: {
      uBiome: texture(gl, "u8", width, height, terrain.biomeType),
      uWater: texture(gl, "u8", width, height, terrain.water()),
      // Slope: a missing raster reads as "no slope limit", like a non-finite value.
      uSlope: upload(slope ?? new Float32Array(total).fill(-1e38)),
      uPrecipitation: upload(precipitation),
      uRunoff: upload(runoff),
      uElevation: upload(elevation),
    },
    flags: {
      uHasPrecipitation: precipitation ? 1 : 0,
      uHasRunoff: runoff ? 1 : 0,
      uHasElevation: elevation && cellMetersValid ? 1 : 0,
    },
  };
  return forestTerrainTextures;
}

function layoutTexture(gl: WebGL2RenderingContext, kind: "i32" | "rgba32f", values: Int32Array | Float32Array, perTexel: number) {
  const texels = Math.max(1, values.length / perTexel);
  const rows = Math.ceil(texels / LAYOUT_WIDTH);
  const padded = kind === "i32" ? new Int32Array(LAYOUT_WIDTH * rows * perTexel) : new Float32Array(LAYOUT_WIDTH * rows * perTexel);
  padded.set(values);
  return texture(gl, kind, LAYOUT_WIDTH, rows, padded);
}

/** buildForestCandidates' attempt loop on the GPU, or null. */
export function renderForestCandidatesGl(input: ForestCandidateGlInput): ForestCandidateGlResult | null {
  const { attempts } = input;
  if (attempts <= 0) return { codes: new Uint8Array(0), habitat: new Float32Array(0) };
  const rows = Math.ceil(attempts / ATTEMPT_ROW);
  const width = Math.min(attempts, ATTEMPT_ROW);
  return withField(Math.max(width, input.terrain?.width ?? 1, LAYOUT_WIDTH), Math.max(rows, input.terrain?.height ?? 1), (field) => {
    const { gl } = field;
    const owned: WebGLTexture[] = [];
    let framebuffer: WebGLFramebuffer | undefined;
    try {
      const blend = input.biomeBlend && input.biomeBlend.blend > 0 ? input.biomeBlend : undefined;
      const terrain = input.terrain ? forestTerrainTexturesFor(gl, input.terrain) : undefined;
      const local: Record<string, WebGLTexture> = {
        uPerm: texture(gl, "u8", 256, 2, permutationRows(blend
          ? [blend.seed ^ 0x3b1e5a7d, blend.seed ^ 0x6c0f92e1]
          : [0, 0])),
        uGaps: layoutTexture(gl, "rgba32f", gapTexels(input.gaps), 4),
        uGapStarts: layoutTexture(gl, "i32", input.gapStarts, 1),
        uGapIndices: layoutTexture(gl, "i32", input.gapIndices.length ? input.gapIndices : new Int32Array(1), 1),
      };
      owned.push(...Object.values(local));
      const placeholder = terrain ? undefined : texture(gl, "f32", 1, 1, new Float32Array(1));
      const placeholderU8 = terrain ? undefined : texture(gl, "u8", 1, 1, new Uint8Array(1));
      if (placeholder) owned.push(placeholder);
      if (placeholderU8) owned.push(placeholderU8);
      const terrainTextures = terrain?.textures ?? {
        uBiome: placeholderU8!, uWater: placeholderU8!,
        uSlope: placeholder!, uPrecipitation: placeholder!, uRunoff: placeholder!, uElevation: placeholder!,
      };
      const pass = drawPass(field, {
        key: "forestCandidates",
        fragment: FOREST_CANDIDATE_FRAGMENT,
        width,
        height: rows,
        textures: { ...local, ...terrainTextures },
        uniforms: {
          uAttempts: { int: attempts },
          uSeed: { int: input.seed | 0 },
          uDem: { int: [input.width, input.height] },
          uTargetBiome: { int: input.terrain && input.targetBiome !== undefined ? input.targetBiome : -1 },
          uBlend: blend?.blend ?? 0,
          uHasTerrain: { int: terrain ? 1 : 0 },
          uHasPrecipitation: { int: terrain?.flags.uHasPrecipitation ?? 0 },
          uHasRunoff: { int: terrain?.flags.uHasRunoff ?? 0 },
          uHasElevation: { int: terrain?.flags.uHasElevation ?? 0 },
          uCellMeters: [input.terrain?.dxMeters ?? 1, input.terrain?.dyMeters ?? 1],
          uGapCellSize: input.gapCellSize,
          uGapColumns: { int: input.gapColumns },
          uGapCells: { int: input.gapStarts.length - 1 },
        },
      });
      owned.push(...pass.targets);
      framebuffer = pass.framebuffer;
      const pixels = readPass(gl, framebuffer, width, rows);
      const codes = new Uint8Array(attempts);
      const habitat = new Float32Array(attempts);
      for (let index = 0; index < attempts; index++) {
        codes[index] = pixels[index * 4];
        habitat[index] = pixels[index * 4 + 2] > 0 ? Number.NaN : pixels[index * 4 + 1];
      }
      return { codes, habitat };
    } finally {
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      for (const texture of owned) gl.deleteTexture(texture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  });
}

/** Seven gap values to two RGBA texels: (x, y, radius, aspect), (cos, sin, phase, 0). */
function gapTexels(gaps: Float32Array): Float32Array {
  const count = gaps.length / 7;
  const texels = new Float32Array(Math.max(1, count) * 8);
  for (let gap = 0; gap < count; gap++) {
    texels.set(gaps.subarray(gap * 7, gap * 7 + 4), gap * 8);
    texels.set(gaps.subarray(gap * 7 + 4, gap * 7 + 7), gap * 8 + 4);
  }
  return texels;
}

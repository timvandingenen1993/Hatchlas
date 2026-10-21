/**
 * Mountain illustration material shading on the GPU.
 *
 * The material pass evaluates three noises per pixel from a few inputs, so
 * it gains on the GPU even with each tile's upload and readback. (The
 * lighting/initial-snow pass reads 22 fields for light per-pixel math; at
 * 8K tile sizes its upload cost what the CPU loop did, so it stays on the
 * CPU.) Like the vegetation fields (vegetationFieldGl.ts) this runs as a
 * synchronous WebGL2 fragment pass, reproduces its CPU loop in
 * mountainIllustrationRenderer.ts, and returns null when the GPU is
 * unavailable so the caller stays on the CPU.
 */
import {
  COMMON,
  drawPass,
  permutationRows,
  readPassBytes,
  texture,
  withField,
  type FieldGl,
} from "./vegetationFieldGl";

/** Bilinear lookups shared by both passes (sampleScalarField: clamped, bilinear). */
const SAMPLING = /* glsl */ `
vec4 bilinear(sampler2D field, float x, float y) {
  float cx = clamp(x, 0.0, float(uSize.x - 1));
  float cy = clamp(y, 0.0, float(uSize.y - 1));
  int x0 = int(floor(cx));
  int y0 = int(floor(cy));
  int x1 = min(uSize.x - 1, x0 + 1);
  int y1 = min(uSize.y - 1, y0 + 1);
  float tx = cx - float(x0);
  float ty = cy - float(y0);
  vec4 top = texelFetch(field, ivec2(x0, y0), 0) * (1.0 - tx) + texelFetch(field, ivec2(x1, y0), 0) * tx;
  vec4 bottom = texelFetch(field, ivec2(x0, y1), 0) * (1.0 - tx) + texelFetch(field, ivec2(x1, y1), 0) * tx;
  return top * (1.0 - ty) + bottom * ty;
}
`;

/** The per-pixel loop under "mountain illustration material shading". */
const MATERIAL_FRAGMENT = /* glsl */ `${COMMON}
${SAMPLING}
// (projected tone, projected snow, projected shadow, sourceY)
uniform sampler2D uProjected;
// (slopeDeg, normalizedElevation, tpi, solarInsolation)
uniform sampler2D uTerrain;
uniform sampler2D uEdgeDistance;
uniform highp usampler2D uAlpha;
uniform highp usampler2D uBiome;
uniform ivec2 uWorldOffset;
uniform float uScale;
uniform int uStride;
uniform int uSeedSalt;
uniform float uWashScale;
uniform float uWashNoiseStrength;
uniform float uHillshade;
uniform int uLightingMode;
uniform vec3 uRock0;
uniform vec3 uRock1;
uniform vec3 uRock2;
uniform vec3 uSnow0;
uniform vec3 uSnow1;
uniform vec3 uSnow2;
uniform float uSnowToneMidpoint;
uniform int uHasGreen;
uniform vec3 uGreen;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outLayers;

const int ROW_GRAIN_NOISE = 0;
const int ROW_WASH_NOISE = 1;
const int ROW_PATCH_NOISE = 2;

float filterGradient(float value, float grain) {
  return clamp01(value + grain * 0.22 * (4.0 * value * (1.0 - value)));
}

float filterSignedGradient(float value, float grain) {
  return clamp(value + grain * 0.22 * (1.0 - value * value), -1.0, 1.0);
}

// smoothstep in mountainTerrainTint.ts (no guard: its edges never meet).
float tintStep(float edge0, float edge1, float value) {
  float t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3.0 - 2.0 * t);
}

float luminance(vec3 color) { return color.r * 0.299 + color.g * 0.587 + color.b * 0.114; }

float baseGreenAmount(float slopeDeg, float normElev, float tpi) {
  float flatness = 1.0 - tintStep(6.0, 16.0, slopeDeg);
  float ridge = clamp(tpi / 60.0, -1.0, 1.0);
  return (flatness * 0.6 + max(0.0, -ridge) * 0.15) * (1.0 - tintStep(0.55, 0.85, normElev));
}

// tintMountainLand.
vec3 tintLand(vec3 base, float slopeDeg, float normElev, float tpi, float insolation, float noise) {
  float baseLum = luminance(base);
  float steep = tintStep(28.0, 45.0, slopeDeg);
  float highness = tintStep(0.5, 1.0, normElev);
  float ridge = clamp(tpi / 60.0, -1.0, 1.0);
  vec3 color = base;
  float greenGain = clamp(baseLum / max(1.0, luminance(uGreen)), 0.5, 1.6);
  float greenAmount = clamp(baseGreenAmount(slopeDeg, normElev, tpi) * (1.0 + noise * 0.35), 0.0, 1.0);
  color += (uGreen * greenGain - color) * greenAmount;
  float lum = luminance(color);
  float coolAmount = min(1.0, steep * 0.35 + highness * 0.22);
  color += (lum * vec3(0.94, 1.0, 1.1) - color) * coolAmount;
  float warmth = (insolation - 0.5) * 2.0;
  float value = 1.0 + ridge * 0.08 + noise * 0.08;
  color.r *= value * (1.0 + warmth * 0.08 + noise * 0.03);
  color.g *= value * (1.0 + warmth * 0.03);
  color.b *= value * (1.0 - warmth * 0.08 - noise * 0.03);
  return clamp(color, 0.0, 255.0);
}

float stylize(float light) {
  float value = clamp01(light);
  if (uLightingMode == 2) return value >= 0.5 ? 0.84 : 0.24;
  if (uLightingMode == 3) return value >= 0.62 ? 1.0 : value >= 0.30 ? 0.5 : 0.0;
  return value;
}

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  uint alphaByte = texelFetch(uAlpha, pixel, 0).r;
  if (alphaByte == 0u) {
    outColor = vec4(0.0);
    outLayers = vec4(0.0);
    return;
  }
  vec4 projected = texelFetch(uProjected, pixel, 0);
  vec4 terrain = texelFetch(uTerrain, pixel, 0);
  int worldX = pixel.x + uWorldOffset.x;
  int worldY = pixel.y + uWorldOffset.y;
  vec2 scaled = vec2(float(worldX), float(worldY)) / uScale;
  // sampleCartographicGrain at pattern scale 1.
  float coarse = clamp01(0.5 + fbm(ROW_GRAIN_NOISE, scaled / 2.6, 3, 1.9, 0.56) * 0.5);
  float fine = hash01(uint(worldY) * uint(uStride) + uint(worldX), uSeedSalt);
  float grain = (coarse * 0.48 + fine * 0.52) * 2.0 - 1.0;
  vec2 washWarp = domainWarp(ROW_WASH_NOISE, scaled / uWashScale, 0.38);
  float washNoise = clamp01(0.5 + fbm(ROW_WASH_NOISE, washWarp, 3, 1.9, 0.55) * 0.5) * 2.0 - 1.0;
  float noise = filterSignedGradient(washNoise, grain);
  float tone = filterGradient(clamp01(projected.x + noise * uWashNoiseStrength * 0.26), grain * 0.4);
  float contrastTone = 1.0 - uHillshade * (1.0 - stylize(clamp01(0.5 + (tone - 0.5) * 1.32)));
  float snowBase = projected.y;
  vec2 patchCoarse = domainWarp(ROW_PATCH_NOISE, scaled / 24.0, 0.6);
  vec2 patchFine = domainWarp(ROW_PATCH_NOISE, scaled / (24.0 * 0.42), 0.35);
  float patchNoise = clamp01(0.5 + (fbm(ROW_PATCH_NOISE, patchCoarse, 3, 1.95, 0.56) * 0.68
    + fbm(ROW_PATCH_NOISE, patchFine, 2, 1.9, 0.5) * 0.32) * 0.5);
  float roughEdge = ((patchNoise - 0.5) * 0.38 + grain * 0.08) * 2.0 * snowBase * (1.0 - snowBase);
  float snow = clamp01((snowBase + roughEdge - 0.28) / 0.3);
  bool darkHalf = contrastTone < 0.5;
  float t = darkHalf ? contrastTone * 2.0 : (contrastTone - 0.5) * 2.0;
  float snowTone = darkHalf
    ? 0.02 + pow(contrastTone, 1.35) * 0.9
    : uSnowToneMidpoint + pow((contrastTone - 0.5) * 2.0, 0.82) * (1.0 - uSnowToneMidpoint);
  bool snowDark = snowTone < 0.5;
  float snowT = snowDark ? snowTone * 2.0 : (snowTone - 0.5) * 2.0;
  float surfaceShadow = uHillshade * clamp01(projected.z * 3.2);
  vec3 rock = darkHalf ? uRock0 * (1.0 - t) + uRock1 * t : uRock1 * (1.0 - t) + uRock2 * t;
  if (uHasGreen == 1 && snow < 1.0) rock = tintLand(rock, terrain.x, terrain.y, terrain.z, terrain.w, noise);
  vec3 ice = snowDark ? uSnow0 * (1.0 - snowT) + uSnow1 * snowT : uSnow1 * (1.0 - snowT) + uSnow2 * snowT;
  vec3 color = clamp(roundEven((rock * (1.0 - snow) + ice * snow) * (1.0 - surfaceShadow * 0.42)), 0.0, 255.0);
  float edgeDistance = bilinear(uEdgeDistance, float(pixel.x), projected.w).x;
  float inkInterior = clamp01(edgeDistance / (28.0 * uScale));
  float groundBreakup = clamp01((terrain.x - 3.0) / 26.0 + (terrain.y - 0.26) * 0.24);
  float edgeAlpha = clamp01(edgeDistance / (6.0 * uScale) + (patchNoise - 0.5) * (0.12 + groundBreakup * 0.08));
  uint biome = texelFetch(uBiome, pixel, 0).r;
  bool tintBiome = (biome >= 1u && biome <= 5u) || biome == 20u;
  // mountainGrassAmount.
  float grassFlat = uHasGreen == 1 && tintBiome
    ? tintStep(0.35, 0.65, baseGreenAmount(terrain.x, terrain.y, terrain.z) / 0.6) * (1.0 - snow)
    : 0.0;
  float alpha = clamp(floor(filterGradient(float(alphaByte) / 255.0 * edgeAlpha, grain) * (1.0 - grassFlat) * 255.0 + 0.5), 0.0, 255.0);
  outColor = vec4(color, alpha) / 255.0;
  outLayers = vec4(floor(snow * 255.0 + 0.5), inkInterior, grassFlat, 0.0);
}
`;

function run<T>(width: number, height: number, body: (field: FieldGl, owned: WebGLTexture[]) => T): T | null {
  return withField(width, height, (field) => {
    const owned: WebGLTexture[] = [];
    try {
      return body(field, owned);
    } finally {
      for (const created of owned) field.gl.deleteTexture(created);
      field.gl.bindFramebuffer(field.gl.FRAMEBUFFER, null);
    }
  });
}

export interface MountainMaterialGlInput {
  width: number;
  height: number;
  /** Projected (tone, snow, shadow) per pixel, three values each. */
  projectedMaterial: Float32Array;
  sourceY: Float32Array;
  slopeDeg: ArrayLike<number>;
  normalizedElevation: ArrayLike<number>;
  tpi?: ArrayLike<number>;
  /** solarInsolation, read as 0.5 where missing. */
  solarInsolation: ArrayLike<number>;
  edgeDistance: Float32Array;
  /** The projected RGBA; only its alpha is read. */
  rgba: Uint8ClampedArray;
  biomeType: Uint8Array;
  offsetX: number;
  offsetY: number;
  scale: number;
  stride: number;
  seed: number;
  washNoiseScale: number;
  washNoiseStrength: number;
  hillshadeStrength: number;
  lightingMode: "continuous" | "three-tone" | "two-tone";
  rockStops: readonly (readonly number[])[];
  snowStops: readonly (readonly number[])[];
  snowToneAtMidpoint: number;
  landGreen?: readonly number[];
}

export interface MountainMaterialGlResult {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  snowCoverageAlpha: Uint8Array;
  inkInterior: Float32Array;
  grassFade: Float32Array;
}

/** The material shading loop on the GPU, or null. */
export function renderMountainMaterialGl(input: MountainMaterialGlInput): MountainMaterialGlResult | null {
  const { width, height } = input;
  const total = width * height;
  return run(width, height, (field, owned) => {
    const { gl } = field;
    const projected = new Float32Array(total * 4);
    for (let index = 0; index < total; index++) {
      projected[index * 4] = input.projectedMaterial[index * 3];
      projected[index * 4 + 1] = input.projectedMaterial[index * 3 + 1];
      projected[index * 4 + 2] = input.projectedMaterial[index * 3 + 2];
      projected[index * 4 + 3] = input.sourceY[index];
    }
    const terrain = new Float32Array(total * 4);
    for (let index = 0; index < total; index++) {
      terrain[index * 4] = input.slopeDeg[index];
      terrain[index * 4 + 1] = input.normalizedElevation[index];
      terrain[index * 4 + 2] = input.tpi?.[index] ?? 0;
      terrain[index * 4 + 3] = input.solarInsolation[index] ?? 0.5;
    }
    const alpha = new Uint8Array(total);
    for (let index = 0; index < total; index++) alpha[index] = input.rgba[index * 4 + 3];
    const textures = {
      uPerm: texture(gl, "u8", 256, 3, permutationRows([input.seed + 3221, input.seed + 1403, input.seed + 1801])),
      uProjected: texture(gl, "rgba32f", width, height, projected),
      uTerrain: texture(gl, "rgba32f", width, height, terrain),
      uEdgeDistance: texture(gl, "f32", width, height, input.edgeDistance),
      uAlpha: texture(gl, "u8", width, height, alpha),
      uBiome: texture(gl, "u8", width, height, input.biomeType),
    };
    owned.push(...Object.values(textures));
    const [rock0, rock1, rock2] = input.rockStops;
    const [snow0, snow1, snow2] = input.snowStops;
    const vec3 = (color: readonly number[]) => [color[0], color[1], color[2]] as const;
    const pass = drawPass(field, {
      key: "mountainMaterial",
      fragment: MATERIAL_FRAGMENT,
      width,
      height,
      formats: ["rgba8", "rgba32f"],
      textures,
      uniforms: {
        uSize: { int: [width, height] },
        uWorldOffset: { int: [input.offsetX, input.offsetY] },
        uScale: input.scale,
        uStride: { int: input.stride | 0 },
        uSeedSalt: { int: (input.seed + 3379) | 0 },
        uWashScale: 140 / Math.max(0.25, input.washNoiseScale),
        uWashNoiseStrength: input.washNoiseStrength,
        uHillshade: input.hillshadeStrength,
        uLightingMode: { int: input.lightingMode === "two-tone" ? 2 : input.lightingMode === "three-tone" ? 3 : 1 },
        uRock0: vec3(rock0),
        uRock1: vec3(rock1),
        uRock2: vec3(rock2),
        uSnow0: vec3(snow0),
        uSnow1: vec3(snow1),
        uSnow2: vec3(snow2),
        uSnowToneMidpoint: input.snowToneAtMidpoint,
        uHasGreen: { int: input.landGreen ? 1 : 0 },
        uGreen: input.landGreen ? vec3(input.landGreen) : [0, 0, 0],
      },
    });
    owned.push(...pass.targets);
    try {
      const rgba = readPassBytes(gl, pass.framebuffer, 0, width, height);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      const layers = new Float32Array(total * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, layers);
      const snowCoverageAlpha = new Uint8Array(total);
      const inkInterior = new Float32Array(total);
      const grassFade = new Float32Array(total);
      for (let index = 0; index < total; index++) {
        snowCoverageAlpha[index] = layers[index * 4];
        inkInterior[index] = layers[index * 4 + 1];
        grassFade[index] = layers[index * 4 + 2];
      }
      return { rgba, snowCoverageAlpha, inkInterior, grassFade };
    } finally {
      gl.deleteFramebuffer(pass.framebuffer);
    }
  });
}

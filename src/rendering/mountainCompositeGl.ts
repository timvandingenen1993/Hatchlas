/**
 * The vegetation layer's final composition on the GPU.
 *
 * renderMountainDetailDEMWithCache blends ~40 full-size layers per pixel
 * (wash, water, ink, mountain illustration, stands, props). On the CPU that
 * loop cost ~550 ns per pixel, far more than uploading the layers, so it runs
 * here as one WebGL2 fragment pass. The layers go up as three texture arrays
 * (bytes, floats, RGBA), integer-typed so every byte reaches the shader
 * exactly. The shader repeats the CPU loop step for step, including each
 * rounding; float32 arithmetic can still land a value on the other side of a
 * rounding edge, so a channel can differ by a level now and then.
 *
 * Like the other passes (vegetationFieldGl.ts) it is synchronous and returns
 * null when the GPU is unavailable or fails, and the caller runs the CPU loop.
 */
import { LINEAR_TO_SRGB, LINEAR_TO_SRGB_STEPS, SRGB_TO_ABSORPTION } from "./forestInkRenderer";
import { program, withField, type FieldGl } from "./vegetationFieldGl";

/** Byte layers, in texture-array order (U8_* in the shader). */
export const COMPOSITE_U8_LAYERS = [
  "biome", "ocean", "river", "waterAlpha", "wetlandPriority", "waterTone", "waveShadow", "waveLight",
  "turbulence", "outlineBank", "flowAlpha", "flowTone", "oceanFlowAlpha", "oceanFlowTone", "crest",
  "washShadow", "flowGuide", "vegetationShadow", "vegetationAlpha", "standCover", "propShadow",
  "standShare", "propCharcoal", "mountainInk",
] as const;
/** Float layers, in texture-array order (F32_* in the shader). */
export const COMPOSITE_F32_LAYERS = [
  "normElev", "hillshade", "ambientOcclusion", "slope", "tpi", "insolation", "siltDepth",
  "contourElevation", "backgroundTone", "backgroundNoise", "backgroundDryness", "siltCrease",
] as const;
/** RGBA layers, in texture-array order (RGBA_* in the shader). */
export const COMPOSITE_RGBA_LAYERS = ["prop", "standWash", "illustration", "material"] as const;

type U8Layer = (typeof COMPOSITE_U8_LAYERS)[number];
type F32Layer = (typeof COMPOSITE_F32_LAYERS)[number];
type RGBALayer = (typeof COMPOSITE_RGBA_LAYERS)[number];
type RGB = readonly [number, number, number];

export interface VegetationCompositeGlInput {
  width: number;
  height: number;
  /** Pixels outside [x0, x1) x [y0, y1) stay zero, as in the CPU loop. */
  window: { x0: number; y0: number; x1: number; y1: number };
  /** Absent layers read as their CPU default (water tone 128, light 0.5, else 0). */
  u8: Partial<Record<U8Layer, Uint8Array | Uint8ClampedArray>>;
  f32: Partial<Record<F32Layer, Float32Array>>;
  rgba: Partial<Record<RGBALayer, Uint8Array | Uint8ClampedArray>>;
  washGrid: { rgba: Uint8Array; width: number; height: number; stride: number; startX: number; startY: number; radiusM: number };
  /** Wash colour per biome id 0..255 (RGB). */
  biomeColors: Float32Array;
  textureOffset: readonly [number, number];
  /** Map width the water marks' grain index runs over (the texture domain width). */
  grainStride: number;
  hillshadeStrength: number;
  aoStrength: number;
  flatShade: number;
  hasTerrainDarkness: boolean;
  waterTerrainShadeStrength: number;
  propTerrainShadeStrength: number;
  hasPropTerrainShade: boolean;
  showWaterDetails: boolean;
  silt: { color: RGB; layers: number };
  wash: { flowStrength: number; darkStrength: number; lightStrength: number; noiseStrength: number };
  dune: { enabled: boolean; colorVariation: number; highlight: number; washShadow: number; spot: RGB };
  contours: {
    show: boolean; interval: number; thickness: number; indexThickness: number; showIndex: boolean;
    indexEvery: number; opacity: number; color: RGB; indexColor: RGB;
  };
  colors: {
    waterShallow: RGB; waterDeep: RGB; waterOutline: RGB; waterFlow: RGB;
    vegetationInk: RGB; aridInk: RGB; propOutline: RGB; flowGuide: RGB;
    meadow: RGB; dry: RGB;
  };
  biomeTransitionStrength: number;
  motifShadowStrength: number;
}

const VERTEX = /* glsl */ `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

const layerConstants = (prefix: string, names: readonly string[]): string =>
  names.map((name, index) => `const int ${prefix}_${name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()} = ${index};`).join("\n");

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2DArray;
precision highp sampler2DArray;
precision highp usampler2D;

uniform highp usampler2DArray uBytes;
uniform highp sampler2DArray uFloats;
uniform highp usampler2DArray uRGBA;
uniform highp usampler2D uWashGrid;
uniform highp sampler2D uBiomeColors;
uniform highp sampler2D uAbsorption;
uniform highp usampler2D uLinearToSrgb;

uniform int uBytePresent;
uniform int uFloatPresent;
uniform int uRGBAPresent;
uniform ivec2 uTextureOffset;
uniform int uGrainStride;
uniform ivec2 uWashSize;
uniform int uWashStride;
uniform ivec2 uWashStart;
uniform float uWashRadius;
uniform float uHillshadeStrength;
uniform float uAoStrength;
uniform float uFlatShade;
uniform int uHasDarkness;
uniform float uWaterShadeStrength;
uniform float uPropShadeStrength;
uniform int uHasPropShade;
uniform int uShowWaterDetails;
uniform vec3 uSiltColor;
uniform int uSiltLayers;
uniform float uFlowStrength;
uniform float uDarkWash;
uniform float uLightWash;
uniform float uWashNoiseStrength;
uniform int uDuneEnabled;
uniform float uDuneColorVariation;
uniform float uDuneHighlight;
uniform float uDuneWashShadow;
uniform vec3 uDuneSpot;
uniform int uShowContours;
uniform float uContourInterval;
uniform float uContourThickness;
uniform float uContourIndexThickness;
uniform int uShowIndexContours;
uniform float uContourIndexEvery;
uniform float uContourOpacity;
uniform vec3 uContourColor;
uniform vec3 uContourIndexColor;
uniform vec3 uWaterShallow;
uniform vec3 uWaterDeep;
uniform vec3 uWaterOutline;
uniform vec3 uWaterFlow;
uniform vec3 uVegetationInk;
uniform vec3 uAridInk;
uniform vec3 uPropOutline;
uniform vec3 uFlowGuide;
uniform vec3 uMeadow;
uniform vec3 uDry;
uniform float uTransitionStrength;
uniform float uMotifShadowStrength;
uniform int uLinearSteps;

layout(location = 0) out vec4 outColor;

${layerConstants("U8", COMPOSITE_U8_LAYERS)}
${layerConstants("F32", COMPOSITE_F32_LAYERS)}
${layerConstants("RGBA", COMPOSITE_RGBA_LAYERS)}

ivec2 pixel;

float jsRound(float value) { return floor(value + 0.5); }
vec3 jsRound3(vec3 value) { return floor(value + 0.5); }
float clamp01(float value) { return clamp(value, 0.0, 1.0); }
float smoothstepJs(float edge0, float edge1, float value) {
  float t = clamp((value - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float byteLayer(int layer, float fallback) {
  if ((uBytePresent & (1 << layer)) == 0) return fallback;
  return float(texelFetch(uBytes, ivec3(pixel, layer), 0).r);
}
float floatLayer(int layer, float fallback) {
  if ((uFloatPresent & (1 << layer)) == 0) return fallback;
  return texelFetch(uFloats, ivec3(pixel, layer), 0).r;
}
bool hasRGBA(int layer) { return (uRGBAPresent & (1 << layer)) != 0; }
vec4 rgbaLayer(int layer) {
  if (!hasRGBA(layer)) return vec4(0.0);
  return vec4(texelFetch(uRGBA, ivec3(pixel, layer), 0));
}

vec3 biomeColor(int biome) { return texelFetch(uBiomeColors, ivec2(biome, 0), 0).rgb; }

vec3 mixRGB(vec3 a, vec3 b, float amount) {
  float t = clamp01(amount);
  return a * (1.0 - t) + b * t;
}
float blendChannel(float base, float contour, float alpha) {
  return jsRound(base * (1.0 - alpha) + contour * alpha);
}
vec3 blend(vec3 base, vec3 contour, float alpha) {
  return vec3(blendChannel(base.r, contour.r, alpha), blendChannel(base.g, contour.g, alpha), blendChannel(base.b, contour.b, alpha));
}

// cartographicStrokeRenderer.hash01
float hashCart(int value, int salt) {
  uint hash = (uint(value) ^ 0x9e3779b9u) * uint(salt) + 0x7f4a7c15u;
  hash = (hash ^ (hash >> 16)) * 0x45d9f3bu;
  hash = (hash ^ (hash >> 13)) * 0x45d9f3bu;
  return float(hash ^ (hash >> 16)) / 4294967296.0;
}

// forestInkRenderer.mixPaintChannel
float mixPaintChannel(float ground, float paint, float amount) {
  int groundIndex = int(clamp(jsRound(ground), 0.0, 255.0));
  if (amount <= 0.0) return float(groundIndex);
  int paintIndex = int(clamp(jsRound(paint), 0.0, 255.0));
  if (amount >= 1.0) return float(paintIndex);
  float ks = texelFetch(uAbsorption, ivec2(groundIndex, 0), 0).r * (1.0 - amount)
    + texelFetch(uAbsorption, ivec2(paintIndex, 0), 0).r * amount;
  float linearValue = 1.0 + ks - sqrt(ks * ks + 2.0 * ks);
  int step = int(jsRound(clamp01(linearValue) * float(uLinearSteps)));
  return float(texelFetch(uLinearToSrgb, ivec2(step % 128, step / 128), 0).r);
}

// riverSilt.riverSiltCoverage / shadeRiverSilt
float siltCoverage(float depth) {
  if (!(depth > 0.0)) return 0.0;
  return smoothstepJs(0.0, 0.35, depth * float(max(1, uSiltLayers)));
}
vec3 shadeRiverSilt(vec3 base, float depth) {
  if (!(depth > 0.0)) return base;
  int passes = max(1, uSiltLayers);
  float position = depth * float(passes);
  int band = min(passes - 1, int(floor(position)));
  float coverage = smoothstepJs(0.0, 0.35, position);
  float tone = 1.0 + ((band % 2) == 0 ? 0.03 : -0.03) - float(band) * 0.015;
  float amount = coverage * 0.9;
  return base + (uSiltColor * tone - base) * amount;
}

// desertDunes.shadeDuneSand
vec3 shadeDuneSand(vec3 sand, float tone, float patchNoise) {
  float toSpot = smoothstepJs(0.0, 0.55, patchNoise) * uDuneColorVariation * 0.7;
  float bleach = smoothstepJs(0.15, 0.7, -patchNoise) * uDuneColorVariation * 0.3;
  vec3 spotted = sand + (uDuneSpot - sand) * toSpot;
  vec3 base = spotted + (255.0 - spotted) * bleach;
  float light = max(0.0, tone - 0.5) * 2.0 * uDuneHighlight * 0.8;
  float shade = max(0.0, 0.5 - tone) * 2.0 * uDuneWashShadow;
  return vec3(
    (base.r + (255.0 - base.r) * light) * (1.0 - shade * 0.4),
    (base.g + (255.0 - base.g) * light) * (1.0 - shade * 0.43),
    (base.b + (255.0 - base.b) * light) * (1.0 - shade * 0.43));
}

// mountainTerrainTint.tintMountainLand
float luminance(vec3 color) { return color.r * 0.299 + color.g * 0.587 + color.b * 0.114; }
float baseGreenAmount(float slopeDeg, float normElev, float tpi) {
  float flatness = 1.0 - smoothstepJs(6.0, 16.0, slopeDeg);
  float ridge = clamp(tpi / 60.0, -1.0, 1.0);
  return (flatness * 0.6 + max(0.0, -ridge) * 0.15) * (1.0 - smoothstepJs(0.55, 0.85, normElev));
}
vec3 tintMountainLand(vec3 base, float slopeDeg, float normElev, float tpi, float insolation, float noise) {
  float baseLum = luminance(base);
  float steep = smoothstepJs(28.0, 45.0, slopeDeg);
  float highness = smoothstepJs(0.5, 1.0, normElev);
  float ridge = clamp(tpi / 60.0, -1.0, 1.0);
  vec3 color = base;
  float greenLum = max(1.0, luminance(uMeadow));
  float greenGain = clamp(baseLum / greenLum, 0.5, 1.6);
  float greenAmount = clamp01(baseGreenAmount(slopeDeg, normElev, tpi) * (1.0 + noise * 0.35));
  color += (uMeadow * greenGain - color) * greenAmount;
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

vec3 waterWash(float shallowness) {
  float t = clamp01(shallowness);
  return jsRound3(uWaterDeep * (1.0 - t) + uWaterShallow * t);
}

// The biome wash field's sample(): (colour, transition).
vec4 washSample(int biome, bool ocean, bool river) {
  vec3 center = biomeColor(biome);
  if (uWashRadius <= 0.0 || biome == 0 || biome == 6 || biome == 8 || ocean || river) return vec4(center, 0.0);
  int globalX = uTextureOffset.x + pixel.x;
  int globalY = uTextureOffset.y + pixel.y;
  int minX = max(0, globalX / uWashStride - uWashStart.x);
  int minY = max(0, globalY / uWashStride - uWashStart.y);
  if (texelFetch(uWashGrid, ivec2(minX, minY), 0).a > 0u) return vec4(center, 0.0);
  float sampleX = clamp(float(globalX) / float(uWashStride) - float(uWashStart.x), 0.0, float(uWashSize.x - 1));
  float sampleY = clamp(float(globalY) / float(uWashStride) - float(uWashStart.y), 0.0, float(uWashSize.y - 1));
  int x0 = int(floor(sampleX));
  int y0 = int(floor(sampleY));
  int x1 = min(uWashSize.x - 1, x0 + 1);
  int y1 = min(uWashSize.y - 1, y0 + 1);
  float tx = sampleX - float(x0);
  float ty = sampleY - float(y0);
  vec3 topLeft = vec3(texelFetch(uWashGrid, ivec2(x0, y0), 0).rgb);
  vec3 topRight = vec3(texelFetch(uWashGrid, ivec2(x1, y0), 0).rgb);
  vec3 bottomLeft = vec3(texelFetch(uWashGrid, ivec2(x0, y1), 0).rgb);
  vec3 bottomRight = vec3(texelFetch(uWashGrid, ivec2(x1, y1), 0).rgb);
  vec3 top = topLeft * (1.0 - tx) + topRight * tx;
  vec3 bottom = bottomLeft * (1.0 - tx) + bottomRight * tx;
  vec3 color = top * (1.0 - ty) + bottom * ty;
  vec3 difference = abs(color - center);
  return vec4(color, min(1.0, max(difference.r, max(difference.g, difference.b)) / 36.0));
}

void main() {
  pixel = ivec2(gl_FragCoord.xy);
  // The water marks' charcoal tooth follows map coordinates (see the CPU loop).
  int index = (uTextureOffset.y + pixel.y) * uGrainStride + uTextureOffset.x + pixel.x;

  vec4 prop = rgbaLayer(RGBA_PROP);
  float propCharcoal = byteLayer(U8_PROP_CHARCOAL, 0.0) / 255.0;
  float rasterPropCoverage = max(prop.a / 255.0, propCharcoal);
  float normElev = floatLayer(F32_NORM_ELEV, 0.0);
  float effectiveShade = 1.0 - uHillshadeStrength * (1.0 - floatLayer(F32_HILLSHADE, 0.0)
    * (1.0 - uAoStrength + uAoStrength * floatLayer(F32_AMBIENT_OCCLUSION, 0.0)));
  float terrainDarkness = uHasDarkness == 1
    ? clamp01((uFlatShade - effectiveShade) / max(0.01, uFlatShade))
    : 0.0;
  int biome = int(byteLayer(U8_BIOME, 0.0));
  bool ocean = byteLayer(U8_OCEAN, 0.0) > 0.0;
  bool river = byteLayer(U8_RIVER, 0.0) > 0.0;
  bool dune = uDuneEnabled == 1 && biome == 15;
  float siltDepth = floatLayer(F32_SILT_DEPTH, 0.0);

  // The vegetation wash.
  vec4 wetSample = washSample(biome, ocean, river);
  float dryAmount = biome == 7 ? floatLayer(F32_BACKGROUND_DRYNESS, 0.0) : 0.0;
  vec3 c = shadeRiverSilt(mixRGB(wetSample.rgb, uDry, dryAmount), siltDepth);
  float flowTone = floatLayer(F32_BACKGROUND_TONE, 0.5);
  float washNoise = floatLayer(F32_BACKGROUND_NOISE, 0.0);
  vec3 outer = vec3(c.r * (1.0 - uDarkWash), c.g * (1.0 - uDarkWash * 0.73), c.b * (1.0 - uDarkWash * 1.27));
  vec3 middle = vec3(c.r * (1.0 - uDarkWash * 0.14), c.g * (1.0 - uDarkWash * 0.09), c.b * (1.0 - uDarkWash * 0.36));
  vec3 centre = vec3(min(255.0, c.r * (1.0 + uLightWash)), min(255.0, c.g * (1.0 + uLightWash * 0.83)), min(255.0, c.b * (1.0 + uLightWash * 0.33)));
  float baseFlowPosition = clamp01(0.5 + (flowTone - 0.5) * uFlowStrength * 2.0);
  float flowPosition = clamp01(baseFlowPosition + washNoise * uWashNoiseStrength * 0.26);
  vec3 washColor = dune
    ? shadeDuneSand(c, flowTone, washNoise)
    : flowPosition < 0.5
      ? mixRGB(outer, middle, flowPosition * 2.0)
      : mixRGB(middle, centre, (flowPosition - 0.5) * 2.0);
  float washShade = 0.55 + 0.45 * effectiveShade;
  bool tintBiome = (biome >= 1 && biome <= 5) || biome == 20;
  vec3 tinted = tintBiome
    ? tintMountainLand(washColor, floatLayer(F32_SLOPE, 0.0), normElev, floatLayer(F32_TPI, 0.0),
        floatLayer(F32_INSOLATION, 0.5), washNoise)
    : washColor;
  vec3 rgb = clamp(jsRound3(tinted * washShade), 0.0, 255.0);
  vec3 transitionRGB = vec3(0.0);
  float transitionStrength = 0.0;
  if (wetSample.a > 0.0 && hasRGBA(RGBA_ILLUSTRATION)) {
    transitionRGB = rgb;
    transitionStrength = jsRound(wetSample.a * 255.0);
  }

  float washShadowAlpha = dune ? 0.0 : byteLayer(U8_WASH_SHADOW, 0.0) / 255.0;
  if (washShadowAlpha > 0.0) rgb = jsRound3(rgb * (1.0 - washShadowAlpha * 0.52));

  // Water wash.
  float waterAlphaByte = byteLayer(U8_WATER_ALPHA, 0.0);
  float wetlandPriority = byteLayer(U8_WETLAND_PRIORITY, 0.0);
  bool hasWaterWash = waterAlphaByte > 0.0 || wetlandPriority > 0.0;
  // The ground under forest stands is the map before its water wash: a
  // crown rising over the water hides it as it hides the ground. Stand areas
  // already keep off the painted water.
  vec3 ground = rgb;
  if (hasWaterWash) {
    float waterAlpha = max(waterAlphaByte, wetlandPriority) / 255.0;
    vec3 water = jsRound3(waterWash(byteLayer(U8_WATER_TONE, 128.0) / 255.0)
      * (1.0 - uWaterShadeStrength * terrainDarkness));
    float waveShadow = uShowWaterDetails == 1 ? byteLayer(U8_WAVE_SHADOW, 0.0) / 255.0 : 0.0;
    if (waveShadow > 0.0) {
      vec3 shadow = jsRound3(waterWash(0.0) * 0.72);
      float amount = min(0.76, waveShadow * 0.82);
      water = jsRound3(water * (1.0 - amount) + shadow * amount);
    }
    float waveLight = uShowWaterDetails == 1 ? byteLayer(U8_WAVE_LIGHT, 0.0) / 255.0 : 0.0;
    if (waveLight > 0.0) {
      vec3 face = mixRGB(waterWash(0.0), waterWash(1.0), 0.82);
      float amount = min(0.62, waveLight * 0.64);
      water = jsRound3(water * (1.0 - amount) + face * amount);
    }
    float turbulence = uShowWaterDetails == 1 ? byteLayer(U8_TURBULENCE, 0.0) / 255.0 : 0.0;
    if (turbulence > 0.0) water = jsRound3(water * (1.0 - turbulence));
    rgb = waterAlpha < 1.0 ? jsRound3(rgb * (1.0 - waterAlpha) + water * waterAlpha) : water;
  }

  float standCover = byteLayer(U8_STAND_COVER, 0.0) / 255.0;

  if (!hasWaterWash && uShowContours == 1 && uContourOpacity > 0.0) {
    float elevation = floatLayer(F32_CONTOUR_ELEVATION, 0.0);
    float modValue = elevation - uContourInterval * floor(elevation / uContourInterval);
    float distanceToContour = min(modValue, uContourInterval - modValue);
    float indexInterval = uContourInterval * uContourIndexEvery;
    float indexMod = elevation - indexInterval * floor(elevation / indexInterval);
    float distanceToIndex = min(indexMod, indexInterval - indexMod);
    if (uShowIndexContours == 1 && distanceToIndex <= uContourIndexThickness) {
      rgb = blend(rgb, uContourIndexColor, uContourOpacity * 0.55);
    } else if (distanceToContour <= uContourThickness) {
      rgb = blend(rgb, uContourColor, uContourOpacity * 0.30);
    }
  }

  float siltCover = siltCoverage(siltDepth);
  float crease = floatLayer(F32_SILT_CREASE, 0.0);
  if (siltCover > 0.0 && crease > 0.0) rgb = blend(rgb, uVegetationInk, crease);
  float siltClip = 1.0 - siltCover;

  float guideAlpha = byteLayer(U8_FLOW_GUIDE, 0.0) / 255.0 * siltClip;
  if (guideAlpha > 0.0) rgb = blend(rgb, uFlowGuide, guideAlpha * 0.78);

  vec3 flowInk = (biome == 15 || biome == 16) ? uAridInk : uVegetationInk;
  float shadowAlpha = dune ? 0.0 : byteLayer(U8_VEGETATION_SHADOW, 0.0) / 255.0 * siltClip;
  if (shadowAlpha > 0.0) rgb = blend(rgb, max(vec3(0.0), jsRound3(flowInk * 0.62)), shadowAlpha);
  float vegetationAlpha = byteLayer(U8_VEGETATION_ALPHA, 0.0) / 255.0 * siltClip;
  if (vegetationAlpha > 0.0) rgb = blend(rgb, flowInk, vegetationAlpha);

  // Water details (a water overlay is always present on this path).
  if (uShowWaterDetails == 1) {
    float outlineBank = byteLayer(U8_OUTLINE_BANK, 0.0) / 255.0 * (1.0 - rasterPropCoverage);
    if (outlineBank > 0.0) rgb = blend(rgb, uWaterOutline, outlineBank);
    float charcoalFlow = byteLayer(U8_FLOW_ALPHA, 0.0) / 255.0 * (1.0 - rasterPropCoverage);
    float oceanWave = byteLayer(U8_OCEAN_FLOW_ALPHA, 0.0) / 255.0 * (1.0 - rasterPropCoverage);
    if (charcoalFlow > 0.0) {
      float tone = byteLayer(U8_FLOW_TONE, 0.0) / 255.0;
      float tooth = 0.85 + 0.30 * hashCart(index, 991);
      vec3 flowColor = min(vec3(255.0), jsRound3(uWaterFlow + tone * vec3(18.0, 16.0, 14.0)));
      rgb = blend(rgb, flowColor, min(1.0, charcoalFlow * tooth));
    }
    if (oceanWave > 0.0) {
      float waveTone = byteLayer(U8_OCEAN_FLOW_TONE, 0.0) / 255.0;
      float tooth = 0.85 + 0.30 * hashCart(index, 991);
      vec3 waveColor = mixRGB(uWaterDeep, uWaterShallow, 0.18 + waveTone * 0.28);
      rgb = blend(rgb, jsRound3(waveColor), min(1.0, oceanWave * tooth));
    }
    float foam = byteLayer(U8_CREST, 0.0) / 255.0 * (1.0 - rasterPropCoverage);
    if (foam > 0.0) {
      vec3 foamColor = mixRGB(uWaterShallow, vec3(246.0, 242.0, 224.0), 0.78);
      rgb = blend(rgb, jsRound3(foamColor), min(0.9, foam));
    }
  }

  // Mountain illustration, its material under stands, and the biome transition.
  float illustrationAlpha = 0.0;
  vec4 illustration = rgbaLayer(RGBA_ILLUSTRATION);
  if (hasRGBA(RGBA_ILLUSTRATION)) {
    illustrationAlpha = illustration.a / 255.0;
    rgb = blend(rgb, illustration.rgb, illustrationAlpha);
  }
  float materialAlpha = max(0.0, illustrationAlpha - byteLayer(U8_MOUNTAIN_INK, 0.0) / 255.0);
  if (standCover > 0.0 && hasRGBA(RGBA_MATERIAL)) {
    vec4 material = rgbaLayer(RGBA_MATERIAL);
    float alpha = material.a / 255.0;
    if (alpha > 0.0) ground = blend(ground, material.rgb, alpha);
  } else if (standCover > 0.0 && materialAlpha > 0.0) {
    ground = blend(ground, illustration.rgb, materialAlpha);
  }
  if (materialAlpha > 0.0 && hasRGBA(RGBA_ILLUSTRATION)) {
    float transitionAlpha = transitionStrength / 255.0 * materialAlpha * min(1.0, 0.72 * uTransitionStrength);
    if (transitionAlpha > 0.0) {
      rgb = blend(rgb, transitionRGB, transitionAlpha);
      ground = blend(ground, transitionRGB, transitionAlpha);
    }
  }
  if (standCover > 0.0) rgb = blend(rgb, ground, standCover);
  vec4 standWash = rgbaLayer(RGBA_STAND_WASH);
  float standWashAmount = standWash.a / 255.0;
  if (standWashAmount > 0.0) {
    rgb = vec3(
      mixPaintChannel(rgb.r, standWash.r, standWashAmount),
      mixPaintChannel(rgb.g, standWash.g, standWashAmount),
      mixPaintChannel(rgb.b, standWash.b, standWashAmount));
  }

  // Props on top.
  float propShadow = byteLayer(U8_PROP_SHADOW, 0.0) / 255.0 * uMotifShadowStrength;
  if (propShadow > 0.0) rgb = blend(rgb, max(vec3(0.0), jsRound3(uVegetationInk * 0.62)), propShadow);
  float standShare = byteLayer(U8_STAND_SHARE, 0.0) / 255.0;
  float propAlpha = prop.a / 255.0;
  if (propAlpha > 0.0) {
    float propTerrainShade = uHasPropShade == 1 ? 1.0 - uPropShadeStrength * terrainDarkness : 1.0;
    float propShade = 1.0 - (1.0 - propTerrainShade) * (1.0 - standShare);
    rgb = blend(rgb, prop.rgb * propShade, propAlpha);
  }
  if (propCharcoal > 0.0) rgb = blend(rgb, uPropOutline, propCharcoal);

  outColor = vec4(clamp(rgb, 0.0, 255.0) / 255.0, 1.0);
}
`;

interface CompositeTextures {
  gl: WebGL2RenderingContext;
  width: number;
  height: number;
  bytes: WebGLTexture;
  floats: WebGLTexture;
  rgba: WebGLTexture;
  target: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  absorption: WebGLTexture;
  linearToSrgb: WebGLTexture;
}

/** Arrays and render target kept between renders of the same size. */
let cached: CompositeTextures | null = null;
/**
 * Frames up to about preview size keep their arrays for the next render.
 * Larger ones (export tiles, ~300 MB of GPU memory at 8K) release them after
 * each composition: the GPU process memory counts against the same RAM the
 * export's helpers need, and the next tile rarely has the same size.
 */
const CACHED_FRAME_PIXELS = 2_600_000;
/** Set when the pass failed once; this worker then stays on the CPU loop. */
let disabled = false;

function plainTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const created = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, created);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return created;
}

function arrayTexture(gl: WebGL2RenderingContext, format: number, width: number, height: number, layers: number): WebGLTexture {
  const created = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, created);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, format, width, height, layers);
  return created;
}

function releaseTextures(textures: CompositeTextures): void {
  const { gl } = textures;
  if (gl.isContextLost()) return;
  for (const texture of [textures.bytes, textures.floats, textures.rgba, textures.target, textures.absorption, textures.linearToSrgb]) {
    gl.deleteTexture(texture);
  }
  gl.deleteFramebuffer(textures.framebuffer);
}

function texturesFor(field: FieldGl, width: number, height: number): CompositeTextures {
  const { gl } = field;
  if (cached && cached.gl === gl && cached.width === width && cached.height === height) return cached;
  if (cached) releaseTextures(cached);
  const bytes = arrayTexture(gl, gl.R8UI, width, height, COMPOSITE_U8_LAYERS.length);
  const floats = arrayTexture(gl, gl.R32F, width, height, COMPOSITE_F32_LAYERS.length);
  const rgba = arrayTexture(gl, gl.RGBA8UI, width, height, COMPOSITE_RGBA_LAYERS.length);
  const target = plainTexture(gl);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("Composite framebuffer incomplete");
  }
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const absorption = plainTexture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, 1, 0, gl.RED, gl.FLOAT, SRGB_TO_ABSORPTION);
  // 8192 entries as 128 x 64: WebGL2 only guarantees 2048-texel rows.
  const linearRows = Math.ceil((LINEAR_TO_SRGB_STEPS + 1) / 128);
  const linearData = new Uint8Array(128 * linearRows);
  linearData.set(LINEAR_TO_SRGB);
  const linearToSrgb = plainTexture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 128, linearRows, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, linearData);
  cached = { gl, width, height, bytes, floats, rgba, target, framebuffer, absorption, linearToSrgb };
  return cached;
}

function setUniform(gl: WebGL2RenderingContext, linked: WebGLProgram, name: string, value: number | boolean | readonly number[], integer = false): void {
  const location = gl.getUniformLocation(linked, name);
  if (!location) return;
  if (typeof value === "boolean") gl.uniform1i(location, value ? 1 : 0);
  else if (typeof value === "number") {
    if (integer) gl.uniform1i(location, value);
    else gl.uniform1f(location, value);
  } else if (integer) gl.uniform2i(location, value[0], value[1]);
  else if (value.length === 3) gl.uniform3f(location, value[0], value[1], value[2]);
  else gl.uniform2f(location, value[0], value[1]);
}

/** Uploads the present layers of one array; returns the presence bit mask. */
function uploadLayers(
  gl: WebGL2RenderingContext,
  target: WebGLTexture,
  names: readonly string[],
  layers: Partial<Record<string, ArrayBufferView>>,
  width: number,
  height: number,
  format: number,
  type: number,
  components: number,
): number {
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, target);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  let present = 0;
  names.forEach((name, layer) => {
    const data = layers[name];
    if (!data) return;
    if ((data as unknown as ArrayLike<number>).length !== width * height * components) {
      throw new Error(`Composite layer ${name} has the wrong size`);
    }
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, width, height, 1, format, type, data);
    present |= 1 << layer;
  });
  return present;
}

/** Frees the arrays kept for the next composition (the export frees the preview's). */
export function releaseCompositeTextures(): void {
  if (cached) releaseTextures(cached);
  cached = null;
}

/**
 * The composed RGBA image (alpha 255 inside the window, zero outside), or
 * null to run the CPU loop.
 */
export function composeVegetationLayerGl(input: VegetationCompositeGlInput): Uint8ClampedArray<ArrayBuffer> | null {
  if (disabled) return null;
  return withField(input.width, input.height, (field) => {
    try {
      return compose(field, input);
    } catch (error) {
      console.warn("GPU composition fell back to the CPU", error);
      disabled = true;
      return null;
    }
  });
}

function compose(field: FieldGl, input: VegetationCompositeGlInput): Uint8ClampedArray<ArrayBuffer> {
  const { gl } = field;
  const { width, height } = input;
  const textures = texturesFor(field, width, height);
  const bytePresent = uploadLayers(gl, textures.bytes, COMPOSITE_U8_LAYERS, input.u8, width, height, gl.RED_INTEGER, gl.UNSIGNED_BYTE, 1);
  const floatPresent = uploadLayers(gl, textures.floats, COMPOSITE_F32_LAYERS, input.f32, width, height, gl.RED, gl.FLOAT, 1);
  const rgbaPresent = uploadLayers(gl, textures.rgba, COMPOSITE_RGBA_LAYERS, input.rgba, width, height, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, 4);

  const grid = input.washGrid;
  const washGrid = plainTexture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, grid.width, grid.height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, grid.rgba);
  const biomeColors = plainTexture(gl);
  const biomeRGBA = new Float32Array(256 * 4);
  for (let biome = 0; biome < 256; biome++) {
    biomeRGBA.set(input.biomeColors.subarray(biome * 3, biome * 3 + 3), biome * 4);
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 1, 0, gl.RGBA, gl.FLOAT, biomeRGBA);

  try {
    const linked = program(field, "vegetation composite", FRAGMENT, VERTEX);
    gl.useProgram(linked);
    gl.bindFramebuffer(gl.FRAMEBUFFER, textures.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    const samplers: Array<[string, number, WebGLTexture]> = [
      ["uBytes", gl.TEXTURE_2D_ARRAY, textures.bytes],
      ["uFloats", gl.TEXTURE_2D_ARRAY, textures.floats],
      ["uRGBA", gl.TEXTURE_2D_ARRAY, textures.rgba],
      ["uWashGrid", gl.TEXTURE_2D, washGrid],
      ["uBiomeColors", gl.TEXTURE_2D, biomeColors],
      ["uAbsorption", gl.TEXTURE_2D, textures.absorption],
      ["uLinearToSrgb", gl.TEXTURE_2D, textures.linearToSrgb],
    ];
    samplers.forEach(([name, target, bound], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, bound);
      setUniform(gl, linked, name, unit, true);
    });
    const set = (name: string, value: number | boolean | readonly number[], integer = false) =>
      setUniform(gl, linked, name, value, integer);
    set("uBytePresent", bytePresent, true);
    set("uFloatPresent", floatPresent, true);
    set("uRGBAPresent", rgbaPresent, true);
    set("uTextureOffset", input.textureOffset, true);
    set("uGrainStride", input.grainStride, true);
    set("uWashSize", [grid.width, grid.height], true);
    set("uWashStride", grid.stride, true);
    set("uWashStart", [grid.startX, grid.startY], true);
    set("uWashRadius", grid.radiusM);
    set("uHillshadeStrength", input.hillshadeStrength);
    set("uAoStrength", input.aoStrength);
    set("uFlatShade", input.flatShade);
    set("uHasDarkness", input.hasTerrainDarkness);
    set("uWaterShadeStrength", input.waterTerrainShadeStrength);
    set("uPropShadeStrength", input.propTerrainShadeStrength);
    set("uHasPropShade", input.hasPropTerrainShade);
    set("uShowWaterDetails", input.showWaterDetails);
    set("uSiltColor", input.silt.color);
    set("uSiltLayers", Math.round(input.silt.layers), true);
    set("uFlowStrength", input.wash.flowStrength);
    set("uDarkWash", input.wash.darkStrength);
    set("uLightWash", input.wash.lightStrength);
    set("uWashNoiseStrength", input.wash.noiseStrength);
    set("uDuneEnabled", input.dune.enabled);
    set("uDuneColorVariation", input.dune.colorVariation);
    set("uDuneHighlight", input.dune.highlight);
    set("uDuneWashShadow", input.dune.washShadow);
    set("uDuneSpot", input.dune.spot);
    set("uShowContours", input.contours.show);
    set("uContourInterval", input.contours.interval);
    set("uContourThickness", input.contours.thickness);
    set("uContourIndexThickness", input.contours.indexThickness);
    set("uShowIndexContours", input.contours.showIndex);
    set("uContourIndexEvery", input.contours.indexEvery);
    set("uContourOpacity", input.contours.opacity);
    set("uContourColor", input.contours.color);
    set("uContourIndexColor", input.contours.indexColor);
    set("uWaterShallow", input.colors.waterShallow);
    set("uWaterDeep", input.colors.waterDeep);
    set("uWaterOutline", input.colors.waterOutline);
    set("uWaterFlow", input.colors.waterFlow);
    set("uVegetationInk", input.colors.vegetationInk);
    set("uAridInk", input.colors.aridInk);
    set("uPropOutline", input.colors.propOutline);
    set("uFlowGuide", input.colors.flowGuide);
    set("uMeadow", input.colors.meadow);
    set("uDry", input.colors.dry);
    set("uTransitionStrength", input.biomeTransitionStrength);
    set("uMotifShadowStrength", input.motifShadowStrength);
    set("uLinearSteps", LINEAR_TO_SRGB_STEPS, true);
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const { x0, y0, x1, y1 } = input.window;
    const pixels = new Uint8ClampedArray(width * height * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    if (x0 === 0 && y0 === 0 && x1 === width && y1 === height) {
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    } else if (x1 > x0 && y1 > y0) {
      // Framebuffer row y is image row y, so the window reads in place.
      const windowWidth = x1 - x0;
      const rows = new Uint8ClampedArray(windowWidth * (y1 - y0) * 4);
      gl.readPixels(x0, y0, windowWidth, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, rows);
      for (let row = 0; row < y1 - y0; row++) {
        pixels.set(rows.subarray(row * windowWidth * 4, (row + 1) * windowWidth * 4), ((y0 + row) * width + x0) * 4);
      }
    }
    if (gl.isContextLost()) throw new Error("GPU context lost during composition");
    return pixels;
  } finally {
    gl.deleteTexture(washGrid);
    gl.deleteTexture(biomeColors);
    if (width * height > CACHED_FRAME_PIXELS && cached === textures) {
      releaseTextures(textures);
      cached = null;
    }
  }
}

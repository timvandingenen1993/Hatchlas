/**
 * Deep-ocean wave paths painted on the GPU.
 *
 * Each wave path is hundreds of short segments, and every segment shades a
 * band up to ~120 output pixels wide with two value noises per pixel: about
 * 1 s of every coastal 8K export tile on the CPU. Here every segment is one
 * instanced quad around its band; the fragment shader repeats the CPU
 * painter's pixel tests and values (paintOceanWaveSegments in
 * waterRenderer.ts), and MAX blending reproduces its max-compositing, which
 * does not depend on drawing order. Returns null when the GPU is unavailable.
 */
import {
  COMMON,
  program,
  readPassBytes,
  texture,
  withField,
} from "./vegetationFieldGl";

/** Per-segment floats: see OceanWaveGlSegments. */
export const OCEAN_WAVE_SEGMENT_FLOATS = 20;

/**
 * Segments to paint, OCEAN_WAVE_SEGMENT_FLOATS floats each:
 * a.x, a.y, a.along, a.nx, a.ny, b.x, b.y, b.along, b.nx, b.ny,
 * path start along, path end along, minX, minY, maxX, maxY,
 * limit, shading fade length, flags (1 shading, 2 marks), reach;
 * plus one path seed each.
 */
export interface OceanWaveGlSegments {
  floats: Float32Array;
  seeds: Int32Array;
  count: number;
}

export interface OceanWaveGlInput {
  width: number;
  height: number;
  oceanClip: Uint8Array;
  segments: OceanWaveGlSegments;
  markScale: number;
  waveThickness: number;
  shadingIntensity: number;
  softScale: number;
  ridgeWidth: number;
  inkWidth: number;
  shadowBase: number;
  lightBase: number;
  bandScale: number;
  marksReach: number;
  offsetX: number;
  offsetY: number;
}

/** Bytes per pixel: (shadow, light, ridge alpha, ridge tone) and (ink, foam, -, -). */
export interface OceanWaveGlResult {
  bands: Uint8ClampedArray<ArrayBuffer>;
  marks: Uint8ClampedArray<ArrayBuffer>;
}

const SEGMENT_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aSegmentA;
layout(location = 1) in vec4 aSegmentB;
layout(location = 2) in vec4 aSegmentC;
layout(location = 3) in vec4 aRect;
layout(location = 4) in vec4 aPass;
layout(location = 5) in int aSeed;
uniform vec2 uViewport;
uniform float uMarkScale;
flat out vec4 vA;
flat out vec4 vB;
flat out vec4 vC;
flat out vec4 vRect;
flat out vec4 vPass;
flat out int vSeed;

void main() {
  vA = aSegmentA;
  vB = aSegmentB;
  vC = aSegmentC;
  vRect = aRect;
  vPass = aPass;
  vSeed = aSeed;
  vec2 a = aSegmentA.xy;
  vec2 b = vec2(aSegmentB.y, aSegmentB.z);
  vec2 d = b - a;
  float len = length(d);
  vec2 u = d / len;
  vec2 n = vec2(-u.y, u.x);
  // Painted pixels project within a markScale of the segment and lie in the
  // reach rectangle, so their distance from its line is below this.
  float across = aPass.w * 1.4143 + len * 0.5 + 1.0;
  float along = gl_VertexID % 2 == 0 ? -uMarkScale - 1.0 : len + uMarkScale + 1.0;
  float side = gl_VertexID < 2 ? -across : across;
  vec2 point = a + u * along + n * side;
  // CPU pixel (x, y) is the window pixel whose centre is (x + 0.5, y + 0.5).
  gl_Position = vec4((point + 0.5) / uViewport * 2.0 - 1.0, 0.0, 1.0);
}
`;

const SEGMENT_FRAGMENT = /* glsl */ `${COMMON}
uniform highp usampler2D uOceanClip;
uniform float uMarkScale;
uniform float uWaveThickness;
uniform float uShadingIntensity;
uniform float uSoftScale;
uniform float uRidgeWidth;
uniform float uInkWidth;
uniform float uShadowBase;
uniform float uLightBase;
uniform float uBandScale;
uniform float uMarksReach;
uniform ivec2 uWorldOffset;
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
flat in vec4 vRect;
flat in vec4 vPass;
flat in int vSeed;
layout(location = 0) out vec4 outBands;
layout(location = 1) out vec4 outMarks;

// smoothstep in waterRenderer.ts.
float waveStep(float edge0, float edge1, float value) {
  float t = clamp01((value - edge0) / max(1e-6, edge1 - edge0));
  return t * t * (3.0 - 2.0 * t);
}

// sampleSmoothWaveNoise: seed + lattice * 374761393 wraps like the CPU's ToInt32.
float smoothWaveNoise(int seed, float coordinate) {
  float lattice = floor(coordinate);
  float t = waveStep(0.0, 1.0, coordinate - lattice);
  int cell = int(lattice);
  float a = hash01(uint(seed) + uint(cell) * 374761393u, 6689) * 2.0 - 1.0;
  float b = hash01(uint(seed) + uint(cell + 1) * 374761393u, 6689) * 2.0 - 1.0;
  return a + (b - a) * t;
}

// sampleWetlandValueNoise.
float valueNoise(float x, float y, int seed, int salt) {
  float fx = floor(x);
  float fy = floor(y);
  float tx = x - fx;
  float ty = y - fy;
  float sx = tx * tx * (3.0 - 2.0 * tx);
  float sy = ty * ty * (3.0 - 2.0 * ty);
  int x0 = int(fx);
  int y0 = int(fy);
  uint s = uint(seed);
  float c00 = hash01((uint(x0) * 374761393u) ^ (uint(y0) * 668265263u) ^ s, salt);
  float c10 = hash01((uint(x0 + 1) * 374761393u) ^ (uint(y0) * 668265263u) ^ s, salt);
  float c01 = hash01((uint(x0) * 374761393u) ^ (uint(y0 + 1) * 668265263u) ^ s, salt);
  float c11 = hash01((uint(x0 + 1) * 374761393u) ^ (uint(y0 + 1) * 668265263u) ^ s, salt);
  float north = c00 * (1.0 - sx) + c10 * sx;
  float south = c01 * (1.0 - sx) + c11 * sx;
  return north * (1.0 - sy) + south * sy;
}

float foamCoverage(int seed, float along) {
  float clusters = smoothWaveNoise(seed + 991, along / (9.0 * uMarkScale));
  float fragments = smoothWaveNoise(seed + 1297, along / (2.4 * uMarkScale));
  return waveStep(0.12, 0.55, clusters) * (0.48 + 0.52 * waveStep(-0.4, 0.4, fragments));
}

float inkCoverage(int seed, float along) {
  float interruptions = smoothWaveNoise(seed + 2857, along / (16.0 * uMarkScale));
  float textureNoise = smoothWaveNoise(seed + 2903, along / (3.8 * uMarkScale));
  return waveStep(-0.45, 0.2, interruptions) * (0.5 + 0.5 * waveStep(-0.35, 0.45, textureNoise));
}

float toByte(float value) { return floor(clamp01(value) * 255.0 + 0.5); }

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  float x = float(pixel.x);
  float y = float(pixel.y);
  if (x < vRect.x || y < vRect.y || x > vRect.z || y > vRect.w) discard;
  vec2 a = vA.xy;
  float alongA = vA.z;
  vec2 normalA = vec2(vA.w, vB.x);
  vec2 b = vB.yz;
  float alongB = vB.w;
  vec2 normalB = vC.xy;
  float pathStart = vC.z;
  float pathEnd = vC.w;
  float limit = vPass.x;
  float shadingFadeLength = vPass.y;
  int flags = int(vPass.z);
  bool shading = (flags & 1) != 0;
  bool marks = (flags & 2) != 0;
  float dx = b.x - a.x;
  float dy = b.y - a.y;
  float lengthSquared = dx * dx + dy * dy;
  float segmentLength = sqrt(lengthSquared);
  vec2 segmentNormal = vec2(-dy, dx) / segmentLength;
  float capProjection = uMarkScale * segmentLength;
  // The CPU's scanline cap clip, rounded outward the same way.
  float rowProjection = (y - a.y) * dy;
  if (dx != 0.0) {
    float capStart = a.x + (-capProjection - rowProjection) / dx;
    float capEnd = a.x + (lengthSquared + capProjection - rowProjection) / dx;
    if (x < max(vRect.x, floor(min(capStart, capEnd))) || x > min(vRect.z, ceil(max(capStart, capEnd)))) discard;
  } else if (rowProjection < -capProjection || rowProjection > lengthSquared + capProjection) {
    discard;
  }
  if (texelFetch(uOceanClip, pixel, 0).r == 0u) discard;
  float rawT = ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared;
  float t = clamp01(rawT);
  if (abs(rawT - t) * segmentLength > uMarkScale) discard;
  vec2 center = a + vec2(dx, dy) * t;
  vec2 rawNormal = normalA + (normalB - normalA) * t;
  float normalLength = length(rawNormal);
  vec2 normal = rawNormal / (normalLength > 0.0 ? normalLength : 1.0);
  float alignment = dot(normal, segmentNormal);
  float correction = 1.0 - waveStep(0.2, 0.5, abs(alignment));
  if (correction > 0.0) {
    float side = alignment < 0.0 ? -1.0 : 1.0;
    vec2 corrected = normal + (side * segmentNormal - normal) * correction;
    float correctedLength = length(corrected);
    normal = corrected / (correctedLength > 0.0 ? correctedLength : 1.0);
  }
  float across = dot(vec2(x, y) - center, normal);
  float acrossMagnitude = abs(across);
  if (acrossMagnitude >= limit) discard;
  float along = alongA + (alongB - alongA) * t;
  float endpointDistance = min(along - pathStart, pathEnd - along);
  float endpointFade = waveStep(0.0, 3.5 * uMarkScale, endpointDistance);
  vec4 bands = vec4(0.0);
  vec4 markBytes = vec4(0.0);
  if (shading && endpointDistance > 0.0 && uShadingIntensity > 0.0) {
    float shadingEndpointFade = waveStep(0.0, shadingFadeLength, endpointDistance);
    float broad = smoothWaveNoise(vSeed + 1601, along / (11.0 * uMarkScale));
    vec2 tangent = vec2(normal.y, -normal.x);
    float globalX = x + float(uWorldOffset.x);
    float globalY = y + float(uWorldOffset.y);
    float noiseAlong = (globalX * tangent.x + globalY * tangent.y) / (25.0 * uMarkScale);
    float noiseAcross = (globalX * normal.x + globalY * normal.y) / (16.0 * uMarkScale);
    float broadTexture = (valueNoise(noiseAlong, noiseAcross, vSeed + 1877, 547) - 0.5) * 2.0;
    float fineTexture = (valueNoise(noiseAlong * 3.0, noiseAcross * 2.8, vSeed + 1999, 557) - 0.5) * 2.0;
    float turbulence = broadTexture * 0.68 + fineTexture * 0.32;
    float turbulentAcross = across + turbulence * 1.15 * uMarkScale * uBandScale;
    float shadowTexture = clamp01(0.58 + broadTexture * 0.45 + fineTexture * 0.2);
    float lightTexture = clamp01(0.58 - broadTexture * 0.42 - fineTexture * 0.15);
    float shadingStrength = (0.78 + 0.22 * (broad + 1.0) * 0.5) * shadingEndpointFade * uSoftScale;
    float shadowWidth = uShadowBase * uBandScale
      + ((0.5 + 0.5 * broad) * 2.3 + turbulence * 1.0) * uMarkScale * uBandScale;
    float lightWidth = uLightBase * uBandScale
      + ((0.5 + 0.5 * broad) * 1.8 + turbulence * 0.9) * uMarkScale * uBandScale;
    float ridgeGap = 0.24 * uMarkScale;
    if (turbulentAcross > ridgeGap && turbulentAcross < shadowWidth) {
      float shadowCenter = shadowWidth * 0.52;
      float shadowSigma = max(0.8 * uMarkScale, shadowWidth * 0.27);
      float startFade = waveStep(ridgeGap, ridgeGap + 0.75 * uMarkScale, turbulentAcross);
      float outerFade = 1.0 - waveStep(shadowWidth * 0.56, shadowWidth, turbulentAcross);
      float z = (turbulentAcross - shadowCenter) / shadowSigma;
      float coverage = shadingStrength * startFade * outerFade * exp(-0.5 * z * z)
        * (0.28 + 0.1 * (broad + 1.0) * 0.5) * shadowTexture * uShadingIntensity;
      bands.x = toByte(coverage);
    }
    if (turbulentAcross < -ridgeGap && turbulentAcross > -lightWidth) {
      float shoreward = -turbulentAcross;
      float lightCenter = lightWidth * 0.5;
      float lightSigma = max(0.8 * uMarkScale, lightWidth * 0.29);
      float startFade = waveStep(ridgeGap, ridgeGap + 0.75 * uMarkScale, shoreward);
      float outerFade = 1.0 - waveStep(lightWidth * 0.56, lightWidth, shoreward);
      float z = (shoreward - lightCenter) / lightSigma;
      float coverage = shadingStrength * startFade * outerFade * exp(-0.5 * z * z)
        * (0.27 + 0.1 * (broad + 1.0) * 0.5) * lightTexture * uShadingIntensity;
      bands.y = toByte(coverage);
    }
  }
  if (marks && acrossMagnitude < uMarksReach) {
    float ripple = smoothWaveNoise(vSeed + 2017, along / (2.8 * uMarkScale));
    float ridgeEdge = 1.0 - waveStep(uRidgeWidth * 0.45, uRidgeWidth, acrossMagnitude);
    float ridge = ridgeEdge * endpointFade * (0.18 + 0.08 * (ripple + 1.0) * 0.5);
    if (ridge > 0.01) {
      bands.z = floor(ridge * 255.0 + 0.5);
      bands.w = floor(82.0 + 38.0 * (ripple + 1.0) * 0.5 + 0.5);
    }
    if (acrossMagnitude < uInkWidth && endpointFade > 0.0) {
      float inkEdge = 1.0 - waveStep(uInkWidth * 0.38, uInkWidth, acrossMagnitude);
      float ink = inkEdge * endpointFade * inkCoverage(vSeed, along) * 0.9;
      if (ink > 0.012) markBytes.x = toByte(ink);
    }
    float cluster = foamCoverage(vSeed, along);
    float foamWidth = max(0.5 * uMarkScale, uWaveThickness * (0.48 + 0.27 * (ripple + 1.0)));
    float foamEdge = 1.0 - waveStep(foamWidth * 0.45, foamWidth, acrossMagnitude);
    float foam = cluster * foamEdge * endpointFade * 0.82;
    if (foam > 0.015) markBytes.y = floor(foam * 255.0 + 0.5);
  }
  outBands = bands / 255.0;
  outMarks = markBytes / 255.0;
}
`;

/** Instances per draw call; flushing between them keeps each GPU submission short. */
const SEGMENTS_PER_DRAW = 32768;

export function renderOceanWaveSegmentsGl(input: OceanWaveGlInput): OceanWaveGlResult | null {
  const { width, height, segments } = input;
  return withField(width, height, (field) => {
    const { gl } = field;
    const linked = program(field, "oceanWaveSegments", SEGMENT_FRAGMENT, SEGMENT_VERTEX);
    const clip = texture(gl, "u8", width, height, input.oceanClip);
    const perm = texture(gl, "u8", 256, 1, new Uint8Array(256));
    const targets = [texture(gl, "rgba8", width, height, null), texture(gl, "rgba8", width, height, null)];
    const framebuffer = gl.createFramebuffer()!;
    const vertexArray = gl.createVertexArray()!;
    const floatBuffer = gl.createBuffer()!;
    const seedBuffer = gl.createBuffer()!;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      targets.forEach((target, index) => {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, gl.TEXTURE_2D, target, 0);
      });
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Ocean wave framebuffer incomplete");
      }
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(linked);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, clip);
      gl.uniform1i(gl.getUniformLocation(linked, "uOceanClip"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, perm);
      gl.uniform1i(gl.getUniformLocation(linked, "uPerm"), 1);
      const uniform = (name: string) => gl.getUniformLocation(linked, name);
      gl.uniform2f(uniform("uViewport"), width, height);
      gl.uniform1f(uniform("uMarkScale"), input.markScale);
      gl.uniform1f(uniform("uWaveThickness"), input.waveThickness);
      gl.uniform1f(uniform("uShadingIntensity"), input.shadingIntensity);
      gl.uniform1f(uniform("uSoftScale"), input.softScale);
      gl.uniform1f(uniform("uRidgeWidth"), input.ridgeWidth);
      gl.uniform1f(uniform("uInkWidth"), input.inkWidth);
      gl.uniform1f(uniform("uShadowBase"), input.shadowBase);
      gl.uniform1f(uniform("uLightBase"), input.lightBase);
      gl.uniform1f(uniform("uBandScale"), input.bandScale);
      gl.uniform1f(uniform("uMarksReach"), input.marksReach);
      gl.uniform2i(uniform("uWorldOffset"), input.offsetX, input.offsetY);
      gl.bindVertexArray(vertexArray);
      const stride = OCEAN_WAVE_SEGMENT_FLOATS * 4;
      gl.bindBuffer(gl.ARRAY_BUFFER, floatBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, segments.floats.subarray(0, segments.count * OCEAN_WAVE_SEGMENT_FLOATS), gl.STATIC_DRAW);
      for (let location = 0; location < 5; location++) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 4, gl.FLOAT, false, stride, location * 16);
        gl.vertexAttribDivisor(location, 1);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, segments.seeds.subarray(0, segments.count), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(5);
      gl.vertexAttribIPointer(5, 1, gl.INT, 4, 0);
      gl.vertexAttribDivisor(5, 1);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      for (let first = 0; first < segments.count; first += SEGMENTS_PER_DRAW) {
        const count = Math.min(SEGMENTS_PER_DRAW, segments.count - first);
        // Rebase the instanced attributes onto this chunk.
        gl.bindBuffer(gl.ARRAY_BUFFER, floatBuffer);
        for (let location = 0; location < 5; location++) {
          gl.vertexAttribPointer(location, 4, gl.FLOAT, false, stride, first * stride + location * 16);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer);
        gl.vertexAttribIPointer(5, 1, gl.INT, 4, first * 4);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        gl.flush();
      }
      gl.disable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      return {
        bands: readPassBytes(gl, framebuffer, 0, width, height),
        marks: readPassBytes(gl, framebuffer, 1, width, height),
      };
    } finally {
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
      gl.deleteBuffer(floatBuffer);
      gl.deleteBuffer(seedBuffer);
      gl.deleteVertexArray(vertexArray);
      gl.deleteFramebuffer(framebuffer);
      for (const owned of [clip, perm, ...targets]) gl.deleteTexture(owned);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  });
}

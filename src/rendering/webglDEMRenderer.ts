/**
 * WebGL renderer that draws a DEM as a lit 3D mesh.
 */
import type { GeomorphicLandscapeData } from '../terrain/geomorphicLandscapeEngine';
import type { ReliefShadingMode, GeomorphicPalette } from './geomorphicRenderer';

export const DEM_VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const DEM_FRAGMENT_SHADER = `
precision highp float;

varying vec2 v_uv;

uniform sampler2D u_demTexture;
uniform float u_resolution;
uniform float u_dxMeters;
uniform float u_vertExagg;
uniform int u_shadingMode; // 0: swiss_multidirectional, 1: ambient_occlusion, 2: classic
uniform int u_palette;     // 0: european_topo, 1: swiss_alpine, 2: physical_satellite, 3: high_contrast
uniform vec3 u_sunDir1;    // Primary light
uniform vec3 u_sunDir2;    // Swiss fill light 1
uniform vec3 u_sunDir3;    // Swiss fill light 2
uniform float u_aoStrength;

const float PI = 3.141592653589793;

vec3 sampleEuropeanTopo(float elev) {
  if (elev <= 80.0) return vec3(85.0/255.0, 140.0/255.0, 75.0/255.0);
  if (elev <= 250.0) {
    float t = (elev - 80.0) / 170.0;
    return mix(vec3(85.0/255.0, 140.0/255.0, 75.0/255.0), vec3(120.0/255.0, 168.0/255.0), t);
  }
  if (elev <= 600.0) {
    float t = (elev - 250.0) / 350.0;
    return mix(vec3(120.0/255.0, 168.0/255.0, 70.0/255.0), vec3(195.0/255.0, 190.0/255.0, 95.0/255.0), t);
  }
  if (elev <= 1100.0) {
    float t = (elev - 600.0) / 500.0;
    return mix(vec3(195.0/255.0, 190.0/255.0, 95.0/255.0), vec3(215.0/255.0, 165.0/255.0, 90.0/255.0), t);
  }
  if (elev <= 1700.0) {
    float t = (elev - 1100.0) / 600.0;
    return mix(vec3(215.0/255.0, 165.0/255.0, 90.0/255.0), vec3(175.0/255.0, 130.0/255.0, 95.0/255.0), t);
  }
  if (elev <= 2400.0) {
    float t = (elev - 1700.0) / 700.0;
    return mix(vec3(175.0/255.0, 130.0/255.0, 95.0/255.0), vec3(145.0/255.0, 125.0/255.0, 115.0/255.0), t);
  }
  if (elev <= 3100.0) {
    float t = (elev - 2400.0) / 700.0;
    return mix(vec3(145.0/255.0, 125.0/255.0, 115.0/255.0), vec3(195.0/255.0, 205.0/255.0, 215.0/255.0), t);
  }
  return vec3(245.0/255.0, 248.0/255.0, 252.0/255.0);
}

vec3 sampleSwissAlpine(float elev) {
  if (elev <= 400.0) return vec3(70.0/255.0, 120.0/255.0, 60.0/255.0);
  if (elev <= 1200.0) {
    float t = (elev - 400.0) / 800.0;
    return mix(vec3(70.0/255.0, 120.0/255.0, 60.0/255.0), vec3(140.0/255.0, 155.0/255.0, 85.0/255.0), t);
  }
  if (elev <= 2200.0) {
    float t = (elev - 1200.0) / 1000.0;
    return mix(vec3(140.0/255.0, 155.0/255.0, 85.0/255.0), vec3(160.0/255.0, 140.0/255.0, 120.0/255.0), t);
  }
  return mix(vec3(160.0/255.0, 140.0/255.0, 120.0/255.0), vec3(245.0/255.0, 250.0/255.0, 255.0/255.0), clamp((elev - 2200.0) / 1000.0, 0.0, 1.0));
}

vec3 sampleSatellite(float elev) {
  if (elev <= 500.0) return vec3(35.0/255.0, 75.0/255.0, 35.0/255.0);
  if (elev <= 1500.0) {
    float t = (elev - 500.0) / 1000.0;
    return mix(vec3(35.0/255.0, 75.0/255.0, 35.0/255.0), vec3(120.0/255.0, 110.0/255.0, 70.0/255.0), t);
  }
  return mix(vec3(120.0/255.0, 110.0/255.0, 70.0/255.0), vec3(230.0/255.0, 235.0/255.0, 245.0/255.0), clamp((elev - 1500.0) / 1500.0, 0.0, 1.0));
}

vec3 sampleHighContrast(float elev) {
  float t = clamp(elev / 3500.0, 0.0, 1.0);
  return vec3(t, t, t);
}

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y); // Flip Y to match canvas 2D
  float step = 1.0 / u_resolution;

  // Sample center and neighbors
  float eC  = texture2D(u_demTexture, uv).r * 8000.0;
  float eNW = texture2D(u_demTexture, uv + vec2(-step, -step)).r * 8000.0;
  float eN  = texture2D(u_demTexture, uv + vec2(0.0, -step)).r * 8000.0;
  float eNE = texture2D(u_demTexture, uv + vec2(step, -step)).r * 8000.0;
  float eW  = texture2D(u_demTexture, uv + vec2(-step, 0.0)).r * 8000.0;
  float eE  = texture2D(u_demTexture, uv + vec2(step, 0.0)).r * 8000.0;
  float eSW = texture2D(u_demTexture, uv + vec2(-step, step)).r * 8000.0;
  float eS  = texture2D(u_demTexture, uv + vec2(0.0, step)).r * 8000.0;
  float eSE = texture2D(u_demTexture, uv + vec2(step, step)).r * 8000.0;

  // Horn (1981) gradient
  float dzdx = ((eNE + 2.0 * eE + eSE) - (eNW + 2.0 * eW + eSW)) / (8.0 * u_dxMeters) * u_vertExagg;
  float dzdy = ((eSW + 2.0 * eS + eSE) - (eNW + 2.0 * eN + eNE)) / (8.0 * u_dxMeters) * u_vertExagg;

  float nLen = sqrt(dzdx * dzdx + dzdy * dzdy + 1.0);
  vec3 normal = vec3(-dzdx / nLen, -dzdy / nLen, 1.0 / nLen);

  float shade = 1.0;

  if (u_shadingMode == 0) {
    // Swiss 3-way relief
    float dot1 = max(0.0, dot(normal, u_sunDir1));
    float dot2 = max(0.0, dot(normal, u_sunDir2));
    float dot3 = max(0.0, dot(normal, u_sunDir3));
    shade = 0.20 + 0.65 * pow(dot1, 0.90) + 0.15 * dot2 + 0.08 * dot3;
  } else if (u_shadingMode == 1) {
    // Ambient Occlusion Shading
    float avgSurround = (eNW + eN + eNE + eW + eE + eSW + eS + eSE) * 0.125;
    float concavity = clamp((avgSurround - eC) / 120.0, 0.0, 1.0);
    float ao = 1.0 - concavity * u_aoStrength;

    float dot1 = max(0.0, dot(normal, u_sunDir1));
    shade = (0.28 + 0.72 * dot1) * ao;
  } else {
    // Classic single light
    float dot1 = max(0.0, dot(normal, u_sunDir1));
    shade = 0.28 + 0.72 * dot1;
  }

  vec3 baseColor = vec3(1.0);
  if (u_palette == 0) baseColor = sampleEuropeanTopo(eC);
  else if (u_palette == 1) baseColor = sampleSwissAlpine(eC);
  else if (u_palette == 2) baseColor = sampleSatellite(eC);
  else baseColor = sampleHighContrast(eC);

  baseColor *= shade;

  gl_FragColor = vec4(clamp(baseColor, 0.0, 1.0), 1.0);
}
`;

export class WebGLDEMRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private demTexture: WebGLTexture | null = null;

  // Uniform locations
  private uResLoc: WebGLUniformLocation | null = null;
  private uDxLoc: WebGLUniformLocation | null = null;
  private uVertExaggLoc: WebGLUniformLocation | null = null;
  private uShadingModeLoc: WebGLUniformLocation | null = null;
  private uPaletteLoc: WebGLUniformLocation | null = null;
  private uSunDir1Loc: WebGLUniformLocation | null = null;
  private uSunDir2Loc: WebGLUniformLocation | null = null;
  private uSunDir3Loc: WebGLUniformLocation | null = null;
  private uAoStrengthLoc: WebGLUniformLocation | null = null;
  private uDemTexLoc: WebGLUniformLocation | null = null;

  private cachedElevBuffer: Float32Array | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.initGL();
  }

  public isSupported(): boolean {
    return this.gl !== null && this.program !== null;
  }

  private initGL(): boolean {
    const gl = this.canvas.getContext('webgl', {
      alpha: false,
      antialias: true,
      preserveDrawingBuffer: true,
    });

    if (!gl) return false;
    this.gl = gl;

    const vert = this.compileShader(gl.VERTEX_SHADER, DEM_VERTEX_SHADER);
    const frag = this.compileShader(gl.FRAGMENT_SHADER, DEM_FRAGMENT_SHADER);
    if (!vert || !frag) return false;

    const prog = gl.createProgram();
    if (!prog) return false;
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('DEM Shader link error:', gl.getProgramInfoLog(prog));
      return false;
    }
    this.program = prog;

    const quadVertices = new Float32Array([
      -1.0, -1.0,  1.0, -1.0, -1.0,  1.0,
      -1.0,  1.0,  1.0, -1.0,  1.0,  1.0,
    ]);

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

    gl.useProgram(prog);
    this.uResLoc = gl.getUniformLocation(prog, 'u_resolution');
    this.uDxLoc = gl.getUniformLocation(prog, 'u_dxMeters');
    this.uVertExaggLoc = gl.getUniformLocation(prog, 'u_vertExagg');
    this.uShadingModeLoc = gl.getUniformLocation(prog, 'u_shadingMode');
    this.uPaletteLoc = gl.getUniformLocation(prog, 'u_palette');
    this.uSunDir1Loc = gl.getUniformLocation(prog, 'u_sunDir1');
    this.uSunDir2Loc = gl.getUniformLocation(prog, 'u_sunDir2');
    this.uSunDir3Loc = gl.getUniformLocation(prog, 'u_sunDir3');
    this.uAoStrengthLoc = gl.getUniformLocation(prog, 'u_aoStrength');
    this.uDemTexLoc = gl.getUniformLocation(prog, 'u_demTexture');

    this.demTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.demTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    return true;
  }

  private compileShader(type: number, src: string): WebGLShader | null {
    if (!this.gl) return null;
    const shader = this.gl.createShader(type);
    if (!shader) return null;
    this.gl.shaderSource(shader, src);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error(this.gl.getShaderInfoLog(shader));
      this.gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  public updateDEM(elevation: Float32Array, resolution: number): void {
    if (!this.gl || !this.demTexture) return;
    const gl = this.gl;
    const N = resolution;
    const pixels = new Uint8Array(N * N * 4);

    for (let i = 0; i < N * N; i++) {
      const e = elevation[i];
      const norm = Math.max(0, Math.min(255, Math.round((e / 8000.0) * 255)));
      pixels[i * 4 + 0] = norm;
      pixels[i * 4 + 1] = norm;
      pixels[i * 4 + 2] = norm;
      pixels[i * 4 + 3] = 255;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.demTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.cachedElevBuffer = elevation;
  }

  public render(
    landscape: GeomorphicLandscapeData,
    options: {
      verticalExaggeration: number;
      sunAzimuthDeg: number;
      sunAltitudeDeg: number;
      shadingMode: ReliefShadingMode;
      palette: GeomorphicPalette;
      ambientOcclusionStrength: number;
    }
  ): void {
    if (!this.gl || !this.program) return;
    const gl = this.gl;
    const N = landscape.resolution;

    if (this.cachedElevBuffer !== landscape.elevation) {
      this.updateDEM(landscape.elevation, N);
    }

    const azRad = (options.sunAzimuthDeg * Math.PI) / 180.0;
    const altRad = (options.sunAltitudeDeg * Math.PI) / 180.0;
    const lx1 = Math.cos(altRad) * Math.sin(azRad);
    const ly1 = -Math.cos(altRad) * Math.cos(azRad);
    const lz1 = Math.sin(altRad);

    const lx2 = Math.cos(altRad * 0.75) * Math.sin(azRad + 1.05);
    const ly2 = -Math.cos(altRad * 0.75) * Math.cos(azRad + 1.05);
    const lz2 = Math.sin(altRad * 0.75);

    const lx3 = Math.cos(altRad * 0.6) * Math.sin(azRad - 1.25);
    const ly3 = -Math.cos(altRad * 0.6) * Math.cos(azRad - 1.25);
    const lz3 = Math.sin(altRad * 0.6);

    const modeEnum = options.shadingMode === 'swiss_multidirectional' ? 0 : options.shadingMode === 'ambient_occlusion' ? 1 : 2;
    const palEnum = options.palette === 'european_topo' ? 0 : options.palette === 'swiss_alpine' ? 1 : options.palette === 'physical_satellite' ? 2 : 3;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const aPosLoc = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1f(this.uResLoc, N);
    gl.uniform1f(this.uDxLoc, (landscape.domainSizeKm * 1000.0) / N);
    gl.uniform1f(this.uVertExaggLoc, options.verticalExaggeration);
    gl.uniform1i(this.uShadingModeLoc, modeEnum);
    gl.uniform1i(this.uPaletteLoc, palEnum);
    gl.uniform3f(this.uSunDir1Loc, lx1, ly1, lz1);
    gl.uniform3f(this.uSunDir2Loc, lx2, ly2, lz2);
    gl.uniform3f(this.uSunDir3Loc, lx3, ly3, lz3);
    gl.uniform1f(this.uAoStrengthLoc, options.ambientOcclusionStrength);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.demTexture);
    gl.uniform1i(this.uDemTexLoc, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  public destroy(): void {
    if (!this.gl) return;
    if (this.quadBuffer) this.gl.deleteBuffer(this.quadBuffer);
    if (this.demTexture) this.gl.deleteTexture(this.demTexture);
    if (this.program) this.gl.deleteProgram(this.program);
    this.gl = null;
    this.program = null;
  }
}

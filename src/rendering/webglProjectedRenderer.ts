/**
 * GPU renderer that samples the cubed sphere into a projected map view.
 */
import type { AnalysisLayer, WorldV2 } from '../types/worldV2';
import type { CubedSphereGrid } from '../geometry/cubedSphere';
import type { ProjectionType } from '../projections/types';
import { getProjection } from '../projections';
import { PROJECTED_FRAGMENT_SHADER, PROJECTED_VERTEX_SHADER } from './webglShaders';

export interface WebGLRenderOptions {
  layer: AnalysisLayer;
  projection: ProjectionType;
  selectedMonth: number;
  showHillshade: boolean;
  /** Changes whenever mutable WorldStore fields are replaced (for example by timeline scrubbing). */
  dataVersion?: number;
}

export class WebGLProjectedRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;

  // Textures (3x2 face atlas)
  private dataTexture: WebGLTexture | null = null;
  private climateTexture: WebGLTexture | null = null;
  private extraTexture: WebGLTexture | null = null;

  // Uniform locations
  private uProjectionLoc: WebGLUniformLocation | null = null;
  private uLayerLoc: WebGLUniformLocation | null = null;
  private uShowHillshadeLoc: WebGLUniformLocation | null = null;
  private uSeaLevelLoc: WebGLUniformLocation | null = null;
  private uExtentsXLoc: WebGLUniformLocation | null = null;
  private uExtentsYLoc: WebGLUniformLocation | null = null;
  private uSunDirLoc: WebGLUniformLocation | null = null;
  private uGridResLoc: WebGLUniformLocation | null = null;

  private uDataTexLoc: WebGLUniformLocation | null = null;
  private uClimateTexLoc: WebGLUniformLocation | null = null;
  private uExtraTexLoc: WebGLUniformLocation | null = null;

  // State cache
  private cachedResolution: number = 0;
  private lastWorldRef: WorldV2 | null = null;
  private lastMonthUploaded: number = -1;
  private lastDataVersion: number = -1;
  private lastRenderTimeMs: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.initGL();
  }

  public isSupported(): boolean {
    return this.gl !== null && this.program !== null;
  }

  public getLastRenderTimeMs(): number {
    return this.lastRenderTimeMs;
  }

  private initGL(): boolean {
    try {
      const gl = this.canvas.getContext('webgl', {
        alpha: true,
        antialias: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      }) || (this.canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

      if (!gl) {
        console.warn('WebGL not supported on this canvas, falling back to 2D.');
        return false;
      }

      this.gl = gl;

      const vertShader = this.compileShader(gl.VERTEX_SHADER, PROJECTED_VERTEX_SHADER);
      const fragShader = this.compileShader(gl.FRAGMENT_SHADER, PROJECTED_FRAGMENT_SHADER);

      if (!vertShader || !fragShader) {
        return false;
      }

      const program = gl.createProgram();
      if (!program) return false;

      gl.attachShader(program, vertShader);
      gl.attachShader(program, fragShader);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('WebGL Program link error:', gl.getProgramInfoLog(program));
        return false;
      }

      this.program = program;

      // Set up full-screen quad (-1..1)
      const quadVertices = new Float32Array([
        -1.0, -1.0,
         1.0, -1.0,
        -1.0,  1.0,
        -1.0,  1.0,
         1.0, -1.0,
         1.0,  1.0,
      ]);

      this.quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

      // Look up uniforms
      gl.useProgram(program);
      this.uProjectionLoc = gl.getUniformLocation(program, 'u_projection');
      this.uLayerLoc = gl.getUniformLocation(program, 'u_layer');
      this.uShowHillshadeLoc = gl.getUniformLocation(program, 'u_showHillshade');
      this.uSeaLevelLoc = gl.getUniformLocation(program, 'u_seaLevel');
      this.uExtentsXLoc = gl.getUniformLocation(program, 'u_extentsX');
      this.uExtentsYLoc = gl.getUniformLocation(program, 'u_extentsY');
      this.uSunDirLoc = gl.getUniformLocation(program, 'u_sunDir');
      this.uGridResLoc = gl.getUniformLocation(program, 'u_gridRes');

      this.uDataTexLoc = gl.getUniformLocation(program, 'u_dataTexture');
      this.uClimateTexLoc = gl.getUniformLocation(program, 'u_climateTexture');
      this.uExtraTexLoc = gl.getUniformLocation(program, 'u_extraTexture');

      // Create Textures
      this.dataTexture = this.createTexture();
      this.climateTexture = this.createTexture();
      this.extraTexture = this.createTexture();

      return true;
    } catch (e) {
      console.warn('WebGL init error:', e);
      return false;
    }
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    if (!this.gl) return null;
    const shader = this.gl.createShader(type);
    if (!shader) return null;

    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', this.gl.getShaderInfoLog(shader));
      this.gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  private createTexture(): WebGLTexture | null {
    if (!this.gl) return null;
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  /**
   * Uploads the world cubed-sphere data fields to GPU textures.
   * Packs 6 cube faces into a 3x2 atlas tile texture:
   * Bottom Row (WebGL row 0): Face 0 (+X), Face 1 (-X), Face 2 (+Y)
   * Top Row (WebGL row 1): Face 3 (-Y), Face 4 (+Z), Face 5 (-Z)
   */
  private dataPixels: Uint8Array | null = null;
  private climatePixels: Uint8Array | null = null;
  private extraPixels: Uint8Array | null = null;

  public updateWorldTextures(world: WorldV2, grid: CubedSphereGrid, selectedMonth: number = 0): void {
    if (!this.gl) return;
    const t0 = performance.now();
    const gl = this.gl;
    const N = grid.resolution;
    const atlasW = N * 3;
    const atlasH = N * 2;
    const totalBytes = atlasW * atlasH * 4;

    if (!this.dataPixels || this.dataPixels.length !== totalBytes) {
      this.dataPixels = new Uint8Array(totalBytes);
      this.climatePixels = new Uint8Array(totalBytes);
      this.extraPixels = new Uint8Array(totalBytes);
    }

    const dataPixels = this.dataPixels;
    const climatePixels = this.climatePixels!;
    const extraPixels = this.extraPixels!;

    const monthIdx = Math.max(0, Math.min(11, selectedMonth));
    const tempField = world.climate?.monthlyTemperature?.[monthIdx];
    const precipField = world.climate?.monthlyPrecipitation?.[monthIdx];
    const elevField = world.terrain?.elevation;
    const dischargeField = world.hydrology?.discharge;
    const iceField = world.climate?.iceThickness;
    const plateIdField = world.geology?.plateIds;
    const bTypeField = world.geology?.boundaryType;
    const upliftField = world.geology?.tectonicUpliftRate;
    const closureField = world.geology?.ownershipClosure;
    const confidenceField = world.geology?.dominanceConfidence;
    const continentalField = world.geology?.continentalThicknessM;

    for (let face = 0; face < 6; face++) {
      const faceOffset = face * N * N;
      const col = face % 3;
      const row = Math.floor(face / 3);
      const startX = col * N;
      const startY = row * N;

      for (let j = 0; j < N; j++) {
        let srcIdx = faceOffset + j * N;
        let dstIdx = ((startY + j) * atlasW + startX) * 4;

        for (let i = 0; i < N; i++) {
          const pId = plateIdField ? plateIdField[srcIdx] : 0;
          const cRes = closureField ? closureField[srcIdx] : 0;
          const cConf = confidenceField ? confidenceField[srcIdx] : 1.0;
          const continentalThicknessM = continentalField ? continentalField[srcIdx] : 0;
          const bType = bTypeField ? bTypeField[srcIdx] : 0;
          const uplift = upliftField ? upliftField[srcIdx] : 0;

          // 1. Elevation & Base Data
          const elev = elevField ? elevField[srcIdx] : 0;
          const elevNorm = Math.max(0, Math.min(255, (((elev * (1.0 / 8000.0)) * 0.5 + 0.5) * 255.0 + 0.5) | 0));
          dataPixels[dstIdx + 0] = elevNorm;
          dataPixels[dstIdx + 1] = Math.max(0, Math.min(255, (cConf * 255.0 + 0.5) | 0));
          dataPixels[dstIdx + 2] = Math.max(0, Math.min(255, (continentalThicknessM * (255 / 70_000) + 0.5) | 0));
          dataPixels[dstIdx + 3] = 255;

          // 2. Climate & Hydrology
          const temp = tempField ? tempField[srcIdx] : 0;
          const tempNorm = Math.max(0, Math.min(255, (((temp * 0.02) * 0.5 + 0.5) * 255.0 + 0.5) | 0));

          const precip = precipField ? precipField[srcIdx] : 0;
          const precipNorm = Math.max(0, Math.min(255, (precip * (255.0 / 500.0) + 0.5) | 0));

          const q = dischargeField ? dischargeField[srcIdx] : 0;
          const qNorm = Math.max(0, Math.min(255, (q * (255.0 / 10000.0) + 0.5) | 0));

          const ice = iceField ? iceField[srcIdx] : 0;
          const iceNorm = Math.max(0, Math.min(255, (ice * (255.0 / 60.0) + 0.5) | 0));

          climatePixels[dstIdx + 0] = tempNorm;
          climatePixels[dstIdx + 1] = precipNorm;
          climatePixels[dstIdx + 2] = qNorm;
          climatePixels[dstIdx + 3] = iceNorm;

          // 3. Extra (Geology / Boundaries / Uplift / Closure)
          extraPixels[dstIdx + 0] = pId;
          extraPixels[dstIdx + 1] = Math.max(0, Math.min(255, (((cRes * 0.5) + 0.5) * 255.0 + 0.5) | 0));
          extraPixels[dstIdx + 2] = bType;
          extraPixels[dstIdx + 3] = Math.max(0, Math.min(255, (((uplift * 0.125) * 0.5 + 0.5) * 255.0 + 0.5) | 0));




          srcIdx++;
          dstIdx += 4;
        }
      }
    }

    const tPack = performance.now() - t0;
    const tUpload0 = performance.now();

    // Upload to GPU
    gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, atlasW, atlasH, 0, gl.RGBA, gl.UNSIGNED_BYTE, dataPixels);

    gl.bindTexture(gl.TEXTURE_2D, this.climateTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, atlasW, atlasH, 0, gl.RGBA, gl.UNSIGNED_BYTE, climatePixels);

    gl.bindTexture(gl.TEXTURE_2D, this.extraTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, atlasW, atlasH, 0, gl.RGBA, gl.UNSIGNED_BYTE, extraPixels);

    const tUpload = performance.now() - tUpload0;
    console.log(`[WebGL] 📦 updateWorldTextures: Packed in ${tPack.toFixed(2)}ms, GPU uploaded in ${tUpload.toFixed(2)}ms (Total ${(performance.now() - t0).toFixed(2)}ms)`);

    this.cachedResolution = N;
    this.lastWorldRef = world;
    this.lastMonthUploaded = selectedMonth;
  }

  /**
   * Render the current view at full GPU speed
   */
  public render(
    world: WorldV2,
    grid: CubedSphereGrid,
    options: WebGLRenderOptions
  ): void {
    const t0 = performance.now();
    if (!this.gl || !this.program) return;
    const gl = this.gl;

    // Check if world data needs upload
    const dataVersion = options.dataVersion ?? 0;
    if (
      this.lastWorldRef !== world
      || this.cachedResolution !== grid.resolution
      || this.lastMonthUploaded !== options.selectedMonth
      || this.lastDataVersion !== dataVersion
    ) {
      this.updateWorldTextures(world, grid, options.selectedMonth);
      this.lastDataVersion = dataVersion;
    }

    const projDef = getProjection(options.projection);
    const { minX, maxX, minY, maxY } = projDef.extents;

    let projEnum = 0; // Equal Earth
    if (options.projection === 'mercator') projEnum = 1;
    else if (options.projection === 'equirectangular') projEnum = 2;

    const layerMap: Record<AnalysisLayer, number> = {
      elevation: 0,
      crust_type: 1,
      crust_age: 2,
      plate_boundaries: 3,
      tectonic_uplift: 4,
      discharge: 5,
      lakes: 6,
      drainage_basins: 7,
      temperature_monthly: 8,
      precipitation_monthly: 9,
      ice_thickness: 10,
      biomes: 11,
      plate_ids: 12,
      relative_velocity: 13,
      ownership_closure: 14,
      dominance_confidence: 15,
      continental_material: 16,
    };



    const layerEnum = layerMap[options.layer] ?? 0;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);

    // Bind full-screen quad
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const aPosLoc = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

    // Set uniforms
    gl.uniform1i(this.uProjectionLoc, projEnum);
    gl.uniform1i(this.uLayerLoc, layerEnum);
    gl.uniform1i(this.uShowHillshadeLoc, options.showHillshade ? 1 : 0);
    gl.uniform1f(this.uSeaLevelLoc, world.seaLevelMeters ?? 0);
    gl.uniform2f(this.uExtentsXLoc, minX, maxX);
    gl.uniform2f(this.uExtentsYLoc, minY, maxY);
    gl.uniform3f(this.uSunDirLoc, -0.5, -0.5, 0.7071);
    gl.uniform1f(this.uGridResLoc, grid.resolution);

    // Bind texture units
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
    gl.uniform1i(this.uDataTexLoc, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.climateTexture);
    gl.uniform1i(this.uClimateTexLoc, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.extraTexture);
    gl.uniform1i(this.uExtraTexLoc, 2);

    // Draw Quad
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.flush();

    this.lastRenderTimeMs = Math.round((performance.now() - t0) * 100) / 100;
  }

  public destroy(): void {
    if (!this.gl) return;
    const gl = this.gl;
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.dataTexture) gl.deleteTexture(this.dataTexture);
    if (this.climateTexture) gl.deleteTexture(this.climateTexture);
    if (this.extraTexture) gl.deleteTexture(this.extraTexture);
    if (this.program) gl.deleteProgram(this.program);
    this.gl = null;
    this.program = null;
  }
}

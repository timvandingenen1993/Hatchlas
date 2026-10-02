/**
 * WebGL orbit viewer for a mountain DEM.
 */
import { useEffect, useRef, useState } from 'react';
import type { MountainDEMData } from '../terrain/mountainBaseDEM';
import type { MountainColorPalette } from '../rendering/mountainDetailRenderer';

interface Mountain3DViewerProps {
  dem: MountainDEMData;
  palette: MountainColorPalette;
  sunAzimuthDeg: number;
  sunAltitudeDeg: number;
}

export function Mountain3DViewer({
  dem,
  palette: _palette,
  sunAzimuthDeg,
  sunAltitudeDeg,
}: Mountain3DViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [heightScale, setHeightScale] = useState<number>(2.5);
  const [wireframe, setWireframe] = useState<boolean>(false);
  const [autoRotate, setAutoRotate] = useState<boolean>(false);

  // Camera Orbit State
  const cameraRef = useRef({
    rotX: 45, // Pitch angle (deg)
    rotY: -35, // Yaw angle (deg)
    distance: 2.8,
    panX: 0,
    panY: 0,
    isDragging: false,
    dragButton: 0,
    lastMouseX: 0,
    lastMouseY: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) {
      console.error('WebGL not supported for 3D terrain viewer');
      return;
    }

    // Vertex & Fragment Shaders
    const vsSource = `
      attribute vec3 a_position;
      attribute vec3 a_normal;
      attribute vec3 a_color;

      uniform mat4 u_mvpMatrix;
      uniform mat4 u_modelMatrix;
      uniform vec3 u_lightDir;

      varying vec3 v_color;
      varying float v_light;
      varying float v_height;

      void main() {
        gl_Position = u_mvpMatrix * vec4(a_position, 1.0);
        v_color = a_color;
        v_height = a_position.y;

        vec3 worldNorm = normalize((u_modelMatrix * vec4(a_normal, 0.0)).xyz);
        float diff = max(0.18, dot(worldNorm, normalize(u_lightDir)));
        v_light = diff;
      }
    `;

    const fsSource = `
      precision mediump float;
      varying vec3 v_color;
      varying float v_light;
      varying float v_height;

      void main() {
        vec3 col = v_color * (0.35 + 0.65 * v_light);
        gl_FragColor = vec4(col, 1.0);
      }
    `;

    function createShader(gl: WebGLRenderingContext, type: number, src: string) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    }

    const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);

    const aPos = gl.getAttribLocation(prog, 'a_position');
    const aNorm = gl.getAttribLocation(prog, 'a_normal');
    const aCol = gl.getAttribLocation(prog, 'a_color');
    const uMvp = gl.getUniformLocation(prog, 'u_mvpMatrix');
    const uModel = gl.getUniformLocation(prog, 'u_modelMatrix');
    const uLight = gl.getUniformLocation(prog, 'u_lightDir');

    // Sub-sample DEM for smooth 3D rendering
    const gridW = 160;
    const gridH = Math.round(160 * (dem.height / dem.width));
    const numVerts = gridW * gridH;

    const positions = new Float32Array(numVerts * 3);
    const normals = new Float32Array(numVerts * 3);
    const colors = new Float32Array(numVerts * 3);

    for (let gy = 0; gy < gridH; gy++) {
      const srcY = Math.min(dem.height - 1, Math.floor((gy / (gridH - 1)) * dem.height));
      const posY = (gy / (gridH - 1) - 0.5) * (dem.height / dem.width);

      for (let gx = 0; gx < gridW; gx++) {
        const srcX = Math.min(dem.width - 1, Math.floor((gx / (gridW - 1)) * dem.width));
        const posX = gx / (gridW - 1) - 0.5;

        const srcIdx = srcY * dem.width + srcX;
        const vIdx = gy * gridW + gx;

        const normH = dem.normalizedElevation[srcIdx];
        const h = normH * 0.45 * heightScale;

        positions[vIdx * 3 + 0] = posX;
        positions[vIdx * 3 + 1] = h;
        positions[vIdx * 3 + 2] = posY;

        // Sample surface normal
        normals[vIdx * 3 + 0] = dem.normals[srcIdx * 3 + 0];
        normals[vIdx * 3 + 1] = dem.normals[srcIdx * 3 + 2]; // Y is up in 3D
        normals[vIdx * 3 + 2] = dem.normals[srcIdx * 3 + 1];

        // Color based on height and river channel
        const isRiver = dem.strahlerOrder[srcIdx] >= 2;
        if (isRiver) {
          colors[vIdx * 3 + 0] = 0.12;
          colors[vIdx * 3 + 1] = 0.52;
          colors[vIdx * 3 + 2] = 0.88;
        } else if (normH > 0.82) {
          colors[vIdx * 3 + 0] = 0.96;
          colors[vIdx * 3 + 1] = 0.97;
          colors[vIdx * 3 + 2] = 1.0;
        } else if (normH > 0.60) {
          colors[vIdx * 3 + 0] = 0.65;
          colors[vIdx * 3 + 1] = 0.48;
          colors[vIdx * 3 + 2] = 0.35;
        } else if (normH > 0.35) {
          colors[vIdx * 3 + 0] = 0.85;
          colors[vIdx * 3 + 1] = 0.75;
          colors[vIdx * 3 + 2] = 0.45;
        } else {
          colors[vIdx * 3 + 0] = 0.32;
          colors[vIdx * 3 + 1] = 0.62;
          colors[vIdx * 3 + 2] = 0.35;
        }
      }
    }

    // Grid Triangles Index Buffer
    const indices = new Uint16Array((gridW - 1) * (gridH - 1) * 6);
    let iIdx = 0;
    for (let gy = 0; gy < gridH - 1; gy++) {
      for (let gx = 0; gx < gridW - 1; gx++) {
        const i0 = gy * gridW + gx;
        const i1 = i0 + 1;
        const i2 = (gy + 1) * gridW + gx;
        const i3 = i2 + 1;

        indices[iIdx++] = i0;
        indices[iIdx++] = i2;
        indices[iIdx++] = i1;

        indices[iIdx++] = i1;
        indices[iIdx++] = i2;
        indices[iIdx++] = i3;
      }
    }

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const normBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);

    const colBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.enable(gl.DEPTH_TEST);

    let animationFrameId: number;

    function renderLoop() {
      if (!canvas || !gl) return;

      if (autoRotate) {
        cameraRef.current.rotY += 0.35;
      }

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }

      gl.clearColor(0.04, 0.06, 0.10, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      gl.useProgram(prog);

      // Light direction from sun sliders
      const sAz = (sunAzimuthDeg * Math.PI) / 180.0;
      const sAlt = (sunAltitudeDeg * Math.PI) / 180.0;
      const lightDir = [
        Math.sin(sAz) * Math.cos(sAlt),
        Math.sin(sAlt),
        -Math.cos(sAz) * Math.cos(sAlt),
      ];
      gl.uniform3fv(uLight, lightDir);

      // 3D Matrix Math (Perspective + LookAt + Rotations)
      const aspect = w / h;
      const fov = (45 * Math.PI) / 180.0;
      const near = 0.1;
      const far = 100.0;
      const f = 1.0 / Math.tan(fov / 2);

      const pMat = new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) / (near - far), -1,
        0, 0, (2 * far * near) / (near - far), 0,
      ]);

      const cam = cameraRef.current;
      const rx = (cam.rotX * Math.PI) / 180.0;
      const ry = (cam.rotY * Math.PI) / 180.0;

      // View Matrix with Pan and Orbit
      const cosY = Math.cos(ry);
      const sinY = Math.sin(ry);
      const cosX = Math.cos(rx);
      const sinX = Math.sin(rx);

      // Model-View Matrix
      const mvMat = new Float32Array([
        cosY, sinX * sinY, -cosX * sinY, 0,
        0, cosX, sinX, 0,
        sinY, -sinX * cosY, cosX * cosY, 0,
        cam.panX, -cam.panY - 0.2, -cam.distance, 1,
      ]);

      // Multiply MVP = P * MV
      const mvp = new Float32Array(16);
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            sum += pMat[k * 4 + i] * mvMat[j * 4 + k];
          }
          mvp[j * 4 + i] = sum;
        }
      }

      gl.uniformMatrix4fv(uMvp, false, mvp);
      gl.uniformMatrix4fv(uModel, false, mvMat);

      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
      gl.enableVertexAttribArray(aNorm);
      gl.vertexAttribPointer(aNorm, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
      gl.enableVertexAttribArray(aCol);
      gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);

      if (wireframe) {
        gl.drawElements(gl.LINES, indices.length, gl.UNSIGNED_SHORT, 0);
      } else {
        gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
      }

      animationFrameId = requestAnimationFrame(renderLoop);
    }

    animationFrameId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(animationFrameId);
      gl.deleteBuffer(posBuf);
      gl.deleteBuffer(normBuf);
      gl.deleteBuffer(colBuf);
      gl.deleteBuffer(idxBuf);
      gl.deleteProgram(prog);
    };
  }, [dem, heightScale, wireframe, autoRotate, sunAzimuthDeg, sunAltitudeDeg]);

  // Mouse Orbit & Pan Handlers
  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    cameraRef.current.isDragging = true;
    cameraRef.current.dragButton = e.button;
    cameraRef.current.lastMouseX = e.clientX;
    cameraRef.current.lastMouseY = e.clientY;
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const cam = cameraRef.current;
    if (!cam.isDragging) return;

    const dx = e.clientX - cam.lastMouseX;
    const dy = e.clientY - cam.lastMouseY;
    cam.lastMouseX = e.clientX;
    cam.lastMouseY = e.clientY;

    if (cam.dragButton === 0) {
      // Left Click = Orbit
      cam.rotY += dx * 0.45;
      cam.rotX = Math.max(5.0, Math.min(88.0, cam.rotX + dy * 0.45));
    } else if (cam.dragButton === 2 || cam.dragButton === 1) {
      // Right Click or Middle = Pan
      cam.panX += dx * 0.003 * cam.distance;
      cam.panY += dy * 0.003 * cam.distance;
    }
  }

  function handleMouseUp() {
    cameraRef.current.isDragging = false;
  }

  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const cam = cameraRef.current;
    cam.distance = Math.max(0.6, Math.min(6.5, cam.distance + e.deltaY * 0.002));
  }

  function handleResetView() {
    cameraRef.current.rotX = 45;
    cameraRef.current.rotY = -35;
    cameraRef.current.distance = 2.8;
    cameraRef.current.panX = 0;
    cameraRef.current.panY = 0;
  }

  return (
    <div className="relative h-full w-full bg-slate-950 flex flex-col overflow-hidden select-none">
      {/* 3D WebGL Canvas */}
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-grab active:cursor-grabbing block"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Floating 3D Navigation & Shader Overlay Toolbar */}
      <div className="absolute top-4 left-4 z-20 bg-slate-900/90 backdrop-blur border border-slate-800 p-3 rounded-2xl shadow-2xl flex flex-col gap-2.5 max-w-xs text-xs text-slate-200">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2">
          <span className="font-bold text-cyan-400 flex items-center gap-1.5">
            <span>🌐</span> 3D Perspective Orbit
          </span>
          <button
            onClick={handleResetView}
            className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-semibold transition cursor-pointer"
          >
            Reset View
          </button>
        </div>

        {/* Height Exaggeration */}
        <div className="flex flex-col gap-1">
          <div className="flex justify-between items-center text-[11px]">
            <span className="text-slate-400">Vertical Relief Scale</span>
            <span className="font-mono text-cyan-300 font-bold">{heightScale.toFixed(1)}×</span>
          </div>
          <input
            type="range"
            min="0.5"
            max="6.0"
            step="0.1"
            value={heightScale}
            onChange={(e) => setHeightScale(parseFloat(e.target.value))}
            className="accent-cyan-400 cursor-pointer"
          />
        </div>

        {/* Wireframe & Auto Rotate Toggles */}
        <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-800">
          <button
            onClick={() => setWireframe(!wireframe)}
            className={`py-1.5 px-2 rounded-lg font-semibold text-center transition cursor-pointer text-[11px] ${
              wireframe ? 'bg-amber-600 text-white font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
            }`}
          >
            🕸️ Wireframe
          </button>
          <button
            onClick={() => setAutoRotate(!autoRotate)}
            className={`py-1.5 px-2 rounded-lg font-semibold text-center transition cursor-pointer text-[11px] ${
              autoRotate ? 'bg-cyan-600 text-white font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
            }`}
          >
            🔄 Turntable
          </button>
        </div>

        <div className="text-[10px] text-slate-500 flex flex-col gap-0.5 pt-1">
          <span>• <strong>Left Click + Drag</strong>: Rotate Orbit</span>
          <span>• <strong>Right Click + Drag</strong>: Pan Terrain</span>
          <span>• <strong>Scroll Wheel</strong>: Zoom In / Out</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Interactive Equal Earth viewport: pan, zoom and cursor inspection.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { AnalysisLayer } from '../types/worldV2';
import { sampleCubedSphereNearest } from '../geometry/cubedSphere';
import type { ProjectionType } from '../projections/types';
import { getProjection } from '../projections';
import { rasterizeProjectedLayer } from '../projections/rasterizer';
import { latLonRadToVec3, type Vec3 } from '../geometry/coordinates';
import { BIOME_DEFINITIONS } from '../utils/colorRamps';
import { WorldStore } from '../storage/worldStore';
import { WebGLProjectedRenderer } from '../rendering/webglProjectedRenderer';

interface EqualEarthViewerProps {
  worldVersion: number;
  currentLayer: AnalysisLayer;
  projection?: ProjectionType;
  selectedMonth: number;
  showHillshade: boolean;
  onSetProfilePoints?: (a: Vec3, b: Vec3) => void;
}

export interface CursorInspectionData {
  latDeg: number;
  lonDeg: number;
  elevationM: number;
  crustTypeName: string;
  crustAgeMyr: number;
  upliftRateMmYr: number;
  temperatureC: number;
  precipitationMm: number;
  dischargeM3s: number;
  biomeName: string;
}

export const EqualEarthViewer: React.FC<EqualEarthViewerProps> = ({
  worldVersion,
  currentLayer,
  projection = 'equal_earth',
  selectedMonth,
  showHillshade,
  onSetProfilePoints,
}) => {
  const world = WorldStore.getWorld();
  const grid = WorldStore.getGrid();
  const tViewerRender = performance.now();
  console.log(`[React Trace] 🔵 EqualEarthViewer rendering at +${tViewerRender.toFixed(1)}ms (worldVersion=${worldVersion}, world=${!!world})`);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const webglRendererRef = useRef<WebGLProjectedRenderer | null>(null);
  const [useWebGL, setUseWebGL] = useState<boolean>(true);

  // Pan and zoom state
  const [zoom, setZoom] = useState(1.0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const hoverRafRef = useRef<number | null>(null);

  // Inspection HUD under cursor
  const [cursorData, setCursorData] = useState<CursorInspectionData | null>(null);

  // Profile click points
  const [clickA, setClickA] = useState<Vec3 | null>(null);

  // Direct DOM ref for performance badge (avoids React re-render cycle after WebGL draw)
  const perfBadgeRef = useRef<HTMLSpanElement | null>(null);

  const projDef = getProjection(projection);

  // Main render routine (WebGL 60fps with graceful 2D fallback)
  useEffect(() => {
    if (!world || !grid || !canvasRef.current) return;

    const tRenderStart = performance.now();
    console.log(`%c[Viewer] 🎨 Render effect triggered (layer=${currentLayer}, proj=${projection}, WebGL=${useWebGL}) at +${tRenderStart.toFixed(1)}ms`, 'color: #a855f7; font-weight: bold;');

    let rasterW = 1024;
    let rasterH = Math.round(rasterW / projDef.aspectRatio);

    if (projection === 'mercator') {
      rasterW = 800;
      rasterH = 800;
    }

    const canvas = canvasRef.current;
    if (canvas.width !== rasterW || canvas.height !== rasterH) {
      canvas.width = rasterW;
      canvas.height = rasterH;
    }

    if (useWebGL) {
      if (!webglRendererRef.current) {
        const tInit0 = performance.now();
        const renderer = new WebGLProjectedRenderer(canvas);
        console.log(`[Viewer] WebGLProjectedRenderer initialized in ${(performance.now() - tInit0).toFixed(2)}ms (supported=${renderer.isSupported()})`);
        if (renderer.isSupported()) {
          webglRendererRef.current = renderer;
        } else {
          console.warn('[Viewer] WebGL not supported, setting useWebGL=false');
          setUseWebGL(false);
          return;
        }
      }

      const renderer = webglRendererRef.current;
      if (renderer && renderer.isSupported()) {
        try {
          renderer.render(world, grid, {
            layer: currentLayer,
            projection,
            selectedMonth,
            showHillshade,
            dataVersion: worldVersion,
          });
          const totalMs = performance.now() - tRenderStart;
          console.warn(
            `%c[Pipeline Timeline 4/4] ⚡ MAP VIEWPORT DISPLAYED! (Rendered in ${totalMs.toFixed(2)}ms, GPU Draw: ${renderer.getLastRenderTimeMs().toFixed(2)}ms)`,
            'color: #22c55e; font-size: 13px; font-weight: bold; background: #052e16; padding: 4px 8px; border: 1px solid #16a34a; border-radius: 4px;'
          );
          if (perfBadgeRef.current) {
            perfBadgeRef.current.textContent = `⚡ WebGL (GPU) (${renderer.getLastRenderTimeMs().toFixed(1)}ms)`;
          }
          return;
        } catch (err) {
          console.warn('WebGL render failed, falling back to 2D Canvas:', err);
          setUseWebGL(false);
          return;
        }
      }
    }

    // Fallback to CPU Canvas 2D
    const t0 = performance.now();
    const ctx = canvas.getContext('2d');
    if (ctx) {
      console.warn(`[Viewer] 🐢 Running CPU rasterizer fallback (${rasterW}x${rasterH})...`);
      const imgData = rasterizeProjectedLayer(world, grid, {
        width: rasterW,
        height: rasterH,
        layer: currentLayer,
        projection,
        selectedMonth,
        showHillshade,
      });
      ctx.putImageData(imgData, 0, 0);
      const cpuTime = performance.now() - t0;
      console.log(`%c[Viewer] 🐢 2D Canvas CPU rasterization took ${cpuTime.toFixed(2)}ms`, 'color: #f59e0b; font-weight: bold;');
      if (perfBadgeRef.current) {
        perfBadgeRef.current.textContent = `2D Canvas (CPU) (${cpuTime.toFixed(1)}ms)`;
      }
    }
  }, [worldVersion, currentLayer, projection, selectedMonth, showHillshade, projDef.aspectRatio, useWebGL]);

  // Clean up WebGL on unmount
  useEffect(() => {
    return () => {
      if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current);
      if (webglRendererRef.current) {
        webglRendererRef.current.destroy();
        webglRendererRef.current = null;
      }
    };
  }, []);

  // Attach non-passive wheel listener for zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      setZoom((prev) => Math.max(0.6, Math.min(10.0, prev * zoomFactor)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Mouse drag pan
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - dragStart.y });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Cursor hover inspection (throttled with RAF)
  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    }

    if (!world || !grid || !canvasRef.current || !containerRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current);
    hoverRafRef.current = requestAnimationFrame(() => {
      const normPx = clientX / rect.width;
      const normPy = clientY / rect.height;

      if (normPx < 0 || normPx > 1 || normPy < 0 || normPy > 1) {
        setCursorData(null);
        return;
      }

      const { minX, maxX, minY, maxY } = projDef.extents;
      const normX = minX + normPx * (maxX - minX);
      const normY = maxY - normPy * (maxY - minY);

      const inv = projDef.inverse(normX, normY);
      if (!inv) {
        setCursorData(null);
        return;
      }

      const { latRad, lonRad } = inv;
      const latDeg = (latRad * 180) / Math.PI;
      const lonDeg = (lonRad * 180) / Math.PI;

      const elev = sampleCubedSphereNearest(grid, world.terrain.elevation, latRad, lonRad);
      const cType = Math.round(sampleCubedSphereNearest(grid, world.geology.crustType, latRad, lonRad));
      const cAge = sampleCubedSphereNearest(grid, world.geology.crustAge, latRad, lonRad);
      const uplift = sampleCubedSphereNearest(grid, world.geology.tectonicUpliftRate, latRad, lonRad);

      const monthIdx = Math.max(0, Math.min(11, selectedMonth));
      const tempField = world.climate?.monthlyTemperature?.[monthIdx];
      const precipField = world.climate?.monthlyPrecipitation?.[monthIdx];
      const temp = tempField ? sampleCubedSphereNearest(grid, tempField, latRad, lonRad) : 0;
      const precip = precipField ? sampleCubedSphereNearest(grid, precipField, latRad, lonRad) : 0;
      const q = world.hydrology?.discharge ? sampleCubedSphereNearest(grid, world.hydrology.discharge, latRad, lonRad) : 0;
      const bId = world.ecology?.biomes ? Math.round(sampleCubedSphereNearest(grid, world.ecology.biomes, latRad, lonRad)) : 0;

      const crustNames = ['Oceanic Crust', 'Continental Craton', 'Volcanic Arc / Orogen'];

      setCursorData({
        latDeg,
        lonDeg,
        elevationM: elev,
        crustTypeName: crustNames[cType] || 'Crust',
        crustAgeMyr: cAge,
        upliftRateMmYr: uplift,
        temperatureC: temp,
        precipitationMm: precip,
        dischargeM3s: q,
        biomeName: BIOME_DEFINITIONS[bId]?.name || 'Biome',
      });
    });
  };

  // Click on map to set Great-Circle profile crosshairs
  const handleClick = (e: React.MouseEvent) => {
    if (!world || !grid || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const normPx = (e.clientX - rect.left) / rect.width;
    const normPy = (e.clientY - rect.top) / rect.height;

    const { minX, maxX, minY, maxY } = projDef.extents;
    const normX = minX + normPx * (maxX - minX);
    const normY = maxY - normPy * (maxY - minY);

    const inv = projDef.inverse(normX, normY);
    if (!inv) return;

    const pt = latLonRadToVec3(inv.latRad, inv.lonRad);
    if (!clickA) {
      setClickA(pt);
    } else {
      onSetProfilePoints?.(clickA, pt);
      setClickA(null);
    }
  };

  const resetView = () => {
    setZoom(1.0);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onClick={handleClick}
      className="relative w-full h-full bg-slate-950 overflow-hidden flex items-center justify-center cursor-crosshair select-none"
    >
      {/* Projected Canvas */}
      <canvas
        key={useWebGL ? 'webgl-canvas' : '2d-canvas'}
        ref={canvasRef}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transition: isDragging ? 'none' : 'transform 0.08s ease-out',
          boxShadow: '0 0 50px rgba(0,0,0,0.8)',
        }}
        className="rounded-xl border border-slate-800/80 max-w-full max-h-full"
      />

      {/* Floating View Controls */}
      <div className="absolute top-4 right-4 flex items-center gap-1.5 bg-slate-900/90 backdrop-blur border border-slate-800 p-1.5 rounded-lg shadow-xl z-20">
        <button
          onClick={(e) => { e.stopPropagation(); setZoom((z) => Math.min(10.0, z * 1.25)); }}
          className="w-7 h-7 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-sm font-bold cursor-pointer"
          title="Zoom In"
        >
          +
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setZoom((z) => Math.max(0.6, z * 0.8)); }}
          className="w-7 h-7 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-sm font-bold cursor-pointer"
          title="Zoom Out"
        >
          -
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); resetView(); }}
          className="px-2 h-7 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs font-semibold cursor-pointer"
          title="Reset View"
        >
          Reset
        </button>
      </div>

      {/* Real-time Cursor Coordinates & Physical Metrics HUD */}
      {cursorData && (
        <div className="absolute bottom-4 left-4 right-4 sm:right-auto bg-slate-900/95 backdrop-blur border border-slate-700/80 rounded-xl p-3 shadow-2xl z-20 text-xs flex flex-wrap items-center gap-x-4 gap-y-1.5 text-slate-300 pointer-events-none">
          <div className="flex items-center gap-1.5 font-mono text-cyan-300 font-semibold">
            <span>📍</span>
            <span>
              {Math.abs(cursorData.latDeg).toFixed(1)}° {cursorData.latDeg >= 0 ? 'N' : 'S'},{' '}
              {Math.abs(cursorData.lonDeg).toFixed(1)}° {cursorData.lonDeg >= 0 ? 'E' : 'W'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Elevation:</span>
            <span className={`font-bold ${cursorData.elevationM > 0 ? 'text-emerald-400' : 'text-sky-400'}`}>
              {cursorData.elevationM.toFixed(0)} m
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Crust:</span>
            <span className="text-amber-300">{cursorData.crustTypeName} ({cursorData.crustAgeMyr.toFixed(0)} Myr)</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Temp:</span>
            <span className="text-orange-300">{cursorData.temperatureC.toFixed(1)} °C</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Precip:</span>
            <span className="text-blue-300">{cursorData.precipitationMm.toFixed(0)} mm/mo</span>
          </div>
          {cursorData.dischargeM3s > 1.0 && (
            <div className="flex items-center gap-1">
              <span className="text-slate-400">Discharge:</span>
              <span className="text-cyan-300 font-mono">{cursorData.dischargeM3s.toFixed(1)} m³/s</span>
            </div>
          )}
          <div className="flex items-center gap-1 bg-slate-800/80 px-2 py-0.5 rounded text-emerald-300 font-medium">
            <span>🌿</span> {cursorData.biomeName}
          </div>
        </div>
      )}

      {/* Projection & Performance Badge */}
      <div className="absolute top-4 left-4 bg-slate-900/90 backdrop-blur border border-slate-800 px-3 py-1.5 rounded-lg text-[11px] font-mono text-slate-300 pointer-events-none flex items-center gap-2.5 shadow-md">
        <span className="text-cyan-400 font-semibold">{projDef.name}</span>
        <span className="text-slate-600">•</span>
        <span ref={perfBadgeRef} className="text-emerald-400 font-bold flex items-center gap-1 text-[10px]">
          ⚡ WebGL (GPU)
        </span>
      </div>
    </div>
  );
};

export const MapViewer = EqualEarthViewer;

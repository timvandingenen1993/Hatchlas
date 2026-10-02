/**
 * Map canvas: picks the active renderer for the layer and handles brush and click input.
 */
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { renderParchmentMap } from '../rendering/parchmentRenderer';
import { renderSatelliteMap } from '../rendering/satelliteRenderer';
import { renderPureHillshadeMap } from '../rendering/hillshadeRenderer';
import {
  renderHypsometricMap,
  renderTemperatureMap,
  renderMoistureMap,
  renderDrainageBasinsMap,
  renderTectonicsMap,
  renderGeologyMap,
} from '../rendering/analysisRenderer';
import { renderIsometricMap } from '../rendering/isometricRenderer';
import { renderDebugDiagnosticMap } from '../rendering/debugRenderer';
import { BIOMES } from '../core/biomes';
import { ROCK_SOIL_DEFINITIONS } from '../types/map';
import { generatePOIName } from '../utils/fantasyNames';
import type { MapData, ToolSettings, ElevationProfileSample, POI } from '../types/map';

interface ViewportProps {
  mapData: MapData;
  settings: ToolSettings;
  onModifyMapData: (updater: (prev: MapData) => MapData) => void;
  onOpenProfileModal: (samples: ElevationProfileSample[]) => void;
  onSelectPOI?: (poi: POI) => void;
}

export const Viewport: React.FC<ViewportProps> = ({
  mapData,
  settings,
  onModifyMapData,
  onOpenProfileModal,
  onSelectPOI,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  // Zoom & Pan state
  const [zoom, setZoom] = useState<number>(1.2);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [startPan, setStartPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Brushing & Drag state
  const [isBrushing, setIsBrushing] = useState<boolean>(false);
  const [sliceStart, setSliceStart] = useState<{ x: number; y: number } | null>(null);
  const [sliceEnd, setSliceEnd] = useState<{ x: number; y: number } | null>(null);

  // Cursor HUD State
  const [cursorInfo, setCursorInfo] = useState<{
    mapX: number;
    mapY: number;
    elevationMeters: number;
    elevationNorm: number;
    temperatureC: number;
    moisturePct: number;
    riverFlux: number;
    biomeName: string;
    biomeColor: string;
    rockSoilName: string;
    isWater: boolean;
  } | null>(null);

  // Center map on initial load
  useEffect(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setPan({
        x: (rect.width - mapData.width * zoom) / 2,
        y: (rect.height - mapData.height * zoom) / 2,
      });
    }
  }, [mapData.width, mapData.height, zoom]);

  // Main Render Routine
  const renderMap = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    switch (settings.renderMode) {
      case 'hillshade':
        renderPureHillshadeMap(canvas, mapData, settings);
        break;
      case 'parchment':
        renderParchmentMap(canvas, mapData, settings);
        break;
      case 'satellite':
        renderSatelliteMap(canvas, mapData, settings);
        break;
      case 'hypsometric':
        renderHypsometricMap(canvas, mapData, settings);
        break;
      case 'temperature':
        renderTemperatureMap(canvas, mapData, settings);
        break;
      case 'moisture':
        renderMoistureMap(canvas, mapData, settings);
        break;
      case 'basins':
        renderDrainageBasinsMap(canvas, mapData, settings);
        break;
      case 'geology':
        renderGeologyMap(canvas, mapData, settings);
        break;
      case 'tectonics':
        renderTectonicsMap(canvas, mapData, settings);
        break;
      case 'isometric':
        renderIsometricMap(canvas, mapData, settings);
        break;
      case 'debug':
        renderDebugDiagnosticMap(canvas, mapData, settings);
        break;
      default:
        renderParchmentMap(canvas, mapData, settings);
    }
  }, [mapData, settings]);

  useEffect(() => {
    renderMap();
  }, [renderMap]);

  // Screen coordinate to Map Grid coordinate conversion
  const screenToMap = useCallback(
    (clientX: number, clientY: number): { mapX: number; mapY: number } | null => {
      const container = containerRef.current;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;

      const mapX = Math.floor((screenX - pan.x) / zoom);
      const mapY = Math.floor((screenY - pan.y) / zoom);

      if (mapX < 0 || mapX >= mapData.width || mapY < 0 || mapY >= mapData.height) {
        return null;
      }
      return { mapX, mapY };
    },
    [pan, zoom, mapData.width, mapData.height]
  );

  // Apply Live Sculpt / Climate / River Brush on Map
  const applyBrush = useCallback(
    (mapX: number, mapY: number) => {
      const { activeTool, brushSize, brushStrength, sculptMode, climateMode, riverMode } = settings;
      const { width, height, config } = mapData;

      onModifyMapData((prev) => {
        const nextElevation = new Float32Array(prev.elevation);
        const nextTemp = new Float32Array(prev.temperature);
        const nextMoist = new Float32Array(prev.moisture);
        const nextGlacier = new Float32Array(prev.glacierIce);
        const nextFlux = new Float32Array(prev.riverFlux);

        const r = brushSize;
        const rSq = r * r;

        for (let dy = -r; dy <= r; dy++) {
          const cy = mapY + dy;
          if (cy < 0 || cy >= height) continue;
          const yIdx = cy * width;

          for (let dx = -r; dx <= r; dx++) {
            const cx = mapX + dx;
            if (cx < 0 || cx >= width) continue;

            const dSq = dx * dx + dy * dy;
            if (dSq > rSq) continue;

            const distNorm = Math.sqrt(dSq) / r;
            // Gaussian-like smooth falloff
            const weight = (1.0 - distNorm * distNorm) * brushStrength;
            const idx = yIdx + cx;

            if (activeTool === 'sculpt') {
              let h = nextElevation[idx];
              switch (sculptMode) {
                case 'raise':
                  h = Math.min(1.0, h + 0.04 * weight);
                  break;
                case 'lower':
                  h = Math.max(0.0, h - 0.04 * weight);
                  break;
                case 'mountain':
                  h = Math.min(1.0, h + 0.08 * (1 - distNorm) * weight);
                  break;
                case 'volcano':
                  if (distNorm < 0.25) {
                    h = Math.max(config.seaLevel, h - 0.06 * weight); // Caldera pit
                  } else {
                    h = Math.min(1.0, h + 0.07 * (1 - distNorm) * weight);
                  }
                  break;
                case 'flatten': {
                  const targetH = 0.55;
                  h = h * (1 - weight * 0.3) + targetH * (weight * 0.3);
                  break;
                }
                case 'smooth': {
                  const hN = cy > 0 ? nextElevation[idx - width] : h;
                  const hS = cy < height - 1 ? nextElevation[idx + width] : h;
                  const hW = cx > 0 ? nextElevation[idx - 1] : h;
                  const hE = cx < width - 1 ? nextElevation[idx + 1] : h;
                  const avg = (hN + hS + hW + hE) * 0.25;
                  h = h * (1 - weight * 0.4) + avg * (weight * 0.4);
                  break;
                }
                case 'terrace': {
                  const step = Math.round(h * 12) / 12;
                  h = h * (1 - weight * 0.45) + step * (weight * 0.45);
                  break;
                }
                case 'island': {
                  const targetElev = config.seaLevel + 0.18 * (1 - distNorm);
                  h = Math.max(h, targetElev * weight + h * (1 - weight));
                  break;
                }
                case 'canyon':
                  h = Math.max(0.0, h - 0.1 * (1 - distNorm) * weight);
                  break;
              }
              nextElevation[idx] = h;
            } else if (activeTool === 'climate') {
              switch (climateMode) {
                case 'heat':
                  nextTemp[idx] = Math.min(50, nextTemp[idx] + 4.0 * weight);
                  break;
                case 'cool':
                  nextTemp[idx] = Math.max(-40, nextTemp[idx] - 4.0 * weight);
                  break;
                case 'rain':
                  nextMoist[idx] = Math.min(1.0, nextMoist[idx] + 0.15 * weight);
                  break;
                case 'dry':
                  nextMoist[idx] = Math.max(0.0, nextMoist[idx] - 0.15 * weight);
                  break;
                case 'glacier':
                  nextGlacier[idx] = Math.min(1.0, nextGlacier[idx] + 0.3 * weight);
                  nextTemp[idx] = Math.min(-5, nextTemp[idx] - 6 * weight);
                  break;
              }
            } else if (activeTool === 'river') {
              switch (riverMode) {
                case 'spring':
                  nextFlux[idx] += 80.0 * weight;
                  break;
                case 'dig_channel':
                  nextElevation[idx] = Math.max(0.0, nextElevation[idx] - 0.05 * weight);
                  nextFlux[idx] += 30.0 * weight;
                  break;
                case 'fill_lake':
                  nextElevation[idx] = config.seaLevel + 0.05;
                  break;
                case 'remove_water':
                  nextFlux[idx] = 0;
                  break;
              }
            }
          }
        }

        return {
          ...prev,
          elevation: nextElevation,
          temperature: nextTemp,
          moisture: nextMoist,
          glacierIce: nextGlacier,
          riverFlux: nextFlux,
        };
      });
    },
    [settings, mapData, onModifyMapData]
  );

  // Mouse Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || e.altKey || e.shiftKey) {
      setIsPanning(true);
      setStartPan({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      return;
    }

    const coords = screenToMap(e.clientX, e.clientY);
    if (!coords) return;

    const clickedPOI = mapData.pois.find(
      (p) => Math.hypot(p.x - coords.mapX, p.y - coords.mapY) < 12
    );
    if (clickedPOI && onSelectPOI) {
      onSelectPOI(clickedPOI);
      return;
    }

    if (settings.activeTool === 'poi') {
      const newPOI: POI = {
        id: `poi-${Date.now()}`,
        name: generatePOIName(settings.selectedPOICategory, Date.now()),
        category: settings.selectedPOICategory,
        x: coords.mapX,
        y: coords.mapY,
        size: 16,
        description: `A newly discovered ${settings.selectedPOICategory}.`,
      };
      onModifyMapData((prev) => ({
        ...prev,
        pois: [...prev.pois, newPOI],
      }));
      return;
    }

    if (settings.activeTool === 'profile' || settings.activeTool === 'ruler') {
      setSliceStart({ x: coords.mapX, y: coords.mapY });
      setSliceEnd({ x: coords.mapX, y: coords.mapY });
      return;
    }

    if (['sculpt', 'climate', 'river'].includes(settings.activeTool)) {
      setIsBrushing(true);
      applyBrush(coords.mapX, coords.mapY);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPan({ x: e.clientX - startPan.x, y: e.clientY - startPan.y });
      return;
    }

    const coords = screenToMap(e.clientX, e.clientY);
    if (coords) {
      const idx = coords.mapY * mapData.width + coords.mapX;
      const elev = mapData.elevation[idx];
      const isLand = elev > mapData.config.seaLevel;
      const elevMeters = isLand
        ? Math.round(((elev - mapData.config.seaLevel) / (1 - mapData.config.seaLevel)) * 4800)
        : -Math.round(((mapData.config.seaLevel - elev) / mapData.config.seaLevel) * 3500);

      const biomeDef = BIOMES[mapData.biomes[idx] as keyof typeof BIOMES] || BIOMES[0];
      const st = mapData.soilType ? mapData.soilType[idx] : 3;
      const rockDef = ROCK_SOIL_DEFINITIONS[st] || ROCK_SOIL_DEFINITIONS[3];

      setCursorInfo({
        mapX: coords.mapX,
        mapY: coords.mapY,
        elevationMeters: elevMeters,
        elevationNorm: elev,
        temperatureC: Math.round(mapData.temperature[idx] * 10) / 10,
        moisturePct: Math.round(mapData.moisture[idx] * 100),
        riverFlux: Math.round(mapData.riverFlux[idx]),
        biomeName: biomeDef.name,
        biomeColor: biomeDef.colorSatellite,
        rockSoilName: rockDef.name,
        isWater: !isLand,
      });

      if (isBrushing && ['sculpt', 'climate', 'river'].includes(settings.activeTool)) {
        applyBrush(coords.mapX, coords.mapY);
      }

      if (sliceStart && (settings.activeTool === 'profile' || settings.activeTool === 'ruler')) {
        setSliceEnd({ x: coords.mapX, y: coords.mapY });
      }
    } else {
      setCursorInfo(null);
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
    setIsBrushing(false);

    if (sliceStart && sliceEnd && settings.activeTool === 'profile') {
      const samples: ElevationProfileSample[] = [];
      const numSamples = 100;
      const { width, height, elevation, temperature, moisture, riverFlux, biomes, config } = mapData;

      for (let i = 0; i <= numSamples; i++) {
        const t = i / numSamples;
        const sx = Math.round(sliceStart.x * (1 - t) + sliceEnd.x * t);
        const sy = Math.round(sliceStart.y * (1 - t) + sliceEnd.y * t);
        const clampedX = Math.max(0, Math.min(width - 1, sx));
        const clampedY = Math.max(0, Math.min(height - 1, sy));
        const idx = clampedY * width + clampedX;

        const h = elevation[idx];
        const biomeDef = BIOMES[biomes[idx] as keyof typeof BIOMES] || BIOMES[0];

        samples.push({
          distance: Math.round(t * 100),
          x: clampedX,
          y: clampedY,
          elevation: h,
          temperature: temperature[idx],
          moisture: moisture[idx],
          riverFlux: riverFlux[idx],
          biomeName: biomeDef.name,
          biomeColor: biomeDef.colorSatellite,
          isWater: h <= config.seaLevel,
        });
      }

      onOpenProfileModal(samples);
      setSliceStart(null);
      setSliceEnd(null);
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    const newZoom = Math.max(0.3, Math.min(8.0, zoom * zoomFactor));

    const newPanX = mouseX - (mouseX - pan.x) * (newZoom / zoom);
    const newPanY = mouseY - (mouseY - pan.y) * (newZoom / zoom);

    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  };

  useEffect(() => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (sliceStart && sliceEnd) {
      const p1x = pan.x + sliceStart.x * zoom;
      const p1y = pan.y + sliceStart.y * zoom;
      const p2x = pan.x + sliceEnd.x * zoom;
      const p2y = pan.y + sliceEnd.y * zoom;

      ctx.save();
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);

      ctx.beginPath();
      ctx.moveTo(p1x, p1y);
      ctx.lineTo(p2x, p2y);
      ctx.stroke();

      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(p1x, p1y, 5, 0, Math.PI * 2);
      ctx.arc(p2x, p2y, 5, 0, Math.PI * 2);
      ctx.fill();

      const distPixels = Math.hypot(sliceEnd.x - sliceStart.x, sliceEnd.y - sliceStart.y);
      const leagues = Math.round(distPixels * 0.4);
      const miles = Math.round(leagues * 3.0);

      ctx.font = 'bold 12px Cinzel, serif';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#000000';
      ctx.shadowBlur = 4;
      ctx.fillText(`${leagues} Leagues (${miles} miles)`, (p1x + p2x) / 2 + 10, (p1y + p2y) / 2 - 10);

      ctx.restore();
    }
  }, [sliceStart, sliceEnd, pan, zoom]);

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
      className="relative w-full h-[calc(100vh-4rem)] bg-slate-950 overflow-hidden cursor-crosshair select-none"
    >
      <div
        className="absolute transition-transform duration-75 origin-top-left"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        <canvas
          ref={canvasRef}
          width={Math.min(2048, mapData.width)}
          height={Math.min(2048, mapData.height)}
          style={{
            width: `${mapData.width}px`,
            height: `${mapData.height}px`,
          }}
          className="shadow-2xl shadow-black rounded"
        />
      </div>

      <canvas
        ref={overlayCanvasRef}
        width={window.innerWidth}
        height={window.innerHeight}
        className="absolute inset-0 pointer-events-none z-10"
      />

      {/* Cursor Topographic HUD Inspector */}
      {cursorInfo && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-slate-900/90 backdrop-blur-md border border-amber-900/50 rounded-xl px-4 py-2 shadow-2xl flex items-center gap-4 text-xs font-medium text-slate-200 pointer-events-none">
          {/* Biome Tag */}
          <div className="flex items-center gap-1.5">
            <span
              className="w-3 h-3 rounded-full border border-slate-700 shrink-0"
              style={{ backgroundColor: cursorInfo.biomeColor }}
            />
            <span className="font-cinzel font-bold text-amber-200">{cursorInfo.biomeName}</span>
          </div>

          <div className="h-4 w-px bg-slate-800" />

          {/* Geological Rock Layer */}
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Strata:</span>
            <span className="font-medium text-amber-300 font-mono text-[11px]">
              {cursorInfo.rockSoilName}
            </span>
          </div>

          <div className="h-4 w-px bg-slate-800" />

          {/* Elevation */}
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Alt:</span>
            <span className={`font-mono ${cursorInfo.isWater ? 'text-sky-300' : 'text-emerald-300'}`}>
              {cursorInfo.elevationMeters >= 0
                ? `+${cursorInfo.elevationMeters} m`
                : `${cursorInfo.elevationMeters} m`}
            </span>
          </div>

          <div className="h-4 w-px bg-slate-800" />

          {/* Temperature */}
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Temp:</span>
            <span
              className={`font-mono ${
                cursorInfo.temperatureC < 0
                  ? 'text-cyan-300'
                  : cursorInfo.temperatureC > 28
                  ? 'text-rose-400'
                  : 'text-amber-300'
              }`}
            >
              {cursorInfo.temperatureC > 0
                ? `+${cursorInfo.temperatureC} °C`
                : `${cursorInfo.temperatureC} °C`}
            </span>
          </div>

          <div className="h-4 w-px bg-slate-800" />

          {/* Moisture */}
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Rain:</span>
            <span className="text-blue-300 font-mono">{cursorInfo.moisturePct}%</span>
          </div>

          {/* River Flux if present */}
          {cursorInfo.riverFlux > 10 && (
            <>
              <div className="h-4 w-px bg-slate-800" />
              <div className="flex items-center gap-1">
                <span className="text-slate-400">Flow:</span>
                <span className="text-cyan-300 font-mono">{cursorInfo.riverFlux} m³/s</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Zoom / Reset Navigation Widget */}
      <div className="absolute bottom-6 right-6 z-20 flex flex-col gap-1 bg-slate-900/90 backdrop-blur-md border border-slate-800 rounded-lg p-1 shadow-lg text-xs font-mono text-slate-300">
        <button
          onClick={() => setZoom((z) => Math.min(8.0, z * 1.3))}
          className="w-8 h-8 rounded hover:bg-slate-800 flex items-center justify-center font-bold text-amber-300 cursor-pointer"
        >
          +
        </button>
        <span className="text-[10px] text-center text-slate-400">{Math.round(zoom * 100)}%</span>
        <button
          onClick={() => setZoom((z) => Math.max(0.3, z / 1.3))}
          className="w-8 h-8 rounded hover:bg-slate-800 flex items-center justify-center font-bold text-amber-300 cursor-pointer"
        >
          -
        </button>
        <button
          onClick={() => {
            setZoom(1.0);
            if (containerRef.current) {
              const rect = containerRef.current.getBoundingClientRect();
              setPan({
                x: (rect.width - mapData.width) / 2,
                y: (rect.height - mapData.height) / 2,
              });
            }
          }}
          title="Reset Zoom & Pan"
          className="w-8 h-8 rounded hover:bg-slate-800 flex items-center justify-center text-[10px] text-amber-400 cursor-pointer"
        >
          1:1
        </button>
      </div>
    </div>
  );
};

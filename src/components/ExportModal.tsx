/**
 * Export dialog: PNG layers, heightmaps and project files.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { AnalysisLayer, WorldV2 } from '../types/worldV2';
import type { CubedSphereGrid } from '../geometry/cubedSphere';
import type { ProjectionType } from '../projections/types';
import { getProjection, PROJECTION_LIST } from '../projections';
import { rasterizeHeightmap, rasterizeProjectedLayer } from '../projections/rasterizer';
import { deserializeWorldV2, serializeWorldV2 } from '../storage/bundleV2';
import { WorldStore } from '../storage/worldStore';

interface ExportModalProps {
  currentLayer: AnalysisLayer;
  currentProjection: ProjectionType;
  selectedMonth: number;
  isOpen: boolean;
  onClose: () => void;
  onImportWorld: (world: WorldV2, grid: CubedSphereGrid) => void;
}

type ExportType = 'visual_layer' | 'heightmap';
type HeightmapMode = 'normalized' | 'sea_level_centered' | 'raw_land_only';

interface ResolutionOption {
  width: number;
  height: number;
  label: string;
}

const ExportModalContent: React.FC<{
  world: WorldV2 | null;
  grid: CubedSphereGrid | null;
  initialLayer: AnalysisLayer;
  initialProjection: ProjectionType;
  selectedMonth: number;
  onClose: () => void;
  onImportWorld: (world: WorldV2, grid: CubedSphereGrid) => void;
}> = ({
  world,
  grid,
  initialLayer,
  initialProjection,
  selectedMonth,
  onClose,
  onImportWorld,
}) => {
  const [selectedProjection, setSelectedProjection] = useState<ProjectionType>(initialProjection);
  const [exportLayer, setExportLayer] = useState<AnalysisLayer>(initialLayer);
  const [exportType, setExportType] = useState<ExportType>('visual_layer');
  const [heightmapMode, setHeightmapMode] = useState<HeightmapMode>('normalized');
  const [selectedWidth, setSelectedWidth] = useState<number>(2048);
  const [includeHillshade, setIncludeHillshade] = useState<boolean>(true);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [importError, setImportError] = useState<string | null>(null);

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const projDef = getProjection(selectedProjection);

  // Compute resolutions based on current projection
  const getResolutionOptions = (): ResolutionOption[] => {
    const aspect = projDef.aspectRatio;
    return [
      { width: 1024, height: Math.round(1024 / aspect), label: '1K (Standard)' },
      { width: 2048, height: Math.round(2048 / aspect), label: '2K (HD)' },
      { width: 4096, height: Math.round(4096 / aspect), label: '4K (Ultra HD)' },
      { width: 8192, height: Math.round(8192 / aspect), label: '8K (Print Poster)' },
      { width: 16384, height: Math.round(16384 / aspect), label: '16K (Large Format)' },
    ];
  };

  const resolutions = getResolutionOptions();
  const currentHeight = Math.round(selectedWidth / projDef.aspectRatio);

  // Render live preview thumbnail
  useEffect(() => {
    if (!world || !grid || !previewCanvasRef.current) return;

    const previewW = 320;
    const previewH = Math.max(120, Math.round(previewW / projDef.aspectRatio));

    const canvas = previewCanvasRef.current;
    canvas.width = previewW;
    canvas.height = previewH;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let imgData: ImageData;
    if (exportType === 'visual_layer') {
      imgData = rasterizeProjectedLayer(world, grid, {
        width: previewW,
        height: previewH,
        layer: exportLayer,
        projection: selectedProjection,
        selectedMonth,
        showHillshade: includeHillshade,
      });
    } else {
      imgData = rasterizeHeightmap(world, grid, {
        width: previewW,
        height: previewH,
        projection: selectedProjection,
        mode: heightmapMode,
      });
    }

    ctx.putImageData(imgData, 0, 0);
  }, [world, grid, selectedProjection, exportLayer, exportType, heightmapMode, selectedMonth, includeHillshade, projDef.aspectRatio]);

  // Handle PNG Image Export
  const handleExportPNG = async () => {
    if (!world || !grid) return;
    setIsExporting(true);

    try {
      // Yield to UI thread before heavy rasterization
      await new Promise((resolve) => setTimeout(resolve, 50));

      const w = selectedWidth;
      const h = currentHeight;

      const offscreen = document.createElement('canvas');
      offscreen.width = w;
      offscreen.height = h;
      const ctx = offscreen.getContext('2d');
      if (!ctx) return;

      let imgData: ImageData;
      if (exportType === 'visual_layer') {
        imgData = rasterizeProjectedLayer(world, grid, {
          width: w,
          height: h,
          layer: exportLayer,
          projection: selectedProjection,
          selectedMonth,
          showHillshade: includeHillshade,
        });
      } else {
        imgData = rasterizeHeightmap(world, grid, {
          width: w,
          height: h,
          projection: selectedProjection,
          mode: heightmapMode,
        });
      }

      ctx.putImageData(imgData, 0, 0);

      const filename =
        exportType === 'visual_layer'
          ? `map_${selectedProjection}_${exportLayer}_${w}x${h}.png`
          : `heightmap_${selectedProjection}_${heightmapMode}_${w}x${h}.png`;

      const dataUrl = offscreen.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      a.click();
    } finally {
      setIsExporting(false);
    }
  };

  // Export Binary V2 Bundle (.world2)
  const handleExportBundle = () => {
    if (!world) return;
    const buffer = serializeWorldV2(world);
    const blob = new Blob([buffer.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `planet_seed_${world.seed}.world2`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Import Binary V2 Bundle
  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setImportError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);
      const { world: importedWorld, grid: importedGrid } = deserializeWorldV2(uint8);
      onImportWorld(importedWorld, importedGrid);
      onClose();
    } catch (err: any) {
      setImportError(err?.message || 'Failed to import world bundle');
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-2xl w-full p-6 text-slate-100 flex flex-col gap-5 my-auto max-h-[95vh] overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">🗺️</span>
          <div>
            <h2 className="text-lg font-bold text-cyan-400">
              Map Export & World Archiving
            </h2>
            <p className="text-xs text-slate-400">
              Export Mercator, Equal Earth, or Equirectangular maps and heightmaps up to 16K.
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm transition cursor-pointer"
        >
          ✕ Close
        </button>
      </div>

      {importError && (
        <div className="bg-red-500/20 border border-red-500 text-red-200 text-xs p-3 rounded-lg flex items-start gap-2">
          <span className="text-base">⚠️</span>
          <span>{importError}</span>
        </div>
      )}

      {/* Section 1: Projected Map Export */}
      <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-cyan-300 uppercase tracking-wider">
            1. Projected Raster Export (PNG)
          </span>
          <span className="text-[11px] text-slate-400 font-mono">
            Output: {selectedWidth} × {currentHeight} px
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          {/* Options Left Column */}
          <div className="flex flex-col gap-3">
            {/* Projection Selector */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-300">Map Projection:</label>
              <div className="grid grid-cols-3 gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
                {PROJECTION_LIST.map((proj) => (
                  <button
                    key={proj.id}
                    onClick={() => setSelectedProjection(proj.id)}
                    className={`py-1 px-2 rounded text-xs font-semibold transition truncate cursor-pointer ${
                      selectedProjection === proj.id
                        ? 'bg-cyan-500 text-slate-950 shadow'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {proj.shortName}
                  </button>
                ))}
              </div>
            </div>

            {/* Export Mode (Visual Layer vs Heightmap) */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-300">Export Format:</label>
              <div className="grid grid-cols-2 gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
                <button
                  onClick={() => setExportType('visual_layer')}
                  className={`py-1 px-2 rounded text-xs font-semibold transition cursor-pointer ${
                    exportType === 'visual_layer'
                      ? 'bg-cyan-500/20 border border-cyan-500 text-cyan-200'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Visual Thematic Map
                </button>
                <button
                  onClick={() => setExportType('heightmap')}
                  className={`py-1 px-2 rounded text-xs font-semibold transition cursor-pointer ${
                    exportType === 'heightmap'
                      ? 'bg-cyan-500/20 border border-cyan-500 text-cyan-200'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Grayscale Heightmap
                </button>
              </div>
            </div>

            {/* Conditional Options */}
            {exportType === 'visual_layer' ? (
              <>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-slate-300">Thematic Layer:</label>
                  <select
                    value={exportLayer}
                    onChange={(e) => setExportLayer(e.target.value as AnalysisLayer)}
                    className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-lg p-2 focus:ring-1 focus:ring-cyan-500 outline-none cursor-pointer"
                  >
                    <option value="elevation">Topography & Relief</option>
                    <option value="biomes">Ecoclimatic Biomes</option>
                    <option value="discharge">River Discharge & Streams</option>
                    <option value="lakes">Lakes & Water Bodies</option>
                    <option value="drainage_basins">Drainage Basins</option>
                    <option value="plate_boundaries">Plate Boundaries</option>
                    <option value="continental_material">Continental Material Thickness</option>
                    <option value="crust_type">Crust Lithology</option>
                    <option value="crust_age">Crust Age (Myr)</option>
                    <option value="tectonic_uplift">Tectonic Uplift Rate</option>
                    <option value="temperature_monthly">Monthly Temperature</option>
                    <option value="precipitation_monthly">Monthly Precipitation</option>
                    <option value="ice_thickness">Glaciers & Polar Sea Ice</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="exportHillshade"
                    checked={includeHillshade}
                    onChange={(e) => setIncludeHillshade(e.target.checked)}
                    className="rounded bg-slate-800 border-slate-700 text-cyan-500 focus:ring-cyan-500 cursor-pointer"
                  />
                  <label htmlFor="exportHillshade" className="text-xs text-slate-300 cursor-pointer select-none">
                    Include 3D Shaded Relief / Hillshade
                  </label>
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-300">Heightmap Encoding:</label>
                <select
                  value={heightmapMode}
                  onChange={(e) => setHeightmapMode(e.target.value as HeightmapMode)}
                  className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-lg p-2 focus:ring-1 focus:ring-cyan-500 outline-none cursor-pointer"
                >
                  <option value="normalized">Full Planetary Span (0..255 Trench to Peak)</option>
                  <option value="sea_level_centered">Sea-Level Centered (128 Datum, Land &gt; 128)</option>
                  <option value="raw_land_only">Land Mask Only (Ocean 0, Land 1..255)</option>
                </select>
              </div>
            )}

            {/* Resolution Options */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-300">Export Resolution:</label>
              <div className="grid grid-cols-2 gap-1.5">
                {resolutions.map((res) => (
                  <button
                    key={res.width}
                    onClick={() => setSelectedWidth(res.width)}
                    className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition flex flex-col items-start cursor-pointer ${
                      selectedWidth === res.width
                        ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span className="font-bold">{res.label}</span>
                    <span className="text-[10px] text-slate-500 font-mono">{res.width} × {res.height}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Live Preview Right Column */}
          <div className="flex flex-col items-center justify-center gap-2 bg-slate-900/60 p-3 rounded-xl border border-slate-800 h-full min-h-[220px]">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              Live Projected Preview
            </div>
            <div className="w-full flex items-center justify-center overflow-hidden bg-slate-950 rounded-lg p-1 border border-slate-800/80">
              <canvas
                ref={previewCanvasRef}
                className="max-w-full max-h-48 object-contain rounded shadow"
              />
            </div>
            <span className="text-[10px] text-slate-500 font-mono text-center">
              {projDef.name} • {projDef.description}
            </span>
          </div>
        </div>

        <button
          onClick={handleExportPNG}
          disabled={!world || isExporting}
          className="w-full py-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:opacity-50 text-white font-bold rounded-xl text-xs transition flex items-center justify-center gap-2 shadow-lg cursor-pointer"
        >
          {isExporting ? (
            <>
              <span className="animate-spin text-sm">⏳</span>
              <span>Rendering {selectedWidth}×{currentHeight} PNG...</span>
            </>
          ) : (
            <>
              <span>📥</span>
              <span>Download High-Resolution PNG ({selectedWidth} × {currentHeight})</span>
            </>
          )}
        </button>
      </div>

      {/* Section 2: Complete V2 Binary Bundle */}
      <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 flex flex-col gap-3">
        <div className="text-xs font-bold text-slate-300 uppercase tracking-wider">
          2. Binary WorldV2 Project Archive (.world2)
        </div>
        <div className="text-xs text-slate-400">
          Lossless binary bundle containing all 3D spherical mesh arrays, 12-month climate fields, and tectonic plates.
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={handleExportBundle}
            disabled={!world}
            className="py-2 px-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-lg text-xs transition flex items-center justify-center gap-2 shadow cursor-pointer"
          >
            <span>📦</span> Save Binary Bundle (.world2)
          </button>
          <label className="py-2 px-4 bg-slate-800 hover:bg-slate-700 text-cyan-300 font-semibold rounded-lg text-xs transition flex items-center justify-center gap-2 border border-slate-700 cursor-pointer text-center">
            <span>📂</span> Load Existing World (.world2)
            <input
              type="file"
              accept=".world2,application/octet-stream"
              onChange={handleFileImport}
              className="hidden"
            />
          </label>
        </div>
      </div>
    </div>
  );
};

export const ExportModal: React.FC<ExportModalProps> = (props) => {
  if (!props.isOpen) return null;
  const world = WorldStore.getWorld();
  const grid = WorldStore.getGrid();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <ExportModalContent
        world={world}
        grid={grid}
        initialLayer={props.currentLayer}
        initialProjection={props.currentProjection}
        selectedMonth={props.selectedMonth}
        onClose={props.onClose}
        onImportWorld={props.onImportWorld}
      />
    </div>
  );
};

/**
 * Picker for the active render layer.
 */
import React from 'react';
import {
  Map,
  Eye,
  Thermometer,
  CloudRain,
  GitBranch,
  Layers,
  Compass,
  Sliders,
  Mountain,
} from 'lucide-react';
import type { RenderMode, ToolSettings } from '../types/map';

interface LayerSelectorProps {
  settings: ToolSettings;
  onUpdateSettings: (partial: Partial<ToolSettings>) => void;
}

export const LayerSelector: React.FC<LayerSelectorProps> = ({
  settings,
  onUpdateSettings,
}) => {
  const MODES: { id: RenderMode; label: string; icon: React.ReactNode; desc: string }[] = [
    {
      id: 'hillshade',
      label: 'Swiss Shaded Relief (Pure Hillshade)',
      icon: <Mountain className="w-4 h-4 text-amber-300" />,
      desc: 'Multidirectional shaded relief with crisp ridges, valleys, and bathymetry',
    },
    {
      id: 'parchment',
      label: 'Fantasy Parchment',
      icon: <Map className="w-4 h-4 text-amber-400" />,
      desc: 'Hand-drawn antique cartography style with mountain & tree stamps',
    },
    {
      id: 'satellite',
      label: 'Satellite Biomes',
      icon: <Eye className="w-4 h-4 text-emerald-400" />,
      desc: 'Realistic shaded relief earth view with biome gradients',
    },
    {
      id: 'hypsometric',
      label: 'Hypsometric Contours',
      icon: <Layers className="w-4 h-4 text-cyan-400" />,
      desc: 'Topographic elevation bands with contour lines',
    },
    {
      id: 'temperature',
      label: 'Temperature Heatmap',
      icon: <Thermometer className="w-4 h-4 text-rose-400" />,
      desc: 'Isothermal heatmap showing temperature lapse rate & climate zones',
    },
    {
      id: 'moisture',
      label: 'Rainfall & Winds',
      icon: <CloudRain className="w-4 h-4 text-sky-400" />,
      desc: 'Orographic precipitation, rain shadows, and prevailing wind belts',
    },
    {
      id: 'basins',
      label: 'Watershed Basins',
      icon: <GitBranch className="w-4 h-4 text-purple-400" />,
      desc: 'Color-coded river drainage catchment basins',
    },
    {
      id: 'geology',
      label: 'Rock & Soil Lithology',
      icon: <Layers className="w-4 h-4 text-amber-500" />,
      desc: 'Bedrock, basalt, sedimentary strata, loam soil, scree, and till',
    },
    {
      id: 'tectonics',
      label: 'Tectonic Crusts',
      icon: <Sliders className="w-4 h-4 text-orange-400" />,
      desc: 'Crustal plates, drift vectors, and boundary stresses',
    },
    {
      id: 'debug',
      label: '🔬 Diagnostic Suite (4-in-1)',
      icon: <Layers className="w-4 h-4 text-pink-400" />,
      desc: '4-quadrant live inspection: Shaded Relief, Raw Heightmap, Tectonics, 3D Normals',
    },
  ];

  return (
    <div className="absolute top-20 right-4 z-20 w-64 bg-slate-900/90 backdrop-blur-md border border-amber-900/40 rounded-xl shadow-2xl p-3 flex flex-col gap-3 select-none text-xs">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <span className="font-cinzel font-bold text-amber-300 tracking-wider">MAP VIEW MODES</span>
        <span className="text-[10px] text-slate-500 font-mono">RENDER</span>
      </div>

      {/* View Mode Buttons */}
      <div className="grid grid-cols-1 gap-1">
        {MODES.map((mode) => {
          const isSelected = settings.renderMode === mode.id;
          return (
            <button
              key={mode.id}
              onClick={() => onUpdateSettings({ renderMode: mode.id })}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-all cursor-pointer ${
                isSelected
                  ? 'bg-amber-600/30 text-amber-200 border border-amber-500/50 shadow-sm font-semibold'
                  : 'text-slate-300 hover:bg-slate-800/60 hover:text-slate-100'
              }`}
            >
              <div className="shrink-0">{mode.icon}</div>
              <div className="flex flex-col truncate">
                <span className="truncate">{mode.label}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Overlay Toggles */}
      <div className="border-t border-slate-800 pt-2 flex flex-col gap-1.5">
        <span className="font-cinzel text-[11px] font-bold text-slate-400">OVERLAYS</span>

        <label className="flex items-center justify-between text-slate-300 hover:text-slate-100 cursor-pointer py-0.5">
          <span className="flex items-center gap-1.5">
            <span className="text-sky-400 font-mono">~</span> River Networks
          </span>
          <input
            type="checkbox"
            checked={settings.showRivers}
            onChange={(e) => onUpdateSettings({ showRivers: e.target.checked })}
            className="rounded border-slate-700 text-amber-500 focus:ring-0 cursor-pointer"
          />
        </label>

        <label className="flex items-center justify-between text-slate-300 hover:text-slate-100 cursor-pointer py-0.5">
          <span className="flex items-center gap-1.5">
            <span className="text-purple-400 font-mono">📍</span> Landmarks & POIs
          </span>
          <input
            type="checkbox"
            checked={settings.showPOIs}
            onChange={(e) => onUpdateSettings({ showPOIs: e.target.checked })}
            className="rounded border-slate-700 text-amber-500 focus:ring-0 cursor-pointer"
          />
        </label>

        <label className="flex items-center justify-between text-slate-300 hover:text-slate-100 cursor-pointer py-0.5">
          <span className="flex items-center gap-1.5">
            <span className="text-cyan-400 font-mono">☵</span> Contour Lines
          </span>
          <input
            type="checkbox"
            checked={settings.showContours}
            onChange={(e) => onUpdateSettings({ showContours: e.target.checked })}
            className="rounded border-slate-700 text-amber-500 focus:ring-0 cursor-pointer"
          />
        </label>

        <label className="flex items-center justify-between text-slate-300 hover:text-slate-100 cursor-pointer py-0.5">
          <span className="flex items-center gap-1.5">
            <Compass className="w-3.5 h-3.5 text-amber-400" /> Compass & Scale
          </span>
          <input
            type="checkbox"
            checked={settings.showCompass}
            onChange={(e) => onUpdateSettings({ showCompass: e.target.checked })}
            className="rounded border-slate-700 text-amber-500 focus:ring-0 cursor-pointer"
          />
        </label>

        <label className="flex items-center justify-between text-slate-300 hover:text-slate-100 cursor-pointer py-0.5">
          <span className="flex items-center gap-1.5">
            <span className="text-emerald-400 font-mono">💨</span> Wind Vectors
          </span>
          <input
            type="checkbox"
            checked={settings.showWindVectors}
            onChange={(e) => onUpdateSettings({ showWindVectors: e.target.checked })}
            className="rounded border-slate-700 text-amber-500 focus:ring-0 cursor-pointer"
          />
        </label>
      </div>
    </div>
  );
};

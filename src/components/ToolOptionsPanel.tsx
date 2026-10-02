/**
 * Options for the active tool: brush radius and strength, climate painter, erosion lab, ruler and landmark types.
 */
import React from 'react';
import {
  Sliders,
  Droplet,
  CloudRain,
  RotateCw,
  Mountain,
  Waves,
  Wind,
  Snowflake,
  Activity,
} from 'lucide-react';
import type { ToolSettings, SculptMode, ClimateBrushMode, RiverBrushMode, POICategory } from '../types/map';

interface ToolOptionsPanelProps {
  settings: ToolSettings;
  onUpdateSettings: (partial: Partial<ToolSettings>) => void;
  onRunLiveErosion: (dropletCount: number) => void;
  onApplyThermalWeathering: () => void;
  onRunOceanWaveErosion?: () => void;
  onRunWindErosion?: () => void;
  onRunGlacialCarving?: () => void;
  onRunComprehensiveErosion?: () => void;
  onRecomputeHydrology: () => void;
  isSimulating: boolean;
}

export const ToolOptionsPanel: React.FC<ToolOptionsPanelProps> = ({
  settings,
  onUpdateSettings,
  onRunLiveErosion,
  onApplyThermalWeathering,
  onRunOceanWaveErosion,
  onRunWindErosion,
  onRunGlacialCarving,
  onRunComprehensiveErosion,
  onRecomputeHydrology,
  isSimulating,
}) => {
  const { activeTool } = settings;

  return (
    <div className="absolute bottom-6 left-20 z-20 bg-slate-900/90 backdrop-blur-md border border-amber-900/40 rounded-2xl p-4 shadow-2xl w-72 flex flex-col gap-3.5 select-none animate-in fade-in slide-in-from-bottom-2 duration-150 text-xs">
      {/* Title */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-amber-400" />
          <span className="font-cinzel font-bold text-amber-200 uppercase tracking-wider text-[11px]">
            {activeTool.toUpperCase()} TOOLBENCH
          </span>
        </div>
      </div>

      {/* BRUSH SIZES & STRENGTH (Shared by Sculpt, Climate, River) */}
      {['sculpt', 'climate', 'river'].includes(activeTool) && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Brush Radius</span>
            <span className="text-amber-300 font-mono">{settings.brushSize} px</span>
          </div>
          <input
            type="range"
            min="4"
            max="48"
            value={settings.brushSize}
            onChange={(e) => onUpdateSettings({ brushSize: parseInt(e.target.value) || 16 })}
            className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
          />

          <div className="flex items-center justify-between mt-1">
            <span className="text-slate-400">Brush Strength</span>
            <span className="text-amber-300 font-mono">{Math.round(settings.brushStrength * 100)}%</span>
          </div>
          <input
            type="range"
            min="0.05"
            max="1.0"
            step="0.05"
            value={settings.brushStrength}
            onChange={(e) => onUpdateSettings({ brushStrength: parseFloat(e.target.value) || 0.3 })}
            className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
          />
        </div>
      )}

      {/* SCULPT MODES */}
      {activeTool === 'sculpt' && (
        <div className="flex flex-col gap-1.5">
          <span className="font-cinzel text-slate-400 font-bold text-[10px]">SCULPT MODE</span>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              { id: 'raise', label: '▲ Raise Land' },
              { id: 'lower', label: '▼ Lower Sea' },
              { id: 'mountain', label: '🏔 Mountain Peak' },
              { id: 'volcano', label: '🌋 Volcano Cone' },
              { id: 'terrace', label: '🧱 Mesa / Terrace' },
              { id: 'island', label: '🏝 Island Stamp' },
              { id: 'flatten', label: '▬ Flatten Plateau' },
              { id: 'smooth', label: '〰 Smooth Terrain' },
              { id: 'canyon', label: '⚡ Canyon / Rift' },
              { id: 'ridge', label: '⛰ Ridge Line' },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => onUpdateSettings({ sculptMode: m.id as SculptMode })}
                className={`px-2 py-1.5 rounded-lg text-left transition-all cursor-pointer font-medium ${
                  settings.sculptMode === m.id
                    ? 'bg-amber-600/30 text-amber-200 border border-amber-500/50 shadow-sm'
                    : 'text-slate-300 hover:bg-slate-800/60'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* CLIMATE MODES */}
      {activeTool === 'climate' && (
        <div className="flex flex-col gap-1.5">
          <span className="font-cinzel text-slate-400 font-bold text-[10px]">CLIMATE PAINTER</span>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              { id: 'heat', label: '🔥 Heat Up (+Temp)' },
              { id: 'cool', label: '❄️ Cool Down (-Temp)' },
              { id: 'rain', label: '🌧 Add Rainfall' },
              { id: 'dry', label: '☀️ Arid / Drought' },
              { id: 'glacier', label: '🏔 Glacier Ice' },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => onUpdateSettings({ climateMode: m.id as ClimateBrushMode })}
                className={`px-2 py-1.5 rounded-lg text-left transition-all cursor-pointer font-medium ${
                  settings.climateMode === m.id
                    ? 'bg-amber-600/30 text-amber-200 border border-amber-500/50 shadow-sm'
                    : 'text-slate-300 hover:bg-slate-800/60'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* MULTI-PHYSICS EROSION LABORATORY */}
      {activeTool === 'erosion' && (
        <div className="flex flex-col gap-2">
          <span className="font-cinzel text-slate-400 font-bold text-[10px]">MULTI-PHYSICS EROSION LAB</span>

          {/* Master 5-Erosion Runner */}
          <button
            onClick={onRunComprehensiveErosion}
            disabled={isSimulating}
            className="w-full py-2 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-amber-50 font-cinzel font-bold rounded-lg shadow-lg flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <Activity className="w-4 h-4 text-amber-200" />
            <span>Simulate All 5 Erosions</span>
          </button>

          {/* Fluvial Droplets */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => onRunLiveErosion(10000)}
              disabled={isSimulating}
              className="px-2 py-1.5 bg-sky-950/80 hover:bg-sky-900 border border-sky-600/40 text-sky-200 rounded-lg font-medium transition-all flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
            >
              <Droplet className="w-3.5 h-3.5 text-sky-400" />
              <span>10k Fluvial</span>
            </button>

            <button
              onClick={() => onRunLiveErosion(30000)}
              disabled={isSimulating}
              className="px-2 py-1.5 bg-blue-950/80 hover:bg-blue-900 border border-blue-600/40 text-blue-200 rounded-lg font-medium transition-all flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
            >
              <CloudRain className="w-3.5 h-3.5 text-blue-400" />
              <span>30k Fluvial</span>
            </button>
          </div>

          {/* Wave & Wind */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onRunOceanWaveErosion}
              disabled={isSimulating}
              className="px-2 py-1.5 bg-teal-950/80 hover:bg-teal-900 border border-teal-600/40 text-teal-200 rounded-lg font-medium transition-all flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
            >
              <Waves className="w-3.5 h-3.5 text-teal-400" />
              <span>Ocean Waves</span>
            </button>

            <button
              onClick={onRunWindErosion}
              disabled={isSimulating}
              className="px-2 py-1.5 bg-yellow-950/80 hover:bg-yellow-900 border border-yellow-600/40 text-yellow-200 rounded-lg font-medium transition-all flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
            >
              <Wind className="w-3.5 h-3.5 text-yellow-400" />
              <span>Aeolian Wind</span>
            </button>
          </div>

          {/* Glacial & Gravity */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onRunGlacialCarving}
              disabled={isSimulating}
              className="px-2 py-1.5 bg-cyan-950/80 hover:bg-cyan-900 border border-cyan-600/40 text-cyan-200 rounded-lg font-medium transition-all flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
            >
              <Snowflake className="w-3.5 h-3.5 text-cyan-400" />
              <span>Glacial Carve</span>
            </button>

            <button
              onClick={onApplyThermalWeathering}
              disabled={isSimulating}
              className="px-2 py-1.5 bg-amber-950/80 hover:bg-amber-900 border border-amber-600/40 text-amber-200 rounded-lg font-medium transition-all flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
            >
              <Mountain className="w-3.5 h-3.5 text-amber-400" />
              <span>Gravity Talus</span>
            </button>
          </div>
        </div>
      )}

      {/* RIVER & HYDROLOGY MODES */}
      {activeTool === 'river' && (
        <div className="flex flex-col gap-2">
          <span className="font-cinzel text-slate-400 font-bold text-[10px]">WATERWAY TOOL</span>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              { id: 'spring', label: '💧 Mountain Spring' },
              { id: 'dig_channel', label: '⛏ Dig Riverbed' },
              { id: 'fill_lake', label: '🌊 Fill Lake' },
              { id: 'remove_water', label: '🚫 Drain Water' },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => onUpdateSettings({ riverMode: m.id as RiverBrushMode })}
                className={`px-2 py-1.5 rounded-lg text-left transition-all cursor-pointer font-medium ${
                  settings.riverMode === m.id
                    ? 'bg-amber-600/30 text-amber-200 border border-amber-500/50 shadow-sm'
                    : 'text-slate-300 hover:bg-slate-800/60'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <button
            onClick={onRecomputeHydrology}
            disabled={isSimulating}
            className="w-full py-1.5 mt-1 bg-cyan-950/70 hover:bg-cyan-900 border border-cyan-500/40 text-cyan-200 rounded-lg font-medium transition-all flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span>Recalculate River Flow</span>
          </button>
        </div>
      )}

      {/* POI & LANDMARK PLACER */}
      {activeTool === 'poi' && (
        <div className="flex flex-col gap-1.5">
          <span className="font-cinzel text-slate-400 font-bold text-[10px]">SELECT LANDMARK TYPE</span>
          <p className="text-[10px] text-slate-400">Click anywhere on the map to place this landmark.</p>
          <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto pr-1">
            {[
              { id: 'capital', label: '👑 Imperial Capital' },
              { id: 'castle', label: '🏰 Stronghold' },
              { id: 'town', label: '🏘 Walled Town' },
              { id: 'port', label: '⚓ Merchant Port' },
              { id: 'tower', label: '🔮 Wizard Spire' },
              { id: 'ruins', label: '🏛 Ancient Ruins' },
              { id: 'dragon', label: '🐉 Dragon Lair' },
              { id: 'cave', label: '🦇 Grotto Cave' },
              { id: 'mine', label: '⛏ Dwarven Mine' },
              { id: 'shrine', label: '✨ Sacred Shrine' },
            ].map((p) => (
              <button
                key={p.id}
                onClick={() => onUpdateSettings({ selectedPOICategory: p.id as POICategory })}
                className={`px-2 py-1.5 rounded-lg text-left transition-all cursor-pointer font-medium truncate ${
                  settings.selectedPOICategory === p.id
                    ? 'bg-amber-600/30 text-amber-200 border border-amber-500/50 shadow-sm'
                    : 'text-slate-300 hover:bg-slate-800/60'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* PROFILE TOOL HELP */}
      {activeTool === 'profile' && (
        <div className="flex flex-col gap-1.5">
          <span className="font-cinzel text-slate-400 font-bold text-[10px]">TOPOGRAPHIC SLICE</span>
          <p className="text-[11px] text-slate-300">
            Click and drag across the map to generate an instant 2D topographical cross-section elevation & climate slice analyzer.
          </p>
        </div>
      )}

      {/* RULER TOOL HELP */}
      {activeTool === 'ruler' && (
        <div className="flex flex-col gap-1.5">
          <span className="font-cinzel text-slate-400 font-bold text-[10px]">CARTOGRAPHIC RULER</span>
          <p className="text-[11px] text-slate-300">
            Click and drag across any two landmarks or realm borders to measure distance in fantasy leagues and statute miles.
          </p>
        </div>
      )}
    </div>
  );
};

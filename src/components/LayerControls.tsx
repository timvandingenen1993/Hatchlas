/**
 * Layer panel: projection, seasonal month, crust and boundary overlays, and the profile and diagnostics buttons.
 */
import React from 'react';
import type { AnalysisLayer } from '../types/worldV2';
import type { ProjectionType } from '../projections/types';
import { PROJECTION_LIST } from '../projections';
import { BIOME_DEFINITIONS } from '../utils/colorRamps';

interface LayerControlsProps {
  currentLayer: AnalysisLayer;
  onSelectLayer: (layer: AnalysisLayer) => void;
  currentProjection: ProjectionType;
  onSelectProjection: (proj: ProjectionType) => void;
  selectedMonth: number; // 0 to 11
  onSelectMonth: (month: number) => void;
  showHillshade: boolean;
  onToggleHillshade: () => void;
  onOpenProfile: () => void;
  onOpenDiagnostics: () => void;
  hasProfilePoints: boolean;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const LAYERS: { id: AnalysisLayer; label: string; icon: string }[] = [
  { id: 'continental_material', label: 'Continental Material (Thickness)', icon: 'CM' },
  { id: 'plate_ids', label: 'Plate Ownership (IDs)', icon: '🎨' },
  { id: 'ownership_closure', label: 'Ownership Closure (Blue/White/Red)', icon: '⚖️' },
  { id: 'dominance_confidence', label: 'Dominance Confidence (Max %)', icon: '🎯' },
  { id: 'plate_boundaries', label: 'Kinematic Boundaries', icon: '🌋' },
  { id: 'relative_velocity', label: 'Relative Velocity (V_n)', icon: '💨' },
  { id: 'crust_type', label: 'Crust Lithology', icon: '🪨' },
  { id: 'crust_age', label: 'Oceanic Age (Myr)', icon: '⏳' },
  { id: 'elevation', label: 'Topography (Stage 5 Inactive)', icon: '🏔️' },
  { id: 'tectonic_uplift', label: 'Deformation Uplift (Stage 4)', icon: '⬆️' },
];

const TECTONIC_LAYER_IDS = new Set<AnalysisLayer>([
  'continental_material',
  'plate_ids',
  'ownership_closure',
  'dominance_confidence',
  'plate_boundaries',
  'relative_velocity',
  'crust_type',
  'crust_age',
]);



export const LayerControls: React.FC<LayerControlsProps> = ({
  currentLayer,
  onSelectLayer,
  currentProjection,
  onSelectProjection,
  selectedMonth,
  onSelectMonth,
  showHillshade,
  onToggleHillshade,
  onOpenProfile,
  onOpenDiagnostics,
  hasProfilePoints,
}) => {
  const isSeasonal = currentLayer === 'temperature_monthly' || currentLayer === 'precipitation_monthly';

  return (
    <div className="flex flex-col gap-3 bg-slate-900/90 backdrop-blur border border-slate-800 rounded-xl p-3 shadow-xl text-slate-200">
      {/* Top action bar */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2">
        <div className="text-xs font-bold text-cyan-400 uppercase tracking-wider">
          Tectonic World
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onToggleHillshade}
            title="Toggle 3D Shaded Relief"
            className={`px-2 py-1 text-xs rounded border transition flex items-center gap-1 ${
              showHillshade
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                : 'bg-slate-800 border-slate-700 text-slate-400'
            }`}
          >
            <span>☀️</span> Relief
          </button>
          <button
            onClick={onOpenProfile}
            title="Open Cross-Section Profile Tool"
            className={`px-2 py-1 text-xs rounded border transition flex items-center gap-1 ${
              hasProfilePoints
                ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                : 'bg-slate-800 border-slate-700 text-slate-400'
            }`}
          >
            <span>📈</span> Profile
          </button>
          <button
            onClick={onOpenDiagnostics}
            title="View Simulation Diagnostics"
            className="px-2 py-1 text-xs rounded border bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300 transition flex items-center gap-1"
          >
            <span>🔬</span> Stats
          </button>
        </div>
      </div>

      {/* Projection Selector Tabs */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Map Projection</span>
        <div className="grid grid-cols-3 gap-1 bg-slate-950/80 p-1 rounded-lg border border-slate-800">
          {PROJECTION_LIST.map((proj) => {
            const isSelected = currentProjection === proj.id;
            return (
              <button
                key={proj.id}
                onClick={() => onSelectProjection(proj.id)}
                title={proj.description}
                className={`py-1 px-1.5 rounded text-[11px] font-semibold transition truncate ${
                  isSelected
                    ? 'bg-cyan-500 text-slate-950 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                {proj.shortName}
              </button>
            );
          })}
        </div>
      </div>

      {/* Layer selector grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
        {LAYERS.filter((layer) => TECTONIC_LAYER_IDS.has(layer.id)).map((layer) => {
          const isActive = currentLayer === layer.id;
          return (
            <button
              key={layer.id}
              onClick={() => onSelectLayer(layer.id)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium text-left flex items-center gap-1.5 transition border ${
                isActive
                  ? 'bg-cyan-500/20 border-cyan-500 text-cyan-200 shadow-sm'
                  : 'bg-slate-950/60 border-slate-800 hover:bg-slate-800 text-slate-300'
              }`}
            >
              <span>{layer.icon}</span>
              <span className="truncate">{layer.label}</span>
            </button>
          );
        })}
      </div>

      {/* 12-Month Seasonal Slider */}
      {isSeasonal && (
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Seasonal Month</span>
            <span className="font-bold text-amber-400">{MONTH_NAMES[selectedMonth]} (Month {selectedMonth + 1})</span>
          </div>
          <input
            type="range"
            min="0"
            max="11"
            step="1"
            value={selectedMonth}
            onChange={(e) => onSelectMonth(parseInt(e.target.value))}
            className="w-full accent-amber-400 cursor-pointer h-1.5 bg-slate-800 rounded-lg appearance-none"
          />
          <div className="flex justify-between text-[10px] text-slate-500 px-1">
            <span>Jan</span>
            <span>Apr</span>
            <span>Jul</span>
            <span>Oct</span>
            <span>Dec</span>
          </div>
        </div>
      )}

      {/* Dynamic Legend */}
      <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800 text-[11px] flex flex-col gap-1">
        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
          Legend: {LAYERS.find((l) => l.id === currentLayer)?.label}
        </div>
        {currentLayer === 'elevation' && (
          <div className="flex flex-col gap-1">
            <div className="h-2.5 rounded w-full bg-gradient-to-r from-[#081840] via-[#3cb0c3] via-[#73b450] via-[#cda04b] via-[#916950] to-[#ffffff]" />
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>-9,000 m (Trench)</span>
              <span>0 m (Sea)</span>
              <span>+8,500 m (Peak)</span>
            </div>
          </div>
        )}
        {currentLayer === 'temperature_monthly' && (
          <div className="flex flex-col gap-1">
            <div className="h-2.5 rounded w-full bg-gradient-to-r from-[#313695] via-[#abd9e9] via-[#fee090] via-[#f46d43] to-[#a50026]" />
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>-40 °C</span>
              <span>0 °C (Freezing)</span>
              <span>+45 °C</span>
            </div>
          </div>
        )}
        {currentLayer === 'precipitation_monthly' && (
          <div className="flex flex-col gap-1">
            <div className="h-2.5 rounded w-full bg-gradient-to-r from-[#fef0d9] via-[#fc8d59] via-[#66c2a4] to-[#0868ac]" />
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>0 mm/mo (Arid)</span>
              <span>150 mm</span>
              <span>450+ mm (Rainforest)</span>
            </div>
          </div>
        )}
        {currentLayer === 'continental_material' && (
          <div className="flex flex-col gap-1">
            <div className="h-2.5 rounded w-full bg-gradient-to-r from-[#122a58] via-[#a47742] to-[#f0bc22]" />
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>0 km</span>
              <span>35 km reference</span>
              <span>70+ km thickened</span>
            </div>
          </div>
        )}
        {currentLayer === 'crust_age' && (
          <div className="flex flex-col gap-1">
            <div className="h-2.5 rounded w-full bg-gradient-to-r from-[#ef4444] via-[#eab308] via-[#06b6d4] to-[#9333ea]" />
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>0 Myr (Spreading)</span>
              <span>110 Myr</span>
              <span>250+ Myr (Old)</span>
            </div>
          </div>
        )}
        {currentLayer === 'biomes' && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 max-h-24 overflow-y-auto pr-1">
            {Object.values(BIOME_DEFINITIONS).map((bm) => (
              <div key={bm.id} className="flex items-center gap-1.5 text-[10px]">
                <span
                  className="w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ backgroundColor: `rgb(${bm.color.r}, ${bm.color.g}, ${bm.color.b})` }}
                />
                <span className="truncate text-slate-300">{bm.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

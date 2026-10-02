/**
 * App header: seed and generate controls, generation parameters and export.
 */
import React from 'react';
import {
  Compass,
  Sparkles,
  RefreshCw,
  Sliders,
  Download,
} from 'lucide-react';
import type { LandmassPreset, WorldGenConfig } from '../types/map';

interface HeaderProps {
  config: WorldGenConfig;
  title: string;
  isGenerating: boolean;
  generationStep: string;
  generationProgress: number;
  onUpdateConfig: (partial: Partial<WorldGenConfig>) => void;
  onGenerateNewWorld: () => void;
  onOpenSettings: () => void;
  onOpenExport: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  config,
  title,
  isGenerating,
  generationStep,
  generationProgress,
  onUpdateConfig,
  onGenerateNewWorld,
  onOpenSettings,
  onOpenExport,
}) => {
  const PRESETS: { id: LandmassPreset; label: string; icon: string }[] = [
    { id: 'continents', label: 'Continents', icon: '🌍' },
    { id: 'pangaea', label: 'Pangaea', icon: '🪐' },
    { id: 'archipelago', label: 'Archipelago', icon: '🏝️' },
    { id: 'shattered', label: 'Shattered', icon: '☄️' },
    { id: 'mediterranean', label: 'Inland Sea', icon: '🌊' },
    { id: 'ring', label: 'Ring World', icon: '⭕' },
    { id: 'fjords', label: 'Glacial Fjords', icon: '🏔️' },
    { id: 'volcanic_isles', label: 'Volcanic Arc', icon: '🌋' },
  ];

  return (
    <header className="h-16 bg-slate-900/90 backdrop-blur-md border-b border-amber-900/30 px-4 flex items-center justify-between z-30 shadow-xl select-none">
      {/* Title & Realm Name */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-500 to-amber-800 p-0.5 shadow-lg shadow-amber-900/40 flex items-center justify-center">
          <div className="w-full h-full bg-slate-950 rounded-[7px] flex items-center justify-center">
            <Compass className="w-5 h-5 text-amber-400 animate-pulse" />
          </div>
        </div>
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h1 className="font-cinzel font-bold text-lg text-amber-200 tracking-wider fantasy-glow-amber leading-none">
              Hatchlas
            </h1>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-mono border border-amber-500/30">
              WORLD ENGINE
            </span>
          </div>
          <span className="text-xs text-slate-400 font-serif italic truncate max-w-[200px] md:max-w-xs">
            {title || 'Unknown Lands'}
          </span>
        </div>
      </div>

      {/* Generation Progress Indicator if active */}
      {isGenerating && (
        <div className="hidden md:flex items-center gap-3 bg-slate-950/80 border border-amber-500/40 px-4 py-1.5 rounded-full shadow-inner animate-pulse">
          <RefreshCw className="w-4 h-4 text-amber-400 animate-spin" />
          <div className="flex flex-col">
            <span className="text-xs font-medium text-amber-200">{generationStep}</span>
            <div className="w-48 bg-slate-800 h-1.5 rounded-full overflow-hidden mt-0.5">
              <div
                className="bg-gradient-to-r from-amber-500 to-amber-300 h-full transition-all duration-200"
                style={{ width: `${Math.round(generationProgress * 100)}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Preset & Seed Controls */}
      <div className="flex items-center gap-2">
        {/* Landmass Preset Selector */}
        <div className="hidden lg:flex items-center bg-slate-950/70 border border-slate-800 rounded-lg p-1">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                onUpdateConfig({ preset: p.id });
                onGenerateNewWorld();
              }}
              disabled={isGenerating}
              className={`px-2.5 py-1 text-xs rounded-md transition-all flex items-center gap-1.5 font-medium cursor-pointer ${
                config.preset === p.id
                  ? 'bg-amber-600/30 text-amber-200 border border-amber-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <span>{p.icon}</span>
              <span>{p.label}</span>
            </button>
          ))}
        </div>

        {/* Seed Input & Randomize */}
        <div className="hidden sm:flex items-center bg-slate-950/70 border border-slate-800 rounded-lg px-2.5 py-1 gap-2">
          <span className="text-xs text-slate-500 font-mono">SEED</span>
          <input
            type="number"
            value={config.seed}
            onChange={(e) => onUpdateConfig({ seed: parseInt(e.target.value) || 0 })}
            className="w-20 bg-transparent text-xs text-amber-300 font-mono focus:outline-none text-center"
          />
          <button
            onClick={() => {
              const newSeed = Math.floor(Math.random() * 1000000);
              onUpdateConfig({ seed: newSeed });
              onGenerateNewWorld();
            }}
            disabled={isGenerating}
            title="Randomize Seed & Generate"
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-amber-300 transition-colors cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Generate World Button */}
        <button
          onClick={onGenerateNewWorld}
          disabled={isGenerating}
          className="bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-amber-50 font-cinzel font-bold text-xs px-3.5 py-2 rounded-lg shadow-lg shadow-amber-950/60 border border-amber-500/40 flex items-center gap-1.5 transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isGenerating ? 'animate-spin' : ''}`} />
          <span>GENERATE</span>
        </button>

        {/* World Gen Parameters Wizard */}
        <button
          onClick={onOpenSettings}
          title="World Generation Parameters & Physics Settings"
          className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 text-slate-300 hover:text-amber-300 transition-colors cursor-pointer"
        >
          <Sliders className="w-4 h-4" />
        </button>

        {/* Export Modal Trigger */}
        <button
          onClick={onOpenExport}
          title="Export Map PNG, Heightmap, or Project JSON"
          className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 text-slate-300 hover:text-amber-300 transition-colors cursor-pointer"
        >
          <Download className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};

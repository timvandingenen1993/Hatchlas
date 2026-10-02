/**
 * Side panel with the world-generation parameters: seed, grid, plates, crust and ocean volume.
 */
import React from 'react';
import type { ResolutionMode, SimulationConfig } from '../types/config';
import type { ProgressMessage } from '../types/workerMessages';

interface ControlPanelProps {
  config: SimulationConfig;
  onChangeConfig: (newConfig: SimulationConfig) => void;
  isSimulating: boolean;
  progress: ProgressMessage | null;
  onGenerate: () => void;
  onCancel: () => void;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  config,
  onChangeConfig,
  isSimulating,
  progress,
  onGenerate,
  onCancel,
}) => {
  const updateField = <K extends keyof SimulationConfig>(key: K, value: SimulationConfig[K]) => {
    onChangeConfig({ ...config, [key]: value });
  };

  return (
    <div className="flex flex-col gap-4 bg-slate-900/90 backdrop-blur border border-slate-800 rounded-xl p-4 shadow-xl text-slate-200">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <h2 className="text-sm font-bold text-cyan-400 uppercase tracking-wider">Plate Tectonics</h2>
        <span className="text-[11px] font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
          Tectonics only
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-semibold text-slate-300 flex justify-between">
          <span>World Grid</span>
          <span className="text-cyan-400 font-mono">6 × {config.faceResolution}²</span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {([96, 192, 256, 384, 512] as ResolutionMode[]).map((resolution) => (
            <button
              key={resolution}
              disabled={isSimulating}
              onClick={() => updateField('faceResolution', resolution)}
              className={`py-1 text-xs font-semibold rounded-lg border transition ${
                config.faceResolution === resolution
                  ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300'
                  : 'bg-slate-950 border-slate-800 hover:bg-slate-800 text-slate-400'
              }`}
            >
              N={resolution}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-slate-300">Deterministic Seed</div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            disabled={isSimulating}
            value={config.seed}
            onChange={(event) => updateField('seed', Number.parseInt(event.target.value) || 1)}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs font-mono text-cyan-300 focus:outline-none focus:border-cyan-500"
          />
          <button
            disabled={isSimulating}
            onClick={() => updateField('seed', Math.floor(Math.random() * 999_999) + 1)}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition shrink-0"
          >
            Random
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-4 bg-slate-950/60 p-3 rounded-lg border border-slate-800/80">
        <label className="flex flex-col gap-1">
          <span className="flex justify-between text-xs text-slate-300">
            <span>Initial Continental Crust</span>
            <span className="font-mono text-cyan-300">{(config.continentalFraction * 100).toFixed(0)}%</span>
          </span>
          <input
            type="range"
            min="0.15"
            max="0.60"
            step="0.05"
            disabled={isSimulating}
            value={config.continentalFraction}
            onChange={(event) => updateField('continentalFraction', Number.parseFloat(event.target.value))}
            className="w-full accent-cyan-400 cursor-pointer h-1 bg-slate-800 rounded appearance-none"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="flex justify-between text-xs text-slate-300">
            <span>Rigid Plates</span>
            <span className="font-mono text-cyan-300">{config.plateCount}</span>
          </span>
          <input
            type="range"
            min="6"
            max="24"
            step="1"
            disabled={isSimulating}
            value={config.plateCount}
            onChange={(event) => updateField('plateCount', Number.parseInt(event.target.value))}
            className="w-full accent-cyan-400 cursor-pointer h-1 bg-slate-800 rounded appearance-none"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="flex justify-between text-xs text-slate-300">
            <span>Kinematic Interval</span>
            <span className="font-mono text-cyan-300">{config.tectonicEvolutionMyr} Myr</span>
          </span>
          <input
            type="range"
            min="5"
            max="75"
            step="5"
            disabled={isSimulating}
            value={config.tectonicEvolutionMyr}
            onChange={(event) => updateField('tectonicEvolutionMyr', Number.parseInt(event.target.value))}
            className="w-full accent-cyan-400 cursor-pointer h-1 bg-slate-800 rounded appearance-none"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="flex justify-between text-xs text-slate-300">
            <span>Ocean Water Volume</span>
            <span className="font-mono text-cyan-300">{config.oceanVolumeMultiplier.toFixed(2)}× Earth</span>
          </span>
          <input
            type="range"
            min="0.60"
            max="1.40"
            step="0.05"
            disabled={isSimulating}
            value={config.oceanVolumeMultiplier}
            onChange={(event) => updateField('oceanVolumeMultiplier', Number.parseFloat(event.target.value))}
            className="w-full accent-cyan-400 cursor-pointer h-1 bg-slate-800 rounded appearance-none"
          />
        </label>
      </div>

      {isSimulating && progress && (
        <div className="flex flex-col gap-2 bg-slate-950 p-3 rounded-lg border border-cyan-500/30">
          <div className="flex justify-between text-xs font-semibold text-cyan-300">
            <span>{progress.stageName}</span>
            <span>{(progress.overallProgress * 100).toFixed(0)}%</span>
          </div>
          <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
            <div
              className="bg-gradient-to-r from-cyan-500 to-emerald-400 h-full transition-all duration-300"
              style={{ width: `${Math.max(5, progress.overallProgress * 100)}%` }}
            />
          </div>
        </div>
      )}

      {isSimulating ? (
        <button
          onClick={onCancel}
          className="w-full py-2.5 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl text-xs transition shadow-lg"
        >
          Cancel Tectonics
        </button>
      ) : (
        <button
          onClick={onGenerate}
          className="w-full py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold rounded-xl text-xs transition shadow-lg"
        >
          Generate Tectonic World
        </button>
      )}
    </div>
  );
};

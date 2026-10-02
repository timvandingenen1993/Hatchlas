/**
 * Dialog for choosing world-generation presets and parameters.
 */
import React from 'react';
import { X, Sliders, RotateCcw, Sparkles } from 'lucide-react';
import { DEFAULT_CONFIG } from '../core/worldGenerator';
import type { WorldGenConfig, LandmassPreset } from '../types/map';

interface WorldGenModalProps {
  isOpen: boolean;
  config: WorldGenConfig;
  onUpdateConfig: (partial: Partial<WorldGenConfig>) => void;
  onGenerate: () => void;
  onClose: () => void;
  isGenerating: boolean;
}

export const WorldGenModal: React.FC<WorldGenModalProps> = ({
  isOpen,
  config,
  onUpdateConfig,
  onGenerate,
  onClose,
  isGenerating,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 select-none animate-in fade-in duration-150">
      <div className="bg-slate-900 border border-amber-900/50 rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <Sliders className="w-5 h-5 text-amber-400" />
            <h2 className="font-cinzel font-bold text-amber-200 tracking-wider text-sm">
              WORLD SIMULATION & GEOPHYSICS PARAMETERS
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Sliders Body */}
        <div className="p-6 overflow-y-auto flex flex-col gap-5 text-xs">
          {/* Section 1: Dimensions & Landmass */}
          <div className="flex flex-col gap-3">
            <span className="font-cinzel font-bold text-amber-400 text-xs border-b border-slate-800 pb-1">
              1. TECTONICS & GEOLOGICAL LANDMASS
            </span>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Landmass Preset</span>
                  <span className="text-amber-300 font-mono capitalize">{config.preset}</span>
                </div>
                <select
                  value={config.preset}
                  onChange={(e) => onUpdateConfig({ preset: e.target.value as LandmassPreset })}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-slate-200 focus:outline-none capitalize"
                >
                  <option value="continents">Continents</option>
                  <option value="pangaea">Pangaea</option>
                  <option value="archipelago">Archipelago</option>
                  <option value="shattered">Shattered Realm</option>
                  <option value="mediterranean">Inland Sea (Mediterranean)</option>
                  <option value="ring">Ring World</option>
                  <option value="fjords">Glacial Fjords</option>
                  <option value="volcanic_isles">Volcanic Island Arc</option>
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Map Dimensions</span>
                  <span className="text-amber-300 font-mono">{config.width} × {config.height}</span>
                </div>
                <select
                  value={config.width}
                  onChange={(e) => {
                    const sz = parseInt(e.target.value) || 512;
                    onUpdateConfig({ width: sz, height: sz });
                  }}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-slate-200 focus:outline-none"
                >
                  <option value={256}>256 × 256 (Ultra Fast)</option>
                  <option value={512}>512 × 512 (Recommended)</option>
                  <option value={1024}>1024 × 1024 (High Detail - 1MP)</option>
                  <option value={2048}>2048 × 2048 (Extreme Detail - 4.2MP)</option>
                  <option value={4096}>4096 × 4096 (Cinematic Master - 16.8MP)</option>
                  <option value={8192}>8192 × 8192 (Colossal Ultra - 67.1MP)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mt-1">
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Tectonic Plates</span>
                  <span className="text-amber-300 font-mono">{config.plateCount}</span>
                </div>
                <input
                  type="range"
                  min="4"
                  max="20"
                  value={config.plateCount}
                  onChange={(e) => onUpdateConfig({ plateCount: parseInt(e.target.value) || 10 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Volcanic Mantle Hotspots</span>
                  <span className="text-orange-400 font-mono">{config.hotspotCount ?? 4}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="8"
                  value={config.hotspotCount ?? 4}
                  onChange={(e) => onUpdateConfig({ hotspotCount: parseInt(e.target.value) || 0 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mt-1">
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Sea Level</span>
                  <span className="text-amber-300 font-mono">{Math.round(config.seaLevel * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.20"
                  max="0.55"
                  step="0.01"
                  value={config.seaLevel}
                  onChange={(e) => onUpdateConfig({ seaLevel: parseFloat(e.target.value) || 0.38 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Mountain Orogenic Roughness</span>
                  <span className="text-amber-300 font-mono">{config.mountainRoughness.toFixed(2)}×</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={config.mountainRoughness}
                  onChange={(e) => onUpdateConfig({ mountainRoughness: parseFloat(e.target.value) || 1.1 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mt-1">
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Geological Terracing / Mesas</span>
                  <span className="text-emerald-300 font-mono">{Math.round((config.geologicalTerracing ?? 0.25) * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.0"
                  step="0.05"
                  value={config.geologicalTerracing ?? 0.25}
                  onChange={(e) => onUpdateConfig({ geologicalTerracing: parseFloat(e.target.value) || 0 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Continental Shelf Ledge</span>
                  <span className="text-sky-300 font-mono">{Math.round((config.continentalShelfWidth ?? 0.06) * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.01"
                  max="0.15"
                  step="0.01"
                  value={config.continentalShelfWidth ?? 0.06}
                  onChange={(e) => onUpdateConfig({ continentalShelfWidth: parseFloat(e.target.value) || 0.06 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* Section 2: Thermodynamics & Climate */}
          <div className="flex flex-col gap-3">
            <span className="font-cinzel font-bold text-amber-400 text-xs border-b border-slate-800 pb-1">
              2. THERMODYNAMICS & CLIMATE
            </span>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Equator Temperature</span>
                  <span className="text-rose-300 font-mono">+{config.equatorTemp}°C</span>
                </div>
                <input
                  type="range"
                  min="18"
                  max="45"
                  value={config.equatorTemp}
                  onChange={(e) => onUpdateConfig({ equatorTemp: parseFloat(e.target.value) || 32 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Pole Temperature</span>
                  <span className="text-cyan-300 font-mono">{config.poleTemp}°C</span>
                </div>
                <input
                  type="range"
                  min="-45"
                  max="-5"
                  value={config.poleTemp}
                  onChange={(e) => onUpdateConfig({ poleTemp: parseFloat(e.target.value) || -24 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mt-1">
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Elevation Lapse Rate</span>
                  <span className="text-amber-300 font-mono">-{config.lapseRate}°C/km</span>
                </div>
                <input
                  type="range"
                  min="3.0"
                  max="9.5"
                  step="0.5"
                  value={config.lapseRate}
                  onChange={(e) => onUpdateConfig({ lapseRate: parseFloat(e.target.value) || 6.5 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Rainfall Multiplier</span>
                  <span className="text-sky-300 font-mono">{config.rainfallMultiplier.toFixed(1)}×</span>
                </div>
                <input
                  type="range"
                  min="0.3"
                  max="2.5"
                  step="0.1"
                  value={config.rainfallMultiplier}
                  onChange={(e) => onUpdateConfig({ rainfallMultiplier: parseFloat(e.target.value) || 1.2 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* Section 3: Droplet Hydraulic Erosion & Rivers */}
          <div className="flex flex-col gap-3">
            <span className="font-cinzel font-bold text-amber-400 text-xs border-b border-slate-800 pb-1">
              3. HYDRAULIC EROSION & RIVER NETWORKS
            </span>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Erosion Droplets</span>
                  <span className="text-sky-300 font-mono">{(config.erosionDroplets / 1000).toFixed(0)}k</span>
                </div>
                <input
                  type="range"
                  min="5000"
                  max="60000"
                  step="5000"
                  value={config.erosionDroplets}
                  onChange={(e) => onUpdateConfig({ erosionDroplets: parseInt(e.target.value) || 25000 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Droplet Carve Rate</span>
                  <span className="text-amber-300 font-mono">{config.erosionStrength.toFixed(2)}×</span>
                </div>
                <input
                  type="range"
                  min="0.2"
                  max="2.0"
                  step="0.1"
                  value={config.erosionStrength}
                  onChange={(e) => onUpdateConfig({ erosionStrength: parseFloat(e.target.value) || 1.0 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mt-1">
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">River Formation Threshold</span>
                  <span className="text-blue-300 font-mono">{config.riverThreshold.toFixed(0)} flux</span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="80"
                  step="5"
                  value={config.riverThreshold}
                  onChange={(e) => onUpdateConfig({ riverThreshold: parseFloat(e.target.value) || 40 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">Talus Scree Angle</span>
                  <span className="text-amber-300 font-mono">{Math.round(config.talusAngle * 60)}°</span>
                </div>
                <input
                  type="range"
                  min="0.25"
                  max="0.65"
                  step="0.05"
                  value={config.talusAngle}
                  onChange={(e) => onUpdateConfig({ talusAngle: parseFloat(e.target.value) || 0.45 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* Section 4: Multi-Physics Geomorphic Erosion & Glaciation */}
          <div className="flex flex-col gap-3">
            <span className="font-cinzel font-bold text-amber-400 text-xs border-b border-slate-800 pb-1">
              4. MULTI-PHYSICS GEOMORPHIC EROSION & GLACIATION
            </span>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">🌊 Ocean Wave Action & Beach Shoals</span>
                  <span className="text-teal-300 font-mono">{Math.round((config.oceanWaveErosionStrength ?? 0.5) * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="2.0"
                  step="0.1"
                  value={config.oceanWaveErosionStrength ?? 0.5}
                  onChange={(e) => onUpdateConfig({ oceanWaveErosionStrength: parseFloat(e.target.value) || 0 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">❄️ Glacial U-Valley & Buzzsaw Gouge</span>
                  <span className="text-cyan-300 font-mono">{Math.round((config.glacierErosionStrength ?? 0.6) * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="2.0"
                  step="0.1"
                  value={config.glacierErosionStrength ?? 0.6}
                  onChange={(e) => onUpdateConfig({ glacierErosionStrength: parseFloat(e.target.value) || 0 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mt-1">
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">🏞️ Fluvial Stream Power Incision</span>
                  <span className="text-sky-300 font-mono">{Math.round((config.riverErosionStrength ?? 0.8) * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="2.0"
                  step="0.1"
                  value={config.riverErosionStrength ?? 0.8}
                  onChange={(e) => onUpdateConfig({ riverErosionStrength: parseFloat(e.target.value) || 0 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">🧊 Glacial Snowline Threshold</span>
                  <span className="text-cyan-300 font-mono">{config.glacierTempThreshold ?? -2}°C</span>
                </div>
                <input
                  type="range"
                  min="-10"
                  max="4"
                  step="1"
                  value={config.glacierTempThreshold ?? -2}
                  onChange={(e) => onUpdateConfig({ glacierTempThreshold: parseFloat(e.target.value) || -2 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mt-1">
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">🌧️ Rain-Splash & Sheetwash</span>
                  <span className="text-blue-300 font-mono">{Math.round((config.rainSplashErosionStrength ?? 0.4) * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="2.0"
                  step="0.1"
                  value={config.rainSplashErosionStrength ?? 0.4}
                  onChange={(e) => onUpdateConfig({ rainSplashErosionStrength: parseFloat(e.target.value) || 0 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300">💨 Aeolian Wind Abrasion</span>
                  <span className="text-yellow-300 font-mono">{Math.round((config.windErosionStrength ?? 0.3) * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="2.0"
                  step="0.1"
                  value={config.windErosionStrength ?? 0.3}
                  onChange={(e) => onUpdateConfig({ windErosionStrength: parseFloat(e.target.value) || 0 })}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-slate-950/80 border-t border-slate-800 flex items-center justify-between">
          <button
            onClick={() => onUpdateConfig(DEFAULT_CONFIG)}
            className="flex items-center gap-1.5 text-slate-400 hover:text-slate-200 text-xs transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Defaults</span>
          </button>

          <div className="flex items-center gap-2.5">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onClose();
                onGenerate();
              }}
              disabled={isGenerating}
              className="px-5 py-2 rounded-lg bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-amber-50 font-cinzel font-bold text-xs shadow-lg shadow-amber-950/50 flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>APPLY & GENERATE</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

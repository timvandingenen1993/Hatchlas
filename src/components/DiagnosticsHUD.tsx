/**
 * Overlay with simulation diagnostics: stage timings, grid and plate counts, and continental mass conservation.
 */
import React from 'react';
import { WorldStore } from '../storage/worldStore';

interface DiagnosticsHUDProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DiagnosticsHUD: React.FC<DiagnosticsHUDProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;
  const world = WorldStore.getWorld();
  if (!world) return null;

  const { diagnostics, topology } = world;
  const scientific = (value: number | undefined) => (value ?? 0).toExponential(3);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl max-w-2xl w-full p-6 text-slate-100 flex flex-col gap-5">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <h2 className="text-lg font-bold text-cyan-400 flex items-center gap-2">
            <span>🔬</span> Simulation Diagnostics & Planetary Metrics
          </h2>
          <button
            onClick={onClose}
            className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-sm transition"
          >
            ✕ Close
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
            <div className="text-xs text-slate-400">Total Simulation Time</div>
            <div className="text-lg font-bold text-amber-400">
              {(diagnostics.totalExecutionTimeMs / 1000).toFixed(2)} s
            </div>
          </div>
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
            <div className="text-xs text-slate-400">Spherical Grid Cells</div>
            <div className="text-lg font-bold text-cyan-400">
              {topology.totalCells.toLocaleString()}
            </div>
            <div className="text-[10px] text-slate-500">
              6 × {topology.resolution}² (Cubed-Sphere)
            </div>
          </div>
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
            <div className="text-xs text-slate-400">Tectonic Timesteps (CFL)</div>
            <div className="text-lg font-bold text-emerald-400">
              {diagnostics.tectonicSubsteps ?? 0} steps
            </div>
            <div className="text-[10px] text-slate-500">
              Δt = {(diagnostics.tectonicTimeStepMyr ?? 1).toFixed(2)} Myr/step
            </div>
          </div>
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
            <div className="text-xs text-slate-400">Rigid Plates</div>
            <div className="text-lg font-bold text-indigo-400">
              {world.geology.plateCount} plates
            </div>
            <div className="text-[10px] text-slate-500">
              Euler pole kinematics
            </div>
          </div>
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
            <div className="text-xs text-slate-400">Continental Area</div>
            <div className="text-lg font-bold text-amber-300">
              {(diagnostics.continentalFraction * 100).toFixed(1)} %
            </div>
          </div>
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
            <div className="text-xs text-slate-400">Continental Mass Residual</div>
            <div className="text-lg font-bold text-cyan-300 font-mono">
              {scientific(diagnostics.continentalVolumeResidualM3)} m³
            </div>
            <div className="text-[10px] text-slate-500">
              relative {scientific(diagnostics.continentalVolumeRelativeError)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          <div className="bg-slate-950 p-2 rounded border border-slate-800">Initial: <span className="font-mono text-amber-300">{scientific(diagnostics.initialContinentalVolumeM3)} m³</span></div>
          <div className="bg-slate-950 p-2 rounded border border-slate-800">Final: <span className="font-mono text-amber-300">{scientific(diagnostics.finalContinentalVolumeM3)} m³</span></div>
          <div className="bg-slate-950 p-2 rounded border border-slate-800">Transported: <span className="font-mono text-cyan-300">{scientific(diagnostics.continentalTransportedVolumeM3)} m³</span></div>
          <div className="bg-slate-950 p-2 rounded border border-slate-800">Sourced / sunk: <span className="font-mono text-cyan-300">{scientific(diagnostics.continentalSourceVolumeM3)} / {scientific(diagnostics.continentalSinkVolumeM3)} m³</span></div>
          <div className="bg-slate-950 p-2 rounded border border-slate-800">Limited: <span className="font-mono text-cyan-300">{scientific(diagnostics.continentalLimitedVolumeM3)} m³</span></div>
          <div className="bg-slate-950 p-2 rounded border border-slate-800">Corrected: <span className="font-mono text-cyan-300">{scientific(diagnostics.continentalCorrectionVolumeM3)} m³</span></div>
          <div className="bg-slate-950 p-2 rounded border border-slate-800">Target / actual dt: <span className="font-mono text-emerald-300">{(diagnostics.tectonicTargetTimeStepMyr ?? 0).toFixed(3)} / {(diagnostics.tectonicMinimumTimeStepMyr ?? 0).toFixed(3)}–{(diagnostics.tectonicMaximumTimeStepMyr ?? 0).toFixed(3)} Myr</span></div>
          <div className="bg-slate-950 p-2 rounded border border-slate-800">Min spacing: <span className="font-mono text-emerald-300">{((diagnostics.tectonicMinCellDistanceM ?? 0) / 1000).toFixed(1)} km</span></div>
          <div className="bg-slate-950 p-2 rounded border border-slate-800">Max speed: <span className="font-mono text-emerald-300">{((diagnostics.tectonicMaxPlateSpeedMPerMyr ?? 0) / 1e6).toFixed(2)} m/yr</span></div>
        </div>

        <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
          <div className="text-xs font-semibold text-slate-300 mb-2">Stage Execution Breakdown</div>
          <div className="flex flex-col gap-1.5 text-xs">
            {diagnostics.stageTimings.map((st, idx) => (
              <div key={idx} className="flex items-center justify-between py-1 border-b border-slate-900">
                <span className="text-slate-400">{st.stage}</span>
                <span className="font-mono text-cyan-300">
                  {st.durationMs < 1000 ? `${st.durationMs.toFixed(0)} ms` : `${(st.durationMs / 1000).toFixed(2)} s`}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

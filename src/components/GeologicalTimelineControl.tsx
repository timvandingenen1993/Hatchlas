/**
 * Time scrubber for stepping through tectonic history snapshots.
 */
import React, { useEffect, useRef, useState } from 'react';
import { WorldStore } from '../storage/worldStore';
import { Play, Pause, SkipBack, SkipForward, RotateCcw } from 'lucide-react';

interface GeologicalTimelineControlProps {
  worldVersion: number;
  onSnapshotChange: (index: number) => void;
}

export const GeologicalTimelineControl: React.FC<GeologicalTimelineControlProps> = ({
  onSnapshotChange,
}) => {
  const timeline = WorldStore.getTimeline();
  const activeIdx = WorldStore.getActiveSnapshotIndex();
  const activeSnap = WorldStore.getActiveSnapshot();

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [speed, setSpeed] = useState<number>(1.0);
  const [isLooping, setIsLooping] = useState<boolean>(true);
  const playTimerRef = useRef<number | null>(null);

  const totalSnapshots = timeline?.snapshots.length ?? 0;
  const maxIdx = Math.max(0, totalSnapshots - 1);

  // Play/Pause animation timer
  useEffect(() => {
    if (!isPlaying || totalSnapshots <= 1) {
      if (playTimerRef.current !== null) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
      return;
    }

    const intervalMs = Math.round(120 / speed);
    playTimerRef.current = window.setInterval(() => {
      const current = WorldStore.getActiveSnapshotIndex();
      if (current >= maxIdx) {
        if (isLooping) {
          WorldStore.setSnapshotIndex(0);
          onSnapshotChange(0);
        } else {
          setIsPlaying(false);
        }
      } else {
        const next = current + 1;
        WorldStore.setSnapshotIndex(next);
        onSnapshotChange(next);
      }
    }, intervalMs);


    return () => {
      if (playTimerRef.current !== null) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [isPlaying, speed, isLooping, maxIdx, totalSnapshots, onSnapshotChange]);

  if (!timeline || totalSnapshots === 0) return null;

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextIdx = Number.parseInt(e.target.value, 10);
    WorldStore.setSnapshotIndex(nextIdx);
    onSnapshotChange(nextIdx);
  };

  const handleStep = (direction: -1 | 1) => {
    const nextIdx = Math.max(0, Math.min(maxIdx, activeIdx + direction));
    WorldStore.setSnapshotIndex(nextIdx);
    onSnapshotChange(nextIdx);
  };

  const handleReset = () => {
    WorldStore.setSnapshotIndex(0);
    onSnapshotChange(0);
  };

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 w-11/12 max-w-3xl bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-2xl shadow-2xl p-3.5 flex flex-col gap-2.5 text-slate-200 select-none">
      {/* Header with Title and Current Time */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-1.5">
            <span>⏳</span> Geological Time
          </span>
          <span className="bg-slate-800 text-slate-400 font-mono text-[10px] px-2 py-0.5 rounded">
            Stage 1B: Kinematic Motion
          </span>
        </div>

        <div className="flex items-center gap-3 font-mono">
          <span className="text-amber-300 font-bold text-sm">
            {activeSnap ? activeSnap.timeMyr.toFixed(1) : '0.0'} Myr
          </span>
          <span className="text-slate-500 text-[11px]">
            / {timeline.durationMyr.toFixed(1)} Myr (Snap {activeIdx + 1}/{totalSnapshots})
          </span>
        </div>
      </div>

      {/* Scrubber Range Slider */}
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={maxIdx}
          step={1}
          value={activeIdx}
          onChange={handleSliderChange}
          className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400 focus:outline-none"
        />
      </div>

      {/* Control Buttons & Playback Options */}
      <div className="flex items-center justify-between text-xs pt-1">
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleReset}
            title="Reset to 0 Myr"
            className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => handleStep(-1)}
            disabled={activeIdx <= 0}
            title="Step backward (-1 Myr)"
            className="p-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg transition"
          >
            <SkipBack className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className={`px-3 py-1 rounded-lg font-semibold flex items-center gap-1.5 transition ${
              isPlaying
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/50'
                : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 hover:bg-cyan-500/30'
            }`}
          >
            {isPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5" /> Pause
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" /> Play
              </>
            )}
          </button>
          <button
            onClick={() => handleStep(1)}
            disabled={activeIdx >= maxIdx}
            title="Step forward (+1 Myr)"
            className="p-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg transition"
          >
            <SkipForward className="w-3.5 h-3.5" />
          </button>

          {/* Speed Selector */}
          <div className="flex items-center bg-slate-800 rounded-lg p-0.5 ml-2">
            {[0.5, 1.0, 2.0, 5.0].map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`px-1.5 py-0.5 text-[10px] font-mono rounded ${
                  speed === s
                    ? 'bg-cyan-500 text-slate-950 font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {s}x
              </button>
            ))}
          </div>

          <label className="flex items-center gap-1 text-[11px] text-slate-400 ml-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isLooping}
              onChange={(e) => setIsLooping(e.target.checked)}
              className="rounded border-slate-700 text-cyan-500 focus:ring-0 cursor-pointer"
            />
            Loop
          </label>
        </div>

        {/* Live Diagnostics Ticker */}
        {activeSnap && (
          <div className="flex items-center gap-3 font-mono text-[10px] text-slate-400">
            <div>
              Edges: <span className="text-cyan-300 font-semibold">{activeSnap.boundaryEdgeCount}</span>
            </div>
            <div>
              Max V: <span className="text-emerald-300 font-semibold">{activeSnap.maxPlateVelocityMmYr.toFixed(1)} mm/yr</span>
            </div>
            <div>
              {(activeSnap.rawMaxClosureResidual ?? 0) > 1e-10 ? (
                <span className="text-rose-400 font-bold bg-rose-950/80 px-2 py-0.5 rounded border border-rose-800">
                  ⚠️ Raw closure: {(activeSnap.rawMaxClosureResidual ?? 0).toExponential(1)}
                </span>
              ) : (
                <span className="text-emerald-300 font-semibold">
                  ✓ Raw closure: {(activeSnap.rawMaxClosureResidual ?? 0).toExponential(1)}
                </span>
              )}
            </div>
            {(activeSnap.topologyFragmentsRemoved ?? 0) > 0 && (
              <div className="text-amber-300" title="Explicit connected-topology projection during this interval">
                Topology: {activeSnap.topologyFragmentsRemoved} fragments /{' '}
                {((activeSnap.topologyCorrectionAreaM2 ?? 0) / 1e6).toExponential(2)} km²
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

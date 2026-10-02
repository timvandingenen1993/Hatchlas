/**
 * Modal wrapper that charts the elevation profile between two clicked points.
 */
import React from 'react';
import { X, Activity, Mountain, Thermometer, Droplets } from 'lucide-react';
import type { ElevationProfileSample } from '../types/map';

interface ElevationProfileModalProps {
  isOpen: boolean;
  samples: ElevationProfileSample[];
  onClose: () => void;
}

export const ElevationProfileModal: React.FC<ElevationProfileModalProps> = ({
  isOpen,
  samples,
  onClose,
}) => {
  if (!isOpen || samples.length === 0) return null;

  // Compute profile statistics
  let maxElev = -1e9;
  let minElev = 1e9;
  let maxTemp = -1e9;
  let minTemp = 1e9;

  for (const s of samples) {
    if (s.elevation > maxElev) maxElev = s.elevation;
    if (s.elevation < minElev) minElev = s.elevation;
    if (s.temperature > maxTemp) maxTemp = s.temperature;
    if (s.temperature < minTemp) minTemp = s.temperature;
  }

  const svgWidth = 600;
  const svgHeight = 220;
  const padL = 50;
  const padR = 20;
  const padT = 20;
  const padB = 40;
  const chartW = svgWidth - padL - padR;
  const chartH = svgHeight - padT - padB;

  // Build SVG polyline for elevation
  const elevPoints: string[] = [];
  const tempPoints: string[] = [];

  samples.forEach((s, idx) => {
    const x = padL + (idx / (samples.length - 1)) * chartW;
    const y = padT + (1.0 - s.elevation) * chartH;
    elevPoints.push(`${x},${y}`);

    // Map temp [-30, 45] to SVG Y
    const normTemp = Math.max(0, Math.min(1, (s.temperature + 30) / 75));
    const ty = padT + (1.0 - normTemp) * chartH;
    tempPoints.push(`${x},${ty}`);
  });

  const seaLevelY = padT + (1.0 - 0.38) * chartH;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 select-none animate-in fade-in duration-150">
      <div className="bg-slate-900 border border-amber-900/50 rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <Activity className="w-5 h-5 text-amber-400" />
            <h2 className="font-cinzel font-bold text-amber-200 tracking-wider text-sm">
              CROSS-SECTION ELEVATION & CLIMATE PROFILE
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Chart SVG */}
        <div className="p-5 flex flex-col gap-4">
          <div className="bg-slate-950 rounded-xl p-3 border border-slate-800">
            <svg
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="w-full h-auto overflow-visible"
            >
              {/* Background grid lines */}
              {[0.25, 0.5, 0.75, 1.0].map((t) => {
                const gy = padT + (1.0 - t) * chartH;
                return (
                  <g key={t}>
                    <line
                      x1={padL}
                      y1={gy}
                      x2={svgWidth - padR}
                      y2={gy}
                      stroke="rgba(255, 255, 255, 0.08)"
                      strokeDasharray="4 4"
                    />
                    <text
                      x={padL - 6}
                      y={gy + 4}
                      fill="#64748b"
                      fontSize="9"
                      fontFamily="monospace"
                      textAnchor="end"
                    >
                      {Math.round(t * 5000)}m
                    </text>
                  </g>
                );
              })}

              {/* Sea level line */}
              <line
                x1={padL}
                y1={seaLevelY}
                x2={svgWidth - padR}
                y2={seaLevelY}
                stroke="#0284c7"
                strokeWidth="1.5"
                strokeDasharray="5 3"
              />
              <text
                x={svgWidth - padR + 5}
                y={seaLevelY + 3}
                fill="#38bdf8"
                fontSize="9"
                fontFamily="sans-serif"
              >
                Sea Level
              </text>

              {/* Filled Elevation Area */}
              <polygon
                points={`${padL},${padT + chartH} ${elevPoints.join(' ')} ${padL + chartW},${padT + chartH}`}
                fill="url(#elevGrad)"
                opacity="0.75"
              />

              {/* Gradient definition */}
              <defs>
                <linearGradient id="elevGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#e2e8f0" />
                  <stop offset="30%" stopColor="#78716c" />
                  <stop offset="60%" stopColor="#15803d" />
                  <stop offset="100%" stopColor="#0c4a6e" />
                </linearGradient>
              </defs>

              {/* Topography Stroke */}
              <polyline
                points={elevPoints.join(' ')}
                fill="none"
                stroke="#f59e0b"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* Temperature Curve Stroke */}
              <polyline
                points={tempPoints.join(' ')}
                fill="none"
                stroke="#f43f5e"
                strokeWidth="1.5"
                strokeDasharray="3 2"
                opacity="0.85"
              />

              {/* Biome Color Band along bottom */}
              {samples.map((s, idx) => {
                const bw = chartW / samples.length;
                const bx = padL + idx * bw;
                return (
                  <g key={idx}>
                    <rect
                      x={bx}
                      y={svgHeight - 12}
                      width={bw + 0.5}
                      height="8"
                      fill={s.biomeColor}
                    />
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Statistics summary chips */}
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800 flex items-center gap-2.5">
              <Mountain className="w-4 h-4 text-amber-400 shrink-0" />
              <div className="flex flex-col">
                <span className="text-slate-400">Peak Summit</span>
                <span className="text-amber-200 font-mono font-bold">
                  +{Math.round(maxElev * 5000)} m
                </span>
              </div>
            </div>

            <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800 flex items-center gap-2.5">
              <Thermometer className="w-4 h-4 text-rose-400 shrink-0" />
              <div className="flex flex-col">
                <span className="text-slate-400">Temp Range</span>
                <span className="text-rose-200 font-mono font-bold">
                  {Math.round(minTemp)}°C to {Math.round(maxTemp)}°C
                </span>
              </div>
            </div>

            <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800 flex items-center gap-2.5">
              <Droplets className="w-4 h-4 text-sky-400 shrink-0" />
              <div className="flex flex-col">
                <span className="text-slate-400">Samples</span>
                <span className="text-sky-200 font-mono font-bold">
                  {samples.length} sample points
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

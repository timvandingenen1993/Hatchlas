/**
 * Left-hand tool palette (select, sculpt, climate and river brushes, points of interest).
 */
import React from 'react';
import {
  MousePointer,
  Mountain,
  SunMedium,
  Droplets,
  Waves,
  MapPin,
  Activity,
  Ruler,
} from 'lucide-react';
import type { ToolType } from '../types/map';

interface ToolbarProps {
  activeTool: ToolType;
  onChangeTool: (tool: ToolType) => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({ activeTool, onChangeTool }) => {
  const TOOLS: { id: ToolType; label: string; icon: React.ReactNode; tooltip: string }[] = [
    {
      id: 'inspect',
      label: 'Inspect',
      icon: <MousePointer className="w-5 h-5" />,
      tooltip: 'Inspect topography, temperature, rainfall, and biomes under cursor',
    },
    {
      id: 'sculpt',
      label: 'Sculpt',
      icon: <Mountain className="w-5 h-5" />,
      tooltip: 'Sculpt mountains, plateaus, volcanoes, and ocean trenches',
    },
    {
      id: 'climate',
      label: 'Climate',
      icon: <SunMedium className="w-5 h-5" />,
      tooltip: 'Paint microclimates: temperature, rainfall, and glacial ice',
    },
    {
      id: 'erosion',
      label: 'Erode',
      icon: <Droplets className="w-5 h-5" />,
      tooltip: 'Live particle hydraulic droplet erosion and thermal scree weathering',
    },
    {
      id: 'river',
      label: 'Rivers',
      icon: <Waves className="w-5 h-5" />,
      tooltip: 'Place mountain springs, dig river channels, and fill lakes',
    },
    {
      id: 'poi',
      label: 'Landmarks',
      icon: <MapPin className="w-5 h-5" />,
      tooltip: 'Place cities, castles, towers, dragon roosts, and custom fantasy labels',
    },
    {
      id: 'profile',
      label: 'Profile',
      icon: <Activity className="w-5 h-5" />,
      tooltip: 'Draw a cross-section line to analyze 2D elevation and climate profile slice',
    },
    {
      id: 'ruler',
      label: 'Ruler',
      icon: <Ruler className="w-5 h-5" />,
      tooltip: 'Measure travel distances across realms in leagues and miles',
    },
  ];

  return (
    <div className="absolute top-20 left-4 z-20 flex flex-col gap-1.5 bg-slate-900/90 backdrop-blur-md border border-amber-900/40 p-1.5 rounded-xl shadow-2xl select-none">
      {TOOLS.map((tool) => {
        const isActive = activeTool === tool.id;
        return (
          <button
            key={tool.id}
            onClick={() => onChangeTool(tool.id)}
            title={`${tool.label} — ${tool.tooltip}`}
            className={`w-11 h-11 rounded-lg flex items-center justify-center transition-all group relative cursor-pointer ${
              isActive
                ? 'bg-amber-600/30 text-amber-300 border border-amber-500/50 shadow-md shadow-amber-950/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            {tool.icon}
            {/* Tooltip on hover */}
            <div className="absolute left-14 px-2.5 py-1 bg-slate-950 border border-slate-700 text-slate-200 text-xs rounded shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-30 font-medium">
              <span className="text-amber-400 font-cinzel font-bold mr-1">{tool.label}:</span>
              <span>{tool.tooltip}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
};

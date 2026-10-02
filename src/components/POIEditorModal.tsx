/**
 * Dialog for creating and editing points of interest.
 */
import React, { useState } from 'react';
import { X, MapPin, Trash2, Plus, Sparkles } from 'lucide-react';
import { generatePOIName } from '../utils/fantasyNames';
import type { POI, POICategory } from '../types/map';

interface POIEditorModalProps {
  isOpen: boolean;
  pois: POI[];
  selectedPOI: POI | null;
  onClose: () => void;
  onUpdatePOI: (poi: POI) => void;
  onDeletePOI: (id: string) => void;
  onAddPOI: (poi: POI) => void;
}

export const POIEditorModal: React.FC<POIEditorModalProps> = ({
  isOpen,
  pois,
  selectedPOI,
  onClose,
  onUpdatePOI,
  onDeletePOI,
  onAddPOI,
}) => {
  const [activePOI, setActivePOI] = useState<POI | null>(selectedPOI || (pois.length > 0 ? pois[0] : null));

  if (!isOpen) return null;

  const handleAddNewPOI = () => {
    const newPOI: POI = {
      id: `poi-manual-${Date.now()}`,
      name: generatePOIName('castle', Date.now()),
      category: 'castle',
      x: 256,
      y: 256,
      size: 16,
      description: 'A newly charted stronghold in the realm.',
    };
    onAddPOI(newPOI);
    setActivePOI(newPOI);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 select-none animate-in fade-in duration-150">
      <div className="bg-slate-900 border border-amber-900/50 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <MapPin className="w-5 h-5 text-amber-400" />
            <h2 className="font-cinzel font-bold text-amber-200 tracking-wider text-sm">
              FANTASY POINTS OF INTEREST & REALM SETTLEMENTS
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body: List on left, Editor on right */}
        <div className="p-5 flex-1 grid grid-cols-5 gap-4 overflow-hidden text-xs">
          {/* POI List */}
          <div className="col-span-2 flex flex-col gap-2 overflow-y-auto pr-1 border-r border-slate-800">
            <div className="flex items-center justify-between">
              <span className="font-cinzel text-slate-400 font-bold text-[10px]">LANDMARK REGISTRY</span>
              <button
                onClick={handleAddNewPOI}
                title="Add New Landmark"
                className="p-1 bg-amber-600/30 hover:bg-amber-600/50 text-amber-300 rounded border border-amber-500/40 flex items-center gap-1 text-[10px] cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                <span>New</span>
              </button>
            </div>

            {pois.map((poi) => (
              <button
                key={poi.id}
                onClick={() => setActivePOI(poi)}
                className={`p-2.5 rounded-lg text-left transition-all flex items-center justify-between cursor-pointer ${
                  activePOI?.id === poi.id
                    ? 'bg-amber-600/30 text-amber-200 border border-amber-500/50 font-semibold'
                    : 'bg-slate-950/60 text-slate-300 hover:bg-slate-800 border border-slate-800/80'
                }`}
              >
                <div className="flex flex-col truncate">
                  <span className="truncate">{poi.name}</span>
                  <span className="text-[10px] text-slate-500 font-mono capitalize">{poi.category}</span>
                </div>
              </button>
            ))}
          </div>

          {/* POI Details Form */}
          <div className="col-span-3 flex flex-col gap-3 overflow-y-auto pl-1">
            {activePOI ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="font-cinzel text-amber-300 font-bold text-xs">EDIT LANDMARK</span>
                  <button
                    onClick={() => {
                      onDeletePOI(activePOI.id);
                      setActivePOI(pois.find((p) => p.id !== activePOI.id) || null);
                    }}
                    className="p-1 text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 rounded transition-colors cursor-pointer"
                    title="Delete Landmark"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-slate-400">Landmark Name</span>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={activePOI.name}
                      onChange={(e) => {
                        const updated = { ...activePOI, name: e.target.value };
                        setActivePOI(updated);
                        onUpdatePOI(updated);
                      }}
                      className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100 font-cinzel font-bold focus:outline-none focus:border-amber-500"
                    />
                    <button
                      onClick={() => {
                        const newName = generatePOIName(activePOI.category, Date.now());
                        const updated = { ...activePOI, name: newName };
                        setActivePOI(updated);
                        onUpdatePOI(updated);
                      }}
                      title="Randomize Name"
                      className="p-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-amber-300 transition-colors cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-slate-400">Category</span>
                    <select
                      value={activePOI.category}
                      onChange={(e) => {
                        const updated = { ...activePOI, category: e.target.value as POICategory };
                        setActivePOI(updated);
                        onUpdatePOI(updated);
                      }}
                      className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200 capitalize focus:outline-none"
                    >
                      {[
                        'capital', 'castle', 'town', 'village', 'port',
                        'tower', 'ruins', 'dungeon', 'cave', 'mine',
                        'dragon', 'shrine'
                      ].map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <span className="text-slate-400">Subtext / Epithet</span>
                    <input
                      type="text"
                      value={activePOI.subtext || ''}
                      onChange={(e) => {
                        const updated = { ...activePOI, subtext: e.target.value };
                        setActivePOI(updated);
                        onUpdatePOI(updated);
                      }}
                      placeholder="e.g. Imperial Seat"
                      className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-slate-400">Lore & Description</span>
                  <textarea
                    rows={3}
                    value={activePOI.description || ''}
                    onChange={(e) => {
                      const updated = { ...activePOI, description: e.target.value };
                      setActivePOI(updated);
                      onUpdatePOI(updated);
                    }}
                    placeholder="Historical lore of this citadel or natural landmark..."
                    className="bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none"
                  />
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-slate-500">
                <span>Select a landmark or click the map with the Landmark tool to create one.</span>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-slate-950/80 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-amber-50 font-cinzel font-bold text-xs transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * "Get map" dialog: pick a box on a world map and load real 30 m terrain for
 * it, downloaded and stitched entirely in the browser. Loaded lazily so the
 * map libraries stay out of the main bundle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import {
  assembleGlobalDem,
  bboxError,
  DEM_SOURCES,
  encodeGlobalDemGeoTiff,
  globalDemToHeightmap,
  planGlobalDem,
  terrariumTileLoader,
  type BBox,
  type DemSourceId,
} from "../terrain/globalDem";
import type { HeightmapRaster } from "../terrain/mountainBaseDEM";
import GlobalDemExtentMap from "./GlobalDemExtentMap";
import { InspectorNote, InspectorSelect, InspectorToggle } from "./InspectorParts";

const STORAGE_KEY = "hatchlas.globalDem";
const MONT_BLANC: BBox = { west: 6.75, south: 45.75, east: 7.05, north: 45.98 };
const SPACING_OPTIONS = [
  [30, "30 m (finest)"], [60, "60 m"], [120, "120 m"], [250, "250 m"], [500, "500 m"], [1000, "1 km"],
] as const;
const SOURCE_OPTIONS = Object.values(DEM_SOURCES).map((source) => [source.id, source.label] as const);

interface StoredChoice { bbox: BBox; sourceId: DemSourceId; spacingM: number; saveGeoTiff: boolean }

/** The last box and options are a per-browser convenience; any failure falls back to defaults. */
function readStoredChoice(): StoredChoice {
  const fallback: StoredChoice = { bbox: MONT_BLANC, sourceId: "mapterhorn", spacingM: 30, saveGeoTiff: false };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<StoredChoice> | null;
    if (!stored) return fallback;
    return {
      bbox: stored.bbox && !bboxError(stored.bbox) ? stored.bbox : fallback.bbox,
      sourceId: stored.sourceId && stored.sourceId in DEM_SOURCES ? stored.sourceId : fallback.sourceId,
      spacingM: SPACING_OPTIONS.some(([value]) => value === stored.spacingM) ? stored.spacingM! : fallback.spacingM,
      saveGeoTiff: stored.saveGeoTiff === true,
    };
  } catch {
    return fallback;
  }
}

const formatCoordinate = (value: number, positive: string, negative: string) =>
  `${Math.abs(value).toFixed(2)}°${value >= 0 ? positive : negative}`;

function downloadBytes(bytes: ArrayBuffer, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/tiff" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export default function GlobalDemDialog({ onClose, onLoad }: {
  onClose: () => void;
  onLoad: (raster: HeightmapRaster, sourceName: string) => void;
}) {
  const [choice, setChoice] = useState(readStoredChoice);
  const { bbox, sourceId, spacingM, saveGeoTiff } = choice;
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const drawingRef = useRef(false);
  const onDrawingChange = useCallback((drawing: boolean) => { drawingRef.current = drawing; }, []);
  const busy = progress !== null;

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(choice)); } catch { /* storage is optional */ }
  }, [choice]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const boxError = bboxError(bbox);
  const plan = useMemo(
    () => (boxError ? null : planGlobalDem(bbox, DEM_SOURCES[sourceId], spacingM)),
    [bbox, boxError, sourceId, spacingM],
  );
  const update = (next: Partial<StoredChoice>) => setChoice((current) => ({ ...current, ...next }));

  const run = async () => {
    if (!plan) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setProgress({ loaded: 0, total: plan.detailTiles.length });
    try {
      const mosaic = await assembleGlobalDem(plan, terrariumTileLoader(plan.source), controller.signal,
        (loaded, total) => setProgress({ loaded, total }));
      const centreLat = (bbox.south + bbox.north) / 2;
      const centreLon = (bbox.west + bbox.east) / 2;
      const name = `terrain_${formatCoordinate(centreLat, "N", "S")}_${formatCoordinate(centreLon, "E", "W")}_${Math.round(mosaic.groundCellSize)}m.tif`
        .replace(/°/g, "");
      if (saveGeoTiff) downloadBytes(encodeGlobalDemGeoTiff(mosaic), name);
      onLoad(globalDemToHeightmap(mosaic), name);
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "The terrain download failed.");
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setProgress(null);
      }
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress(null);
  };

  const coordinate = (label: string, key: keyof BBox) => (
    <label className="flex items-center justify-between gap-2 text-[12px] text-slate-300">
      {label}
      <input type="number" step={0.01} value={Number.isFinite(bbox[key]) ? bbox[key] : ""} disabled={busy}
        onChange={(event) => update({ bbox: { ...bbox, [key]: event.currentTarget.valueAsNumber } })}
        className="w-24 rounded border border-white/10 bg-white/5 px-2 py-1 text-right text-[12px] text-slate-100 tabular-nums disabled:opacity-40" />
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm sm:p-4"
      onKeyDown={(event) => { if (event.key === "Escape" && !drawingRef.current) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="global-dem-title"
        className="flex h-full max-h-[760px] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-white/10 bg-[#1f232b] text-slate-200 shadow-2xl">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-white/5 px-4">
          <h2 id="global-dem-title" className="text-[13px] font-semibold text-white">Get real terrain</h2>
          <span className="text-[12px] text-slate-500">Worldwide, about 30 m</span>
          <button type="button" onClick={onClose} aria-label="Close" autoFocus
            className="ml-auto rounded p-1 text-slate-400 hover:bg-white/5 hover:text-slate-100"><X size={16} /></button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:flex-row md:overflow-hidden">
          <GlobalDemExtentMap bbox={bbox} disabled={busy} onDrawingChange={onDrawingChange}
            onChange={(next) => update({ bbox: next })} />

          <aside className="flex shrink-0 flex-col gap-3 md:w-72 md:overflow-y-auto">
            <section className="flex flex-col gap-1.5">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Area</h3>
              {coordinate("North", "north")}
              {coordinate("West", "west")}
              {coordinate("East", "east")}
              {coordinate("South", "south")}
              {boxError && <p className="text-[11px] text-amber-300">{boxError}</p>}
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Elevation data</h3>
              <InspectorSelect label="Source" value={sourceId} options={SOURCE_OPTIONS} disabled={busy}
                onChange={(next) => update({ sourceId: next })} />
              <InspectorNote>{DEM_SOURCES[sourceId].description}</InspectorNote>
              <InspectorSelect label="Ground spacing" value={spacingM} options={SPACING_OPTIONS} disabled={busy}
                onChange={(next) => update({ spacingM: next })} />
              {plan && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded border border-white/5 bg-black/20 px-2.5 py-2 text-[12px]">
                <dt className="text-slate-500">Size</dt>
                <dd className="text-right tabular-nums">{plan.widthKm.toFixed(1)} × {plan.heightKm.toFixed(1)} km</dd>
                <dt className="text-slate-500">Grid</dt>
                <dd className="text-right tabular-nums">{plan.width.toLocaleString()} × {plan.height.toLocaleString()} px</dd>
                <dt className="text-slate-500">Spacing</dt>
                <dd className="text-right tabular-nums">≈ {plan.groundCellSize.toFixed(0)} m</dd>
                <dt className="text-slate-500">Download</dt>
                <dd className="text-right tabular-nums">{plan.detailTiles.length.toLocaleString()} tiles</dd>
              </dl>}
              {plan && plan.groundCellSize > spacingM * 1.5 &&
                <InspectorNote>This box is large, so it uses coarser tiles to stay within the download limit.</InspectorNote>}
              {plan && plan.detailZoom > plan.zoom &&
                <InspectorNote>
                  Downloads the full ≈ {(plan.groundCellSize / 2 ** (plan.detailZoom - plan.zoom)).toFixed(0)} m data and
                  averages it to this grid, so valleys narrower than a cell keep draining instead of turning into lakes.
                </InspectorNote>}
              <InspectorToggle label="Also save as GeoTIFF" checked={saveGeoTiff} disabled={busy}
                onChange={(next) => update({ saveGeoTiff: next })} />
            </section>

            <InspectorNote>
              Map width, summit height and valley floor are set from the data. Sea is land at or below 0 m
              that reaches the map edge; the GeoTIFF stores it as NODATA. Data: {DEM_SOURCES[sourceId].attribution}.
            </InspectorNote>

            <div className="mt-auto flex flex-col gap-2">
              {error && <p role="alert" className="text-[12px] text-red-300">{error}</p>}
              {progress && <div className="flex flex-col gap-1">
                <div className="h-1.5 overflow-hidden rounded bg-white/10">
                  <div className="h-full bg-sky-500 transition-[width]"
                    style={{ width: `${(100 * progress.loaded) / Math.max(1, progress.total)}%` }} />
                </div>
                <p className="text-[11px] text-slate-400 tabular-nums">Downloading tile {Math.min(progress.total, progress.loaded + 1)} of {progress.total}</p>
              </div>}
              {busy
                ? <button type="button" onClick={cancel}
                    className="rounded border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] text-slate-200 hover:bg-white/10">Cancel</button>
                : <button type="button" onClick={run} disabled={!plan}
                    className="inline-flex items-center justify-center gap-1.5 rounded bg-sky-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40">
                    <Download size={14} /> Load terrain
                  </button>}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

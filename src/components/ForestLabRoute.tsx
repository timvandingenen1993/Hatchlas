import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  DEFAULT_FOREST_LAB_SETTINGS,
  FOREST_LAB_WIDTH,
  renderForestLab,
  type ForestLabSettings,
} from "../rendering/forestLabRenderer";

/**
 * /forest-lab: experiment with a hand-drawn forest look on a synthetic
 * alpine slope. Independent of the main vegetation pipeline.
 */

const STORAGE_KEY = "forest-lab-settings";

function loadSettings(): ForestLabSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_FOREST_LAB_SETTINGS, ...(JSON.parse(raw) as Partial<ForestLabSettings>) };
  } catch {
    // Storage is a convenience only.
  }
  return DEFAULT_FOREST_LAB_SETTINGS;
}

type NumberKey = {
  [K in keyof ForestLabSettings]: ForestLabSettings[K] extends number ? K : never;
}[keyof ForestLabSettings];

const SLIDERS: {
  group: string;
  items: { key: NumberKey; label: string; min: number; max: number; step: number }[];
}[] = [
  {
    group: "Terrain",
    items: [
      { key: "seed", label: "Seed", min: 1, max: 100, step: 1 },
      { key: "treeline", label: "Treeline height", min: 0.3, max: 0.9, step: 0.01 },
      { key: "formLineDensity", label: "Form line density", min: 0, max: 1.5, step: 0.05 },
      { key: "groundShade", label: "Ground hillshade", min: 0, max: 1.5, step: 0.05 },
      { key: "treeLight", label: "Tree + wash light", min: 0, max: 1.5, step: 0.05 },
    ],
  },
  {
    group: "Stands",
    items: [
      { key: "forestCover", label: "Forest cover", min: 0, max: 1, step: 0.01 },
      { key: "gullyAffinity", label: "Gully affinity", min: 0, max: 1.5, step: 0.05 },
      { key: "fringeDensity", label: "Fringe / scattered trees", min: 0, max: 1.5, step: 0.05 },
      { key: "washStrength", label: "Stand wash", min: 0, max: 1, step: 0.05 },
      { key: "washVariation", label: "Wash variation", min: 0, max: 2, step: 0.05 },
      { key: "washSoftness", label: "Wash softness", min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    group: "Trees",
    items: [
      { key: "treeSize", label: "Treetop height (map px)", min: 4, max: 30, step: 0.5 },
      { key: "shrubScale", label: "Shrub height (× tree)", min: 0.2, max: 1, step: 0.02 },
      { key: "accentTrees", label: "Wetland trees among shrubs", min: 0, max: 0.6, step: 0.01 },
      { key: "standSpacing", label: "Mark spacing", min: 0.25, max: 1.5, step: 0.05 },
      { key: "edgeMarks", label: "Edge trees (top + bottom)", min: 0, max: 1.5, step: 0.05 },
      { key: "interiorMarks", label: "Interior L2/L3 trees", min: 0, max: 0.6, step: 0.01 },
      { key: "inkWeight", label: "Ink weight", min: 0, max: 2, step: 0.05 },
    ],
  },
];

const COLORS: { key: keyof ForestLabSettings; label: string }[] = [
  { key: "meadowColor", label: "Meadow" },
  { key: "rockColor", label: "Rock" },
  { key: "washColor", label: "Stand wash" },
  { key: "shrubWashColor", label: "Shrub wash" },
  { key: "accentColor", label: "Wetland tree" },
  { key: "trunkColor", label: "Wetland tree trunk" },
  { key: "inkColor", label: "Ink" },
];

export function ForestLabRoute() {
  const [settings, setSettings] = useState<ForestLabSettings>(loadSettings);
  const [zoom, setZoom] = useState(() => Number(new URLSearchParams(window.location.search).get("zoom")) || 1.5);
  const [renderMs, setRenderMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [referenceUrl, setReferenceUrl] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage is a convenience only.
    }
    const timer = window.setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        const start = performance.now();
        renderForestLab(canvas, settings, Math.min(3, Math.max(1, zoom * window.devicePixelRatio)));
        setRenderMs(performance.now() - start);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [settings, zoom]);

  const update = <K extends keyof ForestLabSettings>(key: K, value: ForestLabSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));

  const onReference = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setReferenceUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });
  };

  return (
    <div className="flex h-screen w-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-slate-800 bg-slate-900 p-4 text-xs">
        <h1 className="mb-1 text-sm font-bold">Forest lab</h1>
        <p className="mb-3 text-slate-400">
          Hand-drawn forest experiment on a synthetic slope. Not wired into
          the main pipeline. Settings are kept in this browser.
        </p>
        <label className="mb-3 block">
          <span className="flex justify-between">
            <span>Display zoom</span>
            <span className="tabular-nums text-slate-400">{zoom}</span>
          </span>
          <input className="w-full" type="range" min={0.5} max={4} step={0.25} value={zoom}
            onChange={(event) => setZoom(Number(event.currentTarget.value))} />
        </label>
        <label className="mb-3 flex items-center justify-between">
          <span>Stands of</span>
          <select className="rounded bg-slate-800 px-1" value={settings.standKind}
            onChange={(event) => update("standKind", event.currentTarget.value as ForestLabSettings["standKind"])}>
            <option value="trees">Trees</option>
            <option value="shrubs">Shrubs</option>
          </select>
        </label>
        {SLIDERS.map((group) => (
          <section key={group.group} className="mb-4">
            <h2 className="mb-2 font-semibold uppercase tracking-wider text-slate-400">{group.group}</h2>
            {group.items.map((item) => (
              <label key={item.key} className="mb-2 block">
                <span className="flex justify-between">
                  <span>{item.label}</span>
                  <span className="tabular-nums text-slate-400">{settings[item.key]}</span>
                </span>
                <input className="w-full" type="range" min={item.min} max={item.max} step={item.step}
                  value={settings[item.key]}
                  onChange={(event) => update(item.key, Number(event.currentTarget.value))} />
              </label>
            ))}
          </section>
        ))}
        <section className="mb-4">
          <h2 className="mb-2 font-semibold uppercase tracking-wider text-slate-400">Colours</h2>
          {COLORS.map((item) => (
            <label key={item.key} className="mb-1 flex items-center justify-between">
              <span>{item.label}</span>
              <input type="color" value={settings[item.key] as string}
                onChange={(event) => update(item.key, event.currentTarget.value as never)} />
            </label>
          ))}
        </section>
        <section className="mb-4">
          <h2 className="mb-2 font-semibold uppercase tracking-wider text-slate-400">Reference image</h2>
          <input type="file" accept="image/*" onChange={onReference} />
        </section>
        <button className="rounded bg-slate-800 px-2 py-1" onClick={() => setSettings(DEFAULT_FOREST_LAB_SETTINGS)}>
          Reset to defaults
        </button>
      </aside>
      <main className="flex-1 overflow-auto p-4">
        <div className="mb-2 text-xs text-slate-400">
          rendered in {renderMs.toFixed(0)} ms
          {error && <span className="ml-2 text-red-400">{error}</span>}
        </div>
        <div className="flex flex-wrap items-start gap-4">
          <canvas ref={canvasRef} style={{ width: FOREST_LAB_WIDTH * zoom }} />
          {referenceUrl && <img src={referenceUrl} alt="Reference" style={{ maxWidth: FOREST_LAB_WIDTH * zoom }} />}
        </div>
      </main>
    </div>
  );
}

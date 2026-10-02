import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  buildVisualWaterSurfaceDEM,
  renderWaterOverlay,
  type WaterOverlay,
} from "../rendering/waterRenderer";
import type { MountainDEMData } from "../terrain/mountainBaseDEM";

/**
 * /pool-lab: tune wetland-pool linework on a synthetic map. It runs the real
 * water renderer with the same option scaling the preview uses
 * (scaleWaterPresentationOptions) and a simplified copy of the detail
 * compositor, so what you see here is what the pool pass produces.
 */

const MAP_WIDTH = 360;
const MAP_HEIGHT = 240;

// The live preview draws water on a 1536px copy of the 2048px reference
// map, so one lab pixel is one preview pixel at this fixed scale. Exports
// scale the same look to their size internally; it is not a setting.
const PREVIEW_WATER_SCALE = 0.75;

interface LabSettings {
  mode: "lake" | "generated";
  zoom: number;
  smoothDisplay: boolean;
  lakeSize: number;
  lakeSeed: number;
  puddleDensity: number;
  puddleSizeMin: number;
  puddleSizeMax: number;
  puddleCoastDistance: number;
  puddleSeed: number;
  outlineThickness: number;
  outlineOpacity: number;
  outlineSmoothing: number;
  flowThickness: number;
  flowDensity: number;
  flowLength: number;
  flowOpacity: number;
  flowSmoothing: number;
  poolContourLength: number;
  fillSmoothing: number;
  landColor: string;
  shallowColor: string;
  deepColor: string;
  outlineColor: string;
  flowColor: string;
}

// Defaults mirror the saved studio settings (currentSettings).
const DEFAULT_SETTINGS: LabSettings = {
  mode: "lake",
  zoom: 3,
  smoothDisplay: true,
  lakeSize: 0.34,
  lakeSeed: 3,
  puddleDensity: 0.6,
  puddleSizeMin: 0.3,
  puddleSizeMax: 1,
  puddleCoastDistance: 0,
  puddleSeed: 1253043850,
  outlineThickness: 0.9,
  outlineOpacity: 1,
  outlineSmoothing: 4,
  flowThickness: 0.45,
  flowDensity: 0.25,
  flowLength: 0.7,
  flowOpacity: 1,
  flowSmoothing: 3,
  poolContourLength: 1.8,
  fillSmoothing: 1,
  landColor: "#8a9e4c",
  shallowColor: "#60a0d0",
  deepColor: "#1d527e",
  outlineColor: "#000000",
  flowColor: "#000000",
};

const STORAGE_KEY = "pool-lab-settings";
// Same key MountainDetailStudio persists its settings under.
const STUDIO_STORAGE_KEY = "fantasy-map-builder:mountain-detail-settings:v1";

// Lab setting <-> studio setting names for everything the pool pass reads.
const STUDIO_FIELDS: [keyof LabSettings, string][] = [
  ["outlineThickness", "waterOutlineThickness"],
  ["outlineOpacity", "waterOutlineOpacity"],
  ["outlineSmoothing", "waterOutlineSmoothing"],
  ["flowThickness", "waterFlowThickness"],
  ["flowDensity", "waterFlowDensity"],
  ["flowLength", "waterFlowLength"],
  ["flowOpacity", "waterFlowOpacity"],
  ["flowSmoothing", "waterFlowSmoothing"],
  ["poolContourLength", "wetlandPoolContourLength"],
  ["fillSmoothing", "waterFillSmoothing"],
  ["puddleDensity", "wetlandPuddleDensity"],
  ["puddleSizeMin", "wetlandPuddleSizeMin"],
  ["puddleSizeMax", "wetlandPuddleSizeMax"],
  ["puddleCoastDistance", "wetlandPuddleCoastDistance"],
  ["puddleSeed", "wetlandPuddleSeed"],
  ["shallowColor", "waterShallowColor"],
  ["deepColor", "waterDeepColor"],
  ["outlineColor", "waterOutlineColor"],
  ["flowColor", "waterFlowColor"],
];

function readStudioSettings(): Record<string, unknown> | null {
  try {
    const raw = window.localStorage.getItem(STUDIO_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Lab settings as the studio currently has them. */
function labSettingsFromStudio(base: LabSettings): LabSettings | null {
  const studio = readStudioSettings();
  if (!studio) return null;
  const next: Record<string, unknown> = { ...base };
  for (const [labKey, studioKey] of STUDIO_FIELDS) {
    const value = studio[studioKey];
    if (typeof value === typeof base[labKey]) next[labKey] = value;
  }
  const biomeColors = studio.vegetationBiomeColors as
    | Record<string, unknown>
    | undefined;
  if (typeof biomeColors?.["7"] === "string") next.landColor = biomeColors["7"];
  return next as unknown as LabSettings;
}

/** Write the lab's pool/water values into the studio's saved settings. */
function applyLabSettingsToStudio(settings: LabSettings): boolean {
  const studio = readStudioSettings();
  if (!studio) return false;
  for (const [labKey, studioKey] of STUDIO_FIELDS) {
    studio[studioKey] = settings[labKey];
  }
  try {
    window.localStorage.setItem(STUDIO_STORAGE_KEY, JSON.stringify(studio));
    return true;
  } catch {
    return false;
  }
}

function loadSettings(): LabSettings {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch {
    // Storage is a convenience only.
  }
  return DEFAULT_SETTINGS;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hash01(value: number): number {
  let h = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function blankDem(): MountainDEMData {
  const total = MAP_WIDTH * MAP_HEIGHT;
  return {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    isRiverChannel: new Uint8Array(total),
    riverChannelRadius: new Uint8Array(total),
    riverCenterlineMask: new Uint8Array(total),
    flowDirection: new Int8Array(total).fill(-1),
    drainageAreaKm2: new Float32Array(total),
    waterDepthM: new Float32Array(total),
    strahlerOrder: new Uint8Array(total),
    biomeType: new Uint8Array(total).fill(4),
  } as unknown as MountainDEMData;
}

/** One irregular, elongated lake given directly as the wetland-pool mask. */
function buildLakeDem(size: number, seed: number): MountainDEMData {
  const dem = blankDem() as MountainDEMData & {
    wetlandPoolMask: Uint8Array;
    wetlandPoolCoverage: Float32Array;
  };
  const total = MAP_WIDTH * MAP_HEIGHT;
  const mask = new Uint8Array(total);
  const coverage = new Float32Array(total);
  const radius = size * Math.min(MAP_WIDTH, MAP_HEIGHT);
  const phaseA = hash01(seed * 7 + 1) * Math.PI * 2;
  const phaseB = hash01(seed * 7 + 2) * Math.PI * 2;
  const phaseC = hash01(seed * 7 + 3) * Math.PI * 2;
  const cx = MAP_WIDTH / 2;
  const cy = MAP_HEIGHT / 2;
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      const dx = (x - cx) / 1.7;
      const dy = y - cy + (x - cx) * 0.25;
      const angle = Math.atan2(dy, dx);
      const rim =
        radius *
        (1 +
          0.16 * Math.sin(2 * angle + phaseA) +
          0.09 * Math.sin(3 * angle + phaseB) +
          0.05 * Math.sin(5 * angle + phaseC));
      const signed = Math.hypot(dx, dy) - rim;
      const index = y * MAP_WIDTH + x;
      coverage[index] = Math.max(0, Math.min(1, 0.5 - signed));
      if (signed <= 0) {
        mask[index] = 1;
        dem.biomeType[index] = 7;
      }
    }
  }
  dem.wetlandPoolMask = mask;
  dem.wetlandPoolCoverage = coverage;
  return dem;
}

/** Wetland biome region; the real pool generator places the pools. */
function buildGeneratedDem(settings: LabSettings): MountainDEMData {
  const dem = blankDem();
  for (let y = 20; y < MAP_HEIGHT - 20; y++) {
    for (let x = 30; x < MAP_WIDTH - 30; x++) {
      dem.biomeType[y * MAP_WIDTH + x] = 7;
    }
  }
  return buildVisualWaterSurfaceDEM(dem, {
    enabled: true,
    density: settings.puddleDensity,
    sizeMin: settings.puddleSizeMin,
    sizeMax: settings.puddleSizeMax,
    coastDistance: settings.puddleCoastDistance,
    seed: settings.puddleSeed,
  });
}

function renderLab(settings: LabSettings): {
  overlay: WaterOverlay;
  rgba: Uint8ClampedArray<ArrayBuffer>;
  ms: number;
} {
  const start = performance.now();
  const dem =
    settings.mode === "lake"
      ? buildLakeDem(settings.lakeSize, settings.lakeSeed)
      : buildGeneratedDem(settings);
  // Same pixel scaling as scaleWaterPresentationOptions in the preview.
  const s = PREVIEW_WATER_SCALE;
  const overlay = renderWaterOverlay(dem, {
    useEcologicalBiomeWater: true,
    wetlandPuddleContours: true,
    wetlandPuddleDensity: settings.puddleDensity,
    wetlandPuddleSizeMin: settings.puddleSizeMin,
    wetlandPuddleSizeMax: settings.puddleSizeMax,
    wetlandPuddleCoastDistance: settings.puddleCoastDistance,
    wetlandPuddleSeed: settings.puddleSeed,
    fillSmoothing: settings.fillSmoothing,
    outlineThickness: settings.outlineThickness * s,
    outlineOpacity: settings.outlineOpacity,
    outlineSmoothing: settings.outlineSmoothing,
    flowThickness: settings.flowThickness * s,
    flowDensity: settings.flowDensity / Math.max(0.25, s),
    flowLength: settings.flowLength * s,
    flowOpacity: settings.flowOpacity,
    flowSmoothing: settings.flowSmoothing,
    poolContourLength: settings.poolContourLength * s,
    oceanPixelScale: s,
    wetlandPuddleCoordinateScale: s,
  });

  const land = hexToRgb(settings.landColor);
  const shallow = hexToRgb(settings.shallowColor);
  const deep = hexToRgb(settings.deepColor);
  const outline = hexToRgb(settings.outlineColor);
  const flow = hexToRgb(settings.flowColor);
  const total = MAP_WIDTH * MAP_HEIGHT;
  const rgba = new Uint8ClampedArray(total * 4);
  const blend = (a: number, b: number, t: number) => a + (b - a) * t;
  for (let i = 0; i < total; i++) {
    let r = land[0];
    let g = land[1];
    let b = land[2];
    const waterAlpha = Math.max(
      overlay.waterAlpha[i],
      overlay.wetlandPuddlePriorityAlpha?.[i] ?? 0,
    ) / 255;
    if (waterAlpha > 0) {
      const tone = (overlay.waterTone?.[i] ?? 128) / 255;
      const shade = 0.92;
      r = blend(r, blend(deep[0], shallow[0], tone) * shade, waterAlpha);
      g = blend(g, blend(deep[1], shallow[1], tone) * shade, waterAlpha);
      b = blend(b, blend(deep[2], shallow[2], tone) * shade, waterAlpha);
    }
    const bank =
      (overlay.outlineBankAlpha?.[i] ?? overlay.bankAlpha[i]) / 255;
    if (bank > 0) {
      r = blend(r, outline[0], bank);
      g = blend(g, outline[1], bank);
      b = blend(b, outline[2], bank);
    }
    const flowAlpha = overlay.flowAlpha[i] / 255;
    if (flowAlpha > 0) {
      const flowTone = overlay.flowTone[i] / 255;
      const alpha = Math.min(1, flowAlpha * (0.85 + 0.3 * hash01(i)));
      r = blend(r, Math.min(255, flow[0] + flowTone * 18), alpha);
      g = blend(g, Math.min(255, flow[1] + flowTone * 16), alpha);
      b = blend(b, Math.min(255, flow[2] + flowTone * 14), alpha);
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return { overlay, rgba, ms: performance.now() - start };
}

type NumberKey = {
  [K in keyof LabSettings]: LabSettings[K] extends number ? K : never;
}[keyof LabSettings];

const SLIDERS: {
  group: string;
  items: { key: NumberKey; label: string; min: number; max: number; step: number }[];
}[] = [
  {
    group: "View",
    items: [
      { key: "zoom", label: "Display zoom", min: 1, max: 8, step: 0.5 },
    ],
  },
  {
    group: "Shape",
    items: [
      { key: "lakeSize", label: "Lake size", min: 0.1, max: 0.45, step: 0.01 },
      { key: "lakeSeed", label: "Lake shape seed", min: 1, max: 50, step: 1 },
      { key: "puddleDensity", label: "Generated pool density", min: 0.05, max: 2, step: 0.05 },
      { key: "puddleSizeMin", label: "Min pool size", min: 0.05, max: 1, step: 0.01 },
      { key: "puddleSizeMax", label: "Max pool size", min: 0.05, max: 1, step: 0.01 },
      { key: "puddleCoastDistance", label: "Min coast distance", min: 0, max: 2, step: 0.05 },
      { key: "fillSmoothing", label: "Fill smoothing", min: 0, max: 4, step: 1 },
    ],
  },
  {
    group: "Outline",
    items: [
      { key: "outlineThickness", label: "Outline thickness", min: 0, max: 4, step: 0.05 },
      { key: "outlineOpacity", label: "Outline opacity", min: 0, max: 1, step: 0.05 },
      { key: "outlineSmoothing", label: "Outline smoothing", min: 0, max: 4, step: 1 },
    ],
  },
  {
    group: "Pool charcoal",
    items: [
      { key: "flowThickness", label: "Flow thickness", min: 0, max: 4, step: 0.05 },
      { key: "flowDensity", label: "Flow density", min: 0, max: 2, step: 0.05 },
      { key: "flowOpacity", label: "Flow opacity", min: 0, max: 1, step: 0.05 },
      { key: "flowLength", label: "Flow length", min: 0.1, max: 4, step: 0.05 },
      { key: "flowSmoothing", label: "Flow smoothing", min: 0, max: 4, step: 1 },
      { key: "poolContourLength", label: "Pool contour length", min: 0.1, max: 6, step: 0.05 },
    ],
  },
];

const COLORS: { key: keyof LabSettings; label: string }[] = [
  { key: "landColor", label: "Land" },
  { key: "shallowColor", label: "Water shallow" },
  { key: "deepColor", label: "Water deep" },
  { key: "outlineColor", label: "Outline" },
  { key: "flowColor", label: "Charcoal" },
];

export function PoolLabRoute() {
  const [settings, setSettings] = useState<LabSettings>(loadSettings);
  const [renderMs, setRenderMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [referenceUrl, setReferenceUrl] = useState<string | null>(null);
  const [studioMessage, setStudioMessage] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage is a convenience only.
    }
    const timer = window.setTimeout(() => {
      try {
        const { rgba, ms } = renderLab(settings);
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        canvas.width = MAP_WIDTH;
        canvas.height = MAP_HEIGHT;
        context.putImageData(new ImageData(rgba, MAP_WIDTH, MAP_HEIGHT), 0, 0);
        setRenderMs(ms);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [settings]);

  const update = <K extends keyof LabSettings>(key: K, value: LabSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));

  const onReference = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setReferenceUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });
  };

  const exportSettings = JSON.stringify(
    {
      waterOutlineThickness: settings.outlineThickness,
      waterOutlineOpacity: settings.outlineOpacity,
      waterOutlineSmoothing: settings.outlineSmoothing,
      waterFlowThickness: settings.flowThickness,
      waterFlowDensity: settings.flowDensity,
      waterFlowLength: settings.flowLength,
      waterFlowOpacity: settings.flowOpacity,
      waterFlowSmoothing: settings.flowSmoothing,
      wetlandPoolContourLength: settings.poolContourLength,
      waterFillSmoothing: settings.fillSmoothing,
    },
    null,
    2,
  );

  return (
    <div className="flex h-screen w-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-slate-800 bg-slate-900 p-4 text-xs">
        <h1 className="mb-1 text-sm font-bold">Pool lab</h1>
        <p className="mb-3 text-slate-400">
          Real water renderer, preview option scaling. Settings are kept in
          this browser.
        </p>
        <div className="mb-3 flex gap-2">
          <button
            className="flex-1 rounded bg-sky-700 px-2 py-1"
            onClick={() => {
              const loaded = labSettingsFromStudio(settings);
              if (loaded) setSettings(loaded);
              setStudioMessage(
                loaded
                  ? "Loaded the studio's current settings."
                  : "No saved studio settings found in this browser.",
              );
            }}
          >
            Load from studio
          </button>
          <button
            className="flex-1 rounded bg-emerald-700 px-2 py-1"
            onClick={() =>
              setStudioMessage(
                applyLabSettingsToStudio(settings)
                  ? "Saved to the studio. Reload the studio page to use them."
                  : "No saved studio settings found in this browser.",
              )
            }
          >
            Apply to studio
          </button>
        </div>
        {studioMessage && (
          <p className="mb-3 text-amber-300">{studioMessage}</p>
        )}
        <div className="mb-3 flex gap-2">
          {(["lake", "generated"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => update("mode", mode)}
              className={`flex-1 rounded px-2 py-1 ${
                settings.mode === mode ? "bg-amber-600" : "bg-slate-800"
              }`}
            >
              {mode === "lake" ? "Single lake" : "Generated pools"}
            </button>
          ))}
        </div>
        <label className="mb-3 flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.smoothDisplay}
            onChange={(event) => update("smoothDisplay", event.currentTarget.checked)}
          />
          Smooth upscale (like the preview)
        </label>
        {SLIDERS.map((group) => (
          <section key={group.group} className="mb-4">
            <h2 className="mb-2 font-semibold uppercase tracking-wider text-slate-400">
              {group.group}
            </h2>
            {group.items.map((item) => (
              <label key={item.key} className="mb-2 block">
                <span className="flex justify-between">
                  <span>{item.label}</span>
                  <span className="tabular-nums text-slate-400">
                    {settings[item.key]}
                  </span>
                </span>
                <input
                  className="w-full"
                  type="range"
                  min={item.min}
                  max={item.max}
                  step={item.step}
                  value={settings[item.key]}
                  onChange={(event) =>
                    update(item.key, Number(event.currentTarget.value))
                  }
                />
              </label>
            ))}
          </section>
        ))}
        <section className="mb-4">
          <h2 className="mb-2 font-semibold uppercase tracking-wider text-slate-400">
            Colours
          </h2>
          {COLORS.map((item) => (
            <label key={item.key} className="mb-1 flex items-center justify-between">
              <span>{item.label}</span>
              <input
                type="color"
                value={settings[item.key] as string}
                onChange={(event) =>
                  update(item.key, event.currentTarget.value as never)
                }
              />
            </label>
          ))}
        </section>
        <section className="mb-4">
          <h2 className="mb-2 font-semibold uppercase tracking-wider text-slate-400">
            Reference image
          </h2>
          <input type="file" accept="image/*" onChange={onReference} />
        </section>
        <section className="mb-4">
          <h2 className="mb-2 font-semibold uppercase tracking-wider text-slate-400">
            Studio values
          </h2>
          <pre className="whitespace-pre-wrap rounded bg-slate-950 p-2 text-[10px]">
            {exportSettings}
          </pre>
          <button
            className="mt-2 rounded bg-slate-800 px-2 py-1"
            onClick={() => setSettings(DEFAULT_SETTINGS)}
          >
            Reset to defaults
          </button>
        </section>
      </aside>
      <main className="flex-1 overflow-auto p-4">
        <div className="mb-2 text-xs text-slate-400">
          {MAP_WIDTH}×{MAP_HEIGHT} map px · rendered in {renderMs.toFixed(0)} ms
          {error && <span className="ml-2 text-red-400">{error}</span>}
        </div>
        <div className="flex flex-wrap items-start gap-4">
          <canvas
            ref={canvasRef}
            style={{
              width: MAP_WIDTH * settings.zoom,
              height: MAP_HEIGHT * settings.zoom,
              imageRendering: settings.smoothDisplay ? "auto" : "pixelated",
            }}
          />
          {referenceUrl && (
            <img
              src={referenceUrl}
              alt="Reference"
              style={{ maxWidth: MAP_WIDTH * settings.zoom }}
            />
          )}
        </div>
      </main>
    </div>
  );
}

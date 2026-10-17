/**
 * Controls for the trees and shrubs: placement, per-biome densities and
 * colours, and the pen-and-ink stands they are drawn as.
 */
import { INSPECTOR_BOUNDS } from "../config/inspectorBounds";
import { FOREST_SETTING_LIMITS, type ForestRenderSettings } from "../rendering/forestCanvasRenderer";
import { NumericControl } from "./NumericControl";
import { InspectorColor, InspectorFold, InspectorNote, InspectorSelect } from "./InspectorParts";

interface ForestRenderControlsProps {
  settings: ForestRenderSettings;
  defaults?: ForestRenderSettings;
  treeDensityDefault?: number;
  shrubDensityDefault?: number;
  biomeClusteringDefault?: number;
  propScaleDefault?: number;
  standSizeDefault?: number;
  placementNoiseScaleDefault?: number;
  onSettingsChange: (settings: ForestRenderSettings) => void;
  /** Densities of the selected biome's tree and shrub stands. */
  treeDensity: number;
  onTreeDensityChange: (density: number) => void;
  shrubDensity: number;
  onShrubDensityChange: (density: number) => void;
  /** Share of the selected biome's shrub-stand plants drawn as trees. */
  shrubTreeShare: number;
  onShrubTreeShareChange: (share: number) => void;
  shrubTreeShareDefault?: number;
  /** Colours of the selected biome's tree and shrub stands. */
  treeColor: string;
  onTreeColorChange: (color: string) => void;
  shrubColor: string;
  onShrubColorChange: (color: string) => void;
  clustering: number;
  onClusteringChange: (clustering: number) => void;
  placementNoiseScale: number;
  onPlacementNoiseScaleChange: (scale: number) => void;
  biome: number;
  biomeOptions: readonly { id: number; label: string }[];
  onBiomeChange: (biome: number) => void;
  treeScale: number;
  onTreeScaleChange: (scale: number) => void;
  standSize: number;
  onStandSizeChange: (size: number) => void;
  disabled?: boolean;
}

type StandControlKey =
  | "standJoin" | "biomeBlend" | "inkFillDensity" | "inkEdgeDensity" | "inkEdgeRows" | "inkEdgeDepth" | "inkMeadowTrees"
  | "inkGrass" | "inkLight" | "inkWeight" | "inkTint" | "inkWashVariation" | "inkWashSoftness" | "inkCharcoal" | "inkInterruptions";

/** Pen-and-ink forest stands (as tuned in /forest-lab). */
const standControls: Array<{ key: StandControlKey; label: string; min: number; max: number; step: number; tip: string }> = [
  { key: "standJoin", label: "Stand joining", min: 1, max: 5, step: 0.05,
    tip: "Largest gap, in trees, between plants that still join into one stand. A plant needs two others this close to be part of a stand. Lower gives fewer, tighter stands and more lone trees; higher more connected woods." },
  { key: "biomeBlend", label: "Biome blend", min: 0, max: 40, step: 0.5,
    tip: "Width, in trees, of the band where neighbouring biomes meet: their trees and shrubs reach into each other in tongues and islands, and their stand colours blend across it. 0 keeps a hard border." },
  { key: "inkFillDensity", label: "Fill density", min: 0.3, max: 1.6, step: 0.05,
    tip: "How closely the tree tops inside a stand are packed." },
  { key: "inkEdgeDensity", label: "Edge density", min: 0.4, max: 1.6, step: 0.05,
    tip: "How tightly trees pack along the front (lower) and back (upper) edges of a stand." },
  { key: "inkEdgeRows", label: "Second front row", min: 0, max: 1, step: 0.05,
    tip: "How often a second, half-hidden tree is set between the front-row trees, doubling the front edge." },
  { key: "inkEdgeDepth", label: "Edge depth variance", min: 0, max: 2, step: 0.05,
    tip: "How far edge trees step in front of or sink behind the stand outline. 0 lines them up on it." },
  { key: "inkMeadowTrees", label: "Meadow trees", min: 0, max: 1.5, step: 0.05,
    tip: "Lone trees and small groups scattered on the open ground around stands." },
  { key: "inkGrass", label: "Grass dots", min: 0, max: 2, step: 0.05,
    tip: "Dotted grass runs trailing out from stand edges and lone trees." },
  { key: "inkLight", label: "Terrain light on stands", min: 0, max: 1.5, step: 0.05,
    tip: "How strongly hillshade affects stands: patches turned from the sun get a darker wash and a fuller, heavier fill; lit ground a sparser one." },
  { key: "inkWeight", label: "Line thickness", min: 0, max: 2, step: 0.05,
    tip: "Pen width of every stand line. The kinds of tree keep their relative weights: the front row boldest, then the second row, back edge, fill and lone trees, and the grass dots finest." },
  { key: "inkTint", label: "Stand wash", min: 0, max: 1, step: 0.05,
    tip: "Mixes the biome's tree or shrub colour into the washed ground beneath the stands and inside each tree (biomes and washes, without contours or other lines), as paints mix: 0 is the ground's own colour, 1 the tree colour." },
  { key: "inkWashVariation", label: "Wash variation", min: 0, max: 2, step: 0.05,
    tip: "Splotchiness of the wash: 0 is flat colour, higher adds blooms and shifts in value and warmth." },
  { key: "inkWashSoftness", label: "Wash softness", min: 0, max: 1, step: 0.05,
    tip: "How soft the wash's edge and splotches are: 0 is crisp, 1 bleeds well past the stand." },
  { key: "inkCharcoal", label: "Charcoal grain", min: 0, max: 1, step: 0.05,
    tip: "Dry, grainy texture in the ink, and thinning of each stroke toward its ends." },
  { key: "inkInterruptions", label: "Stroke interruptions", min: 0, max: 1, step: 0.05,
    tip: "How often strokes break where the pen skipped. The fill breaks most, the front row least." },
];

export function ForestRenderControls({
  settings,
  defaults,
  treeDensityDefault,
  shrubDensityDefault,
  biomeClusteringDefault,
  propScaleDefault,
  standSizeDefault,
  placementNoiseScaleDefault,
  onSettingsChange,
  treeDensity,
  onTreeDensityChange,
  shrubDensity,
  onShrubDensityChange,
  treeColor,
  onTreeColorChange,
  shrubColor,
  onShrubColorChange,
  shrubTreeShare,
  onShrubTreeShareChange,
  shrubTreeShareDefault,
  clustering,
  onClusteringChange,
  placementNoiseScale,
  onPlacementNoiseScaleChange,
  biome,
  biomeOptions,
  onBiomeChange,
  treeScale,
  onTreeScaleChange,
  standSize,
  onStandSizeChange,
  disabled = false,
}: ForestRenderControlsProps) {
  const update = (key: keyof ForestRenderSettings, value: number | boolean | string) => {
    onSettingsChange({ ...settings, [key]: value });
  };
  const slider = (label: string, value: number, min: number, max: number, step: number,
    change: (value: number) => void, defaultValue: number | undefined, title: string,
    unit = max <= 1 && min >= 0 ? "%" : "×", limits?: readonly [number, number]) => (
    <NumericControl key={label} label={label} value={value} min={min} max={max} step={step}
      onChange={change} defaultValue={defaultValue} disabled={disabled} limits={limits} title={title}
      logarithmic={unit !== "%" && min > 0 && max / min >= 8} unit={unit} />
  );

  return (
    <div className="flex flex-col gap-1.5">
      <InspectorNote>These apply to every biome.</InspectorNote>
      {slider("Prop scale", treeScale, INSPECTOR_BOUNDS.propScaleMin, 4, 0.01, onTreeScaleChange, propScaleDefault,
        "Size of the trees and shrubs: the grid every plant is placed on and the size each is drawn at. Larger gives bigger, fewer plants.")}
      {slider("Stand size", standSize, 0, 1, 0.05, onStandSizeChange, standSizeDefault,
        "How strongly plants gather into stands: higher joins neighbours into larger forest patches, lower leaves more small groups and lone trees.")}
      {slider("Placement noise scale", placementNoiseScale, 0.25, 4, 0.05, onPlacementNoiseScaleChange, placementNoiseScaleDefault,
        "Size of the noise that decides where plants grow: larger makes broad forest regions, smaller a finer patchwork.")}
      <div className="mt-1 flex flex-col gap-1.5 rounded bg-black/15 p-2">
        <InspectorSelect label="Biome" value={biome} onChange={onBiomeChange}
          title="The biome the settings below edit."
          options={biomeOptions.map((option) => [option.id, option.label] as const)} />
        {slider("Tree density", treeDensity, 0, INSPECTOR_BOUNDS.propDensity, 0.05, onTreeDensityChange, treeDensityDefault,
          "How many trees this biome grows. Its stands are drawn as conifers or broadleaf trees, depending on the biome.", "×")}
        {slider("Shrub density", shrubDensity, 0, INSPECTOR_BOUNDS.propDensity, 0.05, onShrubDensityChange, shrubDensityDefault,
          "How many shrubs this biome grows. Shrubs form their own low, round, scalloped stands.", "×")}
        {slider("Trees among shrubs", shrubTreeShare, 0, 0.6, 0.01, onShrubTreeShareChange, shrubTreeShareDefault,
          "Share of the shrub stands' edge and lone plants drawn as broadleaf trees instead.")}
        {slider("Clustering", clustering, 0, 1, 0.05, onClusteringChange, biomeClusteringDefault,
          "How much this biome's plants bunch together: high gives dense stands with open ground between, low spreads them evenly.")}
        <InspectorColor label="Tree color" value={treeColor} disabled={disabled} onChange={onTreeColorChange}
          title="Wash colour of this biome's tree stands, and of the trees among its shrubs." />
        <InspectorColor label="Shrub color" value={shrubColor} disabled={disabled} onChange={onShrubColorChange}
          title="Wash colour of this biome's shrub stands." />
      </div>
      <InspectorFold title="Forest stands">
        {standControls.map(({ key, label, min, max, step, tip }) => slider(label, settings[key], min, max, step,
          (value) => update(key, value), defaults?.[key], tip, "×", FOREST_SETTING_LIMITS[key]))}
      </InspectorFold>
      {slider("Terrain shade on props", settings.terrainShadeStrength, 0, 1, 0.01,
        (value) => update("terrainShadeStrength", value), defaults?.terrainShadeStrength,
        "How much hillshade darkens the other props (rocks and boulders) on shadow slopes. Stands use Terrain light on stands.",
        "%", FOREST_SETTING_LIMITS.terrainShadeStrength)}
    </div>
  );
}

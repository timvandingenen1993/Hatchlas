/**
 * Controls for the forest stand renderer.
 */
import { INSPECTOR_BOUNDS } from "../config/inspectorBounds";
import { FOREST_SETTING_LIMITS, type ForestRenderSettings } from "../rendering/forestCanvasRenderer";
import { NumericControl } from "./NumericControl";
import { InspectorColor, InspectorFold, InspectorNote, InspectorSelect, InspectorToggle } from "./InspectorParts";

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
  sourceZoom: number;
  onSourceZoomChange: (zoom: number) => void;
  sourceUrls: readonly string[];
  disabled?: boolean;
}

const numericControls: Array<{
  key: Exclude<
    keyof ForestRenderSettings,
    "seed" | "sunAzimuthDeg" | "showCenterDebug" | "showFootprints" |
      "lightColor" | "outlineColor" | "alpineCanopyColor" | "wetlandCanopyColor" | "wetlandWoodColor" | "wetlandShrubColor"
  >;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: "canopyMerging", label: "Canopy merging", min: 0, max: 100, step: 1 },
  { key: "canopyEdgeNoiseSize", label: "Canopy edge noise size", min: 0.5, max: 2, step: 0.1 },
  { key: "canopyWashNoiseSize", label: "Canopy wash noise size", min: 0.5, max: 2, step: 0.1 },
  { key: "canopyWashStrength", label: "Canopy wash strength", min: 0, max: INSPECTOR_BOUNDS.canopyWash, step: 0.05 },
  { key: "outlineShadowStrength", label: "Cast shadow strength", min: 0, max: 1, step: 0.01 },
  { key: "terrainShadeStrength", label: "Terrain shade on props", min: 0, max: 1, step: 0.01 },
  { key: "hueVariance", label: "Fill hue variance (°)", min: 0, max: 60, step: 1 },
  { key: "saturationVariance", label: "Fill saturation variance", min: 0, max: 0.5, step: 0.01 },
  { key: "valueVariance", label: "Fill value variance", min: 0, max: 0.5, step: 0.01 },
  { key: "outlineInsetStrength", label: "Outline inset strength", min: 0, max: 1, step: 0.01 },
  { key: "outlineInsetBlurRadius", label: "Outline inset blur", min: 0, max: 8, step: 0.1 },
  { key: "lightStrength", label: "Cone shading strength", min: 0, max: 1, step: 0.01 },
  { key: "lightEdgeDepth", label: "Cone edge depth", min: 0.02, max: 0.18, step: 0.005 },
  { key: "lightSoftness", label: "Cone softness", min: 0.1, max: 1, step: 0.01 },
  { key: "lightNoise", label: "Cone texture", min: 0, max: 1, step: 0.01 },
  { key: "centerLightGradientMultiplier", label: "Center light gradient", min: -4, max: -0.25, step: 0.05 },
  { key: "charcoalThickness", label: "Charcoal thickness", min: 0.1, max: 2, step: 0.01 },
  { key: "charcoalInterruptionProbability", label: "Edge interruption probability", min: 0, max: 1, step: 0.01 },
  { key: "centerInterruptionAmountBoost", label: "Center interruption boost", min: 0, max: 0.95, step: 0.01 },
  { key: "centerInterruptionLengthMultiplier", label: "Center gap length", min: 1, max: 12, step: 0.5 },
  { key: "centerDepthThreshold", label: "Center depth threshold", min: 0, max: 0.9, step: 0.01 },
  { key: "minCenterOutlineChance", label: "Minimum center ink", min: 0, max: 0.1, step: 0.001 },
  { key: "centerSegmentRemoval", label: "Center segment removal", min: 0, max: 1, step: 0.01 },
  { key: "overlapLowerInterruptionMultiplier", label: "Overlap interruption multiplier", min: 1, max: 3, step: 0.1 },
  { key: "charcoalInterruptionLength", label: "Edge interruption length", min: 0.5, max: 2.5, step: 0.1 },
];

/** Alpine forest stands (hand-drawn stand style, as tuned in /forest-lab). */
const standControls: Array<{
  key: "standMarkSpacing" | "standEdgeTrees" | "standInteriorTrees" | "standMeadowTrees" |
    "standInkWeight" | "standWashStrength" | "standWashVariation" | "standWashSoftness" | "standLightStrength";
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: "standMarkSpacing", label: "Tree spacing", min: 0.25, max: 1.5, step: 0.05 },
  { key: "standEdgeTrees", label: "Edge trees (top + bottom)", min: 0, max: 1.5, step: 0.05 },
  { key: "standInteriorTrees", label: "Interior trees", min: 0, max: 0.6, step: 0.01 },
  { key: "standMeadowTrees", label: "Meadow trees", min: 0, max: 1.5, step: 0.05 },
  { key: "standInkWeight", label: "Ink weight", min: 0, max: 2, step: 0.05 },
  { key: "standWashStrength", label: "Stand wash", min: 0, max: 1, step: 0.05 },
  { key: "standWashVariation", label: "Wash variation", min: 0, max: 2, step: 0.05 },
  { key: "standWashSoftness", label: "Wash softness", min: 0, max: 1, step: 0.05 },
  { key: "standLightStrength", label: "Terrain light on stands", min: 0, max: 1.5, step: 0.05 },
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
  sourceZoom,
  onSourceZoomChange,
  sourceUrls,
  disabled = false,
}: ForestRenderControlsProps) {
  const update = (key: keyof ForestRenderSettings, value: number | boolean | string) => {
    onSettingsChange({ ...settings, [key]: value });
  };
  const slider = (label: string, value: number, min: number, max: number, step: number,
    change: (value: number) => void, defaultValue?: number, unit = max <= 1 && min >= 0 ? "%" : "×",
    limits?: readonly [number, number]) => (
    <NumericControl key={label} label={label} value={value} min={min} max={max} step={step}
      onChange={change} defaultValue={defaultValue} disabled={disabled} limits={limits}
      logarithmic={unit !== "%" && min > 0 && max / min >= 8} unit={unit} />
  );

  return (
    <div className="flex flex-col gap-1.5">
      <InspectorNote>These apply to every biome.</InspectorNote>
      {slider("Prop scale", treeScale, INSPECTOR_BOUNDS.propScaleMin, 4, 0.01, onTreeScaleChange, propScaleDefault)}
      {slider("Stand size", standSize, 0, 1, 0.05, onStandSizeChange, standSizeDefault)}
      {slider("Placement noise scale", placementNoiseScale, 0.25, 4, 0.05, onPlacementNoiseScaleChange, placementNoiseScaleDefault)}
      <div className="mt-1 flex flex-col gap-1.5 rounded bg-black/15 p-2">
        <InspectorSelect label="Biome" value={biome} onChange={onBiomeChange}
          options={biomeOptions.map((option) => [option.id, option.label] as const)} />
        {slider("Alpine tree density", treeDensity, 0, INSPECTOR_BOUNDS.propDensity, 0.05, onTreeDensityChange, treeDensityDefault, "×")}
        {slider("Shrub density", shrubDensity, 0, INSPECTOR_BOUNDS.propDensity, 0.05, onShrubDensityChange, shrubDensityDefault, "×")}
        {slider("Trees among shrubs", shrubTreeShare, 0, 0.6, 0.01, onShrubTreeShareChange, shrubTreeShareDefault)}
        {slider("Clustering", clustering, 0, 1, 0.05, onClusteringChange, biomeClusteringDefault)}
        <InspectorColor label="Tree color" value={treeColor} disabled={disabled} onChange={onTreeColorChange} />
        <InspectorColor label="Shrub color" value={shrubColor} disabled={disabled} onChange={onShrubColorChange} />
        <InspectorNote>Tree color also paints the trees among the shrubs.</InspectorNote>
      </div>
      <InspectorFold title="Forest stands">
        {standControls.map(({ key, label, min, max, step }) => slider(label, settings[key], min, max, step,
          (value) => update(key, value), defaults?.[key], "×", FOREST_SETTING_LIMITS[key]))}
      </InspectorFold>
      <InspectorFold title="Advanced wash, shading and ink">
        {numericControls.map(({ key, label, min, max, step }) => slider(label, settings[key], min, max, step,
          (value) => update(key, value), defaults?.[key], key === "hueVariance" ? "°" : key === "canopyMerging" ? "" : undefined,
          FOREST_SETTING_LIMITS[key]))}
        <InspectorColor label="Cone light color" value={settings.lightColor} disabled={disabled} onChange={(color) => update("lightColor", color)} />
        <InspectorToggle label="Center-depth debug" checked={settings.showCenterDebug} disabled={disabled} onChange={(checked) => update("showCenterDebug", checked)} />
        <InspectorToggle label="Ground reservations" checked={settings.showFootprints} disabled={disabled} onChange={(checked) => update("showFootprints", checked)} />
      </InspectorFold>
      <InspectorFold title="Source artwork">
        {slider("Preview zoom", sourceZoom, 0.2, 1.5, 0.05, onSourceZoomChange, undefined, "×")}
        <div className="grid grid-cols-4 gap-1">
          {sourceUrls.map((url, index) => <img key={url} src={url} alt={`Prop source ${index + 1}`}
            style={{ transform: `scale(${sourceZoom})` }}
            className="aspect-square w-full rounded bg-slate-200 object-contain p-1" />)}
        </div>
      </InspectorFold>
    </div>
  );
}

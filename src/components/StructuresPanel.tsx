/**
 * Structures inspector tab: roads (routed over the terrain) and towns.
 */
import { useState, type ReactNode } from "react";
import { Eye, EyeOff, Loader2, Plus, RotateCcw, Shuffle, Trash2, Upload, X } from "lucide-react";
import { InspectorColor, InspectorFold, InspectorNote, InspectorSection, InspectorSelect, InspectorToggle } from "./InspectorParts";
import { NumericControl } from "./NumericControl";
import { RoadStylePreview } from "./RoadStylePreview";
import { generatePOIName } from "../utils/fantasyNames";
import type { StructuresEditor } from "../structures/useStructuresEditor";
import { settlementIconUrl, townIconUrl } from "../structures/iconStore";
import {
  DEFAULT_ROAD_STYLE,
  DEFAULT_ROAD_KIND_STYLE,
  DEFAULT_ROUTING_SETTINGS,
  DEFAULT_TOWN_SIZE,
  DEFAULT_TOWN_STYLE,
  randomTownSeed,
  ROAD_KIND_LABELS,
  roadKindStyle,
  SETTLEMENT_ICON_PREFIX,
  SETTLEMENT_KINDS,
  settlementOfIcon,
  TOWN_FONT_STACKS,
  type RoadKind,
  type RoadKindStyle,
  type RoadStyle,
  type TownFont,
  type TownLabelPosition,
  type Town,
  type TownStyle,
} from "../structures/types";

interface StructuresPanelProps {
  editor: StructuresEditor;
  onStartRoad: () => void;
  onStartTown: () => void;
}

function TextField({ label, value, placeholder, onChange }: {
  label: string; value: string; placeholder?: string; onChange: (value: string) => void;
}) {
  return <label className="flex items-center justify-between gap-2 py-0.5 text-[12px] text-slate-300">
    <span className="shrink-0">{label}</span>
    <input type="text" value={value} placeholder={placeholder} maxLength={120}
      onChange={(event) => onChange(event.target.value)}
      className="w-[62%] min-w-0 rounded border border-white/10 bg-white/5 px-2 py-1 text-[12px] text-slate-100 outline-none placeholder:text-slate-500 focus:ring-1 focus:ring-sky-500" />
  </label>;
}

function ListRow({ selected, onSelect, children, actions }: {
  selected: boolean; onSelect: () => void; children: ReactNode; actions: ReactNode;
}) {
  return <div className={`flex items-center gap-1 rounded px-1.5 py-1 text-[12px] ${selected ? "bg-sky-600/25 text-white" : "text-slate-300 hover:bg-white/5"}`}>
    <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">{children}</button>
    {actions}
  </div>;
}

const iconButton = "rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-100";

/** Whole-number seed with a button that rolls a new one. */
function SeedField({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  // Typed text while editing; null shows the seed itself.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const parsed = Number.parseInt(draft ?? "", 10);
    if (Number.isFinite(parsed) && parsed >= 0) onChange(parsed >>> 0);
    setDraft(null);
  };
  return <label className="flex items-center justify-between gap-2 py-0.5 text-[12px] text-slate-300"
    title="Picks the buildings and their layout. Each town keeps its own seed.">
    <span className="shrink-0">Layout seed</span>
    <span className="flex w-[62%] min-w-0 items-center gap-1">
      <input type="text" inputMode="numeric" value={draft ?? String(value)} onChange={(event) => setDraft(event.target.value)}
        onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        className="min-w-0 flex-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-[12px] tabular-nums text-slate-100 outline-none focus:ring-1 focus:ring-sky-500" />
      <button type="button" className={iconButton} title="New layout" aria-label="New layout"
        onClick={() => onChange(randomTownSeed())}><Shuffle size={12} /></button>
    </span>
  </label>;
}

/**
 * Switching icon carries the size along when it was still the old icon's
 * default, so a hamlet turned into a city grows with it.
 */
function iconPatch(town: Town, iconId: string): Partial<Town> {
  const previousDefault = settlementOfIcon(town.iconId)?.defaultSize ?? DEFAULT_TOWN_SIZE;
  const nextDefault = settlementOfIcon(iconId)?.defaultSize ?? DEFAULT_TOWN_SIZE;
  return town.size === previousDefault ? { iconId, size: nextDefault } : { iconId };
}

const iconTile = (selected: boolean) =>
  `flex aspect-square items-center justify-center rounded border p-1 ${selected ? "border-sky-500 bg-sky-600/20" : "border-white/10 bg-white/5 hover:bg-white/10"}`;

function Stat({ label, value }: { label: string; value: string }) {
  return <>
    <span className="text-slate-500">{label}</span>
    <span className="text-right tabular-nums text-slate-200">{value}</span>
  </>;
}

function RoadTypeControls({ kind, value, style, onChange, onReset }: {
  kind: RoadKind; value: RoadKindStyle; style: RoadStyle;
  onChange: (patch: Partial<RoadKindStyle>) => void; onReset: () => void;
}) {
  const defaults = DEFAULT_ROAD_KIND_STYLE;
  const setField = <K extends keyof RoadKindStyle>(key: K) => (next: RoadKindStyle[K]) => onChange({ [key]: next });
  return <InspectorFold title={ROAD_KIND_LABELS[kind]} defaultOpen={kind === "road"}>
    <button type="button" onClick={onReset} aria-label={`Reset ${ROAD_KIND_LABELS[kind].toLowerCase()} style`}
      className="flex items-center gap-1 self-end text-[11px] text-slate-400 hover:text-slate-100">
      <RotateCcw size={11} /> Reset style
    </button>
    <RoadStylePreview style={style} kind={kind} />
    <NumericControl label="Width" value={value.width} min={0.5} max={16} step={0.1} unit="px"
      defaultValue={defaults.width} limits={[0.2, 40]} onChange={setField("width")} />
    <InspectorColor label="Color" value={value.color} onChange={setField("color")} />
    <NumericControl label="Dash spacing" value={value.dashSpacing} min={0} max={40} step={0.5} unit="px"
      defaultValue={defaults.dashSpacing} limits={[0, 100]} onChange={setField("dashSpacing")}
      title="Gap between dashes. Set to 0 for a continuous line." />
    <NumericControl label="Section length" value={value.dashLength} min={2} max={60} step={0.5} unit="px"
      defaultValue={defaults.dashLength} limits={[1, 200]} disabled={value.dashSpacing === 0} onChange={setField("dashLength")}
      title="Length of each dash. Only used when dash spacing is above 0." />
    <InspectorFold title="Outline">
      <InspectorToggle label="Outline" checked={value.outline} onChange={setField("outline")} />
      <InspectorColor label="Outline color" value={value.outlineColor} disabled={!value.outline} onChange={setField("outlineColor")} />
      <NumericControl label="Outline width" value={value.outlineWidth} min={0} max={6} step={0.1} unit="px"
        defaultValue={defaults.outlineWidth} limits={[0, 12]} disabled={!value.outline} onChange={setField("outlineWidth")} />
    </InspectorFold>
    <InspectorFold title="Shadow">
      <NumericControl label="Shadow opacity" value={value.shadowOpacity} min={0} max={1} step={0.01} unit="%"
        defaultValue={defaults.shadowOpacity} onChange={setField("shadowOpacity")} />
      <InspectorColor label="Shadow color" value={value.shadowColor} disabled={value.shadowOpacity === 0} onChange={setField("shadowColor")} />
      <NumericControl label="Shadow offset" value={value.shadowOffset} min={0} max={12} step={0.1} unit="px"
        defaultValue={defaults.shadowOffset} limits={[0, 40]} disabled={value.shadowOpacity === 0} onChange={setField("shadowOffset")} />
      <NumericControl label="Shadow blur" value={value.shadowBlur} min={0} max={10} step={0.1} unit="px"
        defaultValue={defaults.shadowBlur} limits={[0, 20]} disabled={value.shadowOpacity === 0} onChange={setField("shadowBlur")}
        title="How far the shadow edge fades out." />
    </InspectorFold>
  </InspectorFold>;
}

export function StructuresPanel({ editor, onStartRoad, onStartTown }: StructuresPanelProps) {
  const {
    structures, routes, routingRoadIds, routing, setRouting, selection, setSelection, icons,
    roadStyle, setRoadStyle, townStyle, setTownStyle,
  } = editor;
  const setRoadField = <K extends keyof RoadStyle>(key: K) => (value: RoadStyle[K]) =>
    setRoadStyle((previous) => ({ ...previous, [key]: value }));
  const setLabelField = <K extends keyof TownStyle>(key: K) => (value: TownStyle[K]) =>
    setTownStyle((previous) => ({ ...previous, [key]: value }));
  const selectedRoad = selection?.kind === "road"
    ? structures.roads.find((road) => road.id === selection.id)
    : undefined;
  const selectedTown = selection?.kind === "town"
    ? structures.towns.find((town) => town.id === selection.id)
    : undefined;
  const selectedRoute = selectedRoad ? routes[selectedRoad.id] : undefined;
  const uploadedIcons = icons.filter((icon) => !icon.builtin);

  return <>
    {editor.storageError && (
      <div className="mx-4 mt-3 flex items-start gap-2 rounded border border-amber-700/60 bg-amber-950/40 px-2 py-1.5 text-[11px] text-amber-200">
        <span className="flex-1">{editor.storageError}</span>
        <button type="button" onClick={editor.clearStorageError} aria-label="Dismiss" className="text-amber-300 hover:text-white"><X size={12} /></button>
      </div>
    )}

    <InspectorSection title="Roads" aside={
      <button type="button" onClick={onStartRoad}
        className="flex items-center gap-1 rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-500">
        <Plus size={12} /> New road
      </button>}>
      {structures.roads.length === 0
        ? <InspectorNote>Click New road, then click the map to add points. The road is routed between them, around steep ground and across rivers at good crossings.</InspectorNote>
        : <div className="flex flex-col gap-0.5">
          {structures.roads.map((road) => <ListRow key={road.id} selected={selectedRoad?.id === road.id}
            onSelect={() => setSelection({ kind: "road", id: road.id })}
            actions={<>
              <button type="button" className={iconButton} aria-label={road.visible ? `Hide ${road.name}` : `Show ${road.name}`}
                onClick={() => editor.updateRoad(road.id, { visible: !road.visible })}>
                {road.visible ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
              <button type="button" className={iconButton} aria-label={`Delete ${road.name}`} onClick={() => editor.deleteRoad(road.id)}>
                <Trash2 size={12} />
              </button>
            </>}>
            {routingRoadIds.has(road.id) && <Loader2 size={11} className="shrink-0 animate-spin text-sky-300" aria-label="Routing" />}
            <span className={`truncate ${road.visible ? "" : "text-slate-500"}`}>{road.name}</span>
            <span className="ml-auto shrink-0 text-[11px] text-slate-500">{road.waypoints.length} pts</span>
          </ListRow>)}
        </div>}
      {selectedRoad && <div className="mt-2 flex flex-col gap-1 border-t border-white/5 pt-2">
        <TextField label="Name" value={selectedRoad.name} onChange={(name) => editor.updateRoad(selectedRoad.id, { name })} />
        <InspectorSelect label="Type" value={selectedRoad.kind}
          options={(Object.keys(ROAD_KIND_LABELS) as RoadKind[]).map((kind) => [kind, ROAD_KIND_LABELS[kind]] as const)}
          onChange={(kind) => editor.updateRoad(selectedRoad.id, { kind })} />
        <InspectorFold title="Route details">
          {selectedRoad.waypoints.length < 2
            ? <InspectorNote>Click the map to add at least two points.</InspectorNote>
            : selectedRoute && <div className="grid grid-cols-[auto_auto] justify-between gap-x-3 gap-y-0.5 text-[12px]">
              <Stat label="Length" value={`${selectedRoute.lengthKm.toFixed(1)} km`} />
              <Stat label="Total climb" value={`${Math.round(selectedRoute.ascentM).toLocaleString()} m`} />
              <Stat label="Steepest grade" value={`${selectedRoute.maxGradePct.toFixed(0)} %`} />
              <Stat label="Bridges" value={String(selectedRoute.bridgeCount)} />
              {selectedRoute.fordCount > 0 && <Stat label="Fords" value={String(selectedRoute.fordCount)} />}
            </div>}
          {selectedRoute?.blocked && <InspectorNote>Part of this road is cut off by sea or lake and is drawn as a straight line.</InspectorNote>}
          <InspectorNote>Click the road to add a steering point. Drag points to move them (or use the Select tool, V); Delete removes the selected point; Enter finishes the road.</InspectorNote>
        </InspectorFold>
      </div>}
    </InspectorSection>

    <InspectorSection title="Road routing">
      <InspectorFold title="Terrain avoidance" defaultOpen>
        <NumericControl label="Max grade" value={routing.maxGradePct / 100} min={0.03} max={0.25} step={0.005} unit="%"
          defaultValue={DEFAULT_ROUTING_SETTINGS.maxGradePct / 100} limits={[0.03, 0.3]}
          title="Comfortable climb for a standard road. Tracks accept 1.5× this, highways two thirds."
          onChange={(value) => setRouting((previous) => ({ ...previous, maxGradePct: value * 100 }))} />
        <NumericControl label="Slope avoidance" value={routing.slopeAvoidance} min={0} max={3} step={0.1} unit="×"
          defaultValue={DEFAULT_ROUTING_SETTINGS.slopeAvoidance}
          title="How strongly roads detour to stay on gentle ground below the maximum grade."
          onChange={(value) => setRouting((previous) => ({ ...previous, slopeAvoidance: value }))} />
        <NumericControl label="Forest avoidance" value={routing.forestAvoidance} min={0} max={3} step={0.1} unit="×"
          defaultValue={DEFAULT_ROUTING_SETTINGS.forestAvoidance}
          title="How strongly roads steer around forest and shrub stands. Uses the stands drawn on the Map view."
          onChange={(value) => setRouting((previous) => ({ ...previous, forestAvoidance: value }))} />
      </InspectorFold>
      <InspectorFold title="Water crossings">
        <NumericControl label="Bridge reluctance" value={routing.bridgeReluctanceKm} min={0} max={10} step={0.1} unit="km"
          defaultValue={DEFAULT_ROUTING_SETTINGS.bridgeReluctanceKm} limits={[0, 10]}
          title="Fixed cost of a bridge, as km of detour, before its length is counted."
          onChange={(value) => setRouting((previous) => ({ ...previous, bridgeReluctanceKm: value }))} />
        <NumericControl label="Typical bridge" value={routing.typicalBridgeLengthM} min={20} max={500} step={5} unit="m"
          defaultValue={DEFAULT_ROUTING_SETTINGS.typicalBridgeLengthM} limits={[10, 2000]}
          title="Bridges longer than this get steeply more expensive, so a short detour to a narrower crossing wins."
          onChange={(value) => setRouting((previous) => ({ ...previous, typicalBridgeLengthM: value }))} />
        <NumericControl label="Max bridge length" value={routing.maxBridgeLengthM} min={40} max={1500} step={10} unit="m"
          defaultValue={DEFAULT_ROUTING_SETTINGS.maxBridgeLengthM} limits={[20, 3000]}
          title="Longest bridge, bank to bank. Wider water is routed around."
          onChange={(value) => setRouting((previous) => ({ ...previous, maxBridgeLengthM: value }))} />
        <InspectorToggle label="Ford small streams" checked={routing.allowFords}
          onChange={(allowFords) => setRouting((previous) => ({ ...previous, allowFords }))} />
      </InspectorFold>
      <InspectorFold title="Switchbacks">
        <NumericControl label="Straightness" value={routing.straightness} min={0} max={1} step={0.01} unit="%"
          defaultValue={DEFAULT_ROUTING_SETTINGS.straightness}
          title="On climbs only: how readily wiggles become long straight legs and switchbacks. Level stretches keep natural curves."
          onChange={(value) => setRouting((previous) => ({ ...previous, straightness: value }))} />
        <NumericControl label="Min leg length" value={routing.minLegLengthM} min={0} max={800} step={10} unit="m"
          defaultValue={DEFAULT_ROUTING_SETTINGS.minLegLengthM} limits={[0, 2000]}
          title="On climbs: the shortest stretch between two turns. Shorter zigzags are rebuilt as longer switchbacks."
          onChange={(value) => setRouting((previous) => ({ ...previous, minLegLengthM: value }))} />
      </InspectorFold>
    </InspectorSection>

    <InspectorSection title="Road style" aside={
      <button type="button" className={iconButton} title="Reset road style" aria-label="Reset road style"
        onClick={() => setRoadStyle({ ...DEFAULT_ROAD_STYLE })}><RotateCcw size={12} /></button>}>
      <InspectorNote>All types use the same line. Style each type below; pixel sizes refer to a 2048px map.</InspectorNote>
      {(Object.keys(ROAD_KIND_LABELS) as RoadKind[]).map((kind) => <RoadTypeControls key={kind} kind={kind}
        value={roadKindStyle(roadStyle, kind)} style={roadStyle}
        onChange={(patch) => setRoadStyle((previous) => ({ ...previous,
          byKind: { ...previous.byKind, [kind]: { ...previous.byKind?.[kind], ...patch } },
        }))}
        onReset={() => setRoadStyle((previous) => ({ ...previous,
          byKind: { ...previous.byKind, [kind]: { ...DEFAULT_ROAD_KIND_STYLE } },
        }))} />)}
      <InspectorFold title="Shared settings">
        <NumericControl label="Opacity" value={roadStyle.opacity} min={0} max={1} step={0.01} unit="%"
          defaultValue={DEFAULT_ROAD_STYLE.opacity} onChange={setRoadField("opacity")} />
        <InspectorToggle label="Charcoal outline" checked={roadStyle.handDrawn} onChange={setRoadField("handDrawn")}
          title="Draw road outlines with the map's charcoal pen texture. Lines and dashes stay clean." />
        <InspectorColor label="Bridge deck" value={roadStyle.bridgeColor} onChange={setRoadField("bridgeColor")} />
        <InspectorColor label="Bridge outline" value={roadStyle.bridgeOutlineColor} onChange={setRoadField("bridgeOutlineColor")} />
        <NumericControl label="Bridge outline width" value={roadStyle.bridgeOutlineWidth} min={0.2} max={4} step={0.1} unit="px"
          defaultValue={DEFAULT_ROAD_STYLE.bridgeOutlineWidth} limits={[0.2, 8]} onChange={setRoadField("bridgeOutlineWidth")}
          title="Thickness of the lines drawn around a bridge and along its side sections." />
        <NumericControl label="Tree clearance" value={roadStyle.clearance} min={0} max={20} step={0.5} unit="px"
          defaultValue={DEFAULT_ROAD_STYLE.clearance} limits={[0, 40]} onChange={setRoadField("clearance")}
          title="Corridor beside the road kept free of trees, shrubs and boulders." />
      </InspectorFold>
    </InspectorSection>

    <InspectorSection title="Towns" aside={
      <button type="button" onClick={onStartTown}
        className="flex items-center gap-1 rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-500">
        <Plus size={12} /> Place town
      </button>}>
      {structures.towns.length === 0
        ? <InspectorNote>Click Place town, then click the map. Drag a town with the Select tool (V) to move it.</InspectorNote>
        : <div className="flex flex-col gap-0.5">
          {structures.towns.map((town) => <ListRow key={town.id} selected={selectedTown?.id === town.id}
            onSelect={() => setSelection({ kind: "town", id: town.id })}
            actions={<button type="button" className={iconButton} aria-label={`Delete ${town.name}`} onClick={() => editor.deleteTown(town.id)}>
              <Trash2 size={12} />
            </button>}>
            <img src={townIconUrl(town, icons)} alt="" className="h-4 w-4 shrink-0 object-contain" />
            <span className="truncate">{town.name || "Unnamed"}</span>
          </ListRow>)}
        </div>}
      {selectedTown && <div className="mt-2 flex flex-col gap-1 border-t border-white/5 pt-2">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <TextField label="Name" value={selectedTown.name} onChange={(name) => editor.updateTown(selectedTown.id, { name })} />
          </div>
          <button type="button" className={iconButton} title="Random name" aria-label="Random name"
            onClick={() => editor.updateTown(selectedTown.id, { name: generatePOIName("town", Math.floor(Math.random() * 1e9)) })}>
            <Shuffle size={12} />
          </button>
        </div>
        <InspectorFold title="Label" defaultOpen>
          <TextField label="Subtitle" value={selectedTown.subtitle ?? ""} placeholder="e.g. Market town"
            onChange={(subtitle) => editor.updateTown(selectedTown.id, { subtitle: subtitle || undefined })} />
          <InspectorToggle label="Show label" checked={selectedTown.showLabel}
            onChange={(showLabel) => editor.updateTown(selectedTown.id, { showLabel })} />
          <InspectorSelect<TownLabelPosition> label="Label position" value={selectedTown.labelPosition}
            options={[["below", "Below"], ["right", "Right"], ["above", "Above"]]}
            disabled={!selectedTown.showLabel}
            onChange={(labelPosition) => editor.updateTown(selectedTown.id, { labelPosition })} />
          <NumericControl label="Label offset" value={selectedTown.labelOffset ?? 0} min={-40} max={80} step={1} unit="px"
            defaultValue={0} limits={[-160, 320]} disabled={!selectedTown.showLabel}
            title="Extra distance from the town icon. Negative values move the label closer; pixels refer to a 2048px map."
            onChange={(labelOffset) => editor.updateTown(selectedTown.id, { labelOffset })} />
        </InspectorFold>
        <InspectorFold title="Settlement" defaultOpen>
          <NumericControl label="Size" value={selectedTown.size} min={16} max={160} step={1} unit="px" limits={[8, 160]}
            defaultValue={DEFAULT_TOWN_SIZE} onChange={(size) => editor.updateTown(selectedTown.id, { size })} />
          <div role="radiogroup" aria-label="Settlement" className="grid grid-cols-3 gap-1">
            {SETTLEMENT_KINDS.map((settlement) => {
              const iconId = SETTLEMENT_ICON_PREFIX + settlement.kind;
              const selected = selectedTown.iconId === iconId;
              return <button type="button" role="radio" key={iconId} aria-checked={selected} title={settlement.label}
                onClick={() => editor.updateTown(selectedTown.id, iconPatch(selectedTown, iconId))}
                className={`${iconTile(selected)} flex-col gap-0.5`}>
                <img src={settlementIconUrl(settlement.kind, selectedTown.seed)} alt="" className="min-h-0 max-w-full flex-1 object-contain" />
                <span className="text-[10px] leading-none text-slate-400">{settlement.label}</span>
              </button>;
            })}
          </div>
          {settlementOfIcon(selectedTown.iconId) && <SeedField value={selectedTown.seed}
            onChange={(seed) => editor.updateTown(selectedTown.id, { seed })} />}
        </InspectorFold>
        {icons.length > 0 && <>
          <InspectorFold title="Uploaded symbols">
            <div role="radiogroup" aria-label="Uploaded town symbol" className="grid grid-cols-6 gap-1">
              {icons.map((icon) => <button type="button" role="radio" key={icon.id} aria-checked={selectedTown.iconId === icon.id}
                title={icon.name} onClick={() => editor.updateTown(selectedTown.id, iconPatch(selectedTown, icon.id))}
                className={iconTile(selectedTown.iconId === icon.id)}>
                <img src={icon.url} alt={icon.name} className="max-h-full max-w-full object-contain" />
              </button>)}
            </div>
          </InspectorFold>
        </>}
      </div>}
    </InspectorSection>

    <InspectorSection title="Label style" aside={
      <button type="button" className={iconButton} title="Reset label style" aria-label="Reset label style"
        onClick={() => setTownStyle({ ...DEFAULT_TOWN_STYLE })}><RotateCcw size={12} /></button>}>
      <InspectorFold title="Typography" defaultOpen>
        <InspectorSelect<TownFont> label="Font" value={townStyle.font} onChange={setLabelField("font")}
          options={(Object.keys(TOWN_FONT_STACKS) as TownFont[]).map((font) => [font, TOWN_FONT_STACKS[font].label] as const)} />
        <InspectorToggle label="Bold names" checked={townStyle.bold} onChange={setLabelField("bold")} />
        <InspectorToggle label="Uppercase" checked={townStyle.uppercase} onChange={setLabelField("uppercase")} />
        <InspectorToggle label="Italic subtitle" checked={townStyle.subtitleItalic} onChange={setLabelField("subtitleItalic")} />
        <InspectorColor label="Text color" value={townStyle.textColor} onChange={setLabelField("textColor")} />
        <InspectorNote>Fonts come from this computer; a missing font falls back to a similar one.</InspectorNote>
      </InspectorFold>
      <InspectorFold title="Size and spacing" defaultOpen>
        <NumericControl label="Name size" value={townStyle.labelScale} min={0.4} max={2.5} step={0.05} unit="×"
          defaultValue={DEFAULT_TOWN_STYLE.labelScale} limits={[0.3, 4]} onChange={setLabelField("labelScale")} />
        <NumericControl label="Subtitle size" value={townStyle.subtitleScale} min={0.4} max={1.2} step={0.02} unit="×"
          defaultValue={DEFAULT_TOWN_STYLE.subtitleScale} limits={[0.3, 1.5]} onChange={setLabelField("subtitleScale")} />
        <NumericControl label="Letter spacing" value={townStyle.letterSpacing} min={0} max={0.5} step={0.01} unit="em"
          defaultValue={DEFAULT_TOWN_STYLE.letterSpacing} limits={[-0.1, 1]} onChange={setLabelField("letterSpacing")} />
      </InspectorFold>
      <InspectorFold title="Outline">
        <InspectorColor label="Outline color" value={townStyle.haloColor} onChange={setLabelField("haloColor")} />
        <NumericControl label="Outline width" value={townStyle.haloWidth} min={0} max={3} step={0.05} unit="×"
          defaultValue={DEFAULT_TOWN_STYLE.haloWidth} limits={[0, 4]} onChange={setLabelField("haloWidth")} />
        <NumericControl label="Outline opacity" value={townStyle.haloOpacity} min={0} max={1} step={0.01} unit="%"
          defaultValue={DEFAULT_TOWN_STYLE.haloOpacity} onChange={setLabelField("haloOpacity")} />
      </InspectorFold>
    </InspectorSection>

    <InspectorSection title="Town icons">
      <InspectorNote>Upload PNG icons to use for towns. They are kept in this browser.</InspectorNote>
      <label className="flex cursor-pointer items-center justify-center gap-1.5 rounded border border-dashed border-white/15 bg-white/5 px-2 py-1.5 text-[12px] text-slate-200 hover:bg-white/10">
        <Upload size={12} /> Upload PNG…
        <input type="file" accept="image/png,image/webp,image/jpeg" className="sr-only" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void editor.uploadIcon(file).then((icon) => {
            if (icon && selectedTown) editor.updateTown(selectedTown.id, { iconId: icon.id });
          });
        }} />
      </label>
      {uploadedIcons.length > 0 && <div className="flex flex-col gap-0.5">
        {uploadedIcons.map((icon) => <div key={icon.id} className="flex items-center gap-2 px-1.5 py-0.5 text-[12px] text-slate-300">
          <img src={icon.url} alt="" className="h-5 w-5 object-contain" />
          <span className="min-w-0 flex-1 truncate">{icon.name}</span>
          <button type="button" className={iconButton} aria-label={`Delete icon ${icon.name}`} onClick={() => void editor.removeIcon(icon.id)}>
            <Trash2 size={12} />
          </button>
        </div>)}
      </div>}
    </InspectorSection>
  </>;
}

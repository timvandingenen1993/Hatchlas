/**
 * Structures: user-placed roads and towns. Positions are normalized map
 * coordinates (u = 0..1 left to right, v = 0..1 top to bottom), so they stay
 * valid across DEM resolution, preview size and export size.
 */

export interface MapPoint {
  u: number;
  v: number;
}

export interface Waypoint extends MapPoint {
  id: string;
}

export type RoadKind = "track" | "road" | "highway";

/** "auto" follows the road kind: tracks dashed, roads solid, highways double. */
export type RoadLineStyle = "auto" | "solid" | "dashed" | "dotted" | "double";

export interface Road {
  id: string;
  name: string;
  kind: RoadKind;
  /** Optional ink color; falls back to the road style color. */
  color?: string;
  /** Line pattern override; defaults to "auto". */
  lineStyle?: RoadLineStyle;
  /** Width multiplier on top of the road style width; defaults to 1. */
  widthScale?: number;
  waypoints: Waypoint[];
  visible: boolean;
}

/** A contiguous run of route points that crosses water. Indices are inclusive. */
export interface RouteCrossing {
  from: number;
  to: number;
  /** Small streams are forded instead of bridged. */
  ford: boolean;
}

export interface RoadRoute {
  points: MapPoint[];
  bridges: RouteCrossing[];
  lengthKm: number;
  ascentM: number;
  maxGradePct: number;
  bridgeCount: number;
  fordCount: number;
  /** True when at least one segment could not be routed and fell back to a straight line. */
  blocked: boolean;
}

/** Default icon size, in pixels of a 2048px wide frame. */
export const DEFAULT_TOWN_SIZE = 56;

export type TownLabelPosition = "below" | "right" | "above";

/** Settlements drawn from building parts; each town's seed picks its layout. */
export type SettlementKind = "hamlet" | "village" | "keep" | "walled-town" | "castle" | "city";

export interface SettlementInfo {
  kind: SettlementKind;
  label: string;
  /** Icon size a new town of this kind starts at, in 2048px frame pixels. */
  defaultSize: number;
}

export const SETTLEMENT_KINDS: readonly SettlementInfo[] = [
  { kind: "hamlet", label: "Hamlet", defaultSize: 34 },
  { kind: "village", label: "Village", defaultSize: 46 },
  { kind: "keep", label: "Keep", defaultSize: 38 },
  { kind: "walled-town", label: "Walled town", defaultSize: 60 },
  { kind: "castle", label: "Castle", defaultSize: 56 },
  { kind: "city", label: "City", defaultSize: 88 },
];

/** Icon ids of settlement kinds are this prefix plus the kind. */
export const SETTLEMENT_ICON_PREFIX = "settlement:";
export const DEFAULT_TOWN_ICON_ID = `${SETTLEMENT_ICON_PREFIX}village`;
export function randomTownSeed(): number {
  return Math.floor(Math.random() * 1e9);
}

export function settlementOfIcon(iconId: string): SettlementInfo | undefined {
  return iconId.startsWith(SETTLEMENT_ICON_PREFIX)
    ? SETTLEMENT_KINDS.find((info) => SETTLEMENT_ICON_PREFIX + info.kind === iconId)
    : undefined;
}

export interface Town extends MapPoint {
  id: string;
  name: string;
  subtitle?: string;
  /** A settlement kind (see SETTLEMENT_ICON_PREFIX), a symbol or an uploaded icon. */
  iconId: string;
  /** Picks the buildings of a settlement icon; other icons ignore it. */
  seed: number;
  /** Icon size in pixels at the 2048px reference frame width. */
  size: number;
  labelPosition: TownLabelPosition;
  showLabel: boolean;
}

export interface RoutingSettings {
  /** Comfortable maximum grade, in percent, for a standard road. */
  maxGradePct: number;
  /** 0..3, how strongly grades below the maximum are avoided. */
  slopeAvoidance: number;
  /** Fixed cost of one bridge, as km of detour, before its length is counted. */
  bridgeReluctanceKm: number;
  /** Small streams (Strahler order <= 2) may be forded cheaply. */
  allowFords: boolean;
  /** 0..3, how strongly roads steer around forest and shrub stands. */
  forestAvoidance: number;
  /** Longest bridge or ford, bank to bank, in metres. Wider water is avoided. */
  maxBridgeLengthM: number;
  /** Bridges longer than this get steeply more expensive, in metres. */
  typicalBridgeLengthM: number;
  /** 0..1, how readily climbs are straightened into long legs and switchbacks. */
  straightness: number;
  /** Shortest leg between two turns on a climb, in metres. */
  minLegLengthM: number;
}

export const DEFAULT_ROUTING_SETTINGS: RoutingSettings = {
  maxGradePct: 12,
  slopeAvoidance: 1.5,
  bridgeReluctanceKm: 0.6,
  allowFords: true,
  forestAvoidance: 1,
  maxBridgeLengthM: 300,
  typicalBridgeLengthM: 150,
  straightness: 0.5,
  minLegLengthM: 200,
};

/** Map-wide road appearance. Widths are pixels of a 2048px wide frame. */
export interface RoadStyle {
  color: string;
  opacity: number;
  widthScale: number;
  /** Charcoal pen: tapered strokes with seeded breaks; off draws clean, even lines. */
  handDrawn: boolean;
  /** 0..1 chance that a charcoal stroke ends in a break (hand-drawn only). */
  interruptions: number;
  /** Some breaks carry a single ink dot, like river marks (hand-drawn only). */
  gapDots: boolean;
  outline: boolean;
  outlineColor: string;
  outlineWidth: number;
  /** Centre of double-line roads. */
  fillColor: string;
  bridgeColor: string;
  /** Extra corridor, beyond the road edge, kept clear of trees and shrubs. */
  clearance: number;
}

export const DEFAULT_ROAD_STYLE: RoadStyle = {
  color: "#563a26",
  opacity: 1,
  widthScale: 1,
  handDrawn: true,
  interruptions: 0.3,
  gapDots: true,
  outline: false,
  outlineColor: "#f4ecd6",
  outlineWidth: 1.2,
  fillColor: "#eee2c4",
  bridgeColor: "#eee2c4",
  clearance: 2,
};

export type TownFont = "serif" | "oldstyle" | "garamond" | "didone" | "sans" | "script" | "blackletter";

export const TOWN_FONT_STACKS: Record<TownFont, { label: string; css: string }> = {
  serif: { label: "Serif (Georgia)", css: 'Georgia, "Times New Roman", serif' },
  oldstyle: { label: "Old style (Palatino)", css: '"Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif' },
  garamond: { label: "Garamond", css: 'Garamond, "EB Garamond", "Times New Roman", serif' },
  didone: { label: "Didone (Bodoni)", css: '"Bodoni MT", Didot, "Times New Roman", serif' },
  sans: { label: "Sans (Trebuchet)", css: '"Trebuchet MS", "Segoe UI", Helvetica, Arial, sans-serif' },
  script: { label: "Script", css: '"Segoe Script", "Brush Script MT", "Apple Chancery", cursive' },
  blackletter: { label: "Blackletter", css: '"Old English Text MT", "UnifrakturMaguntia", "Times New Roman", serif' },
};

/** Map-wide town label appearance. */
export interface TownStyle {
  font: TownFont;
  bold: boolean;
  textColor: string;
  haloColor: string;
  /** Halo thickness as a multiple of the default. 0 removes the halo. */
  haloWidth: number;
  haloOpacity: number;
  /** Name size as a multiple of the default (0.42 × icon size). */
  labelScale: number;
  /** Subtitle size relative to the name. */
  subtitleScale: number;
  /** Extra space between letters, in em. */
  letterSpacing: number;
  uppercase: boolean;
  subtitleItalic: boolean;
}

export const DEFAULT_TOWN_STYLE: TownStyle = {
  font: "serif",
  bold: true,
  textColor: "#2b2a26",
  haloColor: "#f7f4e8",
  haloWidth: 1,
  haloOpacity: 0.92,
  labelScale: 1,
  subtitleScale: 0.72,
  letterSpacing: 0,
  uppercase: false,
  subtitleItalic: true,
};

/** Grade tolerance multiplier per road kind, relative to `maxGradePct`. */
export const ROAD_KIND_GRADE_SCALE: Record<RoadKind, number> = {
  track: 1.5,
  road: 1,
  highway: 0.66,
};

export const ROAD_KIND_LABELS: Record<RoadKind, string> = {
  track: "Track",
  road: "Road",
  highway: "Highway",
};

export const ROAD_LINE_STYLE_LABELS: Record<RoadLineStyle, string> = {
  auto: "By type",
  solid: "Solid",
  dashed: "Dashed",
  dotted: "Dotted",
  double: "Double",
};

export interface MapStructures {
  roads: Road[];
  towns: Town[];
}

export interface IconAsset {
  id: string;
  name: string;
  builtin: boolean;
  /** Object or bundled asset URL usable as an <img> source. */
  url: string;
}

/** Road geometry handed to the renderer, already routed and smoothed. */
export interface RoadRenderPath {
  points: MapPoint[];
  kind: RoadKind;
  color?: string;
  lineStyle?: RoadLineStyle;
  widthScale?: number;
  bridges: RouteCrossing[];
}

export interface StructureRenderOptions {
  roads: RoadRenderPath[];
  style: RoadStyle;
}

export function createStructureId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

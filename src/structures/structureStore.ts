/**
 * Structures persistence. Roads, towns and routing settings live in
 * localStorage, keyed per heightmap source so each map keeps its own layout.
 * Routes are not stored: they depend on the analysed terrain and are
 * recomputed whenever the analysis changes.
 */
import {
  DEFAULT_ROAD_STYLE,
  DEFAULT_ROUTING_SETTINGS,
  DEFAULT_TOWN_SIZE,
  DEFAULT_TOWN_ICON_ID,
  DEFAULT_TOWN_STYLE,
  SETTLEMENT_ICON_PREFIX,
  TOWN_FONT_STACKS,
  type MapStructures,
  type Road,
  type RoadKind,
  type RoadLineStyle,
  type RoadStyle,
  type RoutingSettings,
  type Town,
  type TownFont,
  type TownLabelPosition,
  type TownStyle,
  type Waypoint,
} from "./types";

export const STRUCTURES_STORAGE_KEY = "hatchlas.structures.v1";

export interface StoredStructures {
  version: 1;
  maps: Record<string, MapStructures>;
  routing: RoutingSettings;
  roadStyle: RoadStyle;
  townStyle: TownStyle;
}

export function emptyStructures(): MapStructures {
  return { roads: [], towns: [] };
}

/** Structures are stored per heightmap source; positions are resolution-free. */
export function heightmapStructureKey(sourceName: string): string {
  return sourceName || "untitled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function text(value: unknown, fallback: string, maxLength = 120): string {
  return typeof value === "string" ? value.slice(0, maxLength) : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function hexColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Deterministic seed for towns saved before seeds existed. */
function stableSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return hash >>> 0;
}

const ROAD_KINDS: readonly RoadKind[] = ["track", "road", "highway"];
const ROAD_LINE_STYLES: readonly RoadLineStyle[] = ["auto", "solid", "dashed", "dotted", "double"];
const TOWN_FONTS = Object.keys(TOWN_FONT_STACKS) as TownFont[];
const LABEL_POSITIONS: readonly TownLabelPosition[] = ["below", "right", "above"];

function parseWaypoint(value: unknown): Waypoint | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  if (typeof value.u !== "number" || typeof value.v !== "number") return null;
  return { id: value.id, u: finite(value.u, 0.5, 0, 1), v: finite(value.v, 0.5, 0, 1) };
}

function parseRoad(value: unknown): Road | null {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.waypoints)) return null;
  const waypoints = value.waypoints.map(parseWaypoint).filter((point): point is Waypoint => point !== null);
  return {
    id: value.id,
    name: text(value.name, "Road"),
    kind: oneOf(value.kind, ROAD_KINDS, "road"),
    color: typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color) ? value.color : undefined,
    lineStyle: value.lineStyle === undefined ? undefined : oneOf(value.lineStyle, ROAD_LINE_STYLES, "auto"),
    widthScale: value.widthScale === undefined ? undefined : finite(value.widthScale, 1, 0.2, 5),
    waypoints,
    visible: value.visible !== false,
  };
}

/** Icons renamed or replaced since they were saved. The flat built-in
 * symbols became seeded settlements of the same kind. */
const ICON_RENAMES: Record<string, string> = {
  "builtin:hamlet": `${SETTLEMENT_ICON_PREFIX}hamlet`,
  "builtin:village": `${SETTLEMENT_ICON_PREFIX}village`,
  "builtin:town": `${SETTLEMENT_ICON_PREFIX}walled-town`,
  "builtin:walled-town": `${SETTLEMENT_ICON_PREFIX}walled-town`,
  "builtin:city": `${SETTLEMENT_ICON_PREFIX}city`,
  "builtin:castle": `${SETTLEMENT_ICON_PREFIX}castle`,
};

function parseTown(value: unknown): Town | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  if (typeof value.u !== "number" || typeof value.v !== "number") return null;
  const iconId = text(value.iconId, DEFAULT_TOWN_ICON_ID, 200);
  return {
    id: value.id,
    name: text(value.name, "Town"),
    subtitle: typeof value.subtitle === "string" && value.subtitle ? value.subtitle.slice(0, 120) : undefined,
    u: finite(value.u, 0.5, 0, 1),
    v: finite(value.v, 0.5, 0, 1),
    iconId: ICON_RENAMES[iconId] ?? iconId,
    seed: typeof value.seed === "number" && Number.isFinite(value.seed)
      ? Math.floor(value.seed) >>> 0
      : stableSeed(value.id),
    size: finite(value.size, DEFAULT_TOWN_SIZE, 8, 160),
    labelPosition: oneOf(value.labelPosition, LABEL_POSITIONS, "below"),
    showLabel: value.showLabel !== false,
  };
}

export function parseMapStructures(value: unknown): MapStructures {
  if (!isRecord(value)) return emptyStructures();
  const roads = Array.isArray(value.roads)
    ? value.roads.map(parseRoad).filter((road): road is Road => road !== null)
    : [];
  const towns = Array.isArray(value.towns)
    ? value.towns.map(parseTown).filter((town): town is Town => town !== null)
    : [];
  return { roads, towns };
}

export function parseRoutingSettings(value: unknown): RoutingSettings {
  const source = isRecord(value) ? value : {};
  return {
    maxGradePct: finite(source.maxGradePct, DEFAULT_ROUTING_SETTINGS.maxGradePct, 3, 30),
    slopeAvoidance: finite(source.slopeAvoidance, DEFAULT_ROUTING_SETTINGS.slopeAvoidance, 0, 3),
    bridgeReluctanceKm: finite(source.bridgeReluctanceKm, DEFAULT_ROUTING_SETTINGS.bridgeReluctanceKm, 0, 10),
    allowFords: flag(source.allowFords, DEFAULT_ROUTING_SETTINGS.allowFords),
    forestAvoidance: finite(source.forestAvoidance, DEFAULT_ROUTING_SETTINGS.forestAvoidance, 0, 3),
    maxBridgeLengthM: finite(source.maxBridgeLengthM, DEFAULT_ROUTING_SETTINGS.maxBridgeLengthM, 20, 3000),
    typicalBridgeLengthM: finite(source.typicalBridgeLengthM, DEFAULT_ROUTING_SETTINGS.typicalBridgeLengthM, 10, 2000),
    straightness: finite(source.straightness, DEFAULT_ROUTING_SETTINGS.straightness, 0, 1),
    minLegLengthM: finite(source.minLegLengthM, DEFAULT_ROUTING_SETTINGS.minLegLengthM, 0, 2000),
  };
}

export function parseRoadStyle(value: unknown): RoadStyle {
  const source = isRecord(value) ? value : {};
  const fallback = DEFAULT_ROAD_STYLE;
  return {
    color: hexColor(source.color, fallback.color),
    opacity: finite(source.opacity, fallback.opacity, 0, 1),
    widthScale: finite(source.widthScale, fallback.widthScale, 0.2, 5),
    handDrawn: flag(source.handDrawn, fallback.handDrawn),
    interruptions: finite(source.interruptions, fallback.interruptions, 0, 1),
    gapDots: flag(source.gapDots, fallback.gapDots),
    outline: flag(source.outline, fallback.outline),
    outlineColor: hexColor(source.outlineColor, fallback.outlineColor),
    outlineWidth: finite(source.outlineWidth, fallback.outlineWidth, 0, 12),
    fillColor: hexColor(source.fillColor, fallback.fillColor),
    bridgeColor: hexColor(source.bridgeColor, fallback.bridgeColor),
    clearance: finite(source.clearance, fallback.clearance, 0, 40),
  };
}

export function parseTownStyle(value: unknown): TownStyle {
  const source = isRecord(value) ? value : {};
  const fallback = DEFAULT_TOWN_STYLE;
  return {
    font: oneOf(source.font, TOWN_FONTS, fallback.font),
    bold: flag(source.bold, fallback.bold),
    textColor: hexColor(source.textColor, fallback.textColor),
    haloColor: hexColor(source.haloColor, fallback.haloColor),
    haloWidth: finite(source.haloWidth, fallback.haloWidth, 0, 4),
    haloOpacity: finite(source.haloOpacity, fallback.haloOpacity, 0, 1),
    labelScale: finite(source.labelScale, fallback.labelScale, 0.3, 4),
    subtitleScale: finite(source.subtitleScale, fallback.subtitleScale, 0.3, 1.5),
    letterSpacing: finite(source.letterSpacing, fallback.letterSpacing, -0.1, 1),
    uppercase: flag(source.uppercase, fallback.uppercase),
    subtitleItalic: flag(source.subtitleItalic, fallback.subtitleItalic),
  };
}

export function parseStoredStructures(raw: string | null): StoredStructures {
  const fallback: StoredStructures = {
    version: 1,
    maps: {},
    routing: { ...DEFAULT_ROUTING_SETTINGS },
    roadStyle: { ...DEFAULT_ROAD_STYLE },
    townStyle: { ...DEFAULT_TOWN_STYLE },
  };
  if (!raw) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return fallback;
  const maps: Record<string, MapStructures> = {};
  if (isRecord(parsed.maps)) {
    for (const [key, value] of Object.entries(parsed.maps)) maps[key] = parseMapStructures(value);
  }
  return {
    version: 1,
    maps,
    routing: parseRoutingSettings(parsed.routing),
    roadStyle: parseRoadStyle(parsed.roadStyle),
    townStyle: parseTownStyle(parsed.townStyle),
  };
}

export function loadStoredStructures(storage?: Pick<Storage, "getItem">): StoredStructures {
  try {
    return parseStoredStructures((storage ?? window.localStorage).getItem(STRUCTURES_STORAGE_KEY));
  } catch {
    return parseStoredStructures(null);
  }
}

/** Returns an error message when the browser refused the write. */
export function saveStoredStructures(
  stored: StoredStructures,
  storage?: Pick<Storage, "setItem">,
): string | null {
  try {
    (storage ?? window.localStorage).setItem(STRUCTURES_STORAGE_KEY, JSON.stringify(stored));
    return null;
  } catch (error) {
    return error instanceof Error && error.name === "QuotaExceededError"
      ? "Browser storage is full; roads and towns were not saved."
      : "Could not save roads and towns to browser storage.";
  }
}

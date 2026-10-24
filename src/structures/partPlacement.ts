import { SETTLEMENT_KINDS, type SettlementKind } from "./types";

export const SETTLEMENT_ATTRIBUTE = "data-settlements";
export type PlacementRules = Readonly<Record<string, readonly SettlementKind[]>>;

/** These pieces are required to connect the enclosure, rather than placed as buildings. */
export const isLayoutPart = (name: string) => /^(wall-|gatehouse-|great-keep$|turret(?:-|$))/.test(name);

/** Keeps, great keeps and standalone towers share one slot per settlement. */
export const isKeepOrTowerPart = (name: string) => /^(keep|great-keep|tower)(?:-|$)/.test(name);

/** Existing generation rules, used until a part's placement is explicitly edited. */
export function defaultSettlements(name: string): readonly SettlementKind[] {
  if (/^wall-(gate|pier|tower)/.test(name)) return ["walled-town", "city"];
  if (name === "wall-drum" || /^(gatehouse-|great-keep$|turret)/.test(name)) return ["castle"];
  if (/^wall-(flat|steep)/.test(name)) return ["walled-town", "castle", "city"];
  if (/^wall-/.test(name)) return ["walled-town", "castle", "city"];
  if (name === "keep") return ["keep", "city"];
  if (name === "tower") return ["keep", "walled-town", "city"];
  if (/^castle-house-/.test(name)) return ["keep", "castle"];
  if (/^castle-/.test(name)) return ["castle"];
  if (/^cathedral-/.test(name)) return ["city"];
  if (/^church-/.test(name)) return ["village", "walled-town"];
  if (/^townhouse-/.test(name)) return ["village", "walled-town", "city"];
  return ["hamlet", "village", "walled-town", "city"];
}

/** Missing means defaults; an empty attribute explicitly disables the building everywhere. */
export function parseSettlements(value: string | undefined): readonly SettlementKind[] | undefined {
  if (value === undefined) return undefined;
  const names = value.trim().split(/\s+/).filter(Boolean);
  if (names.some((name) => !SETTLEMENT_KINDS.some(({ kind }) => kind === name))) {
    throw new Error("Unknown settlement type in building placement");
  }
  return SETTLEMENT_KINDS.filter(({ kind }) => names.includes(kind)).map(({ kind }) => kind);
}

interface PlaceablePart {
  name: string;
  settlements?: readonly SettlementKind[];
}

export function settlementChoices(part: PlaceablePart, rules: PlacementRules = {}): readonly SettlementKind[] {
  return rules[part.name] ?? part.settlements ?? defaultSettlements(part.name);
}

export function allowedIn(part: PlaceablePart, kind: SettlementKind, rules: PlacementRules = {}): boolean {
  return settlementChoices(part, rules).includes(kind);
}

/** Preserve default weighting and order, then include explicitly assigned buildings in this role. */
export function placementPool<T extends PlaceablePart>(
  defaults: readonly T[], candidates: readonly T[], kind: SettlementKind, rules: PlacementRules = {},
): T[] {
  return [
    ...defaults.filter((part) => allowedIn(part, kind, rules)),
    ...candidates.filter((part) => !isLayoutPart(part.name)
      && !defaults.some(({ name }) => name === part.name)
      && !defaultSettlements(part.name).includes(kind)
      && (rules[part.name] ?? part.settlements)?.includes(kind)),
  ];
}

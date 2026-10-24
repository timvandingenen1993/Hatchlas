import { settlementChoices, type PlacementRules } from "./partPlacement";
import { composeSettlement } from "./townSprite";
import type { TownPart } from "./townParts";
import type { SettlementKind } from "./types";

export interface SettlementPreview {
  kind: SettlementKind;
  seed: number;
}

/** Look only in allowed settlements, including less common layouts beyond the first six seeds. */
export function findSettlementPreview(
  part: Pick<TownPart, "name" | "settlements">, rules: PlacementRules = {},
  kinds: readonly SettlementKind[] = settlementChoices(part, rules),
): SettlementPreview | null {
  for (const kind of kinds) {
    for (let seed = 1; seed <= 80; seed++) {
      if (composeSettlement(kind, seed, rules).includes(`data-part="${part.name}"`)) return { kind, seed };
    }
  }
  return null;
}

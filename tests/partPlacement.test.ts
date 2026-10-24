import { describe, expect, it } from "vitest";
import {
  defaultSettlements, isLayoutPart, parseSettlements, placementPool, SETTLEMENT_ATTRIBUTE, type PlacementRules,
} from "../src/structures/partPlacement";
import { parsePartDocument, serializePartDocument } from "../src/structures/partDocument";
import { PARTS, parseTownPart, partNamed } from "../src/structures/townParts";
import { composeSettlement } from "../src/structures/townSprite";
import { castleLayout } from "../src/structures/castleSprite";
import { findSettlementPreview } from "../src/structures/settlementPreview";
import { SETTLEMENT_KINDS } from "../src/structures/types";
import lodgeSource from "../src/assets/structures/town-parts/castle-lodge-gable-right.svg?raw";

const names = (svg: string) => [...svg.matchAll(/data-part="([^"]+)"/g)].map(([, name]) => name);

describe("building placement", () => {
  it("round trips saved placement choices, including disabling a building everywhere", () => {
    for (const choices of ["village castle", ""]) {
      const doc = parsePartDocument(lodgeSource);
      doc.attributes.push([SETTLEMENT_ATTRIBUTE, choices]);
      const saved = serializePartDocument(doc);
      const reopened = parsePartDocument(saved);
      expect(reopened.attributes).toContainEqual([SETTLEMENT_ATTRIBUTE, choices]);
      expect(parseTownPart("castle-lodge-gable-right", saved).settlements).toEqual(choices ? ["village", "castle"] : []);
      expect(saved).toContain('data-edited="true"');
    }
    expect(parseTownPart("castle-lodge-gable-right", lodgeSource).settlements).toBeUndefined();
  });

  it("rejects unknown settlements and normalizes duplicate choices", () => {
    expect(parseSettlements(undefined)).toBeUndefined();
    expect(parseSettlements("castle village castle")).toEqual(["village", "castle"]);
    expect(() => parseSettlements("unknown")).toThrow("Unknown settlement type");
  });

  it("preserves default weighting when existing placement is saved without changes", () => {
    const house = partNamed("house-gable-right");
    const hall = partNamed("castle-hall-gable-right");
    expect(placementPool([house, house], PARTS, "city", { [house.name]: defaultSettlements(house.name) }))
      .toEqual([house, house]);
    // Saving a hall's existing castle assignment does not turn it into a courtyard extra.
    expect(placementPool([], [hall], "castle", { [hall.name]: ["castle"] })).toEqual([]);
    expect(isLayoutPart("wall-i-3")).toBe(true);
    expect(isLayoutPart("great-keep")).toBe(true);
    expect(isLayoutPart(hall.name)).toBe(false);
  });

  it("finds the right-facing lodge beyond the old six-seed preview limit", () => {
    expect(findSettlementPreview(partNamed("castle-lodge-gable-right"))).toEqual({ kind: "castle", seed: 7 });
    expect(findSettlementPreview({ name: "castle-lodge-gable-right" }, { "castle-lodge-gable-right": [] })).toBeNull();
  });

  it("allows buildings in newly selected settlement types", () => {
    for (const [name, kind] of [
      ["castle-lodge-gable-right", "village"],
      ["house-gable-right", "castle"],
      ["church-gable-right", "hamlet"],
      ["tower", "hamlet"],
      ["hut-gable-right", "keep"],
    ] as const) {
      const rules: PlacementRules = { [name]: [kind] };
      const preview = findSettlementPreview({ name }, rules, [kind]);
      expect(preview, `${name} in ${kind}`).not.toBeNull();
      expect(names(composeSettlement(kind, preview!.seed, rules))).toContain(name);
    }
  });

  it("uses saved SVG assignments without needing preview overrides", () => {
    const name = "castle-lodge-gable-right";
    const doc = parsePartDocument(lodgeSource);
    doc.attributes.push([SETTLEMENT_ATTRIBUTE, "village"]);
    const loaded = parseTownPart(name, serializePartDocument(doc));
    const part = partNamed(name);
    const original = part.settlements;
    try {
      part.settlements = loaded.settlements;
      const preview = findSettlementPreview(part);
      expect(preview?.kind).toBe("village");
      expect(names(composeSettlement("village", preview!.seed))).toContain(name);
      expect(castleLayout(7).map(({ name }) => name)).not.toContain(name);
    } finally {
      part.settlements = original;
    }
  });

  it("can disable all optional buildings while retaining complete castle walls", () => {
    const rules: PlacementRules = Object.fromEntries(PARTS.filter(({ name }) => !isLayoutPart(name)).map(({ name }) => [name, []]));
    for (const { kind } of SETTLEMENT_KINDS) {
      const parts = names(composeSettlement(kind, 7, rules));
      expect(parts.every(isLayoutPart), kind).toBe(true);
      if (kind === "castle") {
        expect(parts).toContain("great-keep");
        expect(parts.filter((name) => name.startsWith("gatehouse-"))).toHaveLength(1);
        const layout = castleLayout(7, rules);
        expect(layout.filter(({ name }) => /^wall-[ij]-/.test(name)).length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { PARTS, partNamed } from "../src/structures/townParts";
import { composeSettlement } from "../src/structures/townSprite";
import { SETTLEMENT_KINDS } from "../src/structures/types";
import type { PlacementRules } from "../src/structures/partPlacement";

function keepCount(svg: string) {
  return [...svg.matchAll(/data-part="([^"]+)"/g)]
    .filter(([, name]) => /^(?:great-)?keep(?:-|$)/.test(name)).length;
}

function limitedLandmarkCount(svg: string) {
  return [...svg.matchAll(/data-part="([^"]+)"/g)]
    .filter(([, name]) => /^(keep|great-keep|tower)(?:-|$)/.test(name)).length;
}

describe("combined keep and tower limit", () => {
  it("counts the castle's fixed great keep and optional keeps and towers together", () => {
    const rules: PlacementRules = {
      ...Object.fromEntries(PARTS.filter(({ name }) => !name.startsWith("wall-"))
        .map(({ name }) => [name, []])),
      keep: ["castle"],
      tower: ["castle"],
      "tower-round": ["castle"],
    };
    for (let seed = 1; seed <= 40; seed++) {
      const svg = composeSettlement("castle", seed, rules);
      expect(svg).toContain('data-part="great-keep"');
      expect(limitedLandmarkCount(svg), `castle seed ${seed}`).toBe(1);
      expect(svg).not.toContain('data-part="keep"');
    }
  });

  it("counts a great-keep variant against the regular keep in a keep settlement", () => {
    const originalLength = PARTS.length;
    PARTS.push({ ...partNamed("great-keep"), name: "great-keep-variant", settlements: ["keep"] });
    try {
      for (let seed = 1; seed <= 40; seed++) {
        const svg = composeSettlement("keep", seed);
        expect(svg).toContain('data-part="keep"');
        expect(limitedLandmarkCount(svg), `keep seed ${seed}`).toBe(1);
      }
    } finally {
      PARTS.splice(originalLength);
    }
  });

  for (const { kind } of SETTLEMENT_KINDS) {
    it(`limits keep, great-keep and tower to one combined in ${kind}`, () => {
      let seen = false;
      for (let seed = 1; seed <= 40; seed++) {
        const count = limitedLandmarkCount(composeSettlement(kind, seed));
        expect(count, `${kind} seed ${seed}`).toBeLessThanOrEqual(1);
        if (count) seen = true;
      }
      if (["keep", "castle", "city", "walled-town"].includes(kind)) expect(seen).toBe(true);
    });
  }

  it("allows at most one keep per city, while still allowing cities without a keep", () => {
    const counts = new Set<number>();
    for (let seed = 1; seed <= 60; seed++) {
      const count = keepCount(composeSettlement("city", seed));
      expect(count, `city seed ${seed}`).toBeLessThanOrEqual(1);
      counts.add(count);
    }
    expect(counts).toEqual(new Set([0, 1]));
  });

  it("caps custom town keeps even when the placement pool repeats a candidate", () => {
    const originalLength = PARTS.length;
    // Repeated candidates can weight a part, but must not place another keep.
    PARTS.push(partNamed("keep"), partNamed("keep"));
    const rules: PlacementRules = { keep: ["walled-town"] };
    let seen = false;
    try {
      for (let seed = 1; seed <= 60; seed++) {
        const count = keepCount(composeSettlement("walled-town", seed, rules));
        expect(count, `town seed ${seed}`).toBeLessThanOrEqual(1);
        expect(limitedLandmarkCount(composeSettlement("walled-town", seed, rules))).toBeLessThanOrEqual(1);
        if (count) seen = true;
      }
      expect(seen).toBe(true);
    } finally {
      PARTS.splice(originalLength);
    }
  });

  it("respects a keep disabled by placement settings", () => {
    for (const kind of ["city", "walled-town"] as const) {
      for (let seed = 1; seed <= 10; seed++) {
        expect(keepCount(composeSettlement(kind, seed, { keep: [] }))).toBe(0);
      }
    }
  });
});

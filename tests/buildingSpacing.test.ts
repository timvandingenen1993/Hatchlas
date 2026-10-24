import { describe, expect, it } from "vitest";
import { project } from "../src/structures/isoDraw";
import { castleLayout } from "../src/structures/castleSprite";
import { PARTS, partNamed } from "../src/structures/townParts";
import { composeSettlement } from "../src/structures/townSprite";
import type { PlacementRules } from "../src/structures/partPlacement";
import type { SettlementKind } from "../src/structures/types";

/** Recover actual grid footprints from the generated artwork, excluding the enclosure. */
function footprints(kind: SettlementKind, seed: number, rules?: PlacementRules) {
  const [unitX, unitY] = project([1, 0, 0]);
  return [...composeSettlement(kind, seed, rules).matchAll(/data-part="([^"]+)" transform="translate\(([-\d.]+) ([-\d.]+)\)"/g)]
    .filter(([, name]) => !name.startsWith("wall-"))
    .map(([, name, x, y]) => {
      const part = partNamed(name);
      const i = Math.round((Number(x) + part.originX) / unitX + (Number(y) + part.originY) / unitY) / 2;
      const j = Math.round((Number(y) + part.originY) / unitY - (Number(x) + part.originX) / unitX) / 2;
      return { name, i, j, endI: i + part.cellsI, endJ: j + part.cellsJ };
    });
}

function verifySpacing(kind: SettlementKind, seed: number, rules?: PlacementRules) {
  const layout = footprints(kind, seed, rules);
  const minimumGap = kind === "walled-town" || kind === "city" ? 1 : 0.5;
  for (let a = 0; a < layout.length; a++) {
    for (let b = a + 1; b < layout.length; b++) {
      const first = layout[a], second = layout[b];
      const gap = Math.max(first.i - second.endI, second.i - first.endI,
        first.j - second.endJ, second.j - first.endJ);
      expect(gap, `${kind} seed ${seed}: ${first.name} and ${second.name}`).toBeGreaterThanOrEqual(minimumGap);
    }
  }
  return layout;
}

describe("building spacing", () => {
  for (const kind of ["hamlet", "village", "walled-town", "city"] as const) {
    const spacing = kind === "walled-town" || kind === "city" ? "one" : "half a";
    it(`leaves at least ${spacing} grid cell between every building in ${kind}`, () => {
      let fillers = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const layout = verifySpacing(kind, seed);
        expect(layout.length).toBeGreaterThanOrEqual(2);
        fillers += layout.filter(({ name }) => /^(hut|shed)-/.test(name)).length;
      }
      expect(fillers).toBeGreaterThan(0);
    });
  }

  it("also spaces buildings assigned to villages through placement overrides", () => {
    const parts = ["castle-house-gable-right", "keep", "hut-gable-right"];
    const rules: PlacementRules = {
      ...Object.fromEntries(PARTS.filter(({ name }) => !name.startsWith("wall-"))
        .map(({ name }) => [name, []])),
      ...Object.fromEntries(parts.map((name) => [name, ["village"]])),
    };
    const seen = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      for (const { name } of verifySpacing("village", seed, rules)) seen.add(name);
    }
    expect([...seen].sort()).toEqual([...parts].sort());
  });

  it("still allows touching buildings in keeps", () => {
    const rules: PlacementRules = { "castle-house-gable-left": ["keep"], "castle-house-gable-right": ["keep"] };
    let joined = false;
    for (let seed = 1; seed <= 20; seed++) {
      const layout = footprints("keep", seed, rules);
      for (const first of layout) {
        for (const second of layout) {
          if (first === second) continue;
          const gap = Math.max(first.i - second.endI, second.i - first.endI,
            first.j - second.endJ, second.j - first.endJ);
          if (gap === 0) joined = true;
        }
      }
    }
    expect(joined).toBe(true);
  });

  it("still joins castle buildings to the great keep", () => {
    let joined = false;
    for (let seed = 1; seed <= 20; seed++) {
      const layout = castleLayout(seed).filter(({ name }) => name === "great-keep" || name.startsWith("castle-"))
        .map(({ name, footprint }) => ({ name,
          i: Math.min(...footprint.map(([i]) => i)), endI: Math.max(...footprint.map(([i]) => i)),
          j: Math.min(...footprint.map(([, j]) => j)), endJ: Math.max(...footprint.map(([, j]) => j)),
        }));
      const keep = layout.find(({ name }) => name === "great-keep")!;
      for (const building of layout.filter(({ name }) => name.startsWith("castle-"))) {
        const gap = Math.max(keep.i - building.endI, building.i - keep.endI,
          keep.j - building.endJ, building.j - keep.endJ);
        if (gap === 0) joined = true;
      }
    }
    expect(joined).toBe(true);
  });
});

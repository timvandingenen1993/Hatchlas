import { describe, expect, it } from "vitest";
import { mountainGrassAmount, tintMountainLand } from "../src/rendering/mountainTerrainTint";

describe("tintMountainLand", () => {
  const tundra: [number, number, number] = [147, 131, 98];
  const green: [number, number, number] = [73, 122, 72];
  const terrain = { normElev: 0.4, tpi: 0, insolation: 0.5, noise: 0 };

  it("turns flat low ground greener than steep ground", () => {
    const flat = tintMountainLand(tundra, { ...terrain, slopeDeg: 4 }, green);
    const steep = tintMountainLand(tundra, { ...terrain, slopeDeg: 40 }, green);
    expect(flat[1] - flat[0]).toBeGreaterThan(steep[1] - steep[0]);
  });

  it("keeps flat summit ground from turning green", () => {
    const summit = tintMountainLand(tundra, { ...terrain, normElev: 0.95, slopeDeg: 4 }, green);
    const lowland = tintMountainLand(tundra, { ...terrain, slopeDeg: 4 }, green);
    expect(summit[1] - summit[0]).toBeLessThan(lowland[1] - lowland[0]);
  });
});

describe("mountainGrassAmount", () => {
  it("is grass on the flat low ground the tint paints green and nowhere else", () => {
    expect(mountainGrassAmount(3, 0.4, 0)).toBe(1);
    expect(mountainGrassAmount(30, 0.4, 0)).toBe(0);
    expect(mountainGrassAmount(3, 0.95, 0)).toBe(0);
    // Half grass at the meadow biome's limits.
    expect(mountainGrassAmount(11, 0.4, 0)).toBeCloseTo(0.5, 1);
    expect(mountainGrassAmount(3, 0.7, 0)).toBeCloseTo(0.5, 1);
  });
});

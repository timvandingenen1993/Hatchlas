import { describe, expect, it } from "vitest";
import { formPropStandArea } from "../src/rendering/vegetationRenderer";

const WIDTH = 240;
const HEIGHT = 160;
const TREE = 6;

/** Plants on a grid `spacing` stand trees apart, filling [x0, x1) × [y0, y1). */
function grove(x0: number, x1: number, y0: number, y1: number, spacing: number) {
  const plants: Array<{ x: number; y: number }> = [];
  for (let y = y0; y < y1; y += spacing * TREE) for (let x = x0; x < x1; x += spacing * TREE) plants.push({ x, y });
  return plants;
}

const covered = (forest: Float32Array, x: number, y: number) => forest[Math.floor(y) * WIDTH + Math.floor(x)] >= 0.5;

describe("prop stand area", () => {
  it("joins evenly spread plants within the joining distance and leaves them lone beyond it", () => {
    const plants = grove(40, 200, 40, 120, 2);
    const joined = formPropStandArea(plants, WIDTH, HEIGHT, TREE, 2.5);
    expect(joined.loneTrees.length).toBe(0);
    expect(covered(joined.forest, 120, 78)).toBe(true);
    const apart = formPropStandArea(plants, WIDTH, HEIGHT, TREE, 1.5);
    expect(apart.loneTrees.length).toBe(plants.length);
    expect(apart.forest.some((value) => value >= 0.5)).toBe(false);
  });

  it("never fills the open ground between separate groves", () => {
    const plants = [...grove(20, 80, 40, 110, 1.5), ...grove(160, 220, 40, 110, 1.5)];
    const { forest, loneTrees } = formPropStandArea(plants, WIDTH, HEIGHT, TREE, 2.5);
    expect(loneTrees.length).toBe(0);
    expect(covered(forest, 50, 70)).toBe(true);
    expect(covered(forest, 190, 70)).toBe(true);
    for (let x = 100; x < 140; x++) expect(covered(forest, x, 70)).toBe(false);
  });

  it("keeps plants placed as lone trees lone, and out of a stand's company", () => {
    // Two placed lone trees beside a third plant: without the flag the three
    // would join into a stand.
    const plants = [{ x: 60, y: 60, lone: true }, { x: 70, y: 60, lone: true }, { x: 80, y: 60 }];
    const { forest, loneTrees } = formPropStandArea(plants, WIDTH, HEIGHT, TREE, 2.5);
    expect(loneTrees.length).toBe(3);
    expect(forest.some((value) => value >= 0.5)).toBe(false);
    // Inside a grove a placed lone tree still stays lone.
    const withLone = [...grove(40, 200, 40, 120, 2), { x: 121, y: 79, lone: true }];
    expect(formPropStandArea(withLone, WIDTH, HEIGHT, TREE, 2.5).loneTrees).toEqual([{ x: 121, y: 79 }]);
  });

  it("keeps a pair, or a plant on its own, as lone trees", () => {
    const plants = [{ x: 60, y: 60 }, { x: 70, y: 60 }, { x: 180, y: 100 }];
    const { forest, loneTrees } = formPropStandArea(plants, WIDTH, HEIGHT, TREE, 2.5);
    expect(loneTrees.length).toBe(3);
    expect(forest.some((value) => value >= 0.5)).toBe(false);
  });
});

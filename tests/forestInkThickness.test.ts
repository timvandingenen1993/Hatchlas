import { describe, expect, it } from "vitest";
import { inkMarkThickness } from "../src/rendering/forestInkRenderer";
import { buildForestInkGeometry, DEFAULT_FOREST_INK_PENS, inkMarkPen, type ForestInkMark } from "../src/rendering/forestInkStands";

const WIDTH = 160;
const HEIGHT = 120;

function block() {
  const forest = new Float32Array(WIDTH * HEIGHT);
  for (let y = 30; y < 90; y++) for (let x = 40; x < 120; x++) forest[y * WIDTH + x] = 1;
  return buildForestInkGeometry({
    width: WIDTH,
    height: HEIGHT,
    forest,
    seed: 3,
    settings: { markSize: 5, density: 1, edgeRows: 0.6, edgeDensity: 1, edgeDepth: 1, meadowTrees: 1.5, grass: 1.5 },
  });
}

describe("ink tree types and line thickness", () => {
  it("tags every kind of tree", () => {
    const roles = new Set(block().marks.map((mark) => mark.role));
    for (const role of ["front", "second", "back", "fill", "lone", "grass"]) expect(roles.has(role as ForestInkMark["role"])).toBe(true);
  });

  it("shows more than half the tree along the back edge", () => {
    const back = block().marks.filter((mark) => mark.role === "back");
    expect(back.length).toBeGreaterThan(5);
    expect(back.every((mark) => mark.cut > 0.5)).toBe(true);
  });

  it("draws each kind near its own default weight, the front boldest and the fill finest", () => {
    const marks = block().marks;
    for (const mark of marks) {
      const ratio = mark.pen / inkMarkPen(mark);
      expect(ratio).toBeGreaterThan(0.85);
      expect(ratio).toBeLessThan(1.15);
    }
    const pens = DEFAULT_FOREST_INK_PENS;
    expect(pens.front).toBeGreaterThan(pens.back);
    expect(pens.back).toBeGreaterThan(pens.second);
    expect(pens.second).toBeGreaterThan(pens.fill);
  });

  it("sets each kind's weight on its own and blends the fill toward the near-edge weight", () => {
    const marks = block().marks;
    const front = marks.find((mark) => mark.role === "front")!;
    const lone = marks.find((mark) => mark.role === "lone")!;
    const pens = { front: 2, fill: 0.5, nearEdge: 1.5 };
    // The chosen weight, times the mark's own small variation.
    expect(inkMarkThickness(front, pens)).toBeCloseTo(2 * front.pen / DEFAULT_FOREST_INK_PENS.front, 6);
    // Unset kinds keep their default weight.
    expect(inkMarkThickness(lone, pens)).toBeCloseTo(lone.pen, 6);
    const fill = marks.find((mark) => mark.role === "fill")!;
    const variation = fill.pen / inkMarkPen(fill);
    expect(inkMarkThickness({ ...fill, edge: 0, pen: inkMarkPen({ ...fill, edge: 0 }) }, pens)).toBeCloseTo(0.5, 6);
    expect(inkMarkThickness({ ...fill, edge: 1, pen: inkMarkPen({ ...fill, edge: 1 }) }, pens)).toBeCloseTo(1.5, 6);
    expect(variation).toBeGreaterThan(0.85);
    // Saved settings from before a slider existed come through as undefined or NaN.
    expect(inkMarkThickness(front, { front: Number.NaN })).toBeCloseTo(front.pen, 6);
  });
});

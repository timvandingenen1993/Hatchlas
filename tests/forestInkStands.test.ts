import { describe, expect, it } from "vitest";
import {
  buildForestInkGeometry,
  inkMarkOutline,
  type ForestInkInput,
  type ForestInkMark,
} from "../src/rendering/forestInkStands";

const WIDTH = 160;
const HEIGHT = 120;

/** A block of forest from (40, 30) to (120, 90), with an optional clearing in the middle. */
function blockInput(clearing: boolean, overrides: Partial<ForestInkInput["settings"]> = {}): ForestInkInput {
  const forest = new Float32Array(WIDTH * HEIGHT);
  for (let y = 30; y < 90; y++) {
    for (let x = 40; x < 120; x++) {
      const inClearing = clearing && x >= 66 && x < 94 && y >= 50 && y < 70;
      forest[y * WIDTH + x] = inClearing ? 0 : 1;
    }
  }
  return {
    width: WIDTH,
    height: HEIGHT,
    forest,
    seed: 3,
    settings: { markSize: 5, density: 1, edgeRows: 0.6, edgeDensity: 1, edgeDepth: 1, meadowTrees: 0, grass: 0, ...overrides },
  };
}

const centreY = (mark: ForestInkMark) => mark.y - mark.height / 2;
const heavy = (mark: ForestInkMark) => mark.pen >= 0.8;

describe("ink forest stands", () => {
  it("puts closed crowns on the front edge and open caps on the back edge", () => {
    const { marks } = buildForestInkGeometry(blockInput(false));
    const middle = marks.filter((mark) => mark.x > 55 && mark.x < 105);
    const front = middle.filter((mark) => heavy(mark) && mark.y > 87 && mark.y < 96);
    const back = middle.filter((mark) => heavy(mark) && Math.abs(centreY(mark) - 30) < 5);
    expect(front.length).toBeGreaterThan(5);
    expect(front.every((mark) => mark.kind === "oval")).toBe(true);
    expect(back.length).toBeGreaterThan(4);
    expect(back.every((mark) => mark.kind === "cap")).toBe(true);
  });

  it("draws the front edge as an unbroken, bold chain of mixed sizes", () => {
    const { marks } = buildForestInkGeometry(blockInput(false));
    const chain = marks
      .filter((mark) => mark.kind === "oval" && mark.pen > 1.2 && mark.x > 50 && mark.x < 110 && mark.y > 87 && mark.y < 96)
      .sort((a, b) => a.x - b.x);
    expect(chain.length).toBeGreaterThan(8);
    for (let index = 1; index < chain.length; index++) {
      const gap = (chain[index].x - chain[index].width / 2) - (chain[index - 1].x + chain[index - 1].width / 2);
      expect(gap).toBeLessThan(0.5);
    }
    const fill = marks.filter((mark) => mark.kind === "cap" && mark.pen < 0.8);
    const finest = Math.max(...fill.map((mark) => mark.pen));
    expect(Math.min(...chain.map((mark) => mark.pen))).toBeGreaterThan(finest * 1.3);
    const widths = chain.map((mark) => mark.width);
    expect(Math.max(...widths) / Math.min(...widths)).toBeGreaterThan(1.6);
  });

  it("stands each edge tree at its own depth instead of on the outline", () => {
    const { marks } = buildForestInkGeometry(blockInput(false));
    const spread = (values: number[]) => {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    };
    const middle = marks.filter((mark) => mark.x > 50 && mark.x < 110);
    const feet = middle.filter((mark) => mark.kind === "oval" && mark.pen > 1.2 && mark.y > 85).map((mark) => mark.y);
    const tips = middle.filter((mark) => mark.kind === "cap" && heavy(mark) && mark.y < 45).map((mark) => mark.y - mark.height);
    expect(feet.length).toBeGreaterThan(8);
    expect(tips.length).toBeGreaterThan(4);
    expect(spread(feet)).toBeGreaterThan(0.6);
    expect(spread(tips)).toBeGreaterThan(0.6);
    // Some tops poke up above the outline.
    expect(Math.min(...tips)).toBeLessThan(29);
    // At zero depth variance they all go back onto the outline.
    const flat = buildForestInkGeometry(blockInput(false, { edgeDepth: 0 })).marks
      .filter((mark) => mark.x > 50 && mark.x < 110 && mark.kind === "oval" && mark.pen > 1.2 && mark.y > 85)
      .map((mark) => mark.y);
    expect(spread(flat)).toBeLessThan(spread(feet) * 0.5);
  });

  it("keeps the front chain when edge density is missing from old settings", () => {
    const input = blockInput(false);
    const old = { ...input, settings: { ...input.settings, edgeDensity: undefined as unknown as number } };
    const front = (geometry: ReturnType<typeof buildForestInkGeometry>) =>
      geometry.marks.filter((mark) => mark.pen > 1.2).length;
    expect(front(buildForestInkGeometry(old))).toBe(front(buildForestInkGeometry(input)));
  });

  it("packs the back edge densely, in a pen between the fill and the front", () => {
    const { marks } = buildForestInkGeometry(blockInput(false));
    const back = marks.filter((mark) => mark.kind === "cap" && mark.pen >= 1.05 && mark.x > 50 && mark.x < 110 && mark.y < 42);
    // Tops cover most of the back edge's length.
    const covered = back.reduce((sum, mark) => sum + mark.width, 0);
    expect(covered).toBeGreaterThan(60 * 0.85);
    const fill = marks.filter((mark) => mark.kind === "cap" && mark.x > 62 && mark.x < 98 && mark.y > 52 && mark.y < 70);
    const front = marks.filter((mark) => mark.kind === "oval" && mark.pen > 1.2);
    expect(Math.min(...back.map((mark) => mark.pen))).toBeGreaterThan(Math.max(...fill.map((mark) => mark.pen)));
    expect(Math.max(...back.map((mark) => mark.pen))).toBeLessThan(Math.min(...front.map((mark) => mark.pen)));
  });

  it("packs edge trees tighter or looser with edge density", () => {
    const countEdge = (edgeDensity: number) => buildForestInkGeometry(blockInput(false, { edgeDensity })).marks
      .filter((mark) => mark.pen > 1.2 && mark.x > 50 && mark.x < 110 && mark.y > 85).length;
    expect(countEdge(1.5)).toBeGreaterThan(countEdge(1) * 1.15);
    expect(countEdge(0.5)).toBeLessThan(countEdge(1) * 0.8);
  });

  it("shows more of the trees near an edge, in a middle pen", () => {
    const { marks } = buildForestInkGeometry(blockInput(false));
    const fill = marks.filter((mark) => mark.kind === "cap" && mark.x > 50 && mark.x < 110 && mark.y > 38 && mark.y < 85);
    // Distance from the mark to the block's nearest side.
    const depth = (mark: ForestInkMark) => Math.min(mark.x - 40, 120 - mark.x, mark.y - mark.height / 2 - 30, 90 - mark.y);
    const near = fill.filter((mark) => depth(mark) > 4 && depth(mark) < 11);
    const deep = fill.filter((mark) => depth(mark) > 18);
    expect(near.length).toBeGreaterThan(3);
    expect(deep.length).toBeGreaterThan(10);
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean(near.map((mark) => mark.cut))).toBeGreaterThan(mean(deep.map((mark) => mark.cut)) * 1.4);
    // Three pen weights: fine fill, a middle pen, the bold front.
    const pens = marks.filter((mark) => mark.kind !== "dot").map((mark) => mark.pen);
    expect(pens.some((pen) => pen < 0.8)).toBe(true);
    expect(pens.some((pen) => pen > 0.9 && pen < 1.15)).toBe(true);
    expect(pens.some((pen) => pen > 1.2)).toBe(true);
  });

  it("fills the inside loosely with fine-pen caps", () => {
    const { marks } = buildForestInkGeometry(blockInput(false));
    // Deep inside, away from the deeper near-edge trees.
    const inside = marks.filter((mark) => mark.x > 62 && mark.x < 98 && mark.y > 52 && mark.y < 70);
    expect(inside.length).toBeGreaterThan(10);
    expect(inside.every((mark) => mark.kind === "cap" && !heavy(mark))).toBe(true);
    // Loose: the caps cover well under half of the area they sit in.
    const covered = inside.reduce((sum, mark) => sum + mark.width * mark.height * Math.PI / 4, 0);
    expect(covered / (36 * 18)).toBeLessThan(0.45);
  });

  it("draws whole trees long and pointed, and only short tops inside", () => {
    const { marks } = buildForestInkGeometry(blockInput(false, { meadowTrees: 1 }));
    const trees = marks.filter((mark) => mark.kind === "oval");
    expect(trees.every((mark) => mark.height >= mark.width * 2)).toBe(true);
    // Narrower near the tip than near the foot.
    for (const tree of trees.slice(0, 20)) {
      const { points } = inkMarkOutline({ ...tree, x: 0, y: 0, tilt: 0 });
      const spread = (from: number, to: number) => {
        const xs = points.filter((point) => -point.y >= from * tree.height && -point.y <= to * tree.height).map((point) => point.x);
        return Math.max(...xs) - Math.min(...xs);
      };
      expect(spread(0.8, 0.92)).toBeLessThan(spread(0.08, 0.2) * 0.85);
    }
    // Deep inside the stand only short tops show.
    const deep = marks.filter((mark) => mark.kind === "cap" && mark.x > 62 && mark.x < 98 && mark.y > 52 && mark.y < 70);
    expect(deep.length).toBeGreaterThan(10);
    expect(deep.every((mark) => mark.cut < 0.35 && mark.height < mark.width)).toBe(true);
  });

  it("draws some inside tops as connected groups dipping into valleys", () => {
    const tops = buildForestInkGeometry(blockInput(false)).marks.filter((mark) => mark.kind === "cap" && mark.pen < 0.8);
    const groups = tops.filter((mark) => mark.count > 1);
    expect(groups.length).toBeGreaterThan(tops.length * 0.15);
    expect(groups.length).toBeLessThan(tops.length * 0.7);
    for (const group of groups) {
      const { points, corners } = inkMarkOutline({ ...group, x: 0, y: 0, tilt: 0 });
      // A tip per tree and a valley between each pair.
      expect(corners.length).toBe(group.count * 2 - 1);
      for (let index = 1; index < corners.length; index += 2) {
        const valley = points[corners[index]];
        const tipsBeside = [points[corners[index - 1]], points[corners[index + 1]]];
        // The valley sits below both tips, but above the cut line.
        expect(valley.y).toBeGreaterThan(Math.max(...tipsBeside.map((tip) => tip.y)));
        expect(valley.y).toBeLessThan(-group.height * 0.1);
      }
    }
  });

  it("rounds the fill tops more than the pointed edge trees", () => {
    const { marks } = buildForestInkGeometry(blockInput(false));
    const deep = marks.filter((mark) => mark.kind === "cap" && mark.x > 62 && mark.x < 98 && mark.y > 52 && mark.y < 70);
    expect(deep.every((mark) => mark.tip < 0.75)).toBe(true);
    expect(marks.filter((mark) => mark.kind === "oval").every((mark) => mark.tip === 1)).toBe(true);
    const back = marks.filter((mark) => mark.kind === "cap" && mark.pen >= 1.05 && Math.abs(centreY(mark) - 30) < 4);
    expect(back.length).toBeGreaterThan(4);
    expect(back.every((mark) => mark.tip > 0.9)).toBe(true);
    // Just below the tip a rounded top is already wider than a pointed one.
    const single = deep.find((mark) => mark.count === 1)!;
    const widthBelowTip = (tip: number) => {
      const { points } = inkMarkOutline({ ...single, x: 0, y: 0, tilt: 0, tip });
      const top = Math.min(...points.map((point) => point.y));
      const band = points.filter((point) => point.y < top + single.height * 0.12).map((point) => point.x);
      return Math.max(...band) - Math.min(...band);
    };
    expect(widthBelowTip(single.tip)).toBeGreaterThan(widthBelowTip(1) * 1.2);
  });

  it("gives every tree its own shape", () => {
    const caps = buildForestInkGeometry(blockInput(false)).marks.filter((mark) => mark.kind === "cap" && mark.count === 1);
    // Marks of the same box still draw different outlines.
    let difference = 0;
    for (let pair = 0; pair < 10; pair++) {
      const box = { x: 0, y: 0, tilt: 0, width: caps[0].width, height: caps[0].height, cut: caps[0].cut };
      const a = inkMarkOutline({ ...caps[pair * 2], ...box }).points;
      const b = inkMarkOutline({ ...caps[pair * 2 + 1], ...box }).points;
      difference += a.reduce((sum, point, index) => sum + Math.hypot(point.x - b[index].x, point.y - b[index].y), 0) / a.length / 10;
    }
    expect(difference).toBeGreaterThan(caps[0].width * 0.03);
  });

  it("flips the edges around a clearing", () => {
    const { marks } = buildForestInkGeometry(blockInput(true));
    const inClearingColumns = marks.filter((mark) => mark.x > 72 && mark.x < 88 && heavy(mark));
    // The clearing's upper rim is the front of the forest above it.
    const upperRim = inClearingColumns.filter((mark) => Math.abs(mark.y - 50) < 3);
    // Its lower rim is the back of the forest below it.
    const lowerRim = inClearingColumns.filter((mark) => Math.abs(centreY(mark) - 70) < 4);
    expect(upperRim.length).toBeGreaterThan(1);
    expect(upperRim.every((mark) => mark.kind === "oval")).toBe(true);
    expect(lowerRim.length).toBeGreaterThan(1);
    expect(lowerRim.every((mark) => mark.kind === "cap")).toBe(true);
  });

  it("keeps lone trees and grass on open ground", () => {
    const { marks, mask } = buildForestInkGeometry(blockInput(false, { meadowTrees: 1.5, grass: 1.5 }));
    const open = marks.filter((mark) => mark.y < 22 || mark.y > 100 || mark.x < 30 || mark.x > 130);
    expect(open.some((mark) => mark.kind === "oval")).toBe(true);
    expect(open.some((mark) => mark.kind === "dot")).toBe(true);
    for (const mark of open) {
      expect(mask[Math.floor(mark.y) * WIDTH + Math.floor(mark.x)] ?? 0).toBeLessThan(0.5);
    }
  });

  describe("away from the stands", () => {
    // A small stand in the corner of a wide open map.
    const width = 400;
    const height = 300;
    const forest = new Float32Array(width * height);
    for (let y = 20; y < 60; y++) for (let x = 20; x < 70; x++) forest[y * width + x] = 1;
    const input = (extra: Partial<ForestInkInput> = {}): ForestInkInput => ({
      width,
      height,
      forest,
      seed: 5,
      settings: { markSize: 5, density: 1, edgeRows: 0.6, edgeDensity: 1, edgeDepth: 1, meadowTrees: 3, grass: 3 },
      ...extra,
    });
    /** Lone trees and grass more than twelve trees from the stand. */
    const far = (marks: ForestInkMark[]) => marks.filter((mark) =>
      (mark.role === "lone" || mark.role === "grass") && (mark.x > 130 || mark.y > 120));

    it("keeps lone trees and grass around the stands, as the old stands did", () => {
      const { marks } = buildForestInkGeometry(input());
      expect(marks.some((mark) => mark.role === "lone")).toBe(true);
      expect(far(marks)).toEqual([]);
    });

    it("scatters them further out only where the ground suits them", () => {
      const suitability = new Float32Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 200; x < width; x++) suitability[y * width + x] = 1;
      const scattered = far(buildForestInkGeometry(input({ suitability })).marks);
      expect(scattered.length).toBeGreaterThan(5);
      expect(scattered.every((mark) => mark.x >= 195)).toBe(true);
    });
  });

  it("splits the stand along a clearing instead of leaving it bare inside", () => {
    // Open land six trees wide runs down through the middle of the stand.
    const clearing = new Float32Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) for (let x = 65; x < 95; x++) clearing[y * WIDTH + x] = 1;
    const { marks, mask } = buildForestInkGeometry({ ...blockInput(false), clearing });
    for (let y = 35; y < 85; y++) for (let x = 65; x < 95; x++) expect(mask[y * WIDTH + x]).toBeLessThan(0.5);
    const stand = marks.filter((mark) => mark.role !== "lone" && mark.role !== "grass");
    // Edge trees may step a little way out onto it, never across it.
    expect(stand.filter((mark) => mark.x >= 74 && mark.x < 86)).toEqual([]);
    // Each half is a stand of its own, edged along the clearing.
    expect(stand.filter((mark) => mark.x < 74 && mark.x > 50 && mark.role !== "fill").length).toBeGreaterThan(2);
    expect(stand.filter((mark) => mark.x >= 86 && mark.x < 110 && mark.role !== "fill").length).toBeGreaterThan(2);
  });

  describe("on ground with water", () => {
    // A river three cells wide runs down through the stand, and a lake lies
    // in the open ground to its right.
    const isRiver = (x: number) => x >= 78 && x < 81;
    const isLake = (x: number, y: number) => (x - 140) ** 2 + (y - 60) ** 2 < 14 ** 2;
    const ground = new Float32Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) ground[y * WIDTH + x] = isRiver(x) || isLake(x, y) ? 0 : 1;
    }
    /**
     * A mark's foot across its width. As with placed plants, only the foot
     * must be dry: a crown on the near shore may rise over the water.
     */
    const footprint = (mark: ForestInkMark) => [-0.35, 0, 0.35].map((share) => ({ x: mark.x + mark.width * share, y: mark.y }));
    /** Water at the nearest cell centre (the ground is sampled between centres). */
    const wet = (point: { x: number; y: number }) => {
      const x = Math.min(WIDTH - 1, Math.max(0, Math.round(point.x)));
      const y = Math.min(HEIGHT - 1, Math.max(0, Math.round(point.y)));
      return ground[y * WIDTH + x] === 0;
    };
    const input = (withGround: boolean): ForestInkInput => {
      const base = blockInput(false, { meadowTrees: 3, grass: 3 });
      return { ...base, seed: 11, ground: withGround ? ground : undefined };
    };

    it("bridges the river and fills the lake without it (control)", () => {
      const { marks } = buildForestInkGeometry(input(false));
      expect(marks.some((mark) => footprint(mark).some(wet))).toBe(true);
    });

    it("splits the stand along the river and draws nothing on water", () => {
      const { marks, mask } = buildForestInkGeometry(input(true));
      for (let y = 35; y < 85; y++) {
        for (let x = 78; x < 81; x++) expect(mask[y * WIDTH + x]).toBeLessThan(0.5);
      }
      expect(marks.filter((mark) => footprint(mark).some(wet))).toEqual([]);
      // Both banks still hold forest, edged where they meet the river.
      expect(marks.some((mark) => mark.x < 76 && mark.y > 40 && mark.y < 85)).toBe(true);
      expect(marks.some((mark) => mark.x > 83 && mark.y > 40 && mark.y < 85)).toBe(true);
    });
  });

  it("is deterministic and drawn back to front", () => {
    const first = buildForestInkGeometry(blockInput(true, { meadowTrees: 1, grass: 1 }));
    const second = buildForestInkGeometry(blockInput(true, { meadowTrees: 1, grass: 1 }));
    expect(second.marks).toEqual(first.marks);
    for (let index = 1; index < first.marks.length; index++) {
      expect(first.marks[index].y).toBeGreaterThanOrEqual(first.marks[index - 1].y);
    }
  });
});

import { describe, expect, it } from "vitest";
import { buildForestInkGeometry, inkMarkOutline, type ForestInkMark, type ForestInkType } from "../src/rendering/forestInkStands";
import { boxBlur, smoothStep } from "../src/rendering/forestStandGeometry";

const WIDTH = 160;
const HEIGHT = 120;

function block(type?: ForestInkType) {
  const forest = new Float32Array(WIDTH * HEIGHT);
  for (let y = 30; y < 90; y++) for (let x = 40; x < 120; x++) forest[y * WIDTH + x] = 1;
  return buildForestInkGeometry({
    width: WIDTH,
    height: HEIGHT,
    forest,
    seed: 3,
    settings: { markSize: 5, density: 1, edgeRows: 0.6, edgeDensity: 1, edgeDepth: 1, meadowTrees: 1, grass: 0, type },
  });
}

/** Width of a whole tree's outline in a band of its height (0 = tip, 1 = foot). */
function bandWidth(tree: ForestInkMark, from: number, to: number): number {
  const { points } = inkMarkOutline({ ...tree, x: 0, y: 0, tilt: 0 });
  const xs = points.filter((point) => -point.y <= (1 - from) * tree.height && -point.y >= (1 - to) * tree.height).map((point) => point.x);
  return Math.max(...xs) - Math.min(...xs);
}

const fronts = (type?: ForestInkType) => block(type).marks.filter((mark) => mark.role === "front");
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

describe("ink forest types", () => {
  it("draws deciduous trees when no type is given", () => {
    expect(block().marks.filter((mark) => mark.kind !== "dot").every((mark) => mark.forest === "deciduous")).toBe(true);
    expect(block("conifer").marks.filter((mark) => mark.kind !== "dot").every((mark) => mark.forest === "conifer")).toBe(true);
  });

  it("makes conifers tall cones, widest low down", () => {
    const conifers = fronts("conifer");
    const deciduous = fronts("deciduous");
    expect(mean(conifers.map((mark) => mark.height / mark.width))).toBeGreaterThan(mean(deciduous.map((mark) => mark.height / mark.width)) * 1.1);
    // Low on the tree a cone is much wider than near its tip.
    for (const tree of conifers.slice(0, 10)) expect(bandWidth(tree, 0.7, 0.85)).toBeGreaterThan(bandWidth(tree, 0.1, 0.25) * 2.2);
  });

  it("makes shrubs broad and round", () => {
    const shrubs = fronts("shrub");
    expect(shrubs.every((mark) => mark.height < mark.width * 1.4)).toBe(true);
    expect(mean(shrubs.map((mark) => mark.width))).toBeGreaterThan(mean(fronts("deciduous").map((mark) => mark.width)) * 1.15);
  });
});

describe("ink stand light clusters", () => {
  it("keeps lit and flat ground lit and shades patches turned away from the sun", () => {
    const forest = new Float32Array(WIDTH * HEIGHT);
    const light = new Float32Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        forest[y * WIDTH + x] = x > 10 && x < 150 && y > 20 && y < 100 ? 1 : 0;
        // Left: flat ground with a slight wobble; right: a slope in shadow.
        light[y * WIDTH + x] = x < 80 ? 0.5 + Math.sin(x * 1.7 + y * 2.3) * 0.04 : 0.3;
      }
    }
    const geometry = buildForestInkGeometry({
      width: WIDTH, height: HEIGHT, forest, light, seed: 3,
      settings: { markSize: 5, density: 1, edgeRows: 0.6, edgeDensity: 1, edgeDepth: 1, meadowTrees: 0, grass: 0 },
    });
    const shadedIn = (x0: number, x1: number) => {
      let shaded = 0;
      for (let y = 40; y < 80; y++) for (let x = x0; x < x1; x++) if (geometry.shade![y * WIDTH + x] < 0.5) shaded++;
      return shaded;
    };
    expect(shadedIn(20, 60)).toBe(0);
    expect(shadedIn(100, 140)).toBeGreaterThan(40 * 40 * 0.5);
    // Without terrain light there is nothing to shade.
    expect(buildForestInkGeometry({ ...{ width: WIDTH, height: HEIGHT, forest, seed: 3 },
      settings: { markSize: 5, density: 1, edgeRows: 0.6, edgeDensity: 1, edgeDepth: 1, meadowTrees: 0, grass: 0 } }).shade).toBeUndefined();
  });
});

describe("small stands", () => {
  /**
   * A stand area built the way the map builds it from placed plants: a disc
   * stamped per plant, blurred to bridge the gaps, then softened at the edge
   * (see buildPropStands).
   */
  function placedStandArea(plants: number[][], treeSize: number): Float32Array {
    const stamps = new Float32Array(WIDTH * HEIGHT);
    const radius = treeSize * 0.45;
    for (const [px, py] of plants) {
      const cy = py - radius;
      for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
        if ((x - px) ** 2 + (y - cy) ** 2 <= radius * radius) stamps[y * WIDTH + x] = 1;
      }
    }
    const bridged = boxBlur(stamps, WIDTH, HEIGHT, Math.round(treeSize * 0.5));
    return bridged.map((value) => smoothStep(0.25, 0.45, value));
  }

  it("keeps a loose group of trees as a stand, as the map's placements form them", () => {
    const markSize = 5;
    // The map's stand tree for these marks (Tree size 0.73).
    const treeSize = markSize / 0.73;
    const spacing = treeSize * 1.4;
    const plants: number[][] = [];
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 4; column++) plants.push([60 + column * spacing + (row % 2) * spacing * 0.5, 50 + row * spacing]);
    }
    const { marks } = buildForestInkGeometry({
      width: WIDTH, height: HEIGHT, forest: placedStandArea(plants, treeSize), seed: 3,
      settings: { markSize, density: 1, edgeRows: 0.5, edgeDensity: 1, edgeDepth: 1, meadowTrees: 0, grass: 0 },
    });
    const stand = marks.filter((mark) => mark.role === "front" || mark.role === "back" || mark.role === "fill");
    expect(stand.length).toBeGreaterThan(plants.length);
    expect(marks.filter((mark) => mark.role === "front").length).toBeGreaterThan(3);
  });
});

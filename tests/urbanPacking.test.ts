import { describe, expect, it } from "vitest";
import { project } from "../src/structures/isoDraw";
import { shapePoints } from "../src/structures/partDocument";
import { PARTS, partNamed } from "../src/structures/townParts";
import { composeSettlement } from "../src/structures/townSprite";
import { allowedIn, type PlacementRules } from "../src/structures/partPlacement";

type Point = readonly [number, number];
const [unitX, unitY] = project([1, 0, 0]);
const gridPoint = (x: number, y: number): Point => [
  Math.round(x / unitX + y / unitY) / 2, Math.round(y / unitY - x / unitX) / 2,
];

function inside(point: Point, outline: readonly Point[]) {
  let result = false;
  outline.forEach((a, index) => {
    const b = outline[(index + 1) % outline.length];
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) result = !result;
  });
  return result;
}

function edgeDistance(point: Point, a: Point, b: Point) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

/** Recover the wall and building footprints from the rendered SVG, not the packer's cell sets. */
function inspect(svg: string) {
  const ground = /<path\b[^>]*\/>/.exec(svg)![0];
  const outline = shapePoints(ground)!.points.map(([x, y]) => gridPoint(x, y));
  const usable = new Set<string>();
  const occupied = new Set<string>();
  const names: string[] = [];
  const buildings: { name: string; i: number; j: number; endI: number; endJ: number }[] = [];
  const minI = Math.min(...outline.map(([i]) => i)), maxI = Math.max(...outline.map(([i]) => i));
  const minJ = Math.min(...outline.map(([, j]) => j)), maxJ = Math.max(...outline.map(([, j]) => j));
  for (let i = minI; i < maxI; i++) {
    for (let j = minJ; j < maxJ; j++) {
      const corners: Point[] = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      if (corners.every((point) => inside(point, outline)
        && outline.every((a, index) => edgeDistance(point, a, outline[(index + 1) % outline.length]) >= 0.7 - 1e-9))) {
        usable.add(`${i},${j}`);
      }
    }
  }
  for (const [, name, x, y] of svg.matchAll(/data-part="([^"]+)" transform="translate\(([-\d.]+) ([-\d.]+)\)"/g)) {
    if (name.startsWith("wall-")) continue;
    names.push(name);
    const part = partNamed(name);
    const [i, j] = gridPoint(Number(x) + part.originX, Number(y) + part.originY);
    buildings.push({ name, i, j, endI: i + part.cellsI, endJ: j + part.cellsJ });
    for (let di = 0; di < part.cellsI; di += 0.5) {
      for (let dj = 0; dj < part.cellsJ; dj += 0.5) {
        const cell = `${i + di},${j + dj}`;
        expect(occupied.has(cell), `${name} overlaps cell ${cell}`).toBe(false);
        expect(usable.has(`${Math.floor(i + di)},${Math.floor(j + dj)}`), `${name} crosses the wall at ${cell}`).toBe(true);
        occupied.add(cell);
      }
    }
  }
  const gaps: number[] = [];
  for (let a = 0; a < buildings.length; a++) {
    for (let b = a + 1; b < buildings.length; b++) {
      const first = buildings[a], second = buildings[b];
      const gap = Math.max(first.i - second.endI, second.i - first.endI,
        first.j - second.endJ, second.j - first.endJ);
      expect(gap, `${first.name} / ${second.name}`).toBeGreaterThanOrEqual(1);
      gaps.push(gap);
    }
  }
  return { usable, occupied, names, buildings, gaps };
}

/** Every remaining position must be either too small or part of the required clearance. */
function verifySaturated(layout: ReturnType<typeof inspect>, candidateNames: readonly string[]) {
  const available: string[] = [];
  for (const cell of layout.usable) {
    const [ci, cj] = cell.split(",").map(Number);
    for (const di of [0, 0.5]) {
      for (const dj of [0, 0.5]) {
        const i = ci + di, j = cj + dj;
        for (const name of candidateNames) {
          const part = partNamed(name);
          let inside = true;
          for (let x = i; x < i + part.cellsI; x += 0.5) {
            for (let y = j; y < j + part.cellsJ; y += 0.5) {
              if (!layout.usable.has(`${Math.floor(x)},${Math.floor(y)}`)) inside = false;
            }
          }
          if (inside && layout.buildings.every((other) => Math.max(
            i - other.endI, other.i - i - part.cellsI,
            j - other.endJ, other.j - j - part.cellsJ,
          ) >= 1)) available.push(`${name} at ${i},${j}`);
        }
      }
    }
  }
  expect(available).toEqual([]);
}

describe("town and city packing with one-cell clearance", () => {
  it("fills towns mainly with small buildings and only a few full-size houses, including explicitly assigned halls", () => {
    const ruleSets: PlacementRules[] = [{}, { "castle-hall-gable-left": ["walled-town"] }];
    for (const rules of ruleSets) {
      let largerBuildings = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const layout = inspect(composeSettlement("walled-town", seed, rules));
        const residences = layout.names.filter((name) => !/^(church|tower|keep|cathedral|gatehouse|turret)\b/.test(name));
        const large = residences.filter((name) => {
          const part = partNamed(name);
          return part.cellsI * part.cellsJ > 4 || /^townhouse-/.test(name);
        }).length;
        const fullSize = residences.filter((name) => {
          const part = partNamed(name);
          return part.cellsI * part.cellsJ > 2;
        }).length;
        expect(large, `town seed ${seed}`).toBeLessThanOrEqual(2);
        expect(fullSize, `town seed ${seed}`).toBeLessThanOrEqual(6);
        expect(residences.length - fullSize, `town seed ${seed}`).toBeGreaterThan(fullSize);
        largerBuildings += large;
      }
      expect(largerBuildings).toBeGreaterThan(0);
    }
  });

  for (const kind of ["walled-town", "city"] as const) {
    it(`fills every remaining legal small-building position in ${kind}`, () => {
      const candidates = ["hut-gable-left", "hut-gable-right", "shed-gable-left", "shed-gable-right"]
        .filter((name) => allowedIn(partNamed(name), kind));
      let smallBuildings = 0;
      for (let seed = 1; seed <= 10; seed++) {
        const layout = inspect(composeSettlement(kind, seed));
        expect(layout.usable.size).toBeGreaterThan(50);
        verifySaturated(layout, candidates);
        expect(Math.min(...layout.gaps)).toBe(1);
        smallBuildings += layout.names.filter((name) => /^(hut|shed)-/.test(name)).length;
      }
      expect(smallBuildings).toBeGreaterThan(0);
    });

    it(`packs enabled huts on half-cell positions in ${kind} when larger parts are disabled`, () => {
      const rules: PlacementRules = {
        ...Object.fromEntries(PARTS.map(({ name }) => [name, []])),
        "hut-gable-right": [kind],
      };
      for (let seed = 1; seed <= 5; seed++) {
        const layout = inspect(composeSettlement(kind, seed, rules));
        expect(layout.names.length).toBeGreaterThan(10);
        expect(layout.names.every((name) => name === "hut-gable-right")).toBe(true);
        expect(layout.buildings.some(({ i, j }) => !Number.isInteger(i) || !Number.isInteger(j))).toBe(true);
        verifySaturated(layout, ["hut-gable-right"]);
      }
    });
  }

  it("leaves only positions where an enabled shed cannot fit with clearance, without adding disabled huts", () => {
    const rules: PlacementRules = {
      ...Object.fromEntries(PARTS.map(({ name }) => [name, []])),
      "shed-gable-right": ["walled-town"],
    };
    for (let seed = 1; seed <= 5; seed++) {
      const layout = inspect(composeSettlement("walled-town", seed, rules));
      expect(layout.names.length).toBeGreaterThan(0);
      expect(layout.names.every((name) => name === "shed-gable-right")).toBe(true);
      verifySaturated(layout, ["shed-gable-right"]);
    }
  });
});

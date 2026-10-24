import { describe, expect, it } from "vitest";
import { project, type Vec2 } from "../src/structures/isoDraw";
import { type PlacementRules, isKeepOrTowerPart } from "../src/structures/partPlacement";
import { partNamed } from "../src/structures/townParts";
import { composeSettlement } from "../src/structures/townSprite";

const [unitX, unitY] = project([1, 0, 0]);
const gridPoint = (x: number, y: number): Vec2 => [
  Math.round(x / unitX + y / unitY) / 2,
  Math.round(y / unitY - x / unitX) / 2,
];

function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const di = b[0] - a[0], dj = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * di + (point[1] - a[1]) * dj) / (di * di + dj * dj)));
  return Math.hypot(point[0] - a[0] - t * di, point[1] - a[1] - t * dj);
}

describe("settlement landmarks", () => {
  it("gives cities one cathedral and reserves smaller churches for villages and towns", () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const kind of ["hamlet", "village", "walled-town", "city"] as const) {
        const parts = [...composeSettlement(kind, seed).matchAll(/data-part="([^"]+)"/g)].map(([, name]) => name);
        expect(parts.filter((name) => name.startsWith("cathedral-"))).toHaveLength(kind === "city" ? 1 : 0);
        if (kind === "city") expect(parts.some((name) => name.startsWith("church-"))).toBe(false);
      }
    }
  });

  for (const [kind, rules] of [
    ["walled-town", {}],
    ["city", {}],
    ["walled-town", { keep: ["walled-town"], tower: [] }],
  ] as const satisfies readonly (readonly ["walled-town" | "city", PlacementRules])[]) {
    it(`places defensive landmarks inside a rear wall in ${kind}, with ${Object.keys(rules).join(", ") || "default parts"}`, () => {
      let seen = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const svg = composeSettlement(kind, seed, rules);
        const ground = /<path\b[^>]*\bd="([^"]+)"/.exec(svg)![1];
        const outline = [...ground.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map(([, x, y]) => gridPoint(Number(x), Number(y)));
        const segments = outline.map((a, index) => [a, outline[(index + 1) % outline.length]] as const);
        for (const [, name, x, y] of svg.matchAll(/data-part="([^"]+)" transform="translate\(([-\d.]+) ([-\d.]+)\)"/g)) {
          if (!isKeepOrTowerPart(name)) continue;
          seen++;
          const part = partNamed(name);
          const [i, j] = gridPoint(Number(x) + part.originX, Number(y) + part.originY);
          const corners: Vec2[] = [[i, j], [i + part.cellsI, j], [i + part.cellsI, j + part.cellsJ], [i, j + part.cellsJ]];
          const distance = Math.min(...corners.flatMap((corner) => segments.map(([a, b]) => distanceToSegment(corner, a, b))));
          const label = `${kind} seed ${seed}: ${name}`;
          expect(distance, label).toBeLessThanOrEqual(1.5);
          expect(distance, label).toBeGreaterThanOrEqual(0.6);
          const centreDepth = kind === "walled-town" ? 14 : 18;
          expect(i + j + (part.cellsI + part.cellsJ) / 2, label).toBeLessThanOrEqual(centreDepth);
          for (const [a, b] of segments) {
            for (const [ci, cj] of corners) {
              expect((b[0] - a[0]) * (cj - a[1]) - (b[1] - a[1]) * (ci - a[0]), label).toBeGreaterThan(0);
            }
          }
        }
      }
      expect(seen).toBeGreaterThan(0);
    });
  }
});

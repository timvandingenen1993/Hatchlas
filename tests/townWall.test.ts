import { describe, expect, it } from "vitest";
import { mulberry } from "../src/rendering/forestStandGeometry";
import type { Vec2 } from "../src/structures/isoDraw";
import { buildTownWall, paintChain, type TownWallOptions } from "../src/structures/townWall";

const options = (seed: number, corners: TownWallOptions["corners"] = "pier"): TownWallOptions =>
  ({ centreI: 6, centreJ: 6, radius: 7, corners, random: mulberry(seed) });
const names = (wall: ReturnType<typeof buildTownWall>) => [...wall.back, ...wall.front].map(({ part }) => part.name);

describe("town wall", () => {
  it("paints the neighbour nearer the viewer second", () => {
    // A closed chain running out along +i and back: each step along +i
    // reaches a nearer element, so the order follows i whichever way round
    // the chain is listed, even though a tall piece sits in the middle.
    const chain = [{ centre: [0, 3] as Vec2 }, { centre: [1.2, 3] as Vec2 }, { centre: [2.4, 3] as Vec2 }];
    const towards = (list: typeof chain) => (index: number): Vec2 => {
      const [a, b] = [list[index].centre, list[(index + 1) % list.length].centre];
      return [b[0] - a[0], b[1] - a[1]];
    };
    expect(paintChain(chain, towards(chain))).toEqual(chain);
    const reversed = [...chain].reverse();
    expect(paintChain(reversed, towards(reversed))).toEqual(chain);
  });

  it("is an irregular octagon of whole wall parts, its sides along i, j and the diagonals", () => {
    const outlines = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const wall = buildTownWall(options(seed));
      expect(wall.outline).toHaveLength(8);
      outlines.add(JSON.stringify(wall.outline));
      wall.outline.forEach((point, index) => {
        const next = wall.outline[(index + 1) % 8];
        const [di, dj] = [next[0] - point[0], next[1] - point[1]];
        expect(di === 0 || dj === 0 || Math.abs(di) === Math.abs(dj)).toBe(true);
        expect([...point, ...next].every(Number.isInteger)).toBe(true);
      });
      // Nothing but wall parts: walls, round pieces and one gatehouse.
      const parts = names(wall);
      expect(parts.every((name) => /^wall-((i|j|flat|steep)-\d+|drum|tower|gate-[ij])$/.test(name))).toBe(true);
      for (const direction of ["i", "j", "flat", "steep"]) expect(parts.some((name) => name.startsWith(`wall-${direction}-`))).toBe(true);
    }
    expect(outlines.size).toBeGreaterThanOrEqual(8);
  });

  it("puts one gatehouse in a side beside the one facing the viewer, in front of the town", () => {
    const sides = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const wall = buildTownWall(options(seed));
      const gates = [...wall.back, ...wall.front].filter(({ part }) => part.name.startsWith("wall-gate-"));
      expect(gates).toHaveLength(1);
      expect(wall.front).toContain(gates[0]);
      sides.add(gates[0].part.name);
      expect(wall.back.length).toBeGreaterThan(0);
    }
    expect(sides.size).toBe(2);
  });

  it("stands drums or towers on the corners and keeps buildings clear of the wall", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const plain = buildTownWall(options(seed));
      const towered = buildTownWall(options(seed, "tower"));
      expect(names(plain).filter((name) => name === "wall-tower")).toHaveLength(0);
      expect(names(towered).filter((name) => name === "wall-tower")).toHaveLength(8);
      for (const wall of [plain, towered]) {
        const nearest = Math.min(...wall.outline.map(([i, j]) => Math.hypot(i - 6, j - 6)));
        expect(wall.clearRadius).toBeGreaterThan(3);
        expect(wall.clearRadius).toBeLessThan(nearest);
      }
    }
  });
});

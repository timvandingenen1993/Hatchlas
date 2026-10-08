import { describe, expect, it } from "vitest";
import tower from "../src/assets/structures/town-parts/tower.svg?raw";
import { CASTLE_SLATE, INK, keep, roundTower, STROKE_WIDTH } from "../src/structures/isoDraw";
import { castleLayout, castleOutline } from "../src/structures/castleSprite";
import { composeSettlement, paintOrder, parseTownPart } from "../src/structures/townSprite";
import { SETTLEMENT_KINDS, type SettlementKind } from "../src/structures/types";

function viewBox(svg: string): number[] {
  return (/viewBox="([^"]*)"/.exec(svg)?.[1] ?? "").split(" ").map(Number);
}

function buildings(svg: string) {
  return [...svg.matchAll(/<g class="p\d" data-part="([^"]+)" transform="translate\(([-\d.]+) ([-\d.]+)\)">/g)]
    .map(([, name, x, y]) => ({ name, x: Number(x), y: Number(y) }));
}

const names = (kind: SettlementKind, seed: number) => buildings(composeSettlement(kind, seed)).map((building) => building.name);
const houseCount = (kind: SettlementKind, seed: number) =>
  names(kind, seed).filter((name) => /^(cottage|house|townhouse|longhouse|hall)-/.test(name)).length;

/** Wall parts in a settlement: every wall, round piece and gatehouse of its wall. */
const wallParts = (kind: SettlementKind, seed: number) => names(kind, seed).filter((name) => name.startsWith("wall-"));

describe("settlement sprites", () => {
  it("reads a part's grid footprint and body", () => {
    const part = parseTownPart("tower", tower);
    expect([part.cellsI, part.cellsJ]).toEqual([2, 2]);
    expect(part.originX).toBeGreaterThan(0);
    expect(part.originY).toBeLessThanOrEqual(part.height);
    expect(part.body).toMatch(/^<path/);
    expect(part.body).not.toContain("</svg>");
  });

  it("rejects a part without placement metadata", () => {
    expect(() => parseTownPart("bad", '<svg viewBox="0 0 10 10"><g class="part"><path d="M0 0"/></g></svg>')).toThrow();
  });

  it("draws a building first when it lies wholly behind another on the grid", () => {
    // The long row has the larger centre depth but sits behind the cottage
    // along i, so a plain depth sort would paint it over the cottage.
    const row = { name: "row", i: 0, j: 0, part: { cellsI: 1, cellsJ: 6 } };
    const cottage = { name: "cottage", i: 1, j: 0, part: { cellsI: 1, cellsJ: 1 } };
    const beside = { name: "beside", i: 2, j: 3, part: { cellsI: 2, cellsJ: 2 } };
    expect(paintOrder([cottage, beside, row]).map((entry) => entry.name)).toEqual(["row", "cottage", "beside"]);
  });

  it("is stable per seed and varies between seeds", () => {
    for (const { kind } of SETTLEMENT_KINDS) {
      expect(composeSettlement(kind, 5)).toBe(composeSettlement(kind, 5));
      expect(composeSettlement(kind, 5)).not.toBe(composeSettlement(kind, 6));
    }
  });

  it("keeps every building inside the view", () => {
    for (const { kind } of SETTLEMENT_KINDS) {
      for (let seed = 1; seed <= 8; seed++) {
        const svg = composeSettlement(kind, seed);
        const [minX, minY, width, height] = viewBox(svg);
        for (const { x, y } of buildings(svg)) {
          expect(x).toBeGreaterThanOrEqual(minX - 0.01);
          expect(x).toBeLessThan(minX + width);
          expect(y).toBeGreaterThanOrEqual(minY - 0.01);
          expect(y).toBeLessThan(minY + height);
        }
      }
    }
  });

  it("walls towns, castles and cities with the same wall parts and leaves hamlets, villages and keeps open", () => {
    for (let seed = 1; seed <= 8; seed++) {
      for (const kind of ["hamlet", "village", "keep"] as const) expect(wallParts(kind, seed)).toEqual([]);
      for (const kind of ["walled-town", "city"] as const) {
        expect(wallParts(kind, seed).filter((name) => name.startsWith("wall-gate-"))).toHaveLength(1);
        // Outside the parts a town draws only its ground.
        const outside = composeSettlement(kind, seed).replace(/<g class="p\d"[^>]*>[\s\S]*?<\/g>/g, "");
        expect(outside.match(/<path /g)).toHaveLength(1);
      }
      for (const kind of ["walled-town", "city", "castle"] as const) {
        expect(wallParts(kind, seed).some((name) => /^wall-[ij]-\d+$/.test(name))).toBe(true);
      }
    }
  });

  describe("castle", () => {
    const castle = (seed: number) => composeSettlement("castle", seed);

    it("has the great keep on the back corner, towers on the outermost square corners and one gatehouse", () => {
      for (let seed = 1; seed <= 12; seed++) {
        const layout = castleLayout(seed);
        const parts = layout.map(({ name }) => name);
        expect(parts.filter((name) => /^turret(-tall)?$/.test(name)).length).toBeGreaterThanOrEqual(1);
        expect(parts.filter((name) => /^turret(-tall)?$/.test(name)).length).toBeLessThanOrEqual(3);
        expect(parts.filter((name) => name.startsWith("gatehouse-"))).toHaveLength(1);
        expect(parts.filter((name) => name === "great-keep")).toHaveLength(1);
        expect(parts.some((name) => name.startsWith("church-") || name === "tower")).toBe(false);
        // Back corner: the keep covers the cells where the back walls meet.
        const keepCells = layout.find(({ name }) => name === "great-keep")!.footprint;
        expect([Math.min(...keepCells.map((p) => p[0])), Math.min(...keepCells.map((p) => p[1]))]).toEqual([-1, -1]);
      }
    });

    it("has an irregular outline with rotated walls that differs between seeds", () => {
      const outlines = new Set<string>();
      let rotated = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const { outline } = castleOutline(seed);
        outlines.add(JSON.stringify(outline));
        expect(outline.length).toBeGreaterThan(4);
        // Every side runs along i, along j or on a diagonal.
        outline.forEach((point, index) => {
          const next = outline[(index + 1) % outline.length];
          const [di, dj] = [next[0] - point[0], next[1] - point[1]];
          expect(di === 0 || dj === 0 || Math.abs(di) === Math.abs(dj)).toBe(true);
        });
        if (castleLayout(seed).some(({ name }) => /^wall-(flat|steep)-\d+$/.test(name))) rotated++;
      }
      expect(rotated).toBe(20);
      expect(outlines.size).toBeGreaterThanOrEqual(15);
    });

    it("stands a wall drum, never a tower, on every inner corner", () => {
      let inner = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const { outline, kinds } = castleOutline(seed);
        const drums = castleLayout(seed).filter(({ name }) => name === "wall-drum").map(({ footprint }) =>
          footprint.reduce((sum, p) => [sum[0] + p[0] / footprint.length, sum[1] + p[1] / footprint.length], [0, 0]));
        outline.forEach((point, index) => {
          const [prev, next] = [outline[(index + outline.length - 1) % outline.length], outline[(index + 1) % outline.length]];
          const turn = (point[0] - prev[0]) * (next[1] - point[1]) - (point[1] - prev[1]) * (next[0] - point[0]);
          if (turn >= 0) return;
          inner++;
          expect(kinds[index]).toBe("drum");
          expect(drums.some(([i, j]) => Math.hypot(i - point[0], j - point[1]) < 1e-6)).toBe(true);
        });
      }
      expect(inner).toBeGreaterThan(0);
    });

    it("draws each straight stretch of wall as one whole wall part", () => {
      /** The two ends of a wall's centre line, from its outline on the ground. */
      const ends = (footprint: readonly (readonly number[])[]) => [
        [(footprint[0][0] + footprint[3][0]) / 2, (footprint[0][1] + footprint[3][1]) / 2],
        [(footprint[1][0] + footprint[2][0]) / 2, (footprint[1][1] + footprint[2][1]) / 2],
      ];
      for (let seed = 1; seed <= 20; seed++) {
        const walls = castleLayout(seed).filter(({ name }) => /^wall-(i|j|flat|steep)-\d+$/.test(name));
        expect(walls.length).toBeGreaterThan(0);
        // No wall carries straight on into another: a piece stands between every two.
        for (const a of walls) {
          for (const b of walls) {
            if (a === b || a.name.replace(/\d+$/, "") !== b.name.replace(/\d+$/, "")) continue;
            for (const p of ends(a.footprint)) {
              for (const q of ends(b.footprint)) expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeGreaterThan(0.5);
            }
          }
        }
        // Outside the parts the castle draws only its ground: shadow, courtyard and path.
        const outside = castle(seed).replace(/<g class="p\d"[^>]*>[\s\S]*?<\/g>/g, "");
        expect(outside.match(/<path /g)).toHaveLength(3);
      }
    });

    it("stands a hall in each back wall in place of wall, and sometimes a house in a front one", () => {
      let withFrontHouse = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const { outline } = castleOutline(seed);
        /** Whether a cell's centre lies on the wall's centre line: the building stands in the wall there. */
        const onWall = (i: number, j: number) => outline.some((a, index) => {
          const b = outline[(index + 1) % outline.length];
          const [ci, cj] = [i + 0.5, j + 0.5];
          const cross = (b[0] - a[0]) * (cj - a[1]) - (b[1] - a[1]) * (ci - a[0]);
          const within = Math.min(a[0], b[0]) <= ci && ci <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= cj && cj <= Math.max(a[1], b[1]);
          return Math.abs(cross) < 1e-9 && within;
        });
        const inWall = castleLayout(seed).filter(({ name, footprint }) => {
          if (!name.startsWith("castle-")) return false;
          const [i0, j0] = [Math.min(...footprint.map((p) => p[0])), Math.min(...footprint.map((p) => p[1]))];
          const [i1, j1] = [Math.max(...footprint.map((p) => p[0])), Math.max(...footprint.map((p) => p[1]))];
          for (let i = i0; i < i1; i++) {
            for (let j = j0; j < j1; j++) if (onWall(i, j)) return true;
          }
          return false;
        });
        // One in each back wall, which the keep's corner joins: j = -1 and i = -1.
        expect(inWall.some(({ footprint }) => Math.min(...footprint.map((p) => p[1])) === -1)).toBe(true);
        expect(inWall.some(({ footprint }) => Math.min(...footprint.map((p) => p[0])) === -1)).toBe(true);
        if (inWall.length >= 3) withFrontHouse++;
      }
      expect(withFrontHouse).toBeGreaterThan(0);
      expect(withFrontHouse).toBeLessThan(20);
    });

    it("builds its yard from castle halls, never from village houses", () => {
      for (let seed = 1; seed <= 20; seed++) {
        const parts = names("castle", seed);
        // A hall on each back wall and one more tucked in.
        expect(parts.filter((name) => name.startsWith("castle-")).length).toBeGreaterThanOrEqual(2);
        expect(parts.some((name) => /^(cottage|house|townhouse|longhouse|hall|hut|shed)-/.test(name))).toBe(false);
      }
      for (const kind of ["hamlet", "village", "walled-town", "city"] as const) {
        for (let seed = 1; seed <= 6; seed++) expect(names(kind, seed).some((name) => name.startsWith("castle-"))).toBe(false);
      }
    });

    it("puts the gate on either front wall and at different spots along it", () => {
      const sides = new Set<string>();
      const spots = new Set<number>();
      for (let seed = 1; seed <= 40; seed++) {
        const found = buildings(castle(seed));
        const gate = found.find((building) => building.name.startsWith("gatehouse-"))!;
        const corner = found.find((building) => building.name === "great-keep")!;
        sides.add(gate.name);
        spots.add(Math.round((gate.x - corner.x) / 3));
      }
      expect(sides.size).toBe(2);
      expect(spots.size).toBeGreaterThanOrEqual(4);
    });

    it("stands its buildings on whole cells with nothing overlapping", () => {
      const whole = (value: number) => Math.abs(value - Math.round(value)) < 1e-9;
      /** Whether two convex outlines overlap by more than a touch. */
      const overlap = (a: readonly (readonly number[])[], b: readonly (readonly number[])[]) => [a, b].every((shape) => shape.every((point, index) => {
        const next = shape[(index + 1) % shape.length];
        const normal = [next[1] - point[1], point[0] - next[0]];
        const along = (outline: readonly (readonly number[])[]) => outline.map((p) => p[0] * normal[0] + p[1] * normal[1]);
        const [pa, pb] = [along(a), along(b)];
        return Math.max(...pa) > Math.min(...pb) + 1e-6 && Math.max(...pb) > Math.min(...pa) + 1e-6;
      }));
      for (let seed = 1; seed <= 40; seed++) {
        const layout = castleLayout(seed);
        for (const { name, footprint } of layout) {
          if (/^(castle-|gatehouse-|great-keep|turret$|turret-tall)/.test(name)) expect(footprint.flat().every(whole)).toBe(true);
        }
        for (let a = 0; a < layout.length; a++) {
          for (let b = a + 1; b < layout.length; b++) expect(overlap(layout[a].footprint, layout[b].footprint)).toBe(false);
        }
      }
    });

    it("has no battlements on the keep or the turret", () => {
      // The old keep stood a parapet and merlons on its roof walk: small
      // filled boxes between the eaves and half a cell above them. Open
      // strokes, like the faint slate courses, are not boxes.
      const wall = 3.4;
      const shapes = [...keep({ sizeI: 3, sizeJ: 3, height: wall, rise: 1.6, door: true }),
        ...roundTower({ radius: 0.85, height: 3.1, roof: 1.5 })];
      const rim = shapes.filter((shape) => !shape.detail && shape.points.every(([, , z]) => z >= wall && z <= wall + 0.5));
      expect(rim).toHaveLength(0);
    });
  });

  it("draws every line with the same ink colour and width", () => {
    const offenders: string[] = [];
    for (const { kind } of SETTLEMENT_KINDS) {
      for (let seed = 1; seed <= 6; seed++) {
        const svg = composeSettlement(kind, seed);
        // One root stroke, and nothing else sets its own colour or width.
        if (!svg.includes(`stroke="${INK}" stroke-width="${STROKE_WIDTH}"`)) offenders.push(`${kind}: no root stroke`);
        if (svg.includes("stroke-opacity")) offenders.push(`${kind}: stroke-opacity`);
        const elements = svg.match(/<path [^>]*>/g) ?? [];
        for (const element of elements) {
          const stroke = /stroke="([^"]*)"/.exec(element)?.[1];
          const fill = /fill="([^"]*)"/.exec(element)?.[1];
          // Only a seamless facet sets a stroke: its own fill, as a hairline to close gaps.
          if (stroke !== undefined && stroke !== fill) offenders.push(`${kind}: ${element.slice(0, 80)}`);
        }
        // The roof colour rules never touch stroke, except for the seams of cone facets.
        for (const rule of svg.match(/\.p\d [^{]*\{[^}]*stroke:[^}]*\}/g) ?? []) {
          if (!rule.includes("roof-seam")) offenders.push(`${kind}: css ${rule}`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("gives each kind the buildings that make it", () => {
    for (let seed = 1; seed <= 12; seed++) {
      expect(houseCount("hamlet", seed)).toBeGreaterThanOrEqual(2);
      expect(houseCount("hamlet", seed)).toBeLessThanOrEqual(3);
      expect(names("hamlet", seed).some((name) => /keep|tower|turret|church/.test(name))).toBe(false);
      expect(houseCount("village", seed)).toBeGreaterThanOrEqual(4);
      expect(names("keep", seed)).toContain("keep");
      expect(composeSettlement("keep", seed)).toContain(`<g class="p${CASTLE_SLATE}" data-part="keep"`);
      expect(names("castle", seed)).toContain("great-keep");
      expect(houseCount("walled-town", seed)).toBeGreaterThanOrEqual(4);
      expect(houseCount("city", seed)).toBeGreaterThanOrEqual(15);
      expect(houseCount("city", seed)).toBeGreaterThan(houseCount("walled-town", seed));
      expect(names("city", seed).some((name) => name.startsWith("church-"))).toBe(true);
    }
  });

  it("is quick enough to redraw while a seed is typed", () => {
    const start = performance.now();
    for (let seed = 100; seed < 110; seed++) composeSettlement("city", seed);
    expect((performance.now() - start) / 10).toBeLessThan(60);
  });
});

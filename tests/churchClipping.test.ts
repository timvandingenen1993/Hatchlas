import { describe, expect, it } from "vitest";
import { fitViewBox, parsePartDocument, serializePartDocument, shapePoints } from "../src/structures/partDocument";
import { isLayoutPart, type PlacementRules } from "../src/structures/partPlacement";
import { PARTS, parseTownPart } from "../src/structures/townParts";
import { composeSettlement } from "../src/structures/townSprite";

/** Visible straight-line vertices, including ancestor and per-path translations. */
function vertices(svg: string, partName?: string) {
  const stack = [{ x: 0, y: 0, include: partName === undefined }];
  const points: [number, number][] = [];
  const translation = (element: string) => {
    const match = /\btransform="translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)"/.exec(element);
    return match ? [Number(match[1]), Number(match[2])] : [0, 0];
  };
  for (const [element] of svg.matchAll(/<\/g>|<g\b[^>]*>|<path\b[^>]*\/>/g)) {
    if (element === "</g>") {
      stack.pop();
      continue;
    }
    const parent = stack.at(-1)!;
    const [dx, dy] = translation(element);
    if (element.startsWith("<g")) {
      stack.push({ x: parent.x + dx, y: parent.y + dy,
        include: parent.include || /\bdata-part="([^"]+)"/.exec(element)?.[1] === partName });
    } else if (parent.include) {
      for (const [x, y] of shapePoints(element)?.points ?? []) points.push([parent.x + dx + x, parent.y + dy + y]);
    }
  }
  return points;
}

const editedPart = '<svg width="180" height="240" viewBox="-8 -30 60 80" data-footprint="2 2" data-origin="12 15">'
  + '<g class="part"><path transform="translate(2 -1)" d="M14 -26L4 20L24 20Z"/></g></svg>';

describe("edited building bounds", () => {
  it("keeps path positions relative to the grid origin when the viewBox starts above or left of zero", () => {
    const part = parseTownPart("spire", editedPart);
    const relative = vertices(part.body).map(([x, y]) => [x - part.originX, y - part.originY]);
    expect(relative).toEqual([[4, -42], [-6, 4], [14, 4]]);
    expect(vertices(part.body)).toEqual([[24, 3], [14, 49], [34, 49]]);
    expect([part.width, part.height]).toEqual([60, 80]);
  });

  it("expanding a saved viewBox adds room without moving a building on the settlement grid", () => {
    const doc = parsePartDocument(editedPart);
    const before = parseTownPart("spire", serializePartDocument(doc));
    const grown = fitViewBox(doc, { x: -40, y: -70, width: 110, height: 210 }, 2.2);
    const after = parseTownPart("spire", serializePartDocument(grown));
    const original = vertices(before.body).map(([x, y]) => [x - before.originX, y - before.originY]);
    const expanded = vertices(after.body).map(([x, y]) => [x - after.originX, y - after.originY]);
    for (let index = 0; index < original.length; index++) {
      expect(expanded[index][0]).toBeCloseTo(original[index][0], 8);
      expect(expanded[index][1]).toBeCloseTo(original[index][1], 8);
    }
  });

  it("preserves unshifted part markup when the viewBox already starts at zero", () => {
    const source = editedPart.replace('viewBox="-8 -30 60 80"', 'viewBox="0 0 60 80"');
    expect(parseTownPart("spire", source).body).toBe('<path transform="translate(2 -1)" d="M14 -26L4 20L24 20Z"/>');
  });

  for (const church of ["church-gable-left", "church-gable-right"]) {
    it(`keeps the full ${church} tower inside settlement bounds`, () => {
      const disabled = Object.fromEntries(PARTS.filter(({ name }) => !isLayoutPart(name)).map(({ name }) => [name, []]));
      let seen = 0;
      for (const kind of ["village", "walled-town", "city"] as const) {
        const rules: PlacementRules = { ...disabled, [church]: [kind] };
        for (let seed = 1; seed <= 20; seed++) {
          const svg = composeSettlement(kind, seed, rules);
          const points = vertices(svg, church);
          if (!points.length) continue;
          seen++;
          const [x, y, width, height] = /\bviewBox="([^"]*)"/.exec(svg)![1].split(/\s+/).map(Number);
          for (const [px, py] of points) {
            expect(px, `${kind} ${seed}`).toBeGreaterThanOrEqual(x - 0.02);
            expect(py, `${kind} ${seed}`).toBeGreaterThanOrEqual(y - 0.02);
            expect(px, `${kind} ${seed}`).toBeLessThanOrEqual(x + width + 0.02);
            expect(py, `${kind} ${seed}`).toBeLessThanOrEqual(y + height + 0.02);
          }
        }
      }
      expect(seen).toBeGreaterThanOrEqual(20);
    });
  }
});

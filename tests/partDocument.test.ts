import { describe, expect, it } from "vitest";
import {
  fitViewBox,
  nearestOnOutline,
  parsePartDocument,
  serializePartDocument,
  shapePoints,
  transplantLayer,
  withShapePoints,
  type Point,
} from "../src/structures/partDocument";
import { parseTownPart } from "../src/structures/townParts";

const FILES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../src/assets/structures/town-parts/*.svg", { query: "?raw", import: "default", eager: true }),
  ).map(([path, source]) => [path.replace(/^.*\/|\.svg$/g, ""), source]),
);

describe("town part documents", () => {
  it("writes every part file back unchanged when nothing was edited", () => {
    for (const [name, source] of Object.entries(FILES)) {
      const edited = /<svg\b[^>]*\sdata-edited=/.test(source);
      expect(serializePartDocument(parsePartDocument(source), edited), name).toBe(source);
    }
  });

  it("names every layer of every part, once", () => {
    for (const [name, source] of Object.entries(FILES)) {
      const layers = parsePartDocument(source).layers.map((layer) => layer.name);
      expect(layers, name).not.toContain("unnamed");
      expect(new Set(layers).size, name).toBe(layers.length);
    }
    expect(parsePartDocument(FILES["house-gable-right"]).layers.map((layer) => layer.name))
      .toEqual(["chimney", "walls", "windows", "door", "eaves", "roof", "roof lines"]);
  });

  it("reorders, hides and moves layers, and the composer sees only what is drawn", () => {
    const doc = parsePartDocument(FILES["house-gable-right"]);
    const byName = (name: string) => doc.layers.find((layer) => layer.name === name)!;
    const chimney = { ...byName("chimney"), dx: 2.5, dy: -1 };
    const edited = {
      ...doc,
      layers: [byName("walls"), byName("windows"), byName("door"), byName("eaves"), byName("roof"), chimney, { ...byName("roof lines"), hidden: true }],
    };
    const text = serializePartDocument(edited);
    expect(text).toMatch(/<svg\b[^>]*\sdata-edited="true"/);

    const reread = parsePartDocument(text);
    expect(reread.layers.map((layer) => [layer.name, layer.hidden, layer.dx, layer.dy])).toEqual([
      ["walls", false, 0, 0], ["windows", false, 0, 0], ["door", false, 0, 0], ["eaves", false, 0, 0],
      ["roof", false, 0, 0], ["chimney", false, 2.5, -1], ["roof lines", true, 0, 0],
    ]);

    const part = parseTownPart("house-gable-right", text);
    expect(part.body).not.toContain("data-layer");
    expect(part.body).not.toContain('display="none"');
    // The chimney now paints after (over) the roof, offset.
    const roofAt = part.body.indexOf('class="roof-lit"');
    const chimneyAt = part.body.indexOf('transform="translate(2.5 -1)"');
    expect(roofAt).toBeGreaterThan(-1);
    expect(chimneyAt).toBeGreaterThan(roofAt);
    const drawn = (body: string) => body.match(/<path /g)?.length ?? 0;
    expect(drawn(part.body)).toBe(drawn(parseTownPart("house", FILES["house-gable-right"]).body) - byName("roof lines").elements.length);
  });

  it("grows the viewBox to fit moved layers, and leaves it when they fit", () => {
    const doc = parsePartDocument(FILES["tower"]);
    const [x, y, width, height] = doc.viewBox;
    expect(fitViewBox(doc, { x: x + 3, y: y + 3, width: 4, height: 4 }, 2.2)).toBe(doc);
    const grown = fitViewBox(doc, { x: x - 10, y: y + 3, width: 4, height: height + 5 }, 2.2);
    expect(grown.viewBox[0]).toBeCloseTo(x - 12.2, 5);
    expect(grown.viewBox[0] + grown.viewBox[2]).toBeCloseTo(x + width, 5);
    expect(grown.viewBox[1] + grown.viewBox[3]).toBeCloseTo(y + 3 + height + 5 + 2.2, 5);
    expect(grown.size).toEqual([grown.viewBox[2] * 3, grown.viewBox[3] * 3]);
    // The grid origin stays put, so the composer places the part as before.
    const before = parseTownPart("tower", serializePartDocument(doc, false));
    const after = parseTownPart("tower", serializePartDocument(grown));
    expect(after.originX - (doc.viewBox[0] - grown.viewBox[0])).toBeCloseTo(before.originX, 5);
  });

  it("reads and rewrites the corners of every shape in every part unchanged", () => {
    for (const [name, source] of Object.entries(FILES)) {
      for (const layer of parsePartDocument(source).layers) {
        for (const element of layer.elements) {
          const shape = shapePoints(element);
          expect(shape, `${name} ${layer.name}: ${element.slice(0, 60)}`).not.toBeNull();
          expect(withShapePoints(element, shape!)).toBe(element);
        }
      }
    }
  });

  it("parses straight-line path data in any form, and refuses curves", () => {
    expect(shapePoints('<path d="M1 2L3 4Z"/>')).toEqual({ points: [[1, 2], [3, 4]], closed: true });
    expect(shapePoints('<path d="m1,2 l2 2 h1 v-1 z"/>')).toEqual({ points: [[1, 2], [3, 4], [4, 4], [4, 3]], closed: true });
    expect(shapePoints('<path d="M0 0 10 0 10 5"/>')).toEqual({ points: [[0, 0], [10, 0], [10, 5]], closed: false });
    expect(shapePoints('<path d="M0 0C1 1 2 2 3 3"/>')).toBeNull();
    expect(shapePoints('<path d="M0 0L1 1ZM5 5L6 6Z"/>')).toBeNull();
    const moved = withShapePoints('<path fill="#fff" d="M0 0L1 1Z"/>', { points: [[0.123, -4], [2, 2.555], [7, 7]], closed: true });
    expect(moved).toBe('<path fill="#fff" d="M0.12 -4L2 2.56L7 7Z"/>');
  });

  it("finds where a new corner goes on an outline", () => {
    const square = { points: [[0, 0], [10, 0], [10, 10], [0, 10]] as Point[], closed: true };
    expect(nearestOnOutline(square, 5, -1)).toEqual({ insertAt: 1, point: [5, 0], distance: 1 });
    // The closing edge, from the last corner back to the first.
    expect(nearestOnOutline(square, -2, 4)).toEqual({ insertAt: 4, point: [0, 4], distance: 2 });
    const line = { points: square.points, closed: false };
    expect(nearestOnOutline(line, -2, 4).insertAt).not.toBe(4);
  });

  it("keeps a borrowed layer at its grid position", () => {
    const from = parsePartDocument(FILES["house-gable-right"]);
    const to = parsePartDocument(FILES["cottage-gable-right"]);
    const chimney = from.layers.find((layer) => layer.name === "chimney")!;
    const copy = transplantLayer(chimney, from, to);
    expect(copy.id).not.toBe(chimney.id);
    expect(copy.dx).toBeCloseTo(to.origin[0] - from.origin[0], 5);
    expect(copy.dy).toBeCloseTo(to.origin[1] - from.origin[1], 5);
  });
});

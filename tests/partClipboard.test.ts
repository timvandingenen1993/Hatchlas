import { describe, expect, it } from "vitest";
import { copyPartSelection, insertPartLayers, pastePartLayers } from "../src/structures/partClipboard";
import { parsePartDocument } from "../src/structures/partDocument";

function document() {
  return parsePartDocument('<svg width="100" height="100" viewBox="0 0 100 100" data-footprint="1 1" data-origin="10 20">'
    + '<g class="part"><path data-layer="walls" transform="translate(3 4)" d="M0 0L4 0L4 4Z"/>'
    + '<path data-layer="walls" transform="translate(3 4)" d="M8 0L12 0L12 4Z"/>'
    + '<path data-layer="roof" transform="translate(-1 2)" d="M0 0L4 0L2 -3Z"/>'
    + '<path data-layer="hidden" display="none" d="M0 0L4 0L2 -3Z"/></g></svg>');
}

describe("structure lab copy and paste", () => {
  it("copies a layer group in paint order, preserving geometry, spacing and visibility", () => {
    const start = document();
    const clipboard = copyPartSelection(start, { kind: "layers", ids: start.layers.map((layer) => layer.id).reverse() })!;
    const copies = pastePartLayers(clipboard, start, [2, 2]);
    expect(copies.map((layer) => layer.name)).toEqual(["walls copy", "roof copy", "hidden copy"]);
    expect(copies.map(({ dx, dy }) => [dx, dy])).toEqual([[5, 6], [1, 4], [2, 2]]);
    expect(copies.map((layer) => layer.elements)).toEqual(start.layers.map((layer) => layer.elements));
    expect(copies[2].hidden).toBe(true);
    expect(copies.every((layer) => !start.layers.some((original) => original.id === layer.id))).toBe(true);
    expect(new Set(copies.map((layer) => layer.id)).size).toBe(copies.length);
  });

  it("copies only selected shapes across layers, ignoring duplicate and stale references", () => {
    const start = document();
    const wall = { layerId: start.layers[0].id, el: 1 };
    const roof = { layerId: start.layers[1].id, el: 0 };
    const clipboard = copyPartSelection(start, { kind: "shapes", shapes: [roof, wall, wall, { ...wall, el: 99 }] })!;
    expect(clipboard.kind).toBe("shapes");
    expect(clipboard.layers.map((layer) => layer.elements)).toEqual([
      [start.layers[0].elements[1]], [start.layers[1].elements[0]],
    ]);
    expect(copyPartSelection(start, { kind: "shapes", shapes: [{ layerId: start.layers[2].id, el: 0 }] })).toBeNull();
    expect(copyPartSelection(start, { kind: "layers", ids: [] })).toBeNull();
  });

  it("keeps a copy-time snapshot after source edits", () => {
    const start = document();
    const originalElement = start.layers[0].elements[0];
    const clipboard = copyPartSelection(start, { kind: "layers", ids: [start.layers[0].id] })!;
    start.layers[0].elements[0] = '<path d="M50 50L60 60Z"/>';
    start.layers[0].dx = 100;
    start.origin[0] = 999;
    expect(clipboard.layers[0].elements[0]).toBe(originalElement);
    expect(clipboard.layers[0].dx).toBe(3);
    expect(clipboard.origin).toEqual([10, 20]);
  });

  it("pastes across parts aligned to their grid origins", () => {
    const start = document();
    const clipboard = copyPartSelection(start, { kind: "layers", ids: [start.layers[0].id, start.layers[1].id] })!;
    const target = { ...document(), origin: [50, -20] as [number, number] };
    const copies = pastePartLayers(clipboard, target, [2, 2]);
    expect(copies.map(({ dx, dy }) => [dx, dy])).toEqual([[45, -34], [41, -36]]);
    expect(copies[0].dx - copies[1].dx).toBe(start.layers[0].dx - start.layers[1].dx);
  });

  it("inserts a whole group above the active layer and gives repeated pastes new IDs and names", () => {
    const start = document();
    const clipboard = copyPartSelection(start, { kind: "layers", ids: [start.layers[0].id, start.layers[1].id] })!;
    const first = pastePartLayers(clipboard, start, [2, 2]);
    const pasted = insertPartLayers(start, first, start.layers[1].id);
    expect(pasted.layers.map((layer) => layer.name)).toEqual(["walls", "roof", "walls copy", "roof copy", "hidden"]);
    const second = pastePartLayers(clipboard, pasted, [4, 4]);
    expect(second.map((layer) => layer.name)).toEqual(["walls copy 2", "roof copy 2"]);
    expect(second.every((layer) => !pasted.layers.some((previous) => layer.id === previous.id))).toBe(true);
    expect(second[0].dx - first[0].dx).toBe(2);
    expect(start.layers).toHaveLength(3);
    expect(insertPartLayers(start, first, "missing").layers.slice(-2)).toEqual(first);
    expect(insertPartLayers(start, [], null)).toBe(start);
  });
});

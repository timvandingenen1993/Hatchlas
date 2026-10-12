import { describe, expect, it } from "vitest";
import { shapePoints, type PartDocument } from "../src/structures/partDocument";
import {
  allPoints, layerRange, moveLayers, movePoints, pointTargets,
  sameCorner, selectItem, shapeCorners,
} from "../src/structures/partSelection";

function document(): PartDocument {
  return {
    attributes: [], defs: "", groupOpen: '<g class="part">',
    viewBox: [0, 0, 100, 100], size: [100, 100], footprint: [1, 1], origin: [0, 0],
    layers: [
      { id: "walls", name: "walls", dx: 10, dy: 5, hidden: false,
        elements: ['<path d="M0 0L4 0L4 4L0 4Z"/>', '<path d="M8 0L12 0L12 4L8 4Z"/>'] },
      { id: "roof", name: "roof", dx: 6, dy: 5, hidden: false,
        elements: ['<path d="M4 0L8 0L6 -3Z"/>'] },
      { id: "hidden", name: "hidden", dx: 10, dy: 5, hidden: true,
        elements: ['<path d="M0 0L4 0L2 -3Z"/>'] },
    ],
  };
}

describe("structure lab multi-selection", () => {
  it("adds and removes corners by identity, and preserves a group when grabbed without modifiers", () => {
    const a = { layerId: "walls", el: 0, index: 0 };
    const b = { layerId: "roof", el: 0, index: 0 };
    const c = { layerId: "walls", el: 1, index: 0 };
    const group = selectItem([a], b, true, sameCorner);
    expect(group).toEqual([a, b]);
    expect(selectItem(group, { ...a }, false, sameCorner)).toEqual(group);
    expect(selectItem(group, { ...a }, true, sameCorner)).toEqual([b]);
    expect(selectItem(group, c, false, sameCorner)).toEqual([c]);
  });

  it("selects contiguous layer ranges in either direction with a stable anchor", () => {
    const order = ["roof", "windows", "walls", "door"];
    expect(layerRange(order, "windows", "door")).toEqual(["windows", "walls", "door"]);
    expect(layerRange(order, "door", "windows")).toEqual(["windows", "walls", "door"]);
    expect(layerRange(order, "deleted", "walls")).toEqual(["walls"]);
    expect(layerRange(order, null, "roof")).toEqual(["roof"]);
  });

  it("moves layers by one delta, preserving offsets and leaving other layers and geometry intact", () => {
    const start = document();
    const next = moveLayers(start, ["walls", "roof"], 3, -2);
    expect(next.layers.map(({ dx, dy }) => [dx, dy])).toEqual([[13, 3], [9, 3], [10, 5]]);
    expect(next.layers[2]).toBe(start.layers[2]);
    expect(next.layers[0].elements).toBe(start.layers[0].elements);
    expect(start.layers[0].dx).toBe(10);
    expect(moveLayers(start, ["walls"], 0, 0)).toBe(start);
  });

  it("moves selected corners across layers with different offsets without moving unselected corners", () => {
    const start = document();
    const selection = [{ layerId: "walls", el: 0, index: 2 }, { layerId: "roof", el: 0, index: 2 }];
    const next = movePoints(start, pointTargets(start, selection, false), 2, -1);
    expect(shapePoints(next.layers[0].elements[0])?.points).toEqual([[0, 0], [4, 0], [6, 3], [0, 4]]);
    expect(shapePoints(next.layers[1].elements[0])?.points).toEqual([[4, 0], [8, 0], [8, -4]]);
    expect(next.layers[0].elements[1]).toBe(start.layers[0].elements[1]);
    expect(next.layers[2]).toBe(start.layers[2]);
    expect(next.layers.map(({ dx, dy }) => [dx, dy])).toEqual(start.layers.map(({ dx, dy }) => [dx, dy]));
  });

  it("resolves shared corners once and ignores hidden layers and stale references", () => {
    const start = document();
    const a = { layerId: "walls", el: 0, index: 0 };
    const b = { layerId: "roof", el: 0, index: 0 };
    expect(pointTargets(start, [a], false)).toHaveLength(1);
    const targets = pointTargets(start, [a, a, b, { ...a, index: 99 }], true);
    expect(targets).toHaveLength(2);
    const next = movePoints(start, targets, 1, 2);
    expect(allPoints(next).filter((point) => sameCorner(point, a) || sameCorner(point, b))
      .map(({ ax, ay }) => [ax, ay])).toEqual([[11, 7], [11, 7]]);
    expect(next.layers[2]).toBe(start.layers[2]);
  });

  it("moves whole selected shapes once and calculates successive drag positions from the start", () => {
    const start = document();
    const selection = [{ layerId: "walls", el: 0 }, { layerId: "walls", el: 1 }, { layerId: "roof", el: 0 }];
    const targets = pointTargets(start, shapeCorners(start, [...selection, selection[0]]), false);
    expect(targets).toHaveLength(11);
    const first = movePoints(start, targets, 2, 3);
    const second = movePoints(start, targets, 5, 7);
    expect(shapePoints(first.layers[0].elements[0])?.points[0]).toEqual([2, 3]);
    expect(shapePoints(second.layers[0].elements[0])?.points[0]).toEqual([5, 7]);
    expect(shapePoints(second.layers[1].elements[0])?.points[0]).toEqual([9, 7]);
    expect(shapePoints(start.layers[0].elements[0])?.points[0]).toEqual([0, 0]);
  });
});

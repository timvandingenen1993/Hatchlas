import { describe, expect, it } from "vitest";
import {
  buildWaterStrokeGeometry,
  emptyWaterStrokeGeometry,
} from "../src/rendering/waterStrokeGeometry";

describe("water stroke geometry", () => {
  it("packs paths, widths, families, and bounds deterministically", () => {
    const geometry = buildWaterStrokeGeometry(100, 80, [
      {
        id: 7,
        family: "river",
        points: [
          { x: 2, y: 3, radius: 1.5 },
          { x: 8, y: 5, radius: 2.25 },
        ],
      },
      {
        id: 11,
        family: "offshore",
        points: [
          { x: 20, y: 10 },
          { x: 24, y: 14 },
          { x: 29, y: 12 },
        ],
      },
      { id: 99, family: "inland", points: [{ x: 1, y: 1 }] },
    ]);

    expect(geometry.width).toBe(100);
    expect(geometry.height).toBe(80);
    expect(Array.from(geometry.pathOffsets)).toEqual([0, 2, 5]);
    expect(Array.from(geometry.stableIds)).toEqual([7, 11]);
    expect(Array.from(geometry.families)).toEqual([1, 4]);
    expect(Array.from(geometry.pointRadius)).toEqual([1.5, 2.25, 0, 0, 0]);
    expect(Array.from(geometry.bounds)).toEqual([
      2, 3, 8, 5,
      20, 10, 29, 14,
    ]);
  });

  it("returns owned empty buffers for raw water surfaces", () => {
    const first = emptyWaterStrokeGeometry(12, 9);
    const second = emptyWaterStrokeGeometry(12, 9);

    expect(first).not.toBe(second);
    expect(first.pointX.length).toBe(0);
    expect(first.pathOffsets.length).toBe(1);
    expect(first.pathOffsets[0]).toBe(0);
    expect(first.pointX).not.toBe(second.pointX);
  });
});

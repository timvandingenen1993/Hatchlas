import { describe, expect, it } from "vitest";
import {
  compareMountainGpuImages,
  createMountainGpuSession,
} from "../src/rendering/mountainGpuRenderer";

describe("GPU compositor contracts", () => {
  it("computes a per-channel diff and counts each changed pixel once", () => {
    const expected = new Uint8ClampedArray([
      10, 20, 30, 255,
      40, 50, 60, 255,
    ]);
    const actual = new Uint8ClampedArray([
      11, 22, 30, 254,
      40, 50, 62, 255,
    ]);
    expect(compareMountainGpuImages(expected, actual)).toEqual({
      maxAbsError: 2,
      meanAbsError: 0.75,
      changedPixels: 2,
    });
  });

  it("does not create a GPU session when the runtime has no WebGPU", async () => {
    await expect(createMountainGpuSession({ mode: "auto" })).resolves.toBeNull();
  });

});

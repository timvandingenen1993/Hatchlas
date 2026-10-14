import { describe, expect, it } from "vitest";
import { SimplexNoise } from "../src/core/noise";
import { buildPropStandTerrain, propStandGround, propStandSiltClearing } from "../src/rendering/vegetationRenderer";

const WIDTH = 6;

describe("prop stand ground", () => {
  it("rules out snow, glacier, ocean and cliffs but keeps gentle slopes", () => {
    const terrain = buildPropStandTerrain({
      width: WIDTH,
      height: 1,
      // meadow, glacier, ocean, meadow, meadow, high and frozen meadow
      biomeType: new Uint8Array([20, 0, 8, 20, 20, 20]),
      slopeDeg: new Float32Array([10, 0, 0, 30, 55, 0]),
      normalizedElevation: new Float32Array([0.3, 0.9, 0, 0.3, 0.3, 0.8]),
      temperatureC: new Float32Array([10, -10, 10, 10, 10, -5]),
    });
    expect(Array.from(terrain)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("lets a stand reach between a fifth of a tree and a tree into silt", () => {
    const width = 200;
    const height = 240;
    const markSize = 8;
    // Distance into a silt field whose edge runs down x = 20.
    const depth = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 20; x < width; x++) depth[y * width + x] = x - 19;
    const clearing = propStandSiltClearing(depth, width, height, markSize, new SimplexNoise(3));
    const reaches: number[] = [];
    for (let y = 0; y < height; y++) {
      expect(clearing[y * width + 10]).toBe(0);
      let x = 20;
      while (clearing[y * width + x] < 0.5) x++;
      reaches.push(x - 19);
      expect(clearing[y * width + 60]).toBe(1);
    }
    expect(Math.min(...reaches)).toBeGreaterThanOrEqual(markSize * 0.2 - 1);
    expect(Math.max(...reaches)).toBeLessThanOrEqual(markSize + 1);
    // The reach varies along the edge: organic, not a parallel offset.
    expect(Math.max(...reaches) - Math.min(...reaches)).toBeGreaterThan(1);
  });

  it("keeps a stand a third of a tree back from water", () => {
    const terrain = new Float32Array(WIDTH).fill(1);
    const waterDistance = new Float32Array([0, 1, 2, 3, 4, 20]);
    const ground = propStandGround(terrain, waterDistance, 8);
    // Clearance 2.8 px: off at the water, past 0.5 beyond it, full well away.
    expect(ground[0]).toBe(0);
    expect(ground[1]).toBeLessThan(0.5);
    expect(ground[3]).toBeGreaterThan(0.5);
    expect(ground[5]).toBe(1);
  });
});

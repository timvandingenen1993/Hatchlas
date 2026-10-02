import { describe, expect, it } from "vitest";
import type { MountainDEMData } from "../src/terrain/mountainBaseDEM";
import {
  buildWaterOverlayGeometry,
  renderWaterOverlayFromGeometry,
  type RiverSpline,
} from "../src/rendering/waterRenderer";

function makeOceanDem(width: number, height: number): MountainDEMData {
  const total = width * height;
  const isOcean = new Uint8Array(total);
  const biomeType = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = Math.floor(width * 0.4); x < width; x++) {
      isOcean[y * width + x] = 1;
      biomeType[y * width + x] = 8;
    }
  }
  return {
    width,
    height,
    isOcean,
    biomeType,
    isRiverChannel: new Uint8Array(total),
    flowDirection: new Int8Array(total).fill(-1),
    drainageAreaKm2: new Float32Array(total),
    waterDepthM: new Float32Array(total),
    strahlerOrder: new Uint8Array(total),
  } as MountainDEMData;
}

describe("optimized water paint stage", () => {
  it("reuses immutable guidance and packed paths across paint-only updates", () => {
    const dem = makeOceanDem(96, 64);
    const options = {
      riverThresholdKm2: 2,
      seed: 17,
      riverSplinesOverride: [
        {
          key: 41,
          samples: [
            { x: 8, y: 24, radius: 2, area: 3, order: 2, sourceIndex: 1 },
            { x: 20, y: 25, radius: 2.5, area: 4, order: 2, sourceIndex: 2 },
            { x: 32, y: 23, radius: 3, area: 5, order: 3, sourceIndex: 3 },
          ],
        },
      ] satisfies readonly RiverSpline[],
      oceanRippleCount: 5,
      deepOceanSwells: true,
      deepOceanSwellDensity: 0.6,
    };
    const geometry = buildWaterOverlayGeometry(dem, options);
    const guidance = geometry.coastWaveField ?? geometry.waveField;
    const guidanceSnapshot = Array.from(guidance);
    const paths = geometry.strokeGeometry;

    const thin = renderWaterOverlayFromGeometry(dem, {
      ...options,
      outlineThickness: 0.5,
      outlineOpacity: 0.65,
    }, geometry);
    const thick = renderWaterOverlayFromGeometry(dem, {
      ...options,
      outlineThickness: 2.5,
      outlineOpacity: 0.95,
    }, geometry);

    expect(Array.from(guidance)).toEqual(guidanceSnapshot);
    expect(geometry.coastWaveField).toBe(guidance);
    expect(geometry.strokeGeometry).toBe(paths);
    expect(paths?.stableIds.length).toBe(1);
    expect(thick.oceanFlowAlpha?.some((value) => value > 0)).toBe(true);
    expect(Array.from(thick.oceanFlowAlpha ?? [])).not.toEqual(
      Array.from(thin.oceanFlowAlpha ?? []),
    );
  });
});

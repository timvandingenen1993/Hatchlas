import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildForestLightField,
  DEFAULT_FOREST_LIGHT_SETTINGS,
  getForestLightTextureCanvas,
  renderForestLightTexture,
  type ForestLightField,
} from "../src/rendering/forestPropLighting";
import type { VegetationRasterPropAsset } from "../src/rendering/vegetationRenderer";

afterEach(() => vi.unstubAllGlobals());

describe("forest lighting texture publication", () => {
  it("packs reusable lighting fields into bounded typed arrays", () => {
    const context = {
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
      getImageData: (_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let pixel = 0; pixel < width * height; pixel++) data[pixel * 4 + 3] = 255;
        return { data } as ImageData;
      },
    };
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("document", {
      createElement: () => ({ getContext: () => context }),
    });
    const asset: VegetationRasterPropAsset = {
      key: "alpine-test-tree",
      family: "universal",
      kind: "raster-prop",
      width: 4,
      height: 4,
      data: new Uint8ClampedArray(4 * 4 * 4),
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 1,
      anchorX: 0.5,
      anchorY: 1,
      eligibleBiomeIds: [],
      vectorPaths: [{
        closed: true,
        fillColor: [80, 120, 85],
        strokeWidth: 1,
        points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
      }],
    };

    const field = buildForestLightField(asset, 23817);

    expect(field).not.toBeNull();
    if (!field) return;
    expect(field.edgeDistances).toBeInstanceOf(Uint16Array);
    expect(field.coarseNoise).toBeInstanceOf(Int16Array);
    expect(field.mixedNoise).toBeInstanceOf(Int16Array);
    expect(field.edgeDistances.byteLength).toBe(field.width * field.height * 2);
    expect(buildForestLightField(asset, 23817)).toBe(field);
    expect(context.fill).toHaveBeenCalledTimes(1);
    const reseeded = buildForestLightField(asset, 23818);
    expect(reseeded).not.toBe(field);
    expect(reseeded?.mixedNoise).not.toEqual(field.mixedNoise);
    expect(buildForestLightField({ ...asset }, 23817)).toBe(field);
    const revisedAsset: VegetationRasterPropAsset = {
      ...asset,
      vectorPaths: [{
        ...asset.vectorPaths![0],
        points: asset.vectorPaths![0].points.map((point, index) =>
          index === 0 ? { ...point, x: point.x - 0.25 } : point,
        ),
      }],
    };
    expect(buildForestLightField(revisedAsset, 23817)).not.toBe(field);
    const texture = getForestLightTextureCanvas(field, DEFAULT_FOREST_LIGHT_SETTINGS);
    expect(getForestLightTextureCanvas(field, DEFAULT_FOREST_LIGHT_SETTINGS)).toBe(texture);
    expect(context.putImageData).toHaveBeenCalledTimes(1);
    expect(getForestLightTextureCanvas(field, {
      ...DEFAULT_FOREST_LIGHT_SETTINGS,
      strength: DEFAULT_FOREST_LIGHT_SETTINGS.strength + 0.1,
    })).not.toBe(texture);
    expect(context.putImageData).toHaveBeenCalledTimes(2);
  });

  it("encodes asynchronously and publishes a disposable blob URL", async () => {
    const context = {
      createImageData: () => ({ data: new Uint8ClampedArray(2 * 2 * 4) }),
      putImageData: vi.fn(),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: vi.fn((callback: BlobCallback) => {
        queueMicrotask(() => callback(new Blob(["png"])));
      }),
      toDataURL: vi.fn(() => "data:image/png;base64,unused"),
    };
    vi.stubGlobal("document", { createElement: () => canvas });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:forest-light") });

    const field: ForestLightField = {
      key: "alpine-test-tree",
      width: 2,
      height: 2,
      padding: 0,
      canopyWidth: 2,
      baseColor: [80, 120, 85],
      rowCenters: new Float32Array([1, 1]),
      rowHalfWidths: new Float32Array([1, 1]),
      edgeDistances: new Uint16Array([32, 32, 32, 32]),
      coarseNoise: new Int16Array(4),
      mixedNoise: new Int16Array(4),
    };

    const texture = await renderForestLightTexture(field, DEFAULT_FOREST_LIGHT_SETTINGS);

    expect(canvas.toBlob).toHaveBeenCalledOnce();
    expect(canvas.toDataURL).not.toHaveBeenCalled();
    expect(texture).toMatchObject({
      url: "blob:forest-light",
      width: 2,
      height: 2,
      padding: 0,
      byteLength: 3,
    });
  });
});

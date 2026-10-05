import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FOREST_RENDER_SETTINGS,
  forestRenderSettingsSignature,
  normalizeForestRenderSettings,
  readInitialForestRenderSettings,
  renderForestCanvasLayer,
} from "../src/rendering/forestCanvasRenderer";
import { vegetationGeometryStageKey, vegetationOverlayStageKey } from "../src/rendering/mountainDetailRenderer";
import type { MountainRenderOptions } from "../src/rendering/mountainDetailRenderer";
import { renderVegetationOverlay, type VegetationRasterPropAsset, type VegetationRasterPropPlacement } from "../src/rendering/vegetationRenderer";
import { renderMountainDetailDEM } from "../src/rendering/mountainDetailRenderer";
import type { WaterOverlay } from "../src/rendering/waterRenderer";
import { processMountainBaseDEM } from "../src/terrain/mountainBaseDEM";

class FakeGradient {
  addColorStop(): void {}
}

class FakeContext {
  calls: string[] = [];
  moves: Array<[number, number]> = [];
  strokeWidths: number[] = [];
  lineWidth = 1;
  clearRect(): void { FakeOffscreenCanvas.context = this; this.calls.push("clearRect"); }
  save(): void { this.calls.push("save"); }
  restore(): void { this.calls.push("restore"); }
  beginPath(): void { this.calls.push("beginPath"); }
  translate(): void {}
  transform(): void {}
  drawImage(): void { this.calls.push("drawImage"); }
  createPattern(): null { return null; }
  createImageData(width: number, height: number): ImageData {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData;
  }
  putImageData(): void {}
  moveTo(x: number, y: number): void { this.moves.push([x, y]); }
  lineTo(): void {}
  closePath(): void {}
  fill(): void { this.calls.push("fill"); }
  stroke(): void {
    this.calls.push("stroke");
    if (typeof this.lineWidth === "number") this.strokeWidths.push(this.lineWidth);
  }
  strokeRect(): void { this.calls.push("strokeRect"); }
  fillRect(): void { this.calls.push("fillRect"); }
  clip(): void {}
  createLinearGradient(): FakeGradient { return new FakeGradient(); }
  createRadialGradient(): FakeGradient { return new FakeGradient(); }
  getImageData(_x: number, _y: number, width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < data.length; offset += 4) {
      data[offset] = 80;
      data[offset + 1] = 120;
      data[offset + 2] = 60;
      data[offset + 3] = 255;
    }
    return { width, height, data } as ImageData;
  }
}

class FakeOffscreenCanvas {
  static context = new FakeContext();
  static contextOptions: Array<CanvasRenderingContext2DSettings | undefined> = [];
  context = new FakeContext();
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext(_kind: string, options?: CanvasRenderingContext2DSettings): FakeContext {
    FakeOffscreenCanvas.contextOptions.push(options);
    return this.context;
  }
}

const tree: VegetationRasterPropAsset = {
  key: "tree",
  family: "shrub",
  width: 20,
  height: 24,
  data: new Uint8ClampedArray(20 * 24 * 4),
  kind: "raster-prop",
  footprintWidthCells: 1,
  footprintHeightCells: 1,
  heightCells: 1,
  anchorX: 0.5,
  anchorY: 1,
  renderWidthCells: 1,
  renderHeightCells: 1.2,
  renderAnchorX: 0.5,
  renderAnchorY: 1,
  eligibleBiomeIds: [2, 3],
  outlineGroup: "alpine-forest",
  vectorPaths: [{
    points: [{ x: 2, y: 24 }, { x: 10, y: 1 }, { x: 18, y: 24 }],
    closed: true,
    fillColor: [86, 123, 84],
    strokeWidth: 0.7,
  }],
};

const placement = (x: number, y: number): VegetationRasterPropPlacement => ({
  x,
  y,
  rotation: 0,
  cellSize: 12,
  opacity: 1,
  biomeId: 3,
  assetKey: "tree",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mountain forest canvas settings and layer", () => {
  it("normalizes saved ranges and keeps appearance changes in the render signature", () => {
    // Typed values may exceed the slider range; only validity limits apply.
    const settings = normalizeForestRenderSettings({ canopyMerging: 180, lightColor: "bad", showFootprints: true });
    expect(settings.canopyMerging).toBe(180);
    expect(normalizeForestRenderSettings({ canopyMerging: -5, lightStrength: 2 }))
      .toMatchObject({ canopyMerging: 0, lightStrength: 1 });
    expect(settings.lightColor).toBe(DEFAULT_FOREST_RENDER_SETTINGS.lightColor);
    expect(settings.showFootprints).toBe(true);
    expect(normalizeForestRenderSettings({ density: 3, canopyWashStrength: 3 })).toMatchObject({ density: 3, canopyWashStrength: 3 });
    expect(forestRenderSettingsSignature(settings)).not.toBe(
      forestRenderSettingsSignature({ ...settings, lightStrength: settings.lightStrength - 0.1 }),
    );
  });

  it("prefers mountain forest settings and migrates legacy forest-props values when absent", () => {
    const legacy = JSON.stringify({
      seed: 54321,
      canopyMerging: 47,
      charcoalThickness: 1.2,
      lightSettings: { strength: 0.4, sunAzimuthDeg: 205, edgeDepth: 0.09, softness: 0.5, noise: 0.3, color: "#aabbcc" },
    });
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => key.includes("mountain-detail") ? null : legacy } });
    expect(readInitialForestRenderSettings()).toMatchObject({ seed: 54321, canopyMerging: 47, charcoalThickness: 1.2, lightStrength: 0.4, sunAzimuthDeg: 205, lightColor: "#aabbcc" });

    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => key.includes("mountain-detail")
      ? JSON.stringify({ forestSettings: { canopyMerging: 23 } }) : legacy } });
    expect(readInitialForestRenderSettings().canopyMerging).toBe(23);
  });

  it("invalidates only the mountain overlay cache for forest appearance changes", () => {
    const base = { layer: "vegetation_patterns", vegetation: { forestSettings: { canopyWashStrength: 0.5 } } } as MountainRenderOptions;
    const changed = { ...base, vegetation: { ...base.vegetation, forestSettings: { canopyWashStrength: 1.2 } } } as MountainRenderOptions;
    expect(vegetationGeometryStageKey(base)).toBe(vegetationGeometryStageKey(changed));
    expect(vegetationOverlayStageKey(base, "geometry")).not.toBe(vegetationOverlayStageKey(changed, "geometry"));
  });

  it("handles empty forests and clips forest pixels to land in arbitrary layer sizes", () => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    expect(renderForestCanvasLayer(3, 2, [], [tree])).toBeNull();

    const pixels = renderForestCanvasLayer(
      3,
      2,
      [placement(1, 1)],
      [tree],
      { lightStrength: 0.4 },
      new Uint8Array([1, 0, 1, 1, 0, 1]),
    );
    expect(pixels).toHaveLength(3 * 2 * 4);
    expect(pixels?.[3]).toBe(255);
    expect(pixels?.[7]).toBe(0);
    expect(pixels?.[11]).toBe(255);
    expect(FakeOffscreenCanvas.context.calls).toContain("fill");
    expect(FakeOffscreenCanvas.context.calls).toContain("stroke");
  });

  it("uses the shared lighting texture and disables it at zero strength", () => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    FakeOffscreenCanvas.contextOptions = [];
    renderForestCanvasLayer(64, 64, [placement(30, 40)], [tree], { lightStrength: 0.7 });
    expect(FakeOffscreenCanvas.context.calls).toContain("drawImage");
    // Repeated pattern/image draws must not mix GPU sources with CPU output.
    expect(FakeOffscreenCanvas.contextOptions.every((options) => options?.willReadFrequently)).toBe(true);
    renderForestCanvasLayer(64, 64, [placement(30, 40)], [tree], { lightStrength: 0 });
    expect(FakeOffscreenCanvas.context.calls).not.toContain("drawImage");
  });

  it("keeps seeded crown shape stable after export coordinates and scale are mapped", () => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    renderForestCanvasLayer(100, 100, [placement(20, 24)], [tree], {}, undefined);
    const sourcePoint = FakeOffscreenCanvas.context.moves[0];
    renderForestCanvasLayer(
      200,
      200,
      [{ ...placement(40, 48), cellSize: 24 }],
      [tree],
      {},
      undefined,
      0,
      0,
      0.5,
      0.5,
    );
    const exportPoint = FakeOffscreenCanvas.context.moves[0];
    expect(exportPoint[0] / 2).toBeCloseTo(sourcePoint[0]);
    expect(exportPoint[1] / 2).toBeCloseTo(sourcePoint[1]);
  });


  it("preserves forest crowns and boulder strokes where they overhang water", () => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const dem = processMountainBaseDEM(new Float32Array(40 * 40).fill(0.5), 40, 40, {
      domainWidthKm: 1, minElevationM: 100, maxElevationM: 500,
      oceanElevationM: 0, riverThresholdKm2: 100,
    });
    dem.visualWaterCoverage = new Float32Array(40 * 40);
    const assets: VegetationRasterPropAsset[] = [
      { ...tree, renderHeightCells: 3 },
      { ...tree, key: "boulder", outlineGroup: undefined, renderHeightCells: 3,
        vectorPaths: [{ points: [{ x: 2, y: 1 }, { x: 18, y: 24 }], strokeWidth: 2 }] },
    ];
    const geometry = {
      width: dem.width, height: dem.height, paths: [], motifs: [],
      rasterProps: assets.map((asset) => ({ ...placement(20, 32), assetKey: asset.key })),
    };
    const options = { rasterPropAssets: assets, strokeOpacity: 1, lineInterruptionProbability: 0 };
    const dry = renderVegetationOverlay(dem, geometry, options);
    // The ground footprints remain on land; the taller artwork crosses the shore.
    dem.visualWaterCoverage.fill(1, 0, 40 * 20);
    const wet = renderVegetationOverlay(dem, geometry, options);

    expect(dry.rasterPropRGBA[(12 * 40 + 20) * 4 + 3]).toBeGreaterThan(0);
    expect(wet.rasterPropRGBA).toEqual(dry.rasterPropRGBA);
    expect(wet.rasterPropCharcoalAlpha).toEqual(dry.rasterPropCharcoalAlpha);
  });

  it("keeps river detail beneath a foreground forest pixel", () => {
    const width = 8;
    const height = 8;
    const dem = processMountainBaseDEM(new Float32Array(width * height).fill(0.5), width, height, {
      domainWidthKm: 1,
      domainHeightKm: 1,
      minElevationM: 100,
      maxElevationM: 500,
      oceanElevationM: 0,
      riverThresholdKm2: 100,
    });
    const total = width * height;
    const target = 3 * width + 3;
    const waterOverlay: WaterOverlay = {
      width,
      height,
      waterAlpha: new Uint8Array(total),
      waterTone: new Uint8Array(total).fill(120),
      bankAlpha: new Uint8Array(total),
      outlineBankAlpha: new Uint8Array(total),
      flowAlpha: new Uint8Array(total),
      flowTone: new Uint8Array(total).fill(255),
    };
    waterOverlay.waterAlpha[target] = 255;
    waterOverlay.flowAlpha[target] = 255;
    waterOverlay.outlineBankAlpha![target] = 255;
    const rasterPropRGBA = new Uint8ClampedArray(total * 4);
    rasterPropRGBA[target * 4] = 86;
    rasterPropRGBA[target * 4 + 1] = 123;
    rasterPropRGBA[target * 4 + 2] = 84;
    rasterPropRGBA[target * 4 + 3] = 255;
    const image = renderMountainDetailDEM(dem, {
      layer: "vegetation_patterns",
      palette: "swiss_topo",
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      verticalExaggeration: 1,
      ambientOcclusionStrength: 0.35,
      skipMountainIllustrationStage: true,
      showRivers: true,
      riverThresholdKm2: 1,
      showContours: false,
      contourIntervalM: 100,
      showWaterDetails: true,
      showOceanDetails: true,
      waterOverlayOverride: waterOverlay,
      vegetationGeometryOverride: {
        width,
        height,
        paths: [],
        motifs: [],
        rasterProps: [],
      },
      vegetationOverlayOverride: {
        width,
        height,
        alpha: new Uint8Array(total),
        backgroundTone: new Float32Array(total).fill(0.5),
        backgroundNoise: new Float32Array(total),
        backgroundDryness: new Float32Array(total),
        wetlandDryness: new Float32Array(total),
        wetlandImagePropHabitat: new Float32Array(total),
        washShadowAlpha: new Uint8Array(total),
        shadowAlpha: new Uint8Array(total),
        flowGuideAlpha: new Uint8Array(total),
        rasterPropRGBA,
        rasterPropCharcoalAlpha: new Uint8Array(total),
        rasterPropShadowAlpha: new Uint8Array(total),
      },
      vegetation: { rasterPropAssets: [] },
    });
    const offset = target * 4;
    expect(Array.from(image.data.slice(offset, offset + 3))).toEqual([86, 123, 84]);
  });
});

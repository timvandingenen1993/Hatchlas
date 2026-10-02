import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedForestRasterSize,
  forestCameraFit,
  forestSvgForRaster,
  forestVisibleWorldBounds,
  isCurrentForestRasterRevision,
  LatestForestRasterRequestQueue,
  releaseForestRasterCanvas,
  rasterizeForestSvg,
  type ForestRasterRevision,
} from "../src/rendering/forestRasterPreview";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("forest raster preview", () => {
  it("maps the cursor camera into the expected world-space crop", () => {
    const viewport = { width: 1200, height: 800 };
    const scene = { width: 1536, height: 1152 };
    const fit = forestCameraFit(viewport, scene);
    expect(fit.scale).toBeCloseTo(800 / 1152);
    expect(fit.offsetX).toBeGreaterThan(0);
    expect(fit.offsetY).toBeCloseTo(0);

    const bounds = forestVisibleWorldBounds(
      viewport,
      scene,
      { panX: 0, panY: 0, zoom: 2 },
    );
    expect(bounds.width).toBeCloseTo(viewport.width / (fit.scale * 2));
    expect(bounds.height).toBeCloseTo(viewport.height / (fit.scale * 2));
    expect(bounds.x).toBeLessThan(0);
  });

  it("caps raster dimensions at two device pixels and four million pixels", () => {
    const raster = boundedForestRasterSize(7680, 5760, 3);
    expect(raster.width).toBeLessThanOrEqual(7680 * 2);
    expect(raster.height).toBeLessThanOrEqual(5760 * 2);
    expect(raster.width * raster.height).toBeLessThanOrEqual(4_000_000);
    expect(boundedForestRasterSize(500, 300, 1).width).toBe(500);
  });

  it("rewrites the SVG viewport while keeping scene definitions in place", () => {
    const markup = '<svg width="7680" height="5760" viewBox="0 0 1536 1152"><defs><filter id="grain" /></defs><path d="M0 0" /></svg>';
    const rasterMarkup = forestSvgForRaster(
      markup,
      { x: 10, y: 20, width: 300, height: 200 },
      800,
      600,
    );
    expect(rasterMarkup).toContain('width="800"');
    expect(rasterMarkup).toContain('height="600"');
    expect(rasterMarkup).toContain('viewBox="10 20 300 200"');
    expect(rasterMarkup).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(rasterMarkup).toContain('<filter id="grain" />');
  });

  it("coalesces raster requests to the latest request while one is active", () => {
    const queue = new LatestForestRasterRequestQueue<ForestRasterRevision & { id: string }>();
    const first = { id: "first", sceneRevision: 1, cameraRevision: "a", kind: "overview" as const };
    const second = { id: "second", sceneRevision: 1, cameraRevision: "b", kind: "detail" as const };
    const latest = { id: "latest", sceneRevision: 2, cameraRevision: "c", kind: "overview" as const };

    expect(queue.enqueue(first)).toBe(true);
    expect(queue.takeNext()).toBe(first);
    expect(queue.enqueue(second)).toBe(false);
    expect(queue.enqueue(latest)).toBe(false);
    expect(queue.takeNext()).toBe(latest);
    expect(queue.takeNext()).toBeNull();
    queue.finish();
    expect(queue.enqueue(second)).toBe(true);
    expect(queue.takeNext()).toBe(second);
    queue.cancel();
    expect(queue.takeNext()).toBeNull();
  });

  it("keeps a scene overview ahead of a detail request for that same scene", () => {
    const queue = new LatestForestRasterRequestQueue<ForestRasterRevision & { id: string }>();
    const active = { id: "active", sceneRevision: 1, cameraRevision: "a", kind: "overview" as const };
    const overview = { id: "new overview", sceneRevision: 2, cameraRevision: "b", kind: "overview" as const };
    const detail = { id: "new detail", sceneRevision: 2, cameraRevision: "c", kind: "detail" as const };

    expect(queue.enqueue(active)).toBe(true);
    expect(queue.takeNext()).toBe(active);
    expect(queue.enqueue(overview)).toBe(false);
    expect(queue.enqueue(detail)).toBe(false);
    expect(queue.takeNext()).toBe(overview);
  });

  it("rejects stale scene and camera revisions but allows overview camera reuse", () => {
    const current = { sceneRevision: 4, cameraRevision: "camera-2", kind: "detail" as const };
    expect(isCurrentForestRasterRevision(
      { sceneRevision: 4, cameraRevision: "camera-1", kind: "overview" },
      current,
    )).toBe(true);
    expect(isCurrentForestRasterRevision(
      { sceneRevision: 3, cameraRevision: "camera-2", kind: "overview" },
      current,
    )).toBe(false);
    expect(isCurrentForestRasterRevision(
      { sceneRevision: 4, cameraRevision: "camera-1", kind: "detail" },
      current,
    )).toBe(false);
    expect(isCurrentForestRasterRevision(
      { sceneRevision: 4, cameraRevision: "camera-2", kind: "detail" },
      current,
      false,
    )).toBe(false);
  });

  it("releases cached raster memory by clearing the canvas backing store", () => {
    const canvas = { width: 1280, height: 720 } as HTMLCanvasElement;
    releaseForestRasterCanvas(canvas);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("revokes the temporary SVG URL when browser image decoding fails", async () => {
    class FailingImage {
      decoding = "";
      src = "";
      async decode(): Promise<void> {
        throw new Error("decode failed");
      }
    }
    vi.stubGlobal("Image", FailingImage);
    const revoke = vi.spyOn(URL, "revokeObjectURL");

    await expect(rasterizeForestSvg(
      '<svg width="100" height="100" viewBox="0 0 10 10"></svg>',
      { x: 0, y: 0, width: 10, height: 10 },
      100,
      100,
    )).rejects.toThrow("decode failed");
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

/**
 * Camera and raster-size helpers for the zoomable forest preview.
 */
export const FOREST_RASTER_MAX_PIXELS = 4_000_000;

export interface ForestWorldBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ForestViewportSize {
  width: number;
  height: number;
}

export interface ForestCamera {
  panX: number;
  panY: number;
  zoom: number;
}

export interface ForestCameraFit {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface ForestRasterSize {
  width: number;
  height: number;
  scale: number;
}

export interface ForestRasterResult {
  canvas: HTMLCanvasElement;
  decodeMs: number;
  rasterizeMs: number;
}

export interface ForestRasterRevision {
  sceneRevision: number;
  cameraRevision: string;
  kind: "overview" | "detail";
}

export class LatestForestRasterRequestQueue<T extends ForestRasterRevision> {
  private pending: T | null = null;
  private active = false;

  enqueue(request: T): boolean {
    if (
      this.active &&
      this.pending?.kind === "overview" &&
      request.kind === "detail" &&
      this.pending.sceneRevision === request.sceneRevision
    ) return false;
    this.pending = request;
    if (this.active) return false;
    this.active = true;
    return true;
  }

  takeNext(): T | null {
    const request = this.pending;
    this.pending = null;
    return request;
  }

  finish(): void {
    this.active = false;
  }

  cancel(): void {
    this.pending = null;
    this.active = false;
  }
}

export function isCurrentForestRasterRevision(
  request: ForestRasterRevision,
  current: ForestRasterRevision,
  mounted = true,
): boolean {
  return mounted &&
    request.sceneRevision === current.sceneRevision &&
    (request.kind === "overview" || request.cameraRevision === current.cameraRevision);
}

export function forestCameraFit(
  viewport: ForestViewportSize,
  scene: ForestViewportSize,
): ForestCameraFit {
  const scale = Math.min(
    viewport.width / Math.max(1, scene.width),
    viewport.height / Math.max(1, scene.height),
  );
  return {
    scale,
    offsetX: (viewport.width - scene.width * scale) / 2,
    offsetY: (viewport.height - scene.height * scale) / 2,
  };
}

export function forestVisibleWorldBounds(
  viewport: ForestViewportSize,
  scene: ForestViewportSize,
  camera: ForestCamera,
  overscanCssPixels = 0,
): ForestWorldBounds {
  const fit = forestCameraFit(viewport, scene);
  const zoom = Math.max(0.001, camera.zoom);
  const worldScale = Math.max(0.000001, fit.scale * zoom);
  const overscan = Math.max(0, overscanCssPixels) / worldScale;
  const x = (-camera.panX / zoom - fit.offsetX) / fit.scale;
  const y = (-camera.panY / zoom - fit.offsetY) / fit.scale;
  return {
    x: x - overscan,
    y: y - overscan,
    width: viewport.width / worldScale + overscan * 2,
    height: viewport.height / worldScale + overscan * 2,
  };
}

export function boundedForestRasterSize(
  logicalWidth: number,
  logicalHeight: number,
  devicePixelRatio: number,
  maxPixels = FOREST_RASTER_MAX_PIXELS,
): ForestRasterSize {
  const width = Math.max(1, logicalWidth);
  const height = Math.max(1, logicalHeight);
  const dpr = Math.max(1, Math.min(2, devicePixelRatio || 1));
  const cap = Math.max(1, maxPixels);
  const scale = Math.min(dpr, Math.sqrt(cap / (width * height)));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

function setSvgAttribute(tag: string, name: string, value: string): string {
  const attribute = new RegExp(`\\s${name}=(?:"[^"]*"|'[^']*')`);
  return attribute.test(tag)
    ? tag.replace(attribute, ` ${name}="${value}"`)
    : tag.replace(/\s*\/?\s*>$/, ` ${name}="${value}">`);
}

export function forestSvgForRaster(
  svgMarkup: string,
  bounds: ForestWorldBounds,
  pixelWidth: number,
  pixelHeight: number,
): string {
  const rootMatch = svgMarkup.match(/<svg\b[^>]*>/i);
  if (!rootMatch) throw new Error("Forest snapshot does not contain an SVG root.");
  let root = rootMatch[0];
  root = setSvgAttribute(root, "width", String(Math.max(1, Math.floor(pixelWidth))));
  root = setSvgAttribute(root, "height", String(Math.max(1, Math.floor(pixelHeight))));
  root = setSvgAttribute(
    root,
    "viewBox",
    `${bounds.x} ${bounds.y} ${Math.max(0.001, bounds.width)} ${Math.max(0.001, bounds.height)}`,
  );
  root = setSvgAttribute(root, "xmlns", "http://www.w3.org/2000/svg");
  return svgMarkup.replace(rootMatch[0], root);
}

export async function rasterizeForestSvg(
  svgMarkup: string,
  bounds: ForestWorldBounds,
  pixelWidth: number,
  pixelHeight: number,
): Promise<ForestRasterResult> {
  if (pixelWidth * pixelHeight > FOREST_RASTER_MAX_PIXELS) {
    throw new Error("Forest raster request exceeds the 4 million pixel limit.");
  }
  const rasterSvg = forestSvgForRaster(svgMarkup, bounds, pixelWidth, pixelHeight);
  const objectUrl = URL.createObjectURL(
    new Blob([rasterSvg], { type: "image/svg+xml;charset=utf-8" }),
  );
  const image = new Image();
  image.decoding = "async";
  const decodeStartedAt = performance.now();
  try {
    image.src = objectUrl;
    await image.decode();
    const decodeMs = performance.now() - decodeStartedAt;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(pixelWidth));
    canvas.height = Math.max(1, Math.floor(pixelHeight));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Could not create the forest preview canvas.");
    const rasterStartedAt = performance.now();
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const rasterizeMs = performance.now() - rasterStartedAt;
    return { canvas, decodeMs, rasterizeMs };
  } finally {
    image.src = "";
    URL.revokeObjectURL(objectUrl);
  }
}

export function releaseForestRasterCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

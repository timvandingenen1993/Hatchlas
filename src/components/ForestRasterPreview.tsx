/**
 * Zoomable canvas preview for rendered forest rasters.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  boundedForestRasterSize,
  forestCameraFit,
  forestVisibleWorldBounds,
  isCurrentForestRasterRevision,
  LatestForestRasterRequestQueue,
  rasterizeForestSvg,
  releaseForestRasterCanvas,
  type ForestCamera,
  type ForestRasterSize,
  type ForestViewportSize,
  type ForestWorldBounds,
} from "../rendering/forestRasterPreview";

const SCENE_WIDTH = 1536;
const SCENE_HEIGHT = 1152;
const NAVIGATION_SETTLE_MS = 150;
const DETAIL_OVERSCAN_CSS_PIXELS = 64;

interface ForestSnapshot {
  revision: number;
  svgMarkup: string;
}

interface ForestRasterBitmap {
  canvas: HTMLCanvasElement;
  bounds: ForestWorldBounds;
  sceneRevision: number;
  cameraRevision: string;
  kind: "overview" | "detail";
}

interface ForestRasterRequest {
  snapshot: ForestSnapshot;
  sceneRevision: number;
  bounds: ForestWorldBounds;
  dimensions: ForestRasterSize;
  cameraRevision: string;
  kind: "overview" | "detail";
}

interface ForestRasterProfileEvent {
  stage: string;
  durationMs: number;
  pixels?: number;
  stale?: boolean;
}

interface ForestRasterPreviewProps {
  snapshot: ForestSnapshot | null;
  camera: ForestCamera;
  updating: boolean;
  generationError: string | null;
  onRetryGeneration: () => void;
  onProfile: (event: ForestRasterProfileEvent) => void;
  className?: string;
}

interface RasterInput {
  snapshot: ForestSnapshot | null;
  camera: ForestCamera;
  viewport: ForestViewportSize;
  devicePixelRatio: number;
  cameraRevision: string;
}

function sameSize(first: ForestViewportSize, second: ForestViewportSize): boolean {
  return first.width === second.width && first.height === second.height;
}

function releaseBitmap(bitmap: ForestRasterBitmap | null): void {
  if (bitmap) releaseForestRasterCanvas(bitmap.canvas);
}

export function ForestRasterPreview({
  snapshot,
  camera,
  updating,
  generationError,
  onRetryGeneration,
  onProfile,
  className,
}: ForestRasterPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overviewRef = useRef<ForestRasterBitmap | null>(null);
  const detailRef = useRef<ForestRasterBitmap | null>(null);
  const requestQueueRef = useRef(new LatestForestRasterRequestQueue<ForestRasterRequest>());
  const activeRequestRef = useRef<ForestRasterRequest | null>(null);
  const mountedRef = useRef(true);
  const latestInputRef = useRef<RasterInput>({
    snapshot,
    camera,
    viewport: { width: 0, height: 0 },
    devicePixelRatio: 1,
    cameraRevision: "",
  });
  const [viewport, setViewport] = useState<ForestViewportSize>({ width: 0, height: 0 });
  const [devicePixelRatio, setDevicePixelRatio] = useState(1);
  const [overview, setOverview] = useState<ForestRasterBitmap | null>(null);
  const [detail, setDetail] = useState<ForestRasterBitmap | null>(null);
  const [rasterizing, setRasterizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const lastOverviewRetryRef = useRef(0);

  const cameraRevision = JSON.stringify([
    camera.panX,
    camera.panY,
    camera.zoom,
    viewport.width,
    viewport.height,
    devicePixelRatio,
  ]);
  useLayoutEffect(() => {
    latestInputRef.current = {
      snapshot,
      camera,
      viewport,
      devicePixelRatio,
      cameraRevision,
    };
  }, [
    camera.panX,
    camera.panY,
    camera.zoom,
    cameraRevision,
    camera,
    devicePixelRatio,
    snapshot,
    viewport,
  ]);

  const replaceOverview = useCallback((next: ForestRasterBitmap) => {
    overviewRef.current = next;
    detailRef.current = null;
    setOverview(next);
    setDetail(null);
  }, []);

  const replaceDetail = useCallback((next: ForestRasterBitmap) => {
    detailRef.current = next;
    setDetail(next);
  }, []);

  const createDetailRequest = useCallback((input: RasterInput): ForestRasterRequest | null => {
    if (!input.snapshot || input.viewport.width <= 0 || input.viewport.height <= 0) return null;
    const bounds = forestVisibleWorldBounds(
      input.viewport,
      { width: SCENE_WIDTH, height: SCENE_HEIGHT },
      input.camera,
      DETAIL_OVERSCAN_CSS_PIXELS,
    );
    const fit = forestCameraFit(input.viewport, {
      width: SCENE_WIDTH,
      height: SCENE_HEIGHT,
    });
    const dimensions = boundedForestRasterSize(
      bounds.width * fit.scale * input.camera.zoom,
      bounds.height * fit.scale * input.camera.zoom,
      input.devicePixelRatio,
    );
    return {
      snapshot: input.snapshot,
      sceneRevision: input.snapshot.revision,
      bounds,
      dimensions,
      cameraRevision: input.cameraRevision,
      kind: "detail",
    };
  }, []);

  const enqueueRequest = useCallback((request: ForestRasterRequest) => {
    if (!requestQueueRef.current.enqueue(request)) return;
    setRasterizing(true);
    void (async () => {
      try {
        while (true) {
          const currentRequest = requestQueueRef.current.takeNext();
          if (!currentRequest) break;
          activeRequestRef.current = currentRequest;
          const currentInput = latestInputRef.current;
          if (!isCurrentForestRasterRevision(currentRequest, {
            sceneRevision: currentInput.snapshot?.revision ?? -1,
            cameraRevision: currentInput.cameraRevision,
            kind: currentRequest.kind,
          }, mountedRef.current)) {
            onProfile({ stage: "stale raster request discarded", durationMs: 0, stale: true });
            activeRequestRef.current = null;
            continue;
          }

          let rasterCanvas: HTMLCanvasElement | null = null;
          try {
            const raster = await rasterizeForestSvg(
              currentRequest.snapshot.svgMarkup,
              currentRequest.bounds,
              currentRequest.dimensions.width,
              currentRequest.dimensions.height,
            );
            rasterCanvas = raster.canvas;
            onProfile({
              stage: "SVG image decode",
              durationMs: raster.decodeMs,
              pixels: raster.canvas.width * raster.canvas.height,
            });
            onProfile({
              stage: "SVG canvas rasterization",
              durationMs: raster.rasterizeMs,
              pixels: raster.canvas.width * raster.canvas.height,
            });

            const latest = latestInputRef.current;
            const isStale = !isCurrentForestRasterRevision(currentRequest, {
              sceneRevision: latest.snapshot?.revision ?? -1,
              cameraRevision: latest.cameraRevision,
              kind: currentRequest.kind,
            }, mountedRef.current);
            if (isStale) {
              onProfile({
                stage: "stale raster result discarded",
                durationMs: 0,
                pixels: raster.canvas.width * raster.canvas.height,
                stale: true,
              });
              releaseForestRasterCanvas(raster.canvas);
              rasterCanvas = null;
              activeRequestRef.current = null;
              continue;
            }

            const bitmap: ForestRasterBitmap = {
              canvas: raster.canvas,
              bounds: currentRequest.bounds,
              sceneRevision: currentRequest.snapshot.revision,
              cameraRevision: currentRequest.cameraRevision,
              kind: currentRequest.kind,
            };
            rasterCanvas = null;
            if (currentRequest.kind === "overview") replaceOverview(bitmap);
            else replaceDetail(bitmap);
            setError(null);
          } catch (rasterError) {
            if (rasterCanvas) releaseForestRasterCanvas(rasterCanvas);
            const latest = latestInputRef.current;
            if (
              mountedRef.current &&
              isCurrentForestRasterRevision(currentRequest, {
                sceneRevision: latest.snapshot?.revision ?? -1,
                cameraRevision: latest.cameraRevision,
                kind: currentRequest.kind,
              })
            ) {
              setError(
                rasterError instanceof Error
                  ? rasterError.message
                  : "Could not rasterize the forest preview.",
              );
            }
          }
          activeRequestRef.current = null;
        }
      } finally {
        requestQueueRef.current.finish();
        if (mountedRef.current) setRasterizing(false);
      }
    })();
  }, [onProfile, replaceDetail, replaceOverview]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!parent) return;
    const measure = () => {
      const rect = parent.getBoundingClientRect();
      const nextViewport = { width: rect.width, height: rect.height };
      setViewport((previous) => sameSize(previous, nextViewport) ? previous : nextViewport);
      setDevicePixelRatio(Math.max(1, Math.min(2, window.devicePixelRatio || 1)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    if (!snapshot || viewport.width <= 0 || viewport.height <= 0) return;
    if (
      overviewRef.current?.sceneRevision === snapshot.revision &&
      lastOverviewRetryRef.current === retryRevision
    ) return;
    lastOverviewRetryRef.current = retryRevision;
    const fit = forestCameraFit(viewport, { width: SCENE_WIDTH, height: SCENE_HEIGHT });
    const dimensions = boundedForestRasterSize(
      SCENE_WIDTH * fit.scale,
      SCENE_HEIGHT * fit.scale,
      devicePixelRatio,
    );
    setError(null);
    enqueueRequest({
      snapshot,
      sceneRevision: snapshot.revision,
      bounds: { x: 0, y: 0, width: SCENE_WIDTH, height: SCENE_HEIGHT },
      dimensions,
      cameraRevision,
      kind: "overview",
    });
  }, [
    cameraRevision,
    devicePixelRatio,
    enqueueRequest,
    overview?.sceneRevision,
    retryRevision,
    snapshot,
    viewport,
  ]);

  useEffect(() => {
    if (!snapshot || viewport.width <= 0 || viewport.height <= 0) return;
    const timeout = window.setTimeout(() => {
      const request = createDetailRequest(latestInputRef.current);
      if (!request) return;
      const activeRequest = activeRequestRef.current;
      const cachedDetail = detailRef.current;
      if (
        (activeRequest?.kind === "detail" &&
          activeRequest.sceneRevision === request.sceneRevision &&
          activeRequest.cameraRevision === request.cameraRevision) ||
        (cachedDetail?.sceneRevision === request.sceneRevision &&
          cachedDetail.cameraRevision === request.cameraRevision)
      ) return;
      enqueueRequest(request);
    }, NAVIGATION_SETTLE_MS);
    return () => window.clearTimeout(timeout);
  }, [cameraRevision, createDetailRequest, detail, enqueueRequest, overview, snapshot, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewport.width <= 0 || viewport.height <= 0) return;
    const dimensions = boundedForestRasterSize(viewport.width, viewport.height, devicePixelRatio);
    if (canvas.width !== dimensions.width) canvas.width = dimensions.width;
    if (canvas.height !== dimensions.height) canvas.height = dimensions.height;
    let frame = 0;
    frame = window.requestAnimationFrame(() => {
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      const startedAt = performance.now();
      const dpr = dimensions.scale;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = "#dcdab7";
      context.fillRect(0, 0, viewport.width, viewport.height);
      const currentOverview = overviewRef.current;
      if (currentOverview) {
        const fit = forestCameraFit(viewport, { width: SCENE_WIDTH, height: SCENE_HEIGHT });
        context.translate(
          camera.panX + camera.zoom * fit.offsetX,
          camera.panY + camera.zoom * fit.offsetY,
        );
        context.scale(camera.zoom * fit.scale, camera.zoom * fit.scale);
        context.drawImage(currentOverview.canvas, 0, 0, SCENE_WIDTH, SCENE_HEIGHT);
        const currentDetail = detailRef.current;
        if (currentDetail?.sceneRevision === currentOverview.sceneRevision) {
          context.drawImage(
            currentDetail.canvas,
            currentDetail.bounds.x,
            currentDetail.bounds.y,
            currentDetail.bounds.width,
            currentDetail.bounds.height,
          );
        }
      }
      onProfile({
        stage: "canvas presentation",
        durationMs: performance.now() - startedAt,
        pixels: canvas.width * canvas.height,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    camera.panX,
    camera.panY,
    camera.zoom,
    devicePixelRatio,
    detail,
    onProfile,
    overview,
    viewport,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => () => releaseBitmap(overview), [overview]);
  useEffect(() => () => releaseBitmap(detail), [detail]);

  const hasCurrentOverview = overview?.sceneRevision === snapshot?.revision;
  return (
    <div className={className ?? "absolute inset-0"}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full"
        aria-label="Cached raster forest preview"
        role="img"
      />
      {updating || rasterizing ? (
        <div className="absolute left-2 top-2 rounded bg-[#26352a]/90 px-2 py-1 text-[11px] text-[#f0e8c5]">
          Updating forest preview…
        </div>
      ) : null}
      {generationError || error ? (
        <div className="absolute inset-x-3 top-3 flex items-center justify-between gap-3 rounded border border-[#9d6659] bg-[#422d29]/95 p-2 text-xs text-[#f3c0a8]">
          <span>{hasCurrentOverview ? "Preview refresh failed. " : "Preview failed. "}{generationError ?? error}</span>
          <button
            type="button"
            className="shrink-0 rounded border border-[#d49a83] px-2 py-1 font-semibold"
            onClick={() => {
              if (generationError) onRetryGeneration();
              else setRetryRevision((revision) => revision + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Live sample of one road type. It runs the real road rasterizer on a short
 * curved section with a bridge. The canvas is rendered at the panel's actual
 * pixel size (including high-DPI screens) rather than stretched, and the road
 * is scaled to match, so a 4px road is 4 CSS pixels wide, as on a 2048px map.
 */
import { useEffect, useRef, useState } from "react";
import { rasterizeRoadLayer, ROAD_REFERENCE_LONG_EDGE } from "../rendering/roadRenderer";
import type { RoadKind, RoadRenderPath, RoadStyle } from "../structures/types";

const HEIGHT = 72;
const MIN_WIDTH = 120;
const PAPER = [239, 228, 200] as const;

/** A gentle S-curve across `width` CSS pixels with a short bridge near the end. */
function samplePath(kind: RoadKind, width: number, scale: number): RoadRenderPath {
  const domain = ROAD_REFERENCE_LONG_EDGE * scale;
  const margin = 10;
  const wavelength = width / 6.3;
  const points = [];
  const xs: number[] = [];
  for (let x = margin; x <= width - margin; x += 4) {
    xs.push(x);
    points.push({ u: (x * scale) / (domain - 1), v: ((HEIGHT / 2 + 12 * Math.sin(x / wavelength)) * scale) / (domain - 1) });
  }
  const bridgeStart = width * 0.64;
  const bridgeEnd = width * 0.78;
  const from = Math.max(0, xs.findIndex((x) => x >= bridgeStart));
  const to = Math.max(from + 1, xs.findIndex((x) => x >= bridgeEnd));
  return { points, kind, bridges: [{ from, to, ford: false }] };
}

function drawPreview(canvas: HTMLCanvasElement, style: RoadStyle, kind: RoadKind, cssWidth: number, scale: number): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = Math.round(cssWidth * scale);
  const height = Math.round(HEIGHT * scale);
  const image = context.createImageData(width, height);
  const pixels = image.data;
  for (let index = 0; index < width * height; index++) {
    pixels.set([PAPER[0], PAPER[1], PAPER[2], 255], index * 4);
  }
  const domain = ROAD_REFERENCE_LONG_EDGE * scale;
  const layer = rasterizeRoadLayer([samplePath(kind, cssWidth, scale)], {
    width, height, offsetX: 0, offsetY: 0, domainWidth: domain, domainHeight: domain,
  }, style);
  if (layer) {
    const over = (offset: number, color: readonly number[], alpha: number) => {
      if (alpha <= 0) return;
      for (let channel = 0; channel < 3; channel++) {
        pixels[offset + channel] = Math.round(color[channel] * alpha + pixels[offset + channel] * (1 - alpha));
      }
    };
    const strength = layer.opacity / 255;
    for (let index = 0; index < width * height; index++) {
      const offset = index * 4;
      if (layer.shadow) over(offset, layer.shadow.colors[layer.shadow.colorIndex[index]], layer.shadow.alpha[index] * strength);
      if (layer.outline && layer.outlineColorIndex) {
        over(offset, layer.outlineColors[layer.outlineColorIndex[index]], layer.outline[index] * strength);
      }
      over(offset, layer.inkColors[layer.inkColorIndex[index]] ?? layer.inkColors[0], layer.ink[index] * strength);
      over(offset, layer.bridgeColor, layer.fill[index] * strength);
      if (layer.bridgeOutline) over(offset, layer.bridgeOutlineColor, layer.bridgeOutline[index] * strength);
    }
  }
  context.putImageData(image, 0, 0);
}

export function RoadStylePreview({ style, kind }: { style: RoadStyle; kind: RoadKind }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cssWidth, setCssWidth] = useState(240);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setCssWidth(Math.max(MIN_WIDTH, Math.floor(entry.contentRect.width)));
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = Math.round(cssWidth * scale);
    canvas.height = Math.round(HEIGHT * scale);
    drawPreview(canvas, style, kind, cssWidth, scale);
  }, [style, kind, cssWidth]);

  return <canvas ref={canvasRef} role="img" aria-label="Road style preview"
    className="block w-full rounded border border-white/10" style={{ height: HEIGHT }} />;
}

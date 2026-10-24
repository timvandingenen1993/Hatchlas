/**
 * Town stamp: the settlement icon plus its name label with a halo. The same
 * drawing code serves the editor overlay and the export, so a town looks the
 * same in both. Sizes are authored against a 2048px wide frame and scaled
 * with the frame; fonts, colors, halo and the icon-or-dot symbol come from
 * the map-wide TownStyle.
 */
import { DEFAULT_TOWN_STYLE, TOWN_FONT_STACKS, type Town, type TownStyle } from "./types";

export const TOWN_REFERENCE_FRAME_WIDTH = 2048;

function rgba(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

const DOT_FILL = "#000000";
const DOT_OUTLINE = "#ffffff";

/** Dot symbol: diameter of the black fill and width of its white ring, in output pixels. */
function townDot(town: Town, scale: number, style: TownStyle): { diameter: number; outline: number } {
  return { diameter: Math.max(5, town.size * 0.22) * scale, outline: style.dotOutlineWidth * scale };
}

/** Radius of the drawn symbol, for selection rings. */
export function townSymbolRadius(town: Town, scale: number, style: TownStyle = DEFAULT_TOWN_STYLE): number {
  if (style.symbol !== "dot") return town.size * scale * 0.62 + style.iconHaloWidth * scale;
  const dot = townDot(town, scale, style);
  return dot.diameter / 2 + dot.outline;
}

type ScratchCanvas = HTMLCanvasElement | OffscreenCanvas;

function scratchCanvas(width: number, height: number): ScratchCanvas | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Space the halo needs around the icon: its width plus the reach of the blur. */
function haloPad(radius: number, blur: number): number {
  return radius > 0 || blur > 0 ? Math.ceil(radius + blur * 3) + 1 : 0;
}

const HALO_CACHE_LIMIT = 8;
const haloCache = new WeakMap<object, Map<string, ScratchCanvas>>();

/**
 * The icon's silhouette in the halo color, grown by `radius` and softened by
 * `blur` (output pixels), on a canvas `haloPad` larger than the icon on each
 * side. Kept per icon, so the overlay can redraw every frame.
 */
function iconHalo(
  icon: CanvasImageSource & { width: number; height: number },
  width: number,
  height: number,
  radius: number,
  blur: number,
  color: string,
): ScratchCanvas | null {
  const key = `${width.toFixed(2)}|${height.toFixed(2)}|${radius.toFixed(2)}|${blur.toFixed(2)}|${color}`;
  let entries = haloCache.get(icon);
  const cached = entries?.get(key);
  if (cached) return cached;
  const pad = haloPad(radius, blur);
  const canvasWidth = Math.ceil(width) + pad * 2;
  const canvasHeight = Math.ceil(height) + pad * 2;
  const silhouette = scratchCanvas(canvasWidth, canvasHeight);
  const grown = scratchCanvas(canvasWidth, canvasHeight);
  const silhouetteContext = silhouette?.getContext("2d") as CanvasRenderingContext2D | null | undefined;
  const grownContext = grown?.getContext("2d") as CanvasRenderingContext2D | null | undefined;
  if (!silhouette || !grown || !silhouetteContext || !grownContext) return null;
  silhouetteContext.drawImage(icon, pad, pad, width, height);
  silhouetteContext.globalCompositeOperation = "source-in";
  silhouetteContext.fillStyle = color;
  silhouetteContext.fillRect(0, 0, canvasWidth, canvasHeight);
  // Dilate by stamping the silhouette around concentric rings; the inner
  // rings fill gaps a single ring leaves around small details.
  grownContext.drawImage(silhouette, 0, 0);
  const rings = Math.ceil(radius / 1.5);
  for (let ring = 1; ring <= rings; ring++) {
    const distance = (radius * ring) / rings;
    const steps = Math.max(8, Math.ceil((Math.PI * 2 * distance) / 1.5));
    for (let step = 0; step < steps; step++) {
      const angle = (step / steps) * Math.PI * 2;
      grownContext.drawImage(silhouette, Math.cos(angle) * distance, Math.sin(angle) * distance);
    }
  }
  let halo = grown;
  if (blur > 0) {
    const blurred = scratchCanvas(canvasWidth, canvasHeight);
    const blurredContext = blurred?.getContext("2d") as CanvasRenderingContext2D | null | undefined;
    if (blurred && blurredContext) {
      blurredContext.filter = `blur(${blur.toFixed(2)}px)`;
      blurredContext.drawImage(grown, 0, 0);
      halo = blurred;
    }
  }
  if (!entries) {
    entries = new Map();
    haloCache.set(icon, entries);
  }
  if (entries.size >= HALO_CACHE_LIMIT) entries.delete(entries.keys().next().value!);
  entries.set(key, halo);
  return halo;
}

export interface StampBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface StampLayout {
  iconWidth: number;
  iconHeight: number;
  nameFont: string;
  subtitleFont: string;
  nameSize: number;
  subtitleSize: number;
  halo: number;
  letterSpacing: number;
  lines: { text: string; font: string; size: number; x: number; y: number; align: CanvasTextAlign }[];
  bounds: StampBounds;
}

type TextContext = Pick<CanvasRenderingContext2D, "font" | "measureText" | "letterSpacing">;

function layoutTownStamp(
  context: TextContext,
  town: Town,
  icon: { width: number; height: number } | null,
  scale: number,
  style: TownStyle,
): StampLayout {
  let iconWidth: number;
  let iconHeight: number;
  let haloWidth = 0;
  let haloReach = 0;
  if (style.symbol === "dot") {
    const dot = townDot(town, scale, style);
    iconWidth = iconHeight = dot.diameter + dot.outline * 2;
  } else {
    haloWidth = style.iconHaloWidth * scale;
    haloReach = haloPad(haloWidth, style.iconHaloBlur * scale);
    const iconEdge = town.size * scale;
    const aspect = icon && icon.width > 0 && icon.height > 0 ? icon.width / icon.height : 1;
    iconWidth = aspect >= 1 ? iconEdge : iconEdge * aspect;
    iconHeight = aspect >= 1 ? iconEdge / aspect : iconEdge;
  }
  const family = TOWN_FONT_STACKS[style.font]?.css ?? TOWN_FONT_STACKS.serif.css;
  const nameSize = Math.max(9, town.size * 0.42) * style.labelScale * scale;
  const subtitleSize = nameSize * style.subtitleScale;
  const nameFont = `${style.bold ? "700" : "400"} ${nameSize.toFixed(2)}px ${family}`;
  const subtitleFont = `${style.subtitleItalic ? "italic " : ""}400 ${subtitleSize.toFixed(2)}px ${family}`;
  const halo = nameSize * 0.3 * style.haloWidth;
  const letterSpacing = style.letterSpacing;
  const transform = (text: string) => style.uppercase ? text.toLocaleUpperCase() : text;
  const bounds: StampBounds = {
    left: -iconWidth / 2 - haloReach,
    top: -iconHeight / 2 - haloReach,
    right: iconWidth / 2 + haloReach,
    bottom: iconHeight / 2 + haloReach,
  };
  const lines: StampLayout["lines"] = [];
  if (town.showLabel && (town.name || town.subtitle)) {
    const entries = [
      town.name ? { text: transform(town.name), font: nameFont, size: nameSize } : null,
      town.subtitle ? { text: transform(town.subtitle), font: subtitleFont, size: subtitleSize } : null,
    ].filter((entry): entry is { text: string; font: string; size: number } => entry !== null);
    const widths = entries.map((entry) => {
      context.font = entry.font;
      context.letterSpacing = `${(letterSpacing * entry.size).toFixed(2)}px`;
      return context.measureText(entry.text).width;
    });
    context.letterSpacing = "0px";
    const blockHeight = entries.reduce((sum, entry) => sum + entry.size * 1.15, 0);
    const gap = nameSize * 0.25 + halo * 0.5 + (town.labelOffset ?? 0) * scale;
    const blockWidth = Math.max(...widths);
    let top: number;
    let x: number;
    let align: CanvasTextAlign;
    if (town.labelPosition === "right") {
      x = iconWidth / 2 + haloWidth + gap;
      align = "left";
      top = -blockHeight / 2;
    } else {
      x = 0;
      align = "center";
      const edge = iconHeight / 2 + haloWidth + gap;
      top = town.labelPosition === "above" ? -edge - blockHeight : edge;
    }
    let cursor = top;
    for (const entry of entries) {
      cursor += entry.size;
      lines.push({ ...entry, x, y: cursor, align });
      cursor += entry.size * 0.15;
    }
    const textLeft = align === "left" ? x : -blockWidth / 2;
    bounds.left = Math.min(bounds.left, textLeft - halo);
    bounds.right = Math.max(bounds.right, textLeft + blockWidth + halo);
    bounds.top = Math.min(bounds.top, top - halo);
    bounds.bottom = Math.max(bounds.bottom, top + blockHeight + halo + nameSize * 0.25);
  }
  return { iconWidth, iconHeight, nameFont, subtitleFont, nameSize, subtitleSize, halo, letterSpacing, lines, bounds };
}

/** Draws a town centred on (x, y). */
export function drawTownStamp(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  town: Town,
  icon: CanvasImageSource & { width: number; height: number } | null,
  x: number,
  y: number,
  scale: number,
  style: TownStyle = DEFAULT_TOWN_STYLE,
): StampBounds {
  const layout = layoutTownStamp(context, town, icon, scale, style);
  context.save();
  if (style.symbol === "dot") {
    const dot = townDot(town, scale, style);
    context.beginPath();
    context.arc(x, y, dot.diameter / 2 + dot.outline / 2, 0, Math.PI * 2);
    context.fillStyle = DOT_FILL;
    context.fill();
    if (dot.outline > 0) {
      context.lineWidth = dot.outline;
      context.strokeStyle = DOT_OUTLINE;
      context.stroke();
    }
  } else if (icon) {
    const haloWidth = style.iconHaloWidth * scale;
    const haloBlur = style.iconHaloBlur * scale;
    const halo = (haloWidth > 0 || haloBlur > 0) && style.iconHaloOpacity > 0
      ? iconHalo(icon, layout.iconWidth, layout.iconHeight, haloWidth, haloBlur, style.iconHaloColor)
      : null;
    if (halo) {
      const pad = haloPad(haloWidth, haloBlur);
      context.globalAlpha = style.iconHaloOpacity;
      context.drawImage(halo, x - layout.iconWidth / 2 - pad, y - layout.iconHeight / 2 - pad);
      context.globalAlpha = 1;
    }
    context.drawImage(icon, x - layout.iconWidth / 2, y - layout.iconHeight / 2, layout.iconWidth, layout.iconHeight);
  } else {
    context.fillStyle = style.textColor;
    context.beginPath();
    context.arc(x, y, Math.max(2, layout.iconWidth * 0.18), 0, Math.PI * 2);
    context.fill();
  }
  context.lineJoin = "round";
  context.textBaseline = "alphabetic";
  const drawHalo = layout.halo > 0 && style.haloOpacity > 0;
  for (const line of layout.lines) {
    context.font = line.font;
    context.textAlign = line.align;
    context.letterSpacing = `${(layout.letterSpacing * line.size).toFixed(2)}px`;
    if (drawHalo) {
      context.strokeStyle = rgba(style.haloColor, style.haloOpacity);
      context.lineWidth = layout.halo * 2;
      context.strokeText(line.text, x + line.x, y + line.y);
    }
    context.fillStyle = style.textColor;
    context.fillText(line.text, x + line.x, y + line.y);
  }
  context.restore();
  return {
    left: x + layout.bounds.left,
    top: y + layout.bounds.top,
    right: x + layout.bounds.right,
    bottom: y + layout.bounds.bottom,
  };
}

/** A town pre-rendered at export scale, positioned by its map point. */
export interface TownStampRaster {
  u: number;
  v: number;
  width: number;
  height: number;
  /** Map point position inside the raster, in pixels. */
  anchorX: number;
  anchorY: number;
  rgba: Uint8ClampedArray;
}

export function rasterizeTownStamp(
  town: Town,
  icon: CanvasImageSource & { width: number; height: number } | null,
  scale: number,
  style: TownStyle = DEFAULT_TOWN_STYLE,
): TownStampRaster | null {
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) return null;
  const { bounds } = layoutTownStamp(measure, town, icon, scale, style);
  const left = Math.floor(bounds.left) - 1;
  const top = Math.floor(bounds.top) - 1;
  const width = Math.ceil(bounds.right) + 1 - left;
  const height = Math.ceil(bounds.bottom) + 1 - top;
  if (width <= 0 || height <= 0 || width * height > 4096 * 4096) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  drawTownStamp(context, town, icon, -left, -top, scale, style);
  return {
    u: town.u,
    v: town.v,
    width,
    height,
    anchorX: -left,
    anchorY: -top,
    rgba: context.getImageData(0, 0, width, height).data,
  };
}

export interface StampTarget {
  data: Uint8Array | Uint8ClampedArray;
  /** Pixels per row and rows in this band. */
  width: number;
  height: number;
  /** Bytes per row (RGBA rows may carry a leading PNG filter byte). */
  rowBytes: number;
  /** Byte offset of the first pixel in each row. */
  pixelOffset: number;
  /** Full-output position of the band's top-left pixel. */
  rowStart: number;
  colStart: number;
}

/**
 * Alpha-composites stamps into one band of the output image. `positions`
 * holds each stamp's anchor in full-output pixels.
 */
export function blitTownStamps(
  target: StampTarget,
  stamps: readonly TownStampRaster[],
  positions: readonly ({ x: number; y: number } | null)[],
): void {
  const { data, width, height, rowBytes, pixelOffset } = target;
  for (let index = 0; index < stamps.length; index++) {
    const stamp = stamps[index];
    const position = positions[index];
    if (!position) continue;
    const left = Math.round(position.x - stamp.anchorX) - target.colStart;
    const top = Math.round(position.y - stamp.anchorY) - target.rowStart;
    const y0 = Math.max(0, top);
    const y1 = Math.min(height, top + stamp.height);
    const x0 = Math.max(0, left);
    const x1 = Math.min(width, left + stamp.width);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const source = ((y - top) * stamp.width + (x - left)) * 4;
        const alpha = stamp.rgba[source + 3] / 255;
        if (alpha <= 0) continue;
        const destination = y * rowBytes + pixelOffset + x * 4;
        // Canvas image data is not premultiplied.
        for (let channel = 0; channel < 3; channel++) {
          data[destination + channel] = Math.round(
            stamp.rgba[source + channel] * alpha + data[destination + channel] * (1 - alpha),
          );
        }
        data[destination + 3] = Math.max(data[destination + 3], stamp.rgba[source + 3]);
      }
    }
  }
}

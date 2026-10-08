/**
 * Town stamp: the settlement icon plus its name label with a halo. The same
 * drawing code serves the editor overlay and the export, so a town looks the
 * same in both. Sizes are authored against a 2048px wide frame and scaled
 * with the frame; fonts, colors and halo come from the map-wide TownStyle.
 */
import { DEFAULT_TOWN_STYLE, TOWN_FONT_STACKS, type Town, type TownStyle } from "./types";

export const TOWN_REFERENCE_FRAME_WIDTH = 2048;

function rgba(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
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
  const iconEdge = town.size * scale;
  const aspect = icon && icon.width > 0 && icon.height > 0 ? icon.width / icon.height : 1;
  const iconWidth = aspect >= 1 ? iconEdge : iconEdge * aspect;
  const iconHeight = aspect >= 1 ? iconEdge / aspect : iconEdge;
  const family = TOWN_FONT_STACKS[style.font]?.css ?? TOWN_FONT_STACKS.serif.css;
  const nameSize = Math.max(9, town.size * 0.42) * style.labelScale * scale;
  const subtitleSize = nameSize * style.subtitleScale;
  const nameFont = `${style.bold ? "700" : "400"} ${nameSize.toFixed(2)}px ${family}`;
  const subtitleFont = `${style.subtitleItalic ? "italic " : ""}400 ${subtitleSize.toFixed(2)}px ${family}`;
  const halo = nameSize * 0.3 * style.haloWidth;
  const letterSpacing = style.letterSpacing;
  const transform = (text: string) => style.uppercase ? text.toLocaleUpperCase() : text;
  const bounds: StampBounds = {
    left: -iconWidth / 2,
    top: -iconHeight / 2,
    right: iconWidth / 2,
    bottom: iconHeight / 2,
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
    const gap = nameSize * 0.25 + halo * 0.5;
    const blockWidth = Math.max(...widths);
    let top: number;
    let x: number;
    let align: CanvasTextAlign;
    if (town.labelPosition === "right") {
      x = iconWidth / 2 + gap;
      align = "left";
      top = -blockHeight / 2;
    } else {
      x = 0;
      align = "center";
      top = town.labelPosition === "above" ? -iconHeight / 2 - gap - blockHeight : iconHeight / 2 + gap;
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
  if (icon) {
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

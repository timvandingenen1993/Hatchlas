/**
 * Hex parsing and HSV jitter used to give repeated props slightly different colors.
 */
export type PropRGB = [number, number, number];

export function parseHexColor(hex: string): PropRGB | undefined {
  const match = hex.trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return undefined;
  return [0, 2, 4].map((index) =>
    Number.parseInt(match[1].slice(index, index + 2), 16),
  ) as PropRGB;
}

/** Apply deterministic hue (degrees), saturation, and value offsets to a prop fill color. */
export function varyColorHsv(
  color: string | readonly [number, number, number],
  hueOffsetDeg: number,
  saturationOffset: number,
  valueOffset: number,
): PropRGB {
  const source = typeof color === "string" ? parseHexColor(color) : color;
  if (!source) return [165, 172, 113];
  const [red, green, blue] = source.map((channel) => channel / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) hue = ((green - blue) / delta) % 6;
    else if (maximum === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue *= 60;
  }
  hue = (((hue + hueOffsetDeg) % 360) + 360) % 360;
  const saturation = Math.max(0, Math.min(1, (maximum > 0 ? delta / maximum : 0) + saturationOffset));
  const value = Math.max(0, Math.min(1, maximum + valueOffset));

  const chroma = value * saturation;
  const hueSector = hue / 60;
  const secondary = chroma * (1 - Math.abs((hueSector % 2) - 1));
  const offset = value - chroma;
  const sector = Math.floor(hueSector);
  const rgb = sector === 0 ? [chroma, secondary, 0]
    : sector === 1 ? [secondary, chroma, 0]
      : sector === 2 ? [0, chroma, secondary]
        : sector === 3 ? [0, secondary, chroma]
          : sector === 4 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  return rgb.map((channel) => Math.round((channel + offset) * 255)) as PropRGB;
}

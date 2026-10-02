import type {
  MountainCameraIllustrationLayers,
  MountainIllustration,
} from './mountainIllustrationRenderer';

/** Shared with the perspective study: retain the narrow, dark hatch cores. */
export function mountainHatchCoreAlpha(downhill: number, level: number): number {
  const core = Math.max(0, Math.min(1, (Math.max(downhill, level) - 0.5) / 0.5));
  return Math.pow(core, 1.55) * 0.92;
}

export const MOUNTAIN_HATCH_INK = [27, 25, 21] as const;
export const MOUNTAIN_RIDGE_INK = [45, 40, 33] as const;

export interface MountainCameraIllustrationStyle {
  /** Optional user palette color for downhill/interior hatch marks. */
  hatchColor?: string | readonly number[];
  /** Legacy shared opacity multiplier; also controls both families when the
   * independent values are omitted. */
  hatchOpacity?: number;
  /** Opacity multiplier for near-horizontal contour hatches. */
  horizontalHatchOpacity?: number;
  /** Opacity multiplier for downhill/vertical hatches. */
  verticalHatchOpacity?: number;
}

/** The study's repeated round pen dabs, shared by both camera renderers.
 * Visibility remains the caller's responsibility because depth units differ. */
export function paintMountainCameraSegment(
  data: Uint8ClampedArray, width: number, height: number,
  a: { x: number; y: number }, b: { x: number; y: number },
  radius: number, color: readonly number[], opacity: number,
  visible: (index: number, t: number) => boolean,
  originY = 0,
): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 1.8));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const x = a.x * (1 - t) + b.x * t, y = a.y * (1 - t) + b.y * t;
    const globalMinY = Math.max(originY, Math.floor(y - radius - 1));
    const globalMaxY = Math.min(originY + height - 1, Math.ceil(y + radius + 1));
    for (let globalPy = globalMinY; globalPy <= globalMaxY; globalPy++) {
      const py = globalPy - originY;
      for (let px = Math.max(0, Math.floor(x - radius - 1)); px <= Math.min(width - 1, Math.ceil(x + radius + 1)); px++) {
        const distance = Math.hypot(px + 0.5 - x, globalPy + 0.5 - y);
        const index = py * width + px;
        if (distance > radius || !visible(index, t)) continue;
        const alpha = Math.max(0, Math.min(1, (radius + 1 - distance) * opacity));
        for (let c = 0; c < 3; c++) data[index * 4 + c] =
          data[index * 4 + c] * (1 - alpha) + color[c] * alpha;
        data[index * 4 + 3] = 255;
      }
    }
  }
}

const textures = new WeakMap<MountainIllustration | MountainCameraIllustrationLayers,
  Map<string, Uint8ClampedArray>>();

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
}

function resolveHatchColor(
  value: string | readonly number[] | undefined,
): [number, number, number] {
  if (typeof value === 'string') {
    const match = value.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (match) {
      const hex = match[1].length === 3
        ? match[1].split('').map(channel => channel + channel).join('')
        : match[1];
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  } else if (value && value.length >= 3) {
    return [
      Math.max(0, Math.min(255, Math.round(value[0]))),
      Math.max(0, Math.min(255, Math.round(value[1]))),
      Math.max(0, Math.min(255, Math.round(value[2]))),
    ];
  }
  return [...MOUNTAIN_HATCH_INK];
}

/** The study's hatching layer, without its paper background or baked crest.
 * Structural ridges are drawn once, on the projected global terrain mesh. */
export function mountainCameraIllustrationTexture(
  illustration: MountainIllustration | MountainCameraIllustrationLayers,
  style: MountainCameraIllustrationStyle = {},
): Uint8ClampedArray {
  const hatchColor = resolveHatchColor(style.hatchColor);
  const legacyHatchOpacity = clamp01(style.hatchOpacity ?? 1);
  // Illustration alpha buffers already include the controls used while the
  // stage was rasterized. Scale from that source value so the camera pass can
  // expose independent controls without applying opacity twice.
  const sourceHorizontalOpacity = clamp01(illustration.horizontalHatchOpacity ?? 1);
  const sourceVerticalOpacity = clamp01(illustration.verticalHatchOpacity ?? 1);
  const requestedHorizontalOpacity = clamp01(
    style.horizontalHatchOpacity ?? style.hatchOpacity ?? sourceHorizontalOpacity,
  );
  const requestedVerticalOpacity = clamp01(
    style.verticalHatchOpacity ?? style.hatchOpacity ?? sourceVerticalOpacity,
  );
  const horizontalScale = sourceHorizontalOpacity > 1e-4
    ? requestedHorizontalOpacity / sourceHorizontalOpacity
    : 0;
  const verticalScale = sourceVerticalOpacity > 1e-4
    ? requestedVerticalOpacity / sourceVerticalOpacity
    : 0;
  const cacheKey = `${hatchColor.join(',')}:${requestedHorizontalOpacity}:${requestedVerticalOpacity}:${legacyHatchOpacity}`;
  let styleCache = textures.get(illustration);
  if (!styleCache) {
    styleCache = new Map<string, Uint8ClampedArray>();
    textures.set(illustration, styleCache);
  }
  const cached = styleCache.get(cacheKey);
  if (cached) return cached;

  // Start from the material pass so changing hatch opacity can actually
  // remove the marks. The old implementation started from `rgba` and then
  // painted a second hard-coded ink pass over it, which made the camera look
  // grey even when the studio palette and opacity controls changed.
  const output = illustration.materialRgba.slice();
  for (let i = 0; i < output.length / 4; i++) {
    const offset = i * 4;
    if (illustration.silhouetteAlpha[i] / 255 > 0.08) {
      continue;
    }
    // These buffers already contain the rasterized hatch coverage after the
    // configured line opacity and dry-brush pressure have been applied. Do
    // not run them through mountainHatchCoreAlpha: that helper intentionally
    // thresholds normalized terrain signals at 0.5, while real hatch pixels
    // are commonly much lighter than that.
    const verticalAlpha = ((illustration.verticalHatchAlpha?.[i]
      ?? ('faceStrokeAlpha' in illustration ? illustration.faceStrokeAlpha[i] : 0))
      / 255) * verticalScale;
    const horizontalAlpha = (illustration.horizontalHatchAlpha?.[i] ?? 0) / 255 * horizontalScale;
    // Interior ridge ribs predate the split and remain on the legacy shared
    // control; primary ridges are redrawn separately by the camera renderer.
    const interiorRidgeAlpha = illustration.interiorRidgeAlpha[i] / 255 * legacyHatchOpacity;
    const alpha = Math.min(1, Math.max(verticalAlpha, horizontalAlpha, interiorRidgeAlpha));
    if (alpha <= 0) continue;
    // Keep the material pass in the composite. Snow/shadow material and its
    // edge coverage are intentional environmental modifiers for the ink.
    const materialAlpha = output[offset + 3] / 255;
    const combinedAlpha = alpha + materialAlpha * (1 - alpha);
    for (let c = 0; c < 3; c++) {
      output[offset + c] = Math.round((output[offset + c] * materialAlpha * (1 - alpha)
        + hatchColor[c] * alpha) / Math.max(1e-6, combinedAlpha));
    }
    output[offset + 3] = Math.round(combinedAlpha * 255);
  }
  styleCache.set(cacheKey, output);
  return output;
}

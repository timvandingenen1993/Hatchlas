/**
 * Swiss-style shaded relief render of the world.
 */
import type { MapData, ToolSettings } from '../types/map';

export function renderPureHillshadeMap(
  canvas: HTMLCanvasElement,
  mapData: MapData,
  settings: ToolSettings
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width, height, elevation, config } = mapData;

  // Adaptive canvas sizing to protect GPU backing store (capped at 2048 for smooth display)
  const displaySize = Math.min(2048, Math.max(width, height));
  const renderW = Math.min(width, displaySize);
  const renderH = Math.min(height, displaySize);

  if (canvas.width !== renderW || canvas.height !== renderH) {
    canvas.width = renderW;
    canvas.height = renderH;
  }

  const imgData = ctx.createImageData(renderW, renderH);
  const data = imgData.data;
  const seaLevel = config.seaLevel;

  const stepX = width / renderW;
  const stepY = height / renderH;

  // Primary light (NW 315 deg, alt 45 deg)
  const lx1 = -0.5, ly1 = -0.5, lz1 = 0.7071;
  // Fill light (SW 225 deg, alt 35 deg)
  const lx2 = -0.579, ly2 = 0.579, lz2 = 0.5736;
  const zScale = 26.0;

  for (let dy = 0; dy < renderH; dy++) {
    const srcY = Math.floor(dy * stepY);
    const yN = Math.max(0, srcY - 1);
    const yS = Math.min(height - 1, srcY + 1);
    const dstRow = dy * renderW;

    for (let dx = 0; dx < renderW; dx++) {
      const srcX = Math.floor(dx * stepX);
      const idx = srcY * width + srcX;
      const h = elevation[idx];
      const isLand = h > seaLevel;

      const xW = Math.max(0, srcX - 1);
      const xE = Math.min(width - 1, srcX + 1);

      // Inline 3x3 normal gradient
      const zNW = elevation[yN * width + xW];
      const zN  = elevation[yN * width + srcX];
      const zNE = elevation[yN * width + xE];
      const zW  = elevation[srcY * width + xW];
      const zE  = elevation[srcY * width + xE];
      const zSW = elevation[yS * width + xW];
      const zS  = elevation[yS * width + srcX];
      const zSE = elevation[yS * width + xE];

      const dzdx = ((zNE + 2.0 * zE + zSE) - (zNW + 2.0 * zW + zSW)) * 0.125 * zScale;
      const dzdy = ((zSW + 2.0 * zS + zSE) - (zNW + 2.0 * zN + zNE)) * 0.125 * zScale;

      const nLen = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1.0);
      const nx = -dzdx / nLen;
      const ny = -dzdy / nLen;
      const nz = 1.0 / nLen;

      // Primary & Fill light dot products
      const dot1 = Math.max(0.0, nx * lx1 + ny * ly1 + nz * lz1);
      const dot2 = Math.max(0.0, nx * lx2 + ny * ly2 + nz * lz2);
      const s1 = 0.28 + 0.72 * dot1;
      const s2 = 0.28 + 0.72 * dot2;

      const pIdx = (dstRow + dx) * 4;

      if (isLand) {
        const landFrac = Math.min(1.0, (h - seaLevel) / Math.max(0.01, 1.0 - seaLevel));
        const light = s1 * 0.70 + s2 * 0.20 + 0.10;

        let baseR = 205, baseG = 215, baseB = 175;

        if (landFrac < 0.25) {
          const t = landFrac / 0.25;
          baseR = 205 * (1 - t) + 221 * t;
          baseG = 215 * (1 - t) + 213 * t;
          baseB = 175 * (1 - t) + 189 * t;
        } else if (landFrac < 0.55) {
          const t = (landFrac - 0.25) / 0.30;
          baseR = 221 * (1 - t) + 206 * t;
          baseG = 213 * (1 - t) + 188 * t;
          baseB = 189 * (1 - t) + 160 * t;
        } else if (landFrac < 0.82) {
          const t = (landFrac - 0.55) / 0.27;
          baseR = 206 * (1 - t) + 165 * t;
          baseG = 188 * (1 - t) + 172 * t;
          baseB = 160 * (1 - t) + 182 * t;
        } else {
          const t = (landFrac - 0.82) / 0.18;
          baseR = 165 * (1 - t) + 248 * t;
          baseG = 172 * (1 - t) + 250 * t;
          baseB = 182 * (1 - t) + 252 * t;
        }

        const ridgeHighlight = (landFrac > 0.6 && s1 > 0.65) ? (s1 - 0.65) * 35 * landFrac : 0;
        data[pIdx] = Math.min(255, Math.max(0, Math.round(baseR * light + ridgeHighlight)));
        data[pIdx + 1] = Math.min(255, Math.max(0, Math.round(baseG * light + ridgeHighlight)));
        data[pIdx + 2] = Math.min(255, Math.max(0, Math.round(baseB * light + ridgeHighlight * 1.1)));
        data[pIdx + 3] = 255;
      } else {
        const depth = Math.min(1.0, (seaLevel - h) / Math.max(0.01, seaLevel));
        const oceanLight = 0.7 + s1 * 0.3;
        data[pIdx] = Math.round((26 * (1 - depth) + 10 * depth) * oceanLight);
        data[pIdx + 1] = Math.round((68 * (1 - depth) + 34 * depth) * oceanLight);
        data[pIdx + 2] = Math.round((108 * (1 - depth) + 62 * depth) * oceanLight);
        data[pIdx + 3] = 255;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);

  // 2. Crisp Shoreline Outline
  ctx.save();
  ctx.strokeStyle = 'rgba(10, 34, 62, 0.5)';
  ctx.lineWidth = 1.0;

  // 3. Draw Optional Elevation Contours only if explicitly enabled
  if (settings.showContours) {
    drawContourLines(ctx, width, height, elevation, seaLevel, settings.contourInterval || 0.05);
  }

  ctx.restore();
}

function drawContourLines(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  elevation: Float32Array,
  seaLevel: number,
  interval: number
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(71, 85, 105, 0.25)';
  ctx.lineWidth = 0.6;

  for (let y = 1; y < height - 1; y += 2) {
    const yIdx = y * width;
    for (let x = 1; x < width - 1; x += 2) {
      const idx = yIdx + x;
      const h = elevation[idx];
      if (h > seaLevel) {
        const rem = (h - seaLevel) % interval;
        if (rem < 0.0035 || rem > interval - 0.0035) {
          ctx.beginPath();
          ctx.arc(x, y, 0.75, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }
  ctx.restore();
}

/**
 * Diagnostic map views that show raw simulation fields.
 */
import type { MapData, ToolSettings } from '../types/map';

export function renderDebugDiagnosticMap(
  canvas: HTMLCanvasElement,
  mapData: MapData,
  _settings?: ToolSettings
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width, height, elevation, boundaryStress, plateMap, config } = mapData;

  const displaySize = Math.min(2048, Math.max(width, height));
  const renderW = Math.min(width, displaySize);
  const renderH = Math.min(height, displaySize);

  if (canvas.width !== renderW || canvas.height !== renderH) {
    canvas.width = renderW;
    canvas.height = renderH;
  }

  const halfW = Math.floor(renderW / 2);
  const halfH = Math.floor(renderH / 2);

  const imgData = ctx.createImageData(renderW, renderH);
  const data = imgData.data;
  const seaLevel = config.seaLevel;

  const stepX = width / renderW;
  const stepY = height / renderH;
  const lx = -0.5, ly = -0.5, lz = 0.7071;
  const zScale = 26.0;

  for (let dy = 0; dy < renderH; dy++) {
    const isTop = dy < halfH;
    const srcY = Math.floor(dy * stepY);
    const yN = Math.max(0, srcY - 1);
    const yS = Math.min(height - 1, srcY + 1);
    const dstRow = dy * renderW;

    for (let dx = 0; dx < renderW; dx++) {
      const isLeft = dx < halfW;
      const srcX = Math.floor(dx * stepX);
      const idx = srcY * width + srcX;
      const pIdx = (dstRow + dx) * 4;

      const h = elevation[idx];
      const stress = boundaryStress ? boundaryStress[idx] : 0;
      const plate = plateMap ? plateMap[idx] : 0;

      const xW = Math.max(0, srcX - 1);
      const xE = Math.min(width - 1, srcX + 1);

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

      const dot = Math.max(0.0, nx * lx + ny * ly + nz * lz);
      const s = 0.28 + 0.72 * dot;

      if (isTop && isLeft) {
        // --- TOP-LEFT: Swiss Topographic Shaded Relief ---
        if (h > seaLevel) {
          const landFrac = (h - seaLevel) / (1.0 - seaLevel);
          const r = Math.round(200 * s + (landFrac > 0.8 ? 55 : 0));
          const g = Math.round(210 * s + (landFrac > 0.8 ? 45 : 0));
          const b = Math.round(180 * s + (landFrac > 0.8 ? 75 : 0));
          data[pIdx] = Math.min(255, r);
          data[pIdx + 1] = Math.min(255, g);
          data[pIdx + 2] = Math.min(255, b);
        } else {
          const d = (seaLevel - h) / seaLevel;
          data[pIdx] = Math.round((20 * (1 - d) + 10 * d) * s);
          data[pIdx + 1] = Math.round((60 * (1 - d) + 30 * d) * s);
          data[pIdx + 2] = Math.round((100 * (1 - d) + 60 * d) * s);
        }
      } else if (isTop && !isLeft) {
        // --- TOP-RIGHT: Raw Normalized Heightmap (Hypsometric False Color) ---
        if (h > seaLevel) {
          const lf = (h - seaLevel) / (1.0 - seaLevel);
          if (lf < 0.25) {
            data[pIdx] = Math.round(34 + lf * 4 * 100);
            data[pIdx + 1] = Math.round(197 - lf * 4 * 30);
            data[pIdx + 2] = 94;
          } else if (lf < 0.65) {
            const t = (lf - 0.25) / 0.40;
            data[pIdx] = Math.round(234 + t * 15);
            data[pIdx + 1] = Math.round(179 - t * 60);
            data[pIdx + 2] = Math.round(8 + t * 20);
          } else {
            const t = (lf - 0.65) / 0.35;
            data[pIdx] = Math.round(180 + t * 75);
            data[pIdx + 1] = Math.round(140 + t * 115);
            data[pIdx + 2] = Math.round(120 + t * 135);
          }
        } else {
          const od = (seaLevel - h) / seaLevel;
          data[pIdx] = Math.round(14 * (1 - od));
          data[pIdx + 1] = Math.round(60 * (1 - od) + 20 * od);
          data[pIdx + 2] = Math.round(160 * (1 - od) + 60 * od);
        }
      } else if (!isTop && isLeft) {
        // --- BOTTOM-LEFT: Tectonic Stress & Crustal Plates ---
        if (stress > 0.02) {
          const comp = Math.min(1.0, stress * 5.0);
          data[pIdx] = Math.round(239 * comp + 60 * (1 - comp));
          data[pIdx + 1] = Math.round(68 * comp + 60 * (1 - comp));
          data[pIdx + 2] = Math.round(68 * (1 - comp));
        } else if (stress < -0.02) {
          const rift = Math.min(1.0, Math.abs(stress) * 6.0);
          data[pIdx] = Math.round(6 * rift);
          data[pIdx + 1] = Math.round(182 * rift + 40 * (1 - rift));
          data[pIdx + 2] = Math.round(212 * rift + 80 * (1 - rift));
        } else {
          const plateHue = (plate * 47) % 255;
          data[pIdx] = plateHue;
          data[pIdx + 1] = (plateHue + 80) % 255;
          data[pIdx + 2] = (plateHue + 160) % 255;
        }
      } else {
        // --- BOTTOM-RIGHT: 3D Surface Normal Map (RGB Vector) ---
        const bXW = Math.max(0, srcX - 1);
        const bXE = Math.min(width - 1, srcX + 1);
        const bYN = Math.max(0, srcY - 1);
        const bYS = Math.min(height - 1, srcY + 1);

        const bDzdx = (elevation[srcY * width + bXE] - elevation[srcY * width + bXW]) * 20.0;
        const bDzdy = (elevation[bYS * width + srcX] - elevation[bYN * width + srcX]) * 20.0;
        const len = Math.sqrt(bDzdx * bDzdx + bDzdy * bDzdy + 1.0);

        const nx = (-bDzdx / len) * 0.5 + 0.5;
        const ny = (-bDzdy / len) * 0.5 + 0.5;
        const nz = (1.0 / len) * 0.5 + 0.5;

        data[pIdx] = Math.round(nx * 255);
        data[pIdx + 1] = Math.round(ny * 255);
        data[pIdx + 2] = Math.round(nz * 255);
      }

      data[pIdx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);

  // Draw 4-Quadrant Divider Grid Lines & Labels
  ctx.save();
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  ctx.moveTo(halfW, 0);
  ctx.lineTo(halfW, height);
  ctx.moveTo(0, halfH);
  ctx.lineTo(width, halfH);
  ctx.stroke();

  // Quadrant HUD Labels
  ctx.font = 'bold 11px Inter, sans-serif';
  ctx.textBaseline = 'top';

  const drawBadge = (txt: string, bx: number, by: number, bg: string = 'rgba(15, 23, 42, 0.85)') => {
    ctx.fillStyle = bg;
    const tw = ctx.measureText(txt).width;
    ctx.fillRect(bx, by, tw + 12, 20);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.strokeRect(bx, by, tw + 12, 20);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(txt, bx + 6, by + 4);
  };

  drawBadge('1. Shaded Relief (Imhof Topo)', 10, 10);
  drawBadge('2. Raw Heightmap (Hypsometry)', halfW + 10, 10);
  drawBadge('3. Tectonic Stress (Compression/Rift)', 10, halfH + 10);
  drawBadge('4. 3D Surface Normal Map', halfW + 10, halfH + 10);

  ctx.restore();
}

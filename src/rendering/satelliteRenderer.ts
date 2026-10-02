/**
 * Satellite-style render of the world, shaded by biome color and relief.
 */
import { drawPOIIcon } from './iconStamps';
import { BIOMES, BiomeType } from '../core/biomes';
import type { MapData, ToolSettings } from '../types/map';

export function renderSatelliteMap(
  canvas: HTMLCanvasElement,
  mapData: MapData,
  settings: ToolSettings
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width, height, elevation, biomes, rivers, lakes, pois, glacierIce, config } = mapData;

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
  const lx = -0.5, ly = -0.5, lz = 0.7071;
  const zScale = 4.2;

  for (let dy = 0; dy < renderH; dy++) {
    const srcY = Math.floor(dy * stepY);
    const yN = Math.max(0, srcY - 1);
    const yS = Math.min(height - 1, srcY + 1);
    const dstRow = dy * renderW;

    for (let dx = 0; dx < renderW; dx++) {
      const srcX = Math.floor(dx * stepX);
      const idx = srcY * width + srcX;
      const elev = elevation[idx];
      const ice = glacierIce[idx];
      const isLand = elev > seaLevel;

      const xW = Math.max(0, srcX - 1);
      const xE = Math.min(width - 1, srcX + 1);

      // Inline normal vector
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
      const shade = 0.28 + 0.72 * dot;

      let r = 0, g = 0, b = 0;
      const bId = biomes[idx];

      if (!isLand) {
        // --- Ocean / Water & Polar Sea Ice Rendering ---
        if (bId === BiomeType.POLAR_SEA_ICE) {
          // Solid Perennial Polar Sea Ice Cap & Ice Shelf
          const iceShade = 0.65 + shade * 0.35;
          r = Math.min(255, Math.floor(242 * iceShade));
          g = Math.min(255, Math.floor(248 * iceShade));
          b = Math.min(255, Math.floor(255 * iceShade));
        } else if (bId === BiomeType.PACK_ICE_FLOES) {
          // Marginal Drift Ice & Pack Ice Floes (Procedural Voronoi-like Floe pattern)
          const hashVal = Math.sin(srcX * 0.28) * Math.cos(srcY * 0.28) + Math.sin((srcX + srcY) * 0.15) * 0.5;
          const isFloe = hashVal > -0.05;

          if (isFloe) {
            // Ice floe block
            const floeShade = 0.60 + shade * 0.40;
            r = Math.min(255, Math.floor(220 * floeShade));
            g = Math.min(255, Math.floor(238 * floeShade));
            b = Math.min(255, Math.floor(252 * floeShade));
          } else {
            // Cold turquoise/navy meltwater leads between floes
            r = 18;
            g = 65;
            b = 110;
          }
        } else {
          // Liquid Ocean Depth Gradient
          const depth = (seaLevel - elev) / Math.max(0.01, seaLevel);

          if (depth < 0.12) {
            r = 22 + depth * 30;
            g = 140 - depth * 100;
            b = 180 - depth * 60;
          } else {
            const t = Math.min(1.0, (depth - 0.12) / 0.88);
            r = Math.floor(12 * (1 - t) + 4 * t);
            g = Math.floor(45 * (1 - t) + 12 * t);
            b = Math.floor(90 * (1 - t) + 36 * t);
          }

          const wave = Math.sin(dx * 0.35 + dy * 0.2) * 3;
          r = Math.min(255, Math.max(0, r + wave));
          g = Math.min(255, Math.max(0, g + wave));
          b = Math.min(255, Math.max(0, b + wave));
        }
      } else {
        // --- Land & Biome Rendering ---
        const biomeDef = BIOMES[bId as keyof typeof BIOMES] || BIOMES[10];
        const hex = biomeDef.colorSatellite;
        const hexHigh = biomeDef.colorSatelliteHigh || hex;

        const br = parseInt(hex.slice(1, 3), 16);
        const bg = parseInt(hex.slice(3, 5), 16);
        const bb = parseInt(hex.slice(5, 7), 16);

        const hr = parseInt(hexHigh.slice(1, 3), 16);
        const hg = parseInt(hexHigh.slice(3, 5), 16);
        const hb = parseInt(hexHigh.slice(5, 7), 16);

        const landNorm = (elev - seaLevel) / Math.max(0.01, 1.0 - seaLevel);
        let lr = br * (1 - landNorm * 0.5) + hr * (landNorm * 0.5);
        let lg = bg * (1 - landNorm * 0.5) + hg * (landNorm * 0.5);
        let lb = bb * (1 - landNorm * 0.5) + hb * (landNorm * 0.5);

        // Continental Glacial Ice Sheets & Summit Snowcaps
        if (ice > 0.1 || bId === BiomeType.GLACIER || bId === BiomeType.CRYSTAL_CRAGS || elev > 0.80) {
          const snowFactor = Math.min(1.0, Math.max(ice * 1.3, bId === BiomeType.GLACIER ? 1.0 : (elev - 0.80) * 5.0));
          lr = lr * (1 - snowFactor) + 248 * snowFactor;
          lg = lg * (1 - snowFactor) + 252 * snowFactor;
          lb = lb * (1 - snowFactor) + 255 * snowFactor;
        }

        const lightMultiplier = Math.pow(shade, 1.2) * 1.5;
        r = Math.min(255, Math.max(0, lr * (0.35 + lightMultiplier * 0.65)));
        g = Math.min(255, Math.max(0, lg * (0.35 + lightMultiplier * 0.65)));
        b = Math.min(255, Math.max(0, lb * (0.35 + lightMultiplier * 0.65)));
      }

      const pIdx = (dstRow + dx) * 4;
      data[pIdx] = r;
      data[pIdx + 1] = g;
      data[pIdx + 2] = b;
      data[pIdx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);

  // 3. Draw Lakes with cyan / azure sheen
  if (lakes && lakes.length > 0) {
    ctx.fillStyle = '#0284c7';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.0;
    for (const lake of lakes) {
      ctx.beginPath();
      ctx.arc(lake.x, lake.y, Math.max(2, lake.size * 0.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // 4. Draw River Network
  if (settings.showRivers && rivers) {
    ctx.strokeStyle = '#38bdf8';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const river of rivers) {
      if (river.points.length < 2) continue;

      ctx.beginPath();
      ctx.moveTo(river.points[0][0], river.points[0][1]);

      const baseWidth = river.order === 4 ? 3.0 : river.order === 3 ? 2.2 : river.order === 2 ? 1.5 : 1.0;

      for (let i = 1; i < river.points.length; i++) {
        const p0 = river.points[i - 1];
        const p1 = river.points[i];
        const midX = (p0[0] + p1[0]) / 2;
        const midY = (p0[1] + p1[1]) / 2;
        ctx.quadraticCurveTo(p0[0], p0[1], midX, midY);
      }
      ctx.lineTo(river.points[river.points.length - 1][0], river.points[river.points.length - 1][1]);
      ctx.lineWidth = baseWidth;
      ctx.stroke();
    }
  }

  // 5. Draw POI Landmarks
  if (settings.showPOIs && pois) {
    for (const poi of pois) {
      drawPOIIcon(ctx, poi, 1.0, 'satellite');
    }
  }
}

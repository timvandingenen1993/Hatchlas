/**
 * Analysis layers: hypsometric, temperature, moisture, geology, drainage and tectonics.
 */
import { ROCK_SOIL_DEFINITIONS } from '../types/map';
import type { MapData, ToolSettings } from '../types/map';

const HYPSO_COLORS: [number, number, number, number][] = [
  [0.00, 10, 30, 80],      // Deep trench
  [0.25, 20, 70, 140],     // Abyssal
  [0.37, 40, 140, 180],    // Coastal shelf
  [0.38, 70, 160, 100],    // Coastline lowlands
  [0.45, 120, 190, 80],    // Foothills
  [0.55, 190, 180, 70],    // Plateaus
  [0.68, 160, 110, 60],    // High mountain base
  [0.80, 130, 100, 90],    // Alpine rocks
  [0.92, 210, 220, 230],   // Snowline
  [1.00, 255, 255, 255],   // Summit
];

export function renderHypsometricMap(
  canvas: HTMLCanvasElement,
  mapData: MapData,
  settings: ToolSettings
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height, elevation, config } = mapData;

  const displaySize = Math.min(2048, Math.max(width, height));
  const renderW = Math.min(width, displaySize);
  const renderH = Math.min(height, displaySize);

  if (canvas.width !== renderW || canvas.height !== renderH) {
    canvas.width = renderW;
    canvas.height = renderH;
  }

  const imgData = ctx.createImageData(renderW, renderH);
  const data = imgData.data;
  const contourInterval = 0.05;

  const stepX = width / renderW;
  const stepY = height / renderH;
  const lx = -0.5, ly = -0.5, lz = 0.7071;

  for (let dy = 0; dy < renderH; dy++) {
    const srcY = Math.floor(dy * stepY);
    const yN = Math.max(0, srcY - 1);
    const yS = Math.min(height - 1, srcY + 1);
    const dstRow = dy * renderW;

    for (let dx = 0; dx < renderW; dx++) {
      const srcX = Math.floor(dx * stepX);
      const idx = srcY * width + srcX;
      const elev = elevation[idx];

      const xW = Math.max(0, srcX - 1);
      const xE = Math.min(width - 1, srcX + 1);
      const dzdx = (elevation[srcY * width + xE] - elevation[srcY * width + xW]) * 1.5;
      const dzdy = (elevation[yS * width + srcX] - elevation[yN * width + srcX]) * 1.5;
      const nLen = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1.0);
      const shade = 0.35 + 0.65 * Math.max(0, (-dzdx * lx - dzdy * ly + lz) / nLen);

      let r = 255, g = 255, b = 255;
      for (let k = 0; k < HYPSO_COLORS.length - 1; k++) {
        const c1 = HYPSO_COLORS[k];
        const c2 = HYPSO_COLORS[k + 1];
        if (elev >= c1[0] && elev <= c2[0]) {
          const t = (elev - c1[0]) / (c2[0] - c1[0]);
          r = Math.round(c1[1] * (1 - t) + c2[1] * t);
          g = Math.round(c1[2] * (1 - t) + c2[2] * t);
          b = Math.round(c1[3] * (1 - t) + c2[3] * t);
          break;
        }
      }

      let isContour = false;
      if (settings.showContours && elev > config.seaLevel) {
        const rem = (elev - config.seaLevel) % contourInterval;
        if (rem < 0.0035 || rem > (contourInterval - 0.0035)) {
          isContour = true;
        }
      }

      const pIdx = (dstRow + dx) * 4;
      if (isContour) {
        data[pIdx] = 30;
        data[pIdx + 1] = 20;
        data[pIdx + 2] = 20;
        data[pIdx + 3] = 255;
      } else {
        const light = 0.4 + shade * 0.6;
        data[pIdx] = Math.min(255, r * light);
        data[pIdx + 1] = Math.min(255, g * light);
        data[pIdx + 2] = Math.min(255, b * light);
        data[pIdx + 3] = 255;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

export function renderTemperatureMap(
  canvas: HTMLCanvasElement,
  mapData: MapData,
  _settings: ToolSettings
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height, temperature, elevation, config } = mapData;

  const displaySize = Math.min(2048, Math.max(width, height));
  const renderW = Math.min(width, displaySize);
  const renderH = Math.min(height, displaySize);

  if (canvas.width !== renderW || canvas.height !== renderH) {
    canvas.width = renderW;
    canvas.height = renderH;
  }

  const imgData = ctx.createImageData(renderW, renderH);
  const data = imgData.data;

  const stepX = width / renderW;
  const stepY = height / renderH;

  for (let dy = 0; dy < renderH; dy++) {
    const srcY = Math.floor(dy * stepY);
    const dstRow = dy * renderW;

    for (let dx = 0; dx < renderW; dx++) {
      const srcX = Math.floor(dx * stepX);
      const idx = srcY * width + srcX;
      const temp = temperature[idx];
      const elev = elevation[idx];
      const isLand = elev > config.seaLevel;

      const norm = Math.max(0, Math.min(1, (temp + 30) / 75));

      let r = 0, g = 0, b = 0;
      if (norm < 0.25) {
        const t = norm / 0.25;
        r = Math.round(30 * (1 - t) + 14 * t);
        g = Math.round(27 * (1 - t) + 165 * t);
        b = Math.round(180 * (1 - t) + 233 * t);
      } else if (norm < 0.5) {
        const t = (norm - 0.25) / 0.25;
        r = Math.round(14 * (1 - t) + 34 * t);
        g = Math.round(165 * (1 - t) + 197 * t);
        b = Math.round(233 * (1 - t) + 94 * t);
      } else if (norm < 0.75) {
        const t = (norm - 0.5) / 0.25;
        r = Math.round(34 * (1 - t) + 234 * t);
        g = Math.round(197 * (1 - t) + 179 * t);
        b = Math.round(94 * (1 - t) + 8 * t);
      } else {
        const t = (norm - 0.75) / 0.25;
        r = Math.round(234 * (1 - t) + 225 * t);
        g = Math.round(179 * (1 - t) + 29 * t);
        b = Math.round(8 * (1 - t) + 72 * t);
      }

      const pIdx = (dstRow + dx) * 4;
      const factor = isLand ? 1.0 : 0.75;
      data[pIdx] = r * factor;
      data[pIdx + 1] = g * factor;
      data[pIdx + 2] = b * factor;
      data[pIdx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

export function renderMoistureMap(
  canvas: HTMLCanvasElement,
  mapData: MapData,
  settings: ToolSettings
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height, moisture, elevation, config } = mapData;

  const displaySize = Math.min(2048, Math.max(width, height));
  const renderW = Math.min(width, displaySize);
  const renderH = Math.min(height, displaySize);

  if (canvas.width !== renderW || canvas.height !== renderH) {
    canvas.width = renderW;
    canvas.height = renderH;
  }

  const imgData = ctx.createImageData(renderW, renderH);
  const data = imgData.data;

  const stepX = width / renderW;
  const stepY = height / renderH;
  const lx = -0.5, ly = -0.5, lz = 0.7071;

  for (let dy = 0; dy < renderH; dy++) {
    const srcY = Math.floor(dy * stepY);
    const yN = Math.max(0, srcY - 1);
    const yS = Math.min(height - 1, srcY + 1);
    const dstRow = dy * renderW;

    for (let dx = 0; dx < renderW; dx++) {
      const srcX = Math.floor(dx * stepX);
      const idx = srcY * width + srcX;
      const m = moisture[idx];
      const elev = elevation[idx];
      const isLand = elev > config.seaLevel;

      // Inline terrain normal for relief blending
      const xW = Math.max(0, srcX - 1);
      const xE = Math.min(width - 1, srcX + 1);
      const dzdx = (elevation[srcY * width + xE] - elevation[srcY * width + xW]) * 1.5;
      const dzdy = (elevation[yS * width + srcX] - elevation[yN * width + srcX]) * 1.5;
      const nLen = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1.0);
      const shade = 0.40 + 0.60 * Math.max(0, (-dzdx * lx - dzdy * ly + lz) / nLen);

      let r = 0, g = 0, b = 0;

      if (!isLand) {
        // Marine waters
        const depth = (config.seaLevel - elev) / Math.max(0.01, config.seaLevel);
        r = Math.round(14 * (1 - depth) + 8 * depth);
        g = Math.round(52 * (1 - depth) + 26 * depth);
        b = Math.round(98 * (1 - depth) + 54 * depth);
      } else {
        // Continuous 4-stop ecological moisture ramp:
        // Arid Desert (#d97706) -> Grassland (#ca8a04) -> Temperate Forest (#16a34a) -> Rainforest/Alpine (#0284c7)
        if (m < 0.25) {
          const t = m / 0.25;
          r = Math.round(217 * (1 - t) + 202 * t);
          g = Math.round(119 * (1 - t) + 138 * t);
          b = Math.round(6 * (1 - t) + 4 * t);
        } else if (m < 0.55) {
          const t = (m - 0.25) / 0.30;
          r = Math.round(202 * (1 - t) + 22 * t);
          g = Math.round(138 * (1 - t) + 163 * t);
          b = Math.round(4 * (1 - t) + 74 * t);
        } else if (m < 0.80) {
          const t = (m - 0.55) / 0.25;
          r = Math.round(22 * (1 - t) + 2 * t);
          g = Math.round(163 * (1 - t) + 132 * t);
          b = Math.round(74 * (1 - t) + 199 * t);
        } else {
          const t = Math.min(1.0, (m - 0.80) / 0.20);
          r = Math.round(2 * (1 - t) + 56 * t);
          g = Math.round(132 * (1 - t) + 189 * t);
          b = Math.round(199 * (1 - t) + 248 * t);
        }

        r = Math.min(255, Math.round(r * shade));
        g = Math.min(255, Math.round(g * shade));
        b = Math.min(255, Math.round(b * shade));
      }

      const pIdx = (dstRow + dx) * 4;
      data[pIdx] = r;
      data[pIdx + 1] = g;
      data[pIdx + 2] = b;
      data[pIdx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);

  if (settings.showWindVectors) {
    drawWindVectors(ctx, renderW, renderH);
  }
}

// 🪨 Render Geological Rock & Soil Stratification Layer
export function renderGeologyMap(
  canvas: HTMLCanvasElement,
  mapData: MapData,
  _settings: ToolSettings
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height, soilType, elevation } = mapData;

  const displaySize = Math.min(2048, Math.max(width, height));
  const renderW = Math.min(width, displaySize);
  const renderH = Math.min(height, displaySize);

  if (canvas.width !== renderW || canvas.height !== renderH) {
    canvas.width = renderW;
    canvas.height = renderH;
  }

  const imgData = ctx.createImageData(renderW, renderH);
  const data = imgData.data;

  const stepX = width / renderW;
  const stepY = height / renderH;
  const lx = -0.5, ly = -0.5, lz = 0.7071;

  for (let dy = 0; dy < renderH; dy++) {
    const srcY = Math.floor(dy * stepY);
    const yN = Math.max(0, srcY - 1);
    const yS = Math.min(height - 1, srcY + 1);
    const dstRow = dy * renderW;

    for (let dx = 0; dx < renderW; dx++) {
      const srcX = Math.floor(dx * stepX);
      const idx = srcY * width + srcX;
      const st = soilType ? soilType[idx] : 3;

      const xW = Math.max(0, srcX - 1);
      const xE = Math.min(width - 1, srcX + 1);
      const dzdx = (elevation[srcY * width + xE] - elevation[srcY * width + xW]) * 1.5;
      const dzdy = (elevation[yS * width + srcX] - elevation[yN * width + srcX]) * 1.5;
      const nLen = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1.0);
      const shade = 0.35 + 0.65 * Math.max(0, (-dzdx * lx - dzdy * ly + lz) / nLen);

      const def = ROCK_SOIL_DEFINITIONS[st] || ROCK_SOIL_DEFINITIONS[3];
      const hex = def.color;
      const baseR = parseInt(hex.slice(1, 3), 16);
      const baseG = parseInt(hex.slice(3, 5), 16);
      const baseB = parseInt(hex.slice(5, 7), 16);

      const light = 0.45 + shade * 0.55;
      const pIdx = (dstRow + dx) * 4;
      data[pIdx] = Math.min(255, baseR * light);
      data[pIdx + 1] = Math.min(255, baseG * light);
      data[pIdx + 2] = Math.min(255, baseB * light);
      data[pIdx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

export function renderDrainageBasinsMap(
  canvas: HTMLCanvasElement,
  mapData: MapData,
  _settings: ToolSettings
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height, drainageBasin, elevation, rivers, config } = mapData;

  const displaySize = Math.min(2048, Math.max(width, height));
  const renderW = Math.min(width, displaySize);
  const renderH = Math.min(height, displaySize);

  if (canvas.width !== renderW || canvas.height !== renderH) {
    canvas.width = renderW;
    canvas.height = renderH;
  }

  const imgData = ctx.createImageData(renderW, renderH);
  const data = imgData.data;

  const BASIN_COLORS = [
    [239, 68, 68], [249, 115, 22], [245, 158, 11], [132, 204, 22], [16, 185, 129],
    [6, 182, 212], [59, 130, 246], [99, 102, 241], [139, 92, 246], [217, 70, 239],
    [244, 63, 94], [20, 184, 166], [234, 179, 8], [168, 85, 247], [236, 72, 153],
  ];

  const stepX = width / renderW;
  const stepY = height / renderH;

  for (let dy = 0; dy < renderH; dy++) {
    const srcY = Math.floor(dy * stepY);
    const dstRow = dy * renderW;

    for (let dx = 0; dx < renderW; dx++) {
      const srcX = Math.floor(dx * stepX);
      const idx = srcY * width + srcX;
      const bId = drainageBasin[idx];
      const elev = elevation[idx];
      const isLand = elev > config.seaLevel;

      const pIdx = (dstRow + dx) * 4;
      if (!isLand) {
        data[pIdx] = 12;
        data[pIdx + 1] = 25;
        data[pIdx + 2] = 45;
        data[pIdx + 3] = 255;
      } else if (bId <= 0) {
        data[pIdx] = 100;
        data[pIdx + 1] = 100;
        data[pIdx + 2] = 100;
        data[pIdx + 3] = 255;
      } else {
        const color = BASIN_COLORS[bId % BASIN_COLORS.length];
        data[pIdx] = color[0];
        data[pIdx + 1] = color[1];
        data[pIdx + 2] = color[2];
        data[pIdx + 3] = 255;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);

  if (rivers) {
    const scale = renderW / width;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.8;
    for (const river of rivers) {
      if (river.points.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(river.points[0][0] * scale, river.points[0][1] * scale);
      for (let i = 1; i < river.points.length; i++) {
        ctx.lineTo(river.points[i][0] * scale, river.points[i][1] * scale);
      }
      ctx.stroke();
    }
  }
}

export function renderTectonicsMap(
  canvas: HTMLCanvasElement,
  mapData: MapData,
  _settings: ToolSettings
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height, plateMap, tectonicPlates, boundaryStress } = mapData;

  const displaySize = Math.min(2048, Math.max(width, height));
  const renderW = Math.min(width, displaySize);
  const renderH = Math.min(height, displaySize);

  if (canvas.width !== renderW || canvas.height !== renderH) {
    canvas.width = renderW;
    canvas.height = renderH;
  }

  const imgData = ctx.createImageData(renderW, renderH);
  const data = imgData.data;

  const stepX = width / renderW;
  const stepY = height / renderH;

  for (let dy = 0; dy < renderH; dy++) {
    const srcY = Math.floor(dy * stepY);
    const dstRow = dy * renderW;

    for (let dx = 0; dx < renderW; dx++) {
      const srcX = Math.floor(dx * stepX);
      const idx = srcY * width + srcX;
      const pId = plateMap[idx];
      const stress = boundaryStress[idx];
      const plate = tectonicPlates[pId];

      let r = 80, g = 80, b = 80;
      if (plate) {
        const hex = plate.color;
        r = parseInt(hex.slice(1, 3), 16);
        g = parseInt(hex.slice(3, 5), 16);
        b = parseInt(hex.slice(5, 7), 16);
      }

      if (stress > 0.05) {
        const t = Math.min(1.0, stress * 4.0);
        r = Math.round(r * (1 - t) + 255 * t);
        g = Math.round(g * (1 - t) + 255 * t);
        b = Math.round(b * (1 - t) + 255 * t);
      }

      const pIdx = (dstRow + dx) * 4;
      data[pIdx] = r;
      data[pIdx + 1] = g;
      data[pIdx + 2] = b;
      data[pIdx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

function drawWindVectors(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.lineWidth = 1.0;

  const step = Math.max(24, Math.floor(width / 20));
  for (let y = step; y < height; y += step) {
    const lat = ((y / height) * 2 - 1) * 90;
    const absLat = Math.abs(lat);
    let u = 0, v = 0;

    if (absLat < 30) {
      u = -1.0;
      v = lat > 0 ? -0.3 : 0.3;
    } else if (absLat < 60) {
      u = 1.2;
      v = lat > 0 ? 0.4 : -0.4;
    } else {
      u = -0.8;
      v = lat > 0 ? -0.2 : 0.2;
    }

    for (let x = step / 2; x < width; x += step) {
      const len = 12;
      const endX = x + u * len;
      const endY = y + v * len;

      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      const angle = Math.atan2(v, u);
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - 4 * Math.cos(angle - 0.5), endY - 4 * Math.sin(angle - 0.5));
      ctx.lineTo(endX - 4 * Math.cos(angle + 0.5), endY - 4 * Math.sin(angle + 0.5));
      ctx.fill();
    }
  }

  ctx.restore();
}

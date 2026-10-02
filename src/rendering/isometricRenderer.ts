/**
 * Pseudo-3D isometric block view of the map.
 */
import { BIOMES } from '../core/biomes';
import type { MapData, ToolSettings } from '../types/map';

export function renderIsometricMap(
  canvas: HTMLCanvasElement,
  mapData: MapData,
  _settings?: ToolSettings,
  elevationScale: number = 20,
  pitch: number = 0.52 // isometric pitch angle
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width, height, elevation, biomes, config } = mapData;

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  // Deep space / dark canvas background
  ctx.fillStyle = '#060911';
  ctx.fillRect(0, 0, width, height);

  // Isometric grid step (e.g. 2 or 3 pixels for smooth 60fps and high fidelity)
  const step = Math.max(2, Math.floor(width / 180));
  const cols = Math.floor(width / step);
  const rows = Math.floor(height / step);

  const isoCenterX = width / 2;
  const isoCenterY = height * 0.46;
  const isoScaleX = (width * 0.78) / cols;
  const isoScaleY = isoScaleX * pitch;

  const seaLevel = config.seaLevel;

  // Helper to sample smooth elevation with 3x3 box antialiasing
  const getSmoothElev = (gx: number, gy: number): number => {
    const cx = Math.min(width - 1, Math.max(0, gx * step));
    const cy = Math.min(height - 1, Math.max(0, gy * step));
    let sum = 0;
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const sy = Math.min(height - 1, Math.max(0, cy + dy));
      for (let dx = -1; dx <= 1; dx++) {
        const sx = Math.min(width - 1, Math.max(0, cx + dx));
        sum += elevation[sy * width + sx];
        count++;
      }
    }
    return sum / count;
  };

  // Precompute grid vertices
  const gridZ: Float32Array = new Float32Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const h = getSmoothElev(gx, gy);
      const z = h > seaLevel ? Math.pow((h - seaLevel) / (1.0 - seaLevel), 1.2) * elevationScale : 0;
      gridZ[gy * cols + gx] = z;
    }
  }

  // Light vector (from NW: 315 deg, 45 deg elevation)
  const lx = -0.577;
  const ly = -0.577;
  const lz = 0.577;

  // Render from back to front (gy from 0 to rows - 2)
  for (let gy = 0; gy < rows - 1; gy++) {
    for (let gx = 0; gx < cols - 1; gx++) {
      const x0 = gx * step;
      const y0 = gy * step;

      const z00 = gridZ[gy * cols + gx];
      const z10 = gridZ[gy * cols + (gx + 1)];
      const z01 = gridZ[(gy + 1) * cols + gx];
      const z11 = gridZ[(gy + 1) * cols + (gx + 1)];

      // Projected screen coordinates
      const p00x = isoCenterX + (gx - gy) * isoScaleX * 0.5;
      const p00y = isoCenterY + (gx + gy) * isoScaleY * 0.5 - z00;

      const p10x = isoCenterX + ((gx + 1) - gy) * isoScaleX * 0.5;
      const p10y = isoCenterY + ((gx + 1) + gy) * isoScaleY * 0.5 - z10;

      const p11x = isoCenterX + ((gx + 1) - (gy + 1)) * isoScaleX * 0.5;
      const p11y = isoCenterY + ((gx + 1) + (gy + 1)) * isoScaleY * 0.5 - z11;

      const p01x = isoCenterX + (gx - (gy + 1)) * isoScaleX * 0.5;
      const p01y = isoCenterY + (gx + (gy + 1)) * isoScaleY * 0.5 - z01;

      // Sample center index for color
      const idx = y0 * width + x0;
      const h = elevation[idx];

      // Calculate 3D normal vector for quad lighting
      const dzdx = (z10 - z00 + z11 - z01) * 0.5;
      const dzdy = (z01 - z00 + z11 - z10) * 0.5;
      const len = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1.0);
      const nx = -dzdx / len;
      const ny = -dzdy / len;
      const nz = 1.0 / len;

      const dot = nx * lx + ny * ly + nz * lz;
      const shade = Math.max(0.4, Math.min(1.3, dot * 0.5 + 0.75));

      let r = 14, g = 116, b = 144; // Ocean default

      if (h > seaLevel) {
        const biomeId = biomes[idx] as keyof typeof BIOMES;
        const biomeDef = BIOMES[biomeId] || BIOMES[10];
        const hex = biomeDef.colorSatellite;

        // Parse hex color
        const parsedR = parseInt(hex.slice(1, 3), 16) || 120;
        const parsedG = parseInt(hex.slice(3, 5), 16) || 140;
        const parsedB = parseInt(hex.slice(5, 7), 16) || 100;

        r = Math.min(255, Math.max(0, Math.round(parsedR * shade)));
        g = Math.min(255, Math.max(0, Math.round(parsedG * shade)));
        b = Math.min(255, Math.max(0, Math.round(parsedB * shade)));
      } else {
        const depth = Math.min(1.0, (seaLevel - h) / seaLevel);
        r = Math.round((20 * (1 - depth) + 8 * depth) * shade);
        g = Math.round((80 * (1 - depth) + 30 * depth) * shade);
        b = Math.round((140 * (1 - depth) + 60 * depth) * shade);
      }

      // Draw lit quad
      ctx.beginPath();
      ctx.moveTo(p00x, p00y);
      ctx.lineTo(p10x, p10y);
      ctx.lineTo(p11x, p11y);
      ctx.lineTo(p01x, p01y);
      ctx.closePath();

      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fill();

      // Soft quad wireframe
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
      ctx.lineWidth = 0.4;
      ctx.stroke();
    }
  }
}

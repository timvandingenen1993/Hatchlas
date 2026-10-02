/**
 * Parchment-style fantasy map render.
 */
import { drawTolkienMountain, drawTolkienTree, drawPOIIcon, drawCompassRose, drawScaleBar } from './iconStamps';
import { BIOMES } from '../core/biomes';
import type { MapData, ToolSettings } from '../types/map';

export function renderParchmentMap(
  canvas: HTMLCanvasElement,
  mapData: MapData,
  settings: ToolSettings,
  includeDecorations: boolean = true
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width, height, elevation, biomes, rivers, lakes, pois, title, subtitle, author, config } = mapData;

  // Adaptive canvas sizing to protect GPU backing store (capped at 2048 for smooth display)
  const displaySize = Math.min(2048, Math.max(width, height));
  const renderW = Math.min(width, displaySize);
  const renderH = Math.min(height, displaySize);

  if (canvas.width !== renderW || canvas.height !== renderH) {
    canvas.width = renderW;
    canvas.height = renderH;
  }

  // 1. Draw Textured Parchment Background
  ctx.fillStyle = '#e8d8be';
  ctx.fillRect(0, 0, renderW, renderH);

  // Parchment noise / fibers & vignette
  const imgData = ctx.createImageData(renderW, renderH);
  const data = imgData.data;

  const stepX = width / renderW;
  const stepY = height / renderH;

  for (let dy = 0; dy < renderH; dy++) {
    const srcY = Math.floor(dy * stepY);
    const ny = (srcY / height) * 2 - 1;
    const yIdx = srcY * width;
    const dstRow = dy * renderW;

    for (let dx = 0; dx < renderW; dx++) {
      const srcX = Math.floor(dx * stepX);
      const nx = (srcX / width) * 2 - 1;
      const idx = yIdx + srcX;
      const biome = BIOMES[biomes[idx] as keyof typeof BIOMES] || BIOMES[0];

      // Subtle parchment color variation based on biome tint
      const hex = biome.colorParchment;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);

      // Vignette factor
      const dist = Math.hypot(nx, ny);
      const vignette = Math.max(0.7, 1.0 - Math.pow(dist * 0.7, 2.5) * 0.35);

      // Fiber noise
      const noise = ((idx * 7919 + srcX * 31 + srcY * 97) % 19 - 9) * 0.8;

      const pIdx = (dstRow + dx) * 4;
      data[pIdx] = Math.min(255, Math.max(0, (r + noise) * vignette));
      data[pIdx + 1] = Math.min(255, Math.max(0, (g + noise) * vignette));
      data[pIdx + 2] = Math.min(255, Math.max(0, (b + noise) * vignette));
      data[pIdx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // 2. Draw Ocean Coastal Rippling Wave Rings (Concentric Hachures)
  drawCoastlineRipples(ctx, width, height, elevation, config.seaLevel);

  // 3. Draw Lakes
  if (lakes && lakes.length > 0) {
    ctx.fillStyle = '#dcd0b8';
    ctx.strokeStyle = '#3e2410';
    ctx.lineWidth = 1.2;
    for (const lake of lakes) {
      ctx.beginPath();
      ctx.arc(lake.x, lake.y, Math.max(2, lake.size * 0.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // 4. Draw River Network (Tapered antique ink paths)
  if (settings.showRivers && rivers) {
    ctx.strokeStyle = '#2b1b0d';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const river of rivers) {
      if (river.points.length < 2) continue;

      ctx.beginPath();
      ctx.moveTo(river.points[0][0], river.points[0][1]);

      const baseWidth = river.order === 4 ? 2.8 : river.order === 3 ? 2.0 : river.order === 2 ? 1.4 : 0.9;

      for (let i = 1; i < river.points.length; i++) {
        // Curve smoothly between points
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

  // 5. Draw Hand-Drawn Trees / Forest Patches
  drawForestClusters(ctx, width, height, elevation, biomes, config.seaLevel);

  // 6. Draw Hand-Drawn Mountain Peaks (Sorted North-to-South for correct painterly occlusion)
  drawMountainRanges(ctx, width, height, elevation, config.seaLevel);

  // 7. Draw Points of Interest / Fantasy Landmarks
  if (settings.showPOIs && pois) {
    for (const poi of pois) {
      drawPOIIcon(ctx, poi, 1.0, 'parchment');
    }
  }

  // 8. Draw Cartographic Map Borders & Rulers
  if (includeDecorations) {
    drawOrnateBorder(ctx, width, height);

    // Title Cartouche Banner
    if (title) {
      drawTitleBanner(ctx, width, title, subtitle, author);
    }

    // Compass Rose
    if (settings.showCompass) {
      drawCompassRose(ctx, width - 65, height - 75, 42);
    }

    // Scale Bar
    drawScaleBar(ctx, 45, height - 38, 120, 100);
  }
}

// Concentric ripple rings around coastlines
function drawCoastlineRipples(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  elevation: Float32Array,
  seaLevel: number
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(75, 45, 20, 0.28)';
  ctx.lineWidth = 1.0;

  const step = Math.max(3, Math.floor(width / 170));

  // We find shoreline cells and draw 2-3 outer offset rings
  for (let ring = 1; ring <= 2; ring++) {
    const offset = ring * 2.5;

    for (let y = step; y < height - step; y += step) {
      const yIdx = y * width;
      for (let x = step; x < width - step; x += step) {
        const idx = yIdx + x;
        const h = elevation[idx];

        if (h <= seaLevel && h >= seaLevel - 0.03 * ring) {
          // Check if near land
          const isNearLand =
            elevation[idx - 1] > seaLevel ||
            elevation[idx + 1] > seaLevel ||
            elevation[idx - width] > seaLevel ||
            elevation[idx + width] > seaLevel;

          if (isNearLand) {
            ctx.beginPath();
            ctx.arc(x, y, offset, 0, Math.PI * 0.4);
            ctx.stroke();
          }
        }
      }
    }
  }

  ctx.restore();
}

// Forest clusters using hand-drawn tree stamps
function drawForestClusters(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  elevation: Float32Array,
  biomes: Uint8Array,
  seaLevel: number
): void {
  const step = Math.max(8, Math.floor(width / 64));
  const scale = width / 512;

  for (let y = step; y < height - step; y += step) {
    const yIdx = y * width;
    for (let x = step; x < width - step; x += step) {
      const idx = yIdx + x;
      const h = elevation[idx];
      if (h <= seaLevel || h > 0.72) continue;

      const biomeDef = BIOMES[biomes[idx] as keyof typeof BIOMES];
      if (!biomeDef || biomeDef.treeDensity <= 0) continue;

      // Pseudo-random hash for tree placement
      const hash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const rand = hash - Math.floor(hash);

      if (rand < biomeDef.treeDensity) {
        const jx = x + ((rand * 100) % 5 - 2.5) * scale;
        const jy = y + ((rand * 1000) % 5 - 2.5) * scale;
        const treeSize = (6 + (rand * 4)) * Math.min(2.5, scale);
        drawTolkienTree(ctx, jx, jy, treeSize, biomeDef.treeType || 'broadleaf');
      }
    }
  }
}

// Mountains rendered as individual hand-drawn peaks sorted from top to bottom
function drawMountainRanges(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  elevation: Float32Array,
  seaLevel: number
): void {
  const peaks: { x: number; y: number; size: number; elev: number }[] = [];
  const step = Math.max(6, Math.floor(width / 85));
  const scale = width / 512;

  for (let y = step; y < height - step; y += step) {
    const yIdx = y * width;
    for (let x = step; x < width - step; x += step) {
      const idx = yIdx + x;
      const h = elevation[idx];

      if (h > seaLevel + 0.18) {
        // Mountain candidate
        const normElev = (h - (seaLevel + 0.18)) / (1.0 - (seaLevel + 0.18));
        const hash = Math.sin(x * 91.345 + y * 47.891) * 43758.5453;
        const rand = hash - Math.floor(hash);

        if (rand > 0.35) {
          const size = (7 + normElev * 14) * Math.min(2.5, scale);
          peaks.push({
            x: x + (rand * 4 - 2) * scale,
            y: y + (rand * 4 - 2) * scale,
            size,
            elev: h,
          });
        }
      }
    }
  }

  // Sort peaks from North to South (ascending Y) so southern peaks overlay northern ridges
  peaks.sort((a, b) => a.y - b.y);

  for (const peak of peaks) {
    drawTolkienMountain(ctx, peak.x, peak.y, peak.size, peak.elev);
  }
}

// Ornate decorative vintage map border
function drawOrnateBorder(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  const m = 14; // margin
  const b = 6;  // border bar thickness

  ctx.strokeStyle = '#3a1f0d';
  ctx.lineWidth = 1.5;

  // Outer border
  ctx.strokeRect(m, m, width - m * 2, height - m * 2);
  // Inner border
  ctx.strokeRect(m + b, m + b, width - (m + b) * 2, height - (m + b) * 2);

  // Alternating black and white ruler ticks along border
  const segLength = 20;
  const numSegsX = Math.floor((width - m * 2) / segLength);
  const numSegsY = Math.floor((height - m * 2) / segLength);

  for (let i = 0; i < numSegsX; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#3a1f0d' : '#f0ddc2';
    // Top border ticks
    ctx.fillRect(m + i * segLength, m, segLength, b);
    // Bottom border ticks
    ctx.fillRect(m + i * segLength, height - m - b, segLength, b);
  }

  for (let j = 0; j < numSegsY; j++) {
    ctx.fillStyle = j % 2 === 0 ? '#3a1f0d' : '#f0ddc2';
    // Left border ticks
    ctx.fillRect(m, m + j * segLength, b, segLength);
    // Right border ticks
    ctx.fillRect(width - m - b, m + j * segLength, b, segLength);
  }

  // Corner decorative squares
  ctx.fillStyle = '#b45309';
  [
    [m, m],
    [width - m - b, m],
    [m, height - m - b],
    [width - m - b, height - m - b],
  ].forEach(([cx, cy]) => {
    ctx.fillRect(cx, cy, b, b);
  });

  ctx.restore();
}

// Title cartouche banner
function drawTitleBanner(
  ctx: CanvasRenderingContext2D,
  width: number,
  title: string,
  subtitle?: string,
  author?: string
): void {
  ctx.save();
  const bw = Math.min(320, width * 0.6);
  const bh = subtitle ? 64 : 48;
  const bx = (width - bw) / 2;
  const by = 24;

  // Parchment banner backdrop
  ctx.fillStyle = '#f0e2cd';
  ctx.strokeStyle = '#452b14';
  ctx.lineWidth = 1.8;

  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeRect(bx, by, bw, bh);

  // Inner gold trim
  ctx.strokeStyle = '#b45309';
  ctx.lineWidth = 1.0;
  ctx.strokeRect(bx + 3, by + 3, bw - 6, bh - 6);

  // Banner swallowtail side ribbons
  ctx.fillStyle = '#eddcc4';
  ctx.strokeStyle = '#452b14';
  ctx.lineWidth = 1.5;

  // Left ribbon
  ctx.beginPath();
  ctx.moveTo(bx, by + 10);
  ctx.lineTo(bx - 16, by + 10);
  ctx.lineTo(bx - 8, by + bh / 2);
  ctx.lineTo(bx - 16, by + bh - 10);
  ctx.lineTo(bx, by + bh - 10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Right ribbon
  ctx.beginPath();
  ctx.moveTo(bx + bw, by + 10);
  ctx.lineTo(bx + bw + 16, by + 10);
  ctx.lineTo(bx + bw + 8, by + bh / 2);
  ctx.lineTo(bx + bw + 16, by + bh - 10);
  ctx.lineTo(bx + bw, by + bh - 10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Title text
  ctx.fillStyle = '#2b180a';
  ctx.font = `bold 16px 'Cinzel', serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(title.toUpperCase(), width / 2, by + 10);

  if (subtitle) {
    ctx.font = `italic 11px 'MedievalSharp', cursive`;
    ctx.fillStyle = '#6b452b';
    ctx.fillText(subtitle, width / 2, by + 32);
  }

  if (author) {
    ctx.font = `500 8px 'Cinzel', serif`;
    ctx.fillStyle = '#8c5e3c';
    ctx.fillText(author, width / 2, by + bh - 14);
  }

  ctx.restore();
}

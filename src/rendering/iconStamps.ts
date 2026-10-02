import type { POI } from '../types/map';

// Draw Tolkien-style hand-drawn mountain peak
export function drawTolkienMountain(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  elevationNormalized: number
): void {
  ctx.save();
  ctx.translate(x, y);

  const w = size * 1.8;
  const h = size * 2.2;
  const peakX = (Math.random() - 0.5) * (w * 0.2);
  const peakY = -h;

  ctx.lineWidth = Math.max(1.2, size * 0.1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Base outline path
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  // Left ridge
  ctx.quadraticCurveTo(-w * 0.3, -h * 0.5, peakX, peakY);
  // Right ridge
  ctx.quadraticCurveTo(w * 0.3, -h * 0.4, w / 2, 0);
  ctx.closePath();

  // Parchment fill behind mountain to occlude background
  ctx.fillStyle = '#eddcc4';
  ctx.fill();

  // Central spine / ridge dividing sunlit and shadow slopes
  ctx.strokeStyle = '#452b14';
  ctx.stroke();

  // Draw central jagged spine
  ctx.beginPath();
  ctx.moveTo(peakX, peakY);
  ctx.lineTo(peakX * 0.5 + w * 0.05, -h * 0.6);
  ctx.lineTo(peakX * 0.2 - w * 0.02, -h * 0.3);
  ctx.lineTo(w * 0.08, 0);
  ctx.stroke();

  // Shading hatch lines on the right/shadow facet
  ctx.lineWidth = Math.max(0.8, size * 0.06);
  ctx.strokeStyle = 'rgba(69, 43, 20, 0.65)';
  const hatchLines = Math.floor(size * 0.5);
  for (let i = 1; i <= hatchLines; i++) {
    const t = i / (hatchLines + 1);
    const startY = peakY * (1 - t);
    const startX = peakX * (1 - t) + w * 0.05 * t;
    const endX = startX + (w * 0.4) * t;
    const endY = startY + (h * 0.15);

    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(Math.min(w / 2, endX), Math.min(0, endY));
    ctx.stroke();
  }

  // Snowcap if very high elevation
  if (elevationNormalized > 0.75) {
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.moveTo(peakX, peakY);
    ctx.lineTo(peakX - w * 0.12, peakY + h * 0.25);
    ctx.lineTo(peakX, peakY + h * 0.2);
    ctx.lineTo(peakX + w * 0.12, peakY + h * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#452b14';
    ctx.stroke();
  }

  ctx.restore();
}

// Draw hand-drawn tree icon
export function drawTolkienTree(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  type: 'conifer' | 'broadleaf' | 'palm' | 'dead' | 'fungal' = 'broadleaf'
): void {
  ctx.save();
  ctx.translate(x, y);

  ctx.strokeStyle = '#3a2e1e';
  ctx.fillStyle = '#ecd6b8';
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const h = size * 1.6;
  const w = size * 1.2;

  if (type === 'conifer') {
    // Pine / Spruce tree
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -h * 0.2);
    ctx.stroke();

    // 3 tiered triangles
    ctx.beginPath();
    ctx.moveTo(-w * 0.5, -h * 0.2);
    ctx.lineTo(0, -h);
    ctx.lineTo(w * 0.5, -h * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Inner hatch line
    ctx.beginPath();
    ctx.moveTo(0, -h);
    ctx.lineTo(0, -h * 0.2);
    ctx.stroke();
  } else if (type === 'palm') {
    // Palm tree
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(w * 0.3, -h * 0.5, 0, -h);
    ctx.stroke();

    // Fronds
    const fronds = 4;
    for (let f = 0; f < fronds; f++) {
      const angle = (f / (fronds - 1) - 0.5) * Math.PI * 0.8;
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.quadraticCurveTo(
        Math.sin(angle) * w * 0.8,
        -h + Math.cos(angle) * h * 0.3,
        Math.sin(angle) * w,
        -h + Math.cos(angle) * h * 0.4
      );
      ctx.stroke();
    }
  } else {
    // Broadleaf / Oak tree
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -h * 0.35);
    ctx.stroke();

    // Puffy canopy
    ctx.beginPath();
    ctx.arc(0, -h * 0.65, w * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Shadow crescent
    ctx.beginPath();
    ctx.arc(w * 0.1, -h * 0.65, w * 0.35, 0, Math.PI);
    ctx.strokeStyle = 'rgba(58, 46, 30, 0.5)';
    ctx.stroke();
  }

  ctx.restore();
}

// Draw Fantasy Landmark / POI icon
export function drawPOIIcon(
  ctx: CanvasRenderingContext2D,
  poi: POI,
  scale: number = 1.0,
  style: 'parchment' | 'satellite' = 'parchment'
): void {
  const { x, y, category, name, color, subtext } = poi;
  const size = (poi.size || 16) * scale;

  ctx.save();
  ctx.translate(x, y);

  const isParchment = style === 'parchment';
  const primaryColor = isParchment ? (color || '#6b21a8') : (color || '#a855f7');
  const inkColor = isParchment ? '#2d1808' : '#ffffff';
  const shadowColor = isParchment ? 'rgba(45, 24, 8, 0.3)' : 'rgba(0, 0, 0, 0.6)';

  // Drop shadow
  ctx.shadowColor = shadowColor;
  ctx.shadowBlur = isParchment ? 4 : 8;
  ctx.shadowOffsetY = 2;

  switch (category) {
    case 'capital': {
      // Imperial Crowned Citadel
      ctx.fillStyle = '#f59e0b';
      ctx.strokeStyle = inkColor;
      ctx.lineWidth = 1.5;

      // Base tower
      ctx.fillRect(-size * 0.6, -size * 0.5, size * 1.2, size * 0.7);
      ctx.strokeRect(-size * 0.6, -size * 0.5, size * 1.2, size * 0.7);

      // Battlements
      ctx.beginPath();
      ctx.moveTo(-size * 0.7, -size * 0.5);
      ctx.lineTo(-size * 0.7, -size * 0.9);
      ctx.lineTo(-size * 0.4, -size * 0.9);
      ctx.lineTo(-size * 0.4, -size * 0.7);
      ctx.lineTo(-size * 0.15, -size * 0.7);
      ctx.lineTo(-size * 0.15, -size * 1.1); // High spire
      ctx.lineTo(size * 0.15, -size * 1.1);
      ctx.lineTo(size * 0.15, -size * 0.7);
      ctx.lineTo(size * 0.4, -size * 0.7);
      ctx.lineTo(size * 0.4, -size * 0.9);
      ctx.lineTo(size * 0.7, -size * 0.9);
      ctx.lineTo(size * 0.7, -size * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Gate arch
      ctx.fillStyle = inkColor;
      ctx.beginPath();
      ctx.arc(0, size * 0.2, size * 0.22, Math.PI, 0);
      ctx.fill();
      break;
    }

    case 'castle': {
      // Fortress
      ctx.fillStyle = '#94a3b8';
      ctx.strokeStyle = inkColor;
      ctx.lineWidth = 1.4;

      ctx.fillRect(-size * 0.5, -size * 0.4, size, size * 0.6);
      ctx.strokeRect(-size * 0.5, -size * 0.4, size, size * 0.6);

      // Left and right towers with cone roofs
      [-size * 0.45, size * 0.45].forEach((tx) => {
        ctx.beginPath();
        ctx.moveTo(tx - size * 0.2, -size * 0.4);
        ctx.lineTo(tx, -size * 0.95);
        ctx.lineTo(tx + size * 0.2, -size * 0.4);
        ctx.closePath();
        ctx.fillStyle = '#dc2626';
        ctx.fill();
        ctx.stroke();
      });
      break;
    }

    case 'port': {
      // Nautical Anchor
      ctx.strokeStyle = '#0284c7';
      ctx.fillStyle = '#0284c7';
      ctx.lineWidth = 2.0;

      ctx.beginPath();
      ctx.arc(0, -size * 0.5, size * 0.18, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, -size * 0.3);
      ctx.lineTo(0, size * 0.3);
      ctx.moveTo(-size * 0.3, -size * 0.1);
      ctx.lineTo(size * 0.3, -size * 0.1);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, -size * 0.05, size * 0.4, 0.2, Math.PI - 0.2);
      ctx.stroke();
      break;
    }

    case 'tower': {
      // Wizard Spire with magic orb
      ctx.fillStyle = '#6366f1';
      ctx.strokeStyle = inkColor;
      ctx.lineWidth = 1.4;

      ctx.beginPath();
      ctx.moveTo(-size * 0.3, size * 0.2);
      ctx.lineTo(-size * 0.15, -size * 0.7);
      ctx.lineTo(size * 0.15, -size * 0.7);
      ctx.lineTo(size * 0.3, size * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Glowing orb
      ctx.fillStyle = '#c084fc';
      ctx.beginPath();
      ctx.arc(0, -size * 0.85, size * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    }

    case 'dragon': {
      // Dragon Wyrm Roost
      ctx.fillStyle = '#dc2626';
      ctx.strokeStyle = inkColor;
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      ctx.arc(0, -size * 0.1, size * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#fef08a';
      ctx.font = `bold ${Math.round(size * 0.6)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🐉', 0, -size * 0.1);
      break;
    }

    case 'ruins': {
      // Collapsed Ancient Temple Pillars
      ctx.fillStyle = '#64748b';
      ctx.strokeStyle = inkColor;
      ctx.lineWidth = 1.4;

      ctx.fillRect(-size * 0.4, -size * 0.5, size * 0.2, size * 0.7);
      ctx.strokeRect(-size * 0.4, -size * 0.5, size * 0.2, size * 0.7);

      ctx.fillRect(size * 0.2, -size * 0.3, size * 0.2, size * 0.5);
      ctx.strokeRect(size * 0.2, -size * 0.3, size * 0.2, size * 0.5);

      // Cracked pediment
      ctx.beginPath();
      ctx.moveTo(-size * 0.5, -size * 0.5);
      ctx.lineTo(0, -size * 0.8);
      ctx.lineTo(size * 0.3, -size * 0.5);
      ctx.stroke();
      break;
    }

    default: {
      // Default circular marker
      ctx.fillStyle = primaryColor;
      ctx.strokeStyle = inkColor;
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      ctx.arc(0, 0, size * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
  }

  // Draw Text Label with Cartographic Font Styling
  ctx.shadowColor = isParchment ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 0;

  ctx.font = category === 'capital'
    ? `bold ${Math.max(12, Math.round(size * 0.9))}px 'Cinzel', serif`
    : `600 ${Math.max(10, Math.round(size * 0.75))}px 'Cinzel', serif`;
  
  ctx.fillStyle = isParchment ? '#1c1007' : '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(name, 0, size * 0.45);

  if (subtext) {
    ctx.font = `italic ${Math.max(9, Math.round(size * 0.6))}px 'MedievalSharp', cursive`;
    ctx.fillStyle = isParchment ? '#6b452b' : '#94a3b8';
    ctx.fillText(subtext, 0, size * 0.45 + size * 0.8);
  }

  ctx.restore();
}

// Draw Ornate Antique Compass Rose
export function drawCompassRose(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number = 42
): void {
  ctx.save();
  ctx.translate(x, y);

  // Outer decorative double rings
  ctx.strokeStyle = '#5c3a1e';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.88, 0, Math.PI * 2);
  ctx.stroke();

  // 8-point compass star points (N, NE, E, SE, S, SW, W, NW)
  const numPoints = 8;
  for (let i = 0; i < numPoints; i++) {
    const angle = (i * Math.PI) / 4;
    const isCardinal = i % 2 === 0;
    const pointLen = isCardinal ? radius * 0.82 : radius * 0.55;
    const halfWidthAngle = Math.PI / 16;

    // Dark half
    ctx.fillStyle = isCardinal ? '#3a1f0d' : '#6e4526';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(angle) * pointLen, -Math.cos(angle) * pointLen);
    ctx.lineTo(Math.sin(angle + halfWidthAngle) * (pointLen * 0.25), -Math.cos(angle + halfWidthAngle) * (pointLen * 0.25));
    ctx.closePath();
    ctx.fill();

    // Light half
    ctx.fillStyle = isCardinal ? '#e4caa3' : '#f0ddc2';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(angle) * pointLen, -Math.cos(angle) * pointLen);
    ctx.lineTo(Math.sin(angle - halfWidthAngle) * (pointLen * 0.25), -Math.cos(angle - halfWidthAngle) * (pointLen * 0.25));
    ctx.closePath();
    ctx.fill();
  }

  // Cardinal letters (N, S, E, W)
  ctx.font = `bold ${Math.round(radius * 0.35)}px 'Cinzel', serif`;
  ctx.fillStyle = '#3a1f0d';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillText('N', 0, -radius * 1.18);
  ctx.fillText('S', 0, radius * 1.15);
  ctx.fillText('E', radius * 1.18, 0);
  ctx.fillText('W', -radius * 1.18, 0);

  // Fleur-de-lis on North
  ctx.fillStyle = '#b45309';
  ctx.beginPath();
  ctx.arc(0, -radius * 0.88, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// Draw Ornate Cartographic Scale Bar
export function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number = 140,
  leagues: number = 100
): void {
  ctx.save();
  ctx.translate(x, y);

  const h = 8;
  const segments = 4;
  const segW = width / segments;

  ctx.strokeStyle = '#452b14';
  ctx.lineWidth = 1.5;

  for (let i = 0; i < segments; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#452b14' : '#ecd8bd';
    ctx.fillRect(i * segW, 0, segW, h);
    ctx.strokeRect(i * segW, 0, segW, h);
  }

  ctx.font = `500 10px 'Cinzel', serif`;
  ctx.fillStyle = '#452b14';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('0', 0, -2);
  ctx.fillText(`${leagues / 2}`, width / 2, -2);
  ctx.fillText(`${leagues} Leagues`, width, -2);

  ctx.restore();
}

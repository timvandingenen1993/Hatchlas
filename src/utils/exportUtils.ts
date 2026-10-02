import type { MapData } from '../types/map';
import { renderDebugDiagnosticMap } from '../rendering/debugRenderer';

// Export current canvas as high-resolution PNG image download
export function exportCanvasToImage(
  canvas: HTMLCanvasElement,
  filename: string = 'fantasy_world_map.png'
): void {
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png', 1.0);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Export 16-bit / 8-bit grayscale heightmap PNG
export function exportHeightmapPNG(
  elevation: Float32Array,
  width: number,
  height: number,
  filename: string = 'terrain_heightmap.png'
): void {
  const offCanvas = document.createElement('canvas');
  offCanvas.width = width;
  offCanvas.height = height;
  const ctx = offCanvas.getContext('2d');
  if (!ctx) return;

  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;

  for (let idx = 0; idx < width * height; idx++) {
    const val = Math.round(Math.max(0, Math.min(1, elevation[idx])) * 255);
    const pIdx = idx * 4;
    data[pIdx] = val;
    data[pIdx + 1] = val;
    data[pIdx + 2] = val;
    data[pIdx + 3] = 255;
  }

  ctx.putImageData(imgData, 0, 0);
  exportCanvasToImage(offCanvas, filename);
}

// Export 3D Normal Map PNG
export function exportNormalMapPNG(
  elevation: Float32Array,
  width: number,
  height: number,
  filename: string = 'terrain_normal_map.png'
): void {
  const offCanvas = document.createElement('canvas');
  offCanvas.width = width;
  offCanvas.height = height;
  const ctx = offCanvas.getContext('2d');
  if (!ctx) return;

  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;

  for (let y = 0; y < height; y++) {
    const yN = Math.max(0, y - 1);
    const yS = Math.min(height - 1, y + 1);

    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const xW = Math.max(0, x - 1);
      const xE = Math.min(width - 1, x + 1);

      const dzdx = (elevation[y * width + xE] - elevation[y * width + xW]) * 20.0;
      const dzdy = (elevation[yS * width + x] - elevation[yN * width + x]) * 20.0;
      const len = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1.0);

      const nx = (-dzdx / len) * 0.5 + 0.5;
      const ny = (-dzdy / len) * 0.5 + 0.5;
      const nz = (1.0 / len) * 0.5 + 0.5;

      const pIdx = idx * 4;
      data[pIdx] = Math.round(nx * 255);
      data[pIdx + 1] = Math.round(ny * 255);
      data[pIdx + 2] = Math.round(nz * 255);
      data[pIdx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  exportCanvasToImage(offCanvas, filename);
}

// Export 4-in-1 Diagnostic Analysis Sheet PNG
export function exportDiagnosticSheetPNG(
  mapData: MapData,
  filename: string = 'diagnostic_4in1_sheet.png'
): void {
  const offCanvas = document.createElement('canvas');
  offCanvas.width = mapData.width;
  offCanvas.height = mapData.height;

  renderDebugDiagnosticMap(offCanvas, mapData);
  exportCanvasToImage(offCanvas, filename);
}

// Export Diagnostic JSON Report with full statistical breakdown
export function exportDiagnosticReportJSON(mapData: MapData, filename?: string): void {
  const exportName = filename || `${mapData.title.toLowerCase().replace(/\s+/g, '_')}_diagnostic_report.json`;

  const total = mapData.width * mapData.height;
  let landCells = 0;
  let plainsCells = 0;
  let hillsCells = 0;
  let mountainCells = 0;
  let alpineCells = 0;
  let minElev = 1e9, maxElev = -1e9, sumElev = 0;

  const histogram = new Array(20).fill(0);

  for (let i = 0; i < total; i++) {
    const h = mapData.elevation[i];
    if (h < minElev) minElev = h;
    if (h > maxElev) maxElev = h;
    sumElev += h;

    const bin = Math.min(19, Math.floor(h * 20));
    histogram[bin]++;

    if (h > mapData.config.seaLevel) {
      landCells++;
      const meters = ((h - mapData.config.seaLevel) / (1.0 - mapData.config.seaLevel)) * 5000;
      if (meters < 350) plainsCells++;
      else if (meters < 1000) hillsCells++;
      else if (meters < 2500) mountainCells++;
      else alpineCells++;
    }
  }

  const report = {
    title: mapData.title,
    seed: mapData.seed,
    gridResolution: `${mapData.width}x${mapData.height}`,
    seaLevel: mapData.config.seaLevel,
    elevationStats: {
      minElevationNormalized: Number(minElev.toFixed(4)),
      maxElevationNormalized: Number(maxElev.toFixed(4)),
      meanElevationNormalized: Number((sumElev / total).toFixed(4)),
      minMeters: Math.round(minElev * 5000),
      maxMeters: Math.round(maxElev * 5000),
    },
    landHypsometry: {
      totalLandFraction: Number(((landCells / total) * 100).toFixed(2)) + '%',
      plainsFraction: Number(((plainsCells / Math.max(1, landCells)) * 100).toFixed(2)) + '%',
      hillsFraction: Number(((hillsCells / Math.max(1, landCells)) * 100).toFixed(2)) + '%',
      mountainsFraction: Number(((mountainCells / Math.max(1, landCells)) * 100).toFixed(2)) + '%',
      alpineSummitsFraction: Number(((alpineCells / Math.max(1, landCells)) * 100).toFixed(2)) + '%',
    },
    elevationHistogram20Bins: histogram,
    tectonics: {
      plateCount: mapData.tectonicPlates?.length ?? 0,
      plates: mapData.tectonicPlates,
      hotspotCount: mapData.hotspots?.length ?? 0,
    },
    config: mapData.config,
  };

  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Export entire MapData project state as JSON file
export function exportWorldToJSON(mapData: MapData, filename?: string): void {
  const exportName = filename || `${mapData.title.toLowerCase().replace(/\s+/g, '_')}_world.json`;

  const serialized = {
    version: 1,
    title: mapData.title,
    subtitle: mapData.subtitle,
    author: mapData.author,
    seed: mapData.seed,
    width: mapData.width,
    height: mapData.height,
    config: mapData.config,
    elevation: Array.from(mapData.elevation),
    temperature: Array.from(mapData.temperature),
    moisture: Array.from(mapData.moisture),
    precipitation: Array.from(mapData.precipitation),
    riverFlux: Array.from(mapData.riverFlux),
    flowDirection: Array.from(mapData.flowDirection),
    drainageBasin: Array.from(mapData.drainageBasin),
    sediment: Array.from(mapData.sediment),
    rockHardness: Array.from(mapData.rockHardness),
    soilType: Array.from(mapData.soilType),
    glacierIce: Array.from(mapData.glacierIce),
    biomes: Array.from(mapData.biomes),
    tectonicPlates: mapData.tectonicPlates,
    plateMap: Array.from(mapData.plateMap),
    boundaryStress: Array.from(mapData.boundaryStress),
    boundaryDistance: Array.from(mapData.boundaryDistance),
    hotspots: mapData.hotspots,
    lakes: mapData.lakes,
    rivers: mapData.rivers,
    pois: mapData.pois,
  };

  const blob = new Blob([JSON.stringify(serialized)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Load world state from JSON file
export function importWorldFromJSON(jsonText: string): MapData {
  const data = JSON.parse(jsonText);

  return {
    width: data.width,
    height: data.height,
    seed: data.seed,
    config: data.config,
    title: data.title,
    subtitle: data.subtitle,
    author: data.author,
    elevation: new Float32Array(data.elevation),
    temperature: new Float32Array(data.temperature),
    moisture: new Float32Array(data.moisture),
    precipitation: new Float32Array(data.precipitation),
    riverFlux: new Float32Array(data.riverFlux),
    flowDirection: new Int8Array(data.flowDirection),
    drainageBasin: new Int32Array(data.drainageBasin),
    sediment: new Float32Array(data.sediment),
    rockHardness: new Float32Array(data.rockHardness),
    soilType: new Uint8Array(data.soilType),
    glacierIce: new Float32Array(data.glacierIce),
    biomes: new Uint8Array(data.biomes),
    tectonicPlates: data.tectonicPlates,
    plateMap: new Uint8Array(data.plateMap),
    boundaryStress: new Float32Array(data.boundaryStress),
    boundaryDistance: new Float32Array(data.boundaryDistance),
    hotspots: data.hotspots,
    lakes: data.lakes,
    rivers: data.rivers,
    pois: data.pois,
  };
}

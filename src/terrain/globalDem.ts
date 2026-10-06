/**
 * Worldwide terrain download: plans, fetches and stitches open Terrarium
 * elevation tiles in the browser, cropped on the source grid to a WGS84 box.
 * Both providers serve CORS-enabled tiles, so no server is involved.
 */
import { openDrainageToFloor } from "./drainageOpening";
import { heightmapFromElevations, type HeightmapRaster } from "./mountainBaseDEM";

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export const MERCATOR_MAX_LAT = 85.0511287798066;
const EARTH_RADIUS_M = 6378137;
const HALF_WORLD_M = Math.PI * EARTH_RADIUS_M;
/** Pixels in the output grid; 64 Mapzen-sized 512 px tiles, as in the Heightmap app. */
const MAX_SOURCE_PIXELS = 64 * 512 * 512;
/**
 * Full-resolution pixels streamed for one download. Each tile is reduced to
 * the output grid as it arrives, so this bounds download time, not memory.
 */
const MAX_DETAIL_PIXELS = 4096 * 512 * 512;
/** Ground spacing of the sources' native data (Copernicus GLO-30, SRTM). */
const NATIVE_GROUND_M = 30;
const TERRARIUM_MISSING_BELOW_M = -12000;
const GEOTIFF_NODATA = -32768;

export type DemSourceId = "mapzen" | "mapterhorn";

export interface DemSource {
  id: DemSourceId;
  label: string;
  description: string;
  tileSize: number;
  /** Deepest zoom with worldwide coverage. */
  maxZoom: number;
  tileUrl: (z: number, x: number, y: number) => string;
  attribution: string;
}

export const DEM_SOURCES: Record<DemSourceId, DemSource> = {
  mapterhorn: {
    id: "mapterhorn",
    label: "Mapterhorn (Copernicus GLO-30)",
    description: "Copernicus 30 m DEM worldwide, with clean coastlines.",
    tileSize: 512,
    maxZoom: 12,
    tileUrl: (z, x, y) => `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`,
    attribution: "Mapterhorn; Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA",
  },
  mapzen: {
    id: "mapzen",
    label: "Mapzen / AWS Terrain Tiles",
    description: "SRTM, NED and other open sources, around 30 m on land. Coastlines can show seams between sources.",
    tileSize: 256,
    maxZoom: 15,
    tileUrl: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    attribution: "Mapzen Terrain Tiles on AWS Open Data; see tilezen/joerd attribution",
  },
};

export interface DemTile {
  z: number;
  x: number;
  y: number;
}

export interface GlobalDemPlan {
  source: DemSource;
  /** Zoom of the output grid. */
  zoom: number;
  /** Tiles covering the crop window at `zoom`. */
  tiles: DemTile[];
  /**
   * Zoom actually downloaded: the native ~30 m data, so valleys narrower than
   * an output cell stay open. Each output cell averages a power-of-two block.
   */
  detailZoom: number;
  detailTiles: DemTile[];
  /** Crop window in global pixel coordinates at `zoom`. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Web Mercator metres per pixel. */
  projectedCellSize: number;
  /** Approximate ground metres per pixel at the box centre. */
  groundCellSize: number;
  widthKm: number;
  heightKm: number;
}

export interface GlobalDemMosaic extends GlobalDemPlan {
  /** Elevation in metres, row-major from the north edge; NaN where missing. */
  values: Float32Array;
  minElevationM: number;
  maxElevationM: number;
}

export function bboxError(bbox: BBox): string | null {
  if (![bbox.west, bbox.south, bbox.east, bbox.north].every(Number.isFinite)) return "Enter four valid coordinates.";
  if (bbox.west < -180 || bbox.east > 180 || bbox.west >= bbox.east) {
    return "Longitude must be between -180 and 180, with west smaller than east. Boxes cannot cross the date line.";
  }
  if (bbox.south < -MERCATOR_MAX_LAT || bbox.north > MERCATOR_MAX_LAT || bbox.south >= bbox.north) {
    return "Latitude must be between -85.05 and 85.05, with south smaller than north.";
  }
  return null;
}

const mercatorX = (lon: number) => (lon / 180) * HALF_WORLD_M;
const mercatorY = (lat: number) => EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** Ground metres per Web Mercator metre at a projected northing. */
const mercatorGroundScale = (y: number) => 1 / Math.cosh(y / EARTH_RADIUS_M);

/**
 * Chooses the coarsest zoom that reaches the requested ground spacing, then
 * coarsens further until the download fits the pixel budget. Finer zooms
 * than the source's native detail are never chosen, since they add no data.
 */
export function planGlobalDem(bbox: BBox, source: DemSource, requestedGroundM = 30): GlobalDemPlan {
  const error = bboxError(bbox);
  if (error) throw new Error(error);
  if (!Number.isFinite(requestedGroundM) || requestedGroundM <= 0) throw new Error("Choose a positive ground spacing.");

  const west = mercatorX(bbox.west);
  const east = mercatorX(bbox.east);
  const north = mercatorY(bbox.north);
  const south = mercatorY(bbox.south);
  const groundScale = mercatorGroundScale((north + south) / 2);
  const maxTiles = Math.max(1, Math.floor(MAX_SOURCE_PIXELS / source.tileSize ** 2));

  const window = (zoom: number) => {
    const worldPixels = source.tileSize * 2 ** zoom;
    const toPixels = worldPixels / (2 * HALF_WORLD_M);
    const left = Math.floor((west + HALF_WORLD_M) * toPixels + 1e-7);
    const right = Math.max(left + 1, Math.ceil((east + HALF_WORLD_M) * toPixels - 1e-7));
    const top = Math.floor((HALF_WORLD_M - north) * toPixels + 1e-7);
    const bottom = Math.max(top + 1, Math.ceil((HALF_WORLD_M - south) * toPixels - 1e-7));
    const clamp = (value: number) => Math.max(0, Math.min(worldPixels, value));
    return { left: clamp(left), right: clamp(right), top: clamp(top), bottom: clamp(bottom) };
  };
  const tileCount = (zoom: number) => {
    const w = window(zoom);
    const tiles = (a: number, b: number) => Math.floor((b - 1) / source.tileSize) - Math.floor(a / source.tileSize) + 1;
    return tiles(w.left, w.right) * tiles(w.top, w.bottom);
  };

  const zoomFor = (groundM: number) => Math.max(0, Math.min(source.maxZoom,
    Math.ceil(Math.log2((2 * HALF_WORLD_M * groundScale) / (source.tileSize * groundM))),
  ));
  let zoom = zoomFor(requestedGroundM);
  while (zoom > 0 && tileCount(zoom) > maxTiles) zoom--;

  // A block of detail pixels must fit inside one tile so each tile reduces on its own.
  let detailZoom = Math.max(zoom, Math.min(zoomFor(NATIVE_GROUND_M), zoom + Math.log2(source.tileSize)));
  const maxDetailTiles = Math.max(1, Math.floor(MAX_DETAIL_PIXELS / source.tileSize ** 2));
  while (detailZoom > zoom && tileCount(detailZoom) > maxDetailTiles) detailZoom--;

  const tilesAt = (z: number) => {
    const w = window(z);
    const list: DemTile[] = [];
    for (let y = Math.floor(w.top / source.tileSize); y <= Math.floor((w.bottom - 1) / source.tileSize); y++) {
      for (let x = Math.floor(w.left / source.tileSize); x <= Math.floor((w.right - 1) / source.tileSize); x++) {
        list.push({ z, x, y });
      }
    }
    return list;
  };
  const { left, right, top, bottom } = window(zoom);
  const tiles = tilesAt(zoom);
  const detailTiles = detailZoom === zoom ? tiles : tilesAt(detailZoom);
  const projectedCellSize = (2 * HALF_WORLD_M) / (source.tileSize * 2 ** zoom);
  // Measure at the centre of the snapped window, which is what gets exported.
  const centreY = HALF_WORLD_M - ((top + bottom) / 2) * projectedCellSize;
  const groundCellSize = projectedCellSize * mercatorGroundScale(centreY);
  const width = right - left;
  const height = bottom - top;
  return {
    source, zoom, tiles, detailZoom, detailTiles, left, top, width, height, projectedCellSize, groundCellSize,
    widthKm: (width * groundCellSize) / 1000,
    heightKm: (height * groundCellSize) / 1000,
  };
}

/** Decodes Terrarium RGB(A) pixels: elevation = R·256 + G + B/256 − 32768 m. */
export function decodeTerrarium(pixels: Uint8Array | Uint8ClampedArray, channels = 4): Float32Array {
  const cells = Math.floor(pixels.length / channels);
  const elevations = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    const p = i * channels;
    const elevation = pixels[p] * 256 + pixels[p + 1] + pixels[p + 2] / 256 - 32768;
    // Black (0,0,0) pixels are the format's unfilled value.
    elevations[i] = elevation < TERRARIUM_MISSING_BELOW_M ? Number.NaN : elevation;
  }
  return elevations;
}

/**
 * Replaces the sea with NaN: cells at or below 0 m that connect to the map
 * edge. Both providers store open sea at 0 m or below, which would otherwise
 * read as a flat coastal plain above the default sea level. Enclosed
 * depressions such as Death Valley stay land; polders that reach the sea
 * through cells at or below 0 m flood, as they would without dikes.
 */
export function maskEdgeConnectedSea(values: Float32Array, width: number, height: number): void {
  const queue = new Int32Array(values.length);
  const seen = new Uint8Array(values.length);
  let head = 0;
  let tail = 0;
  const visit = (index: number) => {
    // NaN fails `> 0`, so missing cells join the sea and carry the flood.
    if (seen[index] || values[index] > 0) return;
    seen[index] = 1;
    values[index] = Number.NaN;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    if (x > 0) visit(index - 1);
    if (x < width - 1) visit(index + 1);
    if (index >= width) visit(index - width);
    if (index < values.length - width) visit(index + width);
  }
}

/** Loads one tile's elevations (tileSize² cells), or null when the provider has none. */
export type DemTileLoader = (tile: DemTile, signal: AbortSignal) => Promise<Float32Array | null>;

/**
 * Downloads the full-resolution tiles with limited concurrency. Each tile is
 * reduced straight into the output grid (mean for the surface, minimum for
 * the valley floor) and then released, so memory does not grow with detail.
 */
export async function assembleGlobalDem(
  plan: GlobalDemPlan,
  loadTile: DemTileLoader,
  signal: AbortSignal,
  onProgress?: (loaded: number, total: number) => void,
  concurrency = 6,
): Promise<GlobalDemMosaic> {
  const { tileSize } = plan.source;
  const factor = 2 ** (plan.detailZoom - plan.zoom);
  const values = new Float32Array(plan.width * plan.height).fill(Number.NaN);
  const floor = factor > 1 ? new Float32Array(plan.width * plan.height).fill(Number.NaN) : values;
  const tiles = plan.detailTiles;
  let next = 0;
  let loaded = 0;
  onProgress?.(0, tiles.length);

  const reduceTile = (tile: DemTile, elevations: Float32Array) => {
    if (elevations.length !== tileSize * tileSize) throw new Error("Terrain tile has an unexpected size.");
    const tileLeft = tile.x * tileSize;
    const tileTop = tile.y * tileSize;
    // Output cells whose detail block lies in this tile, clipped to the crop.
    const x0 = Math.max(plan.left, tileLeft / factor);
    const x1 = Math.min(plan.left + plan.width, (tileLeft + tileSize) / factor);
    const y0 = Math.max(plan.top, tileTop / factor);
    const y1 = Math.min(plan.top + plan.height, (tileTop + tileSize) / factor);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let sum = 0;
        let count = 0;
        let lowest = Number.POSITIVE_INFINITY;
        for (let row = y * factor - tileTop; row < (y + 1) * factor - tileTop; row++) {
          for (let column = x * factor - tileLeft; column < (x + 1) * factor - tileLeft; column++) {
            const value = elevations[row * tileSize + column];
            if (Number.isNaN(value)) continue;
            sum += value;
            count++;
            if (value < lowest) lowest = value;
          }
        }
        if (count === 0) continue;
        const index = (y - plan.top) * plan.width + (x - plan.left);
        values[index] = sum / count;
        floor[index] = lowest;
      }
    }
  };
  const worker = async () => {
    while (next < tiles.length) {
      const tile = tiles[next++];
      signal.throwIfAborted();
      const elevations = await loadTile(tile, signal);
      signal.throwIfAborted();
      if (elevations) reduceTile(tile, elevations);
      onProgress?.(++loaded, tiles.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, worker));
  if (!values.some((value) => !Number.isNaN(value))) {
    throw new Error("The provider returned no elevation data for this area.");
  }
  maskEdgeConnectedSea(values, plan.width, plan.height);
  if (factor > 1) openDrainageToFloor(values, floor, plan.width, plan.height);

  let minElevationM = Number.POSITIVE_INFINITY;
  let maxElevationM = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < minElevationM) minElevationM = value;
    if (value > maxElevationM) maxElevationM = value;
  }
  if (!Number.isFinite(minElevationM)) throw new Error("This area is entirely sea. Include some land.");
  return { ...plan, values, minElevationM, maxElevationM };
}

export function globalDemToHeightmap(mosaic: GlobalDemMosaic): HeightmapRaster {
  return heightmapFromElevations(mosaic.values, mosaic.width, mosaic.height, {
    widthKm: mosaic.widthKm,
    heightKm: mosaic.heightKm,
  });
}

/** Lossless, uncompressed Float32 GeoTIFF in EPSG:3857 that the heightmap loader reads back with its scale. */
export function encodeGlobalDemGeoTiff(mosaic: GlobalDemMosaic): ArrayBuffer {
  const { width, height, projectedCellSize: cell } = mosaic;
  const minX = mosaic.left * cell - HALF_WORLD_M;
  const maxY = HALF_WORLD_M - mosaic.top * cell;
  const nodataBytes = new TextEncoder().encode(`${GEOTIFF_NODATA}\0`);
  const pixelOffset = 8;
  const pixelBytes = width * height * 4;
  const pixelScaleOffset = pixelOffset + pixelBytes;
  const tiepointOffset = pixelScaleOffset + 24;
  const geoKeyOffset = tiepointOffset + 48;
  const geoKeys = new Uint16Array([
    1, 1, 0, 3,
    1024, 0, 1, 1, // GTModelType: projected
    1025, 0, 1, 1, // GTRasterType: pixel is area
    3072, 0, 1, 3857, // ProjectedCRS: Web Mercator
  ]);
  const nodataOffset = geoKeyOffset + geoKeys.byteLength;
  const ifdOffset = nodataOffset + nodataBytes.byteLength + (nodataBytes.byteLength % 2);
  const tags: [tag: number, type: number, count: number, value: number][] = [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 1, 32],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [273, 4, 1, pixelOffset],
    [277, 3, 1, 1],
    [278, 4, 1, height],
    [279, 4, 1, pixelBytes],
    [284, 3, 1, 1],
    [339, 3, 1, 3],
    [33550, 12, 3, pixelScaleOffset],
    [33922, 12, 6, tiepointOffset],
    [34735, 3, geoKeys.length, geoKeyOffset],
    [42113, 2, nodataBytes.byteLength, nodataOffset],
  ];
  const buffer = new ArrayBuffer(ifdOffset + 2 + tags.length * 12 + 4);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  for (let i = 0; i < mosaic.values.length; i++) {
    const value = mosaic.values[i];
    view.setFloat32(pixelOffset + i * 4, Number.isFinite(value) ? value : GEOTIFF_NODATA, true);
  }
  [cell, cell, 0].forEach((value, i) => view.setFloat64(pixelScaleOffset + i * 8, value, true));
  [0, 0, 0, minX, maxY, 0].forEach((value, i) => view.setFloat64(tiepointOffset + i * 8, value, true));
  geoKeys.forEach((value, i) => view.setUint16(geoKeyOffset + i * 2, value, true));
  new Uint8Array(buffer, nodataOffset, nodataBytes.byteLength).set(nodataBytes);

  view.setUint16(ifdOffset, tags.length, true);
  tags.forEach(([tag, type, count, value], i) => {
    const entry = ifdOffset + 2 + i * 12;
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, type, true);
    view.setUint32(entry + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(entry + 8, value, true);
    else view.setUint32(entry + 8, value, true);
  });
  return buffer;
}

const TILE_CACHE_NAME = "hatchlas-dem-tiles-v1";

async function fetchTileBytes(url: string, signal: AbortSignal): Promise<Blob | null> {
  // The Cache API is missing outside secure contexts and fails in some private
  // windows; downloads still work without it.
  const cache = await globalThis.caches?.open(TILE_CACHE_NAME).catch(() => null);
  const cached = await cache?.match(url).catch(() => undefined);
  if (cached) return cached.blob();
  const response = await fetch(url, { signal, mode: "cors" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The terrain provider returned HTTP ${response.status}.`);
  await cache?.put(url, response.clone()).catch(() => undefined);
  return response.blob();
}

/** Browser tile loader: fetch, cache, then decode the image without colour management. */
export function terrariumTileLoader(source: DemSource): DemTileLoader {
  return async (tile, signal) => {
    const blob = await fetchTileBytes(source.tileUrl(tile.z, tile.x, tile.y), signal);
    if (!blob) return null;
    // Colour conversion or premultiplication would corrupt the encoded elevations.
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("This browser cannot decode terrain tiles.");
      context.drawImage(bitmap, 0, 0);
      return decodeTerrarium(context.getImageData(0, 0, bitmap.width, bitmap.height).data);
    } finally {
      bitmap.close();
    }
  };
}

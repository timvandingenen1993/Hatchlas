/**
 * Perspective and orthographic camera renderer for the full mountain terrain, with a tiled texture cache.
 */
import type { MountainDEMData } from '../terrain/mountainBaseDEM';
import type { MountainStrokePath } from './mountainPatternRenderer';
import {
  createCharcoalInterruptionPattern,
  hash01,
  isCharcoalInkActiveAtDistance,
  sampleScalarField,
} from './cartographicStrokeRenderer';
import { MOUNTAIN_RIDGE_INK, paintMountainCameraSegment } from './mountainCameraLinework';
import { MOUNTAIN_REFERENCE_PAPER_RGBA } from './mountainProjection';

export type FullTerrainCameraType = 'orthographic' | 'perspective';

export type FullTerrainCameraRenderStyle = 'study' | 'compositor';

export interface FullTerrainCameraSettings {
  /** Source-space primary ridges, inked once after terrain visibility resolves. */
  ridgePaths?: readonly MountainStrokePath[];
  /** Optional user palette color for the primary ridge pass. */
  ridgeColor?: string | readonly number[];
  ridgeThicknessScale?: number;
  /** Temporary test switch for charcoal primary crest strokes. */
  charcoalRidges?: boolean;
  /** Projection used by the full-terrain camera. */
  cameraType?: FullTerrainCameraType;
  /** Camera elevation above the terrain plane, in degrees. */
  elevationDeg?: number;
  /** Vertical world-unit multiplier supplied by the camera study. */
  heightExaggeration?: number;
  /** Vertical field of view for perspective projection. */
  fieldOfViewDeg?: number;
  /** Optional cell mask used only to choose the fitted frame. All DEM cells
   * still participate in projection and depth testing. */
  fitMask?: ArrayLike<number>;
  /** Output raster width. Defaults to the source texture width. */
  outputWidth?: number;
  /** Output raster height. Defaults to the source texture height. */
  outputHeight?: number;
  /** Smoothed terrain surface used by the camera mesh. The source raster is
   * still sampled from the original image; this field only controls relief
   * geometry and matches the study mesh's face elevation field. */
  elevationField?: ArrayLike<number>;
  /** RGB(A) used for the small letterbox margin around the fitted surface. */
  background?: readonly [number, number, number, number];
  /** Optional transparent source-space layer composited after camera ridge ink. */
  foregroundSource?: ImageData | FullTerrainCameraTextureSource;
  /** Destination row range for bounded export rendering. */
  rowStart?: number;
  rowEnd?: number;
  /** Destination column range; pixels outside it keep the background. */
  colStart?: number;
  colEnd?: number;
  /** Packed projection reused by bounded output bands. */
  projection?: FullTerrainCameraProjection;
}

/** Image-like source used by bounded exports. Samples may be served from an
 * LRU tile cache instead of a full output-sized ImageData allocation. */
export interface FullTerrainCameraTextureSource {
  width: number;
  height: number;
  sampleRGBA(
    x: number,
    y: number,
    output: Uint8ClampedArray,
    offset: number,
  ): void;
}

/** A camera band whose visible source coordinates have been resolved but not
 * sampled yet. The retained buffers let export workers prepare texture tiles
 * in parallel before the final color lookup. */
export interface FullTerrainCameraBandPlan {
  width: number;
  height: number;
  rowStart: number;
  depthBuffer: Float32Array;
  sampleMask: Uint8Array;
  sourceX: Float64Array;
  sourceY: Float64Array;
  finish(source: ImageData | FullTerrainCameraTextureSource): ImageData;
}

/** Packed, reusable camera mesh produced once for a complete export. */
export interface FullTerrainCameraProjection {
  width: number;
  fullHeight: number;
  meshWidth: number;
  meshHeight: number;
  cameraType: FullTerrainCameraType;
  dxMeters: number;
  dyMeters: number;
  x: Float32Array;
  y: Float32Array;
  depth: Float32Array;
  inverseDistance?: Float32Array;
  /** Packed source-mesh block bounds used to cull destination bands. */
  meshBlockSize?: number;
  meshBlockColumns?: number;
  meshBlockRows?: number;
  meshBlockMinX?: Float32Array;
  meshBlockMaxX?: Float32Array;
  meshBlockMinY?: Float32Array;
  meshBlockMaxY?: Float32Array;
}

/** Kept as a compatibility alias for callers that explicitly request the old projection. */
export type FullTerrainOrthographicCameraSettings = FullTerrainCameraSettings;

interface ProjectedRasterPoint {
  x: number;
  y: number;
  depth: number;
  inverseDistance: number;
}

interface PreparedCameraRidgeSegment {
  a: ProjectedRasterPoint;
  b: ProjectedRasterPoint;
  radius: number;
  opacity: number;
  order: number;
}

interface PreparedCameraRidges {
  paths: readonly MountainStrokePath[] | undefined;
  color: FullTerrainCameraSettings['ridgeColor'];
  thicknessScale: number | undefined;
  charcoal: boolean | undefined;
  colorRgb: readonly [number, number, number];
  bands: Map<number, PreparedCameraRidgeSegment[]>;
}

const CAMERA_RIDGE_BAND_HEIGHT = 128;
const preparedCameraRidges = new WeakMap<FullTerrainCameraProjection, PreparedCameraRidges>();

const DEFAULT_BACKGROUND: readonly [number, number, number, number] = MOUNTAIN_REFERENCE_PAPER_RGBA;

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
}

function resolveRGB(
  value: string | readonly number[] | undefined,
  fallback: readonly [number, number, number],
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
      clamp(value[0], 0, 255, fallback[0]),
      clamp(value[1], 0, 255, fallback[1]),
      clamp(value[2], 0, 255, fallback[2]),
    ].map(Math.round) as [number, number, number];
  }
  return [...fallback];
}

function sampleRGBAInto(
  source: ImageData | FullTerrainCameraTextureSource,
  x: number,
  y: number,
  output: Uint8ClampedArray,
  offset: number,
): void {
  if ('sampleRGBA' in source) {
    source.sampleRGBA(x, y, output, offset);
    return;
  }
  const width = source.width;
  const height = source.height;
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;
  const topLeft = (y0 * width + x0) * 4;
  const topRight = (y0 * width + x1) * 4;
  const bottomLeft = (y1 * width + x0) * 4;
  const bottomRight = (y1 * width + x1) * 4;
  const topWeight = 1 - tx;
  const bottomWeight = 1 - ty;
  const topRightWeight = tx;
  const bottomRightWeight = ty;
  for (let channel = 0; channel < 4; channel++) {
    const top = source.data[topLeft + channel] * topWeight +
      source.data[topRight + channel] * topRightWeight;
    const bottom = source.data[bottomLeft + channel] * topWeight +
      source.data[bottomRight + channel] * topRightWeight;
    output[offset + channel] = Math.round(top * bottomWeight + bottom * bottomRightWeight);
  }
}

function makeImageData(width: number, height: number, data: Uint8ClampedArray): ImageData {
  if (typeof ImageData !== 'undefined') {
    return new ImageData(data as unknown as Uint8ClampedArray<ArrayBuffer>, width, height);
  }
  return { width, height, data } as unknown as ImageData;
}

export function prepareFullTerrainCameraProjection(
  dem: MountainDEMData,
  requested: FullTerrainCameraSettings = {},
): FullTerrainCameraProjection {
  const width = Math.max(2, Math.floor(requested.outputWidth ?? dem.width));
  const fullHeight = Math.max(2, Math.floor(requested.outputHeight ?? dem.height));
  const meshWidth = dem.width;
  const meshHeight = dem.height;
  const cameraType = requested.cameraType ?? "orthographic";
  // Typed inspector overrides may leave the slider range; only a level or
  // straight-down camera is refused.
  const elevationDeg = clamp(requested.elevationDeg ?? 75, 1, 89, 75);
  const heightExaggeration = clamp(requested.heightExaggeration ?? 1, 0.01, Infinity, 1);
  const angle = elevationDeg * Math.PI / 180;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const dxMeters = Math.max(1e-6, dem.dxMeters || (dem.domainWidthKm * 1000) / meshWidth);
  const dyMeters = Math.max(1e-6, dem.dyMeters || (dem.domainHeightKm * 1000) / meshHeight);
  const meshTotal = meshWidth * meshHeight;
  let targetElevation = (dem.minElevationM + dem.maxElevationM) * 0.5;
  if (requested.elevationField && requested.elevationField.length >= meshTotal) {
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let index = 0; index < meshTotal; index++) {
      const elevation = requested.elevationField[index];
      if (!Number.isFinite(elevation)) continue;
      minimum = Math.min(minimum, elevation);
      maximum = Math.max(maximum, elevation);
    }
    if (Number.isFinite(minimum) && Number.isFinite(maximum)) {
      targetElevation = (minimum + maximum) * 0.5;
    }
  }
  const centerX = (meshWidth - 1) * 0.5;
  const centerY = (meshHeight - 1) * 0.5;
  const x = new Float32Array(meshTotal);
  const y = new Float32Array(meshTotal);
  const depth = new Float32Array(meshTotal);
  const inverseDistance = cameraType === "perspective"
    ? new Float32Array(meshTotal)
    : undefined;
  let maxAbsDepth = 0;
  let maxAbsExtent = 0;
  let frameMinX = Infinity;
  let frameMaxX = -Infinity;
  let frameMinY = Infinity;
  let frameMaxY = -Infinity;
  let frameMaxAbsExtent = 0;
  let hasFrameMask = false;
  for (let row = 0; row < meshHeight; row++) {
    const yMeters = (row - centerY) * dyMeters;
    for (let column = 0; column < meshWidth; column++) {
      const index = row * meshWidth + column;
      const xMeters = (column - centerX) * dxMeters;
      const cameraElevation = requested.elevationField?.[index] ?? dem.elevation[index];
      const elevationMeters = (cameraElevation - targetElevation) * heightExaggeration;
      const upMeters = -yMeters * sin + elevationMeters * cos;
      const depthMeters = yMeters * cos + elevationMeters * sin;
      x[index] = xMeters;
      y[index] = upMeters;
      depth[index] = depthMeters;
      maxAbsDepth = Math.max(maxAbsDepth, Math.abs(depthMeters));
      maxAbsExtent = Math.max(maxAbsExtent, Math.abs(xMeters), Math.abs(upMeters));
      if ((requested.fitMask?.[index] ?? 1) > 8) {
        hasFrameMask = true;
        frameMinX = Math.min(frameMinX, xMeters);
        frameMaxX = Math.max(frameMaxX, xMeters);
        frameMinY = Math.min(frameMinY, upMeters);
        frameMaxY = Math.max(frameMaxY, upMeters);
        frameMaxAbsExtent = Math.max(frameMaxAbsExtent, Math.abs(xMeters), Math.abs(upMeters));
      }
    }
  }
  if (!hasFrameMask) {
    frameMinX = -maxAbsExtent;
    frameMaxX = maxAbsExtent;
    frameMinY = -maxAbsExtent;
    frameMaxY = maxAbsExtent;
    frameMaxAbsExtent = maxAbsExtent;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  if (cameraType === "perspective") {
    const fieldOfViewDeg = clamp(requested.fieldOfViewDeg ?? 35, 10, 100, 35);
    const tangent = Math.tan((fieldOfViewDeg * Math.PI) / 360);
    const cameraMargin = Math.max(1, frameMaxAbsExtent * 0.04, maxAbsDepth * 0.08);
    const cameraDistance = Math.max(
      maxAbsDepth + cameraMargin,
      frameMaxAbsExtent / Math.max(1e-6, tangent) + cameraMargin,
    ) * 1.08;
    const focalLength = cameraDistance / Math.max(1e-6, tangent);
    for (let index = 0; index < meshTotal; index++) {
      const distance = Math.max(1e-3, cameraDistance - depth[index]);
      x[index] *= focalLength / distance;
      y[index] *= focalLength / distance;
      inverseDistance![index] = 1 / distance;
      depth[index] = -distance;
      minX = Math.min(minX, x[index]);
      maxX = Math.max(maxX, x[index]);
      minY = Math.min(minY, y[index]);
      maxY = Math.max(maxY, y[index]);
    }
    if (hasFrameMask) {
      minX = Infinity;
      maxX = -Infinity;
      minY = Infinity;
      maxY = -Infinity;
      for (let index = 0; index < meshTotal; index++) {
        if ((requested.fitMask?.[index] ?? 0) <= 8) continue;
        minX = Math.min(minX, x[index]);
        maxX = Math.max(maxX, x[index]);
        minY = Math.min(minY, y[index]);
        maxY = Math.max(maxY, y[index]);
      }
    }
  } else if (hasFrameMask) {
    minX = frameMinX;
    maxX = frameMaxX;
    minY = frameMinY;
    maxY = frameMaxY;
  } else {
    for (let index = 0; index < meshTotal; index++) {
      minX = Math.min(minX, x[index]);
      maxX = Math.max(maxX, x[index]);
      minY = Math.min(minY, y[index]);
      maxY = Math.max(maxY, y[index]);
    }
  }
  const rangeX = Math.max(1e-6, maxX - minX);
  const rangeY = Math.max(1e-6, maxY - minY);
  const margin = Math.max(1, Math.min(width, fullHeight) * 0.015);
  const fitScale = Math.min(
    (width - margin * 2) / rangeX,
    (fullHeight - margin * 2) / rangeY,
  );
  const centreX = (minX + maxX) * 0.5;
  const centreY = (minY + maxY) * 0.5;
  for (let index = 0; index < meshTotal; index++) {
    x[index] = (x[index] - centreX) * fitScale + (width - 1) * 0.5;
    y[index] = (centreY - y[index]) * fitScale + (fullHeight - 1) * 0.5;
  }
  const meshBlockSize = 32;
  const meshBlockColumns = Math.max(1, Math.ceil(Math.max(1, meshWidth - 1) / meshBlockSize));
  const meshBlockRows = Math.max(1, Math.ceil(Math.max(1, meshHeight - 1) / meshBlockSize));
  const meshBlockCount = meshBlockColumns * meshBlockRows;
  const meshBlockMinX = new Float32Array(meshBlockCount);
  const meshBlockMaxX = new Float32Array(meshBlockCount);
  const meshBlockMinY = new Float32Array(meshBlockCount);
  const meshBlockMaxY = new Float32Array(meshBlockCount);
  meshBlockMinX.fill(Infinity);
  meshBlockMinY.fill(Infinity);
  meshBlockMaxX.fill(-Infinity);
  meshBlockMaxY.fill(-Infinity);
  for (let blockY = 0; blockY < meshBlockRows; blockY++) {
    const firstMeshY = blockY * meshBlockSize;
    const lastMeshY = Math.min(meshHeight - 2, (blockY + 1) * meshBlockSize - 1);
    for (let blockX = 0; blockX < meshBlockColumns; blockX++) {
      const firstMeshX = blockX * meshBlockSize;
      const lastMeshX = Math.min(meshWidth - 2, (blockX + 1) * meshBlockSize - 1);
      const block = blockY * meshBlockColumns + blockX;
      for (let meshY = firstMeshY; meshY <= lastMeshY; meshY++) {
        for (let meshX = firstMeshX; meshX <= lastMeshX; meshX++) {
          const topLeft = meshY * meshWidth + meshX;
          const topRight = topLeft + 1;
          const bottomLeft = topLeft + meshWidth;
          const bottomRight = bottomLeft + 1;
          meshBlockMinX[block] = Math.min(
            meshBlockMinX[block], x[topLeft], x[topRight], x[bottomLeft], x[bottomRight],
          );
          meshBlockMaxX[block] = Math.max(
            meshBlockMaxX[block], x[topLeft], x[topRight], x[bottomLeft], x[bottomRight],
          );
          meshBlockMinY[block] = Math.min(
            meshBlockMinY[block], y[topLeft], y[topRight], y[bottomLeft], y[bottomRight],
          );
          meshBlockMaxY[block] = Math.max(
            meshBlockMaxY[block], y[topLeft], y[topRight], y[bottomLeft], y[bottomRight],
          );
        }
      }
    }
  }
  return {
    width,
    fullHeight,
    meshWidth,
    meshHeight,
    cameraType,
    dxMeters,
    dyMeters,
    x,
    y,
    depth,
    inverseDistance,
    meshBlockSize,
    meshBlockColumns,
    meshBlockRows,
    meshBlockMinX,
    meshBlockMaxX,
    meshBlockMinY,
    meshBlockMaxY,
  };
}

/**
 * Reproject an already-composited terrain image through a fitted camera.
 * Every DEM cell is a surface sample, so the rasterizer resolves overlaps
 * with camera-space depth while carrying all existing ink, water, snow, and
 * prop passes through as one textured surface. Perspective uses the same
 * camera-space coordinates as the isolated mountain study and performs
 * perspective-correct texture interpolation.
 */
function renderFullTerrainCameraInternal(
  dem: MountainDEMData,
  source: ImageData | FullTerrainCameraTextureSource,
  requested: FullTerrainCameraSettings = {},
  captureTextureCoordinates = false,
): ImageData | FullTerrainCameraBandPlan {
  if (source.width < 2 || source.height < 2 || dem.width < 2 || dem.height < 2 ||
      dem.elevation.length < dem.width * dem.height) {
    if (!('sampleRGBA' in source)) return source;
    return makeImageData(source.width, source.height, new Uint8ClampedArray(source.width * source.height * 4));
  }
  const suppliedProjection = requested.projection;
  const width = Math.max(2, Math.floor(
    requested.outputWidth ?? suppliedProjection?.width ?? source.width,
  ));
  const fullHeight = Math.max(2, Math.floor(
    requested.outputHeight ?? suppliedProjection?.fullHeight ?? source.height,
  ));
  const rowStart = Math.max(0, Math.min(fullHeight - 1, Math.floor(requested.rowStart ?? 0)));
  const rowEnd = Math.max(rowStart + 1, Math.min(fullHeight, Math.floor(requested.rowEnd ?? fullHeight)));
  const height = rowEnd - rowStart;
  const colStart = Math.max(0, Math.min(width - 1, Math.floor(requested.colStart ?? 0)));
  const colEnd = Math.max(colStart + 1, Math.min(width, Math.floor(requested.colEnd ?? width)));
  const projection = suppliedProjection &&
      suppliedProjection.width === width &&
      suppliedProjection.fullHeight === fullHeight &&
      suppliedProjection.meshWidth === dem.width &&
      suppliedProjection.meshHeight === dem.height
    ? suppliedProjection
    : prepareFullTerrainCameraProjection(dem, {
        ...requested,
        outputWidth: width,
        outputHeight: fullHeight,
      });
  const meshWidth = projection.meshWidth;
  const meshHeight = projection.meshHeight;
  const cameraType = projection.cameraType;
  const dyMeters = projection.dyMeters;
  const total = width * height;
  const background = requested.background ?? DEFAULT_BACKGROUND;
  const perspective = cameraType === 'perspective';
  const foregroundSource = requested.foregroundSource;
  const foregroundSourceX = foregroundSource ? new Float64Array(total) : undefined;
  const foregroundSourceY = foregroundSource ? new Float64Array(total) : undefined;
  const foregroundSampleMask = foregroundSource ? new Uint8Array(total) : undefined;
  const output = new Uint8ClampedArray(total * 4);
  for (let index = 0; index < total; index++) {
    const offset = index * 4;
    output[offset] = background[0];
    output[offset + 1] = background[1];
    output[offset + 2] = background[2];
    output[offset + 3] = background[3];
  }
  const depthBuffer = new Float32Array(total).fill(-Infinity);
  const sourceXBuffer = captureTextureCoordinates ? new Float64Array(total) : undefined;
  const sourceYBuffer = captureTextureCoordinates ? new Float64Array(total) : undefined;
  const sampleMask = captureTextureCoordinates ? new Uint8Array(total) : undefined;

  const paintTriangle = (
    firstIndex: number,
    secondIndex: number,
    thirdIndex: number,
    firstSourceX: number,
    firstSourceY: number,
    secondSourceX: number,
    secondSourceY: number,
    thirdSourceX: number,
    thirdSourceY: number,
  ): void => {
    const firstX = projection.x[firstIndex];
    const firstY = projection.y[firstIndex];
    const firstDepth = projection.depth[firstIndex];
    const secondX = projection.x[secondIndex];
    const secondY = projection.y[secondIndex];
    const secondDepth = projection.depth[secondIndex];
    const thirdX = projection.x[thirdIndex];
    const thirdY = projection.y[thirdIndex];
    const thirdDepth = projection.depth[thirdIndex];
    const area = (secondX - firstX) * (thirdY - firstY)
      - (secondY - firstY) * (thirdX - firstX);
    if (Math.abs(area) <= 1e-7) return;
    const inverseArea = 1 / area;
    const minRasterX = Math.max(colStart, Math.floor(Math.min(firstX, secondX, thirdX)));
    const maxRasterX = Math.min(colEnd - 1, Math.ceil(Math.max(firstX, secondX, thirdX)));
    const minRasterY = Math.max(rowStart, Math.floor(Math.min(firstY, secondY, thirdY)));
    const maxRasterY = Math.min(rowEnd - 1, Math.ceil(Math.max(firstY, secondY, thirdY)));

    // Barycentric edge values are affine planes. Calculate their values at
    // the first pixel of each row and advance with additions across the row;
    // this removes three edge-function calls and three divisions per pixel.
    const edgeAX = secondY - thirdY;
    const edgeAY = thirdX - secondX;
    const edgeBX = thirdY - firstY;
    const edgeBY = firstX - thirdX;
    const edgeCX = firstY - secondY;
    const edgeCY = secondX - firstX;
    const edgeAConstant = secondX * thirdY - thirdX * secondY;
    const edgeBConstant = thirdX * firstY - firstX * thirdY;
    const edgeCConstant = firstX * secondY - secondX * firstY;
    const stepWeightAX = edgeAX * inverseArea;
    const stepWeightBX = edgeBX * inverseArea;
    const stepWeightCX = edgeCX * inverseArea;
    if (perspective) {
      const firstQ = projection.inverseDistance![firstIndex];
      const secondQ = projection.inverseDistance![secondIndex];
      const thirdQ = projection.inverseDistance![thirdIndex];
      for (let y = minRasterY; y <= maxRasterY; y++) {
        const startX = minRasterX + 0.5;
        const sampleY = y + 0.5;
        let weightA = (edgeAX * startX + edgeAY * sampleY + edgeAConstant) * inverseArea;
        let weightB = (edgeBX * startX + edgeBY * sampleY + edgeBConstant) * inverseArea;
        let weightC = (edgeCX * startX + edgeCY * sampleY + edgeCConstant) * inverseArea;
        let affineSourceX = firstSourceX * weightA + secondSourceX * weightB + thirdSourceX * weightC;
        let affineSourceY = firstSourceY * weightA + secondSourceY * weightB + thirdSourceY * weightC;
        let affineDepth = firstDepth * weightA + secondDepth * weightB + thirdDepth * weightC;
        let q = firstQ * weightA + secondQ * weightB + thirdQ * weightC;
        let u = firstSourceX * firstQ * weightA + secondSourceX * secondQ * weightB + thirdSourceX * thirdQ * weightC;
        let v = firstSourceY * firstQ * weightA + secondSourceY * secondQ * weightB + thirdSourceY * thirdQ * weightC;
        let d = firstDepth * firstQ * weightA + secondDepth * secondQ * weightB + thirdDepth * thirdQ * weightC;
        const affineSourceStepX = firstSourceX * stepWeightAX + secondSourceX * stepWeightBX + thirdSourceX * stepWeightCX;
        const affineSourceStepY = firstSourceY * stepWeightAX + secondSourceY * stepWeightBX + thirdSourceY * stepWeightCX;
        const affineDepthStep = firstDepth * stepWeightAX + secondDepth * stepWeightBX + thirdDepth * stepWeightCX;
        const qStep = firstQ * stepWeightAX + secondQ * stepWeightBX + thirdQ * stepWeightCX;
        const uStep = firstSourceX * firstQ * stepWeightAX + secondSourceX * secondQ * stepWeightBX + thirdSourceX * thirdQ * stepWeightCX;
        const vStep = firstSourceY * firstQ * stepWeightAX + secondSourceY * secondQ * stepWeightBX + thirdSourceY * thirdQ * stepWeightCX;
        const dStep = firstDepth * firstQ * stepWeightAX + secondDepth * secondQ * stepWeightBX + thirdDepth * thirdQ * stepWeightCX;
        for (let x = minRasterX; x <= maxRasterX; x++) {
          if (weightA >= -1e-7 && weightB >= -1e-7 && weightC >= -1e-7) {
            const index = (y - rowStart) * width + x;
            let depth: number;
            let sourceX: number;
            let sourceY: number;
            if (q > 1e-8) {
              const inverseQ = 1 / q;
              depth = d * inverseQ;
              sourceX = u * inverseQ;
              sourceY = v * inverseQ;
            } else {
              depth = -Infinity;
              sourceX = 0;
              sourceY = 0;
            }
            if (depth >= depthBuffer[index]) {
              depthBuffer[index] = depth;
              if (foregroundSourceX && foregroundSourceY && foregroundSampleMask) {
                foregroundSampleMask[index] = 1;
                foregroundSourceX[index] = sourceX;
                foregroundSourceY[index] = sourceY;
              }
              if (sourceXBuffer && sourceYBuffer && sampleMask) {
                sampleMask[index] = 1;
                sourceXBuffer[index] = sourceX;
                sourceYBuffer[index] = sourceY;
              } else {
                sampleRGBAInto(source, sourceX, sourceY, output, index * 4);
              }
            }
          }
          weightA += stepWeightAX;
          weightB += stepWeightBX;
          weightC += stepWeightCX;
          affineSourceX += affineSourceStepX;
          affineSourceY += affineSourceStepY;
          affineDepth += affineDepthStep;
          q += qStep;
          u += uStep;
          v += vStep;
          d += dStep;
        }
      }
    } else {
      // Orthographic export is the default. Keep the same affine interpolation
      // arithmetic, while avoiding perspective-only q/u/v/d work per pixel.
      for (let y = minRasterY; y <= maxRasterY; y++) {
        const startX = minRasterX + 0.5;
        const sampleY = y + 0.5;
        let weightA = (edgeAX * startX + edgeAY * sampleY + edgeAConstant) * inverseArea;
        let weightB = (edgeBX * startX + edgeBY * sampleY + edgeBConstant) * inverseArea;
        let weightC = (edgeCX * startX + edgeCY * sampleY + edgeCConstant) * inverseArea;
        let affineSourceX = firstSourceX * weightA + secondSourceX * weightB + thirdSourceX * weightC;
        let affineSourceY = firstSourceY * weightA + secondSourceY * weightB + thirdSourceY * weightC;
        let affineDepth = firstDepth * weightA + secondDepth * weightB + thirdDepth * weightC;
        const affineSourceStepX = firstSourceX * stepWeightAX + secondSourceX * stepWeightBX + thirdSourceX * stepWeightCX;
        const affineSourceStepY = firstSourceY * stepWeightAX + secondSourceY * stepWeightBX + thirdSourceY * stepWeightCX;
        const affineDepthStep = firstDepth * stepWeightAX + secondDepth * stepWeightBX + thirdDepth * stepWeightCX;
        for (let x = minRasterX; x <= maxRasterX; x++) {
          if (weightA >= -1e-7 && weightB >= -1e-7 && weightC >= -1e-7) {
            const index = (y - rowStart) * width + x;
            if (affineDepth >= depthBuffer[index]) {
              depthBuffer[index] = affineDepth;
              if (foregroundSourceX && foregroundSourceY && foregroundSampleMask) {
                foregroundSampleMask[index] = 1;
                foregroundSourceX[index] = affineSourceX;
                foregroundSourceY[index] = affineSourceY;
              }
              if (sourceXBuffer && sourceYBuffer && sampleMask) {
                sampleMask[index] = 1;
                sourceXBuffer[index] = affineSourceX;
                sourceYBuffer[index] = affineSourceY;
              } else {
                sampleRGBAInto(source, affineSourceX, affineSourceY, output, index * 4);
              }
            }
          }
          weightA += stepWeightAX;
          weightB += stepWeightBX;
          weightC += stepWeightCX;
          affineSourceX += affineSourceStepX;
          affineSourceY += affineSourceStepY;
          affineDepth += affineDepthStep;
        }
      }
    }
    // Row starts are recomputed above from the edge equations. This bounds
    // accumulated floating-point drift on very wide 16K output rows.
  };

  const sourceScaleX = (source.width - 1) / Math.max(1, meshWidth - 1);
  const sourceScaleY = (source.height - 1) / Math.max(1, meshHeight - 1);
  const meshBlockSize = projection.meshBlockSize ?? Math.max(1, meshHeight - 1);
  const meshBlockColumns = projection.meshBlockColumns ?? 1;
  const meshBlockRows = projection.meshBlockRows ?? 1;
  const meshBlockMinX = projection.meshBlockMinX;
  const meshBlockMaxX = projection.meshBlockMaxX;
  const meshBlockMinY = projection.meshBlockMinY;
  const meshBlockMaxY = projection.meshBlockMaxY;
  const activeBlockColumns: number[][] = Array.from({ length: meshBlockRows }, () => []);
  for (let blockY = 0; blockY < meshBlockRows; blockY++) {
    for (let blockX = 0; blockX < meshBlockColumns; blockX++) {
      const block = blockY * meshBlockColumns + blockX;
      // Pixels sample at their centres, so the last row/column (centre at
      // end - 0.5) is still covered by a block starting just below `end`.
      const blockVisible = !meshBlockMinX || !meshBlockMaxX || !meshBlockMinY || !meshBlockMaxY
        || (meshBlockMaxX[block] >= 0 && meshBlockMinX[block] < width
          && meshBlockMaxY[block] >= rowStart && meshBlockMinY[block] < rowEnd);
      if (blockVisible) activeBlockColumns[blockY].push(blockX);
    }
  }
  // Iterate source rows first, then active 32x32 blocks in ascending X. This
  // retains the original triangle order, including equal-depth overwrite ties,
  // while avoiding cells whose projected block cannot touch this output band.
  for (let blockY = 0; blockY < meshBlockRows; blockY++) {
    const visibleColumns = activeBlockColumns[blockY];
    if (visibleColumns.length === 0) continue;
    const firstY = blockY * meshBlockSize;
    const lastY = Math.min(meshHeight - 2, (blockY + 1) * meshBlockSize - 1);
    for (let y = firstY; y <= lastY; y++) {
      for (const blockX of visibleColumns) {
      const firstX = blockX * meshBlockSize;
      const lastX = Math.min(meshWidth - 2, (blockX + 1) * meshBlockSize - 1);
      for (let x = firstX; x <= lastX; x++) {
        const topLeft = y * meshWidth + x;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + meshWidth;
        const bottomRight = bottomLeft + 1;
        const sourceX = x * sourceScaleX;
        const nextSourceX = (x + 1) * sourceScaleX;
        const sourceY = y * sourceScaleY;
        const nextSourceY = (y + 1) * sourceScaleY;
        paintTriangle(topLeft, topRight, bottomLeft,
          sourceX, sourceY,
          nextSourceX, sourceY,
          sourceX, nextSourceY);
        paintTriangle(topRight, bottomRight, bottomLeft,
          nextSourceX, sourceY,
          nextSourceX, nextSourceY,
          sourceX, nextSourceY);
      }
      }
    }
  }
  const finishBand = (): ImageData => {
  // Lift path points onto the very same triangles as the colored texture.
  // Homogeneous interpolation keeps perspective paths attached to the DEM.
  const projectPathPoint = (x: number, y: number): ProjectedRasterPoint => {
    x = Math.max(0, Math.min(meshWidth - 1, x));
    y = Math.max(0, Math.min(meshHeight - 1, y));
    const ix = Math.min(meshWidth - 2, Math.floor(x));
    const iy = Math.min(meshHeight - 2, Math.floor(y));
    const tx = x - ix, ty = y - iy;
    const tl = iy * meshWidth + ix;
    const ids = tx + ty <= 1 ? [tl, tl + 1, tl + meshWidth]
      : [tl + 1, tl + meshWidth + 1, tl + meshWidth];
    const weights = tx + ty <= 1 ? [1 - tx - ty, tx, ty] : [1 - ty, tx + ty - 1, 1 - tx];
    let distance = 0, px = 0, py = 0, depth = 0;
    for (let k = 0; k < 3; k++) {
      const id = ids[k];
      const w = weights[k];
      const q = cameraType === 'perspective' ? projection.inverseDistance![id] : 1;
      const homogeneousWeight = w / q;
      distance += homogeneousWeight;
      px += projection.x[id] * homogeneousWeight;
      py += projection.y[id] * homogeneousWeight;
      depth += projection.depth[id] * w;
    }
    return { x: px / distance, y: py / distance, depth,
      inverseDistance: cameraType === 'perspective' ? 1 / distance : 1 };
  };
  // Ridge widths are authored in source-mesh pixels. The camera fit already
  // maps those pixels to output pixels; applying the field-of-view tangent a
  // second time made the primary crest sub-pixel at ordinary export sizes.
  // Keep a source-to-output scale here and apply the minimum pen radius after
  // that mapping so the summit line remains continuous at every resolution.
  const inkScale = Math.min(width / meshWidth, fullHeight / meshHeight);
  const depthTolerance = cameraType === 'orthographic' ? 4 * dyMeters : 4;
  const ridgeScale = clamp(requested.ridgeThicknessScale ?? 0.75, 0.25, 2, 0.75);
  let prepared = preparedCameraRidges.get(projection);
  if (!prepared || prepared.paths !== requested.ridgePaths
    || prepared.color !== requested.ridgeColor
    || prepared.thicknessScale !== requested.ridgeThicknessScale
    || prepared.charcoal !== requested.charcoalRidges) {
    const bands = new Map<number, PreparedCameraRidgeSegment[]>();
    const thicknessAt = (x: number, y: number): number => 1 + Math.max(0, Math.min(1,
      (sampleScalarField(dem.elevation, meshWidth, meshHeight, x, y) - dem.minElevationM)
        / Math.max(1, dem.maxElevationM - dem.minElevationM)));
    let order = 0;
    for (const path of requested.ridgePaths ?? []) {
      if (path.kind !== 'ridge' || !path.primary) continue;
      const opacity = Math.max(0, Math.min(1, 0.82 * path.opacity * 0.9 * 1.18));
      const sourcePathLength = path.points.reduce((sum, point, index) => index === 0
        ? 0
        : sum + Math.hypot(point.x - path.points[index - 1].x, point.y - path.points[index - 1].y), 0);
      const charcoalInterruption = requested.charcoalRidges
        ? createCharcoalInterruptionPattern(path.key, 1, {
          breakProbability: 0.15, dashMin: 20, dashMax: 48, gapMin: 2.4, gapMax: 4.6,
        })
        : undefined;
      let sourceOffset = 0;
      for (let i = 1; i < path.points.length; i++) {
        const previous = path.points[i - 1], current = path.points[i];
        const sourceLength = Math.hypot(current.x - previous.x, current.y - previous.y);
        const subdivisions = Math.max(1, Math.ceil(sourceLength / 1.5));
        const segmentOffset = sourceOffset;
        for (let subdivision = 0; subdivision < subdivisions; subdivision++) {
          const startT = subdivision / subdivisions;
          const endT = (subdivision + 1) / subdivisions;
          const strokeStart = (segmentOffset + sourceLength * startT) * inkScale;
          const strokeEnd = (segmentOffset + sourceLength * endT) * inkScale;
          const midpoint = (strokeStart + strokeEnd) * 0.5;
          if (charcoalInterruption && !isCharcoalInkActiveAtDistance(midpoint, charcoalInterruption)) continue;
          const taper = requested.charcoalRidges
            ? Math.min(1, midpoint / Math.max(1, 14 * inkScale),
              (sourcePathLength * inkScale - midpoint) / Math.max(1, 14 * inkScale))
            : 1;
          if (taper <= 0) continue;
          const sourceA = {
            x: previous.x * (1 - startT) + current.x * startT,
            y: previous.y * (1 - startT) + current.y * startT,
          };
          const sourceB = {
            x: previous.x * (1 - endT) + current.x * endT,
            y: previous.y * (1 - endT) + current.y * endT,
          };
          const a = projectPathPoint(sourceA.x, sourceA.y);
          const b = projectPathPoint(sourceB.x, sourceB.y);
          const thickness = requested.charcoalRidges
            ? 1
            : (thicknessAt(sourceA.x, sourceA.y) + thicknessAt(sourceB.x, sourceB.y)) * 0.5;
          const baseRadius = path.width * 1.2 * ridgeScale * thickness * inkScale;
          const radius = requested.charcoalRidges
            ? Math.max(0.35 * inkScale,
              baseRadius * 1.4 * (0.85 + hash01(path.key + subdivision, 169) * 0.3) * taper)
            : Math.max(1.15, baseRadius);
          const segment = { a, b, radius, opacity, order: order++ };
          const minX = Math.min(a.x, b.x) - radius - 1;
          const maxX = Math.max(a.x, b.x) + radius + 1;
          if (maxX < 0 || minX >= width) continue;
          const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius - 1));
          const maxY = Math.min(fullHeight - 1, Math.ceil(Math.max(a.y, b.y) + radius + 1));
          for (let band = Math.floor(minY / CAMERA_RIDGE_BAND_HEIGHT);
            band <= Math.floor(maxY / CAMERA_RIDGE_BAND_HEIGHT); band++) {
            const bandSegments = bands.get(band);
            if (bandSegments) bandSegments.push(segment);
            else bands.set(band, [segment]);
          }
        }
        sourceOffset += sourceLength;
      }
    }
    prepared = {
      paths: requested.ridgePaths,
      color: requested.ridgeColor,
      thicknessScale: requested.ridgeThicknessScale,
      charcoal: requested.charcoalRidges,
      colorRgb: resolveRGB(requested.ridgeColor, MOUNTAIN_RIDGE_INK),
      bands,
    };
    preparedCameraRidges.set(projection, prepared);
  }
  const firstBand = Math.floor(rowStart / CAMERA_RIDGE_BAND_HEIGHT);
  const lastBand = Math.floor((rowEnd - 1) / CAMERA_RIDGE_BAND_HEIGHT);
  let ridgeSegments: PreparedCameraRidgeSegment[] = [];
  if (firstBand === lastBand) {
    ridgeSegments = prepared.bands.get(firstBand) ?? [];
  } else {
    const uniqueSegments = new Map<number, PreparedCameraRidgeSegment>();
    for (let band = firstBand; band <= lastBand; band++) {
      for (const segment of prepared.bands.get(band) ?? []) {
        uniqueSegments.set(segment.order, segment);
      }
    }
    ridgeSegments = [...uniqueSegments.values()].sort((a, b) => a.order - b.order);
  }
  for (const segment of ridgeSegments) {
    const { a, b } = segment;
    paintMountainCameraSegment(output, width, height, a, b, segment.radius,
      prepared.colorRgb, segment.opacity, (index, t) => {
        const depth = cameraType === 'perspective'
          ? -1 / (a.inverseDistance * (1 - t) + b.inverseDistance * t)
          : a.depth * (1 - t) + b.depth * t;
        return Number.isFinite(depthBuffer[index]) && depth >= depthBuffer[index] - depthTolerance;
      }, rowStart);
  }
  if (foregroundSource && foregroundSourceX && foregroundSourceY && foregroundSampleMask) {
    const foregroundPixels = new Uint8ClampedArray(total * 4);
    for (let index = 0; index < total; index++) {
      if (!foregroundSampleMask[index]) continue;
      sampleRGBAInto(
        foregroundSource,
        foregroundSourceX[index],
        foregroundSourceY[index],
        foregroundPixels,
        index * 4,
      );
      const offset = index * 4;
      const sourceAlpha = foregroundPixels[offset + 3] / 255;
      if (sourceAlpha <= 0) continue;
      const destinationAlpha = output[offset + 3] / 255;
      const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      if (outputAlpha <= 0) continue;
      output[offset] = Math.round(
        (foregroundPixels[offset] * sourceAlpha +
          output[offset] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
      );
      output[offset + 1] = Math.round(
        (foregroundPixels[offset + 1] * sourceAlpha +
          output[offset + 1] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
      );
      output[offset + 2] = Math.round(
        (foregroundPixels[offset + 2] * sourceAlpha +
          output[offset + 2] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
      );
      output[offset + 3] = Math.round(outputAlpha * 255);
    }
  }
  return makeImageData(width, height, output);
  };

  if (sourceXBuffer && sourceYBuffer && sampleMask) {
    return {
      width,
      height,
      rowStart,
      depthBuffer,
      sampleMask,
      sourceX: sourceXBuffer,
      sourceY: sourceYBuffer,
      finish(textureSource): ImageData {
        for (let index = 0; index < total; index++) {
          if (!sampleMask[index]) continue;
          sampleRGBAInto(
            textureSource,
            sourceXBuffer[index],
            sourceYBuffer[index],
            output,
            index * 4,
          );
        }
        return finishBand();
      },
    };
  }
  return finishBand();
}

export function renderFullTerrainCamera(
  dem: MountainDEMData,
  source: ImageData | FullTerrainCameraTextureSource,
  requested: FullTerrainCameraSettings = {},
): ImageData {
  return renderFullTerrainCameraInternal(dem, source, requested) as ImageData;
}

/** Resolves the camera's winning source sample for each band pixel without
 * reading texture color. Call `finish` after the required source tiles exist. */
export function prepareFullTerrainCameraBand(
  dem: MountainDEMData,
  rowStart: number,
  rowEnd: number,
  requested: FullTerrainCameraSettings = {},
): FullTerrainCameraBandPlan {
  const sourceWidth = Math.max(2, Math.floor(
    requested.outputWidth ?? requested.projection?.width ?? dem.width,
  ));
  const sourceHeight = Math.max(2, Math.floor(
    requested.outputHeight ?? requested.projection?.fullHeight ?? dem.height,
  ));
  const source: FullTerrainCameraTextureSource = {
    width: sourceWidth,
    height: sourceHeight,
    sampleRGBA(): void {},
  };
  return renderFullTerrainCameraInternal(dem, source, {
    ...requested,
    rowStart,
    rowEnd,
  }, true) as FullTerrainCameraBandPlan;
}

/** Lists every source tile touched by bilinear sampling in this band. */
export function getCameraBandTextureTileKeys(
  plan: FullTerrainCameraBandPlan,
  sourceWidth: number,
  sourceHeight: number,
  tileSize: number,
): string[] {
  const columns = Math.ceil(sourceWidth / tileSize);
  const rows = Math.ceil(sourceHeight / tileSize);
  const needed = new Uint8Array(columns * rows);
  const maxX = Math.max(0, sourceWidth - 1);
  const maxY = Math.max(0, sourceHeight - 1);
  for (let index = 0; index < plan.depthBuffer.length; index++) {
    if (!plan.sampleMask[index]) continue;
    const x = Math.max(0, Math.min(maxX, plan.sourceX[index]));
    const y = Math.max(0, Math.min(maxY, plan.sourceY[index]));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(maxX, x0 + 1);
    const y1 = Math.min(maxY, y0 + 1);
    const tileX0 = Math.floor(x0 / tileSize);
    const tileX1 = Math.floor(x1 / tileSize);
    const tileY0 = Math.floor(y0 / tileSize);
    const tileY1 = Math.floor(y1 / tileSize);
    needed[tileY0 * columns + tileX0] = 1;
    needed[tileY0 * columns + tileX1] = 1;
    needed[tileY1 * columns + tileX0] = 1;
    needed[tileY1 * columns + tileX1] = 1;
  }
  const keys: string[] = [];
  for (let index = 0; index < needed.length; index++) {
    if (!needed[index]) continue;
    const tileX = (index % columns) * tileSize;
    const tileY = Math.floor(index / columns) * tileSize;
    keys.push(`${tileX},${tileY}`);
  }
  return keys;
}

/** Processes only row regions whose complete bilinear texture footprint fits
 * the caller's cache budget. Oversized regions are rasterized as two smaller
 * regions, releasing the parent plan before either child is prepared. */
export async function processFullTerrainCameraBandWithinTextureBudget(
  dem: MountainDEMData,
  rowStart: number,
  rowEnd: number,
  requested: FullTerrainCameraSettings,
  tileSize: number,
  maximumWorkingSetBytes: number,
  processRegion: (
    plan: FullTerrainCameraBandPlan,
    tileKeys: readonly string[],
    workingSetBytes: number,
  ) => Promise<void>,
  prepareRegion: (
    start: number,
    end: number,
    settings: FullTerrainCameraSettings,
  ) => FullTerrainCameraBandPlan = (start, end, settings) =>
    prepareFullTerrainCameraBand(dem, start, end, settings),
): Promise<number> {
  const sourceWidth = Math.max(2, Math.floor(
    requested.outputWidth ?? requested.projection?.width ?? dem.width,
  ));
  const sourceHeight = Math.max(2, Math.floor(
    requested.outputHeight ?? requested.projection?.fullHeight ?? dem.height,
  ));
  const bytesForKeys = (keys: readonly string[]): number => {
    let bytes = 0;
    for (const key of keys) {
      const [tileX, tileY] = key.split(',').map(Number);
      bytes += Math.min(tileSize, sourceWidth - tileX)
        * Math.min(tileSize, sourceHeight - tileY) * 4;
    }
    return bytes;
  };
  const processRows = async (start: number, end: number): Promise<number> => {
    let plan: FullTerrainCameraBandPlan | undefined = prepareRegion(start, end, requested);
    const tileKeys = getCameraBandTextureTileKeys(plan, sourceWidth, sourceHeight, tileSize);
    const workingSetBytes = bytesForKeys(tileKeys);
    if (workingSetBytes <= maximumWorkingSetBytes) {
      await processRegion(plan, tileKeys, workingSetBytes);
      return 1;
    }
    if (end - start <= 1) {
      throw new Error("A single camera output row exceeds the texture cache budget");
    }
    // Drop the larger plan before preparing either child to bound retained
    // coordinate and depth buffers during recursive subdivision.
    plan = undefined;
    const middle = Math.floor((start + end) / 2);
    const first = await processRows(start, middle);
    const second = await processRows(middle, end);
    return first + second;
  };
  return processRows(rowStart, rowEnd);
}

/**
 * Renders one destination band with the same camera framing as a complete
 * image. The band uses a local color/depth buffer while projected coordinates
 * remain in the full output space, which lets export callers bound transient
 * memory. Pass a prepared projection when rendering many bands so camera
 * framing and mesh setup are performed once.
 */
export function renderFullTerrainCameraBand(
  dem: MountainDEMData,
  source: ImageData | FullTerrainCameraTextureSource,
  rowStart: number,
  rowEnd: number,
  requested: FullTerrainCameraSettings = {},
): ImageData {
  return renderFullTerrainCamera(dem, source, {
    ...requested,
    rowStart,
    rowEnd,
  });
}

/** Backwards-compatible entry point for the original orthographic study. */
export function renderFullTerrainOrthographicCamera(
  dem: MountainDEMData,
  source: ImageData,
  requested: FullTerrainOrthographicCameraSettings = {},
): ImageData {
  return renderFullTerrainCamera(dem, source, { ...requested, cameraType: 'orthographic' });
}

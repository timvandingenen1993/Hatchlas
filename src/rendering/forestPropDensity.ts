/**
 * Crown-overlap checks and canopy region geometry for placing forest props.
 */
import { hash01 } from "./cartographicStrokeRenderer";

export interface ForestPropPoint {
  x: number;
  y: number;
}

export interface ForestPropCrown {
  points: readonly ForestPropPoint[];
  placementIndex: number;
}

export interface ForestPropBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function padForestPropBounds(
  bounds: ForestPropBounds,
  padding: number,
): ForestPropBounds {
  const safePadding = Math.max(0, Number.isFinite(padding) ? padding : 0);
  return {
    minX: bounds.minX - safePadding,
    minY: bounds.minY - safePadding,
    maxX: bounds.maxX + safePadding,
    maxY: bounds.maxY + safePadding,
  };
}

/** Find exact pairwise box overlaps while limiting candidates with a spatial grid. */
export function findForestPropOverlapFlags(
  bounds: readonly (ForestPropBounds | null)[],
): boolean[] {
  const valid = bounds.filter((bound): bound is ForestPropBounds => bound !== null);
  if (valid.length < 2) return bounds.map(() => false);
  const averageCellSize = valid.reduce((total, bound) =>
    total + Math.max(bound.maxX - bound.minX, bound.maxY - bound.minY),
  0) / valid.length;
  const cellSize = Math.max(8, averageCellSize);
  const cells = new Map<string, number[]>();
  const cellRange = (bound: ForestPropBounds) => ({
    firstColumn: Math.floor(bound.minX / cellSize),
    lastColumn: Math.floor(bound.maxX / cellSize),
    firstRow: Math.floor(bound.minY / cellSize),
    lastRow: Math.floor(bound.maxY / cellSize),
  });
  for (let index = 0; index < bounds.length; index++) {
    const bound = bounds[index];
    if (!bound) continue;
    const range = cellRange(bound);
    for (let row = range.firstRow; row <= range.lastRow; row++) {
      for (let column = range.firstColumn; column <= range.lastColumn; column++) {
        const key = `${column},${row}`;
        const occupants = cells.get(key);
        if (occupants) occupants.push(index);
        else cells.set(key, [index]);
      }
    }
  }

  return bounds.map((bound, index) => {
    if (!bound) return false;
    const range = cellRange(bound);
    const candidates = new Set<number>();
    for (let row = range.firstRow; row <= range.lastRow; row++) {
      for (let column = range.firstColumn; column <= range.lastColumn; column++) {
        for (const candidate of cells.get(`${column},${row}`) ?? []) {
          if (candidate !== index) candidates.add(candidate);
        }
      }
    }
    for (const candidate of candidates) {
      const other = bounds[candidate];
      if (
        other &&
        bound.minX < other.maxX &&
        bound.maxX > other.minX &&
        bound.minY < other.maxY &&
        bound.maxY > other.minY
      ) return true;
    }
    return false;
  });
}

const GRID_STEP = 2;
const MIN_STAND_CROWNS = 5;
const MAX_STAND_COVERAGE_THRESHOLD = 0.48;
const MIN_STAND_COVERAGE_THRESHOLD = 0.24;

function polygonArea(points: readonly ForestPropPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += point.x * next.y - next.x * point.y;
  }
  return Math.abs(twiceArea) * 0.5;
}

function polygonCenter(points: readonly ForestPropPoint[]): ForestPropPoint {
  let twiceArea = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    const cross = point.x * next.y - next.x * point.y;
    twiceArea += cross;
    weightedX += (point.x + next.x) * cross;
    weightedY += (point.y + next.y) * cross;
  }
  if (Math.abs(twiceArea) < 1e-6) {
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    };
  }
  return {
    x: weightedX / (3 * twiceArea),
    y: weightedY / (3 * twiceArea),
  };
}

function rasterizeCrown(
  points: readonly ForestPropPoint[],
  field: Float32Array,
  width: number,
  height: number,
  originX: number,
  originY: number,
): void {
  if (points.length < 3) return;
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const firstRow = Math.max(0, Math.ceil((minY - originY) / GRID_STEP));
  const lastRow = Math.min(height - 1, Math.floor((maxY - originY) / GRID_STEP));
  for (let row = firstRow; row <= lastRow; row++) {
    const y = originY + row * GRID_STEP;
    const intersections: number[] = [];
    for (let index = 0; index < points.length; index++) {
      const start = points[index];
      const end = points[(index + 1) % points.length];
      if ((start.y > y) === (end.y > y)) continue;
      intersections.push(start.x + ((y - start.y) * (end.x - start.x)) / (end.y - start.y));
    }
    intersections.sort((left, right) => left - right);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const firstColumn = Math.max(0, Math.ceil((intersections[index] - originX) / GRID_STEP));
      const lastColumn = Math.min(width - 1, Math.floor((intersections[index + 1] - originX) / GRID_STEP));
      for (let column = firstColumn; column <= lastColumn; column++) {
        field[row * width + column] = 1;
      }
    }
  }
}

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let offset = -radius; offset <= radius; offset++) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    kernel[offset + radius] = weight;
    total += weight;
  }
  for (let index = 0; index < kernel.length; index++) kernel[index] /= total;
  return kernel;
}

function blurCoverage(
  source: Float32Array,
  width: number,
  height: number,
  kernel: Float32Array,
): Float32Array {
  const radius = (kernel.length - 1) >> 1;
  const horizontal = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const sampleX = x + offset;
        if (sampleX >= 0 && sampleX < width) value += source[row + sampleX] * kernel[offset + radius];
      }
      horizontal[row + x] = value;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const sampleY = y + offset;
        if (sampleY >= 0 && sampleY < height) value += horizontal[sampleY * width + x] * kernel[offset + radius];
      }
      result[y * width + x] = value;
    }
  }
  return result;
}

interface StandComponent {
  id: number;
  indices: number[];
}

function findStandComponents(
  coverage: Float32Array,
  width: number,
  height: number,
  coverageThreshold: number,
): { components: StandComponent[]; labels: Int32Array } {
  const labels = new Int32Array(coverage.length);
  const queue = new Int32Array(coverage.length);
  const components: StandComponent[] = [];
  let nextId = 1;
  for (let index = 0; index < coverage.length; index++) {
    if (coverage[index] < coverageThreshold || labels[index]) continue;
    const component = { id: nextId++, indices: [] as number[] };
    let head = 0;
    let tail = 0;
    queue[tail++] = index;
    labels[index] = component.id;
    while (head < tail) {
      const current = queue[head++];
      component.indices.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      const neighbors = [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || labels[neighbor] || coverage[neighbor] < coverageThreshold) continue;
        labels[neighbor] = component.id;
        queue[tail++] = neighbor;
      }
    }
    components.push(component);
  }
  return { components, labels };
}

function nearestStandSample(
  labels: Int32Array,
  width: number,
  height: number,
  point: ForestPropPoint,
  originX: number,
  originY: number,
  searchRadius: number,
): { id: number; index: number } {
  const column = Math.round((point.x - originX) / GRID_STEP);
  const row = Math.round((point.y - originY) / GRID_STEP);
  let id = 0;
  let index = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let offsetY = -searchRadius; offsetY <= searchRadius; offsetY++) {
    for (let offsetX = -searchRadius; offsetX <= searchRadius; offsetX++) {
      const sampleX = column + offsetX;
      const sampleY = row + offsetY;
      if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) continue;
      const sampleIndex = sampleY * width + sampleX;
      const distance = offsetX * offsetX + offsetY * offsetY;
      if (labels[sampleIndex] && distance < nearestDistance) {
        id = labels[sampleIndex];
        index = sampleIndex;
        nearestDistance = distance;
      }
    }
  }
  return { id, index };
}

function distanceFromStandEdge(labels: Int32Array, width: number, height: number): Float32Array {
  const distances = new Float32Array(labels.length);
  distances.fill(Number.POSITIVE_INFINITY);
  for (let index = 0; index < labels.length; index++) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (!labels[index]) {
      distances[index] = 0;
    } else if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      distances[index] = 1;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!labels[index]) continue;
      let distance = distances[index];
      if (x > 0) distance = Math.min(distance, distances[index - 1] + 1);
      if (y > 0) distance = Math.min(distance, distances[index - width] + 1);
      if (x > 0 && y > 0) {
        distance = Math.min(distance, distances[index - width - 1] + Math.SQRT2);
      }
      if (x + 1 < width && y > 0) {
        distance = Math.min(distance, distances[index - width + 1] + Math.SQRT2);
      }
      distances[index] = distance;
    }
  }
  for (let y = height - 2; y > 0; y--) {
    for (let x = width - 2; x > 0; x--) {
      const index = y * width + x;
      if (!labels[index]) continue;
      distances[index] = Math.min(
        distances[index],
        distances[index + 1] + 1,
        distances[index + width] + 1,
        distances[index + width - 1] + Math.SQRT2,
        distances[index + width + 1] + Math.SQRT2,
      );
    }
  }
  return distances;
}

export interface ForestPropStandGeometry {
  canopyPath: string;
  canopyRegions: ForestPropCanopyRegion[];
  interiorWeights: number[];
  regionIds: number[];
}

export interface ForestPropCanopyRegion {
  id: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  radius: number;
}

export const DEFAULT_FOREST_PROP_INK_REMOVAL_DEPTH = 0.36;

export function forestPropInkReductionStartDepth(
  centerDepthThreshold = DEFAULT_FOREST_PROP_INK_REMOVAL_DEPTH,
): number {
  return Math.max(0, Math.min(1, centerDepthThreshold)) * 0.1;
}

/** Fraction of ink segments retained as a prop moves into a canopy stand. */
export function forestPropInkRetentionAtDepth(
  interiorWeight: number,
  centerDepthThreshold = DEFAULT_FOREST_PROP_INK_REMOVAL_DEPTH,
): number {
  const depth = Math.max(0, Math.min(1, interiorWeight));
  const threshold = Math.max(0, Math.min(1, centerDepthThreshold));
  if (depth >= threshold) return 0;
  const reductionStartDepth = forestPropInkReductionStartDepth(threshold);
  const centerProgress = Math.max(
    0,
    (depth - reductionStartDepth) / (threshold - reductionStartDepth),
  );
  return 1 - centerProgress * centerProgress * (3 - 2 * centerProgress);
}

/** Omit whole ink runs, preserving the length and opacity of surviving marks. */
export function thinForestInkRuns(
  runs: readonly { start: number; end: number }[],
  retention: number,
  seed: number,
  centerDistances?: readonly number[],
): { start: number; end: number }[] {
  if (retention >= 1) return runs.map((run) => ({ ...run }));
  if (retention <= 0) return [];
  const keepCount = Math.ceil(runs.length * retention);
  const retainedIndexes = new Set(
    runs
      .map((_, index) => ({
        index,
        priority: centerDistances?.[index] ??
          hash01(seed ^ Math.imul(index + 1, 2246822519), 177),
      }))
      .sort((first, second) =>
        second.priority - first.priority || first.index - second.index,
      )
      .slice(0, keepCount)
      .map(({ index }) => index),
  );
  return runs
    .filter((_, index) => retainedIndexes.has(index))
    .map((run) => ({ ...run }));
}

interface CanopyBoundaryEdge {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  direction: number;
  used: boolean;
}

function smoothContourNoise(
  x: number,
  y: number,
  scale: number,
  seed: number,
): number {
  const gridX = x / scale;
  const gridY = y / scale;
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const fade = (value: number) => value * value * (3 - 2 * value);
  const tx = fade(gridX - x0);
  const ty = fade(gridY - y0);
  const sample = (column: number, row: number) =>
    hash01(
      Math.imul(column + 1, 374761393) ^ Math.imul(row + 1, 668265263),
      seed,
    ) * 2 - 1;
  const top = sample(x0, y0) * (1 - tx) + sample(x0 + 1, y0) * tx;
  const bottom = sample(x0, y0 + 1) * (1 - tx) + sample(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

function roundedContourPath(
  latticePoints: readonly ForestPropPoint[],
  originX: number,
  originY: number,
  seed: number,
  averageDiameter: number,
  edgeNoiseSize: number,
): string {
  const corners = latticePoints.filter((point, index) => {
    const previous = latticePoints[(index + latticePoints.length - 1) % latticePoints.length];
    const next = latticePoints[(index + 1) % latticePoints.length];
    const incomingX = point.x - previous.x;
    const incomingY = point.y - previous.y;
    const outgoingX = next.x - point.x;
    const outgoingY = next.y - point.y;
    return Math.abs(incomingX * outgoingY - incomingY * outgoingX) > 1e-6;
  });
  if (corners.length < 3) return "";

  const rawPoints = corners.map((point) => ({
    x: originX + (point.x - 0.5) * GRID_STEP,
    y: originY + (point.y - 0.5) * GRID_STEP,
  }));
  const points = rawPoints.map((point, index) => {
    const previous = rawPoints[(index + rawPoints.length - 1) % rawPoints.length];
    const next = rawPoints[(index + 1) % rawPoints.length];
    const tangentX = next.x - previous.x;
    const tangentY = next.y - previous.y;
    const tangentLength = Math.hypot(tangentX, tangentY) || 1;
    const normalX = -tangentY / tangentLength;
    const normalY = tangentX / tangentLength;
    const broadNoise = smoothContourNoise(
      point.x,
      point.y,
      Math.max(12, averageDiameter * 0.58) * edgeNoiseSize,
      seed + 31,
    );
    const fineNoise = smoothContourNoise(
      point.x,
      point.y,
      Math.max(7, averageDiameter * 0.28) * edgeNoiseSize,
      seed + 83,
    );
    const displacement =
      broadNoise * Math.min(2.6, averageDiameter * 0.065) +
      fineNoise * Math.min(0.8, averageDiameter * 0.02);
    return {
      x: point.x + normalX * displacement,
      y: point.y + normalY * displacement,
    };
  });
  const midpoint = (first: ForestPropPoint, second: ForestPropPoint) => ({
    x: (first.x + second.x) * 0.5,
    y: (first.y + second.y) * 0.5,
  });
  const format = (point: ForestPropPoint) =>
    `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  let path = `M${format(midpoint(points[points.length - 1], points[0]))}`;
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    path += ` Q${format(point)} ${format(midpoint(point, next))}`;
  }
  return `${path} Z`;
}

function signedContourArea(points: readonly ForestPropPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += point.x * next.y - next.x * point.y;
  }
  return twiceArea * 0.5 * GRID_STEP ** 2;
}

function buildCanopyPath(
  labels: Int32Array,
  width: number,
  height: number,
  originX: number,
  originY: number,
  minimumHoleArea: number,
  seed: number,
  averageDiameter: number,
  edgeNoiseSize: number,
): string {
  const edges: CanopyBoundaryEdge[] = [];
  const outgoingEdges = new Map<number, number[]>();
  const vertexWidth = width + 1;
  const addEdge = (
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    direction: number,
  ) => {
    const edgeIndex = edges.length;
    edges.push({ startX, startY, endX, endY, direction, used: false });
    const vertexIndex = startY * vertexWidth + startX;
    const edgeIndices = outgoingEdges.get(vertexIndex);
    if (edgeIndices) edgeIndices.push(edgeIndex);
    else outgoingEdges.set(vertexIndex, [edgeIndex]);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const label = labels[index];
      if (!label) continue;
      if (y === 0 || labels[index - width] !== label) addEdge(x, y, x + 1, y, 0);
      if (x + 1 === width || labels[index + 1] !== label) {
        addEdge(x + 1, y, x + 1, y + 1, 1);
      }
      if (y + 1 === height || labels[index + width] !== label) {
        addEdge(x + 1, y + 1, x, y + 1, 2);
      }
      if (x === 0 || labels[index - 1] !== label) addEdge(x, y + 1, x, y, 3);
    }
  }

  const turnPriority = [1, 0, 3, 2];
  const paths: string[] = [];
  for (let startIndex = 0; startIndex < edges.length; startIndex++) {
    const first = edges[startIndex];
    if (first.used) continue;
    const points: ForestPropPoint[] = [];
    let edgeIndex = startIndex;
    let closed = false;
    while (!edges[edgeIndex].used) {
      const edge = edges[edgeIndex];
      edge.used = true;
      points.push({ x: edge.startX, y: edge.startY });
      if (edge.endX === first.startX && edge.endY === first.startY) {
        closed = true;
        break;
      }
      const vertexIndex = edge.endY * vertexWidth + edge.endX;
      const candidates = (outgoingEdges.get(vertexIndex) ?? []).filter(
        (candidateIndex) => !edges[candidateIndex].used,
      );
      if (candidates.length === 0) break;
      candidates.sort((leftIndex, rightIndex) => {
        const leftTurn = (edges[leftIndex].direction - edge.direction + 4) % 4;
        const rightTurn = (edges[rightIndex].direction - edge.direction + 4) % 4;
        return turnPriority.indexOf(leftTurn) - turnPriority.indexOf(rightTurn);
      });
      edgeIndex = candidates[0];
    }
    if (closed && points.length >= 3) {
      const contourArea = signedContourArea(points);
      if (contourArea < 0 && Math.abs(contourArea) < minimumHoleArea) continue;
      const path = roundedContourPath(points, originX, originY, seed, averageDiameter, edgeNoiseSize);
      if (path) paths.push(path);
    }
  }
  return paths.join(" ");
}

function buildCanopyRegions(
  labels: Int32Array,
  width: number,
  originX: number,
  originY: number,
): ForestPropCanopyRegion[] {
  const boundsByLabel = new Map<number, {
    minColumn: number;
    maxColumn: number;
    minRow: number;
    maxRow: number;
  }>();
  for (let index = 0; index < labels.length; index++) {
    const id = labels[index];
    if (!id) continue;
    const column = index % width;
    const row = Math.floor(index / width);
    const bounds = boundsByLabel.get(id);
    if (bounds) {
      bounds.minColumn = Math.min(bounds.minColumn, column);
      bounds.maxColumn = Math.max(bounds.maxColumn, column);
      bounds.minRow = Math.min(bounds.minRow, row);
      bounds.maxRow = Math.max(bounds.maxRow, row);
    } else {
      boundsByLabel.set(id, {
        minColumn: column,
        maxColumn: column,
        minRow: row,
        maxRow: row,
      });
    }
  }
  return [...boundsByLabel.entries()].map(([id, bounds]) => {
    const left = originX + (bounds.minColumn - 0.5) * GRID_STEP;
    const right = originX + (bounds.maxColumn + 0.5) * GRID_STEP;
    const top = originY + (bounds.minRow - 0.5) * GRID_STEP;
    const bottom = originY + (bounds.maxRow + 0.5) * GRID_STEP;
    const regionWidth = right - left;
    const regionHeight = bottom - top;
    return {
      id,
      centerX: (left + right) * 0.5,
      centerY: (top + bottom) * 0.5,
      width: regionWidth,
      height: regionHeight,
      radius: Math.hypot(regionWidth, regionHeight) * 0.5,
    };
  });
}

/** Extracts qualifying canopy fills and per-prop weights rising toward each stand's center. */
export function buildForestPropStandGeometry(
  crowns: readonly ForestPropCrown[],
  width: number,
  height: number,
  canopyMerging = 65,
  canopySeed = 0,
  originX = -GRID_STEP,
  originY = -GRID_STEP,
  edgeNoiseSize = 1,
): ForestPropStandGeometry {
  let weightCount = crowns.length;
  for (const crown of crowns) weightCount = Math.max(weightCount, crown.placementIndex + 1);
  const weights = new Array<number>(weightCount).fill(0);
  const regionIds = new Array<number>(weightCount).fill(0);
  const emptyGeometry = {
    canopyPath: "",
    canopyRegions: [],
    interiorWeights: weights,
    regionIds,
  };
  if (canopyMerging <= 0) return emptyGeometry;
  const validCrowns = crowns.filter((crown) => crown.points.length >= 3);
  if (validCrowns.length < MIN_STAND_CROWNS) return emptyGeometry;

  const gridWidth = Math.ceil(width / GRID_STEP) + 3;
  const gridHeight = Math.ceil(height / GRID_STEP) + 3;
  const occupancy = new Float32Array(gridWidth * gridHeight);
  let totalArea = 0;
  let totalDiameter = 0;
  const centers = validCrowns.map((crown) => {
    rasterizeCrown(crown.points, occupancy, gridWidth, gridHeight, originX, originY);
    totalArea += polygonArea(crown.points);
    const minX = Math.min(...crown.points.map((point) => point.x));
    const maxX = Math.max(...crown.points.map((point) => point.x));
    const minY = Math.min(...crown.points.map((point) => point.y));
    const maxY = Math.max(...crown.points.map((point) => point.y));
    totalDiameter += ((maxX - minX) + (maxY - minY)) * 0.5;
    return polygonCenter(crown.points);
  });

  const averageArea = totalArea / validCrowns.length;
  const averageDiameter = totalDiameter / validCrowns.length;
  // Keep the fill edge close to the outer crown silhouettes. A broad blur
  // makes the canopy swell well past its edge props and erase small gaps.
  const sigma = Math.max(GRID_STEP * 0.8, averageDiameter * 0.16);
  const coverage = blurCoverage(
    occupancy,
    gridWidth,
    gridHeight,
    gaussianKernel(sigma / GRID_STEP),
  );
  const mergeStrength = Math.min(100, canopyMerging) / 100;
  const coverageThreshold =
    MAX_STAND_COVERAGE_THRESHOLD -
    mergeStrength * (MAX_STAND_COVERAGE_THRESHOLD - MIN_STAND_COVERAGE_THRESHOLD);
  const { components, labels } = findStandComponents(
    coverage,
    gridWidth,
    gridHeight,
    coverageThreshold,
  );
  const searchRadius = Math.ceil((sigma * 1.5) / GRID_STEP);
  const crownCounts = new Map<number, number>();
  for (const center of centers) {
    const { id } = nearestStandSample(labels, gridWidth, gridHeight, center, originX, originY, searchRadius);
    crownCounts.set(id, (crownCounts.get(id) ?? 0) + 1);
  }

  const activeLabels = new Int32Array(labels.length);
  const minimumArea = averageArea * 1.4;
  for (const component of components) {
    if ((crownCounts.get(component.id) ?? 0) < MIN_STAND_CROWNS) continue;
    if (component.indices.length * GRID_STEP ** 2 < minimumArea) continue;
    for (const index of component.indices) activeLabels[index] = component.id;
  }
  if (!activeLabels.some((label) => label !== 0)) return emptyGeometry;

  const canopyPath = buildCanopyPath(
    activeLabels,
    gridWidth,
    gridHeight,
    originX,
    originY,
    averageArea * 0.5,
    canopySeed,
    averageDiameter,
    edgeNoiseSize,
  );
  const canopyRegions = buildCanopyRegions(
    activeLabels,
    gridWidth,
    originX,
    originY,
  );
  const edgeDistances = distanceFromStandEdge(activeLabels, gridWidth, gridHeight);
  const centerSearchRadius = Math.ceil((averageDiameter * 0.9) / GRID_STEP);
  for (let index = 0; index < validCrowns.length; index++) {
    const crown = validCrowns[index];
    const sample = nearestStandSample(activeLabels, gridWidth, gridHeight, centers[index], originX, originY, centerSearchRadius);
    if (!sample.id || sample.index < 0) continue;
    regionIds[crown.placementIndex] = sample.id;
    weights[crown.placementIndex] = Math.max(
      0,
      Math.min(1, edgeDistances[sample.index] * GRID_STEP / (averageDiameter * 2.2)),
    );
  }
  return { canopyPath, canopyRegions, interiorWeights: weights, regionIds };
}

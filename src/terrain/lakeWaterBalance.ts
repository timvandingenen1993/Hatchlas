/**
 * Steady-state water balance for closed-basin lakes.
 *
 * Priority-flood fills every depression to its spill level and routes the
 * whole inflow across it. That is right for humid basins but cannot produce
 * a terminal (endorheic) lake: one whose surface evaporation consumes the
 * river inflow below the spill, so the river ends in it.
 *
 * Here each lake-sized depression gets a fill-spill-merge tree (Barnes,
 * Callaghan & Wickert 2021, "Computing water flow through complex
 * landscapes, Part 3: Fill-Spill-Merge", Earth Surf. Dynam.). Leaves are
 * pits; a node forms where two water bodies merge at a saddle. Instead of a
 * volume, each wet cell absorbs a steady flux: its open-water evaporation
 * minus the rain falling on it, plus the land runoff it no longer produces.
 * A lake rises until its wet area absorbs its inflow (the equilibrium lake
 * extent of Matsubara & Howard 2009, Water Resour. Res. 45) and spills to
 * its neighbour or out of the basin only when it reaches the saddle.
 */

const D8_OFFSETS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

export interface LakeBasins {
  width: number;
  height: number;
  /** Basin id per cell, or -1 outside every lake-sized depression. */
  basinOf: Int32Array;
  /** Cell outside the basin that receives its overflow, or -1. */
  spillCell: Int32Array;
  /** Basin cell next to the spill cell, where the overflow leaves. */
  exitCell: Int32Array;
  /** Flux that left each resolved basin over its rim. */
  basinOutflow: Float64Array;
  /** Cells of a basin not yet routed; the caller counts these down. */
  remaining: Int32Array;
  /** Basin cells grouped by basin: basinCells[basinStart[b] .. basinStart[b + 1]). */
  basinStart: Int32Array;
  basinCells: Int32Array;
  basinRoot: Int32Array;
  /** 1 once the basin has been resolved as a lake (inflow reached the river threshold). */
  basinIsLake: Uint8Array;
  /** Tree node that first took each basin cell into its water body. */
  owner: Int32Array;
  parent: Int32Array;
  childA: Int32Array;
  childB: Int32Array;
  /** Elevation at which a node's water spills (its parent's saddle, or the basin rim). */
  spillLevel: Float64Array;
  /** Saddle cell where a merge node's children join. */
  mergeCell: Int32Array;
  /** Cell on the sibling's side of the saddle that receives this node's overflow. */
  overflowCell: Int32Array;
  /** Cell on this node's own side of the saddle, where its overflow leaves. */
  sideCell: Int32Array;
  /** Flux each full node spills over its saddle (or, for a root, the rim). */
  outletFlux: Float64Array;
  /** A leaf reached by water arriving at the node's own cells. */
  entryLeaf: Int32Array;
  /** 1 where a cell's place in the fill order among equal-height cells is spatial. */
  flatOrdered: Uint8Array;
  /** Node own cells in fill order (ascending elevation): ownCells[ownStart[n] .. ownStart[n + 1]). */
  ownStart: Int32Array;
  ownCells: Int32Array;
  /** Running sum of own-cell absorption, aligned with ownCells. */
  ownPrefix: Float64Array;
  maxPrefix: Float64Array;
  ownTotal: Float64Array;
  full: Uint8Array;
  held: Float64Array;
  /** All flux that reached each node, whether it stayed or spilled on. */
  received: Float64Array;
  /** Water surface over each node's own cells once resolved, -Infinity when dry. */
  waterLevel: Float64Array;
  /** The node whose water body covers each node's own cells. */
  surfaceNode: Int32Array;
}

/**
 * Finds the lake-sized depressions of a priority-flood fill, points their
 * cells down the real (unfilled) surface toward the pits, and builds each
 * basin's merge tree. `flowDirection` is rewritten inside the basins: a pit
 * gets -1, and the caller routes the basin's overflow to `spillCell`.
 *
 * `absorption` is the flux in routed-area units that one wet cell removes
 * from the lake. Negative values (rain exceeds evaporation) make a cell add
 * water, so such a lake always spills.
 */
export function prepareLakeBasins(
  width: number,
  height: number,
  elevation: Float32Array,
  filledElevation: Float32Array,
  isOcean: Uint8Array,
  flowDirection: Int8Array,
  absorption: Float32Array,
  dxMeters: number,
  dyMeters: number,
  minWaterDepthM: number,
  minLakeCells: number,
  minLakeDepthM: number,
): LakeBasins {
  const totalCells = width * height;
  const basinOf = new Int32Array(totalCells).fill(-1);
  const inDepression = (i: number): boolean =>
    isOcean[i] === 0 && filledElevation[i] > elevation[i];

  // 1. Connected depressions; keep those large and deep enough to be lakes.
  const stack = new Int32Array(totalCells);
  const component = new Int32Array(totalCells);
  const seen = new Uint8Array(totalCells);
  const cells: number[] = [];
  const starts: number[] = [0];
  for (let start = 0; start < totalCells; start++) {
    if (seen[start] === 1 || !inDepression(start)) continue;
    seen[start] = 1;
    let top = 0;
    let count = 0;
    stack[top++] = start;
    let deepCells = 0;
    let maxDepth = 0;
    while (top > 0) {
      const idx = stack[--top];
      component[count++] = idx;
      const depth = filledElevation[idx] - elevation[idx];
      if (depth > minWaterDepthM) deepCells++;
      if (depth > maxDepth) maxDepth = depth;
      const x = idx % width;
      const y = (idx - x) / width;
      for (let d = 0; d < 8; d++) {
        const nx = x + D8_OFFSETS[d][0];
        const ny = y + D8_OFFSETS[d][1];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const n = ny * width + nx;
        if (seen[n] === 1 || !inDepression(n)) continue;
        seen[n] = 1;
        stack[top++] = n;
      }
    }
    if (deepCells < minLakeCells || maxDepth < minLakeDepthM) continue;
    const basin = starts.length - 1;
    for (let k = 0; k < count; k++) {
      basinOf[component[k]] = basin;
      cells.push(component[k]);
    }
    starts.push(cells.length);
  }
  const basinCount = starts.length - 1;
  const basinStart = Int32Array.from(starts);
  const basinCells = Int32Array.from(cells);

  // 2. The overflow leaves where the filled routing took the basin's deepest
  // cell. Quantized DEMs often have several rim cells at exactly the spill
  // height; this keeps the outlet the old routing chose for the lake. Cells
  // exactly at the spill height inside the lake are not basin cells, so the
  // path can leave and re-enter; the spill is its last exit, after which it
  // never returns. An earlier exit would wait on the basin it drains into.
  const spillCell = new Int32Array(basinCount).fill(-1);
  const exitCell = new Int32Array(basinCount).fill(-1);
  for (let b = 0; b < basinCount; b++) {
    let deepest = basinCells[basinStart[b]];
    for (let k = basinStart[b] + 1; k < basinStart[b + 1]; k++) {
      if (elevation[basinCells[k]] < elevation[deepest]) deepest = basinCells[k];
    }
    // The filled routing is acyclic, so the walk ends at an edge or sink.
    let c = deepest;
    for (let guard = 0; guard < totalCells; guard++) {
      const d = flowDirection[c];
      if (d < 0) break;
      const nx = (c % width) + D8_OFFSETS[d][0];
      const ny = Math.floor(c / width) + D8_OFFSETS[d][1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
      const next = ny * width + nx;
      if (basinOf[c] === b && basinOf[next] !== b) {
        spillCell[b] = next;
        exitCell[b] = c;
      }
      c = next;
    }
  }

  // 3. Flat floors. Equal-height cells have no downhill neighbour, and a
  // raster-index tie-break would wet a flat lake floor as a scan-line
  // stripe. Each flat is ordered outward from where its water collects: the
  // cells next to lower ground, or, for a flat basin floor, the cell farthest
  // from higher ground. Cells nearer their source come first, so a partly
  // wet flat is a round pool; breadth-first steps break ties and give each
  // cell the source it is reached from. The first step of a flat beside
  // lower ground is a shoreline ring around that ground and has no such
  // order; every other flat cell is `flatOrdered`.
  const flatStep = new Int32Array(totalCells);
  const flatDist2 = new Int32Array(totalCells);
  const flatOrdered = new Uint8Array(totalCells);
  const sourceOf = new Int32Array(totalCells).fill(-1);
  const flatSeen = new Uint8Array(totalCells);
  const queue = new Int32Array(totalCells);
  const flat: number[] = [];
  const touches = (c: number, lower: boolean): boolean => {
    const x = c % width;
    const y = (c - x) / width;
    for (let d = 0; d < 8; d++) {
      const nx = x + D8_OFFSETS[d][0];
      const ny = y + D8_OFFSETS[d][1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const n = ny * width + nx;
      if (lower ? basinOf[n] === basinOf[c] && elevation[n] < elevation[c] : elevation[n] > elevation[c]) {
        return true;
      }
    }
    return false;
  };
  // Breadth-first over the flat from queue[0 .. sources), each cell keeping
  // the source that reached it.
  const spread = (sources: number): void => {
    let tail = sources;
    for (let read = 0; read < tail; read++) {
      const c = queue[read];
      const s = sourceOf[c];
      const x = c % width;
      const y = (c - x) / width;
      for (let d = 0; d < 8; d++) {
        const nx = x + D8_OFFSETS[d][0];
        const ny = y + D8_OFFSETS[d][1];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const n = ny * width + nx;
        if (sourceOf[n] >= 0 || basinOf[n] !== basinOf[c] || elevation[n] !== elevation[c]) continue;
        sourceOf[n] = s;
        flatStep[n] = flatStep[c] + 1;
        const dx = nx - (s % width);
        const dy = ny - Math.floor(s / width);
        flatDist2[n] = dx * dx + dy * dy;
        queue[tail++] = n;
      }
    }
  };
  for (let k = 0; k < basinCells.length; k++) {
    const start = basinCells[k];
    if (flatSeen[start] === 1) continue;
    flatSeen[start] = 1;
    flat.length = 0;
    flat.push(start);
    for (let read = 0; read < flat.length; read++) {
      const c = flat[read];
      const x = c % width;
      const y = (c - x) / width;
      for (let d = 0; d < 8; d++) {
        const nx = x + D8_OFFSETS[d][0];
        const ny = y + D8_OFFSETS[d][1];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const n = ny * width + nx;
        if (flatSeen[n] === 1 || basinOf[n] !== basinOf[c] || elevation[n] !== elevation[c]) continue;
        flatSeen[n] = 1;
        flat.push(n);
      }
    }
    if (flat.length < 2) continue;
    let sources = 0;
    for (const c of flat) {
      if (!touches(c, true)) continue;
      sourceOf[c] = c;
      queue[sources++] = c;
    }
    if (sources > 0) {
      spread(sources);
      for (const c of flat) if (flatStep[c] > 0) flatOrdered[c] = 1;
      continue;
    }
    // A flat floor: find the cells farthest from higher ground and start
    // from the one nearest their middle.
    for (const c of flat) {
      if (!touches(c, false)) continue;
      sourceOf[c] = c;
      queue[sources++] = c;
    }
    if (sources === 0) {
      sourceOf[flat[0]] = flat[0];
      queue[sources++] = flat[0];
    }
    spread(sources);
    let maxStep = 0;
    for (const c of flat) maxStep = Math.max(maxStep, flatStep[c]);
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const c of flat) {
      if (flatStep[c] !== maxStep) continue;
      sumX += c % width;
      sumY += Math.floor(c / width);
      count++;
    }
    let seed = flat[0];
    let seedDist = Number.POSITIVE_INFINITY;
    for (const c of flat) {
      if (flatStep[c] !== maxStep) continue;
      const dist = ((c % width) - sumX / count) ** 2 + (Math.floor(c / width) - sumY / count) ** 2;
      if (dist < seedDist || (dist === seedDist && c < seed)) {
        seed = c;
        seedDist = dist;
      }
    }
    for (const c of flat) {
      sourceOf[c] = -1;
      flatStep[c] = 0;
      flatDist2[c] = 0;
      flatOrdered[c] = 1;
    }
    sourceOf[seed] = seed;
    queue[0] = seed;
    spread(1);
  }
  const sorted = basinCells
    .slice()
    .sort(
      (a, b) =>
        elevation[a] - elevation[b] ||
        flatDist2[a] - flatDist2[b] ||
        flatStep[a] - flatStep[b] ||
        a - b,
    );
  const rank = new Int32Array(totalCells);
  for (let k = 0; k < sorted.length; k++) rank[sorted[k]] = k;

  // 4. Inside a basin water runs down the real surface into the pits; on a
  // flat it follows the flat's order to where its water collects.
  const distances = D8_OFFSETS.map(([dx, dy]) => Math.hypot(dx * dxMeters, dy * dyMeters));
  for (let k = 0; k < basinCells.length; k++) {
    const idx = basinCells[k];
    const basin = basinOf[idx];
    const x = idx % width;
    const y = (idx - x) / width;
    let bestDir = -1;
    let bestSlope = 0;
    let bestRank = rank[idx];
    for (let d = 0; d < 8; d++) {
      const nx = x + D8_OFFSETS[d][0];
      const ny = y + D8_OFFSETS[d][1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const n = ny * width + nx;
      if (basinOf[n] !== basin) continue;
      const slope = (elevation[idx] - elevation[n]) / distances[d];
      if (slope > bestSlope) {
        bestSlope = slope;
        bestDir = d;
      } else if (bestSlope === 0 && slope === 0 && rank[n] < bestRank) {
        bestRank = rank[n];
        bestDir = d;
      }
    }
    flowDirection[idx] = bestDir;
  }

  // 5. Merge tree: add cells in that order, from the lowest up; a cell
  // touching two water bodies is their saddle. Three or more bodies merge
  // pairwise there.
  const owner = new Int32Array(totalCells).fill(-1);
  const unionParent = new Int32Array(totalCells).fill(-1);
  const topNode = new Int32Array(totalCells).fill(-1);
  const find = (i: number): number => {
    let root = i;
    while (unionParent[root] !== root) root = unionParent[root];
    while (unionParent[i] !== root) {
      const next = unionParent[i];
      unionParent[i] = root;
      i = next;
    }
    return root;
  };
  const parent: number[] = [];
  const childA: number[] = [];
  const childB: number[] = [];
  const spillLevel: number[] = [];
  const mergeCell: number[] = [];
  const overflowCell: number[] = [];
  const sideCell: number[] = [];
  const entryLeaf: number[] = [];
  const newNode = (a: number, b: number, cell: number): number => {
    const id = parent.length;
    parent.push(-1);
    childA.push(a);
    childB.push(b);
    spillLevel.push(Number.POSITIVE_INFINITY);
    mergeCell.push(cell);
    overflowCell.push(-1);
    sideCell.push(-1);
    entryLeaf.push(a < 0 ? id : entryLeaf[a]);
    return id;
  };
  const roots: number[] = [];
  const entries: number[] = [];
  for (let k = 0; k < sorted.length; k++) {
    const c = sorted[k];
    const basin = basinOf[c];
    const x = c % width;
    const y = (c - x) / width;
    roots.length = 0;
    entries.length = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + D8_OFFSETS[d][0];
      const ny = y + D8_OFFSETS[d][1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const n = ny * width + nx;
      if (basinOf[n] !== basin || unionParent[n] < 0) continue;
      const r = find(n);
      const at = roots.indexOf(r);
      if (at < 0) {
        roots.push(r);
        entries.push(n);
      } else if (elevation[n] < elevation[entries[at]]) {
        entries[at] = n;
      }
    }
    unionParent[c] = c;
    if (roots.length === 0) {
      const leaf = newNode(-1, -1, c);
      topNode[c] = leaf;
      owner[c] = leaf;
      continue;
    }
    let current = topNode[roots[0]];
    let currentEntry = entries[0];
    for (let i = 1; i < roots.length; i++) {
      const other = topNode[roots[i]];
      const merged = newNode(current, other, c);
      parent[current] = merged;
      parent[other] = merged;
      spillLevel[current] = elevation[c];
      spillLevel[other] = elevation[c];
      overflowCell[current] = entries[i];
      overflowCell[other] = currentEntry;
      sideCell[current] = currentEntry;
      sideCell[other] = entries[i];
      if (elevation[entries[i]] < elevation[currentEntry]) currentEntry = entries[i];
      current = merged;
    }
    for (const r of roots) unionParent[r] = c;
    topNode[c] = current;
    owner[c] = current;
  }
  const nodeCount = parent.length;
  const basinRoot = new Int32Array(basinCount).fill(-1);
  for (let b = 0; b < basinCount; b++) {
    if (basinStart[b + 1] === basinStart[b]) continue;
    const root = topNode[find(basinCells[basinStart[b]])];
    basinRoot[b] = root;
    spillLevel[root] = filledElevation[basinCells[basinStart[b]]];
  }

  // 6. Own cells per node in fill order, with absorption sums.
  const ownStart = new Int32Array(nodeCount + 1);
  for (const c of sorted) ownStart[owner[c] + 1]++;
  for (let n = 0; n < nodeCount; n++) ownStart[n + 1] += ownStart[n];
  const fill = ownStart.slice(0, nodeCount);
  const ownCells = new Int32Array(sorted.length);
  for (const c of sorted) ownCells[fill[owner[c]]++] = c;
  const ownPrefix = new Float64Array(sorted.length);
  const maxPrefix = new Float64Array(nodeCount).fill(Number.NEGATIVE_INFINITY);
  const ownTotal = new Float64Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) {
    let sum = 0;
    for (let k = ownStart[n]; k < ownStart[n + 1]; k++) {
      sum += absorption[ownCells[k]];
      ownPrefix[k] = sum;
      if (sum > maxPrefix[n]) maxPrefix[n] = sum;
    }
    ownTotal[n] = sum;
  }

  const remaining = new Int32Array(basinCount);
  for (let b = 0; b < basinCount; b++) remaining[b] = basinStart[b + 1] - basinStart[b];

  return {
    width,
    height,
    basinOf,
    spillCell,
    exitCell,
    basinOutflow: new Float64Array(basinCount),
    remaining,
    basinStart,
    basinCells,
    basinRoot,
    basinIsLake: new Uint8Array(basinCount),
    owner,
    parent: Int32Array.from(parent),
    childA: Int32Array.from(childA),
    childB: Int32Array.from(childB),
    spillLevel: Float64Array.from(spillLevel),
    mergeCell: Int32Array.from(mergeCell),
    overflowCell: Int32Array.from(overflowCell),
    sideCell: Int32Array.from(sideCell),
    outletFlux: new Float64Array(nodeCount),
    entryLeaf: Int32Array.from(entryLeaf),
    flatOrdered,
    ownStart,
    ownCells,
    ownPrefix,
    maxPrefix,
    ownTotal,
    full: new Uint8Array(nodeCount),
    held: new Float64Array(nodeCount),
    received: new Float64Array(nodeCount),
    waterLevel: new Float64Array(nodeCount).fill(Number.NEGATIVE_INFINITY),
    surfaceNode: new Int32Array(nodeCount).fill(-1),
  };
}

function directionTo(width: number, from: number, to: number): number {
  const dx = (to % width) - (from % width);
  const dy = Math.floor(to / width) - Math.floor(from / width);
  return D8_OFFSETS.findIndex(([ox, oy]) => ox === dx && oy === dy);
}

function receiverOf(width: number, flowDirection: Int8Array, idx: number): number {
  const d = flowDirection[idx];
  if (d < 0) return -1;
  return (
    (Math.floor(idx / width) + D8_OFFSETS[d][1]) * width +
    (idx % width) + D8_OFFSETS[d][0]
  );
}

/** Leaf whose water body a cell drains into along the real surface. */
function leafBelow(lakes: LakeBasins, flowDirection: Int8Array, cell: number): number {
  let c = cell;
  for (
    let next = receiverOf(lakes.width, flowDirection, c);
    next >= 0;
    next = receiverOf(lakes.width, flowDirection, c)
  ) {
    c = next;
  }
  return lakes.entryLeaf[lakes.owner[c]];
}

/**
 * Resolves one basin once all its cells are routed. Water routed into each
 * pit fills its water body; a full body spills over its saddle into the
 * neighbouring one, and two full neighbours rise together. Returns the flux
 * leaving over the basin rim. A basin too dry for a river to reach is no
 * lake and passes its water on unchanged.
 */
export function resolveLakeBasin(
  lakes: LakeBasins,
  basin: number,
  flowDirection: Int8Array,
  routedArea: Float32Array,
  riverThreshold: number,
): number {
  const start = lakes.basinStart[basin];
  const end = lakes.basinStart[basin + 1];
  const { full, held, received, parent, childA, childB, maxPrefix, ownTotal, outletFlux } = lakes;

  let total = 0;
  for (let k = start; k < end; k++) {
    const idx = lakes.basinCells[k];
    if (flowDirection[idx] < 0) total += routedArea[idx];
  }
  if (total < riverThreshold) {
    lakes.basinOutflow[basin] = total;
    return total;
  }
  lakes.basinIsLake[basin] = 1;

  let outflow = 0;
  const pour = (startNode: number, amount: number): void => {
    let n = startNode;
    let q = amount;
    // Each step either absorbs the water, fills a node, or hands the water
    // to a node that is not yet full, so the walk is bounded.
    for (;;) {
      received[n] += q;
      if (full[n] === 0) {
        const want = held[n] + q;
        if (maxPrefix[n] >= want) {
          held[n] = want;
          return;
        }
        full[n] = 1;
        q = Math.max(0, want - ownTotal[n]);
        held[n] = ownTotal[n];
      }
      const p = parent[n];
      if (p < 0) {
        outletFlux[n] += q;
        outflow += q;
        return;
      }
      const sibling = childA[p] === n ? childB[p] : childA[p];
      if (full[sibling] === 1) {
        n = p;
        continue;
      }
      outletFlux[n] += q;
      n = leafBelow(lakes, flowDirection, lakes.overflowCell[n]);
    }
  };

  for (let k = start; k < end; k++) {
    const idx = lakes.basinCells[k];
    if (flowDirection[idx] < 0) pour(lakes.entryLeaf[lakes.owner[idx]], routedArea[idx]);
  }
  lakes.basinOutflow[basin] = outflow;
  return outflow;
}

/**
 * Water depth per cell for every resolved lake, and the water surface over
 * each tree node. Sub-lakes below the depth floor are dropped, unless a
 * basin held below its rim needs them to show the water its balance wets
 * (drawn at the depth floor), and so are
 * pools smaller than `minLakeCells`, which are raster pits. In a basin held
 * below its rim, a pool is kept at any size once a river feeds it (at least
 * `riverThreshold` of flow reached its water body): on a noisy flat floor
 * the river's water spreads over a chain of such small pools. In a brim-full
 * basin they are only the deeper spots of one shallow lake.
 */
export function lakeDepthFromBasins(
  lakes: LakeBasins,
  elevation: Float32Array,
  minWaterDepthM: number,
  minLakeCells: number,
  riverThreshold: number,
): Float32Array {
  const { width, height } = lakes;
  const totalCells = width * height;
  const depth = new Float32Array(totalCells);
  const nodeCount = lakes.parent.length;
  const level = lakes.waterLevel;
  const surface = lakes.surfaceNode;
  // Own cells, from the first in fill order, that the balance wets and that
  // a basin held below its rim draws whatever their depth.
  const drawnCount = new Int32Array(nodeCount);
  // Parents are created after their children, so a descending pass visits
  // every parent first and passes its water body down.
  for (let n = nodeCount - 1; n >= 0; n--) {
    let own = Number.NEGATIVE_INFINITY;
    const s = lakes.ownStart[n];
    const e = lakes.ownStart[n + 1];
    if (lakes.full[n] === 1) {
      own = lakes.spillLevel[n];
      drawnCount[n] = e - s;
    } else if (lakes.held[n] > 0) {
      let k = s;
      while (k < e - 1 && lakes.ownPrefix[k] < lakes.held[n]) k++;
      const before = k > s ? lakes.ownPrefix[k - 1] : 0;
      const cellFlux = lakes.ownPrefix[k] - before;
      const fraction = cellFlux > 0 ? Math.min(1, Math.max(0, (lakes.held[n] - before) / cellFlux)) : 1;
      const low = elevation[lakes.ownCells[k]];
      const high = k + 1 < e ? elevation[lakes.ownCells[k + 1]] : lakes.spillLevel[n];
      own = low + fraction * (high - low);
      // A band of equal-height cells the water only partly covers is its
      // shoreline. It is drawn by fill order only where that order is
      // spatial; otherwise the depth floor decides.
      let wetEnd = k + (fraction >= 0.5 ? 1 : 0);
      if (wetEnd > s && wetEnd < e) {
        const last = lakes.ownCells[wetEnd - 1];
        const z = elevation[last];
        if (elevation[lakes.ownCells[wetEnd]] === z && lakes.flatOrdered[last] === 0) {
          while (wetEnd > s && elevation[lakes.ownCells[wetEnd - 1]] === z) wetEnd--;
        }
      }
      drawnCount[n] = wetEnd - s;
    }
    const p = lakes.parent[n];
    if (p >= 0 && level[p] >= own) {
      level[n] = level[p];
      surface[n] = surface[p];
    } else {
      level[n] = own;
      surface[n] = n;
    }
  }

  const wet = new Uint8Array(totalCells);
  for (let b = 0; b < lakes.basinRoot.length; b++) {
    if (lakes.basinIsLake[b] === 0) continue;
    for (let k = lakes.basinStart[b]; k < lakes.basinStart[b + 1]; k++) {
      const idx = lakes.basinCells[k];
      if (level[lakes.owner[idx]] - elevation[idx] > minWaterDepthM) wet[idx] = 1;
    }
  }
  // A basin held below its rim also draws every cell its balance wets: on a
  // flat or nearly flat floor that water is shallower than the depth floor,
  // yet its evaporation is what ends the river. In a brim-full basin the
  // shallow margins are only where one lake thins out over its shore.
  for (let n = 0; n < nodeCount; n++) {
    if (drawnCount[n] === 0) continue;
    const s = lakes.ownStart[n];
    const b = lakes.basinOf[lakes.ownCells[s]];
    if (lakes.basinIsLake[b] === 0 || lakes.full[lakes.basinRoot[b]] === 1) continue;
    for (let k = s; k < s + drawnCount[n]; k++) wet[lakes.ownCells[k]] = 1;
  }

  const visited = new Uint8Array(totalCells);
  const patch = new Int32Array(totalCells);
  for (let startCell = 0; startCell < totalCells; startCell++) {
    if (wet[startCell] === 0 || visited[startCell] === 1) continue;
    visited[startCell] = 1;
    patch[0] = startCell;
    let count = 1;
    let read = 0;
    let riverFed = false;
    while (read < count) {
      const idx = patch[read++];
      if (
        lakes.full[lakes.basinRoot[lakes.basinOf[idx]]] === 0 &&
        lakes.received[surface[lakes.owner[idx]]] >= riverThreshold
      )
        riverFed = true;
      const x = idx % width;
      const y = (idx - x) / width;
      for (let d = 0; d < 8; d++) {
        const nx = x + D8_OFFSETS[d][0];
        const ny = y + D8_OFFSETS[d][1];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const n = ny * width + nx;
        if (wet[n] === 0 || visited[n] === 1) continue;
        visited[n] = 1;
        patch[count++] = n;
      }
    }
    if (!riverFed && count < minLakeCells) continue;
    for (let k = 0; k < count; k++) {
      const idx = patch[k];
      depth[idx] = Math.max(minWaterDepthM, level[lakes.owner[idx]] - elevation[idx]);
    }
  }
  return depth;
}

/**
 * Sets the drawn flow field inside each basin once lake levels are known.
 * Dry cells keep draining down the real surface, and water in a terminal
 * lake ends there. Water in a full lake runs through it, as one channel, to
 * the lake's outlet: the spill cell for a basin, the saddle for a sub-lake
 * spilling into its neighbour. Shallow margins too thin to draw as lake
 * thereby still carry their river to the outlet. Flow is re-accumulated from
 * each cell's own runoff plus the water entering from outside the basin
 * (`ownInflow`, `ownCells`), and an outlet passes on only the flux left
 * after evaporation.
 */
export function routeLakeBasins(
  lakes: LakeBasins,
  elevation: Float32Array,
  flowDirection: Int8Array,
  ownInflow: Float32Array,
  ownCells: Float32Array,
  routedArea: Float32Array,
  discharge: Float32Array,
  flowAccumulation: Float32Array,
  dischargePerArea: number,
): void {
  const { width, height } = lakes;
  const totalCells = width * height;
  const reached = new Uint8Array(totalCells);
  const outletOf = new Int32Array(totalCells).fill(-1);
  const pending = new Int32Array(totalCells);
  const queue: number[] = [];
  const bodies: number[] = [];

  for (let b = 0; b < lakes.basinRoot.length; b++) {
    const start = lakes.basinStart[b];
    const end = lakes.basinStart[b + 1];
    const root = lakes.basinRoot[b];
    const isLake = lakes.basinIsLake[b] === 1;
    // A basin that is no lake is treated as brim-full: its water crosses it.
    const bodyOf = (c: number): number => {
      if (!isLake) return root;
      const node = lakes.owner[c];
      return lakes.waterLevel[node] > elevation[c] ? lakes.surfaceNode[node] : -1;
    };

    bodies.length = 0;
    for (let k = start; k < end; k++) {
      const body = bodyOf(lakes.basinCells[k]);
      if (body >= 0 && (!isLake || lakes.full[body] === 1) && !bodies.includes(body)) {
        bodies.push(body);
      }
    }

    for (const body of bodies) {
      const isRoot = body === root;
      const outletStart = isRoot ? lakes.exitCell[b] : lakes.sideCell[body];
      const outletTarget = isRoot ? lakes.spillCell[b] : lakes.mergeCell[lakes.parent[body]];
      if (outletStart < 0 || outletTarget < 0) continue;
      queue.length = 0;
      queue.push(outletStart);
      reached[outletStart] = 1;
      for (let read = 0; read < queue.length; read++) {
        const idx = queue[read];
        const x = idx % width;
        const y = (idx - x) / width;
        for (let d = 0; d < 8; d++) {
          const nx = x + D8_OFFSETS[d][0];
          const ny = y + D8_OFFSETS[d][1];
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const n = ny * width + nx;
          if (reached[n] === 1 || lakes.basinOf[n] !== b || bodyOf(n) !== body) continue;
          reached[n] = 1;
          flowDirection[n] = directionTo(width, n, idx);
          queue.push(n);
        }
      }
      for (const idx of queue) reached[idx] = 0;
      if (outletStart !== outletTarget) {
        flowDirection[outletStart] = directionTo(width, outletStart, outletTarget);
      }
      outletOf[outletStart] = body;
      if (!isRoot) {
        flowDirection[outletTarget] = directionTo(width, outletTarget, lakes.overflowCell[body]);
      }
    }

    // Re-accumulate inside the basin along the drawn field.
    for (let k = start; k < end; k++) {
      const idx = lakes.basinCells[k];
      routedArea[idx] = ownInflow[idx];
      flowAccumulation[idx] = ownCells[idx];
    }
    for (let k = start; k < end; k++) {
      const next = receiverOf(width, flowDirection, lakes.basinCells[k]);
      if (next >= 0 && lakes.basinOf[next] === b) pending[next]++;
    }
    queue.length = 0;
    for (let k = start; k < end; k++) {
      if (pending[lakes.basinCells[k]] === 0) queue.push(lakes.basinCells[k]);
    }
    for (let read = 0; read < queue.length; read++) {
      const idx = queue[read];
      const body = outletOf[idx];
      if (body >= 0) {
        routedArea[idx] = isLake ? lakes.outletFlux[body] : lakes.basinOutflow[b];
      }
      discharge[idx] = routedArea[idx] * dischargePerArea;
      const next = receiverOf(width, flowDirection, idx);
      if (next < 0 || lakes.basinOf[next] !== b) continue;
      routedArea[next] += routedArea[idx];
      flowAccumulation[next] += flowAccumulation[idx];
      if (--pending[next] === 0) queue.push(next);
    }
    // Loop guard: a cell still pending sits on a cycle; end its flow there.
    for (let k = start; k < end; k++) {
      const idx = lakes.basinCells[k];
      if (pending[idx] > 0) {
        flowDirection[idx] = -1;
        pending[idx] = 0;
      }
      outletOf[idx] = -1;
    }
  }
}

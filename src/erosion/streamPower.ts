/**
 * Stream-power river incision, plus glacial incision, on the cubed-sphere grid.
 */
import { cellCenterDistanceMeters, type CubedSphereGrid } from '../geometry/cubedSphere';
import type { SimulationConfig } from '../types/config';

export interface StreamPowerResult {
  erodedVolumeM3: number;
  upliftedVolumeM3: number;
  erodedDepth: Float32Array;
  upliftedDepth: Float32Array;
}

/**
 * O(N) implicit n=1 stream-power step from Cordonnier et al. (2016), Eq. 2.
 *
 *   c = K sqrt(A) dt / L
 *   z_i(t+dt) = (z_i(t) + U_i dt + c z_j(t+dt)) / (1+c)
 *
 * The receiver graph is supplied in source-to-mouth topological order, so it
 * is traversed backwards and every receiver has already been updated. Unlike
 * the former heuristic, this contains no per-step incision or height cap.
 */
export function applyStreamPowerIncision(
  grid: CubedSphereGrid,
  elevation: Float32Array,
  drainageAreaM2: Float64Array,
  flowReceivers: Int32Array,
  topologicalOrder: Int32Array,
  rockHardness: Float32Array,
  tectonicUpliftRateMmYr: Float32Array,
  isostaticBaseElevation: Float32Array,
  config: SimulationConfig,
  dtMyr = 0.25,
): StreamPowerResult {
  const dtYears = Math.max(0, dtMyr) * 1_000_000;
  const erodedDepth = new Float32Array(grid.totalCells);
  const upliftedDepth = new Float32Array(grid.totalCells);
  let erodedVolumeM3 = 0;
  let upliftedVolumeM3 = 0;

  if (dtYears === 0) return { erodedVolumeM3, upliftedVolumeM3, erodedDepth, upliftedDepth };

  for (let orderIndex = topologicalOrder.length - 1; orderIndex >= 0; orderIndex--) {
    const idx = topologicalOrder[orderIndex];
    const oldElevation = elevation[idx];
    if (oldElevation <= 0) continue;

    const uplift = Math.max(0, tectonicUpliftRateMmYr[idx]) * 1e-3 * dtYears;
    upliftedDepth[idx] = uplift;
    upliftedVolumeM3 += uplift * grid.cellAreas[idx];
    const baseElevation = isostaticBaseElevation[idx];
    const oldRelief = Math.max(0, oldElevation - baseElevation);
    const elevatedRelief = oldRelief + uplift;
    const elevatedSurface = baseElevation + elevatedRelief;
    const receiver = flowReceivers[idx];

    const areaM2 = Math.max(0, drainageAreaM2[idx]);
    // Cordonnier receiver roots are fixed at base level. Coastal receivers and
    // terminal land sinks use a virtual zero-relief root one local cell away.
    const receiverIsLand = receiver >= 0 && elevation[receiver] > 0;
    const linkLengthM = receiver >= 0
      ? Math.max(1, cellCenterDistanceMeters(grid, idx, receiver))
      : Math.max(1, Math.sqrt(grid.cellAreas[idx]));
    const hardness = Math.max(0.2, rockHardness[idx]);
    const KPerYear = 5.61e-7 * Math.max(0, config.fluvialErosionRate) / hardness;
    const c = KPerYear * Math.sqrt(areaM2) * dtYears / linkLengthM;
    const receiverRelief = receiverIsLand
      ? Math.max(0, elevation[receiver] - isostaticBaseElevation[receiver])
      : 0;
    const nextRelief = (elevatedRelief + c * receiverRelief) / (1 + c);
    const nextElevation = baseElevation + nextRelief;
    elevation[idx] = nextElevation;

    const erosion = Math.max(0, elevatedSurface - nextElevation);
    erodedDepth[idx] = erosion;
    erodedVolumeM3 += erosion * grid.cellAreas[idx];
  }

  return { erodedVolumeM3, upliftedVolumeM3, erodedDepth, upliftedDepth };
}

/**
 * Climate-dependent glacial incision remains a separate approximation so it
 * cannot alter the implicit fluvial solve or its mass accounting.
 */
export function applyGlacialIncision(
  grid: CubedSphereGrid,
  elevation: Float32Array,
  slopes: Float32Array,
  rockHardness: Float32Array,
  iceThickness: Float32Array,
  config: SimulationConfig,
  dtMyr = 0.25,
): { erodedVolumeM3: number; erodedDepth: Float32Array } {
  const erodedDepth = new Float32Array(grid.totalCells);
  const dtYears = Math.max(0, dtMyr) * 1_000_000;
  // Kept intentionally small because sliding velocity is not represented.
  const coefficientMPerYr = 2e-8 * Math.max(0, config.glacialErosionStrength);
  let erodedVolumeM3 = 0;
  for (let idx = 0; idx < grid.totalCells; idx++) {
    if (elevation[idx] <= 0 || iceThickness[idx] <= 5 || coefficientMPerYr === 0) continue;
    const hardness = Math.max(0.2, rockHardness[idx]);
    const erosion = coefficientMPerYr
      * Math.pow(iceThickness[idx] / 50, 1.3)
      * Math.max(0, slopes[idx])
      / hardness
      * dtYears;
    const actual = Math.min(Math.max(0, elevation[idx]), Math.max(0, erosion));
    elevation[idx] -= actual;
    erodedDepth[idx] = actual;
    erodedVolumeM3 += actual * grid.cellAreas[idx];
  }
  return { erodedVolumeM3, erodedDepth };
}

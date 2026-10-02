/**
 * Moves crust material between plates with a conservative streamfunction flux and CFL diagnostics.
 */
import { cross3, dot3, normalize3, type Vec3 } from '../../geometry/coordinates';
import { faceUVToCubeXYZ, type CubedSphereGrid } from '../../geometry/cubedSphere';
import type { PlateStateReservoirs, RigidEulerPlate } from './types';

export interface CFLMetrics {
  maxPlateSpeedMPerMyr: number;
  minCellDistanceM: number;
  maxDtCFLMyr: number;
  numSubsteps: number;
  dtMyr: number;
  targetTimeStepMyr: number;
  minimumActualTimeStepMyr: number;
  integratedDurationMyr: number;
}

export interface StepAreaLedger {
  openingAreaM2: number;
  convergenceAreaM2: number;
  ridgeAccretionAreaM2?: number;
  trenchConsumptionAreaM2?: number;
  ownershipOpeningAreaM2?: number;
  ownershipConvergenceAreaM2?: number;
  openingByPlateM2?: Float64Array;
  convergenceByPlateM2?: Float64Array;
  /** Deprecated per-step diagnostic retained for API compatibility. The runner
   * now computes the meaningful initial-to-final change once. */
  plateAreaChangeM2?: Float64Array;
  topologyCorrectionAreaM2?: number;
  topologyFragmentsRemoved?: number;
  topologyPlatesReseeded?: number;
  continentalTransportedVolumeM3?: number;
  continentalRoutedVolumeM3?: number;
  continentalTopologyRoutedVolumeM3?: number;
  continentalLimitedVolumeM3?: number;
  continentalCorrectionVolumeM3?: number;
}

export interface RawTransportDiagnostics {
  rawMinOwnership: number;
  rawMaxClosureResidual: number;
  maxClosureCorrection: number;
  totalClosureCorrection: number;
  topologyCorrectionAreaM2: number;
  topologyFragmentsRemoved: number;
  topologyPlatesReseeded: number;
  rawMinContinentalVolumeM3: number;
  continentalCorrectionVolumeM3: number;
}

export interface TransportStepOptions {
  /** Verification hook: reverse traversal while retaining identical edge orientation. */
  reverseEdgeIteration?: boolean;
  /** Disable only for first-order donor-cell comparison tests. */
  highResolutionMaterial?: boolean;
}

interface TransportGeometry {
  edgeCount: number;
  cellA: Int32Array;
  cellB: Int32Array;
  edgeByCellDirection: Int32Array;
  edgeMidpoint: Float32Array;
  /** dot(omega, coefficient) is signed m2/Myr from A to B. */
  fluxCoefficient: Float64Array;
}

export interface OrientedTransportEdgeFlux {
  cellA: number;
  cellB: number;
  /** Signed physical area flux in m^2/Myr; positive is A to B. */
  signedAreaFluxM2PerMyr: number;
}

interface TransportWorkspace {
  requestedOutM2: Float64Array;
  deltaAreaM2: Float64Array;
  requestedIndex: Int32Array;
  deltaIndex: Int32Array;
  deltaTouched: Uint8Array;
  dirtyCell: Int32Array;
  cellTouched: Uint8Array;
  activePlateMask: Uint32Array;
  materialActiveIndex: Int32Array;
  materialActiveFlag: Uint8Array;
  materialActiveCount: number;
  materialActiveInitialized: boolean;
  deltaContinentalM3?: Float64Array;
  deltaOceanicM3?: Float64Array;
  deltaAgeMomentM3Myr?: Float64Array;
  deltaInheritedM3?: Float64Array;
  eventCell: Int32Array;
  eventFromPlate: Uint16Array;
  eventToPlate: Uint16Array;
  eventAreaM2: Float64Array;
  eventKind: Uint8Array;
  primaryPlateId: Uint16Array;
  componentRoot: Int32Array;
  componentSize: Int32Array;
  componentCounts: Int32Array;
  keepRoot: Int32Array;
  connectivityQueue: Int32Array;
  recipientByRoot: Int32Array;
  omegaX: Float64Array;
  omegaY: Float64Array;
  omegaZ: Float64Array;
  plateWeight: Float64Array;
  materialGradientX: Float32Array;
  materialGradientY: Float32Array;
  materialGradientZ: Float32Array;
  materialGradientReady: Uint8Array;
  materialCorrectionEdgePlate: Uint32Array;
  materialCorrectionValueM3: Float64Array;
}

interface ConnectivityAnalysis {
  labels: Uint16Array;
  componentRoot: Int32Array;
  componentSize: Int32Array;
  componentCounts: Int32Array;
  keepRoot: Int32Array;
}

const geometryCache = new WeakMap<CubedSphereGrid, TransportGeometry>();
const workspaceCache = new WeakMap<PlateStateReservoirs, TransportWorkspace>();

export function computeCFLMetrics(
  grid: CubedSphereGrid,
  plates: RigidEulerPlate[],
  totalDurationMyr: number,
  targetTimeStepMyr = 1,
): CFLMetrics {
  let maxAngularVelocity = 0;
  for (const plate of plates) {
    maxAngularVelocity = Math.max(maxAngularVelocity, Math.abs(plate.angularVelocityRadPerMyr));
  }
  const maxPlateSpeedMPerMyr = maxAngularVelocity * grid.radiusMeters;
  const minCellDistanceM = grid.minCellDistanceM
    || grid.radiusMeters * Math.PI / (2 * grid.resolution);
  const safeTarget = Number.isFinite(targetTimeStepMyr) && targetTimeStepMyr > 0
    ? targetTimeStepMyr
    : 1;
  const maxDtCFLMyr = maxPlateSpeedMPerMyr > 0
    ? 0.45 * minCellDistanceM / maxPlateSpeedMPerMyr
    : Number.POSITIVE_INFINITY;
  const effectiveTarget = Math.min(safeTarget, maxDtCFLMyr);
  const numSubsteps = Math.max(1, Math.ceil(totalDurationMyr / effectiveTarget));
  const finalStep = totalDurationMyr - effectiveTarget * (numSubsteps - 1);
  return {
    maxPlateSpeedMPerMyr,
    minCellDistanceM,
    maxDtCFLMyr,
    numSubsteps,
    dtMyr: effectiveTarget,
    targetTimeStepMyr: safeTarget,
    minimumActualTimeStepMyr: Math.min(effectiveTarget, finalStep),
    integratedDurationMyr: effectiveTarget * (numSubsteps - 1) + finalStep,
  };
}

function getCellCorners(
  face: number,
  i: number,
  j: number,
  resolution: number,
): [Vec3, Vec3, Vec3, Vec3] {
  const d = (Math.PI / 2) / resolution;
  const a0 = -Math.PI / 4 + i * d;
  const a1 = a0 + d;
  const b0 = -Math.PI / 4 + j * d;
  const b1 = b0 + d;
  return [
    normalize3(faceUVToCubeXYZ(face, Math.tan(a0), Math.tan(b0))),
    normalize3(faceUVToCubeXYZ(face, Math.tan(a1), Math.tan(b0))),
    normalize3(faceUVToCubeXYZ(face, Math.tan(a1), Math.tan(b1))),
    normalize3(faceUVToCubeXYZ(face, Math.tan(a0), Math.tan(b1))),
  ];
}

/** psi(x) = R2 Omega dot x for v = Omega cross x rigid spherical rotation. */
export function evaluatePlateStreamfunction(
  plate: RigidEulerPlate,
  x: Vec3,
  radiusMeters: number,
): number {
  return plate.angularVelocityRadPerMyr * radiusMeters * radiusMeters
    * dot3(plate.eulerPole, x);
}

/** Build the oriented shared-edge flux geometry once, not every substep. */
function getTransportGeometry(grid: CubedSphereGrid): TransportGeometry {
  const cached = geometryCache.get(grid);
  if (cached) return cached;

  const maxEdges = grid.totalCells * 2;
  const cellA = new Int32Array(maxEdges);
  const cellB = new Int32Array(maxEdges);
  const coefficient = new Float64Array(maxEdges * 3);
  const edgeMidpoint = new Float32Array(maxEdges * 3);
  const edgeByCellDirection = new Int32Array(grid.totalCells * 4);
  edgeByCellDirection.fill(-1);
  const n = grid.resolution;
  const cellsPerFace = n * n;
  const radiusSquared = grid.radiusMeters * grid.radiusMeters;
  let edgeCount = 0;

  for (let face = 0; face < 6; face++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = face * cellsPerFace + j * n + i;
        const corners = getCellCorners(face, i, j, n);
        const edges: [Vec3, Vec3][] = [
          [corners[3], corners[0]],
          [corners[1], corners[2]],
          [corners[0], corners[1]],
          [corners[2], corners[3]],
        ];
        for (let direction = 0; direction < 4; direction++) {
          const b = grid.neighbors[a * 4 + direction];
          if (b <= a) continue;
          if (edgeCount >= maxEdges) throw new Error('Invalid cubed-sphere edge count');
          const [v1, v2] = edges[direction];
          const normalOffset = (a * 4 + direction) * 3;
          const outwardNormal: Vec3 = [
            grid.edgeNormals[normalOffset],
            grid.edgeNormals[normalOffset + 1],
            grid.edgeNormals[normalOffset + 2],
          ];
          const midpoint = normalize3([v1[0] + v2[0], v1[1] + v2[1], v1[2] + v2[2]]);
          const tangent = normalize3([v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]]);
          const positiveTangent = normalize3(cross3(midpoint, outwardNormal));
          const orientation = dot3(tangent, positiveTangent) >= 0 ? 1 : -1;
          const scale = orientation * radiusSquared;
          const k = edgeCount * 3;
          cellA[edgeCount] = a;
          cellB[edgeCount] = b;
          edgeByCellDirection[a * 4 + direction] = edgeCount;
          for (let reverseDirection = 0; reverseDirection < 4; reverseDirection++) {
            if (grid.neighbors[b * 4 + reverseDirection] === a) {
              edgeByCellDirection[b * 4 + reverseDirection] = edgeCount;
              break;
            }
          }
          coefficient[k] = scale * (v2[0] - v1[0]);
          coefficient[k + 1] = scale * (v2[1] - v1[1]);
          coefficient[k + 2] = scale * (v2[2] - v1[2]);
          edgeMidpoint[k] = midpoint[0];
          edgeMidpoint[k + 1] = midpoint[1];
          edgeMidpoint[k + 2] = midpoint[2];
          edgeCount++;
        }
      }
    }
  }

  const geometry: TransportGeometry = {
    edgeCount,
    cellA: cellA.subarray(0, edgeCount),
    cellB: cellB.subarray(0, edgeCount),
    edgeByCellDirection,
    edgeMidpoint: edgeMidpoint.subarray(0, edgeCount * 3),
    fluxCoefficient: coefficient.subarray(0, edgeCount * 3),
  };
  geometryCache.set(grid, geometry);
  return geometry;
}

function getWorkspace(reservoirs: PlateStateReservoirs, edgeCount: number): TransportWorkspace {
  const valueCount = reservoirs.totalCells * reservoirs.plateCount;
  const cached = workspaceCache.get(reservoirs);
  if (cached && cached.requestedOutM2.length === valueCount
    && cached.eventCell.length >= edgeCount * 2
    && cached.primaryPlateId.length === reservoirs.totalCells
    && cached.componentCounts.length === reservoirs.plateCount) {
    cached.deltaContinentalM3?.fill(0);
    cached.deltaOceanicM3?.fill(0);
    cached.deltaAgeMomentM3Myr?.fill(0);
    cached.deltaInheritedM3?.fill(0);
    cached.materialGradientReady.fill(0);
    return cached;
  }
  const workspace: TransportWorkspace = {
    requestedOutM2: new Float64Array(valueCount),
    deltaAreaM2: new Float64Array(valueCount),
    requestedIndex: new Int32Array(valueCount),
    deltaIndex: new Int32Array(valueCount),
    deltaTouched: new Uint8Array(valueCount),
    dirtyCell: new Int32Array(reservoirs.totalCells),
    cellTouched: new Uint8Array(reservoirs.totalCells),
    activePlateMask: new Uint32Array(reservoirs.totalCells),
    materialActiveIndex: new Int32Array(valueCount),
    materialActiveFlag: new Uint8Array(valueCount),
    materialActiveCount: 0,
    materialActiveInitialized: false,
    eventCell: new Int32Array(edgeCount * 2),
    eventFromPlate: new Uint16Array(edgeCount * 2),
    eventToPlate: new Uint16Array(edgeCount * 2),
    eventAreaM2: new Float64Array(edgeCount * 2),
    eventKind: new Uint8Array(edgeCount * 2),
    primaryPlateId: new Uint16Array(reservoirs.totalCells),
    componentRoot: new Int32Array(reservoirs.totalCells),
    componentSize: new Int32Array(reservoirs.totalCells),
    componentCounts: new Int32Array(reservoirs.plateCount),
    keepRoot: new Int32Array(reservoirs.plateCount),
    connectivityQueue: new Int32Array(reservoirs.totalCells),
    recipientByRoot: new Int32Array(reservoirs.totalCells),
    omegaX: new Float64Array(reservoirs.plateCount),
    omegaY: new Float64Array(reservoirs.plateCount),
    omegaZ: new Float64Array(reservoirs.plateCount),
    plateWeight: new Float64Array(reservoirs.plateCount),
    materialGradientX: new Float32Array(valueCount),
    materialGradientY: new Float32Array(valueCount),
    materialGradientZ: new Float32Array(valueCount),
    materialGradientReady: new Uint8Array(valueCount),
    materialCorrectionEdgePlate: new Uint32Array(0),
    materialCorrectionValueM3: new Float64Array(0),
  };
  workspaceCache.set(reservoirs, workspace);
  return workspace;
}

function edgeFlux(
  x: number,
  y: number,
  z: number,
  geometry: TransportGeometry,
  edge: number,
): number {
  const k = edge * 3;
  return x * geometry.fluxCoefficient[k]
    + y * geometry.fluxCoefficient[k + 1]
    + z * geometry.fluxCoefficient[k + 2];
}

/** Exportable diagnostics for the exact oriented shared edges used by transport. */
export function getOrientedTransportEdgeFluxes(
  grid: CubedSphereGrid,
  plate: RigidEulerPlate,
): OrientedTransportEdgeFlux[] {
  const geometry = getTransportGeometry(grid);
  const omegaX = plate.eulerPole[0] * plate.angularVelocityRadPerMyr;
  const omegaY = plate.eulerPole[1] * plate.angularVelocityRadPerMyr;
  const omegaZ = plate.eulerPole[2] * plate.angularVelocityRadPerMyr;
  const edges = new Array<OrientedTransportEdgeFlux>(geometry.edgeCount);
  for (let edge = 0; edge < geometry.edgeCount; edge++) {
    edges[edge] = {
      cellA: geometry.cellA[edge],
      cellB: geometry.cellB[edge],
      signedAreaFluxM2PerMyr: edgeFlux(omegaX, omegaY, omegaZ, geometry, edge),
    };
  }
  return edges;
}

function analyzeConnectivity(
  grid: CubedSphereGrid,
  labels: Uint16Array,
  workspace: TransportWorkspace,
): ConnectivityAnalysis {
  const componentRoot = workspace.componentRoot;
  componentRoot.fill(-1);
  const componentSize = workspace.componentSize;
  componentSize.fill(0);
  const componentCounts = workspace.componentCounts;
  componentCounts.fill(0);
  const keepRoot = workspace.keepRoot;
  keepRoot.fill(-1);
  const queue = workspace.connectivityQueue;

  for (let start = 0; start < grid.totalCells; start++) {
    if (componentRoot[start] >= 0) continue;
    const plate = labels[start];
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    componentRoot[start] = start;
    while (head < tail) {
      const cell = queue[head++];
      for (let direction = 0; direction < 4; direction++) {
        const neighbor = grid.neighbors[cell * 4 + direction];
        if (componentRoot[neighbor] < 0 && labels[neighbor] === plate) {
          componentRoot[neighbor] = start;
          queue[tail++] = neighbor;
        }
      }
    }
    componentSize[start] = tail;
    componentCounts[plate]++;
    const kept = keepRoot[plate];
    if (kept < 0 || tail > componentSize[kept]) keepRoot[plate] = start;
  }
  return { labels, componentRoot, componentSize, componentCounts, keepRoot };
}

function moveOwnershipWithinCell(
  reservoirs: PlateStateReservoirs,
  cell: number,
  fromPlate: number,
  toPlate: number,
  requestedFraction: number,
): number {
  if (requestedFraction <= 0 || fromPlate === toPlate) return 0;
  const count = reservoirs.plateCount;
  const from = cell * count + fromPlate;
  const to = cell * count + toPlate;
  const available = reservoirs.plateAreaFraction[from];
  const moved = Math.min(requestedFraction, available);
  if (moved <= 0) return 0;
  const ratio = moved / available;
  reservoirs.plateAreaFraction[from] -= moved;
  reservoirs.plateAreaFraction[to] += moved;
  void ratio;
  return moved;
}

/**
 * Raster closure projection inspired by continuously closing plate polygons.
 * Flux transport can leave detached argmax islands even while fractions remain
 * conservative. Keep one connected dominant component per configured plate,
 * transfer satellite ownership to an adjacent plate, and ledger every change.
 */
function enforceConnectedDominantTopology(
  grid: CubedSphereGrid,
  plates: RigidEulerPlate[],
  reservoirs: PlateStateReservoirs,
  workspace: TransportWorkspace,
): { correctionAreaM2: number; fragmentsRemoved: number; platesReseeded: number; continentalRoutedVolumeM3: number } {
  const plateCount = reservoirs.plateCount;
  let correctionAreaM2 = 0;
  let fragmentsRemoved = 0;
  let platesReseeded = 0;
  let continentalRoutedVolumeM3 = 0;

  for (let round = 0; round <= plateCount; round++) {
    const labels = derivePrimaryPlateIds(
      grid.totalCells,
      plateCount,
      reservoirs.plateAreaFraction,
      workspace.primaryPlateId,
    );
    let analysis = analyzeConnectivity(grid, labels, workspace);
    let changed = false;

    // Retain the configured plate lifetime by re-anchoring a vanished label from
    // its strongest remaining fractional reservoir (or its original seed cell).
    for (let plate = 0; plate < plateCount; plate++) {
      if (analysis.componentCounts[plate] !== 0) continue;
      let anchor = -1;
      let bestFraction = -1;
      let bestDot = -Infinity;
      const seed = plates[plate]?.seedPosition ?? ([1, 0, 0] as Vec3);
      for (let cell = 0; cell < grid.totalCells; cell++) {
        const fraction = reservoirs.plateAreaFraction[cell * plateCount + plate];
        const k = cell * 3;
        const seedDot = grid.cellPositions[k] * seed[0]
          + grid.cellPositions[k + 1] * seed[1]
          + grid.cellPositions[k + 2] * seed[2];
        if (fraction > bestFraction || (fraction === bestFraction && seedDot > bestDot)) {
          anchor = cell;
          bestFraction = fraction;
          bestDot = seedDot;
        }
      }
      if (anchor < 0) continue;
      const donor = labels[anchor];
      const donorFraction = reservoirs.plateAreaFraction[anchor * plateCount + donor];
      const targetFraction = reservoirs.plateAreaFraction[anchor * plateCount + plate];
      const requested = Math.max(0, 0.5 * (donorFraction - targetFraction) + 1e-12);
      const moved = moveOwnershipWithinCell(reservoirs, anchor, donor, plate, requested);
      correctionAreaM2 += moved * grid.cellAreas[anchor];
      platesReseeded++;
      changed = true;
    }

    if (changed) {
      derivePrimaryPlateIds(
        grid.totalCells,
        plateCount,
        reservoirs.plateAreaFraction,
        labels,
      );
      analysis = analyzeConnectivity(grid, labels, workspace);
    }

    const recipientByRoot = workspace.recipientByRoot;
    recipientByRoot.fill(-1);
    for (let cell = 0; cell < grid.totalCells; cell++) {
      const plate = labels[cell];
      const root = analysis.componentRoot[cell];
      if (root === analysis.keepRoot[plate]) continue;
      for (let direction = 0; direction < 4; direction++) {
        const neighbor = grid.neighbors[cell * 4 + direction];
        const candidate = labels[neighbor];
        if (candidate === plate) continue;
        const current = recipientByRoot[root];
        const candidateWeight = plates[candidate]?.weight ?? 0;
        const currentWeight = current >= 0 ? (plates[current]?.weight ?? 0) : -Infinity;
        if (current < 0 || candidateWeight > currentWeight
          || (candidateWeight === currentWeight && candidate < current)) {
          recipientByRoot[root] = candidate;
        }
      }
    }

    for (let cell = 0; cell < grid.totalCells; cell++) {
      const plate = labels[cell];
      const root = analysis.componentRoot[cell];
      if (root === analysis.keepRoot[plate]) continue;
      const recipient = recipientByRoot[root];
      if (recipient < 0) continue;
      const fraction = reservoirs.plateAreaFraction[cell * plateCount + plate];
      const moved = moveOwnershipWithinCell(reservoirs, cell, plate, recipient, fraction);
      correctionAreaM2 += moved * grid.cellAreas[cell];
      changed = true;
    }
    for (let root = 0; root < grid.totalCells; root++) {
      if (recipientByRoot[root] >= 0) fragmentsRemoved++;
    }
    if (!changed) break;
  }
  return { correctionAreaM2, fragmentsRemoved, platesReseeded, continentalRoutedVolumeM3 };
}

/**
 * Conservative first-order flux-form transport.
 *
 * Every request is calculated from the immutable beginning-of-step state. One
 * donor-wide limiter scales all outgoing requests from a cell/plate reservoir;
 * shared-edge updates are then applied antisymmetrically. Local closure is a
 * property of the update and no dominant-owner partition repair is performed.
 */
export function stepConservativeTransport(
  grid: CubedSphereGrid,
  plates: RigidEulerPlate[],
  reservoirs: PlateStateReservoirs,
  dtMyr: number,
  stepLedger?: StepAreaLedger,
  options: TransportStepOptions = {},
): RawTransportDiagnostics {
  const totalCells = grid.totalCells;
  const plateCount = reservoirs.plateCount;
  const geometry = getTransportGeometry(grid);
  const workspace = getWorkspace(reservoirs, geometry.edgeCount);
  const requestedOut = workspace.requestedOutM2;
  const deltaArea = workspace.deltaAreaM2;

  const omegaX = workspace.omegaX;
  const omegaY = workspace.omegaY;
  const omegaZ = workspace.omegaZ;
  const plateWeight = workspace.plateWeight;
  omegaX.fill(0);
  omegaY.fill(0);
  omegaZ.fill(0);
  plateWeight.fill(0);
  let referenceX = 0;
  let referenceY = 0;
  let referenceZ = 0;
  for (const plate of plates) {
    if (!Number.isInteger(plate.id) || plate.id < 0 || plate.id >= plateCount) {
      throw new Error(`Plate id ${plate.id} is outside the dense reservoir layout`);
    }
    omegaX[plate.id] = plate.eulerPole[0] * plate.angularVelocityRadPerMyr;
    omegaY[plate.id] = plate.eulerPole[1] * plate.angularVelocityRadPerMyr;
    omegaZ[plate.id] = plate.eulerPole[2] * plate.angularVelocityRadPerMyr;
    plateWeight[plate.id] = plate.weight;
    referenceX += omegaX[plate.id] / plateCount;
    referenceY += omegaY[plate.id] / plateCount;
    referenceZ += omegaZ[plate.id] / plateCount;
  }

  const primary = derivePrimaryPlateIds(
    totalCells,
    plateCount,
    reservoirs.plateAreaFraction,
    workspace.primaryPlateId,
    workspace.activePlateMask,
  );
  const activePlateMask = workspace.activePlateMask;
  let requestedCount = 0;
  const addRequested = (index: number, amount: number) => {
    if (amount <= 0) return;
    if (requestedOut[index] === 0) workspace.requestedIndex[requestedCount++] = index;
    requestedOut[index] += amount;
  };
  const clearRequested = () => {
    for (let entry = 0; entry < requestedCount; entry++) {
      requestedOut[workspace.requestedIndex[entry]] = 0;
    }
    requestedCount = 0;
  };
  const limitDonorRequest = (
    index: number,
    available: number,
    requested: number,
    recordContinentalLimit = false,
  ): number => {
    if (requested <= 0) return 1;
    if (available <= 0) return 0;
    const rawScale = Math.min(1, available / requested);
    // Leave a few ulps in reservoirs that are exhausted by several edge
    // contributions so summation order cannot create a negative raw value.
    const scale = requested >= available * (1 - 1e-12)
      ? rawScale * (1 - 1e-14)
      : rawScale;
    if (recordContinentalLimit && scale < 1 && index < reservoirs.continentalVolumeM3.length) {
      continentalLimitedVolumeM3 += reservoirs.continentalVolumeM3[index]
        * (requested / available) * (1 - scale);
    }
    return scale;
  };
  let eventCount = 0;
  let continentalTransportedVolumeM3 = 0;
  let continentalRoutedVolumeM3 = 0;
  let continentalLimitedVolumeM3 = 0;
  let continentalCorrectionVolumeM3 = 0;
  let rawMinContinentalVolumeM3 = Number.POSITIVE_INFINITY;
  let transferKind: 'advection' | 'routing' = 'advection';
  const recordEvent = (
    cell: number,
    fromPlate: number,
    toPlate: number,
    areaM2: number,
    kind: 1 | 2,
  ) => {
    if (areaM2 <= 0 || fromPlate === toPlate) return;
    workspace.eventCell[eventCount] = cell;
    workspace.eventFromPlate[eventCount] = fromPlate;
    workspace.eventToPlate[eventCount] = toPlate;
    workspace.eventAreaM2[eventCount] = areaM2;
    workspace.eventKind[eventCount] = kind;
    eventCount++;
  };

  // Pass 1: calculate all advection and boundary-event requests from old state.
  for (let edgeIteration = 0; edgeIteration < geometry.edgeCount; edgeIteration++) {
    const edge = options.reverseEdgeIteration ? geometry.edgeCount - 1 - edgeIteration : edgeIteration;
    const cellA = geometry.cellA[edge];
    const cellB = geometry.cellB[edge];
    const referenceFlux = edgeFlux(referenceX, referenceY, referenceZ, geometry, edge);
    if (Math.abs(referenceFlux) > 1e-14) {
      const donor = referenceFlux > 0 ? cellA : cellB;
      const fluxArea = Math.abs(referenceFlux) * dtMyr;
      const base = donor * plateCount;
      let mask = activePlateMask[donor];
      while (mask !== 0) {
        const bit = mask & -mask;
        const plate = 31 - Math.clz32(bit);
        addRequested(
          base + plate,
          fluxArea * Math.max(0, reservoirs.plateAreaFraction[base + plate]),
        );
        mask = (mask & (mask - 1)) >>> 0;
      }
    }

    const plateA = primary[cellA];
    const plateB = primary[cellB];
    if (plateA === plateB) continue;
    const fluxA = edgeFlux(omegaX[plateA], omegaY[plateA], omegaZ[plateA], geometry, edge);
    const fluxB = edgeFlux(omegaX[plateB], omegaY[plateB], omegaZ[plateB], geometry, edge);
    const relativeFlux = fluxB - fluxA;
    const eventArea = Math.abs(relativeFlux) * dtMyr;
    if (eventArea <= 1e-14) continue;

    if (relativeFlux > 0) {
      recordEvent(cellA, plateB, plateA, eventArea * 0.5, 1);
      recordEvent(cellB, plateA, plateB, eventArea * 0.5, 1);
      if (stepLedger) {
        stepLedger.openingAreaM2 += eventArea;
        stepLedger.ridgeAccretionAreaM2 = (stepLedger.ridgeAccretionAreaM2 ?? 0) + eventArea;
        if (stepLedger.openingByPlateM2) {
          stepLedger.openingByPlateM2[plateA] += eventArea * 0.5;
          stepLedger.openingByPlateM2[plateB] += eventArea * 0.5;
        }
      }
    } else {
      const overriding = plateWeight[plateA] > plateWeight[plateB]
        ? plateA
        : plateWeight[plateB] > plateWeight[plateA]
          ? plateB
          : Math.min(plateA, plateB);
      const subducting = overriding === plateA ? plateB : plateA;
      recordEvent(cellA, subducting, overriding, eventArea * 0.5, 2);
      recordEvent(cellB, subducting, overriding, eventArea * 0.5, 2);
      if (stepLedger) {
        stepLedger.convergenceAreaM2 += eventArea;
        stepLedger.trenchConsumptionAreaM2 = (stepLedger.trenchConsumptionAreaM2 ?? 0) + eventArea;
        if (stepLedger.convergenceByPlateM2) stepLedger.convergenceByPlateM2[subducting] += eventArea;
      }
    }
  }

  // First limiter: reference advection only. Keeping its budget separate from
  // same-cell tectonic exchange preserves the discrete divergence-free constant
  // state while still limiting all outgoing shared-edge fluxes together.
  for (let entry = 0; entry < requestedCount; entry++) {
    const index = workspace.requestedIndex[entry];
    const cell = Math.floor(index / plateCount);
    const available = Math.max(0, reservoirs.plateAreaFraction[index] * grid.cellAreas[cell]);
    const requested = requestedOut[index];
    requestedOut[index] = limitDonorRequest(index, available, requested);
  }

  const transferMaterial = (from: number, to: number, ratio: number): number => {
    if (ratio <= 0) return 0;
    const valueCount = totalCells * plateCount;
    let continentalAmount = 0;
    const continental = from < reservoirs.continentalVolumeM3.length
      ? reservoirs.continentalVolumeM3[from]
      : 0;
    if (continental !== 0) {
      workspace.deltaContinentalM3 ??= new Float64Array(valueCount);
      const amount = continental * ratio;
      continentalAmount = amount;
      workspace.deltaContinentalM3[from] -= amount;
      workspace.deltaContinentalM3[to] += amount;
    }
    const oceanic = from < reservoirs.oceanicVolumeM3.length
      ? reservoirs.oceanicVolumeM3[from]
      : 0;
    if (oceanic !== 0) {
      workspace.deltaOceanicM3 ??= new Float64Array(valueCount);
      const amount = oceanic * ratio;
      workspace.deltaOceanicM3[from] -= amount;
      workspace.deltaOceanicM3[to] += amount;
    }
    const ageMoment = from < reservoirs.oceanicAgeMomentM3Myr.length
      ? reservoirs.oceanicAgeMomentM3Myr[from]
      : 0;
    if (ageMoment !== 0) {
      workspace.deltaAgeMomentM3Myr ??= new Float64Array(valueCount);
      const amount = ageMoment * ratio;
      workspace.deltaAgeMomentM3Myr[from] -= amount;
      workspace.deltaAgeMomentM3Myr[to] += amount;
    }
    const inherited = from < reservoirs.inheritedOceanicVolumeM3.length
      ? reservoirs.inheritedOceanicVolumeM3[from]
      : 0;
    if (inherited !== 0) {
      workspace.deltaInheritedM3 ??= new Float64Array(valueCount);
      const amount = inherited * ratio;
      workspace.deltaInheritedM3[from] -= amount;
      workspace.deltaInheritedM3[to] += amount;
    }
    return continentalAmount;
  };

  const applyTransfer = (
    fromCell: number,
    toCell: number,
    fromPlate: number,
    toPlate: number,
    requestedAreaM2: number,
    includeReservoirs = true,
  ): number => {
    const from = fromCell * plateCount + fromPlate;
    const to = toCell * plateCount + toPlate;
    const amount = requestedAreaM2 * requestedOut[from];
    const oldArea = reservoirs.plateAreaFraction[from] * grid.cellAreas[fromCell];
    if (amount <= 0 || oldArea <= 0) return 0;
    if (!workspace.deltaTouched[from]) {
      workspace.deltaTouched[from] = 1;
      workspace.deltaIndex[deltaCount++] = from;
    }
    if (!workspace.deltaTouched[to]) {
      workspace.deltaTouched[to] = 1;
      workspace.deltaIndex[deltaCount++] = to;
    }
    if (!workspace.cellTouched[fromCell]) {
      workspace.cellTouched[fromCell] = 1;
      workspace.dirtyCell[dirtyCellCount++] = fromCell;
    }
    if (!workspace.cellTouched[toCell]) {
      workspace.cellTouched[toCell] = 1;
      workspace.dirtyCell[dirtyCellCount++] = toCell;
    }
    deltaArea[from] -= amount;
    deltaArea[to] += amount;
    const continentalAmount = includeReservoirs
      ? transferMaterial(from, to, amount / oldArea)
      : 0;
    if (transferKind === 'advection') continentalTransportedVolumeM3 += continentalAmount;
    else continentalRoutedVolumeM3 += continentalAmount;
    return amount;
  };

  let deltaCount = 0;
  let dirtyCellCount = 0;
  let rawMinOwnership = 0;
  let rawMaxClosureResidual = 0;
  const commitOwnershipDelta = () => {
    for (let entry = 0; entry < deltaCount; entry++) {
      const index = workspace.deltaIndex[entry];
      const cell = Math.floor(index / plateCount);
      const area = grid.cellAreas[cell];
      const fraction = (reservoirs.plateAreaFraction[index] * area + deltaArea[index]) / area;
      if (!Number.isFinite(fraction) || fraction < -1e-11) {
        throw new Error(`Conservative ownership update failed at index ${index}: ${fraction}`);
      }
      rawMinOwnership = Math.min(rawMinOwnership, fraction);
      reservoirs.plateAreaFraction[index] = Math.abs(fraction) < 1e-15 ? 0 : fraction;
      deltaArea[index] = 0;
      workspace.deltaTouched[index] = 0;
    }
    for (let entry = 0; entry < dirtyCellCount; entry++) {
      const cell = workspace.dirtyCell[entry];
      const base = cell * plateCount;
      let sum = 0;
      for (let plate = 0; plate < plateCount; plate++) {
        const index = base + plate;
        sum += reservoirs.plateAreaFraction[index];
      }
      rawMaxClosureResidual = Math.max(rawMaxClosureResidual, Math.abs(sum - 1));
      workspace.cellTouched[cell] = 0;
    }
    deltaCount = 0;
    dirtyCellCount = 0;
  };

  const commitMaterialDelta = () => {
    const updates: Array<[Float64Array, Float64Array | undefined]> = [
      [reservoirs.continentalVolumeM3, workspace.deltaContinentalM3],
      [reservoirs.oceanicVolumeM3, workspace.deltaOceanicM3],
      [reservoirs.oceanicAgeMomentM3Myr, workspace.deltaAgeMomentM3Myr],
      [reservoirs.inheritedOceanicVolumeM3, workspace.deltaInheritedM3],
    ];
    for (const [field, delta] of updates) {
      if (!delta) continue;
      for (let entry = 0; entry < deltaCount; entry++) {
        const index = workspace.deltaIndex[entry];
        if (index >= field.length) continue;
        const value = field[index] + delta[index];
        const roundoffTolerance = 1e-12 * Math.max(
          1,
          Math.abs(field[index]),
          Math.abs(delta[index]),
        );
        if (!Number.isFinite(value) || value < -roundoffTolerance) {
          throw new Error(`Conservative material update failed at index ${index}: ${value}`);
        }
        rawMinContinentalVolumeM3 = field === reservoirs.continentalVolumeM3
          ? Math.min(rawMinContinentalVolumeM3, value)
          : rawMinContinentalVolumeM3;
        if (value < 0) {
          if (field === reservoirs.continentalVolumeM3) continentalCorrectionVolumeM3 += -value;
          field[index] = 0;
        } else {
          field[index] = value;
        }
        delta[index] = 0;
      }
    }
  };

  // Pass 2a: apply shared-edge reference fluxes antisymmetrically.
  for (let edgeIteration = 0; edgeIteration < geometry.edgeCount; edgeIteration++) {
    const edge = options.reverseEdgeIteration ? geometry.edgeCount - 1 - edgeIteration : edgeIteration;
    const cellA = geometry.cellA[edge];
    const cellB = geometry.cellB[edge];
    const referenceFlux = edgeFlux(referenceX, referenceY, referenceZ, geometry, edge);
    if (Math.abs(referenceFlux) <= 1e-14) continue;
    const donor = referenceFlux > 0 ? cellA : cellB;
    const receiver = referenceFlux > 0 ? cellB : cellA;
    const fluxArea = Math.abs(referenceFlux) * dtMyr;
    const base = donor * plateCount;
    let mask = activePlateMask[donor];
    while (mask !== 0) {
      const bit = mask & -mask;
      const plate = 31 - Math.clz32(bit);
      applyTransfer(
        donor,
        receiver,
        plate,
        plate,
        fluxArea * Math.max(0, reservoirs.plateAreaFraction[base + plate]),
        false,
      );
      mask = (mask & (mask - 1)) >>> 0;
    }
  }

  // Commit the flux-form advection before the local tectonic exchange stage.
  // This is an explicit conservative operator split, not edge-order mutation.
  commitMaterialDelta();
  commitOwnershipDelta();
  clearRequested();
  workspace.deltaContinentalM3?.fill(0);
  workspace.deltaOceanicM3?.fill(0);
  workspace.deltaAgeMomentM3Myr?.fill(0);
  workspace.deltaInheritedM3?.fill(0);

  // Continental and future crustal reservoirs are physical plate-attached
  // densities, not passive payloads of the ensemble-mean ownership carrier.
  // Advect each plate column with that plate's own divergence-free Euler field.
  // Density is volume per physical cell area; overlaps at convergence therefore
  // retain both volumes (thickening), while divergence does not invent material.
  const isMaterialIndexActive = (index: number): boolean => {
    const cell = Math.floor(index / plateCount);
    const continental = reservoirs.continentalVolumeM3[index] ?? 0;
    return continental > grid.cellAreas[cell] * 35_000 * 1e-14
      || (reservoirs.oceanicVolumeM3[index] ?? 0) !== 0
      || (reservoirs.oceanicAgeMomentM3Myr[index] ?? 0) !== 0
      || (reservoirs.inheritedOceanicVolumeM3[index] ?? 0) !== 0;
  };
  if (!workspace.materialActiveInitialized) {
    for (let index = 0; index < totalCells * plateCount; index++) {
      if (isMaterialIndexActive(index)) {
        workspace.materialActiveFlag[index] = 1;
        workspace.materialActiveIndex[workspace.materialActiveCount++] = index;
      }
    }
    workspace.materialActiveInitialized = true;
  }
  const materialActiveCount = workspace.materialActiveCount;
  let materialCandidateCount = materialActiveCount;
  const activateMaterialCandidate = (index: number) => {
    if (workspace.materialActiveFlag[index]) return;
    workspace.materialActiveFlag[index] = 1;
    workspace.materialActiveIndex[materialCandidateCount++] = index;
  };
  for (let materialIteration = 0; materialIteration < materialActiveCount; materialIteration++) {
    const entry = options.reverseEdgeIteration
      ? materialActiveCount - 1 - materialIteration
      : materialIteration;
    const index = workspace.materialActiveIndex[entry];
    const cell = Math.floor(index / plateCount);
    const plate = index - cell * plateCount;
    for (let directionIteration = 0; directionIteration < 4; directionIteration++) {
      const direction = options.reverseEdgeIteration ? 3 - directionIteration : directionIteration;
      const edge = geometry.edgeByCellDirection[cell * 4 + direction];
      const flux = edgeFlux(omegaX[plate], omegaY[plate], omegaZ[plate], geometry, edge);
      const isA = geometry.cellA[edge] === cell;
      if ((isA && flux > 1e-14) || (!isA && flux < -1e-14)) {
        addRequested(index, Math.abs(flux) * dtMyr);
      }
    }
  }
  for (let entry = 0; entry < requestedCount; entry++) {
    const index = workspace.requestedIndex[entry];
    const cell = Math.floor(index / plateCount);
    const requested = requestedOut[index];
    const scale = limitDonorRequest(index, grid.cellAreas[cell], requested, true);
    requestedOut[index] = scale;
  }
  transferKind = 'advection';
  for (let materialIteration = 0; materialIteration < materialActiveCount; materialIteration++) {
    const entry = options.reverseEdgeIteration
      ? materialActiveCount - 1 - materialIteration
      : materialIteration;
    const donor = workspace.materialActiveIndex[entry];
    const donorCell = Math.floor(donor / plateCount);
    const plate = donor - donorCell * plateCount;
    for (let directionIteration = 0; directionIteration < 4; directionIteration++) {
      const direction = options.reverseEdgeIteration ? 3 - directionIteration : directionIteration;
      const edge = geometry.edgeByCellDirection[donorCell * 4 + direction];
      const flux = edgeFlux(omegaX[plate], omegaY[plate], omegaZ[plate], geometry, edge);
      const isA = geometry.cellA[edge] === donorCell;
      if ((isA && flux > 1e-14) || (!isA && flux < -1e-14)) {
        const receiverCell = isA ? geometry.cellB[edge] : geometry.cellA[edge];
        const receiver = receiverCell * plateCount + plate;
        const sweptAreaM2 = Math.abs(flux) * dtMyr * requestedOut[donor];
        if (sweptAreaM2 > 0) {
          if (!workspace.deltaTouched[donor]) {
            workspace.deltaTouched[donor] = 1;
            workspace.deltaIndex[deltaCount++] = donor;
          }
          if (!workspace.deltaTouched[receiver]) {
            workspace.deltaTouched[receiver] = 1;
            workspace.deltaIndex[deltaCount++] = receiver;
          }
          const movedContinental = transferMaterial(
            donor,
            receiver,
            sweptAreaM2 / grid.cellAreas[donorCell],
          );
          activateMaterialCandidate(receiver);
          continentalTransportedVolumeM3 += movedContinental;
        }
      }
    }
  }
  clearRequested();

  // Flux-corrected second-order update for continental density. The raw
  // correction is exactly F_high - F_low from the same immutable state used by
  // the donor-cell pass above. It is limited against the low-order solution
  // before either update is committed, preserving shared-edge antisymmetry,
  // positivity, and local old-state extrema.
  if (options.highResolutionMaterial !== false && reservoirs.continentalVolumeM3.length > 0) {
    const material = reservoirs.continentalVolumeM3;
    const materialDelta = workspace.deltaContinentalM3;
    const requiredCorrectionCapacity = materialActiveCount * 4;
    if (workspace.materialCorrectionEdgePlate.length < requiredCorrectionCapacity) {
      workspace.materialCorrectionEdgePlate = new Uint32Array(requiredCorrectionCapacity);
      workspace.materialCorrectionValueM3 = new Float64Array(requiredCorrectionCapacity);
    }
    const touchMaterialIndex = (index: number) => {
      if (workspace.deltaTouched[index]) return;
      workspace.deltaTouched[index] = 1;
      workspace.deltaIndex[deltaCount++] = index;
    };
    const prepareLimitedGradient = (cell: number, plate: number) => {
      const index = cell * plateCount + plate;
      if (workspace.materialGradientReady[index]) return;
      workspace.materialGradientReady[index] = 1;
      const p3 = cell * 3;
      const px = grid.cellPositions[p3];
      const py = grid.cellPositions[p3 + 1];
      const pz = grid.cellPositions[p3 + 2];
      const e1 = Math.abs(pz) < 0.9
        ? normalize3([-py, px, 0])
        : normalize3([pz, 0, -px]);
      const e2 = cross3([px, py, pz], e1);
      const q0 = material[index] / grid.cellAreas[cell];
      let qMin = q0;
      let qMax = q0;
      let sxx = 0;
      let sxy = 0;
      let syy = 0;
      let bx = 0;
      let by = 0;
      for (let direction = 0; direction < 4; direction++) {
        const neighbor = grid.neighbors[cell * 4 + direction];
        const n3 = neighbor * 3;
        const nx = grid.cellPositions[n3];
        const ny = grid.cellPositions[n3 + 1];
        const nz = grid.cellPositions[n3 + 2];
        const radial = px * nx + py * ny + pz * nz;
        const dx = nx - radial * px;
        const dy = ny - radial * py;
        const dz = nz - radial * pz;
        const x = dx * e1[0] + dy * e1[1] + dz * e1[2];
        const y = dx * e2[0] + dy * e2[1] + dz * e2[2];
        const q = material[neighbor * plateCount + plate] / grid.cellAreas[neighbor];
        const dq = q - q0;
        sxx += x * x;
        sxy += x * y;
        syy += y * y;
        bx += x * dq;
        by += y * dq;
        qMin = Math.min(qMin, q);
        qMax = Math.max(qMax, q);
      }
      const determinant = sxx * syy - sxy * sxy;
      if (Math.abs(determinant) <= 1e-20) return;
      const gxLocal = (syy * bx - sxy * by) / determinant;
      const gyLocal = (sxx * by - sxy * bx) / determinant;
      let gx = gxLocal * e1[0] + gyLocal * e2[0];
      let gy = gxLocal * e1[1] + gyLocal * e2[1];
      let gz = gxLocal * e1[2] + gyLocal * e2[2];
      let limiter = 1;
      for (let direction = 0; direction < 4; direction++) {
        const neighbor = grid.neighbors[cell * 4 + direction];
        const n3 = neighbor * 3;
        const mx = grid.cellPositions[n3] + px;
        const my = grid.cellPositions[n3 + 1] + py;
        const mz = grid.cellPositions[n3 + 2] + pz;
        const inverseLength = 1 / Math.max(1e-20, Math.hypot(mx, my, mz));
        const midpointX = mx * inverseLength;
        const midpointY = my * inverseLength;
        const midpointZ = mz * inverseLength;
        const radial = px * midpointX + py * midpointY + pz * midpointZ;
        const predicted = gx * (midpointX - radial * px)
          + gy * (midpointY - radial * py)
          + gz * (midpointZ - radial * pz);
        if (predicted > 0) limiter = Math.min(limiter, (qMax - q0) / predicted);
        else if (predicted < 0) limiter = Math.min(limiter, (qMin - q0) / predicted);
      }
      limiter = Math.max(0, Math.min(1, limiter));
      gx *= limiter;
      gy *= limiter;
      gz *= limiter;
      workspace.materialGradientX[index] = gx;
      workspace.materialGradientY[index] = gy;
      workspace.materialGradientZ[index] = gz;
    };
    const rawCorrectionM3 = (edge: number, plate: number): number => {
      const cellA = geometry.cellA[edge];
      const cellB = geometry.cellB[edge];
      const qA = material[cellA * plateCount + plate] / grid.cellAreas[cellA];
      const qB = material[cellB * plateCount + plate] / grid.cellAreas[cellB];
      if (qA === qB) return 0;
      const signedSweptAreaM2 = edgeFlux(
        omegaX[plate], omegaY[plate], omegaZ[plate], geometry, edge,
      ) * dtMyr;
      if (Math.abs(signedSweptAreaM2) <= 1e-14) return 0;
      const courant = Math.max(-1, Math.min(
        1,
        signedSweptAreaM2 / Math.max(1, Math.min(grid.cellAreas[cellA], grid.cellAreas[cellB])),
      ));
      const donorCell = signedSweptAreaM2 > 0 ? cellA : cellB;
      const donorIndex = donorCell * plateCount + plate;
      const lowOrderFaceDensity = signedSweptAreaM2 > 0 ? qA : qB;
      prepareLimitedGradient(donorCell, plate);
      const p3 = donorCell * 3;
      const m3 = edge * 3;
      const px = grid.cellPositions[p3];
      const py = grid.cellPositions[p3 + 1];
      const pz = grid.cellPositions[p3 + 2];
      const mx = geometry.edgeMidpoint[m3];
      const my = geometry.edgeMidpoint[m3 + 1];
      const mz = geometry.edgeMidpoint[m3 + 2];
      const radial = px * mx + py * my + pz * mz;
      const reconstructedIncrement = workspace.materialGradientX[donorIndex] * (mx - radial * px)
        + workspace.materialGradientY[donorIndex] * (my - radial * py)
        + workspace.materialGradientZ[donorIndex] * (mz - radial * pz);
      const highOrderFaceDensity = lowOrderFaceDensity
        + (1 - Math.abs(courant)) * reconstructedIncrement;
      const correction = signedSweptAreaM2 * (highOrderFaceDensity - lowOrderFaceDensity);
      const localMassScale = Math.max(
        1,
        Math.abs(material[cellA * plateCount + plate]),
        Math.abs(material[cellB * plateCount + plate]),
      );
      return Math.abs(correction) <= 1e-14 * localMassScale ? 0 : correction;
    };

    // requestedOut and deltaArea are scratch P- / P+ sums after the low-order
    // donor scales have been consumed and cleared.
    let materialCorrectionCount = 0;
    for (let materialIteration = 0; materialIteration < materialActiveCount; materialIteration++) {
      const entry = options.reverseEdgeIteration
        ? materialActiveCount - 1 - materialIteration
        : materialIteration;
      const activeIndex = workspace.materialActiveIndex[entry];
      const activeCell = Math.floor(activeIndex / plateCount);
      const plate = activeIndex - activeCell * plateCount;
      for (let directionIteration = 0; directionIteration < 4; directionIteration++) {
        const direction = options.reverseEdgeIteration ? 3 - directionIteration : directionIteration;
        const edge = geometry.edgeByCellDirection[activeCell * 4 + direction];
        const flux = edgeFlux(omegaX[plate], omegaY[plate], omegaZ[plate], geometry, edge);
        const isA = geometry.cellA[edge] === activeCell;
        if (!((isA && flux > 1e-14) || (!isA && flux < -1e-14))) continue;
        const cellA = geometry.cellA[edge];
        const cellB = geometry.cellB[edge];
        const correction = rawCorrectionM3(edge, plate);
        if (correction !== 0) {
          workspace.materialCorrectionEdgePlate[materialCorrectionCount] = edge * plateCount + plate;
          workspace.materialCorrectionValueM3[materialCorrectionCount] = correction;
          materialCorrectionCount++;
          const donor = (correction > 0 ? cellA : cellB) * plateCount + plate;
          const receiver = (correction > 0 ? cellB : cellA) * plateCount + plate;
          const amount = Math.abs(correction);
          touchMaterialIndex(donor);
          touchMaterialIndex(receiver);
          requestedOut[donor] += amount;
          deltaArea[receiver] += amount;
        }
      }
    }

    for (let entry = 0; entry < deltaCount; entry++) {
      const index = workspace.deltaIndex[entry];
      const cell = Math.floor(index / plateCount);
      const plate = index - cell * plateCount;
      const lowOrderMass = material[index] + (materialDelta?.[index] ?? 0);
      let localMin = material[index] / grid.cellAreas[cell];
      let localMax = localMin;
      for (let direction = 0; direction < 4; direction++) {
        const neighbor = grid.neighbors[cell * 4 + direction];
        const density = material[neighbor * plateCount + plate] / grid.cellAreas[neighbor];
        localMin = Math.min(localMin, density);
        localMax = Math.max(localMax, density);
      }
      const allowedOut = Math.max(0, lowOrderMass - localMin * grid.cellAreas[cell]);
      const allowedIn = Math.max(0, localMax * grid.cellAreas[cell] - lowOrderMass);
      const outgoing = requestedOut[index];
      const incoming = deltaArea[index];
      const outgoingFactor = outgoing > 0 ? Math.min(1, allowedOut / outgoing) : 1;
      const incomingFactor = incoming > 0 ? Math.min(1, allowedIn / incoming) : 1;
      // Leave a small floating-point margin when a collection of edge
      // corrections exactly exhausts a local bound. This is a pre-update flux
      // limit, not a post-update clamp or conservation repair.
      requestedOut[index] = outgoing > 0 && outgoing >= allowedOut * (1 - 1e-10)
        ? outgoingFactor * (1 - 1e-10)
        : outgoingFactor;
      deltaArea[index] = incoming > 0 && incoming >= allowedIn * (1 - 1e-10)
        ? incomingFactor * (1 - 1e-10)
        : incomingFactor;
    }

    if (materialDelta) {
      for (let correctionEntry = 0; correctionEntry < materialCorrectionCount; correctionEntry++) {
        const edgePlate = workspace.materialCorrectionEdgePlate[correctionEntry];
        const edge = Math.floor(edgePlate / plateCount);
        const cellA = geometry.cellA[edge];
        const cellB = geometry.cellB[edge];
        const plate = edgePlate - edge * plateCount;
        const correction = workspace.materialCorrectionValueM3[correctionEntry];
        const donor = (correction > 0 ? cellA : cellB) * plateCount + plate;
        const receiver = (correction > 0 ? cellB : cellA) * plateCount + plate;
        const accepted = Math.abs(correction) * Math.min(requestedOut[donor], deltaArea[receiver]);
        if (accepted > 0) {
          materialDelta[donor] -= accepted;
          materialDelta[receiver] += accepted;
          activateMaterialCandidate(receiver);
        }
      }
    }
    for (let entry = 0; entry < deltaCount; entry++) {
      const index = workspace.deltaIndex[entry];
      requestedOut[index] = 0;
      deltaArea[index] = 0;
    }
  }
  commitMaterialDelta();
  commitOwnershipDelta();
  let nextMaterialActiveCount = 0;
  for (let entry = 0; entry < materialCandidateCount; entry++) {
    const index = workspace.materialActiveIndex[entry];
    workspace.materialActiveFlag[index] = 0;
    if (isMaterialIndexActive(index)) {
      workspace.materialActiveIndex[nextMaterialActiveCount++] = index;
    }
  }
  for (let entry = 0; entry < nextMaterialActiveCount; entry++) {
    workspace.materialActiveFlag[workspace.materialActiveIndex[entry]] = 1;
  }
  workspace.materialActiveCount = nextMaterialActiveCount;
  workspace.deltaContinentalM3?.fill(0);
  workspace.deltaOceanicM3?.fill(0);
  workspace.deltaAgeMomentM3Myr?.fill(0);
  workspace.deltaInheritedM3?.fill(0);

  // Second limiter: aggregate every ridge/trench request from the now-advected
  // state, then scale all requests from the same donor by one factor.
  for (let event = 0; event < eventCount; event++) {
    const from = workspace.eventCell[event] * plateCount + workspace.eventFromPlate[event];
    addRequested(from, workspace.eventAreaM2[event]);
  }
  for (let entry = 0; entry < requestedCount; entry++) {
    const index = workspace.requestedIndex[entry];
    const cell = Math.floor(index / plateCount);
    const available = Math.max(0, reservoirs.plateAreaFraction[index] * grid.cellAreas[cell]);
    const requested = requestedOut[index];
    requestedOut[index] = limitDonorRequest(index, available, requested);
  }

  // Pass 2b: apply ridge/trench exchanges with the same donor scale.
  let actualOpeningAreaM2 = 0;
  let actualConvergenceAreaM2 = 0;
  transferKind = 'routing';
  for (let event = 0; event < eventCount; event++) {
    const cell = workspace.eventCell[event];
    const actual = applyTransfer(
      cell,
      cell,
      workspace.eventFromPlate[event],
      workspace.eventToPlate[event],
      workspace.eventAreaM2[event],
      false,
    );
    if (workspace.eventKind[event] === 1) actualOpeningAreaM2 += actual;
    else actualConvergenceAreaM2 += actual;
  }
  if (stepLedger) {
    stepLedger.ownershipOpeningAreaM2 = (stepLedger.ownershipOpeningAreaM2 ?? 0)
      + actualOpeningAreaM2;
    stepLedger.ownershipConvergenceAreaM2 = (stepLedger.ownershipConvergenceAreaM2 ?? 0)
      + actualConvergenceAreaM2;
  }

  commitMaterialDelta();
  commitOwnershipDelta();
  clearRequested();

  const topology = enforceConnectedDominantTopology(grid, plates, reservoirs, workspace);
  if (stepLedger) {
    stepLedger.topologyCorrectionAreaM2 = (stepLedger.topologyCorrectionAreaM2 ?? 0)
      + topology.correctionAreaM2;
    stepLedger.topologyFragmentsRemoved = (stepLedger.topologyFragmentsRemoved ?? 0)
      + topology.fragmentsRemoved;
    stepLedger.topologyPlatesReseeded = (stepLedger.topologyPlatesReseeded ?? 0)
      + topology.platesReseeded;
    stepLedger.continentalTransportedVolumeM3 = (stepLedger.continentalTransportedVolumeM3 ?? 0)
      + continentalTransportedVolumeM3;
    stepLedger.continentalRoutedVolumeM3 = (stepLedger.continentalRoutedVolumeM3 ?? 0)
      + continentalRoutedVolumeM3;
    stepLedger.continentalTopologyRoutedVolumeM3 = (stepLedger.continentalTopologyRoutedVolumeM3 ?? 0)
      + topology.continentalRoutedVolumeM3;
    stepLedger.continentalLimitedVolumeM3 = (stepLedger.continentalLimitedVolumeM3 ?? 0)
      + continentalLimitedVolumeM3;
    stepLedger.continentalCorrectionVolumeM3 = (stepLedger.continentalCorrectionVolumeM3 ?? 0)
      + continentalCorrectionVolumeM3;
  }

  return {
    rawMinOwnership: Number.isFinite(rawMinOwnership) ? rawMinOwnership : 0,
    rawMaxClosureResidual,
    maxClosureCorrection: 0,
    totalClosureCorrection: 0,
    topologyCorrectionAreaM2: topology.correctionAreaM2,
    topologyFragmentsRemoved: topology.fragmentsRemoved,
    topologyPlatesReseeded: topology.platesReseeded,
    rawMinContinentalVolumeM3: Number.isFinite(rawMinContinentalVolumeM3)
      ? rawMinContinentalVolumeM3
      : 0,
    continentalCorrectionVolumeM3,
  };
}

export function derivePrimaryPlateIds(
  totalCells: number,
  numPlates: number,
  plateAreaFraction: Float32Array | Float64Array,
): Uint16Array;
export function derivePrimaryPlateIds<T extends Uint8Array | Uint16Array>(
  totalCells: number,
  numPlates: number,
  plateAreaFraction: Float32Array | Float64Array,
  target: T,
  activePlateMask?: Uint32Array,
): T;
export function derivePrimaryPlateIds(
  totalCells: number,
  numPlates: number,
  plateAreaFraction: Float32Array | Float64Array,
  target: Uint8Array | Uint16Array = new Uint16Array(totalCells),
  activePlateMask?: Uint32Array,
): Uint8Array | Uint16Array {
  if (target.length !== totalCells) {
    throw new Error(`Primary plate target length ${target.length} does not match ${totalCells}`);
  }
  const primary = target;
  for (let cell = 0; cell < totalCells; cell++) {
    const base = cell * numPlates;
    let bestPlate = 0;
    let bestFraction = -Infinity;
    let mask = 0;
    for (let plate = 0; plate < numPlates; plate++) {
      const fraction = plateAreaFraction[base + plate];
      if (activePlateMask && fraction > 0) mask = (mask | (1 << plate)) >>> 0;
      if (fraction > bestFraction) {
        bestFraction = fraction;
        bestPlate = plate;
      }
    }
    primary[cell] = bestPlate;
    if (activePlateMask) activePlateMask[cell] = mask;
  }
  return primary;
}

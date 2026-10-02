/**
 * Terrain, drainage and river generation for geomorphic landscape renders.
 */
import { Mulberry32, Simplex3D } from '../utils/rng';

export interface GeomorphicLandscapeConfig {
  resolution: number;          // e.g. 512, 1024, 2048
  domainSizeKm: number;        // e.g. 150 km
  seed: number;
  maxElevationM: number;       // e.g. 2600 m
  baseLevelM: number;          // e.g. 80 m
  erosionStrength: number;     // 0.5 to 2.5
  drainageDensity?: number;    // 0.5 to 2.5 (controls Montgomery-Dietrich rill/gully initiation)
  spurRoughness?: number;      // 0.5 to 2.0 (controls transverse chevron spur ridges)
  alluvialDeposition?: number; // 0.0 to 1.5 (controls sediment deposition & flat floodplains)
  gorgeDepthM?: number;        // 200 to 1200 m (controls antecedent river pass gorge depth)
  meanderSinuosity?: number;   // 0.5 to 2.0 (controls river gorge and floodplain loops)
}

export interface RiverPolyline {
  points: { x: number; y: number }[];
  order: number;
  maxAreaKm2: number;
  isTrunk?: boolean;
}

export interface GeomorphicLandscapeData {
  resolution: number;
  domainSizeKm: number;
  elevation: Float32Array;
  riverPolylines: RiverPolyline[];
  drainageAreaKm2: Float32Array;
  slopes: Float32Array;
  maxElevationM: number;
  minElevationM: number;
  ambientOcclusion?: Float32Array;
}

/**
 * Musgrave (1989) Ridged Multifractal with Domain Warping for Knife-Edge Alpine Arêtes
 */
function musgraveRidgedMultifractal(
  simplex: Simplex3D,
  px: number,
  py: number,
  pz: number,
  H: number = 0.55,
  lacunarity: number = 2.18,
  octaves: number = 8,
  offset: number = 1.0,
  gain: number = 2.1
): number {
  let frequency = 1.0;
  let signal = Math.abs(simplex.noise3D(px * frequency, py * frequency, pz * frequency));
  signal = offset - signal;
  signal *= signal;
  let result = signal;
  let weight = 1.0;

  for (let i = 1; i < octaves; i++) {
    frequency *= lacunarity;
    weight = Math.max(0.0, Math.min(1.0, signal * gain));
    signal = Math.abs(simplex.noise3D(px * frequency, py * frequency, pz * frequency));
    signal = offset - signal;
    signal *= signal;
    signal *= weight;
    result += signal * Math.pow(frequency, -H);
  }

  return result;
}

/**
 * Barnes (2014) / Priority-Flood with Epsilon-Gradient to Prevent Flat Grid-Aligned Artifacts
 */
function fillDepressionsWithGradient(elevation: Float32Array, N: number): void {
  const totalCells = N * N;
  const inQueue = new Uint8Array(totalCells);
  const heap: number[] = [];

  function pushHeap(idx: number): void {
    heap.push(idx);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (elevation[heap[i]] < elevation[heap[p]]) {
        const tmp = heap[i]; heap[i] = heap[p]; heap[p] = tmp;
        i = p;
      } else break;
    }
  }

  function popHeap(): number {
    const top = heap[0];
    const bottom = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = bottom;
      let i = 0;
      const len = heap.length;
      while (true) {
        let best = i;
        const l = (i << 1) + 1;
        const r = l + 1;
        if (l < len && elevation[heap[l]] < elevation[heap[best]]) best = l;
        if (r < len && elevation[heap[r]] < elevation[heap[best]]) best = r;
        if (best !== i) {
          const tmp = heap[i]; heap[i] = heap[best]; heap[best] = tmp;
          i = best;
        } else break;
      }
    }
    return top;
  }

  // Push boundary cells
  for (let i = 0; i < N; i++) {
    const topIdx = i;
    const botIdx = (N - 1) * N + i;
    inQueue[topIdx] = 1; pushHeap(topIdx);
    inQueue[botIdx] = 1; pushHeap(botIdx);
  }
  for (let j = 1; j < N - 1; j++) {
    const leftIdx = j * N;
    const rightIdx = j * N + (N - 1);
    inQueue[leftIdx] = 1; pushHeap(leftIdx);
    inQueue[rightIdx] = 1; pushHeap(rightIdx);
  }

  while (heap.length > 0) {
    const currIdx = popHeap();
    const currH = elevation[currIdx];
    const ci = currIdx % N;
    const cj = Math.floor(currIdx / N);

    const neighbors = [
      [ci - 1, cj, 1.0], [ci + 1, cj, 1.0], [ci, cj - 1, 1.0], [ci, cj + 1, 1.0],
      [ci - 1, cj - 1, Math.SQRT2], [ci + 1, cj - 1, Math.SQRT2],
      [ci - 1, cj + 1, Math.SQRT2], [ci + 1, cj + 1, Math.SQRT2],
    ];

    for (let k = 0; k < 8; k++) {
      const [ni, nj, dist] = neighbors[k];
      if (ni >= 0 && ni < N && nj >= 0 && nj < N) {
        const nIdx = nj * N + ni;
        if (inQueue[nIdx] === 0) {
          inQueue[nIdx] = 1;
          const minH = currH + 0.08 * dist;
          if (elevation[nIdx] < minH) {
            elevation[nIdx] = minH;
          }
          pushHeap(nIdx);
        }
      }
    }
  }
}

/**
 * High-Fidelity Fluvial-Geomorphic Landscape Engine with Structural Chevrons & Alluvial Deposition
 */
export function generateGeomorphicLandscape(config: GeomorphicLandscapeConfig): GeomorphicLandscapeData {
  const N = config.resolution;
  const totalCells = N * N;
  const dxM = (config.domainSizeKm * 1000.0) / N;
  const cellAreaKm2 = (dxM * dxM) / 1e6;
  const diagDistM = dxM * Math.SQRT2;

  const drainageDensity = config.drainageDensity ?? 1.0;
  const spurRoughness = config.spurRoughness ?? 1.0;
  const alluvialDeposition = config.alluvialDeposition ?? 0.8;
  const gorgeDepthM = config.gorgeDepthM ?? 750.0;
  const meanderSinuosity = config.meanderSinuosity ?? 1.2;

  const rng = new Mulberry32(config.seed + 101);
  const simplex = new Simplex3D(config.seed + 202);
  const ridgeSimplex = new Simplex3D(config.seed + 505);
  const detailSimplex = new Simplex3D(config.seed + 808);
  const organicSimplex = new Simplex3D(config.seed + 1212);
  const spurSimplex = new Simplex3D(config.seed + 1717);

  const elevation = new Float32Array(totalCells);
  const drainageAreaKm2 = new Float32Array(totalCells);
  const slopes = new Float32Array(totalCells);
  const flowReceivers = new Int32Array(totalCells).fill(-1);

  // Dynamic seed-driven mountain axis orientation & spine parameters
  const mountainAngle = rng.range(0.35, 0.75);
  const cosA = Math.cos(mountainAngle);
  const sinA = Math.sin(mountainAngle);

  const spine1OffsetU = rng.range(0.05, 0.20);
  const spine1OffsetV = rng.range(-0.30, -0.15);
  const spine2OffsetU = rng.range(-0.25, -0.10);
  const spine2OffsetV = rng.range(0.20, 0.38);

  const gorgeFreq = rng.range(2.6, 3.4) * meanderSinuosity;
  const gorgeAmp = rng.range(0.14, 0.22) * meanderSinuosity;

  // 1. Tectonic Mountain Massifs, Transverse Chevron Spurs & Antecedent Gorge
  for (let j = 0; j < N; j++) {
    const yNorm = (j / N) * 2.0 - 1.0;
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      const xNorm = (i / N) * 2.0 - 1.0;

      // Coordinate rotated along the dynamic mountain axis
      const u = xNorm * cosA + yNorm * sinA;
      const v = -xNorm * sinA + yNorm * cosA;

      // Primary tectonic mountain spine 1 (North-East sector)
      const u1 = u + spine1OffsetU;
      const v1 = v + spine1OffsetV;
      const spine1Offset = simplex.noise3D(u1 * 2.4, 1.0, 2.0) * 0.14;
      const distSpine1 = Math.hypot(u1 * 1.15, (v1 - spine1Offset) * 2.4);
      const massif1 = Math.max(0.0, 1.0 - distSpine1);

      // Primary tectonic mountain spine 2 (South-West sector)
      const u2 = u + spine2OffsetU;
      const v2 = v + spine2OffsetV;
      const spine2Offset = simplex.noise3D(u2 * 2.4, 3.0, 4.0) * 0.14;
      const distSpine2 = Math.hypot(u2 * 1.25, (v2 - spine2Offset) * 2.6);
      const massif2 = Math.max(0.0, 1.0 - distSpine2);

      const mountainMassif = Math.max(Math.pow(massif1, 1.4) * 0.96, Math.pow(massif2, 1.4) * 0.90);

      // Multi-octave Musgrave ridged multifractal for razor-sharp knife-edge arêtes
      const ridgeNoise = musgraveRidgedMultifractal(ridgeSimplex, xNorm * 3.8, yNorm * 3.8, 1.5, 0.52, 2.18, 8, 1.0, 2.0) * 0.42;

      // Transverse Chevron Spur Ridges (lateral ribs branching off the main spine at ~45-60 degrees)
      const spurU = (u * 0.707 + v * 0.707) * 4.8;
      const spurV = (-u * 0.707 + v * 0.707) * 4.8;
      const spurSignal = (Math.abs(spurSimplex.noise3D(spurU, spurV, 2.5)) +
                          0.5 * Math.abs(spurSimplex.noise3D(spurU * 2.1, spurV * 2.1, 5.0))) * spurRoughness;
      const spurRidge = Math.pow(1.0 - Math.min(1.0, spurSignal), 2.2) * 0.35;

      // Sinuous antecedent transversal river water gap (gorge carved through the mountain pass)
      const gorgePath = Math.sin(xNorm * gorgeFreq) * gorgeAmp + Math.cos(xNorm * (gorgeFreq * 2.2)) * 0.05 - (xNorm - 0.1) * 0.18;
      const gorgeDist = Math.abs(yNorm - gorgePath);
      const gorgeCarving = Math.exp(-Math.pow(gorgeDist / 0.14, 2.0)) * gorgeDepthM;

      // Regional foreland plain gradient (sloping from NW highlands down to SE floodplain)
      const forelandSlope = config.baseLevelM + (1.0 - xNorm * 0.45 - yNorm * 0.55) * 280.0;

      // Natural organic meandering plain relief & subtle alluvial terraces
      const organicRelief = organicSimplex.noise3D(xNorm * 2.8, yNorm * 2.8, 1.0) * 45.0 +
                            detailSimplex.noise3D(xNorm * 5.5, yNorm * 5.5, 2.0) * 18.0;

      // Base elevation with structural chevrons and antecedent water gap
      const mountainH = mountainMassif * config.maxElevationM * (0.26 + 0.52 * ridgeNoise + 0.22 * spurRidge);
      elevation[idx] = Math.max(config.baseLevelM, forelandSlope + organicRelief + mountainH - gorgeCarving);
    }
  }

  // 2. Priority-Flood Depression Filling
  fillDepressionsWithGradient(elevation, N);

  // 3. Multi-Iteration Geomorphic Evolution (Fluvial Incision + Alluvial Deposition + Critical Slope Diffusion)
  const numIterations = 2;
  const indices = new Int32Array(totalCells);

  for (let iter = 0; iter < numIterations; iter++) {
    for (let i = 0; i < totalCells; i++) indices[i] = i;
    indices.sort((a, b) => elevation[b] - elevation[a]);

    drainageAreaKm2.fill(0);
    flowReceivers.fill(-1);

    for (let rank = 0; rank < totalCells; rank++) {
      const idx = indices[rank];
      const i = idx % N;
      const j = Math.floor(idx / N);
      const elev = elevation[idx];

      let maxSlope = 0.0;
      let bestNeighbor = -1;

      const neighbors = [
        [i - 1, j, dxM],
        [i + 1, j, dxM],
        [i, j - 1, dxM],
        [i, j + 1, dxM],
        [i - 1, j - 1, diagDistM],
        [i + 1, j - 1, diagDistM],
        [i - 1, j + 1, diagDistM],
        [i + 1, j + 1, diagDistM],
      ];

      for (let k = 0; k < 8; k++) {
        const [ni, nj, dist] = neighbors[k];
        if (ni >= 0 && ni < N && nj >= 0 && nj < N) {
          const nIdx = nj * N + ni;
          const nH = elevation[nIdx];
          if (nH < elev) {
            const slope = (elev - nH) / dist;
            if (slope > maxSlope) {
              maxSlope = slope;
              bestNeighbor = nIdx;
            }
          }
        }
      }

      flowReceivers[idx] = bestNeighbor;
      slopes[idx] = Math.max(0.001, maxSlope);
      drainageAreaKm2[idx] += cellAreaKm2;

      if (bestNeighbor >= 0) {
        drainageAreaKm2[bestNeighbor] += drainageAreaKm2[idx];
      }
    }

    // Fluvial Bedrock Incision with Montgomery-Dietrich Initiation Scaling
    const channelCrit = (0.006 / drainageDensity);
    for (let rank = 0; rank < totalCells; rank++) {
      const idx = indices[rank];
      const A = drainageAreaKm2[idx];
      const S = slopes[idx];
      const elev = elevation[idx];

      // Channel initiation criterion: steep hollows (high S) initiate at very small A
      const channelInitiated = (A * Math.pow(S, 1.5) >= channelCrit) || (A >= 2.0);

      if (channelInitiated && elev > config.baseLevelM + 5.0) {
        const streamPower = Math.pow(A, 0.45) * Math.pow(S, 0.85) * 520.0 * config.erosionStrength;
        const maxCut = (elev - config.baseLevelM) * 0.70;
        const incision = Math.min(maxCut, streamPower / numIterations);
        elevation[idx] -= incision;
      }

      // Alluvial Sediment Deposition in low-slope floodplains and valley exits
      if (alluvialDeposition > 0.01 && A > 15.0 && S < 0.06 && elev < config.baseLevelM + 600.0) {
        const depositionCapacity = (alluvialDeposition * 28.0 * Math.pow(A, 0.25)) / (1.0 + S * 45.0);
        elevation[idx] += Math.min(45.0, depositionCapacity / numIterations);
      }
    }

    // Critical-Slope Hillslope Diffusion (Sharp knife-edge arêtes & scree talus slopes)
    const Sc = 0.68;
    const ScSq = Sc * Sc;
    const D_hillslope = 0.075;

    for (let step = 0; step < 2; step++) {
      for (let j = 1; j < N - 1; j++) {
        for (let i = 1; i < N - 1; i++) {
          const idx = j * N + i;
          const eC = elevation[idx];
          const eN = elevation[(j + 1) * N + i];
          const eS = elevation[(j - 1) * N + i];
          const eE = elevation[j * N + (i + 1)];
          const eW = elevation[j * N + (i - 1)];

          const dzdx = (eE - eW) / (2.0 * dxM);
          const dzdy = (eN - eS) / (2.0 * dxM);
          const gradSq = dzdx * dzdx + dzdy * dzdy;

          const fluxLimiter = 1.0 / Math.max(0.05, 1.0 - Math.min(0.95, gradSq / ScSq));
          const laplacian = (eN + eS + eE + eW - 4.0 * eC) / (dxM * dxM);

          const deltaZ = D_hillslope * laplacian * fluxLimiter * 16.0;
          elevation[idx] = Math.max(config.baseLevelM, eC + Math.max(-30.0, Math.min(30.0, deltaZ)));
        }
      }
    }

    fillDepressionsWithGradient(elevation, N);
  }

  // 4. Final Flow Routing & Drainage Accumulation
  indices.sort((a, b) => elevation[b] - elevation[a]);
  drainageAreaKm2.fill(0);
  flowReceivers.fill(-1);

  for (let rank = 0; rank < totalCells; rank++) {
    const idx = indices[rank];
    const i = idx % N;
    const j = Math.floor(idx / N);
    const elev = elevation[idx];

    let maxSlope = 0.0;
    let bestNeighbor = -1;

    const neighbors = [
      [i - 1, j, dxM],
      [i + 1, j, dxM],
      [i, j - 1, dxM],
      [i, j + 1, dxM],
      [i - 1, j - 1, diagDistM],
      [i + 1, j - 1, diagDistM],
      [i - 1, j + 1, diagDistM],
      [i + 1, j + 1, diagDistM],
    ];

    for (let k = 0; k < 8; k++) {
      const [ni, nj, dist] = neighbors[k];
      if (ni >= 0 && ni < N && nj >= 0 && nj < N) {
        const nIdx = nj * N + ni;
        const nH = elevation[nIdx];
        if (nH < elev) {
          const slope = (elev - nH) / dist;
          if (slope > maxSlope) {
            maxSlope = slope;
            bestNeighbor = nIdx;
          }
        }
      }
    }

    flowReceivers[idx] = bestNeighbor;
    slopes[idx] = Math.max(0.001, maxSlope);
    drainageAreaKm2[idx] += cellAreaKm2;

    if (bestNeighbor >= 0) {
      drainageAreaKm2[bestNeighbor] += drainageAreaKm2[idx];
    }
  }

  // 5. Extract Smooth Sinuous River Polylines Using Montgomery-Dietrich Criterion
  const riverPolylines: RiverPolyline[] = [];
  const channelCrit = (0.005 / drainageDensity);

  for (let idx = 0; idx < totalCells; idx++) {
    const area = drainageAreaKm2[idx];
    const slope = slopes[idx];
    const rec = flowReceivers[idx];

    // Montgomery-Dietrich Channel Initiation: High slope triggers fine mountain rills at low drainage area
    const isChannel = (area * Math.pow(slope, 1.4) >= channelCrit) || (area >= 3.0);

    if (isChannel && rec >= 0) {
      const x0 = idx % N;
      const y0 = Math.floor(idx / N);
      const x1 = rec % N;
      const y1 = Math.floor(rec / N);

      if (Math.abs(x1 - x0) <= 2 && Math.abs(y1 - y0) <= 2) {
        let order = 1;
        let isTrunk = false;
        if (area >= 1500.0) {
          order = 6;
          isTrunk = true;
        } else if (area >= 400.0) {
          order = 5;
        } else if (area >= 100.0) {
          order = 4;
        } else if (area >= 22.0) {
          order = 3;
        } else if (area >= 5.0) {
          order = 2;
        }

        riverPolylines.push({
          points: [{ x: x0, y: y0 }, { x: x1, y: y1 }],
          order,
          maxAreaKm2: area,
          isTrunk,
        });
      }
    }
  }

  // Calculate stats
  let minElev = 1e9, maxElev = -1e9;
  for (let idx = 0; idx < totalCells; idx++) {
    const h = elevation[idx];
    if (h < minElev) minElev = h;
    if (h > maxElev) maxElev = h;
  }

  return {
    resolution: N,
    domainSizeKm: config.domainSizeKm,
    elevation,
    riverPolylines,
    drainageAreaKm2,
    slopes,
    maxElevationM: maxElev,
    minElevationM: minElev,
  };
}


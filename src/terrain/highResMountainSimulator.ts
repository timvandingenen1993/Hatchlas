/**
 * Erosion and structure simulation for the high-resolution mountain viewer.
 */
import { Mulberry32, Simplex3D } from '../utils/rng';

export interface HighResMountainConfig {
  resolution: number;        // e.g. 1024x1024
  domainSizeKm: number;      // e.g. 500 km
  seed: number;
  tectonicUpliftM: number;   // e.g. 5200 m
  windSpeedMs: number;       // e.g. 16 m/s
  windAngleRad: number;      // e.g. Math.PI / 4
  precipitationMmYr: number; // e.g. 1600 mm/yr
  rockHardness: number;      // 0.8 to 1.5
  geologicalAgeMyr: number;  // 2 to 15 Myr
  criticalSlope: number;     // ~0.68 (~34 degrees)
}

export interface HighResMountainData {
  resolution: number;
  domainSizeKm: number;
  elevation: Float32Array;
  upliftRate: Float32Array;
  precipitation: Float32Array;
  temperatureC: Float32Array;
  drainageAreaKm2: Float32Array;
  dischargeM3s: Float32Array;
  flowReceivers: Int32Array;
  strahlerOrder: Uint8Array;
  slopes: Float32Array;
  erodedDepthM: Float32Array;
  iceThicknessM: Float32Array;
}

/**
 * Physically-Based Fluvial-Tectonic Landscape Evolution (Cordonnier 2016, Tzathas 2024, Smith & Barstad 2004)
 * References:
 * 1. Cordonnier et al. (2016), "Large Scale Terrain Generation from Tectonic Uplift and Fluvial Erosion", Computer Graphics Forum.
 * 2. Tzathas et al. (2024), "Physically-Based Analytical Erosion for Fast Terrain Generation", Computer Graphics Forum.
 * 3. Smith & Barstad (2004), "A Linear Theory of Orographic Precipitation", Journal of the Atmospheric Sciences.
 * 4. Perron & Royden (2013), "An integral approach to bedrock river profile analysis", Earth Surf. Dynam.
 * 5. Musgrave et al. (1989), "The Synthesis and Rendering of Eroded Fractal Terrains", ACM SIGGRAPH.
 */
export function simulateHighResMountainLandscape(config: HighResMountainConfig): HighResMountainData {
  const N = config.resolution;
  const totalCells = N * N;
  const dxM = (config.domainSizeKm * 1000.0) / N;
  const cellAreaKm2 = (dxM * dxM) / 1e6;
  const diagDistM = dxM * Math.SQRT2;

  const rng = new Mulberry32(config.seed + 101);
  const ridgeSimplex = new Simplex3D(config.seed + 909);
  const detailSimplex = new Simplex3D(config.seed + 1414);
  const plainSimplex = new Simplex3D(config.seed + 3030);

  const elevation = new Float32Array(totalCells);
  const initialElevation = new Float32Array(totalCells);
  const upliftRate = new Float32Array(totalCells);
  const precipitation = new Float32Array(totalCells);
  const temperatureC = new Float32Array(totalCells);
  const drainageAreaKm2 = new Float32Array(totalCells);
  const dischargeM3s = new Float32Array(totalCells);
  const flowReceivers = new Int32Array(totalCells).fill(-1);
  const strahlerOrder = new Uint8Array(totalCells);
  const slopes = new Float32Array(totalCells);
  const erodedDepthM = new Float32Array(totalCells);
  const iceThicknessM = new Float32Array(totalCells);

  // 1. Tectonic Orogenic Uplift Field (Main Mountain Arch + Transverse Spurs + Foreland Basin)
  const mountainAxisAngle = rng.range(0.20, 0.38);
  const cosAxis = Math.cos(mountainAxisAngle);
  const sinAxis = Math.sin(mountainAxisAngle);

  for (let j = 0; j < N; j++) {
    const yNorm = (j / N) * 2.0 - 1.0;
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      const xNorm = (i / N) * 2.0 - 1.0;

      // Coordinate rotated along the tectonic mountain range axis
      const u = xNorm * cosAxis + yNorm * sinAxis;
      const v = -xNorm * sinAxis + yNorm * cosAxis;

      // Sinuous spine displacement
      const spineOffset = ridgeSimplex.noise3D(u * 1.6, 0.5, 1.2) * 0.16;
      const vDist = v - spineOffset;

      // Primary tectonic orogenic arch (Gaussian cross-section)
      const archWidth = 0.36;
      const arch = Math.exp(-Math.pow(vDist / archWidth, 2.0));

      // Asymmetric thrust belt
      const asymmetry = 0.85 + 0.15 * Math.tanh(vDist / 0.12);
      const baseUplift = arch * asymmetry * config.tectonicUpliftM;

      // Multi-scale structural fault blocks & transverse spurs (Musgrave ridged multifractal)
      let freq = 2.4;
      let amp = 0.52;
      let faultSignal = 0;
      for (let o = 0; o < 7; o++) {
        const n = Math.abs(ridgeSimplex.noise3D(u * freq, v * freq * 1.3, o * 1.7));
        const ridge = Math.pow(1.0 - n, 2.0);
        faultSignal += ridge * amp;
        freq *= 2.16;
        amp *= 0.50;
      }

      // Heterogeneous valley pre-conditioning (Musgrave HeteroTerrain)
      let hFreq = 3.2;
      let hWeight = 1.0;
      let heteroSignal = 0;
      for (let o = 0; o < 5; o++) {
        const hn = detailSimplex.noise3D(u * hFreq + 10, v * hFreq + 20, o * 2.1);
        heteroSignal += hn * (1.0 / hFreq) * hWeight;
        hWeight = Math.max(0.0, Math.min(1.0, (hn + 0.5) * 1.2));
        hFreq *= 2.10;
      }

      // Foreland basin and coastal slope (sloping smoothly toward southern and eastern ocean coast)
      const continentalSlope = 45.0 + (1.0 - xNorm * 0.4 - yNorm * 0.5) * 120.0;
      const plainRelief = plainSimplex.noise3D(xNorm * 3.0, yNorm * 3.0, 1.0) * 35.0;

      // Base tectonic topography
      const mountainElevation = baseUplift * (0.35 + 0.65 * faultSignal) + heteroSignal * 280.0;
      const totalElevation = Math.max(10.0, continentalSlope + plainRelief + mountainElevation);

      upliftRate[idx] = (baseUplift / 1e6);
      elevation[idx] = totalElevation;
      initialElevation[idx] = totalElevation;
    }
  }

  // 2. Physical Orographic Moisture Transport & Elevation Coupling (Smith & Barstad 2004, Hartmann 1994)
  const wx = Math.cos(config.windAngleRad) * config.windSpeedMs;
  const wy = Math.sin(config.windAngleRad) * config.windSpeedMs;
  const LAPSE_RATE = 0.0065; // 6.5 °C / km

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      const elev = elevation[idx];

      const tSea = 22.0;
      const tempLocal = tSea - elev * LAPSE_RATE;
      temperatureC[idx] = tempLocal;

      // Directional orographic ascent along wind vector
      const iUp = Math.max(0, Math.min(N - 1, Math.round(i - (wx / config.windSpeedMs) * 8)));
      const jUp = Math.max(0, Math.min(N - 1, Math.round(j - (wy / config.windSpeedMs) * 8)));
      const upElev = elevation[jUp * N + iUp];
      const slopeUphill = (elev - upElev) / (8.0 * dxM);

      // Baseline lowland plain precipitation (500 to 750 mm/yr)
      const baseLowlandPrecip = 650.0;

      // 1. WINDWARD FLANK OROGRAPHIC DELUGE:
      // Intense condensation when moist air is forced upward against rising mountain slopes
      const orographicFlankDeluge = slopeUphill > 0.002
        ? slopeUphill * 95000.0 * (config.windSpeedMs / 12.0) * (1.0 + elev / 1200.0)
        : 0.0;

      // 2. LEEWARD RAIN SHADOW DESICCATION:
      // Adiabatic warming of descending air suppresses precipitation by up to 85%
      const rainShadowFactor = slopeUphill < -0.002
        ? Math.max(0.12, Math.exp(slopeUphill * 140.0))
        : 1.0;

      // 3. Peak altitude condensation scaling
      const altitudeCondensation = Math.min(800.0, (elev / 2500.0) * 800.0);

      const pTotal = (baseLowlandPrecip + altitudeCondensation + orographicFlankDeluge) * rainShadowFactor;
      precipitation[idx] = Math.max(80.0, pTotal);

      // Glacial ice cap above freezing line
      if (tempLocal < 0.0) {
        const freezingDeficit = -tempLocal;
        iceThicknessM[idx] = Math.min(450.0, freezingDeficit * 35.0 * (precipitation[idx] / 1500.0));
      }
    }
  }

  // 3. Iterative Geomorphic Evolution (Flow Routing -> Stream Power Incision -> Hillslope Diffusion)
  const totalIterations = 4;
  const K_fluvial = (0.00035 * config.geologicalAgeMyr) / (config.rockHardness * totalIterations);
  const m = 0.45;
  const n = 1.00;
  const Sc = config.criticalSlope; // ~0.68
  const ScSq = Sc * Sc;
  const D_hillslope = 0.09;
  const SECONDS_PER_YEAR = 31557600;

  const indices = new Int32Array(totalCells);

  for (let iter = 0; iter < totalIterations; iter++) {
    // A. 8-Neighbor Steepest Descent Flow Routing
    for (let i = 0; i < totalCells; i++) indices[i] = i;
    indices.sort((a, b) => elevation[b] - elevation[a]);

    drainageAreaKm2.fill(0);
    dischargeM3s.fill(0);
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

      // Local net runoff discharge
      const pNetM = Math.max(0.18, (precipitation[idx] - 320.0) / 1000.0);
      const localQ = (pNetM * (cellAreaKm2 * 1e6)) / SECONDS_PER_YEAR;
      dischargeM3s[idx] += localQ;

      if (bestNeighbor >= 0) {
        drainageAreaKm2[bestNeighbor] += drainageAreaKm2[idx];
        dischargeM3s[bestNeighbor] += dischargeM3s[idx];
      }
    }

    // B. Stream Power Bedrock Fluvial Incision (E = K * A^m * S^n)
    for (let rank = 0; rank < totalCells; rank++) {
      const idx = indices[rank];
      const A = drainageAreaKm2[idx];
      const S = slopes[idx];
      const elev = elevation[idx];

      if (A > 1.2 && elev > 15.0) {
        const streamPowerIncision = K_fluvial * Math.pow(A, m) * Math.pow(S, n) * 6000.0;
        const actualIncision = Math.min(elev * 0.70, streamPowerIncision);

        elevation[idx] -= actualIncision;
      }
    }

    // C. Nonlinear Critical-Slope Hillslope Diffusion (Sharp knife-edge arêtes & scree talus slopes)
    for (let step = 0; step < 3; step++) {
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
          elevation[idx] = Math.max(5.0, eC + Math.max(-40.0, Math.min(40.0, deltaZ)));
        }
      }
    }
  }

  // 4. Calculate Final Cumulative Eroded Depth & Strahler Hierarchy
  for (let idx = 0; idx < totalCells; idx++) {
    erodedDepthM[idx] = Math.max(0.0, initialElevation[idx] - elevation[idx]);

    const A = drainageAreaKm2[idx];
    if (A < 5.0) {
      strahlerOrder[idx] = 1;
    } else if (A < 30.0) {
      strahlerOrder[idx] = 2;
    } else if (A < 180.0) {
      strahlerOrder[idx] = 3;
    } else if (A < 900.0) {
      strahlerOrder[idx] = 4;
    } else if (A < 4500.0) {
      strahlerOrder[idx] = 5;
    } else {
      strahlerOrder[idx] = 6;
    }
  }

  return {
    resolution: N,
    domainSizeKm: config.domainSizeKm,
    elevation,
    upliftRate,
    precipitation,
    temperatureC,
    drainageAreaKm2,
    dischargeM3s,
    flowReceivers,
    strahlerOrder,
    slopes,
    erodedDepthM,
    iceThicknessM,
  };
}

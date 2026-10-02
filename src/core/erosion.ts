/**
 * Erosion for the flat-grid world: stream power, hillslope diffusion, waves, rain splash and glaciers.
 */
import { FastRandom } from './noise';
import { ROCK_SOIL_DEFINITIONS } from '../types/map';
import type { WorldGenConfig } from '../types/map';

export interface ErosionParameters {
  dropletCount: number;
  inertia: number;            // Droplet directional persistence (0.05 - 0.3)
  sedimentCapacity: number;   // Capacity multiplier
  minSedimentCapacity: number;// Flat terrain capacity
  erodeSpeed: number;         // Fluvial rock erosion rate
  depositSpeed: number;       // Silt deposition rate
  evaporateSpeed: number;     // Evaporation rate
  gravity: number;            // Gravitational acceleration
  maxDropletLifetime: number; // Max droplet path length
  initialWaterVolume: number;
  initialSpeed: number;
  brushRadius: number;
}

export const DEFAULT_EROSION_PARAMS: ErosionParameters = {
  dropletCount: 30000,
  inertia: 0.15,
  sedimentCapacity: 3.5,
  minSedimentCapacity: 0.01,
  erodeSpeed: 0.32,
  depositSpeed: 0.3,
  evaporateSpeed: 0.015,
  gravity: 5.5,
  maxDropletLifetime: 45,
  initialWaterVolume: 1.0,
  initialSpeed: 1.0,
  brushRadius: 2,
};

export interface ComprehensiveErosionResult {
  elevation: Float32Array;
  sediment: Float32Array;
  soilType: Uint8Array;
  rockHardness: Float32Array;
}

// Master Geophysical Multi-Erosion Simulator
export function simulateComprehensiveGeologicalErosion(
  width: number,
  height: number,
  elevation: Float32Array,
  precipitation: Float32Array,
  moisture: Float32Array,
  glacierIce: Float32Array,
  windU: Float32Array,
  windV: Float32Array,
  config: WorldGenConfig,
  customParams?: Partial<ErosionParameters>,
  onProgress?: (step: string, progress: number) => void
): ComprehensiveErosionResult {
  const totalCells = width * height;
  const currentElev = new Float32Array(elevation);
  const sedimentMap = new Float32Array(totalCells);
  const soilType = new Uint8Array(totalCells);
  const rockHardness = new Float32Array(totalCells);

  // 1. Classify Initial Geological Lithology / Rock & Soil Layers
  classifyGeologicalStrata(width, height, currentElev, glacierIce, config.seaLevel, soilType, rockHardness);

  // 2. 🌊 Ocean Coastal Wave Erosion & Marine Cliff Notching
  if ((config.oceanWaveErosionStrength ?? 1.0) > 0.05) {
    onProgress?.('Simulating Marine Wave Action & Coastal Cliff Erosion...', 0.2);
    applyOceanWaveErosion(width, height, currentElev, sedimentMap, soilType, rockHardness, config);
  }

  // 3. 🌧️ Pluvial Rain-Splash & Sheetwash Erosion
  if ((config.rainSplashErosionStrength ?? 1.0) > 0.05) {
    onProgress?.('Simulating Pluvial Rain-Splash & Sheetwash...', 0.35);
    applyRainSplashErosion(width, height, currentElev, precipitation, sedimentMap, rockHardness, config);
  }

  // 4. 🏞️ Fluvial / River Channel Hydraulic Droplet Erosion
  if ((config.riverErosionStrength ?? 1.0) > 0.05) {
    onProgress?.('Simulating Fluvial Hydraulic Droplets & Canyon Carving...', 0.55);
    applyHydraulicDroplets(
      width,
      height,
      currentElev,
      precipitation,
      glacierIce,
      sedimentMap,
      soilType,
      rockHardness,
      config,
      customParams
    );
  }

  // 5. 💨 Aeolian Wind Abrasion & Desert Deflation
  if ((config.windErosionStrength ?? 1.0) > 0.05) {
    onProgress?.('Simulating Aeolian Wind Abrasion & Dune Deflation...', 0.75);
    applyAeolianWindErosion(width, height, currentElev, moisture, windU, windV, sedimentMap, soilType, config);
  }

  // 6. ❄️ Cryospheric Glacial U-Valley Gouging
  if ((config.glacierErosionStrength ?? 1.0) > 0.05) {
    onProgress?.('Simulating Glacial U-Valley Gouging...', 0.88);
    applyGlacialCarving(width, height, currentElev, glacierIce, soilType, config);
  }

  // 7. ⛰️ Gravitational Mass Wasting & Slope Angle of Repose by Soil Type
  onProgress?.('Applying Gravitational Mass Wasting & Talus Slumping...', 0.96);
  applyGravitationalMassWasting(width, height, currentElev, soilType, 4);

  return {
    elevation: currentElev,
    sediment: sedimentMap,
    soilType,
    rockHardness,
  };
}

// 1. Initial Geological Lithology assignment based on depth, volcanism, and altitude
export function classifyGeologicalStrata(
  _width: number,
  _height: number,
  elevation: Float32Array,
  glacierIce: Float32Array,
  seaLevel: number,
  soilType: Uint8Array,
  rockHardness: Float32Array
): void {
  for (let idx = 0; idx < elevation.length; idx++) {
    const h = elevation[idx];
    const ice = glacierIce[idx];

    if (ice > 0.3) {
      // Glacial Till / Moraine
      soilType[idx] = 5;
      rockHardness[idx] = ROCK_SOIL_DEFINITIONS[5].hardness;
    } else if (h <= seaLevel) {
      // Ocean shelf / deep marine basalt
      soilType[idx] = 1; // Basalt
      rockHardness[idx] = ROCK_SOIL_DEFINITIONS[1].hardness;
    } else {
      const landAltitude = (h - seaLevel) / (1.0 - seaLevel);
      if (landAltitude > 0.65) {
        // High Alpine Crags -> Granite Bedrock
        soilType[idx] = 0;
        rockHardness[idx] = ROCK_SOIL_DEFINITIONS[0].hardness;
      } else if (landAltitude > 0.35) {
        // Highlands / Mesas -> Sedimentary Strata
        soilType[idx] = 2;
        rockHardness[idx] = ROCK_SOIL_DEFINITIONS[2].hardness;
      } else if (landAltitude < 0.05) {
        // Coastal Lowlands / Beaches -> Sand & Scree
        soilType[idx] = 4;
        rockHardness[idx] = ROCK_SOIL_DEFINITIONS[4].hardness;
      } else {
        // Valleys & Plains -> Regolith Soil
        soilType[idx] = 3;
        rockHardness[idx] = ROCK_SOIL_DEFINITIONS[3].hardness;
      }
    }
  }
}

// 2. 🌊 Ocean / Coastal Wave Marine Erosion
export function applyOceanWaveErosion(
  width: number,
  height: number,
  elevation: Float32Array,
  sediment: Float32Array,
  soilType: Uint8Array,
  rockHardness: Float32Array,
  config: WorldGenConfig
): void {
  const seaLevel = config.seaLevel;
  const strength = config.oceanWaveErosionStrength ?? 1.0;
  const waveBand = 0.035; // Surf zone elevation range

  const delta = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    const yIdx = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = yIdx + x;
      const h = elevation[idx];

      // Check if coastal cell near shoreline
      if (h > seaLevel && h < seaLevel + waveBand) {
        // Count surrounding water cells (exposure to ocean waves)
        let seaNeighbors = 0;
        let lowestSeaIdx = -1;
        let minSeaElev = 1.0;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nIdx = (y + dy) * width + (x + dx);
            if (elevation[nIdx] <= seaLevel) {
              seaNeighbors++;
              if (elevation[nIdx] < minSeaElev) {
                minSeaElev = elevation[nIdx];
                lowestSeaIdx = nIdx;
              }
            }
          }
        }

        if (seaNeighbors > 0) {
          // Marine abrasion: wave energy pounds against headland
          const hardness = rockHardness[idx];
          const waveEnergy = (seaNeighbors / 8.0) * (1.1 - hardness);
          const eroded = 0.015 * waveEnergy * strength;

          delta[idx] -= eroded;
          sediment[idx] -= eroded;

          // Sand/gravel washed into adjacent shallow sea (forming beaches/shoals)
          if (lowestSeaIdx !== -1) {
            delta[lowestSeaIdx] += eroded * 0.75;
            sediment[lowestSeaIdx] += eroded * 0.75;
            soilType[lowestSeaIdx] = 4; // Sand
          }

          // Coastal cliff exposed
          if (h > seaLevel + 0.015) {
            soilType[idx] = hardness > 0.7 ? 0 : 2; // Bedrock cliff
          }
        }
      }
    }
  }

  for (let i = 0; i < elevation.length; i++) {
    elevation[i] = Math.max(0.0, elevation[i] + delta[i]);
  }
}

// 3. 🌧️ Rain-Splash & Sheetwash Pluvial Erosion
export function applyRainSplashErosion(
  width: number,
  height: number,
  elevation: Float32Array,
  precipitation: Float32Array,
  sediment: Float32Array,
  rockHardness: Float32Array,
  config: WorldGenConfig
): void {
  const strength = config.rainSplashErosionStrength ?? 1.0;
  const delta = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    const yIdx = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = yIdx + x;
      const h = elevation[idx];
      if (h <= config.seaLevel) continue;

      const rain = precipitation[idx];
      const hardness = rockHardness[idx];

      // Slope steepness
      const dhdx = (elevation[idx + 1] - elevation[idx - 1]) * 0.5;
      const dhdy = (elevation[idx + width] - elevation[idx - width]) * 0.5;
      const slope = Math.hypot(dhdx, dhdy);

      // Rain splash dislodgement rate
      if (slope > 0.01 && rain > 0.05) {
        const splashRate = rain * slope * (1.0 - hardness * 0.7) * 0.012 * strength;
        delta[idx] -= splashRate;
        sediment[idx] -= splashRate;

        // Transport fine silt to lowest neighbor
        let lowestIdx = idx;
        let minH = h;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nIdx = (y + dy) * width + (x + dx);
            if (elevation[nIdx] < minH) {
              minH = elevation[nIdx];
              lowestIdx = nIdx;
            }
          }
        }

        if (lowestIdx !== idx) {
          delta[lowestIdx] += splashRate * 0.85;
          sediment[lowestIdx] += splashRate * 0.85;
        }
      }
    }
  }

  for (let i = 0; i < elevation.length; i++) {
    elevation[i] = Math.max(0.0, elevation[i] + delta[i]);
  }
}

// 4. 🏞️ Fluvial / River Channel Hydraulic Droplet Erosion
export function applyHydraulicDroplets(
  width: number,
  height: number,
  elevation: Float32Array,
  precipitation: Float32Array,
  glacierIce: Float32Array,
  sedimentMap: Float32Array,
  soilType: Uint8Array,
  rockHardness: Float32Array,
  config: WorldGenConfig,
  customParams?: Partial<ErosionParameters>
): void {
  const params = { ...DEFAULT_EROSION_PARAMS, ...customParams };
  params.dropletCount = customParams?.dropletCount ?? config.erosionDroplets;
  params.erodeSpeed = (customParams?.erodeSpeed ?? 0.32) * (config.riverErosionStrength ?? 1.0);

  const totalCells = width * height;
  const rng = new FastRandom(config.seed + 999);

  // Brush offsets & weights
  const radius = params.brushRadius;
  const brushOffsets: { dx: number; dy: number; weight: number }[] = [];
  let weightSum = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= radius) {
        const w = 1.0 - d / (radius + 0.5);
        brushOffsets.push({ dx, dy, weight: w });
        weightSum += w;
      }
    }
  }
  for (const b of brushOffsets) {
    b.weight /= weightSum;
  }

  // Pre-filter candidate land cells weighted by precipitation
  const candidateIndices: number[] = [];
  for (let idx = 0; idx < totalCells; idx++) {
    if (elevation[idx] > config.seaLevel) {
      const rainWeight = Math.max(0.1, precipitation[idx] + glacierIce[idx] * 1.5);
      const count = Math.ceil(rainWeight * 3);
      for (let k = 0; k < count; k++) {
        candidateIndices.push(idx);
      }
    }
  }

  const numCandidates = candidateIndices.length;
  if (numCandidates === 0) return;

  const totalDroplets = params.dropletCount;

  for (let drop = 0; drop < totalDroplets; drop++) {
    const startIdx = candidateIndices[Math.floor(rng.next() * numCandidates)];
    let posX = startIdx % width;
    let posY = Math.floor(startIdx / width);
    let dirX = 0;
    let dirY = 0;
    let speed = params.initialSpeed;
    let water = params.initialWaterVolume;
    let sediment = 0;

    for (let lifetime = 0; lifetime < params.maxDropletLifetime; lifetime++) {
      const nodeX = Math.floor(posX);
      const nodeY = Math.floor(posY);
      const cellOffsetX = posX - nodeX;
      const cellOffsetY = posY - nodeY;

      if (nodeX < 1 || nodeX >= width - 2 || nodeY < 1 || nodeY >= height - 2) break;

      const idxNW = nodeY * width + nodeX;
      const idxNE = idxNW + 1;
      const idxSW = idxNW + width;
      const idxSE = idxSW + 1;

      const hNW = elevation[idxNW];
      const hNE = elevation[idxNE];
      const hSW = elevation[idxSW];
      const hSE = elevation[idxSE];

      const gradX = (hNE - hNW) * (1.0 - cellOffsetY) + (hSE - hSW) * cellOffsetY;
      const gradY = (hSW - hNW) * (1.0 - cellOffsetX) + (hSE - hNE) * cellOffsetX;

      const currentHeight =
        hNW * (1.0 - cellOffsetX) * (1.0 - cellOffsetY) +
        hNE * cellOffsetX * (1.0 - cellOffsetY) +
        hSW * (1.0 - cellOffsetX) * cellOffsetY +
        hSE * cellOffsetX * cellOffsetY;

      if (currentHeight <= config.seaLevel) {
        // Delta deposition
        const deposit = sediment * 0.8;
        elevation[idxNW] += deposit * (1.0 - cellOffsetX) * (1.0 - cellOffsetY);
        elevation[idxNE] += deposit * cellOffsetX * (1.0 - cellOffsetY);
        elevation[idxSW] += deposit * (1.0 - cellOffsetX) * cellOffsetY;
        elevation[idxSE] += deposit * cellOffsetX * cellOffsetY;
        sedimentMap[idxNW] += deposit;
        soilType[idxNW] = 4; // Sand/alluvium delta
        break;
      }

      // Update droplet direction along -gradient with inertia
      dirX = dirX * params.inertia - gradX * (1.0 - params.inertia);
      dirY = dirY * params.inertia - gradY * (1.0 - params.inertia);

      let len = Math.hypot(dirX, dirY);
      if (len < 1e-4) {
        dirX = rng.nextFloat(-1, 1);
        dirY = rng.nextFloat(-1, 1);
        len = Math.hypot(dirX, dirY);
      }

      if (len > 0) {
        dirX /= len;
        dirY /= len;
      } else break;

      const newPosX = posX + dirX;
      const newPosY = posY + dirY;

      if (newPosX < 1 || newPosX >= width - 2 || newPosY < 1 || newPosY >= height - 2) break;

      const newNodeX = Math.floor(newPosX);
      const newNodeY = Math.floor(newPosY);
      const newCellOffsetX = newPosX - newNodeX;
      const newCellOffsetY = newPosY - newNodeY;

      const newIdxNW = newNodeY * width + newNodeX;
      const newIdxNE = newIdxNW + 1;
      const newIdxSW = newIdxNW + width;
      const newIdxSE = newIdxSW + 1;

      const newHeight =
        elevation[newIdxNW] * (1.0 - newCellOffsetX) * (1.0 - newCellOffsetY) +
        elevation[newIdxNE] * newCellOffsetX * (1.0 - newCellOffsetY) +
        elevation[newIdxSW] * (1.0 - newCellOffsetX) * newCellOffsetY +
        elevation[newIdxSE] * newCellOffsetX * newCellOffsetY;

      const deltaHeight = newHeight - currentHeight;

      // Sediment carrying capacity (scaled inversely by local rock hardness)
      const hardness = rockHardness[idxNW];
      const capacity = Math.max(
        Math.max(0.0, -deltaHeight) * speed * water * params.sedimentCapacity * (1.2 - hardness * 0.4),
        params.minSedimentCapacity
      );

      if (sediment > capacity || deltaHeight > 0) {
        // Deposition (alluvial fan / flat valley)
        const amountToDeposit = deltaHeight > 0
          ? Math.min(deltaHeight, sediment)
          : (sediment - capacity) * params.depositSpeed;

        sediment -= amountToDeposit;

        elevation[idxNW] += amountToDeposit * (1.0 - cellOffsetX) * (1.0 - cellOffsetY);
        elevation[idxNE] += amountToDeposit * cellOffsetX * (1.0 - cellOffsetY);
        elevation[idxSW] += amountToDeposit * (1.0 - cellOffsetX) * cellOffsetY;
        elevation[idxSE] += amountToDeposit * cellOffsetX * cellOffsetY;
        sedimentMap[idxNW] += amountToDeposit;
        if (amountToDeposit > 0.01) soilType[idxNW] = 4; // Alluvium
      } else {
        // Fluvial hydraulic carving: realistic incremental grain transport
        const amountToErode = Math.min(
          0.008,
          Math.min((capacity - sediment) * params.erodeSpeed * 0.08 * (1.1 - hardness * 0.6), -deltaHeight * 0.1)
        );

        for (const b of brushOffsets) {
          const bx = nodeX + b.dx;
          const by = nodeY + b.dy;
          if (bx >= 0 && bx < width && by >= 0 && by < height) {
            const bIdx = by * width + bx;
            const eroded = amountToErode * b.weight;
            elevation[bIdx] = Math.max(0.0, elevation[bIdx] - eroded);
            sedimentMap[bIdx] -= eroded;
          }
        }

        sediment += amountToErode;
      }

      // Gravitational acceleration downhill
      speed = Math.sqrt(Math.max(0.01, speed * speed - deltaHeight * params.gravity));
      water *= (1.0 - params.evaporateSpeed);

      posX = newPosX;
      posY = newPosY;
    }
  }
}

// 5. 💨 Aeolian Wind Abrasion & Desert Deflation
export function applyAeolianWindErosion(
  width: number,
  height: number,
  elevation: Float32Array,
  moisture: Float32Array,
  windU: Float32Array,
  windV: Float32Array,
  sediment: Float32Array,
  soilType: Uint8Array,
  config: WorldGenConfig
): void {
  const strength = config.windErosionStrength ?? 1.0;
  const delta = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    const yIdx = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = yIdx + x;
      const h = elevation[idx];
      if (h <= config.seaLevel) continue;

      const m = moisture[idx];
      // Wind erosion is strongest in dry, arid regions (deserts & badlands)
      if (m < 0.35) {
        const aridityFactor = 1.0 - m / 0.35;
        const wu = windU[idx];
        const wv = windV[idx];
        const windSpeed = Math.hypot(wu, wv);

        // Sample upwind slope facing wind direction
        const upX = Math.max(0, Math.min(width - 1, Math.round(x - wu * 2)));
        const upY = Math.max(0, Math.min(height - 1, Math.round(y - wv * 2)));
        const upIdx = upY * width + upX;
        const windwardSlope = Math.max(0.0, h - elevation[upIdx]);

        if (windwardSlope > 0.005) {
          // Windward abrasion (sandblasting rock face)
          const abrade = windwardSlope * windSpeed * aridityFactor * 0.01 * strength;
          delta[idx] -= abrade;
          sediment[idx] -= abrade;

          // Downwind sand dune deposition (in sheltered leeward hollow)
          const downX = Math.max(0, Math.min(width - 1, Math.round(x + wu * 3)));
          const downY = Math.max(0, Math.min(height - 1, Math.round(y + wv * 3)));
          const downIdx = downY * width + downX;
          if (elevation[downIdx] > config.seaLevel) {
            delta[downIdx] += abrade * 0.75;
            sediment[downIdx] += abrade * 0.75;
            soilType[downIdx] = 4; // Sand dunes
          }
        }
      }
    }
  }

  for (let i = 0; i < elevation.length; i++) {
    elevation[i] = Math.max(0.0, elevation[i] + delta[i]);
  }
}

// 6. ❄️ Cryospheric Glacial U-Valley Gouging
export function applyGlacialCarving(
  width: number,
  height: number,
  elevation: Float32Array,
  glacierIce: Float32Array,
  soilType: Uint8Array,
  config: WorldGenConfig
): void {
  const strength = config.glacierErosionStrength ?? 1.0;
  const delta = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    const yIdx = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = yIdx + x;
      const ice = glacierIce[idx];

      if (ice > 0.2) {
        const h = elevation[idx];
        const hN = elevation[idx - width];
        const hS = elevation[idx + width];
        const hW = elevation[idx - 1];
        const hE = elevation[idx + 1];

        // Parabolic U-valley carving
        const avg = (hN + hS + hW + hE) * 0.25;
        if (h > avg) {
          const carve = (h - avg) * ice * 0.25 * strength;
          delta[idx] -= carve;
          soilType[idx] = 5; // Glacial till
        }
      }
    }
  }

  for (let i = 0; i < elevation.length; i++) {
    elevation[i] = Math.max(0.0, elevation[i] + delta[i]);
  }
}

// 7. ⛰️ Gravitational Mass Wasting & Angle of Repose by Rock/Soil Type
export function applyGravitationalMassWasting(
  width: number,
  height: number,
  elevation: Float32Array,
  soilType: Uint8Array,
  iterations: number = 4
): void {
  const neighbors = [
    { dx: -1, dy: 0, d: 1.0 },
    { dx: 1, dy: 0, d: 1.0 },
    { dx: 0, dy: -1, d: 1.0 },
    { dx: 0, dy: 1, d: 1.0 },
    { dx: -1, dy: -1, d: 1.414 },
    { dx: 1, dy: -1, d: 1.414 },
    { dx: -1, dy: 1, d: 1.414 },
    { dx: 1, dy: 1, d: 1.414 },
  ];

  const delta = new Float32Array(width * height);

  for (let it = 0; it < iterations; it++) {
    delta.fill(0);

    for (let y = 1; y < height - 1; y++) {
      const yIdx = y * width;
      for (let x = 1; x < width - 1; x++) {
        const idx = yIdx + x;
        const h = elevation[idx];

        // Determine critical angle of repose based on local rock/soil type
        const st = soilType[idx];
        const criticalAngle = ROCK_SOIL_DEFINITIONS[st]?.criticalAngle ?? 0.45;

        let maxSlope = 0;
        let lowestNeighborIdx = -1;

        for (const n of neighbors) {
          const nIdx = (y + n.dy) * width + (x + n.dx);
          const nh = elevation[nIdx];
          const slope = (h - nh) / n.d;

          if (slope > maxSlope) {
            maxSlope = slope;
            lowestNeighborIdx = nIdx;
          }
        }

        // Mass wasting: slope exceeds critical angle -> rockslide/slumping
        if (maxSlope > criticalAngle && lowestNeighborIdx !== -1) {
          const transfer = (maxSlope - criticalAngle) * 0.16;
          delta[idx] -= transfer;
          delta[lowestNeighborIdx] += transfer;

          // Material falling forms loose scree / talus
          if (transfer > 0.015) {
            soilType[lowestNeighborIdx] = 4; // Scree
          }
        }
      }
    }

    for (let i = 0; i < elevation.length; i++) {
      elevation[i] = Math.max(0.0, elevation[i] + delta[i]);
    }
  }
}

// Cordonnier 2016 & O'Leary 2016: Stream Power Law Fluvial Incision E = K * A^m * S^n with Lithology and Topological Traversal
export function applyStreamPowerFluvialErosion(
  width: number,
  _height: number,
  elevation: Float32Array,
  flux: Float32Array,
  flowReceivers: Int32Array,
  seaLevel: number,
  iterations: number = 2,
  K_erode: number = 0.00015,
  rockHardness?: Float32Array,
  topologicalIndices?: Int32Array
): void {
  const totalCells = elevation.length;
  const numIndices = topologicalIndices ? topologicalIndices.length : totalCells;

  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < numIndices; i++) {
      // Traverse in topological elevation order if available, else linear
      const idx = topologicalIndices ? topologicalIndices[i] : i;
      const h = elevation[idx];
      if (h <= seaLevel) continue;

      const receiver = flowReceivers[idx];
      if (receiver < 0 || receiver === idx) continue;

      const recH = elevation[receiver];
      const deltaH = h - recH;
      if (deltaH <= 0.00001) continue;

      const rx = receiver % width;
      const ry = Math.floor(receiver / width);
      const x = idx % width;
      const y = Math.floor(idx / width);
      const dist = Math.hypot(rx - x, ry - y) || 1.0;

      const slope = deltaH / dist;
      const areaFlux = Math.sqrt(Math.max(1.0, flux[idx]));

      // Lithological resistance: hard granite resists incision; soft regolith/sediment carves deeper
      const hardness = rockHardness ? rockHardness[idx] : 0.65;
      const lithoFactor = Math.max(0.2, 1.35 - 0.7 * hardness);

      // Incision depth = K * sqrt(A) * slope * lithoFactor
      const incision = Math.min(deltaH * 0.45, K_erode * areaFlux * slope * lithoFactor);
      elevation[idx] -= incision;
    }
  }
}

// Cordonnier 2016: Laplacian Hillslope Diffusion / Soil Creep modulated by Lithology
export function applyLaplacianHillslopeDiffusion(
  width: number,
  height: number,
  elevation: Float32Array,
  seaLevel: number,
  iterations: number = 2,
  D: number = 0.045,
  rockHardness?: Float32Array
): void {
  const temp = new Float32Array(elevation);

  for (let it = 0; it < iterations; it++) {
    for (let y = 1; y < height - 1; y++) {
      const yIdx = y * width;
      for (let x = 1; x < width - 1; x++) {
        const idx = yIdx + x;
        const h = temp[idx];
        if (h <= seaLevel) continue;

        const hN = temp[idx - width];
        const hS = temp[idx + width];
        const hW = temp[idx - 1];
        const hE = temp[idx + 1];

        // 5-point discrete Laplacian
        const laplacian = (hN + hS + hW + hE) - 4.0 * h;

        // Lithology: soft soils creep and smooth faster; hard bedrock preserves sharp crags
        const hardness = rockHardness ? rockHardness[idx] : 0.65;
        const diffRate = D * Math.max(0.3, 1.4 - 0.8 * hardness);

        elevation[idx] = Math.max(seaLevel + 0.0001, h + diffRate * laplacian);
      }
    }
    temp.set(elevation);
  }
}

// Backward compatibility helper
export function simulateHydraulicErosion(
  width: number,
  height: number,
  elevation: Float32Array,
  precipitation: Float32Array,
  glacierIce: Float32Array,
  config: WorldGenConfig,
  customParams?: Partial<ErosionParameters>,
  onProgress?: (progress: number) => void
): { elevation: Float32Array; sediment: Float32Array } {
  const currentElev = new Float32Array(elevation);
  const sediment = new Float32Array(width * height);
  const soilType = new Uint8Array(width * height);
  const rockHardness = new Float32Array(width * height).fill(0.6);

  applyHydraulicDroplets(
    width,
    height,
    currentElev,
    precipitation,
    glacierIce,
    sediment,
    soilType,
    rockHardness,
    config,
    customParams
  );

  applyGravitationalMassWasting(width, height, currentElev, soilType, 3);
  applyLaplacianHillslopeDiffusion(width, height, currentElev, config.seaLevel, 1, 0.035);
  if (onProgress) onProgress(1.0);

  return { elevation: currentElev, sediment };
}

export function applyThermalErosion(
  width: number,
  height: number,
  elevation: Float32Array,
  talusAngle: number = 0.45,
  iterations: number = 3
): void {
  const soilType = new Uint8Array(width * height).fill(2);
  ROCK_SOIL_DEFINITIONS[2].criticalAngle = talusAngle;
  applyGravitationalMassWasting(width, height, elevation, soilType, iterations);
}

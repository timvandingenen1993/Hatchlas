/**
 * Climate for the flat-grid world: temperature, wind and orographic rainfall.
 */
import { SimplexNoise } from './noise';
import type { WorldGenConfig } from '../types/map';

export interface ClimateResult {
  temperature: Float32Array; // in °C
  moisture: Float32Array;    // [0, 1]
  precipitation: Float32Array; // rainfall + snow [0, 1]
  glacierIce: Float32Array;  // ice thickness [0, 1]
  windVectorsU: Float32Array; // Wind X component
  windVectorsV: Float32Array; // Wind Y component
}

/**
 * Physically-Based Atmospheric Climatology & Meso-Scale Orographic Precipitation Engine
 * 
 * References:
 * 1. Smith & Barstad (2004): "A Linear Model of Orographic Precipitation", J. Atmos. Sci.
 *    (Uses atmospheric scale-height spatial transfer function to filter micro-terrain noise).
 * 2. Hartmann (1994): "Global Physical Climatology", Academic Press.
 * 3. Génevaux et al. (2013): "Terrain Generation using Procedural Models based on Hydrology", ACM TOG.
 */
export function simulateClimate(
  width: number,
  height: number,
  elevation: Float32Array,
  config: WorldGenConfig
): ClimateResult {
  const totalCells = width * height;
  const temperature = new Float32Array(totalCells);
  const moisture = new Float32Array(totalCells);
  const precipitation = new Float32Array(totalCells);
  const glacierIce = new Float32Array(totalCells);
  const windU = new Float32Array(totalCells);
  const windV = new Float32Array(totalCells);

  const simplex = new SimplexNoise(config.seed + 333);
  const halfH = height / 2;
  const seaLevel = config.seaLevel;

  // 1. Continuous C^inf Planetary Zonal Wind Harmonics (Hartmann 1994)
  for (let y = 0; y < height; y++) {
    const phi = ((y - halfH) / halfH) * (Math.PI / 2);

    // Continuous 3-cell circulation harmonic profile
    const zonalU = -Math.cos(3.0 * phi) + 0.30 * Math.cos(phi) - 0.20 * Math.cos(5.0 * phi);
    const meridionalV = -Math.sin(3.0 * phi) * 0.28;

    const yIdx = y * width;
    for (let x = 0; x < width; x++) {
      const idx = yIdx + x;

      const nx = (x / width) * 3.5;
      const ny = (y / height) * 3.5;
      const vortexU = simplex.noise2D(nx, ny) * 0.22;
      const vortexV = simplex.noise2D(nx + 17.1, ny + 43.7) * 0.22;

      const rawU = (zonalU + vortexU) * (config.windStrength ?? 1.0);
      const rawV = (meridionalV + vortexV) * (config.windStrength ?? 1.0);
      const len = Math.hypot(rawU, rawV) || 1.0;

      windU[idx] = rawU / len;
      windV[idx] = rawV / len;
    }
  }

  // 2. Solar Insolation & Thermodynamic Temperature Field
  for (let y = 0; y < height; y++) {
    const latNorm = Math.abs((y - halfH) / halfH);
    const solarInsolation = Math.cos(latNorm * (Math.PI / 2));
    const baseLatTemp = config.poleTemp + (config.equatorTemp - config.poleTemp) * solarInsolation;

    const yIdx = y * width;
    for (let x = 0; x < width; x++) {
      const idx = yIdx + x;
      const elev = elevation[idx];
      const isLand = elev > seaLevel;

      let temp = baseLatTemp;

      if (isLand) {
        // Standard lapse rate (-6.5 deg C per 1000m)
        const altitudeKm = ((elev - seaLevel) / Math.max(0.01, 1.0 - seaLevel)) * 4.2;
        temp -= (config.lapseRate ?? 6.5) * altitudeKm;
      } else {
        temp = temp * 0.82 + 15.0 * 0.18;
      }

      temp += simplex.noise2D((x / width) * 5.0, (y / height) * 5.0) * 1.0;
      temperature[idx] = temp;
    }
  }

  // 3. Meso-scale Atmospheric Terrain Filtering (Smith & Barstad 2004 scale height filter)
  // Atmospheric airflow responds to broad orographic mountain massifs, not single-pixel micro-facets
  const mesoElev = new Float32Array(totalCells);
  const filterRadius = Math.max(4, Math.floor(width / 64));

  for (let y = 0; y < height; y++) {
    const yIdx = y * width;
    for (let x = 0; x < width; x++) {
      let sumH = 0;
      let count = 0;
      for (let dy = -filterRadius; dy <= filterRadius; dy += 2) {
        const py = Math.max(0, Math.min(height - 1, y + dy));
        const pyIdx = py * width;
        for (let dx = -filterRadius; dx <= filterRadius; dx += 2) {
          const px = Math.max(0, Math.min(width - 1, x + dx));
          sumH += elevation[pyIdx + px];
          count++;
        }
      }
      mesoElev[yIdx + x] = sumH / count;
    }
  }

  // Calculate meso-scale forced orographic uplift: w = V . grad(h_meso)
  const orographicLift = new Float32Array(totalCells);
  for (let y = 0; y < height; y++) {
    const yN = Math.max(0, y - 1);
    const yS = Math.min(height - 1, y + 1);
    const yIdx = y * width;

    for (let x = 0; x < width; x++) {
      const idx = yIdx + x;
      const xW = Math.max(0, x - 1);
      const xE = Math.min(width - 1, x + 1);

      const dzdx = (mesoElev[y * width + xE] - mesoElev[y * width + xW]) * (width / 512.0);
      const dzdy = (mesoElev[yS * width + x] - mesoElev[yN * width + x]) * (height / 512.0);
      orographicLift[idx] = windU[idx] * dzdx + windV[idx] * dzdy;
    }
  }

  // 4. Planetary Continuous Moisture Advection & Rain Shadows (Smith & Barstad 2004)
  const raySteps = 24;
  const rayDist = Math.max(3.0, width / 90.0);
  const rainMultiplier = config.rainfallMultiplier ?? 1.2;

  for (let y = 0; y < height; y++) {
    const phi = ((y - halfH) / halfH) * (Math.PI / 2);
    const cosPhi = Math.cos(phi);
    const sin2Phi = Math.sin(2.0 * phi);
    // Continuous planetary zonal moisture baseline
    const zonalMoisture = 0.38 + 0.35 * Math.pow(cosPhi, 4.0) + 0.22 * Math.pow(sin2Phi, 2.0);
    const zonalPrecipBase = 0.20 + 0.35 * Math.pow(cosPhi, 4.0) + 0.25 * Math.pow(sin2Phi, 2.0);

    const yIdx = y * width;
    for (let x = 0; x < width; x++) {
      const idx = yIdx + x;
      const elev = elevation[idx];
      const temp = temperature[idx];
      const u = windU[idx];
      const v = windV[idx];

      if (elev <= seaLevel) {
        // Marine open water: Saturated evaporation source
        const marineSat = Math.max(0.65, Math.min(1.0, (temp + 14.0) / 38.0));
        moisture[idx] = marineSat;
        precipitation[idx] = marineSat * zonalPrecipBase * 0.70 * rainMultiplier;
        continue;
      }

      // Continental Landmass: Trace upwind streamline to calculate oceanic distance and rain shadow stripping
      let carriedMoisture = Math.max(0.70, (temp + 14.0) / 38.0);
      let foundOcean = false;
      let cumulativeRainShadow = 0.0;
      let prevMeso = mesoElev[idx];

      for (let s = 1; s <= raySteps; s++) {
        const sx = Math.round(x - u * s * rayDist);
        const sy = Math.round(y - v * s * rayDist);

        if (sx < 0 || sx >= width || sy < 0 || sy >= height) {
          if (!foundOcean) {
            carriedMoisture = Math.max(0.50, (temp + 14.0) / 38.0);
            foundOcean = true;
          }
          break;
        }

        const sIdx = sy * width + sx;
        const sElev = elevation[sIdx];

        if (sElev <= seaLevel) {
          // Reached ocean coastline
          const oceanTemp = temperature[sIdx];
          carriedMoisture = Math.max(0.65, Math.min(1.0, (oceanTemp + 14.0) / 38.0));
          foundOcean = true;
          break;
        }

        // Check if an upwind mountain ridge intercepted the moisture
        const sMeso = mesoElev[sIdx];
        const dMeso = sMeso - prevMeso;
        if (dMeso > 0.015) {
          cumulativeRainShadow += dMeso * 4.0;
        }
        prevMeso = sMeso;
      }

      // Exponential rain shadow moisture depletion behind mountain barriers
      const rainShadowFactor = Math.exp(-cumulativeRainShadow * 0.75);
      const continentalMoisture = (carriedMoisture * rainShadowFactor) * 0.65 + zonalMoisture * 0.35;

      // Forced orographic uplift on windward mountain slopes
      const lift = orographicLift[idx];
      const cw = Math.max(0.30, Math.min(1.0, (temp + 14.0) / 38.0));

      let orographicPrecip = 0.0;
      if (lift > 0.0005) {
        // Windward flank
        orographicPrecip = continentalMoisture * cw * Math.min(1.8, lift * 65.0) * 1.5;
      }

      // Total precipitation combining zonal ambient rain + orographic forced uplift
      const ambientPrecip = zonalPrecipBase * continentalMoisture * 0.45;
      const totalRain = Math.min(1.0, (ambientPrecip + orographicPrecip) * rainMultiplier);

      precipitation[idx] = totalRain;
      moisture[idx] = Math.max(0.08, Math.min(1.0, continentalMoisture * 0.60 + totalRain * 0.40));
    }
  }

  // 5. Hydrometeor Fallout Smoothing (Downwind Dispersion Tau_f in Smith & Barstad 2004)
  for (let y = 1; y < height - 1; y++) {
    const yIdx = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = yIdx + x;
      const p = precipitation[idx];
      const pN = precipitation[idx - width];
      const pS = precipitation[idx + width];
      const pW = precipitation[idx - 1];
      const pE = precipitation[idx + 1];

      precipitation[idx] = p * 0.50 + (pN + pS + pW + pE) * 0.125;
    }
  }

  // 6. Cryospheric Glacial Ice Sheet Formation on freezing land summits & polar sea ice
  const glacierThreshold = config.glacierTempThreshold ?? -2.0;
  for (let idx = 0; idx < totalCells; idx++) {
    const elev = elevation[idx];
    const temp = temperature[idx];
    const precip = precipitation[idx];

    if (temp < glacierThreshold) {
      const freezeFactor = Math.min(1.0, (glacierThreshold - temp) / 10.0);
      if (elev > seaLevel) {
        // Continental Ice Sheets, Alpine Glaciers & Perpetual Snowpack
        const iceThickness = freezeFactor * (0.30 + precip * 0.70);
        glacierIce[idx] = Math.min(1.0, iceThickness);
      } else {
        // Marine Polar Sea Ice & Perennial Ice Shelves
        const seaIceThickness = freezeFactor * 0.85;
        glacierIce[idx] = Math.min(1.0, seaIceThickness);
      }
    } else {
      glacierIce[idx] = 0.0;
    }
  }

  return {
    temperature,
    moisture,
    precipitation,
    glacierIce,
    windVectorsU: windU,
    windVectorsV: windV,
  };
}

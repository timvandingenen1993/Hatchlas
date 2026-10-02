import { cellCenterDistanceMeters, type CubedSphereGrid } from '../geometry/cubedSphere';
import type { SimulationConfig } from '../types/config';
import type { ClimateData } from '../types/worldV2';

/**
 * 12-Month Seasonal Climatology, Directional Orography & Moisture Advection
 * 
 * Note: Computes seasonal temperatures via Stefan-Boltzmann blackbody radiation balance,
 * lapse rate cooling, and thermal inertia, paired with a multi-pass cellular upwind
 * moisture advection scheme that extracts orographic rainfall on windward slopes and
 * simulates rain shadows. This is a cellular approximation rather than a full Smith-Barstad
 * linear spectral model or PDE Navier-Stokes circulation.
 * 
 * References:
 * 1. Hartmann (1994), "Global Physical Climatology", Academic Press (Chapter 4: Energy Balance, Chapter 5: Hydrologic Cycle).
 * 2. Peixoto & Oort (1992), "Physics of Climate", American Institute of Physics - Climatological principles.
 * 3. Roe (2005), "Orography and Precipitation", Annual Review of Earth and Planetary Sciences - Orographic precipitation mechanics.
 */
export function simulateSeasonalClimate(
  grid: CubedSphereGrid,
  insolationWm2: Float32Array[],
  windU: Float32Array[],
  windV: Float32Array[],
  elevation: Float32Array,
  config: SimulationConfig
): ClimateData {
  const totalCells = grid.totalCells;

  const monthlyTemperature: Float32Array[] = [];
  const monthlyPrecipitation: Float32Array[] = [];

  const annualMeanTemp = new Float32Array(totalCells);
  const annualTotalPrecip = new Float32Array(totalCells);
  const annualTotalEvap = new Float32Array(totalCells);
  const iceThickness = new Float32Array(totalCells);

  const SIGMA_SB = 5.670374e-8;
  const EMISSIVITY = 0.61;
  const LAPSE_RATE_PER_M = config.lapseRateDegCPerKm / 1000.0;
  const greenhouseFactor = Math.max(0.8, Math.min(1.5, config.greenhouseEffect));

  function windNeighbor(idx: number, u: number, v: number, upwind: boolean): number {
    const p = idx * 3;
    const lat = grid.cellLatitudes[idx];
    const lon = grid.cellLongitudes[idx];
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon);
    const cosLon = Math.cos(lon);
    const windX = u * -sinLon + v * -sinLat * cosLon;
    const windY = u * cosLon + v * -sinLat * sinLon;
    const windZ = v * cosLat;
    const speed = Math.hypot(windX, windY, windZ);
    if (speed < 1e-6) return idx;

    const px = grid.cellPositions[p];
    const py = grid.cellPositions[p + 1];
    const pz = grid.cellPositions[p + 2];
    let selected = idx;
    let selectedScore = upwind ? Infinity : -Infinity;

    for (let k = 0; k < 4; k++) {
      const nIdx = grid.neighbors[idx * 4 + k];
      const np = nIdx * 3;
      const dx = grid.cellPositions[np] - px;
      const dy = grid.cellPositions[np + 1] - py;
      const dz = grid.cellPositions[np + 2] - pz;
      // Candidate edge lengths differ only modestly on the equiangular grid;
      // use the tangent projection for direction selection and reserve the
      // metric distance for the CFL transport weight below.
      const score = dx * windX + dy * windY + dz * windZ;
      if ((upwind && score < selectedScore) || (!upwind && score > selectedScore)) {
        selected = nIdx;
        selectedScore = score;
      }
    }
    return selected;
  }

  // 1. Compute 12-Month Surface Blackbody Temperature & Thermal Inertia
  for (let m = 0; m < 12; m++) {
    const insol = insolationWm2[m];
    const tempMonth = new Float32Array(totalCells);

    for (let idx = 0; idx < totalCells; idx++) {
      const isOcean = elevation[idx] <= 0.0;
      const phi = grid.cellLatitudes[idx];
      const elev = Math.max(0, elevation[idx]);

      const isHighLatitude = Math.abs(phi) > (65 * Math.PI) / 180.0;
      const baseAlbedo = isOcean ? 0.08 : isHighLatitude ? 0.45 : 0.22;

      const sAbs = insol[idx] * (1.0 - baseAlbedo);
      const effFlux = Math.max(30.0, sAbs * greenhouseFactor);

      const tKelvin = Math.pow(effFlux / (EMISSIVITY * SIGMA_SB), 0.25);
      let tRawCelsius = tKelvin - 273.15;

      let tSeaLevelCelsius = tRawCelsius * 0.70 + 14.8 * 0.30;

      if (isOcean) {
        if (isHighLatitude) {
          tSeaLevelCelsius = Math.min(-6.0, tSeaLevelCelsius * 0.90 - 2.0);
        } else {
          tSeaLevelCelsius = Math.max(-1.8, Math.min(29.0, tSeaLevelCelsius * 0.85 + 3.0));
        }
      } else {
        const seasonalAmp = Math.sin((m / 12) * 2 * Math.PI);
        const latAmp = Math.sin(phi) * 10.0;
        tSeaLevelCelsius += latAmp * seasonalAmp * 0.35;
      }

      const tSurface = tSeaLevelCelsius - elev * LAPSE_RATE_PER_M;
      tempMonth[idx] = tSurface;
      annualMeanTemp[idx] += tSurface / 12.0;
    }

    monthlyTemperature.push(tempMonth);
  }

  // 2. Compute 12-Month Evaporation, Atmospheric Moisture Advection, and Orographic Flank Precipitation
  for (let m = 0; m < 12; m++) {
    const tempMonth = monthlyTemperature[m];
    const uMonth = windU[m];
    const vMonth = windV[m];

    const precipMonth = new Float32Array(totalCells);
    const evapMonth = new Float32Array(totalCells);
    const atmosphericMoisture = new Float32Array(totalCells);

    // Initialize moisture from ocean evaporation based on Clausius-Clapeyron capacity
    for (let idx = 0; idx < totalCells; idx++) {
      const isOcean = elevation[idx] <= 0.0;
      const t = tempMonth[idx];
      const qSat = Math.max(0.5, 5.0 * Math.exp((17.27 * t) / (t + 237.3)));

      if (isOcean) {
        const evapRate = Math.max(15.0, qSat * 28.0);
        evapMonth[idx] = evapRate;
        atmosphericMoisture[idx] = qSat * 1.8; // Saturated oceanic boundary layer
      } else {
        const evapRate = Math.max(1.0, qSat * 3.5);
        evapMonth[idx] = evapRate;
        atmosphericMoisture[idx] = qSat * 0.25; // Dry initial continental air
      }
      annualTotalEvap[idx] += evapMonth[idx];
    }

    // Conservative directional advection. Fluxes are computed from the old
    // state and applied to a separate array, so traversal order and cube-face
    // seams cannot create or destroy atmospheric water.
    const advectionPasses = Math.max(1, Math.min(3, Math.ceil(config.windStrength * 2.0)));
    for (let pass = 0; pass < advectionPasses; pass++) {
      const delta = new Float32Array(totalCells);
      for (let idx = 0; idx < totalCells; idx++) {
        const u = uMonth[idx];
        const v = vMonth[idx];
        const speed = Math.hypot(u, v);
        if (speed < 0.01 || atmosphericMoisture[idx] <= 0) continue;

        const downIdx = windNeighbor(idx, u, v, false);
        if (downIdx === idx) continue;
        const distance = Math.max(1.0, Math.sqrt(grid.cellAreas[idx]));
        // Six-hour transport substep; CFL is explicitly bounded below one.
        const weight = Math.min(0.45, Math.max(0.02, (speed * 21600.0) / distance));
        const flux = atmosphericMoisture[idx] * weight;
        delta[idx] -= flux;
        delta[downIdx] += flux;
      }
      for (let idx = 0; idx < totalCells; idx++) {
        atmosphericMoisture[idx] = Math.max(0.0, atmosphericMoisture[idx] + delta[idx]);
      }

      // Orographic condensation removes exactly the amount added to rainfall.
      for (let idx = 0; idx < totalCells; idx++) {
        if (elevation[idx] <= 0.0 || atmosphericMoisture[idx] <= 0) continue;
        const upIdx = windNeighbor(idx, uMonth[idx], vMonth[idx], true);
        const distance = Math.max(1.0, cellCenterDistanceMeters(grid, idx, upIdx));
        const windwardSlope = Math.max(0.0, (elevation[idx] - elevation[upIdx]) / distance);
        const extractionFraction = Math.min(0.45, Math.max(0.0,
          config.orographicRainfallScale * windwardSlope * 200.0 * (Math.hypot(uMonth[idx], vMonth[idx]) / 10.0),
        ));
        const extracted = atmosphericMoisture[idx] * extractionFraction;
        atmosphericMoisture[idx] -= extracted;
        precipMonth[idx] += extracted;
      }
    }

    // Add Zonal Convective Baseline Precipitation (ITCZ, Storm Tracks) modulated by remaining moisture
    for (let idx = 0; idx < totalCells; idx++) {
      const phi = grid.cellLatitudes[idx];
      const q = atmosphericMoisture[idx];

      // ITCZ equatorial belt
      const itcz = Math.exp(-Math.pow(phi / 0.16, 2.0)) * 180.0;
      // Mid-latitude storm track
      const stormTrack = Math.exp(-Math.pow((Math.abs(phi) - 0.82) / 0.20, 2.0)) * 110.0;
      // Subtropical high subsidence
      const subtropSink = Math.exp(-Math.pow((Math.abs(phi) - 0.46) / 0.12, 2.0)) * 0.85;

      const zonalBaseline = (itcz + stormTrack + 15.0) * (1.0 - subtropSink);

      // Convective precipitation is also a sink from the moisture column;
      // there is no free precipitation floor in an arid cell.
      const convectiveFraction = Math.min(0.65, Math.max(0.02, zonalBaseline / 260.0));
      const convectivePrecip = q * convectiveFraction;
      atmosphericMoisture[idx] = Math.max(0.0, q - convectivePrecip);
      const totalP = convectivePrecip + precipMonth[idx];

      precipMonth[idx] = totalP;
      annualTotalPrecip[idx] += totalP;
    }

    monthlyPrecipitation.push(precipMonth);
  }

  // 3. Glacial Mass Balance & Ice Sheet Thickness Accumulation
  for (let idx = 0; idx < totalCells; idx++) {
    const isOcean = elevation[idx] <= 0.0;
    let annualSnowfallMm = 0;
    let annualMeltMm = 0;

    for (let m = 0; m < 12; m++) {
      const t = monthlyTemperature[m][idx];
      const p = monthlyPrecipitation[m][idx];

      if (t < 0.0) {
        annualSnowfallMm += p;
      } else {
        annualMeltMm += t * 16.0;
      }
    }

    const netBalanceMm = annualSnowfallMm - annualMeltMm;
    if (netBalanceMm > 0 && !isOcean) {
      const iceMeters = (netBalanceMm / 1000.0) * 16.0;
      iceThickness[idx] = Math.min(2800.0, iceMeters);
    } else if (isOcean && annualMeanTemp[idx] < -1.8) {
      iceThickness[idx] = Math.min(4.0, Math.abs(annualMeanTemp[idx] + 1.8) * 0.6);
    } else {
      iceThickness[idx] = 0.0;
    }
  }

  const temperatureSeasonality = new Float32Array(totalCells);
  const seaIceFraction = new Float32Array(totalCells);

  for (let idx = 0; idx < totalCells; idx++) {
    let tMin = Infinity, tMax = -Infinity;
    for (let m = 0; m < 12; m++) {
      const t = monthlyTemperature[m][idx];
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
    temperatureSeasonality[idx] = tMax - tMin;
    seaIceFraction[idx] = (elevation[idx] <= 0.0 && annualMeanTemp[idx] < -1.8) ? 1.0 : 0.0;
  }

  return {
    axialTiltDeg: config.axialTiltDeg,
    monthlyTemperature,
    monthlyPrecipitation,
    meanAnnualTemperature: annualMeanTemp,
    annualPrecipitation: annualTotalPrecip,
    annualEvaporation: annualTotalEvap,
    temperatureSeasonality,
    iceThickness,
    seaIceFraction,
  };
}

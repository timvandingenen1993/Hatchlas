import { describe, it, expect } from 'vitest';
import { buildCubedSphereGrid } from '../src/geometry/cubedSphere';
import { DEFAULT_SIMULATION_CONFIG } from '../src/types/config';
import { computeMonthlyInsolation } from '../src/climate/insolation';
import { computeSeasonalWinds } from '../src/climate/atmosphericCirculation';
import { simulateSeasonalClimate } from '../src/climate/seasonalMoisture';

describe('12-Month Seasonal Climate & Thermodynamics (Hartmann 1994 / Paradise 2022)', () => {
  it('should exhibit opposite seasonal temperature cycles between Northern and Southern Hemispheres', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const { monthlyDeclinationDeg, insolationWm2 } = computeMonthlyInsolation(
      grid.cellLatitudes,
      DEFAULT_SIMULATION_CONFIG.axialTiltDeg,
      DEFAULT_SIMULATION_CONFIG.solarConstantWm2
    );
    const { windU, windV } = computeSeasonalWinds(
      grid,
      monthlyDeclinationDeg,
      DEFAULT_SIMULATION_CONFIG.windStrength,
      DEFAULT_SIMULATION_CONFIG.seed
    );

    const uniformElev = new Float32Array(grid.totalCells).fill(100.0);
    const climate = simulateSeasonalClimate(grid, insolationWm2, windU, windV, uniformElev, DEFAULT_SIMULATION_CONFIG);

    // Find a North temperate cell (lat ~ +45°) and a South temperate cell (lat ~ -45°)
    let northIdx = 0, southIdx = 0;
    let minNorthDiff = 1e9, minSouthDiff = 1e9;

    for (let idx = 0; idx < grid.totalCells; idx++) {
      const latDeg = (grid.cellLatitudes[idx] * 180) / Math.PI;
      const nDiff = Math.abs(latDeg - 45);
      const sDiff = Math.abs(latDeg + 45);

      if (nDiff < minNorthDiff) { minNorthDiff = nDiff; northIdx = idx; }
      if (sDiff < minSouthDiff) { minSouthDiff = sDiff; southIdx = idx; }
    }

    const tNorthJan = climate.monthlyTemperature[0][northIdx]; // Month 0 = January (Winter in North)
    const tNorthJul = climate.monthlyTemperature[6][northIdx]; // Month 6 = July (Summer in North)

    const tSouthJan = climate.monthlyTemperature[0][southIdx]; // Month 0 = January (Summer in South)
    const tSouthJul = climate.monthlyTemperature[6][southIdx]; // Month 6 = July (Winter in South)

    // North: July must be significantly warmer than January
    expect(tNorthJul).toBeGreaterThan(tNorthJan + 10.0);
    // South: January must be significantly warmer than July
    expect(tSouthJan).toBeGreaterThan(tSouthJul + 10.0);
  });

  it('should demonstrate equator-to-pole global temperature gradient', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const { monthlyDeclinationDeg, insolationWm2 } = computeMonthlyInsolation(grid.cellLatitudes, 23.44, 1361);
    const { windU, windV } = computeSeasonalWinds(grid, monthlyDeclinationDeg, 1.0, 123);
    const uniformElev = new Float32Array(grid.totalCells).fill(0.0);
    const climate = simulateSeasonalClimate(grid, insolationWm2, windU, windV, uniformElev, DEFAULT_SIMULATION_CONFIG);

    let sumEquatorT = 0, countEquator = 0;
    let sumPolarT = 0, countPolar = 0;

    for (let idx = 0; idx < grid.totalCells; idx++) {
      const latDeg = Math.abs((grid.cellLatitudes[idx] * 180) / Math.PI);
      const mat = climate.meanAnnualTemperature[idx];

      if (latDeg < 15.0) {
        sumEquatorT += mat;
        countEquator++;
      } else if (latDeg > 75.0) {
        sumPolarT += mat;
        countPolar++;
      }
    }

    const meanEquator = sumEquatorT / countEquator;
    const meanPolar = sumPolarT / countPolar;

    expect(meanEquator).toBeGreaterThan(18.0); // Tropical warmth
    expect(meanPolar).toBeLessThan(-5.0);      // Sub-freezing polar cold
  });

  it('should compute physical annual evaporation distinguishing ocean and land surfaces', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    const { monthlyDeclinationDeg, insolationWm2 } = computeMonthlyInsolation(grid.cellLatitudes, 23.44, 1361);
    const { windU, windV } = computeSeasonalWinds(grid, monthlyDeclinationDeg, 1.0, 123);

    // Half land, half ocean
    const elev = new Float32Array(grid.totalCells);
    for (let idx = 0; idx < grid.totalCells; idx++) {
      elev[idx] = idx % 2 === 0 ? 500.0 : -500.0;
    }

    const climate = simulateSeasonalClimate(grid, insolationWm2, windU, windV, elev, DEFAULT_SIMULATION_CONFIG);

    expect(climate.annualEvaporation).toBeDefined();
    expect(climate.annualEvaporation.length).toBe(grid.totalCells);

    let oceanEvapSum = 0, oceanCount = 0;
    let landEvapSum = 0, landCount = 0;

    for (let idx = 0; idx < grid.totalCells; idx++) {
      const evap = climate.annualEvaporation[idx];
      expect(evap).toBeGreaterThan(0); // Evaporation must be positive

      if (elev[idx] <= 0) {
        oceanEvapSum += evap;
        oceanCount++;
      } else {
        landEvapSum += evap;
        landCount++;
      }
    }

    // Ocean boundary layer has higher evaporation capacity than dry land
    expect(oceanEvapSum / oceanCount).toBeGreaterThan(landEvapSum / landCount);
  });
});

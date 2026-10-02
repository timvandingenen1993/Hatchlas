import type { CubedSphereGrid } from '../geometry/cubedSphere';
import type { ClimateData, EcologyData } from '../types/worldV2';

/**
 * Ecoclimatic Biome Classification on Spherical World
 * References:
 * 1. Champreux et al. (2024), "How to Map Biomes", Ecol. Monogr.
 * 2. Whittaker (1975), "Communities and Ecosystems", Macmillan.
 * 3. Holdridge (1947), "Determination of World Plant Formations", Science.
 */
export function classifySphericalBiomes(
  grid: CubedSphereGrid,
  elevation: Float32Array,
  climate: ClimateData,
  seaLevelMeters: number = 0
): EcologyData {
  const totalCells = grid.totalCells;
  const biomes = new Uint8Array(totalCells);

  const {
    meanAnnualTemperature: mat,
    annualPrecipitation: map,
    iceThickness: ice,
    seaIceFraction: seaIce,
  } = climate;

  for (let idx = 0; idx < totalCells; idx++) {
    const elev = elevation[idx];
    const isLand = elev > seaLevelMeters;
    const T = mat[idx]; // Mean annual temp in °C
    const P = map[idx]; // Annual precip in mm/yr
    const iceThick = ice[idx];
    const sIce = seaIce[idx];

    // 1. Marine Biomes
    if (!isLand) {
      if (sIce > 0.65 || iceThick > 1.5) {
        biomes[idx] = 3; // Polar Sea Ice Cap
      } else if (sIce > 0.1) {
        biomes[idx] = 4; // Marginal Pack Ice Floes
      } else if (T > 21.0 && elev > -120) {
        biomes[idx] = 2; // Tropical Coral Reef
      } else if (elev > -250) {
        biomes[idx] = 1; // Continental Shelf Sea
      } else {
        biomes[idx] = 0; // Abyssal Ocean
      }
      continue;
    }

    // 2. Terrestrial Cryosphere: Continental Glaciers & Ice Sheets
    if (iceThick > 5.0 || T < -12.0) {
      biomes[idx] = 5; // Continental Glacial Ice Sheet
      continue;
    }

    // 3. High Alpine Peaks & Mountain Tundra (Treeline elevation rule)
    if (elev > 3400 || (elev > 1800 && T < 1.0)) {
      biomes[idx] = 17; // Alpine Tundra & Mountain Peaks
      continue;
    }

    // 4. Whittaker Ecoclimatic Matrix
    if (T < 0.0) {
      // Subarctic / Polar
      if (P < 350) {
        biomes[idx] = 6; // Arctic Tundra
      } else {
        biomes[idx] = 7; // Boreal Taiga Forest
      }
    } else if (T < 10.0) {
      // Cold Temperate
      if (P < 280) {
        biomes[idx] = 12; // Cold Continental Desert
      } else if (P < 650) {
        biomes[idx] = 10; // Temperate Grassland / Steppe
      } else if (P < 1100) {
        biomes[idx] = 9;  // Temperate Deciduous Forest
      } else if (P < 1600) {
        biomes[idx] = 7;  // Boreal Taiga Forest
      } else {
        biomes[idx] = 8;  // Temperate Rainforest
      }
    } else if (T < 21.0) {
      // Warm Temperate / Subtropical
      if (P < 250) {
        biomes[idx] = 13; // Hot Subtropical Desert
      } else if (P < 600) {
        biomes[idx] = 11; // Mediterranean Woodland / Chaparral
      } else if (P < 1250) {
        biomes[idx] = 9;  // Temperate Deciduous Forest
      } else {
        biomes[idx] = 8;  // Temperate Rainforest
      }
    } else {
      // Tropical (T >= 21°C)
      if (P < 300) {
        biomes[idx] = 13; // Hot Subtropical Desert
      } else if (P < 750) {
        biomes[idx] = 14; // Tropical Savanna / Scrub
      } else if (P < 1450) {
        biomes[idx] = 15; // Tropical Seasonal Forest
      } else {
        biomes[idx] = 16; // Tropical Rainforest
      }
    }
  }

  return { biomes };
}

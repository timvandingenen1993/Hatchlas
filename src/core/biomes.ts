/**
 * Biome table and classification from temperature, rainfall, elevation and ice.
 */
import type { BiomeDefinition } from '../types/map';

export const BiomeType = {
  DEEP_OCEAN: 0,
  SHALLOW_OCEAN: 1,
  CORAL_REEF: 2,
  BEACH: 3,
  GLACIER: 4,
  TUNDRA: 5,
  ALPINE_PEAKS: 6,
  TAIGA: 7,
  TEMPERATE_RAINFOREST: 8,
  TEMPERATE_DECIDUOUS: 9,
  GRASSLAND: 10,
  SHRUBLAND: 11,
  SAVANNA: 12,
  TROPICAL_RAINFOREST: 13,
  TROPICAL_SEASONAL: 14,
  HOT_DESERT: 15,
  COLD_DESERT: 16,
  MANGROVE_SWAMP: 17,
  VOLCANIC_WASTELAND: 18,
  ENCHANTED_GROVE: 19,
  CRYSTAL_CRAGS: 20,
  POLAR_SEA_ICE: 21,
  PACK_ICE_FLOES: 22,
} as const;

export type BiomeTypeKey = typeof BiomeType[keyof typeof BiomeType];

export const BIOMES: Record<number, BiomeDefinition> = {
  [BiomeType.DEEP_OCEAN]: {
    id: BiomeType.DEEP_OCEAN,
    name: 'Abyssal Deep Ocean',
    colorParchment: '#d8c7a6',
    colorSatellite: '#0c2340',
    colorSatelliteHigh: '#091c33',
    minTemp: -50,
    maxTemp: 50,
    minMoisture: 0,
    maxMoisture: 1,
    minElevation: 0,
    maxElevation: 0.25,
    treeDensity: 0,
    description: 'Vast, uncharted oceanic abysses with mysterious depths and sea monsters.',
  },
  [BiomeType.SHALLOW_OCEAN]: {
    id: BiomeType.SHALLOW_OCEAN,
    name: 'Shallow Waters & Coastal Sea',
    colorParchment: '#e2d5ba',
    colorSatellite: '#164e63',
    colorSatelliteHigh: '#0e7490',
    minTemp: -50,
    maxTemp: 50,
    minMoisture: 0,
    maxMoisture: 1,
    minElevation: 0.25,
    maxElevation: 0.38,
    treeDensity: 0,
    description: 'Coastal waters teeming with fish, archipelago channels, and coastal reefs.',
  },
  [BiomeType.CORAL_REEF]: {
    id: BiomeType.CORAL_REEF,
    name: 'Tropical Coral Reef',
    colorParchment: '#ded2b7',
    colorSatellite: '#06b6d4',
    colorSatelliteHigh: '#22d3ee',
    minTemp: 20,
    maxTemp: 50,
    minMoisture: 0.5,
    maxMoisture: 1,
    minElevation: 0.34,
    maxElevation: 0.38,
    treeDensity: 0,
    description: 'Luminous underwater coral formations in sun-drenched tropical lagoons.',
  },
  [BiomeType.BEACH]: {
    id: BiomeType.BEACH,
    name: 'Golden Shore / Coastline',
    colorParchment: '#e7dcbf',
    colorSatellite: '#d4b483',
    colorSatelliteHigh: '#e5cca0',
    minTemp: 0,
    maxTemp: 50,
    minMoisture: 0,
    maxMoisture: 1,
    minElevation: 0.38,
    maxElevation: 0.40,
    treeDensity: 0.05,
    treeType: 'palm',
    description: 'Sandy shores where ocean waves break against ancient coastlines.',
  },
  [BiomeType.GLACIER]: {
    id: BiomeType.GLACIER,
    name: 'Glacial Ice Sheet & Perpetual Snow',
    colorParchment: '#f4ebd0',
    colorSatellite: '#e2e8f0',
    colorSatelliteHigh: '#ffffff',
    minTemp: -50,
    maxTemp: -2,
    minMoisture: 0.2,
    maxMoisture: 1,
    minElevation: 0.38,
    maxElevation: 1.0,
    treeDensity: 0,
    description: 'Massive continental glaciers and permanent mountain snowpack.',
  },
  [BiomeType.ALPINE_PEAKS]: {
    id: BiomeType.ALPINE_PEAKS,
    name: 'High Alpine Crags & Peaks',
    colorParchment: '#c8b693',
    colorSatellite: '#64748b',
    colorSatelliteHigh: '#94a3b8',
    minTemp: -50,
    maxTemp: 5,
    minMoisture: 0,
    maxMoisture: 1,
    minElevation: 0.75,
    maxElevation: 1.0,
    treeDensity: 0.02,
    treeType: 'conifer',
    description: 'Jagged, windswept mountain peaks piercing the clouds.',
  },
  [BiomeType.TUNDRA]: {
    id: BiomeType.TUNDRA,
    name: 'Arctic & Alpine Tundra',
    colorParchment: '#ddcfb3',
    colorSatellite: '#849b89',
    colorSatelliteHigh: '#9eb4a3',
    minTemp: -20,
    maxTemp: 2,
    minMoisture: 0,
    maxMoisture: 0.6,
    minElevation: 0.38,
    maxElevation: 0.75,
    treeDensity: 0.08,
    treeType: 'dead',
    description: 'Permafrost plains covered in hardy mosses, lichens, and dwarf shrubs.',
  },
  [BiomeType.TAIGA]: {
    id: BiomeType.TAIGA,
    name: 'Boreal Taiga Forest',
    colorParchment: '#d0c2a5',
    colorSatellite: '#2d5a3f',
    colorSatelliteHigh: '#3b7252',
    minTemp: -10,
    maxTemp: 10,
    minMoisture: 0.3,
    maxMoisture: 0.8,
    minElevation: 0.38,
    maxElevation: 0.70,
    treeDensity: 0.65,
    treeType: 'conifer',
    description: 'Dense evergreen spruce, pine, and fir forests in cold northern regions.',
  },
  [BiomeType.TEMPERATE_RAINFOREST]: {
    id: BiomeType.TEMPERATE_RAINFOREST,
    name: 'Temperate Ancient Rainforest',
    colorParchment: '#cad7bd',
    colorSatellite: '#1e4620',
    colorSatelliteHigh: '#2d6a32',
    minTemp: 5,
    maxTemp: 18,
    minMoisture: 0.7,
    maxMoisture: 1.0,
    minElevation: 0.38,
    maxElevation: 0.70,
    treeDensity: 0.85,
    treeType: 'broadleaf',
    description: 'Misty coastal valleys filled with towering redwoods and lush moss.',
  },
  [BiomeType.TEMPERATE_DECIDUOUS]: {
    id: BiomeType.TEMPERATE_DECIDUOUS,
    name: 'Temperate Deciduous Forest',
    colorParchment: '#d4cbb3',
    colorSatellite: '#3f6212',
    colorSatelliteHigh: '#4d7c0f',
    minTemp: 8,
    maxTemp: 22,
    minMoisture: 0.4,
    maxMoisture: 0.75,
    minElevation: 0.38,
    maxElevation: 0.65,
    treeDensity: 0.55,
    treeType: 'broadleaf',
    description: 'Lush oak, birch, and maple woodlands with seasonal foliage.',
  },
  [BiomeType.GRASSLAND]: {
    id: BiomeType.GRASSLAND,
    name: 'Grassland / Steppe',
    colorParchment: '#ddd4ba',
    colorSatellite: '#65a30d',
    colorSatelliteHigh: '#84cc16',
    minTemp: 5,
    maxTemp: 25,
    minMoisture: 0.2,
    maxMoisture: 0.45,
    minElevation: 0.38,
    maxElevation: 0.65,
    treeDensity: 0.1,
    treeType: 'broadleaf',
    description: 'Rolling verdant plains and endless steppes where nomadic tribes roam.',
  },
  [BiomeType.SHRUBLAND]: {
    id: BiomeType.SHRUBLAND,
    name: 'Chaparral & Shrubland',
    colorParchment: '#d8cbaf',
    colorSatellite: '#854d0e',
    colorSatelliteHigh: '#a16207',
    minTemp: 14,
    maxTemp: 28,
    minMoisture: 0.15,
    maxMoisture: 0.35,
    minElevation: 0.38,
    maxElevation: 0.65,
    treeDensity: 0.2,
    treeType: 'broadleaf',
    description: 'Mediterranean scrubland and aromatic herb bushes.',
  },
  [BiomeType.SAVANNA]: {
    id: BiomeType.SAVANNA,
    name: 'Tropical Savanna',
    colorParchment: '#ded2b0',
    colorSatellite: '#ca8a04',
    colorSatelliteHigh: '#eab308',
    minTemp: 22,
    maxTemp: 38,
    minMoisture: 0.2,
    maxMoisture: 0.5,
    minElevation: 0.38,
    maxElevation: 0.60,
    treeDensity: 0.25,
    treeType: 'broadleaf',
    description: 'Vast golden grass savannas punctuated by solitary acacia trees.',
  },
  [BiomeType.TROPICAL_RAINFOREST]: {
    id: BiomeType.TROPICAL_RAINFOREST,
    name: 'Tropical Deep Jungle',
    colorParchment: '#c1d3af',
    colorSatellite: '#14532d',
    colorSatelliteHigh: '#166534',
    minTemp: 24,
    maxTemp: 40,
    minMoisture: 0.65,
    maxMoisture: 1.0,
    minElevation: 0.38,
    maxElevation: 0.65,
    treeDensity: 0.9,
    treeType: 'broadleaf',
    description: 'Impenetrable, ancient rainforests harboring lost temples and rich biodiversity.',
  },
  [BiomeType.TROPICAL_SEASONAL]: {
    id: BiomeType.TROPICAL_SEASONAL,
    name: 'Tropical Seasonal Monsoon Forest',
    colorParchment: '#cbdbb7',
    colorSatellite: '#15803d',
    colorSatelliteHigh: '#22c55e',
    minTemp: 20,
    maxTemp: 36,
    minMoisture: 0.45,
    maxMoisture: 0.7,
    minElevation: 0.38,
    maxElevation: 0.60,
    treeDensity: 0.6,
    treeType: 'broadleaf',
    description: 'Vibrant forests shaped by alternating dry and monsoon rain seasons.',
  },
  [BiomeType.HOT_DESERT]: {
    id: BiomeType.HOT_DESERT,
    name: 'Scorching Dunes & Sand Desert',
    colorParchment: '#e8dcbe',
    colorSatellite: '#d97706',
    colorSatelliteHigh: '#f59e0b',
    minTemp: 28,
    maxTemp: 50,
    minMoisture: 0.0,
    maxMoisture: 0.15,
    minElevation: 0.38,
    maxElevation: 0.65,
    treeDensity: 0.01,
    treeType: 'palm',
    description: 'Endless rolling sand dunes, rocky mesas, and shimmering heat mirages.',
  },
  [BiomeType.COLD_DESERT]: {
    id: BiomeType.COLD_DESERT,
    name: 'Cold High Plateau Desert',
    colorParchment: '#ded2bc',
    colorSatellite: '#a8a29e',
    colorSatelliteHigh: '#d6d3d1',
    minTemp: -15,
    maxTemp: 10,
    minMoisture: 0.0,
    maxMoisture: 0.15,
    minElevation: 0.50,
    maxElevation: 0.85,
    treeDensity: 0.02,
    description: 'Barren, rain-shadow high altitude plateaus swept by frigid winds.',
  },
  [BiomeType.MANGROVE_SWAMP]: {
    id: BiomeType.MANGROVE_SWAMP,
    name: 'Mangrove Marshes & Coastal Bogs',
    colorParchment: '#cad7be',
    colorSatellite: '#047857',
    colorSatelliteHigh: '#10b981',
    minTemp: 18,
    maxTemp: 35,
    minMoisture: 0.75,
    maxMoisture: 1.0,
    minElevation: 0.38,
    maxElevation: 0.42,
    treeDensity: 0.7,
    treeType: 'broadleaf',
    description: 'Tangled mangrove swamps and brackish estuaries where rivers meet the sea.',
  },
  [BiomeType.VOLCANIC_WASTELAND]: {
    id: BiomeType.VOLCANIC_WASTELAND,
    name: 'Volcanic Ashlands & Caldera',
    colorParchment: '#bfae98',
    colorSatellite: '#334155',
    colorSatelliteHigh: '#475569',
    minTemp: 0,
    maxTemp: 50,
    minMoisture: 0,
    maxMoisture: 1,
    minElevation: 0.65,
    maxElevation: 1.0,
    treeDensity: 0.05,
    treeType: 'dead',
    description: 'Obsidian crags, smoking fumaroles, and fertile basalt ash plains.',
  },
  [BiomeType.ENCHANTED_GROVE]: {
    id: BiomeType.ENCHANTED_GROVE,
    name: 'Mystic Sylvan Grove',
    colorParchment: '#d4e2c6',
    colorSatellite: '#0d9488',
    colorSatelliteHigh: '#14b8a6',
    minTemp: 10,
    maxTemp: 24,
    minMoisture: 0.6,
    maxMoisture: 1.0,
    minElevation: 0.40,
    maxElevation: 0.65,
    treeDensity: 0.8,
    treeType: 'broadleaf',
    description: 'Bioluminescent ancient woods inhabited by elven spirits and magical creatures.',
  },
  [BiomeType.CRYSTAL_CRAGS]: {
    id: BiomeType.CRYSTAL_CRAGS,
    name: 'Crystal Crags & Frost Peaks',
    colorParchment: '#dee2e6',
    colorSatellite: '#7dd3fc',
    colorSatelliteHigh: '#bae6fd',
    minTemp: -40,
    maxTemp: -5,
    minMoisture: 0.5,
    maxMoisture: 1.0,
    minElevation: 0.70,
    maxElevation: 1.0,
    treeDensity: 0,
    description: 'Gleaming towers of unmelting ice crystals and glowing arcane frost.',
  },
  [BiomeType.POLAR_SEA_ICE]: {
    id: BiomeType.POLAR_SEA_ICE,
    name: 'Perennial Polar Sea Ice & Ice Shelf',
    colorParchment: '#f8fafc',
    colorSatellite: '#f1f5f9',
    colorSatelliteHigh: '#ffffff',
    minTemp: -50,
    maxTemp: -6,
    minMoisture: 0,
    maxMoisture: 1,
    minElevation: 0,
    maxElevation: 0.38,
    treeDensity: 0,
    description: 'Vast, frozen polar sea ice cap and floating marine ice shelves with pressure ridges.',
  },
  [BiomeType.PACK_ICE_FLOES]: {
    id: BiomeType.PACK_ICE_FLOES,
    name: 'Marginal Pack Ice Floes & Drift Ice',
    colorParchment: '#edf2f7',
    colorSatellite: '#38bdf8',
    colorSatelliteHigh: '#e0f2fe',
    minTemp: -6,
    maxTemp: -1.5,
    minMoisture: 0,
    maxMoisture: 1,
    minElevation: 0,
    maxElevation: 0.38,
    treeDensity: 0,
    description: 'Drifting pack ice floes, fractured leads, and turquoise ice channels along the polar margin.',
  },
};

export function classifyBiomes(
  width: number,
  height: number,
  elevation: Float32Array,
  temperature: Float32Array,
  moisture: Float32Array,
  glacierIce: Float32Array,
  seaLevel: number,
  hotspots?: { x: number; y: number; radius: number }[]
): Uint8Array {
  const totalCells = width * height;
  const biomes = new Uint8Array(totalCells);

  for (let idx = 0; idx < totalCells; idx++) {
    const elev = elevation[idx];
    const temp = temperature[idx];
    const moist = moisture[idx];
    const ice = glacierIce[idx];
    const x = idx % width;
    const y = Math.floor(idx / width);

    // Check Volcanic Hotspots
    if (hotspots && elev > seaLevel) {
      let isVolcanic = false;
      for (const spot of hotspots) {
        const d = Math.hypot(x - spot.x, y - spot.y);
        if (d < spot.radius * 0.45) {
          biomes[idx] = BiomeType.VOLCANIC_WASTELAND;
          isVolcanic = true;
          break;
        }
      }
      if (isVolcanic) continue;
    }

    // 1. Water classification (including Polar Sea Ice & Pack Ice)
    if (elev <= seaLevel) {
      if (temp < -6.0 || ice > 0.35) {
        biomes[idx] = BiomeType.POLAR_SEA_ICE; // Solid polar ice cap / ice shelf
      } else if (temp < -1.8) {
        biomes[idx] = BiomeType.PACK_ICE_FLOES; // Marginal drifting pack ice
      } else if (elev < seaLevel * 0.65) {
        biomes[idx] = BiomeType.DEEP_OCEAN;
      } else if (temp > 22 && moist > 0.6 && elev > seaLevel * 0.88) {
        biomes[idx] = BiomeType.CORAL_REEF;
      } else {
        biomes[idx] = BiomeType.SHALLOW_OCEAN;
      }
      continue;
    }

    // 2. Coastal / Beach classification
    if (elev <= seaLevel + 0.018) {
      if (temp < -4.0) {
        biomes[idx] = BiomeType.GLACIER; // Icy coastline / glacier calving front
      } else if (temp > 18 && moist > 0.7) {
        biomes[idx] = BiomeType.MANGROVE_SWAMP;
      } else {
        biomes[idx] = BiomeType.BEACH;
      }
      continue;
    }

    // 3. Glacial ice sheets & perpetual snow
    if (ice > 0.25 || temp < -6.0) {
      if (elev > 0.8) {
        biomes[idx] = BiomeType.CRYSTAL_CRAGS;
      } else {
        biomes[idx] = BiomeType.GLACIER;
      }
      continue;
    }

    // 4. High Alpine mountain peaks
    if (elev > 0.78) {
      biomes[idx] = BiomeType.ALPINE_PEAKS;
      continue;
    }

    // 5. Whittaker diagram classification based on Temperature & Moisture
    if (temp < 0) {
      if (moist < 0.25) biomes[idx] = BiomeType.COLD_DESERT;
      else biomes[idx] = BiomeType.TUNDRA;
    } else if (temp < 10) {
      if (moist < 0.2) biomes[idx] = BiomeType.COLD_DESERT;
      else if (moist < 0.45) biomes[idx] = BiomeType.GRASSLAND;
      else biomes[idx] = BiomeType.TAIGA;
    } else if (temp < 22) {
      if (moist < 0.15) biomes[idx] = BiomeType.HOT_DESERT;
      else if (moist < 0.35) biomes[idx] = BiomeType.SHRUBLAND;
      else if (moist < 0.6) biomes[idx] = BiomeType.TEMPERATE_DECIDUOUS;
      else if (moist > 0.85 && (idx % 19 === 0)) biomes[idx] = BiomeType.ENCHANTED_GROVE;
      else biomes[idx] = BiomeType.TEMPERATE_RAINFOREST;
    } else {
      // Hot tropical & subtropical zones
      if (moist < 0.18) biomes[idx] = BiomeType.HOT_DESERT;
      else if (moist < 0.45) biomes[idx] = BiomeType.SAVANNA;
      else if (moist < 0.7) biomes[idx] = BiomeType.TROPICAL_SEASONAL;
      else biomes[idx] = BiomeType.TROPICAL_RAINFOREST;
    }
  }

  return biomes;
}

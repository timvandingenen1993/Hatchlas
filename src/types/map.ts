/**
 * Core app types: map data, tool and render modes, points of interest and world-generation config.
 */
export type LandmassPreset =
  | 'continents'
  | 'archipelago'
  | 'pangaea'
  | 'shattered'
  | 'mediterranean'
  | 'ring'
  | 'fjords'
  | 'volcanic_isles'
  | 'custom';

export type RenderMode =
  | 'hillshade'
  | 'parchment'
  | 'satellite'
  | 'hypsometric'
  | 'temperature'
  | 'moisture'
  | 'rivers'
  | 'basins'
  | 'geology'
  | 'tectonics'
  | 'debug'
  | 'isometric';

export type ToolType =
  | 'inspect'
  | 'sculpt'
  | 'climate'
  | 'erosion'
  | 'river'
  | 'poi'
  | 'profile'
  | 'ruler';

export type SculptMode =
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'flatten'
  | 'mountain'
  | 'volcano'
  | 'canyon'
  | 'ridge'
  | 'terrace'
  | 'island';

export type ClimateBrushMode =
  | 'heat'
  | 'cool'
  | 'rain'
  | 'dry'
  | 'glacier';

export type RiverBrushMode =
  | 'spring'
  | 'dig_channel'
  | 'fill_lake'
  | 'remove_water';

export type POICategory =
  | 'capital'
  | 'castle'
  | 'town'
  | 'village'
  | 'port'
  | 'tower'
  | 'ruins'
  | 'dungeon'
  | 'cave'
  | 'mine'
  | 'dragon'
  | 'shrine'
  | 'mountain_label'
  | 'sea_label'
  | 'region_label';

export interface POI {
  id: string;
  name: string;
  category: POICategory;
  x: number; // 0 to map width
  y: number; // 0 to map height
  size: number;
  color?: string;
  description?: string;
  subtext?: string;
}

export interface VolcanicHotspot {
  x: number;
  y: number;
  intensity: number;
  radius: number;
}

export interface TectonicPlate {
  id: number;
  centroidX: number;
  centroidY: number;
  dx: number; // drift vector X
  dy: number; // drift vector Y
  isOceanic: boolean;
  elevationOffset: number;
  ageFactor?: number; // 1.0 = Young alpine, 0.4 = Ancient eroded
  color: string;
}

export interface RockSoilProperty {
  id: number;
  name: string;
  criticalAngle: number; // Slope tangent limit before gravitational slumping
  hardness: number;      // Resistance against fluvial & marine erosion (0.1 to 1.0)
  color: string;
}

export const ROCK_SOIL_DEFINITIONS: Record<number, RockSoilProperty> = {
  0: { id: 0, name: 'Granite Bedrock', criticalAngle: 0.78, hardness: 0.95, color: '#64748b' },
  1: { id: 1, name: 'Volcanic Basalt', criticalAngle: 0.68, hardness: 0.85, color: '#334155' },
  2: { id: 2, name: 'Sedimentary Strata', criticalAngle: 0.52, hardness: 0.55, color: '#d97706' },
  3: { id: 3, name: 'Regolith Loam Soil', criticalAngle: 0.36, hardness: 0.30, color: '#65a30d' },
  4: { id: 4, name: 'Loose Sand & Scree', criticalAngle: 0.28, hardness: 0.15, color: '#eab308' },
  5: { id: 5, name: 'Glacial Till & Moraine', criticalAngle: 0.32, hardness: 0.25, color: '#94a3b8' },
};

export interface WorldGenConfig {
  seed: number;
  width: number;
  height: number;
  preset: LandmassPreset;
  seaLevel: number; // 0.0 - 1.0 (default ~0.38)
  mountainRoughness: number; // 0.1 - 2.0
  plateCount: number; // 4 - 24
  equatorTemp: number; // in °C (default ~32)
  poleTemp: number; // in °C (default -25)
  lapseRate: number; // °C cooling per 1000m elevation (default ~6.5)
  windStrength: number; // 0.5 - 2.0
  rainfallMultiplier: number; // 0.2 - 3.0
  erosionDroplets: number; // 5000 - 100000
  erosionStrength: number; // 0.1 - 2.0
  talusAngle: number; // critical slope for scree (default ~0.45)
  riverThreshold: number; // flux threshold for rivers
  glacierTempThreshold: number; // in °C (default ~-2)
  geologicalTerracing: number; // 0.0 - 1.0 (mesas & rock layers)
  continentalShelfWidth: number; // 0.01 - 0.15
  hotspotCount: number; // 0 - 8
  // Multi-Erosion toggles & factors
  oceanWaveErosionStrength: number; // 0.0 - 2.0
  windErosionStrength: number; // 0.0 - 2.0
  rainSplashErosionStrength: number; // 0.0 - 2.0
  riverErosionStrength: number; // 0.0 - 2.0
  glacierErosionStrength: number; // 0.0 - 2.0
}

export interface MapData {
  width: number;
  height: number;
  seed: number;
  config: WorldGenConfig;
  
  // Simulation float grids (Length: width * height)
  elevation: Float32Array;        // 0.0 (deepest abyss) to 1.0 (highest peak)
  temperature: Float32Array;      // in °C (-40 to +50)
  moisture: Float32Array;         // 0.0 (arid desert) to 1.0 (super-humid)
  precipitation: Float32Array;    // rainfall + snowfall rate (0.0 to 1.0)
  riverFlux: Float32Array;        // accumulated water flow volume
  flowDirection: Int8Array;       // D8 flow direction (0-7, or -1 for sink/ocean)
  drainageBasin: Int32Array;      // Basin ID per cell
  sediment: Float32Array;         // eroded/deposited sediment layer
  rockHardness: Float32Array;     // rock resistance against erosion (0.1 to 1.0)
  soilType: Uint8Array;           // Rock/Soil ID per cell (0-5)
  glacierIce: Float32Array;       // glacier ice sheet thickness
  biomes: Uint8Array;             // Biome ID enum per cell

  // Vector / Feature structures
  tectonicPlates: TectonicPlate[];
  plateMap: Uint8Array;           // plate ID per cell
  boundaryStress: Float32Array;   // tectonic boundary collision / divergence stress
  boundaryDistance: Float32Array; // distance to closest plate boundary
  hotspots: VolcanicHotspot[];
  lakes: { x: number; y: number; level: number; size: number }[];
  rivers: { points: [number, number][]; order: number }[];
  pois: POI[];

  title: string;
  subtitle: string;
  author: string;
}

export interface BiomeDefinition {
  id: number;
  name: string;
  colorParchment: string;
  colorSatellite: string;
  colorSatelliteHigh: string;
  minTemp: number;
  maxTemp: number;
  minMoisture: number;
  maxMoisture: number;
  minElevation: number;
  maxElevation: number;
  treeDensity: number;
  treeType?: 'conifer' | 'broadleaf' | 'palm' | 'dead' | 'fungal';
  description: string;
}

export interface ToolSettings {
  activeTool: ToolType;
  brushSize: number;
  brushStrength: number;
  brushFalloff: 'smooth' | 'linear' | 'flat';
  sculptMode: SculptMode;
  climateMode: ClimateBrushMode;
  riverMode: RiverBrushMode;
  selectedPOICategory: POICategory;
  showContours: boolean;
  showRivers: boolean;
  showPOIs: boolean;
  showGrid: boolean;
  showWindVectors: boolean;
  showCoastlines: boolean;
  showCompass: boolean;
  contourInterval: number;
  renderMode: RenderMode;
}

export interface ElevationProfileSample {
  distance: number; // 0 to 100%
  x: number;
  y: number;
  elevation: number;
  temperature: number;
  moisture: number;
  riverFlux: number;
  biomeName: string;
  biomeColor: string;
  isWater: boolean;
}

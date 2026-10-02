/**
 * Orchestrates the flat-grid generator: tectonics, terrain, climate, rivers, erosion, biomes and names.
 */
import { simulateTectonics } from './tectonics';
import { generateHeightmap } from './terrain';
import { simulateClimate } from './climate';
import { simulateRiversAndHydrology, topologicalBucketSort } from './rivers';
import { classifyBiomes } from './biomes';
import {
  applyStreamPowerFluvialErosion,
  applyLaplacianHillslopeDiffusion,
  applyOceanWaveErosion,
  applyGlacialCarving,
  classifyGeologicalStrata,
} from './erosion';
import { generateRealmTitle, generatePOIName } from '../utils/fantasyNames';
import { FastRandom } from './noise';
import type { MapData, WorldGenConfig, POI } from '../types/map';

export const DEFAULT_CONFIG: WorldGenConfig = {
  seed: 424242,
  width: 512,
  height: 512,
  preset: 'continents',
  seaLevel: 0.38,
  mountainRoughness: 1.0,
  plateCount: 8,
  equatorTemp: 32.0,
  poleTemp: -24.0,
  lapseRate: 6.5,
  windStrength: 1.0,
  rainfallMultiplier: 1.2,
  erosionDroplets: 15000,
  erosionStrength: 0.8,
  talusAngle: 0.45,
  riverThreshold: 40.0,
  glacierTempThreshold: -2.0,
  geologicalTerracing: 0.0,
  continentalShelfWidth: 0.06,
  hotspotCount: 4,
  oceanWaveErosionStrength: 0.5,
  windErosionStrength: 0.3,
  rainSplashErosionStrength: 0.4,
  riverErosionStrength: 0.8,
  glacierErosionStrength: 0.6,
};

export async function generateCompleteWorld(
  config: WorldGenConfig,
  onStepProgress?: (stepName: string, progress: number) => void
): Promise<MapData> {
  const { width, height, seed } = config;

  const yieldUI = () => new Promise((resolve) => setTimeout(resolve, 0));

  // Step 1: Continuous Geophysical Tectonic Velocity Field & Hotspots
  onStepProgress?.('Simulating Tectonic Crusts & Strain Tensor...', 0.15);
  await yieldUI();
  const tectonics = simulateTectonics(width, height, config.plateCount, seed, config.hotspotCount ?? 4);

  // Step 2: Clean Fractal Topography, Orogenic Cordilleras & Lowlands
  onStepProgress?.('Synthesizing Continental Topography & Mountain Cordilleras...', 0.35);
  await yieldUI();
  const elevation = generateHeightmap(width, height, config, tectonics);

  // Step 3: Thermodynamics, Atmospheric Wind & Orographic Precipitation
  onStepProgress?.('Simulating Atmospheric Winds & Climate...', 0.55);
  await yieldUI();
  const climate = simulateClimate(width, height, elevation, config);

  // Step 4: Hydrology & River Drainage Networks
  onStepProgress?.('Routing Hydrological Networks...', 0.75);
  await yieldUI();
  const hydrology = simulateRiversAndHydrology(
    width,
    height,
    elevation,
    climate.precipitation,
    climate.glacierIce,
    config
  );

  // Step 5: Multi-Physics Geomorphic Erosion (Cordonnier 2016, Sunamura 1992, Egholm 2009)
  onStepProgress?.('Simulating Fluvial, Marine Wave & Glacial Geomorphic Processes...', 0.85);
  await yieldUI();
  
  const soilType = new Uint8Array(width * height);
  const rockHardness = new Float32Array(width * height);
  const sediment = new Float32Array(width * height);
  classifyGeologicalStrata(width, height, elevation, climate.glacierIce, config.seaLevel, soilType, rockHardness);

  // 1. Marine Coastal Wave Erosion & Beach Shoal Deposition (Sunamura 1992)
  if ((config.oceanWaveErosionStrength ?? 0.5) > 0.05) {
    applyOceanWaveErosion(width, height, elevation, sediment, soilType, rockHardness, config);
  }

  // 2. Glacial U-Valley Gouging & Buzzsaw Action (Egholm 2009)
  if ((config.glacierErosionStrength ?? 0.6) > 0.05) {
    applyGlacialCarving(width, height, elevation, climate.glacierIce, soilType, config);
  }

  // 3. Build flow receiver map and topological elevation indices for fluvial incision
  const flowReceivers = new Int32Array(width * height).fill(-1);
  const D8_DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const D8_DY = [0, -1, -1, -1, 0, 1, 1, 1];
  for (let idx = 0; idx < width * height; idx++) {
    const dir = hydrology.flowDirection[idx];
    if (dir >= 0) {
      const cx = idx % width;
      const cy = Math.floor(idx / width);
      const nx = cx + D8_DX[dir];
      const ny = cy + D8_DY[dir];
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        flowReceivers[idx] = ny * width + nx;
      }
    }
  }

  // O(N) Linear-Time Topological Bucket Sort
  const indices = topologicalBucketSort(elevation, width * height);

  // 4. Stream Power Incision & Laplacian Hillslope Soil Creep (Cordonnier 2016)
  applyStreamPowerFluvialErosion(width, height, elevation, hydrology.riverFlux, flowReceivers, config.seaLevel, 2, 0.00015, rockHardness, indices);
  applyLaplacianHillslopeDiffusion(width, height, elevation, config.seaLevel, 1, 0.035, rockHardness);

  // Re-classify surface lithology after erosion
  classifyGeologicalStrata(width, height, elevation, climate.glacierIce, config.seaLevel, soilType, rockHardness);

  // Step 6: Whittaker Biomes & Ecological Synthesis
  onStepProgress?.('Classifying Biomes & Vegetative Canopies...', 0.95);
  await yieldUI();
  const biomes = classifyBiomes(
    width,
    height,
    elevation,
    climate.temperature,
    climate.moisture,
    climate.glacierIce,
    config.seaLevel,
    tectonics.hotspots
  );

  // Step 7: Title, Metadata & Fantasy Landmarks (POIs)
  const realmInfo = generateRealmTitle(seed);
  const pois = seedInitialPOIs(width, height, elevation, climate.temperature, hydrology.riverFlux, config.seaLevel, seed);

  onStepProgress?.('Finalizing Topographical Shaded Relief...', 1.0);
  await yieldUI();

  return {
    width,
    height,
    seed,
    config,
    elevation,
    temperature: climate.temperature,
    moisture: climate.moisture,
    precipitation: climate.precipitation,
    riverFlux: hydrology.riverFlux,
    flowDirection: hydrology.flowDirection,
    drainageBasin: hydrology.drainageBasin,
    sediment: new Float32Array(width * height),
    rockHardness,
    soilType,
    glacierIce: climate.glacierIce,
    biomes,
    tectonicPlates: tectonics.plates,
    plateMap: tectonics.plateMap,
    boundaryStress: tectonics.boundaryStress,
    boundaryDistance: tectonics.boundaryDistance,
    hotspots: tectonics.hotspots,
    lakes: hydrology.lakes,
    rivers: hydrology.rivers,
    pois,
    title: realmInfo.title,
    subtitle: realmInfo.subtitle,
    author: realmInfo.author,
  };
}

function seedInitialPOIs(
  width: number,
  height: number,
  elevation: Float32Array,
  temperature: Float32Array,
  riverFlux: Float32Array,
  seaLevel: number,
  seed: number
): POI[] {
  const rng = new FastRandom(seed + 888);
  const pois: POI[] = [];

  let bestCapitalScore = -1;
  let capitalX = Math.floor(width / 2);
  let capitalY = Math.floor(height / 2);

  let highestElev = -1;
  let mountainX = 0;
  let mountainY = 0;

  let bestPortScore = -1;
  let portX = 0;
  let portY = 0;

  const step = Math.max(4, Math.floor(width / 128));

  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const idx = y * width + x;
      const h = elevation[idx];
      const flux = riverFlux[idx];
      const temp = temperature[idx];

      if (h > seaLevel && h < seaLevel + 0.15 && flux > 80 && temp > 10 && temp < 26) {
        const score = flux * (1.0 - Math.abs(temp - 18) / 20);
        if (score > bestCapitalScore) {
          bestCapitalScore = score;
          capitalX = x;
          capitalY = y;
        }
      }

      if (h > highestElev) {
        highestElev = h;
        mountainX = x;
        mountainY = y;
      }

      if (h > seaLevel && h <= seaLevel + 0.03 && flux > 30) {
        if (flux > bestPortScore) {
          bestPortScore = flux;
          portX = x;
          portY = y;
        }
      }
    }
  }

  // Capital City
  pois.push({
    id: 'poi-capital',
    name: generatePOIName('capital', seed + 1),
    category: 'capital',
    x: capitalX,
    y: capitalY,
    size: 22,
    color: '#f59e0b',
    description: 'The glorious seat of power and imperial capital.',
    subtext: 'Imperial Throne',
  });

  // Mountain Dragon Roost / Dwarven Mine
  if (highestElev > seaLevel + 0.25) {
    pois.push({
      id: 'poi-dragon',
      name: generatePOIName('dragon', seed + 2),
      category: 'dragon',
      x: mountainX,
      y: mountainY,
      size: 18,
      color: '#ef4444',
      description: 'Lair of an ancient primordial dragon atop the highest peak.',
      subtext: 'Level 100 Dragon',
    });
  }

  // Port City
  if (portX > 0 && Math.hypot(portX - capitalX, portY - capitalY) > 30) {
    pois.push({
      id: 'poi-port',
      name: generatePOIName('port', seed + 3),
      category: 'port',
      x: portX,
      y: portY,
      size: 16,
      color: '#38bdf8',
      description: 'Bustling merchant harbor connecting maritime trade routes.',
      subtext: 'Trade Haven',
    });
  }

  const extraCategories: Array<POI['category']> = [
    'castle', 'town', 'village', 'ruins', 'tower', 'cave', 'mine', 'shrine'
  ];

  for (let i = 0; i < 7; i++) {
    const cat = extraCategories[i % extraCategories.length];
    for (let attempt = 0; attempt < 30; attempt++) {
      const rx = rng.nextInt(20, width - 20);
      const ry = rng.nextInt(20, height - 20);
      const idx = ry * width + rx;
      const h = elevation[idx];

      if (h > seaLevel) {
        const tooClose = pois.some((p) => Math.hypot(p.x - rx, p.y - ry) < 25);
        if (!tooClose) {
          pois.push({
            id: `poi-${i}-${attempt}`,
            name: generatePOIName(cat, seed + 10 + i * 7),
            category: cat,
            x: rx,
            y: ry,
            size: cat === 'castle' || cat === 'town' ? 15 : 12,
            color: cat === 'ruins' ? '#a855f7' : cat === 'tower' ? '#818cf8' : '#e2e8f0',
            description: `A renowned ${cat} known throughout the realm.`,
          });
          break;
        }
      }
    }
  }

  return pois;
}

/**
 * Heightmap generator for the flat-grid world: continents, shelves and ocean floor from plate fields and noise.
 */
import { SimplexNoise, VoronoiNoise } from './noise';
import type { LandmassPreset, WorldGenConfig } from '../types/map';
import type { TectonicsResult } from './tectonics';

export function generateHeightmap(
  width: number,
  height: number,
  config: WorldGenConfig,
  tectonics: TectonicsResult
): Float32Array {
  const simplex = new SimplexNoise(config.seed);
  const simplex2 = new SimplexNoise(config.seed + 101);
  const voronoi = new VoronoiNoise();
  const elevation = new Float32Array(width * height);

  const seaLevel = config.seaLevel;

  for (let y = 0; y < height; y++) {
    const ny = (y / height) * 2 - 1; // [-1, 1]
    const yIdx = y * width;

    for (let x = 0; x < width; x++) {
      const nx = (x / width) * 2 - 1; // [-1, 1]
      const idx = yIdx + x;

      // Soft natural margin falloff (embraces continents in surrounding oceans)
      const edgeDist = Math.max(Math.abs(nx), Math.abs(ny));
      const borderMask = edgeDist > 0.80 ? Math.max(0.0, 1.0 - Math.pow((edgeDist - 0.80) / 0.18, 2.0)) : 1.0;

      // Continuous continental crust field
      const crust = computeLandmassMask(nx, ny, config.preset, simplex, voronoi, tectonics, idx) * borderMask;

      if (crust <= seaLevel) {
        // --- Continuous Marine Bathymetry ---
        const depth = Math.max(0.0, (seaLevel - crust) / Math.max(0.01, seaLevel));
        const shelfWidth = config.continentalShelfWidth ?? 0.08;

        if (depth < shelfWidth) {
          // Shallow sloping continental shelf
          const t = depth / shelfWidth;
          elevation[idx] = Math.max(0.0, seaLevel - t * 0.035);
        } else {
          // Continental slope descending into oceanic abyss
          const tAbyss = Math.min(1.0, (depth - shelfWidth) / (1.0 - shelfWidth));
          elevation[idx] = Math.max(0.0, seaLevel - 0.035 - Math.pow(tAbyss, 0.75) * 0.38);
        }
        continue;
      }

      // --- Continuous Continental Topography (Musgrave 1989 & Cordonnier 2016) ---
      // Normalized continental elevation [0, 1]
      const landFrac = Math.min(1.0, (crust - seaLevel) / (1.0 - seaLevel));

      // 1. Broad Alluvial Plains & Foreland Basins (Continuous C1 transition from sea level)
      const plains = Math.pow(landFrac, 1.3) * 0.16;

      // 2. Musgrave Heterogeneous Lowlands & Rolling Foothills
      // Octave amplitude is continuously modulated by local elevation: smooth at coasts, rugged inland
      const heteroBase = (simplex2.heteroTerrain(nx * 2.4, ny * 2.4, 0.85, 2.0, 5, 0.65) + 1.0) * 0.5;
      const foothills = heteroBase * 0.18 * Math.pow(landFrac, 1.1);

      // 3. Tectonic Orogenic Uplift & Alpine Mountain Cordilleras
      const boundaryStress = tectonics.boundaryStress ? tectonics.boundaryStress[idx] : 0;
      const tectonicUplift = Math.max(0.0, boundaryStress);
      const ageFactor = tectonics.plateAge ? tectonics.plateAge[idx] : 0.65;

      const ang = 0.58;
      const rx = nx * Math.cos(ang) - ny * Math.sin(ang);
      const ry = nx * Math.sin(ang) + ny * Math.cos(ang);

      const ridgedMtn = simplex.musgraveMountains(
        (rx * 0.8 - ry * 0.6) * 2.6,
        (rx * 0.6 + ry * 0.8) * 2.6,
        5,
        1.0,
        2.0,
        2.02,
        1.0
      );

      // Mountain envelope emerges smoothly in continental uplands
      const mountainZone = Math.max(0.0, (landFrac - 0.18) / 0.82);
      const orogenicCoupling = 0.65 + 0.35 * tectonicUplift;
      const mountains = ridgedMtn * 0.62 * Math.pow(mountainZone, 1.35) * (0.65 + 0.35 * ageFactor) * orogenicCoupling * config.mountainRoughness;

      // 4. Volcanic Edifices & Hotspots
      let volcanicCone = 0.0;
      if (tectonics.hotspots) {
        for (const spot of tectonics.hotspots) {
          const dSpot = Math.hypot(x - spot.x, y - spot.y);
          if (dSpot < spot.radius) {
            const normD = dSpot / spot.radius;
            let cone = Math.pow(1.0 - normD, 2.4);
            if (normD < 0.08) cone -= (0.08 - normD) * 1.8;
            volcanicCone += spot.intensity * cone * 0.25;
          }
        }
      }

      // 5. Active Subduction Coastal Bluffs (Subtle 20-50m sea bluffs on active convergent margins)
      const isActiveCoast = tectonicUplift > 0.05 && landFrac < 0.12;
      const coastalCliff = isActiveCoast ? tectonicUplift * 0.03 * (1.0 - landFrac / 0.12) : 0.0;

      // 6. Non-linear Hypsometric Compression
      const totalElev = plains + foothills + mountains + volcanicCone + coastalCliff;
      const compressed = Math.tanh(totalElev * 1.15) / Math.tanh(1.15);

      elevation[idx] = Math.max(seaLevel + 0.0005, Math.min(0.98, seaLevel + compressed * (1.0 - seaLevel)));
    }
  }

  return elevation;
}

function computeLandmassMask(
  nx: number,
  ny: number,
  preset: LandmassPreset,
  simplex: SimplexNoise,
  voronoi: VoronoiNoise,
  _tectonics: TectonicsResult,
  _idx: number
): number {
  switch (preset) {
    case 'continents': {
      // Ultra-Low Frequency Macro Continental Synthesis (freq = 0.65)
      const macroContinent = simplex.fbm(nx * 0.65, ny * 0.65, 3, 2.0, 0.5) * 0.75 + 0.28;
      const geomorphDetail = simplex.fbm(nx * 1.5, ny * 1.5, 3, 2.0, 0.5) * 0.18;
      const coastalFractal = simplex.fbm(nx * 3.6, ny * 3.6, 5, 2.05, 0.52) * 0.14;
      return Math.max(0.0, Math.min(1.0, macroContinent + geomorphDetail + coastalFractal));
    }

    case 'pangaea': {
      const dist = Math.hypot(nx, ny);
      const radial = Math.max(0.0, 1.0 - Math.pow(dist * 1.15, 2.2));
      const noise = (simplex.fbm(nx * 1.8, ny * 1.8, 4, 2.0, 0.5) + 1.0) * 0.25;
      const coastalFractal = simplex.fbm(nx * 3.8, ny * 3.8, 5, 2.05, 0.5) * 0.2;
      return Math.max(0.0, Math.min(1.0, radial + noise + coastalFractal));
    }

    case 'archipelago': {
      const v = voronoi.sample(nx * 1.5, ny * 1.5, 3.5);
      const islandCores = Math.pow(1.0 - v.f1, 3.0);
      const fbm = (simplex.fbm(nx * 3.5, ny * 3.5, 4, 2.0, 0.5) + 1.0) * 0.5;
      const coastalFractal = simplex.fbm(nx * 4.5, ny * 4.5, 5, 2.0, 0.5) * 0.2;
      return Math.max(0.0, Math.min(1.0, islandCores * 0.65 + fbm * 0.45 + coastalFractal));
    }

    case 'shattered': {
      const voronoiCell = voronoi.sample(nx * 2.0, ny * 2.0, 4.0);
      const cellEdge = voronoiCell.f2 - voronoiCell.f1;
      const fbm = (simplex.fbm(nx * 3.0, ny * 3.0, 4, 2.0, 0.5) + 1.0) * 0.5;
      const coastalFractal = simplex.fbm(nx * 4.5, ny * 4.5, 5, 2.0, 0.5) * 0.2;
      return Math.max(0.0, Math.min(1.0, fbm * 0.6 + cellEdge * 0.6 + coastalFractal));
    }

    case 'mediterranean': {
      const dist = Math.hypot(nx, ny);
      const centerSea = Math.min(1.0, Math.pow(dist * 1.8, 2.0));
      const outerRing = Math.max(0.0, 1.0 - Math.pow(dist * 1.05, 4.0));
      const noise = (simplex.fbm(nx * 2.2, ny * 2.2, 4, 2.0, 0.5) + 1.0) * 0.25;
      const coastalFractal = simplex.fbm(nx * 4.5, ny * 4.5, 5, 2.0, 0.5) * 0.2;
      return Math.max(0.0, Math.min(1.0, (centerSea * outerRing * 1.3) + noise + coastalFractal));
    }

    case 'ring': {
      const dist = Math.hypot(nx, ny);
      const ringDist = Math.abs(dist - 0.55);
      const ringMask = Math.max(0.0, 1.0 - (ringDist / 0.3));
      const noise = (simplex.fbm(nx * 2.8, ny * 2.8, 4, 2.0, 0.5) + 1.0) * 0.25;
      const coastalFractal = simplex.fbm(nx * 4.5, ny * 4.5, 5, 2.0, 0.5) * 0.2;
      return Math.max(0.0, Math.min(1.0, ringMask + noise + coastalFractal));
    }

    case 'fjords': {
      const noise = (simplex.fbm(nx * 2.0, ny * 2.0, 4, 2.0, 0.5) + 1.0) * 0.5;
      const fjordNoise = Math.abs(simplex.noise2D(nx * 6.0, ny * 6.0));
      const fjordCuts = fjordNoise < 0.12 ? (0.12 - fjordNoise) * 1.5 : 0.0;
      const coastalFractal = simplex.fbm(nx * 4.5, ny * 4.5, 5, 2.0, 0.5) * 0.2;
      return Math.max(0.0, Math.min(1.0, noise - fjordCuts + coastalFractal));
    }

    case 'volcanic_isles': {
      const v = voronoi.sample(nx * 2.0, ny * 2.0, 3.0);
      const cones = Math.pow(1.0 - v.f1, 4.0);
      const fbm = (simplex.fbm(nx * 3.5, ny * 3.5, 4, 2.0, 0.5) + 1.0) * 0.5;
      const coastalFractal = simplex.fbm(nx * 4.5, ny * 4.5, 5, 2.0, 0.5) * 0.2;
      return Math.max(0.0, Math.min(1.0, cones * 0.75 + fbm * 0.35 + coastalFractal));
    }

    case 'custom':
    default: {
      const noise = (simplex.fbm(nx * 1.8, ny * 1.8, 4, 2.0, 0.5) + 1.0) * 0.5;
      const coastalFractal = simplex.fbm(nx * 4.5, ny * 4.5, 5, 2.0, 0.5) * 0.2;
      return Math.max(0.0, Math.min(1.0, noise + coastalFractal));
    }
  }
}

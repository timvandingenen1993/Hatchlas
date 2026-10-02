/**
 * Seeds spherical plates at jittered centers with random Euler poles.
 */
import { dot3, normalize3, type Vec3 } from '../geometry/coordinates';
import type { CubedSphereGrid } from '../geometry/cubedSphere';
import type { SimulationConfig } from '../types/config';
import type { TectonicPlateData } from '../types/worldV2';
import { Mulberry32, Simplex3D } from '../utils/rng';

export interface SphericalPlatesResult {
  plates: TectonicPlateData[];
  plateIds: Uint8Array;
  crustType: Uint8Array; // 0=Oceanic, 1=Continental, 2=Volcanic Arc
  crustThickness: Float32Array; // Meters
  crustAge: Float32Array; // Myr
}

const PLATE_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#f43f5e', '#78716c', '#64748b', '#0284c7',
];

/**
 * Procedural Voronoi Tectonic Plates & Stochastic Continental Nuclei
 * 
 * Note: Uses a procedural spherical Voronoi partition for plates and stochastic
 * fractal noise with rank-based thresholding for continent placement.
 * 
 * References:
 * 1. Cortial et al. (2019), "Procedural Tectonic Planets", Comput. Graph. Forum (Eurographics) - Procedural planet synthesis.
 * 2. Müller et al. (2018), "GPlates: Building a Virtual Earth Through Deep Time", G-Cubed - Plate kinematics background.
 */
export function seedSphericalPlates(
  grid: CubedSphereGrid,
  config: SimulationConfig
): SphericalPlatesResult {
  const K = Math.max(8, Math.min(24, config.plateCount));
  const plateRng = new Mulberry32(config.seed + 101);
  // Keep stochastic continent placement independent from plate-count changes.
  const continentRng = new Mulberry32(config.seed + 202);
  const simplex = new Simplex3D(config.seed + 707);
  const cratonSimplex = new Simplex3D(config.seed + 808);
  const totalCells = grid.totalCells;

  const plates: TectonicPlateData[] = [];
  const seedPositions: Vec3[] = [];
  const phiGolden = (1 + Math.sqrt(5)) / 2;

  // 1. Seed Tectonic Plates with Euler Rotation Kinematics
  for (let k = 0; k < K; k++) {
    const z = 1 - (2 * k + 1) / K;
    const theta = (2 * Math.PI * k) / phiGolden;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const rawPos: Vec3 = [r * Math.cos(theta), r * Math.sin(theta), z];

    const jitterX = rawPos[0] + plateRng.range(-0.20, 0.20);
    const jitterY = rawPos[1] + plateRng.range(-0.20, 0.20);
    const jitterZ = rawPos[2] + plateRng.range(-0.20, 0.20);
    const pos = normalize3([jitterX, jitterY, jitterZ]);
    seedPositions.push(pos);

    // Euler rotation pole (axis of rotation)
    const poleX = plateRng.range(-1, 1);
    const poleY = plateRng.range(-1, 1);
    const poleZ = plateRng.range(-1, 1);
    const eulerPole = normalize3([poleX, poleY, poleZ]);

    // Angular velocity: 0.006 to 0.018 rad/Myr (approximately 40–115 mm/yr
    // at Earth radius after the unit conversion in plateKinematics.ts).
    const angularVelocity = plateRng.range(0.006, 0.018) * (plateRng.next() > 0.5 ? 1 : -1);

    plates.push({
      id: k,
      name: `Plate ${String.fromCharCode(65 + k)}`,
      eulerPole,
      angularVelocity,
      isOceanic: false,
      color: PLATE_COLORS[k % PLATE_COLORS.length],
    });
  }

  // 2. Assign Voronoi Plate Partitions with Multi-Scale Fractal Domain Warping
  const plateIds = new Uint8Array(totalCells);

  for (let idx = 0; idx < totalCells; idx++) {
    const px = grid.cellPositions[idx * 3 + 0];
    const py = grid.cellPositions[idx * 3 + 1];
    const pz = grid.cellPositions[idx * 3 + 2];

    const warpX = simplex.noise3D(px * 2.2, py * 2.2, pz * 2.2) * 0.18;
    const warpY = simplex.noise3D(px * 2.2 + 13, py * 2.2 + 37, pz * 2.2) * 0.18;
    const warpZ = simplex.noise3D(px * 2.2 + 71, py * 2.2 + 97, pz * 2.2) * 0.18;

    const warpedPos = normalize3([px + warpX, py + warpY, pz + warpZ]);

    let maxDot = -2.0;
    let bestPlate = 0;

    for (let k = 0; k < K; k++) {
      const sp = seedPositions[k];
      const d = dot3(warpedPos, sp);
      if (d > maxDot) {
        maxDot = d;
        bestPlate = k;
      }
    }

    plateIds[idx] = bestPlate;
  }

  // 3. Seed Distinct, Separated Continental Landmasses & Archipelagos
  // Place 4 to 6 separate continental nuclei with minimum angular separation
  const targetContinentCount = continentRng.rangeInt(4, 7);
  const continentCenters: Vec3[] = [];
  const continentRadii: number[] = [];
  const continentWeights: number[] = [];

  let attempts = 0;
  while (continentCenters.length < targetContinentCount && attempts < 100) {
    attempts++;
    const cx = continentRng.range(-1, 1);
    const cy = continentRng.range(-1, 1);
    const cz = continentRng.range(-1, 1);
    const candidate = normalize3([cx, cy, cz]);

    // Check minimum angular distance to other continent centers (~45 degrees = 0.80 rad)
    let tooClose = false;
    for (const existing of continentCenters) {
      const ang = Math.acos(Math.max(-1.0, Math.min(1.0, dot3(candidate, existing))));
      if (ang < 0.75) {
        tooClose = true;
        break;
      }
    }

    if (!tooClose || attempts > 80) {
      continentCenters.push(candidate);
      // Realistic continent radius: 0.38 to 0.68 radians (22° to 39° arc, Earth continent scale)
      continentRadii.push(continentRng.range(0.40, 0.68));
      continentWeights.push(continentRng.range(0.85, 1.30));
    }
  }

  // Also add 6 to 10 smaller microcontinents and island arcs
  const microCount = continentRng.rangeInt(6, 11);
  for (let m = 0; m < microCount; m++) {
    const mx = continentRng.range(-1, 1);
    const my = continentRng.range(-1, 1);
    const mz = continentRng.range(-1, 1);
    continentCenters.push(normalize3([mx, my, mz]));
    continentRadii.push(continentRng.range(0.12, 0.26)); // Small island/subcontinent scale
    continentWeights.push(continentRng.range(0.50, 0.85));
  }

  const rawContinentalScore = new Float32Array(totalCells);

  for (let idx = 0; idx < totalCells; idx++) {
    const px = grid.cellPositions[idx * 3 + 0];
    const py = grid.cellPositions[idx * 3 + 1];
    const pz = grid.cellPositions[idx * 3 + 2];
    const pVec: Vec3 = [px, py, pz];

    let cratonPotential = 0;
    for (let c = 0; c < continentCenters.length; c++) {
      const cp = continentCenters[c];
      const dot = dot3(pVec, cp);
      const angDist = Math.acos(Math.max(-1.0, Math.min(1.0, dot)));
      const normDist = angDist / continentRadii[c];
      if (normDist < 1.0) {
        const falloff = Math.cos(normDist * (Math.PI / 2));
        cratonPotential += Math.pow(falloff, 1.8) * continentWeights[c];
      }
    }

    // Coastal fractal domain warping & embayments
    const warpX = cratonSimplex.noise3D(px * 1.8, py * 1.8, pz * 1.8) * 0.30;
    const warpY = cratonSimplex.noise3D(px * 1.8 + 17, py * 1.8 + 31, pz * 1.8) * 0.30;
    const warpZ = cratonSimplex.noise3D(px * 1.8 + 43, py * 1.8 + 79, pz * 1.8) * 0.30;

    const wx = px + warpX;
    const wy = py + warpY;
    const wz = pz + warpZ;

    const fbmMacro = cratonSimplex.fbm(wx * 2.2, wy * 2.2, wz * 2.2, 4, 2.0, 0.50);
    const fbmMeso  = cratonSimplex.fbm(px * 5.0, py * 5.0, pz * 5.0, 3, 2.1, 0.45);
    const fbmMicro = cratonSimplex.fbm(px * 12.0, py * 12.0, pz * 12.0, 3, 2.2, 0.40);

    rawContinentalScore[idx] = cratonPotential * 0.75 + fbmMacro * 0.45 + fbmMeso * 0.18 + fbmMicro * 0.08;
  }

  // Find threshold matching target continental fraction
  const sortedScores = new Float32Array(rawContinentalScore).sort();
  const thresholdIdx = Math.floor(totalCells * (1.0 - config.continentalFraction));
  const continentalThreshold = sortedScores[Math.max(0, Math.min(totalCells - 1, thresholdIdx))];

  const crustType = new Uint8Array(totalCells);
  const crustThickness = new Float32Array(totalCells);
  const crustAge = new Float32Array(totalCells);

  for (let idx = 0; idx < totalCells; idx++) {
    const score = rawContinentalScore[idx];
    if (score >= continentalThreshold) {
      crustType[idx] = 1; // Continental Crust
      const distFromMargin = Math.min(1.0, (score - continentalThreshold) / 0.30);
      // Global receiver-function compilations put ordinary continental crust
      // near 30 km at extended margins and about 40 km beneath stable
      // interiors. The 60-80 km tail belongs to actively compensated orogens,
      // and is therefore added only after uplift/erosion has built relief.
      crustThickness[idx] = 30000 + distFromMargin * 10000;
      crustAge[idx] = 250 + distFromMargin * (config.geologicalAgeMyr * 0.8);
    } else {
      crustType[idx] = 0; // Oceanic Crust
      crustThickness[idx] = 7000;
      crustAge[idx] = config.geologicalAgeMyr * 0.5;
    }
  }

  for (let k = 0; k < K; k++) {
    let contCount = 0;
    let totalPlateCells = 0;
    for (let idx = 0; idx < totalCells; idx++) {
      if (plateIds[idx] === k) {
        totalPlateCells++;
        if (crustType[idx] === 1) contCount++;
      }
    }
    plates[k].isOceanic = (contCount / Math.max(1, totalPlateCells)) < 0.35;
  }

  return { plates, plateIds, crustType, crustThickness, crustAge };
}

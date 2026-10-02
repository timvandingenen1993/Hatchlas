/**
 * Plate tectonics for the flat-grid world generator: plate centers, motion and boundary fields.
 */
import { FastRandom, SimplexNoise } from './noise';
import type { TectonicPlate, VolcanicHotspot } from '../types/map';

const PLATE_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef',
  '#f43f5e', '#14b8a6', '#eab308', '#a855f7', '#ec4899',
  '#0284c7', '#16a34a', '#ca8a04', '#9333ea', '#e11d48'
];

export interface TectonicsResult {
  plates: TectonicPlate[];
  plateMap: Uint8Array;
  boundaryStress: Float32Array;
  boundaryDistance: Float32Array;
  tectonicElevation: Float32Array;
  plateAge: Float32Array; // 1.0 = Young alpine orogeny, 0.4 = Ancient eroded orogeny
  hotspots: VolcanicHotspot[];
}

export function simulateTectonics(
  width: number,
  height: number,
  plateCount: number,
  seed: number,
  hotspotCount: number = 4
): TectonicsResult {
  const rng = new FastRandom(seed + 101);
  const simplex = new SimplexNoise(seed + 555);
  const plates: TectonicPlate[] = [];

  // Generate plate centers with jittered grid distribution
  const cols = Math.ceil(Math.sqrt(plateCount));
  const rows = Math.ceil(plateCount / cols);
  const cellW = width / cols;
  const cellH = height / rows;

  let plateId = 0;
  for (let r = 0; r < rows && plateId < plateCount; r++) {
    for (let c = 0; c < cols && plateId < plateCount; c++) {
      const cx = (c + rng.nextFloat(0.2, 0.8)) * cellW;
      const cy = (r + rng.nextFloat(0.2, 0.8)) * cellH;
      
      const angle = rng.nextFloat(0, Math.PI * 2);
      const speed = rng.nextFloat(0.6, 1.8);
      const isOceanic = rng.next() > 0.55;

      // Age factor: first 1-2 continental plates are young active orogenies (1.0), others are intermediate/ancient (0.35-0.7)
      const ageFactor = isOceanic ? 0.3 : (plateId === 0 ? 1.0 : plateId === 1 ? 0.85 : rng.nextFloat(0.35, 0.65));

      plates.push({
        id: plateId,
        centroidX: cx,
        centroidY: cy,
        dx: Math.cos(angle) * speed,
        dy: Math.sin(angle) * speed,
        isOceanic,
        ageFactor,
        elevationOffset: isOceanic ? rng.nextFloat(-0.05, 0.0) : rng.nextFloat(0.04, 0.1),
        color: PLATE_COLORS[plateId % PLATE_COLORS.length],
      });
      plateId++;
    }
  }

  // Generate Mantle Hotspots (volcanic plumes)
  const hotspots: VolcanicHotspot[] = [];
  for (let i = 0; i < hotspotCount; i++) {
    hotspots.push({
      x: rng.nextFloat(width * 0.15, width * 0.85),
      y: rng.nextFloat(height * 0.15, height * 0.85),
      intensity: rng.nextFloat(0.18, 0.30),
      radius: rng.nextFloat(width * 0.04, width * 0.08),
    });
  }

  const totalCells = width * height;
  const plateMap = new Uint8Array(totalCells);
  const boundaryStress = new Float32Array(totalCells);
  const boundaryDistance = new Float32Array(totalCells);
  const tectonicElevation = new Float32Array(totalCells);
  const plateAge = new Float32Array(totalCells);

  const beta = 14.0 / width;
  const numPlates = plates.length;

  const velX = new Float32Array(totalCells);
  const velY = new Float32Array(totalCells);

  // 1. Continuous Softmax Velocity & Age Field
  for (let y = 0; y < height; y++) {
    const yIdx = y * width;
    const ny = (y / height) * 3.5;

    for (let x = 0; x < width; x++) {
      const idx = yIdx + x;
      const nx = (x / width) * 3.5;

      const wx = x + simplex.noise2D(nx, ny) * (width * 0.05);
      const wy = y + simplex.noise2D(nx + 17.3, ny + 31.7) * (width * 0.05);

      let minD1 = 1e9;
      let minD2 = 1e9;
      let dominantPlate = 0;

      let maxLogit = -1e9;
      const logits = new Float32Array(numPlates);

      for (let p = 0; p < numPlates; p++) {
        const d = Math.hypot(wx - plates[p].centroidX, wy - plates[p].centroidY);
        logits[p] = -beta * d;
        if (logits[p] > maxLogit) maxLogit = logits[p];

        if (d < minD1) {
          minD2 = minD1;
          minD1 = d;
          dominantPlate = p;
        } else if (d < minD2) {
          minD2 = d;
        }
      }

      plateMap[idx] = dominantPlate;
      boundaryDistance[idx] = Math.max(0, minD2 - minD1);

      let sumExp = 0;
      const weights = new Float32Array(numPlates);
      for (let p = 0; p < numPlates; p++) {
        weights[p] = Math.exp(logits[p] - maxLogit);
        sumExp += weights[p];
      }

      let vx = 0;
      let vy = 0;
      let crustElev = 0;
      let ageBlend = 0;

      for (let p = 0; p < numPlates; p++) {
        const w = weights[p] / sumExp;
        vx += w * plates[p].dx;
        vy += w * plates[p].dy;

        const baseCrust = plates[p].isOceanic ? 0.28 : 0.52;
        crustElev += w * (baseCrust + plates[p].elevationOffset);
        ageBlend += w * (plates[p].ageFactor ?? 0.5);
      }

      velX[idx] = vx;
      velY[idx] = vy;
      tectonicElevation[idx] = crustElev;
      plateAge[idx] = ageBlend;
    }
  }

  // 2. Physical Velocity Strain & Divergence Tensor Calculation
  for (let y = 0; y < height; y++) {
    const yPrev = Math.max(0, y - 1);
    const yNext = Math.min(height - 1, y + 1);
    const yIdx = y * width;
    const dyDist = yNext === yPrev ? 1.0 : (yNext - yPrev);

    for (let x = 0; x < width; x++) {
      const xPrev = Math.max(0, x - 1);
      const xNext = Math.min(width - 1, x + 1);
      const dxDist = xNext === xPrev ? 1.0 : (xNext - xPrev);
      const idx = yIdx + x;

      const dvxdx = (velX[yIdx + xNext] - velX[yIdx + xPrev]) / dxDist;
      const dvydy = (velY[yNext * width + x] - velY[yPrev * width + x]) / dyDist;
      const divergence = dvxdx + dvydy;

      const stress = -divergence * (width * 0.35);
      boundaryStress[idx] = stress;

      if (stress > 0.02) {
        tectonicElevation[idx] += stress * 0.25;
      } else if (stress < -0.02) {
        tectonicElevation[idx] += stress * 0.12;
      }

      // Add Mantle Hotspots
      for (const spot of hotspots) {
        const dSpot = Math.hypot(x - spot.x, y - spot.y);
        if (dSpot < spot.radius) {
          const spotNorm = 1.0 - dSpot / spot.radius;
          const spotSmooth = spotNorm * spotNorm * (3.0 - 2.0 * spotNorm);
          tectonicElevation[idx] += spot.intensity * spotSmooth;
        }
      }

      tectonicElevation[idx] = Math.max(0.0, Math.min(1.0, tectonicElevation[idx]));
    }
  }

  return {
    plates,
    plateMap,
    boundaryStress,
    boundaryDistance,
    tectonicElevation,
    plateAge,
    hotspots,
  };
}

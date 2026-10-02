/**
 * Structural study of one camera-facing ridge: splits the face into rock planes using shared ribs.
 */
import type { MountainDEMData } from '../terrain/mountainBaseDEM';
import { smoothMountainField } from './mountainPatternRenderer';
import { clamp01, sampleScalarField } from './cartographicStrokeRenderer';
import { mountainProjectionLift, normalizeMountainProjectionSettings } from './mountainProjection';

export interface MountainFaceVertex {
  x: number;
  y: number;
  elevationM: number;
  baseM: number;
}

export interface MountainFacePanel {
  /** Shared vertex indices: ink never invents a second version of an edge. */
  vertices: [number, number, number];
  normal: [number, number, number];
}

export interface MountainFaceGeometry {
  vertices: MountainFaceVertex[];
  panels: MountainFacePanel[];
  crest: number[];
  ribs: number[][];
  foot: number[];
  sourceWidth: number;
  sourceHeight: number;
  dxMeters: number;
  dyMeters: number;
}

/**
 * Structural study of ONE dominant, camera-facing ridge. This deliberately
 * does not claim to solve range partitioning or rear faces. The DEM supplies
 * the crest and drainage-facing foot. Shared ribs divide that face into
 * explicit rock planes, rather than drawing detected ridges over hillshade.
 */
export function buildMountainFaceGeometry(dem: MountainDEMData): MountainFaceGeometry {
  const { width, height } = dem;
  const geometry: MountainFaceGeometry = {
    vertices: [], panels: [], crest: [], ribs: [], foot: [],
    sourceWidth: width, sourceHeight: height, dxMeters: dem.dxMeters, dyMeters: dem.dyMeters,
  };
  const scale = Math.min(width, height) / 1024;
  const field = smoothMountainField(dem.elevation, width, height, Math.max(1, 5 * scale));
  const sample = (x: number, y: number) => sampleScalarField(field, width, height, x, y);
  const isWater = (x: number, y: number) => {
    const i = Math.round(y) * width + Math.round(x);
    return !!(dem.isOcean[i] || dem.isRiverChannel[i] || dem.visualWaterMask?.[i]);
  };
  let summit = 0, base = Infinity;
  for (let i = 0; i < field.length; i++) {
    base = Math.min(base, field[i]);
    if (field[i] > field[summit]) summit = i;
  }
  const relief = field[summit] - base;
  if (relief < 100) return geometry;
  const summitX = summit % width, summitY = Math.floor(summit / width);
  const step = Math.max(4, 48 * scale);
  const crestPoints: { x: number; y: number; z: number }[] = [{ x: summitX, y: summitY, z: field[summit] }];
  // Follow the dominant crest outwards from its highest point. Searching a
  // bounded corridor prevents jumping to a distant, unrelated mountain.
  for (const direction of [-1, 1]) {
    let previousY = summitY;
    for (let x = summitX + direction * step; x > 2 && x < width - 3; x += direction * step) {
      if (Math.abs(x - summitX) > width * 0.38) break;
      let bestY = previousY, bestScore = -Infinity;
      const radius = step * 1.3;
      for (let y = Math.max(2, previousY - radius); y < Math.min(height - 3, previousY + radius); y += Math.max(1, 2 * scale)) {
        const score = sample(x, y) - Math.abs(y - previousY) * relief / (height * 2);
        if (!isWater(x, y) && score > bestScore) { bestScore = score; bestY = y; }
      }
      const z = sample(x, bestY);
      if (z < base + relief * 0.22 || isWater(x, bestY)) break;
      const point = { x, y: bestY, z };
      if (direction < 0) crestPoints.unshift(point); else crestPoints.push(point);
      previousY = bestY;
    }
  }
  if (crestPoints.length < 3) return geometry;

  const rows = [0, 0.2, 0.46, 0.73, 1];
  const add = (vertex: MountainFaceVertex) => { geometry.vertices.push(vertex); return geometry.vertices.length - 1; };
  const profiles: { crest: typeof crestPoints[number]; footX: number; footY: number; footZ: number }[] = [];
  for (const crest of crestPoints) {
    let footX = crest.x, footY = crest.y, footZ = crest.z;
    // Trace the terrain down toward the camera. The fan provides the broad
    // buttress direction; the sampled height determines where its foot ends.
    const traceStep = Math.max(1, 4 * scale);
    for (let y = crest.y + traceStep; y < height - 2; y += traceStep) {
      // Radial descent from the summit opens the buttresses into a foot,
      // instead of forcing every face into a parallel vertical strip.
      const fan = (crest.x - summitX) / (width * 0.48);
      const x = Math.max(1, Math.min(width - 2, crest.x + (y - crest.y) * fan));
      if (isWater(x, y)) break;
      const z = sample(x, y);
      if (z > footZ + relief * 0.06 && footZ < crest.z - relief * 0.4) break;
      footX = x; footY = y; footZ = Math.min(footZ, z);
      if (z < base + relief * 0.22) break;
      if (y - crest.y > height * 0.36) break;
    }
    profiles.push({ crest, footX, footY, footZ });
  }
  for (let profileIndex = 0; profileIndex < profiles.length; profileIndex++) {
    const { crest, footX, footY, footZ } = profiles[profileIndex];
    // Selective cartographic foreshortening: retain the DEM crest's bends,
    // but let elevation establish its silhouette instead of letting its
    // overhead Y meander overwhelm the peak. Ground feet remain DEM anchored.
    const crestY = Math.min(footY - 1, summitY + (crest.y - summitY) * 0.2);
    // Consolidate the broad sampled summit into a narrower illustrated crown.
    // This is an explicit art deformation of the face mesh, not a change to
    // the DEM. The summit stays fixed and the lower buttresses retain their
    // terrain-derived feet. Without this, a broad plateau reads as a curtain.
    const crownX = summitX + (crest.x - summitX) * 0.5;
    const shoulder = clamp01(Math.abs(crest.x - summitX) / (width * 0.38));
    const crownZ = crest.z - Math.max(0, crest.z - footZ) * shoulder * 0.4;
    const rib: number[] = [];
    let previousZ = crownZ;
    for (const t of rows) {
      const x = crownX + (footX - crownX) * t;
      const y = crestY + (footY - crestY) * t;
      // A readable main plane with terrain-derived shoulders. The original
      // samples influence geometry here, not an unrelated shading overlay.
      const linear = crownZ + (footZ - crownZ) * t;
      const z = t === 0 ? crownZ : t === 1 ? footZ
        : Math.max(footZ, Math.min(previousZ, linear * 0.65 + sample(x, crest.y + (footY - crest.y) * t) * 0.35));
      rib.push(add({ x, y, elevationM: z, baseM: footZ }));
      previousZ = z;
    }
    geometry.ribs.push(rib);
    geometry.crest.push(rib[0]);
    geometry.foot.push(rib[rib.length - 1]);
  }

  const normal = (a: number, b: number, c: number): [number, number, number] => {
    const p = geometry.vertices[a], q = geometry.vertices[b], r = geometry.vertices[c];
    const ux = (q.x - p.x) * dem.dxMeters, uy = (q.y - p.y) * dem.dyMeters;
    const vx = (r.x - p.x) * dem.dxMeters, vy = (r.y - p.y) * dem.dyMeters;
    const uz = q.elevationM - p.elevationM, vz = r.elevationM - p.elevationM;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const length = Math.max(1e-9, Math.hypot(nx, ny, nz));
    return [nx / length, ny / length, nz / length];
  };
  for (let rib = 1; rib < geometry.ribs.length; rib++) {
    const left = geometry.ribs[rib - 1], right = geometry.ribs[rib];
    const trough: number[] = [];
    for (let row = 0; row < rows.length; row++) {
      const a = geometry.vertices[left[row]], b = geometry.vertices[right[row]];
      const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
      const z = (a.elevationM + b.elevationM) / 2, baseM = (a.baseM + b.baseM) / 2;
      // Sculpt a shallow gully between adjacent buttresses. Its depth is
      // relative to this face's actual relief and vanishes at crest and foot.
      const sag = Math.sin(Math.PI * rows[row]) * (Math.max(0,
        (geometry.vertices[left[0]].elevationM + geometry.vertices[right[0]].elevationM) / 2 - baseM)) * 0.055;
      trough.push(add({ x, y, elevationM: Math.max(baseM, z - sag), baseM }));
    }
    for (let row = 1; row < rows.length; row++) {
      for (const [a, b] of [[left, trough], [trough, right]]) {
        const triangles: [number, number, number][] = [
          [a[row - 1], b[row - 1], a[row]], [b[row - 1], b[row], a[row]],
        ];
        for (const vertices of triangles) geometry.panels.push({ vertices, normal: normal(...vertices) });
      }
    }
  }
  return geometry;
}

export interface MountainFaceRenderOptions {
  viewAngleDeg?: number;
  heightExaggeration?: number;
  /** Two flat values by default; continuous plane lighting is a diagnostic. */
  twoTone?: boolean;
  ink?: boolean;
  outputScale?: number;
}

/** Rasterize the shared geometry with a depth buffer, then its visible edges. */
export function renderMountainFaceGeometry(
  geometry: MountainFaceGeometry,
  dem: MountainDEMData,
  options: MountainFaceRenderOptions = {},
): { width: number; height: number; data: Uint8ClampedArray } {
  const scale = options.outputScale ?? 1;
  const width = Math.round(geometry.sourceWidth * scale), height = Math.round(geometry.sourceHeight * scale);
  const data = new Uint8ClampedArray(width * height * 4);
  const depth = new Float32Array(width * height).fill(-Infinity);
  const settings = normalizeMountainProjectionSettings(options.viewAngleDeg, options.heightExaggeration);
  const clearance = new Float32Array(dem.width * dem.height);
  for (let x = 0; x < dem.width; x++) {
    // Bilinear sampling must never interpolate Infinity (Infinity * 0 is
    // NaN). A finite distance beyond the map is ample for the bounded lift.
    let waterY = -dem.height - 1024;
    for (let y = 0; y < dem.height; y++) {
      const i = y * dem.width + x;
      if (dem.isOcean[i] || dem.isRiverChannel[i] || dem.visualWaterMask?.[i]) waterY = y;
      clearance[i] = Math.max(0, y - waterY - 2);
    }
  }
  const points = geometry.vertices.map(p => ({ x: p.x * scale, y: (p.y - mountainProjectionLift(
    p.elevationM - p.baseM, geometry.dyMeters,
    sampleScalarField(clearance, dem.width, dem.height, p.x, p.y),
    Math.min(dem.width, dem.height) / 1024, settings,
  )) * scale, depth: p.y }));
  const water = (x: number, y: number) => {
    const i = Math.min(dem.height - 1, Math.floor(y / scale)) * dem.width + Math.min(dem.width - 1, Math.floor(x / scale));
    return !!(dem.isOcean[i] || dem.isRiverChannel[i] || dem.visualWaterMask?.[i]);
  };
  const edge = (a: { x: number; y: number }, b: { x: number; y: number }, x: number, y: number) =>
    (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
  for (const panel of geometry.panels) {
    const [a, b, c] = panel.vertices.map(index => points[index]);
    const area = edge(a, b, c.x, c.y);
    if (Math.abs(area) <= 1e-8) continue;
    const light = clamp01(panel.normal[0] * -0.5 + panel.normal[1] * -0.5 + panel.normal[2] * Math.SQRT1_2);
    const tone = options.twoTone === false ? 0.2 + light * 0.8 : light > 0.25 ? 1 : 0;
    const color = [122, 112, 96].map((v, channel) => v + ([212, 201, 177][channel] - v) * tone);
    for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))); y <= Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))); x <= Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x))); x++) {
        const wa = edge(b, c, x + 0.5, y + 0.5) / area;
        const wb = edge(c, a, x + 0.5, y + 0.5) / area;
        const wc = 1 - wa - wb;
        if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7 || water(x, y)) continue;
        const z = wa * a.depth + wb * b.depth + wc * c.depth, i = y * width + x;
        if (z < depth[i]) continue;
        depth[i] = z;
        for (let channel = 0; channel < 3; channel++) data[i * 4 + channel] = color[channel];
        data[i * 4 + 3] = 255;
      }
    }
  }
  if (options.ink !== false) {
    const draw = (path: number[], radius: number, opacity: number) => {
      for (let j = 1; j < path.length; j++) {
        const a = points[path[j - 1]], b = points[path[j]];
        const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
        if (length2 < 1e-8) continue;
        for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius)); y <= Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + radius)); y++) {
          for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius)); x <= Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + radius)); x++) {
            const t = clamp01(((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / length2);
            const alpha = clamp01(radius + 0.5 - Math.hypot(x + 0.5 - a.x - t * dx, y + 0.5 - a.y - t * dy)) * opacity;
            const i = y * width + x;
            if (alpha <= 0 || !data[i * 4 + 3] || depth[i] > a.depth + t * (b.depth - a.depth) + 3) continue;
            for (let channel = 0; channel < 3; channel++) data[i * 4 + channel] = data[i * 4 + channel] * (1 - alpha) + [63, 54, 44][channel] * alpha;
          }
        }
      }
    };
    draw(geometry.crest, 1.3 * scale, 0.95);
    for (const rib of geometry.ribs) draw(rib.slice(0, -1), 0.65 * scale, 0.6);
    draw(geometry.foot, 0.5 * scale, 0.3);
  }
  return { width, height, data };
}

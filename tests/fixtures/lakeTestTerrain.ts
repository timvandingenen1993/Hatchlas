/**
 * A synthetic heightmap for checking lakes. A plateau sloping south holds
 * three closed basins in a row; each spills through a notch in its south rim
 * into a valley that runs off the south edge. Only the basin floors differ:
 *
 * - flat: a floor of exactly one height, like a playa
 * - gentle: a dish a few 16-bit steps deep, shallower than the depth floor
 * - cone: a deep V-shaped bowl
 *
 * In a wet climate all three fill to their notch and spill; in a dry one the
 * river ends in a lake held below the notch. Heights are normalized 0-1 and
 * rounded to 16-bit steps, as the generated PNG stores them.
 */

export interface LakeTestBasin {
  name: 'flat' | 'gentle' | 'cone';
  /** Centre, as a fraction of map width and height. */
  u: number;
  v: number;
}

export const LAKE_TEST_BASINS: readonly LakeTestBasin[] = [
  { name: 'flat', u: 0.2, v: 0.33 },
  { name: 'gentle', u: 0.5, v: 0.33 },
  { name: 'cone', u: 0.8, v: 0.33 },
];
/** Outer radius of a basin and radius of its floor, as fractions of the map. */
export const LAKE_TEST_RADIUS = 0.14;
export const LAKE_TEST_FLOOR_RADIUS = 0.07;
export const LAKE_TEST_FLOOR = 0.05;
/** Height of each basin's spill notch. */
export const LAKE_TEST_NOTCH = 0.058;

const STEP = 1 / 65535;

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Plateau falling gently south, then steeply to the south edge. */
const plateau = (v: number): number =>
  v < 0.6 ? 0.13 - 0.03 * v : 0.01 + 0.102 * (1 - smoothstep(0.6, 1, v));

function basinFloor(name: LakeTestBasin['name'], r: number): number {
  if (name === 'flat') return LAKE_TEST_FLOOR;
  if (name === 'gentle') return LAKE_TEST_FLOOR + 3 * STEP * (r / LAKE_TEST_FLOOR_RADIUS) ** 2;
  return LAKE_TEST_FLOOR - 0.006 + 0.006 * (r / LAKE_TEST_FLOOR_RADIUS);
}

export function lakeTestTerrain(width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  // Basin shapes are round in map units whatever the aspect.
  const scale = Math.max(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / scale;
      const v = y / scale;
      const ground = plateau(v);
      let z = ground;
      for (const basin of LAKE_TEST_BASINS) {
        const r = Math.hypot(u - basin.u, v - basin.v);
        if (r < LAKE_TEST_RADIUS) {
          const floor = basinFloor(basin.name, Math.min(r, LAKE_TEST_FLOOR_RADIUS));
          const wall = smoothstep(LAKE_TEST_FLOOR_RADIUS, LAKE_TEST_RADIUS, r);
          z = Math.min(z, floor + (ground - floor) * wall);
        }
        // The notch and the valley below it, cut south from the basin centre.
        if (v > basin.v) {
          const fall = 1.2 * Math.max(0, v - (basin.v + LAKE_TEST_RADIUS));
          z = Math.min(z, LAKE_TEST_NOTCH - fall + 6 * Math.abs(u - basin.u));
        }
      }
      out[y * width + x] = Math.round(Math.min(1, Math.max(0, z)) / STEP) * STEP;
    }
  }
  return out;
}

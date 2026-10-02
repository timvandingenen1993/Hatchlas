/**
 * Equal Earth Map Projection
 * Reference: Šavrič, Patterson & Jenny (2019), "The Equal Earth Map Projection", Int. J. Geogr. Inf. Sci.
 * 
 * An equal-area pseudo-cylindrical projection with curved meridians, designed as a modern
 * visually pleasing alternative for world maps.
 */

import type { LatLonRad, Point2D, ProjectionDefinition, ProjectionExtents } from './types';
export type { Point2D, LatLonRad };

const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const SQRT3 = Math.sqrt(3);

/**
 * Forward Equal Earth Projection
 * Converts spherical (latRad, lonRad) to normalized projection plane (x, y)
 * - latRad: [-PI/2, +PI/2]
 * - lonRad: [-PI, +PI]
 * Returns normalized coordinates: x in [-2.674, +2.674], y in [-1.317, +1.317]
 */
export function equalEarthForward(latRad: number, lonRad: number): Point2D {
  const sinPhi = Math.sin(latRad);
  const sinTheta = (SQRT3 / 2) * sinPhi;
  const theta = Math.asin(Math.max(-1.0, Math.min(1.0, sinTheta)));
  const theta2 = theta * theta;
  const theta6 = theta2 * theta2 * theta2;

  const polyY = A1 + A2 * theta2 + A3 * theta6 + A4 * theta6 * theta2;
  const polyX = A1 + 3 * A2 * theta2 + 7 * A3 * theta6 + 9 * A4 * theta6 * theta2;

  const y = theta * polyY;
  const x = (2 * SQRT3 * lonRad * Math.cos(theta)) / (3 * polyX);

  return { x, y };
}

/**
 * Inverse Equal Earth Projection
 * Converts normalized plane (x, y) to spherical (latRad, lonRad)
 * Returns null if the point falls outside the valid projected globe area.
 */
export function equalEarthInverse(x: number, y: number): LatLonRad | null {
  // Max Y extent of Equal Earth projection is approx +/- 1.31705
  const maxY = 1.31705;
  if (Math.abs(y) > maxY) return null;

  // Newton-Raphson iteration to invert y(theta) = theta * (A1 + A2*theta^2 + A3*theta^6 + A4*theta^8)
  let theta = y; // initial guess
  for (let iter = 0; iter < 8; iter++) {
    const theta2 = theta * theta;
    const theta6 = theta2 * theta2 * theta2;
    const f = theta * (A1 + A2 * theta2 + A3 * theta6 + A4 * theta6 * theta2) - y;
    const fPrime = A1 + 3 * A2 * theta2 + 7 * A3 * theta6 + 9 * A4 * theta6 * theta2;
    const delta = f / fPrime;
    theta -= delta;
    if (Math.abs(delta) < 1e-9) break;
  }

  const sinTheta = Math.sin(theta);
  const sinPhi = (2 / SQRT3) * sinTheta;

  // Point is outside latitude bounds
  if (Math.abs(sinPhi) > 1.0) return null;

  const latRad = Math.asin(Math.max(-1.0, Math.min(1.0, sinPhi)));
  const cosTheta = Math.cos(theta);

  if (Math.abs(cosTheta) < 1e-6) {
    return { latRad, lonRad: 0 };
  }

  const theta2 = theta * theta;
  const theta6 = theta2 * theta2 * theta2;
  const polyX = A1 + 3 * A2 * theta2 + 7 * A3 * theta6 + 9 * A4 * theta6 * theta2;

  const lonRad = (3 * x * polyX) / (2 * SQRT3 * cosTheta);

  // Point is outside longitude bounds [-PI, +PI]
  if (Math.abs(lonRad) > Math.PI + 1e-4) return null;

  return {
    latRad,
    lonRad: Math.max(-Math.PI, Math.min(Math.PI, lonRad)),
  };
}

/**
 * Aspect ratio of Equal Earth bounding box (Width / Height)
 * Total X range: [-2.6740, +2.6740] (Total width = 5.348)
 * Total Y range: [-1.3171, +1.3171] (Total height = 2.6342)
 * Aspect ratio = 5.348 / 2.6342 ≈ 2.0547
 */
export const EQUAL_EARTH_ASPECT_RATIO = 2.0547;
export const EQUAL_EARTH_EXTENTS: ProjectionExtents = {
  minX: -2.6740,
  maxX: 2.6740,
  minY: -1.3171,
  maxY: 1.3171,
};

export const EQUAL_EARTH_PROJECTION: ProjectionDefinition = {
  id: 'equal_earth',
  name: 'Equal Earth (Equal-Area 2.05:1)',
  shortName: 'Equal Earth',
  description: 'Equal-area pseudo-cylindrical projection with curved meridians. Preserves relative continent sizes without polar squishing.',
  aspectRatio: EQUAL_EARTH_ASPECT_RATIO,
  extents: EQUAL_EARTH_EXTENTS,
  forward: equalEarthForward,
  inverse: equalEarthInverse,
};

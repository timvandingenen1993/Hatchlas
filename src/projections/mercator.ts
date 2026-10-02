import type { LatLonRad, Point2D, ProjectionDefinition, ProjectionExtents } from './types';

/**
 * Spherical / Web Mercator Map Projection (EPSG:3857 conformal mapping)
 * 
 * Standard conformal cylindrical projection, preserving angles and shapes locally.
 * Widely used for RPG / fantasy world mapping, tabletop virtual tabletops (VTTs),
 * navigation charts, and web map tile pyramids.
 * 
 * Maximum latitude bounds: ~85.05112878° (yielding a 1:1 square aspect ratio).
 */

export const MERCATOR_MAX_LAT_RAD = 1.4844222297453322; // 2 * atan(exp(PI)) - PI/2
export const MERCATOR_MAX_LAT_DEG = (MERCATOR_MAX_LAT_RAD * 180) / Math.PI; // ~85.051129°
export const MERCATOR_ASPECT_RATIO = 1.0;

export const MERCATOR_EXTENTS: ProjectionExtents = {
  minX: -Math.PI,
  maxX: Math.PI,
  minY: -Math.PI,
  maxY: Math.PI,
};

/**
 * Forward Mercator Projection
 * Converts spherical coordinates (latRad, lonRad) to normalized projection plane (x, y)
 * - latRad: [-MERCATOR_MAX_LAT_RAD, +MERCATOR_MAX_LAT_RAD]
 * - lonRad: [-PI, +PI]
 * Returns (x, y) in [-PI, +PI]
 */
export function mercatorForward(latRad: number, lonRad: number): Point2D {
  const clampedLat = Math.max(-MERCATOR_MAX_LAT_RAD, Math.min(MERCATOR_MAX_LAT_RAD, latRad));
  const clampedLon = Math.max(-Math.PI, Math.min(Math.PI, lonRad));

  const y = Math.log(Math.tan(Math.PI / 4 + clampedLat / 2));
  const x = clampedLon;

  return {
    x: Math.max(-Math.PI, Math.min(Math.PI, x)),
    y: Math.max(-Math.PI, Math.min(Math.PI, y)),
  };
}

/**
 * Inverse Mercator Projection
 * Converts normalized projection plane (x, y) back to spherical coordinates (latRad, lonRad)
 * Returns null if (x, y) falls outside the valid projection bounds [-PI, +PI].
 */
export function mercatorInverse(x: number, y: number): LatLonRad | null {
  // Allow slight epsilon tolerance for floating point bounds
  if (Math.abs(x) > Math.PI + 1e-4 || Math.abs(y) > Math.PI + 1e-4) {
    return null;
  }

  const clampedX = Math.max(-Math.PI, Math.min(Math.PI, x));
  const clampedY = Math.max(-Math.PI, Math.min(Math.PI, y));

  // Gudermannian function: lat = 2 * atan(exp(y)) - PI/2 = asin(tanh(y))
  const latRad = 2 * Math.atan(Math.exp(clampedY)) - Math.PI / 2;
  const lonRad = clampedX;

  return {
    latRad: Math.max(-MERCATOR_MAX_LAT_RAD, Math.min(MERCATOR_MAX_LAT_RAD, latRad)),
    lonRad,
  };
}

export const MERCATOR_PROJECTION: ProjectionDefinition = {
  id: 'mercator',
  name: 'Mercator (Conformal 1:1)',
  shortName: 'Mercator',
  description: 'Conformal cylindrical projection preserving local shapes and angles. Standard for RPG grids and web tiles.',
  aspectRatio: MERCATOR_ASPECT_RATIO,
  extents: MERCATOR_EXTENTS,
  forward: mercatorForward,
  inverse: mercatorInverse,
  maxLatitudeDeg: MERCATOR_MAX_LAT_DEG,
};

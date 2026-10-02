import type { LatLonRad, Point2D, ProjectionDefinition, ProjectionExtents } from './types';

/**
 * Equirectangular / Plate Carrée Map Projection
 * 
 * Standard cylindrical equidistant projection (2:1 aspect ratio) mapping longitude linearly
 * to X and latitude linearly to Y. Standard texture mapping format for spherical 3D globes,
 * game engines (Unity, Unreal Engine), and Blender.
 */

export const EQUIRECTANGULAR_ASPECT_RATIO = 2.0;

export const EQUIRECTANGULAR_EXTENTS: ProjectionExtents = {
  minX: -Math.PI,
  maxX: Math.PI,
  minY: -Math.PI / 2,
  maxY: Math.PI / 2,
};

/**
 * Forward Equirectangular Projection
 */
export function equirectangularForward(latRad: number, lonRad: number): Point2D {
  const clampedLat = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, latRad));
  const clampedLon = Math.max(-Math.PI, Math.min(Math.PI, lonRad));
  return {
    x: clampedLon,
    y: clampedLat,
  };
}

/**
 * Inverse Equirectangular Projection
 */
export function equirectangularInverse(x: number, y: number): LatLonRad | null {
  if (Math.abs(x) > Math.PI + 1e-4 || Math.abs(y) > Math.PI / 2 + 1e-4) {
    return null;
  }
  return {
    latRad: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, y)),
    lonRad: Math.max(-Math.PI, Math.min(Math.PI, x)),
  };
}

export const EQUIRECTANGULAR_PROJECTION: ProjectionDefinition = {
  id: 'equirectangular',
  name: 'Equirectangular (Plate Carrée 2:1)',
  shortName: 'Plate Carrée',
  description: 'Standard 2:1 linear latitude/longitude projection. Industry standard for 3D sphere unwrapping and game engines.',
  aspectRatio: EQUIRECTANGULAR_ASPECT_RATIO,
  extents: EQUIRECTANGULAR_EXTENTS,
  forward: equirectangularForward,
  inverse: equirectangularInverse,
};

/**
 * Shared types for map projections: points, extents and the forward/inverse projection interface.
 */
export type ProjectionType = 'equal_earth' | 'mercator' | 'equirectangular';

export interface Point2D {
  x: number;
  y: number;
}

export interface LatLonRad {
  latRad: number;
  lonRad: number;
}

export interface ProjectionExtents {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface ProjectionDefinition {
  id: ProjectionType;
  name: string;
  shortName: string;
  description: string;
  aspectRatio: number; // width / height
  extents: ProjectionExtents;
  forward: (latRad: number, lonRad: number) => Point2D;
  inverse: (x: number, y: number) => LatLonRad | null;
  maxLatitudeDeg?: number;
}

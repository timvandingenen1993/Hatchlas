/**
 * Map projection registry (Equal Earth, Mercator, equirectangular) with a lookup by type.
 */
import type { ProjectionDefinition, ProjectionType } from './types';
import { EQUAL_EARTH_PROJECTION } from './equalEarth';
import { MERCATOR_PROJECTION } from './mercator';
import { EQUIRECTANGULAR_PROJECTION } from './equirectangular';

export * from './types';
export * from './equalEarth';
export * from './mercator';
export * from './equirectangular';
export * from './rasterizer';

export const PROJECTIONS: Record<ProjectionType, ProjectionDefinition> = {
  equal_earth: EQUAL_EARTH_PROJECTION,
  mercator: MERCATOR_PROJECTION,
  equirectangular: EQUIRECTANGULAR_PROJECTION,
};

export const PROJECTION_LIST: ProjectionDefinition[] = [
  EQUAL_EARTH_PROJECTION,
  MERCATOR_PROJECTION,
  EQUIRECTANGULAR_PROJECTION,
];

export function getProjection(type: ProjectionType): ProjectionDefinition {
  return PROJECTIONS[type] || EQUAL_EARTH_PROJECTION;
}

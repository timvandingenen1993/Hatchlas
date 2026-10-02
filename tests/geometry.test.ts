import { describe, it, expect } from 'vitest';
import { buildCubedSphereGrid, cellCenterDistanceMeters, getCubedSphereNeighbor } from '../src/geometry/cubedSphere';
import { greatCircleDistance, latLonRadToVec3, vec3ToLatLonRad } from '../src/geometry/coordinates';

describe('Spherical Geometry & Cubed-Sphere Grid (Ronchi et al. 1996)', () => {
  it('should maintain exact 4-neighbor reciprocity across all cube edges and seams', () => {
    const N = 32; // Fast test resolution
    const grid = buildCubedSphereGrid(N, 6371000);
    const totalCells = grid.totalCells;

    for (let idx = 0; idx < totalCells; idx++) {
      for (let k = 0; k < 4; k++) {
        const neighborIdx = grid.neighbors[idx * 4 + k];
        expect(neighborIdx).toBeGreaterThanOrEqual(0);
        expect(neighborIdx).toBeLessThan(totalCells);
        expect(neighborIdx).not.toBe(idx); // No self-loops

        // Verify reciprocity: neighbor must point back to current cell in one of its 4 directions
        let reciprocalFound = false;
        for (let nk = 0; nk < 4; nk++) {
          if (grid.neighbors[neighborIdx * 4 + nk] === idx) {
            reciprocalFound = true;
            break;
          }
        }
        expect(reciprocalFound).toBe(true);
      }
    }
  });

  it('should compute exact total surface area equal to 4*PI*R^2', () => {
    const R = 6371000;
    const grid = buildCubedSphereGrid(48, R);
    const expectedArea = 4 * Math.PI * R * R;

    let sumArea = 0;
    for (let idx = 0; idx < grid.totalCells; idx++) {
      sumArea += grid.cellAreas[idx];
    }

    const relativeError = Math.abs(sumArea - expectedArea) / expectedArea;
    expect(relativeError).toBeLessThan(1e-4);
  });

  it('should round-trip coordinate conversions between S^2 Cartesian and spherical Lat/Lon', () => {
    const testPoints: [number, number][] = [
      [0, 0],
      [Math.PI / 4, Math.PI / 3],
      [-Math.PI / 3, -Math.PI / 2],
      [Math.PI / 2 - 0.01, Math.PI - 0.01],
      [-Math.PI / 2 + 0.01, -Math.PI + 0.01],
    ];

    for (const [lat, lon] of testPoints) {
      const v = latLonRadToVec3(lat, lon);
      const [rtLat, rtLon] = vec3ToLatLonRad(v);

      expect(Math.abs(rtLat - lat)).toBeLessThan(1e-6);
      expect(Math.abs(rtLon - lon)).toBeLessThan(1e-6);
    }
  });

  it('should correctly calculate great circle geodesic distances', () => {
    const R = 6371000;
    const northPole = latLonRadToVec3(Math.PI / 2, 0);
    const southPole = latLonRadToVec3(-Math.PI / 2, 0);
    const equator = latLonRadToVec3(0, 0);

    const poleToPole = greatCircleDistance(northPole, southPole, R);
    expect(Math.abs(poleToPole - Math.PI * R)).toBeLessThan(1.0);

    const poleToEquator = greatCircleDistance(northPole, equator, R);
    expect(Math.abs(poleToEquator - (Math.PI / 2) * R)).toBeLessThan(1.0);
  });

  it('should retain physical, seam-aware distances for the full routing stencil', () => {
    const grid = buildCubedSphereGrid(32, 6371000);
    let seamDiagonalCount = 0;
    for (let idx = 0; idx < grid.totalCells; idx++) {
      const local = idx % grid.cellsPerFace;
      const i = local % grid.resolution;
      const j = Math.floor(local / grid.resolution);
      const diagonal = getCubedSphereNeighbor(grid, idx, 1, 1);
      expect(diagonal).not.toBe(idx);
      expect(cellCenterDistanceMeters(grid, idx, diagonal)).toBeGreaterThan(1_000.0);
      if (i === grid.resolution - 1 || j === grid.resolution - 1) seamDiagonalCount++;
    }
    expect(seamDiagonalCount).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  createMountainPathSpatialIndex,
  queryMountainPathSpatialIndex,
} from '../src/rendering/mountainPathSpatialIndex';
import { paintInkSegmentsBatched, type BatchedInkSegment } from '../src/rendering/cartographicStrokeRenderer';
import type { MountainStrokePath } from '../src/rendering/mountainPatternRenderer';

function path(key: number, points: MountainStrokePath['points'], width = 0.5): MountainStrokePath {
  return { kind: 'ridge', key, primary: true, width, opacity: 0.8, points };
}

describe('mountain export path spatial index', () => {
  it('keeps whole crossing and boundary paths in original order while skipping distant paths', () => {
    const paths = [
      path(1, [{ x: 10, y: 20 }, { x: 20, y: 20 }]),
      path(2, [{ x: 80, y: 80 }, { x: 90, y: 80 }]),
      path(3, [{ x: 24, y: 10 }, { x: 24, y: 110 }], 1.2),
      path(4, [{ x: 40, y: 40 }, { x: 40, y: 41 }]),
    ];
    const index = createMountainPathSpatialIndex(paths, 128, 128, 1024, 1024);
    const query = queryMountainPathSpatialIndex(index, 65, 145, 35, 35, 20);

    expect(query.paths.map(candidate => candidate.key)).toEqual([1, 3]);
    expect(query.paths[1].points).toEqual(paths[2].points);
    expect(query.totalPaths).toBe(4);
    expect(query.totalPoints).toBe(8);
    expect(query.selectedPoints).toBe(4);

    const rasterize = (selectedPaths: readonly MountainStrokePath[]) => {
      const alpha = new Uint8Array(1024 * 1024);
      const clip = new Uint8Array(alpha.length).fill(255);
      const segments: BatchedInkSegment[] = [];
      for (const candidate of selectedPaths) {
        for (let point = 1; point < candidate.points.length; point++) {
          segments.push({
            x0: candidate.points[point - 1].x * (1023 / 127),
            y0: candidate.points[point - 1].y * (1023 / 127),
            x1: candidate.points[point].x * (1023 / 127),
            y1: candidate.points[point].y * (1023 / 127),
            radius: candidate.width * 8 * 2.1,
            seed: candidate.key,
            smoothing: 2,
            taperStart: false,
            taperEnd: false,
            opacity: candidate.opacity,
            drySkipProbability: 0,
          });
        }
      }
      paintInkSegmentsBatched(alpha, clip, 1024, 1024, segments);
      return alpha;
    };
    const fullRaster = rasterize(paths);
    const selectedRaster = rasterize(query.paths);
    for (let y = 145; y < 180; y++) {
      expect(selectedRaster.slice(y * 1024 + 65, y * 1024 + 100)).toEqual(
        fullRaster.slice(y * 1024 + 65, y * 1024 + 100),
      );
    }
  });

  it('retains long crossing paths and uncertain bounds conservatively', () => {
    const paths = [
      path(1, [{ x: 0, y: 64 }, { x: 127, y: 64 }]),
      path(2, [{ x: Number.NaN, y: 12 }, { x: 16, y: 12 }]),
      path(3, [{ x: 2, y: 2 }, { x: 3, y: 3 }]),
    ];
    const index = createMountainPathSpatialIndex(paths, 128, 128, 1024, 1024);
    const query = queryMountainPathSpatialIndex(index, 500, 500, 24, 24, 0);

    expect(query.paths.map(candidate => candidate.key)).toEqual([1, 2]);
  });
});

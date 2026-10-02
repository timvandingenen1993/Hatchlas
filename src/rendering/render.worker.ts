/**
 * Worker that renders a world layer to pixels off the main thread.
 */
import type { WorldV2 } from '../types/worldV2';
import type { CubedSphereGrid } from '../geometry/cubedSphere';
import { rasterizeProjectedLayer, type RasterizeOptions } from '../projections/rasterizer';

export interface WorkerRenderRequest {
  id: number;
  world: WorldV2;
  grid: CubedSphereGrid;
  options: RasterizeOptions;
}

export interface WorkerRenderResponse {
  id: number;
  imageBitmap?: ImageBitmap;
  imageData?: ImageData;
  error?: string;
}

self.onmessage = async (e: MessageEvent<WorkerRenderRequest>) => {
  const { id, world, grid, options } = e.data;

  try {
    const rawImageData = rasterizeProjectedLayer(world, grid, options);

    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(rawImageData);
      const res: WorkerRenderResponse = { id, imageBitmap: bitmap };
      (self as any).postMessage(res, [bitmap]);
    } else {
      const res: WorkerRenderResponse = { id, imageData: rawImageData };
      (self as any).postMessage(res);
    }
  } catch (err: any) {
    const res: WorkerRenderResponse = { id, error: err.message || 'Worker render failure' };
    (self as any).postMessage(res);
  }
};

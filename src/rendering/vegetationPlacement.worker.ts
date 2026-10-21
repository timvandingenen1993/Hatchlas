/**
 * Places raster props for a group of biomes, or builds some of the forest
 * stands, for parallelPropPlacement.
 */
import type { MountainDEMData } from "../terrain/mountainBaseDEM";
import {
  buildPropStandsForBuckets,
  placeRasterPropsInBiomes,
  type VegetationPatternOptions,
  type VegetationRasterPropPlacement,
} from "./vegetationRenderer";

interface PlacementMessage {
  id: number;
  dem: MountainDEMData;
  options: VegetationPatternOptions | undefined;
  biomes: number[];
  /** Keep the DEM for this render's stand step (sent without one). */
  keepDem?: boolean;
}

interface StandsMessage {
  kind: "stands";
  id: number;
  /** Absent: the DEM of the last placement message. */
  dem?: MountainDEMData;
  options: VegetationPatternOptions | undefined;
  rasterProps: VegetationRasterPropPlacement[];
  bucketIndices: number[];
}

let keptDem: MountainDEMData | undefined;

self.onmessage = (event: MessageEvent<PlacementMessage | StandsMessage>) => {
  const message = event.data;
  try {
    if ("kind" in message) {
      const dem = message.dem ?? keptDem;
      // The stand step ends the render: release the kept snapshot.
      keptDem = undefined;
      if (!dem) throw new Error("Stand helper has no DEM");
      const stands = buildPropStandsForBuckets(dem, message.options, message.rasterProps, message.bucketIndices);
      // The stand masks are map-sized; hand them over instead of copying.
      const transfer: ArrayBuffer[] = [];
      for (const stand of stands) {
        for (const field of [stand.geometry.mask, stand.geometry.shade, stand.debug?.plants, stand.debug?.area]) {
          if (field && field.buffer instanceof ArrayBuffer && !transfer.includes(field.buffer)) transfer.push(field.buffer);
        }
      }
      self.postMessage({ id: message.id, stands }, { transfer });
      return;
    }
    keptDem = message.keepDem ? message.dem : undefined;
    self.postMessage({ id: message.id, lists: placeRasterPropsInBiomes(message.dem, message.options, message.biomes) });
  } catch (error) {
    self.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
};

/**
 * Places raster props for a group of biomes, for parallelPropPlacement.
 */
import type { MountainDEMData } from "../terrain/mountainBaseDEM";
import { placeRasterPropsInBiomes, type VegetationPatternOptions } from "./vegetationRenderer";

interface PlacementMessage {
  id: number;
  dem: MountainDEMData;
  options: VegetationPatternOptions | undefined;
  biomes: number[];
}

self.onmessage = (event: MessageEvent<PlacementMessage>) => {
  const { id, dem, options, biomes } = event.data;
  try {
    self.postMessage({ id, lists: placeRasterPropsInBiomes(dem, options, biomes) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};

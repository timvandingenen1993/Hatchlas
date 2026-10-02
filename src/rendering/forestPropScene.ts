/**
 * Builds the placement geometry for the forest-props review page from a synthetic slope.
 */
import {
  buildVegetationRasterPropPlacements,
  type VegetationPlacementTerrain,
  type VegetationRasterPropAsset,
  type VegetationRasterPropPlacement,
} from "./vegetationRenderer";

export const FOREST_SIMULATION_WIDTH = 1536;
export const FOREST_SIMULATION_HEIGHT = 1152;

// Forest prop placement needs only habitat membership. The old preview DEM
// allocated more than 170 MiB of constant terrain fields, then ran unrelated
// water, flow, and vegetation preparation before returning these placements.
const FOREST_PREVIEW_TERRAIN: VegetationPlacementTerrain = {
  width: FOREST_SIMULATION_WIDTH,
  height: FOREST_SIMULATION_HEIGHT,
  biomeType: new Uint8Array(
    FOREST_SIMULATION_WIDTH * FOREST_SIMULATION_HEIGHT,
  ).fill(3),
};

export interface ForestPreviewGeometry {
  width: number;
  height: number;
  rasterProps: VegetationRasterPropPlacement[];
}

export function buildForestPreviewGeometry(
  density: number,
  clustering: number,
  seed: number,
  rasterPropAssets: readonly VegetationRasterPropAsset[],
): ForestPreviewGeometry {
  return {
    width: FOREST_SIMULATION_WIDTH,
    height: FOREST_SIMULATION_HEIGHT,
    rasterProps: buildVegetationRasterPropPlacements(
      FOREST_PREVIEW_TERRAIN,
      {
        seed,
        density: 0,
        motifDensity: 0,
        rasterPropAssets,
        rasterPropDensity: density,
        rasterPropCellSize: 16,
        rasterPropClustering: clustering,
        rasterPropStandSize: 0.72,
        strokeOpacity: 0.9,
        inkColor: "#30452f",
        flowWashStrength: 0,
        motifShadowStrength: 0,
        showFlowGuides: false,
      },
    ),
  };
}

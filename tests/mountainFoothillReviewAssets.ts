import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VegetationRasterPropAsset } from "../src/rendering/vegetationRenderer";
import {
  MOUNTAIN_FOOTHILL_PROP_DEFINITIONS,
  parseSvgVectorAsset,
} from "../src/rendering/vegetationMotifs";

function loadMountainBoulderSvg(
  definition: typeof MOUNTAIN_FOOTHILL_PROP_DEFINITIONS[number],
): VegetationRasterPropAsset {
  const assetNumber = definition.key.slice("mountain-boulder-".length);
  const path = join(
    process.cwd(),
    "src/assets/BiomeProps/Mountain/foothills",
    `boulder${assetNumber}.svg`,
  );
  const vector = parseSvgVectorAsset(readFileSync(path, "utf8"));
  if (!vector) throw new Error(`Failed to parse ${path}`);
  return {
    ...definition,
    ...vector,
    data: new Uint8ClampedArray(),
    kind: "raster-prop",
  };
}

/** Review assets parse the same SVG paths used by the production loader. */
export function makeMountainFoothillReviewAssets(): VegetationRasterPropAsset[] {
  return MOUNTAIN_FOOTHILL_PROP_DEFINITIONS.map(loadMountainBoulderSvg);
}

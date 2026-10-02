/**
 * Registry of vegetation art: motif and prop definitions, SVG sources and which biomes they suit.
 */
import shrub01Url from "../assets/vegetation/shrub01.svg";
import shrub02Url from "../assets/vegetation/shrub02.svg";
import shrub03Url from "../assets/vegetation/shrub03.svg";
import shrub04Url from "../assets/vegetation/shrub04.svg";
import shrub05Url from "../assets/vegetation/shrub05.svg";
import shrub06Url from "../assets/vegetation/shrub06.svg";
import shrub07Url from "../assets/vegetation/shrub07.svg";
import shrub08Url from "../assets/vegetation/shrub08.svg";
import shrub09Url from "../assets/vegetation/shrub09.svg";
import shrub10Url from "../assets/vegetation/shrub10.svg";
import shrub11Url from "../assets/vegetation/shrub11.svg";
import line01Url from "../assets/vegetation/line01.svg";
import line02Url from "../assets/vegetation/line02.svg";
import dots02Url from "../assets/vegetation/dots02.svg";
import dots01Url from "../assets/vegetation/dots01.svg";
import wetlandShrub01Url from "../assets/BiomeProps/Wetlands/shrubs/shrub01.svg";
import wetlandShrub02Url from "../assets/BiomeProps/Wetlands/shrubs/shrub02.svg";
import wetlandShrub03Url from "../assets/BiomeProps/Wetlands/shrubs/shrub03.svg";
import wetlandShrub04Url from "../assets/BiomeProps/Wetlands/shrubs/shrub04.svg";
import wetlandShrub05Url from "../assets/BiomeProps/Wetlands/shrubs/shrub05.svg";
import wetlandShrub06Url from "../assets/BiomeProps/Wetlands/shrubs/shrub06.svg";
import alpineTree75Url from "../assets/BiomeProps/Alpine/trees/alpineTree75.svg";
import alpineTree75Variant01Url from "../assets/BiomeProps/Alpine/trees/alpineTree75Variant01.svg";
import alpineTree75Variant02Url from "../assets/BiomeProps/Alpine/trees/alpineTree75Variant02.svg";
import alpineTree75Variant03Url from "../assets/BiomeProps/Alpine/trees/alpineTree75Variant03.svg";
import alpineTree75Variant04Url from "../assets/BiomeProps/Alpine/trees/alpineTree75Variant04.svg";
import alpineTree75Variant05Url from "../assets/BiomeProps/Alpine/trees/alpineTree75Variant05.svg";
import alpineTree75Variant06Url from "../assets/BiomeProps/Alpine/trees/alpineTree75Variant06.svg";
import mountainBoulder01Url from "../assets/BiomeProps/Mountain/foothills/boulder01.svg";
import mountainBoulder02Url from "../assets/BiomeProps/Mountain/foothills/boulder02.svg";
import mountainBoulder03Url from "../assets/BiomeProps/Mountain/foothills/boulder03.svg";
import mountainBoulder04Url from "../assets/BiomeProps/Mountain/foothills/boulder04.svg";
import mountainBoulder05Url from "../assets/BiomeProps/Mountain/foothills/boulder05.svg";
import mountainBoulder06Url from "../assets/BiomeProps/Mountain/foothills/boulder06.svg";
import mountainBoulder07Url from "../assets/BiomeProps/Mountain/foothills/boulder07.svg";
import mountainBoulder08Url from "../assets/BiomeProps/Mountain/foothills/boulder08.svg";
import mountainBoulder09Url from "../assets/BiomeProps/Mountain/foothills/boulder09.svg";
import mountainBoulder10Url from "../assets/BiomeProps/Mountain/foothills/boulder10.svg";

import type {
  VegetationMotifAsset,
  VegetationMotifFamily,
  VegetationMotifVectorPath,
  VegetationRasterPropAsset,
} from "./vegetationRenderer";

export interface VegetationMotifDefinition {
  key: string;
  label: string;
  family: VegetationMotifFamily;
  url: string;
  /** Keep a clean SVG fill alongside its parsed charcoal paths. */
  rasterizeVectorFill?: boolean;
}

export const VEGETATION_MOTIF_DEFINITIONS: readonly VegetationMotifDefinition[] =
  [
    {
      key: "shrub-01",
      label: "shrub_01",
      family: "shrub",
      url: shrub01Url,
    },
    {
      key: "shrub-02",
      label: "shrub_02",
      family: "shrub",
      url: shrub02Url,
    },
    {
      key: "shrub-03",
      label: "shrub_03",
      family: "shrub",
      url: shrub03Url,
    },
    {
      key: "shrub-04",
      label: "shrub_04",
      family: "shrub",
      url: shrub04Url,
    },
    {
      key: "shrub-05",
      label: "shrub_05",
      family: "shrub",
      url: shrub05Url,
    },
    {
      key: "shrub-06",
      label: "shrub_06",
      family: "shrub",
      url: shrub06Url,
    },
    {
      key: "shrub-07",
      label: "shrub_07",
      family: "shrub",
      url: shrub07Url,
    },
    {
      key: "shrub-08",
      label: "shrub_08",
      family: "shrub",
      url: shrub08Url,
    },
    {
      key: "shrub-09",
      label: "shrub_09",
      family: "shrub",
      url: shrub09Url,
    },
    {
      key: "shrub-10",
      label: "shrub_10",
      family: "shrub",
      url: shrub10Url,
    },
    {
      key: "shrub-11",
      label: "shrub_11",
      family: "shrub",
      url: shrub11Url,
    },
    {
      key: "dots-01",
      label: "dots_01",
      family: "universal",
      url: dots01Url,
    },
    {
      key: "line-01",
      label: "line_01",
      family: "universal",
      url: line01Url,
    },
    {
      key: "line-02",
      label: "line_02",
      family: "universal",
      url: line02Url,
    },
    {
      key: "dots-02",
      label: "dots_02",
      family: "universal",
      url: dots02Url,
    },
  ] as const;

export interface VegetationRasterPropDefinition extends VegetationMotifDefinition {
  placementRole?: "vegetation" | "mountain-foothill" | "wetland";
  footprintWidthCells: number;
  footprintHeightCells: number;
  heightCells: number;
  anchorX: number;
  anchorY: number;
  renderWidthCells?: number;
  renderHeightCells?: number;
  renderAnchorX?: number;
  renderAnchorY?: number;
  outlineMode?: "none" | "alpha-dilation";
  outlineGroup?: string;
  /** Which filled vector silhouette the forest canvas should treat as canopy. */
  forestCanopyPathIndex?: number;
  /** Paint closed vector fills using their authored SVG colors. */
  paintVectorFills?: boolean;
  eligibleBiomeIds: readonly number[];
}

// The wetland artwork shares one 400x530 authored drawing canvas. The source
// files keep that canvas so the prop's own path geometry determines its size;
// fitting each cropped SVG to a 1x envelope would make stumps and shrubs as
// large as trees.
const WETLAND_REFERENCE_RENDER_WIDTH_CELLS = 1.55;
const WETLAND_REFERENCE_RENDER_HEIGHT_CELLS = 1.7;

export const ALPINE_TREE_75_ASSET_URLS = [
  alpineTree75Url,
  alpineTree75Variant01Url,
  alpineTree75Variant02Url,
  alpineTree75Variant03Url,
  alpineTree75Variant04Url,
  alpineTree75Variant05Url,
  alpineTree75Variant06Url,
] as const;

/** User-authored wetland shrubs: placed like props, drawn as wetland shrub stands. */
export const WETLAND_VEGETATION_PROP_DEFINITIONS: readonly VegetationRasterPropDefinition[] = [
  ...[
    {
      key: "wetland-shrub-01", label: "Wetland shrub 01", url: wetlandShrub01Url,
      canopyPath: 0,
    },
    {
      key: "wetland-shrub-02", label: "Wetland shrub 02", url: wetlandShrub02Url,
      canopyPath: 0,
    },
    {
      key: "wetland-shrub-03", label: "Wetland shrub 03", url: wetlandShrub03Url,
      canopyPath: 0,
    },
    {
      key: "wetland-shrub-04", label: "Wetland shrub 04", url: wetlandShrub04Url,
      canopyPath: 0,
    },
    {
      key: "wetland-shrub-05", label: "Wetland shrub 05", url: wetlandShrub05Url,
      canopyPath: 0,
    },
    {
      key: "wetland-shrub-06", label: "Wetland shrub 06", url: wetlandShrub06Url,
      canopyPath: 0,
    },
  ].map((shrub) => ({
    ...shrub,
    family: "shrub" as const,
    rasterizeVectorFill: true,
    placementRole: "wetland" as const,
    footprintWidthCells: 1,
    footprintHeightCells: 1,
    heightCells: 0.8,
    anchorX: 0.5,
    anchorY: 1,
    renderWidthCells: WETLAND_REFERENCE_RENDER_WIDTH_CELLS,
    renderHeightCells: WETLAND_REFERENCE_RENDER_HEIGHT_CELLS,
    renderAnchorX: 0.5,
    renderAnchorY: 1,
    outlineGroup: "wetland-forest",
    forestCanopyPathIndex: shrub.canopyPath,
    eligibleBiomeIds: [7],
  })),
] as const;

export const VEGETATION_RASTER_PROP_DEFINITIONS: readonly VegetationRasterPropDefinition[] =
  [
    {
      key: "alpine-tree-75",
      label: "Supplied alpine tree 75° SVG prop",
      family: "universal",
      url: alpineTree75Url,
      rasterizeVectorFill: true,
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 1.7,
      anchorX: 0.5,
      anchorY: 0.5,
      renderWidthCells: 0.95,
      renderHeightCells: 1.65,
      renderAnchorX: 0.5,
      renderAnchorY: 1,
      outlineMode: "alpha-dilation",
      outlineGroup: "alpine-forest",
      eligibleBiomeIds: [2, 3, 4],
    },
    {
      key: "alpine-tree-75-01",
      label: "Supplied alpine tree 75-degree variant 01",
      family: "universal",
      url: alpineTree75Variant01Url,
      rasterizeVectorFill: true,
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 1.7,
      anchorX: 0.5,
      anchorY: 0.5,
      renderWidthCells: 0.95,
      renderHeightCells: 1.65,
      renderAnchorX: 0.5,
      renderAnchorY: 1,
      outlineMode: "alpha-dilation",
      outlineGroup: "alpine-forest",
      eligibleBiomeIds: [2, 3, 4],
    },
    {
      key: "alpine-tree-75-02",
      label: "Supplied alpine tree 75-degree variant 02",
      family: "universal",
      url: alpineTree75Variant02Url,
      rasterizeVectorFill: true,
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 1.7,
      anchorX: 0.5,
      anchorY: 0.5,
      renderWidthCells: 0.95,
      renderHeightCells: 1.65,
      renderAnchorX: 0.5,
      renderAnchorY: 1,
      outlineMode: "alpha-dilation",
      outlineGroup: "alpine-forest",
      eligibleBiomeIds: [2, 3, 4],
    },
    {
      key: "alpine-tree-75-03",
      label: "Supplied alpine tree 75-degree variant 03",
      family: "universal",
      url: alpineTree75Variant03Url,
      rasterizeVectorFill: true,
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 1.7,
      anchorX: 0.5,
      anchorY: 0.5,
      renderWidthCells: 0.95,
      renderHeightCells: 1.65,
      renderAnchorX: 0.5,
      renderAnchorY: 1,
      outlineMode: "alpha-dilation",
      outlineGroup: "alpine-forest",
      eligibleBiomeIds: [2, 3, 4],
    },
    {
      key: "alpine-tree-75-04",
      label: "Supplied alpine tree 75-degree variant 04",
      family: "universal",
      url: alpineTree75Variant04Url,
      rasterizeVectorFill: true,
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 1.7,
      anchorX: 0.5,
      anchorY: 0.5,
      renderWidthCells: 0.95,
      renderHeightCells: 1.65,
      renderAnchorX: 0.5,
      renderAnchorY: 1,
      outlineMode: "alpha-dilation",
      outlineGroup: "alpine-forest",
      eligibleBiomeIds: [2, 3, 4],
    },
    {
      key: "alpine-tree-75-05",
      label: "Supplied alpine tree 75-degree variant 05",
      family: "universal",
      url: alpineTree75Variant05Url,
      rasterizeVectorFill: true,
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 1.7,
      anchorX: 0.5,
      anchorY: 0.5,
      renderWidthCells: 0.95,
      renderHeightCells: 1.65,
      renderAnchorX: 0.5,
      renderAnchorY: 1,
      outlineMode: "alpha-dilation",
      outlineGroup: "alpine-forest",
      eligibleBiomeIds: [2, 3, 4],
    },
    {
      key: "alpine-tree-75-06",
      label: "Supplied alpine tree 75-degree variant 06",
      family: "universal",
      url: alpineTree75Variant06Url,
      rasterizeVectorFill: true,
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 1.7,
      anchorX: 0.5,
      anchorY: 0.5,
      renderWidthCells: 0.95,
      renderHeightCells: 1.65,
      renderAnchorX: 0.5,
      renderAnchorY: 1,
      outlineMode: "alpha-dilation",
      outlineGroup: "alpine-forest",
      eligibleBiomeIds: [2, 3, 4],
    },
    ...WETLAND_VEGETATION_PROP_DEFINITIONS,
  ] as const;

/**
 * Small grid-authored mountain-foot props. The SVG source is kept at a 64px
 * viewBox and the compositor maps its 1x, 2x, or 3x footprint to the shared
 * 8px cell size before sending the paths through the charcoal renderer. The
 * additional variants stay at or below the original 3x footprint and use
 * between one and five separate boulder outlines per source file.
 */
export const MOUNTAIN_FOOTHILL_PROP_DEFINITIONS: readonly VegetationRasterPropDefinition[] =
  [
    {
      key: "mountain-boulder-01",
      label: "Charcoal outline boulder 1x SVG",
      family: "universal",
      url: mountainBoulder01Url,
      placementRole: "mountain-foothill",
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 0.45,
      anchorX: 0.5,
      anchorY: 0.5,
      eligibleBiomeIds: [1, 2, 3, 4, 5, 9, 10],
    },
    {
      key: "mountain-boulder-02",
      label: "Charcoal outline boulder 2x SVG",
      family: "universal",
      url: mountainBoulder02Url,
      placementRole: "mountain-foothill",
      footprintWidthCells: 2,
      footprintHeightCells: 2,
      heightCells: 0.9,
      anchorX: 0.5,
      anchorY: 0.5,
      eligibleBiomeIds: [1, 2, 3, 4, 5, 9, 10],
    },
    {
      key: "mountain-boulder-03",
      label: "Charcoal outline boulder 3x SVG",
      family: "universal",
      url: mountainBoulder03Url,
      placementRole: "mountain-foothill",
      footprintWidthCells: 3,
      footprintHeightCells: 3,
      heightCells: 1.35,
      anchorX: 0.5,
      anchorY: 0.5,
      eligibleBiomeIds: [1, 2, 3, 4, 5, 9, 10],
    },
    {
      key: "mountain-boulder-04",
      label: "Charcoal outline pebble 1x SVG",
      family: "universal",
      url: mountainBoulder04Url,
      placementRole: "mountain-foothill",
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 0.32,
      anchorX: 0.5,
      anchorY: 0.5,
      eligibleBiomeIds: [1, 2, 3, 4, 5, 9, 10],
    },
    {
      key: "mountain-boulder-05",
      label: "Charcoal outline pebble pair 1x SVG",
      family: "universal",
      url: mountainBoulder05Url,
      placementRole: "mountain-foothill",
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      heightCells: 0.35,
      anchorX: 0.5,
      anchorY: 0.5,
      eligibleBiomeIds: [1, 2, 3, 4, 5, 9, 10],
    },
    {
      key: "mountain-boulder-06",
      label: "Charcoal outline boulder trio 2x SVG",
      family: "universal",
      url: mountainBoulder06Url,
      placementRole: "mountain-foothill",
      footprintWidthCells: 2,
      footprintHeightCells: 2,
      heightCells: 0.6,
      anchorX: 0.5,
      anchorY: 0.5,
      eligibleBiomeIds: [1, 2, 3, 4, 5, 9, 10],
    },
    {
      key: "mountain-boulder-07",
      label: "Charcoal outline boulder quartet 2x SVG",
      family: "universal",
      url: mountainBoulder07Url,
      placementRole: "mountain-foothill",
      footprintWidthCells: 2,
      footprintHeightCells: 2,
      heightCells: 0.65,
      anchorX: 0.5,
      anchorY: 0.5,
      eligibleBiomeIds: [1, 2, 3, 4, 5, 9, 10],
    },
    {
      key: "mountain-boulder-08",
      label: "Charcoal outline boulder cluster 2x SVG",
      family: "universal",
      url: mountainBoulder08Url,
      placementRole: "mountain-foothill",
      footprintWidthCells: 2,
      footprintHeightCells: 2,
      heightCells: 0.7,
      anchorX: 0.5,
      anchorY: 0.5,
      eligibleBiomeIds: [1, 2, 3, 4, 5, 9, 10],
    },
    {
      key: "mountain-boulder-09",
      label: "Charcoal outline boulder pair 2x SVG",
      family: "universal",
      url: mountainBoulder09Url,
      placementRole: "mountain-foothill",
      footprintWidthCells: 2,
      footprintHeightCells: 2,
      heightCells: 0.75,
      anchorX: 0.5,
      anchorY: 0.5,
      eligibleBiomeIds: [1, 2, 3, 4, 5, 9, 10],
    },
    {
      key: "mountain-boulder-10",
      label: "Charcoal outline boulder cluster 2x SVG",
      family: "universal",
      url: mountainBoulder10Url,
      placementRole: "mountain-foothill",
      footprintWidthCells: 2,
      footprintHeightCells: 2,
      heightCells: 0.7,
      anchorX: 0.5,
      anchorY: 0.5,
      eligibleBiomeIds: [1, 2, 3, 4, 5, 9, 10],
    },
  ] as const;

const ALL_RASTER_PROP_DEFINITIONS: readonly VegetationRasterPropDefinition[] = [
  ...VEGETATION_RASTER_PROP_DEFINITIONS,
  ...MOUNTAIN_FOOTHILL_PROP_DEFINITIONS,
];

const DEFAULT_VECTOR_MOTIF_WIDTH = 64;
const DEFAULT_VECTOR_MOTIF_HEIGHT = 40;
const DEFAULT_VECTOR_MOTIF_STROKE_WIDTH = 3;
const SVG_PATH_TOKEN = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const VECTOR_FLATTENING_STEP = 0.65;

type SvgPoint = { x: number; y: number };

function isSvgCommand(token: string): boolean {
  return /^[a-zA-Z]$/.test(token);
}

function appendSvgPoint(points: SvgPoint[], point: SvgPoint): void {
  const previous = points[points.length - 1];
  if (
    !previous ||
    Math.hypot(point.x - previous.x, point.y - previous.y) > 1e-4
  ) {
    points.push(point);
  }
}

function appendCubicCurve(
  points: SvgPoint[],
  start: SvgPoint,
  control1: SvgPoint,
  control2: SvgPoint,
  end: SvgPoint,
): void {
  const estimate =
    Math.hypot(control1.x - start.x, control1.y - start.y) +
    Math.hypot(control2.x - control1.x, control2.y - control1.y) +
    Math.hypot(end.x - control2.x, end.y - control2.y);
  const steps = Math.max(4, Math.ceil(estimate / VECTOR_FLATTENING_STEP));
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const inverse = 1 - t;
    appendSvgPoint(points, {
      x:
        inverse * inverse * inverse * start.x +
        3 * inverse * inverse * t * control1.x +
        3 * inverse * t * t * control2.x +
        t * t * t * end.x,
      y:
        inverse * inverse * inverse * start.y +
        3 * inverse * inverse * t * control1.y +
        3 * inverse * t * t * control2.y +
        t * t * t * end.y,
    });
  }
}

function appendQuadraticCurve(
  points: SvgPoint[],
  start: SvgPoint,
  control: SvgPoint,
  end: SvgPoint,
): void {
  const estimate =
    Math.hypot(control.x - start.x, control.y - start.y) +
    Math.hypot(end.x - control.x, end.y - control.y);
  const steps = Math.max(3, Math.ceil(estimate / VECTOR_FLATTENING_STEP));
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const inverse = 1 - t;
    appendSvgPoint(points, {
      x:
        inverse * inverse * start.x +
        2 * inverse * t * control.x +
        t * t * end.x,
      y:
        inverse * inverse * start.y +
        2 * inverse * t * control.y +
        t * t * end.y,
    });
  }
}

function appendSvgArc(
  points: SvgPoint[],
  start: SvgPoint,
  radiusX: number,
  radiusY: number,
  rotationDeg: number,
  largeArc: number,
  sweep: number,
  end: SvgPoint,
): void {
  const rx = Math.abs(radiusX);
  const ry = Math.abs(radiusY);
  if (rx < 1e-6 || ry < 1e-6) {
    appendSvgPoint(points, end);
    return;
  }

  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const halfX = (start.x - end.x) * 0.5;
  const halfY = (start.y - end.y) * 0.5;
  const xPrime = cosPhi * halfX + sinPhi * halfY;
  const yPrime = -sinPhi * halfX + cosPhi * halfY;
  const radiusCorrection =
    (xPrime * xPrime) / (rx * rx) + (yPrime * yPrime) / (ry * ry);
  const scale = radiusCorrection > 1 ? Math.sqrt(radiusCorrection) : 1;
  const correctedRx = rx * scale;
  const correctedRy = ry * scale;
  const numerator =
    correctedRx * correctedRx * correctedRy * correctedRy -
    correctedRx * correctedRx * yPrime * yPrime -
    correctedRy * correctedRy * xPrime * xPrime;
  const denominator =
    correctedRx * correctedRx * yPrime * yPrime +
    correctedRy * correctedRy * xPrime * xPrime;
  const factor =
    denominator < 1e-8
      ? 0
      : (largeArc === sweep ? -1 : 1) *
        Math.sqrt(Math.max(0, numerator / denominator));
  const centrePrimeX = factor * ((correctedRx * yPrime) / correctedRy);
  const centrePrimeY = factor * (-(correctedRy * xPrime) / correctedRx);
  const centreX =
    (start.x + end.x) * 0.5 + cosPhi * centrePrimeX - sinPhi * centrePrimeY;
  const centreY =
    (start.y + end.y) * 0.5 + sinPhi * centrePrimeX + cosPhi * centrePrimeY;
  const vectorStartX = (xPrime - centrePrimeX) / correctedRx;
  const vectorStartY = (yPrime - centrePrimeY) / correctedRy;
  const vectorEndX = (-xPrime - centrePrimeX) / correctedRx;
  const vectorEndY = (-yPrime - centrePrimeY) / correctedRy;
  const startAngle = Math.atan2(vectorStartY, vectorStartX);
  let deltaAngle = Math.atan2(
    vectorStartX * vectorEndY - vectorStartY * vectorEndX,
    vectorStartX * vectorEndX + vectorStartY * vectorEndY,
  );
  if (!sweep && deltaAngle > 0) deltaAngle -= Math.PI * 2;
  if (sweep && deltaAngle < 0) deltaAngle += Math.PI * 2;

  const steps = Math.max(
    4,
    Math.ceil(
      (Math.abs(deltaAngle) * Math.max(correctedRx, correctedRy)) /
        VECTOR_FLATTENING_STEP,
    ),
  );
  for (let step = 1; step <= steps; step++) {
    const angle = startAngle + (deltaAngle * step) / steps;
    appendSvgPoint(points, {
      x:
        centreX +
        correctedRx * cosPhi * Math.cos(angle) -
        correctedRy * sinPhi * Math.sin(angle),
      y:
        centreY +
        correctedRx * sinPhi * Math.cos(angle) +
        correctedRy * cosPhi * Math.sin(angle),
    });
  }
}

function flattenSvgPathData(
  pathData: string,
  strokeWidth = DEFAULT_VECTOR_MOTIF_STROKE_WIDTH,
): VegetationMotifVectorPath[] {
  const tokens = pathData.match(SVG_PATH_TOKEN) ?? [];
  const paths: VegetationMotifVectorPath[] = [];
  let tokenIndex = 0;
  let command = "";
  let current: SvgPoint = { x: 0, y: 0 };
  let subpathStart: SvgPoint = current;
  let points: SvgPoint[] | null = null;
  let lastCubicControl: SvgPoint | undefined;
  let lastQuadraticControl: SvgPoint | undefined;
  let pathClosed = false;

  const finishPath = (): void => {
    if (points && points.length > 1) {
      paths.push({ points, strokeWidth, closed: pathClosed });
    }
    points = null;
    pathClosed = false;
  };
  const readNumbers = (count: number): number[] | undefined => {
    if (tokenIndex + count > tokens.length) return undefined;
    const values = tokens.slice(tokenIndex, tokenIndex + count);
    if (values.some(isSvgCommand)) return undefined;
    tokenIndex += count;
    return values.map(Number);
  };
  const ensurePath = (): SvgPoint[] => {
    if (!points) points = [current];
    return points;
  };
  const resetControls = (): void => {
    lastCubicControl = undefined;
    lastQuadraticControl = undefined;
  };

  while (tokenIndex < tokens.length) {
    if (isSvgCommand(tokens[tokenIndex])) {
      command = tokens[tokenIndex++];
    } else if (!command) {
      tokenIndex++;
      continue;
    }
    const relative = command === command.toLowerCase();
    const normalized = command.toUpperCase();

    if (normalized === "Z") {
      const target = ensurePath();
      appendSvgPoint(target, subpathStart);
      current = subpathStart;
      pathClosed = true;
      finishPath();
      command = "";
      resetControls();
      continue;
    }

    if (normalized === "M" || normalized === "L") {
      const values = readNumbers(2);
      if (!values) {
        command = "";
        continue;
      }
      const target = {
        x: relative ? current.x + values[0] : values[0],
        y: relative ? current.y + values[1] : values[1],
      };
      if (normalized === "M") {
        finishPath();
        current = target;
        subpathStart = target;
        points = [target];
        command = relative ? "l" : "L";
      } else {
        appendSvgPoint(ensurePath(), target);
        current = target;
      }
      resetControls();
      continue;
    }

    if (normalized === "H" || normalized === "V") {
      const values = readNumbers(1);
      if (!values) {
        command = "";
        continue;
      }
      const target =
        normalized === "H"
          ? { x: relative ? current.x + values[0] : values[0], y: current.y }
          : { x: current.x, y: relative ? current.y + values[0] : values[0] };
      appendSvgPoint(ensurePath(), target);
      current = target;
      resetControls();
      continue;
    }

    if (normalized === "C" || normalized === "S") {
      const values = readNumbers(normalized === "C" ? 6 : 4);
      if (!values) {
        command = "";
        continue;
      }
      const control1 =
        normalized === "S" && lastCubicControl
          ? {
              x: 2 * current.x - lastCubicControl.x,
              y: 2 * current.y - lastCubicControl.y,
            }
          : normalized === "S"
            ? current
            : {
                x: relative ? current.x + values[0] : values[0],
                y: relative ? current.y + values[1] : values[1],
              };
      const valueOffset = normalized === "C" ? 2 : 0;
      const control2 = {
        x: relative ? current.x + values[valueOffset] : values[valueOffset],
        y: relative
          ? current.y + values[valueOffset + 1]
          : values[valueOffset + 1],
      };
      const target = {
        x: relative
          ? current.x + values[valueOffset + 2]
          : values[valueOffset + 2],
        y: relative
          ? current.y + values[valueOffset + 3]
          : values[valueOffset + 3],
      };
      appendCubicCurve(ensurePath(), current, control1, control2, target);
      current = target;
      lastCubicControl = control2;
      lastQuadraticControl = undefined;
      continue;
    }

    if (normalized === "Q" || normalized === "T") {
      const values = readNumbers(normalized === "Q" ? 4 : 2);
      if (!values) {
        command = "";
        continue;
      }
      const control =
        normalized === "T" && lastQuadraticControl
          ? {
              x: 2 * current.x - lastQuadraticControl.x,
              y: 2 * current.y - lastQuadraticControl.y,
            }
          : normalized === "T"
            ? current
            : {
                x: relative ? current.x + values[0] : values[0],
                y: relative ? current.y + values[1] : values[1],
              };
      const valueOffset = normalized === "Q" ? 2 : 0;
      const target = {
        x: relative ? current.x + values[valueOffset] : values[valueOffset],
        y: relative
          ? current.y + values[valueOffset + 1]
          : values[valueOffset + 1],
      };
      appendQuadraticCurve(ensurePath(), current, control, target);
      current = target;
      lastQuadraticControl = control;
      lastCubicControl = undefined;
      continue;
    }

    if (normalized === "A") {
      const first = readNumbers(3);
      const packedFlags = tokens[tokenIndex];
      let values: number[] | undefined;
      if (
        first &&
        packedFlags &&
        !isSvgCommand(packedFlags) &&
        /^[01][01].+/.test(packedFlags)
      ) {
        tokenIndex++;
        const endX = Number(packedFlags.slice(2));
        const endY = readNumbers(1)?.[0];
        values =
          Number.isFinite(endX) && endY !== undefined
            ? [
                ...first,
                Number(packedFlags[0]),
                Number(packedFlags[1]),
                endX,
                endY,
              ]
            : undefined;
      } else {
        const remaining = readNumbers(4);
        values = first && remaining ? [...first, ...remaining] : undefined;
      }
      if (!values) {
        command = "";
        continue;
      }
      const target = {
        x: relative ? current.x + values[5] : values[5],
        y: relative ? current.y + values[6] : values[6],
      };
      appendSvgArc(
        ensurePath(),
        current,
        values[0],
        values[1],
        values[2],
        values[3],
        values[4],
        target,
      );
      current = target;
      resetControls();
      continue;
    }

    command = "";
  }
  finishPath();
  return paths;
}

function svgAttribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*([\\"'])(.*?)\\1`, "i"))?.[2];
}

function svgDimension(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function svgFillColor(
  value: string | undefined,
): readonly [number, number, number] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "none") return undefined;
  const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!hex) return undefined;
  if (hex.length === 3) {
    return [
      Number.parseInt(`${hex[0]}${hex[0]}`, 16),
      Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      Number.parseInt(`${hex[2]}${hex[2]}`, 16),
    ];
  }
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

export function parseSvgVectorAsset(svgText: string):
  | {
      width: number;
      height: number;
      vectorPaths: VegetationMotifVectorPath[];
    }
  | undefined {
  const svgTag = svgText.match(/<svg\b[^>]*>/i)?.[0];
  if (!svgTag) return undefined;
  const viewBox = svgAttribute(svgTag, "viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const viewBoxX = viewBox && viewBox.length === 4 ? viewBox[0] : 0;
  const viewBoxY = viewBox && viewBox.length === 4 ? viewBox[1] : 0;
  const width =
    svgDimension(svgAttribute(svgTag, "width")) ??
    (viewBox && viewBox.length === 4 ? viewBox[2] : undefined) ??
    DEFAULT_VECTOR_MOTIF_WIDTH;
  const height =
    svgDimension(svgAttribute(svgTag, "height")) ??
    (viewBox && viewBox.length === 4 ? viewBox[3] : undefined) ??
    DEFAULT_VECTOR_MOTIF_HEIGHT;
  const inheritedStrokeWidth =
    svgDimension(svgAttribute(svgTag, "stroke-width")) ??
    DEFAULT_VECTOR_MOTIF_STROKE_WIDTH;
  const vectorPaths = (svgText.match(/<path\b[^>]*>/gi) ?? []).flatMap(
    (tag) => {
      const pathData = svgAttribute(tag, "d");
      if (!pathData) return [];
      const strokeWidth =
        svgDimension(svgAttribute(tag, "stroke-width")) ?? inheritedStrokeWidth;
      const fillColor = svgFillColor(svgAttribute(tag, "fill"));
      return flattenSvgPathData(pathData, strokeWidth).map((path) => ({
        ...path,
        fillColor,
        points: path.points.map((point) => ({
          x: point.x - viewBoxX,
          y: point.y - viewBoxY,
        })),
      }));
    },
  );
  return vectorPaths.length > 0 ? { width, height, vectorPaths } : undefined;
}

let cachedAssets: Promise<VegetationMotifAsset[]> | null = null;
let cachedRasterPropAssets: Promise<VegetationRasterPropAsset[]> | null = null;
let cachedAlpineRasterPropAssets: Promise<VegetationRasterPropAsset[]> | null = null;
let cachedMountainDetailRasterPropAssets: Promise<VegetationRasterPropAsset[]> | null = null;
const cachedMotifAssetLoads = new Map<string, Promise<VegetationMotifAsset>>();

function loadMotifAsset(
  definition: VegetationMotifDefinition,
  useVectorPaths = false,
): Promise<VegetationMotifAsset> {
  const cacheKey = `${definition.key}:${useVectorPaths ? "vector" : "raster"}`;
  const cached = cachedMotifAssetLoads.get(cacheKey);
  if (cached) return cached;

  const pending = (async () => {
      if (useVectorPaths && typeof fetch === "function") {
        try {
          const response = await fetch(definition.url);
          if (response.ok) {
            const vector = parseSvgVectorAsset(await response.text());
            if (vector) {
              let data: Uint8ClampedArray<ArrayBufferLike> =
                new Uint8ClampedArray();
              if (definition.rasterizeVectorFill) {
                try {
                  data = await rasterizeMotifImage(
                    definition.url,
                    vector.width,
                    vector.height,
                  );
                } catch {
                  // The charcoal paths remain usable if an environment cannot
                  // create a canvas for the optional fill pass.
                }
              }
              return {
                key: definition.key,
                family: definition.family,
                width: vector.width,
                height: vector.height,
                data,
                vectorPaths: vector.vectorPaths,
              };
            }
          }
        } catch {
          // Fall back to the existing raster asset loader below.
        }
      }
      return new Promise<VegetationMotifAsset>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, image.naturalWidth || image.width);
            canvas.height = Math.max(1, image.naturalHeight || image.height);
            const context = canvas.getContext("2d");
            if (!context)
              throw new Error("Could not rasterize vegetation motif.");
            context.drawImage(image, 0, 0);
            resolve({
              key: definition.key,
              family: definition.family,
              width: canvas.width,
              height: canvas.height,
              data: context.getImageData(0, 0, canvas.width, canvas.height)
                .data,
            });
          } catch (error) {
            reject(error);
          }
        };
        image.onerror = () =>
          reject(new Error(`Failed to load ${definition.label} motif.`));
        image.src = definition.url;
      });
  })();
  const cachedPromise = pending.catch((error: unknown) => {
    if (cachedMotifAssetLoads.get(cacheKey) === cachedPromise) {
      cachedMotifAssetLoads.delete(cacheKey);
    }
    throw error;
  });
  cachedMotifAssetLoads.set(cacheKey, cachedPromise);
  return cachedPromise;
}

function loadMotifAssets(
  definitions: readonly VegetationMotifDefinition[],
  useVectorPaths = false,
): Promise<VegetationMotifAsset[]> {
  return Promise.all(definitions.map((definition) =>
    loadMotifAsset(definition, useVectorPaths),
  ));
}

function rasterizeMotifImage(
  url: string,
  width: number,
  height: number,
): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    if (typeof Image === "undefined" || typeof document === "undefined") {
      reject(new Error("Canvas image rasterization is unavailable."));
      return;
    }
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not rasterize SVG fill.");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(context.getImageData(0, 0, canvas.width, canvas.height).data);
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error(`Failed to rasterize ${url}.`));
    image.src = url;
  });
}

export function loadVegetationMotifAssets(): Promise<VegetationMotifAsset[]> {
  if (cachedAssets) return cachedAssets;
  const pending = loadMotifAssets(VEGETATION_MOTIF_DEFINITIONS, true);
  cachedAssets = pending.catch((error: unknown) => {
    cachedAssets = null;
    throw error;
  });
  return cachedAssets;
}

/** Calibrate footprints against visible foliage, excluding sprite padding. */
export function trimRasterPropPadding(asset: VegetationMotifAsset): VegetationMotifAsset {
  let minX = asset.width;
  let minY = asset.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < asset.height; y++) {
    for (let x = 0; x < asset.width; x++) {
      if (asset.data[(y * asset.width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return asset;
  // Keep a square canvas so calibration does not distort the artwork.
  const side = Math.max(maxX - minX + 1, maxY - minY + 1);
  const offsetX = Math.floor((side - (maxX - minX + 1)) / 2);
  const offsetY = Math.floor((side - (maxY - minY + 1)) / 2);
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = minY; y <= maxY; y++) {
    const start = (y * asset.width + minX) * 4;
    data.set(asset.data.subarray(start, start + (maxX - minX + 1) * 4),
      ((y - minY + offsetY) * side + offsetX) * 4);
  }
  return { ...asset, width: side, height: side, data };
}

function loadRasterPropDefinitions(
  definitions: readonly VegetationRasterPropDefinition[],
): Promise<VegetationRasterPropAsset[]> {
  return loadMotifAssets(definitions, true).then((assets) =>
    assets.map((asset, index) => {
      const definition = definitions[index];
      const calibratedAsset = definition.placementRole === "mountain-foothill" ||
        definition.rasterizeVectorFill
        ? asset
        : trimRasterPropPadding(asset);
      return {
        ...calibratedAsset,
        kind: "raster-prop" as const,
        placementRole: definition.placementRole ?? "vegetation",
        footprintWidthCells: definition.footprintWidthCells,
        footprintHeightCells: definition.footprintHeightCells,
        heightCells: definition.heightCells,
        anchorX: definition.anchorX,
        anchorY: definition.anchorY,
        renderWidthCells: definition.renderWidthCells,
        renderHeightCells: definition.renderHeightCells,
        renderAnchorX: definition.renderAnchorX,
        renderAnchorY: definition.renderAnchorY,
        outlineMode: definition.outlineMode,
        outlineGroup: definition.outlineGroup,
        forestCanopyPathIndex: definition.forestCanopyPathIndex,
        paintVectorFills: definition.paintVectorFills,
        eligibleBiomeIds: definition.eligibleBiomeIds,
      };
    }),
  );
}

export function loadVegetationRasterPropAssets(): Promise<
  VegetationRasterPropAsset[]
> {
  if (cachedRasterPropAssets) return cachedRasterPropAssets;
  // Mountain foothill props are registered with the grid-prop metadata so
  // terrain placement and export tiling remain unchanged, but SVG sources are
  // parsed as vectors and rendered by the charcoal path below.
  const pending = loadRasterPropDefinitions(ALL_RASTER_PROP_DEFINITIONS);
  cachedRasterPropAssets = pending.catch((error: unknown) => {
    cachedRasterPropAssets = null;
    throw error;
  });
  return cachedRasterPropAssets;
}

/** Props used by Mountain Detail Studio: alpine and wetland vegetation. Foothill boulders are deprecated and not loaded. */
export function loadMountainDetailPropAssets(): Promise<VegetationRasterPropAsset[]> {
  if (cachedMountainDetailRasterPropAssets) return cachedMountainDetailRasterPropAssets;
  const definitions = VEGETATION_RASTER_PROP_DEFINITIONS.filter((definition) =>
    definition.outlineGroup === "alpine-forest" ||
    definition.placementRole === "wetland",
  );
  const pending = loadRasterPropDefinitions(definitions);
  cachedMountainDetailRasterPropAssets = pending.catch((error: unknown) => {
    cachedMountainDetailRasterPropAssets = null;
    throw error;
  });
  return cachedMountainDetailRasterPropAssets;
}

/** Load only the alpine artwork used by the forest-props review route. */
export function loadAlpineVegetationRasterPropAssets(): Promise<
  VegetationRasterPropAsset[]
> {
  if (cachedAlpineRasterPropAssets) return cachedAlpineRasterPropAssets;
  const alpineDefinitions = VEGETATION_RASTER_PROP_DEFINITIONS.filter((definition) =>
    definition.key.startsWith("alpine-tree-75"),
  );
  const pending = loadRasterPropDefinitions(alpineDefinitions);
  cachedAlpineRasterPropAssets = pending.catch((error: unknown) => {
    cachedAlpineRasterPropAssets = null;
    throw error;
  });
  return cachedAlpineRasterPropAssets;
}

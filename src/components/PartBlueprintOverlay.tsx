import { useMemo } from "react";
import { layerMarkup, type PartDocument, type Point } from "../structures/partDocument";

interface Props {
  doc: PartDocument;
  origin: Point;
  name: string;
}

/** An unfiltered wireframe of the reference, aligned without changing its scale. */
export function PartBlueprintOverlay({ doc, origin, name }: Props) {
  const html = useMemo(() => ({
    __html: doc.layers.filter((layer) => !layer.hidden).map((layer) => layerMarkup(layer)).join("\n"),
  }), [doc]);
  return (
    <g transform={`translate(${origin[0] - doc.origin[0]} ${origin[1] - doc.origin[1]})`}
      pointerEvents="none" opacity={0.65} aria-label={`${name} reference blueprint`}>
      <style>{`.part-blueprint-shapes > * {
        fill: none !important;
        stroke: #0284c7 !important;
        stroke-width: 1 !important;
        stroke-dasharray: 4 2 !important;
        stroke-linecap: round;
        stroke-linejoin: round;
        filter: none !important;
        vector-effect: non-scaling-stroke;
        pointer-events: none !important;
      }`}</style>
      <g className="part-blueprint-shapes" dangerouslySetInnerHTML={html} />
    </g>
  );
}

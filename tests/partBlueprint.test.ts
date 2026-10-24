import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PartBlueprintOverlay } from "../src/components/PartBlueprintOverlay";
import { parsePartDocument, serializePartDocument } from "../src/structures/partDocument";

function reference() {
  return parsePartDocument('<svg width="100" height="100" viewBox="0 -40 100 140" data-footprint="3 2" data-origin="10 20">'
    + '<g class="part" filter="url(#hand)"><path data-layer="walls" transform="translate(3 4)" fill="#ece1c9" d="M0 0L4 0L4 4Z"/>'
    + '<path data-layer="roof" d="M0 -40L4 0L2 -3Z"/>'
    + '<path data-layer="hidden" display="none" d="M90 90L95 90L95 95Z"/></g></svg>');
}

describe("reference blueprints", () => {
  it("aligns at the edited part's grid origin while preserving height, geometry and layer offsets", () => {
    const doc = reference();
    const html = renderToStaticMarkup(createElement(PartBlueprintOverlay, { doc, origin: [30, 50], name: "house" }));
    expect(html).toContain('transform="translate(20 30)"');
    expect(html).toContain('transform="translate(3 4)"');
    expect(html).toContain('d="M0 -40L4 0L2 -3Z"');
    expect(html).not.toContain("scale(");
    expect(html).not.toContain('data-layer="hidden"');
    expect(html).not.toContain('url(#hand)');
  });

  it("keeps reference paths outside editable hit targets and leaves the saved document unchanged", () => {
    const doc = reference();
    const before = serializePartDocument(doc);
    const html = renderToStaticMarkup(createElement(PartBlueprintOverlay, { doc, origin: [30, 50], name: "house" }));
    expect(html).toContain('pointer-events="none"');
    expect(html).toContain("pointer-events: none !important");
    expect(html).not.toContain("data-lid");
    expect(html).not.toContain("data-handle");
    expect(serializePartDocument(doc)).toBe(before);
  });

  it("can display curved reference shapes while overriding their original ink and fills", () => {
    const doc = reference();
    doc.layers[0].elements = ['<path style="fill:red;stroke:black" d="M0 0C1 1 2 2 3 3"/>'];
    const html = renderToStaticMarkup(createElement(PartBlueprintOverlay, { doc, origin: doc.origin, name: "round tower" }));
    expect(html).toContain('d="M0 0C1 1 2 2 3 3"');
    expect(html).toContain("fill: none !important");
    expect(html).toContain("stroke: #0284c7 !important");
    expect(html).toContain("vector-effect: non-scaling-stroke");
  });
});

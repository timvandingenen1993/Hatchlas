import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  embedForestLightingDataUrls,
  replaceForestSvgTagAttribute,
} from "../src/rendering/forestSvgSnapshot";

describe("forest SVG snapshot texture embedding", () => {
  it("embeds lighting data URLs without breaking React's explicit image tags", () => {
    const markup = renderToStaticMarkup(createElement(
      "svg",
      null,
      createElement("image", { id: "forest-shade-pine", x: "0", width: "20" }),
    ));
    const textures = new Map([
      ["pine", { url: "blob:pine", width: 52, height: 62, padding: 16, byteLength: 100 }],
    ]);
    const dataUrls = new Map([["pine", "data:image/png;base64,cGluZQ=="]]);

    const result = embedForestLightingDataUrls(markup, textures, dataUrls);

    expect(result.svgMarkup).toContain('href="data:image/png;base64,cGluZQ=="');
    expect(result.svgMarkup).toContain('></image>');
    expect(result.svgMarkup).toContain('x="-16"');
    expect(result.svgMarkup).toContain('y="-16"');
    expect(result.svgMarkup).toContain('width="52"');
    expect(result.svgMarkup).toContain('height="62"');
    expect(result.svgMarkup).not.toContain('href="data:image/png;base64,cGluZQ==" /></image>');
    expect(result.encodedBytes).toBe("data:image/png;base64,cGluZQ==".length);
  });

  it("keeps the self-closing form when the input is self-closing", () => {
    expect(replaceForestSvgTagAttribute(
      '<image id="forest-shade-pine" />',
      "href",
      "data:image/png;base64,cGluZQ==",
    )).toBe('<image id="forest-shade-pine" href="data:image/png;base64,cGluZQ==" />');
  });
});

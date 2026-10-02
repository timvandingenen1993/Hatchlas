import type { ForestLightTexture } from "./forestPropLighting";

/** Replace or append an SVG attribute without changing the tag's closing form. */
export function replaceForestSvgTagAttribute(
  tag: string,
  name: string,
  value: string,
): string {
  const attribute = new RegExp(`\\s${name}=(?:"[^"]*"|'[^']*')`);
  if (attribute.test(tag)) return tag.replace(attribute, ` ${name}="${value}"`);

  // React serializes SVG image elements as <image ...></image>. Preserve the
  // opening tag so adding href does not leave an unmatched closing tag.
  return tag.replace(/(\s*)(\/?>)$/, (_match, whitespace: string, closing: string) =>
    `${whitespace || " "}${name}="${value}"${closing === "/>" ? " " : ""}${closing}`,
  );
}

/** Embed lighting PNGs so serialized forest SVG snapshots are self-contained. */
export function embedForestLightingDataUrls(
  svgMarkup: string,
  textures: ReadonlyMap<string, ForestLightTexture>,
  dataUrls: ReadonlyMap<string, string>,
): { svgMarkup: string; encodedBytes: number } {
  const embeddedMarkup = svgMarkup.replace(/<image\b[^>]*>/g, (tag) => {
    const key = tag.match(/\bid="forest-shade-([^"]+)"/)?.[1];
    if (!key) return tag;
    const texture = textures.get(key);
    const dataUrl = dataUrls.get(key);
    if (!texture || !dataUrl) return tag;

    let embeddedTag = replaceForestSvgTagAttribute(tag, "href", dataUrl);
    embeddedTag = replaceForestSvgTagAttribute(embeddedTag, "x", String(-texture.padding));
    embeddedTag = replaceForestSvgTagAttribute(embeddedTag, "y", String(-texture.padding));
    embeddedTag = replaceForestSvgTagAttribute(embeddedTag, "width", String(texture.width));
    embeddedTag = replaceForestSvgTagAttribute(embeddedTag, "height", String(texture.height));
    return embeddedTag;
  });

  return {
    svgMarkup: embeddedMarkup,
    encodedBytes: [...dataUrls.values()].reduce((sum, value) => sum + value.length, 0),
  };
}

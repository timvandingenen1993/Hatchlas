/**
 * A town part SVG as /structure-lab edits it: the root and filter kept as
 * written, the body as layers. A layer is a run of consecutive elements that
 * share a `data-layer` name, offset and visibility, so reordering layers
 * changes paint order and nothing else.
 */

export interface PartLayer {
  id: string;
  name: string;
  /** Self-closing elements without their layer, offset and display attributes. */
  elements: string[];
  hidden: boolean;
  /** Offset in viewBox units, written as `transform="translate(dx dy)"`. */
  dx: number;
  dy: number;
}

export interface PartDocument {
  /** Root attributes in file order. */
  attributes: [string, string][];
  /** `<defs>…</defs>` as written, or "". */
  defs: string;
  /** Opening tag of the `<g class="part">` group. */
  groupOpen: string;
  viewBox: [number, number, number, number];
  /** The root's width and height attributes. */
  size: [number, number];
  footprint: [number, number];
  /** Viewbox position of grid point (0, 0). */
  origin: [number, number];
  layers: PartLayer[];
}

let nextLayerId = 1;
export const newLayerId = () => `layer-${nextLayerId++}`;

const fmt = (value: number) => (Math.round(value * 100) / 100).toString();

function numbers(value: string | undefined, count: number, what: string): number[] {
  const parsed = (value ?? "").trim().split(/[\s,]+/).map(Number);
  if (parsed.length !== count || !parsed.every(Number.isFinite)) throw new Error(`Part needs a ${what}`);
  return parsed;
}

const TRANSLATE = /\stransform="translate\(\s*(-?[\d.e+-]+)[\s,]+(-?[\d.e+-]+)\s*\)"/;

export function parsePartDocument(source: string): PartDocument {
  const root = /<svg\b([^>]*)>/.exec(source);
  const group = /(<g class="part"[^>]*>)([\s\S]*)<\/g>\s*<\/svg>/.exec(source);
  if (!root || !group) throw new Error('Part needs an <svg> root and a <g class="part"> body');
  const attributes = [...root[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value] as [string, string]);
  const attribute = (name: string) => attributes.find(([key]) => key === name)?.[1];
  const viewBox = numbers(attribute("viewBox"), 4, "viewBox");

  const layers: PartLayer[] = [];
  const body = group[2];
  const leftover = body.replace(/<\w+\b[^>]*\/>/g, "").trim();
  if (leftover) throw new Error(`Part body has content the lab cannot edit: ${leftover.slice(0, 60)}`);
  for (const [element] of body.matchAll(/<\w+\b[^>]*\/>/g)) {
    const name = /\sdata-layer="([^"]*)"/.exec(element)?.[1] ?? "unnamed";
    const offset = TRANSLATE.exec(element);
    const dx = offset ? Number(offset[1]) : 0;
    const dy = offset ? Number(offset[2]) : 0;
    const hidden = /\sdisplay="none"/.test(element);
    const bare = element.replace(/\sdata-layer="[^"]*"/, "").replace(TRANSLATE, "").replace(/\sdisplay="none"/, "");
    const last = layers[layers.length - 1];
    if (last && last.name === name && last.hidden === hidden && last.dx === dx && last.dy === dy) {
      last.elements.push(bare);
    } else {
      layers.push({ id: newLayerId(), name, elements: [bare], hidden, dx, dy });
    }
  }

  const [width, height] = [Number(attribute("width")), Number(attribute("height"))];
  return {
    attributes,
    defs: /<defs>[\s\S]*?<\/defs>/.exec(source)?.[0] ?? "",
    groupOpen: group[1],
    viewBox: viewBox as PartDocument["viewBox"],
    size: Number.isFinite(width) && Number.isFinite(height) ? [width, height] : [viewBox[2] * 3, viewBox[3] * 3],
    footprint: numbers(attribute("data-footprint"), 2, "data-footprint") as [number, number],
    origin: numbers(attribute("data-origin"), 2, "data-origin") as [number, number],
    layers,
  };
}

/**
 * One layer's elements with its name, visibility and offset written back
 * in; `extra` adds attributes to each element (by its index in the layer).
 */
export function layerMarkup(layer: PartLayer, extra: (index: number) => string = () => ""): string {
  const name = layer.name.replace(/["<>&]/g, "");
  const offset = layer.dx !== 0 || layer.dy !== 0 ? ` transform="translate(${fmt(layer.dx)} ${fmt(layer.dy)})"` : "";
  const hidden = layer.hidden ? ' display="none"' : "";
  return layer.elements
    .map((element, index) => element.replace(/^<(\w+)/, `<$1 data-layer="${name}"${hidden}${offset}${extra(index)}`))
    .join("\n");
}

export type Point = [number, number];

/** The corners of a path, as the generator writes them. */
export interface ShapePoints {
  points: Point[];
  closed: boolean;
}

const PATH_D = /\sd="([^"]*)"/;

/**
 * Points of a path element made of straight lines (M, L, H, V and Z, any
 * case) in one run; null for anything else, such as curves.
 */
export function shapePoints(element: string): ShapePoints | null {
  if (!/^<path\b/.test(element)) return null;
  const d = PATH_D.exec(element)?.[1];
  if (!d) return null;
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const points: Point[] = [];
  let closed = false;
  let command = "";
  let index = 0;
  const number = () => {
    const value = Number(tokens[index++]);
    if (!Number.isFinite(value)) throw new Error("bad number");
    return value;
  };
  try {
    while (index < tokens.length) {
      if (/[a-zA-Z]/.test(tokens[index])) command = tokens[index++];
      if (closed) return null;
      const [x, y] = points[points.length - 1] ?? [0, 0];
      const relative = command === command.toLowerCase();
      switch (command.toUpperCase()) {
        case "M":
          if (points.length > 0) return null;
          points.push([number(), number()]);
          if (relative && points.length === 1) command = "l";
          else command = "L";
          break;
        case "L": {
          const [px, py] = [number(), number()];
          points.push(relative ? [x + px, y + py] : [px, py]);
          break;
        }
        case "H": {
          const value = number();
          points.push([relative ? x + value : value, y]);
          break;
        }
        case "V": {
          const value = number();
          points.push([x, relative ? y + value : value]);
          break;
        }
        case "Z":
          closed = true;
          break;
        default:
          return null;
      }
    }
  } catch {
    return null;
  }
  return points.length >= 2 ? { points, closed } : null;
}

/** `element` with its path redrawn through `shape`'s points. */
export function withShapePoints(element: string, shape: ShapePoints): string {
  const d = shape.points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${fmt(x)} ${fmt(y)}`).join("") + (shape.closed ? "Z" : "");
  return element.replace(PATH_D, ` d="${d}"`);
}

/** Where on `shape`'s outline (x, y) is nearest: the index a point inserted there takes, and the spot. */
export function nearestOnOutline(shape: ShapePoints, x: number, y: number): { insertAt: number; point: Point; distance: number } {
  let best = { insertAt: 1, point: shape.points[0], distance: Infinity };
  const edges = shape.closed ? shape.points.length : shape.points.length - 1;
  for (let index = 0; index < edges; index++) {
    const [ax, ay] = shape.points[index];
    const [bx, by] = shape.points[(index + 1) % shape.points.length];
    const length = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = length > 0 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length)) : 0;
    const point: Point = [ax + (bx - ax) * t, ay + (by - ay) * t];
    const distance = Math.hypot(point[0] - x, point[1] - y);
    if (distance < best.distance) best = { insertAt: index + 1, point, distance };
  }
  return best;
}

/** The part file for `doc`; `edited` marks it so the generator leaves it alone. */
export function serializePartDocument(doc: PartDocument, edited = true): string {
  const managed: Record<string, string> = {
    width: fmt(doc.size[0]),
    height: fmt(doc.size[1]),
    viewBox: doc.viewBox.map(fmt).join(" "),
    "data-footprint": doc.footprint.map(fmt).join(" "),
    "data-origin": doc.origin.map(fmt).join(" "),
  };
  const attributes = doc.attributes.map(([name, value]) => [name, managed[name] ?? value]);
  for (const name of Object.keys(managed)) {
    if (!attributes.some(([key]) => key === name)) attributes.push([name, managed[name]]);
  }
  if (edited && !attributes.some(([key]) => key === "data-edited")) attributes.push(["data-edited", "true"]);
  const root = attributes.map(([name, value]) => `${name}="${value}"`).join(" ");
  const body = doc.layers.map((layer) => layerMarkup(layer)).filter(Boolean).join("\n");
  return `<svg ${root}>\n${doc.defs ? `${doc.defs}\n` : ""}${doc.groupOpen}\n${body}\n</g>\n</svg>\n`;
}

/**
 * Grows the viewBox (never shrinks it, so an untouched part keeps its file)
 * to hold `content`, the drawn bounds in viewBox units, plus `pad`.
 */
export function fitViewBox(doc: PartDocument, content: { x: number; y: number; width: number; height: number } | null, pad: number): PartDocument {
  if (!content) return doc;
  const [x, y, width, height] = doc.viewBox;
  // Outward to the 0.01 the file is written in, ignoring float noise.
  const down = (value: number) => Math.floor(value * 100 + 1e-6) / 100;
  const up = (value: number) => Math.ceil(value * 100 - 1e-6) / 100;
  const minX = Math.min(x, down(content.x - pad));
  const minY = Math.min(y, down(content.y - pad));
  const maxX = Math.max(x + width, up(content.x + content.width + pad));
  const maxY = Math.max(y + height, up(content.y + content.height + pad));
  if (minX === x && minY === y && maxX === x + width && maxY === y + height) return doc;
  const viewBox: PartDocument["viewBox"] = [minX, minY, maxX - minX, maxY - minY];
  return { ...doc, viewBox, size: [viewBox[2] * 3, viewBox[3] * 3] };
}

/** A copy of `layer` from part `from`, offset so it keeps its place on the grid in part `to`. */
export function transplantLayer(layer: PartLayer, from: PartDocument, to: PartDocument): PartLayer {
  return {
    ...layer,
    id: newLayerId(),
    elements: [...layer.elements],
    hidden: false,
    dx: layer.dx + to.origin[0] - from.origin[0],
    dy: layer.dy + to.origin[1] - from.origin[1],
  };
}

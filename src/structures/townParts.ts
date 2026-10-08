/**
 * Town parts: the building SVGs under assets/structures/town-parts, their
 * grid footprints, and the back-to-front order for placing them. Shared by
 * the settlement and castle composers.
 */
const PART_SOURCES = import.meta.glob<string>("../assets/structures/town-parts/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

export interface TownPart {
  name: string;
  /** Cells covered along i and j. */
  cellsI: number;
  cellsJ: number;
  width: number;
  height: number;
  /** Viewbox position of the footprint's grid point (0, 0). */
  originX: number;
  originY: number;
  body: string;
}

export function parseTownPart(name: string, source: string): TownPart {
  const root = /<svg\b([^>]*)>/.exec(source);
  if (!root) throw new Error(`Town part ${name} is not an SVG`);
  const numbers = (attribute: string) =>
    (new RegExp(`\\b${attribute}="([^"]*)"`).exec(root[1])?.[1] ?? "").trim().split(/\s+/).map(Number);
  const footprint = numbers("data-footprint");
  const origin = numbers("data-origin");
  const viewBox = numbers("viewBox");
  const group = /<g class="part"[^>]*>([\s\S]*)<\/g>\s*<\/svg>/.exec(source);
  if (footprint.length !== 2 || origin.length !== 2 || viewBox.length !== 4
    || ![...footprint, ...origin, ...viewBox].every(Number.isFinite) || !group) {
    throw new Error(`Town part ${name} needs a viewBox, data-footprint, data-origin and a <g class="part"> body`);
  }
  return {
    name,
    cellsI: footprint[0],
    cellsJ: footprint[1],
    width: viewBox[2],
    height: viewBox[3],
    originX: origin[0] - viewBox[0],
    originY: origin[1] - viewBox[1],
    // Layer names and layers hidden in /structure-lab are for the editor only.
    body: group[1]
      .replace(/<\w+\b[^>]*\sdisplay="none"[^>]*\/>\s*/g, "")
      .replace(/ data-layer="[^"]*"/g, "")
      .trim(),
  };
}

export const PARTS = Object.entries(PART_SOURCES)
  .map(([path, source]) => parseTownPart(path.replace(/^.*\/|\.svg$/g, ""), source))
  .sort((a, b) => a.name.localeCompare(b.name));

export function partNamed(name: string): TownPart {
  const found = PARTS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Town part ${name} is missing`);
  return found;
}

/** Both orientations of a gabled building. */
export function gabled(...names: string[]): TownPart[] {
  return names.flatMap((name) => [partNamed(`${name}-gable-left`), partNamed(`${name}-gable-right`)]);
}


export interface GridFootprint {
  i: number;
  j: number;
  part: Pick<TownPart, "cellsI" | "cellsJ">;
}

/**
 * Back-to-front order for buildings on disjoint footprints: one is drawn
 * first when it lies wholly behind the other along i or j.
 */
export function paintOrder<T extends GridFootprint>(buildings: readonly T[]): T[] {
  const behind = (a: T, b: T) => a.i + a.part.cellsI <= b.i + 1e-6 || a.j + a.part.cellsJ <= b.j + 1e-6;
  const remaining = [...buildings].sort((a, b) =>
    a.i + a.j + (a.part.cellsI + a.part.cellsJ) / 2 - (b.i + b.j + (b.part.cellsI + b.part.cellsJ) / 2));
  const ordered: T[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((candidate) =>
      remaining.every((other) => other === candidate || !(behind(other, candidate) && !behind(candidate, other))));
    ordered.push(...remaining.splice(Math.max(0, index), 1));
  }
  return ordered;
}

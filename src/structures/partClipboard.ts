import { newLayerId, type PartDocument, type PartLayer, type Point } from "./partDocument";
import type { ShapeRef } from "./partSelection";

type CopySelection = { kind: "layers"; ids: readonly string[] } | { kind: "shapes"; shapes: readonly ShapeRef[] };

export interface PartClipboard {
  kind: CopySelection["kind"];
  origin: Point;
  layers: PartLayer[];
}

/** Capture geometry and paint order at copy time, independently of subsequent edits. */
export function copyPartSelection(doc: PartDocument, selection: CopySelection): PartClipboard | null {
  const layers = doc.layers.flatMap((layer) => {
    const elements = selection.kind === "layers"
      ? selection.ids.includes(layer.id) ? [...layer.elements] : []
      : layer.hidden ? [] : layer.elements.filter((_, el) =>
        selection.shapes.some((shape) => shape.layerId === layer.id && shape.el === el));
    return elements.length ? [{ ...layer, elements }] : [];
  });
  return layers.length ? { kind: selection.kind, origin: [...doc.origin], layers } : null;
}

/** Fresh layers, aligned to the target part's grid, with one shared paste offset. */
export function pastePartLayers(clipboard: PartClipboard, target: PartDocument, offset: Point): PartLayer[] {
  const names = new Set(target.layers.map((layer) => layer.name));
  return clipboard.layers.map((layer) => {
    const baseName = `${layer.name} copy`;
    let name = baseName;
    for (let suffix = 2; names.has(name); suffix++) name = `${baseName} ${suffix}`;
    names.add(name);
    return {
      ...layer, id: newLayerId(), name, elements: [...layer.elements],
      dx: layer.dx + target.origin[0] - clipboard.origin[0] + offset[0],
      dy: layer.dy + target.origin[1] - clipboard.origin[1] + offset[1],
    };
  });
}

export function insertPartLayers(doc: PartDocument, copies: readonly PartLayer[], afterId: string | null): PartDocument {
  if (!copies.length) return doc;
  const index = doc.layers.findIndex((layer) => layer.id === afterId);
  const at = index < 0 ? doc.layers.length : index + 1;
  return { ...doc, layers: [...doc.layers.slice(0, at), ...copies, ...doc.layers.slice(at)] };
}

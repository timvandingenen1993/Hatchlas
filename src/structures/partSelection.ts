import { shapePoints, withShapePoints, type PartDocument, type Point } from "./partDocument";

export interface ShapeRef {
  layerId: string;
  el: number;
}

export interface CornerRef extends ShapeRef {
  index: number;
}

export interface PointRef extends CornerRef {
  x: number;
  y: number;
  ax: number;
  ay: number;
}

export const sameShape = (a: ShapeRef, b: ShapeRef) => a.layerId === b.layerId && a.el === b.el;
export const sameCorner = (a: CornerRef, b: CornerRef) => sameShape(a, b) && a.index === b.index;

export function selectItem<T>(selection: readonly T[], item: T, additive: boolean, same: (a: T, b: T) => boolean): T[] {
  const included = selection.some((other) => same(other, item));
  if (additive) return included ? selection.filter((other) => !same(other, item)) : [...selection, item];
  return included ? [...selection] : [item];
}

export function layerRange(order: readonly string[], anchor: string | null, id: string): string[] {
  const from = anchor ? order.indexOf(anchor) : -1;
  const to = order.indexOf(id);
  return from < 0 || to < 0 ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** Every corner of every visible straight-line shape, including its layer offset. */
export function allPoints(doc: PartDocument): PointRef[] {
  return doc.layers.flatMap((layer) => layer.hidden ? [] : layer.elements.flatMap((element, el) =>
    shapePoints(element)?.points.map(([x, y], index) => ({
      layerId: layer.id, el, index, x, y, ax: x + layer.dx, ay: y + layer.dy,
    })) ?? []));
}

/** Resolve references once, including shared corners once even when several faces are selected. */
export function pointTargets(doc: PartDocument, selection: readonly CornerRef[], link: boolean): PointRef[] {
  const points = allPoints(doc);
  const own = points.filter((point) => selection.some((corner) => sameCorner(corner, point)));
  if (!link) return own;
  // Files round to 0.01; corners within 0.05 units count as shared.
  return points.filter((point) => own.some((corner) =>
    sameCorner(corner, point) || (Math.abs(corner.ax - point.ax) < 0.05 && Math.abs(corner.ay - point.ay) < 0.05)));
}

export function shapeCorners(doc: PartDocument, shapes: readonly ShapeRef[]): CornerRef[] {
  return allPoints(doc).filter((point) => shapes.some((shape) => sameShape(shape, point)));
}

/** Move from the captured starting positions, so repeated pointer events never accumulate drift. */
export function movePoints(doc: PartDocument, targets: readonly PointRef[], dx: number, dy: number): PartDocument {
  if (targets.length === 0 || (dx === 0 && dy === 0)) return doc;
  return { ...doc, layers: doc.layers.map((layer) => {
    if (!targets.some((target) => target.layerId === layer.id)) return layer;
    return { ...layer, elements: layer.elements.map((element, el) => {
      const moving = targets.filter((target) => target.layerId === layer.id && target.el === el);
      const shape = moving.length > 0 ? shapePoints(element) : null;
      if (!shape) return element;
      const points = shape.points.map((point) => [...point] as Point);
      for (const target of moving) points[target.index] = [target.x + dx, target.y + dy];
      return withShapePoints(element, { ...shape, points });
    }) };
  }) };
}

export function moveLayers(doc: PartDocument, ids: readonly string[], dx: number, dy: number): PartDocument {
  if (dx === 0 && dy === 0) return doc;
  return { ...doc, layers: doc.layers.map((layer) => ids.includes(layer.id)
    ? { ...layer, dx: layer.dx + dx, dy: layer.dy + dy } : layer) };
}

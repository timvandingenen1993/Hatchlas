/**
 * Dev page (/structure-lab) for the town part SVGs. Each part is a stack of
 * layers (walls, windows, door, roof…): reorder, hide, rename, move and
 * duplicate them, borrow a layer from another part, or switch to the points
 * tool and reshape single shapes corner by corner. Save writes the file back
 * to src/assets/structures/town-parts through the dev server. Saved files
 * carry `data-edited`, so scripts/generate-town-parts.ts leaves them alone.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Dices,
  Eye,
  EyeOff,
  GripVertical,
  MousePointer2,
  PenTool,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
} from "lucide-react";
import { CASTLE_SLATE, CELL, ROOF_CSS, ROOF_PALETTES, STROKE_WIDTH } from "../structures/isoDraw";
import {
  fitViewBox,
  layerMarkup,
  nearestOnOutline,
  newLayerId,
  parsePartDocument,
  serializePartDocument,
  shapePoints,
  transplantLayer,
  withShapePoints,
  type PartDocument,
  type PartLayer,
  type Point,
} from "../structures/partDocument";
import { parseTownPart } from "../structures/townParts";
import { composeSettlement, svgDataUrl } from "../structures/townSprite";
import { SETTLEMENT_KINDS, type SettlementKind } from "../structures/types";

const FILES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../assets/structures/town-parts/*.svg", { query: "?raw", import: "default", eager: true }),
  ).map(([path, source]) => [path.replace(/^.*\/|\.svg$/g, ""), source]),
);

const HISTORY_LIMIT = 200;
/** Screen size of one grid step along i: right and down. */
const STEP_X = (Math.sqrt(3) / 2) * CELL;
const STEP_Y = 0.5 * CELL;
const PAINT_ATTRIBUTES = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"];

interface Draft {
  history: PartDocument[];
  index: number;
  /** Edits with the same key in a row (one drag, typing in one field) are one undo step. */
  lastKey?: string;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type View = Box;

type Tool = "layer" | "points";

/** One shape (path) of the part: element `el` of layer `layerId`. */
interface ShapeRef {
  layerId: string;
  el: number;
}

/** A corner of a shape: `x`, `y` in the shape's own coordinates, `ax`, `ay` on the canvas (with its layer's offset). */
interface PointRef extends ShapeRef {
  index: number;
  x: number;
  y: number;
  ax: number;
  ay: number;
}

type Drag =
  | { kind: "move"; id: string; pointer: number; startX: number; startY: number; dx: number; dy: number; key: string }
  | { kind: "pan"; pointer: number; clientX: number; clientY: number; view: View; scale: number }
  | {
      kind: "points"; pointer: number; startX: number; startY: number; key: string; moved: boolean;
      start: PartDocument; targets: PointRef[];
      /** The grabbed corner and the corners it may snap to; null when dragging a whole shape. */
      grab: Point | null; anchors: PointRef[];
    }
  | { kind: "marquee"; pointer: number; startX: number; startY: number; add: boolean };

/** Corners closer than this (viewBox units) count as one shared corner; files round to 0.01. */
const SHARED = 0.05;
/** Screen pixels within which a dragged corner snaps to another, and a double-click finds an edge. */
const SNAP_PX = 8;
const HANDLE_PX = 3.5;

/** Every corner of every visible straight-line shape in `doc`. */
function allPoints(doc: PartDocument): PointRef[] {
  const points: PointRef[] = [];
  for (const layer of doc.layers) {
    if (layer.hidden) continue;
    layer.elements.forEach((element, el) => {
      shapePoints(element)?.points.forEach(([x, y], index) => {
        points.push({ layerId: layer.id, el, index, x, y, ax: x + layer.dx, ay: y + layer.dy });
      });
    });
  }
  return points;
}

const sameShape = (a: ShapeRef, b: ShapeRef) => a.layerId === b.layerId && a.el === b.el;

/**
 * Corners `indices` of `shape`, plus, when `link` is on, every corner of
 * another shape that sits on one of them, so faces sharing a corner stay joined.
 */
function pointTargets(doc: PartDocument, shape: ShapeRef, indices: readonly number[], link: boolean): PointRef[] {
  const points = allPoints(doc);
  const own = points.filter((point) => sameShape(point, shape) && indices.includes(point.index));
  if (!link) return own;
  const shared = points.filter((point) => !sameShape(point, shape)
    && own.some((corner) => Math.abs(corner.ax - point.ax) < SHARED && Math.abs(corner.ay - point.ay) < SHARED));
  return [...own, ...shared];
}

/** `doc` with every target corner moved by (dx, dy) from where the target says it was. */
function movePoints(doc: PartDocument, targets: readonly PointRef[], dx: number, dy: number): PartDocument {
  if (targets.length === 0) return doc;
  const layers = doc.layers.map((layer) => {
    if (!targets.some((target) => target.layerId === layer.id)) return layer;
    const elements = layer.elements.map((element, el) => {
      const moving = targets.filter((target) => target.layerId === layer.id && target.el === el);
      const shape = moving.length > 0 ? shapePoints(element) : null;
      if (!shape) return element;
      const points = shape.points.map((point) => [...point] as Point);
      for (const target of moving) points[target.index] = [target.x + dx, target.y + dy];
      return withShapePoints(element, { ...shape, points });
    });
    return { ...layer, elements };
  });
  return { ...doc, layers };
}

function parseOrError(source: string): PartDocument | Error {
  try {
    return parsePartDocument(source);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Snaps an offset to half grid cells along i and j. */
function snapToGrid(dx: number, dy: number): [number, number] {
  const a = Math.round((dx / STEP_X + dy / STEP_Y)) / 2;
  const b = Math.round((dy / STEP_Y - dx / STEP_X)) / 2;
  return [(a - b) * STEP_X, (a + b) * STEP_Y];
}

function defaultPalette(name: string): number {
  return /^(castle-|keep|great-keep|turret|gatehouse)/.test(name) ? CASTLE_SLATE : 0;
}

/** Drawn bounds of `layers` in viewBox units, read from the rendered canvas. */
function measureLayers(svg: SVGSVGElement | null, layers: readonly PartLayer[]): Box | null {
  if (!svg) return null;
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const layer of layers) {
    if (layer.hidden) continue;
    for (const element of svg.querySelectorAll<SVGGraphicsElement>(`[data-lid="${layer.id}"]`)) {
      const b = element.getBBox();
      const [x0, y0, x1, y1] = [b.x + layer.dx, b.y + layer.dy, b.x + b.width + layer.dx, b.y + b.height + layer.dy];
      box = box
        ? { minX: Math.min(box.minX, x0), minY: Math.min(box.minY, y0), maxX: Math.max(box.maxX, x1), maxY: Math.max(box.maxY, y1) }
        : { minX: x0, minY: y0, maxX: x1, maxY: y1 };
    }
  }
  return box && { x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY };
}

function fitView(doc: PartDocument): View {
  const [x, y, width, height] = doc.viewBox;
  const pad = Math.max(width, height) * 0.15;
  return { x: x - pad, y: y - pad, width: width + pad * 2, height: height + pad * 2 };
}

/** The first settlement (kind and seed) that draws `part`, so the context preview shows it. */
function settlementShowing(part: string): { kind: SettlementKind; seed: number } {
  for (const { kind } of SETTLEMENT_KINDS) {
    for (let seed = 1; seed <= 6; seed++) {
      if (composeSettlement(kind, seed).includes(`data-part="${part}"`)) return { kind, seed };
    }
  }
  return { kind: "village", seed: 1 };
}

export function StructureLabRoute() {
  // A saved file stands in for the one on disk until the dev server reloads
  // this module with the new files (Fast Refresh reruns the memo then).
  const [saved, setSaved] = useState<Record<string, { text: string; files: typeof FILES }>>({});
  const sources = useMemo(() => {
    const pending = Object.entries(saved).filter(([, entry]) => entry.files === FILES);
    return { ...FILES, ...Object.fromEntries(pending.map(([name, entry]) => [name, entry.text])) };
  }, [saved]);
  const names = useMemo(() => Object.keys(sources).sort(), [sources]);
  const [selected, setSelected] = useState(() => (sources["house-gable-right"] ? "house-gable-right" : names[0]));
  const [filter, setFilter] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [layerId, setLayerId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [palette, setPalette] = useState(() => defaultPalette(selected));
  const [showGrid, setShowGrid] = useState(true);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [saveAsName, setSaveAsName] = useState("");
  const [borrow, setBorrow] = useState("");
  const [context, setContext] = useState(() => settlementShowing(selected));
  const [highlightInContext, setHighlightInContext] = useState(true);
  const [tool, setTool] = useState<Tool>("layer");
  const [shape, setShape] = useState<ShapeRef | null>(null);
  const [pointSelection, setPointSelection] = useState<number[]>([]);
  const [hoverShape, setHoverShape] = useState<ShapeRef | null>(null);
  const [linkCorners, setLinkCorners] = useState(true);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const dragLayerRef = useRef<string | null>(null);

  const baseDocs = useMemo(
    () => Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, parseOrError(source)])),
    [sources],
  );
  const docOf = useCallback(
    (name: string): PartDocument | Error | undefined => {
      const draft = drafts[name];
      return draft ? draft.history[draft.index] : baseDocs[name];
    },
    [baseDocs, drafts],
  );
  const current = docOf(selected);
  const doc = current instanceof Error ? null : current ?? null;
  const draft = drafts[selected];
  const dirty = (name: string) => (drafts[name]?.index ?? 0) > 0;
  const anyDirty = names.some(dirty);

  const [view, setView] = useState<View>(() => (doc ? fitView(doc) : { x: 0, y: 0, width: 100, height: 100 }));
  /** ViewBox units per screen pixel (the canvas letterboxes the view). */
  const unitsPerPixel = Math.max(view.width / canvasSize.width, view.height / canvasSize.height);

  // The selected shape, if it still exists after undo or a layer change.
  const { shapeLayer, shapeElement, shapeGeometry } = useMemo(() => {
    const shapeLayer = shape ? doc?.layers.find((layer) => layer.id === shape.layerId) ?? null : null;
    const shapeElement = shape && shapeLayer ? shapeLayer.elements[shape.el] ?? null : null;
    return { shapeLayer, shapeElement, shapeGeometry: shapeElement ? shapePoints(shapeElement) : null };
  }, [doc, shape]);
  const selectedPoints = useMemo(
    () => (shapeGeometry ? pointSelection.filter((index) => index < shapeGeometry.points.length) : []),
    [pointSelection, shapeGeometry],
  );

  /** Applies `change` to the selected part as one undo step (or merges into the last one with the same `key`). */
  const update = useCallback(
    (change: (doc: PartDocument) => PartDocument, key?: string) => {
      setDrafts((previous) => {
        const base = baseDocs[selected];
        if (!base || base instanceof Error) return previous;
        const draft = previous[selected] ?? { history: [base], index: 0 };
        const next = change(draft.history[draft.index]);
        if (next === draft.history[draft.index]) return previous;
        const history = draft.history.slice(0, draft.index + 1);
        if (key !== undefined && draft.lastKey === key && history.length > 1) history[history.length - 1] = next;
        else history.push(next);
        if (history.length > HISTORY_LIMIT) history.splice(1, history.length - HISTORY_LIMIT);
        return { ...previous, [selected]: { history, index: history.length - 1, lastKey: key } };
      });
    },
    [baseDocs, selected],
  );

  const updateLayer = useCallback(
    (id: string, change: (layer: PartLayer) => PartLayer, key?: string) =>
      update((doc) => {
        const layers = doc.layers.map((layer) => (layer.id === id ? change(layer) : layer));
        return layers.every((layer, index) => layer === doc.layers[index]) ? doc : { ...doc, layers };
      }, key),
    [update],
  );

  const step = useCallback(
    (by: -1 | 1) => {
      setDrafts((previous) => {
        const draft = previous[selected];
        if (!draft) return previous;
        const index = Math.min(draft.history.length - 1, Math.max(0, draft.index + by));
        return index === draft.index ? previous : { ...previous, [selected]: { ...draft, index, lastKey: undefined } };
      });
    },
    [selected],
  );

  const revert = () => {
    setDrafts(({ [selected]: _dropped, ...rest }) => rest);
    setLayerId(null);
  };

  const moveLayer = (id: string, to: number) =>
    update((doc) => {
      const from = doc.layers.findIndex((layer) => layer.id === id);
      const target = Math.max(0, Math.min(doc.layers.length - 1, to));
      if (from < 0 || from === target) return doc;
      const layers = [...doc.layers];
      layers.splice(target, 0, ...layers.splice(from, 1));
      return { ...doc, layers };
    });

  const removeLayer = useCallback(
    (id: string) => {
      update((doc) => ({ ...doc, layers: doc.layers.filter((layer) => layer.id !== id) }));
      setLayerId((selectedId) => (selectedId === id ? null : selectedId));
    },
    [update],
  );

  const duplicateLayer = (id: string) => {
    const copyId = newLayerId();
    update((doc) => {
      const index = doc.layers.findIndex((layer) => layer.id === id);
      if (index < 0) return doc;
      const layers = [...doc.layers];
      layers.splice(index + 1, 0, { ...doc.layers[index], id: copyId, name: `${doc.layers[index].name} copy` });
      return { ...doc, layers };
    });
    setLayerId(copyId);
  };

  const borrowOptions = useMemo(
    () =>
      names
        .map((name) => ({ name, doc: docOf(name) }))
        .filter((entry): entry is { name: string; doc: PartDocument } => entry.doc !== undefined && !(entry.doc instanceof Error)),
    [docOf, names],
  );

  const addBorrowed = () => {
    const [from, id] = borrow.split("|");
    const source = borrowOptions.find((option) => option.name === from)?.doc;
    const layer = source?.layers.find((candidate) => candidate.id === id);
    if (!source || !layer || !doc) return;
    const copy = { ...transplantLayer(layer, source, doc), name: from === selected ? `${layer.name} copy` : layer.name };
    update((doc) => {
      const at = layerId ? doc.layers.findIndex((candidate) => candidate.id === layerId) + 1 : doc.layers.length;
      const layers = [...doc.layers];
      layers.splice(at > 0 ? at : layers.length, 0, copy);
      return { ...doc, layers };
    });
    setLayerId(copy.id);
  };

  const save = useCallback(
    async (target: string) => {
      if (!doc) return;
      try {
        const text = serializePartDocument(fitViewBox(doc, measureLayers(svgRef.current, doc.layers), STROKE_WIDTH * 2));
        parseTownPart(target, text);
        const response = await fetch(`/__town-parts/${encodeURIComponent(target)}`, { method: "POST", body: text });
        if (!response.ok) {
          throw new Error(response.status === 404 ? "Saving needs the Vite dev server (npm run dev)" : await response.text());
        }
        setSaved((previous) => ({ ...previous, [target]: { text, files: FILES } }));
        // The edits now live in the saved file (a new part, for "save as").
        setDrafts(({ [selected]: _saved, ...rest }) => rest);
        if (target !== selected) {
          setSelected(target);
          setSaveAsName("");
        }
        setLayerId(null);
        setStatus({ text: `Saved ${target}.svg` });
      } catch (error) {
        setStatus({ text: error instanceof Error ? error.message : String(error), error: true });
      }
    },
    [doc, selected],
  );

  const selectPart = (name: string) => {
    setSelected(name);
    setLayerId(null);
    setShape(null);
    setPointSelection([]);
    setRenamingId(null);
    setPalette(defaultPalette(name));
    setContext(settlementShowing(name));
    setStatus(null);
    const next = docOf(name);
    if (next && !(next instanceof Error)) setView(fitView(next));
  };

  /** Moves corners `indices` of the selected shape (and the corners they share, if linked) by (dx, dy). */
  const nudgePoints = useCallback(
    (indices: readonly number[], dx: number, dy: number, key: string) => {
      if (!shape) return;
      update((doc) => movePoints(doc, pointTargets(doc, shape, indices, linkCorners), dx, dy), key);
    },
    [linkCorners, shape, update],
  );

  const deleteShape = useCallback(() => {
    if (!shape) return;
    update((doc) => ({
      ...doc,
      layers: doc.layers
        .map((layer) => (layer.id === shape.layerId ? { ...layer, elements: layer.elements.filter((_, el) => el !== shape.el) } : layer))
        .filter((layer) => layer.elements.length > 0),
    }));
    setShape(null);
    setPointSelection([]);
  }, [shape, update]);

  const deletePoints = useCallback(() => {
    if (!shape || !shapeGeometry || selectedPoints.length === 0) return;
    const left = shapeGeometry.points.filter((_, index) => !selectedPoints.includes(index));
    if (left.length < (shapeGeometry.closed ? 3 : 2)) {
      setStatus({ text: "A shape needs at least 3 corners (2 for a line); delete the shape instead.", error: true });
      return;
    }
    update((doc) => ({
      ...doc,
      layers: doc.layers.map((layer) => layer.id !== shape.layerId ? layer : {
        ...layer,
        elements: layer.elements.map((element, el) => (el === shape.el ? withShapePoints(element, { ...shapeGeometry, points: left }) : element)),
      }),
    }));
    setPointSelection([]);
  }, [selectedPoints, shape, shapeGeometry, update]);

  /** Adds a corner to the selected shape where its outline passes nearest (x, y), and to any shape sharing that edge. */
  const insertPoint = (x: number, y: number): boolean => {
    if (!shape || !shapeGeometry || !shapeLayer) return false;
    const near = nearestOnOutline(shapeGeometry, x - shapeLayer.dx, y - shapeLayer.dy);
    const tooClose = shapeGeometry.points.some(([px, py]) => Math.hypot(px - near.point[0], py - near.point[1]) < SNAP_PX * unitsPerPixel * 0.5);
    if (near.distance > SNAP_PX * unitsPerPixel || tooClose) return false;
    const [ax, ay] = [near.point[0] + shapeLayer.dx, near.point[1] + shapeLayer.dy];
    update((doc) => ({
      ...doc,
      layers: doc.layers.map((layer) => {
        if (layer.hidden && layer.id !== shape.layerId) return layer;
        const elements = layer.elements.map((element, el) => {
          const own = layer.id === shape.layerId && el === shape.el;
          if (!own && !linkCorners) return element;
          const geometry = shapePoints(element);
          if (!geometry) return element;
          const at = nearestOnOutline(geometry, ax - layer.dx, ay - layer.dy);
          const onCorner = geometry.points.some(([px, py]) => Math.hypot(px - at.point[0], py - at.point[1]) < SHARED);
          if (!own && (at.distance > SHARED || onCorner)) return element;
          const points = [...geometry.points];
          points.splice(at.insertAt, 0, own ? near.point : at.point);
          return withShapePoints(element, { ...geometry, points });
        });
        return elements.every((element, index) => element === layer.elements[index]) ? layer : { ...layer, elements };
      }),
    }));
    setPointSelection([near.insertAt]);
    return true;
  };

  // Keyboard: undo/redo, save, tools, delete and nudge the selected layer or corners.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === "z") {
        event.preventDefault();
        step(event.shiftKey ? 1 : -1);
      } else if (mod && key === "y") {
        event.preventDefault();
        step(1);
      } else if (mod && key === "s") {
        event.preventDefault();
        void save(selected);
      } else if (!mod && (key === "v" || key === "a")) {
        setTool(key === "v" ? "layer" : "points");
      } else if (tool === "points") {
        const arrow = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, Point>)[event.key];
        if (mod && key === "a" && shapeGeometry) {
          event.preventDefault();
          setPointSelection(shapeGeometry.points.map((_, index) => index));
        } else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          if (selectedPoints.length > 0) deletePoints();
          else deleteShape();
        } else if (arrow && shapeGeometry) {
          event.preventDefault();
          const amount = event.shiftKey ? 2 : 0.5;
          const indices = selectedPoints.length > 0 ? selectedPoints : shapeGeometry.points.map((_, index) => index);
          nudgePoints(indices, arrow[0] * amount, arrow[1] * amount, `nudge-points:${shape?.layerId}:${shape?.el}:${indices.join(",")}`);
        } else if (event.key === "Escape") {
          if (selectedPoints.length > 0) setPointSelection([]);
          else setShape(null);
        }
      } else if (layerId && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        removeLayer(layerId);
      } else if (layerId && event.key.startsWith("Arrow")) {
        event.preventDefault();
        const amount = event.shiftKey ? 2 : 0.5;
        const [x, y] = { ArrowLeft: [-amount, 0], ArrowRight: [amount, 0], ArrowUp: [0, -amount], ArrowDown: [0, amount] }[event.key] ?? [0, 0];
        updateLayer(layerId, (layer) => ({ ...layer, dx: layer.dx + x, dy: layer.dy + y }), `nudge:${layerId}`);
      } else if (event.key === "Escape") {
        setLayerId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deletePoints, deleteShape, layerId, nudgePoints, removeLayer, save, selected, selectedPoints, shape, shapeGeometry, step, tool, updateLayer]);

  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  // Wheel zoom about the cursor; a native listener so the page does not scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const factor = Math.exp(event.deltaY * 0.0015);
      setView((view) => ({
        x: point.x - (point.x - view.x) * factor,
        y: point.y - (point.y - view.y) * factor,
        width: view.width * factor,
        height: view.height * factor,
      }));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) =>
      setCanvasSize({ width: entry.contentRect.width || 1, height: entry.contentRect.height || 1 }));
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const toSvg = (event: { clientX: number; clientY: number }) => {
    const matrix = svgRef.current?.getScreenCTM();
    return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : null;
  };

  /** Starts dragging corners `indices` of `target`; `grab` is the corner under the pointer, which snaps. */
  const startPointDrag = (event: ReactPointerEvent, start: Point, target: ShapeRef, indices: readonly number[], grab: Point | null, link: boolean) => {
    if (!doc) return;
    const targets = pointTargets(doc, target, indices, link);
    const anchors = grab
      ? allPoints(doc).filter((point) => !targets.some((moving) => sameShape(moving, point) && moving.index === point.index))
      : [];
    dragRef.current = {
      kind: "points", pointer: event.pointerId, startX: start[0], startY: start[1], key: `points:${event.timeStamp}`,
      moved: false, start: doc, targets, grab, anchors,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !doc) return;
    const hitElement = (event.target as Element).closest("[data-lid]");
    const hit = hitElement?.getAttribute("data-lid");
    const layer = hit ? doc.layers.find((candidate) => candidate.id === hit) : undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toSvg(event);
    if (!point) return;
    if (tool === "points") {
      const handle = (event.target as Element).closest("[data-handle]");
      if (handle && shape && shapeGeometry && shapeLayer) {
        const index = Number(handle.getAttribute("data-handle"));
        let selection = selectedPoints;
        if (event.shiftKey) selection = selection.includes(index) ? selection.filter((other) => other !== index) : [...selection, index];
        else if (!selection.includes(index)) selection = [index];
        setPointSelection(selection);
        if (selection.includes(index)) {
          const [x, y] = shapeGeometry.points[index];
          startPointDrag(event, [point.x, point.y], shape, selection, [x + shapeLayer.dx, y + shapeLayer.dy], linkCorners);
        }
        return;
      }
      if (layer && hitElement) {
        const next = { layerId: layer.id, el: Number(hitElement.getAttribute("data-el")) };
        if (!shape || !sameShape(shape, next)) setPointSelection([]);
        setShape(next);
        setLayerId(layer.id);
        // Dragging the body moves the whole shape, without its neighbours.
        const geometry = shapePoints(layer.elements[next.el] ?? "");
        if (geometry) startPointDrag(event, [point.x, point.y], next, geometry.points.map((_, index) => index), null, false);
        return;
      }
      if (event.shiftKey && shape) {
        dragRef.current = { kind: "marquee", pointer: event.pointerId, startX: point.x, startY: point.y, add: true };
        return;
      }
      setShape(null);
      setPointSelection([]);
      const scale = 1 / (event.currentTarget.getScreenCTM()?.a ?? 1);
      dragRef.current = { kind: "pan", pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, view, scale };
      return;
    }
    if (layer) {
      setLayerId(layer.id);
      dragRef.current = {
        kind: "move", id: layer.id, pointer: event.pointerId, startX: point.x, startY: point.y,
        dx: layer.dx, dy: layer.dy, key: `move:${event.timeStamp}`,
      };
    } else {
      setLayerId(null);
      const scale = 1 / (event.currentTarget.getScreenCTM()?.a ?? 1);
      dragRef.current = { kind: "pan", pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, view, scale };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== event.pointerId) {
      if (tool === "points" && !drag) {
        const hit = (event.target as Element).closest("[data-lid]");
        const next = hit ? { layerId: hit.getAttribute("data-lid")!, el: Number(hit.getAttribute("data-el")) } : null;
        if (next ? !hoverShape || !sameShape(next, hoverShape) : hoverShape) setHoverShape(next);
      }
      return;
    }
    if (drag.kind === "pan") {
      setView({
        ...drag.view,
        x: drag.view.x - (event.clientX - drag.clientX) * drag.scale,
        y: drag.view.y - (event.clientY - drag.clientY) * drag.scale,
      });
      return;
    }
    const point = toSvg(event);
    if (!point) return;
    if (drag.kind === "marquee") {
      setMarquee({
        x: Math.min(drag.startX, point.x), y: Math.min(drag.startY, point.y),
        width: Math.abs(point.x - drag.startX), height: Math.abs(point.y - drag.startY),
      });
      return;
    }
    if (drag.kind === "points") {
      let [dx, dy] = [point.x - drag.startX, point.y - drag.startY];
      // A click is not a move: wait for the pointer to travel a little.
      if (!drag.moved && Math.hypot(dx, dy) < 2 * unitsPerPixel) return;
      drag.moved = true;
      if (drag.grab && !event.altKey) {
        const [gx, gy] = [drag.grab[0] + dx, drag.grab[1] + dy];
        let best: PointRef | null = null;
        let bestDistance = SNAP_PX * unitsPerPixel;
        for (const anchor of drag.anchors) {
          const distance = Math.hypot(anchor.ax - gx, anchor.ay - gy);
          if (distance < bestDistance) [best, bestDistance] = [anchor, distance];
        }
        if (best) [dx, dy] = [best.ax - drag.grab[0], best.ay - drag.grab[1]];
      }
      update(() => movePoints(drag.start, drag.targets, dx, dy), drag.key);
      return;
    }
    let [dx, dy] = [drag.dx + point.x - drag.startX, drag.dy + point.y - drag.startY];
    if (event.shiftKey) [dx, dy] = snapToGrid(dx, dy);
    updateLayer(drag.id, (layer) => (layer.dx === dx && layer.dy === dy ? layer : { ...layer, dx, dy }), drag.key);
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (drag?.pointer !== event.pointerId) return;
    dragRef.current = null;
    if (drag.kind === "marquee") {
      setMarquee(null);
      const point = toSvg(event);
      if (!point || !shapeGeometry || !shapeLayer) return;
      const [x0, x1] = [Math.min(drag.startX, point.x), Math.max(drag.startX, point.x)];
      const [y0, y1] = [Math.min(drag.startY, point.y), Math.max(drag.startY, point.y)];
      const inside = shapeGeometry.points.flatMap(([x, y], index) => {
        const [ax, ay] = [x + shapeLayer.dx, y + shapeLayer.dy];
        return ax >= x0 && ax <= x1 && ay >= y0 && ay <= y1 ? [index] : [];
      });
      setPointSelection((selection) => [...new Set([...(drag.add ? selection : []), ...inside])]);
    }
  };

  // Dashed box round the hovered or selected layer.
  const focusId = hoverId ?? layerId;
  const [focusBox, setFocusBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const layer = doc?.layers.find((candidate) => candidate.id === focusId);
    setFocusBox(layer ? measureLayers(svgRef.current, [layer]) : null);
  }, [doc, focusId]);

  const partMarkup = useMemo(() => {
    if (!doc) return "";
    const paint = doc.attributes
      .filter(([name]) => PAINT_ATTRIBUTES.includes(name))
      .map(([name, value]) => `${name}="${value}"`)
      .join(" ");
    const layers = doc.layers.map((layer) => layerMarkup(layer, (index) => ` data-lid="${layer.id}" data-el="${index}"`)).join("\n");
    return `<g class="p${palette}" ${paint}>${doc.groupOpen}${layers}</g></g>`;
  }, [doc, palette]);
  // React 19 resets innerHTML whenever this object is new, which would swap
  // the shapes out under the pointer mid-click; keep it stable.
  const partHtml = useMemo(() => ({ __html: partMarkup }), [partMarkup]);
  const defsHtml = useMemo(() => ({ __html: doc ? doc.defs.replace(/^<defs>|<\/defs>$/g, "") : "" }), [doc]);

  const thumbnails = useMemo(
    () => Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, svgDataUrl(source)])),
    [sources],
  );

  // Composed from the files on disk, so it shows edits once they are saved.
  const contextUrl = useMemo(() => {
    let svg = composeSettlement(context.kind, context.seed);
    if (highlightInContext) {
      svg = svg.replace("</svg>", `<style>[data-part]:not([data-part="${selected}"]){opacity:.35}</style></svg>`);
    }
    return svgDataUrl(svg);
    // Fast Refresh reruns this when a save reloads the parts it composes from.
  }, [context, highlightInContext, selected]);

  const selectedLayer = doc?.layers.find((layer) => layer.id === layerId) ?? null;
  const hoverLayer = tool === "points" && hoverShape && !(shape && sameShape(shape, hoverShape))
    ? doc?.layers.find((layer) => layer.id === hoverShape.layerId) ?? null
    : null;
  const hoverGeometry = hoverShape && hoverLayer ? shapePoints(hoverLayer.elements[hoverShape.el] ?? "") : null;
  const singlePoint = shapeGeometry && shapeLayer && selectedPoints.length === 1
    ? ([shapeGeometry.points[selectedPoints[0]][0] + shapeLayer.dx, shapeGeometry.points[selectedPoints[0]][1] + shapeLayer.dy] as Point)
    : null;
  const listed = doc ? [...doc.layers].reverse() : [];
  const visibleNames = names.filter((name) => name.includes(filter.trim().toLowerCase()));
  const button = "flex items-center gap-1 rounded bg-slate-800 px-2 py-1 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800";
  const iconButton = "rounded p-0.5 text-slate-400 hover:bg-slate-700 hover:text-slate-100 disabled:opacity-30";
  const numberInput = "w-full rounded bg-slate-950 px-1.5 py-0.5 tabular-nums";

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 font-sans text-xs text-slate-100">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900">
        <div className="p-3">
          <h1 className="mb-1 text-sm font-bold">Structure lab</h1>
          <p className="mb-2 text-slate-400">Town parts in src/assets/structures/town-parts.</p>
          <input
            className="w-full rounded bg-slate-950 px-2 py-1"
            placeholder="Filter parts"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <ul className="flex-1 overflow-y-auto px-2 pb-2">
          {visibleNames.map((name) => (
            <li key={name}>
              <button
                className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left ${name === selected ? "bg-sky-900/60" : "hover:bg-slate-800"}`}
                onClick={() => selectPart(name)}
              >
                <img src={thumbnails[name]} alt="" className="h-8 w-8 shrink-0 object-contain" />
                <span className="flex-1 truncate">{name}</span>
                {dirty(name) && <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" title="Unsaved changes" />}
                {/\sdata-edited=/.test(/<svg\b[^>]*>/.exec(sources[name])?.[0] ?? "") && (
                  <span className="shrink-0 text-[10px] text-slate-500" title="Hand-edited: the generator leaves this file alone">
                    edited
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-2">
          <span className="text-sm font-semibold">{selected}</span>
          {dirty(selected) && <span className="text-amber-300">unsaved</span>}
          <span className="flex-1" />
          <div className="flex overflow-hidden rounded bg-slate-800">
            {([["layer", "Layers", "V", MousePointer2], ["points", "Points", "A", PenTool]] as const).map(([id, label, key, Icon]) => (
              <button
                key={id}
                className={`flex items-center gap-1 px-2 py-1 ${tool === id ? "bg-sky-700" : "hover:bg-slate-700"}`}
                onClick={() => setTool(id)}
                title={`${label} tool (${key})`}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
          <button className={button} disabled={!draft || draft.index === 0} onClick={() => step(-1)} title="Undo (Ctrl+Z)">
            <Undo2 size={14} /> Undo
          </button>
          <button className={button} disabled={!draft || draft.index >= draft.history.length - 1} onClick={() => step(1)} title="Redo (Ctrl+Shift+Z)">
            <Redo2 size={14} /> Redo
          </button>
          <button className={button} disabled={!draft} onClick={revert} title="Drop all unsaved changes to this part">
            <RotateCcw size={14} /> Revert
          </button>
          <label className="flex items-center gap-1">
            Roof
            <select className="rounded bg-slate-800 px-1 py-1" value={palette} onChange={(event) => setPalette(Number(event.target.value))}>
              {ROOF_PALETTES.map((_, index) => (
                <option key={index} value={index}>Palette {index + 1}</option>
              ))}
              <option value={CASTLE_SLATE}>Castle slate</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} /> Grid
          </label>
          <button className={button} onClick={() => doc && setView(fitView(doc))}>Fit</button>
          <button className={`${button} bg-sky-700 hover:bg-sky-600`} disabled={!doc} onClick={() => void save(selected)} title="Save (Ctrl+S)">
            <Save size={14} /> Save
          </button>
        </div>
        {status && (
          <div className={`border-b border-slate-800 px-3 py-1 ${status.error ? "text-red-400" : "text-emerald-300"}`}>{status.text}</div>
        )}
        <div className="relative min-h-0 flex-1 bg-[#efe6d2]">
          {current instanceof Error && <p className="absolute inset-x-0 top-4 text-center text-red-700">{current.message}</p>}
          <svg
            ref={svgRef}
            className="h-full w-full touch-none select-none"
            viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(event) => {
              if (!doc) return;
              const point = tool === "points" ? toSvg(event) : null;
              if (point && insertPoint(point.x, point.y)) return;
              if (!(event.target as Element).closest("[data-lid], [data-handle]")) setView(fitView(doc));
            }}
          >
            <style>{ROOF_CSS}</style>
            {doc && <defs dangerouslySetInnerHTML={defsHtml} />}
            {doc && (
              <rect
                x={doc.viewBox[0]} y={doc.viewBox[1]} width={doc.viewBox[2]} height={doc.viewBox[3]}
                fill="none" stroke="#a8916e" strokeDasharray="4 3" vectorEffect="non-scaling-stroke"
              />
            )}
            {doc && showGrid && <GridOverlay doc={doc} />}
            <g dangerouslySetInnerHTML={partHtml} />
            {hoverGeometry && hoverLayer && (
              <path
                d={outlinePath(hoverGeometry, hoverLayer.dx, hoverLayer.dy)}
                fill="none" stroke="#0284c7" strokeWidth={1} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" pointerEvents="none"
              />
            )}
            {tool === "points" && shapeGeometry && shapeLayer && (
              <g>
                <path
                  d={outlinePath(shapeGeometry, shapeLayer.dx, shapeLayer.dy)}
                  fill="none" stroke="#0284c7" strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none"
                />
                {shapeGeometry.points.map(([x, y], index) => {
                  const size = HANDLE_PX * unitsPerPixel * (selectedPoints.includes(index) ? 1.3 : 1);
                  return (
                    <rect
                      key={index}
                      data-handle={index}
                      x={x + shapeLayer.dx - size} y={y + shapeLayer.dy - size} width={size * 2} height={size * 2}
                      fill={selectedPoints.includes(index) ? "#0284c7" : "#ffffff"} stroke="#0284c7" strokeWidth={1}
                      vectorEffect="non-scaling-stroke" className="cursor-move"
                    />
                  );
                })}
              </g>
            )}
            {marquee && (
              <rect
                x={marquee.x} y={marquee.y} width={marquee.width} height={marquee.height}
                fill="#0284c7" fillOpacity={0.08} stroke="#0284c7" strokeWidth={1} strokeDasharray="4 2"
                vectorEffect="non-scaling-stroke" pointerEvents="none"
              />
            )}
            {tool === "layer" && focusBox && (
              <rect
                x={focusBox.x} y={focusBox.y} width={focusBox.width} height={focusBox.height}
                fill="none" stroke="#0284c7" strokeWidth={1.5} strokeDasharray="5 3"
                vectorEffect="non-scaling-stroke" pointerEvents="none"
              />
            )}
          </svg>
          <p className="pointer-events-none absolute bottom-2 left-3 right-3 text-[11px] text-stone-600">
            {tool === "layer"
              ? "Layers tool: click a shape to pick its layer; drag to move the layer (Shift snaps to half cells), arrows nudge."
              : "Points tool: click a shape, then drag its corners (they snap to other corners; Alt stops that). Shift-click or "
                + "Shift-drag a box adds corners, double-click an edge adds one, Delete removes, arrows nudge."}
            {" "}Drag the background to pan, scroll to zoom, double-click empty space to fit. Dashed brown: the file's viewBox.
          </p>
        </div>
      </main>

      <aside className="w-80 shrink-0 overflow-y-auto border-l border-slate-800 bg-slate-900 p-3">
        <section className="mb-4">
          <h2 className="mb-1 font-semibold uppercase tracking-wider text-slate-400">Layers</h2>
          <p className="mb-2 text-slate-500">Top of the list is drawn last, in front.</p>
          <ul onMouseLeave={() => setHoverId(null)}>
            {listed.map((layer) => {
              const index = doc!.layers.indexOf(layer);
              return (
                <li
                  key={layer.id}
                  draggable={renamingId !== layer.id}
                  onDragStart={(event) => {
                    dragLayerRef.current = layer.id;
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOverId(layer.id);
                  }}
                  onDragLeave={() => setDragOverId((id) => (id === layer.id ? null : id))}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragOverId(null);
                    if (dragLayerRef.current) moveLayer(dragLayerRef.current, index);
                    dragLayerRef.current = null;
                  }}
                  onDragEnd={() => setDragOverId(null)}
                  onMouseEnter={() => setHoverId(layer.id)}
                  onClick={() => setLayerId(layer.id)}
                  className={`mb-0.5 flex items-center gap-1 rounded px-1 py-1 ${
                    layer.id === layerId ? "bg-sky-900/60" : "hover:bg-slate-800"
                  } ${dragOverId === layer.id ? "outline outline-1 outline-sky-500" : ""}`}
                >
                  <GripVertical size={14} className="shrink-0 cursor-grab text-slate-600" />
                  <button
                    className={iconButton}
                    title={layer.hidden ? "Show (hidden layers are saved but not drawn)" : "Hide"}
                    onClick={(event) => {
                      event.stopPropagation();
                      updateLayer(layer.id, (current) => ({ ...current, hidden: !current.hidden }));
                    }}
                  >
                    {layer.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  {renamingId === layer.id ? (
                    <input
                      autoFocus
                      className="min-w-0 flex-1 rounded bg-slate-950 px-1"
                      defaultValue={layer.name}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={(event) => {
                        const name = event.target.value.replace(/["<>&]/g, "").trim();
                        if (name && name !== layer.name) updateLayer(layer.id, (current) => ({ ...current, name }));
                        setRenamingId(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <span
                      className={`min-w-0 flex-1 truncate ${layer.hidden ? "text-slate-500 line-through" : ""}`}
                      title="Double-click to rename"
                      onDoubleClick={() => setRenamingId(layer.id)}
                    >
                      {layer.name}
                      <span className="ml-1 text-slate-500">{layer.elements.length}</span>
                      {(layer.dx !== 0 || layer.dy !== 0) && <span className="ml-1 text-sky-400" title="Moved">↗</span>}
                    </span>
                  )}
                  <button className={iconButton} title="Bring forward" disabled={index === doc!.layers.length - 1}
                    onClick={(event) => { event.stopPropagation(); moveLayer(layer.id, index + 1); }}>
                    <ChevronUp size={14} />
                  </button>
                  <button className={iconButton} title="Send backward" disabled={index === 0}
                    onClick={(event) => { event.stopPropagation(); moveLayer(layer.id, index - 1); }}>
                    <ChevronDown size={14} />
                  </button>
                  <button className={iconButton} title="Duplicate"
                    onClick={(event) => { event.stopPropagation(); duplicateLayer(layer.id); }}>
                    <Copy size={14} />
                  </button>
                  <button className={iconButton} title="Delete (Del)"
                    onClick={(event) => { event.stopPropagation(); removeLayer(layer.id); }}>
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex gap-1">
            <select className="min-w-0 flex-1 rounded bg-slate-800 px-1 py-1" value={borrow} onChange={(event) => setBorrow(event.target.value)}>
              <option value="">Borrow a layer from…</option>
              {borrowOptions.map(({ name, doc: source }) => (
                <optgroup key={name} label={name}>
                  {source.layers.map((layer) => (
                    <option key={layer.id} value={`${name}|${layer.id}`}>{layer.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button className={button} disabled={!borrow || !doc} onClick={addBorrowed} title="Add above the selected layer, at the same grid position">
              <Plus size={14} /> Add
            </button>
          </div>
        </section>

        {tool === "points" && (
          <section className="mb-4">
            <h2 className="mb-2 font-semibold uppercase tracking-wider text-slate-400">Shape</h2>
            {!shape || !shapeLayer || !shapeElement ? (
              <p className="text-slate-500">Click a shape on the canvas to edit its corners.</p>
            ) : !shapeGeometry ? (
              <p className="text-amber-300">This shape has curves; only straight-line shapes can be edited corner by corner.</p>
            ) : (
              <>
                <p className="mb-2 text-slate-300">
                  {shapeLayer.name} · shape {shape.el + 1} of {shapeLayer.elements.length} · {shapeGeometry.points.length} corners
                  {shapeGeometry.closed ? "" : " (open line)"}
                  {selectedPoints.length > 0 && <span className="text-sky-300"> · {selectedPoints.length} selected</span>}
                </p>
                {singlePoint && (
                  <div className="mb-2 grid grid-cols-2 gap-2">
                    {([0, 1] as const).map((axis) => (
                      <label key={axis}>
                        Corner {axis === 0 ? "x" : "y"}
                        <input
                          type="number" step={0.1} className={numberInput}
                          value={Math.round(singlePoint[axis] * 100) / 100}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            if (!Number.isFinite(value)) return;
                            const delta = value - singlePoint[axis];
                            nudgePoints(selectedPoints, axis === 0 ? delta : 0, axis === 1 ? delta : 0, `corner:${shape.layerId}:${shape.el}:${selectedPoints[0]}`);
                          }}
                        />
                      </label>
                    ))}
                  </div>
                )}
                <label className="mb-2 flex items-center gap-1" title="Corners of other shapes on the same spot move with the ones you drag, so faces stay joined">
                  <input type="checkbox" checked={linkCorners} onChange={(event) => setLinkCorners(event.target.checked)} />
                  Move shared corners together
                </label>
                <div className="flex flex-wrap gap-1">
                  <button className={button} disabled={selectedPoints.length === 0} onClick={deletePoints}>
                    <Trash2 size={14} /> Delete corners
                  </button>
                  <button className={button} onClick={deleteShape}>
                    <Trash2 size={14} /> Delete shape
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {selectedLayer && (
          <section className="mb-4">
            <h2 className="mb-2 font-semibold uppercase tracking-wider text-slate-400">Layer “{selectedLayer.name}”</h2>
            <div className="grid grid-cols-2 gap-2">
              {(["dx", "dy"] as const).map((axis) => (
                <label key={axis}>
                  Offset {axis === "dx" ? "x" : "y"}
                  <input
                    type="number" step={0.1} className={numberInput}
                    value={Math.round(selectedLayer[axis] * 100) / 100}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) updateLayer(selectedLayer.id, (layer) => ({ ...layer, [axis]: value }), `offset:${selectedLayer.id}`);
                    }}
                  />
                </label>
              ))}
            </div>
            <button className={`${button} mt-2`} disabled={selectedLayer.dx === 0 && selectedLayer.dy === 0}
              onClick={() => updateLayer(selectedLayer.id, (layer) => ({ ...layer, dx: 0, dy: 0 }))}>
              Reset offset
            </button>
          </section>
        )}

        {doc && (
          <section className="mb-4">
            <h2 className="mb-2 font-semibold uppercase tracking-wider text-slate-400">Placement</h2>
            <div className="grid grid-cols-2 gap-2">
              {([["footprint", 0, "Cells along i"], ["footprint", 1, "Cells along j"], ["origin", 0, "Origin x"], ["origin", 1, "Origin y"]] as const).map(
                ([field, axis, label]) => (
                  <label key={`${field}${axis}`}>
                    {label}
                    <input
                      type="number" step={field === "footprint" ? 1 : 0.1} min={field === "footprint" ? 1 : undefined}
                      className={numberInput}
                      value={doc[field][axis]}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (!Number.isFinite(value) || (field === "footprint" && value < 1)) return;
                        update((doc) => {
                          const pair = [...doc[field]] as [number, number];
                          pair[axis] = value;
                          return { ...doc, [field]: pair };
                        }, field);
                      }}
                    />
                  </label>
                ),
              )}
            </div>
            <p className="mt-1 text-slate-500">The blue diamond is the footprint; the composer puts grid point (0, 0) on the origin.</p>
          </section>
        )}

        <section className="mb-4">
          <h2 className="mb-2 font-semibold uppercase tracking-wider text-slate-400">Save as a new part</h2>
          <div className="flex gap-1">
            <input
              className="min-w-0 flex-1 rounded bg-slate-950 px-2 py-1"
              placeholder="new-part-name"
              value={saveAsName}
              onChange={(event) => setSaveAsName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            />
            <button
              className={button}
              disabled={!doc || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(saveAsName) || saveAsName in sources}
              onClick={() => void save(saveAsName)}
              title="Writes a new file with these edits and leaves this part as it is on disk"
            >
              <Save size={14} /> Save as
            </button>
          </div>
          {saveAsName in sources && <p className="mt-1 text-amber-300">That part already exists.</p>}
        </section>

        <section>
          <h2 className="mb-2 font-semibold uppercase tracking-wider text-slate-400">In a settlement</h2>
          <div className="mb-2 flex items-center gap-1">
            <select
              className="flex-1 rounded bg-slate-800 px-1 py-1"
              value={context.kind}
              onChange={(event) => setContext((context) => ({ ...context, kind: event.target.value as SettlementKind }))}
            >
              {SETTLEMENT_KINDS.map(({ kind, label }) => (
                <option key={kind} value={kind}>{label}</option>
              ))}
            </select>
            <span className="tabular-nums text-slate-400">#{context.seed}</span>
            <button className={iconButton} title="Another layout"
              onClick={() => setContext((context) => ({ ...context, seed: context.seed + 1 }))}>
              <Dices size={16} />
            </button>
          </div>
          <label className="mb-2 flex items-center gap-1">
            <input type="checkbox" checked={highlightInContext} onChange={(event) => setHighlightInContext(event.target.checked)} />
            Fade the other parts
          </label>
          <img src={contextUrl} alt="" className="w-full rounded bg-[#efe6d2]" />
          <p className="mt-1 text-slate-500">Drawn from the saved files; shows edits after Save.</p>
        </section>
      </aside>
    </div>
  );
}

/** Outline of `shape` as path data, shifted by its layer's offset. */
function outlinePath(shape: { points: readonly Point[]; closed: boolean }, dx: number, dy: number): string {
  return shape.points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x + dx} ${y + dy}`).join("") + (shape.closed ? "Z" : "");
}

/** Iso grid round the footprint, and the footprint itself, anchored on the part's origin. */
function GridOverlay({ doc }: { doc: PartDocument }) {
  const [cellsI, cellsJ] = doc.footprint;
  const [ox, oy] = doc.origin;
  const at = (i: number, j: number) => [ox + (i - j) * STEP_X, oy + (i + j) * STEP_Y] as const;
  const margin = 2;
  const lines: string[] = [];
  for (let i = -margin; i <= cellsI + margin; i++) {
    const [a, b] = [at(i, -margin), at(i, cellsJ + margin)];
    lines.push(`M${a[0]} ${a[1]}L${b[0]} ${b[1]}`);
  }
  for (let j = -margin; j <= cellsJ + margin; j++) {
    const [a, b] = [at(-margin, j), at(cellsI + margin, j)];
    lines.push(`M${a[0]} ${a[1]}L${b[0]} ${b[1]}`);
  }
  const footprint = [at(0, 0), at(cellsI, 0), at(cellsI, cellsJ), at(0, cellsJ)].map((point) => point.join(" ")).join(" ");
  return (
    <g pointerEvents="none">
      <path d={lines.join("")} stroke="#a8916e" strokeOpacity={0.45} fill="none" vectorEffect="non-scaling-stroke" />
      <polygon points={footprint} fill="#0284c7" fillOpacity={0.12} stroke="#0284c7" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <circle cx={ox} cy={oy} r={0.8} fill="#0284c7" />
    </g>
  );
}

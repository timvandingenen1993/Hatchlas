/**
 * World map for choosing a terrain download box: draw, resize by the corners
 * or move by the centre handle. Ported from the Heightmap Stitcher app.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import L from "leaflet";
import { Globe2, Mountain, Scan, SquareDashed, Tags } from "lucide-react";
import type { Map as ReferenceMap } from "maplibre-gl";
import { bboxError, MERCATOR_MAX_LAT, type BBox } from "../terrain/globalDem";
import "leaflet/dist/leaflet.css";
import "./globalDemMap.css";

type Props = {
  bbox: BBox;
  onChange: (bbox: BBox) => void;
  disabled: boolean;
  onDrawingChange: (drawing: boolean) => void;
};

const boundsOf = (bbox: BBox): L.LatLngBoundsExpression => [[bbox.south, bbox.west], [bbox.north, bbox.east]];
const limitPoint = (p: L.LatLng) => L.latLng(
  Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, p.lat)),
  Math.max(-180, Math.min(180, p.lng)),
);
const boxBetween = (a: L.LatLng, b: L.LatLng): BBox => ({
  west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng),
  south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat),
});

function ToolButton({ active, disabled, onClick, title, children }: {
  active?: boolean; disabled?: boolean; onClick: () => void; title?: string; children: ReactNode;
}) {
  return <button type="button" disabled={disabled} aria-pressed={active} onClick={onClick} title={title}
    className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[12px] disabled:cursor-not-allowed disabled:opacity-40 ${active
      ? "border-sky-500/60 bg-sky-500/15 text-sky-100"
      : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"}`}>{children}</button>;
}

export default function GlobalDemExtentMap({ bbox, onChange, disabled, onDrawingChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const selectionRef = useRef<L.Rectangle | null>(null);
  const referenceMapRef = useRef<ReferenceMap | null>(null);
  const bboxRef = useRef(bbox);
  const onChangeRef = useRef(onChange);
  const [drawing, setDrawing] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [terrain, setTerrain] = useState(true);
  const [labels, setLabels] = useState(true);
  const [referenceReady, setReferenceReady] = useState(false);
  const [referenceFallback, setReferenceFallback] = useState(false);
  const visibilityRef = useRef({ terrain, labels });
  useEffect(() => {
    visibilityRef.current = { terrain, labels };
    bboxRef.current = bbox;
    onChangeRef.current = onChange;
  });
  // A download in progress suspends drawing without forgetting the mode.
  const isDrawing = drawing && !disabled;
  useEffect(() => {
    containerRef.current?.classList.toggle("is-drawing", isDrawing);
    onDrawingChange(isDrawing);
  }, [isDrawing, onDrawingChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = L.map(container, {
      minZoom: 1, maxZoom: 18, worldCopyJump: false,
      maxBounds: [[-MERCATOR_MAX_LAT, -180], [MERCATOR_MAX_LAT, 180]],
      maxBoundsViscosity: 1,
    });
    mapRef.current = map;
    map.fitBounds(boundsOf(bboxRef.current), { padding: [48, 48], maxZoom: 11 });
    const controller = new AbortController();
    void import("./globalDemReferenceMap").then(async ({ addReferenceMap, setReferenceVisibility }) => {
      if (controller.signal.aborted) return;
      const reference = await addReferenceMap(map, controller.signal);
      referenceMapRef.current = reference;
      reference.on("error", () => setTileError(true));
      reference.on("style.load", () => {
        const { terrain, labels } = visibilityRef.current;
        setReferenceVisibility(reference, terrain, labels);
        setReferenceReady(true);
      });
    }).catch(() => {
      if (controller.signal.aborted) return;
      setReferenceFallback(true);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, noWrap: true,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).on("tileerror", () => setTileError(true)).on("load", () => setTileError(false)).addTo(map);
    });
    selectionRef.current = L.rectangle(boundsOf(bboxRef.current), {
      color: "#0284c7", weight: 2, fillOpacity: 0.06, interactive: false,
    }).addTo(map);
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      controller.abort();
      map.remove();
      mapRef.current = null;
      selectionRef.current = null;
      referenceMapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const reference = referenceMapRef.current;
    if (!reference || !referenceReady) return;
    void import("./globalDemReferenceMap").then(({ setReferenceVisibility }) => {
      if (referenceMapRef.current === reference) setReferenceVisibility(reference, terrain, labels);
    });
  }, [terrain, labels, referenceReady]);

  useEffect(() => {
    const map = mapRef.current;
    const rectangle = selectionRef.current;
    if (!map || !rectangle) return;
    if (bboxError(bbox)) {
      rectangle.setStyle({ opacity: 0, fillOpacity: 0 });
      return;
    }
    rectangle.setStyle({ opacity: 1, fillOpacity: 0.06 });
    rectangle.setBounds(boundsOf(bbox));
    const handles = L.layerGroup().addTo(map);
    if (!disabled && !isDrawing) {
      const corners: [number, number, number, number, string][] = [
        [bbox.south, bbox.west, bbox.north, bbox.east, "southwest"],
        [bbox.north, bbox.west, bbox.south, bbox.east, "northwest"],
        [bbox.north, bbox.east, bbox.south, bbox.west, "northeast"],
        [bbox.south, bbox.east, bbox.north, bbox.west, "southeast"],
      ];
      corners.forEach(([lat, lon, oppositeLat, oppositeLon, name]) => {
        const marker = L.marker([lat, lon], {
          draggable: true, autoPan: true, title: `Resize ${name} corner`,
          icon: L.divIcon({ className: "extent-handle", iconSize: [14, 14], iconAnchor: [7, 7] }),
        }).addTo(handles);
        const resizedBox = () => boxBetween(limitPoint(marker.getLatLng()), L.latLng(oppositeLat, oppositeLon));
        marker.on("drag", () => rectangle.setBounds(boundsOf(resizedBox())));
        marker.on("dragend", () => {
          const next = resizedBox();
          if (!bboxError(next)) onChangeRef.current(next);
          else rectangle.setBounds(boundsOf(bboxRef.current));
        });
      });
      const center = L.marker([(bbox.south + bbox.north) / 2, (bbox.west + bbox.east) / 2], {
        draggable: true, autoPan: true, title: "Move selection box",
        icon: L.divIcon({ className: "extent-move-handle", html: "&#10021;", iconSize: [24, 24], iconAnchor: [12, 12] }),
      }).addTo(handles);
      const movedBox = (): BBox => {
        const p = center.getLatLng();
        const dx = Math.max(-180 - bbox.west, Math.min(180 - bbox.east, p.lng - (bbox.west + bbox.east) / 2));
        const dy = Math.max(-MERCATOR_MAX_LAT - bbox.south, Math.min(MERCATOR_MAX_LAT - bbox.north, p.lat - (bbox.south + bbox.north) / 2));
        return { west: bbox.west + dx, east: bbox.east + dx, south: bbox.south + dy, north: bbox.north + dy };
      };
      center.on("drag", () => rectangle.setBounds(boundsOf(movedBox())));
      center.on("dragend", () => onChangeRef.current(movedBox()));
    }
    return () => { handles.remove(); };
  }, [bbox, disabled, isDrawing]);

  useEffect(() => {
    const map = mapRef.current, container = containerRef.current;
    if (!map || !container || !isDrawing) return;
    map.dragging.disable();
    map.touchZoom.disable();
    map.doubleClickZoom.disable();
    map.boxZoom.disable();
    map.scrollWheelZoom.disable();
    let start: L.LatLng | null = null;
    let startPixel: L.Point | null = null;
    let pointerId: number | null = null;
    const pointOf = (event: PointerEvent) => limitPoint(map.containerPointToLatLng(map.mouseEventToContainerPoint(event)));
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest(".leaflet-control")) return;
      event.preventDefault();
      start = pointOf(event);
      startPixel = map.mouseEventToContainerPoint(event);
      pointerId = event.pointerId;
      container.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!start || event.pointerId !== pointerId) return;
      event.preventDefault();
      selectionRef.current?.setBounds(boundsOf(boxBetween(start, pointOf(event))));
    };
    const up = (event: PointerEvent) => {
      if (!start || !startPixel || event.pointerId !== pointerId) return;
      const next = boxBetween(start, pointOf(event));
      const distance = startPixel.distanceTo(map.mouseEventToContainerPoint(event));
      start = null;
      if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
      if (distance > 4 && !bboxError(next)) {
        onChangeRef.current(next);
        setDrawing(false);
      } else selectionRef.current?.setBounds(boundsOf(bboxRef.current));
    };
    const cancel = () => { start = null; selectionRef.current?.setBounds(boundsOf(bboxRef.current)); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { cancel(); setDrawing(false); } };
    container.addEventListener("pointerdown", down);
    container.addEventListener("pointermove", move);
    container.addEventListener("pointerup", up);
    container.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      cancel();
      container.removeEventListener("pointerdown", down);
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerup", up);
      container.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape);
      map.dragging.enable(); map.touchZoom.enable(); map.doubleClickZoom.enable();
      map.boxZoom.enable(); map.scrollWheelZoom.enable();
    };
  }, [isDrawing]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <ToolButton active={isDrawing} disabled={disabled} onClick={() => setDrawing(!isDrawing)}>
          <SquareDashed size={13} /> {isDrawing ? "Cancel drawing" : "Draw box"}
        </ToolButton>
        <ToolButton disabled={isDrawing || !!bboxError(bbox)}
          onClick={() => mapRef.current?.fitBounds(boundsOf(bbox), { padding: [36, 36], maxZoom: 14 })}>
          <Scan size={13} /> Fit selection
        </ToolButton>
        <ToolButton disabled={isDrawing} onClick={() => mapRef.current?.setView([20, 0], 2)}><Globe2 size={13} /> World</ToolButton>
        <span className="flex-1" />
        <ToolButton active={terrain} disabled={!referenceReady || referenceFallback} onClick={() => setTerrain(!terrain)} title="Show terrain shading">
          <Mountain size={13} /> Relief
        </ToolButton>
        <ToolButton active={labels} disabled={!referenceReady || referenceFallback} onClick={() => setLabels(!labels)} title="Show map labels">
          <Tags size={13} /> Labels
        </ToolButton>
      </div>
      <div ref={containerRef} className="global-dem-map min-h-70 flex-1 rounded" aria-label="World map with the selected terrain box" />
      <p className="text-[11px] leading-snug text-slate-500">
        {isDrawing
          ? "Drag across the map to draw your area. Press Escape to cancel."
          : "Pan and zoom, then draw a box. Drag its corners to resize or its centre to move."}
      </p>
      {referenceFallback && <p className="text-[11px] text-amber-300">The relief map could not load, so the street map is shown instead.</p>}
      {tileError && <p className="text-[11px] text-amber-300">Some map tiles could not load. You can still select an area or enter coordinates.</p>}
    </div>
  );
}

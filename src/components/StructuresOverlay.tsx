/**
 * Preview overlay for structures. Towns are drawn here with the same stamp
 * code the export uses; roads are baked into the rendered frame, so the
 * overlay only adds editing aids: waypoint handles, the selected route and a
 * dashed placeholder while a road is being re-routed.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { loadIconImage, townIconUrl } from "../structures/iconStore";
import { drawTownStamp, TOWN_REFERENCE_FRAME_WIDTH } from "../structures/townStamp";
import type { StructuresEditor } from "../structures/useStructuresEditor";
import { sourceToScreen, type CameraGrid } from "../structures/viewProjection";
import type { MapPoint } from "../structures/types";

interface StructuresOverlayProps {
  editor: StructuresEditor;
  cameraGrid: CameraGrid | null;
  /** The preview canvas this overlay matches pixel for pixel. */
  sourceCanvasRef: RefObject<HTMLCanvasElement | null>;
  /** Shows handles for every road while the road tool is active. */
  roadToolActive: boolean;
}

const HANDLE_FILL = "#f8fafc";
const HANDLE_ACTIVE = "#38bdf8";
const HANDLE_STROKE = "#0f172a";

export function StructuresOverlay({
  editor,
  cameraGrid,
  sourceCanvasRef,
  roadToolActive,
}: StructuresOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [images, setImages] = useState<ReadonlyMap<string, HTMLImageElement>>(new Map());
  const { structures, routes, selection, icons, routingRoadIds, draggingRoadId } = editor;

  // Decode icons used by towns.
  useEffect(() => {
    let cancelled = false;
    const urls = new Set(structures.towns.map((town) => townIconUrl(town, icons)));
    for (const url of urls) {
      if (images.has(url)) continue;
      loadIconImage(url)
        .then((image) => {
          if (!cancelled) setImages((previous) => new Map(previous).set(url, image));
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [structures.towns, icons, images]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const source = sourceCanvasRef.current;
    if (!canvas || !source) return;
    const { width, height } = source;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    // Keep handles a constant size on screen regardless of zoom.
    const rect = canvas.getBoundingClientRect();
    const pixelsPerCss = rect.width > 0 ? width / rect.width : 1;
    const toCanvas = (point: MapPoint) => {
      const screen = sourceToScreen(cameraGrid, point);
      return { x: screen.x * width, y: screen.y * height };
    };

    const selectedRoadId = selection?.kind === "road" ? selection.id : null;
    for (const road of structures.roads) {
      if (!road.visible) continue;
      const selected = road.id === selectedRoadId;
      const route = routes[road.id];
      const stale = !route || routingRoadIds.has(road.id) || draggingRoadId === road.id;
      if (stale && road.waypoints.length >= 2 && (selected || roadToolActive)) {
        context.save();
        context.setLineDash([6 * pixelsPerCss, 5 * pixelsPerCss]);
        context.strokeStyle = "rgba(15, 23, 42, 0.75)";
        context.lineWidth = 2 * pixelsPerCss;
        context.beginPath();
        road.waypoints.forEach((waypoint, index) => {
          const point = toCanvas(waypoint);
          if (index === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        });
        context.stroke();
        context.restore();
      } else if (route && selected) {
        context.save();
        context.strokeStyle = "rgba(56, 189, 248, 0.6)";
        context.lineWidth = 3 * pixelsPerCss;
        context.lineJoin = "round";
        context.beginPath();
        route.points.forEach((routePoint, index) => {
          const point = toCanvas(routePoint);
          if (index === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        });
        context.stroke();
        context.restore();
      }
      if (!roadToolActive && !selected) continue;
      for (const waypoint of road.waypoints) {
        const point = toCanvas(waypoint);
        const active = selection?.waypointId === waypoint.id;
        const radius = (selected ? 5.5 : 3.5) * pixelsPerCss;
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fillStyle = active ? HANDLE_ACTIVE : HANDLE_FILL;
        context.fill();
        context.lineWidth = 1.5 * pixelsPerCss;
        context.strokeStyle = HANDLE_STROKE;
        context.stroke();
      }
    }

    const stampScale = Math.max(width, height) / TOWN_REFERENCE_FRAME_WIDTH;
    for (const town of structures.towns) {
      const image = images.get(townIconUrl(town, icons)) ?? null;
      const point = toCanvas(town);
      drawTownStamp(context, town, image, point.x, point.y, stampScale, editor.townStyle);
      if (selection?.kind === "town" && selection.id === town.id) {
        context.beginPath();
        context.arc(point.x, point.y, (town.size * stampScale) * 0.62 + 3 * pixelsPerCss, 0, Math.PI * 2);
        context.setLineDash([4 * pixelsPerCss, 3 * pixelsPerCss]);
        context.strokeStyle = HANDLE_ACTIVE;
        context.lineWidth = 2 * pixelsPerCss;
        context.stroke();
        context.setLineDash([]);
      }
    }
  });

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none w-full h-full"
      aria-hidden="true"
    />
  );
}

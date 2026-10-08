/**
 * State and interaction for the Structures tab: roads, towns, their
 * persistence, off-thread road routing, and pointer editing on the map.
 *
 * Pointer handlers work in client pixels through a projector supplied by the
 * studio, so hit radii stay constant on screen at any zoom and in the tilted
 * terrain camera.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MountainDEMData } from "../terrain/mountainBaseDEM";
import { generatePOIName } from "../utils/fantasyNames";
import {
  BUILTIN_ICONS,
  DEFAULT_TOWN_ICON_ID,
  deleteUploadedIcon,
  loadIconImage,
  loadUploadedIcons,
  saveUploadedIcon,
  townIconUrl,
} from "./iconStore";
import { rasterizeTownStamp, TOWN_REFERENCE_FRAME_WIDTH, type TownStampRaster } from "./townStamp";
import type { RoadRoutingRequest, RoadRoutingResponse } from "./roadRouting.worker";
import type { VegetationCoverGrid } from "./roadRouting";
import {
  heightmapStructureKey,
  loadStoredStructures,
  saveStoredStructures,
  type StoredStructures,
} from "./structureStore";
import {
  createStructureId,
  DEFAULT_TOWN_SIZE,
  type IconAsset,
  type MapPoint,
  type MapStructures,
  type Road,
  type RoadRoute,
  type RoadStyle,
  type RoutingSettings,
  settlementOfIcon,
  type StructureRenderOptions,
  type Town,
  type TownStyle,
  type Waypoint,
} from "./types";

/** "select" only picks and drags existing structures; it never creates. */
export type StructureTool = "road" | "town" | "select";

export interface StructureSelection {
  kind: "road" | "town";
  id: string;
  waypointId?: string;
}

export interface ScreenProjector {
  /** Client-pixel position of a map point. */
  project(point: MapPoint): { x: number; y: number };
  /** Map point under a client-pixel position, or null off the terrain. */
  unproject(clientX: number, clientY: number): MapPoint | null;
  /** Client pixels per pixel of the 2048px reference frame. */
  referenceScale: number;
}

interface DragState {
  kind: "waypoint" | "town";
  roadId?: string;
  id: string;
}

const HANDLE_HIT_PX = 10;
const LINE_HIT_PX = 7;
const SAVE_DELAY_MS = 400;

function distanceToSegment(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function routeSignature(road: Road, routing: RoutingSettings, terrainRevision: number): string {
  return JSON.stringify([terrainRevision, road.kind, road.waypoints.map((point) => [point.u, point.v]), routing]);
}

const EMPTY_STRUCTURES: MapStructures = { roads: [], towns: [] };

/** Visible water surface published by the preview worker. */
export interface RoutingWaterSurface {
  width: number;
  height: number;
  visualWaterMask: Uint8Array;
  wetlandPoolMask: Uint8Array;
}

/**
 * Inland water the renderer draws: routed channels above the river threshold,
 * braided gravel channels and, from the preview's water snapshot, wetland
 * pools. Ocean is excluded here; the router blocks it separately.
 */
function crossableWaterMask(
  dem: MountainDEMData,
  riverThresholdKm2: number,
  water: RoutingWaterSurface | null | undefined,
): Uint8Array {
  const mask = new Uint8Array(dem.width * dem.height);
  if (water && water.width === dem.width && water.height === dem.height) {
    for (let index = 0; index < mask.length; index++) {
      if (water.visualWaterMask[index] === 1 && dem.isOcean[index] !== 1) mask[index] = 1;
    }
    return mask;
  }
  const threshold = Math.max(0.001, riverThresholdKm2);
  for (let index = 0; index < mask.length; index++) {
    if (dem.biomeType[index] === 6) {
      mask[index] = 1;
      continue;
    }
    if (dem.isRiverChannel[index] !== 1) continue;
    const area = dem.rainfallWeightedAreaKm2?.[index] ?? dem.drainageAreaKm2[index] ?? 0;
    if (area >= threshold) mask[index] = 1;
  }
  return mask;
}

export interface StructuresEditorOptions {
  dem: MountainDEMData | null;
  analysisRevision: number;
  heightmapSourceName: string;
  riverThresholdKm2: number;
  /** Visible water from the preview; without it routing uses DEM channels only. */
  waterSurface?: RoutingWaterSurface | null;
  /** Placed forest and shrub stands from the preview, for forest avoidance. */
  vegetationCover?: VegetationCoverGrid | null;
}

export function useStructuresEditor({
  dem,
  analysisRevision,
  heightmapSourceName,
  riverThresholdKm2,
  waterSurface,
  vegetationCover,
}: StructuresEditorOptions) {
  const [initialStored] = useState(loadStoredStructures);
  // Every heightmap keeps its own structures; switching sources swaps them.
  const [maps, setMaps] = useState<Record<string, MapStructures>>(initialStored.maps);
  const [routing, setRouting] = useState<RoutingSettings>(initialStored.routing);
  const [roadStyle, setRoadStyle] = useState<RoadStyle>(initialStored.roadStyle);
  const [townStyle, setTownStyle] = useState<TownStyle>(initialStored.townStyle);
  const mapKey = heightmapStructureKey(heightmapSourceName);
  const structures = maps[mapKey] ?? EMPTY_STRUCTURES;
  const setStructures = useCallback((update: (previous: MapStructures) => MapStructures) => {
    setMaps((previous) => ({ ...previous, [mapKey]: update(previous[mapKey] ?? EMPTY_STRUCTURES) }));
  }, [mapKey]);
  const [selection, setSelection] = useState<StructureSelection | null>(null);
  const [routes, setRoutes] = useState<Record<string, { route: RoadRoute; signature: string }>>({});
  const [storageError, setStorageError] = useState<string | null>(null);
  const [uploadedIcons, setUploadedIcons] = useState<IconAsset[]>([]);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [terrainRevision, setTerrainRevision] = useState(-1);

  // Debounced persistence; empty maps are dropped from storage.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored: StoredStructures = { version: 1, maps: {}, routing, roadStyle, townStyle };
      for (const [key, value] of Object.entries(maps)) {
        if (value.roads.length > 0 || value.towns.length > 0) stored.maps[key] = value;
      }
      setStorageError(saveStoredStructures(stored));
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [maps, routing, roadStyle, townStyle]);

  // Icon library.
  useEffect(() => {
    let cancelled = false;
    loadUploadedIcons()
      .then((icons) => { if (!cancelled) setUploadedIcons(icons); })
      .catch(() => { if (!cancelled) setStorageError("Could not read uploaded town icons."); });
    return () => { cancelled = true; };
  }, []);
  const icons = useMemo(() => [...BUILTIN_ICONS, ...uploadedIcons], [uploadedIcons]);

  const uploadIcon = useCallback(async (file: File): Promise<IconAsset | null> => {
    try {
      const icon = await saveUploadedIcon(file);
      setUploadedIcons((previous) => [...previous, icon]);
      return icon;
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Could not store the icon.");
      return null;
    }
  }, []);

  const removeIcon = useCallback(async (id: string) => {
    try {
      await deleteUploadedIcon(id);
      setUploadedIcons((previous) => {
        const removed = previous.find((icon) => icon.id === id);
        if (removed) URL.revokeObjectURL(removed.url);
        return previous.filter((icon) => icon.id !== id);
      });
      setMaps((previous) => Object.fromEntries(Object.entries(previous).map(([key, value]) => [key, {
        ...value,
        towns: value.towns.map((town) => town.iconId === id ? { ...town, iconId: DEFAULT_TOWN_ICON_ID } : town),
      }])));
    } catch {
      setStorageError("Could not delete the icon.");
    }
  }, []);

  // Routing worker.
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const inFlightRef = useRef(new Map<string, { requestId: number; signature: string }>());
  useEffect(() => {
    const worker = new Worker(new URL("./roadRouting.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<RoadRoutingResponse>) => {
      const response = event.data;
      if (response.type === "terrainReady") {
        setTerrainRevision(response.revision);
        return;
      }
      const roadId = response.roadId;
      if (!roadId) return;
      const request = inFlightRef.current.get(roadId);
      if (!request || request.requestId !== response.requestId) return;
      inFlightRef.current.delete(roadId);
      if (response.type === "route") {
        setRoutes((previous) => ({
          ...previous,
          [roadId]: { route: response.route, signature: request.signature },
        }));
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || !dem) return;
    const message: RoadRoutingRequest = {
      type: "setTerrain",
      revision: analysisRevision,
      dem: {
        width: dem.width,
        height: dem.height,
        dxMeters: dem.dxMeters,
        dyMeters: dem.dyMeters,
        elevation: dem.elevation,
        isRiverChannel: crossableWaterMask(dem, riverThresholdKm2, waterSurface),
        strahlerOrder: dem.strahlerOrder,
        isOcean: dem.isOcean,
        biomeType: dem.biomeType,
        lakeDepthM: dem.lakeDepthM,
        wetlandPoolMask: waterSurface?.width === dem.width && waterSurface.height === dem.height
          ? waterSurface.wetlandPoolMask
          : dem.wetlandPoolMask,
        vegetationCover,
      },
    };
    worker.postMessage(message);
    inFlightRef.current.clear();
  }, [dem, analysisRevision, riverThresholdKm2, waterSurface, vegetationCover]);

  // A route is current when it was computed for this terrain, these waypoints
  // and these settings; anything else is re-routed.
  const signatures = useMemo(() => {
    const result = new Map<string, string>();
    for (const road of structures.roads) {
      if (road.waypoints.length >= 2) result.set(road.id, routeSignature(road, routing, analysisRevision));
    }
    return result;
  }, [structures.roads, routing, analysisRevision]);

  const routingRoadIds = useMemo(() => {
    const pending = new Set<string>();
    for (const [roadId, signature] of signatures) {
      if (routes[roadId]?.signature !== signature) pending.add(roadId);
    }
    return pending as ReadonlySet<string>;
  }, [signatures, routes]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || terrainRevision !== analysisRevision) return;
    for (const road of structures.roads) {
      const signature = signatures.get(road.id);
      if (!signature || !routingRoadIds.has(road.id) || dragging?.roadId === road.id) continue;
      if (inFlightRef.current.get(road.id)?.signature === signature) continue;
      const requestId = ++requestIdRef.current;
      inFlightRef.current.set(road.id, { requestId, signature });
      const message: RoadRoutingRequest = {
        type: "route",
        requestId,
        revision: terrainRevision,
        roadId: road.id,
        kind: road.kind,
        waypoints: road.waypoints.map(({ u, v }) => ({ u, v })),
        settings: routing,
      };
      worker.postMessage(message);
    }
  }, [structures.roads, signatures, routingRoadIds, routing, terrainRevision, analysisRevision, dragging]);

  // The last route stays on the map while a road is being re-routed.
  const liveRoutes = useMemo(() => {
    const result: Record<string, RoadRoute> = {};
    for (const roadId of signatures.keys()) {
      if (routes[roadId]) result[roadId] = routes[roadId].route;
    }
    return result;
  }, [signatures, routes]);

  // Only route results and road styles change the rendered map, so dragging
  // a waypoint does not restart the preview render on every mouse move.
  const roadStyleKey = JSON.stringify(structures.roads.map((road) =>
    [road.id, road.visible, road.kind, road.color ?? null, road.lineStyle ?? "auto", road.widthScale ?? 1]));
  const renderOptions = useMemo<StructureRenderOptions | undefined>(() => {
    const styles = JSON.parse(roadStyleKey) as
      [string, boolean, Road["kind"], string | null, NonNullable<Road["lineStyle"]>, number][];
    const roads = styles
      .filter(([id, visible]) => visible && liveRoutes[id])
      .map(([id, , kind, color, lineStyle, widthScale]) => ({
        points: liveRoutes[id].points,
        bridges: liveRoutes[id].bridges,
        kind,
        color: color ?? undefined,
        lineStyle,
        widthScale,
      }));
    return roads.length > 0 ? { roads, style: roadStyle } : undefined;
  }, [roadStyleKey, liveRoutes, roadStyle]);

  /** Towns pre-rendered for an export whose long edge is `longEdge` pixels. */
  const buildTownStamps = useCallback(async (longEdge: number): Promise<TownStampRaster[]> => {
    const scale = longEdge / TOWN_REFERENCE_FRAME_WIDTH;
    const stamps: TownStampRaster[] = [];
    for (const town of structures.towns) {
      const image = await loadIconImage(townIconUrl(town, icons)).catch(() => null);
      const stamp = rasterizeTownStamp(town, image, scale, townStyle);
      if (stamp) stamps.push(stamp);
    }
    return stamps;
  }, [structures.towns, icons, townStyle]);

  // Mutations.
  const updateRoad = useCallback((id: string, patch: Partial<Road>) => {
    setStructures((previous) => ({
      ...previous,
      roads: previous.roads.map((road) => road.id === id ? { ...road, ...patch } : road),
    }));
  }, [setStructures]);

  const updateTown = useCallback((id: string, patch: Partial<Town>) => {
    setStructures((previous) => ({
      ...previous,
      towns: previous.towns.map((town) => town.id === id ? { ...town, ...patch } : town),
    }));
  }, [setStructures]);

  const deleteRoad = useCallback((id: string) => {
    setStructures((previous) => ({ ...previous, roads: previous.roads.filter((road) => road.id !== id) }));
    setSelection((previous) => previous?.id === id ? null : previous);
  }, [setStructures]);

  const deleteTown = useCallback((id: string) => {
    setStructures((previous) => ({ ...previous, towns: previous.towns.filter((town) => town.id !== id) }));
    setSelection((previous) => previous?.id === id ? null : previous);
  }, [setStructures]);

  const createRoad = useCallback((firstPoint?: MapPoint): Road => {
    const road: Road = {
      id: createStructureId("road"),
      name: `Road ${structures.roads.length + 1}`,
      kind: "road",
      waypoints: firstPoint ? [{ id: createStructureId("wp"), u: firstPoint.u, v: firstPoint.v }] : [],
      visible: true,
    };
    setStructures((previous) => ({ ...previous, roads: [...previous.roads, road] }));
    setSelection({ kind: "road", id: road.id, waypointId: road.waypoints[0]?.id });
    return road;
  }, [structures.roads.length, setStructures]);

  const createTown = useCallback((point: MapPoint): Town => {
    const seed = Math.floor(Math.random() * 1e9);
    const town: Town = {
      id: createStructureId("town"),
      name: generatePOIName("town", seed),
      u: point.u,
      v: point.v,
      iconId: DEFAULT_TOWN_ICON_ID,
      seed,
      size: settlementOfIcon(DEFAULT_TOWN_ICON_ID)?.defaultSize ?? DEFAULT_TOWN_SIZE,
      labelPosition: "below",
      showLabel: true,
    };
    setStructures((previous) => ({ ...previous, towns: [...previous.towns, town] }));
    setSelection({ kind: "town", id: town.id });
    return town;
  }, [setStructures]);

  const removeSelectedWaypoint = useCallback((): boolean => {
    if (selection?.kind !== "road" || !selection.waypointId) return false;
    const { id, waypointId } = selection;
    setStructures((previous) => ({
      ...previous,
      roads: previous.roads.map((road) => road.id === id
        ? { ...road, waypoints: road.waypoints.filter((point) => point.id !== waypointId) }
        : road),
    }));
    setSelection({ kind: "road", id });
    return true;
  }, [selection, setStructures]);

  // Pointer editing.
  const nearestRouteIndex = (route: RoadRoute, point: MapPoint): number => {
    let best = 0;
    let bestDistance = Infinity;
    route.points.forEach((candidate, index) => {
      const distance = (candidate.u - point.u) ** 2 + (candidate.v - point.v) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  };

  const pointerDown = useCallback((
    tool: StructureTool,
    clientX: number,
    clientY: number,
    projector: ScreenProjector,
  ): boolean => {
    const point = projector.unproject(clientX, clientY);
    const selectedRoadId = selection?.kind === "road" ? selection.id : null;
    const orderedRoads = [...structures.roads].sort((a, b) =>
      (a.id === selectedRoadId ? -1 : 0) - (b.id === selectedRoadId ? -1 : 0));

    // Nearest town whose icon is under the pointer.
    const hitTown = (): Town | null => {
      let hit: Town | null = null;
      let hitDistance = Infinity;
      for (const town of structures.towns) {
        const screen = projector.project(town);
        const distance = Math.hypot(screen.x - clientX, screen.y - clientY);
        const radius = Math.max(HANDLE_HIT_PX + 2, town.size * projector.referenceScale * 0.55);
        if (distance <= radius && distance < hitDistance) {
          hit = town;
          hitDistance = distance;
        }
      }
      return hit;
    };
    // Waypoint handle under the pointer, the selected road first.
    const hitWaypoint = (): { road: Road; waypoint: Waypoint } | null => {
      for (const road of orderedRoads) {
        if (!road.visible) continue;
        for (const waypoint of road.waypoints) {
          const screen = projector.project(waypoint);
          if (Math.hypot(screen.x - clientX, screen.y - clientY) <= HANDLE_HIT_PX) return { road, waypoint };
        }
      }
      return null;
    };
    const hitRoadLine = (): Road | null => {
      for (const road of orderedRoads) {
        const route = liveRoutes[road.id];
        if (!road.visible || !route) continue;
        let previous = projector.project(route.points[0]);
        for (let index = 1; index < route.points.length; index++) {
          const next = projector.project(route.points[index]);
          if (distanceToSegment(clientX, clientY, previous.x, previous.y, next.x, next.y) <= LINE_HIT_PX) return road;
          previous = next;
        }
      }
      return null;
    };
    const grabTown = (town: Town) => {
      setSelection({ kind: "town", id: town.id });
      setDragging({ kind: "town", id: town.id });
    };
    const grabWaypoint = ({ road, waypoint }: { road: Road; waypoint: Waypoint }) => {
      setSelection({ kind: "road", id: road.id, waypointId: waypoint.id });
      setDragging({ kind: "waypoint", roadId: road.id, id: waypoint.id });
    };

    if (tool === "select") {
      const town = hitTown();
      if (town) {
        grabTown(town);
        return true;
      }
      const handle = hitWaypoint();
      if (handle) {
        grabWaypoint(handle);
        return true;
      }
      const road = hitRoadLine();
      if (road) {
        setSelection({ kind: "road", id: road.id });
        return true;
      }
      setSelection(null);
      return false;
    }

    if (tool === "town") {
      const town = hitTown();
      if (town) {
        grabTown(town);
        return true;
      }
      if (!point) return false;
      const created = createTown(point);
      setDragging({ kind: "town", id: created.id });
      return true;
    }

    // Road tool: handles first, then the routed line. On the selected road a
    // line click inserts a waypoint to steer it; on another road it selects it.
    const handle = hitWaypoint();
    if (handle) {
      grabWaypoint(handle);
      return true;
    }
    const lineRoad = hitRoadLine();
    if (lineRoad) {
      const route = liveRoutes[lineRoad.id];
      if (lineRoad.id !== selectedRoadId || !point || !route) {
        setSelection({ kind: "road", id: lineRoad.id });
        return true;
      }
      const clickedIndex = nearestRouteIndex(route, point);
      const waypointIndices = lineRoad.waypoints.map((waypoint) => nearestRouteIndex(route, waypoint));
      let insertAt = lineRoad.waypoints.length - 1;
      for (let index = 0; index + 1 < waypointIndices.length; index++) {
        if (clickedIndex >= waypointIndices[index] && clickedIndex <= waypointIndices[index + 1]) {
          insertAt = index + 1;
          break;
        }
      }
      const waypoint: Waypoint = { id: createStructureId("wp"), u: point.u, v: point.v };
      updateRoad(lineRoad.id, {
        waypoints: [...lineRoad.waypoints.slice(0, insertAt), waypoint, ...lineRoad.waypoints.slice(insertAt)],
      });
      grabWaypoint({ road: lineRoad, waypoint });
      return true;
    }
    if (!point) return false;
    const selectedRoad = structures.roads.find((road) => road.id === selectedRoadId);
    if (selectedRoad) {
      const waypoint: Waypoint = { id: createStructureId("wp"), u: point.u, v: point.v };
      updateRoad(selectedRoad.id, { waypoints: [...selectedRoad.waypoints, waypoint] });
      grabWaypoint({ road: selectedRoad, waypoint });
      return true;
    }
    const road = createRoad(point);
    setDragging({ kind: "waypoint", roadId: road.id, id: road.waypoints[0].id });
    return true;
  }, [structures, selection, liveRoutes, createRoad, createTown, updateRoad]);

  const pointerMove = useCallback((clientX: number, clientY: number, projector: ScreenProjector): boolean => {
    if (!dragging) return false;
    const point = projector.unproject(clientX, clientY);
    if (!point) return true;
    if (dragging.kind === "town") {
      updateTown(dragging.id, { u: point.u, v: point.v });
    } else if (dragging.roadId) {
      const roadId = dragging.roadId;
      setStructures((previous) => ({
        ...previous,
        roads: previous.roads.map((road) => road.id === roadId
          ? {
              ...road,
              waypoints: road.waypoints.map((waypoint) =>
                waypoint.id === dragging.id ? { ...waypoint, u: point.u, v: point.v } : waypoint),
            }
          : road),
      }));
    }
    return true;
  }, [dragging, updateTown, setStructures]);

  const pointerUp = useCallback((): boolean => {
    if (!dragging) return false;
    setDragging(null);
    return true;
  }, [dragging]);

  /** Keyboard editing; returns true when the key was used. */
  const keyDown = useCallback((key: string): boolean => {
    if (key === "Delete" || key === "Backspace") {
      if (removeSelectedWaypoint()) return true;
      if (selection?.kind === "town") {
        deleteTown(selection.id);
        return true;
      }
      return false;
    }
    if (key === "Escape" || key === "Enter") {
      if (!selection) return false;
      setSelection(null);
      return true;
    }
    return false;
  }, [removeSelectedWaypoint, selection, deleteTown]);

  return {
    structures,
    routes: liveRoutes,
    routingRoadIds,
    routing,
    setRouting,
    roadStyle,
    setRoadStyle,
    townStyle,
    setTownStyle,
    selection,
    setSelection,
    dragging: dragging !== null,
    draggingRoadId: dragging?.roadId ?? null,
    icons,
    uploadIcon,
    removeIcon,
    storageError,
    clearStorageError: () => setStorageError(null),
    renderOptions,
    buildTownStamps,
    createRoad,
    updateRoad,
    deleteRoad,
    updateTown,
    deleteTown,
    pointerDown,
    pointerMove,
    pointerUp,
    keyDown,
  };
}

export type StructuresEditor = ReturnType<typeof useStructuresEditor>;

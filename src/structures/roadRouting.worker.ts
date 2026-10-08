/// <reference lib="webworker" />
/**
 * Off-thread road routing. The studio sends the analysed terrain once per
 * analysis revision, then one request per road. Segment routes (consecutive
 * waypoint pairs) are cached, so moving one waypoint only re-routes the two
 * segments that touch it.
 */
import {
  buildRoutingTerrain,
  resolveRoutingParams,
  routeRoad,
  routeSegment,
  type RoutingDemFields,
  type RoutingTerrain,
  type SegmentRoute,
} from "./roadRouting";
import type { MapPoint, RoadKind, RoadRoute, RoutingSettings } from "./types";

export type RoadRoutingRequest =
  | { type: "setTerrain"; revision: number; dem: RoutingDemFields }
  | {
      type: "route";
      requestId: number;
      revision: number;
      roadId: string;
      kind: RoadKind;
      waypoints: MapPoint[];
      settings: RoutingSettings;
    };

export type RoadRoutingResponse =
  | { type: "terrainReady"; revision: number }
  | { type: "route"; requestId: number; revision: number; roadId: string; route: RoadRoute }
  | { type: "error"; requestId?: number; roadId?: string; message: string };

const SEGMENT_CACHE_LIMIT = 500;

let terrain: RoutingTerrain | null = null;
let terrainRevision = -1;
const segmentCache = new Map<string, SegmentRoute>();

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(message: RoadRoutingResponse): void {
  scope.postMessage(message);
}

scope.onmessage = (event: MessageEvent<RoadRoutingRequest>) => {
  const request = event.data;
  if (request.type === "setTerrain") {
    terrain = buildRoutingTerrain(request.dem);
    terrainRevision = request.revision;
    segmentCache.clear();
    post({ type: "terrainReady", revision: request.revision });
    return;
  }
  if (!terrain || request.revision !== terrainRevision) {
    post({ type: "error", requestId: request.requestId, roadId: request.roadId, message: "Terrain is not ready" });
    return;
  }
  try {
    const activeTerrain = terrain;
    const params = resolveRoutingParams(request.settings, request.kind);
    const paramsKey = JSON.stringify(params);
    const route = routeRoad(activeTerrain, request.waypoints, params, (from, to) => {
      const key = `${from.u},${from.v}>${to.u},${to.v}|${paramsKey}`;
      const cached = segmentCache.get(key);
      if (cached) {
        // Refresh recency for the simple insertion-ordered LRU.
        segmentCache.delete(key);
        segmentCache.set(key, cached);
        return cached;
      }
      const segment = routeSegment(activeTerrain, from, to, params);
      segmentCache.set(key, segment);
      if (segmentCache.size > SEGMENT_CACHE_LIMIT) {
        segmentCache.delete(segmentCache.keys().next().value!);
      }
      return segment;
    });
    post({
      type: "route",
      requestId: request.requestId,
      revision: request.revision,
      roadId: request.roadId,
      route,
    });
  } catch (error) {
    post({
      type: "error",
      requestId: request.requestId,
      roadId: request.roadId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

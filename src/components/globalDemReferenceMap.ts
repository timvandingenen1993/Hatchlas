/**
 * Reference map for the global terrain picker: muted OpenFreeMap cartography
 * with Mapterhorn relief, drawn by MapLibre inside a Leaflet map.
 */
import { maplibreGL } from "@maplibre/maplibre-gl-leaflet";
import { setWorkerUrl, type Map, type StyleSpecification } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type L from "leaflet";
import "maplibre-gl/dist/maplibre-gl.css";

setWorkerUrl(workerUrl);

const TERRAIN_LAYER = "reference-hillshade";
const attribution = '<a href="https://openfreemap.org/">OpenFreeMap</a> · '
  + '<a href="https://www.openmaptiles.org/">© OpenMapTiles</a> · '
  + '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> · '
  + '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>';

export function setReferenceVisibility(map: Map, terrain: boolean, labels: boolean) {
  for (const layer of map.getStyle().layers) {
    if (layer.id === TERRAIN_LAYER) {
      map.setLayoutProperty(layer.id, "visibility", terrain ? "visible" : "none");
    } else if (layer.type === "symbol" && layer.layout?.["text-field"] !== undefined) {
      map.setLayoutProperty(layer.id, "visibility", labels ? "visible" : "none");
    }
  }
}

export async function addReferenceMap(map: L.Map, signal: AbortSignal) {
  const response = await fetch("https://tiles.openfreemap.org/styles/positron", { signal });
  if (!response.ok) throw new Error("The reference map style could not load.");
  const style: StyleSpecification = await response.json();
  signal.throwIfAborted();
  style.sources["reference-elevation"] = {
    type: "raster-dem",
    url: "https://tiles.mapterhorn.com/tilejson.json",
    encoding: "terrarium",
    tileSize: 512,
    attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
  };
  // Put relief above land and roads, but below the readable vector labels.
  const firstLabel = style.layers.findIndex(layer => layer.type === "symbol");
  style.layers.splice(firstLabel < 0 ? style.layers.length : firstLabel, 0, {
    id: TERRAIN_LAYER,
    type: "hillshade",
    source: "reference-elevation",
    paint: {
      "hillshade-exaggeration": 0.45,
      "hillshade-shadow-color": "#596353",
      "hillshade-highlight-color": "#fffbea",
      "hillshade-accent-color": "#7b826c",
      "hillshade-illumination-direction": 315,
      "hillshade-illumination-anchor": "map",
    },
  });
  const layer = maplibreGL({
    style,
    renderWorldCopies: false,
    attributionControl: { customAttribution: attribution },
  });
  try {
    layer.addTo(map);
  } catch (error) {
    // Failed WebGL initialization can leave a partially attached Leaflet layer.
    // Detach it without invoking the adapter's cleanup on an uninitialized map.
    layer.onRemove = () => { layer.getContainer()?.remove(); return layer; };
    if (map.hasLayer(layer)) map.removeLayer(layer);
    throw error;
  }
  return layer.getMaplibreMap();
}

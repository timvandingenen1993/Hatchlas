/**
 * Places raster props on several workers at once.
 *
 * Each biome is placed independently (own collision grid and candidates), so
 * groups of biomes run side by side and the per-biome lists are joined in
 * placement order: the result equals one sequential pass. One group runs on
 * the calling worker while the others run on a small persistent sub-pool.
 */
import type { MountainDEMData } from "../terrain/mountainBaseDEM";
import type { MountainProfiler } from "./mountainProfiler";
import {
  buildPropStandsForBuckets,
  finishPropStands,
  placeRasterPropsInBiomes,
  propStandSizes,
  rasterPropPlacementBiomes,
  type VegetationGeometry,
  type VegetationPatternOptions,
  type VegetationPropStand,
  type VegetationRasterPropPlacement,
} from "./vegetationRenderer";

const MAX_PLACEMENT_HELPERS = 3;

interface PlacementReply {
  id: number;
  lists?: VegetationRasterPropPlacement[][];
  stands?: VegetationPropStand[];
  error?: string;
}

let helpers: Worker[] | undefined;
let nextId = 1;
/**
 * The DEM each helper last received. A helper keeps it for the stand step of
 * the same render, so the ~150 MB snapshot is not copied to it twice.
 */
const demOnHelper = new WeakMap<Worker, MountainDEMData>();

function placementHelpers(): Worker[] {
  if (helpers) return helpers;
  helpers = [];
  if (typeof Worker === "undefined") return helpers;
  const threads = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 1 : 1;
  // The preview already runs a main, a water, a flow and a props worker.
  const count = Math.max(0, Math.min(MAX_PLACEMENT_HELPERS, Math.floor(threads / 2) - 2));
  for (let index = 0; index < count; index++) {
    try {
      helpers.push(new Worker(new URL("./vegetationPlacement.worker.ts", import.meta.url), { type: "module" }));
    } catch {
      break;
    }
  }
  return helpers;
}

/**
 * Starts the helpers ahead of the first placement: each loads the whole
 * vegetation module, which on a cold load otherwise lands on the props
 * critical path.
 */
export function warmPlacementHelpers(): void {
  placementHelpers();
}

/** Sends one job to a helper; resolves with its reply. */
function askHelper(worker: Worker, message: Record<string, unknown>): Promise<PlacementReply> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<PlacementReply>): void => {
      if (event.data?.id !== id) return;
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (event.data.error === undefined) resolve(event.data);
      else reject(new Error(event.data.error));
    };
    const onError = (event: ErrorEvent): void => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      reject(new Error(event.message || "Prop placement helper failed"));
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ ...message, id });
  });
}

async function placeOnHelper(
  worker: Worker,
  dem: MountainDEMData,
  options: VegetationPatternOptions | undefined,
  biomes: number[],
): Promise<VegetationRasterPropPlacement[][]> {
  demOnHelper.set(worker, dem);
  const reply = await askHelper(worker, { dem, options, biomes, keepDem: true });
  if (!reply.lists) throw new Error("Prop placement helper failed");
  return reply.lists;
}

/**
 * Splits biomes into `groups` sets of about equal work: biome area times the
 * number of prop kinds placed there, longest first onto the lightest set.
 */
export function groupBiomesForPlacement(
  biomeType: ArrayLike<number>,
  biomes: readonly number[],
  assetsPerBiome: ReadonlyMap<number, number>,
  groups: number,
): number[][] {
  const cells = new Map<number, number>();
  for (let index = 0; index < biomeType.length; index++) {
    const biome = biomeType[index];
    cells.set(biome, (cells.get(biome) ?? 0) + 1);
  }
  const weighted = biomes
    .map(biome => ({ biome, work: (cells.get(biome) ?? 0) * (assetsPerBiome.get(biome) ?? 1) + 1 }))
    .sort((a, b) => b.work - a.work);
  const sets = Array.from({ length: Math.max(1, groups) }, () => ({ biomes: [] as number[], work: 0 }));
  for (const { biome, work } of weighted) {
    const lightest = sets.reduce((best, set) => (set.work < best.work ? set : best));
    lightest.biomes.push(biome);
    lightest.work += work;
  }
  return sets.map(set => set.biomes).filter(set => set.length > 0);
}

/**
 * All raster prop placements, placed in parallel, joined in placement order;
 * undefined when there is nothing to split (the caller places them itself).
 */
export async function placeRasterPropsInParallel(
  dem: MountainDEMData,
  options: VegetationPatternOptions | undefined,
  profiler?: MountainProfiler,
): Promise<VegetationRasterPropPlacement[] | undefined> {
  const biomes = rasterPropPlacementBiomes(options);
  const pool = placementHelpers();
  if (biomes.length < 2 || pool.length === 0) return undefined;
  const stop = profiler?.begin("vegetation parallel raster prop placement");
  try {
    const assetsPerBiome = new Map<number, number>();
    for (const asset of options?.rasterPropAssets ?? []) {
      for (const biome of asset.eligibleBiomeIds) assetsPerBiome.set(biome, (assetsPerBiome.get(biome) ?? 0) + 1);
    }
    const groups = groupBiomesForPlacement(dem.biomeType, biomes, assetsPerBiome, pool.length + 1);
    profiler?.recordMetric("vegetation prop placement groups", groups.length, "groups");
    // Hand the other groups out first, then place the first one here.
    const remote = groups.slice(1).map((group, index) =>
      placeOnHelper(pool[index], dem, options, group)
        // A failed helper's biomes are placed here instead.
        .catch(() => placeRasterPropsInBiomes(dem, options, group)));
    const local = placeRasterPropsInBiomes(dem, options, groups[0], profiler);
    const lists = [local, ...await Promise.all(remote)];
    const byBiome = new Map<number, VegetationRasterPropPlacement[]>();
    groups.forEach((group, groupIndex) => {
      group.forEach((biome, index) => byBiome.set(biome, lists[groupIndex][index]));
    });
    const placements: VegetationRasterPropPlacement[] = [];
    for (const biome of biomes) {
      for (const placement of byBiome.get(biome) ?? []) placements.push(placement);
    }
    return placements;
  } finally {
    stop?.();
  }
}

/**
 * Turns the stand placements of a geometry built with `deferStands` into
 * stands, building them on the helpers and here side by side. Each stand
 * depends only on the placements and the DEM, so the result equals one
 * sequential pass.
 */
export async function buildPropStandsInParallel(
  geometry: VegetationGeometry,
  dem: MountainDEMData,
  options: VegetationPatternOptions | undefined,
  profiler?: MountainProfiler,
): Promise<void> {
  const stop = profiler?.begin("vegetation forest stand geometry");
  try {
    const rasterProps = geometry.rasterProps ?? [];
    const sizes = propStandSizes(rasterProps, options);
    const pool = placementHelpers();
    const prebuilt = new Map<number, VegetationPropStand>();
    if (sizes.length > 1 && pool.length > 0) {
      // Largest stands first, each onto the lightest set; set 0 stays here.
      const sets = Array.from({ length: Math.min(sizes.length, pool.length + 1) }, () => ({ indices: [] as number[], work: 0 }));
      [...sizes.keys()].sort((a, b) => sizes[b] - sizes[a]).forEach((index) => {
        const lightest = sets.reduce((best, set) => (set.work < best.work ? set : best));
        lightest.indices.push(index);
        lightest.work += sizes[index] + 1;
      });
      profiler?.recordMetric("vegetation stand worker sets", sets.length, "sets");
      const remote = sets.slice(1).map((set, helper) => {
        // Placement already sent this DEM to the helper; it reuses that copy
        // once and then lets it go.
        const reuse = demOnHelper.get(pool[helper]) === dem;
        demOnHelper.delete(pool[helper]);
        return askHelper(pool[helper], {
          kind: "stands",
          dem: reuse ? undefined : dem,
          options,
          rasterProps,
          bucketIndices: set.indices,
        })
          .then((reply) => {
            reply.stands?.forEach((stand, position) => prebuilt.set(set.indices[position], stand));
          })
          // A failed helper's stands are built here by finishPropStands.
          .catch(() => undefined);
      });
      buildPropStandsForBuckets(dem, options, rasterProps, sets[0].indices, profiler)
        .forEach((stand, position) => prebuilt.set(sets[0].indices[position], stand));
      await Promise.all(remote);
    }
    finishPropStands(geometry, dem, options, prebuilt, profiler);
  } finally {
    stop?.();
  }
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ARID_MOTIF_DEFINITIONS,
  loadVegetationMotifAssets,
  parseSvgVectorAsset,
  STAND_PROP_BIOME_IDS,
  VEGETATION_RASTER_PROP_DEFINITIONS,
} from "../src/rendering/vegetationMotifs";

describe("vegetation motif asset loading", () => {
  it("loads only alpine trees and wetland shrubs for Mountain Detail Studio", async () => {
    vi.resetModules();
    const svg = readFileSync(
      join(process.cwd(), "src/assets/BiomeProps/Alpine/trees/alpineTree75.svg"),
      "utf8",
    );
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, text: async () => svg }));
    vi.stubGlobal("fetch", fetchMock);
    const motifs = await import("../src/rendering/vegetationMotifs");
    const definitions = motifs.VEGETATION_RASTER_PROP_DEFINITIONS;
    // Wetland shrubs feed the wetland shrub stands.
    const expected = definitions.filter((definition) =>
      definition.outlineGroup === "alpine-forest" ||
      definition.placementRole === "wetland",
    );

    const assets = await motifs.loadMountainDetailPropAssets();

    expect(assets.map((asset) => asset.key)).toEqual(expected.map((definition) => definition.key));
    expect(assets.filter((asset) => asset.placementRole === "wetland").every((asset) => asset.family === "shrub")).toBe(true);
    expect(assets.some((asset) => asset.placementRole === "mountain-foothill")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(expected.length);
    vi.unstubAllGlobals();
  });

  it("loads alpine props in definition order and shares fetches with the full loader", async () => {
    vi.resetModules();
    const svg = readFileSync(
      join(process.cwd(), "src/assets/BiomeProps/Alpine/trees/alpineTree75.svg"),
      "utf8",
    );
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      text: async () => svg,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const motifs = await import("../src/rendering/vegetationMotifs");
    const expected = motifs.VEGETATION_RASTER_PROP_DEFINITIONS.filter((definition) =>
      definition.key.startsWith("alpine-tree-75"),
    );

    const [alpineAssets, allAssets] = await Promise.all([
      motifs.loadAlpineVegetationRasterPropAssets(),
      motifs.loadVegetationRasterPropAssets(),
    ]);

    expect(alpineAssets.map((asset) => asset.key)).toEqual(
      expected.map((definition) => definition.key),
    );
    expect(allAssets.filter((asset) => asset.key.startsWith("alpine-tree-75")).map((asset) => asset.key))
      .toEqual(alpineAssets.map((asset) => asset.key));
    for (const definition of expected) {
      expect(fetchMock.mock.calls.filter(([url]) => url === definition.url)).toHaveLength(1);
    }
    vi.unstubAllGlobals();
  });

  it("evicts failed alpine loads so a later request can retry", async () => {
    vi.resetModules();
    const svg = readFileSync(
      join(process.cwd(), "src/assets/BiomeProps/Alpine/trees/alpineTree75.svg"),
      "utf8",
    );
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("temporary load failure"))
      .mockImplementation(async (_url: string) => ({ ok: true, text: async () => svg }));
    vi.stubGlobal("fetch", fetchMock);
    const motifs = await import("../src/rendering/vegetationMotifs");

    await expect(motifs.loadAlpineVegetationRasterPropAssets()).rejects.toThrow();
    const assets = await motifs.loadAlpineVegetationRasterPropAssets();

    expect(assets).toHaveLength(7);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    vi.unstubAllGlobals();
  });

  it("uses the selected SVG path data for reeds", async () => {
    const reedsSvg = readFileSync(
      join(process.cwd(), "src/assets/vegetation/reeds01.svg"),
      "utf8",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () => reedsSvg,
      })),
    );

    const assets = await loadVegetationMotifAssets();
    const reeds = assets.find((asset) => asset.key === "reeds-01");
    const points = reeds?.vectorPaths?.[0]?.points ?? [];

    expect(reeds?.vectorPaths).toHaveLength(1);
    expect(points[0]?.x).toBeCloseTo(0, 6);
    expect(points.at(-1)?.x).toBeCloseTo(64, 6);
    vi.unstubAllGlobals();
  });


  it("registers the supplied alpine tree path with a filled closed silhouette", async () => {
    const alpineTrees = VEGETATION_RASTER_PROP_DEFINITIONS.filter((definition) =>
      definition.key === "alpine-tree-75",
    );

    expect(alpineTrees).toHaveLength(1);
    expect(alpineTrees[0]).toMatchObject({
      footprintWidthCells: 1,
      footprintHeightCells: 1,
      renderAnchorX: 0.5,
      renderAnchorY: 1,
      outlineMode: "alpha-dilation",
      outlineGroup: "alpine-forest",
      rasterizeVectorFill: true,
    });
    // Trees may grow in any stand biome; per-biome tree density decides where they do.
    expect(alpineTrees[0].eligibleBiomeIds).toEqual(STAND_PROP_BIOME_IDS);

    const svg = readFileSync(
      join(
        process.cwd(),
        "src/assets/BiomeProps/Alpine/trees/alpineTree75.svg",
      ),
      "utf8",
    );
    const parsed = parseSvgVectorAsset(svg);
    expect(parsed?.width).toBe(512);
    expect(parsed?.height).toBe(512);
    expect(parsed?.vectorPaths.length).toBeGreaterThan(1);
    expect(parsed?.vectorPaths[0]).toMatchObject({
      closed: true,
      fillColor: [86, 123, 84],
    });
    expect(parsed?.vectorPaths.slice(1).every((path) => !path.fillColor)).toBe(
      true,
    );
    expect(VEGETATION_RASTER_PROP_DEFINITIONS.some((definition) =>
      definition.key === "tree-prop-01",
    )).toBe(false);
  });

  it("registers the six additional supplied alpine tree variants", () => {
    const variants = VEGETATION_RASTER_PROP_DEFINITIONS.filter((definition) =>
      /^alpine-tree-75-\d{2}$/.test(definition.key),
    );

    expect(variants).toHaveLength(6);
    for (const [index, definition] of variants.entries()) {
      expect(definition).toMatchObject({
        key: `alpine-tree-75-${String(index + 1).padStart(2, "0")}`,
        footprintWidthCells: 1,
        footprintHeightCells: 1,
        renderAnchorX: 0.5,
        renderAnchorY: 1,
        outlineMode: "alpha-dilation",
        outlineGroup: "alpine-forest",
        rasterizeVectorFill: true,
      });
      const svg = readFileSync(
        join(
          process.cwd(),
          `src/assets/BiomeProps/Alpine/trees/alpineTree75Variant${String(index + 1).padStart(2, "0")}.svg`,
        ),
        "utf8",
      );
      const parsed = parseSvgVectorAsset(svg);
      expect(parsed?.width).toBe(512);
      expect(parsed?.height).toBe(512);
      expect(parsed?.vectorPaths[0]).toMatchObject({
        closed: true,
        fillColor: [86, 123, 84],
      });
      expect(parsed?.vectorPaths.slice(1).every((path) => !path.fillColor)).toBe(
        true,
      );
    }
  });
});

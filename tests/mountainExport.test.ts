import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { getHeightmapFitResolution } from "../src/terrain/mountainBaseDEM";
import type { MountainDEMData } from "../src/terrain/mountainBaseDEM";
import {
  getMountainExportTileDimensions,
  prepareMountainExportTile,
  renderMountainExportTile,
  renderPreparedMountainExportTile,
} from "../src/rendering/mountainExportRenderer";
import type { MountainDetailImageData } from "../src/rendering/mountainDetailRenderer";
import {
  buildVisualWaterSurfaceDEM,
  buildWetlandPuddleContours,
  renderWaterOverlay,
} from "../src/rendering/waterRenderer";
import { encodeRgbaPngRows } from "../src/utils/pngEncoding";
import {
  renderMountainDetailDEM,
  renderMountainIllustrationStage,
  type MountainRenderOptions,
} from "../src/rendering/mountainDetailRenderer";
import { buildVegetationGeometry } from "../src/rendering/vegetationRenderer";

function makeDem(width: number, height: number): MountainDEMData {
  const total = width * height;
  const elevation = new Float32Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) elevation[y * width + x] = 100 + x * 4 + y * 7;
  }
  return {
    width,
    height,
    domainWidthKm: 12,
    domainHeightKm: 12,
    dxMeters: 120,
    dyMeters: 120,
    minElevationM: 80,
    maxElevationM: 1200,
    elevation,
    normalizedElevation: new Float32Array(total).fill(0.2),
    slopeDeg: new Float32Array(total),
    aspectDeg: new Float32Array(total),
    normals: new Float32Array(total * 3),
    hillshade: new Float32Array(total).fill(0.8),
    ambientOcclusion: new Float32Array(total).fill(0.8),
    curvature: new Float32Array(total),
    tpi: new Float32Array(total),
    flowAccumulation: new Float32Array(total),
    drainageAreaKm2: new Float32Array(total),
    rainfallWeightedAreaKm2: new Float32Array(total),
    runoffDepthMmYr: new Float32Array(total),
    dischargeM3s: new Float32Array(total),
    strahlerOrder: new Uint8Array(total),
    riverCenterlineMask: new Uint8Array(total),
    isRiverChannel: new Uint8Array(total),
    riverChannelRadius: new Uint8Array(total),
    riverMouthMask: new Uint8Array(total),
    riverMouthAreaKm2: new Float32Array(total),
    waterDepthM: new Float32Array(total),
    flowDirection: new Int8Array(total).fill(-1),
    erosionDepthM: new Float32Array(total),
    precipitationMmYr: new Float32Array(total).fill(1200),
    solarInsolation: new Float32Array(total).fill(0.5),
    temperatureC: new Float32Array(total).fill(10),
    biomeType: new Uint8Array(total).fill(4),
    isOcean: new Uint8Array(total),
  };
}

const renderOptions: MountainRenderOptions = {
  layer: "swiss_relief",
  palette: "swiss_topo",
  sunAzimuthDeg: 315,
  sunAltitudeDeg: 45,
  verticalExaggeration: 2,
  ambientOcclusionStrength: 0.4,
  showRivers: false,
  riverThresholdKm2: 1,
  showWaterDetails: false,
  showOceanDetails: false,
  showContours: false,
  contourIntervalM: 100,
};

describe("true-detail mountain export primitives", () => {
  it("reserves pool support only for tiles near a pool, including pools outside the core", () => {
    const dem = makeDem(256, 256);
    dem.wetlandPoolCoverage = new Float32Array(256 * 256);
    const context = {
      dem,
      source: { width: 4, height: 4, luminance: new Float32Array(16) },
      render: renderOptions,
      outputWidth: 8192,
      outputHeight: 8192,
    };
    const tile = { x: 2048, y: 2048, width: 1024, height: 1024, halo: 0 };
    const empty = getMountainExportTileDimensions(context, tile);
    dem.wetlandPoolCoverage[0] = 1;
    expect(getMountainExportTileDimensions(context, tile).detailHalo).toBe(empty.detailHalo);
    // Just outside the core: its shoreline can still influence pool rings inside.
    dem.wetlandPoolCoverage[70 * 256 + 61] = 1;
    expect(getMountainExportTileDimensions(context, tile).detailHalo).toBeGreaterThan(empty.detailHalo);
  });

  it("keeps the source aspect ratio at an exact 8K long edge", () => {
    expect(getHeightmapFitResolution(4735, 4778, 8192)).toEqual({
      width: 8118,
      height: 8192,
    });
  });

  it("renders a cropped tile with the requested core dimensions", () => {
    const dem = makeDem(16, 16);
    const source = {
      width: 4,
      height: 4,
      luminance: new Float32Array(16).fill(0.2),
    };
    const image = renderMountainExportTile(
      {
        dem,
        source,
        render: renderOptions,
        outputWidth: 32,
        outputHeight: 32,
      },
      { x: 8, y: 8, width: 8, height: 8, halo: 2 },
    );
    expect(image.width).toBe(8);
    expect(image.height).toBe(8);
    expect(image.data.length).toBe(8 * 8 * 4);
    expect(Array.from(image.data).some((value) => value !== 0)).toBe(true);
  });

  it("is deterministic for identical source, terrain, and render settings", () => {
    const dem = makeDem(16, 16);
    const context = {
      dem,
      source: {
        width: 4,
        height: 4,
        luminance: new Float32Array(16).fill(0.2),
      },
      render: renderOptions,
      outputWidth: 32,
      outputHeight: 32,
    };
    const tile = { x: 8, y: 8, width: 8, height: 8, halo: 2 };
    const first = renderMountainExportTile(context, tile);
    const second = renderMountainExportTile(context, tile);
    expect(Array.from(first.data)).toEqual(Array.from(second.data));
  });

  it("composites a precomputed mountain stage without changing the result", () => {
    const dem = makeDem(24, 24);
    dem.biomeType.fill(2);
    const options: MountainRenderOptions = {
      ...renderOptions,
      layer: "vegetation_patterns",
      oceanPixelScale: 1,
      oceanCoordinateStride: dem.width,
      vegetation: {
        seed: 23817,
        patternScale: 1,
        strokeOpacity: 0.8,
      },
    };
    const stage = renderMountainIllustrationStage(dem, options);
    expect(stage).toBeDefined();
    const direct = renderMountainDetailDEM(dem, options);
    const supplied = renderMountainDetailDEM(dem, {
      ...options,
      mountainIllustrationRGBA: stage!.rgba,
    });
    expect(Array.from(supplied.data)).toEqual(Array.from(direct.data));
    const customRGBA = new Uint8ClampedArray(stage!.rgba.length);
    for (let index = 0; index < customRGBA.length; index += 4) {
      customRGBA[index] = 255;
      customRGBA[index + 3] = 255;
    }
    const custom = renderMountainDetailDEM(dem, {
      ...options,
      mountainIllustrationRGBA: customRGBA,
    });
    expect(Array.from(custom.data)).not.toEqual(Array.from(direct.data));
  });

  it("prepares fields from the expanded mountain region before cropping", async () => {
    const dem = makeDem(40, 40);
    dem.biomeType.fill(2);
    const options: MountainRenderOptions = {
      ...renderOptions,
      layer: "vegetation_patterns",
      vegetation: {
        seed: 23817,
        patternScale: 1,
        strokeOpacity: 0.8,
      },
    };
    const requests: { width: number; height: number; fieldWidth: number; fieldHeight: number }[] = [];
    const image = await renderMountainExportTile(
      {
        dem,
        source: { width: 4, height: 4, luminance: new Float32Array(16).fill(0.2) },
        render: options,
        outputWidth: 128,
        outputHeight: 128,
      },
      { x: 48, y: 48, width: 16, height: 16, halo: 0 },
      request => {
        requests.push({
          width: request.dem.width,
          height: request.dem.height,
          fieldWidth: request.fieldInputs.width,
          fieldHeight: request.fieldInputs.height,
        });
        return undefined;
      },
    );
    expect(image.width).toBe(16);
    expect(requests).toHaveLength(1);
    expect(requests[0].fieldWidth).toBe(requests[0].width);
    expect(requests[0].fieldHeight).toBe(requests[0].height);
    expect(requests[0].width).toBeGreaterThan(16);
  });

  it("renders globally generated vegetation without a split-tile seam", () => {
    const dem = makeDem(64, 64);
    dem.biomeType.fill(2);
    for (let y = 0; y < dem.height; y++) {
      for (let x = dem.width / 2; x < dem.width; x++) dem.biomeType[y * dem.width + x] = 3;
    }
    dem.precipitationMmYr.fill(1200);
    dem.slopeDeg.fill(5);
    const vegetation = {
      seed: 23817,
      density: 2,
      patternScale: 1,
      strokeOpacity: 0.8,
    };
    const context = {
      dem,
      source: {
        width: 4,
        height: 4,
        luminance: new Float32Array(16).fill(0.25),
      },
      render: {
        ...renderOptions,
        layer: "vegetation_patterns" as const,
        vegetationBiomeTransitionStrength: 3,
        vegetation,
      },
      vegetationGeometry: buildVegetationGeometry(dem, vegetation),
      outputWidth: 1024,
      outputHeight: 1024,
    };
    const full = renderMountainExportTile(
      context,
      { x: 0, y: 0, width: 1024, height: 1024, halo: 0 },
    );
    const left = renderMountainExportTile(
      context,
      { x: 0, y: 0, width: 512, height: 1024, halo: 16 },
    );
    const right = renderMountainExportTile(
      context,
      { x: 512, y: 0, width: 512, height: 1024, halo: 16 },
    );
    let mismatches = 0;
    for (let y = 0; y < 1024; y++) {
      for (let x = 508; x < 516; x++) {
        const fullOffset = (y * 1024 + x) * 4;
        const tileX = x < 512 ? x : x - 512;
        const tile = x < 512 ? left : right;
        const tileOffset = (y * 512 + tileX) * 4;
        for (let channel = 0; channel < 4; channel++) {
          if (full.data[fullOffset + channel] !== tile.data[tileOffset + channel]) mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
    expect(Array.from(full.data).some((value, index) => index % 4 !== 3 && value < 120)).toBe(true);
  }, 20_000);

  it("renders camera texture tiles without a seam from the lift-free halo", () => {
    const size = 256;
    const dem = makeDem(size, size);
    dem.domainWidthKm = 2;
    dem.domainHeightKm = 2;
    dem.dxMeters = 2000 / size;
    dem.dyMeters = 2000 / size;
    dem.minElevationM = 0;
    dem.maxElevationM = 1200;
    const luminance = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      // A wavy north-south ridge that crosses the vertical tile seam.
      const crest = size / 2 + 24 * Math.sin(y / 18);
      for (let x = 0; x < size; x++) {
        const index = y * size + x;
        const rough = 30 * Math.sin(x * 0.9 + y * 0.35) * Math.cos(y * 0.7 - x * 0.2);
        const elevation = 200 + 800 * Math.exp(-((x - crest) ** 2) / (2 * 22 ** 2)) + rough;
        dem.elevation[index] = elevation;
        luminance[index] = elevation / 1200;
        dem.normalizedElevation[index] = elevation / 1200;
        dem.temperatureC[index] = 12 - elevation * 0.015;
      }
    }
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const index = y * size + x;
        const gx = (dem.elevation[index + 1] - dem.elevation[index - 1]) / (2 * dem.dxMeters);
        const gy = (dem.elevation[index + size] - dem.elevation[index - size]) / (2 * dem.dyMeters);
        dem.slopeDeg[index] = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
      }
    }
    const context = {
      dem,
      source: { width: size, height: size, luminance },
      render: {
        ...renderOptions,
        fullTerrainCameraElevationDeg: 45,
        mountainViewAngleDeg: 90,
        // Few snow steps keep the halo narrower than the canvas, so an
        // undersized support would show up as seam mismatches.
        snowRedistributionSteps: 8,
      },
      outputWidth: 512,
      outputHeight: 512,
    };
    const full = renderMountainExportTile(context, { x: 0, y: 0, width: 512, height: 512, halo: 0 });
    // A detail halo wider than the mountain support (as coastal wave halos
    // are) makes the illustration region smaller than the compositor region.
    const left = renderMountainExportTile(context, { x: 0, y: 0, width: 256, height: 512, halo: 300 });
    const right = renderMountainExportTile(context, { x: 256, y: 0, width: 256, height: 512, halo: 300 });
    // A prepared tile survives the structured clone a helper worker receives,
    // and renders the same pixels without the export context.
    const clonedLeft = structuredClone(
      prepareMountainExportTile(context, { x: 0, y: 0, width: 256, height: 512, halo: 300 }),
    );
    const leftFromClone = renderPreparedMountainExportTile(clonedLeft, {}) as MountainDetailImageData;
    expect(leftFromClone.data).toEqual(left.data);
    let mismatches = 0;
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const fullOffset = (y * 512 + x) * 4;
        const tile = x < 256 ? left : right;
        const tileOffset = (y * 256 + (x % 256)) * 4;
        for (let channel = 0; channel < 4; channel++) {
          if (full.data[fullOffset + channel] !== tile.data[tileOffset + channel]) mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
    // The seam columns must actually carry mountain illustration.
    const plain = full.data.slice(0, 4).join();
    let illustratedSeamPixels = 0;
    for (let y = 0; y < 512; y++) {
      const offset = (y * 512 + 256) * 4;
      if (full.data.slice(offset, offset + 4).join() !== plain) illustratedSeamPixels++;
    }
    expect(illustratedSeamPixels).toBeGreaterThan(50);
  }, 60_000);

  it("keeps procedural wetland pools visible in a scaled tile", () => {
    const dem = makeDem(64, 64);
    dem.biomeType.fill(7);
    const source = {
      width: 4,
      height: 4,
      luminance: new Float32Array(16).fill(0.2),
    };
    const localDem = makeDem(160, 160);
    for (let y = 16; y < 144; y++) {
      for (let x = 16; x < 144; x++) localDem.biomeType[y * localDem.width + x] = 7;
    }
    const directContours = buildWetlandPuddleContours(localDem, {
      density: 1,
      thickness: 1,
      coordinateScale: 4,
      coordinateOffsetX: 48,
      coordinateOffsetY: 48,
      coordinateDomainWidth: 256,
      coordinateDomainHeight: 256,
    });
    expect(directContours.fillAlpha.some((value) => value > 0)).toBe(true);
    const directWaterDem = buildVisualWaterSurfaceDEM(localDem, {
      enabled: true,
      density: 1,
      riverThresholdKm2: 1,
    });
    const directOverlay = renderWaterOverlay(directWaterDem, {
      riverThresholdKm2: 1,
      showWaterDetails: true,
      showOceanDetails: true,
      wetlandPuddleContours: true,
      wetlandPuddleDensity: 1,
      wetlandPuddleThickness: 1,
      wetlandPuddleCoordinateScale: 4,
      wetlandPuddleCoordinateOffsetX: 48,
      wetlandPuddleCoordinateOffsetY: 48,
      wetlandPuddleCoordinateDomainWidth: 256,
      wetlandPuddleCoordinateDomainHeight: 256,
    });
    expect(directOverlay.waterAlpha.some((value) => value > 0)).toBe(true);
    expect(directOverlay.wetlandPuddleFillAlpha?.some((value) => value > 0)).toBe(false);
    const waterDem = buildVisualWaterSurfaceDEM(dem, {
      enabled: true,
      density: 1,
      riverThresholdKm2: 1,
    });
    expect(waterDem.wetlandPoolMask?.some((value) => value > 0)).toBe(true);
    const image = renderMountainExportTile(
      {
        dem: waterDem,
        source,
        render: {
          ...renderOptions,
          showRivers: true,
          showWaterDetails: true,
          showOceanDetails: true,
          wetlandPuddleContours: true,
          wetlandPuddleDensity: 1,
          wetlandPuddleThickness: 1,
        },
        outputWidth: 256,
        outputHeight: 256,
      },
      { x: 0, y: 0, width: 256, height: 256, halo: 0 },
    );
    const imageWithoutPools = renderMountainExportTile(
      {
        dem: buildVisualWaterSurfaceDEM(dem, {
          enabled: false,
          density: 1,
          riverThresholdKm2: 1,
        }),
        source,
        render: {
          ...renderOptions,
          showRivers: true,
          showWaterDetails: true,
          showOceanDetails: true,
          wetlandPuddleContours: false,
          wetlandPuddleDensity: 1,
          wetlandPuddleThickness: 1,
        },
        outputWidth: 256,
        outputHeight: 256,
      },
      { x: 0, y: 0, width: 256, height: 256, halo: 0 },
    );
    let differentPixels = 0;
    for (let index = 0; index < image.data.length; index++) {
      if (image.data[index] !== imageWithoutPools.data[index]) differentPixels++;
    }
    expect(differentPixels).toBeGreaterThan(0);
  });

  it("encodes ordered RGBA bands as a valid PNG without a full image buffer", async () => {
    const width = 2;
    const height = 2;
    const rowBytes = width * 4 + 1;
    const band = new Uint8Array(rowBytes * height);
    band.set([0, 255, 0, 0, 255, 0, 0, 0, 255], 0);
    band.set([0, 0, 255, 0, 255, 0, 255, 255, 255], rowBytes);
    const blob = await encodeRgbaPngRows(width, height, [band]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    let offset = 8;
    let compressed = new Uint8Array(0);
    while (offset < bytes.length) {
      const length = new DataView(bytes.buffer).getUint32(offset);
      const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      const data = bytes.slice(offset + 8, offset + 8 + length);
      if (type === "IDAT") {
        const joined = new Uint8Array(compressed.length + data.length);
        joined.set(compressed);
        joined.set(data, compressed.length);
        compressed = joined;
      }
      offset += length + 12;
      if (type === "IEND") break;
    }
    const inflated = inflateSync(compressed);
    expect(inflated.length).toBe(rowBytes * height);
    expect(Array.from(inflated)).toEqual(Array.from(band));
  });

  it("rejects incomplete scanline bands", async () => {
    await expect(encodeRgbaPngRows(2, 2, [new Uint8Array([0, 1, 2])])).rejects.toThrow(
      "complete rows",
    );
  });

  it("keeps PNG compression timing separate from scanline production", async () => {
    const events: string[] = [];
    const rowBytes = 2 * 4 + 1;
    async function* rows(): AsyncGenerator<Uint8Array> {
      events.push("produce");
      yield new Uint8Array(rowBytes * 2);
    }
    await encodeRgbaPngRows(2, 2, rows(), {
      beginBand: () => {
        events.push("encode-start");
        return () => events.push("encode-end");
      },
      beginFinalize: () => {
        events.push("finalize-start");
        return () => events.push("finalize-end");
      },
    });
    expect(events.indexOf("produce")).toBeLessThan(events.indexOf("encode-start"));
    expect(events).toContain("encode-end");
    expect(events.indexOf("encode-end")).toBeLessThan(events.indexOf("finalize-start"));
    expect(events).toContain("finalize-end");
  });
});

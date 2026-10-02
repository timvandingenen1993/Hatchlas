import { describe, expect, it } from 'vitest';
import { mountainCameraIllustrationTexture, mountainHatchCoreAlpha, paintMountainCameraSegment } from '../src/rendering/mountainCameraLinework';
import { getMountainPatternOptions, type MountainRenderOptions } from '../src/rendering/mountainDetailRenderer';
import type { MountainIllustration } from '../src/rendering/mountainIllustrationRenderer';
import {
  buildMountainIllustrationStageInputs,
  renderMountainCameraIllustrationStageFromInputs,
  renderMountainIllustrationStageFromInputs,
} from '../src/rendering/mountainDetailRenderer';
import { renderFullTerrainCamera } from '../src/rendering/fullTerrainCameraRenderer';
import { processMountainBaseDEM } from '../src/terrain/mountainBaseDEM';
import { renderMountainPatternOverlay, type MountainStrokePath } from '../src/rendering/mountainPatternRenderer';

describe('study linework in the production camera', () => {
  it('retains the study pen accumulation and respects visibility', () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4).fill(255);
    const point = { x: 1.5, y: 1.5 };
    paintMountainCameraSegment(pixels, 4, 4, point, point, 1, [0, 0, 0], 0.25, () => true);
    // Two endpoint dabs, each at alpha .5: 255 -> 128 -> 64.
    expect(pixels[(1 * 4 + 1) * 4]).toBe(64);
    const before = pixels.slice();
    paintMountainCameraSegment(pixels, 4, 4, point, point, 2, [0, 0, 0], 1, () => false);
    expect(pixels).toEqual(before);
  });

  it('keeps terrain filter and hatch support fixed in metres across preview and export resolutions', () => {
    const dem = processMountainBaseDEM(new Float32Array(16 * 16).fill(0.5), 16, 16,
      { domainWidthKm: 8, domainHeightKm: 8, minElevationM: 0, maxElevationM: 1000 });
    const options = { fullTerrainCameraElevationDeg: 75 } as MountainRenderOptions;
    for (const size of [1024, 2048, 8192]) {
      const surface = { ...dem, dxMeters: 8000 / size, dyMeters: 8000 / size };
      const settings = getMountainPatternOptions(surface, options);
      expect(settings.scale * surface.dxMeters).toBeCloseTo(8000 / 1024);
      expect(settings.detailLengthScale).toBe(1);
    }
    expect(getMountainPatternOptions(dem, { oceanPixelScale: 3 } as MountainRenderOptions).scale).toBe(3);
    const tunedSurface = { ...dem, dxMeters: 8000 / 1024, dyMeters: 8000 / 1024 };
    const tuned = getMountainPatternOptions(tunedSurface, {
      fullTerrainCameraElevationDeg: 75,
      mountainLineworkScale: 1.5,
      mountainHatchDensity: 0.4,
      mountainHatchThickness: 0.6,
      mountainHatchOpacity: 0.35,
      mountainHatchHorizontalOpacity: 0.2,
      mountainHatchVerticalOpacity: 0.9,
      mountainRidgeDensity: 1.4,
      mountainRidgeThickness: 1.2,
    } as MountainRenderOptions);
    expect(tuned.scale * tunedSurface.dxMeters).toBeCloseTo(8000 / 1024);
    expect(tuned.hatchDensity).toBe(0.4);
    expect(tuned.hatchThickness).toBeCloseTo(0.9);
    expect(tuned.ridgeDensity).toBe(1.4);
    expect(tuned.ridgeThickness).toBe(1.2);
    expect(tuned.hatchOpacity).toBe(0.35);
    expect(tuned.horizontalHatchOpacity).toBe(0.2);
    expect(tuned.verticalHatchOpacity).toBe(0.9);
    expect(getMountainPatternOptions(tunedSurface, {
      mountainHatchThickness: 1,
      vegetation: { strokeOpacity: 0.1 },
    } as MountainRenderOptions).strokeOpacity).toBe(0.8);
  });
  it('removes baked crests and composites hatch ink over translucent material', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 220, 230, 240, 180, 100, 140, 90, 90]);
    const illustration = {
      rgba, materialRgba: new Uint8ClampedArray([245, 248, 250, 200, 245, 248, 250, 180, 100, 140, 90, 90]),
      silhouetteAlpha: new Uint8Array([255, 0, 0]),
      faceStrokeAlpha: new Uint8Array([255, 255, 0]),
      interiorRidgeAlpha: new Uint8Array(3),
    } as MountainIllustration;
    const texture = mountainCameraIllustrationTexture(illustration);
    expect(Array.from(texture.slice(0, 4))).toEqual([245, 248, 250, 200]);
    expect(texture[4]).toBeLessThan(50);
    expect(texture[7]).toBe(255);
    expect(Array.from(texture.slice(8))).toEqual(Array.from(rgba.slice(8)));
    expect(rgba[0]).toBe(0);
    expect(mountainCameraIllustrationTexture(illustration)).toBe(texture);
    expect(mountainHatchCoreAlpha(0.5, 0.25)).toBe(0);
  });

  it('uses the configured hatch color and opacity in the camera texture', () => {
    const illustration = {
      rgba: new Uint8ClampedArray([220, 220, 220, 255]),
      materialRgba: new Uint8ClampedArray([220, 220, 220, 255]),
      silhouetteAlpha: new Uint8Array([0]),
      faceStrokeAlpha: new Uint8Array([255]),
      interiorRidgeAlpha: new Uint8Array([0]),
    } as MountainIllustration;

    const red = mountainCameraIllustrationTexture(illustration, {
      hatchColor: '#ff0000',
      hatchOpacity: 1,
    });
    const hidden = mountainCameraIllustrationTexture(illustration, {
      hatchColor: '#00ff00',
      hatchOpacity: 0,
    });

    expect(red[0]).toBeGreaterThan(red[1]);
    expect(red[0]).toBeGreaterThan(red[2]);
    expect(Array.from(hidden.slice(0, 3))).toEqual([220, 220, 220]);
  });

  it('keeps a fully opaque shorthand-black hatch exact', () => {
    const illustration = {
      rgba: new Uint8ClampedArray([220, 220, 220, 255]),
      materialRgba: new Uint8ClampedArray([220, 220, 220, 255]),
      silhouetteAlpha: new Uint8Array([0]),
      faceStrokeAlpha: new Uint8Array([255]),
      horizontalHatchAlpha: new Uint8Array([255]),
      verticalHatchAlpha: new Uint8Array([255]),
      horizontalHatchOpacity: 1,
      verticalHatchOpacity: 1,
      interiorRidgeAlpha: new Uint8Array([255]),
    } as MountainIllustration;

    const black = mountainCameraIllustrationTexture(illustration, {
      hatchColor: '#000',
      horizontalHatchOpacity: 1,
      verticalHatchOpacity: 1,
    });

    expect(Array.from(black.slice(0, 3))).toEqual([0, 0, 0]);
  });

  it('controls horizontal and vertical hatch families independently', () => {
    const illustration = {
      rgba: new Uint8ClampedArray([
        220, 220, 220, 255,
        220, 220, 220, 255,
      ]),
      materialRgba: new Uint8ClampedArray([
        220, 220, 220, 255,
        220, 220, 220, 255,
      ]),
      silhouetteAlpha: new Uint8Array([0, 0]),
      faceStrokeAlpha: new Uint8Array([255, 255]),
      horizontalHatchAlpha: new Uint8Array([255, 0]),
      verticalHatchAlpha: new Uint8Array([0, 255]),
      horizontalHatchOpacity: 1,
      verticalHatchOpacity: 1,
      interiorRidgeAlpha: new Uint8Array([0, 0]),
    } as MountainIllustration;

    const horizontalOnly = mountainCameraIllustrationTexture(illustration, {
      hatchColor: '#ff0000',
      horizontalHatchOpacity: 1,
      verticalHatchOpacity: 0,
    });
    const verticalOnly = mountainCameraIllustrationTexture(illustration, {
      hatchColor: '#ff0000',
      horizontalHatchOpacity: 0,
      verticalHatchOpacity: 1,
    });

    expect(Array.from(horizontalOnly.slice(0, 3))).not.toEqual([220, 220, 220]);
    expect(Array.from(horizontalOnly.slice(4, 7))).toEqual([220, 220, 220]);
    expect(Array.from(verticalOnly.slice(0, 3))).toEqual([220, 220, 220]);
    expect(Array.from(verticalOnly.slice(4, 7))).not.toEqual([220, 220, 220]);
  });

  it('keeps low-opacity rendered hatch coverage visible in the camera texture', () => {
    const illustration = {
      rgba: new Uint8ClampedArray([220, 220, 220, 255]),
      materialRgba: new Uint8ClampedArray([220, 220, 220, 255]),
      silhouetteAlpha: new Uint8Array([0]),
      faceStrokeAlpha: new Uint8Array([64]),
      interiorRidgeAlpha: new Uint8Array([0]),
    } as MountainIllustration;

    const texture = mountainCameraIllustrationTexture(illustration, {
      hatchColor: '#ff0000',
      hatchOpacity: 1,
    });

    expect(texture[0]).toBeGreaterThan(texture[1]);
    expect(texture[1]).toBeLessThan(220);
  });

  it('keeps snow and shadow material able to modulate hatch opacity', () => {
    const render = (materialAlpha: number) => mountainCameraIllustrationTexture({
      rgba: new Uint8ClampedArray([220, 220, 220, materialAlpha]),
      materialRgba: new Uint8ClampedArray([220, 220, 220, materialAlpha]),
      silhouetteAlpha: new Uint8Array([0]),
      faceStrokeAlpha: new Uint8Array([128]),
      interiorRidgeAlpha: new Uint8Array([0]),
    } as MountainIllustration, { hatchColor: '#000000' });

    const translucent = render(64);
    const opaque = render(255);
    expect(translucent[3]).toBeLessThan(opaque[3]);
    expect(translucent[0]).toBeLessThan(opaque[0]);
  });

  it('produces byte-identical camera layers without the full illustration image', () => {
    const raw = new Float32Array(48 * 48);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
      raw[y * 48 + x] = 0.2 + 0.7 * Math.exp(-(((x - 24 - 6 * Math.sin(y / 8)) / 12) ** 2));
    }
    const dem = processMountainBaseDEM(raw, 48, 48,
      { domainWidthKm: 8, domainHeightKm: 8, minElevationM: 0, maxElevationM: 3000 });
    dem.biomeType.fill(2);
    const options: MountainRenderOptions = {
      layer: 'vegetation_patterns', palette: 'swiss_topo',
      sunAzimuthDeg: 315, sunAltitudeDeg: 38, verticalExaggeration: 2,
      ambientOcclusionStrength: 0.4, showRivers: false, riverThresholdKm2: 100,
      showWaterDetails: false, showOceanDetails: false, showContours: false,
      contourIntervalM: 100, fullTerrainCameraElevationDeg: 78,
      snowfallAmount: 0.8, snowfallDrift: 1.1, snowfallPersistence: 0.9,
      mountainHatchHorizontalOpacity: 0.35, mountainHatchVerticalOpacity: 0.8,
    };
    const inputs = buildMountainIllustrationStageInputs(dem, options);
    const full = renderMountainIllustrationStageFromInputs(inputs)!;
    const camera = renderMountainCameraIllustrationStageFromInputs(inputs)!;

    expect(camera.materialRgba).toEqual(full.materialRgba);
    expect(camera.silhouetteAlpha).toEqual(full.silhouetteAlpha);
    expect(camera.interiorRidgeAlpha).toEqual(full.interiorRidgeAlpha);
    expect(camera.horizontalHatchAlpha).toEqual(full.horizontalHatchAlpha);
    expect(camera.verticalHatchAlpha).toEqual(full.verticalHatchAlpha);
    expect(mountainCameraIllustrationTexture(camera)).toEqual(
      mountainCameraIllustrationTexture(full),
    );
    expect('rgba' in camera).toBe(false);
  }, 30000);

  it('changes hatch opacity without changing hatch geometry', () => {
    const raw = new Float32Array(64 * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      raw[y * 64 + x] = 0.2 + 0.7 * Math.exp(-(((x - 32) / 14) ** 2)) * (0.8 + 0.2 * Math.cos(y / 8));
    }
    const dem = processMountainBaseDEM(raw, 64, 64,
      { domainWidthKm: 8, domainHeightKm: 8, minElevationM: 0, maxElevationM: 1000 });
    const baseOptions = {
      hatchDensity: 2, hatchThickness: 1, ridgeDensity: 1, ridgeThickness: 1,
      strokeOpacity: 1,
    } as const;
    const pale = renderMountainPatternOverlay(dem, { ...baseOptions, hatchOpacity: 0.2 });
    const dark = renderMountainPatternOverlay(dem, { ...baseOptions, hatchOpacity: 0.9 });
    expect(pale.paths?.length).toBeGreaterThan(0);
    const geometry = (path: MountainStrokePath) => path.points.map(point => ({ x: point.x, y: point.y }));
    expect(dark.paths?.map(geometry)).toEqual(pale.paths?.map(geometry));
    expect(dark.paths?.map(path => path.width)).toEqual(pale.paths?.map(path => path.width));
    expect(dark.paths?.map(path => path.opacity)).not.toEqual(pale.paths?.map(path => path.opacity));
  });

  it.each(['orthographic', 'perspective'] as const)('projects only primary ridges with a larger texture (%s)', cameraType => {
    const dem = processMountainBaseDEM(new Float32Array(16 * 12).fill(0.5), 16, 12,
      { domainWidthKm: 1, domainHeightKm: 0.75, minElevationM: 0, maxElevationM: 1000 });
    const source = { width: 128, height: 96, data: new Uint8ClampedArray(128 * 96 * 4).fill(255) } as ImageData;
    const ridge: MountainStrokePath = { kind: 'ridge', key: 1, primary: true, width: 0.4, opacity: 0.8,
      points: [{ x: 2, y: 5 }, { x: 13, y: 5 }] };
    const plain = renderFullTerrainCamera(dem, source, { cameraType });
    const secondary = renderFullTerrainCamera(dem, source, { cameraType, ridgePaths: [{ ...ridge, primary: false }] });
    const inked = renderFullTerrainCamera(dem, source, {
      cameraType,
      ridgePaths: [ridge],
      ridgeColor: '#00ff00',
    });
    expect(secondary.data).toEqual(plain.data);
    let changed = 0;
    for (let i = 0; i < plain.data.length; i += 4) {
      if (plain.data[i] === inked.data[i]) continue;
      changed++;
      expect(plain.data[i]).toBe(255); // no ink in the frame margin
      expect(inked.data[i]).toBeLessThan(plain.data[i]);
      expect(inked.data[i + 1]).toBeGreaterThan(inked.data[i]);
      expect(inked.data[i + 3]).toBe(255);
    }
    expect(changed).toBeGreaterThan(30);
    expect(source.data.every(v => v === 255)).toBe(true);
  });

  it('keeps a primary crest readable when the export is smaller than the analysis mesh', () => {
    const dem = processMountainBaseDEM(new Float32Array(64 * 64).fill(0.5), 64, 64,
      { domainWidthKm: 8, domainHeightKm: 8, minElevationM: 0, maxElevationM: 1000 });
    const source = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) } as ImageData;
    const ridge: MountainStrokePath = {
      kind: 'ridge', key: 17, primary: true, width: 0.28, opacity: 0.8,
      points: Array.from({ length: 49 }, (_, index) => ({ x: index + 8, y: 32 + Math.sin(index / 8) * 0.6 })),
    };
    const output = renderFullTerrainCamera(dem, source, {
      cameraType: 'orthographic', elevationDeg: 75, heightExaggeration: 1,
      ridgePaths: [ridge], outputWidth: 32, outputHeight: 32,
    });
    let darkPixels = 0;
    for (let i = 0; i < output.data.length; i += 4) {
      if (output.data[i] < 230 && output.data[i + 1] < 230 && output.data[i + 2] < 230) darkPixels++;
    }
    expect(darkPixels).toBeGreaterThan(18);
  });
});

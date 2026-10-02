import { describe, expect, it } from 'vitest';
import {
  computeMountainIllustrationSsim,
  runMountainFieldGpuBenchmark,
} from '../src/rendering/mountainFieldGpuBenchmark';
import {
  prepareMountainIllustrationFieldsCpu,
  renderMountainIllustration,
  type MountainIllustrationOptions,
} from '../src/rendering/mountainIllustrationRenderer';
import {
  createMountainIllustrationFieldBackend,
} from '../src/rendering/mountainIllustrationGpuExperiment';
import {
  createMountainFieldCache,
} from '../src/rendering/mountainPatternRenderer';
import {
  getMountainIllustrationPreparedFieldsByteLength,
} from '../src/rendering/mountainIllustrationFields';
import {
  createMountainRenderStageCache,
  validateMountainRenderStageCache,
} from '../src/rendering/mountainDetailRenderer';
import type { MountainPatternOverlay } from '../src/rendering/mountainPatternRenderer';
import type { MountainDEMData } from '../src/terrain/mountainBaseDEM';

function makeFields(width: number, height: number): {
  dem: MountainDEMData;
  pattern: MountainPatternOverlay;
} {
  const total = width * height;
  const elevation = new Float32Array(total);
  const coverage = new Uint8Array(total);
  const ink = new Uint8Array(total);
  const snow = new Float32Array(total);
  const wash = new Float32Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      elevation[index] = 100 + x * 12 + y * 7 + (x === 3 && y === 2 ? 400 : 0);
      coverage[index] = x > 1 && y > 1 ? 255 : 0;
      ink[index] = (x * 17 + y * 31) & 255;
      snow[index] = coverage[index] ? 0.4 : 0;
      wash[index] = (x - y) / Math.max(width, height);
    }
  }
  const dem = {
    width,
    height,
    domainWidthKm: 12,
    domainHeightKm: 10,
    dxMeters: 120,
    dyMeters: 120,
    minElevationM: 0,
    maxElevationM: 2000,
    elevation,
    normalizedElevation: new Float32Array(total),
    slopeDeg: new Float32Array(total),
    aspectDeg: new Float32Array(total),
    normals: new Float32Array(total * 3),
    hillshade: new Float32Array(total),
    ambientOcclusion: new Float32Array(total),
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
    precipitationMmYr: new Float32Array(total).fill(900),
    solarInsolation: new Float32Array(total).fill(1),
    temperatureC: new Float32Array(total),
    biomeType: new Uint8Array(total),
    isOcean: new Uint8Array(total),
  } as MountainDEMData;
  return {
    dem,
    pattern: { coverage, ink, snow, wash, surfaceElevation: elevation },
  };
}

describe('mountain field GPU experiment contracts', () => {
  it('keeps the CPU prepared fields dimensioned and normalized for the painter', () => {
    const { dem, pattern } = makeFields(9, 7);
    const fields = prepareMountainIllustrationFieldsCpu(
      dem,
      pattern,
      1,
      dem.elevation,
    );
    expect(fields.width).toBe(9);
    expect(fields.height).toBe(7);
    expect(fields.footprint.every(value => value >= 0 && value <= 1)).toBe(true);
    expect(fields.ribField.every(value => value >= 0 && value <= 1)).toBe(true);
    expect(fields.lightingElevation.some(value => value > 100)).toBe(true);
  });

  it('accepts prepared fields without changing the synchronous painter output', () => {
    const { dem, pattern } = makeFields(9, 7);
    const fields = prepareMountainIllustrationFieldsCpu(dem, pattern, 1, dem.elevation);
    const options: MountainIllustrationOptions = {
      scale: 1,
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      inkColor: [43, 56, 66],
      strokeThickness: 1,
      strokeOpacity: 0.8,
      offsetX: 0,
      offsetY: 0,
      stride: dem.width,
      seed: 23817,
    };
    const baseline = renderMountainIllustration(dem, pattern, new Float32Array(dem.width * dem.height), options);
    const prepared = renderMountainIllustration(
      dem,
      pattern,
      new Float32Array(dem.width * dem.height),
      { ...options, preparedFields: fields },
    );
    expect(prepared.rgba).toEqual(baseline.rgba);
    expect(prepared.charcoalAlpha).toEqual(baseline.charcoalAlpha);
  });

  it('falls back cleanly when WebGPU is not available in the node runner', async () => {
    const { dem, pattern } = makeFields(17, 11);
    const report = await runMountainFieldGpuBenchmark({
      width: dem.width,
      height: dem.height,
      lightingElevation: dem.elevation,
      reliefElevation: dem.elevation,
      ridgeInk: pattern.ink,
      ink: pattern.ink,
      coverage: pattern.coverage,
      lineworkCoverage: pattern.coverage,
      radii: {
        lighting: 3.5,
        relief: 13,
        rib: 3,
        crease: 4.5,
        footprint: 1,
        lineworkFootprint: 1,
        snowRidge: 5.5,
      },
    });
    expect(report.supported).toBe(false);
    expect(report.cpuReferenceFields).toBe(7);
    expect(report.visualGate).toBe('not-run');
  });

  it('returns one for identical illustration buffers', () => {
    const image = new Uint8Array([10, 20, 30, 255, 200, 180, 160, 255]);
    expect(computeMountainIllustrationSsim(image, image)).toBe(1);
  });

  it('reuses the face and support field cache for a repaint', () => {
    const { dem, pattern } = makeFields(9, 7);
    const cache = createMountainFieldCache();
    const options: MountainIllustrationOptions = {
      scale: 1,
      sunAzimuthDeg: 315,
      sunAltitudeDeg: 45,
      inkColor: [43, 56, 66],
      strokeThickness: 1,
      strokeOpacity: 0.8,
      offsetX: 0,
      offsetY: 0,
      stride: dem.width,
      seed: 23817,
    };
    renderMountainIllustration(dem, pattern, new Float32Array(dem.width * dem.height), options, undefined, cache);
    const entryCount = cache.entries.size;
    renderMountainIllustration(dem, pattern, new Float32Array(dem.width * dem.height), options, undefined, cache);
    expect(cache.entries.size).toBe(entryCount);
  });

  it('invalidates prepared fields before a changed DEM can be reused', () => {
    const { dem, pattern } = makeFields(9, 7);
    const cache = createMountainRenderStageCache();
    cache.dem = dem;
    cache.mountainIllustrationPreparedFieldSet = {
      fields: prepareMountainIllustrationFieldsCpu(dem, pattern, 1, dem.elevation),
      dependencySignature: 'stale',
      retainedBytes: 9 * 7 * 7 * Float32Array.BYTES_PER_ELEMENT,
    };
    validateMountainRenderStageCache(dem, cache);
    expect(cache.mountainIllustrationPreparedFieldSet).toBeUndefined();
    dem.elevation[0] += 1;
    validateMountainRenderStageCache(dem, cache);
    expect(cache.mountainIllustrationPreparedFieldSet).toBeUndefined();
    expect(cache.mountainFieldCache.entries.size).toBe(0);
  });

  it('keeps cancellation separate from CPU fallback', async () => {
    const { dem, pattern } = makeFields(17, 11);
    const inputs = {
      width: dem.width,
      height: dem.height,
      cellSizeX: dem.dxMeters,
      cellSizeY: dem.dyMeters,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      faceField: dem.elevation,
      reliefElevation: dem.elevation,
      ridgeInk: pattern.ink,
      ink: pattern.ink,
      coverage: pattern.coverage,
      lineworkCoverage: pattern.coverage,
      radii: {
        lighting: 3.5,
        relief: 13,
        rib: 3,
        crease: 4.5,
        footprint: 1,
        lineworkFootprint: 1,
        snowRidge: 5.5,
      },
    };
    const backend = createMountainIllustrationFieldBackend({ backend: 'auto' });
    await expect(backend.prepare(inputs, undefined, { isCancelled: () => true }))
      .rejects.toMatchObject({ cancelled: true });
    expect(backend.gpuDisabled).toBe(false);
    backend.dispose();

    const cpuBackend = createMountainIllustrationFieldBackend({ backend: 'cpu' });
    const cpuResult = await cpuBackend.prepare(inputs);
    expect(cpuResult.report.backend).toBe('cpu');
    expect(cpuResult.fields.lightingElevation.length).toBe(dem.width * dem.height);
    cpuBackend.dispose();
  });

  it('accounts for all seven retained support fields', () => {
    const { dem, pattern } = makeFields(9, 7);
    const fields = prepareMountainIllustrationFieldsCpu(dem, pattern, 1, dem.elevation);
    expect(getMountainIllustrationPreparedFieldsByteLength(fields))
      .toBe(7 * dem.width * dem.height * Float32Array.BYTES_PER_ELEMENT);
  });

  it('prepares the wind workload through the CPU fallback contract', async () => {
    const { dem } = makeFields(13, 9);
    const backend = createMountainIllustrationFieldBackend({ backend: 'cpu' });
    const result = await backend.prepareWindFields(dem, 225);
    expect(result.report.backend).toBe('cpu');
    expect(result.fields.windShelter.length).toBe(dem.width * dem.height);
    expect(result.fields.windLoading.length).toBe(dem.width * dem.height);
    expect(result.fields.slopeBreak.length).toBe(dem.width * dem.height);
    backend.dispose();
  });

  it('keeps camera-export wind fields on the CPU when WebGPU is unavailable', async () => {
    const { dem } = makeFields(13, 9);
    const automaticBackend = createMountainIllustrationFieldBackend({ backend: 'auto' });
    const cpuBackend = createMountainIllustrationFieldBackend({ backend: 'cpu' });
    const automatic = await automaticBackend.prepareWindFields(dem, 225);
    const cpu = await cpuBackend.prepareWindFields(dem, 225);
    expect(automatic.report.backend).toBe('cpu');
    expect(automatic.fields.windShelter).toEqual(cpu.fields.windShelter);
    expect(automatic.fields.windLoading).toEqual(cpu.fields.windLoading);
    expect(automatic.fields.slopeBreak).toEqual(cpu.fields.slopeBreak);
    automaticBackend.dispose();
    cpuBackend.dispose();
  });
});

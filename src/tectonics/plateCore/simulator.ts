/**
 * Top-level plate-core simulation: builds plates, deforms crust and solves sea level against a fixed ocean volume.
 */
import { buildCubedSphereGrid } from '../../geometry/cubedSphere';
import { classifyPlateBoundariesCore } from './boundaries';
import { deformCrustFromPlateKinematics } from './deformation';
import { crustColumnElevationM, referenceToSeaLevel, solveSeaLevelM } from './elevation';
import { assignPlateIds, createRigidPlates, initializeCrust } from './plates';
import type { PlateCoreConfig, PlateTectonicWorld } from './types';

export const EARTH_OCEAN_VOLUME_M3 = 1.332e18;

export const DEFAULT_PLATE_CORE_CONFIG: PlateCoreConfig = {
  seed: 42,
  resolution: 96,
  radiusMeters: 6_371_000,
  plateCount: 12,
  continentalFraction: 0.35,
  durationMyr: 35,
  waterVolumeM3: EARTH_OCEAN_VOLUME_M3,
};

export function simulatePlateTectonicWorld(
  overrides: Partial<PlateCoreConfig> = {},
): PlateTectonicWorld {
  const config: PlateCoreConfig = { ...DEFAULT_PLATE_CORE_CONFIG, ...overrides };
  config.plateCount = Math.max(4, Math.min(32, Math.floor(config.plateCount)));
  config.continentalFraction = Math.max(0.05, Math.min(0.80, config.continentalFraction));
  config.durationMyr = Math.max(0, config.durationMyr);
  const grid = buildCubedSphereGrid(config.resolution, config.radiusMeters);
  const plates = createRigidPlates(config);
  const plateId = assignPlateIds(grid, plates);
  const initialCrust = initializeCrust(grid, plates, plateId, config);
  const boundaries = classifyPlateBoundariesCore(grid, plates, initialCrust);
  const { crust, ledger } = deformCrustFromPlateKinematics(grid, config, boundaries, initialCrust);
  const rawElevationM = crustColumnElevationM(crust);
  const seaLevelM = solveSeaLevelM(grid, rawElevationM, config.waterVolumeM3);
  const elevationM = referenceToSeaLevel(rawElevationM, seaLevelM);
  return {
    grid,
    config,
    plates,
    crust,
    boundaries,
    elevationM,
    rawElevationM,
    seaLevelM,
    ledger,
  };
}

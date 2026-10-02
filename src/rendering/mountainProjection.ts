/**
 * Selective cartographic projection used by the illustrated mountain layer.
 *
 * This is deliberately separate from the DEM's scientific vertical
 * exaggeration. The map stays overhead; only mountain relief is lifted in the
 * screen-up direction during illustration compositing.
 */

export const MOUNTAIN_VIEW_ANGLE_MIN_DEG = 75;
export const MOUNTAIN_VIEW_ANGLE_MAX_DEG = 90;
export const MOUNTAIN_VIEW_ANGLE_DEFAULT_DEG = 78;
export const MOUNTAIN_HEIGHT_EXAGGERATION_MIN = 1;
export const MOUNTAIN_HEIGHT_EXAGGERATION_MAX = 2;
export const MOUNTAIN_HEIGHT_EXAGGERATION_DEFAULT = 1;

/**
 * Neutral paper from the supplied Mountains/Combined reference sheets and
 * the perspective-study exports. Keep the compositor and study on this same
 * substrate so camera margins never drift toward a second parchment color.
 */
export const MOUNTAIN_REFERENCE_PAPER_RGB = [247, 244, 232] as const;
export const MOUNTAIN_REFERENCE_PAPER_RGBA = [247, 244, 232, 255] as const;

/** Independent cartographic linework controls shared by preview and export. */
export const MOUNTAIN_LINEWORK_SCALE_MIN = 0.5;
export const MOUNTAIN_LINEWORK_SCALE_MAX = 4;
export const MOUNTAIN_LINEWORK_SCALE_DEFAULT = 1;
export const MOUNTAIN_LINEWORK_OPACITY_MIN = 0;
export const MOUNTAIN_LINEWORK_OPACITY_MAX = 1;
export const MOUNTAIN_LINEWORK_OPACITY_DEFAULT = 0.8;
export const MOUNTAIN_HATCH_OPACITY_MIN = 0;
export const MOUNTAIN_HATCH_OPACITY_MAX = 1;
export const MOUNTAIN_HATCH_OPACITY_DEFAULT = 0.8;
export const MOUNTAIN_HATCH_DENSITY_MIN = 0;
export const MOUNTAIN_HATCH_DENSITY_MAX = 6;
export const MOUNTAIN_HATCH_DENSITY_DEFAULT = 1;
export const MOUNTAIN_HATCH_THICKNESS_MIN = 0.25;
export const MOUNTAIN_HATCH_THICKNESS_MAX = 6;
export const MOUNTAIN_HATCH_THICKNESS_DEFAULT = 1;
export const MOUNTAIN_RIDGE_DENSITY_MIN = 0;
export const MOUNTAIN_RIDGE_DENSITY_MAX = 6;
export const MOUNTAIN_RIDGE_DENSITY_DEFAULT = 1;
export const MOUNTAIN_RIDGE_THICKNESS_MIN = 0.25;
export const MOUNTAIN_RIDGE_THICKNESS_MAX = 6;
export const MOUNTAIN_RIDGE_THICKNESS_DEFAULT = 0.75;

/** Automatic local mountain-detail controls. All density results stay at
 * the 1x mountain baseline and only receive additive boosts. */
export const MOUNTAIN_LOCAL_DETAIL_DENSITY_MIN = 1;
export const MOUNTAIN_LOCAL_DETAIL_DENSITY_MAX = 5;
export const MOUNTAIN_LOCAL_DETAIL_DENSITY_DEFAULT = 1.75;
export const MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_MIN = 1;
export const MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_MAX = 4;
export const MOUNTAIN_FOOTHILL_DETAIL_MULTIPLIER_DEFAULT = 1.55;
export const MOUNTAIN_BIOME_DETAIL_MULTIPLIER_MIN = 0;
export const MOUNTAIN_BIOME_DETAIL_MULTIPLIER_MAX = 3;
export const MOUNTAIN_BIOME_DETAIL_MULTIPLIER_DEFAULT = 1;

/** Snow controls are deliberately independent from the camera projection. */
export const MOUNTAIN_SNOWFALL_AMOUNT_DEFAULT = 1;
export const MOUNTAIN_SNOWFALL_DRIFT_DEFAULT = 1;
export const MOUNTAIN_SNOWFALL_PERSISTENCE_DEFAULT = 1;
export const MOUNTAIN_SNOW_REDISTRIBUTION_STEPS_DEFAULT = 100;
export const MOUNTAIN_SNOW_REDISTRIBUTION_STEPS_MAX = 128;

/** Maximum screen-up lift before water/valley anchoring is applied. */
export const MOUNTAIN_MAX_LIFT_PIXELS = 128;
/** Broad source support used by the valley anchor and connected ridge stage. */
export const MOUNTAIN_VALLEY_SUPPORT_PIXELS = 160;
/** Brush, face, and derivative padding around the broad source support. */
export const MOUNTAIN_PROJECTION_SUPPORT_PADDING_PIXELS = 96;

export interface MountainProjectionSettings {
  viewAngleDeg: number;
  heightExaggeration: number;
}

export interface MountainLineworkSettings {
  scale: number;
  opacity: number;
  hatchOpacity: number;
  horizontalHatchOpacity: number;
  verticalHatchOpacity: number;
  hatchDensity: number;
  hatchThickness: number;
  ridgeDensity: number;
  ridgeThickness: number;
}

export interface MountainSnowfallSettings {
  /** Overall incoming snowfall multiplier. */
  amount: number;
  /** Multiplier for routed wind/flow deposition. */
  drift: number;
  /** Retention on sheltered terrain versus exposed slopes. */
  persistence: number;
  /** Number of downhill D8 receiver steps used by the gravity pass. */
  redistributionSteps: number;
}

export function normalizeMountainProjectionSettings(
  viewAngleDeg: number | undefined,
  heightExaggeration: number | undefined,
): MountainProjectionSettings {
  return {
    viewAngleDeg: clamp(
      viewAngleDeg ?? MOUNTAIN_VIEW_ANGLE_DEFAULT_DEG,
      MOUNTAIN_VIEW_ANGLE_MIN_DEG,
      MOUNTAIN_VIEW_ANGLE_MAX_DEG,
    ),
    heightExaggeration: clamp(
      heightExaggeration ?? MOUNTAIN_HEIGHT_EXAGGERATION_DEFAULT,
      MOUNTAIN_HEIGHT_EXAGGERATION_MIN,
      MOUNTAIN_HEIGHT_EXAGGERATION_MAX,
    ),
  };
}

export function normalizeMountainLineworkSettings(
  scale: number | undefined,
  opacity: number | undefined,
  hatchDensity: number | undefined,
  hatchThickness: number | undefined,
  ridgeDensity: number | undefined,
  ridgeThickness: number | undefined,
  hatchOpacity?: number,
  horizontalHatchOpacity?: number,
  verticalHatchOpacity?: number,
): MountainLineworkSettings {
  const normalizedOpacity = clamp(opacity ?? MOUNTAIN_LINEWORK_OPACITY_DEFAULT,
    MOUNTAIN_LINEWORK_OPACITY_MIN, MOUNTAIN_LINEWORK_OPACITY_MAX);
  const normalizedHatchOpacity = clamp(hatchOpacity ?? normalizedOpacity,
    MOUNTAIN_HATCH_OPACITY_MIN, MOUNTAIN_HATCH_OPACITY_MAX);
  return {
    scale: clamp(scale ?? MOUNTAIN_LINEWORK_SCALE_DEFAULT,
      MOUNTAIN_LINEWORK_SCALE_MIN, MOUNTAIN_LINEWORK_SCALE_MAX),
    opacity: normalizedOpacity,
    hatchOpacity: normalizedHatchOpacity,
    horizontalHatchOpacity: clamp(horizontalHatchOpacity ?? normalizedHatchOpacity,
      MOUNTAIN_HATCH_OPACITY_MIN, MOUNTAIN_HATCH_OPACITY_MAX),
    verticalHatchOpacity: clamp(verticalHatchOpacity ?? normalizedHatchOpacity,
      MOUNTAIN_HATCH_OPACITY_MIN, MOUNTAIN_HATCH_OPACITY_MAX),
    hatchDensity: clamp(hatchDensity ?? MOUNTAIN_HATCH_DENSITY_DEFAULT,
      MOUNTAIN_HATCH_DENSITY_MIN, MOUNTAIN_HATCH_DENSITY_MAX),
    hatchThickness: clamp(hatchThickness ?? MOUNTAIN_HATCH_THICKNESS_DEFAULT,
      MOUNTAIN_HATCH_THICKNESS_MIN, MOUNTAIN_HATCH_THICKNESS_MAX),
    ridgeDensity: clamp(ridgeDensity ?? MOUNTAIN_RIDGE_DENSITY_DEFAULT,
      MOUNTAIN_RIDGE_DENSITY_MIN, MOUNTAIN_RIDGE_DENSITY_MAX),
    ridgeThickness: clamp(ridgeThickness ?? MOUNTAIN_RIDGE_THICKNESS_DEFAULT,
      MOUNTAIN_RIDGE_THICKNESS_MIN, MOUNTAIN_RIDGE_THICKNESS_MAX),
  };
}

export function normalizeMountainSnowfallSettings(
  amount: number | undefined,
  drift: number | undefined,
  persistence: number | undefined,
  redistributionSteps?: number,
): MountainSnowfallSettings {
  return {
    amount: clamp(amount ?? MOUNTAIN_SNOWFALL_AMOUNT_DEFAULT, 0, 2),
    drift: clamp(drift ?? MOUNTAIN_SNOWFALL_DRIFT_DEFAULT, 0, 2),
    persistence: clamp(persistence ?? MOUNTAIN_SNOWFALL_PERSISTENCE_DEFAULT, 0, 2),
    redistributionSteps: Math.round(clamp(
      redistributionSteps ?? MOUNTAIN_SNOW_REDISTRIBUTION_STEPS_DEFAULT,
      0,
      MOUNTAIN_SNOW_REDISTRIBUTION_STEPS_MAX,
    )),
  };
}

/**
 * Returns cot(view angle) × height exaggeration. Angles are measured above
 * the ground: 90° is straight down and therefore has no screen displacement.
 */
export function mountainProjectionLiftCoefficient(
  viewAngleDeg = MOUNTAIN_VIEW_ANGLE_DEFAULT_DEG,
  heightExaggeration = MOUNTAIN_HEIGHT_EXAGGERATION_DEFAULT,
): number {
  const settings = normalizeMountainProjectionSettings(viewAngleDeg, heightExaggeration);
  if (settings.viewAngleDeg >= MOUNTAIN_VIEW_ANGLE_MAX_DEG) return 0;
  return Math.tan((MOUNTAIN_VIEW_ANGLE_MAX_DEG - settings.viewAngleDeg) * Math.PI / 180)
    * settings.heightExaggeration;
}

/**
 * Compute a bounded lift in output pixels. `prominenceM / dyMeters` is the
 * local relief expressed in source/output pixels; water clearance preserves
 * the existing local valley anchoring safeguard.
 */
export function mountainProjectionLift(
  prominenceM: number,
  dyMeters: number,
  waterClearancePixels: number,
  scale: number,
  settings: MountainProjectionSettings,
): number {
  const pixelScale = Math.max(0.25, scale);
  const naturalLift = Math.max(0, prominenceM)
    / Math.max(1e-6, dyMeters)
    * mountainProjectionLiftCoefficient(settings.viewAngleDeg, settings.heightExaggeration);
  return Math.min(
    MOUNTAIN_MAX_LIFT_PIXELS * pixelScale,
    naturalLift,
    Math.max(0, waterClearancePixels) * 0.65,
  );
}

/**
 * Support required around an export tile for the maximum allowed projection.
 * Without lift (a straight-down view, as in camera exports) the valley anchor
 * and lift reach are unused; only the filter padding and the unscaled
 * one-pixel-per-step snow redistribution remain.
 */
export function mountainProjectionSupportPixels(
  scale: number,
  liftEnabled = true,
  snowRedistributionSteps = 0,
): number {
  const pixelScale = Math.max(0.25, scale);
  if (!liftEnabled) {
    return Math.ceil(MOUNTAIN_PROJECTION_SUPPORT_PADDING_PIXELS * pixelScale)
      + Math.max(0, Math.ceil(snowRedistributionSteps));
  }
  return Math.ceil(
    (MOUNTAIN_VALLEY_SUPPORT_PIXELS
      + MOUNTAIN_MAX_LIFT_PIXELS
      + MOUNTAIN_PROJECTION_SUPPORT_PADDING_PIXELS) * pixelScale,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

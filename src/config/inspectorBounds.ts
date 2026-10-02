/** Limits used by the inspector, saved-setting loading, and renderers. */
export const INSPECTOR_BOUNDS = {
  groundDensity: 3,
  propDensity: 3,
  patternScale: 3,
  strokeLength: 4,
  propScaleMin: 0.1,
  biomeBorder: 5,
  washNoiseScale: 4,
  canopyWash: 3,
  wetlandDryEnd: 240,
  markShadowSoftness: 10,
  washShadowOffset: 12,
  washShadowGap: 10,
  oceanTurbulence: 6,
  poolSizeMin: 0.02,
} as const;

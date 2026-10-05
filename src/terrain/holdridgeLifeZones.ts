/**
 * Holdridge life zone (HLZ) classification.
 *
 * Holdridge LR (1947) Determination of World Plant Formations From Simple
 * Climatic Data. Science 105(2727):367–368.
 * Holdridge LR (1967) Life zone ecology. Tropical Science Center, San José.
 *
 * The zone table and the nearest-hexagon algorithm follow the "version with
 * no altitudinal belts" implemented in the macroBiome R package
 * (Szelepcsényi Z, `cliHoldridgePoints`, data `hlzDefSubset`), after
 * Szelepcsényi et al. (2014) Cent Eur J Geosci 6(3):293–307.
 *
 * Ported from macroBiome (https://CRAN.R-project.org/package=macroBiome),
 * Copyright (C) Zoltán Szelepcsényi, licensed GPL-3.0-or-later, which is
 * compatible with this project's AGPL-3.0-or-later licence.
 */

export interface HoldridgeLifeZone {
  code: string;
  name: string;
  /** Lower bound of the zone's mean annual biotemperature, °C. */
  abt: number;
  /** Lower bound of the zone's total annual precipitation, mm. */
  tap: number;
  /** Lower bound of the zone's potential evapotranspiration ratio. */
  per: number;
}

/** macroBiome `hlzDefSubset`, core zones then the synthetic bare-soil rows. */
export const HOLDRIDGE_LIFE_ZONES: readonly HoldridgeLifeZone[] = [
  { code: "SpDt", name: "Subpolar dry tundra", abt: 1.5, tap: 62.5, per: 1 },
  { code: "SpMt", name: "Subpolar moist tundra", abt: 1.5, tap: 125, per: 0.5 },
  { code: "SpWt", name: "Subpolar wet tundra", abt: 1.5, tap: 250, per: 0.25 },
  { code: "SpRt", name: "Subpolar rain tundra", abt: 1.5, tap: 500, per: 0.125 },
  { code: "BD", name: "Boreal desert", abt: 3, tap: 62.5, per: 2 },
  { code: "BDs", name: "Boreal dry scrub", abt: 3, tap: 125, per: 1 },
  { code: "BMf", name: "Boreal moist forest", abt: 3, tap: 250, per: 0.5 },
  { code: "BWf", name: "Boreal wet forest", abt: 3, tap: 500, per: 0.25 },
  { code: "BRf", name: "Boreal rain forest", abt: 3, tap: 1000, per: 0.125 },
  { code: "CtD", name: "Cool temperate desert", abt: 6, tap: 62.5, per: 4 },
  { code: "CtDs", name: "Cool temperate desert scrub", abt: 6, tap: 125, per: 2 },
  { code: "CtS", name: "Cool temperate steppe", abt: 6, tap: 250, per: 1 },
  { code: "CtMf", name: "Cool temperate moist forest", abt: 6, tap: 500, per: 0.5 },
  { code: "CtWf", name: "Cool temperate wet forest", abt: 6, tap: 1000, per: 0.25 },
  { code: "CtRf", name: "Cool temperate rain forest", abt: 6, tap: 2000, per: 0.125 },
  { code: "WtD", name: "Warm temperate desert", abt: 12, tap: 62.5, per: 8 },
  { code: "WtDs", name: "Warm temperate desert scrub", abt: 12, tap: 125, per: 4 },
  { code: "WtTs", name: "Warm temperate thorn steppe", abt: 12, tap: 250, per: 2 },
  { code: "WtDf", name: "Warm temperate dry forest", abt: 12, tap: 500, per: 1 },
  { code: "WtMf", name: "Warm temperate moist forest", abt: 12, tap: 1000, per: 0.5 },
  { code: "WtWf", name: "Warm temperate wet forest", abt: 12, tap: 2000, per: 0.25 },
  { code: "WtRf", name: "Warm temperate rain forest", abt: 12, tap: 4000, per: 0.125 },
  { code: "StD", name: "Subtropical desert", abt: 12, tap: 62.5, per: 8 },
  { code: "StDs", name: "Subtropical desert scrub", abt: 12, tap: 125, per: 4 },
  { code: "StTw", name: "Subtropical thorn woodland", abt: 12, tap: 250, per: 2 },
  { code: "StDf", name: "Subtropical dry forest", abt: 12, tap: 500, per: 1 },
  { code: "StMf", name: "Subtropical moist forest", abt: 12, tap: 1000, per: 0.5 },
  { code: "StWf", name: "Subtropical wet forest", abt: 12, tap: 2000, per: 0.25 },
  { code: "StRf", name: "Subtropical rain forest", abt: 12, tap: 4000, per: 0.125 },
  { code: "TD", name: "Tropical desert", abt: 24, tap: 62.5, per: 16 },
  { code: "TDs", name: "Tropical desert scrub", abt: 24, tap: 125, per: 8 },
  { code: "TTw", name: "Tropical thorn woodland", abt: 24, tap: 250, per: 4 },
  { code: "TVdf", name: "Tropical very dry forest", abt: 24, tap: 500, per: 2 },
  { code: "TDf", name: "Tropical dry forest", abt: 24, tap: 1000, per: 1 },
  { code: "TMf", name: "Tropical moist forest", abt: 24, tap: 2000, per: 0.5 },
  { code: "TWf", name: "Tropical wet forest", abt: 24, tap: 4000, per: 0.25 },
  { code: "TRf", name: "Tropical rain forest", abt: 24, tap: 8000, per: 0.125 },
  { code: "BaSl", name: "Bare soil and no vegetation", abt: 1.5, tap: 31.25, per: 2 },
  { code: "BaSl", name: "Bare soil and no vegetation", abt: 1.5, tap: 1000, per: 0.0625 },
  { code: "BaSl", name: "Bare soil and no vegetation", abt: 3, tap: 31.25, per: 4 },
  { code: "BaSl", name: "Bare soil and no vegetation", abt: 3, tap: 2000, per: 0.0625 },
  { code: "BaSl", name: "Bare soil and no vegetation", abt: 6, tap: 31.25, per: 8 },
  { code: "BaSl", name: "Bare soil and no vegetation", abt: 6, tap: 4000, per: 0.0625 },
  { code: "BaSl", name: "Bare soil and no vegetation", abt: 12, tap: 31.25, per: 16 },
  { code: "BaSl", name: "Bare soil and no vegetation", abt: 12, tap: 8000, per: 0.0625 },
  { code: "BaSl", name: "Bare soil and no vegetation", abt: 24, tap: 31.25, per: 32 },
  { code: "BaSl", name: "Bare soil and no vegetation", abt: 24, tap: 16000, per: 0.0625 },
];

/** Every code the classifier returns, in a stable order for per-cell storage. */
export const HOLDRIDGE_ZONE_CODES: readonly string[] = [
  "PD",
  ...new Set(HOLDRIDGE_LIFE_ZONES.map((zone) => zone.code)),
];

/** Full name for a zone code, e.g. "Warm temperate dry forest". */
export function holdridgeZoneName(code: string): string {
  if (code === "PD") return "Polar desert";
  return HOLDRIDGE_LIFE_ZONES.find((zone) => zone.code === code)?.name ?? code;
}

/** Holdridge's annual PET coefficient: PET (mm) = 58.93 × biotemperature. */
export const HOLDRIDGE_PET_COEFFICIENT = 58.93;

// macroBiome's boundary constants.
const POLAR_TEMPERATURE_LINE = 1.5;
const MINIMUM_PRECIPITATION_MM = 62.5;
const MINIMUM_PET_RATIO = 0.125;
/** Frost line separating warm temperate from subtropical zones (≈16.97 °C). */
const FROST_TEMPERATURE_LINE = 2 ** (Math.log2(12) + 0.5);

// Each zone's ideal point is the centre of its hexagon: half a log2 step
// above its lower bounds.
const ZONE_CENTRES = HOLDRIDGE_LIFE_ZONES.map((zone) => ({
  code: zone.code,
  abt: Math.log2(zone.abt) + 0.5,
  tap: Math.log2(zone.tap) + 0.5,
  per: Math.log2(zone.per) + 0.5,
  isWarmTemperate: zone.code.startsWith("Wt"),
  isSubtropical: zone.code.startsWith("St"),
}));

/**
 * Mean annual biotemperature from monthly means: temperatures below 0 °C or
 * above 30 °C count as 0 (Holdridge 1967; Eq 1 in Szelepcsényi et al. 2014).
 */
export function holdridgeBiotemperature(monthlyTemperaturesC: ArrayLike<number>): number {
  let sum = 0;
  for (let month = 0; month < monthlyTemperaturesC.length; month++) {
    const temperature = monthlyTemperaturesC[month];
    if (temperature >= 0 && temperature <= 30) sum += temperature;
  }
  return sum / Math.max(1, monthlyTemperaturesC.length);
}

/**
 * Biotemperature when only the annual mean is known. The 30 °C cut-off
 * zeroes individual hot months; applied to an annual mean above 30 °C it
 * would zero the whole year and classify the hottest climates as polar
 * desert, so the mean is capped at 30 °C instead.
 */
export function holdridgeBiotemperatureFromAnnualMean(annualMeanC: number): number {
  return holdridgeBiotemperature([Math.min(annualMeanC, 30)]);
}

/** Potential evapotranspiration ratio, PET / precipitation (dimensionless). */
export function holdridgePetRatio(biotemperatureC: number, precipitationMm: number): number {
  return (HOLDRIDGE_PET_COEFFICIENT * biotemperatureC) / precipitationMm;
}

/**
 * Holdridge life zone code for a biotemperature (°C) and annual precipitation
 * (mm), using macroBiome's rules: bare soil below 62.5 mm or a PET ratio
 * below 0.125, polar desert below 1.5 °C, otherwise the zone whose hexagon
 * centre is nearest in log2 space. Warm temperate and subtropical zones share
 * centres; the frost line decides between them. A biotemperature of 0 (no
 * month above freezing) is left unclassified by macroBiome and reported here
 * as polar desert.
 */
export function classifyHoldridgeLifeZone(
  biotemperatureC: number,
  precipitationMm: number,
): string {
  if (!(biotemperatureC > 0)) return "PD";
  if (!(precipitationMm > 0)) return "BaSl";
  const per = holdridgePetRatio(biotemperatureC, precipitationMm);
  if (precipitationMm < MINIMUM_PRECIPITATION_MM || per < MINIMUM_PET_RATIO) return "BaSl";
  if (biotemperatureC < POLAR_TEMPERATURE_LINE) return "PD";

  const logAbt = Math.log2(biotemperatureC);
  const logTap = Math.log2(precipitationMm);
  const logPer = Math.log2(per);
  const preferWarmTemperate = biotemperatureC < FROST_TEMPERATURE_LINE;
  let bestCode = "";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const centre of ZONE_CENTRES) {
    // Ties between identical warm temperate and subtropical centres go to the
    // side of the frost line the cell is on.
    if (preferWarmTemperate ? centre.isSubtropical : centre.isWarmTemperate) continue;
    const distance = Math.hypot(
      logAbt - centre.abt,
      logTap - centre.tap,
      logPer - centre.per,
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCode = centre.code;
    }
  }
  return bestCode;
}

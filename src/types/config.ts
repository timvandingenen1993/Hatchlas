/**
 * Validated, Unit-Bearing Simulation Configuration
 */

export type ResolutionMode = 32 | 96 | 192 | 256 | 384 | 512;

export interface SimulationConfig {
  seed: number;
  faceResolution: ResolutionMode; // 32 (test), 96 (preview), 192 (default), 256 (high detail)

  // Planetary Parameters
  planetRadiusKm: number;         // default 6371 km (Earth)
  axialTiltDeg: number;           // default 23.44° (Earth obliquity)
  solarConstantWm2: number;       // default 1361 W/m^2 (Solar irradiance)
  greenhouseEffect: number;       // 0.8 to 1.5 (modulates atmospheric thermal retention)

  // Tectonics & Lithosphere
  continentalFraction: number;    // 0.15 to 0.65 (Target fraction of crust that is continental, default 0.35)
  plateCount: number;             // 6 to 24 (Number of tectonic plates, default 12)
  geologicalAgeMyr: number;       // 50 to 800 Myr (Simulation geological epoch time, default 250)
  tectonicEvolutionMyr: number;   // Active plate-history window, default 50 Myr
  tectonicUpliftRateMmYr: number; // 0.2 to 3.0 mm/yr (Maximum active-orogen uplift rate, default 0.5)
  oceanVolumeMultiplier: number;  // 0.6 to 1.5 (default 1.0)

  // Geomorphology & Landscape Evolution
  landscapeEvolutionMyr: number;  // 5 to 75 Myr (Duration of the active orogenic episode, default 25)
  fluvialErosionRate: number;     // 0.2 to 2.5 (Stream-power law rate coefficient K, default 1.0)
  hillslopeDiffusionRate: number; // Linear hillslope diffusivity D in m²/yr (0.005 to 0.1)
  sedimentDepositionRate: number; // 0.2 to 2.0 (Delta and basin sedimentation rate, default 1.0)
  glacialErosionStrength: number; // 0.0 to 2.0 (Alpine & continental ice carving, default 0.7)

  // Atmosphere & Climate
  windStrength: number;           // 0.5 to 2.0 (Atmospheric circulation speed multiplier, default 1.0)
  orographicRainfallScale: number;// 0.5 to 2.5 (Smith & Barstad forced lift multiplier, default 1.2)
  lapseRateDegCPerKm: number;     // 4.5 to 9.8 °C/km (Environmental lapse rate, default 6.5)
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = {
  seed: 133742,
  faceResolution: 192,

  planetRadiusKm: 6371,
  axialTiltDeg: 23.44,
  solarConstantWm2: 1361,
  greenhouseEffect: 1.0,

  continentalFraction: 0.35,
  plateCount: 12,
  geologicalAgeMyr: 250,
  tectonicEvolutionMyr: 50,
  tectonicUpliftRateMmYr: 0.5,
  oceanVolumeMultiplier: 1.0,

  landscapeEvolutionMyr: 25,
  fluvialErosionRate: 1.0,
  hillslopeDiffusionRate: 0.05,
  sedimentDepositionRate: 1.0,
  glacialErosionStrength: 0.7,

  windStrength: 1.0,
  orographicRainfallScale: 1.2,
  lapseRateDegCPerKm: 6.5,
};

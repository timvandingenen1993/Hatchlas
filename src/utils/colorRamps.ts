/**
 * Scientific and Cartographic Color Ramps for Equal Earth Analysis Layers
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function rgb(r: number, g: number, b: number): RGB {
  return { r, g, b };
}

export function lerpRGB(c1: RGB, c2: RGB, t: number): RGB {
  const clampT = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(c1.r * (1 - clampT) + c2.r * clampT),
    g: Math.round(c1.g * (1 - clampT) + c2.g * clampT),
    b: Math.round(c1.b * (1 - clampT) + c2.b * clampT),
  };
}

/**
 * Continuous multi-stop color ramp interpolation
 */
export function sampleColorRamp(stops: [number, RGB][], value: number): RGB {
  if (stops.length === 0) return rgb(0, 0, 0);
  if (value <= stops[0][0]) return stops[0][1];
  if (value >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];

  for (let i = 0; i < stops.length - 1; i++) {
    const s0 = stops[i];
    const s1 = stops[i + 1];
    if (value >= s0[0] && value <= s1[0]) {
      const t = (value - s0[0]) / (s1[0] - s0[0]);
      return lerpRGB(s0[1], s1[1], t);
    }
  }

  return stops[stops.length - 1][1];
}

// 1. Elevation Hypsometric Ramp (Meters relative to 0m sea level)
export const ELEVATION_STOPS: [number, RGB][] = [
  [-9000, rgb(7, 24, 58)],      // Deep trench
  [-5500, rgb(13, 52, 104)],    // Abyssal plain
  [-2500, rgb(24, 91, 145)],    // Oceanic basin
  [-200,  rgb(55, 132, 161)],   // Continental shelf
  [0,     rgb(184, 173, 122)],  // Shoreline
  [1,     rgb(112, 145, 79)],   // Coastal lowlands
  [250,   rgb(137, 159, 82)],   // Fertile plains
  [650,   rgb(171, 157, 91)],   // Plateaus & rolling hills
  [1400,  rgb(166, 133, 91)],   // Highlands
  [2400,  rgb(143, 111, 89)],   // Mountain base
  [3800,  rgb(126, 116, 107)],  // Alpine crags
  [5500,  rgb(211, 213, 207)],  // Snowline
  [8500,  rgb(248, 249, 244)],  // Highest summits
];

// 2. Temperature Ramp (°C: -40°C to +45°C)
export const TEMPERATURE_STOPS: [number, RGB][] = [
  [-40, rgb(49, 54, 149)],    // Extreme Arctic Cold
  [-20, rgb(69, 117, 180)],
  [-5,  rgb(116, 173, 209)],
  [0,   rgb(171, 217, 233)],  // Freezing Point
  [10,  rgb(254, 224, 144)],  // Mild
  [20,  rgb(253, 174, 97)],   // Warm
  [30,  rgb(244, 109, 67)],   // Hot Tropical
  [45,  rgb(165, 0, 38)],     // Extreme Desert Heat
];

// 3. Precipitation Ramp (mm/month: 0 to 400+ mm)
export const PRECIPITATION_STOPS: [number, RGB][] = [
  [0,   rgb(254, 240, 217)],  // Arid
  [25,  rgb(253, 204, 138)],
  [60,  rgb(252, 141, 89)],
  [120, rgb(153, 216, 201)],  // Moderate
  [200, rgb(102, 194, 164)],
  [300, rgb(44, 162, 95)],    // Heavy Rain
  [450, rgb(8, 104, 172)],    // Monsoon / Rainforest
];

// 4. Crust Age Ramp (Myr: 0 to 220 Myr)
export const CRUST_AGE_STOPS: [number, RGB][] = [
  [0,   rgb(239, 68, 68)],    // 0 Myr: Active Spreading Center
  [30,  rgb(249, 115, 22)],
  [70,  rgb(234, 179, 8)],
  [110, rgb(34, 197, 94)],
  [150, rgb(6, 182, 212)],
  [200, rgb(59, 130, 246)],
  [250, rgb(147, 51, 234)],   // Old Cold Oceanic Lithosphere
];

// 5. Tectonic Uplift Rate (mm/yr: -2.0 to +3.0)
export const TECTONIC_UPLIFT_STOPS: [number, RGB][] = [
  [-2.0, rgb(30, 64, 175)],   // Severe Subsidence / Trench
  [-0.5, rgb(96, 165, 250)],
  [0.0,  rgb(226, 232, 240)], // Stable Neutral
  [0.5,  rgb(251, 146, 60)],
  [1.5,  rgb(239, 68, 68)],   // Active Mountain Orogeny
  [3.0,  rgb(159, 18, 57)],   // Rapid Himalayan Collision
];

// 6. Drainage Basin Distinct Categorical Colors
export const BASIN_PALETTE: RGB[] = [
  rgb(239, 68, 68), rgb(249, 115, 22), rgb(245, 158, 11), rgb(132, 204, 22),
  rgb(16, 185, 129), rgb(6, 182, 212), rgb(59, 130, 246), rgb(99, 102, 241),
  rgb(139, 92, 246), rgb(217, 70, 239), rgb(244, 63, 94), rgb(20, 184, 166),
  rgb(234, 179, 8), rgb(168, 85, 247), rgb(236, 72, 153), rgb(34, 197, 94),
];

// 7. 16 Ecoclimatic Biome Definitions & Palettes (Champreux et al. 2024 / Whittaker 1975)
export interface BiomeMeta {
  id: number;
  name: string;
  color: RGB;
  description: string;
}

export const BIOME_DEFINITIONS: Record<number, BiomeMeta> = {
  0:  { id: 0,  name: 'Abyssal Ocean', color: rgb(12, 35, 64), description: 'Deep ocean basins (>2000m depth).' },
  1:  { id: 1,  name: 'Continental Shelf Sea', color: rgb(22, 78, 99), description: 'Shallow coastal marine waters (<200m depth).' },
  2:  { id: 2,  name: 'Tropical Coral Reef', color: rgb(6, 182, 212), description: 'Warm sunlit tropical reef platforms.' },
  3:  { id: 3,  name: 'Polar Sea Ice Cap', color: rgb(241, 245, 249), description: 'Perennial marine pack ice & floating ice shelves.' },
  4:  { id: 4,  name: 'Marginal Pack Ice Floes', color: rgb(186, 230, 253), description: 'Seasonal drifting sea ice floes.' },
  5:  { id: 5,  name: 'Continental Glacial Ice Sheet', color: rgb(255, 255, 255), description: 'Thick perpetual continental glaciers & ice caps.' },
  6:  { id: 6,  name: 'Arctic Tundra', color: rgb(148, 163, 184), description: 'Treeless moss, lichen & permafrost plains.' },
  7:  { id: 7,  name: 'Boreal Taiga Forest', color: rgb(21, 94, 76), description: 'Coniferous evergreen subarctic taiga.' },
  8:  { id: 8,  name: 'Temperate Rainforest', color: rgb(13, 148, 136), description: 'Lush oceanic coastal temperate rainforest.' },
  9:  { id: 9,  name: 'Temperate Deciduous Forest', color: rgb(34, 128, 56), description: 'Broadleaf seasonal woodlands.' },
  10: { id: 10, name: 'Temperate Grassland / Steppe', color: rgb(163, 163, 45), description: 'Semi-arid continental plains & prairies.' },
  11: { id: 11, name: 'Mediterranean Woodland / Chaparral', color: rgb(180, 140, 50), description: 'Dry-summer sclerophyll shrublands.' },
  12: { id: 12, name: 'Cold Continental Desert', color: rgb(185, 145, 100), description: 'Arid rain-shadow basins & desert plateaus.' },
  13: { id: 13, name: 'Hot Subtropical Desert', color: rgb(217, 119, 6), description: 'Hyper-arid sand erg & gravel reg deserts.' },
  14: { id: 14, name: 'Tropical Savanna / Scrub', color: rgb(202, 138, 4), description: 'Tropical grasslands with wet/dry seasons.' },
  15: { id: 15, name: 'Tropical Seasonal Forest', color: rgb(46, 140, 40), description: 'Monsoon deciduous tropical woodlands.' },
  16: { id: 16, name: 'Tropical Rainforest', color: rgb(4, 90, 36), description: 'Dense equatorial humid jungle canopy.' },
  17: { id: 17, name: 'Alpine Tundra & Mountain Peaks', color: rgb(100, 116, 139), description: 'High-altitude crags above the treeline.' },
};

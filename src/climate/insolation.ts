/**
 * Top-of-Atmosphere Daily-Average Solar Insolation on an Oblique Sphere
 * Reference: Hartmann (1994), "Global Physical Climatology", Academic Press (Chapter 2).
 */

export interface MonthlyInsolationResult {
  monthlyDeclinationDeg: Float32Array; // 12 values
  insolationWm2: Float32Array[];       // 12 arrays (each totalCells length)
}

/**
 * Calculate TOA daily-average insolation for each of the 12 months
 * m = 0: January, m = 6: July
 */
export function computeMonthlyInsolation(
  cellLatitudes: Float32Array,
  axialTiltDeg: number = 23.44,
  solarConstantWm2: number = 1361.0
): MonthlyInsolationResult {
  const totalCells = cellLatitudes.length;
  const tiltRad = (axialTiltDeg * Math.PI) / 180.0;
  const monthlyDeclinationDeg = new Float32Array(12);
  const insolationWm2: Float32Array[] = [];

  for (let m = 0; m < 12; m++) {
    // Solar declination angle: delta(m) = tilt * sin(2*PI * (m - 2.8) / 12)
    // (Spring Equinox occurs in late March ~ month 2.8)
    const solarLon = ((m - 2.8) / 12.0) * (2 * Math.PI);
    const declinationRad = tiltRad * Math.sin(solarLon);
    monthlyDeclinationDeg[m] = (declinationRad * 180.0) / Math.PI;

    const monthInsolation = new Float32Array(totalCells);
    const sinDelta = Math.sin(declinationRad);
    const cosDelta = Math.cos(declinationRad);

    for (let idx = 0; idx < totalCells; idx++) {
      const phi = cellLatitudes[idx]; // Latitude in radians
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);

      // Hour angle at sunset: cos(H0) = -tan(phi) * tan(delta)
      const cosH0 = -Math.tan(phi) * Math.tan(declinationRad);

      let dayInsolation = 0;
      if (cosH0 <= -1.0) {
        // Polar Day (24-hour continuous daylight)
        dayInsolation = solarConstantWm2 * (sinPhi * sinDelta);
      } else if (cosH0 >= 1.0) {
        // Polar Night (24-hour continuous darkness)
        dayInsolation = 0.0;
      } else {
        // Standard diurnal cycle
        const H0 = Math.acos(cosH0);
        dayInsolation = (solarConstantWm2 / Math.PI) * (H0 * sinPhi * sinDelta + cosPhi * cosDelta * Math.sin(H0));
      }

      monthInsolation[idx] = Math.max(0.0, dayInsolation);
    }

    insolationWm2.push(monthInsolation);
  }

  return { monthlyDeclinationDeg, insolationWm2 };
}

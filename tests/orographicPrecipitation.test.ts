import { describe, expect, it } from 'vitest';
import { computeOrographicPrecipitationRate } from '../src/terrain/orographicPrecipitation';

describe('Smith & Barstad orographic precipitation', () => {
  it('matches the fastscape-lem reference implementation', () => {
    // 624 + 2 × 200 padding = 1024, so the reference and the radix-2 port
    // transform the same padded grid. Reference values were produced with
    // compute_orographic_precip (fastscape-lem/orographic-precipitation) for
    // latitude 40, wind 15 m/s from 270°, precip_base 7 mm/h, precip_min
    // 0.01 mm/h, τc = τf = 1000 s, Nm 0.005, Hw 2500 m, Cw 7.4e-3·6.5/5.8.
    const n = 624;
    const elevation = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        elevation[y * n + x] = 2500 * Math.exp(-(((x - 300) / 40) ** 2 + ((y - 320) / 90) ** 2));
      }
    }
    const rate = computeOrographicPrecipitationRate(elevation, n, n, 1000, 1000, {
      windSpeedMs: 15,
      windFromDeg: 270,
      latitudeDeg: 40,
    });

    const westToEast = [7.52108, 8.23475, 10.1891, 13.9109, 16.2793, 10.9288, 0.01, 0.01, 0.01, 3.24842, 7.58301];
    westToEast.forEach((expected, step) => {
      expect(rate[320 * n + 200 + step * 20]).toBeCloseTo(expected, 3);
    });
    const northToSouth = [8.70209, 12.292, 12.292, 8.70209];
    [200, 260, 380, 440].forEach((row, step) => {
      expect(rate[row * n + 290]).toBeCloseTo(northToSouth[step], 3);
    });
  });
});

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

  it('does not turn the opposite map edge into a fake ridge', () => {
    // A mountain on the north edge, a sea-level plain to the south and wind
    // from the south. Padding that blends the south edge up to the north
    // edge's height builds a ridge just beyond the map and dries the plain.
    // The reference is the same terrain embedded in a 3x larger grid whose
    // edges are continued flat, where no such ridge can reach the plain.
    const n = 128;
    const dx = 68000 / n;
    const heightAt = (v: number) => 2 + (v < 0.25 ? 2400 * Math.cos((Math.PI * 0.5 * v) / 0.25) ** 2 : 0);
    const small = new Float32Array(n * n);
    for (let y = 0; y < n; y++) small.fill(heightAt(y / n), y * n, (y + 1) * n);
    const size = n * 3;
    const large = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const row = Math.min(n - 1, Math.max(0, y - n));
      large.fill(heightAt(row / n), y * size, (y + 1) * size);
    }
    const params = { windSpeedMs: 16, windFromDeg: 180 };
    const rate = computeOrographicPrecipitationRate(small, n, n, dx, dx, params);
    const reference = computeOrographicPrecipitationRate(large, size, size, dx, dx, params);
    let padded = 0;
    let ideal = 0;
    let cells = 0;
    for (let y = Math.floor(n * 0.88); y < n; y++) {
      for (let x = Math.floor(n * 0.25); x < n * 0.75; x++) {
        padded += rate[y * n + x];
        ideal += reference[(y + n) * size + x + n];
        cells++;
      }
    }
    expect(Math.abs(padded - ideal) / cells / 7).toBeLessThan(0.12);
  });
});

/** Calibrate the bundled heightmap to the same full-source range as the
 * perspective study, before resampling. Imported maps keep their own scale. */
export function calibrateBundledMountainHeightmap(source: Float32Array): Float32Array {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of source) {
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const range = maximum - minimum;
  if (!Number.isFinite(range) || range <= 0) return source.slice();
  return Float32Array.from(source, value =>
    Number.isFinite(value) ? Math.max(0, Math.min(1, (value - minimum) / range)) : 0);
}

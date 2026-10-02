import { expect, it } from 'vitest';
import { calibrateBundledMountainHeightmap } from '../src/terrain/mountainHeightmapCalibration';

it('preserves source samples while calibrating the complete elevation range', () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);
  const result = calibrateBundledMountainHeightmap(input);
  expect(result[0]).toBe(0);
  expect(result[1]).toBeCloseTo(0.5);
  expect(result[2]).toBe(1);
  expect(input[0]).toBeCloseTo(0.1);
});

import { describe, expect, it } from 'vitest';
import { stylizeMountainLight } from '../src/rendering/mountainLighting';

describe('illustrated mountain lighting', () => {
  it('collapses face lighting into two stable pigment values', () => {
    expect(stylizeMountainLight(0.1, 'two-tone')).toBe(0.24);
    expect(stylizeMountainLight(0.49, 'two-tone')).toBe(0.24);
    expect(stylizeMountainLight(0.5, 'two-tone')).toBe(0.84);
    expect(stylizeMountainLight(0.95, 'two-tone')).toBe(0.84);
  });

  it('preserves the continuous mode for painterly callers', () => {
    expect(stylizeMountainLight(0.37, 'continuous')).toBe(0.37);
    expect(stylizeMountainLight(0.37, 'three-tone')).toBe(0.5);
  });
});


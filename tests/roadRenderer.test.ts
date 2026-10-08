import { describe, expect, it } from 'vitest';
import { rasterizeRoadLayer, roadPropClearanceAt } from '../src/rendering/roadRenderer';
import { DEFAULT_ROAD_STYLE, type RoadRenderPath } from '../src/structures/types';

const SIZE = 256;
const target = { width: SIZE, height: SIZE, offsetX: 0, offsetY: 0, domainWidth: SIZE * 8, domainHeight: SIZE * 8 };
/** Clean pen, so measurements are not affected by charcoal breaks. */
const CLEAN = { ...DEFAULT_ROAD_STYLE, handDrawn: false };

/** A horizontal road through the middle of an 8×-scaled domain's first tile. */
function road(overrides: Partial<RoadRenderPath> = {}): RoadRenderPath {
  return {
    points: [{ u: 0, v: 64 / (SIZE * 8 - 1) }, { u: 255 / (SIZE * 8 - 1), v: 64 / (SIZE * 8 - 1) }],
    kind: 'road',
    bridges: [],
    ...overrides,
  };
}

const columnCoverage = (alpha: Uint8Array | null, x = 128) =>
  alpha ? Array.from({ length: SIZE }, (_, y) => alpha[y * SIZE + x]).filter((value) => value > 0).length : 0;

describe('road renderer', () => {
  it('scales width with the style and per-road multipliers', () => {
    const base = rasterizeRoadLayer([road()], target, { ...CLEAN, clearance: 0 })!;
    const wide = rasterizeRoadLayer([road({ widthScale: 2 })], target, { ...CLEAN, clearance: 0, widthScale: 1.5 })!;
    expect(columnCoverage(wide.ink)).toBeGreaterThan(columnCoverage(base.ink) * 2);
  });

  it('paints an outline casing wider than the ink only when enabled', () => {
    const plain = rasterizeRoadLayer([road()], target, { ...CLEAN, outline: false })!;
    expect(plain.outline).toBeNull();
    const cased = rasterizeRoadLayer([road()], target, { ...CLEAN, outline: true, outlineWidth: 2 })!;
    expect(columnCoverage(cased.outline)).toBeGreaterThan(columnCoverage(cased.ink));
  });

  it('clears props beyond the road edge by the clearance width', () => {
    const tight = rasterizeRoadLayer([road()], target, { ...CLEAN, clearance: 0 })!;
    const roomy = rasterizeRoadLayer([road()], target, { ...CLEAN, clearance: 4 })!;
    const cleared = (layer: NonNullable<typeof tight>) =>
      Array.from({ length: SIZE }, (_, y) => roadPropClearanceAt(layer, y * SIZE + 128)).filter((value) => value > 0.5).length;
    // Scale 1 (2048px domain): 4px each side.
    expect(cleared(roomy)).toBeGreaterThanOrEqual(cleared(tight) + 7);
  });

  it('draws double roads with a fill and dashed roads with gaps', () => {
    const double = rasterizeRoadLayer([road({ lineStyle: 'double' })], target, CLEAN)!;
    expect(columnCoverage(double.fill)).toBeGreaterThan(0);
    const dashed = rasterizeRoadLayer([road({ lineStyle: 'dashed' })], target, { ...CLEAN, clearance: 0 })!;
    const row = Array.from({ length: SIZE }, (_, x) => dashed.ink[64 * SIZE + x]);
    expect(row.some((value) => value === 0)).toBe(true);
    expect(row.some((value) => value > 0)).toBe(true);
  });

  it('uses the road color override and the style color otherwise', () => {
    const layer = rasterizeRoadLayer(
      [road(), road({ color: '#ff0000', points: road().points.map((point) => ({ ...point, v: point.v * 2 })) })],
      target,
      { ...CLEAN, color: '#102030' },
    )!;
    expect(layer.inkColors).toEqual([[16, 32, 48], [255, 0, 0]]);
    expect(layer.inkColors[layer.inkColorIndex[64 * SIZE + 128]]).toEqual([16, 32, 48]);
    expect(layer.inkColors[layer.inkColorIndex[128 * SIZE + 128]]).toEqual([255, 0, 0]);
  });

  it('draws hand-drawn roads as charcoal strokes with breaks and gap dots', () => {
    const long = road({ points: [{ u: 0, v: 64 / 2047 }, { u: 255 / 2047, v: 64 / 2047 }] });
    const charcoal = { ...DEFAULT_ROAD_STYLE, clearance: 0, interruptions: 1, gapDots: true };
    const layer = rasterizeRoadLayer([long], target, charcoal)!;
    // A break empties the whole road width; the pen's dry speckle never does.
    const emptyColumns = (alpha: Uint8Array) => Array.from({ length: 240 }, (_, index) => index + 8)
      .filter((x) => [62, 63, 64, 65, 66].every((y) => alpha[y * SIZE + x] === 0)).length;
    expect(emptyColumns(layer.ink)).toBeGreaterThan(3);
    const unbroken = rasterizeRoadLayer([long], target, { ...charcoal, interruptions: 0 })!;
    expect(emptyColumns(unbroken.ink)).toBe(0);
  });

  it('places true dots for the dotted line style', () => {
    const layer = rasterizeRoadLayer([road({ lineStyle: 'dotted' })], target, { ...DEFAULT_ROAD_STYLE, clearance: 0 })!;
    const row = Array.from({ length: SIZE }, (_, x) => layer.ink[64 * SIZE + x] > 0 ? 1 : 0);
    const dots = row.filter((value, x) => value === 1 && row[x - 1] !== 1).length;
    expect(dots).toBeGreaterThan(20);
  });

  it('draws identical strokes when the map is split into export tiles', () => {
    const charcoal = { ...DEFAULT_ROAD_STYLE, interruptions: 0.6 };
    const whole = rasterizeRoadLayer([road()], target, charcoal)!;
    for (const offsetX of [0, 128]) {
      const tile = rasterizeRoadLayer([road()], { ...target, width: 128, offsetX }, charcoal)!;
      let mismatches = 0;
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < 128; x++) {
          if (tile.ink[y * 128 + x] !== whole.ink[y * SIZE + x + offsetX]) mismatches++;
        }
      }
      expect(mismatches).toBe(0);
    }
  });

  it('breaks each edge of a double road on its own', () => {
    // Wide highway so the two edge lines sit well apart.
    const highway = road({ kind: 'highway', lineStyle: 'double', widthScale: 4 });
    const layer = rasterizeRoadLayer([highway], target, { ...DEFAULT_ROAD_STYLE, clearance: 0, interruptions: 0.8 })!;
    const edgeInk = (rows: number[], x: number) => rows.some((y) => layer.ink[y * SIZE + x] > 0);
    const top = [54, 55, 56, 57];
    const bottom = [71, 72, 73, 74];
    let topOnly = 0;
    let bottomOnly = 0;
    for (let x = 16; x < 240; x++) {
      const upper = edgeInk(top, x);
      const lower = edgeInk(bottom, x);
      if (upper && !lower) topOnly++;
      if (lower && !upper) bottomOnly++;
    }
    // Symmetric breaks would leave both counts at zero.
    expect(topOnly).toBeGreaterThan(0);
    expect(bottomOnly).toBeGreaterThan(0);
    // The fill still runs continuously between the edges.
    expect(Array.from({ length: 224 }, (_, x) => layer.fill[64 * SIZE + x + 16]).every((value) => value > 0)).toBe(true);
  });
});

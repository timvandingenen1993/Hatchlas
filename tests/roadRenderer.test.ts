import { describe, expect, it } from 'vitest';
import { rasterizeRoadLayer, roadPropClearanceAt } from '../src/rendering/roadRenderer';
import { DEFAULT_ROAD_STYLE, type RoadRenderPath, type RoadStyle } from '../src/structures/types';

const SIZE = 256;
const target = { width: SIZE, height: SIZE, offsetX: 0, offsetY: 0, domainWidth: SIZE * 8, domainHeight: SIZE * 8 };
const CLEAN = { ...DEFAULT_ROAD_STYLE, handDrawn: false };

function road(overrides: Partial<RoadRenderPath> = {}, y = 64): RoadRenderPath {
  return { points: [{ u: 0, v: y / 2047 }, { u: 255 / 2047, v: y / 2047 }], kind: 'road', bridges: [], ...overrides };
}
const columnCoverage = (alpha: Uint8Array | null, x = 128) =>
  alpha ? Array.from({ length: SIZE }, (_, y) => alpha[y * SIZE + x]).filter((value) => value > 0).length : 0;
const emptyColumns = (alpha: Uint8Array) => Array.from({ length: 224 }, (_, x) => x + 16)
  .filter((x) => [62, 63, 64, 65, 66].every((y) => alpha[y * SIZE + x] === 0)).length;

describe('road renderer', () => {
  it.each([false, true])('uses identical line geometry for all types (hand-drawn: %s)', (handDrawn) => {
    const style = { ...DEFAULT_ROAD_STYLE, handDrawn };
    const base = rasterizeRoadLayer([road()], target, style)!;
    for (const kind of ['track', 'road', 'highway'] as const) {
      const layer = rasterizeRoadLayer([road({ kind })], target, style)!;
      expect(layer.ink).toEqual(base.ink);
      expect(layer.fill.some((value) => value > 0)).toBe(false);
      expect(emptyColumns(layer.ink)).toBe(0);
    }
  });

  it('ignores legacy individual width, color and line-style fields', () => {
    const style = { ...CLEAN, byKind: { road: { width: 6, color: '#102030' } } };
    const base = rasterizeRoadLayer([road()], target, style)!;
    for (const lineStyle of ['auto', 'double', 'dotted', 'dashed'] as const) {
      const legacy = { ...road(), color: '#ff0000', widthScale: 4, lineStyle };
      const layer = rasterizeRoadLayer([legacy], target, style)!;
      expect(layer.ink).toEqual(base.ink);
      expect(layer.inkColors).toEqual([[16, 32, 48]]);
    }
  });

  it('uses the configured type width', () => {
    const base = rasterizeRoadLayer([road()], target, { ...CLEAN, clearance: 0 })!;
    const wide = rasterizeRoadLayer([road()], target, { ...CLEAN, clearance: 0, byKind: { road: { width: 12 } } })!;
    expect(columnCoverage(wide.ink)).toBeGreaterThan(columnCoverage(base.ink) * 2);
  });

  it('uses independent type widths and colors', () => {
    const style: RoadStyle = { ...CLEAN, byKind: {
      track: { width: 2, color: '#102030' }, road: { width: 4, color: '#405060' }, highway: { width: 8, color: '#708090' },
    } };
    const coverage = (kind: RoadRenderPath['kind']) => columnCoverage(rasterizeRoadLayer([road({ kind })], target, style)!.ink);
    expect(coverage('track')).toBeLessThan(coverage('road'));
    expect(coverage('road')).toBeLessThan(coverage('highway'));
    const layer = rasterizeRoadLayer([
      road({ kind: 'track' }), road({ kind: 'road' }, 128), road({ kind: 'highway' }, 192),
    ], target, style)!;
    expect(layer.inkColors).toEqual([[16, 32, 48], [64, 80, 96], [112, 128, 144]]);
    for (const [y, color] of [[64, 0], [128, 1], [192, 2]]) expect(layer.inkColorIndex[y * SIZE + 128]).toBe(color);
  });

  it('applies casing only to enabled types and keeps each outline color', () => {
    const layer = rasterizeRoadLayer([
      road({ kind: 'track' }), road({ kind: 'road' }, 128), road({ kind: 'highway' }, 192),
    ], target, { ...CLEAN, byKind: {
      road: { outline: true, outlineWidth: 3, outlineColor: '#ff0000' },
      highway: { outline: true, outlineWidth: 2, outlineColor: '#00ff00' },
    } })!;
    expect(layer.outline![64 * SIZE + 128]).toBe(0);
    for (const [y, color] of [[128, [255, 0, 0]], [192, [0, 255, 0]]] as const) {
      const index = y * SIZE + 128;
      expect(layer.outline![index]).toBeGreaterThan(0);
      expect(layer.outlineColors[layer.outlineColorIndex![index]]).toEqual(color);
    }
    expect(rasterizeRoadLayer([road()], target, CLEAN)!.outline).toBeNull();
  });

  it('does not recolor nearby roads, outlines or accents', () => {
    const layer = rasterizeRoadLayer([road({ kind: 'track' }), road({ kind: 'highway' }, 70)], target, {
      ...CLEAN, byKind: {
        track: { color: '#ff0000', outline: true, outlineWidth: 0.5, outlineColor: '#880000',
          shadowOpacity: 0.5, shadowOffset: 1, shadowColor: '#440000' },
        highway: { color: '#0000ff', outline: true, outlineWidth: 0.5, outlineColor: '#000088',
          shadowOpacity: 0.5, shadowOffset: 1, shadowColor: '#000044' },
      },
    })!;
    for (const [y, owner] of [[64, 0], [70, 1]]) {
      const index = y * SIZE + 128;
      expect(layer.inkColorIndex[index]).toBe(owner);
      expect(layer.outlineColorIndex![index]).toBe(owner);
      expect(layer.shadow!.colorIndex[(y + 1) * SIZE + 128]).toBe(owner);
    }
  });

  it('clears props beyond the road edge by the clearance width', () => {
    const tight = rasterizeRoadLayer([road()], target, { ...CLEAN, clearance: 0 })!;
    const roomy = rasterizeRoadLayer([road()], target, { ...CLEAN, clearance: 4 })!;
    const cleared = (layer: typeof tight) => Array.from({ length: SIZE }, (_, y) =>
      roadPropClearanceAt(layer, y * SIZE + 128)).filter((value) => value > 0.5).length;
    expect(cleared(roomy)).toBeGreaterThanOrEqual(cleared(tight) + 7);
  });

  it.each([false, true])('zero spacing is continuous; positive spacing opens gaps (hand-drawn: %s)', (handDrawn) => {
    const style = { ...DEFAULT_ROAD_STYLE, handDrawn };
    const continuous = rasterizeRoadLayer([road()], target, { ...style, byKind: { road: { dashSpacing: 0 } } })!;
    const dashed = rasterizeRoadLayer([road()], target, { ...style, byKind: { road: { dashSpacing: 12 } } })!;
    const spaced = rasterizeRoadLayer([road()], target, { ...style, byKind: { road: { dashSpacing: 30 } } })!;
    expect(emptyColumns(continuous.ink)).toBe(0);
    expect(emptyColumns(dashed.ink)).toBeGreaterThan(20);
    expect(emptyColumns(spaced.ink)).toBeGreaterThan(emptyColumns(dashed.ink));
  });

  it('keeps outline gaps open on dashed roads', () => {
    const layer = rasterizeRoadLayer([road()], target, { ...CLEAN, byKind: {
      road: { dashSpacing: 20, outline: true, outlineWidth: 2 },
    } })!;
    expect(emptyColumns(layer.outline!)).toBeGreaterThan(20);
  });

  it('paints a drop shadow with per-type color and opacity', () => {
    const plain = rasterizeRoadLayer([road()], target, CLEAN)!;
    expect(plain.shadow).toBeNull();
    expect('highlight' in plain).toBe(false);
    const layer = rasterizeRoadLayer([road(), road({ kind: 'track' }, 128)], target, { ...CLEAN, byKind: {
      road: { width: 8, shadowOpacity: 0.5, shadowColor: '#112233', shadowOffset: 6, shadowBlur: 2 },
    } })!;
    expect(layer.shadow!.alpha[70 * SIZE + 128]).toBeGreaterThan(0);
    expect(layer.ink[70 * SIZE + 128]).toBe(0);
    expect(layer.shadow!.colors[layer.shadow!.colorIndex[70 * SIZE + 128]]).toEqual([17, 34, 51]);
    expect(Math.max(...layer.shadow!.alpha)).toBeLessThanOrEqual(128);
    expect(layer.shadow!.alpha[128 * SIZE + 128]).toBe(0);
  });

  it('fades the shadow out softly instead of cutting it off', () => {
    const shadowColumn = (shadowBlur: number) => {
      const layer = rasterizeRoadLayer([road()], target, { ...CLEAN, byKind: {
        road: { width: 8, shadowOpacity: 1, shadowOffset: 0, shadowBlur },
      } })!;
      return Array.from({ length: SIZE }, (_, y) => layer.shadow!.alpha[y * SIZE + 128]).filter((value) => value > 0);
    };
    const hard = shadowColumn(0);
    const soft = shadowColumn(5);
    // Blur widens the shadow and spreads it over many partial-opacity pixels.
    expect(soft.length).toBeGreaterThan(hard.length + 4);
    expect(soft.filter((value) => value > 20 && value < 235).length).toBeGreaterThanOrEqual(6);
    expect(hard.filter((value) => value > 20 && value < 235).length).toBeLessThanOrEqual(3);
  });

  it('keeps the line and dashes clean; only the outline takes the charcoal texture', () => {
    const byKind = { road: { width: 6, dashSpacing: 12, dashLength: 20, outline: true, outlineWidth: 2 } };
    const clean = rasterizeRoadLayer([road()], target, { ...DEFAULT_ROAD_STYLE, handDrawn: false, byKind })!;
    const charcoal = rasterizeRoadLayer([road()], target, { ...DEFAULT_ROAD_STYLE, handDrawn: true, byKind })!;
    expect(charcoal.ink).toEqual(clean.ink);
    expect(charcoal.outline).not.toEqual(clean.outline);
    expect(Array.from(charcoal.ink).filter((value) => value === 255).length).toBeGreaterThan(100);
  });

  it('cuts dashes square so the visible gap equals the dash spacing', () => {
    const layer = rasterizeRoadLayer([road()], target, { ...CLEAN, byKind: { road: { width: 6, dashLength: 20, dashSpacing: 10 } } })!;
    // Inked length along the centerline, summed as coverage so edge antialiasing counts exactly.
    const runs: number[] = [];
    let covered = 0;
    for (let x = 0; x < SIZE; x++) {
      const alpha = layer.ink[64 * SIZE + x];
      if (alpha > 0) covered += alpha / 255;
      else if (covered) { runs.push(covered); covered = 0; }
    }
    if (covered) runs.push(covered);
    expect(runs.length).toBeGreaterThan(5);
    // Interior dashes are exactly the set length, not a pixel longer.
    expect(runs.slice(1, -1).every((length) => Math.abs(length - 20) < 0.25)).toBe(true);
  });

  it('keeps dashes shorter than the line is wide square instead of bulging into blobs', () => {
    // Regression: round caps at joins inside a curved dash overshot its ends.
    const points = Array.from({ length: 56 }, (_, index) => {
      const x = 10 + index * 4;
      return { u: x / 2047, v: (36 + 12 * Math.sin(x / 38)) / 2047 };
    });
    const layer = rasterizeRoadLayer([road({ points })], target, { ...CLEAN, byKind: {
      road: { width: 12, dashLength: 6, dashSpacing: 8, shadowOpacity: 1, shadowBlur: 3, shadowOffset: 0 },
    } })!;
    const columns = (alpha: Uint8Array) => Array.from({ length: SIZE }, (_, x) => {
      for (let y = 0; y < SIZE; y++) if (alpha[y * SIZE + x] > 0) return true;
      return false;
    });
    // Visible gap columns between dashes are real gaps, not filled in.
    expect(columns(layer.ink).filter((on, x) => !on && x > 20 && x < 220).length).toBeGreaterThan(40);
    // Every inked run along x is no longer than the dash plus the curve's slant.
    let run = 0;
    let longest = 0;
    for (const on of columns(layer.ink)) {
      run = on ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThanOrEqual(12);
    // The shadow also leaves a dip between dashes.
    expect(columns(layer.shadow!.alpha).filter((on, x) => !on && x > 20 && x < 220).length).toBeGreaterThan(5);
  });

  it('sets the dash section length independently of the line width', () => {
    const style = { ...CLEAN, byKind: { road: { width: 4, dashSpacing: 10 } } };
    const inked = (dashLength: number) => {
      const layer = rasterizeRoadLayer([road()], target, { ...style, byKind: { road: { ...style.byKind.road, dashLength } } })!;
      return Array.from({ length: SIZE }, (_, x) => layer.ink[64 * SIZE + x]).filter((value) => value > 0).length;
    };
    // Longer sections mean a bigger inked share of the same line; caps and the fixed gap keep it sub-linear.
    expect(inked(40)).toBeGreaterThan(inked(10) * 1.25);
    expect(inked(10)).toBeGreaterThan(inked(3));
  });

  it('scales width and accent offsets with the output domain', () => {
    const style = { ...CLEAN, byKind: { road: { width: 6, shadowOpacity: 1, shadowOffset: 10 } } };
    const base = rasterizeRoadLayer([road()], target, style)!;
    const doubled = rasterizeRoadLayer([road()], { ...target, domainWidth: 4096, domainHeight: 4096 }, style)!;
    expect(columnCoverage(doubled.ink)).toBeGreaterThan(columnCoverage(base.ink) * 1.5);
    expect(base.shadow!.alpha[74 * SIZE + 128]).toBeGreaterThan(0);
    expect(doubled.shadow!.alpha[148 * SIZE + 128]).toBeGreaterThan(0);
  });

  it.each([false, true])('keeps all strokes identical across export tiles (hand-drawn: %s)', (handDrawn) => {
    const style = { ...CLEAN, handDrawn, byKind: { road: {
      width: 6, dashSpacing: 12, outline: true, outlineWidth: 2,
      shadowOpacity: 0.6, shadowOffset: 4, shadowBlur: 3,
    } } };
    const path = road({ points: [{ u: 0, v: 64 / 2047 }, { u: 120 / 2047, v: 64 / 2047 }, { u: 255 / 2047, v: 120 / 2047 }] });
    const whole = rasterizeRoadLayer([path], target, style)!;
    for (const offsetX of [0, 128]) {
      const tile = rasterizeRoadLayer([path], { ...target, width: 128, offsetX }, style)!;
      const masks = (layer: typeof whole) => [layer.ink, layer.outline!, layer.shadow!.alpha];
      masks(whole).forEach((fullMask, maskIndex) => {
        const tileMask = masks(tile)[maskIndex];
        for (let y = 0; y < SIZE; y++) {
          expect(Array.from(tileMask.subarray(y * 128, (y + 1) * 128))).toEqual(
            Array.from(fullMask.subarray(y * SIZE + offsetX, y * SIZE + offsetX + 128)),
          );
        }
      });
    }
  });

  it('keeps bridge decks and rails with the same type settings', () => {
    const layer = rasterizeRoadLayer([road({
      points: [{ u: 20 / 2047, v: 64 / 2047 }, { u: 200 / 2047, v: 64 / 2047 }],
      bridges: [{ from: 0, to: 1, ford: false }],
    })], target, { ...CLEAN, byKind: { road: { width: 8, outline: true, shadowOpacity: 0.5 } } })!;
    expect(layer.fill[64 * SIZE + 128]).toBeGreaterThan(0);
    expect(layer.outline![64 * SIZE + 128]).toBeGreaterThan(0);
    expect(layer.shadow!.alpha.some((value) => value > 0)).toBe(true);
  });

  it('draws a bridge over the water as a main deck with an outlined section down each side', () => {
    const bridge = (extra: Partial<RoadStyle> = {}) => rasterizeRoadLayer([road({
      points: [{ u: 20 / 2047, v: 64 / 2047 }, { u: 200 / 2047, v: 64 / 2047 }],
      bridges: [{ from: 0, to: 1, ford: false }],
    })], target, { ...CLEAN, bridgeOutlineColor: '#102030', ...extra, byKind: { road: { width: 16 } } })!;
    const layer = bridge();
    const outline = (x: number, dy: number) => layer.bridgeOutline![(64 + dy) * SIZE + x] > 128;
    const deck = (x: number, dy: number) => layer.fill[(64 + dy) * SIZE + x] > 200;
    // A 16px road: the deck matches the road width (edges at +-8) and each side section is a quarter of it (4px, out to +-12).
    expect(outline(110, 8) && outline(110, -8)).toBe(true);
    expect(outline(110, 12) && outline(110, -12)).toBe(true);
    expect(outline(110, 14) || outline(110, -14)).toBe(false);
    // Between the lines is the side section, and the main deck sits in the middle.
    expect(deck(110, 10) && deck(110, -10)).toBe(true);
    expect(outline(110, 10) || outline(110, -10)).toBe(false);
    expect(deck(110, 0) && !outline(110, 0)).toBe(true);
    // Each side section is closed at both ends; the main deck stays open.
    expect(outline(20, 10) && outline(20, -10) && outline(200, 10) && outline(200, -10)).toBe(true);
    expect(outline(20, 0) || outline(200, 0)).toBe(false);
    // Only over the water: nothing is drawn out onto the banks.
    expect(layer.bridgeOutline![(64 + 10) * SIZE + 16]).toBe(0);
    expect(layer.bridgeOutline![(64 + 10) * SIZE + 204]).toBe(0);
    // The outline has its own colour and is not part of the road ink.
    expect(layer.bridgeOutlineColor).toEqual([16, 32, 48]);
    expect(layer.ink[(64 + 10) * SIZE + 110]).toBe(0);
  });

  it('sets the bridge outline thickness with the width setting', () => {
    const thickness = (bridgeOutlineWidth: number) => {
      const layer = rasterizeRoadLayer([road({
        points: [{ u: 20 / 2047, v: 64 / 2047 }, { u: 200 / 2047, v: 64 / 2047 }],
        bridges: [{ from: 0, to: 1, ford: false }],
      })], target, { ...CLEAN, bridgeOutlineWidth, byKind: { road: { width: 16 } } })!;
      // Coverage across the upper outer edge line, summed over the column.
      return Array.from({ length: 5 }, (_, i) => layer.bridgeOutline![(64 - 15 + i) * SIZE + 110])
        .reduce((sum, value) => sum + value / 255, 0);
    };
    expect(thickness(1)).toBeCloseTo(1, 0);
    expect(thickness(3)).toBeCloseTo(3, 0);
  });
});

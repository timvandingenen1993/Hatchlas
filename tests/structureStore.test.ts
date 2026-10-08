import { describe, expect, it } from 'vitest';
import {
  parseStoredStructures,
  saveStoredStructures,
  STRUCTURES_STORAGE_KEY,
  type StoredStructures,
} from '../src/structures/structureStore';
import { DEFAULT_ROAD_STYLE, DEFAULT_ROUTING_SETTINGS, DEFAULT_TOWN_STYLE } from '../src/structures/types';

describe('structure store', () => {
  it('round-trips roads, towns and routing settings', () => {
    const stored: StoredStructures = {
      version: 1,
      maps: {
        'nz-linz-dem.tif': {
          roads: [{
            id: 'road_1',
            name: 'King\'s Way',
            kind: 'highway',
            color: '#553311',
            lineStyle: 'dotted',
            widthScale: 1.5,
            visible: true,
            waypoints: [{ id: 'w1', u: 0.1, v: 0.2 }, { id: 'w2', u: 0.8, v: 0.7 }],
          }],
          towns: [{
            id: 'town_1',
            name: 'Highmere',
            subtitle: 'Market town',
            u: 0.4,
            v: 0.5,
            iconId: 'settlement:walled-town',
            seed: 1234,
            size: 40,
            labelPosition: 'right',
            showLabel: true,
          }],
        },
      },
      routing: { ...DEFAULT_ROUTING_SETTINGS, maxGradePct: 9, forestAvoidance: 2 },
      roadStyle: { ...DEFAULT_ROAD_STYLE, outline: true, outlineColor: '#ffffff', clearance: 6 },
      townStyle: { ...DEFAULT_TOWN_STYLE, font: 'garamond', uppercase: true, letterSpacing: 0.12 },
    };
    const written = new Map<string, string>();
    expect(saveStoredStructures(stored, { setItem: (key, value) => written.set(key, value) })).toBeNull();
    expect(parseStoredStructures(written.get(STRUCTURES_STORAGE_KEY) ?? null)).toEqual(stored);
  });

  it('falls back to empty data for malformed or foreign input', () => {
    const empty = {
      version: 1,
      maps: {},
      routing: DEFAULT_ROUTING_SETTINGS,
      roadStyle: DEFAULT_ROAD_STYLE,
      townStyle: DEFAULT_TOWN_STYLE,
    };
    expect(parseStoredStructures(null)).toEqual(empty);
    expect(parseStoredStructures('{not json')).toEqual(empty);
    expect(parseStoredStructures(JSON.stringify({ version: 7, maps: {} }))).toEqual(empty);
  });

  it('drops invalid entries and clamps values', () => {
    const parsed = parseStoredStructures(JSON.stringify({
      version: 1,
      maps: {
        a: {
          roads: [{ id: 'r', waypoints: [{ id: 'w', u: 3, v: -1 }, { u: 0.5 }], kind: 'canal' }, 'junk'],
          towns: [{ id: 't', u: 0.2, v: 0.3, size: 9999 }, { name: 'no position' }],
        },
      },
      routing: { maxGradePct: 500, allowFords: 'yes' },
    }));
    expect(parsed.maps.a.roads).toHaveLength(1);
    expect(parsed.maps.a.roads[0].kind).toBe('road');
    expect(parsed.maps.a.roads[0].waypoints).toEqual([{ id: 'w', u: 1, v: 0 }]);
    expect(parsed.maps.a.towns).toHaveLength(1);
    expect(parsed.maps.a.towns[0].size).toBe(160);
    expect(parsed.routing.maxGradePct).toBe(30);
    expect(parsed.routing.allowFords).toBe(DEFAULT_ROUTING_SETTINGS.allowFords);
  });

  it('gives towns saved without a seed a stable one and renames the walled town icon', () => {
    const raw = JSON.stringify({
      version: 1,
      maps: { a: { roads: [], towns: [
        { id: 'town_a', u: 0.2, v: 0.3, iconId: 'builtin:walled-town' },
        { id: 'town_b', u: 0.4, v: 0.3 },
        { id: 'town_c', u: 0.5, v: 0.3, iconId: 'builtin:town' },
        { id: 'town_d', u: 0.6, v: 0.3, iconId: 'builtin:castle' },
      ] } },
    });
    const [first, second, third, fourth] = parseStoredStructures(raw).maps.a.towns;
    // The old flat symbols map onto settlements of the same kind.
    expect(third.iconId).toBe('settlement:walled-town');
    expect(fourth.iconId).toBe('settlement:castle');
    expect(first.iconId).toBe('settlement:walled-town');
    expect(second.iconId).toBe('settlement:village');
    expect(first.seed).not.toBe(second.seed);
    expect(parseStoredStructures(raw).maps.a.towns.slice(0, 2).map((town) => town.seed)).toEqual([first.seed, second.seed]);
  });

  it('reports a full storage instead of throwing', () => {
    const quota = new Error('full');
    quota.name = 'QuotaExceededError';
    const message = saveStoredStructures(parseStoredStructures(null), {
      setItem: () => { throw quota; },
    });
    expect(message).toMatch(/full/);
  });
});

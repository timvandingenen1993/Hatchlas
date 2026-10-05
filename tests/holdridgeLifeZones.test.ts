import { describe, expect, it } from 'vitest';
import {
  HOLDRIDGE_LIFE_ZONES,
  classifyHoldridgeLifeZone,
  holdridgeBiotemperature,
  holdridgeBiotemperatureFromAnnualMean,
  holdridgePetRatio,
} from '../src/terrain/holdridgeLifeZones';

describe('Holdridge life zones', () => {
  it('classifies every core zone centre as that zone', () => {
    for (const zone of HOLDRIDGE_LIFE_ZONES) {
      if (zone.code === 'BaSl') continue;
      // The hexagon centre sits half a log2 step above the lower bounds.
      let biotemperature = zone.abt * Math.SQRT2;
      // Warm temperate and subtropical share a centre (≈17 °C); step to the
      // side of the frost line that belongs to the zone.
      if (zone.code.startsWith('Wt')) biotemperature = 16.5;
      if (zone.code.startsWith('St')) biotemperature = 17.5;
      expect(classifyHoldridgeLifeZone(biotemperature, zone.tap * Math.SQRT2)).toBe(zone.code);
    }
  });

  it('applies the polar, bare-soil and unclassified limits', () => {
    expect(classifyHoldridgeLifeZone(1.0, 300)).toBe('PD');
    expect(classifyHoldridgeLifeZone(0, 300)).toBe('PD');
    expect(classifyHoldridgeLifeZone(20, 50)).toBe('BaSl');
  });

  it('computes biotemperature and the PET ratio as Holdridge defines them', () => {
    // Months below 0 °C or above 30 °C count as 0.
    expect(holdridgeBiotemperature([-5, 10, 20, 35])).toBeCloseTo(7.5);
    // PET = 58.93 × biotemperature.
    expect(holdridgePetRatio(12, 500)).toBeCloseTo(1.414, 3);
  });

  it('keeps annual means above 30 °C in the hottest belt instead of polar desert', () => {
    expect(holdridgeBiotemperatureFromAnnualMean(47)).toBe(30);
    expect(holdridgeBiotemperatureFromAnnualMean(-4)).toBe(0);
    expect(holdridgeBiotemperatureFromAnnualMean(12)).toBe(12);
    expect(classifyHoldridgeLifeZone(holdridgeBiotemperatureFromAnnualMean(47), 94)).toBe('TD');
  });
});

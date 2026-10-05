import { describe, expect, it } from "vitest";
import { committedNumber, manualLimits, sliderFraction, sliderValue } from "../src/components/NumericControl";

describe("inspector numeric control", () => {
  it("maps positive wide ranges logarithmically and keeps linear fractions", () => {
    expect(sliderValue(0.5, 0.1, 10, true)).toBeCloseTo(1);
    expect(sliderFraction(1, 0.1, 10, true)).toBeCloseTo(0.5);
    expect(sliderValue(0.5, 0, 3)).toBe(1.5);
    expect(sliderValue(0.5, 0, 3000, false, 2)).toBe(750);
  });

  it("commits exact typed values and clamps invalid bounds", () => {
    expect(committedNumber("1.873", 1, 0, 3)).toBe(1.873);
    expect(committedNumber("", 1.873, 0, 3)).toBe(1.873);
    expect(committedNumber("4", 1.873, 0, 3)).toBe(3);
  });

  it("lets typed values leave the slider range within validity limits", () => {
    expect(manualLimits(0, 3)).toEqual([0, Infinity]);
    expect(manualLimits(100, 4000)).toEqual([0, Infinity]);
    expect(manualLimits(-100, 100)).toEqual([-Infinity, Infinity]);
    expect(manualLimits(0.1, 1, "%")).toEqual([0, 1]);
    expect(committedNumber("50", 1400, ...manualLimits(100, 4000))).toBe(50);
    const [min, max] = manualLimits(0, 3);
    expect(committedNumber("12", 1, min, max)).toBe(12);
    expect(committedNumber("-2", 1, min, max)).toBe(0);
  });
});

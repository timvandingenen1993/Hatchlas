import { describe, expect, it } from "vitest";
import { committedNumber, sliderFraction, sliderValue } from "../src/components/NumericControl";

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
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_HELPER_MEMORY_BYTES,
  getExportHelperMemoryBudget,
} from "../src/rendering/exportMemoryBudget";

const GIB = 1024 ** 3;

describe("export helper memory budget", () => {
  it("scales with the reported RAM", () => {
    expect(getExportHelperMemoryBudget(32).bytes).toBeCloseTo(6.4 * GIB);
    expect(getExportHelperMemoryBudget(64).bytes).toBeCloseTo(12.8 * GIB);
    expect(getExportHelperMemoryBudget(128).bytes).toBeCloseTo(24 * GIB);
  });

  it("keeps the old budget when 8 GB may mean 'at least 8' or nothing is reported", () => {
    expect(getExportHelperMemoryBudget(8).bytes).toBe(DEFAULT_EXPORT_HELPER_MEMORY_BYTES);
    expect(getExportHelperMemoryBudget(16).bytes).toBe(DEFAULT_EXPORT_HELPER_MEMORY_BYTES);
    expect(getExportHelperMemoryBudget(undefined)).toEqual({
      bytes: DEFAULT_EXPORT_HELPER_MEMORY_BYTES,
      source: "default",
    });
  });

  it("shrinks on small machines", () => {
    expect(getExportHelperMemoryBudget(4).bytes).toBeCloseTo(1.5 * GIB);
    expect(getExportHelperMemoryBudget(2).bytes).toBeCloseTo(1.5 * GIB);
  });

  it("lets an explicit override win", () => {
    expect(getExportHelperMemoryBudget(8, 20)).toMatchObject({ bytes: 20 * GIB, source: "override" });
    expect(getExportHelperMemoryBudget(32, 0).source).toBe("device memory");
  });
});

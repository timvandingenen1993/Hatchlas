import { describe, expect, it } from "vitest";
import { compareExportSamples } from "../src/rendering/exportTileGpuSampler";
import {
  sampleExportFieldsCpu,
  type ExportFieldSampleRequest,
} from "../src/rendering/mountainExportRenderer";

const field = Float32Array.from({ length: 16 }, (_, index) => index * 10);
const request = (options: Partial<ExportFieldSampleRequest> = {}): ExportFieldSampleRequest => ({
  source: field,
  sourceWidth: 4,
  sourceHeight: 4,
  x: 0,
  y: 0,
  width: 8,
  height: 8,
  ...options,
});

describe("export tile field sampling", () => {
  it("returns the requested types and keeps precise samples in double precision", () => {
    const [plain, precise, categorical, signed] = sampleExportFieldsCpu([
      request(),
      request({ precise: true }),
      request({ nearest: true, output: "u8" }),
      request({ nearest: true, output: "i8" }),
    ], 8, 8);
    expect(plain).toBeInstanceOf(Float32Array);
    expect(precise).toBeInstanceOf(Float64Array);
    expect(categorical).toBeInstanceOf(Uint8Array);
    expect(signed).toBeInstanceOf(Int8Array);
    // Corners map exactly onto source corners.
    expect(precise[0]).toBe(0);
    expect(precise[63]).toBe(150);
    expect(categorical[63]).toBe(150);
  });

  it("accepts float32 rounding but rejects any categorical or larger difference", () => {
    const requests = [request(), request({ nearest: true, output: "u8" })];
    const cpu = sampleExportFieldsCpu(requests, 8, 8);
    const rounded = cpu.map(values => values.slice());
    rounded[0][5] = Math.fround(rounded[0][5] * (1 + 1e-7));
    expect(compareExportSamples(requests, cpu, rounded)).toEqual({
      maxRelativeError: expect.any(Number),
      nearestMismatches: 0,
    });
    expect(compareExportSamples(requests, cpu, rounded).maxRelativeError).toBeLessThan(1e-4);

    const wrong = cpu.map(values => values.slice());
    wrong[1][3] += 1;
    wrong[0][7] *= 1.01;
    const comparison = compareExportSamples(requests, cpu, wrong);
    expect(comparison.nearestMismatches).toBe(1);
    expect(comparison.maxRelativeError).toBeGreaterThan(1e-4);
  });
});

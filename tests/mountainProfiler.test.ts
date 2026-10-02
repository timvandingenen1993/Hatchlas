import { expect, it } from "vitest";
import { MountainProfiler } from "../src/rendering/mountainProfiler";

it("starts a clean profiling request when a profiler is reused", () => {
  const profiler = new MountainProfiler(true, { requestId: 1 });
  profiler.measure("placement generation", () => undefined);
  const first = profiler.finish("completed", false);

  expect(first?.stages.map((stage) => stage.stage)).toEqual([
    "placement generation",
  ]);

  profiler.reset({ requestId: 2, layer: "forest-props" });
  profiler.measure("lighting textures", () => undefined);
  const second = profiler.finish("completed", false);

  expect(second?.requestId).toBe(2);
  expect(second?.layer).toBe("forest-props");
  expect(second?.stages.map((stage) => stage.stage)).toEqual([
    "lighting textures",
  ]);
});

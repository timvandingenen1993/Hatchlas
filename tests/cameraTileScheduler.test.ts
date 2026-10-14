import { describe, expect, it } from "vitest";
import { CameraTileScheduler, type CameraTileHelper } from "../src/rendering/cameraTileScheduler";
import { collectArrayBuffers, transferableBuffers } from "../src/rendering/transferables";

interface Job {
  key: string;
  resolve(): void;
  reject(error: Error): void;
}

function setup(options: {
  helpers?: number;
  helperBudget?: number;
  helperBytes?: (key: string) => number;
  lookaheadBudget?: number;
} = {}) {
  const jobs: Job[] = [];
  const cache = new Set<string>();
  const prepared: string[] = [];
  const local: string[] = [];
  const disposed: number[] = [];
  let maxRunning = 0;
  let running = 0;
  const helpers: CameraTileHelper<string, string>[] = Array.from({ length: options.helpers ?? 2 }, (_, id) => ({
    render(key: string): Promise<string> {
      running++;
      maxRunning = Math.max(maxRunning, running);
      return new Promise<string>((resolve, reject) => {
        jobs.push({
          key,
          resolve: () => { running--; resolve(key); },
          reject: (error) => { running--; reject(error); },
        });
      });
    },
    dispose(): void {
      disposed.push(id);
    },
  }));
  const scheduler = new CameraTileScheduler<string, string>({
    helpers,
    prepare: (key) => {
      prepared.push(key);
      return { prepared: key, transfer: [] };
    },
    renderLocally: (key) => {
      local.push(key);
      cache.add(key);
    },
    store: (key) => { cache.add(key); },
    isAvailable: (key) => cache.has(key),
    helperBytes: options.helperBytes ?? (() => 1),
    outputBytes: () => 1,
    cachedBytes: () => cache.size,
    helperBudgetBytes: options.helperBudget ?? 100,
    lookaheadBudgetBytes: options.lookaheadBudget ?? 100,
    cancelled: () => false,
    yieldToEvents: () => Promise.resolve(),
  });
  // Drains every pending continuation; nothing here waits on a timer.
  const settle = async () => {
    for (let turn = 0; turn < 50; turn++) await Promise.resolve();
  };
  const finish = async (key: string) => {
    const index = jobs.findIndex(job => job.key === key);
    if (index < 0) throw new Error("no running job for " + key);
    jobs.splice(index, 1)[0].resolve();
    await settle();
  };
  return {
    scheduler, jobs, cache, prepared, local, disposed, settle, finish,
    get maxRunning() { return maxRunning; },
  };
}

describe("camera tile scheduler", () => {
  it("renders on every helper and prepares one tile ahead while they are busy", async () => {
    const t = setup({ helpers: 3 });
    const done = t.scheduler.ensure(["a", "b", "c", "d", "e"]);
    await t.settle();
    expect(t.jobs.map(job => job.key)).toEqual(["a", "b", "c"]);
    // "d" is already prepared, so a finishing helper starts it at once.
    expect(t.prepared).toEqual(["a", "b", "c", "d"]);
    await t.finish("b");
    expect(t.jobs.map(job => job.key)).toEqual(["a", "c", "d"]);
    expect(t.prepared).toEqual(["a", "b", "c", "d", "e"]);
    for (const key of ["a", "c", "d", "e"]) await t.finish(key);
    await done;
    expect([...t.cache].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("admits tiles by memory, but always lets one oversized tile run", async () => {
    const t = setup({ helpers: 4, helperBudget: 5, helperBytes: key => (key === "big" ? 9 : 2) });
    const done = t.scheduler.ensure(["big", "a", "b", "c"]);
    await t.settle();
    expect(t.jobs.map(job => job.key)).toEqual(["big"]);
    await t.finish("big");
    expect(t.jobs.map(job => job.key)).toEqual(["a", "b"]);
    await t.finish("a");
    await t.finish("b");
    await t.finish("c");
    await done;
    expect(t.maxRunning).toBe(2);
  });

  it("puts required tiles before tiles rendered ahead", async () => {
    const t = setup({ helpers: 1 });
    t.scheduler.prefetch(["p1", "p2", "p3"]);
    await t.settle();
    expect(t.jobs.map(job => job.key)).toEqual(["p1"]);
    const done = t.scheduler.ensure(["now"]);
    await t.finish("p1");
    // p2 was prepared ahead before "now" was requested, so it runs first.
    expect(t.jobs.map(job => job.key)).toEqual(["p2"]);
    await t.finish("p2");
    expect(t.jobs.map(job => job.key)).toEqual(["now"]);
    await t.finish("now");
    await done;
    expect(t.jobs.map(job => job.key)).toEqual(["p3"]);
  });

  it("stops rendering ahead at the look-ahead budget and resumes when the cache shrinks", async () => {
    const t = setup({ helpers: 4, lookaheadBudget: 2 });
    t.scheduler.prefetch(["a", "b", "c", "d"]);
    await t.settle();
    expect(t.jobs.map(job => job.key)).toEqual(["a", "b"]);
    await t.finish("a");
    await t.finish("b");
    expect(t.jobs).toHaveLength(0);
    t.cache.delete("a");
    t.cache.delete("b");
    t.scheduler.resume();
    await t.settle();
    expect(t.jobs.map(job => job.key)).toEqual(["c", "d"]);
  });

  it("retries a failed tile on another helper and renders locally once none are left", async () => {
    const t = setup({ helpers: 2 });
    const done = t.scheduler.ensure(["a", "b", "c"]);
    await t.settle();
    t.jobs.splice(0, 1)[0].reject(new Error("helper crashed"));
    await t.settle();
    expect(t.disposed).toEqual([1]);
    t.jobs.splice(0, 1)[0].reject(new Error("helper crashed"));
    await t.settle();
    await done;
    expect(t.disposed).toEqual([1, 0]);
    expect(t.local.sort()).toEqual(["a", "b", "c"]);
  });

  it("waits for a tile still being prepared instead of preparing it twice", async () => {
    let releasePreparation!: () => void;
    const prepared: string[] = [];
    const cache = new Set<string>();
    const jobs: Array<{ key: string; resolve(): void }> = [];
    const scheduler = new CameraTileScheduler<string, string>({
      helpers: [{
        render: (key) => new Promise<string>(resolve => jobs.push({ key, resolve: () => resolve(key) })),
        dispose: () => {},
      }],
      prepare: async (key) => {
        prepared.push(key);
        await new Promise<void>(resolve => { releasePreparation = resolve; });
        return { prepared: key, transfer: [] };
      },
      renderLocally: () => {},
      store: (key) => { cache.add(key); },
      isAvailable: (key) => cache.has(key),
      helperBytes: () => 1,
      outputBytes: () => 1,
      cachedBytes: () => cache.size,
      helperBudgetBytes: 10,
      lookaheadBudgetBytes: 10,
      cancelled: () => false,
      yieldToEvents: () => Promise.resolve(),
    });
    const settle = async () => {
      for (let turn = 0; turn < 50; turn++) await Promise.resolve();
    };
    scheduler.prefetch(["a"]);
    await settle();
    let finished = false;
    const done = scheduler.ensure(["a"]).then(() => { finished = true; });
    await settle();
    releasePreparation();
    await settle();
    expect(jobs.map(job => job.key)).toEqual(["a"]);
    // Not ready until the helper delivers the tile.
    expect(finished).toBe(false);
    jobs[0].resolve();
    await done;
    expect(finished).toBe(true);
    expect(prepared).toEqual(["a"]);
  });

  it("retries a tile that ran out of memory once running tiles finish", async () => {
    const jobs: Array<{ key: string; resolve(): void }> = [];
    const cache = new Set<string>();
    const prepared: string[] = [];
    const pressure: number[] = [];
    const recovered: number[] = [];
    let failNext = false;
    const scheduler = new CameraTileScheduler<string, string>({
      helpers: [0, 1].map(() => ({
        render: (key: string) => new Promise<string>(resolve => jobs.push({ key, resolve: () => resolve(key) })),
        dispose: () => {},
      })),
      prepare: (key) => {
        prepared.push(key);
        if (failNext) {
          failNext = false;
          throw new RangeError("Array buffer allocation failed");
        }
        return { prepared: key, transfer: [] };
      },
      renderLocally: () => {},
      store: (key) => { cache.add(key); },
      isAvailable: (key) => cache.has(key),
      helperBytes: () => 1,
      outputBytes: () => 1,
      cachedBytes: () => cache.size,
      helperBudgetBytes: 8,
      lookaheadBudgetBytes: 100,
      cancelled: () => false,
      yieldToEvents: () => Promise.resolve(),
      isOutOfMemory: (error) => error instanceof RangeError,
      onMemoryPressure: (_key, _error, budget) => { pressure.push(budget); },
      onBudgetRecovered: (budget) => { recovered.push(budget); },
    });
    const settle = async () => {
      for (let turn = 0; turn < 50; turn++) await Promise.resolve();
    };
    const done = scheduler.ensure(["a"]);
    await settle();
    expect(jobs.map(job => job.key)).toEqual(["a"]);
    failNext = true;
    const second = scheduler.ensure(["b"]);
    await settle();
    // "b" failed to prepare: no abort, budget halved, nothing new dispatched yet.
    expect(pressure).toEqual([4]);
    expect(jobs.map(job => job.key)).toEqual(["a"]);
    jobs[0].resolve();
    await done;
    await settle();
    expect(jobs.map(job => job.key)).toEqual(["a", "b"]);
    jobs[1].resolve();
    await second;
    expect(prepared).toEqual(["a", "b", "b"]);
    // Four clean tiles later the budget is back where it started.
    for (const key of ["c", "d"]) {
      const next = scheduler.ensure([key]);
      await settle();
      jobs[jobs.length - 1].resolve();
      await next;
    }
    expect(recovered).toEqual([8]);
  });

  it("keeps a helper that ran out of memory and retries its tile", async () => {
    const t = setup({ helpers: 1 });
    const done = t.scheduler.ensure(["a"]);
    await t.settle();
    t.jobs.splice(0, 1)[0].reject(new Error("Array buffer allocation failed"));
    await t.settle();
    // Default setup has no isOutOfMemory hook, so this one is retired...
    expect(t.disposed).toEqual([0]);
    await done;

    let outOfMemory = 0;
    const jobs: Array<{ key: string; resolve(): void; reject(error: Error): void }> = [];
    const cache = new Set<string>();
    const disposed: number[] = [];
    const scheduler = new CameraTileScheduler<string, string>({
      helpers: [{
        render: (key) => new Promise<string>((resolve, reject) =>
          jobs.push({ key, resolve: () => resolve(key), reject })),
        dispose: () => { disposed.push(0); },
      }],
      prepare: (key) => ({ prepared: key, transfer: [] }),
      renderLocally: () => {},
      store: (key) => { cache.add(key); },
      isAvailable: (key) => cache.has(key),
      helperBytes: () => 1,
      outputBytes: () => 1,
      cachedBytes: () => cache.size,
      helperBudgetBytes: 8,
      lookaheadBudgetBytes: 100,
      cancelled: () => false,
      yieldToEvents: () => Promise.resolve(),
      isOutOfMemory: (error) => error instanceof Error && /allocation failed/.test(error.message),
      onMemoryPressure: () => { outOfMemory++; },
    });
    const retried = scheduler.ensure(["b"]);
    await t.settle();
    jobs[0].reject(new Error("Array buffer allocation failed"));
    await t.settle();
    // ...but with the hook the same helper stays and renders the tile again.
    expect(disposed).toEqual([]);
    expect(outOfMemory).toBe(1);
    expect(jobs.map(job => job.key)).toEqual(["b", "b"]);
    jobs[1].resolve();
    await retried;
  });

  it("renders everything locally without helpers", async () => {
    const t = setup({ helpers: 0 });
    t.scheduler.prefetch(["ahead"]);
    await t.scheduler.ensure(["a", "b"]);
    expect(t.local).toEqual(["a", "b"]);
  });
});

describe("transferable buffers", () => {
  it("transfers tile buffers but never buffers the sender keeps", () => {
    const shared = new Float32Array(4);
    const context = { dem: { elevation: shared }, assets: [{ mask: new Uint8Array(2) }] };
    const own = new Float32Array(8);
    const ownView = new Uint8Array(own.buffer, 4, 4);
    const payload = {
      tileDem: { elevation: own, alias: ownView, globalField: shared },
      options: { ...context, override: new Uint8Array(3), numbers: [1, 2, 3] },
      empty: new Float32Array(0),
    };
    const retained = collectArrayBuffers(context);
    const transfer = transferableBuffers(payload, retained);
    expect(transfer).toHaveLength(2);
    expect(transfer).toContain(own.buffer);
    expect(transfer).toContain(payload.options.override.buffer);
    expect(transfer).not.toContain(shared.buffer);
  });
});

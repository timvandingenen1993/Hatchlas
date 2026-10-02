import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveMountainLayerTransferTimings,
  MountainLayerWorkerCancelledError,
  MountainLayerWorkerPool,
} from "../src/rendering/mountainLayerWorkerPool";

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: unknown[] = [];

  constructor(..._args: unknown[]) {
    TestWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {}

  emitReady(readyAt = 100): void {
    this.onmessage?.({ data: { type: "ready", readyAt } } as MessageEvent);
  }

  emitError(error: Error): void {
    this.onerror?.({ error, message: error.message } as ErrorEvent);
  }
}

afterEach(() => {
  TestWorker.instances.length = 0;
  vi.unstubAllGlobals();
});

describe("mountain layer worker timing contracts", () => {
  it("separates dispatch, scheduling, worker, and output transfer time", () => {
    expect(deriveMountainLayerTransferTimings({
      queuedAt: 100,
      postedAt: 120,
      postReturnedAt: 125,
      workerStartedAt: 145,
      workerPostedAt: 195,
      receivedAt: 230,
      workerMs: 50,
    })).toEqual({
      wallMs: 130,
      queueMs: 80,
      inputTransferMs: 5,
      workerSchedulingMs: 20,
      outputTransferMs: 35,
    });
  });

  it("keeps the warmup and preparation fallback safe without Worker support", async () => {
    const pool = new MountainLayerWorkerPool({ maxWorkers: 1 });
    await expect(pool.warmup()).resolves.toBeUndefined();
    expect(pool.available).toBe(false);
    expect(await pool.prepare({} as never, {} as never)).toBeNull();
    pool.dispose();
  });

  it("waits for the ready handshake before dispatching work", async () => {
    vi.stubGlobal("Worker", TestWorker as unknown as typeof Worker);
    const pool = new MountainLayerWorkerPool({ maxWorkers: 1 });
    const worker = TestWorker.instances[0];
    expect(worker).toBeDefined();

    let resolved = false;
    const warmup = pool.warmup().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    worker!.emitReady();
    await warmup;
    expect(resolved).toBe(true);
    expect(worker!.messages).toEqual([]);
    pool.dispose();
  });

  it("cancels before readiness without cloning or dispatching a snapshot", async () => {
    vi.stubGlobal("Worker", TestWorker as unknown as typeof Worker);
    const pool = new MountainLayerWorkerPool({ maxWorkers: 1 });
    const worker = TestWorker.instances[0];
    await expect(pool.prepare(
      {} as never,
      {} as never,
      { isCancelled: () => true },
    )).rejects.toBeInstanceOf(MountainLayerWorkerCancelledError);
    expect(worker!.messages).toEqual([]);
    pool.dispose();
  });

  it("disables the pool and exposes fallback after bootstrap failure", async () => {
    vi.stubGlobal("Worker", TestWorker as unknown as typeof Worker);
    const pool = new MountainLayerWorkerPool({ maxWorkers: 1 });
    const worker = TestWorker.instances[0];
    const warmup = pool.warmup();
    worker!.emitError(new Error("worker bootstrap failed"));
    await expect(warmup).rejects.toThrow("worker bootstrap failed");
    expect(pool.available).toBe(false);
    expect(await pool.prepare({} as never, {} as never)).toBeNull();
    pool.dispose();
  });
});

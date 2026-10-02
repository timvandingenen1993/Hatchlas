/**
 * Runs the WebGPU mountain-field backend in its own worker; falls back to the in-thread backend.
 */
import { MountainFieldGpuCancelledError, type MountainFieldGpuPrepareControl } from "./mountainFieldGpu";
import {
  createMountainIllustrationFieldBackend,
  type MountainIllustrationFieldBackend,
  type MountainIllustrationFieldExperimentOptions,
  type MountainIllustrationFieldPreparationResult,
} from "./mountainIllustrationGpuExperiment";
import type {
  MountainFieldWorkerRequest,
  MountainFieldWorkerResponse,
  MountainFieldWorkerTimings,
} from "./mountainFieldBackend.worker";

type WindResult = Awaited<ReturnType<MountainIllustrationFieldBackend["prepareWindFields"]>>;
type WorkerReport = NonNullable<MountainIllustrationFieldPreparationResult["report"]["fieldWorker"]>;
interface WorkerReply<T> {
  result: T;
  timings: MountainFieldWorkerTimings;
}

interface PendingRequest {
  resolve: (value: never) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setInterval>;
}

/**
 * Runs the WebGPU field backend in its own worker. Its device and pipeline
 * setup then proceeds on a free event loop while the owner is busy with long
 * synchronous stages, instead of stalling until the owner next yields.
 *
 * Returns null where workers are unavailable, so the caller keeps the
 * in-thread backend. If the worker fails, or WebGPU turns out to be missing,
 * preparation continues on an in-thread CPU backend (which also keeps the
 * owner field cache).
 */
export function createWorkerMountainFieldBackend(
  options: Pick<MountainIllustrationFieldExperimentOptions, "gpu" | "disableGpuOnFailure"> = {},
): MountainIllustrationFieldBackend | null {
  if (typeof Worker === "undefined") return null;
  let worker: Worker | null = null;
  let nextId = 1;
  let disposed = false;
  let useFallback = false;
  let fallbackReason: string | undefined;
  let fallback: MountainIllustrationFieldBackend | null = null;
  let createdAt = 0;
  const pending = new Map<number, PendingRequest>();

  const describeTimings = (timings: MountainFieldWorkerTimings): WorkerReport => {
    const setupDoneAt = timings.setupDoneAt ?? timings.requestReceivedAt;
    return {
      loadMs: Math.max(0, timings.startedAt - createdAt),
      setupMs: Math.max(0, setupDoneAt - (timings.setupStartedAt ?? timings.startedAt)),
      slackMs: timings.requestReceivedAt - setupDoneAt,
    };
  };

  const settle = (id: number, outcome: { result: unknown } | { error: unknown }): void => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearInterval(request.timer);
    if ("error" in outcome) request.reject(outcome.error);
    else request.resolve(outcome.result as never);
  };
  const failWorker = (error: unknown): void => {
    try { worker?.terminate(); } catch { /* already stopped */ }
    worker = null;
    useFallback = true;
    fallbackReason ??= error instanceof Error ? error.message : String(error);
    for (const id of [...pending.keys()]) settle(id, { error });
  };
  const ensureWorker = (): Worker | null => {
    if (worker || disposed || useFallback) return worker;
    try {
      createdAt = performance.timeOrigin + performance.now();
      const created = new Worker(new URL("./mountainFieldBackend.worker.ts", import.meta.url), {
        type: "module",
      });
      created.onmessage = (event: MessageEvent<MountainFieldWorkerResponse>) => {
        const message = event.data;
        if (message.type === "result") {
          settle(message.id, { result: { result: message.result, timings: message.timings } });
        }
        else {
          settle(message.id, {
            error: message.cancelled ? new MountainFieldGpuCancelledError() : new Error(message.message),
          });
        }
      };
      created.onerror = event => failWorker(new Error(event.message || "Field worker failed"));
      created.postMessage({
        type: "init",
        gpu: options.gpu,
        disableGpuOnFailure: options.disableGpuOnFailure,
      } satisfies MountainFieldWorkerRequest);
      worker = created;
    } catch (error) {
      failWorker(error);
    }
    return worker;
  };
  const send = <T>(
    build: (id: number) => MountainFieldWorkerRequest,
    control: MountainFieldGpuPrepareControl,
  ): Promise<T> => {
    const active = ensureWorker();
    if (!active) return Promise.reject(new Error(fallbackReason ?? "Field worker unavailable"));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      // The worker cannot see the owner cancellation flag, so mirror it.
      const timer = setInterval(() => {
        if (!control.isCancelled?.()) return;
        active.postMessage({ type: "cancel", id } satisfies MountainFieldWorkerRequest);
        settle(id, { error: new MountainFieldGpuCancelledError() });
      }, 16);
      pending.set(id, { resolve: resolve as (value: never) => void, reject, timer });
      active.postMessage(build(id));
    });
  };
  const getFallback = (): MountainIllustrationFieldBackend =>
    fallback ??= createMountainIllustrationFieldBackend({ backend: "cpu" });
  const isCancel = (error: unknown): boolean => error instanceof MountainFieldGpuCancelledError;

  return {
    get gpuDisabled(): boolean {
      return useFallback;
    },

    async prepare(inputs, fieldCache, control = {}): Promise<MountainIllustrationFieldPreparationResult> {
      if (!useFallback) {
        try {
          const reply = await send<WorkerReply<MountainIllustrationFieldPreparationResult>>(
            id => ({ type: "prepare", id, inputs }),
            control,
          );
          const result = {
            ...reply.result,
            report: { ...reply.result.report, fieldWorker: describeTimings(reply.timings) },
          };
          if (result.report.backend === "cpu") {
            // No WebGPU: later preparations run here, where the field cache applies.
            useFallback = true;
            fallbackReason ??= result.report.fallbackReason;
          }
          return result;
        } catch (error) {
          if (isCancel(error) || control.isCancelled?.()) throw error;
          failWorker(error);
        }
      }
      const result = await getFallback().prepare(inputs, fieldCache, control);
      return fallbackReason && !result.report.fallbackReason
        ? { ...result, report: { ...result.report, fallbackReason } }
        : result;
    },

    async prepareWindFields(dem, windAzimuthDeg, control = {}): Promise<WindResult> {
      if (!useFallback) {
        try {
          const reply = await send<WorkerReply<WindResult>>(
            id => ({
              type: "wind",
              id,
              windAzimuthDeg,
              dem: {
                width: dem.width,
                height: dem.height,
                elevation: dem.elevation,
                dxMeters: dem.dxMeters,
                dyMeters: dem.dyMeters,
              },
            }),
            control,
          );
          return {
            ...reply.result,
            report: { ...reply.result.report, fieldWorker: describeTimings(reply.timings) },
          };
        } catch (error) {
          if (isCancel(error) || control.isCancelled?.()) throw error;
          failWorker(error);
        }
      }
      return getFallback().prepareWindFields(dem, windAzimuthDeg, control);
    },

    warmup(): void {
      ensureWorker();
    },

    dispose(): void {
      disposed = true;
      for (const id of [...pending.keys()]) settle(id, { error: new MountainFieldGpuCancelledError() });
      try { worker?.terminate(); } catch { /* already stopped */ }
      worker = null;
      fallback?.dispose();
      fallback = null;
    },
  };
}

import type { MountainDEMData } from "../terrain/mountainBaseDEM";
import {
  createMountainIllustrationFieldBackend,
  type MountainIllustrationFieldBackend,
  type MountainIllustrationFieldExperimentOptions,
} from "./mountainIllustrationGpuExperiment";
import type { MountainIllustrationFieldInputs } from "./mountainIllustrationFields";

/** The only DEM fields wind preparation reads, so the only ones sent over. */
export interface MountainWindFieldSource {
  width: number;
  height: number;
  elevation: Float32Array;
  dxMeters: number;
  dyMeters: number;
}

export type MountainFieldWorkerRequest =
  | {
    type: "init";
    gpu: MountainIllustrationFieldExperimentOptions["gpu"];
    disableGpuOnFailure?: boolean;
  }
  | { type: "prepare"; id: number; inputs: MountainIllustrationFieldInputs }
  | { type: "wind"; id: number; dem: MountainWindFieldSource; windAzimuthDeg: number }
  | { type: "cancel"; id: number };

/** Absolute clock marks (ms), comparable with the owner thread. */
export interface MountainFieldWorkerTimings {
  /** Module finished loading. */
  startedAt: number;
  setupStartedAt?: number;
  setupDoneAt?: number;
  requestReceivedAt: number;
}

export type MountainFieldWorkerResponse =
  | { type: "result"; id: number; result: unknown; timings: MountainFieldWorkerTimings }
  | { type: "error"; id: number; message: string; cancelled: boolean };

const absoluteNow = (): number => performance.timeOrigin + performance.now();
const startedAt = absoluteNow();
let setupStartedAt: number | undefined;
let setupDoneAt: number | undefined;
let backend: MountainIllustrationFieldBackend | null = null;
const cancelled = new Set<number>();

function collectTransferables(value: unknown, transfers: Transferable[], seen: Set<ArrayBuffer>): void {
  if (!value || typeof value !== "object") return;
  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer;
    if (buffer instanceof ArrayBuffer && !seen.has(buffer)) {
      seen.add(buffer);
      transfers.push(buffer);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTransferables(item, transfers, seen);
    return;
  }
  for (const child of Object.values(value)) collectTransferables(child, transfers, seen);
}

self.onmessage = (event: MessageEvent<MountainFieldWorkerRequest>) => {
  const message = event.data;
  if (message.type === "init") {
    // Setup starts immediately and runs while the owner is busy elsewhere.
    backend = createMountainIllustrationFieldBackend({
      backend: "auto",
      gpu: message.gpu,
      disableGpuOnFailure: message.disableGpuOnFailure,
    });
    setupStartedAt = absoluteNow();
    void Promise.resolve(backend.warmup?.()).then(() => { setupDoneAt = absoluteNow(); });
    return;
  }
  if (message.type === "cancel") {
    cancelled.add(message.id);
    return;
  }
  const { id } = message;
  const requestReceivedAt = absoluteNow();
  const respondError = (error: unknown): void => {
    self.postMessage({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
      cancelled: typeof error === "object" && error !== null && "cancelled" in error
        && Boolean((error as { cancelled?: unknown }).cancelled),
    } satisfies MountainFieldWorkerResponse);
  };
  if (!backend) {
    respondError(new Error("Field worker is not initialized"));
    return;
  }
  const control = { isCancelled: () => cancelled.has(id) };
  const work = message.type === "prepare"
    // The owner CPU field cache cannot cross threads; it only serves the
    // CPU fallback, which the owner keeps in its own thread.
    ? backend.prepare(message.inputs, undefined, control)
    : backend.prepareWindFields(message.dem as unknown as MountainDEMData, message.windAzimuthDeg, control);
  void work
    .then(result => {
      const transfers: Transferable[] = [];
      collectTransferables(result, transfers, new Set<ArrayBuffer>());
      self.postMessage({
        type: "result",
        id,
        result,
        timings: { startedAt, setupStartedAt, setupDoneAt, requestReceivedAt },
      } satisfies MountainFieldWorkerResponse, { transfer: transfers });
    }, respondError)
    .finally(() => cancelled.delete(id));
};

/**
 * Worker entry that runs the spherical world simulation and reports progress to the UI.
 */
import type { WorkerRequest, WorkerResponse } from '../types/workerMessages';
import { runTectonicsOnlySimulation } from './tectonicsOnlyRunner';

let isCancelled = false;

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  if (msg.type === 'CANCEL_SIMULATION') {
    isCancelled = true;
    const resp: WorkerResponse = { type: 'CANCELLED' };
    self.postMessage(resp);
    return;
  }

  if (msg.type === 'GENERATE_WORLD') {
    isCancelled = false;
    const startTime = performance.now();
    console.log(`%c[Worker] 🚀 Simulation started (N=${msg.config.faceResolution}, Plates=${msg.config.plateCount})`, 'color: #06b6d4; font-weight: bold;');

    try {
      const { world } = await runTectonicsOnlySimulation(
        msg.config,
        (stageName, stageIndex, totalStages, stageProgress, overallProgress) => {
          const elapsed = performance.now() - startTime;
          console.log(`[Worker] Stage ${stageIndex}/${totalStages}: ${stageName} (${Math.round(stageProgress * 100)}%) - ${elapsed.toFixed(1)}ms elapsed`);
          const progMsg: WorkerResponse = {
            type: 'PROGRESS',
            stageName,
            stageIndex,
            totalStages,
            stageProgress,
            overallProgress,
            elapsedMs: elapsed,
            memoryMB: worldMemoryEstimateMB(msg.config.faceResolution),
          };
          self.postMessage(progMsg);
        },
        () => isCancelled
      );

      if (isCancelled) {
        const cancelMsg: WorkerResponse = { type: 'CANCELLED' };
        self.postMessage(cancelMsg);
        return;
      }

      const simDurationMs = performance.now() - startTime;
      console.log(`%c[Worker] 🏁 Simulation completed in ${simDurationMs.toFixed(2)}ms`, 'color: #10b981; font-weight: bold;');

      const successMsg: WorkerResponse = {
        type: 'SUCCESS',
        world,
        simDurationMs,
      };

      const transferBuffers = collectTransferableBuffers(world);
      successMsg.transferBufferCount = transferBuffers.length;
      const tPost0 = performance.now();
      (self as unknown as {
        postMessage(message: unknown, transfer: ArrayBuffer[]): void;
      }).postMessage(successMsg, transferBuffers);
      console.log(`[Worker] 📤 postMessage(SUCCESS) dispatched in ${(performance.now() - tPost0).toFixed(2)}ms`);
    } catch (err: any) {
      if (isCancelled || err?.message?.includes('cancelled')) {
        const cancelMsg: WorkerResponse = { type: 'CANCELLED' };
        self.postMessage(cancelMsg);
      } else {
        console.error('[Worker] ❌ Simulation error:', err);
        const errMsg: WorkerResponse = {
          type: 'ERROR',
          error: err?.message || 'Unknown simulation error occurred',
        };
        self.postMessage(errMsg);
      }
    }
  }
};

/**
 * Transfer every uniquely-owned typed-array buffer instead of structured-
 * cloning hundreds of megabytes back to the UI thread. Duplicate views and
 * aliases (for example the active final snapshot) are transferred only once.
 */
function collectTransferableBuffers(root: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const visited = new Set<object>();
  const pending: unknown[] = [root];

  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object') continue;
    if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
      continue;
    }
    if (value instanceof ArrayBuffer) {
      buffers.add(value);
      continue;
    }
    if (visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else {
      for (const item of Object.values(value as Record<string, unknown>)) pending.push(item);
    }
  }

  return [...buffers];
}

function worldMemoryEstimateMB(faceResolution: number): number {
  const totalCells = 6 * faceResolution * faceResolution;
  // ~40 Float32Array / Int32Array fields
  return Math.round((totalCells * 4 * 40) / (1024 * 1024));
}

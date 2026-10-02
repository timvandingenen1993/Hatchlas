/**
 * Worker that runs the mountain field/wind GPU benchmark away from the UI thread.
 */
import {
  runMountainFieldGpuBenchmark,
  runMountainWindGpuBenchmark,
  type MountainFieldBenchmarkInput,
  type MountainFieldBenchmarkOptions,
  type MountainWindBenchmarkInput,
} from './mountainFieldGpuBenchmark';

export interface MountainFieldGpuBenchmarkWorkerRequest {
  type: 'benchmark' | 'windBenchmark';
  id: number;
  input: MountainFieldBenchmarkInput | MountainWindBenchmarkInput;
  options?: MountainFieldBenchmarkOptions;
}

export interface MountainFieldGpuBenchmarkWorkerResponse {
  type: 'result' | 'error';
  id: number;
  report?: Awaited<ReturnType<typeof runMountainFieldGpuBenchmark | typeof runMountainWindGpuBenchmark>>;
  message?: string;
}

self.onmessage = (event: MessageEvent<MountainFieldGpuBenchmarkWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'benchmark' && request.type !== 'windBenchmark') return;
  const run = request.type === 'windBenchmark'
    ? runMountainWindGpuBenchmark(request.input as MountainWindBenchmarkInput, request.options)
    : runMountainFieldGpuBenchmark(request.input as MountainFieldBenchmarkInput, request.options);
  void run
    .then(report => {
      self.postMessage({ type: 'result', id: request.id, report } satisfies MountainFieldGpuBenchmarkWorkerResponse);
    })
    .catch((error: unknown) => {
      self.postMessage({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      } satisfies MountainFieldGpuBenchmarkWorkerResponse);
    });
};

/**
 * Cooperative execution support for worker render stages.
 *
 * Render kernels remain synchronous so existing callers keep their API, but
 * long async drivers can checkpoint between row/path batches. The clock is
 * deliberately monotonic and the task yield uses a timer rather than a
 * resolved promise, which gives the worker a chance to receive cancellation.
 */
export interface RenderExecution {
  readonly revision: number;
  cancelled(): boolean;
  checkpoint(force?: boolean): Promise<void>;
}

function yieldToWorker(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function createRenderExecution(
  revision: number,
  isCancelled: () => boolean,
  budgetMs = 8,
): RenderExecution {
  let lastYield = performance.now();
  let currentBudgetMs = Math.max(1, budgetMs);
  return {
    revision,
    cancelled: isCancelled,
    async checkpoint(force = false): Promise<void> {
      if (isCancelled()) return;
      const now = performance.now();
      const elapsed = now - lastYield;
      if (!force && elapsed < currentBudgetMs) return;
      // A batch that overruns the cooperative target should make subsequent
      // checkpoints more frequent without changing the synchronous kernels.
      if (elapsed > 12) currentBudgetMs = Math.max(1, currentBudgetMs * 0.75);
      await yieldToWorker();
      lastYield = performance.now();
      if (isCancelled()) return;
    },
  };
}

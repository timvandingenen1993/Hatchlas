/**
 * Schedules camera source tiles over helper workers.
 *
 * The export worker is the only place a tile can be prepared, so it is the
 * producer: it prepares one tile ahead while every helper renders, and helpers
 * pick up the next prepared tile the moment they finish. Work is admitted by
 * the memory each tile needs rather than by a fixed helper count, so small
 * interior tiles run side by side while a huge coastal tile runs on its own.
 * Tiles needed later can be rendered ahead within a separate byte budget.
 */

export interface CameraTileHelper<Prepared, Result> {
  render(prepared: Prepared, transfer: Transferable[]): Promise<Result>;
  dispose(): void;
  /**
   * Replaces the helper's worker with a fresh one, releasing everything the
   * old one still held. Resolves false when no new worker could start.
   */
  restart?(): Promise<boolean>;
}

export interface CameraTileSchedulerOptions<Prepared, Result> {
  helpers: CameraTileHelper<Prepared, Result>[];
  /** Builds a tile's helper input (asynchronously when sampled on the GPU). */
  prepare(key: string):
    | { prepared: Prepared; transfer: Transferable[] }
    | Promise<{ prepared: Prepared; transfer: Transferable[] }>;
  /** Renders a tile on this worker when no helper can. */
  renderLocally(key: string): void;
  /** Stores a finished tile; afterwards `isAvailable(key)` must be true. */
  store(key: string, result: Result): void;
  isAvailable(key: string): boolean;
  /** Estimated helper memory while the tile renders. */
  helperBytes(key: string): number;
  /** Bytes a finished tile occupies in the cache. */
  outputBytes(key: string): number;
  /** Bytes the cache holds right now. */
  cachedBytes(): number;
  helperBudgetBytes: number;
  /** Cache bytes that tiles rendered ahead of need may fill. */
  lookaheadBudgetBytes: number;
  cancelled(): boolean;
  /** Lets the event loop deliver helper results between synchronous preparations. */
  yieldToEvents(): Promise<void>;
  onDispatch?(key: string, running: number, queued: number): void;
  onComplete?(key: string, result: Result, elapsedMs: number): void;
  /** Whether a preparation error means memory ran out (retried later, not fatal). */
  isOutOfMemory?(error: unknown): boolean;
  /** Preparing `key` ran out of memory; `helperBudgetBytes` is the reduced budget. */
  onMemoryPressure?(key: string, error: unknown, helperBudgetBytes: number): void;
  /** Preparing `key` ran out of memory with every helper idle; they are restarted. */
  onHelperRestart?(key: string, error: unknown, helperBudgetBytes: number): void;
  /** A reduced budget grew back after clean tiles. */
  onBudgetRecovered?(helperBudgetBytes: number): void;
  /** A helper failed; `helperBudgetBytes` is the reduced budget from now on. */
  onHelperFailure?(key: string, error: unknown, helperBudgetBytes: number): void;
}

interface Waiter {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function createWaiter(): Waiter {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // A waiter nobody awaits (a lookahead tile that failed) must not surface as
  // an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export class CameraTileScheduler<Prepared, Result> {
  private readonly options: CameraTileSchedulerOptions<Prepared, Result>;
  private readonly helpers: CameraTileHelper<Prepared, Result>[];
  private readonly idle: CameraTileHelper<Prepared, Result>[];
  /** Keys waiting to be prepared, required keys first. */
  private readonly queue: string[] = [];
  private readonly required = new Set<string>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly running = new Map<string, number>();
  private staged: { key: string; prepared: Prepared; transfer: Transferable[] } | undefined;
  private runningHelperBytes = 0;
  /** Starts at the configured budget and halves on every helper failure. */
  private helperBudgetBytes: number;
  private pumping = false;
  private pumpAgain = false;
  private preparingKey: string | undefined;
  private lowMemory = false;
  /** Tiles finished since the budget was last reduced. */
  private cleanCompletions = 0;
  /** Clean completions that double a reduced budget again (up to the configured one). */
  private static readonly RECOVERY_COMPLETIONS = 4;
  /** Keys whose preparation already restarted the idle helpers once. */
  private readonly restartedFor = new Set<string>();
  private failure: unknown;

  constructor(options: CameraTileSchedulerOptions<Prepared, Result>) {
    this.options = options;
    this.helperBudgetBytes = options.helperBudgetBytes;
    this.helpers = [...options.helpers];
    this.idle = [...options.helpers];
  }

  get helperCount(): number {
    return this.helpers.length;
  }

  /** Queues tiles to render ahead of need, in the order given. */
  prefetch(keys: Iterable<string>): void {
    for (const key of keys) {
      if (this.isScheduled(key) || this.options.isAvailable(key)) continue;
      this.queue.push(key);
    }
    void this.pump();
  }

  /** Re-checks the budgets, e.g. after the cache released tiles. */
  resume(): void {
    void this.pump();
  }

  /** Resolves once every key is available, rendering missing ones first. */
  async ensure(keys: readonly string[]): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    const pending: Promise<void>[] = [];
    const front: string[] = [];
    for (const key of new Set(keys)) {
      if (this.options.isAvailable(key)) continue;
      if (!this.running.has(key) && this.staged?.key !== key && this.preparingKey !== key) {
        const queuedAt = this.queue.indexOf(key);
        if (queuedAt >= 0) this.queue.splice(queuedAt, 1);
        front.push(key);
      }
      this.required.add(key);
      pending.push(this.waiterFor(key).promise);
    }
    this.queue.unshift(...front);
    if (pending.length === 0) return;
    void this.pump();
    await Promise.all(pending);
  }

  /** Stops scheduling and rejects everything still waiting. */
  abort(error: unknown): void {
    this.failure = error;
    this.queue.length = 0;
    this.staged = undefined;
    for (const waiter of this.waiters.values()) waiter.reject(error);
    this.waiters.clear();
  }

  private isScheduled(key: string): boolean {
    return this.running.has(key)
      || this.staged?.key === key
      || this.preparingKey === key
      || this.queue.includes(key);
  }

  private waiterFor(key: string): Waiter {
    let waiter = this.waiters.get(key);
    if (!waiter) {
      waiter = createWaiter();
      this.waiters.set(key, waiter);
    }
    return waiter;
  }

  private settle(key: string, error?: unknown): void {
    this.required.delete(key);
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    if (error === undefined) waiter.resolve();
    else waiter.reject(error);
  }

  /**
   * A memory shortage is usually one large tile at a bad moment, so a reduced
   * budget doubles again after a run of clean tiles instead of slowing the
   * whole rest of the export.
   */
  private recoverBudget(): void {
    if (this.helperBudgetBytes >= this.options.helperBudgetBytes) return;
    this.cleanCompletions++;
    if (this.cleanCompletions < CameraTileScheduler.RECOVERY_COMPLETIONS) return;
    this.cleanCompletions = 0;
    this.helperBudgetBytes = Math.min(this.options.helperBudgetBytes, this.helperBudgetBytes * 2);
    if (this.helperBudgetBytes >= this.options.helperBudgetBytes) this.lowMemory = false;
    this.options.onBudgetRecovered?.(this.helperBudgetBytes);
  }

  private inFlightOutputBytes(): number {
    let bytes = 0;
    for (const key of this.running.keys()) bytes += this.options.outputBytes(key);
    if (this.staged) bytes += this.options.outputBytes(this.staged.key);
    return bytes;
  }

  private canRunOnHelper(key: string): boolean {
    if (this.idle.length === 0) return false;
    // One tile always runs, however large, so progress never stalls.
    return this.running.size === 0
      || this.runningHelperBytes + this.options.helperBytes(key) <= this.helperBudgetBytes;
  }

  private withinLookahead(key: string): boolean {
    if (this.required.has(key)) return true;
    return this.options.cachedBytes() + this.inFlightOutputBytes() + this.options.outputBytes(key)
      <= this.options.lookaheadBudgetBytes;
  }

  /**
   * The next key to prepare, moved to the queue's front: the first one a band
   * waits for, else the first look-ahead key. Finished keys are dropped.
   * Required keys must win wherever they sit: a look-ahead tile put back at
   * the front after a failure may not fit the look-ahead budget, and stopping
   * there would leave a band waiting with nothing running to wake it.
   */
  private nextKey(): string | undefined {
    let first = -1;
    let index = 0;
    while (index < this.queue.length) {
      const key = this.queue[index];
      if (this.options.isAvailable(key)) {
        this.queue.splice(index, 1);
        this.settle(key);
        continue;
      }
      // Already on its way: its waiters settle when it is stored.
      if (this.running.has(key) || this.staged?.key === key || this.preparingKey === key) {
        this.queue.splice(index, 1);
        continue;
      }
      if (this.required.has(key)) {
        if (index > 0) this.queue.unshift(...this.queue.splice(index, 1));
        return key;
      }
      if (first < 0) first = index;
      index++;
    }
    if (first < 0) return undefined;
    if (first > 0) this.queue.unshift(...this.queue.splice(first, 1));
    return this.queue[0];
  }

  private async pump(): Promise<void> {
    if (this.failure !== undefined) return;
    // A request that arrives while a pass is suspended must not be lost: the
    // running pass may already have decided there was nothing to do.
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        await this.pumpPass();
      } while (this.pumpAgain && this.failure === undefined);
    } catch (error) {
      this.abort(error);
    } finally {
      this.pumping = false;
    }
  }

  private async pumpPass(): Promise<void> {
    while (this.failure === undefined) {
      if (this.options.cancelled()) {
        this.abort(new Error("Export cancelled"));
        return;
      }
      if (this.helpers.length === 0) {
        await this.renderRequiredLocally();
        return;
      }
      if (this.staged) {
        if (!this.canRunOnHelper(this.staged.key)) return;
        const staged = this.staged;
        this.staged = undefined;
        this.dispatch(staged.key, staged.prepared, staged.transfer);
        continue;
      }
      const key = this.nextKey();
      if (key === undefined || !this.withinLookahead(key)) return;
      // After running out of memory, prepare only what a helper can take
      // right away instead of holding another prepared tile in reserve.
      if (this.lowMemory && !this.canRunOnHelper(key)) return;
      // Prepare now if a helper can take the tile, or ahead of time while
      // every helper is busy, so a finishing helper never waits for this
      // worker. At most one prepared tile waits at a time.
      this.queue.shift();
      // While an asynchronous preparation runs, the key counts as scheduled
      // so a band that needs it waits for it instead of queueing it again.
      this.preparingKey = key;
      let preparation: { prepared: Prepared; transfer: Transferable[] };
      try {
        preparation = await this.options.prepare(key);
      } catch (error) {
        this.preparingKey = undefined;
        if (!this.options.isOutOfMemory?.(error)) throw error;
        // Out of memory while helpers still hold tiles: retry this tile once
        // they have finished, with fewer tiles side by side from now on.
        // Retrying at once (or on another path) only digs into swap.
        if (this.running.size > 0) {
          this.queue.unshift(key);
          this.reduceBudget();
          this.options.onMemoryPressure?.(key, error, this.helperBudgetBytes);
          return;
        }
        // Every helper is idle, yet an idle helper keeps its last tile's
        // buffers until its own garbage collector runs, which this worker
        // cannot trigger. Restarting the helpers frees all of it; the tile
        // is retried once, and fails the export if it still does not fit.
        if (this.restartedFor.has(key) || !this.idle.some(helper => helper.restart)) throw error;
        this.restartedFor.add(key);
        this.queue.unshift(key);
        this.reduceBudget();
        this.options.onHelperRestart?.(key, error, this.helperBudgetBytes);
        await this.restartIdleHelpers();
        continue;
      } finally {
        this.preparingKey = undefined;
      }
      if (this.failure !== undefined) return;
      this.staged = { key, prepared: preparation.prepared, transfer: preparation.transfer };
      await this.options.yieldToEvents();
    }
  }

  private reduceBudget(): void {
    this.helperBudgetBytes /= 2;
    this.cleanCompletions = 0;
    this.lowMemory = true;
  }

  /** Restarts every idle helper; one that cannot start again is retired. */
  private async restartIdleHelpers(): Promise<void> {
    const idle = [...this.idle];
    const restarted = await Promise.all(idle.map(helper =>
      helper.restart ? helper.restart().catch(() => false) : Promise.resolve(true)));
    idle.forEach((helper, index) => {
      if (restarted[index]) return;
      helper.dispose();
      const idleAt = this.idle.indexOf(helper);
      if (idleAt >= 0) this.idle.splice(idleAt, 1);
      const helperAt = this.helpers.indexOf(helper);
      if (helperAt >= 0) this.helpers.splice(helperAt, 1);
    });
  }

  private dispatch(key: string, prepared: Prepared, transfer: Transferable[]): void {
    const helper = this.idle.pop()!;
    const helperBytes = this.options.helperBytes(key);
    this.running.set(key, helperBytes);
    this.runningHelperBytes += helperBytes;
    this.options.onDispatch?.(key, this.running.size - 1, this.queue.length);
    const startedAt = performance.now();
    const finish = (): void => {
      this.running.delete(key);
      this.runningHelperBytes -= helperBytes;
    };
    helper.render(prepared, transfer).then(result => {
      finish();
      this.idle.push(helper);
      if (this.failure !== undefined) return;
      this.options.onComplete?.(key, result, performance.now() - startedAt);
      try {
        this.options.store(key, result);
        this.settle(key);
        this.recoverBudget();
      } catch (error) {
        this.abort(error);
        return;
      }
      void this.pump();
    }, error => {
      finish();
      if (this.failure !== undefined) return;
      if (this.options.cancelled()) {
        this.abort(new Error("Export cancelled"));
        return;
      }
      // Failures and timeouts mostly mean memory ran short (swap, failed
      // allocations), so run fewer tiles side by side from here on. The tile
      // goes back to the front, so a helper fault never fails the export.
      this.helperBudgetBytes /= 2;
      this.cleanCompletions = 0;
      this.queue.unshift(key);
      if (this.options.isOutOfMemory?.(error)) {
        // The helper caught the failed allocation and is still healthy:
        // keep it, and retry the tile once memory has been freed.
        this.idle.push(helper);
        this.lowMemory = true;
        this.options.onMemoryPressure?.(key, error, this.helperBudgetBytes);
      } else {
        // A crashed or hung helper is retired.
        this.options.onHelperFailure?.(key, error, this.helperBudgetBytes);
        helper.dispose();
        const index = this.helpers.indexOf(helper);
        if (index >= 0) this.helpers.splice(index, 1);
      }
      void this.pump();
    });
  }

  /** Without helpers, required tiles render here; lookahead is dropped. */
  private async renderRequiredLocally(): Promise<void> {
    if (this.staged) {
      this.queue.unshift(this.staged.key);
      this.staged = undefined;
    }
    while (this.queue.length > 0) {
      const key = this.queue.shift()!;
      if (!this.required.has(key)) {
        this.settle(key);
        continue;
      }
      if (this.options.cancelled()) {
        this.abort(new Error("Export cancelled"));
        return;
      }
      if (!this.options.isAvailable(key)) this.options.renderLocally(key);
      this.settle(key);
      await this.options.yieldToEvents();
    }
  }
}

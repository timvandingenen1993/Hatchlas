/**
 * Keeps only the newest preview request running: later requests replace queued ones instead of piling up.
 */
export class LatestRequestCoordinator<T extends { requestId: number }> {
  private active = false;
  private scheduled = false;
  private pending: T | null = null;
  private latestRequestId = -1;
  private readonly runRequest: (request: T) => Promise<void> | void;
  private readonly scheduleCallback: (callback: () => void) => void;

  constructor(
    run: (request: T) => Promise<void> | void,
    schedule: (callback: () => void) => void = (callback) =>
      setTimeout(callback, 0),
  ) {
    this.runRequest = run;
    this.scheduleCallback = schedule;
  }

  enqueue(request: T): void {
    // A request that arrives while a render is in progress invalidates its
    // eventual frame. The renderer remains synchronous for compatibility, but
    // the worker can now drop stale output immediately when that work returns.
    this.latestRequestId = request.requestId;
    this.pending = request;
    if (this.active || this.scheduled) return;
    this.scheduled = true;
    this.scheduleCallback(() => void this.drain());
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.latestRequestId;
  }

  cancel(): void {
    this.latestRequestId = -1;
    this.pending = null;
  }

  private async drain(): Promise<void> {
    this.scheduled = false;
    const request = this.pending;
    if (!request) return;
    this.pending = null;
    this.active = true;
    try {
      await this.runRequest(request);
    } finally {
      this.active = false;
      if (this.pending && !this.scheduled) {
        this.scheduled = true;
        this.scheduleCallback(() => void this.drain());
      }
    }
  }
}

// Request throttle (MRM — max requests per minute). Paces provider calls under a
// rolling 60-second window so freecode doesn't trip provider rate limits (429s) or
// outrun a budget. The decision is a pure function (testable); the limiter wraps
// it with a real clock + sleep. Shared across the main agent, sub-agents, and
// workflows via one provider instance, so the cap is GLOBAL, not per-agent.

const WINDOW_MS = 60_000;

/** Given the recent request timestamps + now, decide whether a slot is free.
 *  delayMs === 0 → go now (caller records `now`); else wait delayMs and retry.
 *  Also returns the window-pruned timestamps so the caller can keep them tidy. */
export function throttleDecision(
  times: readonly number[],
  now: number,
  maxPerMinute: number,
): { delayMs: number; pruned: number[] } {
  if (maxPerMinute <= 0) return { delayMs: 0, pruned: [...times] };
  const pruned = times.filter((t) => now - t < WINDOW_MS); // drop anything older than the window
  if (pruned.length < maxPerMinute) return { delayMs: 0, pruned };
  const oldest = pruned[0]!; // ascending order — wait until it ages out of the window
  return { delayMs: Math.max(1, WINDOW_MS - (now - oldest)), pruned };
}

export class RateLimiter {
  private times: number[] = [];

  constructor(
    private readonly maxPerMinute: number,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly onWait?: (ms: number) => void,
  ) {}

  /** Resolve immediately if under the limit, else block until a slot frees up. */
  async acquire(): Promise<void> {
    if (this.maxPerMinute <= 0) return; // disabled
    for (;;) {
      const now = this.clock();
      const { delayMs, pruned } = throttleDecision(this.times, now, this.maxPerMinute);
      this.times = pruned;
      if (delayMs === 0) {
        this.times.push(now);
        return;
      }
      this.onWait?.(delayMs);
      await this.sleep(delayMs);
    }
  }
}

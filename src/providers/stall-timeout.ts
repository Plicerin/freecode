// Stall watchdog for streaming providers. A chat stream legitimately takes a
// long time (long generations, slow first token on reasoning models), so a
// total-duration timeout is wrong — it would kill valid long streams. What's
// NEVER valid is a connection that goes silent: no headers, or no bytes for
// minutes. This watchdog aborts on IDLE, not on total time: the clock starts at
// creation (covering connect/time-to-first-token) and is reset on every chunk.
//
// Before this, a stalled socket sat in `reader.read()` forever (the /ultraplan
// hour-long hang) because the fetch carried only the user's abort signal and no
// timeout. Now the watchdog's signal is what fetch listens to; when it fires,
// `timedOut()` lets the provider throw a friendly, retryable timeout instead.
import { getEnv } from "../utils/env";

/** Idle ceiling for a streaming response, in ms. Generous enough for a slow
 *  first token on a reasoning model; an hour-long silence is caught in 2 min. */
export function streamIdleMs(): number {
  const raw = getEnv("FREECODE_STREAM_TIMEOUT_MS");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

export interface StallTimeout {
  /** Pass this to fetch(); it aborts on user-cancel OR on idle timeout. */
  signal: AbortSignal;
  /** Restart the idle clock — call after every received chunk. */
  reset(): void;
  /** Stop the watchdog (stream finished or errored). Idempotent. */
  clear(): void;
  /** True if the watchdog itself fired (vs. a user abort or other error). */
  timedOut(): boolean;
}

export function createStallTimeout(userSignal: AbortSignal | undefined, idleMs: number): StallTimeout {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let cleared = false;

  const onUserAbort = (): void => controller.abort();
  if (userSignal) {
    if (userSignal.aborted) controller.abort();
    else userSignal.addEventListener("abort", onUserAbort, { once: true });
  }

  const arm = (): void => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleMs);
    // Don't let the watchdog timer keep the process alive on its own.
    (timer as { unref?: () => void }).unref?.();
  };

  const clear = (): void => {
    if (cleared) return;
    cleared = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    userSignal?.removeEventListener("abort", onUserAbort);
  };

  arm(); // start the connect / first-token clock immediately

  return {
    signal: controller.signal,
    reset() {
      if (cleared || controller.signal.aborted) return;
      if (timer) clearTimeout(timer);
      arm();
    },
    clear,
    timedOut() {
      return timedOut;
    },
  };
}

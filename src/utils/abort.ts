/** Combine an optional caller cancellation signal with a local deadline.
 * Call `clear` when the operation settles to release the timer/listener. */
export function createDeadline(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; clear(): void; timedOut(): boolean } {
  const controller = new AbortController();
  let expired = false;
  const onAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new Error(`Timed out after ${ms}ms`));
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
    timedOut: () => expired,
  };
}

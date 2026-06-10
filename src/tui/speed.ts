// Live token-throughput readout — a "speedometer" for generation speed
// (output tokens produced ÷ time spent generating). During streaming we estimate
// tokens from characters (~4 chars/token) for a live figure; it's a gauge, not a
// billing number. Reset per generation burst so it reflects the current stream,
// not wall-clock that includes tool-execution pauses.

export function tokensPerSecond(tokens: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || tokens <= 0) return 0;
  return tokens / (elapsedMs / 1000);
}

/** Rough token count from a character count (~4 chars/token). */
export function estTokens(chars: number): number {
  return chars / 4;
}

/** Compact readout, e.g. "46 tok/s" (one decimal under 10, blank when unknown). */
export function formatSpeed(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return "";
  return `${tps < 10 ? tps.toFixed(1) : String(Math.round(tps))} tok/s`;
}

export type StreamHealth = "healthy" | "slow" | "stalled";

/**
 * Classify the in-flight turn's health from silence AND throughput. A sustained
 * CRAWL (a trickle of tokens) is as bad as silence — the idle stall-timeout misses
 * it because bytes keep arriving, so a turn can run ~30 min at 0.2 tok/s looking
 * "busy". `tps` is null before any tokens have streamed (still "connecting").
 *   idleMs  — ms since the last stream event of any kind
 *   burstMs — ms the current generation burst has been running
 *   tps     — live tokens/sec for this burst (null if not generating yet)
 */
export function streamHealth(idleMs: number, burstMs: number, tps: number | null): StreamHealth {
  if (idleMs >= 20_000 || (tps !== null && burstMs > 30_000 && tps < 2)) return "stalled";
  if (idleMs >= 5_000 || (tps !== null && burstMs > 15_000 && tps < 5)) return "slow";
  return "healthy";
}

import { debug } from "./debug";
import { getEnv, getEnvBool } from "./env";

export interface RetryOptions {
  maxRetries?: number;
  baseMs?: number;
  maxMs?: number;
  jitter?: boolean;
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

const DEFAULT_MAX = 10;
// Cap on an honored Retry-After: respect the provider's reset, but never block a
// turn for more than 2 minutes on a single wait (a pathological header value).
const RETRY_AFTER_MAX_MS = 120_000;

export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (msg.includes("rate limit")) return true;
  if (msg.includes("429")) return true;
  if (msg.includes("too many requests")) return true;
  if (msg.includes("quota")) return true;
  const code = (err as { code?: string }).code;
  return code === "rate_limit_exceeded" || code === "RESOURCE_EXHAUSTED";
}

function expBackoff(attempt: number, baseMs: number, maxMs: number, jitter: boolean): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  if (!jitter) return exp;
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

/** Delay before the next retry. Honors a provider-supplied Retry-After / reset
 *  (err.retryAfterMs) — capped, plus a small buffer so we don't retry exactly at
 *  the boundary and re-trip the limit — otherwise falls back to exponential
 *  backoff. `attempt` is zero-based. Pure, so the policy is testable without sleeping. */
export function nextRetryDelayMs(err: unknown, attempt: number, baseMs: number, maxMs: number, jitter: boolean): number {
  const hinted = (err as { retryAfterMs?: number })?.retryAfterMs;
  if (typeof hinted === "number" && hinted >= 0) return Math.min(hinted + 250, RETRY_AFTER_MAX_MS);
  return expBackoff(attempt, baseMs, maxMs, jitter);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const unattended = getEnvBool("CLAUDE_CODE_UNATTENDED_RETRY");
  const maxRetries = unattended ? Infinity : (opts.maxRetries ?? DEFAULT_MAX);
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 30_000;
  const jitter = opts.jitter ?? true;
  const should = opts.shouldRetry ?? isRateLimitError;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > maxRetries || !should(err)) {
        if (unattended) {
          debug.warn("unattended retry exhausted after Infinity attempts — giving up", String(err));
        }
        throw err;
      }
      const delay = nextRetryDelayMs(err, attempt - 1, baseMs, maxMs, jitter);
      debug.warn(`retry ${attempt} in ${delay}ms`, String(err));
      opts.onRetry?.(attempt, delay, err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export const retryEnvHints = {
  isUnattended: () => getEnvBool("CLAUDE_CODE_UNATTENDED_RETRY"),
  maxRetries: () => (getEnvBool("CLAUDE_CODE_UNATTENDED_RETRY") ? Infinity : DEFAULT_MAX),
};

// keep getEnv exported downstream if needed
export { getEnv };

// Honor a provider's OWN rate-limit reset signal on a 429/503 instead of guessing
// with exponential backoff. Reads the standard `Retry-After` header plus the common
// `x-ratelimit-reset*` variants — OpenAI/OpenRouter duration strings ("1s", "6m0s")
// and OpenRouter's absolute epoch — and returns how long to wait, in ms. Returns
// undefined when there's no usable signal (caller falls back to backoff).

export interface HeadersLike {
  get(name: string): string | null | undefined;
}

/** Parse a duration like "1s", "6m0s", "880ms", "1.5s", or a bare number of
 *  SECONDS ("30") into ms. Undefined when it isn't a duration (e.g. an epoch). */
export function parseDurationMs(raw: string): number | undefined {
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n < 1e6 ? Math.round(n * 1000) : undefined; // small = seconds; huge = an epoch, not a delta
  }
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let m: RegExpExecArray | null;
  let total = 0;
  let matched = false;
  while ((m = re.exec(s))) {
    matched = true;
    const v = Number(m[1]);
    total += m[2] === "ms" ? v : m[2] === "s" ? v * 1000 : m[2] === "m" ? v * 60_000 : v * 3_600_000;
  }
  return matched ? Math.round(total) : undefined;
}

/** How long to wait (ms) before retrying, per the provider's headers, or undefined
 *  if none say. `now` is epoch-ms (injected so it's testable). */
export function parseRetryAfterMs(headers: HeadersLike, now: number): number | undefined {
  const get = (k: string): string | undefined => {
    const v = headers.get(k);
    return v == null ? undefined : String(v);
  };
  // 1) Standard Retry-After: delta-seconds OR an HTTP-date.
  const ra = get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (ra.trim() !== "" && Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
    const when = Date.parse(ra);
    if (Number.isFinite(when)) return Math.max(0, when - now);
  }
  // 2) OpenAI-style per-bucket reset, given as a duration ("1s", "6m0s").
  for (const k of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const d = get(k);
    if (d) {
      const ms = parseDurationMs(d);
      if (ms !== undefined) return ms;
    }
  }
  // 3) x-ratelimit-reset: a duration, or an absolute epoch (OpenRouter = ms).
  const reset = get("x-ratelimit-reset");
  if (reset) {
    const d = parseDurationMs(reset);
    if (d !== undefined) return d;
    const n = Number(reset);
    if (Number.isFinite(n)) {
      const epochMs = n > 1e12 ? n : n > 1e9 ? n * 1000 : undefined; // ms-epoch or sec-epoch
      if (epochMs !== undefined) return Math.max(0, epochMs - now);
    }
  }
  return undefined;
}

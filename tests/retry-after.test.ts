// On a 429/503, honor the provider's OWN reset signal (Retry-After / x-ratelimit-
// reset) instead of blind exponential backoff — the fix for the OpenRouter/NIM
// 429-cascade where freecode retried too early and re-tripped the limit.
import { test, expect, describe } from "bun:test";
import { parseRetryAfterMs, parseDurationMs, type HeadersLike } from "../src/providers/retry-after";
import { nextRetryDelayMs, withRetry } from "../src/utils/retry";
import { friendlyError } from "../src/providers/friendly-errors";

function headers(obj: Record<string, string>): HeadersLike {
  const low: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) low[k.toLowerCase()] = v;
  return { get: (k) => low[k.toLowerCase()] ?? null };
}

describe("parseDurationMs", () => {
  test("durations and bare seconds", () => {
    expect(parseDurationMs("1s")).toBe(1000);
    expect(parseDurationMs("6m0s")).toBe(360_000);
    expect(parseDurationMs("880ms")).toBe(880);
    expect(parseDurationMs("1.5s")).toBe(1500);
    expect(parseDurationMs("30")).toBe(30_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
  });
  test("not a duration → undefined", () => {
    expect(parseDurationMs("1700000000")).toBeUndefined(); // an epoch, not a delta
    expect(parseDurationMs("")).toBeUndefined();
    expect(parseDurationMs("soon")).toBeUndefined();
  });
});

describe("parseRetryAfterMs", () => {
  const now = 1_700_000_000_000;
  test("Retry-After seconds", () => {
    expect(parseRetryAfterMs(headers({ "retry-after": "5" }), now)).toBe(5000);
    expect(parseRetryAfterMs(headers({ "Retry-After": "0.5" }), now)).toBe(500);
  });
  test("Retry-After HTTP-date", () => {
    const when = new Date(now + 30_000).toUTCString(); // truncated to whole seconds
    expect(parseRetryAfterMs(headers({ "retry-after": when }), now)).toBe(30_000);
  });
  test("OpenAI-style x-ratelimit-reset-requests duration", () => {
    expect(parseRetryAfterMs(headers({ "x-ratelimit-reset-requests": "6m0s" }), now)).toBe(360_000);
    expect(parseRetryAfterMs(headers({ "x-ratelimit-reset-tokens": "2s" }), now)).toBe(2000);
  });
  test("OpenRouter x-ratelimit-reset absolute epoch (ms)", () => {
    expect(parseRetryAfterMs(headers({ "x-ratelimit-reset": String(now + 20_000) }), now)).toBe(20_000);
  });
  test("x-ratelimit-reset epoch in seconds", () => {
    const resetSec = Math.floor(now / 1000) + 15;
    expect(parseRetryAfterMs(headers({ "x-ratelimit-reset": String(resetSec) }), now)).toBe(15_000);
  });
  test("Retry-After wins over reset headers", () => {
    expect(parseRetryAfterMs(headers({ "retry-after": "3", "x-ratelimit-reset": String(now + 99_000) }), now)).toBe(3000);
  });
  test("no signal → undefined", () => {
    expect(parseRetryAfterMs(headers({}), now)).toBeUndefined();
    expect(parseRetryAfterMs(headers({ "content-type": "application/json" }), now)).toBeUndefined();
  });
});

describe("nextRetryDelayMs (retry policy)", () => {
  test("honors retryAfterMs with a small buffer", () => {
    expect(nextRetryDelayMs({ retryAfterMs: 4000 }, 0, 500, 30_000, true)).toBe(4250);
    expect(nextRetryDelayMs({ retryAfterMs: 0 }, 5, 500, 30_000, true)).toBe(250);
  });
  test("caps a pathological retryAfterMs at 120s", () => {
    expect(nextRetryDelayMs({ retryAfterMs: 999_999_999 }, 0, 500, 30_000, true)).toBe(120_000);
  });
  test("falls back to exponential backoff when no hint", () => {
    expect(nextRetryDelayMs({}, 0, 500, 30_000, false)).toBe(500);
    expect(nextRetryDelayMs({}, 2, 500, 30_000, false)).toBe(2000);
    expect(nextRetryDelayMs(new Error("boom"), 3, 500, 30_000, false)).toBe(4000);
  });
});

describe("friendlyError carries the Retry-After forward", () => {
  test("429 error keeps retryAfterMs + retryable", () => {
    const src = Object.assign(new Error("429 slow down"), { status: 429, retryAfterMs: 7000 });
    const out = friendlyError(src, "openrouter") as Error & { retryable?: boolean; retryAfterMs?: number };
    expect(out.retryable).toBe(true);
    expect(out.retryAfterMs).toBe(7000);
    expect(out.message).toContain("7s");
  });
});

describe("withRetry integration", () => {
  test("waits the honored delay then succeeds; surfaces it via onRetry", async () => {
    let calls = 0;
    const seen: number[] = [];
    const t0 = Date.now();
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("rate limit"), { retryAfterMs: 40, retryable: true });
        return "ok";
      },
      { onRetry: (_a, delayMs) => seen.push(delayMs) },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(seen).toEqual([290]); // 40 + 250 buffer
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });
});

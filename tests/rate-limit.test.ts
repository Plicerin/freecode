// MRM throttle (Tier R). The decision is pure (tested directly) and the limiter
// uses an injected clock + sleep so its blocking behaviour is deterministic.
import { test, expect, describe } from "bun:test";
import { throttleDecision, RateLimiter } from "../src/agent/rate-limit";
import { RateLimitedProvider } from "../src/providers/rate-limited";

describe("throttleDecision", () => {
  test("a slot is free while under the per-minute limit", () => {
    const d = throttleDecision([1000, 2000], 3000, 3);
    expect(d.delayMs).toBe(0);
    expect(d.pruned).toEqual([1000, 2000]);
  });

  test("at the limit, wait until the oldest request ages out of the 60s window", () => {
    // 3 requests at t=0,10s,20s; now=30s; oldest (t=0) ages out at t=60s → wait 30s.
    const d = throttleDecision([0, 10_000, 20_000], 30_000, 3);
    expect(d.delayMs).toBe(30_000);
  });

  test("prunes requests older than the window", () => {
    const d = throttleDecision([0, 70_000, 80_000], 90_000, 3);
    expect(d.pruned).toEqual([70_000, 80_000]); // t=0 dropped (>60s old)
    expect(d.delayMs).toBe(0);
  });

  test("0 (or negative) means unthrottled — always free", () => {
    expect(throttleDecision([1, 2, 3, 4, 5], 5, 0).delayMs).toBe(0);
  });
});

describe("RateLimiter", () => {
  test("lets the first N through instantly, then makes the next one wait", async () => {
    let t = 0;
    const waits: number[] = [];
    const clock = () => t;
    const sleep = async (ms: number) => { waits.push(ms); t += ms; }; // advance virtual time
    const limiter = new RateLimiter(2, clock, sleep);

    await limiter.acquire(); // records t=0
    await limiter.acquire(); // records t=0 (2nd of 2)
    expect(waits).toEqual([]); // both instant

    await limiter.acquire(); // limit hit → must wait the full 60s for the oldest to age out
    expect(waits).toEqual([60_000]);
    expect(t).toBe(60_000);
  });

  test("maxPerMinute <= 0 never blocks", async () => {
    let slept = false;
    const limiter = new RateLimiter(0, () => 0, async () => { slept = true; });
    await limiter.acquire();
    await limiter.acquire();
    expect(slept).toBe(false);
  });
});

describe("RateLimitedProvider", () => {
  test("preserves id/name and passes the stream through (acquiring a slot first)", async () => {
    let acquired = 0;
    const inner = {
      id: "x", name: "X", models: () => ["m"],
      async *stream() { yield { type: "text_delta", delta: "hi" }; yield { type: "end", reason: "end_turn" }; },
    };
    const limiter = new RateLimiter(5, () => { acquired++; return 0; });
    const p = new RateLimitedProvider(inner as never, limiter);
    expect(p.id).toBe("x");
    expect(p.name).toBe("X");
    const types: string[] = [];
    for await (const e of p.stream({ model: "m", messages: [] } as never)) types.push((e as { type: string }).type);
    expect(types).toEqual(["text_delta", "end"]);
    expect(acquired).toBeGreaterThan(0); // the limiter was consulted
  });
});

import { test, expect } from "bun:test";
import { summarize, runBench } from "../src/perf/bench";
import { compare, envFingerprint, envKey, toBest, type PersonalBest } from "../src/perf/ledger";

test("summarize computes robust median/min/mad", () => {
  // 1..9 plus one wild outlier — median must ignore the outlier.
  const s = summarize("x", [5, 1, 3, 2, 4, 9, 7, 6, 8, 1000]);
  expect(s.samples).toBe(10);
  expect(s.min).toBe(1);
  expect(s.median).toBe(5.5); // mean of 5th/6th of sorted 1..9,1000 = (5+6)/2
  expect(s.mad).toBeGreaterThan(0);
  expect(s.p95).toBeGreaterThanOrEqual(s.median);
});

test("summarize handles a single sample", () => {
  const s = summarize("x", [42]);
  expect(s.median).toBe(42);
  expect(s.min).toBe(42);
  expect(s.mad).toBe(0);
});

const best: PersonalBest = { median: 100, min: 95, mad: 1, ts: "t" };

test("compare: no ghost yet → 'new', nothing significant", () => {
  const c = compare({ name: "x", samples: 60, min: 9, median: 10, mad: 1, p95: 12 }, undefined);
  expect(c.verdict).toBe("new");
  expect(c.significant).toBe(false);
});

test("compare: clearly faster beyond the band → 'best'", () => {
  // delta -20, band = max(2% of 100 = 2, 3*(1+1)=6) = 6 → |20| > 6
  const c = compare({ name: "x", samples: 60, min: 78, median: 80, mad: 1, p95: 85 }, best);
  expect(c.verdict).toBe("best");
  expect(c.significant).toBe(true);
  expect(c.deltaPct).toBeCloseTo(-20, 5);
});

test("compare: clearly slower beyond the band → 'regression'", () => {
  const c = compare({ name: "x", samples: 60, min: 118, median: 120, mad: 1, p95: 125 }, best);
  expect(c.verdict).toBe("regression");
  expect(c.significant).toBe(true);
});

test("compare: within the noise band → 'neutral' (a tie, not a win)", () => {
  // delta -1, band 6 → not significant. The whole point of the ledger:
  // a sub-noise improvement is honestly reported as a tie, never a "win".
  const c = compare({ name: "x", samples: 60, min: 98, median: 99, mad: 1, p95: 101 }, best);
  expect(c.verdict).toBe("neutral");
  expect(c.significant).toBe(false);
});

test("compare: high jitter widens the band, suppressing false wins", () => {
  // Same -10 delta, but mad=5 each → band = max(2, 3*10=30) = 30 → tie.
  const noisy: PersonalBest = { median: 100, min: 80, mad: 5, ts: "t" };
  const c = compare({ name: "x", samples: 60, min: 70, median: 90, mad: 5, p95: 110 }, noisy);
  expect(c.verdict).toBe("neutral");
});

test("envKey is stable and like-for-like", () => {
  const k = envKey(envFingerprint());
  expect(k).toBe(envKey(envFingerprint()));
  expect(k.split("/").length).toBe(4);
});

test("toBest snapshots the stats with a timestamp", () => {
  const b = toBest({ name: "x", samples: 60, min: 9, median: 10, mad: 1, p95: 12 }, "abc123");
  expect(b.median).toBe(10);
  expect(b.commit).toBe("abc123");
  expect(typeof b.ts).toBe("string");
});

test("runBench produces sane stats for a trivial fn", async () => {
  const s = await runBench("noop", () => 1 + 1, { warmup: 2, iterations: 20, maxMs: 1000 });
  expect(s.samples).toBeGreaterThan(0);
  expect(s.median).toBeGreaterThanOrEqual(0);
  expect(s.min).toBeLessThanOrEqual(s.median);
});

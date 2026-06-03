// The benchmark harness. Times a hot-path function many times and reduces the
// samples to ROBUST statistics — median (not mean, which one GC pause skews)
// and MAD (median absolute deviation), our noise estimate. The ledger uses MAD
// to decide whether a change is a real win or just jitter.

/** High-resolution monotonic clock, fractional milliseconds. */
function nowMs(): number {
  return performance.now();
}

export interface BenchStats {
  name: string;
  samples: number; // how many timed runs survived
  min: number; // ms — best single run (least-contended)
  median: number; // ms — headline, robust to outliers
  mad: number; // ms — median absolute deviation, the run-to-run jitter
  p95: number; // ms — tail
}

export interface BenchOptions {
  warmup?: number; // untimed iterations to warm JIT/caches (default 5)
  iterations?: number; // timed samples (default 60)
  maxMs?: number; // time-box: stop early if exceeded (default 2000)
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Reduce raw timings (ms) to robust stats. Exported for unit testing. */
export function summarize(name: string, raw: number[]): BenchStats {
  const sorted = [...raw].sort((a, b) => a - b);
  const med = median(sorted);
  const devs = sorted.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  const mad = median(devs);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    name,
    samples: sorted.length,
    min: sorted[0] ?? 0,
    median: med,
    mad,
    p95: sorted[p95Idx] ?? med,
  };
}

/** Run `fn` warmup+iterations times and return robust stats. */
export async function runBench(
  name: string,
  fn: () => unknown | Promise<unknown>,
  opts: BenchOptions = {},
): Promise<BenchStats> {
  const warmup = opts.warmup ?? 5;
  const iterations = opts.iterations ?? 60;
  const maxMs = opts.maxMs ?? 2000;

  for (let i = 0; i < warmup; i++) await fn();

  const samples: number[] = [];
  const deadline = nowMs() + maxMs;
  for (let i = 0; i < iterations; i++) {
    const t0 = nowMs();
    await fn();
    samples.push(nowMs() - t0);
    if (nowMs() > deadline) break;
  }
  return summarize(name, samples);
}

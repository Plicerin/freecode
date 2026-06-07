// Bounded parallelism. `Promise.all(items.map(fn))` runs EVERYTHING at once — for
// a workflow stage that fans out to sub-agents, that's unbounded spawn (cost +
// the deadlock/hang surface). This runs at most `limit` at a time, queueing the
// rest, while preserving result order. Pure → unit-tested.

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  const cap = Math.max(1, Math.floor(limit) || 1);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  const workers = Array.from({ length: Math.min(cap, n) }, () => worker());
  await Promise.all(workers);
  return results;
}

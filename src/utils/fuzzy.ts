/** Levenshtein edit distance between two strings. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]!;
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i]!;
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i]!, dp[i - 1]!);
      prev = tmp;
    }
  }
  return dp[m]!;
}

/** Closest candidate to `input` within `maxDistance` edits, or undefined. */
export function closest(input: string, candidates: string[], maxDistance = 3): string | undefined {
  const q = input.toLowerCase();
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(q, c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD <= maxDistance ? best : undefined;
}

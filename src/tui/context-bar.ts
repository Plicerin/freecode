// A tiny text progress bar for "how full is the context window". Pure so the
// fill math + tone thresholds are unit-tested; the REPL maps the tone to a theme
// colour and renders it in the footer.

/** A width-cell bar of filled (▓) / empty (░) blocks for a [0,1] fraction. */
export function contextBar(fraction: number, width = 10): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(f * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

export type ContextTone = "ok" | "warn" | "crit";

/** Colour band for the bar: calm until ~60%, warn approaching the compaction
 *  zone, critical near full. */
export function contextTone(fraction: number): ContextTone {
  if (fraction >= 0.85) return "crit";
  if (fraction >= 0.6) return "warn";
  return "ok";
}

/** Compact "12k", "200k", "1.5M" style token count for the footer. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

import type { TokenUsage } from "../providers/types";

/** USD per 1,000,000 tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Cached-input read rate; defaults to the input rate when unset. */
  cacheRead?: number;
  /** Cache-write rate; defaults to the input rate when unset. */
  cacheWrite?: number;
}

const FREE: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Conservative blended fallback for unknown remote models. */
const UNKNOWN_REMOTE: ModelPrice = { input: 3, output: 15 };

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "mock"]);

// Approximate public list prices (USD per 1M tokens). Match by substring so
// version suffixes (dates, sizes) still resolve. Order matters: most specific
// patterns first.
const TABLE: Array<{ match: RegExp; price: ModelPrice }> = [
  // Anthropic Claude
  { match: /opus/i, price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: /sonnet/i, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /haiku/i, price: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
  // OpenAI
  { match: /gpt-4o-mini/i, price: { input: 0.15, output: 0.6, cacheRead: 0.075 } },
  { match: /gpt-4o/i, price: { input: 2.5, output: 10, cacheRead: 1.25 } },
  { match: /gpt-4\.1-mini/i, price: { input: 0.4, output: 1.6 } },
  { match: /gpt-4\.1/i, price: { input: 2, output: 8 } },
  { match: /(^|[^a-z])(o3-mini|o4-mini)/i, price: { input: 1.1, output: 4.4 } },
  // Google Gemini
  { match: /gemini.*flash/i, price: { input: 0.1, output: 0.4 } },
  { match: /gemini.*pro/i, price: { input: 1.25, output: 5 } },
];

/**
 * Resolve the price for a model. Local providers are always free; otherwise we
 * match the model name against the table and fall back to a blended estimate.
 */
export function priceFor(model: string, provider?: string): ModelPrice {
  if (provider && LOCAL_PROVIDERS.has(provider)) return FREE;
  for (const row of TABLE) {
    if (row.match.test(model)) return row.price;
  }
  return UNKNOWN_REMOTE;
}

/**
 * Estimate USD cost for accumulated usage. Cached reads/writes are billed at
 * their own rates when the provider reports them separately from `input`.
 */
const WINDOWS: Array<{ match: RegExp; window: number }> = [
  { match: /gpt-4\.1/i, window: 1_000_000 },
  { match: /gpt-5/i, window: 400_000 },
  { match: /gpt-4o/i, window: 128_000 },
  { match: /(^|[^a-z])o[1-9]/i, window: 200_000 }, // o-series reasoning
  { match: /gemini/i, window: 1_000_000 },
  { match: /claude/i, window: 200_000 },
];

/** Approximate context window (tokens) for a model; used to size compaction. */
export function contextWindowFor(model: string): number {
  for (const w of WINDOWS) {
    if (w.match.test(model)) return w.window;
  }
  return 128_000;
}

export function estimateCost(usage: TokenUsage, price: ModelPrice): number {
  const m = 1_000_000;
  const cacheRead = price.cacheRead ?? price.input;
  const cacheWrite = price.cacheWrite ?? price.input;
  return (
    (usage.input / m) * price.input +
    (usage.output / m) * price.output +
    (usage.cacheRead / m) * cacheRead +
    (usage.cacheWrite / m) * cacheWrite
  );
}

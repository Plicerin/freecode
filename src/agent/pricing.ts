import type { TokenUsage } from "../providers/types";
import { getEnv } from "../utils/env";

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
// USD per 1M tokens. input/output for Anthropic are VERIFIED (platform.claude.com,
// 2026-06); cache rates are Anthropic's standard 0.1x read / 1.25x write of input
// (derived, not separately re-checked). OpenAI/Gemini rows are prior approximations
// (marked "approx") — not re-verified 2026-06.
const TABLE: Array<{ match: RegExp; price: ModelPrice }> = [
  // Anthropic Claude — pricing is version-specific, like the context windows.
  { match: /opus-4-[5678]/i, price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },   // Opus 4.5–4.8: verified $5/$25
  { match: /opus/i, price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },           // Opus 4.1/4.0 + fallback: verified $15/$75
  { match: /sonnet/i, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },           // verified $3/$15
  { match: /haiku/i, price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },             // Haiku 4.5: verified $1/$5
  // OpenAI — GPT-5.x verified developers.openai.com 2026-06 (5.4 mini price
  // unverified — it matches the 5.4 row). gpt-4.x/4o/o-series are prior approx.
  { match: /gpt-5\.5/i, price: { input: 5, output: 30, cacheRead: 0.5 } },     // verified
  { match: /gpt-5\.4/i, price: { input: 2.5, output: 15, cacheRead: 0.25 } },  // verified
  { match: /gpt-4o-mini/i, price: { input: 0.15, output: 0.6, cacheRead: 0.075 } },
  { match: /gpt-4o/i, price: { input: 2.5, output: 10, cacheRead: 1.25 } },
  { match: /gpt-4\.1-mini/i, price: { input: 0.4, output: 1.6 } },
  { match: /gpt-4\.1/i, price: { input: 2, output: 8 } },
  { match: /(^|[^a-z])(o3-mini|o4-mini)/i, price: { input: 1.1, output: 4.4 } },
  // Google Gemini — verified ai.google.dev/gemini-api/docs/pricing 2026-06.
  // Base tier: ≤200k-token prompt, text/image/video input. Gemini's higher >200k
  // tier and its audio-input rates aren't modeled by the flat price shape.
  // Specific → generic so a model gets its own rate before a family fallback.
  { match: /gemini-3\.5.*flash/i, price: { input: 1.5, output: 9, cacheRead: 0.15 } },        // 3.5 Flash
  { match: /gemini-3.*flash-lite/i, price: { input: 0.25, output: 1.5, cacheRead: 0.025 } },  // 3.1 Flash-Lite
  { match: /gemini-3.*pro/i, price: { input: 2, output: 12, cacheRead: 0.2 } },                // 3.1 Pro (≤200k)
  { match: /gemini-2\.5.*flash-lite/i, price: { input: 0.1, output: 0.4 } },
  { match: /gemini-2\.5.*flash/i, price: { input: 0.3, output: 2.5 } },
  { match: /gemini-2\.5.*pro/i, price: { input: 1.25, output: 10 } },                          // ≤200k
  { match: /gemini-2\.0.*flash/i, price: { input: 0.1, output: 0.4 } },
  { match: /gemini.*flash/i, price: { input: 0.3, output: 2.5 } },   // unknown flash → ~2.5 Flash
  { match: /gemini.*pro/i, price: { input: 1.25, output: 10 } },     // unknown pro → ~2.5 Pro
  // DeepSeek — approx, api-docs.deepseek.com (cache-miss input / cache-hit / output).
  { match: /deepseek-reasoner/i, price: { input: 0.55, output: 2.19, cacheRead: 0.14 } },  // R1
  { match: /deepseek/i, price: { input: 0.27, output: 1.1, cacheRead: 0.07 } },            // chat (V3) + fallback
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
// Context windows. First match wins, so version-specific rules precede generic
// ones. Provenance is per-line: "verified <source> <date>" was confirmed against
// official provider docs; "approx" is a best-effort value not (re)confirmed.
// Override any of this at runtime with FREECODE_CONTEXT_WINDOW=<tokens>.
const WINDOWS: Array<{ match: RegExp; window: number }> = [
  // OpenAI — verified developers.openai.com 2026-06.
  { match: /gpt-5\.[45][\s-]*mini/i, window: 400_000 },   // GPT-5.4 mini
  { match: /gpt-5\.[45]/i, window: 1_050_000 },           // GPT-5.5 / GPT-5.4 (verified 1,050,000)
  { match: /gpt-5/i, window: 400_000 },                   // plain gpt-5 (approx; absent from 2026 lineup)
  { match: /gpt-4\.1/i, window: 1_000_000 },              // approx (not re-checked 2026-06)
  { match: /gpt-4o/i, window: 128_000 },                  // approx
  { match: /(^|[^a-z])o[1-9]/i, window: 200_000 },        // o-series reasoning — approx
  // Anthropic — verified platform.claude.com 2026-06. Only Opus 4.6/4.7/4.8 and
  // Sonnet 4.6 are 1M; everything older (Sonnet ≤4.5, Opus ≤4.5, Haiku) is 200k.
  { match: /opus-4-[678]/i, window: 1_000_000 },
  { match: /sonnet-4-6/i, window: 1_000_000 },
  { match: /claude/i, window: 200_000 },
  // Google — UNVERIFIED (token table is JS-rendered; WebFetch can't read it).
  // Gemini 2.5 Pro is widely documented at ~1,048,576 input tokens; treat as approx.
  { match: /gemini/i, window: 1_000_000 },
  // DeepSeek — documented API context 64K for deepseek-chat/reasoner (approx;
  // conservative so compaction sizes under, not over). Override w/ FREECODE_CONTEXT_WINDOW.
  { match: /deepseek/i, window: 64_000 },
];

/** Context window (tokens) for a model; used to size compaction + the fill gauge.
 *  FREECODE_CONTEXT_WINDOW overrides everything (e.g. to pin an exact value the
 *  table doesn't know yet). Otherwise a name-matched lookup; 128k fallback. */
export function contextWindowFor(model: string): number {
  const override = getEnv("FREECODE_CONTEXT_WINDOW");
  if (override) {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n;
  }
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

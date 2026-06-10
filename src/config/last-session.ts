// Remember the provider/model from the last session so freecode reopens where you
// left off instead of auto-selecting (which lands on whatever has a key, e.g.
// openai). Stored as a small machine-managed file — kept separate from
// settings.json so it never clobbers a hand-edited (possibly commented) config.
// It's the LOWEST-priority default: an explicit --provider/--model, a project
// profile, env vars, or settings.json all still win.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { APP_DIR } from "../utils/paths";
import type { ProviderId } from "./schema";

export interface ProviderMemory {
  model?: string;
  baseUrl?: string;
}

export interface LastSession {
  provider?: ProviderId; // the globally LAST-used provider (plain `freecode` reopens this)
  model?: string;
  /** Base URL last used (e.g. a remote llama-server over Tailscale) so it's
   *  restored next launch without re-passing --base-url. */
  baseUrl?: string;
  /** Per-provider memory: each provider's OWN last model + base URL. Switching
   *  to a provider restores ITS settings, so bouncing between (say) a remote
   *  llama-server, nim:qwen, and ollama no longer wipes the others. */
  providers?: Record<string, ProviderMemory>;
}

function defaultPath(): string {
  return join(APP_DIR, "last-session.json");
}

// Under the test runner, ignore the real file unless a path is passed explicitly,
// so loadConfig tests stay deterministic (and a test never pollutes the real one).
const underTest = process.env.NODE_ENV === "test";

export function readLastSession(path?: string): LastSession {
  if (path === undefined && underTest) return {};
  const p = path ?? defaultPath();
  try {
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8")) as LastSession;
    return { provider: parsed.provider, model: parsed.model, baseUrl: parsed.baseUrl, providers: parsed.providers };
  } catch {
    return {};
  }
}

export function writeLastSession(s: LastSession, path?: string): void {
  if (path === undefined && underTest) return;
  const p = path ?? defaultPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    // Merge into the per-provider map: keep every OTHER provider's remembered
    // model/baseUrl and only update this provider's entry, so a switch never
    // wipes the rest. The top-level fields track the LAST-used provider.
    let existing: LastSession = {};
    try { if (existsSync(p)) existing = JSON.parse(readFileSync(p, "utf8")) as LastSession; } catch { existing = {}; }
    const providers: Record<string, ProviderMemory> = { ...(existing.providers ?? {}) };
    if (s.provider) providers[s.provider] = { model: s.model, baseUrl: s.baseUrl };
    writeFileSync(p, JSON.stringify({ provider: s.provider, model: s.model, baseUrl: s.baseUrl, providers }, null, 2));
  } catch {
    /* remembering must never break a run */
  }
}

/** The remembered model + base URL for a SPECIFIC provider: its per-provider
 *  entry first, then the top-level fields when they belong to that provider
 *  (back-compat with files written before per-provider memory existed). */
export function rememberedFor(last: LastSession, provider: ProviderId): ProviderMemory {
  const perProvider = last.providers?.[provider];
  if (perProvider && (perProvider.model || perProvider.baseUrl)) return perProvider;
  if (last.provider === provider) return { model: last.model, baseUrl: last.baseUrl };
  return {};
}

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
  provider?: ProviderId; // last-used provider for this scope (folder, or global fallback)
  model?: string;
  /** Base URL last used (e.g. a remote llama-server over Tailscale) so it's
   *  restored next launch without re-passing --base-url. */
  baseUrl?: string;
  /** Per-provider memory: each provider's OWN last model + base URL. Switching
   *  to a provider restores ITS settings, so bouncing between (say) a remote
   *  llama-server, nim:qwen, and ollama no longer wipes the others. */
  providers?: Record<string, ProviderMemory>;
}

// On disk: a global entry (fallback for a brand-new folder) plus a per-CWD map,
// so each project folder reopens with the provider/model IT last used — not
// whatever the most-recent OTHER folder happened to set.
interface LastSessionFile extends LastSession {
  byCwd?: Record<string, LastSession>;
}

function defaultPath(): string {
  return join(APP_DIR, "last-session.json");
}

// Under the test runner, ignore the real file unless a path is passed explicitly,
// so loadConfig tests stay deterministic (and a test never pollutes the real one).
const underTest = process.env.NODE_ENV === "test";

function readFile(p: string): LastSessionFile {
  try {
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf8")) as LastSessionFile;
  } catch {
    return {};
  }
}

const pick = (e: LastSession): LastSession => ({ provider: e.provider, model: e.model, baseUrl: e.baseUrl, providers: e.providers });

/** The remembered session for a folder: its OWN per-CWD entry when present, else
 *  the global last-used (so a never-seen folder still opens somewhere sensible). */
export function readLastSession(path?: string, cwd?: string): LastSession {
  if (path === undefined && underTest) return {};
  const file = readFile(path ?? defaultPath());
  if (cwd && file.byCwd?.[cwd]) return pick(file.byCwd[cwd]!);
  return pick(file);
}

// Merge a new (provider, model, baseUrl) into an entry: update this provider's
// per-provider slot, keep the others, and set the entry's last-used fields.
function mergeEntry(existing: LastSession | undefined, s: LastSession): LastSession {
  const providers: Record<string, ProviderMemory> = { ...(existing?.providers ?? {}) };
  if (s.provider) providers[s.provider] = { model: s.model, baseUrl: s.baseUrl };
  return { provider: s.provider, model: s.model, baseUrl: s.baseUrl, providers };
}

export function writeLastSession(s: LastSession, path?: string, cwd?: string): void {
  if (path === undefined && underTest) return;
  const p = path ?? defaultPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const file = readFile(p);
    // Update the global last-used (fallback for new folders) AND this folder's
    // own entry, so each folder keeps its own provider/model independently.
    const next: LastSessionFile = mergeEntry(file, s);
    const byCwd = { ...(file.byCwd ?? {}) };
    if (cwd) byCwd[cwd] = mergeEntry(file.byCwd?.[cwd], s);
    next.byCwd = byCwd;
    writeFileSync(p, JSON.stringify(next, null, 2));
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

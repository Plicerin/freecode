// Last-known-good cache for recalled memory. recall() is fail-soft — a slow or
// briefly-unreachable Honcho makes it return an empty block, which looks like
// memory VANISHED (worked one session, gone the next). This machine-local cache
// keeps the last non-empty recall per workspace, so a transient failure degrades
// to "slightly stale" instead of "gone". Kept separate from settings, like the
// other machine-managed files.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { APP_DIR } from "../utils/paths";
import { debug } from "../utils/debug";

interface CacheFile {
  byWorkspace?: Record<string, { block: string; ts: string }>;
}

// Under the test runner, ignore the real file unless a path is passed explicitly,
// so tests stay deterministic and never touch the real cache.
const underTest = process.env.NODE_ENV === "test";

function defaultPath(): string {
  return join(APP_DIR, "memory-cache.json");
}

function readFileSafe(p: string): CacheFile {
  try {
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

/** The last non-empty recalled block for a workspace, or null. */
export function readMemoryCache(workspace: string, path?: string): string | null {
  if (path === undefined && underTest) return null;
  const f = readFileSafe(path ?? defaultPath());
  const block = f.byWorkspace?.[workspace]?.block;
  return block && block.trim() ? block : null;
}

/** Cache a good (non-empty) recalled block for a workspace. Never throws. */
export function writeMemoryCache(workspace: string, block: string, path?: string): void {
  if (!block.trim()) return; // never cache an empty block over a good one
  if (path === undefined && underTest) return;
  const p = path ?? defaultPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const f = readFileSafe(p);
    const byWorkspace = { ...(f.byWorkspace ?? {}) };
    byWorkspace[workspace] = { block, ts: new Date().toISOString() };
    writeFileSync(p, JSON.stringify({ ...f, byWorkspace }, null, 2));
  } catch (e) {
    debug.warn("memory cache write failed", String(e));
  }
}

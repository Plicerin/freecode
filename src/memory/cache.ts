// Last-known-good cache for recalled memory. recall() is fail-soft — a slow or
// briefly-unreachable Honcho makes it return an empty block, which looks like
// memory VANISHED (worked one session, gone the next). This machine-local cache
// keeps the last non-empty recall per SCOPE, so a transient failure degrades to
// "slightly stale" instead of "gone". Kept separate from settings, like the
// other machine-managed files.
//
// The scope is workspace + project (see store.ts) — NOT just the workspace. A
// workspace-only key was a cross-project leak: a fresh project's empty recall
// fell back to whatever project was cached last and served its block verbatim,
// so freecode opened believing it was mid-work on a different project.
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { writeFileAtomic } from "../utils/atomic";
import { join, dirname } from "node:path";
import { APP_DIR } from "../utils/paths";
import { debug } from "../utils/debug";

interface CacheFile {
  byScope?: Record<string, { block: string; ts: string }>;
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

/** The last non-empty recalled block for a scope (workspace+project), or null. */
export function readMemoryCache(scope: string, path?: string): string | null {
  if (path === undefined && underTest) return null;
  const f = readFileSafe(path ?? defaultPath());
  const block = f.byScope?.[scope]?.block;
  return block && block.trim() ? block : null;
}

/** Cache a good (non-empty) recalled block for a scope. Never throws. */
export function writeMemoryCache(scope: string, block: string, path?: string): void {
  if (!block.trim()) return; // never cache an empty block over a good one
  if (path === undefined && underTest) return;
  const p = path ?? defaultPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const f = readFileSafe(p);
    const byScope = { ...(f.byScope ?? {}) };
    byScope[scope] = { block, ts: new Date().toISOString() };
    // Write ONLY byScope — deliberately dropping any legacy `byWorkspace` map so
    // the old workspace-keyed (cross-project-leaked) entry is cleaned up the
    // first time any project caches a good recall, not carried forward forever.
    writeFileAtomic(p, JSON.stringify({ byScope }, null, 2));
  } catch (e) {
    debug.warn("memory cache write failed", String(e));
  }
}

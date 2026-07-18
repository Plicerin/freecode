// Persist "allow always" tool grants PER PROJECT FOLDER so they survive a
// relaunch. In-memory grants reset every launch, which reads as "permissions
// don't stick" — you re-approve FileWrite in the same project every time. This is
// a small machine-managed file, kept separate from settings.json so it never
// clobbers hand-edited (possibly commented) config.
//
// SAFETY: command execution (Bash) is NEVER persisted. Auto-approving arbitrary
// commands on every future launch of a folder is too powerful, so Bash always
// re-confirms each session even if you pressed "always". The exclusion is applied
// on BOTH write and read, so a hand-edited file can't smuggle Bash back in.
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { writeFileAtomic } from "../utils/atomic";
import { join, dirname } from "node:path";
import { APP_DIR } from "../utils/paths";
import type { GrantStore } from "../permissions/modes";
import { debug } from "../utils/debug";

// Tools whose allow-always is never remembered across sessions.
const NON_PERSISTED = new Set<string>(["Bash"]);

/** May this tool's allow-always grant be persisted across sessions? */
export function isPersistableTool(tool: string): boolean {
  return !NON_PERSISTED.has(tool);
}

// On disk: a per-CWD map of granted tool names, so each project folder keeps its
// own standing approvals independent of the others.
interface GrantsFile {
  byCwd?: Record<string, string[]>;
}

// Under the test runner, ignore the real file unless a path is passed explicitly,
// so tests stay deterministic and never pollute the real grants file.
const underTest = process.env.NODE_ENV === "test";

function defaultPath(): string {
  return join(APP_DIR, "permissions.json");
}

function readFileSafe(p: string): GrantsFile {
  try {
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf8")) as GrantsFile;
  } catch {
    return {};
  }
}

/** Persisted allow-always tool names for a project folder (Bash filtered out). */
export function readGrants(cwd: string, path?: string): string[] {
  if (path === undefined && underTest) return [];
  const file = readFileSafe(path ?? defaultPath());
  return (file.byCwd?.[cwd] ?? []).filter(isPersistableTool);
}

/** Persist one allow-always grant for a folder. No-op for non-persistable tools
 *  (Bash) and if it's already saved. Never throws — remembering must not break a run. */
export function persistGrant(cwd: string, tool: string, path?: string): void {
  if (!isPersistableTool(tool)) return;
  if (path === undefined && underTest) return;
  const p = path ?? defaultPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const file = readFileSafe(p);
    const byCwd = { ...(file.byCwd ?? {}) };
    const cur = new Set(byCwd[cwd] ?? []);
    if (cur.has(tool)) return; // already saved
    cur.add(tool);
    byCwd[cwd] = [...cur].sort();
    writeFileAtomic(p, JSON.stringify({ ...file, byCwd }, null, 2));
  } catch (e) {
    debug.warn("could not persist permission grant", String(e));
  }
}

/** A GrantStore bound to a project folder, for createPermissionEngine. */
export function makeGrantStore(cwd: string, path?: string): GrantStore {
  return {
    load: () => readGrants(cwd, path),
    persist: (tool) => persistGrant(cwd, tool, path),
  };
}

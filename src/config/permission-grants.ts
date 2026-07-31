// Persist "allow always" grants for read-only built-ins PER PROJECT FOLDER so
// they survive a relaunch. Mutating, command-execution, and external tool grants
// stay session-only. This machine-managed file is separate from settings.json so
// it never clobbers hand-edited (possibly commented) config.
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { writeFileAtomic } from "../utils/atomic";
import { join, dirname } from "node:path";
import { APP_DIR } from "../utils/paths";
import type { GrantStore } from "../permissions/modes";
import { debug } from "../utils/debug";

// Persist only intrinsically read-only built-ins. A tool-wide grant has no
// argument/path scope, so persisting FileWrite/FileEdit or an external MCP tool
// would silently authorize unrelated future mutations after a relaunch.
const PERSISTABLE = new Set<string>(["FileRead", "Glob", "Grep", "WebSearch", "WebFetch", "ViewImage", "Skill"]);

/** May this tool's allow-always grant be persisted across sessions? */
export function isPersistableTool(tool: string): boolean {
  return PERSISTABLE.has(tool);
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

/** Persisted allow-always read-only tool names for a project folder. */
export function readGrants(cwd: string, path?: string): string[] {
  if (path === undefined && underTest) return [];
  const file = readFileSafe(path ?? defaultPath());
  return (file.byCwd?.[cwd] ?? []).filter(isPersistableTool);
}

/** Persist one allow-always grant for a folder. No-op for non-persistable tools
 * and if it's already saved. Never throws — remembering must not break a run. */
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

import { existsSync, statSync, readFileSync, mkdirSync, readdirSync, copyFileSync, unlinkSync } from "node:fs";
import { join, isAbsolute, resolve, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { APP_DIR } from "../utils/paths";
import { debug } from "../utils/debug";
import { pathFromDiffHeader } from "./file-edit";

// A local shadow copy of every file a tool is about to mutate, taken JUST BEFORE
// the mutation runs. This is the safety net that turns "the model truncated my
// file and there's no git history" (a real, catastrophic incident) into a
// one-command recovery. Snapshots are keyed by the file's absolute path and kept
// as a small ring buffer per file. Everything here is FAIL-SOFT: a backup must
// never throw, block, or slow down the tool it guards.

/** Root of the shadow-backup store. Overridable via env for hermetic tests. */
export function backupsRoot(): string {
  return process.env.FREECODE_BACKUPS_DIR || join(APP_DIR, "backups");
}

const MAX_BACKUP_BYTES = 5_000_000; // don't shadow huge/generated blobs
const KEEP_PER_FILE = 30; // ring-buffer depth per file

function sha1(buf: Buffer | string): string {
  return createHash("sha1").update(buf).digest("hex");
}

/** The backup folder for one file. Deterministic from the absolute path, so
 *  /recover finds the same folder without any index. Named `<basename>-<hash>`
 *  (readable + collision-free, and short enough for Windows MAX_PATH). */
export function backupFolderFor(absPath: string): string {
  const dirHash = sha1(dirname(absPath).replace(/[\\/]+/g, "/").toLowerCase()).slice(0, 10);
  const safeBase = basename(absPath).replace(/[^\w.-]/g, "_").slice(0, 80);
  return join(backupsRoot(), `${safeBase}-${dirHash}`);
}

export interface BackupEntry {
  path: string;
  hash: string;
  mtimeMs: number;
}

/** Existing snapshots for a file, oldest→newest (by name, which is ISO-prefixed). */
export function listBackups(absPath: string): BackupEntry[] {
  const dir = backupFolderFor(absPath);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".bak"))
      .sort()
      .map((f) => {
        const m = f.match(/__([0-9a-f]+)\.bak$/);
        const p = join(dir, f);
        return { path: p, hash: m?.[1] ?? "", mtimeMs: statSync(p).mtimeMs };
      });
  } catch (err) {
    debug.warn(`listBackups failed for ${absPath}`, String(err));
    return [];
  }
}

function prune(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".bak")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try { unlinkSync(join(dir, f)); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

/** Shadow-copy `absPath`'s CURRENT bytes before it is overwritten. Returns the
 *  backup path, or null when there's nothing worth backing up (file absent, a
 *  new file, binary, empty, too big, or identical to the last snapshot). */
// Files whose CONTENT is a secret — never drop a verbatim plaintext copy of these
// into ~/.freecode/backups. The tradeoff: if the model truncates a .env, /recover
// can't restore it (regenerate/rotate instead of keeping plaintext keys around).
const SECRET_FILE = /(^|[\\/])(\.env(\.[\w-]+)?|\.?netrc|credentials?(\.[\w-]+)?|secrets?(\.[\w-]+)?|id_[a-z0-9]+|.*\.(pem|key|pfx|p12|keystore|jks|ppk|asc))$/i;

export function snapshotFile(absPath: string): string | null {
  try {
    if (!absPath || !isAbsolute(absPath) || !existsSync(absPath)) return null;
    if (SECRET_FILE.test(absPath)) return null; // don't shadow-copy secret files in cleartext
    const st = statSync(absPath);
    if (!st.isFile() || st.size === 0 || st.size > MAX_BACKUP_BYTES) return null;
    const buf = readFileSync(absPath);
    if (buf.subarray(0, 8192).includes(0)) return null; // binary — skip
    const hash = sha1(buf).slice(0, 12);
    const dir = backupFolderFor(absPath);
    const existing = listBackups(absPath);
    // No-op if the newest snapshot is already this exact content.
    const newest = existing[existing.length - 1];
    if (newest && newest.hash === hash) return null;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(dir, `${stamp}__${hash}.bak`);
    copyFileSync(absPath, dest);
    prune(dir, KEEP_PER_FILE);
    return dest;
  } catch (err) {
    debug.warn(`snapshotFile failed for ${absPath}`, String(err));
    return null;
  }
}

/** Parse a shell command for the files it is about to WRITE (overwrite/append),
 *  so we can shadow them before a raw `node -e "...writeFileSync..."` or a `>`
 *  redirect clobbers a source file — the exact class of edit that bypasses
 *  FileWrite/FileEdit and their guards. Heuristic and deliberately generous:
 *  an extra harmless snapshot is fine; a missed one is not. */
export function extractBashWriteTargets(command: string, cwd: string): string[] {
  const out = new Set<string>();
  const add = (raw?: string | null): void => {
    if (!raw) return;
    let p = raw.trim().replace(/^['"`]+|['"`]+$/g, "").trim();
    if (!p || p.length > 400) return;
    if (/[$%`*?<>]/.test(p)) return; // shell var / glob / stream marker — can't resolve safely
    if (/^&/.test(p)) return; // `2>&1` style fd redirect
    if (/^(?:\/dev\/null|nul|null|con)$/i.test(p)) return;
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    out.add(abs);
  };

  // node: fs.writeFileSync / writeFile / appendFileSync / appendFile('path', …)
  for (const m of command.matchAll(/\b(?:write|append)File(?:Sync)?\s*\(\s*(['"`])([^'"`]+)\1/gi)) add(m[2]);
  // shell output redirect  > file  /  >> file   (not 1>/2> fd redirects)
  for (const m of command.matchAll(/(?<![0-9&])>>?\s*([^\s'"|;&<>]+)/g)) add(m[1]);
  // PowerShell write cmdlets with an explicit path parameter
  for (const m of command.matchAll(/-(?:FilePath|Path|LiteralPath|Destination)\s+(['"][^'"]+['"]|[^\s;|]+)/gi)) add(m[1]);
  // PowerShell write cmdlets with a positional path
  for (const m of command.matchAll(/\b(?:Out-File|Set-Content|Add-Content|Tee-Object)\b\s+(?!-)(['"][^'"]+['"]|[^\s;|]+)/gi)) add(m[1]);

  return [...out].slice(0, 20);
}

/** Snapshot everything a tool call is about to mutate, before it runs. Called
 *  from the agent loop for FileWrite/FileEdit (the declared path) and Bash (any
 *  write target parsed from the command). Returns the paths actually snapshotted. */
export function snapshotBeforeToolRun(toolName: string, args: unknown, cwd: string): string[] {
  const done: string[] = [];
  try {
    const a = (args ?? {}) as { path?: unknown; command?: unknown; cwd?: unknown; unifiedDiff?: unknown; diff?: unknown };
    if (toolName === "FileWrite" || toolName === "FileEdit") {
      // FileEdit may omit `path` when a unifiedDiff header names the file — derive it
      // the same way FileEdit.run does, so that edit shape is also shadow-backed.
      let rel = typeof a.path === "string" ? a.path : undefined;
      if (!rel && toolName === "FileEdit") {
        const diff = typeof a.unifiedDiff === "string" ? a.unifiedDiff : typeof a.diff === "string" ? a.diff : undefined;
        if (diff) rel = pathFromDiffHeader(diff) ?? undefined;
      }
      if (rel) {
        const abs = isAbsolute(rel) ? rel : resolve(cwd, rel);
        if (snapshotFile(abs)) done.push(abs);
      }
    } else if (toolName === "Bash" && typeof a.command === "string") {
      const base = typeof a.cwd === "string" ? a.cwd : cwd;
      for (const abs of extractBashWriteTargets(a.command, base)) {
        if (snapshotFile(abs)) done.push(abs);
      }
    }
  } catch (err) {
    debug.warn("snapshotBeforeToolRun failed", String(err));
  }
  return done;
}

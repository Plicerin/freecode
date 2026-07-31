import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { listSessions, readSession, type SessionEvent } from "./manager";
import { listBackups } from "../tools/backup";
import { debug } from "../utils/debug";

// Reconstruct a file's earlier contents after a destructive edit. Two sources,
// unioned: (1) the on-disk shadow backups taken before each mutation, and
// (2) the session log itself — every FileWrite records the exact bytes it wrote,
// and every complete FileRead records the file as it was at read time. Source (2)
// works RETROACTIVELY, even for files damaged before backups existed — it's how
// a truncated file with no git history is still recoverable.

export interface RecoverSnapshot {
  content: string;
  ts: string; // ISO
  source: "backup" | "write" | "read";
  sessionId?: string;
  lines: number;
  bytes: number;
  hash: string;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function resolveLogPath(p: unknown, cwd: string): string | null {
  if (typeof p !== "string" || !p) return null;
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Strip FileRead's line-number gutter and trailing freecode note. Reports
 *  whether the read was truncated (a partial read is NOT a faithful snapshot). */
export function deNumberReadOutput(out: string): { content: string; partial: boolean } {
  const partial = /use offset\/limit to read more/.test(out) || /\[\+\d+ chars\]/.test(out) || /output capped at/.test(out);
  // Remove the trailing "[… — use offset/limit to read more]" style note only.
  const text = out.replace(/\n\n\[(?:[^\]]*(?:use offset\/limit|long lines clipped|output capped|read first)[^\]]*)\]\s*$/, "");
  const content = text.split("\n").map((l) => l.replace(/^\s*\d+\t/, "")).join("\n");
  return { content, partial };
}

function stat(content: string, source: RecoverSnapshot["source"], ts: string, sessionId?: string): RecoverSnapshot {
  return {
    content,
    ts,
    source,
    sessionId,
    lines: content.split("\n").length,
    bytes: Buffer.byteLength(content, "utf8"),
    hash: createHash("sha1").update(content).digest("hex").slice(0, 12),
  };
}

/** Reconstruct every snapshot of `targetAbs` from ONE session's events:
 *  FileWrite records the exact bytes written; a complete FileRead records the
 *  file as it was. Pure (no filesystem) so it's directly testable. */
export function snapshotsFromEvents(events: SessionEvent[], sessionCwd: string, sessionId: string, targetAbs: string): RecoverSnapshot[] {
  const cands: RecoverSnapshot[] = [];
  const calls = new Map<string, Extract<SessionEvent, { kind: "tool_call" }>>();
  for (const e of events) {
    if (e.kind === "tool_call") { calls.set(e.id, e); continue; }
    if (e.kind !== "tool_result") continue;
    const call = calls.get(e.id);
    if (!call) continue;
    const path = resolveLogPath((call.args as { path?: unknown }).path, sessionCwd);
    if (!path || !samePath(path, targetAbs)) continue;
    if (call.name === "FileWrite" && e.ok) {
      const content = (call.args as { content?: unknown }).content;
      if (typeof content === "string" && content.length > 0) {
        cands.push(stat(content, "write", call.ts, sessionId));
      }
    } else if (call.name === "FileRead" && e.ok && e.output.length > 0) {
      if ((call.args as { offset?: unknown }).offset) continue; // a page, not the whole file
      const { content, partial } = deNumberReadOutput(e.output);
      if (!partial && content.length > 0) cands.push(stat(content, "read", call.ts, sessionId));
    }
  }
  return cands;
}

/** Collapse candidates to DISTINCT versions (by content), newest sighting wins,
 *  sorted newest-first. */
export function dedupeSnapshots(cands: RecoverSnapshot[]): RecoverSnapshot[] {
  const byHash = new Map<string, RecoverSnapshot>();
  for (const c of cands) {
    const prev = byHash.get(c.hash);
    if (!prev || c.ts > prev.ts) byHash.set(c.hash, c);
  }
  return [...byHash.values()].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

/** All distinct earlier versions of `targetAbs`, newest-first. Unions the
 *  on-disk shadow backups with every project session's log reconstruction. */
export function collectSnapshots(cwd: string, targetAbs: string): RecoverSnapshot[] {
  const cands: RecoverSnapshot[] = [];

  // (1) On-disk shadow backups — exact bytes, always complete.
  for (const b of listBackups(targetAbs)) {
    try {
      const buf = readFileSync(b.path);
      if (buf.subarray(0, 8192).includes(0)) continue;
      cands.push(stat(buf.toString("utf8"), "backup", new Date(b.mtimeMs).toISOString()));
    } catch (err) {
      debug.warn(`recover: unreadable backup ${b.path}`, String(err));
    }
  }

  // (2) Session logs for this project — FileWrite contents and complete FileReads.
  for (const session of listSessions(cwd)) {
    let events: SessionEvent[];
    try { events = readSession(session); } catch { continue; }
    cands.push(...snapshotsFromEvents(events, session.cwd, session.id, targetAbs));
  }

  return dedupeSnapshots(cands);
}

/** Write a recovered version beside the file as `<path>.recovered` — NEVER
 *  overwrites the working file. Returns the destination path. */
export function writeRecovered(targetAbs: string, content: string): string {
  const dest = `${targetAbs}.recovered`;
  writeFileSync(dest, content, "utf8");
  return dest;
}

/** Line/byte summary of the current on-disk file, or null if it doesn't exist. */
export function currentFileInfo(targetAbs: string): { lines: number; bytes: number } | null {
  if (!existsSync(targetAbs)) return null;
  try {
    const buf = readFileSync(targetAbs);
    return { lines: buf.toString("utf8").split("\n").length, bytes: buf.length };
  } catch {
    return null;
  }
}

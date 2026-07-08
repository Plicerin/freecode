import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { projectDir, sessionPath, PROJECTS_DIR } from "../utils/paths";
import { newId, nowIso } from "../utils/ids";
import { debug } from "../utils/debug";
import type { ChatMessage } from "../providers/types";

export type SessionEvent =
  | { kind: "user"; text: string; ts: string }
  | { kind: "assistant"; text: string; ts: string; usage?: Record<string, number> }
  | { kind: "tool_call"; id: string; name: string; args: Record<string, unknown>; ts: string }
  | { kind: "tool_result"; id: string; output: string; ok: boolean; ts: string; durationMs: number }
  | { kind: "thinking"; text: string; ts: string }
  | { kind: "title"; text: string; ts: string }
  | { kind: "system"; text: string; ts: string };

export interface Session {
  id: string;
  cwd: string;
  path: string;
}

// Richer listing for the resume picker: a human title (if set via /rename), a
// preview of the first prompt, message count, and last-modified time.
export interface SessionMeta extends Session {
  title?: string;
  preview: string;
  count: number;
  mtime: number;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function newSession(cwd: string): Session {
  ensureDir(PROJECTS_DIR);
  ensureDir(projectDir(cwd));
  const id = newId();
  const path = sessionPath(cwd, id);
  if (!existsSync(path)) {
    appendFileSync(path, JSON.stringify({ kind: "system", text: `session start cwd=${cwd}`, ts: nowIso() }) + "\n");
  }
  debug.log("new session", { id, path });
  return { id, cwd, path };
}

export function appendEvent(session: Session, event: SessionEvent): void {
  ensureDir(projectDir(session.cwd));
  appendFileSync(session.path, JSON.stringify(event) + "\n");
}

export function listSessions(cwd: string): Session[] {
  const dir = projectDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const id = f.replace(/\.jsonl$/, "");
      const path = sessionPath(cwd, id);
      const mtime = statSync(path).mtimeMs;
      return { id, cwd, path, mtime } as Session & { mtime: number };
    })
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .map(({ mtime: _m, ...rest }) => rest as Session);
}

export function readSession(session: Session): SessionEvent[] {
  if (!existsSync(session.path)) return [];
  const raw = readFileSync(session.path, "utf8");
  const events: SessionEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      debug.warn(`corrupt line in ${session.path}`, String(err));
    }
  }
  return events;
}

export function resumeSession(cwd: string, id: string): Session | undefined {
  const path = sessionPath(cwd, id);
  if (!existsSync(path)) return undefined;
  return { id, cwd, path };
}

/** Give the session a human-readable name (latest title event wins). */
export function setSessionTitle(session: Session, title: string): void {
  appendEvent(session, { kind: "title", text: title, ts: nowIso() });
}

/** The current title of a session from its events, if any. */
export function titleOf(events: SessionEvent[]): string | undefined {
  let t: string | undefined;
  for (const e of events) if (e.kind === "title") t = e.text; // last one wins
  return t;
}

/** Every tool_result's FULL output from a session log, oldest→newest. The
 *  durable source for /expand: context compaction/trimming evicts tool output
 *  from the live model context, but the session log keeps all of it. */
export function toolOutputs(events: SessionEvent[]): string[] {
  return events
    .filter((e): e is Extract<SessionEvent, { kind: "tool_result" }> => e.kind === "tool_result" && e.output.length > 0)
    .map((e) => e.output);
}

// The provider-format conversation (the model's actual working context, incl.
// tool_use/tool_result pairs and any compaction summary) is persisted alongside
// the event log so /resume restores the REAL context — not the text-only,
// tool-stripped rebuild. Overwritten each turn (latest-wins), sized to whatever
// the live session held (bounded by compaction), so it never grows unbounded.
function statePath(session: Session): string {
  return session.path.replace(/\.jsonl$/, ".state.json");
}

/** Persist the live provider-format conversation so a resume continues with the
 *  full context (tool calls + results), not just user/assistant text. Never throws. */
export function writeConversationState(session: Session, messages: ChatMessage[]): void {
  try {
    const p = statePath(session);
    ensureDir(dirname(p));
    writeFileSync(p, JSON.stringify({ v: 1, messages }));
  } catch (err) {
    debug.warn(`could not persist conversation state for ${session.id}`, String(err));
  }
}

/** The persisted provider-format conversation, if any. undefined for sessions
 *  saved before this existed (the caller falls back to historyFromEvents). */
export function readConversationState(session: Session): ChatMessage[] | undefined {
  const p = statePath(session);
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { v?: number; messages?: ChatMessage[] };
    return Array.isArray(parsed.messages) ? parsed.messages : undefined;
  } catch (err) {
    debug.warn(`corrupt conversation state for ${session.id}`, String(err));
    return undefined;
  }
}

/** Sessions with display metadata, newest first — for the resume picker. */
export function listSessionMetas(cwd: string): SessionMeta[] {
  const dir = projectDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const id = f.replace(/\.jsonl$/, "");
      const path = sessionPath(cwd, id);
      const mtime = statSync(path).mtimeMs;
      const events = readSession({ id, cwd, path });
      const firstUser = events.find((e) => e.kind === "user") as { text?: string } | undefined;
      const preview = (firstUser?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      const count = events.filter((e) => e.kind === "user" || e.kind === "assistant").length;
      return { id, cwd, path, title: titleOf(events), preview, count, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

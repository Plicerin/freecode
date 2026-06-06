// Background-job registry (ROADMAP Tier A — background sessions). A background
// job is one headless agent run in a DETACHED child process, so the REPL (or the
// shell) gets its prompt back immediately and the work continues independently.
//
// State lives as one JSON file per job under ~/.freecode/bg/<id>.json (plus a
// <id>.log of its output). One-file-per-job — not a shared index — so a detached
// child writing its own status never races the parent listing jobs. Everything
// takes an optional `root` so tests target a temp dir instead of the real home.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "../utils/paths";

export type BgStatus = "running" | "done" | "failed" | "stopped";

export interface BgJob {
  id: string;
  prompt: string;
  cwd: string;
  provider: string;
  model: string;
  pid?: number;
  status: BgStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  /** Final assistant text once finished (short preview kept for `bg list`). */
  summary?: string;
  logPath: string;
}

export function bgDir(root: string = APP_DIR): string {
  return join(root, "bg");
}
export function jobFile(id: string, root: string = APP_DIR): string {
  return join(bgDir(root), `${id}.json`);
}
export function logFile(id: string, root: string = APP_DIR): string {
  return join(bgDir(root), `${id}.log`);
}

/** Persist a job atomically (write temp + rename) so a reader never sees half a file. */
export function saveJob(job: BgJob, root: string = APP_DIR): void {
  mkdirSync(bgDir(root), { recursive: true });
  const tmp = jobFile(job.id, root) + ".tmp";
  writeFileSync(tmp, JSON.stringify(job, null, 2));
  renameSync(tmp, jobFile(job.id, root));
}

export function readJob(id: string, root: string = APP_DIR): BgJob | undefined {
  const f = jobFile(id, root);
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as BgJob;
  } catch {
    return undefined;
  }
}

/** Apply a patch to a stored job and persist it. Returns the updated job. */
export function updateJob(id: string, patch: Partial<BgJob>, root: string = APP_DIR): BgJob | undefined {
  const cur = readJob(id, root);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  saveJob(next, root);
  return next;
}

/** All jobs, newest first. */
export function listJobs(root: string = APP_DIR): BgJob[] {
  const dir = bgDir(root);
  if (!existsSync(dir)) return [];
  const jobs: BgJob[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const j = readJob(f.slice(0, -5), root);
    if (j) jobs.push(j);
  }
  return jobs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** Is a process still running? `kill(pid, 0)` throws ESRCH if it's gone. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it — still alive.
    return (err as { code?: string }).code === "EPERM";
  }
}

/** Reconcile reality: any job marked `running` whose process is gone died without
 *  recording its result — mark it failed so the list reflects the truth. */
export function reapJobs(root: string = APP_DIR, alive: (pid: number) => boolean = isPidAlive): BgJob[] {
  const jobs = listJobs(root);
  for (const j of jobs) {
    if (j.status === "running" && (j.pid === undefined || !alive(j.pid))) {
      j.status = "failed";
      j.finishedAt = j.finishedAt ?? new Date().toISOString();
      j.summary = j.summary ?? "(process exited without completing)";
      saveJob(j, root);
    }
  }
  return jobs;
}

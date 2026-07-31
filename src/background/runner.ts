// Spawning + executing background jobs. `startBackground` launches a DETACHED
// child that re-invokes this same CLI in a hidden `bg-exec <id>` mode; the child
// runs the headless agent loop, streams to a log file, and records its own final
// status. The parent returns immediately. Nothing here keeps a long-lived daemon
// alive — the OS owns the detached child; the registry is the source of truth.
import { openSync, closeSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { CliFlags } from "../config/loader";
import { loadConfig } from "../config/loader";
import { runHeadless } from "../agent/headless";
import { newId, nowIso } from "../utils/ids";
import { logFile, saveJob, readJob, updateJob, isPidAlive, type BgJob } from "./registry";

/** How to re-invoke THIS cli for the detached child — works whether we're run as
 *  `bun run src/cli.tsx` / `node dist/cli.js` (argv[1] is the script) or as a
 *  compiled single-file exe (the runtime itself is the entrypoint). */
export function selfInvocation(extra: string[]): { cmd: string; args: string[] } {
  const runtime = process.execPath;
  const script = process.argv[1];
  if (script && existsSync(script)) return { cmd: runtime, args: [script, ...extra] };
  return { cmd: runtime, args: extra };
}

/** Create a job and launch its detached worker. Returns the recorded job. */
export function startBackground(prompt: string, flags: CliFlags, root?: string): BgJob {
  const cwd = process.cwd();
  const config = loadConfig({ flags });
  const id = newId();
  const job: BgJob = {
    id,
    prompt,
    cwd,
    provider: config.provider,
    model: config.model,
    status: "running",
    startedAt: nowIso(),
    logPath: logFile(id, root),
  };
  saveJob(job, root);

  // The child writes its own stdout/stderr straight to the log file, and updates
  // its job status when done. detached + unref so it outlives this process.
  const out = openSync(job.logPath, "a");
  const extra = ["bg-exec", id, ...(root ? ["--bg-root", root] : [])];
  const { cmd, args } = selfInvocation(extra);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd,
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      env: { ...process.env, FREECODE_BG_CHILD: "1" },
    });
  } finally {
    try { closeSync(out); } catch { /* already closed */ }
  }
  child.unref();

  saveJob({ ...job, pid: child.pid }, root);
  return { ...job, pid: child.pid };
}

/** The detached child's entry: run the job to completion and record the result.
 *  Output already goes to the log via the inherited stdio, so the sink writes
 *  there too (for code paths that don't inherit, e.g. tests). */
export async function runBackgroundJob(id: string, root?: string): Promise<void> {
  const job = readJob(id, root);
  if (!job) {
    process.stderr.write(`[bg] no such job: ${id}\n`);
    process.exit(1);
  }
  updateJob(id, { pid: process.pid }, root);
  // Honour the provider/model the job was started with (the REPL's live choice),
  // not just whatever the default config resolves to.
  const flags: CliFlags = { provider: job.provider as CliFlags["provider"], model: job.model };
  const sink = (chunk: string): void => {
    try { appendFileSync(job.logPath, chunk); } catch { /* best-effort log */ }
  };
  appendFileSync(job.logPath, `\n=== bg job ${id} started ${nowIso()} ===\n${job.prompt}\n---\n`);
  let ok = false;
  let summary = "";
  try {
    const res = await runHeadless({ prompt: job.prompt, flags, cwd: job.cwd, sink });
    ok = res.ok;
    summary = res.finalText.replace(/\s+/g, " ").trim().slice(0, 200);
  } catch (err) {
    summary = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  updateJob(id, {
    status: ok ? "done" : "failed",
    finishedAt: nowIso(),
    exitCode: ok ? 0 : 1,
    summary: summary || (ok ? "(no text output)" : "(failed)"),
  }, root);
  appendFileSync(job.logPath, `\n=== ${ok ? "done" : "failed"} ${nowIso()} ===\n`);
}

/** Stop a running job by signalling its process; mark it stopped. */
export function stopJob(id: string, root?: string): boolean {
  const job = readJob(id, root);
  if (!job) return false;
  if (job.status === "running" && job.pid && isPidAlive(job.pid)) {
    try { process.kill(job.pid); } catch { /* already gone */ }
  }
  updateJob(id, { status: "stopped", finishedAt: nowIso(), summary: job.summary ?? "(stopped by user)" }, root);
  return true;
}

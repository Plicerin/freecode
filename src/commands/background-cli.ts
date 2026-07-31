// CLI surface for background jobs: `freecode bg <run|list|logs|status|stop>` and
// the hidden `bg-exec <id>` the detached worker re-enters through. Kept thin —
// all the real logic is in src/background/.
import { readFileSync, existsSync } from "node:fs";
import type { CliFlags } from "../config/loader";
import { startBackground, runBackgroundJob, stopJob } from "../background/runner";
import { reapJobs, readJob, type BgJob, type BgStatus } from "../background/registry";

const ICON: Record<BgStatus, string> = { running: "●", done: "✓", failed: "✗", stopped: "◼" };

function rel(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatJobLine(j: BgJob): string {
  const when = j.status === "running" ? `started ${rel(j.startedAt)}` : j.finishedAt ? rel(j.finishedAt) : "";
  const preview = j.prompt.replace(/\s+/g, " ").trim().slice(0, 50);
  return `${ICON[j.status]} ${j.id}  ${j.status.padEnd(7)} ${when.padEnd(12)} ${preview}`;
}

/** `freecode bg ...` — dispatch the subcommand. Returns a process exit code. */
export async function runBackgroundCommand(argv: string[], flags: CliFlags): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "run": {
      const prompt = rest.join(" ").trim();
      if (!prompt) { process.stderr.write("Usage: freecode bg run <prompt>\n"); return 2; }
      const job = startBackground(prompt, flags);
      process.stdout.write(`Started background job ${job.id} (pid ${job.pid ?? "?"}).\n`);
      process.stdout.write(`  follow: freecode bg logs ${job.id}\n  list:   freecode bg list\n`);
      return 0;
    }
    case undefined:
    case "list":
    case "status": {
      const jobs = reapJobs();
      if (!jobs.length) { process.stdout.write("No background jobs. Start one with: freecode bg run <prompt>\n"); return 0; }
      const running = jobs.filter((j) => j.status === "running").length;
      process.stdout.write(`Background jobs (${jobs.length}, ${running} running):\n`);
      for (const j of jobs) process.stdout.write(`  ${formatJobLine(j)}\n`);
      return 0;
    }
    case "logs": {
      const id = rest[0];
      if (!id) { process.stderr.write("Usage: freecode bg logs <id>\n"); return 2; }
      const job = readJob(id);
      if (!job || !existsSync(job.logPath)) { process.stderr.write(`No log for job ${id}\n`); return 1; }
      process.stdout.write(readFileSync(job.logPath, "utf8"));
      return 0;
    }
    case "stop": {
      const id = rest[0];
      if (!id) { process.stderr.write("Usage: freecode bg stop <id>\n"); return 2; }
      const okStop = stopJob(id);
      process.stdout.write(okStop ? `Stopped job ${id}.\n` : `No such job: ${id}\n`);
      return okStop ? 0 : 1;
    }
    default:
      process.stderr.write(`Unknown bg command: ${sub}. Use run|list|logs|status|stop.\n`);
      return 2;
  }
}

/** Hidden worker entry: `freecode bg-exec <id> [--bg-root <dir>]`. */
export async function runBgExec(argv: string[]): Promise<void> {
  const id = argv[0];
  const rootIdx = argv.indexOf("--bg-root");
  const root = rootIdx >= 0 ? argv[rootIdx + 1] : undefined;
  if (!id) { process.stderr.write("bg-exec requires a job id\n"); process.exit(2); }
  await runBackgroundJob(id, root);
  process.exit(0);
}

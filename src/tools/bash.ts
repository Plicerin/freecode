import { spawn } from "node:child_process";
import { openSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { APP_DIR } from "../utils/paths";
import type { Tool } from "./types";

const ArgsSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  env: z.record(z.string()).optional(),
  // Start a long-lived process (dev server, watcher, tunnel) DETACHED: returns
  // immediately with the pid + a log path instead of blocking until it exits.
  runInBackground: z.boolean().optional(),
});

const DEFAULT_ALLOW = [/.*/];
const DEFAULT_DENY: RegExp[] = [
  /\brm\s+-rf\s+\/(?:\s|$)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bcurl\b.*\|\s*(?:ba)?sh\b/,
  /\bwget\b.*\|\s*(?:ba)?sh\b/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bchmod\s+-R\s+777\s+\/(?:\s|$)/,
  // PowerShell catastrophic recursive delete of a drive root (defense-in-depth;
  // the permission prompt is the primary guard, so normal ./dir deletes are fine).
  /\bRemove-Item\b[^|\n]*-Recurse\b[^|\n]*-Force\b[^|\n]*\b[A-Za-z]:\\?(?:\s|$)/i,
];

export interface BashToolOptions {
  allow?: RegExp[];
  deny?: RegExp[];
  maxOutputBytes?: number;
  /** Override the Windows shell (default powershell.exe). */
  shellPath?: string;
}

const IS_WINDOWS = process.platform === "win32";

// Commands run non-interactively, so a wizard that waits on stdin would hang
// forever without this backstop. The model can override per-call up to the cap.
const DEFAULT_TIMEOUT_MS = 120_000;

/** The shell the Bash tool executes in, for the system prompt and UX. */
export function bashShellName(): string {
  return IS_WINDOWS ? "PowerShell" : "bash/sh";
}

/**
 * Build the spawn invocation for a command. On Windows we run PowerShell
 * explicitly (shell:true would use cmd.exe, which rejects PowerShell syntax);
 * on Unix we let the default shell interpret the command string.
 */
export function spawnArgs(command: string, shellPath?: string): { file: string; args: string[]; useShell: boolean } {
  if (IS_WINDOWS) {
    return { file: shellPath ?? "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command], useShell: false };
  }
  return { file: command, args: [], useShell: true };
}

interface RunCtx {
  cwd: string;
  signal?: AbortSignal;
}

/** Read the tail of a background log (the captured stdout/stderr), trimmed. */
function readLogTail(path: string, maxChars = 1500): string {
  try {
    const t = readFileSync(path, "utf8").trim();
    return t.length > maxChars ? "…" + t.slice(-maxChars) : t;
  } catch {
    return "";
  }
}

/**
 * Launch a long-lived command in the background and return at once. stdout+stderr
 * are captured to a log file the model can read back; the child is unref'd and
 * NOT tied to ctx.signal, so it outlives the turn (the whole point — a dev server
 * must keep running) and runs for the rest of the session.
 *
 * NOT `detached: true`: on Windows a detached child does not inherit our file
 * descriptors, so the log captures nothing (and a crash looks like a clean exit).
 * We wait briefly to catch an immediate failure — and surface the captured output
 * (e.g. a Python traceback, "address already in use") right in the error, since a
 * shell wrapper often exits 0 even when the real command crashed.
 */
function runDetached(
  args: z.infer<typeof ArgsSchema>,
  ctx: RunCtx,
  shellPath?: string,
): Promise<{ ok: boolean; output: string; error?: string; metadata?: Record<string, unknown> }> {
  const dir = join(APP_DIR, "bg-bash");
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.log`);
  let fd: number;
  try {
    fd = openSync(logPath, "a");
  } catch (err) {
    return Promise.resolve({ ok: false, output: "", error: `Could not open background log: ${(err as Error).message}` });
  }
  const inv = spawnArgs(args.command, shellPath);
  const child = spawn(inv.file, inv.args, {
    shell: inv.useShell,
    cwd: args.cwd ?? ctx.cwd,
    env: { ...process.env, ...(args.env ?? {}) },
    stdio: ["ignore", fd, fd], // no stdin; stdout+stderr → log file
  });
  const pid = child.pid;
  const stopHint = IS_WINDOWS ? `taskkill /PID ${pid} /F` : `kill ${pid}`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: boolean; output: string; error?: string; metadata?: Record<string, unknown> }): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    child.on("error", (err) => finish({ ok: false, output: "", error: `Failed to start background process: ${err.message}` }));
    const onEarlyExit = (code: number | null): void => {
      // Small delay so the OS flushes the child's last writes to the log.
      setTimeout(() => {
        const tail = readLogTail(logPath);
        const why = tail ? `\n--- captured output ---\n${tail}` : " (no output was captured)";
        finish({
          ok: false,
          output: "",
          error: `The background command exited right away (exit code ${code}) instead of staying up.${why}`,
          metadata: { pid, logPath, background: true },
        });
      }, 120);
    };
    child.on("exit", onEarlyExit);
    // Survived the startup window → treat it as running.
    setTimeout(() => {
      child.removeListener("exit", onEarlyExit);
      child.unref();
      const tail = readLogTail(logPath, 600);
      finish({
        ok: true,
        output:
          `Started in background (pid ${pid}). Runs until you stop it or this freecode session ends.\n` +
          `Output → ${logPath}` +
          (tail ? `\n--- so far ---\n${tail}` : "  (nothing logged yet — read it with FileRead to check progress)") +
          `\nStop it with: ${stopHint}`,
        metadata: { pid, logPath, background: true },
      });
    }, 600);
  });
}

export function createBashTool(opts: BashToolOptions = {}): Tool<z.infer<typeof ArgsSchema>> {
  const allow = opts.allow ?? DEFAULT_ALLOW;
  const deny = opts.deny ?? DEFAULT_DENY;
  const maxOutput = opts.maxOutputBytes ?? 200_000;

  return {
    name: "Bash",
    description: `Execute a shell command in ${bashShellName()}. Use for git, npm, scripts, system inspection. Runs NON-INTERACTIVELY (no stdin) with a ${DEFAULT_TIMEOUT_MS / 1000}s default timeout — for scaffolders/installers pass non-interactive flags (e.g. --yes), and set timeoutMs for long jobs. For a process that should KEEP RUNNING (a dev server, watcher, http.server, tunnel) set runInBackground:true — it launches detached and returns immediately with a pid + log path (do NOT run servers in the foreground; they'll just hit the timeout). Output is truncated if large.`,
    schema: ArgsSchema,
    permission: "confirm",
    async run(args, ctx) {
      for (const re of deny) {
        if (re.test(args.command)) {
          return {
            ok: false,
            output: "",
            error: `Command denied by safety policy (matched: ${re})`,
          };
        }
      }
      const allowMatch = allow.some((re) => re.test(args.command));
      if (!allowMatch) {
        return { ok: false, output: "", error: "Command not in allowlist" };
      }
      if (args.runInBackground) {
        return runDetached(args, ctx, opts.shellPath);
      }
      return new Promise((resolve) => {
        const inv = spawnArgs(args.command, opts.shellPath);
        const child = spawn(inv.file, inv.args, {
          shell: inv.useShell,
          cwd: args.cwd ?? ctx.cwd,
          env: { ...process.env, ...(args.env ?? {}) },
          signal: ctx.signal,
          // Ignore stdin: commands run non-interactively, so a prompt (e.g.
          // `npm create`) gets EOF and fails fast instead of hanging on a read.
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let killed = false;
        let settled = false;

        const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let timeout: ReturnType<typeof setTimeout>;
        let forceTimer: ReturnType<typeof setTimeout> | null = null;

        // Resolve exactly once and clear timers — guards against a force-resolve
        // racing a late 'close'.
        const settle = (r: { ok: boolean; output: string; error?: string; metadata?: Record<string, unknown> }): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (forceTimer) clearTimeout(forceTimer);
          resolve(r);
        };

        // SIGKILL only kills the direct child. On Windows a test runner spawns a
        // whole tree (npm → node → jest workers) that survives and keeps the
        // stdio pipes open, so 'close' never fires and we'd hang forever. Kill
        // the entire tree.
        const killTree = (): void => {
          if (IS_WINDOWS && child.pid) {
            try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* fall through */ }
          }
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        };

        // On interrupt/exit, kill the whole tree (not just the direct child that
        // the spawn `signal` handles) so a running test suite doesn't outlive us,
        // and force-resolve if its pipes linger so the loop is never stuck.
        ctx.signal?.addEventListener("abort", () => {
          killed = true;
          killTree();
          if (!forceTimer) forceTimer = setTimeout(() => settle({ ok: false, output: stdout, error: "Interrupted." + (stderr ? `\n${stderr}` : "") }), 3000);
        }, { once: true });

        const timeoutMsg = `Command timed out after ${timeoutMs}ms — it may be interactive or long-running. Re-run with non-interactive flags (e.g. --yes / -y) or pass a larger timeoutMs.`;
        timeout = setTimeout(() => {
          killed = true;
          killTree();
          // Last resort: if orphaned children still hold the pipes open and
          // 'close' never arrives, force-resolve so the agent loop is never stuck.
          forceTimer = setTimeout(() => settle({ ok: false, output: stdout, error: timeoutMsg + (stderr ? `\n${stderr}` : "") }), 3000);
        }, timeoutMs);

        child.stdout?.on("data", (buf: Buffer) => {
          stdoutBytes += buf.length;
          if (stdoutBytes <= maxOutput) stdout += buf.toString("utf8");
        });
        child.stderr?.on("data", (buf: Buffer) => {
          stderrBytes += buf.length;
          if (stderrBytes <= maxOutput) stderr += buf.toString("utf8");
        });
        child.on("error", (err) => settle({ ok: false, output: stdout, error: err.message + (stderr ? `\n${stderr}` : "") }));
        child.on("close", (code) => {
          if (killed) {
            settle({ ok: false, output: stdout, error: timeoutMsg + (stderr ? `\n${stderr}` : "") });
            return;
          }
          const ok = code === 0;
          settle({
            ok,
            output: stdout + (stderr ? `\n[stderr]\n${stderr}` : ""),
            error: ok ? undefined : `exit code ${code}`,
            metadata: { exitCode: code, stdoutBytes, stderrBytes, truncated: stdoutBytes > maxOutput || stderrBytes > maxOutput },
          });
        });
      });
    },
  };
}

import { spawn } from "node:child_process";
import { openSync, closeSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { APP_DIR } from "../utils/paths";
import { translateUnixCommand } from "./win-cmd-translate";
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

// How long a backgrounded process must stay alive before we call it "started".
// It must comfortably exceed shell cold-start. Windows security scanning and
// PowerShell profiles can delay an immediate failure by several seconds.
const STARTUP_GRACE_MS = IS_WINDOWS ? 1000 : 700;
const SHELL_READY_TIMEOUT_MS = IS_WINDOWS ? 15_000 : 5_000;

/** The shell the Bash tool executes in, for the system prompt and UX. */
export function bashShellName(): string {
  return IS_WINDOWS ? "PowerShell" : "bash/sh";
}

/** Does a command look like a long-running server/watcher (one that never exits)?
 *  Used to give the RIGHT advice when a foreground run times out — a bigger
 *  timeout won't help; runInBackground:true is the fix. */
export function looksLikeLongRunningServer(command: string): boolean {
  return /\b(vite|next(\s+dev)?|nuxt|astro\s+dev|ng\s+serve|webpack(-dev)?-server|live-server|http\.server|uvicorn|gunicorn|flask\s+run|rails\s+s(erver)?|php\s+-S|(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch))\b/i.test(command);
}

/** Rewrite the bash-isms weak models emit into PowerShell equivalents so they don't
 *  fail. Two layers: (1) translate the Unix COMMANDS they reflexively reach for
 *  (grep/head/tail/which/ls → Select-String/Get-Content/Get-Command/Get-ChildItem)
 *  so `grep foo` works instead of "not recognized"; (2) fix redirection bash-isms —
 *  the big one is `2>/dev/null`, which PowerShell reads as a FILE path (`C:\dev\null`)
 *  and errors on. Both are deterministic; valid PowerShell (`2>&1`, `2>$null`) is
 *  left alone, and command translation passes through anything it can't map faithfully. */
export function normalizeForPowerShell(command: string): string {
  return translateUnixCommand(command)
    .replace(/&>\s*\/dev\/null/g, () => "*>$null")            // bash "&>" both streams
    .replace(/(\d*)>\s*\/dev\/null/g, (_m, fd) => `${fd}>$null`) // 2>/dev/null, >/dev/null, 1>/dev/null
    .replace(/\/dev\/null/g, () => "$null");                  // any leftover literal (never a real Windows path)
}

// Prefer PowerShell 7 (pwsh) when it's installed: it supports `&&` and `||` (which
// Windows PowerShell 5.1 rejects with "not a valid statement separator") and is far
// more bash-compatible, so the model's shell commands fail much less. Detected once
// and cached; always falls back to the ever-present powershell.exe.
let _winShell: string | null = null;
export function defaultWindowsShell(): string {
  if (_winShell) return _winShell;
  // A probe that starts PowerShell can itself take several seconds under Windows
  // security scanning. Check the standard install location without launching it.
  for (const root of [process.env.ProgramW6432, process.env.ProgramFiles]) {
    if (!root) continue;
    const candidate = join(root, "PowerShell", "7", "pwsh.exe");
    if (existsSync(candidate)) return (_winShell = candidate);
  }
  return (_winShell = "powershell.exe");
}

/**
 * Build the spawn invocation for a command. On Windows we run PowerShell
 * explicitly (shell:true would use cmd.exe, which rejects PowerShell syntax) —
 * preferring pwsh 7 and translating common bash-isms; on Unix we let the default
 * shell interpret the command string.
 */
export function spawnArgs(command: string, shellPath?: string): { file: string; args: string[]; useShell: boolean } {
  if (IS_WINDOWS) {
    return { file: shellPath ?? defaultWindowsShell(), args: ["-NoProfile", "-NonInteractive", "-Command", normalizeForPowerShell(command)], useShell: false };
  }
  return { file: command, args: [], useShell: true };
}

interface RunCtx {
  cwd: string;
  signal?: AbortSignal;
}

/** Read the tail of a background log (the captured stdout/stderr), trimmed. */
function readLogTail(path: string, maxChars = 1500, omit?: string): string {
  try {
    const t = readFileSync(path, "utf8").replace(omit ?? /$^/, "").trim();
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
  // Emit a private readiness marker after the shell has initialized, then start
  // the requested command. The grace period begins at this marker, not at spawn,
  // so a slow PowerShell cold-start cannot make an immediate crash look healthy.
  const readyMarker = `__FREECODE_READY_${process.pid}_${Math.random().toString(36).slice(2)}__`;
  const wrapped = IS_WINDOWS
    ? `Write-Output '${readyMarker}'; ${args.command}`
    : `printf '%s\\n' '${readyMarker}'; ${args.command}`;
  const inv = spawnArgs(wrapped, shellPath);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(inv.file, inv.args, {
      shell: inv.useShell,
      cwd: args.cwd ?? ctx.cwd,
      env: { ...process.env, ...(args.env ?? {}) },
      stdio: ["ignore", fd, fd], // no stdin; stdout+stderr → log file
    });
  } finally {
    // spawn duplicates/inherits the descriptor; the parent must release its copy.
    try { closeSync(fd); } catch { /* already closed */ }
  }
  const pid = child.pid;
  const stopHint = IS_WINDOWS ? `taskkill /PID ${pid} /F` : `kill ${pid}`;

  return new Promise((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let readyDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: { ok: boolean; output: string; error?: string; metadata?: Record<string, unknown> }): void => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (grace) clearTimeout(grace);
      if (readyDeadline) clearTimeout(readyDeadline);
      resolve(r);
    };
    child.on("error", (err) => finish({ ok: false, output: "", error: `Failed to start background process: ${err.message}` }));
    const onEarlyExit = (code: number | null): void => {
      // The child's final writes may not be flushed to the log the instant it
      // exits, so poll briefly for output before giving up (otherwise a real
      // crash can be reported as "no output" — both a UX miss and a test flake).
      let tries = 0;
      const attempt = (): void => {
        const tail = readLogTail(logPath, 1500, readyMarker);
        if (!tail && tries < 4) { tries++; setTimeout(attempt, 90); return; }
        const why = tail ? `\n--- captured output ---\n${tail}` : " (no output was captured)";
        finish({
          ok: false,
          output: "",
          error: `The background command exited right away (exit code ${code}) instead of staying up.${why}`,
          metadata: { pid, logPath, background: true },
        });
      };
      setTimeout(attempt, 60);
    };
    child.on("exit", onEarlyExit);
    const markRunning = (): void => {
      child.unref();
      const tail = readLogTail(logPath, 600, readyMarker);
      finish({
        ok: true,
        output:
          `Started in background (pid ${pid}). Runs until you stop it or this freecode session ends.\n` +
          `Output → ${logPath}` +
          (tail ? `\n--- so far ---\n${tail}` : "  (nothing logged yet — read it with FileRead to check progress)") +
          `\nStop it with: ${stopHint}`,
        metadata: { pid, logPath, background: true },
      });
    };
    poll = setInterval(() => {
      try {
        if (readFileSync(logPath, "utf8").includes(readyMarker)) {
          clearInterval(poll);
          poll = undefined;
          grace = setTimeout(markRunning, STARTUP_GRACE_MS);
        }
      } catch { /* log may not be visible yet */ }
    }, 50);
    readyDeadline = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({
        ok: false,
        output: "",
        error: `The background shell did not become ready within ${SHELL_READY_TIMEOUT_MS}ms.`,
        metadata: { pid, logPath, background: true },
      });
    }, SHELL_READY_TIMEOUT_MS);
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
          // Remove the abort listener we added below. `{ once: true }` only fires
          // (and self-removes) on an actual abort; on the normal success path the
          // signal never aborts, so without this the listener — and the ~400KB of
          // stdout/stderr + child it closes over — stays attached to the run-long
          // signal for every Bash call, a real leak across a long agent session.
          ctx.signal?.removeEventListener("abort", onAbort);
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
        const onAbort = (): void => {
          killed = true;
          killTree();
          if (!forceTimer) forceTimer = setTimeout(() => settle({ ok: false, output: stdout, error: "Interrupted." + (stderr ? `\n${stderr}` : "") }), 3000);
        };
        ctx.signal?.addEventListener("abort", onAbort, { once: true });

        const timeoutMsg = looksLikeLongRunningServer(args.command)
          ? `Command timed out after ${timeoutMs}ms. This looks like a long-running server — it never exits, so a bigger timeoutMs won't help. Re-run the SAME command with runInBackground:true: it launches detached, returns immediately with a pid + log path, and keeps serving. Then read the log to confirm it came up. (Do NOT tell the user the server can't start — it can.)`
          : `Command timed out after ${timeoutMs}ms — it may be interactive or long-running. Re-run with non-interactive flags (e.g. --yes / -y), pass a larger timeoutMs, or use runInBackground:true for a server/watcher.`;
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

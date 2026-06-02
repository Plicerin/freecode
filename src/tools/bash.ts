import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool } from "./types";

const ArgsSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  env: z.record(z.string()).optional(),
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

export function createBashTool(opts: BashToolOptions = {}): Tool<z.infer<typeof ArgsSchema>> {
  const allow = opts.allow ?? DEFAULT_ALLOW;
  const deny = opts.deny ?? DEFAULT_DENY;
  const maxOutput = opts.maxOutputBytes ?? 200_000;

  return {
    name: "Bash",
    description: `Execute a shell command in ${bashShellName()}. Use for git, npm, scripts, system inspection. Long-running output is truncated.`,
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
      return new Promise((resolve) => {
        const inv = spawnArgs(args.command, opts.shellPath);
        const child = spawn(inv.file, inv.args, {
          shell: inv.useShell,
          cwd: args.cwd ?? ctx.cwd,
          env: { ...process.env, ...(args.env ?? {}) },
          signal: ctx.signal,
        });
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let killed = false;

        const timeout = args.timeoutMs ? setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, args.timeoutMs) : null;

        child.stdout?.on("data", (buf: Buffer) => {
          stdoutBytes += buf.length;
          if (stdoutBytes <= maxOutput) stdout += buf.toString("utf8");
        });
        child.stderr?.on("data", (buf: Buffer) => {
          stderrBytes += buf.length;
          if (stderrBytes <= maxOutput) stderr += buf.toString("utf8");
        });
        child.on("error", (err) => {
          if (timeout) clearTimeout(timeout);
          resolve({ ok: false, output: stdout, error: err.message + (stderr ? `\n${stderr}` : "") });
        });
        child.on("close", (code) => {
          if (timeout) clearTimeout(timeout);
          if (killed) {
            resolve({ ok: false, output: stdout, error: `Command timed out after ${args.timeoutMs}ms` + (stderr ? `\n${stderr}` : "") });
            return;
          }
          const ok = code === 0;
          resolve({
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

import { spawn } from "node:child_process";
import { spawnArgs } from "../tools/bash";
import { debug } from "../utils/debug";
import type { HooksConfig } from "../config/schema";
import { createDeadline } from "../utils/abort";

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop";

export interface HookOutcome {
  blocked: boolean;
  reason?: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_HOOK_OUTPUT = 64 * 1024;
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

function runOne(command: string, payload: unknown, timeoutMs: number, cwd?: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const watch = createDeadline(signal, timeoutMs);
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      watch.clear();
      resolve(watch.timedOut()
        ? { code: 1, stdout: result.stdout, stderr: `Hook timed out after ${timeoutMs}ms` }
        : result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      const inv = spawnArgs(command);
      child = spawn(inv.file, inv.args, { shell: inv.useShell, signal: watch.signal, cwd });
    } catch (e) {
      return finish({ code: 1, stdout: "", stderr: String(e) });
    }
    let stdout = "";
    let stderr = "";
    const append = (current: string, b: Buffer): string => (current + b.toString("utf8")).slice(0, MAX_HOOK_OUTPUT);
    child.stdout?.on("data", (b: Buffer) => { stdout = append(stdout, b); });
    child.stderr?.on("data", (b: Buffer) => { stderr = append(stderr, b); });
    child.on("error", (e) => finish({ code: 1, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => finish({ code: code ?? 0, stdout, stderr }));
    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch { /* ignore */ }
  });
}

/**
 * Run the hooks registered for an event, in order. For PreToolUse a non-zero
 * exit blocks the tool (the hook's stderr/stdout becomes the reason). Matchers
 * are regexes tested against the tool name.
 */
export async function runHooks(
  event: HookEvent,
  hooks: HooksConfig | undefined,
  payload: Record<string, unknown>,
  toolName?: string,
  signal?: AbortSignal,
): Promise<HookOutcome> {
  const entries = hooks?.[event] ?? [];
  for (const hook of entries) {
    if (hook.matcher && toolName !== undefined) {
      try {
        if (!new RegExp(hook.matcher).test(toolName)) continue;
      } catch {
        continue; // invalid matcher → treat as non-matching
      }
    }
    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
    const res = await runOne(hook.command, payload, hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, cwd, signal);
    debug.log(`hook ${event}`, { command: hook.command, code: res.code });
    if (event === "PreToolUse" && res.code !== 0) {
      const reason = (res.stderr || res.stdout || `hook exited ${res.code}`).trim();
      return { blocked: true, reason };
    }
  }
  return { blocked: false };
}

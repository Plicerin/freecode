import { spawn } from "node:child_process";
import { spawnArgs } from "../tools/bash";
import { debug } from "../utils/debug";
import type { HooksConfig } from "../config/schema";

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

function runOne(command: string, payload: unknown, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const inv = spawnArgs(command);
      child = spawn(inv.file, inv.args, { shell: inv.useShell, signal });
    } catch (e) {
      return resolve({ code: 1, stdout: "", stderr: String(e) });
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
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
    const res = await runOne(hook.command, payload, signal);
    debug.log(`hook ${event}`, { command: hook.command, code: res.code });
    if (event === "PreToolUse" && res.code !== 0) {
      const reason = (res.stderr || res.stdout || `hook exited ${res.code}`).trim();
      return { blocked: true, reason };
    }
  }
  return { blocked: false };
}

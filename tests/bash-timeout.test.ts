import { test, expect } from "bun:test";
import { createBashTool } from "../src/tools/bash";

const ctx = { cwd: process.cwd(), signal: undefined as unknown as AbortSignal };
const sleepCmd = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
const failCmd = process.platform === "win32"
  ? "[Console]::Error.WriteLine('boom-trace'); exit 7"
  : "printf '%s\\n' 'boom-trace' >&2; exit 7";

test("a normal command runs to completion with stdin ignored", async () => {
  const tool = createBashTool();
  const r = await tool.run({ command: "echo hello" } as never, ctx);
  expect(r.ok).toBe(true);
  expect(r.output).toMatch(/hello/);
});

test("a long/hung command is killed by the timeout instead of blocking forever", async () => {
  const tool = createBashTool();
  const t0 = Date.now();
  const r = await tool.run({ command: sleepCmd, timeoutMs: 700 } as never, ctx);
  const elapsed = Date.now() - t0;
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/timed out/i);
  expect(elapsed).toBeLessThan(5000); // killed promptly, not after 30s
});

test("runInBackground launches detached and returns a pid + log handle without blocking", async () => {
  const tool = createBashTool();
  const t0 = Date.now();
  // A process that would block far past the timeout in the foreground.
  const r = await tool.run({ command: sleepCmd, runInBackground: true } as never, ctx);
  const elapsed = Date.now() - t0;
  // It returns a real handle and returns fast — never the 30s foreground block.
  // (Whether ok is true depends on the host reaping the detached child: bun's
  // test runner kills it at once, a normal process keeps it alive. The pid +
  // log + background marker hold either way.)
  expect(typeof (r.metadata?.pid as number)).toBe("number");
  expect(r.metadata?.pid as number).toBeGreaterThan(0);
  expect(r.metadata?.background).toBe(true);
  expect(String(r.metadata?.logPath)).toMatch(/bg-bash/);
  expect(elapsed).toBeLessThan(process.platform === "win32" ? 7000 : 2000); // returned at the startup check, not after 30s
  const pid = r.metadata?.pid as number;
  if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
});

test("runInBackground reports an immediately-failing command, with its captured output", async () => {
  const tool = createBashTool();
  // Write to stderr then exit nonzero — the error must surface BOTH and not look "clean".
  const r = await tool.run({ command: failCmd, runInBackground: true } as never, ctx);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/exited right away/i);
  expect(r.error).toMatch(/boom-trace/); // the captured reason is surfaced inline
});

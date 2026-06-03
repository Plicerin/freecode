import { test, expect } from "bun:test";
import { createBashTool } from "../src/tools/bash";

const ctx = { cwd: process.cwd(), signal: undefined as unknown as AbortSignal };
const sleepCmd = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";

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

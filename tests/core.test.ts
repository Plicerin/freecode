import { describe, it, expect } from "bun:test";
import { MockProvider } from "../src/providers/mock";
import { createBashTool } from "../src/tools/bash";
import { FileReadTool } from "../src/tools/file-read";
import { FileWriteTool } from "../src/tools/file-write";
import { newSession, appendEvent, readSession } from "../src/session/manager";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import { runAgentLoop } from "../src/agent/loop";
import type { Tool } from "../src/tools/types";

describe("MockProvider", () => {
  it("streams text then ends", async () => {
    const p = new MockProvider();
    const events: string[] = [];
    for await (const e of p.stream({ model: "mock-1", messages: [{ role: "user", content: "hi" }] })) {
      if (e.type === "text_delta") events.push(e.delta);
      if (e.type === "end") events.push(`END:${e.reason}`);
    }
    expect(events.at(-1)).toMatch(/^END:/);
    expect(events.slice(0, -1).join("").length).toBeGreaterThan(0);
  });
});

describe("Bash tool denylist (V4)", () => {
  it("rejects rm -rf /", async () => {
    const t = createBashTool();
    const r = await t.run({ command: "rm -rf /" }, { cwd: process.cwd() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/denied/i);
  });
  it("rejects fork bomb", async () => {
    const t = createBashTool();
    const r = await t.run({ command: ":(){ :|:&};:" }, { cwd: process.cwd() });
    expect(r.ok).toBe(false);
  });
  it("runs a safe command", async () => {
    const t = createBashTool();
    const isWin = process.platform === "win32";
    const cmd = isWin ? "echo hello" : "echo hello";
    const r = await t.run({ command: cmd }, { cwd: process.cwd() });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/hello/);
  });
});

describe("FileRead / FileWrite", () => {
  it("round-trips a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-fs-"));
    const p = join(dir, "a.txt");
    const w = await FileWriteTool.run({ path: p, content: "abc\n" }, { cwd: dir });
    expect(w.ok).toBe(true);
    expect(existsSync(p)).toBe(true);
    const r = await FileReadTool.run({ path: p }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/abc/);
  });
});

describe("Session append-only (V6)", () => {
  it("appends events to JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-sess-"));
    const cwd = dir;
    const s = newSession(cwd);
    appendEvent(s, { kind: "user", text: "hi", ts: new Date().toISOString() });
    appendEvent(s, { kind: "assistant", text: "hello", ts: new Date().toISOString() });
    const evts = readSession(s);
    expect(evts.length).toBeGreaterThanOrEqual(3);
    expect(evts.find((e) => e.kind === "user")).toBeDefined();
    expect(evts.find((e) => e.kind === "assistant")).toBeDefined();
  });
});

describe("Permission engine (V3, V18)", () => {
  it("bypass mode allows everything without prompt", async () => {
    const eng = createPermissionEngine("bypass", (async () => "deny") as ApprovalCallback);
    const d = await eng.decide({ tool: "Bash", argsSummary: "rm -rf /" }, (async () => "deny") as ApprovalCallback);
    expect(d).toBe("allow");
  });
  it("manual mode prompts and remembers denials", async () => {
    let calls = 0;
    const eng = createPermissionEngine("manual", (async () => { calls++; return "deny"; }) as ApprovalCallback);
    const req = { tool: "Bash", argsSummary: "x" };
    expect(await eng.decide(req, (async () => "deny") as ApprovalCallback)).toBe("deny");
    eng.rememberDenied(req);
    expect(await eng.decide(req, (async () => { calls++; return "allow"; }) as ApprovalCallback)).toBe("deny");
  });
});

describe("Agent loop integration", () => {
  it("runs mock provider to end_turn", async () => {
    const tools: Tool[] = [];
    const perm = createPermissionEngine("bypass", (async () => "allow") as ApprovalCallback);
    const res = await runAgentLoop({
      provider: new MockProvider(),
      tools,
      model: "mock-1",
      maxTurns: 5,
      prompt: "ping",
      permission: perm,
      promptUser: (async () => "allow") as ApprovalCallback,
      onEvent: () => {},
    });
    expect(res.turns).toBeGreaterThanOrEqual(1);
    expect(res.usage.output).toBeGreaterThan(0);
  });
});

describe("Provider registry", () => {
  it("builds NVIDIA NIM provider via openai-compat factory", async () => {
    const { buildProvider } = await import("../src/providers/registry");
    const p = buildProvider({
      provider: "nim",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: "nvapi-test",
      model: "meta/llama-3.1-70b-instruct",
      permissionMode: "bypass",
      webSearchProvider: "duckduckgo",
      theme: "dark",
      maxTurns: 5,
      contextThreshold: 0.8,
      enablePromptCache: true,
      enableExtendedThinking: false,
      source: { provider: "cli", model: "cli", baseUrl: "cli", apiKey: "cli" },
    });
    expect(p.id).toBe("nim");
    expect(p.name).toBe("NVIDIA NIM");
  });
});

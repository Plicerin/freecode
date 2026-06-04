// CLI 101 — basic competence. Unlike the per-tool unit tests, this drives the
// REAL tool registry (and the real agent loop) through the fundamentals on
// realistic inputs — the kind of end-to-end checks that catch "green tests but
// broken in practice" bugs (e.g. FileEdit failing on every CRLF file).
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRegistry } from "../src/tools/registry";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine } from "../src/permissions/modes";

const tools = buildToolRegistry();
const tool = (name: string) => tools.find((t) => t.name === name)!;
const ctx = (cwd: string) => ({ cwd, signal: undefined as unknown as AbortSignal });
function project(): string {
  return mkdtempSync(join(tmpdir(), "fc-101-"));
}

// A provider scripted to emit a fixed sequence of tool calls / text per turn.
function scripted(turns: Array<Array<Record<string, unknown>>>): unknown {
  let i = 0;
  return {
    name: "scripted", id: "scripted", models: () => ["x"],
    async *stream() { for (const e of turns[i++] ?? []) yield e; },
  };
}
const call = (name: string, args: Record<string, unknown>) => ({ type: "tool_call", call: { id: `${name}-${Math.random()}`, name, arguments: args } });

async function runLoop(opts: { provider: unknown; cwd: string; verifyPlan?: unknown; verifyMode?: string }) {
  const events: AgentEvent[] = [];
  // The loop runs tools against process.cwd(), so point it at the temp project.
  const prev = process.cwd();
  process.chdir(opts.cwd);
  try {
    await runAgentLoop({
      provider: opts.provider as never,
      tools,
      permission: createPermissionEngine("bypass", (async () => "allow") as never),
      promptUser: (async () => "allow") as never,
      model: "x",
      history: [{ role: "user", content: "do it" }],
      onEvent: (e: AgentEvent) => events.push(e),
      verifyMode: (opts.verifyMode ?? "off") as never,
      verifyPlan: opts.verifyPlan as never,
      maxTurns: 50,
    } as never);
  } finally {
    process.chdir(prev);
  }
  return events;
}

describe("CLI 101 — file ops", () => {
  test("writes a file then reads it back", async () => {
    const dir = project();
    const w = await tool("FileWrite").run({ path: "note.txt", content: "hello world", createDirs: true } as never, ctx(dir));
    expect(w.ok).toBe(true);
    expect(existsSync(join(dir, "note.txt"))).toBe(true);
    const r = await tool("FileRead").run({ path: "note.txt" } as never, ctx(dir));
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/hello world/);
  });

  test("edits a real CRLF file (the everyday Windows case)", async () => {
    const dir = project();
    writeFileSync(join(dir, "m.js"), "export function go() {\r\n  return 1;\r\n}\r\n");
    const e = await tool("FileEdit").run({ path: "m.js", oldText: "  return 1;", newText: "  return 2;" } as never, ctx(dir));
    expect(e.ok).toBe(true);
    const after = readFileSync(join(dir, "m.js"), "utf8");
    expect(after).toContain("return 2;");
    expect(after).toContain("\r\n"); // EOL preserved
  });
});

describe("CLI 101 — search", () => {
  test("Glob finds files by pattern", async () => {
    const dir = project();
    writeFileSync(join(dir, "a.ts"), "x");
    writeFileSync(join(dir, "b.ts"), "y");
    writeFileSync(join(dir, "c.md"), "z");
    const g = await tool("Glob").run({ pattern: "**/*.ts" } as never, ctx(dir));
    expect(g.ok).toBe(true);
    expect(g.output).toMatch(/a\.ts/);
    expect(g.output).toMatch(/b\.ts/);
    expect(g.output).not.toMatch(/c\.md/);
  });

  test("Grep finds content", async () => {
    const dir = project();
    writeFileSync(join(dir, "code.js"), "const target = 42;\nconst other = 1;\n");
    const r = await tool("Grep").run({ pattern: "target" } as never, ctx(dir));
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/target/);
  });
});

describe("CLI 101 — shell", () => {
  test("runs a command and captures output", async () => {
    const r = await tool("Bash").run({ command: "echo hi-from-101" } as never, ctx(process.cwd()));
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/hi-from-101/);
  });

  test("propagates a non-zero exit as failure", async () => {
    const r = await tool("Bash").run({ command: "exit 5" } as never, ctx(process.cwd()));
    expect(r.ok).toBe(false);
  });
});

describe("CLI 101 — agent loop end-to-end", () => {
  test("read → edit a CRLF file → verify, all the way through the loop", async () => {
    const dir = project();
    writeFileSync(join(dir, "app.js"), "function add(a, b) {\r\n  return a - b;\r\n}\r\n"); // bug: minus
    const provider = scripted([
      [call("FileRead", { path: "app.js" })],
      [call("FileEdit", { path: "app.js", oldText: "function add(a, b) {\n  return a - b;\n}", newText: "function add(a, b) {\n  return a + b;\n}" })],
      [{ type: "text_delta", delta: "fixed the operator" }],
    ]);
    const events = await runLoop({ provider, cwd: dir, verifyMode: "on", verifyPlan: { source: "test", commands: ["bun --version"] } });

    // the file was actually edited on disk, EOL preserved
    const after = readFileSync(join(dir, "app.js"), "utf8");
    expect(after).toContain("return a + b;");
    expect(after).toContain("\r\n");

    // the ledger honestly reports a verified change, nothing merely believed
    const ledgers = events.filter((e) => e.type === "ledger");
    const last = ledgers[ledgers.length - 1] as { ledger?: { verified: string[]; believed: string[] } };
    expect(last?.ledger?.verified.length).toBeGreaterThan(0);
    expect(last?.ledger?.believed.length).toBe(0);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("stops flailing — circuit-breaker halts a repeated tool failure", async () => {
    const dir = project();
    writeFileSync(join(dir, "x.js"), "real content\n");
    // every turn issues the same edit whose oldText isn't in the file
    const provider = scripted(Array.from({ length: 30 }, () => [call("FileEdit", { path: "x.js", oldText: "NONEXISTENT", newText: "y" })]));
    const events = await runLoop({ provider, cwd: dir });
    const err = events.find((e) => e.type === "error") as { error?: string } | undefined;
    expect(err?.error).toMatch(/consecutive tool failures/i);
  });
});

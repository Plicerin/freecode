// CRITICAL paths — the must-work-every-time capabilities of a coding agent,
// exercised through the real tools and the real agent loop. These guard the
// class of bug that hides behind green unit tests (e.g. FileEdit silently
// failing on CRLF, or the REPL once being stateless across turns).
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRegistry } from "../src/tools/registry";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import type { ChatMessage } from "../src/providers/types";
import { createPermissionEngine } from "../src/permissions/modes";
import { z } from "zod";

const tools = buildToolRegistry();
const tool = (n: string) => tools.find((t) => t.name === n)!;
const ctx = (cwd: string) => ({ cwd, signal: undefined as unknown as AbortSignal });
const project = () => mkdtempSync(join(tmpdir(), "fc-crit-"));
const call = (name: string, args: Record<string, unknown>) => ({ type: "tool_call", call: { id: `${name}-${Math.random()}`, name, arguments: args } });
function scripted(turns: Array<Array<Record<string, unknown>>>): unknown {
  let i = 0;
  return { name: "s", id: "s", models: () => ["x"], async *stream() { for (const e of turns[i++] ?? []) yield e; } };
}
async function runLoop(provider: unknown, cwd: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    await runAgentLoop({
      provider: provider as never, tools,
      permission: createPermissionEngine("bypass", (async () => "allow") as never),
      promptUser: (async () => "allow") as never,
      model: "x", prompt: "do it", history: [], onEvent: (e: AgentEvent) => events.push(e), maxTurns: 20,
    } as never);
  } finally { process.chdir(prev); }
  return events;
}

describe("CRITICAL — memory", () => {
  test("conversation history is threaded to the provider across turns", async () => {
    let captured: ChatMessage[] = [];
    const provider = { name: "c", id: "c", models: () => ["x"], async *stream(req: { messages: ChatMessage[] }) { captured = req.messages; yield { type: "text_delta", delta: "ok" }; } };
    await runAgentLoop({
      provider: provider as never, tools,
      permission: createPermissionEngine("bypass", (async () => "allow") as never),
      promptUser: (async () => "allow") as never, model: "x",
      history: [{ role: "user", content: "my name is Zorp" }, { role: "assistant", content: "noted" }],
      prompt: "what did I say my name was?", onEvent: () => {}, maxTurns: 3,
    } as never);
    const joined = captured.map((m) => `${m.role}:${m.content}`).join("\n");
    expect(joined).toContain("my name is Zorp"); // prior turn survives
    expect(joined).toContain("what did I say my name was"); // current prompt present
  });
});

describe("CRITICAL — file mutations", () => {
  test("FileWrite creates nested directories", async () => {
    const dir = project();
    const r = await tool("FileWrite").run({ path: "a/b/c.txt", content: "hi", createDirs: true } as never, ctx(dir));
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, "a", "b", "c.txt"))).toBe(true);
  });

  test("FileEdit refuses a non-unique oldText, but replaceAll replaces every match", async () => {
    const dir = project();
    const p = join(dir, "x.txt");
    writeFileSync(p, "foo\nfoo\nfoo\n");
    const fail = await tool("FileEdit").run({ path: p, oldText: "foo", newText: "bar" } as never, ctx(dir));
    expect(fail.ok).toBe(false);
    expect(fail.error).toMatch(/unique/i);
    const ok = await tool("FileEdit").run({ path: p, oldText: "foo", newText: "bar", replaceAll: true } as never, ctx(dir));
    expect(ok.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("bar\nbar\nbar\n");
  });

  test("the loop applies multiple file changes in a single turn", async () => {
    const dir = project();
    const provider = scripted([
      [call("FileWrite", { path: "one.txt", content: "1", createDirs: true }), call("FileWrite", { path: "two.txt", content: "2", createDirs: true })],
      [{ type: "text_delta", delta: "done" }],
    ]);
    await runLoop(provider, dir);
    expect(existsSync(join(dir, "one.txt"))).toBe(true);
    expect(existsSync(join(dir, "two.txt"))).toBe(true);
  });
});

describe("CRITICAL — safety", () => {
  test("a denied tool does NOT execute (permission is a real gate, not advisory)", async () => {
    let ran = false;
    const dangerTool = {
      name: "Bash", description: "", schema: z.object({ command: z.string() }), permission: "danger" as const,
      run: async () => { ran = true; return { ok: true, output: "DID RUN" }; },
    };
    const events: AgentEvent[] = [];
    await runAgentLoop({
      provider: scripted([[call("Bash", { command: "rm -rf /" })], [{ type: "text_delta", delta: "k" }]]) as never,
      tools: [dangerTool] as never,
      permission: createPermissionEngine("manual", (async () => "deny") as never),
      promptUser: (async () => "deny") as never,
      model: "x", prompt: "wipe everything", history: [], onEvent: (e: AgentEvent) => events.push(e), maxTurns: 5,
    } as never);
    expect(ran).toBe(false); // the dangerous tool was never run
    const result = events.find((e) => e.type === "tool_result") as { result?: { output?: string } } | undefined;
    expect((result?.result?.output ?? "").toLowerCase()).toMatch(/denied/);
  });
});

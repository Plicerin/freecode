// End-to-end: when the provider returns a tool call as TEXT (no structured
// tool_calls — the Ollama/local-template failure), the agent loop recovers it and
// runs it through the normal path. Drives the REAL tool registry + real loop with
// a scripted provider, so it catches "unit passes, loop doesn't wire it" bugs.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRegistry } from "../src/tools/registry";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine } from "../src/permissions/modes";

const tools = buildToolRegistry();

function scripted(turns: Array<Array<Record<string, unknown>>>): unknown {
  let i = 0;
  return { name: "scripted", id: "scripted", models: () => ["x"], async *stream() { for (const e of turns[i++] ?? []) yield e; } };
}
const textTurn = (s: string) => [{ type: "text_delta", delta: s }];

async function runLoop(provider: unknown, cwd: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    await runAgentLoop({
      provider: provider as never,
      tools,
      permission: createPermissionEngine("bypass", (async () => "allow") as never),
      promptUser: (async () => "allow") as never,
      model: "x",
      history: [{ role: "user", content: "do it" }],
      onEvent: (e: AgentEvent) => events.push(e),
      verifyMode: "off" as never,
      maxTurns: 10,
    } as never);
  } finally {
    process.chdir(prev);
  }
  return events;
}

describe("loop recovers a text-emitted tool call and runs it", () => {
  test("a FileWrite emitted as JSON text actually writes the file (+ announced)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-rec-"));
    const provider = scripted([
      textTurn(`I'll create it now.\n{"name":"FileWrite","arguments":{"path":"out.txt","content":"recovered!"}}`),
      textTurn("Done."),
    ]);
    const events = await runLoop(provider, dir);
    expect(existsSync(join(dir, "out.txt"))).toBe(true);
    expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("recovered!");
    const announced = events.some((e) => e.type === "compacted" && /Recovered a FileWrite call/.test((e as { text?: string }).text ?? ""));
    expect(announced).toBe(true);
  });

  test("plain prose (no tool JSON) does NOT trigger a phantom call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-rec2-"));
    const events = await runLoop(scripted([textTurn("The build looks fine; nothing to change.")]), dir);
    expect(events.some((e) => e.type === "tool_result")).toBe(false);
  });
});

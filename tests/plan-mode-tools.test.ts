// In plan mode write/exec tools are filtered out; a call to one must get a clear
// "read-only" message (so the model plans instead of flailing), not the
// misleading "tool not found".
import { test, expect, describe } from "bun:test";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent } from "../src/providers/types";

class CallsBashThenStops implements Provider {
  id = "mock"; name = "x"; private n = 0;
  models() { return ["m"]; }
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.n++ === 0) {
      yield { type: "tool_call", call: { id: "c1", name: "Bash", arguments: { command: "ls" } } };
      yield { type: "end", reason: "tool_use" };
    } else {
      yield { type: "text_delta", delta: "ok" };
      yield { type: "end", reason: "end_turn" };
    }
  }
}
const perm = createPermissionEngine("bypass");
const run = async (restrictedToolNames: string[]): Promise<string[]> => {
  const events: AgentEvent[] = [];
  await runAgentLoop({
    provider: new CallsBashThenStops(), tools: [], model: "m", maxTurns: 3, prompt: "go",
    permission: perm, promptUser: (async () => "allow") as ApprovalCallback, restrictedToolNames,
    onEvent: (e) => events.push(e),
  });
  return events.filter((e) => e.type === "tool_result").map((e) => e.result?.output ?? "");
};

describe("plan-mode restricted tool", () => {
  test("a restricted tool gets a read-only message, NOT 'not found'", async () => {
    const out = await run(["Bash", "FileWrite", "FileEdit"]);
    expect(out.some((o) => /plan mode|read-only/i.test(o))).toBe(true);
    expect(out.some((o) => /not found/i.test(o))).toBe(false);
  });

  test("a genuinely unknown tool still says 'not found'", async () => {
    const out = await run([]); // nothing restricted → Bash is truly absent
    expect(out.some((o) => /not found/i.test(o))).toBe(true);
  });
});

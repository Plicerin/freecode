// A degenerating local model can collapse into a trivial junk scrap ("')") with
// no tool call. Fed back into the context it POISONS the next turn — the model
// parrots its own junk in a self-reinforcing loop that never recovers, burns
// tokens, and (as the repetitive history grows) balloons prompt-processing time.
// The loop must (a) never re-send such junk, and (b) stop + surface it, not loop.
import { test, expect, describe } from "bun:test";
import { isJunkResponse } from "../src/agent/degeneration";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent, ChatMessage } from "../src/providers/types";

describe("isJunkResponse", () => {
  test("tiny punctuation-only scraps are junk", () => {
    for (const s of ["')", ")", "'", ".", "…", "``", "()"]) expect(isJunkResponse(s)).toBe(true);
  });
  test("real short replies and empty are NOT junk", () => {
    for (const s of ["ok", "done", "yes", "42", "no.", ""]) expect(isJunkResponse(s)).toBe(false);
  });
});

// Records what the provider was asked to send, and always returns a junk "')".
class JunkSpy implements Provider {
  id = "mock"; name = "junk"; lastSent: ChatMessage[] = [];
  models() { return ["m"]; }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.lastSent = req.messages;
    yield { type: "text_delta", delta: "')" };
    yield { type: "usage", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 } };
    yield { type: "end", reason: "end_turn" };
  }
}

const perm = () => createPermissionEngine("bypass");
const base = { tools: [] as never[], model: "m", maxTurns: 5, promptUser: (async () => "allow") as ApprovalCallback };

describe("agent loop breaks the junk self-poison loop", () => {
  test("drops junk assistant scraps from the prior history before sending", async () => {
    const provider = new JunkSpy();
    const poisoned: ChatMessage[] = [
      { role: "user", content: "extract the spawn logic" },
      { role: "assistant", content: "')" }, // degenerate scraps from earlier turns
      { role: "user", content: "continue" },
      { role: "assistant", content: "')" },
    ];
    await runAgentLoop({ ...base, provider, prompt: "continue", history: poisoned, permission: perm(), onEvent: () => {} });
    // What the model actually saw must contain NONE of the "')" scraps.
    expect(provider.lastSent.some((m) => m.role === "assistant" && m.content.trim() === "')")).toBe(false);
    expect(provider.lastSent.some((m) => m.content === "extract the spawn logic")).toBe(true); // real history kept
  });

  test("a junk response stops with a clear message and is NOT kept in the returned context", async () => {
    const provider = new JunkSpy();
    const events: AgentEvent[] = [];
    const r = await runAgentLoop({ ...base, provider, prompt: "continue", history: [{ role: "user", content: "go" }, { role: "assistant", content: "did the thing" }], permission: perm(), onEvent: (e) => events.push(e) });
    expect(r.aborted).toBe(true); // stopped instead of looping
    expect(events.some((e) => e.type === "error" && /degenerated|no usable answer/i.test(e.error ?? ""))).toBe(true);
    // the "')" must not be appended to the context that gets persisted/re-sent
    expect(r.messages.some((m) => m.role === "assistant" && m.content.trim() === "')")).toBe(false);
  });
});

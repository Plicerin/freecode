// A stream that times out MID-generation (openai-compat throws when its idle
// watchdog fires after partial output) must NOT discard the turn. The partial
// assistant text + the user prompt have to survive in the returned context, or a
// follow-up "continue" has no idea what was being generated ("continue what?").
import { test, expect, describe } from "bun:test";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent } from "../src/providers/types";

class PartialThenThrow implements Provider {
  id = "mock";
  name = "pt";
  models() { return ["m"]; }
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "The key insight: each Atari playfield pixel maps to 16 screen pixels." };
    yield { type: "usage", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, thinking: 0 } };
    throw new Error('nim stream timed out — no response from "minimax-m3".');
  }
}

class EmptyThenThrow implements Provider {
  id = "mock";
  name = "et";
  models() { return ["m"]; }
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    throw new Error("connection reset before any bytes");
  }
}

const perm = () => createPermissionEngine("bypass");
const common = { tools: [] as never[], model: "m", maxTurns: 3, promptUser: (async () => "allow") as ApprovalCallback };

describe("stream timeout mid-generation", () => {
  test("keeps the partial assistant text + user prompt instead of throwing the turn away", async () => {
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({ ...common, provider: new PartialThenThrow(), prompt: "port river raid", permission: perm(), onEvent: (e) => events.push(e) });
    expect(result.aborted).toBe(true); // ended gracefully, did NOT throw
    const asst = result.messages.find((m) => m.role === "assistant");
    expect(asst?.content).toContain("16 screen pixels"); // the partial survives
    expect(result.messages.some((m) => m.role === "user" && m.content === "port river raid")).toBe(true);
    expect(events.some((e) => e.type === "error" && /timed out/.test(e.error ?? ""))).toBe(true); // still surfaced
  });

  test("an error before any output ends gracefully and injects no hollow assistant message", async () => {
    const result = await runAgentLoop({ ...common, provider: new EmptyThenThrow(), prompt: "do the thing", permission: perm(), onEvent: () => {} });
    expect(result.aborted).toBe(true);
    // the user prompt is still there (so "continue" at least sees the ask)…
    expect(result.messages.some((m) => m.role === "user" && m.content === "do the thing")).toBe(true);
    // …but no empty assistant message got pushed (would risk breaking the next request)
    expect(result.messages.some((m) => m.role === "assistant" && !m.content && !(m.toolCalls?.length))).toBe(false);
  });
});

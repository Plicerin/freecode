// Cold-load retry: freshly-loaded local models (Ollama after an idle, llama-
// server first hit) often return an empty first turn (end_turn, no content);
// the immediate retry returns real output. The loop catches this with a
// silent one-shot re-issue so the user never sees a spurious empty-response
// error. Burned once per run — any further empties are real stuck-model
// signals and surface normally.
import { test, expect, describe } from "bun:test";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine } from "../src/permissions/modes";

// Tiny scripted provider that yields a fixed sequence of events per stream
// call. Each call advances the index — so the cold-load retry draws the
// NEXT round's content.
function scriptedMulti(rounds: Array<Array<Record<string, unknown>>>): unknown & { callCount: number } {
  const provider = {
    name: "s", id: "s", models: () => ["x"],
    callCount: 0,
    async *stream() {
      const r = rounds[provider.callCount] ?? [];
      provider.callCount++;
      for (const e of r) yield e;
    },
  };
  return provider as never;
}

async function runWith(
  provider: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await runAgentLoop({
    provider: provider as never,
    tools: [],
    permission: createPermissionEngine("bypass"),
    promptUser: (async () => "allow") as never,
    model: "x",
    history: [{ role: "user", content: "do it" }],
    onEvent: (e: AgentEvent) => events.push(e),
    verifyMode: "off",
    maxTurns: 10,
    ...opts,
  } as never);
  return events;
}

describe("cold-load retry (silent one-shot on first empty turn)", () => {
  test("first turn empty → retry returns text → no empty-response error event", async () => {
    const provider = scriptedMulti([
      [{ type: "end", reason: "end_turn" }],                  // cold: empty
      [{ type: "text_delta", delta: "warm now" }, { type: "end", reason: "end_turn" }],  // retry: real
    ]);
    const events = await runWith(provider);
    // No empty-response error fired.
    const emptyErrs = events.filter((e) => e.type === "error" && /empty response/i.test(e.error ?? ""));
    expect(emptyErrs).toHaveLength(0);
    // Retry text came through.
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.text ?? "").join("");
    expect(text).toMatch(/warm now/);
    // Provider got called exactly twice (cold + one retry).
    expect(provider.callCount).toBe(2);
  });

  test("retry ALSO empty falls through to the empty-response error (no infinite retry)", async () => {
    const provider = scriptedMulti([
      [{ type: "end", reason: "end_turn" }],
      [{ type: "end", reason: "end_turn" }],  // retry also empty
    ]);
    const events = await runWith(provider);
    const emptyErrs = events.filter((e) => e.type === "error" && /empty response/i.test(e.error ?? ""));
    expect(emptyErrs).toHaveLength(1);
    // Exactly one cold + one retry = two stream calls, MAX.
    expect(provider.callCount).toBe(2);
  });

  test("pre-aborted signal → loop exits before any stream call", async () => {
    const ac = new AbortController();
    ac.abort();
    const provider = scriptedMulti([[{ type: "end", reason: "end_turn" }]]);
    const events = await runWith(provider, { signal: ac.signal });
    const emptyErrs = events.filter((e) => e.type === "error" && /empty response/i.test(e.error ?? ""));
    expect(emptyErrs).toHaveLength(0);
    expect(provider.callCount).toBe(0); // never called
  });
});

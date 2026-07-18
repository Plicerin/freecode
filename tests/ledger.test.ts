import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { runAgentLoop, type AgentEvent, type TurnLedger } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent } from "../src/providers/types";
import type { Tool } from "../src/tools/types";

function provider(toolName: string) {
  let t = 0;
  return { id: "m", name: "m", models: () => ["m"], async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    if (t++ === 0) { yield { type: "tool_call", call: { id: "c1", name: toolName, arguments: { path: "x.ts", command: "git status" } } }; yield { type: "end", reason: "tool_use" }; }
    else { yield { type: "text_delta", delta: "done" }; yield { type: "end", reason: "end_turn" }; }
  } } as Provider;
}
const perm = () => createPermissionEngine("bypass");
const allow = (async () => "allow") as ApprovalCallback;

async function ledgerFor(toolName: string, run: Tool["run"]): Promise<TurnLedger | undefined> {
  const tool: Tool = { name: toolName, description: "x", schema: z.object({ path: z.string().optional(), command: z.string().optional() }), permission: "confirm", run };
  let ledger: TurnLedger | undefined;
  await runAgentLoop({ provider: provider(toolName), tools: [tool], model: "m", maxTurns: 4, prompt: "go", permission: perm(), promptUser: allow, verifyMode: "off", onEvent: (e: AgentEvent) => { if (e.type === "ledger") ledger = e.ledger; } });
  return ledger;
}

describe("provenance ledger", () => {
  it("records an edit as Observed and flags it Believed (unverified, verify off)", async () => {
    const L = await ledgerFor("FileEdit", async () => ({ ok: true, output: "edited" }));
    expect(L?.observed.some((o) => /edited x\.ts/.test(o))).toBe(true);
    expect(L?.believed.some((b) => /unverified/.test(b))).toBe(true);
    expect(L?.verified.length).toBe(0);
  });

  it("records a Bash command as Observed, no Believed flag (no file change)", async () => {
    const L = await ledgerFor("Bash", async () => ({ ok: true, output: "ok" }));
    expect(L?.observed.some((o) => /ran .*git status/.test(o))).toBe(true);
    expect(L?.believed.length).toBe(0);
  });
});

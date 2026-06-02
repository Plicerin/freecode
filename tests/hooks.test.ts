import { describe, it, expect } from "bun:test";
import { runHooks } from "../src/agent/hooks";
import type { HooksConfig } from "../src/config/schema";

describe("hooks", () => {
  it("PreToolUse with non-zero exit blocks the tool", async () => {
    const hooks: HooksConfig = { PreToolUse: [{ command: "exit 3" }] };
    const r = await runHooks("PreToolUse", hooks, { tool: "Bash" }, "Bash");
    expect(r.blocked).toBe(true);
  }, 30000);

  it("PreToolUse with exit 0 allows", async () => {
    const hooks: HooksConfig = { PreToolUse: [{ command: "exit 0" }] };
    const r = await runHooks("PreToolUse", hooks, { tool: "Bash" }, "Bash");
    expect(r.blocked).toBe(false);
  }, 30000);

  it("matcher only fires for matching tool names", async () => {
    const hooks: HooksConfig = { PreToolUse: [{ matcher: "Bash", command: "exit 1" }] };
    // FileRead doesn't match -> not blocked
    expect((await runHooks("PreToolUse", hooks, {}, "FileRead")).blocked).toBe(false);
    // Bash matches -> blocked
    expect((await runHooks("PreToolUse", hooks, {}, "Bash")).blocked).toBe(true);
  }, 30000);

  it("PostToolUse never blocks even on non-zero exit", async () => {
    const hooks: HooksConfig = { PostToolUse: [{ command: "exit 5" }] };
    expect((await runHooks("PostToolUse", hooks, {}, "Bash")).blocked).toBe(false);
  }, 30000);
});

import { runAgentLoop } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import { z } from "zod";
import type { Provider, ChatRequest, StreamEvent } from "../src/providers/types";
import type { Tool } from "../src/tools/types";

describe("hooks in the agent loop", () => {
  it("a vetoing PreToolUse hook prevents the tool from running", async () => {
    let turn = 0;
    const provider: Provider = {
      id: "mock", name: "x", models: () => ["m"],
      async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
        if (turn++ === 0) {
          yield { type: "tool_call", call: { id: "c1", name: "Noop", arguments: {} } };
          yield { type: "end", reason: "tool_use" };
        } else {
          yield { type: "text_delta", delta: "done" };
          yield { type: "end", reason: "end_turn" };
        }
      },
    };
    let ran = false;
    const noop: Tool = { name: "Noop", description: "x", schema: z.object({}), permission: "safe", async run() { ran = true; return { ok: true, output: "ran" }; } };
    const events: any[] = [];
    await runAgentLoop({
      provider, tools: [noop], model: "m", maxTurns: 3, prompt: "go",
      permission: createPermissionEngine("bypass", (async () => "allow") as ApprovalCallback),
      promptUser: (async () => "allow") as ApprovalCallback,
      hooks: { PreToolUse: [{ command: "exit 1" }] },
      onEvent: (e) => events.push(e),
    });
    expect(ran).toBe(false);
    expect(events.find((e) => e.type === "tool_result")?.result.output).toMatch(/Blocked by PreToolUse/);
  }, 30000);
});

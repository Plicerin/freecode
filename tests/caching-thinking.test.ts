import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { buildAnthropicBody } from "../src/providers/anthropic";
import type { ChatRequest, ToolDefinition } from "../src/providers/types";

const tools: ToolDefinition[] = [{ name: "Bash", description: "run", schema: z.object({ command: z.string() }) }];
const base: ChatRequest = {
  model: "claude-sonnet-4-5",
  system: "You are freecode.",
  messages: [{ role: "user", content: "hi" }],
  tools,
};

describe("Anthropic prompt caching", () => {
  it("adds cache_control to system, tools, and the last message when enabled", () => {
    const body = buildAnthropicBody({ ...base, enablePromptCache: true }) as any;
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    const lastMsg = body.messages.at(-1);
    expect(lastMsg.content.at(-1).cache_control).toEqual({ type: "ephemeral" });
  });

  it("omits cache_control when disabled", () => {
    const body = buildAnthropicBody({ ...base, enablePromptCache: false }) as any;
    expect(typeof body.system).toBe("string");
    expect(body.tools.at(-1).cache_control).toBeUndefined();
  });
});

describe("Anthropic extended thinking", () => {
  it("adds a thinking block and bumps max_tokens when enabled", () => {
    const body = buildAnthropicBody({ ...base, enableExtendedThinking: true }) as any;
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    expect(body.max_tokens).toBeGreaterThan(8000);
  });

  it("no thinking block by default", () => {
    const body = buildAnthropicBody(base) as any;
    expect(body.thinking).toBeUndefined();
  });
});

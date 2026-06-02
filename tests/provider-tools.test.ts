import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { zodToJsonSchema } from "../src/providers/schema-util";
import { toAnthropicMessages, toAnthropicTools } from "../src/providers/anthropic";
import { toGeminiContents, toGeminiTools } from "../src/providers/gemini";
import type { ChatMessage, ToolDefinition } from "../src/providers/types";

const schema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  level: z.enum(["a", "b"]),
});
const tools: ToolDefinition[] = [{ name: "Bash", description: "run", schema }];

const convo: ChatMessage[] = [
  { role: "user", content: "list files" },
  { role: "assistant", content: "sure", toolCalls: [{ id: "c1", name: "Glob", arguments: { pattern: "*" } }] },
  { role: "tool", toolCallId: "c1", content: "a.ts" },
  { role: "tool", toolCallId: "c1b", content: "b.ts" }, // second result coalesces into same message
];

describe("zodToJsonSchema", () => {
  it("produces a JSON Schema object with required derived from non-optional fields", () => {
    const s = zodToJsonSchema(schema);
    expect(s.type).toBe("object");
    expect((s.properties as Record<string, { type?: string }>).command?.type).toBe("string");
    expect(s.required).toEqual(["command", "level"]); // cwd is optional
    expect(s.additionalProperties).toBe(false);
  });
});

describe("Anthropic serialization", () => {
  it("maps tools to input_schema", () => {
    const t = toAnthropicTools(tools);
    expect(t[0]!.name).toBe("Bash");
    expect((t[0]!.input_schema as { type?: string }).type).toBe("object");
  });

  it("serializes tool_use + tool_result blocks and coalesces consecutive roles", () => {
    const msgs = toAnthropicMessages(convo);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1]!.content.some((b) => b.type === "tool_use" && b.name === "Glob")).toBe(true);
    const results = msgs[2]!.content.filter((b) => b.type === "tool_result");
    expect(results.length).toBe(2);
    expect(results[0]!.tool_use_id).toBe("c1");
  });

  it("folds a mid-stream system message (compaction summary) into user text", () => {
    const msgs = toAnthropicMessages([{ role: "system", content: "summary" }, { role: "user", content: "hi" }]);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content[0]).toEqual({ type: "text", text: "summary" });
  });
});

describe("Gemini serialization", () => {
  it("wraps functionDeclarations and strips additionalProperties", () => {
    const t = toGeminiTools(tools) as Array<{ functionDeclarations: Array<{ name: string; parameters: Record<string, unknown> }> }>;
    const decl = t[0]!.functionDeclarations[0]!;
    expect(decl.name).toBe("Bash");
    expect(decl.parameters.type).toBe("object");
    expect(decl.parameters.additionalProperties).toBeUndefined();
  });

  it("serializes functionCall + functionResponse parts and coalesces", () => {
    const contents = toGeminiContents(convo);
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[1]!.parts.some((p) => p.functionCall?.name === "Glob")).toBe(true);
    expect(contents[2]!.parts.filter((p) => p.functionResponse).length).toBe(2);
  });
});

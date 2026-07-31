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

  it("carries string min/max as minLength/maxLength (so an empty required string is invalid up front)", () => {
    const s = zodToJsonSchema(z.object({ pattern: z.string().min(1).max(200).describe("the regex") }));
    const p = (s.properties as Record<string, Record<string, unknown>>).pattern!;
    expect(p.type).toBe("string");
    expect(p.minLength).toBe(1);
    expect(p.maxLength).toBe(200);
    expect(p.description).toBe("the regex");
  });

  it("carries number int/positive/range as integer + (exclusive)minimum/maximum", () => {
    const s = zodToJsonSchema(z.object({
      count: z.number().int().positive().max(5000).optional(),
      offset: z.number().int().min(0).max(50).optional(),
    }));
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.count).toEqual({ type: "integer", exclusiveMinimum: 0, maximum: 5000 });
    expect(props.offset).toEqual({ type: "integer", minimum: 0, maximum: 50 });
  });

  it("unwraps a .refine()-wrapped object so its fields are advertised (the FileEdit bug)", () => {
    const refined = z.object({ path: z.string().min(1), body: z.string() })
      .refine((a) => !!a.path, { message: "need path" })
      .refine((a) => !!a.body, { message: "need body" });
    const s = zodToJsonSchema(refined);
    expect(Object.keys(s.properties as object)).toEqual(["path", "body"]); // not {}
    expect((s.properties as Record<string, Record<string, unknown>>).path!.minLength).toBe(1);
    expect(s.required).toEqual(["path", "body"]);
  });

  it("preserves a description attached AFTER .optional()/.default(); .default() is not required", () => {
    const s = zodToJsonSchema(z.object({
      a: z.string().optional().describe("desc after optional"),
      n: z.number().int().default(50).describe("cap"),
    }));
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.a!.description).toBe("desc after optional");
    expect(props.n).toEqual({ type: "integer", description: "cap" }); // unwrapped, not {type:"string"}
    expect(s.required).toBeUndefined(); // both optional/defaulted → nothing required
  });

  it("emits required + additionalProperties for nested objects, minItems for arrays, format for strings", () => {
    const s = zodToJsonSchema(z.object({
      loc: z.object({ path: z.string().min(1), line: z.number() }),
      tasks: z.array(z.string().min(1)).min(1),
      url: z.string().url(),
    }));
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.loc).toEqual({
      type: "object",
      properties: { path: { type: "string", minLength: 1 }, line: { type: "number" } },
      required: ["path", "line"],
      additionalProperties: false,
    });
    expect(props.tasks).toEqual({ type: "array", items: { type: "string", minLength: 1 }, minItems: 1 });
    expect(props.url).toEqual({ type: "string", format: "uri" });
  });

  it("keeps a .nullable() field required and represents a literal as an enum", () => {
    const s = zodToJsonSchema(z.object({ x: z.number().nullable(), mode: z.literal("strict") }));
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.x).toEqual({ type: "number", nullable: true });
    expect(props.mode).toEqual({ type: "string", enum: ["strict"] });
    expect(s.required).toEqual(["x", "mode"]); // nullable ≠ optional
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

  it("remaps exclusiveMinimum/Maximum (unsupported by Gemini) to inclusive bounds", () => {
    const s: ToolDefinition[] = [{ name: "X", description: "x", schema: z.object({ n: z.number().int().positive().max(20) }) }];
    const t = toGeminiTools(s) as Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }>;
    const n = (t[0]!.functionDeclarations[0]!.parameters.properties as Record<string, Record<string, unknown>>).n!;
    expect(n.exclusiveMinimum).toBeUndefined(); // Gemini would 400 on this keyword
    expect(n.exclusiveMaximum).toBeUndefined();
    expect(n.minimum).toBe(0);   // approximated from exclusiveMinimum
    expect(n.maximum).toBe(20);
  });

  it("serializes functionCall + functionResponse parts and coalesces", () => {
    const contents = toGeminiContents(convo);
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[1]!.parts.some((p) => p.functionCall?.name === "Glob")).toBe(true);
    expect(contents[2]!.parts.filter((p) => p.functionResponse).length).toBe(2);
  });

  it("uses the function name, not an OpenAI call id, after a provider switch", () => {
    const contents = toGeminiContents([
      { role: "assistant", content: "", toolCalls: [{ id: "call_123", name: "FileRead", arguments: { path: "x" } }] },
      { role: "tool", content: "ok", toolCallId: "call_123", name: "FileRead" },
    ]);
    const response = contents[1]!.parts.find((p) => p.functionResponse)!.functionResponse as { name: string };
    expect(response.name).toBe("FileRead");
  });
});

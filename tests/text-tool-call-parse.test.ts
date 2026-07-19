// The root fix for local models (Qwen via llama-server, LM Studio, Ollama) that
// emit tool calls as TEXT markup instead of structured tool_calls: parse them into
// real calls and strip the markup — including the stray closing tags a half-parsing
// server leaks (the reported </parameter></function></tool_call> residue).
import { test, expect, describe } from "bun:test";
import { parseTextToolCalls, filterTextToolCalls, shouldParseTextToolCalls } from "../src/agent/text-tool-call";
import type { StreamEvent, ToolCall } from "../src/providers/types";

const KNOWN = new Set(["Glob", "Bash", "Read", "Edit"]);

describe("parseTextToolCalls (whole-blob)", () => {
  test("Qwen block → structured call, markup removed", () => {
    const { calls, cleaned } = parseTextToolCalls(
      `<tool_call>\n<function=Glob>\n<parameter=pattern>**/*.js</parameter>\n</function>\n</tool_call>`,
      KNOWN,
    );
    expect(calls).toEqual([{ name: "Glob", arguments: { pattern: "**/*.js" } }]);
    expect(cleaned.trim()).toBe("");
  });

  test("coerces typed params, keeps strings", () => {
    const { calls } = parseTextToolCalls(
      `<tool_call><function=Bash><parameter=command>ls -la</parameter><parameter=runInBackground>true</parameter><parameter=timeout>500</parameter></function></tool_call>`,
      KNOWN,
    );
    expect(calls[0]!.arguments).toEqual({ command: "ls -la", runInBackground: true, timeout: 500 });
  });

  test("Hermes/JSON tool_call form", () => {
    const { calls } = parseTextToolCalls(`<tool_call>{"name":"Read","arguments":{"file":"a.ts"}}</tool_call>`, KNOWN);
    expect(calls).toEqual([{ name: "Read", arguments: { file: "a.ts" } }]);
  });

  test("Anthropic <function_calls>/<invoke> form", () => {
    const { calls, cleaned } = parseTextToolCalls(
      `<function_calls><invoke name="Bash"><parameter name="command">echo hi</parameter></invoke></function_calls>`,
      KNOWN,
    );
    expect(calls).toEqual([{ name: "Bash", arguments: { command: "echo hi" } }]);
    expect(cleaned.trim()).toBe("");
  });

  test("stray closing tags only (the reported residue) → no calls, tags stripped", () => {
    const { calls, cleaned } = parseTextToolCalls(
      `Let me rewrite moveEntity.\n</parameter>\n</parameter>\n</function>\n</tool_call>`,
      KNOWN,
    );
    expect(calls).toEqual([]);
    expect(cleaned).toBe("Let me rewrite moveEntity.");
  });

  test("unknown tool name is NOT converted (left as text)", () => {
    const src = `<tool_call><function=NotARealTool><parameter=x>1</parameter></function></tool_call>`;
    const { calls, cleaned } = parseTextToolCalls(src, KNOWN);
    expect(calls).toEqual([]);
    expect(cleaned).toBe(src);
  });

  test("prose/code with a bare < is untouched", () => {
    for (const s of ["if (a < b) return;", "5 < 10 and 10 > 5", "const x = <T>() => {};"]) {
      const { calls, cleaned } = parseTextToolCalls(s, KNOWN);
      expect(calls).toEqual([]);
      expect(cleaned).toBe(s);
    }
  });

  test("prose before a real block is preserved", () => {
    const { calls, cleaned } = parseTextToolCalls(
      `I'll list the files.\n<tool_call><function=Glob><parameter=pattern>*.ts</parameter></function></tool_call>`,
      KNOWN,
    );
    expect(calls).toEqual([{ name: "Glob", arguments: { pattern: "*.ts" } }]);
    expect(cleaned.trim()).toBe("I'll list the files.");
  });
});

// Drive the streaming filter: feed chunks (optionally with injected non-text
// events), collect the resulting text and calls.
async function runStream(
  chunks: string[],
  known?: Set<string>,
  lead: StreamEvent[] = [],
): Promise<{ text: string; calls: ToolCall[] }> {
  async function* src(): AsyncIterable<StreamEvent> {
    for (const e of lead) yield e;
    for (const c of chunks) yield { type: "text_delta", delta: c };
    yield { type: "end", reason: "end_turn" };
  }
  const text: string[] = [];
  const calls: ToolCall[] = [];
  for await (const e of filterTextToolCalls(src(), known)) {
    if (e.type === "text_delta") text.push(e.delta);
    else if (e.type === "tool_call") calls.push(e.call);
  }
  return { text: text.join(""), calls };
}

function splitEveryChar(s: string): string[] {
  return [...s];
}

describe("filterTextToolCalls (streaming)", () => {
  const QWEN = `<tool_call>\n<function=Glob>\n<parameter=pattern>**/*.js</parameter>\n</function>\n</tool_call>`;

  test("whole block in one delta → one call, no leaked text", async () => {
    const { text, calls } = await runStream([QWEN], KNOWN);
    expect(calls).toEqual([{ id: expect.any(String), name: "Glob", arguments: { pattern: "**/*.js" } }]);
    expect(text.trim()).toBe("");
  });

  test("block split across single-char deltas → still one call, no markup leaks", async () => {
    const { text, calls } = await runStream(splitEveryChar(QWEN), KNOWN);
    expect(calls.map((c) => ({ name: c.name, arguments: c.arguments }))).toEqual([
      { name: "Glob", arguments: { pattern: "**/*.js" } },
    ]);
    expect(text).not.toContain("<tool_call>");
    expect(text).not.toContain("</function>");
    expect(text.trim()).toBe("");
  });

  test("stray closing tags split across deltas are stripped", async () => {
    const chunks = splitEveryChar("Rewriting now.\n</parameter>\n</function>\n</tool_call>");
    const { text, calls } = await runStream(chunks, KNOWN);
    expect(calls).toEqual([]);
    expect(text).not.toMatch(/<\/(function|tool_call|parameter)>/);
    expect(text.trim()).toBe("Rewriting now.");
  });

  test("normal prose (incl. a lone <) passes through intact", async () => {
    const prose = "Comparing a < b, then b > c. Done.";
    const { text, calls } = await runStream(splitEveryChar(prose), KNOWN);
    expect(calls).toEqual([]);
    expect(text).toBe(prose);
  });

  test("dedup: a structured call + a leaked twin block runs once", async () => {
    const structured: StreamEvent = { type: "tool_call", call: { id: "s1", name: "Glob", arguments: { pattern: "**/*.js" } } };
    const { calls } = await runStream([QWEN], KNOWN, [structured]);
    expect(calls).toHaveLength(1);
  });

  test("prose then block then more prose, all split", async () => {
    const full = `First I check.\n${QWEN}\nNow the result is in.`;
    const { text, calls } = await runStream(splitEveryChar(full), KNOWN);
    expect(calls).toHaveLength(1);
    expect(text).toContain("First I check.");
    expect(text).toContain("Now the result is in.");
    expect(text).not.toContain("tool_call");
  });
});

describe("shouldParseTextToolCalls (gating)", () => {
  test("ON for local/aggregator providers", () => {
    for (const id of ["llama-server", "ollama", "lmstudio", "openrouter", "nim"]) {
      expect(shouldParseTextToolCalls(id)).toBe(true);
    }
  });
  test("OFF for native-structured-tool providers", () => {
    for (const id of ["anthropic", "openai", "gemini", "bedrock", "vertex"]) {
      expect(shouldParseTextToolCalls(id)).toBe(false);
    }
  });
  test("env override wins both ways", () => {
    expect(shouldParseTextToolCalls("anthropic", "1")).toBe(true);
    expect(shouldParseTextToolCalls("llama-server", "0")).toBe(false);
  });
});

import type { ChatMessage, ChatRequest, Provider, StreamEvent, TokenUsage, ToolDefinition } from "./types";
import { friendlyError, makeError } from "./friendly-errors";
import { zodToJsonSchema } from "./schema-util";
import { debug } from "../utils/debug";

interface GeminiPart { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: unknown }
interface GeminiContent { role: "user" | "model"; parts: GeminiPart[] }

/** Gemini rejects JSON-Schema keywords like additionalProperties/$schema; strip them. */
function stripUnsupported(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const walk = (o: unknown): void => {
    if (o && typeof o === "object") {
      const rec = o as Record<string, unknown>;
      delete rec.additionalProperties;
      delete rec.$schema;
      for (const k of Object.keys(rec)) walk(rec[k]);
    }
  };
  walk(clone);
  return clone;
}

/** Gemini wraps tools in a single functionDeclarations array. */
export function toGeminiTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: stripUnsupported(t.parameters ?? zodToJsonSchema(t.schema)),
    })),
  }];
}

/**
 * Convert freecode messages into Gemini `contents`: assistant tool calls become
 * functionCall parts, tool results become functionResponse parts (matched by
 * name), and consecutive same-role messages are merged. Mid-stream system
 * messages (compaction summary) fold in as user text.
 */
export function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    let role: "user" | "model";
    const parts: GeminiPart[] = [];
    if (m.role === "tool") {
      role = "user";
      parts.push({ functionResponse: { name: m.toolCallId ?? "tool", response: { result: m.content } } });
    } else if (m.role === "assistant") {
      role = "model";
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
    } else {
      role = "user";
      if (m.content) parts.push({ text: m.content });
    }
    if (parts.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  }
  return out;
}

interface GeminiOptions {
  apiKey?: string;
  baseUrl?: string;
}

const DEFAULT_BASE = "https://generativelanguage.googleapis.com";

export class GeminiProvider implements Provider {
  readonly id = "gemini";
  readonly name = "Google Gemini";
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor(opts: GeminiOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  }

  models() {
    return ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"];
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.apiKey) {
      yield { type: "error", error: makeError("gemini", "GEMINI_API_KEY not set", "missing_api_key") };
      return;
    }
    const url = `${this.baseUrl}/v1beta/models/${req.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const body: Record<string, unknown> = {
      contents: toGeminiContents(req.messages),
      generationConfig: { maxOutputTokens: req.maxTokens ?? 8192 },
    };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.tools && req.tools.length > 0) body.tools = toGeminiTools(req.tools);
    debug.log("gemini request", { url, model: req.model });
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      throw friendlyError(err, "gemini");
    }
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      throw friendlyError(new Error(`${resp.status} ${text}`), "gemini");
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalInput = 0;
    let totalOutput = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const obj = JSON.parse(data);
          const cand = obj.candidates?.[0];
          for (const part of (cand?.content?.parts ?? []) as GeminiPart[]) {
            if (part.text) {
              yield { type: "text_delta", delta: part.text };
            } else if (part.functionCall) {
              const fc = part.functionCall;
              // Gemini gives no call id; use the function name (matched by name on return).
              yield { type: "tool_call", call: { id: fc.name, name: fc.name, arguments: fc.args ?? {} } };
            }
          }
          if (obj.usageMetadata) {
            totalInput = obj.usageMetadata.promptTokenCount ?? totalInput;
            totalOutput = obj.usageMetadata.candidatesTokenCount ?? totalOutput;
          }
        } catch {
          // skip malformed
        }
      }
    }
    const usage: TokenUsage = { input: totalInput, output: totalOutput, cacheRead: 0, cacheWrite: 0, thinking: 0 };
    yield { type: "usage", usage };
    yield { type: "end", reason: "end_turn" };
  }
}

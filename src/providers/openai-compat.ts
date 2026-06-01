import type { ChatMessage, ChatRequest, Provider, StreamEvent, TokenUsage } from "./types";
import { friendlyError, makeError } from "./friendly-errors";
import { debug } from "../utils/debug";

interface OpenAICompatOptions {
  apiKey?: string;
  baseUrl: string;
  providerName: string;
  authHeader?: "bearer" | "github" | "lmstudio" | "none";
  defaultModel: string;
  supportsTools?: boolean;
  supportsThinking?: boolean;
}

const DEFAULT_OPTIONS: Omit<OpenAICompatOptions, "baseUrl" | "providerName" | "defaultModel"> = {
  authHeader: "bearer",
  supportsTools: true,
  supportsThinking: false,
};

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
  };
}

export class OpenAICompatProvider implements Provider {
  readonly id: string;
  readonly name: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly opts: OpenAICompatOptions;

  constructor(id: string, name: string, opts: OpenAICompatOptions) {
    this.id = id;
    this.name = name;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  models() {
    return [this.opts.defaultModel];
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const url = `${this.baseUrl}/chat/completions`;
    const auth = this.opts.authHeader ?? "bearer";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth === "bearer" && this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    else if (auth === "github" && this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    else if (auth === "lmstudio") {
      // LM Studio often needs no key but accepts anything
      if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    } else if (auth !== "none" && !this.apiKey) {
      yield { type: "error", error: makeError(this.id, "API key not set", "missing_api_key") };
      return;
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        ...req.messages.map(toOpenAIMessage),
      ],
      stream: true,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.7,
    };
    if (req.tools && req.tools.length > 0 && this.opts.supportsTools) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: zodToJsonShape(t.schema) },
      }));
    }
    debug.log("openai-compat request", { url, model: req.model, provider: this.id });
    let resp: Response;
    try {
      resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal });
    } catch (err) {
      throw friendlyError(err, this.id);
    }
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      throw friendlyError(new Error(`${resp.status} ${text}`), this.id);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          for (const [idx, tc] of toolAcc) {
            if (tc.id && tc.name) {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(tc.args || "{}");
              } catch {
                args = {};
              }
              yield { type: "tool_call", call: { id: tc.id, name: tc.name, arguments: args } };
              toolAcc.delete(idx);
            }
          }
          yield { type: "end", reason: "end_turn" };
          return;
        }
        if (!data) continue;
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          yield { type: "text_delta", delta: choice.delta.content };
        }
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const acc = toolAcc.get(tc.index) ?? { args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolAcc.set(tc.index, acc);
          }
        }
        if (choice?.finish_reason) {
          // handled by [DONE] or end of stream
        }
        if (chunk.usage) {
          const usage: TokenUsage = {
            input: chunk.usage.prompt_tokens ?? 0,
            output: chunk.usage.completion_tokens ?? 0,
            cacheRead: chunk.usage.cached_tokens ?? 0,
            cacheWrite: 0,
            thinking: 0,
          };
          yield { type: "usage", usage };
        }
      }
    }
    yield { type: "end", reason: "end_turn" };
  }
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function zodToJsonShape(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && "_def" in (schema as object)) {
    const def = (schema as { _def?: { shape?: () => Record<string, unknown> } })._def;
    if (def && typeof def.shape === "function") {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const shape = def.shape();
      for (const [k, v] of Object.entries(shape)) {
        const field = v as ZodLike;
        properties[k] = describeZod(field);
        if (field._def?.typeName !== "ZodOptional") required.push(k);
      }
      return {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      };
    }
  }
  return { type: "object", properties: {} };
}

interface ZodLike {
  _def?: { typeName?: string; innerType?: ZodLike; valueType?: ZodLike; values?: unknown[]; description?: string; shape?: () => Record<string, unknown> };
  description?: string;
}

function describeZod(z: ZodLike): Record<string, unknown> {
  const def = z._def;
  if (!def) return { type: "string" };
  switch (def.typeName) {
    case "ZodString": return { type: "string", description: z.description };
    case "ZodNumber": return { type: "number", description: z.description };
    case "ZodBoolean": return { type: "boolean", description: z.description };
    case "ZodArray": return { type: "array", items: describeZod(def.innerType ?? {}) };
    case "ZodObject": {
      if (typeof def.shape === "function") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(def.shape())) {
          out[k] = describeZod(v as ZodLike);
        }
        return { type: "object", properties: out };
      }
      return { type: "object" };
    }
    case "ZodEnum": return { type: "string", enum: def.values ?? [] };
    case "ZodRecord": return { type: "object", additionalProperties: describeZod(def.valueType ?? {}) };
    case "ZodOptional": return describeZod(def.innerType ?? {});
    default: return { type: "string" };
  }
}

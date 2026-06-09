import type { ChatMessage, ChatRequest, Provider, StreamEvent, TokenUsage } from "./types";
import { friendlyError, makeError } from "./friendly-errors";
import { zodToJsonSchema } from "./schema-util";
import { debug } from "../utils/debug";
import { getEnv } from "../utils/env";
import { createStallTimeout, streamIdleMs, streamFirstByteMs } from "./stall-timeout";

// Open reasoning models (gpt-oss, deepseek-r1, qwq, "reasoner"s) accept a
// reasoning_effort. Setting it MAY help multi-step work, but it can also backfire
// on some endpoints — a server can reject the param (400), or high effort can
// burn the output-token budget before any tool call is emitted. It's unverified
// against live endpoints, so it's OPT-IN: default sends nothing (prior behavior),
// and FREECODE_REASONING_EFFORT=low|medium|high turns it on for reasoning models.
function reasoningEffortFor(model: string): "low" | "medium" | "high" | undefined {
  if (!/gpt-oss|deepseek-r1|\bqwq\b|reasoner/i.test(model)) return undefined;
  const env = (getEnv("FREECODE_REASONING_EFFORT") || "").toLowerCase();
  if (env === "low" || env === "medium" || env === "high") return env;
  return undefined; // opt-in only
}

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
      // Reasoning models expose chain-of-thought separately from the answer.
      // NIM/vLLM use `reasoning_content`; some servers use `reasoning`.
      reasoning_content?: string | null;
      reasoning?: string | null;
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

  async models(): Promise<string[]> {
    const fallback = this.opts.defaultModel ? [this.opts.defaultModel] : [];
    try {
      const headers: Record<string, string> = {};
      const auth = this.opts.authHeader ?? "bearer";
      if (auth !== "none" && this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
      const resp = await fetch(`${this.baseUrl}/models`, { headers, signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return fallback;
      const json = (await resp.json()) as { data?: Array<{ id?: string }> };
      const ids = (json.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
      return ids.length ? ids.sort() : fallback;
    } catch {
      return fallback; // offline / no key / endpoint unsupported → known default
    }
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
      // Without this, OpenAI (and most compatible APIs) omit token usage from a
      // streamed response, so cost can never be computed. Asking for it sends a
      // final usage-only chunk.
      stream_options: { include_usage: true },
    };
    const maxTokens = req.maxTokens ?? 4096;
    if (usesMaxCompletionTokens(req.model)) {
      // GPT-5 family and o-series reasoning models renamed the cap to
      // max_completion_tokens and only accept the default temperature.
      body.max_completion_tokens = maxTokens;
      // These models reason natively. reasoning_effort + function tools is
      // rejected on /v1/chat/completions, so only set it when no tools are sent.
      const hasTools = !!(req.tools && req.tools.length > 0 && this.opts.supportsTools);
      if (req.enableExtendedThinking && !hasTools) body.reasoning_effort = "high";
    } else {
      body.max_tokens = maxTokens;
      // Reasoning models (gpt-oss et al.) are tuned for temperature ~1.0; the
      // generic chat default is 0.7.
      body.temperature = req.temperature ?? (reasoningEffortFor(req.model) ? 1 : 0.7);
    }
    // Tell a reasoning model HOW hard to think — without this it runs at the
    // server default, which is often too low for agentic, multi-step work.
    const effort = reasoningEffortFor(req.model);
    if (effort) body.reasoning_effort = effort;
    // Note: OpenAI prompt caching is automatic (no markers); cached_tokens are
    // already read from usage. Anthropic needs explicit cache_control markers.
    if (req.tools && req.tools.length > 0 && this.opts.supportsTools) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters ?? zodToJsonSchema(t.schema) },
      }));
    }
    debug.log("openai-compat request", { url, model: req.model, provider: this.id });
    // Idle watchdog: abort if the stream goes silent. A SHORT first-byte ceiling
    // catches a request the endpoint accepts but never streams (a 2-minute hang
    // otherwise); a generous idle ceiling covers long mid-stream gaps.
    const idleMs = streamIdleMs();
    const firstByteMs = streamFirstByteMs();
    const watchdog = createStallTimeout(req.signal, idleMs, firstByteMs);
    const timeoutError = (): Error =>
      makeError(this.id, `${this.opts.providerName} stream timed out — no response from "${req.model}". Common causes: a hit rate/daily usage limit, the backend is stalled or at capacity, or the model isn't served on ${this.baseUrl}. (Over-quota requests often hang silently rather than returning an error.)`, "timeout", true);
    let resp: Response;
    try {
      resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: watchdog.signal });
    } catch (err) {
      watchdog.clear();
      throw watchdog.timedOut() ? timeoutError() : friendlyError(err, this.id);
    }
    if (!resp.ok || !resp.body) {
      watchdog.clear();
      const text = await resp.text().catch(() => "");
      const err = new Error(`${resp.status} ${text}`) as Error & { status?: number };
      err.status = resp.status;
      throw friendlyError(err, this.id);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finishReason: string | undefined;
    const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();
    const endReason = (): "end_turn" | "max_tokens" | "tool_use" =>
      finishReason === "length" ? "max_tokens" : finishReason === "tool_calls" ? "tool_use" : "end_turn";

    try {
    while (true) {
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ value, done } = await reader.read());
      } catch (err) {
        throw watchdog.timedOut() ? timeoutError() : friendlyError(err, this.id);
      }
      watchdog.reset(); // got bytes (or clean EOF) — restart the idle clock
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
          yield { type: "end", reason: endReason() };
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
        // Reasoning channel (gpt-oss et al.) — surfaced as thinking, kept out of
        // the answer text. Previously dropped entirely, so a reasoning model's
        // work was invisible.
        const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
        if (reasoning) {
          yield { type: "thinking_delta", delta: reasoning };
        }
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
          // Remember WHY generation stopped — "length" means the reply was cut
          // off at the token cap (a truncated tool call then parses to nothing,
          // and the turn looks "done" when it wasn't).
          finishReason = choice.finish_reason;
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
    } finally {
      watchdog.clear();
    }
    yield { type: "end", reason: endReason() };
  }
}

/**
 * GPT-5 family and o-series reasoning models (o1/o3/o4...) use
 * `max_completion_tokens` instead of `max_tokens` and reject a custom
 * temperature. Match on the model name so it works on any OpenAI-style endpoint.
 */
function usesMaxCompletionTokens(model: string): boolean {
  return /gpt-5/i.test(model) || /^o[1-9]/i.test(model);
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
  if (m.role === "user" && m.images && m.images.length > 0) {
    const parts: Array<Record<string, unknown>> = [];
    if (m.content) parts.push({ type: "text", text: m.content });
    for (const img of m.images) {
      parts.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
    }
    return { role: "user", content: parts };
  }
  return { role: m.role, content: m.content };
}

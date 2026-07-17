import type { ChatMessage, ChatRequest, Provider, StreamEvent, TokenUsage, ToolDefinition } from "./types";
import { friendlyError, makeError } from "./friendly-errors";
import { zodToJsonSchema } from "./schema-util";
import { debug } from "../utils/debug";
import { createStallTimeout, streamIdleMs } from "./stall-timeout";

interface AnthropicBlock { type: string; [k: string]: unknown }

const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * Build the Anthropic /v1/messages request body, applying prompt caching
 * (cache_control breakpoints on the system prompt, tools, and the last
 * message) and extended thinking when requested.
 */
export function buildAnthropicBody(req: ChatRequest): Record<string, unknown> {
  const cache = req.enablePromptCache !== false; // default on
  const messages = toAnthropicMessages(req.messages);

  // Cache the conversation prefix: breakpoint on the last block of the last message.
  if (cache && messages.length > 0) {
    const last = messages[messages.length - 1]!;
    const block = last.content[last.content.length - 1];
    if (block) (block as Record<string, unknown>).cache_control = EPHEMERAL;
  }

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 8192,
    messages,
    stream: true,
  };

  // System prompt — array form so it can carry a cache breakpoint.
  if (req.system) {
    body.system = cache
      ? [{ type: "text", text: req.system, cache_control: EPHEMERAL }]
      : req.system;
  }

  if (req.tools && req.tools.length > 0) {
    const tools = toAnthropicTools(req.tools);
    if (cache) (tools[tools.length - 1] as Record<string, unknown>).cache_control = EPHEMERAL;
    body.tools = tools;
  }

  if (req.enableExtendedThinking) {
    const budget = 8000;
    body.thinking = { type: "enabled", budget_tokens: budget };
    // max_tokens must exceed the thinking budget; give headroom for the answer.
    body.max_tokens = Math.max(Number(body.max_tokens) || 0, budget + 8000);
  }

  return body;
}

/** Convert tool definitions to Anthropic's tool format. */
export function toAnthropicTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters ?? zodToJsonSchema(t.schema),
  }));
}

/**
 * Convert freecode messages into Anthropic's content-block format: assistant
 * tool_use blocks and user tool_result blocks, coalescing consecutive
 * same-role messages (Anthropic requires alternating roles). Mid-stream system
 * messages (e.g. a compaction summary) are folded in as user text.
 */
export function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> {
  const out: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  for (const m of messages) {
    let role: "user" | "assistant";
    const blocks: AnthropicBlock[] = [];
    if (m.role === "tool") {
      role = "user";
      blocks.push({ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content });
    } else if (m.role === "assistant") {
      role = "assistant";
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
    } else {
      // user or system (folded in as user text)
      role = "user";
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const img of m.images ?? []) {
        blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
      }
    }
    if (blocks.length === 0) continue; // Anthropic rejects empty content
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  return out;
}

interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  /** OAuth (Pro/Max subscription) access token. When set, the provider uses
   *  `Authorization: Bearer` + `anthropic-beta` and omits x-api-key. */
  oauthToken?: string;
  /** Comma-separated anthropic-beta flags to send in OAuth mode. */
  betaHeader?: string;
}

const DEFAULT_BASE = "https://api.anthropic.com";

// OAuth (subscription) tokens are rejected unless the request identifies itself
// as Claude Code — the system prompt must lead with this exact line. Harmless if
// the requirement ever relaxes; fatal (401/403) if it's needed and absent.
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

interface ApiEvent {
  type: string;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  content_block?: { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
  index?: number;
  message?: {
    usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    stop_reason?: string;
  };
  // `message_delta` carries the FINAL output token count and stop_reason at the TOP
  // level (usage here, stop_reason in `delta`) — NOT under `message`. Missing this
  // field is why output tokens went uncounted and truncation went undetected.
  usage?: { output_tokens?: number; input_tokens?: number };
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  readonly name = "Anthropic";
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly oauthToken?: string;
  private readonly betaHeader?: string;

  constructor(opts: AnthropicOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.oauthToken = opts.oauthToken;
    this.betaHeader = opts.betaHeader;
  }

  /** Auth headers: Bearer + anthropic-beta in OAuth mode, else x-api-key. */
  private authHeaders(): Record<string, string> {
    if (this.oauthToken) {
      const h: Record<string, string> = { authorization: `Bearer ${this.oauthToken}` };
      if (this.betaHeader) h["anthropic-beta"] = this.betaHeader;
      return h;
    }
    return this.apiKey ? { "x-api-key": this.apiKey } : {};
  }

  async models(): Promise<string[]> {
    const fallback = ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"];
    if (!this.apiKey && !this.oauthToken) return fallback;
    try {
      const resp = await fetch(`${this.baseUrl}/v1/models?limit=1000`, {
        headers: { ...this.authHeaders(), "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return fallback;
      const json = (await resp.json()) as { data?: Array<{ id?: string }> };
      const ids = (json.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
      return ids.length ? ids : fallback;
    } catch {
      return fallback;
    }
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.apiKey && !this.oauthToken) {
      yield { type: "error", error: makeError("anthropic", "ANTHROPIC_API_KEY not set (or sign in: freecode auth login anthropic)", "missing_api_key") };
      return;
    }
    const url = `${this.baseUrl}/v1/messages`;
    // OAuth (subscription) requires the Claude Code identity to lead the system
    // prompt, or the token is rejected. Prepend it once, in OAuth mode only.
    const effectiveReq = this.oauthToken
      ? { ...req, system: req.system && req.system.startsWith(CLAUDE_CODE_SYSTEM) ? req.system : `${CLAUDE_CODE_SYSTEM}\n\n${req.system ?? ""}`.trimEnd() }
      : req;
    const body = buildAnthropicBody(effectiveReq);
    debug.log("anthropic request", { url, model: req.model });
    // Idle watchdog — abort if the stream goes silent (see stall-timeout.ts).
    const idleMs = streamIdleMs();
    const watchdog = createStallTimeout(req.signal, idleMs);
    const timeoutError = (): Error =>
      makeError("anthropic", `Anthropic stream timed out (no data for ${Math.round(idleMs / 1000)}s)`, "timeout", true);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
        signal: watchdog.signal,
      });
    } catch (err) {
      watchdog.clear();
      throw watchdog.timedOut() ? timeoutError() : friendlyError(err, "anthropic", req.model);
    }
    if (!resp.ok || !resp.body) {
      watchdog.clear();
      const text = await resp.text().catch(() => "");
      const err = new Error(`${resp.status} ${text}`) as Error & { status?: number };
      err.status = resp.status;
      throw friendlyError(err, "anthropic", req.model);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls = new Map<number, { id?: string; name?: string; inputJson: string }>();
    let stopReason: string | undefined; // captured from message_delta, used at message_stop

    try {
    while (true) {
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ value, done } = await reader.read());
      } catch (err) {
        throw watchdog.timedOut() ? timeoutError() : friendlyError(err, "anthropic", req.model);
      }
      watchdog.reset();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let evt: ApiEvent;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        if (evt.type === "content_block_start" && evt.content_block) {
          if (evt.content_block.type === "tool_use" && typeof evt.index === "number") {
            toolCalls.set(evt.index, {
              id: evt.content_block.id,
              name: evt.content_block.name,
              inputJson: "",
            });
          }
        } else if (evt.type === "content_block_delta" && evt.delta) {
          if (evt.delta.type === "text_delta" && evt.delta.text) {
            yield { type: "text_delta", delta: evt.delta.text };
          } else if (evt.delta.type === "thinking_delta" && evt.delta.thinking) {
            yield { type: "thinking_delta", delta: evt.delta.thinking };
          } else if (evt.delta.type === "input_json_delta" && typeof evt.index === "number") {
            // Anthropic carries tool-call args here in `partial_json`, not `text`.
            const tc = toolCalls.get(evt.index);
            if (tc) tc.inputJson += evt.delta.partial_json ?? "";
          }
        } else if (evt.type === "content_block_stop" && typeof evt.index === "number") {
          const tc = toolCalls.get(evt.index);
          if (tc && tc.id && tc.name) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(tc.inputJson || "{}");
            } catch {
              input = {};
            }
            yield {
              type: "tool_call",
              call: { id: tc.id, name: tc.name, arguments: input },
            };
            toolCalls.delete(evt.index);
          }
        } else if (evt.type === "message_delta") {
          // Top-level usage carries the FINAL output token count; delta.stop_reason
          // says WHY we stopped ("max_tokens" = truncated → the loop's auto-continue
          // heal needs this). Both live here, not under `message`.
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
          if (evt.usage?.output_tokens != null) {
            yield { type: "usage", usage: { input: 0, output: evt.usage.output_tokens, cacheRead: 0, cacheWrite: 0, thinking: 0 } };
          }
        } else if (evt.type === "message_start" && evt.message?.usage) {
          const u = evt.message.usage;
          const usage: TokenUsage = {
            input: u.input_tokens,
            output: 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            thinking: 0,
          };
          yield { type: "usage", usage };
        } else if (evt.type === "message_stop") {
          yield { type: "end", reason: stopReason === "max_tokens" ? "max_tokens" : "end_turn" };
          return;
        }
      }
    }
    } finally {
      watchdog.clear();
    }
    yield { type: "end", reason: stopReason === "max_tokens" ? "max_tokens" : "end_turn" };
  }
}

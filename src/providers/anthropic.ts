import type { ChatRequest, Provider, StreamEvent, TokenUsage } from "./types";
import { friendlyError, makeError } from "./friendly-errors";
import { debug } from "../utils/debug";

interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
}

const DEFAULT_BASE = "https://api.anthropic.com";

interface ApiEvent {
  type: string;
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
  content_block?: { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
  index?: number;
  message?: {
    usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    stop_reason?: string;
  };
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  readonly name = "Anthropic";
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor(opts: AnthropicOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  }

  models() {
    return ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"];
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.apiKey) {
      yield { type: "error", error: makeError("anthropic", "ANTHROPIC_API_KEY not set", "missing_api_key") };
      return;
    }
    const url = `${this.baseUrl}/v1/messages`;
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      system: req.system,
      messages: req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role,
          content: m.content,
        })),
      stream: true,
    };
    debug.log("anthropic request", { url, model: req.model });
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      throw friendlyError(err, "anthropic");
    }
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      throw friendlyError(new Error(`${resp.status} ${text}`), "anthropic");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls = new Map<number, { id?: string; name?: string; inputJson: string }>();

    while (true) {
      const { value, done } = await reader.read();
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
            const tc = toolCalls.get(evt.index);
            if (tc) tc.inputJson += evt.delta.text ?? "";
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
        } else if (evt.type === "message_delta" && evt.message) {
          const u = evt.message.usage;
          if (u) {
            const usage: TokenUsage = {
              input: 0,
              output: u.output_tokens,
              cacheRead: 0,
              cacheWrite: 0,
              thinking: 0,
            };
            yield { type: "usage", usage };
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
          yield { type: "end", reason: "end_turn" };
          return;
        }
      }
    }
    yield { type: "end", reason: "end_turn" };
  }
}

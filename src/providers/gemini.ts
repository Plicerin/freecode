import type { ChatRequest, Provider, StreamEvent, TokenUsage } from "./types";
import { friendlyError, makeError } from "./friendly-errors";
import { debug } from "../utils/debug";

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
    const contents = [];
    if (req.system) contents.push({ role: "user", parts: [{ text: `[system]\n${req.system}` }] });
    for (const m of req.messages) {
      if (m.role === "system") continue;
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
    }
    const body = { contents, generationConfig: { maxOutputTokens: req.maxTokens ?? 8192 } };
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
          const part = cand?.content?.parts?.[0];
          if (part?.text) yield { type: "text_delta", delta: part.text };
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

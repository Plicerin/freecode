import type { z } from "zod";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ImagePart {
  /** base64-encoded image bytes (no data: prefix). */
  data: string;
  /** MIME type, e.g. "image/png". */
  mediaType: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  /** Images attached to a user message (multimodal input). */
  images?: ImagePart[];
  name?: string;
}

export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
  permission?: "safe" | "confirm" | "danger";
  /** Raw JSON Schema for params; when set, providers use it verbatim instead
   * of deriving one from `schema` (used for MCP tools, which arrive as JSON Schema). */
  parameters?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Force the model to emit a tool call this turn instead of free text.
   *  "required" = must call some tool; "auto" (default when unset) = model
   *  decides. Used by the loop to compel action when a model narrated a next
   *  step but didn't call the tool. Honored by servers with tool-call support
   *  (OpenAI, llama.cpp with --jinja); ignored as a no-op by those without. */
  toolChoice?: "auto" | "required";
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  enablePromptCache?: boolean;
  enableExtendedThinking?: boolean;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "thinking_delta"; delta: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "end"; reason: "end_turn" | "max_tokens" | "stop" | "tool_use" | "error" }
  | { type: "error"; error: ProviderError };

export interface ProviderError extends Error {
  code?: string;
  retryable?: boolean;
  provider?: string;
  /** ms to wait before retrying, parsed from the provider's Retry-After /
   *  x-ratelimit-reset headers on a 429/503. The retry layer honors this over its
   *  exponential-backoff guess so we don't retry too early and re-trip the limit. */
  retryAfterMs?: number;
}

/** Richer per-model metadata, when the provider's catalog exposes it (e.g.
 *  OpenRouter's /models carries pricing + expiration_date). Fields are optional
 *  because most providers only return bare ids. */
export interface ModelInfo {
  id: string;
  /** true/false when pricing is known; undefined when the provider doesn't say. */
  free?: boolean;
  /** false only when the catalog marks it expired/withdrawn; undefined = unknown. */
  available?: boolean;
  /** true = text-output chat model, false = a generation model (image/audio/…);
   *  undefined when the provider doesn't report modality (fall back to the name). */
  chat?: boolean;
}

export interface Provider {
  name: string;
  id: string;
  models(): Promise<string[]> | string[];
  /** Optional: the catalog with pricing/availability, so the picker can drop
   *  expired models and mark free ones accurately instead of guessing by name. */
  modelCatalog?(): Promise<ModelInfo[]>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  countTokens?(req: ChatRequest): Promise<number>;
}

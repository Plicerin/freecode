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
}

export interface Provider {
  name: string;
  id: string;
  models(): Promise<string[]> | string[];
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  countTokens?(req: ChatRequest): Promise<number>;
}

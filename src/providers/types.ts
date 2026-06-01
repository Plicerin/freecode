import type { z } from "zod";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  name?: string;
}

export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
  permission?: "safe" | "confirm" | "danger";
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

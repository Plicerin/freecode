import type { z } from "zod";
import type { ToolDefinition, ImagePart } from "../providers/types";

export type { ToolDefinition } from "../providers/types";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (chunk: string) => void;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
  /** Images produced by the tool (e.g. ViewImage); the agent loop feeds these
   * back into the conversation so the model can see them. */
  images?: ImagePart[];
}

export interface Tool<TArgs = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TArgs>;
  permission: "safe" | "confirm" | "danger";
  /** Raw JSON Schema for params; set by MCP tools whose schema isn't Zod-derived. */
  parameters?: Record<string, unknown>;
  run(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}

export function toProviderTool<T>(tool: Tool<T>): ToolDefinition<T> {
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    permission: tool.permission,
    parameters: tool.parameters,
  };
}

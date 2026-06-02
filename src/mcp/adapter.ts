import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../tools/types";
import type { McpClient, McpToolDef } from "./client";

// MCP servers validate their own arguments, so we accept any object and pass
// it through. The real schema is advertised to the model via `parameters`.
const PASSTHROUGH = z.record(z.unknown());

/** Tool/function names must be [a-zA-Z0-9_-], max 64 chars (OpenAI's limit). */
function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  // Ensure a top-level `type` (providers reject params without one); a real
  // type in the server schema overrides the default.
  return { type: "object", ...schema };
}

/** Wrap a discovered MCP tool as a freecode Tool. */
export function mcpToolToTool(client: McpClient, def: McpToolDef): Tool<Record<string, unknown>> {
  const name = `${sanitizeName(client.name)}__${sanitizeName(def.name)}`.slice(0, 64);
  const parameters = normalizeSchema(def.inputSchema);

  return {
    name,
    description: def.description ?? `${def.name} (MCP tool from ${client.name})`,
    schema: PASSTHROUGH,
    parameters,
    permission: "confirm", // external tools are never auto-safe
    async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      try {
        const { text, isError } = await client.callTool(def.name, args ?? {});
        return {
          ok: !isError,
          output: text,
          error: isError ? "MCP tool reported an error" : undefined,
          metadata: { mcpServer: client.name, mcpTool: def.name },
        };
      } catch (err) {
        return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

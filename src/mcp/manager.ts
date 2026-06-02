import { McpClient } from "./client";
import { mcpToolToTool } from "./adapter";
import type { Tool } from "../tools/types";
import type { McpServerConfig } from "../config/schema";
import { debug } from "../utils/debug";

export interface McpServerStatus {
  name: string;
  ok: boolean;
  toolCount: number;
  error?: string;
}

/**
 * Starts and supervises the configured MCP servers, exposing their tools as
 * freecode Tools and aggregating connection status for display.
 */
export class McpManager {
  private clients: McpClient[] = [];
  private readonly _tools: Tool[] = [];
  private readonly _status: McpServerStatus[] = [];

  get tools(): Tool[] {
    return this._tools;
  }

  get status(): McpServerStatus[] {
    return this._status;
  }

  /** Start every enabled server in parallel; failures are recorded, not thrown. */
  async startAll(servers: Record<string, McpServerConfig> | undefined): Promise<void> {
    if (!servers) return;
    const entries = Object.entries(servers).filter(([, cfg]) => !cfg.disabled);
    await Promise.all(
      entries.map(async ([name, cfg]) => {
        const client = new McpClient({ name, command: cfg.command, args: cfg.args, env: cfg.env });
        try {
          await client.start();
          const defs = await client.listTools();
          const tools = defs.map((d) => mcpToolToTool(client, d));
          this.clients.push(client);
          this._tools.push(...tools);
          this._status.push({ name, ok: true, toolCount: tools.length });
          debug.log(`[mcp] '${name}' connected with ${tools.length} tools`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this._status.push({ name, ok: false, toolCount: 0, error: msg });
          debug.warn(`[mcp] '${name}' failed to start`, { err: msg });
          await client.close().catch(() => {});
        }
      }),
    );
  }

  /** A one-line summary for startup display. */
  summary(): string | null {
    if (this._status.length === 0) return null;
    const ok = this._status.filter((s) => s.ok);
    const failed = this._status.filter((s) => !s.ok);
    const toolCount = ok.reduce((n, s) => n + s.toolCount, 0);
    const parts = [`MCP: ${ok.length}/${this._status.length} servers, ${toolCount} tools`];
    if (failed.length) parts.push(`(${failed.map((s) => s.name).join(", ")} failed)`);
    return parts.join(" ");
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close().catch(() => {})));
    this.clients = [];
  }
}

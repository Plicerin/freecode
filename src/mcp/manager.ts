import { McpClient } from "./client";
import { mcpToolToTool, mcpToolPrefix } from "./adapter";
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
    await Promise.all(entries.map(([name, cfg]) => this.startServer(name, cfg)));
  }

  /**
   * Connect ONE server and add its tools live (so `/mcp add` works without a
   * restart). Already-connected → no-op returning the existing status; a prior
   * FAILED entry is replaced on retry. Never throws — failures are recorded.
   */
  async startServer(name: string, cfg: McpServerConfig): Promise<McpServerStatus> {
    const existing = this._status.find((s) => s.name === name);
    if (existing?.ok) return existing; // already loaded — don't double-add tools
    if (existing) this._status.splice(this._status.indexOf(existing), 1); // retry a failed one
    const client = new McpClient({ name, command: cfg.command, args: cfg.args, env: cfg.env });
    try {
      await client.start();
      const defs = await client.listTools();
      const tools = defs.map((d) => mcpToolToTool(client, d));
      this.clients.push(client);
      this._tools.push(...tools);
      const status: McpServerStatus = { name, ok: true, toolCount: tools.length };
      this._status.push(status);
      debug.log(`[mcp] '${name}' connected with ${tools.length} tools`);
      return status;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status: McpServerStatus = { name, ok: false, toolCount: 0, error: msg };
      this._status.push(status);
      debug.warn(`[mcp] '${name}' failed to start`, { err: msg });
      await client.close().catch(() => {});
      return status;
    }
  }

  /** Disconnect ONE server and drop its tools + status live (for `/mcp remove`).
   *  Returns true if anything was actually removed. */
  async stopServer(name: string): Promise<boolean> {
    let removed = false;
    const idx = this.clients.findIndex((c) => c.name === name);
    if (idx >= 0) {
      const [client] = this.clients.splice(idx, 1);
      await client!.close().catch(() => {});
      removed = true;
    }
    const prefix = mcpToolPrefix(name);
    for (let i = this._tools.length - 1; i >= 0; i--) {
      if (this._tools[i]!.name.startsWith(prefix)) this._tools.splice(i, 1);
    }
    const si = this._status.findIndex((s) => s.name === name);
    if (si >= 0) { this._status.splice(si, 1); removed = true; }
    return removed;
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

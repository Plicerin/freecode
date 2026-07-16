import { spawn, type ChildProcess } from "node:child_process";
import { debug } from "../utils/debug";

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpClientOptions {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const PROTOCOL_VERSION = "2024-11-05";

/**
 * A minimal MCP client speaking JSON-RPC 2.0 over a child process's stdio.
 * Messages are newline-delimited JSON, per the MCP stdio transport.
 */
export class McpClient {
  readonly name: string;
  private proc?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private closed = false;

  constructor(private readonly opts: McpClientOptions) {
    this.name = opts.name;
  }

  /** Spawn the server and perform the MCP initialize handshake. */
  async start(timeoutMs = 15_000): Promise<void> {
    const proc = spawn(this.opts.command, this.opts.args ?? [], {
      env: { ...process.env, ...(this.opts.env ?? {}) },
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr?.on("data", (chunk: Buffer) =>
      debug.log(`[mcp:${this.name}] ${chunk.toString().trim()}`),
    );
    proc.on("exit", (code) => this.failAll(new Error(`MCP server '${this.name}' exited (code ${code})`)));
    proc.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
    // A write racing server death emits EPIPE on stdin; without a listener that's an
    // unhandled stream error → the whole TUI crashes. Swallow it (exit/error handle
    // the real failure).
    proc.stdin?.on("error", (err) => debug.warn(`[mcp:${this.name}] stdin error`, String(err)));

    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "freecode", version: "0.1.0" },
      },
      timeoutMs,
    );
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = (await this.request("tools/list", {})) as { tools?: McpToolDef[] };
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type} content]`))
      .join("\n");
    return { text, isError: Boolean(res.isError) };
  }

  async close(): Promise<void> {
    if (!this.proc || this.closed) return;
    this.closed = true;
    try { this.proc.stdin?.end(); } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* ignore */ }
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        debug.warn(`[mcp:${this.name}] non-JSON line ignored`, { line });
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
        else p.resolve(msg.result);
      }
      // Server-initiated notifications (no id) are ignored for now.
    }
  }

  private send(obj: unknown): void {
    if (!this.proc || this.closed) throw new Error(`MCP server '${this.name}' is not running`);
    this.proc.stdin?.write(JSON.stringify(obj) + "\n");
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP '${this.name}' ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

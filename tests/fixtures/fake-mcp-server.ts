// Minimal MCP stdio server used by tests. Speaks newline-delimited JSON-RPC.
interface Msg { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handle(JSON.parse(line) as Msg);
  }
});

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg: Msg): void {
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0" } } });
      break;
    case "notifications/initialized":
      break; // notification, no reply
    case "tools/list":
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "echo", description: "Echo back the text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
      ] } });
      break;
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (name === "echo") {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(args.text ?? "") }] } });
      } else if (name === "add") {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(Number(args.a ?? 0) + Number(args.b ?? 0)) }] } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "unknown tool" }], isError: true } });
      }
      break;
    }
    default:
      if (typeof msg.id === "number") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}

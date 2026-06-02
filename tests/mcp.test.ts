import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { McpClient } from "../src/mcp/client";
import { McpManager } from "../src/mcp/manager";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");
const server = { command: process.execPath, args: [FIXTURE] };

describe("MCP client (stdio JSON-RPC)", () => {
  it("initializes, lists tools, and calls tools", async () => {
    const client = new McpClient({ name: "fake", ...server });
    await client.start();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["add", "echo"]);

    const echo = await client.callTool("echo", { text: "hello mcp" });
    expect(echo.isError).toBe(false);
    expect(echo.text).toBe("hello mcp");

    const add = await client.callTool("add", { a: 2, b: 3 });
    expect(add.text).toBe("5");

    await client.close();
  });
});

describe("MCP manager", () => {
  it("starts a server and exposes namespaced, schema-bearing tools", async () => {
    const mgr = new McpManager();
    await mgr.startAll({ fake: server });
    expect(mgr.status[0]?.ok).toBe(true);
    expect(mgr.tools.map((t) => t.name).sort()).toEqual(["fake__add", "fake__echo"]);

    const echo = mgr.tools.find((t) => t.name === "fake__echo")!;
    expect(echo.permission).toBe("confirm"); // external tools always prompt
    expect((echo.parameters as { type?: string })?.type).toBe("object");

    const res = await echo.run({ text: "via tool" }, { cwd: process.cwd() });
    expect(res.ok).toBe(true);
    expect(res.output).toBe("via tool");

    await mgr.stopAll();
  });

  it("records a failed server without throwing", async () => {
    const mgr = new McpManager();
    await mgr.startAll({ broken: { command: "definitely-not-a-real-command-xyz" } });
    expect(mgr.status[0]?.ok).toBe(false);
    expect(mgr.tools.length).toBe(0);
    await mgr.stopAll();
  });
});

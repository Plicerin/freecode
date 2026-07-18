// Hot-load relies on a contract between two halves of the manager: startServer
// adds a server's tools via mcpToolToTool, and stopServer removes them by the
// `<server>__` name prefix (mcpToolPrefix). If those ever drift, removing a
// server would orphan its tools. This locks the contract — including for server
// names with characters that get sanitized.
import { test, expect, describe } from "bun:test";
import { mcpToolToTool, mcpToolPrefix } from "../src/mcp/adapter";
import type { McpClient, McpToolDef } from "../src/mcp/client";

const fakeClient = (name: string): McpClient => ({ name } as unknown as McpClient);
const def = (name: string): McpToolDef => ({ name, description: "d", inputSchema: { type: "object", properties: {} } });

describe("mcp hot-load tool/prefix contract", () => {
  test("a tool's name starts with its server's removal prefix (simple name)", () => {
    const t = mcpToolToTool(fakeClient("github"), def("search_issues"));
    expect(t.name.startsWith(mcpToolPrefix("github"))).toBe(true);
    expect(t.name).toBe("github__search_issues");
  });

  test("holds when the server name needs sanitizing (spaces/dots/slashes)", () => {
    const server = "my server.v2/beta";
    const t = mcpToolToTool(fakeClient(server), def("do.thing"));
    expect(t.name.startsWith(mcpToolPrefix(server))).toBe(true); // stopServer would still match it
  });

  test("the prefix does not match a different server's tools", () => {
    const t = mcpToolToTool(fakeClient("alpha"), def("x"));
    expect(t.name.startsWith(mcpToolPrefix("beta"))).toBe(false);
  });
});

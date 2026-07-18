// /mcp add should let you register an MCP server WITHOUT hand-editing JSON, and
// create settings.json if it doesn't exist yet.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMcpAdd, addMcpServer, removeMcpServer, listConfiguredMcp } from "../src/config/mcp-edit";

const tmp = () => join(mkdtempSync(join(tmpdir(), "fc-mcp-")), "settings.json");

describe("parseMcpAdd", () => {
  test("name + command + args", () => {
    const r = parseMcpAdd("github npx -y @modelcontextprotocol/server-github");
    expect(r).toEqual({ name: "github", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } });
  });

  test("leading KEY=VALUE tokens become env vars", () => {
    const r = parseMcpAdd("gh GITHUB_TOKEN=ghp_x npx server-github");
    expect(r).toEqual({ name: "gh", server: { command: "npx", args: ["server-github"], env: { GITHUB_TOKEN: "ghp_x" } } });
  });

  test("a bare command with no args", () => {
    expect(parseMcpAdd("local /usr/bin/my-mcp")).toEqual({ name: "local", server: { command: "/usr/bin/my-mcp" } });
  });

  test("errors on missing command / too few tokens", () => {
    expect(parseMcpAdd("onlyname")).toHaveProperty("error");
    expect(parseMcpAdd("name FOO=bar")).toHaveProperty("error"); // env but no command
    expect(parseMcpAdd("")).toHaveProperty("error");
  });
});

describe("add / remove / list", () => {
  test("creates settings.json when missing and adds the server", () => {
    const p = tmp();
    expect(existsSync(p)).toBe(false);
    addMcpServer("github", { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }, p);
    expect(existsSync(p)).toBe(true);
    expect(listConfiguredMcp(p).github).toEqual({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
  });

  test("preserves existing settings + comments when adding", () => {
    const p = tmp();
    writeFileSync(p, '{\n  // my theme\n  "theme": "dark"\n}\n');
    addMcpServer("fs", { command: "mcp-fs" }, p);
    const raw = readFileSync(p, "utf8");
    expect(raw).toContain("// my theme"); // comment survived
    expect(raw).toContain("mcp-fs");
    expect(listConfiguredMcp(p).fs).toEqual({ command: "mcp-fs" });
  });

  test("remove deletes the entry; returns false when absent", () => {
    const p = tmp();
    addMcpServer("a", { command: "x" }, p);
    addMcpServer("b", { command: "y" }, p);
    expect(removeMcpServer("a", p)).toBe(true);
    expect(listConfiguredMcp(p).a).toBeUndefined();
    expect(listConfiguredMcp(p).b).toEqual({ command: "y" });
    expect(removeMcpServer("missing", p)).toBe(false);
  });
});

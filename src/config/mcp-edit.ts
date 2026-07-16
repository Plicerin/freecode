// Add/remove MCP servers from settings.json WITHOUT hand-editing JSON (and
// creating the file if it doesn't exist). Edits are surgical (jsonc modify) so a
// user's existing comments/formatting in settings.json survive.
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { writeFileAtomic } from "../utils/atomic";
import { dirname } from "node:path";
import { modify, applyEdits } from "jsonc-parser";
import { SETTINGS_PATH } from "../utils/paths";
import { loadJsoncSettings } from "./settings-jsonc";
import { McpServerSchema, type McpServerConfig } from "./schema";

export interface ParsedAdd {
  name: string;
  server: McpServerConfig;
}

/**
 * Parse `/mcp add` arguments: `<name> [ENV=value ...] <command> [args...]`.
 * Leading KEY=VALUE tokens become env vars (for API keys etc.); the rest is the
 * spawn command + args. Returns an error string on bad input.
 */
export function parseMcpAdd(argline: string): ParsedAdd | { error: string } {
  const toks = argline.trim().split(/\s+/).filter(Boolean);
  if (toks.length < 2) {
    return { error: 'Usage: /mcp add <name> [ENV=value ...] <command> [args...]\nExample: /mcp add github GITHUB_TOKEN=ghp_xxx npx -y @modelcontextprotocol/server-github' };
  }
  const name = toks[0]!;
  let i = 1;
  const env: Record<string, string> = {};
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]!)) {
    const tok = toks[i]!;
    const eq = tok.indexOf("=");
    env[tok.slice(0, eq)] = tok.slice(eq + 1);
    i += 1;
  }
  if (i >= toks.length) return { error: `No command given for "${name}". Provide the program to run, e.g. \`npx -y @some/mcp-server\`.` };
  const command = toks[i]!;
  const args = toks.slice(i + 1);
  const server: McpServerConfig = {
    command,
    ...(args.length ? { args } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  };
  const valid = McpServerSchema.safeParse(server);
  if (!valid.success) return { error: `Invalid server config: ${valid.error.issues.map((x) => x.message).join("; ")}` };
  return { name, server };
}

/** Write a server under mcpServers.<name>, creating settings.json if needed. */
export function addMcpServer(name: string, server: McpServerConfig, path: string = SETTINGS_PATH): void {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "{}";
  const edits = modify(raw, ["mcpServers", name], server, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  const next = applyEdits(raw, edits);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, next);
}

/** Remove mcpServers.<name>. Returns true if something was removed. */
export function removeMcpServer(name: string, path: string = SETTINGS_PATH): boolean {
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, "utf8");
  const edits = modify(raw, ["mcpServers", name], undefined, {});
  const next = applyEdits(raw, edits);
  if (next === raw) return false;
  writeFileAtomic(path, next);
  return true;
}

/** The servers currently configured in settings.json. */
export function listConfiguredMcp(path: string = SETTINGS_PATH): Record<string, McpServerConfig> {
  return loadJsoncSettings(path).mcpServers ?? {};
}

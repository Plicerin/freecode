import type { Tool } from "./types";
import { createBashTool, type BashToolOptions } from "./bash";
import { FileReadTool } from "./file-read";
import { FileWriteTool } from "./file-write";
import { FileEditTool } from "./file-edit";
import { GlobTool } from "./glob";
import { createGrepTool, type GrepOptions } from "./grep";
import { createWebSearchTool, type WebSearchOptions } from "./web-search";
import { WebFetchTool } from "./web-fetch";

export interface RegistryOptions {
  bash?: BashToolOptions;
  grep?: GrepOptions;
  webSearch?: WebSearchOptions;
}

export function buildToolRegistry(opts: RegistryOptions = {}): Tool[] {
  return [
    createBashTool(opts.bash),
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    createGrepTool(opts.grep),
    createWebSearchTool(opts.webSearch),
    WebFetchTool,
  ];
}

export function toolListToSystemPrompt(tools: Tool[]): string {
  const cwd = process.cwd();
  const platform = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
  const lines = [
    "You are freecode, an autonomous coding agent running directly on the user's local machine through their terminal.",
    "",
    "You have REAL access to this machine through the tools listed below. The tools actually execute on the user's computer: Bash runs shell commands, the file tools read and write real files, Glob and Grep search the real filesystem. This is the entire purpose of the application.",
    "",
    "Behaviour:",
    "- When the user asks you to inspect files, list directories, run commands, search code, or make changes, DO IT by calling the appropriate tool. Then answer based on the real result.",
    "- NEVER say you cannot access the user's machine or files, and never tell the user to run a command themselves — you have the tools to do it for them. Refusing a normal local operation is a bug.",
    "- To list a directory or inspect the system, use the Bash tool (e.g. `ls -la <path>` on Unix, `dir <path>` or `Get-ChildItem <path>` on Windows). To find files by pattern use Glob; to search file contents use Grep.",
    "- Prefer tools over guessing. Don't fabricate file contents or command output — call a tool and report what it returns.",
    "- Keep responses concise. After tools return, give the user a direct answer.",
    "",
    `Environment:`,
    `- Operating system: ${platform}`,
    `- Current working directory: ${cwd}`,
    "",
    "Available tools:",
  ];
  for (const t of tools) {
    lines.push(`- ${t.name}: ${t.description} [permission=${t.permission}]`);
  }
  lines.push("");
  lines.push("When you need a tool, call it. The runtime executes it and returns the result so you can continue.");
  return lines.join("\n");
}

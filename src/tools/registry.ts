import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "./types";
import { createBashTool, bashShellName, type BashToolOptions } from "./bash";
import { FileReadTool } from "./file-read";
import { FileWriteTool } from "./file-write";
import { FileEditTool } from "./file-edit";
import { GlobTool } from "./glob";
import { createGrepTool, type GrepOptions } from "./grep";
import { createWebSearchTool, type WebSearchOptions } from "./web-search";
import { WebFetchTool } from "./web-fetch";
import { ViewImageTool } from "./view-image";

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
    ViewImageTool,
  ];
}

const CONTEXT_FILES = ["FREECODE.md", "AGENTS.md", "CLAUDE.md"];
const MAX_CONTEXT_BYTES = 32_000;

/** Load a project-context file from cwd (first match wins), capped in size. */
function loadProjectContext(cwd: string): { file: string; content: string } | null {
  for (const name of CONTEXT_FILES) {
    const p = join(cwd, name);
    try {
      if (!existsSync(p) || !statSync(p).isFile()) continue;
      let content = readFileSync(p, "utf8").trim();
      if (!content) continue;
      if (content.length > MAX_CONTEXT_BYTES) content = content.slice(0, MAX_CONTEXT_BYTES) + "\n…(truncated)";
      return { file: name, content };
    } catch {
      // unreadable — skip
    }
  }
  return null;
}

export function toolListToSystemPrompt(tools: Tool[]): string {
  const cwd = process.cwd();
  const platform = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
  const shell = bashShellName();
  const listExample = shell === "PowerShell" ? "`Get-ChildItem <path>`" : "`ls -la <path>`";
  const lines = [
    "You are freecode, an autonomous coding agent running directly on the user's local machine through their terminal.",
    "",
    "You have REAL access to this machine through the tools listed below. The tools actually execute on the user's computer: Bash runs shell commands, the file tools read and write real files, Glob and Grep search the real filesystem. This is the entire purpose of the application.",
    "",
    "Behaviour:",
    "- When the user asks you to inspect files, list directories, run commands, search code, or make changes, DO IT by calling the appropriate tool. Then answer based on the real result.",
    "- NEVER say you cannot access the user's machine or files, and never tell the user to run a command themselves — you have the tools to do it for them. Refusing a normal local operation is a bug.",
    `- The Bash tool runs ${shell} on this machine — write commands in ${shell} syntax. To list a directory use ${listExample}. To find files by pattern use Glob; to search file contents use Grep.`,
    "- Prefer tools over guessing. Don't fabricate file contents or command output — call a tool and report what it returns.",
    "- To examine the visual contents of an image file (to describe it, or rename it by content), call the ViewImage tool with its path — the image then becomes visible to you. Use Glob/Bash to find the image paths first.",
    "",
    "Targeting and honesty (important):",
    "- Operate ONLY on the files and paths the user explicitly names, attaches, or asks you to find in a specific location. If the user refers to files but you can't tell which ones, ASK — do not guess.",
    "- NEVER recursively scan the working directory for files to modify, rename, or delete unless the user clearly asked you to act on the whole directory. Grabbing unrelated nearby files is a serious error.",
    "- If a task genuinely needs a capability you don't have, say so plainly and stop. Do not substitute unrelated files or fake progress.",
    "- Before a destructive action (delete, overwrite, bulk rename), confirm the exact targets. Don't proceed on ambiguous scope.",
    "- Keep responses concise. After tools return, give the user a direct answer.",
    "",
    `Environment:`,
    `- Operating system: ${platform}`,
    `- Shell (the Bash tool executes commands here): ${shell}`,
    `- Current working directory: ${cwd}`,
    "",
    "Available tools:",
  ];
  for (const t of tools) {
    lines.push(`- ${t.name}: ${t.description} [permission=${t.permission}]`);
  }
  lines.push("");
  lines.push("When you need a tool, call it. The runtime executes it and returns the result so you can continue.");
  const ctx = loadProjectContext(cwd);
  if (ctx) {
    lines.push("");
    lines.push(`Project context (from ${ctx.file}) — follow these project-specific instructions:`);
    lines.push(ctx.content);
  }
  return lines.join("\n");
}

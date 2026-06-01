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
  const lines = ["You have access to the following tools:"];
  for (const t of tools) {
    lines.push(`- ${t.name}: ${t.description} [permission=${t.permission}]`);
  }
  lines.push("");
  lines.push("When you need a tool, respond with a tool invocation. The runtime will execute it and return the result.");
  return lines.join("\n");
}

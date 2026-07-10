import type { Tool } from "./types";

// Models carry a strong trained prior for the standard agent tool names —
// Claude Code's Write/Read/Edit, shell/terminal for a shell, str_replace_editor,
// etc. freecode names its tools FileWrite/FileRead/FileEdit/Bash, so a model
// calls "Write", hits "tool not found", and burns a turn retrying "FileWrite".
// Map the common aliases to freecode's canonical tool so the first call just
// works. Keys are normalised (lowercase, separators stripped). An exact or
// case-insensitive match to a REAL tool (including MCP tools) always wins first,
// so an alias only applies when nothing else matches.
const ALIASES: Record<string, string> = {
  write: "FileWrite", writefile: "FileWrite", createfile: "FileWrite", newfile: "FileWrite", savefile: "FileWrite",
  read: "FileRead", readfile: "FileRead", viewfile: "FileRead", catfile: "FileRead", openfile: "FileRead", cat: "FileRead",
  edit: "FileEdit", editfile: "FileEdit", strreplace: "FileEdit", strreplaceeditor: "FileEdit",
  strreplacebasededittool: "FileEdit", applypatch: "FileEdit", replaceinfile: "FileEdit", patchfile: "FileEdit",
  shell: "Bash", terminal: "Bash", runcommand: "Bash", executecommand: "Bash", runshell: "Bash",
  powershell: "Bash", runbash: "Bash", executebash: "Bash",
  findfiles: "Glob", globfilesearch: "Glob", filesearch: "Glob", listfiles: "Glob",
  grepsearch: "Grep", searchtext: "Grep", ripgrep: "Grep", searchcode: "Grep", searchfiles: "Grep",
  fetchurl: "WebFetch", webfetch: "WebFetch", fetchwebpage: "WebFetch", browseurl: "WebFetch",
  websearch: "WebSearch", searchweb: "WebSearch", googlesearch: "WebSearch",
  viewimage: "ViewImage", readimage: "ViewImage", showimage: "ViewImage",
};

const norm = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");

/** Resolve a model-called tool name to an available tool, tolerating case and the
 *  common cross-framework aliases (Write→FileWrite, shell→Bash, str_replace→
 *  FileEdit, …). Exact then case-insensitive matches win before any alias.
 *  Returns undefined only when nothing plausibly matches. */
export function resolveTool(tools: Tool[], name: string): Tool | undefined {
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const ci = tools.find((t) => t.name.toLowerCase() === lower);
  if (ci) return ci;
  const canonical = ALIASES[norm(name)];
  return canonical ? tools.find((t) => t.name === canonical) : undefined;
}

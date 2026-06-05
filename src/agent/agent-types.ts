// Subagent types (ROADMAP Tier A). A type is a named preset: a specialization
// prompt + an optional tool allowlist that the orchestrator selects when it
// dispatches a sub-agent. Built-ins ship with freecode; users/projects add their
// own as `.md` files (same convention as custom commands): frontmatter for
// `description` and `tools`, body as the specialization prompt. Project agents
// override user agents override built-ins by name.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "../utils/paths";

export interface AgentType {
  name: string;
  description: string; // when to use it — shown to the orchestrator and in /agents
  systemPrompt: string; // appended to the base sub-agent prompt ("" = no specialization)
  tools?: string[]; // optional allowlist of tool names; undefined = all available
  source: "builtin" | "user" | "project";
}

export const BUILTIN_AGENTS: AgentType[] = [
  {
    name: "general",
    description: "General-purpose autonomous agent for any multi-step task. Full tool access. The default.",
    systemPrompt: "",
    source: "builtin",
  },
  {
    name: "explore",
    description: "Read-only codebase exploration — locate files, trace how something works, gather facts. Cannot modify anything.",
    systemPrompt:
      "You are an EXPLORE sub-agent: you find and report, you never modify. Search broadly (Glob/Grep), read what's relevant (FileRead), and return a precise map — the files and symbols that matter and how they fit together, cited as path:line. Be the eyes, not the hands.",
    tools: ["FileRead", "Glob", "Grep"],
    source: "builtin",
  },
  {
    name: "code-reviewer",
    description: "Reviews code or a working-tree diff for correctness, risk, and concrete improvements. Read-only review.",
    systemPrompt:
      "You are a CODE-REVIEWER sub-agent. Inspect the relevant code (run `git diff`/`git diff --staged` via Bash if reviewing changes), then report bugs, risky edits, and concrete fixes — specific, cited as path:line, ordered by severity. Do not modify files; your final message IS the review.",
    tools: ["FileRead", "Glob", "Grep", "Bash"],
    source: "builtin",
  },
];

function parseAgentFile(text: string): { description?: string; tools?: string[]; systemPrompt: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { systemPrompt: text.trim() };
  const fm = m[1]!;
  const description = /(^|\n)\s*description:\s*(.+)/i.exec(fm)?.[2]?.trim();
  const toolsRaw = /(^|\n)\s*tools:\s*(.+)/i.exec(fm)?.[2]?.trim();
  const tools = toolsRaw ? toolsRaw.split(/[,\s]+/).filter(Boolean) : undefined;
  return { description, tools, systemPrompt: text.slice(m[0].length).trim() };
}

function loadAgentDir(dir: string, source: "user" | "project", into: Map<string, AgentType>): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    try {
      const { description, tools, systemPrompt } = parseAgentFile(readFileSync(join(dir, file), "utf8"));
      if (!systemPrompt) continue; // an agent with no prompt is meaningless
      into.set(name, { name, description: description ?? `(${source} agent)`, systemPrompt, tools, source });
    } catch {
      // skip unreadable agent files
    }
  }
}

/** Built-ins + user + project agent types; later sources override earlier by name. */
export function resolveAgentTypes(cwd: string): AgentType[] {
  const map = new Map<string, AgentType>();
  for (const a of BUILTIN_AGENTS) map.set(a.name, a);
  loadAgentDir(join(APP_DIR, "agents"), "user", map);
  loadAgentDir(join(cwd, ".freecode", "agents"), "project", map);
  return [...map.values()];
}

export function getAgentType(name: string, cwd: string): AgentType | undefined {
  return resolveAgentTypes(cwd).find((a) => a.name === name);
}

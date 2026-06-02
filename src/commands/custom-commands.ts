import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "../utils/paths";

export interface CustomCommand {
  name: string;
  description?: string;
  body: string;
  source: "user" | "project";
}

function parseFile(text: string): { description?: string; body: string } {
  // Optional frontmatter: --- ... --- with a `description:` line.
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    const dm = /(^|\n)\s*description:\s*(.+)/i.exec(m[1]!);
    return { description: dm?.[2]?.trim(), body: text.slice(m[0].length).trim() };
  }
  return { body: text.trim() };
}

function loadDir(dir: string, source: CustomCommand["source"], into: Map<string, CustomCommand>): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    try {
      const { description, body } = parseFile(readFileSync(join(dir, file), "utf8"));
      if (body) into.set(name, { name, description, body, source });
    } catch {
      // skip unreadable command files
    }
  }
}

/** Load custom slash commands; project commands override same-named user ones. */
export function loadCustomCommands(cwd: string): Map<string, CustomCommand> {
  const map = new Map<string, CustomCommand>();
  loadDir(join(APP_DIR, "commands"), "user", map);
  loadDir(join(cwd, ".freecode", "commands"), "project", map);
  return map;
}

/** Expand a command template with the invocation's arguments. */
export function expandCommand(body: string, args: string): string {
  const trimmed = args.trim();
  const parts = trimmed.length ? trimmed.split(/\s+/) : [];
  let out = body.replace(/\$ARGUMENTS\b/g, trimmed);
  out = out.replace(/\$(\d)/g, (_, d: string) => parts[Number(d) - 1] ?? "");
  // If the template took no arguments but some were given, append them.
  if (!/\$ARGUMENTS\b/.test(body) && !/\$\d/.test(body) && trimmed) {
    out += `\n\n${trimmed}`;
  }
  return out;
}

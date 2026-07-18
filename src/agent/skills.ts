// Skills (ROADMAP Tier A). A skill is reusable, project-specific procedural
// knowledge: a `.md` file whose frontmatter `description` is the trigger ("when
// to use this") and whose body is the instructions. Only the name+description go
// into the system prompt (a cheap index); the full body is pulled in ON DEMAND
// via the Skill tool, so an unused skill costs almost no context. Discovery
// mirrors commands/agents: user dir + project `.freecode/skills/`, project wins.
//
// Two layouts are supported: a flat `<name>.md`, or `<name>/SKILL.md` (a folder
// so a skill can ship alongside scripts/resources, Claude-Code style).
//
// This module is also the foundation the future self-authoring layer builds on:
// a "propose a skill" path just writes a `<name>.md` into the project dir below.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "../utils/paths";
import { pluginDirs } from "../plugins";

export interface Skill {
  name: string;
  description: string; // the trigger — surfaced in the prompt index
  body: string; // the instructions — loaded on demand
  source: "user" | "project" | "plugin";
  path: string;
}

function parseSkill(text: string): { description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { body: text.trim() };
  const description = /(^|\n)\s*description:\s*(.+)/i.exec(m[1]!)?.[2]?.trim();
  return { description, body: text.slice(m[0].length).trim() };
}

function addSkill(file: string, name: string, source: Skill["source"], into: Map<string, Skill>): void {
  try {
    const { description, body } = parseSkill(readFileSync(file, "utf8"));
    // A skill needs BOTH a trigger (description) and instructions (body) to be
    // useful — the description is how the agent decides to load it.
    if (!description || !body) return;
    into.set(name, { name, description, body, source, path: file });
  } catch {
    // skip unreadable skill files
  }
}

function loadSkillDir(dir: string, source: Skill["source"], into: Map<string, Skill>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skillMd = join(dir, entry.name, "SKILL.md");
      if (existsSync(skillMd)) addSkill(skillMd, entry.name, source, into);
    } else if (entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
      addSkill(join(dir, entry.name), entry.name.slice(0, -3), source, into);
    }
  }
}

/** User skills + project skills; project overrides a same-named user skill. */
export function resolveSkills(cwd: string): Skill[] {
  const map = new Map<string, Skill>();
  loadSkillDir(join(APP_DIR, "skills"), "user", map);
  for (const d of pluginDirs(cwd, "skills")) loadSkillDir(d, "plugin", map);
  loadSkillDir(join(cwd, ".freecode", "skills"), "project", map);
  return [...map.values()];
}

export function getSkill(name: string, cwd: string): Skill | undefined {
  return resolveSkills(cwd).find((s) => s.name === name);
}

/** Compact index for the system prompt — names + triggers, NOT bodies. */
export function skillsIndex(skills: Skill[]): string {
  if (!skills.length) return "";
  return [
    "",
    "Skills (reusable procedures available for THIS project, loaded on demand):",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
    "When a task matches a skill's description, call the Skill tool with that skill's name to load its full instructions, then follow them. Don't guess a skill's contents — load it.",
  ].join("\n");
}

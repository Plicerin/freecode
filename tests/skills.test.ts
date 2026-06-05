// Skills foundation (ROADMAP Tier A). Covers discovery (flat `<name>.md` and
// `<name>/SKILL.md` folder forms), the description+body requirement, the prompt
// index (names/triggers only, not bodies), and the Skill tool's on-demand load.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkills, getSkill, skillsIndex } from "../src/agent/skills";
import { SkillTool } from "../src/tools/skill";
import { buildToolRegistry } from "../src/tools/registry";

function project(skills: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fc-skills-"));
  const base = join(dir, ".freecode", "skills");
  mkdirSync(base, { recursive: true });
  for (const [rel, content] of Object.entries(skills)) {
    const full = join(base, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
const ctx = (cwd: string) => ({ cwd, signal: undefined as unknown as AbortSignal });

describe("skill discovery", () => {
  test("loads a flat <name>.md and a <name>/SKILL.md folder skill", () => {
    const dir = project({
      "deploy.md": "---\ndescription: how to deploy this project\n---\nRun the deploy script, then verify.",
      "release/SKILL.md": "---\ndescription: cut a release\n---\nBump version, tag, push.",
    });
    const names = resolveSkills(dir).map((s) => s.name).sort();
    expect(names).toEqual(["deploy", "release"]);
    expect(getSkill("deploy", dir)?.body).toContain("deploy script");
    expect(getSkill("release", dir)?.source).toBe("project");
  });

  test("a skill missing its description OR body is ignored", () => {
    const dir = project({
      "no-desc.md": "---\nfoo: bar\n---\nbody but no description",
      "no-body.md": "---\ndescription: has a trigger but no instructions\n---\n",
      "good.md": "---\ndescription: complete skill\n---\ndo the thing",
    });
    expect(resolveSkills(dir).map((s) => s.name)).toEqual(["good"]);
  });
});

describe("skillsIndex", () => {
  test("lists names + triggers but NOT bodies; empty when no skills", () => {
    const dir = project({ "x.md": "---\ndescription: the trigger text\n---\nSECRET BODY DETAIL" });
    const idx = skillsIndex(resolveSkills(dir));
    expect(idx).toContain("x: the trigger text");
    expect(idx).not.toContain("SECRET BODY DETAIL"); // bodies stay out of the prompt (context-fork)
    expect(skillsIndex([])).toBe("");
  });
});

describe("Skill tool", () => {
  test("is in the base registry", () => {
    expect(buildToolRegistry().some((t) => t.name === "Skill")).toBe(true);
  });

  test("loads a skill's full body on demand", async () => {
    const dir = project({ "fix.md": "---\ndescription: fix flaky tests\n---\nStep 1. Step 2. $ARGUMENTS" });
    const r = await SkillTool.run({ name: "fix", args: "in the auth module" } as never, ctx(dir));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Step 1. Step 2.");
    expect(r.output).toContain("in the auth module"); // $ARGUMENTS expanded
  });

  test("unknown skill fails cleanly and lists what's available", async () => {
    const dir = project({ "real.md": "---\ndescription: a real one\n---\nbody" });
    const r = await SkillTool.run({ name: "ghost" } as never, ctx(dir));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown skill "ghost"/);
    expect(r.error).toMatch(/real/);
  });
});

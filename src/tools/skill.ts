// The Skill tool — loads a project skill's full instructions on demand. Listed
// under "Skills" in the system prompt; the agent calls this when a task matches
// a skill's trigger, and follows the returned instructions. Stateless (reads
// from disk per call), so it lives in the base registry like any other tool.
import { z } from "zod";
import type { Tool } from "./types";
import { getSkill, resolveSkills } from "../agent/skills";
import { expandCommand } from "../commands/custom-commands";
import { recordFire } from "../agent/learn-stats";
import { logActivity } from "../utils/activity";

const schema = z.object({
  name: z.string().min(1).describe("The skill to load (see the Skills list in your system prompt)"),
  args: z.string().optional().describe("Optional arguments to fill into the skill's template ($ARGUMENTS / $1…)"),
});

export const SkillTool: Tool = {
  name: "Skill",
  description:
    "Load a project skill's full instructions by name, then follow them. Skills are reusable procedures listed under 'Skills' in your system prompt — call this when a task matches one, rather than guessing the procedure.",
  permission: "safe",
  schema,
  async run(args, ctx) {
    const { name, args: skillArgs } = args as z.infer<typeof schema>;
    const skill = getSkill(name, ctx.cwd);
    if (!skill) {
      const valid = resolveSkills(ctx.cwd).map((s) => s.name).join(", ") || "(none defined)";
      return { ok: false, output: "", error: `Unknown skill "${name}". Available: ${valid}` };
    }
    // Phase-2 measurement: count the load as a "fire" so the scorecard can show
    // which skills earn their keep (and which never fire → decay candidates).
    recordFire(ctx.cwd, "skill", skill.name, new Date().toISOString());
    logActivity(`LEARN-FIRE skill "${skill.name}"`);
    const body = skillArgs ? expandCommand(skill.body, skillArgs) : skill.body;
    return { ok: true, output: `# Skill: ${skill.name}\n\n${body}` };
  },
};

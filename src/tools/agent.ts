// The Agent tool — lets the orchestrator dispatch an autonomous sub-agent for a
// focused, self-contained task (ROADMAP Tier A). The host supplies the live
// run-context via a getter so provider/model switches are picked up. As defence
// in depth the sub-agent's toolset is stripped of any Agent tool here too, so
// nesting is impossible no matter what the host passes in.
import { z } from "zod";
import type { Tool } from "./types";
import { runSubAgent, type SubAgentContext } from "../agent/subagent";
import { resolveAgentTypes, getAgentType } from "../agent/agent-types";

const schema = z.object({
  description: z.string().min(1).describe("A short (3-5 word) description of the task"),
  prompt: z
    .string()
    .min(1)
    .describe(
      "The complete, standalone task for the sub-agent. It cannot see this conversation, so include everything it needs.",
    ),
  subagent_type: z
    .string()
    .optional()
    .describe('Which agent type to dispatch (default "general"). See the type list in this tool description.'),
});

const DESCRIPTION_BASE =
  "Dispatch an autonomous sub-agent to handle a focused, multi-step task and return its final report. " +
  "The sub-agent runs in its own fresh context with the same tools (except it cannot dispatch further sub-agents), " +
  "executes the task end-to-end, and its final message is returned to you as the result. " +
  "Use it to isolate self-contained work — a broad search across the codebase, a contained implementation, " +
  "or focused research — so it doesn't crowd your own context. Give it a complete, standalone prompt; " +
  "it cannot ask you questions. Prefer doing simple things yourself — reach for a sub-agent when the work is " +
  "large, parallelizable, or worth keeping out of your main thread.";

/** The host can pass `onProgress` to surface a running sub-agent's interior
 *  (its tool calls) live, instead of only the final report. */
export type AgentToolContext = SubAgentContext & { onProgress?: (line: string) => void };

/** Build the Agent tool bound to a live run-context getter. The available agent
 *  types are baked into the description (rebuilt per turn, so project agents
 *  show up) and validated at call time against the current working directory. */
export function createAgentTool(getCtx: () => AgentToolContext): Tool {
  const types = resolveAgentTypes(process.cwd());
  const typeList = types.map((t) => `  • ${t.name} — ${t.description}`).join("\n");
  const description = `${DESCRIPTION_BASE}\n\nAvailable agent types (pass as subagent_type, default "general"):\n${typeList}`;
  return {
    name: "Agent",
    description,
    permission: "safe", // the sub-agent's OWN tool calls are permissioned individually
    schema,
    async run(args, ctx) {
      const { description: desc, prompt, subagent_type } = args as z.infer<typeof schema>;
      const c = getCtx();
      const typeName = subagent_type ?? "general";
      const agentType = getAgentType(typeName, ctx.cwd);
      if (!agentType) {
        const valid = resolveAgentTypes(ctx.cwd).map((t) => t.name).join(", ");
        return { ok: false, output: "", error: `Unknown subagent_type "${typeName}". Available: ${valid}` };
      }
      // Recursion guard: never hand a sub-agent the means to spawn more.
      const subTools = c.tools.filter((t) => t.name !== "Agent");
      try {
        const r = await runSubAgent({
          ...c,
          tools: subTools,
          description: desc,
          prompt,
          agentType,
          signal: ctx.signal,
          // Live progress: surface each interior tool call so the run is visibly
          // working instead of a frozen spinner until the final report.
          onEvent: c.onProgress
            ? (e) => { if (e.type === "tool_call" && e.call) c.onProgress!(`↳ ${typeName} → ${e.call.name}`); }
            : undefined,
        });
        return { ok: r.ok, output: r.output };
      } catch (e) {
        return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

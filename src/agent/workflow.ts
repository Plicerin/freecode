// Workflows (ROADMAP Tier A) — declarative, file-based orchestration of the
// sub-agents we already ship. A workflow is an ordered list of STAGES; the tasks
// within a stage run in PARALLEL, and each stage is a BARRIER (it starts only
// after the previous stage finishes). A task dispatches a sub-agent (optionally a
// named type), and its prompt can interpolate `{{input}}` (the run's input) and
// `{{previous}}` (the combined output of the prior stage) — so a fan-out stage
// can feed a synthesis stage.
//
// This is the *declarative* half. The *dynamic* half (an agent composing
// orchestration on the fly, `/ultraplan`) is deliberately deferred — it needs a
// scripting runtime; this needs only JSON + the sub-agent engine.
import { z } from "zod";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "../utils/paths";
import { runSubAgent, type SubAgentContext } from "./subagent";
import { getAgentType } from "./agent-types";
import { pluginDirs } from "../plugins";

export const WorkflowTaskSchema = z.object({
  agent: z.string().optional(), // a subagent_type; omitted = general
  prompt: z.string().min(1),
});
export const WorkflowStageSchema = z.object({
  name: z.string().optional(),
  tasks: z.array(WorkflowTaskSchema).min(1),
});
export const WorkflowFileSchema = z.object({
  description: z.string().min(1),
  stages: z.array(WorkflowStageSchema).min(1),
});
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

export interface Workflow {
  name: string;
  description: string;
  stages: WorkflowStage[];
  source: "user" | "project" | "plugin";
  path: string;
}

function loadWorkflowDir(dir: string, source: Workflow["source"], into: Map<string, Workflow>): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -5);
    try {
      const parsed = WorkflowFileSchema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
      if (parsed.success) into.set(name, { name, ...parsed.data, source, path: join(dir, file) });
    } catch {
      // skip unreadable/invalid workflow files
    }
  }
}

/** User + project workflows; project overrides a same-named user workflow. */
export function resolveWorkflows(cwd: string): Workflow[] {
  const map = new Map<string, Workflow>();
  loadWorkflowDir(join(APP_DIR, "workflows"), "user", map);
  for (const d of pluginDirs(cwd, "workflows")) loadWorkflowDir(d, "plugin", map);
  loadWorkflowDir(join(cwd, ".freecode", "workflows"), "project", map);
  return [...map.values()];
}

export function getWorkflow(name: string, cwd: string): Workflow | undefined {
  return resolveWorkflows(cwd).find((w) => w.name === name);
}

export interface StageResult {
  name?: string;
  outputs: { agent?: string; output: string; ok: boolean }[];
}

/** Execute a workflow stage by stage (barrier between stages, parallel within),
 *  returning every stage's results plus the final stage's combined output. */
export async function runWorkflow(
  wf: Workflow,
  ctx: SubAgentContext & {
    input: string;
    cwd: string;
    signal?: AbortSignal;
    onStage?: (index: number, stage: WorkflowStage, result: StageResult) => void;
  },
): Promise<{ stages: StageResult[]; output: string }> {
  const results: StageResult[] = [];
  let previous = "";
  for (let i = 0; i < wf.stages.length; i++) {
    if (ctx.signal?.aborted) break;
    const stage = wf.stages[i]!;
    const outputs = await Promise.all(
      stage.tasks.map(async (task) => {
        const prompt = task.prompt
          .replace(/\{\{\s*input\s*\}\}/g, ctx.input)
          .replace(/\{\{\s*previous\s*\}\}/g, previous);
        const agentType = task.agent ? getAgentType(task.agent, ctx.cwd) : undefined;
        const r = await runSubAgent({ ...ctx, prompt, description: stage.name ?? `stage ${i + 1}`, agentType, signal: ctx.signal });
        return { agent: task.agent, output: r.output, ok: r.ok };
      }),
    );
    const result: StageResult = { name: stage.name, outputs };
    results.push(result);
    ctx.onStage?.(i, stage, result);
    previous = outputs.map((o, j) => `### ${o.agent ?? `task ${j + 1}`}\n${o.output}`).join("\n\n");
  }
  return { stages: results, output: previous };
}

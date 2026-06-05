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
import { getAgentType, resolveAgentTypes } from "./agent-types";
import { pluginDirs } from "../plugins";
import type { Provider } from "../providers/types";

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
  source: "user" | "project" | "plugin" | "dynamic";
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

/** Fine-grained progress so the UI can stream a workflow as it runs, rather than
 *  only ticking once per finished stage. `task_done` fires as each parallel task
 *  in a stage resolves (so a slow task doesn't hide its faster siblings). */
export type WorkflowEvent =
  | { type: "stage_start"; index: number; name?: string; tasks: number }
  | { type: "task_done"; stage: number; task: number; agent?: string; ok: boolean }
  | { type: "stage_done"; index: number; result: StageResult };

/** Execute a workflow stage by stage (barrier between stages, parallel within),
 *  returning every stage's results plus the final stage's combined output. */
export async function runWorkflow(
  wf: Workflow,
  ctx: SubAgentContext & {
    input: string;
    cwd: string;
    signal?: AbortSignal;
    onStage?: (index: number, stage: WorkflowStage, result: StageResult) => void;
    onEvent?: (e: WorkflowEvent) => void;
  },
): Promise<{ stages: StageResult[]; output: string }> {
  // The workflow-only fields (input/onStage/onEvent) must NOT flow into runSubAgent
  // — it has its own onEvent of a different shape. Keep them as locals and pass
  // only the sub-agent context (`base`) down.
  const { input, onStage, onEvent, ...base } = ctx;
  const results: StageResult[] = [];
  let previous = "";
  for (let i = 0; i < wf.stages.length; i++) {
    if (ctx.signal?.aborted) break;
    const stage = wf.stages[i]!;
    onEvent?.({ type: "stage_start", index: i, name: stage.name, tasks: stage.tasks.length });
    const outputs = await Promise.all(
      stage.tasks.map(async (task, ti) => {
        const prompt = task.prompt
          .replace(/\{\{\s*input\s*\}\}/g, input)
          .replace(/\{\{\s*previous\s*\}\}/g, previous);
        const agentType = task.agent ? getAgentType(task.agent, ctx.cwd) : undefined;
        const r = await runSubAgent({ ...base, prompt, description: stage.name ?? `stage ${i + 1}`, agentType, signal: ctx.signal });
        onEvent?.({ type: "task_done", stage: i, task: ti, agent: task.agent, ok: r.ok });
        return { agent: task.agent, output: r.output, ok: r.ok };
      }),
    );
    const result: StageResult = { name: stage.name, outputs };
    results.push(result);
    onEvent?.({ type: "stage_done", index: i, result });
    onStage?.(i, stage, result);
    previous = outputs.map((o, j) => `### ${o.agent ?? `task ${j + 1}`}\n${o.output}`).join("\n\n");
  }
  return { stages: results, output: previous };
}

// ── Dynamic composition (/ultraplan) ────────────────────────────────────────
// Instead of reading a hand-written JSON file, freecode asks the model to DESIGN
// a workflow for an arbitrary task — which stages, which sub-agents run in
// parallel, how the synthesis stage combines them — then runs that plan through
// the very same engine above. The model only emits a declarative spec (no code),
// so it's validated by the same Zod schema as a file-based workflow.

/** Pull the first JSON object out of a model reply (tolerates ``` fences + prose). */
function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("the planner returned no JSON object");
  return JSON.parse(body.slice(start, end + 1));
}

/** Ask the model to compose a workflow for `task`, validated into a runnable
 *  Workflow (source: "dynamic"). Throws if the model can't produce a valid spec. */
export async function composeWorkflow(
  provider: Provider,
  model: string,
  task: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<Workflow> {
  const typeList = resolveAgentTypes(cwd).map((a) => `  - ${a.name}: ${a.description}`).join("\n");
  const system = [
    "You are freecode's workflow planner. Decompose the user's task into a multi-agent workflow and output it as JSON ONLY — no prose, no markdown fences.",
    "",
    "Shape: { \"description\": string, \"stages\": [ { \"name\": string, \"tasks\": [ { \"agent\"?: string, \"prompt\": string } ] } ] }",
    "",
    "Rules:",
    "- Stages run SEQUENTIALLY (a barrier between them); tasks WITHIN a stage run in PARALLEL. Put independent work in parallel tasks; use a later stage to combine/synthesize.",
    "- Each task.prompt may interpolate {{input}} (the original task) and {{previous}} (the prior stage's combined output). A synthesis stage almost always references {{previous}}.",
    "- \"agent\" must be one of the available sub-agent types below (omit it for a general agent). Read-only investigation → explore; reviewing code → code-reviewer.",
    "- Keep it tight and purposeful: usually 2 stages (a parallel fan-out, then a single general-agent synthesis). 1–4 tasks per stage. Never exceed 4 stages.",
    "",
    "Available sub-agent types:",
    typeList,
  ].join("\n");

  let text = "";
  for await (const e of provider.stream({
    model,
    system,
    messages: [{ role: "user", content: `Task to decompose into a workflow:\n\n${task}` }],
    stream: true,
    maxTokens: 2048,
    signal,
  })) {
    if (e.type === "text_delta") text += e.delta;
  }

  let parsedJson: unknown;
  try {
    parsedJson = extractJsonObject(text);
  } catch (err) {
    throw new Error(`could not compose a workflow — ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = WorkflowFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`the composed workflow was invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { name: "ultraplan", ...parsed.data, source: "dynamic", path: "(dynamic)" };
}

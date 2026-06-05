// Workflows (ROADMAP Tier A). Covers discovery + schema validation, the shipped
// example workflow, and the engine: parallel within a stage, barrier between
// stages, and {{input}}/{{previous}} interpolation feeding fan-out → synthesis.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { resolveWorkflows, getWorkflow, runWorkflow, composeWorkflow, type Workflow, type WorkflowEvent } from "../src/agent/workflow";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Tool } from "../src/tools/types";

const allow = (async () => "allow") as ApprovalCallback;
const perm = () => createPermissionEngine("bypass", allow);

// A provider that echoes back the prompt it was given, so we can assert what each
// sub-agent actually received (i.e. that interpolation happened).
const echo = {
  name: "e", id: "e", models: () => ["x"],
  async *stream(req: { messages: { role: string; content: string }[] }) {
    const last = [...req.messages].reverse().find((m) => m.role === "user");
    yield { type: "text_delta", delta: `ECHO:${last?.content ?? ""}` };
    yield { type: "end", reason: "end_turn" };
  },
};

describe("workflow discovery", () => {
  test("loads valid JSON workflows and skips invalid ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-wf-"));
    mkdirSync(join(dir, ".freecode", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".freecode", "workflows", "good.json"),
      JSON.stringify({ description: "ok", stages: [{ tasks: [{ prompt: "do it" }] }] }));
    writeFileSync(join(dir, ".freecode", "workflows", "bad.json"),
      JSON.stringify({ description: "missing stages" })); // schema-invalid
    writeFileSync(join(dir, ".freecode", "workflows", "broken.json"), "{ not json");
    expect(resolveWorkflows(dir).map((w) => w.name)).toEqual(["good"]);
  });

  test("the shipped review.json workflow is valid (2 stages: review → synthesize)", () => {
    const wf = getWorkflow("review", process.cwd());
    expect(wf).toBeDefined();
    expect(wf!.stages.length).toBe(2);
    expect(wf!.stages[0]!.tasks.length).toBe(2); // parallel correctness + security
  });
});

describe("runWorkflow engine", () => {
  test("runs stages with a barrier, parallel within, interpolating {{input}} and {{previous}}", async () => {
    const wf: Workflow = {
      name: "t", description: "d", source: "project", path: "",
      stages: [
        { name: "fan-out", tasks: [{ prompt: "Q1 about {{input}}" }, { prompt: "Q2 about {{input}}" }] },
        { name: "synthesize", tasks: [{ prompt: "summarize: {{previous}}" }] },
      ],
    };
    const seen: number[] = [];
    const res = await runWorkflow(wf, {
      provider: echo as never, model: "x", tools: [], permission: perm(), promptUser: allow,
      input: "FOO", cwd: process.cwd(), onStage: (i) => seen.push(i),
    });

    expect(res.stages.length).toBe(2);
    // Stage 1 ran both tasks in parallel, each with {{input}} filled.
    expect(res.stages[0]!.outputs.length).toBe(2);
    expect(res.stages[0]!.outputs[0]!.output).toContain("Q1 about FOO");
    expect(res.stages[0]!.outputs[1]!.output).toContain("Q2 about FOO");
    // Stage 2 saw stage 1's combined output via {{previous}} (the barrier held).
    expect(res.output).toContain("summarize:");
    expect(res.output).toContain("Q1 about FOO");
    expect(seen).toEqual([0, 1]); // onStage fired once per stage, in order
  });

  test("onEvent streams stage_start, per-task task_done, and stage_done in order", async () => {
    const wf: Workflow = {
      name: "t", description: "d", source: "project", path: "",
      stages: [
        { name: "fan", tasks: [{ prompt: "a" }, { prompt: "b" }] },
        { name: "join", tasks: [{ prompt: "c {{previous}}" }] },
      ],
    };
    const types: string[] = [];
    await runWorkflow(wf, {
      provider: echo as never, model: "x", tools: [], permission: perm(), promptUser: allow,
      input: "X", cwd: process.cwd(), onEvent: (e: WorkflowEvent) => types.push(e.type),
    });
    // Stage 1: start, two task_done (parallel), done. Stage 2: start, one task_done, done.
    expect(types).toEqual([
      "stage_start", "task_done", "task_done", "stage_done",
      "stage_start", "task_done", "stage_done",
    ]);
  });

  test("a sub-agent's tool calls surface as task_activity (live progress)", async () => {
    // A provider scripted to use a tool on turn 1, then report on turn 2 — so the
    // sub-agent's interior tool call must bubble up as a task_activity event.
    let turn = 0;
    const toolProvider = {
      name: "tp", id: "tp", models: () => ["x"],
      async *stream() {
        if (turn++ === 0) {
          yield { type: "tool_call", call: { id: "Grep-1", name: "Grep", arguments: {} } };
          yield { type: "end", reason: "tool_use" };
        } else {
          yield { type: "text_delta", delta: "found it" };
          yield { type: "end", reason: "end_turn" };
        }
      },
    };
    const grep: Tool = {
      name: "Grep", description: "stub", permission: "safe",
      schema: z.object({}).passthrough(),
      async run() { return { ok: true, output: "match" }; },
    };
    const wf: Workflow = {
      name: "t", description: "d", source: "dynamic", path: "(dynamic)",
      stages: [{ name: "look", tasks: [{ agent: "explore", prompt: "search {{input}}" }] }],
    };
    const activity: string[] = [];
    await runWorkflow(wf, {
      provider: toolProvider as never, model: "x", tools: [grep], permission: perm(), promptUser: allow,
      input: "X", cwd: process.cwd(),
      onEvent: (e: WorkflowEvent) => { if (e.type === "task_activity") activity.push(e.label); },
    });
    expect(activity).toContain("→ Grep");
  });
});

// A provider that ignores its input and returns a fixed reply — lets us feed
// composeWorkflow() a canned "plan" and assert how it's parsed/validated.
function planner(reply: string) {
  return {
    name: "p", id: "p", models: () => ["x"],
    async *stream() {
      yield { type: "text_delta", delta: reply };
      yield { type: "end", reason: "end_turn" };
    },
  };
}

describe("composeWorkflow (dynamic /ultraplan)", () => {
  test("parses a clean JSON plan into a runnable dynamic workflow", async () => {
    const reply = JSON.stringify({
      description: "investigate then summarize",
      stages: [
        { name: "look", tasks: [{ agent: "explore", prompt: "find {{input}}" }] },
        { name: "sum", tasks: [{ prompt: "summarize {{previous}}" }] },
      ],
    });
    const wf = await composeWorkflow(planner(reply) as never, "x", "how does auth work?", process.cwd());
    expect(wf.source).toBe("dynamic");
    expect(wf.name).toBe("ultraplan");
    expect(wf.stages.length).toBe(2);
    expect(wf.stages[0]!.tasks[0]!.agent).toBe("explore");
  });

  test("tolerates code fences and surrounding prose around the JSON", async () => {
    const reply = "Here is the plan:\n```json\n" +
      JSON.stringify({ description: "x", stages: [{ tasks: [{ prompt: "do {{input}}" }] }] }) +
      "\n```\nThat should work.";
    const wf = await composeWorkflow(planner(reply) as never, "x", "task", process.cwd());
    expect(wf.stages.length).toBe(1);
    expect(wf.description).toBe("x");
  });

  test("throws when the model returns no JSON object", async () => {
    await expect(composeWorkflow(planner("I cannot help with that.") as never, "x", "t", process.cwd()))
      .rejects.toThrow(/no JSON object|could not compose/);
  });

  test("throws when the composed JSON fails the schema (missing stages)", async () => {
    const reply = JSON.stringify({ description: "no stages here" });
    await expect(composeWorkflow(planner(reply) as never, "x", "t", process.cwd()))
      .rejects.toThrow(/invalid/);
  });
});

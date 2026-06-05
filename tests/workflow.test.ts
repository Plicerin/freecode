// Workflows (ROADMAP Tier A). Covers discovery + schema validation, the shipped
// example workflow, and the engine: parallel within a stage, barrier between
// stages, and {{input}}/{{previous}} interpolation feeding fan-out → synthesis.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkflows, getWorkflow, runWorkflow, type Workflow } from "../src/agent/workflow";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";

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
});

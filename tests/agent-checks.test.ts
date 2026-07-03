// The signature feature's coverage for the case real-world dogfooding exposed:
// a monorepo/nested project whose checks live in a subdir the auto-gate's cwd
// can't see. When the AGENT runs a build/test/typecheck itself and it passes,
// that real signal must count toward the confidence badge — not be ignored just
// because freecode's auto-gate didn't fire. See recognizeCheckCommand + the
// agentChecks wiring in src/agent/loop.ts.
import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { runAgentLoop, recognizeCheckCommand, type AgentEvent, type TurnLedger } from "../src/agent/loop";
import { nextConfidence, type Confidence } from "../src/tui/confidence";
import { createPermissionEngine } from "../src/permissions/modes";
import type { Tool } from "../src/tools/types";

describe("recognizeCheckCommand", () => {
  test("recognizes real check commands", () => {
    for (const c of ["npm run build", "npm run typecheck", "pnpm test", "yarn run lint",
      "bun run check", "tsc --noEmit", "npx tsc", "pytest -q", "python -m pytest",
      "cargo check", "cargo test", "go test ./...", "go build ./...", "make check",
      "eslint .", "ruff check src", "npx vitest run"]) {
      expect(recognizeCheckCommand(c)).not.toBeNull();
    }
  });
  test("recognizes colon-scoped and hyphen-scoped workflow scripts (tauri use case)", () => {
    // The case the handover flagged: `npm run tauri:build` is a real check for
    // a Tauri app, broader than the strict verb dictionary.
    for (const c of ["npm run tauri:build", "npm run build:prod", "pnpm test:unit",
      "yarn run type-check:strict", "bun run lint:fix", "npm run coverage:unit",
      "pnpm validate:configs"]) {
      expect(recognizeCheckCommand(c)).not.toBeNull();
    }
  });
  test("rejects non-checks (dev servers, one-off scripts, reads)", () => {
    for (const c of ["npm run dev", "npm run start", "npm install", "git status",
      "ls -la", "node scripts/seed.js", "echo hi", "cat package.json", ""]) {
      expect(recognizeCheckCommand(c)).toBeNull();
    }
  });
  test("normalizes to a stable short label", () => {
    expect(recognizeCheckCommand("cargo test --all-features")).toBe("cargo test");
    expect(recognizeCheckCommand("  GO TEST ./pkg/...  ")).toBe("go test");
    expect(recognizeCheckCommand("npm run build --workspace=web")).toBe("npm run build");
    expect(recognizeCheckCommand("npm run tauri:build")).toBe("npm run tauri:build");
  });
});

// ---- end-to-end: a check the agent runs itself credits the ledger ----

const editTool = (onRun?: () => void): Tool => ({
  name: "FileEdit", description: "stub", permission: "safe",
  schema: z.object({ path: z.string() }),
  async run() { onRun?.(); return { ok: true, output: "edited" }; },
});
// Bash stub whose exit status we control, so we don't depend on a real toolchain.
const bashTool = (ok: boolean): Tool => ({
  name: "Bash", description: "stub", permission: "safe",
  schema: z.object({ command: z.string() }),
  async run() { return { ok, output: ok ? "" : "exit code 1", error: ok ? undefined : "exit code 1" }; },
});
// Bash stub that returns a different exit status per successive call.
const bashSeq = (results: boolean[]): Tool => {
  let i = 0;
  return {
    name: "Bash", description: "stub", permission: "safe",
    schema: z.object({ command: z.string() }),
    async run() { const ok = results[Math.min(i, results.length - 1)]!; i++; return { ok, output: ok ? "" : "exit code 1", error: ok ? undefined : "exit code 1" }; },
  };
};

const call = (name: string, args: Record<string, unknown>) => ({ type: "tool_call", call: { id: `${name}-1`, name, arguments: args } });
const text = (delta: string) => ({ type: "text_delta", delta });

function scripted(turns: Array<Array<Record<string, unknown>>>): unknown {
  let i = 0;
  return { name: "s", id: "s", models: () => ["x"], async *stream() { for (const e of turns[i++] ?? []) yield e; } };
}

async function run(tools: Tool[], turns: Array<Array<Record<string, unknown>>>): Promise<TurnLedger> {
  const events: AgentEvent[] = [];
  await runAgentLoop({
    provider: scripted(turns) as never, tools,
    permission: createPermissionEngine("bypass", (async () => "allow") as never),
    promptUser: (async () => "allow") as never,
    model: "x", history: [{ role: "user", content: "do it" }],
    onEvent: (e: AgentEvent) => events.push(e),
    verifyMode: "off", maxTurns: 10, // auto-gate OFF — only the agent's own check exists
  } as never);
  return (events.filter((e) => e.type === "ledger").pop()?.ledger) ?? { verified: [], observed: [], believed: [] };
}

describe("agent-run checks credit confidence (auto-gate off, nested-project case)", () => {
  test("edit then a passing build → verified (agent-run), no 'unverified' debt", async () => {
    const led = await run([bashTool(true), editTool()], [
      [call("FileEdit", { path: "f.ts" }), call("Bash", { command: "npm run build" })],
      [text("done")],
    ]);
    expect(led.verified.some((v) => /npm run build passed \(agent-run\)/.test(v))).toBe(true);
    expect(led.believed).toEqual([]);
    expect(nextConfidence("unchecked" as Confidence, led)).toBe("verified");
  });

  test("a passing check that ran BEFORE the last edit is stale → not credited", async () => {
    // build passes, THEN we edit again — the green no longer describes current state.
    const led = await run([bashTool(true), editTool()], [
      [call("Bash", { command: "npm run build" }), call("FileEdit", { path: "f.ts" })],
      [text("done")],
    ]);
    expect(led.verified).toEqual([]);
    expect(led.believed.some((b) => /without running checks/.test(b))).toBe(true);
    expect(nextConfidence("unchecked" as Confidence, led)).toBe("unverified");
  });

  test("edit then a FAILING check → 'checks failing', confidence failing", async () => {
    const led = await run([bashTool(false), editTool()], [
      [call("FileEdit", { path: "f.ts" }), call("Bash", { command: "npm test" })],
      [text("done")],
    ]);
    expect(led.verified).toEqual([]);
    expect(led.believed.some((b) => /failing/.test(b))).toBe(true);
    expect(nextConfidence("unchecked" as Confidence, led)).toBe("failing");
  });

  // Regression for the false-green caught in the activity log (2026-06-05 03:11):
  // `tests PASS, PASS, FAIL` in one turn must NOT report "tests passed".
  test("same check passing then FAILING (no edit between) → latest outcome wins, not green", async () => {
    const led = await run([bashSeq([true, true, false])], [
      [call("Bash", { command: "npm test" }), call("Bash", { command: "npm test" }), call("Bash", { command: "npm test" })],
      [text("done")],
    ]);
    expect(led.verified).toEqual([]); // the stale pass must NOT survive the later fail
    expect(led.believed.some((b) => /failing/.test(b))).toBe(true);
    expect(nextConfidence("verified" as Confidence, led)).toBe("failing");
  });

  test("a failing check dominates a sibling passing check (build passes, tests fail) → failing", async () => {
    const led = await run([bashSeq([true, false])], [
      [call("Bash", { command: "npm run build" }), call("Bash", { command: "npm test" })],
      [text("done")],
    ]);
    expect(led.verified.some((v) => /npm run build passed/.test(v))).toBe(true); // the pass is still recorded (a true fact)…
    expect(led.believed.some((b) => /failing/.test(b))).toBe(true); // …but the failure dominates
    expect(nextConfidence("unchecked" as Confidence, led)).toBe("failing"); // badge is NOT green
  });

  test("a non-check command (npm run dev) does NOT count as verification", async () => {
    const led = await run([bashTool(true), editTool()], [
      [call("FileEdit", { path: "f.ts" }), call("Bash", { command: "npm run dev" })],
      [text("done")],
    ]);
    expect(led.verified).toEqual([]);
    expect(led.believed.some((b) => /without running checks/.test(b))).toBe(true);
  });
});

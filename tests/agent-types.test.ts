// Subagent types + /agents (ROADMAP Tier A). Covers: built-ins resolve, project
// agents load from .freecode/agents and override built-ins, a typed sub-agent is
// restricted to its tool allowlist, and an unknown type fails cleanly.
import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentTypes, getAgentType } from "../src/agent/agent-types";
import { runSubAgent } from "../src/agent/subagent";
import { createAgentTool } from "../src/tools/agent";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Tool } from "../src/tools/types";

const allow = (async () => "allow") as ApprovalCallback;
const perm = () => createPermissionEngine("bypass");

function scripted(turns: Array<Array<Record<string, unknown>>>): unknown {
  let i = 0;
  return { name: "s", id: "s", models: () => ["x"], async *stream() { for (const e of turns[i++] ?? []) yield e; } };
}
const text = (delta: string) => ({ type: "text_delta", delta });
const call = (name: string, args: Record<string, unknown>) => ({ type: "tool_call", call: { id: `${name}-1`, name, arguments: args } });
function probe(name: string): Tool & { ran: boolean } {
  const t = { name, description: "stub", permission: "safe" as const, ran: false, schema: z.object({}).passthrough(), async run() { t.ran = true; return { ok: true, output: `${name} ok` }; } };
  return t;
}

describe("agent-type resolution", () => {
  test("built-ins are present with expected restrictions", () => {
    const names = resolveAgentTypes(mkdtempSync(join(tmpdir(), "fc-noagents-"))).map((t) => t.name);
    expect(names).toContain("general");
    expect(names).toContain("explore");
    expect(names).toContain("code-reviewer");
    expect(getAgentType("general", process.cwd())?.tools).toBeUndefined(); // full access
    expect(getAgentType("explore", process.cwd())?.tools).toEqual(["FileRead", "Glob", "Grep"]); // read-only
  });

  test("a project agent loads from .freecode/agents and overrides a built-in", () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-agents-"));
    mkdirSync(join(dir, ".freecode", "agents"), { recursive: true });
    writeFileSync(join(dir, ".freecode", "agents", "doc-writer.md"),
      "---\ndescription: writes docs\ntools: FileRead, FileWrite\n---\nYou write documentation.");
    writeFileSync(join(dir, ".freecode", "agents", "explore.md"),
      "---\ndescription: my custom explore\n---\nCustom explore prompt.");
    const types = resolveAgentTypes(dir);
    const doc = types.find((t) => t.name === "doc-writer");
    expect(doc?.source).toBe("project");
    expect(doc?.tools).toEqual(["FileRead", "FileWrite"]);
    const explore = types.find((t) => t.name === "explore");
    expect(explore?.source).toBe("project"); // project overrides the built-in
    expect(explore?.description).toBe("my custom explore");
  });
});

describe("typed dispatch enforces the tool allowlist", () => {
  test("an explore sub-agent cannot reach a write tool", async () => {
    const fileWrite = probe("FileWrite");
    const fileRead = probe("FileRead");
    const explore = getAgentType("explore", process.cwd())!;
    await runSubAgent({
      provider: scripted([
        [call("FileWrite", { path: "x", content: "y" })], // explore tries to write…
        [text("could not write; here is what I found instead")],
      ]) as never,
      model: "x", tools: [fileRead, fileWrite, probe("Bash")], permission: perm(), promptUser: allow,
      description: "look", prompt: "explore x", agentType: explore,
    });
    expect(fileWrite.ran).toBe(false); // …but FileWrite isn't in its allowlist, so it never runs
  });

  test("Agent tool rejects an unknown subagent_type", async () => {
    const tool = createAgentTool(() => ({
      provider: scripted([[text("noop")]]) as never,
      model: "x", tools: [probe("Bash")], permission: perm(), promptUser: allow,
    }));
    const res = await tool.run(
      { description: "x", prompt: "y", subagent_type: "nonexistent" } as never,
      { cwd: process.cwd(), signal: undefined as unknown as AbortSignal },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown subagent_type "nonexistent"/);
    expect(res.error).toMatch(/general/); // lists valid options
  });
});

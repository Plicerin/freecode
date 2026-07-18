// Self-improvement (ROADMAP Tier I). freecode watches its own session and
// proposes durable artifacts (rules → FREECODE.md, skills → .freecode/skills/),
// never written without consent. Tests pin the analyzer's parse/validate path
// (mock provider), the dedupe against existing skills, and that an accepted
// proposal lands on disk in the format the loaders already read.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeSession, applyProposal, dedupeProposals, transcriptFromMessages, safeSkillName,
  type Proposal,
} from "../src/agent/self-improve";
import { resolveSkills } from "../src/agent/skills";

// A provider that returns a fixed reply, so we can feed analyzeSession a canned plan.
function planner(reply: string) {
  return {
    name: "p", id: "p", models: () => ["x"],
    async *stream() {
      yield { type: "text_delta", delta: reply };
      yield { type: "end", reason: "end_turn" };
    },
  };
}

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  kind: "rule", name: "run-tests-first", description: "always verify before claiming done",
  body: "Run `bun test` and report the real result before saying a task is done.",
  evidence: ["USER: you said it passed but never ran the tests"], rationale: "prevents false-green",
  ...over,
});

describe("analyzeSession", () => {
  test("parses a clean proposals JSON from the model", async () => {
    const reply = JSON.stringify({ proposals: [proposal(), proposal({ kind: "skill", name: "release-flow", description: "cut a release" })] });
    const out = await analyzeSession(planner(reply) as never, "x", { transcript: "USER: ...\nASSISTANT: ..." });
    expect(out.length).toBe(2);
    expect(out[0]!.kind).toBe("rule");
    expect(out[1]!.kind).toBe("skill");
  });

  test("tolerates code fences and prose around the JSON", async () => {
    const reply = "Here is what I learned:\n```json\n" + JSON.stringify({ proposals: [proposal()] }) + "\n```\ndone.";
    const out = await analyzeSession(planner(reply) as never, "x", { transcript: "t" });
    expect(out.length).toBe(1);
  });

  test("returns [] when the model declines (no JSON)", async () => {
    const out = await analyzeSession(planner("Nothing worth saving here.") as never, "x", { transcript: "t" });
    expect(out).toEqual([]);
  });

  test("throws when JSON is present but fails the schema", async () => {
    const reply = JSON.stringify({ proposals: [{ kind: "rule", name: "x" }] }); // missing required fields
    await expect(analyzeSession(planner(reply) as never, "x", { transcript: "t" })).rejects.toThrow(/malformed/);
  });
});

describe("dedupeProposals", () => {
  test("drops a skill proposal whose name already exists, and collapses repeats", () => {
    const ps = [
      proposal({ kind: "skill", name: "release-flow" }),
      proposal({ kind: "skill", name: "release-flow" }), // exact repeat
      proposal({ kind: "rule", name: "keep-this" }),
    ];
    const out = dedupeProposals(ps, ["release-flow"]); // already have that skill
    expect(out.map((p) => p.name)).toEqual(["keep-this"]);
  });
});

describe("applyProposal", () => {
  test("writes a skill the existing loader can read back", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fc-learn-"));
    const r = applyProposal(proposal({ kind: "skill", name: "Release Flow!", description: "cut a release", body: "1. bump\n2. tag" }), cwd);
    expect(r.kind).toBe("skill");
    expect(existsSync(r.path)).toBe(true);
    const found = resolveSkills(cwd).find((s) => s.name === "release-flow");
    expect(found).toBeDefined();
    expect(found!.description).toBe("cut a release");
    expect(found!.body).toContain("bump");
  });

  test("refuses to clobber an existing skill", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fc-learn-"));
    applyProposal(proposal({ kind: "skill", name: "dup", body: "x" }), cwd);
    expect(() => applyProposal(proposal({ kind: "skill", name: "dup", body: "y" }), cwd)).toThrow(/already exists/);
  });

  test("appends a rule to FREECODE.md under a stable heading", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fc-learn-"));
    applyProposal(proposal({ kind: "rule", body: "Always run bun test before done." }), cwd);
    const md = readFileSync(join(cwd, "FREECODE.md"), "utf8");
    expect(md).toContain("Learned rules");
    expect(md).toContain("Always run bun test before done.");
    // A second rule appends under the same heading (only one heading).
    applyProposal(proposal({ kind: "rule", body: "Never echo secrets." }), cwd);
    const md2 = readFileSync(join(cwd, "FREECODE.md"), "utf8");
    expect(md2.match(/Learned rules/g)!.length).toBe(1);
    expect(md2).toContain("Never echo secrets.");
  });
});

describe("helpers", () => {
  test("transcriptFromMessages keeps user/assistant turns and keeps the most recent under the cap", () => {
    const t = transcriptFromMessages([
      { role: "system", content: "ignored" } as never,
      { role: "user", content: "hello there" } as never,
      { role: "assistant", content: "hi back" } as never,
    ]);
    expect(t).toContain("USER: hello there");
    expect(t).toContain("ASSISTANT: hi back");
    expect(t).not.toContain("ignored");
  });

  test("safeSkillName is kebab and traversal-safe", () => {
    expect(safeSkillName("../../etc/passwd")).not.toContain("/");
    expect(safeSkillName("Release Flow!")).toBe("release-flow");
  });
});

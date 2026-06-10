import { test, expect, describe } from "bun:test";
import { CONSULT_PROVIDERS, supervisorPrompt, consultBanner } from "../src/tui/consult";

describe("consult helpers", () => {
  test("offers implemented providers, never the unimplemented / mock ones", () => {
    expect(CONSULT_PROVIDERS).toContain("nim");
    expect(CONSULT_PROVIDERS).toContain("llama-server");
    expect(CONSULT_PROVIDERS).toContain("anthropic");
    for (const bad of ["bedrock", "vertex", "mock"]) {
      expect(CONSULT_PROVIDERS as readonly string[]).not.toContain(bad);
    }
  });

  test("supervisor prompt frames it as an independent critical reviewer with the task", () => {
    const p = supervisorPrompt("check the auth refactor for race conditions");
    expect(p).toMatch(/second|independent/i);
    expect(p).toMatch(/do not assume|critically/i);
    expect(p).toMatch(/verify against the actual code/i);
    expect(p).toContain("check the auth refactor for race conditions");
  });

  test("supervisor prompt has a sensible default task when none is given", () => {
    const p = supervisorPrompt("   ");
    expect(p).toMatch(/review the work so far/i); // doesn't leave the task blank
  });

  test("banner names the provider:model and the task", () => {
    expect(consultBanner("nim", "openai/gpt-oss-120b", "validate the fix")).toBe(
      "🧐 Consulting supervisor nim:openai/gpt-oss-120b — validate the fix",
    );
    expect(consultBanner("lmstudio", "gemma", "")).toBe("🧐 Consulting supervisor lmstudio:gemma");
  });
});

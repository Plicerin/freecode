import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildToolRegistry, toolListToSystemPrompt } from "../src/tools/registry";

const tools = buildToolRegistry();
const p = join(process.cwd(), "FREECODE.md");
afterEach(() => { if (existsSync(p)) rmSync(p); });

describe("project context file", () => {
  it("injects FREECODE.md into the system prompt", () => {
    writeFileSync(p, "Always use tabs, never spaces. Prefer fp-ts.");
    const sys = toolListToSystemPrompt(tools);
    expect(sys).toContain("Project context (from FREECODE.md)");
    expect(sys).toContain("Always use tabs, never spaces");
  });
  it("omits the section when no context file exists", () => {
    if (existsSync(p)) rmSync(p);
    const sys = toolListToSystemPrompt(tools);
    expect(sys).not.toContain("Project context (from");
  });
});

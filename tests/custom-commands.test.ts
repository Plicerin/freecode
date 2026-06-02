import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCustomCommands, expandCommand } from "../src/commands/custom-commands";

describe("expandCommand", () => {
  it("substitutes $ARGUMENTS and positional $1/$2", () => {
    expect(expandCommand("Review $ARGUMENTS please", "the auth module")).toBe("Review the auth module please");
    expect(expandCommand("Diff $1 against $2", "main feature")).toBe("Diff main against feature");
  });
  it("appends args when the template has no placeholder", () => {
    expect(expandCommand("Summarize the code", "src/x.ts")).toBe("Summarize the code\n\nsrc/x.ts");
  });
  it("leaves template alone with no args", () => {
    expect(expandCommand("Run the tests.", "")).toBe("Run the tests.");
  });
});

describe("loadCustomCommands", () => {
  it("loads project commands with frontmatter description", () => {
    const cwd = mkdtempSync(join(tmpdir(), "oc-cmd-"));
    mkdirSync(join(cwd, ".freecode", "commands"), { recursive: true });
    writeFileSync(join(cwd, ".freecode", "commands", "review.md"), "---\ndescription: Review a PR\n---\nReview $ARGUMENTS thoroughly.");
    const map = loadCustomCommands(cwd);
    const cmd = map.get("review");
    expect(cmd?.description).toBe("Review a PR");
    expect(cmd?.body).toBe("Review $ARGUMENTS thoroughly.");
    expect(cmd?.source).toBe("project");
  });
});

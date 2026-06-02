import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVerify, runVerify } from "../src/agent/verify";

describe("resolveVerify", () => {
  it("uses explicit config commands", () => {
    const p = resolveVerify("/x", ["echo a", "echo b"]);
    expect(p.source).toBe("config");
    expect(p.commands).toEqual(["echo a", "echo b"]);
  });
  it("auto-detects package.json typecheck+test with the right pm", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-vf-"));
    writeFileSync(join(dir, "bun.lock"), "");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "bun test", build: "x" } }));
    const p = resolveVerify(dir);
    expect(p.source).toBe("detected");
    expect(p.commands).toEqual(["bun run typecheck", "bun run test"]);
  });
  it("returns none when nothing is detectable", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-vf2-"));
    expect(resolveVerify(dir).source).toBe("none");
  });
});

describe("runVerify", () => {
  it("passes when all commands exit 0", async () => {
    const r = await runVerify({ commands: ["exit 0", "exit 0"], source: "config" }, process.cwd());
    expect(r.ok).toBe(true);
    expect(r.ranCommands.length).toBe(2);
  }, 30000);
  it("stops at the first failing command", async () => {
    const r = await runVerify({ commands: ["exit 0", "exit 2", "exit 0"], source: "config" }, process.cwd());
    expect(r.ok).toBe(false);
    expect(r.failedCommand).toBe("exit 2");
    expect(r.ranCommands).toEqual(["exit 0", "exit 2"]);
  }, 30000);
});

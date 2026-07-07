import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVerify, resolveQuickVerify, runVerify, isHomeDir, verifyCoversChanges } from "../src/agent/verify";

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

describe("isHomeDir", () => {
  it("true for the home dir (trailing slash tolerant), false for subdirs/tmp", () => {
    expect(isHomeDir(os.homedir())).toBe(true);
    expect(isHomeDir(os.homedir() + "/")).toBe(true);
    expect(isHomeDir(join(os.homedir(), "Documents"))).toBe(false);
    expect(isHomeDir(mkdtempSync(join(tmpdir(), "oc-hd-")))).toBe(false);
  });
});

describe("home-directory guard (the tic-tac-toe trap)", () => {
  it("refuses to auto-detect a check from ~ — a stray package.json there isn't the project", () => {
    // Even though this machine HAS a ~/package.json, auto-detection is off at home.
    expect(resolveVerify(os.homedir()).source).toBe("none");
    expect(resolveQuickVerify(os.homedir()).source).toBe("none");
  });
  it("but an explicit config command still applies at home (opt-in wins)", () => {
    expect(resolveVerify(os.homedir(), "echo hi").source).toBe("config");
    expect(resolveQuickVerify(os.homedir(), "echo hi").source).toBe("config");
  });
});

describe("verifyCoversChanges — a check only verifies files it compiles", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-scope-"));
  it("true when a compiled source file under root changed", () => {
    expect(verifyCoversChanges([join(root, "src", "app.ts")], root)).toBe(true);
  });
  it("FALSE when only a standalone .html changed (build never imports it)", () => {
    expect(verifyCoversChanges([join(root, "game.html")], root)).toBe(false);
  });
  it("false for other loose assets (.css/.md/.png) with no source", () => {
    expect(verifyCoversChanges([join(root, "style.css"), join(root, "notes.md")], root)).toBe(false);
  });
  it("false when the source file is OUTSIDE the check's root", () => {
    expect(verifyCoversChanges([join(tmpdir(), "elsewhere", "app.ts")], root)).toBe(false);
  });
  it("true when a change set mixes an asset with real source", () => {
    expect(verifyCoversChanges([join(root, "game.html"), join(root, "src", "main.tsx")], root)).toBe(true);
  });
  it("empty change set is not blocked", () => {
    expect(verifyCoversChanges([], root)).toBe(true);
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

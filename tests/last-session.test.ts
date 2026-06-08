// "Remember the last provider/model" — the store round-trips, and the loader uses
// it as the LOWEST-priority default (overridden by a flag/env, paired coherently
// with its own model).
import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLastSession, writeLastSession } from "../src/config/last-session";
import { loadConfig } from "../src/config/loader";

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), "fc-last-")), "last-session.json");
}
// Point profile/settings at non-existent files so only last-session + env matter.
const noFiles = (lastSessionPath: string) => ({
  profilePath: join(tmpdir(), "nope-profile.json"),
  settingsPath: join(tmpdir(), "nope-settings.json"),
  lastSessionPath,
});

describe("store", () => {
  test("round-trips provider + model; missing/corrupt → empty", () => {
    const p = tmp();
    writeLastSession({ provider: "anthropic", model: "claude-opus-4-8" }, p);
    expect(readLastSession(p)).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
    expect(readLastSession(join(tmpdir(), "does-not-exist.json"))).toEqual({});
  });
});

describe("loader precedence", () => {
  test("reopens the remembered provider/model when it has a usable key and nothing more explicit is set", () => {
    const p = tmp();
    writeLastSession({ provider: "anthropic", model: "claude-sonnet-4-6" }, p);
    const prevA = process.env.ANTHROPIC_API_KEY;
    const prevUse = process.env.CLAUDE_CODE_USE_OPENAI;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test"; // makes the remembered provider usable
    delete process.env.CLAUDE_CODE_USE_OPENAI; // no explicit env override
    try {
      const cfg = loadConfig({ flags: {}, ...noFiles(p) });
      expect(cfg.provider).toBe("anthropic"); // remembered, even if OPENAI_API_KEY also exists
      expect(cfg.model).toBe("claude-sonnet-4-6");
    } finally {
      if (prevA === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevA;
      if (prevUse !== undefined) process.env.CLAUDE_CODE_USE_OPENAI = prevUse;
    }
  });

  test("an explicit --provider flag overrides the remembered one", () => {
    const p = tmp();
    writeLastSession({ provider: "anthropic", model: "claude-sonnet-4-6" }, p);
    const cfg = loadConfig({ flags: { provider: "gemini", apiKey: "k" }, ...noFiles(p) });
    expect(cfg.provider).toBe("gemini");
    // The remembered model is NOT carried onto a different provider.
    expect(cfg.model).not.toBe("claude-sonnet-4-6");
  });

  test("a remembered model is ignored if it doesn't match the resolved provider", () => {
    const p = tmp();
    writeLastSession({ provider: "anthropic", model: "claude-sonnet-4-6" }, p);
    // Force openai via flag; the anthropic model must not leak onto it.
    const cfg = loadConfig({ flags: { provider: "openai", apiKey: "k" }, ...noFiles(p) });
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).not.toBe("claude-sonnet-4-6");
  });
});

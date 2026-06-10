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
    const r = readLastSession(p);
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.providers?.anthropic?.model).toBe("claude-opus-4-8"); // also in the per-provider map
    expect(readLastSession(join(tmpdir(), "does-not-exist.json"))).toEqual({});
  });

  test("round-trips a remembered base URL (remote endpoint)", () => {
    const p = tmp();
    writeLastSession({ provider: "lmstudio", model: "m", baseUrl: "https://host.ts.net/v1" }, p);
    const r = readLastSession(p);
    expect(r.baseUrl).toBe("https://host.ts.net/v1");
    expect(r.providers?.lmstudio?.baseUrl).toBe("https://host.ts.net/v1");
  });
});

describe("per-provider memory", () => {
  test("each provider keeps its OWN model/url across switches", () => {
    const p = tmp();
    const prev = process.env.LMSTUDIO_HOST; delete process.env.LMSTUDIO_HOST;
    try {
      // Use llama-server (remote URL), then switch to nim → nim is now last-used,
      // but the llama-server URL must NOT be wiped.
      writeLastSession({ provider: "llama-server", model: "local-model", baseUrl: "https://remote.ts.net/v1" }, p);
      writeLastSession({ provider: "nim", model: "qwen/qwen3" }, p);

      // --provider llama-server restores ITS remote URL (not the localhost default)…
      expect(loadConfig({ flags: { provider: "llama-server" }, ...noFiles(p) }).baseUrl).toBe("https://remote.ts.net/v1");
      // …and --provider nim restores ITS model.
      expect(loadConfig({ flags: { provider: "nim", apiKey: "k" }, ...noFiles(p) }).model).toBe("qwen/qwen3");

      // Both entries survive in the file; top-level tracks the last-used (nim).
      const r = readLastSession(p);
      expect(r.provider).toBe("nim");
      expect(r.providers?.["llama-server"]?.baseUrl).toBe("https://remote.ts.net/v1");
      expect(r.providers?.nim?.model).toBe("qwen/qwen3");
    } finally {
      if (prev === undefined) delete process.env.LMSTUDIO_HOST; else process.env.LMSTUDIO_HOST = prev;
    }
  });
});

describe("base-URL memory", () => {
  test("remembered base URL applies to the same provider; flag overrides; other provider ignores it", () => {
    const p = tmp();
    const prev = process.env.LMSTUDIO_HOST;
    delete process.env.LMSTUDIO_HOST;
    try {
      writeLastSession({ provider: "lmstudio", model: "m", baseUrl: "https://remote.ts.net/v1" }, p);
      // same provider → remembered URL wins over the localhost default
      expect(loadConfig({ flags: { provider: "lmstudio" }, ...noFiles(p) }).baseUrl).toBe("https://remote.ts.net/v1");
      // explicit --base-url flag still wins
      expect(loadConfig({ flags: { provider: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" }, ...noFiles(p) }).baseUrl).toBe("http://127.0.0.1:1234/v1");
      // a different provider does NOT inherit the lmstudio URL
      expect(loadConfig({ flags: { provider: "ollama" }, ...noFiles(p) }).baseUrl).not.toBe("https://remote.ts.net/v1");
    } finally {
      if (prev === undefined) delete process.env.LMSTUDIO_HOST; else process.env.LMSTUDIO_HOST = prev;
    }
  });
});

describe("per-folder (cwd) memory", () => {
  test("each folder reopens its OWN last provider/model, not the global last", () => {
    const p = tmp();
    const A = "/proj/A", B = "/proj/B";
    writeLastSession({ provider: "llama-server", model: "local-model" }, p, A);
    writeLastSession({ provider: "nim", model: "z-ai/glm-5.1" }, p, B);
    // A then switches to openrouter (now the global most-recent) — B must be untouched.
    writeLastSession({ provider: "openrouter", model: "google/gemma-4-31b-it:free" }, p, A);

    expect(readLastSession(p, B).provider).toBe("nim"); // NOT the global openrouter
    expect(readLastSession(p, B).model).toBe("z-ai/glm-5.1");
    expect(readLastSession(p, A).provider).toBe("openrouter"); // A's own latest
    // A brand-new folder falls back to the global most-recent.
    expect(readLastSession(p, "/proj/NEVER-SEEN").provider).toBe("openrouter");
  });

  test("loadConfig resolves the folder's remembered provider, not the global one", () => {
    const p = tmp();
    const B = "/proj/B2";
    writeLastSession({ provider: "ollama", model: "llama3.2" }, p, B);
    writeLastSession({ provider: "openrouter", model: "x" }, p, "/proj/A2"); // newer global
    // Resolving in folder B → its own ollama, not the global openrouter.
    const cfg = loadConfig({ flags: {}, ...noFiles(p), cwd: B });
    expect(cfg.provider).toBe("ollama");
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

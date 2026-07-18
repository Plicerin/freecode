// OpenRouter provider wiring — the unified OpenAI-compatible gateway. Env auto-
// detection, config resolution (key + namespaced default model + gateway URL),
// and that buildProvider yields an OpenRouter client. Env keys are cleared per
// test (and restored) so detection order doesn't depend on the host's real keys.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { detectProviderFromEnv } from "../src/utils/env";
import { loadConfig } from "../src/config/loader";
import { buildProvider } from "../src/providers/registry";

const KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN",
  "OPENROUTER_API_KEY", "NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY", "OPENROUTER_BASE_URL",
];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("OpenRouter provider", () => {
  test("env auto-detect picks openrouter from OPENROUTER_API_KEY", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    expect(detectProviderFromEnv()).toBe("openrouter");
  });

  test("config resolves openrouter: key, namespaced default model, gateway URL", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    const cfg = loadConfig({ flags: { provider: "openrouter" } as never });
    expect(cfg.provider).toBe("openrouter");
    expect(cfg.apiKey).toBeTruthy();
    expect(cfg.model).toBe("anthropic/claude-3.7-sonnet"); // namespaced slug
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  test("buildProvider returns an OpenRouter OpenAI-compat client", () => {
    const p = buildProvider({ provider: "openrouter", apiKey: "k", baseUrl: undefined, model: "openai/gpt-4o" } as never);
    expect((p as { id?: string }).id).toBe("openrouter");
    expect(p.name).toBe("OpenRouter");
  });
});

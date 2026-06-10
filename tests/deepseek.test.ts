// DeepSeek provider wiring — OpenAI-compatible (deepseek-chat / deepseek-reasoner).
// Env auto-detection, config resolution (key + default model + base URL), pricing
// + context window, and that buildProvider yields a DeepSeek client. Env keys are
// cleared per test (and restored) so detection order doesn't depend on host keys.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { detectProviderFromEnv } from "../src/utils/env";
import { loadConfig } from "../src/config/loader";
import { buildProvider } from "../src/providers/registry";
import { priceFor, contextWindowFor } from "../src/agent/pricing";

const KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN",
  "OPENROUTER_API_KEY", "NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY", "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("DeepSeek provider", () => {
  test("env auto-detect picks deepseek from DEEPSEEK_API_KEY", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
    expect(detectProviderFromEnv()).toBe("deepseek");
  });

  test("config resolves deepseek: key, default model, base URL", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
    const cfg = loadConfig({ flags: { provider: "deepseek" } as never });
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.apiKey).toBeTruthy();
    expect(cfg.model).toBe("deepseek-chat");
    expect(cfg.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  test("DEEPSEEK_BASE_URL overrides the default endpoint", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
    process.env.DEEPSEEK_BASE_URL = "https://proxy.example.com/v1";
    expect(loadConfig({ flags: { provider: "deepseek" } as never }).baseUrl).toBe("https://proxy.example.com/v1");
  });

  test("buildProvider returns a DeepSeek OpenAI-compat client", () => {
    const p = buildProvider({ provider: "deepseek", apiKey: "k", baseUrl: undefined, model: "deepseek-chat" } as never);
    expect((p as { id?: string }).id).toBe("deepseek");
    expect(p.name).toBe("DeepSeek");
  });

  test("pricing + context window resolve for both deepseek models", () => {
    expect(priceFor("deepseek-chat", "deepseek").output).toBe(1.1);
    expect(priceFor("deepseek-reasoner", "deepseek").output).toBe(2.19); // reasoner row wins
    expect(contextWindowFor("deepseek-chat")).toBe(64_000);
  });
});

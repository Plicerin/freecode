import { describe, it, expect } from "bun:test";
import { loadConfig } from "../src/config/loader";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("loadConfig priority", () => {
  it("CLI > profile > env > settings (V5)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-cfg-"));
    const profile = join(dir, ".openclaude-profile.json");
    const settings = join(dir, "settings.json");
    writeFileSync(profile, JSON.stringify({ provider: "openai", model: "from-profile" }));
    writeFileSync(settings, JSON.stringify({ model: "from-settings", theme: "light" }));

    const env: Record<string, string | undefined> = { ...process.env as Record<string, string | undefined>, ANTHROPIC_API_KEY: "env-key" };

    const prev: Record<string, string | undefined> = { ...process.env as Record<string, string | undefined> };
    for (const k of Object.keys(env)) (process.env as Record<string, string | undefined>)[k] = env[k];

    try {
      const cfg = loadConfig({
        flags: { model: "from-cli" },
        profilePath: profile,
        settingsPath: settings,
      });
      expect(cfg.model).toBe("from-cli");
      expect(cfg.theme).toBe("light");
      expect(cfg.provider).toBe("openai");
      expect(cfg.source.model).toBe("cli");
    } finally {
      for (const k of Object.keys(prev)) (process.env as Record<string, string | undefined>)[k] = prev[k];
    }
  });

  it("local server *_HOST env is a base URL, never the api key", () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = { LLAMA_SERVER_HOST: env.LLAMA_SERVER_HOST };
    env.LLAMA_SERVER_HOST = "http://localhost:8888/v1";
    try {
      const cfg = loadConfig({ flags: { provider: "llama-server" } });
      expect(cfg.baseUrl).toBe("http://localhost:8888/v1"); // host feeds the base URL…
      expect(cfg.apiKey).toBeUndefined();                   // …NOT the Authorization header
    } finally {
      if (prev.LLAMA_SERVER_HOST === undefined) delete env.LLAMA_SERVER_HOST;
      else env.LLAMA_SERVER_HOST = prev.LLAMA_SERVER_HOST;
    }
  });
});

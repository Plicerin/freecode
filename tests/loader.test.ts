import { describe, it, expect } from "bun:test";
import { loadConfig } from "../src/config/loader";
import { writeLastSession } from "../src/config/last-session";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run a body with some env vars forced, restoring the prior values after.
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const env = process.env as Record<string, string | undefined>;
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = env[k]; if (vars[k] === undefined) delete env[k]; else env[k] = vars[k]!; }
  try { body(); } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete env[k]; else env[k] = prev[k]!; }
  }
}

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
    withEnv({ LLAMA_SERVER_HOST: "http://localhost:8888/v1" }, () => {
      const cfg = loadConfig({ flags: { provider: "llama-server" } });
      expect(cfg.baseUrl).toBe("http://localhost:8888/v1"); // host feeds the base URL…
      expect(cfg.apiKey).toBeUndefined();                   // …NOT the Authorization header
    });
  });

  it("restores the last-used LOCAL endpoint even when *_HOST env points elsewhere", () => {
    // The reported bug: a persistent LLAMA_SERVER_HOST in the shell snapped every
    // launch back to itself, wiping the endpoint you actually last picked.
    const dir = mkdtempSync(join(tmpdir(), "oc-ls-"));
    const lsPath = join(dir, "last-session.json");
    const cwd = "C:\\proj\\alpha";
    writeLastSession({ provider: "llama-server", model: "atomic-35b", baseUrl: "http://127.0.0.1:8888/v1" }, lsPath, cwd);
    withEnv({ LLAMA_SERVER_HOST: "https://elsewhere.ts.net/v1" }, () => {
      const cfg = loadConfig({ flags: { provider: "llama-server" }, lastSessionPath: lsPath, cwd });
      expect(cfg.baseUrl).toBe("http://127.0.0.1:8888/v1"); // remembered wins over the env default
    });
  });

  it("uses the *_HOST env as the default when a LOCAL provider has no remembered endpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-ls-"));
    const lsPath = join(dir, "last-session.json"); // empty — never written
    withEnv({ LLAMA_SERVER_HOST: "https://default-box.ts.net/v1" }, () => {
      const cfg = loadConfig({ flags: { provider: "llama-server" }, lastSessionPath: lsPath, cwd: "C:\\proj\\fresh" });
      expect(cfg.baseUrl).toBe("https://default-box.ts.net/v1"); // no memory → env is the default
    });
  });

  it("an explicit --base-url still beats a remembered LOCAL endpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-ls-"));
    const lsPath = join(dir, "last-session.json");
    const cwd = "C:\\proj\\beta";
    writeLastSession({ provider: "llama-server", model: "m", baseUrl: "http://127.0.0.1:8888/v1" }, lsPath, cwd);
    const cfg = loadConfig({ flags: { provider: "llama-server", baseUrl: "http://127.0.0.1:9999/v1" }, lastSessionPath: lsPath, cwd });
    expect(cfg.baseUrl).toBe("http://127.0.0.1:9999/v1");
  });

  it("CLOUD base-URL env stays a deliberate override (env beats remembered)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-ls-"));
    const lsPath = join(dir, "last-session.json");
    const cwd = "C:\\proj\\gamma";
    writeLastSession({ provider: "openrouter", model: "m", baseUrl: "https://remembered.example/v1" }, lsPath, cwd);
    withEnv({ OPENROUTER_BASE_URL: "https://override.example/v1", OPENROUTER_API_KEY: "k" }, () => {
      const cfg = loadConfig({ flags: { provider: "openrouter" }, lastSessionPath: lsPath, cwd });
      expect(cfg.baseUrl).toBe("https://override.example/v1"); // cloud env override wins
    });
  });
});

describe("loadConfig memory (cross-session / Honcho)", () => {
  // Isolate from the real ~/.freecode/settings.json by always passing a settings file.
  function withSettings(memory: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "oc-mem-"));
    const p = join(dir, "settings.json");
    writeFileSync(p, JSON.stringify(memory === undefined ? {} : { memory }));
    return p;
  }

  it("is OFF by default (no settings, no env)", () => {
    withEnv({ FREECODE_HONCHO_URL: undefined, HONCHO_URL: undefined }, () => {
      const cfg = loadConfig({ flags: {}, settingsPath: withSettings(undefined) });
      expect(cfg.memory?.enabled).toBe(false);
      expect(cfg.memory?.baseUrl).toBeUndefined();
      expect(cfg.memory?.workspace).toBe("freecode"); // defaults present even when off
      expect(cfg.memory?.peer).toBe("user");
    });
  });

  it("turns ON with a settings baseUrl and fills workspace/peer defaults", () => {
    withEnv({ FREECODE_HONCHO_URL: undefined, HONCHO_URL: undefined }, () => {
      const cfg = loadConfig({ flags: {}, settingsPath: withSettings({ baseUrl: "http://box:8100" }) });
      expect(cfg.memory?.enabled).toBe(true);
      expect(cfg.memory?.baseUrl).toBe("http://box:8100");
      expect(cfg.memory?.workspace).toBe("freecode");
      expect(cfg.memory?.peer).toBe("user");
    });
  });

  it("reads the base URL from FREECODE_HONCHO_URL when settings has none", () => {
    withEnv({ FREECODE_HONCHO_URL: "http://env-box:8100", HONCHO_URL: undefined }, () => {
      const cfg = loadConfig({ flags: {}, settingsPath: withSettings(undefined) });
      expect(cfg.memory?.enabled).toBe(true);
      expect(cfg.memory?.baseUrl).toBe("http://env-box:8100");
    });
  });

  it("an explicit enabled:false disables it even with a baseUrl present", () => {
    withEnv({ FREECODE_HONCHO_URL: undefined, HONCHO_URL: undefined }, () => {
      const cfg = loadConfig({ flags: {}, settingsPath: withSettings({ baseUrl: "http://box:8100", enabled: false }) });
      expect(cfg.memory?.enabled).toBe(false);
      expect(cfg.memory?.baseUrl).toBe("http://box:8100"); // still resolved, just not active
    });
  });

  it("honours a custom workspace and peer from settings", () => {
    withEnv({ FREECODE_HONCHO_URL: undefined, HONCHO_URL: undefined }, () => {
      const cfg = loadConfig({ flags: {}, settingsPath: withSettings({ baseUrl: "http://box:8100", workspace: "fc-dev", peer: "vrock" }) });
      expect(cfg.memory?.workspace).toBe("fc-dev");
      expect(cfg.memory?.peer).toBe("vrock");
    });
  });
});

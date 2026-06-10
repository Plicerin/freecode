// A local model server's *_HOST env var is a LISTEN spec, not a connect target:
// OLLAMA_HOST=0.0.0.0:11434 means "bind all interfaces", and 0.0.0.0 / :: can't
// be dialed by a client. freecode must add a missing scheme and rewrite a
// bind-all host to loopback — while leaving a real LAN IP/hostname alone.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeLocalBaseUrl, loadConfig } from "../src/config/loader";

describe("normalizeLocalBaseUrl", () => {
  test("0.0.0.0 → loopback, scheme added", () => {
    expect(normalizeLocalBaseUrl("0.0.0.0:11434")).toBe("http://127.0.0.1:11434");
    expect(normalizeLocalBaseUrl("http://0.0.0.0:11434")).toBe("http://127.0.0.1:11434");
  });
  test("IPv6 bind-all → loopback", () => {
    expect(normalizeLocalBaseUrl("http://[::]:11434")).toBe("http://127.0.0.1:11434");
  });
  test("scheme-less loopback/host just gets http://", () => {
    expect(normalizeLocalBaseUrl("127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(normalizeLocalBaseUrl("localhost:1234")).toBe("http://localhost:1234");
  });
  test("a real LAN IP or hostname is left intact (only the scheme is added)", () => {
    expect(normalizeLocalBaseUrl("192.168.1.50:11434")).toBe("http://192.168.1.50:11434");
    expect(normalizeLocalBaseUrl("https://box.tail.ts.net/v1")).toBe("https://box.tail.ts.net/v1");
  });
  test("trailing slashes trimmed; junk returned as-is", () => {
    expect(normalizeLocalBaseUrl("http://0.0.0.0:11434/")).toBe("http://127.0.0.1:11434");
    expect(normalizeLocalBaseUrl("")).toBe("");
  });
});

describe("loadConfig applies it for local providers (the reported bug)", () => {
  const noFiles = (p: string) => ({
    profilePath: join(tmpdir(), "nope-profile.json"),
    settingsPath: join(tmpdir(), "nope-settings.json"),
    lastSessionPath: p,
  });
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.OLLAMA_HOST; });
  afterEach(() => { if (saved === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = saved; });

  test("OLLAMA_HOST=0.0.0.0:11434 resolves to a dialable loopback endpoint", () => {
    process.env.OLLAMA_HOST = "0.0.0.0:11434";
    const p = join(mkdtempSync(join(tmpdir(), "fc-ep-")), "last.json");
    expect(loadConfig({ flags: { provider: "ollama" }, ...noFiles(p) }).baseUrl).toBe("http://127.0.0.1:11434");
  });

  test("a cloud provider's URL is NOT touched by the local normalization", () => {
    const p = join(mkdtempSync(join(tmpdir(), "fc-ep-")), "last.json");
    const cfg = loadConfig({ flags: { provider: "deepseek", apiKey: "k" }, ...noFiles(p) });
    expect(cfg.baseUrl).toBe("https://api.deepseek.com/v1");
  });
});

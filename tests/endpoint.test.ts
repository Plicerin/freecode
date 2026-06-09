import { test, expect, describe } from "bun:test";
import { isRemoteHost, isLanModelEndpoint } from "../src/tui/endpoint";

describe("isRemoteHost", () => {
  test("localhost variants are NOT remote", () => {
    expect(isRemoteHost("http://127.0.0.1:1234/v1")).toBe(false);
    expect(isRemoteHost("http://localhost:8080")).toBe(false);
    expect(isRemoteHost("http://0.0.0.0:8080/v1")).toBe(false);
    expect(isRemoteHost(undefined)).toBe(false);
    expect(isRemoteHost("not a url")).toBe(false);
  });
  test("a LAN/Tailscale host IS remote", () => {
    expect(isRemoteHost("http://192.168.1.50:8080/v1")).toBe(true);
    expect(isRemoteHost("https://desktop-0fh88mm.tail989c2.ts.net/v1")).toBe(true);
    expect(isRemoteHost("http://100.120.85.55:8080")).toBe(true);
  });
});

describe("isLanModelEndpoint", () => {
  test("badges a local-server provider pointed at a remote host", () => {
    expect(isLanModelEndpoint("llama-server", "https://host.ts.net/v1")).toBe(true);
    expect(isLanModelEndpoint("lmstudio", "http://192.168.1.50:1234/v1")).toBe(true);
  });
  test("no badge for localhost or for cloud providers", () => {
    expect(isLanModelEndpoint("lmstudio", "http://127.0.0.1:1234/v1")).toBe(false);
    expect(isLanModelEndpoint("openrouter", "https://openrouter.ai/api/v1")).toBe(false);
    expect(isLanModelEndpoint("anthropic", undefined)).toBe(false);
  });
});

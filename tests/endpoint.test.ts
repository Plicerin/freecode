import { test, expect, describe } from "bun:test";
import { isRemoteHost, isLanModelEndpoint, endpointHostLabel } from "../src/tui/endpoint";

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

describe("endpointHostLabel — tells two servers of the same kind apart", () => {
  test("strips the Tailscale/MagicDNS suffix to the first label", () => {
    expect(endpointHostLabel("http://desktop-0fh88mm.tail989c2.ts.net:8888/v1", "llama-server")).toBe("desktop-0fh88mm:8888");
    expect(endpointHostLabel("http://mazinger.tail989c2.ts.net:8888/v1", "llama-server")).toBe("mazinger:8888");
  });
  test("drops the port when it's the provider default, keeps it otherwise", () => {
    expect(endpointHostLabel("http://box.ts.net:8080/v1", "llama-server")).toBe("box");       // 8080 is the llama-server default
    expect(endpointHostLabel("http://box.ts.net:11434/v1", "ollama")).toBe("box");             // 11434 is the ollama default
    expect(endpointHostLabel("http://box.ts.net:8888/v1", "llama-server")).toBe("box:8888");   // non-default → shown
  });
  test("keeps a bare IP whole", () => {
    expect(endpointHostLabel("http://192.168.1.50:8888/v1", "llama-server")).toBe("192.168.1.50:8888");
  });
  test("empty for a local or unparseable endpoint (no host in the badge)", () => {
    expect(endpointHostLabel("http://127.0.0.1:8888/v1", "llama-server")).toBe("");
    expect(endpointHostLabel(undefined, "llama-server")).toBe("");
    expect(endpointHostLabel("not a url", "llama-server")).toBe("");
  });
});

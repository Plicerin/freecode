// WebFetch takes a model-supplied URL; without a guard it could fetch cloud metadata
// (169.254.169.254), localhost admin APIs, or internal/Tailscale hosts and hand the
// response to the model — a real SSRF vector, especially chained with prompt injection.
import { test, expect, describe, afterEach } from "bun:test";
import { isPrivateIp, ssrfGuard } from "../src/tools/web-fetch";

describe("isPrivateIp", () => {
  test("flags loopback / RFC-1918 / link-local / cloud-metadata (v4)", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  test("allows public v4", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.32.0.1"]) expect(isPrivateIp(ip)).toBe(false);
  });
  test("v6 loopback / link-local / unique-local blocked, public allowed", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true); // IPv4-mapped loopback
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });
});

describe("ssrfGuard", () => {
  afterEach(() => { delete process.env.FREECODE_WEBFETCH_ALLOW_LOCAL; });

  test("blocks non-http(s) schemes", async () => {
    expect(await ssrfGuard("file:///etc/passwd")).toMatch(/scheme/);
    expect(await ssrfGuard("ftp://example.com/x")).toMatch(/scheme/);
    expect(await ssrfGuard("gopher://x")).toMatch(/scheme/);
  });
  test("blocks cloud metadata and loopback/RFC-1918 IP literals", async () => {
    expect(await ssrfGuard("http://169.254.169.254/latest/meta-data/")).toMatch(/private|internal/);
    expect(await ssrfGuard("http://127.0.0.1:8888/")).toMatch(/private|internal/);
    expect(await ssrfGuard("http://10.1.2.3/")).toMatch(/private|internal/);
    expect(await ssrfGuard("http://[::1]/")).toMatch(/private|internal/);
  });
  test("blocks localhost and *.local by name (no DNS needed)", async () => {
    expect(await ssrfGuard("http://localhost:3000/")).toMatch(/local/);
    expect(await ssrfGuard("http://synology.local/")).toMatch(/local/);
  });
  test("allows a public IP literal", async () => {
    expect(await ssrfGuard("https://93.184.216.34/")).toBeNull();
  });
  test("the escape hatch re-allows local hosts", async () => {
    process.env.FREECODE_WEBFETCH_ALLOW_LOCAL = "1";
    expect(await ssrfGuard("http://127.0.0.1:8888/")).toBeNull();
    expect(await ssrfGuard("http://localhost/")).toBeNull();
  });
  test("still rejects a bad scheme even with the escape hatch", async () => {
    process.env.FREECODE_WEBFETCH_ALLOW_LOCAL = "1";
    expect(await ssrfGuard("file:///etc/passwd")).toMatch(/scheme/);
  });
});

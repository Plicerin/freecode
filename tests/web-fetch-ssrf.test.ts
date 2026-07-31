// WebFetch takes a model-supplied URL; without a guard it could fetch cloud metadata
// (169.254.169.254), localhost admin APIs, or internal/Tailscale hosts and hand the
// response to the model — a real SSRF vector, especially chained with prompt injection.
import { test, expect, describe, afterEach } from "bun:test";
import { createServer } from "node:http";
import { createWebFetchTool, isPrivateIp, ssrfGuard } from "../src/tools/web-fetch";

describe("isPrivateIp", () => {
  test("flags loopback / RFC-1918 / link-local / cloud-metadata (v4)", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  test("allows public v4", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.32.0.1"]) expect(isPrivateIp(ip)).toBe(false);
  });
  test("blocks carrier-grade NAT / Tailscale and benchmark networks", () => {
    for (const ip of ["100.64.0.1", "100.100.100.100", "100.127.255.254", "198.18.0.1", "198.19.255.254"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  test("v6 loopback / link-local / unique-local blocked, public allowed", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("febf::1")).toBe(true); // upper edge of fe80::/10
    expect(isPrivateIp("fd00::1")).toBe(true);
    expect(isPrivateIp("ff02::1")).toBe(true); // multicast
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
    expect(await ssrfGuard("http://localhost/", async () => [{ address: "127.0.0.1", family: 4 }])).toBeNull();
  });
  test("still rejects a bad scheme even with the escape hatch", async () => {
    process.env.FREECODE_WEBFETCH_ALLOW_LOCAL = "1";
    expect(await ssrfGuard("file:///etc/passwd")).toMatch(/scheme/);
  });

  test("blocks a hostname if any DNS answer is private", async () => {
    const reason = await ssrfGuard("https://mixed.example/", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "100.100.100.100", family: 4 },
    ]);
    expect(reason).toMatch(/100\.100\.100\.100/);
  });
});

describe("DNS pinning", () => {
  test("connects to the exact public IP returned by the one validation lookup", async () => {
    let lookupCount = 0;
    const targets: Array<{ address: string; hostname: string; hostHeader: string }> = [];
    const tool = createWebFetchTool({
      lookup: async (hostname) => {
        lookupCount++;
        expect(hostname).toBe("public.example");
        return [{ address: "93.184.216.34", family: 4 }];
      },
      request: async (target) => {
        targets.push({ address: target.address, hostname: target.hostname, hostHeader: target.url.host });
        return new Response("safe", { status: 200, headers: { "content-type": "text/plain" } });
      },
    });

    const result = await tool.run({ url: "https://public.example:8443/page" } as never, { cwd: "." });
    expect(result.ok).toBe(true);
    expect(lookupCount).toBe(1);
    expect(targets).toEqual([{
      address: "93.184.216.34",
      hostname: "public.example",
      hostHeader: "public.example:8443",
    }]);
  });

  test("validates a redirect destination before making the second request", async () => {
    const requested: string[] = [];
    const tool = createWebFetchTool({
      lookup: async (hostname) => hostname === "public.example"
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "100.100.100.100", family: 4 }],
      request: async (target) => {
        requested.push(target.hostname);
        return new Response(null, { status: 302, headers: { location: "http://llama.tail.ts.net:8080/v1/models" } });
      },
    });

    const result = await tool.run({ url: "https://public.example/start" } as never, { cwd: "." });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/100\.100\.100\.100/);
    expect(requested).toEqual(["public.example"]);
  });

  test("the production transport connects to the pinned IP but sends the original Host", async () => {
    let receivedHost = "";
    const server = createServer((request, response) => {
      receivedHost = request.headers.host ?? "";
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("through pinned transport");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");

    process.env.FREECODE_WEBFETCH_ALLOW_LOCAL = "1";
    try {
      const tool = createWebFetchTool({
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      });
      const result = await tool.run({ url: `http://pinned.test:${address.port}/page` } as never, { cwd: "." });
      expect(result.ok).toBe(true);
      expect(result.output).toMatch(/through pinned transport/);
      expect(receivedHost).toBe(`pinned.test:${address.port}`);
    } finally {
      delete process.env.FREECODE_WEBFETCH_ALLOW_LOCAL;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

// Discover Ollama servers on the network (don't hardcode a moving address).
// Pure parsing + subnet derivation, and the orchestration with injected host
// sources + fetch so no real network/CLI is touched.
import { test, expect, describe } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { parseOllamaTags, parseTailscaleHosts, localSubnetHosts, discoverOllamaServers } from "../src/providers/ollama-discovery";

describe("parseOllamaTags", () => {
  test("extracts model names", () => {
    expect(parseOllamaTags(JSON.stringify({ models: [{ name: "qwen3:latest" }, { name: "llama3.2" }] }))).toEqual(["qwen3:latest", "llama3.2"]);
  });
  test("empty / garbage → []", () => {
    expect(parseOllamaTags(JSON.stringify({ models: [] }))).toEqual([]);
    expect(parseOllamaTags("not json")).toEqual([]);
    expect(parseOllamaTags("")).toEqual([]);
  });
});

describe("parseTailscaleHosts", () => {
  const json = JSON.stringify({
    Self: { DNSName: "me.tail.ts.net.", Online: true },
    Peer: {
      a: { DNSName: "desktop.tail.ts.net.", Online: true },
      b: { DNSName: "phone.tail.ts.net.", Online: false }, // offline → skipped
      c: { DNSName: "nas.tail.ts.net.", Online: true },
    },
  });
  test("self + ONLINE peers, trailing dot stripped, offline skipped", () => {
    const hosts = parseTailscaleHosts(json);
    expect(hosts).toContain("me.tail.ts.net");
    expect(hosts).toContain("desktop.tail.ts.net");
    expect(hosts).toContain("nas.tail.ts.net");
    expect(hosts).not.toContain("phone.tail.ts.net");
  });
  test("garbage → []", () => {
    expect(parseTailscaleHosts("nope")).toEqual([]);
  });
});

describe("localSubnetHosts", () => {
  const iface = (cidr: string, internal = false, family = "IPv4"): NetworkInterfaceInfo =>
    ({ address: cidr.split("/")[0]!, netmask: "", family, mac: "", internal, cidr } as NetworkInterfaceInfo);

  test("enumerates a /24 (1..254), skips loopback + IPv6", () => {
    const hosts = localSubnetHosts({ eth0: [iface("192.168.1.23/24")], lo: [iface("127.0.0.1/8", true)], v6: [iface("fe80::1/64", false, "IPv6")] });
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe("192.168.1.1");
    expect(hosts.at(-1)).toBe("192.168.1.254");
    expect(hosts).not.toContain("127.0.0.1");
  });
  test("refuses to enumerate wider than /24", () => {
    expect(localSubnetHosts({ eth0: [iface("10.0.0.5/16")] })).toEqual([]);
  });
});

describe("discoverOllamaServers (orchestration)", () => {
  const fetchFn = (async (url: string) => {
    if (String(url).includes("desktop.ts.net")) return new Response(JSON.stringify({ models: [{ name: "qwen3:latest" }, { name: "llama3.2" }] }), { status: 200 });
    if (String(url).includes("192.168.1.5")) return new Response(JSON.stringify({ models: [{ name: "codellama" }] }), { status: 200 });
    if (String(url).includes("127.0.0.1")) return new Response("", { status: 200 }); // responds but no models → filtered
    throw new Error("connection refused"); // dead.ts.net, others
  }) as unknown as typeof fetch;

  test("returns only hosts that answer WITH models; dedups; tags the source", async () => {
    const servers = await discoverOllamaServers({
      fetchFn,
      timeoutMs: 100,
      tailscaleHosts: async () => ["desktop.ts.net", "dead.ts.net"],
      lanHosts: () => ["192.168.1.5"],
    });
    const byHost = Object.fromEntries(servers.map((s) => [s.host, s]));
    expect(Object.keys(byHost).sort()).toEqual(["192.168.1.5", "desktop.ts.net"]); // localhost (no models) + dead (refused) dropped
    expect(byHost["desktop.ts.net"]!.models).toEqual(["qwen3:latest", "llama3.2"]);
    expect(byHost["desktop.ts.net"]!.source).toBe("tailscale");
    expect(byHost["desktop.ts.net"]!.baseUrl).toBe("http://desktop.ts.net:11434");
    expect(byHost["192.168.1.5"]!.source).toBe("lan");
  });

  test("collapses ONE box answering on multiple addresses (identical model set)", async () => {
    const same = JSON.stringify({ models: [{ name: "qwen3:latest" }] });
    const f = (async (url: string) =>
      (String(url).includes("box.ts.net") || String(url).includes("192.168.1.9"))
        ? new Response(same, { status: 200 })
        : (() => { throw new Error("refused"); })()) as unknown as typeof fetch;
    const servers = await discoverOllamaServers({
      fetchFn: f, timeoutMs: 50,
      tailscaleHosts: async () => ["box.ts.net"],
      lanHosts: () => ["192.168.1.9"],
    });
    expect(servers).toHaveLength(1);               // one physical box, not two
    expect(servers[0]!.source).toBe("tailscale");  // tailscale preferred over lan
    expect(servers[0]!.host).toBe("box.ts.net");
    expect(servers[0]!.aliases).toContain("192.168.1.9 (lan)");
  });
});

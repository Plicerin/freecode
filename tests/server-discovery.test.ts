// Discover LOCAL model servers (Ollama + llama-server) on the network without
// hardcoding a moving address. Pure parsing + subnet derivation, plus the
// orchestration with injected host sources + fetch so no real network/CLI runs.
import { test, expect, describe } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { parseOllamaTags, parseModelIds, parseTailscaleHosts, localSubnetHosts, discoverServers } from "../src/providers/server-discovery";

describe("parseOllamaTags / parseModelIds", () => {
  test("ollama /api/tags → names", () => {
    expect(parseOllamaTags(JSON.stringify({ models: [{ name: "qwen3:latest" }, { name: "llama3.2" }] }))).toEqual(["qwen3:latest", "llama3.2"]);
    expect(parseOllamaTags("not json")).toEqual([]);
  });
  test("openai /v1/models → ids", () => {
    expect(parseModelIds(JSON.stringify({ data: [{ id: "gemma-7b" }, { id: "qwen" }] }))).toEqual(["gemma-7b", "qwen"]);
    expect(parseModelIds("")).toEqual([]);
  });
});

describe("parseTailscaleHosts", () => {
  const json = JSON.stringify({
    Self: { DNSName: "me.tail.ts.net." },
    Peer: { a: { DNSName: "desktop.tail.ts.net.", Online: true }, b: { DNSName: "phone.tail.ts.net.", Online: false } },
  });
  test("self + ONLINE peers, trailing dot stripped, offline skipped", () => {
    const hosts = parseTailscaleHosts(json);
    expect(hosts).toContain("me.tail.ts.net");
    expect(hosts).toContain("desktop.tail.ts.net");
    expect(hosts).not.toContain("phone.tail.ts.net");
  });
});

describe("localSubnetHosts", () => {
  const iface = (cidr: string, internal = false, family = "IPv4"): NetworkInterfaceInfo =>
    ({ address: cidr.split("/")[0]!, netmask: "", family, mac: "", internal, cidr } as NetworkInterfaceInfo);
  test("enumerates a /24 (1..254), skips loopback + IPv6; refuses wider than /24", () => {
    const hosts = localSubnetHosts({ eth0: [iface("192.168.1.23/24")], lo: [iface("127.0.0.1/8", true)] });
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe("192.168.1.1");
    expect(localSubnetHosts({ eth0: [iface("10.0.0.5/16")] })).toEqual([]);
  });
});

describe("discoverServers", () => {
  const PROPS = JSON.stringify({ default_generation_settings: { n_ctx: 4096 } });

  test("finds Ollama AND llama-server, labelled by kind", async () => {
    const f = (async (url: string) => {
      const u = String(url);
      if (u === "http://olla.ts.net:11434/api/tags") return new Response(JSON.stringify({ models: [{ name: "llama3.2" }] }), { status: 200 });
      if (u === "http://192.168.1.8:8080/props") return new Response(PROPS, { status: 200 });
      if (u === "http://192.168.1.8:8080/v1/models") return new Response(JSON.stringify({ data: [{ id: "gemma-7b" }] }), { status: 200 });
      throw new Error("refused");
    }) as unknown as typeof fetch;

    const servers = await discoverServers({ fetchFn: f, timeoutMs: 50, tailscaleHosts: async () => ["olla.ts.net"], lanHosts: () => ["192.168.1.8"] });
    const oll = servers.find((s) => s.kind === "ollama");
    const llama = servers.find((s) => s.kind === "llama-server");
    expect(oll?.host).toBe("olla.ts.net");
    expect(oll?.baseUrl).toBe("http://olla.ts.net:11434/v1");
    expect(oll?.models).toEqual(["llama3.2"]);
    expect(llama?.endpoint).toBe("http://192.168.1.8:8080");
    expect(llama?.baseUrl).toBe("http://192.168.1.8:8080/v1");
    expect(llama?.contextLength).toBe(4096);
    expect(llama?.models).toEqual(["gemma-7b"]);
  });

  test("a /props with no n_ctx is NOT a llama-server (discriminator)", async () => {
    const f = (async (url: string) => String(url).endsWith("/props")
      ? new Response(JSON.stringify({ something: "else" }), { status: 200 })
      : (() => { throw new Error("refused"); })()) as unknown as typeof fetch;
    const servers = await discoverServers({ fetchFn: f, timeoutMs: 50, tailscaleHosts: async () => ["x.ts.net"], lanHosts: () => [] });
    expect(servers).toHaveLength(0);
  });

  test("dedups ONE llama-server box answering on two addresses", async () => {
    const f = (async (url: string) => {
      const u = String(url);
      const known = u.includes("box.ts.net") || u.includes("192.168.1.8");
      if (known && u.endsWith(":8080/props")) return new Response(PROPS, { status: 200 });
      if (known && u.endsWith(":8080/v1/models")) return new Response(JSON.stringify({ data: [{ id: "gemma-7b" }] }), { status: 200 });
      throw new Error("refused");
    }) as unknown as typeof fetch;
    const servers = await discoverServers({ fetchFn: f, timeoutMs: 50, tailscaleHosts: async () => ["box.ts.net"], lanHosts: () => ["192.168.1.8"] });
    const llamas = servers.filter((s) => s.kind === "llama-server");
    expect(llamas).toHaveLength(1);                       // one box, not two
    expect(llamas[0]!.source).toBe("tailscale");          // tailscale preferred over lan
    expect(llamas[0]!.aliases?.some((a) => a.includes("192.168.1.8"))).toBe(true);
  });
});

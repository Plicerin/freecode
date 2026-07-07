// Discover LOCAL model servers (Ollama + llama-server) on the network without
// hardcoding a moving address. Pure parsing + subnet derivation, plus the
// orchestration with injected host sources + fetch so no real network/CLI runs.
import { test, expect, describe } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { parseOllamaTags, parseModelIds, parseTailscaleHosts, parseTailscaleSelf, selfHostSet, localSubnetHosts, discoverServers, envLlamaPorts, llamaPortsFor } from "../src/providers/server-discovery";

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

describe("llama-server port set", () => {
  test("envLlamaPorts parses comma/space lists, drops junk + out-of-range", () => {
    expect(envLlamaPorts("8888")).toEqual([8888]);
    expect(envLlamaPorts("8080, 8888  9000")).toEqual([8080, 8888, 9000]);
    expect(envLlamaPorts("8888,8888")).toEqual([8888]);           // deduped
    expect(envLlamaPorts("nope,0,70000,-1,443")).toEqual([443]);  // only the valid one
    expect(envLlamaPorts(undefined)).toEqual([]);
    expect(envLlamaPorts("")).toEqual([]);
  });
  test("llamaPortsFor: localhost + tailscale peers get the alternates, the LAN /24 doesn't; env adds everywhere", () => {
    expect(llamaPortsFor("local", [])).toEqual([8080, 8888]);
    expect(llamaPortsFor("tailscale", [])).toEqual([8080, 8888]); // small named peer set → cheap to probe
    expect(llamaPortsFor("lan", [])).toEqual([8080]);             // 254-host sweep stays at 8080
    expect(llamaPortsFor("lan", [9000])).toEqual([8080, 9000]);
    expect(llamaPortsFor("local", [8080])).toEqual([8080, 8888]); // no dupe when env repeats a default
  });
});

describe("discoverServers", () => {
  const PROPS = JSON.stringify({ default_generation_settings: { n_ctx: 4096 } });

  test("finds a llama-server on localhost:8888 (the common alternate), not on a LAN host", async () => {
    const f = (async (url: string) => {
      const u = String(url);
      if (u === "http://127.0.0.1:8888/props") return new Response(PROPS, { status: 200 });
      if (u === "http://127.0.0.1:8888/v1/models") return new Response(JSON.stringify({ data: [{ id: "qwen3.6-35b" }] }), { status: 200 });
      throw new Error("refused"); // nothing on :8080, :11434, or any LAN host
    }) as unknown as typeof fetch;
    const servers = await discoverServers({ fetchFn: f, timeoutMs: 50, tailscaleHosts: async () => [], lanHosts: () => ["192.168.1.8"], llamaPorts: [] });
    expect(servers).toHaveLength(1);
    expect(servers[0]!.kind).toBe("llama-server");
    expect(servers[0]!.endpoint).toBe("http://127.0.0.1:8888");
    expect(servers[0]!.baseUrl).toBe("http://127.0.0.1:8888/v1");
    expect(servers[0]!.contextLength).toBe(4096);
    expect(servers[0]!.models).toEqual(["qwen3.6-35b"]);
  });

  test("FREECODE_LLAMA_PORTS opens a non-default port on a LAN host too", async () => {
    const f = (async (url: string) => {
      const u = String(url);
      if (u === "http://192.168.1.8:9001/props") return new Response(PROPS, { status: 200 });
      if (u === "http://192.168.1.8:9001/v1/models") return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
      throw new Error("refused");
    }) as unknown as typeof fetch;
    const servers = await discoverServers({ fetchFn: f, timeoutMs: 50, tailscaleHosts: async () => [], lanHosts: () => ["192.168.1.8"], llamaPorts: [9001] });
    expect(servers).toHaveLength(1);
    expect(servers[0]!.endpoint).toBe("http://192.168.1.8:9001");
  });

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

  test("collapses THIS machine's OWN addresses (localhost + self tailscale name) into one", async () => {
    // 127.0.0.1 and our own tailscale name are the SAME physical box → one entry,
    // 127.0.0.1 preferred, the self-name recorded as an alias.
    const f = (async (url: string) => {
      const u = String(url);
      const mine = u.includes("127.0.0.1") || u.includes("gakeen.ts.net");
      if (mine && u.endsWith(":8888/props")) return new Response(PROPS, { status: 200 });
      if (mine && u.endsWith(":8888/v1/models")) return new Response(JSON.stringify({ data: [{ id: "qwen-35b" }] }), { status: 200 });
      throw new Error("refused");
    }) as unknown as typeof fetch;
    const servers = await discoverServers({
      fetchFn: f, timeoutMs: 50, includeLan: false,
      tailscaleHosts: async () => ["gakeen.ts.net"], selfHost: "gakeen.ts.net",
    });
    const llamas = servers.filter((s) => s.kind === "llama-server");
    expect(llamas).toHaveLength(1);                                     // one box (self), not two
    expect(llamas[0]!.source).toBe("local");                           // 127.0.0.1 preferred
    expect(llamas[0]!.endpoint).toBe("http://127.0.0.1:8888");
    expect(llamas[0]!.aliases?.some((a) => a.includes("gakeen.ts.net"))).toBe(true);
  });

  test("does NOT merge two DIFFERENT machines that serve an identical model set", async () => {
    // The bug: three boxes all serving one 35B were collapsed into one because the
    // dedup keyed on model set. Distinct peers must stay distinct.
    const f = (async (url: string) => {
      const u = String(url);
      const isPeer = u.includes("desktop.ts.net") || u.includes("mazinger.ts.net");
      if (isPeer && u.endsWith(":8888/props")) return new Response(PROPS, { status: 200 });
      if (isPeer && u.endsWith(":8888/v1/models")) return new Response(JSON.stringify({ data: [{ id: "qwen-35b" }] }), { status: 200 });
      throw new Error("refused");
    }) as unknown as typeof fetch;
    const servers = await discoverServers({
      fetchFn: f, timeoutMs: 50, includeLan: false,
      tailscaleHosts: async () => ["desktop.ts.net", "mazinger.ts.net"], selfHost: "gakeen.ts.net",
    });
    const llamas = servers.filter((s) => s.kind === "llama-server");
    expect(llamas).toHaveLength(2);                                     // two distinct boxes, same model
    expect(llamas.map((s) => s.host).sort()).toEqual(["desktop.ts.net", "mazinger.ts.net"]);
    expect(llamas.every((s) => (s.aliases?.length ?? 0) === 0)).toBe(true); // neither swallowed the other
  });
});

describe("parseTailscaleSelf / selfHostSet", () => {
  test("parseTailscaleSelf reads Self.DNSName, strips trailing dot + lowercases", () => {
    expect(parseTailscaleSelf(JSON.stringify({ Self: { DNSName: "Gakeen.tail989c2.ts.net." } }))).toBe("gakeen.tail989c2.ts.net");
    expect(parseTailscaleSelf(JSON.stringify({}))).toBeUndefined();
    expect(parseTailscaleSelf("not json")).toBeUndefined();
  });
  test("selfHostSet includes loopback + our hostname + self tailscale name, not peers", () => {
    const s = selfHostSet("gakeen.ts.net", { eth0: [{ address: "192.168.1.50", internal: false } as NetworkInterfaceInfo] });
    expect(s.has("127.0.0.1")).toBe(true);
    expect(s.has("localhost")).toBe(true);
    expect(s.has("gakeen.ts.net")).toBe(true);
    expect(s.has("192.168.1.50")).toBe(true);          // our own LAN IP is "self"
    expect(s.has("desktop.ts.net")).toBe(false);       // a peer is not
  });
});

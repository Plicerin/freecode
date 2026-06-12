// Discover LOCAL model servers on the network instead of hardcoding an address
// that moves. Probes localhost + online Tailscale peers + the active LAN /24 for:
//   - Ollama       → http://host:11434/api/tags
//   - llama-server → http://host:8080/props (default port) AND, for Tailscale
//                    HOSTNAMES, https://host/props (a llama-server fronted by
//                    `tailscale serve` on 443). /props is the discriminator — only
//                    a llama-server answers it with an n_ctx.
// Returns the servers that answer, labelled by kind, deduped per physical box.
// Pure parsing + subnet derivation are unit-tested; the orchestration takes
// injectable host sources + fetch.
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { execFile } from "node:child_process";
import { parseLlamaServerContext } from "./local-context";

export type ServerKind = "ollama" | "llama-server";

export interface DiscoveredServer {
  host: string;            // preferred address (hostname or IP, no scheme/port)
  endpoint: string;        // raw base, e.g. http://host:11434 or https://host
  baseUrl: string;         // the /v1 URL to use as a provider base
  kind: ServerKind;
  models: string[];
  contextLength?: number;  // llama-server only (per-slot n_ctx)
  source: "local" | "tailscale" | "lan";
  /** Other addresses the SAME box answers on. */
  aliases?: string[];
}

const OLLAMA_PORT = 11434;
const LLAMA_PORT = 8080;

/** Model ids from an Ollama /api/tags payload. */
export function parseOllamaTags(jsonText: string): string[] {
  try {
    const j = JSON.parse(jsonText) as { models?: Array<{ name?: string }> };
    return (j.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    return [];
  }
}

/** Model ids from an OpenAI-compatible /v1/models payload (llama-server). */
export function parseModelIds(jsonText: string): string[] {
  try {
    const j = JSON.parse(jsonText) as { data?: Array<{ id?: string }> };
    return (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

/** Online peer hostnames (+ self) from `tailscale status --json`. */
export function parseTailscaleHosts(jsonText: string): string[] {
  try {
    const j = JSON.parse(jsonText) as {
      Self?: { DNSName?: string };
      Peer?: Record<string, { DNSName?: string; Online?: boolean }>;
    };
    const out: string[] = [];
    const self = j.Self?.DNSName?.replace(/\.$/, "");
    if (self) out.push(self);
    for (const p of Object.values(j.Peer ?? {})) {
      if (p.Online && p.DNSName) out.push(p.DNSName.replace(/\.$/, ""));
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}

/** Every host in the active /24 (guarded — never enumerate wider than a /24). */
export function localSubnetHosts(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const hosts = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.internal || ni.family !== "IPv4") continue;
      const m = /^(\d+\.\d+\.\d+)\.\d+\/(\d+)$/.exec(ni.cidr ?? "");
      if (!m || Number(m[2]) < 24) continue;
      for (let i = 1; i <= 254; i++) hosts.add(`${m[1]}.${i}`);
    }
  }
  return [...hosts];
}

function tailscaleStatusJson(): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile("tailscale", ["status", "--json"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
        resolve(err ? "" : stdout));
    } catch {
      resolve("");
    }
  });
}

async function getText(url: string, timeoutMs: number, fetchFn: typeof fetch): Promise<string | null> {
  try {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

const isIp = (h: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

/** Probe a single host for every server kind (in parallel); 0+ servers back. */
async function probeHost(host: string, source: DiscoveredServer["source"], timeoutMs: number, fetchFn: typeof fetch): Promise<DiscoveredServer[]> {
  const ollama = (async (): Promise<DiscoveredServer | null> => {
    const tags = await getText(`http://${host}:${OLLAMA_PORT}/api/tags`, timeoutMs, fetchFn);
    if (tags === null) return null;
    const models = parseOllamaTags(tags);
    return models.length ? { host, endpoint: `http://${host}:${OLLAMA_PORT}`, baseUrl: `http://${host}:${OLLAMA_PORT}/v1`, kind: "ollama", models, source } : null;
  })();

  const llamaAt = async (endpoint: string): Promise<DiscoveredServer | null> => {
    const props = await getText(`${endpoint}/props`, timeoutMs, fetchFn);
    if (props === null) return null;
    const ctx = parseLlamaServerContext(props); // null unless it's really a llama-server
    if (ctx === null) return null;
    const m = await getText(`${endpoint}/v1/models`, timeoutMs, fetchFn);
    return { host, endpoint, baseUrl: `${endpoint}/v1`, kind: "llama-server", models: m ? parseModelIds(m) : [], contextLength: ctx, source };
  };

  const probes: Promise<DiscoveredServer | null>[] = [ollama, llamaAt(`http://${host}:${LLAMA_PORT}`)];
  if (!isIp(host)) probes.push(llamaAt(`https://${host}`)); // tailscale-serve on 443 (hostnames only)

  return (await Promise.all(probes)).filter((s): s is DiscoveredServer => s !== null);
}

/** Bounded-concurrency map preserving order. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker));
  return results;
}

export interface DiscoverOptions {
  timeoutMs?: number;
  concurrency?: number;
  includeLan?: boolean;
  fetchFn?: typeof fetch;
  /** Injectable for tests: defaults to `tailscale status --json` parsing. */
  tailscaleHosts?: () => Promise<string[]>;
  /** Injectable for tests: defaults to the active /24. */
  lanHosts?: () => string[];
}

/** Probe localhost + Tailscale peers + the LAN /24 for Ollama and llama-server;
 *  return what answers, deduped per physical box (best address = local > tailscale > lan). */
export async function discoverServers(opts: DiscoverOptions = {}): Promise<DiscoveredServer[]> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const fetchFn = opts.fetchFn ?? fetch;
  const tsHosts = opts.tailscaleHosts ? await opts.tailscaleHosts() : parseTailscaleHosts(await tailscaleStatusJson());
  const lan = opts.includeLan === false ? [] : (opts.lanHosts ? opts.lanHosts() : localSubnetHosts());

  const candidates: Array<{ host: string; source: DiscoveredServer["source"] }> = [{ host: "127.0.0.1", source: "local" }];
  for (const h of tsHosts) candidates.push({ host: h, source: "tailscale" });
  for (const h of lan) candidates.push({ host: h, source: "lan" });

  const seen = new Set<string>();
  const uniq = candidates.filter((c) => (seen.has(c.host) ? false : (seen.add(c.host), true)));

  const found = (await mapBounded(uniq, opts.concurrency ?? 48, (c) => probeHost(c.host, c.source, timeoutMs, fetchFn))).flat();

  // Dedup PHYSICAL boxes per KIND: one machine answers under several addresses
  // with an identical model set. Keep the most useful address; record the rest.
  const rank: Record<DiscoveredServer["source"], number> = { local: 0, tailscale: 1, lan: 2 };
  const byKey = new Map<string, DiscoveredServer>();
  for (const s of found) {
    const sig = [...s.models].sort().join(" ");
    const key = `${s.kind}::${sig || s.endpoint}`; // model-less servers don't merge
    const cur = byKey.get(key);
    if (!cur) { byKey.set(key, { ...s, aliases: [] }); continue; }
    if (rank[s.source] < rank[cur.source]) {
      cur.aliases!.push(`${cur.endpoint} (${cur.source})`);
      cur.host = s.host; cur.endpoint = s.endpoint; cur.baseUrl = s.baseUrl; cur.source = s.source;
    } else {
      cur.aliases!.push(`${s.endpoint} (${s.source})`);
    }
  }
  return [...byKey.values()];
}

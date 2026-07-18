// Discover LOCAL model servers on the network instead of hardcoding an address
// that moves. Probes localhost + online Tailscale peers + the active LAN /24 for:
//   - Ollama       → http://host:11434/api/tags
//   - llama-server → http://host:8080/props (default port) AND, for Tailscale
//                    HOSTNAMES, https://host/props (a llama-server fronted by
//                    `tailscale serve` on 443). /props is the discriminator — only
//                    a llama-server answers it with an n_ctx.
// llama-server ports aren't just 8080: localhost also gets the common alternates
// (see LLAMA_LOCAL_EXTRA_PORTS), and FREECODE_LLAMA_PORTS adds ports on EVERY host.
// The /props discriminator means probing an extra port is safe — a non-llama
// service there (Jupyter, a web app) simply doesn't answer /props with an n_ctx.
// Returns the servers that answer, labelled by kind, deduped per physical box.
// Pure parsing + subnet derivation are unit-tested; the orchestration takes
// injectable host sources + fetch.
import { networkInterfaces, hostname, type NetworkInterfaceInfo } from "node:os";
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
const LLAMA_PORT = 8080;                 // the llama-server default, probed on EVERY host
// Common non-default llama-server ports, probed on localhost AND Tailscale peers
// (both are small, named host sets — cheap). NOT probed across the LAN /24, whose
// 254 hosts would turn each extra port into 254 more requests; the /24 stays at 8080.
const LLAMA_ALT_PORTS = [8888];

/** Extra llama-server ports from FREECODE_LLAMA_PORTS (comma/space separated), probed on EVERY host.
 *  Lets any port you actually serve on become discoverable without a code change. */
export function envLlamaPorts(raw: string | undefined = process.env.FREECODE_LLAMA_PORTS): number[] {
  if (!raw) return [];
  return [...new Set(
    raw.split(/[\s,]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536),
  )];
}

/** llama-server ports to probe for a candidate: the default + env ports everywhere,
 *  plus the common alternates on localhost and Tailscale peers (not the LAN /24).
 *  Deduped, order-stable. */
export function llamaPortsFor(source: DiscoveredServer["source"], envPorts: number[] = envLlamaPorts()): number[] {
  const ports = [LLAMA_PORT, ...envPorts];
  if (source === "local" || source === "tailscale") ports.push(...LLAMA_ALT_PORTS);
  return [...new Set(ports)];
}

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

/** This machine's OWN Tailscale name from `tailscale status --json` (Self.DNSName).
 *  Used to tell "my own addresses" apart from a peer's when deduping. */
export function parseTailscaleSelf(jsonText: string): string | undefined {
  try {
    const j = JSON.parse(jsonText) as { Self?: { DNSName?: string } };
    return j.Self?.DNSName?.replace(/\.$/, "").toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** The set of host strings that are THIS machine: loopback names, our hostname,
 *  our own Tailscale name, and every non-internal local interface IP. A server
 *  found on any of these is the same physical box as `127.0.0.1`, so its
 *  addresses collapse into one "local" entry — whereas a DIFFERENT machine that
 *  happens to serve the same model must stay a distinct entry. */
export function selfHostSet(
  selfTailscaleName?: string,
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): Set<string> {
  const s = new Set<string>(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);
  s.add(hostname().toLowerCase());
  if (selfTailscaleName) s.add(selfTailscaleName.toLowerCase());
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (!ni.internal && ni.address) s.add(ni.address.toLowerCase());
    }
  }
  return s;
}

/** Port from a discovered endpoint URL (443/80 default by scheme). Two servers on
 *  the SAME box are distinguished by port, so localhost:8888 and self:8888 merge
 *  but self:8888 and self:8080 stay separate. */
function portOf(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    return "?";
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
async function probeHost(host: string, source: DiscoveredServer["source"], timeoutMs: number, fetchFn: typeof fetch, envPorts: number[]): Promise<DiscoveredServer[]> {
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

  const probes: Promise<DiscoveredServer | null>[] = [ollama];
  for (const port of llamaPortsFor(source, envPorts)) probes.push(llamaAt(`http://${host}:${port}`));
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
  /** Extra llama-server ports probed on every host. Defaults to FREECODE_LLAMA_PORTS. */
  llamaPorts?: number[];
  /** Injectable for tests: this machine's own Tailscale name (self-vs-peer dedup).
   *  Defaults to `tailscale status --json` Self.DNSName. */
  selfHost?: string;
}

/** Probe localhost + Tailscale peers + the LAN /24 for Ollama and llama-server;
 *  return what answers, deduped per physical box (best address = local > tailscale > lan). */
export async function discoverServers(opts: DiscoverOptions = {}): Promise<DiscoveredServer[]> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const fetchFn = opts.fetchFn ?? fetch;
  const envPorts = opts.llamaPorts ?? envLlamaPorts();
  let tsHosts: string[];
  let selfTsName = opts.selfHost?.toLowerCase();
  if (opts.tailscaleHosts) {
    tsHosts = await opts.tailscaleHosts();
  } else {
    const json = await tailscaleStatusJson();
    tsHosts = parseTailscaleHosts(json);
    if (selfTsName === undefined) selfTsName = parseTailscaleSelf(json);
  }
  const lan = opts.includeLan === false ? [] : (opts.lanHosts ? opts.lanHosts() : localSubnetHosts());

  const candidates: Array<{ host: string; source: DiscoveredServer["source"] }> = [{ host: "127.0.0.1", source: "local" }];
  for (const h of tsHosts) candidates.push({ host: h, source: "tailscale" });
  for (const h of lan) candidates.push({ host: h, source: "lan" });

  const seen = new Set<string>();
  const uniq = candidates.filter((c) => (seen.has(c.host) ? false : (seen.add(c.host), true)));

  const found = (await mapBounded(uniq, opts.concurrency ?? 48, (c) => probeHost(c.host, c.source, timeoutMs, fetchFn, envPorts))).flat();

  // Collapse only the addresses that are the SAME physical box. THIS machine
  // answers on 127.0.0.1 + its own hostname/Tailscale-name/LAN-IP — those merge
  // into one "local" entry (best address = local > tailscale > lan). A DIFFERENT
  // machine is a distinct box even if it serves an identical model set, so peers
  // key by (host, port) and never merge into each other or into local. (The old
  // model-set key wrongly merged three separate boxes all serving one 35B model.)
  const self = selfHostSet(selfTsName);
  const rank: Record<DiscoveredServer["source"], number> = { local: 0, tailscale: 1, lan: 2 };
  const byKey = new Map<string, DiscoveredServer>();
  for (const s of found) {
    const isSelf = self.has(s.host.toLowerCase());
    // Same box + same port = same server. Self collapses across all its addresses;
    // a peer stays keyed to its own host so distinct machines never fold together.
    const key = isSelf ? `${s.kind}::self::${portOf(s.endpoint)}` : `${s.kind}::${s.host.toLowerCase()}::${portOf(s.endpoint)}`;
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

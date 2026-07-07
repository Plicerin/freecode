// Is a base URL pointing at a REMOTE host (a model server on another machine on
// the network) vs localhost? Used to badge network/LAN connections in the status
// line with a 🌐 — e.g. a llama-server reached over Tailscale.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", ""]);

export function isRemoteHost(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    return !LOCAL_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Local-server providers — those that could be pointed at a remote box. */
const LOCAL_SERVER_PROVIDERS = new Set(["ollama", "lmstudio", "llama-server"]);

/** True when this is a local-server provider reaching a model on ANOTHER machine
 *  (so the status line should show a network badge). Cloud providers are always
 *  remote and don't get the badge — it's specifically for "your other computer". */
export function isLanModelEndpoint(provider: string, baseUrl?: string): boolean {
  return LOCAL_SERVER_PROVIDERS.has(provider) && isRemoteHost(baseUrl);
}

/** Short, human "which machine" label for a network endpoint, so two servers of
 *  the SAME kind (e.g. two llama-servers both serving one 35B) are told apart in
 *  the status line. Strips the Tailscale/MagicDNS suffix (desktop-0fh88mm.tail989c2.ts.net
 *  → desktop-0fh88mm) and appends the port when it isn't the provider default.
 *  Returns "" for a local/loopback or unparseable endpoint (no badge host shown). */
export function endpointHostLabel(baseUrl?: string, provider?: string): string {
  if (!isRemoteHost(baseUrl)) return "";
  try {
    const u = new URL(baseUrl!);
    // First DNS label only when it's a real hostname; keep bare IPs whole.
    const host = /^[0-9.]+$/.test(u.hostname) ? u.hostname : u.hostname.split(".")[0]!;
    const defaultPort = provider === "ollama" ? "11434" : provider === "llama-server" ? "8080" : "";
    const port = u.port && u.port !== defaultPort ? `:${u.port}` : "";
    return host + port;
  } catch {
    return "";
  }
}

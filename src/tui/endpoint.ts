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

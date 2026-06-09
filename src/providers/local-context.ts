// freecode guesses a model's context window from its name (e.g. 128k), but a
// LOCAL server loads a model with a fixed KV-cache (`n_ctx`) chosen at load time
// that can be far smaller — gemma-3-4b at 4096 while its max is 131072. That
// mismatch makes freecode assume room it doesn't have, so the server overruns
// (truncates / returns empty) while freecode never compacts. LM Studio exposes
// the real loaded size at /api/v0/models; we read it for local providers.

interface LmModel {
  id?: string;
  state?: string;
  loaded_context_length?: number;
}

/** Parse LM Studio's /api/v0/models payload → the context length the model is
 *  actually LOADED with. Prefer the requested model id; fall back to whatever is
 *  loaded. null if not found / not a positive number. */
export function parseLmStudioContext(jsonText: string, modelId: string): number | null {
  try {
    const json = JSON.parse(jsonText) as { data?: LmModel[] } | LmModel[];
    const list = Array.isArray(json) ? json : (json.data ?? []);
    const byId = list.find((m) => m.id === modelId && m.state === "loaded");
    const anyLoaded = list.find((m) => m.state === "loaded");
    const n = (byId ?? anyLoaded)?.loaded_context_length;
    return typeof n === "number" && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Best-effort: ask a LOCAL provider what context the model is actually loaded
 *  with. Returns null when unknown, not local, or unreachable — never throws, so
 *  a missing/older server just falls back to the name-based guess. */
export async function detectLocalContextWindow(provider: string, baseUrl: string | undefined, modelId: string): Promise<number | null> {
  if (provider !== "lmstudio") return null; // only LM Studio exposes this today
  const root = (baseUrl ?? "http://127.0.0.1:1234/v1").replace(/\/v1\/?$/, "");
  try {
    const resp = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return null;
    return parseLmStudioContext(await resp.text(), modelId);
  } catch {
    return null;
  }
}

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

export interface LoadedModel {
  id: string;
  contextLength: number | null;
}

/** Every model LM Studio currently has LOADED, with its loaded context length.
 *  Lets freecode follow what's actually serving instead of a stale model id. */
export function parseLoadedLmStudioModels(jsonText: string): LoadedModel[] {
  try {
    const json = JSON.parse(jsonText) as { data?: LmModel[] } | LmModel[];
    const list = Array.isArray(json) ? json : (json.data ?? []);
    return list
      .filter((m) => m.state === "loaded" && typeof m.id === "string")
      .map((m) => ({ id: m.id!, contextLength: typeof m.loaded_context_length === "number" && m.loaded_context_length > 0 ? m.loaded_context_length : null }));
  } catch {
    return [];
  }
}

/** Best-effort: which models a LOCAL provider currently has loaded (LM Studio).
 *  [] when not local / unreachable — never throws. */
export async function detectLocalModels(provider: string, baseUrl: string | undefined): Promise<LoadedModel[]> {
  if (provider !== "lmstudio") return [];
  const root = (baseUrl ?? "http://127.0.0.1:1234/v1").replace(/\/v1\/?$/, "");
  try {
    const resp = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return [];
    return parseLoadedLmStudioModels(await resp.text());
  } catch {
    return [];
  }
}

/** Best-effort: the context the given model is loaded with. Falls back to the
 *  name-based guess (null) when unknown / not local / unreachable. */
export async function detectLocalContextWindow(provider: string, baseUrl: string | undefined, modelId: string): Promise<number | null> {
  if (provider !== "lmstudio") return null;
  const root = (baseUrl ?? "http://127.0.0.1:1234/v1").replace(/\/v1\/?$/, "");
  try {
    const resp = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return null;
    return parseLmStudioContext(await resp.text(), modelId);
  } catch {
    return null;
  }
}

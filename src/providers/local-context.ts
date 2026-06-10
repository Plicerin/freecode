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

interface LlamaProps {
  default_generation_settings?: { n_ctx?: number };
  n_ctx?: number;
  total_slots?: number;
}

/** Parse llama.cpp server's /props payload → the PER-SLOT context the model is
 *  loaded with (what a single request actually gets). Prefer
 *  default_generation_settings.n_ctx (already per-slot in recent llama.cpp);
 *  else split the global n_ctx across the slots. null if absent / non-positive. */
export function parseLlamaServerContext(jsonText: string): number | null {
  try {
    const json = JSON.parse(jsonText) as LlamaProps;
    const perSlot = json.default_generation_settings?.n_ctx;
    if (typeof perSlot === "number" && perSlot > 0) return perSlot;
    const total = json.n_ctx;
    const slots = json.total_slots && json.total_slots > 0 ? json.total_slots : 1;
    if (typeof total === "number" && total > 0) return Math.floor(total / slots);
    return null;
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
    const resp = await fetch(`${root}/api/v0/models`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return [];
    return parseLoadedLmStudioModels(await resp.text());
  } catch {
    return [];
  }
}

async function probeOk(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Identify which kind of local OpenAI-compat server is behind a base URL from
 *  its distinctive endpoint — so a llama.cpp server reached via the lmstudio
 *  provider can be LABELED "llama-server", not "lmstudio". null = unknown. */
export async function detectServerKind(baseUrl: string | undefined): Promise<"lmstudio" | "llama-server" | "ollama" | null> {
  if (!baseUrl) return null;
  const root = baseUrl.replace(/\/v1\/?$/, "");
  if (await probeOk(`${root}/api/v0/models`)) return "lmstudio"; // LM Studio's native API
  if (await probeOk(`${root}/props`)) return "llama-server"; // llama.cpp server props
  if (await probeOk(`${root}/api/tags`)) return "ollama"; // Ollama's native API
  return null;
}

/** Best-effort: the context a llama.cpp server has loaded, via /props. null when
 *  unreachable / not a llama-server. Independent of which provider id freecode
 *  used — a llama-server reached through the lmstudio provider still works. */
export async function detectLlamaServerContext(baseUrl: string | undefined): Promise<number | null> {
  const root = (baseUrl ?? "http://127.0.0.1:8080/v1").replace(/\/v1\/?$/, "");
  try {
    const resp = await fetch(`${root}/props`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return null;
    return parseLlamaServerContext(await resp.text());
  } catch {
    return null;
  }
}

/** Best-effort: the context the given model is loaded with. Falls back to the
 *  name-based guess (null) when unknown / not local / unreachable. */
export async function detectLocalContextWindow(provider: string, baseUrl: string | undefined, modelId: string): Promise<number | null> {
  if (provider !== "lmstudio") return null;
  const root = (baseUrl ?? "http://127.0.0.1:1234/v1").replace(/\/v1\/?$/, "");
  try {
    const resp = await fetch(`${root}/api/v0/models`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return null;
    return parseLmStudioContext(await resp.text(), modelId);
  } catch {
    return null;
  }
}

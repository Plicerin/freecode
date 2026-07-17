import type { ProviderError, StreamEvent } from "./types";
import { debug } from "../utils/debug";

export function makeError(provider: string, message: string, code?: string, retryable = false): ProviderError {
  const err = new Error(message) as ProviderError;
  err.provider = provider;
  err.code = code;
  err.retryable = retryable;
  return err;
}

export function friendlyError(err: unknown, provider: string, model?: string): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const code = (err as { code?: string }).code ?? "";
  const status = (err as { status?: number }).status ?? 0;
  const msg = err.message.toLowerCase();

  if (code === "ECONNREFUSED" || msg.includes("econnrefused") || msg.includes("fetch failed")) {
    if (provider === "ollama") {
      return new Error("Local provider not running — please start Ollama");
    }
    if (provider === "lmstudio") {
      return new Error("Local provider not running — please start LM Studio");
    }
    return new Error(`Could not reach ${provider} — check your network or baseUrl`);
  }
  if (status === 401 || code === "invalid_api_key" || msg.includes("invalid api key") || msg.includes("api key not valid") || msg.includes("unauthorized")) {
    if (provider === "nim") {
      return new Error("Invalid NVIDIA API key — get one at build.nvidia.com (free tier available)");
    }
    return new Error(`Invalid API key — check the key for ${provider}`);
  }
  if (status === 403 || msg.includes("forbidden")) {
    return new Error(`Forbidden — your ${provider} key may lack the required scope`);
  }
  if (code === "model_not_found" || msg.includes("model not found") || msg.includes("does not exist") || msg.includes("unknown model")) {
    return new Error(`Model ${model ? `"${model}" ` : ""}not found on ${provider} — it may be deprecated or unavailable. Pick another with /model. (${err.message})`);
  }
  if (status === 404) {
    // A bare 404 is NOT necessarily a bad model. For local servers it's usually a
    // wrong endpoint/baseUrl PATH, and a server that crashed or restarted (common
    // with heavy local models) 404s every request until it's back. Telling the user
    // "Model not found — use /model" sends them switching models in circles when the
    // endpoint/server is the real problem. Surface the raw error and BOTH causes.
    return new Error(`${provider} returned 404 for ${model ? `model "${model}"` : "the request"} — the model may be unavailable, OR the endpoint/baseUrl is wrong or the server is down. Check the endpoint/server, then try /model. (${err.message})`);
  }
  if (status === 429 || code === "rate_limit_exceeded" || msg.includes("rate limit") || code === "RESOURCE_EXHAUSTED") {
    const e = new Error(`Rate limited by ${provider} — retrying with backoff`) as Error & { retryable: boolean };
    e.retryable = true;
    return e;
  }
  if (status === 529 || code === "overloaded") {
    const e = new Error(`${provider} is overloaded — retrying`) as Error & { retryable: boolean };
    e.retryable = true;
    return e;
  }
  if (msg.includes("context length") || msg.includes("context window") || msg.includes("maximum context")) {
    // Keep the ORIGINAL message: it carries the token count the loop's
    // parseContextLimit() needs to size the shrink-and-retry. Dropping it (as the
    // old numberless string did) left parseContextLimit null → the heal never ran.
    return new Error(`Context window exceeded — auto-compacting. ${err.message}`);
  }
  if (msg.includes("invalid base url") || msg.includes("invalid url")) {
    return new Error(`Invalid baseUrl for ${provider} — check configuration`);
  }
  debug.warn(`unmapped provider error from ${provider}`, { message: err.message, code, status });
  return err;
}

export function isRetryable(err: unknown): boolean {
  if (err && typeof err === "object" && "retryable" in err) {
    return Boolean((err as { retryable?: boolean }).retryable);
  }
  return false;
}

export function passthroughStream(events: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
  return (async function* () {
    for await (const e of events) yield e;
  })();
}

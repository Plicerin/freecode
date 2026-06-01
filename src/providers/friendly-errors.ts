import type { ProviderError, StreamEvent } from "./types";
import { debug } from "../utils/debug";

export function makeError(provider: string, message: string, code?: string, retryable = false): ProviderError {
  const err = new Error(message) as ProviderError;
  err.provider = provider;
  err.code = code;
  err.retryable = retryable;
  return err;
}

export function friendlyError(err: unknown, provider: string): Error {
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
  if (status === 401 || code === "invalid_api_key" || msg.includes("invalid api key") || msg.includes("unauthorized")) {
    if (provider === "nim") {
      return new Error("Invalid NVIDIA API key — get one at build.nvidia.com (free tier available)");
    }
    return new Error(`Invalid API key — check the key for ${provider}`);
  }
  if (status === 403 || msg.includes("forbidden")) {
    return new Error(`Forbidden — your ${provider} key may lack the required scope`);
  }
  if (status === 404 || code === "model_not_found" || msg.includes("model not found")) {
    return new Error("Model not found — use /model to switch");
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
    return new Error("Context window exceeded — auto-compacting");
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

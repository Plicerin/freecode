import type { Provider } from "./types";
import { MockProvider } from "./mock";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatProvider } from "./openai-compat";
import { GeminiProvider } from "./gemini";
import { UnimplementedProvider } from "./unimplemented";
import type { ResolvedConfig } from "../config/schema";
import { debug } from "../utils/debug";
import { loadTokens } from "../auth/store";
import { ANTHROPIC_OAUTH_BETAS } from "../auth/anthropic-oauth";
import { isExpired } from "../auth/oauth";
import { RateLimitedProvider } from "./rate-limited";
import { RateLimiter } from "../agent/rate-limit";

/** OpenAI-compatible endpoints live under /v1; ensure the base URL has it. */
function ensureV1(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function buildProvider(config: ResolvedConfig): Provider {
  const base = buildBaseProvider(config);
  // MRM throttle: when set, gate every chat request through a shared limiter so
  // the cap is global across the main agent, sub-agents, and workflows.
  const rpm = config.maxRequestsPerMinute ?? 0;
  if (rpm > 0) {
    debug.log("rate limiting enabled", { maxRequestsPerMinute: rpm });
    return new RateLimitedProvider(base, new RateLimiter(rpm, undefined, undefined, (ms) =>
      debug.log("throttled — waiting", { ms })));
  }
  return base;
}

function buildBaseProvider(config: ResolvedConfig): Provider {
  const { provider, baseUrl, apiKey, model } = config;
  debug.log("building provider", { provider, baseUrl, hasKey: !!apiKey, model });

  switch (provider) {
    case "anthropic": {
      // Prefer a "Sign in with Claude" (Pro/Max subscription) token if present
      // and no explicit API key was forced — Bearer + anthropic-beta, no x-api-key.
      if (!apiKey) {
        try {
          const tokens = loadTokens("anthropic");
          if (tokens?.accessToken) {
            if (isExpired(tokens, Date.now())) {
              debug.warn("anthropic OAuth token expired — run `freecode auth refresh anthropic`");
            }
            return new AnthropicProvider({ baseUrl, oauthToken: tokens.accessToken, betaHeader: ANTHROPIC_OAUTH_BETAS });
          }
        } catch { /* fall through to api-key mode */ }
      }
      return new AnthropicProvider({ apiKey, baseUrl });
    }
    case "openai":
      return new OpenAICompatProvider("openai", "OpenAI", {
        apiKey,
        baseUrl: baseUrl ?? "https://api.openai.com/v1",
        providerName: "openai",
        defaultModel: model,
        authHeader: "bearer",
      });
    case "github-models":
      return new OpenAICompatProvider("github-models", "GitHub Models", {
        apiKey,
        baseUrl: baseUrl ?? "https://models.inference.ai.azure.com",
        providerName: "github-models",
        defaultModel: model,
        authHeader: "github",
      });
    case "lmstudio":
      return new OpenAICompatProvider("lmstudio", "LM Studio", {
        apiKey,
        baseUrl: ensureV1(baseUrl ?? "http://127.0.0.1:1234/v1"),
        providerName: "lmstudio",
        defaultModel: model,
        authHeader: "lmstudio",
      });
    case "ollama":
      return new OpenAICompatProvider("ollama", "Ollama", {
        apiKey,
        baseUrl: ensureV1(baseUrl ?? "http://127.0.0.1:11434/v1"),
        providerName: "ollama",
        defaultModel: model,
        authHeader: "none",
      });
    case "llama-server":
      return new OpenAICompatProvider("llama-server", "llama.cpp server", {
        apiKey,
        baseUrl: ensureV1(baseUrl ?? "http://127.0.0.1:8080/v1"),
        providerName: "llama-server",
        defaultModel: model,
        authHeader: "lmstudio", // optional/no key, like LM Studio
      });
    case "nim":
      return new OpenAICompatProvider("nim", "NVIDIA NIM", {
        apiKey,
        baseUrl: baseUrl ?? "https://integrate.api.nvidia.com/v1",
        providerName: "nim",
        defaultModel: model,
        authHeader: "bearer",
      });
    case "openrouter":
      // Unified OpenAI-compatible gateway to 300+ models (model slugs are
      // namespaced, e.g. "anthropic/claude-3.7-sonnet", "openai/gpt-4o").
      return new OpenAICompatProvider("openrouter", "OpenRouter", {
        apiKey,
        baseUrl: baseUrl ?? "https://openrouter.ai/api/v1",
        providerName: "openrouter",
        defaultModel: model,
        authHeader: "bearer",
      });
    case "gemini":
      return new GeminiProvider({ apiKey, baseUrl });
    case "bedrock":
    case "vertex":
      // Not implemented yet — fail honestly rather than silently returning mock output.
      return new UnimplementedProvider(provider);
    case "mock":
      return new MockProvider();
    default:
      return new MockProvider();
  }
}

export { MockProvider } from "./mock";
export { AnthropicProvider } from "./anthropic";
export { OpenAICompatProvider } from "./openai-compat";
export { GeminiProvider } from "./gemini";

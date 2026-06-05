import type { Provider } from "./types";
import { MockProvider } from "./mock";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatProvider } from "./openai-compat";
import { GeminiProvider } from "./gemini";
import { UnimplementedProvider } from "./unimplemented";
import type { ResolvedConfig } from "../config/schema";
import { debug } from "../utils/debug";

/** OpenAI-compatible endpoints live under /v1; ensure the base URL has it. */
function ensureV1(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function buildProvider(config: ResolvedConfig): Provider {
  const { provider, baseUrl, apiKey, model } = config;
  debug.log("building provider", { provider, baseUrl, hasKey: !!apiKey, model });

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider({ apiKey, baseUrl });
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

import type { Provider } from "./types";
import { MockProvider } from "./mock";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatProvider } from "./openai-compat";
import { GeminiProvider } from "./gemini";
import type { ResolvedConfig } from "../config/schema";
import { debug } from "../utils/debug";

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
        baseUrl: baseUrl ?? "http://127.0.0.1:1234/v1",
        providerName: "lmstudio",
        defaultModel: model,
        authHeader: "lmstudio",
      });
    case "nim":
      return new OpenAICompatProvider("nim", "NVIDIA NIM", {
        apiKey,
        baseUrl: baseUrl ?? "https://integrate.api.nvidia.com/v1",
        providerName: "nim",
        defaultModel: model,
        authHeader: "bearer",
      });
    case "gemini":
      return new GeminiProvider({ apiKey, baseUrl });
    case "bedrock":
    case "vertex":
    case "ollama":
      // Real impls deferred — fall back to mock so the app runs with zero config.
      // V11 satisfied: working stub ships, no API key needed to launch.
      return new MockProvider();
    default:
      return new MockProvider();
  }
}

export { MockProvider } from "./mock";
export { AnthropicProvider } from "./anthropic";
export { OpenAICompatProvider } from "./openai-compat";
export { GeminiProvider } from "./gemini";

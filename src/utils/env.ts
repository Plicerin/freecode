export function getEnv(key: string): string | undefined {
  const v = process.env[key];
  if (v === undefined || v === "") return undefined;
  return v;
}

export function getEnvBool(key: string, fallback = false): boolean {
  const v = getEnv(key);
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export function getEnvInt(key: string, fallback: number): number {
  const v = getEnv(key);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export type ProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "github-models"
  | "openrouter"
  | "bedrock"
  | "vertex"
  | "ollama"
  | "lmstudio"
  | "nim";

const ENV_FLAGS: Record<ProviderId, string> = {
  anthropic: "CLAUDE_CODE_USE_ANTHROPIC",
  openai: "CLAUDE_CODE_USE_OPENAI",
  gemini: "CLAUDE_CODE_USE_GEMINI",
  "github-models": "CLAUDE_CODE_USE_GITHUB_MODELS",
  openrouter: "CLAUDE_CODE_USE_OPENROUTER",
  bedrock: "CLAUDE_CODE_USE_BEDROCK",
  vertex: "CLAUDE_CODE_USE_VERTEX",
  ollama: "CLAUDE_CODE_USE_OLLAMA",
  lmstudio: "CLAUDE_CODE_USE_LMSTUDIO",
  nim: "CLAUDE_CODE_USE_NIM",
};

/** A DELIBERATE provider choice from env: only the CLAUDE_CODE_USE_* flags, not
 *  raw-key inference. Should outrank a remembered session; key-inference (the full
 *  detectProviderFromEnv below) should not. */
export function explicitEnvProvider(): ProviderId | undefined {
  for (const [id, flag] of Object.entries(ENV_FLAGS)) {
    if (getEnvBool(flag)) return id as ProviderId;
  }
  return undefined;
}

export function detectProviderFromEnv(): ProviderId | undefined {
  const explicit = explicitEnvProvider();
  if (explicit) return explicit;
  if (getEnv("ANTHROPIC_API_KEY")) return "anthropic";
  if (getEnv("OPENAI_API_KEY")) return "openai";
  if (getEnv("GEMINI_API_KEY")) return "gemini";
  if (getEnv("OPENROUTER_API_KEY")) return "openrouter";
  if (getEnv("GITHUB_TOKEN")) return "github-models";
  if (getEnv("AWS_ACCESS_KEY_ID") && getEnv("AWS_SECRET_ACCESS_KEY")) return "bedrock";
  if (getEnv("GOOGLE_APPLICATION_CREDENTIALS")) return "vertex";
  if (getEnv("OLLAMA_HOST")) return "ollama";
  if (getEnv("LMSTUDIO_HOST")) return "lmstudio";
  if (getEnv("NVIDIA_API_KEY") || getEnv("NVIDIA_NIM_API_KEY")) return "nim";
  return undefined;
}

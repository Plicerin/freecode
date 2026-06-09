import { existsSync, readFileSync } from "node:fs";
import { PROFILE_PATH } from "../utils/paths";
import { ProfileSchema, type Profile } from "./schema";
import { loadJsoncSettings } from "./settings-jsonc";
import { loadProfile } from "./profile";
import { readLastSession } from "./last-session";
import { detectProviderFromEnv, explicitEnvProvider, getEnv } from "../utils/env";
import { Vault } from "./vault";
import {
  type ProviderId,
  type ResolvedConfig,
  type Settings,
} from "./schema";
import { debug } from "../utils/debug";

export interface CliFlags {
  provider?: ProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  permissionMode?: "manual" | "auto" | "bypass";
  theme?: "dark" | "light";
  maxTurns?: number;
  maxRequestsPerMinute?: number;
  webSearchProvider?: "duckduckgo" | "tavily" | "exa" | "firecrawl";
  enableExtendedThinking?: boolean;
  verifyMode?: "off" | "on" | "strict";
  print?: boolean;
  resume?: string;
  port?: number;
}

type Source = "cli" | "profile" | "env" | "settings" | "default";

const DEFAULTS = {
  provider: "anthropic" as ProviderId,
  model: "claude-sonnet-4-5",
  permissionMode: "manual" as const,
  webSearchProvider: "duckduckgo" as const,
  theme: "dark" as const,
  maxTurns: 50,
  contextThreshold: 0.8,
  enablePromptCache: true,
  enableExtendedThinking: false,
};

function pick<T>(cli: T | undefined, profile: T | undefined, env: T | undefined, settings: T | undefined, def: T): { value: T; source: Source } {
  if (cli !== undefined) return { value: cli, source: "cli" };
  if (profile !== undefined) return { value: profile, source: "profile" };
  if (env !== undefined && env !== "") return { value: env as T, source: "env" };
  if (settings !== undefined) return { value: settings, source: "settings" };
  return { value: def, source: "default" };
}

function envValueFor(key: string): string | undefined {
  return getEnv(key);
}

function profileProvider(profile: Profile, envProvider: ProviderId | undefined): ProviderId | undefined {
  return profile.provider ?? envProvider;
}

/** Read a provider key from the encrypted vault. Device-mode vaults unlock
 * automatically; passphrase-mode needs FREECODE_VAULT_PASSPHRASE. */
function vaultApiKey(provider: ProviderId): string | undefined {
  if (!Vault.exists()) return undefined;
  try {
    return Vault.load().get(provider);
  } catch {
    return undefined; // locked/corrupted — fall through to other sources
  }
}

// Key precedence: per-project profile key > vault > provider env var.
function profileApiKey(profile: Profile, provider: ProviderId): string | undefined {
  if (profile.apiKey) return profile.apiKey;
  const fromVault = vaultApiKey(provider);
  if (fromVault) return fromVault;
  const envKey = providerEnvKey(provider);
  return envKey ? getEnv(envKey) : undefined;
}

function providerEnvKey(p: ProviderId): string | undefined {
  switch (p) {
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "openai": return "OPENAI_API_KEY";
    case "gemini": return "GEMINI_API_KEY";
    case "github-models": return "GITHUB_TOKEN";
    case "openrouter": return "OPENROUTER_API_KEY";
    case "bedrock": return "AWS_ACCESS_KEY_ID";
    case "vertex": return "GOOGLE_APPLICATION_CREDENTIALS";
    case "ollama": return "OLLAMA_HOST";
    case "lmstudio": return "LMSTUDIO_HOST";
    case "nim": return getEnv("NVIDIA_API_KEY") ? "NVIDIA_API_KEY" : "NVIDIA_NIM_API_KEY";
    default: return undefined;
  }
}

// When no provider is explicitly chosen (flags/profile/env), prefer one that
// actually has a usable key — vault or env — over the hardcoded default. Without
// this, freecode boots pointing at anthropic with no key while the user's key
// (e.g. openai) sits in the vault.
// Does this provider have a key we can actually use? Local providers need none.
function hasUsableKey(p: ProviderId): boolean {
  if (p === "ollama" || p === "lmstudio") return true;
  if (vaultApiKey(p)) return true;
  const envKey = providerEnvKey(p);
  return !!(envKey && getEnv(envKey));
}

function firstProviderWithKey(): ProviderId | undefined {
  const order: ProviderId[] = ["anthropic", "openai", "gemini", "openrouter", "github-models", "nim"];
  let vaultProviders: string[] = [];
  try {
    if (Vault.exists()) vaultProviders = Vault.load().list();
  } catch {
    vaultProviders = [];
  }
  for (const p of order) {
    if (hasUsableKey(p)) return p;
  }
  return vaultProviders.length ? (vaultProviders[0] as ProviderId) : undefined;
}

// An explicit base-URL env override (undefined when unset) — separate from the
// hardcoded default below, so a remembered base URL can sit BETWEEN them: env
// override wins, then remembered, then the provider's built-in default.
function providerBaseUrlEnv(p: ProviderId): string | undefined {
  switch (p) {
    case "anthropic": return getEnv("ANTHROPIC_BASE_URL");
    case "openai": return getEnv("OPENAI_BASE_URL");
    case "gemini": return getEnv("GEMINI_BASE_URL");
    case "openrouter": return getEnv("OPENROUTER_BASE_URL");
    case "vertex": return getEnv("VERTEX_BASE_URL");
    case "ollama": return getEnv("OLLAMA_HOST");
    case "lmstudio": return getEnv("LMSTUDIO_HOST");
    case "nim": return getEnv("NVIDIA_NIM_BASE_URL") ?? getEnv("NIM_BASE_URL");
    default: return undefined;
  }
}

/** The provider's built-in default base URL (no env / no override). */
function providerBaseUrlDefault(p: ProviderId): string | undefined {
  switch (p) {
    case "github-models": return "https://models.inference.ai.azure.com";
    case "openrouter": return "https://openrouter.ai/api/v1";
    case "ollama": return "http://127.0.0.1:11434";
    case "lmstudio": return "http://127.0.0.1:1234";
    case "nim": return "https://integrate.api.nvidia.com/v1";
    default: return undefined;
  }
}

function defaultModelFor(p: ProviderId): string {
  switch (p) {
    case "anthropic": return "claude-sonnet-4-5";
    case "openai": return "gpt-4o";
    case "gemini": return "gemini-2.5-flash";
    case "github-models": return "gpt-4o";
    case "openrouter": return "anthropic/claude-3.7-sonnet";
    case "bedrock": return "anthropic.claude-sonnet-4-5-20250929";
    case "vertex": return "gemini-2.5-flash";
    case "ollama": return "llama3.2";
    case "lmstudio": return "local-model";
    case "nim": return "meta/llama-3.1-70b-instruct";
    case "mock": return "mock-1";
    default: return "claude-sonnet-4-5";
  }
}

export interface LoadOptions {
  flags: CliFlags;
  profilePath?: string;
  settingsPath?: string;
  lastSessionPath?: string;
}

export function loadConfig(opts: LoadOptions): ResolvedConfig {
  const profile = loadProfile(opts.profilePath ?? PROFILE_PATH);
  const settings: Settings = loadJsoncSettings(opts.settingsPath);
  const last = readLastSession(opts.lastSessionPath); // remembered provider/model (lowest priority)

  const explicitEnv = explicitEnvProvider(); // CLAUDE_CODE_USE_* — deliberate
  const envProvider = detectProviderFromEnv(); // incl. raw-key inference (auto-select)
  // Precedence: a deliberate choice (CLI flag / project profile) is absolute, then
  // an explicit CLAUDE_CODE_USE_* env flag, then the REMEMBERED last session (so we
  // reopen where you left off instead of auto-selecting whatever has a key), then
  // raw-key inference, then the first provider with any key.
  const deliberate = opts.flags.provider ?? profile.provider;
  let finalProvider: ProviderId;
  let providerSource: Source;
  if (deliberate) {
    finalProvider = deliberate;
    providerSource = opts.flags.provider !== undefined ? "cli" : "profile";
  } else if (explicitEnv && hasUsableKey(explicitEnv)) {
    finalProvider = explicitEnv;
    providerSource = "env";
  } else if (last.provider && hasUsableKey(last.provider)) {
    finalProvider = last.provider;
    providerSource = "settings";
  } else if (envProvider && hasUsableKey(envProvider)) {
    finalProvider = envProvider;
    providerSource = "env";
  } else {
    const withKey = firstProviderWithKey();
    finalProvider = withKey ?? envProvider ?? DEFAULTS.provider;
    providerSource = withKey ? "default" : envProvider ? "env" : "default";
  }

  const envModel = envValueFor("CLAUDE_CODE_MODEL") ?? envValueFor("OPENAI_MODEL") ?? envValueFor("ANTHROPIC_MODEL");
  // Use the remembered model only when it goes with the remembered provider, so
  // we never pair (say) a Claude model id with an auto-selected OpenAI provider.
  const rememberedModel = last.provider === finalProvider ? last.model : undefined;
  const modelPick = pick<string | undefined>(
    opts.flags.model,
    profile.model,
    envModel,
    settings.model,
    rememberedModel, // lowest-priority default; undefined → falls through to defaultModelFor below
  );
  const finalModel = modelPick.value ?? defaultModelFor(finalProvider);

  // Precedence: flag > profile > env override > remembered (only if its provider
  // matches) > the provider's built-in default. So a saved remote base URL sticks
  // across launches but an explicit flag/env still wins.
  const rememberedBaseUrl = last.provider === finalProvider ? last.baseUrl : undefined;
  const baseUrlPick = pick<string | undefined>(
    opts.flags.baseUrl,
    profile.baseUrl,
    providerBaseUrlEnv(finalProvider),
    rememberedBaseUrl,
    providerBaseUrlDefault(finalProvider),
  );
  const finalBaseUrl = baseUrlPick.value;

  const envApiKey = profileApiKey(profile, finalProvider);
  const apiKeyPick = pick<string | undefined>(
    opts.flags.apiKey,
    undefined,
    envApiKey,
    undefined,
    undefined,
  );
  const finalApiKey = apiKeyPick.value;

  const permPick = pick(
    opts.flags.permissionMode,
    undefined,
    envValueFor("CLAUDE_CODE_PERMISSION_MODE") as "manual" | "auto" | "bypass" | undefined,
    settings.permissionMode,
    DEFAULTS.permissionMode,
  );

  const themePick = pick(
    opts.flags.theme,
    undefined,
    envValueFor("CLAUDE_CODE_THEME") as "dark" | "light" | undefined,
    settings.theme,
    DEFAULTS.theme,
  );

  const webPick = pick(
    opts.flags.webSearchProvider,
    undefined,
    envValueFor("CLAUDE_CODE_WEB_SEARCH") as "duckduckgo" | "tavily" | "exa" | "firecrawl" | undefined,
    settings.webSearchProvider,
    DEFAULTS.webSearchProvider,
  );

  const turnsPick = pick<number | undefined>(
    opts.flags.maxTurns,
    undefined,
    envValueFor("CLAUDE_CODE_MAX_TURNS") ? Number.parseInt(envValueFor("CLAUDE_CODE_MAX_TURNS")!, 10) : undefined,
    settings.maxTurns,
    DEFAULTS.maxTurns,
  );

  // MRM (max requests/min) throttle: flag > env (FREECODE_MAX_RPM) > settings > off.
  const rpmEnv = envValueFor("FREECODE_MAX_RPM");
  const maxRpm = opts.flags.maxRequestsPerMinute
    ?? (rpmEnv !== undefined ? Number.parseInt(rpmEnv, 10) : undefined)
    ?? settings.maxRequestsPerMinute
    ?? 0;

  debug.log("config resolved", {
    provider: finalProvider,
    model: finalModel,
    baseUrl: finalBaseUrl,
    hasKey: !!finalApiKey,
    permMode: permPick.value,
    sources: {
      provider: providerSource,
      model: modelPick.source,
      baseUrl: baseUrlPick.source,
      apiKey: apiKeyPick.source,
    },
  });

  return {
    provider: finalProvider,
    baseUrl: finalBaseUrl,
    apiKey: finalApiKey,
    model: finalModel,
    permissionMode: permPick.value,
    webSearchProvider: webPick.value,
    theme: themePick.value,
    maxTurns: turnsPick.value ?? DEFAULTS.maxTurns,
    maxRequestsPerMinute: Number.isFinite(maxRpm) && maxRpm > 0 ? maxRpm : 0,
    contextThreshold: settings.contextThreshold ?? DEFAULTS.contextThreshold,
    enablePromptCache: settings.enablePromptCache ?? DEFAULTS.enablePromptCache,
    enableExtendedThinking: opts.flags.enableExtendedThinking ?? settings.enableExtendedThinking ?? DEFAULTS.enableExtendedThinking,
    mcpServers: settings.mcpServers,
    hooks: settings.hooks,
    verify: settings.verify,
    verifyMode: opts.flags.verifyMode ?? settings.verifyMode ?? "on",
    source: {
      provider: providerSource,
      model: modelPick.source as Source,
      baseUrl: baseUrlPick.source as Source,
      apiKey: apiKeyPick.source as Source,
    },
  };
}

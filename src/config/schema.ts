import { z } from "zod";

export const ProviderIdSchema = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "github-models",
  "bedrock",
  "vertex",
  "ollama",
  "lmstudio",
  "nim",
  "mock",
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const PermissionModeSchema = z.enum(["manual", "auto", "bypass"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ThemeNameSchema = z.enum(["dark", "light"]);
export type ThemeName = z.infer<typeof ThemeNameSchema>;

export const WebSearchProviderSchema = z.enum([
  "duckduckgo",
  "tavily",
  "exa",
  "firecrawl",
]);
export type WebSearchProvider = z.infer<typeof WebSearchProviderSchema>;

export const ProfileSchema = z.object({
  provider: ProviderIdSchema.optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  model: z.string().min(1).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const SettingsSchema = z.object({
  model: z.string().min(1).optional(),
  permissionMode: PermissionModeSchema.optional(),
  webSearchProvider: WebSearchProviderSchema.optional(),
  theme: ThemeNameSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  contextThreshold: z.number().min(0.1).max(1).optional(),
  enablePromptCache: z.boolean().optional(),
  enableExtendedThinking: z.boolean().optional(),
  extraEnv: z.record(z.string()).optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const ResolvedConfigSchema = z.object({
  provider: ProviderIdSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  permissionMode: PermissionModeSchema.default("manual"),
  webSearchProvider: WebSearchProviderSchema.default("duckduckgo"),
  theme: ThemeNameSchema.default("dark"),
  maxTurns: z.number().int().positive().default(50),
  contextThreshold: z.number().min(0.1).max(1).default(0.8),
  enablePromptCache: z.boolean().default(true),
  enableExtendedThinking: z.boolean().default(false),
  source: z.object({
    provider: z.enum(["cli", "profile", "env", "settings", "default"]),
    model: z.enum(["cli", "profile", "env", "settings", "default"]),
    baseUrl: z.enum(["cli", "profile", "env", "settings", "default"]),
    apiKey: z.enum(["cli", "profile", "env", "settings", "default"]),
  }),
});
export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;

import { z } from "zod";
import {
  APP_VERSION,
  DEFAULT_SYNC_INTERVAL_SECONDS,
  DEFAULT_TIMEZONE,
  type HarnessId,
} from "@shared/contracts";
import { defaultSourceRoots, resolvePaths } from "./paths.js";

export const CONFIG_VERSION = 1;

export const harnessIdSchema = z.enum(["pi", "codex", "opencode", "claude-code"]);

export const sourceConfigSchema = z.object({
  id: z.string().min(1),
  harness: harnessIdSchema,
  label: z.string().min(1),
  root: z.string().min(1),
  enabled: z.boolean(),
});
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export const providerAliasSchema = z.object({
  raw: z.string(),
  display: z.string(),
});
export type ProviderAlias = z.infer<typeof providerAliasSchema>;

export const providerOverrideSchema = z.object({
  harness: harnessIdSchema,
  rawProviderId: z.string().nullable(),
  rawModelId: z.string().nullable(),
  canonicalProviderId: z.string(),
  from: z.string().datetime().nullable(),
  to: z.string().datetime().nullable(),
});
export type ProviderOverride = z.infer<typeof providerOverrideSchema>;

export const modelAliasSchema = z.object({
  provider: z.string().nullable(),
  model: z.string(),
  canonicalModel: z.string(),
  owner: z.string().nullable(),
});
export type ModelAlias = z.infer<typeof modelAliasSchema>;

export const projectAliasSchema = z.object({
  paths: z.array(z.string()).min(1),
  canonicalProject: z.string(),
});
export type ProjectAlias = z.infer<typeof projectAliasSchema>;

export const observerConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  timezone: z.string().default(DEFAULT_TIMEZONE),
  syncIntervalSeconds: z.number().int().min(5).max(86_400).default(DEFAULT_SYNC_INTERVAL_SECONDS),
  historyCutoff: z.string().datetime().nullable().default(null),
  sources: z.array(sourceConfigSchema).default([]),
  providerAliases: z.array(providerAliasSchema).default([]),
  providerOverrides: z.array(providerOverrideSchema).default([]),
  modelAliases: z.array(modelAliasSchema).default([]),
  projectAliases: z.array(projectAliasSchema).default([]),
});
export type ObserverConfig = z.infer<typeof observerConfigSchema>;

export const APP_V = APP_VERSION;

/** Default provider display aliases for known providers. */
export const SEED_PROVIDER_ALIASES: ProviderAlias[] = [
  { raw: "openai", display: "OpenAI" },
  { raw: "anthropic", display: "Anthropic" },
  { raw: "google", display: "Google" },
  { raw: "openrouter", display: "OpenRouter" },
  { raw: "mistral", display: "Mistral" },
  { raw: "deepseek", display: "DeepSeek" },
  { raw: "x-ai", display: "xAI" },
  { raw: "groq", display: "Groq" },
  { raw: "together", display: "Together" },
  { raw: "fireworks", display: "Fireworks" },
];

/** Known canonical model owner + id pairs. */
export const SEED_MODEL_ALIASES: ModelAlias[] = [
  { provider: null, model: "gpt-5", canonicalModel: "gpt-5", owner: "openai" },
  { provider: null, model: "gpt-5-codex", canonicalModel: "gpt-5-codex", owner: "openai" },
  { provider: null, model: "gpt-4.1", canonicalModel: "gpt-4.1", owner: "openai" },
  { provider: null, model: "gpt-4.1-mini", canonicalModel: "gpt-4.1-mini", owner: "openai" },
  { provider: null, model: "gpt-4o", canonicalModel: "gpt-4o", owner: "openai" },
  { provider: null, model: "o3", canonicalModel: "o3", owner: "openai" },
  { provider: null, model: "o4-mini", canonicalModel: "o4-mini", owner: "openai" },
  { provider: null, model: "claude-opus-4", canonicalModel: "claude-opus-4", owner: "anthropic" },
  { provider: null, model: "claude-sonnet-4", canonicalModel: "claude-sonnet-4", owner: "anthropic" },
  { provider: null, model: "claude-3-7-sonnet", canonicalModel: "claude-3-7-sonnet", owner: "anthropic" },
  { provider: null, model: "claude-3-5-sonnet", canonicalModel: "claude-3-5-sonnet", owner: "anthropic" },
  { provider: null, model: "gemini-2.5-pro", canonicalModel: "gemini-2.5-pro", owner: "google" },
  { provider: null, model: "gemini-2.5-flash", canonicalModel: "gemini-2.5-flash", owner: "google" },
  { provider: null, model: "deepseek-v3", canonicalModel: "deepseek-v3", owner: "deepseek" },
  { provider: null, model: "grok-4", canonicalModel: "grok-4", owner: "x-ai" },
];

/** Build a fresh default config. */
export function defaultConfig(): ObserverConfig {
  const roots = defaultSourceRoots();
  return observerConfigSchema.parse({
    version: CONFIG_VERSION,
    timezone: DEFAULT_TIMEZONE,
    syncIntervalSeconds: DEFAULT_SYNC_INTERVAL_SECONDS,
    historyCutoff: null,
    sources: [
      { id: "pi-default", harness: "pi", label: "Pi", root: roots.pi, enabled: true },
      { id: "codex-sessions", harness: "codex", label: "Codex (sessions)", root: roots.codexSessions, enabled: true },
      { id: "codex-archived", harness: "codex", label: "Codex (archived)", root: roots.codexArchived, enabled: true },
    ],
    providerAliases: SEED_PROVIDER_ALIASES,
    providerOverrides: [],
    modelAliases: SEED_MODEL_ALIASES,
    projectAliases: [],
  });
}

export type { HarnessId };

export { resolvePaths };

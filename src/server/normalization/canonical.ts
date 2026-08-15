import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join, normalize as pathNormalize, sep } from "node:path";
import { normalizePath } from "../config/paths.js";
import type { ModelAlias, ProviderAlias, ProviderOverride, ProjectAlias } from "../config/schema.js";

/**
 * Known model owners, keyed by lowercased model id. Used to combine owner with
 * model id for canonical keys so routed forms (OpenAI direct vs OpenRouter)
 * collapse onto the same canonical model while provider attribution stays
 * separate.
 */
const OWNER_BY_MODEL: Record<string, string> = {
  "gpt-5": "openai",
  "gpt-5-codex": "openai",
  "gpt-4.1": "openai",
  "gpt-4.1-mini": "openai",
  "gpt-4.1-nano": "openai",
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-4-turbo": "openai",
  "gpt-3.5-turbo": "openai",
  "o1": "openai",
  "o1-mini": "openai",
  "o1-pro": "openai",
  "o3": "openai",
  "o3-mini": "openai",
  "o4-mini": "openai",
  "claude-opus-4": "anthropic",
  "claude-opus-4.1": "anthropic",
  "claude-sonnet-4": "anthropic",
  "claude-sonnet-4.5": "anthropic",
  "claude-haiku-4": "anthropic",
  "claude-3-7-sonnet": "anthropic",
  "claude-3-5-sonnet": "anthropic",
  "claude-3-5-haiku": "anthropic",
  "claude-3-opus": "anthropic",
  "gemini-2.5-pro": "google",
  "gemini-2.5-flash": "google",
  "gemini-2.0-flash": "google",
  "gemini-1.5-pro": "google",
  "deepseek-v3": "deepseek",
  "deepseek-v4-pro": "deepseek",
  "deepseek-r1": "deepseek",
  "deepseek-chat": "deepseek",
  "grok-4": "x-ai",
  "grok-3": "x-ai",
  "llama-3.3-70b": "meta",
  "minimax-m3": "minimax",
  "minimax-m2.7": "minimax",
};

/**
 * Provider routes that should roll up to the company serving the model.
 * Harnesses name the same serving company differently (OpenCode's coding-plan
 * endpoint, Pi's model-family provider id); routes collapse them onto one
 * canonical provider while raw attribution stays on the envelope.
 */
const PROVIDER_ROUTES: Record<string, string> = {
  "openai-codex": "openai",
  "glm": "zai",
  "zai-coding-plan": "zai",
  "kimi": "moonshot",
  "kimi-coding": "moonshot",
  "kimi-for-coding": "moonshot",
  "moonshot-ai": "moonshot",
};

export function modelOwner(rawModel: string | null): string | null {
  if (!rawModel) return null;
  const cleaned = stripRoutingPrefix(rawModel).toLowerCase();
  // Routed ids (OpenRouter-style `owner/model`) carry the family in the last
  // segment; derive the owner from there.
  const family = cleaned.includes("/") ? cleaned.split("/").pop()! : cleaned;
  // Anthropic model ids frequently carry dated or point-release suffixes
  // (for example claude-opus-4-6 or claude-sonnet-4-5-20250929).
  if (family.startsWith("claude-")) return "anthropic";
  // Z.AI point-releases and turbo variants follow the glm-<version> family.
  if (/^glm-\d/.test(family)) return "zai";
  // Moonshot's Kimi family (kimi-k2.6, kimi-k3, ...).
  if (/^kimi-k\d/.test(family)) return "moonshot";
  return OWNER_BY_MODEL[family] ?? OWNER_BY_MODEL[cleaned] ?? null;
}

/** Remove routing-only leading `~` and trim. */
export function stripRoutingPrefix(rawModel: string): string {
  let m = rawModel.trim();
  while (m.startsWith("~")) m = m.slice(1).trim();
  return m;
}

/** Routed model-id prefixes that should normalize onto the owner namespace. */
const MODEL_PREFIX_ROUTES: Record<string, string> = {
  moonshotai: "moonshot",
};

/**
 * Canonical model key. Lowercased, routing prefix removed, owner-combined.
 * `latest` / dated versions remain distinct unless aliased.
 */
export function canonicalizeModelId(rawModel: string | null, owner?: string | null): string | null {
  if (!rawModel) return null;
  const cleaned = stripRoutingPrefix(rawModel).toLowerCase();
  if (!cleaned) return null;
  const o = (owner ?? modelOwner(rawModel))?.toLowerCase();
  if (!o) return cleaned;
  // Avoid double-prefixing if the model id already carries an owner segment;
  // normalize known routing-only spellings onto the owner namespace.
  if (cleaned.includes("/")) {
    const [prefix, ...rest] = cleaned.split("/");
    const routed = MODEL_PREFIX_ROUTES[prefix] ?? prefix;
    return rest.length > 0 ? `${routed}/${rest.join("/")}` : cleaned;
  }
  return `${o}/${cleaned}`;
}

export function modelDisplay(rawModel: string | null, canonicalModelId: string | null): string {
  if (rawModel) return rawModel;
  return canonicalModelId ?? "unknown";
}

export function canonicalizeProviderId(rawProvider: string | null): string | null {
  if (!rawProvider) return null;
  const cleaned = rawProvider.trim().toLowerCase();
  return PROVIDER_ROUTES[cleaned] ?? cleaned;
}

export function providerDisplay(
  rawProvider: string | null,
  canonicalProvider: string | null,
  aliases: ProviderAlias[],
): string {
  if (rawProvider) {
    const hit = aliases.find((a) => a.raw.toLowerCase() === rawProvider.toLowerCase());
    if (hit) return hit.display;
    return rawProvider;
  }
  return canonicalProvider ?? "unknown";
}

/**
 * Resolve the project for a working directory.
 *
 * - Normalizes Windows paths case-insensitively.
 * - Walks upward to the nearest git root (dir or worktree .git file).
 * - If the directory no longer exists, retains the normalized recorded path.
 * - Applies project aliases (joining multiple clones) when present.
 */
export interface ProjectResolution {
  projectId: string;
  normalizedRootPath: string;
  displayPath: string;
  canonicalProject: string;
}

export function resolveProject(
  cwd: string | null,
  projectAliases: ProjectAlias[],
): ProjectResolution | null {
  if (!cwd) return null;
  const normalizedCwd = normalizePath(cwd);
  const exists = dirExists(normalizedCwd);
  const root = exists ? findGitRoot(normalizedCwd) : normalizedCwd;
  const displayPath = root;
  let canonicalProject = root;

  // Project alias: any normalized path under an alias group joins the group.
  for (const alias of projectAliases) {
    const normalizedAliasPaths = alias.paths.map((p) => normalizePath(p));
    if (normalizedAliasPaths.includes(root) || normalizedAliasPaths.includes(normalizedCwd)) {
      canonicalProject = alias.canonicalProject;
      break;
    }
  }

  const projectId = hashId("project", canonicalProject);
  return { projectId, normalizedRootPath: root, displayPath, canonicalProject };
}

function dirExists(normalized: string): boolean {
  try {
    return existsSync(normalized) && statSync(normalized).isDirectory();
  } catch {
    return false;
  }
}

/** Walk upward to nearest directory containing a `.git` file or directory. */
export function findGitRoot(normalizedStart: string): string {
  let current = normalizedStart;
  // Guard against infinite loop on drive roots.
  for (let i = 0; i < 64; i++) {
    const gitPath = join(current, ".git");
    if (existsSync(gitPath)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return normalizedStart;
}

export function hashId(namespace: string, key: string): string {
  return createHash("sha256").update(`${namespace}:${key}`).digest("hex").slice(0, 16);
}

/**
 * Resolution result for provider/model with precedence.
 *
 * Precedence: user-override > seed-alias > deterministic > unknown.
 */
export interface DimensionResolution {
  rawProviderId: string | null;
  canonicalProviderId: string | null;
  providerResolution: "source" | "seed-alias" | "user-override" | "unknown";
  rawModelId: string | null;
  canonicalModelId: string | null;
  modelResolution: "source" | "seed-alias" | "user-override" | "unknown";
  owner: string | null;
}

export function resolveDimensions(params: {
  harness: string;
  rawProviderId: string | null;
  rawModelId: string | null;
  cwd: string | null;
  occurredAt: string;
  providerAliases: ProviderAlias[];
  providerOverrides: ProviderOverride[];
  modelAliases: ModelAlias[];
}): DimensionResolution {
  const {
    harness,
    rawProviderId,
    rawModelId,
    occurredAt,
    providerOverrides,
    providerAliases: _providerAliases,
    modelAliases,
  } = params;

  const detProvider = canonicalizeProviderId(rawProviderId);
  const detOwner = modelOwner(rawModelId);
  const detModel = canonicalizeModelId(rawModelId, detOwner);

  // Provider: 1) user override (date-bounded, matching harness+raw provider/model)
  let canonicalProviderId = detProvider;
  let providerResolution: DimensionResolution["providerResolution"] = detProvider
    ? "source"
    : "unknown";
  let owner = detOwner;

  const override = providerOverrides.find((o) => {
    if (o.harness !== harness) return false;
    if (o.rawProviderId != null && o.rawProviderId.toLowerCase() !== (rawProviderId ?? "").toLowerCase())
      return false;
    if (o.rawModelId != null && o.rawModelId.toLowerCase() !== (rawModelId ?? "").toLowerCase())
      return false;
    const t = occurredAt;
    if (o.from && t < o.from) return false;
    if (o.to && t >= o.to) return false;
    return true;
  });
  if (override) {
    canonicalProviderId = override.canonicalProviderId.toLowerCase();
    providerResolution = "user-override";
  } else if (detProvider && detProvider !== (rawProviderId ?? "").toLowerCase()) {
    providerResolution = "seed-alias";
  }

  // Model: seed alias overrides deterministic canonical when present.
  let canonicalModelId = detModel;
  let modelResolution: DimensionResolution["modelResolution"] = detModel ? "source" : "unknown";
  if (rawModelId) {
    const cleaned = stripRoutingPrefix(rawModelId).toLowerCase();
    const alias = modelAliases.find(
      (m) => m.model.toLowerCase() === cleaned && (m.provider == null || m.provider.toLowerCase() === (canonicalProviderId ?? "")),
    );
    if (alias) {
      canonicalModelId = alias.owner
        ? `${alias.owner.toLowerCase()}/${alias.canonicalModel.toLowerCase()}`
        : alias.canonicalModel.toLowerCase();
      owner = alias.owner?.toLowerCase() ?? owner;
      modelResolution = alias.owner ? "seed-alias" : modelResolution;
    }
  }

  return {
    rawProviderId,
    canonicalProviderId,
    providerResolution,
    rawModelId,
    canonicalModelId,
    modelResolution,
    owner,
  };
}

export { normalizePath, pathNormalize, sep };

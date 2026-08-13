/** Shared contracts used across the server and client. */

export const HARNESS_IDS = ["pi", "codex", "opencode", "claude-code"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const PROVIDER_RESOLUTIONS = [
  "source",
  "seed-alias",
  "user-override",
  "unknown",
] as const;
export type ProviderResolution = (typeof PROVIDER_RESOLUTIONS)[number];

export const NORMALIZATION_STATUSES = ["normalized", "duplicate", "quarantined"] as const;
export type NormalizationStatus = (typeof NORMALIZATION_STATUSES)[number];

/** A normalized, deduplicated model usage event. */
export interface NormalizedUsageEvent {
  id: string;
  harness: HarnessId;
  occurredAt: string; // ISO 8601 UTC
  projectId: string | null;
  sessionId: string;
  turnId: string | null;
  requestId: string;

  rawProviderId: string | null;
  canonicalProviderId: string | null;
  providerResolution: ProviderResolution;

  rawModelId: string | null;
  canonicalModelId: string | null;

  processedInputTokens: number;
  freshInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWriteAvailable: boolean;

  outputTokens: number;
  reasoningOutputTokens: number | null;
  unattributedTokens: number;
  processedTokens: number;

  costUsd: number | null;
  qualityFlags: string[];
}

/** Sanitized usage-only envelope retained for re-normalization and inspection. */
export interface RawUsageEnvelope {
  harness: HarnessId;
  logicalSessionId: string;
  requestId: string;
  lineOrdinal: number;
  envelopeHash: string;
  occurredAt: string;
  sessionId: string;
  turnId: string | null;
  projectId: string | null;
  rawProviderId: string | null;
  rawModelId: string | null;
  cwd: string | null;
  parentId: string | null;
  usage: TokenUsageRecord;
  /** Only accounting/identity context — never prompts, code, or tool I/O. */
  context: Record<string, unknown>;
}

/** Normalized token accounting extracted from a raw record by a collector. */
export interface TokenUsageRecord {
  freshInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWriteAvailable: boolean;
  outputTokens: number;
  reasoningOutputTokens: number | null;
  reasoningAvailable: boolean;
  unattributedTokens: number;
  costUsd: number | null;
  costAvailable: boolean;
}

/** Quality flags attached to a normalized event. */
export const QUALITY_FLAGS = {
  MISSING_CACHE_WRITE: "missing-cache-write",
  MISSING_REASONING: "missing-reasoning",
  MISSING_COST: "missing-cost",
  QUARANTINED: "quarantined",
  DUPLICATE_TELEMETRY: "duplicate-telemetry",
} as const;

/* ----------------------------- API contracts ----------------------------- */

export interface HealthResponse {
  version: string;
  dbSchema: number;
  activeSync: { runId: string | null; phase: string | null };
  warningCount: number;
}

export interface SourceInfo {
  id: string;
  harness: HarnessId;
  label: string;
  root: string;
  enabled: boolean;
  present: boolean;
  adapterVersion: string;
  schemaFingerprint: string | null;
  lastSyncStartedAt: string | null;
  lastSyncFinishedAt: string | null;
  filesDiscovered: number;
  filesPresent: number;
  rawRecords: number;
  normalizedEvents: number;
  quarantined: number;
  duplicates: number;
  lastError: string | null;
}

export interface SyncTriggerResponse {
  runId: string;
  status: "coalesced" | "started";
}

export interface SyncRunInfo {
  id: string;
  trigger: "startup" | "timer" | "manual" | "rebuild" | "renormalize";
  startedAt: string;
  finishedAt: string | null;
  phase: "pending" | "running" | "completed" | "failed";
  progress: { current: number; total: number };
  imported: number;
  duplicates: number;
  quarantined: number;
  errors: string[];
  perSource: Array<{ sourceId: string; imported: number; duplicates: number; quarantined: number; error: string | null }>;
}

export interface DimensionLists {
  harnesses: HarnessId[];
  providers: Array<{ id: string; rawProviderId: string | null; display: string; eventCount: number }>;
  models: Array<{ id: string; canonicalModelId: string | null; display: string; owner: string | null; eventCount: number }>;
  projects: Array<{ id: string; path: string; eventCount: number }>;
}

export interface SummaryResponse {
  range: { from: string | null; to: string | null };
  filters: AppliedFilters;
  totals: SummaryTotals;
  coverage: SummaryCoverage;
}

export interface AppliedFilters {
  harness?: HarnessId[];
  provider?: string[];
  model?: string[];
  project?: string[];
}

export interface SummaryTotals {
  processedTokens: number;
  processedInputTokens: number;
  freshInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  unattributedTokens: number;
  costUsd: number;
  sessions: number;
  turns: number;
  requests: number;
  cacheHitRate: number | null;
  cacheReuseEfficiency: number | null;
  outputInputRatio: number | null;
  costCoverage: number | null;
}

export interface SummaryCoverage {
  costCoverage: number | null;
  classificationCoverage: number | null;
  reasoningAvailable: number;
  cacheWriteAvailable: number;
  costAvailable: number;
  total: number;
}

export interface EventsPage {
  items: NormalizedUsageEvent[];
  nextCursor: string | null;
  total: number;
}

export interface SanitizedConfig {
  configPath: string;
  dataDir: string;
  dbPath: string;
  version: number;
  timezone: string;
  syncIntervalSeconds: number;
  historyCutoff: string | null;
  sources: Array<{
    id: string;
    harness: HarnessId;
    label: string;
    root: string;
    enabled: boolean;
    resolvedRoot: string;
    present: boolean;
  }>;
  providerAliases: Array<{ raw: string; display: string }>;
  providerOverrides: Array<{
    harness: HarnessId;
    rawProviderId: string | null;
    rawModelId: string | null;
    canonicalProviderId: string;
    from: string | null;
    to: string | null;
  }>;
  modelAliases: Array<{ provider: string | null; model: string; canonicalModel: string; owner: string | null }>;
  projectAliases: Array<{ paths: string[]; canonicalProject: string }>;
}

export const APP_VERSION = "0.1.0";
export const DEFAULT_PORT = 4310;
export const DEFAULT_SYNC_INTERVAL_SECONDS = 60;
export const DEFAULT_TIMEZONE = "Europe/Berlin";
export const EVENT_PAGE_SIZE_DEFAULT = 100;
export const EVENT_PAGE_SIZE_MAX = 250;

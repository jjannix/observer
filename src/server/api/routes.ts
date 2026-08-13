import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import {
  APP_VERSION,
  EVENT_PAGE_SIZE_DEFAULT,
  type AppliedFilters,
  type HealthResponse,
  type SanitizedConfig,
  type SourceInfo,
  type SyncRunInfo,
} from "@shared/contracts";
import type { AppState } from "../state.js";
import { Analytics, type RangeFilters, type TimeseriesGroupBy, type TimeseriesMetric } from "./analytics.js";
import { observerConfigSchema, type ObserverConfig } from "../config/schema.js";
import { resolveProject } from "../normalization/canonical.js";

export function registerApi(app: FastifyInstance, state: AppState): void {
  const analytics = new Analytics(state.raw);

  app.get("/api/v1/health", async (): Promise<HealthResponse> => {
    const schemaVersion = (state.raw.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations`).get() as any).v;
    return {
      version: APP_VERSION,
      dbSchema: schemaVersion,
      activeSync: { runId: state.engine.activeRun(), phase: state.engine.isActive() ? "running" : null },
      warningCount: state.repo.countWarnings(),
    };
  });

  app.get("/api/v1/sources", async (): Promise<SourceInfo[]> => {
    return state.repo.listSources().map((s: any) => toSourceInfo(s));
  });

  app.post("/api/v1/sync", async (_req, reply) => {
    const result = state.engine.trigger("manual");
    reply.code(202);
    return result;
  });

  app.get("/api/v1/sync/:id", async (req): Promise<SyncRunInfo | null> => {
    const { id } = req.params as { id: string };
    return toSyncRunInfo(state.repo.getSyncRun(id));
  });

  app.get("/api/v1/dimensions", async () => analytics.dimensions());

  app.get("/api/v1/timeseries", async (req) => {
    const q = req.query as Record<string, unknown>;
    const metric = (typeof q.metric === "string" ? q.metric : "processedTokens") as TimeseriesMetric;
    const groupBy = (q.groupBy === "harness" ? "harness" : "provider") as TimeseriesGroupBy;
    return analytics.timeseries(parseFilters(q), metric, groupBy);
  });

  app.get("/api/v1/summary", async (req): Promise<unknown> => {
    return analytics.summary(parseFilters(req.query as Record<string, unknown>));
  });

  app.get("/api/v1/events", async (req) => {
    const q = req.query as Record<string, unknown>;
    const filters = parseFilters(q);
    const cursor = typeof q.cursor === "string" ? q.cursor : null;
    const pageSize = typeof q.pageSize === "string" ? Number(q.pageSize) : EVENT_PAGE_SIZE_DEFAULT;
    return analytics.events(filters, cursor, pageSize);
  });

  app.get("/api/v1/config", async (): Promise<SanitizedConfig> => sanitizeConfig(state));

  app.put("/api/v1/config", async (req, reply) => {
    const parsed = observerConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid-config", details: parsed.error.flatten() };
    }
    try {
      state.updateConfig(parsed.data);
    } catch (err) {
      reply.code(500);
      return { error: "persist-failed", message: (err as Error).message };
    }
    return sanitizeConfig(state);
  });

  app.post("/api/v1/renormalize", async (_req, reply) => {
    const result = state.engine.renormalize();
    reply.code(202);
    return result;
  });

  app.post("/api/v1/rebuild", async (req, reply) => {
    const body = (req.body ?? {}) as { confirm?: string };
    if (body.confirm !== "rebuild") {
      reply.code(400);
      return { error: "confirmation-required", message: 'POST {"confirm":"rebuild"} to confirm index rebuild.' };
    }
    const result = state.engine.rebuild();
    reply.code(202);
    return result;
  });
}

function parseFilters(q: Record<string, unknown>): RangeFilters {
  const f: RangeFilters = {};
  if (typeof q.from === "string" && q.from.length > 0) f.from = q.from;
  if (typeof q.to === "string" && q.to.length > 0) f.to = q.to;
  f.harness = asArray(q.harness) as AppliedFilters["harness"];
  f.provider = asArray(q.provider);
  f.model = asArray(q.model);
  f.project = asArray(q.project);
  return f;
}

function asArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  if (typeof v === "string" && v.length > 0) return v.split(",");
  return undefined;
}

function toSourceInfo(s: any): SourceInfo {
  return {
    id: s.id,
    harness: s.harness,
    label: s.label,
    root: s.root,
    enabled: !!s.enabled,
    present: !!s.present,
    adapterVersion: s.adapter_version,
    schemaFingerprint: s.schema_fingerprint,
    lastSyncStartedAt: s.last_sync_started_at,
    lastSyncFinishedAt: s.last_sync_finished_at,
    filesDiscovered: s.files_discovered,
    filesPresent: s.files_present,
    rawRecords: s.raw_records,
    normalizedEvents: s.normalized_events,
    quarantined: s.quarantined,
    duplicates: s.duplicates,
    lastError: s.last_error,
  };
}

function toSyncRunInfo(row: any): SyncRunInfo | null {
  if (!row) return null;
  return {
    id: row.id,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    phase: row.phase,
    progress: { current: row.progress_current, total: row.progress_total },
    imported: row.imported,
    duplicates: row.duplicates,
    quarantined: row.quarantined,
    errors: safeParseArray(row.errors_json),
    perSource: [],
  };
}

function safeParseArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function sanitizeConfig(state: AppState): SanitizedConfig {
  const cfg: ObserverConfig = state.getConfig();
  return {
    configPath: state.paths.configPath,
    dataDir: state.paths.dataDir,
    dbPath: state.paths.dbPath,
    version: cfg.version,
    timezone: cfg.timezone,
    syncIntervalSeconds: cfg.syncIntervalSeconds,
    historyCutoff: cfg.historyCutoff,
    sources: cfg.sources.map((s) => ({
      id: s.id,
      harness: s.harness,
      label: s.label,
      root: s.root,
      enabled: s.enabled,
      resolvedRoot: s.root,
      present: existsSync(s.root),
    })),
    providerAliases: cfg.providerAliases,
    providerOverrides: cfg.providerOverrides.map((o) => ({
      harness: o.harness,
      rawProviderId: o.rawProviderId,
      rawModelId: o.rawModelId,
      canonicalProviderId: o.canonicalProviderId,
      from: o.from,
      to: o.to,
    })),
    modelAliases: cfg.modelAliases,
    projectAliases: cfg.projectAliases.map((p) => ({
      paths: p.paths,
      canonicalProject: p.canonicalProject,
    })),
  };
}

void resolveProject; // reserved for future project-display enrichment

import type { RawDatabase } from "../db/index.js";
import type { ProviderBilling } from "../config/schema.js";
import type {
  SessionDetail,
  SessionModelUsage,
  SessionSummary,
  SessionsPage,
  SessionSort,
  SessionUsage,
  SortDirection,
} from "@shared/contracts";
import { buildWhere, rowToEvent, type RangeFilters } from "./analytics.js";
import {
  canonicalizeModelId,
  canonicalizeProviderId,
} from "../normalization/canonical.js";
import { nanoToUsd } from "../normalization/metrics.js";

const processed =
  "(e.processed_input_tokens + e.output_tokens + e.unattributed_tokens)";
const aggregates = `MIN(e.occurred_at) AS firstActivity, MAX(e.occurred_at) AS lastActivity,
  COUNT(*) AS requests, COUNT(DISTINCT e.turn_id) AS turns,
  SUM(e.turn_id IS NOT NULL) AS attributedRequests,
  SUM(${processed}) AS processedTokens,
  SUM(e.processed_input_tokens) AS processedInputTokens,
  SUM(e.fresh_input_tokens) AS freshInputTokens,
  SUM(e.cache_read_input_tokens) AS cacheReadInputTokens,
  SUM(e.cache_write_input_tokens) AS cacheWriteInputTokens,
  SUM(e.output_tokens) AS outputTokens,
  SUM(COALESCE(e.reasoning_output_tokens, 0)) AS reasoningOutputTokens,
  SUM(e.reasoning_output_tokens IS NOT NULL) AS reasoningAvailable,
  SUM(e.cache_write_available) AS cacheWriteAvailable,
  SUM(e.unattributed_tokens) AS unattributedTokens,
  SUM(CASE WHEN e.cost_available = 1 THEN e.cost_nano_usd END) AS costNano,
  SUM(e.cost_available = 1 AND e.cost_nano_usd IS NOT NULL) AS costAvailable,
  SUM(CASE WHEN e.cost_available = 1 AND e.cost_nano_usd IS NOT NULL THEN ${processed} ELSE 0 END) AS costedTokens`;

function usage(row: any): SessionUsage {
  return {
    firstActivity: row.firstActivity,
    lastActivity: row.lastActivity,
    requests: row.requests,
    turns: row.turns,
    attributedRequests: row.attributedRequests,
    processedTokens: row.processedTokens,
    processedInputTokens: row.processedInputTokens,
    freshInputTokens: row.freshInputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    cacheWriteInputTokens: row.cacheWriteInputTokens,
    outputTokens: row.outputTokens,
    reasoningOutputTokens: row.reasoningOutputTokens,
    reasoningAvailable: row.reasoningAvailable,
    cacheWriteAvailable: row.cacheWriteAvailable,
    unattributedTokens: row.unattributedTokens,
    costUsd: nanoToUsd(row.costNano),
    costAvailable: row.costAvailable,
    costCoverage:
      row.processedTokens > 0 ? row.costedTokens / row.processedTokens : null,
    cacheHitRate:
      row.processedInputTokens > 0
        ? row.cacheReadInputTokens / row.processedInputTokens
        : null,
  };
}

export class SessionAnalytics {
  constructor(private db: RawDatabase) {
    db.function(
      "session_project_name",
      { deterministic: true },
      (path: unknown) =>
        typeof path === "string"
          ? (path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ??
            "Unassigned")
          : "Unassigned",
    );
  }

  list(
    filters: RangeFilters,
    search = "",
    sort: SessionSort = "recent",
    page = 1,
    pageSize = 25,
    direction: SortDirection = "desc",
  ): SessionsPage {
    const { sql, params } = buildWhere(this.db, filters);
    // Search selects entire session groups. Searching a model must not discard
    // the other models' requests from that session's filtered totals.
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const having = search
      ? `HAVING e.session_id LIKE ? ESCAPE '\\'
      OR MAX(COALESCE(p.display_path, '') LIKE ? ESCAPE '\\')
      OR MAX(COALESCE(e.canonical_model_id, e.raw_model_id, '') LIKE ? ESCAPE '\\')`
      : "";
    const bindings = search ? [...params, pattern, pattern, pattern] : params;
    const base = `SELECT e.session_id AS sessionId, MIN(e.harness) AS harness,
      MIN(e.project_id) AS projectId, MIN(p.display_path) AS projectPath, session_project_name(MIN(p.display_path)) AS projectName,
      json_group_array(DISTINCT COALESCE(e.canonical_model_id, e.raw_model_id, 'unknown-model')) AS models,
      ${aggregates}
      FROM usage_events e LEFT JOIN projects p ON p.id = e.project_id
      ${sql} ${sql ? "AND" : "WHERE"} e.session_id IS NOT NULL
      GROUP BY e.session_id ${having}`;
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM (${base})`)
        .get(...bindings) as any
    ).n;
    const safeSize = Number.isFinite(pageSize)
      ? Math.min(100, Math.max(1, Math.floor(pageSize)))
      : 25;
    const requestedPage = Number.isFinite(page)
      ? Math.max(1, Math.floor(page))
      : 1;
    const safePage = Math.min(
      requestedPage,
      Math.max(1, Math.ceil(total / safeSize)),
    );
    const orderColumn =
      {
        recent: "lastActivity",
        tokens: "processedTokens",
        cost: "costNano",
        requests: "requests",
        project: "projectName COLLATE NOCASE",
        harness: "harness COLLATE NOCASE",
        cache:
          "CAST(cacheReadInputTokens AS REAL) / NULLIF(processedInputTokens, 0)",
      }[sort] ?? "lastActivity";
    const order = `${orderColumn} ${direction === "asc" ? "ASC" : "DESC"} NULLS LAST`;
    const rows = this.db
      .prepare(`${base} ORDER BY ${order}, sessionId ASC LIMIT ? OFFSET ?`)
      .all(...bindings, safeSize, (safePage - 1) * safeSize) as any[];
    return {
      items: rows.map(summary),
      total,
      page: safePage,
      pageSize: safeSize,
    };
  }

  detail(
    sessionId: string,
    filters: RangeFilters,
    billing: ProviderBilling[] = [],
  ): SessionDetail | null {
    const { sql, params } = buildWhere(this.db, { ...filters, sessionId });
    const row = this.db
      .prepare(
        `SELECT e.session_id AS sessionId, MIN(e.harness) AS harness,
      MIN(e.project_id) AS projectId, MIN(p.display_path) AS projectPath,
      json_group_array(DISTINCT COALESCE(e.canonical_model_id, e.raw_model_id, 'unknown-model')) AS models,
      ${aggregates} FROM usage_events e LEFT JOIN projects p ON p.id = e.project_id ${sql}`,
      )
      .get(...params) as any;
    if (!row?.requests) return null;
    const modelRows = this.db
      .prepare(
        `SELECT
      COALESCE(e.canonical_model_id, e.raw_model_id, 'unknown-model') AS model,
      COALESCE(e.canonical_provider_id, e.raw_provider_id, 'Unknown') AS provider,
      json_group_array(DISTINCT e.turn_id) AS turnIds, ${aggregates}
      FROM usage_events e ${sql} GROUP BY model, provider`,
      )
      .all(...params) as any[];
    const merged = new Map<string, any>();
    for (const modelRow of modelRows) {
      const model = canonicalizeModelId(modelRow.model) ?? modelRow.model;
      const provider =
        canonicalizeProviderId(modelRow.provider) ?? modelRow.provider;
      const key = JSON.stringify([model, provider]);
      const existing = merged.get(key);
      const turnIds = new Set(
        JSON.parse(modelRow.turnIds).filter((id: unknown) => id != null),
      );
      if (!existing) merged.set(key, { ...modelRow, model, provider, turnIds });
      else {
        for (const field of [
          "requests",
          "attributedRequests",
          "processedTokens",
          "processedInputTokens",
          "freshInputTokens",
          "cacheReadInputTokens",
          "cacheWriteInputTokens",
          "outputTokens",
          "reasoningOutputTokens",
          "reasoningAvailable",
          "cacheWriteAvailable",
          "unattributedTokens",
          "costAvailable",
          "costedTokens",
        ])
          existing[field] += modelRow[field];
        if (modelRow.costNano != null)
          existing.costNano = (existing.costNano ?? 0) + modelRow.costNano;
        existing.firstActivity = [
          existing.firstActivity,
          modelRow.firstActivity,
        ].sort()[0];
        existing.lastActivity = [existing.lastActivity, modelRow.lastActivity]
          .sort()
          .at(-1);
        for (const id of turnIds) existing.turnIds.add(id);
      }
    }
    const models: SessionModelUsage[] = [...merged.values()]
      .map(
        (modelRow): SessionModelUsage => ({
          ...usage({ ...modelRow, turns: modelRow.turnIds.size }),
          model: modelRow.model,
          provider: modelRow.provider,
          billingMode:
            billing.find(
              (item) =>
                (canonicalizeProviderId(item.provider) ?? item.provider) ===
                modelRow.provider,
            )?.mode ?? "unspecified",
        }),
      )
      .sort(
        (a, b) =>
          b.processedTokens - a.processedTokens ||
          a.model.localeCompare(b.model),
      );
    const start = Math.floor(Date.parse(row.firstActivity) / 1000);
    const width = Math.max(
      1,
      Math.ceil((Date.parse(row.lastActivity) / 1000 - start + 1) / 48),
    );
    const timeline = this.db
      .prepare(
        `SELECT CAST((unixepoch(e.occurred_at) - ?) / ? AS INTEGER) AS bucket,
      MIN(e.occurred_at) AS occurredAt, SUM(${processed}) AS processedTokens,
      SUM(e.output_tokens) AS outputTokens, COUNT(*) AS requests
      FROM usage_events e ${sql} GROUP BY bucket ORDER BY bucket`,
      )
      .all(start, width, ...params) as SessionDetail["timeline"];
    const largestRequests = this.db
      .prepare(
        `SELECT e.* FROM usage_events e ${sql}
      ORDER BY ${processed} DESC, e.occurred_at ASC, e.id ASC LIMIT 5`,
      )
      .all(...params)
      .map(rowToEvent);
    const flags = this.db
      .prepare(`SELECT DISTINCT quality_flags_json FROM usage_events e ${sql}`)
      .all(...params) as any[];
    const qualityFlags = new Set<string>();
    for (const flag of flags) {
      try {
        for (const value of JSON.parse(flag.quality_flags_json))
          if (typeof value === "string") qualityFlags.add(value);
      } catch {
        /* ignore legacy malformed flags */
      }
    }
    return {
      session: summary(row),
      models,
      timelineBucketSeconds: width,
      timeline,
      largestRequests,
      qualityFlags: [...qualityFlags].sort(),
      hasSubscription: models.some(
        (model) => model.billingMode === "subscription",
      ),
    };
  }
}

function summary(row: any): SessionSummary {
  const models = [
    ...new Set<string>(
      (JSON.parse(row.models) as string[]).map(
        (id) => canonicalizeModelId(id) ?? id,
      ),
    ),
  ];
  return {
    ...usage(row),
    sessionId: row.sessionId,
    harness: row.harness,
    projectId: row.projectId,
    projectPath: row.projectPath,
    models,
  };
}

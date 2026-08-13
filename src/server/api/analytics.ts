import type { RawDatabase } from "../db/index.js";
import { formatInTimeZone } from "date-fns-tz";
import {
  type AppliedFilters,
  type DimensionLists,
  type EventsPage,
  type NormalizedUsageEvent,
  type SummaryResponse,
  type SummaryTotals,
  EVENT_PAGE_SIZE_DEFAULT,
  EVENT_PAGE_SIZE_MAX,
} from "@shared/contracts";
import {
  nanoToUsd,
} from "../normalization/metrics.js";

export type TimeseriesMetric =
  | "processedTokens"
  | "processedInputTokens"
  | "outputTokens"
  | "freshInputTokens"
  | "cacheReadInputTokens"
  | "costUsd"
  | "requests";
export type TimeseriesGroupBy = "provider" | "harness";

export interface TimeseriesPoint {
  date: string; // Berlin calendar day "yyyy-MM-dd"
  provider: string;
  value: number;
}

export interface TimeseriesResponse {
  metric: TimeseriesMetric;
  groupBy: TimeseriesGroupBy;
  buckets: string[];
  providers: string[];
  points: TimeseriesPoint[];
}

export interface RangeFilters extends AppliedFilters {
  from?: string | null;
  to?: string | null;
}

function buildWhere(filters: RangeFilters): { sql: string; params: any[] } {
  const clauses: string[] = [];
  const params: any[] = [];
  if (filters.from) {
    clauses.push(`e.occurred_at >= ?`);
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push(`e.occurred_at < ?`); // exclusive
    params.push(filters.to);
  }
  if (filters.harness && filters.harness.length > 0) {
    clauses.push(`e.harness IN (${ph(filters.harness.length)})`);
    params.push(...filters.harness);
  }
  if (filters.provider && filters.provider.length > 0) {
    clauses.push(`e.canonical_provider_id IN (${ph(filters.provider.length)})`);
    params.push(...filters.provider);
  }
  if (filters.model && filters.model.length > 0) {
    clauses.push(`e.canonical_model_id IN (${ph(filters.model.length)})`);
    params.push(...filters.model);
  }
  if (filters.project && filters.project.length > 0) {
    clauses.push(`e.project_id IN (${ph(filters.project.length)})`);
    params.push(...filters.project);
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function ph(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

export class Analytics {
  constructor(private db: RawDatabase) {}

  summary(filters: RangeFilters): SummaryResponse {
    const { sql, params } = buildWhere(filters);
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(e.processed_input_tokens),0) AS processedInputTokens,
           COALESCE(SUM(e.fresh_input_tokens),0) AS freshInputTokens,
           COALESCE(SUM(e.cache_read_input_tokens),0) AS cacheReadInputTokens,
           COALESCE(SUM(e.cache_write_input_tokens),0) AS cacheWriteInputTokens,
           COALESCE(SUM(e.output_tokens),0) AS outputTokens,
           COALESCE(SUM(CASE WHEN e.reasoning_output_tokens IS NULL THEN 0 ELSE e.reasoning_output_tokens END),0) AS reasoningOutputTokens,
           COALESCE(SUM(e.unattributed_tokens),0) AS unattributedTokens,
           COALESCE(SUM(e.processed_tokens),0) AS processedTokens,
           COALESCE(SUM(CASE WHEN e.cost_available THEN e.cost_nano_usd ELSE 0 END),0) AS costNano,
           COALESCE(SUM(CASE WHEN e.cost_available THEN e.processed_tokens ELSE 0 END),0) AS costCoverageTokens,
           COALESCE(SUM(CASE WHEN e.cache_write_available THEN e.cache_read_input_tokens ELSE 0 END),0) AS cwRead,
           COALESCE(SUM(CASE WHEN e.cache_write_available THEN e.cache_write_input_tokens ELSE 0 END),0) AS cwWrite,
           COUNT(DISTINCT e.session_id) AS sessions,
           COUNT(DISTINCT e.turn_id) AS turns,
           COUNT(*) AS requests,
           SUM(CASE WHEN e.reasoning_output_tokens IS NOT NULL THEN 1 ELSE 0 END) AS reasoningAvailable,
           SUM(CASE WHEN e.cache_write_available THEN 1 ELSE 0 END) AS cacheWriteAvailable,
           SUM(CASE WHEN e.cost_available THEN 1 ELSE 0 END) AS costAvailable,
           COUNT(*) AS total
         FROM usage_events e ${sql}`,
      )
      .get(...params) as any;

    const processedInput = row.processedInputTokens ?? 0;
    const cacheHitRate = processedInput > 0 ? row.cacheReadInputTokens / processedInput : null;
    const cwWrite = row.cwWrite ?? 0;
    const cacheReuseEfficiency =
      row.total > 0 && row.cacheWriteAvailable === row.total && cwWrite > 0
        ? (row.cwRead ?? 0) / cwWrite
        : null;
    const outputInputRatio = processedInput > 0 ? (row.outputTokens ?? 0) / processedInput : null;
    const costCoverage =
      (row.processedTokens ?? 0) > 0 ? (row.costCoverageTokens ?? 0) / (row.processedTokens ?? 0) : null;
    const classificationCoverage =
      (row.processedTokens ?? 0) > 0
        ? ((row.processedInputTokens ?? 0) + (row.outputTokens ?? 0)) / (row.processedTokens ?? 0)
        : null;

    const totals: SummaryTotals = {
      processedTokens: row.processedTokens ?? 0,
      processedInputTokens: row.processedInputTokens ?? 0,
      freshInputTokens: row.freshInputTokens ?? 0,
      cacheReadInputTokens: row.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: row.cacheWriteInputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      reasoningOutputTokens: row.reasoningOutputTokens ?? 0,
      unattributedTokens: row.unattributedTokens ?? 0,
      costUsd: nanoToUsd(row.costNano ?? 0) ?? 0,
      sessions: row.sessions ?? 0,
      turns: row.turns ?? 0,
      requests: row.requests ?? 0,
      cacheHitRate,
      cacheReuseEfficiency,
      outputInputRatio,
      costCoverage,
    };

    return {
      range: { from: filters.from ?? null, to: filters.to ?? null },
      filters,
      totals,
      coverage: {
        costCoverage,
        classificationCoverage,
        reasoningAvailable: row.reasoningAvailable ?? 0,
        cacheWriteAvailable: row.cacheWriteAvailable ?? 0,
        costAvailable: row.costAvailable ?? 0,
        total: row.total ?? 0,
      },
    };
  }

  events(filters: RangeFilters, cursor: string | null, pageSize: number): EventsPage {
    const size = Math.min(Math.max(1, pageSize || EVENT_PAGE_SIZE_DEFAULT), EVENT_PAGE_SIZE_MAX);
    const { sql, params } = buildWhere(filters);

    const cursorClause: string[] = [];
    const cursorParams: any[] = [];
    if (cursor) {
      const [ts, id] = decodeCursor(cursor);
      cursorClause.push(`AND (e.occurred_at > ? OR (e.occurred_at = ? AND e.id > ?))`);
      cursorParams.push(ts, ts, id);
    }

    const rows = this.db
      .prepare(
        `SELECT e.* FROM usage_events e ${sql}
         ${sql ? "AND" : "WHERE"} 1=1 ${cursorClause.join(" ")}
         ORDER BY e.occurred_at ASC, e.id ASC LIMIT ?`,
      )
      .all(...params, ...cursorParams, size + 1) as any[];

    const hasMore = rows.length > size;
    const page = rows.slice(0, size);
    const items = page.map(rowToEvent);
    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = encodeCursor(last.occurred_at, last.id);
    }

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM usage_events e ${sql}`)
      .get(...params) as any;

    return { items, nextCursor, total: totalRow?.c ?? 0 };
  }

  dimensions(): DimensionLists {
    const providers = this.db
      .prepare(
        `SELECT canonical_provider_id AS id, MAX(raw_provider_id) AS rawProviderId,
                canonical_provider_id AS canonical, COUNT(*) AS eventCount
         FROM usage_events WHERE canonical_provider_id IS NOT NULL
         GROUP BY canonical_provider_id ORDER BY eventCount DESC`,
      )
      .all() as any[];
    const models = this.db
      .prepare(
        `SELECT m.id, m.canonical_model_id AS canonicalModelId, m.display,
                m.owner, COUNT(e.id) AS eventCount
         FROM models m LEFT JOIN usage_events e ON e.canonical_model_id = m.id
         GROUP BY m.id ORDER BY eventCount DESC`,
      )
      .all() as any[];
    const projects = this.db
      .prepare(
        `SELECT p.id, p.display_path AS path, COUNT(e.id) AS eventCount
         FROM projects p LEFT JOIN usage_events e ON e.project_id = p.id
         GROUP BY p.id ORDER BY eventCount DESC`,
      )
      .all() as any[];
    const harnesses = (this.db
      .prepare(`SELECT DISTINCT harness FROM usage_events ORDER BY harness`)
      .all() as any[]).map((r) => r.harness);

    return {
      harnesses,
      providers: providers.map((p) => ({
        id: p.id,
        rawProviderId: p.rawProviderId,
        display: p.canonical ?? p.id,
        eventCount: p.eventCount ?? 0,
      })),
      models: models.map((m) => ({
        id: m.id,
        canonicalModelId: m.canonicalModelId,
        display: m.display ?? m.canonicalModelId,
        owner: m.owner ?? null,
        eventCount: m.eventCount ?? 0,
      })),
      projects: projects.map((p) => ({ id: p.id, path: p.path, eventCount: p.eventCount ?? 0 })),
    };
  }

  /**
   * Daily time series bucketed by Europe/Berlin calendar day, grouped by
   * the requested dimension. One value per (day, series) for the chosen metric.
   * Buckets fill the full range (inclusive of empty days) for stable charting.
   */
  timeseries(filters: RangeFilters, metric: TimeseriesMetric, groupBy: TimeseriesGroupBy = "provider", timezone = "Europe/Berlin"): TimeseriesResponse {
    const { sql, params } = buildWhere(filters);
    const dimension = groupBy === "harness" ? "e.harness" : "COALESCE(e.canonical_provider_id, 'unknown')";
    const rows = this.db
      .prepare(
        `SELECT e.occurred_at, ${dimension} AS provider,
                e.processed_tokens, e.processed_input_tokens, e.fresh_input_tokens,
                e.cache_read_input_tokens, e.output_tokens, e.cost_nano_usd, e.cost_available
         FROM usage_events e ${sql}
         ORDER BY e.occurred_at ASC`,
      )
      .all(...params) as any[];

    // Resolve the bucket range from the data (or fall back to the filter window).
    let minDate: string | null = null;
    let maxDate: string | null = null;
    const acc = new Map<string, number>(); // `${date}|${provider}` -> value

    for (const r of rows) {
      const day = formatInTimeZone(r.occurred_at, timezone, "yyyy-MM-dd");
      if (minDate === null || day < minDate) minDate = day;
      if (maxDate === null || day > maxDate) maxDate = day;
      const key = `${day}|${r.provider}`;
      acc.set(key, (acc.get(key) ?? 0) + rowMetric(r, metric));
    }

    // If filter window is explicit and outside the data, extend to it.
    const fromDay = filters.from ? formatInTimeZone(filters.from, timezone, "yyyy-MM-dd") : minDate;
    const toDay = filters.to ? formatInTimeZone(new Date(Date.parse(filters.to) - 1).toISOString(), timezone, "yyyy-MM-dd") : maxDate;

    const fallback = formatInTimeZone(new Date().toISOString(), timezone, "yyyy-MM-dd");
    const start = fromDay ?? toDay ?? fallback;
    const end = toDay ?? fromDay ?? fallback;
    const buckets = fillDays(start, end);
    const providers = Array.from(new Set(rows.map((r) => r.provider))).sort();

    const points: TimeseriesPoint[] = [];
    for (const date of buckets) {
      for (const provider of providers) {
        const v = acc.get(`${date}|${provider}`) ?? 0;
        if (v > 0) points.push({ date, provider, value: v });
      }
    }

    return { metric, groupBy, buckets, providers, points };
  }
}

function rowMetric(r: any, metric: TimeseriesMetric): number {
  switch (metric) {
    case "processedTokens": return r.processed_tokens ?? 0;
    case "processedInputTokens": return r.processed_input_tokens ?? 0;
    case "outputTokens": return r.output_tokens ?? 0;
    case "freshInputTokens": return r.fresh_input_tokens ?? 0;
    case "cacheReadInputTokens": return r.cache_read_input_tokens ?? 0;
    case "costUsd": return r.cost_available ? r.cost_nano_usd ?? 0 : 0;
    case "requests": return 1;
  }
}

/** Inclusive list of "yyyy-MM-dd" days from start..end (max 1000). */
function fillDays(start: string, end: string): string[] {
  const out: string[] = [];
  const s = new Date(`${start}T00:00:00Z`).getTime();
  let e = new Date(`${end}T00:00:00Z`).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return out;
  if (e < s) e = s;
  for (let t = s, i = 0; t <= e && i < 1000; t += 86_400_000, i++) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`).toString("base64url");
}
function decodeCursor(cursor: string): [string, string] {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = decoded.lastIndexOf("|");
  return [decoded.slice(0, sep), decoded.slice(sep + 1)];
}

function rowToEvent(r: any): NormalizedUsageEvent {
  return {
    id: r.id,
    harness: r.harness,
    occurredAt: r.occurred_at,
    projectId: r.project_id,
    sessionId: r.session_id,
    turnId: r.turn_id,
    requestId: r.request_id,
    rawProviderId: r.raw_provider_id,
    canonicalProviderId: r.canonical_provider_id,
    providerResolution: r.provider_resolution,
    rawModelId: r.raw_model_id,
    canonicalModelId: r.canonical_model_id,
    processedInputTokens: r.processed_input_tokens,
    freshInputTokens: r.fresh_input_tokens,
    cacheReadInputTokens: r.cache_read_input_tokens,
    cacheWriteInputTokens: r.cache_write_input_tokens,
    cacheWriteAvailable: !!r.cache_write_available,
    outputTokens: r.output_tokens,
    reasoningOutputTokens: r.reasoning_output_tokens,
    unattributedTokens: r.unattributed_tokens,
    processedTokens: r.processed_tokens,
    costUsd: nanoToUsd(r.cost_available ? r.cost_nano_usd : null),
    qualityFlags: safeParseJsonArray(r.quality_flags_json),
  };
}

function safeParseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

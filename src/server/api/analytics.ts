import type { RawDatabase } from "../db/index.js";
import { formatInTimeZone } from "date-fns-tz";
import {
  type AppliedFilters,
  type DimensionLists,
  type EventsPage,
  type ModelBreakdownItem,
  type ModelsBreakdownResponse,
  type NormalizedUsageEvent,
  type SummaryResponse,
  type SummaryTotals,
  EVENT_PAGE_SIZE_DEFAULT,
  EVENT_PAGE_SIZE_MAX,
} from "@shared/contracts";
import {
  nanoToUsd,
} from "../normalization/metrics.js";
import {
  canonicalizeModelId,
  canonicalizeProviderId,
  modelDisplay,
  modelOwner,
} from "../normalization/canonical.js";

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

function expandProviderFilter(db: RawDatabase, requestedProviders: string[]): string[] {
  const selectedCanonicals = new Set(
    requestedProviders.map((provider) => canonicalizeProviderId(provider) ?? provider),
  );
  try {
    const stored = db
      .prepare(
        `SELECT DISTINCT canonical_provider_id AS providerId
         FROM usage_events WHERE canonical_provider_id IS NOT NULL`,
      )
      .all() as Array<{ providerId: string }>;
    const matched = new Set<string>();
    for (const row of stored) {
      const canonical = canonicalizeProviderId(row.providerId) ?? row.providerId;
      if (selectedCanonicals.has(canonical)) {
        matched.add(row.providerId);
      }
    }
    for (const c of selectedCanonicals) {
      matched.add(c);
    }
    for (const r of requestedProviders) {
      matched.add(r);
    }
    return Array.from(matched);
  } catch {
    return requestedProviders;
  }
}

function buildWhere(db: RawDatabase, filters: RangeFilters): { sql: string; params: any[] } {
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
    const expanded = expandProviderFilter(db, filters.provider);
    clauses.push(`e.canonical_provider_id IN (${ph(expanded.length)})`);
    params.push(...expanded);
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

/**
 * Resolve a display name for a canonical provider id using every raw
 * spelling seen on events plus the user's provider aliases. Generic for any
 * routed family: whichever raw id (zai, glm, zai-coding-plan, ...) maps onto
 * the canonical id contributes its alias label; the id itself is the
 * fallback. Unknown stays explicit.
 */
function providerDisplayNameFactory(
  db: RawDatabase,
  providerAliases: Array<{ raw: string; display: string }>,
): (canonicalId: string) => string {
  const aliasByRaw = new Map(providerAliases.map((alias) => [alias.raw.toLowerCase(), alias.display]));
  const byCanonical = new Map<string, string>();
  try {
    const pairs = db
      .prepare(
        `SELECT DISTINCT raw_provider_id AS raw, canonical_provider_id AS canonical
         FROM usage_events WHERE raw_provider_id IS NOT NULL`,
      )
      .all() as Array<{ raw: string; canonical: string | null }>;
    for (const pair of pairs) {
      const canonical = canonicalizeProviderId(pair.canonical ?? pair.raw) ?? pair.raw;
      const display = aliasByRaw.get(pair.raw.toLowerCase());
      if (display && !byCanonical.has(canonical)) byCanonical.set(canonical, display);
      if (pair.raw.toLowerCase() === canonical && display) byCanonical.set(canonical, display);
    }
  } catch {
  }
  return (canonicalId: string) => {
    if (canonicalId === "unknown") return "Unknown provider";
    return byCanonical.get(canonicalId) ?? aliasByRaw.get(canonicalId) ?? canonicalId;
  };
}

export class Analytics {
  constructor(private db: RawDatabase) {}

  summary(filters: RangeFilters): SummaryResponse {
    const { sql, params } = buildWhere(this.db, filters);
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
    const { sql, params } = buildWhere(this.db, filters);

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

  dimensions(providerAliases: Array<{ raw: string; display: string }> = []): DimensionLists {
    const rawProviders = this.db
      .prepare(
        `SELECT canonical_provider_id AS id, MAX(raw_provider_id) AS rawProviderId,
                canonical_provider_id AS canonical, COUNT(*) AS eventCount
         FROM usage_events WHERE canonical_provider_id IS NOT NULL
         GROUP BY canonical_provider_id ORDER BY eventCount DESC`,
      )
      .all() as any[];

    const displayFor = providerDisplayNameFactory(this.db, providerAliases);

    const providerMap = new Map<string, { id: string; rawProviderId: string | null; eventCount: number }>();
    for (const p of rawProviders) {
      const canonicalId = canonicalizeProviderId(p.id) ?? p.id;
      const existing = providerMap.get(canonicalId);
      if (!existing) {
        providerMap.set(canonicalId, {
          id: canonicalId,
          rawProviderId: p.rawProviderId ?? null,
          eventCount: p.eventCount ?? 0,
        });
      } else {
        existing.eventCount += (p.eventCount ?? 0);
        if (p.rawProviderId && (!existing.rawProviderId || p.rawProviderId.toLowerCase() === canonicalId)) {
          existing.rawProviderId = p.rawProviderId;
        }
      }
    }

    const providers = Array.from(providerMap.values())
      .sort((a, b) => b.eventCount - a.eventCount)
      .map((p) => ({
        id: p.id,
        rawProviderId: p.rawProviderId,
        display: displayFor(p.id),
        eventCount: p.eventCount,
      }));

    const models = this.db
      .prepare(
        `SELECT m.id, m.canonical_model_id AS canonicalModelId, m.display,
                m.owner, COUNT(e.id) AS eventCount,
                COALESCE(SUM(e.processed_tokens), 0) AS totalTokens
         FROM models m LEFT JOIN usage_events e ON e.canonical_model_id = m.id
         GROUP BY m.id ORDER BY totalTokens DESC, eventCount DESC`,
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
      providers,
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
    const { sql, params } = buildWhere(this.db, filters);
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
    const seriesKeys = new Set<string>();

    for (const r of rows) {
      const day = formatInTimeZone(r.occurred_at, timezone, "yyyy-MM-dd");
      if (minDate === null || day < minDate) minDate = day;
      if (maxDate === null || day > maxDate) maxDate = day;
      const series = groupBy === "harness"
        ? r.provider
        : (r.provider === "unknown" ? "unknown" : (canonicalizeProviderId(r.provider) ?? r.provider));
      seriesKeys.add(series);
      const key = `${day}|${series}`;
      acc.set(key, (acc.get(key) ?? 0) + rowMetric(r, metric));
    }

    // If filter window is explicit and outside the data, extend to it.
    const fromDay = filters.from ? formatInTimeZone(filters.from, timezone, "yyyy-MM-dd") : minDate;
    const toDay = filters.to ? formatInTimeZone(new Date(Date.parse(filters.to) - 1).toISOString(), timezone, "yyyy-MM-dd") : maxDate;

    const fallback = formatInTimeZone(new Date().toISOString(), timezone, "yyyy-MM-dd");
    const start = fromDay ?? toDay ?? fallback;
    const end = toDay ?? fromDay ?? fallback;
    const buckets = fillDays(start, end);
    const providers = Array.from(seriesKeys).sort();

    const points: TimeseriesPoint[] = [];
    for (const date of buckets) {
      for (const provider of providers) {
        const v = acc.get(`${date}|${provider}`) ?? 0;
        if (v > 0) points.push({ date, provider, value: v });
      }
    }

    return { metric, groupBy, buckets, providers, points };
  }

  modelsBreakdown(filters: RangeFilters): ModelsBreakdownResponse {
    const { sql, params } = buildWhere(this.db, filters);
    const rows = this.db
      .prepare(
        `SELECT
           COALESCE(e.canonical_model_id, 'unknown') AS modelId,
           MAX(e.raw_model_id) AS rawModelId,
           COALESCE(SUM(e.processed_tokens), 0) AS processedTokens,
           COALESCE(SUM(e.processed_input_tokens), 0) AS processedInputTokens,
           COALESCE(SUM(e.fresh_input_tokens), 0) AS freshInputTokens,
           COALESCE(SUM(e.cache_read_input_tokens), 0) AS cacheReadInputTokens,
           COALESCE(SUM(e.output_tokens), 0) AS outputTokens,
           COALESCE(SUM(CASE WHEN e.cost_available THEN e.cost_nano_usd ELSE 0 END), 0) AS costNano,
           COUNT(DISTINCT e.session_id) AS sessions
         FROM usage_events e ${sql}
         GROUP BY COALESCE(e.canonical_model_id, 'unknown')
         HAVING SUM(e.processed_tokens) > 0
         ORDER BY processedTokens DESC`,
      )
      .all(...params) as any[];

    const modelMeta = new Map<string, { display: string | null; owner: string | null; canonicalModelId: string | null }>();
    try {
      const storedModels = this.db
        .prepare(`SELECT id, canonical_model_id AS canonicalModelId, display, owner FROM models`)
        .all() as any[];
      for (const m of storedModels) {
        modelMeta.set(m.id, { display: m.display, owner: m.owner, canonicalModelId: m.canonicalModelId });
      }
    } catch {
    }

    interface MergedModel {
      id: string;
      canonicalModelId: string | null;
      rawModelId: string | null;
      display: string;
      owner: string | null;
      processedTokens: number;
      processedInputTokens: number;
      freshInputTokens: number;
      cacheReadInputTokens: number;
      outputTokens: number;
      costNano: number;
      sessions: number;
    }

    const modelMap = new Map<string, MergedModel>();

    for (const r of rows) {
      const meta = modelMeta.get(r.modelId);
      const rawOrCanon = r.modelId === "unknown" ? (r.rawModelId ?? "unknown") : r.modelId;
      const canonicalId = r.modelId === "unknown" ? "unknown" : (canonicalizeModelId(rawOrCanon) ?? rawOrCanon);
      const existing = modelMap.get(canonicalId);
      const owner = meta?.owner ?? modelOwner(canonicalId) ?? null;
      const display = meta?.display ?? modelDisplay(r.rawModelId, canonicalId);

      if (!existing) {
        modelMap.set(canonicalId, {
          id: canonicalId,
          canonicalModelId: canonicalId === "unknown" ? null : canonicalId,
          rawModelId: r.rawModelId ?? null,
          display,
          owner,
          processedTokens: r.processedTokens,
          processedInputTokens: r.processedInputTokens,
          freshInputTokens: r.freshInputTokens,
          cacheReadInputTokens: r.cacheReadInputTokens,
          outputTokens: r.outputTokens,
          costNano: r.costNano,
          sessions: r.sessions,
        });
      } else {
        existing.processedTokens += r.processedTokens;
        existing.processedInputTokens += r.processedInputTokens;
        existing.freshInputTokens += r.freshInputTokens;
        existing.cacheReadInputTokens += r.cacheReadInputTokens;
        existing.outputTokens += r.outputTokens;
        existing.costNano += r.costNano;
        existing.sessions += r.sessions;
        if (!existing.rawModelId && r.rawModelId) existing.rawModelId = r.rawModelId;
      }
    }

    const models: ModelBreakdownItem[] = Array.from(modelMap.values())
      .sort((a, b) => b.processedTokens - a.processedTokens)
      .map((m) => {
        const processedInput = m.processedInputTokens;
        const cacheHitRate = processedInput > 0 ? m.cacheReadInputTokens / processedInput : null;
        return {
          id: m.id,
          canonicalModelId: m.canonicalModelId,
          rawModelId: m.rawModelId,
          display: m.display,
          owner: m.owner,
          processedTokens: m.processedTokens,
          processedInputTokens: m.processedInputTokens,
          freshInputTokens: m.freshInputTokens,
          cacheReadInputTokens: m.cacheReadInputTokens,
          outputTokens: m.outputTokens,
          costUsd: nanoToUsd(m.costNano) ?? 0,
          sessions: m.sessions,
          cacheHitRate,
        };
      });

    return {
      range: { from: filters.from ?? null, to: filters.to ?? null },
      filters,
      models,
    };
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

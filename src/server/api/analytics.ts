import type { RawDatabase } from "../db/index.js";
import { formatInTimeZone } from "date-fns-tz";
import {
  type AppliedFilters,
  type CacheAttributionResponse,
  type DimensionLists,
  type EventsPage,
  type RequestSort,
  type SortDirection,
  type LargestSessionRow,
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
import type { ProviderBilling } from "../config/schema.js";

export type TimeseriesMetric =
  | "processedTokens"
  | "processedInputTokens"
  | "outputTokens"
  | "freshInputTokens"
  | "cacheReadInputTokens"
  | "cacheHitRate"
  | "costUsd"
  | "requests";
export type TimeseriesGroupBy = "provider" | "harness" | "model";

const MIN_COMPARABLE_PROVIDER_INPUT_TOKENS = 1_000_000;
const MIN_COMPARABLE_PROVIDER_SHARE = 0.05;
const MAX_COMPARABLE_INPUT_RATIO = 20;

export interface TimeseriesPoint {
  date: string; // Berlin calendar day "yyyy-MM-dd"
  provider: string;
  value: number;
  inputTokens?: number; // Denominator for token-weighted cache hit rates.
}

export interface TimeseriesResponse {
  metric: TimeseriesMetric;
  groupBy: TimeseriesGroupBy;
  buckets: string[];
  providers: string[];
  points: TimeseriesPoint[];
}

export interface RangeFilters extends AppliedFilters {
  sessionId?: string;
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

function expandModelFilter(db: RawDatabase, requestedModels: string[]): string[] {
  const selectedCanonicals = new Set(
    requestedModels.map((model) => canonicalizeModelId(model) ?? model),
  );
  try {
    const stored = db
      .prepare(
        `SELECT DISTINCT canonical_model_id AS modelId
         FROM usage_events WHERE canonical_model_id IS NOT NULL`,
      )
      .all() as Array<{ modelId: string }>;
    const matched = new Set<string>();
    for (const row of stored) {
      const canonical = canonicalizeModelId(row.modelId) ?? row.modelId;
      if (selectedCanonicals.has(canonical)) {
        matched.add(row.modelId);
      }
    }
    for (const c of selectedCanonicals) {
      matched.add(c);
    }
    for (const r of requestedModels) {
      matched.add(r);
    }
    return Array.from(matched);
  } catch {
    return requestedModels;
  }
}

export function buildWhere(db: RawDatabase, filters: RangeFilters): { sql: string; params: any[] } {
  const clauses: string[] = [];
  const params: any[] = [];
  if (filters.sessionId) {
    clauses.push(`e.session_id = ?`);
    params.push(filters.sessionId);
  }
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
    const expanded = expandModelFilter(db, filters.model);
    clauses.push(`e.canonical_model_id IN (${ph(expanded.length)})`);
    params.push(...expanded);
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

  cacheAttribution(filters: RangeFilters, providerAliases: Array<{ raw: string; display: string }> = []): CacheAttributionResponse {
    const displayFor = providerDisplayNameFactory(this.db, providerAliases);
    const attributionFilters = filters.provider?.length ? { ...filters, provider: undefined } : filters;
    const { sql, params } = buildWhere(this.db, attributionFilters);
    const rawRows = this.db
      .prepare(
        `SELECT e.harness AS harness,
                COALESCE(e.canonical_provider_id, 'unknown') AS providerId,
                COALESCE(SUM(e.processed_input_tokens), 0) AS processedInputTokens,
                COALESCE(SUM(e.cache_read_input_tokens), 0) AS cacheReadInputTokens
         FROM usage_events e ${sql}
         GROUP BY e.harness, COALESCE(e.canonical_provider_id, 'unknown')
         HAVING SUM(e.processed_input_tokens) > 0`,
      )
      .all(...params) as Array<{
        harness: string;
        providerId: string;
        processedInputTokens: number;
        cacheReadInputTokens: number;
      }>;
    const selectedProviders = filters.provider?.length
      ? new Set(filters.provider.map((provider) => canonicalizeProviderId(provider) ?? provider))
      : null;
    const cellMap = new Map<string, (typeof rawRows)[number]>();
    for (const rawRow of rawRows) {
      const providerId = rawRow.providerId === "unknown"
        ? "unknown"
        : canonicalizeProviderId(rawRow.providerId) ?? rawRow.providerId;
      if (selectedProviders && !selectedProviders.has(providerId)) continue;
      const key = `${rawRow.harness}|${providerId}`;
      const cell = cellMap.get(key) ?? {
        harness: rawRow.harness,
        providerId,
        processedInputTokens: 0,
        cacheReadInputTokens: 0,
      };
      cell.processedInputTokens += rawRow.processedInputTokens;
      cell.cacheReadInputTokens += rawRow.cacheReadInputTokens;
      cellMap.set(key, cell);
    }
    const rows = [...cellMap.values()];

    const providerCells = new Map<string, typeof rows>();
    const harnessCells = new Map<string, typeof rows>();
    for (const row of rows) {
      providerCells.set(row.providerId, [...(providerCells.get(row.providerId) ?? []), row]);
      harnessCells.set(row.harness, [...(harnessCells.get(row.harness) ?? []), row]);
    }

    const harnesses = [...harnessCells.entries()].map(([harness, cells]) => {
      const processedInputTokens = cells.reduce((sum, cell) => sum + cell.processedInputTokens, 0);
      const cacheReadInputTokens = cells.reduce((sum, cell) => sum + cell.cacheReadInputTokens, 0);
      const providers = cells
        .map((cell) => {
          const inputShare = processedInputTokens > 0 ? cell.processedInputTokens / processedInputTokens : null;
          const observedRate = cell.processedInputTokens > 0
            ? cell.cacheReadInputTokens / cell.processedInputTokens
            : null;
          const cellsForProvider = providerCells.get(cell.providerId) ?? [];
          const qualifiedPeers = cellsForProvider.filter((peer) => {
            if (peer.harness === harness) return false;
            if (cell.providerId === "unknown") return false;
            if (cell.processedInputTokens < MIN_COMPARABLE_PROVIDER_INPUT_TOKENS) return false;
            if (peer.processedInputTokens < MIN_COMPARABLE_PROVIDER_INPUT_TOKENS) return false;
            const ratio = Math.max(cell.processedInputTokens, peer.processedInputTokens)
              / Math.min(cell.processedInputTokens, peer.processedInputTokens);
            return ratio <= MAX_COMPARABLE_INPUT_RATIO;
          });
          const comparatorInputTokens = qualifiedPeers.reduce((sum, peer) => sum + peer.processedInputTokens, 0);
          const comparatorCacheRead = qualifiedPeers.reduce((sum, peer) => sum + peer.cacheReadInputTokens, 0);
          let comparisonNote: string | null = null;
          if (cell.providerId === "unknown") {
            comparisonNote = "provider is unknown";
          } else if (inputShare == null || inputShare < MIN_COMPARABLE_PROVIDER_SHARE) {
            comparisonNote = "below 5% of harness input";
          } else if (cell.processedInputTokens < MIN_COMPARABLE_PROVIDER_INPUT_TOKENS) {
            comparisonNote = "less than 1M input tokens";
          } else if (qualifiedPeers.length === 0) {
            comparisonNote = "no peer with at least 1M input and a 20×-balanced sample";
          }
          const otherHarnessRate = comparisonNote == null && comparatorInputTokens > 0
            ? comparatorCacheRead / comparatorInputTokens
            : null;
          return {
            providerId: cell.providerId,
            display: displayFor(cell.providerId),
            processedInputTokens: cell.processedInputTokens,
            cacheReadInputTokens: cell.cacheReadInputTokens,
            observedRate,
            inputShare,
            otherHarnessRate,
            comparatorInputTokens,
            comparisonNote,
            lift: observedRate != null && otherHarnessRate != null ? observedRate - otherHarnessRate : null,
          };
        })
        .sort((a, b) => b.processedInputTokens - a.processedInputTokens);

      const comparable = providers.filter((provider) => provider.otherHarnessRate != null);
      const comparableInput = comparable.reduce((sum, provider) => sum + provider.processedInputTokens, 0);
      const comparableCacheRead = comparable.reduce((sum, provider) => sum + provider.cacheReadInputTokens, 0);
      const expectedCacheRead = comparable.reduce(
        (sum, provider) => sum + provider.processedInputTokens * provider.otherHarnessRate!,
        0,
      );
      const comparableObservedRate = comparableInput > 0 ? comparableCacheRead / comparableInput : null;
      const providerExpectedRate = comparableInput > 0 ? expectedCacheRead / comparableInput : null;

      return {
        harness: harness as CacheAttributionResponse["harnesses"][number]["harness"],
        processedInputTokens,
        cacheReadInputTokens,
        observedRate: processedInputTokens > 0 ? cacheReadInputTokens / processedInputTokens : null,
        comparableObservedRate,
        providerExpectedRate,
        adjustedLift: comparableObservedRate != null && providerExpectedRate != null
          ? comparableObservedRate - providerExpectedRate
          : null,
        comparisonCoverage: processedInputTokens > 0 ? comparableInput / processedInputTokens : null,
        providers,
      };
    }).sort((a, b) => b.processedInputTokens - a.processedInputTokens);

    return { filters, harnesses };
  }

  events(filters: RangeFilters, cursor: string | null, pageSize: number, sort: RequestSort = "oldest", order?: SortDirection): EventsPage {
    const size = Math.min(Math.max(1, pageSize || EVENT_PAGE_SIZE_DEFAULT), EVENT_PAGE_SIZE_MAX);
    const { sql, params } = buildWhere(this.db, filters);

    const direction = (order ?? (sort === "oldest" || sort === "model" ? "asc" : "desc")) === "asc" ? "ASC" : "DESC";
    const sortColumn = {
      oldest: "e.occurred_at", recent: "e.occurred_at",
      largest: "(e.processed_input_tokens + e.output_tokens + e.unattributed_tokens)",
      model: "LOWER(SUBSTR(COALESCE(e.canonical_model_id, e.raw_model_id, 'Unknown'), INSTR(COALESCE(e.canonical_model_id, e.raw_model_id, 'Unknown'), '/') + 1))",
      fresh: "e.fresh_input_tokens", cache: "e.cache_read_input_tokens", output: "e.output_tokens",
      cost: "CASE WHEN e.cost_available = 1 THEN e.cost_nano_usd END",
    }[sort];
    const numericSort = sort !== "oldest" && sort !== "recent" && sort !== "model";
    const compare = direction === "ASC" ? ">" : "<";
    const cursorClause: string[] = [];
    const cursorParams: any[] = [];
    if (cursor) {
      const [ts, id] = decodeCursor(cursor);
      if (sort === "cost" && ts === "null") {
        cursorClause.push(`AND (${sortColumn} IS NULL AND e.id ${compare} ?)`);
        cursorParams.push(id);
      } else {
        cursorClause.push(`AND (${sort === "cost" ? `${sortColumn} IS NULL OR ` : ""}${sortColumn} ${compare} ? OR (${sortColumn} = ? AND e.id ${compare} ?))`);
        const value = numericSort ? Number(ts) : ts;
        cursorParams.push(value, value, id);
      }
    }

    const rows = this.db
      .prepare(
        `SELECT e.*, ${sortColumn} AS sort_value FROM usage_events e ${sql}
         ${sql ? "AND" : "WHERE"} 1=1 ${cursorClause.join(" ")}
         ORDER BY ${sortColumn} ${direction} NULLS LAST, e.id ${direction} LIMIT ?`,
      )
      .all(...params, ...cursorParams, size + 1) as any[];

    const hasMore = rows.length > size;
    const page = rows.slice(0, size);
    const items = page.map(rowToEvent);
    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = encodeCursor(String(last.sort_value), last.id);
    }

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM usage_events e ${sql}`)
      .get(...params) as any;

    return { items, nextCursor, total: totalRow?.c ?? 0 };
  }

  /**
   * Largest sessions in the filtered range, aggregated in SQL over ALL
   * matching events (unlike the paginated /events endpoint, which only
   * exposes one page at a time).
   */
  largestSessions(filters: RangeFilters, limit = 5): LargestSessionRow[] {
    const size = Math.min(Math.max(1, limit || 5), 25);
    const { sql, params } = buildWhere(this.db, filters);
    const processedExpr = "(e.processed_input_tokens + e.output_tokens + e.unattributed_tokens)";
    const rows = this.db
      .prepare(
        `WITH per_session AS (
           SELECT e.session_id AS sessionId,
                  MIN(e.occurred_at) AS startedAt,
                  SUM(${processedExpr}) AS processed,
                  SUM(e.cost_nano_usd) AS costNano,
                  COUNT(*) AS events,
                  MAX(e.harness) AS harness
           FROM usage_events e ${sql}
           GROUP BY e.session_id
         ),
         ranked_models AS (
           SELECT e.session_id AS sessionId,
                  COALESCE(e.canonical_model_id, e.raw_model_id, 'unknown-model') AS model,
                  ROW_NUMBER() OVER (
                    PARTITION BY e.session_id
                    ORDER BY SUM(${processedExpr}) DESC
                  ) AS rn
           FROM usage_events e ${sql}
           GROUP BY e.session_id, COALESCE(e.canonical_model_id, e.raw_model_id, 'unknown-model')
         ),
         ranked_projects AS (
           SELECT e.session_id AS sessionId,
                  e.project_id AS project,
                  ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.occurred_at ASC, e.id ASC) AS rn
           FROM usage_events e ${sql}
         )
         SELECT s.sessionId, s.startedAt, s.processed, s.costNano, s.events, s.harness,
                m.model, p.project
         FROM per_session s
         LEFT JOIN ranked_models m ON m.sessionId = s.sessionId AND m.rn = 1
         LEFT JOIN ranked_projects p ON p.sessionId = s.sessionId AND p.rn = 1
         ORDER BY s.processed DESC
         LIMIT ?`,
      )
      // buildWhere placeholders repeat once per CTE above, so bind params per occurrence.
      .all(...params, ...params, ...params, size) as any[];

    return rows.map((row) => ({
      sessionId: String(row.sessionId),
      startedAt: row.startedAt,
      harness: row.harness,
      model: row.model ?? "unknown-model",
      project: row.project ?? null,
      events: row.events,
      processedTokens: row.processed ?? 0,
      costUsd: nanoToUsd(row.costNano ?? null),
    }));
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

    // Merge stored model spellings that canonicalize to the same id at read
    // time (e.g. `gpt-5.6-luna` and `openai/gpt-5.6-luna`) so the filter UI
    // offers one canonical choice instead of misleading duplicates.
    const modelMap = new Map<string, { id: string; canonicalModelId: string | null; display: string | null; owner: string | null; eventCount: number; totalTokens: number }>();
    const rawModels = this.db
      .prepare(
        `SELECT m.id, m.canonical_model_id AS canonicalModelId, m.display,
                m.owner, COUNT(e.id) AS eventCount,
                COALESCE(SUM(e.processed_tokens), 0) AS totalTokens
         FROM models m LEFT JOIN usage_events e ON e.canonical_model_id = m.id
         GROUP BY m.id`,
      )
      .all() as any[];
    for (const m of rawModels) {
      const canonicalId = mergedModelId(m.id);
      const existing = modelMap.get(canonicalId);
      if (!existing) {
        modelMap.set(canonicalId, {
          id: canonicalId,
          canonicalModelId: canonicalId === "unknown" ? null : canonicalId,
          display: m.display ?? m.canonicalModelId,
          owner: m.owner ?? null,
          eventCount: m.eventCount ?? 0,
          totalTokens: m.totalTokens ?? 0,
        });
      } else {
        existing.eventCount += m.eventCount ?? 0;
        existing.totalTokens += m.totalTokens ?? 0;
        if (!existing.display || existing.display === canonicalId) {
          existing.display = m.display ?? m.canonicalModelId ?? existing.display;
        }
        if (!existing.owner && m.owner) existing.owner = m.owner;
      }
    }
    const models = Array.from(modelMap.values()).sort(
      (a, b) => b.totalTokens - a.totalTokens || b.eventCount - a.eventCount,
    );
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
        display: prettyModelDisplay(m.display ?? m.canonicalModelId ?? m.id, m.id),
        owner: m.owner,
        eventCount: m.eventCount,
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
    const dimension = groupBy === "harness" ? "e.harness"
      : groupBy === "model" ? "COALESCE(e.canonical_model_id, e.raw_model_id, 'unknown')"
      : "COALESCE(e.canonical_provider_id, 'unknown')";
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
    const rateInputs = new Map<string, number>();
    const seriesKeys = new Set<string>();

    for (const r of rows) {
      const day = formatInTimeZone(r.occurred_at, timezone, "yyyy-MM-dd");
      if (minDate === null || day < minDate) minDate = day;
      if (maxDate === null || day > maxDate) maxDate = day;
      const series = groupBy === "harness"
        ? r.provider
        : groupBy === "model" ? (canonicalizeModelId(r.provider) ?? r.provider)
        : (r.provider === "unknown" ? "unknown" : (canonicalizeProviderId(r.provider) ?? r.provider));
      seriesKeys.add(series);
      const key = `${day}|${series}`;
      acc.set(key, (acc.get(key) ?? 0) + rowMetric(r, metric));
      if (metric === "cacheHitRate") {
        rateInputs.set(key, (rateInputs.get(key) ?? 0) + (r.processed_input_tokens ?? 0));
      }
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
        if (metric === "cacheHitRate") {
          const inputTokens = rateInputs.get(`${date}|${provider}`) ?? 0;
          if (inputTokens > 0) points.push({ date, provider, value: v / inputTokens, inputTokens });
        } else if (v > 0) points.push({ date, provider, value: v });
      }
    }

    return { metric, groupBy, buckets, providers, points };
  }

  modelsBreakdown(filters: RangeFilters, billing: ProviderBilling[] = []): ModelsBreakdownResponse {
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
           COALESCE(SUM(CASE WHEN e.cost_available THEN e.processed_tokens ELSE 0 END), 0) AS costCoverageProcessedTokens
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
      costCoverageProcessedTokens: number;
      sessions: number;
    }

    const modelMap = new Map<string, MergedModel>();

    for (const r of rows) {
      const meta = modelMeta.get(r.modelId);
      const canonicalId = mergedModelId(r.modelId);
      const existing = modelMap.get(canonicalId);
      const owner = meta?.owner ?? modelOwner(canonicalId) ?? null;
      const display = prettyModelDisplay(meta?.display ?? modelDisplay(r.rawModelId, canonicalId), canonicalId);

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
          costCoverageProcessedTokens: r.costCoverageProcessedTokens,
          sessions: 0,
        });
      } else {
        existing.processedTokens += r.processedTokens;
        existing.processedInputTokens += r.processedInputTokens;
        existing.freshInputTokens += r.freshInputTokens;
        existing.cacheReadInputTokens += r.cacheReadInputTokens;
        existing.outputTokens += r.outputTokens;
        existing.costNano += r.costNano;
        existing.costCoverageProcessedTokens += r.costCoverageProcessedTokens;
        if (!existing.rawModelId && r.rawModelId) existing.rawModelId = r.rawModelId;
      }
    }

    // Sessions are not additive across merged spellings: a session that used
    // both `gpt-5.6-luna` and `openai/gpt-5.6-luna` would be counted twice if
    // we summed the per-stored-id distinct counts. Collect distinct
    // (stored id, session) pairs instead and dedupe per merged canonical id.
    const sessionsByModel = new Map<string, Set<string>>();
    const sessionPairs = this.db
      .prepare(
        `SELECT COALESCE(e.canonical_model_id, 'unknown') AS modelId, e.session_id AS sessionId
         FROM usage_events e ${sql}
         GROUP BY COALESCE(e.canonical_model_id, 'unknown'), e.session_id`,
      )
      .all(...params) as Array<{ modelId: string; sessionId: string | null }>;
    for (const pair of sessionPairs) {
      if (pair.sessionId == null) continue;
      const key = mergedModelId(pair.modelId);
      const sessions = sessionsByModel.get(key) ?? new Set<string>();
      sessions.add(pair.sessionId);
      sessionsByModel.set(key, sessions);
    }
    for (const m of modelMap.values()) {
      m.sessions = sessionsByModel.get(m.id)?.size ?? 0;
    }

    const models: ModelBreakdownItem[] = Array.from(modelMap.values())
      .sort((a, b) => b.processedTokens - a.processedTokens)
      .map((m) => {
        const processedInput = m.processedInputTokens;
        const cacheHitRate = processedInput > 0 ? m.cacheReadInputTokens / processedInput : null;
        const costCoverage = m.processedTokens > 0 ? m.costCoverageProcessedTokens / m.processedTokens : null;
        // Billing mode is keyed by the provider segment of the canonical model
        // id ("openai/gpt-6-sol" → "openai"). Matched verbatim and via the
        // canonical provider route; anything unlisted stays unspecified —
        // Observer makes no assumption about anyone's plan.
        const ownerSegment = m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : m.id;
        const billingMode = modeByProvider(billing, ownerSegment);
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
          costUsd: costCoverage != null && costCoverage > 0 ? nanoToUsd(m.costNano) ?? 0 : null,
          costCoverage,
          billingMode,
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

/** Merge key for a stored canonical model id at read time. */
function mergedModelId(storedModelId: string): string {
  if (storedModelId === "unknown") return "unknown";
  return canonicalizeModelId(storedModelId) ?? storedModelId;
}

/**
 * Display label for a model. Human aliases win verbatim; otherwise the label
 * mirrors the canonical id with a redundant owner prefix collapsed
 * (`deepseek/deepseek-v4.1-flash` → `deepseek-v4.1-flash`).
 */
function prettyModelDisplay(display: string | null | undefined, canonicalId: string): string {
  const base = display ?? canonicalId;
  if (base.toLowerCase() !== canonicalId.toLowerCase()) return base;
  const slash = canonicalId.indexOf("/");
  if (slash > 0) {
    const owner = canonicalId.slice(0, slash).toLowerCase();
    const family = canonicalId.slice(slash + 1);
    if (family.toLowerCase().startsWith(`${owner}-`)) return family;
  }
  return base;
}

function modeByProvider(billing: ProviderBilling[], ownerSegment: string): "subscription" | "metered" | "unspecified" {
  const lower = ownerSegment.toLowerCase();
  const canonical = canonicalizeProviderId(lower) ?? lower;
  for (const candidate of [lower, canonical]) {
    const match = billing.find((entry) => entry.provider.toLowerCase() === candidate);
    if (match) return match.mode;
  }
  return "unspecified";
}

function rowMetric(r: any, metric: TimeseriesMetric): number {
  switch (metric) {
    case "processedTokens": return r.processed_tokens ?? 0;
    case "processedInputTokens": return r.processed_input_tokens ?? 0;
    case "outputTokens": return r.output_tokens ?? 0;
    case "freshInputTokens": return r.fresh_input_tokens ?? 0;
    case "cacheHitRate":
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

export function rowToEvent(r: any): NormalizedUsageEvent {
  return {
    id: r.id,
    harness: r.harness,
    occurredAt: r.occurred_at,
    projectId: r.project_id,
    sessionId: r.session_id,
    turnId: r.turn_id,
    requestId: r.request_id,
    rawProviderId: r.raw_provider_id,
    // Read-time canonicalization: rows stored before a routing change keep
    // stale ids (e.g. `glm`, `zai-coding-plan`), so events must surface the
    // same canonical ids that filtering and aggregation use.
    canonicalProviderId: r.canonical_provider_id == null
      ? null
      : (canonicalizeProviderId(r.canonical_provider_id) ?? r.canonical_provider_id),
    providerResolution: r.provider_resolution,
    rawModelId: r.raw_model_id,
    canonicalModelId: r.canonical_model_id == null
      ? null
      : (canonicalizeModelId(r.canonical_model_id) ?? r.canonical_model_id),
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

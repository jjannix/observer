import { useEffect, useState, useCallback } from "react";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

import type {
  DimensionLists,
  EventsPage,
  HealthResponse,
  SanitizedConfig,
  SourceInfo,
  SummaryResponse,
  SyncRunInfo,
  SyncTriggerResponse,
  AppliedFilters,
} from "@shared/contracts";

export interface TimeseriesResponse {
  metric: string;
  groupBy: "provider" | "harness";
  buckets: string[];
  providers: string[];
  points: { date: string; provider: string; value: number }[];
}

export const api = {
  health: () => jsonFetch<HealthResponse>("/api/v1/health"),
  sources: () => jsonFetch<SourceInfo[]>("/api/v1/sources"),
  sync: () => jsonFetch<SyncTriggerResponse>("/api/v1/sync", { method: "POST" }),
  syncRun: (id: string) => jsonFetch<SyncRunInfo | null>(`/api/v1/sync/${id}`),
  dimensions: () => jsonFetch<DimensionLists>("/api/v1/dimensions"),
  timeseries: (filters: RangeFilters, metric: string, groupBy: "provider" | "harness" = "provider") =>
    jsonFetch<TimeseriesResponse>(`/api/v1/timeseries?${qs({ ...filters, metric, groupBy } as Record<string, unknown>)}`),
  summary: (filters: RangeFilters) =>
    jsonFetch<SummaryResponse>(`/api/v1/summary?${qs(filters as Record<string, unknown>)}`),
  events: (filters: RangeFilters, cursor: string | null, pageSize: number) =>
    jsonFetch<EventsPage>(`/api/v1/events?${qs({ ...filters, cursor, pageSize } as Record<string, unknown>)}`),
  config: () => jsonFetch<SanitizedConfig>("/api/v1/config"),
  updateConfig: (cfg: unknown) =>
    jsonFetch<SanitizedConfig>("/api/v1/config", { method: "PUT", body: JSON.stringify(cfg) }),
  renormalize: () => jsonFetch<SyncTriggerResponse>("/api/v1/renormalize", { method: "POST" }),
  rebuild: () =>
    jsonFetch<SyncTriggerResponse>("/api/v1/rebuild", {
      method: "POST",
      body: JSON.stringify({ confirm: "rebuild" }),
    }),
};

export interface RangeFilters extends AppliedFilters {
  from?: string | null;
  to?: string | null;
  cursor?: string | null;
  pageSize?: number;
}

function qs(o: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      params.set(k, v.join(","));
    } else {
      params.set(k, String(v));
    }
  }
  return params.toString();
}

/** Local calendar range (Europe/Berlin) → UTC instants for the API. */
export function rangeToFilters(range: RangeKey, _tz: string): Pick<RangeFilters, "from" | "to"> {
  const now = new Date();
  if (range === "all") return { from: null, to: null };
  const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 365;
  const from = new Date(now.getTime() - days * 86400_000);
  return { from: from.toISOString(), to: null };
}

export type RangeKey = "7d" | "30d" | "90d" | "1y" | "all" | "custom";

/** Polls health for active-sync status + warnings while mounted. */
export function useHealth(intervalMs = 2000): {
  health: HealthResponse | null;
  refresh: () => void;
} {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const refresh = useCallback(() => {
    api.health().then(setHealth).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, [refresh, intervalMs]);
  return { health, refresh };
}

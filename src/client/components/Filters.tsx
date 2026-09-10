import { useEffect, useRef, useState } from "react";
import { HARNESS_IDS, type DimensionLists, type HarnessId } from "@shared/contracts";
import type { RangeFilters, RangeKey } from "../api.js";
import { MultiSelect } from "./MultiSelect.js";
import { harnessLabel } from "./colors.js";

export interface FilterState extends RangeFilters {
  range: RangeKey;
  chartMetric?: string;
}

export const DEFAULT_FILTERS: FilterState = { range: "30d", chartMetric: "processedTokens" };
const FILTER_STORAGE_KEY = "observer.filters";
const LEGACY_RANGE_STORAGE_KEY = "observer.observation-range";
const RANGE_KEYS: RangeKey[] = ["7d", "30d", "90d", "1y", "all", "custom"];

export function useFilterState(): [FilterState, (next: FilterState) => void] {
  const [filters, setFilters] = useState<FilterState>(readStoredFilters);

  useEffect(() => {
    try {
      window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(persistedFilters(filters)));
      window.localStorage.removeItem(LEGACY_RANGE_STORAGE_KEY);
    } catch {
      // Persistence is optional when storage is unavailable.
    }
  }, [filters]);

  return [filters, setFilters];
}

export const CHART_METRICS = [
  { id: "processedTokens", label: "Processed tokens" },
  { id: "processedInputTokens", label: "Processed input" },
  { id: "freshInputTokens", label: "Fresh input" },
  { id: "cacheReadInputTokens", label: "Cache read" },
  { id: "outputTokens", label: "Output" },
  { id: "costUsd", label: "Cost (USD)" },
  { id: "requests", label: "Requests" },
];

export function FiltersBar({
  dims,
  filters,
  onChange,
}: {
  dims: DimensionLists | undefined;
  filters: FilterState;
  onChange: (next: FilterState) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const update = (patch: Partial<FilterState>) => onChange({ ...filters, ...patch });
  const clearDimensionFilters = () => update({ harness: undefined, provider: undefined, model: undefined, project: undefined });
  const activeChips: { label: string; clear: () => void }[] = [];
  if (filters.harness?.length) activeChips.push({ label: chipLabel(filters.harness, "harness", (id) => harnessLabel(id)), clear: () => update({ harness: undefined }) });
  if (filters.provider?.length) activeChips.push({ label: chipLabel(filters.provider, "provider", (id) => dims?.providers.find((p) => p.id === id)?.display ?? id), clear: () => update({ provider: undefined }) });
  if (filters.model?.length) activeChips.push({ label: chipLabel(filters.model, "model", (id) => dims?.models.find((m) => m.id === id)?.display ?? id), clear: () => update({ model: undefined }) });
  if (filters.project?.length) activeChips.push({ label: chipLabel(filters.project, "project", (id) => shortPath(dims?.projects.find((p) => p.id === id)?.path ?? id)), clear: () => update({ project: undefined }) });

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="observation-controls">
      <div className="range-tabs" aria-label="Observation period">
        {([["7d", "7D"], ["30d", "30D"], ["90d", "90D"], ["1y", "1Y"], ["all", "ALL"]] as Array<[RangeKey, string]>).map(([value, label]) => (
          <button key={value} className={filters.range === value ? "active" : ""} onClick={() => update({ range: value })}>{label}</button>
        ))}
      </div>
      <div className="filter-anchor" ref={panelRef}>
        <button
          className={`filter-trigger${open ? " open" : ""}${activeChips.length ? " has-filters" : ""}`}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
            <path d="M2.25 4.5h3m2.5 0h6M2.25 11.5h6m2.5 0h3" />
            <circle cx="6.5" cy="4.5" r="1.25" />
            <circle cx="9.5" cy="11.5" r="1.25" />
          </svg>
          <span className="filter-trigger-label">Filters</span>
          {activeChips.length > 0 && <span className="filter-count">{activeChips.length}</span>}
          <span className="filter-chevron" aria-hidden="true" />
        </button>
        {open && (
          <div className="filter-panel" role="dialog" aria-label="Observation filters">
            <div className="filter-panel-head">
              <div>
                <strong>Filter observations</strong>
                <span>{activeChips.length ? `${activeChips.length} active` : "All dimensions"}</span>
              </div>
              {activeChips.length > 0 && <button className="filter-reset" onClick={clearDimensionFilters}>Reset</button>}
            </div>
            <div className="filter-panel-body">
              <div className="filter-section-label">Dimensions</div>
              <div className="filter-grid">
                <MultiSelect label="Harness" width={180} options={(dims?.harnesses ?? []).map((h) => ({ id: h, label: harnessLabel(h) }))} selected={filters.harness ?? []} onChange={(next) => update({ harness: next.length ? (next as HarnessId[]) : undefined })} />
                <MultiSelect label="Model" width={220} options={(dims?.models ?? []).map((m) => ({ id: m.id, label: m.display, count: m.eventCount }))} selected={filters.model ?? []} onChange={(next) => update({ model: next.length ? next : undefined })} />
                <MultiSelect label="Provider" width={200} options={(dims?.providers ?? []).map((p) => ({ id: p.id, label: p.display, count: p.eventCount }))} selected={filters.provider ?? []} onChange={(next) => update({ provider: next.length ? next : undefined })} />
                <MultiSelect label="Project" width={220} options={(dims?.projects ?? []).map((p) => ({ id: p.id, label: shortPath(p.path), count: p.eventCount }))} selected={filters.project ?? []} onChange={(next) => update({ project: next.length ? next : undefined })} />
              </div>
              <div className="custom-range">
                <span className="custom-range-label">Date range</span>
                <button className={filters.range === "custom" ? "active sm" : "ghost sm"} onClick={() => update({ range: "custom" })}>Custom</button>
                {filters.range === "custom" && <><input aria-label="Start date" type="date" value={filters.from?.slice(0, 10) ?? ""} onChange={(e) => update({ from: e.target.value ? new Date(e.target.value).toISOString() : null })} /><span>to</span><input aria-label="End date" type="date" value={filters.to?.slice(0, 10) ?? ""} onChange={(e) => update({ to: e.target.value ? new Date(e.target.value).toISOString() : null })} /></>}
              </div>
            </div>
          </div>
        )}
      </div>
      {activeChips.length > 0 && (
        <div className="active-filters">
          {activeChips.map((chip) => (
            <span key={chip.label} className="chip">
              <span>{chip.label}</span>
              <button onClick={chip.clear} aria-label={`Clear ${chip.label}`}><span aria-hidden="true">×</span></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function chipLabel(values: string[], singular: string, resolve: (id: string) => string): string {
  return values.length === 1 ? resolve(values[0]) : `${values.length} ${singular}s`;
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

function readStoredFilters(): FilterState {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) {
      const legacyRange = window.localStorage.getItem(LEGACY_RANGE_STORAGE_KEY);
      return { ...DEFAULT_FILTERS, range: validRange(legacyRange) ?? DEFAULT_FILTERS.range };
    }

    const stored = JSON.parse(raw) as Record<string, unknown>;
    const range = validRange(stored.range) ?? DEFAULT_FILTERS.range;
    return {
      ...DEFAULT_FILTERS,
      range,
      from: range === "custom" ? validDate(stored.from) : undefined,
      to: range === "custom" ? validDate(stored.to) : undefined,
      harness: validHarnesses(stored.harness),
      provider: validStringArray(stored.provider),
      model: validStringArray(stored.model),
      project: validStringArray(stored.project),
      chartMetric: validChartMetric(stored.chartMetric),
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function persistedFilters(filters: FilterState): FilterState {
  return {
    range: filters.range,
    from: filters.range === "custom" ? filters.from : undefined,
    to: filters.range === "custom" ? filters.to : undefined,
    harness: filters.harness?.length ? filters.harness : undefined,
    provider: filters.provider?.length ? filters.provider : undefined,
    model: filters.model?.length ? filters.model : undefined,
    project: filters.project?.length ? filters.project : undefined,
    chartMetric: validChartMetric(filters.chartMetric),
  };
}

function validRange(value: unknown): RangeKey | undefined {
  return typeof value === "string" && RANGE_KEYS.includes(value as RangeKey) ? (value as RangeKey) : undefined;
}

function validDate(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function validStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return values.length ? values : undefined;
}

function validHarnesses(value: unknown): HarnessId[] | undefined {
  const values = validStringArray(value)?.filter((item): item is HarnessId => HARNESS_IDS.includes(item as HarnessId));
  return values?.length ? values : undefined;
}

function validChartMetric(value: unknown): string {
  return typeof value === "string" && CHART_METRICS.some((metric) => metric.id === value)
    ? value
    : DEFAULT_FILTERS.chartMetric!;
}

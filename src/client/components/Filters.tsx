import { useEffect, useRef, useState } from "react";
import type { DimensionLists, HarnessId } from "@shared/contracts";
import type { RangeFilters, RangeKey } from "../api.js";
import { MultiSelect } from "./MultiSelect.js";

export interface FilterState extends RangeFilters {
  range: RangeKey;
  chartMetric?: string;
}

export const DEFAULT_FILTERS: FilterState = { range: "30d", chartMetric: "processedTokens" };

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
  const activeChips: { label: string; clear: () => void }[] = [];
  if (filters.harness?.length) activeChips.push({ label: chipLabel(filters.harness, "harness", (id) => id), clear: () => update({ harness: undefined }) });
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
        <button className="filter-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          Filter <span>+</span>
        </button>
        {open && (
          <div className="filter-panel">
            <div className="filter-grid">
              <MultiSelect label="Harness" width={180} options={(dims?.harnesses ?? []).map((h) => ({ id: h, label: h }))} selected={filters.harness ?? []} onChange={(next) => update({ harness: next.length ? (next as HarnessId[]) : undefined })} />
              <MultiSelect label="Model" width={220} options={(dims?.models ?? []).map((m) => ({ id: m.id, label: m.display, count: m.eventCount }))} selected={filters.model ?? []} onChange={(next) => update({ model: next.length ? next : undefined })} />
              <MultiSelect label="Provider" width={200} options={(dims?.providers ?? []).map((p) => ({ id: p.id, label: p.display, count: p.eventCount }))} selected={filters.provider ?? []} onChange={(next) => update({ provider: next.length ? next : undefined })} />
              <MultiSelect label="Project" width={220} options={(dims?.projects ?? []).map((p) => ({ id: p.id, label: shortPath(p.path), count: p.eventCount }))} selected={filters.project ?? []} onChange={(next) => update({ project: next.length ? next : undefined })} />
            </div>
            <div className="custom-range">
              <button className={filters.range === "custom" ? "active" : "ghost sm"} onClick={() => update({ range: "custom" })}>Custom period</button>
              {filters.range === "custom" && <><input type="date" value={filters.from?.slice(0, 10) ?? ""} onChange={(e) => update({ from: e.target.value ? new Date(e.target.value).toISOString() : null })} /><span>to</span><input type="date" value={filters.to?.slice(0, 10) ?? ""} onChange={(e) => update({ to: e.target.value ? new Date(e.target.value).toISOString() : null })} /></>}
              {activeChips.length > 0 && <button className="ghost sm clear-filters" onClick={() => update({ harness: undefined, provider: undefined, model: undefined, project: undefined })}>Clear filters</button>}
            </div>
          </div>
        )}
      </div>
      {activeChips.length > 0 && (
        <div className="active-filters">
          {activeChips.map((chip) => (
            <span key={chip.label} className="chip">
              {chip.label}
              <button onClick={chip.clear} aria-label={`Clear ${chip.label}`}>×</button>
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

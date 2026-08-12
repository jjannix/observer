import type { DimensionLists, HarnessId } from "@shared/contracts";
import type { RangeFilters, RangeKey } from "../api.js";
import { MultiSelect } from "./MultiSelect.js";

export interface FilterState extends RangeFilters {
  range: RangeKey;
  /** metric shown on the time graph */
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
  const update = (patch: Partial<FilterState>) => onChange({ ...filters, ...patch });
  const activeChips: { label: string; clear: () => void }[] = [];
  if (filters.harness?.length) activeChips.push({ label: `${filters.harness.length} harness`, clear: () => update({ harness: undefined }) });
  if (filters.provider?.length) activeChips.push({ label: `${filters.provider.length} provider`, clear: () => update({ provider: undefined }) });
  if (filters.model?.length) activeChips.push({ label: `${filters.model.length} model`, clear: () => update({ model: undefined }) });
  if (filters.project?.length) activeChips.push({ label: `${filters.project.length} project`, clear: () => update({ project: undefined }) });

  return (
    <div className="surface pad" style={{ marginBottom: "var(--space-5)" }}>
      <div className="toolbar">
        <div className="select-wrap">
          <select value={filters.range} onChange={(e) => update({ range: e.target.value as RangeKey })}>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="all">All time</option>
            <option value="custom">Custom…</option>
          </select>
        </div>
        {filters.range === "custom" && (
          <>
            <input
              type="date"
              style={{ width: "auto" }}
              value={filters.from?.slice(0, 10) ?? ""}
              onChange={(e) => update({ from: e.target.value ? new Date(e.target.value).toISOString() : null })}
            />
            <span className="dim">→</span>
            <input
              type="date"
              style={{ width: "auto" }}
              value={filters.to?.slice(0, 10) ?? ""}
              onChange={(e) => update({ to: e.target.value ? new Date(e.target.value).toISOString() : null })}
            />
          </>
        )}
        <span style={{ width: 1, height: 22, background: "var(--border)", margin: "0 6px" }} />
        <MultiSelect
          label="Harness"
          width={150}
          options={(dims?.harnesses ?? []).map((h) => ({ id: h, label: h }))}
          selected={filters.harness ?? []}
          onChange={(next) => update({ harness: next.length ? (next as HarnessId[]) : undefined })}
        />
        <MultiSelect
          label="Model"
          width={210}
          options={(dims?.models ?? []).map((m) => ({ id: m.id, label: m.display, count: m.eventCount }))}
          selected={filters.model ?? []}
          onChange={(next) => update({ model: next.length ? next : undefined })}
        />
        <MultiSelect
          label="Provider"
          width={180}
          options={(dims?.providers ?? []).map((p) => ({ id: p.id, label: p.display, count: p.eventCount }))}
          selected={filters.provider ?? []}
          onChange={(next) => update({ provider: next.length ? next : undefined })}
        />
        <MultiSelect
          label="Project"
          width={210}
          options={(dims?.projects ?? []).map((p) => ({ id: p.id, label: shortPath(p.path), count: p.eventCount }))}
          selected={filters.project ?? []}
          onChange={(next) => update({ project: next.length ? next : undefined })}
        />
        {(filters.harness || filters.provider || filters.model || filters.project) && (
          <button className="ghost sm" onClick={() => update({ harness: undefined, provider: undefined, model: undefined, project: undefined })}>
            Clear filters
          </button>
        )}
      </div>
      {activeChips.length > 0 && (
        <div className="row wrap" style={{ marginTop: "var(--space-3)", gap: 6 }}>
          {activeChips.map((c) => (
            <span key={c.label} className="chip">
              {c.label}
              <button onClick={c.clear} aria-label="clear">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || p;
}

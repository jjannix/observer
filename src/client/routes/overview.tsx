import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, rangeToFilters } from "../api.js";
import { CHART_METRICS, DEFAULT_FILTERS, FiltersBar, type FilterState } from "../components/Filters.js";
import { StackedAreaChart } from "../components/Chart.js";
import { CompositionBar, COLORS, Kpi, Metric, fmtCompact, fmtDate, fmtInt, fmtPct, fmtUsd } from "../components/ui.js";
import { colorFor } from "../components/colors.js";

const METRIC_FORMATTER: Record<string, (v: number) => string> = {
  processedTokens: fmtCompact,
  processedInputTokens: fmtCompact,
  freshInputTokens: fmtCompact,
  cacheReadInputTokens: fmtCompact,
  outputTokens: fmtCompact,
  costUsd: (v) => fmtUsd(v / 1e9),
  requests: fmtCompact,
};

export function Overview() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);

  const range = useMemo(() => {
    const { from, to } = rangeToFilters(filters.range, "Europe/Berlin");
    return {
      from: filters.range === "custom" ? filters.from : from,
      to: filters.range === "custom" ? filters.to : to,
      harness: filters.harness,
      provider: filters.provider,
      model: filters.model,
      project: filters.project,
    };
  }, [filters]);

  const chartMetric = filters.chartMetric ?? "processedTokens";
  const chartRange = { ...range };

  const { data: dims } = useQuery({ queryKey: ["dimensions"], queryFn: api.dimensions });
  const { data: sources } = useQuery({ queryKey: ["sources"], queryFn: api.sources, refetchInterval: 3000 });
  const { data: summary } = useQuery({ queryKey: ["summary", range], queryFn: () => api.summary(range) });
  const { data: ts } = useQuery({ queryKey: ["timeseries", chartRange, chartMetric], queryFn: () => api.timeseries(chartRange, chartMetric) });

  const syncMut = useMutation({ mutationFn: api.sync, onSuccess: () => qc.invalidateQueries() });

  const t = summary?.totals;
  const c = summary?.coverage;
  const reportedReasoning = t?.reasoningOutputTokens ?? 0;
  const unclassifiedOutput = t ? Math.max(0, t.outputTokens - reportedReasoning) : 0;

  return (
    <div>
      <div className="page-head">
        <div className="titles">
          <h1>Overview</h1>
          <p className="page-sub">Canonical token accounting across Pi and Codex sessions.</p>
        </div>
        <div className="actions">
          <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending}>
            {syncMut.isPending ? <span className="spinner" /> : null} Sync now
          </button>
        </div>
      </div>

      <FiltersBar dims={dims} filters={filters} onChange={setFilters} />

      {/* KPI strip — the hero numbers */}
      <div className="section">
        <div className="kpis">
          <Kpi label="Processed tokens" value={fmtCompact(t?.processedTokens)} accent="var(--accent)"
            sub={<>{fmtInt(t?.requests)} requests · {fmtInt(t?.sessions)} sessions</>} />
          <Kpi label="Cost" value={fmtUsd(t?.costUsd)} accent="var(--c-fresh)"
            sub={c ? <>coverage {fmtPct(c.costCoverage)}</> : undefined} />
          <Kpi label="Cache hit rate" value={fmtPct(t?.cacheHitRate)} accent="var(--c-cache-read)"
            sub={t?.cacheReuseEfficiency != null ? `reuse ${fmtPct(t.cacheReuseEfficiency)}` : "reuse —"} />
          <Kpi label="Output" value={fmtCompact(t?.outputTokens)} accent="var(--c-output)"
            sub={<>incl. {fmtCompact(reportedReasoning)} reasoning</>} />
        </div>
      </div>

      {/* Time graph — provider colored */}
      <div className="section">
        <div className="surface pad">
          <div className="section-head">
            <h2>Usage over time</h2>
            <div className="select-wrap" style={{ minWidth: 180 }}>
              <select value={chartMetric} onChange={(e) => setFilters({ ...filters, chartMetric: e.target.value })}>
                {CHART_METRICS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>
          {ts ? (
            <StackedAreaChart
              buckets={ts.buckets}
              providers={ts.providers}
              points={ts.points}
              formatValue={METRIC_FORMATTER[chartMetric] ?? fmtCompact}
            />
          ) : (
            <div className="skeleton" style={{ height: 260 }} />
          )}
          {ts && ts.providers.length > 0 && (
            <div className="comp-legend" style={{ marginTop: "var(--space-4)" }}>
              {ts.providers.map((p) => (
                <div key={p} className="item">
                  <span className="swatch" style={{ background: colorFor(p) }} />
                  {p}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Token composition */}
      <div className="section">
        <div className="surface pad">
          <div className="section-head">
            <h2>Token composition</h2>
            <span className="hint">{fmtCompact(t?.processedTokens)} processed total</span>
          </div>
          <CompositionBar
            total={t?.processedTokens ?? 0}
            segments={[
              { label: "Cache read", value: t?.cacheReadInputTokens ?? 0, color: COLORS.cacheRead },
              { label: "Fresh input", value: t?.freshInputTokens ?? 0, color: COLORS.fresh },
              { label: "Cache write", value: t?.cacheWriteInputTokens ?? 0, color: COLORS.cacheWrite },
              { label: "Output", value: unclassifiedOutput, color: COLORS.output },
              { label: "Reported reasoning", value: reportedReasoning, color: COLORS.reasoning },
              { label: "Unattributed", value: t?.unattributedTokens ?? 0, color: COLORS.unattributed },
            ]}
          />
          <div className="dim" style={{ fontSize: 11.5, marginTop: "var(--space-4)" }}>
            Output already includes reasoning. <strong>Reported reasoning</strong> counts only records with an
            explicit reasoning field; the remaining output is intentionally not classified as reasoning.
          </div>
        </div>
      </div>

      {/* Secondary metrics */}
      <div className="section">
        <div className="section-head"><h2>Breakdown</h2></div>
        <div className="metrics">
          <Metric label="Processed input" value={fmtCompact(t?.processedInputTokens)} sub="fresh + cache" />
          <Metric label="Fresh input" value={fmtCompact(t?.freshInputTokens)} />
          <Metric label="Cache read" value={fmtCompact(t?.cacheReadInputTokens)} />
          <Metric label="Cache write" value={fmtCompact(t?.cacheWriteInputTokens)} sub={c ? `${fmtPct(c.cacheWriteAvailable / (c.total || 1))} coverage` : undefined} />
          <Metric label="Output / input" value={fmtPct(t?.outputInputRatio)} />
          <Metric label="Turns" value={fmtInt(t?.turns)} />
          <Metric label="Reasoning coverage" value={fmtPct(c ? c.reasoningAvailable / (c.total || 1) : null)} />
          <Metric label="Classification coverage" value={fmtPct(c?.classificationCoverage)} />
        </div>
      </div>

      {/* Sources health */}
      <div className="section">
        <div className="section-head">
          <h2>Sources</h2>
          <span className="hint">{sources ? `${sources.filter((s) => s.present).length}/${sources.length} present` : ""}</span>
        </div>
        <div className="surface flush">
          <table className="data">
            <thead>
              <tr>
                <th>Source</th><th>Status</th><th>Files</th><th>Events</th>
                <th>Quarantined</th><th>Duplicates</th><th>Last sync</th>
              </tr>
            </thead>
            <tbody>
              {(sources ?? []).map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="row">
                      <span className="dot" style={{ background: s.harness === "pi" ? "var(--c-cache-write)" : "var(--c-output)" }} />
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        <span style={{ color: "var(--fg-0)" }}>{s.label}</span>
                        <span className="dim mono" style={{ fontSize: 10.5 }}>{s.root}</span>
                      </div>
                    </div>
                  </td>
                  <td>{s.present ? <span className="badge ok">present</span> : <span className="badge danger">missing</span>}</td>
                  <td className="tnum">{s.filesPresent}/{s.filesDiscovered}</td>
                  <td className="tnum">{fmtInt(s.normalizedEvents)}</td>
                  <td className="tnum">{s.quarantined > 0 ? <span className="badge warn">{fmtCompact(s.quarantined)}</span> : <span className="dim">0</span>}</td>
                  <td className="tnum dim">{fmtInt(s.duplicates)}</td>
                  <td className="dim">{fmtDate(s.lastSyncFinishedAt)}</td>
                </tr>
              ))}
              {(!sources || sources.length === 0) && (
                <tr><td colSpan={7} className="empty">No sources discovered yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, rangeToFilters } from "../api.js";
import { CHART_METRICS, FiltersBar, useFilterState, type FilterState } from "../components/Filters.js";
import { SignalChart } from "../components/Chart.js";
import { CompositionBar, COLORS, fmtCompact, fmtCompactPrecise, fmtInt, fmtPct, fmtUsd } from "../components/ui.js";

const METRIC_FORMATTER: Record<string, (value: number) => string> = {
  processedTokens: fmtCompact,
  processedInputTokens: fmtCompact,
  freshInputTokens: fmtCompact,
  cacheReadInputTokens: fmtCompact,
  outputTokens: fmtCompact,
  costUsd: (value) => fmtUsd(value / 1e9),
  requests: fmtCompact,
};

export function Overview() {
  const [filters, setFilters] = useFilterState();

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

  const previousRange = useMemo(() => {
    if (!range.from) return null;
    const start = new Date(range.from).getTime();
    const end = range.to ? new Date(range.to).getTime() : Date.now();
    const duration = end - start;
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return {
      ...range,
      from: new Date(start - duration).toISOString(),
      to: new Date(start).toISOString(),
    };
  }, [range]);

  const chartMetric = filters.chartMetric ?? "processedTokens";
  const { data: dims } = useQuery({ queryKey: ["dimensions"], queryFn: api.dimensions });
  const { data: summary } = useQuery({ queryKey: ["summary", range], queryFn: () => api.summary(range) });
  const { data: previous } = useQuery({
    queryKey: ["summary", "previous", previousRange],
    queryFn: () => api.summary(previousRange!),
    enabled: Boolean(previousRange),
  });
  const { data: timeseries } = useQuery({
    queryKey: ["timeseries", range, chartMetric],
    queryFn: () => api.timeseries(range, chartMetric),
  });
  const modelCandidates = (dims?.models ?? []).slice(0, 12);
  const modelSummaries = useQueries({
    queries: modelCandidates.map((model) => ({
      queryKey: ["summary", "model", model.id, range],
      queryFn: () => api.summary({ ...range, model: [model.id] }),
      staleTime: 10_000,
    })),
  });

  const totals = summary?.totals;
  const previousTokens = previous?.totals.processedTokens;
  const change = totals && previousTokens ? totals.processedTokens / previousTokens - 1 : null;
  const modelRows = modelCandidates
    .map((model, index) => ({ model, totals: modelSummaries[index]?.data?.totals }))
    .filter(({ totals: row }) => row == null || row.processedTokens > 0)
    .slice(0, 5);

  return (
    <div className="overview-page">
      <div className="page-head overview-head">
        <div className="titles">
          <h1>Overview</h1>
          <p className="page-sub">Observe usage across every coding agent.</p>
        </div>
        <FiltersBar dims={dims} filters={filters} onChange={setFilters} />
      </div>

      <section className="hero-readout" aria-labelledby="processed-label">
        <div className="hero-primary">
          <div className="hero-value">{fmtCompact(totals?.processedTokens)}</div>
          <div className="hero-caption" id="processed-label">tokens processed</div>
          <div className={`period-change${change != null && change < 0 ? " negative" : ""}${change != null && change >= 0.1 ? " notable" : ""}`}>
            {change == null ? `${fmtInt(totals?.requests)} requests · ${fmtInt(totals?.sessions)} sessions` : `${change >= 0 ? "+" : ""}${fmtPct(change)} vs previous ${rangeLabel(filters.range).replace("last ", "")}`}
          </div>
        </div>
        <div className="secondary-readings">
          <Readout label="uncached input" value={fmtCompact(totals?.freshInputTokens)} />
          <Readout label="cached input" value={fmtCompact(totals?.cacheReadInputTokens)} />
          <Readout label="output" value={fmtCompact(totals?.outputTokens)} />
          <Readout label="estimated cost" value={fmtUsd(totals?.costUsd)} />
        </div>
      </section>

      <section className="instrument-section usage-section">
        <div className="section-head">
          <div>
            <h2>Usage over time</h2>
            <span className="hint">Daily observations · {rangeLabel(filters.range)}</span>
          </div>
          <div className="select-wrap metric-select">
            <select aria-label="Chart metric" value={chartMetric} onChange={(event) => setFilters({ ...filters, chartMetric: event.target.value })}>
              {CHART_METRICS.map((metric) => <option key={metric.id} value={metric.id}>{metric.label}</option>)}
            </select>
          </div>
        </div>
        {timeseries ? (
          <SignalChart
            buckets={timeseries.buckets}
            providers={timeseries.providers}
            points={timeseries.points}
            formatValue={METRIC_FORMATTER[chartMetric] ?? fmtCompact}
          />
        ) : <div className="skeleton chart-skeleton" />}
      </section>

      <section className="instrument-section composition-section">
        <div className="section-head">
          <div><h2>Token composition</h2><span className="hint">How processed usage was composed</span></div>
          <Link to="/analysis" className="section-link">Token analysis <span>→</span></Link>
        </div>
        <div className="composition-focus">
          <strong>{fmtPct(totals?.cacheHitRate)}</strong>
          <span>cached input</span>
        </div>
        <CompositionBar
          total={totals?.processedTokens ?? 0}
          segments={[
            { label: "Cached input", value: totals?.cacheReadInputTokens ?? 0, color: COLORS.cacheRead },
            { label: "Uncached input", value: totals?.freshInputTokens ?? 0, color: COLORS.fresh },
            { label: "Output", value: totals?.outputTokens ?? 0, color: COLORS.output },
            { label: "Other", value: (totals?.cacheWriteInputTokens ?? 0) + (totals?.unattributedTokens ?? 0), color: COLORS.unattributed },
          ]}
        />
      </section>

      <section className="instrument-section models-section">
        <div className="section-head"><div><h2>Models</h2><span className="hint">Processed usage by model</span></div></div>
        <div className="table-scroll">
          <table className="data instrument-table">
            <thead><tr><th>Model</th><th>Processed</th><th>Input</th><th>Output</th><th>Cache</th><th>Cost</th></tr></thead>
            <tbody>
              {modelRows.map(({ model, totals: row }) => {
                return <tr key={model.id}>
                  <td><span className="model-id">{model.display}</span></td>
                  <td className="tnum">{fmtCompactPrecise(row?.processedTokens)}</td>
                  <td className="tnum">{fmtCompactPrecise(row?.processedInputTokens)}</td>
                  <td className="tnum">{fmtCompactPrecise(row?.outputTokens)}</td>
                  <td className="tnum">{fmtPct(row?.cacheHitRate)}</td>
                  <td className="tnum">{fmtUsd(row?.costUsd)}</td>
                </tr>
              })}
              {modelRows.length === 0 && <tr><td colSpan={6} className="empty">No model observations in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return <div className="readout"><div className="readout-value">{value}</div><div className="readout-label">{label}</div></div>;
}

function rangeLabel(range: FilterState["range"]): string {
  return ({ "7d": "last 7 days", "30d": "last 30 days", "90d": "last 90 days", "1y": "last year", all: "all observations", custom: "custom period" })[range];
}

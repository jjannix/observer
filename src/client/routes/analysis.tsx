import { useMemo, useState, type CSSProperties } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { NormalizedUsageEvent, SummaryTotals } from "@shared/contracts";
import { api, rangeToFilters } from "../api.js";
import { FiltersBar, useFilterState } from "../components/Filters.js";
import { MultiLineChart } from "../components/Chart.js";
import { colorForHarness } from "../components/colors.js";
import { COLORS, CompositionBar, fmtCompact, fmtCompactPrecise, fmtInt, fmtPct, fmtUsd } from "../components/ui.js";

export function Analysis() {
  const [filters, setFilters] = useFilterState();
  const [providerDetailsOpen, setProviderDetailsOpen] = useState(true);
  const [harnessDetailsOpen, setHarnessDetailsOpen] = useState(true);
  const range = useMemo(() => {
    const resolved = rangeToFilters(filters.range, "Europe/Berlin");
    return {
      from: filters.range === "custom" ? filters.from : resolved.from,
      to: filters.range === "custom" ? filters.to : resolved.to,
      harness: filters.harness,
      provider: filters.provider,
      model: filters.model,
      project: filters.project,
    };
  }, [filters]);

  const { data: dims } = useQuery({ queryKey: ["dimensions"], queryFn: api.dimensions });
  const { data: summary } = useQuery({ queryKey: ["summary", range], queryFn: () => api.summary(range) });
  const { data: timeseries } = useQuery({ queryKey: ["timeseries", "analysis", range], queryFn: () => api.timeseries(range, "processedTokens") });
  const { data: harnessTimeseries } = useQuery({ queryKey: ["timeseries", "analysis-harness", range], queryFn: () => api.timeseries(range, "processedTokens", "harness") });
  const { data: events } = useQuery({ queryKey: ["analysis", "events", range], queryFn: () => api.events(range, null, 250) });
  const providerCandidates = useMemo(() => {
    if (!timeseries) return [];
    const providerTotals = new Map<string, number>();
    for (const point of timeseries.points) providerTotals.set(point.provider, (providerTotals.get(point.provider) ?? 0) + point.value);
    return [...providerTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([provider]) => provider);
  }, [timeseries]);
  const providerSummaries = useQueries({
    queries: providerCandidates.map((provider) => ({
      queryKey: ["summary", "analysis-provider", provider, range],
      queryFn: () => api.summary({ ...range, provider: [provider] }),
      staleTime: 10_000,
    })),
  });
  const harnessCandidates = filters.harness?.length ? filters.harness : (dims?.harnesses ?? []);
  const harnessSummaries = useQueries({
    queries: harnessCandidates.map((harness) => ({
      queryKey: ["summary", "analysis-harness", harness, range],
      queryFn: () => api.summary({ ...range, harness: [harness] }),
      staleTime: 10_000,
    })),
  });
  const modelCandidates = (dims?.models ?? []).slice(0, 16);
  const modelSummaries = useQueries({
    queries: modelCandidates.map((model) => ({
      queryKey: ["summary", "analysis-model", model.id, range],
      queryFn: () => api.summary({ ...range, model: [model.id] }),
      staleTime: 10_000,
    })),
  });

  const totals = summary?.totals;
  const reasoning = totals?.reasoningOutputTokens ?? 0;
  const visibleOutput = Math.max(0, (totals?.outputTokens ?? 0) - reasoning);
  const costPerMillion = totals?.processedTokens ? (totals.costUsd / totals.processedTokens) * 1_000_000 : null;
  const cacheRate = totals?.cacheHitRate ?? null;
  const rawCost = totals && cacheRate != null && totals.costUsd > 0 ? totals.costUsd / Math.max(0.05, 1 - cacheRate) : null;
  const saved = rawCost == null ? null : Math.max(0, rawCost - (totals?.costUsd ?? 0));
  const largestSessions = useMemo(() => aggregateLargestSessions(events?.items ?? []).slice(0, 5), [events?.items]);
  const providerRows = providerCandidates
    .map((provider, index) => ({ id: provider, label: providerLabel(provider, dims?.providers), totals: providerSummaries[index]?.data?.totals }))
    .filter(({ totals: row }) => row == null || row.processedTokens > 0)
    .sort((a, b) => (b.totals?.processedTokens ?? 0) - (a.totals?.processedTokens ?? 0));
  const harnessRows = harnessCandidates
    .map((harness, index) => ({ id: harness, label: harnessLabel(harness), totals: harnessSummaries[index]?.data?.totals }))
    .filter(({ totals: row }) => row == null || row.processedTokens > 0)
    .sort((a, b) => (b.totals?.processedTokens ?? 0) - (a.totals?.processedTokens ?? 0));
  const providerChart = useMemo(() => timeseries ? {
    buckets: timeseries.buckets,
    providers: timeseries.providers.map((provider) => providerLabel(provider, dims?.providers)),
    points: timeseries.points.map((point) => ({ ...point, provider: providerLabel(point.provider, dims?.providers) })),
  } : null, [dims?.providers, timeseries]);
  const harnessChart = useMemo(() => harnessTimeseries ? {
    buckets: harnessTimeseries.buckets,
    providers: harnessTimeseries.providers.map(harnessLabel),
    points: harnessTimeseries.points.map((point) => ({ ...point, provider: harnessLabel(point.provider) })),
  } : null, [harnessTimeseries]);
  const modelRows = modelCandidates
    .map((model, index) => ({ model, totals: modelSummaries[index]?.data?.totals }))
    .filter(({ totals: row }) => row == null || row.processedTokens > 0)
    .sort((a, b) => (b.totals?.processedTokens ?? 0) - (a.totals?.processedTokens ?? 0))
    .slice(0, 8);

  return (
    <div className="analysis-page">
      <div className="page-head">
        <div className="titles"><h1>Analysis</h1><p className="page-sub">Understand composition, economics, and efficiency.</p></div>
        <FiltersBar dims={dims} filters={filters} onChange={setFilters} />
      </div>

      <section className="analysis-efficiency" aria-labelledby="efficiency-heading">
        <h2 id="efficiency-heading">Efficiency</h2>
        <div className="analysis-readings">
          <Readout value={fmtPct(totals?.cacheHitRate)} label="cache hit" detail="share of processed input read from cache" />
          <Readout value={fmtPct(totals?.outputInputRatio, 2)} label="output / input" detail="generated tokens relative to processed input" />
          <Readout value={fmtUsd(costPerMillion)} label="per 1M processed" detail="effective observed unit cost" />
        </div>
      </section>

      <section className="instrument-section analysis-composition">
        <div className="section-head"><div><h2>Token composition</h2><span className="hint">{fmtCompact(totals?.processedTokens)} classified tokens</span></div></div>
        <CompositionBar total={totals?.processedTokens ?? 0} segments={[
          { label: "Cached input", value: totals?.cacheReadInputTokens ?? 0, color: COLORS.cacheRead },
          { label: "Uncached input", value: totals?.freshInputTokens ?? 0, color: COLORS.fresh },
          { label: "Cache write", value: totals?.cacheWriteInputTokens ?? 0, color: COLORS.cacheWrite },
          { label: "Output", value: visibleOutput, color: COLORS.output },
          { label: "Reasoning", value: reasoning, color: COLORS.reasoning },
          { label: "Unattributed", value: totals?.unattributedTokens ?? 0, color: COLORS.unattributed },
        ]} />
      </section>

      <section className="instrument-section cache-economics">
        <div className="section-head"><div><h2>Cache economics</h2><span className="hint">Estimated from observed effective cost</span></div></div>
        <div className="economics-readings">
          <div className="economics-metric"><strong>{fmtUsd(rawCost)}</strong><span>equivalent uncached cost</span></div>
          <div className="economics-metric"><strong>{fmtUsd(totals?.costUsd)}</strong><span>actual estimated cost</span></div>
          <div className="economics-metric savings"><strong>{fmtUsd(saved)}</strong><span>estimated savings through caching</span></div>
        </div>
        <p className="calculation-note">The uncached equivalent scales observed cost by the uncached input share. It is directional, not an invoice.</p>
      </section>

      <section className="instrument-section provider-section">
        <div className="section-head"><div><h2>Usage by provider</h2><span className="hint">Compare the services delivering your model usage</span></div></div>
        <div className={`dimension-comparison-layout${providerDetailsOpen ? "" : " is-collapsed"}`}>
          <ComparisonSidebar dimension="provider" open={providerDetailsOpen} onToggle={() => setProviderDetailsOpen((open) => !open)} rows={providerRows} total={totals?.processedTokens ?? 0} empty="No provider observations in this period." />
          <div className="dimension-chart">
            {providerChart ? <MultiLineChart buckets={providerChart.buckets} providers={providerChart.providers} points={providerChart.points} formatValue={fmtCompact} ariaLabel="Provider usage comparison over time" /> : <div className="skeleton chart-skeleton" />}
          </div>
        </div>
      </section>

      <section className="instrument-section harness-section">
        <div className="section-head"><div><h2>Usage by harness</h2><span className="hint">Compare volume, composition, and activity across coding agents</span></div></div>
        <div className={`dimension-comparison-layout${harnessDetailsOpen ? "" : " is-collapsed"}`}>
          <ComparisonSidebar dimension="harness" open={harnessDetailsOpen} onToggle={() => setHarnessDetailsOpen((open) => !open)} rows={harnessRows} total={totals?.processedTokens ?? 0} empty="No harness observations in this period." />
          <div className="dimension-chart">
            {harnessChart ? <MultiLineChart buckets={harnessChart.buckets} providers={harnessChart.providers} points={harnessChart.points} formatValue={fmtCompact} ariaLabel="Harness usage comparison over time" seriesColor={colorForHarness} fillAreas /> : <div className="skeleton chart-skeleton" />}
          </div>
        </div>
        <div className="harness-metrics-head"><h3>Comparison metrics</h3><span>Best value for each metric is highlighted</span></div>
        <HarnessMetricMatrix rows={harnessRows} total={totals?.processedTokens ?? 0} />
      </section>

      <section className="instrument-section models-section">
        <div className="section-head"><div><h2>Models</h2><span className="hint">Accounting by model</span></div></div>
        <div className="table-scroll"><table className="data instrument-table analysis-models">
          <thead><tr><th>Model</th><th>Processed</th><th>Uncached input</th><th>Cached input</th><th>Output</th><th>Cache</th><th>Cost</th></tr></thead>
          <tbody>
            {modelRows.map(({ model, totals: row }) => {
              return <tr key={model.id}>
                <td><span className="model-id">{model.display}</span></td>
                <td className="tnum">{fmtCompactPrecise(row?.processedTokens)}</td>
                <td className="tnum">{fmtCompactPrecise(row?.freshInputTokens)}</td>
                <td className="tnum">{fmtCompactPrecise(row?.cacheReadInputTokens)}</td>
                <td className="tnum">{fmtCompactPrecise(row?.outputTokens)}</td>
                <td className="tnum">{fmtPct(row?.cacheHitRate)}</td>
                <td className="tnum">{fmtUsd(row?.costUsd)}</td>
              </tr>;
            })}
            {modelRows.length === 0 && <tr><td colSpan={7} className="empty">No model observations in this period.</td></tr>}
          </tbody>
        </table></div>
      </section>

      <section className="instrument-section largest-sessions">
        <div className="section-head"><div><h2>Largest sessions</h2><span className="hint">Loaded observations ranked by processed tokens</span></div></div>
        <div className="table-scroll"><table className="data instrument-table">
          <thead><tr><th>Started</th><th>Model</th><th>Project</th><th>Processed</th><th>Cost</th></tr></thead>
          <tbody>
            {largestSessions.map((session) => <tr key={session.id}>
              <td>{formatDate(session.startedAt)}</td>
              <td><span className="model-id">{session.model}</span></td>
              <td><span className="project-id" title={session.project}>{projectLabel(session.project, dims?.projects)}</span></td>
              <td className="tnum">{fmtCompact(session.processed)}</td>
              <td className="tnum">{fmtUsd(session.cost)}</td>
            </tr>)}
            {largestSessions.length === 0 && <tr><td colSpan={5} className="empty">No sessions in this period.</td></tr>}
          </tbody>
        </table></div>
      </section>
    </div>
  );
}

function aggregateLargestSessions(events: NormalizedUsageEvent[]): Array<{ id: string; startedAt: string; model: string; project: string; processed: number; cost: number }> {
  const groups = new Map<string, NormalizedUsageEvent[]>();
  for (const event of events) groups.set(event.sessionId, [...(groups.get(event.sessionId) ?? []), event]);
  return [...groups.entries()].map(([id, rows]) => ({
    id,
    startedAt: [...rows].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))[0].occurredAt,
    model: rows[0].canonicalModelId ?? rows[0].rawModelId ?? "unknown-model",
    project: rows[0].projectId ?? "Unassigned",
    processed: rows.reduce((sum, row) => sum + row.processedTokens, 0),
    cost: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
  })).sort((a, b) => b.processed - a.processed);
}

function formatDate(iso: string): string { return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)); }
function providerLabel(value: string, providers: Array<{ id: string; display: string }> | undefined): string { return providers?.find((provider) => provider.id === value)?.display ?? value; }
function harnessLabel(value: string): string { return ({ codex: "Codex", pi: "Pi", opencode: "OpenCode", "claude-code": "Claude Code", cursor: "Cursor" } as Record<string, string>)[value] ?? value; }
function shortId(value: string): string { const parts = value.replace(/\\/g, "/").split("/").filter(Boolean); return parts.at(-1) ?? value; }
function projectLabel(projectId: string, projects: Array<{ id: string; path: string }> | undefined): string { const resolved = projects?.find((project) => project.id === projectId); return shortId(resolved?.path ?? projectId); }
function Readout({ value, label, detail }: { value: string; label: string; detail: string }) { return <div className="readout"><div className="readout-value">{value}</div><div className="readout-label">{label}</div><div className="readout-detail">{detail}</div></div>; }
function HarnessMetricMatrix({ rows, total }: { rows: Array<{ id: string; label: string; totals: SummaryTotals | undefined }>; total: number }) {
  const [activeHarness, setActiveHarness] = useState<string | null>(null);
  const metrics: Array<{
    label: string;
    primary?: boolean;
    direction: "max" | "min";
    bestLabel: string;
    score: (row: SummaryTotals | undefined) => number | null;
    value: (row: SummaryTotals | undefined) => string;
    detail?: (row: SummaryTotals | undefined) => string;
  }> = [
    {
      label: "Processed tokens",
      primary: true,
      direction: "max",
      bestLabel: "Highest processed volume",
      score: (row) => row?.processedTokens ?? null,
      value: (row) => fmtCompactPrecise(row?.processedTokens),
      detail: (row) => `${fmtPct(total > 0 ? (row?.processedTokens ?? 0) / total : null)} of selected usage`,
    },
    {
      label: "Uncached input",
      direction: "min",
      bestLabel: "Lowest uncached input",
      score: (row) => row?.freshInputTokens ?? null,
      value: (row) => fmtCompactPrecise(row?.freshInputTokens),
      detail: (row) => `${fmtPct(row?.processedInputTokens ? row.freshInputTokens / row.processedInputTokens : null)} of input`,
    },
    {
      label: "Cached input",
      direction: "max",
      bestLabel: "Most cached input",
      score: (row) => row?.cacheReadInputTokens ?? null,
      value: (row) => fmtCompactPrecise(row?.cacheReadInputTokens),
    },
    {
      label: "Cache hit rate",
      direction: "max",
      bestLabel: "Highest cache hit rate",
      score: (row) => row?.cacheHitRate ?? null,
      value: (row) => fmtPct(row?.cacheHitRate),
      detail: () => "of processed input",
    },
    {
      label: "Output",
      direction: "max",
      bestLabel: "Most output",
      score: (row) => row?.outputTokens ?? null,
      value: (row) => fmtCompactPrecise(row?.outputTokens),
      detail: (row) => `${fmtPct(row?.outputInputRatio)} of input`,
    },
    {
      label: "Estimated cost",
      direction: "min",
      bestLabel: "Lowest covered estimated cost",
      score: (row) => row && (row.costCoverage ?? 0) >= .5 ? row.costUsd : null,
      value: (row) => (row?.costCoverage ?? 0) > 0 ? fmtUsd(row?.costUsd) : "—",
      detail: (row) => (row?.costCoverage ?? 0) > 0 ? `${fmtPct(row?.costCoverage)} covered` : "cost unavailable",
    },
    { label: "Requests", direction: "max", bestLabel: "Most requests", score: (row) => row?.requests ?? null, value: (row) => fmtInt(row?.requests) },
    { label: "Sessions", direction: "max", bestLabel: "Most sessions", score: (row) => row?.sessions ?? null, value: (row) => fmtInt(row?.sessions) },
  ];

  if (rows.length === 0) return <div className="empty harness-metric-empty">No harness observations in this period.</div>;

  return <div className="harness-metric-scroll" onMouseLeave={() => setActiveHarness(null)}>
    <table className={`harness-metric-matrix${activeHarness ? " has-active-column" : ""}`} style={{ minWidth: `${164 + rows.length * 205}px` }}>
      <caption className="sr-only">Usage metrics separated by harness</caption>
      <thead><tr><th scope="col">Metric</th>{rows.map((row) => <th scope="col" key={row.id} className={activeHarness === row.id ? "is-active-column" : ""} onMouseEnter={() => setActiveHarness(row.id)}><span><i className="series-dot" style={{ background: colorForHarness(row.label) }} />{row.label}</span></th>)}</tr></thead>
      <tbody>{metrics.map((metric) => {
        const scoredRows = rows.map((row) => ({ id: row.id, score: metric.score(row.totals) })).filter((row): row is { id: string; score: number } => row.score != null && Number.isFinite(row.score));
        const bestScore = scoredRows.length > 1 ? (metric.direction === "max" ? Math.max(...scoredRows.map((row) => row.score)) : Math.min(...scoredRows.map((row) => row.score))) : null;
        return <tr key={metric.label} className={metric.primary ? "primary" : ""}>
          <th scope="row">{metric.label}</th>
          {rows.map((row) => {
            const isBest = bestScore != null && metric.score(row.totals) === bestScore;
            const color = colorForHarness(row.label);
            return <td
              key={row.id}
              className={`${isBest ? "is-best " : ""}${activeHarness === row.id ? "is-active-column" : ""}`.trim()}
              style={{ "--harness-color": color } as CSSProperties}
              title={isBest ? `${metric.bestLabel}: ${row.label}` : undefined}
              onMouseEnter={() => setActiveHarness(row.id)}
            >
              <strong>{metric.value(row.totals)}</strong>
              {metric.detail && <small>{metric.detail(row.totals)}</small>}
            </td>;
          })}
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
function ComparisonSidebar({ dimension, open, onToggle, rows, total, empty }: { dimension: "provider" | "harness"; open: boolean; onToggle: () => void; rows: Array<{ id: string; label: string; totals: SummaryTotals | undefined }>; total: number; empty: string }) {
  const label = `${open ? "Collapse" : "Expand"} ${dimension} sidebar`;
  return <aside className={`dimension-sidebar${open ? "" : " is-collapsed"}`} aria-label={`${dimension} breakdown`}>
    <ComparisonBreakdown id={`${dimension}-breakdown`} hidden={!open} rows={rows} total={total} empty={empty} />
    <button className="dimension-sidebar-toggle" type="button" aria-controls={`${dimension}-breakdown`} aria-expanded={open} aria-label={label} title={label} onClick={onToggle}>
      <svg viewBox="0 0 14 14" aria-hidden="true"><path d={open ? "M9 3.5 5.5 7 9 10.5" : "M5 3.5 8.5 7 5 10.5"} /></svg>
    </button>
  </aside>;
}
function ComparisonBreakdown({ id, hidden, rows, total, empty }: { id: string; hidden: boolean; rows: Array<{ id: string; label: string; totals: SummaryTotals | undefined }>; total: number; empty: string }) {
  return <div className="dimension-breakdown" id={id} hidden={hidden}>
    {rows.map(({ id, label, totals: row }, index) => {
      const share = total > 0 ? (row?.processedTokens ?? 0) / total : 0;
      return <div className="dimension-row" key={id}>
        <div className="dimension-row-head"><strong>{label}</strong><span>{fmtCompactPrecise(row?.processedTokens)}</span></div>
        <div className="dimension-share-track"><i className={`series-${index}`} style={{ width: `${share * 100}%` }} /></div>
        <div className="dimension-row-meta"><span>{fmtPct(share)} of usage</span><span>{fmtCompact(row?.outputTokens)} output</span><span>{fmtInt(row?.sessions)} sessions</span><span>{row?.costCoverage ? `${fmtUsd(row.costUsd)} cost` : "cost unavailable"}</span></div>
      </div>;
    })}
    {rows.length === 0 && <div className="empty dimension-empty">{empty}</div>}
  </div>;
}

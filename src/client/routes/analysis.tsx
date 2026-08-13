import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { NormalizedUsageEvent } from "@shared/contracts";
import { api, rangeToFilters } from "../api.js";
import { FiltersBar, useFilterState } from "../components/Filters.js";
import { MultiLineChart } from "../components/Chart.js";
import { COLORS, CompositionBar, fmtCompact, fmtCompactPrecise, fmtInt, fmtPct, fmtUsd } from "../components/ui.js";

export function Analysis() {
  const [filters, setFilters] = useFilterState();
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
  const harnessRows = harnessCandidates
    .map((harness, index) => ({ harness, totals: harnessSummaries[index]?.data?.totals }))
    .filter(({ totals: row }) => row == null || row.processedTokens > 0)
    .sort((a, b) => (b.totals?.processedTokens ?? 0) - (a.totals?.processedTokens ?? 0));
  const harnessTotal = harnessRows.reduce((sum, row) => sum + (row.totals?.processedTokens ?? 0), 0);
  const harnessChart = useMemo(() => harnessTimeseries ? {
    buckets: harnessTimeseries.buckets,
    providers: harnessTimeseries.providers.map(harnessLabel),
    points: harnessTimeseries.points.map((point) => ({ ...point, provider: harnessLabel(point.provider) })),
  } : null, [harnessTimeseries]);
  const modelRows = modelCandidates
    .map((model, index) => ({ model, totals: modelSummaries[index]?.data?.totals }))
    .filter(({ totals: row }) => row == null || row.processedTokens > 0)
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
        <div className="section-head"><div><h2>Usage by provider</h2><span className="hint">Daily processed-token signals</span></div></div>
        {timeseries ? <MultiLineChart buckets={timeseries.buckets} providers={timeseries.providers} points={timeseries.points} formatValue={fmtCompact} /> : <div className="skeleton chart-skeleton" />}
      </section>

      <section className="instrument-section harness-section">
        <div className="section-head"><div><h2>Usage by harness</h2><span className="hint">Compare the coding agents behind your observations</span></div></div>
        <div className="harness-comparison-layout">
          <div className="harness-breakdown">
            {harnessRows.map(({ harness, totals: row }, index) => {
              const share = harnessTotal > 0 ? (row?.processedTokens ?? 0) / harnessTotal : 0;
              return <div className="harness-row" key={harness}>
                <div className="harness-row-head"><strong>{harnessLabel(harness)}</strong><span>{fmtCompactPrecise(row?.processedTokens)}</span></div>
                <div className="harness-share-track"><i className={`series-${index}`} style={{ width: `${share * 100}%` }} /></div>
                <div className="harness-row-meta"><span>{fmtPct(share)} of usage</span><span>{fmtCompact(row?.outputTokens)} output</span><span>{fmtInt(row?.sessions)} sessions</span><span>{row?.costCoverage ? `${fmtUsd(row.costUsd)} cost` : "cost unavailable"}</span></div>
              </div>;
            })}
            {harnessRows.length === 0 && <div className="empty harness-empty">No harness observations in this period.</div>}
          </div>
          <div className="harness-chart">
            {harnessChart ? <MultiLineChart buckets={harnessChart.buckets} providers={harnessChart.providers} points={harnessChart.points} formatValue={fmtCompact} ariaLabel="Harness usage comparison over time" /> : <div className="skeleton chart-skeleton" />}
          </div>
        </div>
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
function harnessLabel(value: string): string { return ({ codex: "Codex", pi: "Pi", opencode: "OpenCode", "claude-code": "Claude Code" } as Record<string, string>)[value] ?? value; }
function shortId(value: string): string { const parts = value.replace(/\\/g, "/").split("/").filter(Boolean); return parts.at(-1) ?? value; }
function projectLabel(projectId: string, projects: Array<{ id: string; path: string }> | undefined): string { const resolved = projects?.find((project) => project.id === projectId); return shortId(resolved?.path ?? projectId); }
function Readout({ value, label, detail }: { value: string; label: string; detail: string }) { return <div className="readout"><div className="readout-value">{value}</div><div className="readout-label">{label}</div><div className="readout-detail">{detail}</div></div>; }

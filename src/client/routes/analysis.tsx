import { useId, useMemo, useState, type CSSProperties } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { CacheAttributionHarness, NormalizedUsageEvent, SummaryTotals } from "@shared/contracts";
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
  const { data: cacheAttribution, isPending: cacheAttributionPending } = useQuery({ queryKey: ["cache-attribution", range], queryFn: () => api.cacheAttribution(range) });
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
  const { data: modelsBreakdown } = useQuery({
    queryKey: ["models-breakdown", range],
    queryFn: () => api.modelsBreakdown(range),
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
  const cacheAttributionByHarness = new Map(cacheAttribution?.harnesses.map((row) => [row.harness, row]) ?? []);
  const harnessRows = harnessCandidates
    .map((harness, index) => ({ id: harness, label: harnessLabel(harness), totals: harnessSummaries[index]?.data?.totals, attribution: cacheAttributionByHarness.get(harness) }))
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
  const modelRows = (modelsBreakdown?.models ?? []).slice(0, 8);

  return (
    <div className="analysis-page">
      <div className="page-head">
        <div className="titles"><h1>Analysis</h1><p className="page-sub">Understand composition, economics, and efficiency.</p></div>
        <FiltersBar dims={dims} filters={filters} onChange={setFilters} />
      </div>

      <section className="analysis-efficiency" aria-labelledby="efficiency-heading">
        <h2 id="efficiency-heading">Efficiency</h2>
        <div className="analysis-readings">
          <Readout value={fmtPct(totals?.cacheHitRate)} label="observed cache-read share" detail="cache-read input / processed input; provider mix affects this value" />
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
        <div className="harness-metrics-head"><h3>Comparison metrics</h3><span>Provider-adjusted values require qualified peer samples</span></div>
        <HarnessMetricMatrix rows={harnessRows} total={totals?.processedTokens ?? 0} />
        <CacheAttributionPanel harnesses={cacheAttribution?.harnesses ?? []} loading={cacheAttributionPending} />
      </section>

      <section className="instrument-section models-section">
        <div className="section-head"><div><h2>Models</h2><span className="hint">Accounting by model</span></div></div>
        <div className="table-scroll"><table className="data instrument-table analysis-models">
          <thead><tr><th>Model</th><th>Processed</th><th>Uncached input</th><th>Cached input</th><th>Output</th><th>Cache</th><th>Cost</th></tr></thead>
          <tbody>
            {modelRows.map((model) => {
              return <tr key={model.id}>
                <td><span className="model-id">{model.display}</span></td>
                <td className="tnum">{fmtCompactPrecise(model.processedTokens)}</td>
                <td className="tnum">{fmtCompactPrecise(model.freshInputTokens)}</td>
                <td className="tnum">{fmtCompactPrecise(model.cacheReadInputTokens)}</td>
                <td className="tnum">{fmtCompactPrecise(model.outputTokens)}</td>
                <td className="tnum">{fmtPct(model.cacheHitRate)}</td>
                <td className="tnum">{fmtUsd(model.costUsd)}</td>
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
type HarnessMetricRow = {
  id: string;
  label: string;
  totals: SummaryTotals | undefined;
  attribution: CacheAttributionHarness | undefined;
};

const HARNESS_METRIC_HELP: Record<string, string> = {
  "Processed tokens": "Processed input plus output and unattributed tokens. This measures volume, not efficiency.",
  "Uncached input": "Fresh input tokens not reported as cache reads or cache writes. The percentage uses total processed input as its denominator.",
  "Cached input": "Input tokens the source reports as cache reads. This is an absolute token count.",
  "Observed cache-read share": "Cache-read input divided by all processed input for this harness. It describes observed traffic and is not ranked because provider mix affects it.",
  "Provider-adjusted lift": "On providers with meaningful traffic in both harnesses, compare this harness with a leave-one-harness-out provider baseline. Each side needs at least 1M input tokens, neither may exceed the other by more than 20×, and the provider must represent at least 5% of the target harness's input. Lift is comparable observed share minus expected share. Values below 70% comparable coverage are shown but not ranked. This controls provider mix only; model and workload differences remain.",
  Output: "Generated output tokens. The supporting percentage is output divided by processed input.",
  "Estimated cost": "Sum of source-reported cost only. Harnesses without reported cost are excluded from the best-value comparison.",
  Requests: "Count of normalized usage requests observed in the selected period.",
  Sessions: "Count of distinct harness sessions with usage in the selected period.",
};

function HarnessMetricMatrix({ rows, total }: { rows: HarnessMetricRow[]; total: number }) {
  const [activeHarness, setActiveHarness] = useState<string | null>(null);
  const metrics: Array<{
    label: string;
    primary?: boolean;
    direction: "max" | "min";
    bestLabel: string;
    score: (row: HarnessMetricRow) => number | null;
    value: (row: HarnessMetricRow) => string;
    detail?: (row: HarnessMetricRow) => string;
  }> = [
    {
      label: "Processed tokens",
      primary: true,
      direction: "max",
      bestLabel: "Highest processed volume",
      score: (row) => row.totals?.processedTokens ?? null,
      value: (row) => fmtCompactPrecise(row.totals?.processedTokens),
      detail: (row) => `${fmtPct(total > 0 ? (row.totals?.processedTokens ?? 0) / total : null)} of selected usage`,
    },
    {
      label: "Uncached input",
      direction: "min",
      bestLabel: "Lowest uncached input",
      score: (row) => row.totals?.freshInputTokens ?? null,
      value: (row) => fmtCompactPrecise(row.totals?.freshInputTokens),
      detail: (row) => `${fmtPct(row.totals?.processedInputTokens ? row.totals.freshInputTokens / row.totals.processedInputTokens : null)} of input`,
    },
    {
      label: "Cached input",
      direction: "max",
      bestLabel: "Most cached input",
      score: (row) => row.totals?.cacheReadInputTokens ?? null,
      value: (row) => fmtCompactPrecise(row.totals?.cacheReadInputTokens),
    },
    {
      label: "Observed cache-read share",
      direction: "max",
      bestLabel: "Observed cache-read share",
      score: () => null,
      value: (row) => fmtPct(row.attribution?.observedRate ?? row.totals?.cacheHitRate),
      detail: () => "provider mix affects this value",
    },
    {
      label: "Provider-adjusted lift",
      direction: "max",
      bestLabel: "Highest provider-adjusted lift",
      score: (row) => (row.attribution?.comparisonCoverage ?? 0) >= .7 ? row.attribution?.adjustedLift ?? null : null,
      value: (row) => fmtPercentagePoints(row.attribution?.adjustedLift),
      detail: (row) => !row.attribution
        ? "loading attribution"
        : row.attribution.adjustedLift == null
          ? "no shared provider traffic"
          : `${fmtPct(row.attribution.comparisonCoverage)} qualified input${(row.attribution.comparisonCoverage ?? 0) < .7 ? " · low coverage" : ""}`,
    },
    {
      label: "Output",
      direction: "max",
      bestLabel: "Most output",
      score: (row) => row.totals?.outputTokens ?? null,
      value: (row) => fmtCompactPrecise(row.totals?.outputTokens),
      detail: (row) => `${fmtPct(row.totals?.outputInputRatio)} of input`,
    },
    {
      label: "Estimated cost",
      direction: "min",
      bestLabel: "Lowest covered estimated cost",
      score: (row) => row.totals && (row.totals.costCoverage ?? 0) >= .5 ? row.totals.costUsd : null,
      value: (row) => (row.totals?.costCoverage ?? 0) > 0 ? fmtUsd(row.totals?.costUsd) : "—",
      detail: (row) => (row.totals?.costCoverage ?? 0) > 0 ? `${fmtPct(row.totals?.costCoverage)} covered` : "cost unavailable",
    },
    { label: "Requests", direction: "max", bestLabel: "Most requests", score: (row) => row.totals?.requests ?? null, value: (row) => fmtInt(row.totals?.requests) },
    { label: "Sessions", direction: "max", bestLabel: "Most sessions", score: (row) => row.totals?.sessions ?? null, value: (row) => fmtInt(row.totals?.sessions) },
  ];

  if (rows.length === 0) return <div className="empty harness-metric-empty">No harness observations in this period.</div>;

  return <div className="harness-metric-scroll" onMouseLeave={() => setActiveHarness(null)}>
    <table className={`harness-metric-matrix${activeHarness ? " has-active-column" : ""}`} style={{ minWidth: `${164 + rows.length * 205}px` }}>
      <caption className="sr-only">Usage metrics separated by harness</caption>
      <thead><tr><th scope="col">Metric</th>{rows.map((row) => <th scope="col" key={row.id} className={activeHarness === row.id ? "is-active-column" : ""} onMouseEnter={() => setActiveHarness(row.id)}><span><i className="series-dot" style={{ background: colorForHarness(row.label) }} />{row.label}</span></th>)}</tr></thead>
      <tbody>{metrics.map((metric) => {
        const scoredRows = rows.map((row) => ({ id: row.id, score: metric.score(row) })).filter((row): row is { id: string; score: number } => row.score != null && Number.isFinite(row.score));
        const bestScore = scoredRows.length > 1 ? (metric.direction === "max" ? Math.max(...scoredRows.map((row) => row.score)) : Math.min(...scoredRows.map((row) => row.score))) : null;
        return <tr key={metric.label} className={metric.primary ? "primary" : ""}>
          <th scope="row"><span className="metric-name">{metric.label}<MetricHelp text={HARNESS_METRIC_HELP[metric.label]} /></span></th>
          {rows.map((row) => {
            const isBest = bestScore != null && metric.score(row) === bestScore;
            const color = colorForHarness(row.label);
            return <td
              key={row.id}
              className={`${isBest ? "is-best " : ""}${activeHarness === row.id ? "is-active-column" : ""}`.trim()}
              style={{ "--harness-color": color } as CSSProperties}
              title={isBest ? `${metric.bestLabel}: ${row.label}` : undefined}
              onMouseEnter={() => setActiveHarness(row.id)}
            >
              <strong>{metric.value(row)}</strong>
              {metric.detail && <small>{metric.detail(row)}</small>}
            </td>;
          })}
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function CacheAttributionPanel({ harnesses, loading }: { harnesses: CacheAttributionHarness[]; loading: boolean }) {
  const [selectedHarness, setSelectedHarness] = useState<string | null>(null);
  const active = harnesses.find((row) => row.harness === selectedHarness) ?? harnesses[0];

  if (loading) return <div className="skeleton cache-attribution-skeleton" />;
  if (!active) return <div className="empty cache-attribution-empty">No provider attribution is available for this period.</div>;

  const activeLabel = harnessLabel(active.harness);
  const reliable = (active.comparisonCoverage ?? 0) >= .7;
  return <section className="cache-attribution" aria-labelledby="cache-attribution-heading">
    <div className="cache-attribution-head">
      <div><h3 id="cache-attribution-heading">Cache attribution</h3><span>Separate observed reuse from the provider mix behind it</span></div>
      <div className="cache-harness-tabs" role="tablist" aria-label="Cache attribution harness">
        {harnesses.map((row) => {
          const label = harnessLabel(row.harness);
          return <button key={row.harness} type="button" role="tab" aria-selected={row.harness === active.harness} className={row.harness === active.harness ? "active" : ""} onClick={() => setSelectedHarness(row.harness)}><i style={{ background: colorForHarness(label) }} />{label}</button>;
        })}
      </div>
    </div>

    <div className="cache-attribution-readings">
      <AttributionReading value={fmtPct(active.observedRate)} label="observed across all input" help="Cache-read input divided by processed input across every provider used by this harness." />
      <AttributionReading value={fmtPct(active.comparableObservedRate)} label="observed on qualified providers" help="The observed cache-read share after restricting this harness to providers with a qualified peer sample." />
      <AttributionReading value={fmtPct(active.providerExpectedRate)} label="expected on qualified providers" help="A weighted expectation using this harness's provider mix and qualified peer harness cache-read rates." />
      <AttributionReading value={fmtPercentagePoints(active.adjustedLift)} label="provider-adjusted lift" help="Qualified observed share minus provider-expected share, shown in percentage points." muted={!reliable} />
      <AttributionReading value={fmtPct(active.comparisonCoverage)} label="qualified input" help="Share of this harness's processed input delivered by providers with a qualified peer sample: at least 1M input on both sides, no more than a 20× input imbalance, and at least 5% of target input." />
    </div>

    <p className="cache-attribution-note">{active.adjustedLift == null
      ? `${activeLabel} has no known provider traffic shared with another harness in this period.`
      : !reliable
        ? `Only ${fmtPct(active.comparisonCoverage)} of ${activeLabel} input has a qualified peer sample. The adjusted lift is directional, not rankable.`
        : "Provider adjustment controls for provider mix only; model and workload differences can still affect caching."}</p>

    <div className="table-scroll">
      <table className="cache-provider-table">
        <thead><tr><th>Provider</th><th>Input mix</th><th>Observed</th><th>Qualified peers</th><th>Difference</th></tr></thead>
        <tbody>{active.providers.map((provider) => <tr key={provider.providerId}>
          <td><strong>{provider.display}</strong><small>{fmtCompact(provider.processedInputTokens)} processed input</small></td>
          <td><div className="cache-mix"><span><i style={{ width: `${(provider.inputShare ?? 0) * 100}%`, background: colorForHarness(activeLabel) }} /></span><small>{fmtPct(provider.inputShare)}</small></div></td>
          <td className="tnum">{fmtPct(provider.observedRate)}</td>
          <td className="tnum cache-peer-cell">{provider.otherHarnessRate == null ? <><span>Not comparable</span><small>{provider.comparisonNote}</small></> : <><span>{fmtPct(provider.otherHarnessRate)}</span><small>{fmtCompact(provider.comparatorInputTokens)} peer input</small></>}</td>
          <td className={`tnum${provider.lift != null && provider.lift > 0 ? " positive" : ""}`}>{fmtPercentagePoints(provider.lift)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

function AttributionReading({ value, label, help, muted = false }: { value: string; label: string; help: string; muted?: boolean }) {
  return <div className={muted ? "muted" : ""}><strong>{value}</strong><span>{label}<MetricHelp text={help} /></span></div>;
}

function MetricHelp({ text }: { text: string }) {
  const id = useId();
  return <span className="metric-help">
    <button type="button" aria-label="Explain metric" aria-describedby={id}>i</button>
    <span className="metric-help-tip" id={id} role="tooltip">{text}</span>
  </span>;
}

function fmtPercentagePoints(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const points = value * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pp`;
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

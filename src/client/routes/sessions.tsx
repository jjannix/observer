import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NormalizedUsageEvent } from "@shared/contracts";
import { api, rangeToFilters } from "../api.js";
import { DEFAULT_FILTERS, FiltersBar, type FilterState } from "../components/Filters.js";
import { COLORS, CompositionBar, fmtCompact, fmtInt, fmtUsd } from "../components/ui.js";

interface SessionRow {
  id: string;
  startedAt: string;
  finishedAt: string;
  harness: string;
  model: string;
  provider: string;
  project: string;
  processed: number;
  input: number;
  cached: number;
  fresh: number;
  output: number;
  reasoning: number;
  cost: number;
  events: NormalizedUsageEvent[];
}

export function Sessions() {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const { data, isFetching } = useQuery({ queryKey: ["sessions", range], queryFn: () => api.events(range, null, 250) });
  const sessions = useMemo(() => groupSessions(data?.items ?? []), [data?.items]);
  const selected = sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null;

  useEffect(() => {
    if (sessions.length > 0 && !sessions.some((session) => session.id === selectedId)) setSelectedId(sessions[0].id);
  }, [selectedId, sessions]);

  const medians = useMemo(() => ({
    processed: median(sessions.map((session) => session.processed)),
    output: median(sessions.map((session) => session.output)),
    cost: median(sessions.map((session) => session.cost)),
    duration: median(sessions.map((session) => durationMs(session))),
  }), [sessions]);

  return (
    <div className="sessions-page">
      <div className="page-head">
        <div className="titles"><h1>Sessions</h1><p className="page-sub">Inspect the observations behind your usage.</p></div>
        <FiltersBar dims={dims} filters={filters} onChange={setFilters} />
      </div>

      <section className="session-hero">
        <div className="session-total"><strong>{fmtInt(summary?.totals.sessions)}</strong><span>sessions observed</span></div>
        <p>{fmtCompact(summary?.totals.processedTokens)} processed · {fmtCompact(summary?.totals.outputTokens)} output · {fmtUsd(summary?.totals.costUsd)} estimated cost</p>
        <div className="session-medians">
          <Readout value={fmtCompact(medians.processed)} label="median processed" />
          <Readout value={fmtCompact(medians.output)} label="median output" />
          <Readout value={formatDuration(medians.duration)} label="median duration" />
          <Readout value={fmtUsd(medians.cost)} label="median cost" />
        </div>
      </section>

      <section className="instrument-section sessions-list">
        <div className="section-head"><div><h2>Observed sessions</h2><span className="hint">{fmtInt(sessions.length)} loaded · select a row to inspect</span></div></div>
        <div className="table-scroll">
          <table className="data instrument-table sessions-table">
            <thead><tr><th>Started</th><th>Harness</th><th>Model</th><th>Project</th><th>Processed</th><th>Output</th><th>Cost</th><th>Duration</th></tr></thead>
            <tbody>
              {sessions.map((session) => (
                <tr
                  key={session.id}
                  className={selected?.id === session.id ? "selected" : ""}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(session.id)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedId(session.id); }}
                >
                  <td>{formatStarted(session.startedAt)}</td>
                  <td>{harnessLabel(session.harness)}</td>
                  <td><span className="model-id">{session.model}</span></td>
                  <td><span className="project-id">{shortId(session.project)}</span></td>
                  <td className="tnum">{fmtCompact(session.processed)}</td>
                  <td className="tnum">{fmtCompact(session.output)}</td>
                  <td className="tnum">{fmtUsd(session.cost)}</td>
                  <td className="tnum">{formatDuration(durationMs(session))}</td>
                </tr>
              ))}
              {!isFetching && sessions.length === 0 && <tr><td colSpan={8} className="empty">No observations in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {selected && <SessionInspector session={selected} />}
    </div>
  );
}

function SessionInspector({ session }: { session: SessionRow }) {
  const visibleOutput = Math.max(0, session.output - session.reasoning);
  return (
    <section className="instrument-section session-inspector">
      <div className="section-head inspector-head">
        <div><h2>{formatStarted(session.startedAt)}</h2><span className="hint model-id">{session.id}</span></div>
        <span className="hint">{fmtInt(session.events.length)} normalized events</span>
      </div>
      <div className="inspector-readings">
        <Readout value={fmtCompact(session.processed)} label="processed" />
        <Readout value={fmtCompact(session.cached)} label="cached input" />
        <Readout value={fmtCompact(session.fresh)} label="uncached input" />
        <Readout value={fmtCompact(session.output)} label="output" />
      </div>
      <CompositionBar
        total={session.processed}
        segments={[
          { label: "Cached input", value: session.cached, color: COLORS.cacheRead },
          { label: "Uncached input", value: session.fresh, color: COLORS.fresh },
          { label: "Output", value: visibleOutput, color: COLORS.output },
          { label: "Reasoning", value: session.reasoning, color: COLORS.reasoning },
        ]}
      />
      <div className="inspector-grid">
        <dl className="session-metadata">
          <div><dt>Harness</dt><dd>{harnessLabel(session.harness)}</dd></div>
          <div><dt>Model</dt><dd className="model-id">{session.model}</dd></div>
          <div><dt>Project</dt><dd className="project-id">{shortId(session.project)}</dd></div>
          <div><dt>Provider</dt><dd>{session.provider}</dd></div>
          <div><dt>Started</dt><dd>{formatTimestamp(session.startedAt)}</dd></div>
          <div><dt>Duration</dt><dd>{formatDuration(durationMs(session))}</dd></div>
        </dl>
        <div className="session-timeline">
          <h3>Session timeline</h3>
          {timelineEvents(session).map((event) => <div key={`${event.label}-${event.time}`} className="timeline-event"><i /><span><strong>{event.label}</strong><small>{fmtClock(event.time)}{event.detail ? ` · ${event.detail}` : ""}</small></span></div>)}
        </div>
      </div>
    </section>
  );
}

function groupSessions(events: NormalizedUsageEvent[]): SessionRow[] {
  const groups = new Map<string, NormalizedUsageEvent[]>();
  for (const event of events) {
    const key = event.sessionId || event.requestId;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.entries()].map(([id, items]) => {
    const ordered = [...items].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const first = ordered[0];
    const last = ordered.at(-1)!;
    return {
      id,
      startedAt: first.occurredAt,
      finishedAt: last.occurredAt,
      harness: first.harness,
      model: first.canonicalModelId ?? first.rawModelId ?? "unknown-model",
      provider: first.canonicalProviderId ?? first.rawProviderId ?? "Unknown",
      project: first.projectId ?? "Unassigned",
      processed: sum(ordered, (event) => event.processedTokens),
      input: sum(ordered, (event) => event.processedInputTokens),
      cached: sum(ordered, (event) => event.cacheReadInputTokens),
      fresh: sum(ordered, (event) => event.freshInputTokens),
      output: sum(ordered, (event) => event.outputTokens),
      reasoning: sum(ordered, (event) => event.reasoningOutputTokens ?? 0),
      cost: sum(ordered, (event) => event.costUsd ?? 0),
      events: ordered,
    };
  }).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

function timelineEvents(session: SessionRow): Array<{ label: string; time: string; detail?: string }> {
  const events = session.events;
  if (events.length === 1) return [{ label: "Observed", time: events[0].occurredAt, detail: fmtCompact(events[0].processedTokens) }];
  const peak = [...events].sort((a, b) => b.processedTokens - a.processedTokens)[0];
  return [
    { label: "Started", time: events[0].occurredAt },
    { label: "First usage", time: events[Math.min(1, events.length - 1)].occurredAt },
    { label: "Peak context", time: peak.occurredAt, detail: fmtCompact(peak.processedTokens) },
    { label: "Last observation", time: events.at(-1)!.occurredAt },
  ];
}

function sum(events: NormalizedUsageEvent[], select: (event: NormalizedUsageEvent) => number): number { return events.reduce((total, event) => total + select(event), 0); }
function durationMs(session: SessionRow): number { return Math.max(0, Date.parse(session.finishedAt) - Date.parse(session.startedAt)); }
function median(values: number[]): number { if (values.length === 0) return 0; const ordered = [...values].sort((a, b) => a - b); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2; }
function harnessLabel(value: string): string { return ({ codex: "Codex", pi: "Pi", opencode: "OpenCode", "claude-code": "Claude Code" } as Record<string, string>)[value] ?? value; }
function shortId(value: string): string { const parts = value.replace(/\\/g, "/").split("/").filter(Boolean); return parts.at(-1) ?? value; }
function fmtClock(iso: string): string { return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(iso)); }
function formatTimestamp(iso: string): string { return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)); }
function formatStarted(iso: string): string { const date = new Date(iso); const now = new Date(); const day = date.toDateString() === now.toDateString() ? "Today" : new Intl.DateTimeFormat("en", { month: "short", day: "2-digit" }).format(date); return `${day}, ${new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)}`; }
function formatDuration(ms: number): string { if (!Number.isFinite(ms) || ms <= 0) return "<1m"; const minutes = Math.max(1, Math.round(ms / 60_000)); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`; }

function Readout({ value, label }: { value: string; label: string }) {
  return <div className="readout"><div className="readout-value">{value}</div><div className="readout-label">{label}</div></div>;
}

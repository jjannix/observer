import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NormalizedUsageEvent } from "@shared/contracts";
import { api, rangeToFilters } from "../api.js";
import { FiltersBar, useFilterState } from "../components/Filters.js";
import { fmtCompact, fmtInt, fmtPct, fmtUsd } from "../components/ui.js";

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
  const [filters, setFilters] = useFilterState();
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
  const selected = sessions.find((session) => session.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && !sessions.some((session) => session.id === selectedId)) setSelectedId(null);
  }, [selectedId, sessions]);

  useEffect(() => {
    if (!selectedId) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedId(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedId]);

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
        <div className={`sessions-workspace${selected ? " has-inspector" : ""}`}>
          <div className="table-scroll">
            <table className="data instrument-table sessions-table">
              <thead><tr><th>Started</th><th>Session</th><th>Project</th><th>Processed</th><th>Cost</th><th>Duration</th></tr></thead>
              <tbody>
                {sessions.map((session) => (
                  <tr
                    key={session.id}
                    className={selected?.id === session.id ? "selected" : ""}
                    role="button"
                    aria-selected={selected?.id === session.id}
                    tabIndex={0}
                    onClick={() => setSelectedId(session.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedId(session.id);
                      }
                    }}
                  >
                    <td>{formatStarted(session.startedAt)}</td>
                    <td><span className="session-agent"><strong>{harnessLabel(session.harness)}</strong><small className="model-id">{session.model}</small></span></td>
                    <td><span className="project-id" title={session.project}>{projectLabel(session.project, dims?.projects)}</span></td>
                    <td className="tnum">{fmtCompact(session.processed)}</td>
                    <td className="tnum">{fmtUsd(session.cost)}</td>
                    <td className="tnum">{formatDuration(durationMs(session))}</td>
                  </tr>
                ))}
                {!isFetching && sessions.length === 0 && <tr><td colSpan={6} className="empty">No observations in this period.</td></tr>}
              </tbody>
            </table>
          </div>
          {selected && <SessionInspector session={selected} project={projectLabel(selected.project, dims?.projects)} onClose={() => setSelectedId(null)} />}
        </div>
      </section>
    </div>
  );
}

function SessionInspector({ session, project, onClose }: { session: SessionRow; project: string; onClose: () => void }) {
  const cacheHitRate = session.input > 0 ? session.cached / session.input : null;
  return (
    <aside className="session-inspector" aria-label={`Session ${formatStarted(session.startedAt)}`}>
      <div className="inspector-head">
        <div><span className="inspector-eyebrow">Session</span><h2>{formatStarted(session.startedAt)}</h2></div>
        <button type="button" className="inspector-close" onClick={onClose} aria-label="Close session inspector">×</button>
      </div>
      <div className="inspector-identity">
        <strong>{harnessLabel(session.harness)}</strong>
        <span className="model-id">{session.model}</span>
        <span className="project-id" title={session.project}>{project}</span>
      </div>
      <div className="inspector-primary"><strong>{fmtCompact(session.processed)}</strong><span>processed tokens</span></div>
      <div className="inspector-stats">
        <Readout value={fmtCompact(session.output)} label="output" />
        <Readout value={formatDuration(durationMs(session))} label="duration" />
        <Readout value={fmtUsd(session.cost)} label="estimated cost" />
      </div>
      <dl className="session-metadata">
        <div><dt>Provider</dt><dd>{session.provider}</dd></div>
        <div><dt>Cache hit</dt><dd>{fmtPct(cacheHitRate)}</dd></div>
        <div><dt>Uncached input</dt><dd>{fmtCompact(session.fresh)}</dd></div>
        <div><dt>Observed events</dt><dd>{fmtInt(session.events.length)}</dd></div>
        <div><dt>Started</dt><dd>{formatTimestamp(session.startedAt)}</dd></div>
        <div><dt>Project ID</dt><dd className="project-id" title={session.project}>{session.project}</dd></div>
      </dl>
      <div className="inspector-raw">
        <span>Session ID</span>
        <code title={session.id}>{session.id}</code>
      </div>
    </aside>
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

function sum(events: NormalizedUsageEvent[], select: (event: NormalizedUsageEvent) => number): number { return events.reduce((total, event) => total + select(event), 0); }
function durationMs(session: SessionRow): number { return Math.max(0, Date.parse(session.finishedAt) - Date.parse(session.startedAt)); }
function median(values: number[]): number { if (values.length === 0) return 0; const ordered = [...values].sort((a, b) => a - b); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2; }
function harnessLabel(value: string): string { return ({ codex: "Codex", pi: "Pi", opencode: "OpenCode", "claude-code": "Claude Code" } as Record<string, string>)[value] ?? value; }
function shortId(value: string): string { const parts = value.replace(/\\/g, "/").split("/").filter(Boolean); return parts.at(-1) ?? value; }
function projectLabel(projectId: string, projects: Array<{ id: string; path: string }> | undefined): string {
  const resolved = projects?.find((project) => project.id === projectId);
  return shortId(resolved?.path ?? projectId);
}
function formatTimestamp(iso: string): string { return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)); }
function formatStarted(iso: string): string { const date = new Date(iso); const now = new Date(); const day = date.toDateString() === now.toDateString() ? "Today" : new Intl.DateTimeFormat("en", { month: "short", day: "2-digit" }).format(date); return `${day}, ${new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)}`; }
function formatDuration(ms: number): string { if (!Number.isFinite(ms) || ms <= 0) return "<1m"; const minutes = Math.max(1, Math.round(ms / 60_000)); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`; }

function Readout({ value, label }: { value: string; label: string }) {
  return <div className="readout"><div className="readout-value">{value}</div><div className="readout-label">{label}</div></div>;
}

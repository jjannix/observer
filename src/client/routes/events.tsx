import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { api, rangeToFilters } from "../api.js";
import { FiltersBar, useFilterState } from "../components/Filters.js";
import { COLORS, fmtDate, fmtInt, fmtUsd } from "../components/ui.js";
import type { NormalizedUsageEvent } from "@shared/contracts";

const PAGE_SIZE = 100;

export function Events() {
  const [filters, setFilters] = useFilterState();
  const [cursor, setCursor] = useState<string | null>(null);
  const [stack, setStack] = useState<(string | null)[]>([null]);

  const range = useMemo(() => {
    const { from, to } = rangeToFilters(filters.range, "Europe/Berlin");
    return {
      from: filters.range === "custom" ? filters.from : from,
      to: filters.range === "custom" ? filters.to : to,
      harness: filters.harness, provider: filters.provider, model: filters.model, project: filters.project,
    };
  }, [filters]);

  const { data, isFetching } = useQuery({ queryKey: ["events", range, cursor], queryFn: () => api.events(range, cursor, PAGE_SIZE) });
  const { data: dims } = useQuery({ queryKey: ["dimensions"], queryFn: api.dimensions });

  const columns = useMemo<ColumnDef<NormalizedUsageEvent>[]>(() => [
    {
      id: "expand", header: () => null, cell: ({ row }) => (
        <button className="ghost sm" onClick={row.getToggleExpandedHandler()} aria-label="expand">
          {row.getIsExpanded() ? "−" : "+"}
        </button>
      ),
    },
    { accessorKey: "harness", header: "Harness", cell: (i) => <span className="tmono">{i.getValue() as string}</span> },
    { id: "occurredAt", header: "Occurred", cell: (i) => <span className="dim">{fmtDate(i.row.original.occurredAt)}</span> },
    {
      id: "provider", header: "Provider", cell: (i) => {
        const e = i.row.original;
        return e.canonicalProviderId ? <span className="tmono">{e.canonicalProviderId}</span> : <span className="dim">—</span>;
      },
    },
    {
      id: "model", header: "Model", cell: (i) => {
        const e = i.row.original;
        return e.canonicalModelId ? <span className="tmono">{e.canonicalModelId}</span> : <span className="dim">—</span>;
      },
    },
    { id: "comp", header: "Tokens", cell: (i) => <TokenBar e={i.row.original} /> },
    { id: "processed", header: "Processed", cell: (i) => <span className="tnum">{fmtInt(i.row.original.processedTokens)}</span> },
    { accessorKey: "costUsd", header: "Cost", cell: (i) => i.getValue() == null ? <span className="dim">—</span> : <span className="tnum">{fmtUsd(i.getValue() as number)}</span> },
    { id: "ids", header: "Session · Turn · Request", cell: (i) => <Ids e={i.row.original} /> },
    { id: "flags", header: "Flags", cell: (i) => <Flags e={i.row.original} /> },
  ], []);

  const table = useReactTable({
    data: data?.items ?? [], columns, state: {},
    getRowCanExpand: () => true,
    getCoreRowModel: getCoreRowModel(), getExpandedRowModel: getExpandedRowModel(),
  });

  const goNext = () => { if (data?.nextCursor) { setStack((s) => [...s, data.nextCursor]); setCursor(data.nextCursor); } };
  const goPrev = () => { setStack((s) => { if (s.length <= 1) return s; const n = s.slice(0, -1); setCursor(n[n.length - 1]); return n; }); };

  return (
    <div>
      <div className="page-head">
        <div className="titles">
          <h1>Events</h1>
          <p className="page-sub">Normalized usage events, server-paginated. Expand a row for the sanitized envelope.</p>
        </div>
      </div>

      <FiltersBar dims={dims} filters={filters} onChange={(f) => { setFilters(f); setCursor(null); setStack([null]); }} />

      <div className="section">
        <div className="row between" style={{ marginBottom: "var(--space-3)" }}>
          <span className="muted">{data ? `${fmtInt(data.total)} events` : "—"}</span>
          <div className="row">
            <button className="ghost sm" onClick={goPrev} disabled={stack.length <= 1 || isFetching}>Prev</button>
            <span className="dim" style={{ fontSize: 11 }}>page {stack.length}</span>
            <button className="ghost sm" onClick={goNext} disabled={!data?.nextCursor || isFetching}>Next</button>
          </div>
        </div>
        <div className="surface flush">
          <table className="data">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th key={h.id} style={{ width: h.column.id === "expand" ? 40 : undefined }}>
                      {h.isPlaceholder ? null : typeof h.column.columnDef.header === "function" ? (h.column.columnDef.header as any)() : (h.column.columnDef.header as string)}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <Fragment key={row.id}>
                  <tr>
                    {row.getVisibleCells().map((cell) => <td key={cell.id}>{(cell.column.columnDef.cell as any)?.(cell.getContext()) ?? null}</td>)}
                  </tr>
                  {row.getIsExpanded() && (
                    <tr><td colSpan={row.getVisibleCells().length} style={{ background: "var(--bg-0)" }}><ExpandedEnvelope e={row.original} /></td></tr>
                  )}
                </Fragment>
              ))}
              {(!data || data.items.length === 0) && !isFetching && (
                <tr><td colSpan={10} className="empty">No events in range.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TokenBar({ e }: { e: NormalizedUsageEvent }) {
  const total = e.processedInputTokens + e.outputTokens || 1;
  const seg = (v: number, color: string) =>
    v > 0 ? <span style={{ width: `${Math.max(2, (v / total) * 100)}%`, background: color }} /> : null;
  return (
    <div className="comp-bar" style={{ width: 140, height: 7 }}>
      {seg(e.freshInputTokens, COLORS.fresh)}
      {seg(e.cacheReadInputTokens, COLORS.cacheRead)}
      {seg(e.cacheWriteInputTokens, COLORS.cacheWrite)}
      {seg(e.outputTokens, COLORS.output)}
      {seg(e.unattributedTokens, COLORS.unattributed)}
    </div>
  );
}

function Ids({ e }: { e: NormalizedUsageEvent }) {
  return (
    <span className="tmono dim" style={{ fontSize: 10.5 }}>
      {e.sessionId?.slice(-10)}{e.turnId ? ` · ${e.turnId.slice(-6)}` : ""} · {e.requestId.slice(-8)}
    </span>
  );
}

function Flags({ e }: { e: NormalizedUsageEvent }) {
  if (e.qualityFlags.length === 0) return <span className="dim">—</span>;
  return <span className="flags">{e.qualityFlags.map((f) => <span key={f} className="flag">{f}</span>)}</span>;
}

function ExpandedEnvelope({ e }: { e: NormalizedUsageEvent }) {
  return (
    <div style={{ padding: "var(--space-3) var(--space-5)" }}>
      <div className="kvs" style={{ marginBottom: "var(--space-3)" }}>
        <dt>Provider resolution</dt><dd>{e.providerResolution}</dd>
        <dt>Cache write available</dt><dd>{String(e.cacheWriteAvailable)}</dd>
        <dt>Reasoning tokens</dt><dd>{e.reasoningOutputTokens == null ? "—" : fmtInt(e.reasoningOutputTokens)}</dd>
        <dt>Fresh / cache-read / cache-write</dt>
        <dd>{fmtInt(e.freshInputTokens)} / {fmtInt(e.cacheReadInputTokens)} / {fmtInt(e.cacheWriteInputTokens)}</dd>
      </div>
      <details>
        <summary className="muted" style={{ cursor: "pointer" }}>Sanitized envelope JSON</summary>
        <pre className="tmono" style={{ fontSize: 11, color: "var(--fg-1)", padding: "var(--space-3)", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "var(--space-2) 0 0" }}>{JSON.stringify(e, null, 2)}</pre>
      </details>
    </div>
  );
}

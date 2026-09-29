import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  SESSION_SORTS,
  type NormalizedUsageEvent,
  type SessionDetail,
  type SessionSort,
  type RequestSort,
  type SessionUsage,
  type SortDirection,
} from "@shared/contracts";
import { api, rangeToFilters, type RangeFilters } from "../api.js";
import { FiltersBar, useFilterState } from "../components/Filters.js";
import {
  COLORS,
  CompositionBar,
  fmtCompact,
  fmtInt,
  fmtPct as formatPercent,
  fmtUsd as formatUsd,
} from "../components/ui.js";
import { harnessLabel } from "../components/colors.js";

export function Sessions() {
  const [filters, setFilters] = useFilterState();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("session");
  const search = params.get("q") ?? "";
  const [searchInput, setSearchInput] = useState(search);
  const sort = SESSION_SORTS.includes(params.get("sort") as SessionSort)
    ? (params.get("sort") as SessionSort)
    : "recent";
  const direction: SortDirection =
    params.get("direction") === "asc"
      ? "asc"
      : params.get("direction") === "desc"
        ? "desc"
        : sort === "project" || sort === "harness"
          ? "asc"
          : "desc";
  const requestedPage = Number(params.get("page") ?? 1);
  const page =
    Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const lastSelected = useRef<string | null>(selectedId);
  const searchRef = useRef<HTMLInputElement>(null);
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
  const { data: dims } = useQuery({
    queryKey: ["dimensions"],
    queryFn: api.dimensions,
  });
  const list = useQuery({
    queryKey: ["sessions", range, search, sort, direction, page],
    queryFn: () => api.sessions(range, search, sort, page, direction),
    enabled: !selectedId,
    // Preserve the table for sorting/paging, but never retain a different search or scope.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === search &&
      JSON.stringify(previousQuery.queryKey[1]) === JSON.stringify(range)
        ? previous
        : undefined,
    refetchInterval: 30_000,
  });

  const updateParams = (
    patch: Record<string, string | null>,
    replace = false,
  ) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace },
    );
  };
  const changeSort = (next: SessionSort, toggle = true) => {
    updateParams({
      sort: next,
      direction:
        toggle && sort === next
          ? reverseDirection(direction)
          : next === "project" || next === "harness"
            ? "asc"
            : "desc",
      page: null,
    });
  };
  useEffect(() => {
    setSearchInput(search);
  }, [search]);
  useEffect(() => {
    if (searchInput === search) return;
    const timer = window.setTimeout(() => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (searchInput) next.set("q", searchInput);
          else next.delete("q");
          next.delete("page");
          return next;
        },
        { replace: true },
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput, search, setParams]);
  useEffect(() => {
    if (selectedId) {
      lastSelected.current = selectedId;
      return;
    }
    if (!lastSelected.current || !list.data) return;
    const links =
      document.querySelectorAll<HTMLAnchorElement>("[data-session-id]");
    const link = [...links].find(
      (item) => item.dataset.sessionId === lastSelected.current,
    );
    (link ?? searchRef.current)?.focus();
    lastSelected.current = null;
  }, [selectedId, list.data]);
  const close = () => updateParams({ session: null });
  useEffect(() => {
    if (!selectedId) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector(".filter-panel")
      ) {
        setParams((previous) => {
          const next = new URLSearchParams(previous);
          next.delete("session");
          return next;
        });
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [selectedId, setParams]);

  return (
    <div className="sessions-page session-explorer">
      <div className="page-head">
        <div className="titles">
          <h1>Sessions</h1>
          <p className="page-sub">
            Find a session. Understand where its usage went.
          </p>
        </div>
        <FiltersBar
          dims={dims}
          filters={filters}
          onChange={(next) => {
            setFilters(next);
            updateParams({ page: null }, true);
          }}
        />
      </div>
      {selectedId ? (
        <SessionView
          key={selectedId}
          id={selectedId}
          range={range}
          onClose={close}
        />
      ) : (
        <>
          <div className="session-toolbar">
            <label className="session-search">
              <span>Search sessions</span>
              <input
                ref={searchRef}
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search project, model, or session ID"
              />
            </label>
            <label className="session-sort">
              <span>Sort by</span>
              <select
                aria-label="Sort sessions"
                value={sort}
                onChange={(event) =>
                  changeSort(event.target.value as SessionSort, false)
                }
              >
                <option value="recent">Last activity</option>
                <option value="tokens">Processed tokens</option>
                <option value="cost">Reported cost</option>
                <option value="requests">Requests</option>
                <option value="project">Project name</option>
                <option value="harness">Harness</option>
                <option value="cache">Cache hit</option>
              </select>
            </label>
          </div>
          <section
            className="sessions-results"
            aria-labelledby="sessions-list-heading"
          >
            <div className="section-head">
              <div>
                <h2 id="sessions-list-heading">Observed sessions</h2>
                <p className="session-hint">
                  Usage within the selected period and filters.
                </p>
              </div>
              <div className="session-result-status">
                <UpdatingStatus active={list.isFetching && !list.isPending} />
                <span className="session-hint" role="status">
                  {list.data
                    ? `${fmtInt(list.data.total)} ${list.data.total === 1 ? "session" : "sessions"}`
                    : list.isError
                      ? "Unable to load"
                      : "Loading sessions…"}
                </span>
              </div>
            </div>
            {list.isError ? (
              <QueryError
                onRetry={() => void list.refetch()}
                message="Sessions couldn’t be loaded. Try again or check that Observer is running."
              />
            ) : list.isPending ? (
              <LoadingRows />
            ) : list.data.items.length === 0 ? (
              <div className="session-empty">
                <h3>No matching sessions</h3>
                <p>
                  Try a broader period, remove a filter, or search for a
                  different project or session ID.
                </p>
                <button
                  className="ghost"
                  onClick={() => {
                    setSearchInput("");
                    updateParams({ q: null, page: null }, true);
                    setFilters({ range: "all" });
                  }}
                >
                  Show all sessions
                </button>
              </div>
            ) : (
              <>
                <div className="table-scroll" aria-busy={list.isFetching}>
                  <table className="data session-browser-table">
                    <colgroup>
                      {Array.from({ length: 7 }, (_, index) => (
                        <col key={index} />
                      ))}
                    </colgroup>
                    <thead>
                      <tr>
                        {(
                          [
                            ["project", "Session / project"],
                            ["harness", "Harness / models"],
                            ["recent", "Last activity"],
                            ["tokens", "Processed"],
                            ["cost", "Reported cost"],
                            ["cache", "Cache hit"],
                            ["requests", "Requests"],
                          ] as const
                        ).map(([column, label]) => (
                          <SortableHeader
                            key={column}
                            column={column}
                            label={label}
                            active={sort}
                            direction={direction}
                            onSort={changeSort}
                            numeric={
                              !["project", "harness", "recent"].includes(column)
                            }
                          />
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {list.data.items.map((session) => {
                        const next = new URLSearchParams(params);
                        next.set("session", session.sessionId);
                        const project = projectName(session.projectPath);
                        return (
                          <tr key={session.sessionId}>
                            <td>
                              <Link
                                className="session-open"
                                to={`?${next}`}
                                data-session-id={session.sessionId}
                                aria-label={`Inspect ${project}, ${harnessLabel(session.harness)}, ${formatTimestamp(session.lastActivity)}, ${shortSessionId(session.sessionId)}`}
                              >
                                <strong
                                  title={
                                    session.projectPath ?? "Unassigned project"
                                  }
                                >
                                  {project}
                                </strong>
                                <span
                                  className="session-id-small"
                                  title={session.sessionId}
                                >
                                  {shortSessionId(session.sessionId)}
                                </span>
                                <span className="session-mobile-meta">
                                  <span>
                                    {harnessLabel(session.harness)} ·{" "}
                                    {session.models.length === 1
                                      ? modelName(session.models[0])
                                      : `${session.models.length} models`}
                                  </span>
                                  <time dateTime={session.lastActivity}>
                                    {formatTimestamp(session.lastActivity)}
                                  </time>
                                </span>
                              </Link>
                            </td>
                            <td>
                              <span className="session-agent">
                                <strong>{harnessLabel(session.harness)}</strong>
                                <small title={session.models.join(", ")}>
                                  {session.models.length === 1
                                    ? modelName(session.models[0])
                                    : `${session.models.length} models`}
                                </small>
                              </span>
                            </td>
                            <td
                              className={
                                sort === "recent" ? "session-sorted" : undefined
                              }
                            >
                              <SessionDate iso={session.lastActivity} />
                            </td>
                            <td
                              className={`tnum session-processed${sort === "tokens" ? " session-sorted" : ""}`}
                              title={fmtInt(session.processedTokens)}
                            >
                              {fmtCompact(session.processedTokens)}
                            </td>
                            <td
                              className={`tnum${sort === "cost" ? " session-sorted" : ""}`}
                            >
                              <CostValue usage={session} />
                            </td>
                            <td className="tnum">
                              {fmtPct(session.cacheHitRate)}
                            </td>
                            <td
                              className={`tnum${sort === "requests" ? " session-sorted" : ""}`}
                            >
                              {fmtInt(session.requests)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="session-pagination">
                  <span role="status">
                    {fmtInt((list.data.page - 1) * list.data.pageSize + 1)}-
                    {fmtInt(
                      Math.min(
                        list.data.page * list.data.pageSize,
                        list.data.total,
                      ),
                    )}{" "}
                    of {fmtInt(list.data.total)} sessions
                  </span>
                  <div className="row">
                    <button
                      className="ghost"
                      disabled={list.isPlaceholderData || list.data.page <= 1}
                      onClick={() =>
                        updateParams({ page: String(list.data.page - 1) })
                      }
                    >
                      Previous
                    </button>
                    <span>Page {list.data.page}</span>
                    <button
                      className="ghost"
                      disabled={
                        list.isPlaceholderData ||
                        list.data.page * list.data.pageSize >= list.data.total
                      }
                      onClick={() =>
                        updateParams({ page: String(list.data.page + 1) })
                      }
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SessionView({
  id,
  range,
  onClose,
}: {
  id: string;
  range: RangeFilters;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"full" | "filtered">("full");
  const heading = useRef<HTMLHeadingElement>(null);
  const scopeFilters = scope === "full" ? {} : range;
  const detail = useQuery({
    queryKey: ["session-detail", id, scopeFilters],
    queryFn: () => api.session(id, scopeFilters),
    refetchInterval: 30_000,
  });
  useEffect(() => {
    heading.current?.focus();
    window.scrollTo({ top: 0 });
  }, [id]);
  return (
    <section
      className="session-detail"
      aria-labelledby="session-detail-heading"
    >
      <div className="session-detail-navigation">
        <button className="ghost" onClick={onClose}>
          ← All sessions
        </button>
        <div
          className="session-scope"
          role="group"
          aria-label="Session usage scope"
        >
          <button
            aria-pressed={scope === "full"}
            onClick={() => setScope("full")}
          >
            Full session
          </button>
          <button
            aria-pressed={scope === "filtered"}
            onClick={() => setScope("filtered")}
          >
            Selected period & filters
          </button>
        </div>
      </div>
      <div className="session-detail-title">
        <div>
          <h2 id="session-detail-heading" tabIndex={-1} ref={heading}>
            {detail.data
              ? projectName(detail.data.session.projectPath)
              : "Session details"}
          </h2>
          <p>
            {scope === "full"
              ? "Complete collected usage for this session, across all periods and models."
              : "Only usage matching the period and filters above."}
          </p>
        </div>
        <CopyId id={id} />
      </div>
      {detail.isError ? (
        <QueryError
          message={
            detail.error.message.startsWith("404")
              ? scope === "filtered"
                ? "This session has no requests matching these filters. Switch to Full session to see its history."
                : "This session is no longer in Observer’s index. Return to the session list or sync your sources."
              : "Session details couldn’t be loaded. Try again or check that Observer is running."
          }
          onRetry={() => void detail.refetch()}
        />
      ) : detail.isPending ? (
        <LoadingRows />
      ) : (
        <SessionContent
          key={JSON.stringify(scopeFilters)}
          detail={detail.data}
          filters={scopeFilters}
        />
      )}
    </section>
  );
}

function SessionContent({
  detail,
  filters,
}: {
  detail: SessionDetail;
  filters: RangeFilters;
}) {
  const session = detail.session;
  const [modelSort, setModelSort] = useState<
    "model" | "tokens" | "share" | "cost"
  >("tokens");
  const [modelDirection, setModelDirection] = useState<SortDirection>("desc");
  const models = useMemo(
    () =>
      [...detail.models].sort((a, b) => {
        const tie =
          modelName(a.model).localeCompare(modelName(b.model)) ||
          a.provider.localeCompare(b.provider);
        if (modelSort === "model")
          return (modelDirection === "asc" ? 1 : -1) * tie;
        const left = modelSort === "cost" ? a.costUsd : a.processedTokens;
        const right = modelSort === "cost" ? b.costUsd : b.processedTokens;
        if (left == null || right == null)
          return left == null && right == null ? tie : left == null ? 1 : -1;
        return (modelDirection === "asc" ? 1 : -1) * (left - right) || tie;
      }),
    [detail.models, modelSort, modelDirection],
  );
  const changeModelSort = (next: typeof modelSort) => {
    setModelDirection(
      next === modelSort
        ? reverseDirection(modelDirection)
        : next === "model"
          ? "asc"
          : "desc",
    );
    setModelSort(next);
  };
  const [selectedRequest, setSelectedRequest] =
    useState<NormalizedUsageEvent | null>(null);
  const requestDetail = useRef<HTMLDivElement>(null);
  const requestTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (selectedRequest) requestDetail.current?.focus();
    else requestTrigger.current?.focus();
  }, [selectedRequest]);
  const inspectRequest = (request: NormalizedUsageEvent) => {
    requestTrigger.current = document.activeElement as HTMLElement;
    setSelectedRequest(request);
  };
  const segments = [
    {
      label: "Fresh input",
      value: session.freshInputTokens,
      color: COLORS.fresh,
    },
    {
      label: "Cache read",
      value: session.cacheReadInputTokens,
      color: COLORS.cacheRead,
    },
    {
      label: "Cache write",
      value: session.cacheWriteInputTokens,
      color: COLORS.cacheWrite,
    },
    { label: "Output", value: session.outputTokens, color: COLORS.output },
    {
      label: "Unattributed",
      value: session.unattributedTokens,
      color: COLORS.unattributed,
    },
  ];
  return (
    <>
      <div className="session-context">
        <span>{harnessLabel(session.harness)}</span>
        <span>
          {session.models.length}{" "}
          {session.models.length === 1 ? "model" : "models"}
        </span>
        <span title={session.projectPath ?? undefined}>
          {session.projectPath ?? "Unassigned project"}
        </span>
      </div>
      <div className="session-usage-strip">
        <Readout
          label="Processed tokens"
          value={fmtCompact(session.processedTokens)}
          exact={fmtInt(session.processedTokens)}
        />
        <Readout
          label="Output tokens"
          value={fmtCompact(session.outputTokens)}
          exact={fmtInt(session.outputTokens)}
        />
        <Readout label="Reported cost" value={<CostValue usage={session} />} />
        <Readout label="Cache hit" value={fmtPct(session.cacheHitRate)} />
        <Readout label="Requests" value={fmtInt(session.requests)} />
      </div>
      <div className="session-observation">
        <span>
          First activity{" "}
          <strong>{formatTimestamp(session.firstActivity)}</strong>
        </span>
        <span>
          Last activity <strong>{formatTimestamp(session.lastActivity)}</strong>
        </span>
        <span title="First to last observed request. Includes idle gaps; this is not active working time.">
          Observed span{" "}
          <strong>
            {session.requests > 1
              ? formatSpan(session.firstActivity, session.lastActivity)
              : "Single request"}
          </strong>
        </span>
      </div>
      <p className="session-hint">
        {session.attributedRequests > 0
          ? `${fmtInt(session.turns)} attributed human turns · ${fmtInt(session.attributedRequests)} of ${fmtInt(session.requests)} requests have turn attribution.`
          : "Human-turn attribution is unavailable for these requests."}{" "}
        {session.costAvailable === 0
          ? "The source did not report costs."
          : `${fmtInt(session.costAvailable)} of ${fmtInt(session.requests)} requests report cost (${fmtPct(session.costCoverage)} token coverage).`}{" "}
        {detail.hasSubscription &&
          "Some requests use a provider marked as subscription-covered; its reported cost is a list-price equivalent."}
      </p>
      <div className="session-detail-columns">
        <section className="session-detail-section">
          <h3>Token composition</h3>
          <CompositionBar total={session.processedTokens} segments={segments} />
          <p className="session-hint">
            {session.reasoningAvailable > 0
              ? `${fmtCompact(session.reasoningOutputTokens)} reasoning tokens are already included in output. Reasoning reported on ${fmtInt(session.reasoningAvailable)} of ${fmtInt(session.requests)} requests.`
              : "Output includes reasoning; its separate token count is unavailable."}{" "}
            {session.cacheWriteAvailable < session.requests &&
              `Cache-write accounting is available on ${fmtInt(session.cacheWriteAvailable)} of ${fmtInt(session.requests)} requests.`}
          </p>
        </section>
        <section className="session-detail-section">
          <h3>Models used</h3>
          <div className="table-scroll">
            <table className="data session-model-table">
              <colgroup>
                {Array.from({ length: 4 }, (_, index) => (
                  <col key={index} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {(
                    [
                      ["model", "Model / provider"],
                      ["tokens", "Processed"],
                      ["share", "Share"],
                      ["cost", "Cost"],
                    ] as const
                  ).map(([column, label]) => (
                    <SortableHeader
                      key={column}
                      column={column}
                      label={label}
                      active={modelSort}
                      direction={modelDirection}
                      onSort={changeModelSort}
                      numeric={column !== "model"}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={`${model.model}:${model.provider}`}>
                    <td>
                      <strong>{modelName(model.model)}</strong>
                      <small>
                        {model.provider}
                        {model.billingMode === "subscription"
                          ? " · subscription"
                          : ""}{" "}
                        · {fmtInt(model.requests)} requests
                      </small>
                    </td>
                    <td className="tnum" title={fmtInt(model.processedTokens)}>
                      {fmtCompact(model.processedTokens)}
                    </td>
                    <td className="tnum">
                      {fmtPct(
                        session.processedTokens > 0
                          ? model.processedTokens / session.processedTokens
                          : null,
                      )}
                    </td>
                    <td className="tnum">
                      <CostValue usage={model} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <div className="session-activity-columns">
        <section className="session-detail-section">
          <div className="section-head">
            <div>
              <h3>Usage over this session</h3>
              <p className="session-hint">
                Processed tokens grouped into time intervals. Idle gaps remain
                visible.
              </p>
            </div>
          </div>
          <SessionTimeline
            timeline={detail.timeline}
            bucketSeconds={detail.timelineBucketSeconds}
            start={session.firstActivity}
            end={session.lastActivity}
          />
        </section>
        <section className="session-detail-section">
          <div className="section-head">
            <div>
              <h3>Largest requests</h3>
              <p className="session-hint">
                Inspect a request to see its exact accounting and model.
              </p>
            </div>
          </div>
          <div className="session-largest">
            {detail.largestRequests.map((request, index) => (
              <button
                key={request.id}
                className="session-large-request"
                onClick={() => inspectRequest(request)}
                aria-pressed={selectedRequest?.id === request.id}
              >
                <span className="session-request-rank">{index + 1}</span>
                <span>
                  <strong>{fmtCompact(request.processedTokens)} tokens</strong>
                  <small>
                    {formatTimestamp(request.occurredAt)} ·{" "}
                    {modelName(
                      request.canonicalModelId ??
                        request.rawModelId ??
                        "Unknown",
                    )}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
      {selectedRequest && (
        <div
          ref={requestDetail}
          className="session-request-detail"
          tabIndex={-1}
          role="region"
          aria-label="Selected request accounting"
        >
          <div className="section-head">
            <h3>Request accounting</h3>
            <button className="ghost" onClick={() => setSelectedRequest(null)}>
              Close request
            </button>
          </div>
          <p>
            {formatTimestamp(selectedRequest.occurredAt)} ·{" "}
            {selectedRequest.canonicalModelId ??
              selectedRequest.rawModelId ??
              "Unknown model"}{" "}
            ·{" "}
            {selectedRequest.canonicalProviderId ??
              selectedRequest.rawProviderId ??
              "Unknown provider"}
          </p>
          <dl className="session-request-metrics">
            {[
              ["Processed", fmtInt(selectedRequest.processedTokens)],
              ["Fresh input", fmtInt(selectedRequest.freshInputTokens)],
              ["Cache read", fmtInt(selectedRequest.cacheReadInputTokens)],
              [
                "Cache write",
                selectedRequest.cacheWriteAvailable
                  ? fmtInt(selectedRequest.cacheWriteInputTokens)
                  : "Unavailable",
              ],
              [
                "Output (includes reasoning)",
                fmtInt(selectedRequest.outputTokens),
              ],
              [
                "Reasoning subset",
                selectedRequest.reasoningOutputTokens == null
                  ? "Unavailable"
                  : fmtInt(selectedRequest.reasoningOutputTokens),
              ],
              ["Unattributed", fmtInt(selectedRequest.unattributedTokens)],
              ["Reported cost", fmtUsd(selectedRequest.costUsd)],
              ["Turn ID", selectedRequest.turnId ?? "Unavailable"],
              ["Request ID", selectedRequest.requestId],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {selectedRequest.qualityFlags.length > 0 && (
            <p className="session-hint">
              Accounting flags:{" "}
              {selectedRequest.qualityFlags.map(flagLabel).join(" · ")}
            </p>
          )}
        </div>
      )}
      <RequestList
        sessionId={session.sessionId}
        filters={filters}
        onInspect={inspectRequest}
        selectedId={selectedRequest?.id ?? null}
      />
      {detail.qualityFlags.length > 0 && (
        <details className="session-accounting-notes">
          <summary>Accounting notes ({detail.qualityFlags.length})</summary>
          <ul>
            {detail.qualityFlags.map((flag) => (
              <li key={flag}>{flagLabel(flag)}</li>
            ))}
          </ul>
          <p>
            These source limitations can affect the completeness of reported
            usage.
          </p>
        </details>
      )}
    </>
  );
}

function RequestList({
  sessionId,
  filters,
  onInspect,
  selectedId,
}: {
  sessionId: string;
  filters: RangeFilters;
  onInspect: (request: NormalizedUsageEvent) => void;
  selectedId: string | null;
}) {
  const [sort, setSort] = useState<RequestSort>("oldest");
  const [direction, setDirection] = useState<SortDirection>("asc");
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors.at(-1) ?? null;
  const query = useQuery({
    queryKey: ["session-requests", sessionId, filters, cursor, sort, direction],
    queryFn: async () => ({
      ...(await api.sessionRequests(
        sessionId,
        filters,
        cursor,
        sort,
        direction,
      )),
      page: cursors.length,
    }),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === sessionId &&
      JSON.stringify(previousQuery.queryKey[2]) === JSON.stringify(filters)
        ? previous
        : undefined,
    refetchInterval: 30_000,
  });
  const changeRequestSort = (next: RequestSort, toggle = true) => {
    const currentColumn = sort === "recent" ? "oldest" : sort;
    const nextDirection =
      toggle && currentColumn === next
        ? reverseDirection(direction)
        : next === "oldest" || next === "model"
          ? "asc"
          : "desc";
    setDirection(nextDirection);
    setSort(next === "oldest" && nextDirection === "desc" ? "recent" : next);
    setCursors([null]);
  };
  return (
    <section className="session-detail-section">
      <div className="section-head">
        <div>
          <h3>All requests</h3>
          <p className="session-hint">
            Each row is one recorded model request. Inspect its time to see
            exact accounting.
          </p>
        </div>
        <div className="session-request-order">
          <UpdatingStatus active={query.isFetching && !query.isPending} />
          <label className="session-sort">
            Request order{" "}
            <select
              aria-label="Request order"
              value={sort}
              onChange={(event) => {
                changeRequestSort(event.target.value as RequestSort, false);
              }}
            >
              <option value="oldest">Oldest first</option>
              <option value="recent">Latest first</option>
              <option value="largest">Processed tokens</option>
              <option value="model">Model name</option>
              <option value="fresh">Fresh input</option>
              <option value="cache">Cache read</option>
              <option value="output">Output</option>
              <option value="cost">Reported cost</option>
            </select>
          </label>
        </div>
      </div>
      {query.isError ? (
        <QueryError
          message="Requests couldn’t be loaded. Try again."
          onRetry={() => void query.refetch()}
        />
      ) : query.isPending ? (
        <LoadingRows />
      ) : (
        <>
          <div className="table-scroll" aria-busy={query.isFetching}>
            <table className="data session-requests-table">
              <colgroup>
                {Array.from({ length: 7 }, (_, index) => (
                  <col key={index} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {(
                    [
                      ["oldest", "Time"],
                      ["model", "Model"],
                      ["largest", "Processed"],
                      ["fresh", "Fresh input"],
                      ["cache", "Cache read"],
                      ["output", "Output"],
                      ["cost", "Cost"],
                    ] as const
                  ).map(([column, label]) => (
                    <SortableHeader
                      key={column}
                      column={column}
                      label={label}
                      active={sort === "recent" ? "oldest" : sort}
                      direction={direction}
                      onSort={changeRequestSort}
                      numeric={!["oldest", "model"].includes(column)}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((request) => (
                  <tr
                    key={request.id}
                    className={selectedId === request.id ? "is-selected" : ""}
                  >
                    <td>
                      <button
                        className="session-request-link"
                        onClick={() => onInspect(request)}
                        aria-label={`Inspect request at ${formatTimestamp(request.occurredAt)}, ${request.requestId}`}
                      >
                        {formatTimestamp(request.occurredAt)}
                      </button>
                    </td>
                    <td
                      title={
                        request.canonicalModelId ??
                        request.rawModelId ??
                        undefined
                      }
                    >
                      {modelName(
                        request.canonicalModelId ??
                          request.rawModelId ??
                          "Unknown",
                      )}
                    </td>
                    <td
                      className="tnum"
                      title={fmtInt(request.processedTokens)}
                    >
                      {fmtCompact(request.processedTokens)}
                    </td>
                    <td className="tnum">
                      {fmtCompact(request.freshInputTokens)}
                    </td>
                    <td className="tnum">
                      {fmtCompact(request.cacheReadInputTokens)}
                    </td>
                    <td className="tnum">{fmtCompact(request.outputTokens)}</td>
                    <td className="tnum">{fmtUsd(request.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="session-pagination">
            <span>
              {fmtInt(
                (query.data.page - 1) * 50 + (query.data.items.length ? 1 : 0),
              )}
              -{fmtInt((query.data.page - 1) * 50 + query.data.items.length)} of{" "}
              {fmtInt(query.data.total)} requests
            </span>
            <div className="row">
              <button
                className="ghost"
                disabled={query.isPlaceholderData || cursors.length <= 1}
                onClick={() => setCursors((previous) => previous.slice(0, -1))}
              >
                Previous requests
              </button>
              <button
                className="ghost"
                disabled={query.isPlaceholderData || !query.data.nextCursor}
                onClick={() =>
                  setCursors((previous) => [...previous, query.data.nextCursor])
                }
              >
                Next requests
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function SessionTimeline({
  timeline,
  bucketSeconds,
  start,
  end,
}: {
  timeline: SessionDetail["timeline"];
  bucketSeconds: number;
  start: string;
  end: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const width = 1000,
    height = 140,
    plotHeight = 108;
  const count = Math.max(1, ...timeline.map((point) => point.bucket + 1));
  const maximum = Math.max(
    1,
    ...timeline.map((point) => point.processedTokens),
  );
  const hovered = active == null ? null : timeline[active];
  return (
    <div className="session-timeline">
      <div className="session-timeline-readout" role="status">
        {hovered
          ? `${formatTimestamp(hovered.occurredAt)} · ${fmtInt(hovered.processedTokens)} tokens · ${fmtInt(hovered.requests)} requests`
          : `Peak interval: ${fmtCompact(maximum)} processed tokens`}
      </div>
      <p className="session-hint">
        Each interval covers{" "}
        {bucketSeconds < 60
          ? `${bucketSeconds}s`
          : bucketSeconds < 3600
            ? `${Math.round(bucketSeconds / 60)}m`
            : bucketSeconds < 86400
              ? `${(bucketSeconds / 3600).toFixed(1)}h`
              : `${(bucketSeconds / 86400).toFixed(1)}d`}
        .
      </p>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="group"
        aria-label="Session usage over time"
      >
        <line
          x1="0"
          y1={plotHeight + 4}
          x2={width}
          y2={plotHeight + 4}
          stroke="var(--border-strong)"
        />
        {timeline.map((point, index) => {
          const bucket = point.bucket;
          const barWidth = Math.max(2, width / count - 4);
          const barHeight = Math.max(
            2,
            (point.processedTokens / maximum) * plotHeight,
          );
          const label = `${formatTimestamp(point.occurredAt)}, ${fmtInt(point.processedTokens)} tokens, ${point.requests} requests`;
          return (
            <rect
              key={point.occurredAt}
              tabIndex={0}
              role="img"
              aria-label={label}
              x={(bucket * width) / count + 2}
              y={plotHeight + 4 - barHeight}
              width={barWidth}
              height={barHeight}
              rx="2"
              fill={active === index ? "var(--accent)" : "var(--fg-1)"}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
            >
              <title>{label}</title>
            </rect>
          );
        })}
      </svg>
      <div className="session-timeline-axis">
        <span>{formatTimestamp(start)}</span>
        <span>{formatTimestamp(end)}</span>
      </div>
    </div>
  );
}

function CopyId({ id }: { id: string }) {
  const [status, setStatus] = useState("");
  return (
    <div className="session-copy-id">
      <code title={id}>{id}</code>
      <button
        className="ghost"
        aria-label="Copy ID"
        onClick={() => {
          if (!navigator.clipboard) {
            setStatus("Select the ID to copy it");
            return;
          }
          void navigator.clipboard
            .writeText(id)
            .then(() => setStatus("Copied"))
            .catch(() => setStatus("Select the ID to copy it"));
        }}
      >
        {status === "Copied" ? "Copied" : "Copy ID"}
      </button>
      <span
        className={
          status === "Copied" || !status ? "sr-only" : "session-copy-status"
        }
        role="status"
      >
        {status}
      </span>
    </div>
  );
}
function CostValue({ usage }: { usage: SessionUsage }) {
  const partial =
    usage.costAvailable > 0 && usage.costAvailable < usage.requests;
  return (
    <span
      className={
        usage.costAvailable === 0 ? "session-cost-unavailable" : undefined
      }
      title={
        usage.costAvailable === 0
          ? "Cost unavailable: the source did not report it."
          : `${usage.costAvailable} of ${usage.requests} requests report cost; ${fmtPct(usage.costCoverage)} token coverage.`
      }
    >
      {fmtUsd(usage.costUsd)}
      {partial && <small className="session-cost-partial">partial</small>}
    </span>
  );
}
function Readout({
  label,
  value,
  exact,
}: {
  label: string;
  value: ReactNode;
  exact?: string;
}) {
  return (
    <div className="session-readout">
      <span>{label}</span>
      <strong title={exact}>{value}</strong>
    </div>
  );
}
function reverseDirection(direction: SortDirection): SortDirection {
  return direction === "asc" ? "desc" : "asc";
}
function SortableHeader<T extends string>({
  label,
  column,
  active,
  direction,
  onSort,
  numeric = false,
}: {
  label: string;
  column: T;
  active: T;
  direction: SortDirection;
  onSort: (column: T) => void;
  numeric?: boolean;
}) {
  const selected = column === active;
  return (
    <th
      scope="col"
      className={numeric ? "tnum" : undefined}
      aria-sort={
        selected
          ? direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      <button
        className="session-column-sort"
        aria-label={`Sort by ${label}`}
        onClick={() => onSort(column)}
      >
        <span>{label}</span>
        <span className="session-sort-direction" aria-hidden="true">
          {selected ? (direction === "asc" ? "↑" : "↓") : null}
        </span>
      </button>
    </th>
  );
}
function UpdatingStatus({ active }: { active: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), 180);
    return () => window.clearTimeout(timer);
  }, [active]);
  const show = active && visible;
  return (
    <span className="session-update-status" data-active={show} role="status">
      {show ? "Updating…" : ""}
    </span>
  );
}
function QueryError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="session-error" role="alert">
      <p>{message}</p>
      <button className="ghost" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
function LoadingRows() {
  return (
    <div className="session-loading" role="status" aria-label="Loading usage">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
function projectName(path: string | null): string {
  return (
    path?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "Unassigned"
  );
}
function modelName(id: string): string {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
}
function shortSessionId(id: string): string {
  const uuid = id.match(
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i,
  );
  return uuid
    ? `${uuid[0].slice(0, 8)}…${uuid[0].slice(-6)}`
    : id.split(":").slice(1).join(":").slice(-16) || id;
}
function SessionDate({ iso }: { iso: string }) {
  const date = new Date(iso);
  return (
    <time className="session-date" dateTime={iso}>
      <span>
        {new Intl.DateTimeFormat("en", {
          month: "short",
          day: "2-digit",
          year: "numeric",
        }).format(date)}
      </span>
      <small>
        {new Intl.DateTimeFormat("en", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(date)}
      </small>
    </time>
  );
}
function fmtPct(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "n/a"
    : formatPercent(value);
}
function fmtUsd(value: number | null | undefined): string {
  return value == null ? "Not reported" : formatUsd(value);
}
function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
function formatSpan(start: string, end: string): string {
  const ms = Math.max(0, Date.parse(end) - Date.parse(start));
  if (ms < 60_000) return "<1m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 1440)
    return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}
function flagLabel(flag: string): string {
  return flag.replace(/-/g, " ");
}

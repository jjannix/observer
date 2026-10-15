import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { type ActivityDay, type ActivityResponse } from "@shared/contracts";
import { api, type RangeFilters } from "../api.js";
import { colorForHarness, harnessLabel } from "./colors.js";
import { fmtCompact, fmtInt } from "./ui.js";

type Intensity = "tokens" | "sessions";

const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

/**
 * Contribution graph of daily usage over the selected period; picking a day
 * scopes the session list to it.
 */
export function ActivityGraph({
  filters,
  selectedDay,
  onSelectDay,
}: {
  filters: RangeFilters;
  selectedDay: string | null;
  onSelectDay: (day: string | null) => void;
}) {
  const [params, setParams] = useSearchParams();
  const intensity: Intensity = params.get("activityBy") === "sessions" ? "sessions" : "tokens";
  const activity = useQuery({
    queryKey: ["activity", filters],
    queryFn: () => api.activity(filters),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const setIntensity = (value: Intensity) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value === "sessions") next.set("activityBy", value);
        else next.delete("activityBy");
        return next;
      },
      { replace: true },
    );
  const data = activity.data;

  return (
    <section className="session-activity activity-section" aria-labelledby="activity-heading" aria-busy={activity.isFetching}>
      <div className="section-head">
        <div>
          <h2 id="activity-heading">Coding activity</h2>
          <span className="hint">
            Daily {intensity === "tokens" ? "processed tokens" : "sessions"} in the selected period
            {data ? ` · ${data.timezone} days` : ""}
          </span>
        </div>
        <div className="chart-controls">
          <Toggle
            label="Shade days by"
            value={intensity}
            options={[["tokens", "Tokens"], ["sessions", "Sessions"]]}
            onChange={setIntensity}
          />
        </div>
      </div>

      {activity.isError ? (
        <div className="session-error" role="alert">
          <p>Activity couldn’t be loaded. Try again or check that Observer is running.</p>
          <button className="ghost" onClick={() => void activity.refetch()}>Try again</button>
        </div>
      ) : !data ? (
        <div className="skeleton activity-skeleton" />
      ) : data.days.length === 0 ? (
        <p className="hint activity-empty">The selected period has no days up to today.</p>
      ) : (
        <ContributionGraph
          key={`${data.start}:${data.end}`}
          data={data}
          intensity={intensity}
          selectedDay={selectedDay}
          onSelectDay={onSelectDay}
          interactive={!activity.isPlaceholderData}
        />
      )}
    </section>
  );
}

function ContributionGraph({
  data,
  intensity,
  selectedDay,
  onSelectDay,
  interactive,
}: {
  data: ActivityResponse;
  intensity: Intensity;
  selectedDay: string | null;
  onSelectDay: (day: string | null) => void;
  interactive: boolean;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const cells = useRef(new Map<number, HTMLElement>());
  const [focusIndex, setFocusIndex] = useState(() => {
    const selected = data.days.findIndex((day) => day.date === selectedDay);
    return selected >= 0 ? selected : data.days.length - 1;
  });
  const [active, setActive] = useState<{ index: number; x: number; y: number } | null>(null);

  // Monday-first weeks: pad the first column so each row is one weekday.
  const offset = (new Date(`${data.start}T00:00:00Z`).getUTCDay() + 6) % 7;
  const columns = Math.ceil((offset + data.days.length) / 7);
  const thresholds = useMemo(() => levelThresholds(data.days.map((day) => metricOf(day, intensity))), [data, intensity]);
  const months = useMemo(() => monthLabels(data.days, offset, columns), [data, offset, columns]);

  // On narrow screens the graph scrolls; start at the most recent weeks.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, []);

  const show = (index: number, element: HTMLElement) => {
    const frame = wrapper.current?.getBoundingClientRect();
    const cell = element.getBoundingClientRect();
    if (!frame) return;
    setActive({ index, x: cell.left - frame.left + cell.width / 2, y: cell.top - frame.top });
  };
  // Picking the selected day again returns the list to the selected period.
  const open = (day: ActivityDay) => {
    if (!interactive) return;
    if (day.date === selectedDay) onSelectDay(null);
    else if (day.requests > 0) onSelectDay(day.date);
  };
  const move = (event: KeyboardEvent, index: number) => {
    const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
    let next: number | null = null;
    if (step != null) next = index + step;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = data.days.length - 1;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(data.days[index]);
      return;
    }
    if (next == null) return;
    event.preventDefault();
    if (next < 0 || next >= data.days.length) return;
    setFocusIndex(next);
    cells.current.get(next)?.focus();
  };

  const tip = active ? data.days[active.index] : null;
  const frameWidth = wrapper.current?.clientWidth ?? 0;
  const align = !active ? "center" : active.x < 130 ? "start" : active.x > frameWidth - 130 ? "end" : "center";
  const legend = levelLegend(thresholds, intensity);

  return (
    <div className="activity-frame" ref={wrapper} style={{ "--columns": columns } as CSSProperties}>
      <div className="activity-scroll" ref={scroller} onScroll={() => setActive(null)}>
        <div className="activity-graph" onMouseLeave={() => setActive(null)}>
          {months.map(({ column, label }) => (
            <span key={column} className="activity-month" style={{ gridColumn: column + 2 }} aria-hidden="true">{label}</span>
          ))}
          {WEEKDAYS.map((label, row) => (
            <span key={row} className="activity-weekday" style={{ gridRow: row + 2 }} aria-hidden="true">{label}</span>
          ))}
          <div
            role="grid"
            className="activity-cells"
            aria-label={`Daily coding activity, ${formatDay(data.start)} to ${formatDay(data.end)}. Use arrow keys to move between days and Enter to list a day's sessions.`}
          >
            {WEEKDAYS.map((_, row) => (
              <div role="row" key={row} className="activity-row">
                {Array.from({ length: columns }, (_, column) => {
                  const index = column * 7 + row - offset;
                  const day = data.days[index];
                  const position = { gridColumn: column + 2, gridRow: row + 2 };
                  if (!day) return <span key={column} role="presentation" className="activity-cell is-outside" style={position} />;
                  const level = levelOf(metricOf(day, intensity), thresholds);
                  const selected = day.date === selectedDay;
                  return (
                    <span
                      key={column}
                      ref={(element) => {
                        if (element) cells.current.set(index, element);
                        else cells.current.delete(index);
                      }}
                      role="gridcell"
                      tabIndex={index === focusIndex ? 0 : -1}
                      className={`activity-cell${day.requests > 0 ? " is-active" : ""}${selected ? " is-selected" : ""}${active?.index === index ? " is-hovered" : ""}`}
                      aria-selected={selected}
                      aria-disabled={!interactive || (day.requests === 0 && !selected)}
                      data-level={level}
                      data-date={day.date}
                      style={position}
                      aria-label={dayLabel(day)}
                      onMouseEnter={(event) => show(index, event.currentTarget)}
                      onFocus={(event) => {
                        setFocusIndex(index);
                        show(index, event.currentTarget);
                      }}
                      onBlur={() => setActive(null)}
                      onClick={() => open(day)}
                      onKeyDown={(event) => move(event, index)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {tip && active && (
        <div className="tip activity-tip" data-align={align} style={{ left: active.x, top: active.y }} aria-hidden="true">
          <div className="t-date">{formatDay(tip.date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</div>
          {tip.requests === 0 ? (
            <div className="t-row">No activity</div>
          ) : (
            <>
              <div className="t-total">
                <strong>{metricText(tip, intensity)}</strong>
                <span>{intensity === "tokens" ? `${fmtInt(tip.sessions)} ${plural(tip.sessions, "session")}` : `${fmtCompact(tip.processedTokens)} tokens`}</span>
              </div>
              <div className="t-row t-muted"><span>{fmtInt(tip.requests)} {plural(tip.requests, "request")}</span></div>
              <div className="activity-tip-harnesses">
                {tip.harnesses.map((item) => (
                  <div key={item.harness} className="t-row">
                    <span className="activity-tip-harness">
                      <i style={{ background: colorForHarness(item.harness) }} aria-hidden="true" />
                      {harnessLabel(item.harness)}
                    </span>
                    <span>
                      {fmtCompact(item.processedTokens)} · {fmtInt(item.sessions)} {plural(item.sessions, "session")}
                    </span>
                  </div>
                ))}
              </div>
              <div className="activity-tip-hint">
                {tip.date === selectedDay ? "Click to show the selected period" : "Click to list its sessions"}
              </div>
            </>
          )}
        </div>
      )}

      <div className="activity-legend">
        <span className="hint">
          {data.totals.requests === 0
            ? "No activity in this period."
            : `${fmtInt(data.totals.activeDays)} active ${plural(data.totals.activeDays, "day")} · ${fmtInt(data.totals.sessions)} ${plural(data.totals.sessions, "session")} · ${fmtCompact(data.totals.processedTokens)} tokens. Click a day to list its sessions.`}
        </span>
        <div className="activity-scale" aria-label={`Shade scale by ${intensity}`}>
          <span>Less</span>
          {legend.map(({ level, label }) => (
            <span key={level} className="activity-cell" data-level={level} title={label} aria-label={label} role="img" />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

function Toggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="chart-group-toggle model-limit-toggle" role="group" aria-label={label}>
      {options.map(([key, text]) => (
        <button key={key} type="button" className={value === key ? "active" : ""} aria-pressed={value === key} onClick={() => onChange(key)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function metricOf(day: ActivityDay, intensity: Intensity): number {
  return intensity === "tokens" ? day.processedTokens : day.sessions;
}

function metricText(day: ActivityDay, intensity: Intensity): string {
  return intensity === "tokens"
    ? `${fmtCompact(day.processedTokens)} tokens`
    : `${fmtInt(day.sessions)} ${plural(day.sessions, "session")}`;
}

/**
 * Quartile cut points over active days. Usage is heavy-tailed, so equal-width
 * bins would leave most days in the lowest shade.
 */
function levelThresholds(values: number[]): [number, number, number] {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (active.length === 0) return [0, 0, 0];
  const at = (p: number) => active[Math.min(active.length - 1, Math.floor(p * active.length))];
  return [at(0.25), at(0.5), at(0.75)];
}

function levelOf(value: number, [q1, q2, q3]: [number, number, number]): number {
  if (value <= 0) return 0;
  return 1 + Number(value > q1) + Number(value > q2) + Number(value > q3);
}

function levelLegend(thresholds: [number, number, number], intensity: Intensity) {
  const format = intensity === "tokens" ? fmtCompact : fmtInt;
  const unit = intensity === "tokens" ? "tokens" : "sessions";
  const [q1, q2, q3] = thresholds;
  return [
    { level: 0, label: "No activity" },
    { level: 1, label: q1 > 0 ? `Up to ${format(q1)} ${unit}` : "Any activity" },
    { level: 2, label: q2 > q1 ? `${format(q1)}–${format(q2)} ${unit}` : "Not used in this period" },
    { level: 3, label: q3 > q2 ? `${format(q2)}–${format(q3)} ${unit}` : "Not used in this period" },
    { level: 4, label: q3 > 0 ? `More than ${format(q3)} ${unit}` : "Not used in this period" },
  ];
}

/** Label a column with its month when that month's first day falls in it. */
function monthLabels(days: ActivityDay[], offset: number, columns: number) {
  const labels: Array<{ column: number; label: string }> = [];
  for (let column = 0; column < columns; column++) {
    const first = Math.max(0, column * 7 - offset);
    const last = Math.min(days.length - 1, column * 7 + 6 - offset);
    const starts = days.slice(first, last + 1).find((day) => day.date.endsWith("-01"));
    if (column === 0 || starts) {
      labels.push({ column, label: formatDay((starts ?? days[first]).date, { month: "short" }) });
    }
  }
  // The leading partial month only gets a label if it has room before the next one.
  if (labels.length > 1 && labels[1].column - labels[0].column < 3) labels.shift();
  return labels;
}

function dayLabel(day: ActivityDay): string {
  const date = formatDay(day.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (day.requests === 0) return `${date}: no activity`;
  const split = day.harnesses.map((item) => `${harnessLabel(item.harness)} ${fmtCompact(item.processedTokens)} tokens`).join(", ");
  return `${date}: ${fmtInt(day.sessions)} ${plural(day.sessions, "session")}, ${fmtCompact(day.processedTokens)} tokens, ${fmtInt(day.requests)} ${plural(day.requests, "request")}. ${split}.`;
}

/** Format a "yyyy-MM-dd" calendar day without shifting it through the viewer's time zone. */
function formatDay(day: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }): string {
  return new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

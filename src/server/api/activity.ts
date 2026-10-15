import type { RawDatabase } from "../db/index.js";
import type { ActivityDay, ActivityResponse, HarnessId } from "@shared/contracts";
import { addDays, dayBounds, dayInTimeZone } from "@shared/days";
import { buildWhere, type RangeFilters } from "./analytics.js";

// Same processed-token definition as the session explorer, so a day's total
// matches the sessions listed when the day is opened there.
const processed =
  "(e.processed_input_tokens + e.output_tokens + e.unattributed_tokens)";

export class ActivityAnalytics {
  constructor(private db: RawDatabase) {}

  /**
   * Per-day usage over every calendar day in `timezone` that the period
   * touches, aggregated from normalized events. Days have DST-aware bounds and
   * are clipped to the period, so the totals match the session list for the
   * same filters. Without `from` the period starts at the first matching
   * event; it never extends past today.
   */
  daily(
    filters: RangeFilters,
    timezone: string,
    now: Date = new Date(),
  ): ActivityResponse {
    const from = filters.from ? new Date(filters.from).toISOString() : null;
    const to = filters.to ? new Date(filters.to).toISOString() : null;
    const today = dayInTimeZone(now, timezone);
    const first = from ?? this.firstEventAt(filters);
    const start = first ? dayInTimeZone(first, timezone) : today;
    const last = to ? dayInTimeZone(new Date(Date.parse(to) - 1), timezone) : today;
    const end = last < today ? last : today;
    const windows: Array<[string, string, string]> = [];
    for (let day = start; day <= end; day = addDays(day, 1)) {
      const bounds = dayBounds(day, timezone);
      windows.push([
        day,
        from && from > bounds.from ? from : bounds.from,
        to && to < bounds.to ? to : bounds.to,
      ]);
    }

    const { sql, params } = buildWhere(this.db, { ...filters, from: null, to: null });
    // CROSS JOIN keeps the day list as the outer loop and INDEXED BY pins each
    // day to a range scan on occurred_at; otherwise a dimension filter lets the
    // planner pick e.g. the harness index and rescan it once per day.
    const rows = this.db
      .prepare(
        `WITH days AS (
           SELECT json_extract(value, '$[0]') AS day,
                  json_extract(value, '$[1]') AS day_start,
                  json_extract(value, '$[2]') AS day_end
           FROM json_each(?)
         )
         SELECT d.day AS date, e.harness AS harness,
                COUNT(DISTINCT e.session_id) AS sessions,
                SUM(${processed}) AS processedTokens,
                COUNT(*) AS requests
         FROM days d CROSS JOIN usage_events e INDEXED BY usage_events_occurred_idx
           ON e.occurred_at >= d.day_start AND e.occurred_at < d.day_end
         ${sql}
         GROUP BY d.day, e.harness`,
      )
      .all(JSON.stringify(windows), ...params) as Array<{
        date: string;
        harness: HarnessId;
        sessions: number;
        processedTokens: number;
        requests: number;
      }>;

    const byDay = new Map<string, ActivityDay>(
      windows.map(([date]) => [
        date,
        { date, sessions: 0, processedTokens: 0, requests: 0, harnesses: [] },
      ]),
    );
    for (const row of rows) {
      const day = byDay.get(row.date);
      if (!day) continue;
      // Session ids are harness-scoped, so per-harness counts sum exactly.
      day.sessions += row.sessions;
      day.processedTokens += row.processedTokens;
      day.requests += row.requests;
      day.harnesses.push({
        harness: row.harness,
        sessions: row.sessions,
        processedTokens: row.processedTokens,
        requests: row.requests,
      });
    }
    const days = [...byDay.values()];
    for (const day of days) {
      day.harnesses.sort(
        (a, b) =>
          b.processedTokens - a.processedTokens ||
          a.harness.localeCompare(b.harness),
      );
    }

    let sessions = 0;
    if (windows.length > 0) {
      const window = buildWhere(this.db, {
        ...filters,
        from: windows[0][1],
        to: windows[windows.length - 1][2],
      });
      sessions = (
        this.db
          .prepare(
            `SELECT COUNT(DISTINCT e.session_id) AS n FROM usage_events e ${window.sql}`,
          )
          .get(...window.params) as { n: number }
      ).n;
    }

    return {
      timezone,
      start,
      end,
      days,
      totals: {
        sessions,
        processedTokens: days.reduce((sum, day) => sum + day.processedTokens, 0),
        requests: days.reduce((sum, day) => sum + day.requests, 0),
        activeDays: days.filter((day) => day.requests > 0).length,
      },
    };
  }

  /** Earliest matching event before the period's end, or null when there is none. */
  private firstEventAt(filters: RangeFilters): string | null {
    const { sql, params } = buildWhere(this.db, { ...filters, from: null });
    return (
      this.db
        .prepare(`SELECT MIN(e.occurred_at) AS first FROM usage_events e ${sql}`)
        .get(...params) as { first: string | null }
    ).first;
  }
}

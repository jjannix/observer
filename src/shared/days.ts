import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/** Calendar-day helpers shared by the activity API and the session explorer. */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real "yyyy-MM-dd" calendar day. */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Shift a "yyyy-MM-dd" day by whole calendar days (timezone-free). */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The calendar day containing `instant` in `timezone`. */
export function dayInTimeZone(instant: Date | string, timezone: string): string {
  return formatInTimeZone(instant, timezone, "yyyy-MM-dd");
}

/** UTC instants bounding a local calendar day: `from` inclusive, `to` exclusive. DST-safe. */
export function dayBounds(day: string, timezone: string): { from: string; to: string } {
  return {
    from: fromZonedTime(`${day}T00:00:00`, timezone).toISOString(),
    to: fromZonedTime(`${addDays(day, 1)}T00:00:00`, timezone).toISOString(),
  };
}

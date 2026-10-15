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
    from: startOfDay(day, timezone),
    to: startOfDay(addDays(day, 1), timezone),
  };
}

/** Earliest instant on or after a local day, including midnight offset changes. */
function startOfDay(day: string, timezone: string): string {
  const guess = fromZonedTime(`${day}T00:00:00`, timezone).getTime();
  const localDay = (instant: number) => dayInTimeZone(new Date(instant), timezone);
  if (localDay(guess) === day && localDay(guess - 1) < day) {
    return new Date(guess).toISOString();
  }
  // Midnight may be skipped or repeated. Find the first instant whose local
  // date reaches this day; a skipped calendar day has the next day's start.
  const margin = 36 * 60 * 60 * 1000;
  let lower = guess - margin;
  let upper = guess + margin;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (localDay(middle) < day) lower = middle;
    else upper = middle;
  }
  return new Date(upper).toISOString();
}

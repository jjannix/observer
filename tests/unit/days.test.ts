import { describe, expect, it } from "vitest";
import { dayBounds, dayInTimeZone } from "../../src/shared/days.js";

describe("local calendar-day bounds", () => {
  it.each([
    ["2026-10-09", "Europe/Berlin", "2026-10-08T22:00:00.000Z", "2026-10-09T22:00:00.000Z"],
    ["2026-03-29", "Europe/Berlin", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"],
    ["2026-10-25", "Europe/Berlin", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"],
    // Santiago and Havana skip midnight when DST starts.
    ["2026-09-05", "America/Santiago", "2026-09-05T04:00:00.000Z", "2026-09-06T04:00:00.000Z"],
    ["2026-09-06", "America/Santiago", "2026-09-06T04:00:00.000Z", "2026-09-07T03:00:00.000Z"],
    ["2026-03-08", "America/Havana", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    // Both occurrences of Havana's repeated midnight belong to the same day.
    ["2026-11-01", "America/Havana", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
  ])("covers the entire day %s in %s", (day, timezone, from, to) => {
    expect(dayBounds(day, timezone)).toEqual({ from, to });
    expect(dayInTimeZone(from, timezone)).toBe(day);
    expect(dayInTimeZone(new Date(Date.parse(from) - 1), timezone) < day).toBe(true);
    expect(dayInTimeZone(new Date(Date.parse(to) - 1), timezone)).toBe(day);
  });

  it("gives a skipped calendar day an empty interval", () => {
    expect(dayBounds("2011-12-30", "Pacific/Apia")).toEqual({
      from: "2011-12-30T10:00:00.000Z",
      to: "2011-12-30T10:00:00.000Z",
    });
  });
});

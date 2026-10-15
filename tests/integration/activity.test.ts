import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppState } from "../../src/server/state.js";
import { registerApi } from "../../src/server/api/routes.js";
import { dayBounds } from "../../src/shared/days.js";
import type { ActivityResponse } from "../../src/shared/contracts.js";

// The contribution graph buckets requests into Europe/Berlin calendar days and
// must agree with the session explorer when a day is opened there.
describe("Activity API", () => {
  let directory: string;
  let state: AppState;
  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
    directory = mkdtempSync(join(tmpdir(), "observer-activity-"));
    process.env.OBSERVER_DATA_DIR = join(directory, "data");
    process.env.OBSERVER_CONFIG_PATH = join(directory, "config.json");
    state = new AppState();
    const config = state.getConfig();
    config.sources = [];
    config.timezone = "Europe/Berlin";
    state.updateConfig(config);
    app = Fastify();
    registerApi(app, state);
    await app.ready();
    const insertSession = state.raw.prepare(
      `INSERT INTO sessions (id, harness, logical_session_id, project_id, first_seen, last_seen)
       VALUES (?, ?, ?, NULL, '2026-01-01T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`,
    );
    const insert = state.raw.prepare(`INSERT INTO usage_events
      (id, harness, occurred_at, session_id, logical_session_id, request_id, canonical_provider_id,
       canonical_model_id, processed_input_tokens, fresh_input_tokens, cache_read_input_tokens,
       cache_write_input_tokens, output_tokens, processed_tokens, quality_flags_json)
      VALUES (?, ?, ?, ?, ?, ?, 'openai', 'openai/gpt-5', ?, ?, 0, 0, ?, ?, '[]')`);
    const event = (id: string, harness: string, session: string, at: string, input: number, output: number) =>
      insert.run(id, harness, at, `${harness}:${session}`, session, id, input, input, output, input + output);
    state.raw.transaction(() => {
      insertSession.run("pi:long", "pi", "long");
      insertSession.run("codex:quick", "codex", "quick");
      insertSession.run("pi:dst", "pi", "dst");
      insertSession.run("pi:old", "pi", "old");
      // 00:30 Berlin on Oct 9 — still Oct 8 in UTC.
      event("a", "pi", "long", "2026-10-08T22:30:00.000Z", 900, 100);
      // Oct 8 late evening in Berlin; same session continues into Oct 9.
      event("b", "pi", "long", "2026-10-08T21:30:00.000Z", 400, 100);
      event("c", "codex", "quick", "2026-10-09T08:00:00.000Z", 1500, 500);
      // DST starts 2026-03-29 in Berlin: 23:30Z on the 28th is 00:30 CET on the 29th.
      event("d", "pi", "dst", "2026-03-28T23:30:00.000Z", 50, 50);
      // Before the one-year window.
      event("e", "pi", "old", "2025-10-09T12:00:00.000Z", 10, 10);
    })();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    state.close();
    delete process.env.OBSERVER_DATA_DIR;
    delete process.env.OBSERVER_CONFIG_PATH;
    rmSync(directory, { recursive: true, force: true });
  });
  const get = async (url: string) => (await app.inject({ method: "GET", url })).json();
  const day = (response: ActivityResponse, date: string) => response.days.find((item) => item.date === date)!;
  // Midnight starting 2025-10-10 in Berlin: the last 365 local days.
  const lastYear = "/api/v1/activity?from=2025-10-09T22:00:00.000Z";

  it("returns one bucket per local calendar day the period touches, up to today", async () => {
    const year: ActivityResponse = await get(lastYear);
    expect(year).toMatchObject({ timezone: "Europe/Berlin", start: "2025-10-10", end: "2026-10-09" });
    expect(year.days).toHaveLength(365);
    expect(year.days[0].date).toBe("2025-10-10");
    expect(year.days.at(-1)!.date).toBe("2026-10-09");
    // A rolling 30-day period starts mid-day, so it touches 31 calendar days.
    const month: ActivityResponse = await get("/api/v1/activity?from=2026-09-09T10:00:00.000Z");
    expect(month).toMatchObject({ start: "2026-09-09", end: "2026-10-09" });
    expect(month.days).toHaveLength(31);
    // Without a start, the period begins on the first matching event's day.
    const all: ActivityResponse = await get("/api/v1/activity");
    expect(all).toMatchObject({ start: "2025-10-09", end: "2026-10-09" });
    // An end in the future stops at today; a period after today has no days.
    expect((await get("/api/v1/activity?from=2026-10-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z")).end).toBe("2026-10-09");
    expect((await get("/api/v1/activity?from=2026-12-01T00:00:00.000Z")).days).toEqual([]);
    const invalid = await app.inject({ method: "GET", url: "/api/v1/activity?from=yesterday" });
    expect(invalid.statusCode).toBe(400);
  });

  it("buckets by local day across midnight and DST, with a per-harness split", async () => {
    const year: ActivityResponse = await get(lastYear);
    expect(day(year, "2026-10-08")).toMatchObject({ sessions: 1, processedTokens: 500, requests: 1 });
    const today = day(year, "2026-10-09");
    expect(today).toMatchObject({ sessions: 2, processedTokens: 3000, requests: 2 });
    expect(today.harnesses).toEqual([
      { harness: "codex", sessions: 1, processedTokens: 2000, requests: 1 },
      { harness: "pi", sessions: 1, processedTokens: 1000, requests: 1 },
    ]);
    expect(day(year, "2026-03-29")).toMatchObject({ sessions: 1, processedTokens: 100 });
    expect(day(year, "2026-03-28").requests).toBe(0);
    // The multi-day session counts on each active day but once in the totals.
    expect(year.totals).toEqual({ sessions: 3, processedTokens: 3600, requests: 4, activeDays: 3 });
  });

  it("keeps the previous evening in its day when DST skips midnight", async () => {
    vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
    const config = state.getConfig();
    config.timezone = "America/Santiago";
    state.updateConfig(config);
    // Sept 5, 23:30 local: the following day begins at 01:00 after a DST jump.
    state.raw.prepare("UPDATE usage_events SET occurred_at = ? WHERE id = 'd'")
      .run("2026-09-06T03:30:00.000Z");
    const period: ActivityResponse = await get("/api/v1/activity?from=2026-09-05T04:00:00.000Z&to=2026-09-07T03:00:00.000Z");
    expect(period.days.map((item) => [item.date, item.requests])).toEqual([
      ["2026-09-05", 1], ["2026-09-06", 0],
    ]);
    expect(period.totals.processedTokens).toBe(100);
    const { from, to } = dayBounds("2026-09-05", config.timezone);
    const sessions = await get(`/api/v1/sessions?from=${from}&to=${to}`);
    expect(sessions.total).toBe(1);
    expect(sessions.items[0].processedTokens).toBe(100);
  });

  it("applies dimension filters", async () => {
    const codex: ActivityResponse = await get(`${lastYear}&harness=codex`);
    expect(codex.totals).toEqual({ sessions: 1, processedTokens: 2000, requests: 1, activeDays: 1 });
    expect(day(codex, "2026-10-08").requests).toBe(0);
  });

  it("clips edge days to the period so totals match the session list", async () => {
    // 23:45 Berlin on Oct 8: excludes the 23:30 request that day.
    const from = "2026-10-08T21:45:00.000Z";
    const period: ActivityResponse = await get(`/api/v1/activity?from=${from}`);
    expect(period.days.map((item) => item.date)).toEqual(["2026-10-08", "2026-10-09"]);
    expect(day(period, "2026-10-08").requests).toBe(0);
    expect(period.totals).toEqual({ sessions: 2, processedTokens: 3000, requests: 2, activeDays: 1 });
    const sessions = await get(`/api/v1/sessions?from=${from}`);
    expect(sessions.total).toBe(period.totals.sessions);
    expect(sessions.items.reduce((sum: number, item: any) => sum + item.processedTokens, 0)).toBe(period.totals.processedTokens);
    // A custom range ending at 00:00 UTC still touches the following Berlin day.
    const custom: ActivityResponse = await get("/api/v1/activity?from=2026-10-08T00:00:00.000Z&to=2026-10-09T00:00:00.000Z");
    expect(custom.days.map((item) => [item.date, item.requests])).toEqual([["2026-10-08", 1], ["2026-10-09", 1]]);
  });

  it("matches the session explorer for an opened day", async () => {
    const month: ActivityResponse = await get(lastYear);
    for (const date of ["2026-10-08", "2026-10-09"]) {
      const { from, to } = dayBounds(date, "Europe/Berlin");
      const sessions = await get(`/api/v1/sessions?from=${from}&to=${to}`);
      const bucket = day(month, date);
      expect(sessions.total).toBe(bucket.sessions);
      expect(sessions.items.reduce((sum: number, item: any) => sum + item.processedTokens, 0)).toBe(bucket.processedTokens);
    }
  });
});

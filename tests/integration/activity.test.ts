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

  it("returns one bucket per local calendar day ending today", async () => {
    const year: ActivityResponse = await get("/api/v1/activity?range=1y");
    expect(year).toMatchObject({ range: "1y", timezone: "Europe/Berlin", start: "2025-10-10", end: "2026-10-09" });
    expect(year.days).toHaveLength(365);
    expect(year.days[0].date).toBe("2025-10-10");
    expect(year.days.at(-1)!.date).toBe("2026-10-09");
    expect((await get("/api/v1/activity?range=90d")).days).toHaveLength(90);
    expect((await get("/api/v1/activity?range=30d")).days).toHaveLength(30);
    expect((await get("/api/v1/activity")).range).toBe("1y");
    const invalid = await app.inject({ method: "GET", url: "/api/v1/activity?range=7d" });
    expect(invalid.statusCode).toBe(400);
  });

  it("buckets by local day across midnight and DST, with a per-harness split", async () => {
    const year: ActivityResponse = await get("/api/v1/activity?range=1y");
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

  it("applies dimension filters", async () => {
    const codex: ActivityResponse = await get("/api/v1/activity?range=30d&harness=codex");
    expect(codex.totals).toEqual({ sessions: 1, processedTokens: 2000, requests: 1, activeDays: 1 });
    expect(day(codex, "2026-10-08").requests).toBe(0);
  });

  it("matches the session explorer for an opened day", async () => {
    const month: ActivityResponse = await get("/api/v1/activity?range=30d");
    for (const date of ["2026-10-08", "2026-10-09"]) {
      const { from, to } = dayBounds(date, "Europe/Berlin");
      const sessions = await get(`/api/v1/sessions?from=${from}&to=${to}`);
      const bucket = day(month, date);
      expect(sessions.total).toBe(bucket.sessions);
      expect(sessions.items.reduce((sum: number, item: any) => sum + item.processedTokens, 0)).toBe(bucket.processedTokens);
    }
  });
});

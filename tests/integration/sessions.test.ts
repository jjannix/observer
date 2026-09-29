import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppState } from "../../src/server/state.js";
import { registerApi } from "../../src/server/api/routes.js";

// Exercise the HTTP contracts against real SQLite accounting, including a
// session larger than the event-page cap and a session spanning range filters.
describe("Session explorer API", () => {
  let directory: string;
  let state: AppState;
  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "observer-sessions-"));
    process.env.OBSERVER_DATA_DIR = join(directory, "data");
    process.env.OBSERVER_CONFIG_PATH = join(directory, "config.json");
    state = new AppState();
    const config = state.getConfig();
    config.sources = [];
    config.providerBilling = [{ provider: "openai", mode: "subscription" }];
    state.updateConfig(config);
    app = Fastify();
    registerApi(app, state);
    await app.ready();
    state.raw
      .prepare(
        `INSERT INTO projects (id, normalized_root_path, display_path, canonical_project)
      VALUES ('project', 'c:/work/project_100%', 'C:/Work/Project_100%', 'project')`,
      )
      .run();
    const insertSession = state.raw
      .prepare(`INSERT INTO sessions (id, harness, logical_session_id, project_id, first_seen, last_seen)
      VALUES (?, ?, ?, 'project', '2025-01-01T00:00:00.000Z', '2025-01-03T00:00:00.000Z')`);
    insertSession.run("pi:big", "pi", "big");
    insertSession.run("codex:big", "codex", "big");
    insertSession.run("pi:zero", "pi", "zero");
    const insert = state.raw.prepare(`INSERT INTO usage_events
      (id, harness, occurred_at, session_id, logical_session_id, request_id, turn_id, project_id,
       canonical_provider_id, canonical_model_id, processed_input_tokens, fresh_input_tokens,
       cache_read_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens,
       processed_tokens, cost_available, cost_nano_usd, quality_flags_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'project', ?, ?, 1000, 100, 800, 100, 20, 5, 1020, ?, ?, ?)`);
    state.raw.transaction(() => {
      for (let i = 0; i < 300; i++) {
        const later = i >= 150;
        const timestamp = new Date(
          Date.parse(later ? "2025-01-03T00:00:00Z" : "2025-01-01T00:00:00Z") +
            (i % 150) * 60000,
        ).toISOString();
        insert.run(
          `big-${i}`,
          "pi",
          timestamp,
          "pi:big",
          "big",
          `request-${i}`,
          `turn-${Math.floor(i / 2)}`,
          later ? "zai" : "openai",
          later ? "zai/glm-5" : "openai/gpt-5",
          i === 0 || i === 299 ? 1 : 0,
          i === 0 ? 0 : i === 299 ? 20_000_000 : null,
          i === 10 ? '["missing-cost"]' : "[]",
        );
      }
      insert.run(
        "codex-1",
        "codex",
        "2025-01-05T00:00:00.000Z",
        "codex:big",
        "big",
        "codex-request",
        null,
        "openai",
        "openai/gpt-5",
        0,
        null,
        "[]",
      );
      insert.run(
        "zero-1",
        "pi",
        "2025-01-04T00:00:00.000Z",
        "pi:zero",
        "zero",
        "zero-request",
        null,
        "openai",
        "openai/gpt-5",
        1,
        0,
        "[]",
      );
    })();
  });
  afterEach(async () => {
    await app.close();
    state.close();
    delete process.env.OBSERVER_DATA_DIR;
    delete process.env.OBSERVER_CONFIG_PATH;
    rmSync(directory, { recursive: true, force: true });
  });
  const get = async (url: string) =>
    (await app.inject({ method: "GET", url })).json();

  it("aggregates complete sessions before pagination, with deterministic sorting and harness identity", async () => {
    const first = await get("/api/v1/sessions?sort=tokens&pageSize=1");
    expect(first).toMatchObject({ total: 3, page: 1, pageSize: 1 });
    expect(first.items[0]).toMatchObject({
      sessionId: "pi:big",
      requests: 300,
      turns: 150,
      processedTokens: 306000,
      costUsd: 0.02,
    });
    expect(first.items[0].models).toHaveLength(2);
    expect(first.items[0].cacheHitRate).toBeCloseTo(0.8);
    expect(first.items[0].costCoverage).toBeCloseTo(2 / 300);
    const recent = await get("/api/v1/sessions?sort=recent&pageSize=1");
    expect(recent.items[0].sessionId).toBe("codex:big");
    expect(recent.items[0].costUsd).toBeNull();
    const next = await get("/api/v1/sessions?sort=recent&pageSize=1&page=2");
    expect(next.items[0]).toMatchObject({ sessionId: "pi:zero", costUsd: 0 });
    const cost = await get("/api/v1/sessions?sort=cost");
    expect(cost.items.map((item: any) => item.sessionId)).toEqual([
      "pi:big",
      "pi:zero",
      "codex:big",
    ]);
    expect((await get("/api/v1/sessions?page=999")).page).toBe(1);
  });

  it("searches session groups without dropping other models and treats wildcard characters literally", async () => {
    const model = await get("/api/v1/sessions?search=glm");
    expect(model.total).toBe(1);
    expect(model.items[0]).toMatchObject({
      requests: 300,
      processedTokens: 306000,
    });
    expect(
      (await get("/api/v1/sessions?search=codex%3Abig")).items[0].sessionId,
    ).toBe("codex:big");
    expect((await get("/api/v1/sessions?search=Project_100%25")).total).toBe(3);
    expect((await get("/api/v1/sessions?search=Project_100x")).total).toBe(0);
  });

  it("distinguishes full history from filtered usage and returns complete models, timeline and coverage", async () => {
    const list = await get(
      "/api/v1/sessions?from=2025-01-02T00:00:00.000Z&to=2025-01-04T00:00:00.000Z",
    );
    expect(list.items[0]).toMatchObject({
      sessionId: "pi:big",
      requests: 150,
      processedTokens: 153000,
    });
    const full = await get("/api/v1/sessions/pi%3Abig");
    expect(full.session).toMatchObject({
      requests: 300,
      processedTokens: 306000,
      outputTokens: 6000,
      reasoningOutputTokens: 1500,
      turns: 150,
    });
    expect(full.models).toHaveLength(2);
    expect(
      full.models.find((model: any) => model.provider === "openai").billingMode,
    ).toBe("subscription");
    expect(full.hasSubscription).toBe(true);
    expect(
      full.models.reduce(
        (sum: number, model: any) => sum + model.processedTokens,
        0,
      ),
    ).toBe(306000);
    expect(full.timeline.length).toBeLessThanOrEqual(48);
    expect(
      full.timeline.reduce(
        (sum: number, point: any) => sum + point.requests,
        0,
      ),
    ).toBe(300);
    expect(
      full.timeline.reduce(
        (sum: number, point: any) => sum + point.processedTokens,
        0,
      ),
    ).toBe(306000);
    expect(full.largestRequests).toHaveLength(5);
    expect(full.qualityFlags).toEqual(["missing-cost"]);
    const filtered = await get("/api/v1/sessions/pi%3Abig?model=zai%2Fglm-5");
    expect(filtered.session.requests).toBe(150);
    expect(filtered.models).toHaveLength(1);
    expect(filtered.session.costCoverage).toBeCloseTo(1 / 150);
    expect(
      (await app.inject("/api/v1/sessions/pi%3Abig?from=2026-01-01"))
        .statusCode,
    ).toBe(404);
  });

  it("paginates requests from only the selected session and filters without omissions", async () => {
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const result = await get(
        `/api/v1/sessions/pi%3Abig/requests?pageSize=100${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(result.total).toBe(300);
      expect(
        result.items.every((item: any) => item.sessionId === "pi:big"),
      ).toBe(true);
      ids.push(...result.items.map((item: any) => item.id));
      cursor = result.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(300);
    expect(new Set(ids).size).toBe(300);
    const filtered = await get(
      "/api/v1/sessions/pi%3Abig/requests?model=zai%2Fglm-5",
    );
    expect(filtered.total).toBe(150);
    expect(filtered.items[0].canonicalModelId).toBe("zai/glm-5");
  });

  it("sorts requests by usage or latest activity with stable cursor pagination", async () => {
    state.raw
      .prepare(
        "UPDATE usage_events SET processed_input_tokens = 2000, fresh_input_tokens = 1100, processed_tokens = 2020 WHERE id = 'big-299'",
      )
      .run();
    const largest = await get(
      "/api/v1/sessions/pi%3Abig/requests?sort=largest&pageSize=1",
    );
    expect(largest.items[0].id).toBe("big-299");
    const second = await get(
      "/api/v1/sessions/pi%3Abig/requests?sort=largest&pageSize=1&cursor=" +
        largest.nextCursor,
    );
    expect(second.items[0].id).not.toBe("big-299");
    expect(second.items[0].processedTokens).toBe(1020);
    const recent = await get(
      "/api/v1/sessions/pi%3Abig/requests?sort=recent&pageSize=1",
    );
    expect(recent.items[0].id).toBe("big-299");
    const older = await get(
      "/api/v1/sessions/pi%3Abig/requests?sort=recent&pageSize=1&cursor=" +
        recent.nextCursor,
    );
    expect(older.items[0].id).toBe("big-298");
  });

  it("sorts sessions by every visible column in both directions before paging", async () => {
    state.raw
      .exec(`INSERT INTO projects (id, normalized_root_path, display_path, canonical_project)
      VALUES ('alpha', 'z:/alpha', 'Z:/Alpha', 'alpha'), ('zulu', 'a:/zulu', 'A:/Zulu', 'zulu');
      UPDATE usage_events SET project_id = 'alpha', cache_read_input_tokens = 100 WHERE session_id = 'codex:big';
      UPDATE usage_events SET project_id = 'zulu', cache_read_input_tokens = 900 WHERE session_id = 'pi:zero';`);
    const first = async (sort: string, direction: string) =>
      (
        await get(
          `/api/v1/sessions?sort=${sort}&direction=${direction}&pageSize=1`,
        )
      ).items[0].sessionId;
    expect(await first("project", "asc")).toBe("codex:big");
    expect(await first("project", "desc")).toBe("pi:zero");
    expect(await first("harness", "asc")).toBe("codex:big");
    expect(await first("harness", "desc")).toBe("pi:big");
    expect(await first("cache", "asc")).toBe("codex:big");
    expect(await first("cache", "desc")).toBe("pi:zero");
    expect(await first("recent", "asc")).toBe("pi:big");
    expect(await first("recent", "desc")).toBe("codex:big");
    for (const sort of ["tokens", "requests"]) {
      expect(await first(sort, "asc")).toBe("codex:big");
      expect(await first(sort, "desc")).toBe("pi:big");
    }
    for (const direction of ["asc", "desc"]) {
      const costs = await get(
        `/api/v1/sessions?sort=cost&direction=${direction}`,
      );
      expect(costs.items.map((row: any) => row.sessionId)).toEqual(
        direction === "asc"
          ? ["pi:zero", "pi:big", "codex:big"]
          : ["pi:big", "pi:zero", "codex:big"],
      );
    }
  });

  it("orders every request column across cursor pages, including tied and missing costs", async () => {
    state.raw
      .exec(`UPDATE usage_events SET fresh_input_tokens = 1100, cache_read_input_tokens = 1600,
      output_tokens = 70, processed_input_tokens = 2800, processed_tokens = 2870 WHERE id = 'big-299';
      UPDATE usage_events SET fresh_input_tokens = 300, cache_read_input_tokens = 100,
      output_tokens = 1, processed_input_tokens = 500, processed_tokens = 501 WHERE id = 'big-2';`);
    const columns: Record<string, (row: any) => number | string | null> = {
      oldest: (row) => row.occurredAt,
      largest: (row) => row.processedTokens,
      model: (row) => row.canonicalModelId.split("/").at(-1).toLowerCase(),
      fresh: (row) => row.freshInputTokens,
      cache: (row) => row.cacheReadInputTokens,
      output: (row) => row.outputTokens,
      cost: (row) => row.costUsd,
    };
    for (const [sort, value] of Object.entries(columns))
      for (const direction of ["asc", "desc"]) {
        let cursor: string | null = null;
        const rows: any[] = [];
        do {
          const page = await get(
            `/api/v1/sessions/pi%3Abig/requests?sort=${sort}&direction=${direction}&pageSize=37${cursor ? `&cursor=${cursor}` : ""}`,
          );
          rows.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        expect(rows, sort + direction).toHaveLength(300);
        expect(new Set(rows.map((row) => row.id)).size).toBe(300);
        for (let index = 1; index < rows.length; index++) {
          const previous = value(rows[index - 1]),
            current = value(rows[index]);
          if (current == null) continue;
          expect(previous).not.toBeNull();
          if (direction === "asc") expect(previous! <= current).toBe(true);
          else expect(previous! >= current).toBe(true);
        }
        if (sort === "cost")
          expect(rows.slice(0, 2).map(value)).toEqual(
            direction === "asc" ? [0, 0.02] : [0.02, 0],
          );
      }
  });

  it("rejects invalid query options and handles missing sessions and empty lists", async () => {
    for (const query of [
      "sort=DROP",
      "direction=wrong",
      "page=NaN",
      "page=0",
      "pageSize=0",
      "pageSize=101",
    ]) {
      expect((await app.inject(`/api/v1/sessions?${query}`)).statusCode).toBe(
        400,
      );
    }
    expect((await app.inject("/api/v1/sessions/pi%3Amissing")).statusCode).toBe(
      404,
    );
    for (const query of [
      "sort=wrong",
      "direction=wrong",
      "cursor=invalid",
      "pageSize=0",
    ]) {
      expect(
        (await app.inject(`/api/v1/sessions/pi%3Abig/requests?${query}`))
          .statusCode,
      ).toBe(400);
    }
    expect((await get("/api/v1/sessions?from=2026-01-01")).items).toEqual([]);
  });
});

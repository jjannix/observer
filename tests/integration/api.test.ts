import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerApi } from "../../src/server/api/routes.js";
import { AppState } from "../../src/server/state.js";

let dataDir: string;
let configPath: string;
let piRoot: string;

function piSession(name: string, ts: string, input: number): object[] {
  return [
    { type: "header", id: name, cwd: join(piRoot, "proj") },
    { type: "message", id: "u1", role: "user", parentId: null },
    {
      type: "message",
      id: `a_${name}`,
      role: "assistant",
      parentId: "u1",
      timestamp: ts,
      message: { provider: "openai", model: "gpt-5" },
      usage: { input, cacheRead: 0, cacheWrite: 0, output: 10, totalTokens: input + 10, cost: { total: 0.01 } },
    },
  ];
}

describe("HTTP API", () => {
  let app: ReturnType<typeof Fastify>;
  let state: AppState;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "obs-api-data-"));
    configPath = join(mkdtempSync(join(tmpdir(), "obs-api-cfg-")), "config.json");
    piRoot = mkdtempSync(join(tmpdir(), "obs-api-pi-"));
    process.env.OBSERVER_DATA_DIR = dataDir;
    process.env.OBSERVER_CONFIG_PATH = configPath;

    state = new AppState();
    const cfg = state.getConfig();
    cfg.sources = [{ id: "pi", harness: "pi", label: "Pi", root: piRoot, enabled: true }];
    state.updateConfig(cfg);

    app = Fastify();
    registerApi(app, state);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    state.close();
    delete process.env.OBSERVER_DATA_DIR;
    delete process.env.OBSERVER_CONFIG_PATH;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(join(configPath, ".."), { recursive: true, force: true });
    rmSync(piRoot, { recursive: true, force: true });
  });

  async function syncOnce() {
    state.engine.trigger("manual");
    await state.engine.join();
  }

  it("GET /health returns version and schema", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBeDefined();
    expect(typeof body.dbSchema).toBe("number");
  });

  it("POST /sync returns 202 with a run id", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/sync" });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.runId).toBeDefined();
  });

  it("summary totals reflect imported events", async () => {
    writeFileSync(
      join(piRoot, "s1.jsonl"),
      piSession("s1", "2025-01-01T00:00:00Z", 100).map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    await syncOnce();
    const res = await app.inject({ method: "GET", url: "/api/v1/summary" });
    const body = res.json();
    expect(body.totals.requests).toBe(1);
    expect(body.totals.processedInputTokens).toBe(100);
    expect(body.totals.costUsd).toBeCloseTo(0.01, 6);
  });

  it("attributes cache reuse against other harnesses on shared providers", async () => {
    const insert = state.raw.prepare(
      `INSERT INTO usage_events
       (id, harness, occurred_at, logical_session_id, request_id, canonical_provider_id,
        provider_resolution, processed_input_tokens, fresh_input_tokens,
        cache_read_input_tokens, processed_tokens)
       VALUES (?, ?, '2025-01-01T00:00:00Z', ?, ?, ?, 'source', ?, ?, ?, ?)`,
    );
    const add = (id: string, harness: string, provider: string, input: number, cacheRead: number) => {
      insert.run(id, harness, `${harness}-${id}`, id, provider, input, input - cacheRead, cacheRead, input);
    };
    // Historical aliases must compare as one canonical provider without a rebuild.
    add("pi-shared", "pi", "glm", 100_000_000, 80_000_000);
    add("pi-exclusive", "pi", "pi-only", 100_000_000, 100_000_000);
    add("codex-shared", "codex", "zai-coding-plan", 100_000_000, 60_000_000);
    // A second routed family proves alias merging is generic, not glm-specific.
    add("pi-kimi", "pi", "kimi-coding", 20_000_000, 18_000_000);
    add("codex-kimi", "codex", "moonshot-ai", 20_000_000, 10_000_000);

    const res = await app.inject({ method: "GET", url: "/api/v1/cache-attribution" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const pi = body.harnesses.find((row: any) => row.harness === "pi");
    const codex = body.harnesses.find((row: any) => row.harness === "codex");
    // Pi: 220M input (zai 100M @80M, pi-only 100M @100M, moonshot 20M @18M).
    expect(pi).toMatchObject({
      observedRate: 0.9,
      comparableObservedRate: 98_000_000 / 120_000_000,
      providerExpectedRate: 70_000_000 / 120_000_000,
      comparisonCoverage: 120_000_000 / 220_000_000,
    });
    expect(pi.adjustedLift).toBeCloseTo(28_000_000 / 120_000_000, 8);
    // Codex: 120M input (zai 100M @60M, moonshot 20M @10M); all qualified.
    expect(codex).toMatchObject({
      observedRate: 70_000_000 / 120_000_000,
      comparableObservedRate: 70_000_000 / 120_000_000,
      providerExpectedRate: 98_000_000 / 120_000_000,
      comparisonCoverage: 1,
    });
    expect(codex.adjustedLift).toBeCloseTo(-28_000_000 / 120_000_000, 8);
    expect(pi.providers.find((provider: any) => provider.providerId === "zai")).toMatchObject({ otherHarnessRate: 0.6, display: "Z.AI" });
    const moonshot = pi.providers.find((provider: any) => provider.providerId === "moonshot");
    expect(moonshot).toMatchObject({ otherHarnessRate: 0.5, display: "Moonshot AI" });
    expect(pi.providers.find((provider: any) => provider.providerId === "pi-only")).toMatchObject({ otherHarnessRate: null, lift: null });

    const filtered = await app.inject({ method: "GET", url: "/api/v1/cache-attribution?provider=glm" });
    const filteredBody = filtered.json();
    expect(filteredBody.harnesses.map((row: any) => row.harness).sort()).toEqual(["codex", "pi"]);
    expect(filteredBody.harnesses.every((row: any) => row.providers[0].providerId === "zai")).toBe(true);
    // Filtering by any alias spelling of the same family selects the merged cells.
    const kimiFiltered = await app.inject({ method: "GET", url: "/api/v1/cache-attribution?provider=kimi" });
    expect(kimiFiltered.json().harnesses.map((row: any) => row.harness).sort()).toEqual(["codex", "pi"]);
    expect(kimiFiltered.json().harnesses.every((row: any) => row.providers.every((p: any) => p.providerId === "moonshot"))).toBe(true);

    // A tiny OpenCode OpenRouter sample cannot set Pi's OpenRouter baseline.
    add("pi-router", "pi", "openrouter", 220_000_000, 206_800_000);
    add("opencode-router", "opencode", "openrouter", 87_800, 22_915);
    const imbalanced = await app.inject({ method: "GET", url: "/api/v1/cache-attribution" });
    const imbalancedPi = imbalanced.json().harnesses.find((row: any) => row.harness === "pi");
    const router = imbalancedPi.providers.find((provider: any) => provider.providerId === "openrouter");
    expect(router).toMatchObject({ otherHarnessRate: null, lift: null, comparisonNote: "no peer with at least 1M input and a 20×-balanced sample" });
  });

  it("date ranges are end-exclusive", async () => {
    writeFileSync(
      join(piRoot, "sx.jsonl"),
      [
        ...piSession("early", "2025-01-01T00:00:00Z", 100),
        ...piSession("mid", "2025-01-02T00:00:00Z", 200),
        ...piSession("late", "2025-01-03T00:00:00Z", 300),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    await syncOnce();
    // to = exclusive boundary at mid day; only early + mid included
    const res = await app.inject({ method: "GET", url: "/api/v1/summary?from=2025-01-01T00:00:00Z&to=2025-01-03T00:00:00Z" });
    const body = res.json();
    expect(body.totals.requests).toBe(2);
  });

  it("events endpoint paginates with a cursor", async () => {
    const lines: object[] = [{ type: "header", id: "page", cwd: join(piRoot, "p") }];
    lines.push({ type: "message", id: "u1", role: "user", parentId: null });
    for (let i = 0; i < 5; i++) {
      lines.push({
        type: "message",
        id: `a${i}`,
        role: "assistant",
        parentId: "u1",
        timestamp: `2025-01-0${i + 1}T00:00:00Z`,
        message: { provider: "openai", model: "gpt-5" },
        usage: { input: 10 + i, output: 1, totalTokens: 11 + i },
      });
    }
    writeFileSync(join(piRoot, "page.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await syncOnce();

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const url: string = `/api/v1/events?pageSize=2${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await app.inject({ method: "GET", url });
      const body: { items: { id: string }[]; nextCursor: string | null } = res.json();
      for (const e of body.items) seen.push(e.id);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5); // no duplicates across pages
  });

  it("dimensions compose with provider/model filters", async () => {
    writeFileSync(
      join(piRoot, "d.jsonl"),
      piSession("d", "2025-01-01T00:00:00Z", 50).map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    await syncOnce();
    const res = await app.inject({ method: "GET", url: "/api/v1/dimensions" });
    const body = res.json();
    expect(body.harnesses).toContain("pi");
    expect(body.models.length).toBeGreaterThan(0);

    const timeseries = await app.inject({ method: "GET", url: "/api/v1/timeseries?metric=processedTokens&groupBy=harness" });
    expect(timeseries.statusCode).toBe(200);
    expect(timeseries.json()).toMatchObject({ groupBy: "harness", providers: ["pi"] });

    const attribution = await app.inject({ method: "GET", url: "/api/v1/cache-attribution" });
    expect(attribution.statusCode).toBe(200);
    expect(attribution.json()).toMatchObject({
      harnesses: [{
        harness: "pi",
        processedInputTokens: 50,
        observedRate: 0,
        adjustedLift: null,
        comparisonCoverage: 0,
        providers: [{ providerId: "openai", inputShare: 1, otherHarnessRate: null }],
      }],
    });
  });

  it("invalid PUT /config is rejected without corrupting prior file", async () => {
    const prior = state.getConfig();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/config",
      payload: { version: 1, timezone: "Europe/Berlin", sources: "not-an-array" },
    });
    expect(res.statusCode).toBe(400);
    // Config unchanged.
    expect(state.getConfig()).toEqual(prior);
  });

  it("rebuild requires confirmation", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/rebuild", payload: {} });
    expect(res.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/v1/rebuild", payload: { confirm: "rebuild" } });
    expect(ok.statusCode).toBe(202);
  });

  it("read-time canonicalization merges stale provider rows in dimensions, timeseries, and summary", async () => {
    const insert = state.raw.prepare(
      `INSERT INTO usage_events
       (id, harness, occurred_at, logical_session_id, request_id, raw_provider_id, canonical_provider_id,
        provider_resolution, processed_input_tokens, fresh_input_tokens,
        cache_read_input_tokens, processed_tokens)
       VALUES (?, 'pi', '2025-01-01T00:00:00Z', ?, ?, ?, ?, 'source', ?, ?, ?, ?)`,
    );

    insert.run("e1", "s1", "r1", "glm", "glm", 100, 100, 0, 100);
    insert.run("e2", "s2", "r2", "zai-coding-plan", "zai-coding-plan", 200, 200, 0, 200);
    insert.run("e3", "s3", "r3", "glm", "zai", 300, 300, 0, 300);

    // Dimensions: providers collapsed to "zai"
    const dimsRes = await app.inject({ method: "GET", url: "/api/v1/dimensions" });
    const dims = dimsRes.json();
    expect(dims.providers.find((p: any) => p.id === "glm")).toBeUndefined();
    expect(dims.providers.find((p: any) => p.id === "zai-coding-plan")).toBeUndefined();
    const zai = dims.providers.find((p: any) => p.id === "zai");
    expect(zai).toBeDefined();
    expect(zai.display).toBe("Z.AI");
    expect(zai.eventCount).toBe(3);

    // Timeseries: grouped under single "zai" provider
    const tsRes = await app.inject({ method: "GET", url: "/api/v1/timeseries?metric=processedTokens&groupBy=provider" });
    const ts = tsRes.json();
    expect(ts.providers).toEqual(["zai"]);
    expect(ts.points).toEqual([{ date: "2025-01-01", provider: "zai", value: 600 }]);

    // Summary: provider=zai filter matches all 3 events
    const summaryRes = await app.inject({ method: "GET", url: "/api/v1/summary?provider=zai" });
    const summary = summaryRes.json();
    expect(summary.totals.requests).toBe(3);
    expect(summary.totals.processedTokens).toBe(600);
  });

  it("models-breakdown returns range-filtered models ranked by token volume", async () => {
    const insert = state.raw.prepare(
      `INSERT INTO usage_events
       (id, harness, occurred_at, logical_session_id, request_id, raw_model_id, canonical_model_id,
        processed_input_tokens, fresh_input_tokens, cache_read_input_tokens, output_tokens, processed_tokens)
       VALUES (?, 'pi', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertModel = state.raw.prepare(
      `INSERT OR IGNORE INTO models (id, canonical_model_id, raw_model_id, owner, display) VALUES (?, ?, ?, ?, ?)`,
    );

    // Insert 20 models with 5 events each, 100 tokens per event (500 tokens total per model)
    for (let m = 1; m <= 20; m++) {
      insertModel.run(`test/model-${m}`, `test/model-${m}`, `model-${m}`, "test", `Model ${m}`);
      for (let e = 1; e <= 5; e++) {
        insert.run(
          `m${m}_e${e}`,
          `2025-01-0${e}T00:00:00Z`,
          `s_${m}`,
          `r_${m}_${e}`,
          `model-${m}`,
          `test/model-${m}`,
          90,
          90,
          0,
          10,
          100,
        );
      }
    }

    // Insert 1 model with only 1 event, but 1,000,000 tokens
    insertModel.run("google/gemini-3.7-flash", "google/gemini-3.7-flash", "gemini-3.7-flash", "google", "Gemini 3.7 Flash");
    insert.run(
      "gemini_e1",
      "2025-01-01T00:00:00Z",
      "s_gemini",
      "r_gemini_1",
      "gemini-3.7-flash",
      "google/gemini-3.7-flash",
      800_000,
      200_000,
      600_000,
      200_000,
      1_000_000,
    );

    const res = await app.inject({ method: "GET", url: "/api/v1/models-breakdown" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.models.length).toBe(21);
    // Gemini Flash ranks #1 despite having only 1 event
    expect(body.models[0]).toMatchObject({
      id: "google/gemini-3.7-flash",
      canonicalModelId: "google/gemini-3.7-flash",
      processedTokens: 1_000_000,
      cacheReadInputTokens: 600_000,
      freshInputTokens: 200_000,
      outputTokens: 200_000,
    });
    expect(body.models[0].cacheHitRate).toBeCloseTo(600_000 / 800_000);

    // Dimensions models also ordered by volume
    const dimsRes = await app.inject({ method: "GET", url: "/api/v1/dimensions" });
    const dims = dimsRes.json();
    expect(dims.models[0].id).toBe("google/gemini-3.7-flash");
  });
});

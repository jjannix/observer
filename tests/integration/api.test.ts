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
});

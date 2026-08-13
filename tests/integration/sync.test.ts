import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, renameSync, unlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../../src/server/sync/repository.js";
import { SyncEngine } from "../../src/server/sync/engine.js";
import { makeDb } from "../helpers/db.js";
import { defaultConfig, type ObserverConfig } from "../../src/server/config/schema.js";
import { containsForbiddenContent } from "../../src/server/collectors/envelope.js";

let piRoot: string;
let codexRoot: string;
let codexArchivedRoot: string;

function newConfig(): ObserverConfig {
  const cfg = defaultConfig();
  cfg.sources = [
    { id: "pi-default", harness: "pi", label: "Pi", root: piRoot, enabled: true },
    { id: "codex-sessions", harness: "codex", label: "Codex", root: codexRoot, enabled: true },
    { id: "codex-archived", harness: "codex", label: "Codex (archived)", root: codexArchivedRoot, enabled: true },
  ];
  cfg.projectAliases = [];
  return cfg;
}

function countEvents(repo: Repository, harness: string): number {
  const r = repo["db"].prepare(`SELECT COUNT(*) AS c FROM usage_events WHERE harness = ?`).get(harness) as any;
  return r.c;
}

function sumTokens(repo: Repository): number {
  const r = repo["db"].prepare(`SELECT COALESCE(SUM(processed_tokens),0) AS s FROM usage_events`).get() as any;
  return r.s;
}

function writePiSession(dir: string, name: string, n: number) {
  const lines: object[] = [{ type: "header", id: name, cwd: join(dir, "proj") }];
  lines.push({ type: "message", id: "u1", role: "user", parentId: null });
  for (let i = 0; i < n; i++) {
    lines.push({
      type: "message",
      id: `a${i}`,
      role: "assistant",
      parentId: "u1",
      message: { provider: "openai", model: "gpt-5" },
      usage: { input: 100 + i, cacheRead: 10, cacheWrite: 5, output: 20, reasoning: 5, totalTokens: 135 + i, cost: { total: 0.001 } },
    });
  }
  writeFileSync(join(dir, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

function writeModernCodexSession(dir: string, name: string) {
  const lines = [
    {
      timestamp: "2026-08-13T10:00:00.000Z",
      type: "session_meta",
      payload: { id: `${name}-session`, model_provider: "openai", cwd: "C:/modern" },
    },
    {
      timestamp: "2026-08-13T10:00:01.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-1", model: "gpt-5.3-codex", cwd: "C:/modern" },
    },
    {
      timestamp: "2026-08-13T10:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
            reasoning_output_tokens: 4,
            total_tokens: 110,
          },
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
            reasoning_output_tokens: 4,
            total_tokens: 110,
          },
        },
      },
    },
  ];
  writeFileSync(join(dir, `${name}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

describe("sync lifecycle", () => {
  let db: ReturnType<typeof makeDb>;
  let repo: Repository;
  let config: ObserverConfig;
  let engine: SyncEngine;

  beforeEach(() => {
    piRoot = mkdtempSync(join(tmpdir(), "obs-pi-"));
    codexRoot = mkdtempSync(join(tmpdir(), "obs-codex-"));
    codexArchivedRoot = mkdtempSync(join(tmpdir(), "obs-codex-a-"));
    db = makeDb();
    repo = new Repository(db.raw);
    config = newConfig();
    engine = new SyncEngine(repo, () => config);
  });

  afterEach(() => {
    db.close();
    rmSync(piRoot, { recursive: true, force: true });
    rmSync(codexRoot, { recursive: true, force: true });
    rmSync(codexArchivedRoot, { recursive: true, force: true });
  });

  it("two full syncs produce identical totals", async () => {
    writePiSession(piRoot, "sess-a", 3);
    const t1 = engine.trigger("manual");
    await engine.join();
    const totalsAfter1 = sumTokens(repo);
    const eventsAfter1 = countEvents(repo, "pi");
    expect(t1.status).toBe("started");
    expect(eventsAfter1).toBe(3);

    engine.trigger("manual");
    await engine.join();
    expect(sumTokens(repo)).toBe(totalsAfter1);
    expect(countEvents(repo, "pi")).toBe(eventsAfter1);
  });

  it("appending one complete line adds exactly one event", async () => {
    writePiSession(piRoot, "sess-b", 2);
    engine.trigger("manual");
    await engine.join();
    expect(countEvents(repo, "pi")).toBe(2);
    appendFileSync(
      join(piRoot, "sess-b.jsonl"),
      JSON.stringify({
        type: "message",
        id: "a999",
        role: "assistant",
        parentId: "u1",
        message: { provider: "openai", model: "gpt-5" },
        usage: { input: 7, output: 3, totalTokens: 10 },
      }) + "\n",
      "utf8",
    );
    engine.trigger("manual");
    await engine.join();
    expect(countEvents(repo, "pi")).toBe(3);
  });

  it("moving a codex rollout to archived creates no duplicate", async () => {
    const rollout = [
      JSON.stringify({ type: "session_meta", session_id: "roll-1", model_provider: "openai", cwd: "C:/proj", model: "gpt-5-codex" }),
      JSON.stringify({ type: "turn_context", model: "gpt-5-codex", turn_id: "t1" }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 } } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", total_token_usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 20, total_tokens: 220 } } }),
    ].join("\n") + "\n";
    writeFileSync(join(codexRoot, "roll-1.jsonl"), rollout, "utf8");

    engine.trigger("manual");
    await engine.join();
    expect(countEvents(repo, "codex")).toBe(1);

    // Move to archived.
    renameSync(join(codexRoot, "roll-1.jsonl"), join(codexArchivedRoot, "roll-1.jsonl"));
    engine.trigger("manual");
    await engine.join();
    // Still one event (no duplicate).
    expect(countEvents(repo, "codex")).toBe(1);

    // The original source file is marked missing; analytics retained.
    const missing = repo["db"]
      .prepare(`SELECT present FROM source_files WHERE source_id = 'codex-sessions' AND logical_session_id = 'roll-1'`)
      .get() as any;
    expect(missing.present).toBe(0);
    // Archived source now carries the file.
    const archived = repo["db"]
      .prepare(`SELECT present FROM source_files WHERE source_id = 'codex-archived' AND logical_session_id = 'roll-1'`)
      .get() as any;
    expect(archived.present).toBe(1);
  });

  it("imports current Codex rollout usage", async () => {
    writeModernCodexSession(codexRoot, "modern-rollout");

    engine.trigger("manual");
    await engine.join();

    expect(countEvents(repo, "codex")).toBe(1);
    const event = repo["db"]
      .prepare(
        `SELECT occurred_at, fresh_input_tokens, cache_read_input_tokens,
                output_tokens, reasoning_output_tokens, raw_model_id
         FROM usage_events WHERE harness = 'codex'`,
      )
      .get() as any;
    expect(event).toMatchObject({
      occurred_at: "2026-08-13T10:00:02.000Z",
      fresh_input_tokens: 80,
      cache_read_input_tokens: 20,
      output_tokens: 10,
      reasoning_output_tokens: 4,
      raw_model_id: "gpt-5.3-codex",
    });
  });

  it("reindexes Codex files when the adapter version changes", async () => {
    writeModernCodexSession(codexRoot, "modern-rescan");
    engine.trigger("manual");
    await engine.join();
    expect(countEvents(repo, "codex")).toBe(1);

    repo["db"].prepare(`DELETE FROM sessions WHERE harness = 'codex'`).run();
    repo["db"]
      .prepare(`UPDATE collector_sources SET adapter_version = 'codex-1' WHERE id = 'codex-sessions'`)
      .run();
    expect(countEvents(repo, "codex")).toBe(0);

    engine.trigger("manual");
    await engine.join();

    expect(countEvents(repo, "codex")).toBe(1);
    const source = repo.getSource("codex-sessions");
    expect(source.adapter_version).toBe("codex-2");
  });

  it("deleted source files are marked missing while analytics remain", async () => {
    writePiSession(piRoot, "sess-del", 2);
    engine.trigger("manual");
    await engine.join();
    expect(countEvents(repo, "pi")).toBe(2);
    unlinkSync(join(piRoot, "sess-del.jsonl"));

    engine.trigger("manual");
    await engine.join();
    const row = repo["db"]
      .prepare(`SELECT present FROM source_files WHERE source_id = 'pi-default' AND logical_session_id = 'sess-del'`)
      .get() as any;
    expect(row.present).toBe(0);
    expect(countEvents(repo, "pi")).toBe(2); // retained
  });

  it("alias edits re-resolve dimensions without changing token totals", async () => {
    writePiSession(piRoot, "sess-alias", 1);
    engine.trigger("manual");
    await engine.join();
    const tokensBefore = sumTokens(repo);
    // Change config alias rules.
    config.modelAliases = [
      { provider: null, model: "gpt-5", canonicalModel: "gpt-5-renamed", owner: "openai" },
    ];
    engine.renormalize();
    await engine.join();
    expect(sumTokens(repo)).toBe(tokensBefore);
    const m = repo["db"]
      .prepare(`SELECT DISTINCT canonical_model_id FROM usage_events WHERE harness='pi'`)
      .all() as any[];
    expect(m.some((x) => x.canonical_model_id.includes("gpt-5-renamed"))).toBe(true);
  });

  it("rebuild affects only Observer storage (sources untouched)", async () => {
    writePiSession(piRoot, "sess-reb", 2);
    engine.trigger("manual");
    await engine.join();
    const before = countEvents(repo, "pi");
    engine.rebuild();
    await engine.join();
    expect(countEvents(repo, "pi")).toBe(before);
    // Source files still present on disk.
    const fs = await import("node:fs");
    expect(fs.existsSync(join(piRoot, "sess-reb.jsonl"))).toBe(true);
  });

  it("stored raw JSON contains no forbidden content fields", async () => {
    writePiSession(piRoot, "sess-priv", 1);
    engine.trigger("manual");
    await engine.join();
    const rows = repo["db"].prepare(`SELECT envelope_json FROM raw_usage_records`).all() as any[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const env = JSON.parse(row.envelope_json);
      expect(containsForbiddenContent(env)).toBe(false);
    }
  });

  it("a parser failure in one source does not roll back another", async () => {
    writePiSession(piRoot, "sess-ok", 1);
    // Codex root: write a file that exists (collector handles malformed gracefully, won't throw).
    writeFileSync(join(codexRoot, "good.jsonl"),
      JSON.stringify({ type: "session_meta", session_id: "g", model_provider: "openai", cwd: "C:/p", model: "gpt-5-codex" }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", total_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, total_tokens: 6 } } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", total_token_usage: { input_tokens: 15, cached_input_tokens: 0, output_tokens: 2, total_tokens: 17 } } }) + "\n",
      "utf8");
    engine.trigger("manual");
    await engine.join();
    // Both sources imported independently.
    expect(countEvents(repo, "pi")).toBe(1);
    expect(countEvents(repo, "codex")).toBe(1);
  });
});

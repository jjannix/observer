import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../../src/server/sync/repository.js";
import { SyncEngine } from "../../src/server/sync/engine.js";
import { makeDb } from "../helpers/db.js";
import { defaultConfig, type ObserverConfig } from "../../src/server/config/schema.js";
import { sanitizeStopHookPayload } from "../../src/server/collectors/cursor/event.js";
import { CURSOR_ADAPTER_VERSION } from "../../src/server/collectors/cursor/collector.js";

let cursorSpool: string;
let db: ReturnType<typeof makeDb>;
let repo: Repository;
let config: ObserverConfig;
let engine: SyncEngine;

function cursorEventLine(payload: Record<string, unknown>): string {
  const event = sanitizeStopHookPayload(payload);
  if (!event) throw new Error("test payload failed to sanitize");
  return JSON.stringify(event);
}

function writeLiveFile(name: string, lines: string[], day = "2026-08-14"): void {
  const dir = join(cursorSpool, "live", day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.join("\n") + "\n", "utf8");
}

function writeBackfillFile(name: string, lines: string[]): void {
  const dir = join(cursorSpool, "backfill", "import");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.join("\n") + "\n", "utf8");
}

function sumProcessedInput(repo: Repository, harness = "cursor"): number {
  const r = repo["db"]
    .prepare(`SELECT COALESCE(SUM(fresh_input_tokens + cache_read_input_tokens + cache_write_input_tokens),0) AS s FROM usage_events WHERE harness = ?`)
    .get(harness) as { s: number };
  return r.s;
}

function countEvents(repo: Repository, harness = "cursor"): number {
  const r = repo["db"].prepare(`SELECT COUNT(*) AS c FROM usage_events WHERE harness = ?`).get(harness) as { c: number };
  return r.c;
}

function countQuarantined(repo: Repository, sourceId: string): number {
  const r = repo["db"]
    .prepare(`SELECT COUNT(*) AS c FROM raw_usage_records WHERE source_id = ? AND normalization_status = 'quarantined'`)
    .get(sourceId) as { c: number };
  return r.c;
}

function eventsForRequest(repo: Repository, requestId: string): any[] {
  return repo["db"].prepare(`SELECT * FROM usage_events WHERE request_id = ?`).all(requestId);
}

function rawEnvelopes(repo: Repository): any[] {
  return repo["db"]
    .prepare(`SELECT envelope_json FROM raw_usage_records WHERE normalization_status = 'normalized'`)
    .all()
    .map((r: any) => JSON.parse(r.envelope_json));
}

beforeEach(() => {
  cursorSpool = mkdtempSync(join(tmpdir(), "obs-cursor-spool-"));
  db = makeDb();
  repo = new Repository(db.raw);
  config = defaultConfig();
  config.sources = [
    { id: "cursor-spool", harness: "cursor", label: "Cursor", root: cursorSpool, enabled: true },
  ];
  config.projectAliases = [];
  engine = new SyncEngine(repo, () => config);
});

afterEach(() => {
  db.close();
  rmSync(cursorSpool, { recursive: true, force: true });
});

describe("cursor sync", () => {
  it("imports live stop-hook events and totals them once across repeated syncs", async () => {
    writeLiveFile("a.jsonl", [
      cursorEventLine({ conversation_id: "conv-1", generation_id: "gen-1", input_tokens: 1000, output_tokens: 200, cache_read_tokens: 300, cache_write_tokens: 50, model_id: "claude-sonnet-4-5" }),
      cursorEventLine({ conversation_id: "conv-1", generation_id: "gen-2", input_tokens: 10, output_tokens: 2 }),
    ]);
    engine.trigger("manual");
    await engine.join();
    expect(countEvents(repo)).toBe(2);
    const total = sumProcessedInput(repo);
    expect(total).toBe(1360);
    expect(countQuarantined(repo, "cursor-spool")).toBe(0);

    engine.trigger("manual");
    await engine.join();
    expect(countEvents(repo)).toBe(2);
    expect(sumProcessedInput(repo)).toBe(total);
  });

  it("quarantines tokenless Cmd+K-style stops instead of importing zero usage", async () => {
    writeLiveFile("tokenless.jsonl", [
      cursorEventLine({ conversation_id: "conv-1", generation_id: "gen-tokenless", status: "completed" }),
    ]);
    engine.trigger("manual");
    await engine.join();
    expect(countEvents(repo)).toBe(0);
    expect(countQuarantined(repo, "cursor-spool")).toBe(1);
    expect(sumProcessedInput(repo)).toBe(0);
  });

  it("supersedes an earlier snapshot for the same generation", async () => {
    writeLiveFile("20260814T100000.000Z-aaa-1.jsonl", [
      cursorEventLine({ conversation_id: "conv-1", generation_id: "gen-1", input_tokens: 100, output_tokens: 10 }),
    ]);
    engine.trigger("manual");
    await engine.join();
    expect(countEvents(repo)).toBe(1);

    writeLiveFile("20260814T100005.000Z-aaa-2.jsonl", [
      cursorEventLine({ conversation_id: "conv-1", generation_id: "gen-1", input_tokens: 500, output_tokens: 50 }),
    ]);
    engine.trigger("manual");
    await engine.join();

    const events = eventsForRequest(repo, "gen-1");
    expect(events).toHaveLength(1);
    expect(events[0].fresh_input_tokens).toBe(500);
    expect(events[0].output_tokens).toBe(50);
  });

  it("lets a live event supersede a legacy backfill event for the same generation", async () => {
    const legacy = JSON.stringify({
      ...JSON.parse(cursorEventLine({ conversation_id: "conv-1", generation_id: "gen-shared", input_tokens: 13816, output_tokens: 2251 })),
      source: "legacy-backfill",
    });
    writeBackfillFile("legacy-aaa.jsonl", [legacy]);
    writeLiveFile("live.jsonl", [
      cursorEventLine({ conversation_id: "conv-1", generation_id: "gen-shared", input_tokens: 200, output_tokens: 20, cache_read_tokens: 5 }),
    ]);

    engine.trigger("manual");
    await engine.join();

    const events = eventsForRequest(repo, "gen-shared");
    expect(events).toHaveLength(1);
    // The live accounting (200 + 5 cache-read) wins over the legacy total.
    expect(events[0].fresh_input_tokens).toBe(200);
    expect(events[0].cache_read_input_tokens).toBe(5);
    expect(sumProcessedInput(repo)).toBe(205);
  });

  it("renormalize keeps a single version per cursor generation", async () => {
    writeLiveFile("20260814T100000.000Z-aaa-1.jsonl", [
      cursorEventLine({ conversation_id: "conv-1", generation_id: "gen-1", input_tokens: 100, output_tokens: 10 }),
    ]);
    writeLiveFile("20260814T100005.000Z-aaa-2.jsonl", [
      cursorEventLine({ conversation_id: "conv-1", generation_id: "gen-1", input_tokens: 500, output_tokens: 50 }),
    ]);
    engine.trigger("manual");
    await engine.join();

    engine.renormalize();
    await engine.join();
    expect(countEvents(repo)).toBe(1);
    expect(eventsForRequest(repo, "gen-1")[0].fresh_input_tokens).toBe(500);
  });

  it("stores raw envelopes without forbidden content keys", async () => {
    writeLiveFile("a.jsonl", [
      cursorEventLine({
        conversation_id: "conv-1", generation_id: "gen-1", input_tokens: 5, output_tokens: 1,
        user_email: "secret@example.com", transcript_path: "C:/t", prompts: [{ content: "x" }],
      }),
    ]);
    engine.trigger("manual");
    await engine.join();
    for (const envelope of rawEnvelopes(repo)) {
      const serialized = JSON.stringify(envelope).toLowerCase();
      expect(serialized).not.toContain("secret@example.com");
      expect(serialized).not.toContain("transcript");
      expect(serialized).not.toContain("prompt");
      expect(serialized).not.toContain("\"content\"");
    }
  });

  it("reindexes cursor files when the adapter version changes", async () => {
    writeLiveFile("a.jsonl", [
      cursorEventLine({ conversation_id: "conv-1", generation_id: "gen-1", input_tokens: 5, output_tokens: 1 }),
    ]);
    engine.trigger("manual");
    await engine.join();
    expect(countEvents(repo)).toBe(1);

    const registry = repo["db"].prepare(`SELECT adapter_version FROM collector_sources WHERE id = ?`).get("cursor-spool") as any;
    expect(registry.adapter_version).toBe(CURSOR_ADAPTER_VERSION);

    repo["db"]
      .prepare(`UPDATE collector_sources SET adapter_version = ? WHERE id = ?`)
      .run("cursor-0", "cursor-spool");
    engine.trigger("manual");
    await engine.join();
    // The stale adapter version forced a full re-collection of the source,
    // and the row now carries the current adapter version again.
    const reread = repo["db"].prepare(`SELECT adapter_version FROM collector_sources WHERE id = ?`).get("cursor-spool") as any;
    expect(reread.adapter_version).toBe(CURSOR_ADAPTER_VERSION);
    expect(countEvents(repo)).toBe(1);
  });
});

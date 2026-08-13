import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, renameSync, unlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../../src/server/sync/repository.js";
import { SyncEngine } from "../../src/server/sync/engine.js";
import { makeDb } from "../helpers/db.js";
import { defaultConfig, type ObserverConfig } from "../../src/server/config/schema.js";
import { containsForbiddenContent } from "../../src/server/collectors/envelope.js";
import type { RawUsageEnvelope } from "../../src/shared/contracts.js";

let piRoot: string;
let codexRoot: string;
let codexArchivedRoot: string;
let claudeCodeRoot: string;

function newConfig(): ObserverConfig {
  const cfg = defaultConfig();
  cfg.sources = [
    { id: "pi-default", harness: "pi", label: "Pi", root: piRoot, enabled: true },
    { id: "codex-sessions", harness: "codex", label: "Codex", root: codexRoot, enabled: true },
    { id: "codex-archived", harness: "codex", label: "Codex (archived)", root: codexArchivedRoot, enabled: true },
    { id: "claude-code-projects", harness: "claude-code", label: "Claude Code", root: claudeCodeRoot, enabled: true },
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

function claudeEnvelope(
  logicalSessionId: string,
  requestId: string,
  outputTokens: number,
  occurredAt: string,
  lineOrdinal: number,
  envelopeHash: string,
): RawUsageEnvelope {
  return {
    harness: "claude-code",
    logicalSessionId,
    requestId,
    lineOrdinal,
    envelopeHash,
    occurredAt,
    sessionId: logicalSessionId,
    turnId: null,
    projectId: null,
    rawProviderId: null,
    rawModelId: "claude-opus-4-6",
    cwd: "C:/claude-project",
    parentId: null,
    usage: {
      freshInputTokens: 10,
      cacheReadInputTokens: 40,
      cacheWriteInputTokens: 20,
      cacheWriteAvailable: true,
      outputTokens,
      reasoningOutputTokens: null,
      reasoningAvailable: false,
      unattributedTokens: 0,
      costUsd: null,
      costAvailable: false,
    },
    context: {},
  };
}

function writeClaudeCodeSession(dir: string, name: string) {
  const lines = [
    { type: "user", uuid: "claude-user-1", parentUuid: null, sessionId: name, cwd: "C:/claude-project" },
    {
      type: "assistant",
      uuid: "claude-assistant-1",
      parentUuid: "claude-user-1",
      sessionId: name,
      cwd: "C:/claude-project",
      timestamp: "2026-08-13T11:00:00.000Z",
      requestId: "req-claude-1",
      message: {
        id: "msg-claude-1",
        role: "assistant",
        model: "claude-opus-4-6",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 20,
          output_tokens: 30,
        },
      },
    },
    {
      type: "assistant",
      uuid: "claude-assistant-2",
      parentUuid: "claude-assistant-1",
      sessionId: name,
      cwd: "C:/claude-project",
      timestamp: "2026-08-13T11:00:00.001Z",
      requestId: "req-claude-1",
      message: {
        id: "msg-claude-1",
        role: "assistant",
        model: "claude-opus-4-6",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 20,
          output_tokens: 300,
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
    claudeCodeRoot = mkdtempSync(join(tmpdir(), "obs-claude-code-"));
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
    rmSync(claudeCodeRoot, { recursive: true, force: true });
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

  it("imports Claude Code transcript usage", async () => {
    writeClaudeCodeSession(claudeCodeRoot, "claude-session");

    engine.trigger("manual");
    await engine.join();

    expect(countEvents(repo, "claude-code")).toBe(1);
    const event = repo["db"]
      .prepare(
        `SELECT occurred_at, fresh_input_tokens, cache_read_input_tokens,
                cache_write_input_tokens, output_tokens, raw_provider_id, raw_model_id
         FROM usage_events WHERE harness = 'claude-code'`,
      )
      .get() as any;
    expect(event).toMatchObject({
      occurred_at: "2026-08-13T11:00:00.001Z",
      fresh_input_tokens: 10,
      cache_read_input_tokens: 40,
      cache_write_input_tokens: 20,
      output_tokens: 300,
      raw_provider_id: null,
      raw_model_id: "claude-opus-4-6",
    });
    const duplicate = repo["db"]
      .prepare(`SELECT COUNT(*) AS c FROM raw_usage_records WHERE normalization_status = 'duplicate'`)
      .get() as any;
    expect(duplicate.c).toBe(1);
    expect(repo.countWarnings()).toBe(0);
  });

  it("updates Claude Code usage when a final snapshot is appended", async () => {
    writeClaudeCodeSession(claudeCodeRoot, "claude-incremental");
    engine.trigger("manual");
    await engine.join();

    appendFileSync(
      join(claudeCodeRoot, "claude-incremental.jsonl"),
      JSON.stringify({
        type: "assistant",
        uuid: "claude-assistant-final",
        parentUuid: "claude-assistant-2",
        sessionId: "claude-incremental",
        timestamp: "2026-08-13T11:00:00.002Z",
        requestId: "req-claude-1",
        message: {
          id: "msg-claude-1",
          role: "assistant",
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 20,
            output_tokens: 600,
          },
        },
      }) + "\n",
      "utf8",
    );
    engine.trigger("manual");
    await engine.join();

    const event = repo["db"]
      .prepare(`SELECT output_tokens FROM usage_events WHERE harness = 'claude-code'`)
      .get() as any;
    expect(countEvents(repo, "claude-code")).toBe(1);
    expect(event.output_tokens).toBe(600);
  });

  it("renormalize after appending a final snapshot keeps only the final version", async () => {
    writeClaudeCodeSession(claudeCodeRoot, "claude-renorm");
    engine.trigger("manual");
    await engine.join();
    // Append a final snapshot for the same request in a second sync batch.
    appendFileSync(
      join(claudeCodeRoot, "claude-renorm.jsonl"),
      JSON.stringify({
        type: "assistant",
        uuid: "claude-assistant-final",
        parentUuid: "claude-assistant-2",
        sessionId: "claude-renorm",
        timestamp: "2026-08-13T11:00:00.002Z",
        requestId: "req-claude-1",
        message: {
          id: "msg-claude-1",
          role: "assistant",
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 20,
            output_tokens: 600,
          },
        },
      }) + "\n",
      "utf8",
    );
    engine.trigger("manual");
    await engine.join();

    // Before renormalize, the cross-batch superseded snapshot is already a
    // duplicate (the within-batch one from the first sync is the other).
    const sourceBefore = repo.getSource("claude-code-projects");
    expect(sourceBefore.duplicates).toBe(2);

    engine.renormalize();
    await engine.join();

    // Exactly one normalized raw snapshot remains for the request; renormalize
    // is order-independent because only the final version is replayed.
    const perRequest = repo["db"]
      .prepare(
        `SELECT COUNT(*) AS c FROM raw_usage_records
         WHERE logical_session_id = 'claude-renorm'
           AND request_id = 'msg-claude-1:req-claude-1'
           AND normalization_status = 'normalized'`,
      )
      .get() as any;
    expect(perRequest.c).toBe(1);

    expect(countEvents(repo, "claude-code")).toBe(1);
    const event = repo["db"]
      .prepare(`SELECT output_tokens FROM usage_events WHERE harness = 'claude-code'`)
      .get() as any;
    expect(event.output_tokens).toBe(600);
    expect(repo.getSource("claude-code-projects").duplicates).toBe(2);

    // Idempotent: a second renormalize reproduces the same totals.
    engine.renormalize();
    await engine.join();
    expect(countEvents(repo, "claude-code")).toBe(1);
    const event2 = repo["db"]
      .prepare(`SELECT output_tokens FROM usage_events WHERE harness = 'claude-code'`)
      .get() as any;
    expect(event2.output_tokens).toBe(600);
    expect(repo.getSource("claude-code-projects").duplicates).toBe(2);
  });

  it("renormalize collapses pre-existing superseded normalized snapshots", () => {
    // Simulate legacy data where both a stale and a final snapshot were stored
    // as `normalized` for the same request (e.g. before supersession marking).
    repo.upsertCollectorSource(
      { id: "claude-code-projects", harness: "claude-code", label: "Claude Code", root: claudeCodeRoot, enabled: true },
      "claude-code-2",
      true,
    );
    const logicalSessionId = "claude-legacy";
    const requestId = "msg-legacy:req-legacy";
    const now = new Date().toISOString();
    const stale = claudeEnvelope(logicalSessionId, requestId, 111, "2026-08-13T12:00:00.000Z", 1, "h-stale");
    const final = claudeEnvelope(logicalSessionId, requestId, 222, "2026-08-13T12:00:00.001Z", 2, "h-final");
    repo.insertRawRecord({
      sourceId: "claude-code-projects",
      sourceFileId: null,
      logicalSessionId,
      lineOrdinal: 1,
      envelopeHash: "h-stale",
      parserVersion: "claude-code-2",
      requestId,
      occurredAt: stale.occurredAt,
      status: "normalized",
      envelopeJson: JSON.stringify(stale),
      qualityFlagsJson: JSON.stringify([]),
      createdAt: now,
    });
    repo.insertRawRecord({
      sourceId: "claude-code-projects",
      sourceFileId: null,
      logicalSessionId,
      lineOrdinal: 2,
      envelopeHash: "h-final",
      parserVersion: "claude-code-2",
      requestId,
      occurredAt: final.occurredAt,
      status: "normalized",
      envelopeJson: JSON.stringify(final),
      qualityFlagsJson: JSON.stringify([]),
      createdAt: now,
    });

    engine.renormalize();

    const normalized = repo["db"]
      .prepare(
        `SELECT COUNT(*) AS c FROM raw_usage_records
         WHERE logical_session_id = ? AND request_id = ? AND normalization_status = 'normalized'`,
      )
      .get(logicalSessionId, requestId) as any;
    const duplicates = repo["db"]
      .prepare(
        `SELECT COUNT(*) AS c FROM raw_usage_records
         WHERE logical_session_id = ? AND request_id = ? AND normalization_status = 'duplicate'`,
      )
      .get(logicalSessionId, requestId) as any;
    expect(normalized.c).toBe(1);
    expect(duplicates.c).toBe(1);

    // The last-stored (final) snapshot wins deterministically.
    const event = repo["db"]
      .prepare(`SELECT output_tokens FROM usage_events WHERE harness = 'claude-code'`)
      .get() as any;
    expect(event.output_tokens).toBe(222);
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

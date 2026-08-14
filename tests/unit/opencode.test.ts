import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenCodeCollector } from "../../src/server/collectors/opencode/collector.js";
import type { CollectEmit, CollectFileOptions } from "../../src/server/collectors/contract.js";
import type { RawUsageEnvelope } from "../../src/shared/contracts.js";

function usageEmits(emits: CollectEmit[]): RawUsageEnvelope[] {
  return emits
    .filter((emit) => emit.kind === "usage")
    .map((emit) => (emit as Extract<CollectEmit, { kind: "usage" }>).usage.envelope);
}

function quarantineReasons(emits: CollectEmit[]): string[] {
  return emits
    .filter((emit) => emit.kind === "quarantine")
    .map((emit) => (emit as Extract<CollectEmit, { kind: "quarantine" }>).quarantine.reason);
}

function nodeEmits(emits: CollectEmit[]): Array<{ nodeId: string; role: string | null }> {
  return emits
    .filter((emit) => emit.kind === "node")
    .map((emit) => {
      const node = (emit as Extract<CollectEmit, { kind: "node" }>).node;
      return { nodeId: node.nodeId, role: node.role };
    });
}

function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parentID: "msg_user_1",
    role: "assistant",
    mode: "build",
    agent: "build",
    path: { cwd: "C:\\projects\\observer", root: "C:\\projects\\observer" },
    cost: 0.00054602352,
    tokens: {
      total: 8229,
      input: 6390,
      output: 47,
      reasoning: 0,
      cache: { read: 1792, write: 0 },
    },
    modelID: "~deepseek/deepseek-v4-flash-latest",
    providerID: "openrouter",
    time: { created: 1786388366292, completed: 1786388370771 },
    finish: "tool-calls",
    ...overrides,
  };
}

function userMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "user",
    agent: "build",
    model: { providerID: "openrouter", modelID: "~deepseek/deepseek-v4-flash-latest" },
    time: { created: 1786388366000 },
    ...overrides,
  };
}

interface WriteMessage {
  id: string;
  sessionId?: string;
  timeCreated: number;
  timeUpdated?: number;
  data: Record<string, unknown>;
}

describe("OpenCode collector", () => {
  let root: string;
  const collector = new OpenCodeCollector();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "observer-opencode-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeDatabase(
    messages: WriteMessage[],
    sessions: Array<{ id: string; directory?: string; parentId?: string | null }> = [],
  ): string {
    const path = join(root, "opencode.db");
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        parent_id text,
        directory text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      );
      CREATE TABLE message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
    `);
    const insertSession = db.prepare(
      "INSERT INTO session (id, project_id, parent_id, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const session of sessions) {
      insertSession.run(
        session.id,
        "global",
        session.parentId ?? null,
        session.directory ?? "C:/projects/observer",
        1786388300000,
        1786388400000,
      );
    }
    const insertMessage = db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    for (const message of messages) {
      insertMessage.run(
        message.id,
        message.sessionId ?? "ses_1",
        message.timeCreated,
        message.timeUpdated ?? message.timeCreated,
        JSON.stringify(message.data),
      );
    }
    db.close();
    return path;
  }

  function updateMessage(id: string, data: Record<string, unknown>, timeUpdated: number): void {
    const db = new Database(join(root, "opencode.db"));
    db.prepare("UPDATE message SET data = ?, time_updated = ? WHERE id = ?").run(
      JSON.stringify(data),
      timeUpdated,
      id,
    );
    db.close();
  }

  async function collect(path: string, options: Partial<CollectFileOptions> = {}) {
    const stat = statSync(path);
    return collector.collectFile(
      { logicalSessionId: "opencode", path, size: stat.size, mtimeMs: stat.mtimeMs },
      {
        byteCursor: 0,
        lineCursor: 0,
        parserState: null,
        ctx: { sourceId: "opencode-database", historyCutoff: null },
        ...options,
      },
    );
  }

  function defaultMessages(): WriteMessage[] {
    return [
      { id: "msg_user_1", timeCreated: 1786388366000, data: userMessage() },
      { id: "msg_asst_1", timeCreated: 1786388366292, timeUpdated: 1786388370771, data: assistantMessage() },
    ];
  }

  it("normalizes token classes, folds reasoning into output, and resolves identity", async () => {
    const path = writeDatabase(defaultMessages(), [{ id: "ses_1", directory: "C:/projects/observer" }]);

    const result = await collect(path);
    const envelopes = usageEmits(result.emits);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      harness: "opencode",
      logicalSessionId: "opencode",
      sessionId: "ses_1",
      requestId: "msg_asst_1",
      occurredAt: "2026-08-10T18:59:26.292Z",
      turnId: "msg_user_1",
      cwd: "C:\\projects\\observer",
      parentId: "msg_user_1",
      rawProviderId: "openrouter",
      rawModelId: "~deepseek/deepseek-v4-flash-latest",
      usage: {
        freshInputTokens: 6390,
        cacheReadInputTokens: 1792,
        cacheWriteInputTokens: 0,
        cacheWriteAvailable: true,
        outputTokens: 47,
        reasoningOutputTokens: 0,
        reasoningAvailable: true,
        unattributedTokens: 0,
        costUsd: 0.00054602352,
        costAvailable: true,
      },
    });
    expect(nodeEmits(result.emits)).toEqual([
      { nodeId: "msg_user_1", role: "user" },
      { nodeId: "msg_asst_1", role: "assistant" },
    ]);
    expect(result.schemaFingerprint).not.toBe("");
  });

  it("adds reasoning to output and reports it as a subset", async () => {
    const data = assistantMessage({
      tokens: { total: 13273, input: 13241, output: 11, reasoning: 21, cache: { read: 0, write: 0 } },
    });
    const path = writeDatabase([{ id: "msg_asst_1", timeCreated: 1786389556899, data }]);

    const envelope = usageEmits((await collect(path)).emits)[0];
    expect(envelope.usage.outputTokens).toBe(32);
    expect(envelope.usage.reasoningOutputTokens).toBe(21);
    expect(envelope.usage.unattributedTokens).toBe(0);
  });

  it("falls back to the session directory for cwd", async () => {
    const data = assistantMessage({ path: undefined });
    const path = writeDatabase(
      [{ id: "msg_asst_1", timeCreated: 1786388366292, data }],
      [{ id: "ses_1", directory: "C:/projects/from-session" }],
    );

    const envelope = usageEmits((await collect(path)).emits)[0];
    expect(envelope.cwd).toBe("C:/projects/from-session");
    expect(envelope.context).toMatchObject({ sessionDirectory: "C:/projects/from-session" });
  });

  it("skips aborted zero-token rows and quarantines invalid counts", async () => {
    const aborted = assistantMessage({
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    });
    const invalid = assistantMessage({
      tokens: { input: -1, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const path = writeDatabase([
      { id: "msg_aborted", timeCreated: 1786388300000, data: aborted },
      { id: "msg_invalid", timeCreated: 1786388300001, data: invalid },
    ]);

    const result = await collect(path);
    expect(usageEmits(result.emits)).toHaveLength(0);
    expect(quarantineReasons(result.emits)).toEqual(["invalid-token-count"]);
  });

  it("quarantines malformed row JSON", async () => {
    const path = join(root, "opencode.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text,
        directory text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
      CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL,
        time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    `);
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run("msg_bad", "ses_1", 1786388300000, 1786388300000, "{not json");
    db.close();

    const result = await collect(path);
    expect(quarantineReasons(result.emits)).toEqual(["malformed-json"]);
  });

  it("consumes appended rows incrementally through the watermark", async () => {
    const path = writeDatabase(defaultMessages());
    const first = await collect(path);
    expect(usageEmits(first.emits)).toHaveLength(1);

    const db = new Database(path);
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "msg_asst_2",
      "ses_1",
      1786388400000,
      1786388400000,
      JSON.stringify(assistantMessage({
        parentID: "msg_asst_1",
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      })),
    );
    db.close();

    const second = await collect(path, {
      byteCursor: first.byteCursor,
      lineCursor: first.lineCursor,
      parserState: first.parserState,
    });
    const envelopes = usageEmits(second.emits);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].requestId).toBe("msg_asst_2");
    expect(second.lineCursor).toBe(first.lineCursor + 1);
  });

  it("supersedes a streaming snapshot when the row is finalized", async () => {
    const path = writeDatabase(defaultMessages());
    const first = await collect(path);
    expect(usageEmits(first.emits)[0].usage.outputTokens).toBe(47);

    updateMessage(
      "msg_asst_1",
      assistantMessage({ tokens: { total: 9275, input: 6390, output: 1093, reasoning: 0, cache: { read: 1792, write: 0 } } }),
      1786388372000,
    );

    const second = await collect(path, {
      byteCursor: first.byteCursor,
      lineCursor: first.lineCursor,
      parserState: first.parserState,
    });
    const envelopes = usageEmits(second.emits);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].usage.outputTokens).toBe(1093);
    expect(envelopes[0].requestId).toBe("msg_asst_1");
  });

  it("does not re-emit an unchanged snapshot", async () => {
    const path = writeDatabase(defaultMessages());
    const first = await collect(path);

    // An unrelated update (e.g. summary edit) bumps time_updated only.
    updateMessage("msg_asst_1", assistantMessage({ finish: "stop" }), 1786388380000);

    const second = await collect(path, {
      byteCursor: first.byteCursor,
      lineCursor: first.lineCursor,
      parserState: first.parserState,
    });
    expect(usageEmits(second.emits)).toHaveLength(0);
    expect(quarantineReasons(second.emits)).toHaveLength(0);
  });

  it("resumes correctly inside a tie group at the watermark", async () => {
    const tied: WriteMessage[] = [
      { id: "msg_a", timeCreated: 1786388366000, timeUpdated: 5000, data: assistantMessage() },
      { id: "msg_b", timeCreated: 1786388366000, timeUpdated: 5000, data: assistantMessage() },
    ];
    const path = writeDatabase(tied);

    const first = await collect(path, { maxLines: 1 });
    expect(usageEmits(first.emits)).toHaveLength(1);
    expect(usageEmits(first.emits)[0].requestId).toBe("msg_a");

    const second = await collect(path, {
      lineCursor: first.lineCursor,
      parserState: first.parserState,
      maxLines: 1,
    });
    expect(usageEmits(second.emits)).toHaveLength(1);
    expect(usageEmits(second.emits)[0].requestId).toBe("msg_b");

    const third = await collect(path, {
      lineCursor: second.lineCursor,
      parserState: second.parserState,
      maxLines: 1,
    });
    expect(usageEmits(third.emits)).toHaveLength(0);
  });

  it("attributes turns when the parent row is updated after its child", async () => {
    // time_updated order: assistant (5000) before its user parent (9000).
    const messages: WriteMessage[] = [
      { id: "msg_asst_late", timeCreated: 1786388366292, timeUpdated: 5000, data: assistantMessage({ parentID: "msg_user_late" }) },
      {
        id: "msg_user_late",
        timeCreated: 1786388366000,
        timeUpdated: 9000,
        data: userMessage({ time: { created: 1786388366000 } }),
      },
    ];
    const path = writeDatabase(messages);

    const result = await collect(path);
    const envelopes = usageEmits(result.emits);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].turnId).toBe("msg_user_late");
    // The lazily fetched user node is emitted exactly once.
    const userNodeEmits = nodeEmits(result.emits).filter((node) => node.nodeId === "msg_user_late");
    expect(userNodeEmits).toEqual([{ nodeId: "msg_user_late", role: "user" }]);
  });

  it("attributes turns through the nearest user ancestor", async () => {
    const messages: WriteMessage[] = [
      { id: "msg_user_1", timeCreated: 1786388366000, data: userMessage() },
      {
        id: "msg_user_2",
        timeCreated: 1786388380000,
        data: userMessage({ time: { created: 1786388380000 } }),
      },
      {
        id: "msg_asst_1",
        timeCreated: 1786388366292,
        timeUpdated: 1786388370771,
        data: assistantMessage(),
      },
      {
        id: "msg_asst_2",
        timeCreated: 1786388381000,
        timeUpdated: 1786388382000,
        data: assistantMessage({ parentID: "msg_user_2", time: { created: 1786388381000 } }),
      },
    ];
    const path = writeDatabase(messages);

    const envelopes = usageEmits((await collect(path)).emits);
    expect(envelopes.map((envelope) => [envelope.requestId, envelope.turnId])).toEqual([
      ["msg_asst_1", "msg_user_1"],
      ["msg_asst_2", "msg_user_2"],
    ]);
  });

  it("marks subagent sessions in the accounting context", async () => {
    const path = writeDatabase(
      [{ id: "msg_asst_1", timeCreated: 1786388366292, data: assistantMessage() }],
      [{ id: "ses_1", directory: "C:/projects/observer", parentId: "ses_parent" }],
    );

    const envelope = usageEmits((await collect(path)).emits)[0];
    expect(envelope.context).toMatchObject({ sessionParentId: "ses_parent", querySource: "subagent" });
  });

  it("retains the total surplus as unattributed tokens", async () => {
    const data = assistantMessage({
      tokens: { total: 9000, input: 6390, output: 47, reasoning: 0, cache: { read: 1792, write: 0 } },
    });
    const path = writeDatabase([{ id: "msg_asst_1", timeCreated: 1786388366292, data }]);

    const envelope = usageEmits((await collect(path)).emits)[0];
    expect(envelope.usage.unattributedTokens).toBe(771);
  });

  it("discovers the database with WAL sidecars folded into change detection", async () => {
    const path = writeDatabase(defaultMessages());
    const discovered = collector.discover(root, { sourceId: "opencode-database", historyCutoff: null });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({ logicalSessionId: "opencode", path });

    const db = new Database(path);
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "msg_asst_2",
      "ses_1",
      1786388400000,
      1786388400000,
      JSON.stringify(assistantMessage()),
    );
    db.close(); // Checkpoints the WAL back into the main file.

    const walPath = `${path}-wal`;
    const afterCheckpoint = collector.discover(root, { sourceId: "opencode-database", historyCutoff: null })[0];
    expect(afterCheckpoint.size).toBeGreaterThanOrEqual(discovered[0].size);

    // Simulate a live WAL sidecar: aggregate size must grow beyond the db file.
    mkdirSync(root, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(walPath, Buffer.alloc(64 * 1024));
    const withWal = collector.discover(root, { sourceId: "opencode-database", historyCutoff: null })[0];
    expect(withWal.size).toBeGreaterThanOrEqual(afterCheckpoint.size + 64 * 1024);
  });

  it("returns nothing when the database is absent", () => {
    expect(collector.discover(root, { sourceId: "opencode-database", historyCutoff: null })).toEqual([]);
  });

  it("reports the byte cursor as zero so a shrinking database cannot deadlock", async () => {
    const path = writeDatabase(defaultMessages());
    const result = await collect(path);
    expect(result.byteCursor).toBe(0);
  });
});

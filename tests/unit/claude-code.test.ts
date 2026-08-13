import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeCollector } from "../../src/server/collectors/claude-code/collector.js";
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

function duplicateReasons(emits: CollectEmit[]): string[] {
  return emits
    .filter((emit) => emit.kind === "duplicate")
    .map((emit) => (emit as Extract<CollectEmit, { kind: "duplicate" }>).duplicate.reason);
}

function assistant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: "assistant-1",
    parentUuid: "user-1",
    sessionId: "session-1",
    cwd: "C:/projects/observer",
    timestamp: "2026-08-13T10:01:00.000Z",
    requestId: "req-1",
    message: {
      id: "msg-1",
      role: "assistant",
      model: "claude-sonnet-4-5",
      usage: {
        input_tokens: 11,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 19,
        output_tokens: 23,
        service_tier: "standard",
      },
    },
    ...overrides,
  };
}

describe("Claude Code collector", () => {
  let root: string;
  const collector = new ClaudeCodeCollector();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "observer-claude-code-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeTranscript(name: string, records: unknown[], trailingNewline = true): string {
    const path = join(root, `${name}.jsonl`);
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + (trailingNewline ? "\n" : ""), "utf8");
    return path;
  }

  async function collect(path: string, options: Partial<CollectFileOptions> = {}) {
    const stat = statSync(path);
    return collector.collectFile(
      { logicalSessionId: "session-1", path, size: stat.size, mtimeMs: stat.mtimeMs },
      {
        byteCursor: 0,
        lineCursor: 0,
        parserState: null,
        ctx: { sourceId: "claude-code-projects", historyCutoff: null },
        ...options,
      },
    );
  }

  it("normalizes the four Claude token classes and identity metadata", async () => {
    const path = writeTranscript("session-1", [
      { type: "user", uuid: "user-1", parentUuid: null, sessionId: "session-1", cwd: "C:/projects/observer" },
      assistant(),
    ]);

    const result = await collect(path);
    const envelopes = usageEmits(result.emits);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      harness: "claude-code",
      logicalSessionId: "session-1",
      sessionId: "session-1",
      requestId: "msg-1:req-1",
      occurredAt: "2026-08-13T10:01:00.000Z",
      turnId: "user-1",
      cwd: "C:/projects/observer",
      rawProviderId: null,
      rawModelId: "claude-sonnet-4-5",
      usage: {
        freshInputTokens: 11,
        cacheReadInputTokens: 70,
        cacheWriteInputTokens: 19,
        cacheWriteAvailable: true,
        outputTokens: 23,
        reasoningOutputTokens: null,
        reasoningAvailable: false,
        unattributedTokens: 0,
        costUsd: null,
        costAvailable: false,
      },
    });
  });

  it("deduplicates content-block records from one API response", async () => {
    const first = assistant();
    const second = assistant({
      uuid: "assistant-2",
      parentUuid: "assistant-1",
    });
    const path = writeTranscript("duplicates", [
      { type: "user", uuid: "user-1", parentUuid: null },
      first,
      second,
    ]);

    const result = await collect(path);
    expect(usageEmits(result.emits)).toHaveLength(1);
    expect(duplicateReasons(result.emits)).toContain("duplicate-telemetry");
    expect(quarantineReasons(result.emits)).not.toContain("duplicate-telemetry");
  });

  it("keeps separate requests when a provider reuses a message id", async () => {
    const path = writeTranscript("request-ids", [
      assistant(),
      assistant({ uuid: "assistant-2", requestId: "req-2" }),
    ]);

    const result = await collect(path);
    expect(usageEmits(result.emits).map((envelope) => envelope.requestId)).toEqual([
      "msg-1:req-1",
      "msg-1:req-2",
    ]);
  });

  it("falls back to the typed cache-creation breakdown", async () => {
    const record = assistant();
    const message = record.message as Record<string, unknown>;
    message.usage = {
      input_tokens: 5,
      cache_read_input_tokens: 7,
      cache_creation: {
        ephemeral_5m_input_tokens: 3,
        ephemeral_1h_input_tokens: 13,
      },
      output_tokens: 2,
    };
    const path = writeTranscript("cache-breakdown", [record]);

    const envelope = usageEmits((await collect(path)).emits)[0];
    expect(envelope.usage.cacheWriteInputTokens).toBe(16);
    expect(envelope.usage.cacheWriteAvailable).toBe(true);
    expect(envelope.context).toMatchObject({
      cacheCreation5mInputTokens: 3,
      cacheCreation1hInputTokens: 13,
    });
  });

  it("ignores synthetic zero-usage messages and quarantines invalid counts", async () => {
    const synthetic = assistant({
      uuid: "synthetic",
      requestId: undefined,
      message: {
        id: "synthetic-message",
        role: "assistant",
        model: "<synthetic>",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    const invalid = assistant({
      uuid: "invalid",
      requestId: "req-invalid",
      message: {
        id: "invalid-message",
        role: "assistant",
        model: "claude-opus-4-6",
        usage: { input_tokens: -1, output_tokens: 4 },
      },
    });
    const path = writeTranscript("invalid", [synthetic, invalid]);

    const result = await collect(path);
    expect(usageEmits(result.emits)).toHaveLength(0);
    expect(quarantineReasons(result.emits)).toContain("invalid-token-count");
  });

  it("retains deduplication state across incremental appends", async () => {
    const path = writeTranscript("incremental", [assistant()]);
    const first = await collect(path);
    appendFileSync(path, `${JSON.stringify(assistant({ uuid: "assistant-duplicate" }))}\n`, "utf8");
    appendFileSync(path, `${JSON.stringify(assistant({
      uuid: "assistant-2",
      requestId: "req-2",
      message: {
        id: "msg-2",
        role: "assistant",
        model: "claude-opus-4-6",
        usage: { input_tokens: 2, output_tokens: 3 },
      },
    }))}\n`, "utf8");

    const second = await collect(path, {
      byteCursor: first.byteCursor,
      lineCursor: first.lineCursor,
      parserState: first.parserState,
    });
    expect(usageEmits(second.emits)).toHaveLength(1);
    expect(usageEmits(second.emits)[0].requestId).toBe("msg-2:req-2");
    expect(duplicateReasons(second.emits)).toContain("duplicate-telemetry");
  });

  it("discovers main and subagent transcripts with collision-safe identities", () => {
    const project = join(root, "encoded-project");
    const subagents = join(project, "session-1", "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(project, "session-1.jsonl"), "{}\n", "utf8");
    writeFileSync(join(subagents, "agent-a.jsonl"), "{}\n", "utf8");

    const discovered = collector.discover(root, { sourceId: "claude-code-projects", historyCutoff: null });
    expect(discovered.map((file) => file.logicalSessionId).sort()).toEqual([
      "session-1",
      "session-1:subagent:agent-a",
    ]);
  });

  it("does not consume an incomplete trailing JSONL line", async () => {
    const path = writeTranscript("partial", [assistant()], false);
    const result = await collect(path);
    expect(result.byteCursor).toBe(0);
    expect(result.lineCursor).toBe(0);
    expect(result.emits).toHaveLength(0);
  });
});

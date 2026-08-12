import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiCollector } from "../../src/server/collectors/pi/collector.js";
import { nearestUserAncestor } from "../../src/server/collectors/pi/collector.js";
import type { CollectEmit } from "../../src/server/collectors/contract.js";
import type { RawUsageEnvelope } from "../../src/shared/contracts.js";

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-pi-"));
}

function writeSession(dir: string, name: string, lines: object[]): string {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return path;
}

function usageEmits(emits: CollectEmit[]): RawUsageEnvelope[] {
  return emits.filter((e) => e.kind === "usage").map((e) => (e as any).usage.envelope as RawUsageEnvelope);
}

describe("Pi collector", () => {
  let dir: string;
  const collector = new PiCollector();

  beforeEach(() => {
    dir = fixtureDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not add reasoning twice to output", async () => {
    writeSession(dir, "s1", [
      { type: "header", id: "sess-1", cwd: "/proj/alpha" },
      { type: "message", id: "u1", role: "user", parentId: null },
      {
        type: "message",
        id: "a1",
        role: "assistant",
        parentId: "u1",
        message: { provider: "openai", model: "gpt-5" },
        usage: { input: 100, cacheRead: 10, cacheWrite: 20, cacheWrite1h: 20, output: 50, reasoning: 15, totalTokens: 180, cost: { total: 0.012 } },
      },
    ]);

    const result = await collector.collectFile(
      { logicalSessionId: "s1", path: join(dir, "s1.jsonl"), size: 0, mtimeMs: 0 },
      { byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "pi", historyCutoff: null } },
    );
    const env = usageEmits(result.emits)[0];
    expect(env.usage.outputTokens).toBe(50); // reasoning NOT added
    expect(env.usage.reasoningOutputTokens).toBe(15);
    expect(env.usage.reasoningAvailable).toBe(true);
  });

  it("does not double-count cacheWrite1h", async () => {
    writeSession(dir, "s2", [
      { type: "header", id: "sess-2", cwd: "/proj/alpha" },
      { type: "message", id: "u1", role: "user", parentId: null },
      {
        type: "message",
        id: "a1",
        role: "assistant",
        parentId: "u1",
        message: { provider: "openai", model: "gpt-5" },
        usage: { input: 100, cacheRead: 10, cacheWrite: 20, cacheWrite1h: 20, output: 30, totalTokens: 160 },
      },
    ]);
    const result = await collector.collectFile(
      { logicalSessionId: "s2", path: join(dir, "s2.jsonl"), size: 0, mtimeMs: 0 },
      { byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "pi", historyCutoff: null } },
    );
    const env = usageEmits(result.emits)[0];
    // processedInput = 100 + 10 + 20 = 130 (cacheWrite1h NOT added)
    const processedInput = env.usage.freshInputTokens + env.usage.cacheReadInputTokens + env.usage.cacheWriteInputTokens;
    expect(processedInput).toBe(130);
    expect(env.usage.unattributedTokens).toBe(0); // 160 - (130 + 30) = 0
  });

  it("preserves per-record model switches", async () => {
    writeSession(dir, "s3", [
      { type: "header", id: "sess-3", cwd: "/proj/beta" },
      { type: "message", id: "u1", role: "user", parentId: null },
      { type: "message", id: "a1", role: "assistant", parentId: "u1", message: { provider: "openai", model: "gpt-5" }, usage: { input: 10, output: 5, totalTokens: 15 } },
      { type: "message", id: "u2", role: "user", parentId: "a1" },
      { type: "message", id: "a2", role: "assistant", parentId: "u2", message: { provider: "anthropic", model: "claude-sonnet-4" }, usage: { input: 20, output: 8, totalTokens: 28 } },
    ]);
    const result = await collector.collectFile(
      { logicalSessionId: "s3", path: join(dir, "s3.jsonl"), size: 0, mtimeMs: 0 },
      { byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "pi", historyCutoff: null } },
    );
    const envs = usageEmits(result.emits);
    expect(envs[0].rawModelId).toBe("gpt-5");
    expect(envs[1].rawModelId).toBe("claude-sonnet-4");
  });

  it("attributes requests to nearest user ancestor through tool nodes", () => {
    const nodes = {
      u1: { parentId: null, role: "user" },
      a1: { parentId: "u1", role: "assistant" },
      t1: { parentId: "a1", role: "tool" },
      a2: { parentId: "t1", role: "assistant" },
    };
    expect(nearestUserAncestor("a2", nodes)).toBe("u1");
    expect(nearestUserAncestor("t1", nodes)).toBe("u1");
  });

  it("marks reasoning/cost unavailable rather than zero when omitted", async () => {
    writeSession(dir, "s4", [
      { type: "header", id: "sess-4", cwd: "/proj/gamma" },
      { type: "message", id: "u1", role: "user", parentId: null },
      { type: "message", id: "a1", role: "assistant", parentId: "u1", message: { provider: "openai", model: "gpt-5" }, usage: { input: 5, output: 2, totalTokens: 7 } },
    ]);
    const result = await collector.collectFile(
      { logicalSessionId: "s4", path: join(dir, "s4.jsonl"), size: 0, mtimeMs: 0 },
      { byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "pi", historyCutoff: null } },
    );
    const env = usageEmits(result.emits)[0];
    expect(env.usage.reasoningAvailable).toBe(false);
    expect(env.usage.reasoningOutputTokens).toBeNull();
    expect(env.usage.costAvailable).toBe(false);
    expect(env.usage.costUsd).toBeNull();
  });

  it("quarantines malformed JSON lines", async () => {
    const path = join(dir, "s5.jsonl");
    writeFileSync(path, '{"type":"header","id":"sess-5"}\n{ this is not json\n', "utf8");
    const result = await collector.collectFile(
      { logicalSessionId: "s5", path, size: 0, mtimeMs: 0 },
      { byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "pi", historyCutoff: null } },
    );
    const q = result.emits.find((e) => e.kind === "quarantine");
    expect(q).toBeDefined();
  });

  it("ignores partial trailing lines until completed", async () => {
    const path = join(dir, "s6.jsonl");
    // Two complete lines + one partial (no newline).
    writeFileSync(
      path,
      '{"type":"header","id":"sess-6"}\n{"type":"message","id":"a1","role":"assistant","parentId":"u1","message":{"provider":"openai","model":"gpt-5"},"usage":{"input":1,"output":1,"totalTokens":2}}\n{"type":"message","id":"partial"',
      "utf8",
    );
    const result = await collector.collectFile(
      { logicalSessionId: "s6", path, size: 0, mtimeMs: 0 },
      { byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "pi", historyCutoff: null } },
    );
    const size = statSync(path).size;
    expect(result.byteCursor).toBeLessThan(size);
    // One usage event from the complete assistant line.
    expect(usageEmits(result.emits).length).toBe(1);
  });

  it("preserves cursor and parser state across bounded batches", async () => {
    const path = join(dir, "batched.jsonl");
    const lines: object[] = [
      { type: "header", id: "batched", cwd: "/proj/batched" },
      { type: "message", id: "u1", role: "user", parentId: null },
    ];
    for (let i = 0; i < 8; i++) {
      lines.push({
        type: "message",
        id: `a${i}`,
        role: "assistant",
        parentId: "u1",
        message: { provider: "openai", model: "gpt-5" },
        usage: { input: 10, output: 2, totalTokens: 12 },
      });
    }
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    const file = { logicalSessionId: "batched", path, size: statSync(path).size, mtimeMs: statSync(path).mtimeMs };
    const first = await collector.collectFile(file, {
      byteCursor: 0,
      lineCursor: 0,
      parserState: null,
      maxLines: 4,
      ctx: { sourceId: "pi", historyCutoff: null },
    });
    const second = await collector.collectFile(file, {
      byteCursor: first.byteCursor,
      lineCursor: first.lineCursor,
      parserState: first.parserState,
      maxLines: 4,
      ctx: { sourceId: "pi", historyCutoff: null },
    });
    const third = await collector.collectFile(file, {
      byteCursor: second.byteCursor,
      lineCursor: second.lineCursor,
      parserState: second.parserState,
      maxLines: 20,
      ctx: { sourceId: "pi", historyCutoff: null },
    });
    expect(
      usageEmits(first.emits).length + usageEmits(second.emits).length + usageEmits(third.emits).length,
    ).toBe(8);
  });

  it("discovers jsonl files recursively", () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeSession(dir, "top", [{ type: "header", id: "x" }]);
    writeFileSync(join(dir, "sub", "nested.jsonl"), '{"type":"header","id":"y"}\n', "utf8");
    const files = collector.discover(dir, { sourceId: "pi", historyCutoff: null });
    expect(files.map((f) => f.logicalSessionId).sort()).toEqual(["nested", "top"]);
    void existsSync;
  });
});

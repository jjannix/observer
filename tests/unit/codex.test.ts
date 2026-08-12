import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexCollector } from "../../src/server/collectors/codex/collector.js";
import type { CollectEmit } from "../../src/server/collectors/contract.js";
import type { RawUsageEnvelope } from "../../src/shared/contracts.js";

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-codex-"));
}

function writeFile(dir: string, name: string, content: string): string {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, content, "utf8");
  return path;
}

function usageEmits(emits: CollectEmit[]): RawUsageEnvelope[] {
  return emits.filter((e) => e.kind === "usage").map((e) => (e as any).usage.envelope as RawUsageEnvelope);
}

const SESSION_META = { type: "session_meta", session_id: "codex-1", model_provider: "openai", cwd: "C:/proj/alpha", model: "gpt-5-codex" };
const TURN = (model: string, turnId: string) => ({ type: "turn_context", model, turn_id: turnId });
const TOKEN = (u: Record<string, number | undefined>) => ({
  type: "event_msg",
  payload: { type: "token_count", total_token_usage: u },
});

describe("Codex collector", () => {
  let dir: string;
  const collector = new CodexCollector();

  beforeEach(() => {
    dir = fixtureDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(path: string, logicalSessionId = "codex-1") {
    return collector.collectFile(
      { logicalSessionId, path, size: 0, mtimeMs: 0 },
      { byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "codex", historyCutoff: null } },
    );
  }

  it("computes deltas between successive cumulative vectors and subtracts cached input from fresh", async () => {
    const path = writeFile(
      dir,
      "r1",
      [
        JSON.stringify(SESSION_META),
        JSON.stringify(TURN("gpt-5-codex", "t1")),
        JSON.stringify(TOKEN({ input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 50, output_tokens: 100, reasoning_output_tokens: 40, total_tokens: 1150 })),
        JSON.stringify(TOKEN({ input_tokens: 3000, cached_input_tokens: 800, cache_write_input_tokens: 120, output_tokens: 300, reasoning_output_tokens: 120, total_tokens: 3420 })),
      ].join("\n") + "\n",
    );
    const result = await run(path);
    const envs = usageEmits(result.emits);
    expect(envs.length).toBe(1);
    const e = envs[0];
    // delta input = 2000, cached read delta = 600, cache write delta = 70
    expect(e.usage.cacheReadInputTokens).toBe(600);
    expect(e.usage.cacheWriteInputTokens).toBe(70);
    // fresh = 2000 - 600 - 70 = 1330
    expect(e.usage.freshInputTokens).toBe(1330);
    // processed input = fresh + cacheRead + cacheWrite = 1330 + 600 + 70 = 2000
    expect(e.usage.freshInputTokens + e.usage.cacheReadInputTokens + e.usage.cacheWriteInputTokens).toBe(2000);
    // output delta = 200, reasoning delta = 80 (subset)
    expect(e.usage.outputTokens).toBe(200);
    expect(e.usage.reasoningOutputTokens).toBe(80);
    expect(e.usage.reasoningAvailable).toBe(true);
  });

  it("produces no second event for duplicate (equal) cumulative telemetry", async () => {
    const path = writeFile(
      dir,
      "r2",
      [
        JSON.stringify(SESSION_META),
        JSON.stringify(TOKEN({ input_tokens: 500, cached_input_tokens: 0, output_tokens: 50, total_tokens: 550 })),
        JSON.stringify(TOKEN({ input_tokens: 500, cached_input_tokens: 0, output_tokens: 50, total_tokens: 550 })),
        JSON.stringify(TOKEN({ input_tokens: 600, cached_input_tokens: 0, output_tokens: 60, total_tokens: 660 })),
      ].join("\n") + "\n",
    );
    const result = await run(path);
    const envs = usageEmits(result.emits);
    expect(envs.length).toBe(1); // one delta (550->660), the equal one is duplicate
    const quarantines = result.emits.filter((e) => e.kind === "quarantine");
    expect(quarantines.length).toBe(1);
  });

  it("retains total-only increases as unattributed tokens", async () => {
    const path = writeFile(
      dir,
      "r3",
      [
        JSON.stringify(SESSION_META),
        JSON.stringify(TOKEN({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 })),
        // total jumps but input/output unchanged -> unattributed
        JSON.stringify(TOKEN({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 160 })),
      ].join("\n") + "\n",
    );
    const result = await run(path);
    const envs = usageEmits(result.emits);
    expect(envs.length).toBe(1);
    expect(envs[0].usage.unattributedTokens).toBe(50);
  });

  it("marks cache-write unavailable for older records omitting the field", async () => {
    const path = writeFile(
      dir,
      "r4",
      [
        JSON.stringify(SESSION_META),
        JSON.stringify(TOKEN({ input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, total_tokens: 130 })), // no cache_write field
        JSON.stringify(TOKEN({ input_tokens: 200, cached_input_tokens: 30, output_tokens: 40, total_tokens: 270 })), // no cache_write field
      ].join("\n") + "\n",
    );
    const result = await run(path);
    const envs = usageEmits(result.emits);
    expect(envs[0].usage.cacheWriteAvailable).toBe(false);
    // fresh = input delta (100) - cached read delta (20) - cache write (0, unavailable)
    expect(envs[0].usage.freshInputTokens).toBe(80);
  });

  it("quarantines non-monotonic cumulative counters", async () => {
    const path = writeFile(
      dir,
      "r5",
      [
        JSON.stringify(SESSION_META),
        JSON.stringify(TOKEN({ input_tokens: 500, cached_input_tokens: 0, output_tokens: 50, total_tokens: 550 })),
        // input goes backwards (rollback)
        JSON.stringify(TOKEN({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, total_tokens: 550 })),
      ].join("\n") + "\n",
    );
    const result = await run(path);
    const envs = usageEmits(result.emits);
    expect(envs.length).toBe(0);
    expect(result.emits.some((e) => e.kind === "quarantine")).toBe(true);
  });

  it("quarantines impossible cache relationship (cached read > input)", async () => {
    const path = writeFile(
      dir,
      "r6",
      [
        JSON.stringify(SESSION_META),
        JSON.stringify(TOKEN({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 })),
        // cached read jumps by 500 but input only by 10 -> impossible
        JSON.stringify(TOKEN({ input_tokens: 110, cached_input_tokens: 500, output_tokens: 10, total_tokens: 620 })),
      ].join("\n") + "\n",
    );
    const result = await run(path);
    const envs = usageEmits(result.emits);
    expect(envs.length).toBe(0);
  });

  it("marks cost unavailable rather than zero (codex has no cost field)", async () => {
    const path = writeFile(
      dir,
      "r7",
      [
        JSON.stringify(SESSION_META),
        JSON.stringify(TOKEN({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 })),
        JSON.stringify(TOKEN({ input_tokens: 200, cached_input_tokens: 0, output_tokens: 20, total_tokens: 220 })),
      ].join("\n") + "\n",
    );
    const result = await run(path);
    const envs = usageEmits(result.emits);
    expect(envs[0].usage.costAvailable).toBe(false);
    expect(envs[0].usage.costUsd).toBeNull();
  });

  it("ignores partial trailing lines", async () => {
    const content =
      [
        JSON.stringify(SESSION_META),
        JSON.stringify(TOKEN({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 })),
      ].join("\n") +
      "\n" +
      '{"type":"event_msg","payload":{"type":"token_count","total_token_usage":{"input_tokens":200'; // partial
    const path = writeFile(dir, "r8", content);
    const result = await run(path);
    const size = statSync(path).size;
    expect(result.byteCursor).toBeLessThan(size);
    expect(usageEmits(result.emits).length).toBe(0); // only first vector -> seed, no delta
  });
});

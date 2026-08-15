import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  isTokenlessEvent,
  isZeroVectorEvent,
  sanitizeStopHookPayload,
  validateCursorEventRecord,
} from "../../src/server/collectors/cursor/event.js";
import { buildStopHookScript } from "../../src/server/collectors/cursor/hook-script.js";
import {
  cursorDoctor,
  defaultCursorHookPaths,
  installStopHook,
  uninstallStopHook,
} from "../../src/server/collectors/cursor/hooks.js";
import { runLegacyBackfill } from "../../src/server/collectors/cursor/backfill.js";
import { CursorCollector } from "../../src/server/collectors/cursor/collector.js";
import type { CollectEmit } from "../../src/server/collectors/contract.js";
import type { RawUsageEnvelope } from "../../src/shared/contracts.js";
import { containsForbiddenContent } from "../../src/server/collectors/envelope.js";

let tmp: string;

function scriptPaths(): { hooksJsonPath: string; scriptPath: string } {
  return {
    hooksJsonPath: join(tmp, "hooks.json"),
    scriptPath: join(tmp, "hooks dir with spaces", "observer-stop.cjs"),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "observer-cursor-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function usageEmits(emits: CollectEmit[]): RawUsageEnvelope[] {
  return emits
    .filter((e) => e.kind === "usage")
    .map((e) => (e as Extract<CollectEmit, { kind: "usage" }>).usage.envelope);
}

function fullStopPayload(): Record<string, unknown> {
  return {
    hook: "stop",
    status: "completed",
    loop_count: 0,
    conversation_id: "conv-1",
    generation_id: "gen-1",
    // Identity/metadata that must be dropped:
    user_email: "secret@example.com",
    transcript_path: "C:/Users/janni/.cursor/transcripts/secret.json",
    cursor_version: "3.16.17",
    model: "claude-legacy-slug",
    model_id: "claude-sonnet-4-5",
    model_params: { temperature: 0.4, max_tokens: 8192 },
    workspace_roots: ["C:/Users/janni/Documents/Code/Observer"],
    // Content that must never survive sanitization:
    prompts: [{ role: "user", content: "top secret prompt" }],
    attachments: [{ name: "secret.ts", content: "password = 1" }],
    responses: [{ text: "secret answer" }],
    thinking: "secret reasoning text",
    tools: [{ name: "edit_file", input: { path: "x", content: "y" }, output: "z" }],
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_tokens: 300,
    cache_write_tokens: 50,
    // Future field, must be tolerated:
    brand_new_field: { whatever: true },
  };
}

describe("event sanitizer", () => {
  it("reduces a full payload to the exact allowlist", () => {
    const event = sanitizeStopHookPayload(fullStopPayload(), { projectDir: "C:/proj/obs" });
    expect(event).not.toBeNull();
    expect(Object.keys(event!).sort()).toEqual(
      [
        "cacheReadTokens", "cacheWriteTokens", "conversationId", "cursorVersion", "generationId",
        "inputTokens", "legacyModel", "modelId", "occurredAt", "outputTokens", "receivedAt",
        "reasoningTokens", "schema", "source", "status", "timestampConfidence", "workspaceRoot",
      ].sort(),
    );
    // Privacy: none of the payload's sensitive values leak into the record.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("user_email");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("model_params");
    expect(serialized).not.toContain("temperature");
    expect(event!.modelId).toBe("claude-sonnet-4-5");
    expect(event!.legacyModel).toBe("claude-legacy-slug");
    expect(event!.workspaceRoot).toBe("C:/proj/obs");
    expect(event!.inputTokens).toBe(1000);
    expect(event!.outputTokens).toBe(200);
    expect(event!.cacheReadTokens).toBe(300);
    expect(event!.cacheWriteTokens).toBe(50);
    expect(event!.reasoningTokens).toBeNull();
    expect(event!.timestampConfidence).toBe("hook-receipt");
    expect(containsForbiddenContent(event)).toBe(false);
  });

  it("prefers model_id but falls back to the legacy model slug", () => {
    const a = sanitizeStopHookPayload({ conversation_id: "c", generation_id: "g", model: "legacy-only" });
    expect(a!.modelId).toBeNull();
    expect(a!.legacyModel).toBe("legacy-only");
    const b = sanitizeStopHookPayload({ conversation_id: "c", generation_id: "g", model_id: "new-id", model: "old" });
    expect(b!.modelId).toBe("new-id");
    expect(b!.legacyModel).toBe("old");
  });

  it("uses CURSOR_PROJECT_DIR, a single workspace root, and flags multi-root ambiguity", () => {
    const single = sanitizeStopHookPayload({
      conversation_id: "c", generation_id: "g", workspace_roots: ["C:/a"],
    });
    expect(single!.workspaceRoot).toBe("C:/a");
    expect(single!.flags).toBeUndefined();

    const multi = sanitizeStopHookPayload({
      conversation_id: "c", generation_id: "g", workspace_roots: ["C:/a", "C:/b"],
    });
    expect(multi!.workspaceRoot).toBeNull();
    expect(multi!.flags).toContain("multi-root-project-ambiguous");

    const explicit = sanitizeStopHookPayload({
      conversation_id: "c", generation_id: "g", workspace_roots: ["C:/a", "C:/b"],
    }, { projectDir: "C:/canonical" });
    expect(explicit!.workspaceRoot).toBe("C:/canonical");
    expect(explicit!.flags).toBeUndefined();
  });

  it("rejects negative, fractional, non-finite and unsafe token values", () => {
    const event = sanitizeStopHookPayload({
      conversation_id: "c", generation_id: "g",
      input_tokens: -5, output_tokens: 1.5, cache_read_tokens: "not-a-number",
      cache_write_tokens: Number.MAX_SAFE_INTEGER * 2,
    });
    expect(event!.inputTokens).toBeNull();
    expect(event!.outputTokens).toBeNull();
    expect(event!.cacheReadTokens).toBeNull();
    expect(event!.cacheWriteTokens).toBeNull();
  });

  it("requires conversation and generation identity", () => {
    expect(sanitizeStopHookPayload({ conversation_id: "c" })).toBeNull();
    expect(sanitizeStopHookPayload({ generation_id: "g" })).toBeNull();
    expect(sanitizeStopHookPayload("junk")).toBeNull();
    expect(sanitizeStopHookPayload(null)).toBeNull();
  });

  it("treats tokenless and zero-vector events distinctly", () => {
    const tokenless = sanitizeStopHookPayload({ conversation_id: "c", generation_id: "g" })!;
    expect(isTokenlessEvent(tokenless)).toBe(true);
    expect(isZeroVectorEvent(tokenless)).toBe(false);
    const zero = sanitizeStopHookPayload({
      conversation_id: "c", generation_id: "g", input_tokens: 0, output_tokens: 0,
    })!;
    expect(isTokenlessEvent(zero)).toBe(false);
    expect(isZeroVectorEvent(zero)).toBe(true);
  });

  it("revalidates spooled records defensively", () => {
    const good = sanitizeStopHookPayload({
      conversation_id: "c", generation_id: "g", input_tokens: 5, reasoning_tokens: 3,
    })!;
    const validated = validateCursorEventRecord(good);
    expect(validated.ok).toBe(true);
    expect(validated.ok && validated.event.reasoningTokens).toBe(3);

    expect(validateCursorEventRecord({ schema: "other.v9" }).ok).toBe(false);
    expect(validateCursorEventRecord({ schema: "observer.cursor.usage.v1", inputTokens: -3 }).ok).toBe(false);
    expect(validateCursorEventRecord({ schema: "observer.cursor.usage.v1", inputTokens: 1 }).ok).toBe(false);
  });
});

describe("stop-hook script", () => {
  it("writes the exact sanitized allowlist (parity with the in-tree sanitizer)", () => {
    const spool = join(tmp, "spool");
    const paths = scriptPaths();
    mkdirSync(dirname(paths.scriptPath), { recursive: true });
    const scriptPath = `${paths.scriptPath}.test.cjs`;
    writeFileSync(scriptPath, buildStopHookScript(spool), "utf8");

    const payload = fullStopPayload();
    execFileSync(process.execPath, [scriptPath], {
      input: JSON.stringify(payload),
      env: { ...process.env, CURSOR_PROJECT_DIR: "C:/proj/obs" },
    });

    const liveDir = join(spool, "live");
    const day = readdirSync(liveDir)[0];
    const files = readdirSync(join(liveDir, day)).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(liveDir, day, files[0]), "utf8"));

    const expected = sanitizeStopHookPayload(payload, { projectDir: "C:/proj/obs" });
    // Timing fields are generated inside the script; compare everything else.
    const { receivedAt: _r, occurredAt: _o, ...recordRest } = record;
    const { receivedAt: _r2, occurredAt: _o2, ...expectedRest } = expected!;
    expect(recordRest).toEqual(expectedRest);
    expect(record.schema).toBe("observer.cursor.usage.v1");
    expect(JSON.stringify(record)).not.toContain("secret");
    expect(JSON.stringify(record)).not.toContain("user_email");
  }, 20_000);

  it("prints {} and fails open on malformed payloads without spooling", () => {
    const spool = join(tmp, "spool");
    const scriptPath = join(tmp, "hook.cjs");
    writeFileSync(scriptPath, buildStopHookScript(spool), "utf8");
    const out = execFileSync(process.execPath, [scriptPath], { input: "{not json" }).toString();
    expect(JSON.parse(out)).toEqual({});
    expect(existsSync(join(spool, "live"))).toBe(false);
  });

  it("embeds the spool root safely and rejects placeholder collisions", () => {
    const script = buildStopHookScript("C:/data dir/observer");
    expect(script).toContain('"C:/data dir/observer"');
    expect(() => buildStopHookScript("prefix__OBSERVER_CURSOR_SPOOL_ROOT__suffix")).toThrow();
  });
});

describe("hook installer", () => {
  it("preserves existing preToolUse config and unknown fields, idempotently", () => {
    const paths = scriptPaths();
    const preToolUse = [{ command: "node \".cursor/skills/hook-before-edit.mjs\"", timeout: 5 }];
    writeFileSync(
      paths.hooksJsonPath,
      JSON.stringify({ version: 1, hooks: { preToolUse }, futureTopLevel: { keep: true } }),
      "utf8",
    );

    const first = installStopHook({ paths, spoolRoot: join(tmp, "spool") });
    expect(first.status).toBe("installed");

    const after = JSON.parse(readFileSync(paths.hooksJsonPath, "utf8"));
    expect(after.hooks.preToolUse).toEqual(preToolUse);
    expect(after.hooks.stop).toHaveLength(1);
    expect(after.hooks.stop[0].timeout).toBe(5);
    expect(after.futureTopLevel).toEqual({ keep: true });
    expect(existsSync(paths.scriptPath)).toBe(true);

    const second = installStopHook({ paths, spoolRoot: join(tmp, "spool") });
    expect(second.status).toBe("already-installed");
    const afterAgain = JSON.parse(readFileSync(paths.hooksJsonPath, "utf8"));
    expect(afterAgain.hooks.stop).toHaveLength(1);

    const uninstall = uninstallStopHook({ paths });
    expect(uninstall.status).toBe("uninstalled");
    const restored = JSON.parse(readFileSync(paths.hooksJsonPath, "utf8"));
    expect(restored.hooks.preToolUse).toEqual(preToolUse);
    expect(restored.hooks.stop).toBeUndefined();
    expect(restored.futureTopLevel).toEqual({ keep: true });
    expect(existsSync(paths.scriptPath)).toBe(false);

    expect(uninstallStopHook({ paths }).status).toBe("not-installed");
  });

  it("quotes Windows paths with spaces in the installed command", () => {
    const paths = scriptPaths();
    const nodePath = "C:/Program Files/nodejs/node.exe";
    const result = installStopHook({ paths, spoolRoot: join(tmp, "spool"), nodePath });
    expect(result.command).toBe(`"${nodePath}" "${paths.scriptPath}"`);
    const after = JSON.parse(readFileSync(paths.hooksJsonPath, "utf8"));
    expect(after.hooks.stop[0].command).toBe(result.command);
  });

  it("resolves a version-manager shim to a stable node executable", () => {
    const paths = scriptPaths();
    installStopHook({ paths, spoolRoot: join(tmp, "spool") });
    const after = JSON.parse(readFileSync(paths.hooksJsonPath, "utf8"));
    const command = after.hooks.stop[0].command as string;
    const nodePath = command.split(" ")[0].replace(/^"|"$/g, "");
    expect(nodePath.toLowerCase()).not.toContain("multishell");
    expect(existsSync(nodePath)).toBe(true);
  });

  it("aborts without modification when hooks.json is malformed", () => {
    const paths = scriptPaths();
    writeFileSync(paths.hooksJsonPath, "{ broken", "utf8");
    expect(() => installStopHook({ paths, spoolRoot: join(tmp, "spool") })).toThrow(/not a valid JSON/);
    expect(readFileSync(paths.hooksJsonPath, "utf8")).toBe("{ broken");
    expect(uninstallStopHook({ paths }).status).toBe("aborted-malformed-hooks-json");
    expect(readFileSync(paths.hooksJsonPath, "utf8")).toBe("{ broken");
  });

  it("doctor reports install state, checksum, spool writability and last event", () => {
    const spoolRoot = join(tmp, "spool");
    const paths = scriptPaths();
    const before = cursorDoctor({ paths, spoolRoot });
    expect(before.observerEntry.expected).toBe(false);
    expect(before.warnings.some((w) => w.includes("not installed"))).toBe(true);

    installStopHook({ paths, spoolRoot });
    const after = cursorDoctor({ paths, spoolRoot });
    expect(after.observerEntry.expected).toBe(true);
    expect(after.script.checksumMatches).toBe(true);
    expect(after.spool.writable).toBe(true);
    expect(after.lastEvent).toBeNull();

    const day = new Date().toISOString().slice(0, 10);
    const liveDir = join(spoolRoot, "live", day);
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(
      join(liveDir, "20260814T000000.000Z-abc-1.jsonl"),
      JSON.stringify(sanitizeStopHookPayload({
        conversation_id: "c", generation_id: "g", input_tokens: 10, output_tokens: 2,
      })) + "\n",
      "utf8",
    );
    const withEvent = cursorDoctor({ paths, spoolRoot });
    expect(withEvent.lastEvent?.tokenFields).toContain("inputTokens");
    expect(withEvent.lastEvent?.warnings).toEqual([]);
  });
});

describe("collector", () => {
  const collector = new CursorCollector();

  function writeLive(events: object[], name = "evt.jsonl", day = "2026-08-14"): string {
    const dir = join(tmp, "spool", "live", day);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    return path;
  }

  it("imports completed, aborted and error stops with positive accounting", async () => {
    for (const status of ["completed", "aborted", "error", undefined]) {
      writeLive([
        sanitizeStopHookPayload({
          conversation_id: "conv", generation_id: `gen-${status ?? "none"}`,
          status, input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 5,
        })!,
      ], `${status ?? "none"}.jsonl`);
    }
    const discovered = collector.discover(join(tmp, "spool"), { sourceId: "s", historyCutoff: null });
    expect(discovered).toHaveLength(4);
    for (const file of discovered) {
      const result = await collector.collectFile(file, {
        byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "s", historyCutoff: null },
      });
      const envelopes = usageEmits(result.emits);
      expect(envelopes).toHaveLength(1);
      const e = envelopes[0];
      expect(e.harness).toBe("cursor");
      expect(e.logicalSessionId).toBe("conv");
      expect(e.requestId).toMatch(/^gen-/);
      expect(e.usage.freshInputTokens).toBe(100);
      expect(e.usage.cacheReadInputTokens).toBe(30);
      expect(e.usage.cacheWriteInputTokens).toBe(5);
      expect(e.usage.cacheWriteAvailable).toBe(true);
      expect(e.usage.outputTokens).toBe(20);
      expect(e.usage.costUsd).toBeNull();
      expect(e.qualityFlags).toContain("cursor-input-semantics-unverified");
      expect(containsForbiddenContent(e)).toBe(false);
    }
  });

  it("quarantines tokenless events instead of importing zero usage", async () => {
    writeLive([
      sanitizeStopHookPayload({ conversation_id: "conv", generation_id: "gen-tokenless", status: "completed" })!,
    ], "tokenless.jsonl");
    const discovered = collector.discover(join(tmp, "spool"), { sourceId: "s", historyCutoff: null });
    const result = await collector.collectFile(discovered[0], {
      byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "s", historyCutoff: null },
    });
    expect(usageEmits(result.emits)).toHaveLength(0);
    const quarantines = result.emits.filter((e) => e.kind === "quarantine") as Array<
      Extract<CollectEmit, { kind: "quarantine" }>
    >;
    expect(quarantines).toHaveLength(1);
    expect(quarantines[0].quarantine.reason).toBe("cursor-token-fields-missing");
  });

  it("normalizes future reasoning tokens and prefers model_id", async () => {
    writeLive([
      sanitizeStopHookPayload({
        conversation_id: "conv", generation_id: "gen-r",
        model_id: "gpt-5", model: "gpt-5-legacy",
        input_tokens: 1, output_tokens: 2, reasoning_tokens: 1,
      })!,
    ], "reasoning.jsonl");
    const discovered = collector.discover(join(tmp, "spool"), { sourceId: "s", historyCutoff: null });
    const result = await collector.collectFile(discovered[0], {
      byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "s", historyCutoff: null },
    });
    const e = usageEmits(result.emits)[0];
    expect(e.rawModelId).toBe("gpt-5");
    expect(e.usage.reasoningOutputTokens).toBe(1);
    expect(e.usage.reasoningAvailable).toBe(true);
  });

  it("does not consume a partial trailing line", async () => {
    const dir = join(tmp, "spool", "live", "2026-08-14");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "partial.jsonl");
    const complete = JSON.stringify(sanitizeStopHookPayload({
      conversation_id: "c", generation_id: "g1", input_tokens: 5, output_tokens: 1,
    }));
    writeFileSync(path, complete + "\n" + '{"schema":"observer.cur', "utf8");
    const discovered = collector.discover(join(tmp, "spool"), { sourceId: "s", historyCutoff: null });
    const result = await collector.collectFile(discovered[0], {
      byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "s", historyCutoff: null },
    });
    expect(result.lineCursor).toBe(1);
    expect(result.byteCursor).toBe(complete.length + 1);
    expect(usageEmits(result.emits)).toHaveLength(1);
  });

  it("quarantines malformed and unknown-schema lines", async () => {
    const dir = join(tmp, "spool", "live", "2026-08-14");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.jsonl"), "{oops\n" + JSON.stringify({ schema: "observer.cursor.v9" }) + "\n", "utf8");
    const discovered = collector.discover(join(tmp, "spool"), { sourceId: "s", historyCutoff: null });
    const result = await collector.collectFile(discovered[0], {
      byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "s", historyCutoff: null },
    });
    const reasons = result.emits
      .filter((e): e is Extract<CollectEmit, { kind: "quarantine" }> => e.kind === "quarantine")
      .map((e) => e.quarantine.reason);
    expect(reasons).toEqual(["malformed-json", "unknown-schema"]);
  });
});

describe("legacy backfill", () => {
  function makeCursorDb(dir: string, bubbles: Array<{ composer: string; bubble: string; usage?: string | null; in?: number; out?: number; time?: number }>, composers: Array<{ composerId: string; workspaceId: string; createdAt: number }>) {
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "state.vscdb"));
    db.exec("CREATE TABLE cursorDiskKV ([key] TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.exec("CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER)");
    const insert = db.prepare("INSERT INTO cursorDiskKV ([key], value) VALUES (?, ?)");
    for (const b of bubbles) {
      insert.run(`bubbleId:${b.composer}:${b.bubble}`, JSON.stringify({
        type: 2,
        text: "PROMPT AND RESPONSE CONTENT",
        toolResults: [{ name: "edit", input: { code: "x" } }],
        allThinkingBlocks: [{ text: "thinking" }],
        tokenCount: b.usage ? { inputTokens: b.in ?? 0, outputTokens: b.out ?? 0 } : { inputTokens: 0, outputTokens: 0 },
        usageUuid: b.usage ?? null,
        timingInfo: b.time != null ? { clientRpcSendTime: b.time } : null,
      }));
    }
    const header = db.prepare("INSERT INTO composerHeaders VALUES (?, ?, ?)");
    for (const c of composers) header.run(c.composerId, c.workspaceId, c.createdAt);
    db.close();
  }

  function args(overrides: Partial<Parameters<typeof runLegacyBackfill>[0]> = {}) {
    return {
      globalDbPath: join(tmp, "cursor", "globalStorage", "state.vscdb"),
      workspaceStorageDir: join(tmp, "cursor", "workspaceStorage"),
      spoolRoot: join(tmp, "spool"),
      receivedAt: "2026-08-15T00:00:00.000Z",
      ...overrides,
    };
  }

  it("imports only positive tokenCount records with usageUuid, mapping workspace and timestamps", () => {
    makeCursorDb(
      dirname(args().globalDbPath),
      [
        { composer: "comp-1", bubble: "b-1", usage: "u-1", in: 13816, out: 2251, time: 1747650422021 },
        { composer: "comp-1", bubble: "b-2", usage: "u-2", in: 500, out: 50 },
        { composer: "comp-1", bubble: "b-3", usage: null, in: 900, out: 90 }, // no usageUuid
        { composer: "comp-1", bubble: "b-4", usage: "u-4", in: 0, out: 0 }, // Cursor 3.16.17 zero storage
      ],
      [{ composerId: "comp-1", workspaceId: "ws-1", createdAt: 1741209311788 }],
    );
    mkdirSync(join(args().workspaceStorageDir, "ws-1"), { recursive: true });
    writeFileSync(join(args().workspaceStorageDir, "ws-1", "workspace.json"), JSON.stringify({ folder: "file:///c%3A/Users/janni/Documents/Code/Observer" }), "utf8");

    const summary = runLegacyBackfill(args());
    expect(summary.status).toBe("completed");
    expect(summary.positiveBubbles).toBe(2);
    expect(summary.imported).toBe(2);
    expect(summary.quarantinedIdentities).toBe(0);

    const lines = readFileSync(summary.outputFile!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    const exact = lines.find((l: any) => l.generationId === "u-1");
    expect(exact.timestampConfidence).toBe("exact");
    expect(exact.occurredAt).toBe(new Date(1747650422021).toISOString());
    const approx = lines.find((l: any) => l.generationId === "u-2");
    expect(approx.timestampConfidence).toBe("approximate");
    expect(approx.occurredAt).toBe(new Date(1741209311788).toISOString());
    for (const line of lines) {
      expect(line.schema).toBe("observer.cursor.usage.v1");
      expect(line.source).toBe("legacy-backfill");
      expect(line.workspaceRoot).toBe("c:/Users/janni/Documents/Code/Observer");
      expect(line.modelId).toBeNull();
      expect(line.cacheReadTokens).toBeNull();
      expect(containsForbiddenContent(line)).toBe(false);
      expect(JSON.stringify(line)).not.toContain("PROMPT");
    }
  });

  it("resolves duplicate usageUuid snapshots and quarantines unresolvable conflicts", () => {
    makeCursorDb(
      dirname(args().globalDbPath),
      [
        // Monotonic duplicates: keep the larger/final.
        { composer: "comp", bubble: "b-1", usage: "u-mono", in: 1504, out: 185, time: 1000 },
        { composer: "comp", bubble: "b-2", usage: "u-mono", in: 15036, out: 4734, time: 2000 },
        // Identical vectors: keep one.
        { composer: "comp", bubble: "b-3", usage: "u-same", in: 10, out: 5 },
        { composer: "comp", bubble: "b-4", usage: "u-same", in: 10, out: 5 },
        // Non-monotonic without reliable order: quarantine the identity.
        { composer: "comp", bubble: "b-5", usage: "u-conflict", in: 100, out: 1 },
        { composer: "comp", bubble: "b-6", usage: "u-conflict", in: 50, out: 9 },
      ],
      [{ composerId: "comp", workspaceId: "empty-window", createdAt: 5000 }],
    );
    const summary = runLegacyBackfill(args());
    expect(summary.imported).toBe(2);
    expect(summary.quarantinedIdentities).toBe(1);
    const lines = readFileSync(summary.outputFile!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const mono = lines.find((l: any) => l.generationId === "u-mono");
    expect(mono.inputTokens).toBe(15036);
    expect(mono.outputTokens).toBe(4734);
    expect(lines.find((l: any) => l.generationId === "u-conflict")).toBeUndefined();
  });

  it("is idempotent across repeated runs", () => {
    makeCursorDb(
      dirname(args().globalDbPath),
      [{ composer: "comp", bubble: "b-1", usage: "u-1", in: 10, out: 2, time: 1000 }],
      [{ composerId: "comp", workspaceId: "empty-window", createdAt: 500 }],
    );
    const first = runLegacyBackfill(args());
    const content1 = readFileSync(first.outputFile!, "utf8");
    const second = runLegacyBackfill(args());
    const content2 = readFileSync(second.outputFile!, "utf8");
    expect(content1).toBe(content2);
    expect(second.outputFile).toBe(first.outputFile);
  });

  it("reports missing databases and tables gracefully", () => {
    expect(runLegacyBackfill(args()).status).toBe("no-database");
    mkdirSync(dirname(args().globalDbPath), { recursive: true });
    const db = new Database(args().globalDbPath);
    db.exec("CREATE TABLE unrelated (a)");
    db.close();
    expect(runLegacyBackfill(args()).status).toBe("no-table");
  });

  it("produces events the collector imports with partial-accounting flags", async () => {
    makeCursorDb(
      dirname(args().globalDbPath),
      [{ composer: "comp-1", bubble: "b-1", usage: "u-1", in: 13816, out: 2251 }],
      [{ composerId: "comp-1", workspaceId: "ws-1", createdAt: 1741209311788 }],
    );
    runLegacyBackfill(args());
    const collector = new CursorCollector();
    const discovered = collector.discover(join(tmp, "spool"), { sourceId: "s", historyCutoff: null });
    expect(discovered.map((d) => d.path)).toHaveLength(1);
    const result = await collector.collectFile(discovered[0], {
      byteCursor: 0, lineCursor: 0, parserState: null, ctx: { sourceId: "s", historyCutoff: null },
    });
    const e = usageEmits(result.emits)[0];
    expect(e.usage.freshInputTokens).toBe(13816);
    expect(e.usage.outputTokens).toBe(2251);
    expect(e.usage.cacheWriteAvailable).toBe(false);
    expect(e.qualityFlags).toContain("historical-partial-accounting");
    expect(e.qualityFlags).toContain("approximate-timestamp");
    expect(e.qualityFlags).toContain("missing-cache-read");
    expect(e.qualityFlags).not.toContain("cursor-input-semantics-unverified");
  });
});

describe("hook script checksum determinism", () => {
  it("produces a stable script for a stable spool root", () => {
    const a = buildStopHookScript("C:/spool");
    const b = buildStopHookScript("C:/spool");
    expect(a).toBe(b);
    expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));
    expect(defaultCursorHookPaths().scriptPath).toContain("observer-stop.cjs");
  });
});

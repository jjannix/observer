import { basename, join } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import type { HarnessId, RawUsageEnvelope, TokenUsageRecord } from "@shared/contracts";
import { QUALITY_FLAGS } from "@shared/contracts";
import type {
  Collector,
  CollectorContext,
  CollectEmit,
  CollectFileOptions,
  CollectResult,
  DiscoveredFile,
} from "../contract.js";
import { readCompleteLines, probeJsonlFingerprint } from "../jsonl.js";
import { hashEnvelope } from "../envelope.js";
import {
  CursorUsageEventV1,
  isTokenlessEvent,
  isZeroVectorEvent,
  validateCursorEventRecord,
} from "./event.js";

export const CURSOR_ADAPTER_VERSION = "cursor-1";

// Observer's input-token semantics against Cursor's stop payload are not yet
// verified against a live cache-reuse pair (release gate; see the controlled
// verification plan). Every live imported event carries this flag until then.
const LIVE_INPUT_SEMANTICS_FLAG = QUALITY_FLAGS.CURSOR_INPUT_SEMANTICS_UNVERIFIED;

/**
 * Cursor collector.
 *
 * Source is Observer's own sanitized spool (never Cursor's private data):
 * - `live/YYYY-MM-DD/*.jsonl` — one atomic file per stop-hook event
 * - `backfill/*.jsonl` — immutable files written once by `observer cursor
 *   backfill` from legacy Cursor SQLite state (Cursor 3.16.17 stores no
 *   usable accounting there for new prompts).
 *
 * Every file contains sanitized `observer.cursor.usage.v1` records, so this
 * adapter only validates, maps to envelopes, and quarantines tokenless
 * events (Cmd+K and schema drift) instead of importing them as zero usage.
 * `generation_id` is the stable request identity: a later snapshot for the
 * same generation naturally supersedes the earlier one through the engine's
 * existing snapshot supersession.
 */
export class CursorCollector implements Collector {
  readonly harness: HarnessId = "cursor";
  readonly adapterVersion = CURSOR_ADAPTER_VERSION;

  discover(root: string, _ctx: CollectorContext): DiscoveredFile[] {
    if (!existsSync(root)) return [];
    const out: DiscoveredFile[] = [];
    // Backfill files are discovered before live files so that, within one sync
    // run, a live event with the same generation identity is stored last and
    // supersedes the partial historical snapshot (renormalize keeps the
    // last-stored snapshot too).
    for (const group of ["backfill", "live"]) {
      const groupDir = join(root, group);
      let entries: string[];
      try {
        entries = readdirSync(groupDir);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        const full = `${groupDir}/${entry}`.replace(/\\/g, "/");
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        if (group === "backfill" && entry !== "import") continue;
        this.collectDay(full, out);
      }
    }
    return out;
  }

  private collectDay(dir: string, out: DiscoveredFile[]): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = `${dir}/${name}`.replace(/\\/g, "/");
      if (!full.endsWith(".jsonl") || full.endsWith(".tmp")) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const logicalSessionId = basename(full).replace(/\.jsonl$/, "");
      out.push({ logicalSessionId, path: full, size: st.size, mtimeMs: st.mtimeMs });
    }
  }

  async collectFile(file: DiscoveredFile, opts: CollectFileOptions): Promise<CollectResult> {
    const { lines, byteCursor, lineCursor } = await readCompleteLines(
      file.path,
      opts.byteCursor,
      opts.lineCursor,
      opts.maxLines,
    );

    const emits: CollectEmit[] = [];

    for (const line of lines) {
      const trimmed = line.text.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        emits.push({
          kind: "quarantine",
          quarantine: { lineOrdinal: line.ordinal, reason: "malformed-json", partial: null },
        });
        continue;
      }
      const validation = validateCursorEventRecord(parsed);
      if (!validation.ok) {
        emits.push({
          kind: "quarantine",
          quarantine: { lineOrdinal: line.ordinal, reason: validation.reason, partial: null },
        });
        continue;
      }
      const event = validation.event;
      const emit = this.mapEvent(event, line.ordinal);
      if (emit) emits.push(emit);
    }

    const schemaFingerprint = opts.byteCursor === 0
      ? await probeJsonlFingerprint(file.path, this.adapterVersion)
      : "";

    return {
      emits,
      byteCursor,
      lineCursor,
      parserState: null,
      schemaFingerprint,
      schemaChanged: false,
    };
  }

  private mapEvent(event: CursorUsageEventV1, lineOrdinal: number): CollectEmit | null {
    // Cmd+K-style stops (and future schema removals) omit all token fields;
    // they must be quarantined, never imported as zero usage.
    if (isTokenlessEvent(event)) {
      return {
        kind: "quarantine",
        quarantine: { lineOrdinal, reason: "cursor-token-fields-missing", partial: null },
      };
    }

    // Present-but-all-zero vectors are not real API requests either.
    if (isZeroVectorEvent(event)) return null;

    const usage: TokenUsageRecord = {
      freshInputTokens: event.inputTokens ?? 0,
      cacheReadInputTokens: event.cacheReadTokens ?? 0,
      cacheWriteInputTokens: event.cacheWriteTokens ?? 0,
      cacheWriteAvailable: event.cacheWriteTokens != null,
      outputTokens: event.outputTokens ?? 0,
      reasoningOutputTokens: event.reasoningTokens,
      reasoningAvailable: event.reasoningTokens != null,
      unattributedTokens: 0,
      // Cursor exposes no local cost; never estimate from public prices.
      costUsd: null,
      costAvailable: false,
    };

    const flags: string[] = [];
    if (event.flags?.includes("multi-root-project-ambiguous")) {
      flags.push(QUALITY_FLAGS.MULTI_ROOT_PROJECT_AMBIGUOUS);
    }
    if (event.source === "stop-hook") {
      flags.push(LIVE_INPUT_SEMANTICS_FLAG);
    } else {
      // Legacy storage has no cache/reasoning/cost split (input is a
      // processed-input total) — always partial accounting.
      flags.push(QUALITY_FLAGS.HISTORICAL_PARTIAL_ACCOUNTING);
      if (event.timestampConfidence !== "exact") {
        flags.push(QUALITY_FLAGS.APPROXIMATE_TIMESTAMP);
      }
    }
    if (event.cacheReadTokens == null) flags.push(QUALITY_FLAGS.MISSING_CACHE_READ);

    const rawModelId = event.modelId ?? event.legacyModel;

    const envelope: Omit<RawUsageEnvelope, "envelopeHash"> & { envelopeHash: string } = {
      harness: "cursor" as const,
      logicalSessionId: event.conversationId,
      requestId: event.generationId,
      lineOrdinal,
      envelopeHash: "",
      occurredAt: event.occurredAt,
      sessionId: event.conversationId,
      turnId: event.generationId,
      projectId: null,
      rawProviderId: null,
      rawModelId,
      cwd: event.workspaceRoot,
      parentId: null,
      usage,
      context: {
        source: event.source,
        cursorVersion: event.cursorVersion,
        status: event.status,
        legacyModel: event.legacyModel,
        modelId: event.modelId,
        timestampConfidence: event.timestampConfidence,
        receivedAt: event.receivedAt,
      },
      qualityFlags: flags,
    };
    envelope.envelopeHash = hashEnvelope(envelope);
    return { kind: "usage", usage: { envelope: envelope as RawUsageEnvelope } };
  }
}

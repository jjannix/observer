import { basename } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import type { HarnessId, RawUsageEnvelope, TokenUsageRecord } from "@shared/contracts";
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

export const CODEX_ADAPTER_VERSION = "codex-1";

interface CodexCumulative {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number | null; // null when field omitted (older records)
  output_tokens: number;
  reasoning_output_tokens: number | null;
  total_tokens: number;
}

interface CodexParserState {
  sessionId: string | null;
  provider: string | null;
  cwd: string | null;
  currentModel: string | null;
  currentTurnId: string | null;
  prev: CodexCumulative | null;
}

function emptyState(): CodexParserState {
  return { sessionId: null, provider: null, cwd: null, currentModel: null, currentTurnId: null, prev: null };
}

/**
 * Codex collector.
 *
 * Computes per-request usage from deltas between successive
 * `total_token_usage` cumulative vectors. Equal cumulative vectors are
 * duplicate telemetry and emit no second event. Output deltas include
 * reasoning (reasoning stays a subset). Cache-write availability is honored.
 * total-only increases become unattributed tokens. Negative or non-monotonic
 * counters quarantine the event.
 */
export class CodexCollector implements Collector {
  readonly harness: HarnessId = "codex";
  readonly adapterVersion = CODEX_ADAPTER_VERSION;

  discover(root: string, _ctx: CollectorContext): DiscoveredFile[] {
    if (!existsSync(root)) return [];
    const out: DiscoveredFile[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = `${dir}/${name}`.replace(/\\/g, "/");
        let st: { isDirectory: () => boolean; isFile: () => boolean; size: number; mtimeMs: number };
        try {
          const s = statSync(full);
          st = { isDirectory: () => s.isDirectory(), isFile: () => s.isFile(), size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && (full.endsWith(".jsonl") || full.endsWith(".ndjson") || full.endsWith(".rollout"))) {
          const logicalSessionId = basename(full).replace(/\.(jsonl|ndjson|rollout)$/, "");
          out.push({ logicalSessionId, path: full, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    };
    walk(root);
    return out;
  }

  async collectFile(file: DiscoveredFile, opts: CollectFileOptions): Promise<CollectResult> {
    const state: CodexParserState = opts.parserState ? safeParseState(opts.parserState) : emptyState();
    if (!state.sessionId) state.sessionId = file.logicalSessionId;

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
      let rec: Record<string, any>;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        emits.push({
          kind: "quarantine",
          quarantine: { lineOrdinal: line.ordinal, reason: "malformed-json", partial: null },
        });
        continue;
      }

      applyMeta(rec, state);

      const payload = rec.payload ?? rec.event_msg?.payload;
      const tokenCount = extractTokenCount(rec, payload);
      if (!tokenCount) continue;

      const result = processTokenCount(tokenCount, line.ordinal, state, file.logicalSessionId, opts.ctx.sourceId);
      if (result) emits.push(result);
    }

    const schemaFingerprint = opts.byteCursor === 0
      ? await probeJsonlFingerprint(file.path, this.adapterVersion)
      : "";
    return {
      emits,
      byteCursor,
      lineCursor,
      parserState: JSON.stringify(state),
      schemaFingerprint,
      schemaChanged: false,
    };
  }
}

function applyMeta(rec: Record<string, any>, state: CodexParserState): void {
  const type = rec.type;
  if (type === "session_meta" || rec.session_meta) {
    const meta = rec.session_meta ?? rec;
    if (meta.model_provider) state.provider = meta.model_provider;
    if (meta.cwd) state.cwd = meta.cwd;
    if (meta.session_id) state.sessionId = meta.session_id;
    if (meta.model && !state.currentModel) state.currentModel = meta.model;
  } else if (type === "turn_context" || rec.turn_context) {
    const tc = rec.turn_context ?? rec;
    if (tc.model) state.currentModel = tc.model;
    if (tc.turn_id) state.currentTurnId = tc.turn_id;
    if (tc.cwd) state.cwd = tc.cwd;
  }
}

function extractTokenCount(rec: Record<string, any>, payload: any): CodexCumulative | null {
  let p = payload;
  if (!p && rec.type === "event_msg") p = rec.payload ?? rec;
  if (!p) return null;
  // Accept payload.type === "token_count" OR a flat token_count record.
  const pt = p.payload?.type ?? p.type;
  const isTokenCount = pt === "token_count" || rec.type === "token_count";
  if (!isTokenCount) return null;

  const usage = p.total_token_usage ?? p.usage ?? p.payload?.total_token_usage;
  if (!usage) return null;
  return {
    input_tokens: num(usage.input_tokens ?? usage.inputTokens ?? 0),
    cached_input_tokens: num(usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.cache_read_input_tokens ?? 0),
    cache_write_input_tokens: hasField(usage, "cache_write_input_tokens")
      ? num(usage.cache_write_input_tokens ?? 0)
      : null,
    output_tokens: num(usage.output_tokens ?? usage.outputTokens ?? 0),
    reasoning_output_tokens: hasField(usage, "reasoning_output_tokens")
      ? num(usage.reasoning_output_tokens ?? 0)
      : null,
    total_tokens: num(usage.total_tokens ?? usage.totalTokens ?? 0),
  };
}

function hasField(obj: Record<string, any>, key: string): boolean {
  return key in obj || camelOf(key) in obj;
}
function camelOf(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? Math.trunc(n as number) : 0;
}

function processTokenCount(
  cur: CodexCumulative,
  lineOrdinal: number,
  state: CodexParserState,
  logicalSessionId: string,
  _sourceId: string,
): CollectEmit | null {
  const prev = state.prev;

  // First observation: just seed the cursor, no delta event.
  if (!prev) {
    state.prev = cur;
    return null;
  }

  // Duplicate telemetry: identical cumulative vector → no second event.
  if (
    prev.input_tokens === cur.input_tokens &&
    prev.cached_input_tokens === cur.cached_input_tokens &&
    normalize(prev.cache_write_input_tokens) === normalize(cur.cache_write_input_tokens) &&
    prev.output_tokens === cur.output_tokens &&
    prev.total_tokens === cur.total_tokens
  ) {
    state.prev = cur;
    return { kind: "quarantine", quarantine: { lineOrdinal, reason: "duplicate-telemetry", partial: null } };
  }

  const deltaInput = cur.input_tokens - prev.input_tokens;
  const deltaCachedRead = cur.cached_input_tokens - prev.cached_input_tokens;
  const cacheWriteAvailable =
    prev.cache_write_input_tokens != null && cur.cache_write_input_tokens != null;
  const deltaCacheWrite = cacheWriteAvailable
    ? (cur.cache_write_input_tokens as number) - (prev.cache_write_input_tokens as number)
    : 0;
  const deltaOutput = cur.output_tokens - prev.output_tokens;
  const deltaTotal = cur.total_tokens - prev.total_tokens;

  // Negative components / non-monotonic cumulative counters → quarantine.
  const negatives =
    deltaInput < 0 ||
    deltaCachedRead < 0 ||
    deltaOutput < 0 ||
    deltaTotal < 0 ||
    (cacheWriteAvailable && deltaCacheWrite < 0);

  // Impossible cache relationship: cached-read delta cannot exceed input delta.
  const impossibleCache = deltaCachedRead > deltaInput + 1; // tolerance 1 for rounding

  if (negatives || impossibleCache) {
    state.prev = cur;
    return {
      kind: "quarantine",
      quarantine: {
        lineOrdinal,
        reason: negatives ? "non-monotonic-cumulative" : "impossible-cache-relationship",
        partial: null,
      },
    };
  }

  // Fresh input excludes cached read and cache write.
  const fresh = Math.max(0, deltaInput - deltaCachedRead - deltaCacheWrite);

  // Output delta includes reasoning; reasoning is a subset.
  const output = deltaOutput;
  const reasoning = cur.reasoning_output_tokens != null && prev.reasoning_output_tokens != null
    ? Math.max(0, cur.reasoning_output_tokens - prev.reasoning_output_tokens)
    : null;
  const reasoningAvailable = cur.reasoning_output_tokens != null && prev.reasoning_output_tokens != null;

  // Unattributed: total increased beyond input+output components.
  let unattributed = 0;
  if (deltaTotal > deltaInput + deltaOutput) {
    unattributed = deltaTotal - (deltaInput + deltaOutput);
  }

  const costAvailable = false;
  const usageRecord: TokenUsageRecord = {
    freshInputTokens: fresh,
    cacheReadInputTokens: deltaCachedRead,
    cacheWriteInputTokens: deltaCacheWrite,
    cacheWriteAvailable,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    reasoningAvailable,
    unattributedTokens: unattributed,
    costUsd: null,
    costAvailable,
  };

  const requestId = `${logicalSessionId}:${lineOrdinal}`;
  const occurredAt = new Date().toISOString();
  const envelope = {
    harness: "codex" as const,
    logicalSessionId,
    requestId,
    lineOrdinal,
    envelopeHash: "",
    occurredAt,
    sessionId: state.sessionId ?? logicalSessionId,
    turnId: state.currentTurnId,
    projectId: null,
    rawProviderId: state.provider,
    rawModelId: state.currentModel,
    cwd: state.cwd,
    parentId: null,
    usage: usageRecord,
    context: {
      cumulative: cur,
      previousCumulative: prev,
    },
  };
  envelope.envelopeHash = hashEnvelope(envelope);

  state.prev = cur;
  return { kind: "usage", usage: { envelope: envelope as RawUsageEnvelope } };
}

function normalize(v: number | null): number {
  return v ?? -999999; // distinct sentinel so absent vs present never compare equal
}

function safeParseState(raw: string): CodexParserState {
  try {
    const p = JSON.parse(raw);
    return {
      sessionId: p.sessionId ?? null,
      provider: p.provider ?? null,
      cwd: p.cwd ?? null,
      currentModel: p.currentModel ?? null,
      currentTurnId: p.currentTurnId ?? null,
      prev: p.prev ?? null,
    };
  } catch {
    return emptyState();
  }
}

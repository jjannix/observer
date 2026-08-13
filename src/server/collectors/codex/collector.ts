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

export const CODEX_ADAPTER_VERSION = "codex-2";

const FORK_COPY_BURST_MS = 1_000;

interface CodexUsageVector {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number | null;
  output_tokens: number;
  reasoning_output_tokens: number | null;
  total_tokens: number;
}

type CodexTokenCount =
  | { kind: "per-request"; usage: CodexUsageVector; cumulative: CodexUsageVector | null }
  | { kind: "cumulative"; usage: CodexUsageVector };

interface CodexParserState {
  sessionId: string | null;
  provider: string | null;
  cwd: string | null;
  currentModel: string | null;
  currentTurnId: string | null;
  prev: CodexUsageVector | null;
  lastPerRequestSignature: string | null;
  sawSessionMeta: boolean;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number | null;
}

function emptyState(): CodexParserState {
  return {
    sessionId: null,
    provider: null,
    cwd: null,
    currentModel: null,
    currentTurnId: null,
    prev: null,
    lastPerRequestSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: null,
  };
}

/**
 * Codex collector.
 *
 * Current Codex rollouts report each request in
 * `event_msg.payload.info.last_token_usage`. Older rollouts exposed only a
 * cumulative `total_token_usage` vector, which remains supported by taking
 * successive deltas. Forked and subagent rollouts can begin with a rapid copy
 * of their parent's telemetry; that initial burst is ignored until the first
 * one-second gap.
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
    const state = opts.parserState ? safeParseState(opts.parserState) : emptyState();
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
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        emits.push({
          kind: "quarantine",
          quarantine: { lineOrdinal: line.ordinal, reason: "malformed-json", partial: null },
        });
        continue;
      }

      applyMeta(rec, state);

      const eventMessage = asRecord(rec.event_msg);
      const payload = rec.payload ?? eventMessage?.payload;
      const tokenCount = extractTokenCount(rec, payload);
      if (!tokenCount) continue;

      const result = processTokenCount(
        tokenCount,
        line.ordinal,
        rec.timestamp,
        state,
        file.logicalSessionId,
      );
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

function applyMeta(rec: Record<string, unknown>, state: CodexParserState): void {
  const type = rec.type;
  if (type === "session_meta" || rec.session_meta) {
    const meta = asRecord(rec.session_meta) ?? asRecord(rec.payload) ?? rec;
    if (state.sawSessionMeta) return;

    state.sawSessionMeta = true;
    state.provider = stringValue(meta.model_provider) ?? state.provider;
    state.cwd = stringValue(meta.cwd) ?? state.cwd;
    state.sessionId = stringValue(meta.id) ?? stringValue(meta.session_id) ?? state.sessionId;
    state.currentModel = stringValue(meta.model) ?? state.currentModel;

    if (isForkedSessionMeta(meta)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = timestampMs(rec.timestamp);
    }
    return;
  }

  if (type === "turn_context" || rec.turn_context) {
    const turnContext = asRecord(rec.turn_context) ?? asRecord(rec.payload) ?? rec;
    state.currentModel = stringValue(turnContext.model) ?? state.currentModel;
    state.currentTurnId = stringValue(turnContext.turn_id) ?? state.currentTurnId;
    state.cwd = stringValue(turnContext.cwd) ?? state.cwd;
  }
}

function isForkedSessionMeta(meta: Record<string, unknown>): boolean {
  if (stringValue(meta.forked_from_id)) return true;
  const source = meta.source;
  if (source === "subagent" || source === "fork") return true;
  const sourceRecord = asRecord(source);
  return sourceRecord != null && ("subagent" in sourceRecord || "fork" in sourceRecord);
}

function extractTokenCount(rec: Record<string, unknown>, payload: unknown): CodexTokenCount | null {
  const p = asRecord(payload);
  if (!p) return null;

  const nestedPayload = asRecord(p.payload);
  const payloadType = nestedPayload?.type ?? p.type;
  if (payloadType !== "token_count" && rec.type !== "token_count") return null;

  const info = asRecord(p.info);
  const lastUsage = asRecord(info?.last_token_usage);
  if (lastUsage) {
    const totalUsage = asRecord(info?.total_token_usage);
    return {
      kind: "per-request",
      usage: parseUsageVector(lastUsage),
      cumulative: totalUsage ? parseUsageVector(totalUsage) : null,
    };
  }

  const cumulative =
    asRecord(p.total_token_usage) ??
    asRecord(p.usage) ??
    asRecord(nestedPayload?.total_token_usage);
  return cumulative ? { kind: "cumulative", usage: parseUsageVector(cumulative) } : null;
}

function parseUsageVector(usage: Record<string, unknown>): CodexUsageVector {
  return {
    input_tokens: num(usage.input_tokens ?? usage.inputTokens ?? 0),
    cached_input_tokens: num(
      usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.cache_read_input_tokens ?? 0,
    ),
    cache_write_input_tokens: hasField(usage, "cache_write_input_tokens")
      ? num(usage.cache_write_input_tokens ?? usage.cacheWriteInputTokens ?? 0)
      : null,
    output_tokens: num(usage.output_tokens ?? usage.outputTokens ?? 0),
    reasoning_output_tokens: hasField(usage, "reasoning_output_tokens")
      ? num(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens ?? 0)
      : null,
    total_tokens: num(usage.total_tokens ?? usage.totalTokens ?? 0),
  };
}

function hasField(obj: Record<string, unknown>, key: string): boolean {
  return key in obj || camelOf(key) in obj;
}

function camelOf(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function num(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function processTokenCount(
  tokenCount: CodexTokenCount,
  lineOrdinal: number,
  timestamp: unknown,
  state: CodexParserState,
  logicalSessionId: string,
): CollectEmit | null {
  const eventTimeMs = timestampMs(timestamp);
  if (shouldSuppressForkCopy(state, eventTimeMs)) {
    if (tokenCount.kind === "cumulative") state.prev = tokenCount.usage;
    else state.lastPerRequestSignature = perRequestSignature(tokenCount);
    return null;
  }

  if (tokenCount.kind === "per-request") {
    return processPerRequest(tokenCount, lineOrdinal, timestamp, state, logicalSessionId);
  }
  return processCumulative(tokenCount.usage, lineOrdinal, timestamp, state, logicalSessionId);
}

function shouldSuppressForkCopy(state: CodexParserState, eventTimeMs: number | null): boolean {
  if (!state.suppressingForkCopies) return false;
  if (eventTimeMs == null || state.forkCopyAnchorMs == null) {
    state.suppressingForkCopies = false;
    return false;
  }

  const gapMs = eventTimeMs - state.forkCopyAnchorMs;
  if (gapMs >= 0 && gapMs < FORK_COPY_BURST_MS) {
    state.forkCopyAnchorMs = eventTimeMs;
    return true;
  }

  state.suppressingForkCopies = false;
  return false;
}

function processPerRequest(
  tokenCount: Extract<CodexTokenCount, { kind: "per-request" }>,
  lineOrdinal: number,
  timestamp: unknown,
  state: CodexParserState,
  logicalSessionId: string,
): CollectEmit {
  const current = tokenCount.usage;
  const signature = perRequestSignature(tokenCount);
  if (state.lastPerRequestSignature === signature) {
    return duplicateTelemetry(lineOrdinal);
  }
  state.lastPerRequestSignature = signature;

  const cacheWrite = current.cache_write_input_tokens ?? 0;
  const reasoning = current.reasoning_output_tokens;
  const values = [
    current.input_tokens,
    current.cached_input_tokens,
    cacheWrite,
    current.output_tokens,
    current.total_tokens,
    ...(reasoning == null ? [] : [reasoning]),
  ];
  if (values.some((value) => value < 0)) {
    return quarantine(lineOrdinal, "negative-token-count");
  }
  if (current.cached_input_tokens + cacheWrite > current.input_tokens + 1) {
    return quarantine(lineOrdinal, "impossible-cache-relationship");
  }
  if (reasoning != null && reasoning > current.output_tokens + 1) {
    return quarantine(lineOrdinal, "impossible-reasoning-relationship");
  }
  if (current.total_tokens + 1 < current.input_tokens + current.output_tokens) {
    return quarantine(lineOrdinal, "impossible-total-relationship");
  }

  const usage: TokenUsageRecord = {
    freshInputTokens: Math.max(0, current.input_tokens - current.cached_input_tokens - cacheWrite),
    cacheReadInputTokens: current.cached_input_tokens,
    cacheWriteInputTokens: cacheWrite,
    cacheWriteAvailable: current.cache_write_input_tokens != null,
    outputTokens: current.output_tokens,
    reasoningOutputTokens: reasoning,
    reasoningAvailable: reasoning != null,
    unattributedTokens: Math.max(0, current.total_tokens - current.input_tokens - current.output_tokens),
    costUsd: null,
    costAvailable: false,
  };

  return usageEmit(usage, lineOrdinal, timestamp, state, logicalSessionId, {
    accountingMode: "per-request",
    usage: current,
    cumulative: tokenCount.cumulative,
  });
}

function processCumulative(
  current: CodexUsageVector,
  lineOrdinal: number,
  timestamp: unknown,
  state: CodexParserState,
  logicalSessionId: string,
): CollectEmit | null {
  const previous = state.prev;
  if (!previous) {
    state.prev = current;
    return null;
  }

  if (vectorSignature(previous) === vectorSignature(current)) {
    state.prev = current;
    return duplicateTelemetry(lineOrdinal);
  }

  const deltaInput = current.input_tokens - previous.input_tokens;
  const deltaCachedRead = current.cached_input_tokens - previous.cached_input_tokens;
  const cacheWriteAvailable =
    previous.cache_write_input_tokens != null && current.cache_write_input_tokens != null;
  const deltaCacheWrite = cacheWriteAvailable
    ? (current.cache_write_input_tokens as number) - (previous.cache_write_input_tokens as number)
    : 0;
  const deltaOutput = current.output_tokens - previous.output_tokens;
  const deltaTotal = current.total_tokens - previous.total_tokens;
  const reasoningAvailable =
    current.reasoning_output_tokens != null && previous.reasoning_output_tokens != null;
  const deltaReasoning = reasoningAvailable
    ? (current.reasoning_output_tokens as number) - (previous.reasoning_output_tokens as number)
    : null;

  const negatives =
    deltaInput < 0 ||
    deltaCachedRead < 0 ||
    deltaOutput < 0 ||
    deltaTotal < 0 ||
    (cacheWriteAvailable && deltaCacheWrite < 0) ||
    (deltaReasoning != null && deltaReasoning < 0);
  const impossibleCache = deltaCachedRead + deltaCacheWrite > deltaInput + 1;

  if (negatives || impossibleCache) {
    state.prev = current;
    return quarantine(
      lineOrdinal,
      negatives ? "non-monotonic-cumulative" : "impossible-cache-relationship",
    );
  }

  const usage: TokenUsageRecord = {
    freshInputTokens: Math.max(0, deltaInput - deltaCachedRead - deltaCacheWrite),
    cacheReadInputTokens: deltaCachedRead,
    cacheWriteInputTokens: deltaCacheWrite,
    cacheWriteAvailable,
    outputTokens: deltaOutput,
    reasoningOutputTokens: deltaReasoning,
    reasoningAvailable,
    unattributedTokens: Math.max(0, deltaTotal - deltaInput - deltaOutput),
    costUsd: null,
    costAvailable: false,
  };

  const emit = usageEmit(usage, lineOrdinal, timestamp, state, logicalSessionId, {
    accountingMode: "cumulative-delta",
    cumulative: current,
    previousCumulative: previous,
  });
  state.prev = current;
  return emit;
}

function usageEmit(
  usage: TokenUsageRecord,
  lineOrdinal: number,
  timestamp: unknown,
  state: CodexParserState,
  logicalSessionId: string,
  context: Record<string, unknown>,
): CollectEmit {
  const envelope = {
    harness: "codex" as const,
    logicalSessionId,
    requestId: `${logicalSessionId}:${lineOrdinal}`,
    lineOrdinal,
    envelopeHash: "",
    occurredAt: timestampIso(timestamp),
    sessionId: state.sessionId ?? logicalSessionId,
    turnId: state.currentTurnId,
    projectId: null,
    rawProviderId: state.provider,
    rawModelId: state.currentModel,
    cwd: state.cwd,
    parentId: null,
    usage,
    context,
  };
  envelope.envelopeHash = hashEnvelope(envelope);
  return { kind: "usage", usage: { envelope: envelope as RawUsageEnvelope } };
}

function duplicateTelemetry(lineOrdinal: number): CollectEmit {
  return quarantine(lineOrdinal, "duplicate-telemetry");
}

function quarantine(lineOrdinal: number, reason: string): CollectEmit {
  return { kind: "quarantine", quarantine: { lineOrdinal, reason, partial: null } };
}

function perRequestSignature(tokenCount: Extract<CodexTokenCount, { kind: "per-request" }>): string {
  return vectorSignature(tokenCount.usage);
}

function vectorSignature(vector: CodexUsageVector): string {
  return [
    vector.input_tokens,
    vector.cached_input_tokens,
    vector.cache_write_input_tokens ?? "missing",
    vector.output_tokens,
    vector.reasoning_output_tokens ?? "missing",
    vector.total_tokens,
  ].join(":");
}

function timestampIso(value: unknown): string {
  const milliseconds = timestampMs(value);
  return milliseconds == null ? new Date().toISOString() : new Date(milliseconds).toISOString();
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const milliseconds = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeParseState(raw: string): CodexParserState {
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return emptyState();
    return {
      sessionId: stringValue(parsed.sessionId),
      provider: stringValue(parsed.provider),
      cwd: stringValue(parsed.cwd),
      currentModel: stringValue(parsed.currentModel),
      currentTurnId: stringValue(parsed.currentTurnId),
      prev: asRecord(parsed.prev) as unknown as CodexUsageVector | null,
      lastPerRequestSignature: stringValue(parsed.lastPerRequestSignature),
      sawSessionMeta: parsed.sawSessionMeta === true,
      suppressingForkCopies: parsed.suppressingForkCopies === true,
      forkCopyAnchorMs: typeof parsed.forkCopyAnchorMs === "number" ? parsed.forkCopyAnchorMs : null,
    };
  } catch {
    return emptyState();
  }
}

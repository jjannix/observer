import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { RawUsageEnvelope, TokenUsageRecord } from "@shared/contracts";
import { hashEnvelope } from "../envelope.js";
import { probeJsonlFingerprint, readCompleteLines } from "../jsonl.js";
import type {
  CollectEmit,
  CollectFileOptions,
  CollectResult,
  Collector,
  CollectorContext,
  DiscoveredFile,
} from "../contract.js";

const CLAUDE_CODE_ADAPTER_VERSION = "claude-code-2";

interface MessageNode {
  parentId: string | null;
  role: string | null;
}

interface ClaudeCodeParserState {
  sessionId: string | null;
  cwd: string | null;
  nodes: Record<string, MessageNode>;
  responseSnapshots: Record<string, string>;
}

interface ParsedToken {
  value: number;
  present: boolean;
  valid: boolean;
}

function emptyState(): ClaudeCodeParserState {
  return { sessionId: null, cwd: null, nodes: {}, responseSnapshots: {} };
}

/**
 * Claude Code transcript collector.
 *
 * Claude Code persists transcripts below `~/.claude/projects` and records API
 * accounting on assistant messages. One API response can be written as several
 * assistant records (for example, one record per thinking/text/tool block), so
 * exact repeats are deduplicated by response identity while changed snapshots
 * supersede earlier usage for that response.
 *
 * The transcript schema is explicitly internal to Claude Code. Keeping this
 * adapter versioned lets Observer rebuild only this source when its parser is
 * updated for a future schema.
 */
export class ClaudeCodeCollector implements Collector {
  readonly harness = "claude-code" as const;
  readonly adapterVersion = CLAUDE_CODE_ADAPTER_VERSION;

  discover(root: string, _ctx: CollectorContext): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        try {
          const stat = statSync(path);
          files.push({
            logicalSessionId: logicalSessionId(root, path),
            path,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          // A transcript can disappear during Claude Code's retention sweep.
        }
      }
    };

    walk(root);
    return files;
  }

  async collectFile(file: DiscoveredFile, opts: CollectFileOptions): Promise<CollectResult> {
    const state = opts.parserState ? safeParseState(opts.parserState) : emptyState();
    const { lines, byteCursor, lineCursor } = await readCompleteLines(
      file.path,
      opts.byteCursor,
      opts.lineCursor,
      opts.maxLines,
    );
    const emits: CollectEmit[] = [];
    const responseEmitIndexes = new Map<string, number>();

    for (const line of lines) {
      const trimmed = line.text.trim();
      if (!trimmed) continue;

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        emits.push(quarantine(line.ordinal, "malformed-json"));
        continue;
      }

      applyMetadata(record, state);
      registerMessageNode(record, state, emits);
      if (record.type !== "assistant") continue;

      const message = asRecord(record.message);
      const usage = asRecord(message?.usage);
      if (!message || !usage || !hasTokenFields(usage)) continue;

      const messageId = stringValue(message.id);
      const providerRequestId = stringValue(record.requestId ?? record.request_id);
      const recordUuid = stringValue(record.uuid);
      const responseKey = messageId
        ? providerRequestId ? `${messageId}:${providerRequestId}` : messageId
        : providerRequestId ?? recordUuid;
      if (!responseKey) {
        emits.push(quarantine(line.ordinal, "missing-response-id"));
        continue;
      }

      const parsed = parseUsage(usage);
      if (!parsed) {
        emits.push(quarantine(line.ordinal, "invalid-token-count"));
        continue;
      }
      const snapshot = usageSnapshot(parsed);
      if (state.responseSnapshots[responseKey] === snapshot) {
        emits.push(duplicate(line.ordinal, "duplicate-telemetry"));
        continue;
      }
      state.responseSnapshots[responseKey] = snapshot;

      // Synthetic UI messages contain an all-zero usage object and do not
      // represent an API request.
      if (processedTokens(parsed.usage) === 0) continue;

      const sessionId = stringValue(record.sessionId ?? record.session_id) ?? state.sessionId ?? file.logicalSessionId;
      const occurredAt = isoTimestamp(record.timestamp, file.mtimeMs);
      const nodeId = recordUuid;
      const turnId = nodeId ? nearestUserAncestor(nodeId, state.nodes) : null;
      const model = stringValue(message.model);
      const envelope = {
        harness: "claude-code" as const,
        logicalSessionId: file.logicalSessionId,
        requestId: responseKey,
        lineOrdinal: line.ordinal,
        envelopeHash: "",
        occurredAt,
        sessionId,
        turnId,
        projectId: null,
        // The transcript identifies the model but not the delivery provider
        // (Anthropic, Bedrock, Vertex, Foundry, or a custom gateway).
        rawProviderId: null,
        rawModelId: model === "<synthetic>" ? null : model,
        cwd: stringValue(record.cwd) ?? state.cwd,
        parentId: stringValue(record.parentUuid ?? record.parent_uuid),
        usage: parsed.usage,
        context: {
          messageId,
          providerRequestId,
          recordUuid,
          querySource: record.isSidechain === true || record.agentId != null ? "subagent" : "main",
          serviceTier: stringValue(usage.service_tier),
          speed: stringValue(usage.speed),
          cacheCreation5mInputTokens: parsed.cacheCreation5m,
          cacheCreation1hInputTokens: parsed.cacheCreation1h,
        },
      };
      envelope.envelopeHash = hashEnvelope(envelope);
      const previousEmitIndex = responseEmitIndexes.get(responseKey);
      if (previousEmitIndex != null) {
        const previous = emits[previousEmitIndex];
        if (previous.kind === "usage") {
          emits[previousEmitIndex] = duplicate(previous.usage.envelope.lineOrdinal, "superseded-telemetry");
        }
      }
      responseEmitIndexes.set(responseKey, emits.length);
      emits.push({ kind: "usage", usage: { envelope: envelope as RawUsageEnvelope } });
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

function logicalSessionId(root: string, path: string): string {
  const relativeParts = relative(root, path).split(sep);
  const fileId = basename(path, ".jsonl");
  const subagentsAt = relativeParts.lastIndexOf("subagents");
  if (subagentsAt > 0) {
    return `${relativeParts[subagentsAt - 1]}:subagent:${fileId}`;
  }
  return fileId;
}

function applyMetadata(record: Record<string, unknown>, state: ClaudeCodeParserState): void {
  state.sessionId = stringValue(record.sessionId ?? record.session_id) ?? state.sessionId;
  state.cwd = stringValue(record.cwd) ?? state.cwd;
}

function registerMessageNode(
  record: Record<string, unknown>,
  state: ClaudeCodeParserState,
  emits: CollectEmit[],
): void {
  const nodeId = stringValue(record.uuid);
  if (!nodeId || state.nodes[nodeId]) return;
  const parentId = stringValue(record.parentUuid ?? record.parent_uuid);
  const message = asRecord(record.message);
  const role = stringValue(message?.role) ?? stringValue(record.type);
  state.nodes[nodeId] = { parentId, role };
  emits.push({ kind: "node", node: { nodeId, parentId, role, turnId: null } });
}

function parseUsage(usage: Record<string, unknown>): {
  usage: TokenUsageRecord;
  cacheCreation5m: number | null;
  cacheCreation1h: number | null;
} | null {
  const input = token(usage, "input_tokens");
  const output = token(usage, "output_tokens");
  const cacheRead = token(usage, "cache_read_input_tokens");
  const cacheCreation = token(usage, "cache_creation_input_tokens");
  const cacheBreakdown = asRecord(usage.cache_creation);
  const cacheCreation5m = cacheBreakdown ? token(cacheBreakdown, "ephemeral_5m_input_tokens") : null;
  const cacheCreation1h = cacheBreakdown ? token(cacheBreakdown, "ephemeral_1h_input_tokens") : null;

  const values = [input, output, cacheRead, cacheCreation, cacheCreation5m, cacheCreation1h]
    .filter((value): value is ParsedToken => value != null);
  if (values.some((value) => !value.valid)) return null;

  const hasBreakdown = Boolean(cacheCreation5m?.present || cacheCreation1h?.present);
  const cacheWrite = cacheCreation.present
    ? cacheCreation.value
    : (cacheCreation5m?.value ?? 0) + (cacheCreation1h?.value ?? 0);

  return {
    usage: {
      freshInputTokens: input.value,
      cacheReadInputTokens: cacheRead.value,
      cacheWriteInputTokens: cacheWrite,
      cacheWriteAvailable: cacheCreation.present || hasBreakdown,
      outputTokens: output.value,
      // Claude's output token total includes thinking; transcripts do not
      // provide a reliable separate reasoning-token count.
      reasoningOutputTokens: null,
      reasoningAvailable: false,
      unattributedTokens: 0,
      costUsd: null,
      costAvailable: false,
    },
    cacheCreation5m: cacheCreation5m?.present ? cacheCreation5m.value : null,
    cacheCreation1h: cacheCreation1h?.present ? cacheCreation1h.value : null,
  };
}

function token(record: Record<string, unknown>, key: string): ParsedToken {
  if (!(key in record)) return { value: 0, present: false, valid: true };
  const raw = record[key];
  const number = typeof raw === "string" && raw.trim().length > 0 ? Number(raw) : raw;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    return { value: 0, present: true, valid: false };
  }
  return { value: number, present: true, valid: true };
}

function usageSnapshot(parsed: NonNullable<ReturnType<typeof parseUsage>>): string {
  return JSON.stringify(parsed);
}

function hasTokenFields(usage: Record<string, unknown>): boolean {
  return [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_creation",
  ].some((key) => key in usage);
}

function processedTokens(usage: TokenUsageRecord): number {
  return usage.freshInputTokens + usage.cacheReadInputTokens + usage.cacheWriteInputTokens +
    usage.outputTokens + usage.unattributedTokens;
}

export function nearestUserAncestor(
  startId: string,
  nodes: Record<string, MessageNode>,
): string | null {
  let current: string | null = startId;
  const seen = new Set<string>();
  for (let i = 0; i < 4096; i++) {
    if (!current || seen.has(current)) return null;
    seen.add(current);
    const node: MessageNode | undefined = nodes[current];
    if (!node) return null;
    if ((node.role ?? "").toLowerCase() === "user") return current;
    current = node.parentId;
  }
  return null;
}

function quarantine(lineOrdinal: number, reason: string): CollectEmit {
  return { kind: "quarantine", quarantine: { lineOrdinal, reason, partial: null } };
}

function duplicate(lineOrdinal: number, reason: string): CollectEmit {
  return { kind: "duplicate", duplicate: { lineOrdinal, reason } };
}

function isoTimestamp(value: unknown, fallbackMtimeMs: number): string {
  const text = stringValue(value);
  if (text) {
    const time = Date.parse(text);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  const fallback = Number.isFinite(fallbackMtimeMs) && fallbackMtimeMs > 0 ? fallbackMtimeMs : 0;
  return new Date(fallback).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeParseState(raw: string): ClaudeCodeParserState {
  try {
    const parsed = JSON.parse(raw) as Partial<ClaudeCodeParserState>;
    return {
      sessionId: stringValue(parsed.sessionId),
      cwd: stringValue(parsed.cwd),
      nodes: asRecord(parsed.nodes) as Record<string, MessageNode> ?? {},
      responseSnapshots: stringRecord(parsed.responseSnapshots),
    };
  } catch {
    return emptyState();
  }
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

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
  MessageNodeEmit,
} from "../contract.js";
import { readCompleteLines, probeJsonlFingerprint } from "../jsonl.js";
import { hashEnvelope } from "../envelope.js";
import { QUALITY_FLAGS } from "@shared/contracts";

export const PI_ADAPTER_VERSION = "pi-1";

interface PiParserState {
  sessionHeaderId: string | null;
  cwd: string | null;
  nodes: Record<string, { parentId: string | null; role: string | null }>;
}

function emptyState(): PiParserState {
  return { sessionHeaderId: null, cwd: null, nodes: {} };
}

/**
 * Pi collector.
 *
 * - Stable request identity: session header id + record id.
 * - Output already includes reasoning (we never add reasoning again).
 * - cacheWrite1h is retained on the raw envelope but never added to processed
 *   input (observed to duplicate cacheWrite).
 * - Each request is attributed to the nearest human (user) ancestor via the
 *   parentId graph; tool-result nodes inherit their ancestor turn.
 * - Per-record model is preserved (no single "primary model").
 */
export class PiCollector implements Collector {
  readonly harness: HarnessId = "pi";
  readonly adapterVersion = PI_ADAPTER_VERSION;

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
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile() && (full.endsWith(".jsonl") || full.endsWith(".ndjson"))) {
          const logicalSessionId = basename(full).replace(/\.(jsonl|ndjson)$/, "");
          out.push({ logicalSessionId, path: full, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    };
    walk(root);
    return out;
  }

  async collectFile(file: DiscoveredFile, opts: CollectFileOptions): Promise<CollectResult> {
    const state: PiParserState = opts.parserState
      ? safeParseState(opts.parserState)
      : emptyState();

    const { lines, byteCursor, lineCursor } = await readCompleteLines(
      file.path,
      opts.byteCursor,
      opts.lineCursor,
      opts.maxLines,
    );

    const emits: CollectEmit[] = [];
    const nodeEmits: MessageNodeEmit[] = [];

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

      const type: string | undefined = rec.type;
      const recordId: string | undefined = rec.id ?? rec.uuid ?? rec.messageId;
      const parentId: string | null = rec.parentId ?? rec.parent_id ?? null;
      const role: string | null = rec.role ?? rec.message?.role ?? null;

      // Session header detection (heuristic: type header/session, or first record).
      if ((type === "header" || type === "session" || type === "session_header") && recordId) {
        if (!state.sessionHeaderId) state.sessionHeaderId = recordId;
        if (rec.cwd && !state.cwd) state.cwd = rec.cwd;
      }

      // Register every node that has an id so the graph is connected.
      if (recordId) {
        if (!state.nodes[recordId]) {
          state.nodes[recordId] = { parentId, role };
          nodeEmits.push({ nodeId: recordId, parentId, role, turnId: null });
        }
      }

      const usage = rec.usage ?? rec.message?.usage;
      if (usage && typeof usage === "object" && hasAnyToken(usage)) {
        const usageEmit = buildUsageEnvelope(rec, line.ordinal, state, opts.ctx.sourceId);
        if (usageEmit) emits.push({ kind: "usage", usage: { envelope: usageEmit } });
      }
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

function hasAnyToken(u: Record<string, any>): boolean {
  return (
    "input" in u || "output" in u || "totalTokens" in u || "total_tokens" in u ||
    "cacheRead" in u || "cacheWrite" in u
  );
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n as number)) : 0;
}

function optNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n as number)) : null;
}

function optFloat(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? Math.max(0, n as number) : null;
}

function buildUsageEnvelope(
  rec: Record<string, any>,
  lineOrdinal: number,
  state: PiParserState,
  _sourceId: string,
): RawUsageEnvelope | null {
  const usage = rec.usage ?? rec.message?.usage;
  const recordId: string = rec.id ?? rec.uuid ?? rec.messageId ?? `line-${lineOrdinal}`;
  const sessionHeaderId = state.sessionHeaderId ?? rec.sessionId ?? rec.session_id ?? "unknown";
  const requestId = `${sessionHeaderId}:${recordId}`;

  const message = rec.message ?? {};
  const rawProviderId: string | null = message.provider ?? rec.provider ?? null;
  const modelFromRec: string | null = message.model ?? rec.model ?? null;

  const freshInput = num(usage.input ?? usage.inputTokens ?? usage.input_tokens);
  const cacheRead = num(usage.cacheRead ?? usage.cache_read ?? usage.cachedInput ?? 0);
  const hasCacheWrite = usage.cacheWrite !== undefined || usage.cache_write !== undefined;
  const cacheWrite = num(usage.cacheWrite ?? usage.cache_write ?? 0);
  const output = num(usage.output ?? usage.outputTokens ?? usage.output_tokens ?? 0);
  const reasoning = optNum(usage.reasoning ?? usage.reasoningTokens ?? usage.reasoning_tokens);
  const totalTokens = optNum(usage.totalTokens ?? usage.total_tokens);
  const cost = optFloat(usage.cost?.total ?? usage.costTotal ?? usage.cost_total);

  const processedInput = freshInput + cacheRead + cacheWrite;
  // Pi: output already includes reasoning — do NOT add it again.
  const computedOutput = output;
  let unattributed = 0;
  if (totalTokens != null) {
    const sum = processedInput + computedOutput;
    unattributed = Math.max(0, totalTokens - sum);
  }

  const usageRecord: TokenUsageRecord = {
    freshInputTokens: freshInput,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    cacheWriteAvailable: hasCacheWrite,
    outputTokens: computedOutput,
    reasoningOutputTokens: reasoning,
    reasoningAvailable: reasoning != null,
    unattributedTokens: unattributed,
    costUsd: cost,
    costAvailable: cost != null,
  };

  // Turn attribution: nearest user ancestor via parentId graph.
  const turnNodeId = nearestUserAncestor(recordId, state.nodes);
  const turnId = turnNodeId;

  const occurredAt = rec.timestamp ?? rec.ts ?? rec.createdAt ?? rec.created_at ?? new Date().toISOString();
  const logicalSessionId = sessionHeaderId;

  const envelope = {
    harness: "pi" as const,
    logicalSessionId,
    requestId,
    lineOrdinal,
    envelopeHash: "",
    occurredAt,
    sessionId: logicalSessionId,
    turnId,
    projectId: null,
    rawProviderId,
    rawModelId: modelFromRec,
    cwd: rec.cwd ?? state.cwd ?? null,
    parentId: rec.parentId ?? rec.parent_id ?? null,
    usage: usageRecord,
    context: {
      // Whitelisted accounting context only — no prompts/code/tool I/O.
      sessionHeaderId,
      recordId,
      cacheWrite1h: usage.cacheWrite1h ?? null,
      totalTokens: totalTokens,
      role: rec.role ?? rec.message?.role ?? null,
    },
  };
  envelope.envelopeHash = hashEnvelope(envelope);
  return envelope;
}

/** Walk parentId chain to nearest node whose role is "user". */
export function nearestUserAncestor(
  startId: string,
  nodes: Record<string, { parentId: string | null; role: string | null }>,
): string | null {
  let current: string | null = startId;
  const seen = new Set<string>();
  for (let i = 0; i < 4096; i++) {
    if (!current) return null;
    if (seen.has(current)) return null; // cycle guard
    seen.add(current);
    const node: { parentId: string | null; role: string | null } | undefined = nodes[current];
    if (!node) return null;
    const role = (node.role ?? "").toLowerCase();
    if (role === "user" || role === "human") return current;
    current = node.parentId;
  }
  return null;
}

function safeParseState(raw: string): PiParserState {
  try {
    const p = JSON.parse(raw);
    return {
      sessionHeaderId: p.sessionHeaderId ?? null,
      cwd: p.cwd ?? null,
      nodes: p.nodes ?? {},
    };
  } catch {
    return emptyState();
  }
}

export const QUALITY = QUALITY_FLAGS;

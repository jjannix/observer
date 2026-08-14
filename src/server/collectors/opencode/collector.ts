import Database from "better-sqlite3";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { RawUsageEnvelope, TokenUsageRecord } from "@shared/contracts";
import { hashEnvelope } from "../envelope.js";
import { shapeSignature } from "../jsonl.js";
import type {
  CollectEmit,
  CollectFileOptions,
  CollectResult,
  Collector,
  CollectorContext,
  DiscoveredFile,
} from "../contract.js";

export const OPENCODE_ADAPTER_VERSION = "opencode-1";

interface MessageRow {
  rowid: number;
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
  session_directory: string | null;
  session_parent_id: string | null;
}

interface MessageNode {
  parentId: string | null;
  role: string | null;
}

interface OpenCodeParserState {
  /** Largest message.time_updated consumed so far (epoch ms watermark). */
  watermark: number;
  /** Row ids consumed exactly at the watermark (excluded on the next pass). */
  boundaryIds: string[];
  nodes: Record<string, MessageNode>;
  /** message id -> serialized usage snapshot (change + supersession detection). */
  snapshots: Record<string, string>;
}

interface ParsedToken {
  value: number;
  present: boolean;
  valid: boolean;
}

function emptyState(): OpenCodeParserState {
  return { watermark: 0, boundaryIds: [], nodes: {}, snapshots: {} };
}

/**
 * OpenCode collector.
 *
 * OpenCode (>= v1.0, verified against 1.18) persists sessions in a local
 * SQLite database (`opencode.db` in its XDG data directory) rather than
 * append-only JSONL transcripts. API accounting lives on assistant rows of
 * the `message` table: `tokens { input, output, reasoning, cache { read,
 * write }, total }`, `cost`, `providerID`, `modelID`, `path.cwd`, and a
 * `parentID` message graph.
 *
 * Contract mapping:
 * - `discover` surfaces the database file itself; size/mtime aggregate the
 *   `-wal`/`-shm` sidecars so change detection notices WAL growth between
 *   checkpoints.
 * - Rows are consumed through a `time_updated` watermark with tie exclusion
 *   (row ids at the watermark are held in parser state). OpenCode updates
 *   message rows while a response streams, so a re-delivered row with a
 *   changed usage snapshot supersedes the earlier version for the same
 *   request (message id), exactly like Claude Code's response snapshots.
 * - `byteCursor` stays 0: the SQLite cursor lives in parser state, and a
 *   byte offset must never mark the file fully consumed (the database can
 *   shrink on vacuum, which would deadlock a byte-based cursor).
 * - OpenCode's `output` excludes reasoning while the canonical `output`
 *   includes it (their own `total = input + cacheRead + output + reasoning`),
 *   so reasoning is folded into the emitted output and kept as a subset.
 */
export class OpenCodeCollector implements Collector {
  readonly harness = "opencode" as const;
  readonly adapterVersion = OPENCODE_ADAPTER_VERSION;

  discover(root: string, _ctx: CollectorContext): DiscoveredFile[] {
    const path = join(root, "opencode.db");
    let db;
    try {
      db = statSync(path);
    } catch {
      return [];
    }

    // WAL mode: committed writes land in the -wal sidecar until a checkpoint;
    // fold sidecars into the change-detection signature.
    let size = db.size;
    let mtimeMs = db.mtimeMs;
    for (const suffix of ["-wal", "-shm"]) {
      try {
        const sidecar = statSync(`${path}${suffix}`);
        size += sidecar.size;
        mtimeMs = Math.max(mtimeMs, sidecar.mtimeMs);
      } catch {
        // Sidecars exist only while the WAL is live.
      }
    }

    return [{ logicalSessionId: "opencode", path, size, mtimeMs }];
  }

  async collectFile(file: DiscoveredFile, opts: CollectFileOptions): Promise<CollectResult> {
    const state = opts.parserState ? safeParseState(opts.parserState) : emptyState();
    const limit = typeof opts.maxLines === "number" && opts.maxLines > 0 ? Math.floor(opts.maxLines) : -1;

    const db = openReadonly(file.path);
    try {
      const rows = fetchPendingRows(db, state, limit);
      const emits: CollectEmit[] = [];

      for (const row of rows) {
        const trimmed = row.data.trim();
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          emits.push(quarantine(row.rowid, "malformed-json"));
          continue;
        }

        const messageId = row.id;
        const parentId = stringValue(record.parentID);
        const role = stringValue(record.role);
        if (!state.nodes[messageId]) {
          state.nodes[messageId] = { parentId, role };
          emits.push({ kind: "node", node: { nodeId: messageId, parentId, role, turnId: null } });
        }

        if (role !== "assistant") continue;
        const tokens = asRecord(record.tokens);
        if (!tokens || !hasTokenFields(tokens)) continue;

        const parsed = parseUsage(tokens, record.cost);
        if (!parsed) {
          emits.push(quarantine(row.rowid, "invalid-token-count"));
          continue;
        }

        // Aborted or synthetic assistant rows carry an all-zero vector and do
        // not represent an API request.
        if (processedTokens(parsed.usage) === 0) continue;

        const snapshot = JSON.stringify(parsed.usage);
        if (state.snapshots[messageId] === snapshot) continue;
        state.snapshots[messageId] = snapshot;

        // Rows stream in time_updated order, which does not preserve graph
        // order — a parent can be updated after its child — so missing
        // ancestors are resolved from the database on demand.
        registerAncestors(parentId, state, db, emits);
        const turnId = nearestUserAncestor(messageId, state.nodes);

        const envelope = buildEnvelope(row, record, parsed.usage, turnId, file.mtimeMs);
        envelope.envelopeHash = hashEnvelope(envelope);
        emits.push({ kind: "usage", usage: { envelope } });
      }

      advanceWatermark(state, rows);

      const schemaFingerprint = opts.lineCursor === 0
        ? probeSqliteFingerprint(db, this.adapterVersion)
        : "";

      return {
        emits,
        byteCursor: 0,
        lineCursor: opts.lineCursor + rows.length,
        parserState: JSON.stringify(state),
        schemaFingerprint,
        schemaChanged: false,
      };
    } finally {
      db.close();
    }
  }
}

function openReadonly(path: string): Database.Database {
  try {
    return new Database(path, { readonly: true, fileMustExist: true, timeout: 5_000 });
  } catch (err) {
    throw new Error(
      `cannot open opencode database read-only: ${(err as Error).message} ` +
      `(opencode must have created the -shm sidecar for a live WAL, or checkpointed it)`,
    );
  }
}

function fetchPendingRows(db: Database.Database, state: OpenCodeParserState, limit: number): MessageRow[] {
  const boundary = state.boundaryIds;
  const tieClause = boundary.length > 0
    ? ` OR (m.time_updated = ? AND m.id NOT IN (${boundary.map(() => "?").join(",")}))`
    : "";
  const sql = `
    SELECT m.rowid AS rowid, m.id AS id, m.session_id AS session_id,
           m.time_created AS time_created, m.time_updated AS time_updated, m.data AS data,
           s.directory AS session_directory, s.parent_id AS session_parent_id
    FROM message m
    LEFT JOIN session s ON s.id = m.session_id
    WHERE m.time_updated > ?${tieClause}
    ORDER BY m.time_updated, m.id
    LIMIT ?
  `;
  const params: unknown[] = boundary.length > 0
    ? [state.watermark, state.watermark, ...boundary, limit]
    : [state.watermark, limit];
  return db.prepare(sql).all(...params) as unknown as MessageRow[];
}

function advanceWatermark(state: OpenCodeParserState, rows: MessageRow[]): void {
  if (rows.length === 0) return;
  const maxUpdated = rows[rows.length - 1].time_updated; // rows are ordered
  if (maxUpdated > state.watermark) {
    state.watermark = maxUpdated;
    state.boundaryIds = rows.filter((row) => row.time_updated === maxUpdated).map((row) => row.id);
    return;
  }
  // The batch stopped inside a tie group at the current watermark; remember
  // the consumed ids so the next pass resumes after them.
  const consumed = new Set(state.boundaryIds);
  for (const row of rows) {
    if (row.time_updated === state.watermark) consumed.add(row.id);
  }
  state.boundaryIds = [...consumed];
}

function buildEnvelope(
  row: MessageRow,
  record: Record<string, unknown>,
  usage: TokenUsageRecord,
  turnId: string | null,
  fallbackMtimeMs: number,
): RawUsageEnvelope {
  const path = asRecord(record.path);
  const time = asRecord(record.time);
  const sessionId = row.session_id;
  const nodeId = row.id;
  const sessionDirectory = stringValue(row.session_directory);

  return {
    harness: "opencode" as const,
    logicalSessionId: "opencode",
    requestId: nodeId,
    lineOrdinal: row.rowid,
    envelopeHash: "",
    occurredAt: isoTimestamp(time?.created ?? time?.completed ?? row.time_created, fallbackMtimeMs),
    sessionId,
    turnId,
    projectId: null,
    rawProviderId: stringValue(record.providerID),
    rawModelId: stringValue(record.modelID),
    cwd: stringValue(path?.cwd) ?? sessionDirectory,
    parentId: stringValue(record.parentID),
    usage,
    context: {
      messageId: nodeId,
      agent: stringValue(record.agent),
      mode: stringValue(record.mode),
      variant: stringValue(record.variant),
      finish: stringValue(record.finish),
      sessionDirectory,
      sessionParentId: stringValue(row.session_parent_id),
      querySource: row.session_parent_id != null ? "subagent" : "main",
      timeCompletedMs: time?.completed ?? null,
    },
  };
}

function parseUsage(
  tokens: Record<string, unknown>,
  rawCost: unknown,
): { usage: TokenUsageRecord } | null {
  const input = token(tokens, "input");
  const output = token(tokens, "output");
  const reasoning = optionalToken(tokens, "reasoning");
  const cache = asRecord(tokens.cache);
  const cacheRead = cache ? token(cache, "read") : { value: 0, present: false, valid: true };
  const cacheWrite = cache ? token(cache, "write") : { value: 0, present: false, valid: true };
  const total = optionalToken(tokens, "total");

  const values = [input, output, reasoning, cacheRead, cacheWrite, total]
    .filter((value): value is ParsedToken => value != null);
  if (values.some((value) => !value.valid)) return null;

  const cost = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : null;

  const freshInput = input.value;
  const cacheReadTokens = cacheRead.value;
  const cacheWriteTokens = cacheWrite.value;
  const outputTokens = output.value + (reasoning?.value ?? 0);

  let unattributed = 0;
  if (total?.present) {
    const sum = freshInput + cacheReadTokens + cacheWriteTokens + outputTokens;
    unattributed = Math.max(0, total.value - sum);
  }

  return {
    usage: {
      freshInputTokens: freshInput,
      cacheReadInputTokens: cacheReadTokens,
      cacheWriteInputTokens: cacheWriteTokens,
      cacheWriteAvailable: cacheWrite.present,
      outputTokens,
      reasoningOutputTokens: reasoning?.present ? reasoning.value : null,
      reasoningAvailable: reasoning?.present ?? false,
      unattributedTokens: unattributed,
      costUsd: cost,
      costAvailable: cost != null,
    },
  };
}

function hasTokenFields(tokens: Record<string, unknown>): boolean {
  return ["input", "output", "reasoning", "cache", "total"].some((key) => key in tokens);
}

function processedTokens(usage: TokenUsageRecord): number {
  return usage.freshInputTokens + usage.cacheReadInputTokens + usage.cacheWriteInputTokens +
    usage.outputTokens + usage.unattributedTokens;
}

/** Walk the parentID chain to the nearest node whose role is `user`. */
function nearestUserAncestor(
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

/**
 * Register ancestors of `fromId` on demand, continuing through already-known
 * nodes. Fetched nodes are emitted like streamed ones so the message-node
 * table stays complete; later consumption of the same row is skipped.
 */
function registerAncestors(
  fromId: string | null,
  state: OpenCodeParserState,
  db: Database.Database,
  emits: CollectEmit[],
): void {
  if (fromId == null) return;
  const select = db.prepare("SELECT id, data FROM message WHERE id = ?");
  const seen = new Set<string>();
  let current: string | null = fromId;
  for (let i = 0; i < 4096; i++) {
    if (current == null || seen.has(current)) return;
    seen.add(current);
    const known: MessageNode | undefined = state.nodes[current];
    if (known) {
      current = known.parentId;
      continue;
    }
    const found = select.get(current) as { id: string; data: string } | undefined;
    if (!found) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(found.data) as Record<string, unknown>;
    } catch {
      return;
    }
    const parentId = stringValue(record.parentID);
    const role = stringValue(record.role);
    state.nodes[current] = { parentId, role };
    emits.push({ kind: "node", node: { nodeId: current, parentId, role, turnId: null } });
    current = parentId;
  }
}

/** Best-effort schema fingerprint: structural signature of a message row. */
function probeSqliteFingerprint(db: Database.Database, adapterVersion: string): string {
  try {
    const row = db.prepare("SELECT data FROM message ORDER BY time_created LIMIT 1").get() as
      | { data: string }
      | undefined;
    const shape = row ? shapeSignature(JSON.parse(row.data)) : "empty";
    return djb2(`${adapterVersion}:${shape}`);
  } catch {
    return "unknown";
  }
}

function djb2(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

function token(record: Record<string, unknown>, key: string): ParsedToken {
  if (!(key in record)) return { value: 0, present: false, valid: true };
  return parseCount(record[key]);
}

function optionalToken(record: Record<string, unknown>, key: string): ParsedToken | null {
  if (!(key in record) || record[key] == null) return null;
  return parseCount(record[key]);
}

function parseCount(raw: unknown): ParsedToken {
  const number = typeof raw === "string" && raw.trim().length > 0 ? Number(raw) : raw;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    return { value: 0, present: true, valid: false };
  }
  return { value: number, present: true, valid: true };
}

function quarantine(lineOrdinal: number, reason: string): CollectEmit {
  return { kind: "quarantine", quarantine: { lineOrdinal, reason, partial: null } };
}

function isoTimestamp(value: unknown, fallbackMtimeMs: number): string {
  const ms = typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : Number.isFinite(fallbackMtimeMs) && fallbackMtimeMs > 0
      ? fallbackMtimeMs
      : 0;
  return new Date(ms).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeParseState(raw: string): OpenCodeParserState {
  try {
    const parsed = JSON.parse(raw) as Partial<OpenCodeParserState>;
    return {
      watermark: typeof parsed.watermark === "number" && Number.isFinite(parsed.watermark)
        ? parsed.watermark
        : 0,
      boundaryIds: Array.isArray(parsed.boundaryIds)
        ? parsed.boundaryIds.filter((id): id is string => typeof id === "string")
        : [],
      nodes: asRecord(parsed.nodes) as Record<string, MessageNode> ?? {},
      snapshots: stringRecord(parsed.snapshots),
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

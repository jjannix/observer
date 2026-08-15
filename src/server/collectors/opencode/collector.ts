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

export const OPENCODE_ADAPTER_VERSION = "opencode-3";

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

/** In-flight rowid sweep across the pending set (null once fully drained). */
interface SweepState {
  /** Exclusive lower rowid bound of the next window. */
  scanRowid: number;
  /** Largest time_updated consumed during this sweep (committed at drain). */
  maxUpdated: number;
  /** Row ids consumed exactly at `maxUpdated` (tie exclusion after commit). */
  boundaryIds: string[];
}

/** Database generation observed at the start of the last sweep. */
interface Generation {
  messageCount: number;
  maxUpdated: number;
}

/**
 * Upper bound on retained accounting-snapshot digests. The cache only
 * exists to skip re-delivered rows whose accounting did not change; an
 * evicted entry is at worst re-emitted once and collapsed by the engine's
 * envelope-hash dedupe (and supersession), so the bound trades a rare
 * duplicate row for constant parser-state size. Steady-state re-deliveries
 * are recent rows, which always sit inside the window.
 */
const SNAPSHOT_CACHE_CAP = 1024;

interface OpenCodeParserState {
  /** Largest message.time_updated consumed so far (epoch ms watermark). */
  watermark: number;
  /** Row ids consumed exactly at the watermark (excluded on the next pass). */
  boundaryIds: string[];
  /** Bounded FIFO of message id -> accounting-snapshot digest. */
  snapshots: Record<string, string>;
  /** Insertion order of `snapshots` keys for FIFO eviction. */
  snapshotOrder: string[];
  /** In-flight rowid sweep across the pending set (null once fully drained). */
  sweep: SweepState | null;
  /** Database generation observed at the start of the last sweep. */
  generation: Generation | null;
}

interface ParsedToken {
  value: number;
  present: boolean;
  valid: boolean;
}

function emptyState(): OpenCodeParserState {
  return { watermark: 0, boundaryIds: [], snapshots: {}, snapshotOrder: [], sweep: null, generation: null };
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
 * - `discover` surfaces the database file itself under the stable file
 *   identity "opencode"; the change signature folds in a non-empty `-wal`
 *   sidecar so change detection notices un-checkpointed writes. The `-shm`
 *   sidecar and empty `-wal` files are deliberately excluded: both are
 *   connection bookkeeping churned by every open — including Observer's own
 *   read-only connects — so folding them in would keep the signature
 *   permanently unstable and defeat the skip. Each emitted envelope instead
 *   carries the row's `session_id` as its logical session identity, so every
 *   OpenCode conversation becomes its own Observer session (the database
 *   file is a container, not a conversation).
 * - Pending rows are consumed through a `time_updated` watermark with tie
 *   exclusion. OpenCode only indexes `message` by (session_id, time_created,
 *   id), so filtering on `time_updated` cannot use an index: each window is
 *   therefore an `INTEGER PRIMARY KEY` range scan with the watermark filter
 *   applied in SQL — during a backfill this walks the table sequentially
 *   instead of re-running a full scan + sort per 500-row batch. OpenCode
 *   updates message rows while a response streams, so a re-delivered row
 *   with a changed accounting snapshot supersedes the earlier version for
 *   the same request (message id), exactly like Claude Code's response
 *   snapshots.
 * - `byteCursor` reports the discovered file size once the pending set is
 *   fully drained (and 0 while windows remain), letting the engine's
 *   size/mtime signature short-circuit unchanged databases. It never
 *   advances past what was actually drained, and the engine re-reads from
 *   the start when the file shrinks below the cursor (SQLite vacuum), so a
 *   shrinking database cannot deadlock collection.
 * - Parser state is strictly bounded: the watermark, its tie-exclusion ids,
 *   the in-flight sweep cursor, and a FIFO-capped cache of recent
 *   accounting-snapshot digests. The message graph is never retained —
 *   turn attribution walks the parentID chain directly in the source
 *   database (`message.id` is the text primary key, so each step is a point
 *   lookup that terminates at the nearest user message). Serialized state
 *   therefore stays constant-sized no matter how large the database is,
 *   keeping backfills linear instead of quadratic.
 * - At the start of each sweep a cheap generation probe (row count + max
 *   `time_updated`) validates the database identity. A replaced or restored
 *   database (backup restore, migration, recreation) rolls count or max
 *   timestamp backwards; the parser state is reset so older rows re-import
 *   instead of being skipped by a stale watermark forever.
 * - OpenCode's `output` excludes reasoning while the canonical `output`
 *   includes it (their `total = input + cacheRead + output + reasoning`),
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
    // fold it into the change-detection signature. The -shm sidecar is
    // excluded on purpose: every connection (including this collector's own
    // read-only opens) rewrites its lock state, so it carries no stable
    // change signal — only churn that would defeat the skip. An empty -wal
    // (which read-only connections create) holds no committed frames and is
    // likewise ignored, so the collector's own reads never disturb the
    // signature.
    let size = db.size;
    let mtimeMs = db.mtimeMs;
    try {
      const wal = statSync(`${path}-wal`);
      if (wal.size > 0) {
        size += wal.size;
        mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
      }
    } catch {
      // No live WAL: everything is checkpointed into the main file.
    }

    return [{ logicalSessionId: "opencode", path, size, mtimeMs }];
  }

  async collectFile(file: DiscoveredFile, opts: CollectFileOptions): Promise<CollectResult> {
    let state = opts.parserState ? safeParseState(opts.parserState) : emptyState();
    const limit = typeof opts.maxLines === "number" && opts.maxLines > 0 ? Math.floor(opts.maxLines) : -1;

    const db = openReadonly(file.path);
    try {
      if (!state.sweep) {
        // A fresh sweep starts by validating the database generation: a
        // replaced/restored database (count or max timestamp rolled back)
        // resets the watermark so older rows re-import.
        const generation = probeGeneration(db);
        if (
          state.generation &&
          generation &&
          (generation.messageCount < state.generation.messageCount ||
            generation.maxUpdated < state.generation.maxUpdated)
        ) {
          state = emptyState();
        }
        if (generation) state.generation = generation;
        state.sweep = {
          scanRowid: 0,
          maxUpdated: state.watermark,
          boundaryIds: [...state.boundaryIds],
        };
      }

      const rows = fetchPendingRows(db, state, limit);
      const emits: CollectEmit[] = [];
      // Node emits are deduped within a batch; the engine's node upsert is
      // idempotent, so re-emitting a node across batches is harmless.
      const emittedNodes = new Set<string>();

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
        if (!emittedNodes.has(messageId)) {
          emittedNodes.add(messageId);
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

        const digest = snapshotDigest(accountingSnapshot(row, record, parsed.usage));
        if (state.snapshots[messageId] === digest) continue;
        rememberSnapshot(state, messageId, digest);

        // Windows arrive in rowid order, which does not preserve graph
        // order — a parent can be updated after its child — so the nearest
        // user ancestor is resolved from the database on demand.
        const turnId = resolveTurn(parentId, db, emits, emittedNodes);

        const envelope = buildEnvelope(row, record, parsed.usage, turnId, file.mtimeMs);
        envelope.envelopeHash = hashEnvelope(envelope);
        emits.push({ kind: "usage", usage: { envelope } });
      }

      advanceSweep(state.sweep, rows);

      // A window shorter than the limit means the sweep reached the end of
      // the table: commit the watermark and let the engine's signature skip
      // the file until the database changes again.
      const drained = limit < 0 || rows.length < limit;
      if (drained) {
        state.watermark = state.sweep.maxUpdated;
        state.boundaryIds = state.sweep.boundaryIds;
        state.sweep = null;
      }

      const schemaFingerprint = opts.lineCursor === 0
        ? probeSqliteFingerprint(db, this.adapterVersion)
        : "";

      return {
        emits,
        byteCursor: drained ? file.size : 0,
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

/**
 * Fetch the next pending window in rowid order. The watermark/tie filter is
 * frozen for the duration of a sweep; `rowid >` keeps each window an
 * efficient primary-key range seek instead of a full scan + sort.
 */
function fetchPendingRows(db: Database.Database, state: OpenCodeParserState, limit: number): MessageRow[] {
  const sweep = state.sweep as SweepState;
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
    WHERE m.rowid > ? AND (m.time_updated > ?${tieClause})
    ORDER BY m.rowid
    LIMIT ?
  `;
  const params: unknown[] = boundary.length > 0
    ? [sweep.scanRowid, state.watermark, state.watermark, ...boundary, limit]
    : [sweep.scanRowid, state.watermark, limit];
  return db.prepare(sql).all(...params) as unknown as MessageRow[];
}

/** Fold a consumed window into the sweep cursor and candidate watermark. */
function advanceSweep(sweep: SweepState, rows: MessageRow[]): void {
  for (const row of rows) {
    if (row.time_updated > sweep.maxUpdated) {
      sweep.maxUpdated = row.time_updated;
      sweep.boundaryIds = [row.id];
    } else if (row.time_updated === sweep.maxUpdated) {
      sweep.boundaryIds.push(row.id);
    }
  }
  if (rows.length > 0) sweep.scanRowid = rows[rows.length - 1].rowid;
}

/**
 * Cheap generation fingerprint of the whole table: row count + max
 * time_updated. Returns null when the table cannot be probed.
 */
function probeGeneration(db: Database.Database): Generation | null {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS messageCount, MAX(time_updated) AS maxUpdated FROM message")
      .get() as { messageCount: number; maxUpdated: number | null } | undefined;
    if (!row) return null;
    return { messageCount: row.messageCount ?? 0, maxUpdated: row.maxUpdated ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Serialize every envelope-relevant accounting field of a row: usage (which
 * carries cost), provider, model, timestamps, cwd, and parent/session
 * attribution. A row re-delivered with any of these changed must supersede
 * the earlier version; only non-accounting context (finish, mode, ...) is
 * intentionally excluded.
 */
function accountingSnapshot(
  row: MessageRow,
  record: Record<string, unknown>,
  usage: TokenUsageRecord,
): string {
  const time = asRecord(record.time);
  return JSON.stringify({
    usage,
    providerId: stringValue(record.providerID),
    modelId: stringValue(record.modelID),
    parentId: stringValue(record.parentID),
    cwd: stringValue(asRecord(record.path)?.cwd),
    sessionDirectory: row.session_directory,
    sessionParentId: row.session_parent_id,
    timeCreated: time?.created ?? null,
    timeCompleted: time?.completed ?? null,
  });
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
    logicalSessionId: sessionId,
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

/**
 * Resolve the nearest user ancestor of `parentId` by walking the parentID
 * chain directly in the source database. `message.id` is the text primary
 * key, so every step is an indexed point lookup, and the walk stops at the
 * nearest user message, so chains stay short. Ancestors fetched along the
 * way are emitted (deduped per batch) so the message-node table stays
 * complete without retaining the graph in parser state. Returns null when
 * the chain is missing, cyclic, or has no user ancestor within the depth
 * limit.
 */
function resolveTurn(
  parentId: string | null,
  db: Database.Database,
  emits: CollectEmit[],
  emittedNodes: Set<string>,
): string | null {
  if (parentId == null) return null;
  const select = db.prepare("SELECT data FROM message WHERE id = ?");
  const seen = new Set<string>();
  let current: string | null = parentId;
  for (let i = 0; i < 4096; i++) {
    if (current == null || seen.has(current)) return null;
    seen.add(current);
    const found = select.get(current) as { data: string } | undefined;
    if (!found) return null;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(found.data) as Record<string, unknown>;
    } catch {
      return null;
    }
    const parent = stringValue(record.parentID);
    const role = stringValue(record.role);
    if (!emittedNodes.has(current)) {
      emittedNodes.add(current);
      emits.push({ kind: "node", node: { nodeId: current, parentId: parent, role, turnId: null } });
    }
    if ((role ?? "").toLowerCase() === "user") return current;
    current = parent;
  }
  return null;
}

/**
 * Record an accounting-snapshot digest in the bounded FIFO cache, evicting
 * the oldest entries beyond `SNAPSHOT_CACHE_CAP`.
 */
function rememberSnapshot(state: OpenCodeParserState, messageId: string, digest: string): void {
  if (!(messageId in state.snapshots)) state.snapshotOrder.push(messageId);
  state.snapshots[messageId] = digest;
  while (state.snapshotOrder.length > SNAPSHOT_CACHE_CAP) {
    const oldest = state.snapshotOrder.shift();
    if (oldest === undefined) break;
    delete state.snapshots[oldest];
  }
}

/**
 * Compact fixed-size digest of an accounting snapshot (two independent
 * 32-bit hashes rendered as 16 hex chars). Equality-preserving and cheap to
 * retain en masse; collision odds across a cap-bounded cache are negligible,
 * and a collision would only defer one superseding emit to the next change.
 */
function snapshotDigest(text: string): string {
  let djb2 = 5381;
  let sdbm = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    djb2 = ((djb2 << 5) + djb2 + c) >>> 0;
    sdbm = (c + (sdbm << 6) + (sdbm << 16) - sdbm) >>> 0;
  }
  return djb2.toString(16).padStart(8, "0") + sdbm.toString(16).padStart(8, "0");
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
    const snapshots = stringRecord(parsed.snapshots);
    // Insertion order for FIFO eviction: fall back to key order when a
    // legacy state (pre opencode-3) carried no explicit order.
    const rawOrder = Array.isArray(parsed.snapshotOrder)
      ? parsed.snapshotOrder.filter((id): id is string => typeof id === "string")
      : Object.keys(snapshots);
    const snapshotOrder: string[] = [];
    const seen = new Set<string>();
    for (const id of rawOrder) {
      if (id in snapshots && !seen.has(id)) {
        seen.add(id);
        snapshotOrder.push(id);
      }
    }
    for (const key of Object.keys(snapshots)) {
      if (!seen.has(key)) {
        seen.add(key);
        snapshotOrder.push(key);
      }
    }
    // A legacy state may exceed the cap (full snapshot strings); trim it on
    // load so the very next serialization is already bounded.
    while (snapshotOrder.length > SNAPSHOT_CACHE_CAP) {
      const oldest = snapshotOrder.shift();
      if (oldest === undefined) break;
      delete snapshots[oldest];
    }
    return {
      watermark: typeof parsed.watermark === "number" && Number.isFinite(parsed.watermark)
        ? parsed.watermark
        : 0,
      boundaryIds: Array.isArray(parsed.boundaryIds)
        ? parsed.boundaryIds.filter((id): id is string => typeof id === "string")
        : [],
      snapshots,
      snapshotOrder,
      sweep: parseSweep(parsed.sweep),
      generation: parseGeneration(parsed.generation),
    };
  } catch {
    return emptyState();
  }
}

function parseSweep(value: unknown): SweepState | null {
  const sweep = asRecord(value);
  if (!sweep) return null;
  const scanRowid = typeof sweep.scanRowid === "number" && Number.isFinite(sweep.scanRowid)
    ? sweep.scanRowid
    : null;
  const maxUpdated = typeof sweep.maxUpdated === "number" && Number.isFinite(sweep.maxUpdated)
    ? sweep.maxUpdated
    : null;
  const boundaryIds = Array.isArray(sweep.boundaryIds)
    ? sweep.boundaryIds.filter((id): id is string => typeof id === "string")
    : null;
  if (scanRowid == null || maxUpdated == null || boundaryIds == null) return null;
  return { scanRowid, maxUpdated, boundaryIds };
}

function parseGeneration(value: unknown): Generation | null {
  const generation = asRecord(value);
  if (!generation) return null;
  const messageCount = typeof generation.messageCount === "number" && Number.isFinite(generation.messageCount)
    ? generation.messageCount
    : null;
  const maxUpdated = typeof generation.maxUpdated === "number" && Number.isFinite(generation.maxUpdated)
    ? generation.maxUpdated
    : null;
  if (messageCount == null || maxUpdated == null) return null;
  return { messageCount, maxUpdated };
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

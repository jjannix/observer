import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURSOR_EVENT_SCHEMA, safeCursorToken, type CursorUsageEventV1 } from "./event.js";

// Legacy-only backfill. Cursor 3.16.17 stores no usable accounting for new
// prompts in its SQLite state, so this materializes only historical bubbles
// that carry a positive tokenCount plus a usageUuid. Values are parsed
// transiently and reduced to allowlisted fields before anything else happens;
// prompt/tool fields never leave the parse call. Output is one deterministic,
// immutable sanitized event file in Observer's spool — repeated runs rewrite
// identical content, and envelope-hash dedupe keeps re-imports idempotent.

const BACKFILL_FILE_NAME = "legacy.jsonl";
const BUBBLE_KEY_PREFIX = "bubbleId:";
// 'bubbleId;' is the lexicographic successor of every 'bubbleId:*' key.
const BUBBLE_KEY_END = "bubbleId;";
const SCAN_WINDOW = 500;

export interface BackfillArgs {
  /** %APPDATA%\Cursor\User\globalStorage\state.vscdb */
  globalDbPath: string;
  /** %APPDATA%\Cursor\User\workspaceStorage */
  workspaceStorageDir: string;
  /** Observer spool root (…/cursor/spool). */
  spoolRoot: string;
  receivedAt?: string;
}

export interface BackfillSummary {
  status: "completed" | "no-database" | "no-table";
  bubblesScanned: number;
  positiveBubbles: number;
  uniqueIdentities: number;
  imported: number;
  quarantinedIdentities: number;
  eventsWithExactTimestamp: number;
  outputFile: string | null;
}

interface BubbleSnapshot {
  composerId: string;
  bubbleId: string;
  usageUuid: string;
  inputTokens: number;
  outputTokens: number;
  timeMs: number | null;
}

function openReadonly(path: string): Database.Database | null {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 2_000 });
    db.pragma("query_only = true");
    db.pragma("busy_timeout = 2000");
    return db;
  } catch {
    return null;
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return row != null;
}

/**
 * Range-scan every `bubbleId:<composerId>:<bubbleId>` key through the key
 * index (never the rowid), reducing each value to an allowlisted snapshot.
 * The full value object is discarded inside the loop.
 */
function scanBubbles(db: Database.Database): { snapshots: BubbleSnapshot[]; scanned: number } {
  const select = db.prepare(
    `SELECT [key] AS k, value AS v FROM cursorDiskKV
      WHERE [key] >= ? AND [key] < ? AND [key] > ?
      ORDER BY [key]
      LIMIT ?`,
  );
  const snapshots: BubbleSnapshot[] = [];
  let scanned = 0;
  let cursorKey = BUBBLE_KEY_PREFIX;
  for (;;) {
    const rows = select.all(BUBBLE_KEY_PREFIX, BUBBLE_KEY_END, cursorKey, SCAN_WINDOW) as Array<
      { k: string; v: unknown }
    >;
    for (const row of rows) {
      cursorKey = row.k;
      scanned += 1;
      const parts = row.k.split(":");
      if (parts.length !== 3) continue;
      const [, composerId, bubbleId] = parts;
      if (!composerId || !bubbleId) continue;

      let value: unknown;
      try {
        value = JSON.parse(typeof row.v === "string" ? row.v : String(row.v));
      } catch {
        continue;
      }
      if (value == null || typeof value !== "object" || Array.isArray(value)) continue;
      const rec = value as Record<string, unknown>;

      const usageUuid = typeof rec.usageUuid === "string" ? rec.usageUuid : null;
      const tokenCount = rec.tokenCount;
      if (!usageUuid || tokenCount == null || typeof tokenCount !== "object") continue;

      const inputTokens = safeCursorToken((tokenCount as Record<string, unknown>).inputTokens);
      const outputTokens = safeCursorToken((tokenCount as Record<string, unknown>).outputTokens);
      if (inputTokens == null || outputTokens == null) continue;
      // Import only positive accounting; all-zero rows (Cursor 3.16.17's new
      // prompt storage) are not recoverable and must not become zero usage.
      if (inputTokens + outputTokens <= 0) continue;

      const timing = rec.timingInfo;
      const timeMs =
        timing != null && typeof timing === "object" && !Array.isArray(timing) &&
        typeof (timing as Record<string, unknown>).clientRpcSendTime === "number" &&
        Number.isFinite((timing as Record<string, unknown>).clientRpcSendTime as number)
          ? (timing as Record<string, unknown>).clientRpcSendTime as number
          : null;

      snapshots.push({ composerId, bubbleId, usageUuid, inputTokens, outputTokens, timeMs });
    }
    if (rows.length < SCAN_WINDOW) break;
  }
  return { snapshots, scanned };
}

/**
 * Resolve duplicate snapshots for one usageUuid. Prefer the final occurrence
 * in time order; fall back to component-wise monotonicity (keep the larger);
 * quarantine the identity when neither applies.
 */
function resolveDuplicates(group: BubbleSnapshot[]): BubbleSnapshot | null {
  if (group.length === 1) return group[0];
  const vectors = new Set(group.map((s) => `${s.inputTokens}:${s.outputTokens}`));
  if (vectors.size === 1) return group[group.length - 1];

  if (group.every((s) => s.timeMs != null)) {
    const ordered = [...group].sort((a, b) => (a.timeMs as number) - (b.timeMs as number));
    const monotonic = ordered.every(
      (s, i) => i === 0 || (s.inputTokens >= ordered[i - 1].inputTokens && s.outputTokens >= ordered[i - 1].outputTokens),
    );
    return monotonic ? ordered[ordered.length - 1] : null;
  }

  const byMagnitude = [...group].sort((a, b) => a.inputTokens - b.inputTokens || a.outputTokens - b.outputTokens);
  const monotonic = byMagnitude.every(
    (s, i) => i === 0 || (s.inputTokens >= byMagnitude[i - 1].inputTokens && s.outputTokens >= byMagnitude[i - 1].outputTokens),
  );
  return monotonic ? byMagnitude[byMagnitude.length - 1] : null;
}

/** composerId -> workspace folder path, through composer + workspaceStorage. */
function buildWorkspaceMap(
  db: Database.Database,
  workspaceStorageDir: string,
): Map<string, { createdAtMs: number | null; folder: string | null }> {
  const map = new Map<string, { createdAtMs: number | null; folder: string | null }>();

  if (tableExists(db, "composerHeaders")) {
    const rows = db
      .prepare("SELECT composerId, workspaceId, createdAt FROM composerHeaders")
      .all() as Array<{ composerId: string; workspaceId: string; createdAt: number | null }>;
    for (const row of rows) {
      const folder = readWorkspaceFolder(workspaceStorageDir, row.workspaceId);
      map.set(row.composerId, { createdAtMs: row.createdAt, folder });
    }
  }

  // Conversations without a header row still get an approximate timestamp
  // when composerData carries one.
  if (tableExists(db, "cursorDiskKV")) {
    const composers = db
      .prepare(
        `SELECT [key] AS k, value AS v FROM cursorDiskKV
          WHERE [key] >= 'composerData:' AND [key] < 'composerData;'`,
      )
      .all() as Array<{ k: string; v: unknown }>;
    for (const row of composers) {
      const composerId = row.k.slice("composerData:".length);
      if (map.has(composerId)) continue;
      try {
        const value = JSON.parse(typeof row.v === "string" ? row.v : String(row.v));
        if (value == null || typeof value !== "object") continue;
        const createdAt = (value as Record<string, unknown>).createdAt;
        map.set(composerId, {
          createdAtMs: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : null,
          folder: null,
        });
      } catch {
        map.set(composerId, { createdAtMs: null, folder: null });
      }
    }
  }

  return map;
}

function readWorkspaceFolder(workspaceStorageDir: string, workspaceId: string): string | null {
  if (!workspaceId || workspaceId === "empty-window") return null;
  const manifest = join(workspaceStorageDir, workspaceId, "workspace.json");
  if (!existsSync(manifest)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { folder?: unknown };
    if (typeof parsed.folder !== "string") return null;
    return decodeFileUri(parsed.folder);
  } catch {
    return null;
  }
}

function decodeFileUri(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(uri).pathname);
    } catch {
      pathname = decodeURIComponent(uri.replace(/^file:\/\//, ""));
    }
    return pathname.replace(/^\/([A-Za-z]):/, "$1:").replace(/\\/g, "/") || null;
  } catch {
    return null;
  }
}

export function runLegacyBackfill(args: BackfillArgs): BackfillSummary {
  const receivedAt = args.receivedAt ?? new Date().toISOString();
  const empty: BackfillSummary = {
    status: "no-database",
    bubblesScanned: 0,
    positiveBubbles: 0,
    uniqueIdentities: 0,
    imported: 0,
    quarantinedIdentities: 0,
    eventsWithExactTimestamp: 0,
    outputFile: null,
  };

  const db = openReadonly(args.globalDbPath);
  if (!db) return empty;
  try {
    if (!tableExists(db, "cursorDiskKV")) return { ...empty, status: "no-table" };

    const { snapshots, scanned } = scanBubbles(db);
    const workspaces = buildWorkspaceMap(db, args.workspaceStorageDir);

    const byIdentity = new Map<string, BubbleSnapshot[]>();
    for (const snapshot of snapshots) {
      const arr = byIdentity.get(snapshot.usageUuid) ?? [];
      arr.push(snapshot);
      byIdentity.set(snapshot.usageUuid, arr);
    }

    const events: CursorUsageEventV1[] = [];
    let quarantinedIdentities = 0;
    let exactTimestamps = 0;

    for (const [usageUuid, group] of byIdentity) {
      const chosen = resolveDuplicates(group);
      if (!chosen) {
        quarantinedIdentities += 1;
        continue;
      }
      const workspace = workspaces.get(chosen.composerId);
      const conversationTimeMs = workspace?.createdAtMs ?? null;
      const timeMs = chosen.timeMs ?? conversationTimeMs;
      const exact = chosen.timeMs != null;
      if (exact) exactTimestamps += 1;

      events.push({
        schema: CURSOR_EVENT_SCHEMA,
        source: "legacy-backfill",
        receivedAt,
        conversationId: chosen.composerId,
        generationId: usageUuid,
        cursorVersion: null,
        // Legacy bubbles carry no model; the conversation's current model is
        // deliberately never applied retroactively.
        modelId: null,
        legacyModel: null,
        workspaceRoot: workspace?.folder ?? null,
        status: null,
        inputTokens: chosen.inputTokens,
        outputTokens: chosen.outputTokens,
        // Legacy storage has no cache/reasoning/cost split — input is a
        // processed-input total, flagged as partial accounting downstream.
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        occurredAt: new Date(timeMs ?? Date.parse(receivedAt)).toISOString(),
        timestampConfidence: timeMs != null ? (exact ? "exact" : "approximate") : "approximate",
      });
    }

    events.sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.generationId.localeCompare(b.generationId),
    );

    const outDir = join(args.spoolRoot, "backfill", "import");
    mkdirSync(outDir, { recursive: true });
    const finalPath = join(outDir, BACKFILL_FILE_NAME);
    const tmpPath = `${finalPath}.tmp-${process.pid}`;
    writeFileSync(
      tmpPath,
      events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : ""),
      "utf8",
    );
    renameSync(tmpPath, finalPath);

    return {
      status: "completed",
      bubblesScanned: scanned,
      positiveBubbles: snapshots.length,
      uniqueIdentities: byIdentity.size,
      imported: events.length,
      quarantinedIdentities,
      eventsWithExactTimestamp: exactTimestamps,
      outputFile: finalPath,
    };
  } finally {
    db.close();
  }
}

export function defaultBackfillArgs(spoolRoot: string): BackfillArgs {
  const appData = process.env.APPDATA ?? "";
  const userDir = join(appData, "Cursor", "User");
  return {
    globalDbPath: join(userDir, "globalStorage", "state.vscdb"),
    workspaceStorageDir: join(userDir, "workspaceStorage"),
    spoolRoot,
  };
}

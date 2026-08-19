import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cursorUserDir } from "../../config/paths.js";
import { CURSOR_EVENT_SCHEMA, safeCursorToken, type CursorUsageEventV1 } from "./event.js";

// Legacy-only backfill. Cursor 3.16.17 stores no usable accounting for new
// prompts in its SQLite state, so this materializes only historical bubbles
// that carry a positive tokenCount plus a usageUuid. Values are parsed
// transiently and reduced to allowlisted fields before anything else happens;
// prompt/tool fields never leave the parse call. Output is one deterministic,
// immutable sanitized event file in Observer's spool — repeated runs rewrite
// identical content, and envelope-hash dedupe keeps re-imports idempotent.

const BACKFILL_FILE_PREFIX = "legacy-";
const BUBBLE_KEY_PREFIX = "bubbleId:";
// 'bubbleId;' is the lexicographic successor of every 'bubbleId:*' key.
const BUBBLE_KEY_END = "bubbleId;";
const SCAN_WINDOW = 500;

export interface BackfillArgs {
  /** <cursorUserDir>/globalStorage/state.vscdb */
  globalDbPath: string;
  /** <cursorUserDir>/workspaceStorage */
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
  eventsWithModel: number;
  outputFile: string | null;
}

interface BubbleSnapshot {
  composerId: string;
  bubbleId: string;
  usageUuid: string;
  inputTokens: number;
  outputTokens: number;
  timeMs: number | null;
  model: string | null;
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
 * The full value object is discarded inside the loop. User bubbles keep only
 * their `modelInfo.modelName` ("default" treated as absent) so per-request
 * models can be attributed from the same turn's context later.
 */
interface UserBubbleModel {
  composerId: string;
  bubbleId: string;
  model: string;
}

function scanBubbles(db: Database.Database): {
  snapshots: BubbleSnapshot[];
  userModels: UserBubbleModel[];
  scanned: number;
} {
  const select = db.prepare(
    `SELECT [key] AS k, value AS v FROM cursorDiskKV
      WHERE [key] >= ? AND [key] < ? AND [key] > ?
      ORDER BY [key]
      LIMIT ?`,
  );
  const snapshots: BubbleSnapshot[] = [];
  const userModels: UserBubbleModel[] = [];
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

      // User bubbles carry the model selected for the following request.
      if (rec.type === 1) {
        const modelInfo =
          rec.modelInfo != null && typeof rec.modelInfo === "object" && !Array.isArray(rec.modelInfo)
            ? (rec.modelInfo as Record<string, unknown>).modelName
            : null;
        if (typeof modelInfo === "string" && modelInfo.length > 0 && modelInfo !== "default") {
          userModels.push({ composerId, bubbleId, model: modelInfo });
        }
        continue;
      }

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

      snapshots.push({ composerId, bubbleId, usageUuid, inputTokens, outputTokens, timeMs, model: null });
    }
    if (rows.length < SCAN_WINDOW) break;
  }
  return { snapshots, userModels, scanned };
}

/**
 * Attribute per-request models by walking each conversation's
 * `fullConversationHeadersOnly` order: the model on a user bubble applies to
 * the positive requests that follow it until another user bubble changes it.
 * This is same-turn context, never a conversation's current model applied
 * retroactively to older requests.
 */
function attributeModels(
  db: Database.Database,
  userModels: UserBubbleModel[],
  snapshots: BubbleSnapshot[],
): void {
  if (userModels.length === 0) return;
  const modelsByBubble = new Map(userModels.map((u) => [`${u.composerId}\u0000${u.bubbleId}`, u.model]));
  const pendingByComposer = new Map<string, BubbleSnapshot[]>();
  for (const snapshot of snapshots) {
    const arr = pendingByComposer.get(snapshot.composerId) ?? [];
    arr.push(snapshot);
    pendingByComposer.set(snapshot.composerId, arr);
  }

  const composerData = db.prepare(
    `SELECT value AS v FROM cursorDiskKV WHERE [key] = ?`,
  );
  for (const [composerId, pending] of pendingByComposer) {
    let row: { v: unknown } | undefined;
    try {
      row = composerData.get(`composerData:${composerId}`) as { v: unknown } | undefined;
    } catch {
      continue;
    }
    if (!row) continue;
    let data: unknown;
    try {
      data = JSON.parse(typeof row.v === "string" ? row.v : String(row.v));
    } catch {
      continue;
    }
    const headers =
      data != null && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>).fullConversationHeadersOnly
        : null;
    if (!Array.isArray(headers)) continue;

    const pendingById = new Map(pending.map((s) => [s.bubbleId, s]));
    let currentModel: string | null = null;
    for (const header of headers) {
      const bubbleId =
        header != null && typeof header === "object" && !Array.isArray(header)
          ? (header as Record<string, unknown>).bubbleId
          : null;
      if (typeof bubbleId !== "string") continue;
      const model = modelsByBubble.get(`${composerId}\u0000${bubbleId}`);
      if (model !== undefined) currentModel = model;
      const snapshot = pendingById.get(bubbleId);
      if (snapshot && snapshot.model === null) snapshot.model = currentModel;
    }
  }
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
    eventsWithModel: 0,
    outputFile: null,
  };

  const db = openReadonly(args.globalDbPath);
  if (!db) return empty;
  try {
    if (!tableExists(db, "cursorDiskKV")) return { ...empty, status: "no-table" };

    const { snapshots, userModels, scanned } = scanBubbles(db);
    attributeModels(db, userModels, snapshots);
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
    let withModel = 0;

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
      if (chosen.model != null) withModel += 1;

      events.push({
        schema: CURSOR_EVENT_SCHEMA,
        source: "legacy-backfill",
        receivedAt,
        conversationId: chosen.composerId,
        generationId: usageUuid,
        cursorVersion: null,
        // Per-request model attributed from the same turn's user bubble when
        // Cursor stored one (never the conversation's current model applied
        // retroactively).
        modelId: chosen.model,
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

    // Immutable, content-addressed output: a changed dataset gets a new
    // filename (fresh collection from byte 0), and prior files are removed so
    // the same generation is never present in two files at once. Rewriting a
    // single stable filename would leave stored cursors misaligned mid-line.
    const outDir = join(args.spoolRoot, "backfill", "import");
    mkdirSync(outDir, { recursive: true });
    const content = events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
    const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const finalPath = join(outDir, `legacy-${contentHash}.jsonl`);
    if (!existsSync(finalPath)) {
      const tmpPath = `${finalPath}.tmp-${process.pid}`;
      writeFileSync(tmpPath, content, "utf8");
      renameSync(tmpPath, finalPath);
    }
    // Remove superseded backfill outputs (keep any *.tmp strays out).
    try {
      for (const name of readdirSync(outDir)) {
        if ((name.startsWith("legacy-") || name === "legacy.jsonl") && name.endsWith(".jsonl") && name !== `legacy-${contentHash}.jsonl`) {
          rmSync(join(outDir, name));
        }
      }
    } catch {
      /* best-effort cleanup */
    }

    return {
      status: "completed",
      bubblesScanned: scanned,
      positiveBubbles: snapshots.length,
      uniqueIdentities: byIdentity.size,
      imported: events.length,
      quarantinedIdentities,
      eventsWithExactTimestamp: exactTimestamps,
      eventsWithModel: withModel,
      outputFile: finalPath,
    };
  } finally {
    db.close();
  }
}

export function defaultBackfillArgs(spoolRoot: string): BackfillArgs {
  const userDir = cursorUserDir();
  return {
    globalDbPath: join(userDir, "globalStorage", "state.vscdb"),
    workspaceStorageDir: join(userDir, "workspaceStorage"),
    spoolRoot,
  };
}

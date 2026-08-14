import type { RawDatabase } from "../db/index.js";
import { QUALITY_FLAGS, type HarnessId, type NormalizationStatus } from "@shared/contracts";
import type { SourceConfig } from "../config/schema.js";

/**
 * Repository: typed DB access for sync + analytics. Uses prepared statements
 * directly on better-sqlite3 for the hot import path.
 */

export interface SourceFileRow {
  id: number;
  sourceId: string;
  logicalSessionId: string;
  currentPath: string;
  size: number;
  mtimeMs: number;
  byteCursor: number;
  lineCursor: number;
  parserState: string | null;
  present: number;
  schemaFingerprint: string | null;
  lastSyncedAt: string | null;
}

export class Repository {
  constructor(private db: RawDatabase) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /* --------------------------- collector_sources --------------------------- */

  upsertCollectorSource(src: SourceConfig, adapterVersion: string, present: boolean): void {
    this.db
      .prepare(
        `INSERT INTO collector_sources
           (id, harness, label, root, enabled, adapter_version, present)
         VALUES (@id, @harness, @label, @root, @enabled, @adapterVersion, @present)
         ON CONFLICT(id) DO UPDATE SET
           harness=excluded.harness, label=excluded.label, root=excluded.root,
           enabled=excluded.enabled, adapter_version=excluded.adapter_version,
           present=excluded.present`,
      )
      .run({
        id: src.id,
        harness: src.harness,
        label: src.label,
        root: src.root,
        enabled: src.enabled ? 1 : 0,
        adapterVersion,
        present: present ? 1 : 0,
      });
  }

  getSource(id: string) {
    return this.db.prepare(`SELECT * FROM collector_sources WHERE id = ?`).get(id) as any | undefined;
  }

  listSources() {
    return this.db.prepare(`SELECT * FROM collector_sources`).all() as any[];
  }

  setSourceSyncTimes(id: string, startedAt: string | null, finishedAt: string | null) {
    this.db
      .prepare(`UPDATE collector_sources SET last_sync_started_at = ?, last_sync_finished_at = ? WHERE id = ?`)
      .run(startedAt, finishedAt, id);
  }

  setSourceError(id: string, error: string | null) {
    this.db.prepare(`UPDATE collector_sources SET last_error = ? WHERE id = ?`).run(error, id);
  }

  recomputeSourceCounts(id: string) {
    const r = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN present = 1 THEN 1 ELSE 0 END) AS filesPresent,
           COUNT(*) AS filesDiscovered,
           (SELECT COUNT(*) FROM raw_usage_records WHERE source_id = ?) AS rawRecords,
           (SELECT COUNT(*) FROM raw_usage_records WHERE source_id = ? AND normalization_status = 'quarantined') AS quarantined,
           (SELECT COUNT(*) FROM raw_usage_records WHERE source_id = ? AND normalization_status = 'duplicate') AS duplicates
         FROM source_files WHERE source_id = ?`,
      )
      .get(id, id, id, id) as any;
    const events = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM usage_events WHERE harness =
           (SELECT harness FROM collector_sources WHERE id = ?)`,
      )
      .get(id) as any;
    this.db
      .prepare(
        `UPDATE collector_sources SET
           files_present = ?, files_discovered = ?, raw_records = ?,
           quarantined = ?, duplicates = ?, normalized_events = ? WHERE id = ?`,
      )
      .run(r.filesPresent ?? 0, r.filesDiscovered ?? 0, r.rawRecords ?? 0, r.quarantined ?? 0, r.duplicates ?? 0, events.c ?? 0, id);
  }

  /* ------------------------------ source_files ----------------------------- */

  getSourceFile(sourceId: string, logicalSessionId: string): SourceFileRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM source_files WHERE source_id = ? AND logical_session_id = ?`)
      .get(sourceId, logicalSessionId) as any | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      sourceId: row.source_id,
      logicalSessionId: row.logical_session_id,
      currentPath: row.current_path,
      size: row.size,
      mtimeMs: row.mtime_ms,
      byteCursor: row.byte_cursor,
      lineCursor: row.line_cursor,
      parserState: row.parser_state,
      present: row.present,
      schemaFingerprint: row.schema_fingerprint,
      lastSyncedAt: row.last_synced_at,
    };
  }

  upsertSourceFile(row: {
    sourceId: string;
    logicalSessionId: string;
    currentPath: string;
    size: number;
    mtimeMs: number;
    schemaFingerprint: string | null;
    lastSyncedAt: string;
  }): { id: number; pathChanged: boolean } {
    const existing = this.getSourceFile(row.sourceId, row.logicalSessionId);
    if (existing) {
      const pathChanged = existing.currentPath !== row.currentPath;
      this.db
        .prepare(
          `UPDATE source_files SET current_path = ?, size = ?, mtime_ms = ?, present = 1,
             schema_fingerprint = ?, last_synced_at = ?
             ${pathChanged ? ", byte_cursor = 0, line_cursor = 0, parser_state = NULL" : ""}
           WHERE id = ?`,
        )
        .run(row.currentPath, row.size, row.mtimeMs, row.schemaFingerprint, row.lastSyncedAt, existing.id);
      return { id: existing.id, pathChanged };
    }
    const info = this.db
      .prepare(
        `INSERT INTO source_files
           (source_id, logical_session_id, current_path, size, mtime_ms, byte_cursor, line_cursor,
            parser_state, present, schema_fingerprint, last_synced_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, NULL, 1, ?, ?)`,
      )
      .run(row.sourceId, row.logicalSessionId, row.currentPath, row.size, row.mtimeMs, row.schemaFingerprint, row.lastSyncedAt);
    return { id: Number(info.lastInsertRowid), pathChanged: false };
  }

  setSourceFileCursor(
    id: number,
    byteCursor: number,
    lineCursor: number,
    parserState: string | null,
    lastSyncedAt: string,
  ) {
    this.db
      .prepare(`UPDATE source_files SET byte_cursor = ?, line_cursor = ?, parser_state = ?, last_synced_at = ? WHERE id = ?`)
      .run(byteCursor, lineCursor, parserState, lastSyncedAt, id);
  }

  markMissingSourceFiles(sourceId: string, presentLogicalIds: string[]): number {
    const placeholders = presentLogicalIds.length > 0 ? presentLogicalIds.map(() => "?").join(",") : "''";
    const info = this.db
      .prepare(
        `UPDATE source_files SET present = 0 WHERE source_id = ? AND logical_session_id NOT IN (${placeholders})`,
      )
      .run(sourceId, ...presentLogicalIds) as any;
    return info.changes ?? 0;
  }

  /* ------------------------------ raw_usage -------------------------------- */

  insertRawRecord(args: {
    sourceId: string;
    sourceFileId: number | null;
    logicalSessionId: string;
    lineOrdinal: number;
    envelopeHash: string;
    parserVersion: string;
    requestId: string | null;
    occurredAt: string;
    status: NormalizationStatus;
    envelopeJson: string;
    qualityFlagsJson: string;
    createdAt: string;
  }): { inserted: boolean; id: number | null } {
    const info = this.db
      .prepare(
        `INSERT INTO raw_usage_records
           (source_id, source_file_id, logical_session_id, line_ordinal, envelope_hash,
            parser_version, request_id, occurred_at, normalization_status, envelope_json,
            quality_flags_json, created_at)
         VALUES (@sourceId, @sourceFileId, @logicalSessionId, @lineOrdinal, @envelopeHash,
                 @parserVersion, @requestId, @occurredAt, @status, @envelopeJson,
                 @qualityFlagsJson, @createdAt)
         ON CONFLICT(logical_session_id, line_ordinal, envelope_hash) DO NOTHING`,
      )
      .run(args) as any;
    if (info.changes > 0) return { inserted: true, id: Number(info.lastInsertRowid) };
    return { inserted: false, id: null };
  }

  /**
   * Mark every earlier `normalized` snapshot for the same API request as a
   * duplicate. Used when a newer snapshot supersedes a version that a previous
   * sync batch already stored as `normalized` (the in-collector dedup only sees
   * snapshots within a single batch). Returns the number of rows superseded.
   */
  supersedePriorNormalizedRawRecords(args: {
    sourceId: string;
    logicalSessionId: string;
    requestId: string;
    keepId: number;
  }): number {
    if (!args.requestId) return 0;
    const info = this.db
      .prepare(
        `UPDATE raw_usage_records
           SET normalization_status = 'duplicate',
               quality_flags_json = ?
         WHERE source_id = ? AND logical_session_id = ? AND request_id = ?
           AND normalization_status = 'normalized'
           AND id != ?`,
      )
      .run(JSON.stringify([QUALITY_FLAGS.DUPLICATE_TELEMETRY]), args.sourceId, args.logicalSessionId, args.requestId, args.keepId) as any;
    return info.changes ?? 0;
  }

  /** Bulk-mark raw snapshots as duplicates during renormalize collapse. */
  markRawRecordsDuplicate(ids: number[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const info = this.db
      .prepare(
        `UPDATE raw_usage_records
           SET normalization_status = 'duplicate',
               quality_flags_json = ?
         WHERE id IN (${placeholders})`,
      )
      .run(JSON.stringify([QUALITY_FLAGS.DUPLICATE_TELEMETRY]), ...ids) as any;
    return info.changes ?? 0;
  }

  setRawRecordStatus(id: number, status: NormalizationStatus) {
    this.db.prepare(`UPDATE raw_usage_records SET normalization_status = ? WHERE id = ?`).run(status, id);
  }

  /* --------------------------- message_nodes ------------------------------- */

  upsertMessageNode(args: {
    sourceId: string;
    logicalSessionId: string;
    nodeId: string;
    parentId: string | null;
    role: string | null;
    turnId: string | null;
    createdAt: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO source_message_nodes
           (source_id, logical_session_id, node_id, parent_id, role, turn_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, logical_session_id, node_id) DO UPDATE SET
           parent_id = COALESCE(excluded.parent_id, source_message_nodes.parent_id),
           role = COALESCE(excluded.role, source_message_nodes.role)`,
      )
      .run(args.sourceId, args.logicalSessionId, args.nodeId, args.parentId, args.role, args.turnId, args.createdAt);
  }

  /* ------------------------------ sync_runs -------------------------------- */

  createSyncRun(args: { id: string; trigger: string; startedAt: string; total: number }) {
    this.db
      .prepare(
        `INSERT INTO sync_runs (id, trigger, started_at, phase, progress_total) VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(args.id, args.trigger, args.startedAt, args.total);
  }

  updateSyncRunProgress(id: string, current: number, total: number, imported: number, duplicates: number, quarantined: number) {
    this.db
      .prepare(
        `UPDATE sync_runs SET progress_current = ?, progress_total = ?, imported = ?, duplicates = ?, quarantined = ? WHERE id = ?`,
      )
      .run(current, total, imported, duplicates, quarantined, id);
  }

  finishSyncRun(id: string, finishedAt: string, phase: string, errors: string[]) {
    this.db
      .prepare(`UPDATE sync_runs SET finished_at = ?, phase = ?, errors_json = ? WHERE id = ?`)
      .run(finishedAt, phase, JSON.stringify(errors), id);
  }

  appendSyncRunError(id: string, error: string) {
    this.db
      .prepare(`UPDATE sync_runs SET errors_json = errors_json || ? WHERE id = ?`)
      .run(JSON.stringify([error]), id);
  }

  getSyncRun(id: string) {
    return this.db.prepare(`SELECT * FROM sync_runs WHERE id = ?`).get(id) as any | undefined;
  }

  listSyncRuns(limit = 20) {
    return this.db.prepare(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?`).all(limit) as any[];
  }

  /* ------------------------- normalized dimensions ------------------------- */

  upsertProject(args: { id: string; normalizedRootPath: string; displayPath: string; canonicalProject: string }) {
    this.db
      .prepare(
        `INSERT INTO projects (id, normalized_root_path, display_path, canonical_project)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           normalized_root_path = excluded.normalized_root_path,
           display_path = excluded.display_path,
           canonical_project = excluded.canonical_project`,
      )
      .run(args.id, args.normalizedRootPath, args.displayPath, args.canonicalProject);
  }

  upsertSession(args: {
    id: string;
    harness: HarnessId;
    logicalSessionId: string;
    projectId: string | null;
    cwd: string | null;
    firstSeen: string;
    lastSeen: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO sessions (id, harness, logical_session_id, project_id, cwd, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = COALESCE(excluded.project_id, sessions.project_id),
           cwd = COALESCE(excluded.cwd, sessions.cwd),
           last_seen = excluded.last_seen`,
      )
      .run(args.id, args.harness, args.logicalSessionId, args.projectId, args.cwd, args.firstSeen, args.lastSeen);
  }

  upsertTurn(args: { id: string; sessionId: string; turnId: string; occurredAt: string }) {
    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, turn_id, occurred_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(args.id, args.sessionId, args.turnId, args.occurredAt);
  }

  upsertProvider(args: { id: string; rawProviderId: string | null; canonicalProviderId: string; display: string }) {
    this.db
      .prepare(
        `INSERT INTO providers (id, raw_provider_id, canonical_provider_id, display)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           canonical_provider_id = excluded.canonical_provider_id,
           raw_provider_id = COALESCE(excluded.raw_provider_id, providers.raw_provider_id),
           display = excluded.display`,
      )
      .run(args.id, args.rawProviderId, args.canonicalProviderId, args.display);
  }

  upsertModel(args: { id: string; canonicalModelId: string; rawModelId: string | null; owner: string | null; display: string }) {
    this.db
      .prepare(
        `INSERT INTO models (id, canonical_model_id, raw_model_id, owner, display)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET display = excluded.display`,
      )
      .run(args.id, args.canonicalModelId, args.rawModelId, args.owner, args.display);
  }

  /* ------------------------------ usage_events ----------------------------- */

  upsertUsageEvent(args: {
    id: string;
    rawRecordId: number | null;
    harness: HarnessId;
    occurredAt: string;
    sessionId: string;
    logicalSessionId: string;
    turnId: string | null;
    requestId: string;
    projectId: string | null;
    rawProviderId: string | null;
    canonicalProviderId: string | null;
    providerResolution: string;
    rawModelId: string | null;
    canonicalModelId: string | null;
    processedInputTokens: number;
    freshInputTokens: number;
    cacheReadInputTokens: number;
    cacheWriteInputTokens: number;
    cacheWriteAvailable: boolean;
    outputTokens: number;
    reasoningOutputTokens: number | null;
    unattributedTokens: number;
    processedTokens: number;
    costNanoUsd: number | null;
    costAvailable: boolean;
    qualityFlagsJson: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO usage_events
           (id, raw_record_id, harness, occurred_at, session_id, logical_session_id, turn_id, request_id,
            project_id, raw_provider_id, canonical_provider_id, provider_resolution, raw_model_id,
            canonical_model_id, processed_input_tokens, fresh_input_tokens, cache_read_input_tokens,
            cache_write_input_tokens, cache_write_available, output_tokens, reasoning_output_tokens,
            unattributed_tokens, processed_tokens, cost_nano_usd, cost_available, quality_flags_json)
         VALUES (@id, @rawRecordId, @harness, @occurredAt, @sessionId, @logicalSessionId, @turnId, @requestId,
            @projectId, @rawProviderId, @canonicalProviderId, @providerResolution, @rawModelId,
            @canonicalModelId, @processedInputTokens, @freshInputTokens, @cacheReadInputTokens,
            @cacheWriteInputTokens, @cacheWriteAvailable, @outputTokens, @reasoningOutputTokens,
            @unattributedTokens, @processedTokens, @costNanoUsd, @costAvailable, @qualityFlagsJson)
         ON CONFLICT(harness, logical_session_id, request_id) DO UPDATE SET
            raw_record_id = excluded.raw_record_id, occurred_at = excluded.occurred_at,
            session_id = excluded.session_id, turn_id = excluded.turn_id, project_id = excluded.project_id,
            raw_provider_id = excluded.raw_provider_id, canonical_provider_id = excluded.canonical_provider_id,
            provider_resolution = excluded.provider_resolution, raw_model_id = excluded.raw_model_id,
            canonical_model_id = excluded.canonical_model_id, processed_input_tokens = excluded.processed_input_tokens,
            fresh_input_tokens = excluded.fresh_input_tokens, cache_read_input_tokens = excluded.cache_read_input_tokens,
            cache_write_input_tokens = excluded.cache_write_input_tokens, cache_write_available = excluded.cache_write_available,
            output_tokens = excluded.output_tokens, reasoning_output_tokens = excluded.reasoning_output_tokens,
            unattributed_tokens = excluded.unattributed_tokens, processed_tokens = excluded.processed_tokens,
            cost_nano_usd = excluded.cost_nano_usd, cost_available = excluded.cost_available,
            quality_flags_json = excluded.quality_flags_json`,
      )
      .run({ ...args, cacheWriteAvailable: args.cacheWriteAvailable ? 1 : 0, costAvailable: args.costAvailable ? 1 : 0 });
  }

  /* ------------------------------- rebuild --------------------------------- */

  clearIndexForSource(sourceId: string) {
    this.db
      .prepare(
        `DELETE FROM sessions
         WHERE harness = (SELECT harness FROM collector_sources WHERE id = ?)
           AND logical_session_id IN (
             SELECT logical_session_id FROM source_files WHERE source_id = ?
           )`,
      )
      .run(sourceId, sourceId);
    this.db.prepare(`DELETE FROM raw_usage_records WHERE source_id = ?`).run(sourceId);
    this.db.prepare(`DELETE FROM source_files WHERE source_id = ?`).run(sourceId);
    this.db.prepare(`DELETE FROM source_message_nodes WHERE source_id = ?`).run(sourceId);
  }

  /**
   * Clear every canonical row for renormalize. Dimension tables (sessions,
   * projects, providers, models) are rebuilt by the replay, so they must be
   * cleared too — otherwise renamed canonical keys leave zombie filter rows.
   * Children are deleted before parents to respect foreign keys.
   */
  clearAllNormalized() {
    this.db.exec(`DELETE FROM usage_events`);
    this.db.exec(`DELETE FROM turns`);
    this.db.exec(`DELETE FROM sessions`);
    this.db.exec(`DELETE FROM projects`);
    this.db.exec(`DELETE FROM models`);
    this.db.exec(`DELETE FROM providers`);
  }

  clearAllIndex() {
    // Delete children before parents to respect foreign keys.
    this.db.exec(`DELETE FROM usage_events`);
    this.db.exec(`DELETE FROM turns`);
    this.db.exec(`DELETE FROM sessions`);
    this.db.exec(`DELETE FROM raw_usage_records`);
    this.db.exec(`DELETE FROM source_message_nodes`);
    this.db.exec(`DELETE FROM source_files`);
    this.db.exec(`DELETE FROM projects`);
    this.db.exec(`DELETE FROM providers`);
    this.db.exec(`DELETE FROM models`);
  }

  listAllRawRecords(): any[] {
    return this.db.prepare(`SELECT * FROM raw_usage_records ORDER BY id`).all() as any[];
  }

  countWarnings(): number {
    const r = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM raw_usage_records WHERE normalization_status = 'quarantined') AS q,
           (SELECT COUNT(*) FROM collector_sources WHERE last_error IS NOT NULL) AS e`,
      )
      .get() as any;
    return (r.q ?? 0) + (r.e ?? 0);
  }
}

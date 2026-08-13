import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Observer SQLite schema.
 *
 * Token columns are SQLite 64-bit INTEGERs (stored as JS numbers; per-event
 * values are always within safe integer range). Cost is stored as nano-USD
 * (integer number of 1e-9 USD) to avoid floating point drift.
 *
 * Migrations are hand-authored SQL under drizzle/*.ts for determinism; this
 * file documents the canonical shape and is used by drizzle-kit tooling.
 */

export const collectorSources = sqliteTable(
  "collector_sources",
  {
    id: text("id").primaryKey(),
    harness: text("harness").notNull(),
    label: text("label").notNull(),
    root: text("root").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    adapterVersion: text("adapter_version").notNull(),
    schemaFingerprint: text("schema_fingerprint"),
    present: integer("present", { mode: "boolean" }).notNull().default(true),
    lastSyncStartedAt: text("last_sync_started_at"),
    lastSyncFinishedAt: text("last_sync_finished_at"),
    lastError: text("last_error"),
    rawRecords: integer("raw_records").notNull().default(0),
    normalizedEvents: integer("normalized_events").notNull().default(0),
    quarantined: integer("quarantined").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    filesDiscovered: integer("files_discovered").notNull().default(0),
    filesPresent: integer("files_present").notNull().default(0),
  },
  (t) => ({
    harnessIdx: index("collector_sources_harness_idx").on(t.harness),
  }),
);

export const sourceFiles = sqliteTable(
  "source_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: text("source_id").notNull().references(() => collectorSources.id, { onDelete: "cascade" }),
    logicalSessionId: text("logical_session_id").notNull(),
    currentPath: text("current_path").notNull(),
    size: integer("size").notNull().default(0),
    mtimeMs: integer("mtime_ms").notNull().default(0),
    byteCursor: integer("byte_cursor").notNull().default(0),
    lineCursor: integer("line_cursor").notNull().default(0),
    parserState: text("parser_state"), // opaque JSON, collector-specific
    present: integer("present", { mode: "boolean" }).notNull().default(true),
    schemaFingerprint: text("schema_fingerprint"),
    lastSyncedAt: text("last_synced_at"),
  },
  (t) => ({
    logicalIdx: index("source_files_logical_idx").on(t.sourceId, t.logicalSessionId),
    pathIdx: index("source_files_path_idx").on(t.currentPath),
  }),
);

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    trigger: text("trigger").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    phase: text("phase").notNull().default("pending"),
    progressCurrent: integer("progress_current").notNull().default(0),
    progressTotal: integer("progress_total").notNull().default(0),
    imported: integer("imported").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    quarantined: integer("quarantined").notNull().default(0),
    errorsJson: text("errors_json").notNull().default("[]"),
  },
  (t) => ({
    startedIdx: index("sync_runs_started_idx").on(t.startedAt),
    phaseIdx: index("sync_runs_phase_idx").on(t.phase),
  }),
);

export const rawUsageRecords = sqliteTable(
  "raw_usage_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: text("source_id").notNull().references(() => collectorSources.id, { onDelete: "cascade" }),
    sourceFileId: integer("source_file_id").references(() => sourceFiles.id, { onDelete: "cascade" }),
    logicalSessionId: text("logical_session_id").notNull(),
    lineOrdinal: integer("line_ordinal").notNull(),
    envelopeHash: text("envelope_hash").notNull(),
    parserVersion: text("parser_version").notNull(),
    // API request identity, backfilled from the envelope so that superseded
    // snapshot versions for one response can be collapsed deterministically.
    requestId: text("request_id"),
    occurredAt: text("occurred_at").notNull(),
    normalizationStatus: text("normalization_status").notNull().default("normalized"),
    envelopeJson: text("envelope_json").notNull(),
    qualityFlagsJson: text("quality_flags_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    // Unique raw-record identity: logical session + line ordinal + envelope hash.
    rawUnique: uniqueIndex("raw_usage_unique_idx").on(t.logicalSessionId, t.lineOrdinal, t.envelopeHash),
    sourceIdx: index("raw_usage_source_idx").on(t.sourceId),
    statusIdx: index("raw_usage_status_idx").on(t.normalizationStatus),
    occurredIdx: index("raw_usage_occurred_idx").on(t.occurredAt),
    // Supersession lookup: prior normalized snapshots for one request.
    supersedeIdx: index("raw_usage_supersede_idx").on(t.sourceId, t.logicalSessionId, t.requestId),
  }),
);

export const sourceMessageNodes = sqliteTable(
  "source_message_nodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: text("source_id").notNull().references(() => collectorSources.id, { onDelete: "cascade" }),
    logicalSessionId: text("logical_session_id").notNull(),
    nodeId: text("node_id").notNull(),
    parentId: text("parent_id"),
    role: text("role"),
    turnId: text("turn_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    nodeUnique: uniqueIndex("source_message_nodes_unique_idx").on(t.sourceId, t.logicalSessionId, t.nodeId),
    sessionIdx: index("source_message_nodes_session_idx").on(t.logicalSessionId),
  }),
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    normalizedRootPath: text("normalized_root_path").notNull(),
    displayPath: text("display_path").notNull(),
    canonicalProject: text("canonical_project").notNull(),
  },
  (t) => ({
    pathIdx: uniqueIndex("projects_path_idx").on(t.normalizedRootPath),
    canonicalIdx: index("projects_canonical_idx").on(t.canonicalProject),
  }),
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // harness:logicalSessionId
    harness: text("harness").notNull(),
    logicalSessionId: text("logical_session_id").notNull(),
    projectId: text("project_id").references(() => projects.id),
    cwd: text("cwd"),
    firstSeen: text("first_seen").notNull(),
    lastSeen: text("last_seen").notNull(),
  },
  (t) => ({
    harnessLogicalUnique: uniqueIndex("sessions_harness_logical_idx").on(t.harness, t.logicalSessionId),
    harnessIdx: index("sessions_harness_idx").on(t.harness),
    projectIdx: index("sessions_project_idx").on(t.projectId),
  }),
);

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => ({
    sessionTurnUnique: uniqueIndex("turns_session_turn_idx").on(t.sessionId, t.turnId),
    sessionIdx: index("turns_session_idx").on(t.sessionId),
  }),
);

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  rawProviderId: text("raw_provider_id"),
  canonicalProviderId: text("canonical_provider_id").notNull(),
  display: text("display").notNull(),
});

export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  canonicalModelId: text("canonical_model_id").notNull(),
  rawModelId: text("raw_model_id"),
  owner: text("owner"),
  display: text("display").notNull(),
});

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    rawRecordId: integer("raw_record_id").references(() => rawUsageRecords.id, { onDelete: "cascade" }),
    harness: text("harness").notNull(),
    occurredAt: text("occurred_at").notNull(),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    logicalSessionId: text("logical_session_id").notNull(),
    turnId: text("turn_id"),
    requestId: text("request_id").notNull(),
    projectId: text("project_id").references(() => projects.id),

    rawProviderId: text("raw_provider_id"),
    canonicalProviderId: text("canonical_provider_id"),
    providerResolution: text("provider_resolution").notNull().default("unknown"),

    rawModelId: text("raw_model_id"),
    canonicalModelId: text("canonical_model_id"),

    processedInputTokens: integer("processed_input_tokens").notNull().default(0),
    freshInputTokens: integer("fresh_input_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    cacheWriteInputTokens: integer("cache_write_input_tokens").notNull().default(0),
    cacheWriteAvailable: integer("cache_write_available", { mode: "boolean" }).notNull().default(true),

    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningOutputTokens: integer("reasoning_output_tokens"),
    unattributedTokens: integer("unattributed_tokens").notNull().default(0),
    processedTokens: integer("processed_tokens").notNull().default(0),

    costNanoUsd: integer("cost_nano_usd"),
    costAvailable: integer("cost_available", { mode: "boolean" }).notNull().default(false),
    qualityFlagsJson: text("quality_flags_json").notNull().default("[]"),
  },
  (t) => ({
    // Unique normalized event key per harness/session/request.
    eventUnique: uniqueIndex("usage_events_unique_idx").on(t.harness, t.logicalSessionId, t.requestId),
    occurredIdx: index("usage_events_occurred_idx").on(t.occurredAt),
    harnessIdx: index("usage_events_harness_idx").on(t.harness),
    providerIdx: index("usage_events_provider_idx").on(t.canonicalProviderId),
    modelIdx: index("usage_events_model_idx").on(t.canonicalModelId),
    projectIdx: index("usage_events_project_idx").on(t.projectId),
    sessionIdx: index("usage_events_session_idx").on(t.sessionId),
  }),
);

export type DbCollectorSource = typeof collectorSources.$inferSelect;
export type DbSourceFile = typeof sourceFiles.$inferSelect;
export type DbSyncRun = typeof syncRuns.$inferSelect;
export type DbRawUsageRecord = typeof rawUsageRecords.$inferSelect;
export type DbUsageEvent = typeof usageEvents.$inferSelect;

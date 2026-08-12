-- Observer initial schema (version 1)
-- Token columns are 64-bit INTEGERs. Cost is nano-USD (1e-9 USD).

CREATE TABLE collector_sources (
  id TEXT PRIMARY KEY NOT NULL,
  harness TEXT NOT NULL,
  label TEXT NOT NULL,
  root TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  adapter_version TEXT NOT NULL,
  schema_fingerprint TEXT,
  present INTEGER NOT NULL DEFAULT 1,
  last_sync_started_at TEXT,
  last_sync_finished_at TEXT,
  last_error TEXT,
  raw_records INTEGER NOT NULL DEFAULT 0,
  normalized_events INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  files_discovered INTEGER NOT NULL DEFAULT 0,
  files_present INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX collector_sources_harness_idx ON collector_sources(harness);

CREATE TABLE source_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES collector_sources(id) ON DELETE CASCADE,
  logical_session_id TEXT NOT NULL,
  current_path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  byte_cursor INTEGER NOT NULL DEFAULT 0,
  line_cursor INTEGER NOT NULL DEFAULT 0,
  parser_state TEXT,
  present INTEGER NOT NULL DEFAULT 1,
  schema_fingerprint TEXT,
  last_synced_at TEXT
);
CREATE INDEX source_files_logical_idx ON source_files(source_id, logical_session_id);
CREATE INDEX source_files_path_idx ON source_files(current_path);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  phase TEXT NOT NULL DEFAULT 'pending',
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX sync_runs_started_idx ON sync_runs(started_at);
CREATE INDEX sync_runs_phase_idx ON sync_runs(phase);

CREATE TABLE raw_usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES collector_sources(id) ON DELETE CASCADE,
  source_file_id INTEGER REFERENCES source_files(id) ON DELETE CASCADE,
  logical_session_id TEXT NOT NULL,
  line_ordinal INTEGER NOT NULL,
  envelope_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  normalization_status TEXT NOT NULL DEFAULT 'normalized',
  envelope_json TEXT NOT NULL,
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX raw_usage_unique_idx ON raw_usage_records(logical_session_id, line_ordinal, envelope_hash);
CREATE INDEX raw_usage_source_idx ON raw_usage_records(source_id);
CREATE INDEX raw_usage_status_idx ON raw_usage_records(normalization_status);
CREATE INDEX raw_usage_occurred_idx ON raw_usage_records(occurred_at);

CREATE TABLE source_message_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES collector_sources(id) ON DELETE CASCADE,
  logical_session_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT,
  turn_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX source_message_nodes_unique_idx ON source_message_nodes(source_id, logical_session_id, node_id);
CREATE INDEX source_message_nodes_session_idx ON source_message_nodes(logical_session_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  normalized_root_path TEXT NOT NULL,
  display_path TEXT NOT NULL,
  canonical_project TEXT NOT NULL
);
CREATE UNIQUE INDEX projects_path_idx ON projects(normalized_root_path);
CREATE INDEX projects_canonical_idx ON projects(canonical_project);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  harness TEXT NOT NULL,
  logical_session_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  cwd TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE UNIQUE INDEX sessions_harness_logical_idx ON sessions(harness, logical_session_id);
CREATE INDEX sessions_harness_idx ON sessions(harness);
CREATE INDEX sessions_project_idx ON sessions(project_id);

CREATE TABLE turns (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE UNIQUE INDEX turns_session_turn_idx ON turns(session_id, turn_id);
CREATE INDEX turns_session_idx ON turns(session_id);

CREATE TABLE providers (
  id TEXT PRIMARY KEY NOT NULL,
  raw_provider_id TEXT,
  canonical_provider_id TEXT NOT NULL,
  display TEXT NOT NULL
);

CREATE TABLE models (
  id TEXT PRIMARY KEY NOT NULL,
  canonical_model_id TEXT NOT NULL,
  raw_model_id TEXT,
  owner TEXT,
  display TEXT NOT NULL
);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY NOT NULL,
  raw_record_id INTEGER REFERENCES raw_usage_records(id) ON DELETE CASCADE,
  harness TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  logical_session_id TEXT NOT NULL,
  turn_id TEXT,
  request_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),

  raw_provider_id TEXT,
  canonical_provider_id TEXT,
  provider_resolution TEXT NOT NULL DEFAULT 'unknown',

  raw_model_id TEXT,
  canonical_model_id TEXT,

  processed_input_tokens INTEGER NOT NULL DEFAULT 0,
  fresh_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_available INTEGER NOT NULL DEFAULT 1,

  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER,
  unattributed_tokens INTEGER NOT NULL DEFAULT 0,
  processed_tokens INTEGER NOT NULL DEFAULT 0,

  cost_nano_usd INTEGER,
  cost_available INTEGER NOT NULL DEFAULT 0,
  quality_flags_json TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX usage_events_unique_idx ON usage_events(harness, logical_session_id, request_id);
CREATE INDEX usage_events_occurred_idx ON usage_events(occurred_at);
CREATE INDEX usage_events_harness_idx ON usage_events(harness);
CREATE INDEX usage_events_provider_idx ON usage_events(canonical_provider_id);
CREATE INDEX usage_events_model_idx ON usage_events(canonical_model_id);
CREATE INDEX usage_events_project_idx ON usage_events(project_id);
CREATE INDEX usage_events_session_idx ON usage_events(session_id);

-- Track the API request identity on each retained raw snapshot so that
-- superseded snapshot versions can be collapsed deterministically during
-- renormalization. Claude Code (and other harnesses) can append an updated
-- usage snapshot for the same response across separate sync batches; without a
-- request id on the raw row, every version stays `normalized` and renormalize
-- replays stale and final snapshots in unspecified `SELECT *` order.
ALTER TABLE raw_usage_records ADD COLUMN request_id TEXT;

-- Backfill from retained envelopes for snapshots already stored as `normalized`.
-- Duplicate/quarantine rows keep a `{"reason": ...}` envelope with no request id
-- and are intentionally left NULL.
UPDATE raw_usage_records
SET request_id = json_extract(envelope_json, '$.requestId')
WHERE request_id IS NULL
  AND normalization_status = 'normalized'
  AND json_extract(envelope_json, '$.requestId') IS NOT NULL;

CREATE INDEX raw_usage_supersede_idx
  ON raw_usage_records(source_id, logical_session_id, request_id);

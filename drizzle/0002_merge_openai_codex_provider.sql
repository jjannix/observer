-- `openai-codex` identifies an OpenAI delivery/auth route used by some
-- harnesses. Provider analysis should group it with OpenAI; the raw value is
-- retained on each event for diagnostics.
UPDATE usage_events
SET canonical_provider_id = 'openai',
    provider_resolution = 'seed-alias'
WHERE lower(COALESCE(raw_provider_id, '')) = 'openai-codex'
   OR lower(COALESCE(canonical_provider_id, '')) = 'openai-codex';

INSERT INTO providers (id, raw_provider_id, canonical_provider_id, display)
SELECT 'openai', raw_provider_id, 'openai', 'OpenAI'
FROM providers
WHERE id = 'openai-codex'
ON CONFLICT(id) DO UPDATE SET
  canonical_provider_id = 'openai',
  display = 'OpenAI';

DELETE FROM providers WHERE id = 'openai-codex';

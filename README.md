# Observer

Local-first usage analytics for AI coding harnesses. This milestone delivers **Pi** and **Codex** collectors with complete historical backfill, canonical token accounting, and a diagnostic dark-mode UI — all running on `127.0.0.1` with no network calls, no telemetry, and no authentication.

OpenCode and Claude Code collectors, charts, ranked breakdowns, and the session explorer are explicitly deferred; the schema and collector contract already accommodate them.

## Quick start

```bash
npm install
npm run dev          # Vite client (5173) + Fastify API (4310), /api proxied
```

For production:

```bash
npm run build        # type-check + Vite build to dist/client
npm start            # Fastify serves API + built UI on 127.0.0.1:4310
```

CLI:

```bash
npm run observer -- doctor    # sources, schema, health, counts
npm run observer -- sync      # one sync pass, then exit
npm run observer -- rebuild   # clear Observer's index, rescan sources
npm run observer -- config    # print active configuration
```

## Tests

```bash
npm test              # vitest: collectors, normalization, sync lifecycle, privacy, API
npm run test:e2e      # Playwright diagnostic UI (run `npx playwright install` first)
npm run typecheck
npm run lint
```

## Local files and defaults

| Item | Default | Override |
| --- | --- | --- |
| Database | `%LOCALAPPDATA%\Observer\observer.sqlite3` | `OBSERVER_DATA_DIR` |
| Config | `%APPDATA%\Observer\config.json` | `OBSERVER_CONFIG_PATH` |
| Port | `4310` (production) | `OBSERVER_PORT` |

- **Time zone:** `Europe/Berlin` (local calendar ranges are converted to UTC instants before API requests).
- **Sync interval:** 60 seconds while the server runs.
- **History cutoff:** `null` (all available history).
- **Pi source:** `%USERPROFILE%\.pi\agent\sessions`
- **Codex sources:** `%USERPROFILE%\.codex\sessions` and `%USERPROFILE%\.codex\archived_sessions`

Paths are auto-detected, editable, and individually disableable. Changing the history cutoff requires **Save and rebuild**. Rebuild deletes and recreates **only Observer's index**; harness source data is never modified.

## Canonical metric definitions

```
processedInput   = fresh + cacheRead + cacheWrite
processedTokens  = processedInput + output + unattributed
cachedTokens     = cacheRead
cacheHitRate     = cacheRead / processedInput
cacheReuseEff.   = cacheRead / cacheWrite        (only with complete cache-write coverage, non-zero denom)
outputInputRatio = output / processedInput
sessionCount     = distinct sessions with usage in range
turnCount        = distinct human turns with usage in range
requestCount     = distinct normalized requests
cost             = sum of reported cost (missing excluded, not zero)
costCoverage     = processed-token share with a reported cost
classificationCoverage = classified input/output tokens / processed tokens
```

**`output` always includes reasoning exactly once.** When reasoning is separately available, visible output is derived as `output - reasoning`. Weighted aggregate ratios use summed numerators and denominators — never averages of per-event percentages.

### Pi normalization

Stable request identity is `sessionHeaderId:recordId`. Provider/model come from `message.provider` / `message.model` (per-record — model changes are preserved). Output already includes reasoning and is **not** added again; `cacheWrite1h` is retained on the raw envelope but never added to processed input (observed to duplicate `cacheWrite`). Each request is attributed to the nearest human ancestor through the `parentId` graph; tool-result nodes inherit their ancestor turn.

### Codex normalization

Current Codex rollouts expose each request in `event_msg.payload.info.last_token_usage`; Observer records that vector directly and uses the nested `session_meta` / `turn_context` payloads for identity and model attribution. Legacy rollouts that expose only `total_token_usage` remain supported by taking deltas between successive cumulative vectors.

- Equal consecutive telemetry = duplicate telemetry → no second event.
- `processedInput = input`; `fresh = input − cached-read − cache-write` (using deltas for legacy cumulative records).
- Output includes reasoning; reasoning stays a subset.
- Cache-write is marked unavailable for older records omitting the field.
- If `total_tokens` increases while input/output components do not, the difference is retained as `unattributedTokens` (covers rollback/compaction).
- Negative components, non-monotonic cumulative counters, or impossible cache relationships quarantine the event and raise a source-health warning.
- Forked and subagent rollouts ignore their initial rapid replay of parent telemetry; accounting begins after the first one-second gap.

## Project & identity resolution

- Windows paths are normalized case-insensitively.
- A working directory resolves upward to the nearest Git root (including worktree `.git` files).
- If the directory no longer exists, the normalized recorded path is retained.
- Default project identity is a hash of the normalized root path; different clones stay separate unless joined by a project alias.
- Canonical model keys normalize case, strip routing-only leading `~`, and combine a known model owner with the model id so direct and routed forms (e.g. OpenAI vs OpenRouter) share a canonical model while provider attribution stays separate. `latest`/dated versions stay distinct unless aliased.

## Configuration

`config.json` is versioned and atomically replaced after validation. The Settings UI edits the same file. Supported sections:

- **Sources:** roots, enabled state, history cutoff.
- **Provider aliases:** display names.
- **Provider overrides:** harness + raw provider/model + optional date bounds → canonical provider.
- **Model aliases:** provider/model pairs → canonical model (+ owner).
- **Project aliases:** join multiple normalized paths to one project.
- **General:** time zone and sync interval.

Resolution precedence: **user-override → seed-alias → deterministic → unknown**. Saving alias changes re-resolves canonical dimensions from retained usage envelopes **without rescanning** source files.

## HTTP API (all under `/api/v1`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | version, schema, active sync, warning count |
| GET | `/sources` | discovery, health, schema fingerprint, counts, last error |
| POST | `/sync` | start/coalesce a sync → `202` + run id |
| GET | `/sync/:id` | progress and results |
| GET | `/dimensions` | canonical providers/models/projects/harnesses for filters |
| GET | `/timeseries` | daily Europe/Berlin buckets grouped by canonical provider |
| GET | `/summary` | totals and weighted ratios |
| GET | `/events` | opaque-cursor pagination over normalized events |
| GET | `/config` | sanitized configuration + resolved paths |
| PUT | `/config` | validate + atomically persist |
| POST | `/renormalize` | rebuild canonical rows from retained envelopes |
| POST | `/rebuild` | requires `{"confirm":"rebuild"}`; clears index, rescans |

`summary` and `events` accept `from`, exclusive `to`, and canonical `harness`/`provider`/`model`/`project` filters. Event page size defaults to 100 and is capped at 250.

## Privacy

Raw envelopes whitelist **only** usage fields, IDs, timestamps, provider/model metadata, and accounting context. Prompts, assistant text, code, tool inputs, and tool outputs are **never** copied. The integration suite asserts this on every stored raw record.

## Synchronization behavior

1. Fastify serves the UI immediately.
2. Migrations apply; source roots are discovered.
3. Initial backfill runs asynchronously.
4. Files stream line-by-line without loading full sessions into memory.
5. Commits happen in bounded batches with progress updates.
6. Cursors advance only past committed complete lines — never past a partial trailing line.
7. Concurrent startup/timer/manual requests coalesce into one run.
8. Incremental scans repeat every 60s and on "Sync now".
9. Moved/archived sources match by logical session + record identity, not path.
10. Disappearing sources are marked missing; analytics are retained.
11. Failures are isolated per source/file; the last valid cursor is kept.
12. Raw envelopes and sensitive configuration values are never logged.

## Repository layout

```
src/
  client/            React + Vite + TanStack Query/Table (overview, events, settings)
  server/
    api/             Fastify routes + analytics queries
    collectors/      contract, Pi, Codex, JSONL streaming, envelope hashing
    config/          versioned config, paths, Zod schema
    db/              better-sqlite3 + drizzle schema + migration runner
    normalization/   canonical keys, resolution, metric formulas
    sync/            engine, repository, normalize
  shared/contracts.ts  public domain types
drizzle/             SQL migrations
tests/               fixtures, unit, integration, e2e
```

## Performance targets (current corpus)

- Stream the ~500 MB Pi/Codex corpus with peak memory below 500 MB.
- First backfill within ~90s.
- No-change incremental sync within 2s.
- Summary and event-page queries within 250 ms.

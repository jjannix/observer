// Sanitized Cursor usage event contract (observer.cursor.usage.v1).
// Privacy rules: only allowlisted fields are copied from raw hook payloads —
// never user_email, transcript_path, prompts, attachments, thinking text,
// tool names/inputs/outputs, or arbitrary stdin fragments.

export const CURSOR_EVENT_SCHEMA = "observer.cursor.usage.v1";

export const CURSOR_EVENT_FLAG_ALLOWLIST = [
  "multi-root-project-ambiguous",
] as const;

export type CursorEventSource = "stop-hook" | "legacy-backfill";
export type CursorEventStatus = "completed" | "aborted" | "error";
export type CursorTimestampConfidence = "exact" | "hook-receipt" | "approximate";

/** Versioned internal record consumed by CursorCollector. */
export interface CursorUsageEventV1 {
  schema: typeof CURSOR_EVENT_SCHEMA;
  source: CursorEventSource;
  receivedAt: string;

  conversationId: string;
  generationId: string;
  cursorVersion: string | null;
  modelId: string | null;
  legacyModel: string | null;
  workspaceRoot: string | null;
  status: CursorEventStatus | null;

  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;

  occurredAt: string;
  timestampConfidence: CursorTimestampConfidence;

  /** Optional allowlisted producer flags (multi-root ambiguity). */
  flags?: string[];
}

/**
 * Validate a token counter from untrusted input. Accepts only
 * non-negative, integral, finite, safe-integer numbers; everything else
 * (negative, fractional, non-finite, unsafe, non-numeric) is "absent".
 */
export function safeCursorToken(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number") return null;
  if (!Number.isFinite(n)) return null;
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Read a field from a record trying snake_case then camelCase keys. */
function field(rec: Record<string, unknown>, snake: string): unknown {
  if (snake in rec) return rec[snake];
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return rec[camel];
}

function pickStatus(value: unknown): CursorEventStatus | null {
  const s = pickString(value);
  if (s === "completed" || s === "aborted" || s === "error") return s;
  return null;
}

function pickTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

export interface SanitizeOptions {
  /** Canonical workspace root (CURSOR_PROJECT_DIR), highest priority. */
  projectDir?: string | null;
  receivedAt?: string;
}

/**
 * Construct a sanitized event from a raw stop-hook payload using an explicit
 * allowlist. Unknown fields — including any future Cursor additions — are
 * ignored. Returns null when identity fields are missing (nothing is written).
 */
export function sanitizeStopHookPayload(raw: unknown, opts: SanitizeOptions = {}): CursorUsageEventV1 | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;

  const conversationId = pickString(field(rec, "conversation_id"));
  const generationId = pickString(field(rec, "generation_id"));
  if (!conversationId || !generationId) return null;

  // Workspace attribution: CURSOR_PROJECT_DIR wins; a single workspace root is
  // accepted; genuinely multi-root payloads stay unattributed with a flag.
  let workspaceRoot = pickString(opts.projectDir ?? null);
  const flags: string[] = [];
  if (!workspaceRoot) {
    const roots = Array.isArray(rec.workspace_roots)
      ? rec.workspace_roots.filter((r): r is string => typeof r === "string" && r.length > 0)
      : [];
    const single = Array.isArray(rec.workspace_root) ? null : pickString(rec.workspace_root);
    if (single) workspaceRoot = single;
    else if (roots.length === 1) workspaceRoot = roots[0];
    else if (roots.length > 1) flags.push("multi-root-project-ambiguous");
  }

  const receivedAt = opts.receivedAt ?? new Date().toISOString();
  const exact = pickTimestamp(field(rec, "occurred_at") ?? field(rec, "timestamp"));
  const occurredAt = exact ?? receivedAt;

  const modelId = pickString(field(rec, "model_id"));
  const legacyModel = pickString(field(rec, "model"));

  const event: CursorUsageEventV1 = {
    schema: CURSOR_EVENT_SCHEMA,
    source: "stop-hook",
    receivedAt,
    conversationId,
    generationId,
    cursorVersion: pickString(field(rec, "cursor_version")),
    modelId,
    legacyModel,
    workspaceRoot,
    status: pickStatus(field(rec, "status")),
    inputTokens: safeCursorToken(field(rec, "input_tokens")),
    outputTokens: safeCursorToken(field(rec, "output_tokens")),
    cacheReadTokens: safeCursorToken(field(rec, "cache_read_tokens")),
    cacheWriteTokens: safeCursorToken(field(rec, "cache_write_tokens")),
    reasoningTokens: safeCursorToken(field(rec, "reasoning_tokens")),
    occurredAt,
    timestampConfidence: exact ? "exact" : "hook-receipt",
  };
  if (flags.length > 0) event.flags = flags;
  return event;
}

export type CursorEventValidation =
  | { ok: true; event: CursorUsageEventV1 }
  | { ok: false; reason: "malformed-json" | "unknown-schema" | "invalid-token-value" };

/**
 * Collector-side validation of a spooled record. Defensive re-validation:
 * the producers already sanitize, but the spool is on disk and could be
 * stale, hand-edited, or written by a newer/older hook. Re-validates token
 * values so a corrupted counter can never reach an envelope.
 */
export function validateCursorEventRecord(raw: unknown): CursorEventValidation {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "malformed-json" };
  }
  const rec = raw as Record<string, unknown>;
  if (rec.schema !== CURSOR_EVENT_SCHEMA) return { ok: false, reason: "unknown-schema" };

  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
    const value = rec[key];
    if (value === undefined || value === null) continue;
    if (safeCursorToken(value) === null) return { ok: false, reason: "invalid-token-value" };
  }

  const flags = Array.isArray(rec.flags)
    ? (rec.flags as unknown[]).filter(
        (f): f is (typeof CURSOR_EVENT_FLAG_ALLOWLIST)[number] =>
          typeof f === "string" && (CURSOR_EVENT_FLAG_ALLOWLIST as readonly string[]).includes(f),
      )
    : [];

  const event: CursorUsageEventV1 = {
    schema: CURSOR_EVENT_SCHEMA,
    source: rec.source === "legacy-backfill" ? "legacy-backfill" : "stop-hook",
    receivedAt: pickString(rec.receivedAt) ?? new Date().toISOString(),
    conversationId: pickString(rec.conversationId) ?? "",
    generationId: pickString(rec.generationId) ?? "",
    cursorVersion: pickString(rec.cursorVersion),
    modelId: pickString(rec.modelId),
    legacyModel: pickString(rec.legacyModel),
    workspaceRoot: pickString(rec.workspaceRoot),
    status: pickStatus(rec.status),
    inputTokens: safeCursorToken(rec.inputTokens),
    outputTokens: safeCursorToken(rec.outputTokens),
    cacheReadTokens: safeCursorToken(rec.cacheReadTokens),
    cacheWriteTokens: safeCursorToken(rec.cacheWriteTokens),
    reasoningTokens: safeCursorToken(rec.reasoningTokens),
    occurredAt: pickTimestamp(rec.occurredAt) ?? new Date().toISOString(),
    timestampConfidence:
      rec.timestampConfidence === "exact" || rec.timestampConfidence === "approximate"
        ? rec.timestampConfidence
        : "hook-receipt",
  };
  if (!event.conversationId || !event.generationId) return { ok: false, reason: "malformed-json" };
  if (flags.length > 0) event.flags = flags;
  return { ok: true, event };
}

/** True when a stop event carries no token accounting at all (e.g. Cmd+K). */
export function isTokenlessEvent(event: CursorUsageEventV1): boolean {
  return (
    event.inputTokens == null &&
    event.outputTokens == null &&
    event.cacheReadTokens == null &&
    event.cacheWriteTokens == null
  );
}

/** True when every present counter is zero — not a real API request. */
export function isZeroVectorEvent(event: CursorUsageEventV1): boolean {
  const present = [event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens];
  return present.some((v) => v != null) && present.every((v) => v == null || v === 0);
}

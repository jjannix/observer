// Source of the standalone Observer stop-hook script. The sanitization
// allowlist mirrors sanitizeStopHookPayload in ./event.ts; the parity test
// executes this script end-to-end so the two cannot silently drift.
// Failure policy: fail-open on every error, never log the received payload.

const TEMPLATE = String.raw`"use strict";
// Observer stop hook (observer.cursor.usage.v1). Deployed by 'observer cursor install-hook'.
// Reads Cursor's stop payload from stdin, keeps ONLY the allowlisted
// accounting/identity fields, writes one sanitized JSON line into Observer's
// spool, and prints {} — Cursor treats any failure as "proceed".
var SPOOL_ROOT = "__OBSERVER_CURSOR_SPOOL_ROOT__";
var MAX_STDIN_BYTES = 1024 * 1024;
var FAILURE_LOG_CAP = 64 * 1024;
var CRYPTO = require("crypto");
var FS = require("fs");
var PATH = require("path");

function failOpen(reason) {
  try {
    var logPath = PATH.join(SPOOL_ROOT, ".hook-failures.log");
    try {
      if (FS.statSync(logPath).size > FAILURE_LOG_CAP) FS.writeFileSync(logPath, "");
    } catch (e) { /* first failure */ }
    FS.appendFileSync(logPath, new Date().toISOString() + " " + reason + "\n");
  } catch (e2) { /* never block */ }
  try { process.stdout.write("{}\n"); } catch (e3) { /* ignore */ }
  process.exit(0);
}

function readStdin(cb) {
  var chunks = [];
  var total = 0;
  var done = false;
  process.stdin.on("data", function (chunk) {
    if (done) return;
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) { done = true; cb(null); return; }
    chunks.push(chunk);
  });
  process.stdin.on("end", function () { if (!done) { done = true; cb(Buffer.concat(chunks)); } });
  process.stdin.on("error", function () { if (!done) { done = true; cb(null); } });
}

function str(v) { return typeof v === "string" && v.length > 0 ? v : null; }
function pick(rec, snake) {
  if (Object.prototype.hasOwnProperty.call(rec, snake)) return rec[snake];
  var camel = snake.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); });
  return rec[camel];
}
function token(v) {
  var n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !isFinite(n) || !Number.isSafeInteger(n) || n < 0) return null;
  return n;
}
function status(v) {
  var s = str(v);
  return s === "completed" || s === "aborted" || s === "error" ? s : null;
}
function occurred(v) {
  if (typeof v === "number" && isFinite(v) && v > 0) return new Date(v).toISOString();
  if (typeof v === "string") {
    var ms = Date.parse(v);
    if (isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

readStdin(function (buf) {
  if (!buf) failOpen("stdin-too-large");
  var text = buf.toString("utf8");
  // Cursor sends a UTF-8 BOM prefix; JSON.parse rejects it.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  var raw;
  try { raw = JSON.parse(text); } catch (e) { failOpen("payload-not-json"); return; }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) { failOpen("payload-not-object"); return; }
  var rec = raw;

  var conversationId = str(pick(rec, "conversation_id"));
  var generationId = str(pick(rec, "generation_id"));
  if (!conversationId || !generationId) { failOpen("identity-missing"); return; }

  var flags = [];
  var workspaceRoot = str(process.env.CURSOR_PROJECT_DIR || null);
  if (!workspaceRoot) {
    var roots = Array.isArray(rec.workspace_roots)
      ? rec.workspace_roots.filter(function (r) { return typeof r === "string" && r.length > 0; })
      : [];
    var single = !Array.isArray(rec.workspace_root) ? str(rec.workspace_root) : null;
    if (single) workspaceRoot = single;
    else if (roots.length === 1) workspaceRoot = roots[0];
    else if (roots.length > 1) flags.push("multi-root-project-ambiguous");
  }

  var receivedAt = new Date().toISOString();
  var exact = occurred(pick(rec, "occurred_at") || pick(rec, "timestamp"));
  var event = {
    schema: "observer.cursor.usage.v1",
    source: "stop-hook",
    receivedAt: receivedAt,
    conversationId: conversationId,
    generationId: generationId,
    cursorVersion: str(pick(rec, "cursor_version")),
    modelId: str(pick(rec, "model_id")),
    legacyModel: str(pick(rec, "model")),
    workspaceRoot: workspaceRoot,
    status: status(pick(rec, "status")),
    inputTokens: token(pick(rec, "input_tokens")),
    outputTokens: token(pick(rec, "output_tokens")),
    cacheReadTokens: token(pick(rec, "cache_read_tokens")),
    cacheWriteTokens: token(pick(rec, "cache_write_tokens")),
    reasoningTokens: token(pick(rec, "reasoning_tokens")),
    occurredAt: exact || receivedAt,
    timestampConfidence: exact ? "exact" : "hook-receipt"
  };
  if (flags.length > 0) event.flags = flags;

  try {
    var day = receivedAt.slice(0, 10);
    var dir = PATH.join(SPOOL_ROOT, "live", day);
    FS.mkdirSync(dir, { recursive: true });
    var stamp = receivedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    var genHash = CRYPTO.createHash("sha256").update(generationId, "utf8").digest("hex").slice(0, 16);
    var rand = CRYPTO.randomBytes(4).toString("hex");
    var finalPath = PATH.join(dir, stamp + "-" + genHash + "-" + rand + ".jsonl");
    var tmpPath = finalPath + ".tmp-" + process.pid + "-" + rand;
    var line = JSON.stringify(event) + "\n";
    var fd = FS.openSync(tmpPath, "wx");
    try {
      FS.writeSync(fd, line, null, "utf8");
      try { FS.fsyncSync(fd); } catch (e) { /* flush is best-effort */ }
    } finally {
      FS.closeSync(fd);
    }
    FS.renameSync(tmpPath, finalPath);
  } catch (e) {
    failOpen("spool-write-failed");
    return;
  }
  try { process.stdout.write("{}\n"); } catch (e2) { /* ignore */ }
  process.exit(0);
});
`;

/** Placeholder replaced with the resolved spool root at install time. */
const SPOOL_ROOT_PLACEHOLDER = "__OBSERVER_CURSOR_SPOOL_ROOT__";

/** Build the exact script content deployed for a given spool root. */
export function buildStopHookScript(spoolRoot: string): string {
  if (spoolRoot.includes(SPOOL_ROOT_PLACEHOLDER)) {
    throw new Error("spool root collides with the template placeholder");
  }
  return TEMPLATE.split(`"${SPOOL_ROOT_PLACEHOLDER}"`).join(JSON.stringify(spoolRoot));
}

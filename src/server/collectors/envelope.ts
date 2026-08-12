import { createHash } from "node:crypto";
import type { RawUsageEnvelope } from "@shared/contracts";

/**
 * Compute a stable hash of a raw usage envelope. Used for deduplication and
 * raw-record identity. Two structurally identical envelopes produce the same
 * hash regardless of key insertion order.
 */
export function hashEnvelope(envelope: Omit<RawUsageEnvelope, "envelopeHash">): string {
  const canonical = JSON.stringify(sortKeys(envelope));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Privacy guard: assert that a parsed JSON value contains none of the
 * forbidden content keys. Raw envelopes must never carry prompts, content,
 * tool inputs, or tool outputs.
 */
const FORBIDDEN_KEYS = new Set([
  "prompt",
  "content",
  "text",
  "input",
  "output",
  "tool_input",
  "tool_output",
  "function_call",
  "tool_calls",
  "messages",
  "body",
  "snippet",
  "code",
]);

export function containsForbiddenContent(value: unknown, depth = 0): boolean {
  if (depth > 6 || value == null) return false;
  if (Array.isArray(value)) {
    return value.some((v) => containsForbiddenContent(v, depth + 1));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      // Allow explicit accounting field named "input"/"output" only at the
      // token-usage level (numbers). Nested object "input"/"output" of other
      // shapes is suspicious.
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        const v = obj[key];
        if (typeof v === "number") continue;
        if (typeof v === "string" && v.length > 0) return true;
        if (v && typeof v === "object") return true;
      }
      if (containsForbiddenContent(obj[key], depth + 1)) return true;
    }
  }
  return false;
}

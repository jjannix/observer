import { open } from "node:fs/promises";

const CHUNK = 256 * 1024;

export interface Line {
  /** 1-based ordinal within the file (counting from the first line ever). */
  ordinal: number;
  text: string;
}

export interface ReadLinesResult {
  lines: Line[];
  /** Byte offset at end of last fully consumed line (next sync starts here). */
  byteCursor: number;
  /** Total count of fully consumed lines. */
  lineCursor: number;
  /** True if EOF was reached and a partial trailing line remains unwritten. */
  reachedEof: boolean;
}

/**
 * Read complete JSONL lines from a file starting at a byte cursor, without
 * loading the whole file into memory. A trailing partial line (no newline yet)
 * is never consumed — its bytes are retained for the next pass.
 */
export async function readCompleteLines(
  path: string,
  byteCursor: number,
  lineCursor: number,
  maxLines = Number.POSITIVE_INFINITY,
): Promise<ReadLinesResult> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } catch {
    /* ignore */
  }

  const lines: Line[] = [];
  // `readOffset` is the physical file position already loaded into memory.
  // The returned cursor is the end of the last complete line, which can lag
  // behind it while a partial/tail buffer is held.
  let readOffset = byteCursor;
  let committedOffset = byteCursor;
  let ordinal = lineCursor;
  let leftover = Buffer.alloc(0);
  let reachedEof = false;

  // Read at least one chunk to detect EOF / partial state.
  for (;;) {
    const buf = Buffer.alloc(CHUNK);
    const { bytesRead } = await handle.read(buf, 0, CHUNK, readOffset);
    if (bytesRead === 0) {
      reachedEof = true;
      break;
    }
    const data = buf.subarray(0, bytesRead);
    readOffset += bytesRead;
    const combined = leftover.length > 0 ? Buffer.concat([leftover, data]) : data;

    let lineStart = 0;
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] === 0x0a /* \n */) {
        const raw = combined.subarray(lineStart, i);
        const text = stripTrailingCr(raw).toString("utf8");
        ordinal += 1;
        lines.push({ ordinal, text });
        lineStart = i + 1;
        if (lines.length >= maxLines) break;
      }
    }
    leftover = combined.subarray(lineStart);
    committedOffset = readOffset - leftover.length;
    if (lines.length >= maxLines) break;
    if (bytesRead < CHUNK) {
      // We've read everything currently in the file. Whatever remains in
      // `leftover` is a partial trailing line (no newline) — leave it.
      reachedEof = true;
      break;
    }
  }

  await handle.close();

  return {
    lines,
    byteCursor: committedOffset,
    lineCursor: ordinal,
    reachedEof,
  };
}

function stripTrailingCr(buf: Buffer): Buffer {
  if (buf.length > 0 && buf[buf.length - 1] === 0x0d /* \r */) {
    return buf.subarray(0, buf.length - 1);
  }
  return buf;
}

/** Best-effort schema fingerprint: cheap structural signature of a JSONL file. */
export async function probeJsonlFingerprint(path: string, adapterVersion: string, sample = 4): Promise<string> {
  const handle = await open(path, "r");
  const buf = Buffer.alloc(64 * 1024);
  const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, 64 * 1024), 0);
  await handle.close();
  const text = buf.subarray(0, bytesRead).toString("utf8");
  const firstLines = text.split("\n").filter((l) => l.trim().length > 0).slice(0, sample);
  const shape = firstLines
    .map((l) => {
      try {
        return shapeSignature(JSON.parse(l));
      } catch {
        return "?";
      }
    })
    .join("|");
  let h = 5381;
  const s = `${adapterVersion}:${shape}`;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

function shapeSignature(value: unknown, depth = 0): string {
  if (depth > 4) return "?";
  if (value === null || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return `[${value.length > 0 ? shapeSignature(value[0], depth + 1) : ""}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.slice(0, 16).join(",")}}`;
}

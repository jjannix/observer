import type { HarnessId, RawUsageEnvelope, TokenUsageRecord } from "@shared/contracts";

/**
 * Stable collector contract. Adapters (Pi, Codex, OpenCode, Claude Code) all
 * implement this. The sync engine drives discovery and incremental collection;
 * collectors never touch the database directly.
 */

export interface DiscoveredFile {
  /** Stable identity independent of path (survives move/archive). */
  logicalSessionId: string;
  /** Absolute path on disk right now. */
  path: string;
  size: number;
  mtimeMs: number;
}

export interface CollectorContext {
  sourceId: string;
  historyCutoff: string | null;
}

export interface MessageNodeEmit {
  nodeId: string;
  parentId: string | null;
  role: string | null;
  turnId: string | null;
}

export interface UsageEmit {
  envelope: RawUsageEnvelope;
}

export interface QuarantineEmit {
  lineOrdinal: number;
  reason: string;
  partial: Partial<TokenUsageRecord> | null;
}

export type CollectEmit =
  | { kind: "usage"; usage: UsageEmit }
  | { kind: "node"; node: MessageNodeEmit }
  | { kind: "quarantine"; quarantine: QuarantineEmit };

export interface CollectResult {
  emits: CollectEmit[];
  /** Byte offset of the end of the last fully consumed line. */
  byteCursor: number;
  /** Count of fully consumed lines. */
  lineCursor: number;
  /** Opaque, collector-specific JSON state (e.g. message graph). */
  parserState: string | null;
  schemaFingerprint: string;
  schemaChanged: boolean;
}

export interface CollectFileOptions {
  byteCursor: number;
  lineCursor: number;
  parserState: string | null;
  ctx: CollectorContext;
  /** Bound memory and transaction size during historical backfills. */
  maxLines?: number;
}

export interface Collector {
  readonly harness: HarnessId;
  readonly adapterVersion: string;
  discover(root: string, ctx: CollectorContext): DiscoveredFile[];
  collectFile(file: DiscoveredFile, opts: CollectFileOptions): Promise<CollectResult>;
}

export class CollectionError extends Error {
  constructor(
    message: string,
    readonly logicalSessionId: string | null,
    readonly lineOrdinal: number | null,
  ) {
    super(message);
    this.name = "CollectionError";
  }
}

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { RawUsageEnvelope } from "@shared/contracts";
import { getCollector } from "../collectors/index.js";
import type { CollectEmit, Collector } from "../collectors/contract.js";
import type { ObserverConfig, SourceConfig } from "../config/schema.js";
import { Repository } from "./repository.js";
import { normalizeEnvelope, persistNormalized } from "./normalize.js";

const SYNC_BATCH_LINES = 500;

export type SyncTrigger = "startup" | "timer" | "manual" | "rebuild" | "renormalize";

export interface TriggerResult {
  runId: string;
  status: "coalesced" | "started";
}

export class SyncEngine {
  private activeRunId: string | null = null;
  private activePromise: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private repo: Repository,
    private getConfig: () => ObserverConfig,
  ) {}

  isActive(): boolean {
    return this.activeRunId !== null;
  }

  activeRun(): string | null {
    return this.activeRunId;
  }

  /** Start a run, or coalesce into the running one. */
  trigger(trigger: SyncTrigger): TriggerResult {
    if (this.activeRunId) {
      return { runId: this.activeRunId, status: "coalesced" };
    }
    const runId = randomUUID();
    this.activeRunId = runId;
    this.activePromise = this.execRun(runId, trigger, async () => {
      await this.runScan(runId, trigger);
    });
    return { runId, status: "started" };
  }

  async join(): Promise<void> {
    if (this.activePromise) await this.activePromise;
  }

  startInterval(intervalSeconds: number): void {
    this.stopInterval();
    if (intervalSeconds <= 0) return;
    this.timer = setInterval(() => {
      if (!this.activeRunId) this.trigger("timer");
    }, intervalSeconds * 1000);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stopInterval(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private execRun(runId: string, trigger: SyncTrigger, fn: () => Promise<void>): Promise<void> {
    const p = fn()
      .catch((err) => {
        try {
          this.repo.appendSyncRunError(runId, `fatal: ${(err as Error).message}`);
          this.repo.finishSyncRun(runId, new Date().toISOString(), "failed", [(err as Error).message]);
        } catch {
          /* ignore */
        }
      })
      .finally(() => {
        if (this.activeRunId === runId) {
          this.activeRunId = null;
          this.activePromise = null;
        }
      });
    void trigger;
    return p;
  }

  /* ------------------------------- main scan ------------------------------- */

  private async runScan(runId: string, trigger: SyncTrigger): Promise<void> {
    const config = this.getConfig();
    const startedAt = new Date().toISOString();
    const enabledSources = config.sources.filter((s) => s.enabled);

    this.repo.createSyncRun({ id: runId, trigger, startedAt, total: enabledSources.length });

    let totalImported = 0;
    let totalDuplicates = 0;
    let totalQuarantined = 0;
    const errors: string[] = [];

    for (let idx = 0; idx < enabledSources.length; idx++) {
      const source = enabledSources[idx];
      const startedSource = new Date().toISOString();
      this.repo.setSourceSyncTimes(source.id, startedSource, null);
      try {
        const counts = await this.syncSource(source, config, runId);
        totalImported += counts.imported;
        totalDuplicates += counts.duplicates;
        totalQuarantined += counts.quarantined;
      } catch (err) {
        const msg = `source ${source.id}: ${(err as Error).message}`;
        errors.push(msg);
        this.repo.setSourceError(source.id, (err as Error).message);
      } finally {
        this.repo.setSourceSyncTimes(source.id, startedSource, new Date().toISOString());
        this.repo.recomputeSourceCounts(source.id);
        this.repo.updateSyncRunProgress(
          runId,
          idx + 1,
          enabledSources.length,
          totalImported,
          totalDuplicates,
          totalQuarantined,
        );
      }
    }

    this.repo.finishSyncRun(runId, new Date().toISOString(), "completed", errors);
  }

  private async syncSource(
    source: SourceConfig,
    config: ObserverConfig,
    runId: string,
  ): Promise<{ imported: number; duplicates: number; quarantined: number }> {
    const collector = getCollector(source.harness);
    if (!collector) throw new Error(`no collector for harness ${source.harness}`);

    const present = existsSync(source.root);
    this.repo.setSourceError(source.id, null);
    this.repo.upsertCollectorSource(source, collector.adapterVersion, present);
    if (!present) {
      this.repo.markMissingSourceFiles(source.id, []);
      return { imported: 0, duplicates: 0, quarantined: 0 };
    }

    const ctx = { sourceId: source.id, historyCutoff: config.historyCutoff };
    const discovered = collector.discover(source.root, ctx);
    const now = new Date().toISOString();

    for (const f of discovered) {
      this.repo.upsertSourceFile({
        sourceId: source.id,
        logicalSessionId: f.logicalSessionId,
        currentPath: f.path,
        size: f.size,
        mtimeMs: f.mtimeMs,
        schemaFingerprint: null,
        lastSyncedAt: now,
      });
    }
    this.repo.markMissingSourceFiles(
      source.id,
      discovered.map((d) => d.logicalSessionId),
    );

    let imported = 0;
    let duplicates = 0;
    let quarantined = 0;

    for (const f of discovered) {
      const fileRow = this.repo.getSourceFile(source.id, f.logicalSessionId);
      if (!fileRow) continue;
      if (
        fileRow.size === f.size &&
        fileRow.mtimeMs === f.mtimeMs &&
        fileRow.byteCursor >= f.size &&
        f.size > 0
      ) {
        continue;
      }

      let byteCursor = fileRow.byteCursor;
      let lineCursor = fileRow.lineCursor;
      let parserState = fileRow.parserState;
      for (;;) {
        if (byteCursor >= f.size && f.size > 0) break;
        let result;
        try {
          result = await collector.collectFile(f, {
            byteCursor,
            lineCursor,
            parserState,
            maxLines: SYNC_BATCH_LINES,
            ctx,
          });
        } catch (err) {
          const msg = `file ${f.logicalSessionId}: ${(err as Error).message}`;
          this.repo.setSourceError(source.id, msg);
          this.repo.appendSyncRunError(runId, `source ${source.id} ${msg}`);
          break;
        }

        const previousByteCursor = byteCursor;
        const previousLineCursor = lineCursor;
        const tx = this.repoTx(() => {
          for (const emit of result.emits) {
            const outcome = this.applyEmit(emit, collector, source, fileRow.id, config, f);
            imported += outcome.imported;
            duplicates += outcome.duplicates;
            quarantined += outcome.quarantined;
          }
          this.repo.setSourceFileCursor(
            fileRow.id,
            result.byteCursor,
            result.lineCursor,
            result.parserState,
            new Date().toISOString(),
          );
        });
        if (!tx.ok) {
          this.repo.setSourceError(source.id, `file ${f.logicalSessionId}: ${tx.error}`);
          this.repo.appendSyncRunError(runId, `source ${source.id} file ${f.logicalSessionId}: ${tx.error}`);
          break;
        }

        byteCursor = result.byteCursor;
        lineCursor = result.lineCursor;
        parserState = result.parserState;
        if (byteCursor === previousByteCursor && lineCursor === previousLineCursor) break;
      }
    }

    return { imported, duplicates, quarantined };
  }

  private applyEmit(
    emit: CollectEmit,
    collector: Collector,
    source: SourceConfig,
    sourceFileId: number,
    config: ObserverConfig,
    file: { logicalSessionId: string },
  ): { imported: number; duplicates: number; quarantined: number } {
    if (emit.kind === "node") {
      this.repo.upsertMessageNode({
        sourceId: source.id,
        logicalSessionId: file.logicalSessionId,
        nodeId: emit.node.nodeId,
        parentId: emit.node.parentId,
        role: emit.node.role,
        turnId: emit.node.turnId,
        createdAt: new Date().toISOString(),
      });
      return { imported: 0, duplicates: 0, quarantined: 0 };
    }

    if (emit.kind === "quarantine") {
      const hash = `${emit.quarantine.reason}:${file.logicalSessionId}:${emit.quarantine.lineOrdinal}`;
      const { inserted } = this.repo.insertRawRecord({
        sourceId: source.id,
        sourceFileId,
        logicalSessionId: file.logicalSessionId,
        lineOrdinal: emit.quarantine.lineOrdinal,
        envelopeHash: hash,
        parserVersion: collector.adapterVersion,
        occurredAt: new Date().toISOString(),
        status: "quarantined",
        envelopeJson: JSON.stringify({ reason: emit.quarantine.reason, partial: emit.quarantine.partial ?? null }),
        qualityFlagsJson: JSON.stringify(["quarantined"]),
        createdAt: new Date().toISOString(),
      });
      return { imported: 0, duplicates: 0, quarantined: inserted ? 1 : 0 };
    }

    const envelope = emit.usage.envelope;
    const cutoff = config.historyCutoff;
    const withinCutoff = cutoff == null || envelope.occurredAt >= cutoff;

    const { inserted } = this.repo.insertRawRecord({
      sourceId: source.id,
      sourceFileId,
      logicalSessionId: envelope.logicalSessionId,
      lineOrdinal: envelope.lineOrdinal,
      envelopeHash: envelope.envelopeHash,
      parserVersion: collector.adapterVersion,
      occurredAt: envelope.occurredAt,
      status: "normalized",
      envelopeJson: JSON.stringify(envelope),
      qualityFlagsJson: JSON.stringify([]),
      createdAt: new Date().toISOString(),
    });
    if (!inserted) {
      return { imported: 0, duplicates: 1, quarantined: 0 };
    }

    if (withinCutoff) {
      const normalized = normalizeEnvelope(envelope as RawUsageEnvelope, config);
      persistNormalized(this.repo, envelope as RawUsageEnvelope, normalized);
    }
    return { imported: 1, duplicates: 0, quarantined: 0 };
  }

  private repoTx<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
    try {
      return { ok: true, value: this.repo.transaction(fn) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /* ----------------------------- renormalize ------------------------------- */

  renormalize(): TriggerResult {
    if (this.activeRunId) return { runId: this.activeRunId, status: "coalesced" };
    const runId = randomUUID();
    this.activeRunId = runId;
    this.activePromise = this.execRun(runId, "renormalize", async () => {
      const config = this.getConfig();
      this.repo.createSyncRun({ id: runId, trigger: "renormalize", startedAt: new Date().toISOString(), total: 1 });
      this.repo.clearAllNormalized();
      const all = this.repo.listAllRawRecords();
      let i = 0;
      for (const row of all) {
        if (row.normalization_status !== "normalized") continue;
        const envelope = JSON.parse(row.envelope_json) as RawUsageEnvelope;
        if (config.historyCutoff != null && envelope.occurredAt < config.historyCutoff) continue;
        const normalized = normalizeEnvelope(envelope, config);
        persistNormalized(this.repo, envelope, normalized);
        if (++i % 500 === 0) this.repo.updateSyncRunProgress(runId, i, all.length, 0, 0, 0);
      }
      for (const s of config.sources) this.repo.recomputeSourceCounts(s.id);
    });
    return { runId, status: "started" };
  }

  /** Clear Observer's index only and rescan. Never touches harness source data. */
  rebuild(): TriggerResult {
    if (this.activeRunId) return { runId: this.activeRunId, status: "coalesced" };
    const runId = randomUUID();
    this.activeRunId = runId;
    this.activePromise = this.execRun(runId, "rebuild", async () => {
      this.repo.clearAllIndex();
      await this.runScan(runId, "rebuild");
    });
    return { runId, status: "started" };
  }
}

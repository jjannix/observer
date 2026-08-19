import type { NormalizedUsageEvent, RawUsageEnvelope } from "@shared/contracts";
import { COLLECTOR_QUALITY_FLAGS, QUALITY_FLAGS } from "@shared/contracts";
import {
  canonicalizeProviderId,
  hashId,
  modelDisplay,
  providerDisplay,
  resolveDimensions,
  resolveProject,
} from "../normalization/canonical.js";
import {
  nanoToUsd,
  processedInput as pi,
  processedTokens as pt,
  usdToNano,
} from "../normalization/metrics.js";
import type { ObserverConfig } from "../config/schema.js";
import type { Repository } from "./repository.js";

export interface NormalizedRow {
  event: Omit<NormalizedUsageEvent, "costUsd"> & { costUsd: number | null; costNanoUsd: number | null };
}

/**
 * Resolve a retained raw envelope into a canonical usage event using the
 * current alias rules. Token fields are taken verbatim from the collector's
 * accounting (collectors enforce the canonical formulas); this layer only
 * resolves dimensions, attaches quality flags, and recomputes derived totals
 * defensively.
 */
export function normalizeEnvelope(envelope: RawUsageEnvelope, config: ObserverConfig): {
  project: ReturnType<typeof resolveProject>;
  dims: ReturnType<typeof resolveDimensions>;
  event: {
    harness: string;
    occurredAt: string;
    logicalSessionId: string;
    requestId: string;
    turnId: string | null;
    sessionId: string;
    projectId: string | null;
    rawProviderId: string | null;
    canonicalProviderId: string | null;
    providerResolution: string;
    rawModelId: string | null;
    canonicalModelId: string | null;
    processedInputTokens: number;
    freshInputTokens: number;
    cacheReadInputTokens: number;
    cacheWriteInputTokens: number;
    cacheWriteAvailable: boolean;
    outputTokens: number;
    reasoningOutputTokens: number | null;
    unattributedTokens: number;
    processedTokens: number;
    costNanoUsd: number | null;
    costAvailable: boolean;
    qualityFlags: string[];
  };
} {
  const u = envelope.usage;
  const processedInputTokens = pi(u.freshInputTokens, u.cacheReadInputTokens, u.cacheWriteInputTokens);
  const processedTokensValue = pt(processedInputTokens, u.outputTokens, u.unattributedTokens);

  const dims = resolveDimensions({
    harness: envelope.harness,
    rawProviderId: envelope.rawProviderId,
    rawModelId: envelope.rawModelId,
    cwd: envelope.cwd,
    occurredAt: envelope.occurredAt,
    providerAliases: config.providerAliases,
    providerOverrides: config.providerOverrides,
    modelAliases: config.modelAliases,
  });

  const project = resolveProject(envelope.cwd, config.projectAliases);

  const qualityFlags: string[] = [];
  if (!u.cacheWriteAvailable) qualityFlags.push(QUALITY_FLAGS.MISSING_CACHE_WRITE);
  if (!u.reasoningAvailable) qualityFlags.push(QUALITY_FLAGS.MISSING_REASONING);
  if (!u.costAvailable) qualityFlags.push(QUALITY_FLAGS.MISSING_COST);
  // Collector-supplied flags pass through an allowlist only — arbitrary
  // strings from source input are never propagated.
  if (Array.isArray(envelope.qualityFlags)) {
    for (const flag of envelope.qualityFlags) {
      if ((COLLECTOR_QUALITY_FLAGS as readonly string[]).includes(flag) && !qualityFlags.includes(flag)) {
        qualityFlags.push(flag);
      }
    }
  }

  return {
    project,
    dims,
    event: {
      harness: envelope.harness,
      occurredAt: envelope.occurredAt,
      logicalSessionId: envelope.logicalSessionId,
      requestId: envelope.requestId,
      turnId: envelope.turnId,
      sessionId: envelope.sessionId,
      projectId: project?.projectId ?? null,
      rawProviderId: envelope.rawProviderId,
      canonicalProviderId: dims.canonicalProviderId,
      providerResolution: dims.providerResolution,
      rawModelId: envelope.rawModelId,
      canonicalModelId: dims.canonicalModelId,
      processedInputTokens,
      freshInputTokens: u.freshInputTokens,
      cacheReadInputTokens: u.cacheReadInputTokens,
      cacheWriteInputTokens: u.cacheWriteInputTokens,
      cacheWriteAvailable: u.cacheWriteAvailable,
      outputTokens: u.outputTokens,
      reasoningOutputTokens: u.reasoningOutputTokens,
      unattributedTokens: u.unattributedTokens,
      processedTokens: processedTokensValue,
      costNanoUsd: u.costUsd != null ? usdToNano(u.costUsd) : null,
      costAvailable: u.costAvailable,
      qualityFlags,
    },
  };
}

/** Persist all dimension rows + the usage event for a normalized envelope. */
export function persistNormalized(
  repo: Repository,
  envelope: RawUsageEnvelope,
  normalized: ReturnType<typeof normalizeEnvelope>,
): void {
  const sessionId = `${envelope.harness}:${envelope.logicalSessionId}`;

  if (normalized.project) {
    repo.upsertProject({
      id: normalized.project.projectId,
      normalizedRootPath: normalized.project.normalizedRootPath,
      displayPath: normalized.project.displayPath,
      canonicalProject: normalized.project.canonicalProject,
    });
  }

  repo.upsertSession({
    id: sessionId,
    harness: envelope.harness,
    logicalSessionId: envelope.logicalSessionId,
    projectId: normalized.project?.projectId ?? null,
    cwd: envelope.cwd,
    firstSeen: envelope.occurredAt,
    lastSeen: envelope.occurredAt,
  });

  if (envelope.turnId) {
    const turnRowId = hashId("turn", `${sessionId}:${envelope.turnId}`);
    repo.upsertTurn({ id: turnRowId, sessionId, turnId: envelope.turnId, occurredAt: envelope.occurredAt });
  }

  const providerId = normalized.dims.canonicalProviderId ?? canonicalizeProviderId(envelope.rawProviderId) ?? `unknown:${envelope.harness}`;
  repo.upsertProvider({
    id: providerId,
    rawProviderId: envelope.rawProviderId,
    canonicalProviderId: normalized.dims.canonicalProviderId ?? providerId,
    display: providerDisplay(null, normalized.dims.canonicalProviderId, []),
  });

  const modelId = normalized.dims.canonicalModelId ?? envelope.rawModelId ?? `unknown:${envelope.harness}`;
  repo.upsertModel({
    id: modelId,
    canonicalModelId: normalized.dims.canonicalModelId ?? modelId,
    rawModelId: envelope.rawModelId,
    owner: normalized.dims.owner,
    display: modelDisplay(envelope.rawModelId, normalized.dims.canonicalModelId),
  });

  const eventId = hashId("event", `${envelope.harness}:${envelope.logicalSessionId}:${envelope.requestId}`);
  repo.upsertUsageEvent({
    id: eventId,
    rawRecordId: null,
    harness: envelope.harness,
    occurredAt: normalized.event.occurredAt,
    sessionId,
    logicalSessionId: envelope.logicalSessionId,
    turnId: envelope.turnId,
    requestId: envelope.requestId,
    projectId: normalized.project?.projectId ?? null,
    rawProviderId: normalized.event.rawProviderId,
    canonicalProviderId: normalized.event.canonicalProviderId,
    providerResolution: normalized.event.providerResolution,
    rawModelId: normalized.event.rawModelId,
    canonicalModelId: normalized.event.canonicalModelId,
    processedInputTokens: normalized.event.processedInputTokens,
    freshInputTokens: normalized.event.freshInputTokens,
    cacheReadInputTokens: normalized.event.cacheReadInputTokens,
    cacheWriteInputTokens: normalized.event.cacheWriteInputTokens,
    cacheWriteAvailable: normalized.event.cacheWriteAvailable,
    outputTokens: normalized.event.outputTokens,
    reasoningOutputTokens: normalized.event.reasoningOutputTokens,
    unattributedTokens: normalized.event.unattributedTokens,
    processedTokens: normalized.event.processedTokens,
    costNanoUsd: normalized.event.costNanoUsd,
    costAvailable: normalized.event.costAvailable,
    qualityFlagsJson: JSON.stringify(normalized.event.qualityFlags),
  });
}

export { nanoToUsd };

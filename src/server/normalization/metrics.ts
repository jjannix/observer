import type { NormalizedUsageEvent } from "@shared/contracts";

/**
 * Canonical metric definitions and weighted aggregate formulas.
 *
 * Weighted aggregate ratios ALWAYS use summed numerators and denominators —
 * never averages of per-event percentages.
 */

export const NANO = 1_000_000_000;

export function usdToNano(usd: number): number {
  return Math.round(usd * NANO);
}

export function nanoToUsd(nano: number | null): number | null {
  if (nano == null) return null;
  return nano / NANO;
}

/** processedInput = freshInput + cacheRead + cacheWrite */
export function processedInput(fresh: number, cacheRead: number, cacheWrite: number): number {
  return fresh + cacheRead + cacheWrite;
}

/** processedTokens = processedInput + output + unattributed */
export function processedTokens(processedInputTokens: number, output: number, unattributed: number): number {
  return processedInputTokens + output + unattributed;
}

/** Clamp a ratio to a finite value or null when denominator is 0/missing. */
export function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator === 0 || !Number.isFinite(denominator)) return null;
  return numerator / denominator;
}

export interface AggregatedSums {
  processedInputTokens: number;
  freshInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  unattributedTokens: number;
  processedTokens: number;
  costNanoUsd: number;
  costCoverageProcessedTokens: number;
  classifiedInputOutputTokens: number;
  cacheWriteCoveredReadTokens: number;
  cacheWriteCoveredWriteTokens: number;
  distinctSessions: Set<string>;
  distinctTurns: Set<string>;
  distinctRequests: number;
  reasoningAvailableCount: number;
  cacheWriteAvailableCount: number;
  costAvailableCount: number;
  totalCount: number;
}

export function newAggregatedSums(): AggregatedSums {
  return {
    processedInputTokens: 0,
    freshInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    unattributedTokens: 0,
    processedTokens: 0,
    costNanoUsd: 0,
    costCoverageProcessedTokens: 0,
    classifiedInputOutputTokens: 0,
    cacheWriteCoveredReadTokens: 0,
    cacheWriteCoveredWriteTokens: 0,
    distinctSessions: new Set(),
    distinctTurns: new Set(),
    distinctRequests: 0,
    reasoningAvailableCount: 0,
    cacheWriteAvailableCount: 0,
    costAvailableCount: 0,
    totalCount: 0,
  };
}

export function accumulateEvent(sums: AggregatedSums, e: NormalizedUsageEvent): void {
  sums.processedInputTokens += e.processedInputTokens;
  sums.freshInputTokens += e.freshInputTokens;
  sums.cacheReadInputTokens += e.cacheReadInputTokens;
  sums.cacheWriteInputTokens += e.cacheWriteInputTokens;
  sums.outputTokens += e.outputTokens;
  sums.reasoningOutputTokens += e.reasoningOutputTokens ?? 0;
  sums.unattributedTokens += e.unattributedTokens;
  sums.processedTokens += e.processedTokens;

  if (e.costUsd != null) {
    sums.costNanoUsd += usdToNano(e.costUsd);
    sums.costCoverageProcessedTokens += e.processedTokens;
    sums.costAvailableCount += 1;
  }
  // Classification coverage: input/output tokens are "classified" when both
  // categories are represented. We approximate with processed input + output
  // being attributable (unattributed excluded by definition).
  sums.classifiedInputOutputTokens += e.processedInputTokens + e.outputTokens;

  // Cache reuse efficiency needs complete cache-write coverage.
  if (e.cacheWriteAvailable) {
    sums.cacheWriteCoveredReadTokens += e.cacheReadInputTokens;
    sums.cacheWriteCoveredWriteTokens += e.cacheWriteInputTokens;
    sums.cacheWriteAvailableCount += 1;
  }
  if (e.reasoningOutputTokens != null) sums.reasoningAvailableCount += 1;

  if (e.sessionId) sums.distinctSessions.add(e.sessionId);
  if (e.turnId) sums.distinctTurns.add(`${e.sessionId}::${e.turnId}`);
  sums.distinctRequests += 1;
  sums.totalCount += 1;
}

export interface ComputedRatios {
  cacheHitRate: number | null;
  cacheReuseEfficiency: number | null;
  outputInputRatio: number | null;
  costCoverage: number | null;
  classificationCoverage: number | null;
}

export function computeRatios(sums: AggregatedSums): ComputedRatios {
  const cacheHitRate = safeRatio(sums.cacheReadInputTokens, sums.processedInputTokens);
  // Only valid when cache-write coverage is complete and denominator non-zero.
  const cacheWriteCoverageComplete =
    sums.cacheWriteAvailableCount === sums.totalCount && sums.totalCount > 0;
  const cacheReuseEfficiency =
    cacheWriteCoverageComplete && sums.cacheWriteCoveredWriteTokens > 0
      ? safeRatio(sums.cacheWriteCoveredReadTokens, sums.cacheWriteCoveredWriteTokens)
      : null;
  const outputInputRatio = safeRatio(sums.outputTokens, sums.processedInputTokens);
  const costCoverage = safeRatio(sums.costCoverageProcessedTokens, sums.processedTokens);
  const classificationCoverage = safeRatio(sums.classifiedInputOutputTokens, sums.processedTokens);
  return { cacheHitRate, cacheReuseEfficiency, outputInputRatio, costCoverage, classificationCoverage };
}

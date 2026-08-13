import { describe, it, expect } from "vitest";
import {
  accumulateEvent,
  computeRatios,
  newAggregatedSums,
  nanoToUsd,
  usdToNano,
  processedInput,
  processedTokens,
  safeRatio,
} from "../../src/server/normalization/metrics.js";
import { resolveDimensions, canonicalizeModelId, canonicalizeProviderId, stripRoutingPrefix, modelOwner, resolveProject } from "../../src/server/normalization/canonical.js";
import { SEED_MODEL_ALIASES, SEED_PROVIDER_ALIASES } from "../../src/server/config/schema.js";
import type { NormalizedUsageEvent } from "../../src/shared/contracts.js";

function ev(partial: Partial<NormalizedUsageEvent>): NormalizedUsageEvent {
  const base: NormalizedUsageEvent = {
    id: "x",
    harness: "pi",
    occurredAt: "2025-01-01T00:00:00Z",
    projectId: null,
    sessionId: "s1",
    turnId: "t1",
    requestId: "r1",
    rawProviderId: "openai",
    canonicalProviderId: "openai",
    providerResolution: "source",
    rawModelId: "gpt-5",
    canonicalModelId: "openai/gpt-5",
    processedInputTokens: 0,
    freshInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheWriteAvailable: true,
    outputTokens: 0,
    reasoningOutputTokens: null,
    unattributedTokens: 0,
    processedTokens: 0,
    costUsd: null,
    qualityFlags: [],
  };
  return { ...base, ...partial };
}

describe("metric definitions", () => {
  it("processedInput = fresh + cacheRead + cacheWrite", () => {
    expect(processedInput(100, 20, 30)).toBe(150);
  });

  it("processedTokens = processedInput + output + unattributed", () => {
    expect(processedTokens(150, 40, 5)).toBe(195);
  });

  it("safeRatio returns null for zero denominator", () => {
    expect(safeRatio(10, 0)).toBeNull();
    expect(safeRatio(10, 2)).toBeCloseTo(5);
  });

  it("nanoUsd round-trips", () => {
    expect(nanoToUsd(usdToNano(0.001234567))).toBeCloseTo(0.001234567, 9);
  });
});

describe("weighted aggregate ratios", () => {
  it("cache hit rate uses summed numerators/denominators", () => {
    const sums = newAggregatedSums();
    accumulateEvent(sums, ev({ freshInputTokens: 100, cacheReadInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 50, processedInputTokens: 200, processedTokens: 250 }));
    accumulateEvent(sums, ev({ requestId: "r2", turnId: "t2", freshInputTokens: 300, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, processedInputTokens: 300, processedTokens: 310 }));
    const { cacheHitRate } = computeRatios(sums);
    // 100 / (200 + 300) = 0.2, not avg(0.5, 0)
    expect(cacheHitRate).toBeCloseTo(0.2, 6);
  });

  it("cost coverage = processed-token share with reported cost", () => {
    const sums = newAggregatedSums();
    accumulateEvent(sums, ev({ requestId: "r1", processedTokens: 100, costUsd: 0.01 }));
    accumulateEvent(sums, ev({ requestId: "r2", processedTokens: 300, costUsd: null }));
    const { costCoverage } = computeRatios(sums);
    expect(costCoverage).toBeCloseTo(0.25, 6); // 100 / 400
  });

  it("cache reuse efficiency only valid with complete cache-write coverage", () => {
    const sums = newAggregatedSums();
    accumulateEvent(sums, ev({ requestId: "r1", freshInputTokens: 10, cacheReadInputTokens: 100, cacheWriteInputTokens: 50, outputTokens: 0, processedInputTokens: 160, processedTokens: 160, cacheWriteAvailable: true }));
    const { cacheReuseEfficiency } = computeRatios(sums);
    expect(cacheReuseEfficiency).toBeCloseTo(2, 6); // 100 / 50
  });

  it("cache reuse efficiency is null when cache-write coverage incomplete", () => {
    const sums = newAggregatedSums();
    accumulateEvent(sums, ev({ requestId: "r1", cacheReadInputTokens: 100, cacheWriteInputTokens: 50, cacheWriteAvailable: true, processedInputTokens: 150, processedTokens: 150 }));
    accumulateEvent(sums, ev({ requestId: "r2", cacheReadInputTokens: 10, cacheWriteInputTokens: 0, cacheWriteAvailable: false, processedInputTokens: 10, processedTokens: 10 }));
    const { cacheReuseEfficiency } = computeRatios(sums);
    expect(cacheReuseEfficiency).toBeNull();
  });

  it("output/input ratio uses sums", () => {
    const sums = newAggregatedSums();
    accumulateEvent(sums, ev({ requestId: "r1", processedInputTokens: 100, outputTokens: 50, processedTokens: 150 }));
    accumulateEvent(sums, ev({ requestId: "r2", processedInputTokens: 100, outputTokens: 150, processedTokens: 250 }));
    const { outputInputRatio } = computeRatios(sums);
    // (50+150)/(100+100) = 1.0
    expect(outputInputRatio).toBeCloseTo(1.0, 6);
  });
});

describe("canonical model keys", () => {
  it("removes routing prefix and lowercases", () => {
    expect(stripRoutingPrefix("~openai/gpt-5")).toBe("openai/gpt-5");
    expect(canonicalizeModelId("~gpt-5", "openai")).toBe("openai/gpt-5");
  });

  it("combines known owner with model id", () => {
    expect(canonicalizeModelId("gpt-5")).toBe("openai/gpt-5");
    expect(canonicalizeModelId("claude-sonnet-4")).toBe("anthropic/claude-sonnet-4");
  });

  it("modelOwner resolves known ids", () => {
    expect(modelOwner("GPT-5")).toBe("openai");
    expect(modelOwner("unknown-model")).toBeNull();
  });

  it("routed (openrouter) and direct forms share canonical model via seed alias", () => {
    const dims = resolveDimensions({
      harness: "codex",
      rawProviderId: "openrouter",
      rawModelId: "gpt-5",
      cwd: null,
      occurredAt: "2025-01-01T00:00:00Z",
      providerAliases: SEED_PROVIDER_ALIASES,
      providerOverrides: [],
      modelAliases: SEED_MODEL_ALIASES,
    });
    expect(dims.canonicalModelId).toBe("openai/gpt-5");
    // Provider attribution stays separate.
    expect(dims.canonicalProviderId).toBe("openrouter");
  });
});

describe("canonical provider keys", () => {
  it("rolls the Codex subscription route into OpenAI", () => {
    expect(canonicalizeProviderId("openai-codex")).toBe("openai");
    const dims = resolveDimensions({
      harness: "pi",
      rawProviderId: "openai-codex",
      rawModelId: "gpt-5.6-sol",
      cwd: null,
      occurredAt: "2026-08-13T00:00:00Z",
      providerAliases: SEED_PROVIDER_ALIASES,
      providerOverrides: [],
      modelAliases: SEED_MODEL_ALIASES,
    });
    expect(dims.rawProviderId).toBe("openai-codex");
    expect(dims.canonicalProviderId).toBe("openai");
    expect(dims.providerResolution).toBe("seed-alias");
  });
});

describe("Claude model ownership", () => {
  it("recognizes point-release and dated Claude model ids", () => {
    const dims = resolveDimensions({
      harness: "claude-code",
      rawProviderId: null,
      rawModelId: "claude-opus-4-6-20260801",
      cwd: null,
      occurredAt: "2026-08-13T00:00:00Z",
      providerAliases: SEED_PROVIDER_ALIASES,
      providerOverrides: [],
      modelAliases: SEED_MODEL_ALIASES,
    });
    expect(dims.canonicalProviderId).toBeNull();
    expect(dims.owner).toBe("anthropic");
    expect(dims.canonicalModelId).toBe("anthropic/claude-opus-4-6-20260801");
  });
});

describe("project resolution", () => {
  it("resolves cwd upward to git root when present", () => {
    // Resolve on a non-git temp path simply returns the normalized path.
    const p = resolveProject("C:/proj/alpha", []);
    expect(p).not.toBeNull();
    expect(p!.projectId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("retains recorded path when directory does not exist", () => {
    const p = resolveProject("Z:/does/not/exist", []);
    expect(p).not.toBeNull();
    expect(p!.normalizedRootPath).toBe(resolveProject("Z:/does/not/exist", [])!.normalizedRootPath);
  });
});

import type { HarnessId } from "@shared/contracts";
import type { Collector } from "./contract.js";
import { PiCollector } from "./pi/collector.js";
import { CodexCollector } from "./codex/collector.js";
import { ClaudeCodeCollector } from "./claude-code/collector.js";
import { OpenCodeCollector } from "./opencode/collector.js";

export { PiCollector, CodexCollector, ClaudeCodeCollector, OpenCodeCollector };
export * from "./contract.js";

const REGISTRY: Partial<Record<HarnessId, () => Collector>> = {
  pi: () => new PiCollector(),
  codex: () => new CodexCollector(),
  "claude-code": () => new ClaudeCodeCollector(),
  opencode: () => new OpenCodeCollector(),
};

export function getCollector(harness: HarnessId): Collector | null {
  const factory = REGISTRY[harness];
  return factory ? factory() : null;
}

import type { HarnessId } from "@shared/contracts";
import type { Collector } from "./contract.js";
import { PiCollector } from "./pi/collector.js";
import { CodexCollector } from "./codex/collector.js";

export { PiCollector, CodexCollector };
export * from "./contract.js";

const REGISTRY: Partial<Record<HarnessId, () => Collector>> = {
  pi: () => new PiCollector(),
  codex: () => new CodexCollector(),
};

export function getCollector(harness: HarnessId): Collector | null {
  const factory = REGISTRY[harness];
  return factory ? factory() : null;
}

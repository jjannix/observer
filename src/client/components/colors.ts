/** Deterministic categorical color for a provider. Simple, dark-friendly. */
const PALETTE = [
  "#60a5fa", // blue
  "#2dd4bf", // teal
  "#a78bfa", // violet
  "#f5b544", // amber
  "#f472b6", // pink
  "#34d399", // green
  "#fb7185", // rose
  "#22d3ee", // cyan
  "#c084fc", // purple
  "#fbbf24", // gold
  "#4ade80", // lime
  "#f97316", // orange
  "#818cf8", // indigo
  "#e879f9", // fuchsia
  "#2dd4a0", // emerald-teal
  "#facc15", // yellow
];

const assigned = new Map<string, string>();

/** Brand-inspired harness colors, tuned to remain legible on Observer's black canvas. */
export const HARNESS_COLORS = {
  pi: "#8B7CF6",
  codex: "#60A5FA",
  opencode: "#F2F2F2",
  "claude-code": "#D97757",
} as const;

export function colorForHarness(harness: string): string {
  const normalized = harness.trim().toLowerCase();
  if (normalized === "pi") return HARNESS_COLORS.pi;
  if (normalized === "codex") return HARNESS_COLORS.codex;
  if (normalized === "opencode" || normalized === "open code") return HARNESS_COLORS.opencode;
  if (normalized === "claude-code" || normalized === "claude code") return HARNESS_COLORS["claude-code"];
  return "#A2A2A2";
}

export function colorFor(provider: string): string {
  const existing = assigned.get(provider);
  if (existing) return existing;
  const c = PALETTE[hash(provider) % PALETTE.length];
  assigned.set(provider, c);
  return c;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Reset assignment so palette order is stable by first-seen. Useful in tests. */
export function resetColors(): void {
  assigned.clear();
}

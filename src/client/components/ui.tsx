import { useState, type ReactNode } from "react";

export function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function fmtCompactPrecise(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) < 1_000) return Math.round(n).toLocaleString("en-US");
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(n);
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtPct(ratio: number | null | undefined, digits = 1): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export interface Segment {
  label: string;
  value: number;
  color: string;
}

/** Horizontal proportion bar with a legend. */
export function CompositionBar({ segments, total }: { segments: Segment[]; total: number }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const denom = total || segments.reduce((s, x) => s + x.value, 0) || 1;
  const itemClass = (index: number, base: string) => {
    if (hoveredIndex == null) return base;
    return `${base} ${hoveredIndex === index ? "is-active" : "is-muted"}`;
  };

  return (
    <div className={`composition${hoveredIndex == null ? "" : " has-active"}`} onMouseLeave={() => setHoveredIndex(null)}>
      <div className="comp-bar">
        {segments.map((s, index) => s.value > 0 && (
          <span
            key={s.label}
            className={itemClass(index, "comp-segment")}
            data-label={s.label}
            style={{ width: `${(s.value / denom) * 100}%`, background: s.color }}
            title={`${s.label}: ${fmtInt(s.value)}`}
            onMouseEnter={() => setHoveredIndex(index)}
          />
        ))}
      </div>
      <div className="comp-legend">
        {segments.map((s, index) => (
          <div key={s.label} className={itemClass(index, "item")} data-label={s.label} onMouseEnter={() => setHoveredIndex(index)}>
            <span className="swatch" style={{ background: s.color }} />
            {s.label}
            <span className="v">{fmtCompact(s.value)}</span>
            <span className="dim">{((s.value / denom) * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: string;
}) {
  return (
    <div className="kpi" style={{ ["--bar" as string]: accent }}>
      <div className="k-accent" />
      <div className="k-label">{label}</div>
      <div className="k-value">{value}</div>
      {sub != null && <div className="k-sub">{sub}</div>}
    </div>
  );
}

export function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="metric">
      <div className="m-label">{label}</div>
      <div className="m-value">{value}</div>
      {sub != null && <div className="m-sub">{sub}</div>}
    </div>
  );
}

export const COLORS = {
  cacheRead: "var(--signal-0)",
  fresh: "var(--signal-1)",
  output: "var(--accent)",
  cacheWrite: "var(--signal-2)",
  unattributed: "var(--signal-4)",
  reasoning: "var(--signal-3)",
};

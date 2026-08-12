import { useMemo, useState } from "react";
import { colorFor } from "./colors.js";

export interface ChartPoint {
  date: string;
  provider: string;
  value: number;
}

interface Props {
  buckets: string[];
  providers: string[];
  points: ChartPoint[];
  /** Format a raw value for axis/tooltip. */
  formatValue: (v: number) => string;
  height?: number;
}

/**
 * Stacked area chart, one color per provider. Pure SVG, responsive via
 * viewBox; hover tracks the nearest day and shows a per-provider breakdown.
 */
export function StackedAreaChart({ buckets, providers, points, formatValue, height = 260 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 920;
  const padL = 52;
  const padR = 16;
  const padT = 12;
  const padB = 24;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  // Build matrix [day][provider] -> value, plus daily stacked totals.
  const { matrix, dailyTotal, maxTotal, orderedProviders } = useMemo(() => {
    const lookup = new Map<string, number>();
    for (const p of points) lookup.set(`${p.date}|${p.provider}`, p.value);
    // Order providers by total descending for stable stacking.
    const totals = new Map<string, number>();
    for (const p of points) totals.set(p.provider, (totals.get(p.provider) ?? 0) + p.value);
    const ordered = [...providers].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
    const m: number[][] = buckets.map((d) => ordered.map((pv) => lookup.get(`${d}|${pv}`) ?? 0));
    const dt = m.map((row) => row.reduce((s, v) => s + v, 0));
    const mx = Math.max(1, ...dt);
    return { matrix: m, dailyTotal: dt, maxTotal: mx, orderedProviders: ordered };
  }, [buckets, providers, points]);

  if (buckets.length === 0) {
    return <div className="empty">No data in range.</div>;
  }

  const x = (i: number) => padL + (buckets.length <= 1 ? plotW / 2 : (i / (buckets.length - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / maxTotal) * plotH;

  // Build stacked area paths per provider.
  const layers = orderedProviders.map((pv, pi) => {
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i < buckets.length; i++) {
      let below = 0;
      let val = 0;
      for (let k = 0; k <= pi; k++) {
        val = matrix[i][k];
        below += matrix[i][k];
      }
      void val;
      const xi = x(i);
      const yi = y(below);
      top.push(`${i === 0 ? "M" : "L"}${xi.toFixed(1)},${yi.toFixed(1)}`);
    }
    for (let i = buckets.length - 1; i >= 0; i--) {
      let below = 0;
      for (let k = 0; k < pi; k++) below += matrix[i][k];
      const xi = x(i);
      const yi = y(below);
      bottom.push(`L${xi.toFixed(1)},${yi.toFixed(1)}`);
    }
    return { provider: pv, d: `${top.join(" ")} ${bottom.join(" ")} Z` };
  });

  // Y ticks (4 nice-ish).
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxTotal * f));

  // X labels: ~6 across.
  const labelStep = Math.max(1, Math.ceil(buckets.length / 6));

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * width;
          const ratio = (px - padL) / plotW;
          const idx = Math.round(ratio * (buckets.length - 1));
          setHover(idx < 0 ? 0 : idx >= buckets.length ? buckets.length - 1 : idx);
        }}
      >
        <g className="grid">
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />
            </g>
          ))}
        </g>
        <g className="axis">
          {ticks.map((t, i) => (
            <text key={i} x={padL - 8} y={y(t) + 3} textAnchor="end">
              {formatValue(t)}
            </text>
          ))}
          {buckets.map((d, i) =>
            i % labelStep === 0 || i === buckets.length - 1 ? (
              <text key={d} x={x(i)} y={height - 6} textAnchor="middle">
                {fmtDay(d)}
              </text>
            ) : null,
          )}
        </g>
        {layers.map((l) => (
          <path key={l.provider} d={l.d} fill={colorFor(l.provider)} fillOpacity={0.85} stroke={colorFor(l.provider)} strokeWidth={0.5}>
            <title>{l.provider}</title>
          </path>
        ))}
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} stroke="var(--fg-0)" strokeOpacity={0.35} strokeDasharray="3 3" />
        )}
      </svg>
      {hover != null && (
        <div
          className="tip"
          style={{
            left: `${((x(hover) / width) * 100).toFixed(2)}%`,
            top: 4,
            transform: hover / Math.max(1, buckets.length - 1) > 0.7 ? "translateX(-100%)" : "translateX(8px)",
          }}
        >
          <div className="t-date">{fmtFullDay(buckets[hover])} · {formatValue(dailyTotal[hover])}</div>
          {orderedProviders
            .map((pv, pi) => ({ pv, v: matrix[hover][pi] }))
            .filter((r) => r.v > 0)
            .sort((a, b) => b.v - a.v)
            .slice(0, 8)
            .map((r) => (
              <div key={r.pv} className="t-row">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span className="swatch" style={{ background: colorFor(r.pv) }} />
                  <span className="muted">{r.pv}</span>
                </span>
                <span className="mono">{formatValue(r.v)}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function fmtDay(d: string): string {
  // yyyy-MM-dd -> "Jul 12"
  const [, m, day] = d.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m) - 1] ?? ""} ${day}`;
}
function fmtFullDay(d: string): string {
  const [, m, day] = d.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m) - 1] ?? ""} ${day}`;
}

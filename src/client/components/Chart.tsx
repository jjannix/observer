import { useId, useMemo, useState } from "react";

export interface ChartPoint {
  date: string;
  provider: string;
  value: number;
}

interface Props {
  buckets: string[];
  providers: string[];
  points: ChartPoint[];
  formatValue: (value: number) => string;
  height?: number;
  ariaLabel?: string;
  seriesColor?: (series: string, index: number) => string;
  fillAreas?: boolean;
}

export function SignalChart({ buckets, providers, points, formatValue, height = 410 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 1200;
  const padL = 66;
  const padR = 8;
  const padT = 18;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const { matrix, dailyTotal, maxTotal, orderedProviders } = useMemo(() => {
    const lookup = new Map<string, number>();
    const providerTotals = new Map<string, number>();
    for (const point of points) {
      lookup.set(`${point.date}|${point.provider}`, point.value);
      providerTotals.set(point.provider, (providerTotals.get(point.provider) ?? 0) + point.value);
    }
    const ordered = [...providers].sort((a, b) => (providerTotals.get(b) ?? 0) - (providerTotals.get(a) ?? 0));
    const values = buckets.map((date) => ordered.map((provider) => lookup.get(`${date}|${provider}`) ?? 0));
    const totals = values.map((row) => row.reduce((sum, value) => sum + value, 0));
    return { matrix: values, dailyTotal: totals, maxTotal: Math.max(1, ...totals), orderedProviders: ordered };
  }, [buckets, points, providers]);

  if (buckets.length === 0) return <div className="empty chart-empty">No observations in this period.</div>;

  const x = (index: number) => padL + (buckets.length <= 1 ? plotW / 2 : (index / (buckets.length - 1)) * plotW);
  const y = (value: number) => padT + plotH - (value / maxTotal) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(maxTotal * fraction));
  const labelStep = Math.max(1, Math.ceil(buckets.length / 5));
  const hoverY = hover == null ? 0 : y(dailyTotal[hover]);
  const signalPoints = dailyTotal.map((value, index) => [x(index), y(value)] as [number, number]);
  const signalPath = smoothLinePath(signalPoints);
  const signalAreaPath = `${signalPath} L${signalPoints.at(-1)?.[0].toFixed(1)},${(padT + plotH).toFixed(1)} L${signalPoints[0][0].toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

  return (
    <div className="telemetry-chart">
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Usage over time"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const pointerX = ((event.clientX - rect.left) / rect.width) * width;
          const index = Math.round(((pointerX - padL) / plotW) * (buckets.length - 1));
          setHover(Math.max(0, Math.min(buckets.length - 1, index)));
        }}
      >
        <defs>
          <linearGradient id="signal-area-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#afcbff" stopOpacity="0.18" />
            <stop offset="45%" stopColor="#afcbff" stopOpacity="0.13" />
            <stop offset="80%" stopColor="#afcbff" stopOpacity="0.045" />
            <stop offset="100%" stopColor="#afcbff" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        <g className="grid">
          {ticks.map((tick) => <line key={tick} x1={padL} x2={width - padR} y1={y(tick)} y2={y(tick)} />)}
        </g>
        <g className="axis">
          {ticks.map((tick) => <text key={tick} x={padL - 12} y={y(tick) + 4} textAnchor="end">{formatValue(tick)}</text>)}
          {buckets.map((date, index) => index % labelStep === 0 || index === buckets.length - 1 ? (
            <text key={date} x={x(index)} y={height - 6} textAnchor={index === 0 ? "start" : index === buckets.length - 1 ? "end" : "middle"}>{fmtDay(date)}</text>
          ) : null)}
        </g>
        <path className="signal-area" d={signalAreaPath} fill="url(#signal-area-gradient)" />
        <path className="signal" d={signalPath} vectorEffect="non-scaling-stroke" />
        {hover != null && (
          <g className="crosshair">
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} vectorEffect="non-scaling-stroke" />
            <circle cx={x(hover)} cy={hoverY} r="3.5" vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
      {hover != null && (
        <div
          className="tip"
          style={{
            left: `${(x(hover) / width) * 100}%`,
            top: `${(hoverY / height) * 100}%`,
            transform: `${hover > buckets.length * 0.7 ? "translateX(-100%)" : "translateX(10px)"} ${hoverY > height * 0.62 ? "translateY(-100%)" : "translateY(8px)"}`,
          }}
        >
          <div className="t-date">{fmtFullDay(buckets[hover])}</div>
          <div className="t-total"><span>Processed</span><strong>{formatValue(dailyTotal[hover])}</strong></div>
          {orderedProviders.map((provider, providerIndex) => ({ provider, value: matrix[hover][providerIndex] }))
            .filter((row) => row.value > 0)
            .slice(0, 5)
            .map((row) => <div key={row.provider} className="t-row"><span>{row.provider}</span><span>{formatValue(row.value)}</span></div>)}
        </div>
      )}
    </div>
  );
}

export function MultiLineChart({ buckets, providers, points, formatValue, height = 330, ariaLabel = "Usage comparison over time", seriesColor, fillAreas = false }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const gradientPrefix = useId().replace(/:/g, "");
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const width = 1200;
  const padL = 58;
  const padR = 8;
  const padT = 16;
  const padB = 32;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const { ordered, values, maxValue } = useMemo(() => {
    const lookup = new Map<string, number>();
    const totals = new Map<string, number>();
    for (const point of points) {
      lookup.set(`${point.date}|${point.provider}`, point.value);
      totals.set(point.provider, (totals.get(point.provider) ?? 0) + point.value);
    }
    const series = [...providers].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0)).slice(0, 4);
    const matrix = series.map((provider) => buckets.map((date) => lookup.get(`${date}|${provider}`) ?? 0));
    return { ordered: series, values: matrix, maxValue: Math.max(1, ...matrix.flat()) };
  }, [buckets, points, providers]);

  if (buckets.length === 0 || ordered.length === 0) return <div className="empty chart-empty">No observations in this period.</div>;
  const x = (index: number) => padL + (buckets.length <= 1 ? plotW / 2 : (index / (buckets.length - 1)) * plotW);
  const y = (value: number) => padT + plotH - (value / maxValue) * plotH;
  const ticks = [0, 0.5, 1].map((fraction) => Math.round(maxValue * fraction));
  const labelStep = Math.max(1, Math.ceil(buckets.length / 4));
  const focusedProvider = hoveredProvider ?? selectedProvider;

  return (
    <div className="telemetry-chart comparison-chart">
      <div className="chart-legend">
        {ordered.map((provider, index) => (
          <button
            type="button"
            key={provider}
            className={focusedProvider === provider ? "focused" : ""}
            aria-pressed={selectedProvider === provider}
            onMouseEnter={() => setHoveredProvider(provider)}
            onMouseLeave={() => setHoveredProvider(null)}
            onFocus={() => setHoveredProvider(provider)}
            onBlur={() => setHoveredProvider(null)}
            onClick={() => setSelectedProvider((current) => current === provider ? null : provider)}
          >
            <i className={`series-key series-${index}`} style={seriesColor ? { background: seriesColor(provider, index) } : undefined} />{provider}
          </button>
        ))}
      </div>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => { setHover(null); setHoveredProvider(null); }}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const pointerX = ((event.clientX - rect.left) / rect.width) * width;
          const pointerY = ((event.clientY - rect.top) / rect.height) * height;
          const pointIndex = Math.max(0, Math.min(buckets.length - 1, Math.round(((pointerX - padL) / plotW) * (buckets.length - 1))));
          const nearestProvider = ordered.reduce((nearest, provider, providerIndex) => {
            if (nearest == null) return provider;
            const nearestIndex = ordered.indexOf(nearest);
            return Math.abs(y(values[providerIndex][pointIndex]) - pointerY) < Math.abs(y(values[nearestIndex][pointIndex]) - pointerY) ? provider : nearest;
          }, null as string | null);
          setHover(pointIndex);
          setHoveredProvider(nearestProvider);
        }}
      >
        {fillAreas && <defs>
          {ordered.map((provider, index) => {
            const color = seriesColor?.(provider, index) ?? ["#8498bb", "#a2a2a2", "#6a6a6a", "#454545"][index];
            return <linearGradient id={`${gradientPrefix}-area-${index}`} key={provider} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.24" />
              <stop offset="68%" stopColor={color} stopOpacity="0.08" />
              <stop offset="100%" stopColor={color} stopOpacity="0.01" />
            </linearGradient>;
          })}
        </defs>}
        <g className="grid">{ticks.map((tick) => <line key={tick} x1={padL} x2={width - padR} y1={y(tick)} y2={y(tick)} />)}</g>
        <g className="axis">
          {ticks.map((tick) => <text key={tick} x={padL - 10} y={y(tick) + 4} textAnchor="end">{formatValue(tick)}</text>)}
          {buckets.map((date, index) => index % labelStep === 0 || index === buckets.length - 1 ? <text key={date} x={x(index)} y={height - 5} textAnchor="middle">{fmtDay(date)}</text> : null)}
        </g>
        {fillAreas && values.map((series, index) => {
          const linePoints = series.map((value, pointIndex) => [x(pointIndex), y(value)] as [number, number]);
          const baseline = padT + plotH;
          const areaPath = `${smoothLinePath(linePoints)} L${linePoints.at(-1)?.[0].toFixed(1)},${baseline.toFixed(1)} L${linePoints[0][0].toFixed(1)},${baseline.toFixed(1)} Z`;
          return <path key={`${ordered[index]}-area`} className={`comparison-area${focusedProvider === ordered[index] ? " focused" : focusedProvider ? " subdued" : ""}`} d={areaPath} fill={`url(#${gradientPrefix}-area-${index})`} />;
        })}
        {values.map((series, index) => <path key={ordered[index]} className={`comparison-signal series-${index}${focusedProvider === ordered[index] ? " focused" : focusedProvider ? " subdued" : ""}`} style={seriesColor ? { stroke: seriesColor(ordered[index], index) } : undefined} d={smoothLinePath(series.map((value, pointIndex) => [x(pointIndex), y(value)]))} vectorEffect="non-scaling-stroke" />)}
        {hover != null && <g className="crosshair"><line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} /></g>}
      </svg>
      {hover != null && (
        <div className="tip comparison-tip" style={{ left: `${(x(hover) / width) * 100}%`, top: 48, transform: hover > buckets.length * 0.7 ? "translateX(-100%)" : "translateX(10px)" }}>
          <div className="t-date">{fmtFullDay(buckets[hover])}</div>
          {ordered.map((provider, index) => <div key={provider} className={`t-row${focusedProvider === provider ? " focused" : ""}`}><span className="t-series-label">{seriesColor && <i style={{ background: seriesColor(provider, index) }} />}{provider}</span><span>{formatValue(values[index][hover])}</span></div>)}
        </div>
      )}
    </div>
  );
}

function smoothLinePath(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;

  const slopes = points.slice(0, -1).map(([x, y], index) => {
    const [nextX, nextY] = points[index + 1];
    return (nextY - y) / (nextX - x);
  });
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0];
    if (index === points.length - 1) return slopes[slopes.length - 1];
    return slopes[index - 1] * slopes[index] <= 0 ? 0 : (slopes[index - 1] + slopes[index]) / 2;
  });

  for (let index = 0; index < slopes.length; index += 1) {
    const slope = slopes[index];
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const left = tangents[index] / slope;
    const right = tangents[index + 1] / slope;
    const magnitude = left * left + right * right;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * left * slope;
      tangents[index + 1] = scale * right * slope;
    }
  }

  let path = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[index + 1];
    const width = x2 - x1;
    path += ` C${(x1 + width / 3).toFixed(1)},${(y1 + tangents[index] * width / 3).toFixed(1)}`;
    path += ` ${(x2 - width / 3).toFixed(1)},${(y2 - tangents[index + 1] * width / 3).toFixed(1)}`;
    path += ` ${x2.toFixed(1)},${y2.toFixed(1)}`;
  }
  return path;
}

function fmtDay(value: string): string {
  const [, month, day] = value.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(month) - 1] ?? ""} ${Number(day)}`;
}

function fmtFullDay(value: string): string {
  return fmtDay(value).toUpperCase();
}

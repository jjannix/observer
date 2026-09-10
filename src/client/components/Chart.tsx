import { useId, useMemo, useState } from "react";

export interface ChartPoint {
  date: string;
  provider: string;
  value: number;
}

export interface OverviewChartProps {
  grouping: "total" | "harness";
  totalData?: {
    buckets: string[];
    providers: string[];
    points: ChartPoint[];
  } | null;
  harnessData?: {
    buckets: string[];
    providers: string[];
    points: ChartPoint[];
  } | null;
  formatValue: (value: number) => string;
  height?: number;
  seriesColor?: (series: string, index: number) => string;
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

export function OverviewChart({
  grouping,
  totalData,
  harnessData,
  formatValue,
  height = 410,
  seriesColor,
}: OverviewChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [sweepKey, setSweepKey] = useState<number>(0);
  const gradientPrefix = useId().replace(/:/g, "");

  const prevGrouping = useMemo(() => ({ current: grouping }), []);
  const [activeGrouping, setActiveGrouping] = useState(grouping);

  // Trigger optical sweep animation when grouping changes
  if (prevGrouping.current !== grouping) {
    prevGrouping.current = grouping;
    if (activeGrouping !== grouping) {
      setActiveGrouping(grouping);
      setSweepKey((k) => k + 1);
    }
  }

  const width = 1200;
  const padL = 58;
  const padR = 8;
  const padT = 16;
  const padB = 32;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  // Compute Total metrics
  const totalModel = useMemo(() => {
    const buckets = totalData?.buckets ?? harnessData?.buckets ?? [];
    if (buckets.length === 0) return null;

    const points = totalData?.points ?? harnessData?.points ?? [];
    const providers = totalData?.providers ?? harnessData?.providers ?? [];
    const lookup = new Map<string, number>();
    const providerTotals = new Map<string, number>();
    for (const point of points) {
      lookup.set(`${point.date}|${point.provider}`, point.value);
      providerTotals.set(point.provider, (providerTotals.get(point.provider) ?? 0) + point.value);
    }
    const ordered = [...providers].sort((a, b) => (providerTotals.get(b) ?? 0) - (providerTotals.get(a) ?? 0));
    const matrix = buckets.map((date) => ordered.map((provider) => lookup.get(`${date}|${provider}`) ?? 0));
    const dailyTotal = matrix.map((row) => row.reduce((sum, value) => sum + value, 0));
    const maxTotal = Math.max(1, ...dailyTotal);
    return { buckets, matrix, dailyTotal, maxTotal, orderedProviders: ordered };
  }, [totalData, harnessData]);

  // Compute Harness metrics
  const harnessModel = useMemo(() => {
    const buckets = harnessData?.buckets ?? totalData?.buckets ?? [];
    const points = harnessData?.points ?? [];
    const providers = harnessData?.providers ?? [];
    if (buckets.length === 0 || providers.length === 0 || points.length === 0) return null;

    const lookup = new Map<string, number>();
    const totals = new Map<string, number>();
    for (const point of points) {
      lookup.set(`${point.date}|${point.provider}`, point.value);
      totals.set(point.provider, (totals.get(point.provider) ?? 0) + point.value);
    }
    const series = [...providers].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0)).slice(0, 4);
    const matrix = series.map((provider) => buckets.map((date) => lookup.get(`${date}|${provider}`) ?? 0));
    const maxValue = Math.max(1, ...matrix.flat());
    return { buckets, ordered: series, values: matrix, maxValue };
  }, [harnessData, totalData]);

  const buckets = (grouping === "harness" ? harnessModel?.buckets : totalModel?.buckets) ?? totalModel?.buckets ?? harnessModel?.buckets ?? [];

  if (buckets.length === 0 || (!totalModel && !harnessModel)) {
    return <div className="empty chart-empty">No observations in this period.</div>;
  }

  const isHarness = grouping === "harness" && harnessModel != null;
  const activeMax = isHarness ? (harnessModel?.maxValue ?? 1) : (totalModel?.maxTotal ?? 1);

  const x = (index: number) => padL + (buckets.length <= 1 ? plotW / 2 : (index / (buckets.length - 1)) * plotW);
  const y = (value: number) => padT + plotH - (value / activeMax) * plotH;
  const yTotal = (value: number) => padT + plotH - (value / (totalModel?.maxTotal ?? 1)) * plotH;
  const yHarness = (value: number) => padT + plotH - (value / (harnessModel?.maxValue ?? 1)) * plotH;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(activeMax * fraction));
  const labelStep = Math.max(1, Math.ceil(buckets.length / (isHarness ? 4 : 5)));
  const focusedProvider = hoveredProvider ?? selectedProvider;

  // Pre-calculate paths
  const baseline = (padT + plotH).toFixed(1);

  const totalPoints = totalModel ? totalModel.dailyTotal.map((value, index) => [x(index), yTotal(value)] as [number, number]) : [];
  const totalPath = smoothLinePath(totalPoints);
  const totalAreaPath = totalPoints.length > 0
    ? `${totalPath} L${totalPoints.at(-1)?.[0].toFixed(1)},${baseline} L${totalPoints[0][0].toFixed(1)},${baseline} Z`
    : "";

  const harnessSeriesData = harnessModel
    ? harnessModel.ordered.map((provider, index) => {
        const linePoints = harnessModel.values[index].map((value, pointIndex) => [x(pointIndex), yHarness(value)] as [number, number]);
        const path = smoothLinePath(linePoints);
        const areaPath = linePoints.length > 0
          ? `${path} L${linePoints.at(-1)?.[0].toFixed(1)},${baseline} L${linePoints[0][0].toFixed(1)},${baseline} Z`
          : "";
        return { provider, linePoints, path, areaPath };
      })
    : [];

  const hoverY = hover == null ? 0 : isHarness && harnessModel
    ? yHarness(focusedProvider ? (harnessModel.values[harnessModel.ordered.indexOf(focusedProvider)]?.[hover] ?? 0) : Math.max(...harnessModel.values.map((v) => v[hover])))
    : totalModel ? yTotal(totalModel.dailyTotal[hover]) : 0;

  return (
    <div className={`telemetry-chart overview-chart-container ${isHarness ? "comparison-chart mode-harness" : "mode-total"}`}>
      <div className="chart-legend-slot">
        <div
          className={`chart-legend overview-legend ${isHarness ? "overview-legend-enter" : ""}`}
          style={{
            opacity: isHarness ? 1 : 0,
            pointerEvents: isHarness ? "auto" : "none",
            visibility: isHarness ? "visible" : "hidden",
          }}
        >
          {harnessModel?.ordered.map((provider, index) => (
            <button
              type="button"
              key={provider}
              className={`overview-legend-item ${focusedProvider === provider ? "focused" : ""}`}
              aria-pressed={selectedProvider === provider}
              style={{ "--item-idx": index } as React.CSSProperties}
              onMouseEnter={() => setHoveredProvider(provider)}
              onMouseLeave={() => setHoveredProvider(null)}
              onFocus={() => setHoveredProvider(provider)}
              onBlur={() => setHoveredProvider(null)}
              onClick={() => setSelectedProvider((current) => (current === provider ? null : provider))}
            >
              <i
                className={`series-key series-${index}`}
                style={seriesColor ? { background: seriesColor(provider, index) } : undefined}
              />
              {provider}
            </button>
          ))}
        </div>
      </div>

      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={isHarness ? "Harness usage comparison over time" : "Usage over time"}
        onMouseLeave={() => {
          setHover(null);
          setHoveredProvider(null);
        }}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const pointerX = ((event.clientX - rect.left) / rect.width) * width;
          const pointerY = ((event.clientY - rect.top) / rect.height) * height;
          const pointIndex = Math.max(0, Math.min(buckets.length - 1, Math.round(((pointerX - padL) / plotW) * (buckets.length - 1))));
          setHover(pointIndex);

          if (isHarness && harnessModel) {
            const nearest = harnessModel.ordered.reduce((nearestProvider, provider, providerIndex) => {
              if (nearestProvider == null) return provider;
              const nearestIndex = harnessModel.ordered.indexOf(nearestProvider);
              const currentDist = Math.abs(yHarness(harnessModel.values[providerIndex][pointIndex]) - pointerY);
              const nearestDist = Math.abs(yHarness(harnessModel.values[nearestIndex][pointIndex]) - pointerY);
              return currentDist < nearestDist ? provider : nearestProvider;
            }, null as string | null);
            setHoveredProvider(nearest);
          }
        }}
      >
        <defs>
          <linearGradient id="signal-area-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#afcbff" stopOpacity="0.18" />
            <stop offset="45%" stopColor="#afcbff" stopOpacity="0.13" />
            <stop offset="80%" stopColor="#afcbff" stopOpacity="0.045" />
            <stop offset="100%" stopColor="#afcbff" stopOpacity="0.01" />
          </linearGradient>

          {harnessModel?.ordered.map((provider, index) => {
            const color = seriesColor?.(provider, index) ?? ["#8498bb", "#a2a2a2", "#6a6a6a", "#454545"][index];
            return (
              <linearGradient id={`${gradientPrefix}-area-${index}`} key={provider} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.24" />
                <stop offset="68%" stopColor={color} stopOpacity="0.08" />
                <stop offset="100%" stopColor={color} stopOpacity="0.01" />
              </linearGradient>
            );
          })}

          <linearGradient id="overview-scan-beam" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#afcbff" stopOpacity="0.05" />
            <stop offset="25%" stopColor="#afcbff" stopOpacity="0.9" />
            <stop offset="75%" stopColor="#afcbff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#afcbff" stopOpacity="0.05" />
          </linearGradient>

          <linearGradient id="overview-scan-trail" x1="1" y1="0" x2="0" y2="0">
            <stop offset="0%" stopColor="#afcbff" stopOpacity="0.18" />
            <stop offset="40%" stopColor="#afcbff" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#afcbff" stopOpacity="0" />
          </linearGradient>
        </defs>

        <g className="grid">
          {ticks.map((tick) => (
            <line key={tick} x1={padL} x2={width - padR} y1={y(tick)} y2={y(tick)} />
          ))}
        </g>

        <g className="axis" key={`axis-${grouping}`}>
          {ticks.map((tick) => (
            <text key={tick} x={padL - 10} y={y(tick) + 4} textAnchor="end" className="axis-tick-label animating">
              {formatValue(tick)}
            </text>
          ))}
          {buckets.map((date, index) =>
            index % labelStep === 0 || index === buckets.length - 1 ? (
              <text
                key={date}
                x={x(index)}
                y={height - 5}
                textAnchor={index === 0 ? "start" : index === buckets.length - 1 ? "end" : "middle"}
              >
                {fmtDay(date)}
              </text>
            ) : null,
          )}
        </g>

        {/* Optical Aperture Sweep Line */}
        {sweepKey > 0 && (
          <g className="overview-aperture-sweep" key={`sweep-${sweepKey}`}>
            <rect
              x={padL - 48}
              y={padT}
              width="48"
              height={plotH}
              fill="url(#overview-scan-trail)"
            />
            <line
              x1={padL}
              y1={padT}
              x2={padL}
              y2={padT + plotH}
              stroke="url(#overview-scan-beam)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}

        {/* Total Signal Layer */}
        <g
          className={`overview-signal-group overview-signal-total ${
            !isHarness ? "is-active" : "is-inactive"
          }`}
          aria-hidden={isHarness}
        >
          {totalAreaPath && <path className="signal-area" d={totalAreaPath} fill="url(#signal-area-gradient)" />}
          {totalPath && <path className="signal" d={totalPath} vectorEffect="non-scaling-stroke" />}
        </g>

        {/* Harness Multi-Line Layer */}
        <g
          className={`overview-signal-group overview-signal-harness ${
            isHarness ? "is-active" : "is-inactive"
          }`}
          aria-hidden={!isHarness}
        >
          {harnessSeriesData.map(({ provider, areaPath }, index) => (
            <path
              key={`${provider}-area`}
              className={`comparison-area ${focusedProvider === provider ? "focused" : focusedProvider ? "subdued" : ""}`}
              d={areaPath}
              fill={`url(#${gradientPrefix}-area-${index})`}
              style={{ "--series-idx": index } as React.CSSProperties}
            />
          ))}
          {harnessSeriesData.map(({ provider, path }, index) => (
            <path
              key={provider}
              className={`comparison-signal series-${index} ${
                focusedProvider === provider ? "focused" : focusedProvider ? "subdued" : ""
              }`}
              style={{
                ...(seriesColor ? { stroke: seriesColor(provider, index) } : {}),
                "--series-idx": index,
              } as React.CSSProperties}
              d={path}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>

        {/* Crosshair */}
        {hover != null && (
          <g className="crosshair">
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} vectorEffect="non-scaling-stroke" />
            {!isHarness && <circle cx={x(hover)} cy={hoverY} r="3.5" vectorEffect="non-scaling-stroke" />}
          </g>
        )}
      </svg>

      {/* Tooltip */}
      {hover != null && (
        !isHarness ? (
          totalModel && (
            <div
              className="tip"
              style={{
                left: `${(x(hover) / width) * 100}%`,
                top: `${(hoverY / height) * 100}%`,
                transform: `${hover > buckets.length * 0.7 ? "translateX(-100%)" : "translateX(10px)"} ${
                  hoverY > height * 0.62 ? "translateY(-100%)" : "translateY(8px)"
                }`,
              }}
            >
              <div className="t-date">{fmtFullDay(buckets[hover])}</div>
              <div className="t-total">
                <span>Processed</span>
                <strong>{formatValue(totalModel.dailyTotal[hover])}</strong>
              </div>
              {totalModel.orderedProviders
                .map((provider, providerIndex) => ({
                  provider,
                  value: totalModel.matrix[hover][providerIndex],
                }))
                .filter((row) => row.value > 0)
                .slice(0, 5)
                .map((row) => (
                  <div key={row.provider} className="t-row">
                    <span>{row.provider}</span>
                    <span>{formatValue(row.value)}</span>
                  </div>
                ))}
            </div>
          )
        ) : (
          harnessModel && (
            <div
              className="tip comparison-tip"
              style={{
                left: `${(x(hover) / width) * 100}%`,
                top: 48,
                transform: hover > buckets.length * 0.7 ? "translateX(-100%)" : "translateX(10px)",
              }}
            >
              <div className="t-date">{fmtFullDay(buckets[hover])}</div>
              {harnessModel.ordered.map((provider, index) => (
                <div key={provider} className={`t-row ${focusedProvider === provider ? "focused" : ""}`}>
                  <span className="t-series-label">
                    {seriesColor && <i style={{ background: seriesColor(provider, index) }} />}
                    {provider}
                  </span>
                  <span>{formatValue(harnessModel.values[index][hover])}</span>
                </div>
              ))}
            </div>
          )
        )
      )}
    </div>
  );
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

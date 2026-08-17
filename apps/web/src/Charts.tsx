type BarPoint = { key: string; count: number; amount?: number };

function compact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function BarChart({
  title,
  points,
  valueKey = "count",
}: {
  title: string;
  points: BarPoint[];
  valueKey?: "count" | "amount";
}) {
  const values = points.map((point) => Number(point[valueKey] ?? 0));
  const max = Math.max(0, ...values);
  const description = points.length
    ? points.map((point) => `${point.key}: ${Number(point[valueKey] ?? 0).toLocaleString()}`).join(", ")
    : "No data available";

  return (
    <section className="chart-card" aria-labelledby={`chart-${slug(title)}`}>
      <div className="chart-title-row">
        <h3 id={`chart-${slug(title)}`}>{title}</h3>
        <span>{valueKey === "amount" ? "Amount" : "Rows"}</span>
      </div>
      <p className="sr-only">{description}</p>
      {points.length === 0 ? (
        <div className="mini-empty">No data in this scope</div>
      ) : (
        <div className="bars" aria-hidden="true">
          {points.map((point) => {
            const value = Number(point[valueKey] ?? 0);
            const width = max === 0 ? "0%" : `${(value / max) * 100}%`;
            return (
              <div key={point.key} className="bar-row">
                <span title={point.key}>{humanize(point.key)}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width }} />
                </div>
                <em title={value.toLocaleString()}>{compact(value)}</em>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function Sparkline({ title, points }: { title: string; points: BarPoint[] }) {
  const values = points.map((point) => point.count);
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const width = 480;
  const height = 112;
  const path = values
    .map((value, index) => {
      const x = values.length <= 1 ? 0 : (index / (values.length - 1)) * width;
      const y = height - ((value - min) / (max - min || 1)) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const description = points.length
    ? points.map((point) => `${point.key}: ${point.count.toLocaleString()} rows`).join(", ")
    : "No timeline data available";

  return (
    <section className="chart-card chart-wide" aria-labelledby={`chart-${slug(title)}`}>
      <div className="chart-title-row">
        <h3 id={`chart-${slug(title)}`}>{title}</h3>
        <span>{points.length ? `${points[0]?.key} – ${points.at(-1)?.key}` : "No range"}</span>
      </div>
      <p className="sr-only">{description}</p>
      {points.length === 0 ? (
        <div className="mini-empty">No timeline data in this scope</div>
      ) : points.length === 1 ? (
        <svg viewBox={`0 0 ${width} ${height}`} className="spark" aria-hidden="true" preserveAspectRatio="none">
          <line x1="0" y1={height} x2={width} y2={height} stroke="currentColor" strokeOpacity="0.18" vectorEffect="non-scaling-stroke" />
          <circle cx={width / 2} cy={height / 2} r="5" fill="currentColor" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} className="spark" aria-hidden="true" preserveAspectRatio="none">
          <defs>
            <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.24" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${path} L${width},${height} L0,${height} Z`} fill="url(#spark-fill)" stroke="none" />
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </section>
  );
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

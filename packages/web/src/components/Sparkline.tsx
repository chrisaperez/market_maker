// Lightweight dependency-free SVG line chart. Green when the series ends higher
// than it started, red when lower — the "little charts that go up and down".

export function Sparkline({
  points,
  width = 130,
  height = 38,
  strokeWidth = 1.75,
  area = true,
  className,
}: {
  points: number[];
  width?: number;
  height?: number;
  strokeWidth?: number;
  area?: boolean;
  className?: string;
}) {
  if (points.length < 2) {
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className={`opacity-40 ${className ?? ''}`}
        preserveAspectRatio="none"
      >
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="#475569" strokeDasharray="3 3" />
      </svg>
    );
  }

  const pad = strokeWidth + 1;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const n = points.length;

  const x = (i: number) => pad + (i / (n - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const up = points[points.length - 1]! >= points[0]!;
  const color = up ? '#34d399' : '#f87171';
  const areaPath = `${line} L${x(n - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
  const gid = `sg-${color.slice(1)}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={className}
    >
      {area && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#${gid})`} />
        </>
      )}
      <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(n - 1)} cy={y(points[n - 1]!)} r={strokeWidth + 0.5} fill={color} />
    </svg>
  );
}

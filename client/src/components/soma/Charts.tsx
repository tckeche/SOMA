// Small, clean data-viz primitives for the Warm Editorial redesign.
// Pure SVG/CSS, theme-aware via design tokens (no chart lib needed).
import { useId, type ReactNode } from "react";

/** Sparkline — a tiny filled trend line. */
export function Spark({
  data,
  w = 120,
  h = 36,
  stroke = "hsl(var(--primary))",
  fill = true,
}: {
  data: number[];
  w?: number;
  h?: number;
  stroke?: string;
  fill?: boolean;
}) {
  const rawId = useId().replace(/[:]/g, "");
  if (!data || data.length === 0) return <svg width={w} height={h} aria-hidden />;
  if (data.length === 1) data = [data[0], data[0]];
  const max = Math.max(...data);
  const min = Math.min(...data);
  const rng = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - 4 - ((v - min) / rng) * (h - 8);
    return [x, y] as const;
  });
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = `${line} L ${w} ${h} L 0 ${h} Z`;
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block", overflow: "visible" }} aria-hidden>
      {fill && (
        <>
          <defs>
            <linearGradient id={rawId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${rawId})`} />
        </>
      )}
      <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.8" fill={stroke} />
    </svg>
  );
}

/** Progress ring with centered content. */
export function Ring({
  pct,
  size = 64,
  stroke = 7,
  color = "hsl(var(--primary))",
  track = "hsl(var(--muted))",
  children,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
  children?: ReactNode;
}) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - clamped / 100);
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={off}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset .8s cubic-bezier(.2,.7,.2,1)" }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>{children}</div>
    </div>
  );
}

/** Completion donut with legend. */
export function Donut({
  completed,
  awaiting,
  notStarted,
  size = 150,
}: {
  completed: number;
  awaiting: number;
  notStarted: number;
  size?: number;
}) {
  const total = completed + awaiting + notStarted || 1;
  const a = (completed / total) * 360;
  const b = a + (awaiting / total) * 360;
  const bg = `conic-gradient(hsl(var(--success)) 0 ${a}deg, hsl(var(--warning)) ${a}deg ${b}deg, hsl(var(--border)) ${b}deg 360deg)`;
  const rows: Array<[string, number, string]> = [
    ["Completed", completed, "hsl(var(--success))"],
    ["Awaiting", awaiting, "hsl(var(--warning))"],
    ["Not started", notStarted, "hsl(var(--border))"],
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
      <div style={{ width: size, height: size, borderRadius: "50%", background: bg, flex: "none", position: "relative" }}>
        <div
          style={{
            position: "absolute",
            inset: size * 0.18,
            borderRadius: "50%",
            background: "hsl(var(--card))",
            display: "grid",
            placeItems: "center",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <div className="num" style={{ fontSize: 30 }}>{Math.round((completed / total) * 100)}%</div>
            <div className="eyebrow" style={{ fontSize: 9 }}>complete</div>
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map(([l, v, col]) => (
          <div key={l} className="row" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: col, flex: "none" }} />
            <span style={{ minWidth: 88, color: "hsl(var(--secondary-foreground))" }}>{l}</span>
            <span className="num" style={{ fontSize: 14 }}>{v}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Radar chart for cohort strengths. */
export function RadarChart({ data, size = 260 }: { data: Array<{ axis: string; value: number }>; size?: number }) {
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 34;
  const n = data.length || 1;
  const pt = (i: number, rad: number): [number, number] => {
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad];
  };
  const rings = [0.25, 0.5, 0.75, 1];
  const poly = data.map((d, i) => pt(i, R * (d.value / 100)).map((v) => v.toFixed(1)).join(",")).join(" ");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ maxWidth: "100%" }}>
      {rings.map((r, i) => (
        <polygon
          key={i}
          points={data.map((_, j) => pt(j, R * r).map((v) => v.toFixed(1)).join(",")).join(" ")}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth="1"
        />
      ))}
      {data.map((_, i) => {
        const [x, y] = pt(i, R);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="hsl(var(--border))" strokeWidth="1" />;
      })}
      <polygon points={poly} fill="hsl(var(--primary))" fillOpacity="0.16" stroke="hsl(var(--primary))" strokeWidth="2" />
      {data.map((d, i) => {
        const [x, y] = pt(i, R * (d.value / 100));
        return <circle key={i} cx={x} cy={y} r="3" fill="hsl(var(--primary))" />;
      })}
      {data.map((d, i) => {
        const [x, y] = pt(i, R + 16);
        return (
          <text
            key={i}
            x={x}
            y={y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontFamily="var(--font-mono)"
            fontSize="10"
            fontWeight="700"
            fill="hsl(var(--muted-foreground))"
            style={{ textTransform: "uppercase", letterSpacing: ".06em" }}
          >
            {d.axis}
          </text>
        );
      })}
    </svg>
  );
}

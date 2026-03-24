import React from "react";
import type { GraphQuestionSpec } from "@shared/schema";

const WIDTH = 640;
const HEIGHT = 360;
const M = { top: 28, right: 24, bottom: 52, left: 64 };

const plotLeft   = M.left;
const plotRight  = WIDTH  - M.right;
const plotTop    = M.top;
const plotBottom = HEIGHT - M.bottom;

function evaluateEquation(equation: string, x: number): number | null {
  const normalized = equation
    .replace(/^y\s*=\s*/i, "")            // strip "y = "
    .replace(/\^/g, "**")                 // ^ → ** (exponentiation)
    .replace(/([0-9])\s*x/g, "$1*x")     // 2x → 2*x  (implicit coefficient)
    .replace(/([0-9])\s*\(/g, "$1*(");   // 2(x+1) → 2*(x+1)
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("x", `return (${normalized});`) as (x: number) => number;
    const value = fn(x);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export default function GraphPlot({ spec }: { spec: GraphQuestionSpec }) {
  const [xMin, xMax] = spec.xRange;
  const [yMin, yMax] = spec.yRange;
  const tick = spec.tickInterval ?? 1;
  const axisLabels = spec.axisLabels ?? { x: "x", y: "y" };

  const xToSvg = (x: number) =>
    plotLeft + ((x - xMin) / (xMax - xMin)) * (plotRight - plotLeft);
  const yToSvg = (y: number) =>
    plotBottom - ((y - yMin) / (yMax - yMin)) * (plotBottom - plotTop);

  const sampledPoints = spec.equation
    ? Array.from({ length: 201 }, (_, i) => xMin + ((xMax - xMin) * i) / 200)
        .map((x) => ({ x, y: evaluateEquation(spec.equation!, x) }))
        .filter(
          (p): p is { x: number; y: number } =>
            p.y !== null && p.y >= yMin - (yMax - yMin) && p.y <= yMax + (yMax - yMin),
        )
    : [];

  const linePath = sampledPoints
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xToSvg(p.x).toFixed(2)} ${yToSvg(p.y).toFixed(2)}`)
    .join(" ");

  const plotPoints = [...(spec.points || []), ...(spec.highlightedPoints || [])];

  const xTicks = Array.from(
    { length: Math.floor((xMax - xMin) / tick) + 1 },
    (_, i) => xMin + i * tick,
  );
  const yTicks = Array.from(
    { length: Math.floor((yMax - yMin) / tick) + 1 },
    (_, i) => yMin + i * tick,
  );

  return (
    <div
      className="rounded-2xl border border-cyan-500/20 bg-slate-950/70 p-3 md:p-4"
      data-testid="graph-plot"
    >
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-[260px] md:h-[360px]"
        role="img"
        aria-label="Cartesian graph"
      >
        {/* Grid lines */}
        {spec.showGrid &&
          xTicks.map((x) => (
            <line
              key={`vg-${x}`}
              x1={xToSvg(x)}
              x2={xToSvg(x)}
              y1={plotTop}
              y2={plotBottom}
              stroke="rgba(148,163,184,0.12)"
              strokeWidth="1"
            />
          ))}
        {spec.showGrid &&
          yTicks.map((y) => (
            <line
              key={`hg-${y}`}
              x1={plotLeft}
              x2={plotRight}
              y1={yToSvg(y)}
              y2={yToSvg(y)}
              stroke="rgba(148,163,184,0.12)"
              strokeWidth="1"
            />
          ))}

        {/* Axes — clamp to plot area when 0 is outside visible range */}
        <line
          x1={plotLeft}
          x2={plotRight}
          y1={Math.max(plotTop, Math.min(plotBottom, yToSvg(0)))}
          y2={Math.max(plotTop, Math.min(plotBottom, yToSvg(0)))}
          stroke="rgba(226,232,240,0.55)"
          strokeWidth="1.5"
        />
        <line
          x1={Math.max(plotLeft, Math.min(plotRight, xToSvg(0)))}
          x2={Math.max(plotLeft, Math.min(plotRight, xToSvg(0)))}
          y1={plotTop}
          y2={plotBottom}
          stroke="rgba(226,232,240,0.55)"
          strokeWidth="1.5"
        />

        {/* Plotted line/curve */}
        {linePath ? (
          <path d={linePath} fill="none" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        ) : null}

        {/* Discrete plotted points */}
        {plotPoints.map((p, i) => (
          <g key={`pt-${p.x}-${p.y}-${i}`}>
            <circle cx={xToSvg(p.x)} cy={yToSvg(p.y)} r="5" fill="#a78bfa" />
            {p.label ? (
              <text
                x={xToSvg(p.x) + 8}
                y={yToSvg(p.y) - 8}
                fill="#e2e8f0"
                fontSize="13"
              >
                {p.label}
              </text>
            ) : null}
          </g>
        ))}

        {/* X-axis tick labels */}
        {xTicks.map((x) => (
          <text
            key={`xt-${x}`}
            x={xToSvg(x)}
            y={plotBottom + 18}
            textAnchor="middle"
            fill="#94a3b8"
            fontSize="12"
          >
            {x}
          </text>
        ))}

        {/* Y-axis tick labels — right-aligned flush against the plot area */}
        {yTicks.map((y) => (
          <text
            key={`yt-${y}`}
            x={plotLeft - 8}
            y={yToSvg(y) + 4}
            textAnchor="end"
            fill="#94a3b8"
            fontSize="12"
          >
            {y}
          </text>
        ))}

        {/* X-axis title — below the tick labels */}
        <text
          x={(plotLeft + plotRight) / 2}
          y={HEIGHT - 8}
          textAnchor="middle"
          fill="#cbd5e1"
          fontSize="13"
          fontWeight="500"
        >
          {axisLabels.x}
        </text>

        {/* Y-axis title — rotated, well to the left of tick labels */}
        <text
          x={13}
          y={(plotTop + plotBottom) / 2}
          textAnchor="middle"
          fill="#cbd5e1"
          fontSize="13"
          fontWeight="500"
          transform={`rotate(-90 13 ${(plotTop + plotBottom) / 2})`}
        >
          {axisLabels.y}
        </text>
      </svg>
    </div>
  );
}

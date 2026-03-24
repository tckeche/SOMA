import React from "react";
import type { GraphQuestionSpec } from "@shared/schema";

const WIDTH  = 640;
const HEIGHT = 380;
const M = { top: 36, right: 56, bottom: 36, left: 52 };

const plotLeft   = M.left;
const plotRight  = WIDTH  - M.right;
const plotTop    = M.top;
const plotBottom = HEIGHT - M.bottom;

const CURVE_COLORS = [
  "#38bdf8", // sky blue
  "#a78bfa", // violet
  "#34d399", // emerald
  "#fb923c", // orange
  "#f87171", // rose
  "#facc15", // yellow
];

function evaluateEquation(equation: string, x: number): number | null {
  const expr = equation
    .replace(/^y\s*=\s*/i, "")
    .replace(/\^/g, "**")
    .replace(/([0-9])\s*x/g, "$1*x")
    .replace(/([0-9])\s*\(/g, "$1*(")
    .replace(/Math\./g, "Math.");
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("x", `"use strict"; return (${expr});`) as (x: number) => number;
    const v = fn(x);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Build an SVG path string for an equation, breaking on discontinuities. */
function buildCurvePath(
  equation: string,
  xMin: number, xMax: number,
  yMin: number, yMax: number,
  xToSvg: (x: number) => number,
  yToSvg: (y: number) => number,
  numSamples = 500,
): string {
  const ySpan = yMax - yMin;
  const parts: string[] = [];
  let penDown = false;
  let prevY: number | null = null;

  for (let i = 0; i <= numSamples; i++) {
    const x = xMin + ((xMax - xMin) * i) / numSamples;
    const y = evaluateEquation(equation, x);

    if (y === null) { penDown = false; prevY = null; continue; }

    // Discontinuity: vertical jump larger than 4× visible range → lift pen
    if (prevY !== null && Math.abs(y - prevY) > ySpan * 4) {
      penDown = false;
    }

    const sx = xToSvg(x).toFixed(2);
    const sy = yToSvg(y).toFixed(2);

    parts.push(penDown ? `L ${sx} ${sy}` : `M ${sx} ${sy}`);
    penDown = true;
    prevY = y;
  }

  return parts.join(" ");
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

  // Axes clamped to plot area (handle ranges that don't include 0)
  const xAxisY = Math.max(plotTop, Math.min(plotBottom, yToSvg(0)));
  const yAxisX = Math.max(plotLeft, Math.min(plotRight, xToSvg(0)));

  const xTicks = Array.from(
    { length: Math.floor((xMax - xMin) / tick) + 1 },
    (_, i) => parseFloat((xMin + i * tick).toPrecision(10)),
  );
  const yTicks = Array.from(
    { length: Math.floor((yMax - yMin) / tick) + 1 },
    (_, i) => parseFloat((yMin + i * tick).toPrecision(10)),
  );

  // Resolve all curves (single equation → treat as curves[0])
  const allCurves: { equation: string; label?: string; color: string }[] = [];
  if (spec.curves && spec.curves.length > 0) {
    spec.curves.forEach((c, i) => {
      allCurves.push({
        equation: c.equation,
        label: c.label,
        color: c.color ?? CURVE_COLORS[i % CURVE_COLORS.length],
      });
    });
  } else if (spec.equation) {
    allCurves.push({ equation: spec.equation, color: CURVE_COLORS[0] });
  }

  const showLegend = allCurves.length > 1 && allCurves.some((c) => c.label);

  const plotPoints = [...(spec.points || []), ...(spec.highlightedPoints || [])];

  const clipId = "plot-clip";

  // Legend sizing
  const legendPad = 8;
  const legendLineW = 18;
  const legendEntries = showLegend ? allCurves.filter((c) => c.label) : [];
  const legendRowH = 18;
  const legendH = legendEntries.length * legendRowH + legendPad * 2;
  const legendW = Math.min(180, Math.max(...legendEntries.map((c) => (c.label?.length ?? 0) * 7 + legendLineW + 16)));
  const legendX = plotRight - legendW - 4;
  const legendY = plotTop + 4;

  return (
    <div
      className="rounded-2xl border border-cyan-500/20 bg-slate-950/70 p-3 md:p-4"
      data-testid="graph-plot"
    >
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-[260px] md:h-[380px]"
        role="img"
        aria-label="Cartesian graph"
      >
        <defs>
          {/* Clip path — all curves/points are clipped strictly to the plot area */}
          <clipPath id={clipId}>
            <rect x={plotLeft} y={plotTop} width={plotRight - plotLeft} height={plotBottom - plotTop} />
          </clipPath>
          {/* Arrowhead markers */}
          <marker id="arrow-x" markerWidth="7" markerHeight="7" refX="6" refY="2" orient="0">
            <path d="M0,0 L0,4 L7,2 z" fill="rgba(226,232,240,0.55)" />
          </marker>
          <marker id="arrow-y" markerWidth="7" markerHeight="7" refX="2" refY="0" orient="-90">
            <path d="M0,4 L4,4 L2,0 z" fill="rgba(226,232,240,0.55)" />
          </marker>
        </defs>

        {/* ── Grid lines (clipped) ─────────────────────────────────────── */}
        <g clipPath={`url(#${clipId})`}>
          {spec.showGrid &&
            xTicks.map((x) => (
              <line
                key={`vg-${x}`}
                x1={xToSvg(x)} x2={xToSvg(x)}
                y1={plotTop} y2={plotBottom}
                stroke="rgba(148,163,184,0.11)" strokeWidth="1"
              />
            ))}
          {spec.showGrid &&
            yTicks.map((y) => (
              <line
                key={`hg-${y}`}
                x1={plotLeft} x2={plotRight}
                y1={yToSvg(y)} y2={yToSvg(y)}
                stroke="rgba(148,163,184,0.11)" strokeWidth="1"
              />
            ))}
        </g>

        {/* ── Axes ────────────────────────────────────────────────────── */}
        {/* X axis with arrowhead at right end */}
        <line
          x1={plotLeft} x2={plotRight + 2}
          y1={xAxisY} y2={xAxisY}
          stroke="rgba(226,232,240,0.55)" strokeWidth="1.5"
          markerEnd="url(#arrow-x)"
        />
        {/* Y axis with arrowhead at top */}
        <line
          x1={yAxisX} x2={yAxisX}
          y1={plotBottom} y2={plotTop - 2}
          stroke="rgba(226,232,240,0.55)" strokeWidth="1.5"
          markerEnd="url(#arrow-y)"
        />

        {/* ── X tick labels (skip 0 where axes cross) ─────────────────── */}
        {xTicks.map((x) => {
          const skip = x === 0 && yMin < 0 && yMax > 0;
          return !skip ? (
            <text
              key={`xt-${x}`}
              x={xToSvg(x)}
              y={xAxisY + 16}
              textAnchor="middle"
              fill="#94a3b8"
              fontSize="11"
            >
              {x}
            </text>
          ) : null;
        })}

        {/* ── Y tick labels (skip 0 where axes cross) ─────────────────── */}
        {yTicks.map((y) => {
          const skip = y === 0 && xMin < 0 && xMax > 0;
          return !skip ? (
            <text
              key={`yt-${y}`}
              x={yAxisX - 7}
              y={yToSvg(y) + 4}
              textAnchor="end"
              fill="#94a3b8"
              fontSize="11"
            >
              {y}
            </text>
          ) : null;
        })}

        {/* ── Axis labels — right next to axes (Cartesian style) ──────── */}
        {/* X label: right next to the right end of the x-axis */}
        <text
          x={plotRight + 10}
          y={xAxisY + 5}
          textAnchor="start"
          fill="#cbd5e1"
          fontSize="13"
          fontWeight="600"
          fontStyle="italic"
        >
          {axisLabels.x}
        </text>
        {/* Y label: right next to the top of the y-axis */}
        <text
          x={yAxisX + 6}
          y={plotTop - 8}
          textAnchor="start"
          fill="#cbd5e1"
          fontSize="13"
          fontWeight="600"
          fontStyle="italic"
        >
          {axisLabels.y}
        </text>

        {/* ── Plotted curves (strictly clipped to plot area) ───────────── */}
        <g clipPath={`url(#${clipId})`}>
          {allCurves.map((c, i) => {
            const d = buildCurvePath(c.equation, xMin, xMax, yMin, yMax, xToSvg, yToSvg);
            return d ? (
              <path
                key={`curve-${i}`}
                d={d}
                fill="none"
                stroke={c.color}
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null;
          })}

          {/* Discrete plotted points */}
          {plotPoints.map((p, i) => (
            <g key={`pt-${p.x}-${p.y}-${i}`}>
              <circle cx={xToSvg(p.x)} cy={yToSvg(p.y)} r="4" fill="#a78bfa" stroke="#1e1b4b" strokeWidth="1" />
              {p.label ? (
                <text
                  x={xToSvg(p.x) + 8}
                  y={yToSvg(p.y) - 7}
                  fill="#e2e8f0"
                  fontSize="12"
                >
                  {p.label}
                </text>
              ) : null}
            </g>
          ))}
        </g>

        {/* ── Legend (when multiple labelled curves) ───────────────────── */}
        {showLegend && legendEntries.length > 0 && (
          <g>
            <rect
              x={legendX}
              y={legendY}
              width={legendW}
              height={legendH}
              rx="6"
              fill="rgba(15,23,42,0.82)"
              stroke="rgba(148,163,184,0.18)"
              strokeWidth="1"
            />
            {legendEntries.map((c, i) => (
              <g key={`legend-${i}`}>
                <line
                  x1={legendX + legendPad}
                  x2={legendX + legendPad + legendLineW}
                  y1={legendY + legendPad + i * legendRowH + legendRowH / 2}
                  y2={legendY + legendPad + i * legendRowH + legendRowH / 2}
                  stroke={c.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <text
                  x={legendX + legendPad + legendLineW + 5}
                  y={legendY + legendPad + i * legendRowH + legendRowH / 2 + 4}
                  fill="#e2e8f0"
                  fontSize="11"
                >
                  {c.label}
                </text>
              </g>
            ))}
          </g>
        )}
      </svg>
    </div>
  );
}

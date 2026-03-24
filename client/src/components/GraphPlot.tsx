import React from "react";
import type { GraphQuestionSpec } from "@shared/schema";

// ── Layout constants ──────────────────────────────────────────────────────────
const WIDTH  = 620;
const HEIGHT = 340;
const M = { top: 32, right: 48, bottom: 32, left: 50 };

const plotLeft   = M.left;
const plotRight  = WIDTH  - M.right;
const plotTop    = M.top;
const plotBottom = HEIGHT - M.bottom;
const plotW      = plotRight - plotLeft;   // 522
const plotH      = plotBottom - plotTop;   // 276

const CURVE_COLORS = [
  "#38bdf8", // sky blue
  "#a78bfa", // violet
  "#34d399", // emerald
  "#fb923c", // orange
  "#f87171", // rose
  "#facc15", // yellow
];

// ── Nice tick interval ────────────────────────────────────────────────────────
// Overrides the AI-supplied tickInterval so there are always 4-10 readable ticks.
function niceInterval(span: number): number {
  if (span <= 0) return 1;
  const rough = span / 8; // aim for ~8 ticks
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm  = rough / mag;
  // round to 1, 2, 2.5, 5, 10
  const nice  = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 3 ? 2.5 : norm <= 7.5 ? 5 : 10;
  return parseFloat((nice * mag).toPrecision(6));
}

// ── Equation evaluator ────────────────────────────────────────────────────────
function evaluateEquation(equation: string, x: number): number | null {
  const expr = equation
    .replace(/^y\s*=\s*/i, "")
    .replace(/\^/g, "**")
    .replace(/([0-9])\s*x/g, "$1*x")
    .replace(/([0-9])\s*\(/g, "$1*(");
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("x", `"use strict"; return (${expr});`) as (x: number) => number;
    const v  = fn(x);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// ── SVG path for a curve, with pen-lift on discontinuities ───────────────────
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
  let penDown  = false;
  let prevY: number | null = null;

  for (let i = 0; i <= numSamples; i++) {
    const x = xMin + ((xMax - xMin) * i) / numSamples;
    const y = evaluateEquation(equation, x);

    if (y === null) { penDown = false; prevY = null; continue; }

    if (prevY !== null && Math.abs(y - prevY) > ySpan * 4) {
      penDown = false; // lift pen on asymptote-like jump
    }

    parts.push(penDown
      ? `L ${xToSvg(x).toFixed(2)} ${yToSvg(y).toFixed(2)}`
      : `M ${xToSvg(x).toFixed(2)} ${yToSvg(y).toFixed(2)}`);
    penDown = true;
    prevY   = y;
  }
  return parts.join(" ");
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function GraphPlot({ spec }: { spec: GraphQuestionSpec }) {
  const [rawXMin, rawXMax] = spec.xRange;
  const [rawYMin, rawYMax] = spec.yRange;
  const axisLabels = spec.axisLabels ?? { x: "x", y: "y" };

  // ── Auto-correct extreme aspect ratio (cap x:y pixel ratio at 2:1) ──────────
  const xSpanNat = rawXMax - rawXMin;
  const ySpanNat = rawYMax - rawYMin;
  const xPPU = plotW / xSpanNat;  // x pixels-per-unit
  const yPPU = plotH / ySpanNat;  // y pixels-per-unit
  const pxRatio = xPPU / yPPU;    // > 1 → x zoomed in more than y

  let xMin = rawXMin, xMax = rawXMax, yMin = rawYMin, yMax = rawYMax;
  if (pxRatio > 2) {
    // x axis is too "zoomed in" — expand the y range so units balance
    const newYSpan = (plotH / plotW) * xSpanNat * 2;
    const cy = (rawYMin + rawYMax) / 2;
    yMin = cy - newYSpan / 2;
    yMax = cy + newYSpan / 2;
  } else if (pxRatio < 0.5) {
    // y axis is too "zoomed in" — expand the x range
    const newXSpan = (plotW / plotH) * ySpanNat * 2;
    const cx = (rawXMin + rawXMax) / 2;
    xMin = cx - newXSpan / 2;
    xMax = cx + newXSpan / 2;
  }

  // ── Coordinate transforms ──────────────────────────────────────────────────
  const xToSvg = (x: number) =>
    plotLeft  + ((x - xMin) / (xMax - xMin)) * plotW;
  const yToSvg = (y: number) =>
    plotBottom - ((y - yMin) / (yMax - yMin)) * plotH;

  // ── Axes (clamped inside plot area when 0 is off-range) ────────────────────
  const xAxisY = Math.max(plotTop,  Math.min(plotBottom, yToSvg(0)));
  const yAxisX = Math.max(plotLeft, Math.min(plotRight,  xToSvg(0)));

  // ── Smart tick interval ────────────────────────────────────────────────────
  const tick = niceInterval(Math.max(xMax - xMin, yMax - yMin));

  const xTicks = (() => {
    const start = Math.ceil(xMin / tick) * tick;
    const out: number[] = [];
    for (let v = start; v <= xMax + 1e-9; v = parseFloat((v + tick).toPrecision(10))) {
      out.push(parseFloat(v.toPrecision(10)));
    }
    return out;
  })();

  const yTicks = (() => {
    const start = Math.ceil(yMin / tick) * tick;
    const out: number[] = [];
    for (let v = start; v <= yMax + 1e-9; v = parseFloat((v + tick).toPrecision(10))) {
      out.push(parseFloat(v.toPrecision(10)));
    }
    return out;
  })();

  // ── Resolve curves ─────────────────────────────────────────────────────────
  const allCurves: { equation: string; label?: string; color: string }[] = [];
  if (spec.curves && spec.curves.length > 0) {
    spec.curves.forEach((c, i) => allCurves.push({
      equation: c.equation,
      label:    c.label,
      color:    c.color ?? CURVE_COLORS[i % CURVE_COLORS.length],
    }));
  } else if (spec.equation) {
    allCurves.push({ equation: spec.equation, color: CURVE_COLORS[0] });
  }

  const showLegend    = allCurves.length > 1 && allCurves.some((c) => c.label);
  const legendEntries = showLegend ? allCurves.filter((c) => c.label) : [];
  const plotPoints    = [...(spec.points || []), ...(spec.highlightedPoints || [])];
  const tickSize      = 4; // half-length of tick marks in px

  return (
    <div
      className="rounded-2xl border border-cyan-500/20 bg-slate-950/70 p-3 md:p-4"
      data-testid="graph-plot"
    >
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-[230px] md:h-[340px]"
        role="img"
        aria-label="Cartesian graph"
      >
        <defs>
          {/* Clip to plot area — curves & points cannot bleed outside */}
          <clipPath id="plot-clip">
            <rect
              x={plotLeft} y={plotTop}
              width={plotRight - plotLeft}
              height={plotBottom - plotTop}
            />
          </clipPath>

          {/*
            Single arrowhead used for BOTH axes.
            orient="auto" rotates the marker to match each line's direction:
              • X axis (→): 0°  — arrow points right  ✓
              • Y axis (↑, y2 < y1 in SVG): −90°  — arrow points up  ✓
            The tip of the triangle is at (8, 4); refX/refY place that tip
            exactly at the line endpoint so there's no gap or overshoot.
          */}
          <marker
            id="arrowhead"
            markerWidth="8" markerHeight="8"
            refX="8" refY="4"
            orient="auto"
          >
            <path d="M0,1 L8,4 L0,7 z" fill="rgba(226,232,240,0.60)" />
          </marker>
        </defs>

        {/* ── Grid lines ────────────────────────────────────────────────── */}
        <g clipPath="url(#plot-clip)">
          {spec.showGrid && xTicks.map((x) => (
            <line
              key={`vg-${x}`}
              x1={xToSvg(x)} x2={xToSvg(x)}
              y1={plotTop}   y2={plotBottom}
              stroke="rgba(148,163,184,0.10)" strokeWidth="1"
            />
          ))}
          {spec.showGrid && yTicks.map((y) => (
            <line
              key={`hg-${y}`}
              x1={plotLeft} x2={plotRight}
              y1={yToSvg(y)} y2={yToSvg(y)}
              stroke="rgba(148,163,184,0.10)" strokeWidth="1"
            />
          ))}
        </g>

        {/* ── Axes with arrowheads ──────────────────────────────────────── */}
        {/* X axis → */}
        <line
          x1={plotLeft} x2={plotRight + 4}
          y1={xAxisY}   y2={xAxisY}
          stroke="rgba(226,232,240,0.55)" strokeWidth="1.5"
          markerEnd="url(#arrowhead)"
        />
        {/* Y axis ↑ (line drawn bottom→top so marker points up) */}
        <line
          x1={yAxisX} x2={yAxisX}
          y1={plotBottom} y2={plotTop - 4}
          stroke="rgba(226,232,240,0.55)" strokeWidth="1.5"
          markerEnd="url(#arrowhead)"
        />

        {/* ── Tick marks on axes ────────────────────────────────────────── */}
        {xTicks.map((x) => {
          const sx = xToSvg(x);
          if (sx < plotLeft - 1 || sx > plotRight + 1) return null;
          return (
            <line
              key={`xtick-${x}`}
              x1={sx} x2={sx}
              y1={xAxisY - tickSize} y2={xAxisY + tickSize}
              stroke="rgba(148,163,184,0.55)" strokeWidth="1"
            />
          );
        })}
        {yTicks.map((y) => {
          const sy = yToSvg(y);
          if (sy < plotTop - 1 || sy > plotBottom + 1) return null;
          return (
            <line
              key={`ytick-${y}`}
              x1={yAxisX - tickSize} x2={yAxisX + tickSize}
              y1={sy} y2={sy}
              stroke="rgba(148,163,184,0.55)" strokeWidth="1"
            />
          );
        })}

        {/* ── Tick labels ───────────────────────────────────────────────── */}
        {xTicks.map((x) => {
          const sx = xToSvg(x);
          if (sx < plotLeft - 1 || sx > plotRight + 1) return null;
          // Skip "0" where axes cross to avoid cluttered origin
          const skipZero = x === 0 && yMin < 0 && yMax > 0;
          return !skipZero ? (
            <text
              key={`xl-${x}`}
              x={sx} y={xAxisY + 15}
              textAnchor="middle" fill="#94a3b8" fontSize="11"
            >
              {x}
            </text>
          ) : null;
        })}
        {yTicks.map((y) => {
          const sy = yToSvg(y);
          if (sy < plotTop - 1 || sy > plotBottom + 1) return null;
          const skipZero = y === 0 && xMin < 0 && xMax > 0;
          return !skipZero ? (
            <text
              key={`yl-${y}`}
              x={yAxisX - 8} y={sy + 4}
              textAnchor="end" fill="#94a3b8" fontSize="11"
            >
              {y}
            </text>
          ) : null;
        })}

        {/* ── Axis labels — right next to each axis end ─────────────────── */}
        {/* X label: to the right of the arrowhead */}
        <text
          x={plotRight + 10} y={xAxisY + 4}
          textAnchor="start" fill="#cbd5e1"
          fontSize="13" fontWeight="600" fontStyle="italic"
        >
          {axisLabels.x}
        </text>
        {/* Y label: just above the arrowhead */}
        <text
          x={yAxisX + 5} y={plotTop - 8}
          textAnchor="start" fill="#cbd5e1"
          fontSize="13" fontWeight="600" fontStyle="italic"
        >
          {axisLabels.y}
        </text>

        {/* ── Curves (clipped strictly to plot area) ────────────────────── */}
        <g clipPath="url(#plot-clip)">
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

          {/* Scatter / highlighted points */}
          {plotPoints.map((p, i) => (
            <g key={`pt-${p.x}-${p.y}-${i}`}>
              <circle
                cx={xToSvg(p.x)} cy={yToSvg(p.y)} r="4"
                fill="#a78bfa" stroke="#1e1b4b" strokeWidth="1"
              />
              {p.label && (
                <text
                  x={xToSvg(p.x) + 8} y={yToSvg(p.y) - 6}
                  fill="#e2e8f0" fontSize="11"
                >
                  {p.label}
                </text>
              )}
            </g>
          ))}
        </g>
      </svg>

      {/* ── Legend — rendered as HTML below the plot ──────────────────────── */}
      {showLegend && legendEntries.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 mt-2 pt-2 border-t border-white/5">
          {legendEntries.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <span
                className="inline-block rounded-full flex-shrink-0"
                style={{ width: 20, height: 2, background: c.color }}
              />
              <span className="text-xs text-slate-300 whitespace-nowrap">{c.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

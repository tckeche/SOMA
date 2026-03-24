import React from "react";
import type { GraphQuestionSpec } from "@shared/schema";

// ── Layout constants ──────────────────────────────────────────────────────────
const WIDTH  = 620;
const HEIGHT = 340;
// left=64 gives enough room for labels like "−100" without clipping
const M = { top: 32, right: 50, bottom: 32, left: 64 };

const plotLeft   = M.left;
const plotRight  = WIDTH  - M.right;
const plotTop    = M.top;
const plotBottom = HEIGHT - M.bottom;
const plotW      = plotRight - plotLeft;   // 520
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
// Always produces 4–10 readable, "round number" ticks regardless of range size.
function niceInterval(span: number): number {
  if (span <= 0) return 1;
  const rough = span / 8;
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm  = rough / mag;
  const nice  = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 3 ? 2.5 : norm <= 7.5 ? 5 : 10;
  return parseFloat((nice * mag).toPrecision(6));
}

// ── Safe equation evaluator ───────────────────────────────────────────────────
// Injects the full Math object so equations like sin(x), cos(x), exp(x),
// sqrt(x), log(x), abs(x), PI etc. work without any extra pre-processing.
function evaluateEquation(eq: string, x: number): number | null {
  const expr = eq
    .replace(/^y\s*=\s*/i, "")           // strip "y = " prefix
    .replace(/\^/g, "**")                  // ^ → **
    .replace(/([0-9])\s*x/g, "$1*x")      // 2x → 2*x
    .replace(/([0-9])\s*\(/g, "$1*(");    // 2( → 2*(
  try {
    // Destructure Math so authors can write sin(x) instead of Math.sin(x).
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "x",
      `"use strict";
       const {abs,acos,acosh,asin,asinh,atan,atanh,atan2,cbrt,ceil,clz32,cos,cosh,
              exp,expm1,floor,fround,hypot,imul,log,log10,log1p,log2,max,min,pow,
              random,round,sign,sin,sinh,sqrt,tan,tanh,trunc,
              PI,E,LN2,LN10,LOG2E,LOG10E,SQRT2,SQRT1_2} = Math;
       return (${expr});`,
    ) as (x: number) => number;
    const v = fn(x);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// ── SVG path with pen-lift on discontinuities ─────────────────────────────────
function buildCurvePath(
  eq: string,
  xMin: number, xMax: number,
  yMin: number, yMax: number,
  xToSvg: (x: number) => number,
  yToSvg: (y: number) => number,
  numSamples = 600,
): string {
  const ySpan  = yMax - yMin;
  const parts: string[] = [];
  let penDown  = false;
  let prevY: number | null = null;

  for (let i = 0; i <= numSamples; i++) {
    const x = xMin + ((xMax - xMin) * i) / numSamples;
    const y = evaluateEquation(eq, x);

    if (y === null) { penDown = false; prevY = null; continue; }

    // Lift pen on asymptote-like discontinuity
    if (prevY !== null && Math.abs(y - prevY) > ySpan * 4) penDown = false;

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
  const [xMin, xMax] = spec.xRange;
  const [yMin, yMax] = spec.yRange;
  const axisLabels   = spec.axisLabels ?? { x: "x", y: "y" };

  // ── Coordinate transforms using the AI's exact ranges ────────────────────
  // We trust the AI to choose ranges that show all curves fully.
  // We do NOT auto-correct the ranges — that caused incorrect clipping.
  const xToSvg = (x: number) =>
    plotLeft  + ((x - xMin) / (xMax - xMin)) * plotW;
  const yToSvg = (y: number) =>
    plotBottom - ((y - yMin) / (yMax - yMin)) * plotH;

  // Axes clamped to plot area (handles ranges that don't include 0)
  const xAxisY = Math.max(plotTop,  Math.min(plotBottom, yToSvg(0)));
  const yAxisX = Math.max(plotLeft, Math.min(plotRight,  xToSvg(0)));

  // ── Smart tick intervals (independent per axis) ───────────────────────────
  const xTick = niceInterval(xMax - xMin);
  const yTick = niceInterval(yMax - yMin);

  const makeTicks = (lo: number, hi: number, step: number) => {
    const start = Math.ceil(lo / step) * step;
    const out: number[] = [];
    for (let v = start; v <= hi + 1e-9; v = parseFloat((v + step).toPrecision(10))) {
      out.push(parseFloat(v.toPrecision(10)));
    }
    return out;
  };
  const xTicks = makeTicks(xMin, xMax, xTick);
  const yTicks = makeTicks(yMin, yMax, yTick);

  // ── Curves ────────────────────────────────────────────────────────────────
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
  const TICK_SIZE     = 4; // half-length of tick cross-hairs (px)

  return (
    <div
      className="rounded-2xl border border-cyan-500/20 bg-slate-950/70 p-3 md:p-4"
      data-testid="graph-plot"
    >
      {/*
        SVG sizing: `w-full` + no fixed height → browser computes height from viewBox aspect
        ratio (620:340 ≈ 1.82:1), so the graph scales proportionally on every screen size.
        A max-width wrapper caps the graph at its natural 620 px width so it never stretches
        into an ultra-wide canvas on large monitors.
      */}
      <div className="w-full max-w-[620px] mx-auto">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full block"
        role="img"
        aria-label="Cartesian graph"
      >
        <defs>
          {/*
            ClipPath restricted to exact plot rectangle.
            Curves are drawn at full precision and then clipped here —
            the AI sets yRange to encompass the whole curve, so nothing
            meaningful is cut off; only out-of-range overflow is hidden.
          */}
          <clipPath id="plot-clip">
            <rect x={plotLeft} y={plotTop} width={plotW} height={plotH} />
          </clipPath>

          {/*
            Single arrowhead for both axes.
            orient="auto" rotates to match the line direction:
              X axis (→ rightward)  →  0°   ✓
              Y axis (↑ upward, y2 < y1 in SVG coords) → −90°  ✓
            refX="8" places the triangle tip exactly at the line end.
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
            <line key={`vg-${x}`}
              x1={xToSvg(x)} x2={xToSvg(x)} y1={plotTop} y2={plotBottom}
              stroke="rgba(148,163,184,0.10)" strokeWidth="1"
            />
          ))}
          {spec.showGrid && yTicks.map((y) => (
            <line key={`hg-${y}`}
              x1={plotLeft} x2={plotRight} y1={yToSvg(y)} y2={yToSvg(y)}
              stroke="rgba(148,163,184,0.10)" strokeWidth="1"
            />
          ))}
        </g>

        {/* ── X axis → ──────────────────────────────────────────────────── */}
        <line
          x1={plotLeft} x2={plotRight + 5}
          y1={xAxisY}   y2={xAxisY}
          stroke="rgba(226,232,240,0.55)" strokeWidth="1.5"
          markerEnd="url(#arrowhead)"
        />

        {/* ── Y axis ↑ (drawn bottom→top so marker-end points up) ─────── */}
        <line
          x1={yAxisX} x2={yAxisX}
          y1={plotBottom} y2={plotTop - 5}
          stroke="rgba(226,232,240,0.55)" strokeWidth="1.5"
          markerEnd="url(#arrowhead)"
        />

        {/* ── Tick marks on X axis ──────────────────────────────────────── */}
        {xTicks.map((x) => {
          const sx = xToSvg(x);
          if (sx < plotLeft - 1 || sx > plotRight + 1) return null;
          return (
            <line key={`xtk-${x}`}
              x1={sx} x2={sx}
              y1={xAxisY - TICK_SIZE} y2={xAxisY + TICK_SIZE}
              stroke="rgba(148,163,184,0.6)" strokeWidth="1"
            />
          );
        })}

        {/* ── Tick marks on Y axis ──────────────────────────────────────── */}
        {yTicks.map((y) => {
          const sy = yToSvg(y);
          if (sy < plotTop - 1 || sy > plotBottom + 1) return null;
          return (
            <line key={`ytk-${y}`}
              x1={yAxisX - TICK_SIZE} x2={yAxisX + TICK_SIZE}
              y1={sy} y2={sy}
              stroke="rgba(148,163,184,0.6)" strokeWidth="1"
            />
          );
        })}

        {/* ── X tick labels ─────────────────────────────────────────────── */}
        {xTicks.map((x) => {
          const sx = xToSvg(x);
          if (sx < plotLeft - 1 || sx > plotRight + 1) return null;
          const skipOrigin = x === 0 && yMin < 0 && yMax > 0;
          return !skipOrigin ? (
            <text key={`xl-${x}`}
              x={sx} y={xAxisY + 16}
              textAnchor="middle" fill="#94a3b8" fontSize="11"
            >
              {x}
            </text>
          ) : null;
        })}

        {/* ── Y tick labels ─────────────────────────────────────────────── */}
        {yTicks.map((y) => {
          const sy = yToSvg(y);
          if (sy < plotTop - 1 || sy > plotBottom + 1) return null;
          const skipOrigin = y === 0 && xMin < 0 && xMax > 0;
          return !skipOrigin ? (
            <text key={`yl-${y}`}
              x={yAxisX - 9} y={sy + 4}
              textAnchor="end" fill="#94a3b8" fontSize="11"
            >
              {y}
            </text>
          ) : null;
        })}

        {/* ── Axis name labels (right next to arrowheads) ───────────────── */}
        <text
          x={plotRight + 12} y={xAxisY + 4}
          textAnchor="start" fill="#cbd5e1"
          fontSize="13" fontWeight="600" fontStyle="italic"
        >
          {axisLabels.x}
        </text>
        <text
          x={yAxisX + 6} y={plotTop - 8}
          textAnchor="start" fill="#cbd5e1"
          fontSize="13" fontWeight="600" fontStyle="italic"
        >
          {axisLabels.y}
        </text>

        {/* ── Curves, clipped to plot area ──────────────────────────────── */}
        <g clipPath="url(#plot-clip)">
          {allCurves.map((c, i) => {
            const d = buildCurvePath(c.equation, xMin, xMax, yMin, yMax, xToSvg, yToSvg);
            return d ? (
              <path key={`curve-${i}`}
                d={d} fill="none"
                stroke={c.color} strokeWidth="1.4"
                strokeLinecap="round" strokeLinejoin="round"
              />
            ) : null;
          })}

          {plotPoints.map((p, i) => (
            <g key={`pt-${p.x}-${p.y}-${i}`}>
              <circle
                cx={xToSvg(p.x)} cy={yToSvg(p.y)} r="4"
                fill="#a78bfa" stroke="#1e1b4b" strokeWidth="1"
              />
              {p.label && (
                <text x={xToSvg(p.x) + 8} y={yToSvg(p.y) - 6} fill="#e2e8f0" fontSize="11">
                  {p.label}
                </text>
              )}
            </g>
          ))}
        </g>
      </svg>

      {/* ── Legend — HTML below the SVG (no in-plot overlap) ─────────────── */}
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
      </div>{/* end max-w-[620px] wrapper */}
    </div>
  );
}

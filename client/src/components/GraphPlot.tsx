import React from "react";
import type { GraphQuestionSpec } from "@shared/schema";

const WIDTH = 640;
const HEIGHT = 360;
const PADDING = 48;

function evaluateEquation(equation: string, x: number): number | null {
  const normalized = equation.replace(/^y\s*=\s*/i, "").replace(/\^/g, "**");
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("x", `return ${normalized};`) as (x: number) => number;
    const value = fn(x);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export default function GraphPlot({ spec }: { spec: GraphQuestionSpec }) {
  const [xMin, xMax] = spec.xRange;
  const [yMin, yMax] = spec.yRange;
  const tick = spec.tickInterval;
  const xToSvg = (x: number) => PADDING + ((x - xMin) / (xMax - xMin)) * (WIDTH - PADDING * 2);
  const yToSvg = (y: number) => HEIGHT - PADDING - ((y - yMin) / (yMax - yMin)) * (HEIGHT - PADDING * 2);

  const sampledPoints = spec.equation
    ? Array.from({ length: 81 }, (_, index) => xMin + ((xMax - xMin) * index) / 80)
        .map((x) => ({ x, y: evaluateEquation(spec.equation!, x) }))
        .filter((point): point is { x: number; y: number } => point.y !== null && point.y >= yMin - 5 && point.y <= yMax + 5)
    : [];

  const linePath = sampledPoints
    .map((point, index) => `${index === 0 ? "M" : "L"} ${xToSvg(point.x)} ${yToSvg(point.y)}`)
    .join(" ");

  const plotPoints = [...(spec.points || []), ...(spec.highlightedPoints || [])];

  return (
    <div className="rounded-2xl border border-cyan-500/20 bg-slate-950/70 p-4 md:p-5" data-testid="graph-plot">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full h-[280px] md:h-[360px]" role="img" aria-label="Cartesian graph">
        {spec.showGrid && Array.from({ length: Math.floor((xMax - xMin) / tick) + 1 }, (_, i) => xMin + i * tick).map((x) => (
          <line key={`vx-${x}`} x1={xToSvg(x)} x2={xToSvg(x)} y1={PADDING} y2={HEIGHT - PADDING} stroke="rgba(148,163,184,0.15)" />
        ))}
        {spec.showGrid && Array.from({ length: Math.floor((yMax - yMin) / tick) + 1 }, (_, i) => yMin + i * tick).map((y) => (
          <line key={`hy-${y}`} x1={PADDING} x2={WIDTH - PADDING} y1={yToSvg(y)} y2={yToSvg(y)} stroke="rgba(148,163,184,0.15)" />
        ))}
        <line x1={PADDING} x2={WIDTH - PADDING} y1={yToSvg(0)} y2={yToSvg(0)} stroke="rgba(226,232,240,0.7)" />
        <line x1={xToSvg(0)} x2={xToSvg(0)} y1={PADDING} y2={HEIGHT - PADDING} stroke="rgba(226,232,240,0.7)" />
        {linePath ? <path d={linePath} fill="none" stroke="#22d3ee" strokeWidth="3" /> : null}
        {plotPoints.map((point, index) => (
          <g key={`${point.x}-${point.y}-${index}`}>
            <circle cx={xToSvg(point.x)} cy={yToSvg(point.y)} r="5" fill="#a78bfa" />
            {point.label ? <text x={xToSvg(point.x) + 8} y={yToSvg(point.y) - 8} fill="#e2e8f0" fontSize="14">{point.label}</text> : null}
          </g>
        ))}
        {Array.from({ length: Math.floor((xMax - xMin) / tick) + 1 }, (_, i) => xMin + i * tick).map((x) => (
          <text key={`xt-${x}`} x={xToSvg(x)} y={HEIGHT - 20} textAnchor="middle" fill="#94a3b8" fontSize="12">{x}</text>
        ))}
        {Array.from({ length: Math.floor((yMax - yMin) / tick) + 1 }, (_, i) => yMin + i * tick).map((y) => (
          <text key={`yt-${y}`} x={22} y={yToSvg(y) + 4} textAnchor="middle" fill="#94a3b8" fontSize="12">{y}</text>
        ))}
        <text x={WIDTH / 2} y={HEIGHT - 4} textAnchor="middle" fill="#e2e8f0" fontSize="14">{spec.axisLabels.x}</text>
        <text x={18} y={HEIGHT / 2} textAnchor="middle" fill="#e2e8f0" fontSize="14" transform={`rotate(-90 18 ${HEIGHT / 2})`}>{spec.axisLabels.y}</text>
      </svg>
    </div>
  );
}

import React, { useId } from "react";
import type { GraphQuestionSpec } from "@shared/schema";
import { applyGraphPreset } from "@/lib/graphPresets";

// ── Layout constants ──────────────────────────────────────────────────────────
const WIDTH  = 620;
const HEIGHT = 340;
// left=72 gives enough room for labels like "−100" without clipping
const M = { top: 36, right: 56, bottom: 36, left: 72 };

const plotLeft   = M.left;
const plotRight  = WIDTH  - M.right;
const plotTop    = M.top;
const plotBottom = HEIGHT - M.bottom;
const plotW      = plotRight - plotLeft;   // 492
const plotH      = plotBottom - plotTop;   // 268

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
type MathFn = (v: number) => number;
const FN_TABLE: Record<string, MathFn> = {
  abs: Math.abs,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  ceil: Math.ceil,
  cos: Math.cos,
  exp: Math.exp,
  floor: Math.floor,
  log: Math.log,   // natural log
  ln: Math.log,
  log10: Math.log10,
  round: Math.round,
  sign: Math.sign,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan,
  trunc: Math.trunc,
};

type Token =
  | { t: "num"; v: number }
  | { t: "var"; n: "x" | "y" }
  | { t: "const"; v: number }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "^" | "u-" }
  | { t: "fn"; v: string }
  | { t: "lp" }
  | { t: "rp" };

function normalizeExpression(raw: string): string {
  return raw
    .replace(/^y\s*=\s*/i, "")
    .replace(/[−–—]/g, "-")
    .replace(/[×⋅]/g, "*")
    .replace(/[÷]/g, "/")
    .replace(/π/gi, "pi")
    .replace(/\s+/g, "")
    .replace(/(\d)(x|\()/gi, "$1*$2")
    .replace(/(x|\))(\d)/gi, "$1*$2")
    .replace(/(x|\))\(/gi, "$1*(")
    .replace(/\)(x)/gi, ")*$1")
    // Add implicit multiplication before known functions only (e.g. 2sin(x) -> 2*sin(x)),
    // without breaking scientific notation like 1e-3.
    .replace(/(\d)(?=(?:abs|acos|asin|atan|ceil|cos|exp|floor|ln|log10|log|round|sign|sin|sqrt|tan|trunc)\()/gi, "$1*");
}

// ── Equation display label ─────────────────────────────────────────────────────
// Converts a raw JS equation expression to human-readable Unicode math.
// Used as a fallback when spec.label is not provided.
function prettyEquation(eq: string): string {
  let s = eq.replace(/^y\s*=\s*/i, "").trim();
  // Trig in degrees
  s = s.replace(/Math\.(sin|cos|tan)\(\s*x\s*\*\s*Math\.PI\s*\/\s*180\s*\)/gi, (_, fn) => `${fn} x°`);
  s = s.replace(/Math\.(sin|cos|tan)\(\s*Math\.PI\s*\*\s*x\s*\/\s*180\s*\)/gi, (_, fn) => `${fn} x°`);
  // Trig in radians
  s = s.replace(/Math\.(sin|cos|tan)\(\s*x\s*\)/gi, (_, fn) => `${fn} x`);
  s = s.replace(/Math\.(sin|cos|tan)\(/gi, (_, fn) => `${fn}(`);
  // Exponential / log
  s = s.replace(/Math\.exp\(\s*x\s*\)/gi, "eˣ");
  s = s.replace(/Math\.exp\(/gi, "exp(");
  s = s.replace(/Math\.log\(\s*x\s*\)/gi, "ln x");
  s = s.replace(/Math\.log\(/gi, "ln(");
  s = s.replace(/Math\.log10\(\s*x\s*\)/gi, "log x");
  s = s.replace(/Math\.log10\(/gi, "log₁₀(");
  // sqrt / abs
  s = s.replace(/Math\.sqrt\(\s*x\s*\)/gi, "√x");
  s = s.replace(/Math\.sqrt\(/gi, "√(");
  s = s.replace(/Math\.abs\(\s*x\s*\)/gi, "|x|");
  s = s.replace(/Math\.abs\(/gi, "|");
  // Constants
  s = s.replace(/Math\.PI/g, "π");
  s = s.replace(/Math\.E\b/g, "e");
  // Powers: x**2 → x², x**3 → x³
  const supMap: Record<string, string> = {"0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹"};
  s = s.replace(/x\*\*(\d)/g, (_, d) => `x${supMap[d] ?? `^${d}`}`);
  s = s.replace(/\*\*/g, "^");
  // Implicit multiplication: 2*x → 2x
  s = s.replace(/(\d)\s*\*\s*x/g, "$1x");
  s = s.replace(/(\d)\s*\*\s*\(/g, "$1(");
  // Remaining bare * → middle dot
  s = s.replace(/\s*\*\s*/g, "·");
  return s.trim();
}

// Prefer spec.label (AI-supplied clean name), fall back to "y = prettyEquation()".
// Returns the FULL display string including any variable prefix (e.g. "s = 4θ", "A = ¾r²").
// Callers must NOT prepend "y = " — this function owns the complete label text.
function equationDisplayLabel(spec: { equation?: string; label?: string }): string {
  if (spec.label) return spec.label.trim();
  if (spec.equation) return `y = ${prettyEquation(spec.equation)}`;
  return "";
}

function tokenize(expr: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/[0-9.]/.test(ch)) {
      let j = i + 1;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const n = Number(expr.slice(i, j));
      if (!Number.isFinite(n)) return null;
      out.push({ t: "num", v: n });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i + 1;
      while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j++;
      const id = expr.slice(i, j);
      if (/^x$/i.test(id)) out.push({ t: "var", n: "x" });
      else if (/^y$/i.test(id)) out.push({ t: "var", n: "y" });
      else if (/^pi$/i.test(id)) out.push({ t: "const", v: Math.PI });
      else if (/^e$/i.test(id)) out.push({ t: "const", v: Math.E });
      else if (FN_TABLE[id.toLowerCase()]) out.push({ t: "fn", v: id.toLowerCase() });
      else return null;
      i = j;
      continue;
    }
    if (ch === "(") { out.push({ t: "lp" }); i++; continue; }
    if (ch === ")") { out.push({ t: "rp" }); i++; continue; }
    if ("+-*/^".includes(ch)) {
      const prev = out[out.length - 1];
      const unary = ch === "-" && (!prev || prev.t === "op" || prev.t === "lp");
      out.push({ t: "op", v: unary ? "u-" : (ch as "+" | "-" | "*" | "/" | "^") });
      i++;
      continue;
    }
    return null;
  }
  return out;
}

function toRpn(tokens: Token[]): Token[] | null {
  const out: Token[] = [];
  const stack: Token[] = [];
  type Op = "+" | "-" | "*" | "/" | "^" | "u-";
  const prec = (op: Op) => (op === "u-" ? 4 : op === "^" ? 3 : op === "*" || op === "/" ? 2 : 1);
  const rightAssoc = (op: Op) => op === "^" || op === "u-";

  for (const tok of tokens) {
    if (tok.t === "num" || tok.t === "var" || tok.t === "const") {
      out.push(tok);
      continue;
    }
    if (tok.t === "fn") {
      stack.push(tok);
      continue;
    }
    if (tok.t === "op") {
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.t === "fn") {
          out.push(stack.pop()!);
          continue;
        }
        if (top.t === "op" && (prec(top.v) > prec(tok.v) || (prec(top.v) === prec(tok.v) && !rightAssoc(tok.v)))) {
          out.push(stack.pop()!);
          continue;
        }
        break;
      }
      stack.push(tok);
      continue;
    }
    if (tok.t === "lp") {
      stack.push(tok);
      continue;
    }
    if (tok.t === "rp") {
      let found = false;
      while (stack.length) {
        const top = stack.pop()!;
        if (top.t === "lp") { found = true; break; }
        out.push(top);
      }
      if (!found) return null;
      if (stack.length && stack[stack.length - 1].t === "fn") out.push(stack.pop()!);
    }
  }

  while (stack.length) {
    const top = stack.pop()!;
    if (top.t === "lp" || top.t === "rp") return null;
    out.push(top);
  }
  return out;
}

function evalRpn(rpn: Token[], vars: { x: number; y: number }): number | null {
  const s: number[] = [];
  for (const tok of rpn) {
    if (tok.t === "num") { s.push(tok.v); continue; }
    if (tok.t === "var") { s.push(tok.n === "x" ? vars.x : vars.y); continue; }
    if (tok.t === "const") { s.push(tok.v); continue; }
    if (tok.t === "fn") {
      const a = s.pop();
      if (a === undefined) return null;
      const fn = FN_TABLE[tok.v];
      if (!fn) return null;
      s.push(fn(a));
      continue;
    }
    if (tok.t === "op") {
      if (tok.v === "u-") {
        const a = s.pop();
        if (a === undefined) return null;
        s.push(-a);
        continue;
      }
      const b = s.pop();
      const a = s.pop();
      if (a === undefined || b === undefined) return null;
      switch (tok.v) {
        case "+": s.push(a + b); break;
        case "-": s.push(a - b); break;
        case "*": s.push(a * b); break;
        case "/": s.push(a / b); break;
        case "^": s.push(Math.pow(a, b)); break;
      }
    }
  }
  if (s.length !== 1) return null;
  return Number.isFinite(s[0]) ? s[0] : null;
}

function compileEquation(eq: string, variable: "x" | "t" = "x"): ((x: number) => number | null) | null {
  const source = variable === "t" ? eq.replace(/\bt\b/gi, "x") : eq;
  const normalized = normalizeExpression(source);
  const tokens = tokenize(normalized);
  if (!tokens) return null;
  const rpn = toRpn(tokens);
  if (!rpn) return null;
  return (x: number) => evalRpn(rpn, { x, y: 0 });
}

function compileImplicitEquation(eq: string): ((x: number, y: number) => number | null) | null {
  const source = eq.includes("=")
    ? (() => {
      const [lhs, rhs] = eq.split("=");
      return `(${lhs})-(${rhs})`;
    })()
    : eq;
  const normalized = normalizeExpression(source);
  const tokens = tokenize(normalized);
  if (!tokens) return null;
  const rpn = toRpn(tokens);
  if (!rpn) return null;
  return (x: number, y: number) => evalRpn(rpn, { x, y });
}

// ── SVG path with pen-lift on discontinuities ─────────────────────────────────
// Returns null (not "") when nothing can be plotted — callers skip rendering entirely.
function buildCurvePath(
  eq: string,
  xMin: number, xMax: number,
  yMin: number, yMax: number,
  xToSvg: (x: number) => number,
  yToSvg: (y: number) => number,
  numSamples = 600,
): string | null {
  const ySpan  = yMax - yMin;
  const parts: string[] = [];
  let penDown  = false;
  let prevY: number | null = null;
  const fn = compileEquation(eq);
  if (!fn) return null;

  for (let i = 0; i <= numSamples; i++) {
    const x = xMin + ((xMax - xMin) * i) / numSamples;
    const y = fn(x);

    if (y === null) { penDown = false; prevY = null; continue; }

    // Lift pen on asymptote-like discontinuity
    const tooSteepJump = prevY !== null && Math.abs(y - prevY) > ySpan * 2.25;
    const outOfView = y < yMin - ySpan * 0.25 || y > yMax + ySpan * 0.25;
    if (tooSteepJump || outOfView) {
      penDown = false;
      prevY = y;
      continue;
    }

    parts.push(penDown
      ? `L ${xToSvg(x).toFixed(2)} ${yToSvg(y).toFixed(2)}`
      : `M ${xToSvg(x).toFixed(2)} ${yToSvg(y).toFixed(2)}`);
    penDown = true;
    prevY   = y;
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function buildCirclePath(
  h: number,
  k: number,
  r: number,
  xToSvg: (x: number) => number,
  yToSvg: (y: number) => number,
  samples = 360,
): string {
  const parts: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (2 * Math.PI * i) / samples;
    const x = h + r * Math.cos(t);
    const y = k + r * Math.sin(t);
    parts.push(i === 0
      ? `M ${xToSvg(x).toFixed(2)} ${yToSvg(y).toFixed(2)}`
      : `L ${xToSvg(x).toFixed(2)} ${yToSvg(y).toFixed(2)}`);
  }
  return parts.join(" ");
}

function buildParametricPath(
  xEq: string,
  yEq: string,
  tMin: number,
  tMax: number,
  xToSvg: (x: number) => number,
  yToSvg: (y: number) => number,
  samples = 700,
): string | null {
  const xFn = compileEquation(xEq, "t");
  const yFn = compileEquation(yEq, "t");
  if (!xFn || !yFn || tMin >= tMax) return null;
  const parts: string[] = [];
  let penDown = false;
  for (let i = 0; i <= samples; i++) {
    const t = tMin + ((tMax - tMin) * i) / samples;
    const x = xFn(t);
    const y = yFn(t);
    if (x === null || y === null) {
      penDown = false;
      continue;
    }
    parts.push(penDown
      ? `L ${xToSvg(x).toFixed(2)} ${yToSvg(y).toFixed(2)}`
      : `M ${xToSvg(x).toFixed(2)} ${yToSvg(y).toFixed(2)}`);
    penDown = true;
  }
  return parts.length ? parts.join(" ") : null;
}

function buildImplicitEquationPath(
  equation: string,
  xMin: number, xMax: number,
  yMin: number, yMax: number,
  xToSvg: (x: number) => number,
  yToSvg: (y: number) => number,
  resolution = 84,
): string | null {
  const fn = compileImplicitEquation(equation);
  if (!fn) return null;
  const parts: string[] = [];
  const dx = (xMax - xMin) / resolution;
  const dy = (yMax - yMin) / resolution;

  const val = (x: number, y: number) => fn(x, y);
  const interp = (x1: number, y1: number, v1: number, x2: number, y2: number, v2: number) => {
    const t = Math.abs(v1 - v2) < 1e-12 ? 0.5 : v1 / (v1 - v2);
    return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t };
  };

  for (let ix = 0; ix < resolution; ix++) {
    const x0 = xMin + ix * dx;
    const x1 = x0 + dx;
    for (let iy = 0; iy < resolution; iy++) {
      const y0 = yMin + iy * dy;
      const y1 = y0 + dy;
      const v00 = val(x0, y0);
      const v10 = val(x1, y0);
      const v11 = val(x1, y1);
      const v01 = val(x0, y1);
      if (v00 === null || v10 === null || v11 === null || v01 === null) continue;
      const corners = [
        { x: x0, y: y0, v: v00 },
        { x: x1, y: y0, v: v10 },
        { x: x1, y: y1, v: v11 },
        { x: x0, y: y1, v: v01 },
      ];
      const edges: { x: number; y: number }[] = [];
      for (let e = 0; e < 4; e++) {
        const a = corners[e];
        const b = corners[(e + 1) % 4];
        const crosses = (a.v <= 0 && b.v >= 0) || (a.v >= 0 && b.v <= 0);
        if (crosses && a.v !== b.v) {
          edges.push(interp(a.x, a.y, a.v, b.x, b.y, b.v));
        }
      }
      if (edges.length >= 2) {
        const p = edges[0];
        const q = edges[1];
        parts.push(`M ${xToSvg(p.x).toFixed(2)} ${yToSvg(p.y).toFixed(2)} L ${xToSvg(q.x).toFixed(2)} ${yToSvg(q.y).toFixed(2)}`);
      }
    }
  }
  return parts.length ? parts.join(" ") : null;
}

// ── Client-side graphSpec validator ───────────────────────────────────────────
function isValidSpec(spec: GraphQuestionSpec): boolean {
  if (!spec) return false;
  const [xMin, xMax] = spec.xRange;
  const [yMin, yMax] = spec.yRange;
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMin >= xMax) return false;
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMin >= yMax) return false;
  if (spec.tickInterval !== undefined && (!Number.isFinite(spec.tickInterval) || spec.tickInterval <= 0)) return false;
  const hasEquation = typeof spec.equation === "string" && spec.equation.trim().length > 0;
  const hasCurves   = Array.isArray(spec.curves) && spec.curves.length > 0;
  const hasPoints   = Array.isArray(spec.points)  && spec.points.length > 0;
  const hasImplicit = !!spec.implicit;
  const hasParametric = !!spec.parametric;
  const hasPiecewise = Array.isArray(spec.piecewise) && spec.piecewise.length > 0;
  if (!hasEquation && !hasCurves && !hasPoints && !hasImplicit && !hasParametric && !hasPiecewise) return false;
  return true;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function GraphPlot({ spec }: { spec: GraphQuestionSpec }) {
  const resolvedSpec = applyGraphPreset(spec);
  // Generate unique IDs per instance so multiple graphs on the same page
  // never share clipPath or marker IDs — SVG ID conflicts cause wrong clipping
  // and missing arrowheads on all but the first graph.
  const uid        = useId().replace(/:/g, "");
  const clipId     = `plot-clip-${uid}`;
  const markerId   = `arrowhead-${uid}`;

  // Validate spec client-side before attempting to render
  if (!isValidSpec(resolvedSpec)) {
    return (
      <div
        className="rounded-2xl border border-slate-700/50 bg-slate-900/60 p-6 text-center"
        data-testid="graph-invalid"
      >
        <p className="text-slate-400 text-sm">Graph specification is invalid or incomplete.</p>
      </div>
    );
  }

  const [xMin, xMax] = resolvedSpec.xRange;
  const [yMin, yMax] = resolvedSpec.yRange;
  const axisLabels   = resolvedSpec.axisLabels ?? { x: "x", y: "y" };

  // ── Coordinate transforms using the AI's exact ranges ────────────────────
  const xToSvg = (x: number) =>
    plotLeft  + ((x - xMin) / (xMax - xMin)) * plotW;
  const yToSvg = (y: number) =>
    plotBottom - ((y - yMin) / (yMax - yMin)) * plotH;

  // Axes clamped to plot area (handles ranges that don't include 0)
  const xAxisY = Math.max(plotTop,  Math.min(plotBottom, yToSvg(0)));
  const yAxisX = Math.max(plotLeft, Math.min(plotRight,  xToSvg(0)));

  // ── Smart tick intervals (independent per axis) ───────────────────────────
  const fallbackXTick = niceInterval(xMax - xMin);
  const fallbackYTick = niceInterval(yMax - yMin);
  const safeTick = Number(resolvedSpec.tickInterval);
  const xTick = Number.isFinite(safeTick) && safeTick > 0 ? safeTick : fallbackXTick;
  const yTick = Number.isFinite(safeTick) && safeTick > 0 ? safeTick : fallbackYTick;

  const makeTicks = (lo: number, hi: number, step: number) => {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step) || step <= 0 || lo >= hi) return [];
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
  if (resolvedSpec.curves && resolvedSpec.curves.length > 0) {
    resolvedSpec.curves.forEach((c, i) => allCurves.push({
      equation: c.equation,
      label:    c.label,
      color:    c.color ?? CURVE_COLORS[i % CURVE_COLORS.length],
    }));
  } else if (resolvedSpec.equation) {
    allCurves.push({ equation: resolvedSpec.equation, color: CURVE_COLORS[0] });
  }

  const showLegend    = allCurves.length > 1 && allCurves.some((c) => c.label);
  const legendEntries = showLegend ? allCurves.filter((c) => c.label) : [];
  const plotPoints = [...(resolvedSpec.points || []), ...(resolvedSpec.highlightedPoints || [])]
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const TICK_SIZE     = 4; // half-length of tick cross-hairs (px)
  const equationA11yText = resolvedSpec.equation ? normalizeExpression(resolvedSpec.equation) : "";
  const asymptotes = {
    vertical: (resolvedSpec.asymptotes?.vertical ?? []).filter(Number.isFinite),
    horizontal: (resolvedSpec.asymptotes?.horizontal ?? []).filter(Number.isFinite),
    oblique: (resolvedSpec.asymptotes?.oblique ?? []).filter((eq): eq is string => typeof eq === "string" && eq.trim().length > 0),
  };

  // Y-tick label x-position: left of y-axis, but at least 4px inside SVG viewport
  const yLabelX = Math.max(4, yAxisX - 9);

  return (
    <div
      className="rounded-2xl border border-cyan-500/20 bg-slate-950/70 p-3 md:p-4"
      data-testid="graph-plot"
    >
      {resolvedSpec.equation && <span className="sr-only">Equation: {resolvedSpec.equation}</span>}
      {/*
        SVG sizing: `w-full` + no fixed height → browser computes height from viewBox aspect
        ratio (620:340 ≈ 1.82:1), so the graph scales proportionally on every screen size.
        A max-width wrapper caps the graph at its natural 620 px width on large monitors.
      */}
      <div className="w-full max-w-[620px] mx-auto">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full block"
        role="img"
        aria-label="Cartesian graph"
      >
        {equationA11yText && <desc>{equationA11yText}</desc>}
        <defs>
          {/*
            Unique clipPath ID per instance prevents conflicts when multiple
            GraphPlot components render on the same page.
          */}
          <clipPath id={clipId}>
            <rect x={plotLeft} y={plotTop} width={plotW} height={plotH} />
          </clipPath>

          {/*
            Unique marker ID — same reason as clipPath above.
            orient="auto" rotates to match line direction:
              X axis (→ rightward)  →  0°
              Y axis (↑ upward, y2 < y1 in SVG coords) → −90°
          */}
          <marker
            id={markerId}
            markerWidth="8" markerHeight="8"
            refX="8" refY="4"
            orient="auto"
          >
            <path d="M0,1 L8,4 L0,7 z" fill="rgba(226,232,240,0.60)" />
          </marker>
        </defs>

        {/* ── Grid lines ────────────────────────────────────────────────── */}
        <g clipPath={`url(#${clipId})`}>
          {resolvedSpec.showGrid && xTicks.map((x) => (
            <line key={`vg-${x}`}
              x1={xToSvg(x)} x2={xToSvg(x)} y1={plotTop} y2={plotBottom}
              stroke="rgba(148,163,184,0.10)" strokeWidth="1"
            />
          ))}
          {resolvedSpec.showGrid && yTicks.map((y) => (
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
          markerEnd={`url(#${markerId})`}
        />

        {/* ── Y axis ↑ (drawn bottom→top so marker-end points up) ─────── */}
        <line
          x1={yAxisX} x2={yAxisX}
          y1={plotBottom} y2={plotTop - 5}
          stroke="rgba(226,232,240,0.55)" strokeWidth="1.5"
          markerEnd={`url(#${markerId})`}
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
          // Skip origin label when both axes are visible (avoid "0" at intersection)
          const skipOrigin = x === 0 && yMin < 0 && yMax > 0 && xMin < 0 && xMax > 0;
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
          const skipOrigin = y === 0 && xMin < 0 && xMax > 0 && yMin < 0 && yMax > 0;
          return !skipOrigin ? (
            <text key={`yl-${y}`}
              x={yLabelX} y={sy + 4}
              textAnchor="end" fill="#94a3b8" fontSize="11"
            >
              {y}
            </text>
          ) : null;
        })}

        {/* ── Axis name labels ──────────────────────────────────────────── */}
        {/* X label: anchored at right SVG edge, grows leftward → never clips  */}
        <text
          x={WIDTH - 4} y={xAxisY + 4}
          textAnchor="end" fill="#cbd5e1"
          fontSize="12" fontWeight="600" fontStyle="italic"
        >
          {axisLabels.x}
        </text>
        {/* Y label: just above the arrowhead, anchored to left of axis line   */}
        <text
          x={yAxisX + 6} y={plotTop - 10}
          textAnchor="start" fill="#cbd5e1"
          fontSize="12" fontWeight="600" fontStyle="italic"
        >
          {axisLabels.y}
        </text>

        {/* ── Curves, clipped to plot area ──────────────────────────────── */}
        <g clipPath={`url(#${clipId})`}>
          {asymptotes.vertical.map((x, i) => (
            <line
              key={`asym-v-${x}-${i}`}
              x1={xToSvg(x)} x2={xToSvg(x)}
              y1={plotTop} y2={plotBottom}
              stroke="rgba(248,113,113,0.75)"
              strokeDasharray="7 5"
              strokeWidth="1.2"
            />
          ))}
          {asymptotes.horizontal.map((y, i) => (
            <line
              key={`asym-h-${y}-${i}`}
              x1={plotLeft} x2={plotRight}
              y1={yToSvg(y)} y2={yToSvg(y)}
              stroke="rgba(248,113,113,0.75)"
              strokeDasharray="7 5"
              strokeWidth="1.2"
            />
          ))}
          {asymptotes.oblique.map((eq, i) => {
            const d = buildCurvePath(eq, xMin, xMax, yMin, yMax, xToSvg, yToSvg);
            return d ? (
              <path
                key={`asym-o-${i}`}
                d={d}
                fill="none"
                stroke="rgba(248,113,113,0.75)"
                strokeDasharray="7 5"
                strokeWidth="1.2"
              />
            ) : null;
          })}

          {allCurves.map((c, i) => {
            const d = buildCurvePath(c.equation, xMin, xMax, yMin, yMax, xToSvg, yToSvg);
            return d ? (
              <path key={`curve-${i}`}
                d={d} fill="none"
                stroke={c.color} strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round"
              />
            ) : null;
          })}

          {Array.isArray(resolvedSpec.piecewise) && resolvedSpec.piecewise.map((seg, i) => {
            const segMin = Math.max(xMin, seg.domain[0]);
            const segMax = Math.min(xMax, seg.domain[1]);
            if (!(segMin < segMax)) return null;
            const d = buildCurvePath(seg.equation, segMin, segMax, yMin, yMax, xToSvg, yToSvg, 260);
            return d ? (
              <path
                key={`piecewise-${i}`}
                d={d}
                fill="none"
                stroke={CURVE_COLORS[i % CURVE_COLORS.length]}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null;
          })}

          {resolvedSpec.implicit?.type === "circle" && (
            <path
              d={buildCirclePath(resolvedSpec.implicit.h, resolvedSpec.implicit.k, resolvedSpec.implicit.r, xToSvg, yToSvg)}
              fill="none"
              stroke={CURVE_COLORS[0]}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {resolvedSpec.implicit?.type === "equation" && (() => {
            const d = buildImplicitEquationPath(resolvedSpec.implicit.equation, xMin, xMax, yMin, yMax, xToSvg, yToSvg);
            return d ? (
              <path
                d={d}
                fill="none"
                stroke={CURVE_COLORS[0]}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null;
          })()}

          {resolvedSpec.parametric && (() => {
            const d = buildParametricPath(
              resolvedSpec.parametric.xEquation,
              resolvedSpec.parametric.yEquation,
              resolvedSpec.parametric.tRange[0],
              resolvedSpec.parametric.tRange[1],
              xToSvg,
              yToSvg,
            );
            return d ? (
              <path
                d={d}
                fill="none"
                stroke={CURVE_COLORS[1]}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null;
          })()}

          {plotPoints.map((p, i) => (
            <g key={`pt-${p.x}-${p.y}-${i}`}>
              <circle
                cx={xToSvg(p.x)} cy={yToSvg(p.y)} r="4.5"
                fill="#a78bfa" stroke="#1e1b4b" strokeWidth="1.2"
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

        {/* ── Single-curve equation label — italic, upper-right ─────────── */}
        {(() => {
          const isSingleCurve = allCurves.length === 1 && !!resolvedSpec.equation && !resolvedSpec.curves?.length;
          if (!isSingleCurve) return null;
          const labelText = equationDisplayLabel(resolvedSpec);
          if (!labelText) return null;
          return (
            <text
              x={plotRight - 6}
              y={plotTop + 18}
              textAnchor="end"
              fill={CURVE_COLORS[0]}
              fontSize="12"
              fontStyle="italic"
              fontWeight="500"
              opacity="0.90"
            >
              {labelText}
            </text>
          );
        })()}

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
              <span className="text-xs text-slate-300 italic whitespace-nowrap">{c.label}</span>
            </div>
          ))}
        </div>
      )}
      </div>{/* end max-w-[620px] wrapper */}
    </div>
  );
}

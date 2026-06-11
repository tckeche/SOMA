import { create, all } from "mathjs";

const math = create(all, {});

export interface MathValidationResult {
  verifiable: boolean;
  pattern?: string;
  computedAnswer?: number | number[] | string;
  matchedOption?: string;
  storedCorrectMatches?: boolean;
  mismatch?: boolean;
  workedSolution?: string;
}

const NUM_TOL = 1e-6;

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) < Math.max(NUM_TOL, Math.abs(b) * 1e-4);
}

function stripLatexAndUnicode(input: string): string {
  return input
    .replace(/\\\(|\\\)|\\\[|\\\]/g, "")
    .replace(/\$\$/g, "")
    .replace(/\$/g, "")
    .replace(/\\,|\\;|\\:|\\!|\\quad|\\qquad/g, " ")
    .replace(/\\left|\\right/g, "")
    .replace(/\\cdot|\\times/g, "*")
    .replace(/\\div/g, "/")
    .replace(/\\pi/g, "pi")
    .replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "(($1)/($2))")
    .replace(/\\sqrt\s*\{([^{}]+)\}/g, "sqrt(($1))")
    .replace(/\\sqrt\s*([0-9.]+)/g, "sqrt($1)")
    .replace(/\^\s*\{([^{}]+)\}/g, "^($1)")
    .replace(/_\s*\{[^{}]+\}/g, "")
    .replace(/[{}]/g, "")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/⁴/g, "^4")
    .replace(/⁵/g, "^5")
    .replace(/−|–|—/g, "-")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/≈|≃/g, "=")
    .replace(/\s+/g, " ")
    .trim();
}

function insertImplicitMultiplication(expr: string, variable = "x"): string {
  let s = expr;
  // number followed by variable / open paren
  s = s.replace(/(\d)\s*([a-zA-Z(])/g, "$1*$2");
  // closing paren followed by variable / number / open paren
  s = s.replace(/\)\s*([a-zA-Z0-9(])/g, ")*$1");
  // single variable followed by open paren  (e.g. x(2) → x*(2))
  s = s.replace(new RegExp(`\\b${variable}\\s*\\(`, "g"), `${variable}*(`);
  // collapse accidental "**" → "*"
  s = s.replace(/\*\*+/g, "*");
  return s;
}

function safeEvaluate(expr: string, scope: Record<string, number> = {}): number | null {
  try {
    const v = math.evaluate(expr, scope);
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v && typeof (v as any).toNumber === "function") {
      const n = (v as any).toNumber();
      return Number.isFinite(n) ? n : null;
    }
    return null;
  } catch {
    return null;
  }
}

function parseOptionAsNumber(opt: string): number | null {
  let cleaned = stripLatexAndUnicode(opt)
    .replace(/^[A-D]\s*[\.\):]\s*/i, "") // strip leading "A) ", "B." etc
    .replace(/^[a-z]\s*=\s*/i, "")        // strip leading "x = " / "y = "
    .replace(/,(?=\d{3}\b)/g, "")         // thousands separator
    .replace(/[a-zA-Z°%]/g, "")           // strip residual units
    .trim();
  if (!cleaned) return null;
  const direct = Number(cleaned);
  if (Number.isFinite(direct)) return direct;
  const expr = safeEvaluate(cleaned);
  if (expr !== null) return expr;
  return null;
}

// Parse multi-value options like "x = 2 or x = 3", "{1, 4}", "2 and 5" into a set of numbers.
function parseOptionAsNumberSet(opt: string): number[] {
  const cleaned = stripLatexAndUnicode(opt)
    .replace(/^[A-D]\s*[\.\):]\s*/i, "")
    .replace(/[{}\[\]]/g, " ")
    .replace(/\b(?:or|and|x|y|z|t|n)\s*=?\s*/gi, " ")
    .replace(/[°%]/g, "")
    .replace(/,(?=\d{3}\b)/g, "");
  const tokens = cleaned.match(/-?\d+(?:\.\d+)?(?:\/\d+)?/g) ?? [];
  const nums: number[] = [];
  for (const t of tokens) {
    const n = t.includes("/") ? safeEvaluate(t) : Number(t);
    if (n !== null && Number.isFinite(n)) nums.push(n);
  }
  return nums;
}

function findMatchingOption(options: string[], computed: number | number[]): { idx: number; value: number } | null {
  const candidates = Array.isArray(computed) ? computed : [computed];
  // Multi-root case: require set equality between the computed candidates and the option's parsed numbers.
  if (candidates.length >= 2) {
    for (let i = 0; i < options.length; i++) {
      const set = parseOptionAsNumberSet(options[i]);
      if (set.length !== candidates.length) continue;
      const used = new Array(set.length).fill(false);
      let allMatched = true;
      for (const c of candidates) {
        const idx = set.findIndex((s, k) => !used[k] && approxEq(s, c));
        if (idx === -1) { allMatched = false; break; }
        used[idx] = true;
      }
      if (allMatched) return { idx: i, value: candidates[0] };
    }
    return null;
  }
  // Single-value case: option must be (or evaluate to) exactly that number.
  for (let i = 0; i < options.length; i++) {
    const n = parseOptionAsNumber(options[i]);
    if (n === null) continue;
    if (approxEq(n, candidates[0])) return { idx: i, value: candidates[0] };
  }
  return null;
}

type Attempt = { computed: number | number[]; worked: string; pattern: string } | null;

// ─── Pattern 1: function evaluation  f(x) = expr ; find f(c) ─────────
function tryFunctionEval(stem: string): Attempt {
  const cleaned = stripLatexAndUnicode(stem);
  const defRe = /([fghpqr])\s*\(\s*([a-zA-Z])\s*\)\s*=\s*([^,;.]+?)(?=[,;.]|\s+(?:find|evaluate|compute|determine|calculate|what)\b|$)/i;
  const def = cleaned.match(defRe);
  if (!def) return null;
  const fn = def[1], variable = def[2], body = def[3].trim();
  const callRe = new RegExp(`${fn}\\s*\\(\\s*(-?\\d+(?:\\.\\d+)?)\\s*\\)`, "i");
  const tail = cleaned.slice((def.index ?? 0) + def[0].length);
  const call = tail.match(callRe);
  if (!call) return null;
  const x = Number(call[1]);
  if (!Number.isFinite(x)) return null;
  const computed = safeEvaluate(insertImplicitMultiplication(body, variable), { [variable]: x });
  if (computed === null) return null;
  const sub = body.replace(new RegExp(`(?<![a-zA-Z])${variable}(?![a-zA-Z])`, "g"), `(${x})`);
  return { computed, worked: `**Worked solution:** $${fn}(${x}) = ${sub} = ${computed}$`, pattern: "function_eval" };
}

// ─── Pattern 2: substitution  "If x = 3, find 2x + 5" ────────────────
function trySubstitution(stem: string): Attempt {
  const cleaned = stripLatexAndUnicode(stem);
  const m = cleaned.match(/(?:if|when|given\s+(?:that\s+)?)\s*([a-z])\s*=\s*(-?\d+(?:\.\d+)?)\s*[,.;]\s*(?:find|evaluate|calculate|determine|what\s+is(?:\s+the\s+value\s+of)?)\s+([^?\.]+)/i);
  if (!m) return null;
  const variable = m[1].toLowerCase();
  const value = Number(m[2]);
  if (!Number.isFinite(value)) return null;
  const expr = m[3].trim().replace(/^the\s+value\s+of\s+/i, "");
  const computed = safeEvaluate(insertImplicitMultiplication(expr, variable), { [variable]: value });
  if (computed === null) return null;
  const sub = expr.replace(new RegExp(`(?<![a-zA-Z])${variable}(?![a-zA-Z])`, "g"), `(${value})`);
  return { computed, worked: `**Worked solution:** Substituting $${variable} = ${value}$ gives $${sub} = ${computed}$.`, pattern: "substitution" };
}

// ─── Pattern 3: solve linear / quadratic equation ────────────────────
function trySolveEquation(stem: string): Attempt {
  const cleaned = stripLatexAndUnicode(stem);
  if (!/=/.test(cleaned)) return null;
  if (!/\bsolve\b|\bfind\b|\broots?\s+of\b|\bvalue[s]?\s+of\b/i.test(cleaned)) return null;

  // Try common math variables — pick whichever appears in the text
  const tryVars = ["x", "y", "z", "t", "n", "p", "q", "a", "b"].filter((v) =>
    new RegExp(`\\b${v}\\b`, "i").test(cleaned),
  );
  if (tryVars.length === 0) tryVars.push("x");

  for (const variable of tryVars) {
    // Pull the equation: maximal run of math chars on each side of '=' that contain
    // only digits, ops, parens, spaces, ^ and the chosen variable letter.
    const charClass = `[\\-+*/().\\d\\s^${variable}]`;
    const re = new RegExp(`(${charClass}+?)\\s*=\\s*(${charClass}+?)(?=[^${variable}\\-+*/().\\d\\s^]|$)`, "i");
    const m = cleaned.match(re);
    if (!m) continue;
    const lhs = m[1].trim();
    const rhs = m[2].trim();
    if (!lhs || !rhs) continue;
    // Need the variable somewhere — `\b` fails on digit-letter (e.g. "2x"), so use a manual boundary.
    const varRe = new RegExp(`(?<![a-zA-Z])${variable}(?![a-zA-Z])`, "i");
    if (!varRe.test(lhs) && !varRe.test(rhs)) continue;

    try {
      const lhsExpr = insertImplicitMultiplication(lhs, variable);
      const rhsExpr = insertImplicitMultiplication(rhs, variable);
      const node = math.parse(`(${lhsExpr}) - (${rhsExpr})`);
      const rat: any = math.rationalize(node, {}, true);
      const coeffs: any[] = rat?.coefficients ?? [];
      const nums = coeffs.map((c) => Number(c)).filter((n) => Number.isFinite(n));
      if (nums.length !== coeffs.length || nums.length < 2 || nums.length > 3) continue;

      if (nums.length === 2) {
        const [b, a] = nums;
        if (a === 0) continue;
        const sol = -b / a;
        return {
          computed: sol,
          worked: `**Worked solution:** $${lhs} = ${rhs}$ ⇒ $${variable} = ${sol}$.`,
          pattern: "linear_equation",
        };
      }
      const [c, b, a] = nums;
      if (a === 0) continue;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const r1 = (-b + Math.sqrt(disc)) / (2 * a);
      const r2 = (-b - Math.sqrt(disc)) / (2 * a);
      const roots = approxEq(r1, r2) ? [r1] : [r1, r2];
      return {
        computed: roots,
        worked: `**Worked solution:** $${lhs} = ${rhs}$ ⇒ $${variable} = ${roots.join(" \\text{ or } ")}$.`,
        pattern: "quadratic_equation",
      };
    } catch {
      continue;
    }
  }
  return null;
}

// ─── Pattern 4: derivative (with eval point) ─────────────────────────
function tryDerivative(stem: string): Attempt {
  const cleaned = stripLatexAndUnicode(stem);
  if (!/\b(differentiate|derivative|dy\/dx|gradient|slope)\b/i.test(cleaned)) return null;

  const variable = (cleaned.match(/d([a-z])\/d([a-z])/i)?.[2] || "x").toLowerCase();
  // Look for an eval point — required for numeric matching
  const atMatch = cleaned.match(/\bat\s+[a-z]?\s*=?\s*(-?\d+(?:\.\d+)?)/i);
  if (!atMatch) return null;
  const evalAt = Number(atMatch[1]);
  if (!Number.isFinite(evalAt)) return null;

  // Extract the expression: largest run of math chars between the verb and "at"
  const cls = `[\\-+*/().\\d\\s^${variable}]`;
  const re = new RegExp(`(?:differentiate|derivative\\s+of|dy\\/dx\\s+of|gradient\\s+of|slope\\s+of)\\s+(${cls}+)`, "i");
  const exprMatch = cleaned.match(re);
  if (!exprMatch) return null;
  const exprBody = exprMatch[1].trim();
  // Use manual non-letter boundary so "2x"-style terms aren't missed (\\b fails between digit and letter).
  if (!new RegExp(`(?<![a-zA-Z])${variable}(?![a-zA-Z])`).test(exprBody)) return null;

  try {
    const exprWithMul = insertImplicitMultiplication(exprBody, variable);
    const deriv = math.derivative(exprWithMul, variable);
    const derivStr = deriv.toString();
    const val = safeEvaluate(derivStr, { [variable]: evalAt });
    if (val === null) return null;
    return {
      computed: val,
      worked: `**Worked solution:** $\\frac{d}{d${variable}}(${exprBody}) = ${derivStr}$, then at $${variable}=${evalAt}$: $${val}$.`,
      pattern: "derivative",
    };
  } catch {
    return null;
  }
}

// ─── Pattern 5: percentage  "What is 20% of 50" ──────────────────────
function tryPercentage(stem: string): Attempt {
  const cleaned = stripLatexAndUnicode(stem);
  const m = cleaned.match(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const pct = Number(m[1]), base = Number(m[2]);
  const computed = (pct / 100) * base;
  return { computed, worked: `**Worked solution:** $${pct}\\% \\times ${base} = ${computed}$.`, pattern: "percentage" };
}

// ─── Pattern 6: statistics  mean / median / mode / range / sum ───────
function tryStatistics(stem: string): Attempt {
  const cleaned = stripLatexAndUnicode(stem);
  const opMatch = cleaned.match(/\b(arithmetic\s+mean|mean|average|median|mode|range|sum|total)\b/i);
  if (!opMatch) return null;
  const op = opMatch[1].toLowerCase().replace(/^arithmetic\s+/, "");
  // Pull a list of numbers; require ≥3 to avoid grabbing question numbers / years
  const nums = (cleaned.match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length < 3) return null;
  let computed: number | null = null;
  switch (op) {
    case "mean": case "average":
      computed = nums.reduce((s, n) => s + n, 0) / nums.length; break;
    case "sum": case "total":
      computed = nums.reduce((s, n) => s + n, 0); break;
    case "range":
      computed = Math.max(...nums) - Math.min(...nums); break;
    case "median": {
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      computed = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      break;
    }
    case "mode": {
      const freq = new Map<number, number>();
      for (const n of nums) freq.set(n, (freq.get(n) || 0) + 1);
      const max = Math.max(...Array.from(freq.values()));
      const modes = Array.from(freq.entries()).filter(([_, c]) => c === max).map(([n]) => n);
      if (modes.length === 1) computed = modes[0];
      break;
    }
  }
  if (computed === null || !Number.isFinite(computed)) return null;
  return { computed, worked: `**Worked solution:** ${op} of {${nums.join(", ")}} = $${computed}$.`, pattern: `statistics_${op}` };
}

// ─── Pattern 7: direct arithmetic with a verb cue ────────────────────
function tryArithmeticVerb(stem: string): Attempt {
  const cleaned = stripLatexAndUnicode(stem);
  const m = cleaned.match(/(?:what\s+is|calculate|compute|evaluate|find\s+the\s+value\s+of|simplify)\s*[:\s]\s*([\-+*/().\d\s^]+?)\s*[\?\.]?\s*$/i);
  if (!m) return null;
  const expr = m[1].trim();
  if (!/[+\-*/^]/.test(expr)) return null;
  const computed = safeEvaluate(expr);
  if (computed === null) return null;
  return { computed, worked: `**Worked solution:** $${expr.replace(/\s+/g, " ")} = ${computed}$.`, pattern: "arithmetic" };
}

// ─── Pattern 8: bare arithmetic expression  "8 - 6 + 1 = ?" ──────────
function tryRawExpression(stem: string): Attempt {
  let cleaned = stripLatexAndUnicode(stem)
    .replace(/=\s*\?/g, "")
    .replace(/[\?\.]+\s*$/, "")
    .trim();
  if (!/^[\-+*/().\d\s^]+$/.test(cleaned)) return null;
  if (!/[+\-*/^]/.test(cleaned)) return null;
  const computed = safeEvaluate(cleaned);
  if (computed === null) return null;
  return { computed, worked: `**Worked solution:** $${cleaned} = ${computed}$.`, pattern: "raw_arithmetic" };
}

const ATTEMPTS: Array<(s: string) => Attempt> = [
  tryFunctionEval,
  trySubstitution,
  // Derivative must come before equation: derivative stems like "... at x = 2"
  // contain an `=` that would otherwise be eaten by trySolveEquation.
  tryDerivative,
  trySolveEquation,
  tryPercentage,
  tryStatistics,
  tryArithmeticVerb,
  tryRawExpression,
];

// ─── Complex-number support ──────────────────────────────────────────────
//
// Real-number parsing strips the imaginary unit (e.g. "0 + 8i" → "0 + 8" → 8),
// so complex questions MUST be handled on a dedicated path or they get silently
// mis-graded. We evaluate with mathjs' native complex arithmetic and match
// options as complex numbers (real and imaginary parts compared independently).

interface Cplx {
  re: number;
  im: number;
}

/** Detect a standalone imaginary unit `i` (not part of a word like "is"/"find"). */
function hasImaginaryUnit(s: string): boolean {
  return /(?<![a-zA-Z])i(?![a-zA-Z])/.test(stripLatexAndUnicode(s));
}

/** A question is "complex" if its stem or ≥2 of its options use the imaginary unit. */
function looksComplex(stem: string, options: string[]): boolean {
  if (hasImaginaryUnit(stem)) return true;
  return options.filter(hasImaginaryUnit).length >= 2;
}

function toComplex(v: any): Cplx | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? { re: v, im: 0 } : null;
  if (typeof v === "object") {
    if (typeof v.re === "number" && typeof v.im === "number") {
      return Number.isFinite(v.re) && Number.isFinite(v.im) ? { re: v.re, im: v.im } : null;
    }
    if (typeof v.toNumber === "function") {
      const n = v.toNumber();
      return Number.isFinite(n) ? { re: n, im: 0 } : null;
    }
  }
  return null;
}

function safeEvaluateComplex(expr: string, scope: Record<string, any> = {}): Cplx | null {
  try {
    return toComplex(math.evaluate(expr, scope));
  } catch {
    return null;
  }
}

function complexEq(a: Cplx, b: Cplx): boolean {
  return approxEq(a.re, b.re) && approxEq(a.im, b.im);
}

function roundish(n: number): number {
  const r = Math.round(n);
  return Math.abs(n - r) < 1e-9 ? r : Number(n.toFixed(6));
}

function fmtComplex(c: Cplx): string {
  const re = roundish(c.re);
  const im = roundish(c.im);
  if (im === 0) return `${re}`;
  if (re === 0) return `${im}i`;
  return `${re} ${im < 0 ? "-" : "+"} ${Math.abs(im)}i`;
}

/** Parse an option / answer string into a complex number, keeping the imaginary unit. */
function parseComplexValue(input: string): Cplx | null {
  let cleaned = stripLatexAndUnicode(input)
    .replace(/^[A-D]\s*[\.\):]\s*/i, "") // strip leading "A) ", "B." etc
    .replace(/^[a-z]\s*=\s*/i, "")        // strip leading "z = " / "w = "
    .replace(/,(?=\d{3}\b)/g, "")         // thousands separator
    .trim();
  if (!cleaned) return null;
  cleaned = insertImplicitMultiplication(cleaned, "i"); // "8i" → "8*i"
  return safeEvaluateComplex(cleaned);
}

// ─── Complex pattern: "If z = 2 + 2i, find z²" ───────────────────────────
function findMatchingComplexOption(options: string[], computed: Cplx): number | null {
  for (let i = 0; i < options.length; i++) {
    const c = parseComplexValue(options[i]);
    if (c && complexEq(c, computed)) return i;
  }
  return null;
}

function validateComplexQuestion(
  stem: string,
  options: string[],
  storedCorrectAnswer: string,
): MathValidationResult {
  const cleaned = stripLatexAndUnicode(stem);
  const def = cleaned.match(/\b([zw])\s*=\s*([^,;.?]+)/i);
  if (!def) return { verifiable: false };
  const variable = def[1].toLowerCase();
  const zVal = parseComplexValue(def[2]);
  if (!zVal) return { verifiable: false };

  const tail = cleaned.slice((def.index ?? 0) + def[0].length);
  const exprMatch = tail.match(
    /(?:find|calculate|evaluate|compute|determine|express|what\s+is(?:\s+the\s+value\s+of)?)\s+([^?.]+)/i,
  );
  if (!exprMatch) return { verifiable: false };
  let body = exprMatch[1]
    .trim()
    .replace(/^the\s+value\s+of\s+/i, "")
    .replace(/\bconjugate\s+of\s+([zw])\b/i, "conj($1)")
    .replace(/\bmodulus\s+of\s+([zw])\b/i, "abs($1)")
    .replace(/\|\s*([zw])\s*\|/i, "abs($1)")
    .replace(/\bargument\s+of\s+([zw])\b/i, "arg($1)")
    .replace(/\b([zw])\s+squared\b/i, "$1^2")
    .replace(/\b([zw])\s+cubed\b/i, "$1^3")
    .replace(/^the\s+/i, "")
    .replace(/[?.]+\s*$/, "")
    .trim();
  if (!body) return { verifiable: false };
  if (!new RegExp(`(?<![a-zA-Z])${variable}(?![a-zA-Z])`, "i").test(body)) {
    return { verifiable: false };
  }

  const computed = safeEvaluateComplex(
    insertImplicitMultiplication(body, variable),
    { [variable]: math.complex(zVal.re, zVal.im) },
  );
  if (!computed) return { verifiable: false };

  const idx = findMatchingComplexOption(options, computed);
  if (idx === null) return { verifiable: false };

  const matchedOption = options[idx];
  const storedC = parseComplexValue(storedCorrectAnswer);
  const storedCorrectMatches = storedC !== null && complexEq(storedC, computed);

  return {
    verifiable: true,
    pattern: "complex_arithmetic",
    computedAnswer: fmtComplex(computed),
    matchedOption,
    storedCorrectMatches,
    mismatch: !storedCorrectMatches,
    workedSolution: `**Worked solution:** with $${variable} = ${fmtComplex(zVal)}$, $${body} = ${fmtComplex(computed)}$.`,
  };
}

/** Pull every complex/real numeric token out of free text (for explanation checks). */
function extractComplexTokens(text: string): Cplx[] {
  const cleaned = stripLatexAndUnicode(text);
  const re =
    /-?\s*\d+(?:\.\d+)?\s*[+\-]\s*\d+(?:\.\d+)?\s*i|-?\s*\d+(?:\.\d+)?\s*i|(?<![\d.])-?\d+(?:\.\d+)?(?![\d.])/g;
  const out: Cplx[] = [];
  for (const m of cleaned.match(re) ?? []) {
    const c = parseComplexValue(m);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Pull real-number tokens out of free text, evaluating simple fractions so that
 * "1/2" is read as 0.5 (not as the two integers 1 and 2). Used by the numeric
 * branch of the explanation check to avoid false contradictions on equivalent
 * forms.
 */
function extractNumberTokens(text: string): number[] {
  const cleaned = stripLatexAndUnicode(text);
  const re = /-?\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;
  const out: number[] = [];
  for (const m of cleaned.match(re) ?? []) {
    const v = m.includes("/") ? safeEvaluate(m.replace(/\s+/g, "")) : Number(m);
    if (v !== null && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * Requirement: the explanation's stated answer must agree with the marked
 * correct option. We flag a mismatch ONLY when the expected value never appears
 * anywhere in a worked (numeric) explanation — a strong contradiction signal —
 * so verbal explanations and harmless phrasing differences are never blocked.
 *
 * `complex` is returned so callers can hard-block the high-confidence complex
 * case while treating the looser numeric case as a review warning only.
 */
export function explanationFinalAnswerMismatch(
  stem: string,
  options: string[],
  correctAnswer: string,
  explanation: string,
): { mismatch: boolean; complex: boolean; expected?: string } {
  if (!explanation || !explanation.trim()) return { mismatch: false, complex: false };

  if (looksComplex(stem, options) || hasImaginaryUnit(correctAnswer)) {
    const expected = parseComplexValue(correctAnswer);
    if (!expected) return { mismatch: false, complex: true };
    const tokens = extractComplexTokens(explanation);
    if (tokens.length === 0) return { mismatch: false, complex: true }; // verbal — can't judge
    const present = tokens.some((t) => complexEq(t, expected));
    return present
      ? { mismatch: false, complex: true }
      : { mismatch: true, complex: true, expected: fmtComplex(expected) };
  }

  const expectedNum = parseOptionAsNumber(correctAnswer);
  if (expectedNum === null) return { mismatch: false, complex: false };
  const nums = extractNumberTokens(explanation);
  if (nums.length === 0) return { mismatch: false, complex: false };
  const present = nums.some((n) => approxEq(n, expectedNum));
  return present
    ? { mismatch: false, complex: false }
    : { mismatch: true, complex: false, expected: String(roundish(expectedNum)) };
}

/**
 * Attempt deterministic verification of an MCQ math question.
 * Returns verifiable=false when the question doesn't fit a recognised pattern
 * or the options aren't numeric — leaving the AI's answer unchanged.
 */
export function validateMathQuestion(
  stem: string,
  options: string[],
  storedCorrectAnswer: string,
): MathValidationResult {
  if (!Array.isArray(options) || options.length < 2) return { verifiable: false };

  // Complex-number questions take a dedicated path: the real-number parser
  // strips the imaginary unit and would otherwise silently mis-grade them.
  if (looksComplex(stem, options)) {
    return validateComplexQuestion(stem, options, storedCorrectAnswer);
  }
  // An option is "numeric-shaped" if it parses as a single number OR contains numeric tokens
  // (e.g. "x = 2 or x = 3", "{1, 6}"). Require most options to be numeric-shaped.
  const numericOptionCount = options.filter(
    (o) => parseOptionAsNumber(o) !== null || parseOptionAsNumberSet(o).length > 0,
  ).length;
  if (numericOptionCount < Math.max(2, options.length - 1)) return { verifiable: false };

  let attempt: Attempt = null;
  for (const fn of ATTEMPTS) {
    attempt = fn(stem);
    if (attempt) break;
  }
  if (!attempt) return { verifiable: false };

  const match = findMatchingOption(options, attempt.computed);
  if (!match) return { verifiable: false };

  const matchedOption = options[match.idx];
  const storedNum = parseOptionAsNumber(storedCorrectAnswer);
  const candidates = Array.isArray(attempt.computed) ? attempt.computed : [attempt.computed];
  const storedCorrectMatches = storedNum !== null && candidates.some((c) => approxEq(storedNum, c));

  return {
    verifiable: true,
    pattern: attempt.pattern,
    computedAnswer: attempt.computed,
    matchedOption,
    storedCorrectMatches,
    mismatch: !storedCorrectMatches,
    workedSolution: attempt.worked,
  };
}

/**
 * Returns the deterministically-correct answer if verifiable, else the stored answer.
 * Use at grading time so legacy bad questions don't penalise students.
 */
export function effectiveCorrectAnswer(
  stem: string,
  options: string[],
  storedCorrectAnswer: string,
): string {
  const r = validateMathQuestion(stem, options, storedCorrectAnswer);
  if (r.verifiable && r.matchedOption) return r.matchedOption;
  return storedCorrectAnswer;
}

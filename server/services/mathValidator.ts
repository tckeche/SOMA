import { create, all } from "mathjs";

const math = create(all, {});

export interface MathValidationResult {
  verifiable: boolean;
  pattern?: "function_eval" | "arithmetic" | "expression";
  computedAnswer?: number;
  matchedOption?: string;
  storedCorrectMatches?: boolean;
  mismatch?: boolean;
  workedSolution?: string;
}

const NUM_TOL = 1e-6;

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
    .trim();
}

function insertImplicitMultiplication(expr: string, variable: string): string {
  // 2x -> 2*x ; )x -> )*x ; x( -> x*( ; 2( -> 2*( ; )( -> )*(
  let s = expr;
  const v = variable;
  // number followed by variable
  s = s.replace(new RegExp(`(\\d)\\s*${v}`, "g"), `$1*${v}`);
  // variable followed by number  (rare, but x2 -> x*2 only when not part of identifier — safer to skip)
  // closing paren followed by variable or number or open paren
  s = s.replace(/\)\s*([a-zA-Z0-9(])/g, ")*$1");
  // number or variable followed by open paren
  s = s.replace(/(\d)\s*\(/g, "$1*(");
  s = s.replace(new RegExp(`${v}\\s*\\(`, "g"), `${v}*(`);
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
  const cleaned = stripLatexAndUnicode(opt)
    .replace(/^[A-D]\s*[\.\):]\s*/i, "") // strip leading "A) " etc
    .replace(/[a-zA-Z°%]/g, "") // strip units / letters
    .replace(/,(?=\d{3}\b)/g, "") // strip thousands separators
    .trim();
  if (!cleaned) return null;
  const direct = Number(cleaned);
  if (Number.isFinite(direct)) return direct;
  // Try as a math expression (e.g. "3/4", "2^3")
  return safeEvaluate(cleaned);
}

function findMatchingOptionIndex(options: string[], computed: number): number {
  for (let i = 0; i < options.length; i++) {
    const n = parseOptionAsNumber(options[i]);
    if (n !== null && Math.abs(n - computed) < Math.max(NUM_TOL, Math.abs(computed) * 1e-4)) {
      return i;
    }
  }
  return -1;
}

function tryFunctionEval(stem: string): { computed: number; worked: string } | null {
  const cleaned = stripLatexAndUnicode(stem);
  // Match patterns like:  f(x) = 2x^2 - 3x + 1 ... find f(2)  /  evaluate g(t) ... at t = 5
  const defRe = /([fghpqr])\s*\(\s*([a-zA-Z])\s*\)\s*=\s*([^,;.]+?)(?=[,;.]|\s+(?:find|evaluate|compute|determine|calculate|what)\b)/i;
  const defMatch = cleaned.match(defRe);
  if (!defMatch) return null;
  const fnName = defMatch[1];
  const variable = defMatch[2];
  const body = defMatch[3].trim();

  const callRe = new RegExp(`${fnName}\\s*\\(\\s*(-?\\d+(?:\\.\\d+)?)\\s*\\)`, "i");
  // Look for a call AFTER the definition
  const tail = cleaned.slice((defMatch.index ?? 0) + defMatch[0].length);
  const callMatch = tail.match(callRe);
  if (!callMatch) return null;
  const x = Number(callMatch[1]);
  if (!Number.isFinite(x)) return null;

  const exprWithMul = insertImplicitMultiplication(body, variable);
  const computed = safeEvaluate(exprWithMul, { [variable]: x });
  if (computed === null) return null;

  const substituted = body.replace(new RegExp(`(?<![a-zA-Z])${variable}(?![a-zA-Z])`, "g"), `(${x})`);
  const worked = `**Worked solution:** $${fnName}(${x}) = ${substituted} = ${computed}$`;
  return { computed, worked };
}

function tryDirectArithmetic(stem: string): { computed: number; worked: string } | null {
  const cleaned = stripLatexAndUnicode(stem);
  // "What is 8 - 6 + 1?" / "Calculate 2 * (3 + 4)" / "Evaluate 12 / 4 + 1"
  const re = /(?:what\s+is|calculate|compute|evaluate|find\s+the\s+value\s+of|simplify)\s*[:\s]\s*([\-+*/().\d\s^]+?)\s*[\?\.]?\s*$/i;
  const m = cleaned.match(re);
  if (!m) return null;
  const expr = m[1].trim();
  // Must contain an operator — otherwise it's just a number, not a calculation
  if (!/[+\-*/^]/.test(expr)) return null;
  const computed = safeEvaluate(expr);
  if (computed === null) return null;
  return { computed, worked: `**Worked solution:** $${expr.replace(/\s+/g, " ")} = ${computed}$` };
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
  const numericOptionCount = options.filter((o) => parseOptionAsNumber(o) !== null).length;
  // Need at least 3/4 numeric options to consider this a numeric MCQ
  if (numericOptionCount < Math.max(2, options.length - 1)) return { verifiable: false };

  let attempt: { computed: number; worked: string } | null = null;
  let pattern: MathValidationResult["pattern"] | undefined;

  attempt = tryFunctionEval(stem);
  if (attempt) pattern = "function_eval";

  if (!attempt) {
    attempt = tryDirectArithmetic(stem);
    if (attempt) pattern = "arithmetic";
  }

  if (!attempt) return { verifiable: false };

  const matchedIdx = findMatchingOptionIndex(options, attempt.computed);
  if (matchedIdx < 0) {
    // Computed value doesn't match any option — likely our parser missed something subtle.
    // Don't claim authority; return non-verifiable.
    return { verifiable: false };
  }

  const matchedOption = options[matchedIdx];
  const storedNum = parseOptionAsNumber(storedCorrectAnswer);
  const storedCorrectMatches =
    storedNum !== null &&
    Math.abs(storedNum - attempt.computed) < Math.max(NUM_TOL, Math.abs(attempt.computed) * 1e-4);

  return {
    verifiable: true,
    pattern,
    computedAnswer: attempt.computed,
    matchedOption,
    storedCorrectMatches,
    mismatch: !storedCorrectMatches,
    workedSolution: attempt.worked,
  };
}

/**
 * Returns the deterministically-correct answer for a question if verifiable,
 * otherwise the stored answer. Use at grading time so legacy bad questions
 * don't penalise students.
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

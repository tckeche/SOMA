/**
 * Regression: wrong "correct answer" displayed on the student review screen.
 *
 * Reported case (Q15 in a fraction quiz): stem "Calculate 8/9 − 5/12", AI
 * shipped 11/36 as the correct answer; the actual answer is 17/36, and the
 * AI's own explanation said so. The math validator could prove the answer
 * but the result wasn't being applied at read time on the review endpoint,
 * AND verbal stems like "Subtract X from Y" / "Add X and Y" weren't even
 * recognised as arithmetic so they slipped past the disagreement protocol.
 *
 * These tests pin both fixes at the unit level so the bug can't regress.
 */
import { describe, it, expect } from "vitest";
import {
  validateMathQuestion,
  effectiveCorrectAnswer,
} from "../server/services/mathValidator";

describe("mathValidator fraction stems", () => {
  it("Q15 — 'Calculate 8/9 - 5/12' overrides a wrong stored 11/36 → 17/36", () => {
    const stem = "Calculate $\\frac{8}{9} - \\frac{5}{12}$.";
    const options = ["$\\frac{17}{36}$", "$\\frac{11}{36}$", "$\\frac{7}{36}$", "$\\frac{3}{36}$"];
    const r = validateMathQuestion(stem, options, "$\\frac{11}{36}$");
    expect(r.verifiable).toBe(true);
    expect(r.mismatch).toBe(true);
    expect(r.matchedOption).toBe("$\\frac{17}{36}$");
    expect(effectiveCorrectAnswer(stem, options, "$\\frac{11}{36}$")).toBe("$\\frac{17}{36}$");
  });

  it("'Subtract X from Y' computes Y − X (not X − Y)", () => {
    const stem = "Subtract $\\frac{7}{10}$ from $\\frac{9}{5}$. What is the result?";
    const options = ["$\\frac{11}{10}$", "$\\frac{13}{10}$", "$\\frac{2}{10}$", "$-\\frac{11}{10}$"];
    const r = validateMathQuestion(stem, options, "$\\frac{13}{10}$");
    expect(r.verifiable).toBe(true);
    expect(r.pattern).toBe("verbal_arithmetic");
    expect(r.matchedOption).toBe("$\\frac{11}{10}$");
    // Sanity: it must NOT compute 7/10 − 9/5 = −11/10.
    expect(typeof r.computedAnswer).toBe("number");
    expect(r.computedAnswer as number).toBeGreaterThan(0);
  });

  it("'Add X and Y' on integers", () => {
    const stem = "Add 7 and 5. What is the sum?";
    const options = ["12", "2", "35", "11"];
    expect(effectiveCorrectAnswer(stem, options, "11")).toBe("12");
  });

  it("'Add X and Y' on LaTeX fractions", () => {
    const stem = "Add $\\frac{4}{5}$ and $\\frac{3}{10}$. What is the sum?";
    const options = ["$\\frac{11}{10}$", "$\\frac{9}{10}$", "$\\frac{7}{10}$", "$\\frac{14}{10}$"];
    const r = validateMathQuestion(stem, options, "$\\frac{11}{10}$");
    expect(r.verifiable).toBe(true);
    expect(r.matchedOption).toBe("$\\frac{11}{10}$");
    expect(r.storedCorrectMatches).toBe(true);
  });

  it("'Multiply X by Y'", () => {
    const stem = "Multiply $\\frac{2}{3}$ by $\\frac{3}{4}$.";
    const options = ["$\\frac{5}{7}$", "$\\frac{1}{2}$", "$\\frac{6}{7}$", "$\\frac{2}{12}$"];
    const r = validateMathQuestion(stem, options, "$\\frac{5}{7}$");
    expect(r.verifiable).toBe(true);
    expect(r.matchedOption).toBe("$\\frac{1}{2}$");
  });

  it("'Divide X by Y'", () => {
    const stem = "Divide $\\frac{1}{2}$ by $\\frac{1}{4}$.";
    const options = ["$\\frac{1}{8}$", "2", "$\\frac{1}{2}$", "4"];
    expect(effectiveCorrectAnswer(stem, options, "$\\frac{1}{8}$")).toBe("2");
  });

  it("'Sum of X and Y'", () => {
    const stem = "What is the sum of $\\frac{1}{4}$ and $\\frac{1}{4}$?";
    const options = ["$\\frac{1}{2}$", "$\\frac{1}{16}$", "$\\frac{2}{8}$", "0"];
    expect(effectiveCorrectAnswer(stem, options, "$\\frac{1}{16}$")).toBe("$\\frac{1}{2}$");
  });

  it("'Difference between' is commutative when both sides are numeric", () => {
    const stem = "Find the difference between 4 and 9.";
    const options = ["5", "-5", "13", "36"];
    expect(effectiveCorrectAnswer(stem, options, "-5")).toBe("5");
  });

  it("does not trigger on non-arithmetic 'add ... and ...' phrasing", () => {
    const stem = "Add the diagrams and explanations to your answer.";
    const options = ["A", "B", "C", "D"];
    const r = validateMathQuestion(stem, options, "A");
    // Options aren't numeric, so the validator must abstain regardless.
    expect(r.verifiable).toBe(false);
  });

  it("falls back to the stored answer when the stem isn't recognised", () => {
    const stem = "Identify the misconception in the following working.";
    const options = ["misread the question", "wrong sign", "correct", "rounding"];
    expect(effectiveCorrectAnswer(stem, options, "wrong sign")).toBe("wrong sign");
  });
});

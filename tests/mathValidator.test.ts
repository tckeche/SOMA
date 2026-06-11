/**
 * MATH VALIDATOR tests.
 *
 * Part 1 — complex-number support. Regression tests for the assessment-integrity
 * bug where "If z = 2 + 2i, find z²" was marked 8 + 0i instead of the correct
 * 0 + 8i. The deterministic engine must verify complex answers and flag
 * explanations that contradict the marked option.
 *
 * Part 2 — deterministic option parsing. The old parser stripped ALL letters
 * from option text before evaluating, which silently turned "sqrt(2)" into
 * "(2)" = 2 and "2x" into 2 — letting the prover "verify" a wrong option as the
 * correct answer. These tests pin the safe behaviour: evaluate first, only strip
 * recognised units, and treat algebraic text as non-numeric.
 */
import { describe, it, expect } from "vitest";

import {
  validateMathQuestion,
  explanationFinalAnswerMismatch,
  parseNumericValue,
  numericallyEquivalent,
  effectiveCorrectAnswer,
} from "../server/services/mathValidator";

describe("validateMathQuestion: complex numbers", () => {
  const options = ["4 + 4i", "0 + 8i", "4 + 8i", "8 + 0i"];

  it("computes z² correctly and flags the wrong stored answer (the reported bug)", () => {
    const r = validateMathQuestion("If z = 2 + 2i, find z².", options, "8 + 0i");
    expect(r.verifiable).toBe(true);
    expect(r.pattern).toBe("complex_arithmetic");
    expect(r.matchedOption).toBe("0 + 8i");
    expect(r.storedCorrectMatches).toBe(false);
    expect(r.mismatch).toBe(true);
  });

  it("accepts the correct stored answer for z² (caret form)", () => {
    const r = validateMathQuestion("If z = 2 + 2i, find z^2", options, "0 + 8i");
    expect(r.verifiable).toBe(true);
    expect(r.matchedOption).toBe("0 + 8i");
    expect(r.storedCorrectMatches).toBe(true);
    expect(r.mismatch).toBe(false);
  });

  it("verifies the conjugate of a complex number", () => {
    const r = validateMathQuestion(
      "If z = 3 + 4i, find the conjugate of z.",
      ["3 - 4i", "3 + 4i", "-3 + 4i", "4 + 3i"],
      "3 + 4i",
    );
    expect(r.verifiable).toBe(true);
    expect(r.matchedOption).toBe("3 - 4i");
    expect(r.mismatch).toBe(true);
  });

  it("verifies the modulus (real-valued result) of a complex number", () => {
    const r = validateMathQuestion(
      "If z = 3 + 4i, find the modulus of z.",
      ["5", "7", "25", "1"],
      "5",
    );
    expect(r.verifiable).toBe(true);
    expect(r.matchedOption).toBe("5");
    expect(r.storedCorrectMatches).toBe(true);
  });

  it("does not hijack a plain (non-complex) arithmetic question", () => {
    const r = validateMathQuestion("What is: 8 - 6 + 1?", ["3", "2", "15", "1"], "3");
    expect(r.verifiable).toBe(true);
    expect(r.pattern).toBe("arithmetic");
    expect(r.matchedOption).toBe("3");
  });

  it("returns unverifiable for natural-language complex questions it cannot parse", () => {
    const r = validateMathQuestion(
      "If z = 1 + 2i, find z times the conjugate of z.",
      ["5", "3", "-3", "1 + 4i"],
      "5",
    );
    // Safe failure: leaves the LLM answer untouched rather than guessing.
    expect(r.verifiable).toBe(false);
  });
});

describe("explanationFinalAnswerMismatch", () => {
  const options = ["4 + 4i", "0 + 8i", "4 + 8i", "8 + 0i"];

  it("flags an explanation whose final answer contradicts the marked option", () => {
    const r = explanationFinalAnswerMismatch(
      "If z = 2 + 2i, find z².",
      options,
      "0 + 8i",
      "Expanding (2+2i)^2 = 4 + 8i + 4i^2 = 4 + 8i - 4 ... = 8 + 0i.",
    );
    expect(r.mismatch).toBe(true);
    expect(r.expected).toBe("8i");
  });

  it("passes an explanation that states the correct value", () => {
    const r = explanationFinalAnswerMismatch(
      "If z = 2 + 2i, find z².",
      options,
      "0 + 8i",
      "Expanding (2+2i)^2 = 4 + 8i + 4i^2 = 4 + 8i - 4 = 0 + 8i.",
    );
    expect(r.mismatch).toBe(false);
  });

  it("does not flag a purely verbal explanation (no numeric tokens to judge)", () => {
    const r = explanationFinalAnswerMismatch(
      "If z = 2 + 2i, find z².",
      options,
      "0 + 8i",
      "Square the complex number using the binomial expansion and simplify.",
    );
    expect(r.mismatch).toBe(false);
  });

  it("treats 1/2 and 0.5 as equivalent (no false contradiction on fraction form)", () => {
    const r = explanationFinalAnswerMismatch(
      "What is 1 ÷ 2?",
      ["0.5", "0.25", "2", "1"],
      "0.5",
      "Dividing one by two, 1/2 gives the result.",
    );
    expect(r.mismatch).toBe(false);
  });

  it("flags a numeric explanation that never states the correct answer", () => {
    const r = explanationFinalAnswerMismatch(
      "What is 7 * 8?",
      ["54", "56", "63", "49"],
      "56",
      "Multiplying gives 7 times 8 = 54.",
    );
    expect(r.mismatch).toBe(true);
    expect(r.expected).toBe("56");
  });
});

describe("parseNumericValue", () => {
  it("parses plain numbers, decimals, and thousands separators", () => {
    expect(parseNumericValue("42")).toBe(42);
    expect(parseNumericValue("-3.5")).toBe(-3.5);
    expect(parseNumericValue("1,250")).toBe(1250);
  });

  it("evaluates sqrt(2) to ~1.414, NOT 2 (letter-stripping regression)", () => {
    expect(parseNumericValue("sqrt(2)")).toBeCloseTo(Math.SQRT2, 6);
    expect(parseNumericValue("\\sqrt{2}")).toBeCloseTo(Math.SQRT2, 6);
    expect(parseNumericValue("√2")).toBeCloseTo(Math.SQRT2, 6);
  });

  it("evaluates fractions in every common notation", () => {
    expect(parseNumericValue("2/3")).toBeCloseTo(2 / 3, 6);
    expect(parseNumericValue("\\frac{2}{3}")).toBeCloseTo(2 / 3, 6);
    expect(parseNumericValue("\\dfrac{2}{3}")).toBeCloseTo(2 / 3, 6);
    expect(parseNumericValue("½")).toBeCloseTo(0.5, 6);
  });

  it("resolves nested fractions", () => {
    expect(parseNumericValue("\\frac{1}{\\frac{1}{2}}")).toBeCloseTo(2, 6);
  });

  it("evaluates pi expressions", () => {
    expect(parseNumericValue("\\pi")).toBeCloseTo(Math.PI, 6);
    expect(parseNumericValue("pi/2")).toBeCloseTo(Math.PI / 2, 6);
  });

  it("handles unicode superscripts beyond ²³ (regression: ⁶⁷⁸⁹ were dropped)", () => {
    expect(parseNumericValue("2⁶")).toBe(64);
    expect(parseNumericValue("10⁻²")).toBeCloseTo(0.01, 6);
    expect(parseNumericValue("3²")).toBe(9);
  });

  it("strips recognised trailing units", () => {
    expect(parseNumericValue("12 cm")).toBe(12);
    expect(parseNumericValue("45 minutes")).toBe(45);
    expect(parseNumericValue("90°")).toBe(90);
    expect(parseNumericValue("25%")).toBe(25);
    expect(parseNumericValue("$1,500")).toBe(1500);
  });

  it("treats algebraic options as NON-numeric (regression: '2x' parsed as 2)", () => {
    expect(parseNumericValue("2x")).toBeNull();
    expect(parseNumericValue("3a + 1")).toBeNull();
    expect(parseNumericValue("x + 2")).toBeNull();
  });

  it("returns null for prose options", () => {
    expect(parseNumericValue("Cannot be determined")).toBeNull();
    expect(parseNumericValue("")).toBeNull();
  });
});

describe("numericallyEquivalent", () => {
  it("treats equal values in different notations as equivalent", () => {
    expect(numericallyEquivalent("2", "2.0")).toBe(true);
    expect(numericallyEquivalent("0.5", "\\frac{1}{2}")).toBe(true);
    expect(numericallyEquivalent("0.5", "1/2")).toBe(true);
  });

  it("rejects different values and non-numeric inputs", () => {
    expect(numericallyEquivalent("12", "123")).toBe(false);
    expect(numericallyEquivalent("2", "2x")).toBe(false);
    expect(numericallyEquivalent("Darwin", "Darwin")).toBe(false);
  });
});

describe("validateMathQuestion — wrong-option matching regressions", () => {
  it("does not match a sqrt option when the computed answer is the integer", () => {
    // Old behaviour: "√2" was letter-stripped to "2" and matched FIRST,
    // flipping the answer key onto the wrong option.
    const result = validateMathQuestion(
      "What is $8 - 6$?",
      ["√2", "2", "3", "4"],
      "2",
    );
    expect(result.verifiable).toBe(true);
    expect(result.matchedOption).toBe("2");
    expect(result.storedCorrectMatches).toBe(true);
  });

  it("still verifies simple arithmetic", () => {
    const result = validateMathQuestion("What is $2 + 2$?", ["2", "3", "4", "5"], "4");
    expect(result.verifiable).toBe(true);
    expect(result.matchedOption).toBe("4");
  });

  it("declines to verify when options are algebraic, instead of mis-valuing them", () => {
    const result = validateMathQuestion(
      "Differentiate $x^2$.",
      ["2x", "x", "2", "x^2"],
      "2x",
    );
    // "2x" and "x" are not numbers; with at most 2 numeric-shaped options the
    // prover must stand down rather than guess.
    expect(result.verifiable).toBe(false);
  });
});

describe("effectiveCorrectAnswer", () => {
  it("overrides a wrong stored answer when deterministically solvable", () => {
    expect(effectiveCorrectAnswer("What is $2 + 2$?", ["2", "3", "4", "5"], "5")).toBe("4");
  });

  it("keeps the stored answer when the question is not verifiable", () => {
    expect(
      effectiveCorrectAnswer("Which is a prime?", ["Apple", "Banana", "Cherry", "Date"], "Cherry"),
    ).toBe("Cherry");
  });
});

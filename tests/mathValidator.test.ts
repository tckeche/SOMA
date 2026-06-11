/**
 * Regression tests for the deterministic math prover's option parsing.
 *
 * The old parser stripped ALL letters from option text before evaluating,
 * which silently turned "sqrt(2)" into "(2)" = 2 and "2x" into 2 — letting
 * the prover "verify" a wrong option as the correct answer. These tests pin
 * the safe behaviour: evaluate first, only strip recognised units, and treat
 * algebraic text as non-numeric.
 */
import { describe, it, expect } from "vitest";

import {
  parseNumericValue,
  numericallyEquivalent,
  validateMathQuestion,
  effectiveCorrectAnswer,
} from "../server/services/mathValidator";

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

/**
 * MATH VALIDATOR — complex-number support.
 * Regression tests for the assessment-integrity bug where "If z = 2 + 2i,
 * find z²" was marked 8 + 0i instead of the correct 0 + 8i. The deterministic
 * engine must verify complex answers and flag explanations that contradict the
 * marked option.
 */
import { describe, it, expect } from "vitest";

import {
  validateMathQuestion,
  explanationFinalAnswerMismatch,
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

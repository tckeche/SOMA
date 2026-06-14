/**
 * QUESTION QUALITY GATE tests.
 *
 * Deterministic per-question checks that flag genuinely broken MCQ questions so
 * they are never served to students. Each test pins one rule: hard failures must
 * yield auto_blocked, soft issues needs_review, and clean questions approved.
 */
import { describe, it, expect } from "vitest";

import {
  validateQuestionQuality,
  type QualityInput,
} from "../server/services/questionQuality";

function base(overrides: Partial<QualityInput> = {}): QualityInput {
  return {
    stem: "What is the capital of France?",
    options: ["Paris", "London", "Berlin", "Madrid"],
    correct_answer: "Paris",
    ...overrides,
  };
}

describe("validateQuestionQuality", () => {
  it("approves a clean 4-option question", () => {
    const r = validateQuestionQuality(base());
    expect(r.reviewStatus).toBe("approved");
    expect(r.blocking).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("blocks when there are not exactly 4 options", () => {
    const r = validateQuestionQuality(
      base({ options: ["Paris", "London", "Berlin"] }),
    );
    expect(r.reviewStatus).toBe("auto_blocked");
    expect(r.blocking.length).toBeGreaterThan(0);
  });

  it("blocks when the correct answer is not among the options", () => {
    const r = validateQuestionQuality(base({ correct_answer: "Rome" }));
    expect(r.reviewStatus).toBe("auto_blocked");
    expect(r.blocking.join(" ")).toMatch(/not present/i);
  });

  it("blocks when the correct answer matches more than one option (duplicate correct)", () => {
    const r = validateQuestionQuality(
      base({ options: ["Paris", "Paris", "Berlin", "Madrid"] }),
    );
    expect(r.reviewStatus).toBe("auto_blocked");
    expect(r.blocking.length).toBeGreaterThan(0);
  });

  it("blocks numerically-equivalent distractors ('0.5' and '1/2')", () => {
    const r = validateQuestionQuality({
      stem: "Which equals a half?",
      options: ["0.5", "1/2", "0.25", "0.75"],
      correct_answer: "0.5",
    });
    expect(r.reviewStatus).toBe("auto_blocked");
    expect(r.blocking).toContain("two options are equivalent");
  });

  it("blocks an option carrying the generation-failure sentinel", () => {
    const r = validateQuestionQuality(
      base({
        options: ["Paris", "London", "Berlin", "[OPTION GENERATION FAILED]"],
      }),
    );
    expect(r.reviewStatus).toBe("auto_blocked");
    expect(r.blocking.join(" ")).toMatch(/sentinel/i);
  });

  it("blocks a complex-number explanation that contradicts the marked answer", () => {
    const r = validateQuestionQuality({
      stem: "If z = 2 + 2i, find z².",
      options: ["0 + 8i", "4 + 4i", "4 + 8i", "8 + 0i"],
      correct_answer: "0 + 8i",
      explanation: "Squaring gives 8 + 0i.",
    });
    expect(r.reviewStatus).toBe("auto_blocked");
    expect(r.blocking.join(" ")).toMatch(/explanation/i);
  });

  it("warns (needs_review) on a plain numeric explanation mismatch", () => {
    const r = validateQuestionQuality({
      stem: "If x = 3, find 2x + 1.",
      options: ["7", "5", "9", "11"],
      correct_answer: "7",
      explanation: "The worked answer comes to 42.",
    });
    expect(r.reviewStatus).toBe("needs_review");
    expect(r.blocking).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("warns (needs_review) when the correct option is conspicuously longer than distractors", () => {
    const r = validateQuestionQuality({
      stem: "Which statement is true?",
      options: [
        "The answer is the very long and conspicuously detailed correct choice here indeed",
        "no",
        "yes",
        "maybe",
      ],
      correct_answer:
        "The answer is the very long and conspicuously detailed correct choice here indeed",
    });
    expect(r.reviewStatus).toBe("needs_review");
    expect(r.warnings).toContain(
      "correct option is conspicuously longer than distractors",
    );
  });

  it("warns (needs_review) on an invalid difficulty tag", () => {
    const r = validateQuestionQuality(base({ difficulty_tag: "impossible" }));
    expect(r.reviewStatus).toBe("needs_review");
    expect(r.warnings.join(" ")).toMatch(/difficulty/i);
  });

  it("keeps a valid difficulty tag approved", () => {
    const r = validateQuestionQuality(base({ difficulty_tag: "medium" }));
    expect(r.reviewStatus).toBe("approved");
  });

  it("warns (needs_review) when an answer keyword appears in the stem but no distractor", () => {
    // "chloroplast" is a >=4 char token present in the stem but in none of the distractors.
    const revealing = validateQuestionQuality({
      stem: "Where in the cell does the chloroplast function occur?",
      options: ["Chloroplast", "Nucleus", "Ribosome", "Vacuole"],
      correct_answer: "Chloroplast",
    });
    expect(revealing.reviewStatus).toBe("needs_review");
    expect(revealing.warnings).toContain(
      "answer keyword appears in the stem but not in distractors",
    );

    // sanity: the non-revealing variant (keyword absent from stem) stays approved
    const clean = validateQuestionQuality({
      stem: "Photosynthesis occurs in which organelle?",
      options: ["Chloroplast", "Nucleus", "Ribosome", "Vacuole"],
      correct_answer: "Chloroplast",
    });
    expect(clean.reviewStatus).toBe("approved");
  });
});

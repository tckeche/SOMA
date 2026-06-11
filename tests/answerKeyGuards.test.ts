/**
 * Regression tests for the pipeline's answer-key guards — the places where a
 * wrong answer could previously be produced or a good question falsely blocked:
 *
 *  1. validateAndCorrectMcqAnswers substring-snapped numeric answers onto the
 *     wrong option ("12" → "123" at 67% overlap) and shipped it as auto-fixed.
 *  2. applyDisagreementProtocol compared prover vs verifier as raw strings, so
 *     "4" vs "4.0" was a false disagreement that burned a re-roll pass.
 *  3. dedupeOptions padded "Option N" placeholders silently — students could
 *     see a nonsense option in a published quiz.
 */
import { describe, it, expect } from "vitest";

import {
  validateAndCorrectMcqAnswers,
  applyDisagreementProtocol,
  applyDeterministicIntegrityGuards,
  type QuizResult,
} from "../server/services/aiPipeline";

const baseQuestion = {
  stem: "Compute the value.",
  options: ["10", "11", "12", "13"],
  correct_answer: "12",
  explanation: "Because.",
  marks: 1,
};

describe("validateAndCorrectMcqAnswers — numeric answers", () => {
  it("snaps a numeric answer onto the numerically-equal option across notations", () => {
    const q = { ...baseQuestion, options: ["1/4", "1/2", "3/4", "1"], correct_answer: "0.5" };
    const { questions, warnings } = validateAndCorrectMcqAnswers([q]);
    expect(questions[0].correct_answer).toBe("1/2");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].autoFixed).toBe(true);
  });

  it("never substring-snaps a numeric answer onto a superstring option (12 vs 123)", () => {
    const q = { ...baseQuestion, options: ["123", "12.5", "14", "15"], correct_answer: "12" };
    const { questions, warnings } = validateAndCorrectMcqAnswers([q]);
    // No option equals 12 → CRITICAL unfixed warning, NOT a silent snap to "123".
    expect(warnings).toHaveLength(1);
    expect(warnings[0].autoFixed).toBe(false);
    expect(warnings[0].issue).toMatch(/CRITICAL/);
    // Fallback keeps the quiz savable but the protocol will block this question.
    expect(questions[0].correct_answer).toBe("123");
  });

  it("still substring-matches genuinely textual answers", () => {
    const q = {
      ...baseQuestion,
      options: ["The mean increases", "The mean decreases", "No change", "Cannot say"],
      correct_answer: "mean increases",
    };
    const { questions, warnings } = validateAndCorrectMcqAnswers([q]);
    expect(questions[0].correct_answer).toBe("The mean increases");
    expect(warnings[0].autoFixed).toBe(true);
  });

  it("leaves exact matches untouched", () => {
    const { questions, warnings } = validateAndCorrectMcqAnswers([baseQuestion]);
    expect(questions[0]).toEqual(baseQuestion);
    expect(warnings).toHaveLength(0);
  });
});

describe("applyDisagreementProtocol — numeric equivalence", () => {
  it("does not block when prover and verifier agree numerically but not textually", () => {
    // Options contain both "4" and "4.0"; the prover's matched option is "4"
    // while the verifier said "4.0". Same value → agreement, not a block.
    const verified: QuizResult["questions"][number] = {
      stem: "What is $2 + 2$?",
      options: ["4", "4.0", "5", "6"],
      correct_answer: "4.0",
      explanation: "Two plus two.",
      marks: 1,
    };
    const draft = { stem: verified.stem, options: verified.options, correct_answer: "4.0", marks: 1 };
    const result = applyDisagreementProtocol([draft], [verified], []);
    expect(result.blocked).toHaveLength(0);
    expect(result.questions).toHaveLength(1);
  });

  it("still blocks a genuine prover/verifier disagreement", () => {
    const verified: QuizResult["questions"][number] = {
      stem: "What is $2 + 2$?",
      options: ["2", "3", "4", "5"],
      correct_answer: "5",
      explanation: "Two plus two.",
      marks: 1,
    };
    const draft = { stem: verified.stem, options: verified.options, correct_answer: "5", marks: 1 };
    const result = applyDisagreementProtocol([draft], [verified], []);
    expect(result.blocked).toHaveLength(1);
  });
});

describe("applyDeterministicIntegrityGuards — placeholder options", () => {
  it("flags padded placeholder options as CRITICAL so the protocol blocks them", () => {
    const q = {
      stem: "Pick one.",
      options: ["A", "A", "A", "A"], // collapses to 1 distinct option
      correct_answer: "A",
      explanation: "x",
      marks: 1,
    };
    const { questions, warnings } = applyDeterministicIntegrityGuards([q]);
    expect(questions[0].options).toHaveLength(4);
    const critical = warnings.filter((w) => /CRITICAL/.test(w.issue) && w.autoFixed === false);
    expect(critical.length).toBeGreaterThanOrEqual(1);
    expect(critical[0].field).toBe("options");

    // End-to-end: the disagreement protocol must block it.
    const protocol = applyDisagreementProtocol(
      [{ stem: q.stem, options: questions[0].options, correct_answer: "A", marks: 1 }],
      questions,
      warnings,
    );
    expect(protocol.blocked).toHaveLength(1);
    expect(protocol.questions).toHaveLength(0);
  });

  it("does not flag a healthy 4-option question", () => {
    const { warnings } = applyDeterministicIntegrityGuards([baseQuestion]);
    expect(warnings).toHaveLength(0);
  });
});

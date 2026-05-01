/**
 * Tests for the re-roll wrapper around generateAuditedQuiz.
 *
 * The wrapper guarantees that an assignment ships at full length: when
 * the disagreement protocol blocks a question, we re-generate the
 * shortfall slot(s) up to maxRerollAttempts times before giving up.
 *
 * We drive the test by stubbing the maker to alternate between producing
 * a wrong-answer question (which the protocol blocks) and a correct one
 * — so the first pass is short and the second pass fills it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  generateAuditedQuiz,
  pipelineStages,
} from "../server/services/aiPipeline";

const mathDraft = {
  stem: "What is $2 + 2$?",
  options: ["2", "3", "4", "5"],
  correct_answer: "4",
  marks: 1,
};

const correctMathQuestion = {
  ...mathDraft,
  explanation: "Two plus two equals four.",
};

// A question whose verifier emits a correct_answer that does not match
// any option, so validateAndCorrectMcqAnswers raises a CRITICAL warning
// → the disagreement protocol blocks. We can't use a wrong-numeric
// answer for "2+2" to trigger a block: the math validator auto-fixes it
// before the protocol stage sees it. Using an unmatchable answer is the
// reliable way to land in the protocol's block path.
const unrecoverableQuestion = {
  stem: "What is $2 + 2$?",
  options: ["2", "3", "4", "5"],
  correct_answer: "Pizza",
  explanation: "Verifier picked something that isn't an option.",
  marks: 1,
};

const originalStages = { ...pipelineStages };
function stubStages(overrides: Partial<typeof pipelineStages>) {
  Object.assign(pipelineStages, originalStages, overrides);
}

describe("generateAuditedQuiz re-roll loop", () => {
  beforeEach(() => {
    Object.assign(pipelineStages, originalStages);
  });

  it("does not re-roll when the first pass ships a full quiz", async () => {
    const maker = vi.fn().mockResolvedValue({ questions: [mathDraft] });
    const verifier = vi.fn().mockResolvedValue({ questions: [correctMathQuestion], warnings: [] });
    stubStages({
      runClaudeMakerSimple: maker,
      runOpenAIMakerSimple: vi.fn(),
      runOpenAIVerifier: verifier,
      runGeminiVerifier: vi.fn(),
    });

    const result = await generateAuditedQuiz({
      topic: "Arithmetic",
      subject: "Mathematics",
      syllabus: "Cambridge",
      level: "IGCSE",
      questionCount: 1,
    });

    expect(maker).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(result.questions).toHaveLength(1);
    expect(result.blockedQuestions).toHaveLength(0);
    expect(result.telemetry.rerollAttempts).toBe(0);
    expect(result.telemetry.recoveredCount).toBe(0);
  });

  it("re-rolls a single blocked slot until the quiz is full", async () => {
    const maker = vi.fn().mockResolvedValue({ questions: [mathDraft] });
    const verifier = vi.fn()
      // First pass: verifier says 5 → math prover disagrees → blocked.
      .mockResolvedValueOnce({ questions: [unrecoverableQuestion], warnings: [] })
      // Second pass (re-roll): verifier returns the right answer.
      .mockResolvedValueOnce({ questions: [correctMathQuestion], warnings: [] });
    stubStages({
      runClaudeMakerSimple: maker,
      runOpenAIMakerSimple: vi.fn(),
      runOpenAIVerifier: verifier,
      runGeminiVerifier: vi.fn(),
    });

    const result = await generateAuditedQuiz({
      topic: "Arithmetic",
      subject: "Mathematics",
      syllabus: "Cambridge",
      level: "IGCSE",
      questionCount: 1,
    });

    expect(maker).toHaveBeenCalledTimes(2);
    expect(verifier).toHaveBeenCalledTimes(2);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].correct_answer).toBe("4");
    expect(result.blockedQuestions).toHaveLength(0);
    expect(result.telemetry.rerollAttempts).toBe(1);
    expect(result.telemetry.recoveredCount).toBe(1);
  });

  it("stops re-rolling and ships short with a warning when maxRerollAttempts is exhausted", async () => {
    const maker = vi.fn().mockResolvedValue({ questions: [mathDraft] });
    // Every pass produces a blocked question.
    const verifier = vi.fn().mockResolvedValue({ questions: [unrecoverableQuestion], warnings: [] });
    stubStages({
      runClaudeMakerSimple: maker,
      runOpenAIMakerSimple: vi.fn(),
      runOpenAIVerifier: verifier,
      runGeminiVerifier: vi.fn(),
    });

    const result = await generateAuditedQuiz({
      topic: "Arithmetic",
      subject: "Mathematics",
      syllabus: "Cambridge",
      level: "IGCSE",
      questionCount: 1,
      maxRerollAttempts: 2,
    });

    // 1 initial pass + 2 re-rolls = 3 maker calls
    expect(maker).toHaveBeenCalledTimes(3);
    expect(result.questions).toHaveLength(0);
    expect(result.blockedQuestions).toHaveLength(1);
    expect(result.telemetry.rerollAttempts).toBe(2);
    expect(result.telemetry.recoveredCount).toBe(0);
    // The exhaustion warning should be present.
    expect(result.warnings.some((w) => /remained blocked after 2 re-roll attempt/.test(w.issue))).toBe(true);
  });

  it("opts out of re-rolling when maxRerollAttempts is 0", async () => {
    const maker = vi.fn().mockResolvedValue({ questions: [mathDraft] });
    const verifier = vi.fn().mockResolvedValue({ questions: [unrecoverableQuestion], warnings: [] });
    stubStages({
      runClaudeMakerSimple: maker,
      runOpenAIMakerSimple: vi.fn(),
      runOpenAIVerifier: verifier,
      runGeminiVerifier: vi.fn(),
    });

    const result = await generateAuditedQuiz({
      topic: "Arithmetic",
      subject: "Mathematics",
      syllabus: "Cambridge",
      level: "IGCSE",
      questionCount: 1,
      maxRerollAttempts: 0,
    });

    expect(maker).toHaveBeenCalledTimes(1);
    expect(result.questions).toHaveLength(0);
    expect(result.blockedQuestions).toHaveLength(1);
  });

  it("partially recovers (kept some + re-rolled rest) when only one of two slots was blocked", async () => {
    // First pass: 2 questions, the second blocked.
    // Re-roll: 1 question, succeeds.
    const maker = vi.fn()
      .mockResolvedValueOnce({ questions: [mathDraft, mathDraft] })
      .mockResolvedValueOnce({ questions: [mathDraft] });
    const verifier = vi.fn()
      .mockResolvedValueOnce({ questions: [correctMathQuestion, unrecoverableQuestion], warnings: [] })
      .mockResolvedValueOnce({ questions: [correctMathQuestion], warnings: [] });
    stubStages({
      runClaudeMakerSimple: maker,
      runOpenAIMakerSimple: vi.fn(),
      runOpenAIVerifier: verifier,
      runGeminiVerifier: vi.fn(),
    });

    const result = await generateAuditedQuiz({
      topic: "Arithmetic",
      subject: "Mathematics",
      syllabus: "Cambridge",
      level: "IGCSE",
      questionCount: 2,
    });

    expect(result.questions).toHaveLength(2);
    expect(result.blockedQuestions).toHaveLength(0);
    expect(result.telemetry.rerollAttempts).toBe(1);
    expect(result.telemetry.recoveredCount).toBe(1);
  });

  it("handles a re-roll that throws by stopping the loop and shipping what was recovered", async () => {
    let callCount = 0;
    const maker = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount > 1) throw new Error("Provider exploded");
      return { questions: [mathDraft] };
    });
    const verifier = vi.fn().mockResolvedValue({ questions: [unrecoverableQuestion], warnings: [] });
    const fallbackMaker = vi.fn().mockRejectedValue(new Error("Fallback also down"));
    stubStages({
      runClaudeMakerSimple: maker,
      runOpenAIMakerSimple: fallbackMaker,
      runOpenAIVerifier: verifier,
      runGeminiVerifier: vi.fn(),
    });

    const result = await generateAuditedQuiz({
      topic: "Arithmetic",
      subject: "Mathematics",
      syllabus: "Cambridge",
      level: "IGCSE",
      questionCount: 1,
    });

    // Re-roll thrown should not crash the whole call.
    expect(result.warnings.some((w) => /Re-roll attempt 1 failed/.test(w.issue))).toBe(true);
    expect(result.questions).toHaveLength(0);
  });
});

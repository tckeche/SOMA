/**
 * C-1 ANSWER-LEAK REGRESSION.
 *
 * Pre-submission question payloads served to students must NOT carry the answer
 * key or any field that reveals the correct option. This pins the allowlist
 * shape of `sanitizeQuestionForPreSubmission` so a future refactor cannot
 * accidentally re-introduce an answer leak.
 */
import { describe, it, expect } from "vitest";

import { sanitizeQuestionForPreSubmission } from "../server/routes";

const fullQuestion = {
  id: 7,
  quizId: 3,
  stem: "What is 2 + 2?",
  options: ["3", "4", "5", "6"],
  correctAnswer: "4",
  explanation: "Two plus two is four.",
  marks: 1,
  questionType: "multiple_choice",
  graphSpec: null,
  topicTag: "arithmetic",
  subtopicTag: null,
  difficultyTag: "easy",
  subtopicId: null,
  learningRequirementId: null,
  targetMisconceptionIds: [11, 22],
  commandWord: "state",
  assessmentObjective: "AO1",
  optionRationales: [
    { option: "4", isCorrect: true, rationale: "correct", misconceptionId: null },
  ],
  reviewStatus: "approved",
  generationMeta: null,
} as any;

describe("sanitizeQuestionForPreSubmission", () => {
  const sanitized = sanitizeQuestionForPreSubmission(fullQuestion);

  it("keeps the safe student-facing fields", () => {
    for (const key of [
      "id",
      "quizId",
      "stem",
      "options",
      "marks",
      "questionType",
      "graphSpec",
    ]) {
      expect(sanitized).toHaveProperty(key);
    }
    expect(sanitized.id).toBe(7);
    expect(sanitized.stem).toBe("What is 2 + 2?");
    expect(sanitized.options).toEqual(["3", "4", "5", "6"]);
  });

  it("strips every field that could reveal the answer key", () => {
    for (const leaky of [
      "correctAnswer",
      "explanation",
      "optionRationales",
      "targetMisconceptionIds",
    ]) {
      expect(sanitized).not.toHaveProperty(leaky);
    }
  });
});

/**
 * REGRADE ENGINE tests.
 *
 * `recomputeReportScore` recomputes a report's score from stored data only (NO
 * AI), using the exact same `effectiveCorrectAnswer` marking as submission time
 * and the `isServableToStudent` publish gate. Excluding a question (reviewStatus
 * "excluded") drops it from BOTH numerator and denominator, so:
 *   (a) excluding a question the student got right lowers numerator AND denominator;
 *   (b) excluding a question the student got wrong lowers denominator only;
 *   (c) no exclusions -> score matches the original marking.
 */
import { describe, it, expect } from "vitest";

import { recomputeReportScore } from "../server/services/regrade";
import type { SomaQuestion, SomaReport } from "../shared/schema";

// Minimal question fixture; only the fields the marker/gate read matter.
function q(
  id: number,
  correctAnswer: string,
  reviewStatus: string = "approved",
  marks = 1,
): SomaQuestion {
  return {
    id,
    quizId: 1,
    stem: `Q${id}`,
    options: ["A", "B", "C", "D"],
    correctAnswer,
    explanation: "",
    marks,
    questionType: "multiple_choice",
    graphSpec: null,
    topicTag: null,
    subtopicTag: null,
    difficultyTag: null,
    subtopicId: null,
    learningRequirementId: null,
    targetMisconceptionIds: null,
    commandWord: null,
    assessmentObjective: null,
    optionRationales: null,
    reviewStatus,
    generationMeta: null,
  } as SomaQuestion;
}

function report(answers: Record<string, string>, score: number): Pick<SomaReport, "score" | "answersJson"> {
  return { score, answersJson: answers };
}

describe("recomputeReportScore", () => {
  // Student answered: Q1 right, Q2 right, Q3 wrong. Original score = 2 of 3.
  const answers = { "1": "A", "2": "B", "3": "X" };

  it("(c) no exclusions -> score matches original marking", () => {
    const questions = [q(1, "A"), q(2, "B"), q(3, "C")];
    const r = recomputeReportScore(report(answers, 2), questions);
    expect(r.newScore).toBe(2);
    expect(r.maxPossibleScore).toBe(3);
    expect(r.oldScore).toBe(2);
  });

  it("(a) excluding a right question lowers numerator AND denominator", () => {
    // Q1 (got right) excluded -> served Q2,Q3: 1 of 2.
    const questions = [q(1, "A", "excluded"), q(2, "B"), q(3, "C")];
    const r = recomputeReportScore(report(answers, 2), questions);
    expect(r.newScore).toBe(1);
    expect(r.maxPossibleScore).toBe(2);
  });

  it("(b) excluding a wrong question lowers denominator only", () => {
    // Q3 (got wrong) excluded -> served Q1,Q2: 2 of 2.
    const questions = [q(1, "A"), q(2, "B"), q(3, "C", "excluded")];
    const r = recomputeReportScore(report(answers, 2), questions);
    expect(r.newScore).toBe(2);
    expect(r.maxPossibleScore).toBe(2);
  });

  it("respects per-question marks and ignores all non-approved statuses", () => {
    const questions = [
      q(1, "A", "approved", 3), // right, 3 marks
      q(2, "B", "needs_review", 5), // not served
      q(3, "C", "auto_blocked", 5), // not served
    ];
    const r = recomputeReportScore(report(answers, 3), questions);
    expect(r.newScore).toBe(3);
    expect(r.maxPossibleScore).toBe(3);
  });
});

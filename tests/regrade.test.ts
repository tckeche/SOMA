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

function report(
  answers: Record<string, string>,
  score: number,
  manualMarks: Record<string, number> | null = null,
): Pick<SomaReport, "score" | "answersJson" | "manualMarks"> {
  return { score, answersJson: answers, manualMarks };
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

  describe("manual marks overrides", () => {
    it("(a) override raises a wrong answer to partial/full marks", () => {
      // Q3 wrong (0) -> tutor awards 2 of its 4 marks (partial credit).
      const questions = [q(1, "A"), q(2, "B"), q(3, "C", "approved", 4)];
      const r = recomputeReportScore(report(answers, 2, { "3": 2 }), questions);
      // Q1(1) + Q2(1) + Q3 override(2) = 4 of 6.
      expect(r.newScore).toBe(4);
      expect(r.maxPossibleScore).toBe(6);
    });

    it("(b) override lowers a correct answer", () => {
      // Q1 right (2 marks) but tutor knocks it down to 1.
      const questions = [q(1, "A", "approved", 2), q(2, "B"), q(3, "C")];
      const r = recomputeReportScore(report(answers, 3, { "1": 1 }), questions);
      // Q1 override(1) + Q2(1) + Q3 wrong(0) = 2 of 4.
      expect(r.newScore).toBe(2);
      expect(r.maxPossibleScore).toBe(4);
    });

    it("(c) override is clamped to 0..q.marks", () => {
      const questions = [q(1, "A", "approved", 3), q(2, "B"), q(3, "C")];
      // 99 clamps to 3; -5 clamps to 0.
      const high = recomputeReportScore(report(answers, 0, { "1": 99 }), questions);
      expect(high.newScore).toBe(3 + 1); // Q1 clamped to 3 + Q2 right 1
      const low = recomputeReportScore(report(answers, 0, { "2": -5 }), questions);
      expect(low.newScore).toBe(3 + 0); // Q1 right 3 (default marks=1? no: q1 marks 3) + Q2 clamped to 0
    });

    it("(d) clearing (no key) falls back to computed marks", () => {
      const questions = [q(1, "A"), q(2, "B"), q(3, "C")];
      // Only Q3 has an override; Q1/Q2 fall back to computed (both right).
      const r = recomputeReportScore(report(answers, 2, { "3": 1 }), questions);
      expect(r.newScore).toBe(1 + 1 + 1); // computed Q1 + computed Q2 + override Q3
      // With no manualMarks at all -> pure computed.
      const r2 = recomputeReportScore(report(answers, 2, null), questions);
      expect(r2.newScore).toBe(2);
    });

    it("(e) regrade + overrides: excluded question drops out, override on a served question respected", () => {
      const questions = [
        q(1, "A", "excluded", 2), // got right but excluded -> dropped entirely
        q(2, "B", "approved", 1), // served, right
        q(3, "C", "approved", 4), // served, wrong -> overridden to 3
      ];
      const r = recomputeReportScore(report(answers, 3, { "1": 5, "3": 3 }), questions);
      // Q1 excluded (override ignored, not in denom); Q2 computed 1; Q3 override 3.
      expect(r.newScore).toBe(4); // 1 + 3
      expect(r.maxPossibleScore).toBe(5); // Q2(1) + Q3(4)
    });
  });
});

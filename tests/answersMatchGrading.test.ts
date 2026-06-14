/**
 * ANSWER-MATCHING false-negative regression (SOMA-001).
 *
 * Student answers are trimmed at intake (sanitizeSubmittedAnswers), but the
 * correct value returned by effectiveCorrectAnswer (a verbatim option string or
 * the stored answer) is NOT trimmed. A raw `studentAnswer === correctAnswer`
 * comparison therefore marks a correct selection WRONG whenever the stored
 * option carries stray leading/trailing whitespace — a silent false negative
 * that costs the student marks.
 *
 * `answersMatch` trims BOTH sides, closing the gap, while still never matching
 * an empty/unanswered side. `recomputeReportScore` (the regrade engine, which
 * shares the exact submission-time marking) must inherit the same behaviour so
 * a regrade can never diverge from the score the student received.
 */
import { describe, it, expect } from "vitest";

import { answersMatch } from "../server/services/mathValidator";
import { recomputeReportScore } from "../server/services/regrade";
import type { SomaQuestion, SomaReport } from "../shared/schema";

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

describe("answersMatch", () => {
  it("matches identical answers", () => {
    expect(answersMatch("Paris", "Paris")).toBe(true);
  });

  it("matches despite leading/trailing whitespace on either side (the bug)", () => {
    expect(answersMatch("Paris", "Paris ")).toBe(true);
    expect(answersMatch(" Paris", "Paris")).toBe(true);
    expect(answersMatch("  Paris  ", " Paris ")).toBe(true);
  });

  it("does not match different answers", () => {
    expect(answersMatch("Paris", "London")).toBe(false);
  });

  it("never matches an empty/unanswered side", () => {
    expect(answersMatch(undefined, "Paris")).toBe(false);
    expect(answersMatch(null, "Paris")).toBe(false);
    expect(answersMatch("", "Paris")).toBe(false);
    expect(answersMatch("   ", "Paris")).toBe(false);
    expect(answersMatch("Paris", "")).toBe(false);
  });
});

describe("recomputeReportScore — whitespace false negative (SOMA-001)", () => {
  it("awards the mark when the stored correct answer has trailing whitespace", () => {
    // Stored correct answer carries a trailing space; student picked the clean
    // value. Pre-fix this scored 0; post-fix it scores the mark.
    const questions = [q(1, "Paris ")];
    const r = recomputeReportScore(report({ "1": "Paris" }, 0), questions);
    expect(r.newScore).toBe(1);
    expect(r.maxPossibleScore).toBe(1);
  });

  it("awards the mark when the stored student answer has leading whitespace", () => {
    const questions = [q(1, "Paris")];
    const r = recomputeReportScore(report({ "1": " Paris" }, 0), questions);
    expect(r.newScore).toBe(1);
  });

  it("still marks a genuinely wrong answer wrong", () => {
    const questions = [q(1, "Paris ")];
    const r = recomputeReportScore(report({ "1": "London" }, 0), questions);
    expect(r.newScore).toBe(0);
  });

  it("does not award an unanswered question", () => {
    const questions = [q(1, "Paris ")];
    const r = recomputeReportScore(report({}, 0), questions);
    expect(r.newScore).toBe(0);
    expect(r.maxPossibleScore).toBe(1);
  });
});

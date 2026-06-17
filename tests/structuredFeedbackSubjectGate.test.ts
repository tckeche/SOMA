/**
 * Structured-feedback subject visibility gate.
 *
 * A tutor must only ever see written-answer feedback for subjects they have
 * actually assigned the student a quiz in. buildStructuredFeedback enforces this
 * through its `allowedSubjects` option: when supplied, feedback for any other
 * subject (or for quizzes with no subject) is dropped. When omitted, every
 * subject is returned (the student's own view).
 */
import { describe, it, expect } from "vitest";

import { buildStructuredFeedback } from "../server/services/structuredFeedback";
import type { IStorage } from "../server/storage";

function report(quizId: number, subject: string) {
  return {
    id: quizId * 10,
    quizId,
    studentId: "stu-1",
    status: "completed",
    completedAt: new Date().toISOString(),
    quiz: { id: quizId, title: `Quiz ${quizId}`, subject },
    structuredMarking: {
      "1": { maxMarks: 10, aiMarks: 2, aiUnderstanding: "missed the method", aiFeedback: "show each step" },
    },
  } as any;
}

function makeStorage(): IStorage {
  return {
    // Maths (in scope) + Physics (NOT assigned by this tutor).
    getSomaReportsByStudentId: async () => [report(1, "Mathematics"), report(2, "Physics")],
    getSomaQuestionsByQuizIds: async (ids: number[]) => {
      const out: Record<number, any[]> = {};
      for (const id of ids) {
        out[id] = [{ id: 1, stem: "Question stem", topicTag: "Topic", subtopicTag: "Sub" }];
      }
      return out;
    },
  } as unknown as IStorage;
}

describe("buildStructuredFeedback — subject visibility gate", () => {
  it("returns every subject when no gate is supplied (student's own view)", async () => {
    const out = await buildStructuredFeedback(makeStorage(), "stu-1");
    expect(out.map((w) => w.subject).sort()).toEqual(["Mathematics", "Physics"]);
  });

  it("only returns feedback for allowed subjects (case-insensitive)", async () => {
    const out = await buildStructuredFeedback(makeStorage(), "stu-1", { allowedSubjects: ["mathematics"] });
    expect(out.map((w) => w.subject)).toEqual(["Mathematics"]);
  });

  it("returns nothing when the tutor has no assigned subjects for the student", async () => {
    const out = await buildStructuredFeedback(makeStorage(), "stu-1", { allowedSubjects: [] });
    expect(out).toEqual([]);
  });
});

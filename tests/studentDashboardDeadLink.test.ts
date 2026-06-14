/**
 * STUDENT DASHBOARD dead-link regression (SOMA-002).
 *
 * The quiz/questions endpoints 404 any archived or unpublished quiz, so an
 * assignment to such a quiz rendered a "/soma/quiz/:id" link that hung forever
 * on "Loading assessment…". `buildStudentDashboard` must not surface a
 * pending/overdue assignment whose quiz is not playable — while still keeping
 * COMPLETED assignments (reviewable via reportId) so score history and stats
 * survive a quiz being archived after the fact.
 */
import { describe, it, expect } from "vitest";

import { buildStudentDashboard, isPlayableQuiz } from "../server/services/studentDashboard";
import type { IStorage } from "../server/storage";
import type { SomaQuiz, SomaUser } from "../shared/schema";

describe("isPlayableQuiz", () => {
  const base = { isArchived: false, status: "published" } as Pick<SomaQuiz, "isArchived" | "status">;
  it("true only for a published, non-archived quiz", () => {
    expect(isPlayableQuiz(base)).toBe(true);
  });
  it("false for an archived quiz", () => {
    expect(isPlayableQuiz({ ...base, isArchived: true })).toBe(false);
  });
  it("false for an unpublished (draft) quiz", () => {
    expect(isPlayableQuiz({ ...base, status: "draft" })).toBe(false);
  });
  it("false for a missing quiz", () => {
    expect(isPlayableQuiz(null)).toBe(false);
    expect(isPlayableQuiz(undefined)).toBe(false);
  });
});

function quiz(id: number, status: string, isArchived: boolean): SomaQuiz {
  return {
    id,
    title: `Quiz ${id}`,
    subject: "Mathematics",
    level: "IGCSE",
    status,
    isArchived,
  } as unknown as SomaQuiz;
}

function assignment(id: number, quizId: number, status: string, q: SomaQuiz) {
  return {
    id,
    quizId,
    studentId: "stu-1",
    status,
    dueDate: status === "completed" ? null : new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
    quiz: q,
  } as any;
}

describe("buildStudentDashboard — dead-link suppression (SOMA-002)", () => {
  const student = { id: "stu-1", email: "stu@example.com", displayName: "Stu" } as SomaUser;

  // A: pending + playable quiz -> shown. B: pending + archived quiz -> hidden
  // (the dead link). C: completed + archived quiz -> kept (review history).
  const qA = quiz(1, "published", false);
  const qB = quiz(2, "published", true);   // archived
  const qC = quiz(3, "published", true);   // archived but completed
  const qD = quiz(4, "draft", false);      // unpublished, pending

  const fakeStorage = {
    getQuizAssignmentsForStudent: async () => [
      assignment(10, 1, "pending", qA),
      assignment(11, 2, "pending", qB),
      assignment(12, 3, "completed", qC),
      assignment(13, 4, "pending", qD),
    ],
    getSomaReportsByStudentId: async () => [
      { id: 99, quizId: 3, score: 5, status: "completed", createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), startedAt: null } as any,
    ],
    listStudentSubjects: async () => [],
    listStudentTopicMastery: async () => [],
    listStudentNotifications: async () => [],
    getSomaQuestionTotalsByQuizIds: async () => ({ 1: 10, 2: 10, 3: 10, 4: 10 }),
  } as unknown as IStorage;

  it("hides pending assignments to archived/unpublished quizzes but keeps playable and completed ones", async () => {
    const payload = await buildStudentDashboard({ storage: fakeStorage, student });
    const ids = payload.assignments.map((a) => a.quizId).sort();
    expect(ids).toEqual([1, 3]); // A (playable pending) + C (completed) only
    expect(ids).not.toContain(2); // archived pending dead link removed
    expect(ids).not.toContain(4); // draft pending dead link removed
  });

  it("keeps the completed archived quiz reviewable in the completed list", async () => {
    const payload = await buildStudentDashboard({ storage: fakeStorage, student });
    expect(payload.completed.map((a) => a.quizId)).toContain(3);
  });
});

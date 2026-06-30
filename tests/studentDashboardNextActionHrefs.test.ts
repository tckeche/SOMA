/**
 * STUDENT DASHBOARD next-action href regression (SOMA-DEADLINK-2).
 *
 * `buildNextActions` previously emitted hrefs to "/quiz/:id" and "/report/:id",
 * but the real wouter routes (client/src/App.tsx) are "/soma/quiz/:id" and
 * "/soma/review/:reportId". The dashboard renders these via <Link href={...}>,
 * so a student clicking "Catch up on…", "Today: …", "Tomorrow: …" or
 * "Revisit …" landed on the NotFound page — a broken core journey that the
 * existing dead-link test (which only checks assignment suppression) missed.
 *
 * These are the only valid student-facing destinations the dashboard links to.
 */
import { describe, it, expect } from "vitest";

import { buildStudentDashboard } from "../server/services/studentDashboard";
import type { IStorage } from "../server/storage";
import type { SomaQuiz, SomaUser } from "../shared/schema";

function quiz(id: number): SomaQuiz {
  return {
    id,
    title: `Quiz ${id}`,
    subject: "Mathematics",
    level: "IGCSE",
    status: "published",
    isArchived: false,
    questionCount: 10,
  } as unknown as SomaQuiz;
}

function assignment(id: number, quizId: number, status: string, dueOffsetDays: number, q: SomaQuiz) {
  return {
    id,
    quizId,
    studentId: "stu-1",
    status,
    dueDate: status === "completed" ? null : new Date(Date.now() + dueOffsetDays * 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
    quiz: q,
  } as any;
}

describe("buildStudentDashboard — next-action hrefs resolve to real routes", () => {
  const student = { id: "stu-1", email: "stu@example.com", displayName: "Stu" } as SomaUser;

  const fakeStorage = {
    // overdue (-2d), due today (0d), due tomorrow (+1d), and a completed low-score quiz to review.
    getQuizAssignmentsForStudent: async () => [
      assignment(10, 1, "pending", -2, quiz(1)),
      assignment(11, 2, "pending", 0, quiz(2)),
      assignment(12, 3, "pending", 1, quiz(3)),
      assignment(13, 4, "completed", 0, quiz(4)),
    ],
    getSomaReportsByStudentId: async () => [
      { id: 77, quizId: 4, score: 2, status: "completed", reviewRequested: false, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), startedAt: null } as any,
    ],
    listStudentSubjects: async () => [],
    listStudentTopicMastery: async () => [],
    listStudentNotifications: async () => [],
    getSomaQuestionTotalsByQuizIds: async () => ({ 1: 10, 2: 10, 3: 10, 4: 10 }),
  } as unknown as IStorage;

  it("every next-action href targets /soma/quiz/:id or /soma/review/:id", async () => {
    const payload = await buildStudentDashboard({ storage: fakeStorage, student });
    const hrefs = payload.nextActions.map((a) => a.href).filter((h): h is string => !!h);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/soma\/(quiz|review)\/\d+$/);
    }
  });

  it("never emits the legacy dead-link prefixes", async () => {
    const payload = await buildStudentDashboard({ storage: fakeStorage, student });
    for (const a of payload.nextActions) {
      if (!a.href) continue;
      expect(a.href.startsWith("/quiz/")).toBe(false);
      expect(a.href.startsWith("/report/")).toBe(false);
    }
  });
});

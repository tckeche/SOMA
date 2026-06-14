/**
 * REGRADE — storage/endpoint-level integration against MemoryStorage.
 *
 * Pins the two backend behaviours the tutor UI depends on:
 *  1. Excluding a question reports `affectedSubmissionCount` = number of COMPLETED
 *     reports whose stored answer for that question matched the (then) correct
 *     answer — i.e. submissions whose score will drop on regrade.
 *  2. A regrade pass updates `somaReports.score` for affected (completed) reports
 *     only, leaving pending/failed reports untouched.
 *
 * The route handlers are thin orchestration over storage + recomputeReportScore;
 * here we exercise that same orchestration directly against MemoryStorage.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { MemoryStorage } from "../server/storage";
import { recomputeReportScore } from "../server/services/regrade";
import { effectiveCorrectAnswer } from "../server/services/mathValidator";

let storage: MemoryStorage;
let quizId: number;
let q1: number;
let q2: number;

beforeEach(async () => {
  storage = new MemoryStorage();
  const quiz = await storage.createSomaQuiz({ title: "T", topic: "x", authorId: "tutor-1" } as any);
  quizId = quiz.id;
  const [a, b] = await storage.createSomaQuestions([
    { quizId, stem: "Q1", options: ["A", "B", "C", "D"], correctAnswer: "A", explanation: "", marks: 2 },
    { quizId, stem: "Q2", options: ["A", "B", "C", "D"], correctAnswer: "B", explanation: "", marks: 1 },
  ] as any);
  q1 = a.id;
  q2 = b.id;

  // r1: got Q1 right + Q2 right (score 3) — completed
  // r2: got Q1 wrong + Q2 right (score 1) — completed
  // r3: got Q1 right — but still pending (must NOT be touched)
  await storage.createSomaReport({ quizId, studentName: "Alice", score: 3, status: "completed", answersJson: { [q1]: "A", [q2]: "B" } } as any);
  await storage.createSomaReport({ quizId, studentName: "Bob", score: 1, status: "completed", answersJson: { [q1]: "C", [q2]: "B" } } as any);
  await storage.createSomaReport({ quizId, studentName: "Carol", score: 0, status: "pending", answersJson: { [q1]: "A", [q2]: "B" } } as any);
});

describe("exclude affectedSubmissionCount", () => {
  it("counts only completed reports whose stored answer matched the correct answer", async () => {
    const questions = await storage.getSomaQuestionsByQuizId(quizId);
    const target = questions.find((q) => q.id === q1)!;
    const correct = effectiveCorrectAnswer(target.stem, target.options as string[], target.correctAnswer);
    const reports = await storage.getSomaReportsByQuizId(quizId);
    const affected = reports.filter((r) => {
      if (r.status !== "completed") return false;
      const answers = (r.answersJson ?? {}) as Record<string, string>;
      return answers[String(q1)] === correct;
    }).length;
    // Alice matched (completed); Carol matched but is pending; Bob wrong.
    expect(affected).toBe(1);
  });

  it("persists reviewStatus 'excluded' so the question is no longer served", async () => {
    const updated = await storage.updateSomaQuestionReview(q1, { reviewStatus: "excluded" });
    expect(updated?.reviewStatus).toBe("excluded");
  });
});

describe("regrade updates score for affected completed reports only", () => {
  it("recomputes and persists new scores after excluding Q1", async () => {
    await storage.updateSomaQuestionReview(q1, { reviewStatus: "excluded" });
    const questions = await storage.getSomaQuestionsByQuizId(quizId);
    const reports = await storage.getSomaReportsByQuizId(quizId);

    let regraded = 0;
    let changed = 0;
    for (const report of reports) {
      if (report.status !== "completed") continue;
      regraded++;
      const { oldScore, newScore } = recomputeReportScore(report, questions);
      if (newScore !== oldScore) {
        changed++;
        await storage.updateSomaReport(report.id, { score: newScore });
      }
    }

    expect(regraded).toBe(2); // Alice + Bob; Carol (pending) skipped
    expect(changed).toBe(1); // only Alice drops (lost Q1's 2 marks)

    const after = await storage.getSomaReportsByQuizId(quizId);
    const alice = after.find((r) => r.studentName === "Alice")!;
    const bob = after.find((r) => r.studentName === "Bob")!;
    const carol = after.find((r) => r.studentName === "Carol")!;
    expect(alice.score).toBe(1); // was 3, Q1 excluded -> only Q2's 1 mark
    expect(bob.score).toBe(1); // unchanged (already only had Q2 right)
    expect(carol.score).toBe(0); // pending -> untouched
  });
});

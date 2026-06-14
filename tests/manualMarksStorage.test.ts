/**
 * MANUAL MARKS OVERRIDE — storage/endpoint-level integration against MemoryStorage.
 *
 * The route handler (POST /api/tutor/reports/:reportId/marks) is thin
 * orchestration over storage + recomputeReportScore: validate overrides against
 * the report's quiz questions, merge into existing manualMarks (null clears a
 * key), recompute the score honouring overrides, and persist BOTH manualMarks
 * and the new score. Here we exercise that same orchestration directly.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { MemoryStorage } from "../server/storage";
import { recomputeReportScore } from "../server/services/regrade";

let storage: MemoryStorage;
let quizId: number;
let q1: number;
let q2: number;
let reportId: number;

beforeEach(async () => {
  storage = new MemoryStorage();
  const quiz = await storage.createSomaQuiz({ title: "T", topic: "x", authorId: "tutor-1" } as any);
  quizId = quiz.id;
  const [a, b] = await storage.createSomaQuestions([
    { quizId, stem: "Q1", options: ["A", "B", "C", "D"], correctAnswer: "A", explanation: "", marks: 2 },
    { quizId, stem: "Q2", options: ["A", "B", "C", "D"], correctAnswer: "B", explanation: "", marks: 4 },
  ] as any);
  q1 = a.id;
  q2 = b.id;

  // Student got Q1 right (2) and Q2 wrong (0). Computed score = 2 of 6.
  const r = await storage.createSomaReport({
    quizId,
    studentName: "Alice",
    score: 2,
    status: "completed",
    answersJson: { [q1]: "A", [q2]: "X" },
  } as any);
  reportId = r.id;
});

// Replicates the route's validate -> merge -> recompute -> persist flow.
async function applyOverrides(overrides: Record<string, number | null>) {
  const report = await storage.getSomaReportById(reportId);
  if (!report) throw new Error("missing report");
  const questions = await storage.getSomaQuestionsByQuizId(report.quizId);
  const byId = new Map(questions.map((q) => [String(q.id), q]));

  for (const [qid, value] of Object.entries(overrides)) {
    const q = byId.get(qid);
    if (!q) throw new Error(`unknown:${qid}`);
    if (value === null) continue;
    if (!Number.isInteger(value) || value < 0 || value > q.marks) {
      throw new Error(`outofrange:${qid}`);
    }
  }

  const merged: Record<string, number> = { ...((report.manualMarks ?? {}) as Record<string, number>) };
  for (const [qid, value] of Object.entries(overrides)) {
    if (value === null) delete merged[qid];
    else merged[qid] = value;
  }
  const nextManualMarks = Object.keys(merged).length > 0 ? merged : null;

  const { newScore, maxPossibleScore } = recomputeReportScore(
    { ...report, manualMarks: nextManualMarks },
    questions,
  );
  await storage.updateSomaReport(reportId, { manualMarks: nextManualMarks, score: newScore });
  return { score: newScore, maxPossibleScore, manualMarks: nextManualMarks };
}

describe("manual marks override (storage-level)", () => {
  it("setting an override updates score and persists manualMarks", async () => {
    const res = await applyOverrides({ [q2]: 3 }); // award 3 of 4 on the wrong Q2
    expect(res.score).toBe(5); // Q1 computed 2 + Q2 override 3
    expect(res.maxPossibleScore).toBe(6);
    expect(res.manualMarks).toEqual({ [q2]: 3 });

    const after = await storage.getSomaReportById(reportId);
    expect(after!.score).toBe(5);
    expect(after!.manualMarks).toEqual({ [q2]: 3 });
  });

  it("clearing with null removes the key and reverts that question to computed", async () => {
    await applyOverrides({ [q1]: 0, [q2]: 4 }); // Q1->0, Q2->4 (full)
    let after = await storage.getSomaReportById(reportId);
    expect(after!.score).toBe(4); // 0 + 4
    expect(after!.manualMarks).toEqual({ [q1]: 0, [q2]: 4 });

    // Clear Q1 -> reverts to computed (Q1 right = 2); Q2 override stays.
    const res = await applyOverrides({ [q1]: null });
    expect(res.manualMarks).toEqual({ [q2]: 4 });
    expect(res.score).toBe(6); // computed Q1(2) + override Q2(4)

    // Clear the last override -> manualMarks becomes null, score is pure computed.
    const res2 = await applyOverrides({ [q2]: null });
    expect(res2.manualMarks).toBeNull();
    expect(res2.score).toBe(2);
    after = await storage.getSomaReportById(reportId);
    expect(after!.manualMarks).toBeNull();
    expect(after!.score).toBe(2);
  });

  it("rejects marks greater than q.marks", async () => {
    await expect(applyOverrides({ [q2]: 5 })).rejects.toThrow(/outofrange/); // Q2 max is 4
  });

  it("rejects an unknown questionId", async () => {
    await expect(applyOverrides({ "99999": 1 })).rejects.toThrow(/unknown/);
  });
});

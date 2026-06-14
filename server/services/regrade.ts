import type { SomaQuestion, SomaReport } from "@shared/schema";
import { effectiveCorrectAnswer } from "./mathValidator";
import { isServableToStudent } from "./questionQuality";

export interface RecomputeResult {
  oldScore: number;
  newScore: number;
  maxPossibleScore: number;
}

/**
 * Pure recompute of a report's score from stored data only (NO AI).
 *
 * For each SERVED question (per `isServableToStudent`), award `q.marks` when the
 * student's stored answer equals `effectiveCorrectAnswer(q...)` — the exact same
 * marking function used at submission time, so regrade can never diverge from
 * the original grading. Excluded/blocked/needs_review questions are dropped from
 * BOTH the numerator and the denominator (maxPossibleScore).
 */
export function recomputeReportScore(
  report: Pick<SomaReport, "score" | "answersJson">,
  questions: SomaQuestion[],
): RecomputeResult {
  const answers = (report.answersJson ?? {}) as Record<string, string>;
  let newScore = 0;
  let maxPossibleScore = 0;

  for (const q of questions) {
    if (!isServableToStudent(q)) continue;
    maxPossibleScore += q.marks;
    const correct = effectiveCorrectAnswer(q.stem, q.options as string[], q.correctAnswer);
    if (answers[String(q.id)] === correct) {
      newScore += q.marks;
    }
  }

  return { oldScore: report.score, newScore, maxPossibleScore };
}

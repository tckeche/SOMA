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
 *
 * Tutor manual overrides: when `report.manualMarks` has an entry for a served
 * question, that awarded value (clamped to `0..q.marks`) wins over the computed
 * marks. This lets a tutor award partial credit or fix a mis-mark without the
 * regrade engine clobbering it. Overrides on non-served questions are ignored.
 * `maxPossibleScore` is unaffected by overrides — it stays the sum of served
 * `q.marks`.
 */
export function recomputeReportScore(
  report: Pick<SomaReport, "score" | "answersJson" | "manualMarks">,
  questions: SomaQuestion[],
): RecomputeResult {
  const answers = (report.answersJson ?? {}) as Record<string, string>;
  const manualMarks = (report.manualMarks ?? undefined) as
    | Record<string, number>
    | undefined;
  let newScore = 0;
  let maxPossibleScore = 0;

  for (const q of questions) {
    if (!isServableToStudent(q)) continue;
    maxPossibleScore += q.marks;
    const correct = effectiveCorrectAnswer(q.stem, q.options as string[], q.correctAnswer);
    const computed = answers[String(q.id)] === correct ? q.marks : 0;
    const override = manualMarks?.[String(q.id)];
    const awarded =
      override === undefined || override === null
        ? computed
        : Math.max(0, Math.min(q.marks, Math.trunc(override)));
    newScore += awarded;
  }

  return { oldScore: report.score, newScore, maxPossibleScore };
}

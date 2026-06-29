import type { SomaQuestion, SomaReport } from "@shared/schema";
import { answersMatch, effectiveCorrectAnswer } from "./mathValidator";
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
  report: Pick<SomaReport, "score" | "answersJson"> & { structuredMarking?: SomaReport["structuredMarking"] },
  questions: SomaQuestion[],
): RecomputeResult {
  const answers = (report.answersJson ?? {}) as Record<string, string>;
  const marking = (report.structuredMarking ?? {}) as Record<
    string,
    { aiMarks?: number; tutorMarks?: number | null; maxMarks?: number }
  >;
  let newScore = 0;
  let maxPossibleScore = 0;

  for (const q of questions) {
    if (!isServableToStudent(q)) continue;

    if (q.questionType === "structured") {
      // Written answers are marked separately (AI mark, optionally overridden by
      // a tutor) and stored in report.structuredMarking — NOT by MCQ matching.
      // Preserve those marks here; matching the essay against an (empty) MCQ key
      // would score every structured answer as wrong and zero out real marks.
      const m = marking[String(q.id)];
      maxPossibleScore += m?.maxMarks ?? q.marks;
      newScore += m ? (m.tutorMarks ?? m.aiMarks ?? 0) : 0;
      continue;
    }

    maxPossibleScore += q.marks;
    const correct = effectiveCorrectAnswer(q.stem, q.options as string[], q.correctAnswer);
    if (answersMatch(answers[String(q.id)], correct)) {
      newScore += q.marks;
    }
  }

  return { oldScore: report.score, newScore, maxPossibleScore };
}

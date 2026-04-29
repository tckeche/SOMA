/**
 * Read-side helper: fetch per-question diagnoses for a report, joined
 * with the matched examiner misconception so the student review UI can
 * cite the examiner verbatim.
 *
 * Returns a map keyed by questionId so the frontend can render inline
 * with each question without scanning the whole array.
 */
import { db } from "../db";
import { answerDiagnoses, examinerMisconceptions } from "@shared/schema";
import { eq } from "drizzle-orm";

export interface QuestionDiagnosis {
  category: string;
  correct: boolean;
  rationale: string | null;
  misconception: {
    id: number;
    misconception: string;
    studentError: string;
    correctApproach: string;
    frequency: string;
    sourceQuote: string | null;
    sourcePage: number | null;
  } | null;
}

export async function getDiagnosesForReport(reportId: number): Promise<Record<number, QuestionDiagnosis>> {
  if (!db) return {};

  const rows = await db
    .select({
      questionId: answerDiagnoses.questionId,
      category: answerDiagnoses.diagnosisCategory,
      correct: answerDiagnoses.correct,
      rationale: answerDiagnoses.rationale,
      misconceptionId: examinerMisconceptions.id,
      misconception: examinerMisconceptions.misconception,
      studentError: examinerMisconceptions.studentError,
      correctApproach: examinerMisconceptions.correctApproach,
      frequency: examinerMisconceptions.frequency,
      sourceQuote: examinerMisconceptions.sourceQuote,
      sourcePage: examinerMisconceptions.sourcePage,
    })
    .from(answerDiagnoses)
    .leftJoin(examinerMisconceptions, eq(examinerMisconceptions.id, answerDiagnoses.misconceptionId))
    .where(eq(answerDiagnoses.reportId, reportId));

  const out: Record<number, QuestionDiagnosis> = {};
  for (const r of rows) {
    out[r.questionId] = {
      category: r.category ?? "",
      correct: !!r.correct,
      rationale: r.rationale ?? null,
      misconception: r.misconceptionId
        ? {
            id: r.misconceptionId,
            misconception: r.misconception ?? "",
            studentError: r.studentError ?? "",
            correctApproach: r.correctApproach ?? "",
            frequency: r.frequency ?? "common",
            sourceQuote: r.sourceQuote ?? null,
            sourcePage: r.sourcePage ?? null,
          }
        : null,
    };
  }
  return out;
}

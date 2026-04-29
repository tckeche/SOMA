/**
 * Phase 2C — examiner-style marking & diagnosis.
 *
 * After the student submits a quiz, for each wrong answer we try to match
 * the chosen distractor against the question's seeded examiner
 * misconceptions (target_misconception_ids). When we find a match, we:
 *
 *   1. Write an `answer_diagnoses` row pointing at the matched
 *      misconception so feedback can cite the examiner's exact phrasing.
 *   2. Bump `student_misconceptions` for that (student, misconception)
 *      pair so the per-student timeline keeps growing.
 *
 * Matching strategy (deterministic, no LLM):
 *   - Jaccard similarity on token sets between the student's chosen
 *     distractor text and each candidate misconception's `studentError`
 *     (and `misconception` text as a tie-breaker). Threshold: 0.25 — low
 *     enough to catch paraphrases, high enough to avoid false positives
 *     on completely unrelated text.
 *   - When several candidates match, we pick the highest similarity.
 *
 * For wrong answers with NO matched misconception, we still write an
 * `answer_diagnoses` row with `misconceptionId: null` and a generic
 * category so we can later analyse "we have no diagnosis for X% of
 * wrong answers — extend the misconception library."
 */
import { db } from "../db";
import {
  answerDiagnoses,
  examinerMisconceptions,
  studentMisconceptions,
  type AnswerDiagnosis,
  type ExaminerMisconception,
} from "@shared/schema";
import { eq, inArray, sql } from "drizzle-orm";

export interface GradedAnswer {
  questionId: number;
  /** Raw student-supplied option text. */
  studentAnswer: string;
  /** Effective correct answer (already canonicalised). */
  correctAnswer: string;
  /** Question targets these misconception ids (from the seeded batch). */
  targetMisconceptionIds: number[];
}

export interface DiagnosisRow {
  questionId: number;
  studentAnswer: string;
  correct: boolean;
  matchedMisconception: ExaminerMisconception | null;
  category: "correct" | "matched_misconception" | "unmatched_wrong" | "skipped";
  rationale: string | null;
}

const STOP_WORDS = new Set([
  "the","a","an","of","and","or","to","is","in","on","for","with","by","at","as","be","that","this","it","its","than","then","into","from","not","do","does","did","so","if","but","who","which","what","when","where","why","how","are","was","were","has","have","had","can","could","would","should","may","might","will","shall","be","being","been","i","you","he","she","they","we","them","us","his","her","their","our","your",
]);

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\$\$?[^$]*\$\$?/g, " ") // strip latex
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  Array.from(a).forEach((tok) => { if (b.has(tok)) inter++; });
  const uni = a.size + b.size - inter;
  return uni > 0 ? inter / uni : 0;
}

const MIN_SIMILARITY = 0.25;

function pickBestMatch(
  chosen: string,
  candidates: ExaminerMisconception[],
): { row: ExaminerMisconception; score: number } | null {
  if (!candidates.length) return null;
  const chosenTokens = tokenise(chosen);
  if (chosenTokens.size === 0) return null;
  let best: { row: ExaminerMisconception; score: number } | null = null;
  for (const cand of candidates) {
    const errTokens = tokenise(cand.studentError ?? "");
    const miscTokens = tokenise(cand.misconception ?? "");
    const score = Math.max(jaccard(chosenTokens, errTokens), jaccard(chosenTokens, miscTokens) * 0.8);
    if (score >= MIN_SIMILARITY && (!best || score > best.score)) {
      best = { row: cand, score };
    }
  }
  return best;
}

export interface BuildDiagnosesInput {
  reportId: number;
  studentId: string;
  answers: GradedAnswer[];
}

export interface BuildDiagnosesResult {
  diagnoses: DiagnosisRow[];
  matchedCount: number;
  wrongCount: number;
}

/**
 * Compute, persist, and roll up diagnoses for a freshly-graded report.
 * Returns the diagnoses (with matched misconception details inlined) so
 * the caller can fold them into the AI feedback prompt.
 */
export async function buildAndPersistDiagnoses(
  input: BuildDiagnosesInput,
): Promise<BuildDiagnosesResult> {
  const result: BuildDiagnosesResult = { diagnoses: [], matchedCount: 0, wrongCount: 0 };
  if (!db) return result;

  // Collect all candidate misconception ids across the report so we
  // fetch the rows in a single query.
  const allIds = Array.from(
    new Set(input.answers.flatMap((a) => a.targetMisconceptionIds || [])),
  ).filter((id) => Number.isInteger(id) && id > 0);

  const candidatesById = new Map<number, ExaminerMisconception>();
  if (allIds.length > 0) {
    const rows = await db
      .select()
      .from(examinerMisconceptions)
      .where(inArray(examinerMisconceptions.id, allIds));
    for (const r of rows) candidatesById.set(r.id, r);
  }

  for (const answer of input.answers) {
    const correct = (answer.studentAnswer || "").trim().length > 0
      && answer.studentAnswer.trim() === (answer.correctAnswer ?? "").trim();
    const skipped = !answer.studentAnswer || !answer.studentAnswer.trim();

    if (correct) {
      result.diagnoses.push({
        questionId: answer.questionId,
        studentAnswer: answer.studentAnswer,
        correct: true,
        matchedMisconception: null,
        category: "correct",
        rationale: null,
      });
      continue;
    }

    if (skipped) {
      result.wrongCount++;
      result.diagnoses.push({
        questionId: answer.questionId,
        studentAnswer: "",
        correct: false,
        matchedMisconception: null,
        category: "skipped",
        rationale: "Student left this question blank.",
      });
      continue;
    }

    result.wrongCount++;
    const candidates = (answer.targetMisconceptionIds || [])
      .map((id) => candidatesById.get(id))
      .filter((r): r is ExaminerMisconception => Boolean(r));
    const match = pickBestMatch(answer.studentAnswer, candidates);

    if (match) {
      result.matchedCount++;
      result.diagnoses.push({
        questionId: answer.questionId,
        studentAnswer: answer.studentAnswer,
        correct: false,
        matchedMisconception: match.row,
        category: "matched_misconception",
        rationale: `Matched "${match.row.misconception}" (similarity ${(match.score * 100).toFixed(0)}%).`,
      });
    } else {
      result.diagnoses.push({
        questionId: answer.questionId,
        studentAnswer: answer.studentAnswer,
        correct: false,
        matchedMisconception: null,
        category: "unmatched_wrong",
        rationale: null,
      });
    }
  }

  // Persist answer_diagnoses (idempotent: unique on (reportId, questionId)
  // — re-running grading replaces rows).
  for (const d of result.diagnoses) {
    const idx = (() => {
      // Numeric index of chosen option requires looking it up from the
      // question — we don't have it here without another fetch. Leave
      // null for now; Phase 4 can include it when we wire structured
      // option lists through.
      return null;
    })();
    await db
      .insert(answerDiagnoses)
      .values({
        reportId: input.reportId,
        questionId: d.questionId,
        studentId: input.studentId,
        chosenOptionIndex: idx,
        chosenOptionText: d.studentAnswer || null,
        correct: d.correct,
        misconceptionId: d.matchedMisconception?.id ?? null,
        diagnosisCategory: d.category,
        rationale: d.rationale,
      })
      .onConflictDoUpdate({
        target: [answerDiagnoses.reportId, answerDiagnoses.questionId],
        set: {
          chosenOptionText: d.studentAnswer || null,
          correct: d.correct,
          misconceptionId: d.matchedMisconception?.id ?? null,
          diagnosisCategory: d.category,
          rationale: d.rationale,
        },
      });
  }

  // Roll up student_misconceptions: bump evidence for triggered ones,
  // bump consecutive_correct on the others (matched-but-now-correct
  // would resolve them; we keep that logic simple here).
  const triggeredMisconceptionIds = result.diagnoses
    .filter((d) => d.category === "matched_misconception" && d.matchedMisconception)
    .map((d) => d.matchedMisconception!.id);

  for (const misId of triggeredMisconceptionIds) {
    await db
      .insert(studentMisconceptions)
      .values({
        studentId: input.studentId,
        misconceptionId: misId,
        evidenceCount: 1,
        consecutiveCorrect: 0,
        lastReportId: input.reportId,
      })
      .onConflictDoUpdate({
        target: [studentMisconceptions.studentId, studentMisconceptions.misconceptionId],
        set: {
          evidenceCount: sql`${studentMisconceptions.evidenceCount} + 1`,
          consecutiveCorrect: 0,
          lastSeenAt: new Date(),
          lastReportId: input.reportId,
          updatedAt: new Date(),
        },
      });
  }

  // For correct answers on questions targeting any misconception the
  // student already has on file, bump their consecutive_correct counter
  // and resolve once it hits 3 in a row.
  const correctTargetedIds = new Set(
    result.diagnoses
      .filter((d) => d.correct)
      .flatMap((d) => {
        const ans = input.answers.find((a) => a.questionId === d.questionId);
        return ans?.targetMisconceptionIds ?? [];
      }),
  );
  if (correctTargetedIds.size > 0) {
    const ids = Array.from(correctTargetedIds);
    const rows = await db
      .select()
      .from(studentMisconceptions)
      .where(eq(studentMisconceptions.studentId, input.studentId));
    for (const row of rows) {
      if (!ids.includes(row.misconceptionId)) continue;
      const next = (row.consecutiveCorrect ?? 0) + 1;
      const resolved = next >= 3 && row.resolvedAt === null;
      await db
        .update(studentMisconceptions)
        .set({
          consecutiveCorrect: next,
          resolvedAt: resolved ? new Date() : row.resolvedAt,
          updatedAt: new Date(),
        })
        .where(eq(studentMisconceptions.id, row.id));
    }
  }

  return result;
}

/**
 * Render the diagnosis context the AI grader receives so its feedback
 * cites the matched examiner phrasing.
 */
export function renderDiagnosesForFeedback(diagnoses: DiagnosisRow[]): string {
  const matched = diagnoses.filter((d) => d.category === "matched_misconception" && d.matchedMisconception);
  if (matched.length === 0) return "";
  const lines = matched.map((d, i) => {
    const m = d.matchedMisconception!;
    return [
      `${i + 1}. Question ${d.questionId}: student picked "${d.studentAnswer}".`,
      `   Examiner-flagged misconception: ${m.misconception}`,
      `   Typical wrong working: ${m.studentError || "—"}`,
      `   Correct approach: ${m.correctApproach || "—"}`,
      m.sourceQuote ? `   Examiner quote: "${m.sourceQuote}"` : "",
    ].filter(Boolean).join("\n");
  });
  return [
    "",
    "Examiner-flagged misconceptions detected in this submission. When you mention these questions in your feedback, cite the misconception explicitly so the student understands the EXACT thinking error:",
    ...lines,
  ].join("\n");
}

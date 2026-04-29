/**
 * Phase 2B — fetch approved examiner-misconception seeds for question
 * generation.
 *
 * Given a set of catalogue subtopic ids (and/or a (board, syllabusCode)
 * fallback), return the top-K approved misconceptions to feed into the
 * maker prompt as required distractor seeds.
 *
 * "Approved" here is non-negotiable: pending and rejected rows must
 * never reach a generated question.
 */
import { db } from "../db";
import { examinerMisconceptions } from "@shared/schema";
import { and, desc, eq, inArray } from "drizzle-orm";

export interface ExaminerSeed {
  id: number;
  topic: string;
  subtopic: string | null;
  misconception: string;
  studentError: string;
  correctApproach: string;
  frequency: string;
  sourceQuote: string | null;
  sourcePage: number | null;
}

const FREQUENCY_RANK: Record<string, number> = {
  very_common: 3,
  common: 2,
  occasional: 1,
};

export interface SeedQuery {
  /** Catalogue subtopic ids the question batch is targeting. */
  subtopicIds?: number[];
  /** Fallback when subtopic FK linkage isn't available — match by
   *  exam board + syllabus code. */
  board?: string;
  syllabusCode?: string;
  /** Max seeds to return. Defaults to 6 — large enough that distractors
   *  can plausibly be drawn from one each, small enough to keep the
   *  prompt focused. */
  limit?: number;
}

export async function listApprovedSeeds(q: SeedQuery): Promise<ExaminerSeed[]> {
  if (!db) return [];
  const limit = Math.max(1, Math.min(20, q.limit ?? 6));

  const conditions = [eq(examinerMisconceptions.status, "approved")];
  const subtopicIds = (q.subtopicIds ?? []).filter((n) => Number.isFinite(n) && n > 0);
  if (subtopicIds.length > 0) {
    conditions.push(inArray(examinerMisconceptions.subtopicId, subtopicIds));
  } else {
    if (q.board) conditions.push(eq(examinerMisconceptions.board, q.board));
    if (q.syllabusCode) conditions.push(eq(examinerMisconceptions.syllabusCode, q.syllabusCode));
  }

  const rows = await db
    .select({
      id: examinerMisconceptions.id,
      topic: examinerMisconceptions.topic,
      subtopic: examinerMisconceptions.subtopic,
      misconception: examinerMisconceptions.misconception,
      studentError: examinerMisconceptions.studentError,
      correctApproach: examinerMisconceptions.correctApproach,
      frequency: examinerMisconceptions.frequency,
      sourceQuote: examinerMisconceptions.sourceQuote,
      sourcePage: examinerMisconceptions.sourcePage,
      confidence: examinerMisconceptions.confidence,
    })
    .from(examinerMisconceptions)
    .where(and(...conditions))
    .orderBy(desc(examinerMisconceptions.extractedAt));

  // Rank: very_common > common > occasional, then by confidence desc.
  const ranked = rows
    .map((r) => ({
      ...r,
      rank: (FREQUENCY_RANK[r.frequency] ?? 1) * 100 + (r.confidence ?? 0),
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);

  return ranked.map((r) => ({
    id: r.id,
    topic: r.topic,
    subtopic: r.subtopic,
    misconception: r.misconception,
    studentError: r.studentError,
    correctApproach: r.correctApproach,
    frequency: r.frequency,
    sourceQuote: r.sourceQuote,
    sourcePage: r.sourcePage,
  }));
}

/**
 * Render seeds as a numbered prompt block. Used by the maker prompt and
 * the marking layer (when explaining a wrong answer).
 */
export function renderSeedsForPrompt(seeds: ExaminerSeed[]): string {
  if (!seeds || seeds.length === 0) return "";
  const lines = seeds.map((s, i) =>
    [
      `${i + 1}. (${s.frequency}) ${s.misconception}`,
      `   Typical wrong working: ${s.studentError || "—"}`,
      `   Correct approach: ${s.correctApproach || "—"}`,
    ].join("\n"),
  );
  return [
    "Examiner-flagged misconceptions for this topic. Treat these as known student errors:",
    ...lines,
    "",
    "When writing distractors:",
    "- Where it fits the syllabus question, base at least one distractor per question on a misconception above so the wrong answer matches a known student error verbatim.",
    "- Do not invent misconceptions that aren't in the list.",
    "- Distractors should be plausible to a student who genuinely holds the misconception.",
  ].join("\n");
}

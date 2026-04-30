/**
 * Service: catalogue subtopic resolver.
 *
 * Best-effort lookup that maps a free-text (subject, topic, subtopic) tuple
 * onto a canonical `subtopics.id`. Used by:
 *   - the AI examiner-misconception extractor at insert time, so freshly
 *     extracted rows already carry the FK and the queue join hydrates
 *     `subtopicTitle` immediately, and
 *   - the one-shot `scripts/backfillCatalogueFks.ts` script that walks
 *     legacy rows whose `subtopic_id` was never populated.
 *
 * Matching strategy
 * ─────────────────
 * 1. Scope candidate subtopics by `(syllabusCode)`. When a `subject` is
 *    supplied we additionally `ilike`-match on `subjects.name`, which
 *    stops a lookup like ("Chemistry", "Atoms", "Atomic structure") from
 *    accidentally hitting the Physics syllabus that shares a topic
 *    title.
 * 2. Prefer exact (case-insensitive) match on `subtopics.title`. A
 *    single hit returns the id; multiple hits across different syllabi
 *    are reported as `ambiguous` and the caller leaves the row alone.
 * 3. Fall back to matching `topics.title` and pick the canonical
 *    sortOrder=1 subtopic of that topic. Helps when only the topic
 *    name was stored on the legacy row.
 *
 * Returning `ambiguous` rather than guessing keeps the backfill safe:
 * the script logs the count and humans can sweep the residue manually.
 */
import { and, eq, ilike, inArray } from "drizzle-orm";
import { db } from "../db";
import { subjects, subtopics, syllabi, topics } from "@shared/schema";

export interface ResolveSubtopicArgs {
  subject: string | null;
  topic: string | null;
  subtopic: string | null;
  /** Pre-resolved candidate syllabus ids. When omitted, the helper
   *  resolves them from `syllabusCode` (and optional `board`). */
  candidateSyllabusIds?: number[];
  /** When `candidateSyllabusIds` is omitted, used to derive the scope. */
  syllabusCode?: string | null;
}

export interface ResolveSubtopicResult {
  subtopicId: number | null;
  ambiguous: boolean;
}

/**
 * Resolve candidate syllabus ids for a `(syllabusCode)` pair. Returns an
 * empty list when nothing matches (the caller then falls back to an
 * un-scoped lookup which is more permissive but rarely needed).
 */
export async function resolveSyllabusIdsForCode(syllabusCode: string | null | undefined): Promise<number[]> {
  if (!db) return [];
  const code = (syllabusCode ?? "").trim();
  if (!code) return [];
  const rows = await db
    .select({ id: syllabi.id })
    .from(syllabi)
    .where(eq(syllabi.syllabusCode, code));
  return rows.map((r) => r.id);
}

export async function resolveSubtopicId(args: ResolveSubtopicArgs): Promise<ResolveSubtopicResult> {
  if (!db) return { subtopicId: null, ambiguous: false };

  const subjectName = (args.subject ?? "").trim();
  const subtopicTitle = (args.subtopic ?? "").trim();
  const topicTitle = (args.topic ?? "").trim();
  if (!subtopicTitle && !topicTitle) return { subtopicId: null, ambiguous: false };

  const candidateSyllabusIds =
    args.candidateSyllabusIds ?? (await resolveSyllabusIdsForCode(args.syllabusCode));

  const conditions = [] as ReturnType<typeof eq>[];
  if (subjectName) conditions.push(ilike(subjects.name, subjectName));
  if (candidateSyllabusIds.length > 0) {
    conditions.push(inArray(syllabi.id, candidateSyllabusIds));
  }

  const titleMatch = subtopicTitle || topicTitle;

  const baseRows = await db
    .select({ subtopicId: subtopics.id })
    .from(subtopics)
    .innerJoin(topics, eq(topics.id, subtopics.topicId))
    .innerJoin(syllabi, eq(syllabi.id, topics.syllabusId))
    .innerJoin(subjects, eq(subjects.id, syllabi.subjectId))
    .where(and(ilike(subtopics.title, titleMatch), ...conditions));

  if (baseRows.length === 1) return { subtopicId: baseRows[0].subtopicId, ambiguous: false };
  if (baseRows.length > 1) return { subtopicId: null, ambiguous: true };

  if (topicTitle) {
    const fallback = await db
      .select({ subtopicId: subtopics.id, sortOrder: subtopics.sortOrder })
      .from(subtopics)
      .innerJoin(topics, eq(topics.id, subtopics.topicId))
      .innerJoin(syllabi, eq(syllabi.id, topics.syllabusId))
      .innerJoin(subjects, eq(subjects.id, syllabi.subjectId))
      .where(and(ilike(topics.title, topicTitle), ...conditions))
      .orderBy(subtopics.sortOrder)
      .limit(2);
    if (fallback.length === 1) return { subtopicId: fallback[0].subtopicId, ambiguous: false };
    if (fallback.length > 1) return { subtopicId: fallback[0].subtopicId, ambiguous: false };
  }
  return { subtopicId: null, ambiguous: false };
}

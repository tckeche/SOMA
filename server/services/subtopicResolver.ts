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
 * 4. If both exact passes miss, run a `pg_trgm` similarity fallback
 *    against subtopics.title and topics.title. This catches drift like
 *    examiner "Stoichiometry & moles" vs catalogue "Stoichiometry".
 *    Threshold 0.45 with a 0.15 ambiguity gap to runner-up: a clear
 *    winner is taken, near-ties are reported `ambiguous` so a human
 *    sweeps them. Failures (e.g. pg_trgm not installed) degrade to
 *    "no match" silently — they never throw to the caller.
 *
 * Returning `ambiguous` rather than guessing keeps the backfill safe:
 * the script logs the count and humans can sweep the residue manually.
 */
import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { subjects, subtopics, syllabi, topics } from "@shared/schema";

/** Trigram similarity threshold for the fuzzy fallback. Empirical:
 *  "Stoichiometry & moles" vs "Stoichiometry" ≈ 0.70,
 *  "Algebra basics" vs "Algebra" ≈ 0.53,
 *  "Atomic Structure" vs "Atoms and Atomic Structure" ≈ 0.77. */
const FUZZY_MIN_SIM = 0.45;

/** Required gap between top match and runner-up before we commit. */
const FUZZY_AMBIGUITY_GAP = 0.15;

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

  // ── Fuzzy fallback (Phase 15) ────────────────────────────────────────────
  // Both exact passes missed. Use pg_trgm similarity against subtopics.title
  // and topics.title to catch examiner drift ("Stoichiometry & moles" →
  // "Stoichiometry"). Subject + syllabus scoping (already in `conditions`)
  // still applies, so a Chemistry query never grabs a Physics topic.
  try {
    const fuzzyRows = await db
      .select({
        subtopicId: subtopics.id,
        sim: sql<number>`GREATEST(
          similarity(LOWER(${subtopics.title}), LOWER(${titleMatch})),
          similarity(LOWER(${topics.title}), LOWER(${titleMatch}))
        )`,
      })
      .from(subtopics)
      .innerJoin(topics, eq(topics.id, subtopics.topicId))
      .innerJoin(syllabi, eq(syllabi.id, topics.syllabusId))
      .innerJoin(subjects, eq(subjects.id, syllabi.subjectId))
      .where(
        and(
          sql`(similarity(LOWER(${subtopics.title}), LOWER(${titleMatch})) >= ${FUZZY_MIN_SIM}
               OR similarity(LOWER(${topics.title}), LOWER(${titleMatch})) >= ${FUZZY_MIN_SIM})`,
          ...conditions,
        ),
      )
      .orderBy(
        sql`GREATEST(
          similarity(LOWER(${subtopics.title}), LOWER(${titleMatch})),
          similarity(LOWER(${topics.title}), LOWER(${titleMatch}))
        ) DESC`,
        // Deterministic tie-breaker: subtopics.id is unique and stable across
        // runs, so two near-identical similarity scores will always rank in
        // the same order. (Earlier this used sortOrder, which collides for
        // subtopics belonging to different topics and made the "first vs
        // second" comparison flap between runs.)
        subtopics.id,
      )
      .limit(2);

    if (fuzzyRows.length === 0) return { subtopicId: null, ambiguous: false };
    if (fuzzyRows.length === 1) {
      return { subtopicId: fuzzyRows[0].subtopicId, ambiguous: false };
    }
    const [first, second] = fuzzyRows;
    const firstSim = Number(first.sim ?? 0);
    const secondSim = Number(second.sim ?? 0);
    if (firstSim - secondSim >= FUZZY_AMBIGUITY_GAP) {
      return { subtopicId: first.subtopicId, ambiguous: false };
    }
    return { subtopicId: null, ambiguous: true };
  } catch (err: any) {
    // Most likely cause: pg_trgm extension not installed on this database.
    // Degrade silently — the row simply stays unmatched. The backfill
    // script logs the residue so a sweep can be planned.
    console.warn(
      `[subtopicResolver] fuzzy fallback unavailable: ${err?.message ?? err}`,
    );
    return { subtopicId: null, ambiguous: false };
  }
}

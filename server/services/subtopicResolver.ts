/**
 * Service: catalogue subtopic resolver.
 *
 * Best-effort lookup that maps a free-text (subject, topic, subtopic) tuple
 * onto a canonical `subtopics.id`. Used by:
 *   - the AI examiner-misconception extractor at insert time, so freshly
 *     extracted rows already carry the FK and the queue join hydrates
 *     `subtopicTitle` immediately,
 *   - the AI examiner-insights review path, and
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
 *    single hit returns the id; multiple hits within the same scope can
 *    often be disambiguated by the supplied topic title (e.g.
 *    "Algorithms" appears twice in CS 9618 under different topics) —
 *    otherwise reported as `ambiguous` and the caller leaves the row
 *    alone.
 * 3. Fall back to matching `topics.title` and pick the canonical
 *    sortOrder=1 subtopic of that topic. Helps when only the topic
 *    name was stored on the legacy row.
 * 4. If both exact passes miss with the **raw** caller-supplied strings,
 *    re-run the same exact passes against the **normalised** versions
 *    (see `questionTagNormalizer.ts`). The normaliser is destructive on
 *    composite legacy tags ("Foo, Bar" → "Bar"), so we deliberately try
 *    the raw catalogue-shaped string first — that way clean inputs like
 *    "Motion, forces and energy" still resolve via the catalogue's
 *    literal topic title.
 * 5. If everything above misses, run a `pg_trgm` similarity fallback
 *    against subtopics.title and topics.title using the normalised
 *    strings. Threshold 0.45 with a 0.15 ambiguity gap to runner-up: a
 *    clear winner is taken, near-ties are reported `ambiguous` so a
 *    human sweeps them. Failures (e.g. pg_trgm not installed) degrade
 *    to "no match" silently — they never throw to the caller.
 *
 * Returning `ambiguous` rather than guessing keeps the backfill safe:
 * the script logs the count and humans can sweep the residue manually.
 */
import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { subjects, subtopics, syllabi, topics } from "@shared/schema";
import { normalizeQuestionTag } from "./questionTagNormalizer";

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

/** Internal sentinel: an exact-pass attempt may "miss" (return no rows
 *  and no flag) — we want to retry with the normalised strings before
 *  reporting that to the caller. `ambiguous` propagates immediately. */
type ExactOutcome =
  | { kind: "hit"; subtopicId: number }
  | { kind: "ambiguous" }
  | { kind: "miss" };

/**
 * Resolve candidate syllabus ids for a `(syllabusCode)` pair. Returns an
 * empty list when nothing matches (the caller then falls back to an
 * un-scoped lookup which is more permissive but rarely needed).
 */
export interface CatalogueLabel {
  topicTitle: string;
  subtopicTitle: string;
}

/**
 * Batch-resolve the canonical catalogue titles for a set of subtopic ids.
 *
 * This is the authoritative source for human-readable topic/subtopic names
 * when a row already carries the `subtopicId` FK (e.g. `soma_questions`,
 * `student_topic_mastery`). It is the reverse of {@link resolveSubtopicId}:
 * given the FK, return the real `topics.title` / `subtopics.title` so callers
 * never have to fall back to the free-text tag (which can be a bare number).
 *
 * Single query, deduped — safe to call once per request batch (no N+1).
 * Returns an empty map when db is unavailable or no ids resolve.
 */
export async function resolveCatalogueLabelsForSubtopicIds(
  subtopicIds: Array<number | null | undefined>,
): Promise<Map<number, CatalogueLabel>> {
  const out = new Map<number, CatalogueLabel>();
  if (!db) return out;
  const uniq = Array.from(
    new Set(subtopicIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0)),
  );
  if (uniq.length === 0) return out;
  const rows = await db
    .select({
      subtopicId: subtopics.id,
      subtopicTitle: subtopics.title,
      topicTitle: topics.title,
    })
    .from(subtopics)
    .innerJoin(topics, eq(topics.id, subtopics.topicId))
    .where(inArray(subtopics.id, uniq));
  for (const r of rows) {
    out.set(r.subtopicId, { topicTitle: r.topicTitle, subtopicTitle: r.subtopicTitle });
  }
  return out;
}

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

/**
 * One pass of the exact-match logic against a specific (topicTitle,
 * subtopicTitle) shape. Pulled into a helper so we can run it twice —
 * first with the raw caller strings (preserves clean catalogue titles)
 * and then with the legacy-tag-normalised strings (rescues noisy rows).
 */
async function exactLookup(
  topicTitle: string,
  subtopicTitle: string,
  conditions: ReturnType<typeof eq>[],
): Promise<ExactOutcome> {
  if (!db) return { kind: "miss" };
  const titleMatch = subtopicTitle || topicTitle;
  if (!titleMatch) return { kind: "miss" };

  const baseRows = await db
    .select({ subtopicId: subtopics.id })
    .from(subtopics)
    .innerJoin(topics, eq(topics.id, subtopics.topicId))
    .innerJoin(syllabi, eq(syllabi.id, topics.syllabusId))
    .innerJoin(subjects, eq(subjects.id, syllabi.subjectId))
    .where(and(ilike(subtopics.title, titleMatch), ...conditions));

  if (baseRows.length === 1) {
    return { kind: "hit", subtopicId: baseRows[0].subtopicId };
  }
  if (baseRows.length > 1) {
    // Two or more catalogue subtopics share the title (e.g. "Algorithms"
    // appears under two different topics in Cambridge 9618 Computer
    // Science). When the caller also supplied a topic title, retry the
    // exact lookup with topics.title narrowed too — this routinely
    // disambiguates without giving up safety.
    if (topicTitle) {
      const narrowed = await db
        .select({ subtopicId: subtopics.id })
        .from(subtopics)
        .innerJoin(topics, eq(topics.id, subtopics.topicId))
        .innerJoin(syllabi, eq(syllabi.id, topics.syllabusId))
        .innerJoin(subjects, eq(subjects.id, syllabi.subjectId))
        .where(and(ilike(subtopics.title, titleMatch), ilike(topics.title, topicTitle), ...conditions));
      if (narrowed.length === 1) {
        return { kind: "hit", subtopicId: narrowed[0].subtopicId };
      }
    }
    return { kind: "ambiguous" };
  }

  // baseRows.length === 0 → topic-title fallback.
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
    if (fallback.length === 1) {
      return { kind: "hit", subtopicId: fallback[0].subtopicId };
    }
    if (fallback.length > 1) {
      return { kind: "hit", subtopicId: fallback[0].subtopicId };
    }
  }

  return { kind: "miss" };
}

export async function resolveSubtopicId(args: ResolveSubtopicArgs): Promise<ResolveSubtopicResult> {
  if (!db) return { subtopicId: null, ambiguous: false };

  const subjectName = (args.subject ?? "").trim();
  const rawSubtopic = (args.subtopic ?? "").trim();
  const rawTopic = (args.topic ?? "").trim();
  if (!rawSubtopic && !rawTopic) return { subtopicId: null, ambiguous: false };

  const candidateSyllabusIds =
    args.candidateSyllabusIds ?? (await resolveSyllabusIdsForCode(args.syllabusCode));

  const conditions = [] as ReturnType<typeof eq>[];
  if (subjectName) conditions.push(ilike(subjects.name, subjectName));
  if (candidateSyllabusIds.length > 0) {
    conditions.push(inArray(syllabi.id, candidateSyllabusIds));
  }

  // Pass 1 — try the raw caller strings exactly. Preserves catalogue
  // titles that legitimately contain commas, brackets, etc. (e.g.
  // "Motion, forces and energy", "Stoichiometry & moles").
  const rawOutcome = await exactLookup(rawTopic, rawSubtopic, conditions);
  if (rawOutcome.kind === "hit") {
    return { subtopicId: rawOutcome.subtopicId, ambiguous: false };
  }

  // Pass 2 — strip noisy legacy tag prefixes/suffixes (e.g.
  // "9.2 Algorithms" → "Algorithms", "S-Writing.1" → "Writing",
  // "Foo, Bar" → "Bar") and retry. Runs whenever normalisation
  // actually changes the input. Importantly we also fall through to
  // pass 2 when pass 1 reported `ambiguous` — a noisy topic like
  // "9.2 Algorithm Design and Problem-solving" can disambiguate a
  // duplicated subtopic title once normalised to its catalogue form.
  // If pass 2 itself also fails to commit, we then return ambiguous.
  const normSubtopic = (normalizeQuestionTag(rawSubtopic) ?? "").trim();
  const normTopic = (normalizeQuestionTag(rawTopic) ?? "").trim();
  const differs = normSubtopic !== rawSubtopic || normTopic !== rawTopic;
  if (differs && (normSubtopic || normTopic)) {
    const normOutcome = await exactLookup(normTopic, normSubtopic, conditions);
    if (normOutcome.kind === "hit") {
      return { subtopicId: normOutcome.subtopicId, ambiguous: false };
    }
    if (normOutcome.kind === "ambiguous") {
      return { subtopicId: null, ambiguous: true };
    }
    // pass 2 missed — fall through to fuzzy.
  } else if (rawOutcome.kind === "ambiguous") {
    // Normalisation wouldn't change anything, so pass 2 cannot rescue
    // the ambiguity. Report it now and skip fuzzy (fuzzy can't
    // distinguish between identical-title catalogue entries either).
    return { subtopicId: null, ambiguous: true };
  }

  // ── Fuzzy fallback ───────────────────────────────────────────────────────
  // Both exact passes missed. Use pg_trgm similarity against subtopics.title
  // and topics.title to catch examiner drift ("Stoichiometry & moles" →
  // "Stoichiometry"). Subject + syllabus scoping (already in `conditions`)
  // still applies, so a Chemistry query never grabs a Physics topic. We
  // run fuzzy against the normalised strings (or raw if normalisation
  // produced no change) so noisy "9.2 Algorithms" doesn't waste fuzzy
  // budget on the leading "9.2".
  const fuzzyTitle = (normSubtopic || normTopic || rawSubtopic || rawTopic).trim();
  if (!fuzzyTitle) return { subtopicId: null, ambiguous: false };

  try {
    const fuzzyRows = await db
      .select({
        subtopicId: subtopics.id,
        sim: sql<number>`GREATEST(
          similarity(LOWER(${subtopics.title}), LOWER(${fuzzyTitle})),
          similarity(LOWER(${topics.title}), LOWER(${fuzzyTitle}))
        )`,
      })
      .from(subtopics)
      .innerJoin(topics, eq(topics.id, subtopics.topicId))
      .innerJoin(syllabi, eq(syllabi.id, topics.syllabusId))
      .innerJoin(subjects, eq(subjects.id, syllabi.subjectId))
      .where(
        and(
          sql`(similarity(LOWER(${subtopics.title}), LOWER(${fuzzyTitle})) >= ${FUZZY_MIN_SIM}
               OR similarity(LOWER(${topics.title}), LOWER(${fuzzyTitle})) >= ${FUZZY_MIN_SIM})`,
          ...conditions,
        ),
      )
      .orderBy(
        sql`GREATEST(
          similarity(LOWER(${subtopics.title}), LOWER(${fuzzyTitle})),
          similarity(LOWER(${topics.title}), LOWER(${fuzzyTitle}))
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

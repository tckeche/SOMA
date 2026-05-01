/**
 * Service: learning-requirement resolver.
 *
 * Sibling to `subtopicResolver.ts`. Where the subtopic resolver maps a
 * free-text (subject, topic, subtopic) tuple onto `subtopics.id`, this
 * one walks one level deeper: given a misconception that is already
 * linked to a subtopic, pick the single learning requirement under
 * that subtopic that the misconception is "about".
 *
 * Matching strategy
 * ─────────────────
 * Pure-JS lexical similarity (Jaccard over substantive tokens) between
 * the misconception's combined text and each candidate requirement's
 * `statement` (+ `notesAndExamples` if present). No LLM call, no
 * embeddings — keeps the backfill cheap and deterministic. Math-vocab
 * tokens like "equation", "factor", "fraction" naturally dominate
 * because they appear in both texts; stop-words and very short tokens
 * are filtered so they can't drown out the signal.
 *
 * A match is committed only when it clears two thresholds:
 *   - `minScore`        — top score must be >= this (default 0.10)
 *   - `minScoreGap`     — top score must beat runner-up by this much
 *                         (default 0.03), so genuine ties stay null
 *                         and the row falls through to human review.
 *
 * Used by:
 *   - `scripts/backfillLearningRequirementLinks.ts` to populate the
 *     `learning_requirement_id` FK on examiner_misconceptions rows
 *     that already have `subtopic_id` but missing the deeper FK.
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db";
import { examinerMisconceptions, learningRequirements } from "@shared/schema";
import { invalidateExaminerMisconceptionsCache } from "./examinerMisconceptionsCache";

// ─── Pure matcher ──────────────────────────────────────────────────

/**
 * Stop words filtered before scoring — both English function words and
 * generic exam-rubric phrases that would otherwise inflate Jaccard
 * overlap on every pair (e.g. "the candidate", "students often"). Kept
 * intentionally small; mathematical terms are NEVER filtered so they
 * can carry the matching signal.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by",
  "for", "with", "as", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "they", "them", "their",
  "i", "we", "you", "he", "she", "his", "her", "our",
  "do", "does", "did", "done", "doing", "have", "has", "had", "having",
  "will", "would", "should", "could", "can", "may", "might", "must", "shall",
  "not", "no", "yes", "than", "then", "so", "such", "very",
  "from", "into", "out", "up", "down", "over", "under", "between", "through",
  "candidate", "candidates", "student", "students", "answer", "answers",
  "question", "questions", "often", "many", "some", "most", "all",
  "use", "used", "using", "show", "shown", "give", "given", "giving",
  "instead", "rather", "wrong", "correct", "incorrect",
]);

/** Minimum token length kept for scoring. "x", "y", "n" are math
 *  variables but also extremely common — keeping length>=2 avoids
 *  inflating Jaccard on every pair via single-letter overlap. */
const MIN_TOKEN_LEN = 2;

export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((tok) => tok.length >= MIN_TOKEN_LEN && !STOP_WORDS.has(tok));
}

/** Jaccard = |A ∩ B| / |A ∪ B|. Returns 0 when either set is empty. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const tok of Array.from(setA)) {
    if (setB.has(tok)) intersect += 1;
  }
  const unionSize = setA.size + setB.size - intersect;
  return unionSize === 0 ? 0 : intersect / unionSize;
}

export interface MisconceptionTextParts {
  misconception: string;
  studentError?: string | null;
  correctApproach?: string | null;
}

export interface RequirementCandidate {
  id: number;
  statement: string;
  notesAndExamples?: string | null;
}

export interface MatchResult {
  /** Best requirement id, or null when nothing cleared the thresholds. */
  requirementId: number | null;
  /** Top score actually achieved (0..1). */
  topScore: number;
  /** Runner-up score, for tie diagnostics. */
  runnerUpScore: number;
  /** Reason the match was rejected, if `requirementId` is null. */
  rejectionReason: "no_candidates" | "low_score" | "ambiguous_tie" | null;
}

export interface MatchOptions {
  /** Top score must be >= this to commit. Default 0.10. */
  minScore?: number;
  /** Top score must exceed runner-up by this much. Default 0.03. */
  minScoreGap?: number;
}

/**
 * Pure scoring function. No DB calls. Picks the requirement whose
 * statement (+ notes) shares the most substantive tokens with the
 * combined misconception text, subject to the two confidence guards.
 */
export function pickBestRequirement(
  parts: MisconceptionTextParts,
  candidates: RequirementCandidate[],
  options: MatchOptions = {},
): MatchResult {
  const minScore = options.minScore ?? 0.10;
  const minScoreGap = options.minScoreGap ?? 0.03;

  if (candidates.length === 0) {
    return { requirementId: null, topScore: 0, runnerUpScore: 0, rejectionReason: "no_candidates" };
  }

  const misconceptionTokens = tokenize(
    [parts.misconception, parts.studentError ?? "", parts.correctApproach ?? ""].join(" "),
  );

  const scored = candidates
    .map((c) => {
      const candidateText = [c.statement, c.notesAndExamples ?? ""].join(" ");
      return { id: c.id, score: jaccard(misconceptionTokens, tokenize(candidateText)) };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const runnerUp = scored[1] ?? { score: 0 };

  if (top.score < minScore) {
    return { requirementId: null, topScore: top.score, runnerUpScore: runnerUp.score, rejectionReason: "low_score" };
  }
  if (top.score - runnerUp.score < minScoreGap) {
    return { requirementId: null, topScore: top.score, runnerUpScore: runnerUp.score, rejectionReason: "ambiguous_tie" };
  }
  return { requirementId: top.id, topScore: top.score, runnerUpScore: runnerUp.score, rejectionReason: null };
}

// ─── DB-backed batch backfill ──────────────────────────────────────

export interface BackfillOptions extends MatchOptions {
  /** Restrict to one exam board. */
  board?: string;
  /** Restrict to one syllabus code. */
  syllabusCode?: string;
  /** Only consider rows with this status. Default "approved" (so the
   *  Maker's seed pool gets the deeper linkage immediately). */
  status?: "pending" | "approved" | "rejected";
  /** Cap on candidate rows scanned per call. Default 10_000. */
  limit?: number;
  /** Preview-only: compute matches but do not write. */
  dryRun?: boolean;
}

export interface BackfillResult {
  scanned: number;
  matched: number;
  skippedLowScore: number;
  skippedAmbiguous: number;
  skippedNoCandidates: number;
  matchedIds: number[];
  thresholds: Required<Pick<MatchOptions, "minScore" | "minScoreGap">>;
}

/**
 * Walk every misconception with `subtopic_id IS NOT NULL` AND
 * `learning_requirement_id IS NULL`, look up the candidate
 * requirements under each subtopic, score with `pickBestRequirement`,
 * and (unless `dryRun`) write the matched FK back. Cache invalidation
 * runs once per affected (board, syllabusCode) group at the end.
 */
export async function backfillLearningRequirementLinks(
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const thresholds = {
    minScore: opts.minScore ?? 0.10,
    minScoreGap: opts.minScoreGap ?? 0.03,
  };
  const empty: BackfillResult = {
    scanned: 0,
    matched: 0,
    skippedLowScore: 0,
    skippedAmbiguous: 0,
    skippedNoCandidates: 0,
    matchedIds: [],
    thresholds,
  };
  if (!db) return empty;

  const limit = Math.max(1, Math.min(100_000, opts.limit ?? 10_000));
  const status = opts.status ?? "approved";

  const conditions = [
    eq(examinerMisconceptions.status, status),
    isNotNull(examinerMisconceptions.subtopicId),
    isNull(examinerMisconceptions.learningRequirementId),
  ];
  if (opts.board) conditions.push(eq(examinerMisconceptions.board, opts.board));
  if (opts.syllabusCode) conditions.push(eq(examinerMisconceptions.syllabusCode, opts.syllabusCode));

  const candidates = await db
    .select({
      id: examinerMisconceptions.id,
      board: examinerMisconceptions.board,
      syllabusCode: examinerMisconceptions.syllabusCode,
      subtopicId: examinerMisconceptions.subtopicId,
      misconception: examinerMisconceptions.misconception,
      studentError: examinerMisconceptions.studentError,
      correctApproach: examinerMisconceptions.correctApproach,
    })
    .from(examinerMisconceptions)
    .where(and(...conditions))
    .limit(limit);

  if (candidates.length === 0) return { ...empty, scanned: 0 };

  // Fetch all learning requirements for the involved subtopics in one
  // query, then group in memory so per-row matching is O(candidates).
  const subtopicIds = Array.from(
    new Set(
      candidates
        .map((c) => c.subtopicId)
        .filter((id): id is number => id !== null && id !== undefined),
    ),
  );
  const reqRows = await db
    .select({
      id: learningRequirements.id,
      subtopicId: learningRequirements.subtopicId,
      statement: learningRequirements.statement,
      notesAndExamples: learningRequirements.notesAndExamples,
    })
    .from(learningRequirements)
    .where(inArray(learningRequirements.subtopicId, subtopicIds));

  const reqsBySubtopic = new Map<number, RequirementCandidate[]>();
  for (const r of reqRows) {
    const list = reqsBySubtopic.get(r.subtopicId) ?? [];
    list.push({ id: r.id, statement: r.statement, notesAndExamples: r.notesAndExamples });
    reqsBySubtopic.set(r.subtopicId, list);
  }

  // Bucket per assigned requirement id so we can do one UPDATE per
  // requirement (rather than N separate UPDATEs).
  const updateBuckets = new Map<number, number[]>();
  let skippedLowScore = 0;
  let skippedAmbiguous = 0;
  let skippedNoCandidates = 0;

  for (const row of candidates) {
    if (row.subtopicId === null || row.subtopicId === undefined) continue;
    const subtopicReqs = reqsBySubtopic.get(row.subtopicId) ?? [];
    const result = pickBestRequirement(
      {
        misconception: row.misconception,
        studentError: row.studentError,
        correctApproach: row.correctApproach,
      },
      subtopicReqs,
      thresholds,
    );
    if (result.requirementId === null) {
      switch (result.rejectionReason) {
        case "low_score": skippedLowScore += 1; break;
        case "ambiguous_tie": skippedAmbiguous += 1; break;
        case "no_candidates": skippedNoCandidates += 1; break;
      }
      continue;
    }
    const list = updateBuckets.get(result.requirementId) ?? [];
    list.push(row.id);
    updateBuckets.set(result.requirementId, list);
  }

  const matchedIds = Array.from(updateBuckets.values()).flat();
  const result: BackfillResult = {
    scanned: candidates.length,
    matched: matchedIds.length,
    skippedLowScore,
    skippedAmbiguous,
    skippedNoCandidates,
    matchedIds,
    thresholds,
  };

  if (opts.dryRun) return result;

  const cacheGroups = new Set<string>();
  const bucketEntries = Array.from(updateBuckets.entries());
  for (const [requirementId, ids] of bucketEntries) {
    if (ids.length === 0) continue;
    const updated = await db
      .update(examinerMisconceptions)
      .set({ learningRequirementId: requirementId })
      .where(inArray(examinerMisconceptions.id, ids))
      .returning({
        board: examinerMisconceptions.board,
        syllabusCode: examinerMisconceptions.syllabusCode,
      });
    for (const r of updated) cacheGroups.add(`${r.board}|${r.syllabusCode}`);
  }

  for (const g of Array.from(cacheGroups)) {
    const [board, syllabusCode] = g.split("|");
    invalidateExaminerMisconceptionsCache({ board, syllabusCode });
  }

  return result;
}

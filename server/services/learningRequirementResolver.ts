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

// ─── LLM-judge fallback ─────────────────────────────────────────────
//
// The lexical matcher (above) only commits high-confidence wins —
// misconceptions whose vocabulary literally overlaps with a
// requirement's statement. That leaves a long tail of rows where the
// match exists semantically but the surface words differ
// ("student writes 2x = 7 instead of x = 4" vs "Solve linear
// equations using inverse operations"). This judge plugs that gap by
// asking a small LLM to pick from the same candidate set, with the
// same all-or-nothing contract — return one id from the provided list
// or report "none" with a reason.
//
// Routes through generateWithFallback so it inherits the same
// caching, idempotency, telemetry, cost guards, and provider fallback
// chain everything else uses. Per-row idempotency key = misconception
// id, so re-running the script picks up where it left off without
// duplicating spend.

import { generateWithFallback } from "./aiOrchestrator";

export interface JudgeOptions {
  /** Override the AI orchestrator call (used in tests). */
  callAI?: typeof generateWithFallback;
  /** Stable idempotency tag prefix (default derives from promptVersion). */
  idempotencyPrefix?: string;
  /** Minimum confidence the judge must report to commit. Default "medium". */
  minConfidence?: "low" | "medium" | "high";
  /**
   * Prompt phrasing version. v1 (default) is conservative — model
   * returns null when no requirement is a "clear fit". v2 is
   * best-fit-permissive — model commits to the closest requirement
   * unless the misconception is about a genuinely different topic.
   * Used to retry the residue from a v1 pass without paying for the
   * already-decided rows (the orchestrator's idempotency key includes
   * the version, so v2 calls miss the v1 cache entries).
   */
  promptVersion?: "v1" | "v2";
}

export interface JudgeResult {
  requirementId: number | null;
  confidence: "low" | "medium" | "high";
  reason: string;
  rejectionReason: "judge_low_confidence" | "judge_picked_none" | "judge_invalid_id" | null;
}

const JUDGE_SYSTEM_PROMPT_V1 = [
  "You classify exam-board misconceptions to a single learning requirement.",
  "You will be given:",
  "  1. A misconception (the wrong belief, the typical wrong working, and the correct approach).",
  "  2. A numbered list of candidate learning requirements under one syllabus subtopic.",
  "Pick exactly one id from the list that the misconception is ABOUT — i.e. the requirement",
  "the student would have demonstrated correctly if they understood. If no requirement is a clear",
  "fit, return id=null with confidence=\"low\".",
  "Never invent an id that isn't in the list. Never return more than one id.",
  "Output JSON only, matching the provided schema.",
].join("\n");

const JUDGE_SYSTEM_PROMPT_V2 = [
  "You classify exam-board misconceptions to a single learning requirement.",
  "You will be given:",
  "  1. A misconception (the wrong belief, the typical wrong working, and the correct approach).",
  "  2. A numbered list of candidate learning requirements under one syllabus subtopic.",
  "",
  "Pick the BEST-FIT id from the list — the requirement most directly related to the",
  "misconception, even if the fit is imperfect. The candidates are ALL within the same",
  "subtopic, so one of them is almost certainly the right home for this misconception.",
  "When two candidates are close, prefer the broader / more foundational one.",
  "When the misconception is about a fundamental skill (arithmetic, notation, units) that",
  "any of these requirements would exercise, pick the one whose statement most clearly names",
  "that skill.",
  "",
  "ONLY return id=null when the misconception is genuinely about a topic outside this",
  "subtopic (e.g. an algebra misconception under a geometry subtopic). Don't return null just",
  "because the fit is imperfect — that is the normal case, and you should still commit.",
  "",
  "Confidence rating:",
  "  - high: the misconception clearly maps to one specific requirement.",
  "  - medium: best fit picked with reasonable confidence; minor surface-language gap.",
  "  - low:  best-of-imperfect-options; commit anyway unless the misconception is off-topic.",
  "",
  "Never invent an id that isn't in the list. Never return more than one id.",
  "Output JSON only, matching the provided schema.",
].join("\n");

function getJudgePrompt(version: "v1" | "v2"): string {
  return version === "v2" ? JUDGE_SYSTEM_PROMPT_V2 : JUDGE_SYSTEM_PROMPT_V1;
}

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "confidence", "reason"],
  properties: {
    id: {
      type: ["integer", "null"],
      description: "The chosen requirement id from the candidate list, or null if no clear fit.",
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
    reason: {
      type: "string",
      description: "One short sentence explaining the choice (or why none fit).",
    },
  },
};

const CONFIDENCE_RANK: Record<"low" | "medium" | "high", number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function buildJudgeUserPrompt(
  parts: MisconceptionTextParts,
  candidates: RequirementCandidate[],
): string {
  const numbered = candidates
    .map((c, i) =>
      `  [${c.id}] ${c.statement}` +
      (c.notesAndExamples ? `\n        notes: ${c.notesAndExamples}` : ""),
    )
    .join("\n");
  return [
    "Misconception:",
    `  belief: ${parts.misconception}`,
    `  typical wrong working: ${parts.studentError ?? "—"}`,
    `  correct approach: ${parts.correctApproach ?? "—"}`,
    "",
    "Candidate learning requirements (pick one id, or null):",
    numbered,
  ].join("\n");
}

/** Pure-async judge — calls the AI orchestrator and parses the
 *  response. Returns null requirementId when the model refuses or
 *  reports low confidence below `minConfidence`. */
export async function judgeBestRequirement(
  parts: MisconceptionTextParts,
  candidates: RequirementCandidate[],
  rowId: number,
  opts: JudgeOptions = {},
): Promise<JudgeResult> {
  const minConfidence = opts.minConfidence ?? "medium";
  const minConfidenceRank = CONFIDENCE_RANK[minConfidence];
  const callAI = opts.callAI ?? generateWithFallback;
  const promptVersion = opts.promptVersion ?? "v1";
  // Default the idempotency prefix to the prompt version so a v2 retry
  // automatically misses the v1 cache entries from the previous pass.
  const idempotencyPrefix = opts.idempotencyPrefix ?? `lr-judge-${promptVersion}`;

  if (candidates.length === 0) {
    return {
      requirementId: null,
      confidence: "low",
      reason: "no candidates",
      rejectionReason: "judge_picked_none",
    };
  }

  const candidateIds = new Set(candidates.map((c) => c.id));
  const userPrompt = buildJudgeUserPrompt(parts, candidates);
  const result = await callAI(getJudgePrompt(promptVersion), userPrompt, JUDGE_SCHEMA, {
    idempotencyKey: `${idempotencyPrefix}:misconception:${rowId}`,
    cacheable: true,
    taskType: "misconception_classify",
    promptId: "learning-requirement-judge",
    promptVersion,
    maxTokens: 200,
  });

  let parsed: { id: number | null; confidence: string; reason: string };
  try {
    parsed = JSON.parse(result.data);
  } catch {
    return {
      requirementId: null,
      confidence: "low",
      reason: `unparseable judge response: ${result.data.slice(0, 80)}`,
      rejectionReason: "judge_invalid_id",
    };
  }

  const conf =
    parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
      ? parsed.confidence
      : "low";

  if (parsed.id === null || parsed.id === undefined) {
    return {
      requirementId: null,
      confidence: conf,
      reason: parsed.reason ?? "model returned null",
      rejectionReason: "judge_picked_none",
    };
  }
  if (typeof parsed.id !== "number" || !Number.isInteger(parsed.id) || !candidateIds.has(parsed.id)) {
    return {
      requirementId: null,
      confidence: conf,
      reason: `model returned invalid id ${parsed.id}`,
      rejectionReason: "judge_invalid_id",
    };
  }
  if (CONFIDENCE_RANK[conf] < minConfidenceRank) {
    return {
      requirementId: null,
      confidence: conf,
      reason: parsed.reason ?? "below min confidence",
      rejectionReason: "judge_low_confidence",
    };
  }
  return {
    requirementId: parsed.id,
    confidence: conf,
    reason: parsed.reason ?? "",
    rejectionReason: null,
  };
}

export interface JudgeBackfillOptions {
  board?: string;
  syllabusCode?: string;
  status?: "pending" | "approved" | "rejected";
  /** Cap on candidate rows scanned. Default 10_000. Use a small value (e.g. 50) for the first paid run. */
  limit?: number;
  /** Parallel LLM calls. Default 5. */
  concurrency?: number;
  /** Minimum confidence to commit. Default "medium". */
  minConfidence?: "low" | "medium" | "high";
  /** Prompt phrasing version (v1 conservative, v2 best-fit). Default v1. */
  promptVersion?: "v1" | "v2";
  /** Preview-only: don't write. */
  dryRun?: boolean;
  /** Test seam — override the AI call. */
  callAI?: typeof generateWithFallback;
  /** Test seam — override pLimit (defaults to dynamic import). */
  concurrencyImpl?: <T>(n: number) => (fn: () => Promise<T>) => Promise<T>;
  /** Optional progress callback — invoked after each row's judge call resolves. */
  onProgress?: (done: number, total: number) => void;
}

export interface JudgeBackfillResult {
  scanned: number;
  matched: number;
  skippedJudgeNone: number;
  skippedJudgeLowConfidence: number;
  skippedJudgeInvalidId: number;
  skippedNoCandidates: number;
  matchedIds: number[];
}

/**
 * Same scan as the lexical backfill, but routes the candidate set
 * through the LLM judge instead of Jaccard. Targets ONLY rows where
 * the lexical pass already failed (subtopic_id NOT NULL,
 * learning_requirement_id IS NULL), so running this after the lexical
 * backfill is the natural workflow.
 */
export async function llmBackfillLearningRequirementLinks(
  opts: JudgeBackfillOptions = {},
): Promise<JudgeBackfillResult> {
  const empty: JudgeBackfillResult = {
    scanned: 0,
    matched: 0,
    skippedJudgeNone: 0,
    skippedJudgeLowConfidence: 0,
    skippedJudgeInvalidId: 0,
    skippedNoCandidates: 0,
    matchedIds: [],
  };
  if (!db) return empty;

  const limit = Math.max(1, Math.min(100_000, opts.limit ?? 10_000));
  const status = opts.status ?? "approved";
  const concurrency = Math.max(1, Math.min(20, opts.concurrency ?? 5));
  const minConfidence = opts.minConfidence ?? "medium";

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

  if (candidates.length === 0) return empty;

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

  // Resolve concurrency limiter — dynamic import keeps this file
  // testable without a real p-limit dependency in the unit tests.
  let runWithLimit: (fn: () => Promise<void>) => Promise<void>;
  if (opts.concurrencyImpl) {
    runWithLimit = opts.concurrencyImpl(concurrency) as typeof runWithLimit;
  } else {
    const pLimit = (await import("p-limit")).default;
    runWithLimit = pLimit(concurrency);
  }

  const updateBuckets = new Map<number, number[]>();
  let skippedJudgeNone = 0;
  let skippedJudgeLowConfidence = 0;
  let skippedJudgeInvalidId = 0;
  let skippedNoCandidates = 0;
  let done = 0;

  await Promise.all(
    candidates.map((row) =>
      runWithLimit(async () => {
        if (row.subtopicId === null || row.subtopicId === undefined) {
          skippedNoCandidates += 1;
          done += 1;
          opts.onProgress?.(done, candidates.length);
          return;
        }
        const subtopicReqs = reqsBySubtopic.get(row.subtopicId) ?? [];
        if (subtopicReqs.length === 0) {
          skippedNoCandidates += 1;
          done += 1;
          opts.onProgress?.(done, candidates.length);
          return;
        }
        const result = await judgeBestRequirement(
          {
            misconception: row.misconception,
            studentError: row.studentError,
            correctApproach: row.correctApproach,
          },
          subtopicReqs,
          row.id,
          { callAI: opts.callAI, minConfidence, promptVersion: opts.promptVersion },
        );
        if (result.requirementId === null) {
          switch (result.rejectionReason) {
            case "judge_picked_none": skippedJudgeNone += 1; break;
            case "judge_low_confidence": skippedJudgeLowConfidence += 1; break;
            case "judge_invalid_id": skippedJudgeInvalidId += 1; break;
          }
        } else {
          const list = updateBuckets.get(result.requirementId) ?? [];
          list.push(row.id);
          updateBuckets.set(result.requirementId, list);
        }
        done += 1;
        opts.onProgress?.(done, candidates.length);
      }),
    ),
  );

  const matchedIds = Array.from(updateBuckets.values()).flat();
  const result: JudgeBackfillResult = {
    scanned: candidates.length,
    matched: matchedIds.length,
    skippedJudgeNone,
    skippedJudgeLowConfidence,
    skippedJudgeInvalidId,
    skippedNoCandidates,
    matchedIds,
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

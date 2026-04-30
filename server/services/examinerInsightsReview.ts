/**
 * Service: Examiner Insight Review Queue.
 *
 * Read + write helpers for the super-admin queue that gates AI-extracted
 * misconceptions before they go live. Lives outside `storage.ts` per
 * server/storage-pattern.md.
 *
 * Read shape includes joined source-document context so the reviewer can
 * see WHERE each insight came from without an extra round-trip.
 */
import { db } from "../db";
import {
  examinerMisconceptions,
  syllabusDocuments,
  somaUsers,
  somaQuizzes,
  subtopics,
  topics,
  syllabi,
} from "@shared/schema";
import { invalidateExaminerMisconceptionsCache } from "./examinerMisconceptionsCache";
import { and, asc, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { resolveSubtopicId, resolveSyllabusIdsForCode } from "./subtopicResolver";

export type ReviewStatus = "pending" | "approved" | "rejected";

export interface QueueRow {
  id: number;
  status: ReviewStatus;
  board: string;
  syllabusCode: string;
  subject: string | null;
  topic: string;
  subtopic: string | null;
  subtopicId: number | null;
  subtopicTitle: string | null;
  misconception: string;
  studentError: string;
  correctApproach: string;
  frequency: string;
  sourceQuote: string | null;
  sourcePage: number | null;
  confidencePct: number | null;
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewedByDisplayName: string | null;
  reviewNotes: string | null;
  documentId: number;
  documentFilename: string | null;
  documentType: string | null;
  extractedAt: string;
}

export interface QueueListOptions {
  status?: ReviewStatus;
  board?: string;
  syllabusCode?: string;
  limit?: number;
  offset?: number;
}

export interface QueueListResult {
  rows: QueueRow[];
  total: number;
}

const REVIEWER_USERS = somaUsers; // alias for clarity in joins

/**
 * Single source of truth for the queue SELECT shape. Both `listQueue`
 * and `listQueueForTutor` use this so adding a column is a one-line
 * change instead of a four-place edit (which is exactly how the missing
 * `subtopics` join slipped in originally).
 */
function buildQueueSelect() {
  return {
    id: examinerMisconceptions.id,
    status: examinerMisconceptions.status,
    board: examinerMisconceptions.board,
    syllabusCode: examinerMisconceptions.syllabusCode,
    subject: examinerMisconceptions.subject,
    topic: examinerMisconceptions.topic,
    subtopic: examinerMisconceptions.subtopic,
    subtopicId: examinerMisconceptions.subtopicId,
    subtopicTitle: subtopics.title,
    misconception: examinerMisconceptions.misconception,
    studentError: examinerMisconceptions.studentError,
    correctApproach: examinerMisconceptions.correctApproach,
    frequency: examinerMisconceptions.frequency,
    sourceQuote: examinerMisconceptions.sourceQuote,
    sourcePage: examinerMisconceptions.sourcePage,
    confidencePct: examinerMisconceptions.confidence,
    reviewedAt: examinerMisconceptions.reviewedAt,
    reviewedById: examinerMisconceptions.reviewedById,
    reviewedByDisplayName: REVIEWER_USERS.displayName,
    reviewNotes: examinerMisconceptions.reviewNotes,
    documentId: examinerMisconceptions.documentId,
    documentFilename: syllabusDocuments.filename,
    documentType: syllabusDocuments.documentType,
    extractedAt: examinerMisconceptions.extractedAt,
  } as const;
}

/**
 * Type-only helper: a phantom query expression we use solely to derive
 * `RawQueueRow` from drizzle's inference of `buildQueueSelect()`. The
 * function is never executed (the `as never` keeps it type-only and
 * avoids needing a real `db` at module load), so there is no runtime
 * cost. Keeping the row type derived means adding a column to
 * `buildQueueSelect` automatically widens `RawQueueRow` instead of
 * forcing a parallel hand-maintained interface.
 */
function _queueRowTypeProbe() {
  const builder = (null as never as NonNullable<typeof db>)
    .select(buildQueueSelect())
    .from(examinerMisconceptions)
    .leftJoin(syllabusDocuments, eq(syllabusDocuments.id, examinerMisconceptions.documentId))
    .leftJoin(subtopics, eq(subtopics.id, examinerMisconceptions.subtopicId))
    .leftJoin(REVIEWER_USERS, eq(REVIEWER_USERS.id, examinerMisconceptions.reviewedById));
  return builder;
}
type RawQueueRow = Awaited<ReturnType<typeof _queueRowTypeProbe>>[number];

/**
 * Maps the raw drizzle row (with Date objects and possibly-null status)
 * into the public `QueueRow` shape returned to the API layer.
 */
function mapQueueRow(r: RawQueueRow): QueueRow {
  return {
    ...r,
    status: (r.status ?? "pending") as ReviewStatus,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    reviewedByDisplayName: r.reviewedByDisplayName ?? null,
    extractedAt: r.extractedAt.toISOString(),
  };
}

/**
 * Runs the shared queue query against any caller-supplied WHERE
 * conditions. `listQueue` and `listQueueForTutor` differ only in what
 * they pass here.
 */
async function runQueueQuery(
  conditions: SQL[],
  limit: number,
  offset: number,
): Promise<QueueListResult> {
  if (!db) return { rows: [], total: 0 };
  const rows = await db
    .select(buildQueueSelect())
    .from(examinerMisconceptions)
    .leftJoin(syllabusDocuments, eq(syllabusDocuments.id, examinerMisconceptions.documentId))
    .leftJoin(subtopics, eq(subtopics.id, examinerMisconceptions.subtopicId))
    .leftJoin(REVIEWER_USERS, eq(REVIEWER_USERS.id, examinerMisconceptions.reviewedById))
    .where(and(...conditions))
    .orderBy(desc(examinerMisconceptions.extractedAt))
    .limit(limit)
    .offset(offset);

  // Count for pagination — separate query so the row select stays lean.
  const totalRows = await db
    .select({ count: examinerMisconceptions.id })
    .from(examinerMisconceptions)
    .where(and(...conditions));

  return {
    rows: rows.map(mapQueueRow),
    total: totalRows.length,
  };
}

/**
 * Paginated listing for the queue UI. Defaults to status='pending' and
 * orders newest first.
 */
export async function listQueue(options: QueueListOptions = {}): Promise<QueueListResult> {
  if (!db) return { rows: [], total: 0 };

  const status = options.status ?? "pending";
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);

  const conditions: SQL[] = [eq(examinerMisconceptions.status, status)];
  if (options.board) conditions.push(eq(examinerMisconceptions.board, options.board));
  if (options.syllabusCode) conditions.push(eq(examinerMisconceptions.syllabusCode, options.syllabusCode));

  return runQueueQuery(conditions, limit, offset);
}

/**
 * Tutor scope: every (board, syllabusCode) pair derived from quizzes the
 * tutor has authored. Returned as a deduped set so callers can scope
 * queries by `(board, syllabusCode) IN scope` without joining quizzes
 * on every request.
 *
 * Parsing rule mirrors `parseBoardAndSyllabusCode` in routes.ts: the
 * first numeric block in `soma_quizzes.syllabus` is the syllabus code,
 * the rest is the board. Quizzes with empty `syllabus` are ignored.
 */
export interface TutorScopePair {
  board: string;
  syllabusCode: string;
}

const SYLLABUS_CODE_RE = /\b(\d{3,6}[A-Za-z]?)\b/;

function parseBoardAndCode(raw: string | null | undefined): TutorScopePair | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const m = trimmed.match(SYLLABUS_CODE_RE);
  if (!m) return null;
  const syllabusCode = m[1];
  const board = trimmed.replace(syllabusCode, "").trim() || trimmed;
  return { board, syllabusCode };
}

export async function listTutorScope(tutorId: string): Promise<TutorScopePair[]> {
  if (!db) return [];
  const rows = await db
    .select({ syllabus: somaQuizzes.syllabus })
    .from(somaQuizzes)
    .where(eq(somaQuizzes.authorId, tutorId));
  const out = new Map<string, TutorScopePair>();
  for (const r of rows) {
    const pair = parseBoardAndCode(r.syllabus);
    if (!pair) continue;
    out.set(`${pair.board.toLowerCase()}|${pair.syllabusCode}`, pair);
  }
  return Array.from(out.values());
}

/**
 * True when the given misconception id falls inside `tutorId`'s scope.
 * Used by approve/edit/reject endpoints to forbid cross-tutor mutations.
 */
export async function tutorOwnsInsight(tutorId: string, insightId: number): Promise<boolean> {
  if (!db) return false;
  const [row] = await db
    .select({ board: examinerMisconceptions.board, syllabusCode: examinerMisconceptions.syllabusCode })
    .from(examinerMisconceptions)
    .where(eq(examinerMisconceptions.id, insightId));
  if (!row) return false;
  const scope = await listTutorScope(tutorId);
  const key = `${row.board.toLowerCase()}|${row.syllabusCode}`;
  return scope.some((p) => `${p.board.toLowerCase()}|${p.syllabusCode}` === key);
}

export type ConfidenceBucket = "high" | "medium" | "low" | "unknown";

export interface ConfidenceBreakdown {
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

export interface CountsByStatus {
  pending: number;
  approved: number;
  rejected: number;
  byConfidence: Record<ReviewStatus, ConfidenceBreakdown>;
}

function bucketOfConfidence(pct: number | null | undefined): ConfidenceBucket {
  if (pct === null || pct === undefined) return "unknown";
  if (pct >= 80) return "high";
  if (pct >= 50) return "medium";
  return "low";
}

function emptyCountsByStatus(): CountsByStatus {
  return {
    pending: 0,
    approved: 0,
    rejected: 0,
    byConfidence: {
      pending: { high: 0, medium: 0, low: 0, unknown: 0 },
      approved: { high: 0, medium: 0, low: 0, unknown: 0 },
      rejected: { high: 0, medium: 0, low: 0, unknown: 0 },
    },
  };
}

export async function countsByStatus(): Promise<CountsByStatus> {
  const counts = emptyCountsByStatus();
  if (!db) return counts;
  const rows = await db
    .select({ status: examinerMisconceptions.status, confidence: examinerMisconceptions.confidence })
    .from(examinerMisconceptions);
  for (const r of rows) {
    const s = r.status as ReviewStatus | null;
    if (s !== "pending" && s !== "approved" && s !== "rejected") continue;
    counts[s]++;
    counts.byConfidence[s][bucketOfConfidence(r.confidence)]++;
  }
  return counts;
}

/**
 * Tutor-scoped queue listing — same shape as `listQueue` but scoped to
 * (board, syllabusCode) pairs the tutor has authored quizzes on.
 * Returns an empty list (not 403) when the tutor has authored no
 * quizzes — UI shows an explanatory empty state.
 */
export async function listQueueForTutor(
  tutorId: string,
  options: QueueListOptions = {},
): Promise<QueueListResult> {
  const empty: QueueListResult = { rows: [], total: 0 };
  if (!db) return empty;

  const scope = await listTutorScope(tutorId);
  if (scope.length === 0) return empty;

  // Drizzle's `or(and(...), and(...))` constructs an `IN` over (board,
  // syllabusCode) pairs. Postgres can't natively do row-value IN over
  // joined string columns, so we OR them up.
  const scopeConditions = scope.map((p) =>
    and(eq(examinerMisconceptions.board, p.board), eq(examinerMisconceptions.syllabusCode, p.syllabusCode)),
  );
  const status = options.status ?? "pending";
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);

  const conditions: SQL[] = [
    eq(examinerMisconceptions.status, status),
    or(...scopeConditions)!,
  ];
  if (options.board) conditions.push(eq(examinerMisconceptions.board, options.board));
  if (options.syllabusCode) conditions.push(eq(examinerMisconceptions.syllabusCode, options.syllabusCode));

  return runQueueQuery(conditions, limit, offset);
}

export async function countsByStatusForTutor(tutorId: string): Promise<CountsByStatus> {
  const counts = emptyCountsByStatus();
  if (!db) return counts;
  const scope = await listTutorScope(tutorId);
  if (scope.length === 0) return counts;
  const scopeConditions = scope.map((p) =>
    and(eq(examinerMisconceptions.board, p.board), eq(examinerMisconceptions.syllabusCode, p.syllabusCode)),
  );
  const rows = await db
    .select({ status: examinerMisconceptions.status, confidence: examinerMisconceptions.confidence })
    .from(examinerMisconceptions)
    .where(or(...scopeConditions)!);
  for (const r of rows) {
    const s = r.status as ReviewStatus | null;
    if (s !== "pending" && s !== "approved" && s !== "rejected") continue;
    counts[s]++;
    counts.byConfidence[s][bucketOfConfidence(r.confidence)]++;
  }
  return counts;
}

export interface UpdatePatch {
  topic?: string;
  subtopic?: string | null;
  subtopicId?: number | null;
  misconception?: string;
  studentError?: string;
  correctApproach?: string;
  frequency?: string;
}

/**
 * Thrown when a PATCH tries to link an insight to a `subtopicId` that
 * doesn't belong to the insight's syllabus. Routes catch this to return
 * a 400 instead of a generic 500.
 */
export class SubtopicLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubtopicLinkValidationError";
  }
}

/**
 * Edit a row in the queue (any status). Used by reviewers to fix
 * AI-extracted text before approving.
 */
export async function updateInsight(id: number, patch: UpdatePatch): Promise<void> {
  if (!db) return;
  const update: Record<string, unknown> = {};
  if (patch.topic !== undefined) update.topic = patch.topic;
  if (patch.subtopic !== undefined) update.subtopic = patch.subtopic;
  if (patch.subtopicId !== undefined) {
    // Validate that the submitted subtopic actually belongs to one of
    // the syllabi this insight is scoped to. The picker UI only offers
    // in-syllabus options, but we re-check on the server so a crafted
    // PATCH can't quietly link an insight to an unrelated subtopic.
    if (patch.subtopicId !== null) {
      const [insight] = await db
        .select({ syllabusCode: examinerMisconceptions.syllabusCode })
        .from(examinerMisconceptions)
        .where(eq(examinerMisconceptions.id, id));
      if (!insight) {
        throw new SubtopicLinkValidationError(`Insight ${id} not found`);
      }
      const candidateSyllabusIds = await resolveSyllabusIdsForCode(insight.syllabusCode);
      if (candidateSyllabusIds.length === 0) {
        throw new SubtopicLinkValidationError(
          `Cannot link insight ${id}: no syllabus matches code "${insight.syllabusCode}"`,
        );
      }
      const [match] = await db
        .select({ id: subtopics.id })
        .from(subtopics)
        .innerJoin(topics, eq(topics.id, subtopics.topicId))
        .where(
          and(
            eq(subtopics.id, patch.subtopicId),
            inArray(topics.syllabusId, candidateSyllabusIds),
          ),
        );
      if (!match) {
        throw new SubtopicLinkValidationError(
          `Subtopic ${patch.subtopicId} does not belong to syllabus "${insight.syllabusCode}"`,
        );
      }
    }
    update.subtopicId = patch.subtopicId;
  }
  if (patch.misconception !== undefined) update.misconception = patch.misconception;
  if (patch.studentError !== undefined) update.studentError = patch.studentError;
  if (patch.correctApproach !== undefined) update.correctApproach = patch.correctApproach;
  if (patch.frequency !== undefined) update.frequency = patch.frequency;
  if (Object.keys(update).length === 0) return;
  await db.update(examinerMisconceptions).set(update).where(eq(examinerMisconceptions.id, id));
}

export async function approveInsight(id: number, reviewerId: string, notes?: string | null): Promise<void> {
  if (!db) return;
  const [row] = await db
    .update(examinerMisconceptions)
    .set({
      status: "approved",
      reviewedById: reviewerId,
      reviewedAt: new Date(),
      reviewNotes: notes ?? null,
    })
    .where(eq(examinerMisconceptions.id, id))
    .returning({ board: examinerMisconceptions.board, syllabusCode: examinerMisconceptions.syllabusCode });
  if (row) invalidateExaminerMisconceptionsCache({ board: row.board, syllabusCode: row.syllabusCode });
}

export async function rejectInsight(id: number, reviewerId: string, notes?: string | null): Promise<void> {
  if (!db) return;
  const [row] = await db
    .update(examinerMisconceptions)
    .set({
      status: "rejected",
      reviewedById: reviewerId,
      reviewedAt: new Date(),
      reviewNotes: notes ?? null,
    })
    .where(eq(examinerMisconceptions.id, id))
    .returning({ board: examinerMisconceptions.board, syllabusCode: examinerMisconceptions.syllabusCode });
  if (row) invalidateExaminerMisconceptionsCache({ board: row.board, syllabusCode: row.syllabusCode });
}

/**
 * Bulk approve / reject a caller-supplied list of insight ids. Used by
 * the queue UI's "Approve N" / "Reject N" floating action bar where the
 * reviewer hand-picks rows.
 *
 * Returns the number of rows actually updated (insights already in the
 * target status, or simply not found, are silently skipped). Cache
 * invalidation runs once per (board, syllabusCode) group at the end.
 */
export async function bulkActionInsights(
  ids: number[],
  action: "approve" | "reject",
  reviewerId: string,
  notes?: string | null,
): Promise<{ updated: number }> {
  if (!db) return { updated: 0 };
  const uniqueIds = Array.from(new Set(ids.filter((n) => Number.isFinite(n) && n > 0)));
  if (uniqueIds.length === 0) return { updated: 0 };
  const targetStatus: ReviewStatus = action === "approve" ? "approved" : "rejected";
  const updated = await db
    .update(examinerMisconceptions)
    .set({
      status: targetStatus,
      reviewedById: reviewerId,
      reviewedAt: new Date(),
      reviewNotes: notes ?? null,
    })
    .where(inArray(examinerMisconceptions.id, uniqueIds))
    .returning({ board: examinerMisconceptions.board, syllabusCode: examinerMisconceptions.syllabusCode });
  // Invalidate caches for each affected (board, syllabusCode) group exactly once.
  const groups = Array.from(new Set(updated.map((r) => `${r.board}|${r.syllabusCode}`)));
  for (const g of groups) {
    const [board, syllabusCode] = g.split("|");
    invalidateExaminerMisconceptionsCache({ board, syllabusCode });
  }
  return { updated: updated.length };
}

/**
 * Bulk-approve all pending rows whose source-quote matches a verbatim
 * substring in the syllabus document AND whose extractor confidence is
 * &gt;= the threshold. Used to clear high-quality bulk extractions
 * without manually clicking through.
 */
export async function bulkApproveHighConfidence(
  reviewerId: string,
  options: { minConfidence?: number; board?: string; syllabusCode?: string } = {},
): Promise<{ approved: number }> {
  if (!db) return { approved: 0 };
  const minConfidence = options.minConfidence ?? 90;
  const conditions = [eq(examinerMisconceptions.status, "pending")];
  if (options.board) conditions.push(eq(examinerMisconceptions.board, options.board));
  if (options.syllabusCode) conditions.push(eq(examinerMisconceptions.syllabusCode, options.syllabusCode));
  const candidates = await db
    .select({
      id: examinerMisconceptions.id,
      confidence: examinerMisconceptions.confidence,
      board: examinerMisconceptions.board,
      syllabusCode: examinerMisconceptions.syllabusCode,
    })
    .from(examinerMisconceptions)
    .where(and(...conditions));
  const eligible = candidates.filter((c) => (c.confidence ?? 0) >= minConfidence);
  if (eligible.length === 0) return { approved: 0 };
  for (const row of eligible) {
    await db
      .update(examinerMisconceptions)
      .set({
        status: "approved",
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        reviewNotes: `auto-approved (confidence >= ${minConfidence})`,
      })
      .where(eq(examinerMisconceptions.id, row.id));
  }
  // Invalidate caches for affected groups.
  const groups = Array.from(new Set(eligible.map((r) => `${r.board}|${r.syllabusCode}`)));
  for (const g of groups) {
    const [board, syllabusCode] = g.split("|");
    invalidateExaminerMisconceptionsCache({ board, syllabusCode });
  }
  return { approved: eligible.length };
}

// ── Subtopic picker support ──────────────────────────────────────────
//
// Powers the reviewer "pick a subtopic" affordance on queue rows whose
// free-text `subtopic` couldn't be auto-mapped to a canonical
// `subtopics.id`. Returns the subtopic catalogue scoped to the row's
// syllabus plus a best-guess suggestion from `resolveSubtopicId` so
// the picker can pre-select a sensible default.

export interface SubtopicOption {
  id: number;
  subtopicNumber: string;
  title: string;
  topicId: number;
  topicNumber: string;
  topicTitle: string;
}

export interface SubtopicOptionsResult {
  insight: {
    id: number;
    board: string;
    syllabusCode: string;
    subject: string | null;
    topic: string;
    subtopic: string | null;
    subtopicId: number | null;
  };
  options: SubtopicOption[];
  suggestion: { id: number; title: string } | null;
}

export async function listSubtopicOptionsForInsight(
  insightId: number,
): Promise<SubtopicOptionsResult | null> {
  if (!db) return null;
  const [insight] = await db
    .select({
      id: examinerMisconceptions.id,
      board: examinerMisconceptions.board,
      syllabusCode: examinerMisconceptions.syllabusCode,
      subject: examinerMisconceptions.subject,
      topic: examinerMisconceptions.topic,
      subtopic: examinerMisconceptions.subtopic,
      subtopicId: examinerMisconceptions.subtopicId,
    })
    .from(examinerMisconceptions)
    .where(eq(examinerMisconceptions.id, insightId));
  if (!insight) return null;

  const candidateSyllabusIds = await resolveSyllabusIdsForCode(insight.syllabusCode);

  // Pull every subtopic under the candidate syllabi so the reviewer
  // can browse the full catalogue. Joined with topic so the picker can
  // group "1.1 Atoms / 1.2 Molecules" under their parent topic.
  const optionRows =
    candidateSyllabusIds.length > 0
      ? await db
          .select({
            id: subtopics.id,
            subtopicNumber: subtopics.subtopicNumber,
            title: subtopics.title,
            topicId: topics.id,
            topicNumber: topics.topicNumber,
            topicTitle: topics.title,
          })
          .from(subtopics)
          .innerJoin(topics, eq(topics.id, subtopics.topicId))
          .innerJoin(syllabi, eq(syllabi.id, topics.syllabusId))
          .where(inArray(syllabi.id, candidateSyllabusIds))
          .orderBy(asc(topics.sortOrder), asc(topics.topicNumber), asc(subtopics.sortOrder), asc(subtopics.subtopicNumber))
      : [];

  // Best-guess suggestion (only meaningful when there is free-text to
  // match against). Re-uses the same resolver the extractor runs at
  // insert time so the suggestion logic stays in lock-step.
  let suggestion: { id: number; title: string } | null = null;
  if ((insight.subtopic ?? "").trim() || (insight.topic ?? "").trim()) {
    const r = await resolveSubtopicId({
      subject: insight.subject,
      topic: insight.topic,
      subtopic: insight.subtopic,
      candidateSyllabusIds,
    });
    if (r.subtopicId) {
      const hit = optionRows.find((o) => o.id === r.subtopicId);
      if (hit) suggestion = { id: hit.id, title: hit.title };
    }
  }

  return {
    insight: {
      id: insight.id,
      board: insight.board,
      syllabusCode: insight.syllabusCode,
      subject: insight.subject,
      topic: insight.topic,
      subtopic: insight.subtopic,
      subtopicId: insight.subtopicId,
    },
    options: optionRows,
    suggestion,
  };
}

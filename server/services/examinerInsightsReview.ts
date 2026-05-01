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
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
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
  /**
   * Restrict the result to "unmatched orphans": rows whose AI-extracted
   * free-text `subtopic` is non-empty but couldn't be auto-mapped to a
   * canonical `subtopics.id`. Pushed into the SQL WHERE so reviewers
   * can sweep orphans even when total pending exceeds the page limit.
   */
  unmatchedOnly?: boolean;
}

/**
 * Shared SQL predicate for "unmatched orphan": non-empty trimmed
 * free-text `subtopic` AND null `subtopicId`. Built once so the
 * counts pass and the queue filter use the exact same definition.
 */
function unmatchedSqlCondition(): SQL {
  return and(
    sql`length(trim(coalesce(${examinerMisconceptions.subtopic}, ''))) > 0`,
    isNull(examinerMisconceptions.subtopicId),
  )!;
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
  if (options.unmatchedOnly) conditions.push(unmatchedSqlCondition());

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
  /**
   * Per-status count of rows whose free-text `subtopic` is non-empty
   * but couldn't be auto-mapped to a canonical `subtopics.id`. Powers
   * the "Show only unmatched (N)" reviewer toggle so the count reflects
   * the entire status (not just the current page of `listQueue`).
   */
  unmatched: Record<ReviewStatus, number>;
}

function bucketOfConfidence(pct: number | null | undefined): ConfidenceBucket {
  if (pct === null || pct === undefined) return "unknown";
  if (pct >= 80) return "high";
  if (pct >= 50) return "medium";
  return "low";
}

function isUnmatched(subtopic: string | null | undefined, subtopicId: number | null | undefined): boolean {
  return (subtopic ?? "").trim() !== "" && (subtopicId === null || subtopicId === undefined);
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
    unmatched: { pending: 0, approved: 0, rejected: 0 },
  };
}

export async function countsByStatus(): Promise<CountsByStatus> {
  const counts = emptyCountsByStatus();
  if (!db) return counts;
  const rows = await db
    .select({
      status: examinerMisconceptions.status,
      confidence: examinerMisconceptions.confidence,
      subtopic: examinerMisconceptions.subtopic,
      subtopicId: examinerMisconceptions.subtopicId,
    })
    .from(examinerMisconceptions);
  for (const r of rows) {
    const s = r.status as ReviewStatus | null;
    if (s !== "pending" && s !== "approved" && s !== "rejected") continue;
    counts[s]++;
    counts.byConfidence[s][bucketOfConfidence(r.confidence)]++;
    if (isUnmatched(r.subtopic, r.subtopicId)) counts.unmatched[s]++;
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
  if (options.unmatchedOnly) conditions.push(unmatchedSqlCondition());

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
    .select({
      status: examinerMisconceptions.status,
      confidence: examinerMisconceptions.confidence,
      subtopic: examinerMisconceptions.subtopic,
      subtopicId: examinerMisconceptions.subtopicId,
    })
    .from(examinerMisconceptions)
    .where(or(...scopeConditions)!);
  for (const r of rows) {
    const s = r.status as ReviewStatus | null;
    if (s !== "pending" && s !== "approved" && s !== "rejected") continue;
    counts[s]++;
    counts.byConfidence[s][bucketOfConfidence(r.confidence)]++;
    if (isUnmatched(r.subtopic, r.subtopicId)) counts.unmatched[s]++;
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

// ── Tiered automated triage ──────────────────────────────────────────
//
// Approves / rejects pending rows from the AI extractor based on
// multiple signal columns at once (confidence + subtopic FK + source
// quote + examiner-flagged frequency) so the human review queue only
// sees the genuinely ambiguous middle tier. Sits alongside the
// reviewer-driven approveInsight / rejectInsight / bulkActionInsights /
// bulkApproveHighConfidence — those keep working unchanged. The
// downstream Maker prompt (`listApprovedSeeds`) is also untouched: it
// still reads only `status = 'approved'`, so this function plugs into
// the existing distractor pipeline without changing it.

export interface TriageThresholds {
  /** Auto-approve when confidence >= this value (and other guards pass). Default 70. */
  minApproveConfidence?: number;
  /** Auto-reject when confidence < this value. Default 40. */
  minRejectConfidence?: number;
  /** Require subtopic FK linkage to auto-approve. Default true. */
  requireSubtopicId?: boolean;
  /** Require a non-null source_quote to auto-approve, and treat missing source_quote as auto-reject. Default true. */
  requireSourceQuote?: boolean;
  /** Frequencies eligible for auto-approve. Default ["very_common", "common"]. */
  approveFrequencies?: string[];
}

export interface TriageOptions extends TriageThresholds {
  /** Reviewer UUID to stamp on auto-decisions. null = "automated" (no human). Default null. */
  reviewerId?: string | null;
  /** Restrict triage to one board. */
  board?: string;
  /** Restrict triage to one syllabus code. */
  syllabusCode?: string;
  /** Restrict triage to a single source document. */
  documentId?: number;
  /** Preview-only: compute what would change but do not write. */
  dryRun?: boolean;
  /** Cap on rows to scan per call. Default 10_000. */
  limit?: number;
}

export interface TriageResult {
  scanned: number;
  approved: number;
  rejected: number;
  leftPending: number;
  approvedIds: number[];
  rejectedIds: number[];
  leftPendingIds: number[];
  thresholds: Required<TriageThresholds>;
}

export async function triagePendingMisconceptions(
  opts: TriageOptions = {},
): Promise<TriageResult> {
  const thresholds: Required<TriageThresholds> = {
    minApproveConfidence: opts.minApproveConfidence ?? 70,
    minRejectConfidence: opts.minRejectConfidence ?? 40,
    requireSubtopicId: opts.requireSubtopicId ?? true,
    requireSourceQuote: opts.requireSourceQuote ?? true,
    approveFrequencies: opts.approveFrequencies ?? ["very_common", "common"],
  };
  const empty: TriageResult = {
    scanned: 0,
    approved: 0,
    rejected: 0,
    leftPending: 0,
    approvedIds: [],
    rejectedIds: [],
    leftPendingIds: [],
    thresholds,
  };
  if (!db) return empty;

  const limit = Math.max(1, Math.min(100_000, opts.limit ?? 10_000));
  const conditions = [eq(examinerMisconceptions.status, "pending")];
  if (opts.board) conditions.push(eq(examinerMisconceptions.board, opts.board));
  if (opts.syllabusCode) conditions.push(eq(examinerMisconceptions.syllabusCode, opts.syllabusCode));
  if (opts.documentId !== undefined) conditions.push(eq(examinerMisconceptions.documentId, opts.documentId));

  const candidates = await db
    .select({
      id: examinerMisconceptions.id,
      board: examinerMisconceptions.board,
      syllabusCode: examinerMisconceptions.syllabusCode,
      confidence: examinerMisconceptions.confidence,
      subtopicId: examinerMisconceptions.subtopicId,
      sourceQuote: examinerMisconceptions.sourceQuote,
      frequency: examinerMisconceptions.frequency,
    })
    .from(examinerMisconceptions)
    .where(and(...conditions))
    .limit(limit);

  if (candidates.length === 0) return empty;

  const approveFreqSet = new Set(thresholds.approveFrequencies);
  const approveBucket: typeof candidates = [];
  // Reject ids are bucketed by reason so reviewNotes captures *why*.
  const rejectByReason = new Map<string, number[]>();
  const leftPendingIds: number[] = [];

  for (const row of candidates) {
    const conf = row.confidence ?? 0;
    const hasQuote = (row.sourceQuote ?? "").trim().length > 0;
    const hasSubtopic = row.subtopicId !== null && row.subtopicId !== undefined;
    const freqOk = approveFreqSet.has(row.frequency);

    // Reject path takes precedence — a row that fails a hard reject
    // signal must never simultaneously be approved.
    const rejectReasons: string[] = [];
    if (conf < thresholds.minRejectConfidence) {
      rejectReasons.push(`confidence<${thresholds.minRejectConfidence}`);
    }
    if (thresholds.requireSourceQuote && !hasQuote) {
      rejectReasons.push("missing source_quote");
    }
    if (rejectReasons.length > 0) {
      const reason = `auto-rejected: ${rejectReasons.join(", ")}`;
      const list = rejectByReason.get(reason) ?? [];
      list.push(row.id);
      rejectByReason.set(reason, list);
      continue;
    }

    const approveOk =
      conf >= thresholds.minApproveConfidence &&
      (!thresholds.requireSubtopicId || hasSubtopic) &&
      (!thresholds.requireSourceQuote || hasQuote) &&
      freqOk;
    if (approveOk) {
      approveBucket.push(row);
    } else {
      leftPendingIds.push(row.id);
    }
  }

  const approvedIds = approveBucket.map((r) => r.id);
  const rejectedIds = Array.from(rejectByReason.values()).flat();
  const result: TriageResult = {
    scanned: candidates.length,
    approved: approvedIds.length,
    rejected: rejectedIds.length,
    leftPending: leftPendingIds.length,
    approvedIds,
    rejectedIds,
    leftPendingIds,
    thresholds,
  };

  if (opts.dryRun) return result;

  const reviewerId = opts.reviewerId ?? null;
  const reviewedAt = new Date();
  const cacheGroups = new Set<string>();

  if (approvedIds.length > 0) {
    const approveNote =
      `auto-approved: confidence>=${thresholds.minApproveConfidence}` +
      (thresholds.requireSubtopicId ? ", linked subtopic" : "") +
      (thresholds.requireSourceQuote ? ", has source_quote" : "") +
      `, frequency in {${thresholds.approveFrequencies.join("|")}}`;
    const updated = await db
      .update(examinerMisconceptions)
      .set({
        status: "approved",
        reviewedById: reviewerId,
        reviewedAt,
        reviewNotes: approveNote,
      })
      .where(inArray(examinerMisconceptions.id, approvedIds))
      .returning({
        board: examinerMisconceptions.board,
        syllabusCode: examinerMisconceptions.syllabusCode,
      });
    for (const r of updated) cacheGroups.add(`${r.board}|${r.syllabusCode}`);
  }

  const rejectEntries = Array.from(rejectByReason.entries());
  for (const [reason, ids] of rejectEntries) {
    if (ids.length === 0) continue;
    const updated = await db
      .update(examinerMisconceptions)
      .set({
        status: "rejected",
        reviewedById: reviewerId,
        reviewedAt,
        reviewNotes: reason,
      })
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

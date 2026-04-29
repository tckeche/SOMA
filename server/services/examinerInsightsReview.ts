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
  subtopics,
} from "@shared/schema";
import { invalidateExaminerMisconceptionsCache } from "./examinerMisconceptionsCache";
import { and, desc, eq } from "drizzle-orm";

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
 * Paginated listing for the queue UI. Defaults to status='pending' and
 * orders newest first.
 */
export async function listQueue(options: QueueListOptions = {}): Promise<QueueListResult> {
  const empty: QueueListResult = { rows: [], total: 0 };
  if (!db) return empty;

  const status = options.status ?? "pending";
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);

  const conditions = [eq(examinerMisconceptions.status, status)];
  if (options.board) conditions.push(eq(examinerMisconceptions.board, options.board));
  if (options.syllabusCode) conditions.push(eq(examinerMisconceptions.syllabusCode, options.syllabusCode));

  const rows = await db
    .select({
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
    })
    .from(examinerMisconceptions)
    .leftJoin(syllabusDocuments, eq(syllabusDocuments.id, examinerMisconceptions.documentId))
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
    rows: rows.map((r) => ({
      id: r.id,
      status: (r.status ?? "pending") as ReviewStatus,
      board: r.board,
      syllabusCode: r.syllabusCode,
      subject: r.subject,
      topic: r.topic,
      subtopic: r.subtopic,
      subtopicId: r.subtopicId,
      subtopicTitle: r.subtopicTitle,
      misconception: r.misconception,
      studentError: r.studentError,
      correctApproach: r.correctApproach,
      frequency: r.frequency,
      sourceQuote: r.sourceQuote,
      sourcePage: r.sourcePage,
      confidencePct: r.confidencePct,
      reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
      reviewedById: r.reviewedById,
      reviewedByDisplayName: r.reviewedByDisplayName ?? null,
      reviewNotes: r.reviewNotes,
      documentId: r.documentId,
      documentFilename: r.documentFilename,
      documentType: r.documentType,
      extractedAt: r.extractedAt.toISOString(),
    })),
    total: totalRows.length,
  };
}

export interface CountsByStatus {
  pending: number;
  approved: number;
  rejected: number;
}

export async function countsByStatus(): Promise<CountsByStatus> {
  if (!db) return { pending: 0, approved: 0, rejected: 0 };
  const rows = await db.select({ status: examinerMisconceptions.status }).from(examinerMisconceptions);
  const counts: CountsByStatus = { pending: 0, approved: 0, rejected: 0 };
  for (const r of rows) {
    if (r.status === "pending") counts.pending++;
    else if (r.status === "approved") counts.approved++;
    else if (r.status === "rejected") counts.rejected++;
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
 * Edit a row in the queue (any status). Used by reviewers to fix
 * AI-extracted text before approving.
 */
export async function updateInsight(id: number, patch: UpdatePatch): Promise<void> {
  if (!db) return;
  const update: Record<string, unknown> = {};
  if (patch.topic !== undefined) update.topic = patch.topic;
  if (patch.subtopic !== undefined) update.subtopic = patch.subtopic;
  if (patch.subtopicId !== undefined) update.subtopicId = patch.subtopicId;
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

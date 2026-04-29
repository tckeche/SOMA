/**
 * Super-admin: Examiner Insight Review Queue routes.
 *
 * AI-extracted misconceptions land here as `status="pending"`. A
 * super-admin reviews each row, optionally edits the text or attaches a
 * `subtopic_id`, and either approves (visible to tutors / students) or
 * rejects.
 *
 * Conventions: see server/routes/README.md.
 */
import type { Express } from "express";
import { z } from "zod";
import { requireSuperAdmin } from "../middleware/roles";
import {
  approveInsight,
  bulkActionInsights,
  bulkApproveHighConfidence,
  countsByStatus,
  listQueue,
  rejectInsight,
  updateInsight,
  type ReviewStatus,
} from "../services/examinerInsightsReview";

const STATUS_VALUES: readonly ReviewStatus[] = ["pending", "approved", "rejected"] as const;

const updateSchema = z.object({
  topic: z.string().min(1).max(200).optional(),
  subtopic: z.string().max(200).nullable().optional(),
  subtopicId: z.number().int().positive().nullable().optional(),
  misconception: z.string().min(1).max(2000).optional(),
  studentError: z.string().max(2000).optional(),
  correctApproach: z.string().max(2000).optional(),
  frequency: z.enum(["very_common", "common", "occasional"]).optional(),
});

const approveSchema = z.object({
  notes: z.string().max(1000).nullable().optional(),
});

const bulkApproveSchema = z.object({
  minConfidence: z.number().int().min(0).max(100).optional(),
  board: z.string().optional(),
  syllabusCode: z.string().optional(),
});

const bulkActionSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
  action: z.enum(["approve", "reject"]),
  notes: z.string().max(1000).nullable().optional(),
});

function reviewerId(req: any): string | null {
  const fromAuth = req?.authUser?.id;
  if (fromAuth) return String(fromAuth);
  const fromAdmin = req?.adminUser?.id;
  if (fromAdmin) return String(fromAdmin);
  const headerId = req?.headers?.["x-admin-id"];
  return headerId ? String(headerId) : null;
}

export function registerExaminerInsightsReviewRoutes(app: Express): void {
  // ── Counts at top of dashboard ─────────────────────────────────────
  app.get("/api/super-admin/examiner-insights/counts", requireSuperAdmin, async (_req, res) => {
    try {
      const counts = await countsByStatus();
      res.json(counts);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to fetch counts" });
    }
  });

  // ── List queue ─────────────────────────────────────────────────────
  app.get("/api/super-admin/examiner-insights/queue", requireSuperAdmin, async (req, res) => {
    try {
      const status = STATUS_VALUES.includes(String(req.query.status) as ReviewStatus)
        ? (String(req.query.status) as ReviewStatus)
        : "pending";
      const board = typeof req.query.board === "string" && req.query.board.trim() ? req.query.board.trim() : undefined;
      const syllabusCode =
        typeof req.query.syllabusCode === "string" && req.query.syllabusCode.trim()
          ? req.query.syllabusCode.trim()
          : undefined;
      const limit = Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 50;
      const offset = Number.isFinite(Number(req.query.offset)) ? Number(req.query.offset) : 0;
      const result = await listQueue({ status, board, syllabusCode, limit, offset });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to fetch queue" });
    }
  });

  // ── Edit a row (any status) ────────────────────────────────────────
  app.patch("/api/super-admin/examiner-insights/:id", requireSuperAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid patch", details: parsed.error.flatten() });
      }
      await updateInsight(id, parsed.data);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to update insight" });
    }
  });

  // ── Approve ────────────────────────────────────────────────────────
  app.post("/api/super-admin/examiner-insights/:id/approve", requireSuperAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
      const parsed = approveSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", details: parsed.error.flatten() });
      }
      const userId = reviewerId(req);
      if (!userId) return res.status(401).json({ message: "Reviewer identity required" });
      await approveInsight(id, userId, parsed.data.notes ?? null);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to approve insight" });
    }
  });

  // ── Reject ─────────────────────────────────────────────────────────
  app.post("/api/super-admin/examiner-insights/:id/reject", requireSuperAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
      const parsed = approveSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", details: parsed.error.flatten() });
      }
      const userId = reviewerId(req);
      if (!userId) return res.status(401).json({ message: "Reviewer identity required" });
      await rejectInsight(id, userId, parsed.data.notes ?? null);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to reject insight" });
    }
  });

  // ── Bulk approve high-confidence rows ──────────────────────────────
  app.post("/api/super-admin/examiner-insights/bulk-approve", requireSuperAdmin, async (req, res) => {
    try {
      const parsed = bulkApproveSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", details: parsed.error.flatten() });
      }
      const userId = reviewerId(req);
      if (!userId) return res.status(401).json({ message: "Reviewer identity required" });
      const result = await bulkApproveHighConfidence(userId, parsed.data);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Bulk approve failed" });
    }
  });

  // ── Bulk action on a hand-picked selection of insight ids ──────────
  app.post("/api/super-admin/examiner-insights/bulk-action", requireSuperAdmin, async (req, res) => {
    try {
      const parsed = bulkActionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", details: parsed.error.flatten() });
      }
      const userId = reviewerId(req);
      if (!userId) return res.status(401).json({ message: "Reviewer identity required" });
      const result = await bulkActionInsights(
        parsed.data.ids,
        parsed.data.action,
        userId,
        parsed.data.notes ?? null,
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Bulk action failed" });
    }
  });
}

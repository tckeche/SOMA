/**
 * Tutor-scoped Examiner Insight Review Queue routes.
 *
 * Mirrors the super-admin queue but constrains every operation to
 * (board, syllabusCode) pairs the tutor has authored quizzes on. A
 * tutor cannot approve / edit / reject an insight outside their scope.
 *
 * Conventions: see server/routes/README.md.
 */
import type { Express } from "express";
import { z } from "zod";
import { requireTutor } from "../middleware/roles";
import {
  approveInsight,
  bulkActionInsights,
  countsByStatusForTutor,
  listQueueForTutor,
  listSubtopicOptionsForInsight,
  rejectInsight,
  SubtopicLinkValidationError,
  tutorOwnsInsight,
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

const reviewSchema = z.object({
  notes: z.string().max(1000).nullable().optional(),
});

const bulkActionSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
  action: z.enum(["approve", "reject"]),
  notes: z.string().max(1000).nullable().optional(),
});

function tutorIdFromReq(req: any): string | null {
  const fromAuth = req?.authUser?.id;
  if (fromAuth) return String(fromAuth);
  const fromTutor = req?.tutorUser?.id;
  return fromTutor ? String(fromTutor) : null;
}

export function registerTutorExaminerInsightsRoutes(app: Express): void {
  // ── Counts (scoped) ────────────────────────────────────────────────
  app.get("/api/tutor/examiner-insights/counts", requireTutor, async (req, res) => {
    try {
      const tutorId = tutorIdFromReq(req);
      if (!tutorId) return res.status(401).json({ message: "Tutor identity required" });
      const counts = await countsByStatusForTutor(tutorId);
      res.json(counts);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to fetch counts" });
    }
  });

  // ── List queue (scoped) ────────────────────────────────────────────
  app.get("/api/tutor/examiner-insights/queue", requireTutor, async (req, res) => {
    try {
      const tutorId = tutorIdFromReq(req);
      if (!tutorId) return res.status(401).json({ message: "Tutor identity required" });
      const status = STATUS_VALUES.includes(String(req.query.status) as ReviewStatus)
        ? (String(req.query.status) as ReviewStatus)
        : "pending";
      const board = typeof req.query.board === "string" && req.query.board.trim() ? req.query.board.trim() : undefined;
      const unmatchedOnly = req.query.unmatchedOnly === "1" || req.query.unmatchedOnly === "true";
      const syllabusCode =
        typeof req.query.syllabusCode === "string" && req.query.syllabusCode.trim()
          ? req.query.syllabusCode.trim()
          : undefined;
      const limit = Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 50;
      const offset = Number.isFinite(Number(req.query.offset)) ? Number(req.query.offset) : 0;
      const result = await listQueueForTutor(tutorId, { status, board, syllabusCode, limit, offset, unmatchedOnly });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to fetch queue" });
    }
  });

  // ── Subtopic options for the inline picker (scoped) ────────────────
  app.get("/api/tutor/examiner-insights/:id/subtopic-options", requireTutor, async (req, res) => {
    try {
      const tutorId = tutorIdFromReq(req);
      if (!tutorId) return res.status(401).json({ message: "Tutor identity required" });
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
      if (!(await tutorOwnsInsight(tutorId, id))) {
        return res.status(403).json({ message: "This insight is outside your assigned syllabi." });
      }
      const result = await listSubtopicOptionsForInsight(id);
      if (!result) return res.status(404).json({ message: "Insight not found" });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to fetch subtopic options" });
    }
  });

  // ── Edit (scoped) ──────────────────────────────────────────────────
  app.patch("/api/tutor/examiner-insights/:id", requireTutor, async (req, res) => {
    try {
      const tutorId = tutorIdFromReq(req);
      if (!tutorId) return res.status(401).json({ message: "Tutor identity required" });
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
      if (!(await tutorOwnsInsight(tutorId, id))) {
        return res.status(403).json({ message: "This insight is outside your assigned syllabi." });
      }
      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid patch", details: parsed.error.flatten() });
      }
      await updateInsight(id, parsed.data);
      res.json({ ok: true });
    } catch (err: any) {
      if (err instanceof SubtopicLinkValidationError) {
        return res.status(400).json({ message: err.message });
      }
      res.status(500).json({ message: err?.message || "Failed to update insight" });
    }
  });

  // ── Approve (scoped) ───────────────────────────────────────────────
  app.post("/api/tutor/examiner-insights/:id/approve", requireTutor, async (req, res) => {
    try {
      const tutorId = tutorIdFromReq(req);
      if (!tutorId) return res.status(401).json({ message: "Tutor identity required" });
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
      if (!(await tutorOwnsInsight(tutorId, id))) {
        return res.status(403).json({ message: "This insight is outside your assigned syllabi." });
      }
      const parsed = reviewSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", details: parsed.error.flatten() });
      }
      await approveInsight(id, tutorId, parsed.data.notes ?? null);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to approve insight" });
    }
  });

  // ── Bulk action on a hand-picked selection (scoped) ────────────────
  app.post("/api/tutor/examiner-insights/bulk-action", requireTutor, async (req, res) => {
    try {
      const tutorId = tutorIdFromReq(req);
      if (!tutorId) return res.status(401).json({ message: "Tutor identity required" });
      const parsed = bulkActionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", details: parsed.error.flatten() });
      }
      // Reject the entire batch if ANY id is outside the tutor's scope.
      const ownership = await Promise.all(parsed.data.ids.map((id) => tutorOwnsInsight(tutorId, id)));
      if (ownership.some((ok) => !ok)) {
        return res.status(403).json({ message: "One or more insights are outside your assigned syllabi." });
      }
      const result = await bulkActionInsights(
        parsed.data.ids,
        parsed.data.action,
        tutorId,
        parsed.data.notes ?? null,
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Bulk action failed" });
    }
  });

  // ── Reject (scoped) ────────────────────────────────────────────────
  app.post("/api/tutor/examiner-insights/:id/reject", requireTutor, async (req, res) => {
    try {
      const tutorId = tutorIdFromReq(req);
      if (!tutorId) return res.status(401).json({ message: "Tutor identity required" });
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
      if (!(await tutorOwnsInsight(tutorId, id))) {
        return res.status(403).json({ message: "This insight is outside your assigned syllabi." });
      }
      const parsed = reviewSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", details: parsed.error.flatten() });
      }
      await rejectInsight(id, tutorId, parsed.data.notes ?? null);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to reject insight" });
    }
  });
}

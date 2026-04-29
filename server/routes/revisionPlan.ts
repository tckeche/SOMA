/**
 * Phase 3.3 — Personal Revision Plan endpoints.
 */
import type { Express } from "express";
import { z } from "zod";
import { requireSupabaseAuth } from "../middleware/roles";
import { generateRevisionPlan } from "../services/revisionPlanGenerator";
import { getPlan, listPlansForStudent, upsertPlan } from "../services/revisionPlanStore";

const generateBodySchema = z.object({
  subject: z.string().min(1),
  examBody: z.string().min(1),
  syllabusCode: z.string().min(1),
  level: z.string().min(1),
  examDate: z.string().datetime().nullable().optional(),
  weekHours: z.number().int().min(1).max(40).optional(),
});

export function registerRevisionPlanRoutes(app: Express): void {
  // List all plans for the student (one per subject).
  app.get("/api/student/revision-plans", requireSupabaseAuth, async (req, res) => {
    try {
      const studentId = (req as any).authUser.id;
      const rows = await listPlansForStudent(studentId);
      res.json({
        plans: rows.map((r) => ({
          id: r.id,
          subject: r.subject,
          examBody: r.examBody,
          syllabusCode: r.syllabusCode,
          level: r.level,
          examDate: r.examDate ? r.examDate.toISOString() : null,
          weekHours: r.weekHours,
          weeks: r.weeks,
          summary: r.summary,
          weakAreas: r.weakAreas,
          stale: r.stale,
          generatedAt: r.generatedAt.toISOString(),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to list plans" });
    }
  });

  // Fetch a single plan for (subject, syllabusCode, level).
  app.get("/api/student/revision-plan", requireSupabaseAuth, async (req, res) => {
    try {
      const studentId = (req as any).authUser.id;
      const subject = String(req.query.subject || "");
      const syllabusCode = String(req.query.syllabusCode || "");
      const level = String(req.query.level || "");
      if (!subject || !syllabusCode || !level) {
        return res.status(400).json({ message: "subject, syllabusCode and level are required" });
      }
      const plan = await getPlan({ studentId, subject, syllabusCode, level });
      if (!plan) return res.status(404).json({ message: "No plan yet — generate one first." });
      res.json({
        id: plan.id,
        subject: plan.subject,
        examBody: plan.examBody,
        syllabusCode: plan.syllabusCode,
        level: plan.level,
        examDate: plan.examDate ? plan.examDate.toISOString() : null,
        weekHours: plan.weekHours,
        weeks: plan.weeks,
        summary: plan.summary,
        weakAreas: plan.weakAreas,
        stale: plan.stale,
        generatedAt: plan.generatedAt.toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to fetch plan" });
    }
  });

  // Generate or refresh the plan for (subject, syllabusCode, level).
  app.post("/api/student/revision-plan", requireSupabaseAuth, async (req, res) => {
    try {
      const studentId = (req as any).authUser.id;
      const parsed = generateBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", details: parsed.error.flatten() });
      }
      const examDate = parsed.data.examDate ? new Date(parsed.data.examDate) : null;
      const weekHours = parsed.data.weekHours ?? 6;
      const body = await generateRevisionPlan({
        studentId,
        subject: parsed.data.subject,
        syllabusCode: parsed.data.syllabusCode,
        level: parsed.data.level,
        examDate,
        weekHours,
      });
      const row = await upsertPlan({
        studentId,
        subject: parsed.data.subject,
        examBody: parsed.data.examBody,
        syllabusCode: parsed.data.syllabusCode,
        level: parsed.data.level,
        examDate,
        weekHours,
        body,
      });
      res.json({
        id: row.id,
        subject: row.subject,
        examBody: row.examBody,
        syllabusCode: row.syllabusCode,
        level: row.level,
        examDate: row.examDate ? row.examDate.toISOString() : null,
        weekHours: row.weekHours,
        weeks: row.weeks,
        summary: row.summary,
        weakAreas: row.weakAreas,
        stale: row.stale,
        generatedAt: row.generatedAt.toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to generate plan" });
    }
  });
}

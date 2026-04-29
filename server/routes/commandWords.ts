/**
 * Phase 4.2 — Command-Word Coach endpoints.
 */
import type { Express } from "express";
import { requireSupabaseAuth, requireTutor } from "../middleware/roles";
import { storage } from "../storage";
import { listForStudent } from "../services/commandWordPerformance";

export function registerCommandWordsRoutes(app: Express): void {
  app.get("/api/student/command-words", requireSupabaseAuth, async (req, res) => {
    try {
      const studentId = (req as any).authUser.id;
      const payload = await listForStudent(studentId);
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to fetch command-word performance" });
    }
  });

  app.get("/api/tutor/students/:studentId/command-words", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId || (req as any).authUser?.id;
      const studentId = String(req.params.studentId);
      if (!tutorId) return res.status(401).json({ message: "Tutor identity required" });
      const adopted = await storage.getAdoptedStudents(tutorId);
      if (!adopted.some((s) => s.id === studentId)) {
        return res.status(403).json({ message: "You haven't adopted this student." });
      }
      const payload = await listForStudent(studentId);
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to fetch command-word performance" });
    }
  });
}

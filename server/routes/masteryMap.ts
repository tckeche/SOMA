/**
 * Phase 3.1 — Syllabus Mastery Map endpoints.
 *
 * Student route returns the requesting student's tree.
 * Tutor route returns a specified student's tree, gated to tutors who
 * have adopted that student.
 */
import type { Express } from "express";
import { requireSupabaseAuth, requireTutor } from "../middleware/roles";
import { storage } from "../storage";
import { buildMasteryMap } from "../services/syllabusMasteryMap";

export function registerMasteryMapRoutes(app: Express): void {
  app.get("/api/student/mastery-map", requireSupabaseAuth, async (req, res) => {
    try {
      const studentId = (req as any).authUser.id;
      const map = await buildMasteryMap(studentId);
      res.json(map);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to build mastery map" });
    }
  });

  app.get("/api/tutor/students/:studentId/mastery-map", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId || (req as any).authUser?.id;
      const studentId = String(req.params.studentId);
      if (!tutorId) return res.status(401).json({ message: "Tutor identity required" });
      const adopted = await storage.getAdoptedStudents(tutorId);
      if (!adopted.some((s) => s.id === studentId)) {
        return res.status(403).json({ message: "You haven't adopted this student." });
      }
      const map = await buildMasteryMap(studentId);
      res.json(map);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to build mastery map" });
    }
  });
}

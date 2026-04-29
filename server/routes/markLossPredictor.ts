/**
 * Phase 3.2 — Mark-Loss Predictor endpoints.
 */
import type { Express } from "express";
import { requireSupabaseAuth, requireTutor } from "../middleware/roles";
import { storage } from "../storage";
import { buildMarkLossPrediction } from "../services/markLossPredictor";

export function registerMarkLossPredictorRoutes(app: Express): void {
  app.get("/api/student/mark-loss-prediction", requireSupabaseAuth, async (req, res) => {
    try {
      const studentId = (req as any).authUser.id;
      const payload = await buildMarkLossPrediction(studentId);
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to build prediction" });
    }
  });

  app.get("/api/tutor/students/:studentId/mark-loss-prediction", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId || (req as any).authUser?.id;
      const studentId = String(req.params.studentId);
      if (!tutorId) return res.status(401).json({ message: "Tutor identity required" });
      const adopted = await storage.getAdoptedStudents(tutorId);
      if (!adopted.some((s) => s.id === studentId)) {
        return res.status(403).json({ message: "You haven't adopted this student." });
      }
      const payload = await buildMarkLossPrediction(studentId);
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to build prediction" });
    }
  });
}

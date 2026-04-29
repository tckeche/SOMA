/**
 * Phase 3.4 — Cohort Misconception Heatmap endpoint.
 */
import type { Express } from "express";
import { requireTutor } from "../middleware/roles";
import { buildCohortMisconceptionHeatmap } from "../services/cohortMisconceptionHeatmap";

export function registerCohortHeatmapRoutes(app: Express): void {
  app.get("/api/tutor/cohort-misconceptions", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId || (req as any).authUser?.id;
      if (!tutorId) return res.status(401).json({ message: "Tutor identity required" });
      const payload = await buildCohortMisconceptionHeatmap(tutorId);
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to build heatmap" });
    }
  });
}

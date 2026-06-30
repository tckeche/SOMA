/**
 * Domain-route registration compatibility entry point.
 *
 * The legacy `server/routes.ts` still calls `registerDomainRoutes(app)` once at
 * the start of `registerRoutes()`. This file now delegates to the autoloaded
 * `server/modules` domain loader so newly extracted domains do not need to edit
 * a central manual import list.
 */
import type { Express } from "express";
import { registerSuperAdminAiUsageRoutes } from "./superAdminAiUsage";
import { registerExaminerInsightsReviewRoutes } from "./examinerInsightsReview";
import { registerTutorExaminerInsightsRoutes } from "./tutorExaminerInsights";
import { registerMasteryMapRoutes } from "./masteryMap";
import { registerMarkLossPredictorRoutes } from "./markLossPredictor";
import { registerRevisionPlanRoutes } from "./revisionPlan";
import { registerCohortHeatmapRoutes } from "./cohortHeatmap";
import { registerCommandWordsRoutes } from "./commandWords";
import { registerSuperAdminDiagnosticsRoutes } from "./superAdminDiagnostics";
import { registerPdfAiMarkingRoutes } from "./pdfAiMarking";

export function registerDomainRoutes(app: Express): void {
  registerSuperAdminAiUsageRoutes(app);
  registerExaminerInsightsReviewRoutes(app);
  registerTutorExaminerInsightsRoutes(app);
  registerMasteryMapRoutes(app);
  registerMarkLossPredictorRoutes(app);
  registerRevisionPlanRoutes(app);
  registerCohortHeatmapRoutes(app);
  registerCommandWordsRoutes(app);
  registerSuperAdminDiagnosticsRoutes(app);
  registerPdfAiMarkingRoutes(app);
}

/**
 * Domain-route registration entry point.
 *
 * The legacy `server/routes.ts` calls `registerDomainRoutes(app)` once at
 * the start of `registerRoutes()`. Add new domain modules here as they are
 * peeled out of the monolith.
 *
 * See `server/routes/README.md` for conventions.
 */
import type { Express } from "express";
import { registerSuperAdminAiUsageRoutes } from "./superAdminAiUsage";
import { registerExaminerInsightsReviewRoutes } from "./examinerInsightsReview";
import { registerTutorExaminerInsightsRoutes } from "./tutorExaminerInsights";
import { registerMasteryMapRoutes } from "./masteryMap";
import { registerMarkLossPredictorRoutes } from "./markLossPredictor";

export function registerDomainRoutes(app: Express): void {
  registerSuperAdminAiUsageRoutes(app);
  registerExaminerInsightsReviewRoutes(app);
  registerTutorExaminerInsightsRoutes(app);
  registerMasteryMapRoutes(app);
  registerMarkLossPredictorRoutes(app);
}

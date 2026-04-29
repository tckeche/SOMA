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

export function registerDomainRoutes(app: Express): void {
  registerSuperAdminAiUsageRoutes(app);
  registerExaminerInsightsReviewRoutes(app);
}

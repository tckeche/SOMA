/**
 * Super-admin AI spend & health endpoints.
 *
 * Extracted from `server/routes.ts` as the first domain module under
 * `server/routes/`. Wired into the app via
 * `server/routes/index.ts → registerDomainRoutes(app)`.
 *
 * Privacy: counters and safe metadata only. No raw prompts, no raw model
 * output, no idempotency keys are exposed.
 */
import type { Express } from "express";
import { requireSuperAdmin } from "../middleware/roles";
import { report as usageReport } from "../services/aiUsageMetrics";
import { snapshot as healthSnapshot, currentHealthBackend } from "../services/aiHealth";
import { maxTokensTable } from "../services/aiCostGuards";
import { getHistoricalUsage } from "../services/aiUsageQueries";

export function registerSuperAdminAiUsageRoutes(app: Express): void {
  // ?days=N (default 30, clamped 1..365). Historical view uses ai_usage_logs;
  // the in-memory `usage` block remains the live counter snapshot.
  app.get("/api/super-admin/ai-usage", requireSuperAdmin, async (req, res) => {
    try {
      const daysRaw = Number(req.query.days);
      const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, Math.floor(daysRaw))) : 30;
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - days);
      since.setUTCHours(0, 0, 0, 0);

      const historical = await getHistoricalUsage({ since });

      res.json({
        usage: usageReport(),
        historical,
        rangeDays: days,
        health: {
          backend: currentHealthBackend(),
          providers: healthSnapshot(),
        },
        guardrails: {
          maxTokensByTask: maxTokensTable(),
        },
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch AI usage" });
    }
  });
}

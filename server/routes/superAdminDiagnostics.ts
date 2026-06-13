import type { Express } from "express";
import { requireSuperAdmin } from "../middleware/roles";
import { diagnosticsCategories, getDiagnosticsSummary, getRecentDiagnostics, type DiagnosticsCategory, type DiagnosticsSeverity } from "../services/diagnosticsStore";

const severities = new Set(["debug", "info", "warn", "error", "critical"]);
const categories = new Set<string>(diagnosticsCategories);

export function registerSuperAdminDiagnosticsRoutes(app: Express): void {
  app.get("/api/super-admin/diagnostics/recent", requireSuperAdmin, (req, res) => {
    const limitRaw = Number(req.query.limit);
    const severity = typeof req.query.severity === "string" && severities.has(req.query.severity)
      ? req.query.severity as DiagnosticsSeverity
      : undefined;
    const category = typeof req.query.category === "string" && categories.has(req.query.category)
      ? req.query.category as DiagnosticsCategory
      : undefined;

    res.json({
      events: getRecentDiagnostics({
        limit: Number.isFinite(limitRaw) ? limitRaw : 100,
        severity,
        category,
      }),
    });
  });

  app.get("/api/super-admin/diagnostics/summary", requireSuperAdmin, (_req, res) => {
    res.json(getDiagnosticsSummary());
  });

  app.get("/api/super-admin/diagnostics/health", requireSuperAdmin, (_req, res) => {
    const summary = getDiagnosticsSummary();
    const errorCount = summary.lastHour.errorCount;
    res.status(errorCount > 10 ? 503 : 200).json({
      ok: errorCount <= 10,
      status: errorCount > 10 ? "degraded" : "ok",
      errorCountLastHour: errorCount,
      generatedAt: summary.generatedAt,
    });
  });
}
